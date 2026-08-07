/**
 * HTTP backend tests — when RAG_EMBED_URL / RAG_RERANK_URL are set, embedding
 * and reranking route to an external server (e.g. llama-swap) instead of the
 * local ONNX pipeline. This suite spins up a fake OpenAI-compatible server,
 * sets the env vars, re-imports the module (module-level consts read env at
 * load time), and verifies truncation to VECTOR_DIM + re-normalization.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** 2560-dim unit vector, deterministic per seed — mimics a llama-swap /
 *  Qwen3-Embedding-4B full-width output. */
function fakeVector(dim: number, seed: number): number[] {
  const v = new Array(dim).fill(0).map((_, i) => Math.sin(seed * 1000 + i * 0.01));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

describe("HTTP embedding/rerank backend (RAG_EMBED_URL / RAG_RERANK_URL)", () => {
  let server: Server;
  let baseUrl: string;
  const embedRequests: Array<{ model: string; input: string[] }> = [];
  const rerankRequests: Array<{ model: string; query: string; documents: string[] }> = [];

  beforeAll(async () => {
    process.env.RAG_EMBEDDING_DIM = "1024"; // VECTOR_DIM for the truncation check
    server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        if (req.url === "/v1/embeddings") {
          embedRequests.push(parsed);
          const input = parsed.input as string[];
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ data: input.map((_, i) => ({ embedding: fakeVector(2560, i) })) }));
        } else if (req.url === "/v1/rerank") {
          rerankRequests.push(parsed);
          const docs = (parsed.documents as string[]).length;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            results: Array.from({ length: docs }, (_, i) => ({ index: i, relevance_score: 1 - i * 0.1 })),
          }));
        } else {
          res.statusCode = 404;
          res.end("not found");
        }
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.RAG_EMBED_URL = baseUrl;
    process.env.RAG_RERANK_URL = baseUrl;
    vi.resetModules(); // module-level consts re-read env on next import
  });

  afterAll(async () => {
    delete process.env.RAG_EMBED_URL;
    delete process.env.RAG_RERANK_URL;
    delete process.env.RAG_EMBEDDING_DIM;
    await new Promise<void>(r => server.close(() => r()));
  });

  it("embedTexts hits /v1/embeddings, truncates to VECTOR_DIM, re-normalizes", async () => {
    const { embedTexts } = await import("../embed.ts");
    const texts = ["量測裝置臨床評估", "Medical device evaluation"];
    const vecs = await embedTexts(texts);
    expect(vecs.length).toBe(2);
    for (const v of vecs) {
      expect(v.length).toBe(1024); // MRL-truncated from 2560
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      expect(Math.abs(norm - 1)).toBeLessThan(1e-3);
    }
    expect(embedRequests.length).toBe(1);
    expect(embedRequests[0]!.model).toBe("qwen3-embedding-4b");
    expect(embedRequests[0]!.input).toEqual(texts);
  });

  it("rerank hits /v1/rerank and returns scores aligned with passages", async () => {
    const { rerank } = await import("../embed.ts");
    const scores = (await rerank("臨床評估", ["文件一", "文件二", "文件三"]))!;
    expect(scores.length).toBe(3);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[2]).toBeLessThan(scores[1]!);
    expect(rerankRequests.length).toBe(1);
    expect(rerankRequests[0]!.model).toBe("qwen3-reranker-4b");
    expect(rerankRequests[0]!.query).toBe("臨床評估");
  });

  it("isRerankerEnabled is true when RAG_RERANK_URL is set", async () => {
    const { isRerankerEnabled } = await import("../embed.ts");
    expect(isRerankerEnabled()).toBe(true);
  });

  it("splits large token loads into multiple HTTP requests (ctx budget guard)", async () => {
    const before = embedRequests.length;
    const { embedTexts } = await import("../embed.ts");
    // 10 long CJK texts ≈ 10 × 3600 est. tokens — must split into ≥2 requests.
    const texts = Array.from({ length: 10 }, (_, i) => "臨床評估報告內容片段".repeat(300) + ` ${i}`);
    const vecs = await embedTexts(texts);
    expect(vecs.length).toBe(10);
    expect(embedRequests.length - before).toBeGreaterThanOrEqual(2);
  });

  it("errors surface when the server is unreachable", async () => {
    // Point at a closed port (the fake server is still listening, so use an
    // invalid URL on a different module instance).
    process.env.RAG_EMBED_URL = "http://127.0.0.1:1";
    vi.resetModules();
    const { embedTexts: e2 } = await import("../embed.ts");
    await expect(e2(["x"])).rejects.toThrow(/RAG_EMBED_URL|fetch|ECONNREFUSED/);
    process.env.RAG_EMBED_URL = baseUrl;
    vi.resetModules();
  });
});
