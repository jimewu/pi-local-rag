import { test, expect } from "vitest";
import { DEFAULT_TEXT_EXTS, normalizeExt, resolveExtensions } from "../index.ts";

test("normalizeExt: adds leading dot and lowercases", () => {
  expect(normalizeExt("cs")).toBe(".cs");
  expect(normalizeExt(".CS")).toBe(".cs");
  expect(normalizeExt("  .TeX  ")).toBe(".tex");
  expect(normalizeExt("")).toBe("");
  expect(normalizeExt("   ")).toBe("");
});

test("resolveExtensions: returns the default set when no overrides", () => {
  const exts = resolveExtensions({ extraExtensions: [], excludeExtensions: [] });
  for (const e of DEFAULT_TEXT_EXTS) expect(exts.has(e), `default ${e} missing`).toBe(true);
  expect(exts.size).toBe(DEFAULT_TEXT_EXTS.length);
});

test("resolveExtensions: default set covers common languages including the ones from issue #9", () => {
  const exts = resolveExtensions({ extraExtensions: [], excludeExtensions: [] });
  for (const e of [".cs", ".tsx", ".jsx", ".kt", ".swift", ".rb", ".php", ".lua", ".vue", ".svelte"]) {
    expect(exts.has(e), `expected default set to include ${e}`).toBe(true);
  }
});

test("resolveExtensions: extraExtensions are added and normalized", () => {
  const exts = resolveExtensions({ extraExtensions: ["tex", ".ZIG", " .nix "], excludeExtensions: [] });
  expect(exts.has(".tex")).toBe(true);
  expect(exts.has(".zig")).toBe(true);
  expect(exts.has(".nix")).toBe(true);
});

test("resolveExtensions: excludeExtensions remove from the default set", () => {
  const exts = resolveExtensions({ extraExtensions: [], excludeExtensions: [".md", "JSON"] });
  expect(exts.has(".md")).toBe(false);
  expect(exts.has(".json")).toBe(false);
  expect(exts.has(".ts")).toBe(true);
});

test("resolveExtensions: empty/whitespace entries are ignored", () => {
  const baseline = resolveExtensions({ extraExtensions: [], excludeExtensions: [] }).size;
  const exts = resolveExtensions({ extraExtensions: ["", "   "], excludeExtensions: ["", "  "] });
  expect(exts.size).toBe(baseline);
});
