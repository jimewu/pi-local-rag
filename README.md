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
- **Per-project storage** — walks up from cwd looking for `.pi/rag/`; falls back to `~/.pi/rag/` global store
- **Auto-refresh** — stale index (>24 h) silently refreshed before the next agent turn; manual `/rag refresh` for on-demand incremental updates
- **Auto-injection** — relevant parent sections appended after the user prompt before every agent turn (KV-cache friendly)
- **4 AI tools** — `rag_index`, `rag_query`, `rag_status`, `rag_md_sync`

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

Models download once from HuggingFace on first use and are cached locally.

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
2. **Search** — FTS5 `bm25()` with `trigram` tokenization (CJK-aware) + `sqlite-vec` cosine NN, blended `alpha × BM25 + (1-alpha) × cosine`. Hits are children; each hit recalls its **parent section**. With the reranker enabled, the top `RAG_RERANK_TOP_K` candidates are re-scored as (query, parent) cross-encoder pairs and re-sorted.
3. **md-sync** — for every non-md document, `scanMarkdownSync` checks whether `A/B/B.md` (or legacy `A/B_ocr/B.md`) exists and whether the recorded sha256 sidecar matches the live source; reports `up_to_date` / `needs_convert` / `checksum_missing`.
4. **Auto-inject** — before every agent turn, the prompt is searched and relevant **parent sections** are appended as a hidden `customType: "rag"` message (KV-cache friendly).
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
npx vitest run                      # 128 tests (embeddings suite runs real bge-m3)
SKIP_EMBEDDING_TESTS=1 npx vitest run
```

## Notes / known limitations

- The feature-extraction **pipeline** in `@xenova/transformers` ignores `max_length`; embeddings therefore drive `AutoTokenizer + AutoModel` directly (mean pooling + L2 normalize) — this is also what keeps memory bounded on bge-m3.
- Reranked results may contain several hits from the same parent section (parent recall); a parent-dedup pass is a possible future refinement.
- `regulations/`-style source folders should be excluded (`/rag exclude`) and handled by a verbatim regulation skill instead of RAG.
