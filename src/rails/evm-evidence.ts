// SPDX-License-Identifier: MIT
//
// Pure evidence adapter for the vendored `evm-htlc` rail (src/vendor/evm-hash-rail.ts /
// contracts/EvmHashRail.sol): the chain twin of src/paper-evidence.ts. `evmEvidence` decodes
// one captured `locks(hashLock)` read into the same `LockEvidence`/`RailObservation` shapes
// the fold (src/swap.ts) already understands — no fetch, no clock, no network of its own; the
// caller supplies the captured bytes (`EvmCapture`, already loaded and re-hashed — see
// `loadEvmCapture` below) and every timestamp it reports comes from the capture itself
// (`capture.index.checkedAtMs`, P22-P24-EVM-FIXES.md A7), exactly like `paperEvidence` takes
// an already-fetched note body. `captureEvmLeg` is the one function here that touches the
// network, and only through the caller's own `rpc` (a rpc-capture.ts `CapturingRpc`): it
// performs the live reads and hands back the exact bytes plus a manifest (`EvmCaptureIndex`)
// that `evmEvidence` can later re-derive the identical verdict from, live or replayed —
// `src/rails/evm-htlc.ts`'s `verifyLockFinal` is implemented as "capture live, then call
// evmEvidence" for exactly this reason (the same rule P0.5 set for the paper rail: the live
// and replayed verdicts must never be able to diverge). Both `evmEvidence` and `foldCaptured`
// (src/replay.ts) are synchronous — fixes A11: a decode over already-loaded bytes has no
// business awaiting anything; the file I/O a replay needs lives entirely in `loadEvmCapture`,
// called by the caller *before* folding.
//
// Every branch here fails closed: a missing or tampered capture file, a chain id that isn't
// the pin, a capture taken under a different rail config, an exchange whose own requestBody
// doesn't actually ask for what it claims to (P22-P24-EVM-FIXES.md A1), a non-hex numeric
// value, an unrecognised on-chain status, a block with no hash, or a result that doesn't
// decode all become `railVerified: null` (nothing trustworthy to check) or `railVerified:
// false` (something was checked and it disagreed) — never a thrown exception, since every
// byte this reads is either a stranger's RPC response or a replayed file from disk, the same
// trust level `paperEvidence` gives a `/kv` note.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §2.2 point 3, §4;
// flop-contrib/handoff/P22-P24-EVM-FIXES.md A1, A2, A4, A7, A8, A11.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToNumber,
  isAddressEqual,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import type { LockTerms } from "@flop-labs/tclk";

import { EVM_HASH_RAIL_ABI } from "../vendor/evm-hash-rail.js";
import { readCapture, type CapturingRpc, type Exchange } from "./rpc-capture.js";
import type { EvmFinality, EvmRailConfig } from "./evm-htlc.js";
import type { LockEvidence, RailObservation } from "../types.js";

export const EVM_RAIL_ID = "evm-htlc";

/** Mirrors `contracts/EvmHashRail.sol`'s `Status` enum, in declaration order — same
 *  convention as `src/vendor/evm-hash-rail.ts`'s own (private) copy. */
const enum OnChainStatus {
  None = 0,
  Locked = 1,
  Claimed = 2,
  Refunded = 3,
}

export const HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/;
const BLOCK_HASH_SHAPE = /^0x[0-9a-fA-F]{64}$/;
const HEX_VALUE = /^0x[0-9a-fA-F]+$/;

/** A8/§2.2 point 3's guard, hoisted so it can run *before* any network call: `ref` must equal
 *  `terms.statement` (lowercase `0x` + 64 hex) and `terms.lock` must be `"hash"`. Used both by
 *  `evmEvidence` (as the first check over already-captured bytes) and by
 *  `EvmHtlcRail.verifyLockFinal`/`captureEvmLeg` (to refuse before ever touching the RPC —
 *  P22-P24-EVM-FIXES.md A8). */
export function hashLockRefMismatch(terms: LockTerms, ref: string): boolean {
  return terms.lock !== "hash" || !HASH_LOCK_SHAPE.test(ref) || ref !== terms.statement;
}

/** One captured exchange as it sits in the index file — `responseBody` itself is not here;
 *  it lives at `raw/rpc/<responseSha256>.json` (see rpc-capture.ts). */
export interface EvmCaptureIndexExchange {
  method: string;
  params: unknown;
  requestBody: string;
  responseSha256: string;
  atMs: number;
}

/** `raw/evm/<hashLock>/<iso-stamp>.json` (§4): a manifest naming every raw RPC exchange one
 *  `captureEvmLeg` call produced, in call order. `config` (P22-P24-EVM-FIXES.md A4) is the
 *  full `EvmRailConfig` this capture was taken under — frozen at capture time, so a later
 *  edit to the live `EvmRailConfig` (a new asset mapping, a widened finality policy) can
 *  never silently change how an old capture replays; `evmEvidence` requires it to agree with
 *  the auditor's own supplied config on chain id, contract and this leg's asset before
 *  trusting anything decoded from the bytes, and decodes the finalized view according to
 *  *this* config's `pin.finality`, not the caller's. */
export interface EvmCaptureIndex {
  v: 1;
  rail: "evm-htlc";
  chainId: number;
  caip2: string;
  pin: string;
  endpoint: string;
  contract: Address;
  hashLock: string;
  checkedAtMs: number;
  finality: { mode: "tag"; tag: "finalized" } | { mode: "confirmations"; confirmations: number };
  config: EvmRailConfig;
  exchanges: EvmCaptureIndexExchange[];
}

/**
 * The index plus every exchange's already-loaded, already-re-hashed response bytes
 * (P22-P24-EVM-FIXES.md A11) — `evmEvidence` is pure and synchronous over this: it never
 * reads a file or awaits anything itself. A live read builds this map straight from the
 * `Exchange`s `captureEvmLeg` just produced (`EvmHtlcRail.verifyLockFinal`); a replay builds
 * it with `loadEvmCapture` below, which does the one round of file I/O (and `readCapture`'s
 * own re-hashing) up front. A key absent from the map, or mapped to `null`, means that
 * exchange's bytes could not be verified (missing file, hash mismatch, never captured) —
 * `evmEvidence` treats either the same way: fail closed, never a thrown exception, since
 * every byte here is either a stranger's RPC response or a replayed file from disk.
 */
export interface EvmCapture {
  index: EvmCaptureIndex;
  bytes: ReadonlyMap<string, Uint8Array | null>;
}

export interface EvmEvidenceResult {
  lock: LockEvidence;
  rail?: RailObservation;
}

/** The chain accounts a caller has already resolved for this swap's parties (§3's
 *  `resolveAccounts` shape) — `evmEvidence` takes them as given, it does not resolve DIDs. */
export interface EvmAccounts {
  payee?: Address;
  payer?: Address;
}

export interface EvmEvidenceInput {
  terms: LockTerms;
  config: EvmRailConfig;
  accounts: EvmAccounts;
  capture: EvmCapture;
}

/** Minimal shape check on a decoded `index.config` — enough to refuse a pre-A4 capture (no
 *  `config` at all) or a corrupted one without crashing on a missing/mistyped field; the
 *  fuller `validateEvmRailConfig` (deny list, D-09 asset check) is `src/rails/evm-htlc.ts`'s
 *  job wherever a config is actually *used* to connect (A3, a later fixer's item) — this is
 *  just enough for `evmEvidence` to trust reading `.pin.chainId` / `.contract` / `.assets`. */
function looksLikeEvmRailConfig(value: unknown): value is EvmRailConfig {
  if (value === null || typeof value !== "object") return false;
  const v = value as { pin?: unknown; contract?: unknown; assets?: unknown };
  if (v.pin === null || typeof v.pin !== "object") return false;
  const pin = v.pin as { chainId?: unknown; finality?: unknown };
  if (typeof pin.chainId !== "number") return false;
  if (pin.finality === null || typeof pin.finality !== "object") return false;
  const finality = pin.finality as { mode?: unknown };
  if (finality.mode !== "tag" && finality.mode !== "confirmations") return false;
  return typeof v.contract === "string" && v.assets !== null && typeof v.assets === "object";
}

/** Whether a captured config's own finality knobs are even well-formed (positive integer
 *  confirmations, if any) — a corrupted/hostile index that turns this to nonsense fails
 *  closed instead of ever reaching a bare integer arithmetic path with garbage. */
function finalityLooksValid(finality: EvmFinality): boolean {
  if (finality.mode === "confirmations") {
    return Number.isInteger(finality.confirmations) && finality.confirmations > 0;
  }
  return (
    finality.fallbackConfirmations === undefined ||
    (Number.isInteger(finality.fallbackConfirmations) && finality.fallbackConfirmations > 0)
  );
}

function findByMethod(exchanges: readonly EvmCaptureIndexExchange[], method: string): EvmCaptureIndexExchange | null {
  return exchanges.find((exchange) => exchange.method === method) ?? null;
}

/** A2: parse a hex numeric value the way every wire number in this file must be parsed —
 *  never handing a non-hex or absent value straight to `hexToNumber` (which throws). `null`
 *  for anything that isn't a well-formed `0x`-prefixed hex string, or that overflows what
 *  `hexToNumber` can represent. */
function parseHexNumber(value: unknown): number | null {
  if (typeof value !== "string" || !HEX_VALUE.test(value)) return null;
  try {
    return hexToNumber(value as Hex);
  } catch {
    return null;
  }
}

function blockResultHash(value: unknown): Hex | null {
  if (value === null || typeof value !== "object") return null;
  const hash = (value as { hash?: unknown }).hash;
  return typeof hash === "string" && BLOCK_HASH_SHAPE.test(hash) ? (hash as Hex) : null;
}

function blockResultNumber(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  return parseHexNumber((value as { number?: unknown }).number);
}

type EnvelopeOutcome = { kind: "result"; value: unknown } | { kind: "error" };

interface ParsedRequest {
  id: number;
  method: string;
  params: unknown;
}

/** A1: parse one exchange's own `requestBody` — the literal bytes that were sent — never the
 *  index's separate (attacker-editable) `.method`/`.params` metadata fields. `null` for
 *  anything that isn't a JSON-RPC request object with a numeric `id` and string `method`. */
function parseRequestBody(exchange: EvmCaptureIndexExchange): ParsedRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exchange.requestBody);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof obj.id !== "number" || typeof obj.method !== "string") return null;
  return { id: obj.id, method: obj.method, params: obj.params };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type BoundExchange =
  | { kind: "missing"; reason: string }
  | { kind: "bound"; request: ParsedRequest; outcome: EnvelopeOutcome };

/**
 * A1: bind one exchange's declared identity to what it actually is. `findByMethod`/a
 * caller's own filtering only ever pick a *candidate* by the index's own (attacker-editable)
 * `.method`/`.params` fields; this is what actually authenticates that candidate before its
 * bytes are trusted for anything: its `requestBody` really does ask for the `.method`/
 * `.params` the index claims, and the response's own JSON-RPC `id` really does answer that
 * exact request — never merely "a same-shaped response happened to be captured somewhere".
 * A swapped-in genuine response from a different capture, a rewritten block selector, or an
 * id mismatch all fail here, the same way a missing or hash-mismatched file does — fail
 * closed, never a thrown exception, since every byte behind this is untrusted input.
 */
function bindExchange(capture: EvmCapture, exchange: EvmCaptureIndexExchange | null, label: string): BoundExchange {
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
  if (envelope.error !== undefined && envelope.error !== null) return { kind: "bound", request, outcome: { kind: "error" } };
  return { kind: "bound", request, outcome: { kind: "result", value: envelope.result } };
}

interface FinalizedBlock {
  ok: true;
  number: number;
  hash: Hex;
  finalityLabel: string;
}
interface FinalizedBlockFailure {
  ok: false;
  reason: string;
}

function requestedBlockNumberArg(request: ParsedRequest): number | null {
  if (!Array.isArray(request.params) || request.params.length < 1) return null;
  return parseHexNumber(request.params[0]);
}

/** Replay-side "confirmations" read: `eth_blockNumber` then `eth_getBlockByNumber(latest-N)`,
 *  decoded purely from the captured exchanges. `blockCall` is the specific exchange to decode
 *  as the numbered block (the caller has already picked it out among possibly two
 *  `eth_getBlockByNumber` calls — see `resolveFinalizedBlock`). A1: the numbered block's own
 *  request must actually ask for `latest − confirmations` (not whatever the index's
 *  `.params` metadata merely claims) — the block's reported *number* is taken from that
 *  verified request, never trusted from the (tamperable) response body. */
function readNumberedBlock(
  capture: EvmCapture,
  exchanges: readonly EvmCaptureIndexExchange[],
  confirmations: number,
  blockCall: EvmCaptureIndexExchange | null,
): FinalizedBlock | FinalizedBlockFailure {
  const latestBound = bindExchange(capture, findByMethod(exchanges, "eth_blockNumber"), "eth_blockNumber");
  if (latestBound.kind === "missing") return { ok: false, reason: latestBound.reason };
  if (latestBound.outcome.kind === "error") return { ok: false, reason: "rpc rejected eth_blockNumber" };
  const latestNumber = parseHexNumber(latestBound.outcome.value);
  if (latestNumber === null) return { ok: false, reason: "evm-htlc: malformed eth_blockNumber result (not hex)" };

  const blockBound = bindExchange(capture, blockCall, "eth_getBlockByNumber(confirmations)");
  if (blockBound.kind === "missing") return { ok: false, reason: blockBound.reason };
  if (blockBound.outcome.kind === "error") return { ok: false, reason: "rpc rejected eth_getBlockByNumber" };

  const requestedNumber = requestedBlockNumberArg(blockBound.request);
  const requestShapeOk =
    Array.isArray(blockBound.request.params) && blockBound.request.params.length === 2 && blockBound.request.params[1] === false;
  if (requestedNumber === null || !requestShapeOk || requestedNumber !== latestNumber - confirmations) {
    return {
      ok: false,
      reason: "evm-htlc: the numbered block read does not target latest - confirmations (tampered block selector)",
    };
  }

  const hash = blockResultHash(blockBound.outcome.value);
  if (hash === null) return { ok: false, reason: "finalized block has no hash" };
  return { ok: true, number: requestedNumber, hash, finalityLabel: `confirmations-${confirmations}` };
}

/**
 * Reconstruct §2.2 point 3's finalized-view decision purely from the captured exchanges and
 * `capturedConfig.pin.finality` — the config *this capture was taken under*
 * (P22-P24-EVM-FIXES.md A4), never the auditor's own possibly-since-changed config. Mode
 * "tag": look for the exchange that asked for `finality.tag`; if its own request really is
 * `[tag, false]` (A1) and it decoded to a real block with a hash, that block is final.
 * Otherwise (the RPC rejected the tag, answered with `null`/a hash-less block, or the
 * request itself was tampered to ask for something else) fall back to
 * `finality.fallbackConfirmations` when configured, else fail closed — exactly the branch
 * `verifyLockFinal`'s live path takes, replayed from disk. Mode "confirmations": always the
 * numbered read.
 */
function resolveFinalizedBlock(capturedConfig: EvmRailConfig, capture: EvmCapture): FinalizedBlock | FinalizedBlockFailure {
  const exchanges = capture.index.exchanges;
  const finality = capturedConfig.pin.finality;

  if (finality.mode === "confirmations") {
    return readNumberedBlock(capture, exchanges, finality.confirmations, findByMethod(exchanges, "eth_getBlockByNumber"));
  }

  const blockCalls = exchanges.filter((exchange) => exchange.method === "eth_getBlockByNumber");
  const tagCall = blockCalls.find((exchange) => Array.isArray(exchange.params) && exchange.params[0] === finality.tag) ?? null;
  const tagBound = bindExchange(capture, tagCall, `eth_getBlockByNumber(${finality.tag})`);

  if (tagBound.kind === "missing") return { ok: false, reason: tagBound.reason };

  if (tagBound.outcome.kind === "result") {
    const params = tagBound.request.params;
    const requestIsTag = Array.isArray(params) && params.length === 2 && params[0] === finality.tag && params[1] === false;
    if (!requestIsTag) {
      return {
        ok: false,
        reason: `evm-htlc: the finalized-tag read does not request ["${finality.tag}", false] (tampered block selector)`,
      };
    }
    const hash = blockResultHash(tagBound.outcome.value);
    const number = blockResultNumber(tagBound.outcome.value);
    if (hash !== null && number !== null) return { ok: true, number, hash, finalityLabel: "finalized" };
  }

  if (finality.fallbackConfirmations === undefined) {
    return { ok: false, reason: "rpc lacks the finalized tag and no fallbackConfirmations is configured" };
  }
  const fallbackCall = blockCalls.find((exchange) => exchange !== tagCall) ?? null;
  return readNumberedBlock(capture, exchanges, finality.fallbackConfirmations, fallbackCall);
}

/** A1: the `eth_call` request itself must target this deployment's contract with
 *  `locks(hashLock)` calldata for *this* lock, read at *this* finalized block by hash — never
 *  merely trusted because a candidate exchange's own `.method` said `"eth_call"`. `null` when
 *  the request checks out; otherwise the fail-closed reason. */
function validateLocksCallRequest(request: ParsedRequest, config: EvmRailConfig, hashLock: Hex, finalizedBlockHash: Hex): string | null {
  const params = request.params;
  if (!Array.isArray(params) || params.length !== 2) {
    return "evm-htlc: eth_call request is not shaped like a locks() read (tampered)";
  }
  const [callObject, blockSelector] = params as [unknown, unknown];
  if (callObject === null || typeof callObject !== "object") {
    return "evm-htlc: eth_call request has no call object (tampered)";
  }
  const to = (callObject as { to?: unknown }).to;
  const data = (callObject as { data?: unknown }).data;
  if (typeof to !== "string" || !HEX_VALUE.test(to) || !isAddressEqual(to as Address, config.contract)) {
    return "evm-htlc: eth_call request does not target this deployment's contract (tampered)";
  }
  const expectedData = encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [hashLock] });
  if (typeof data !== "string" || data.toLowerCase() !== expectedData.toLowerCase()) {
    return "evm-htlc: eth_call request does not encode locks(hashLock) for this lock (tampered)";
  }
  if (blockSelector === null || typeof blockSelector !== "object") {
    return "evm-htlc: eth_call request has no block selector (tampered)";
  }
  const blockHash = (blockSelector as { blockHash?: unknown }).blockHash;
  if (typeof blockHash !== "string" || !BLOCK_HASH_SHAPE.test(blockHash) || blockHash.toLowerCase() !== finalizedBlockHash.toLowerCase()) {
    return "evm-htlc: eth_call request is not pinned to the finalized block (tampered block selector)";
  }
  return null;
}

function firstFieldMismatch(args: {
  onChainPayee: Address;
  onChainToken: Address;
  onChainAmount: bigint;
  onChainClaimByMs: bigint;
  onChainRefundAfterMs: bigint;
  onChainPayer: Address;
  payee: Address;
  payer?: Address;
  token: Address;
  terms: LockTerms;
}): string | null {
  const { onChainPayee, onChainToken, onChainAmount, onChainClaimByMs, onChainRefundAfterMs, onChainPayer, payee, payer, token, terms } =
    args;
  if (!isAddressEqual(onChainPayee, payee)) return "evm-htlc: on-chain payee differs from the payee account line";
  if (!isAddressEqual(onChainToken, token)) return "evm-htlc: on-chain token differs from the configured asset";
  if (onChainAmount !== BigInt(terms.amount)) return "evm-htlc: on-chain amount differs from terms";
  if (onChainClaimByMs !== BigInt(terms.claimByMs)) return "evm-htlc: on-chain claimByMs differs from terms";
  if (onChainRefundAfterMs !== BigInt(terms.refundAfterMs)) {
    return "evm-htlc: on-chain refundAfterMs differs from terms";
  }
  if (payer !== undefined && !isAddressEqual(onChainPayer, payer)) {
    return "evm-htlc: on-chain payer differs from the payer account line";
  }
  return null;
}

/**
 * Turn one captured `locks(hashLock)` read into evidence for `terms`. Pure and synchronous
 * (P22-P24-EVM-FIXES.md A11) — every byte it looks at is already sitting in `capture.bytes`.
 * See P22-P24-EVM-SPEC.md §2.2 point 3 for the branch table this implements (finalized view
 * → decode → status None/Claimed/Refunded/Locked → the Locked branch's field-by-field
 * compare), extended per P22-P24-EVM-FIXES.md A1 (bind every exchange to its request), A2
 * (never throw on captured data), A4 (the capture's own config must match the auditor's) and
 * A7 (`checkedAtMs` comes from the capture, not the caller, so a replay of the same bytes can
 * never disagree with what the live watcher reported).
 */
export function evmEvidence(input: EvmEvidenceInput): EvmEvidenceResult {
  const { terms, config, accounts, capture } = input;
  const checkedAtMs = capture.index.checkedAtMs; // A7
  const raw = capture.index.exchanges.map((exchange) => exchange.responseSha256);
  const base = {
    rail: EVM_RAIL_ID,
    ref: capture.index.hashLock,
    terms,
    checkedAtMs,
    endpoint: config.endpoint,
    raw,
  };

  if (hashLockRefMismatch(terms, capture.index.hashLock)) {
    return {
      lock: {
        ...base,
        railVerified: false,
        reason: 'evm-htlc: ref/lock mismatch (ref must equal terms.statement and lock must be "hash")',
      },
    };
  }

  // A4: this capture must carry a config, and it must agree with the auditor's own supplied
  // config (the trust anchor for which deployment is ours) on chain id, contract and this
  // leg's asset — a later edit to rails.json must never silently change how an old capture
  // replays.
  const capturedConfig = capture.index.config;
  if (!looksLikeEvmRailConfig(capturedConfig)) {
    return { lock: { ...base, railVerified: null, reason: "evm-htlc: capture index has no usable config (A4)" } };
  }
  const capturedAssetToken = capturedConfig.assets[terms.asset];
  const configAssetToken = config.assets[terms.asset];
  if (
    capturedConfig.pin.chainId !== config.pin.chainId ||
    !isAddressEqual(capturedConfig.contract, config.contract) ||
    (capturedAssetToken !== undefined && configAssetToken !== undefined && !isAddressEqual(capturedAssetToken, configAssetToken))
  ) {
    return { lock: { ...base, railVerified: null, reason: "evm-htlc: capture was taken under a different rail config" } };
  }
  if (!finalityLooksValid(capturedConfig.pin.finality)) {
    return { lock: { ...base, railVerified: null, reason: "evm-htlc: capture's finality config is malformed" } };
  }

  const chainIdBound = bindExchange(capture, findByMethod(capture.index.exchanges, "eth_chainId"), "eth_chainId");
  if (chainIdBound.kind === "missing") {
    return { lock: { ...base, railVerified: null, reason: chainIdBound.reason } };
  }
  if (chainIdBound.outcome.kind === "error") {
    return { lock: { ...base, railVerified: null, reason: "rpc rejected eth_chainId" } };
  }
  const chainId = parseHexNumber(chainIdBound.outcome.value);
  if (chainId === null) {
    return { lock: { ...base, railVerified: null, reason: "evm-htlc: malformed eth_chainId result (not hex)" } };
  }
  if (chainId !== config.pin.chainId) {
    return {
      lock: {
        ...base,
        railVerified: null,
        reason: `captured chain id ${chainId} does not match pin "${config.pin.name}" (expected ${config.pin.chainId})`,
      },
    };
  }

  if (!isAddressEqual(capture.index.contract, config.contract)) {
    return { lock: { ...base, railVerified: null, reason: "capture index contract does not match config.contract" } };
  }

  const finalized = resolveFinalizedBlock(capturedConfig, capture);
  if (!finalized.ok) {
    return { lock: { ...base, railVerified: null, reason: finalized.reason } };
  }

  const callBound = bindExchange(capture, findByMethod(capture.index.exchanges, "eth_call"), "eth_call");
  if (callBound.kind === "missing") {
    return { lock: { ...base, railVerified: null, reason: callBound.reason } };
  }
  if (callBound.outcome.kind === "error") {
    return { lock: { ...base, railVerified: null, reason: "rpc rejected eth_call locks(hashLock)" } };
  }

  const callRequestReason = validateLocksCallRequest(
    callBound.request,
    config,
    capture.index.hashLock as Hex,
    finalized.hash,
  );
  if (callRequestReason !== null) {
    return { lock: { ...base, railVerified: null, reason: callRequestReason } };
  }

  let decoded: unknown;
  try {
    decoded = decodeFunctionResult({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", data: callBound.outcome.value as Hex });
  } catch {
    return { lock: { ...base, railVerified: null, reason: "malformed locks() result" } };
  }
  const [onChainPayer, onChainPayee, onChainToken, onChainAmount, onChainClaimByMs, onChainRefundAfterMs, status] =
    decoded as readonly [Address, Address, Address, bigint, bigint, bigint, number];

  const finalizedRef = `${config.pin.name}:${finalized.finalityLabel}:${finalized.number}:${finalized.hash}`;
  // Every branch from here on did successfully resolve a finalized view, so `base` gains
  // `finalizedRef` for the rest of this function (LockEvidence carries the same finalizedRef
  // the RailObservation does, per §2.2 point 3).
  const baseAtFinalizedView = { ...base, finalizedRef };

  // A2: an on-chain status outside the contract's own declared range never decodes to a
  // guessed branch (the pre-fix behaviour silently treated 4..255 as Locked).
  if (status !== OnChainStatus.None && status !== OnChainStatus.Locked && status !== OnChainStatus.Claimed && status !== OnChainStatus.Refunded) {
    return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "malformed locks() result (unknown status)" } };
  }

  if (status === OnChainStatus.None) {
    return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "no lock at the finalized view" } };
  }
  if (status === OnChainStatus.Claimed) {
    return {
      lock: { ...baseAtFinalizedView, railVerified: false, reason: "evm-htlc: locks(hashLock) is claimed on-chain, not locked" },
      rail: { status: "claimed", final: true, checkedAtMs, finalizedRef },
    };
  }
  if (status === OnChainStatus.Refunded) {
    return {
      lock: { ...baseAtFinalizedView, railVerified: false, reason: "evm-htlc: locks(hashLock) is refunded on-chain, not locked" },
      rail: { status: "refunded", final: true, checkedAtMs, finalizedRef },
    };
  }

  // status === Locked.
  const rail: RailObservation = { status: "locked", final: true, checkedAtMs, finalizedRef };

  if (accounts.payee === undefined) {
    return { lock: { ...baseAtFinalizedView, railVerified: null, reason: "payee has no account line" }, rail };
  }
  const token = config.assets[terms.asset];
  if (token === undefined) {
    return {
      lock: { ...baseAtFinalizedView, railVerified: null, reason: `asset "${terms.asset}" has no configured token address` },
      rail,
    };
  }

  const mismatch = firstFieldMismatch({
    onChainPayee,
    onChainToken,
    onChainAmount,
    onChainClaimByMs,
    onChainRefundAfterMs,
    onChainPayer,
    payee: accounts.payee,
    ...(accounts.payer === undefined ? {} : { payer: accounts.payer }),
    token,
    terms,
  });
  if (mismatch !== null) {
    return { lock: { ...baseAtFinalizedView, railVerified: false, reason: mismatch }, rail };
  }

  const reason =
    accounts.payer === undefined
      ? "evm-htlc: payer unbound (no payer account line)"
      : "evm-htlc: locked and on-chain state matches terms";
  return { lock: { ...baseAtFinalizedView, railVerified: true, reason }, rail };
}

async function readLiveNumberedBlockHash(rpc: CapturingRpc, confirmations: number): Promise<Hex | null> {
  const latestHex = (await rpc.request({ method: "eth_blockNumber", params: [] })) as Hex;
  const latest = hexToNumber(latestHex);
  const n = latest - confirmations;
  const result = (await rpc.request({ method: "eth_getBlockByNumber", params: [numberToHex(n), false] })) as unknown;
  return blockResultHash(result);
}

function buildIndex(
  config: EvmRailConfig,
  chainId: number,
  hashLock: string,
  checkedAtMs: number,
  exchanges: readonly Exchange[],
  finality: EvmCaptureIndex["finality"],
): EvmCaptureIndex {
  return {
    v: 1,
    rail: "evm-htlc",
    chainId,
    caip2: config.pin.caip2,
    pin: config.pin.name,
    endpoint: config.endpoint,
    contract: config.contract,
    hashLock,
    checkedAtMs,
    finality,
    config, // A4: freeze the exact config this capture was taken under.
    exchanges: exchanges.map(({ method, params, requestBody, responseSha256, atMs }) => ({
      method,
      params,
      requestBody,
      responseSha256,
      atMs,
    })),
  };
}

/**
 * The live half of the "capture live, then evmEvidence" rule: `eth_chainId`, the
 * finalized-block read (per `config.pin.finality`, with the tag→fallback branch §2.2 point 3
 * describes), and `eth_call locks(hashLock)` pinned to that block by hash (EIP-1898
 * `{ blockHash }`) — every call through `rpc`, so every byte is captured. Returns the index
 * (§4's on-disk manifest shape) plus the raw `Exchange`s (for `writeCapture`/an in-memory
 * `EvmCapture.bytes`). A8: a malformed `hashLock` can never resolve to real evidence, so it
 * is refused up front — before ever touching `rpc` — the same guard `verifyLockFinal` applies
 * before calling this at all. Otherwise never throws for a rejected finalized tag (falls back
 * or gives up per config, still returning whatever it captured) — only a genuine transport
 * failure (the node unreachable) propagates, since there is nothing this function could paper
 * over for that.
 */
export async function captureEvmLeg(
  rpc: CapturingRpc,
  config: EvmRailConfig,
  hashLock: string,
  nowMs: number,
): Promise<{ index: EvmCaptureIndex; exchanges: Exchange[] }> {
  if (!HASH_LOCK_SHAPE.test(hashLock)) {
    const finality = config.pin.finality;
    const finalityRecord: EvmCaptureIndex["finality"] =
      finality.mode === "confirmations" ? { mode: "confirmations", confirmations: finality.confirmations } : { mode: "tag", tag: finality.tag };
    return { index: buildIndex(config, 0, hashLock, nowMs, [], finalityRecord), exchanges: [] };
  }

  const before = rpc.exchanges().length;
  const finish = (finality: EvmCaptureIndex["finality"], chainId: number) => {
    const exchanges = rpc.exchanges().slice(before);
    return { index: buildIndex(config, chainId, hashLock, nowMs, exchanges, finality), exchanges };
  };

  const chainIdHex = (await rpc.request({ method: "eth_chainId", params: [] })) as Hex;
  const chainId = hexToNumber(chainIdHex);
  const finality = config.pin.finality;

  let blockHash: Hex | null;
  let finalityRecord: EvmCaptureIndex["finality"];

  if (finality.mode === "confirmations") {
    blockHash = await readLiveNumberedBlockHash(rpc, finality.confirmations);
    finalityRecord = { mode: "confirmations", confirmations: finality.confirmations };
  } else {
    let tagHash: Hex | null = null;
    try {
      const result = await rpc.request({ method: "eth_getBlockByNumber", params: [finality.tag, false] });
      tagHash = blockResultHash(result);
    } catch {
      tagHash = null;
    }

    if (tagHash !== null) {
      blockHash = tagHash;
      finalityRecord = { mode: "tag", tag: finality.tag };
    } else if (finality.fallbackConfirmations !== undefined) {
      blockHash = await readLiveNumberedBlockHash(rpc, finality.fallbackConfirmations);
      finalityRecord = { mode: "confirmations", confirmations: finality.fallbackConfirmations };
    } else {
      return finish({ mode: "tag", tag: finality.tag }, chainId);
    }
  }

  if (blockHash === null) return finish(finalityRecord, chainId);

  const data = encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [hashLock as Hex] });
  try {
    await rpc.request({ method: "eth_call", params: [{ to: config.contract, data }, { blockHash }] });
  } catch {
    // Recorded regardless (CapturingRpc records before throwing) — evmEvidence sees the
    // error envelope on replay and fails closed; nothing more for this function to decide.
  }

  return finish(finalityRecord, chainId);
}

const SHA256_HEX_LOWER = /^[0-9a-f]{64}$/;

/** P22-P24-EVM-FIXES.md A5: whether a parsed `raw/evm/<hashLock>/*.json` file actually looks
 *  like an index this build wrote — `v === 1`, `rail === "evm-htlc"`, `hashLock` equal to the
 *  directory name it was found under and hash-shaped, and `exchanges` an array of well-formed
 *  entries (each with the fields `bindExchange`/`resolveFinalizedBlock` above dereference).
 *  Deliberately narrower than `looksLikeEvmRailConfig`'s check on `index.config` (A4's job,
 *  run later by `evmEvidence` itself once a candidate index has passed this gate) — this is
 *  only "is this file even a capture index for this hashLock", not "is its config any good". */
function looksLikeCaptureIndexFile(value: unknown, hashLock: string): value is EvmCaptureIndex {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || v.rail !== "evm-htlc") return false;
  if (typeof v.hashLock !== "string" || v.hashLock !== hashLock || !HASH_LOCK_SHAPE.test(v.hashLock)) return false;
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

/** A5: only real capture-index files are candidates — `*.json`, never a `*.tmp-*` leftover
 *  from an atomic write (`writeFileAtomic` in `src/watcher.ts`/`rpc-capture.ts`) interrupted
 *  mid-write, which would otherwise sort after a real (ISO-stamped) name and get mistaken for
 *  "the newest" one. */
function isCaptureIndexCandidate(name: string): boolean {
  return name.endsWith(".json") && !name.includes(".tmp-");
}

export interface LoadEvmCaptureResult {
  capture: EvmCapture | null;
  /** A5: candidate filenames (newest first) that were skipped because they failed to read,
   *  parse, or validate as a capture index for this hashLock — empty in the common case where
   *  every candidate file was fine. The caller decides how (or whether) to surface these; a
   *  bad file here fails only this hashLock's evidence closed, never the whole replay. */
  skipped: string[];
}

/**
 * A11/A5: the one place a replay does file I/O for an EVM capture — everything downstream
 * (`evmEvidence`, `foldCaptured`) is pure and synchronous over the result. Tries every
 * `raw/evm/<hashLock>/*.json` candidate under `root`, newest first (ISO-stamped names sort
 * chronologically; `.tmp-*` leftovers and non-`.json` entries are never candidates at all),
 * and returns the first one that actually parses and validates as this hashLock's capture
 * index — so a corrupted or interrupted *latest* write falls back to the newest still-good
 * one instead of failing the leg outright. Once a valid index is found, its exchanges' bytes
 * are pre-loaded and re-verified (via `readCapture`'s own re-hashing), the same shape a live
 * capture's in-memory bytes are given, so `evmEvidence` never needs to know which source it
 * came from. `capture: null` when the hashLock has no capture directory, or no candidate file
 * ever validates — the caller (`examples/audit-export.mjs`) treats that exactly like "not
 * captured" evidence-wise, never a thrown exception.
 */
export async function loadEvmCapture(root: string, hashLock: string): Promise<LoadEvmCaptureResult> {
  const dir = join(root, "raw", "evm", hashLock);
  let allEntries: string[];
  try {
    allEntries = await readdir(dir);
  } catch {
    return { capture: null, skipped: [] };
  }
  const candidates = allEntries.filter(isCaptureIndexCandidate).sort().reverse(); // newest first

  const skipped: string[] = [];
  for (const name of candidates) {
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      skipped.push(name);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped.push(name);
      continue;
    }
    if (!looksLikeCaptureIndexFile(parsed, hashLock)) {
      skipped.push(name);
      continue;
    }

    const index = parsed;
    const bytes = new Map<string, Uint8Array | null>();
    for (const exchange of index.exchanges) {
      if (bytes.has(exchange.responseSha256)) continue;
      const body = await readCapture(root, exchange.responseSha256);
      bytes.set(exchange.responseSha256, body === null ? null : new TextEncoder().encode(body));
    }
    return { capture: { index, bytes }, skipped };
  }
  return { capture: null, skipped };
}
