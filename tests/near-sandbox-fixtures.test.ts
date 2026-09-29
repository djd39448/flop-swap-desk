// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs against the three committed near-sandbox capture fixtures
// (P5-NEAR-SPEC.md §5): byte-exact, watch-root-shaped bundles of a real Seller/Buyer client-flow
// run (tests-near/client-flows.near.test.ts) against a real, local `near-sandbox` node (chain id
// `near-sandbox-flop`, D-N3) — captured once (`CAPTURE_NEAR_FIXTURES=1 npm run test:near`),
// replayed here with no network and no sandbox (hermetic `npm test`). Mirrors
// tests/btc-regtest-fixtures.test.ts's own pattern exactly, but these three also exercise the
// `near-htlc` chain-evidence path (`raw/near/`, `raw/rpc/`, `rails.json`) end to end: `settled`
// needs both legs' rail evidence final, `refunded`/`refunded-b` need the NEAR leg's own on-chain
// refund (or its complete absence) to fold correctly. `npm test` builds `dist/` first
// (package.json's "test" script), which this spawn depends on.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");
const fixturesRoot = join(repoRoot, "fixtures", "near-sandbox-2026-09-29");

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

interface Case {
  scenario: string;
  swapId: string;
  status: string;
  settlementView: { a: string; b: string };
}

// One entry per fixture directory under fixtures/near-sandbox-2026-09-29/ — swapId and expected
// status/settlementView as tests-near/client-flows.near.test.ts's own scenarios 1-3 produced them
// (re-derive by running `node examples/audit-export.mjs --root <dir> --json` if the fixtures are
// ever recaptured, `CAPTURE_NEAR_FIXTURES=1 npm run test:near`).
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

describe("examples/audit-export.mjs — committed near-sandbox client-flow fixtures (2026-09-29)", () => {
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

  // The settled fixture's chain evidence names the near-sandbox pin, finalized, plus the paper
  // leg's own note hash — the NEAR twin of tests/btc-regtest-fixtures.test.ts's identical check.
  it("the settled fixture's chain evidence names the near-sandbox pin, finalized", () => {
    const result = run(["--root", join(fixturesRoot, "settled"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { swaps: Array<{ finalizedRefs: string[] }> };
    const [swap] = parsed.swaps;
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("near-sandbox:final:"))).toBe(true);
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("paper:sha256:"))).toBe(true);
  });

  // The refunded fixture's own NEAR leg similarly names a finalized ref (the refund's own final
  // block, not the lock's — nearEvidence's own `rail` branch).
  it("the refunded fixture's chain evidence names the near-sandbox pin, finalized", () => {
    const result = run(["--root", join(fixturesRoot, "refunded"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { swaps: Array<{ finalizedRefs: string[] }> };
    const [swap] = parsed.swaps;
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("near-sandbox:final:"))).toBe(true);
  });

  // P22-P24-EVM-FIXES.md B5's rule, reused verbatim for NEAR (as for Bitcoin): every raw sha256 a
  // fixture's evidence summary names (each write's `WriteEvidence.raw`) must resolve to real
  // bytes under that fixture's own `raw/rpc/`, and those bytes must actually re-hash to the name.
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
      // refunded-b (the Buyer never locks leg A at all) makes no NEAR write, so its only write is
      // the paper-rail refund, which carries no `raw` sha256s to check.
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

  // D-N2's own key-discipline rule (no NEAR key material ever leaves memory): the Bitcoin fixture
  // scan's own patterns, plus NEAR's own literal `"secret_key"` field name (`validator_key.json`'s
  // own shape — `tests-near/helpers/sandbox.ts`'s header comment: read once, straight into memory,
  // never written to disk on the Windows side, never logged, never returned from that module in
  // any form).
  //
  // A length-based `ed25519:<base58 longer than N>` heuristic was tried first and dropped: this
  // build's own real captures legitimately contain PLENTY of `ed25519:`-prefixed base58 strings
  // over 50 characters that are not key material at all — every NEAR block header's own
  // `approvals` and every chunk's own `signature` field is `ed25519:` + base58 of a 64-byte
  // signature, the identical byte length (and so string length) a `secret_key` (seed(32) ||
  // publicKey(32), also 64 bytes) would have. A bare length check on an `ed25519:`-prefixed
  // string cannot tell a routine, entirely public chain signature apart from a leaked secret key
  // — confirmed empirically against this file's own committed captures, which contain real
  // signatures of exactly this shape (see the "a real captured NEAR signature is not flagged"
  // test below). Only a NEAR public key (`ed25519:` + base58 of 32 bytes, ~44 chars) is
  // meaningfully shorter than either a signature or a secret key, so the reliable NEAR-specific
  // signal is the literal field name, never a length threshold on the value alone.
  const SUSPICIOUS_KEY_MATERIAL =
    /-----BEGIN|PRIVATE KEY|mnemonic|seed phrase|\bxprv[0-9A-Za-z]{100,}|\bcprv[0-9A-Za-z]{100,}|\btprv[0-9A-Za-z]{100,}|\b[c9][1-9A-HJ-NP-Za-km-z]{50,51}\b|"secret_key"/i;

  function walkFixtures(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walkFixtures(full) : [full];
    });
  }

  it("no committed fixture holds anything resembling a private key, ed25519 secret key, seed or mnemonic", () => {
    for (const file of walkFixtures(fixturesRoot)) {
      expect(SUSPICIOUS_KEY_MATERIAL.test(readFileSync(file, "utf8"))).toBe(false);
    }
  });

  // Pins that the extended scan actually catches a planted leak -- a scratch copy, never the
  // committed fixtures themselves (mirrors tests/btc-regtest-fixtures.test.ts's own H8 pin).
  it("the extended key-material scan actually flags a planted validator_key.json-shaped secret_key field", () => {
    const scratch = mkdtempSync(join(tmpdir(), "flop-near-fixture-scan-"));
    try {
      mkdirSync(join(scratch, "raw", "rpc"), { recursive: true });
      // validator_key.json's own real shape (a planted, never-real, sample value).
      writeFileSync(
        join(scratch, "raw", "rpc", "planted-validator-key.json"),
        JSON.stringify({ account_id: "test.near", public_key: `ed25519:${"1".repeat(43)}`, secret_key: `ed25519:${"2".repeat(87)}` }),
      );

      const files = walkFixtures(scratch);
      const flagged = files.filter((f) => SUSPICIOUS_KEY_MATERIAL.test(readFileSync(f, "utf8")));
      expect(flagged).toEqual([join(scratch, "raw", "rpc", "planted-validator-key.json")]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // A real captured NEAR signature (`ed25519:` + base58 of a 64-byte signature — the SAME string
  // length a secret key's own seed+pubkey encoding would have) must NOT be flagged: this is the
  // false-positive this file's own header comment documents empirically. Every committed fixture
  // already contains real block/chunk signatures of exactly this shape (block headers' own
  // `approvals`, chunks' own `signature`), so this assertion is checked directly against the
  // committed fixtures themselves, not a synthetic sample.
  it("a real captured NEAR block/chunk signature (ed25519: + 64-byte base58, the same length a secret key would have) is not flagged", () => {
    const settledStatusFile = join(fixturesRoot, "settled", "raw", "rpc");
    const files = readdirSync(settledStatusFile).map((name) => join(settledStatusFile, name));
    const withSignature = files.filter((f) => /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/.test(readFileSync(f, "utf8")));
    expect(withSignature.length).toBeGreaterThan(0); // sanity: this fixture really does contain long ed25519 strings
    for (const f of withSignature) {
      expect(SUSPICIOUS_KEY_MATERIAL.test(readFileSync(f, "utf8"))).toBe(false);
    }
  });
});
