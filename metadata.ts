/**
 * File metadata seed — a single source of truth for per-file entity tags.
 *
 * The seed lives at `<repo>/rag-metadata.json` (next to the case repo so it
 * is version-controlled and travels with the repo):
 *
 *   {
 *     "1_初審資料/5_CER/CER MT V5 (20260310) Final.md": "PROD-A 系列 臨床評估報告 CER",
 *     "1_初審資料/4_風險利益問卷_by_子涵/9 Questionnaire ...20260307.md": "PROD-A 系列 風險利益問卷"
 *   }
 *
 * Keys are paths relative to the repo root (stable across relocations);
 * values are the metadata tag string. Every index/rebuild/auto operation
 * applies the seed to the files it mentions (creating or updating their
 * tags); files not listed keep whatever tags they already have.
 *
 * JSON is used (instead of YAML) to keep the dependency footprint at zero.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { setFileMetadata, listFilePaths } from "./repository.ts";

export const METADATA_SEED_FILE = "rag-metadata.json";

export function metadataSeedPath(root: string): string {
  return join(root, METADATA_SEED_FILE);
}

/** Load the seed map, resolving every key against `root`. */
export function loadMetadataSeed(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const fp = metadataSeedPath(root);
  if (!existsSync(fp)) return out;
  try {
    const data = JSON.parse(readFileSync(fp, "utf-8")) as Record<string, unknown>;
    for (const [p, tags] of Object.entries(data)) {
      if (typeof tags !== "string" || !tags.trim()) continue;
      out.set(resolve(root, p), tags.trim());
    }
  } catch (e) {
    process.stderr.write(`[rag] failed to read metadata seed ${fp}: ${(e as Error).message}\n`);
  }
  return out;
}

/** Apply the seed to every indexed file it mentions. Files not listed are
 *  left untouched. Returns how many files got a tag set/updated. Entries
 *  whose path does not match an indexed file are reported to stderr so a
 *  typo in the seed is visible. */
export function applyMetadataSeed(db: Database.Database, root: string): number {
  const seed = loadMetadataSeed(root);
  if (seed.size === 0) return 0;
  const indexed = new Set(listFilePaths(db));
  let applied = 0;
  for (const [path, tags] of seed) {
    if (!indexed.has(path)) {
      process.stderr.write(`[rag] metadata seed: path not in index, skipped: ${path}\n`);
      continue;
    }
    setFileMetadata(db, path, tags);
    applied++;
  }
  return applied;
}
