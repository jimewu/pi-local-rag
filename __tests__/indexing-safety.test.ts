/**
 * indexFiles data-safety test: when embedding fails (e.g. an HTTP backend
 * error), the previously indexed chunks must survive. Old chunks were
 * deleted during Phase 1 (read) before embedding ran — a failure then wiped
 * the whole index while files rows remained, leaving coverage reporting
 * "indexed" with 0 chunks. Deletions now happen inside the Phase 3
 * transaction, so a failed run leaves the previous index intact.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../embed.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embed.ts")>();
  return {
    ...actual,
    embedBatch: vi.fn().mockRejectedValue(new Error("simulated embed failure")),
  };
});

import { indexFiles } from "../indexing.ts";
import { getDbConn, closeDbConn, initSchema } from "../db.ts";
import { setRagDirGetter } from "../store.ts";
import * as repo from "../repository.ts";

describe("indexFiles preserves existing index when embedding fails", () => {
  let ragDir: string;
  let repoDir: string;

  beforeAll(() => {
    ragDir = mkdtempSync(join(tmpdir(), "rag-safety-"));
    repoDir = mkdtempSync(join(tmpdir(), "rag-safety-repo-"));
    setRagDirGetter(() => ragDir);
    closeDbConn();
    initSchema(getDbConn());
  });

  afterAll(() => {
    closeDbConn();
    setRagDirGetter(() => undefined);
    rmSync(ragDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("keeps old chunks when re-indexing fails during embedding", async () => {
    const db = getDbConn();
    const fp = join(repoDir, "doc.md");
    writeFileSync(fp, "# 標題\n\n內容段落一\n\n內容段落二");
    const now = new Date().toISOString();
    // Seed an existing index for this file (2 chunks, embedded).
    repo.upsertFile(db, fp, "oldhash", 2, now, 10, true);
    db.prepare(`
      INSERT INTO chunks(id, file_path, chunk_content, line_start, line_end, chunk_hash, indexed_at, tokens)
      VALUES ('c1', ?, 'chunk1', 1, 1, 'h1', ?, 5), ('c2', ?, 'chunk2', 3, 3, 'h2', ?, 5)
    `).run(fp, now, fp, now);
    expect(repo.countChunksTotal(db)).toBe(2);

    // Change the file so its hash no longer matches → not skipped → Phase 2
    // embed throws (mocked).
    writeFileSync(fp, "# 標題\n\n完全不同的內容。");

    await expect(indexFiles([fp], {}, db)).rejects.toThrow("simulated embed failure");
    // Old chunks must survive the failed re-index.
    expect(repo.countChunksTotal(db)).toBe(2);
    const file = repo.getFile(db, fp);
    expect(file?.embedded).toBe(1);
  });
});
