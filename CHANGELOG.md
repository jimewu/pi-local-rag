# Changelog

## 0.5.8

- **Tagger upgraded to Qwen3.5-2B** (unsloth GGUF, Q4_K_M) — much newer and
  smaller than Qwen2.5-3B with better extraction: concrete model numbers
  (e.g. MT-850) are now captured. Requires llama.cpp b10330+ (Qwen3.5
  architecture support; b10301 produced empty output for Qwen3.5).
- **llama.cpp upgraded b10301 → b10330** (Vulkan build; verified embedding +
  reranker behave identically). Old build kept at /usr/local/lib/llama.cpp.b10301.
- **`enable_thinking: false`** in the tag-extraction request — Qwen3.5's
  reasoning mode can emit only reasoning_content with an empty answer on
  llama.cpp; disabling it makes generation stable.
- Verified: 158 files re-tagged; metadata hits rank tagged files first
  (MT-850 → CERs, 審查意見 → review docs, 紅外線溫度計 → CIP).

## 0.5.7

- **`meta generate` (CLI + `/rag meta generate`)** — batch-tag every indexed
  file through a small local chat model (Qwen2.5-3B-Instruct via llama-swap's
  `/v1/chat/completions`; no frontier model needed). Classification-style
  prompt constrains output to `type, model, keywords…` which small models
  follow reliably; tags land in `.pi/rag-metadata.json` and are applied.
  `RAG_META_URL` / `RAG_META_MODEL` env override server + model. Verified on a
  158-file repo: tags generated in minutes, metadata hits rank tagged files
  first (e.g. querying 審查意見 surfaces the review documents).
- Qwen3.5-0.8B (with or without MTP) produces empty generation on the
  bundled llama.cpp (b10301) — architecture incompatibility; Qwen2.5-3B is
  used instead.

## 0.5.6.1 (security)

- **Scrubbed confidential case information from the entire git history**:
  product identifiers, real document paths, and machine-specific paths were
  replaced with generic placeholders across all commits (messages and file
  blobs). History rewritten and force-pushed; existing clones must be
  re-fetched/cloned.

## 0.5.6

- **Metadata seed (`rag-metadata.json`)** — a version-controlled source of
  truth for per-file tags at the repo root; keys are paths relative to the
  repo root (stable across relocations). Every index/rebuild/refresh/auto
  re-applies the seed automatically (`indexFiles` applies it on completion),
  and `/rag meta seed` / `bin/rag meta seed` apply it on demand. Entries
  whose path matches no indexed file are reported to stderr; files not
  listed keep their existing tags.
- Verified end-to-end on the real case repo through both entry points:
  `bin/rag meta seed` (CLI) and `/rag meta seed` (pi extension), plus the
  automatic path (cleared tags are restored by `bin/rag auto`).

## 0.5.5

- **File metadata (entity tags, 方式 3 / FTS column)** — per-file tags
  (product, doc type, related docs…) become a searchable FTS column:
  - schema v3: `files.metadata` + `chunks_fts.metadata`; migration rebuilds
    only the FTS table (vectors untouched, no re-embedding)
  - queries hitting a tag (e.g. `PROD-A`, a product name absent from file
    bodies) score every chunk of that file via BM25, and `hybridSearch`
    boosts tagged files' chunks — cross-file links without a graph database
  - `/rag meta` (pi) + `bin/rag meta` (CLI): list / set / show / clear tags;
    re-indexing never overwrites existing tags
- **BM25 normalization fix** — bm25() returns negative scores where smaller
  is better, but normalization inverted the ranking (best → 0, worst → 1),
  hidden until pure-BM25 hits (a metadata-only match) exposed it
- 4 new tests (schema v3, metadata-only BM25 hit, setFileMetadata
  propagation, upsert keeps tags); verified on the real case repo:
  “PROD-A” now surfaces the tagged evaluation/risk-questionnaire files first

## 0.5.4

- **Injection answering policy (three steps)** — the auto-injected RAG message
  now instructs the model to (1) answer from the injected context when it is
  sufficient; (2) otherwise run the `rag_query` tool for an active, targeted
  search — passive injection is a single best-effort lookup and often misses,
  while an active query usually finds the content; (3) only if an active RAG
  search still falls short, fall back to reading/grepping the repository files.
  README en/zh updated.

## 0.5.3

- **`bin/rag` CLI** — run without installing the extension: `cd <repo> && /path/to/pi-local-rag/bin/rag status|coverage|auto|mdsync|help` (Node ≥ 23.6 native TS). `--dir`/`--json` supported; `auto` streams live progress to stderr.
- **HTTP embedding/rerank backend** — `RAG_EMBED_URL`/`RAG_RERANK_URL` (e.g. llama-swap) route inference off the CPU; output is MRL-truncated to `RAG_EMBEDDING_DIM` and re-normalized; requests are batched by a char budget and over-long inputs truncated so a single chunk never exceeds the server's ctx/batch. `RAG_EMBED_MODEL`/`RAG_RERANK_MODEL` name the server-side models. No machine-specific info is baked into the repo (URLs come from env).
- **GPU backend deployment (reference)** — [`llama-swap`](https://github.com/mostlygeek/llama-swap) systemd service serving Qwen3-Embedding-4B + Qwen3-Reranker-4B GGUF on the AMD iGPU (Vulkan, ~2420 vs ~726 tokens/s CPU). A `swap: false` group keeps both resident while each **rotates independently** via its own idle `ttl` (ollama keep_alive semantics).
- **Latency: RAG auto-inject 12.6 s → 60 ms** — the injection lookup passes `{ rerank: false }` (hybrid BM25+vector already surfaces relevant chunks); `/rag search`/`rag_query` keep the cross-encoder for answer quality.
- **Store anchoring** — index/auto-complete always creates `.pi/rag/` under the repo root (never the global `~/.pi/rag/` fallback, never cwd when `--dir` differs); `/rag rebuild|refresh` anchor too.
- **`before_agent_start` hardening** — any RAG lookup/refresh error is swallowed (logged to stderr) so a failed lookup can never block the agent turn; the injected message now instructs the model to answer from the retrieved context when sufficient (no redundant repo re-reading).
- **Coverage robustness** — md-vs-index comparison matches by realpath (symlinked aliases) and by relative path from each side's lowest common directory (repo relocation no longer flips to 0%); rendering moved to a transcript entry (`appendEntry` + `registerEntryRenderer`).
- **Crash-safe indexing** — old chunks/vectors are deleted inside the Phase 3 transaction, so an embedding failure leaves the previous index intact (previously a failure wiped all chunks while files rows remained).
- **Embedding metadata** — `status`/DB record the real embedder (`activeEmbeddingModel()`: server-side model when HTTP, else local ONNX).
- **Testing**: 160 tests (159 passed + 1 skipped), incl. HTTP backend batching/MRL/rerank-alignment, embed-failure data safety, store anchoring, and command-handler behavior.

## 0.5.2

- **`/rag coverage --auto`** (and `rag_coverage(auto: true)`): when the report is not complete, auto-fixes gaps in priority order — write missing checksums (trusts existing md), convert documents via anydoc (OCR CLI fallback for scanned PDFs when `RAG_OCR_CLI`/`RAG_OCR_API` are set), then re-index everything (hash-skip makes the full walk cheap). `convertOneDocument` never throws; command runner injectable for tests. Verified live: 3 docs (xlsx/pdf/csv) converted + checksummed, verdict went `needs_convert → complete`.

## 0.5.1

- **`rag_coverage`** (`/rag coverage` + tool): one-command knowledge-base completeness report — markdown vs index (missing/modified), non-md document conversion state (md-sync), index health (vector coverage, 24 h staleness). Verdict priority: `needs_convert` > `needs_checksum` > `needs_index` > `stale` > `complete`. 5 new tests.

## 0.5.0 (jimewu fork)

- **Markdown-only knowledge base**: the index allowlist is markdown only (`.md`/`.markdown`). Non-md documents are no longer ingested directly; they are converted to markdown first via the `convert-documents-to-markdown` skill, with conversion state verified by the new md-sync scanner.
- **md-sync scanner** (`md-sync.ts`, `/rag mdsync`, `rag_md_sync` tool): for every non-md document, checks whether `A/B/B.md` (or the legacy `<stem>_ocr/<stem>.md` layout) exists and whether the recorded sha256 sidecar (`A/B/B.docx.sha256`) matches the live source. Reports `up_to_date` / `needs_convert` (`no_markdown` / `checksum_changed`) / `checksum_missing`. Symlinked duplicates (legacy `_ocr` folders) are collapsed by realpath.
- **Configurable multilingual embeddings**: `RAG_EMBEDDING_MODEL` (default `Xenova/bge-m3`, 1024-dim) + `RAG_EMBEDDING_DIM`. Embeddings drive `AutoTokenizer + AutoModel` directly (mean pooling + L2 normalize).
- **Sequence-length clamp** (`RAG_EMBED_MAX_LENGTH`, default 512): the feature-extraction pipeline ignores `max_length`, and bge-m3's 8192-position × batch 32 forward pass OOMs (~256 GB attention buffer). Clamping keeps peak RSS ~2 GB.
- **Optional cross-encoder reranker** (`RAG_RERANKER`, `RAG_RERANKER_MODEL` default `Xenova/bge-reranker-base`, `RAG_RERANK_TOP_K`): re-scores (query, parent-section) pairs and re-sorts. The text-classification pipeline cannot take `{text, text_pair}`, so the reranker also drives tokenizer + `AutoModelForSequenceClassification` directly.
- **Parent-child chunking**: markdown heading sections become parents (≤200 lines), paragraphs/lists/tables/code blocks become children; a child hit recalls the whole parent section. Heading lines never become children; `MIN_CHILD_CHARS` lowered to 10 for CJK.
- **FTS5 `tokenize=trigram`**: CJK 3-gram segmentation replaces the default `unicode61` (which treats a run of Chinese characters as a single token, silently breaking Chinese keyword search). Schema v2 migration drops/rebuilds the FTS and vector tables and marks files for re-embedding.
- **Fixes upstream's unfinished refactor**: `openDb`/`getDb`/`float32ToBuffer` no longer exist in `db.ts`; index.ts now uses the `getDbConn()` singleton, the `hybridSearch(query, limit, alpha, db)` signature, and re-exports `getFreshDbConn`/`initSchema`. Upstream main did not typecheck; this fork does.
- **`/rag status`** shows the embedding model and reranker state; `rag_query` returns the recalled parent section plus child line numbers and rerank score.
- **Testing**: 128 tests (127 passed + 1 skipped) incl. real bge-m3 ONNX suite, CJK trigram retrieval, parent recall, rerank scoring, and md-sync scanner.

## 0.4.1

- **Docs refresh**: README rewritten for 0.4.0 feature set — SQLite/FTS5/sqlite-vec storage, PDF/DOCX/HTML extraction, OCR fallback, per-project store, tracked paths + exclude patterns, 24 h auto-refresh, trailing-message auto-injection. Commands table expanded with `/rag find`, `/rag refresh`, `/rag rebuild --force`, `/rag exclude`, `/rag help`. Optional OCR install instructions (`brew install poppler tesseract tesseract-lang` / `apt install poppler-utils tesseract-ocr ...`). New "Testing" section noting `SKIP_EMBEDDING_TESTS` and the tesseract-absent OCR skip.
- **`package.json`**: description rewritten to mention SQLite + sqlite-vec + PDF/DOCX/HTML + OCR + per-project storage. Keywords += `sqlite`, `fts5`, `sqlite-vec`, `pdf`, `docx`, `ocr`.
- **`.gitignore`**: ignore `.pi/` so local RAG stores don't leak into commits.

## 0.4.0

- **SQLite storage** (replaces JSON): index now lives in a `rag.db` file using `better-sqlite3` + FTS5 virtual table for BM25 full-text search + `sqlite-vec` for vector similarity. Automatic one-shot migration from legacy `index.json` on first run, no data loss. WAL mode enabled for safe concurrent reads.
- **Per-project RAG store**: walks up from `process.cwd()` looking for `.pi/rag/`; falls back to `~/.pi/rag/` global store. First `/rag index` in a directory with no parent store creates one at cwd. Override with `$PI_RAG_DIR`.
- **Tracked paths + gitignore-style exclude patterns**: `trackedPaths` and `excludePatterns` in config; `/rag rebuild` re-walks tracked paths so new files are picked up automatically.
- **24h auto-refresh**: `before_agent_start` hook checks index age; re-indexes stale tracked paths in the background. `/rag refresh` command triggers manually. Configurable via `ragAutoRefresh`.
- **`/rag rebuild --force`**: wipes DB and re-embeds everything from scratch; fixes progress bar freezing during rebuild.
- **PDF + DOCX indexing**: `pdf-parse` for text PDFs, `mammoth` for DOCX files.
- **OCR fallback for image-only PDFs**: `pdftoppm` + `tesseract` pipeline for scanned documents (optional system deps).
- **HTML → Markdown via `turndown`** before chunking — cleaner chunks for web content.
- **`/rag find <glob>`**: list indexed files matching a glob pattern.
- **`/rag help`**: show all available subcommands.
- **`/rag` autocompletions**: working tab-completions for all subcommands.
- **Batched ONNX embeddings** (perf): `embedBatch()` now passes up to 64 texts per ONNX forward pass instead of 1-at-a-time (~64× fewer forward passes; ~219 passes for 13,955 chunks vs 13,955 previously).
- **Parallel file reads** (perf): Phase 1 of `indexFiles()` reads/chunks up to 32 files concurrently so I/O latency hides behind CPU work.
- **RAG context injected at end of prompt** (perf): avoids KV cache invalidation on models that support prefix caching.
- **Modular split**: `index.ts` refactored into 9 focused modules (`chunking.ts`, `embed.ts`, `indexing.ts`, `search.ts`, `store.ts`, `db.ts`, `config.ts`, `constants.ts`, `types/`).
- **104 tests** via vitest: covers chunking, math, BM25 search, SQLite storage round-trip, FTS5 triggers, vector normalization, PDF/DOCX/OCR extraction, per-project store resolution, 24h auto-refresh, and configurable extensions.
- **Fix**: tool definitions now include required `label` and `AgentToolResult.details` fields.
- **Fix**: silence `pdfjs` worker warnings in TUI.
- **Fix**: FTS5 query escaping for single quotes; split into individual terms.

## Unreleased

- **Configurable file extensions** (closes #9): expanded the default list to cover commonly-missing languages (`.cs`, `.tsx`, `.jsx`, `.kt`, `.swift`, `.rb`, `.php`, `.lua`, `.dart`, `.vue`, `.svelte`, `.scala`, `.scss`, `.tf`, `.hcl`, `.mdx`, …) and added `extraExtensions` / `excludeExtensions` to `RagConfig` plus a `/rag ext list|add|remove|reset` subcommand so users can extend the allowlist without forking. Includes 6 new tests for `normalizeExt` and `resolveExtensions`.
- **Test suite** (38 tests, no dev dependencies — uses `node --test` + `--experimental-strip-types`): covers cosine/normalize math, chunking, file collection against real tmp dirs, BM25 search ranking + phrase boost, storage I/O round-trip + legacy `~/.pi/lens` → `~/.pi/rag` migration, and live embedding/semantic-search against the real ONNX model. The model (`Xenova/all-MiniLM-L6-v2`, ~23 MB) is fetched from HuggingFace on the first run; set `SKIP_EMBEDDING_TESTS=1` to opt out in offline CI. Run with `npm test`.
- **Storage paths overridable via env**: `PI_RAG_DIR` and `PI_RAG_LEGACY_DIR` let the index live somewhere other than `~/.pi/rag` (useful for project-local indexes and isolated tests).

## 0.3.0

- **Renamed `/lens` → `/rag`**: all commands now use `/rag index|search|status|rebuild|clear|on|off`
- **Renamed tools**: `lens_index` → `rag_index`, `lens_query` → `rag_query`, `lens_status` → `rag_status`
- **Storage migrated**: index data moved from `~/.pi/lens/` to `~/.pi/rag/` — existing index is automatically migrated on first run, no data loss
- **`/rag on|off`**: simplified toggle (previously `/lens rag on|off`)
- **No file limit**: removed the 500-file cap — indexes all files in a directory
- **Live progress**: `setWidget` + `setStatus` updates during `/rag index` and `/rag rebuild`; stderr overwrite line for tool mode (`rag_index`)
- **Event loop yield**: `await setTimeout(0)` between files so the TUI can re-render and the agent doesn't appear hung

## 0.2.0

- **Hybrid RAG**: BM25 + local vector embeddings via `@xenova/transformers` (Transformers.js)
- **Auto-injection**: `before_agent_start` hook injects relevant chunks into every LLM prompt
- **Embedding model**: `Xenova/all-MiniLM-L6-v2` (384-dim, ~23MB, downloads once, runs fully offline)
- **Score transparency**: search results now show `bm25`, `vector`, and `hybrid` scores
- **`/lens rag on|off`**: toggle auto-injection at runtime *(renamed to `/rag on|off` in 0.3.0)*
- **`/lens status`**: now shows vector coverage % *(renamed to `/rag status` in 0.3.0)*
- **Config file**: `~/.pi/lens/config.json` for `ragEnabled`, `ragTopK`, `ragScoreThreshold`, `ragAlpha` *(moved to `~/.pi/rag/` in 0.3.0)*
- Bumped to `dependencies` for `@xenova/transformers`

## 0.1.0

- Initial release
- BM25 keyword search over local files
- Tools: `lens_index`, `lens_query`, `lens_status` *(renamed to `rag_*` in 0.3.0)*
- Commands: `/lens index|search|status|rebuild|clear|context` *(renamed to `/rag` in 0.3.0)*
