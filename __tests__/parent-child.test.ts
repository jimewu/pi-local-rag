/**
 * Fork feature tests: parent-child chunking, CJK (trigram) retrieval, parent
 * recall, and rerank scoring. These lock in the behaviors added for the
 * Chinese OCR'd case-file workflow.
 *
 * The @xenova/transformers mock from index.test.ts does not apply here; this
 * file mocks it itself so hybridSearch can run without a real model download.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";

vi.mock("@xenova/transformers", () => {
  const DIM = 384;
  return {
    pipeline: vi.fn().mockResolvedValue(
      vi.fn().mockImplementation(async (texts: string | string[]) => {
        const batch = Array.isArray(texts) ? texts : [texts];
        const flat = new Float32Array(batch.length * DIM).fill(0.1);
        return { data: flat };
      })
    ),
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

import {
  chunkMarkdownParentChild,
  chunkForFile,
  chunkText,
  indexFiles,
  hybridSearch,
  rerank,
  isRerankerEnabled,
  initSchema,
  sha256,
} from "../index.ts";
import { closeDbConn } from "../db.ts";

function createTestDb(chunks: Array<{ content: string; parentId?: string | null }>): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  loadVec(db);
  initSchema(db);
  const insChunk = db.prepare(`
    INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    insChunk.run(
      `chunk-${i}`, "/src/案卷.md", c.content, i + 1, i + 1, sha256(c.content),
      "2026-01-01T00:00:00Z", Math.ceil(c.content.length / 4), c.parentId ?? null,
    );
  }
  return db;
}

describe("chunkMarkdownParentChild", () => {
  it("splits a markdown document into heading sections (parents) and paragraphs (children)", () => {
    const md = [
      "前言段落：本文件為 審查委員會送審資料。",
      "",
      "# 範例醫學中心人體試驗委員會",
      "",
      "## 研究計畫核准函",
      "",
      "計畫名稱：量測裝置演算法驗證。",
      "",
      "試驗機構：範例醫學中心。",
      "",
      "## 審查結論",
      "",
      "本計畫經審查通過。",
    ].join("\n");

    const doc = chunkMarkdownParentChild(md);
    // preamble (before first heading) + h1 + 2 h2 sections
    expect(doc.parents.length).toBe(4);
    expect(doc.parents[0].heading).toBeNull(); // preamble
    expect(doc.parents[0].content).toContain("審查委員會送審資料");
    expect(doc.parents[1].heading).toBe("範例醫學中心人體試驗委員會");
    expect(doc.parents[2].heading).toBe("研究計畫核准函");
    expect(doc.parents[3].heading).toBe("審查結論");
    // first section includes its heading line
    expect(doc.parents[1].content).toContain("# 範例醫學中心人體試驗委員會");
    // parent for the 核准函 section contains both its paragraphs
    expect(doc.parents[2].content).toContain("計畫名稱");
    expect(doc.parents[2].content).toContain("試驗機構");
    // children are the paragraphs, pointing at their parent
    const agreeChildren = doc.children.filter(c => c.parent === 2);
    expect(agreeChildren.length).toBe(2);
    expect(agreeChildren[0].content).toContain("計畫名稱");
    expect(agreeChildren[1].content).toContain("試驗機構");
  });

  it("keeps a fenced code block as a single child even with blank lines inside", () => {
    const md = [
      "## Code",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
    ].join("\n");
    const doc = chunkMarkdownParentChild(md);
    const children = doc.children.filter(c => c.parent === 0);
    expect(children.length).toBe(1);
    expect(children[0].content).toContain("const b = 2;");
  });

  it("treats a heading-only document as one section", () => {
    const doc = chunkMarkdownParentChild("## 只有標題\n");
    expect(doc.parents.length).toBe(1);
    expect(doc.parents[0].heading).toBe("只有標題");
  });

  it("falls back to flat chunking for non-markdown files", () => {
    const doc = chunkForFile("/src/app.ts", "line one\n\nline two\n\nline three");
    expect(doc.parents.length).toBe(0);
    expect(doc.children.length).toBe(chunkText("line one\n\nline two\n\nline three").length);
    for (const c of doc.children) expect(c.parent).toBeNull();
  });
});

describe("CJK retrieval (FTS5 trigram)", () => {
  it("finds a Chinese phrase in a child chunk", async () => {
    const db = createTestDb([
      { content: "針對臨床量測裝置及量測裝置在不同量測部位下演算法的驗證確效" },
      { content: "The device measures tympanic temperature via infrared sensor." },
    ]);
    const results = await hybridSearch("量測裝置", 5, 1.0, db); // pure BM25
    db.close();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain("量測裝置");
  });
});

describe("parent recall end-to-end", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rag-pc-")); });
  afterEach(() => {
    closeDbConn();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes parents+children and recalls the whole section on a child hit", async () => {
    const fp = join(dir, "review.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(fp, [
      "# 範例醫學中心人體試驗委員會",
      "",
      "## 研究計畫核准函",
      "",
      "計畫名稱：量測裝置演算法驗證確效。",
      "",
      "## 審查結論",
      "",
      "本計畫經審查通過。",
    ].join("\n"));

    // Point the singleton at this temp dir.
    const { setRagDirGetter } = await import("../store.ts");
    setRagDirGetter(() => dir);

    const res = await indexFiles([fp], {});
    expect(res.indexed).toBe(1);

    // alpha=1.0 → pure BM25 so ordering is deterministic under the mocked
    // (constant-vector) embedding used by the unit suite.
    const results = await hybridSearch("量測裝置 演算法", 5, 1.0);
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    // The child that matched belongs to the 核准函 section…
    expect(top.parent).not.toBeNull();
    expect(top.parent!.heading).toBe("研究計畫核准函");
    // …and the recalled parent is the WHOLE section, not just the child.
    expect(top.parent!.content).toContain("## 研究計畫核准函");
    expect(top.parent!.content).toContain("計畫名稱");
  });
});

describe("rerank", () => {
  it("is disabled via env in the mock suite (vitest.config)", () => {
    expect(isRerankerEnabled()).toBe(false);
  });

  it("scores pairs through an injected scorer and clamps to 0..1", async () => {
    const scores = await rerank(
      "量測裝置",
      ["計畫名稱：量測裝置演算法", "審查結論：無"],
      async pairs => {
        expect(pairs).toHaveLength(2);
        expect(pairs[0].text).toBe("量測裝置");
        expect(pairs[0].text_pair).toContain("量測裝置");
        return [{ score: 0.9 }, { score: -2 }];
      },
    );
    expect(scores).toEqual([0.9, 0]);
  });

  it("returns null when disabled", async () => {
    const scores = await rerank("q", ["p1"]);
    expect(scores).toBeNull();
  });
});
