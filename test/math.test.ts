import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, normalize } from "../index.ts";

test("cosineSimilarity: identical vectors = 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosineSimilarity: orthogonal vectors = 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: opposite vectors = -1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
});

test("cosineSimilarity: scale-invariant", () => {
  // scaling one vector should not change cosine
  const a = cosineSimilarity([1, 2, 3], [2, 4, 6]);
  assert.ok(Math.abs(a - 1) < 1e-9);
});

test("cosineSimilarity: mismatched lengths returns 0", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
});

test("cosineSimilarity: zero vector returns 0 (no divide-by-zero)", () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

test("normalize: maps to [0,1] preserving order", () => {
  const out = normalize([10, 0, 5]);
  assert.equal(out[0], 1);
  assert.equal(out[1], 0);
  assert.equal(out[2], 0.5);
});

test("normalize: all-equal input returns all zeros", () => {
  assert.deepEqual(normalize([3, 3, 3]), [0, 0, 0]);
});

test("normalize: single value returns [0]", () => {
  assert.deepEqual(normalize([7]), [0]);
});
