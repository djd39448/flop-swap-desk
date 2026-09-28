import { defineConfig } from "vitest/config";

// The anvil-only suite (P22-P24-EVM-SPEC.md §2.3): real anvil nodes, real block mining, real
// time warps. Kept out of vitest.config.ts's scope so the hermetic `npm test` never spawns a
// process or opens a socket — see tests-anvil/helpers/anvil.ts for how a node is found/spawned.
export default defineConfig({
  test: {
    include: ["tests-anvil/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
