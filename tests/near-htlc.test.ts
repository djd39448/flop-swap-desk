// SPDX-License-Identifier: MIT
//
// tests/near-htlc.test.ts — NearHtlcRail exercised against a mocked near-sandbox JSON-RPC
// surface (a mocked `fetch`, through this repo's own CapturingRpc — the same pattern
// tests/btc-htlc.test.ts/tests/evm-htlc.test.ts use for the other two legs), so the adapter's
// own guards, the two-step "sign-and-record, then broadcast" write path, and the pre-checks
// before claim/refund are exercised the way production code drives them, without a real node or
// a real key. The (later, NB-int) sandbox suite covers what needs one.
//
// P5-NEAR-FIXES.md Group H round: every `railWith(...)` call below now goes through H6's own
// `connect()` gate (`status` -> `block(final)` -> `view_account` -> `view_access_key_list`,
// via `connectBodies()`), and every successful write's own post-send `get_lock` re-read (H1) is
// included in each write's body list.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  CLAIM_REFUND_GAS,
  FT_TRANSFER_CALL_GAS,
  NEAR_CLAIM_LANDING_MARGIN_MS,
  NEAR_SANDBOX_PIN,
  NearHtlcRail,
  NearLockRefusedError,
  NearPayoutFailedError,
  NearPendingError,
  NearRefundFailedError,
  NearTxFailedError,
  checkNearRailConfig,
  validateNearRailConfig,
  type NearHtlcTerms,
  type NearRailConfig,
} from "../src/rails/near-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const CONTRACT = "htlc.near-sandbox-flop";
const USDC = "usdc.near-sandbox-flop";
const HTLC_CODE_HASH = "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT"; // any well-formed base58 string
const CONFIG: NearRailConfig = { pin: NEAR_SANDBOX_PIN, endpoint: "http://127.0.0.1:9999", contract: CONTRACT, assets: { USDC }, htlcCodeHash: HTLC_CODE_HASH };

const BUYER_ACCOUNT = "buyer.near-sandbox-flop";
const SELLER_ACCOUNT = "seller.near-sandbox-flop";
const SEED_BUYER = new Uint8Array(32).fill(1);
const SEED_SELLER = new Uint8Array(32).fill(2);

const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const PREIMAGE = `0x${PREIMAGE_HEX}`;
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
const REF = `${HASH_LOCK}:${BUYER_ACCOUNT}`; // the squatting-fix ref: 0x<hash lock>:<payer>
const BLOCK_HASH_BASE58 = "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM"; // a real 32-byte base58 value

const TERMS: NearHtlcTerms = {
  hashLock: HASH_LOCK,
  amount: "1000000",
  payee: SELLER_ACCOUNT,
  claimByMs: 1_700_000_000_000,
  refundAfterMs: 1_800_000_000_000,
};

// ── mock RPC plumbing ────────────────────────────────────────────────────────────────────────

function fakeFetch(bodies: string[]): { fetch: typeof fetch; requests: Array<{ method: string; params: unknown }> } {
  const requests: Array<{ method: string; params: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    requests.push({ method: parsed.method, params: parsed.params });
    const body = bodies[i];
    i += 1;
    if (body === undefined) throw new Error(`fakeFetch: ran out of canned responses (call #${i} was ${parsed.method})`);
    const bytes = new TextEncoder().encode(body);
    return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function ok(result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}

function errBody(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } });
}

function statusBody(chainId: string = "near-sandbox-flop"): string {
  return ok({ chain_id: chainId, protocol_version: 86, sync_info: {} });
}

function blockBody(height: number, hash: string, timestampNs: string): string {
  return ok({ header: { height, hash, timestamp_nanosec: timestampNs } });
}

function viewAccessKeyBody(nonce: number): string {
  return ok({ nonce, permission: "FullAccess", block_height: 1, block_hash: "bh" });
}

function viewAccountBody(codeHash: string): string {
  return ok({ amount: "1000000000000000000000000", code_hash: codeHash, block_height: 1, block_hash: "bh" });
}

function viewAccessKeyListBody(publicKeys: string[]): string {
  return ok({ keys: publicKeys.map((pk) => ({ public_key: pk, access_key: { nonce: 0, permission: "FullAccess" } })), block_height: 1, block_hash: "bh" });
}

function callFunctionBody(payload: unknown): string {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));
  return ok({ result: bytes, logs: [], block_height: 1, block_hash: "bh" });
}

function sendTxBody(id: string, blockHash: string): string {
  return ok({ status: { SuccessValue: "" }, transaction_outcome: { id, block_hash: blockHash } });
}

function failedSendTxBody(id: string, blockHash: string, failure: unknown = { ActionError: { kind: "FunctionCallError" } }): string {
  return ok({ status: { Failure: failure }, transaction_outcome: { id, block_hash: blockHash } });
}

function lockView(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "Locked",
    payer: BUYER_ACCOUNT,
    payee: SELLER_ACCOUNT,
    token: USDC,
    amount: "1000000",
    claim_by_ms: "1700000000000",
    refund_after_ms: "1800000000000",
    ...overrides,
  };
}

/** H6: the four calls every `connect()` now makes — `status` (assertPinnedChain), then
 *  `assertLockedContract`'s own `block(final)` -> `view_account` -> `view_access_key_list`, all
 *  pinned to that one block. A locked (keyless), correctly-hashed contract by default. */
function connectBodies(options: { codeHash?: string; keys?: string[] } = {}): string[] {
  return [
    statusBody(),
    blockBody(1, BLOCK_HASH_BASE58, "1690000000000000000"),
    viewAccountBody(options.codeHash ?? HTLC_CODE_HASH),
    viewAccessKeyListBody(options.keys ?? []),
  ];
}

function railWith(
  bodies: string[],
  connect: string[] = connectBodies(),
  railClock: () => number = () => 5000,
): { rail: () => Promise<NearHtlcRail>; requests: Array<{ method: string; params: unknown }>; rpc: CapturingRpc } {
  const { fetch: fetchImpl, requests } = fakeFetch([...connect, ...bodies]);
  const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 5000 });
  const signer = InMemoryNearSigner.generate(BUYER_ACCOUNT, SEED_BUYER);
  // H3's own `max(final block time, clock)` guard needs an injected clock too — by default a
  // fixed value far below every test's own chain-time fixtures (all in the ~1.7e12ms epoch-ms
  // range), so the guard's `max(...)` resolves to the block time exactly as every existing test
  // already assumes, never the real wall clock `Date.now()` would otherwise fall back to here. A
  // caller exercising the `max(...)` itself (H3's own test below) passes its own `railClock`.
  return { rail: () => NearHtlcRail.connect({ config: CONFIG, rpc, signer, clock: railClock }), requests, rpc };
}

// ── checkNearRailConfig / validateNearRailConfig ────────────────────────────────────────────

describe("checkNearRailConfig", () => {
  it("accepts a well-formed sandbox config", () => {
    expect(checkNearRailConfig(CONFIG)).toEqual({ ok: true, config: CONFIG });
  });

  it("accepts an account id containing underscores (D-N5)", () => {
    const config: NearRailConfig = { ...CONFIG, contract: "my_htlc.near-sandbox-flop" };
    expect(checkNearRailConfig(config).ok).toBe(true);
  });

  it("rejects a missing pin", () => {
    const result = checkNearRailConfig({ endpoint: "x", contract: CONTRACT, assets: { USDC }, htlcCodeHash: HTLC_CODE_HASH });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("pin") });
  });

  it("rejects a pin.caip2 that doesn't match pin.chainId", () => {
    const config = { ...CONFIG, pin: { ...NEAR_SANDBOX_PIN, caip2: "near:something-else" } };
    const result = checkNearRailConfig(config);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("caip2") });
  });

  it("rejects a contract id with uppercase letters", () => {
    const config = { ...CONFIG, contract: "HTLC.near-sandbox-flop" };
    expect(checkNearRailConfig(config)).toEqual({ ok: false, reason: expect.stringContaining("contract") });
  });

  it("rejects a config missing assets.USDC", () => {
    const config = { ...CONFIG, assets: {} };
    expect(checkNearRailConfig(config)).toEqual({ ok: false, reason: expect.stringContaining("assets") });
  });

  it("refuses mainnet by name", () => {
    const config: NearRailConfig = { ...CONFIG, pin: { name: "near-mainnet", chainId: "mainnet", caip2: "near:mainnet", finality: "final" } };
    expect(() => validateNearRailConfig(config)).toThrow(/mainnet/);
  });

  it("refuses an unknown chain id even if well-shaped", () => {
    const config: NearRailConfig = { ...CONFIG, pin: { name: "near-devnet", chainId: "devnet", caip2: "near:devnet", finality: "final" } };
    expect(() => validateNearRailConfig(config)).toThrow(/allow list/);
  });

  it("refuses a pin name that doesn't match the known pin for that chain id", () => {
    const config: NearRailConfig = { ...CONFIG, pin: { ...NEAR_SANDBOX_PIN, name: "renamed-sandbox" } };
    expect(() => validateNearRailConfig(config)).toThrow(/pin\.name/);
  });

  // H6
  it("rejects a config missing htlcCodeHash", () => {
    const { htlcCodeHash: _drop, ...withoutHash } = CONFIG;
    expect(checkNearRailConfig(withoutHash)).toEqual({ ok: false, reason: expect.stringContaining("htlcCodeHash") });
  });

  it("rejects a config whose htlcCodeHash is an empty string", () => {
    const config = { ...CONFIG, htlcCodeHash: "" };
    expect(checkNearRailConfig(config)).toEqual({ ok: false, reason: expect.stringContaining("htlcCodeHash") });
  });
});

// ── connect() ────────────────────────────────────────────────────────────────────────────────

describe("NearHtlcRail.connect", () => {
  it("reads status, then the contract's account + key list at the same final block, and connects when everything checks out", async () => {
    const { rail, requests } = railWith([]);
    const r = await rail();
    expect(r).toBeInstanceOf(NearHtlcRail);
    expect(requests[0]).toEqual({ method: "status", params: [] });
    expect(requests[1]).toMatchObject({ method: "block" });
    const accountReq = requests[2]?.params as Record<string, unknown>;
    expect(accountReq).toMatchObject({ request_type: "view_account", account_id: CONTRACT, block_id: 1 });
    const keysReq = requests[3]?.params as Record<string, unknown>;
    expect(keysReq).toMatchObject({ request_type: "view_access_key_list", account_id: CONTRACT, block_id: 1 });
  });

  it("refuses to connect when the config itself is invalid", async () => {
    const badConfig = { ...CONFIG, contract: "BAD" } as unknown as NearRailConfig;
    const rpc = new CapturingRpc({ endpoint: "x", fetch: fakeFetch([]).fetch });
    const signer = InMemoryNearSigner.generate(BUYER_ACCOUNT, SEED_BUYER);
    await expect(NearHtlcRail.connect({ config: badConfig, rpc, signer })).rejects.toThrow(/refusing to connect/);
  });

  it("refuses when the live chain id disagrees with the pin", async () => {
    const { rail } = railWith([], [statusBody("testnet")]);
    await expect(rail()).rejects.toThrow(/does not match pin/);
  });

  it("refuses when the live chain id is off the allow list", async () => {
    const { rail } = railWith([], [statusBody("mainnet")]);
    await expect(rail()).rejects.toThrow(/allow list/);
  });

  // H6
  it("refuses when the live contract code_hash does not match the pinned htlcCodeHash", async () => {
    const { rail } = railWith([], connectBodies({ codeHash: "SomeOtherCodeHashEntirely111111111111111111" }));
    await expect(rail()).rejects.toThrow(/code_hash/);
  });

  it("refuses when the contract still holds one or more access keys", async () => {
    const { rail } = railWith([], connectBodies({ keys: ["ed25519:11111111111111111111111111111111"] }));
    await expect(rail()).rejects.toThrow(/access key/);
  });
});

// ── prepareLock / commitLock ─────────────────────────────────────────────────────────────────

describe("prepareLock / commitLock", () => {
  it("records ref=0x<hashLock>:<payer> and a base58 txHash without sending, then commitLock broadcasts, re-reads get_lock, and returns evidence", async () => {
    const bodies = [
      statusBody(), // prepareLock's own assertPinnedChain
      viewAccessKeyBody(4), // nextNonce
      blockBody(10, BLOCK_HASH_BASE58, "1690000000000000000"), // recentBlockHashBytes
      statusBody(), // commitLock -> sendPrepared's assertPinnedChain
      sendTxBody("txid-lock-1", "final-block-hash"), // send_tx
      blockBody(11, "final-block-hash", "1690000001000000000"), // block(blockId) for height
      callFunctionBody(lockView()), // H1: post-send get_lock re-read, matches this signer's own terms
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();

    const prepared = await r.prepareLock(TERMS);
    expect(prepared.ref).toBe(REF);
    expect(() => base58.decode(prepared.txHash)).not.toThrow();
    expect(base58.decode(prepared.txHash)).toHaveLength(32);

    const evidence = await r.commitLock();
    expect(evidence.ref).toBe(REF);
    expect(evidence.txHash).toBe(prepared.txHash);
    expect(evidence.blockHeight).toBe(11);
    expect(evidence.blockHash).toBe("final-block-hash");
    expect(evidence.raw.length).toBeGreaterThan(0);

    // request shapes (indices shift by 4 for the connect() bundle)
    const nonceReq = requests[5]?.params as Record<string, unknown>;
    expect(nonceReq).toMatchObject({ request_type: "view_access_key", account_id: BUYER_ACCOUNT });
    const sendReq = requests[8]?.params as Record<string, unknown>;
    expect(sendReq.wait_until).toBe("FINAL");

    // the signed tx bytes embed the FunctionCall method name, receiver and JSON args as plain
    // ASCII/UTF-8 — checkable without a borsh deserializer.
    const signedTxBase64 = String(sendReq.signed_tx_base64);
    const raw = Buffer.from(signedTxBase64, "base64").toString("latin1");
    expect(raw).toContain("ft_transfer_call");
    expect(raw).toContain(CONTRACT); // args.receiver_id
    expect(raw).toContain(HASH_LOCK.slice(2)); // msg.hash_lock (no 0x prefix on the wire)
    expect(raw).toContain(TERMS.payee);

    // Squatting fix: the post-send get_lock re-read addresses the (payer, hash lock) pair — the
    // args name this signer as payer, never the hash lock alone.
    const lockRead = requests[10]?.params as Record<string, unknown>;
    expect(lockRead).toMatchObject({ request_type: "call_function", method_name: "get_lock" });
    expect(JSON.parse(Buffer.from(String(lockRead.args_base64), "base64").toString("utf8"))).toEqual({
      hash_lock: HASH_LOCK.slice(2),
      payer: BUYER_ACCOUNT,
    });
  });

  it("commitLock without a prior prepareLock throws", async () => {
    const { rail } = railWith([]);
    const r = await rail();
    await expect(r.commitLock()).rejects.toThrow(/call prepareLock first/);
  });

  it("commitLock cannot be called twice for the same prepareLock", async () => {
    const bodies = [
      statusBody(),
      viewAccessKeyBody(1),
      blockBody(10, BLOCK_HASH_BASE58, "1690000000000000000"),
      statusBody(),
      sendTxBody("txid-1", "bh1"),
      blockBody(11, "bh1", "1690000001000000000"),
      callFunctionBody(lockView()),
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await r.prepareLock(TERMS);
    await r.commitLock();
    await expect(r.commitLock()).rejects.toThrow(/call prepareLock first/);
  });

  it("prepareLock rejects terms below the amount floor / malformed hashLock / claimByMs after refundAfterMs", async () => {
    const { rail } = railWith([]);
    const r = await rail();
    await expect(r.prepareLock({ ...TERMS, amount: "0" })).rejects.toThrow(/floor/);
    await expect(r.prepareLock({ ...TERMS, hashLock: "0xnothex" })).rejects.toThrow(/hashLock/);
    await expect(r.prepareLock({ ...TERMS, claimByMs: TERMS.refundAfterMs + 1 })).rejects.toThrow(/claimByMs/);
  });

  // H5
  it("prepareLock rejects a payee equal to the HTLC contract itself", async () => {
    const { rail } = railWith([]);
    const r = await rail();
    await expect(r.prepareLock({ ...TERMS, payee: CONTRACT })).rejects.toThrow(/HTLC contract itself/);
  });

  it("prepareLock rejects a payee equal to the USDC token account itself", async () => {
    const { rail } = railWith([]);
    const r = await rail();
    await expect(r.prepareLock({ ...TERMS, payee: USDC })).rejects.toThrow(/USDC token account itself/);
  });

  // H1 (S3): the transaction itself succeeds, but ft_on_transfer refused it — no lock exists
  // afterward (or one exists but it isn't this signer's own, with these exact terms).
  it("commitLock throws NearLockRefusedError when the tx succeeds but no matching lock exists afterward (S3)", async () => {
    const bodies = [
      statusBody(),
      viewAccessKeyBody(4),
      blockBody(10, BLOCK_HASH_BASE58, "1690000000000000000"),
      statusBody(),
      sendTxBody("txid-lock-2", "final-block-hash"),
      blockBody(11, "final-block-hash", "1690000001000000000"),
      callFunctionBody(null), // get_lock: no lock at all — ft_on_transfer refused it
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await r.prepareLock(TERMS);
    await expect(r.commitLock()).rejects.toThrow(NearLockRefusedError);
  });

  it("commitLock throws NearLockRefusedError when a lock exists but with different terms (e.g. a squatter got there first)", async () => {
    const bodies = [
      statusBody(),
      viewAccessKeyBody(4),
      blockBody(10, BLOCK_HASH_BASE58, "1690000000000000000"),
      statusBody(),
      sendTxBody("txid-lock-3", "final-block-hash"),
      blockBody(11, "final-block-hash", "1690000001000000000"),
      callFunctionBody(lockView({ payer: "someone-else.near-sandbox-flop" })),
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await r.prepareLock(TERMS);
    await expect(r.commitLock()).rejects.toThrow(NearLockRefusedError);
  });

  // H1: a top-level Failure throws NearTxFailedError, never returned as if it were evidence.
  it("commitLock throws NearTxFailedError when the transaction itself failed on chain", async () => {
    const bodies = [
      statusBody(),
      viewAccessKeyBody(4),
      blockBody(10, BLOCK_HASH_BASE58, "1690000000000000000"),
      statusBody(),
      failedSendTxBody("txid-lock-4", "final-block-hash"),
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await r.prepareLock(TERMS);
    await expect(r.commitLock()).rejects.toThrow(NearTxFailedError);
  });
});

// ── claim ────────────────────────────────────────────────────────────────────────────────────

describe("claim", () => {
  it("refuses a preimage that does not open hashLock, before any FURTHER RPC call", async () => {
    const { rail, requests } = railWith([]); // connect() alone
    const r = await rail();
    const before = requests.length;
    await expect(r.claim(REF, `0x${"00".repeat(32)}`, 9_999_999_999_999)).rejects.toThrow(/does not open hashLock/);
    expect(requests).toHaveLength(before); // claim() itself made no RPC calls at all
  });

  it("refuses when the lock is not in a Locked state", async () => {
    const bodies = [statusBody(), callFunctionBody(lockView({ status: "Claiming" }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.claim(REF, PREIMAGE, 9_999_999_999_999)).rejects.toThrow(/claimable "Locked"/);
  });

  it("refuses when the payee is not storage-registered on the token", async () => {
    const bodies = [
      statusBody(), // claim's own assertPinnedChain
      callFunctionBody(lockView()), // get_lock
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"), // preClaimNowMs
      callFunctionBody(null), // storage_balance_of -> not registered
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.claim(REF, PREIMAGE, 9_999_999_999_999)).rejects.toThrow(/storage-registered/);
  });

  // H3: refused up front (before ever signing) when notAfterMs leaves less than the landing
  // margin before refundAfterMs — refundAfterMs is 1_800_000_000_000 in TERMS/lockView().
  it("refuses up front when notAfterMs leaves less than the landing margin before refundAfterMs (H3)", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"),
      callFunctionBody({ total: "125000", available: "0" }),
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();
    const tooLate = 1_800_000_000_000 - NEAR_CLAIM_LANDING_MARGIN_MS + 1; // 1ms inside the margin
    await expect(r.claim(REF, PREIMAGE, tooLate)).rejects.toThrow(/landing margin/);
    // refused before ever signing (no nonce lookup) or sending
    expect(requests.some((req) => req.method === "send_tx")).toBe(false);
    expect(requests.filter((req) => req.method === "query" && (req.params as Record<string, unknown>).request_type === "view_access_key")).toHaveLength(0);
  });

  it("refuses (as the LAST check, after pre-checks and signing) when the fresh chain time is at/after notAfterMs", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"), // preClaimNowMs = 1_700_000_000_000
      callFunctionBody({ total: "125000", available: "0" }), // storage_balance_of
      viewAccessKeyBody(2), // nonce for buildAndSign
      blockBody(2, BLOCK_HASH_BASE58, "1700000000200000000"), // recentBlockHashBytes
      blockBody(3, BLOCK_HASH_BASE58, "1700000000500000000"), // finalNowMs = 1_700_000_000_500
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();
    await expect(r.claim(REF, PREIMAGE, 1_700_000_000_000)).rejects.toThrow(/at\/after the given deadline/);
    // nothing was ever sent — the last body in the queue was the deadline read, never send_tx.
    expect(requests.every((req) => req.method !== "send_tx")).toBe(true);
  });

  // H3: the last-moment guard judges notAfterMs against max(final block time, the injected
  // clock) — a final block whose own timestamp alone would still permit the claim must NOT save
  // it when the injected clock reads later than notAfterMs (a node whose block cadence has
  // stalled must never let a stale "chain time" understate how much real time has passed).
  it("H3: refuses using max(final block time, clock) even when the block time alone would permit the claim", async () => {
    const bodies = [
      statusBody(), // claim's own assertPinnedChain
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"), // preClaimNowMs
      callFunctionBody({ total: "125000", available: "0" }),
      viewAccessKeyBody(3),
      blockBody(2, BLOCK_HASH_BASE58, "1700000000200000000"),
      blockBody(3, BLOCK_HASH_BASE58, "1700000000500000000"), // finalNowMs = ...500, BEFORE notAfterMs
    ];
    const notAfterMs = 1_700_000_001_000; // > finalNowMs(...500): block time ALONE would pass
    const clockAheadOfDeadline = () => 1_700_000_002_000; // but the injected clock is already past it
    const { rail, requests } = railWith(bodies, connectBodies(), clockAheadOfDeadline);
    const r = await rail();
    await expect(r.claim(REF, PREIMAGE, notAfterMs)).rejects.toThrow(/at\/after the given deadline/);
    expect(requests.every((req) => req.method !== "send_tx")).toBe(true);
  });

  it("happy path: pre-checks pass, signs, re-checks the deadline fresh, broadcasts, and re-reads get_lock (H1) to confirm Claimed", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"), // preClaimNowMs
      callFunctionBody({ total: "125000", available: "0" }),
      viewAccessKeyBody(3),
      blockBody(2, BLOCK_HASH_BASE58, "1700000000200000000"),
      blockBody(3, BLOCK_HASH_BASE58, "1700000000500000000"), // finalNowMs = ...500
      statusBody(), // sendPrepared's assertPinnedChain
      sendTxBody("claim-tx-1", "claim-block-hash"),
      blockBody(4, "claim-block-hash", "1700000000600000000"),
      callFunctionBody(lockView({ status: "Claimed", preimage: PREIMAGE_HEX })), // H1 post-send re-read
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();
    const evidence = await r.claim(REF, PREIMAGE, 1_700_000_001_000); // > finalNowMs(...500)
    expect(evidence.ref).toBe(REF);
    expect(evidence.blockHeight).toBe(4);

    const sendReq = requests[requests.length - 3]?.params as Record<string, unknown>;
    const raw = Buffer.from(String(sendReq.signed_tx_base64), "base64").toString("latin1");
    expect(raw).toContain("claim");
    expect(raw).toContain(PREIMAGE_HEX);
    // Squatting fix: the claim call names the lock's payer (from the ref) next to the hash lock.
    expect(raw).toContain(`"payer":"${BUYER_ACCOUNT}"`);
    const getLockReq = requests.find((request) => (request.params as Record<string, unknown>).method_name === "get_lock")
      ?.params as Record<string, unknown>;
    expect(JSON.parse(Buffer.from(String(getLockReq.args_base64), "base64").toString("utf8"))).toEqual({
      hash_lock: HASH_LOCK.slice(2),
      payer: BUYER_ACCOUNT,
    });
  });

  it("refuses a bare hash lock (the pre-fix ref) or a malformed ref before any RPC call", async () => {
    const { rail } = railWith([]);
    const r = await rail();
    await expect(r.claim(HASH_LOCK, PREIMAGE, 1_700_000_001_000)).rejects.toThrow(/ref must be 0x/);
    await expect(r.claim(`${HASH_LOCK}:`, PREIMAGE, 1_700_000_001_000)).rejects.toThrow(/ref must be 0x/);
    await expect(r.claim(`${HASH_LOCK}:BAD ACCOUNT`, PREIMAGE, 1_700_000_001_000)).rejects.toThrow(/ref must be 0x/);
    await expect(r.refund(HASH_LOCK)).rejects.toThrow(/ref must be 0x/);
    await expect(r.findClaimedPreimage(HASH_LOCK)).rejects.toThrow(/ref must be 0x/);
    await expect(r.checkPendingClaim(HASH_LOCK)).rejects.toThrow(/ref must be 0x/);
  });

  // H1 (S1): the outer transaction succeeds, but the inner payout promise failed (e.g. the payee
  // was unregistered by the time it ran) — get_lock afterward still shows Locked with the
  // preimage revealed.
  it("throws NearPayoutFailedError (carrying the preimage) when the tx succeeds but the payout callback failed (S1)", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"),
      callFunctionBody({ total: "125000", available: "0" }),
      viewAccessKeyBody(3),
      blockBody(2, BLOCK_HASH_BASE58, "1700000000200000000"),
      blockBody(3, BLOCK_HASH_BASE58, "1700000000500000000"),
      statusBody(),
      sendTxBody("claim-tx-2", "claim-block-hash"),
      blockBody(4, "claim-block-hash", "1700000000600000000"),
      callFunctionBody(lockView({ status: "Locked", preimage: PREIMAGE_HEX })), // reverted, preimage kept
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    let caught: unknown;
    try {
      await r.claim(REF, PREIMAGE, 1_700_000_001_000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NearPayoutFailedError);
    expect((caught as NearPayoutFailedError).preimage).toBe(PREIMAGE);
  });

  it("throws NearPendingError when the tx succeeds but get_lock still shows Claiming", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"),
      callFunctionBody({ total: "125000", available: "0" }),
      viewAccessKeyBody(3),
      blockBody(2, BLOCK_HASH_BASE58, "1700000000200000000"),
      blockBody(3, BLOCK_HASH_BASE58, "1700000000500000000"),
      statusBody(),
      sendTxBody("claim-tx-3", "claim-block-hash"),
      blockBody(4, "claim-block-hash", "1700000000600000000"),
      callFunctionBody(lockView({ status: "Claiming", preimage: PREIMAGE_HEX })),
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.claim(REF, PREIMAGE, 1_700_000_001_000)).rejects.toThrow(NearPendingError);
  });

  // H1: a top-level Failure (e.g. claim attempted at/after refundAfterMs, unrevealed) throws
  // NearTxFailedError.
  it("throws NearTxFailedError when the claim transaction itself failed on chain", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"),
      callFunctionBody({ total: "125000", available: "0" }),
      viewAccessKeyBody(3),
      blockBody(2, BLOCK_HASH_BASE58, "1700000000200000000"),
      blockBody(3, BLOCK_HASH_BASE58, "1700000000500000000"),
      statusBody(),
      failedSendTxBody("claim-tx-4", "claim-block-hash"),
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.claim(REF, PREIMAGE, 1_700_000_001_000)).rejects.toThrow(NearTxFailedError);
  });

  // H2: a revealed-but-Locked lock (a prior claim's payout callback failed) may be retried past
  // refundAfterMs/notAfterMs — the refundAfterMs pre-check and the notAfterMs/margin guards are
  // both skipped (fewer RPC calls than the unrevealed happy path: no "finalNowMs" read), but the
  // storage-registration check still runs.
  describe("H2: revealed-lock retry", () => {
    it("retries successfully past refundAfterMs when the lock is revealed (preimage already public)", async () => {
      const revealedLocked = lockView({ status: "Locked", preimage: PREIMAGE_HEX });
      const bodies = [
        statusBody(),
        callFunctionBody(revealedLocked), // get_lock: revealed
        blockBody(1, BLOCK_HASH_BASE58, "1800000000100000000"), // preClaimNowMs, ALREADY past refundAfterMs
        callFunctionBody({ total: "125000", available: "0" }), // storage_balance_of — still checked
        viewAccessKeyBody(9), // buildAndSign nonce
        blockBody(2, BLOCK_HASH_BASE58, "1800000000200000000"), // recentBlockHashBytes
        // no finalNowMs read: the deadline guard is skipped entirely on a revealed retry
        statusBody(), // sendPrepared's assertPinnedChain
        sendTxBody("claim-retry-1", "claim-block-hash"),
        blockBody(3, "claim-block-hash", "1800000000300000000"),
        callFunctionBody(lockView({ status: "Claimed", preimage: PREIMAGE_HEX })),
      ];
      const { rail, requests } = railWith(bodies);
      const r = await rail();
      // notAfterMs is already past refundAfterMs — would be refused up front on an unrevealed
      // lock (H3), but must succeed here since the lock is revealed.
      const evidence = await r.claim(REF, PREIMAGE, 1_800_000_500_000);
      expect(evidence.ref).toBe(REF);
      const sendReq = requests[requests.length - 3]?.params as Record<string, unknown>;
      expect(sendReq.wait_until).toBe("FINAL");
    });

    it("still refuses an UNREVEALED lock past refundAfterMs (the retry exemption never applies)", async () => {
      const bodies = [
        statusBody(),
        callFunctionBody(lockView({ status: "Locked" })), // not revealed
        blockBody(1, BLOCK_HASH_BASE58, "1800000000100000000"), // now already past refundAfterMs
      ];
      const { rail } = railWith(bodies);
      const r = await rail();
      await expect(r.claim(REF, PREIMAGE, 1_800_000_500_000)).rejects.toThrow(/refundAfterMs/);
    });

    it("still refuses a revealed retry when the payee is not storage-registered", async () => {
      const revealedLocked = lockView({ status: "Locked", preimage: PREIMAGE_HEX });
      const bodies = [
        statusBody(),
        callFunctionBody(revealedLocked),
        blockBody(1, BLOCK_HASH_BASE58, "1800000000100000000"),
        callFunctionBody(null), // storage_balance_of: not registered — still enforced
      ];
      const { rail } = railWith(bodies);
      const r = await rail();
      await expect(r.claim(REF, PREIMAGE, 1_800_000_500_000)).rejects.toThrow(/storage-registered/);
    });
  });
});

// ── refund ───────────────────────────────────────────────────────────────────────────────────

describe("refund", () => {
  it("refuses a ref naming another payer before any RPC call (refund is keyed by the signer's own account)", async () => {
    const { rail, requests } = railWith([]);
    const r = await rail();
    const before = requests.length;
    await expect(r.refund(`${HASH_LOCK}:someone-else.near-sandbox-flop`)).rejects.toThrow(/payer's own account/);
    expect(requests.length).toBe(before);
  });

  it("refuses when the lock read back names another payer than this signer (defence in depth)", async () => {
    const bodies = [statusBody(), callFunctionBody(lockView({ payer: "someone-else.near-sandbox-flop" }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.refund(REF)).rejects.toThrow(/payer's own account/);
  });

  it("refuses before refundAfterMs is reached", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()), // refund_after_ms = 1_800_000_000_000
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"), // now = 1_700_000_000_000, too early
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.refund(REF)).rejects.toThrow(/has not yet reached/);
  });

  it("happy path: signs and sends a refund once the window has opened, and re-reads get_lock (H1) to confirm Refunded", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1800000000100000000"), // now just past refundAfterMs
      viewAccessKeyBody(5),
      blockBody(2, BLOCK_HASH_BASE58, "1800000000200000000"),
      statusBody(),
      sendTxBody("refund-tx-1", "refund-block-hash"),
      blockBody(3, "refund-block-hash", "1800000000300000000"),
      callFunctionBody(lockView({ status: "Refunded" })), // H1 post-send re-read
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();
    const evidence = await r.refund(REF);
    expect(evidence.blockHeight).toBe(3);
    const sendReq = requests[requests.length - 3]?.params as Record<string, unknown>;
    const raw = Buffer.from(String(sendReq.signed_tx_base64), "base64").toString("latin1");
    expect(raw).toContain("refund");
  });

  // H1: the transaction succeeds, but get_lock afterward doesn't show Refunded (the inner payout
  // promise failed).
  it("throws NearRefundFailedError when the tx succeeds but get_lock doesn't show Refunded afterward", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1800000000100000000"),
      viewAccessKeyBody(5),
      blockBody(2, BLOCK_HASH_BASE58, "1800000000200000000"),
      statusBody(),
      sendTxBody("refund-tx-2", "refund-block-hash"),
      blockBody(3, "refund-block-hash", "1800000000300000000"),
      callFunctionBody(lockView({ status: "Locked" })), // reverted: payout promise failed
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.refund(REF)).rejects.toThrow(NearRefundFailedError);
  });

  // H1: a revealed lock's refund is refused by the CONTRACT itself as a top-level Failure (H2's
  // own contract-side rule) — sendPrepared's Failure gate catches this before ever reaching the
  // refund-specific post-check.
  it("throws NearTxFailedError when refunding a revealed lock (the contract panics: refund refused)", async () => {
    const bodies = [
      statusBody(),
      callFunctionBody(lockView({ preimage: PREIMAGE_HEX })), // revealed — still status Locked
      blockBody(1, BLOCK_HASH_BASE58, "1800000000100000000"),
      viewAccessKeyBody(5),
      blockBody(2, BLOCK_HASH_BASE58, "1800000000200000000"),
      statusBody(),
      failedSendTxBody("refund-tx-3", "refund-block-hash", { ActionError: { kind: { FunctionCallError: "refund refused" } } }),
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.refund(REF)).rejects.toThrow(NearTxFailedError);
  });
});

// ── recoverByTxHash ──────────────────────────────────────────────────────────────────────────

describe("recoverByTxHash", () => {
  it("returns write evidence carrying the CALLER's own expectedRef (H4), not the raw txHash", async () => {
    const bodies = [statusBody(), sendTxBody("known-tx", "known-block-hash"), blockBody(7, "known-block-hash", "1700000000000000000")];
    const { rail } = railWith(bodies);
    const r = await rail();
    const evidence = await r.recoverByTxHash("known-tx", BUYER_ACCOUNT, REF);
    expect(evidence).toEqual({ ref: REF, txHash: "known-tx", blockHeight: 7, blockHash: "known-block-hash", raw: expect.any(Array) });
  });

  it("returns null (never throws) when the node has never seen the transaction", async () => {
    const bodies = [statusBody(), errBody(-32000, "[UNKNOWN_TRANSACTION] transaction not found")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.recoverByTxHash("ghost-tx", BUYER_ACCOUNT, REF)).resolves.toBeNull();
  });

  it("propagates any OTHER error unchanged", async () => {
    const bodies = [statusBody(), errBody(-32603, "internal error")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.recoverByTxHash("x", BUYER_ACCOUNT, REF)).rejects.toThrow(/internal error/);
  });

  // H4: a transaction the node still knows about but that itself executed as Failure is reported
  // as failed, never handed back as evidence.
  it("throws NearTxFailedError (never returns evidence) for a transaction the node knows failed", async () => {
    const bodies = [statusBody(), failedSendTxBody("known-failed-tx", "known-block-hash")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.recoverByTxHash("known-failed-tx", BUYER_ACCOUNT, REF)).rejects.toThrow(NearTxFailedError);
  });
});

// ── findClaimedPreimage / checkPendingClaim ─────────────────────────────────────────────────

describe("findClaimedPreimage / checkPendingClaim", () => {
  it("returns the preimage from a pending (Claiming) lock", async () => {
    const bodies = [callFunctionBody(lockView({ status: "Claiming", preimage: PREIMAGE_HEX }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(REF)).resolves.toBe(PREIMAGE);
  });

  it("checkPendingClaim is the same read as findClaimedPreimage", async () => {
    const bodies = [callFunctionBody(lockView({ status: "Claimed", preimage: PREIMAGE_HEX }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.checkPendingClaim(REF)).resolves.toBe(PREIMAGE);
  });

  it("returns null for a Locked lock (no preimage known yet)", async () => {
    const bodies = [callFunctionBody(lockView({ status: "Locked" }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(REF)).resolves.toBeNull();
  });

  it("returns the preimage from a Locked lock whose payout failed after the reveal (F4: revealed, refund refused)", async () => {
    // The contract's F4 rule: a claim whose ft_transfer failed reverts the status to Locked but
    // keeps the (now public) preimage and refuses every refund. The Buyer's leg A is gone either
    // way; learning `s` here is what lets it still take leg B (main-loop review 2026-09-29).
    const revealedButLocked = lockView({ status: "Locked", preimage: PREIMAGE_HEX });
    const bodies = [callFunctionBody(revealedButLocked), callFunctionBody(revealedButLocked)];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(REF)).resolves.toBe(PREIMAGE);
    await expect(r.checkPendingClaim(REF)).resolves.toBe(PREIMAGE);
  });

  it("returns null when the lock does not exist", async () => {
    const bodies = [callFunctionBody(null)];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(REF)).resolves.toBeNull();
  });

  it("never trusts a preimage that doesn't actually open the hash lock", async () => {
    const wrongPreimageHex = "00".repeat(32);
    const bodies = [callFunctionBody(lockView({ status: "Claiming", preimage: wrongPreimageHex }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(REF)).resolves.toBeNull();
  });
});

// ── chainTimeMs / currentBlockMarker ─────────────────────────────────────────────────────────

describe("chainTimeMs / currentBlockMarker", () => {
  it("chainTimeMs converts the final block header's timestamp_nanosec, ns to ms", async () => {
    const bodies = [blockBody(1, "h", "1700000000123000000")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.chainTimeMs()).resolves.toBe(1_700_000_000_123);
  });

  it("fails closed on a non-numeric timestamp_nanosec rather than guessing a deadline", async () => {
    const bodies = [ok({ header: { height: 1, hash: "h", timestamp_nanosec: "not-a-number" } })];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.chainTimeMs()).rejects.toThrow(/refusing to guess/);
  });

  it("currentBlockMarker returns the final block's own height", async () => {
    const bodies = [blockBody(123, "h", "1700000000000000000")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.currentBlockMarker()).resolves.toBe(123);
  });
});

// ── gas / floor constants sanity ────────────────────────────────────────────────────────────

describe("D-N9 gas constants", () => {
  // NB-int corrected these from the provisional 100/60 Tgas against real measured burn on a live
  // near-sandbox node (src/rails/near-htlc.ts's own doc comment on these constants carries the
  // exact measured numbers and why claim/refund need more headroom than the raw burn figure
  // alone would suggest).
  it("ft_transfer_call gas is 20 Tgas and claim/refund gas is 40 Tgas", () => {
    expect(FT_TRANSFER_CALL_GAS).toBe(20_000_000_000_000n);
    expect(CLAIM_REFUND_GAS).toBe(40_000_000_000_000n);
  });
});

// ── H3 constant sanity ───────────────────────────────────────────────────────────────────────

describe("H3 NEAR_CLAIM_LANDING_MARGIN_MS", () => {
  it("is 30 seconds", () => {
    expect(NEAR_CLAIM_LANDING_MARGIN_MS).toBe(30_000);
  });
});

void SEED_SELLER; // reserved for a future two-signer scenario once the client rail lands
