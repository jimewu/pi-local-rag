# pi-local-rag (jimewu fork)

[English](README.md) · [繁體中文](README_zh.md)

> **Agent-assisted fork** — this fork was developed with the assistance of an AI coding agent (pi) under the maintainer's direction.

Local hybrid RAG pipeline for the [Pi coding agent](https://github.com/badlogic/pi-mono), **scoped to case-file knowledge bases** (e.g. regulatory compliance submissions). Indexes **markdown only**; every non-md document is first converted to markdown (via the `convert-documents-to-markdown` skill), then verified by a checksum-aware sync scanner. Zero cloud dependency, works fully offline.

> Fork of [vahidkowsari/pi-local-rag](https://github.com/vahidkowsari/pi-local-rag).
> Upstream's unfinished refactor (broken `openDb` imports) is fixed here; the embedding pipeline is rewritten for large multilingual models.

## Features

- **Hybrid BM25 + vector search** — SQLite FTS5 (`tokenize=trigram`, so Chinese keyword search works — `unicode61` treats a CJK run as one token) + [`sqlite-vec`](https://github.com/asg017/sqlite-vec) cosine NN, blended at retrieval time
- **Configurable multilingual embeddings** — default `Xenova/bge-m3` (1024-dim, strong zh/en); swap via env vars
- **Optional cross-encoder reranker** — default `Xenova/bge-reranker-base`; re-sorts hybrid candidates by (query, section) relevance; disable with `RAG_RERANKER=false`
- **Parent-child chunking for markdown** — parent = one heading section (≤200 lines), child = paragraph/list/table/code block; a child hit recalls the **whole section** so answers are never taken out of context
- **Markdown-only index** — the extension never ingests docx/pdf/xlsx/csv directly; it reports conversion state instead (see md-sync below)
- **md-sync scanner** — `A/B.docx` → `A/B/B.md` + `A/B/B.docx.sha256`; recognizes the legacy `<stem>_ocr/<stem>.md` layout; flags `no_markdown` / `checksum_changed` / `checksum_missing`, collapses symlinked duplicates
- **Per-project storage** — walks up from cwd looking for `.pi/rag/`; falls back to `~/.pi/rag/` global store. Store creation during index/auto-complete is always anchored at the repo root — a deleted `.pi/rag/` is recreated inside the repo, never silently redirected to the global store
- **Auto-refresh** — stale index (>24 h) silently refreshed before the next agent turn; manual `/rag refresh` for on-demand incremental updates
- **Auto-injection** — relevant parent sections appended after the user prompt before every agent turn (KV-cache friendly), with a three-step answering policy: (1) answer from the injected context when sufficient; (2) otherwise run the `rag_query` tool for an active, targeted search; (3) only then fall back to reading/grepping repo files
- **GPU inference backend (optional)** — route embedding + reranking to a local [`llama-swap`](https://github.com/mostlygeek/llama-swap) server (Qwen3 GGUF on the AMD iGPU via Vulkan, ~3.3× CPU throughput) via `RAG_EMBED_URL` / `RAG_RERANK_URL`; models stay resident side-by-side and each **rotates independently** (unloaded after its own idle `ttl`, exactly like ollama keep_alive)
- **Matryoshka (MRL) truncation** — HTTP backend outputs are truncated to `RAG_EMBEDDING_DIM` and re-normalized; Qwen3-Embedding-4B at 1024 dims keeps ≥97% retrieval quality vs full 2560
- **File metadata tags** — per-file entity tags (product, doc type, related docs…) stored as an FTS column; a query hitting a tag (e.g. a product name) scores the whole file's chunks, so cross-file links surface without a graph database. Set via `/rag meta <path> <tags>` or `bin/rag meta`
- **4 AI tools** — `rag_index`, `rag_query`, `rag_status`, `rag_md_sync` (+ `rag_coverage`)

## GPU inference backend (llama-swap)

Embedding and reranking can run on the local GPU instead of the CPU ONNX
pipeline. The reference setup serves **Qwen3-Embedding-4B** and
**Qwen3-Reranker-4B** (GGUF, MTEB multilingual top-tier, Chinese included)
through [`llama-swap`](https://github.com/mostlygeek/llama-swap) as a systemd
service:

```yaml
# /opt/llama-swap/config.yaml (excerpt)
models:
  qwen3-embedding-4b:
    cmd: |
      llama-server --model /opt/models/qwen3-embedding-4b/Qwen3-Embedding-4B-Q5_K_M.gguf
        --embeddings --pooling mean --ctx-size 16384 --batch-size 16384 --ubatch-size 16384
        --n-gpu-layers 99 --port ${PORT}
    ttl: 600          # idle 10 min → this model unloads, independently
  qwen3-reranker-4b:
    cmd: |
      llama-server --model /opt/models/qwen3-reranker-4b/Qwen3-Reranker-4B-Q5_K_M.gguf
        --reranking --ctx-size 32768 --batch-size 16384 --ubatch-size 16384
        --n-gpu-layers 99 --port ${PORT}
    ttl: 600
    reranker: true
routing:
  router:
    use: group
    settings:
      groups:
        "rag-models":
          swap: false      # embedding + reranker stay loaded together
          exclusive: false
          members: [qwen3-embedding-4b, qwen3-reranker-4b]
```

**Rotation semantics**: each model unloads after its own `ttl` of inactivity —
independent of the other. The `swap: false` group only stops llama-swap's
*default* behavior of evicting one model to load another (which cost a
~2.3 s reload per lookup); it does not disable the per-model idle unload.
The env vars go in `~/.profile` (sourced by `~/.zshrc`):

```bash
export RAG_EMBED_URL=http://127.0.0.1:18080
# optionally override the server-side model names:
# export RAG_EMBED_MODEL=qwen3-embedding-4b
# export RAG_RERANK_MODEL=qwen3-reranker-4b
```

**Measured performance** (Qwen3-Embedding-4B Q5_K_M, Ryzen AI MAX+ 395):

| | tokens/s |
|---|---|
| GPU (Vulkan iGPU) | ~2420 |
| CPU (32 threads) | ~726 |

RAG auto-injection lookup runs **without** the reranker (`{ rerank: false }`)
— hybrid BM25+vector already surfaces the relevant chunks, so an injection
lookup is ~60 ms hot. `/rag search` and `rag_query` keep the reranker for
answer quality (the cross-encoder costs ~0.65 s per candidate on the local
GPU, so it is only worth it for interactive search, not per-turn injection).

## Install

```bash
# temporary, per-session (recommended — keeps the fork out of your global config)
pi -e /path/to/pi-local-rag

# or install permanently
pi install /path/to/pi-local-rag
```

Note: pi 0.83 does not load `.tgz` or `git:` package URLs directly; use a directory path (this repo, which has `node_modules` installed).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `RAG_EMBEDDING_MODEL` | `Xenova/bge-m3` | Embedding model (any Transformers.js-compatible model) |
| `RAG_EMBEDDING_DIM` | `1024` | Vector dimension in sqlite-vec; must match the model |
| `RAG_EMBED_MAX_LENGTH` | `512` | Clamp tokenizer sequence length (bge-m3's 8192 max × batch OOMs; paragraphs are short) |
| `RAG_EMBED_BATCH_SIZE` | `32` | ONNX batch size; lower to 8 on memory-constrained machines |
| `RAG_RERANKER` | `true` | Set `false` to disable reranking |
| `RAG_RERANKER_MODEL` | `Xenova/bge-reranker-base` | Cross-encoder reranker |
| `RAG_RERANK_TOP_K` | `20` | Hybrid candidates sent to the reranker |
| `PI_RAG_DIR` | — | Explicit store location (wins over walk-up) |
| `RAG_EMBED_URL` | — | Base URL of an external embedding server (llama-swap / any OpenAI-compatible, e.g. `http://127.0.0.1:18080`). When set, embedding routes over HTTP; output is MRL-truncated to `RAG_EMBEDDING_DIM` and re-normalized. Unset → local ONNX (Transformers.js) |
| `RAG_RERANK_URL` | — | Base URL of an external rerank server (`POST /v1/rerank`, e.g. llama-swap). Unset → local ONNX reranker |
| `RAG_EMBED_MODEL` | `qwen3-embedding-4b` | Model name to request on the embedding server |
| `RAG_RERANK_MODEL` | `qwen3-reranker-4b` | Model name to request on the rerank server |

Models download once from HuggingFace on first use and are cached locally.

## File metadata (entity tags)

A case repo's knowledge points are usually linked — product ↔ documents ↔ review
opinions ↔ responses. Instead of a graph database, per-file **metadata tags** are
stored in the FTS index (schema v3, `files.metadata` + `chunks_fts.metadata`):

```bash
/rag meta "docs/product-evaluation.md" "PROD-A series clinical evaluation report"
/rag meta list          # all tagged files
/rag meta <path>        # show one file's tags
/rag meta -d <path>     # clear
/rag meta seed          # apply the seed file (rag-metadata.json) to the index
```

How it works (方式 3): the tags become an FTS column, so a query hitting a tag
(e.g. `PROD-A` — a product name that never appears in the file bodies) scores
every chunk of that file via BM25, and `hybridSearch` boosts the tagged files' chunks. This makes cross-file lookups like “everything about product PROD-A”
work with zero graph infrastructure. Re-indexing keeps existing tags (the
`ON CONFLICT` upsert never overwrites `metadata`).

### Metadata seed (`rag-metadata.json`)

For maintenance (and so tags survive a rebuild), keep the tags in a seed file
at `<repo>/.pi/rag-metadata.json` — inside the pi project config dir, so it
travels with the case repo and stays out of the knowledge base's own files:

```json
{
  "docs/product-evaluation.md": "PROD-A series clinical evaluation report",
  "docs/review-questions.md": "PROD-A series review questions"
}
```

Keys are paths **relative to the repo root** (stable across relocations); the file lives in `.pi/`; paths
must match the indexed files exactly (including directory levels). Every
`/rag index` / `rebuild` / `refresh` / `auto` run re-applies the seed
automatically (`indexFiles` applies it on completion), and `/rag meta seed`
(or `bin/rag meta seed`) applies it on demand. Entries whose path does not
match an indexed file are reported to stderr. Files not listed in the seed keep
their existing tags.

## Workflow: convert → sync → index

```bash
cd <case-repo>
pi -e /path/to/pi-local-rag

/rag exclude regulations/           # keep regulation sources out (use a regulation skill instead)
/rag coverage                     # is the knowledge base complete? (one glance)
/rag coverage --auto               # …or auto-fix gaps: index, checksums, convert
#   → 76 need conversion / 27 checksum missing / … up to date
#   → agent converts each missing document with the
#     convert-documents-to-markdown skill (anydoc / batch-ocr):
#       A/B.docx → A/B/B.md, then write A/B/B.docx.sha256
/rag mdsync                       # re-check: should now be up to date
/rag index .                      # index the markdown (chunks → embeds → stores)
/rag search 產品規格 演算法         # hybrid search, returns whole sections
```

## CLI (`bin/rag`)

A command-line companion that inspects and completes the knowledge base
**without starting a pi session** — and **without installing the extension**
(the executable lives in this repo):

```bash
cd /path/to/case-repo
/path/to/pi-local-rag/bin/rag status    # index statistics + config
/path/to/pi-local-rag/bin/rag coverage  # completeness report
/path/to/pi-local-rag/bin/rag auto      # auto-complete: checksums → convert → index
/path/to/pi-local-rag/bin/rag mdsync    # document conversion state
/path/to/pi-local-rag/bin/rag help
```

- Run it from the case repo directory (the RAG store is resolved by walking
  up for `.pi/rag`), or pass `--dir <path>` explicitly.
- `--json` — machine-readable output for scripts.
- Progress (convert/index/embed) streams to stderr so you always see what
  is happening; long auto-completes finish with a summary and an
  “open pi and start talking” cue.
- Requires **Node ≥ 23.6** (native TypeScript type stripping).

If you ever `pi install` this package, the same CLI is also linked as `rag`.

Example workflow before a session:

```bash
cd /path/to/case-repo
RAG=/path/to/pi-local-rag/bin/rag
$RAG coverage        # see what's missing
$RAG auto            # fix it (may take minutes; progress shown)
pi                    # then start the session
```

## Commands

| Command | Description |
|---|---|
| `/rag index <path>` | Index markdown under a path (chunks → embeds → stores) |
| `/rag mdsync [path]` | Scan non-md documents for markdown conversion state (checksum check) |
| `/rag meta [path] [tags…]` | Set/list per-file entity metadata (product, doc type, related docs…); tags are searched via the FTS metadata column. `list` (default), `<path> <tags>` to set, `<path>` to show, `-d <path>` to clear |
| `/rag coverage [path]` | Completeness report: indexed md vs disk, document conversion state, index health |
| `/rag coverage --auto` | Auto-fix gaps in priority order: write missing checksums, convert documents (anydoc; OCR via `RAG_OCR_CLI`), re-index |
| `/rag search <query>` | Hybrid BM25 + vector search (returns recalled parent sections) |
| `/rag find <glob>` | List indexed files matching a glob |
| `/rag status` | Index stats, embedding model, reranker state, config, storage |
| `/rag rebuild [--force]` | Re-walk tracked paths and re-embed all files |
| `/rag refresh` | Incremental refresh — only new/changed files (also runs every 24 h) |
| `/rag clear` | Wipe the entire index (tracked paths are preserved) |
| `/rag exclude <pattern>` | Add a gitignore-style exclude pattern |
| `/rag ext list \| add <.ext> \| remove <.ext> \| reset` | Manage the indexable extension allowlist (markdown by default) |
| `/rag on` \| `off` | Toggle auto-injection |
| `/rag help` | Show all subcommands |

## AI Tools

- **`rag_index`** — Index a path into the pipeline (markdown only)
- **`rag_query`** — Hybrid search; returns **parent sections** (whole heading section on a child hit) with file paths, line numbers, and scores
- **`rag_status`** — Index stats, embedding model, reranker, config, storage
- **`rag_md_sync`** — JSON report of which non-md documents need conversion / are stale / are up to date
- **`rag_coverage`** — one-call completeness report (md vs index, document conversion, index freshness) with a verdict

## How It Works

1. **Index (markdown only)** — `chunkForFile` picks the chunker: markdown files get parent-child chunking (parent = heading section, child = semantic block), everything else falls back to flat line chunks (only reachable via `extraExtensions`). Children are embedded (`bge-m3`, mean-pooled, L2-normalized, sequence length clamped) and stored in SQLite; parents are stored whole for recall.
2. **Search** — FTS5 `bm25()` with `trigram` tokenization (CJK-aware) + `sqlite-vec` cosine NN, blended `alpha × BM25 + (1-alpha) × cosine`. Hits are children; each hit recalls its **parent section**. With the reranker enabled (default for `/rag search` / `rag_query`), the top `RAG_RERANK_TOP_K` candidates are re-scored as (query, parent) cross-encoder pairs and re-sorted; low-latency callers (RAG auto-injection) pass `{ rerank: false }`.
3. **md-sync** — for every non-md document, `scanMarkdownSync` checks whether `A/B/B.md` (or legacy `A/B_ocr/B.md`) exists and whether the recorded sha256 sidecar matches the live source; reports `up_to_date` / `needs_convert` / `checksum_missing`.
4. **Auto-inject** — before every agent turn, the prompt is searched (without reranking) and relevant **parent sections** are appended as a hidden `customType: "rag"` message (KV-cache friendly). The message carries a three-step answering policy: answer directly when the injected context is sufficient; if not, run the `rag_query` tool for an active targeted search (passive injection is a single best-effort lookup and often misses — active search usually finds it); only if an active RAG search still falls short, fall back to reading/grepping the repository files. Any lookup failure is swallowed — RAG never blocks the conversation.
5. **Auto-refresh** — index older than 24 h re-walks tracked paths and re-indexes changed files in the background (throttled to one check/hour).

## Storage

Index data lives in `rag.db` (SQLite WAL, FTS5 + sqlite-vec). Resolution: `$PI_RAG_DIR` → walk-up `.pi/rag/` → `~/.pi/rag/`. The schema carries a version; old indexes are migrated automatically (FTS table rebuilt with trigram, vector table re-dimensioned, files marked for re-embedding).

## Configuration

Config lives in `<ragDir>/config.json`:

| Setting | Default | Description |
|---|---|---|
| `ragEnabled` | `true` | Auto-inject context before each turn |
| `ragTopK` | `5` | Max sections to inject |
| `ragScoreThreshold` | `0.1` | Min hybrid score to include |
| `ragAlpha` | `0.4` | BM25/vector blend (0 = pure vector, 1 = pure BM25) |
| `extraExtensions` | `[]` | Extra file extensions to index beyond markdown |
| `excludeExtensions` | `[]` | Default extensions to skip |
| `trackedPaths` | `[]` | Absolute paths that `/rag rebuild`/`refresh` re-walk |
| `excludePatterns` | `[]` | Gitignore-style patterns applied when walking tracked paths |

## Testing

```bash
npm run typecheck
npx vitest run                      # 160 tests (embeddings suite runs real bge-m3)
SKIP_EMBEDDING_TESTS=1 npx vitest run
```

## Notes / known limitations

- The feature-extraction **pipeline** in `@xenova/transformers` ignores `max_length`; embeddings therefore drive `AutoTokenizer + AutoModel` directly (mean pooling + L2 normalize) — this is also what keeps memory bounded on bge-m3.
- Reranked results may contain several hits from the same parent section (parent recall); a parent-dedup pass is a possible future refinement.
- `regulations/`-style source folders should be excluded (`/rag exclude`) and handled by a verbatim regulation skill instead of RAG.
