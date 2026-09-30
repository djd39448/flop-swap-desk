// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs against the three committed near-sandbox capture fixtures
// (P5-NEAR-SPEC.md §5): byte-exact, watch-root-shaped bundles of a real Seller/Buyer client-flow
// run (tests-near/client-flows.near.test.ts) against a real, local `near-sandbox` node (chain id
// `near-sandbox-flop`, D-N3) — captured once (`CAPTURE_NEAR_FIXTURES=1 npm run test:near`),
// replayed here with no network and no sandbox (hermetic `npm test`). Mirrors
// tests/btc-regtest-fixtures.test.ts's own pattern, but `settled` and `refunded` also exercise
// the `near-htlc` chain-evidence path (`raw/near/`, `raw/rpc/`, `rails.json`) end to end:
// `settled` needs both legs' rail evidence final, `refunded` the NEAR leg's own on-chain refund
// to fold. `refunded-b` (the Buyer never locks leg A) carries NO NEAR bytes at all -- no
// `raw/near/`, no `raw/rpc/`, no `rails.json` -- so it proves only the paper-rail fold and the
// absence of any NEAR write; it does not exercise the NEAR evidence reader. `npm test` builds
// `dist/` first (package.json's "test" script), which this spawn depends on.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

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
  // scan's own patterns (PEM headers, mnemonics, WIF-shaped strings), plus two literal field
  // names (`"secret_key"` — `validator_key.json`'s own shape, `tests-near/helpers/sandbox.ts`'s
  // header comment: read once, straight into memory, never written to disk on the Windows side,
  // never logged, never returned from that module in any form — and `"private_key"`, the more
  // generic name other tooling around this repo uses for the same kind of value).
  //
  // P5-NEAR-FIXES.md D2 [C6]: a field-name-only scan is blind to a key hiding under any OTHER
  // name, or with no name at all (e.g. a raw value copy-pasted into a comment or a log line
  // captured verbatim). A length-based `ed25519:<base58 longer than N>` heuristic was tried first
  // for that gap and dropped: this build's own real captures legitimately contain PLENTY of
  // `ed25519:`-prefixed base58 strings over 50 characters that are not key material at all —
  // every NEAR block header's own `approvals` and every chunk's own `signature` field is
  // `ed25519:` + base58 of a 64-byte signature, the identical byte length (and so string length)
  // a `secret_key` (seed(32) || publicKey(32), also 64 bytes) would have. A bare length check on
  // an `ed25519:`-prefixed string cannot tell a routine, entirely public chain signature apart
  // from a leaked secret key.
  //
  // D2's actual fix replaces that abandoned length heuristic with two EXACT, cryptographic checks
  // — each derives a real ed25519 public key from candidate bytes and compares it byte-for-byte,
  // so (unlike a length or format heuristic) neither can be tripped by a routine public value
  // such as a block hash or a chain signature, only by bytes that are genuinely, verifiably a
  // secret key's own seed:
  //
  //   1. Any base58 token (`ed25519:`-prefixed or bare — `\bBASE58_TOKEN\b` below matches the
  //      base58 run either way, since `ed25519:`'s colon already breaks the token boundary) that
  //      decodes to exactly 64 bytes, whose first 32 bytes, run through ed25519's own public-key
  //      derivation, produce its own last 32 bytes — a NEAR `secret_key` wire value's exact shape
  //      (`seed(32) || publicKey(32)`). This is why a real signature is safe: a signature's own
  //      64 bytes are `R(32) || s(32)`, unrelated to any key derivation, so the check simply does
  //      not hold for one (confirmed below against this suite's own real captured signatures).
  //   2. Any bare 32-byte token (hex or base58, no distinguishing name — indistinguishable by
  //      shape alone from a random hash) whose derived public key matches a public key ALREADY
  //      known to belong to this same fixture (collected from every `ed25519:`-prefixed 32-byte
  //      value across the fixture's own files: account keys, node keys, access keys). A random
  //      hash deriving to a real key by chance has probability ~2^-256 — this is the "no false
  //      positives" property the fix list asks for, proven empirically by the "still passes on
  //      the committed fixtures" test below (those fixtures are full of 32-byte hashes: block
  //      hashes, chunk hashes, merkle roots, none of which derive to any of the fixture's own
  //      keys).
  const SUSPICIOUS_KEY_MATERIAL =
    /-----BEGIN|PRIVATE KEY|mnemonic|seed phrase|\bxprv[0-9A-Za-z]{100,}|\bcprv[0-9A-Za-z]{100,}|\btprv[0-9A-Za-z]{100,}|\b[c9][1-9A-HJ-NP-Za-km-z]{50,51}\b|"secret_key"|"private_key"/i;

  // 38..95 spans both a 32-byte value's own base58 encoding (~42-45 chars) and a 64-byte value's
  // (~86-88 chars); anything decoding to neither length is simply skipped by `scanForKeyMaterial`
  // below, so this range does not need to be tight.
  const BASE58_TOKEN = /[1-9A-HJ-NP-Za-km-z]{38,95}/g;
  const HEX32_TOKEN = /\b[0-9a-fA-F]{64}\b/g;
  const ED25519_PUBLIC_KEY_FIELD = /ed25519:([1-9A-HJ-NP-Za-km-z]{38,95})/g;

  function walkFixtures(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walkFixtures(full) : [full];
    });
  }

  function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function tryDecodeBase58(token: string): Uint8Array | null {
    try {
      return base58.decode(token);
    } catch {
      return null;
    }
  }

  function tryDeriveEd25519PublicKey(seed: Uint8Array): Uint8Array | null {
    if (seed.length !== 32) return null;
    try {
      return ed25519.getPublicKey(seed);
    } catch {
      return null;
    }
  }

  /** Check 2's own comparison set for one fixture: every `ed25519:`-prefixed value across
   *  `files` that decodes to exactly 32 bytes, base58-re-encoded so lookups are a plain string
   *  compare. */
  function collectKnownEd25519PublicKeys(files: readonly string[]): Set<string> {
    const known = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(ED25519_PUBLIC_KEY_FIELD)) {
        const decoded = tryDecodeBase58(m[1]);
        if (decoded && decoded.length === 32) known.add(base58.encode(decoded));
      }
    }
    return known;
  }

  /** The field-name/PEM/mnemonic/WIF heuristic plus D2's two derivation checks. Returns every
   *  reason `text` was flagged (empty when clean). `knownPublicKeys` is this fixture's own set
   *  from `collectKnownEd25519PublicKeys`, used only by check 2. */
  function scanForKeyMaterial(text: string, knownPublicKeys: ReadonlySet<string>): string[] {
    const reasons: string[] = [];

    if (SUSPICIOUS_KEY_MATERIAL.test(text)) {
      reasons.push("matches the field-name/PEM/mnemonic/WIF heuristic");
    }

    for (const m of text.matchAll(BASE58_TOKEN)) {
      const decoded = tryDecodeBase58(m[0]);
      if (!decoded) continue;

      if (decoded.length === 64) {
        const seed = decoded.slice(0, 32);
        const claimedPublicKey = decoded.slice(32, 64);
        const derived = tryDeriveEd25519PublicKey(seed);
        if (derived && bytesEqual(derived, claimedPublicKey)) {
          reasons.push(`a base58 token decodes to 64 bytes whose first 32 bytes derive its own last 32 (ed25519 secret-key shape): ${m[0].slice(0, 10)}...`);
        }
      } else if (decoded.length === 32) {
        const derived = tryDeriveEd25519PublicKey(decoded);
        if (derived && knownPublicKeys.has(base58.encode(derived))) {
          reasons.push(`a bare 32-byte base58 token derives a public key already present in this fixture: ${m[0].slice(0, 10)}...`);
        }
      }
    }

    for (const m of text.matchAll(HEX32_TOKEN)) {
      const derived = tryDeriveEd25519PublicKey(hexToBytes(m[0]));
      if (derived && knownPublicKeys.has(base58.encode(derived))) {
        reasons.push(`a bare 32-byte hex token derives a public key already present in this fixture: ${m[0].slice(0, 10)}...`);
      }
    }

    return reasons;
  }

  it("no committed fixture holds anything resembling a private key, ed25519 secret key, seed or mnemonic", () => {
    // Check 2 (bare 32-byte token vs. this fixture's own public keys) is scoped per top-level
    // scenario directory (`settled`/`refunded`/`refunded-b`) — each is its own independent
    // fixture, D-N10's own "raw/near/<hashLock>/..." per-swap layout.
    for (const scenarioDir of readdirSync(fixturesRoot)) {
      const root = join(fixturesRoot, scenarioDir);
      if (!statSync(root).isDirectory()) continue;
      const files = walkFixtures(root);
      const knownPublicKeys = collectKnownEd25519PublicKeys(files);
      for (const file of files) {
        const reasons = scanForKeyMaterial(readFileSync(file, "utf8"), knownPublicKeys);
        expect({ file, reasons }).toEqual({ file, reasons: [] });
      }
    }
  });

  // Pins that the extended scan actually catches a planted leak -- a scratch copy, never the
  // committed fixtures themselves (mirrors tests/btc-regtest-fixtures.test.ts's own H8 pin).
  // One test per shape D2 names explicitly.
  function withScratchFixture(build: (dir: string) => void, check: (files: string[], known: Set<string>) => void) {
    const scratch = mkdtempSync(join(tmpdir(), "flop-near-fixture-scan-"));
    try {
      mkdirSync(join(scratch, "raw", "rpc"), { recursive: true });
      build(scratch);
      const files = walkFixtures(scratch);
      check(files, collectKnownEd25519PublicKeys(files));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it("shape 1 (field name): flags a planted validator_key.json-shaped secret_key field", () => {
    withScratchFixture(
      (scratch) => {
        // validator_key.json's own real shape (a planted, never-real, sample value; too short to
        // trip either derivation check, so this is a pure field-name-heuristic pin).
        writeFileSync(
          join(scratch, "raw", "rpc", "planted-validator-key.json"),
          JSON.stringify({ account_id: "test.near", public_key: `ed25519:${"1".repeat(43)}`, secret_key: `ed25519:${"2".repeat(87)}` }),
        );
      },
      (files, known) => {
        const flagged = files.filter((f) => scanForKeyMaterial(readFileSync(f, "utf8"), known).length > 0);
        expect(flagged).toEqual([files.find((f) => f.endsWith("planted-validator-key.json"))!]);
      },
    );
  });

  it("shape 1b (field name): flags a planted private_key field (the generic name, not just NEAR's own secret_key)", () => {
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "planted-private-key.json"), JSON.stringify({ private_key: `ed25519:${"3".repeat(87)}` }));
      },
      (files, known) => {
        const [file] = files;
        expect(scanForKeyMaterial(readFileSync(file!, "utf8"), known).length).toBeGreaterThan(0);
      },
    );
  });

  it("shape 2 (64-byte derivation): flags a REAL secret_key value hiding under an unrelated field name, ed25519:-prefixed", () => {
    const seed = new Uint8Array(32).fill(11);
    const publicKey = ed25519.getPublicKey(seed);
    const secretKeyWire = `ed25519:${base58.encode(new Uint8Array([...seed, ...publicKey]))}`;
    withScratchFixture(
      (scratch) => {
        // No field literally named "secret_key" or "private_key" -- a field-name scan alone
        // would miss this; only the derivation check can catch it.
        writeFileSync(join(scratch, "raw", "rpc", "unlabeled.json"), JSON.stringify({ note: "just some value", blob: secretKeyWire }));
      },
      (files, known) => {
        const [file] = files;
        const reasons = scanForKeyMaterial(readFileSync(file!, "utf8"), known);
        expect(reasons.some((r) => r.includes("decodes to 64 bytes"))).toBe(true);
      },
    );
  });

  it("shape 2b (64-byte derivation): flags the same REAL secret key with no ed25519: prefix at all (bare base58)", () => {
    const seed = new Uint8Array(32).fill(12);
    const publicKey = ed25519.getPublicKey(seed);
    const bareSecretKey = base58.encode(new Uint8Array([...seed, ...publicKey]));
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "unlabeled-bare.json"), JSON.stringify({ blob: bareSecretKey }));
      },
      (files, known) => {
        const [file] = files;
        const reasons = scanForKeyMaterial(readFileSync(file!, "utf8"), known);
        expect(reasons.some((r) => r.includes("decodes to 64 bytes"))).toBe(true);
      },
    );
  });

  it("shape 3 (bare 32-byte seed vs. a known public key): flags a seed whose derived key matches a public key elsewhere in the SAME fixture", () => {
    const seed = new Uint8Array(32).fill(13);
    const publicKey = ed25519.getPublicKey(seed);
    withScratchFixture(
      (scratch) => {
        // The public key is revealed in one file (an ordinary account-key capture)...
        writeFileSync(join(scratch, "raw", "rpc", "account-key.json"), JSON.stringify({ public_key: `ed25519:${base58.encode(publicKey)}` }));
        // ...and its own bare seed leaks, unlabeled, in a completely different file -- no shared
        // field name, no ed25519: prefix, indistinguishable from a random 32-byte hash by shape
        // alone. Only the cross-file public-key match can catch it.
        writeFileSync(join(scratch, "raw", "rpc", "unrelated-log.json"), JSON.stringify({ some_hash: base58.encode(seed) }));
      },
      (files, known) => {
        expect(known.size).toBeGreaterThan(0); // sanity: the public key really was collected
        const flagged = files.filter((f) => scanForKeyMaterial(readFileSync(f, "utf8"), known).length > 0);
        expect(flagged).toEqual([join(files.find((f) => f.endsWith("unrelated-log.json"))!)]);
      },
    );
  });

  it("shape 3b (bare 32-byte seed vs. a known public key): the same seed, hex-encoded instead of base58", () => {
    const seed = new Uint8Array(32).fill(14);
    const publicKey = ed25519.getPublicKey(seed);
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "account-key.json"), JSON.stringify({ public_key: `ed25519:${base58.encode(publicKey)}` }));
        writeFileSync(join(scratch, "raw", "rpc", "unrelated-log.json"), JSON.stringify({ some_hash: Buffer.from(seed).toString("hex") }));
      },
      (files, known) => {
        const flagged = files.filter((f) => scanForKeyMaterial(readFileSync(f, "utf8"), known).length > 0);
        expect(flagged).toEqual([join(files.find((f) => f.endsWith("unrelated-log.json"))!)]);
      },
    );
  });

  it("a random 32-byte hash never derives to a public key it happens to share a fixture with (no false positive)", () => {
    const seed = new Uint8Array(32).fill(15);
    const publicKey = ed25519.getPublicKey(seed);
    const unrelatedHash = new Uint8Array(32).fill(16); // NOT this seed; NOT derived from it
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "account-key.json"), JSON.stringify({ public_key: `ed25519:${base58.encode(publicKey)}` }));
        writeFileSync(join(scratch, "raw", "rpc", "unrelated-log.json"), JSON.stringify({ some_hash: base58.encode(unrelatedHash) }));
      },
      (files, known) => {
        for (const f of files) expect(scanForKeyMaterial(readFileSync(f, "utf8"), known)).toEqual([]);
      },
    );
  });

  // A real captured NEAR signature (`ed25519:` + base58 of a 64-byte signature — the SAME string
  // length a secret key's own seed+pubkey encoding would have) must NOT be flagged: this is the
  // false-positive this file's own header comment documents empirically. Every committed fixture
  // already contains real block/chunk signatures of exactly this shape (block headers' own
  // `approvals`, chunks' own `signature`), so this assertion is checked directly against the
  // committed fixtures themselves, not a synthetic sample. Uses the full `scanForKeyMaterial`
  // (field-name heuristic AND both derivation checks), not just the field-name regex, since D2's
  // whole point is that the derivation check must ALSO clear a real signature — a signature's own
  // `R(32) || s(32)` bytes are not `seed || derivedPublicKey`, so check 1 does not hold for one.
  it("a real captured NEAR block/chunk signature (ed25519: + 64-byte base58, the same length a secret key would have) is not flagged", () => {
    const settledDir = join(fixturesRoot, "settled");
    const settledFiles = walkFixtures(settledDir);
    const knownPublicKeys = collectKnownEd25519PublicKeys(settledFiles);
    const rpcDir = join(settledDir, "raw", "rpc");
    const files = readdirSync(rpcDir).map((name) => join(rpcDir, name));
    const withSignature = files.filter((f) => /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/.test(readFileSync(f, "utf8")));
    expect(withSignature.length).toBeGreaterThan(0); // sanity: this fixture really does contain long ed25519 strings
    for (const f of withSignature) {
      expect(scanForKeyMaterial(readFileSync(f, "utf8"), knownPublicKeys)).toEqual([]);
    }
  });
});
