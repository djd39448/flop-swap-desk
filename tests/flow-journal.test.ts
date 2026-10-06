// SPDX-License-Identifier: MIT
//
// tests/flow-journal.test.ts: P8-FIXES-R1.md R1-02, R1-03 and R1-12 at the journal, with no flow in sight. The journal is
// the one handle a flow has on its stored record, so its three promises are pinned here directly:
//
//   R1-03  durable before adopted. The journal adopts a record in memory only after its save resolved; a refused save of
//          any kind fails the journal (it keeps the last durable record, throws a typed error, and refuses every later
//          write with FlowStoreWriteFailedError) until a fresh `open`. The scratch tests of review round 1 (retry cases A
//          and B) are ported here as journal-level cases: what a flow latched in memory behind a refused save is never
//          made durable by a retry in the same process, and a retry never posts a line whose intent was not saved.
//   R1-02  single writer. Two journals on one record: the second save is FlowRecordStaleError; a second `begin` is
//          FlowRecordExistsError; two concurrent `begin`s leave one winner (ported from the idempotency lens, F-C1 to F-C4,
//          at the store level).
//   R1-12  a line the ledger shows as landed is never posted again and its room is not read; a landed mark is never
//          replaced by another seq.

import { OFFER_ROOM, dealRoom, generateHashLock, verifyTranscriptRecord, type TranscriptRecord } from "@flop-labs/tclk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FlowRecordConflictError,
  FlowRecordInvalidError,
  decodeFlowRecord,
  ledgerEntry,
  newBuyerRecord,
  newSellerRecord,
  recordKey,
  type BuyerFlowRecord,
  type SellerFlowRecord,
} from "../src/client/flow-record.js";
import { FlowJournal, FlowRecordExistsError, FlowRecordStaleError, FlowStoreWriteFailedError, digestOfText, type JournalDeps, type PostSpec } from "../src/client/flow-resume.js";
import { FileFlowStore, FlowStoreFaultError, MemoryFlowStore, flowDigest, flowKey, type FlowStore } from "../src/client/flow-store.js";
import { MemoryVenue, type Venue } from "../src/client/venue.js";
import { identity } from "./helpers/identity.js";

const T0 = 1_700_000_000_000;
const SWAP = `0x${"5a".repeat(32)}`;
const CONTRACT_A = `0x${"c1".repeat(32)}`;
const CONTRACT_B = `0x${"c2".repeat(32)}`;
const me = identity("a1".repeat(32));
const OFFER_TEXT = 'tclk1 {"journal":"offer-a"}';
const ACCOUNT_TEXT = "acct journal-test line";
const LOCK_TEXT = 'tclk1 {"journal":"lock-a"}';
const BUYER_KEY = flowKey("buyer", SWAP);

const bytesOf = (value: Uint8Array | null): Uint8Array => {
  if (value === null) throw new Error("expected the store to hold a record");
  return value;
};

const buyerRecord = (): BuyerFlowRecord => ({
  ...newBuyerRecord({ swapId: SWAP, did: me.did, railId: "evm-htlc", caip2: "eip155:31337", deploymentId: "evm:0xrail:0xtoken", nowMs: T0 }),
  contractA: CONTRACT_A,
});

function sellerRecord(contractA: string, offerText: string): SellerFlowRecord {
  const lock = generateHashLock();
  const record = newSellerRecord({
    swapId: SWAP,
    did: me.did,
    railId: "evm-htlc",
    caip2: "eip155:31337",
    deploymentId: "evm:0xrail:0xtoken",
    nowMs: T0,
    contractA,
    preimage: lock.preimage,
    statement: lock.hash,
  });
  return { ...record, frames: { offerA: { text: offerText } } };
}

const specOffer: PostSpec = { kind: "offer-a", room: OFFER_ROOM, text: OFFER_TEXT, slot: "offerA" };
const specAccount: PostSpec = { kind: "account-a", room: dealRoom(CONTRACT_A), text: ACCOUNT_TEXT };
const specLock: PostSpec = { kind: "lock-a", room: dealRoom(CONTRACT_A), text: LOCK_TEXT };

interface Rig {
  clock: { ms: number };
  venue: MemoryVenue;
  store: FlowStore;
  deps: JournalDeps;
}

function rig(store: FlowStore): Rig {
  const clock = { ms: T0 };
  const venue = new MemoryVenue(() => clock.ms);
  return { clock, venue, store, deps: { store, venue, identity: me, clock: () => clock.ms } };
}

/** What a refused write is: the typed family the journal throws for it. */
const refused = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(FlowStoreWriteFailedError);

const linesIn = async (r: Rig, room: string): Promise<TranscriptRecord[]> => (await r.venue.read(room)).filter((rec) => rec.sender === me.did);

/** The room as a short ring: from now on a read shows only the lines posted after `cutoffSeq`. */
function ringRollsOver(venue: Venue, room: string, cutoffSeq: number): void {
  const target = venue as unknown as { read: (room: string) => Promise<readonly TranscriptRecord[]> };
  const original = target.read.bind(venue);
  target.read = async (name: string) => {
    const all = await original(name);
    return name === room ? all.filter((rec) => rec.seq > cutoffSeq) : all;
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flowjournal-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("R1-03: a refused save fails the journal; nothing is adopted before it is durable", () => {
  it("begin: a refused first save throws, stores nothing, and never lets a flow start", async () => {
    const store = new MemoryFlowStore().failSave(1);
    const r = rig(store);
    await expect(FlowJournal.begin(r.deps, buyerRecord())).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(await store.load(BUYER_KEY)).toBeNull();
  });

  it("case A (ported): a latch the flow holds in memory is NOT adopted behind a refused save, and a same-process retry does not make it durable", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const latch = { attempted: false };
    journal.setProjector((record) => ({ ...record, lock: { ...record.lock, attempted: latch.attempted, ...(latch.attempted ? { prepared: { ref: "outpoint:0" } } : {}) } }));
    const before = bytesOf(await store.load(BUYER_KEY));

    // the flow latches "the lock was prepared", and the save that would carry it is refused (ENOSPC: every save fails)
    latch.attempted = true;
    store.failSaveWhen(() => "reject");
    await expect(journal.update((record) => record)).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(journal.failed).toBe(true);
    expect(journal.failureError).toBeInstanceOf(FlowStoreFaultError);
    expect(journal.record.lock.attempted).toBe(false); // the journal still shows what the store holds
    expect(journal.record.lock.prepared).toBeUndefined();
    expect(journal.record.revision).toBe(1);
    expect(flowDigest(before)).toBe(journal.lastDigest);

    // the runner retries in the same process, with the disk healthy again: the retry is REFUSED, it does not save
    store.clearFaults();
    await refused(journal.update((record) => record));
    await refused(journal.save(journal.record));
    expect(() => journal.assertUsable()).toThrow(FlowStoreWriteFailedError);
    const stored = bytesOf(await store.load(BUYER_KEY));
    expect(flowDigest(stored)).toBe(flowDigest(before)); // the store was never written again by this journal
    expect(decodeFlowRecord(stored, BUYER_KEY)).toMatchObject({ lock: { attempted: false } });
    expect(store.saves.filter((save) => save.outcome === "ok")).toHaveLength(1); // the begin, nothing else
  });

  it("a refusal after the failure carries the first error as its cause, and names what to do", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    store.failSave(2);
    await expect(journal.update((record) => record)).rejects.toBeInstanceOf(FlowStoreFaultError);
    const error = await journal.update((record) => record).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowStoreWriteFailedError);
    expect((error as FlowStoreWriteFailedError).cause).toBeInstanceOf(FlowStoreFaultError);
    expect((error as FlowStoreWriteFailedError).message).toMatch(/resume\(\)/);
    expect((error as FlowStoreWriteFailedError).key).toBe(BUYER_KEY);
  });

  it("a fresh open (the runner's resume) reads the store and works: the failed journal is the only thing that was dead", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    store.failSave(2);
    await expect(journal.update((record) => ({ ...record, legBVerified: true }))).rejects.toBeInstanceOf(FlowStoreFaultError);
    const fresh = await FlowJournal.open(r.deps, "buyer", SWAP);
    expect(fresh.failed).toBe(false);
    expect((fresh.record as BuyerFlowRecord).legBVerified).toBe(false);
    await fresh.update((record) => ({ ...(record as BuyerFlowRecord), legBVerified: true }));
    expect(decodeFlowRecord(bytesOfSync(await store.load(BUYER_KEY)), BUYER_KEY)).toMatchObject({ legBVerified: true, revision: 2 });
  });

  it("case B (ported): a refused INTENT save posts nothing; the same-process retry posts nothing either; the restart posts the line once", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    store.failSaveWhen((_n, key, bytes) => (decodeFlowRecord(bytes, key).ledger.some((entry) => entry.kind === "lock-a") ? "reject" : undefined));

    await expect(journal.ensurePosted(specLock)).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(await linesIn(r, specLock.room)).toHaveLength(0);

    // the retry in the same process used to find the entry in memory ("already recorded"), skip the save and post
    store.clearFaults();
    await refused(journal.ensurePosted(specLock));
    expect(await linesIn(r, specLock.room)).toHaveLength(0);
    expect(decodeFlowRecord(bytesOfSync(await store.load(BUYER_KEY)), BUYER_KEY).ledger).toEqual([]);

    // the restart: the intent is saved, then the line is posted, once
    const fresh = await FlowJournal.open(r.deps, "buyer", SWAP);
    await fresh.ensurePosted(specLock);
    expect(await linesIn(r, specLock.room)).toHaveLength(1);
    expect(fresh.isLanded("lock-a")).toBe(true);
  });

  it("case B, the other half: the line was posted and the save that marks it landed is refused; the retry refuses, and the restart ADOPTS the line (no second post)", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    store.failSaveWhen((_n, key, bytes) => {
      const entry = ledgerEntry(decodeFlowRecord(bytes, key), "lock-a");
      return entry?.landed !== undefined ? "reject" : undefined;
    });
    await expect(journal.ensurePosted(specLock)).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(await linesIn(r, specLock.room)).toHaveLength(1); // posted: the intent was durable first
    store.clearFaults();
    await refused(journal.ensurePosted(specLock));
    expect(await linesIn(r, specLock.room)).toHaveLength(1);

    const fresh = await FlowJournal.open(r.deps, "buyer", SWAP);
    expect(fresh.hasEntry("lock-a")).toBe(true);
    expect(fresh.isLanded("lock-a")).toBe(false);
    await fresh.ensurePosted(specLock);
    expect(await linesIn(r, specLock.room)).toHaveLength(1); // found in the room and adopted
    expect(fresh.isLanded("lock-a")).toBe(true);
  });

  it("commit-then-throw (the bytes landed, the confirmation was lost): the journal does not adopt them either; a fresh open sees them", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    store.failSave(2, "commit-then-throw");
    await expect(journal.update((record) => ({ ...(record as BuyerFlowRecord), legBVerified: true }))).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect((journal.record as BuyerFlowRecord).legBVerified).toBe(false);
    expect(journal.failed).toBe(true);
    const fresh = await FlowJournal.open(r.deps, "buyer", SWAP);
    expect((fresh.record as BuyerFlowRecord).legBVerified).toBe(true);
  });

  it("an error that is not a typed store error (a disk error) is wrapped in FlowStoreWriteFailedError with the cause kept", async () => {
    const real = new MemoryFlowStore();
    let failNext = false;
    const store: FlowStore = {
      load: (key) => real.load(key),
      list: () => real.list(),
      save: async (key, bytes, expected) => {
        if (failNext) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        await real.save(key, bytes, expected);
      },
    };
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    failNext = true;
    const error = await journal.update((record) => record).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowStoreWriteFailedError);
    expect((error as FlowStoreWriteFailedError).cause).toMatchObject({ code: "ENOSPC" });
    expect(journal.failed).toBe(true);
  });

  it("a record that would not encode (R1-09) fails the journal as FlowStoreWriteFailedError with FlowRecordInvalidError (not a corrupt record) as its cause; the store is untouched", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const before = flowDigest(bytesOfSync(await store.load(BUYER_KEY)));
    const tooMany = Array.from({ length: 65 }, (_, i) => `note ${i}`);
    const error = await journal.update((record) => ({ ...(record as BuyerFlowRecord), refundNotes: tooMany })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowStoreWriteFailedError);
    expect((error as FlowStoreWriteFailedError).cause).toBeInstanceOf(FlowRecordInvalidError);
    expect(((error as FlowStoreWriteFailedError).cause as FlowRecordInvalidError).reason).toMatch(/refundNotes/);
    expect((error as FlowStoreWriteFailedError).message).toMatch(/refundNotes/); // the real failure is named, not hidden behind the wrapper
    expect(journal.failureError).toBe(error);
    expect(journal.failed).toBe(true);
    expect(flowDigest(bytesOfSync(await store.load(BUYER_KEY)))).toBe(before);
    await refused(journal.update((record) => record)); // the flow that wanted to persist state the store cannot hold is stopped
  });

  it("a refusal of the caller's own (two different texts for one kind) is a FlowRecordConflictError and leaves the journal healthy", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    await journal.ensurePosted(specAccount);
    await expect(journal.ensurePosted({ ...specAccount, text: "acct a DIFFERENT line" })).rejects.toBeInstanceOf(FlowRecordConflictError);
    expect(journal.failed).toBe(false);
    expect(await linesIn(r, specAccount.room)).toHaveLength(1);
    await journal.update((record) => record); // still writable
  });

  it("saves overlap safely: each builds on the record the one before it made durable (no update is lost), in order", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    await Promise.all([
      journal.update((record) => ({ ...(record as BuyerFlowRecord), legBVerified: true })),
      journal.update((record) => ({ ...(record as BuyerFlowRecord), refundNotes: [...(record as BuyerFlowRecord).refundNotes, "second"] })),
      journal.ensurePosted(specAccount),
    ]);
    const stored = decodeFlowRecord(bytesOfSync(await store.load(BUYER_KEY)), BUYER_KEY) as BuyerFlowRecord;
    expect(stored.legBVerified).toBe(true);
    expect(stored.refundNotes).toEqual(["second"]);
    expect(ledgerEntry(stored, "account-a")?.landed).toBeDefined();
    expect(stored.revision).toBeGreaterThanOrEqual(4);
    expect(flowDigest(bytesOfSync(await store.load(BUYER_KEY)))).toBe(journal.lastDigest);
  });

  it("a save queued behind a refused one is refused too and never reaches the store", async () => {
    const store = new MemoryFlowStore();
    const r = rig(store);
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    store.failSave(2);
    const first = journal.update((record) => record);
    const second = journal.update((record) => ({ ...(record as BuyerFlowRecord), legBVerified: true }));
    await expect(first).rejects.toBeInstanceOf(FlowStoreFaultError);
    await refused(second);
    expect(store.saveCount).toBe(2); // the begin and the refused one: the queued save was never sent
  });
});

describe.each<[string, () => FlowStore]>([
  ["MemoryFlowStore", () => new MemoryFlowStore()],
  ["FileFlowStore", () => new FileFlowStore(join(root, "flows"))],
])("R1-02 over %s: a record has one writer", (_name, makeStore) => {
  it("F-C1 (begin): a second begin over a stored swap is FlowRecordExistsError and posts and stores nothing", async () => {
    const r = rig(makeStore());
    const first = await FlowJournal.begin(r.deps, buyerRecord());
    await first.ensurePosted(specOffer);
    const stored = flowDigest(bytesOf(await r.store.load(BUYER_KEY)));
    await expect(FlowJournal.begin(r.deps, buyerRecord())).rejects.toBeInstanceOf(FlowRecordExistsError);
    expect(flowDigest(bytesOf(await r.store.load(BUYER_KEY)))).toBe(stored);
  });

  it("F-C1 (begin): two begins racing on one swap leave exactly one winner, whole in the store", async () => {
    const r = rig(makeStore());
    const results = await Promise.allSettled([FlowJournal.begin(r.deps, buyerRecord()), FlowJournal.begin(r.deps, buyerRecord())]);
    expect(results.filter((res) => res.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((res): res is PromiseRejectedResult => res.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(FlowRecordExistsError);
    expect(decodeFlowRecord(bytesOf(await r.store.load(BUYER_KEY)), BUYER_KEY).revision).toBe(1);
  });

  it("F-C3 (two journals, one record, in turn): the second journal's save is FlowRecordStaleError and fails it; the first one's state stands", async () => {
    const r = rig(makeStore());
    await FlowJournal.begin(r.deps, buyerRecord());
    const p1 = await FlowJournal.open(r.deps, "buyer", SWAP);
    const p2 = await FlowJournal.open(r.deps, "buyer", SWAP); // two flows resumed from one record
    await p1.update((record) => ({ ...(record as BuyerFlowRecord), lock: { ...(record as BuyerFlowRecord).lock, attempted: true, prepared: { ref: "first:0" } } }));
    const error = await p2.update((record) => ({ ...(record as BuyerFlowRecord), lock: { ...(record as BuyerFlowRecord).lock, attempted: true, prepared: { ref: "second:0" } } })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordStaleError);
    expect(p2.failed).toBe(true);
    const stored = decodeFlowRecord(bytesOf(await r.store.load(BUYER_KEY)), BUYER_KEY) as BuyerFlowRecord;
    expect(stored.lock.prepared).toEqual({ ref: "first:0" });
    await refused(p2.update((record) => record));
  });

  it("F-C3 (the same, concurrently): two journals racing one update: exactly one wins and the loser is stale", async () => {
    const r = rig(makeStore());
    await FlowJournal.begin(r.deps, buyerRecord());
    const p1 = await FlowJournal.open(r.deps, "buyer", SWAP);
    const p2 = await FlowJournal.open(r.deps, "buyer", SWAP);
    const results = await Promise.allSettled([
      p1.update((record) => ({ ...(record as BuyerFlowRecord), refundNotes: ["from p1"] })),
      p2.update((record) => ({ ...(record as BuyerFlowRecord), refundNotes: ["from p2"] })),
    ]);
    expect(results.filter((res) => res.status === "fulfilled")).toHaveLength(1);
    expect(results.find((res): res is PromiseRejectedResult => res.status === "rejected")?.reason).toBeInstanceOf(FlowRecordStaleError);
    const winner = results[0]?.status === "fulfilled" ? "from p1" : "from p2";
    expect((decodeFlowRecord(bytesOf(await r.store.load(BUYER_KEY)), BUYER_KEY) as BuyerFlowRecord).refundNotes).toEqual([winner]);
  });

  it("F-C2: P1 locks, then P2 only records a verification: P2's save is stale, so it cannot reset P1's lock section, and a third resume sees P1's lock", async () => {
    const r = rig(makeStore());
    await FlowJournal.begin(r.deps, buyerRecord());
    const p1 = await FlowJournal.open(r.deps, "buyer", SWAP);
    const p2 = await FlowJournal.open(r.deps, "buyer", SWAP);
    await p1.update((record) => ({ ...(record as BuyerFlowRecord), lock: { ...(record as BuyerFlowRecord).lock, attempted: true, prepared: { ref: "funded:0" } } }));
    await expect(p2.update((record) => ({ ...(record as BuyerFlowRecord), legBVerified: true }))).rejects.toBeInstanceOf(FlowRecordStaleError);
    const third = await FlowJournal.open(r.deps, "buyer", SWAP);
    const record = third.record as BuyerFlowRecord;
    expect(record.lock).toMatchObject({ attempted: true, prepared: { ref: "funded:0" } });
    expect(record.legBVerified).toBe(false);
  });

  it("the posts of the loser: a stale journal's ensurePosted never posts (its intent save is the one that is refused)", async () => {
    const r = rig(makeStore());
    await FlowJournal.begin(r.deps, buyerRecord());
    const p1 = await FlowJournal.open(r.deps, "buyer", SWAP);
    const p2 = await FlowJournal.open(r.deps, "buyer", SWAP);
    await p1.ensurePosted(specLock);
    await expect(p2.ensurePosted({ ...specLock, text: 'tclk1 {"journal":"another lock frame"}' })).rejects.toBeInstanceOf(FlowRecordStaleError);
    expect(await linesIn(r, specLock.room)).toHaveLength(1);
  });

  it("every successful save leaves journal.lastDigest equal to the digest of the stored bytes", async () => {
    const r = rig(makeStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const digestNow = async (): Promise<string> => flowDigest(bytesOf(await r.store.load(BUYER_KEY)));
    expect(journal.lastDigest).toBe(await digestNow());
    await journal.ensurePosted(specAccount);
    expect(journal.lastDigest).toBe(await digestNow());
    await journal.update((record) => record);
    expect(journal.lastDigest).toBe(await digestNow());
  });

  it("two Seller accepts of ONE offer leave one record (the second begin is FlowRecordExistsError); the same swap id from another offer is not refused (R1-14)", async () => {
    const r = rig(makeStore());
    const contract1 = `0x${"d1".repeat(32)}`;
    const contract2 = `0x${"d2".repeat(32)}`;
    const contract3 = `0x${"d3".repeat(32)}`;
    const results = await Promise.allSettled([
      FlowJournal.begin(r.deps, sellerRecord(contract1, OFFER_TEXT)),
      FlowJournal.begin(r.deps, sellerRecord(contract2, OFFER_TEXT)), // another statement, so another contract A, for the same offer
    ]);
    expect(results.filter((res) => res.status === "fulfilled")).toHaveLength(1);
    expect(results.find((res): res is PromiseRejectedResult => res.status === "rejected")?.reason).toBeInstanceOf(FlowRecordExistsError);
    expect(await r.store.list()).toHaveLength(1);
    // a squatter's offer carries the same swap id but is another offer: its own record, no slot is taken from anyone
    await FlowJournal.begin(r.deps, sellerRecord(contract3, 'tclk1 {"journal":"a squatter offer"}'));
    expect(await r.store.list()).toHaveLength(2);
    expect((await r.store.list()).every((key) => key.startsWith("seller:"))).toBe(true);
  });

  it("a Seller record is stored under seller:<contractA>", async () => {
    const r = rig(makeStore());
    const record = sellerRecord(`0x${"d1".repeat(32)}`, OFFER_TEXT);
    await FlowJournal.begin(r.deps, record);
    expect(await r.store.list()).toEqual([recordKey(record)]);
    expect(recordKey(record)).toBe(`seller:${record.contractA}`);
    const reopened = await FlowJournal.open(r.deps, "seller", record.contractA);
    expect((reopened.record as SellerFlowRecord).swapId).toBe(SWAP);
  });
});

describe("R2-04: the Seller begin queue is keyed by the store's scope id, not by the store object", () => {
  /** Two handles on ONE storage that name it (`scopeId`) but offer no exclusive section: what a store of another kind
   *  would look like, so only the in-process queue stands between two accepts of one offer. */
  function handles(): [FlowStore, FlowStore] {
    const inner = new MemoryFlowStore();
    const handle = (): FlowStore => ({
      scopeId: "one-storage",
      load: (key) => inner.load(key),
      save: (key, value, expected) => inner.save(key, value, expected),
      list: () => inner.list(),
    });
    return [handle(), handle()];
  }

  it("two begins of one offer through two handles on one storage leave exactly one record (the other is FlowRecordExistsError, and never minted)", async () => {
    const [a, b] = handles();
    let built = 0;
    const begin = (store: FlowStore, contract: string): Promise<unknown> =>
      FlowJournal.beginSeller(rig(store).deps, OFFER_TEXT, () => {
        built += 1;
        return sellerRecord(contract, OFFER_TEXT);
      });
    const results = await Promise.allSettled([begin(a, `0x${"e1".repeat(32)}`), begin(b, `0x${"e2".repeat(32)}`)]);
    expect(results.filter((res) => res.status === "fulfilled")).toHaveLength(1);
    expect(results.find((res): res is PromiseRejectedResult => res.status === "rejected")?.reason).toBeInstanceOf(FlowRecordExistsError);
    expect(built).toBe(1);
    expect(await a.list()).toHaveLength(1);
  });

  it("handles with different scope ids are different stores and do not wait for each other", async () => {
    const one = new MemoryFlowStore();
    const two = new MemoryFlowStore();
    const handle = (inner: MemoryFlowStore, scopeId: string): FlowStore => ({ scopeId, load: (k) => inner.load(k), save: (k, v, e) => inner.save(k, v, e), list: () => inner.list() });
    const results = await Promise.allSettled([
      FlowJournal.beginSeller(rig(handle(one, "s1")).deps, OFFER_TEXT, () => sellerRecord(`0x${"e1".repeat(32)}`, OFFER_TEXT)),
      FlowJournal.beginSeller(rig(handle(two, "s2")).deps, OFFER_TEXT, () => sellerRecord(`0x${"e2".repeat(32)}`, OFFER_TEXT)),
    ]);
    expect(results.every((res) => res.status === "fulfilled")).toBe(true);
  });
});

describe("R1-12 (journal part): a line the ledger shows as landed is never posted again", () => {
  it("B1: a confirmed offers-room line (a slot kind) is returned as recorded after the ring rolled; nothing is posted, nothing is read, the seq stays", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const posted = await journal.ensurePosted(specOffer);
    ringRollsOver(r.venue, OFFER_ROOM, posted.seq); // the offers room is a short ring: the line is gone from a read

    const again = await journal.ensurePosted(specOffer);
    expect(again).toEqual(posted);
    expect(await r.venue.read(OFFER_ROOM)).toHaveLength(0); // the ring shows nothing; ...
    expect(((r.venue as unknown as { rooms: Map<string, unknown[]> }).rooms.get(OFFER_ROOM) ?? []).length).toBe(1); // ... and the room holds one line only
    expect(ledgerEntry(journal.record, "offer-a")?.landed).toEqual({ seq: posted.seq, nonce: posted.nonce });
    expect(journal.record.frames.offerA?.record?.seq).toBe(posted.seq);

    // the same after a restart
    const fresh = await FlowJournal.open(r.deps, "buyer", SWAP);
    expect(await fresh.ensurePosted(specOffer)).toEqual(posted);
    expect(((r.venue as unknown as { rooms: Map<string, unknown[]> }).rooms.get(OFFER_ROOM) ?? []).length).toBe(1);
  });

  it("a landed line of a kind with no frame slot is answered with the real signed record kept on its mark", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const posted = await journal.ensurePosted(specAccount);
    ringRollsOver(r.venue, specAccount.room, posted.seq);
    const fresh = await FlowJournal.open(r.deps, "buyer", SWAP);
    const again = await fresh.ensurePosted(specAccount);
    expect(again).toEqual(posted);
    expect(verifyTranscriptRecord(again).ok).toBe(true);
    expect(((r.venue as unknown as { rooms: Map<string, unknown[]> }).rooms.get(specAccount.room) ?? []).length).toBe(1);
  });

  it("a Buyer's reveal-b is digest-only: the ledger and the mark hold no secret, and a landed one is answered with the mark (not authenticated)", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const secretLine = 'tclk1 {"type":"reveal","secret":"0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100"}';
    const spec: PostSpec = { kind: "reveal-b", room: dealRoom(CONTRACT_B), text: secretLine, digestOnly: true };
    const posted = await journal.ensurePosted(spec);
    const stored = new TextDecoder().decode(bytesOf(await r.store.load(BUYER_KEY)));
    expect(stored).not.toContain("1f1e1d1c1b1a1918");
    expect(ledgerEntry(journal.record, "reveal-b")).toMatchObject({ text: digestOfText(secretLine), landed: { seq: posted.seq, nonce: posted.nonce } });
    expect(ledgerEntry(journal.record, "reveal-b")?.landed?.record).toBeUndefined();
    ringRollsOver(r.venue, spec.room, posted.seq);
    const again = await journal.ensurePosted(spec);
    expect(again).toMatchObject({ seq: posted.seq, nonce: posted.nonce, signature: null, line: digestOfText(secretLine) });
    expect(((r.venue as unknown as { rooms: Map<string, unknown[]> }).rooms.get(spec.room) ?? []).length).toBe(1);
  });

  it("a landed kind with another text or room is still FlowRecordConflictError (a party never posts a second, different frame)", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    await journal.ensurePosted(specAccount);
    await expect(journal.ensurePosted({ ...specAccount, text: "acct another" })).rejects.toBeInstanceOf(FlowRecordConflictError);
    expect(journal.failed).toBe(false);
  });

  it("markLanded never replaces a landed mark with another seq: adopt() of a different record is FlowRecordConflictError and the ledger is unchanged", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const posted = await journal.ensurePosted(specAccount);
    const duplicate = await r.venue.post(specAccount.room, specAccount.text, me); // a second copy of the same line, at the next seq
    expect(duplicate.seq).not.toBe(posted.seq);
    const before = flowDigest(bytesOf(await r.store.load(BUYER_KEY)));
    await expect(journal.adopt(specAccount, duplicate)).rejects.toBeInstanceOf(FlowRecordConflictError);
    expect(ledgerEntry(journal.record, "account-a")?.landed?.seq).toBe(posted.seq);
    expect(flowDigest(bytesOf(await r.store.load(BUYER_KEY)))).toBe(before);
    expect(journal.failed).toBe(false);
    await journal.adopt(specAccount, posted); // the same mark again is a no-op
    expect(flowDigest(bytesOf(await r.store.load(BUYER_KEY)))).toBe(before);
  });

  it("a line whose landing was never confirmed is still read for and adopted, not posted twice (rule 3 stays)", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    // the intent is durable and the line is in the room, but the landed mark never got saved
    await journal.update((record) => ({ ...record, ledger: [...record.ledger, { kind: "account-a" as const, room: specAccount.room, text: specAccount.text }] }));
    const stray = await r.venue.post(specAccount.room, specAccount.text, me);
    const adopted = await journal.ensurePosted(specAccount);
    expect(adopted.seq).toBe(stray.seq);
    expect(((r.venue as unknown as { rooms: Map<string, unknown[]> }).rooms.get(specAccount.room) ?? []).length).toBe(1);
    expect(ledgerEntry(journal.record, "account-a")?.landed?.seq).toBe(stray.seq);
  });
});

describe("R1-16: overlapping ensurePosted calls for one kind", () => {
  it("a second call carrying ANOTHER text while the first is in flight is FlowRecordConflictError; exactly one line is posted, the first's", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const first = journal.ensurePosted(specAccount);
    const second = journal.ensurePosted({ ...specAccount, text: "acct a DIFFERENT line" });
    await expect(second).rejects.toBeInstanceOf(FlowRecordConflictError);
    const posted = await first;
    expect(posted.line).toBe(ACCOUNT_TEXT);
    expect((await linesIn(r, specAccount.room)).map((line) => line.line)).toEqual([ACCOUNT_TEXT]);
    expect(journal.failed).toBe(false); // a refusal of the caller's own does not fail the journal
  });

  it("a second call for another ROOM with the same kind is refused the same way", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const first = journal.ensurePosted(specAccount);
    const second = journal.ensurePosted({ ...specAccount, room: dealRoom(CONTRACT_B) });
    await expect(second).rejects.toBeInstanceOf(FlowRecordConflictError);
    await first;
    expect(await linesIn(r, dealRoom(CONTRACT_B))).toHaveLength(0);
  });

  it("a second call with the SAME text shares the attempt: one post, the same answer", async () => {
    const r = rig(new MemoryFlowStore());
    const journal = await FlowJournal.begin(r.deps, buyerRecord());
    const [a, b] = await Promise.all([journal.ensurePosted(specAccount), journal.ensurePosted(specAccount)]);
    expect(b.seq).toBe(a.seq);
    expect(await linesIn(r, specAccount.room)).toHaveLength(1);
  });
});

/** `bytesOf` for the places that read it right after an await (keeps the lines short). */
function bytesOfSync(value: Uint8Array | null): Uint8Array {
  return bytesOf(value);
}
