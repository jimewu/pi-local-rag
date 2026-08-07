/**
 * Markdown-sync scanner (fork feature).
 *
 * The knowledge base only indexes markdown. Every non-md document (docx, pdf,
 * xlsx, csv, …) is first converted to markdown via the
 * convert-documents-to-markdown skill (anydoc / batch-ocr), which follows the
 * convention:
 *
 *   A/B.docx  →  A/B/B.md          (folder named after the source file)
 *                A/B/images/       (images referenced by the md, when OCR'd)
 *                A/B/B.docx.sha256 (sha256 of the ORIGINAL docx)
 *
 * This module decides which documents need conversion and which are stale, by
 * comparing the checksum recorded next to each converted md against the live
 * sha256 of the source document. Conversion itself is done by the agent with
 * the skill; this scanner only reports state.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createReadStream } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export type MdSyncState = "up_to_date" | "needs_convert" | "checksum_missing";

export type MdSyncReason = "ok" | "no_markdown" | "checksum_changed" | "checksum_missing";

export interface MdSyncStatus {
  /** Source document (non-md), absolute path. */
  file: string;
  /** Expected markdown conversion target. */
  targetMd: string;
  /** Expected checksum sidecar next to the converted md. */
  checksumFile: string;
  state: MdSyncState;
  reason: MdSyncReason;
}

export interface MdSyncReport {
  up_to_date: MdSyncStatus[];
  needs_convert: MdSyncStatus[];
  checksum_missing: MdSyncStatus[];
}

/** How the converted markdown is laid out next to the source document. */
export type MdSyncStyle = "named-folder" | "legacy-ocr";

export interface MdTarget {
  folder: string;
  md: string;
  checksum: string;
  style: MdSyncStyle;
}

/** Where a document's converted md + checksum are expected to live (the
 *  convert-documents-to-markdown convention: A/B.docx → A/B/B.md). */
export function mdTargetFor(src: string): MdTarget {
  const dir = dirname(src);
  const stem = basename(src, extname(src));
  const folder = join(dir, stem);
  return {
    folder,
    md: join(folder, `${stem}.md`),
    checksum: join(folder, `${basename(src)}.sha256`),
    style: "named-folder",
  };
}

/** Legacy layout produced by the earlier OCR pipeline: the md sits directly
 *  inside a `<stem>_ocr/` folder next to a symlink of the source, i.e.
 *  A/<stem>_ocr/<stem>.md. Returns null when that layout is not present. */
export function legacyOcrTargetFor(src: string): MdTarget | null {
  const dir = dirname(src);
  const stem = basename(src, extname(src));
  const ocrDir = join(dir, `${stem}_ocr`);
  const md = join(ocrDir, `${stem}.md`);
  if (existsSync(md)) {
    return {
      folder: ocrDir,
      md,
      checksum: join(ocrDir, `${basename(src)}.sha256`),
      style: "legacy-ocr",
    };
  }
  return null;
}

/** Resolve which (if any) converted markdown exists for a source document:
 *  the plan's named-folder layout first, then the legacy `_ocr` layout. */
export function resolveMdTarget(src: string): MdTarget | null {
  const primary = mdTargetFor(src);
  if (existsSync(primary.md)) return primary;
  return legacyOcrTargetFor(src);
}

/** sha256 of a file's raw bytes (streamed, so multi-hundred-MB PDFs are fine). */
export async function sha256File(fp: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(fp);
    rs.on("data", chunk => hash.update(chunk as Buffer));
    rs.on("end", () => resolve());
    rs.on("error", reject);
  });
  return hash.digest("hex");
}

/** Parse a checksum sidecar: first 64 hex chars of the first line (supports
 *  both bare hashes and `sha256sum`-style "<hash>  <file>" lines). */
export function readChecksumFile(fp: string): string | null {
  try {
    const line = readFileSync(fp, "utf-8").split("\n")[0]?.trim() ?? "";
    const m = line.match(/^([0-9a-f]{64})/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Scan a list of source documents for conversion state. Symlinked duplicates
 *  (the legacy `_ocr` folders symlink the source pdf) are collapsed by real
 *  path so each document is reported once. */
export async function scanMarkdownSync(files: string[]): Promise<MdSyncReport> {
  const report: MdSyncReport = { up_to_date: [], needs_convert: [], checksum_missing: [] };
  const seen = new Set<string>();
  for (const file of files) {
    let real = file;
    try {
      real = realpathSync(file);
    } catch {
      /* dangling symlink or missing file — still report it */
    }
    if (seen.has(real)) continue;
    seen.add(real);

    const target = resolveMdTarget(file);
    const status: MdSyncStatus = {
      file,
      targetMd: target?.md ?? mdTargetFor(file).md,
      checksumFile: target?.checksum ?? mdTargetFor(file).checksum,
      state: "needs_convert",
      reason: "no_markdown",
    };
    if (!target) {
      status.state = "needs_convert";
      status.reason = "no_markdown";
    } else {
      const recorded = readChecksumFile(status.checksumFile);
      if (!recorded) {
        status.state = "checksum_missing";
        status.reason = "checksum_missing";
      } else if (recorded === (await sha256File(file))) {
        status.state = "up_to_date";
        status.reason = "ok";
      } else {
        status.state = "needs_convert";
        status.reason = "checksum_changed";
      }
    }
    if (status.state === "up_to_date") report.up_to_date.push(status);
    else if (status.state === "checksum_missing") report.checksum_missing.push(status);
    else report.needs_convert.push(status);
  }
  return report;
}
