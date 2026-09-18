import { defineConfig } from "vitest/config";

// The vendored tclk workspace has its own suite; scope this config to ours so a root run
// never sweeps `vendor/tclk/tests` (and never depends on its Windows-CRLF generator check).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
