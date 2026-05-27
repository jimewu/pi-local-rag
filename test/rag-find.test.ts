import { test, expect } from "vitest";
import { relative, basename } from "node:path";
import ignore from "ignore";

// Mirrors the matching loop in the `/rag find` command. Keeps the test focused
// on the glob semantics without booting the full extension/registerCommand path.
function findMatches(indexedFiles: string[], glob: string, cwd: string): string[] {
  const ig = ignore().add([glob]);
  const matches: string[] = [];
  for (const fp of indexedFiles) {
    const rel = relative(cwd, fp);
    const candidate = rel && !rel.startsWith("..") ? rel : basename(fp);
    if (ig.ignores(candidate)) matches.push(fp);
  }
  return matches.sort();
}

test("/rag find: matches by extension glob (*.ts)", () => {
  const files = ["/repo/src/a.ts", "/repo/src/b.js", "/repo/test/c.ts", "/repo/README.md"];
  expect(findMatches(files, "*.ts", "/repo")).toEqual(["/repo/src/a.ts", "/repo/test/c.ts"]);
});

test("/rag find: matches by basename prefix (page*)", () => {
  const files = ["/repo/page1.html", "/repo/page2.html", "/repo/about.html"];
  expect(findMatches(files, "page*", "/repo")).toEqual(["/repo/page1.html", "/repo/page2.html"]);
});

test("/rag find: matches a directory subtree (src/)", () => {
  const files = ["/repo/src/a.ts", "/repo/src/inner/b.ts", "/repo/test/c.ts"];
  const m = findMatches(files, "src", "/repo");
  expect(m).toContain("/repo/src/a.ts");
  expect(m).toContain("/repo/src/inner/b.ts");
  expect(m).not.toContain("/repo/test/c.ts");
});

test("/rag find: returns empty when nothing matches", () => {
  const files = ["/repo/a.ts", "/repo/b.md"];
  expect(findMatches(files, "*.py", "/repo")).toEqual([]);
});

test("/rag find: falls back to basename for files outside cwd", () => {
  const files = ["/elsewhere/notes.md", "/repo/src/a.ts"];
  expect(findMatches(files, "notes.md", "/repo")).toEqual(["/elsewhere/notes.md"]);
});

test("/rag find: exact filename glob", () => {
  const files = ["/repo/src/foo.js", "/repo/lib/foo.js", "/repo/src/bar.js"];
  const m = findMatches(files, "foo.js", "/repo");
  expect(m).toContain("/repo/src/foo.js");
  expect(m).toContain("/repo/lib/foo.js");
  expect(m).not.toContain("/repo/src/bar.js");
});
