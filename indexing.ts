import { basename } from "node:path";
import { realpathSync } from "node:fs";
import Database from "better-sqlite3";
import { getDbConn, type IndexStats } from "./db.ts";
import { EMBEDDING_MODEL } from "./constants.ts";
import { embedBatch } from "./embed.ts";
import { chunkForFile, extractText, sha256, type ChunkedDoc } from "./chunking.ts";
import * as repo from "./repository.ts";

export interface ProgressCallbacks {
  onFile?: (current: number, total: number, filename: string, skipped: number) => void;
  onChunk?: (fileChunk: number, totalChunks: number, filename: string) => void;
  /** Fires after each cross-file embed micro-batch completes. `done` is the
   *  number of chunks embedded so far across all files; `total` is the grand
   *  total. Used by the TUI to render live embedding progress instead of
   *  freezing at "Rebuilding 100%". */
  onEmbed?: (done: number, total: number) => void;
  onSave?: () => void;
}

export function isIndexStale(index: IndexStats, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  if (!index.lastBuild) return false;
  return Date.now() - new Date(index.lastBuild).getTime() > maxAgeMs;
}

const yield_ = () => new Promise<void>(r => setTimeout(r, 0));

/** Resolve symlinks so path comparisons survive aliased paths (e.g.
 *  /Documents → ). Falls back to the
 *  input when the file no longer exists. */
function realOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

let _suppressStderr = false;

function stderrProgress(msg: string) {
  if (_suppressStderr) return;
  process.stderr.write(`\r\x1b[2K${msg}`);
}

interface FileWork {
  fp: string;
  hash: string;
  size: number;
  /** Parent blocks with stable ids + content hashes (markdown sections). */
  rawParents: {
    id: string;
    content: string;
    lineStart: number;
    lineEnd: number;
    heading: string | null;
    hash: string;
  }[];
  /** Searchable units (paragraphs for markdown, flat chunks otherwise). */
  rawChildren: {
    content: string;
    lineStart: number;
    lineEnd: number;
    parentId: string | null;
    hash: string;
  }[];
  _vectors?: number[][];
}

export async function indexFiles(
  paths: string[],
  progress?: ProgressCallbacks,
  _db?: Database.Database,
  force?: boolean,
): Promise<{ indexed: number; chunks: number; skipped: number; durationMs: number }> {
  const hadCallbacks = !!progress;
  if (hadCallbacks) _suppressStderr = true;
  const database = _db ?? getDbConn();
  const startMs = Date.now();
  const total = paths.length;

  try {
    if (total === 0) {
      return { indexed: 0, chunks: 0, skipped: 0, durationMs: Date.now() - startMs };
    }

    // Map resolved realpaths → DB-side stored paths so the hash-skip check
    // survives symlinked aliases: a file indexed under one alias (e.g.
    // /…) is skipped when scanned via the other (/…)
    // instead of being fully re-read and re-embedded.
    const realToDb = new Map<string, string>();
    for (const p of repo.listFilePaths(database)) {
      const real = realOf(p);
      if (!realToDb.has(real)) realToDb.set(real, p);
    }

    // Phase 1: parallel read + chunk; DB ops on main thread
    const CONCURRENCY = 32;
    const YIELD_INTERVAL = 64;

    interface ReadResult { fp: string; hash: string; size: number; doc: ChunkedDoc }

    const readQueue: ReadResult[] = [];
    let readQueueDone = false;
    let readErrorCount = 0;
    let resolveRead: (() => void) | null = null;
    const notifyRead = () => { resolveRead?.(); resolveRead = null; };
    const waitRead = () => new Promise<void>(r => { resolveRead = r; });

    const workerCount = Math.min(CONCURRENCY, paths.length);
    let pathsIdx = 0;
    let producersDone = 0;
    const producers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
      producers.push((async () => {
        while (true) {
          const i = pathsIdx++;
          if (i >= paths.length) { producersDone++; if (producersDone >= workerCount) { readQueueDone = true; notifyRead(); } return; }
          try {
            const { text, hash, size } = await extractText(paths[i]);
            const doc = chunkForFile(paths[i], text);
            readQueue.push({ fp: paths[i], hash, size, doc });
            notifyRead();
          } catch {
            readErrorCount++;
            stderrProgress(`[${i + 1}/${total}] ERROR ${basename(paths[i])}: not found or unreadable`);
          }
        }
      })());
    }

    const toIndex: FileWork[] = [];
    let skipped = 0;
    let processedCount = 0;
    let nextYieldAt = 0;

    const drainReads = () => {
      while (readQueue.length > 0) {
        const r = readQueue.shift()!;
        processedCount++;
        const name = basename(r.fp);

        let existing = repo.getFile(database, r.fp);
        if (!existing) {
          // The DB may store this file under a symlinked alias of r.fp.
          const dbPath = realToDb.get(realOf(r.fp));
          if (dbPath && dbPath !== r.fp) existing = repo.getFile(database, dbPath);
        }
        if (!force && existing?.hash === r.hash && existing?.embedded) {
          skipped++;
          progress?.onFile?.(processedCount, total, name, skipped);
          continue;
        }

        repo.deleteVectorsForFile(database, r.fp);
        repo.deleteChunksForFile(database, r.fp);

        const fileKey = sha256(r.fp);
        const rawParents = r.doc.parents.map(p => ({
          id: `${fileKey}-p-${p.lineStart}`,
          content: p.content,
          lineStart: p.lineStart,
          lineEnd: p.lineEnd,
          heading: p.heading,
          hash: sha256(p.content),
        }));
        const parentIdByIndex = new Map<number, string>(rawParents.map((p, i) => [i, p.id]));
        const rawChildren = r.doc.children.map(c => ({
          content: c.content,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          parentId: c.parent !== null ? parentIdByIndex.get(c.parent) ?? null : null,
          hash: sha256(c.content),
        }));

        stderrProgress(`[${processedCount}/${total}] chunked ${name} (${rawChildren.length} chunks / ${rawParents.length} parents)`);
        progress?.onFile?.(processedCount, total, name, skipped);

        toIndex.push({ fp: r.fp, hash: r.hash, size: r.size, rawParents, rawChildren });
      }
    };

    const maybeYield = async () => {
      if (processedCount >= nextYieldAt) {
        nextYieldAt = processedCount + YIELD_INTERVAL;
        await yield_();
      }
    };

    while (!readQueueDone || readQueue.length > 0) {
      drainReads();
      if (!readQueueDone) await waitRead();
      await maybeYield();
    }
    drainReads();
    await yield_();

    skipped += readErrorCount;

    // Phase 2: embed in cross-file groups
    const EMBED_GROUP_TARGET = 256;
    const groupChunks: { fw: FileWork; ci: number }[] = [];
    let globalChunkIdx = 0;
    const totalChunks = toIndex.reduce((s, f) => s + f.rawChildren.length, 0);

    const flushGroup = async () => {
      if (groupChunks.length === 0) return;
      const texts = groupChunks.map(g => g.fw.rawChildren[g.ci].content);
      stderrProgress(`Embedding ${globalChunkIdx - groupChunks.length + 1}…${globalChunkIdx}/${totalChunks} chunks`);
      const vectors = await embedBatch(texts);
      for (let vi = 0; vi < groupChunks.length; vi++) {
        const g = groupChunks[vi];
        g.fw._vectors ??= new Array(g.fw.rawChildren.length);
        g.fw._vectors[g.ci] = vectors[vi];
      }
      progress?.onEmbed?.(globalChunkIdx, totalChunks);
      groupChunks.length = 0;
      // Yield so the TUI can render the progress update before the next batch.
      await yield_();
    };

    for (const fw of toIndex) {
      for (let j = 0; j < fw.rawChildren.length; j++) {
        groupChunks.push({ fw, ci: j });
        globalChunkIdx++;
        if (groupChunks.length >= EMBED_GROUP_TARGET) await flushGroup();
      }
    }
    await flushGroup();

    // Phase 3: insert parents + children + vectors into DB
    let chunked = 0;
    const indexedAt = new Date().toISOString();
    const tx = database.transaction(() => {
      for (const fw of toIndex) {
        const vectors = fw._vectors;
        const fileKey = sha256(fw.fp);
        for (const p of fw.rawParents) {
          repo.insertParent(database, {
            id: p.id,
            filePath: fw.fp,
            content: p.content,
            lineStart: p.lineStart,
            lineEnd: p.lineEnd,
            heading: p.heading,
            hash: p.hash,
            indexedAt,
            tokens: Math.ceil(p.content.length / 4),
          });
        }
        for (let j = 0; j < fw.rawChildren.length; j++) {
          const c = fw.rawChildren[j];
          const chunkResult = repo.insertChunk(database, {
            id: `${fileKey}-${c.lineStart}`,
            filePath: fw.fp, content: c.content,
            lineStart: c.lineStart, lineEnd: c.lineEnd, hash: c.hash,
            indexedAt, tokens: Math.ceil(c.content.length / 4),
            parentId: c.parentId,
          });          
          if (vectors?.[j]) {
            repo.insertVector(database, Number(chunkResult.lastInsertRowid), vectors[j]);
          }
          chunked++;
        }
        repo.upsertFile(database, fw.fp, fw.hash, fw.rawChildren.length, indexedAt, fw.size, true);
      }
    });

    tx();

    if (!hadCallbacks) process.stderr.write(`\r\x1b[2K`);
    progress?.onSave?.();
    repo.setMetadata(database, repo.MetadataKey.LastBuild, new Date().toISOString());
    repo.setMetadata(database, repo.MetadataKey.EmbeddingModel, EMBEDDING_MODEL);

    return { indexed: toIndex.length, chunks: chunked, skipped, durationMs: Date.now() - startMs };
  } finally {
    if (hadCallbacks) _suppressStderr = false;
  }
}
