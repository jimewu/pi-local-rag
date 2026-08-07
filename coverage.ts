/**
 * Coverage report — "is the knowledge base complete?".
 *
 * Answers three questions at once:
 *   1. Markdown: which .md files on disk are NOT in the index (or changed)?
 *   2. Documents: which non-md files still need conversion / checksums?
 *   3. Index: is the index fresh and fully embedded?
 *
 * Verdict priority: needs_convert > needs_checksum > needs_index > stale >
 * complete. The command/tool counterpart is `/rag coverage` / `rag_coverage`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getDbConn } from "./db.ts";
import { collectFiles } from "./chunking.ts";
import { scanMarkdownSync } from "./md-sync.ts";
import { DOC_CONVERT_EXTS } from "./constants.ts";
import { isIndexStale } from "./indexing.ts";
import { getIndexStats } from "./db.ts";
import * as repo from "./repository.ts";

export type CoverageVerdict =
  | "complete"
  | "needs_convert"
  | "needs_checksum"
  | "needs_index"
  | "stale";

export interface CoverageReport {
  root: string;
  markdown: {
    total: number;
    indexed: number;
    /** .md files on disk that are not in the index at all. */
    missing: string[];
    /** .md files whose content hash differs from the indexed one. */
    modified: string[];
  };
  documents: {
    total: number;
    needs_convert: number;
    checksum_missing: number;
    up_to_date: number;
  };
  index: {
    chunks: number;
    tokens: number;
    vectors: number;
    vectorCoveragePct: number;
    lastBuild: string;
    stale: boolean;
  };
  verdict: CoverageVerdict;
}

/** sha256 over the utf-8 text — matches how extractText hashes md files
 *  (chunking.sha256 truncates to 12 hex chars). */
function textSha256(fp: string): string {
  return createHash("sha256").update(readFileSync(fp, "utf-8")).digest("hex").slice(0, 12);
}

/** Resolve symlinks (e.g. /Documents → )
 *  so index paths and scanned paths compare as the same physical file.
 *  Falls back to the input path when it no longer exists. */
function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export async function computeCoverage(
  root: string,
  opts: { excludePatterns?: string[]; db?: Database.Database } = {},
): Promise<CoverageReport> {
  const exclude = opts.excludePatterns ?? [];
  const db = opts.db ?? getDbConn();

  // 1. markdown vs index
  const mdFiles = collectFiles(root, undefined, exclude);
  // Index paths may be stored under a symlinked alias of `root` (e.g.
  // /Documents → ). Compare by resolved
  // realpath so the same physical file isn't reported as missing.
  const indexedByReal = new Map<string, string>();
  for (const p of repo.listFilePaths(db)) {
    const real = realOf(p);
    if (!indexedByReal.has(real)) indexedByReal.set(real, p);
  }

  const missing: string[] = [];
  const modified: string[] = [];
  for (const fp of mdFiles) {
    const dbPath = indexedByReal.get(realOf(fp));
    if (dbPath === undefined) {
      missing.push(fp);
      continue;
    }
    const rec = repo.getFile(db, dbPath);
    if (rec?.hash && rec.hash !== textSha256(fp)) modified.push(fp);
  }

  // 2. non-md documents (md-sync)
  const docs = collectFiles(root, DOC_CONVERT_EXTS, exclude);
  const sync = await scanMarkdownSync(docs);

  // 3. index health
  const stats = getIndexStats(db);
  const vectorCoveragePct = stats.totalChunks
    ? Math.round((stats.embeddedCount / stats.totalChunks) * 100)
    : 0;
  const stale = isIndexStale(stats);

  const verdict: CoverageVerdict =
    sync.needs_convert.length > 0
      ? "needs_convert"
      : sync.checksum_missing.length > 0
        ? "needs_checksum"
        : missing.length > 0 || modified.length > 0
          ? "needs_index"
          : stale
            ? "stale"
            : "complete";

  const rel = (p: string) => relative(root, p);

  return {
    root,
    markdown: {
      total: mdFiles.length,
      indexed: mdFiles.length - missing.length,
      missing: missing.map(rel),
      modified: modified.map(rel),
    },
    documents: {
      total: docs.length,
      needs_convert: sync.needs_convert.length,
      checksum_missing: sync.checksum_missing.length,
      up_to_date: sync.up_to_date.length,
    },
    index: {
      chunks: stats.totalChunks,
      tokens: stats.totalTokens,
      vectors: stats.embeddedCount,
      vectorCoveragePct,
      lastBuild: stats.lastBuild,
      stale,
    },
    verdict,
  };
}

export function coverageVerdictLabel(v: CoverageVerdict): string {
  switch (v) {
    case "complete": return "✅ 完整";
    case "needs_convert": return "⚠️ 有文件待轉檔";
    case "needs_checksum": return "⚠️ 有文件缺 checksum";
    case "needs_index": return "⚠️ 有 md 未索引/已變更";
    case "stale": return "⚠️ 索引已過期（>24h）";
  }
}
