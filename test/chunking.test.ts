import { test, expect } from "vitest";
import { chunkText } from "../index.ts";

test("chunkText: short text under threshold returns a single chunk starting at line 1", () => {
  const text = "line one\nline two\nline three";
  const chunks = chunkText(text);
  expect(chunks.length).toBe(1);
  expect(chunks[0].lineStart).toBe(1);
  expect(chunks[0].lineEnd).toBe(3);
  expect(chunks[0].content).toBe(text);
});

test("chunkText: text just under 20 chars after trimming is dropped", () => {
  const chunks = chunkText("tiny");
  expect(chunks.length).toBe(0);
});

test("chunkText: respects maxLines and produces consecutive line ranges", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1} content`);
  const chunks = chunkText(lines.join("\n"), 50);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks[0].lineStart).toBe(1);
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i].lineStart, "consecutive chunks should be contiguous").toBe(chunks[i - 1].lineEnd + 1);
  }
});

test("chunkText: prefers breaking at blank lines near the window end", () => {
  const lines = Array.from({ length: 80 }, (_, i) => (i === 44 ? "" : `content line ${i + 1}`));
  const chunks = chunkText(lines.join("\n"), 50);
  expect(chunks[0].lineEnd).toBe(45);
});

test("chunkText: does not lose lines across the boundary", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `data ${i}`);
  const chunks = chunkText(lines.join("\n"), 50);
  const last = chunks[chunks.length - 1];
  expect(last.lineEnd).toBe(200);
});
