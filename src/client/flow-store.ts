// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Surface" (rule 1 "durable before visible", rule 6 "fail closed on bad state"): the
// persistence surface a Buyer or Seller flow writes its swap record through, so a fresh process given the same
// store can continue the swap. Three things live here and nothing else:
//
//   - `FlowStore`: three methods over opaque bytes. `save` resolves only once the bytes are durable.
//   - `MemoryFlowStore`: the test store. It logs every save and can fail the n-th one in two ways (the write
//     is refused, or the write commits and the call still throws), which is how the crash matrix cuts a flow
//     "after the action, before the store confirmed it".
//   - `FileFlowStore`: one file per key under a runner-owned directory, written temp file + fsync + rename +
//     directory fsync (the directory fsync is skipped on Windows, which cannot open a directory for it). The
//     file carries a one-line header with the payload's length and sha256, so a truncated or corrupted file is
//     a `FlowStoreCorruptError` on `load`, never an empty answer (the watcher's `state.json` habit of resetting
//     on a bad read is deliberately NOT copied).
//
// Keys are `buyer:<swapId>` and `seller:<swapId>` (swapId = `0x` + 64 lowercase hex, `src/profile.ts`). The key
// is checked against that grammar on every call, and the file name is built only from the checked parts, so
// nothing outside `dir` can be reached; `underDir` is the watcher's `underRoot` idea, applied a second time.
//
// File names: the key's `:` is not a legal character in a Windows file name (it opens an NTFS alternate data
// stream), so a key is stored as `<role>-<swapId>.json`; `list()` maps the names back to keys.
//
// This directory is secret-grade, exactly like a key file: the Seller's record holds the swap preimage.

import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/** `buyer` or `seller`: whose record a key names. */
export type FlowRole = "buyer" | "seller";

/** The stable shape of a swap id (`0x` + sha256 hex), the same shape `isSwapId` in `src/profile.ts` checks. */
const SWAP_ID_SHAPE = /^0x[0-9a-f]{64}$/;

/** The key grammar: `buyer:<swapId>` or `seller:<swapId>`. */
export const FLOW_KEY_PATTERN = /^(buyer|seller):(0x[0-9a-f]{64})$/;

/** The file-name form of a key, `<role>-<swapId>.json`. */
const FILE_NAME_PATTERN = /^(buyer|seller)-(0x[0-9a-f]{64})\.json$/;

/** The first line of a `FileFlowStore` file: format tag, payload sha256, payload length. */
const HEADER_PATTERN = /^flop-flow-store\/1 sha256=([0-9a-f]{64}) length=([0-9]+)\n/;

// --- errors ---------------------------------------------------------------------------------------------------

/** Base of every error this module throws, so a caller can tell a store problem from a flow problem. */
export class FlowStoreError extends Error {
  constructor(message: string) {
    super(message);
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

/** A key that does not match `buyer:<swapId>` or `seller:<swapId>`. */
export class FlowStoreKeyError extends FlowStoreError {
  constructor(key: unknown) {
    super(`flow store: key must be "buyer:<swapId>" or "seller:<swapId>" with swapId = 0x + 64 lowercase hex, got ${JSON.stringify(key)}`);
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

/** The failure a `MemoryFlowStore` injects on purpose (never thrown by a real store). */
export class FlowStoreFaultError extends FlowStoreError {
  readonly saveNumber: number;
  readonly mode: MemoryFault;
  constructor(saveNumber: number, mode: MemoryFault) {
    super(`flow store: injected fault on save number ${saveNumber} (${mode})`);
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
  /** Saves `bytes` under `key`, replacing the old value whole. Resolves only once the bytes are durable. */
  save(key: string, bytes: Uint8Array): Promise<void>;
  /** Every key with a saved value, sorted. */
  list(): Promise<string[]>;
}

/** Builds a key, checking the swap id's shape. */
export function flowKey(role: FlowRole, swapId: string): string {
  const key = `${role}:${swapId}`;
  if (role !== "buyer" && role !== "seller") throw new FlowStoreKeyError(key);
  if (!SWAP_ID_SHAPE.test(swapId)) throw new FlowStoreKeyError(key);
  return key;
}

/** Splits a key into its parts, or throws `FlowStoreKeyError`. */
export function parseFlowKey(key: string): { role: FlowRole; swapId: string } {
  const match = typeof key === "string" ? FLOW_KEY_PATTERN.exec(key) : null;
  if (match === null) throw new FlowStoreKeyError(key);
  return { role: match[1] as FlowRole, swapId: match[2] as string };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
  /** `ok`, or the fault that was injected on this call. */
  readonly outcome: "ok" | MemoryFault;
}

/**
 * The test store. Values are held as copies (a caller mutating its array afterwards changes nothing), every
 * `save` is logged in `saves`, and a save can be made to fail: `failSave(n, mode)` fails the n-th call (1-based,
 * across all keys); `failSaveWhen(predicate)` decides per call. Both modes of `MemoryFault` are available.
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

  /** How many `save` calls have been made (failed ones included). */
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

  async save(key: string, bytes: Uint8Array): Promise<void> {
    parseFlowKey(key);
    const copy = bytes.slice();
    const n = this.log.length + 1;
    const fault = this.byNumber.get(n) ?? this.predicate?.(n, key, copy.slice());
    this.log.push({ n, key, bytes: copy.slice(), outcome: fault ?? "ok" });
    if (fault === "reject") throw new FlowStoreFaultError(n, fault);
    this.values.set(key, copy);
    if (fault === "commit-then-throw") throw new FlowStoreFaultError(n, fault);
  }

  async list(): Promise<string[]> {
    return [...this.values.keys()].sort();
  }
}

// --- FileFlowStore -----------------------------------------------------------------------------------------------

/** The stages of one `FileFlowStore.save`, in order. `dir-synced` does not occur on Windows. */
export type FileSaveStep = "tmp-written" | "file-synced" | "renamed" | "dir-synced";

export interface FileFlowStoreOptions {
  /** File mode for the saved files. Default `0o600`. Honoured where the platform honours modes (not Windows). */
  mode?: number;
  /** Test seam: called after each stage of `save`. A throw aborts the save at that stage, which is how a test
   *  stands in for "the process died here". Not for production use. */
  onStep?: (step: FileSaveStep, path: string) => void | Promise<void>;
}

/** The platform codes for which a directory fsync is simply not supported (so its absence is not a failure). */
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR", "EACCES", "EBADF"]);

/** The platform codes for which a file mode cannot be set (so its absence is not a failure). */
const MODE_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EINVAL"]);

/** The Windows codes a rename can fail with while a scanner or indexer briefly holds the target; retried a few times. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * One file per key under `dir`. `save`: write `<name>.json.tmp-<pid>-<random>` in the same directory (created
 * exclusively, mode `options.mode`), fsync it, rename it onto `<name>.json`, then fsync the directory (skipped
 * on win32). Saves through one instance are serialised. `load` verifies the header's length and sha256 and throws
 * `FlowStoreCorruptError` on any mismatch. Stale `.tmp-` files left by a crash are never read and never listed.
 */
export class FileFlowStore implements FlowStore {
  private readonly dir: string;
  private readonly mode: number;
  private readonly onStep: FileFlowStoreOptions["onStep"];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, options: FileFlowStoreOptions = {}) {
    if (typeof dir !== "string" || dir === "") throw new FlowStorePathError("flow store: dir must be a non-empty path");
    this.dir = resolve(dir);
    const mode = options.mode ?? 0o600;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new FlowStorePathError("flow store: mode must be an integer 0..0o777");
    this.mode = mode;
    this.onStep = options.onStep;
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

  async load(key: string): Promise<Uint8Array | null> {
    const path = this.pathFor(key);
    let file: Buffer;
    try {
      file = await fsp.readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    const newline = file.indexOf(0x0a);
    if (newline < 0) throw new FlowStoreCorruptError(key, "no header line");
    const header = HEADER_PATTERN.exec(file.subarray(0, newline + 1).toString("latin1"));
    if (header === null) throw new FlowStoreCorruptError(key, "unrecognised header");
    const payload = file.subarray(newline + 1);
    const length = Number(header[2]);
    if (!Number.isSafeInteger(length) || payload.length !== length) {
      throw new FlowStoreCorruptError(key, `payload is ${payload.length} bytes, the header says ${header[2]}`);
    }
    if (sha256Hex(payload) !== header[1]) throw new FlowStoreCorruptError(key, "payload sha256 does not match the header");
    return Uint8Array.from(payload);
  }

  async save(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key); // grammar + containment are checked before anything is queued or touched
    const payload = Uint8Array.from(bytes);
    const run = this.queue.then(() => this.write(path, payload));
    this.queue = run.catch(() => undefined);
    await run;
  }

  private async write(path: string, payload: Uint8Array): Promise<void> {
    const header = Buffer.from(`flop-flow-store/1 sha256=${sha256Hex(payload)} length=${payload.length}\n`, "latin1");
    const body = Buffer.concat([header, payload]);
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmpName = `${relative(this.dir, path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const tmp = this.underDir(tmpName);
    let renamed = false;
    try {
      const handle = await fsp.open(tmp, "wx", this.mode);
      try {
        if (process.platform !== "win32") await this.applyMode(handle);
        await handle.writeFile(body);
        await this.step("tmp-written", tmp);
        await handle.sync();
        await this.step("file-synced", tmp);
      } finally {
        await handle.close();
      }
      await this.renameOver(tmp, path);
      renamed = true;
      await this.step("renamed", path);
      if (process.platform !== "win32") {
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
    const attempts = process.platform === "win32" ? 5 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fsp.rename(from, to);
        return;
      } catch (error) {
        const code = errorCode(error);
        if (attempt >= attempts || code === undefined || !RENAME_RETRY_CODES.has(code)) throw error;
        await new Promise<void>((done) => setTimeout(done, 20 * attempt));
      }
    }
  }

  /** fsync of the directory entry, so the rename itself survives a power cut. A platform or file system that
   *  cannot fsync a directory is tolerated (its codes are named above); every other failure propagates. */
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
