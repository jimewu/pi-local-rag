/**
 * Markdown-sync scanner tests: conversion-state detection for non-md
 * documents (A/B.docx → A/B/B.md + A/B/B.docx.sha256).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn().mockResolvedValue(vi.fn()),
  AutoTokenizer: { from_pretrained: vi.fn() },
  AutoModel: { from_pretrained: vi.fn() },
  AutoModelForSequenceClassification: { from_pretrained: vi.fn() },
}));

import { mdTargetFor, sha256File, readChecksumFile, scanMarkdownSync } from "../index.ts";
import { collectFiles, DOC_CONVERT_EXTS } from "../index.ts";

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "rag-mdsync-"));
  const docx = join(root, "A", "B.docx");
  mkdirSync(join(root, "A"), { recursive: true });
  writeFileSync(docx, "PK\x03\x04 stub docx content");
  return { root, docx };
}

describe("mdTargetFor", () => {
  it("derives folder/md/checksum from the source document path", () => {
    const t = mdTargetFor("/repo/1_初審資料/5.1.xlsx");
    expect(t.folder).toBe("/repo/1_初審資料/5.1");
    expect(t.md).toBe("/repo/1_初審資料/5.1/5.1.md");
    expect(t.checksum).toBe("/repo/1_初審資料/5.1/5.1.xlsx.sha256");
  });
});

describe("readChecksumFile", () => {
  it("parses a bare hex hash", () => {
    const f = join(tmpdir(), "bare.sha256");
    writeFileSync(f, "a".repeat(64) + "\n");
    expect(readChecksumFile(f)).toBe("a".repeat(64));
  });
  it("parses sha256sum-style '<hash>  <file>' lines", () => {
    const f = join(tmpdir(), "sum.sha256");
    writeFileSync(f, `bbbb${"b".repeat(60)}  A/B.docx\n`);
    expect(readChecksumFile(f)).toBe("bbbb" + "b".repeat(60));
  });
  it("returns null for missing/unreadable files", () => {
    expect(readChecksumFile(join(tmpdir(), "nope.sha256"))).toBeNull();
  });
});

describe("scanMarkdownSync", () => {
  it("flags no_markdown when the converted md does not exist", async () => {
    const { root, docx } = makeTree();
    try {
      const report = await scanMarkdownSync([docx]);
      expect(report.needs_convert.length).toBe(1);
      expect(report.needs_convert[0].reason).toBe("no_markdown");
      expect(report.needs_convert[0].targetMd).toContain(`${basename(docx, ".docx")}/`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags checksum_missing when md exists but no sidecar", async () => {
    const { root, docx } = makeTree();
    try {
      const stem = docx.replace(/\.docx$/, "");
      mkdirSync(stem, { recursive: true });
      writeFileSync(join(stem, "B.md"), "# converted");
      const report = await scanMarkdownSync([docx]);
      expect(report.checksum_missing.length).toBe(1);
      expect(report.up_to_date.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("up_to_date when checksum matches", async () => {
    const { root, docx } = makeTree();
    try {
      const stem = docx.replace(/\.docx$/, "");
      mkdirSync(stem, { recursive: true });
      writeFileSync(join(stem, "B.md"), "# converted");
      const hash = await sha256File(docx);
      writeFileSync(join(stem, "B.docx.sha256"), hash + "  B.docx\n");
      const report = await scanMarkdownSync([docx]);
      expect(report.up_to_date.length).toBe(1);
      expect(report.needs_convert.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags checksum_changed when the source file was modified after conversion", async () => {
    const { root, docx } = makeTree();
    try {
      const stem = docx.replace(/\.docx$/, "");
      mkdirSync(stem, { recursive: true });
      writeFileSync(join(stem, "B.md"), "# converted");
      const hash = await sha256File(docx);
      writeFileSync(join(stem, "B.docx.sha256"), hash + "\n");
      // Modify the source after recording the checksum.
      writeFileSync(docx, "PK\x03\x04 NEW CONTENT");
      const report = await scanMarkdownSync([docx]);
      expect(report.needs_convert.length).toBe(1);
      expect(report.needs_convert[0].reason).toBe("checksum_changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collectFiles with DOC_CONVERT_EXTS finds the documents to convert", () => {
    const { root } = makeTree();
    try {
      writeFileSync(join(root, "A", "already.md"), "# md is not a document");
      const docs = collectFiles(root, DOC_CONVERT_EXTS).map(f => f.replace(root, ""));
      expect(docs).toContain("/A/B.docx");
      expect(docs).not.toContain("/A/already.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("legacy _ocr layout support", () => {
  it("recognizes the existing <stem>_ocr/<stem>.md layout via resolveMdTarget", async () => {
    const root = mkdtempSync(join(tmpdir(), "rag-mdsync-ocr-"));
    try {
      const ocrDir = join(root, "S.6_fever-screening_ocr");
      mkdirSync(ocrDir, { recursive: true });
      writeFileSync(join(ocrDir, "S.6_fever-screening.md"), "# OCR 產出");
      const pdf = join(root, "S.6_fever-screening.pdf");
      writeFileSync(pdf, "%PDF stub");
      const report = await scanMarkdownSync([pdf]);
      // md exists (legacy layout) but no checksum sidecar yet.
      expect(report.checksum_missing.length).toBe(1);
      expect(report.checksum_missing[0].targetMd).toContain("S.6_fever-screening_ocr");
      // After adding a matching sidecar it becomes up-to-date.
      const hash = await sha256File(pdf);
      writeFileSync(join(ocrDir, "S.6_fever-screening.pdf.sha256"), hash + "\n");
      const report2 = await scanMarkdownSync([pdf]);
      expect(report2.up_to_date.length).toBe(1);
      expect(report2.needs_convert.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collapses symlinked duplicates (legacy _ocr folders symlink the source)", async () => {
    const { root, docx } = makeTree();
    try {
      const stem = docx.replace(/\.docx$/, "");
      mkdirSync(stem, { recursive: true });
      writeFileSync(join(stem, "B.md"), "# converted");
      const hash = await sha256File(docx);
      writeFileSync(join(stem, "B.docx.sha256"), hash + "\n");
      // A symlink pointing back at the same source must not double-report.
      const { symlinkSync } = await import("node:fs");
      const link = join(root, "A", "B-link.docx");
      symlinkSync(docx, link);
      const report = await scanMarkdownSync([docx, link]);
      expect(report.up_to_date.length).toBe(1);
      expect(report.needs_convert.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
