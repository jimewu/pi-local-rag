import {
  EMBEDDING_MODEL, RERANKER_MODEL, RERANKER_ENABLED,
  EMBED_MAX_LENGTH, EMBED_BATCH_SIZE, VECTOR_DIM,
} from "./constants.ts";

// ─── HTTP backend (llama-swap / any OpenAI-compatible server) ───────────────
// Set RAG_EMBED_URL / RAG_RERANK_URL to route embedding/reranking to an
// external server (e.g. llama-swap serving Qwen3 GGUF on the local GPU).
// Nothing machine-specific is baked into this repo — the URLs come from the
// environment. The optional *_MODEL vars name the model on that server; the
// defaults match the Qwen3 GGUF setup. Output is truncated to VECTOR_DIM
// (Matryoshka-style: the leading dims carry the most signal) and re-normalized
// so stored vectors match the local backend's dimension.
const EMBED_URL = process.env.RAG_EMBED_URL;
const RERANK_URL = process.env.RAG_RERANK_URL;
const EMBED_HTTP_MODEL = process.env.RAG_EMBED_MODEL ?? "qwen3-embedding-4b";
const RERANK_HTTP_MODEL = process.env.RAG_RERANK_MODEL ?? "qwen3-reranker-4b";


/** L2-normalize a vector. Local ONNX output is already normalized; HTTP
 *  backends return full-width (e.g. 2560-dim) normalized vectors whose
 *  MRL-truncated sub-vector must be re-normalized before storage. */
function normalizeL2(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map(x => x / norm);
}

/** Conservative per-request budget in CHARACTERS for the HTTP backend.
 *  For CJK text 1 char ≈ 1 token (rare chars up to 2); for latin text 1
 *  token ≈ 4 chars — so a char budget never underestimates tokens, and each
 *  request stays under the server's physical batch (token) limit. */
const HTTP_BATCH_MAX_CHARS = 20000;

/** Ceiling for a single input's length in chars. The local ONNX path
 *  truncates every chunk to ~512 tokens; the HTTP path must also cap long
 *  chunks — otherwise one over-long chunk (50-line md chunk ≈ 20k+ chars)
 *  alone can exceed the server's physical batch even when it is the only
 *  text in the request. */
const HTTP_MAX_CHARS = 8000;

async function embedHttp(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  let batch: string[] = [];
  let batchChars = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const resp = await fetch(`${EMBED_URL}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_HTTP_MODEL, input: batch }),
    });
    if (!resp.ok) {
      throw new Error(`RAG_EMBED_URL ${EMBED_URL} returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
    for (const item of data.data ?? []) {
      out.push(normalizeL2((item.embedding ?? []).slice(0, VECTOR_DIM)));
    }
    batch = [];
    batchChars = 0;
  };

  for (const t of texts) {
    const clipped = t.length > HTTP_MAX_CHARS ? t.slice(0, HTTP_MAX_CHARS) : t;
    if (batch.length > 0 && batchChars + clipped.length > HTTP_BATCH_MAX_CHARS) await flush();
    batch.push(clipped);
    batchChars += clipped.length;
  }
  await flush();
  return out;
}


// The feature-extraction PIPELINE ignores a `max_length` option (it only
// passes padding/truncation to the tokenizer, which then truncates to the
// model's full max position — 8192 for bge-m3). At batch 32/64 that tries to
// allocate a ~256 GB attention buffer and the process gets OOM-killed. So we
// drive the tokenizer + AutoModel directly (same path the reranker uses) and
// clamp the sequence length ourselves. Mean pooling + L2 normalize matches
// the pipeline's default pooling behavior for sentence embeddings.

let _embedder: { tokenizer: any; model: any } | null = null;
let _embedderLoading: Promise<{ tokenizer: any; model: any }> | null = null;

async function getEmbedder() {
  if (_embedder) return _embedder;
  if (_embedderLoading) return _embedderLoading;
  const { AutoTokenizer, AutoModel } = await import("@xenova/transformers");
  _embedderLoading = (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL);
    const model = await AutoModel.from_pretrained(EMBEDDING_MODEL);
    _embedder = { tokenizer, model };
    return _embedder;
  })().finally(() => { _embedderLoading = null; });
  return _embedderLoading;
}

/** Embed a batch of texts: tokenize (clamped length) → forward → mean-pool
 *  over non-padding tokens → L2 normalize. Returns number[][] (dim = model dim). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (EMBED_URL) return embedHttp(texts);
  const { tokenizer, model } = await getEmbedder();
  const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: EMBED_MAX_LENGTH });
  const outputs = await model(inputs);
  const hidden = outputs.last_hidden_state; // [batch, seq, dim]
  const dims = hidden.dims as number[];
  const batch = dims[0], seq = dims[1], dim = dims[2];
  const data = hidden.data as Float32Array;
  const mask = inputs.attention_mask?.data as Float32Array | undefined;

  const vectors: number[][] = new Array(batch);
  for (let b = 0; b < batch; b++) {
    const vec = new Float32Array(dim);
    let count = 0;
    for (let s = 0; s < seq; s++) {
      if (mask && mask[b * seq + s] === 0) continue;
      count++;
      const base = (b * seq + s) * dim;
      for (let d = 0; d < dim; d++) vec[d] += data[base + d];
    }
    if (count === 0) count = 1;
    let norm = 0;
    for (let d = 0; d < dim; d++) { vec[d] /= count; norm += vec[d] * vec[d]; }
    norm = Math.sqrt(norm) || 1;
    const out = new Array<number>(dim);
    for (let d = 0; d < dim; d++) out[d] = vec[d] / norm;
    vectors[b] = out;
  }
  return vectors;
}

export async function embed(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}

/**
 * Yield to the event loop so the TUI can render progress updates.
 * ONNX inference is synchronous from the event loop's perspective;
 * without this, the UI freezes during embedding.
 */
const yield_ = () => new Promise<void>(r => setTimeout(r, 0));

/** Default batch size for a single ONNX forward pass (env-tunable). */
export const BATCH_SIZE = EMBED_BATCH_SIZE;

/**
 * Embed `texts` using true batched ONNX inference.
 *
 * The model is called once per batch of up to `BATCH_SIZE` texts rather than
 * once per text, giving a ~BATCH_SIZE× speedup on CPU.  The output has
 * dims [batchSize, VECTOR_DIM]; we slice it into per-text arrays.
 *
 * `onProgress` is fired after each batch with the cumulative count so the TUI
 * can render a smooth progress bar (same contract as before).
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (i: number, total: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const results: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const embedded = await embedTexts(batch);
    for (let j = 0; j < batch.length; j++) {
      results[start + j] = embedded[j];
    }
    onProgress?.(Math.min(start + batch.length, texts.length), texts.length);
    // Yield after each batch so the TUI can re-render before the next pass.
    await yield_();
  }

  return results;
}

// ─── Reranker (cross-encoder) ────────────────────────────────────────────────
//
// Optional second stage: hybrid BM25+vector produces top-K candidates from
// children; the reranker scores (query, parent-content) pairs with a
// cross-encoder and re-sorts. Disabled when RAG_RERANKER=false.
//
// Implementation note: the text-classification pipeline in @xenova/transformers
// does NOT accept {text, text_pair} object inputs (it only splits strings), so
// we drive the tokenizer + AutoModelForSequenceClassification directly with the
// tokenizer's text_pair option (same path QuestionAnsweringPipeline uses).

let _reranker: { tokenizer: any; model: any } | null = null;
let _rerankerLoading: Promise<{ tokenizer: any; model: any } | null> | null = null;

export function isRerankerEnabled(): boolean {
  return RERANKER_ENABLED || !!RERANK_URL;
}

async function rerankHttp(query: string, passages: string[]): Promise<number[]> {
  const resp = await fetch(`${RERANK_URL}/v1/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: RERANK_HTTP_MODEL, query, documents: passages }),
  });
  if (!resp.ok) {
    throw new Error(`RAG_RERANK_URL ${RERANK_URL} returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as { results?: Array<{ index: number; relevance_score: number }> };
  const scores = new Array<number>(passages.length).fill(0);
  for (const r of data.results ?? []) {
    if (Number.isInteger(r.index) && r.index >= 0 && r.index < scores.length) {
      scores[r.index] = Math.min(1, Math.max(0, r.relevance_score));
    }
  }
  return scores;
}

async function getReranker() {
  if (!RERANKER_ENABLED) return null;
  if (_reranker) return _reranker;
  if (_rerankerLoading) return _rerankerLoading;
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@xenova/transformers");
  _rerankerLoading = (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL);
    _reranker = { tokenizer, model };
    return _reranker;
  })().finally(() => { _rerankerLoading = null; });
  return _rerankerLoading;
}

/**
 * Cross-encoder rerank of (query, passage) pairs. Returns scores aligned with
 * `passages` (higher = more relevant), or null when the reranker is disabled
 * or unavailable. Accepts an injected scorer so tests can fake the model.
 */
export async function rerank(
  query: string,
  passages: string[],
  scorer?: (pairs: Array<{ text: string; text_pair: string }>) => Promise<Array<{ score: number }>>,
): Promise<number[] | null> {
  if (passages.length === 0) return [];

  if (scorer) {
    const pairs = passages.map(p => ({ text: query, text_pair: p }));
    const outputs = await scorer(pairs);
    return outputs.map(o => Math.min(1, Math.max(0, typeof o?.score === "number" ? o.score : 0)));
  }

  if (RERANK_URL) return rerankHttp(query, passages);

  const rr = await getReranker();
  if (!rr) return null;
  const { tokenizer, model } = rr;

  const queries = new Array(passages.length).fill(query);
  const inputs = tokenizer(queries, { text_pair: passages, padding: true, truncation: true });
  const outputs = await model(inputs);
  const logits = outputs.logits; // Tensor [batch, num_labels]
  const dims = logits.dims as number[];
  const data = logits.data as Float32Array;
  const numLabels = dims && dims.length >= 2 ? dims[dims.length - 1] : 1;
  const stride = Math.max(1, numLabels);
  const scores: number[] = [];
  for (let i = 0; i < passages.length; i++) {
    // Single-label rerankers expose one logit; binary expose the positive
    // class at index 1. Either way sigmoid → 0..1 relevance.
    const idx = stride === 1 ? 0 : Math.min(1, stride - 1);
    const logit = data[i * stride + idx] ?? 0;
    scores.push(1 / (1 + Math.exp(-logit)));
  }
  return scores;
}
