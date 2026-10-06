// SPDX-License-Identifier: MIT
//
// P9-6: the local world the EVM rehearsal runner (bin/swap-rehearsal-evm.mjs) keeps in its state directory, so that a process
// that is killed can be replaced by a fresh one (`--resume`): the P8 flow records live in `FileFlowStore` directories, and this
// module holds the three other things a swap needs to outlive its process.
//
//   - `DurableVenue`: the in-memory venue (`MemoryVenue`, src/client/venue.ts) made durable. Same rooms, same per-room `seq`, the
//     same nonce and signature rule (so `verifyTranscriptRecord` and `examples/audit-export.mjs` accept its records exactly as
//     they accept a `MemoryVenue`'s), but every post is written to one JSON file BEFORE `post` resolves. A venue is the outside
//     world of a flow: a post a flow was told succeeded must still be there after a restart, and a post that never returned
//     must not be, which is what an atomic write (temp file, fsync, rename) gives. Nothing here is a network venue: the runner
//     posts to no HTTP service (rule 4).
//   - `DurableNoteStore`: tclk's `MemoryNoteStore` (the leg-B paper rail's notes) made durable the same way. Paper notes hold no
//     value and anyone could write them on a real venue; here they are one local file.
//   - the two Ed25519 signing seeds of the parties' `did:key` identities (the venue's chat-signing keys, never wallets): minted
//     once from the system CSPRNG into the state directory with mode 0600, read back on every later run. They sign only lines
//     of this local venue; nothing public ever sees them. They are secret-grade like the flow records beside them.
//
// Also here: the atomic file write the three share, and the one-runner-per-state-directory lock (O_EXCL, pid; a lock whose
// holder is gone is broken, like the flow store's).
//
// Fail closed: a world file that does not parse or whose records do not add up is a typed error, never an empty world (a
// swap must not restart on an empty venue because a file was damaged). No key of any kind for an EVM account passes through
// this module.

import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import type { NoteStore, TranscriptRecord } from "@flop-labs/tclk";

import type { Signer, Venue } from "./venue.js";

/** A damaged or unreadable world file. */
export class RehearsalWorldError extends Error {
  constructor(message: string) {
    super(`rehearsal state: ${message}`);
    this.name = "RehearsalWorldError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((done) => setTimeout(done, ms));

/** The codes a rename can fail with while a scanner or indexer briefly holds the target (Windows); retried a few times. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Writes `text` to `path` durably and atomically: a temp file in the same directory (created exclusively, `mode`), fsync, then
 * rename over `path`. A reader sees the old content or the new content, never a mixture, and a returned promise means the bytes
 * were handed to the disk. (A directory sync is not attempted: Windows cannot, and the README says a power cut may bring back the
 * previous state, which a resumed run then recovers from like any crash.)
 */
export async function writeFileDurable(path: string, text: string, mode = 0o600): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await fsp.open(tmp, "wx", mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(tmp, path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !RENAME_RETRY_CODES.has(code) || attempt >= 6) {
        await fsp.rm(tmp, { force: true });
        throw error;
      }
      await sleep(20 * attempt);
    }
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

// --- the venue --------------------------------------------------------------------------------------------------------------

interface VenueFile {
  v: 1;
  rooms: Record<string, TranscriptRecord[]>;
}

function isRecordShape(value: unknown, room: string, seq: number): value is TranscriptRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  return (
    keys === "line,nonce,room,sender,seq,signature,timestampMs" &&
    r.room === room &&
    r.seq === seq &&
    typeof r.timestampMs === "number" &&
    Number.isSafeInteger(r.timestampMs) &&
    typeof r.sender === "string" &&
    typeof r.nonce === "string" &&
    typeof r.signature === "string" &&
    typeof r.line === "string"
  );
}

/**
 * `MemoryVenue`'s twin that keeps its rooms in one file. Open it with `DurableVenue.open`; every `post` rewrites the file (a few
 * kilobytes) before it resolves. Posts are serialised, so two overlapping calls can never write over each other.
 */
export class DurableVenue implements Venue {
  private readonly path: string;
  private readonly clock: () => number;
  private readonly rooms: Map<string, TranscriptRecord[]>;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(path: string, clock: () => number, rooms: Map<string, TranscriptRecord[]>) {
    this.path = path;
    this.clock = clock;
    this.rooms = rooms;
  }

  /** Loads the venue file (absent: an empty venue) and checks every record's shape and sequence number. */
  static async open(path: string, clock: () => number): Promise<DurableVenue> {
    const text = await readIfExists(path);
    const rooms = new Map<string, TranscriptRecord[]>();
    if (text !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RehearsalWorldError(`the venue file ${path} is not valid JSON; it holds the swap's frames and is never replaced by an empty one`);
      }
      const file = parsed as Partial<VenueFile> | null;
      if (file === null || typeof file !== "object" || file.v !== 1 || file.rooms === null || typeof file.rooms !== "object" || Array.isArray(file.rooms)) {
        throw new RehearsalWorldError(`the venue file ${path} is not a version 1 venue`);
      }
      for (const [room, records] of Object.entries(file.rooms)) {
        if (!Array.isArray(records)) throw new RehearsalWorldError(`the venue file ${path} has a room that is not a list`);
        records.forEach((record, index) => {
          if (!isRecordShape(record, room, index + 1)) throw new RehearsalWorldError(`the venue file ${path} holds a record that does not fit room ${room} at position ${index + 1}`);
        });
        rooms.set(room, [...records]);
      }
    }
    return new DurableVenue(path, clock, rooms);
  }

  post(room: string, line: string, signer: Signer): Promise<TranscriptRecord> {
    const run = this.chain.then(() => this.postNow(room, line, signer));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async postNow(room: string, line: string, signer: Signer): Promise<TranscriptRecord> {
    const records = [...(this.rooms.get(room) ?? [])];
    const seq = records.length + 1;
    const nonce = String(10_000 + seq);
    const record: TranscriptRecord = {
      room,
      seq,
      timestampMs: this.clock(),
      sender: signer.did,
      nonce,
      signature: signer.sign(`${room}|${nonce}|${line}`),
      line,
    };
    records.push(record);
    const next = new Map(this.rooms);
    next.set(room, records);
    await writeFileDurable(this.path, serializeVenue(next));
    // The file holds it: only now is it a post (a flow told it failed must not find the line later; a flow told it succeeded must).
    this.rooms.set(room, records);
    return record;
  }

  async read(room: string): Promise<readonly TranscriptRecord[]> {
    return [...(this.rooms.get(room) ?? [])];
  }
}

function serializeVenue(rooms: ReadonlyMap<string, readonly TranscriptRecord[]>): string {
  const file: VenueFile = { v: 1, rooms: Object.fromEntries([...rooms.entries()].map(([room, records]) => [room, [...records]])) };
  return `${JSON.stringify(file, null, 1)}\n`;
}

// --- the paper notes --------------------------------------------------------------------------------------------------------

interface NotesFile {
  v: 1;
  notes: Record<string, string>;
}

/** tclk's `MemoryNoteStore` with the same conditional-write rules, kept in one file and written before `set` resolves. */
export class DurableNoteStore implements NoteStore {
  private readonly path: string;
  private readonly values: Map<string, string>;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(path: string, values: Map<string, string>) {
    this.path = path;
    this.values = values;
  }

  static async open(path: string): Promise<DurableNoteStore> {
    const text = await readIfExists(path);
    const values = new Map<string, string>();
    if (text !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RehearsalWorldError(`the notes file ${path} is not valid JSON; it holds the paper leg and is never replaced by an empty one`);
      }
      const file = parsed as Partial<NotesFile> | null;
      if (file === null || typeof file !== "object" || file.v !== 1 || file.notes === null || typeof file.notes !== "object" || Array.isArray(file.notes)) {
        throw new RehearsalWorldError(`the notes file ${path} is not a version 1 notes file`);
      }
      for (const [key, value] of Object.entries(file.notes)) {
        if (typeof value !== "string") throw new RehearsalWorldError(`the notes file ${path} holds a note that is not text`);
        values.set(key, value);
      }
    }
    return new DurableNoteStore(path, values);
  }

  async get(ns: string, key: string): Promise<string | null> {
    return this.values.get(`${ns}/${key}`) ?? null;
  }

  set(ns: string, key: string, value: string, condition?: { ifAbsent: true } | { if: string }): Promise<boolean> {
    const run = this.chain.then(() => this.setNow(ns, key, value, condition));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async setNow(ns: string, key: string, value: string, condition?: { ifAbsent: true } | { if: string }): Promise<boolean> {
    const path = `${ns}/${key}`;
    const current = this.values.get(path);
    if (condition !== undefined) {
      if ("ifAbsent" in condition && current !== undefined) return false;
      if ("if" in condition && current !== condition.if) return false;
    }
    const next = new Map(this.values);
    next.set(path, value);
    const file: NotesFile = { v: 1, notes: Object.fromEntries(next.entries()) };
    await writeFileDurable(this.path, `${JSON.stringify(file, null, 1)}\n`);
    this.values.set(path, value);
    return true;
  }

  /** The raw stored line, exactly as a reader of the venue would see it (what a bundle carries). */
  raw(ns: string, key: string): string | undefined {
    return this.values.get(`${ns}/${key}`);
  }
}

// --- the parties' Ed25519 identities -----------------------------------------------------------------------------------------

/** A tclk `did:key` identity: the same shape as `Signer` plus nothing else. The seed is held in a closure and is not a member. */
export type RehearsalIdentity = Signer;

const SEED_FILE = /^[0-9a-f]{64}\n?$/;

function identityFromSeed(seed: Uint8Array): RehearsalIdentity {
  const publicKey = ed25519.getPublicKey(seed);
  const did = `did:key:z${base58.encode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
  const identity = {
    did,
    sign(canonical: string): string {
      return base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed));
    },
  };
  // Only the DID is ever shown: a spread, JSON.stringify or util.inspect of the identity cannot reach the seed (it is not a member).
  return Object.freeze(identity);
}

/**
 * Reads the Ed25519 seed file at `path`, or mints a fresh seed from the system CSPRNG and writes it there (mode 0600, created
 * exclusively: an existing file is never overwritten). The seed is returned only as the identity that signs with it.
 */
export async function loadOrCreateIdentity(path: string): Promise<RehearsalIdentity> {
  const existing = await readIfExists(path);
  if (existing !== null) {
    if (!SEED_FILE.test(existing)) throw new RehearsalWorldError(`the identity file ${path} is not 64 hex digits; it is never replaced by a new one`);
    return identityFromSeed(Uint8Array.from(Buffer.from(existing.trim(), "hex")));
  }
  const seed = randomBytes(32);
  await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await fsp.open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${seed.toString("hex")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return identityFromSeed(Uint8Array.from(seed));
}

// --- one runner per state directory -----------------------------------------------------------------------------------------

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

export class RunLockedError extends Error {
  readonly pid: number;
  constructor(path: string, pid: number) {
    super(`another rehearsal runner (pid ${pid}) is using this state directory (${path}); one runner per swap`);
    this.name = "RunLockedError";
    this.pid = pid;
  }
}

/**
 * Takes the state directory's runner lock (`runner.lock`, created exclusively, holding this process's pid) and returns the
 * function that releases it. A lock whose pid is gone, or is this very pid (a predecessor that died and a restart under the same
 * pid: a container's pid 1), is a leftover and is broken; a lock held by another live process is a `RunLockedError`. The
 * flow records have their own single-writer fence; this one keeps two runners off the venue and note files.
 */
export async function acquireRunLock(stateDir: string): Promise<() => Promise<void>> {
  const path = join(stateDir, "runner.lock");
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const body = `${process.pid}\n${randomBytes(8).toString("hex")}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fsp.open(path, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        const now = await readIfExists(path).catch(() => null);
        if (now === body) await fsp.rm(path, { force: true });
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const held = await readIfExists(path);
    if (held === null) continue;
    const pid = Number.parseInt(held.split("\n")[0] ?? "", 10);
    if (Number.isInteger(pid) && pid !== process.pid && processAlive(pid)) throw new RunLockedError(path, pid);
    await fsp.rm(path, { force: true });
  }
  throw new RehearsalWorldError(`could not take the runner lock ${path}`);
}
