/**
 * CLI tests: argument parsing, output formatting, and JSON modes.
 * formatCoverage/parseArgs are pure; formatStatus/formatMdsync need a
 * scratch RAG store (pinned via setRagDirGetter).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, formatCoverage, formatStatus, type CliArgs } from "../cli.ts";
import { getDbConn, closeDbConn, initSchema } from "../db.ts";
import { setRagDirGetter } from "../store.ts";
import type { CoverageReport } from "../coverage.ts";

describe("parseArgs", () => {
  it("defaults to status", () => {
    expect(parseArgs([])).toEqual({ command: "status", dir: undefined, json: false, help: false, rest: [] });
  });

  it("parses command, --dir, --json, --help", () => {
    const args: CliArgs = parseArgs(["coverage", "--dir", "/tmp/x", "--json"]);
    expect(args.command).toBe("coverage");
    expect(args.dir).toBe("/tmp/x");
    expect(args.json).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["help"]).help).toBe(true);
    expect(parseArgs(["auto", "--dir=/tmp/y"]).dir).toBe("/tmp/y");
  });

  it("ignores unknown flags and keeps the first positional as command", () => {
    const args = parseArgs(["--verbose", "mdsync", "extra"]);
    expect(args.command).toBe("mdsync");
  });
});

function fakeReport(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return {
    root: "/repo",
    markdown: { total: 10, indexed: 7, missing: ["a.md", "b.md"], modified: [] },
    documents: { total: 5, needs_convert: 2, checksum_missing: 1, up_to_date: 2 },
    index: { chunks: 100, tokens: 5000, vectors: 100, vectorCoveragePct: 100, lastBuild: "2026-01-01T00:00:00.000Z", stale: false },
    verdict: "needs_convert",
    ...overrides,
  };
}

describe("formatCoverage", () => {
  it("renders a human-readable report (plain text when ANSI is stripped)", () => {
    const out = formatCoverage(fakeReport(), { json: false });
    // Strip ANSI codes for assertion simplicity.
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("🧭 RAG coverage");
    expect(plain).toContain("7/10 indexed");
    expect(plain).toContain("2 missing");
    expect(plain).toContain("2 needs convert");
    expect(plain).toContain("a.md");
  });

  it("emits JSON when --json is set", () => {
    const out = formatCoverage(fakeReport(), { json: true });
    const parsed = JSON.parse(out) as CoverageReport;
    expect(parsed.root).toBe("/repo");
    expect(parsed.verdict).toBe("needs_convert");
  });

  it("suggests auto-complete when files are missing", () => {
    const out = formatCoverage(fakeReport(), { json: false }).replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("pi-rag auto");
  });
});

describe("formatStatus", () => {
  let ragDir: string;
  beforeEach(() => {
    ragDir = mkdtempSync(join(tmpdir(), "rag-cli-"));
    setRagDirGetter(() => ragDir);
    closeDbConn();
    initSchema(getDbConn());
  });
  afterEach(() => {
    closeDbConn();
    setRagDirGetter(() => undefined);
    rmSync(ragDir, { recursive: true, force: true });
  });

  it("renders stats and config, works with an empty store", () => {
    const out = formatStatus({ json: false }).replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("🔍 pi-local-rag");
    expect(out).toContain("Files indexed:");
  });

  it("emits JSON with the same fields", () => {
    const parsed = JSON.parse(formatStatus({ json: true })) as { files: number; chunks: number; storageScope: string };
    expect(parsed.files).toBe(0);
    expect(parsed.chunks).toBe(0);
    expect(parsed.storageScope).toBe("project");
  });
});
