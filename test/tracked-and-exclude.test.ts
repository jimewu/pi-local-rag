import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, collectFromTracked, isExcludedByConfig } from "../index.ts";

function makeProj(): string {
  const root = mkdtempSync(join(tmpdir(), "rag-track-"));
  writeFileSync(join(root, "a.ts"), "x");
  writeFileSync(join(root, "b.ts"), "x");
  writeFileSync(join(root, "page.html"), "<p>x</p>");
  mkdirSync(join(root, "gen"));
  writeFileSync(join(root, "gen", "ignored.ts"), "x");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "deep.ts"), "x");
  return root;
}

test("collectFiles: excludePatterns filters a top-level file", () => {
  const root = makeProj();
  try {
    const files = collectFiles(root, undefined, ["b.ts"]).map(f => f.replace(root, ""));
    expect(files).not.toContain("/b.ts");
    expect(files).toContain("/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: excludePatterns filters a whole directory subtree", () => {
  const root = makeProj();
  try {
    const files = collectFiles(root, undefined, ["gen/"]).map(f => f.replace(root, ""));
    expect(files.some(f => f.includes("/gen/"))).toBe(false);
    expect(files).toContain("/src/deep.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: extension glob exclude", () => {
  const root = makeProj();
  try {
    const files = collectFiles(root, undefined, ["*.html"]).map(f => f.replace(root, ""));
    expect(files.some(f => f.endsWith(".html"))).toBe(false);
    expect(files.some(f => f.endsWith(".ts"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFromTracked: walks every tracked path, dedupes overlaps", () => {
  const a = mkdtempSync(join(tmpdir(), "rag-track-a-"));
  const b = mkdtempSync(join(tmpdir(), "rag-track-b-"));
  try {
    writeFileSync(join(a, "x.ts"), "x");
    writeFileSync(join(b, "y.ts"), "y");
    const cfg = {
      ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
      extraExtensions: [], excludeExtensions: [],
      trackedPaths: [a, b, a],
      excludePatterns: [],
    };
    const files = collectFromTracked(cfg);
    expect(files.filter(f => f.endsWith("x.ts")).length, "duplicate tracked path should not duplicate files").toBe(1);
    expect(files.some(f => f.endsWith("x.ts"))).toBe(true);
    expect(files.some(f => f.endsWith("y.ts"))).toBe(true);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("collectFromTracked: silently skips non-existent tracked paths", () => {
  const a = mkdtempSync(join(tmpdir(), "rag-track-a-"));
  try {
    writeFileSync(join(a, "x.ts"), "x");
    const cfg = {
      ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
      extraExtensions: [], excludeExtensions: [],
      trackedPaths: [a, "/definitely/not/a/real/dir-xyz-123"],
      excludePatterns: [],
    };
    const files = collectFromTracked(cfg);
    expect(files.length).toBe(1);
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

test("collectFromTracked: applies excludePatterns per tracked root", () => {
  const root = makeProj();
  try {
    const cfg = {
      ragEnabled: true, ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
      extraExtensions: [], excludeExtensions: [],
      trackedPaths: [root],
      excludePatterns: ["gen/"],
    };
    const files = collectFromTracked(cfg);
    expect(files.some(f => f.includes("/gen/"))).toBe(false);
    expect(files.some(f => f.endsWith("a.ts"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isExcludedByConfig: false when no patterns", () => {
  expect(isExcludedByConfig("/repo/a.ts", ["/repo"], [])).toBe(false);
});

test("isExcludedByConfig: matches a file relative to a root", () => {
  expect(isExcludedByConfig("/repo/gen/x.ts", ["/repo"], ["gen/"])).toBe(true);
  expect(isExcludedByConfig("/repo/src/x.ts", ["/repo"], ["gen/"])).toBe(false);
});

test("isExcludedByConfig: tries all roots; returns true if any matches", () => {
  expect(isExcludedByConfig("/repo-b/gen/x.ts", ["/repo-a", "/repo-b"], ["gen/"])).toBe(true);
});

test("isExcludedByConfig: file outside every root is not excluded", () => {
  expect(isExcludedByConfig("/elsewhere/a.ts", ["/repo"], ["*.ts"])).toBe(false);
});
