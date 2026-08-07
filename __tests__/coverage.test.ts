/**
 * Coverage report tests: md-vs-index comparison, document conversion state,
 * index freshness, and verdict priority.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";

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

import { computeCoverage, indexFiles } from "../index.ts";
import { closeDbConn } from "../db.ts";
import { initSchema } from "../index.ts";
import * as repo from "../repository.ts";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "rag-cov-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "a.md"), "# A\n\n量測裝置內容");
  writeFileSync(join(root, "docs", "b.md"), "# B\n\n審查委員會核准函內容");
  return root;
}

describe("computeCoverage", () => {
  let root: string;
  let db: Database.Database;
  beforeEach(() => {
    closeDbConn();
    root = makeRepo();
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    loadVec(db);
    initSchema(db);
  });
  afterEach(() => {
    closeDbConn();
    rmSync(root, { recursive: true, force: true });
  });

  it("verdict needs_index when md files are not indexed yet", async () => {
    const report = await computeCoverage(root, { db });
    expect(report.verdict).toBe("needs_index");
    expect(report.markdown.total).toBe(2);
    expect(report.markdown.missing.length).toBe(2);
  });

  it("verdict complete when everything is indexed and no docs to convert", async () => {
    await indexFiles([join(root, "docs", "a.md"), join(root, "docs", "b.md")], {}, db);
    const report = await computeCoverage(root, { db });
    expect(report.verdict).toBe("complete");
    expect(report.markdown.missing.length).toBe(0);
    expect(report.markdown.modified.length).toBe(0);
    expect(report.index.vectorCoveragePct).toBe(100);
  });

  it("verdict needs_index when a md file changed after indexing", async () => {
    await indexFiles([join(root, "docs", "a.md")], {}, db);
    writeFileSync(join(root, "docs", "a.md"), "# A CHANGED\n\n新的內容");
    const report = await computeCoverage(root, { db });
    expect(report.verdict).toBe("needs_index");
    expect(report.markdown.modified.length).toBe(1);
  });

  it("verdict needs_convert when a docx has no markdown", async () => {
    mkdirSync(join(root, "raw"), { recursive: true });
    writeFileSync(join(root, "raw", "report.docx"), "PK\x03\x04 stub");
    const report = await computeCoverage(root, { db });
    expect(report.documents.total).toBe(1);
    expect(report.documents.needs_convert).toBe(1);
    // needs_convert outranks needs_index
    expect(report.verdict).toBe("needs_convert");
  });

  it("verdict stale when last build is older than 24h", async () => {
    await indexFiles([join(root, "docs", "a.md"), join(root, "docs", "b.md")], {}, db);
    repo.setMetadata(db, repo.MetadataKey.LastBuild, new Date(Date.now() - 25 * 3600 * 1000).toISOString());
    const report = await computeCoverage(root, { db });
    expect(report.index.stale).toBe(true);
    expect(report.verdict).toBe("stale");
  });

  it("matches indexed files after the scan root is a symlink alias of the stored path", async () => {
    // Regression: index paths stored under a symlinked alias (e.g.
    // /home/user/Documents → /srv/data/Documents) must still be
    // recognized when coverage scans via the other alias — plain string
    // startsWith() comparison would report every file as missing.
    const realRoot = mkdtempSync(join(tmpdir(), "rag-cov-real-"));
    const alias = join(tmpdir(), `rag-cov-alias-${Date.now()}`);
    try {
      mkdirSync(join(realRoot, "docs"), { recursive: true });
      writeFileSync(join(realRoot, "docs", "a.md"), "# A\n\n量測裝置內容");
      symlinkSync(realRoot, alias, "dir");
      // Index via the real path — the DB stores real-path entries.
      await indexFiles([join(realRoot, "docs", "a.md")], {}, db);
      // Scan via the symlinked alias — must still match by realpath.
      const report = await computeCoverage(alias, { db });
      expect(report.markdown.missing.length).toBe(0);
      expect(report.markdown.modified.length).toBe(0);
      expect(report.verdict).not.toBe("needs_index");
    } finally {
      rmSync(alias, { recursive: true, force: true });
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it("still matches indexed files after the repo directory is relocated", async () => {
    // Regression: the DB stores absolute paths from where indexing ran; if
    // the whole case repo is moved, scanned paths differ on every level
    // except the path relative to the repo root. Matching by relative path
    // keeps the report from flipping to 0% indexed after a move.
    await indexFiles([join(root, "docs", "a.md"), join(root, "docs", "b.md")], {}, db);
    const moved = join(tmpdir(), `rag-cov-moved-${Date.now()}`);
    renameSync(root, moved);
    try {
      const report = await computeCoverage(moved, { db });
      expect(report.markdown.missing.length).toBe(0);
      expect(report.markdown.modified.length).toBe(0);
      expect(report.markdown.indexed).toBe(report.markdown.total);
      expect(report.verdict).not.toBe("needs_index");
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });
});
