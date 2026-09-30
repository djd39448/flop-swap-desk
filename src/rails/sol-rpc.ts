// SPDX-License-Identifier: MIT
//
// A thin typed client for Solana's JSON-RPC surface, built directly on `CapturingRpc` (rpc-capture.ts,
// unchanged for Solana: Solana's RPC is plain JSON-RPC 2.0, so the byte-exact capture, request-id
// namespacing, timeout and byte cap all apply as they do for the other rails). `SolRpc` adds no wire
// behaviour; it types the handful of methods this leg calls and turns Solana's structured error data into
// typed errors a caller can `instanceof` (NEAR H4's rule: never parse prose when a structured field
// exists):
//
//   - a JSON-RPC-level error is an `RpcCaptureError` carrying `code`, `message` and the response's `data`
//     (`error.errorData`); the code (-32002 preflight/simulation failure, -32005 node unhealthy, -32004/
//     -32007/-32009 block or slot unavailable, -32016 minimum context slot not reached) and `data.err` (the
//     runtime's transaction error, for example `"BlockhashNotFound"` or `{InstructionError: [0, {Custom: 5}]}`)
//     select the typed error;
//   - a transport failure (timeout, refused connection, malformed JSON, an over-cap response) is NEVER
//     folded into a Solana-specific "absent" answer. A timeout or network error is rethrown unchanged (it is
//     a failure, not a verdict); an over-cap response becomes `SolResponseTooLargeError`;
//   - a `null` result where Solana uses it for "not found" (`getAccountInfo` value, `getTransaction`,
//     `getSignatureStatuses` entries) is returned as `null` and means exactly that; it is never conflated
//     with an error.
//
// Facts this was written against are in handoff/research/sol-probe/README.md (getVersion, getGenesisHash,
// finalized lagging processed by about 31 slots, block-time behaviour). `requestAirdrop` exists for the
// local harness only (a faucet exists on a local validator and nowhere this desk runs for value).

import { base64 } from "@scure/base";

import { RpcCaptureError, CapturingRpc } from "./rpc-capture.js";
import { decodeTransaction, type SolTransaction } from "./sol-tx.js";

export type SolCommitment = "processed" | "confirmed" | "finalized";

/** The response byte cap SolRpc users should build their `CapturingRpc` with. A reviewed program's
 *  ProgramData account (base64) is the largest read this leg makes; 4 MiB is comfortably above it. */
export const SOL_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class SolRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "SolRpcError";
    this.code = code;
    this.data = data;
  }
}

/** -32005: the node says it is behind or unhealthy; its answers must not be trusted. */
export class SolNodeUnhealthyError extends SolRpcError {
  constructor(message: string, code: number, data?: unknown) {
    super(message, code, data);
    this.name = "SolNodeUnhealthyError";
  }
}

/** -32004 / -32007 / -32009: the requested block or slot is not available (skipped, or not yet there). */
export class SolBlockNotAvailableError extends SolRpcError {
  constructor(message: string, code: number, data?: unknown) {
    super(message, code, data);
    this.name = "SolBlockNotAvailableError";
  }
}

/** -32016: the node has not reached the `minContextSlot` this read demanded. Retry later. */
export class SolMinContextSlotError extends SolRpcError {
  readonly contextSlot: number | null;
  constructor(message: string, code: number, data?: unknown) {
    super(message, code, data);
    this.name = "SolMinContextSlotError";
    const slot = (data as { contextSlot?: unknown } | null | undefined)?.contextSlot;
    this.contextSlot = typeof slot === "number" ? slot : null;
  }
}

/** The runtime refused (or would refuse) the transaction: a simulation whose `err` is set, or a send
 *  whose preflight simulation failed (-32002). Nothing was broadcast by a preflight refusal. */
export class SolSimulationFailedError extends SolRpcError {
  readonly phase: "simulate" | "preflight";
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | null;
  constructor(input: { phase: "simulate" | "preflight"; err: unknown; logs: readonly string[]; unitsConsumed: number | null; code: number; message?: string }) {
    super(input.message ?? `sol-rpc: ${input.phase} failed: ${JSON.stringify(input.err)}`, input.code, { err: input.err });
    this.name = "SolSimulationFailedError";
    this.phase = input.phase;
    this.err = input.err;
    this.logs = input.logs;
    this.unitsConsumed = input.unitsConsumed;
  }
}

/** The transaction's blockhash is not known to the node (expired or never seen). Nothing was broadcast. */
export class SolBlockhashNotFoundError extends SolSimulationFailedError {
  constructor(input: { phase: "simulate" | "preflight"; logs: readonly string[]; unitsConsumed: number | null; code: number }) {
    super({ ...input, err: "BlockhashNotFound", message: "sol-rpc: blockhash not found (expired or unknown to this node)" });
    this.name = "SolBlockhashNotFoundError";
  }
}

/** A response exceeded the capture cap; nothing was recorded or trusted. */
export class SolResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolResponseTooLargeError";
  }
}

/** `{InstructionError: [index, {Custom: n}]}` -> `n`, else `null`. */
export function programErrorCode(err: unknown): number | null {
  if (err === null || typeof err !== "object") return null;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2) return null;
  const detail = ie[1] as { Custom?: unknown } | string;
  if (detail !== null && typeof detail === "object" && typeof detail.Custom === "number") return detail.Custom;
  return null;
}

function structuredErr(data: unknown): { err: unknown; logs: readonly string[]; unitsConsumed: number | null } {
  const d = (data ?? {}) as { err?: unknown; logs?: unknown; unitsConsumed?: unknown };
  return {
    err: d.err ?? null,
    logs: Array.isArray(d.logs) ? (d.logs as unknown[]).filter((l): l is string => typeof l === "string") : [],
    unitsConsumed: typeof d.unitsConsumed === "number" ? d.unitsConsumed : null,
  };
}

/** Maps an `RpcCaptureError` (a JSON-RPC-level error reply) onto the most specific typed error; rethrows
 *  anything else (transport failures) unchanged, except the capture cap, which becomes typed. */
function mapSolRpcError(error: unknown): never {
  if (error instanceof RpcCaptureError) {
    const { code, message } = error;
    const data = error.errorData;
    if (code === -32002) {
      const s = structuredErr(data);
      if (s.err === "BlockhashNotFound") throw new SolBlockhashNotFoundError({ phase: "preflight", logs: s.logs, unitsConsumed: s.unitsConsumed, code });
      throw new SolSimulationFailedError({ phase: "preflight", err: s.err, logs: s.logs, unitsConsumed: s.unitsConsumed, code, message });
    }
    if (code === -32005) throw new SolNodeUnhealthyError(message, code, data);
    if (code === -32004 || code === -32007 || code === -32009) throw new SolBlockNotAvailableError(message, code, data);
    if (code === -32016) throw new SolMinContextSlotError(message, code, data);
    throw new SolRpcError(message, code, data);
  }
  if (error instanceof Error && /exceeding maxResponseBytes/.test(error.message)) {
    throw new SolResponseTooLargeError(error.message);
  }
  throw error;
}

// --- result shapes --------------------------------------------------------------------------------------------

export interface SolAccountInfo {
  /** `lamports` is a JSON number on the wire; values above 2^53 (a faucet account) lose precision, which
   *  nothing here depends on. */
  lamports: number;
  /** base58 owner program. */
  owner: string;
  data: Uint8Array;
  executable: boolean;
}

export interface SolSignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: SolCommitment | null;
}

export interface SolSignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

export interface SolFetchedTransaction {
  slot: number;
  blockTime: number | null;
  /** The transaction's own `meta.err` (null when it executed successfully). */
  err: unknown;
  /** Strictly decoded from the wire bytes; `null` when the transaction is not a legacy one this codec can
   *  read (for example a v0 transaction), which callers treat as "not ours". */
  transaction: SolTransaction | null;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`sol-rpc: ${what} is not an object`);
  return value as Record<string, unknown>;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`sol-rpc: ${what} is not a number`);
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`sol-rpc: ${what} is not a string`);
  return value;
}

function contextSlot(raw: Record<string, unknown>): number {
  return num(record(raw.context, "context").slot, "context.slot");
}

function decodeAccount(value: unknown): SolAccountInfo | null {
  if (value === null) return null;
  const a = record(value, "account");
  const data = a.data;
  if (!Array.isArray(data) || typeof data[0] !== "string" || data[1] !== "base64") throw new Error("sol-rpc: account data is not [base64, \"base64\"]");
  return {
    lamports: num(a.lamports, "account.lamports"),
    owner: str(a.owner, "account.owner"),
    data: base64.decode(data[0]),
    executable: a.executable === true,
  };
}

export interface SolReadOptions {
  commitment?: SolCommitment;
  minContextSlot?: number;
}

function readConfig(options: SolReadOptions): Record<string, unknown> {
  return {
    encoding: "base64",
    ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
    ...(options.minContextSlot === undefined ? {} : { minContextSlot: options.minContextSlot }),
  };
}

/**
 * Every method is one `CapturingRpc.request()` (so one captured `Exchange`), typed and shape-checked.
 * Build it over the SAME `CapturingRpc` a caller reads `.exchanges()` from.
 */
export class SolRpc {
  private readonly rpc: CapturingRpc;

  constructor(rpc: CapturingRpc) {
    this.rpc = rpc;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    try {
      return await this.rpc.request({ method, params });
    } catch (error) {
      mapSolRpcError(error);
    }
  }

  async getVersion(): Promise<{ solanaCore: string; featureSet: number | null }> {
    const raw = record(await this.call("getVersion", []), "getVersion result");
    return { solanaCore: str(raw["solana-core"], "solana-core"), featureSet: typeof raw["feature-set"] === "number" ? raw["feature-set"] : null };
  }

  async getGenesisHash(): Promise<string> {
    return str(await this.call("getGenesisHash", []), "getGenesisHash result");
  }

  async getSlot(commitment: SolCommitment): Promise<number> {
    return num(await this.call("getSlot", [{ commitment }]), "getSlot result");
  }

  async getBlockHeight(commitment: SolCommitment): Promise<number> {
    return num(await this.call("getBlockHeight", [{ commitment }]), "getBlockHeight result");
  }

  /** Unix seconds of the block at `slot`, or `null` when the node has no time for it. */
  async getBlockTime(slot: number): Promise<number | null> {
    const result = await this.call("getBlockTime", [slot]);
    if (result === null) return null;
    return num(result, "getBlockTime result");
  }

  async getLatestBlockhash(commitment: SolCommitment): Promise<{ blockhash: string; lastValidBlockHeight: number; contextSlot: number }> {
    const raw = record(await this.call("getLatestBlockhash", [{ commitment }]), "getLatestBlockhash result");
    const value = record(raw.value, "getLatestBlockhash value");
    return { blockhash: str(value.blockhash, "blockhash"), lastValidBlockHeight: num(value.lastValidBlockHeight, "lastValidBlockHeight"), contextSlot: contextSlot(raw) };
  }

  async getAccountInfo(pubkey: string, options: SolReadOptions = {}): Promise<{ contextSlot: number; account: SolAccountInfo | null }> {
    const raw = record(await this.call("getAccountInfo", [pubkey, readConfig(options)]), "getAccountInfo result");
    return { contextSlot: contextSlot(raw), account: decodeAccount(raw.value) };
  }

  /** All accounts are read at ONE context slot (one call), which is what a consistent evidence read needs. */
  async getMultipleAccounts(pubkeys: readonly string[], options: SolReadOptions = {}): Promise<{ contextSlot: number; accounts: (SolAccountInfo | null)[] }> {
    const raw = record(await this.call("getMultipleAccounts", [pubkeys, readConfig(options)]), "getMultipleAccounts result");
    if (!Array.isArray(raw.value) || raw.value.length !== pubkeys.length) throw new Error("sol-rpc: getMultipleAccounts returned the wrong number of accounts");
    return { contextSlot: contextSlot(raw), accounts: (raw.value as unknown[]).map(decodeAccount) };
  }

  /** Returns the simulation outcome; a set `err` is a RESULT here (the caller decides), not a throw. A
   *  JSON-RPC error reply (for example an unknown blockhash) still throws typed. */
  async simulateTransaction(
    txBytes: Uint8Array,
    options: { commitment?: SolCommitment; sigVerify?: boolean; replaceRecentBlockhash?: boolean } = {},
  ): Promise<{ contextSlot: number; err: unknown; logs: readonly string[]; unitsConsumed: number | null }> {
    const config: Record<string, unknown> = { encoding: "base64", sigVerify: options.sigVerify ?? true };
    if (options.commitment !== undefined) config.commitment = options.commitment;
    if (options.replaceRecentBlockhash === true) config.replaceRecentBlockhash = true;
    const raw = record(await this.call("simulateTransaction", [base64.encode(txBytes), config]), "simulateTransaction result");
    const value = record(raw.value, "simulateTransaction value");
    const s = structuredErr(value);
    return { contextSlot: contextSlot(raw), err: value.err ?? null, logs: s.logs, unitsConsumed: s.unitsConsumed };
  }

  /** Sends with the node's preflight simulation ON unless `skipPreflight` is set. Returns the signature the
   *  node reports (the caller compares it with the signature it computed before sending). */
  async sendTransaction(txBytes: Uint8Array, options: { preflightCommitment?: SolCommitment; skipPreflight?: boolean } = {}): Promise<string> {
    const config: Record<string, unknown> = { encoding: "base64", skipPreflight: options.skipPreflight === true };
    if (options.preflightCommitment !== undefined) config.preflightCommitment = options.preflightCommitment;
    return str(await this.call("sendTransaction", [base64.encode(txBytes), config]), "sendTransaction result");
  }

  /** One entry per signature; `null` means the node has no status for it (searching history included). */
  async getSignatureStatuses(signatures: readonly string[]): Promise<(SolSignatureStatus | null)[]> {
    const raw = record(await this.call("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]), "getSignatureStatuses result");
    if (!Array.isArray(raw.value) || raw.value.length !== signatures.length) throw new Error("sol-rpc: getSignatureStatuses returned the wrong number of entries");
    return (raw.value as unknown[]).map((entry) => {
      if (entry === null) return null;
      const s = record(entry, "signature status");
      const cs = s.confirmationStatus;
      if (cs !== null && cs !== undefined && cs !== "processed" && cs !== "confirmed" && cs !== "finalized") throw new Error("sol-rpc: unknown confirmationStatus");
      return {
        slot: num(s.slot, "status.slot"),
        confirmations: typeof s.confirmations === "number" ? s.confirmations : null,
        err: s.err ?? null,
        confirmationStatus: (cs ?? null) as SolCommitment | null,
      };
    });
  }

  /** `null` when the node has no such transaction at that commitment. */
  async getTransaction(signature: string, commitment: SolCommitment): Promise<SolFetchedTransaction | null> {
    const result = await this.call("getTransaction", [signature, { encoding: "base64", commitment, maxSupportedTransactionVersion: 0 }]);
    if (result === null) return null;
    const raw = record(result, "getTransaction result");
    const tx = raw.transaction;
    if (!Array.isArray(tx) || typeof tx[0] !== "string" || tx[1] !== "base64") throw new Error("sol-rpc: transaction is not [base64, \"base64\"]");
    const meta = record(raw.meta, "getTransaction meta");
    let transaction: SolTransaction | null;
    try {
      transaction = decodeTransaction(base64.decode(tx[0]));
    } catch {
      transaction = null;
    }
    return { slot: num(raw.slot, "transaction.slot"), blockTime: typeof raw.blockTime === "number" ? raw.blockTime : null, err: meta.err ?? null, transaction };
  }

  /** Newest first. `before` pages backwards. Includes failed transactions (their `err` is set). */
  async getSignaturesForAddress(address: string, options: { commitment: SolCommitment; limit?: number; before?: string }): Promise<SolSignatureInfo[]> {
    const config: Record<string, unknown> = { commitment: options.commitment };
    if (options.limit !== undefined) config.limit = options.limit;
    if (options.before !== undefined) config.before = options.before;
    const result = await this.call("getSignaturesForAddress", [address, config]);
    if (!Array.isArray(result)) throw new Error("sol-rpc: getSignaturesForAddress did not return an array");
    return (result as unknown[]).map((entry) => {
      const e = record(entry, "signature info");
      return { signature: str(e.signature, "signature"), slot: num(e.slot, "slot"), err: e.err ?? null, blockTime: typeof e.blockTime === "number" ? e.blockTime : null };
    });
  }

  /** LOCAL HARNESS ONLY: the validator faucet. Returns the airdrop transaction's signature. */
  async requestAirdrop(pubkey: string, lamports: number): Promise<string> {
    return str(await this.call("requestAirdrop", [pubkey, lamports]), "requestAirdrop result");
  }
}
