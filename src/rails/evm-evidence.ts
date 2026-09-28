// SPDX-License-Identifier: MIT
//
// Pure evidence adapter for the vendored `evm-htlc` rail (src/vendor/evm-hash-rail.ts /
// contracts/EvmHashRail.sol): the chain twin of src/paper-evidence.ts. `evmEvidence` decodes
// one captured `locks(hashLock)` read into the same `LockEvidence`/`RailObservation` shapes
// the fold (src/swap.ts) already understands — no fetch, no clock, no network of its own; the
// caller supplies the captured bytes (`EvmCapture`) and the time the check is considered to
// have happened (`checkedAtMs`), exactly like `paperEvidence` takes an already-fetched note
// body. `captureEvmLeg` is the one function here that touches the network, and only through
// the caller's own `rpc` (a rpc-capture.ts `CapturingRpc`): it performs the live reads and
// hands back the exact bytes plus a manifest (`EvmCaptureIndex`) that `evmEvidence` can later
// re-derive the identical verdict from, live or replayed — `src/rails/evm-htlc.ts`'s
// `verifyLockFinal` is implemented as "capture live, then call evmEvidence" for exactly this
// reason (the same rule P0.5 set for the paper rail: the live and replayed verdicts must
// never be able to diverge).
//
// Every branch here fails closed: a missing or tampered capture file, a chain id that isn't
// the pin, an index whose contract differs from `config.contract`, a block with no hash, or a
// result that doesn't decode all become `railVerified: null` (nothing trustworthy to check)
// or `railVerified: false` (something was checked and it disagreed) — never a thrown
// exception, since every byte this reads is either a stranger's RPC response or a replayed
// file from disk, the same trust level `paperEvidence` gives a `/kv` note.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §2.2 point 3, §4.

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
import type { CapturingRpc, Exchange } from "./rpc-capture.js";
import type { EvmRailConfig } from "./evm-htlc.js";
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

const HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/;

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
 *  `captureEvmLeg` call produced, in call order. */
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
  exchanges: EvmCaptureIndexExchange[];
}

/**
 * The index plus a way to fetch the verified bytes behind any of its exchanges. `load` is
 * injected so the same shape serves a live read (the bytes are already in memory —
 * `EvmHtlcRail.verifyLockFinal` hands back a plain map lookup) and a replay (bytes reloaded
 * from `raw/rpc/<sha256>.json` through `readCapture`, which re-hashes them). `evmEvidence`
 * decodes only from what `load` returns — never from `index` alone — so a tampered response
 * file fails closed even though its sha256 is still named in the index.
 */
export interface EvmCapture {
  index: EvmCaptureIndex;
  load(sha256Hex: string): string | null | Promise<string | null>;
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
  checkedAtMs: number;
}

type EnvelopeOutcome =
  | { kind: "result"; value: unknown }
  | { kind: "error" }
  | { kind: "missing"; reason: string };

function findByMethod(exchanges: readonly EvmCaptureIndexExchange[], method: string): EvmCaptureIndexExchange | null {
  return exchanges.find((exchange) => exchange.method === method) ?? null;
}

/** Load one exchange's captured JSON-RPC response and classify it: a decoded `.result`, a
 *  decoded `.error`, or "missing" (no such exchange, the file is gone, its hash no longer
 *  matches, or it isn't a JSON-RPC envelope at all) — the one case that always fails closed
 *  regardless of what the caller was hoping to find. */
async function loadEnvelope(
  capture: EvmCapture,
  exchange: EvmCaptureIndexExchange | null,
  label: string,
): Promise<EnvelopeOutcome> {
  if (exchange === null) return { kind: "missing", reason: `missing/tampered capture: no ${label} exchange` };
  const body = await capture.load(exchange.responseSha256);
  if (body === null) return { kind: "missing", reason: `missing/tampered capture: ${label}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (unparseable)` };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (not a JSON-RPC object)` };
  }
  const envelope = parsed as { result?: unknown; error?: unknown };
  if (envelope.error !== undefined && envelope.error !== null) return { kind: "error" };
  return { kind: "result", value: envelope.result };
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

function blockResultHash(value: unknown): Hex | null {
  if (value === null || typeof value !== "object") return null;
  const hash = (value as { hash?: unknown }).hash;
  return typeof hash === "string" ? (hash as Hex) : null;
}

function blockResultNumber(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const number = (value as { number?: unknown }).number;
  return typeof number === "string" ? hexToNumber(number as Hex) : null;
}

/** Replay-side "confirmations" read: `eth_blockNumber` then `eth_getBlockByNumber(latest-N)`,
 *  decoded purely from the captured exchanges. `blockCall` is the specific exchange to decode
 *  as the numbered block (the caller has already picked it out among possibly two
 *  `eth_getBlockByNumber` calls — see `resolveFinalizedBlock`). */
async function readNumberedBlock(
  capture: EvmCapture,
  exchanges: readonly EvmCaptureIndexExchange[],
  confirmations: number,
  blockCall: EvmCaptureIndexExchange | null,
): Promise<FinalizedBlock | FinalizedBlockFailure> {
  const latestOutcome = await loadEnvelope(capture, findByMethod(exchanges, "eth_blockNumber"), "eth_blockNumber");
  if (latestOutcome.kind === "missing") return { ok: false, reason: latestOutcome.reason };
  if (latestOutcome.kind === "error") return { ok: false, reason: "rpc rejected eth_blockNumber" };

  const blockOutcome = await loadEnvelope(capture, blockCall, "eth_getBlockByNumber(confirmations)");
  if (blockOutcome.kind === "missing") return { ok: false, reason: blockOutcome.reason };
  if (blockOutcome.kind === "error") return { ok: false, reason: "rpc rejected eth_getBlockByNumber" };

  const hash = blockResultHash(blockOutcome.value);
  const number = blockResultNumber(blockOutcome.value);
  if (hash === null || number === null) return { ok: false, reason: "finalized block has no hash" };
  return { ok: true, number, hash, finalityLabel: `confirmations-${confirmations}` };
}

/**
 * Reconstruct §2.2 point 3's finalized-view decision purely from the captured exchanges and
 * `config.pin.finality` (the same object both the live capture and this replay were given —
 * it never needs to be re-derived from the index). Mode "tag": look for the exchange that
 * asked for `finality.tag`; if it decoded to a real block with a hash, that block is final.
 * Otherwise (the RPC rejected the tag, or answered with `null`/a hash-less block) fall back to
 * `finality.fallbackConfirmations` when configured, else fail closed — exactly the branch
 * `verifyLockFinal`'s live path takes, replayed from disk. Mode "confirmations": always the
 * numbered read.
 */
async function resolveFinalizedBlock(
  config: EvmRailConfig,
  capture: EvmCapture,
): Promise<FinalizedBlock | FinalizedBlockFailure> {
  const exchanges = capture.index.exchanges;
  const finality = config.pin.finality;

  if (finality.mode === "confirmations") {
    return readNumberedBlock(capture, exchanges, finality.confirmations, findByMethod(exchanges, "eth_getBlockByNumber"));
  }

  const blockCalls = exchanges.filter((exchange) => exchange.method === "eth_getBlockByNumber");
  const tagCall =
    blockCalls.find((exchange) => Array.isArray(exchange.params) && exchange.params[0] === finality.tag) ?? null;
  const tagOutcome = await loadEnvelope(capture, tagCall, `eth_getBlockByNumber(${finality.tag})`);

  if (tagOutcome.kind === "missing") return { ok: false, reason: tagOutcome.reason };
  if (tagOutcome.kind === "result") {
    const hash = blockResultHash(tagOutcome.value);
    const number = blockResultNumber(tagOutcome.value);
    if (hash !== null && number !== null) return { ok: true, number, hash, finalityLabel: "finalized" };
  }

  if (finality.fallbackConfirmations === undefined) {
    return { ok: false, reason: "rpc lacks the finalized tag and no fallbackConfirmations is configured" };
  }
  const fallbackCall = blockCalls.find((exchange) => exchange !== tagCall) ?? null;
  return readNumberedBlock(capture, exchanges, finality.fallbackConfirmations, fallbackCall);
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
 * Turn one captured `locks(hashLock)` read into evidence for `terms`. See P22-P24-EVM-SPEC.md
 * §2.2 point 3 for the branch table this implements verbatim (finalized view → decode →
 * status None/Claimed/Refunded/Locked → the Locked branch's field-by-field compare).
 */
export async function evmEvidence(input: EvmEvidenceInput): Promise<EvmEvidenceResult> {
  const { terms, config, accounts, capture, checkedAtMs } = input;
  const raw = capture.index.exchanges.map((exchange) => exchange.responseSha256);
  const base = {
    rail: EVM_RAIL_ID,
    ref: capture.index.hashLock,
    terms,
    checkedAtMs,
    endpoint: config.endpoint,
    raw,
  };

  if (
    terms.lock !== "hash" ||
    !HASH_LOCK_SHAPE.test(capture.index.hashLock) ||
    capture.index.hashLock !== terms.statement
  ) {
    return {
      lock: {
        ...base,
        railVerified: false,
        reason: 'evm-htlc: ref/lock mismatch (ref must equal terms.statement and lock must be "hash")',
      },
    };
  }

  const chainIdOutcome = await loadEnvelope(capture, findByMethod(capture.index.exchanges, "eth_chainId"), "eth_chainId");
  if (chainIdOutcome.kind === "missing") {
    return { lock: { ...base, railVerified: null, reason: chainIdOutcome.reason } };
  }
  if (chainIdOutcome.kind === "error") {
    return { lock: { ...base, railVerified: null, reason: "rpc rejected eth_chainId" } };
  }
  const chainId = hexToNumber(chainIdOutcome.value as Hex);
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

  const finalized = await resolveFinalizedBlock(config, capture);
  if (!finalized.ok) {
    return { lock: { ...base, railVerified: null, reason: finalized.reason } };
  }

  const callOutcome = await loadEnvelope(capture, findByMethod(capture.index.exchanges, "eth_call"), "eth_call");
  if (callOutcome.kind === "missing") {
    return { lock: { ...base, railVerified: null, reason: callOutcome.reason } };
  }
  if (callOutcome.kind === "error") {
    return { lock: { ...base, railVerified: null, reason: "rpc rejected eth_call locks(hashLock)" } };
  }

  let decoded: unknown;
  try {
    decoded = decodeFunctionResult({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", data: callOutcome.value as Hex });
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
 * `EvmCapture.load`). Never throws for a rejected finalized tag (falls back or gives up per
 * config, still returning whatever it captured) — only a genuine transport failure (the node
 * unreachable) propagates, since there is nothing this function could paper over for that.
 */
export async function captureEvmLeg(
  rpc: CapturingRpc,
  config: EvmRailConfig,
  hashLock: string,
  nowMs: number,
): Promise<{ index: EvmCaptureIndex; exchanges: Exchange[] }> {
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
