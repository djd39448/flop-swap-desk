// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs's EVM-leg wiring (P22-P24-EVM-SPEC.md §5): `loadRails` /
// `loadEvmCaptures` unit-tested directly, then the compiled CLI exercised end to end against
// a synthetic watch root shaped exactly like a live sweep with `options.rails.evm` configured
// would leave on disk — `rails.json`, `raw/evm/<hashLock>/*.json`, `raw/rpc/<sha256>.json` —
// proving the offline replay reaches the same verdict without ever opening a socket.

import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeFunctionData, encodeFunctionResult, type Address } from "viem";
import { dealRoom, encodeFrame, generateHashLock, makeAccept, makeOffer, OFFER_ROOM } from "@flop-labs/tclk";

import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { formatAccountLine } from "../src/rails/account-line.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";
import { identity, record } from "./helpers/identity.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadEvmCaptures, loadRails } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");

const buyer = identity("c1".repeat(32));
const seller = identity("c2".repeat(32));
const T0 = 1_758_000_000_000;
const MIN = 60_000;

function addr(tag: string): Address {
  const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
  return `0x${hex}` as Address;
}
const RAIL_CONTRACT = addr("evm-rail-contract");
const TOKEN = addr("usdc-token");
const BUYER_ADDR = addr("buyer-evm-addr");
const SELLER_ADDR = addr("seller-evm-addr");
const BLOCK_HASH = `0x${"cd".repeat(32)}`;

const EVM_CONFIG: EvmRailConfig = {
  pin: ANVIL_LOCAL_PIN,
  endpoint: "http://127.0.0.1:9999/rpc",
  contract: RAIL_CONTRACT,
  assets: { USDC: TOKEN },
};

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
/** P22-P24-EVM-FIXES-R3.md F2: this fixture file's own standard nonce — every fixture built
 *  here freezes it into `index.nonce`, and `evmId` embeds it, so the ordinary (non-tampered)
 *  case binds exactly as before F2 added the nonce segment. */
const NONCE = "aaaaaaaaaaaaaaaa";

/** P22-P24-EVM-FIXES-R2.md D1/P22-P24-EVM-FIXES-R3.md F2: the capture-bound id format every
 *  real capture now uses. */
function evmId(hashLock: string, checkedAtMs: number, n: number): string {
  return `${hashLock}:${checkedAtMs}:${NONCE}:${n}`;
}
function wireRow(rec: ReturnType<typeof record>) {
  return JSON.stringify({ seq: rec.seq, ts: new Date(rec.timestampMs).toISOString(), from: rec.sender, nonce: rec.nonce, sig: rec.signature, text: rec.line });
}
function dealRoomWire(rows: ReturnType<typeof record>[]) {
  return JSON.stringify({ messages: rows.map((r) => ({ seq: r.seq, ts: new Date(r.timestampMs).toISOString(), from: r.sender, nonce: r.nonce, sig: r.signature, text: r.line })) });
}

/** Build one leg-A-on-evm-htlc / leg-B-unlocked swap and everything a live sweep with
 *  `options.rails.evm` configured would have written under a watch root for it. */
function buildEvmFixture(contractAddress: Address) {
  const swapId = makeSwapId(buyer.did, "d00fd00fd00fd00f");
  const lock = generateHashLock();

  const legAOffer = makeOffer({
    from: buyer.did, role: "payer", amount: "1000", asset: "USDC", lock: "hash", rails: ["evm-htlc"],
    claimByMs: T0 + 45 * MIN, refundAfterMs: T0 + 60 * MIN, expiresMs: T0 + 30 * MIN,
    job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash });

  const legBOffer = makeOffer({
    from: seller.did, role: "payer", amount: "52070000", asset: "FLOP", lock: "hash", rails: ["flop-htlc"],
    claimByMs: T0 + 70 * MIN, refundAfterMs: T0 + 180 * MIN, expiresMs: T0 + 40 * MIN,
    job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash });

  const legATerms = offerAcceptLockTerms(legAOffer, legAAccept);

  const offerRows = [
    record(OFFER_ROOM, 1, T0, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, 2, T0 + 1 * MIN, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(legBAccept)),
  ];

  const dealRoomA = dealRoom(legAAccept.contract);
  const dealRoomARows = [
    record(dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame({
      type: "lock", from: buyer.did, contract: legAAccept.contract, rail: "evm-htlc", ref: lock.hash,
    })),
    record(dealRoomA, 2, T0 + 4.5 * MIN, seller, formatAccountLine({
      railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: SELLER_ADDR,
    })),
    record(dealRoomA, 3, T0 + 4.5 * MIN + 1, buyer, formatAccountLine({
      railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: BUYER_ADDR,
    })),
  ];

  const callResult = encodeFunctionResult({
    abi: EVM_HASH_RAIL_ABI,
    functionName: "locks",
    result: [BUYER_ADDR, SELLER_ADDR, TOKEN, BigInt(legATerms.amount), BigInt(legATerms.claimByMs), BigInt(legATerms.refundAfterMs), 1 /* Locked */],
  });
  const checkedAtMs = T0 + 5 * MIN;
  const chainIdBody = jsonRpcResult(evmId(lock.hash, checkedAtMs, 1), `0x${ANVIL_LOCAL_PIN.chainId.toString(16)}`);
  const blockBody = jsonRpcResult(evmId(lock.hash, checkedAtMs, 2), { number: "0x5", hash: BLOCK_HASH });
  const callBody = jsonRpcResult(evmId(lock.hash, checkedAtMs, 3), callResult);
  const callParams = [
    { to: EVM_CONFIG.contract, data: encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [lock.hash as `0x${string}`] }) },
    { blockHash: BLOCK_HASH },
  ];

  // P22-P24-EVM-FIXES.md A1: each exchange's own `requestBody` must actually ask for its
  // declared `method`/`params` — these three are what a real `CapturingRpc` would have sent,
  // never a placeholder, since `evmEvidence` now binds every read to its own request.
  // P22-P24-EVM-FIXES-R2.md D1: their ids are bound to this capture's own hashLock/checkedAtMs
  // (`CapturingRpc.setIdNamespace`), never a bare auto-incrementing integer.
  const index = {
    v: 1,
    rail: "evm-htlc",
    chainId: ANVIL_LOCAL_PIN.chainId,
    caip2: ANVIL_LOCAL_PIN.caip2,
    pin: ANVIL_LOCAL_PIN.name,
    endpoint: EVM_CONFIG.endpoint,
    contract: contractAddress,
    hashLock: lock.hash,
    checkedAtMs,
    finality: { mode: "tag", tag: "finalized" },
    config: EVM_CONFIG,
    nonce: NONCE,
    exchanges: [
      {
        method: "eth_chainId",
        params: [],
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: evmId(lock.hash, checkedAtMs, 1), method: "eth_chainId", params: [] }),
        responseSha256: sha256Hex(chainIdBody),
        atMs: T0,
      },
      {
        method: "eth_getBlockByNumber",
        params: ["finalized", false],
        requestBody: JSON.stringify({
          jsonrpc: "2.0",
          id: evmId(lock.hash, checkedAtMs, 2),
          method: "eth_getBlockByNumber",
          params: ["finalized", false],
        }),
        responseSha256: sha256Hex(blockBody),
        atMs: T0,
      },
      {
        method: "eth_call",
        params: callParams,
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: evmId(lock.hash, checkedAtMs, 3), method: "eth_call", params: callParams }),
        responseSha256: sha256Hex(callBody),
        atMs: T0,
      },
    ],
  };

  return { swapId, lock, legAOffer, legAAccept, legBOffer, legBAccept, legATerms, offerRows, dealRoomA, dealRoomARows, index, chainIdBody, blockBody, callBody };
}

async function writeWatchRoot(root: string, fixture: ReturnType<typeof buildEvmFixture>, opts: { rails?: unknown } = {}) {
  await mkdir(join(root, "raw", OFFER_ROOM), { recursive: true });
  await writeFile(join(root, "raw", OFFER_ROOM, "only.jsonl"), fixture.offerRows.map(wireRow).join("\n") + "\n");

  await mkdir(join(root, "raw", fixture.dealRoomA), { recursive: true });
  await writeFile(join(root, "raw", fixture.dealRoomA, "only.json"), dealRoomWire(fixture.dealRoomARows));

  await mkdir(join(root, "raw", "rpc"), { recursive: true });
  for (const [sha, body] of [
    [fixture.index.exchanges[0]!.responseSha256, fixture.chainIdBody],
    [fixture.index.exchanges[1]!.responseSha256, fixture.blockBody],
    [fixture.index.exchanges[2]!.responseSha256, fixture.callBody],
  ] as const) {
    await writeFile(join(root, "raw", "rpc", `${sha}.json`), body);
  }

  await mkdir(join(root, "raw", "evm", fixture.lock.hash), { recursive: true });
  await writeFile(join(root, "raw", "evm", fixture.lock.hash, "only.json"), JSON.stringify(fixture.index, null, 2));

  if (opts.rails !== undefined) {
    await writeFile(join(root, "rails.json"), JSON.stringify(opts.rails, null, 2));
  }
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "audit-export-evm-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadRails", () => {
  it("returns undefined when neither DIR/rails.json nor --rails exists", () => {
    expect(loadRails(root, undefined)).toBeUndefined();
  });

  it("reads DIR/rails.json when present", async () => {
    await writeFile(join(root, "rails.json"), JSON.stringify({ evm: EVM_CONFIG }));
    expect(loadRails(root, undefined)).toEqual({ evm: EVM_CONFIG });
  });

  it("an explicit override path takes precedence over DIR/rails.json", async () => {
    await writeFile(join(root, "rails.json"), JSON.stringify({ evm: { ...EVM_CONFIG, endpoint: "http://wrong" } }));
    const overridePath = join(root, "override-rails.json");
    await writeFile(overridePath, JSON.stringify({ evm: EVM_CONFIG }));
    expect(loadRails(root, overridePath)).toEqual({ evm: EVM_CONFIG });
  });

  it("throws when an explicit override path cannot be read", () => {
    expect(() => loadRails(root, join(root, "does-not-exist.json"))).toThrow(/cannot read --rails file/);
  });

  // P22-P24-EVM-FIXES.md A3: a rails config read off disk is just as untrusted as any other
  // file under --root, so it gets the same `checkEvmRailConfig` gate a live sweep's own
  // `--rails` file does.
  it("throws when DIR/rails.json's own evm config is invalid (chain id off the allow list)", async () => {
    const badConfig = { ...EVM_CONFIG, pin: { ...EVM_CONFIG.pin, chainId: 1, caip2: "eip155:1" } };
    await writeFile(join(root, "rails.json"), JSON.stringify({ evm: badConfig }));
    expect(() => loadRails(root, undefined)).toThrow(/evm rail config is invalid.*not on the allow list/);
  });

  it("throws when an explicit --rails override's own evm config is invalid", async () => {
    const overridePath = join(root, "override-rails.json");
    await writeFile(overridePath, JSON.stringify({ evm: { ...EVM_CONFIG, contract: "not-an-address" } }));
    expect(() => loadRails(root, overridePath)).toThrow(/evm rail config is invalid.*contract must be a 0x-address/);
  });
});

describe("loadEvmCaptures", () => {
  it("returns an empty map when raw/evm does not exist", async () => {
    expect((await loadEvmCaptures(root)).size).toBe(0);
  });

  it("loads the latest index per hashLock, with pre-verified raw/rpc bytes (P22-P24-EVM-FIXES.md A11)", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    await writeWatchRoot(root, fixture);

    const chain = await loadEvmCaptures(root);
    expect(chain.size).toBe(1);
    const capture = chain.get(fixture.lock.hash);
    expect(capture).toBeDefined();
    expect(capture.index.hashLock).toBe(fixture.lock.hash);

    const goodSha = fixture.index.exchanges[0]!.responseSha256;
    expect(new TextDecoder().decode(capture.bytes.get(goodSha))).toBe(fixture.chainIdBody);
    // A sha256 that was never written (or a tampered one) is "missing", never thrown.
    expect(capture.bytes.get("0".repeat(64)) ?? null).toBeNull();
  });

  // P22-P24-EVM-FIXES.md A5, as revised by the main-loop review after round 3: a corrupted
  // *latest* index file fails that leg closed (no capture for it, a note on the caller-supplied
  // array) and never falls back to an older capture; the whole replay still completes.
  it("fails the leg closed on a corrupted newest index and reports it via the notes array", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    await writeWatchRoot(root, fixture);
    // A newer, corrupted index file alongside the good one `writeWatchRoot` already wrote.
    await writeFile(join(root, "raw", "evm", fixture.lock.hash, "zzz-newer-but-corrupt.json"), "{ not valid json");

    const notes: string[] = [];
    const chain = await loadEvmCaptures(root, notes);
    expect(chain.size).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`raw/evm/${fixture.lock.hash}/zzz-newer-but-corrupt\\.json.*skipped`));
  });

  it("defaults to a private notes array when the caller does not supply one (backward compatible)", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    await writeWatchRoot(root, fixture);
    await expect(loadEvmCaptures(root)).resolves.toBeInstanceOf(Map);
  });
});

describe("examples/audit-export.mjs — evm-htlc leg end to end", () => {
  it("folds a captured, on-terms Locked read into settlementView 'funded' with an anvil-local finalizedRef", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    await writeWatchRoot(root, fixture, { rails: { evm: EVM_CONFIG } });

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("funded");
    expect(swap.finalizedRefs.some((ref: string) => ref.startsWith("anvil-local:finalized:5:"))).toBe(true);
  });

  it("--rails FILE overrides DIR/rails.json — a wrong contract in the on-disk file leaves the leg unverified until the override supplies the right one", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    const wrongConfig: EvmRailConfig = { ...EVM_CONFIG, contract: addr("a-different-contract") };
    await writeWatchRoot(root, fixture, { rails: { evm: wrongConfig } });

    const withoutOverride = run(["--root", root, "--json"]);
    expect(withoutOverride.status).toBe(0);
    const withoutSwap = JSON.parse(withoutOverride.stdout).swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(withoutSwap.settlementView.a).toBe("none"); // no rail: contract mismatch fails before a status is even read

    const overridePath = join(root, "override-rails.json");
    await writeFile(overridePath, JSON.stringify({ evm: EVM_CONFIG }));
    const withOverride = run(["--root", root, "--rails", overridePath, "--json"]);
    expect(withOverride.status).toBe(0);
    const withSwap = JSON.parse(withOverride.stdout).swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(withSwap.settlementView.a).toBe("funded");
  });

  it("a tampered raw/rpc file (bytes no longer hash to their own filename) leaves the leg unverified, never thrown", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    await writeWatchRoot(root, fixture, { rails: { evm: EVM_CONFIG } });

    const callSha = fixture.index.exchanges[2]!.responseSha256;
    await writeFile(join(root, "raw", "rpc", `${callSha}.json`), "tampered, does not match its own filename's hash");

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const swap = JSON.parse(result.stdout).swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("none"); // eth_call's own bytes failed to re-verify
    expect(swap.finalizedRefs).toEqual([]);
  });

  it("still opens no network connection with an EVM leg on disk (the CLI imports no fetch)", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    await writeWatchRoot(root, fixture, { rails: { evm: EVM_CONFIG } });
    // If this ever tried a real RPC call, EVM_CONFIG.endpoint (127.0.0.1:9999) would refuse
    // the connection (or hang) instead of returning promptly — no --expect here, since the
    // swap's exact status is sensitive to wall-clock time (leg B never locks); completing at
    // all, fast, is the point.
    const result = run(["--root", root]);
    expect(result.status).toBe(0);
  });

  // P22-P24-EVM-FIXES.md A3: the CLI itself, not just `loadRails` in isolation, exits 2 with
  // the reason when DIR/rails.json's own evm config is invalid.
  it("exits 2 with the reason when DIR/rails.json's evm config is invalid", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    const badConfig = { ...EVM_CONFIG, pin: { ...EVM_CONFIG.pin, chainId: 1, caip2: "eip155:1" } };
    await writeWatchRoot(root, fixture, { rails: { evm: badConfig } });

    const result = run(["--root", root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/evm rail config is invalid.*not on the allow list/);
  });

  // P22-P24-EVM-FIXES.md A5: a corrupted-but-fallen-back-from capture index is surfaced as a
  // note, and the replay still completes rather than treating it as fatal.
  it("prints an A5 note, still replays, and fails the leg closed when the newest capture index is corrupted", async () => {
    const fixture = buildEvmFixture(RAIL_CONTRACT);
    await writeWatchRoot(root, fixture, { rails: { evm: EVM_CONFIG } });
    await writeFile(join(root, "raw", "evm", fixture.lock.hash, "zzz-newer-but-corrupt.json"), "{ not valid json");

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.evmCaptureNotes).toHaveLength(1);
    expect(parsed.evmCaptureNotes[0]).toMatch(/zzz-newer-but-corrupt\.json.*skipped/);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    // Never falls back to the older, good index (main-loop review after round 3): that would
    // replay a previous sweep's verdict as current. The leg has no chain evidence.
    expect(swap.settlementView.a).toBe("none");

    const textResult = run(["--root", root]);
    expect(textResult.status).toBe(0);
    expect(textResult.stdout).toMatch(/zzz-newer-but-corrupt\.json.*skipped/);
  });
});
