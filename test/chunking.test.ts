import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "../index.ts";

test("chunkText: short text under threshold returns a single chunk starting at line 1", () => {
  const text = "line one\nline two\nline three";
  const chunks = chunkText(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].lineStart, 1);
  assert.equal(chunks[0].lineEnd, 3);
  assert.equal(chunks[0].content, text);
});

test("chunkText: text just under 20 chars after trimming is dropped", () => {
  // single short line — chunk.trim().length must be > 20 to be kept
  const chunks = chunkText("tiny");
  assert.equal(chunks.length, 0);
});

test("chunkText: respects maxLines and produces consecutive line ranges", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1} content`);
  const chunks = chunkText(lines.join("\n"), 50);
  assert.ok(chunks.length >= 2, "should produce multiple chunks for 120 lines");
  // chunks should cover line 1 onward with no gaps
  assert.equal(chunks[0].lineStart, 1);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].lineStart, chunks[i - 1].lineEnd + 1, "consecutive chunks should be contiguous");
  }
});

test("chunkText: prefers breaking at blank lines near the window end", () => {
  // 50 lines; blank line at position 45 (1-indexed) — break should land there
  const lines = Array.from({ length: 80 }, (_, i) => (i === 44 ? "" : `content line ${i + 1}`));
  const chunks = chunkText(lines.join("\n"), 50);
  // First chunk should end at the blank line (line 45)
  assert.equal(chunks[0].lineEnd, 45);
});

test("chunkText: does not lose lines across the boundary", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `data ${i}`);
  const chunks = chunkText(lines.join("\n"), 50);
  const last = chunks[chunks.length - 1];
  assert.equal(last.lineEnd, 200);
});
