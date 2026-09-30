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
  nearLockRefInvalid,
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
// H6 (landed before this Group-E fix list): NearRailConfig requires htlcCodeHash — any
// well-formed base58 string here, this file never exercises H6's own on-chain code-hash check
// (that lives in near-htlc.ts's connect(), not the pure nearEvidence() decoder this file tests).
const HTLC_CODE_HASH = "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT";
const CONFIG: NearRailConfig = { pin: PIN, endpoint: "http://127.0.0.1:9999", contract: CONTRACT, assets: { USDC }, htlcCodeHash: HTLC_CODE_HASH };

const HASH_LOCK = `0x${"ab".repeat(32)}`;
const HASH_LOCK_HEX = HASH_LOCK.slice(2);
// Squatting fix: the near-htlc ref is `0x<hash lock>:<payer>`; the payer here is the Buyer.
const REF = `${HASH_LOCK}:${BUYER_ACCOUNT}`;
// E1: a leg contract id (tclk's own CONTRACT_ID shape, `0x` + 64 lowercase hex) — the second half
// of `loadNearCapture`'s (hashLock, legContract) key.
const LEG_CONTRACT = `0x${"22".repeat(32)}`;

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

function nearId(n: number, ref: string = REF, checkedAtMs: number = CHECKED_AT_MS, nonce: string = NONCE): string {
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

function statusExchange(opts: { chainId?: string; protocolVersion?: number; error?: boolean; ref?: string } = {}): ExchangeSpec {
  const params: unknown = [];
  return {
    method: "status",
    params,
    body: opts.error
      ? jsonRpcError(nearId(1, opts.ref), -32000, "internal error")
      : jsonRpcResult(nearId(1, opts.ref), { chain_id: opts.chainId ?? PIN.chainId, protocol_version: opts.protocolVersion ?? 86, sync_info: {} }),
  };
}

function blockExchange(opts: { finality?: string; height?: number; hash?: string; timestampNs?: string; error?: boolean; malformed?: boolean; ref?: string } = {}): ExchangeSpec {
  const params = { finality: opts.finality ?? "final" };
  let body: string;
  if (opts.error) body = jsonRpcError(nearId(2, opts.ref), -32000, "internal error");
  else if (opts.malformed) body = jsonRpcResult(nearId(2, opts.ref), { header: { height: "not-a-number" } });
  else body = jsonRpcResult(nearId(2, opts.ref), { header: { height: opts.height ?? BLOCK_HEIGHT, hash: opts.hash ?? BLOCK_HASH, timestamp_nanosec: opts.timestampNs ?? TIMESTAMP_NS } });
  return { method: "block", params, body };
}

function getLockExchange(opts: {
  accountId?: string;
  methodName?: string;
  blockId?: string;
  hashLockArg?: string;
  payerArg?: string;
  view?: Record<string, unknown> | null | "malformed";
  panic?: string;
  error?: boolean;
  ref?: string;
} = {}): ExchangeSpec {
  const params = {
    request_type: "call_function",
    account_id: opts.accountId ?? CONTRACT,
    method_name: opts.methodName ?? "get_lock",
    args_base64: argsBase64({ hash_lock: opts.hashLockArg ?? HASH_LOCK_HEX, payer: opts.payerArg ?? BUYER_ACCOUNT }),
    block_id: opts.blockId ?? BLOCK_HASH,
  };
  let body: string;
  if (opts.error) body = jsonRpcError(nearId(3, opts.ref), -32000, "internal error");
  else if (opts.panic !== undefined) body = jsonRpcResult(nearId(3, opts.ref), { error: opts.panic, logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.view === "malformed") body = jsonRpcResult(nearId(3, opts.ref), { result: resultBytesOf({ status: "NotAStatus" }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.view === null) body = jsonRpcResult(nearId(3, opts.ref), { result: resultBytesOf(null), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else body = jsonRpcResult(nearId(3, opts.ref), { result: resultBytesOf(opts.view ?? lockViewPayload()), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
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
  ref?: string;
} = {}): ExchangeSpec {
  const params = {
    request_type: "call_function",
    account_id: opts.accountId ?? USDC,
    method_name: opts.methodName ?? "storage_balance_of",
    args_base64: argsBase64({ account_id: opts.payeeArg ?? SELLER_ACCOUNT }),
    block_id: opts.blockId ?? BLOCK_HASH,
  };
  let body: string;
  if (opts.error) body = jsonRpcError(nearId(4, opts.ref), -32000, "internal error");
  else if (opts.panic !== undefined) body = jsonRpcResult(nearId(4, opts.ref), { error: opts.panic, logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.balance === "malformed") body = jsonRpcResult(nearId(4, opts.ref), { result: resultBytesOf({ nope: true }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else if (opts.balance === null) body = jsonRpcResult(nearId(4, opts.ref), { result: resultBytesOf(null), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
  else body = jsonRpcResult(nearId(4, opts.ref), { result: resultBytesOf(opts.balance ?? { total: "1250000000000000000000", available: "0" }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH });
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
  const ref = opts.ref ?? REF;
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
    expect(result.lock.ref).toBe(REF);
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

// ── E4: a revealed lock is not "locked" ─────────────────────────────────────────────────────

describe("nearEvidence — E4: a revealed lock is not \"locked\"", () => {
  // Needs a preimage that GENUINELY opens the ref (sha256(preimage) === ref) — HASH_LOCK is a
  // fixture value with no known preimage, so this computes its own fresh (preimage, hash) pair
  // and threads it through every exchange's own id binding via each builder's `ref` option.
  const REVEALED_PREIMAGE_BYTES = new Uint8Array(32).fill(0x07);
  const REVEALED_PREIMAGE_HEX = bytesToHex(REVEALED_PREIMAGE_BYTES);
  const REVEALED_HASH_LOCK = `0x${bytesToHex(sha256(REVEALED_PREIMAGE_BYTES))}`;
  const REVEALED_REF = `${REVEALED_HASH_LOCK}:${BUYER_ACCOUNT}`;
  const REVEALED_TERMS: LockTerms = { ...TERMS, statement: REVEALED_HASH_LOCK };

  it("Locked with a preimage that genuinely opens the hash lock -> railVerified null, no rail (F4, not locked)", () => {
    const capture = buildCapture({
      ref: REVEALED_REF,
      exchanges: [
        statusExchange({ ref: REVEALED_REF }),
        blockExchange({ ref: REVEALED_REF }),
        getLockExchange({ ref: REVEALED_REF, hashLockArg: REVEALED_HASH_LOCK.slice(2), view: lockViewPayload({ preimage: REVEALED_PREIMAGE_HEX }) }),
      ],
    });
    const result = nearEvidence({ terms: REVEALED_TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("near-htlc: preimage revealed (F4): payer refund refused, payee may claim");
    expect(result.rail).toBeUndefined();
  });

  it("Locked with a preimage present but NOT opening the hash lock -> still evaluated as an ordinary Locked view (storage check reached)", () => {
    const capture = buildCapture({
      ref: REVEALED_REF,
      exchanges: [
        statusExchange({ ref: REVEALED_REF }),
        blockExchange({ ref: REVEALED_REF }),
        getLockExchange({ ref: REVEALED_REF, hashLockArg: REVEALED_HASH_LOCK.slice(2), view: lockViewPayload({ preimage: "cd".repeat(32) }) }),
        storageBalanceExchange({ ref: REVEALED_REF }),
      ],
    });
    const result = nearEvidence({ terms: REVEALED_TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    // A preimage field that does not actually open the hash lock is never trusted as "revealed"
    // — falls through to the ordinary Locked/storage-registered path exactly as before E4.
    expect(result.lock.railVerified).toBe(true);
    expect(result.rail?.status).toBe("locked");
  });

  it("a mismatched Locked view with a revealed preimage still fails closed on the mismatch first (never reports 'revealed' for the wrong lock)", () => {
    const capture = buildCapture({
      ref: REVEALED_REF,
      exchanges: [
        statusExchange({ ref: REVEALED_REF }),
        blockExchange({ ref: REVEALED_REF }),
        getLockExchange({
          ref: REVEALED_REF,
          hashLockArg: REVEALED_HASH_LOCK.slice(2),
          view: lockViewPayload({ preimage: REVEALED_PREIMAGE_HEX, payee: OTHER_ACCOUNT }),
        }),
      ],
    });
    const result = nearEvidence({ terms: REVEALED_TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/on-chain payee differs/);
    expect(result.rail).toBeUndefined();
  });
});

// ── ref/lock and asset gates ────────────────────────────────────────────────────────────────

describe("nearEvidence — ref/lock/asset gates", () => {
  it("ref not equal to terms.statement -> railVerified false, no rail", () => {
    const capture = buildCapture({ ref: `0x${"99".repeat(32)}:${BUYER_ACCOUNT}`, exchanges: standardExchanges() });
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

// ── E6: the index's own top-level pin/caip2/endpoint fields, checked against its embedded
// config ──────────────────────────────────────────────────────────────────────────────────────

describe("nearEvidence — E6: index's own top-level pin/caip2/endpoint fields", () => {
  it("index.pin disagrees with its own embedded config.pin.name -> railVerified null, tampered index", () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const tampered: NearCapture = { ...capture, index: { ...capture.index, pin: "near-mainnet-forged" } };
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: tampered });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/E6, tampered index/);
    expect(result.rail).toBeUndefined();
  });

  it("index.caip2 disagrees with its own embedded config.pin.caip2 -> railVerified null, tampered index", () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const tampered: NearCapture = { ...capture, index: { ...capture.index, caip2: "near:mainnet" } };
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: tampered });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/E6, tampered index/);
  });

  it("index.endpoint disagrees with its own embedded config.endpoint -> railVerified null, tampered index", () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const tampered: NearCapture = { ...capture, index: { ...capture.index, endpoint: "http://evil.example/rpc" } };
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: tampered });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/E6, tampered index/);
  });

  it("index.pin/caip2/endpoint all agree with the embedded config (the default) -> unaffected", () => {
    const capture = buildCapture({ exchanges: standardExchanges() });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(true);
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

// ── squatting fix: the ref names the payer, and the evidence binds to that exact pair ─────────

describe("nearEvidence — squatting fix: the ref is 0x<hash lock>:<payer>", () => {
  it("nearLockRefInvalid: accepts only a parsed ref whose hash-lock part is terms.statement", () => {
    expect(nearLockRefInvalid(TERMS, REF)).toBe(false);
    expect(nearLockRefInvalid(TERMS, HASH_LOCK)).toBe(true); // the pre-fix ref (bare hash lock)
    expect(nearLockRefInvalid(TERMS, `0x${"99".repeat(32)}:${BUYER_ACCOUNT}`)).toBe(true); // another hash lock
    expect(nearLockRefInvalid(TERMS, `${HASH_LOCK}:`)).toBe(true);
    expect(nearLockRefInvalid(TERMS, `${HASH_LOCK}:Bad Account`)).toBe(true);
    expect(nearLockRefInvalid({ ...TERMS, lock: "point" }, REF)).toBe(true);
  });

  it("a capture whose index ref is the bare hash lock (pre-fix shape) fails closed", () => {
    const capture = buildCapture({ ref: HASH_LOCK, exchanges: standardExchanges({ status: { ref: HASH_LOCK }, block: { ref: HASH_LOCK }, lock: { ref: HASH_LOCK }, storage: { ref: HASH_LOCK } }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });

  it("evidence rejects a capture whose get_lock args name ANOTHER payer (a squatter lock read under the buyer ref)", () => {
    // The ref names the buyer, but the captured get_lock read asked for (squatter, hash lock) and
    // got the squatter's own perfectly well-formed lock back. Field comparison alone would pass
    // (the squatter can copy payee/amount/times); the args binding is what refuses it.
    const capture = buildCapture({
      exchanges: standardExchanges({ lock: { payerArg: OTHER_ACCOUNT, view: lockViewPayload({ payer: OTHER_ACCOUNT }) } }),
    });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this lock/);
    expect(result.rail).toBeUndefined();
  });

  it("evidence rejects a get_lock read that carries no payer argument (the pre-fix request shape)", () => {
    const params = {
      request_type: "call_function",
      account_id: CONTRACT,
      method_name: "get_lock",
      args_base64: argsBase64({ hash_lock: HASH_LOCK_HEX }),
      block_id: BLOCK_HASH,
    };
    const good = getLockExchange();
    const capture = buildCapture({ exchanges: [statusExchange(), blockExchange(), { ...good, params }, storageBalanceExchange()] });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this lock/);
  });

  it("evidence rejects get_lock args with an extra field", () => {
    const params = {
      request_type: "call_function",
      account_id: CONTRACT,
      method_name: "get_lock",
      args_base64: argsBase64({ hash_lock: HASH_LOCK_HEX, payer: BUYER_ACCOUNT, extra: 1 }),
      block_id: BLOCK_HASH,
    };
    const good = getLockExchange();
    const capture = buildCapture({ exchanges: [statusExchange(), blockExchange(), { ...good, params }, storageBalanceExchange()] });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this lock/);
  });

  it("evidence requires the on-chain payer to equal the ref payer (railVerified false, no rail)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ payer: OTHER_ACCOUNT }) }, storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: { payee: SELLER_ACCOUNT }, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/payer named by the ref/);
    expect(result.rail).toBeUndefined();
  });

  it("when a payer account line exists it must equal the ref payer", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ storage: false }) });
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: { payee: SELLER_ACCOUNT, payer: OTHER_ACCOUNT }, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/payer account line/);
    expect(result.rail).toBeUndefined();
  });

  it("a capture of the squatter own pair reads as the squatter own lock (its ref names the squatter), never the buyer", () => {
    const squatRef = `${HASH_LOCK}:${OTHER_ACCOUNT}`;
    const capture = buildCapture({
      ref: squatRef,
      exchanges: standardExchanges({
        status: { ref: squatRef },
        block: { ref: squatRef },
        lock: { ref: squatRef, payerArg: OTHER_ACCOUNT, view: lockViewPayload({ payer: OTHER_ACCOUNT }) },
        storage: { ref: squatRef },
      }),
    });
    // The evidence layer keeps the ref it was handed; the replay layer requires the capture ref
    // to equal the ACCEPTED lock frame ref, so this never stands in for the buyer (see
    // tests/replay.test.ts and tests/watcher.test.ts).
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: { payee: SELLER_ACCOUNT }, capture });
    expect(result.lock.ref).toBe(squatRef);
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
      requestBody: JSON.stringify({ jsonrpc: "2.0", id: nearId(3, REF, CHECKED_AT_MS, donorNonce), method: donorLockSpec.method, params: donorLockSpec.params }),
      responseSha256: sha256Hex(jsonRpcResult(nearId(3, REF, CHECKED_AT_MS, donorNonce), JSON.parse(donorLockSpec.body).result)),
      atMs: CHECKED_AT_MS,
    };
    const donorBody = jsonRpcResult(nearId(3, REF, CHECKED_AT_MS, donorNonce), JSON.parse(donorLockSpec.body).result);

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

    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, REF, nowMs);

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
      expect(req.id).toMatch(new RegExp(`^${REF}:${nowMs}:${index.nonce}:\\d+$`));
    }

    // nearEvidence over exactly what was just captured live agrees with the synthetic fixture.
    const bytes = new Map<string, Uint8Array>();
    for (const exchange of exchanges) bytes.set(exchange.responseSha256, exchange.responseBytes);
    const result = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index, bytes } });
    expect(result.lock.railVerified).toBe(true);
  });

  it("the live get_lock read carries the ref payer (squatting fix), and an unparseable ref captures nothing", async () => {
    const nowMs = 1_700_000_900_000;
    const results = [
      { chain_id: PIN.chainId, protocol_version: 86, sync_info: {} },
      { header: { height: BLOCK_HEIGHT, hash: BLOCK_HASH, timestamp_nanosec: TIMESTAMP_NS } },
      { result: resultBytesOf(lockViewPayload()), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH },
    ];
    const { fetch: fetchImpl, requests } = fakeFetch(results);
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => nowMs });
    await captureNearLeg(rpc, CONFIG, TERMS, {}, REF, nowMs);
    const lockParams = requests[2]!.params as Record<string, unknown>;
    expect(JSON.parse(Buffer.from(String(lockParams.args_base64), "base64").toString("utf8"))).toEqual({ hash_lock: HASH_LOCK_HEX, payer: BUYER_ACCOUNT });

    const none = fakeFetch([]);
    const rpc2 = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: none.fetch, clock: () => nowMs });
    const bare = await captureNearLeg(rpc2, CONFIG, TERMS, {}, HASH_LOCK, nowMs);
    expect(bare.exchanges).toHaveLength(0);
    expect(none.requests).toHaveLength(0);
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
    const { exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, {}, REF, nowMs);
    expect(exchanges).toHaveLength(3);
    expect(requests.map((r) => r.method)).toEqual(["status", "block", "query"]);
  });

  it("a transport failure on the very first call sets index.error and captures nothing", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, REF, 1_700_000_900_000);
    expect(index.error).toBeDefined();
    expect(exchanges).toHaveLength(0);
  });

  it("an invalid ref never touches the network at all", async () => {
    const fetchImpl = (async () => {
      throw new Error("should never be called");
    }) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, { ...TERMS, lock: "point" }, ACCOUNTS, REF, 1_700_000_900_000);
    expect(exchanges).toHaveLength(0);
    expect(index.error).toBeUndefined();
  });

  // ── E2: only an RpcCaptureError is a completed read; any other error is a failure capture ──

  /** Answers each call in order with either `{ result }`, a genuine JSON-RPC `{ error }`
   *  envelope (still an HTTP-200, still fully recorded — becomes an `RpcCaptureError`), or
   *  `"throw"` (a transport-level failure — `CapturingRpc` never gets to push anything for that
   *  call at all). Echoes back whatever id the real outgoing request minted, exactly like
   *  `fakeFetch` above. */
  function fakeFetchWithOutcomes(outcomes: Array<{ result: unknown } | { errorMessage: string } | "throw">): typeof fetch {
    let i = 0;
    return (async (_url: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { id: string | number };
      const outcome = outcomes[i];
      i += 1;
      if (outcome === undefined) throw new Error(`fakeFetchWithOutcomes: ran out of canned outcomes (call #${i})`);
      if (outcome === "throw") throw new TypeError("network failure");
      const envelope =
        "errorMessage" in outcome
          ? { jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: outcome.errorMessage } }
          : { jsonrpc: "2.0", id: parsed.id, result: outcome.result };
      const body = JSON.stringify(envelope);
      const bytes = new TextEncoder().encode(body);
      return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
  }

  const STATUS_RESULT = { chain_id: PIN.chainId, protocol_version: 86, sync_info: {} };
  const BLOCK_RESULT = { header: { height: BLOCK_HEIGHT, hash: BLOCK_HASH, timestamp_nanosec: TIMESTAMP_NS } };
  const LOCK_RESULT = { result: resultBytesOf(lockViewPayload()), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH };
  const STORAGE_RESULT = { result: resultBytesOf({ total: "1", available: "0" }), logs: [], block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH };

  it("E2: a genuine JSON-RPC error on get_lock is a completed read — no index.error, storage_balance_of still attempted", async () => {
    const fetchImpl = fakeFetchWithOutcomes([
      { result: STATUS_RESULT },
      { result: BLOCK_RESULT },
      { errorMessage: "contract panicked" }, // get_lock: a real RpcCaptureError, still recorded
      { result: STORAGE_RESULT },
    ]);
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, REF, 1_700_000_900_000);
    expect(index.error).toBeUndefined();
    expect(exchanges).toHaveLength(4);
    expect(exchanges[2]!.responseBody).toContain("contract panicked");
  });

  it("E2: a transport failure on get_lock sets index.error and never reaches storage_balance_of", async () => {
    const fetchImpl = fakeFetchWithOutcomes([{ result: STATUS_RESULT }, { result: BLOCK_RESULT }, "throw"]);
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, REF, 1_700_000_900_000);
    expect(index.error).toBeDefined();
    // Only status and block were ever recorded — get_lock's own transport failure left nothing
    // for `CapturingRpc` to push, and storage_balance_of was never even attempted.
    expect(exchanges).toHaveLength(2);
  });

  it("E2: a genuine JSON-RPC error on storage_balance_of is a completed read — no index.error", async () => {
    const fetchImpl = fakeFetchWithOutcomes([
      { result: STATUS_RESULT },
      { result: BLOCK_RESULT },
      { result: LOCK_RESULT },
      { errorMessage: "token contract panicked" }, // storage_balance_of: a real RpcCaptureError
    ]);
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, REF, 1_700_000_900_000);
    expect(index.error).toBeUndefined();
    expect(exchanges).toHaveLength(4);
    expect(exchanges[3]!.responseBody).toContain("token contract panicked");
  });

  it("E2: a transport failure on storage_balance_of sets index.error (get_lock's own exchange is still kept)", async () => {
    const fetchImpl = fakeFetchWithOutcomes([{ result: STATUS_RESULT }, { result: BLOCK_RESULT }, { result: LOCK_RESULT }, "throw"]);
    const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 1_700_000_900_000 });
    const { index, exchanges } = await captureNearLeg(rpc, CONFIG, TERMS, ACCOUNTS, REF, 1_700_000_900_000);
    expect(index.error).toBeDefined();
    expect(exchanges).toHaveLength(3);
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
    const result = await loadNearCapture(root, HASH_LOCK, LEG_CONTRACT);
    expect(result.capture).toBeNull();
    expect(result.skipped).toEqual([]);
  });

  // E1: keyed by (hashLock, legContract) — a malformed legContract must never touch the
  // filesystem at all, the same discipline readCapture's own SHA256_HEX guard applies.
  it("a malformed legContract is refused before ever touching the filesystem", async () => {
    const dir = join(root, "raw", "near", HASH_LOCK, LEG_CONTRACT);
    const capture = buildCapture({ exchanges: standardExchanges() });
    await writeIndexFile(dir, "2026-09-29T00-00-00-000Z", capture.index, capture.index.exchanges, capture.bytes as Map<string, Uint8Array>);

    for (const badLegContract of ["../../etc/passwd", "not-a-contract-id", `0x${"AB".repeat(32)}` /* uppercase refused */]) {
      const result = await loadNearCapture(root, HASH_LOCK, badLegContract);
      expect(result.capture).toBeNull();
      expect(result.skipped).toEqual([]);
    }
  });

  // E1: two different leg contracts genuinely sharing the same hash lock each get their own
  // capture, isolated by directory — reading one never sees, and can never be overwritten by,
  // the other's.
  it("two different leg contracts sharing the same hash lock never see or overwrite each other's capture", async () => {
    const otherLegContract = `0x${"33".repeat(32)}`;
    const mine = buildCapture({ exchanges: standardExchanges() });
    const theirs = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Refunded" }) }, storage: false }) });
    await writeIndexFile(join(root, "raw", "near", HASH_LOCK, LEG_CONTRACT), "only", mine.index, mine.index.exchanges, mine.bytes as Map<string, Uint8Array>);
    await writeIndexFile(join(root, "raw", "near", HASH_LOCK, otherLegContract), "only", theirs.index, theirs.index.exchanges, theirs.bytes as Map<string, Uint8Array>);

    const mineResult = await loadNearCapture(root, HASH_LOCK, LEG_CONTRACT);
    const theirsResult = await loadNearCapture(root, HASH_LOCK, otherLegContract);
    expect(mineResult.capture).not.toBeNull();
    expect(theirsResult.capture).not.toBeNull();
    const mineDecoded = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: mineResult.capture! });
    const theirsDecoded = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: theirsResult.capture! });
    expect(mineDecoded.rail?.status).toBe("locked");
    expect(theirsDecoded.rail?.status).toBe("refunded");
  });

  it("a full ref matches only that exact ref; a bare hash lock (the directory key) matches any payer index", async () => {
    const dir = join(root, "raw", "near", HASH_LOCK, LEG_CONTRACT);
    const capture = buildCapture({ exchanges: standardExchanges() });
    await writeIndexFile(dir, "only", capture.index, capture.index.exchanges, capture.bytes as Map<string, Uint8Array>);

    expect((await loadNearCapture(root, REF, LEG_CONTRACT)).capture).not.toBeNull();
    expect((await loadNearCapture(root, HASH_LOCK, LEG_CONTRACT)).capture?.index.ref).toBe(REF);
    // A ref naming another payer finds the directory but not a matching index: skipped, fail closed.
    const other = await loadNearCapture(root, `${HASH_LOCK}:${OTHER_ACCOUNT}`, LEG_CONTRACT);
    expect(other.capture).toBeNull();
    expect(other.skipped).toEqual(["only.json"]);
    // Neither shape: nothing read.
    expect((await loadNearCapture(root, "not-a-ref", LEG_CONTRACT)).capture).toBeNull();
  });

  it("reads the newest of two capture files, never an older one", async () => {
    const dir = join(root, "raw", "near", HASH_LOCK, LEG_CONTRACT);
    const older = buildCapture({ exchanges: standardExchanges({ lock: { view: lockViewPayload({ status: "Refunded" }) }, storage: false } ) });
    const newer = buildCapture({ exchanges: standardExchanges() });
    await writeIndexFile(dir, "2026-09-29T00-00-00-000Z", older.index, older.index.exchanges, older.bytes as Map<string, Uint8Array>);
    await writeIndexFile(dir, "2026-09-29T00-01-00-000Z", newer.index, newer.index.exchanges, newer.bytes as Map<string, Uint8Array>);

    const result = await loadNearCapture(root, HASH_LOCK, LEG_CONTRACT);
    expect(result.capture).not.toBeNull();
    expect(result.skipped).toEqual([]);
    const decoded = nearEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: result.capture! });
    expect(decoded.lock.railVerified).toBe(true); // the newer (Locked) capture, not the older Refunded one
  });

  it("a corrupt newest file fails closed (capture: null) rather than falling back to an older one", async () => {
    const dir = join(root, "raw", "near", HASH_LOCK, LEG_CONTRACT);
    const older = buildCapture({ exchanges: standardExchanges() });
    await writeIndexFile(dir, "2026-09-29T00-00-00-000Z", older.index, older.index.exchanges, older.bytes as Map<string, Uint8Array>);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "2026-09-29T00-01-00-000Z.json"), "{ not valid json", "utf8");

    const result = await loadNearCapture(root, HASH_LOCK, LEG_CONTRACT);
    expect(result.capture).toBeNull();
    expect(result.skipped).toEqual(["2026-09-29T00-01-00-000Z.json"]);
  });
});
