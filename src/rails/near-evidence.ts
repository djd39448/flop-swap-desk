// SPDX-License-Identifier: MIT
//
// Pure evidence adapter for the `near-htlc` rail (P5-NEAR-SPEC.md §4, D-N10): the NEAR twin of
// `src/rails/evm-evidence.ts`. near-htlc's own `get_lock(hash_lock)` view is a single-struct/
// status read exactly like EVM's `locks(hashLock)` (one contract, one status enum) rather than
// Bitcoin's UTXO-derived state, so this file mirrors evm-evidence.ts's own shape — bind every
// exchange to its own request, validate every value, fail closed (`railVerified: null` with a
// reason, never a thrown exception), take `checkedAtMs` from the capture's own index, and let a
// capture's own frozen `config` gate what it can be trusted to say. `nearEvidence` is pure and
// synchronous over an already-captured `NearCapture`; `captureNearLeg` is the one function here
// that touches the network (through the caller's own `rpc-capture.ts` `CapturingRpc`), and only
// ever appends to the log, never throwing for a chain-state reason — only a genuine transport
// failure sets the capture's own `error` field (mirrors EVM/Bitcoin's F1 rule).
//
// Unlike EVM's single `eth_call`, NEAR's own evidence read is D-N10's fixed sequence, always in
// this order: `status` (the pin's own chain id + protocol version), `block` at
// `finality: "final"` (height + hash + timestamp), `query call_function get_lock` **pinned to
// that exact block hash**, and — only once the leg's own resolved payee account is known and the
// lock is genuinely `Locked` with every other field matching — `query call_function
// storage_balance_of` for that payee on the configured USDC token, pinned to the same block hash.
// That last read is D-N10's own reason for existing: near-htlc's payout is a token transfer, and
// a payee who was never storage-registered on the token would make even a perfectly matching
// `Locked` on-chain state worthless (the payout could never land) — so this reader never reports
// a `locked` verdict without also confirming the payout can land.
//
// H1 (name reused from btc-evidence.ts, whose stricter rule this file follows rather than
// evm-evidence.ts's looser one): `rail` is attached to the result ONLY once every field this
// capture can check — payee, payer (when known), token, amount, both times — is confirmed to
// equal what `terms`/`accounts` themselves say. A mismatch on any checked field means
// `railVerified: false` and `rail` is OMITTED entirely, never attached "matching except for one
// field". `Claiming`/`Refunding` are transitional contract states the contract's own callback
// will move out of on its own (D-N10 is explicit neither is a final outcome) — this reader never
// returns a `RailObservation` for either, only `railVerified: null` naming the transitional
// state.
//
// Honesty limit (carried over verbatim from evm-evidence.ts/btc-evidence.ts): a capture is the
// capturing process's own bytes. Replaying it detects corruption, splicing, mismatched requests
// and config drift — never forgery. A fabricated response named by its own (correct) hash still
// replays as genuine; the independent check is that every `finalizedRef` names a real block hash
// and height, so anyone with their own RPC access to the same near-sandbox/testnet chain can
// re-query the same lock at that exact block hash.
//
// Design source: flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md D-N1..D-N10;
// flop-contrib/handoff/P5-NEAR-SPEC.md §4;
// flop-contrib/handoff/research/near-mirror-map-2026-09-29.md §4.

import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LockTerms } from "@flop-labs/tclk";

import { checkNearRailConfig, NEAR_ASSET_ID, type NearRailConfig } from "./near-htlc.js";
import { readCapture, type CapturingRpc, type Exchange } from "./rpc-capture.js";
import type { LockEvidence, RailObservation } from "../types.js";

export const NEAR_RAIL_ID = "near-htlc";

const HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/;
/** NEAR's own base58 block-hash charset (Bitcoin/IPFS-style base58: no `0`, `O`, `I`, `l`) — a
 *  32-byte hash encodes to something in this length range depending on leading zero bytes;
 *  bounded loosely rather than to one exact length. */
const BLOCK_HASH_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{20,44}$/;
const SHA256_HEX_LOWER = /^[0-9a-f]{64}$/;

/** Hoisted so it can run before any network call — mirrors `hashLockRefMismatch`
 *  (evm-evidence.ts) / `btcLockRefInvalid` (btc-evidence.ts): `terms.lock` must be `"hash"`,
 *  `ref` must equal `terms.statement` (D-N4: the ref IS the hash lock, exactly like EVM), and
 *  both must be a well-formed sha256 hash-lock shape. */
export function nearLockRefInvalid(terms: LockTerms, ref: string): boolean {
  return terms.lock !== "hash" || !HASH_LOCK_SHAPE.test(ref) || ref !== terms.statement;
}

/** One captured exchange as it sits in the index file — mirrors `EvmCaptureIndexExchange`/
 *  `BtcCaptureIndexExchange` exactly (see rpc-capture.ts for where the response bytes live). */
export interface NearCaptureIndexExchange {
  method: string;
  params: unknown;
  requestBody: string;
  responseSha256: string;
  atMs: number;
}

/** `raw/near/<hashLock>/<iso-stamp>.json` (D-N10) — `hashLock` is already filename-safe (`0x` +
 *  hex, no `:`), so unlike Bitcoin's `<txid>-<vout>` rewrite this uses the ref as-is, exactly
 *  like EVM's `raw/evm/<hashLock>/`. */
export interface NearCaptureIndex {
  v: 1;
  rail: "near-htlc";
  ref: string;
  pin: string;
  caip2: string;
  endpoint: string;
  checkedAtMs: number;
  /** The full `NearRailConfig` this capture was taken under (A4: frozen at capture time, so a
   *  later `rails.json` edit can never silently change how an old capture replays). */
  config: NearRailConfig;
  /** A random value minted once per `captureNearLeg` call — every id this capture's own
   *  exchanges carry is namespaced `"<ref>:<checkedAtMs>:<nonce>:<n>"` (mirrors EVM's F2
   *  same-timestamp splice fix). */
  nonce: string;
  /** Set when this capture attempt did not run to completion (mirrors EVM/BTC's F1). Absent for
   *  a capture that ran to completion, whether or not it found anything verifiable. */
  error?: string;
  exchanges: NearCaptureIndexExchange[];
}

/** The index plus every exchange's already-loaded, already-re-hashed response bytes — identical
 *  shape and purpose to `EvmCapture`/`BtcCapture`. */
export interface NearCapture {
  index: NearCaptureIndex;
  bytes: ReadonlyMap<string, Uint8Array | null>;
}

/** The leg's resolved NEAR account ids (`src/rails/account-line.ts`'s `resolveAccounts`, D-N5's
 *  account line) — `terms` itself (tclk's `LockTerms`) carries only DIDs, never chain accounts.
 *  `payee` also decides whether/whom `captureNearLeg` reads `storage_balance_of` for. */
export interface NearAccounts {
  payee?: string;
  payer?: string;
}

export interface NearEvidenceInput {
  terms: LockTerms;
  config: NearRailConfig;
  accounts: NearAccounts;
  capture: NearCapture;
}

export interface NearEvidenceResult {
  lock: LockEvidence;
  rail?: RailObservation;
}

// ── binding (mirrors evm-evidence.ts's bindExchange/idBoundToCapture verbatim, adapted) ───────

interface ParsedRequest {
  id: number | string;
  method: string;
  params: unknown;
}

function parseRequestBody(exchange: NearCaptureIndexExchange): ParsedRequest | null {
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

function idBoundToCapture(capture: NearCapture, id: number | string): boolean {
  return typeof id === "string" && id.startsWith(`${capture.index.ref}:${capture.index.checkedAtMs}:${capture.index.nonce}:`);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type EnvelopeOutcome = { kind: "result"; value: unknown } | { kind: "error" };

type BoundExchange =
  | { kind: "missing"; reason: string }
  | { kind: "bound"; request: ParsedRequest; outcome: EnvelopeOutcome };

/** The NEAR twin of `evm-evidence.ts`'s `bindExchange`: authenticates that a candidate exchange's
 *  own `requestBody` really does ask for what the index's (editable) `.method`/`.params` metadata
 *  claims, and that the response's own JSON-RPC `id` really does answer that exact request AND is
 *  bound to this exact capture (`idBoundToCapture`) — never merely trusted because a same-shaped
 *  response happened to be captured somewhere. */
function bindExchange(capture: NearCapture, exchange: NearCaptureIndexExchange | null, label: string): BoundExchange {
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
    return { kind: "missing", reason: `missing/tampered capture: ${label} (id is not bound to this capture's ref/checkedAtMs/nonce)` };
  }
  if (envelope.error !== undefined && envelope.error !== null) return { kind: "bound", request, outcome: { kind: "error" } };
  return { kind: "bound", request, outcome: { kind: "result", value: envelope.result } };
}

/** Position-authenticated lookup: `captureNearLeg` always appends this leg's own reads in a
 *  fixed order (0: status, 1: block, 2: query/get_lock, 3: query/storage_balance_of — the last
 *  only when a payee account is known) — a convenience for a known layout, never a substitute
 *  for `bindExchange`'s own content binding (a candidate at the wrong position is refused because
 *  its own `.method` there would simply not equal what the caller asks for). */
function exchangeAt(exchanges: readonly NearCaptureIndexExchange[], i: number, expectedMethod: string): NearCaptureIndexExchange | null {
  const e = exchanges[i];
  return e !== undefined && e.method === expectedMethod ? e : null;
}

function requestParamsObject(request: ParsedRequest): Record<string, unknown> | null {
  return request.params !== null && typeof request.params === "object" && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : null;
}

/** `query call_function`'s own `args_base64` is JSON-serialised bytes — decode it back to the
 *  plain object the request claims to be calling with, so the request can be checked against
 *  what this leg's own `hash_lock`/`account_id` argument must actually be (never merely trusted
 *  from the index's own `.params`, same A1 discipline `bindExchange` already applies to
 *  method/params themselves). */
function decodeCallArgs(params: Record<string, unknown>): Record<string, unknown> | null {
  const argsBase64 = params.args_base64;
  if (typeof argsBase64 !== "string") return null;
  try {
    const text = Buffer.from(argsBase64, "base64").toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── wire decoding ────────────────────────────────────────────────────────────────────────────

function decodeStatusResult(value: unknown): { chainId: string; protocolVersion: number } | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { chain_id?: unknown; protocol_version?: unknown };
  if (typeof v.chain_id !== "string" || v.chain_id === "") return null;
  if (typeof v.protocol_version !== "number" || !Number.isInteger(v.protocol_version) || v.protocol_version <= 0) return null;
  return { chainId: v.chain_id, protocolVersion: v.protocol_version };
}

function decodeBlockResult(value: unknown): { height: number; hash: string; timestampNs: string } | null {
  if (value === null || typeof value !== "object") return null;
  const header = (value as { header?: unknown }).header;
  if (header === null || typeof header !== "object") return null;
  const h = header as { height?: unknown; hash?: unknown; timestamp_nanosec?: unknown };
  if (typeof h.height !== "number" || !Number.isInteger(h.height) || h.height < 0) return null;
  if (typeof h.hash !== "string" || !BLOCK_HASH_SHAPE.test(h.hash)) return null;
  if (typeof h.timestamp_nanosec !== "string" || !/^[0-9]+$/.test(h.timestamp_nanosec)) return null;
  return { height: h.height, hash: h.hash, timestampNs: h.timestamp_nanosec };
}

/** A `query call_function`'s own successful-envelope result: `{ result: number[], ... }`
 *  (decoded to UTF-8 text) or a contract-side panic reported INSIDE the (HTTP-200, no
 *  JSON-RPC-level error) response as `{ error: string, ... }` (mirrors `near-rpc.ts`'s own
 *  `callFunction`). Distinct from a genuine JSON-RPC-level error envelope, which `bindExchange`
 *  already reports as `outcome.kind === "error"` before this is ever called. */
function decodeCallFunctionResult(value: unknown): { resultText: string } | { error: string } | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { error?: unknown; result?: unknown };
  if (typeof v.error === "string") return { error: v.error };
  if (!Array.isArray(v.result)) return null;
  try {
    const bytes = Uint8Array.from(v.result as number[]);
    return { resultText: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return null;
  }
}

interface NearLockView {
  status: "Locked" | "Claiming" | "Claimed" | "Refunding" | "Refunded";
  payer: string;
  payee: string;
  token: string;
  amount: string;
  claimByMs: number;
  refundAfterMs: number;
  preimage: string | null;
}

type ParsedLockView = { kind: "none" } | { kind: "malformed" } | { kind: "ok"; view: NearLockView };

/** `get_lock(hash_lock) -> Option<LockView>` — a genuine "no such lock" is the JSON literal
 *  `null` (`kind: "none"`), distinct from an unparseable/wrongly-shaped body (`kind: "malformed"`,
 *  which fails closed the same way a BTC/EVM decode failure does). */
function parseLockView(text: string): ParsedLockView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (parsed === null) return { kind: "none" };
  if (typeof parsed !== "object") return { kind: "malformed" };
  const v = parsed as Record<string, unknown>;
  const validStatus =
    v.status === "Locked" || v.status === "Claiming" || v.status === "Claimed" || v.status === "Refunding" || v.status === "Refunded";
  if (
    !validStatus ||
    typeof v.payer !== "string" ||
    typeof v.payee !== "string" ||
    typeof v.token !== "string" ||
    typeof v.amount !== "string" ||
    typeof v.claim_by_ms !== "string" ||
    typeof v.refund_after_ms !== "string"
  ) {
    return { kind: "malformed" };
  }
  const claimByMs = Number(v.claim_by_ms);
  const refundAfterMs = Number(v.refund_after_ms);
  if (!Number.isFinite(claimByMs) || !Number.isFinite(refundAfterMs)) return { kind: "malformed" };
  const preimage = typeof v.preimage === "string" ? `0x${v.preimage}` : null;
  return {
    kind: "ok",
    view: { status: v.status as NearLockView["status"], payer: v.payer, payee: v.payee, token: v.token, amount: v.amount, claimByMs, refundAfterMs, preimage },
  };
}

type ParsedStorageBalance = { kind: "none" } | { kind: "malformed" } | { kind: "ok"; balance: { total: string; available: string } };

/** `storage_balance_of(account_id) -> Option<StorageBalance>` — a genuine "not registered" is
 *  the JSON literal `null` (`kind: "none"`), distinct from an unparseable/wrongly-shaped body
 *  (`kind: "malformed"`), exactly like `parseLockView`'s own `Option` distinction above. */
function parseStorageBalance(text: string): ParsedStorageBalance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (parsed === null) return { kind: "none" };
  if (typeof parsed !== "object") return { kind: "malformed" };
  const v = parsed as Record<string, unknown>;
  if (typeof v.total !== "string" || typeof v.available !== "string") return { kind: "malformed" };
  return { kind: "ok", balance: { total: v.total, available: v.available } };
}

function amountsEqual(onChain: string, expected: string): boolean {
  try {
    return BigInt(onChain) === BigInt(expected);
  } catch {
    return false;
  }
}

function finalizedRefFor(pinName: string, height: number, blockHash: string): string {
  return `${pinName}:final:${height}:${blockHash}`;
}

function firstFieldMismatch(args: {
  onChainPayee: string;
  onChainPayer: string;
  onChainToken: string;
  onChainAmount: string;
  onChainClaimByMs: number;
  onChainRefundAfterMs: number;
  payee: string;
  payer?: string;
  token: string;
  terms: LockTerms;
}): string | null {
  const { onChainPayee, onChainPayer, onChainToken, onChainAmount, onChainClaimByMs, onChainRefundAfterMs, payee, payer, token, terms } = args;
  if (onChainPayee !== payee) return "near-htlc: on-chain payee differs from the payee account line";
  if (onChainToken !== token) return "near-htlc: on-chain token differs from the configured USDC asset";
  if (!amountsEqual(onChainAmount, terms.amount)) return "near-htlc: on-chain amount differs from terms";
  if (onChainClaimByMs !== terms.claimByMs) return "near-htlc: on-chain claimByMs differs from terms";
  if (onChainRefundAfterMs !== terms.refundAfterMs) return "near-htlc: on-chain refundAfterMs differs from terms";
  if (payer !== undefined && onChainPayer !== payer) return "near-htlc: on-chain payer differs from the payer account line";
  return null;
}

// ── the pure decoder ─────────────────────────────────────────────────────────────────────────

/**
 * Turn one captured `get_lock`/`storage_balance_of` read into evidence for `terms`/`accounts`.
 * Pure and synchronous — every byte it looks at is already sitting in `capture.bytes`. See
 * P5-NEAR-SPEC.md §4/D-N10 for the branch table this implements.
 */
export function nearEvidence(input: NearEvidenceInput): NearEvidenceResult {
  const { terms, config, accounts, capture } = input;
  const checkedAtMs = capture.index.checkedAtMs;
  const raw = capture.index.exchanges.map((exchange) => exchange.responseSha256);
  const base = { rail: NEAR_RAIL_ID, ref: capture.index.ref, terms, checkedAtMs, endpoint: config.endpoint, raw };

  // F1: this capture's own attempt did not run to completion.
  if (capture.index.error !== undefined) {
    return { lock: { ...base, railVerified: null, reason: `near-htlc: chain read did not complete: ${capture.index.error}` } };
  }

  if (nearLockRefInvalid(terms, capture.index.ref)) {
    return {
      lock: { ...base, railVerified: false, reason: 'near-htlc: ref/lock mismatch (ref must equal terms.statement and lock must be "hash")' },
    };
  }

  // K3: this rail only ever settles USDC — a leg whose declared terms.asset names anything else
  // must never verify, no matter how genuine the underlying chain state is (mirrors btc-evidence
  // .ts's identical asset check).
  if (terms.asset !== NEAR_ASSET_ID) {
    return {
      lock: { ...base, railVerified: false, reason: `near-htlc: leg asset "${terms.asset}" does not match this rail's own asset "${NEAR_ASSET_ID}" (K3)` },
    };
  }

  // A4/D3 (mirrors evm-evidence.ts verbatim): the capture must carry a valid config, and it must
  // agree with the auditor's own supplied config on chain, contract and the configured USDC
  // token — a later edit to rails.json must never silently change how an old capture replays,
  // and an edited capture must never be able to claim a different (weaker) trust anchor than the
  // auditor's own.
  const capturedConfigCheck = checkNearRailConfig(capture.index.config);
  if (!capturedConfigCheck.ok) {
    return { lock: { ...base, railVerified: null, reason: `near-htlc: capture's own config is invalid (A4/D3): ${capturedConfigCheck.reason}` } };
  }
  const capturedConfig = capturedConfigCheck.config;
  if (
    capturedConfig.pin.chainId !== config.pin.chainId ||
    capturedConfig.pin.name !== config.pin.name ||
    capturedConfig.contract !== config.contract ||
    capturedConfig.assets.USDC !== config.assets.USDC
  ) {
    return { lock: { ...base, railVerified: null, reason: "near-htlc: capture was taken under a different rail config (D3)" } };
  }

  const base2 = { ...base, endpoint: capturedConfig.endpoint };
  const exchanges = capture.index.exchanges;

  // Position 0: status — the pin's own chain id and protocol version.
  const statusBound = bindExchange(capture, exchangeAt(exchanges, 0, "status"), "status");
  if (statusBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: statusBound.reason } };
  if (statusBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: "rpc rejected status" } };
  const statusDecoded = decodeStatusResult(statusBound.outcome.value);
  if (statusDecoded === null) return { lock: { ...base2, railVerified: null, reason: "near-htlc: malformed status result" } };
  if (statusDecoded.chainId !== capturedConfig.pin.chainId) {
    return {
      lock: {
        ...base2,
        railVerified: null,
        reason: `captured chain "${statusDecoded.chainId}" does not match pin "${capturedConfig.pin.name}" (expected "${capturedConfig.pin.chainId}")`,
      },
    };
  }

  // Position 1: block(finality: "final").
  const blockBound = bindExchange(capture, exchangeAt(exchanges, 1, "block"), "block");
  if (blockBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: blockBound.reason } };
  const blockParams = requestParamsObject(blockBound.request);
  if (blockParams === null || blockParams.finality !== "final") {
    return { lock: { ...base2, railVerified: null, reason: 'near-htlc: the block read does not request finality "final" (tampered block selector)' } };
  }
  if (blockBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: "rpc rejected block(final)" } };
  const block = decodeBlockResult(blockBound.outcome.value);
  if (block === null) return { lock: { ...base2, railVerified: null, reason: "near-htlc: malformed block result" } };

  // Position 2: query call_function get_lock, pinned to the final block's own hash.
  const lockBound = bindExchange(capture, exchangeAt(exchanges, 2, "query"), "get_lock");
  if (lockBound.kind === "missing") return { lock: { ...base2, railVerified: null, reason: lockBound.reason } };
  const lockParams = requestParamsObject(lockBound.request);
  const lockArgs = lockParams === null ? null : decodeCallArgs(lockParams);
  if (
    lockParams === null ||
    lockParams.request_type !== "call_function" ||
    lockParams.account_id !== capturedConfig.contract ||
    lockParams.method_name !== "get_lock" ||
    lockParams.block_id !== block.hash ||
    lockArgs === null ||
    lockArgs.hash_lock !== capture.index.ref.slice(2)
  ) {
    return { lock: { ...base2, railVerified: null, reason: "near-htlc: the get_lock read does not target this lock at the finalized block (tampered)" } };
  }
  if (lockBound.outcome.kind === "error") return { lock: { ...base2, railVerified: null, reason: "rpc rejected get_lock" } };
  const lockCallResult = decodeCallFunctionResult(lockBound.outcome.value);
  if (lockCallResult === null) return { lock: { ...base2, railVerified: null, reason: "near-htlc: malformed get_lock result" } };
  if ("error" in lockCallResult) return { lock: { ...base2, railVerified: null, reason: `near-htlc: get_lock panicked: ${lockCallResult.error}` } };

  const parsedLock = parseLockView(lockCallResult.resultText);
  if (parsedLock.kind === "malformed") {
    return { lock: { ...base2, railVerified: null, reason: "near-htlc: malformed get_lock result (unrecognised LockView shape)" } };
  }
  const finalizedRef = finalizedRefFor(capturedConfig.pin.name, block.height, block.hash);
  const baseAtFinalizedView = { ...base2, finalizedRef };

  if (parsedLock.kind === "none") {
    return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "near-htlc: no lock at the finalized view" } };
  }
  const lockView = parsedLock.view;

  // D-N10: Claiming/Refunding are transitional contract states — never a final RailObservation.
  if (lockView.status === "Claiming" || lockView.status === "Refunding") {
    return {
      lock: {
        ...baseAtFinalizedView,
        railVerified: null,
        reason: `near-htlc: lock is ${lockView.status} at the finalized view — not yet a final on-chain state (D-N10)`,
      },
    };
  }

  if (accounts.payee === undefined) {
    return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "near-htlc: payee has no account line" } };
  }
  const token = config.assets.USDC;
  const mismatch = firstFieldMismatch({
    onChainPayee: lockView.payee,
    onChainPayer: lockView.payer,
    onChainToken: lockView.token,
    onChainAmount: lockView.amount,
    onChainClaimByMs: lockView.claimByMs,
    onChainRefundAfterMs: lockView.refundAfterMs,
    payee: accounts.payee,
    ...(accounts.payer === undefined ? {} : { payer: accounts.payer }),
    token,
    terms,
  });

  if (lockView.status === "Locked") {
    // H1: `rail` is attached ONLY once every field this capture can check matches — a mismatch
    // fails closed with NO rail, never "locked but wrong terms".
    if (mismatch !== null) {
      return { lock: { ...baseAtFinalizedView, railVerified: false, reason: mismatch } };
    }

    // Position 3: query call_function storage_balance_of(payee) — D-N10: a locked verdict must
    // also prove the payout can land, only performed once the lock itself already matches.
    const storageBound = bindExchange(capture, exchangeAt(exchanges, 3, "query"), "storage_balance_of");
    if (storageBound.kind === "missing") {
      return { lock: { ...baseAtFinalizedView, railVerified: null, reason: storageBound.reason } };
    }
    const storageParams = requestParamsObject(storageBound.request);
    const storageArgs = storageParams === null ? null : decodeCallArgs(storageParams);
    if (
      storageParams === null ||
      storageParams.request_type !== "call_function" ||
      storageParams.account_id !== token ||
      storageParams.method_name !== "storage_balance_of" ||
      storageParams.block_id !== block.hash ||
      storageArgs === null ||
      storageArgs.account_id !== accounts.payee
    ) {
      return {
        lock: {
          ...baseAtFinalizedView,
          railVerified: null,
          reason: "near-htlc: the storage_balance_of read does not target this leg's payee/token at the finalized block (tampered)",
        },
      };
    }
    if (storageBound.outcome.kind === "error") {
      return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "rpc rejected storage_balance_of" } };
    }
    const storageCallResult = decodeCallFunctionResult(storageBound.outcome.value);
    if (storageCallResult === null) {
      return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "near-htlc: malformed storage_balance_of result" } };
    }
    if ("error" in storageCallResult) {
      return { lock: { ...baseAtFinalizedView, railVerified: null, reason: `near-htlc: storage_balance_of panicked: ${storageCallResult.error}` } };
    }
    const storageBalance = parseStorageBalance(storageCallResult.resultText);
    if (storageBalance.kind === "malformed") {
      return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "near-htlc: malformed storage_balance_of result" } };
    }
    if (storageBalance.kind === "none") {
      return {
        lock: {
          ...baseAtFinalizedView,
          railVerified: false,
          reason: `near-htlc: payee "${accounts.payee}" is not storage-registered on the token — the payout could never land`,
        },
      };
    }
    const rail: RailObservation = { status: "locked", final: true, checkedAtMs, finalizedRef };
    return { lock: { ...baseAtFinalizedView, railVerified: true, reason: "near-htlc: locked and on-chain state matches terms (payee is storage-registered)" }, rail };
  }

  // status is Claimed or Refunded (Locked handled above; Claiming/Refunding already returned).
  const label: "claimed" | "refunded" = lockView.status === "Claimed" ? "claimed" : "refunded";
  const baseReason = `near-htlc: ${capture.index.ref} is ${label} on-chain, not locked`;
  if (mismatch !== null) {
    // H1: a field mismatch means this lock is NOT provably this swap's own escrow, no matter
    // what it was claimed/refunded by — `rail` must be omitted here exactly as in the Locked
    // branch above.
    return {
      lock: {
        ...baseAtFinalizedView,
        railVerified: null,
        reason: `${baseReason} — and its other fields do not match this swap's terms/accounts (${mismatch}) — refusing to trust it as this swap's own lock`,
      },
    };
  }
  const rail: RailObservation = { status: label, final: true, checkedAtMs, finalizedRef };
  return { lock: { ...baseAtFinalizedView, railVerified: false, reason: baseReason }, rail };
}

// ── the live capture ─────────────────────────────────────────────────────────────────────────

function randomNonce(): string {
  return randomBytes(8).toString("hex");
}

function buildIndex(config: NearRailConfig, ref: string, checkedAtMs: number, nonce: string, exchanges: readonly Exchange[], error?: string): NearCaptureIndex {
  return {
    v: 1,
    rail: "near-htlc",
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
 * The live half of "capture live, then decode" (mirrors `captureEvmLeg`/`captureBtcLeg`):
 * `status`, `block(finality: "final")`, `query call_function get_lock` pinned to that block's own
 * hash, and — only once `accounts.payee` is known — `query call_function storage_balance_of` for
 * that payee on `config.assets.USDC`, pinned to the same block hash. Every call through `rpc`, so
 * every byte is captured, and every id namespaced `"<ref>:<nowMs>:<nonce>:<n>"`. Never throws for
 * a chain-state reason (no such lock, a contract-side panic on a view call) — those are recorded
 * as whatever was captured, with no `error` set, and `nearEvidence` reports the specific reason
 * on replay; only a genuine transport-level failure sets `index.error` (F1's rule).
 */
export async function captureNearLeg(
  rpc: CapturingRpc,
  config: NearRailConfig,
  terms: LockTerms,
  accounts: NearAccounts,
  ref: string,
  nowMs: number,
): Promise<{ index: NearCaptureIndex; exchanges: Exchange[] }> {
  const nonce = randomNonce();
  if (nearLockRefInvalid(terms, ref)) {
    return { index: buildIndex(config, ref, nowMs, nonce, []), exchanges: [] };
  }
  const hashLockHex = ref.slice(2);

  const before = rpc.exchanges().length;
  const finish = (error?: string) => {
    const exchanges = rpc.exchanges().slice(before);
    return { index: buildIndex(config, ref, nowMs, nonce, exchanges, error), exchanges };
  };

  rpc.setIdNamespace(`${ref}:${nowMs}:${nonce}`);
  try {
    try {
      const statusResult = await rpc.request({ method: "status", params: [] });
      if (decodeStatusResult(statusResult) === null) return finish();
    } catch (error) {
      return finish(error instanceof Error ? error.message : String(error));
    }

    let block: { height: number; hash: string; timestampNs: string } | null;
    try {
      const blockResult = await rpc.request({ method: "block", params: { finality: "final" } });
      block = decodeBlockResult(blockResult);
    } catch (error) {
      return finish(error instanceof Error ? error.message : String(error));
    }
    if (block === null) return finish();

    const lockArgsBase64 = Buffer.from(new TextEncoder().encode(JSON.stringify({ hash_lock: hashLockHex }))).toString("base64");
    try {
      await rpc.request({
        method: "query",
        params: { request_type: "call_function", account_id: config.contract, method_name: "get_lock", args_base64: lockArgsBase64, block_id: block.hash },
      });
    } catch {
      // A view-call error is still a legitimate captured exchange (CapturingRpc records before
      // throwing) — nearEvidence sees it on replay and fails closed; nothing more to decide here.
    }

    if (accounts.payee !== undefined) {
      const storageArgsBase64 = Buffer.from(new TextEncoder().encode(JSON.stringify({ account_id: accounts.payee }))).toString("base64");
      try {
        await rpc.request({
          method: "query",
          params: {
            request_type: "call_function",
            account_id: config.assets.USDC,
            method_name: "storage_balance_of",
            args_base64: storageArgsBase64,
            block_id: block.hash,
          },
        });
      } catch {
        // Same as above — recorded regardless.
      }
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

function looksLikeCaptureIndexFile(value: unknown, ref: string): value is NearCaptureIndex {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || v.rail !== "near-htlc") return false;
  if (typeof v.ref !== "string" || v.ref !== ref || !HASH_LOCK_SHAPE.test(v.ref)) return false;
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

export interface LoadNearCaptureResult {
  capture: NearCapture | null;
  /** The newest index filename when it failed to read, parse, or validate as a capture index for
   *  this ref (and so failed the leg closed) — empty when it was fine. */
  skipped: string[];
}

/**
 * The one place a replay does file I/O for a `near-htlc` capture — everything downstream
 * (`nearEvidence`) is pure and synchronous over the result. Reads only the newest
 * `raw/near/<hashLock>/*.json` under `root` (ISO-stamped filenames sort chronologically;
 * `.tmp-*` leftovers are never candidates). If that newest file fails to read/parse/validate, the
 * leg fails closed (`capture: null`) — it never falls back to an older capture.
 */
export async function loadNearCapture(root: string, ref: string): Promise<LoadNearCaptureResult> {
  const dir = join(root, "raw", "near", ref);
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
