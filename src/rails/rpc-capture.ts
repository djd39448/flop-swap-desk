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
 *  function that isn't explicitly given one).
 *
 *  P22-P24-EVM-FIXES-R2.md D2: `responseBytes` is the exact wire bytes (what `responseSha256`
 *  is a hash of, what `writeCapture` writes, what `readCapture` re-derives) — the source of
 *  truth for every write/hash/equality operation from here on. `responseBody` is kept only as
 *  a convenience UTF-8 decode of those same bytes (lossy — `TextDecoder`'s replacement
 *  characters — for whatever isn't valid UTF-8) for a caller that wants a readable string (an
 *  error message, a quick `.includes()`); nothing that decides a verdict may compare or hash
 *  it, since a response with a UTF-8 BOM or a genuinely invalid byte would otherwise decode
 *  losslessly live but not survive a disk round trip through a JS string the same way (the
 *  live and replayed verdicts must never be able to diverge over exactly this). */
export interface Exchange {
  method: string;
  params: unknown;
  requestBody: string;
  responseBody: string;
  /** The exact response bytes — see the interface doc above. */
  responseBytes: Uint8Array;
  /** Lowercase hex sha256 of `responseBytes`'s exact bytes — the name `writeCapture` gives the
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
  /** P22-P24-EVM-FIXES.md A9: aborts a call that has not answered within this many ms, so one
   *  stalled/unreachable RPC endpoint can never hang a sweep forever. `undefined` (the
   *  default) never aborts on its own — a caller that wants this protection passes its own
   *  `timeoutMs` (`src/watcher.ts`'s sweep passes the same `timeoutMs` it uses for every other
   *  fetch). */
  timeoutMs?: number;
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
  private readonly timeoutMs: number | undefined;
  private readonly log: Exchange[] = [];
  private nextId = 1;
  private idNamespace: string | undefined;
  private namespaceCounter = 0;

  constructor(options: CapturingRpcOptions) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * P22-P24-EVM-FIXES-R2.md D1: from now until the next call, every id this instance mints is
   * `${namespace}:${n}` (`n` restarting at 1) instead of the bare auto-incrementing integer
   * `nextId` mints by default. A plain integer id is unique only *within one `CapturingRpc`
   * instance's own lifetime* — a fresh instance always restarts at 1 — so a genuine response
   * captured under one capture session (one hashLock/checkedAtMs, or a totally different
   * instance/process) could otherwise be spliced into a different capture's index and still
   * satisfy `evm-evidence.ts`'s `bindExchange` ("response id equals request id"), since two
   * unrelated captures can easily mint the exact same small integer. Binding every id to
   * something the *verifier* independently trusts (an evidence capture's own hashLock +
   * checkedAtMs — see `captureEvmLeg`) closes that gap: `bindExchange` additionally requires a
   * captured id to start with the capture it claims to belong to. Pass `undefined` to go back
   * to the bare integer sequence — every caller that never calls this (every test, and any
   * write that has no natural per-capture identity of its own) keeps today's behaviour exactly.
   */
  setIdNamespace(namespace: string | undefined): void {
    this.idNamespace = namespace;
    this.namespaceCounter = 0;
  }

  private mintId(): string | number {
    if (this.idNamespace === undefined) {
      const id = this.nextId;
      this.nextId += 1;
      return id;
    }
    this.namespaceCounter += 1;
    return `${this.idNamespace}:${this.namespaceCounter}`;
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const id = this.mintId();
    const requestBody = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? [] });
    const atMs = this.clock();

    // A9/D6: a stalled/unreachable endpoint must not be able to hang a sweep forever — abort
    // after `timeoutMs` (when the caller configured one) exactly like `src/watcher.ts`'s own
    // `fetchWithTimeout` does for its technocore reads. D6: the timer covers the BODY too, not
    // only the initial connection — `fetch()` commonly resolves once response *headers* arrive,
    // while the body keeps streaming, so clearing the timer right after `fetchImpl` resolves
    // (the original bug) would leave a server that stalls mid-body free to hang the subsequent
    // `arrayBuffer()` read forever. Both steps happen inside the same try, so the same abort
    // (and the same `finally`) covers whichever one is still in flight when `timeoutMs` elapses.
    const controller = new AbortController();
    const timer = this.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), this.timeoutMs);
    let responseBytes: Uint8Array;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal: controller.signal,
      });
      // A9: hash and store the exact wire bytes (`arrayBuffer()`), never a UTF-8 decode/re-encode
      // round trip through `.text()` — a response containing bytes that are not valid UTF-8
      // would decode with lossy replacement characters, so hashing the *decoded* string could
      // never reproduce the sha256 of what the server actually sent.
      responseBytes = new Uint8Array(await response.arrayBuffer());
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // `responseBody` (used for JSON parsing below and for whatever a caller does with the
    // exchange afterward) is decoded from that same byte buffer, once, as a separate copy.
    const responseSha256 = bytesToHex(sha256(responseBytes));
    const responseBody = new TextDecoder("utf-8").decode(responseBytes);
    this.log.push({ method, params: params ?? [], requestBody, responseBody, responseBytes, responseSha256, atMs });

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

async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** D2: exact byte-for-byte equality — never `TextDecoder`/`TextEncoder` round-tripped, so a
 *  response with a UTF-8 BOM or a genuinely invalid byte compares the same way live and
 *  replayed. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Where `writeCapture`/`readCapture` keep one exchange's response bytes under a watch root. */
function rawRpcPath(root: string, sha256Hex: string): string {
  return join(root, "raw", "rpc", `${sha256Hex}.json`);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Write each exchange's `responseBytes` byte-exact to `raw/rpc/<responseSha256>.json` — never
 * `responseBody` (P22-P24-EVM-FIXES-R2.md D2: a `TextDecoder`/`TextEncoder` round trip through
 * a JS string is lossy for a response containing a byte that isn't valid UTF-8, which would
 * otherwise write different bytes than the ones `responseSha256` actually names). The name is
 * the content's own hash, so two callers writing the same exchange twice (or the same exchange
 * re-captured on a later sweep) produce the identical file — idempotent by construction. Skips
 * a path that is already on disk with the identical bytes rather than re-writing it; a path
 * that exists with *different* bytes (corruption, or a hostile edit) is overwritten with the
 * genuine bytes this capture just produced, self-healing rather than trusting whatever was
 * there first.
 */
export async function writeCapture(root: string, exchanges: readonly Exchange[]): Promise<void> {
  for (const exchange of exchanges) {
    const path = rawRpcPath(root, exchange.responseSha256);
    let alreadyThere: Uint8Array | null;
    try {
      alreadyThere = await readFile(path);
    } catch {
      alreadyThere = null;
    }
    if (alreadyThere !== null && bytesEqual(alreadyThere, exchange.responseBytes)) continue;
    await writeFileAtomic(path, exchange.responseBytes);
  }
}

/**
 * Read `raw/rpc/<sha256>.json`'s raw bytes and re-hash them directly — never decoded to a
 * string and re-encoded first (P22-P24-EVM-FIXES-R2.md D2: that round trip is lossy for a byte
 * that isn't valid UTF-8, so a genuine capture of such a response could otherwise re-hash to a
 * *different* value on replay than it did live, even though nothing was tampered — the live and
 * replayed verdicts must never be able to diverge over exactly this). `null` on a missing file
 * OR a hash mismatch (tampering, truncation, a caller passing a hash that never came from
 * `writeCapture`) — the caller (`src/rails/evm-evidence.ts`'s `evmEvidence`) turns either into
 * fail-closed evidence, never a thrown exception; this file is anonymous input from disk, same
 * trust level as a `/kv` note. A malformed `sha256Hex` (not 64 lowercase hex chars) is refused
 * before touching the filesystem at all, so a hostile or corrupted index can never walk this
 * out of `root`.
 */
export async function readCapture(root: string, sha256Hex: string): Promise<Uint8Array | null> {
  if (!SHA256_HEX.test(sha256Hex)) return null;
  let raw: Buffer;
  try {
    raw = await readFile(rawRpcPath(root, sha256Hex));
  } catch {
    return null;
  }
  // A plain `Uint8Array` copy, not the `Buffer` subclass `readFile` returns — the same concrete
  // type every other byte array in this module is (`Exchange.responseBytes`, `writeCapture`'s
  // own input), so a caller's `toEqual`/structural comparison never has to know or care that
  // these bytes happened to come from a file.
  const body = new Uint8Array(raw);
  const actual = bytesToHex(sha256(body));
  return actual === sha256Hex ? body : null;
}

/**
 * P22-P24-EVM-FIXES-R2.md D2: builds an `EvmCapture.bytes`-shaped map straight from a live
 * capture's own `Exchange[]`, re-hashing each one's `responseBytes` against its own
 * `responseSha256` — the same re-hash `readCapture` performs on a replayed file, so a live
 * capture and a replayed one are trusted identically instead of a live one blindly reusing
 * whatever bytes happen to already be sitting in memory. Used by every caller that builds an
 * in-memory `EvmCapture` straight from a live capture (`src/rails/evm-htlc.ts`'s
 * `verifyLockFinal`, `src/watcher.ts`'s sweep, `src/client/bundle.ts`'s evidence writer) —
 * never `new TextEncoder().encode(exchange.responseBody)`, which is lossy for a response
 * containing a byte that isn't valid UTF-8 (the live and replayed verdicts must never be able
 * to diverge over exactly this). A mismatch (should never happen if `CapturingRpc` behaved,
 * but this is the same untrusted-input boundary as everywhere else in this file) maps to
 * `null`, exactly like a `readCapture` tamper/miss.
 */
export function verifiedExchangeBytes(exchanges: readonly Exchange[]): Map<string, Uint8Array | null> {
  const bytes = new Map<string, Uint8Array | null>();
  for (const exchange of exchanges) {
    if (bytes.has(exchange.responseSha256)) continue;
    const actual = bytesToHex(sha256(exchange.responseBytes));
    bytes.set(exchange.responseSha256, actual === exchange.responseSha256 ? exchange.responseBytes : null);
  }
  return bytes;
}
