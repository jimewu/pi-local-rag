import { test } from "node:test";
import assert from "node:assert/strict";
import { hybridSearch } from "../index.ts";

function chunk(file: string, content: string, lineStart = 1) {
  return {
    id: `${file}-${lineStart}`,
    file,
    content,
    lineStart,
    lineEnd: lineStart + content.split("\n").length - 1,
    hash: "abc",
    indexed: new Date().toISOString(),
    tokens: Math.ceil(content.length / 4),
  };
}

test("hybridSearch: empty index returns no results", async () => {
  const results = await hybridSearch("anything", { chunks: [], files: {}, lastBuild: "" });
  assert.deepEqual(results, []);
});

test("hybridSearch: BM25-only path (no vectors) ranks term matches above unrelated text", async () => {
  const index = {
    chunks: [
      chunk("auth.ts", "function loginUser(email, password) { return verifyToken(email); }"),
      chunk("readme.md", "# Project\nThis project does many things unrelated to the query."),
      chunk("db.ts", "connect to postgres database and return a client handle"),
    ],
    files: {},
    lastBuild: "",
  };
  const results = await hybridSearch("loginUser email password", index, 10, 1);
  assert.ok(results.length > 0, "should return at least one result");
  assert.equal(results[0].chunk.file, "auth.ts", "best match should be the auth chunk");
  // vector score should be 0 since no vectors are present
  for (const r of results) assert.equal(r.vector, 0);
});

test("hybridSearch: filters out chunks with zero hybrid score", async () => {
  const index = {
    chunks: [
      chunk("a.ts", "alpha beta gamma"),
      chunk("b.ts", "nothing matching here at all"),
    ],
    files: {},
    lastBuild: "",
  };
  const results = await hybridSearch("alpha", index, 10, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].chunk.file, "a.ts");
});

test("hybridSearch: phrase boost — exact phrase outranks scattered terms", async () => {
  const index = {
    chunks: [
      chunk("exact.ts", "user authentication flow handles tokens"),
      chunk("scattered.ts", "authentication is one thing and user logic is another flow"),
    ],
    files: {},
    lastBuild: "",
  };
  const results = await hybridSearch("user authentication flow", index, 10, 1);
  assert.equal(results[0].chunk.file, "exact.ts");
});

test("hybridSearch: respects the limit parameter", async () => {
  // Vary match counts so chunks get distinct BM25 scores; identical scores
  // would normalize to 0 and be filtered out (documented behavior of hybridSearch).
  const index = {
    chunks: Array.from({ length: 8 }, (_, i) =>
      chunk(`f${i}.ts`, ("query ".repeat(i + 1) + "filler text here").trim())),
    files: {},
    lastBuild: "",
  };
  const results = await hybridSearch("query", index, 3, 1);
  assert.equal(results.length, 3);
});

test("hybridSearch: results are sorted by descending hybrid score", async () => {
  const index = {
    chunks: [
      chunk("a.ts", "match match match relevance heavy"),
      chunk("b.ts", "match once only"),
      chunk("c.ts", "match match medium frequency"),
    ],
    files: {},
    lastBuild: "",
  };
  const results = await hybridSearch("match", index, 10, 1);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].hybrid >= results[i].hybrid, "results must be sorted desc by hybrid score");
  }
});
