// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Surface" (rule 1 "durable before visible", rule 6 "fail closed on bad state"): the
// persistence surface a Buyer or Seller flow writes its swap record through, so a fresh process given the same
// store can continue the swap. Three things live here and nothing else:
//
//   - `FlowStore`: three methods over opaque bytes. `save` is a compare-and-swap: the caller passes the sha256 of
//     the bytes it last loaded or wrote (`null` = "create, there must be nothing there yet"), and the store
//     refuses with a typed error when what it holds is something else. That is what makes the record
//     SINGLE-WRITER (review round 1, R1-02): a second flow instance on the same record, in this process or in
//     another, is stopped at its first save instead of silently replacing the first one's state. `save` resolves
//     only once the bytes are durable.
//   - `MemoryFlowStore`: the test store. It checks and sets synchronously, logs every save and can fail the n-th
//     one in two ways (the write is refused, or the write commits and the call still throws), which is how the
//     crash matrix cuts a flow "after the action, before the store confirmed it".
//   - `FileFlowStore`: one file per key under a runner-owned directory. Every save runs inside a per-key critical
//     section held by an exclusive lock file (`<role>-<id>.lock`, created with O_EXCL, carrying the holder's pid):
//     compare, remove this key's stale temp files, write a temp file, fsync it, rename it over the record, then
//     fsync the directory (POSIX) or the renamed file (Windows, best effort). A lock left behind by a dead process
//     is broken; a lock held by a live one is a typed `FlowStoreLockedError` and is never broken silently. A lock
//     that names THIS process's own pid and is not one this process holds (a predecessor that died inside a save
//     and a restart under the same pid, the normal case for node as pid 1 in a container, R2-01) is a leftover too
//     and is broken: the process-wide set of held lock bodies tells the two apart. The set is per process, not per
//     thread: one thread per store directory (the README says so). The file
//     carries a one-line header with the payload's length and sha256, so a truncated or corrupted file is a
//     `FlowStoreCorruptError` on `load`, never an empty answer (the watcher's `state.json` habit of resetting on a
//     bad read is deliberately NOT copied). A store also names its storage (`scopeId`: the resolved directory) and
//     offers one store-wide exclusive section (`exclusive("seller-begin")`, a fixed `seller-begin.lock` taken with
//     the same lock code), so that two accepts of one offer, which a per-key compare-and-swap cannot tell apart
//     (their keys differ), are one critical section across store objects and processes (R2-04).
//
// Keys are `buyer:<swapId>` and `seller:<contractA>`: the part after the colon is `0x` + 64 lowercase hex in both
// cases (the swap id of `src/profile.ts` for a Buyer; leg A's tclk contract id for a Seller, review round 1 R1-14: a
// swap id is chosen by the Buyer and nobody can authenticate it, a contract id binds the signed offer and the
// Seller's own accept). The key is checked against that grammar on every call, and the file name is built only from
// the checked parts, so nothing outside `dir` can be reached; `underDir` is the watcher's `underRoot` idea, applied
// a second time.
//
// File names: the key's `:` is not a legal character in a Windows file name (it opens an NTFS alternate data
// stream), so a key is stored as `<role>-<id>.json`; `list()` maps the names back to keys. Lock and temp files
// (`<role>-<id>.lock`, `seller-begin.lock`, `<role>-<id>.json.tmp-<pid>-<random>`) never match that pattern, so
// `list()` never shows them.
//
// This directory is secret-grade, exactly like a key file: the Seller's record holds the swap preimage.

import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/** `buyer` or `seller`: whose record a key names. */
export type FlowRole = "buyer" | "seller";

/** The stable shape of the id in a key (`0x` + sha256 hex): the swap id for a Buyer, leg A's contract id for a Seller. */
const KEY_ID_SHAPE = /^0x[0-9a-f]{64}$/;

/** The key grammar: `buyer:<swapId>` or `seller:<contractA>`. */
export const FLOW_KEY_PATTERN = /^(buyer|seller):(0x[0-9a-f]{64})$/;

/** The file-name form of a key, `<role>-<id>.json`. */
const FILE_NAME_PATTERN = /^(buyer|seller)-(0x[0-9a-f]{64})\.json$/;

/** The format tag alone, to tell "a format this build does not know" from "not one of our files at all". */
const FORMAT_PATTERN = /^flop-flow-store\/([0-9]+) /;

/** The first line of a `FileFlowStore` file: format tag, payload sha256, payload length. */
const HEADER_PATTERN = /^flop-flow-store\/1 sha256=([0-9a-f]{64}) length=([0-9]+)\n/;

const SHA256_HEX = /^[0-9a-f]{64}$/;

// --- errors ---------------------------------------------------------------------------------------------------

/** Base of every error this module throws, so a caller can tell a store problem from a flow problem. */
export class FlowStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FlowStoreError";
  }
}

/** A stored value failed its integrity check (truncated, corrupted, wrong header or wrong checksum). The flow
 *  stops: a corrupt record is never read as "no record" (rule 6). */
export class FlowStoreCorruptError extends FlowStoreError {
  readonly key: string;
  readonly reason: string;
  constructor(key: string, reason: string) {
    super(`flow store: the record for "${key}" is corrupt: ${reason}`);
    this.name = "FlowStoreCorruptError";
    this.key = key;
    this.reason = reason;
  }
}

/** A key that does not match `buyer:<swapId>` or `seller:<contractA>`. */
export class FlowStoreKeyError extends FlowStoreError {
  constructor(key: unknown) {
    super(`flow store: key must be "buyer:<swapId>" or "seller:<contractA>" with the id = 0x + 64 lowercase hex, got ${JSON.stringify(key)}`);
    this.name = "FlowStoreKeyError";
  }
}

/** A path that would leave the store's directory (defence in depth: the key grammar already rules it out). */
export class FlowStorePathError extends FlowStoreError {
  constructor(message: string) {
    super(message);
    this.name = "FlowStorePathError";
  }
}

/**
 * A save did not become durable. Raised by the journal for EVERY refused save (a flow whose save was refused is a
 * crashed flow: it never acts on state the store does not hold, review round 1 R1-03), and the base of the store's
 * own refusals below. `cause` carries the underlying error (a disk error, a record the journal could not encode).
 */
export class FlowStoreWriteFailedError extends FlowStoreError {
  readonly key: string;
  constructor(key: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FlowStoreWriteFailedError";
    this.key = key;
  }
}

/** The stored bytes are not the ones the caller last loaded or wrote: another writer saved in between, so this
 *  caller no longer owns the record. Nothing was written. The flow must be dropped and rebuilt with `resume()`. */
export class FlowRecordStaleError extends FlowStoreWriteFailedError {
  /** The digest the caller expected (sha256 hex of its last loaded or written bytes). */
  readonly expected: string;
  /** The digest of what the store holds now, or `null` when it holds nothing. */
  readonly actual: string | null;
  constructor(key: string, expected: string, actual: string | null) {
    super(
      key,
      `flow store: "${key}" was changed by another writer since this flow last read or wrote it ` +
        `(expected sha256 ${expected.slice(0, 12)}..., the store holds ${actual === null ? "nothing" : `${actual.slice(0, 12)}...`}); ` +
        "this flow no longer owns the swap record: drop it and call resume()",
    );
    this.name = "FlowRecordStaleError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** A create (`expected` = `null`) found a record already stored under the key. Overwriting it would silently reset a
 *  swap (rule 6): the runner must call `resume`, or pick another store. */
export class FlowRecordExistsError extends FlowStoreWriteFailedError {
  constructor(key: string) {
    super(key, `flow store: "${key}" already holds a record; call resume() to continue that swap instead of starting it over`);
    this.name = "FlowRecordExistsError";
  }
}

/** Why a `FlowStoreLockedError` refused. `held`: a live holder owns the lock (or the lock could not be taken at all).
 *  `stale`: the lock file is a leftover (its process is gone, or it names this process's pid without this process
 *  holding it) and could not be removed (R3-05). `lost`: the save's own lock file was removed or replaced while the
 *  save held it. `unreadable`: the save's own lock file could not be read when the save checked it (R3-04). */
export type FlowStoreLockReason = "held" | "stale" | "lost" | "unreadable";

/** Another LIVE process holds the key's lock file (or the lock could not be taken): that process owns the swap. The
 *  lock is never broken silently. A lock left by a process that is gone is broken automatically, and so is one that
 *  names this very process's pid without this process holding it (R2-01); if the pid was reused by an unrelated
 *  process, an operator removes the named file, and the message says so. The message never says "another instance"
 *  for this process's own pid: the only own-pid lock that is not broken is one a save of THIS process is holding
 *  right now. A leftover that cannot be removed has its own reason and wording (`stale`: remove the named file), and
 *  so does a save whose own lock file could not be read (`unreadable`); neither names another instance (R3-04,
 *  R3-05). A refusal of the store-wide Seller begin section says "another Seller begin is running", not "owns this
 *  swap". */
export class FlowStoreLockedError extends FlowStoreWriteFailedError {
  readonly lockPath: string;
  /** The pid the lock file names, when it could be read. */
  readonly holderPid: number | undefined;
  /** Why the lock refused (see `FlowStoreLockReason`). Default `held`. */
  readonly reason: FlowStoreLockReason;
  constructor(key: string, lockPath: string, holderPid: number | undefined, detail?: string, reason: FlowStoreLockReason = "held") {
    super(key, lockedMessage(key, lockPath, holderPid, detail, reason));
    this.name = "FlowStoreLockedError";
    this.lockPath = lockPath;
    this.holderPid = holderPid;
    this.reason = reason;
  }
}

function lockedMessage(key: string, lockPath: string, holderPid: number | undefined, detail: string | undefined, reason: FlowStoreLockReason): string {
  if (reason === "stale") {
    return (
      `flow store: "${key}": a stale lock file${holderPid === undefined ? "" : ` naming pid ${holderPid}`} could not be removed: ` +
      `remove ${lockPath}; nothing was written`
    );
  }
  if (reason === "unreadable") return `flow store: "${key}": the lock file could not be read (${lockPath}); nothing was renamed`;
  const own = holderPid !== undefined && holderPid === process.pid;
  const extra = detail === undefined ? "" : `: ${detail}`;
  // A live foreign pid may be a pid an unrelated process now has (a reboot, a recycled pid): the way out is the file.
  const reused = holderPid !== undefined && !own && reason === "held";
  if (!FLOW_KEY_PATTERN.test(key)) {
    // A store-wide section (`seller-begin`), not a record: there is no swap to own.
    if (holderPid === undefined) return `flow store: "${key}" is locked by another writer (${lockPath})${extra}; nothing was written`;
    return (
      `flow store: another Seller begin is running (pid ${holderPid})${own ? " in this same process" : ""} (${lockPath})${extra}; nothing was written` +
      `${reused ? `. A pid reused by an unrelated process looks live: if no Seller begin is running, remove ${lockPath} by hand` : ""}`
    );
  }
  return (
    `flow store: "${key}" is locked by ${holderPid === undefined ? "another writer" : own ? `a save in this same process (pid ${holderPid})` : `process ${holderPid}`} (${lockPath})` +
    `${extra}; ${own ? "" : "another instance owns this swap, "}nothing was written` +
    `${reused ? `. A pid reused by an unrelated process looks live: if no instance of this swap is running, remove ${lockPath} by hand` : ""}`
  );
}

/** The failure a `MemoryFlowStore` injects on purpose (never thrown by a real store). */
export class FlowStoreFaultError extends FlowStoreWriteFailedError {
  readonly saveNumber: number;
  readonly mode: MemoryFault;
  constructor(saveNumber: number, mode: MemoryFault, key = "") {
    super(key, `flow store: injected fault on save number ${saveNumber} (${mode})`);
    this.name = "FlowStoreFaultError";
    this.saveNumber = saveNumber;
    this.mode = mode;
  }
}

// --- the interface and the key grammar -------------------------------------------------------------------------

export interface FlowStore {
  /** The bytes last saved under `key`, or `null` when nothing was ever saved there. A value that fails its
   *  integrity check throws `FlowStoreCorruptError`; it is never reported as `null`. */
  load(key: string): Promise<Uint8Array | null>;
  /**
   * Saves `bytes` under `key`, replacing the old value whole, but only if the store still holds what the caller last
   * saw: `expected` is the sha256 hex (`flowDigest`) of the bytes the caller last loaded or wrote under this key, or
   * `null` to create (the key must hold nothing yet). A different stored value rejects with `FlowRecordStaleError`,
   * a create over an existing key with `FlowRecordExistsError`; nothing is written then. Resolves only once the bytes
   * are durable.
   */
  save(key: string, bytes: Uint8Array, expected: string | null): Promise<void>;
  /** Every key with a saved value, sorted: `buyer:<swapId>` for each Buyer record and `seller:<contractA>` (leg A's
   *  tclk contract id, not the swap id: R1-14) for each Seller record. */
  list(): Promise<string[]>;
  /**
   * R2-04: names the storage this object reads and writes. Two objects with the same `scopeId` are two handles on ONE
   * store (two `FileFlowStore` objects on one directory), so a queue that must serialise "everything on this store"
   * (the Seller's begin scan) is keyed by it instead of by the object. Absent: the object itself is the scope (a
   * `MemoryFlowStore` is its own storage).
   */
  readonly scopeId?: string;
  /**
   * R2-04: an optional store-wide exclusive section. Runs `work` while no other caller, in this process or in another
   * one on the same storage, is inside the section of the same `name`; a caller that cannot get in within the
   * store's wait is refused with a typed error and `work` never runs. A store that cannot give that across
   * processes leaves the method out, and the caller falls back to its in-process queue alone.
   */
  exclusive?<T>(name: FlowExclusiveName, work: () => Promise<T>): Promise<T>;
}

/** The named store-wide sections a `FlowStore.exclusive` offers. `seller-begin`: the Seller's scan of the stored
 *  records for an offer, its mint of a secret and its create of the record, which must not interleave between two
 *  accepts of one offer (R2-04). The name is a closed set, so no caller can reach a file outside the store's own. */
export type FlowExclusiveName = "seller-begin";

const EXCLUSIVE_NAMES: ReadonlySet<string> = new Set<string>(["seller-begin"]);

/** The digest `save` compares against: sha256 hex of the bytes. */
export function flowDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Builds a key. `id` is the swap id for a Buyer and leg A's contract id for a Seller (both `0x` + 64 hex). */
export function flowKey(role: FlowRole, id: string): string {
  const key = `${role}:${id}`;
  if (role !== "buyer" && role !== "seller") throw new FlowStoreKeyError(key);
  if (!KEY_ID_SHAPE.test(id)) throw new FlowStoreKeyError(key);
  return key;
}

/** Splits a key into its parts, or throws `FlowStoreKeyError`. `swapId` is the 64-hex id after the colon, which is the
 *  swap id for a Buyer key and leg A's contract id for a Seller key (the name is kept for compatibility). */
export function parseFlowKey(key: string): { role: FlowRole; swapId: string } {
  const match = typeof key === "string" ? FLOW_KEY_PATTERN.exec(key) : null;
  if (match === null) throw new FlowStoreKeyError(key);
  return { role: match[1] as FlowRole, swapId: match[2] as string };
}

function checkExpected(key: string, expected: unknown): void {
  if (expected !== null && (typeof expected !== "string" || !SHA256_HEX.test(expected))) {
    throw new FlowStoreError(`flow store: save("${key}") needs the sha256 hex of the bytes last loaded or written, or null to create`);
  }
}

// --- MemoryFlowStore ---------------------------------------------------------------------------------------------

/** How an injected save fault behaves. `reject`: nothing is stored and `save` throws (the store write FAILED).
 *  `commit-then-throw`: the bytes are stored and `save` still throws (the write landed, the confirmation was lost). */
export type MemoryFault = "reject" | "commit-then-throw";

/** One entry of `MemoryFlowStore.saves`: every `save` call, in order, whether it stored anything or not. */
export interface MemorySaveRecord {
  /** 1-based, counted across all keys. */
  readonly n: number;
  readonly key: string;
  /** A copy of the bytes the caller passed. */
  readonly bytes: Uint8Array;
  /** `ok`, the fault that was injected on this call, or the refusal of the compare-and-swap (`stale`: the stored
   *  bytes were not the expected ones; `exists`: a create over an existing key). */
  readonly outcome: "ok" | MemoryFault | "stale" | "exists";
}

/**
 * The test store. Values are held as copies (a caller mutating its array afterwards changes nothing), every
 * `save` is logged in `saves`, and a save can be made to fail: `failSave(n, mode)` fails the n-th call (1-based,
 * across all keys); `failSaveWhen(predicate)` decides per call. Both modes of `MemoryFault` are available. The
 * compare-and-swap of `save` is checked and applied with no `await` in between, so two callers can never both win.
 */
export class MemoryFlowStore implements FlowStore {
  private readonly values = new Map<string, Uint8Array>();
  private readonly log: MemorySaveRecord[] = [];
  private readonly byNumber = new Map<number, MemoryFault>();
  private predicate: ((n: number, key: string, bytes: Uint8Array) => MemoryFault | undefined) | undefined;

  /** Every save call so far, oldest first. */
  get saves(): readonly MemorySaveRecord[] {
    return this.log;
  }

  /** How many `save` calls have been made (failed and refused ones included). */
  get saveCount(): number {
    return this.log.length;
  }

  /** Fail the n-th `save` call (1-based, across all keys). Several numbers can be armed. */
  failSave(n: number, mode: MemoryFault = "reject"): this {
    if (!Number.isInteger(n) || n < 1) throw new FlowStoreError("flow store: failSave needs a 1-based save number");
    this.byNumber.set(n, mode);
    return this;
  }

  /** Decide per call: return a fault to inject it, `undefined` to let the call through. */
  failSaveWhen(predicate: (n: number, key: string, bytes: Uint8Array) => MemoryFault | undefined): this {
    this.predicate = predicate;
    return this;
  }

  /** Disarms every injected fault (the log and the stored values stay). */
  clearFaults(): void {
    this.byNumber.clear();
    this.predicate = undefined;
  }

  async load(key: string): Promise<Uint8Array | null> {
    parseFlowKey(key);
    const value = this.values.get(key);
    return value === undefined ? null : value.slice();
  }

  async save(key: string, bytes: Uint8Array, expected: string | null): Promise<void> {
    parseFlowKey(key);
    checkExpected(key, expected);
    const copy = bytes.slice();
    const n = this.log.length + 1;
    const fault = this.byNumber.get(n) ?? this.predicate?.(n, key, copy.slice());
    const logAs = (outcome: MemorySaveRecord["outcome"]): void => void this.log.push({ n, key, bytes: copy.slice(), outcome });
    if (fault === "reject") {
      logAs("reject");
      throw new FlowStoreFaultError(n, fault, key);
    }
    // No await from here to `values.set`: the compare and the swap are one step.
    const current = this.values.get(key);
    if (expected === null) {
      if (current !== undefined) {
        logAs("exists");
        throw new FlowRecordExistsError(key);
      }
    } else if (current === undefined || flowDigest(current) !== expected) {
      logAs("stale");
      throw new FlowRecordStaleError(key, expected, current === undefined ? null : flowDigest(current));
    }
    logAs(fault ?? "ok");
    this.values.set(key, copy);
    if (fault === "commit-then-throw") throw new FlowStoreFaultError(n, fault, key);
  }

  async list(): Promise<string[]> {
    return [...this.values.keys()].sort();
  }
}

// --- FileFlowStore -----------------------------------------------------------------------------------------------

/** The stages of one `FileFlowStore.save`, in order. `dir-synced` occurs on POSIX only; `target-synced` on Windows only
 *  (and only when the best-effort flush of the renamed file succeeded). */
export type FileSaveStep = "tmp-written" | "file-synced" | "renamed" | "dir-synced" | "target-synced";

export interface FileFlowStoreOptions {
  /** File mode for the saved files. Default `0o600`. Honoured where the platform honours modes (not Windows). */
  mode?: number;
  /** How long (ms) a save waits for another process's lock on the same key before it gives up with
   *  `FlowStoreLockedError`. A critical section is a few file operations, so contention is brief. Default 5000; 0 =
   *  do not wait. */
  lockWaitMs?: number;
  /** Test seam: called after each stage of `save`. A throw aborts the save at that stage, which is how a test
   *  stands in for "the process died here". Not for production use. */
  onStep?: (step: FileSaveStep, path: string) => void | Promise<void>;
  /** Test seam: the platform the save pipeline behaves as (default `process.platform`): it picks the directory fsync
   *  (POSIX) or the renamed-file flush (win32). Not for production use. */
  platform?: NodeJS.Platform;
}

/** The platform codes a directory fsync may fail with because the platform or file system simply does not support it.
 *  Every other code (EACCES, EPERM, EBADF, EIO, ...) is a real failure and surfaces: the rename may not be durable. */
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP"]);

/** The platform codes for which a file mode cannot be set (so its absence is not a failure). */
const MODE_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EINVAL"]);

/** The Windows codes a rename can fail with while a scanner or indexer briefly holds the target; retried a few times. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** What a stale temp file of one key may be called after `<name>.tmp-` (this build writes `<pid>-<12 hex>`). */
const TEMP_TAIL = /^[A-Za-z0-9_-]{1,64}$/;

/** The content of a lock file: `<pid>\n<16 hex token>\n`. */
const LOCK_BODY = /^([0-9]{1,9})\n([0-9a-f]{16})\n$/;

const LOCK_POLL_MS = 25;
/** An absolute cap on lock-loop iterations, so no combination of odd lock files can spin for ever. */
const LOCK_MAX_ITERATIONS = 4000;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((done) => setTimeout(done, ms));

/** True unless the pid is gone (`ESRCH`); a process we may not signal (`EPERM`) is alive. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

/** The lock bodies (a pid line, then a token line) this process holds right now. A lock file that names this
 *  process's own pid and whose body is NOT in here was left by a predecessor (killed inside a save and restarted under the same pid,
 *  or a release that could not read or remove its file) and is stale (R2-01). Kept on `globalThis` under a
 *  registered symbol so that two copies of this module in one process (a bundle and a source import, say) share it.
 *  A body is added BEFORE its lock file is created (a reader that sees the file must find the body) and removed by
 *  `release` whatever its outcome. */
const HELD_LOCKS = Symbol.for("flop-swap-desk.flow-store.held-locks");

function heldLockBodies(): Set<string> {
  const registry = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let held = registry[HELD_LOCKS];
  if (held === undefined) {
    held = new Set<string>();
    registry[HELD_LOCKS] = held;
  }
  return held;
}

/** In-process serialisation by lock path, across every `FileFlowStore` instance of this process: the O_EXCL lock file
 *  fences other PROCESSES, this fences other callers here, so the loser of a race is compared against the winner's
 *  bytes (a clean `FlowRecordStaleError`) instead of being refused as locked. */
const processMutex = new Map<string, Promise<void>>();

async function withProcessMutex<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = processMutex.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((done) => {
    release = done;
  });
  const chain = previous.then(() => mine);
  processMutex.set(id, chain);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (processMutex.get(id) === chain) processMutex.delete(id);
  }
}

interface LockFileContent {
  raw: string;
  /** The holder's pid, or `undefined` when the content is not a lock body (a creator that died before it wrote). */
  pid: number | undefined;
}

async function readLockFile(path: string): Promise<LockFileContent | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY") return null;
    throw error;
  }
  const match = LOCK_BODY.exec(raw);
  return { raw, pid: match === null ? undefined : Number(match[1]) };
}

/** The codes a read or a remove of a lock file can fail with while a scanner or indexer briefly holds it (Windows). */
const LOCK_IO_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const LOCK_IO_ATTEMPTS = 6;

/** R2-01: the lock file's content for `release`, retrying a transient EPERM, EBUSY or EACCES with a short backoff
 *  (`readLockFile` answers `null` to those, which `acquire` reads as "gone, try again"). `null`: there is no file;
 *  `undefined`: it could not be read at all. */
async function readLockFileRetrying(path: string): Promise<LockFileContent | null | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const raw = await fsp.readFile(path, "utf8");
      const match = LOCK_BODY.exec(raw);
      return { raw, pid: match === null ? undefined : Number(match[1]) };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return null;
      if (code === undefined || !LOCK_IO_RETRY_CODES.has(code) || attempt >= LOCK_IO_ATTEMPTS) return undefined;
      await sleep(20 * attempt);
    }
  }
}

/** `release`'s work: removes the lock file if it still holds `body`, retrying a transient read or remove failure.
 *  A file that cannot be read, or that holds something else, is left alone (it is not ours to remove, or it cannot be
 *  shown to be); a remove that keeps failing is left behind for this process's next acquire to break (R2-01). */
async function removeOwnLock(lockPath: string, body: string): Promise<void> {
  const now = await readLockFileRetrying(lockPath);
  if (now === null || now === undefined || now.raw !== body) return;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rm(lockPath, { force: true });
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !LOCK_IO_RETRY_CODES.has(code) || attempt >= LOCK_IO_ATTEMPTS) return;
      await sleep(20 * attempt);
    }
  }
}

interface HeldLock {
  /** Throws `FlowStoreLockedError` if the lock file is no longer ours (removed or replaced while the save held it). */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/**
 * One file per key under `dir`. `save`: take the key's lock, compare the stored bytes with `expected`, remove the key's
 * stale `.tmp-` files, write `<name>.tmp-<pid>-<random>` in the same directory (created exclusively, mode
 * `options.mode`), fsync it, rename it onto `<name>.json`, then fsync the directory (POSIX) or flush the renamed
 * file (win32, best effort), and release the lock. `load` verifies the header's length and sha256 and throws
 * `FlowStoreCorruptError` on any mismatch. Stale `.tmp-` and `.lock` files are never read and never listed.
 */
export class FileFlowStore implements FlowStore {
  /** R2-04: the resolved absolute directory (lower-cased on Windows, where paths ignore case), so two objects on one
   *  directory share one begin queue. A symlink or junction to the directory is another spelling this does not see:
   *  that case is fenced by the begin lock file across processes and objects alike. */
  readonly scopeId: string;
  private readonly dir: string;
  private readonly mode: number;
  private readonly lockWaitMs: number;
  private readonly onStep: FileFlowStoreOptions["onStep"];
  private readonly platform: NodeJS.Platform;

  constructor(dir: string, options: FileFlowStoreOptions = {}) {
    if (typeof dir !== "string" || dir === "") throw new FlowStorePathError("flow store: dir must be a non-empty path");
    this.dir = resolve(dir);
    this.scopeId = process.platform === "win32" ? this.dir.toLowerCase() : this.dir;
    const mode = options.mode ?? 0o600;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new FlowStorePathError("flow store: mode must be an integer 0..0o777");
    this.mode = mode;
    const wait = options.lockWaitMs ?? 5000;
    if (!Number.isInteger(wait) || wait < 0) throw new FlowStorePathError("flow store: lockWaitMs must be a non-negative integer");
    this.lockWaitMs = wait;
    this.onStep = options.onStep;
    this.platform = options.platform ?? process.platform;
  }

  /** The absolute directory this store writes under. */
  get directory(): string {
    return this.dir;
  }

  /** The watcher's `underRoot` idea: the path of `name` inside `dir`, refusing anything that escapes it. */
  private underDir(name: string): string {
    const full = join(this.dir, name);
    const rel = relative(this.dir, full);
    if (rel === "" || rel.startsWith("..") || rel.includes("/") || rel.includes("\\") || rel !== name) {
      throw new FlowStorePathError(`flow store: refusing to touch a path outside the store directory: ${name}`);
    }
    return full;
  }

  private pathFor(key: string): string {
    const { role, swapId } = parseFlowKey(key);
    return this.underDir(`${role}-${swapId}.json`);
  }

  /** The verified payload of the file at `path`, or `null` when there is no file. */
  private async readPayload(path: string, key: string): Promise<Buffer | null> {
    let file: Buffer;
    try {
      file = await fsp.readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    const newline = file.indexOf(0x0a);
    if (newline < 0) throw new FlowStoreCorruptError(key, "no header line");
    const headerLine = file.subarray(0, newline + 1).toString("latin1");
    const formatVersion = FORMAT_PATTERN.exec(headerLine);
    if (formatVersion !== null && formatVersion[1] !== "1") {
      throw new FlowStoreCorruptError(key, `unknown store format version ${formatVersion[1]}, this build reads version 1 only`);
    }
    const header = HEADER_PATTERN.exec(headerLine);
    if (header === null) throw new FlowStoreCorruptError(key, "unrecognised header");
    const payload = file.subarray(newline + 1);
    const length = Number(header[2]);
    if (!Number.isSafeInteger(length) || payload.length !== length) {
      throw new FlowStoreCorruptError(key, `payload is ${payload.length} bytes, the header says ${header[2]}`);
    }
    if (flowDigest(payload) !== header[1]) throw new FlowStoreCorruptError(key, "payload sha256 does not match the header");
    return payload;
  }

  async load(key: string): Promise<Uint8Array | null> {
    const payload = await this.readPayload(this.pathFor(key), key);
    return payload === null ? null : Uint8Array.from(payload);
  }

  async save(key: string, bytes: Uint8Array, expected: string | null): Promise<void> {
    checkExpected(key, expected);
    const path = this.pathFor(key); // grammar + containment are checked before anything is queued or touched
    const payload = Uint8Array.from(bytes);
    const lockPath = this.underDir(`${relative(this.dir, path).replace(/\.json$/, "")}.lock`); // <role>-<id>.lock
    await withProcessMutex(lockPath, async () => {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const lock = await this.acquireLock(key, lockPath);
      try {
        await this.compare(key, path, expected);
        await this.removeStaleTemps(path);
        await this.write(path, payload, lock);
      } finally {
        await lock.release();
      }
    });
  }

  /**
   * R2-04: the named store-wide section, over a fixed `<name>.lock` file in the directory, taken with the same
   * `acquireLock` as a key's lock (so the same rules hold: a dead holder's lock is broken, so is one naming this
   * process's own pid that it does not hold, a live holder is a typed `FlowStoreLockedError` after `lockWaitMs`).
   * The file name is outside the key grammar, so `list()` never shows it and `load` never reads it; it is removed when
   * the section ends, whatever `work` did.
   */
  async exclusive<T>(name: FlowExclusiveName, work: () => Promise<T>): Promise<T> {
    if (!EXCLUSIVE_NAMES.has(name)) throw new FlowStorePathError(`flow store: "${String(name)}" is not a store-wide section this build offers`);
    const lockPath = this.underDir(`${name}.lock`);
    return withProcessMutex(lockPath, async () => {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const lock = await this.acquireLock(name, lockPath);
      try {
        return await work();
      } finally {
        await lock.release();
      }
    });
  }

  /** The compare-and-swap's compare, run inside the critical section. */
  private async compare(key: string, path: string, expected: string | null): Promise<void> {
    if (expected === null) {
      const exists = await fsp.stat(path).then(
        () => true,
        (error: unknown) => {
          if (errorCode(error) === "ENOENT") return false;
          throw error;
        },
      );
      if (exists) throw new FlowRecordExistsError(key);
      return;
    }
    const current = await this.readPayload(path, key); // a damaged stored file is FlowStoreCorruptError, never overwritten
    if (current === null) throw new FlowRecordStaleError(key, expected, null);
    const actual = flowDigest(current);
    if (actual !== expected) throw new FlowRecordStaleError(key, expected, actual);
  }

  /** R1-17: a save killed between the temp write and the rename leaves `<name>.tmp-<pid>-<random>` holding the whole
   *  record (the Seller's preimage included). Inside the critical section nobody else is writing this key, so every
   *  such file is stale. Only this key's own temp files are touched; never another key's, never anything outside `dir`. */
  private async removeStaleTemps(path: string): Promise<void> {
    const prefix = `${relative(this.dir, path)}.tmp-`;
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !TEMP_TAIL.test(name.slice(prefix.length))) continue;
      await fsp.rm(this.underDir(name), { force: true }).catch(() => undefined); // best effort: a file held open elsewhere stays
    }
  }

  // --- the per-key lock ----------------------------------------------------------------------------------------

  private async tryCreateLock(lockPath: string, body: string): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await fsp.open(lockPath, "wx", 0o600);
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") return false;
      // Windows: a lock file another process just removed can sit "delete pending" while it is still open elsewhere.
      if (this.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) return false;
      throw error;
    }
    try {
      await handle.writeFile(body);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.rm(lockPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return true;
  }

  /** Removes the lock file only if it still has the content that was judged stale. */
  private async breakLock(lockPath: string, raw: string): Promise<void> {
    const again = await readLockFile(lockPath).catch(() => null);
    if (again === null || again.raw !== raw) return; // someone else broke it, or a new holder took it: not ours to remove
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  }

  private async acquireLock(key: string, lockPath: string): Promise<HeldLock> {
    const body = `${process.pid}\n${randomBytes(8).toString("hex")}\n`;
    const held = heldLockBodies();
    // R2-01: the body is registered BEFORE the file exists, so that no reader in this process can see our own
    // file and mistake it for a predecessor's leftover. It stays registered only if the lock is taken.
    held.add(body);
    let acquired = false;
    try {
      let waited = 0;
      let breaks = 0;
      let vanished = 0;
      let unparsed: string | undefined;
      for (let iteration = 0; iteration < LOCK_MAX_ITERATIONS; iteration += 1) {
        if (await this.tryCreateLock(lockPath, body)) {
          acquired = true;
          return this.heldLock(key, lockPath, body, held);
        }
        const holder = await readLockFile(lockPath);
        if (holder === null) {
          vanished += 1;
          if (vanished <= 3) continue; // it was released between the two calls: try again at once
        } else {
          // A lock body that does not parse is a creator that died between create and write (or one about to write):
          // it is judged stale only when the same unparseable content is seen twice, one poll apart. A lock naming a
          // pid that is gone is stale. So is one naming THIS process's own pid whose body this process does not hold
          // (R2-01): the pid is "alive" only because it is us, and `withProcessMutex` plus the held set guarantee that
          // no save of this process is inside that lock.
          const stale = holder.pid === undefined ? unparsed === holder.raw : holder.pid === process.pid ? !held.has(holder.raw) : !processAlive(holder.pid);
          if (stale) {
            breaks += 1;
            // R3-05: a leftover that cannot be removed is not "a save in this same process" and not "another instance":
            // it names the file a person removes.
            if (breaks > 5) throw new FlowStoreLockedError(key, lockPath, holder.pid, undefined, "stale");
            await this.breakLock(lockPath, holder.raw);
            unparsed = undefined;
            continue;
          }
          unparsed = holder.pid === undefined ? holder.raw : undefined;
          if (holder.pid !== undefined && waited >= this.lockWaitMs) throw new FlowStoreLockedError(key, lockPath, holder.pid);
        }
        if (holder === null && waited >= this.lockWaitMs) throw new FlowStoreLockedError(key, lockPath, undefined, "the lock file could not be created or read");
        await sleep(LOCK_POLL_MS);
        waited += LOCK_POLL_MS;
      }
      throw new FlowStoreLockedError(key, lockPath, undefined, "gave up taking the lock");
    } finally {
      if (!acquired) held.delete(body);
    }
  }

  private heldLock(key: string, lockPath: string, body: string, held: Set<string>): HeldLock {
    return {
      assertHeld: async () => {
        // R3-04: the reader release uses, which retries a transient EPERM, EBUSY or EACCES (a scanner or indexer holding
        // the file between the fsync and the rename). `readLockFile` answers `null` to those, which would be read here as
        // "removed or replaced" and fail a save that owns its lock.
        const now = await readLockFileRetrying(lockPath);
        if (now === undefined) throw new FlowStoreLockedError(key, lockPath, undefined, undefined, "unreadable");
        if (now === null || now.raw !== body) {
          throw new FlowStoreLockedError(key, lockPath, now?.pid, "the lock file was removed or replaced while this save held it; nothing was renamed", "lost");
        }
      },
      release: async () => {
        try {
          await removeOwnLock(lockPath, body);
        } finally {
          // R2-01: whatever happened to the file, this process no longer holds it. A file left behind names our pid
          // with a body that is not in the set, so this process's next acquire breaks it.
          held.delete(body);
        }
      },
    };
  }

  // --- the write ------------------------------------------------------------------------------------------------

  private async write(path: string, payload: Uint8Array, lock: HeldLock): Promise<void> {
    const header = Buffer.from(`flop-flow-store/1 sha256=${flowDigest(payload)} length=${payload.length}\n`, "latin1");
    const body = Buffer.concat([header, payload]);
    const tmpName = `${relative(this.dir, path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const tmp = this.underDir(tmpName);
    let renamed = false;
    try {
      const handle = await fsp.open(tmp, "wx", this.mode);
      try {
        if (this.platform !== "win32") await this.applyMode(handle);
        await handle.writeFile(body);
        await this.step("tmp-written", tmp);
        await handle.sync();
        await this.step("file-synced", tmp);
      } finally {
        await handle.close();
      }
      await lock.assertHeld(); // the last look before the swap: the critical section is still ours
      await this.renameOver(tmp, path);
      renamed = true;
      await this.step("renamed", path);
      if (this.platform === "win32") {
        // R1-20: a directory cannot be opened for fsync on Windows; flush the renamed file itself, best effort.
        if (await this.syncTarget(path)) await this.step("target-synced", path);
      } else {
        await this.syncDirectory();
        await this.step("dir-synced", this.dir);
      }
    } catch (error) {
      if (!renamed) await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** A umask can narrow the creation mode, so the mode is set again on the open file. A file system that cannot
   *  hold modes (FAT, some network mounts) is tolerated: the creation mode already applied is the best available. */
  private async applyMode(handle: FileHandle): Promise<void> {
    try {
      await handle.chmod(this.mode);
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !MODE_UNSUPPORTED.has(code)) throw error;
    }
  }

  private async step(step: FileSaveStep, path: string): Promise<void> {
    if (this.onStep !== undefined) await this.onStep(step, path);
  }

  private async renameOver(from: string, to: string): Promise<void> {
    const attempts = this.platform === "win32" ? 5 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fsp.rename(from, to);
        return;
      } catch (error) {
        const code = errorCode(error);
        if (attempt >= attempts || code === undefined || !RENAME_RETRY_CODES.has(code)) throw error;
        await sleep(20 * attempt);
      }
    }
  }

  /** fsync of the directory entry, so the rename itself survives a power cut. Only a file system that does not support
   *  it (EINVAL, ENOTSUP) is tolerated; EACCES, EPERM, EBADF and every other failure propagate (R1-20: they mean the
   *  rename may not be durable, and the flow must not act on it). */
  private async syncDirectory(): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await fsp.open(this.dir, "r");
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && DIR_FSYNC_UNSUPPORTED.has(code)) return;
      throw error;
    }
    try {
      await handle.sync();
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !DIR_FSYNC_UNSUPPORTED.has(code)) throw error;
    } finally {
      await handle.close();
    }
  }

  /** Windows: flush the renamed file (best effort; the platform may refuse while a scanner holds it). True when it
   *  was flushed. */
  private async syncTarget(path: string): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await fsp.open(path, "r+");
      await handle.sync();
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const keys: string[] = [];
    for (const name of names) {
      const match = FILE_NAME_PATTERN.exec(name);
      if (match !== null) keys.push(`${match[1]}:${match[2]}`);
    }
    return keys.sort();
  }
}
