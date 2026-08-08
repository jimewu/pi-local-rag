/**
 * File metadata seed — a single source of truth for per-file entity tags.
 *
 * The seed lives at `<repo>/.pi/rag-metadata.json` — inside the pi project
 * config dir, next to the store, so it is not mixed into the repo's own
 * file listing and still travels with the case repo when it moves:
 *
 *   {
 *     "docs/product-evaluation.md": "PROD-A series clinical evaluation report",
 *     "docs/risk-questionnaire.md": "PROD-A series benefit-risk questionnaire"
 *   }
 *
 * Keys are paths relative to the repo root (stable across relocations);
 * values are the metadata tag string. Every index/rebuild/auto operation
 * applies the seed to the files it mentions (creating or updating their
 * tags); files not listed keep whatever tags they already have.
 *
 * JSON is used (instead of YAML) to keep the dependency footprint at zero.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import type Database from "better-sqlite3";
import { setFileMetadata, listFilePaths, listFiles } from "./repository.ts";

export const METADATA_SEED_FILE = "rag-metadata.json";

export function metadataSeedPath(root: string): string {
  // Inside .pi/ (the project config dir, sibling of .pi/rag/) — not the repo
  // root — so the seed stays out of the knowledge base's own files.
  return join(root, ".pi", METADATA_SEED_FILE);
}

/** Load the seed map, resolving every key against `root`. */
export function loadMetadataSeed(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const fp = metadataSeedPath(root);
  if (!existsSync(fp)) return out;
  try {
    const data = JSON.parse(readFileSync(fp, "utf-8")) as Record<string, unknown>;
    for (const [p, tags] of Object.entries(data)) {
      if (typeof tags !== "string" || !tags.trim()) continue;
      out.set(resolve(root, p), tags.trim());
    }
  } catch (e) {
    process.stderr.write(`[rag] failed to read metadata seed ${fp}: ${(e as Error).message}\n`);
  }
  return out;
}

/** Apply the seed to every indexed file it mentions. Files not listed are
 *  left untouched. Returns how many files got a tag set/updated. Entries
 *  whose path does not match an indexed file are reported to stderr so a
 *  typo in the seed is visible. */
export function applyMetadataSeed(db: Database.Database, root: string): number {
  const seed = loadMetadataSeed(root);
  if (seed.size === 0) return 0;
  const indexed = new Set(listFilePaths(db));
  let applied = 0;
  for (const [path, tags] of seed) {
    if (!indexed.has(path)) {
      process.stderr.write(`[rag] metadata seed: path not in index, skipped: ${path}\n`);
      continue;
    }
    setFileMetadata(db, path, tags);
    applied++;
  }
  return applied;
}

/** Write the seed map back to .pi/rag-metadata.json with repo-relative keys. */
export function saveMetadataSeed(root: string, seed: Map<string, string>): void {
  const rel: Record<string, string> = {};
  for (const [abs, tags] of seed) rel[relative(root, abs)] = tags;
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(metadataSeedPath(root), JSON.stringify(rel, null, 2) + "\n", "utf-8");
}

// ─── LLM tag generation (bin/rag meta generate / /rag meta generate) ───────
// A small local chat model (e.g. Qwen2.5-1.5B-Instruct via llama-swap's
// OpenAI-compatible /v1/chat/completions) reads each file's name + leading
// content and returns a short comma-separated tag list. Good enough for
// entity tagging — no frontier model needed.

export interface MetaGenerateOptions {
  /** Base URL of an OpenAI-compatible chat server (llama-swap). */
  llmUrl: string;
  /** Model name on that server (default qwen2.5-1.5b-tag). */
  model: string;
  /** Concurrent LLM requests (the server queues them; 2-4 is plenty). */
  concurrency?: number;
  /** How many chars of each file's content to send. */
  contentChars?: number;
  timeoutMs?: number;
}

function extractTagsPrompt(path: string, content: string): string {
  // Classification-style prompt: constrains the output to one comma-separated
  // line, which small local models follow far more reliably than free-form
  // extraction.
  return `你是文件歸檔助手。輸出格式必須嚴格是：文件類型, 產品型號, 主題關鍵詞1, 主題關鍵詞2, 主題關鍵詞3
- 文件類型：從 [CER, CEP, LSR, 審查意見, 回覆, 問卷, 臨床文獻, 操作手冊, 會議記錄, 其他] 中選一個
- 產品型號：從檔名或內容提取（如 MT-850、MT-16R1），沒有則寫「無」
- 主題關鍵詞：2-3 個與內容相關的詞
只輸出一行，逗號分隔，不要任何其他文字。

檔名: ${path}
內容: ${content.slice(0, 1500)}

輸出:`;
}

export async function extractTags(path: string, content: string, opts: MetaGenerateOptions): Promise<string | null> {
  const resp = await fetch(`${opts.llmUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: "user", content: extractTagsPrompt(path, content) }],
      max_tokens: 120,
      temperature: 0.2,
      // Qwen3.5 is a reasoning model; with thinking left on it can produce
      // only reasoning_content and an empty final answer on this llama.cpp.
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) return null;
  // Collect every non-empty line, strip leading field labels (「產品/型號:」),
  // numbering, and list markers, then join with commas.
  const parts = text.split(/\n/).map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^[^:：]{1,14}[:：]\s*/, ""))
    .map(l => l.replace(/^\d+[.、)）]\s*/, ""))
    .map(l => l.replace(/^[-*•]\s*/, ""))
    .filter(l => l.length > 0);
  return parts.join(", ").slice(0, 300);
}

/** Generate tags for every indexed file via the local LLM, merge into the
 *  existing seed, persist it, and apply. Existing tags are kept unless the
 *  file is regenerated. */
export async function generateMetadataSeed(
  db: Database.Database,
  root: string,
  opts: MetaGenerateOptions,
  onProgress?: (done: number, total: number, path: string) => void,
): Promise<{ generated: number; failed: Array<{ path: string; reason: string }> }> {
  const files = listFiles(db).filter(f => f.chunks > 0);
  if (files.length === 0) return { generated: 0, failed: [] };
  const seed = loadMetadataSeed(root);
  const failed: Array<{ path: string; reason: string }> = [];
  let done = 0;
  const queue = [...files];
  const concurrency = Math.min(opts.concurrency ?? 4, files.length);
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const f = queue.shift()!;
      const rel = relative(root, f.path);
      try {
        const content = readFileSync(f.path, "utf-8").slice(0, opts.contentChars ?? 2000);
        const tags = await extractTags(rel, content, opts);
        if (tags) seed.set(f.path, tags);
      } catch (e) {
        failed.push({ path: rel, reason: (e as Error).message });
      }
      done++;
      onProgress?.(done, files.length, rel);
    }
  });
  await Promise.all(workers);
  saveMetadataSeed(root, seed);
  const applied = applyMetadataSeed(db, root);
  return { generated: applied, failed };
}
