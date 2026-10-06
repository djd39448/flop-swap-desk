// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Surface" (flow API additions), rules 1, 3 and 6: the part of resume that BuyerFlow and
// SellerFlow share. Three things live here and nothing else:
//
//   - the typed errors and the `next` step names `resume` hands back;
//   - `FlowJournal`: the flow's handle on its ONE persisted record. It holds the record as last made durable, saves
//     the next one through a `FlowStore` (bumping the revision, one save at a time, in order), and owns the frame
//     ledger rules: a frame's exact text is written BEFORE `venue.post` (rule 1), is re-posted only as that
//     identical text and only after a room read shows it absent, an identical text already in the room is
//     adopted (rule 3), and a line the ledger already shows as landed is never posted again (R1-12);
//   - small conversions between a signed venue record and its plain-JSON form.
//
// The journal is a SINGLE writer (review round 1, R1-02): it remembers the sha256 of the bytes it last loaded or
// saved and hands it to `FlowStore.save` as the `expected` digest, so a second flow instance on the same record is
// refused at its first save (`FlowRecordStaleError`) instead of silently replacing the first one's state. `begin`
// creates (`expected` = null), so a new flow never overwrites a stored swap (`FlowRecordExistsError`).
//
// The journal adopts a record in memory only AFTER its save resolved (R1-03): `record` is always what the store
// holds. A refused save, of any kind (the store refused it, the disk failed, the record would not encode), puts the
// journal into a FAILED state: it keeps the last durable record and throws a typed error, and every later write
// throws `FlowStoreWriteFailedError`. A flow whose save was refused is treated as a crashed flow: whatever it latched
// in memory while that save was pending (a prepared lock, a claim attempt) was never made durable, so no step of it
// may act on that state again. The runner drops the flow and builds a fresh one with `resume()`, which reads the
// store, the chain and the venue (rule 2) and decides from those. The flows check `journal.assertUsable()` at the
// start of every public step.

import { createHash } from "node:crypto";
import { tryDecodeFrame, verifyTranscriptRecord, type AcceptFrame, type OfferFrame, type TranscriptRecord } from "@flop-labs/tclk";

import type { RailAccounts } from "./counter-rail.js";
import {
  FlowRecordConflictError,
  FlowRecordError,
  FlowRecordInvalidError,
  bumped,
  cloneFlowRecord,
  decodeFlowRecord,
  encodeFlowRecord,
  ledgerEntry,
  loadFlowRecordWithDigest,
  recordKey,
  withLedgerIntent,
  type FlowRecord,
  type FrameSlot,
  type LedgerEntry,
  type LedgerKind,
  type RailAccountsJson,
  type SellerFlowRecord,
  type SwapFrames,
  type TranscriptRecordJson,
} from "./flow-record.js";
import { FlowRecordExistsError, FlowStoreCorruptError, FlowStoreWriteFailedError, flowDigest, flowKey, type FlowRole, type FlowStore } from "./flow-store.js";
import type { Signer, Venue } from "./venue.js";

// The store's own typed refusals are part of what a flow step can throw: re-exported here so a runner imports its errors
// from one place. `FlowRecordExistsError` lived here before the single-writer store (R1-02) moved it next to the store.
export { FlowRecordExistsError, FlowRecordStaleError, FlowStoreLockedError, FlowStoreWriteFailedError } from "./flow-store.js";

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

// --- one Seller record per offer -------------------------------------------------------------------------------------

/** The key of the Seller record already stored for the leg A offer whose exact text is `offerAText`, or `null`. A Seller
 *  record is keyed by contract A (R1-14), which does not exist until a statement is minted, so the store's own key cannot
 *  say "this offer was already accepted"; this scan can.
 *
 *  R2-05: the scan NEVER skips a record it cannot read. A record that fails its checksum or schema
 *  (`FlowStoreCorruptError`), carries a version this build does not know (`FlowRecordVersionError`), names another
 *  key or role (`FlowRecordMismatchError`) or cannot be loaded at all (a disk error, a sharing violation) throws as it is:
 *  an unreadable record cannot be told NOT to be the one for this offer, and passing over it would let a second accept
 *  mint another secret and post a second, different accept A for an offer whose first accept (and secret) the damaged
 *  record holds. A new Seller begin therefore stops on a store that holds an unreadable `seller:` record, until a person
 *  moves that file aside. A record listed and then gone (`load` answers `null`) is not unreadable and is passed over. */
export async function findStoredSellerOffer(store: FlowStore, offerAText: string): Promise<string | null> {
  for (const key of await store.list()) {
    if (!key.startsWith("seller:")) continue;
    const bytes = await store.load(key);
    if (bytes === null) continue;
    const record: FlowRecord = decodeFlowRecord(bytes, key);
    if (record.role === "seller" && record.frames.offerA?.text === offerAText) return key;
  }
  return null;
}

/** In-process queues for the scan and the create of a Seller `begin`: they must not interleave with another `begin` on the
 *  same STORE (R2-04). A store that names its storage (`scopeId`: every `FileFlowStore` on one directory) is queued by
 *  that name, so two store OBJECTS on one directory share one queue; any other store is queued by the object itself.
 *  Across processes the queue is not enough: the store's own `exclusive` section is (see `beginSeller`). */
const beginQueuesByObject = new WeakMap<object, Promise<void>>();
const beginQueuesByScope = new Map<string, Promise<void>>();

async function serialisedPerStore<T>(store: FlowStore, work: () => Promise<T>): Promise<T> {
  const scope = store.scopeId;
  const previous = (scope === undefined ? beginQueuesByObject.get(store) : beginQueuesByScope.get(scope)) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => mine);
  if (scope === undefined) beginQueuesByObject.set(store, tail);
  else beginQueuesByScope.set(scope, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (scope !== undefined && beginQueuesByScope.get(scope) === tail) beginQueuesByScope.delete(scope);
  }
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
  /** The record as last made durable (never ahead of the store). */
  private current: R;
  /** sha256 hex of the bytes behind `current` (what the next save passes as `expected`); `null` before the first save. */
  private digest: string | null;
  /** The first refused save, once there was one: the journal is dead from then on (R1-03). */
  private failure: Error | undefined;
  private tail: Promise<void> = Promise.resolve();
  /** The attempt in flight for each kind, with the room and the ledger text it carries (R1-16). */
  private readonly inflight = new Map<LedgerKind, { room: string; text: string; promise: Promise<TranscriptRecord> }>();
  private readonly deps: JournalDeps;
  private readonly key: string;
  private projector: ((record: R) => R) | undefined;

  private constructor(deps: JournalDeps, initial: R, digest: string | null) {
    this.deps = deps;
    this.current = initial;
    this.digest = digest;
    this.key = recordKey(initial);
  }

  /** Starts the journal of a NEW swap: saves `initial` as the first version (its revision is kept as given) as a
   *  create, so the store refuses (`FlowRecordExistsError`) if it already holds a record under the key, with no gap
   *  between the check and the write (R1-02). A Seller record is keyed by contract A, so a second accept of the SAME
   *  offer would not collide on the key; a Seller `begin` therefore also refuses when the store already holds a Seller
   *  record for that offer (the same exact offer A text), as the swap-id key used to (a new flow never starts a swap
   *  over). A different Buyer's offer with a copied swap id is a different offer and is not refused (R1-14). */
  static async begin<T extends FlowRecord>(deps: JournalDeps, initial: T): Promise<FlowJournal<T>> {
    const offerAText = initial.role === "seller" ? initial.frames.offerA?.text : undefined;
    if (offerAText !== undefined) return FlowJournal.beginSeller(deps, offerAText, () => initial as unknown as SellerFlowRecord) as unknown as Promise<FlowJournal<T>>;
    const journal = new FlowJournal<T>(deps, initial, null);
    await journal.run(() => initial, true);
    return journal;
  }

  /** `begin` for a Seller's record, with the record BUILT only once the store is known to hold no Seller record for the offer
   *  whose exact text is `offerAText`: `build` is where the Seller mints its secret, so a second `acceptLegA` of one offer
   *  (two processes, or two calls at once on one store) is refused with `FlowRecordExistsError` BEFORE anything is
   *  minted or posted (R1-02, review round 1). The key of a Seller record is contract A, which differs between two
   *  accepts of one offer, so the per-key compare-and-swap cannot tell them apart: the scan, the mint and the create are
   *  one critical section instead (R2-04). In one process every store object on one storage shares one queue
   *  (`FlowStore.scopeId`); across processes the section runs inside the store's own `exclusive("seller-begin")` when it
   *  offers one (`FileFlowStore` does, over a lock file in its directory). A store with neither has only its own object's
   *  queue, and the README says one process per store directory. */
  static async beginSeller(deps: JournalDeps, offerAText: string, build: () => SellerFlowRecord): Promise<FlowJournal<SellerFlowRecord>> {
    return serialisedPerStore(deps.store, async () => {
      const begin = async (): Promise<FlowJournal<SellerFlowRecord>> => {
        const existing = await findStoredSellerOffer(deps.store, offerAText);
        if (existing !== null) throw new FlowRecordExistsError(existing);
        const initial = build();
        const journal = new FlowJournal<SellerFlowRecord>(deps, initial, null);
        await journal.run(() => initial, true);
        return journal;
      };
      return deps.store.exclusive === undefined ? begin() : deps.store.exclusive("seller-begin", begin);
    });
  }

  /** The journal of an existing swap, from its stored record. `id` is the swap id for a Buyer and leg A's contract id
   *  for a Seller (R1-14). A missing record is `FlowNotFoundError`; a damaged, foreign-version or foreign-key record
   *  throws the typed error `loadFlowRecordWithDigest` names. */
  static async open(deps: JournalDeps, role: FlowRole, id: string): Promise<FlowJournal<FlowRecord>> {
    const loaded = await loadFlowRecordWithDigest(deps.store, role, id);
    if (loaded === null) throw new FlowNotFoundError(flowKey(role, id));
    return new FlowJournal<FlowRecord>(deps, loaded.record, loaded.digest);
  }

  /** The record as last made durable (a copy is made on every save; treat this as read-only). */
  get record(): R {
    return this.current;
  }

  /** True once a save was refused: the journal keeps the last durable record and refuses every write (R1-03). */
  get failed(): boolean {
    return this.failure !== undefined;
  }

  /** The error of the first refused save (always a `FlowStoreWriteFailedError`: the store's own refusal, or one wrapping
   *  the disk error or the invalid record), or `undefined` while the journal is healthy. */
  get failureError(): Error | undefined {
    return this.failure;
  }

  /** sha256 hex of the bytes behind `record`: what the next save is compared against. */
  get lastDigest(): string | null {
    return this.digest;
  }

  /** Throws `FlowStoreWriteFailedError` if an earlier save of this flow was refused. Every public step of a flow calls
   *  this first: a flow whose save was refused has latched state the store never saw, and must be rebuilt with
   *  `resume()` before it acts on anything (R1-03). */
  assertUsable(): void {
    if (this.failure === undefined) return;
    const why = this.failure instanceof Error ? `${this.failure.name}: ${this.failure.message}` : String(this.failure);
    throw new FlowStoreWriteFailedError(
      this.key,
      `flow store: an earlier save of "${this.key}" was refused (${why}); this flow no longer matches the store and must not act again: drop it and call resume()`,
      { cause: this.failure },
    );
  }

  /** Registers the flow's projection of its live state onto a record. Every later save runs `next` through it, so a
   *  save always carries the latest latches the flow holds, whatever step made the save. */
  setProjector(projector: (record: R) => R): void {
    this.projector = projector;
  }

  /** Saves `next` (projected, revision + 1, `updatedAtMs` from the clock). Resolves once the bytes are durable. */
  async save(next: R): Promise<void> {
    await this.update(() => next);
  }

  /** Saves `update(record)`, where `record` is the record as last made durable at the moment this save's turn comes
   *  (saves go out one at a time in the order they were made, so two overlapping updates both build on the other's
   *  result). Projected, revision + 1, `updatedAtMs` from the clock. Resolves once the bytes are durable; a refusal
   *  fails the journal (see the header). */
  async update(update: (record: R) => R): Promise<void> {
    await this.run(update, false);
  }

  /** The one write path. `derive` returns the record to save, or `null` for "nothing to save". The record is adopted in
   *  memory only after the store's save resolved. */
  private run(derive: (record: R) => R | null, create: boolean): Promise<void> {
    const turn = this.tail.then(() => this.commit(derive, create));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async commit(derive: (record: R) => R | null, create: boolean): Promise<void> {
    this.assertUsable();
    let next: R;
    let bytes: Uint8Array;
    try {
      const derived = derive(this.current);
      if (derived === null) return;
      const projected = this.projector === undefined ? derived : this.projector(derived);
      next = create ? projected : bumped(projected, this.deps.clock());
      bytes = encodeFlowRecord(next);
    } catch (error) {
      if (error instanceof FlowRecordInvalidError) this.fail(error); // a record that cannot be saved: the flow is ahead of its store
      throw error; // a refusal of the caller's own (a conflict between two texts, say): nothing was latched, the journal is fine
    }
    try {
      await this.deps.store.save(this.key, bytes, this.digest);
    } catch (error) {
      this.fail(error);
    }
    this.current = next;
    this.digest = flowDigest(bytes);
  }

  /** Marks the journal failed (the first failure is kept) and throws `FlowStoreWriteFailedError` for it. The store's own
   *  refusals (stale, exists, locked, an injected fault) ARE that class and are thrown as they are, so a caller can still
   *  tell them apart; anything else (a disk error, a record that would not encode) is wrapped, with the real failure as
   *  its `cause` and in its message. */
  private fail(error: unknown): never {
    const typed =
      error instanceof FlowStoreWriteFailedError
        ? error
        : new FlowStoreWriteFailedError(this.key, `flow store: saving "${this.key}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    this.failure ??= typed;
    throw typed;
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
   * second, different frame). The landed `seq` and `nonce` are saved after the post. An entry the ledger already marks
   * as landed is never posted again and the room is not read: the stored record answers (R1-12). Two calls for the
   * same kind that overlap share one attempt, but only when they carry the SAME room and text: a second call for a kind whose
   * attempt is in flight with another text is a `FlowRecordConflictError` (R1-16), never a silent share of the first call's
   * answer (two overlapping calls would otherwise leave the record naming one text while the room holds another).
   */
  ensurePosted(spec: PostSpec): Promise<TranscriptRecord> {
    const running = this.inflight.get(spec.kind);
    const text = this.ledgerText(spec);
    if (running !== undefined) {
      if (running.room !== spec.room || running.text !== text) {
        return Promise.reject(
          new FlowRecordConflictError(`flow record: "${spec.kind}" is already being posted with another room or text; a party never posts a second, different frame (R1-16)`),
        );
      }
      return running.promise;
    }
    const attempt = this.postOnce(spec).finally(() => this.inflight.delete(spec.kind));
    this.inflight.set(spec.kind, { room: spec.room, text, promise: attempt });
    return attempt;
  }

  private async postOnce(spec: PostSpec): Promise<TranscriptRecord> {
    this.assertUsable();
    const text = this.ledgerText(spec);
    // Throws FlowRecordConflictError when this kind was recorded with another room or text; returns `current` itself
    // (same object) when the entry already exists identically.
    const isNew = withLedgerIntent(this.current, { kind: spec.kind, room: spec.room, text }) !== this.current;

    // R1-12: a line the ledger shows as landed is DONE. The offers room is a short ring, so a read can miss a line that
    // did land; re-posting it would put a duplicate in the room and move the recorded seq to the duplicate.
    const stored = this.landedAnswer(spec);
    if (stored !== undefined) return stored;

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
    // may have saved while the room was being read. The post happens only after this save resolved; a refused save
    // fails the journal and nothing is posted (R1-03).
    if (isNew) {
      await this.run((current) => {
        const next = withLedgerIntent(current, { kind: spec.kind, room: spec.room, text });
        return next === current ? null : next;
      }, false);
    }
    const posted = await (spec.post ?? ((room: string, line: string) => this.deps.venue.post(room, line, this.deps.identity)))(spec.room, spec.text);
    await this.markLanded(spec, text, posted, false);
    return posted;
  }

  /** What an entry already marked landed answers with, without a room read: the record kept in the frame slot or on the
   *  landed mark (authenticated, as the flows check a slot at resume), else the mark itself (a Buyer's reveal-b, whose
   *  line is held as a digest only, or a mark saved before records were kept): a record-shaped value with the stored
   *  `seq` and `nonce`, `timestampMs` 0, a null signature and the ledger text as its line. That value does not
   *  authenticate; a caller that needs the signed record reads the room. `undefined` when the entry is not landed. */
  private landedAnswer(spec: PostSpec): TranscriptRecord | undefined {
    const entry = ledgerEntry(this.current, spec.kind);
    const landed = entry?.landed;
    if (entry === undefined || landed === undefined) return undefined;
    const fromSlot = spec.slot === undefined ? undefined : this.current.frames[spec.slot]?.record;
    const json = fromSlot !== undefined && fromSlot.seq === landed.seq ? fromSlot : landed.record;
    if (json !== undefined) {
      const record = recordFromJson(json);
      if (!verifyTranscriptRecord(record).ok) throw new FlowStoreCorruptError(this.key, `the stored record of the landed "${spec.kind}" line does not authenticate`);
      return record;
    }
    return markAsRecord(entry, landed, this.deps.identity.did);
  }

  /** Records a line this party already posted (found in the room by the caller) as the one for `kind`: the ledger
   *  entry is written if missing and marked landed, in one save. A ledger entry with another text or room throws, and so
   *  does one already landed at another seq (R1-12). */
  async adopt(spec: Pick<PostSpec, "kind" | "room" | "text" | "digestOnly" | "slot">, record: TranscriptRecord): Promise<void> {
    await this.markLanded(spec, this.ledgerText(spec), record, true);
  }

  /** Saves `record`'s `seq` and `nonce` on the ledger entry of `spec.kind` (writing the entry first, in the same save,
   *  when `ensureIntent`), with the signed record itself beside it (in the frame slot when the spec has one, else on the
   *  mark; never for a digest-only text). An entry already landed at a DIFFERENT seq or nonce is a conflict, not
   *  something to overwrite (R1-12). Derived from the latest record when the save's turn comes. */
  private async markLanded(spec: Pick<PostSpec, "kind" | "room" | "text" | "slot" | "digestOnly">, ledgerText: string, record: TranscriptRecord, ensureIntent: boolean): Promise<void> {
    await this.run((current) => {
      const from = ensureIntent ? withLedgerIntent(current, { kind: spec.kind, room: spec.room, text: ledgerText }) : current;
      const existing = ledgerEntry(from, spec.kind);
      if (existing === undefined) throw new FlowRecordConflictError(`flow record: "${spec.kind}" has no ledger entry to mark as landed`);
      if (existing.landed !== undefined && (existing.landed.seq !== record.seq || existing.landed.nonce !== record.nonce)) {
        throw new FlowRecordConflictError(
          `flow record: "${spec.kind}" already landed at seq ${existing.landed.seq}; refusing to replace that mark with seq ${record.seq} (a line is posted once)`,
        );
      }
      const slotKnown = spec.slot === undefined || from.frames[spec.slot]?.record?.seq === record.seq;
      if (from === current && existing.landed !== undefined && slotKnown) return null;
      const copy = cloneFlowRecord(from);
      const entry = ledgerEntry(copy, spec.kind);
      if (entry === undefined) throw new FlowRecordConflictError("flow record: ledger entry vanished on copy"); // unreachable
      const keepOnMark = spec.slot === undefined && spec.digestOnly !== true;
      entry.landed = { seq: record.seq, nonce: record.nonce, ...(keepOnMark ? { record: recordToJson(record) } : {}) };
      if (spec.slot !== undefined) copy.frames[spec.slot] = { text: spec.text, record: recordToJson(record) };
      return copy;
    }, false);
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

/** The record-shaped answer for a landed mark that has no stored record (see `FlowJournal.landedAnswer`). */
function markAsRecord(entry: LedgerEntry, landed: { seq: number; nonce: string | null }, sender: string): TranscriptRecord {
  return { room: entry.room, seq: landed.seq, timestampMs: 0, sender, nonce: landed.nonce, signature: null, line: entry.text };
}
