import { EMBEDDING_MODEL } from "./constants.ts";

let _pipeline: any = null;

async function getEmbedder() {
  if (_pipeline) return _pipeline;
  const { pipeline } = await import("@xenova/transformers");
  _pipeline = await pipeline("feature-extraction", EMBEDDING_MODEL);
  return _pipeline;
}

export async function embed(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedBatch(
  texts: string[],
  onProgress?: (i: number, total: number) => void,
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(await embed(texts[i]));
    onProgress?.(i + 1, texts.length);
  }
  return results;
}
