import type Database from "better-sqlite3";
import { VECTOR_DIM } from "./constants.ts";

/**
 * Centralizes every raw SQL statement used across db.ts, indexing.ts,
 * search.ts, and index.ts. Nothing outside this file should contain a
 * `.prepare` / `.exec` call against the rag database — that keeps the
 * schema-to-code contract in one place instead of scattered across four
 * files with subtly duplicated INSERT shapes.
 *
 * These are plain functions, not a class with cached prepared statements:
 * better-sqlite3 already caches statements per-connection internally via
 * db.prepare, and singleton lifetime (open/close) is still owned by
 * RagDatabase in db.ts. This module is just where the SQL text lives.
 */

// ─── Schema ──────────────────────────────────────────────────────────────

/**
 * Bump when the physical schema changes in a way that requires a rebuild:
 *   v2 — FTS5 tokenize=trigram (CJK support), parents table, chunks.parent_id,
 *        VECTOR_DIM may have changed (embedding model now configurable).
 *   v3 — files.metadata + chunks_fts.metadata: per-file entity tags (product,
 *        doc type, related docs…) become an FTS column so queries hitting the
 *        metadata (e.g. a product name) score the file's chunks — a lightweight
 *        cross-file link without a graph database.
 */
export const SCHEMA_VERSION = 3;

/** Returns the stored schema version, or 0 when unset (fresh / legacy DB). */
export function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined;
    return row?.value ? Number(row.value) : 0;
  } catch {
    return 0; // metadata table does not exist yet
  }
}

export function initSchema(db: Database.Database) {
  const version = getSchemaVersion(db);

  if (version > 0 && version < SCHEMA_VERSION) {
    if (version < 2) {
      // ── v1 → v2 migration ──
      // The old FTS table used the unicode61 tokenizer (no CJK segmentation)
      // and chunks_vec may have the wrong dimension. Drop both; they are
      // rebuilt below from the chunks table (FTS) / lazily re-embedded (vec).
      db.exec(`
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS chunks_vec;
      `);
      // Vector data is gone — mark every file for re-embedding.
      db.prepare("UPDATE files SET embedded = 0").run();
    }
    // ── v2 → v3 migration ──
    // files gains a metadata column; chunks_fts is rebuilt below WITH the new
    // metadata column (vectors/chunks are untouched — no re-embedding needed).
    const fileCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    if (!fileCols.some(c => c.name === "metadata")) {
      db.exec("ALTER TABLE files ADD COLUMN metadata TEXT");
    }
    db.exec(`DROP TABLE IF EXISTS chunks_fts;`);
  }

  db.exec(`DROP TRIGGER IF EXISTS chunks_ai; DROP TRIGGER IF EXISTS chunks_ad;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parents (
      id          TEXT PRIMARY KEY,
      file_path   TEXT NOT NULL,
      content     TEXT NOT NULL,
      line_start  INTEGER NOT NULL,
      line_end    INTEGER NOT NULL,
      heading     TEXT,
      hash        TEXT NOT NULL,
      indexed_at  TEXT NOT NULL,
      tokens      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id          TEXT PRIMARY KEY,
      file_path   TEXT NOT NULL,
      chunk_content TEXT NOT NULL,
      line_start  INTEGER NOT NULL,
      line_end    INTEGER NOT NULL,
      chunk_hash  TEXT NOT NULL,
      indexed_at  TEXT NOT NULL,
      tokens      INTEGER NOT NULL,
      parent_id   TEXT REFERENCES parents(id)
    );

    -- tokenize='trigram' gives CJK 3-gram segmentation; unicode61 (the
    -- default) treats a run of Chinese characters as ONE token, so Chinese
    -- keyword search silently fails. Requires SQLite >= 3.34 (bundled).
    -- 'metadata' holds the file's entity tags (product, doc type, related
    -- docs...) so a query hitting a tag (e.g. a product name) also scores every
    -- chunk of that file — a cheap cross-file link, no graph database.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_content,
      file_path,
      metadata,
      content_rowid=rowid,
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, chunk_content, file_path, metadata)
      VALUES (new.rowid, new.chunk_content, new.file_path,
              (SELECT metadata FROM files WHERE path = new.file_path));
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.rowid;
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      embedding float[${VECTOR_DIM}]
    );

    CREATE TABLE IF NOT EXISTS files (
      path      TEXT PRIMARY KEY,
      hash      TEXT NOT NULL,
      chunks    INTEGER NOT NULL,
      indexed   TEXT NOT NULL,
      size      INTEGER NOT NULL,
      embedded  INTEGER NOT NULL DEFAULT 0,
      metadata  TEXT
    );

    -- Re-indexing deletes chunks per file (DELETE … WHERE file_path = ?);
    -- without this index each delete full-scans the chunks table.
    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id);
  `);

  // Backfill chunks.parent_id for legacy tables that predate the column.
  const chunkCols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
  if (!chunkCols.some(c => c.name === "parent_id")) {
    db.exec("ALTER TABLE chunks ADD COLUMN parent_id TEXT REFERENCES parents(id)");
  }

  // If the FTS table was dropped in the migration (or created empty for a
  // pre-existing chunks table), re-populate it from the chunks table, pulling
  // each file's metadata alongside.
  const ftsCount = (db.prepare("SELECT COUNT(*) AS c FROM chunks_fts").get() as { c: number }).c;
  const chunkCount = (db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;
  if (ftsCount === 0 && chunkCount > 0) {
    db.exec(`
      INSERT INTO chunks_fts(rowid, chunk_content, file_path, metadata)
      SELECT c.rowid, c.chunk_content, c.file_path, f.metadata
      FROM chunks c LEFT JOIN files f ON f.path = c.file_path;
    `);
  }

  // Vector-dimension drift: if the configured embedding model changed after
  // the vec table was created (e.g. RAG_EMBEDDING_DIM differs from the stored
  // float[N] shape), queries fail with "Dimension mismatch". Detect it from
  // the table SQL and rebuild the vec table + mark files for re-embedding.
  const vecSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'").get() as
    | { sql?: string }
    | undefined)?.sql;
  const storedDim = vecSql?.match(/float\[(\d+)\]/)?.[1];
  if (storedDim && Number(storedDim) !== VECTOR_DIM) {
    db.exec(`
      DROP TABLE chunks_vec;
      CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[${VECTOR_DIM}]);
    `);
    db.prepare("UPDATE files SET embedded = 0").run();
  }

  db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

// ─── Chunks ──────────────────────────────────────────────────────────────

export interface ChunkRow {
  rowid: number;
  id: string;
  file_path: string;
  chunk_content: string;
  line_start: number;
  line_end: number;
  chunk_hash: string;
  indexed_at: string;
  tokens: number;
  parent_id: string | null;
}

export interface NewChunk {
  id: string;
  filePath: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  hash: string;
  indexedAt: string;
  tokens: number;
  parentId?: string | null;
}

export interface ParentRow {
  id: string;
  file_path: string;
  content: string;
  line_start: number;
  line_end: number;
  heading: string | null;
  hash: string;
  indexed_at: string;
  tokens: number;
}

export interface NewParent {
  id: string;
  filePath: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  heading: string | null;
  hash: string;
  indexedAt: string;
  tokens: number;
}

export function hasAnyChunks(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM chunks LIMIT 1").get();
}

export function insertChunk(db: Database.Database, c: NewChunk) {
  return db.prepare(`
    INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, c.filePath, c.content, c.lineStart, c.lineEnd, c.hash, c.indexedAt, c.tokens, c.parentId ?? null);
}

export function insertParent(db: Database.Database, p: NewParent) {
  return db.prepare(`
    INSERT INTO parents(id, file_path, content, line_start, line_end, heading, hash, indexed_at, tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.id, p.filePath, p.content, p.lineStart, p.lineEnd, p.heading, p.hash, p.indexedAt, p.tokens);
}

export function deleteChunksForFile(db: Database.Database, filePath: string) {
  db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
  db.prepare("DELETE FROM parents WHERE file_path = ?").run(filePath);
}

export function getChunksByRowids(db: Database.Database, rowids: number[]): ChunkRow[] {
  if (rowids.length === 0) return [];
  const placeholders = rowids.map(() => "?").join(",");
  return db.prepare(`
    SELECT rowid, id, file_path, chunk_content, line_start, line_end,
            chunk_hash, indexed_at, tokens, parent_id
    FROM chunks
    WHERE rowid IN (${placeholders})
  `).all(...rowids) as ChunkRow[];
}

export interface LoadedChunk {
  id: string; file: string; content: string;
  lineStart: number; lineEnd: number;
  hash: string; indexed: string; tokens: number;
  parentId: string | null;
}

export function getAllChunks(db: Database.Database): LoadedChunk[] {
  return db.prepare(`
    SELECT c.id, c.file_path as file, c.chunk_content as content,
            c.line_start as lineStart, c.line_end as lineEnd,
            c.chunk_hash as hash, c.indexed_at as indexed, c.tokens,
            c.parent_id as parentId
    FROM chunks c
  `).all() as LoadedChunk[];
}

export function getParentsByRowids(db: Database.Database, ids: string[]): ParentRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, file_path, content, line_start, line_end, heading, hash, indexed_at, tokens
    FROM parents
    WHERE id IN (${placeholders})
  `).all(...ids) as ParentRow[];
}

// ─── Vectors (chunks_vec) ────────────────────────────────────────────────

/**
 * Internal only — not part of the module's public surface. Vector params
 * come in as `number[]`; every caller converts through this before it
 * touches chunks_vec.
 **/
function float32ToBuffer(arr: number[]): Buffer {
  const f = new Float32Array(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function insertVector(db: Database.Database, rowid: number, vector: number[]) {
  db.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)")
    .run(rowid, float32ToBuffer(vector));
}

export function deleteVectorsForFile(db: Database.Database, filePath: string) {
  db.prepare("DELETE FROM chunks_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE file_path = ?)").run(filePath);
}

export interface VecMatch {
  rowid: number;
  distance: number
}

export function searchVectors(db: Database.Database, queryVec: number[], limit: number): VecMatch[] {
  return db.prepare(`
    SELECT rowid, distance
    FROM chunks_vec
    WHERE embedding MATCH ?
    LIMIT ?
  `).bind(float32ToBuffer(queryVec), limit).all() as VecMatch[];
}

export function getEmbeddedCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as embeddedCount FROM chunks_vec").get() as { embeddedCount: number };
  return row.embeddedCount;
}

export function clearAllVectors(db: Database.Database) {
  db.exec("DELETE FROM chunks_vec; DELETE FROM chunks; DELETE FROM parents; DELETE FROM files;");
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
}

// ─── Fts (chunks_fts / BM25) ─────────────────────────────────────────────

export interface FtsMatch { rowid: number; bm25_score: number }

export function searchFts(db: Database.Database, ftsQuery: string, limit: number): FtsMatch[] {
  // bm25 weights per column: chunk_content 1.0, file_path 0.5, metadata 1.5.
  // A metadata hit (product name, doc type…) is a strong cross-file signal,
  // so it outranks a plain filename hit but stays below an in-content hit
  // combined with its own score.
  return db.prepare(`
    SELECT chunks_fts.rowid, bm25(chunks_fts, 1.0, 0.5, 1.5) as bm25_score
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
    ORDER BY bm25_score
    LIMIT ?
  `).all(ftsQuery, limit) as FtsMatch[];
}

/** Match the metadata column only (FTS5 column syntax) — used to find which
 *  FILES carry entity tags matching the query terms, so hybridSearch can
 *  boost those files' chunks (a product name in metadata should lift the
 *  whole file, not just the tagged fragments). */
export function searchFtsMetadata(db: Database.Database, terms: string[], limit: number): FtsMatch[] {
  if (terms.length === 0) return [];
  const q = terms.map(t => `metadata:"${t.replace(/"/g, '"')}"`).join(" OR ");
  return db.prepare(`
    SELECT chunks_fts.rowid, bm25(chunks_fts, 1.0, 0.5, 1.5) as bm25_score
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
    ORDER BY bm25_score
    LIMIT ?
  `).all(q, limit) as FtsMatch[];
}

// ─── Files ───────────────────────────────────────────────────────────────

export interface FileRow {
  path: string;
  hash: string;
  chunks: number;
  indexed: string;
  size: number;
  embedded: number;
  /** Entity tags for this file (product, doc type, related docs…); NULL/absent
   *  until set via /rag meta or an importer. Surfaced in the FTS metadata
   *  column so queries hitting a tag score the file's chunks. */
  metadata?: string | null;
}

export function getFile(db: Database.Database, path: string): { hash?: string; embedded?: number; metadata?: string | null } | undefined {
  return db.prepare("SELECT hash, embedded, metadata FROM files WHERE path = ?").get(path) as
    { hash?: string; embedded?: number; metadata?: string | null } | undefined;
}

export function upsertFile(
  db: Database.Database,
  path: string, hash: string, chunks: number, indexed: string, size: number, embedded: boolean,
  metadata?: string | null,
) {
  // metadata is NOT overwritten by ON CONFLICT — re-indexing keeps whatever
  // tags were set via /rag meta, so a refresh does not wipe them.
  db.prepare(`
    INSERT INTO files(path, hash, chunks, indexed, size, embedded, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash=excluded.hash, chunks=excluded.chunks, indexed=excluded.indexed,
      size=excluded.size, embedded=excluded.embedded
  `).run(path, hash, chunks, indexed, size, embedded ? 1 : 0, metadata ?? null);
}

/** Set (or clear, with null/"") a file's metadata tags and propagate them to
 *  every FTS row of that file so searches match immediately. */
export function setFileMetadata(db: Database.Database, path: string, metadata: string | null): void {
  db.prepare("UPDATE files SET metadata = ? WHERE path = ?").run(metadata, path);
  db.prepare(`
    UPDATE chunks_fts SET metadata = ?
    WHERE rowid IN (SELECT rowid FROM chunks WHERE file_path = ?)
  `).run(metadata, path);
}

/** Insert-or-replace variant used by the JSON migration path (no upsert semantics needed there). */
export function replaceFile(
  db: Database.Database,
  path: string, hash: string, chunks: number, indexed: string, size: number, embedded: boolean,
) {
  db.prepare(`
    INSERT OR REPLACE INTO files(path, hash, chunks, indexed, size, embedded)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(path, hash, chunks, indexed, size, embedded ? 1 : 0);
}

export function deleteFile(db: Database.Database, path: string) {
  db.prepare("DELETE FROM files WHERE path = ?").run(path);
}

export function setFileEmbedded(db: Database.Database, path: string, embedded: boolean) {
  db.prepare("UPDATE files SET embedded = ? WHERE path = ?").run(embedded ? 1 : 0, path);
}

export function listFiles(db: Database.Database): FileRow[] {
  return db.prepare("SELECT * FROM files").all() as FileRow[];
}

export function listFilePaths(db: Database.Database): string[] {
  return (db.prepare("SELECT path FROM files").all() as Array<{ path: string }>).map(r => r.path);
}

export function countFiles(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as totalFiles FROM files").get() as { totalFiles: number }).totalFiles;
}

// ─── Metadata ────────────────────────────────────────────────────────────
/**
 * Canonical metadata key names — the single source of truth so call sites
 * never spell out "last_build" / "embedding_model" as string literals.
 **/
export const MetadataKey = {
  LastBuild: "last_build",
  EmbeddingModel: "embedding_model",
} as const;

export type MetadataKey = typeof MetadataKey[keyof typeof MetadataKey];

export function getMetadata(db: Database.Database, key: MetadataKey): string | undefined {
  return (db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
}

export function setMetadata(db: Database.Database, key: MetadataKey, value: string) {
  db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)").run(key, value);
}

export function getChunkStats(db: Database.Database): { totalChunks: number; totalTokens: number } {
  return db.prepare(`
    SELECT COUNT(*) as totalChunks, COALESCE(SUM(tokens), 0) as totalTokens
    FROM chunks
  `).get() as { totalChunks: number; totalTokens: number };
}

export function countChunksTotal(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
}
