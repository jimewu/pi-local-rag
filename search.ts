import Database from "better-sqlite3";
import { embed, rerank, isRerankerEnabled } from "./embed.ts";
import { getDbConn } from "./db.ts";
import type { Chunk } from "./db.ts";
import { RERANK_TOP_K } from "./constants.ts";
import * as repo from "./repository.ts";

export interface ParentContent {
  id: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  heading: string | null;
}

export interface ScoredChunk {
  chunk: Chunk;
  bm25: number;
  vector: number;
  hybrid: number;
  /** Recalled parent section when the child belongs to a markdown section. */
  parent?: ParentContent | null;
  /** Cross-encoder rerank score when the reranker ran (0..1). */
  rerank?: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function normalize(scores: number[]): number[] {
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min;
  if (range === 0) return scores.map(() => 0);
  return scores.map(s => (s - min) / range);
}

function l2ToCosine(l2Dist: number): number {
  return 1 - (l2Dist * l2Dist) / 2;
}

/**
 * Hybrid search over CHILD chunks (BM25 via FTS5 trigram + sqlite-vec cosine),
 * then recalls the PARENT section for each hit (so answers are never taken
 * out of context) and optionally re-sorts the candidates with a cross-encoder
 * reranker (bge-reranker by default; disable via RAG_RERANKER=false).
 */
export async function hybridSearch(
  query: string,
  limit = 10,
  alpha = 0.4,
  _db?: Database.Database
): Promise<ScoredChunk[]> {
  const database = _db ?? getDbConn();

  // Fast existence check — LIMIT 1 avoids full table scan
  if (!repo.hasAnyChunks(database)) return [];

  // BM25 via FTS5 — cap candidates to avoid scanning entire index
  const ftsQuery = query.split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
  const ftsLimit = Math.max(limit * 20, 200);
  const ftsResults = repo.searchFts(database, ftsQuery, ftsLimit);

  // Vector via sqlite-vec
  const queryVec = await embed(query);
  const vecLimit = Math.max(limit * 10, 100);
  const vecResults = repo.searchVectors(database, queryVec, vecLimit);

  const ftsRowIds = new Set(ftsResults.map(r => r.rowid));
  const vecRowIds = new Set(vecResults.map(r => r.rowid));
  const allRowIds: Set<number> = new Set([...ftsRowIds, ...vecRowIds]);

  if (allRowIds.size === 0) return [];

  const chunks = repo.getChunksByRowids(database, Array.from(allRowIds));

  const chunkMap = new Map<number, typeof chunks[0]>();
  for (const c of chunks) chunkMap.set(c.rowid, c);

  const bm25Scores = ftsResults.map(r => r.bm25_score);
  const hasBm25 = bm25Scores.length > 0;
  const distances = vecResults.map(r => r.distance);
  const hasVectors = distances.length > 0;

  // Normalize BM25
  const bm25NormMap = new Map<number, number>();
  if (hasBm25) {
    const bm25Max = Math.max(...bm25Scores);
    const bm25Min = Math.min(...bm25Scores);
    const bm25Range = bm25Max - bm25Min;
    if (bm25Range === 0) {
      for (const r of ftsResults) {
        bm25NormMap.set(r.rowid, 1);
      }
    } else {
      for (const r of ftsResults) {
        bm25NormMap.set(r.rowid, (r.bm25_score - bm25Min) / bm25Range);
      }
    }
  }

  // Normalize distances → cosine → min-max
  const vecNormMap = new Map<number, number>();
  if (hasVectors) {
    for (const r of vecResults) {
      vecNormMap.set(r.rowid, l2ToCosine(r.distance));
    }
    const cosines = Array.from(vecNormMap.values());
    const cosMax = Math.max(...cosines);
    const cosMin = Math.min(...cosines);
    const cosRange = cosMax - cosMin;
    if (cosRange > 0) {
      const normalized = new Map<number, number>();
      for (const [rowid, cos] of vecNormMap) {
        normalized.set(rowid, (cos - cosMin) / cosRange);
      }
      vecNormMap.clear();
      for (const [k, v] of normalized) vecNormMap.set(k, v);
    } else {
      for (const k of vecNormMap.keys()) vecNormMap.set(k, 1);
    }
  }

  // Build scored results
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const scored: ScoredChunk[] = [];

  for (const rowid of allRowIds) {
    const c = chunkMap.get(rowid);
    if (!c) continue;

    const bm25Norm = bm25NormMap.get(rowid) ?? 0;
    const vecNorm = vecNormMap.get(rowid) ?? 0;

    let bm25Final = bm25Norm;
    // Boost when the first meaningful query term appears in the file path.
    // Guard on terms[0]: an empty/short query makes includes("") always true,
    // which would spuriously boost every result.
    if (terms[0] && c.file_path.toLowerCase().includes(terms[0])) {
      bm25Final = Math.min(1, bm25Final * 1.5);
    }

    const hybrid = hasVectors
      ? alpha * bm25Final + (1 - alpha) * vecNorm
      : bm25Final;

    scored.push({
      chunk: {
        id: c.id, file: c.file_path, content: c.chunk_content,
        lineStart: c.line_start, lineEnd: c.line_end,
        hash: c.chunk_hash, indexed: c.indexed_at, tokens: c.tokens,
        parentId: c.parent_id,
      },
      bm25: bm25Final, vector: vecNorm, hybrid,
    });
  }

  const filtered = scored
    .filter(s => s.hybrid > 0)
    .sort((a, b) => b.hybrid - a.hybrid);

  if (filtered.length === 0) return [];

  // ── Parent recall ─────────────────────────────────────────────────────────
  // Every child that belongs to a markdown section carries a parent_id. Load
  // the parent (the whole section) so callers can present it as the answer
  // body instead of a decontextualized paragraph.
  const parentIds = new Set<string>();
  for (const s of filtered) {
    if (s.chunk.parentId) parentIds.add(s.chunk.parentId);
  }
  const parents = parentIds.size
    ? repo.getParentsByRowids(database, Array.from(parentIds))
    : [];
  const parentMap = new Map(parents.map(p => [p.id, p]));
  for (const s of filtered) {
    const pid = s.chunk.parentId;
    const p = pid ? parentMap.get(pid) : undefined;
    s.parent = p
      ? { id: p.id, content: p.content, lineStart: p.line_start, lineEnd: p.line_end, heading: p.heading }
      : null;
  }

  // ── Rerank (optional cross-encoder) ──────────────────────────────────────
  if (isRerankerEnabled()) {
    const candidates = filtered.slice(0, RERANK_TOP_K);
    const passages = candidates.map(c => c.parent?.content ?? c.chunk.content);
    const scores = await rerank(query, passages);
    if (scores) {
      for (let i = 0; i < candidates.length; i++) {
        candidates[i].rerank = scores[i];
      }
      candidates.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0));
      return candidates.slice(0, limit);
    }
  }

  return filtered.slice(0, limit);
}
