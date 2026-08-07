// ANSI color escapes — used by stderr progress lines and TUI widgets in
// callers that don't have access to ctx.ui.theme.
export const RST = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
export const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m", RED = "\x1b[31m", MAGENTA = "\x1b[35m";

export const EMBEDDING_MODEL = process.env.RAG_EMBEDDING_MODEL ?? "Xenova/bge-m3";
export const VECTOR_DIM = Number(process.env.RAG_EMBEDDING_DIM ?? 1024);

// bge-m3's max position is 8192; at batch 64 a full-length forward pass tries
// to allocate a ~256 GB attention buffer. Clamp the sequence length (paragraphs
// are short) and keep the batch modest so CPU memory stays bounded.
export const EMBED_MAX_LENGTH = Number(process.env.RAG_EMBED_MAX_LENGTH ?? 512);
export const EMBED_BATCH_SIZE = Number(process.env.RAG_EMBED_BATCH_SIZE ?? 32);

// Reranker (cross-encoder) — optional, toggled with RAG_RERANKER=false.
export const RERANKER_MODEL = process.env.RAG_RERANKER_MODEL ?? "Xenova/bge-reranker-base";
export const RERANKER_ENABLED = (process.env.RAG_RERANKER ?? "true").toLowerCase() !== "false";
/** How many hybrid-search candidates are sent to the reranker. */
export const RERANK_TOP_K = Number(process.env.RAG_RERANK_TOP_K ?? 20);

export const DEFAULT_TEXT_EXTS = [
  ".md", ".mdx", ".txt", ".rst",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".kts", ".scala",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx",
  ".cs", ".fs", ".vb",
  ".swift", ".m", ".mm",
  ".rb", ".php", ".pl", ".lua", ".dart", ".ex", ".exs", ".erl", ".clj", ".cljs", ".edn",
  ".vue", ".svelte", ".astro",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".xml", ".csv", ".tsv",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".sql", ".graphql", ".gql", ".proto",
  ".env", ".gitignore", ".dockerfile", ".tf", ".hcl",
];

// FORK: this package is scoped to case-file knowledge bases built from
// OCR'd/anydoc-converted markdown. The INDEX allowlist is markdown only;
// every non-md document (docx/pdf/xlsx/csv/…) goes through the convert-to-
// markdown flow (anydoc / batch-ocr skill) into <name>/<name>.md first.
export const DEFAULT_MARKDOWN_EXTS = [".md", ".markdown"];

// Document formats the convert-documents-to-markdown skill can turn into md
// (anydoc: Word/PPT/Excel/ODF/RTF/EPUB/PDF/CSV; batch-ocr: scanned PDFs).
// Used by the md-sync scanner to decide which non-md files need conversion.
export const DOC_CONVERT_EXTS = new Set([
  ".doc", ".docx", ".docm", ".odt", ".rtf", ".epub",
  ".ppt", ".pps", ".pot", ".pptx", ".pptm", ".ppsx", ".ppsm", ".odp",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".ods",
  ".csv",
  ".pdf",
]);

export const BINARY_DOC_EXTS = new Set([".pdf", ".docx"]);

export const TEXT_MAX_BYTES = 500_000;
export const BINARY_DOC_MAX_BYTES = 10_000_000;

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv", ".cache",
]);
