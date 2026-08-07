import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    // Several suites set process.env.PI_RAG_DIR / PI_RAG_LEGACY_DIR before
    // importing index.ts, so running them in parallel would race over the
    // shared module instance. Keep files sequential — runtime is < 1 s.
    fileParallelism: false,
    testTimeout: 10_000,
    // The @xenova/transformers mock in index.test.ts emits 384-dim vectors
    // (matching the original all-MiniLM-L6-v2), and the reranker is a
    // text-classification pipeline the mock does not model — so run the test
    // suite against those defaults.
    env: {
      RAG_EMBEDDING_DIM: "384",
      RAG_RERANKER: "false",
    },
  },
});
