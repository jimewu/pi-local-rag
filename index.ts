/**
 * pi-local-rag — Hybrid RAG Pipeline (BM25 + Vector + Auto-injection)
 *
 * Index local files → chunk → embed → store → retrieve → inject into LLM context.
 * Uses Transformers.js (ONNX) for local embeddings — zero cloud dependency.
 *
 * Storage is per-cwd: walk up from the working directory looking for a `.pi/rag/`
 * project store; fall back to `~/.pi/rag/` as the global default. The first
 * `/rag index` in a directory with no parent store creates one at cwd.
 *
 * /rag index <path>     → index + embed a file or directory
 * /rag search <query>   → hybrid search (BM25 + vector)
 * /rag find <glob>      → list indexed files matching a glob
 * /rag status           → show index stats
 * /rag rebuild          → re-embed all tracked files (forced re-embed)
 * /rag refresh          → incremental refresh (only new/changed files)
 * /rag clear            → clear index
 * /rag exclude <pat>    → add gitignore-style pattern (use -<pat> to remove; omit arg to list)
 * /rag on|off           → toggle auto-injection
 * /rag ext list         → list active file extensions
 * /rag ext add <.ext>   → add an extra extension (e.g. .cs, .tex)
 * /rag ext remove <.ext>→ remove an extension from the active set
 * /rag ext reset        → restore default extensions
 * /rag help             → show all /rag commands
 *
 * Tools: rag_index, rag_query, rag_status
 *
 * Implementation is split across:
 *   constants.ts     — shared constants, file ext sets, size limits
 *   store.ts         — RAG_DIR / LEGACY_DIR / file paths / ensureDir + legacy migration
 *   config.ts        — RagConfig type, loadConfig / saveConfig, ext helpers
 *   index-store.ts   — Chunk / IndexMeta types, loadIndex / saveIndex (JSON)
 *   chunking.ts      — sha256, chunkText, collectFiles, extractText (txt/pdf/docx/html)
 *   embed.ts         — getEmbedder, embed, embedBatch (ONNX via @xenova/transformers)
 *   search.ts        — cosineSimilarity, normalize, hybridSearch
 *   indexing.ts      — indexFiles (parallel Phase 1 read, sequential Phase 2 embed)
 *   index.ts         — extension entry point (this file) + re-exports
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Box, Text } from "@mariozechner/pi-tui";
import type { CoverageReport } from "./coverage.ts";import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { resolve, extname, basename, relative } from "node:path";
import ignore from "ignore";

import { RST, B, D, GREEN, CYAN } from "./constants.ts";
import { DOC_CONVERT_EXTS } from "./constants.ts";
import { getRagDir, GLOBAL_RAG_DIR } from "./store.ts";
import { loadConfig, saveConfig, normalizeExt, resolveExtensions } from "./config.ts";
import { getDbConn, loadIndex, saveIndex, getIndexStats } from "./db.ts";
import { collectFiles, collectFromTracked, collectFromTrackedAsync, isExcludedByConfig } from "./chunking.ts";
import { scanMarkdownSync } from "./md-sync.ts";
import { computeCoverage, coverageVerdictLabel } from "./coverage.ts";
import { autoCompleteCoverage } from "./auto-fix.ts";
import { isRerankerEnabled } from "./embed.ts";
import { hybridSearch } from "./search.ts";
import { indexFiles, isIndexStale } from "./indexing.ts";

// Re-export the public surface so existing consumers of `pi-local-rag` keep
// working (tests, downstream code that imports from the package root).
export { DEFAULT_TEXT_EXTS, DEFAULT_MARKDOWN_EXTS, DOC_CONVERT_EXTS } from "./constants.ts";
export { getRagDir, GLOBAL_RAG_DIR, LEGACY_DIR } from "./store.ts";
export type { RagConfig } from "./config.ts";
export { loadConfig, saveConfig, defaultConfig, normalizeExt, resolveExtensions } from "./config.ts";
export type { Chunk, IndexMeta, IndexStats } from "./db.ts";
export { getDbConn, closeDbConn, getFreshDbConn, loadIndex, saveIndex, getIndexStats, initSchema } from "./db.ts";
export { RagDatabase } from "./db.ts";
export { sha256, chunkText, chunkForFile, chunkMarkdownParentChild, splitSemanticBlocks,
  collectFiles, collectFilesAsync, collectFromTracked, collectFromTrackedAsync,
  isExcludedByConfig, extractText, getOcrTooling, isSparsePdfText,
} from "./chunking.ts";
export { mdTargetFor, legacyOcrTargetFor, resolveMdTarget, sha256File, readChecksumFile, scanMarkdownSync } from "./md-sync.ts";
export type { MdSyncStatus, MdSyncReport, MdSyncState, MdSyncReason, MdTarget, MdSyncStyle } from "./md-sync.ts";
export { computeCoverage, coverageVerdictLabel } from "./coverage.ts";
export { autoCompleteCoverage, convertOneDocument } from "./auto-fix.ts";
export type { AutoFixOptions, AutoFixResult, AutoFixOutcome } from "./auto-fix.ts";
export type { CoverageReport, CoverageVerdict } from "./coverage.ts";
export { embed, embedBatch, rerank, isRerankerEnabled } from "./embed.ts";
export type { ScoredChunk, ParentContent } from "./search.ts";
export { cosineSimilarity, normalize, hybridSearch } from "./search.ts";
export { isIndexStale, indexFiles } from "./indexing.ts";
export type { ProgressCallbacks } from "./indexing.ts";

// ─── Extension ────────────────────────────────────────────────────────────────

/** Data stored in a /rag coverage transcript entry (report + reported-at time). */
interface CoverageEntry extends CoverageReport {
  timestamp: number;
}

/** Minimal theme surface consumed by the coverage entry renderer. The runtime
 *  resolves @mariozechner/* to @earendil-works/* (pi's extension loader
 *  aliases), which provides the full Theme; the npm-resolved typings in
 *  node_modules predate registerEntryRenderer, so this is declared locally. */
interface EntryRendererTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** Runtime-only ExtensionAPI surface: registerEntryRenderer ships with
 *  @earendil-works/pi-coding-agent and is aliased into @mariozechner/* at
 *  load time, but is absent from the old npm typings. Guarded by a runtime
 *  typeof check so older pi versions still load the extension. */
interface ExtensionAPICompat extends ExtensionAPI {
  registerEntryRenderer<T>(
    customType: string,
    renderer: (entry: { data?: T }, options: { expanded: boolean }, theme: EntryRendererTheme) => unknown,
  ): void;
}

export default function (pi: ExtensionAPI) {
  // ── Register entry renderer for /rag coverage output (renders in transcript) ──
  const api = pi as ExtensionAPICompat;
  if (api.registerEntryRenderer) {
    api.registerEntryRenderer<CoverageEntry>("rag-coverage", (entry, { expanded }, th) => {
    const report = entry.data ?? {
      root: "", verdict: "complete" as const,
      markdown: { total: 0, indexed: 0, missing: [], modified: [] },
      documents: { total: 0, needs_convert: 0, checksum_missing: 0, up_to_date: 0 },
      index: { chunks: 0, tokens: 0, vectors: 0, vectorCoveragePct: 0, lastBuild: "", stale: false },
      timestamp: Date.now(),
    };
    const box = new Box(1, 1, (s) => th.bg("customMessageBg", s));

    const addLine = (text: string) => { box.addChild(new Text(text, 0, 0)); };
    const addEmpty = () => { box.addChild(new Text("", 0, 0)); };

    addLine(th.bold("🧭 RAG coverage") + th.fg("dim", `  ${report.root || ""}`));
    addEmpty();
    addLine(th.bold(report.verdict === "complete" ? th.fg("success", "✅ " + coverageVerdictLabel(report.verdict)) : th.fg("warning", coverageVerdictLabel(report.verdict))));
    addEmpty();
    addLine(th.fg("dim", "  Markdown:") + `  ${report.markdown.indexed}/${report.markdown.total} indexed` +
      (report.markdown.missing.length ? th.fg("warning", `  · ${report.markdown.missing.length} missing`) : "") +
      (report.markdown.modified.length ? th.fg("warning", `  · ${report.markdown.modified.length} modified`) : ""));
    addLine(th.fg("dim", "  Documents:") + `  ${report.documents.total} total` +
      th.fg("warning", `  · ${report.documents.needs_convert} needs convert`) +
      th.fg("muted", `  · ${report.documents.checksum_missing} checksum missing`) +
      th.fg("success", `  · ${report.documents.up_to_date} up to date`));
    addLine(th.fg("dim", "  Index:") + `  ${report.index.chunks} chunks / ${report.index.vectors} vectors (${report.index.vectorCoveragePct}%)` +
      (report.index.stale ? th.fg("warning", "  · STALE") : th.fg("success", "  · fresh")));

    if (report.markdown.missing.length) {
      addEmpty();
      addLine(th.fg("warning", "  Missing md:"));
      for (const m of report.markdown.missing.slice(0, expanded ? undefined : 8)) {
        addLine("    " + th.fg("dim", m));
      }
      if (report.markdown.missing.length > 8) {
        addLine(th.fg("dim", `    … and ${report.markdown.missing.length - 8} more`));
      }
      addLine(th.fg("dim", "  → run /rag index . (or /rag refresh)"));
    }
    if (report.markdown.modified.length) {
      addEmpty();
      addLine(th.fg("warning", "  Modified md:"));
      for (const m of report.markdown.modified.slice(0, expanded ? undefined : 8)) {
        addLine("    " + th.fg("dim", m));
      }
      addLine(th.fg("dim", "  → run /rag refresh"));
    }
    if (report.documents.needs_convert || report.documents.checksum_missing) {
      addEmpty();
      addLine(th.fg("dim", "  → convert with convert-documents-to-markdown skill, then /rag mdsync"));
    }
    if (report.timestamp) {
      addEmpty();
      addLine(th.fg("dim", `Reported at ${new Date(report.timestamp).toLocaleString()}`));
    }

    return box;
    });
  }

  // Throttle stale-index checks to once per hour so we don't repeatedly stat
  // the filesystem on every agent turn (matches the upstream fork's
  // lastStaleCheckMs pattern from kallewoof@849e485).
  let lastStaleCheckMs = 0;
  const STALE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

  // ── Auto-inject RAG context before every agent turn ──
  pi.on("before_agent_start", async (event, _ctx) => {
    const config = loadConfig();
    if (!config.ragEnabled) return;

    // RAG auto-injection is an enhancement — a lookup/embedding failure must
    // NEVER block the agent turn (that manifests as the conversation showing
    // nothing). Any error here is logged to stderr and swallowed.
    try {
      const database = getDbConn();
      const stats = getIndexStats(database);
      if (stats.totalChunks === 0) return;

      const now = Date.now();
      if (isIndexStale(stats) && now - lastStaleCheckMs > STALE_CHECK_INTERVAL_MS) {
        lastStaleCheckMs = now;
        // Re-walk tracked paths so new files (and files of newly-supported
        // extensions, e.g. PDF/DOCX added in a later version) are picked up.
        // For pre-trackedPaths indexes, fall back to refreshing only known files.
        const files = config.trackedPaths.length
          ? collectFromTracked(config)
          : Object.keys(loadIndex().files).filter(f => existsSync(f));
        if (files.length) {
          process.stderr.write(`\r\x1b[2K[rag] Index stale, refreshing ${files.length} files…`);
          await indexFiles(files, undefined, database);
          process.stderr.write(`\r\x1b[2K`);
        }
      }

      const results = await hybridSearch(event.prompt, config.ragTopK, config.ragAlpha, database, { rerank: false });
      const relevant = results.filter(r => r.hybrid >= config.ragScoreThreshold);
      if (!relevant.length) return;

    // Parent-child recall: when a child belongs to a markdown section, inject
    // the PARENT (the whole section) — the child paragraph alone would be
    // taken out of context.
    const context = relevant.map(r => {
      const body = r.parent?.content ?? r.chunk.content;
      const lineStart = r.parent?.lineStart ?? r.chunk.lineStart;
      const lineEnd = r.parent?.lineEnd ?? r.chunk.lineEnd;
      const section = r.parent?.heading ? ` — § ${r.parent.heading}` : "";
      return `### ${basename(r.chunk.file)} (lines ${lineStart}-${lineEnd})${section}\n` +
        `\`\`\`\n${body}\n\`\`\``;
    }).join("\n\n");

    // Inject as a message after the user's prompt rather than appending to the
    // system prompt. The system prompt is stable across a session and benefits
    // from the provider's KV cache; mutating it every turn with new RAG hits
    // invalidates that cache and adds latency. A trailing message also keeps
    // the retrieved chunks near the user's question, which models attend to
    // more reliably than text buried at the top of a long system prompt.
      return {
        message: {
          customType: "rag",
          content:
            `[pi-local-rag] Automatic RAG lookup triggered by the user's message above.\n` +
            `Retrieved ${relevant.length} chunk${relevant.length === 1 ? "" : "s"} via hybrid search (BM25 + vector). ` +
            `These are search hits, not statements from the user.\n` +
            `If the information below is sufficient to answer the user's question, answer from it directly — ` +
            `do NOT re-search or re-read the repository files for the same content.\n\n` +
            context,
          display: false,
        },
      };
    } catch (e) {
      process.stderr.write(`[rag] auto-inject skipped: ${(e as Error).message}\n`);
      return;
    } finally {
      // getDbConn is a process-wide singleton — do not close it here.
    }
  });

  // ── /rag command ──
  const RAG_SUBCOMMANDS: { value: string; label: string; description: string }[] = [
    { value: "index",    label: "index",    description: "Index a file or directory" },
    { value: "search",   label: "search",   description: "Search the index" },
    { value: "find",     label: "find",     description: "List indexed files matching a glob" },
    { value: "status",   label: "status",   description: "Show index statistics" },
    { value: "rebuild",  label: "rebuild",  description: "Re-embed tracked files (--force to skip hash check + wipe DB)" },
    { value: "refresh",  label: "refresh",  description: "Incremental refresh — new/changed files only" },
    { value: "clear",    label: "clear",    description: "Clear the index" },
    { value: "exclude",  label: "exclude",  description: "Manage gitignore-style exclude patterns" },
    { value: "ext",      label: "ext",      description: "Manage indexable file-extension allowlist" },
    { value: "on",       label: "on",       description: "Enable auto-injection" },
    { value: "off",      label: "off",      description: "Disable auto-injection" },
    { value: "mdsync",   label: "mdsync",   description: "Scan non-md documents for conversion state (checksum check)" },
    { value: "coverage", label: "coverage", description: "Completeness report: indexed md vs disk, document conversion, index health" },
    { value: "help",     label: "help",     description: "Show all /rag commands" },
  ];

  pi.registerCommand("rag", {
    description: "pi-local-rag: /rag index|search|find|status|rebuild [--force]|refresh|clear|exclude|on|off|ext",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const filtered = RAG_SUBCOMMANDS
        .filter((s) => s.value.startsWith(prefix))
        .map((s) => ({ value: s.value, label: s.label, description: s.description }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const cmd = parts[0] || "status";

      // ── index ──
      if (cmd === "index") {
        const path = parts[1] || ".";
        if (!existsSync(path)) { ctx.ui.notify(`Path not found: ${path}`, "error"); return; }
        // Anchor a project-local store at cwd if there isn't one in scope yet.
        getRagDir({ createIfMissing: true });
        const config = loadConfig();
        const absPath = resolve(path);
        if (!config.trackedPaths.includes(absPath)) {
          config.trackedPaths.push(absPath);
          saveConfig(config);
        }
        const files = collectFiles(absPath, undefined, config.excludePatterns);
        if (!files.length) { ctx.ui.notify(`No indexable files found in: ${path}`, "warning"); return; }

        const total = files.length;
        ctx.ui.notify(`Found ${total} files to index`, "info");

        function progressBar(n: number, total: number, width = 24): string {
          const filled = Math.round((n / total) * width);
          return CYAN + "█".repeat(filled) + D + "░".repeat(width - filled) + RST;
        }

        const result = await indexFiles(files, {
          onFile(current, total, filename, skipped) {
            const pct = Math.round((current / total) * 100);
            const bar = progressBar(current, total);
            ctx.ui.setStatus("rag", `■ Indexing ${pct}% │ ${current}/${total} files │ ${skipped} unchanged`);
            ctx.ui.setWidget("rag", [
              `${B}${CYAN}Indexing${RST}  ${bar}  ${GREEN}${pct}%${RST}`,
              `${D}file:    ${RST}${filename}`,
              `${D}done:    ${RST}${GREEN}${current - skipped} embedded${RST}  ${D}${skipped} unchanged${RST}`,
            ]);
          },
          onChunk(ci, total, filename) {
            ctx.ui.setStatus("rag", `■ Embedding ${filename} — chunk ${ci}/${total}`);
          },
          onSave() {
            ctx.ui.setStatus("rag", `■ Saving index...`);
          },
        });

        ctx.ui.setStatus("rag", undefined);
        ctx.ui.setWidget("rag", undefined);

        const secs = (result.durationMs / 1000).toFixed(1);
        const ragDir = getRagDir();
        const scope = ragDir === GLOBAL_RAG_DIR() ? "global" : "project";
        ctx.ui.notify(`✅ Indexed ${result.indexed} files (${result.chunks} chunks) · ${result.skipped} unchanged · ${secs}s · tracking ${config.trackedPaths.length} path(s) · ${scope} store`, "info");
        return;
      }

      // ── search ──
      if (cmd === "search") {
        const query = parts.slice(1).join(" ");
        if (!query) { ctx.ui.notify("Usage: /rag search <query>", "warning"); return; }
        const config = loadConfig();
        const database = getDbConn();
        const results = await hybridSearch(query, 10, config.ragAlpha, database);
        if (!results.length) { ctx.ui.notify(`No results for: ${query}`, "warning"); return; }

        const th = ctx.ui.theme;
        const hasVectors = getIndexStats(database).embeddedCount > 0;
        const lines: string[] = [
          th.bold(th.fg("accent", "🔍 ") + `${results.length} results for "${query}"`) +
            "  " + th.fg("dim", hasVectors ? "hybrid BM25+vector" : "BM25 only"),
          "",
        ];
        for (const r of results) {
          const lineStart = r.parent?.lineStart ?? r.chunk.lineStart;
          const lineEnd = r.parent?.lineEnd ?? r.chunk.lineEnd;
          const section = r.parent?.heading ? ` — § ${r.parent.heading}` : "";
          lines.push(
            th.fg("success", basename(r.chunk.file)) +
            th.fg("muted", `:${lineStart}-${lineEnd}`) +
            section +
            "  " + th.fg("dim", `score=${r.hybrid.toFixed(2)}${r.rerank !== undefined ? ` rerank=${r.rerank.toFixed(2)}` : ""}`)
          );
          const preview = (r.parent?.content ?? r.chunk.content).split("\n").slice(0, 3).join("\n");
          lines.push(th.fg("dim", preview.slice(0, 200)));
          lines.push("");
        }
        ctx.ui.setWidget("rag-search", lines);
        return;
      }

      // ── mdsync: scan documents for markdown conversion state ──
      if (cmd === "mdsync") {
        const config = loadConfig();
        const target = parts[1] ? resolve(parts[1]) : config.trackedPaths[0] ?? process.cwd();
        if (!existsSync(target)) { ctx.ui.notify(`Path not found: ${target}`, "error"); return; }
        const docs = collectFiles(target, DOC_CONVERT_EXTS, config.excludePatterns);
        const report = await scanMarkdownSync(docs);
        const th = ctx.ui.theme;
        const lines: string[] = [
          th.bold("📄 Markdown sync") + th.fg("dim", `  scanned ${docs.length} document(s)`),
          "",
          th.fg("success", `  ${report.up_to_date.length} up-to-date`),
          th.fg("warning", `  ${report.needs_convert.length} need conversion`),
          th.fg("muted", `  ${report.checksum_missing.length} checksum missing`),
          "",
        ];
        for (const s of report.needs_convert) {
          const rel = s.file.startsWith(process.cwd()) ? s.file.slice(process.cwd().length + 1) : s.file;
          lines.push(th.fg("warning", `  ⚠ ${rel}`) + "  " + th.fg("dim", `→ ${s.targetMd} (${s.reason})`));
        }
        for (const s of report.checksum_missing) {
          const rel = s.file.startsWith(process.cwd()) ? s.file.slice(process.cwd().length + 1) : s.file;
          lines.push(th.fg("muted", `  ? ${rel}`) + "  " + th.fg("dim", `→ ${s.checksumFile} missing`));
        }
        if (docs.length === 0) lines.push(th.fg("dim", "  (no non-md documents found)"));
        lines.push("", th.fg("dim", "Convert via the convert-documents-to-markdown skill (anydoc / batch-ocr)."));
        ctx.ui.setWidget("rag-mdsync", lines);
        return;
      }

      // ── coverage: completeness report (+ --auto) ──
      if (cmd === "coverage") {
        const config = loadConfig();
        const auto = parts.includes("--auto");
        const pathArg = parts.slice(1).find(p => !p.startsWith("-"));
        const target = pathArg ? resolve(pathArg) : config.trackedPaths[0] ?? process.cwd();
        if (!existsSync(target)) { ctx.ui.notify(`Path not found: ${target}`, "error"); return; }

        const env = process.env;
        const autoOpts = {
          excludePatterns: config.excludePatterns,
          ocrCli: env.RAG_OCR_CLI || undefined,
          ocrApi: env.RAG_OCR_API || undefined,
        };
        if (auto) {
          // Auto-completion converts documents and re-embeds markdown — that
          // takes minutes. Give immediate feedback and stream progress to the
          // footer status so it never looks like the command silently died.
          ctx.ui.notify("⏳ /rag coverage --auto：正在補齊知識庫（轉檔+索引），進度顯示於底部狀態列，可能需要數分鐘…", "info");
        }
        const report = auto
          ? (await autoCompleteCoverage(target, autoOpts, (msg) => {
              ctx.ui.setStatus("rag", `■ coverage --auto: ${msg}`);
            })).after
          : await computeCoverage(target, { excludePatterns: config.excludePatterns });
        if (auto) ctx.ui.setStatus("rag", undefined);

        pi.appendEntry<CoverageEntry>("rag-coverage", { ...report, timestamp: Date.now() });
        return;
      }

      // ── on/off toggle ──
      if (cmd === "on" || cmd === "off") {
        const config = loadConfig();
        config.ragEnabled = cmd === "on";
        saveConfig(config);
        ctx.ui.notify(cmd === "on" ? "RAG auto-injection enabled" : "RAG auto-injection disabled", "info");
        return;
      }

      // ── rebuild ──
      if (cmd === "rebuild") {
        // Parse --force flag from any position after "rebuild".
        const rebuildArgs = parts.slice(1);
        const force = rebuildArgs.includes("--force");

        // Anchor the store at the repo (cwd) — rebuild writes the index and
        // must never silently fall back to the global ~/.pi/rag store.
        getRagDir({ createIfMissing: true });
        const database = getDbConn();
        const config = loadConfig();
        try {
          const indexedRows = database.prepare("SELECT path FROM files").all() as Array<{ path: string }>;
          const indexedFileSet = new Set(indexedRows.map(f => f.path));

          // Walking tracked paths can stall the event loop on large trees
          // (45k+ files). Use the async variant + yield up-front so the user
          // gets immediate feedback before the heavy work begins.
          ctx.ui.notify("Scanning tracked paths...", "info");
          const trackedFiles = await collectFromTrackedAsync(config);

          // Union of currently-indexed files and files discovered by walking tracked paths.
          const targetSet = new Set<string>([...trackedFiles]);
          for (const f of indexedFileSet) {
            if (existsSync(f) && !isExcludedByConfig(f, config.trackedPaths, config.excludePatterns)) {
              targetSet.add(f);
            }
          }
          const targetFiles = [...targetSet];

          if (!targetFiles.length && !indexedFileSet.size) {
            ctx.ui.notify("No files to rebuild. Run /rag index <path> first.", "warning");
            return;
          }

          // Files in the index but no longer present (deleted, excluded, or untracked).
          const droppedFiles = [...indexedFileSet].filter(f => !targetSet.has(f));
          for (const f of droppedFiles) {
            database.prepare("DELETE FROM chunks_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE file_path = ?)").run(f);
            database.prepare("DELETE FROM chunks WHERE file_path = ?").run(f);
            database.prepare("DELETE FROM parents WHERE file_path = ?").run(f);
            database.prepare("DELETE FROM files WHERE path = ?").run(f);
          }
          if (force) {
            // --force: wipe everything and rebuild the FTS index. indexFiles
            // will then insert fresh rows for every targetFile, bypassing the
            // skip-on-equal-hash check.
            database.exec("DELETE FROM chunks_vec; DELETE FROM chunks; DELETE FROM parents; DELETE FROM files;");
            database.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
          } else {
            for (const f of targetFiles) {
              database.prepare("UPDATE files SET embedded = 0 WHERE path = ?").run(f);
            }
          }

          const newFiles = targetFiles.filter(f => !indexedFileSet.has(f));
          ctx.ui.notify(`Rebuilding ${targetFiles.length} files${force ? " (forced)" : ""}...`, "info");
          if (droppedFiles.length) ctx.ui.notify(`Pruned ${droppedFiles.length} files (deleted/excluded)`, "info");
          if (newFiles.length) ctx.ui.notify(`Discovered ${newFiles.length} new files`, "info");

          // Yield so the TUI can paint the "Rebuilding" message before
          // indexFiles starts hammering the event loop.
          await new Promise<void>(r => setTimeout(r, 0));

          function progressBar(n: number, total: number, width = 24): string {
            const filled = Math.round((n / total) * width);
            return CYAN + "█".repeat(filled) + D + "░".repeat(width - filled) + RST;
          }

          const result = await indexFiles(targetFiles, {
            onFile(current, total, filename, skipped) {
              const pct = Math.round((current / total) * 100);
              const bar = progressBar(current, total);
              ctx.ui.setStatus("rag", `■ Rebuilding ${pct}% │ ${current}/${total} │ ${skipped} unchanged`);
              ctx.ui.setWidget("rag", [
                `${B}${CYAN}Rebuilding${RST}  ${bar}  ${GREEN}${pct}%${RST}`,
                `${D}file:    ${RST}${filename}`,
                `${D}done:    ${RST}${GREEN}${current - skipped} re-embedded${RST}  ${D}${skipped} unchanged${RST}`,
              ]);
            },
            onEmbed(done, total) {
              const pct = Math.round((done / total) * 100);
              const bar = progressBar(done, total);
              ctx.ui.setStatus("rag", `■ Embedding ${pct}% │ ${done}/${total} chunks`);
              ctx.ui.setWidget("rag", [
                `${B}${CYAN}Embedding${RST}  ${bar}  ${GREEN}${pct}%${RST}`,
                `${D}chunks:  ${RST}${done}/${total}`,
              ]);
            },
            onChunk(ci, total, filename) {
              ctx.ui.setStatus("rag", `■ Embedding ${filename} — chunk ${ci}/${total}`);
            },
            onSave() {
              ctx.ui.setStatus("rag", `■ Saving index...`);
            },
          }, database, force);

          ctx.ui.setStatus("rag", undefined);
          ctx.ui.setWidget("rag", undefined);

          const secs = (result.durationMs / 1000).toFixed(1);
          ctx.ui.notify(`✅ Rebuilt: ${result.indexed} re-indexed · ${result.skipped} unchanged · ${droppedFiles.length} deleted · ${result.chunks} chunks · ${secs}s`, "info");
        } finally {
          // getDbConn is a process-wide singleton — do not close it here.
        }
        return;
      }

      // ── refresh (on-demand equivalent of the 24h auto-refresh) ──
      if (cmd === "refresh") {
        // Anchor the store at the repo (cwd) — refresh writes the index and
        // must never silently fall back to the global ~/.pi/rag store.
        getRagDir({ createIfMissing: true });
        const config = loadConfig();
        const index = loadIndex();
        const files = config.trackedPaths.length
          ? collectFromTracked(config)
          : Object.keys(index.files).filter(f => existsSync(f));
        if (!files.length) {
          ctx.ui.notify("No tracked files to refresh. Run /rag index <path> first.", "warning");
          return;
        }

        ctx.ui.notify(`Refreshing ${files.length} files...`, "info");

        function progressBar(n: number, total: number, width = 24): string {
          const filled = Math.round((n / total) * width);
          return CYAN + "█".repeat(filled) + D + "░".repeat(width - filled) + RST;
        }

        const result = await indexFiles(files, {
          onFile(current, total, filename, skipped) {
            const pct = Math.round((current / total) * 100);
            const bar = progressBar(current, total);
            ctx.ui.setStatus("rag", `■ Refreshing ${pct}% │ ${current}/${total} │ ${skipped} unchanged`);
            ctx.ui.setWidget("rag", [
              `${B}${CYAN}Refreshing${RST}  ${bar}  ${GREEN}${pct}%${RST}`,
              `${D}file:    ${RST}${filename}`,
              `${D}done:    ${RST}${GREEN}${current - skipped} new/changed${RST}  ${D}${skipped} unchanged${RST}`,
            ]);
          },
          onChunk(ci, total, filename) {
            ctx.ui.setStatus("rag", `■ Embedding ${filename} — chunk ${ci}/${total}`);
          },
          onSave() {
            ctx.ui.setStatus("rag", `■ Saving index...`);
          },
        });

        ctx.ui.setStatus("rag", undefined);
        ctx.ui.setWidget("rag", undefined);

        const secs = (result.durationMs / 1000).toFixed(1);
        ctx.ui.notify(`✅ Refreshed ${result.indexed} new/changed · ${result.skipped} unchanged · ${result.chunks} chunks · ${secs}s`, "info");
        return;
      }

      // ── ext (configure file extensions) ──
      if (cmd === "ext") {
        const sub = (parts[1] || "list").toLowerCase();
        const config = loadConfig();

        if (sub === "list") {
          const th = ctx.ui.theme;
          const active = Array.from(resolveExtensions(config)).sort();
          const lines: string[] = [
            th.bold("Active file extensions") + "  " + th.fg("dim", `(${active.length})`),
            th.fg("muted", "  " + active.join(" ")),
          ];
          if (config.extraExtensions.length)
            lines.push("  " + th.fg("dim", "extra:   ") + th.fg("success", config.extraExtensions.join(" ")));
          if (config.excludeExtensions.length)
            lines.push("  " + th.fg("dim", "excluded:") + " " + th.fg("warning", config.excludeExtensions.join(" ")));
          lines.push("", th.fg("dim", "Edit via /rag ext add <.ext> / remove <.ext> / reset"));
          ctx.ui.setWidget("rag-ext", lines);
          return;
        }

        if (sub === "add") {
          const ext = normalizeExt(parts[2] || "");
          if (!ext) { ctx.ui.notify("Usage: /rag ext add <.ext>", "warning"); return; }
          config.excludeExtensions = config.excludeExtensions.filter(e => normalizeExt(e) !== ext);
          if (!config.extraExtensions.map(normalizeExt).includes(ext)) config.extraExtensions.push(ext);
          saveConfig(config);
          ctx.ui.notify(`Added ${ext} to indexable extensions. Run /rag index <path> to pick up matching files.`, "info");
          return;
        }

        if (sub === "remove" || sub === "rm") {
          const ext = normalizeExt(parts[2] || "");
          if (!ext) { ctx.ui.notify("Usage: /rag ext remove <.ext>", "warning"); return; }
          const wasExtra = config.extraExtensions.map(normalizeExt).includes(ext);
          config.extraExtensions = config.extraExtensions.filter(e => normalizeExt(e) !== ext);
          if (!wasExtra && !config.excludeExtensions.map(normalizeExt).includes(ext)) config.excludeExtensions.push(ext);
          saveConfig(config);
          ctx.ui.notify(`Removed ${ext} from indexable extensions.`, "info");
          return;
        }

        if (sub === "reset") {
          config.extraExtensions = [];
          config.excludeExtensions = [];
          saveConfig(config);
          ctx.ui.notify("Extension list reset to defaults.", "info");
          return;
        }

        ctx.ui.notify("Usage: /rag ext list|add <.ext>|remove <.ext>|reset", "warning");
        return;
      }

      // ── clear ──
      if (cmd === "clear") {
        saveIndex({ chunks: [], files: {}, lastBuild: "" });
        ctx.ui.notify("Index cleared.", "info");
        return;
      }

      // ── exclude ──
      if (cmd === "exclude") {
        const config = loadConfig();
        const expr = parts.slice(1).join(" ").trim();
        const th = ctx.ui.theme;

        if (!expr) {
          if (!config.excludePatterns.length) {
            ctx.ui.notify("No exclude patterns set. Add one with: /rag exclude <pattern>", "info");
            return;
          }
          const lines: string[] = [
            th.bold(`Exclude patterns (${config.excludePatterns.length})`),
            "",
          ];
          for (const p of config.excludePatterns) lines.push("  " + th.fg("muted", p));
          ctx.ui.setWidget("rag-exclude", lines);
          return;
        }

        if (expr.startsWith("-")) {
          const target = expr.slice(1);
          const before = config.excludePatterns.length;
          config.excludePatterns = config.excludePatterns.filter(p => p !== target);
          if (config.excludePatterns.length === before) {
            ctx.ui.notify(`Pattern not found: ${target}`, "warning");
            return;
          }
          saveConfig(config);
          ctx.ui.notify(`✅ Removed exclude: ${target} · ${config.excludePatterns.length} pattern(s) remain. Run /rag rebuild to re-apply.`, "info");
          return;
        }

        if (config.excludePatterns.includes(expr)) {
          ctx.ui.notify(`Already excluded: ${expr}`, "warning");
          return;
        }
        config.excludePatterns.push(expr);
        saveConfig(config);
        ctx.ui.notify(`✅ Added exclude: ${expr} · ${config.excludePatterns.length} pattern(s) total. Run /rag rebuild to re-apply.`, "info");
        return;
      }

      // ── find ──
      if (cmd === "find") {
        const glob = parts.slice(1).join(" ").trim();
        if (!glob) {
          ctx.ui.notify("Usage: /rag find <glob>   e.g. *.html, page*, foo.js, src/*.ts", "warning");
          return;
        }

        const index = loadIndex();
        const cwd = process.cwd();
        const ig = ignore().add([glob]);

        const matches: string[] = [];
        for (const fp of Object.keys(index.files)) {
          const rel = relative(cwd, fp);
          const candidate = rel && !rel.startsWith("..") ? rel : basename(fp);
          if (ig.ignores(candidate)) matches.push(fp);
        }
        matches.sort();

        if (!matches.length) {
          ctx.ui.notify(`No indexed files match: ${glob}`, "warning");
          return;
        }
        const th = ctx.ui.theme;
        const lines: string[] = [
          th.bold(`🔍 ${matches.length} indexed file${matches.length === 1 ? "" : "s"} matching "${glob}"`),
          "",
        ];
        for (const fp of matches) lines.push(th.fg("success", fp));
        ctx.ui.setWidget("rag-find", lines);
        return;
      }

      // ── help ──
      if (cmd === "help") {
        const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
        const cmds: [string, string][] = [
          ["/rag index <path>",       "Index a file or directory (chunks, embeds, stores)"],
          ["/rag search <query>",     "Hybrid BM25 + vector search over the index"],
          ["/rag find <glob>",        "List indexed files matching a glob (e.g. *.ts, src/*)"],
          ["/rag status",             "Show index stats and active configuration"],
          ["/rag rebuild [--force]",  "Re-embed tracked files; --force wipes DB and bypasses hash skip"],
          ["/rag refresh",            "Incremental refresh — only new/changed files (also fires automatically every 24h)"],
          ["/rag clear",              "Delete all indexed chunks"],
          ["/rag exclude <pattern>",  "Add a gitignore-style exclude pattern (omit to list; -<pattern> to remove)"],
          ["/rag ext list|add|remove|reset", "Manage the indexable file-extension allowlist"],
          ["/rag on",                 "Enable automatic RAG injection before each agent turn"],
          ["/rag off",                "Disable automatic RAG injection"],
          ["/rag mdsync [path]",      "Scan non-md documents for markdown conversion state"],
          ["/rag coverage [path]",    "Completeness report: indexed md vs disk, document conversion, index health"],
          ["/rag help",               "Show this help"],
        ];
        const COL = 36;
        const th = ctx.ui.theme;
        const lines: string[] = [th.bold("pi-local-rag commands"), ""];
        for (const [usage, desc] of cmds) {
          lines.push("  " + th.fg("success", pad(usage, COL)) + "  " + th.fg("dim", desc));
        }
        ctx.ui.setWidget("rag-help", lines);
        return;
      }

      // ── status (default) ──
      const index = loadIndex();
      const config = loadConfig();
      const database = getDbConn();
      const stats = getIndexStats(database);
      const fileCount = stats.totalFiles;
      const totalTokens = stats.totalTokens;
      const embeddedCount = stats.embeddedCount;
      const vectorCoverage = stats.totalChunks ? Math.round(embeddedCount / stats.totalChunks * 100) : 0;

      const th = ctx.ui.theme;
      const label = (k: string) => th.fg("dim", k.padEnd(18));
      const val = (v: string | number) => th.fg("success", String(v));
      const ragDir = getRagDir();
      const scope = ragDir === GLOBAL_RAG_DIR() ? "global" : "project";
      const lines: string[] = [
        th.bold("🔍 pi-local-rag"),
        "",
        "  " + label("Files indexed:")  + val(fileCount),
        "  " + label("Chunks:")         + val(stats.totalChunks),
        "  " + label("Vectors:")        + val(embeddedCount) + "  " + th.fg("dim", `(${vectorCoverage}% coverage)`),
        "  " + label("Total tokens:")   + val(totalTokens.toLocaleString()),
        "  " + label("Embedding model:") + th.fg("dim", stats.embeddingModel || "none"),
        "  " + label("Last build:")     + (stats.lastBuild || th.fg("dim", "never")),
        "  " + label("Storage:")        + th.fg("dim", `${ragDir} (${scope})`),
        "",
        "  " + label("RAG injection:")  +
          (config.ragEnabled ? th.fg("success", "enabled") : th.fg("warning", "disabled")) +
          th.fg("dim", `  topK=${config.ragTopK}  threshold=${config.ragScoreThreshold}  alpha=${config.ragAlpha}`),
      ];

      if (fileCount) {
        lines.push("", "  " + th.bold("File types:"));
        const byExt: Record<string, number> = {};
        for (const f of Object.keys(index.files)) byExt[extname(f)] = (byExt[extname(f)] || 0) + 1;
        for (const [ext, count] of Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
          lines.push("    " + th.fg("muted", ext) + "  " + th.fg("dim", String(count)));
        }
      }

      lines.push(
        "",
        "  " + label("Reranker:") +
          (isRerankerEnabled() ? th.fg("success", "enabled") : th.fg("warning", "disabled")),
      );

      lines.push("", "  " + th.bold("Tracked paths:"));
      if (config.trackedPaths.length) {
        for (const p of config.trackedPaths) lines.push("    " + th.fg("muted", p));
      } else {
        lines.push("    " + th.fg("dim", "(none — run /rag index <path> to track)"));
      }

      lines.push("", "  " + th.bold("Exclude patterns:"));
      if (config.excludePatterns.length) {
        for (const p of config.excludePatterns) lines.push("    " + th.fg("muted", p));
      } else {
        lines.push("    " + th.fg("dim", "(none — add with /rag exclude <pattern>)"));
      }

      ctx.ui.setWidget("rag-status", lines);
    },
  });

  // ── Tools ──

  pi.registerTool({
    name: "rag_index",
    label: "RAG index",
    description: "Index a file or directory into the local pi-local-rag pipeline. Chunks text files (including PDF and DOCX), generates embeddings, stores for hybrid BM25+vector search.",
    parameters: Type.Object({
      path: Type.String({ description: "File or directory path to index" }),
    }),
    execute: async (_toolCallId, params) => {
      if (!existsSync(params.path)) return { content: [{ type: "text" as const, text: `Path not found: ${params.path}` }], details: undefined };
      // Anchor a project-local store at cwd if there isn't one in scope yet.
      getRagDir({ createIfMissing: true });
      const config = loadConfig();
      const absPath = resolve(params.path);
      if (!config.trackedPaths.includes(absPath)) {
        config.trackedPaths.push(absPath);
        saveConfig(config);
      }
      const files = collectFiles(absPath, undefined, config.excludePatterns);
      if (!files.length) return { content: [{ type: "text" as const, text: `No indexable files found in: ${params.path}` }], details: undefined };
      const result = await indexFiles(files, {});
      process.stderr.write(`\n`);
      return { content: [{ type: "text" as const, text: `Indexed ${result.indexed} files (${result.chunks} chunks, embeddings generated). ${result.skipped} unchanged. ${(result.durationMs / 1000).toFixed(1)}s` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "rag_query",
    label: "RAG query",
    description: "Search the local pi-local-rag index using hybrid BM25+vector search. Returns relevant chunks with file paths, line numbers, and relevance scores.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    execute: async (_toolCallId, params) => {
      const database = getDbConn();
      const stats = getIndexStats(database);
      if (stats.totalChunks === 0) return { content: [{ type: "text" as const, text: "pi-local-rag index is empty. Run rag_index first." }], details: undefined };
      const config = loadConfig();
      const results = await hybridSearch(params.query, params.limit ?? 10, config.ragAlpha, database);
      if (!results.length) return { content: [{ type: "text" as const, text: `No results for: ${params.query}` }], details: undefined };
      const text = JSON.stringify(results.map(r => ({
        file: r.chunk.file,
        lines: `${r.parent?.lineStart ?? r.chunk.lineStart}-${r.parent?.lineEnd ?? r.chunk.lineEnd}`,
        section: r.parent?.heading ?? null,
        childLines: `${r.chunk.lineStart}-${r.chunk.lineEnd}`,
        tokens: r.chunk.tokens,
        scores: { bm25: r.bm25.toFixed(3), vector: r.vector.toFixed(3), hybrid: r.hybrid.toFixed(3), rerank: r.rerank?.toFixed(3) ?? null },
        parent: r.parent?.content ?? null,
        preview: r.chunk.content.slice(0, 300),
      })), null, 2);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "rag_status",
    label: "RAG status",
    description: "Show pi-local-rag index statistics: file count, chunk count, vector coverage, embedding model, RAG config.",
    parameters: Type.Object({}),
    execute: async (_toolCallId) => {
      const config = loadConfig();
      const database = getDbConn();
      const stats = getIndexStats(database);
      const embeddedCount = stats.embeddedCount;
      const text = JSON.stringify({
        files: stats.totalFiles,
        chunks: stats.totalChunks,
        vectorsEmbedded: embeddedCount,
        vectorCoverage: stats.totalChunks ? `${Math.round(embeddedCount / stats.totalChunks * 100)}%` : "0%",
        embeddingModel: stats.embeddingModel || "none",
        reranker: isRerankerEnabled(),
        totalTokens: stats.totalTokens,
        lastBuild: stats.lastBuild || "never",
        ragConfig: config,
        storagePath: getRagDir(),
        storageScope: getRagDir() === GLOBAL_RAG_DIR() ? "global" : "project",
      }, null, 2);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "rag_md_sync",
    label: "RAG md sync",
    description: "Scan non-markdown documents (docx/pdf/xlsx/csv/…) under a path for markdown conversion state: which need converting (no_markdown / checksum_changed) and which are up to date. The knowledge base indexes markdown only — convert missing documents with the convert-documents-to-markdown skill first, then /rag index.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to scan (default: first tracked path, else cwd)" })),
    }),
    execute: async (_toolCallId, params) => {
      const config = loadConfig();
      const target = params.path ? resolve(params.path) : config.trackedPaths[0] ?? process.cwd();
      if (!existsSync(target)) return { content: [{ type: "text" as const, text: `Path not found: ${target}` }], details: undefined };
      const docs = collectFiles(target, DOC_CONVERT_EXTS, config.excludePatterns);
      const report = await scanMarkdownSync(docs);
      const text = JSON.stringify({
        scanned: docs.length,
        summary: {
          up_to_date: report.up_to_date.length,
          needs_convert: report.needs_convert.length,
          checksum_missing: report.checksum_missing.length,
        },
        needs_convert: report.needs_convert.map(s => ({ file: s.file, target_md: s.targetMd, reason: s.reason })),
        checksum_missing: report.checksum_missing.map(s => ({ file: s.file, target_md: s.targetMd, checksum_file: s.checksumFile })),
        up_to_date: report.up_to_date.map(s => s.file),
      }, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          scanned: docs.length,
          up_to_date: report.up_to_date.length,
          needs_convert: report.needs_convert.length,
          checksum_missing: report.checksum_missing.length,
        } as Record<string, unknown>,
      };
    },
  });

  pi.registerTool({
    name: "rag_coverage",
    label: "RAG coverage",
    description: "Completeness report for the knowledge base: which markdown files on disk are not yet indexed or have changed, which non-md documents still need conversion/checksums, and whether the index is fresh and fully embedded. Run this at session start to decide whether to /rag index, /rag refresh, or convert documents.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to scan (default: first tracked path, else cwd)" })),
      auto: Type.Optional(Type.Boolean({ description: "When true, automatically fix gaps: index missing/changed md, write missing checksums, and convert documents (anydoc; OCR when RAG_OCR_CLI is configured)" })),
    }),
    execute: async (_toolCallId, params) => {
      const config = loadConfig();
      const target = params.path ? resolve(params.path) : config.trackedPaths[0] ?? process.cwd();
      if (!existsSync(target)) return { content: [{ type: "text" as const, text: `Path not found: ${target}` }], details: undefined };
      const env = process.env;
      const report = params.auto
        ? (await autoCompleteCoverage(target, {
            excludePatterns: config.excludePatterns,
            ocrCli: env.RAG_OCR_CLI || undefined,
            ocrApi: env.RAG_OCR_API || undefined,
          })).after
        : await computeCoverage(target, { excludePatterns: config.excludePatterns });
      const text = JSON.stringify(report, null, 2);
      return { content: [{ type: "text" as const, text }], details: { verdict: report.verdict } as Record<string, unknown> };
    },
  });
}
