/**
 * File metadata (方式 3 / FTS metadata column) tests.
 *
 * v3 schema adds files.metadata + a metadata column to chunks_fts, so a
 * query hitting an entity tag (product name, doc type…) scores every chunk
 * of that file via BM25 — a cheap cross-file link without a graph DB.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { initSchema } from "../index.ts";
import * as repo from "../repository.ts";
import { loadMetadataSeed, applyMetadataSeed } from "../metadata.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  loadVec(db);
  initSchema(db);
  return db;
}

function seedFile(db: Database.Database, path: string, content: string, metadata?: string | null) {
  const now = new Date().toISOString();
  repo.upsertFile(db, path, "hash-" + path, 1, now, content.length, true, metadata);
  const r = db.prepare(`
    INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens)
    VALUES (?, ?, ?, 1, 1, 'h', ?, 5)
  `).run("chunk-" + path, path, content, now);
  return Number(r.lastInsertRowid);
}

describe("file metadata (FTS column)", () => {
  it("schema v3 adds the metadata columns", () => {
    const db = makeDb();
    expect(repo.getSchemaVersion(db)).toBe(3);
    const fileCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    expect(fileCols.some(c => c.name === "metadata")).toBe(true);
    const ftsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'").get() as { sql: string }).sql;
    expect(ftsSql).toContain("metadata");
    db.close();
  });

  it("metadata-only query hits chunks of the tagged file via BM25", () => {
    const db = makeDb();
    seedFile(db, "/repo/risk.md", "問卷內容與受試者回饋", "PROD-A 系列 風險利益問卷");
    seedFile(db, "/repo/manual.md", "產品操作說明", null);

    const hits = repo.searchFts(db, '"PROD-A"', 10);
    expect(hits.length).toBeGreaterThan(0);
    // The hit must be the tagged file's chunk.
    const row = db.prepare("SELECT file_path FROM chunks WHERE rowid = ?").get(hits[0]!.rowid) as { file_path: string };
    expect(row.file_path).toBe("/repo/risk.md");
    db.close();
  });

  it("setFileMetadata updates files + FTS rows and is immediately searchable", () => {
    const db = makeDb();
    seedFile(db, "/repo/cer.md", "臨床評估結論段落", null);
    // No metadata yet — the product name must NOT hit.
    expect(repo.searchFts(db, '"PROD-A"', 10).length).toBe(0);

    repo.setFileMetadata(db, "/repo/cer.md", "PROD-A 系列 臨床評估報告 CER");
    const hits = repo.searchFts(db, '"PROD-A"', 10);
    expect(hits.length).toBeGreaterThan(0);
    const row = db.prepare("SELECT file_path FROM chunks WHERE rowid = ?").get(hits[0]!.rowid) as { file_path: string };
    expect(row.file_path).toBe("/repo/cer.md");
    // Clearing removes it from search again.
    repo.setFileMetadata(db, "/repo/cer.md", null);
    expect(repo.searchFts(db, '"PROD-A"', 10).length).toBe(0);
    db.close();
  });

  it("re-indexing (upsertFile) keeps previously set metadata", () => {
    const db = makeDb();
    seedFile(db, "/repo/q.md", "內容", "PROD-A 問卷");
    // Re-index with metadata omitted → ON CONFLICT must preserve the tag.
    const now = new Date().toISOString();
    repo.upsertFile(db, "/repo/q.md", "new-hash", 1, now, 10, true);
    expect(repo.getFile(db, "/repo/q.md")?.metadata).toBe("PROD-A 問卷");
    db.close();
  });
});

describe("metadata seed (rag-metadata.json)", () => {
  it("loadMetadataSeed reads JSON and resolves relative paths against root", () => {
    const root = mkdtempSync(join(tmpdir(), "rag-seed-"));
    try {
      writeFileSync(join(root, "rag-metadata.json"), JSON.stringify({
        "docs/a.md": "PROD-A 系列 臨床評估報告 CER",
        "docs/b.md": "  ", // blank tags are skipped
      }));
      const seed = loadMetadataSeed(root);
      expect(seed.get(join(root, "docs/a.md"))).toBe("PROD-A 系列 臨床評估報告 CER");
      expect(seed.size).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applyMetadataSeed tags indexed files and skips unindexed ones", () => {
    const db = makeDb();
    const root = mkdtempSync(join(tmpdir(), "rag-seed2-"));
    try {
      seedFile(db, join(root, "docs/a.md"), "內容段落", null);
      seedFile(db, join(root, "docs/b.md"), "內容段落", "既有標籤");
      writeFileSync(join(root, "rag-metadata.json"), JSON.stringify({
        "docs/a.md": "PROD-A 系列 CER",
        "docs/c.md": "未索引的檔案",
      }));
      const n = applyMetadataSeed(db, root);
      expect(n).toBe(1); // only a.md; c.md is not in the index
      expect(repo.getFile(db, join(root, "docs/a.md"))?.metadata).toBe("PROD-A 系列 CER");
      // Files not listed in the seed keep their existing tags.
      expect(repo.getFile(db, join(root, "docs/b.md"))?.metadata).toBe("既有標籤");
      // The tag is immediately searchable via the FTS metadata column.
      expect(repo.searchFtsMetadata(db, ["PROD-A"], 10).length).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
