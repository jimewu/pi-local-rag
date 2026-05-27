import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { INDEX_FILE, ensureDir } from "./store.ts";

export interface Chunk {
  id: string;
  file: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  hash: string;
  indexed: string;
  tokens: number;
  vector?: number[]; // 384-dim embedding, present after embed step
}

export interface IndexMeta {
  chunks: Chunk[];
  files: Record<string, { hash: string; chunks: number; indexed: string; size: number; embedded?: boolean }>;
  lastBuild: string;
  embeddingModel?: string;
}

export function loadIndex(): IndexMeta {
  ensureDir();
  if (!existsSync(INDEX_FILE)) return { chunks: [], files: {}, lastBuild: "" };
  try {
    const data = JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
    return {
      chunks: Array.isArray(data.chunks) ? data.chunks : [],
      files: data.files && typeof data.files === "object" ? data.files : {},
      lastBuild: data.lastBuild ?? "",
      embeddingModel: data.embeddingModel,
    };
  } catch { return { chunks: [], files: {}, lastBuild: "" }; }
}

export function saveIndex(index: IndexMeta) {
  ensureDir();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}
