import { VECTOR_DIM } from "./constants.ts";
import { embed } from "./embed.ts";
import type { Chunk, IndexMeta } from "./index-store.ts";

export interface ScoredChunk {
  chunk: Chunk;
  bm25: number;
  vector: number;
  hybrid: number;
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

export async function hybridSearch(
  query: string,
  index: IndexMeta,
  limit = 10,
  alpha = 0.4,
): Promise<ScoredChunk[]> {
  if (!index.chunks.length) return [];

  // ── BM25 ──
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const queryLower = query.toLowerCase();
  const idfMap = new Map<string, number>();
  for (const term of terms) {
    const docsWithTerm = index.chunks.filter(c => c.content.toLowerCase().includes(term)).length;
    idfMap.set(term, Math.log(1 + index.chunks.length / (1 + docsWithTerm)));
  }

  const bm25Raw = index.chunks.map(chunk => {
    const lower = chunk.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const count = (lower.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
      if (count > 0) score += Math.log(1 + count) * (idfMap.get(term) ?? 0);
    }
    if (lower.includes(queryLower)) score *= 2;
    if (chunk.file.toLowerCase().includes(terms[0] ?? "")) score *= 1.5;
    return score;
  });

  const bm25Norm = normalize(bm25Raw);

  // ── Vector ──
  const chunksWithVectors = index.chunks.filter(c => c.vector && c.vector.length === VECTOR_DIM);
  const hasVectors = chunksWithVectors.length > 0;

  let vectorNorm: number[] = new Array(index.chunks.length).fill(0);

  if (hasVectors) {
    const queryVec = await embed(query);
    const vectorRaw = index.chunks.map(chunk =>
      chunk.vector && chunk.vector.length === VECTOR_DIM
        ? cosineSimilarity(queryVec, chunk.vector)
        : 0
    );
    vectorNorm = normalize(vectorRaw);
  }

  // ── Hybrid ──
  const scored: ScoredChunk[] = index.chunks.map((chunk, i) => ({
    chunk,
    bm25: bm25Norm[i],
    vector: vectorNorm[i],
    hybrid: hasVectors
      ? alpha * bm25Norm[i] + (1 - alpha) * vectorNorm[i]
      : bm25Norm[i],
  }));

  return scored
    .filter(s => s.hybrid > 0)
    .sort((a, b) => b.hybrid - a.hybrid)
    .slice(0, limit);
}
