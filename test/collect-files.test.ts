import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "../index.ts";

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  writeFileSync(join(root, "a.ts"), "export const a = 1;");
  writeFileSync(join(root, "b.md"), "# heading");
  writeFileSync(join(root, "c.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, "image.png"), Buffer.alloc(10));

  // Skipped dirs
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "skip.ts"), "// should not be indexed");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "x");

  // Dot-prefixed dir (should be skipped)
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, ".hidden", "secret.ts"), "// hidden");

  // Nested allowed dir
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "deep.py"), "print('hi')");

  // Oversize file (> 500_000)
  writeFileSync(join(root, "huge.ts"), "x".repeat(500_001));

  return root;
}

test("collectFiles: walks dir, applies extension allowlist, skips node_modules and dotdirs", () => {
  const root = makeTree();
  try {
    const files = collectFiles(root).map(f => f.replace(root, "")).sort();
    assert.ok(files.includes("/a.ts"));
    assert.ok(files.includes("/b.md"));
    assert.ok(files.includes("/src/deep.py"));
    assert.ok(!files.some(f => f.includes("node_modules")), "node_modules must be skipped");
    assert.ok(!files.some(f => f.includes(".git")), ".git must be skipped");
    assert.ok(!files.some(f => f.includes(".hidden")), "dot-prefixed dirs must be skipped");
    assert.ok(!files.some(f => f.endsWith(".bin") || f.endsWith(".png")), "binary extensions not in allowlist");
    assert.ok(!files.some(f => f.endsWith("huge.ts")), "files >= 500_000 bytes must be skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: file path returns single entry when extension allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    const fp = join(root, "single.ts");
    writeFileSync(fp, "export {};");
    assert.deepEqual(collectFiles(fp), [fp]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: file path returns empty when extension not allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    const fp = join(root, "data.bin");
    writeFileSync(fp, "x");
    assert.deepEqual(collectFiles(fp), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: nonexistent path returns empty", () => {
  assert.deepEqual(collectFiles(join(tmpdir(), "definitely-not-here-xyz-12345")), []);
});

test("collectFiles: custom extension set is honored", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    writeFileSync(join(root, "a.ts"), "x");
    writeFileSync(join(root, "b.cs"), "x");
    const files = collectFiles(root, new Set([".cs"]));
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("b.cs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
