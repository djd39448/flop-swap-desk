// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs against the three committed anvil capture fixtures
// (P22-P24-EVM-SPEC.md §6): byte-exact, watch-root-shaped bundles of a real Seller/Buyer
// client-flow run (tests-anvil/client-flows.anvil.test.ts) against a real, local anvil node —
// captured once, replayed here with no network and no anvil (hermetic `npm test`). Mirrors
// tests/audit-export.test.ts's pattern for the 2026-09-18 paper rehearsal fixture, but these
// three also exercise the `evm-htlc` chain-evidence path (`raw/evm/`, `raw/rpc/`, `rails.json`)
// end to end: `settled` needs both legs' rail evidence final, `refunded`/`refunded-b` need the
// EVM leg's on-chain refund (or its complete absence) to fold correctly. `npm test` builds
// `dist/` first (package.json's "test" script), which this spawn depends on.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");
const fixturesRoot = join(repoRoot, "fixtures", "evm-anvil-2026-09-28");

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

interface Case {
  scenario: string;
  swapId: string;
  status: string;
  settlementView: { a: string; b: string };
}

// One entry per fixture directory under fixtures/evm-anvil-2026-09-28/ — swapId and expected
// status/settlementView as tests-anvil/client-flows.anvil.test.ts's own scenarios 1-3 produced
// them (re-derive by running `node examples/audit-export.mjs --root <dir> --json` if the
// fixtures are ever recaptured).
const CASES: Case[] = [
  {
    scenario: "settled",
    swapId: "0xf606337768df1bacad6a46342809d1e4622140f9227297648a834a3f5a3ef62d",
    status: "settled",
    settlementView: { a: "claimed", b: "claimed" },
  },
  {
    scenario: "refunded",
    swapId: "0x96b50bd3277b4434bbc450b58106a21ed470c49764a7f72f240123055377f35e",
    status: "refunded",
    settlementView: { a: "refunded", b: "refunded" },
  },
  {
    scenario: "refunded-b",
    swapId: "0xf30e56dca89c02760ab6f230bf2934255841ee0d14cac8d58625601a948b99b0",
    status: "refunded-b",
    settlementView: { a: "none", b: "refunded" },
  },
];

describe("examples/audit-export.mjs — committed anvil client-flow fixtures (2026-09-28)", () => {
  for (const testCase of CASES) {
    const root = join(fixturesRoot, testCase.scenario);

    it(`${testCase.scenario}: --expect ${testCase.swapId}=${testCase.status} exits 0`, () => {
      const result = run(["--root", root, "--expect", `${testCase.swapId}=${testCase.status}`]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`swap ${testCase.swapId} -> ${testCase.status}`);
    });

    it(`${testCase.scenario}: settlementView is a=${testCase.settlementView.a} b=${testCase.settlementView.b}`, () => {
      const result = run(["--root", root, "--json"]);
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as { swaps: Array<{ swapId: string; status: string; settlementView: { a: string; b: string } }> };
      const swap = parsed.swaps.find((s) => s.swapId === testCase.swapId);
      expect(swap).toBeDefined();
      expect(swap?.status).toBe(testCase.status);
      expect(swap?.settlementView).toEqual(testCase.settlementView);
    });

    it(`${testCase.scenario}: exits 1 when the expectation does not hold`, () => {
      const result = run(["--root", root, "--expect", `${testCase.swapId}=bid`]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("expect failed");
    });
  }

  it("the settled fixture's chain evidence names the anvil-local pin, finalized", () => {
    const result = run(["--root", join(fixturesRoot, "settled"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { swaps: Array<{ finalizedRefs: string[] }> };
    const [swap] = parsed.swaps;
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("anvil-local:finalized:"))).toBe(true);
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("paper:sha256:"))).toBe(true);
  });

  it("no committed fixture holds anything resembling a private key or mnemonic", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const suspicious = /-----BEGIN|PRIVATE KEY|mnemonic|seed phrase/i;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    for (const file of walk(fixturesRoot)) {
      expect(suspicious.test(readFileSync(file, "utf8"))).toBe(false);
    }
  });
});
