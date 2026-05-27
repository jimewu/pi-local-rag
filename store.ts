import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Storage paths — overridable via env for tests / project-local indexes.
export const RAG_DIR = process.env.PI_RAG_DIR ?? join(homedir(), ".pi", "rag");
export const LEGACY_DIR = process.env.PI_RAG_LEGACY_DIR ?? join(homedir(), ".pi", "lens");
export const INDEX_FILE = join(RAG_DIR, "index.json");
export const CONFIG_FILE = join(RAG_DIR, "config.json");

export function ensureDir() {
  if (!existsSync(RAG_DIR)) {
    // Migrate legacy .pi/lens directory to .pi/rag on first run
    if (existsSync(LEGACY_DIR)) {
      try {
        renameSync(LEGACY_DIR, RAG_DIR);
      } catch {
        mkdirSync(RAG_DIR, { recursive: true });
      }
    } else {
      mkdirSync(RAG_DIR, { recursive: true });
    }
  }
}
