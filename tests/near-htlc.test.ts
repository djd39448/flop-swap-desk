// SPDX-License-Identifier: MIT
//
// tests/near-htlc.test.ts — NearHtlcRail exercised against a mocked near-sandbox JSON-RPC
// surface (a mocked `fetch`, through this repo's own CapturingRpc — the same pattern
// tests/btc-htlc.test.ts/tests/evm-htlc.test.ts use for the other two legs), so the adapter's
// own guards, the two-step "sign-and-record, then broadcast" write path, and the pre-checks
// before claim/refund are exercised the way production code drives them, without a real node or
// a real key. The (later, NB-int) sandbox suite covers what needs one.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  CLAIM_REFUND_GAS,
  FT_TRANSFER_CALL_GAS,
  NEAR_SANDBOX_PIN,
  NearHtlcRail,
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
const CONFIG: NearRailConfig = { pin: NEAR_SANDBOX_PIN, endpoint: "http://127.0.0.1:9999", contract: CONTRACT, assets: { USDC } };

const BUYER_ACCOUNT = "buyer.near-sandbox-flop";
const SELLER_ACCOUNT = "seller.near-sandbox-flop";
const SEED_BUYER = new Uint8Array(32).fill(1);
const SEED_SELLER = new Uint8Array(32).fill(2);

const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const PREIMAGE = `0x${PREIMAGE_HEX}`;
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
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

function callFunctionBody(payload: unknown): string {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));
  return ok({ result: bytes, logs: [], block_height: 1, block_hash: "bh" });
}

function sendTxBody(id: string, blockHash: string): string {
  return ok({ status: { SuccessValue: "" }, transaction_outcome: { id, block_hash: blockHash } });
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

function railWith(bodies: string[]): { rail: () => Promise<NearHtlcRail>; requests: Array<{ method: string; params: unknown }>; rpc: CapturingRpc } {
  const { fetch: fetchImpl, requests } = fakeFetch(bodies);
  const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 5000 });
  const signer = InMemoryNearSigner.generate(BUYER_ACCOUNT, SEED_BUYER);
  return { rail: () => NearHtlcRail.connect({ config: CONFIG, rpc, signer }), requests, rpc };
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
    const result = checkNearRailConfig({ endpoint: "x", contract: CONTRACT, assets: { USDC } });
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
});

// ── connect() ────────────────────────────────────────────────────────────────────────────────

describe("NearHtlcRail.connect", () => {
  it("reads status and connects when the live chain id matches the pin", async () => {
    const { rail, requests } = railWith([statusBody()]);
    const r = await rail();
    expect(r).toBeInstanceOf(NearHtlcRail);
    expect(requests[0]).toEqual({ method: "status", params: [] });
  });

  it("refuses to connect when the config itself is invalid", async () => {
    const badConfig = { ...CONFIG, contract: "BAD" } as unknown as NearRailConfig;
    const rpc = new CapturingRpc({ endpoint: "x", fetch: fakeFetch([]).fetch });
    const signer = InMemoryNearSigner.generate(BUYER_ACCOUNT, SEED_BUYER);
    await expect(NearHtlcRail.connect({ config: badConfig, rpc, signer })).rejects.toThrow(/refusing to connect/);
  });

  it("refuses when the live chain id disagrees with the pin", async () => {
    const { rail } = railWith([statusBody("testnet")]);
    await expect(rail()).rejects.toThrow(/does not match pin/);
  });

  it("refuses when the live chain id is off the allow list", async () => {
    const { rail } = railWith([statusBody("mainnet")]);
    await expect(rail()).rejects.toThrow(/allow list/);
  });
});

// ── prepareLock / commitLock ─────────────────────────────────────────────────────────────────

describe("prepareLock / commitLock", () => {
  it("records ref=hashLock and a base58 txHash without sending, then commitLock broadcasts and returns evidence", async () => {
    const bodies = [
      statusBody(), // connect
      statusBody(), // prepareLock's own assertPinnedChain
      viewAccessKeyBody(4), // nextNonce
      blockBody(10, BLOCK_HASH_BASE58, "1690000000000000000"), // recentBlockHashBytes
      statusBody(), // commitLock -> sendPrepared's assertPinnedChain
      sendTxBody("txid-lock-1", "final-block-hash"), // send_tx
      blockBody(11, "final-block-hash", "1690000001000000000"), // block(blockId) for height
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();

    const prepared = await r.prepareLock(TERMS);
    expect(prepared.ref).toBe(HASH_LOCK);
    expect(() => base58.decode(prepared.txHash)).not.toThrow();
    expect(base58.decode(prepared.txHash)).toHaveLength(32);

    const evidence = await r.commitLock();
    expect(evidence.ref).toBe(HASH_LOCK);
    expect(evidence.txHash).toBe(prepared.txHash);
    expect(evidence.blockHeight).toBe(11);
    expect(evidence.blockHash).toBe("final-block-hash");
    expect(evidence.raw.length).toBeGreaterThan(0);

    // request shapes
    const nonceReq = requests[2]?.params as Record<string, unknown>;
    expect(nonceReq).toMatchObject({ request_type: "view_access_key", account_id: BUYER_ACCOUNT });
    const sendReq = requests[5]?.params as Record<string, unknown>;
    expect(sendReq.wait_until).toBe("FINAL");

    // the signed tx bytes embed the FunctionCall method name, receiver and JSON args as plain
    // ASCII/UTF-8 — checkable without a borsh deserializer.
    const signedTxBase64 = String(sendReq.signed_tx_base64);
    const raw = Buffer.from(signedTxBase64, "base64").toString("latin1");
    expect(raw).toContain("ft_transfer_call");
    expect(raw).toContain(CONTRACT); // args.receiver_id
    expect(raw).toContain(HASH_LOCK.slice(2)); // msg.hash_lock (no 0x prefix on the wire)
    expect(raw).toContain(TERMS.payee);
  });

  it("commitLock without a prior prepareLock throws", async () => {
    const { rail } = railWith([statusBody()]);
    const r = await rail();
    await expect(r.commitLock()).rejects.toThrow(/call prepareLock first/);
  });

  it("commitLock cannot be called twice for the same prepareLock", async () => {
    const bodies = [
      statusBody(),
      statusBody(),
      viewAccessKeyBody(1),
      blockBody(10, BLOCK_HASH_BASE58, "1690000000000000000"),
      statusBody(),
      sendTxBody("txid-1", "bh1"),
      blockBody(11, "bh1", "1690000001000000000"),
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await r.prepareLock(TERMS);
    await r.commitLock();
    await expect(r.commitLock()).rejects.toThrow(/call prepareLock first/);
  });

  it("prepareLock rejects terms below the amount floor / malformed hashLock / claimByMs after refundAfterMs", async () => {
    const { rail } = railWith([statusBody()]);
    const r = await rail();
    await expect(r.prepareLock({ ...TERMS, amount: "0" })).rejects.toThrow(/floor/);
    await expect(r.prepareLock({ ...TERMS, hashLock: "0xnothex" })).rejects.toThrow(/hashLock/);
    await expect(r.prepareLock({ ...TERMS, claimByMs: TERMS.refundAfterMs + 1 })).rejects.toThrow(/claimByMs/);
  });
});

// ── claim ────────────────────────────────────────────────────────────────────────────────────

describe("claim", () => {
  it("refuses a preimage that does not open hashLock, before any FURTHER RPC call", async () => {
    const { rail, requests } = railWith([statusBody()]); // connect() alone
    const r = await rail();
    const before = requests.length;
    await expect(r.claim(HASH_LOCK, `0x${"00".repeat(32)}`, 9_999_999_999_999)).rejects.toThrow(/does not open hashLock/);
    expect(requests).toHaveLength(before); // claim() itself made no RPC calls at all
  });

  it("refuses when the lock is not in a Locked state", async () => {
    const bodies = [statusBody(), statusBody(), callFunctionBody(lockView({ status: "Claiming" }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.claim(HASH_LOCK, PREIMAGE, 9_999_999_999_999)).rejects.toThrow(/claimable "Locked"/);
  });

  it("refuses when the payee is not storage-registered on the token", async () => {
    const bodies = [
      statusBody(), // connect
      statusBody(), // claim's own assertPinnedChain
      callFunctionBody(lockView()), // get_lock
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"), // preClaimNowMs
      callFunctionBody(null), // storage_balance_of -> not registered
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.claim(HASH_LOCK, PREIMAGE, 9_999_999_999_999)).rejects.toThrow(/storage-registered/);
  });

  it("refuses (as the LAST check, after pre-checks and signing) when the fresh chain time is at/after notAfterMs", async () => {
    const bodies = [
      statusBody(),
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
    await expect(r.claim(HASH_LOCK, PREIMAGE, 1_700_000_000_000)).rejects.toThrow(/at\/after the given deadline/);
    // nothing was ever sent — the last body in the queue was the deadline read, never send_tx.
    expect(requests.every((req) => req.method !== "send_tx")).toBe(true);
  });

  it("happy path: pre-checks pass, signs, re-checks the deadline fresh, then broadcasts", async () => {
    const bodies = [
      statusBody(),
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
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();
    const evidence = await r.claim(HASH_LOCK, PREIMAGE, 1_700_000_001_000); // > finalNowMs(...500)
    expect(evidence.ref).toBe(HASH_LOCK);
    expect(evidence.blockHeight).toBe(4);

    const sendReq = requests[requests.length - 2]?.params as Record<string, unknown>;
    const raw = Buffer.from(String(sendReq.signed_tx_base64), "base64").toString("latin1");
    expect(raw).toContain("claim");
    expect(raw).toContain(PREIMAGE_HEX);
  });
});

// ── refund ───────────────────────────────────────────────────────────────────────────────────

describe("refund", () => {
  it("refuses when the caller's signer is not the lock's payer", async () => {
    const bodies = [statusBody(), statusBody(), callFunctionBody(lockView({ payer: "someone-else.near-sandbox-flop" }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.refund(HASH_LOCK)).rejects.toThrow(/payer's own account/);
  });

  it("refuses before refundAfterMs is reached", async () => {
    const bodies = [
      statusBody(),
      statusBody(),
      callFunctionBody(lockView()), // refund_after_ms = 1_800_000_000_000
      blockBody(1, BLOCK_HASH_BASE58, "1700000000000000000"), // now = 1_700_000_000_000, too early
    ];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.refund(HASH_LOCK)).rejects.toThrow(/has not yet reached/);
  });

  it("happy path: signs and sends a refund once the window has opened", async () => {
    const bodies = [
      statusBody(),
      statusBody(),
      callFunctionBody(lockView()),
      blockBody(1, BLOCK_HASH_BASE58, "1800000000100000000"), // now just past refundAfterMs
      viewAccessKeyBody(5),
      blockBody(2, BLOCK_HASH_BASE58, "1800000000200000000"),
      statusBody(),
      sendTxBody("refund-tx-1", "refund-block-hash"),
      blockBody(3, "refund-block-hash", "1800000000300000000"),
    ];
    const { rail, requests } = railWith(bodies);
    const r = await rail();
    const evidence = await r.refund(HASH_LOCK);
    expect(evidence.blockHeight).toBe(3);
    const sendReq = requests[requests.length - 2]?.params as Record<string, unknown>;
    const raw = Buffer.from(String(sendReq.signed_tx_base64), "base64").toString("latin1");
    expect(raw).toContain("refund");
  });
});

// ── recoverByTxHash ──────────────────────────────────────────────────────────────────────────

describe("recoverByTxHash", () => {
  it("returns write evidence when the node still has the transaction", async () => {
    const bodies = [statusBody(), statusBody(), sendTxBody("known-tx", "known-block-hash"), blockBody(7, "known-block-hash", "1700000000000000000")];
    const { rail } = railWith(bodies);
    const r = await rail();
    const evidence = await r.recoverByTxHash("known-tx", BUYER_ACCOUNT);
    expect(evidence).toEqual({ ref: "known-tx", txHash: "known-tx", blockHeight: 7, blockHash: "known-block-hash", raw: expect.any(Array) });
  });

  it("returns null (never throws) when the node has never seen the transaction", async () => {
    const bodies = [statusBody(), statusBody(), errBody(-32000, "[UNKNOWN_TRANSACTION] transaction not found")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.recoverByTxHash("ghost-tx", BUYER_ACCOUNT)).resolves.toBeNull();
  });

  it("propagates any OTHER error unchanged", async () => {
    const bodies = [statusBody(), statusBody(), errBody(-32603, "internal error")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.recoverByTxHash("x", BUYER_ACCOUNT)).rejects.toThrow(/internal error/);
  });
});

// ── findClaimedPreimage / checkPendingClaim ─────────────────────────────────────────────────

describe("findClaimedPreimage / checkPendingClaim", () => {
  it("returns the preimage from a pending (Claiming) lock", async () => {
    const bodies = [statusBody(), callFunctionBody(lockView({ status: "Claiming", preimage: PREIMAGE_HEX }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(HASH_LOCK)).resolves.toBe(PREIMAGE);
  });

  it("checkPendingClaim is the same read as findClaimedPreimage", async () => {
    const bodies = [statusBody(), callFunctionBody(lockView({ status: "Claimed", preimage: PREIMAGE_HEX }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.checkPendingClaim(HASH_LOCK)).resolves.toBe(PREIMAGE);
  });

  it("returns null for a Locked lock (no preimage known yet)", async () => {
    const bodies = [statusBody(), callFunctionBody(lockView({ status: "Locked" }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(HASH_LOCK)).resolves.toBeNull();
  });

  it("returns the preimage from a Locked lock whose payout failed after the reveal (F4: revealed, refund refused)", async () => {
    // The contract's F4 rule: a claim whose ft_transfer failed reverts the status to Locked but
    // keeps the (now public) preimage and refuses every refund. The Buyer's leg A is gone either
    // way; learning `s` here is what lets it still take leg B (main-loop review 2026-09-29).
    const revealedButLocked = lockView({ status: "Locked", preimage: PREIMAGE_HEX });
    const bodies = [statusBody(), callFunctionBody(revealedButLocked), callFunctionBody(revealedButLocked)];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(HASH_LOCK)).resolves.toBe(PREIMAGE);
    await expect(r.checkPendingClaim(HASH_LOCK)).resolves.toBe(PREIMAGE);
  });

  it("returns null when the lock does not exist", async () => {
    const bodies = [statusBody(), callFunctionBody(null)];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(HASH_LOCK)).resolves.toBeNull();
  });

  it("never trusts a preimage that doesn't actually open the hash lock", async () => {
    const wrongPreimageHex = "00".repeat(32);
    const bodies = [statusBody(), callFunctionBody(lockView({ status: "Claiming", preimage: wrongPreimageHex }))];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.findClaimedPreimage(HASH_LOCK)).resolves.toBeNull();
  });
});

// ── chainTimeMs / currentBlockMarker ─────────────────────────────────────────────────────────

describe("chainTimeMs / currentBlockMarker", () => {
  it("chainTimeMs converts the final block header's timestamp_nanosec, ns to ms", async () => {
    const bodies = [statusBody(), blockBody(1, "h", "1700000000123000000")];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.chainTimeMs()).resolves.toBe(1_700_000_000_123);
  });

  it("fails closed on a non-numeric timestamp_nanosec rather than guessing a deadline", async () => {
    const bodies = [statusBody(), ok({ header: { height: 1, hash: "h", timestamp_nanosec: "not-a-number" } })];
    const { rail } = railWith(bodies);
    const r = await rail();
    await expect(r.chainTimeMs()).rejects.toThrow(/refusing to guess/);
  });

  it("currentBlockMarker returns the final block's own height", async () => {
    const bodies = [statusBody(), blockBody(123, "h", "1700000000000000000")];
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

void SEED_SELLER; // reserved for a future two-signer scenario once the client rail lands
