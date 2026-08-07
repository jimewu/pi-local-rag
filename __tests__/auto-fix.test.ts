/**
 * Auto-complete coverage tests: --auto fixes index gaps, writes checksums,
 * and converts documents via an injected command runner (no real npx/OCR).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

vi.mock("@xenova/transformers", () => {
  const DIM = 384;
  return {
    pipeline: vi.fn().mockResolvedValue(vi.fn()),
    AutoTokenizer: {
      from_pretrained: vi.fn().mockResolvedValue(
        vi.fn().mockImplementation((texts: string | string[]) => {
          const batch = Array.isArray(texts) ? texts : [texts];
          return {
            input_ids: { dims: [batch.length, 1], data: new Float32Array(batch.length).fill(1) },
            attention_mask: { data: new Float32Array(batch.length).fill(1) },
          };
        })
      ),
    },
    AutoModel: {
      from_pretrained: vi.fn().mockResolvedValue(
        vi.fn().mockImplementation(async (inputs: any) => {
          const batch = inputs.input_ids?.dims?.[0] ?? 1;
          return { last_hidden_state: { dims: [batch, 1, DIM], data: new Float32Array(batch * DIM).fill(0.1) } };
        })
      ),
    },
    AutoModelForSequenceClassification: { from_pretrained: vi.fn() },
  };
});

import { autoCompleteCoverage, convertOneDocument } from "../index.ts";
import type { CmdRunner } from "../auto-fix.ts";
import { closeDbConn } from "../db.ts";
import { mdTargetFor, readChecksumFile } from "../index.ts";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "rag-auto-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "# A\n\n內容段落");
  return root;
}

/** Fake runner that "converts" by writing the md + succeeds. */
function fakeAnydocRunner(fs: { root: string }): CmdRunner {
  return vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === "npx" || cmd === "anydoc") {
      const src = args.find(a => a.endsWith(".docx") || a.endsWith(".pdf") || a.endsWith(".csv"));
      const outIdx = args.indexOf("-o");
      const out = args[outIdx + 1];
      if (src && out) {
        mkdirSync(out.split("/").slice(0, -1).join("/"), { recursive: true });
        writeFileSync(out, `# converted from ${basename(src)}\n\n內容。`);
        return { ok: true, stderr: "" };
      }
    }
    return { ok: false, stderr: "anydoc: unsupported" };
  });
}

describe("convertOneDocument", () => {
  let root: string;
  beforeEach(() => { root = makeRepo(); });
  afterEach(() => { closeDbConn(); rmSync(root, { recursive: true, force: true }); });

  it("converts via anydoc and writes the checksum sidecar", async () => {
    const docx = join(root, "docs", "report.docx");
    writeFileSync(docx, "PK\x03\x04 stub");
    const r = await convertOneDocument(docx, { runner: fakeAnydocRunner({ root }) });
    expect(r.ok).toBe(true);
    expect(r.tool).toBe("anydoc");
    const t = mdTargetFor(docx);
    expect(existsSync(t.md)).toBe(true);
    expect(readChecksumFile(t.checksum)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to OCR CLI when anydoc reports OCR required", async () => {
    const pdf = join(root, "docs", "scan.pdf");
    writeFileSync(pdf, "%PDF scanned stub");
    const runner: CmdRunner = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "npx") return { ok: false, stderr: "anydoc: unsupported input: Scanned, OCR is required" };
      if (cmd === "/fake/ocr") {
        const src = args[args.length - 1];
        const t = mdTargetFor(src);
        mkdirSync(t.folder, { recursive: true });
        writeFileSync(t.md, `# OCR 產出\n`);
        return { ok: true, stderr: "1/1 succeeded" };
      }
      return { ok: false, stderr: "?" };
    });
    const r = await convertOneDocument(pdf, { runner, ocrCli: "/fake/ocr", ocrApi: "http://x" });
    expect(r.ok).toBe(true);
    expect(r.tool).toBe("ocr");
    expect(runner).toHaveBeenCalledWith("/fake/ocr", ["--api", "http://x", pdf]);
    const t = mdTargetFor(pdf);
    expect(existsSync(t.md)).toBe(true);
  });

  it("reports skipped-OCR when no OCR CLI is configured", async () => {
    const pdf = join(root, "docs", "scan.pdf");
    writeFileSync(pdf, "%PDF scanned stub");
    const runner: CmdRunner = vi.fn().mockResolvedValue({ ok: false, stderr: "OCR is required" });
    const r = await convertOneDocument(pdf, { runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("RAG_OCR_CLI");
  });
});

describe("autoCompleteCoverage", () => {
  let root: string;
  beforeEach(() => { root = makeRepo(); });
  afterEach(() => { closeDbConn(); rmSync(root, { recursive: true, force: true }); });

  it("indexes missing markdown and writes missing checksums", async () => {
    const docx = join(root, "docs", "r.docx");
    writeFileSync(docx, "PK stub");
    const stem = docx.replace(/\.docx$/, "");
    mkdirSync(stem, { recursive: true });
    writeFileSync(join(stem, "r.md"), "# R\n\n已轉檔。");

    const outcome = await autoCompleteCoverage(root, {
      runner: fakeAnydocRunner({ root }),
    });
    // missing md got indexed
    expect(outcome.actions.indexed.length).toBeGreaterThan(0);
    // docx has md but no sidecar → checksum written
    expect(outcome.actions.checksummed).toContain(docx);
    expect(outcome.after.markdown.missing.length).toBe(0);
  });

  it("converts documents and reaches complete", async () => {
    const docx = join(root, "docs", "new.docx");
    writeFileSync(docx, "PK\x03\x04 new doc");
    const outcome = await autoCompleteCoverage(root, {
      runner: fakeAnydocRunner({ root }),
    });
    expect(outcome.actions.converted.length).toBe(1);
    expect(outcome.actions.converted[0].tool).toBe("anydoc");
    expect(outcome.after.verdict).toBe("complete");
  });

  it("streams progress updates via the onProgress callback", async () => {
    const docx = join(root, "docs", "r.docx");
    writeFileSync(docx, "PK stub");
    const stem = docx.replace(/\.docx$/, "");
    mkdirSync(stem, { recursive: true });
    writeFileSync(join(stem, "r.md"), "# R\n\n已轉檔。");

    const msgs: string[] = [];
    await autoCompleteCoverage(root, { runner: fakeAnydocRunner({ root }) }, (m) => msgs.push(m));
    expect(msgs.length).toBeGreaterThan(0);
    // Progress covers at least one of the long-running phases (checksum,
    // conversion, indexing, embedding).
    expect(msgs.some(m => /^(checksum|convert|indexing|embedding)/.test(m))).toBe(true);
  });
});
