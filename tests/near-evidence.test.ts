// SPDX-License-Identifier: MIT
//
// tests/near-evidence.test.ts — P5-NEAR-SPEC.md §4/D-N10: synthetic near-sandbox JSON-RPC
// responses covering every branch of `nearEvidence`'s fail-closed decode (the Bitcoin/EVM probes
// ported: a donor-nonce splice, an index-only rename to mainnet, wrong token, wrong payee, an
// amount mismatch, `Claiming` not being a final state, a payee unregistered on the token, a
// failure capture, and a captured config weaker than the auditor's), plus live-capture (mocked
// fetch) and disk round-trip coverage for `captureNearLeg`/`loadNearCapture`.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LockTerms } from "@flop-labs/tclk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NEAR_SANDBOX_PIN, type NearChainPin, type NearRailConfig } from "../src/rails/near-htlc.js";
import { CapturingRpc, writeCapture } from "../src/rails/rpc-capture.js";
import {
  captureNearLeg,
  loadNearCapture,
  nearEvidence,
  type NearAccounts,
  type NearCapture,
  type NearCaptureIndex,
  type NearCaptureIndexExchange,
} from "../src/rails/near-evidence.js";

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonRpcError(id: number | string, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

const CONTRACT = "htlc.near-sandbox-flop";
const USDC = "usdc.near-sandbox-flop";
const OTHER_TOKEN = "other-token.near-sandbox-flop";
const BUYER_ACCOUNT = "buyer.near-sandbox-flop";
const SELLER_ACCOUNT = "seller.near-sandbox-flop";
const OTHER_ACCOUNT = "someone-else.near-sandbox-flop";

const PIN: NearChainPin = NEAR_SANDBOX_PIN;
const CONFIG: NearRailConfig = { pin: PIN, endpoint: "http://127.0.0.1:9999", contract: CONTRACT, assets: { USDC } };

const HASH_LOCK = `0x${"ab".repeat(32)}`;
const HASH_LOCK_HEX = HASH_LOCK.slice(2);

const TERMS: LockTerms = {
  contract: "0x" + "11".repeat(32),
  lock: "hash",
  statement: HASH_LOCK,
  amount: "1000000",
  asset: "USDC",
  payer: "did:key:zPayer",
  payee: "did:key:zPayee",
  claimByMs: 1_700_000_000_000,
  refundAfterMs: 1_700_003_600_000,
};

const ACCOUNTS: NearAccounts = { payee: SELLER_ACCOUNT, payer: BUYER_ACCOUNT };
const CHECKED_AT_MS = 1_700_000_500_000;
const BLOCK_HEIGHT = 42;
const BLOCK_HASH = "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM"; // a real 32-byte base58 value
const TIMESTAMP_NS = "1700000500000000000";

/** This fixture file's own standard nonce — every `buildCapture` freezes it into `index.nonce`
 *  by default, and every `nearId` call embeds it by default (mirrors evm-evidence.test.ts's own
 *  `NONCE`/`evmId`). A test demonstrating a same-timestamp/donor-nonce splice passes a different
 *  nonce explicitly instead. */
const NONCE = "aaaaaaaaaaaaaaaa";

function nearId(n: number, ref: string = HASH_LOCK, checkedAtMs: number = CHECKED_AT_MS, nonce: string = NONCE): string {
  return `${ref}:${checkedAtMs}:${nonce}:${n}`;
}

function argsBase64(payload: unknown): string {
  return Buffer.from(new TextEncoder().encode(JSON.stringify(payload))).toString("base64");
}

function resultBytesOf(payload: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(payload)));
}

function lockViewPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    status: "Locked",
    payer: BUYER_ACCOUNT,
    payee: SELLER_ACCOUNT,
    token: USDC,
    amount: "1000000",
    claim_by_ms: String(TERMS.claimByMs),
    refund_after_ms: String(TERMS.refundAfterMs),
    ...overrides,
  };
}

interface ExchangeSpec {
  method: string;
  params: unknown;
  body: string;
}

function statusExchange(opts: { chainId?: string; protocolVersion?: number; error?: boolean } = {}): ExchangeSpec {
  const params: unknown = [];
  return {
    method: "status",
    params,
    body: opts.error
      ? jsonRpcError(nearId(1), -32000, "internal error")
      : jsonRpcResult(nearId(1), { chain_id: opts.chainId ?? PIN.chainId, protocol_version: opts.protocolVersion ?? 86, sync_info: {} }),
  };
}

function blockExchange(opts: { finality?: string; height?: number; hash?: string; timestampNs?: string; error?: boolean; malformed?: boolean } = {}): ExchangeSpec {
  const params = { finality: opts.finality ?? "final" };
  let body: string;
  if (opts.error) body = jsonRpcError(nearId(2), -32000, "internal error");
  else if (opts.malformed) body = jsonRpcResult(nearId(2), { header: { height: "not-a-number" } });
  else body = jsonRpcResult(nearId(2), { header: { height: opts.height ?? BLOCK_HEIGHT, hash: opts.hash ?? BLOCK_HASH, timestamp_nanosec: opts.timestampNs ?? TIMESTAMP_NS } });
  return { method: "block", params, body };
}

function getLockExchange(opts: {
  accountId?: string;
  methodName?: string;
  blockId?: string;
  hashLockArg?: string;
  view?: Record<string, unknown> | null | "malformed";
  panic?: string;
  error?: boolean;
} = {}): ExchangeSpec {
  const params = {
    request_type: "call_function",
    account_id: opts.accountId ?? CONTRACT,
    method_name: opts.methodName ?? "get_lock",
    args_base64: argsBase64({ hash_lock: opts.hashLockArg ?? HASH_LOCK_HEX }),
    block_id: opts.blockId ?? BLOCK_HASH,
  };
  let body: string;
  if (opts.error) body = jsonRpcError(nearId(3), -32000, "internal error");
  else if (opts.panic !== undefined) body = jsonRpcResult(nearId(3), { error: opts.panic, logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.view === "malformed") body = jsonRpcResult(nearId(3), { result: resultBytesOf({ status: "NotAStatus" }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.view === null) body = jsonRpcResult(nearId(3), { result: resultBytesOf(null), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else body = jsonRpcResult(nearId(3), { result: resultBytesOf(opts.view ?? lockViewPayload()), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  return { method: "query", params, body };
}

function storageBalanceExchange(opts: {
  accountId?: string;
  methodName?: string;
  blockId?: string;
  payeeArg?: string;
  balance?: Record<string, unknown> | null | "malformed";
  panic?: string;
  error?: boolean;
} = {}): ExchangeSpec {
  const params = {
    request_type: "call_function",
    account_id: opts.accountId ?? USDC,
    method_name: opts.methodName ?? "storage_balance_of",
    args_base64: argsBase64({ account_id: opts.payeeArg ?? SELLER_ACCOUNT }),
    block_id: opts.blockId ?? BLOCK_HASH,
  };
  let body: string;
  if (opts.error) body = jsonRpcError(nearId(4), -32000, "internal error");
  else if (opts.panic !== undefined) body = jsonRpcResult(nearId(4), { error: opts.panic, logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.balance === "malformed") body = jsonRpcResult(nearId(4), { result: resultBytesOf({ nope: true }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.balance === null) body = jsonRpcResult(nearId(4), { result: resultBytesOf(null), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else body = jsonRpcResult(nearId(4), { result: resultBytesOf(opts.balance ?? { total: "1250000000000000000000", available: "0" }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  return { method: "query", params, body };
}

/** Also builds each exchange's request/response bytes so binding (requestBody parses to exactly
 *  the declared method/params; the response's own `id` matches) holds by default — a test that
 *  wants a tampered exchange does so explicitly, never by accident of a sloppy fixture. */
function buildCapture(opts: {
  ref?: string;
  config?: NearRailConfig;
  nonce?: string;
  checkedAtMs?: number;
  exchanges: ExchangeSpec[];
  error?: string;
}): NearCapture {
  const ref = opts.ref ?? HASH_LOCK;
  const nonce = opts.nonce ?? NONCE;
  const checkedAtMs = opts.checkedAtMs ?? CHECKED_AT_MS;
  const bySha = new Map<string, Uint8Array>();
  const exchanges: NearCaptureIndexExchange[] = opts.exchanges.map((spec, i) => {
    const sha = sha256Hex(spec.body);
    bySha.set(sha, new TextEncoder().encode(spec.body));
    return {
      method: spec.method,
      params: spec.params,
      requestBody: JSON.stringify({ jsonrpc: "2.0", id: nearId(i + 1, ref, checkedAtMs, nonce), method: spec.method, params: spec.params }),
      responseSha256: sha,
      atMs: checkedAtMs - 1000 + i,
    };
  });
  const index: NearCaptureIndex = {
    v: 1,
    rail: "near-htlc",
    ref,
    pin: PIN.name,
    caip2: PIN.caip2,
    endpoint: CONFIG.endpoint,
    checkedAtMs,
    config: opts.config ?? CONFIG,
    nonce,
    ...(opts.error === undefined ? {} : { error: opts.error }),
    exchanges,
  };
  return { index, bytes: bySha };
}

/** The standard four-exchange sequence (status, block, get_lock, storage_balance_of), with room
 *  to override or omit any single exchange. */
function standardExchanges(
  opts: {
    status?: Parameters<typeof statusExchange>[0];
    block?: Parameters<typeof blockExchange>[0];
    lock?: Parameters<typeof getLockExchange>[0];
    storage?: Parameters<typeof storageBalanceExchange>[0] | false;
  } = {},
): ExchangeSpec[] {
  const specs = [statusExchange(opts.status), blockExchange(opts.block), getLockExchange(opts.lock)];
  if (opts.storage !== false) specs.push(storageBalanceExchange(opts.storage));
  return specs;
}

const FINALIZED_REF = `near-sandbox:final:${BLOCK_HEIGHT}:${BLOCK_HASH}`;

// ── happy path ───────────────────────────────────────────────────────────────────────────────

describe("nearEvidence — happy path", () => {
  it("locked, all fields match and payee is storage-registered -> railVerified true, rail locked+final", () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });

    expect(result.lock.railVerified).toBe(true);
    expect(result.rail).toEqual({ status: "locked", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
    expect(result.lock.finalizedRef).toBe(FINALIZED_REF);
    expect(result.lock.ref).toBe(HASH_LOCK);
    expect(result.lock.rail).toBe("near-htlc");
    expect(result.lock.raw).toEqual(capture.index.exchanges.map((e) => e.responseSha256));
  });

  it("locked, payer omitted from accounts -> still true (payer is only optional corroboration)", () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: { payee: SELLER_ACCOUNT }, capture });
    expect(result.lock.railVerified).toBe(true);
    expect(result.rail?.status).toBe("locked");
  });

  it("claimed, fields match -> railVerified false, rail claimed+final", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Claimed", preimage: "cd".repeat(32) }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "claimed", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
  });

  it("refunded, fields match -> railVerified false, rail refunded+final", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Refunded" }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "refunded", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
  });
});

// ── ref/lock and asset gates ────────────────────────────────────────────────────────────────

describe("nearEvidence — ref/lock/asset gates", () => {
  it("ref not equal to terms.statement -> railVerified false, no rail", () => {
    const capture = buildCapture({ ref: `0x${"99".repeat(32)}`, exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });

  it('terms.lock !== "hash" -> railVerified false, no rail', () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const result = nearEvidence({ terms: { ...TERMS, lock: "point" }, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });

  it("K3: terms.asset is not USDC -> railVerified false, no rail, no network fields trusted", () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const result = nearEvidence({ terms: { ...TERMS, asset: "BTC" }, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/K3/);
    expect(result.rail).toBeUndefined();
  });
});

// ── config checks (A4/D3) ───────────────────────────────────────────────────────────────────

describe("nearEvidence — captured config checks (A4/D3)", () => {
  it("capture's own config is shape-invalid -> railVerified null", () => {
    const capture = buildCapture({ config: { ...CONFIG, contract: "NOT A VALID ACCOUNT ID" }, exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/A4\/D3/);
    expect(result.rail).toBeUndefined();
  });

  it("index-only rename to mainnet (capture's own pin edited to a denied chain) -> railVerified null", () => {
    const mainnetConfig: NearRailConfig = {
      ...CONFIG,
      pin: { name: "near-mainnet-forged", chainId: "mainnet", caip2: "near:mainnet", finality: "final" },
    };
    const capture = buildCapture({ config: mainnetConfig, exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/A4\/D3/);
    expect(result.rail).toBeUndefined();
  });

  it("capture was taken under a different contract -> railVerified null", () => {
    const capture = buildCapture({ config: { ...CONFIG, contract: "evil-htlc.near-sandbox-flop" }, exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/different rail config/);
  });

  it("config weaker than the auditor's: capture claims a different (non-genuine) USDC token account -> railVerified null", () => {
    const capture = buildCapture({ config: { ...CONFIG, assets: { USDC: "fake-usdc.near-sandbox-flop" } }, exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/different rail config/);
    expect(result.rail).toBeUndefined();
  });
});

// ── status/block/get_lock binding ───────────────────────────────────────────────────────────

describe("nearEvidence — status binding", () => {
  it("captured chain id disagrees with the pin -> railVerified null", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ status: { chainId: "testnet" } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not match pin/);
  });

  it("status exchange missing -> railVerified null", () => {
    const capture = buildCapture({ exchanges: [blockExchange(), getLockExchange(), storageBalanceExchange()] });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no status exchange/);
  });
});

describe("nearEvidence — block binding", () => {
  it("the block request does not ask for finality \"final\" (tampered selector) -> railVerified null", () => {
    const tampered = blockExchange();
    const spec: ExchangeSpec = { ...tampered, params: { finality: "optimistic" } };
    const capture = buildCapture({ exchanges: [statusExchange(), spec, getLockExchange(), storageBalanceExchange()] });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/finality "final"/);
  });

  it("malformed block result -> railVerified null", () => {
    const capture = buildCapture({ exchanges: [statusExchange(), blockExchange({ malformed: true }), getLockExchange(), storageBalanceExchange()] });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/malformed block result/);
  });
});

describe("nearEvidence — get_lock binding", () => {
  it("get_lock request targets the wrong contract -> railVerified null (tampered)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { accountId: "not-the-contract.near-sandbox-flop" } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this lock/);
  });

  it("get_lock request is not pinned to the finalized block hash -> railVerified null (tampered)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { blockId: "SomeOtherBlockHash1111111111111111111" } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this lock/);
  });

  it("get_lock request carries a different hash_lock argument -> railVerified null (tampered)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { hashLockArg: "ff".repeat(32) } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this lock/);
  });

  it("get_lock panics -> railVerified null", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { panic: "something went wrong" } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/panicked/);
  });

  it("get_lock returns malformed JSON -> railVerified null", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: "malformed" } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/malformed get_lock result/);
  });

  it("no lock at the finalized view (get_lock returns null) -> railVerified null, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: null }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no lock at the finalized view/);
    expect(result.rail).toBeUndefined();
  });
});

// ── Claiming/Refunding are not final (D-N10) ────────────────────────────────────────────────

describe("nearEvidence — Claiming/Refunding are not final outcomes", () => {
  it("Claiming -> railVerified null, no rail (not yet a final state)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Claiming", preimage: "cd".repeat(32) }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/Claiming/);
    expect(result.rail).toBeUndefined();
  });

  it("Refunding -> railVerified null, no rail (not yet a final state)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Refunding" }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/Refunding/);
    expect(result.rail).toBeUndefined();
  });
});

// ── field mismatches (H1: no rail on mismatch) ──────────────────────────────────────────────

describe("nearEvidence — field mismatches (H1: railVerified false, rail OMITTED)", () => {
  it("no payee account line -> railVerified null, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: {}, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no account line/);
    expect(result.rail).toBeUndefined();
  });

  it("wrong payee: on-chain payee differs from the resolved account line -> railVerified false, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ payee: OTHER_ACCOUNT }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/payee/);
    expect(result.rail).toBeUndefined();
  });

  it("wrong token: on-chain token differs from the configured USDC -> railVerified false, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ token: OTHER_TOKEN }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/token/);
    expect(result.rail).toBeUndefined();
  });

  it("amount mismatch: on-chain amount differs from terms -> railVerified false, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ amount: "999" }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/amount/);
    expect(result.rail).toBeUndefined();
  });

  it("amount mismatch is checked numerically, not as a literal string (\"01000000\" would be a decoding bug elsewhere, not equal here)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ amount: "0999999" }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
  });

  it("claimByMs mismatch -> railVerified false, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ claim_by_ms: "1" }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/claimByMs/);
  });

  it("refundAfterMs mismatch -> railVerified false, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ refund_after_ms: "1" }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/refundAfterMs/);
  });

  it("payer mismatch, when a payer account line IS known -> railVerified false, no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ payer: OTHER_ACCOUNT }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/payer/);
  });

  it("claimed with a field mismatch -> railVerified null (defense in depth), no rail", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Claimed", amount: "1" }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/claimed on-chain/);
    expect(result.rail).toBeUndefined();
  });
});

// ── storage_balance_of / payee unregistered ─────────────────────────────────────────────────

describe("nearEvidence — storage_balance_of (payout can land)", () => {
  it("payee unregistered on the token (storage_balance_of returns null) -> railVerified false, NOT locked", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: { balance: null } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/not storage-registered/);
    expect(result.rail).toBeUndefined();
  });

  it("storage_balance_of exchange missing -> railVerified null", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no storage_balance_of exchange/);
  });

  it("storage_balance_of request targets the wrong account -> railVerified null (tampered)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: { payeeArg: OTHER_ACCOUNT } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/storage_balance_of read does not target/);
  });

  it("storage_balance_of request targets the wrong token account -> railVerified null (tampered)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: { accountId: OTHER_TOKEN } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/storage_balance_of read does not target/);
  });

  it("storage_balance_of panics -> railVerified null", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: { panic: "boom" } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/panicked/);
  });

  it("storage_balance_of returns malformed JSON -> railVerified null", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: { balance: "malformed" } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/malformed storage_balance_of/);
  });
});

// ── failure capture (F1) ────────────────────────────────────────────────────────────────────

describe("nearEvidence — failure capture (F1)", () => {
  it("index.error set -> railVerified null naming the error, regardless of what exchanges exist", () => {
    const capture = buildCapture({ exchanges: [], error: "fetch failed: ECONNREFUSED" });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/chain read did not complete/);
    expect(result.lock.reason).toMatch(/ECONNREFUSED/);
    expect(result.rail).toBeUndefined();
  });
});

// ── id binding / donor-nonce splice (H8) ────────────────────────────────────────────────────

describe("nearEvidence — id binding: a donor-nonce splice fails closed", () => {
  it("a genuine get_lock response captured under this same ref/checkedAtMs but a DIFFERENT (donor) nonce does not bind", () => {
    // The "attacker" has a second, genuine capture for the identical ref and checkedAtMs (a
    // coincidence no attacker needs to predict — a retried sweep, two calls under a mocked/coarse
    // clock) but a different random nonce. Its own genuine get_lock response is spliced into the
    // victim capture's index, at the correct position, with the SAME method/params (so the
    // request-shape check alone would not catch it) — only the id's own embedded nonce differs.
    const donorNonce = "bbbbbbbbbbbbbbbb";
    const donorLockSpec = getLockExchange();
    const donorExchange: NearCaptureIndexExchange = {
      method: donorLockSpec.method,
      params: donorLockSpec.params,
      requestBody: JSON.stringify({ jsonrpc: "2.0", id: nearId(3, HASH_LOCK, CHECKED_AT_MS, donorNonce), method: donorLockSpec.method, params: donorLockSpec.params }),
      responseSha256: sha256Hex(jsonRpcResult(nearId(3, HASH_LOCK, CHECKED_AT_MS, donorNonce), JSON.parse(donorLockSpec.body).result)),
      atMs: CHECKED_AT_MS,
    };
    const donorBody = jsonRpcResult(nearId(3, HASH_LOCK, CHECKED_AT_MS, donorNonce), JSON.parse(donorLockSpec.body).result);

    const capture = buildCapture({ exchanges: [statusExchange(), blockExchange(), getLockExchange(), storageBalanceExchange()] });
    const splicedIndex: NearCaptureIndex = { ...capture.index, exchanges: [capture.index.exchanges[0]!, capture.index.exchanges[1]!, donorExchange, capture.index.exchanges[3]!] };
    const bytes = new Map(capture.bytes);
    bytes.set(donorExchange.responseSha256, new TextEncoder().encode(donorBody));

    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: splicedIndex, bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/id is not bound to this capture/);
  });
});

// ── live capture (mocked fetch) ──────────────────────────────────────────────────────────────

/** Unlike `tests/near-htlc.test.ts`'s own `fakeFetch` (canned bodies with a fixed literal id —
 *  fine there, since `NearRpc`/`NearHtlcRail` never check a response's own id against its
 *  request), `nearEvidence`'s `bindExchange` DOES check `envelope.id === request.id` — and
 *  `captureNearLeg` mints a fresh random nonce internally on every call, so no id can be known
 *  ahead of time. This fake echoes back whatever id the real outgoing request actually minted,
 *  paired with the next canned RESULT value in sequence (one per call, in call order). */
function fakeFetch(resultsInOrder: unknown[]): { fetch: typeof fetch; requests: Array<{ method: string; params: unknown }> } {
  const requests: Array<{ method: string; params: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { id: string | number; method: string; params: unknown };
    requests.push({ method: parsed.method, params: parsed.params });
    const result = resultsInOrder[i];
    i += 1;
    if (result === undefined) throw new Error(`fakeFetch: ran out of canned responses (call #${i} was ${parsed.method})`);
    const body = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result });
    const bytes = new TextEncoder().encode(body);
    return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe("captureNearLeg — live (mocked fetch)", () => {
  it("captures status, block, get_lock and storage_balance_of in order, ids namespaced by ref/nowMs/nonce", async () => {
    const nowMs = 1_700_000_900_000;
    const results = [
      { chain_id: PIN.chainId, protocol_version: 86, sync_info: {} },
      { header: { height: BLOCK_HEIGHT, hash: BLOCK_HASH, timestamp_nanosec: TIMESTAMP_NS } },
      { result: resultBytesOf(lockViewPayload()), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH },
      { result: resultBytesOf({ total: "1", available: "0" }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH },
    ];
    const { fetch: fetchImpl, requests } = fakeFetch(results);
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => nowMs });

    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, HASH_LOCK, nowMs);

    expect(index.error).toBeUndefined();
    expect(exchanges).toHaveLength(4);
    expect(requests.map((r) => r.method)).toEqual(["status", "block", "query", "query"]);
    expect(requests[1]!.params).toEqual({ finality: "final" });
    const lockParams = requests[2]!.params as Record<string, unknown>;
    expect(lockParams.method_name).toBe("get_lock");
    expect(lockParams.block_id).toBe(BLOCK_HASH);
    const storageParams = requests[3]!.params as Record<string, unknown>;
    expect(storageParams.method_name).toBe("storage_balance_of");
    expect(storageParams.account_id).toBe(USDC);

    // Every exchange's own id is namespaced "<ref>:<nowMs>:<nonce>:<n>".
    for (const exchange of exchanges) {
      const req = JSON.parse(exchange.requestBody) as { id: string };
      expect(req.id).toMatch(new RegExp(`^${HASH_LOCK}:${nowMs}:${index.nonce}:\\d+$`));
    }

    // nearEvidence over exactly what was just captured live agrees with the synthetic fixture.
    const bytes = new Map<string, Uint8Array>();
    for (const exchange of exchanges) bytes.set(exchange.responseSha256, exchange.responseBytes);
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index, bytes } });
    expect(result.lock.railVerified).toBe(true);
  });

  it("no accounts.payee -> only 3 exchanges (status, block, get_lock); no storage_balance_of call", async () => {
    const nowMs = 1_700_000_900_000;
    const results = [
      { chain_id: PIN.chainId, protocol_version: 86, sync_info: {} },
      { header: { height: BLOCK_HEIGHT, hash: BLOCK_HASH, timestamp_nanosec: TIMESTAMP_NS } },
      { result: resultBytesOf(lockViewPayload()), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH },
    ];
    const { fetch: fetchImpl, requests } = fakeFetch(results);
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => nowMs });
    const { exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, {}, HASH_LOCK, nowMs);
    expect(exchanges).toHaveLength(3);
    expect(requests.map((r) => r.method)).toEqual(["status", "block", "query"]);
  });

  it("a transport failure on the very first call sets index.error and captures nothing", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, HASH_LOCK, 1_700_000_900_000);
    expect(index.error).toBeDefined();
    expect(exchanges).toHaveLength(0);
  });

  it("an invalid ref never touches the network at all", async () => {
    const fetchImpl = (async () => {
      throw new Error("should never be called");
    }) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, { ...TERMS, lock: "point" }, ACCOUNTS, HASH_LOCK, 1_700_000_900_000);
    expect(exchanges).toHaveLength(0);
    expect(index.error).toBeUndefined();
  });
});

// ── loadNearCapture (disk round trip, newest-only) ──────────────────────────────────────────

describe("loadNearCapture", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flop-swap-desk-near-evidence-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeIndexFile(dir: string, stamp: string, index: NearCaptureIndex, exchanges: NearCaptureIndexExchange[], bytesByExchange: Map<string, Uint8Array>): Promise<void> {
    const rawExchanges = exchanges.map((e) => ({
      method: e.method,
      params: e.params,
      requestBody: e.requestBody,
      responseBody: "",
      responseBytes: bytesByExchange.get(e.responseSha256)!,
      responseSha256: e.responseSha256,
      atMs: e.atMs,
    }));
    await writeCapture(root, rawExchanges);
    await mkdir(dir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, `${stamp}.json`), JSON.stringify(index), "utf8");
  }

  it("no capture directory -> capture null, no skip", async () => {
    const result = await loadNearCapture(root, HASH_LOCK);
    expect(result.capture).toBeNull();
    expect(result.skipped).toEqual([]);
  });

  it("reads the newest of two capture files, never an older one", async () => {
    const dir = join(root, "raw", "near", HASH_LOCK);
    const older = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Refunded" }) }, storage: false } ) });
    const newer = buildCapture({ exchanges: standardExchanges() });
    await writeIndexFile(dir, "2026-09-29T00-00-00-000Z", older.index, older.index.exchanges, older.bytes as Map<string, Uint8Array>);
    await writeIndexFile(dir, "2026-09-29T00-01-00-000Z", newer.index, newer.index.exchanges, newer.bytes as Map<string, Uint8Array>);

    const result = await loadNearCapture(root, HASH_LOCK);
    expect(result.capture).not.toBeNull();
    expect(result.skipped).toEqual([]);
    const decoded = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: result.capture! });
    expect(decoded.lock.railVerified).toBe(true); // the newer (Locked) capture, not the older Refunded one
  });

  it("a corrupt newest file fails closed (capture: null) rather than falling back to an older one", async () => {
    const dir = join(root, "raw", "near", HASH_LOCK);
    const older = buildCapture({ exchanges: standardExchanges() });
    await writeIndexFile(dir, "2026-09-29T00-00-00-000Z", older.index, older.index.exchanges, older.bytes as Map<string, Uint8Array>);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "2026-09-29T00-01-00-000Z.json"), "{ not valid json", "utf8");

    const result = await loadNearCapture(root, HASH_LOCK);
    expect(result.capture).toBeNull();
    expect(result.skipped).toEqual(["2026-09-29T00-01-00-000Z.json"]);
  });
});
