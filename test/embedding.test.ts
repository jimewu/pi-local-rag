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
import { test, expect } from "vitest";
import { embed, cosineSimilarity, hybridSearch } from "../index.ts";

const skip = process.env.SKIP_EMBEDDING_TESTS === "1";
const EMBED_TIMEOUT = 120_000; // first run downloads ~23 MB model

test.skipIf(skip)("embed: returns a 384-dim unit-normalized vector for a single string", async () => {
  const v = await embed("hello world");
  expect(Array.isArray(v)).toBe(true);
  expect(v.length).toBe(384);

  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  expect(Math.abs(norm - 1), `expected unit-normalized vector, got norm=${norm}`).toBeLessThan(1e-3);

  expect(v.some(x => x !== 0)).toBe(true);
}, EMBED_TIMEOUT);

test.skipIf(skip)("embed: deterministic — same input produces same output", async () => {
  const a = await embed("the quick brown fox jumps over the lazy dog");
  const b = await embed("the quick brown fox jumps over the lazy dog");
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(Math.abs(a[i] - b[i]), `vectors differ at index ${i}: ${a[i]} vs ${b[i]}`).toBeLessThan(1e-6);
  }
}, EMBED_TIMEOUT);

test.skipIf(skip)("embed: semantic similarity — related sentences are closer than unrelated ones", async () => {
  const cat = await embed("A cat sits on the windowsill watching birds.");
  const kitten = await embed("A small kitten is looking at sparrows through the window.");
  const finance = await embed("Quarterly revenue exceeded analyst expectations by twelve percent.");

  const simRelated = cosineSimilarity(cat, kitten);
  const simUnrelated = cosineSimilarity(cat, finance);

  expect(simRelated, `expected cat~kitten (${simRelated.toFixed(3)}) to clearly outscore cat~finance (${simUnrelated.toFixed(3)})`)
    .toBeGreaterThan(simUnrelated + 0.1);
  expect(simRelated, `cat~kitten cosine should be high, got ${simRelated.toFixed(3)}`).toBeGreaterThan(0.5);
}, EMBED_TIMEOUT);

test.skipIf(skip)("hybridSearch: vector path retrieves semantically relevant chunks even without keyword overlap", async () => {
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

  const results = await hybridSearch("How do leaves produce food from light?", index, 3, 0);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].chunk.file,
    `expected photosynthesis chunk to rank first via semantic similarity; got ${results[0].chunk.file}`)
    .toBe("plants.md");
}, EMBED_TIMEOUT);
