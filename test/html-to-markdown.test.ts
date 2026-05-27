import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractText } from "../index.ts";

function setup() {
  return mkdtempSync(join(tmpdir(), "rag-html-"));
}

test("extractText HTML: converts simple HTML to markdown", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "simple.html");
    writeFileSync(fp, "<p>Hello <strong>world</strong></p>");
    const { text } = await extractText(fp);
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<strong>");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: removes script and style blocks", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "no-script.html");
    writeFileSync(fp, "<p>Before</p><script>alert('xss')</script><style>.x{}</style><p>After</p>");
    const { text } = await extractText(fp);
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".x{}");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: removes nav and footer elements", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "no-nav.html");
    writeFileSync(fp, "<nav>Home | About</nav><p>Content</p><footer>Copyright</footer>");
    const { text } = await extractText(fp);
    expect(text).toContain("Content");
    expect(text).not.toContain("Home | About");
    expect(text).not.toContain("Copyright");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: converts headings to atx style", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "headings.html");
    writeFileSync(fp, "<h1>Title</h1><h2>Subtitle</h2><p>Body</p>");
    const { text } = await extractText(fp);
    expect(text).toContain("# Title");
    expect(text).toContain("## Subtitle");
    expect(text).toContain("Body");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: fences code blocks", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "code.html");
    writeFileSync(fp, '<pre><code class="lang-cs">var x = 1;</code></pre>');
    const { text } = await extractText(fp);
    expect(text).toContain("```");
    expect(text).toContain("var x = 1;");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: converts lists to markdown", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "lists.html");
    writeFileSync(fp, "<ul><li>One</li><li>Two</li></ul>");
    const { text } = await extractText(fp);
    expect(text).toContain("One");
    expect(text).toContain("Two");
    expect(text).not.toContain("<li>");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: hashes the raw HTML, not the markdown", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "hash-test.html");
    writeFileSync(fp, "<p>Content</p>");
    const { hash, text } = await extractText(fp);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(text).not.toContain("<p>");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: handles real-world Unity doc HTML structure", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "unity-doc.html");
    const html = `<!DOCTYPE html><html><head><script>var x = 1;</script></head>
<body><nav>Navigation</nav><div class="content"><h1>Add textures to the camera history</h1>
<p>To add your own texture to the <strong>camera</strong> history.</p>
<pre><code>public class Example : CameraHistoryItem { }</code></pre>
<ul><li>Step one</li><li>Step two</li></ul>
</div><footer>Copyright</footer></body></html>`;
    writeFileSync(fp, html);
    const { text } = await extractText(fp);
    expect(text).toContain("# Add textures to the camera history");
    expect(text).toContain("camera");
    expect(text).toContain("public class Example : CameraHistoryItem { }");
    expect(text).toContain("Step one");
    expect(text).toContain("Step two");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("Navigation");
    expect(text).not.toContain("Copyright");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: also handles .htm extension", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "page.htm");
    writeFileSync(fp, "<h1>Title</h1><p>Body</p>");
    const { text } = await extractText(fp);
    expect(text).toContain("# Title");
    expect(text).toContain("Body");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("extractText HTML: produces much smaller output than raw HTML for Unity docs", async () => {
  const tmp = setup();
  try {
    const fp = join(tmp, "big.html");
    const html = "<script>" + "x".repeat(5000) + "</script>"
      + "<style>" + "y".repeat(3000) + "</style>"
      + "<nav>" + "z".repeat(2000) + "</nav>"
      + "<p>Actual content here about framebuffer fetch</p>"
      + "<footer>" + "w".repeat(1000) + "</footer>";
    writeFileSync(fp, html);
    const { text } = await extractText(fp);
    expect(text.length).toBeLessThan(html.length / 2);
    expect(text).toContain("Actual content here about framebuffer fetch");
    expect(text).not.toContain("x".repeat(100));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
