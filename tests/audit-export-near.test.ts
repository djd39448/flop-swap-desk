// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs's near-htlc-leg wiring (P5-NEAR-SPEC.md §4): `loadRails` /
// `loadNearCaptures` unit-tested directly, then the compiled CLI exercised end to end against a
// synthetic watch root shaped exactly like a live sweep with `options.rails.near` configured
// would leave on disk — `rails.json`, `raw/near/<hashLock>/*.json`, `raw/rpc/<sha256>.json` —
// proving the offline replay reaches the same verdict without ever opening a socket. Mirrors
// tests/audit-export-btc.test.ts's own structure, adapted for near-htlc's own D-N10 fixed read
// sequence (status, block(final), get_lock, storage_balance_of) and its account-id (not pubkey)
// accounts.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { dealRoom, encodeFrame, generateHashLock, makeAccept, makeOffer, OFFER_ROOM } from "@flop-labs/tclk";

import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { formatAccountLine } from "../src/rails/account-line.js";
import { NEAR_SANDBOX_PIN, type NearRailConfig } from "../src/rails/near-htlc.js";
import { nearCaptureKey } from "../src/rails/near-evidence.js";
import { identity, record } from "./helpers/identity.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadNearCaptures, loadRails } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");

const buyer = identity("d3".repeat(32));
const seller = identity("d4".repeat(32));
const T0 = 1_758_000_000_000;
const MIN = 60_000;

const CONTRACT_ACCOUNT = "htlc.near-sandbox-flop";
const USDC_ACCOUNT = "usdc.near-sandbox-flop";
const PAYER_ACCOUNT = "buyer.near-sandbox-flop"; // buyer
const PAYEE_ACCOUNT = "seller.near-sandbox-flop"; // seller
const AMOUNT = "1000000";
const BLOCK_HEIGHT = 42;
const BLOCK_HASH = "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM"; // a real 32-byte base58 value
const TIMESTAMP_NS = "1700000500000000000";

// H6: any well-formed base58 string — this file never exercises H6's own on-chain code-hash
// check (that lives in near-htlc.ts's connect(), never reached by the offline audit-export CLI).
const HTLC_CODE_HASH = "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT";
const NEAR_CONFIG: NearRailConfig = {
  pin: NEAR_SANDBOX_PIN,
  endpoint: "http://127.0.0.1:9999",
  contract: CONTRACT_ACCOUNT,
  assets: { USDC: USDC_ACCOUNT },
  htlcCodeHash: HTLC_CODE_HASH,
};

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function argsBase64(payload: unknown): string {
  return Buffer.from(new TextEncoder().encode(JSON.stringify(payload))).toString("base64");
}
function resultBytesOf(payload: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(payload)));
}
const NONCE = "eeeeeeeeeeeeeeee";
function nearId(ref: string, checkedAtMs: number, n: number): string {
  return `${ref}:${checkedAtMs}:${NONCE}:${n}`;
}
function wireRow(rec: ReturnType<typeof record>) {
  return JSON.stringify({ seq: rec.seq, ts: new Date(rec.timestampMs).toISOString(), from: rec.sender, nonce: rec.nonce, sig: rec.signature, text: rec.line });
}
function dealRoomWire(rows: ReturnType<typeof record>[]) {
  return JSON.stringify({ messages: rows.map((r) => ({ seq: r.seq, ts: new Date(r.timestampMs).toISOString(), from: r.sender, nonce: r.nonce, sig: r.signature, text: r.line })) });
}

/** Build one leg-A-on-near-htlc / leg-B-unlocked swap and everything a live sweep with
 *  `options.rails.near` configured would have written under a watch root for it. */
function buildNearFixture(opts: { capturePayer?: string } = {}) {
  const swapId = makeSwapId(buyer.did, "f00ff00ff00ff00f");
  const lock = generateHashLock();
  const hashLock = lock.hash;
  // Squatting fix: the ref is 0x<hash lock>:<payer>. The lock frame always names the Buyer; a test
  // can make the CAPTURE read another payer pair (a squatter) under the same hash lock.
  const frameRef = `${hashLock}:${PAYER_ACCOUNT}`;
  const capturePayer = opts.capturePayer ?? PAYER_ACCOUNT;
  const nearRef = `${hashLock}:${capturePayer}`;

  const legAOffer = makeOffer({
    from: buyer.did, role: "payer", amount: AMOUNT, asset: "USDC", lock: "hash", rails: ["near-htlc"],
    claimByMs: T0 + 45 * MIN, refundAfterMs: T0 + 60 * MIN, expiresMs: T0 + 30 * MIN,
    job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: hashLock });

  const legBOffer = makeOffer({
    from: seller.did, role: "payer", amount: "52070000", asset: "FLOP", lock: "hash", rails: ["flop-htlc"],
    claimByMs: T0 + 70 * MIN, refundAfterMs: T0 + 180 * MIN, expiresMs: T0 + 40 * MIN,
    job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: hashLock });

  const legATerms = offerAcceptLockTerms(legAOffer, legAAccept);

  const offerRows = [
    record(OFFER_ROOM, 1, T0, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, 2, T0 + 1 * MIN, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(legBAccept)),
  ];

  // D-N5, mirroring P4-BTC-FIXES-R2.md R2-3: account lines before the lock frame, matching the
  // real client flows (both parties post their own account-id line, THEN the Buyer locks and
  // posts the lock frame) and `replay.ts`'s own `beforeSeq: accepted.seq` rule.
  const dealRoomA = dealRoom(legAAccept.contract);
  const dealRoomARows = [
    record(dealRoomA, 1, T0 + 4 * MIN, seller, formatAccountLine({ railId: "near-htlc", caip2: NEAR_SANDBOX_PIN.caip2, address: PAYEE_ACCOUNT })),
    record(dealRoomA, 2, T0 + 4 * MIN + 1, buyer, formatAccountLine({ railId: "near-htlc", caip2: NEAR_SANDBOX_PIN.caip2, address: PAYER_ACCOUNT })),
    record(dealRoomA, 3, T0 + 4.5 * MIN, buyer, encodeFrame({
      type: "lock", from: buyer.did, contract: legAAccept.contract, rail: "near-htlc", ref: frameRef,
    })),
  ];

  const checkedAtMs = T0 + 5 * MIN;

  const lockViewPayload = {
    status: "Locked",
    payer: capturePayer,
    payee: PAYEE_ACCOUNT,
    token: USDC_ACCOUNT,
    amount: AMOUNT,
    claim_by_ms: String(legATerms.claimByMs),
    refund_after_ms: String(legATerms.refundAfterMs),
  };
  const storageBalancePayload = { total: "1250000000000000000000", available: "0" };

  const statusBody = jsonRpcResult(nearId(nearRef, checkedAtMs, 1), { chain_id: NEAR_SANDBOX_PIN.chainId, protocol_version: 86, sync_info: {} });
  const blockBody = jsonRpcResult(nearId(nearRef, checkedAtMs, 2), { header: { height: BLOCK_HEIGHT, hash: BLOCK_HASH, timestamp_nanosec: TIMESTAMP_NS } });
  const getLockBody = jsonRpcResult(nearId(nearRef, checkedAtMs, 3), { result: resultBytesOf(lockViewPayload), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  // H8: the contract's own code hash and key list at the same block (positions 3 and 4).
  const accountBody = jsonRpcResult(nearId(nearRef, checkedAtMs, 4), {
    amount: "1000000000000000000000000",
    locked: "0",
    code_hash: NEAR_CONFIG.htlcCodeHash,
    storage_usage: 200000,
    storage_paid_at: 0,
    block_height: BLOCK_HEIGHT,
    block_hash: BLOCK_HASH,
  });
  const keysBody = jsonRpcResult(nearId(nearRef, checkedAtMs, 5), { keys: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  const storageBody = jsonRpcResult(nearId(nearRef, checkedAtMs, 6), { result: resultBytesOf(storageBalancePayload), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });

  // D-N10's fixed read order: status, block(final), get_lock (pinned to that block hash),
  // view_account and view_access_key_list of the contract (H8), storage_balance_of (pinned to the
  // same block hash) — mirroring evm-evidence's own A1/D1
  // binding rules: each exchange's own `requestBody` must actually ask for its declared
  // `method`/`params`, and every id is bound to this capture's own ref/checkedAtMs/nonce.
  const index = {
    v: 1,
    rail: "near-htlc",
    ref: nearRef,
    pin: NEAR_CONFIG.pin.name,
    caip2: NEAR_CONFIG.pin.caip2,
    endpoint: NEAR_CONFIG.endpoint,
    checkedAtMs,
    config: NEAR_CONFIG,
    nonce: NONCE,
    exchanges: [
      {
        method: "status",
        params: [],
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: nearId(nearRef, checkedAtMs, 1), method: "status", params: [] }),
        responseSha256: sha256Hex(statusBody),
        atMs: T0,
      },
      {
        method: "block",
        params: { finality: "final" },
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: nearId(nearRef, checkedAtMs, 2), method: "block", params: { finality: "final" } }),
        responseSha256: sha256Hex(blockBody),
        atMs: T0,
      },
      {
        method: "query",
        params: { request_type: "call_function", account_id: CONTRACT_ACCOUNT, method_name: "get_lock", args_base64: argsBase64({ hash_lock: hashLock.slice(2), payer: capturePayer }), block_id: BLOCK_HASH },
        requestBody: JSON.stringify({
          jsonrpc: "2.0",
          id: nearId(nearRef, checkedAtMs, 3),
          method: "query",
          params: { request_type: "call_function", account_id: CONTRACT_ACCOUNT, method_name: "get_lock", args_base64: argsBase64({ hash_lock: hashLock.slice(2), payer: capturePayer }), block_id: BLOCK_HASH },
        }),
        responseSha256: sha256Hex(getLockBody),
        atMs: T0,
      },
      {
        method: "query",
        params: { request_type: "view_account", account_id: CONTRACT_ACCOUNT, block_id: BLOCK_HASH },
        requestBody: JSON.stringify({
          jsonrpc: "2.0",
          id: nearId(nearRef, checkedAtMs, 4),
          method: "query",
          params: { request_type: "view_account", account_id: CONTRACT_ACCOUNT, block_id: BLOCK_HASH },
        }),
        responseSha256: sha256Hex(accountBody),
        atMs: T0,
      },
      {
        method: "query",
        params: { request_type: "view_access_key_list", account_id: CONTRACT_ACCOUNT, block_id: BLOCK_HASH },
        requestBody: JSON.stringify({
          jsonrpc: "2.0",
          id: nearId(nearRef, checkedAtMs, 5),
          method: "query",
          params: { request_type: "view_access_key_list", account_id: CONTRACT_ACCOUNT, block_id: BLOCK_HASH },
        }),
        responseSha256: sha256Hex(keysBody),
        atMs: T0,
      },
      {
        method: "query",
        params: { request_type: "call_function", account_id: USDC_ACCOUNT, method_name: "storage_balance_of", args_base64: argsBase64({ account_id: PAYEE_ACCOUNT }), block_id: BLOCK_HASH },
        requestBody: JSON.stringify({
          jsonrpc: "2.0",
          id: nearId(nearRef, checkedAtMs, 6),
          method: "query",
          params: { request_type: "call_function", account_id: USDC_ACCOUNT, method_name: "storage_balance_of", args_base64: argsBase64({ account_id: PAYEE_ACCOUNT }), block_id: BLOCK_HASH },
        }),
        responseSha256: sha256Hex(storageBody),
        atMs: T0,
      },
    ],
  };

  // E1: `legAAccept.contract` is the leg contract id — the second half of `loadNearCapture`'s
  // (hashLock, legContract) key, exactly the value `src/watcher.ts` passes as `candidate.contract`.
  return {
    swapId, hashLock, ref: nearRef, legContract: legAAccept.contract, legAOffer, legAAccept, legBOffer, legBAccept, legATerms,
    offerRows, dealRoomA, dealRoomARows, index, statusBody, blockBody, getLockBody, accountBody, keysBody, storageBody,
  };
}

async function writeWatchRoot(root: string, fixture: ReturnType<typeof buildNearFixture>, opts: { rails?: unknown } = {}) {
  await mkdir(join(root, "raw", OFFER_ROOM), { recursive: true });
  await writeFile(join(root, "raw", OFFER_ROOM, "only.jsonl"), fixture.offerRows.map(wireRow).join("\n") + "\n");

  await mkdir(join(root, "raw", fixture.dealRoomA), { recursive: true });
  await writeFile(join(root, "raw", fixture.dealRoomA, "only.json"), dealRoomWire(fixture.dealRoomARows));

  await mkdir(join(root, "raw", "rpc"), { recursive: true });
  for (const [sha, body] of [
    [fixture.index.exchanges[0]!.responseSha256, fixture.statusBody],
    [fixture.index.exchanges[1]!.responseSha256, fixture.blockBody],
    [fixture.index.exchanges[2]!.responseSha256, fixture.getLockBody],
    [fixture.index.exchanges[3]!.responseSha256, fixture.accountBody],
    [fixture.index.exchanges[4]!.responseSha256, fixture.keysBody],
    [fixture.index.exchanges[5]!.responseSha256, fixture.storageBody],
  ] as const) {
    await writeFile(join(root, "raw", "rpc", `${sha}.json`), body);
  }

  // E1: `raw/near/<hashLock>/<legContract>/*.json` — never `<hashLock>/*.json` directly.
  await mkdir(join(root, "raw", "near", fixture.hashLock, fixture.legContract), { recursive: true });
  await writeFile(join(root, "raw", "near", fixture.hashLock, fixture.legContract, "only.json"), JSON.stringify(fixture.index, null, 2));

  if (opts.rails !== undefined) {
    await writeFile(join(root, "rails.json"), JSON.stringify(opts.rails, null, 2));
  }
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "audit-export-near-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadRails — near", () => {
  it("reads DIR/rails.json's near config when present", async () => {
    await writeFile(join(root, "rails.json"), JSON.stringify({ near: NEAR_CONFIG }));
    expect(loadRails(root, undefined)).toEqual({ near: NEAR_CONFIG });
  });

  // P5-NEAR-SPEC.md §4, mirroring A3 for evm/btc: a rails config read off disk is just as
  // untrusted as any other file under --root, so it gets the same `checkNearRailConfig` gate a
  // live sweep's own `--rails` file does.
  it("throws when DIR/rails.json's own near config is invalid (chain id off the allow list)", async () => {
    const badConfig = { ...NEAR_CONFIG, pin: { ...NEAR_CONFIG.pin, chainId: "mainnet", caip2: "near:mainnet" } };
    await writeFile(join(root, "rails.json"), JSON.stringify({ near: badConfig }));
    expect(() => loadRails(root, undefined)).toThrow(/near rail config is invalid.*not on the allow list/);
  });

  it("reads evm, btc and near from the same file", async () => {
    await writeFile(join(root, "rails.json"), JSON.stringify({ near: NEAR_CONFIG }));
    const parsed = loadRails(root, undefined);
    expect(parsed.near).toEqual(NEAR_CONFIG);
  });
});

describe("loadNearCaptures", () => {
  it("returns an empty map when raw/near does not exist", async () => {
    expect((await loadNearCaptures(root)).size).toBe(0);
  });

  it("loads the latest index per hash lock, with pre-verified raw/rpc bytes", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture);

    const chain = await loadNearCaptures(root);
    expect(chain.size).toBe(1);
    const capture = chain.get(nearCaptureKey(fixture.hashLock, fixture.legContract));
    expect(capture).toBeDefined();
    expect(capture.index.ref).toBe(fixture.ref);

    const goodSha = fixture.index.exchanges[0]!.responseSha256;
    expect(new TextDecoder().decode(capture.bytes.get(goodSha))).toBe(fixture.statusBody);
    expect(capture.bytes.get("0".repeat(64)) ?? null).toBeNull();
  });

  it("fails the leg closed on a corrupted newest index and reports it via the notes array", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture);
    await writeFile(join(root, "raw", "near", fixture.hashLock, fixture.legContract, "zzz-newer-but-corrupt.json"), "{ not valid json");

    const notes: string[] = [];
    const chain = await loadNearCaptures(root, notes);
    expect(chain.size).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`raw/near/${fixture.hashLock}/${fixture.legContract}/zzz-newer-but-corrupt\\.json.*skipped`));
  });

  // E1: two different leg contracts captured under the same hash lock — each is loaded into its
  // own map entry (never one overwriting the other), and the collision itself is reported.
  it("two leg contracts sharing a hash lock each load into their own map entry; the collision is noted", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture);
    const otherLegContract = `0x${"44".repeat(32)}`;
    const otherIndex = { ...fixture.index, exchanges: fixture.index.exchanges };
    await mkdir(join(root, "raw", "near", fixture.hashLock, otherLegContract), { recursive: true });
    await writeFile(join(root, "raw", "near", fixture.hashLock, otherLegContract, "only.json"), JSON.stringify(otherIndex, null, 2));

    const notes: string[] = [];
    const chain = await loadNearCaptures(root, notes);
    expect(chain.size).toBe(2);
    expect(chain.get(nearCaptureKey(fixture.hashLock, fixture.legContract))).toBeDefined();
    expect(chain.get(nearCaptureKey(fixture.hashLock, otherLegContract))).toBeDefined();
    expect(
      notes.some(
        (n) => n.includes(fixture.hashLock) && n.includes("2 different leg contracts") && n.includes(fixture.legContract) && n.includes(otherLegContract),
      ),
    ).toBe(true);
  });
});

describe("examples/audit-export.mjs — near-htlc leg end to end", () => {
  it("folds a captured, on-terms locked read into settlementView 'funded' with a near-sandbox finalizedRef", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture, { rails: { near: NEAR_CONFIG } });

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("funded");
    expect(swap.finalizedRefs.some((ref: string) => ref.startsWith(`${NEAR_SANDBOX_PIN.name}:final:${BLOCK_HEIGHT}:`))).toBe(true);
  });

  it("a tampered raw/rpc file (bytes no longer hash to their own filename) leaves the leg unverified, never thrown", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture, { rails: { near: NEAR_CONFIG } });

    const storageSha = fixture.index.exchanges[5]!.responseSha256;
    await writeFile(join(root, "raw", "rpc", `${storageSha}.json`), "tampered, does not match its own filename's hash");

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const swap = JSON.parse(result.stdout).swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("none");
    expect(swap.finalizedRefs).toEqual([]);
  });

  it("still opens no network connection with a near-htlc leg on disk (the CLI imports no fetch)", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture, { rails: { near: NEAR_CONFIG } });
    const result = run(["--root", root]);
    expect(result.status).toBe(0);
  });

  it("exits 2 with the reason when DIR/rails.json's near config is invalid", async () => {
    const fixture = buildNearFixture();
    const badConfig = { ...NEAR_CONFIG, pin: { ...NEAR_CONFIG.pin, chainId: "mainnet", caip2: "near:mainnet" } };
    await writeWatchRoot(root, fixture, { rails: { near: badConfig } });

    const result = run(["--root", root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/near rail config is invalid.*not on the allow list/);
  });

  it("R2-3-style: a conflicting account line posted AFTER the accepted lock frame leaves leg A funded (never re-resolved)", async () => {
    const fixture = buildNearFixture();
    // A second, conflicting account line for the Seller (payee), posted after the lock frame the
    // tclk machine actually accepted (seq 3) — per G1's own rule (also applied on replay, mirrors
    // R2-3), this must neither add to nor conflict with what already resolved before the lock.
    fixture.dealRoomARows.push(
      record(fixture.dealRoomA, 4, T0 + 5 * MIN, seller, formatAccountLine({
        railId: "near-htlc", caip2: NEAR_SANDBOX_PIN.caip2, address: "someone-else.near-sandbox-flop",
      })),
    );
    await writeWatchRoot(root, fixture, { rails: { near: NEAR_CONFIG } });

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("funded");
  });

  it("a genuine response from a DIFFERENT capture (the donor's own nonce id) leaves leg A without chain evidence, naming the capture binding", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture, { rails: { near: NEAR_CONFIG } });

    // H8-style splice defence, exercised through the real CLI: a donor exchange that is itself
    // genuine and self-consistent (its own request id equals its own response's embedded id) but
    // minted under a DIFFERENT capture (a different nonce) — so only `idBoundToCapture` can catch
    // it, never a bare id-mismatch check.
    const donorNonce = "ffffffffffffffff";
    const donorId = `${fixture.ref}:${fixture.index.checkedAtMs}:${donorNonce}:1`;
    const donorBody = jsonRpcResult(donorId, { chain_id: NEAR_SANDBOX_PIN.chainId, protocol_version: 86, sync_info: {} });
    const donorSha = sha256Hex(donorBody);
    await writeFile(join(root, "raw", "rpc", `${donorSha}.json`), donorBody);

    const splicedIndex = {
      ...fixture.index,
      exchanges: fixture.index.exchanges.map((exchange, i) =>
        i === 0
          ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: donorId, method: "status", params: [] }), responseSha256: donorSha }
          : exchange,
      ),
    };
    await writeFile(join(root, "raw", "near", fixture.hashLock, fixture.legContract, "only.json"), JSON.stringify(splicedIndex, null, 2));

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("none");
    expect(swap.finalizedRefs).toEqual([]);
    expect(swap.evidence.a.railVerified).toBeNull();
    expect(swap.evidence.a.reason).toMatch(/not bound to this capture/);
  });

  // Squatting fix: the capture is keyed by (hash lock, leg contract) only, so it must ALSO name
  // the very ref the accepted lock frame names. A capture of another payer's lock under the same
  // hash lock (a squatter's own perfectly valid lock) never stands in for the Buyer's leg.
  it("a capture that names ANOTHER payer's ref than the accepted lock frame leaves leg A without chain evidence", async () => {
    const fixture = buildNearFixture({ capturePayer: "squatter.near-sandbox-flop" });
    await writeWatchRoot(root, fixture, { rails: { near: NEAR_CONFIG } });

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("none");
    expect(swap.finalizedRefs).toEqual([]);
    expect(swap.evidence.a.railVerified).toBeNull();
    expect(swap.evidence.a.reason).toMatch(/payer mismatch/);
  });

  it("prints a note, still replays, and fails the leg closed when the newest capture index is corrupted", async () => {
    const fixture = buildNearFixture();
    await writeWatchRoot(root, fixture, { rails: { near: NEAR_CONFIG } });
    await writeFile(join(root, "raw", "near", fixture.hashLock, fixture.legContract, "zzz-newer-but-corrupt.json"), "{ not valid json");

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.nearCaptureNotes).toHaveLength(1);
    expect(parsed.nearCaptureNotes[0]).toMatch(/zzz-newer-but-corrupt\.json.*skipped/);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap.settlementView.a).toBe("none");
  });
});
