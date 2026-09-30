import { defineConfig } from "vitest/config";

// The solana-test-validator-only suite (P6-SOL-SPEC.md section 5): a real validator inside WSL, the real
// reviewed htlc.so loaded at genesis, real signed transactions. Kept out of vitest.config.ts's scope so the
// hermetic `npm test` never spawns a process or opens a socket - mirrors vitest.near.config.ts's shape.
// Generous timeouts: `tests-sol/helpers/validator.ts` builds the program (once per process), starts the
// validator and funds the parties in `beforeAll`, and every write waits for a FINALIZED signature
// (about 15 s on this validator). Files run one at a time (one worktree, one WSL instance).
export default defineConfig({
  test: {
    include: ["tests-sol/**/*.sol.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    disableConsoleIntercept: true,
  },
});
