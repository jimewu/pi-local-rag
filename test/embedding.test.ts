/**
 * Embedding tests — exercise the real local ONNX pipeline.
 *
 * The Xenova/all-MiniLM-L6-v2 model (~23 MB) is fetched from HuggingFace by
 * Transformers.js on first call to `embed()`. Subsequent runs read from the
 * Transformers.js cache (~/.cache/huggingface/...). No fixture data is bundled
 * with the repo.
 *
 * Set SKIP_EMBEDDING_TESTS=1 to skip (e.g. in offline CI).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { embed, cosineSimilarity, hybridSearch } from "../index.ts";

const skip = process.env.SKIP_EMBEDDING_TESTS === "1";
const EMBED_TIMEOUT = 120_000; // first run downloads ~23 MB model

test("embed: returns a 384-dim unit-normalized vector for a single string", { skip, timeout: EMBED_TIMEOUT }, async () => {
  const v = await embed("hello world");
  assert.ok(Array.isArray(v));
  assert.equal(v.length, 384, "all-MiniLM-L6-v2 produces 384-dim embeddings");

  // The pipeline is configured with normalize: true → expect unit length
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit-normalized vector, got norm=${norm}`);

  // Sanity: not all zeros
  assert.ok(v.some(x => x !== 0));
});

test("embed: deterministic — same input produces same output", { skip, timeout: EMBED_TIMEOUT }, async () => {
  const a = await embed("the quick brown fox jumps over the lazy dog");
  const b = await embed("the quick brown fox jumps over the lazy dog");
  // Identical inputs should yield bit-identical vectors (model is deterministic)
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-6, `vectors differ at index ${i}: ${a[i]} vs ${b[i]}`);
  }
});

test("embed: semantic similarity — related sentences are closer than unrelated ones", { skip, timeout: EMBED_TIMEOUT }, async () => {
  const cat = await embed("A cat sits on the windowsill watching birds.");
  const kitten = await embed("A small kitten is looking at sparrows through the window.");
  const finance = await embed("Quarterly revenue exceeded analyst expectations by twelve percent.");

  const simRelated = cosineSimilarity(cat, kitten);
  const simUnrelated = cosineSimilarity(cat, finance);

  assert.ok(simRelated > simUnrelated + 0.1,
    `expected cat~kitten (${simRelated.toFixed(3)}) to clearly outscore cat~finance (${simUnrelated.toFixed(3)})`);
  assert.ok(simRelated > 0.5, `cat~kitten cosine should be high, got ${simRelated.toFixed(3)}`);
});

test("hybridSearch: vector path retrieves semantically relevant chunks even without keyword overlap", { skip, timeout: EMBED_TIMEOUT }, async () => {
  // Build an index where the most semantically relevant chunk shares NO query keywords.
  // BM25 alone would miss it; vector search should surface it.
  const chunks = [
    { content: "Photosynthesis is how plants convert sunlight into chemical energy.", file: "plants.md" },
    { content: "The team shipped a new dashboard for analytics reporting.", file: "shipping.md" },
    { content: "We pickled cucumbers in a vinegar brine with dill and garlic.", file: "recipe.md" },
  ];

  const vectors = await Promise.all(chunks.map(c => embed(c.content)));
  const index = {
    chunks: chunks.map((c, i) => ({
      id: `${c.file}-1`,
      file: c.file,
      content: c.content,
      lineStart: 1,
      lineEnd: 1,
      hash: "x",
      indexed: "2026-05-15T00:00:00Z",
      tokens: Math.ceil(c.content.length / 4),
      vector: vectors[i],
    })),
    files: {},
    lastBuild: "",
  };

  // Query has zero keyword overlap with the plants chunk, but is semantically close.
  // alpha=0 → pure vector search.
  const results = await hybridSearch("How do leaves produce food from light?", index, 3, 0);
  assert.ok(results.length > 0, "vector search should return results");
  assert.equal(results[0].chunk.file, "plants.md",
    `expected photosynthesis chunk to rank first via semantic similarity; got ${results[0].chunk.file}`);
});
