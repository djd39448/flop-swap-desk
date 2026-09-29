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
  /** P4-BTC-SPEC.md §4: set when this exchange targeted `endpoint + path` instead of the bare
   *  endpoint — bitcoind's per-wallet JSON-RPC dispatch (`/wallet/<name>`) needs this; every EVM
   *  call leaves it unset (the bare endpoint). Never a secret (a wallet name is not credential
   *  material), so recording it is safe — unlike the auth header (see `CapturingRpcOptions.headers`
   *  below), which is never recorded anywhere on an `Exchange`. */
  path?: string;
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
/** H4: optional, chain-agnostic passthrough of a JSON-RPC error object's own structured fields
 *  beyond `code`/`message` — populated only when the response's `error` object actually carries
 *  them (NEAR's own error shape nests `name`/`cause`/`data` alongside `code`/`message`; a plain
 *  EVM/Bitcoin JSON-RPC error never has these, so `errorName`/`cause`/`data` stay `undefined`
 *  there and neither rail's own behaviour changes). `errorName` (not `name`) so it never collides
 *  with `Error.prototype.name`, which this class reserves for its own constructor identity
 *  ("RpcCaptureError") — every existing `instanceof`/`.name === "RpcCaptureError"` check anywhere
 *  in this repo keeps working unchanged. */
export interface RpcCaptureErrorExtra {
  /** The error object's own `name` (NEAR: `"HANDLER_ERROR"`). Explicitly `| undefined` (rather
   *  than plain optional) so a caller can pass `errorName: undefined` under this repo's own
   *  `exactOptionalPropertyTypes` — every caller does exactly that when the response carried no
   *  such field. */
  errorName?: string | undefined;
  /** The error object's own `cause` (NEAR: `{ name: "UNKNOWN_TRANSACTION" | "TIMEOUT_ERROR" |
   *  "INVALID_TRANSACTION" | ..., info?: unknown }`) — passed through structurally, never parsed
   *  here (chain-specific interpretation belongs to the caller, e.g. `near-rpc.ts`). */
  cause?: unknown;
  /** The error object's own `data` (a free-form string or value; NEAR sometimes puts a human
   *  message here, e.g. `"Timeout"`). */
  data?: unknown;
}

export class RpcCaptureError extends Error {
  readonly code: number;
  readonly errorName?: string | undefined;
  readonly errorCause?: unknown;
  readonly errorData?: unknown;

  constructor(code: number, message: string, extra?: RpcCaptureErrorExtra) {
    super(message);
    this.name = "RpcCaptureError";
    this.code = code;
    this.errorName = extra?.errorName;
    this.errorCause = extra?.cause;
    this.errorData = extra?.data;
  }
}

/** P22-P24-EVM-FIXES-R3.md E4: every `CapturingRpc` gets this timeout unless a caller passes
 *  its own — a stalled or badly rate-limited RPC endpoint (the reviewer's slow-`locks()`-read
 *  probe) must never be able to hang a client flow's chain read indefinitely just because that
 *  particular call site forgot to configure one. `src/watcher.ts`'s own `DEFAULT_TIMEOUT_MS`
 *  (45s, for its technocore HTTP reads) is the closest existing precedent; this is the same
 *  order of magnitude for the same reason. Passing `timeoutMs: undefined` explicitly (as
 *  opposed to omitting the field) still falls back to this default — only a caller that wants
 *  *no* timeout at all has no way to ask for that anymore, which is the point (P22-P24-EVM-
 *  FIXES-R3.md E4 group E is fund-safety: a chain read that never gives up is exactly what let
 *  a claim's own safety margin quietly erode while nobody was watching). */
export const DEFAULT_RPC_TIMEOUT_MS = 45_000;

export interface CapturingRpcOptions {
  endpoint: string;
  /** Defaults to the global `fetch`. Injected so tests never touch the network. */
  fetch?: typeof fetch;
  /** Defaults to `Date.now`. Injected per the house rule: no clock in an untested corner. */
  clock?: () => number;
  /** P22-P24-EVM-FIXES.md A9: aborts a call that has not answered within this many ms, so one
   *  stalled/unreachable RPC endpoint can never hang a sweep forever. P22-P24-EVM-FIXES-R3.md
   *  E4: defaults to `DEFAULT_RPC_TIMEOUT_MS` rather than never aborting — every caller gets
   *  this protection unless it explicitly asks for a different one. */
  timeoutMs?: number;
  /** P4-BTC-SPEC.md §1/§4: extra HTTP headers merged into every request this instance makes —
   *  chiefly the `Authorization: Basic <cookie>` header bitcoind's regtest RPC needs
   *  (tests-regtest/helpers/bitcoind.ts reads the node's own throwaway cookie file and passes it
   *  here). Read fresh on every call (a function, not a static object) rather than baked in once,
   *  so nothing forces a caller to have the credential in hand before constructing this instance.
   *  Never merged into `requestBody`, never stored on an `Exchange`, and so never written to
   *  `raw/rpc/*.json` or any capture index — the keyless rule's "never logged, never persisted"
   *  extends to the node's own RPC cookie exactly as it does to a private key. Defaults to no
   *  extra headers (every existing EVM caller is unaffected). */
  headers?: () => Record<string, string>;
  /** P5-NEAR-FIXES.md E5: a hard cap on one response's own byte length. `Content-Length` is
   *  checked first (when the response carries one) so an oversized reply can be refused before
   *  ever buffering its body; the buffered length is checked again afterward regardless (a
   *  chunked reply carries no `Content-Length` at all, and a lying header must never be trusted
   *  on its own) — either way, going over the cap throws a plain transport-class `Error` (never
   *  an `RpcCaptureError`: nothing here claims to be a JSON-RPC-level reply) BEFORE the exchange
   *  is pushed onto `this.log`, so an oversized response is never written to `raw/rpc/*.json` or
   *  handed back to a caller as if it were a completed read. `captureNearLeg`
   *  (src/rails/near-evidence.ts) relies on exactly this: only an `RpcCaptureError` counts as a
   *  completed read there (E2); everything else — this cap included — fails the capture closed
   *  (`index.error`, counted under `nearChainReadsSkipped`). Defaults to 4 MiB, comfortably above
   *  any real EVM/Bitcoin/NEAR JSON-RPC response this repo's own suites ever see, so neither
   *  rail's behaviour changes by default. */
  maxResponseBytes?: number;
}

/** E5: the default `maxResponseBytes` — see `CapturingRpcOptions.maxResponseBytes`'s own doc. */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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
  private readonly headersFn: () => Record<string, string>;
  private readonly maxResponseBytes: number;
  private readonly log: Exchange[] = [];
  private nextId = 1;
  private idNamespace: string | undefined;
  private namespaceCounter = 0;

  constructor(options: CapturingRpcOptions) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.headersFn = options.headers ?? (() => ({}));
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
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

  async request({ method, params, path }: { method: string; params?: unknown; path?: string }): Promise<unknown> {
    const id = this.mintId();
    const requestBody = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? [] });
    const atMs = this.clock();
    // P4-BTC-SPEC.md §4: bitcoind's per-wallet RPC dispatch needs `/wallet/<name>` appended to
    // the base endpoint for wallet calls (walletprocesspsbt, sendtoaddress, …); every other
    // call (and every existing EVM caller, which never passes `path`) still targets the bare
    // endpoint exactly as before.
    const url = path === undefined || path === "" ? this.endpoint : `${this.endpoint}${path}`;

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
      // The auth header (if any) is read fresh here and only ever placed on the outgoing HTTP
      // request — it never reaches `requestBody` above, and is therefore never part of what
      // gets pushed onto `this.log` below (an `Exchange` carries no headers field at all).
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headersFn() },
        body: requestBody,
        signal: controller.signal,
      });
      // E5: refuse an oversized reply before ever buffering its body, when the response is
      // honest enough to declare one. Optional chaining throughout — none of this repo's own
      // fake-`fetch` test doubles implement `.headers`, and a real `fetch` Response always does.
      const declaredLength = Number.parseInt(response.headers?.get?.("content-length") ?? "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        controller.abort();
        throw new Error(
          `rpc-capture: response for ${method} declares content-length ${declaredLength}, exceeding maxResponseBytes ${this.maxResponseBytes} (endpoint ${this.endpoint})`,
        );
      }
      // A9: hash and store the exact wire bytes (`arrayBuffer()`), never a UTF-8 decode/re-encode
      // round trip through `.text()` — a response containing bytes that are not valid UTF-8
      // would decode with lossy replacement characters, so hashing the *decoded* string could
      // never reproduce the sha256 of what the server actually sent.
      responseBytes = new Uint8Array(await response.arrayBuffer());
      // E5: a chunked reply carries no `Content-Length` at all, and a lying header must never be
      // trusted on its own either — check the buffered length itself regardless of the header
      // check above. Still before `this.log.push` below, so an oversized response is never
      // written to `raw/rpc/*.json` or treated as a completed read (near-evidence.ts's E2).
      if (responseBytes.length > this.maxResponseBytes) {
        throw new Error(
          `rpc-capture: response for ${method} is ${responseBytes.length} bytes, exceeding maxResponseBytes ${this.maxResponseBytes} (endpoint ${this.endpoint})`,
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // `responseBody` (used for JSON parsing below and for whatever a caller does with the
    // exchange afterward) is decoded from that same byte buffer, once, as a separate copy.
    const responseSha256 = bytesToHex(sha256(responseBytes));
    const responseBody = new TextDecoder("utf-8").decode(responseBytes);
    this.log.push({
      method,
      params: params ?? [],
      requestBody,
      responseBody,
      responseBytes,
      responseSha256,
      atMs,
      ...(path === undefined || path === "" ? {} : { path }),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      throw new Error(`rpc-capture: response for ${method} is not valid JSON (endpoint ${this.endpoint})`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`rpc-capture: response for ${method} is not a JSON-RPC object`);
    }
    const envelope = parsed as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown; name?: unknown; cause?: unknown; data?: unknown };
    };
    if (envelope.error !== undefined && envelope.error !== null) {
      const code = typeof envelope.error.code === "number" ? envelope.error.code : -32603;
      const message = typeof envelope.error.message === "string" ? envelope.error.message : "rpc error";
      // H4: pass the error object's own name/cause/data through untouched when present — see
      // `RpcCaptureErrorExtra`'s own doc for why this changes nothing for EVM/Bitcoin (their
      // error objects never carry these fields, so all three stay `undefined` there).
      throw new RpcCaptureError(code, message, {
        errorName: typeof envelope.error.name === "string" ? envelope.error.name : undefined,
        cause: envelope.error.cause,
        data: envelope.error.data,
      });
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
