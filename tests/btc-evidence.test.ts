// SPDX-License-Identifier: MIT
//
// tests/btc-evidence.test.ts — P4-BTC-SPEC.md §5, Stage BB2: synthetic bitcoind-shaped RPC
// responses covering every branch of `btcEvidence`'s fail-closed decode (mirrors
// tests/evm-evidence.test.ts's own structure for the identical contract), plus
// `captureBtcLeg`'s own never-throws-on-bad-live-data behaviour and live-vs-replay equivalence.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import type { LockTerms } from "@flop-labs/tclk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BTC_REGTEST_NETWORK, buildHtlcScript } from "../src/rails/btc-script.js";
import { CapturingRpc, readCapture, writeCapture } from "../src/rails/rpc-capture.js";
import type { BtcChainPin, BtcRailConfig } from "../src/rails/btc-htlc.js";
import {
  btcEvidence,
  btcLockRefInvalid,
  captureBtcLeg,
  loadBtcCapture,
  BTC_RAIL_ID,
  type BtcAccounts,
  type BtcCapture,
  type BtcCaptureIndex,
  type BtcCaptureIndexExchange,
} from "../src/rails/btc-evidence.js";

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonRpcError(id: number | string, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const PAYEE_PUBKEY = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a"; // seller
const PAYER_PUBKEY = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627"; // buyer
const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
const REFUND_AFTER_MS = 1_700_000_000_000; // -> T = 1_700_000_000
const LOCKTIME = 1_700_000_000;
const FUND_TXID = "ab08a3ba29a27d8ccbc37fe3efe3f56018e34978328bc421361e688dc8d66694";
const FUND_VOUT = 1;
const REF = `${FUND_TXID}:${FUND_VOUT}`;
const AMOUNT_SATS = 100_000_000n;

const GENESIS_HASH = "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206";

const PIN: BtcChainPin = {
  name: "btc-regtest",
  network: "regtest",
  caip2: `bip122:${GENESIS_HASH.slice(0, 32)}`,
  genesisHash: GENESIS_HASH,
  finality: { confirmations: 2 },
};
const CONFIG: BtcRailConfig = { pin: PIN, endpoint: "http://127.0.0.1:19000" };

const SCRIPT = buildHtlcScript(
  { hashLock: hexToBytes(HASH_LOCK.slice(2)), payeePubkey: hexToBytes(PAYEE_PUBKEY), payerPubkey: hexToBytes(PAYER_PUBKEY), locktime: LOCKTIME },
  BTC_REGTEST_NETWORK,
);

const TERMS: LockTerms = {
  contract: `0x${"11".repeat(32)}`,
  lock: "hash",
  statement: HASH_LOCK,
  amount: AMOUNT_SATS.toString(),
  asset: "BTC",
  payer: "did:key:zBuyer",
  payee: "did:key:zSeller",
  claimByMs: REFUND_AFTER_MS - 3_600_000,
  refundAfterMs: REFUND_AFTER_MS,
};

const ACCOUNTS: BtcAccounts = { payeePubkey: PAYEE_PUBKEY, payerPubkey: PAYER_PUBKEY };
const CHECKED_AT_MS = 1_700_000_500_000;
const NONCE = "aaaaaaaaaaaaaaaa";
const TIP_HEIGHT = 110;

function btcId(n: number, ref: string = REF, checkedAtMs: number = CHECKED_AT_MS, nonce: string = NONCE): string {
  return `${ref}:${checkedAtMs}:${nonce}:${n}`;
}

/** A 2-output funding transaction (unsigned — decoding an output never needs a valid signature)
 *  with `scriptPubKey`/`amountSats` at vout `FUND_VOUT` and an unrelated dummy at vout 0, the
 *  same technique tests/btc-htlc.test.ts's own `fakeRawFundingTxHex` uses. */
function fakeRawFundingTxHex(scriptPubKey: Uint8Array, amountSats: bigint): string {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
  tx.addInput({ txid: new Uint8Array(32), index: 0, witnessUtxo: { amount: 1n, script: new Uint8Array([0x00]) } });
  tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(0)]), amount: 1_000_000n }); // vout 0: unrelated
  tx.addOutput({ script: scriptPubKey, amount: amountSats }); // vout 1: the HTLC output
  return bytesToHex(tx.unsignedTx);
}

const GOOD_RAW_TX_HEX = fakeRawFundingTxHex(SCRIPT.scriptPubKey, AMOUNT_SATS);

interface ExchangeSpec {
  method: string;
  params: unknown;
  body: string;
}

/** Builds each exchange's request/response bytes so binding holds by default; a test that wants
 *  a tampered exchange does so explicitly by editing the built index afterward. */
function buildCapture(opts: {
  ref?: string;
  config?: BtcRailConfig;
  nonce?: string;
  checkedAtMs?: number;
  error?: string;
  exchanges: ExchangeSpec[];
}): BtcCapture {
  const nonce = opts.nonce ?? NONCE;
  const ref = opts.ref ?? REF;
  const checkedAtMs = opts.checkedAtMs ?? CHECKED_AT_MS;
  const bySha = new Map<string, Uint8Array>();
  const exchanges: BtcCaptureIndexExchange[] = opts.exchanges.map((spec, i) => {
    const sha = sha256Hex(spec.body);
    bySha.set(sha, new TextEncoder().encode(spec.body));
    return {
      method: spec.method,
      params: spec.params,
      requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(i + 1, ref, checkedAtMs, nonce), method: spec.method, params: spec.params }),
      responseSha256: sha,
      atMs: checkedAtMs - 1000 + i,
    };
  });
  const index: BtcCaptureIndex = {
    v: 1,
    rail: "btc-htlc",
    ref,
    pin: CONFIG.pin.name,
    caip2: CONFIG.pin.caip2,
    endpoint: CONFIG.endpoint,
    checkedAtMs,
    config: opts.config ?? CONFIG,
    nonce,
    ...(opts.error === undefined ? {} : { error: opts.error }),
    exchanges,
  };
  return { index, bytes: bySha };
}

function chainInfoSpec(opts: { chain?: string; blocks?: number } = {}): ExchangeSpec {
  return {
    method: "getblockchaininfo",
    params: [],
    body: jsonRpcResult(btcId(1), { chain: opts.chain ?? "regtest", blocks: opts.blocks ?? TIP_HEIGHT }),
  };
}
function genesisSpec(hash: string = GENESIS_HASH): ExchangeSpec {
  return { method: "getblockhash", params: [0], body: jsonRpcResult(btcId(2), hash) };
}
function rawTxSpec(opts: { hex?: string; confirmations?: number; blockhash?: string; error?: boolean } = {}): ExchangeSpec {
  const body = opts.error
    ? jsonRpcError(btcId(3), -5, "No such mempool or blockchain transaction")
    : jsonRpcResult(btcId(3), {
        hex: opts.hex ?? GOOD_RAW_TX_HEX,
        ...(opts.confirmations === undefined ? {} : { confirmations: opts.confirmations }),
        ...(opts.blockhash === undefined ? {} : { blockhash: opts.blockhash }),
      });
  return { method: "getrawtransaction", params: [FUND_TXID, true], body };
}
function txoutSpec(opts: { spent?: boolean } = {}): ExchangeSpec {
  const body = opts.spent
    ? jsonRpcResult(btcId(4), null)
    : jsonRpcResult(btcId(4), { confirmations: 3, value: 1.0, scriptPubKey: { hex: bytesToHex(SCRIPT.scriptPubKey) } });
  return { method: "gettxout", params: [FUND_TXID, FUND_VOUT, false], body };
}

const FUNDING_BLOCK_HASH = "bb".repeat(32);

/** The standard four "setup" exchanges for a funded, unspent, `confirmations`-confirmed outpoint. */
function unspentExchanges(confirmations: number): ExchangeSpec[] {
  return [chainInfoSpec(), genesisSpec(), rawTxSpec({ confirmations, blockhash: FUNDING_BLOCK_HASH }), txoutSpec()];
}

function blockHashSpec(n: number, height: number, hash: string): ExchangeSpec {
  return { method: "getblockhash", params: [height], body: jsonRpcResult(btcId(n), hash) };
}
function emptyBlockSpec(n: number, hash: string): ExchangeSpec {
  return { method: "getblock", params: [hash, 2], body: jsonRpcResult(btcId(n), { tx: [] }) };
}
function spendBlockSpec(n: number, hash: string, witness: readonly string[]): ExchangeSpec {
  return {
    method: "getblock",
    params: [hash, 2],
    body: jsonRpcResult(btcId(n), { tx: [{ vin: [{ txid: FUND_TXID, vout: FUND_VOUT, txinwitness: witness }] }] }),
  };
}

const WITNESS_SCRIPT_HEX = bytesToHex(SCRIPT.witnessScript);
const CLAIM_WITNESS = [PREIMAGE_HEX, "3044022001020304050607080910111213141516171819202122232425262728293001" /* fake der sig */, WITNESS_SCRIPT_HEX];
const REFUND_WITNESS = ["3044022001020304050607080910111213141516171819202122232425262728293001", "", WITNESS_SCRIPT_HEX];

/** Funding confirmed at height `fundingHeight`, spent at `spendHeight` (found by the scan's
 *  second pair, after one empty block) — used by the claimed/refunded fixtures below. */
function spentExchanges(opts: { fundingHeight: number; spendHeight: number; witness: readonly string[] }): ExchangeSpec[] {
  const specs: ExchangeSpec[] = [chainInfoSpec(), genesisSpec(), rawTxSpec({ confirmations: TIP_HEIGHT - opts.fundingHeight + 1, blockhash: FUNDING_BLOCK_HASH }), txoutSpec({ spent: true })];
  let n = 5;
  for (let height = opts.fundingHeight; height <= opts.spendHeight; height += 1) {
    const hash = `${height.toString(16).padStart(2, "0")}`.repeat(32).slice(0, 64);
    specs.push(blockHashSpec(n, height, hash));
    n += 1;
    if (height === opts.spendHeight) {
      specs.push(spendBlockSpec(n, hash, opts.witness));
    } else {
      specs.push(emptyBlockSpec(n, hash));
    }
    n += 1;
  }
  return specs;
}

// ── btcLockRefInvalid ────────────────────────────────────────────────────────────────────────

describe("btcLockRefInvalid", () => {
  it("accepts a well-formed hash-lock ref", () => {
    expect(btcLockRefInvalid(TERMS, REF)).toBe(false);
  });
  it("rejects a non-hash lock kind", () => {
    expect(btcLockRefInvalid({ ...TERMS, lock: "point" }, REF)).toBe(true);
  });
  it("rejects a malformed ref shape", () => {
    expect(btcLockRefInvalid(TERMS, "not-an-outpoint")).toBe(true);
    expect(btcLockRefInvalid(TERMS, `${FUND_TXID}`)).toBe(true);
    expect(btcLockRefInvalid(TERMS, `${FUND_TXID}:-1`)).toBe(true);
  });
  it("rejects a malformed statement", () => {
    expect(btcLockRefInvalid({ ...TERMS, statement: "0xnothex" }, REF)).toBe(true);
  });
});

// ── btcEvidence: the happy paths ─────────────────────────────────────────────────────────────

describe("btcEvidence — locked", () => {
  it("verifies a funded, sufficiently confirmed, matching outpoint", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.rail).toBe(BTC_RAIL_ID);
    expect(result.lock.ref).toBe(REF);
    expect(result.lock.checkedAtMs).toBe(CHECKED_AT_MS);
    expect(result.rail).toEqual({ status: "locked", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: `btc-regtest:confirmations-2:108:${FUNDING_BLOCK_HASH}` });
  });

  it("reports null, no rail, below the auditor's required confirmations", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(1) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/has 1 confirmation\(s\), need 2/);
    expect(result.rail).toBeUndefined();
  });

  it("reports null, no rail, for a still-unconfirmed (mempool-only) funding transaction", () => {
    const capture = buildCapture({ exchanges: [chainInfoSpec(), genesisSpec(), rawTxSpec({}), txoutSpec({ spent: true })] });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/not yet confirmed/);
    expect(result.rail).toBeUndefined();
  });

  it("reports null, no rail, for a funding transaction that does not exist", () => {
    const capture = buildCapture({ exchanges: [chainInfoSpec(), genesisSpec(), rawTxSpec({ error: true })] });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no such funding transaction/);
    expect(result.rail).toBeUndefined();
  });

  it("railVerified: null with rail attached when the payee's pubkey has not resolved", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: { payerPubkey: PAYER_PUBKEY }, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/has no pubkey line/);
    expect(result.rail?.status).toBe("locked");
  });

  it("railVerified: null when a resolved pubkey is not a valid 33-byte compressed key", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: { payeePubkey: "not-a-pubkey", payerPubkey: PAYER_PUBKEY }, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/not a 33-byte compressed pubkey/);
  });

  it("railVerified: false when the funding scriptPubKey does not match the expected HTLC script", () => {
    const wrongRawTx = fakeRawFundingTxHex(new Uint8Array([0x00, 0x14, ...new Array(20).fill(1)]), AMOUNT_SATS);
    const capture = buildCapture({ exchanges: [chainInfoSpec(), genesisSpec(), rawTxSpec({ hex: wrongRawTx, confirmations: 3, blockhash: FUNDING_BLOCK_HASH }), txoutSpec()] });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/does not match the expected HTLC script/);
    expect(result.rail?.status).toBe("locked");
  });

  it("railVerified: false when the funding value does not match terms.amount", () => {
    const wrongRawTx = fakeRawFundingTxHex(SCRIPT.scriptPubKey, AMOUNT_SATS - 1n);
    const capture = buildCapture({ exchanges: [chainInfoSpec(), genesisSpec(), rawTxSpec({ hex: wrongRawTx, confirmations: 3, blockhash: FUNDING_BLOCK_HASH }), txoutSpec()] });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/does not match terms\.amount/);
  });

  it("railVerified: false for an invalid (non-hash) lock/ref shape, never touching rail state", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3), ref: "not-an-outpoint" });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/ref\/lock mismatch/);
    expect(result.rail).toBeUndefined();
  });

  it("F1: a capture whose own attempt did not complete reports null and names the error", () => {
    const capture = buildCapture({ exchanges: [], error: "fetch failed: ECONNRESET" });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/chain read did not complete: fetch failed: ECONNRESET/);
  });
});

describe("btcEvidence — claimed / refunded", () => {
  it("classifies a claim from the spending witness once final", () => {
    const capture = buildCapture({ exchanges: spentExchanges({ fundingHeight: 108, spendHeight: 109, witness: CLAIM_WITNESS }) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.rail).toEqual({
      status: "claimed",
      final: true,
      checkedAtMs: CHECKED_AT_MS,
      finalizedRef: `btc-regtest:confirmations-2:109:${(109).toString(16).padStart(2, "0").repeat(32).slice(0, 64)}`,
    });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/claimed on-chain, not locked/);
  });

  it("classifies a refund from the spending witness once final", () => {
    const capture = buildCapture({ exchanges: spentExchanges({ fundingHeight: 108, spendHeight: 109, witness: REFUND_WITNESS }) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.rail?.status).toBe("refunded");
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/refunded on-chain, not locked/);
  });

  it("a 32-byte witness item that does NOT open H is treated as a refund, never a false claim", () => {
    const wrongPreimage = "ee".repeat(32);
    const witness = [wrongPreimage, "3044022001020304050607080910111213141516171819202122232425262728293001", WITNESS_SCRIPT_HEX];
    const capture = buildCapture({ exchanges: spentExchanges({ fundingHeight: 108, spendHeight: 109, witness }) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.rail?.status).toBe("refunded");
  });

  it("D1: a claimed/refunded read whose funding fields do not match this swap's terms is null, never a false claimed/refunded", () => {
    const wrongRawTx = fakeRawFundingTxHex(SCRIPT.scriptPubKey, AMOUNT_SATS - 1n);
    const exchanges = spentExchanges({ fundingHeight: 108, spendHeight: 109, witness: CLAIM_WITNESS });
    exchanges[2] = rawTxSpec({ hex: wrongRawTx, confirmations: TIP_HEIGHT - 108 + 1, blockhash: FUNDING_BLOCK_HASH });
    const capture = buildCapture({ exchanges });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/claimed on-chain, but the funding output does not match/);
    expect(result.rail?.status).toBe("claimed");
  });

  it("reports null, no rail, when the spend itself is below the required confirmations", () => {
    const capture = buildCapture({ exchanges: spentExchanges({ fundingHeight: 109, spendHeight: 110, witness: CLAIM_WITNESS }) });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/spend has 1 confirmation\(s\), need 2/);
    expect(result.rail).toBeUndefined();
  });

  it("fails closed when gettxout reports spent but the bounded scan never finds the spend", () => {
    // fundingHeight 108, tipHeight 110 — the scan must cover every height in between; every
    // block here is genuinely empty, so a complete, honest scan still finds nothing.
    const capture = buildCapture({
      exchanges: [
        chainInfoSpec(),
        genesisSpec(),
        rawTxSpec({ confirmations: TIP_HEIGHT - 108 + 1, blockhash: FUNDING_BLOCK_HASH }),
        txoutSpec({ spent: true }),
        blockHashSpec(5, 108, "cc".repeat(32)),
        emptyBlockSpec(6, "cc".repeat(32)),
        blockHashSpec(7, 109, "dd".repeat(32)),
        emptyBlockSpec(8, "dd".repeat(32)),
        blockHashSpec(9, 110, "ee".repeat(32)),
        emptyBlockSpec(10, "ee".repeat(32)),
      ],
    });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/did not find the spending transaction/);
    expect(result.rail).toBeUndefined();
  });
});

// ── config validation (A4/D3, mirrored from evm-evidence.ts) ────────────────────────────────

describe("btcEvidence — config validation", () => {
  it("null for a capture taken under a different network", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3), config: { ...CONFIG, pin: { ...PIN, network: "signet" } } });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture was taken under a different rail config/);
  });

  it("null for a capture taken under a different genesis hash", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3), config: { ...CONFIG, pin: { ...PIN, genesisHash: "ff".repeat(32), caip2: `bip122:${"ff".repeat(16)}` } } });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture was taken under a different rail config/);
  });

  it("D3: null when the captured config's own finality is weaker than the auditor's", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3), config: { ...CONFIG, pin: { ...PIN, finality: { confirmations: 1 } } } });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/weaker than the auditor's configured finality/);
  });

  it("a captured finality that is STRONGER than the auditor's is accepted", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3), config: { ...CONFIG, pin: { ...PIN, finality: { confirmations: 5 } } } });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    // The auditor still only requires 2, and the funding has 3 confirmations, so this verifies.
    expect(result.lock.railVerified).toBe(true);
  });

  it("null for a malformed captured config (fails checkBtcRailConfig's own shape check)", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3), config: { pin: PIN, endpoint: "" } as unknown as BtcRailConfig });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture's own config is invalid/);
  });

  it("null for an off-allow-list network in the captured config", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3), config: { ...CONFIG, pin: { ...PIN, network: "main" as never } } });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
  });
});

// ── A1/D1: bind every exchange, tamper/splice/id-mismatch/malformed cases ───────────────────

describe("btcEvidence — binding, tamper, splice, id-mismatch, malformed captures", () => {
  it("a genuine response from a different exchange spliced in -> unverified (id mismatch)", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const genesisSha = capture.index.exchanges[1]!.responseSha256;
    const spliced: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) => (i === 3 ? { ...exchange, responseSha256: genesisSha } : exchange)),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: spliced, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("a response whose own JSON id does not match its request's id -> unverified", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const badBody = jsonRpcResult(btcId(999), { chain: "regtest", blocks: TIP_HEIGHT });
    const sha = sha256Hex(badBody);
    const bytes = new Map(capture.bytes);
    bytes.set(sha, new TextEncoder().encode(badBody));
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) => (i === 0 ? { ...exchange, responseSha256: sha } : exchange)),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/response id does not match its request/);
  });

  it("a genuine response id from a DIFFERENT capture (different nonce) does not bind here", () => {
    const donor = buildCapture({ exchanges: [chainInfoSpec()], nonce: "bbbbbbbbbbbbbbbb" });
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const donorExchange = donor.index.exchanges[0]!;
    const bytes = new Map(capture.bytes);
    bytes.set(donorExchange.responseSha256, donor.bytes.get(donorExchange.responseSha256)!);
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) => (i === 0 ? donorExchange : exchange)),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("the genesis read rewritten to request a different height -> unverified (tampered block selector)", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) =>
        i === 1
          ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(2), method: "getblockhash", params: [5] }), params: [5] }
          : exchange,
      ),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not request height 0/);
  });

  it("getrawtransaction rewritten to target a different txid -> unverified (tampered)", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const otherTxid = "cd".repeat(32);
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) =>
        i === 2
          ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(3), method: "getrawtransaction", params: [otherTxid, true] }), params: [otherTxid, true] }
          : exchange,
      ),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this ref's txid/);
  });

  it("gettxout rewritten to target a different vout -> unverified (tampered)", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) =>
        i === 3
          ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(4), method: "gettxout", params: [FUND_TXID, 99, false] }), params: [FUND_TXID, 99, false] }
          : exchange,
      ),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this ref/);
  });

  it("a scan getblockhash rewritten out of sequence -> unverified (tampered)", () => {
    const capture = buildCapture({ exchanges: spentExchanges({ fundingHeight: 108, spendHeight: 109, witness: CLAIM_WITNESS }) });
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) =>
        i === 4
          ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(5), method: "getblockhash", params: [500] }), params: [500] }
          : exchange,
      ),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/out of sequence/);
  });

  it("a scan getblock rewritten to a hash other than its own getblockhash's -> unverified (tampered)", () => {
    const capture = buildCapture({ exchanges: spentExchanges({ fundingHeight: 108, spendHeight: 109, witness: CLAIM_WITNESS }) });
    const otherHash = "ee".repeat(32);
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) =>
        i === 5
          ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(6), method: "getblock", params: [otherHash, 2] }), params: [otherHash, 2] }
          : exchange,
      ),
    };
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/not pinned to its own getblockhash/);
  });

  it("a malformed (unparseable) response body -> unverified, never throws", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const badBytes = new TextEncoder().encode("{not json");
    const sha = bytesToHex(sha256(badBytes));
    const bytes = new Map(capture.bytes);
    bytes.set(sha, badBytes);
    const tampered: BtcCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) => (i === 3 ? { ...exchange, responseSha256: sha } : exchange)),
    };
    expect(() => btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes } })).not.toThrow();
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("a missing byte entry (never captured/hash mismatch) -> unverified, never throws", () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    const bytes = new Map(capture.bytes);
    bytes.set(capture.index.exchanges[2]!.responseSha256, null);
    expect(() => btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: capture.index, bytes } })).not.toThrow();
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: capture.index, bytes } });
    expect(result.lock.railVerified).toBeNull();
  });

  it("rpc error envelopes never throw, always fail closed", () => {
    const capture = buildCapture({ exchanges: [chainInfoSpec(), genesisSpec(), rawTxSpec({ confirmations: 3, blockhash: FUNDING_BLOCK_HASH }), { method: "gettxout", params: [FUND_TXID, FUND_VOUT, false], body: jsonRpcError(btcId(4), -1, "internal error") }] });
    expect(() => btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture })).not.toThrow();
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc rejected gettxout/);
  });

  it("a non-numeric getblockchaininfo.blocks never throws, fails closed", () => {
    const capture = buildCapture({ exchanges: [{ method: "getblockchaininfo", params: [], body: jsonRpcResult(btcId(1), { chain: "regtest", blocks: "not-a-number" }) }, genesisSpec(), rawTxSpec({ confirmations: 3, blockhash: FUNDING_BLOCK_HASH }), txoutSpec()] });
    expect(() => btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture })).not.toThrow();
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/malformed getblockchaininfo result/);
  });

  it("a chain name off the auditor's pin never throws, fails closed", () => {
    const capture = buildCapture({ exchanges: [chainInfoSpec({ chain: "signet" }), genesisSpec(), rawTxSpec({ confirmations: 3, blockhash: FUNDING_BLOCK_HASH }), txoutSpec()] });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not match pin/);
  });

  it("a wrong genesis hash never throws, fails closed", () => {
    const capture = buildCapture({ exchanges: [chainInfoSpec(), genesisSpec("aa".repeat(32)), rawTxSpec({ confirmations: 3, blockhash: FUNDING_BLOCK_HASH }), txoutSpec()] });
    const result = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/genesis hash does not match pin/);
  });
});

// ── captureBtcLeg: never throws on bad live chain data ──────────────────────────────────────

describe("captureBtcLeg — never throws on bad live chain data", () => {
  function fetchReturning(bodiesByMethod: Record<string, string>): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number | string };
      const text = bodiesByMethod[body.method] ?? jsonRpcResult(body.id, null);
      const bytes = new TextEncoder().encode(text.includes('"id"') ? text : text); // template already carries its own id below
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
  }

  it("a malformed getblockchaininfo.blocks never throws; returns the one exchange captured so far", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number | string; method: string };
      const text = jsonRpcResult(body.id, { chain: "regtest", blocks: "nope" });
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => CHECKED_AT_MS });

    const { index, exchanges } = await captureBtcLeg(rpc, CONFIG, REF, CHECKED_AT_MS);
    expect(exchanges).toHaveLength(1);
    expect(index.exchanges).toHaveLength(1);
    expect(index.exchanges[0]?.method).toBe("getblockchaininfo");
    expect(index.error).toBeUndefined();
  });

  it("a malformed ref never touches the network at all", async () => {
    const fetchImpl = ((): never => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index, exchanges } = await captureBtcLeg(rpc, CONFIG, "not-an-outpoint", CHECKED_AT_MS);
    expect(exchanges).toHaveLength(0);
    expect(index.exchanges).toHaveLength(0);
  });

  it("a genuine transport failure sets index.error (F1)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index } = await captureBtcLeg(rpc, CONFIG, REF, CHECKED_AT_MS);
    expect(index.error).toMatch(/ECONNREFUSED/);
  });

  it("a JSON-RPC 'no such transaction' error stops the capture without setting index.error", async () => {
    let call = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number | string; method: string };
      call += 1;
      let text: string;
      if (body.method === "getblockchaininfo") text = jsonRpcResult(body.id, { chain: "regtest", blocks: TIP_HEIGHT });
      else if (body.method === "getblockhash") text = jsonRpcResult(body.id, GENESIS_HASH);
      else text = jsonRpcError(body.id, -5, "No such mempool or blockchain transaction");
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index, exchanges } = await captureBtcLeg(rpc, CONFIG, REF, CHECKED_AT_MS);
    expect(call).toBe(3); // chaininfo, genesis, rawtx(error) — never reaches gettxout
    expect(exchanges).toHaveLength(3);
    expect(index.error).toBeUndefined();
  });
});

// ── live vs replay equivalence ───────────────────────────────────────────────────────────────

describe("captureBtcLeg + btcEvidence — live vs replay equivalence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flop-swap-desk-btc-evidence-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("the same captured bytes produce identical evidence live (in-memory) and replayed (from disk)", async () => {
    const responses: Record<string, unknown> = {
      getblockchaininfo: { chain: "regtest", blocks: TIP_HEIGHT },
      getblockhash: GENESIS_HASH, // overridden below for scan calls, unused here (unspent path)
      getrawtransaction: { hex: GOOD_RAW_TX_HEX, confirmations: 3, blockhash: FUNDING_BLOCK_HASH },
      gettxout: { confirmations: 3, value: 1.0, scriptPubKey: { hex: bytesToHex(SCRIPT.scriptPubKey) } },
    };
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number | string; params: unknown[] };
      let result: unknown;
      if (body.method === "getblockhash" && body.params[0] === 0) result = GENESIS_HASH;
      else result = responses[body.method];
      const text = jsonRpcResult(body.id, result);
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;

    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index, exchanges } = await captureBtcLeg(rpc, CONFIG, REF, CHECKED_AT_MS);
    expect(exchanges.length).toBeGreaterThan(0);

    const liveCapture: BtcCapture = { index, bytes: new Map(exchanges.map((e) => [e.responseSha256, e.responseBytes])) };
    const liveResult = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: liveCapture });
    expect(liveResult.lock.railVerified).toBe(true);

    await writeCapture(root, exchanges);
    const replayBytes = new Map(
      await Promise.all(index.exchanges.map(async (e): Promise<[string, Uint8Array | null]> => [e.responseSha256, await readCapture(root, e.responseSha256)])),
    );
    const replayResult = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index, bytes: replayBytes } });

    expect(replayResult).toEqual(liveResult);
  });

  it("a genuine spend, found live by the bounded scan, replays identically", async () => {
    const spendHeight = 109;
    const fundingHeight = 108;
    const blockHashFor = (h: number) => `${h.toString(16).padStart(2, "0")}`.repeat(32).slice(0, 64);
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number | string; params: unknown[] };
      let result: unknown;
      if (body.method === "getblockchaininfo") result = { chain: "regtest", blocks: TIP_HEIGHT };
      else if (body.method === "getblockhash" && body.params[0] === 0) result = GENESIS_HASH;
      else if (body.method === "getblockhash") result = blockHashFor(body.params[0] as number);
      else if (body.method === "getrawtransaction") result = { hex: GOOD_RAW_TX_HEX, confirmations: TIP_HEIGHT - fundingHeight + 1, blockhash: FUNDING_BLOCK_HASH };
      else if (body.method === "gettxout") result = null;
      else if (body.method === "getblock") {
        const hash = body.params[0] as string;
        result = hash === blockHashFor(spendHeight) ? { tx: [{ vin: [{ txid: FUND_TXID, vout: FUND_VOUT, txinwitness: CLAIM_WITNESS }] }] } : { tx: [] };
      }
      const text = jsonRpcResult(body.id, result);
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;

    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index, exchanges } = await captureBtcLeg(rpc, CONFIG, REF, CHECKED_AT_MS);

    const liveCapture: BtcCapture = { index, bytes: new Map(exchanges.map((e) => [e.responseSha256, e.responseBytes])) };
    const liveResult = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: liveCapture });
    expect(liveResult.rail?.status).toBe("claimed");

    await writeCapture(root, exchanges);
    const replayBytes = new Map(
      await Promise.all(index.exchanges.map(async (e): Promise<[string, Uint8Array | null]> => [e.responseSha256, await readCapture(root, e.responseSha256)])),
    );
    const replayResult = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index, bytes: replayBytes } });
    expect(replayResult).toEqual(liveResult);
  });
});

// ── loadBtcCapture ───────────────────────────────────────────────────────────────────────────

describe("loadBtcCapture", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flop-swap-desk-btc-load-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeIndex(index: BtcCaptureIndex, stamp: string): Promise<void> {
    const dir = join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${stamp}.json`), JSON.stringify(index));
  }

  it("returns null with no capture when the directory does not exist", async () => {
    const result = await loadBtcCapture(root, REF);
    expect(result.capture).toBeNull();
    expect(result.skipped).toEqual([]);
  });

  it("loads the newest valid index and its bytes", async () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    await writeCapture(
      root,
      capture.index.exchanges.map((e) => ({
        method: e.method,
        params: e.params,
        requestBody: e.requestBody,
        responseBody: "",
        responseBytes: capture.bytes.get(e.responseSha256)!,
        responseSha256: e.responseSha256,
        atMs: e.atMs,
      })),
    );
    await writeIndex(capture.index, "2026-09-28T00-00-00-000Z");

    const result = await loadBtcCapture(root, REF);
    expect(result.capture).not.toBeNull();
    expect(result.skipped).toEqual([]);
    const decoded = btcEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: result.capture! });
    expect(decoded.lock.railVerified).toBe(true);
  });

  it("never falls back to an older valid capture when the newest is corrupt", async () => {
    const goodCapture = buildCapture({ exchanges: unspentExchanges(3) });
    await writeCapture(
      root,
      goodCapture.index.exchanges.map((e) => ({
        method: e.method,
        params: e.params,
        requestBody: e.requestBody,
        responseBody: "",
        responseBytes: goodCapture.bytes.get(e.responseSha256)!,
        responseSha256: e.responseSha256,
        atMs: e.atMs,
      })),
    );
    await writeIndex(goodCapture.index, "2026-09-28T00-00-00-000Z");
    const dir = join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`);
    await writeFile(join(dir, "2026-09-28T00-00-01-000Z.json"), "{not json at all");

    const result = await loadBtcCapture(root, REF);
    expect(result.capture).toBeNull();
    expect(result.skipped).toEqual(["2026-09-28T00-00-01-000Z.json"]);
  });

  it("ignores .tmp- leftovers when picking the newest file", async () => {
    const capture = buildCapture({ exchanges: unspentExchanges(3) });
    await writeCapture(
      root,
      capture.index.exchanges.map((e) => ({
        method: e.method,
        params: e.params,
        requestBody: e.requestBody,
        responseBody: "",
        responseBytes: capture.bytes.get(e.responseSha256)!,
        responseSha256: e.responseSha256,
        atMs: e.atMs,
      })),
    );
    await writeIndex(capture.index, "2026-09-28T00-00-00-000Z");
    const dir = join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`);
    await writeFile(join(dir, "2026-09-28T99-99-99-999Z.json.tmp-1234"), "garbage");

    const result = await loadBtcCapture(root, REF);
    expect(result.capture).not.toBeNull();
    expect(result.skipped).toEqual([]);
  });

  it("returns null for a malformed ref, never touching the filesystem", async () => {
    const result = await loadBtcCapture(root, "not-an-outpoint");
    expect(result.capture).toBeNull();
  });
});
