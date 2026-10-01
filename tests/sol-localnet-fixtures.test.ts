// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs against the three committed solana-localnet capture fixtures (SB3b,
// P6-SOL-SPEC.md section 5): byte-exact, watch-root-shaped bundles of a real Seller/Buyer client-flow run
// (tests-sol/client-flows.sol.test.ts) against a real, local `solana-test-validator` with the reviewed
// `htlc.so` loaded at genesis (chain pin `solana-localnet-flop`), captured once
// (`CAPTURE_SOL_FIXTURES=1 npm run test:sol`) and replayed here with no network, no validator and no WSL
// (hermetic `npm test`). Mirrors tests/near-sandbox-fixtures.test.ts: `settled` and `refunded` exercise the
// Solana chain-evidence path (`raw/sol/<hash lock>/<leg contract>/`, `raw/rpc/`, `rails.json`) end to end;
// `refunded-b` (the Buyer never locks leg A) carries a live read of the chain that shows no escrow for the
// lock's ref, so it proves the paper-rail fold and the absence of any Solana lock or write. `npm test` builds `dist/` first, which this spawn depends on.
//
// The second half is the key-discipline scan: no committed fixture may hold a Solana private key in the shapes
// listed here. It is a scan for those shapes, NOT a proof that no key material exists. A bare length or format
// heuristic cannot tell a routine public value apart from key material (a transaction signature is 64 bytes of
// base58, exactly the length of a base58 keypair), so the scan uses EXACT checks, each deriving a real ed25519
// public key from candidate bytes and comparing it byte for byte:
//   - a token that decodes to 64 bytes whose first 32 bytes derive its last 32 (the keypair shape) in base58,
//     base64 (88 chars) and hex (128 chars);
//   - a bare 32-byte token in base58, hex or base64 (a seed) whose derived public key is one already present in
//     the same fixture scenario, where "present" means a base58 token that decodes to 32 bytes OR any 32-byte
//     window of any decoded base64 run (account data, transaction bytes: an address sits inside those as raw bytes).
// On top of those, two shape checks with no derivation: any JSON array of 64 numbers (the `solana-keygen` file
// format) and the field-name, PEM and mnemonic heuristics. Every shape has a planted-leak test, and the real
// captured signatures are shown NOT to be flagged. What it cannot see: a seed whose public key appears nowhere in
// its fixture scenario, a key split or otherwise transformed (encrypted, XOR-ed, chunked), or a 32-byte value
// hidden inside a larger decoded blob and never presented as a token of its own.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");
const fixturesRoot = join(repoRoot, "fixtures", "sol-localnet-2026-09-30");

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

interface Case {
  scenario: string;
  swapId: string;
  status: string;
  settlementView: { a: string; b: string };
}

// One entry per fixture directory under fixtures/sol-localnet-2026-09-30/ - swapId and expected
// status/settlementView as tests-sol/client-flows.sol.test.ts's own scenarios produced them (re-derive by
// running `node examples/audit-export.mjs --root <dir> --json` if the fixtures are ever recaptured,
// `CAPTURE_SOL_FIXTURES=1 npm run test:sol`).
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

describe("examples/audit-export.mjs - committed solana-localnet client-flow fixtures (2026-09-30)", () => {
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

  // The settled fixture's chain evidence names the localnet pin, finalized, plus the paper leg's own note hash.
  it("the settled fixture's chain evidence names the solana-localnet pin, finalized", () => {
    const result = run(["--root", join(fixturesRoot, "settled"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { swaps: Array<{ finalizedRefs: string[] }> };
    const [swap] = parsed.swaps;
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("solana-localnet-flop:final:"))).toBe(true);
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("paper:sha256:"))).toBe(true);
  });

  // The refunded fixture's own Solana leg names a finalized ref too (the refund's own slot, nothing borrowed).
  it("the refunded fixture's chain evidence names the solana-localnet pin, finalized", () => {
    const result = run(["--root", join(fixturesRoot, "refunded"), "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { swaps: Array<{ finalizedRefs: string[] }> };
    const [swap] = parsed.swaps;
    expect(swap?.finalizedRefs.some((ref) => ref.startsWith("solana-localnet-flop:final:"))).toBe(true);
  });

  it("refunded-b holds a live read of the chain that shows NO escrow for the lock's ref (and the rails.json the replay needs), and no Solana write", () => {
    const root = join(fixturesRoot, "refunded-b");
    const rails = JSON.parse(readFileSync(join(root, "rails.json"), "utf8")) as { sol?: { pin: { name: string } } };
    expect(rails.sol?.pin.name).toBe("solana-localnet-flop");
    expect(readdirSync(join(root, "raw", "sol"))).toHaveLength(1);
    // the escrow and the vault of the lock that was never made are both absent: their getAccountInfo replies are null
    const replies = readdirSync(join(root, "raw", "rpc")).map((name) => readFileSync(join(root, "raw", "rpc", name), "utf8"));
    const absent = replies.filter((text) => /"value":null/.test(text));
    expect(absent.length).toBeGreaterThanOrEqual(2);
    // and no claim or refund transaction exists: the evidence summary lists only the paper refund
    const summary = JSON.parse(readFileSync(join(root, "evidence", `${CASES[2]?.swapId}.json`), "utf8")) as { writes: Array<{ rail: string }> };
    expect(summary.writes.map((w) => w.rail)).toEqual(["paper"]);
  });

  it("settled and refunded hold a Solana capture keyed per leg contract and a rails.json naming the solana pin", () => {
    for (const scenario of ["settled", "refunded"]) {
      const root = join(fixturesRoot, scenario);
      const rails = JSON.parse(readFileSync(join(root, "rails.json"), "utf8")) as { sol?: { pin: { name: string } } };
      expect(rails.sol?.pin.name).toBe("solana-localnet-flop");
      const hashLocks = readdirSync(join(root, "raw", "sol"));
      expect(hashLocks).toHaveLength(1);
      const legContracts = readdirSync(join(root, "raw", "sol", hashLocks[0] as string));
      expect(legContracts).toHaveLength(1);
      expect(legContracts[0]).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  // P22-P24-EVM-FIXES.md B5's rule, reused verbatim for Solana (as for NEAR): every raw sha256 a fixture's
  // evidence summary names must resolve to real bytes under that fixture's own `raw/rpc/`, and those bytes must
  // actually re-hash to the name.
  for (const testCase of CASES) {
    it(`${testCase.scenario}: every raw hash in the evidence summary exists in raw/rpc and re-hashes`, () => {
      const evidencePath = join(fixturesRoot, testCase.scenario, "evidence", `${testCase.swapId}.json`);
      const summary = JSON.parse(readFileSync(evidencePath, "utf8")) as { writes: Array<{ evidence: { raw?: string[] } }> };
      const hashes = summary.writes.flatMap((write) => write.evidence.raw ?? []);
      // refunded-b makes no Solana write, so its only write is the paper-rail refund, which carries no raw hashes
      // (its chain read of the absent escrow is the capture under raw/sol).
      if (testCase.scenario === "refunded-b") {
        expect(hashes.length).toBe(0);
        return;
      }
      expect(hashes.length).toBeGreaterThan(0);
      for (const hash of hashes) {
        const bytes = readFileSync(join(fixturesRoot, testCase.scenario, "raw", "rpc", `${hash}.json`));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      }
    });
  }

  // -- the key-material scan ---------------------------------------------------------------------------------

  // (The Bitcoin fixture scan's WIF and xprv patterns are deliberately absent: Solana has neither, and a
  // base58-alphabet run of 51 characters starting with "9" occurs by chance inside the base64 of the captured
  // program data.)
  const SUSPICIOUS_KEY_MATERIAL = /-----BEGIN|PRIVATE KEY|mnemonic|seed phrase|"secret_key"|"private_key"|"secretKey"|"keypair"/i;

  // 38..95 spans a 32-byte value's base58 (43-44 chars) and a 64-byte value's (86-88 chars).
  const BASE58_TOKEN = /[1-9A-HJ-NP-Za-km-z]{38,95}/g;
  // A base64 run long enough to hold 64 bytes (88 chars with padding; 86 without).
  const BASE64_TOKEN = /[A-Za-z0-9+/]{86,88}(?:==)?/g;
  const HEX32_TOKEN = /\b[0-9a-fA-F]{64}\b/g;
  // A 128-hex token: the keypair (seed then public key) written as hex.
  const HEX64_TOKEN = /\b[0-9a-fA-F]{128}\b/g;
  // A bare 32-byte value in base64: 43 characters, or 44 with its one `=` (a seed or a public key).
  const BASE64_32_TOKEN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{43}=?(?![A-Za-z0-9+/=])/g;
  // Any base64 run that can hold at least a 32-byte value: account data and signed transactions live in these.
  const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43,}={0,2}/g;
  // A JSON array of exactly 64 small non-negative integers: the `solana-keygen` keypair file format.
  const JSON_64_NUMBERS = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

  function walkFixtures(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walkFixtures(full) : [full];
    });
  }

  function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function tryBase58(token: string): Uint8Array | null {
    try {
      return base58.decode(token);
    } catch {
      return null;
    }
  }

  function tryBase64(token: string): Uint8Array | null {
    try {
      return base64.decode(token.length % 4 === 0 ? token : token + "=".repeat(4 - (token.length % 4)));
    } catch {
      return null;
    }
  }

  function derive(seed: Uint8Array): Uint8Array | null {
    if (seed.length !== 32) return null;
    try {
      return ed25519.getPublicKey(seed);
    } catch {
      return null;
    }
  }

  /** The keypair shape: 64 bytes whose first 32 derive its last 32. */
  function isKeypair(bytes: Uint8Array): boolean {
    if (bytes.length !== 64) return false;
    const derived = derive(bytes.slice(0, 32));
    return derived !== null && equalBytes(derived, bytes.slice(32, 64));
  }

  /** The public keys present in `files`, as hex keys (a Solana address IS the ed25519 public key): every base58
   *  token that decodes to exactly 32 bytes, and every 32-byte window of every decoded base64 run (an address sits
   *  inside account data and inside a signed transaction as raw bytes, and is never a token of its own there). */
  function collectKnownPublicKeys(files: readonly string[]): Set<string> {
    const known = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(BASE58_TOKEN)) {
        const decoded = tryBase58(m[0]);
        if (decoded !== null && decoded.length === 32) known.add(bytesToHex(decoded));
      }
      for (const m of text.matchAll(BASE64_RUN)) {
        const decoded = tryBase64(m[0]);
        if (decoded === null) continue;
        for (let offset = 0; offset + 32 <= decoded.length; offset += 1) known.add(bytesToHex(decoded.subarray(offset, offset + 32)));
      }
    }
    return known;
  }

  /** `true` when the public key derived from `seed` (32 bytes) is one already present in this fixture scenario. */
  function seedDerivesKnownKey(seed: Uint8Array, knownPublicKeys: ReadonlySet<string>): boolean {
    const derived = derive(seed);
    return derived !== null && knownPublicKeys.has(bytesToHex(derived));
  }

  /** Every reason `text` was flagged (empty when clean). `knownPublicKeys` is this fixture's own set. */
  function scanForKeyMaterial(text: string, knownPublicKeys: ReadonlySet<string>): string[] {
    const reasons: string[] = [];
    if (SUSPICIOUS_KEY_MATERIAL.test(text)) reasons.push("matches the field-name/PEM/mnemonic heuristic");

    for (const m of text.matchAll(JSON_64_NUMBERS)) {
      const numbers = m[0].slice(1, -1).split(",").map((n) => Number.parseInt(n.trim(), 10));
      if (numbers.every((n) => n >= 0 && n <= 255)) reasons.push("a JSON array of 64 numbers (the solana-keygen keypair file format)");
    }

    for (const m of text.matchAll(BASE58_TOKEN)) {
      const decoded = tryBase58(m[0]);
      if (decoded === null) continue;
      if (decoded.length === 64 && isKeypair(decoded)) {
        reasons.push(`a base58 token decodes to 64 bytes whose first 32 bytes derive its own last 32 (keypair shape): ${m[0].slice(0, 8)}...`);
      } else if (decoded.length === 32 && seedDerivesKnownKey(decoded, knownPublicKeys)) {
        reasons.push(`a bare 32-byte base58 token derives a public key already present in this fixture: ${m[0].slice(0, 8)}...`);
      }
    }

    for (const m of text.matchAll(BASE64_TOKEN)) {
      const decoded = tryBase64(m[0]);
      if (decoded !== null && isKeypair(decoded)) reasons.push(`a base64 token decodes to a keypair: ${m[0].slice(0, 8)}...`);
    }

    for (const m of text.matchAll(BASE64_32_TOKEN)) {
      const decoded = tryBase64(m[0]);
      if (decoded !== null && decoded.length === 32 && seedDerivesKnownKey(decoded, knownPublicKeys)) {
        reasons.push(`a bare 32-byte base64 token derives a public key already present in this fixture: ${m[0].slice(0, 8)}...`);
      }
    }

    for (const m of text.matchAll(HEX32_TOKEN)) {
      if (seedDerivesKnownKey(hexToBytes(m[0]), knownPublicKeys)) {
        reasons.push(`a bare 32-byte hex token derives a public key already present in this fixture: ${m[0].slice(0, 8)}...`);
      }
    }

    for (const m of text.matchAll(HEX64_TOKEN)) {
      if (isKeypair(hexToBytes(m[0]))) reasons.push(`a 128-hex token is a keypair (first 32 bytes derive the last 32): ${m[0].slice(0, 8)}...`);
    }
    return reasons;
  }

  it("no committed fixture holds anything resembling a private key, keypair, seed or mnemonic", () => {
    // The seed-versus-known-public-key check is scoped per top-level scenario directory: each is an independent
    // fixture.
    let scanned = 0;
    for (const scenarioDir of readdirSync(fixturesRoot)) {
      const root = join(fixturesRoot, scenarioDir);
      if (!statSync(root).isDirectory()) continue;
      const files = walkFixtures(root);
      const known = collectKnownPublicKeys(files);
      for (const file of files) {
        scanned += 1;
        expect({ file, reasons: scanForKeyMaterial(readFileSync(file, "utf8"), known) }).toEqual({ file, reasons: [] });
      }
    }
    expect(scanned).toBeGreaterThan(20);
  });

  // Pins that the scan actually catches a planted leak - a scratch copy, never the committed fixtures.
  function withScratchFixture(build: (dir: string) => void, check: (files: string[], known: Set<string>) => void) {
    const scratch = mkdtempSync(join(tmpdir(), "flop-sol-fixture-scan-"));
    try {
      mkdirSync(join(scratch, "raw", "rpc"), { recursive: true });
      build(scratch);
      const files = walkFixtures(scratch);
      check(files, collectKnownPublicKeys(files));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const keypairOf = (fill: number) => {
    const seed = new Uint8Array(32).fill(fill);
    return { seed, publicKey: ed25519.getPublicKey(seed), keypair: Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]) };
  };
  const flagged = (files: string[], known: Set<string>): string[] => files.filter((f) => scanForKeyMaterial(readFileSync(f, "utf8"), known).length > 0);

  it("shape 1 (field name): flags a planted secretKey / private_key field", () => {
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "planted-a.json"), JSON.stringify({ secretKey: "x" }));
        writeFileSync(join(scratch, "raw", "rpc", "planted-b.json"), JSON.stringify({ private_key: "x" }));
      },
      (files, known) => expect(flagged(files, known)).toHaveLength(2),
    );
  });

  it("shape 2 (base58 keypair): flags a REAL 64-byte keypair hiding under an unrelated field name", () => {
    const { keypair } = keypairOf(11);
    withScratchFixture(
      (scratch) => writeFileSync(join(scratch, "raw", "rpc", "unlabeled.json"), JSON.stringify({ note: "just some value", blob: base58.encode(keypair) })),
      (files, known) => {
        const reasons = scanForKeyMaterial(readFileSync(files[0] as string, "utf8"), known);
        expect(reasons.some((r) => r.includes("decodes to 64 bytes"))).toBe(true);
      },
    );
  });

  it("shape 3 (JSON array of 64 numbers): flags the solana-keygen file format", () => {
    const { keypair } = keypairOf(12);
    withScratchFixture(
      (scratch) => writeFileSync(join(scratch, "raw", "rpc", "id.json"), JSON.stringify(Array.from(keypair))),
      (files, known) => {
        const reasons = scanForKeyMaterial(readFileSync(files[0] as string, "utf8"), known);
        expect(reasons.some((r) => r.includes("64 numbers"))).toBe(true);
      },
    );
  });

  it("shape 4 (base64 keypair): flags a 64-byte keypair in base64", () => {
    const { keypair } = keypairOf(13);
    withScratchFixture(
      (scratch) => writeFileSync(join(scratch, "raw", "rpc", "b64.json"), JSON.stringify({ data: [base64.encode(keypair), "base64"] })),
      (files, known) => {
        const reasons = scanForKeyMaterial(readFileSync(files[0] as string, "utf8"), known);
        expect(reasons.some((r) => r.includes("base64 token decodes to a keypair"))).toBe(true);
      },
    );
  });

  it("shape 5 (bare seed vs a known public key): flags a seed, in base58 or hex, whose public key is elsewhere in the SAME fixture", () => {
    const { seed, publicKey } = keypairOf(14);
    withScratchFixture(
      (scratch) => {
        // The public key is an ordinary account address in one file (as every wallet address is)...
        writeFileSync(join(scratch, "raw", "rpc", "account.json"), JSON.stringify({ address: base58.encode(publicKey) }));
        // ...and its own bare seed leaks, unlabeled, in two other files.
        writeFileSync(join(scratch, "raw", "rpc", "leak-b58.json"), JSON.stringify({ some_hash: base58.encode(seed) }));
        writeFileSync(join(scratch, "raw", "rpc", "leak-hex.json"), JSON.stringify({ some_hash: Buffer.from(seed).toString("hex") }));
      },
      (files, known) => {
        expect(known.size).toBeGreaterThan(0);
        expect(flagged(files, known).map((f) => f.split(/[\\/]/).pop())).toEqual(["leak-b58.json", "leak-hex.json"]);
      },
    );
  });

  it("shape 6 (128-hex keypair): flags a keypair written as 128 hex characters under an unrelated field name", () => {
    const { keypair } = keypairOf(17);
    withScratchFixture(
      (scratch) => writeFileSync(join(scratch, "raw", "rpc", "hex-keypair.json"), JSON.stringify({ note: "a value", blob: Buffer.from(keypair).toString("hex") })),
      (files, known) => {
        const reasons = scanForKeyMaterial(readFileSync(files[0] as string, "utf8"), known);
        expect(reasons.some((r) => r.includes("128-hex token is a keypair"))).toBe(true);
      },
    );
  });

  it("shape 7 (base64 32-byte seed): flags a seed in base64 (padded and unpadded) whose public key is elsewhere in the SAME fixture", () => {
    const { seed, publicKey } = keypairOf(18);
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "account.json"), JSON.stringify({ address: base58.encode(publicKey) }));
        writeFileSync(join(scratch, "raw", "rpc", "leak-b64.json"), JSON.stringify({ some_hash: base64.encode(seed) }));
        writeFileSync(join(scratch, "raw", "rpc", "leak-b64-unpadded.json"), JSON.stringify({ some_hash: base64.encode(seed).replace(/=+$/, "") }));
      },
      (files, known) => {
        expect(flagged(files, known).map((f) => f.split(/[\\/]/).pop())).toEqual(["leak-b64-unpadded.json", "leak-b64.json"]);
      },
    );
  });

  it("shape 8 (public key found only in decoded bytes): a seed whose public key sits inside a base64 blob (account data) is flagged, in every encoding", () => {
    const { seed, publicKey } = keypairOf(19);
    // the address is never a token of its own: it is raw bytes in the middle of a base64 account-data blob
    const blob = Uint8Array.from([...new Uint8Array(40).fill(7), ...publicKey, ...new Uint8Array(51).fill(9)]);
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "account-data.json"), JSON.stringify({ data: [base64.encode(blob), "base64"] }));
        writeFileSync(join(scratch, "raw", "rpc", "leak-b58.json"), JSON.stringify({ x: base58.encode(seed) }));
        writeFileSync(join(scratch, "raw", "rpc", "leak-hex.json"), JSON.stringify({ x: Buffer.from(seed).toString("hex") }));
        writeFileSync(join(scratch, "raw", "rpc", "leak-b64.json"), JSON.stringify({ x: base64.encode(seed) }));
      },
      (files, known) => {
        expect(known.has(bytesToHex(publicKey))).toBe(true);
        expect(flagged(files, known).map((f) => f.split(/[\\/]/).pop())).toEqual(["leak-b58.json", "leak-b64.json", "leak-hex.json"]);
      },
    );
  });

  it("no false positive: a random 32-byte hash that is not a seed of any public key in the fixture is not flagged", () => {
    const { publicKey } = keypairOf(15);
    withScratchFixture(
      (scratch) => {
        writeFileSync(join(scratch, "raw", "rpc", "account.json"), JSON.stringify({ address: base58.encode(publicKey) }));
        writeFileSync(
          join(scratch, "raw", "rpc", "unrelated.json"),
          JSON.stringify({
            hash: base58.encode(new Uint8Array(32).fill(16)),
            hex: Buffer.from(new Uint8Array(32).fill(16)).toString("hex"),
            hex64: Buffer.from(new Uint8Array(64).fill(17)).toString("hex"),
            b64: base64.encode(new Uint8Array(32).fill(16)),
            array: [1, 2, 3],
          }),
        );
      },
      (files, known) => expect(flagged(files, known)).toEqual([]),
    );
  });

  // A real captured transaction signature (base58 of 64 bytes - the same length a base58 keypair has) must NOT be
  // flagged: the derivation check does not hold for `R(32) || s(32)`. Every committed capture is full of them
  // (sendTransaction replies, getSignatureStatuses), so this is checked against the committed fixtures themselves.
  it("a real captured transaction signature (64 bytes of base58, the same length a keypair would have) is not flagged", () => {
    const dir = join(fixturesRoot, "settled");
    const files = walkFixtures(dir);
    const known = collectKnownPublicKeys(files);
    let signatures = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(BASE58_TOKEN)) {
        const decoded = tryBase58(m[0]);
        if (decoded !== null && decoded.length === 64) {
          signatures += 1;
          expect(isKeypair(decoded)).toBe(false);
        }
      }
      expect(scanForKeyMaterial(text, known)).toEqual([]);
    }
    expect(signatures).toBeGreaterThan(0); // sanity: the fixture really does contain 64-byte base58 tokens
  });
});
