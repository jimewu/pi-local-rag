import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync, promises as fsPromises } from "node:fs";
import { extname, basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import ignore from "ignore";
import { BINARY_DOC_EXTS, TEXT_MAX_BYTES, BINARY_DOC_MAX_BYTES, SKIP_DIRS } from "./constants.ts";
import { loadConfig, resolveExtensions, type RagConfig } from "./config.ts";

const yield_ = () => new Promise<void>(r => setTimeout(r, 0));

function stderrProgress(msg: string) { process.stderr.write(`\r\x1b[2K${msg}`); }

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 12);
}

export function chunkText(text: string, maxLines = 50): { content: string; lineStart: number; lineEnd: number }[] {
  const lines = text.split("\n");
  const chunks: { content: string; lineStart: number; lineEnd: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    let end = Math.min(i + maxLines, lines.length);
    for (let j = end - 1; j > i + 10 && j > end - 15; j--) {
      if (lines[j]?.trim() === "") { end = j + 1; break; }
    }
    const chunk = lines.slice(i, end).join("\n");
    if (chunk.trim().length > 20) {
      chunks.push({ content: chunk, lineStart: i + 1, lineEnd: end });
    }
    i = end;
  }
  return chunks;
}

// ─── Parent-child chunking (markdown) ────────────────────────────────────────
//
// The OCR'd case files (committee letters, review comments, …) are markdown with
// clear heading structure. Flat line-based chunking splits sections apart and
// mixes unrelated sections into one chunk. Instead:
//
//   parent  = one markdown heading section (the whole section)
//   child   = one semantic unit inside the section (a paragraph / list /
//             table / code block)
//
// Retrieval runs against CHILDREN (precise, small, embeddable). When a child
// hits, the PARENT (the entire section) is recalled so the answer is never
// taken out of context. Non-markdown files keep the flat chunkText path.

const HEADING_RE = /^#{1,6}\s+.+$/;
const CODE_FENCE_RE = /^\s*(```|~~~)/;
const CHILD_MAX_LINES = 50;
const PARENT_MAX_LINES = 200;
// Chinese text is information-dense: a 10-character line is already a complete
// sentence, so keep the minimum much lower than the English default.
const MIN_CHILD_CHARS = 10;

export interface ParentBlock {
  /** Full section content (heading line included). */
  content: string;
  lineStart: number;
  lineEnd: number;
  /** Heading text without the leading `#`, or null for preamble / flat docs. */
  heading: string | null;
}

export interface ChildBlock {
  content: string;
  lineStart: number;
  lineEnd: number;
  /** Index into the document's parents array; null for flat (non-md) files. */
  parent: number | null;
}

export interface ChunkedDoc {
  parents: ParentBlock[];
  children: ChildBlock[];
}

export function isMarkdownPath(fp: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(fp);
}

/** Split section body lines into semantic blocks (paragraphs / lists /
 *  tables / code fences), using blank lines as paragraph separators and
 *  keeping fenced code blocks intact even when they contain blank lines. */
export function splitSemanticBlocks(lines: string[], startLine = 0): { content: string; lineStart: number; lineEnd: number }[] {
  const blocks: { content: string; lineStart: number; lineEnd: number }[] = [];
  let i = 0;
  while (i < lines.length) {
    const trim = lines[i].trim();
    if (trim === "") { i++; continue; }

    // Fenced code block — swallow everything up to the closing fence.
    if (CODE_FENCE_RE.test(lines[i])) {
      const start = i;
      i++;
      while (i < lines.length && !CODE_FENCE_RE.test(lines[i])) i++;
      i = Math.min(i + 1, lines.length); // include closing fence if present
      blocks.push({
        content: lines.slice(start, i).join("\n"),
        lineStart: startLine + start + 1,
        lineEnd: startLine + i,
      });
      continue;
    }

    // Ordinary block — accumulate consecutive non-blank lines.
    const start = i;
    while (i < lines.length && lines[i].trim() !== "") i++;
    const raw = lines.slice(start, i);
    // Oversized block (no blank lines for a long stretch): split on lines.
    for (let s = 0; s < raw.length; s += CHILD_MAX_LINES) {
      const e = Math.min(s + CHILD_MAX_LINES, raw.length);
      blocks.push({
        content: raw.slice(s, e).join("\n"),
        lineStart: startLine + start + s + 1,
        lineEnd: startLine + start + e,
      });
    }
    while (i < lines.length && lines[i].trim() === "") i++;
  }
  return blocks;
}

/**
 * Parent-child chunk a markdown document.
 *
 * Sections start at every ATX heading; content before the first heading is a
 * preamble parent (heading = null). A section larger than PARENT_MAX_LINES is
 * split into multiple parents (packed on child boundaries) so recalling a
 * parent never floods the context window.
 */
export function chunkMarkdownParentChild(text: string): ChunkedDoc {
  const lines = text.split("\n");
  const parents: ParentBlock[] = [];
  const children: ChildBlock[] = [];

  const headingIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) headingIdx.push(i);
  }

  const sectionBounds: Array<{ start: number; end: number; heading: string | null }> = [];
  if (headingIdx.length === 0) {
    // No headings at all — treat the whole doc as one (heading-less) section.
    sectionBounds.push({ start: 0, end: lines.length, heading: null });
  } else {
    sectionBounds.push({ start: 0, end: headingIdx[0], heading: null }); // preamble
    for (let h = 0; h < headingIdx.length; h++) {
      sectionBounds.push({
        start: headingIdx[h],
        end: h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length,
        heading: lines[headingIdx[h]].replace(/^#{1,6}\s+/, "").trim(),
      });
    }
  }

  for (const sec of sectionBounds) {
    if (sec.end <= sec.start) continue; // empty preamble / adjacent headings
    const sectionLines = lines.slice(sec.start, sec.end);
    // Heading lines belong to the PARENT, never to a child block — a heading
    // alone is not a searchable semantic unit.
    const blocks = splitSemanticBlocks(sectionLines, sec.start)
      .filter(b => !HEADING_RE.test(b.content.trim()));

    // Pack blocks into parents of at most PARENT_MAX_LINES. The first pack
    // starts at the section's heading line so the parent carries the title;
    // the last pack runs to the section end.
    const packs: { blocks: typeof blocks; lineStart: number; lineEnd: number }[] = [];
    for (const b of blocks) {
      let pack = packs[packs.length - 1];
      if (!pack || (b.lineEnd - pack.lineStart) >= PARENT_MAX_LINES) {
        pack = { blocks: [], lineStart: b.lineStart, lineEnd: b.lineEnd };
        packs.push(pack);
      }
      pack.blocks.push(b);
      pack.lineEnd = b.lineEnd;
    }

    if (packs.length === 0) {
      // Heading-only section — keep the heading lines so the section is not
      // lost entirely.
      packs.push({ blocks: [], lineStart: sec.start + 1, lineEnd: sec.end });
    }

    for (let p = 0; p < packs.length; p++) {
      const pack = packs[p];
      const parentStart0 = p === 0 ? sec.start : pack.lineStart - 1; // 0-based line
      const parentEnd0 = p === packs.length - 1 ? sec.end : pack.lineEnd; // exclusive
      parents.push({
        content: lines.slice(parentStart0, parentEnd0).join("\n"),
        lineStart: parentStart0 + 1,
        lineEnd: parentEnd0,
        heading: sec.heading,
      });

      const parentIdx = parents.length - 1;
      for (const b of pack.blocks) {
        if (b.content.trim().length < MIN_CHILD_CHARS) continue;
        children.push({
          content: b.content,
          lineStart: b.lineStart,
          lineEnd: b.lineEnd,
          parent: parentIdx,
        });
      }
    }

    // A section with blocks where every child was filtered out would be
    // unsearchable — fall back to the first block of each empty pack.
    for (let p = 0; p < packs.length; p++) {
      const pack = packs[p];
      if (pack.blocks.length === 0) continue;
      const parentIdx = parents.length - packs.length + p;
      if (children.some(c => c.parent === parentIdx)) continue;
      const b = pack.blocks[0];
      children.push({ content: b.content, lineStart: b.lineStart, lineEnd: b.lineEnd, parent: parentIdx });
    }
  }

  return { parents, children };
}

/** Pick the chunker for a file: parent-child for markdown, flat otherwise. */
export function chunkForFile(fp: string, text: string): ChunkedDoc {
  if (isMarkdownPath(fp)) return chunkMarkdownParentChild(text);
  const flat = chunkText(text);
  return {
    parents: [],
    children: flat.map(c => ({ content: c.content, lineStart: c.lineStart, lineEnd: c.lineEnd, parent: null })),
  };
}

export function collectFiles(
  dirPath: string,
  exts?: Set<string>,
  excludePatterns: string[] = [],
): string[] {
  const allowed = exts ?? resolveExtensions(loadConfig());
  const ig = excludePatterns.length ? ignore().add(excludePatterns) : null;
  const files: string[] = [];
  const root = dirPath;

  function acceptable(fp: string, size: number): boolean {
    const ext = extname(fp).toLowerCase();
    // Binary document formats (pdf/docx) get their own (larger) size cap even
    // when they are explicitly requested via the `exts` parameter — e.g. the
    // md-sync scanner passes DOC_CONVERT_EXTS to enumerate office documents.
    if (!allowed.has(ext)) return false;
    // Binary document formats get their own (larger) size cap when they are
    // explicitly allowed (e.g. the md-sync scanner passes DOC_CONVERT_EXTS).
    return BINARY_DOC_EXTS.has(ext) ? size < BINARY_DOC_MAX_BYTES : size < TEXT_MAX_BYTES;
  }

  function isExcluded(absPath: string): boolean {
    if (!ig) return false;
    const rel = relative(root, absPath);
    if (!rel || rel.startsWith("..")) return false;
    return ig.ignores(rel);
  }

  try {
    const stat = statSync(dirPath);
    if (stat.isFile()) {
      if (!acceptable(dirPath, stat.size)) return [];
      if (ig && ig.ignores(basename(dirPath))) return [];
      return [dirPath];
    }
  } catch { return []; }

  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fp = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          if (isExcluded(fp)) continue;
          walk(fp);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (!allowed.has(ext) && !BINARY_DOC_EXTS.has(ext)) continue;
          if (isExcluded(fp)) continue;
          try {
            if (acceptable(fp, statSync(fp).size)) files.push(fp);
          } catch {}
        }
      }
    } catch {}
  }
  walk(root);
  return files;
}

export function collectFromTracked(cfg: RagConfig): string[] {
  const out = new Set<string>();
  for (const p of cfg.trackedPaths) {
    if (!existsSync(p)) continue;
    for (const f of collectFiles(p, undefined, cfg.excludePatterns)) out.add(f);
  }
  return [...out];
}

/**
 * Async variant of collectFiles that uses fs.promises and yields to the event
 * loop between directories. Required for /rag rebuild on large trackedPaths
 * (45k+ files) — the synchronous walk pegs the event loop long enough that
 * the TUI freezes before reaching the embed phase. Adapted from
 * theli-ua/pi-local-rag@8432a15.
 */
export async function collectFilesAsync(
  dirPath: string,
  exts?: Set<string>,
  excludePatterns: string[] = [],
): Promise<string[]> {
  const allowed = exts ?? resolveExtensions(loadConfig());
  const ig = excludePatterns.length ? ignore().add(excludePatterns) : null;
  const files: string[] = [];
  const root = dirPath;

  function acceptable(fp: string, size: number): boolean {
    const ext = extname(fp).toLowerCase();
    // Binary document formats (pdf/docx) get their own (larger) size cap even
    // when they are explicitly requested via the `exts` parameter — e.g. the
    // md-sync scanner passes DOC_CONVERT_EXTS to enumerate office documents.
    if (!allowed.has(ext)) return false;
    // Binary document formats get their own (larger) size cap when they are
    // explicitly allowed (e.g. the md-sync scanner passes DOC_CONVERT_EXTS).
    return BINARY_DOC_EXTS.has(ext) ? size < BINARY_DOC_MAX_BYTES : size < TEXT_MAX_BYTES;
  }

  function isExcluded(absPath: string): boolean {
    if (!ig) return false;
    const rel = relative(root, absPath);
    if (!rel || rel.startsWith("..")) return false;
    return ig.ignores(rel);
  }

  try {
    const st = await fsPromises.stat(dirPath);
    if (st.isFile()) {
      if (!acceptable(dirPath, st.size)) return [];
      if (ig && ig.ignores(basename(dirPath))) return [];
      return [dirPath];
    }
  } catch { return []; }

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (isExcluded(fp)) continue;
        await walk(fp);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (!allowed.has(ext) && !BINARY_DOC_EXTS.has(ext)) continue;
        if (isExcluded(fp)) continue;
        try {
          const st = await fsPromises.stat(fp);
          if (acceptable(fp, st.size)) files.push(fp);
        } catch {}
      }
    }
    // Yield between directories so the event loop can process UI updates.
    await yield_();
  }

  await walk(root);
  return files;
}

export async function collectFromTrackedAsync(cfg: RagConfig): Promise<string[]> {
  const out = new Set<string>();
  for (const p of cfg.trackedPaths) {
    if (!existsSync(p)) continue;
    for (const f of await collectFilesAsync(p, undefined, cfg.excludePatterns)) out.add(f);
  }
  return [...out];
}

/** Returns true if `file` is matched by `excludePatterns` relative to any of `roots`. */
export function isExcludedByConfig(file: string, roots: string[], excludePatterns: string[]): boolean {
  if (!excludePatterns.length) return false;
  const ig = ignore().add(excludePatterns);
  for (const root of roots) {
    const rel = relative(root, file);
    if (!rel || rel.startsWith("..")) continue;
    if (ig.ignores(rel)) return true;
  }
  return false;
}

// pdfjs (bundled inside pdf-parse) routes warnings through console.log with a
// "Warning: " prefix. On real-world PDFs this fires thousands of times per
// document ("Ran out of space in font private use area", missing glyphs, …).
// The font warnings come from pdf.worker.js, which is a separate webpack
// bundle whose verbosity is not externally configurable (its setVerbosityLevel
// export exists only as a placeholder at the outer module level). Filtering
// console.log for the known pdfjs prefixes is the only reliable approach.
const PDFJS_LOG_PREFIX = /^(Warning|Info|Deprecated API usage):/;
async function withPdfjsSilenced<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && PDFJS_LOG_PREFIX.test(first)) return;
    origLog(...args);
  };
  try {
    return await fn();
  } finally {
    console.log = origLog;
  }
}

// ─── OCR fallback for image-based PDFs ───────────────────────────────────────

type OcrTooling = { available: false } | { available: true; langs: string };
let _ocrTooling: OcrTooling | undefined;
let _ocrUnavailableLogged = false;

/** One-shot probe for system pdftoppm + tesseract. Caches the result. */
export function getOcrTooling(): OcrTooling {
  if (_ocrTooling) return _ocrTooling;
  const pdftoppm = spawnSync("pdftoppm", ["-v"]);
  const tess = spawnSync("tesseract", ["--list-langs"], { encoding: "utf-8" });
  if (pdftoppm.error || tess.error) return (_ocrTooling = { available: false });
  // tesseract prints langs on stderr in some builds, stdout in others.
  const out = `${tess.stdout || ""}\n${tess.stderr || ""}`;
  const have = new Set(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const wanted = ["jpn", "eng"].filter(l => have.has(l));
  if (!wanted.length) return (_ocrTooling = { available: false });
  return (_ocrTooling = { available: true, langs: wanted.join("+") });
}

/** Render `buf` to PNGs via pdftoppm, OCR each page via tesseract, return concatenated text. */
async function ocrPdf(buf: Buffer, langs: string, label: string): Promise<string> {
  const MAX_PAGES = 200;
  const PER_PAGE_TIMEOUT_MS = 60_000;
  const dir = mkdtempSync(join(tmpdir(), "rag-ocr-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    writeFileSync(pdfPath, buf);
    const render = spawnSync("pdftoppm", ["-png", "-r", "200", pdfPath, join(dir, "p")], { encoding: "utf-8" });
    if (render.status !== 0) return "";
    const pages = readdirSync(dir).filter(f => f.startsWith("p-") && f.endsWith(".png")).sort();
    const total = Math.min(pages.length, MAX_PAGES);
    if (pages.length > MAX_PAGES) {
      process.stderr.write(`\r\x1b[2K[rag] OCR ${label}: ${pages.length} pages, capping at ${MAX_PAGES}\n`);
    }
    const out: string[] = [];
    for (let i = 0; i < total; i++) {
      stderrProgress(`[OCR ${i + 1}/${total}] ${label}`);
      await yield_();
      const r = spawnSync("tesseract", [join(dir, pages[i]), "-", "-l", langs], {
        encoding: "utf-8",
        timeout: PER_PAGE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      out.push(r.status === 0 ? (r.stdout ?? "") : "");
    }
    process.stderr.write(`\r\x1b[2K`);
    return out.join("\n\n");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** True if `text` looks too sparse for `numpages` to be the real content of the document. */
export function isSparsePdfText(text: string, numpages: number): boolean {
  return text.trim().length < 50 * Math.max(1, numpages);
}

/**
 * Read and decode a file into UTF-8 text. PDF and DOCX are routed through
 * extraction libraries; everything else is read as plain UTF-8. Hash is
 * computed over the raw bytes for binaries (so the source file's identity
 * drives skip-on-rebuild) and over the decoded text for plain text files.
 */
export async function extractText(fp: string): Promise<{ text: string; hash: string; size: number }> {
  const ext = extname(fp).toLowerCase();
  if (ext === ".pdf") {
    const buf = readFileSync(fp);
    const { default: pdf } = await import("pdf-parse/lib/pdf-parse.js");
    const data = await withPdfjsSilenced(() => pdf(buf));
    let text = data.text;
    if (isSparsePdfText(text, data.numpages ?? 1)) {
      const tools = getOcrTooling();
      if (tools.available) {
        const ocr = await ocrPdf(buf, tools.langs, basename(fp));
        if (ocr.trim().length > text.trim().length) text = ocr;
      } else if (!_ocrUnavailableLogged) {
        _ocrUnavailableLogged = true;
        process.stderr.write(
          `\r\x1b[2K[rag] OCR unavailable: install pdftoppm + tesseract (with jpn/eng traineddata) to index image PDFs\n`
        );
      }
    }
    return { text, hash: sha256(buf.toString("binary")), size: buf.length };
  }
  if (ext === ".docx") {
    const buf = readFileSync(fp);
    const { default: mammoth } = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value, hash: sha256(buf.toString("binary")), size: buf.length };
  }
  if (ext === ".html" || ext === ".htm") {
    const { default: TurndownService } = await import("turndown");
    const raw = readFileSync(fp, "utf-8");
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      blankReplacement: (_content, node) => node.tagName === "BR" ? "\n" : "",
    });
    td.remove(["script", "style"]);
    td.remove(["nav", "footer"]);
    const text = td.turndown(raw);
    return { text, hash: sha256(raw), size: raw.length };
  }
  const text = readFileSync(fp, "utf-8");
  return { text, hash: sha256(text), size: text.length };
}
