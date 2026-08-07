/**
 * Auto-complete the knowledge base — the engine behind `/rag coverage --auto`
 * and `rag_coverage(auto: true)`.
 *
 * Runs in verdict-priority order until the report is complete:
 *   1. needs_index      → index the missing/changed markdown files
 *   2. needs_checksum   → write the .sha256 sidecar for docs that already
 *                         have markdown (trusts the existing md as current)
 *   3. needs_convert    → convert each document via the
 *                         convert-documents-to-markdown toolchain:
 *                         anydoc first, then the OCR CLI for scanned PDFs
 *   4. stale            → re-walk and refresh the index
 *
 * Conversion is opt-in by default for documents: anydoc is bundled via npx;
 * OCR requires a configured CLI (RAG_OCR_CLI) because the OCR endpoint is
 * environment-specific. A command runner is injectable for tests.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { collectFiles } from "./chunking.ts";
import { mdTargetFor, scanMarkdownSync, sha256File } from "./md-sync.ts";
import { DOC_CONVERT_EXTS } from "./constants.ts";
import { computeCoverage, type CoverageReport } from "./coverage.ts";
import { indexFiles } from "./indexing.ts";
import { getDbConn } from "./db.ts";

const execFileP = promisify(execFile);

/** Injectable command runner: (cmd, args) → { ok, stderr }. */
export type CmdRunner = (cmd: string, args: string[]) => Promise<{ ok: boolean; stderr: string }>;

export interface AutoFixOptions {
  excludePatterns?: string[];
  /** anydoc binary; defaults to `npx -y @firecrawl/anydoc` when not set. */
  anydocCmd?: string;
  /** batch-ocr CLI (environment-specific); null/undefined disables OCR. */
  ocrCli?: string;
  ocrApi?: string;
  runner?: CmdRunner;
}

export interface AutoFixResult {
  indexed: string[];
  indexFailed: string[];
  checksummed: string[];
  converted: Array<{ file: string; tool: "anydoc" | "ocr" }>;
  failed: Array<{ file: string; reason: string }>;
}

export interface AutoFixOutcome {
  before: CoverageReport;
  actions: AutoFixResult;
  after: CoverageReport;
}

export function defaultRunner(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return execFileP(cmd, args, { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
    .then(() => ({ ok: true, stderr: "" }))
    .catch((e: unknown) => {
      const err = e as { stderr?: unknown; message?: string };
      return { ok: false, stderr: String(err?.stderr ?? err?.message ?? e) };
    });
}

async function writeChecksum(src: string, checksumFile: string): Promise<void> {
  const hash = await sha256File(src);
  mkdirSync(checksumFile.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(checksumFile, `${hash}  ${src.split("/").pop()}\n`, "utf-8");
}

/** Convert one document to markdown (anydoc → OCR fallback) and record the
 *  source checksum. Returns the outcome; never throws. */
export async function convertOneDocument(
  src: string,
  opts: AutoFixOptions = {},
): Promise<{ ok: boolean; tool?: "anydoc" | "ocr"; reason?: string }> {
  const runner = opts.runner ?? defaultRunner;
  const target = mdTargetFor(src);
  try {
    mkdirSync(target.folder, { recursive: true });
  } catch {
    return { ok: false, reason: `cannot create ${target.folder}` };
  }

  // 1) anydoc (text-based conversion: docx/pdf/xlsx/csv/ppt/…)
  const anydocArgs = opts.anydocCmd
    ? [src, "-o", target.md]
    : ["-y", "@firecrawl/anydoc", src, "-o", target.md];
  const r = await runner(opts.anydocCmd ?? "npx", anydocArgs);
  if (r.ok && existsSync(target.md)) {
    try {
      await writeChecksum(src, target.checksum);
      return { ok: true, tool: "anydoc" };
    } catch (e) {
      return { ok: false, tool: "anydoc", reason: `checksum failed: ${String(e)}` };
    }
  }

  // 2) scanned/image-only PDF → OCR CLI
  if (r.stderr.includes("OCR")) {
    if (!opts.ocrCli) {
      return { ok: false, tool: "ocr", reason: "OCR required but no RAG_OCR_CLI configured" };
    }
    const o = await runner(opts.ocrCli, ["--api", opts.ocrApi ?? "", src]);
    if (o.ok && existsSync(target.md)) {
      try {
        await writeChecksum(src, target.checksum);
        return { ok: true, tool: "ocr" };
      } catch (e) {
        return { ok: false, tool: "ocr", reason: `checksum failed: ${String(e)}` };
      }
    }
    return { ok: false, tool: "ocr", reason: o.stderr || "OCR conversion failed" };
  }

  return { ok: false, reason: r.stderr || "conversion failed" };
}

/** Run the full auto-complete cycle and re-report coverage. */
export async function autoCompleteCoverage(
  root: string,
  opts: AutoFixOptions = {},
): Promise<AutoFixOutcome> {
  const exclude = opts.excludePatterns ?? [];
  const db = getDbConn();
  const before = await computeCoverage(root, { excludePatterns: exclude, db });
  const actions: AutoFixResult = { indexed: [], indexFailed: [], checksummed: [], converted: [], failed: [] };

  // 1) checksum missing → record current source hash (trusts existing md)
  const docs = collectFiles(root, DOC_CONVERT_EXTS, exclude);
  const sync = await scanMarkdownSync(docs);
  for (const s of sync.checksum_missing) {
    try {
      await writeChecksum(s.file, s.checksumFile);
      actions.checksummed.push(s.file);
    } catch (e) {
      actions.failed.push({ file: s.file, reason: `checksum failed: ${String(e)}` });
    }
  }

  // 2) needs_convert → convert each document
  for (const s of sync.needs_convert) {
    const r = await convertOneDocument(s.file, opts);
    if (r.ok) actions.converted.push({ file: s.file, tool: r.tool! });
    else actions.failed.push({ file: s.file, reason: r.reason ?? "convert failed" });
  }

  // 3) index everything (missing + modified + freshly converted). Full walk
  //    with the hash-skip cache is cheap; it also covers the stale case.
  const mdFiles = collectFiles(root, undefined, exclude);
  if (mdFiles.length) {
    try {
      await indexFiles(mdFiles, {}, db);
      actions.indexed = mdFiles;
    } catch (e) {
      actions.indexFailed = mdFiles;
      actions.failed.push({ file: root, reason: `index failed: ${String(e)}` });
    }
  }

  const after = await computeCoverage(root, { excludePatterns: exclude, db });
  return { before, actions, after };
}
