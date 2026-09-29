// SPDX-License-Identifier: MIT
//
// A thin JSON-RPC 2.0 client over NEAR's own RPC surface, built directly on `CapturingRpc`
// (P5-NEAR-SPEC.md §4) — the same byte-exact capture, request-id namespacing, `RpcCaptureError`
// and bounded (timeout-guarded) reads this repo's Bitcoin and EVM adapters already get from
// `rpc-capture.ts`, entirely unchanged: the mirror map's own finding is that file needs zero
// changes for NEAR (near-sandbox's own RPC is JSON-RPC 2.0-shaped like every other rail here).
// `NearRpc` adds nothing of its own on the wire; it only gives `near-htlc.ts` typed helpers for
// the handful of RPC methods this leg calls, and maps NEAR's own error shapes into typed errors
// a caller can `instanceof`-check instead of parsing prose:
//
//   - a JSON-RPC-level error (`UNKNOWN_TRANSACTION`, `InvalidNonce`, an expired transaction) —
//     `CapturingRpc` itself already turns this into an `RpcCaptureError` carrying the response's
//     own `code`/`message`; this module maps that `message` onto the most specific typed error it
//     names. NEAR's own structured `error.data` cause (e.g. `{name: "HANDLER_ERROR", cause:
//     {name: "UNKNOWN_TRANSACTION", ...}}`) is NOT visible past `CapturingRpc`'s own generic
//     `{code, message}` contract — deliberately: `rpc-capture.ts` is shared/chain-agnostic and
//     this build never edits it for one rail's convenience — so this maps on `message` content,
//     the only field an `RpcCaptureError` carries. A later NB-int sandbox run is what confirms
//     these substrings against real, live responses (a probe-stage caveat noted throughout the
//     handoff for anything this build cannot yet verify against a live chain).
//   - a view `call_function`'s own contract panic — NEAR reports this INSIDE a normal (HTTP 200,
//     no JSON-RPC-level `error` at all) `query` result, as `result.error` (P5-NEAR-SPEC.md §4:
//     "function-call panic in query"). Mapped to `NearFunctionCallPanicError`, kept deliberately
//     distinct from `NearRpcError` so catching one can never accidentally also catch the other.
//
// Design source: flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md D-N1/D-N4/D-N10;
// flop-contrib/handoff/P5-NEAR-SPEC.md §4;
// flop-contrib/handoff/research/near-rpc-and-signing-2026-09-29.md.

import { RpcCaptureError, type CapturingRpc } from "./rpc-capture.js";

export type NearFinality = "final" | "optimistic";
export type NearBlockRef = { finality: NearFinality } | { blockId: number | string };

function refParams(ref: NearBlockRef): Record<string, unknown> {
  return "finality" in ref ? { finality: ref.finality } : { block_id: ref.blockId };
}

/** Base class for every typed NEAR RPC error this module recognises. See the file header for why
 *  this can only ever carry the `code`/`message` an `RpcCaptureError` itself carries — never
 *  NEAR's own structured `error.data` cause. */
export class NearRpcError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "NearRpcError";
    this.code = code;
  }
}
export class NearUnknownTransactionError extends NearRpcError {
  constructor(message: string, code: number) {
    super(message, code);
    this.name = "NearUnknownTransactionError";
  }
}
export class NearInvalidNonceError extends NearRpcError {
  constructor(message: string, code: number) {
    super(message, code);
    this.name = "NearInvalidNonceError";
  }
}
export class NearExpiredTransactionError extends NearRpcError {
  constructor(message: string, code: number) {
    super(message, code);
    this.name = "NearExpiredTransactionError";
  }
}

/** A view `call_function`'s own contract panic — see the file header. Never thrown for a
 *  transport-level failure or a JSON-RPC-level error; only for a successful RPC response whose
 *  `result.error` names a contract-side panic. */
export class NearFunctionCallPanicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearFunctionCallPanicError";
  }
}

/** Wraps an `RpcCaptureError` into the most specific typed error its own `message` names, or a
 *  bare `NearRpcError` when none match. Any OTHER thrown value (a timeout, a network failure, a
 *  malformed-JSON error `CapturingRpc` itself throws) is rethrown completely unchanged — never
 *  folded into a NEAR-specific type it did not actually name. */
function mapNearRpcError(error: unknown): never {
  if (error instanceof RpcCaptureError) {
    const msg = error.message;
    // NB-int (stage this comment was confirmed live, against near-sandbox 2.13.4): `tx`/
    // `EXPERIMENTAL_tx_status` for a genuinely unknown transaction hash does NOT answer quickly
    // with a named "not found" error the way `query`'s view-call errors do — it long-polls
    // waiting for the transaction to appear, then answers `{"code":-32000,"error":{"name":
    // "HANDLER_ERROR","cause":{"name":"TIMEOUT_ERROR"}},"message":"Server error","data":
    // "Timeout"}` once its own internal wait expires. `RpcCaptureError` only ever carries
    // `code`/`message` (see this file's own header: `data`/`cause` are not visible past
    // `rpc-capture.ts`'s generic contract, which this build never edits for one rail's
    // convenience), so `code === -32000` combined with the generic `"Server error"` message is
    // the only signal available here — confirmed empirically to be this method's own "I don't
    // know about this transaction" answer, not a transport failure (a genuinely unreachable node
    // fails `fetch` itself, never reaches this branch at all).
    if (/UNKNOWN_TRANSACTION/i.test(msg) || /doesn'?t exist/i.test(msg) || (error.code === -32000 && /^server error$/i.test(msg))) {
      throw new NearUnknownTransactionError(msg, error.code);
    }
    if (/InvalidNonce/i.test(msg)) throw new NearInvalidNonceError(msg, error.code);
    if (/expired/i.test(msg)) throw new NearExpiredTransactionError(msg, error.code);
    throw new NearRpcError(msg, error.code);
  }
  throw error;
}

export interface NearStatusResult {
  chainId: string;
  protocolVersion: number;
  raw: Record<string, unknown>;
}

export interface NearBlockHeader {
  height: number;
  hash: string;
  /** `header.timestamp_nanosec`, kept as the RPC's own decimal STRING — a nanosecond timestamp
   *  cannot round-trip exactly through a JS `number`; `near-htlc.ts`'s `chainTimeMs()` does the
   *  ns→ms conversion itself, in `bigint`. */
  timestampNs: string;
}

export interface NearBlockResult {
  header: NearBlockHeader;
  raw: Record<string, unknown>;
}

export interface NearAccountView {
  amount: string;
  codeHash: string;
  blockHeight: number;
  blockHash: string;
  raw: Record<string, unknown>;
}

export interface NearAccessKeyView {
  nonce: number;
  permission: unknown;
  blockHeight: number;
  blockHash: string;
  raw: Record<string, unknown>;
}

export interface NearCallFunctionResult {
  /** The decoded UTF-8 text of the RPC's own `result` (a `u8[]`) — NEAR view calls conventionally
   *  return JSON-encoded bytes, but this module leaves parsing that JSON to the caller (each
   *  method's own return shape is the caller's, i.e. `near-htlc.ts`'s, business, not this thin
   *  client's). */
  resultText: string;
  resultBytes: Uint8Array;
  logs: readonly string[];
  blockHeight: number;
  blockHash: string;
}

export interface NearTxOutcome {
  status: unknown;
  transactionOutcome: { blockHash: string; id: string };
  raw: Record<string, unknown>;
}

export type NearWaitUntil = "NONE" | "INCLUDED" | "EXECUTED_OPTIMISTIC" | "INCLUDED_FINAL" | "EXECUTED" | "FINAL";

function decodeOutcome(raw: Record<string, unknown>): NearTxOutcome {
  const outcome = raw.transaction_outcome as Record<string, unknown> | undefined;
  if (outcome === undefined || typeof outcome.block_hash !== "string" || typeof outcome.id !== "string") {
    throw new Error("near-rpc: outcome is missing transaction_outcome.block_hash/id");
  }
  return { status: raw.status, transactionOutcome: { blockHash: outcome.block_hash, id: outcome.id }, raw };
}

/**
 * Every method here is one `CapturingRpc.request()` call (so one captured `Exchange`), typed and
 * with a bit of shape validation on the way out — never its own HTTP, never its own JSON-RPC
 * framing. Construct with the SAME `CapturingRpc` instance a caller also reads `.exchanges()`/
 * `.drain()`/`.setIdNamespace()` on (`near-htlc.ts` does exactly this), so every call this class
 * makes shows up in that same capture log.
 */
export class NearRpc {
  private readonly rpc: CapturingRpc;

  constructor(rpc: CapturingRpc) {
    this.rpc = rpc;
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    try {
      return (await this.rpc.request({ method, params })) as T;
    } catch (error) {
      mapNearRpcError(error);
    }
  }

  async status(): Promise<NearStatusResult> {
    const raw = await this.call<Record<string, unknown>>("status", []);
    if (typeof raw.chain_id !== "string" || typeof raw.protocol_version !== "number") {
      throw new Error("near-rpc: status did not return a usable chain_id/protocol_version");
    }
    return { chainId: raw.chain_id, protocolVersion: raw.protocol_version, raw };
  }

  async block(ref: NearBlockRef): Promise<NearBlockResult> {
    const raw = await this.call<Record<string, unknown>>("block", refParams(ref));
    const header = raw.header as Record<string, unknown> | undefined;
    if (
      header === undefined ||
      typeof header.height !== "number" ||
      typeof header.hash !== "string" ||
      typeof header.timestamp_nanosec !== "string"
    ) {
      throw new Error("near-rpc: block did not return a usable header (height/hash/timestamp_nanosec)");
    }
    return { header: { height: header.height, hash: header.hash, timestampNs: header.timestamp_nanosec }, raw };
  }

  async viewAccount(accountId: string, ref: NearBlockRef = { finality: "final" }): Promise<NearAccountView> {
    const raw = await this.call<Record<string, unknown>>("query", {
      request_type: "view_account",
      account_id: accountId,
      ...refParams(ref),
    });
    if (
      typeof raw.amount !== "string" ||
      typeof raw.code_hash !== "string" ||
      typeof raw.block_height !== "number" ||
      typeof raw.block_hash !== "string"
    ) {
      throw new Error(`near-rpc: view_account for "${accountId}" did not return a usable account view`);
    }
    return { amount: raw.amount, codeHash: raw.code_hash, blockHeight: raw.block_height, blockHash: raw.block_hash, raw };
  }

  async viewAccessKey(accountId: string, publicKey: string, ref: NearBlockRef = { finality: "final" }): Promise<NearAccessKeyView> {
    const raw = await this.call<Record<string, unknown>>("query", {
      request_type: "view_access_key",
      account_id: accountId,
      public_key: publicKey,
      ...refParams(ref),
    });
    if (typeof raw.nonce !== "number" || raw.permission === undefined || typeof raw.block_height !== "number" || typeof raw.block_hash !== "string") {
      throw new Error(`near-rpc: view_access_key for "${accountId}" did not return a usable access key view`);
    }
    return { nonce: raw.nonce, permission: raw.permission, blockHeight: raw.block_height, blockHash: raw.block_hash, raw };
  }

  /** `args` is JSON-serialised and base64-encoded here (`args_base64`) — the caller passes a
   *  plain JS value, never pre-encoded bytes. Throws `NearFunctionCallPanicError` when the
   *  (successful, HTTP-200) response itself carries `result.error` — see the file header. */
  async callFunction(accountId: string, methodName: string, args: unknown, ref: NearBlockRef = { finality: "final" }): Promise<NearCallFunctionResult> {
    const argsBase64 = Buffer.from(new TextEncoder().encode(JSON.stringify(args ?? {}))).toString("base64");
    const raw = await this.call<Record<string, unknown>>("query", {
      request_type: "call_function",
      account_id: accountId,
      method_name: methodName,
      args_base64: argsBase64,
      ...refParams(ref),
    });
    if (typeof raw.error === "string") {
      throw new NearFunctionCallPanicError(raw.error);
    }
    if (!Array.isArray(raw.result) || typeof raw.block_height !== "number" || typeof raw.block_hash !== "string") {
      throw new Error(`near-rpc: call_function ${accountId}.${methodName} did not return a usable result`);
    }
    const resultBytes = Uint8Array.from(raw.result as number[]);
    const resultText = new TextDecoder("utf-8").decode(resultBytes);
    const logs = Array.isArray(raw.logs) ? (raw.logs as string[]) : [];
    return { resultText, resultBytes, logs, blockHeight: raw.block_height, blockHash: raw.block_hash };
  }

  /** `send_tx` — the stable, non-EXPERIMENTAL broadcast method that accepts `wait_until`
   *  (D-N4/D-N9: this build always sends `"FINAL"`, so `commitLock`/`claim`/`refund` return
   *  evidence straight from this one call's own outcome). */
  async sendTx(signedTxBase64: string, waitUntil: NearWaitUntil = "FINAL"): Promise<NearTxOutcome> {
    const raw = await this.call<Record<string, unknown>>("send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil });
    return decodeOutcome(raw);
  }

  /** D-N4's lost-reply recovery path: `EXPERIMENTAL_tx_status`, classic array params
   *  (`[txHashBase58, senderAccountId]` — the same shape the plain `tx` method has always taken,
   *  still accepted alongside the newer object form). */
  async txStatus(txHashBase58: string, senderAccountId: string): Promise<NearTxOutcome> {
    const raw = await this.call<Record<string, unknown>>("EXPERIMENTAL_tx_status", [txHashBase58, senderAccountId]);
    return decodeOutcome(raw);
  }
}
