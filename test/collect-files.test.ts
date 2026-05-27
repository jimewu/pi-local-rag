import { test, expect } from "vitest";
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

  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "skip.ts"), "// should not be indexed");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "x");

  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, ".hidden", "secret.ts"), "// hidden");

  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "deep.py"), "print('hi')");

  writeFileSync(join(root, "huge.ts"), "x".repeat(500_001));

  return root;
}

test("collectFiles: walks dir, applies extension allowlist, skips node_modules and dotdirs", () => {
  const root = makeTree();
  try {
    const files = collectFiles(root).map(f => f.replace(root, "")).sort();
    expect(files).toContain("/a.ts");
    expect(files).toContain("/b.md");
    expect(files).toContain("/src/deep.py");
    expect(files.some(f => f.includes("node_modules"))).toBe(false);
    expect(files.some(f => f.includes(".git"))).toBe(false);
    expect(files.some(f => f.includes(".hidden"))).toBe(false);
    expect(files.some(f => f.endsWith(".bin") || f.endsWith(".png"))).toBe(false);
    expect(files.some(f => f.endsWith("huge.ts"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: file path returns single entry when extension allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    const fp = join(root, "single.ts");
    writeFileSync(fp, "export {};");
    expect(collectFiles(fp)).toEqual([fp]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: file path returns empty when extension not allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    const fp = join(root, "data.bin");
    writeFileSync(fp, "x");
    expect(collectFiles(fp)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: nonexistent path returns empty", () => {
  expect(collectFiles(join(tmpdir(), "definitely-not-here-xyz-12345"))).toEqual([]);
});

test("collectFiles: picks up .pdf and .docx even without being in TEXT_EXTS", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    writeFileSync(join(root, "doc.pdf"), Buffer.from("%PDF-1.4 stub"));
    writeFileSync(join(root, "doc.docx"), Buffer.from("PK\x03\x04 stub"));
    writeFileSync(join(root, "a.ts"), "x");
    const files = collectFiles(root).map(f => f.replace(root, "")).sort();
    expect(files).toContain("/doc.pdf");
    expect(files).toContain("/doc.docx");
    expect(files).toContain("/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: 9 MB PDF accepted, 500 KB text rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    writeFileSync(join(root, "big.pdf"), Buffer.alloc(9_000_000));
    writeFileSync(join(root, "big.txt"), "x".repeat(500_000));
    const files = collectFiles(root).map(f => f.replace(root, "")).sort();
    expect(files).toContain("/big.pdf");
    expect(files.some(f => f.endsWith("big.txt"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: PDF over 10 MB cap is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    writeFileSync(join(root, "huge.pdf"), Buffer.alloc(10_000_000));
    expect(collectFiles(root).length).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectFiles: custom extension set is honored", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-rag-test-"));
  try {
    writeFileSync(join(root, "a.ts"), "x");
    writeFileSync(join(root, "b.cs"), "x");
    const files = collectFiles(root, new Set([".cs"]));
    expect(files.length).toBe(1);
    expect(files[0].endsWith("b.cs")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
