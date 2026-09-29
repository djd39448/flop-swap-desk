import { defineConfig } from "vitest/config";

// The near-sandbox-only suite (P5-NEAR-SPEC.md §5): a real near-sandbox node inside WSL, real
// wasm contracts, real signed transactions. Kept out of vitest.config.ts's scope so the hermetic
// `npm test` never spawns a process or opens a socket — mirrors vitest.regtest.config.ts's exact
// shape. Generous timeouts: `tests-near/helpers/sandbox.ts` builds the Rust contracts (once per
// process), starts the sandbox, and creates/funds/deploys four accounts, all in `beforeAll`.
export default defineConfig({
  test: {
    include: ["tests-near/**/*.near.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
