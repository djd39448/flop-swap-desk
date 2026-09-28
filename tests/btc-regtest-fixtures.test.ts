// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs against the three committed regtest capture fixtures
// (P4-BTC-SPEC.md §7): byte-exact, watch-root-shaped bundles of a real Seller/Buyer client-flow
// run (tests-regtest/client-flows.regtest.test.ts) against a real, local bitcoind -regtest node
// — captured once (`CAPTURE_BTC_FIXTURES=1 npm run test:regtest`), replayed here with no network
// and no bitcoind (hermetic `npm test`). Mirrors tests/evm-anvil-fixtures.test.ts's own pattern
// exactly, but these three also exercise the `btc-htlc` chain-evidence path (`raw/btc/`,
// `raw/rpc/`, `rails.json`) end to end: `settled` needs both legs' rail evidence final,
// `refunded`/`refunded-b` need the Bitcoin leg's on-chain refund (or its complete absence) to
// fold correctly. `npm test` builds `dist/` first (package.json's "test" script), which this
// spawn depends on.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");
const fixturesRoot = join(repoRoot, "fixtures", "btc-regtest-2026-09-28");

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

interface Case {
  scenario: string;
  swapId: string;
  status: string;
  settlementView: { a: string; b: string };
}

// One entry per fixture directory under fixtures/btc-regtest-2026-09-28/ — swapId and expected
// status/settlementView as tests-regtest/client-flows.regtest.test.ts's own scenarios 1-3
// produced them (re-derive by running `node examples/audit-export.mjs --root <dir> --json` if
// the fixtures are ever recaptured, CAPTURE_BTC_FIXTURES=1 npm run test:regtest).
const CASES: Case[] = [
  {
    scenario: "settled",
    swapId: "0x4096f1d32d53d44c63b4554ea849511ce01895e6de56d86ab3a257f4bc1fb80e",
    status: "settled",
    settlementView: { a: "claimed", b: "claimed" },
  },
  {
    scenario: "refunded",
    swapId: "0x208e2bdaa7c0a00cbddd329c8dc414f4044780d0a1cc56627c10866b87ff6ae1",
    status: "refunded",
    settlementView: { a: "refunded", b: "refunded" },
  },
  {
    scenario: "refunded-b",
    swapId: "0x7a1e900409c90ef1a824e323ce36b20d769c37b93a1eda6e0430130054577f5b",
    status: "refunded-b",
    settlementView: { a: "none", b: "refunded" },
  },
];

describe("examples/audit-export.mjs — committed btc-regtest client-flow fixtures (2026-09-28)", () => {
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

  // The settled fixture's chain evidence names the btc-regtest pin, finalized, plus the paper
  // leg's own note hash — the Bitcoin twin of tests/evm-anvil-fixtures.test.ts's identical check.
  it("the settled fixture's chain evidence names the btc-regtest pin, finalized", () => {
    const result = run(["--root", join(fixturesRoot, "settled"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { swaps: Array<{ finalizedRefs: string[] }> };
    const [swap] = parsed.swaps;
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("btc-regtest:confirmations-2:"))).toBe(true);
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("paper:sha256:"))).toBe(true);
  });

  // The refunded fixture's own Bitcoin leg similarly names a finalized confirmations-based ref
  // (the refund's own spending block, not the funding block — btcEvidence's own `rail` branch).
  it("the refunded fixture's chain evidence names the btc-regtest pin, finalized", () => {
    const result = run(["--root", join(fixturesRoot, "refunded"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { swaps: Array<{ finalizedRefs: string[] }> };
    const [swap] = parsed.swaps;
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("btc-regtest:confirmations-2:"))).toBe(true);
  });

  // P22-P24-EVM-FIXES.md B5's rule, reused verbatim for Bitcoin: every raw sha256 a fixture's
  // evidence summary names (each write's `WriteEvidence.raw`) must resolve to real bytes under
  // that fixture's own `raw/rpc/`, and those bytes must actually re-hash to the name.
  for (const testCase of CASES) {
    it(`${testCase.scenario}: every raw hash in the evidence summary exists in raw/rpc and re-hashes`, async () => {
      const { readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const evidenceDir = join(fixturesRoot, testCase.scenario, "evidence");
      const evidencePath = join(evidenceDir, `${testCase.swapId}.json`);
      const summary = JSON.parse(await readFile(evidencePath, "utf8")) as {
        writes: Array<{ evidence: { raw?: string[] } }>;
      };
      const hashes = summary.writes.flatMap((write) => write.evidence.raw ?? []);
      // refunded-b (SPEC §7 scenario 3: the Buyer never funds A) makes no Bitcoin write at all,
      // so its only write is the paper-rail refund, which carries no `raw` sha256s to check.
      if (testCase.scenario === "refunded-b") {
        expect(hashes.length).toBe(0);
        return;
      }
      expect(hashes.length).toBeGreaterThan(0);
      for (const hash of hashes) {
        const bytes = await readFile(join(fixturesRoot, testCase.scenario, "raw", "rpc", `${hash}.json`));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      }
    });
  }

  // H8: extended with tprv (Bitcoin's own testnet/regtest xprv prefix — the chain this build's
  // fixtures are actually on), a testnet/regtest WIF (base58, 51-52 chars, starting `c`/`9`), and
  // any captured request naming `dumpprivkey`, `dumpwallet`, or `listdescriptors` with `true` (the
  // three RPCs P4-BTC-SPEC.md §1 forbids outright) — pinning what H1's own key-export ban claims.
  const SUSPICIOUS_KEY_MATERIAL = /-----BEGIN|PRIVATE KEY|mnemonic|seed phrase|\bxprv[0-9A-Za-z]{100,}|\bcprv[0-9A-Za-z]{100,}|\btprv[0-9A-Za-z]{100,}|\b[c9][1-9A-HJ-NP-Za-km-z]{50,51}\b/i;
  const SUSPICIOUS_RPC_METHOD = /dumpprivkey|dumpwallet|listdescriptors[\s\S]{0,80}true/i;

  function walkFixtures(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walkFixtures(full) : [full];
    });
  }

  it("no committed fixture holds anything resembling a private key, WIF, xprv/tprv, seed or mnemonic", () => {
    for (const file of walkFixtures(fixturesRoot)) {
      expect(SUSPICIOUS_KEY_MATERIAL.test(readFileSync(file, "utf8"))).toBe(false);
    }
  });

  it("H8: no committed fixture names dumpprivkey, dumpwallet, or listdescriptors with true", () => {
    for (const file of walkFixtures(fixturesRoot)) {
      expect(SUSPICIOUS_RPC_METHOD.test(readFileSync(file, "utf8"))).toBe(false);
    }
  });

  // H8's own "pins what it claims": prove the extended patterns actually catch a planted leak —
  // a scratch copy, never the committed fixtures themselves.
  it("H8: the extended key/method scan actually flags a planted tprv, testnet WIF, and forbidden RPC method", () => {
    const scratch = mkdtempSync(join(tmpdir(), "flop-btc-fixture-scan-"));
    try {
      mkdirSync(join(scratch, "raw", "rpc"), { recursive: true });
      const tprvSample = `tprv${"A".repeat(107)}`;
      const wifSample = `c${"1".repeat(51)}`;
      writeFileSync(join(scratch, "planted-tprv.txt"), tprvSample);
      writeFileSync(join(scratch, "planted-wif.txt"), wifSample);
      writeFileSync(join(scratch, "raw", "rpc", "planted-method.json"), JSON.stringify({ method: "dumpprivkey", params: ["addr"] }));
      writeFileSync(join(scratch, "raw", "rpc", "planted-listdescriptors.json"), JSON.stringify({ method: "listdescriptors", params: [true] }));

      const files = walkFixtures(scratch);
      const flaggedKeyMaterial = files.filter((f) => SUSPICIOUS_KEY_MATERIAL.test(readFileSync(f, "utf8")));
      const flaggedMethods = files.filter((f) => SUSPICIOUS_RPC_METHOD.test(readFileSync(f, "utf8")));
      expect(flaggedKeyMaterial.sort()).toEqual([join(scratch, "planted-tprv.txt"), join(scratch, "planted-wif.txt")].sort());
      expect(flaggedMethods.sort()).toEqual(
        [join(scratch, "raw", "rpc", "planted-listdescriptors.json"), join(scratch, "raw", "rpc", "planted-method.json")].sort(),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // P4-BTC-SPEC.md §1: the node's RPC cookie (Basic auth) must never have been captured — every
  // exchange's own request bytes carry only the JSON-RPC body, never an HTTP header.
  it("no captured raw/rpc exchange contains an Authorization header or cookie value", async () => {
    const rpcDirs = CASES.map((c) => join(fixturesRoot, c.scenario, "raw", "rpc")).filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
    for (const dir of rpcDirs) {
      for (const name of readdirSync(dir)) {
        const text = readFileSync(join(dir, name), "utf8");
        expect(text.toLowerCase()).not.toContain("authorization");
        expect(text.toLowerCase()).not.toContain("basic ");
      }
    }
  });
});
