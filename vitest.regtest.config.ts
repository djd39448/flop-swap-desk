import { defineConfig } from "vitest/config";

// The regtest-only suite (P4-BTC-SPEC.md §2): a real bitcoind -regtest node, real wallets, real
// mined blocks. Kept out of vitest.config.ts's scope so the hermetic `npm test` never spawns a
// process or opens a socket — see tests-regtest/helpers/bitcoind.ts for how a node is
// found/spawned. Generous timeouts: spawning bitcoind, creating two descriptor wallets and
// mining >100 blocks to mature a coinbase all happen once per file in `beforeAll`.
export default defineConfig({
  test: {
    include: ["tests-regtest/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
