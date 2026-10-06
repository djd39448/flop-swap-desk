// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Surface" (flow API additions), rules 1, 3 and 6: the part of resume that BuyerFlow and
// SellerFlow share. Three things live here and nothing else:
//
//   - the typed errors and the `next` step names `resume` hands back;
//   - `FlowJournal`: the flow's handle on its ONE persisted record. It holds the current record in memory,
//     saves it through a `FlowStore` (bumping the revision, one save at a time, in order), and owns the frame
//     ledger rules: a frame's exact text is written BEFORE `venue.post` (rule 1), is re-posted only as that
//     identical text and only after a room read shows it absent, and an identical text already in the room is
//     adopted (rule 3);
//   - small conversions between a signed venue record and its plain-JSON form.
//
// The journal adopts a record in memory BEFORE its save resolves. If the save then throws, the flow keeps going
// from what it intended, and the step that failed has not run its outward action yet (the intent is saved before
// the action), so the outcome of that action is "unknown" only in the sense the record already says: the next
// call goes through the step's recover path, which reads the chain and the venue (rule 2).

import { createHash } from "node:crypto";
import { tryDecodeFrame, verifyTranscriptRecord, type AcceptFrame, type OfferFrame, type TranscriptRecord } from "@flop-labs/tclk";

import type { RailAccounts } from "./counter-rail.js";
import {
  FlowRecordConflictError,
  FlowRecordError,
  bumped,
  cloneFlowRecord,
  encodeFlowRecord,
  ledgerEntry,
  loadFlowRecord,
  withLedgerIntent,
  type FlowRecord,
  type FrameSlot,
  type LedgerKind,
  type RailAccountsJson,
  type SwapFrames,
  type TranscriptRecordJson,
} from "./flow-record.js";
import { FlowStoreCorruptError, flowKey, type FlowRole, type FlowStore } from "./flow-store.js";
import type { Signer, Venue } from "./venue.js";

// --- errors and step names ------------------------------------------------------------------------------------------

/** `resume` found nothing under the key. A swap that never persisted anything has nothing to continue: start a new
 *  flow. Never read as an empty record (rule 6). */
export class FlowNotFoundError extends FlowRecordError {
  readonly key: string;
  constructor(key: string) {
    super(`flow resume: the store holds no record for "${key}"; nothing was persisted for this swap, so there is nothing to resume`);
    this.name = "FlowNotFoundError";
    this.key = key;
  }
}

/** A NEW flow (not `resume`) found a record already stored under its key. Overwriting it would silently reset a swap
 *  (rule 6): the runner must call `resume`, or pick another store. */
export class FlowRecordExistsError extends FlowRecordError {
  readonly key: string;
  constructor(key: string) {
    super(`flow store: "${key}" already holds a record; call resume() to continue that swap instead of starting it over`);
    this.name = "FlowRecordExistsError";
    this.key = key;
  }
}

/** The next safe step of a resumed Seller, by method name. After leg B's `refundAfterMs` a runner may call
 *  `refundLegB` in place of `claimLegA`; `"done"` means every outward action of the swap is recorded as finished. */
export type SellerNextStep = "acceptLegA" | "postAccountLineA" | "lockLegB" | "claimLegA" | "refundLegB" | "done";

/** The next safe step of a resumed Buyer, by method name. `"learnSecret"` is also the way back into `claimLegB`: the
 *  secret is never stored on a Buyer record, so it is read again from the venue or the chain. After leg A's
 *  `refundAfterMs` a runner may call `refundLegA` in place of `learnSecret`. */
export type BuyerNextStep =
  | "bid"
  | "acceptLegB"
  | "verifyLegBLocked"
  | "postAccountLineA"
  | "lockLegA"
  | "learnSecret"
  | "refundLegA"
  | "done";

// --- conversions ----------------------------------------------------------------------------------------------------

export function recordToJson(record: TranscriptRecord): TranscriptRecordJson {
  return {
    room: record.room,
    seq: record.seq,
    timestampMs: record.timestampMs,
    sender: record.sender,
    nonce: record.nonce,
    signature: record.signature,
    line: record.line,
  };
}

export function recordFromJson(json: TranscriptRecordJson): TranscriptRecord {
  return {
    room: json.room,
    seq: json.seq,
    timestampMs: json.timestampMs,
    sender: json.sender,
    nonce: json.nonce,
    signature: json.signature,
    line: json.line,
  };
}

/** What a ledger entry holds for a frame whose text carries the swap secret and whose party must not store the secret
 *  (a Buyer's reveal of leg B): the digest of the exact text. "Same bytes" is still checkable: the text is rebuilt
 *  from the secret learned again, and its digest must equal this one. */
export function digestOfText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function accountsToJson(accounts: RailAccounts): RailAccountsJson {
  const out: RailAccountsJson = {};
  if (accounts.payer !== undefined) out.payer = accounts.payer;
  if (accounts.payee !== undefined) out.payee = accounts.payee;
  if (accounts.payerKey !== undefined) out.payerKey = accounts.payerKey;
  if (accounts.payeeKey !== undefined) out.payeeKey = accounts.payeeKey;
  return out;
}

export function accountsFromJson(json: RailAccountsJson): RailAccounts {
  const out: RailAccounts = {};
  if (json.payer !== undefined) out.payer = json.payer;
  if (json.payee !== undefined) out.payee = json.payee;
  if (json.payerKey !== undefined) out.payerKey = json.payerKey;
  if (json.payeeKey !== undefined) out.payeeKey = json.payeeKey;
  return out;
}

/** True when the record's ledger shows `kind` as landed. */
export function ledgerLanded(record: FlowRecord, kind: LedgerKind): boolean {
  return ledgerEntry(record, kind)?.landed !== undefined;
}

/** The offer frame a frame slot holds, or a `FlowStoreCorruptError` naming the slot (a stored text that is not an
 *  offer frame can only mean a damaged or foreign record). `undefined` for an empty slot. */
export function offerFromSlot(key: string, name: string, slot: FrameSlot | undefined): OfferFrame | undefined {
  if (slot === undefined) return undefined;
  const frame = tryDecodeFrame(slot.text);
  if (frame === null || frame.type !== "offer") throw new FlowStoreCorruptError(key, `frames.${name}.text is not an offer frame`);
  return frame;
}

/** The accept frame a frame slot holds (see `offerFromSlot`). */
export function acceptFromSlot(key: string, name: string, slot: FrameSlot | undefined): AcceptFrame | undefined {
  if (slot === undefined) return undefined;
  const frame = tryDecodeFrame(slot.text);
  if (frame === null || frame.type !== "accept") throw new FlowStoreCorruptError(key, `frames.${name}.text is not an accept frame`);
  return frame;
}

/** The signed venue record a frame slot holds, checked: it must authenticate and be sent by `sender`. */
export function slotRecord(key: string, name: string, slot: FrameSlot | undefined, sender: string): TranscriptRecord | undefined {
  if (slot?.record === undefined) return undefined;
  const record = recordFromJson(slot.record);
  if (!verifyTranscriptRecord(record).ok) throw new FlowStoreCorruptError(key, `frames.${name}.record does not authenticate`);
  if (record.sender !== sender) throw new FlowStoreCorruptError(key, `frames.${name}.record was not sent by the party that frame names`);
  return record;
}

// --- the journal ----------------------------------------------------------------------------------------------------

export interface JournalDeps {
  store: FlowStore;
  venue: Venue;
  identity: Signer;
  clock: () => number;
}

/** One frame (or line) this party posts, as the journal needs to know it. */
export interface PostSpec {
  kind: LedgerKind;
  room: string;
  text: string;
  /** Persist only `digestOfText(text)` in the ledger (the Buyer's reveal of leg B: the record never holds the secret). */
  digestOnly?: boolean;
  /** Runs when the text is not yet in the room and is about to be posted, with the room as just read. A throw refuses
   *  the post (and, for a first-time post, leaves no ledger entry behind). Forces a room read even for a first post. */
  guard?: (roomRecords: readonly TranscriptRecord[]) => void;
  /** Replaces `venue.post` (the Seller's bounded reveal post on Solana). */
  post?: (room: string, text: string) => Promise<TranscriptRecord>;
  /** Replaces `venue.read` for the look-before-post (a bounded read). */
  read?: (room: string) => Promise<readonly TranscriptRecord[]>;
  /** The record's frame slot this text fills (`offerA`, `acceptA`, `offerB`, `acceptB`): once the line is known
   *  (posted or adopted) the slot gets its signed venue record in the SAME save that marks the ledger entry landed. */
  slot?: keyof SwapFrames;
}

export class FlowJournal<R extends FlowRecord> {
  private current: R;
  private tail: Promise<void> = Promise.resolve();
  private readonly inflight = new Map<LedgerKind, Promise<TranscriptRecord>>();
  private readonly deps: JournalDeps;
  private readonly key: string;
  private projector: ((record: R) => R) | undefined;

  private constructor(deps: JournalDeps, initial: R) {
    this.deps = deps;
    this.current = initial;
    this.key = flowKey(initial.role, initial.swapId);
  }

  /** Starts the journal of a NEW swap: refuses (typed) if the store already holds a record under the key, then saves
   *  `initial` as the first version (its revision is kept as given). */
  static async begin<T extends FlowRecord>(deps: JournalDeps, initial: T): Promise<FlowJournal<T>> {
    const key = flowKey(initial.role, initial.swapId);
    if ((await deps.store.load(key)) !== null) throw new FlowRecordExistsError(key);
    const journal = new FlowJournal<T>(deps, initial);
    await journal.write(initial);
    return journal;
  }

  /** The journal of an existing swap, from its stored record. A missing record is `FlowNotFoundError`; a damaged,
   *  foreign-version or foreign-key record throws the typed error `loadFlowRecord` names. */
  static async open(deps: JournalDeps, role: FlowRole, swapId: string): Promise<FlowJournal<FlowRecord>> {
    const record = await loadFlowRecord(deps.store, role, swapId);
    if (record === null) throw new FlowNotFoundError(flowKey(role, swapId));
    return new FlowJournal<FlowRecord>(deps, record);
  }

  /** The record as the flow last adopted it (a copy is made on every save; treat this as read-only). */
  get record(): R {
    return this.current;
  }

  /** Registers the flow's projection of its live state onto a record. Every later save runs `next` through it, so a
   *  save always carries the latest latches the flow holds, whatever step made the save. */
  setProjector(projector: (record: R) => R): void {
    this.projector = projector;
  }

  /** Adopts `next` (projected, revision + 1, `updatedAtMs` from the clock) and saves it. Resolves once the bytes are
   *  durable. */
  async save(next: R): Promise<void> {
    const projected = this.projector === undefined ? next : this.projector(next);
    await this.write(bumped(projected, this.deps.clock()));
  }

  /** `save(update(record))`. */
  async update(update: (record: R) => R): Promise<void> {
    await this.save(update(this.current));
  }

  /** Validates (a record that would not read back is refused before anything is adopted), adopts, then saves. Saves
   *  go out one at a time in the order they were made. */
  private async write(next: R): Promise<void> {
    const bytes = encodeFlowRecord(next);
    this.current = next;
    const run = this.tail.then(() => this.deps.store.save(this.key, bytes));
    this.tail = run.catch(() => undefined);
    await run;
  }

  /** The ledger text a spec stores. */
  private ledgerText(spec: PostSpec): string {
    return spec.digestOnly === true ? digestOfText(spec.text) : spec.text;
  }

  /** This party's own authenticated record in `records` carrying exactly `text`, if any. */
  findOwn(records: readonly TranscriptRecord[], text: string): TranscriptRecord | null {
    for (const candidate of records) {
      if (candidate.sender !== this.deps.identity.did || candidate.line !== text) continue;
      if (verifyTranscriptRecord(candidate).ok) return candidate;
    }
    return null;
  }

  /**
   * Gets `spec.text` into `spec.room` exactly once, as the identical bytes: the intent is saved BEFORE anything is
   * posted (rule 1); if the ledger already holds this kind (an earlier attempt, possibly landed) the room is read
   * first and an identical own line is ADOPTED instead of posted again (rule 3); a ledger entry with a DIFFERENT text
   * or room makes this throw `FlowRecordConflictError` before anything is read or posted (a party never posts a
   * second, different frame). The landed `seq` and `nonce` are saved after the post. Two calls for the same kind that
   * overlap share one attempt.
   */
  ensurePosted(spec: PostSpec): Promise<TranscriptRecord> {
    const running = this.inflight.get(spec.kind);
    if (running !== undefined) return running;
    const attempt = this.postOnce(spec).finally(() => this.inflight.delete(spec.kind));
    this.inflight.set(spec.kind, attempt);
    return attempt;
  }

  private async postOnce(spec: PostSpec): Promise<TranscriptRecord> {
    const text = this.ledgerText(spec);
    // Throws FlowRecordConflictError when this kind was recorded with another room or text; returns `current` itself
    // (same object) when the entry already exists identically.
    const isNew = withLedgerIntent(this.current, { kind: spec.kind, room: spec.room, text }) !== this.current;

    let records: readonly TranscriptRecord[] | undefined;
    if (!isNew || spec.guard !== undefined) {
      records = await (spec.read ?? ((room: string) => this.deps.venue.read(room)))(spec.room);
      const found = this.findOwn(records, spec.text);
      if (found !== null) {
        await this.markLanded(spec, text, found, true);
        return found;
      }
    }
    if (spec.guard !== undefined) spec.guard(records ?? []);
    // Durable BEFORE visible. Derived from the latest record at this moment, not from the one read above: another step
    // may have saved while the room was being read.
    if (isNew) await this.save(withLedgerIntent(this.current, { kind: spec.kind, room: spec.room, text }));
    const posted = await (spec.post ?? ((room: string, line: string) => this.deps.venue.post(room, line, this.deps.identity)))(spec.room, spec.text);
    await this.markLanded(spec, text, posted, false);
    return posted;
  }

  /** Records a line this party already posted (found in the room by the caller) as the one for `kind`: the ledger
   *  entry is written if missing and marked landed, in one save. A ledger entry with another text or room throws. */
  async adopt(spec: Pick<PostSpec, "kind" | "room" | "text" | "digestOnly" | "slot">, record: TranscriptRecord): Promise<void> {
    await this.markLanded(spec, this.ledgerText(spec), record, true);
  }

  /** Saves `record`'s `seq` and `nonce` on the ledger entry of `spec.kind` (writing the entry first, in the same save,
   *  when `ensureIntent`). Overwrites an older landed mark (a room read just showed the line elsewhere or posted it
   *  anew). Derived from the latest record, saved in the same synchronous step. */
  private async markLanded(spec: Pick<PostSpec, "kind" | "room" | "text" | "slot">, ledgerText: string, record: TranscriptRecord, ensureIntent: boolean): Promise<void> {
    const from = ensureIntent ? withLedgerIntent(this.current, { kind: spec.kind, room: spec.room, text: ledgerText }) : this.current;
    const existing = ledgerEntry(from, spec.kind);
    if (existing === undefined) throw new FlowRecordConflictError(`flow record: "${spec.kind}" has no ledger entry to mark as landed`);
    const slotKnown = spec.slot === undefined || from.frames[spec.slot]?.record?.seq === record.seq;
    if (from === this.current && existing.landed?.seq === record.seq && existing.landed.nonce === record.nonce && slotKnown) return;
    const copy = cloneFlowRecord(from);
    const entry = ledgerEntry(copy, spec.kind);
    if (entry === undefined) throw new FlowRecordConflictError("flow record: ledger entry vanished on copy"); // unreachable
    entry.landed = { seq: record.seq, nonce: record.nonce };
    if (spec.slot !== undefined) copy.frames[spec.slot] = { text: spec.text, record: recordToJson(record) };
    await this.save(copy);
  }

  /** True when the ledger records `kind` as landed. */
  isLanded(kind: LedgerKind): boolean {
    return ledgerEntry(this.current, kind)?.landed !== undefined;
  }

  /** True when the ledger holds an entry for `kind` (posted or only intended). */
  hasEntry(kind: LedgerKind): boolean {
    return ledgerEntry(this.current, kind) !== undefined;
  }
}
