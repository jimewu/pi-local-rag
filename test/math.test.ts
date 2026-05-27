import { test, expect } from "vitest";
import { cosineSimilarity, normalize } from "../index.ts";

test("cosineSimilarity: identical vectors = 1", () => {
  expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBe(1);
});

test("cosineSimilarity: orthogonal vectors = 0", () => {
  expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
});

test("cosineSimilarity: opposite vectors = -1", () => {
  expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBe(-1);
});

test("cosineSimilarity: scale-invariant", () => {
  const a = cosineSimilarity([1, 2, 3], [2, 4, 6]);
  expect(Math.abs(a - 1)).toBeLessThan(1e-9);
});

test("cosineSimilarity: mismatched lengths returns 0", () => {
  expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
});

test("cosineSimilarity: zero vector returns 0 (no divide-by-zero)", () => {
  expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
});

test("normalize: maps to [0,1] preserving order", () => {
  const out = normalize([10, 0, 5]);
  expect(out[0]).toBe(1);
  expect(out[1]).toBe(0);
  expect(out[2]).toBe(0.5);
});

test("normalize: all-equal input returns all zeros", () => {
  expect(normalize([3, 3, 3])).toEqual([0, 0, 0]);
});

test("normalize: single value returns [0]", () => {
  expect(normalize([7])).toEqual([0]);
});
