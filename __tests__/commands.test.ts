/**
 * /rag command handler tests — verify the extension's command layer that pi
 * executes in an interactive session: /rag status renders a widget,
 * /rag coverage appends a transcript entry (not a pinned widget), and
 * /rag coverage --auto runs the auto-complete cycle. The store is isolated
 * to a scratch dir via PI_RAG_DIR.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RagHandler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

interface MockPi {
  on: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerEntryRenderer: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
}

describe("/rag command handlers (pi session)", () => {
  let ragDir: string;
  let savedCwd: string;
  let savedRagDir: string | undefined;

  beforeAll(async () => {
    ragDir = mkdtempSync(join(tmpdir(), "rag-cmd-"));
    savedCwd = process.cwd();
    savedRagDir = process.env.PI_RAG_DIR;
    process.env.PI_RAG_DIR = ragDir;
    process.chdir(ragDir); // empty scratch repo: no files, no documents
  });

  afterAll(() => {
    process.chdir(savedCwd);
    if (savedRagDir !== undefined) process.env.PI_RAG_DIR = savedRagDir;
    else delete process.env.PI_RAG_DIR;
    rmSync(ragDir, { recursive: true, force: true });
  });

  async function loadHandler(): Promise<{ handler: RagHandler; pi: MockPi; ctx: Record<string, unknown> }> {
    const mod = await import("../index.ts");
    const commands: Record<string, { handler: RagHandler }> = {};
    const appended: Array<[string, unknown]> = [];
    const widgets: Array<[string, unknown]> = [];
    const statuses: Array<[string, string | undefined]> = [];

    const pi: MockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerEntryRenderer: vi.fn(),
      appendEntry: vi.fn((type: string, data: unknown) => { appended.push([type, data]); }),
      registerCommand: vi.fn((name: string, opts: { handler: RagHandler }) => { commands[name] = opts; }),
    };
    mod.default(pi as never);

    const ctx = {
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn((k: string, v: unknown) => { widgets.push([k, v]); }),
        setStatus: vi.fn((k: string, v?: string) => { statuses.push([k, v]); }),
        theme: {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
        },
      },
      cwd: ragDir,
      mode: "tui",
    };

    return { handler: commands["rag"]!.handler, pi, ctx };
  }

  it("/rag status renders a widget (not an entry)", async () => {
    const { handler, pi, ctx } = await loadHandler();
    await handler("status", ctx);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    const ui = ctx.ui as { setWidget: ReturnType<typeof vi.fn> };
    expect(ui.setWidget).toHaveBeenCalledWith("rag-status", expect.any(Array));
    const lines = ui.setWidget.mock.calls[0]![1] as string[];
    const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("🔍 pi-local-rag");
  });

  it("/rag coverage appends a transcript entry and does not pin a widget", async () => {
    const { handler, pi, ctx } = await loadHandler();
    await handler("coverage", ctx);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry.mock.calls[0]![0]).toBe("rag-coverage");
    const data = pi.appendEntry.mock.calls[0]![1] as { root: string; timestamp: number; verdict: string };
    expect(data.root).toBe(ragDir);
    expect(data.timestamp).toEqual(expect.any(Number));
    const ui = ctx.ui as { setWidget: ReturnType<typeof vi.fn> };
    expect(ui.setWidget).not.toHaveBeenCalled();
  });

  it("/rag coverage --auto runs the auto-complete cycle and appends the result", async () => {
    const { handler, pi, ctx } = await loadHandler();
    await handler("coverage --auto", ctx);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry.mock.calls[0]![0]).toBe("rag-coverage");
    // Empty scratch repo: auto-complete finishes with a complete verdict.
    const data = pi.appendEntry.mock.calls[0]![1] as { verdict: string; timestamp: number };
    expect(data.timestamp).toEqual(expect.any(Number));
    expect(data.verdict).toBe("complete");
    // Progress was streamed to the footer status.
    const ui = ctx.ui as { setStatus: ReturnType<typeof vi.fn> };
    expect(ui.setStatus).toHaveBeenCalled();
    expect(ui.setStatus).toHaveBeenLastCalledWith("rag", undefined); // cleared at the end
  });
});
