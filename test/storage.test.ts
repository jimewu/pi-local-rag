import { test, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Storage paths are read at module load. Set the env BEFORE the dynamic import
// so loadIndex / saveIndex / loadConfig / saveConfig point at a throwaway dir.
const ragDir = mkdtempSync(join(tmpdir(), "pi-rag-storage-"));
const legacyDir = mkdtempSync(join(tmpdir(), "pi-lens-legacy-"));
process.env.PI_RAG_DIR = ragDir;
process.env.PI_RAG_LEGACY_DIR = legacyDir;

// rmSync the placeholder dirs so we can exercise the "create on first use" + migration code paths.
rmSync(ragDir, { recursive: true, force: true });
rmSync(legacyDir, { recursive: true, force: true });

const mod = await import("../index.ts");
const { loadConfig, saveConfig, loadIndex, saveIndex } = mod;

afterAll(() => {
  rmSync(ragDir, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
});

test("loadConfig: returns defaults when no config file exists", () => {
  const cfg = loadConfig();
  expect(cfg.ragEnabled).toBe(true);
  expect(cfg.ragTopK).toBe(5);
  expect(cfg.ragScoreThreshold).toBe(0.1);
  expect(cfg.ragAlpha).toBe(0.4);
  expect(cfg.extraExtensions).toEqual([]);
  expect(cfg.excludeExtensions).toEqual([]);
  expect(cfg.trackedPaths).toEqual([]);
  expect(cfg.excludePatterns).toEqual([]);
});

test("saveConfig / loadConfig round-trip persists every field", () => {
  const written = {
    ragEnabled: false,
    ragTopK: 12,
    ragScoreThreshold: 0.25,
    ragAlpha: 0.7,
    extraExtensions: [".cs", ".tex"],
    excludeExtensions: [".md"],
    trackedPaths: ["/tmp/proj-a", "/tmp/proj-b"],
    excludePatterns: ["*.log", "node_modules/"],
  };
  saveConfig(written);
  const read = loadConfig();
  expect(read).toEqual(written);

  expect(existsSync(join(ragDir, "config.json"))).toBe(true);
  const raw = JSON.parse(readFileSync(join(ragDir, "config.json"), "utf-8"));
  expect(raw).toEqual(written);
});

test("loadConfig: merges saved partial config over defaults", () => {
  mkdirSync(ragDir, { recursive: true });
  writeFileSync(join(ragDir, "config.json"), JSON.stringify({ ragTopK: 99 }));
  const cfg = loadConfig();
  expect(cfg.ragTopK).toBe(99);
  expect(cfg.ragEnabled, "missing fields should fall back to defaults").toBe(true);
  expect(cfg.ragAlpha, "missing fields should fall back to defaults").toBe(0.4);
});

test("loadConfig: malformed JSON falls back to defaults instead of throwing", () => {
  writeFileSync(join(ragDir, "config.json"), "{not valid json");
  const cfg = loadConfig();
  expect(cfg.ragEnabled).toBe(true);
  expect(cfg.ragTopK).toBe(5);
});

test("loadIndex: empty/missing index returns an empty IndexMeta shell", () => {
  rmSync(join(ragDir, "index.json"), { force: true });
  const idx = loadIndex();
  expect(idx.chunks).toEqual([]);
  expect(idx.files).toEqual({});
  expect(idx.lastBuild).toBe("");
});

test("saveIndex / loadIndex: round-trip preserves chunks, files map, lastBuild and model", () => {
  const written = {
    chunks: [{
      id: "abc-1",
      file: "/some/file.ts",
      content: "export const x = 1;",
      lineStart: 1,
      lineEnd: 1,
      hash: "deadbeef",
      indexed: "2026-05-15T00:00:00Z",
      tokens: 6,
      vector: [0.1, 0.2, 0.3],
    }],
    files: { "/some/file.ts": { hash: "deadbeef", chunks: 1, indexed: "2026-05-15T00:00:00Z", size: 19, embedded: true } },
    lastBuild: "2026-05-15T00:00:00Z",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
  };
  saveIndex(written);
  const read = loadIndex();
  expect(read).toEqual(written);
});

test("loadIndex: corrupt index.json is treated as empty (no crash)", () => {
  writeFileSync(join(ragDir, "index.json"), "}}}not json{{{");
  const idx = loadIndex();
  expect(idx.chunks).toEqual([]);
  expect(idx.files).toEqual({});
});

test("loadIndex: tolerates partial shapes (missing files or chunks key)", () => {
  writeFileSync(join(ragDir, "index.json"), JSON.stringify({ chunks: "not an array", files: null }));
  const idx = loadIndex();
  expect(idx.chunks, "non-array chunks should become []").toEqual([]);
  expect(idx.files, "null files should become {}").toEqual({});
});

test("ensureDir migration: legacy ~/.pi/lens → ~/.pi/rag is renamed on first use", () => {
  rmSync(ragDir, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "index.json"), JSON.stringify({
    chunks: [], files: {}, lastBuild: "from-legacy",
  }));

  const idx = loadIndex();
  expect(idx.lastBuild, "data from legacy dir should be picked up after rename").toBe("from-legacy");
  expect(existsSync(ragDir), "rag dir should now exist").toBe(true);
  expect(existsSync(legacyDir), "legacy dir should be gone (renamed)").toBe(false);
});
