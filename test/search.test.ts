import { test, expect } from "vitest";
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
  expect(results).toEqual([]);
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
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].chunk.file).toBe("auth.ts");
  for (const r of results) expect(r.vector).toBe(0);
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
  expect(results.length).toBe(1);
  expect(results[0].chunk.file).toBe("a.ts");
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
  expect(results[0].chunk.file).toBe("exact.ts");
});

test("hybridSearch: respects the limit parameter", async () => {
  const index = {
    chunks: Array.from({ length: 8 }, (_, i) =>
      chunk(`f${i}.ts`, ("query ".repeat(i + 1) + "filler text here").trim())),
    files: {},
    lastBuild: "",
  };
  const results = await hybridSearch("query", index, 3, 1);
  expect(results.length).toBe(3);
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
    expect(results[i - 1].hybrid).toBeGreaterThanOrEqual(results[i].hybrid);
  }
});
