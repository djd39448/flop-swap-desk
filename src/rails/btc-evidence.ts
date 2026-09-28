// SPDX-License-Identifier: MIT
//
// Pure evidence adapter for the `btc-htlc` rail (P4-BTC-SPEC.md §5): the Bitcoin twin of
// `src/rails/evm-evidence.ts`, over the identical contract — bind every exchange to its own
// request, validate every value, fail closed (`railVerified: null` with a reason, never a thrown
// exception), take `checkedAtMs` from the index, and let a capture's own frozen `config` gate
// what it can be trusted to say (it must agree with the auditor's supplied config and can never
// claim a *weaker* finality than the auditor asked for). `btcEvidence` is pure and synchronous
// over an already-captured `BtcCapture`; `captureBtcLeg` is the one function here that touches
// the network (through the caller's own `rpc-capture.ts` `CapturingRpc`), and only ever appends
// to the log, never throwing for a chain-state reason (a missing tx, an unconfirmed one, a spend
// it could not classify) — only a genuine transport failure sets the capture's own `error` field
// (F1's rule, reused here), so a failed sweep is still saved and replays identically to the live
// board.
//
// Unlike EVM's `locks(hashLock)` read (one on-chain struct, one status enum), Bitcoin has no
// contract to ask "is this locked" — the evidence *is* the funding output's own current UTXO
// state, so this reader has to derive it live: `gettxout(txid, vout, false)` (the confirmed-only
// UTXO set — its own third argument excludes the mempool, so an unconfirmed funding is
// indistinguishable from "spent" by that call alone) disambiguated against
// `getrawtransaction(txid, true)`'s own `confirmations`/`blockhash` fields, and — only once the
// funding output is confirmed but no longer unspent — a bounded `getblock(hash, 2)` scan forward
// from the funding height to find the single transaction that spent it. Every read here reports
// a state at *some* height; `btcEvidence` only ever returns a `RailObservation` once that state's
// own confirmations have reached the auditor's configured `N` (mirroring EVM's "only ever read
// at the finalized view" — Bitcoin's finality knob is a confirmations count, not a block tag, but
// the same discipline of "nothing below the bar is reported as a fact" applies identically): below
// `N`, this returns `railVerified: null` with a reason naming how many more confirmations are
// needed, and no `RailObservation` at all — there is no "final: false" case anywhere in this
// file, the same as there has never been one in evm-evidence.ts.
//
// The P2WSH script commits to *public keys*, not addresses (P4-BTC-SPEC.md §6), and the refund
// branch commits to the payer's key too — so verifying a `btc-htlc` leg needs BOTH parties'
// resolved pubkeys (`BtcAccounts`, from `src/rails/account-line.ts`'s `resolvePubkeys`), unlike
// EVM where only the payee's account is required to check a lock.
//
// Honesty limit (P22-P24-EVM-FIXES-R3.md F3, carried over verbatim): a capture is the capturing
// process's own bytes. Replaying it detects corruption, splicing, mismatched requests and config
// drift — never forgery. A fabricated response named by its own (correct) hash still replays as
// genuine; the independent check is that every `finalizedRef` names a real block hash and height,
// so anyone can re-query the same outpoint against the real chain.
//
// Design source: flop-contrib/handoff/P4-BTC-SPEC.md §5, §6;
// flop-contrib/handoff/research/btc-regtest-probe-2026-09-28.md.

import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";
import type { LockTerms } from "@flop-labs/tclk";

import {
  BTC_REGTEST_NETWORK,
  BTC_SIGNET_NETWORK,
  buildHtlcScript,
  bytesEqual,
  locktimeFromRefundAfterMs,
} from "./btc-script.js";
import { checkBtcRailConfig, type BtcChainPin, type BtcRailConfig } from "./btc-htlc.js";
import { readCapture, type CapturingRpc, type Exchange } from "./rpc-capture.js";
import type { LockEvidence, RailObservation } from "../types.js";

export const BTC_RAIL_ID = "btc-htlc";

const REF_SHAPE = /^[0-9a-f]{64}:[0-9]+$/;
const HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/;
const PUBKEY_SHAPE = /^0[23][0-9a-f]{64}$/; // 33-byte compressed secp256k1 point, lowercase hex
const BLOCK_HASH_SHAPE = /^[0-9a-fA-F]{64}$/;
const SHA256_HEX_LOWER = /^[0-9a-f]{64}$/;

/** Hoisted so it can run before any network call, exactly like `evm-evidence.ts`'s
 *  `hashLockRefMismatch`: `terms.lock` must be `"hash"`, `ref` must look like an outpoint, and
 *  `terms.statement` must itself be a sha256 hash-lock shape (checked here rather than left to
 *  the script builder to discover later, so a malformed statement never gets as far as a
 *  network round trip either — used both by `btcEvidence` and, in a later stage,
 *  `BtcHtlcRail.verifyLockFinal`/`captureBtcLeg`'s own guard). */
export function btcLockRefInvalid(terms: LockTerms, ref: string): boolean {
  return terms.lock !== "hash" || !REF_SHAPE.test(ref) || !HASH_LOCK_SHAPE.test(terms.statement);
}

function parseRef(ref: string): { txid: string; vout: number } | null {
  if (!REF_SHAPE.test(ref)) return null;
  const parts = ref.split(":");
  const txid = parts[0];
  const voutStr = parts[1];
  if (txid === undefined || voutStr === undefined) return null;
  return { txid, vout: Number(voutStr) };
}

function networkParamsFor(network: BtcChainPin["network"]): BTC_NETWORK {
  return network === "regtest" ? BTC_REGTEST_NETWORK : BTC_SIGNET_NETWORK;
}

/** One captured exchange as it sits in the index file — mirrors
 *  `EvmCaptureIndexExchange` exactly (see rpc-capture.ts for where the response bytes live). */
export interface BtcCaptureIndexExchange {
  method: string;
  params: unknown;
  requestBody: string;
  responseSha256: string;
  atMs: number;
}

/** `raw/btc/<txid>-<vout>/<iso-stamp>.json` (§5) — a hyphen, never the ref's own `:`, since `:`
 *  is not a legal Windows filename character (this build's own machine). */
export interface BtcCaptureIndex {
  v: 1;
  rail: "btc-htlc";
  ref: string;
  pin: string;
  caip2: string;
  endpoint: string;
  checkedAtMs: number;
  /** The full `BtcRailConfig` this capture was taken under (mirrors EVM's A4: frozen at capture
   *  time, so a later `rails.json` edit can never silently change how an old capture replays). */
  config: BtcRailConfig;
  /** A random value minted once per `captureBtcLeg` call — every id this capture's own exchanges
   *  carry is namespaced `"<ref>:<checkedAtMs>:<nonce>:<n>"` (mirrors EVM's F2 same-timestamp
   *  splice fix). */
  nonce: string;
  /** Set when this capture attempt did not run to completion (mirrors EVM's F1). Absent for a
   *  capture that ran to completion, whether or not it found anything verifiable. */
  error?: string;
  exchanges: BtcCaptureIndexExchange[];
}

/** The index plus every exchange's already-loaded, already-re-hashed response bytes — identical
 *  shape and purpose to `EvmCapture`. */
export interface BtcCapture {
  index: BtcCaptureIndex;
  bytes: ReadonlyMap<string, Uint8Array | null>;
}

/** The two parties' resolved pubkeys for this leg (`src/rails/account-line.ts`'s
 *  `resolvePubkeys`) — both required to rebuild the witnessScript (P4-BTC-SPEC.md §6); `terms`
 *  itself (tclk's `LockTerms`) carries only DIDs, never chain key material. */
export interface BtcAccounts {
  payeePubkey?: string;
  payerPubkey?: string;
}

export interface BtcEvidenceInput {
  terms: LockTerms;
  config: BtcRailConfig;
  accounts: BtcAccounts;
  capture: BtcCapture;
}

export interface BtcEvidenceResult {
  lock: LockEvidence;
  rail?: RailObservation;
}

// ── binding (A1's rule, reused verbatim for Bitcoin) ────────────────────────────────────────

interface ParsedRequest {
  id: number | string;
  method: string;
  params: unknown;
}

function parseRequestBody(exchange: BtcCaptureIndexExchange): ParsedRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exchange.requestBody);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if ((typeof obj.id !== "number" && typeof obj.id !== "string") || typeof obj.method !== "string") return null;
  return { id: obj.id, method: obj.method, params: obj.params };
}

function idBoundToCapture(capture: BtcCapture, id: number | string): boolean {
  return typeof id === "string" && id.startsWith(`${capture.index.ref}:${capture.index.checkedAtMs}:${capture.index.nonce}:`);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type EnvelopeOutcome = { kind: "result"; value: unknown } | { kind: "error" };

type BoundExchange =
  | { kind: "missing"; reason: string }
  | { kind: "bound"; request: ParsedRequest; outcome: EnvelopeOutcome };

/** The Bitcoin twin of `evm-evidence.ts`'s `bindExchange`: authenticates that a candidate
 *  exchange's own `requestBody` really does ask for what the index's (editable) `.method`/
 *  `.params` metadata claims, and that the response's own JSON-RPC `id` really does answer that
 *  exact request AND is bound to this exact capture (`idBoundToCapture`) — never merely trusted
 *  because a same-shaped response happened to be captured somewhere. */
function bindExchange(capture: BtcCapture, exchange: BtcCaptureIndexExchange | null, label: string): BoundExchange {
  if (exchange === null) return { kind: "missing", reason: `missing/tampered capture: no ${label} exchange` };
  const request = parseRequestBody(exchange);
  if (request === null) {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (malformed request)` };
  }
  if (request.method !== exchange.method || !sameJson(request.params, exchange.params)) {
    return {
      kind: "missing",
      reason: `missing/tampered capture: ${label} (request does not match its own recorded method/params)`,
    };
  }
  const bytes = capture.bytes.get(exchange.responseSha256);
  if (bytes === undefined || bytes === null) return { kind: "missing", reason: `missing/tampered capture: ${label}` };
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (undecodable)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (unparseable)` };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (not a JSON-RPC object)` };
  }
  const envelope = parsed as { id?: unknown; result?: unknown; error?: unknown };
  if (envelope.id !== request.id) {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (response id does not match its request)` };
  }
  if (!idBoundToCapture(capture, request.id)) {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (id is not bound to this capture's ref/checkedAtMs)` };
  }
  if (envelope.error !== undefined && envelope.error !== null) return { kind: "bound", request, outcome: { kind: "error" } };
  return { kind: "bound", request, outcome: { kind: "result", value: envelope.result } };
}

/** Position-authenticated lookup: `captureBtcLeg` always appends this leg's fixed setup reads
 *  in this exact order (0: getblockchaininfo, 1: getblockhash(0), 2: getrawtransaction, 3:
 *  gettxout), then, only if needed, the bounded scan's own getblockhash/getblock pairs from
 *  index 4 on. A candidate at the wrong position is refused by `bindExchange`'s own request
 *  re-check below (its own `.method` there would simply not equal what the caller asks for), so
 *  this is a convenience for a fixed, known layout, never a substitute for content binding. */
function exchangeAt(exchanges: readonly BtcCaptureIndexExchange[], i: number, expectedMethod: string): BtcCaptureIndexExchange | null {
  const e = exchanges[i];
  return e !== undefined && e.method === expectedMethod ? e : null;
}

function requestParams(request: ParsedRequest): unknown[] | null {
  return Array.isArray(request.params) ? request.params : null;
}

// ── funding-tx / spend decoding ──────────────────────────────────────────────────────────────

function decodeFundingOutput(rawTxResult: unknown, vout: number): { scriptPubKey: Uint8Array; amountSats: bigint } | null {
  if (rawTxResult === null || typeof rawTxResult !== "object") return null;
  const hex = (rawTxResult as { hex?: unknown }).hex;
  if (typeof hex !== "string") return null;
  try {
    const decoded = Transaction.fromRaw(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    if (vout < 0 || vout >= decoded.outputsLength) return null;
    const output = decoded.getOutput(vout);
    if (output.script === undefined || output.amount === undefined) return null;
    return { scriptPubKey: output.script, amountSats: output.amount };
  } catch {
    return null;
  }
}

function rawTxConfirmations(rawTxResult: unknown): number | null {
  if (rawTxResult === null || typeof rawTxResult !== "object") return null;
  const c = (rawTxResult as { confirmations?: unknown }).confirmations;
  return typeof c === "number" && Number.isInteger(c) && c >= 0 ? c : null;
}

function rawTxBlockHash(rawTxResult: unknown): string | null {
  if (rawTxResult === null || typeof rawTxResult !== "object") return null;
  const h = (rawTxResult as { blockhash?: unknown }).blockhash;
  return typeof h === "string" && BLOCK_HASH_SHAPE.test(h) ? h.toLowerCase() : null;
}

function findSpendWitness(blockResult: unknown, txid: string, vout: number): readonly string[] | null {
  if (blockResult === null || typeof blockResult !== "object") return null;
  const txs = (blockResult as { tx?: unknown }).tx;
  if (!Array.isArray(txs)) return null;
  for (const tx of txs) {
    if (tx === null || typeof tx !== "object") continue;
    const vin = (tx as { vin?: unknown }).vin;
    if (!Array.isArray(vin)) continue;
    for (const input of vin) {
      if (input === null || typeof input !== "object") continue;
      const inTxid = (input as { txid?: unknown }).txid;
      const inVout = (input as { vout?: unknown }).vout;
      if (typeof inTxid === "string" && inTxid.toLowerCase() === txid.toLowerCase() && inVout === vout) {
        const witness = (input as { txinwitness?: unknown }).txinwitness;
        return Array.isArray(witness) ? witness.filter((w): w is string => typeof w === "string") : [];
      }
    }
  }
  return null;
}

/** Classify a spend's witness stack: the hash branch's witness carries the 32-byte preimage as
 *  one of its items (probe Q3: item 0); the timelock branch's does not (probe Q4: item 0 is a
 *  signature, never 32 bytes that opens `H`). Scans every item (never assumes a fixed position),
 *  the same defensive shape `BtcHtlcRail.findClaimPreimage` already uses on a live node. */
function classifySpend(witness: readonly string[], hashLockBytes: Uint8Array): { label: "claimed" | "refunded"; preimage?: string } {
  for (const item of witness) {
    if (!/^[0-9a-fA-F]{64}$/.test(item)) continue;
    const candidate = hexToBytes(item);
    if (bytesEqual(sha256(candidate), hashLockBytes)) {
      return { label: "claimed", preimage: `0x${bytesToHex(candidate)}` };
    }
  }
  return { label: "refunded" };
}

function finalizedRefFor(pinName: string, n: number, height: number, blockHash: string): string {
  return `${pinName}:confirmations-${n}:${height}:${blockHash}`;
}

// ── the pure decoder ──────────────────────────────────────────────────────────────────────────

/**
 * Turn one captured outpoint read into evidence for `terms`/`accounts`. Pure and synchronous:
 * every byte it looks at is already sitting in `capture.bytes`. Mirrors P4-BTC-SPEC.md §5's own
 * bullet list: chain/genesis pin check; the funding output decoded from `getrawtransaction`'s own
 * raw hex (exact sats, never Core's float BTC JSON); `gettxout` (confirmed-UTXO-set-only)
 * disambiguated against the funding tx's own confirmations to tell "unconfirmed" from "spent";
 * the bounded `getblock` scan and witness classification for a spend; the funding/spend output's
 * scriptPubKey and value checked against the script rebuilt from `terms.statement`,
 * `accounts.payeePubkey`/`payerPubkey` and `T`; a `RailObservation` only once the relevant tx has
 * reached the auditor's configured `N` confirmations (never a `final: false` case — see this
 * file's header).
 */
export function btcEvidence(input: BtcEvidenceInput): BtcEvidenceResult {
  const { terms, config, accounts, capture } = input;
  const checkedAtMs = capture.index.checkedAtMs;
  const raw = capture.index.exchanges.map((exchange) => exchange.responseSha256);
  const base = { rail: BTC_RAIL_ID, ref: capture.index.ref, terms, checkedAtMs, endpoint: config.endpoint, raw };

  // F1: this capture's own attempt did not run to completion.
  if (capture.index.error !== undefined) {
    return { lock: { ...base, railVerified: null, reason: `btc-htlc: chain read did not complete: ${capture.index.error}` } };
  }

  if (btcLockRefInvalid(terms, capture.index.ref)) {
    return {
      lock: {
        ...base,
        railVerified: false,
        reason: 'btc-htlc: ref/lock mismatch (ref must look like "<64-hex txid>:<vout>", lock must be "hash", and statement must be a sha256 hash lock)',
      },
    };
  }
  const parsedRef = parseRef(capture.index.ref);
  if (parsedRef === null) {
    // Unreachable given the guard above, kept for noUncheckedIndexedAccess/defense in depth.
    return { lock: { ...base, railVerified: null, reason: "btc-htlc: malformed ref" } };
  }
  const { txid, vout } = parsedRef;

  // A4/D3 (mirrors evm-evidence.ts verbatim): the capture must carry a valid config, and it must
  // agree with the auditor's own supplied config on chain and never claim a weaker finality.
  const capturedConfigCheck = checkBtcRailConfig(capture.index.config);
  if (!capturedConfigCheck.ok) {
    return { lock: { ...base, railVerified: null, reason: `btc-htlc: capture's own config is invalid (A4/D3): ${capturedConfigCheck.reason}` } };
  }
  const capturedConfig = capturedConfigCheck.config;
  if (
    capturedConfig.pin.network !== config.pin.network ||
    capturedConfig.pin.genesisHash.toLowerCase() !== config.pin.genesisHash.toLowerCase()
  ) {
    return { lock: { ...base, railVerified: null, reason: "btc-htlc: capture was taken under a different rail config" } };
  }
  if (capturedConfig.pin.finality.confirmations < config.pin.finality.confirmations) {
    return {
      lock: { ...base, railVerified: null, reason: "btc-htlc: capture's own finality is weaker than the auditor's configured finality (D3)" },
    };
  }
  const n = config.pin.finality.confirmations;
  const base2 = { ...base, endpoint: capturedConfig.endpoint };

  const exchanges = capture.index.exchanges;

  // Position 0: getblockchaininfo — chain name and tip height.
  const chainInfoBound = bindExchange(capture, exchangeAt(exchanges, 0, "getblockchaininfo"), "getblockchaininfo");
  if (chainInfoBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: chainInfoBound.reason } };
  if (chainInfoBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: "rpc rejected getblockchaininfo" } };
  const chainInfoValue = chainInfoBound.outcome.value;
  const chainName = chainInfoValue !== null && typeof chainInfoValue === "object" ? (chainInfoValue as { chain?: unknown }).chain : undefined;
  const tipHeight = chainInfoValue !== null && typeof chainInfoValue === "object" ? (chainInfoValue as { blocks?: unknown }).blocks : undefined;
  if (typeof chainName !== "string" || typeof tipHeight !== "number" || !Number.isInteger(tipHeight)) {
    return { lock: { ...base2, railVerified: null, reason: "btc-htlc: malformed getblockchaininfo result" } };
  }
  if (chainName !== config.pin.network) {
    return { lock: { ...base2, railVerified: null, reason: `captured chain "${chainName}" does not match pin "${config.pin.name}" (expected "${config.pin.network}")` } };
  }

  // Position 1: getblockhash(0) — genesis, pinned.
  const genesisBound = bindExchange(capture, exchangeAt(exchanges, 1, "getblockhash"), "getblockhash(0)");
  if (genesisBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: genesisBound.reason } };
  if (genesisBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: "rpc rejected getblockhash(0)" } };
  const genesisParams = requestParams(genesisBound.request);
  if (genesisParams === null || genesisParams.length !== 1 || genesisParams[0] !== 0) {
    return { lock: { ...base2, railVerified: null, reason: "btc-htlc: the genesis read does not request height 0 (tampered block selector)" } };
  }
  const genesisHash = genesisBound.outcome.value;
  if (typeof genesisHash !== "string" || genesisHash.toLowerCase() !== config.pin.genesisHash.toLowerCase()) {
    return { lock: { ...base2, railVerified: null, reason: `genesis hash does not match pin "${config.pin.name}" (expected ${config.pin.genesisHash})` } };
  }

  // Position 2: getrawtransaction(txid, true) — the funding tx itself.
  const rawTxBound = bindExchange(capture, exchangeAt(exchanges, 2, "getrawtransaction"), "getrawtransaction");
  if (rawTxBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: rawTxBound.reason } };
  const rawTxParams = requestParams(rawTxBound.request);
  if (rawTxParams === null || rawTxParams.length !== 2 || rawTxParams[0] !== txid || rawTxParams[1] !== true) {
    return { lock: { ...base2, railVerified: null, reason: "btc-htlc: the getrawtransaction read does not target this ref's txid (tampered)" } };
  }
  if (rawTxBound.outcome.kind === "error") {
    return { lock: { ...base2, railVerified: null, reason: "btc-htlc: no such funding transaction" } };
  }
  const rawTxResult = rawTxBound.outcome.value;
  const funding = decodeFundingOutput(rawTxResult, vout);
  if (funding === null) {
    return { lock: { ...base2, railVerified: null, reason: `btc-htlc: outpoint ${txid}:${vout} has no such funding output (malformed capture)` } };
  }
  const fundingConfirmations = rawTxConfirmations(rawTxResult);
  const fundingBlockHash = rawTxBlockHash(rawTxResult);
  if (fundingConfirmations === null || fundingConfirmations < 1 || fundingBlockHash === null) {
    return { lock: { ...base2, railVerified: null, reason: "btc-htlc: funding transaction is not yet confirmed" } };
  }
  const fundingHeight = tipHeight - fundingConfirmations + 1;
  if (!Number.isInteger(fundingHeight) || fundingHeight < 1 || fundingHeight > tipHeight) {
    return { lock: { ...base2, railVerified: null, reason: "btc-htlc: malformed confirmations/height accounting (tampered capture)" } };
  }

  // Position 3: gettxout(txid, vout, false) — confirmed-UTXO-set-only read.
  const txoutBound = bindExchange(capture, exchangeAt(exchanges, 3, "gettxout"), "gettxout");
  if (txoutBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: txoutBound.reason } };
  const txoutParams = requestParams(txoutBound.request);
  if (txoutParams === null || txoutParams.length !== 3 || txoutParams[0] !== txid || txoutParams[1] !== vout || txoutParams[2] !== false) {
    return { lock: { ...base2, railVerified: null, reason: "btc-htlc: the gettxout read does not target this ref (tampered)" } };
  }
  if (txoutBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: "rpc rejected gettxout" } };

  let rail: RailObservation;
  if (txoutBound.outcome.value !== null) {
    // Unspent (and, since the third argument excludes the mempool, therefore confirmed).
    if (fundingConfirmations < n) {
      return {
        lock: { ...base2, railVerified: null, reason: `btc-htlc: funding has ${fundingConfirmations} confirmation(s), need ${n}` },
      };
    }
    rail = { status: "locked", final: true, checkedAtMs, finalizedRef: finalizedRefFor(capturedConfig.pin.name, n, fundingHeight, fundingBlockHash) };
  } else {
    // Confirmed but no longer unspent — spent. Find it with the bounded getblock(hash, 2) scan
    // starting at the funding height, in strict (height, hash) pairs from position 4 on.
    let found: { height: number; blockHash: string; witness: readonly string[] } | null = null;
    for (let i = 4, height = fundingHeight; height <= tipHeight; i += 2, height += 1) {
      const hashBound = bindExchange(capture, exchangeAt(exchanges, i, "getblockhash"), `getblockhash(${height})`);
      if (hashBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: hashBound.reason } };
      if (hashBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: `rpc rejected getblockhash(${height})` } };
      const hashParams = requestParams(hashBound.request);
      if (hashParams === null || hashParams.length !== 1 || hashParams[0] !== height) {
        return { lock: { ...base2, railVerified: null, reason: "btc-htlc: the scan's getblockhash read is out of sequence (tampered)" } };
      }
      const blockHash = hashBound.outcome.value;
      if (typeof blockHash !== "string" || !BLOCK_HASH_SHAPE.test(blockHash)) {
        return { lock: { ...base2, railVerified: null, reason: `btc-htlc: malformed getblockhash(${height}) result` } };
      }

      const blockBound = bindExchange(capture, exchangeAt(exchanges, i + 1, "getblock"), `getblock(${height})`);
      if (blockBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: blockBound.reason } };
      if (blockBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: `rpc rejected getblock(${height})` } };
      const blockParams = requestParams(blockBound.request);
      if (blockParams === null || blockParams.length !== 2 || blockParams[0] !== blockHash || blockParams[1] !== 2) {
        return { lock: { ...base2, railVerified: null, reason: "btc-htlc: the scan's getblock read is not pinned to its own getblockhash (tampered)" } };
      }

      const witness = findSpendWitness(blockBound.outcome.value, txid, vout);
      if (witness !== null) {
        found = { height, blockHash: blockHash.toLowerCase(), witness };
        break;
      }
    }
    if (found === null) {
      return {
        lock: { ...base2, railVerified: null, reason: "btc-htlc: gettxout reports the output spent but the bounded scan did not find the spending transaction" },
      };
    }
    const spendConfirmations = tipHeight - found.height + 1;
    if (spendConfirmations < n) {
      return { lock: { ...base2, railVerified: null, reason: `btc-htlc: spend has ${spendConfirmations} confirmation(s), need ${n}` } };
    }
    const hashLockBytes = hexToBytes(terms.statement.slice(2));
    const classified = classifySpend(found.witness, hashLockBytes);
    rail = {
      status: classified.label,
      final: true,
      checkedAtMs,
      finalizedRef: finalizedRefFor(capturedConfig.pin.name, n, found.height, found.blockHash),
    };
  }

  const baseAtFinalizedView = { ...base2, finalizedRef: rail.finalizedRef as string };

  // Field checks — always against the FUNDING output (the funding scriptPubKey/value never
  // change once mined, whether the outpoint is still locked or has since been spent).
  if (accounts.payeePubkey === undefined || accounts.payerPubkey === undefined) {
    return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "btc-htlc: payee and/or payer has no pubkey line (P4-BTC-SPEC.md §6)" }, rail };
  }
  if (!PUBKEY_SHAPE.test(accounts.payeePubkey) || !PUBKEY_SHAPE.test(accounts.payerPubkey)) {
    return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "btc-htlc: a resolved pubkey line is not a 33-byte compressed pubkey" }, rail };
  }
  let expected: { scriptPubKey: Uint8Array };
  let expectedAmount: bigint;
  try {
    const locktime = locktimeFromRefundAfterMs(terms.refundAfterMs);
    expected = buildHtlcScript(
      {
        hashLock: hexToBytes(terms.statement.slice(2)),
        payeePubkey: hexToBytes(accounts.payeePubkey),
        payerPubkey: hexToBytes(accounts.payerPubkey),
        locktime,
      },
      networkParamsFor(capturedConfig.pin.network),
    );
    expectedAmount = BigInt(terms.amount);
  } catch (error) {
    return {
      lock: { ...baseAtFinalizedView, railVerified: null, reason: `btc-htlc: could not rebuild the expected HTLC script/amount from terms: ${error instanceof Error ? error.message : String(error)}` },
      rail,
    };
  }

  const scriptMatches = bytesEqual(funding.scriptPubKey, expected.scriptPubKey);
  const amountMatches = funding.amountSats === expectedAmount;

  if (rail.status === "locked") {
    if (!scriptMatches) {
      return { lock: { ...baseAtFinalizedView, railVerified: false, reason: "btc-htlc: on-chain funding scriptPubKey does not match the expected HTLC script for these terms" }, rail };
    }
    if (!amountMatches) {
      return { lock: { ...baseAtFinalizedView, railVerified: false, reason: `btc-htlc: on-chain funding value ${funding.amountSats} does not match terms.amount ${terms.amount}` }, rail };
    }
    return { lock: { ...baseAtFinalizedView, railVerified: true, reason: "btc-htlc: locked and on-chain state matches terms" }, rail };
  }

  // claimed/refunded: D1-style defense in depth (mirrors evm-evidence.ts's own Claimed/Refunded
  // branch) — a genuine claimed/refunded read for THIS outpoint must still show the funding
  // output's own fields matching terms/accounts before it is trusted as evidence about *this*
  // swap's own lock; a mismatch fails closed (null), never asserts the claimed/refunded status
  // for a lock it does not actually describe.
  const label = rail.status;
  if (!scriptMatches || !amountMatches) {
    return {
      lock: {
        ...baseAtFinalizedView,
        railVerified: null,
        reason: `btc-htlc: ${label} on-chain, but the funding output does not match this swap's terms/accounts — refusing to trust it as this swap's own lock`,
      },
      rail,
    };
  }
  return { lock: { ...baseAtFinalizedView, railVerified: false, reason: `btc-htlc: ${capture.index.ref} is ${label} on-chain, not locked` }, rail };
}

// ── the live capture ──────────────────────────────────────────────────────────────────────────

function randomNonce(): string {
  return randomBytes(8).toString("hex");
}

function buildIndex(config: BtcRailConfig, ref: string, checkedAtMs: number, nonce: string, exchanges: readonly Exchange[], error?: string): BtcCaptureIndex {
  return {
    v: 1,
    rail: "btc-htlc",
    ref,
    pin: config.pin.name,
    caip2: config.pin.caip2,
    endpoint: config.endpoint,
    checkedAtMs,
    config,
    nonce,
    ...(error === undefined ? {} : { error }),
    exchanges: exchanges.map(({ method, params, requestBody, responseSha256, atMs }) => ({ method, params, requestBody, responseSha256, atMs })),
  };
}

/**
 * The live half of "capture live, then decode" (mirrors `captureEvmLeg` exactly): reads
 * `getblockchaininfo`, `getblockhash(0)`, `getrawtransaction(txid, true)`, `gettxout(txid, vout,
 * false)` and, only if the output turns out to be spent, the bounded `getblock(hash, 2)` scan —
 * every call through `rpc`, so every byte is captured, and every id namespaced
 * `"<ref>:<nowMs>:<nonce>:<n>"`. Never throws for a chain-state reason (a missing tx, an
 * unconfirmed one, a spend the scan could not find within its own window) — those are recorded
 * as whatever was captured, with no `error` set, and `btcEvidence` reports the specific reason on
 * replay; only a genuine transport-level failure (the node unreachable, a rejected fetch) sets
 * `index.error` (F1's rule) so a later replay's "newest capture" is this sweep's own (failed)
 * attempt, never a stale earlier one's success.
 */
export async function captureBtcLeg(
  rpc: CapturingRpc,
  config: BtcRailConfig,
  ref: string,
  nowMs: number,
): Promise<{ index: BtcCaptureIndex; exchanges: Exchange[] }> {
  const nonce = randomNonce();
  const parsed = parseRef(ref);
  if (parsed === null) {
    return { index: buildIndex(config, ref, nowMs, nonce, []), exchanges: [] };
  }
  const { txid, vout } = parsed;

  const before = rpc.exchanges().length;
  const finish = (error?: string) => {
    const exchanges = rpc.exchanges().slice(before);
    return { index: buildIndex(config, ref, nowMs, nonce, exchanges, error), exchanges };
  };

  rpc.setIdNamespace(`${ref}:${nowMs}:${nonce}`);
  try {
    let chainInfo: { chain?: unknown; blocks?: unknown };
    try {
      chainInfo = (await rpc.request({ method: "getblockchaininfo", params: [] })) as { chain?: unknown; blocks?: unknown };
    } catch (error) {
      return finish(error instanceof Error ? error.message : String(error));
    }
    if (typeof chainInfo.blocks !== "number" || !Number.isInteger(chainInfo.blocks)) return finish();
    const tipHeight = chainInfo.blocks;

    try {
      await rpc.request({ method: "getblockhash", params: [0] });
    } catch (error) {
      return finish(error instanceof Error ? error.message : String(error));
    }

    let rawTxResult: unknown = null;
    try {
      rawTxResult = await rpc.request({ method: "getrawtransaction", params: [txid, true] });
    } catch {
      // A legitimate negative answer ("no such funding transaction") — recorded as a JSON-RPC
      // error envelope; btcEvidence reads that outcome directly. Nothing else to usefully read.
      return finish();
    }

    let txoutResult: unknown;
    try {
      txoutResult = await rpc.request({ method: "gettxout", params: [txid, vout, false] });
    } catch (error) {
      return finish(error instanceof Error ? error.message : String(error));
    }

    if (txoutResult !== null) {
      // Unspent (and therefore confirmed, since gettxout's third argument excludes the mempool).
      return finish();
    }

    const confirmations = rawTxConfirmations(rawTxResult);
    if (confirmations === null || confirmations < 1) {
      // Still unconfirmed (mempool-only): gettxout's null result reflects that, not a spend.
      return finish();
    }

    const fundingHeight = tipHeight - confirmations + 1;
    if (!Number.isInteger(fundingHeight) || fundingHeight < 1 || fundingHeight > tipHeight) {
      return finish();
    }

    for (let height = fundingHeight; height <= tipHeight; height += 1) {
      let hash: unknown;
      try {
        hash = await rpc.request({ method: "getblockhash", params: [height] });
      } catch (error) {
        return finish(error instanceof Error ? error.message : String(error));
      }
      if (typeof hash !== "string") return finish();

      let block: unknown;
      try {
        block = await rpc.request({ method: "getblock", params: [hash, 2] });
      } catch (error) {
        return finish(error instanceof Error ? error.message : String(error));
      }
      const witness = findSpendWitness(block, txid, vout);
      if (witness !== null) break; // found — the bounded scan stops here (spec §5).
    }
    return finish();
  } finally {
    rpc.setIdNamespace(undefined);
  }
}

// ── replay-side loading ──────────────────────────────────────────────────────────────────────

function isCaptureIndexCandidate(name: string): boolean {
  return name.endsWith(".json") && !name.includes(".tmp-");
}

function looksLikeCaptureIndexFile(value: unknown, ref: string): value is BtcCaptureIndex {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || v.rail !== "btc-htlc") return false;
  if (typeof v.ref !== "string" || v.ref !== ref || !REF_SHAPE.test(v.ref)) return false;
  if (typeof v.nonce !== "string" || v.nonce.length === 0) return false;
  if (!Array.isArray(v.exchanges)) return false;
  for (const exchange of v.exchanges) {
    if (exchange === null || typeof exchange !== "object") return false;
    const e = exchange as Record<string, unknown>;
    if (typeof e.method !== "string") return false;
    if (typeof e.requestBody !== "string") return false;
    if (typeof e.responseSha256 !== "string" || !SHA256_HEX_LOWER.test(e.responseSha256)) return false;
    if (typeof e.atMs !== "number") return false;
  }
  return true;
}

export interface LoadBtcCaptureResult {
  capture: BtcCapture | null;
  /** The newest index filename when it failed to read, parse, or validate as a capture index for
   *  this ref (and so failed the leg closed) — empty when it was fine. */
  skipped: string[];
}

/**
 * The one place a replay does file I/O for a `btc-htlc` capture — everything downstream
 * (`btcEvidence`) is pure and synchronous over the result. Reads only the newest
 * `raw/btc/<txid>-<vout>/*.json` under `root` (ISO-stamped names sort chronologically; `.tmp-*`
 * leftovers are never candidates). If that newest file does not read, parse and validate as this
 * ref's capture index, the leg fails closed (`capture: null`) — it never falls back to an older
 * capture, which would replay a previous sweep's verdict as current.
 */
export async function loadBtcCapture(root: string, ref: string): Promise<LoadBtcCaptureResult> {
  const parsed = parseRef(ref);
  if (parsed === null) return { capture: null, skipped: [] };
  const dir = join(root, "raw", "btc", `${parsed.txid}-${parsed.vout}`);
  let allEntries: string[];
  try {
    allEntries = await readdir(dir);
  } catch {
    return { capture: null, skipped: [] };
  }
  const newest = allEntries.filter(isCaptureIndexCandidate).sort().at(-1);
  if (newest === undefined) return { capture: null, skipped: [] };

  let rawFile: string;
  try {
    rawFile = await readFile(join(dir, newest), "utf8");
  } catch {
    return { capture: null, skipped: [newest] };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawFile);
  } catch {
    return { capture: null, skipped: [newest] };
  }
  if (!looksLikeCaptureIndexFile(parsedJson, ref)) {
    return { capture: null, skipped: [newest] };
  }

  const index = parsedJson;
  const bytes = new Map<string, Uint8Array | null>();
  for (const exchange of index.exchanges) {
    if (bytes.has(exchange.responseSha256)) continue;
    bytes.set(exchange.responseSha256, await readCapture(root, exchange.responseSha256));
  }
  return { capture: { index, bytes }, skipped: [] };
}
