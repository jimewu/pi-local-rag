#!/usr/bin/env node
/**
 * pi-rag — command-line companion to the pi-local-rag extension.
 *
 * Inspect and complete the local RAG knowledge base without starting an
 * interactive pi session:
 *
 *   pi-rag status                → index statistics + config
 *   pi-rag coverage [dir]        → completeness report
 *   pi-rag auto [dir]            → auto-complete (checksums, convert, index)
 *   pi-rag mdsync [dir]          → document conversion state
 *   pi-rag meta [path] [tags…]    → set/list per-file entity metadata tags
 *
 * Run it from the case repo directory, or pass --dir <path>. Add --json for
 * machine-readable output. Requires Node >= 23.6 (native TypeScript type
 * stripping).
 */
import { existsSync } from "node:fs";
import { extname } from "node:path";

import { RST, B, D, GREEN, YELLOW, RED } from "./constants.ts";
import { DOC_CONVERT_EXTS } from "./constants.ts";
import { getRagDir, GLOBAL_RAG_DIR } from "./store.ts";
import { loadConfig } from "./config.ts";
import { getDbConn, getFreshDbConn, closeDbConn, loadIndex, getIndexStats } from "./db.ts";
import { collectFiles } from "./chunking.ts";
import { scanMarkdownSync } from "./md-sync.ts";
import { computeCoverage, coverageVerdictLabel, type CoverageReport } from "./coverage.ts";
import { autoCompleteCoverage } from "./auto-fix.ts";
import { isRerankerEnabled } from "./embed.ts";
import { isIndexStale } from "./indexing.ts";

const USAGE = `pi-rag — pi-local-rag 命令列工具

用法:
  pi-rag <command> [options]

命令:
  status                索引狀態（檔案 / chunks / 向量 / 模型 / 設定）
  coverage [dir]        完整性報告（md vs 索引、文件轉檔、索引健康）
  auto [dir]            自動補齊知識庫（補 checksum、轉檔、索引）
  mdsync [dir]          掃描非 md 文件轉檔狀態
  meta [path] [tags…]   設定/列出每檔案實體 metadata 標記
  help                  顯示說明

選項:
  --dir <path>          case repo 根目錄（預設：目前目錄）
  --json                機器可讀 JSON 輸出
  -h, --help            顯示說明

範例:
  pi-rag status
  pi-rag coverage
  pi-rag coverage --dir /path/to/case-repo
  pi-rag auto --dir /path/to/case-repo   # 完成後即可啟動 pi 開始對話
`;

export interface CliArgs {
  command: string;
  dir?: string;
  json: boolean;
  help: boolean;
  /** Positional args after the command (e.g. `meta <path> <tags>`). */
  rest: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "status", json: false, help: false, rest: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--dir") args.dir = argv[++i];
    else if (a.startsWith("--dir=")) args.dir = a.slice("--dir=".length);
    else if (a.startsWith("-")) { /* ignore unknown flags */ }
    else positional.push(a);
  }
  if (positional.length > 0) {
    args.command = positional[0]!;
    args.rest = positional.slice(1);
  }
  if (args.command === "help") args.help = true;
  return args;
}

// ─── Formatters (pure, unit-testable) ────────────────────────────────────

export function formatStatus(opts: { json: boolean }): string {
  const config = loadConfig();
  const database = getDbConn();
  const stats = getIndexStats(database);
  const index = loadIndex();
  const ragDir = getRagDir();
  const scope = ragDir === GLOBAL_RAG_DIR() ? "global" : "project";
  const vectorCoverage = stats.totalChunks ? Math.round((stats.embeddedCount / stats.totalChunks) * 100) : 0;

  if (opts.json) {
    return JSON.stringify({
      files: stats.totalFiles,
      chunks: stats.totalChunks,
      vectorsEmbedded: stats.embeddedCount,
      vectorCoverage: `${vectorCoverage}%`,
      embeddingModel: stats.embeddingModel || "none",
      reranker: isRerankerEnabled(),
      totalTokens: stats.totalTokens,
      lastBuild: stats.lastBuild || "never",
      stale: isIndexStale(stats),
      ragConfig: config,
      storagePath: ragDir,
      storageScope: scope,
    }, null, 2);
  }

  const label = (k: string) => D + k.padEnd(18) + RST;
  const val = (v: string | number) => GREEN + String(v) + RST;
  const lines: string[] = [
    B + "🔍 pi-local-rag" + RST,
    "",
    "  " + label("Files indexed:") + val(stats.totalFiles),
    "  " + label("Chunks:") + val(stats.totalChunks),
    "  " + label("Vectors:") + val(stats.embeddedCount) + "  " + D + `(${vectorCoverage}% coverage)` + RST,
    "  " + label("Total tokens:") + val(stats.totalTokens.toLocaleString()),
    "  " + label("Embedding model:") + D + (stats.embeddingModel || "none") + RST,
    "  " + label("Last build:") + (stats.lastBuild || D + "never" + RST),
    "  " + label("Storage:") + D + `${ragDir} (${scope})` + RST,
    "",
    "  " + label("RAG injection:") +
      (config.ragEnabled ? GREEN + "enabled" + RST : YELLOW + "disabled" + RST) +
      D + `  topK=${config.ragTopK}  threshold=${config.ragScoreThreshold}  alpha=${config.ragAlpha}` + RST,
  ];

  if (stats.totalFiles) {
    lines.push("", "  " + B + "File types:" + RST);
    const byExt: Record<string, number> = {};
    for (const f of Object.keys(index.files)) byExt[extname(f)] = (byExt[extname(f)] || 0) + 1;
    for (const [ext, count] of Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push("    " + D + ext + RST + "  " + D + String(count) + RST);
    }
  }

  lines.push("", "  " + label("Reranker:") +
    (isRerankerEnabled() ? GREEN + "enabled" + RST : YELLOW + "disabled" + RST));

  lines.push("", "  " + B + "Tracked paths:" + RST);
  if (config.trackedPaths.length) {
    for (const p of config.trackedPaths) lines.push("    " + D + p + RST);
  } else {
    lines.push("    " + D + "(none — run /rag index <path> to track)" + RST);
  }

  lines.push("", "  " + B + "Exclude patterns:" + RST);
  if (config.excludePatterns.length) {
    for (const p of config.excludePatterns) lines.push("    " + D + p + RST);
  } else {
    lines.push("    " + D + "(none — add with /rag exclude <pattern>)" + RST);
  }

  return lines.join("\n");
}

export function formatCoverage(report: CoverageReport, opts: { json: boolean }): string {
  if (opts.json) return JSON.stringify(report, null, 2);

  const lines: string[] = [
    B + "🧭 RAG coverage" + RST + D + `  ${report.root}` + RST,
    "",
    report.verdict === "complete"
      ? GREEN + "✅ " + coverageVerdictLabel(report.verdict) + RST
      : YELLOW + coverageVerdictLabel(report.verdict) + RST,
    "",
    "  " + D + "Markdown:" + RST + `  ${report.markdown.indexed}/${report.markdown.total} indexed` +
      (report.markdown.missing.length ? YELLOW + `  · ${report.markdown.missing.length} missing` + RST : "") +
      (report.markdown.modified.length ? YELLOW + `  · ${report.markdown.modified.length} modified` + RST : ""),
    "  " + D + "Documents:" + RST + `  ${report.documents.total} total` +
      YELLOW + `  · ${report.documents.needs_convert} needs convert` + RST +
      D + `  · ${report.documents.checksum_missing} checksum missing` + RST +
      GREEN + `  · ${report.documents.up_to_date} up to date` + RST,
    "  " + D + "Index:" + RST + `  ${report.index.chunks} chunks / ${report.index.vectors} vectors (${report.index.vectorCoveragePct}%)` +
      (report.index.stale ? YELLOW + "  · STALE" + RST : GREEN + "  · fresh" + RST),
  ];

  if (report.markdown.missing.length) {
    lines.push("", YELLOW + "  Missing md:" + RST);
    for (const m of report.markdown.missing.slice(0, 8)) lines.push("    " + D + m + RST);
    if (report.markdown.missing.length > 8) lines.push(D + `    … and ${report.markdown.missing.length - 8} more` + RST);
    lines.push(D + "  → run: pi-rag auto (或 /rag index .)" + RST);
  }
  if (report.markdown.modified.length) {
    lines.push("", YELLOW + "  Modified md:" + RST);
    for (const m of report.markdown.modified.slice(0, 8)) lines.push("    " + D + m + RST);
    lines.push(D + "  → run: pi-rag auto (或 /rag refresh)" + RST);
  }
  if (report.documents.needs_convert || report.documents.checksum_missing) {
    lines.push("", D + "  → convert with pi-rag auto, or the convert-documents-to-markdown skill + /rag mdsync" + RST);
  }

  return lines.join("\n");
}

export async function formatMdsync(root: string, opts: { json: boolean }): Promise<string> {
  const config = loadConfig();
  const docs = collectFiles(root, DOC_CONVERT_EXTS, config.excludePatterns);
  const report = await scanMarkdownSync(docs);
  if (opts.json) return JSON.stringify(report, null, 2);

  const lines: string[] = [
    B + "📄 Markdown sync" + RST + D + `  scanned ${docs.length} document(s)` + RST,
    "",
    GREEN + `  ${report.up_to_date.length} up-to-date` + RST,
    YELLOW + `  ${report.needs_convert.length} need conversion` + RST,
    D + `  ${report.checksum_missing.length} checksum missing` + RST,
    "",
  ];
  for (const s of report.needs_convert) {
    lines.push(YELLOW + `  ⚠ ${s.file}` + RST + "  " + D + `→ ${s.targetMd} (${s.reason})` + RST);
  }
  for (const s of report.checksum_missing) {
    lines.push(D + `  ? ${s.file}` + RST + "  " + D + `→ ${s.checksumFile} missing` + RST);
  }
  if (docs.length === 0) lines.push(D + "  (no non-md documents found)" + RST);
  lines.push("", D + "Convert via pi-rag auto or the convert-documents-to-markdown skill (anydoc / batch-ocr)." + RST);
  return lines.join("\n");
}

// ─── Commands ─────────────────────────────────────────────────────────────

export async function runAuto(root: string, opts: { json: boolean }): Promise<number> {
  const config = loadConfig();
  const autoOpts = {
    excludePatterns: config.excludePatterns,
    ocrCli: process.env.RAG_OCR_CLI || undefined,
    ocrApi: process.env.RAG_OCR_API || undefined,
  };
  // The starting-state summary must read the same store the auto-complete
  // writes to — anchored at the repo root, never the cwd-based singleton
  // (which may point at a different store when --dir is used) and never the
  // global fallback.
  const ragDir = getRagDir({ createIfMissing: true, startDir: root });
  const db = getFreshDbConn(ragDir);
  const before = await computeCoverage(root, { excludePatterns: config.excludePatterns, db });
  db.close();
  if (opts.json) {
    // JSON mode: quiet progress (stderr), full outcome object at the end.
    const outcome = await autoCompleteCoverage(root, autoOpts);
    console.log(JSON.stringify(outcome, null, 2));
    return 0;
  }
  process.stderr.write(
    `⏳ pi-rag auto: 起始 ${before.markdown.indexed}/${before.markdown.total} md 已索引 · ` +
    `${before.markdown.missing.length} md 待索引 · ${before.documents.needs_convert} 文件待轉檔\n`,
  );
  const outcome = await autoCompleteCoverage(root, autoOpts, (msg) => {
    process.stderr.write(`\r\x1b[2K[pi-rag] ${msg}`);
  });
  process.stderr.write("\r\x1b[2K");

  console.log("");
  console.log(formatCoverage(outcome.after, { json: false }));
  console.log("");
  const a = outcome.actions;
  console.log(B + "動作摘要" + RST +
    `: indexed=${a.indexed.length}  checksummed=${a.checksummed.length}  converted=${a.converted.length}  failed=${a.failed.length}`);
  for (const f of a.failed) {
    console.log("  " + RED + "✗ " + f.file + RST + "  " + D + f.reason + RST);
  }
  console.log("");
  console.log(GREEN + "✅ 知識庫補齊完成 — 現在可以啟動 pi，直接開始對話。" + RST);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 23) {
    console.error(RED + `[pi-rag] 需要 Node >= 23.6（原生 TypeScript 支援）。目前: ${process.version}` + RST);
    return 1;
  }

  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.dir) {
    if (!existsSync(args.dir)) {
      console.error(RED + `Path not found: ${args.dir}` + RST);
      return 1;
    }
    process.chdir(args.dir);
  }

  try {
    switch (args.command) {
      case "status":
        console.log(formatStatus(args));
        return 0;
      case "coverage": {
        const root = process.cwd();
        const config = loadConfig();
        const report = await computeCoverage(root, { excludePatterns: config.excludePatterns });
        console.log(formatCoverage(report, args));
        return 0;
      }
      case "auto":
        return await runAuto(process.cwd(), args);
      case "mdsync":
        console.log(await formatMdsync(process.cwd(), args));
        return 0;
      case "meta": {
        const db = getDbConn();
        const metaArgs = args.rest ?? [];
        if (metaArgs[0] === "seed") {
          const { applyMetadataSeed, metadataSeedPath } = await import("./metadata.ts");
          const applied = applyMetadataSeed(db, process.cwd());
          console.log(GREEN + `Metadata seed applied to ${applied} file(s)` + RST + D + ` (${metadataSeedPath(process.cwd())})` + RST);
          return 0;
        }
        if (metaArgs.length === 0 || metaArgs[0] === "list") {
          const rows = (await import("./repository.ts")).listFiles(db).filter(f => f.metadata);
          console.log(B + `📎 File metadata (${rows.length})` + RST);
          for (const r of rows) {
            console.log("  " + GREEN + r.path + RST);
            console.log("    " + D + r.metadata + RST);
          }
          if (!rows.length) console.log(D + "  (none — set via: bin/rag meta <path> <tags>)" + RST);
          return 0;
        }
        const { resolve } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const { setFileMetadata, getFile } = await import("./repository.ts");
        if (metaArgs[0] === "-d" || metaArgs[0] === "--delete") {
          const p = resolve(metaArgs[1] ?? ".");
          if (!existsSync(p)) { console.error(RED + `Path not found: ${p}` + RST); return 1; }
          setFileMetadata(db, p, null);
          console.log(GREEN + `Cleared metadata: ${p}` + RST);
          return 0;
        }
        const p = resolve(metaArgs[0]!);
        if (!existsSync(p)) { console.error(RED + `Path not found: ${p}` + RST); return 1; }
        const text = metaArgs.slice(1).join(" ").trim();
        if (!text) {
          const f = getFile(db, p);
          if (!f) { console.error(RED + `Not indexed: ${p}` + RST); return 1; }
          console.log(f.metadata ? `${p}\n  ${f.metadata}` : `No metadata set: ${p}`);
          return 0;
        }
        setFileMetadata(db, p, text);
        console.log(GREEN + `✅ Metadata set: ${p}` + RST + `\n  ${text}`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 1;
    }
  } catch (e) {
    console.error(RED + `[pi-rag] error: ${(e as Error).message}` + RST);
    return 1;
  } finally {
    closeDbConn();
  }
}

// Run directly (node cli.ts …) — skipped when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
