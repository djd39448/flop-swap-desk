// SPDX-License-Identifier: MIT
//
// Byte-exact JSON-RPC capture for the EVM rails (P22-P24-EVM-SPEC.md §2.1). `CapturingRpc` is
// an EIP-1193-shaped client (`{ request({ method, params }) }`) so it can be handed straight to
// viem's `custom()` transport — every read AND write a `PublicClient`/`WalletClient` built on
// top of it makes (including `eth_sendTransaction` and receipt polling) goes through here and
// is recorded. Recording the request/response BYTES (not the parsed values) is the point: a
// later reader must be able to re-hash the exact bytes a verdict rested on, the same way this
// repo's tclk export capture already treats a `/kv` note or a deal-room body as anonymous input
// until its own hash is re-checked (see `readCapture` below, and `src/watcher.ts`'s
// `writeFileAtomic`, whose atomic-rename pattern this mirrors for `raw/rpc/<sha256>.json`).
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §2.1.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** One request/response round trip, byte-exact. `atMs` is the injected clock's reading taken
 *  when the request was issued — never `Date.now()` directly (house rule: no clock in a
 *  function that isn't explicitly given one). */
export interface Exchange {
  method: string;
  params: unknown;
  requestBody: string;
  responseBody: string;
  /** Lowercase hex sha256 of `responseBody`'s exact bytes — the name `writeCapture` gives the
   *  file it writes, and the value `readCapture` re-derives to catch tampering. */
  responseSha256: string;
  atMs: number;
}

/** What `CapturingRpc` exposes beyond the EIP-1193 `request` method: the exchanges it has
 *  recorded so far. `exchanges()` peeks (never clears); `drain()` takes and clears — a caller
 *  that wants "everything this operation produced" calls `drain()` once when the operation is
 *  done, so a later, unrelated call on the same instance starts from an empty log. */
export interface CaptureSink {
  exchanges(): readonly Exchange[];
  drain(): Exchange[];
}

/** Carries a JSON-RPC error's own `code`/`message` (per §2.1: "throws an error carrying the
 *  JSON-RPC code/message") instead of collapsing it into a generic `Error`. */
export class RpcCaptureError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcCaptureError";
    this.code = code;
  }
}

export interface CapturingRpcOptions {
  endpoint: string;
  /** Defaults to the global `fetch`. Injected so tests never touch the network. */
  fetch?: typeof fetch;
  /** Defaults to `Date.now`. Injected per the house rule: no clock in an untested corner. */
  clock?: () => number;
}

/**
 * An EIP-1193-shaped client (`{ request(...) }`) over one JSON-RPC `endpoint`. Every call is
 * exactly one HTTP exchange: it serialises its own JSON-RPC 2.0 request body (an incrementing
 * `id`; keeps the exact bytes it sent as `requestBody`), POSTs it, reads the response as
 * **text** (never `.json()` — the exact bytes are what a later audit re-hashes), records the
 * exchange, then parses that text once to return `result` or throw a `RpcCaptureError` carrying
 * the response's own `code`/`message`. A response that is not valid JSON at all is recorded
 * (the caller can still inspect it) but still fails the call — there is nothing to return.
 *
 * Use as viem's transport via `custom(capturingRpc)`, so every read AND write a `PublicClient`
 * / `WalletClient` built on it makes is captured, not just the ones this module calls directly.
 */
export class CapturingRpc implements CaptureSink {
  readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly log: Exchange[] = [];
  private nextId = 1;

  constructor(options: CapturingRpcOptions) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const requestBody = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? [] });
    const atMs = this.clock();

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    const responseBody = await response.text();
    const responseSha256 = bytesToHex(sha256(new TextEncoder().encode(responseBody)));
    this.log.push({ method, params: params ?? [], requestBody, responseBody, responseSha256, atMs });

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      throw new Error(`rpc-capture: response for ${method} is not valid JSON (endpoint ${this.endpoint})`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`rpc-capture: response for ${method} is not a JSON-RPC object`);
    }
    const envelope = parsed as { result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (envelope.error !== undefined && envelope.error !== null) {
      const code = typeof envelope.error.code === "number" ? envelope.error.code : -32603;
      const message = typeof envelope.error.message === "string" ? envelope.error.message : "rpc error";
      throw new RpcCaptureError(code, message);
    }
    return envelope.result;
  }

  exchanges(): readonly Exchange[] {
    return [...this.log];
  }

  drain(): Exchange[] {
    return this.log.splice(0, this.log.length);
  }
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Where `writeCapture`/`readCapture` keep one exchange's response bytes under a watch root. */
function rawRpcPath(root: string, sha256Hex: string): string {
  return join(root, "raw", "rpc", `${sha256Hex}.json`);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Write each exchange's `responseBody` byte-exact to `raw/rpc/<responseSha256>.json`. The name
 * is the content's own hash, so two callers writing the same exchange twice (or the same
 * exchange re-captured on a later sweep) produce the identical file — idempotent by
 * construction. Skips a path that is already on disk rather than re-writing it, since its
 * content is fully determined by its own name.
 */
export async function writeCapture(root: string, exchanges: readonly Exchange[]): Promise<void> {
  for (const exchange of exchanges) {
    const path = rawRpcPath(root, exchange.responseSha256);
    let alreadyThere: string | null;
    try {
      alreadyThere = await readFile(path, "utf8");
    } catch {
      alreadyThere = null;
    }
    if (alreadyThere === exchange.responseBody) continue;
    await writeFileAtomic(path, exchange.responseBody);
  }
}

/**
 * Read `raw/rpc/<sha256>.json` and re-hash it. `null` on a missing file OR a hash mismatch
 * (tampering, truncation, a caller passing a hash that never came from `writeCapture`) — the
 * caller (`src/rails/evm-evidence.ts`'s `evmEvidence`) turns either into fail-closed evidence,
 * never a thrown exception; this file is anonymous input from disk, same trust level as a
 * `/kv` note. A malformed `sha256Hex` (not 64 lowercase hex chars) is refused before touching
 * the filesystem at all, so a hostile or corrupted index can never walk this out of `root`.
 */
export async function readCapture(root: string, sha256Hex: string): Promise<string | null> {
  if (!SHA256_HEX.test(sha256Hex)) return null;
  let body: string;
  try {
    body = await readFile(rawRpcPath(root, sha256Hex), "utf8");
  } catch {
    return null;
  }
  const actual = bytesToHex(sha256(new TextEncoder().encode(body)));
  return actual === sha256Hex ? body : null;
}
