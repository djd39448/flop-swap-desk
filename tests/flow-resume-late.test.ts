// SPDX-License-Identifier: MIT
//
// R3-01 (P8-FIXES-R3.md, decision 1): the Seller half of the offer-expiry rule, and the Buyer's mirror.
//
// tclk's machine rejects an accept stamped at or after the offer's `expiresMs` ("offer has expired"). R2-06 made the Buyer check the accept A
// stamp and the accept B clock, but nothing compared accept B's VENUE STAMP with offer B's expiry: the Buyer posts accept B a second before the
// expiry by its own clock, the venue stamps the post two seconds later (or its clock runs ahead), and the Seller still locked leg B against it.
// Both legs then settled on chain while leg B's transcript folded "proposed" with accept B and every later frame rejected, so the board, the
// watcher and audit-export disagreed with the paper note. Now
//   - Seller `lockLegB`: refuses with `SwapExpiredError` when the accept B record's stamp is at or after offer B's expiry, ONLY while no lock
//     attempt is saved (a saved attempt is recovered whatever its stamp: recognising a lock that may have landed is not a new action);
//   - Buyer (store path) `acceptLegB`: throws `SwapExpiredError` instead of returning a landed accept B stamped at or after the expiry, and
//     `next` says `abandoned` for that state while leg B is unverified and no leg A lock was attempted (record only, no I/O).
// Nothing is at stake in that state: leg B is the Seller's first lock and leg A is locked only after leg B verified. The EVM world.

import { OFFER_ROOM, applyFrame, dealRoom, encodeFrame, foldTranscript, makeAccept, openContract, tryDecodeFrame, type OfferFrame, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { decodeFlowRecord, encodeFlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import { SwapExpiredError } from "../src/client/flow-resume.js";
import { flowDigest } from "../src/client/flow-store.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { STEPS, readSwap, type World } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied, failVenuePosts } from "./helpers/resume-flows.js";
import { buyerRecordOf, resumedBuyer, resumedSeller, sellerRecordOf, started, strangerPaper, type Started } from "./helpers/resume-world.js";
import { sellerKeyOf } from "./helpers/seller-key.js";

/** A world after the bid, the Seller's accept A and offer B, and the Seller's account line: the Buyer has not answered offer B yet. */
async function afterSellerLine(): Promise<{ s: Started; offerB: OfferFrame; offerBRecord: TranscriptRecord; statement: string }> {
  const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.sellerLine]);
  const v = await readSwap(s.w);
  if (v.offerB === undefined || v.offerBRecord === undefined || v.acceptA === undefined) throw new Error("test: the pairing frames are not in the venue");
  return { s, offerB: v.offerB, offerBRecord: v.offerBRecord, statement: v.acceptA.statement };
}

/** The Buyer's DID posts accept B straight to the venue (outside its flow) at clock `at`: the record the Seller is handed. */
async function acceptBAt(s: Started, offerB: OfferFrame, statement: string, at: number): Promise<{ record: TranscriptRecord; contract: string }> {
  s.w.setTime(at);
  const acceptB = makeAccept(offerB, { from: s.w.dids.buyer, statement });
  const record = await s.w.venue.post(OFFER_ROOM, encodeFrame(acceptB), s.w.buyerOptions().identity);
  return { record, contract: acceptB.contract };
}

const counts = (w: World) => w.counts();

describe("R3-01 (Seller): lockLegB refuses an accept B the venue stamped at or after offer B's expiry", () => {
  for (const delta of [0, 1_000]) {
    it(`accept B stamped at expiresMs + ${delta}: SwapExpiredError, leg B's note is never written, nothing is saved or posted, the chain shows 0 locks`, async () => {
      const { s, offerB, offerBRecord, statement } = await afterSellerLine();
      const { record, contract } = await acceptBAt(s, offerB, statement, offerB.expiresMs + delta);
      // the premise: tclk's machine rejects this accept ("offer has expired"), so it never folds into leg B's transcript
      const fold = foldTranscript([offerBRecord, record]);
      expect(fold.steps.map((step) => step.ok), "offer B folds, the late accept B is rejected").toEqual([true, false]);
      expect(applyFrame(openContract(offerB), tryDecodeFrame(record.line)!, record.timestampMs)).toMatchObject({ ok: false });

      const error = await s.c.seller.lockLegB(record).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SwapExpiredError);
      expect((error as SwapExpiredError).offerId).toBe(offerB.id);
      expect((error as SwapExpiredError).expiresMs).toBe(offerB.expiresMs);
      expect((error as SwapExpiredError).message).toMatch(/accept B is timestamped \d+, at or after the offer's expiry/);
      expect(await s.w.paper.read(contract), "leg B's note was never written").toBeNull();
      expect(counts(s.w).locks, "nothing locked").toBe(0);
      expect(await s.w.venue.read(dealRoom(contract)), "no lock frame in leg B's deal room").toHaveLength(0);
      const saved = await sellerRecordOf(s.w);
      expect(saved.attemptedAcceptB, "no attempt was saved").toBeUndefined();
      expect(saved.frames.acceptB, "nor the accept").toBeUndefined();
      // the refusal latches nothing: the same call refuses the same way, and the flow still names lockLegB
      await expect(s.c.seller.lockLegB(record)).rejects.toBeInstanceOf(SwapExpiredError);
      expect((await resumedSeller(s)).next).toBe("lockLegB");
    });
  }

  it("control: an accept B stamped one millisecond before the expiry is locked against, and its lock frame is posted", async () => {
    const { s, offerB, statement } = await afterSellerLine();
    const { record, contract } = await acceptBAt(s, offerB, statement, offerB.expiresMs - 1);
    await s.c.seller.lockLegB(record);
    expect((await s.w.paper.read(contract))?.status).toBe("locked");
    const frames = (await s.w.venue.read(dealRoom(contract))).filter((r) => tryDecodeFrame(r.line)?.type === "lock");
    expect(frames).toHaveLength(1);
  });

  it("the stamp decides, not the clock: an accept B stamped in time is still locked against after the clock passed the expiry", async () => {
    const { s, offerB, statement } = await afterSellerLine();
    const { record, contract } = await acceptBAt(s, offerB, statement, offerB.expiresMs - 1);
    s.w.setTime(offerB.expiresMs + 60_000);
    await s.c.seller.lockLegB(record);
    expect((await s.w.paper.read(contract))?.status).toBe("locked");
  });
});

describe("R3-01 (both halves): the Buyer's accept B is stamped two seconds after it was posted, past offer B's expiry", () => {
  /** The Buyer's `venue.post` moves the clock two seconds when it posts accept B (a slow post, or a venue clock ahead of the Buyer's). */
  async function lateStampedAcceptB(): Promise<{ s: Started; error: unknown }> {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA]);
    const v = await readSwap(s.w);
    const venue = s.w.venue;
    const original = venue.post.bind(venue);
    venue.post = async (room, line, signer) => {
      const frame = tryDecodeFrame(line);
      if (room === OFFER_ROOM && frame?.type === "accept" && frame.from === s.w.dids.buyer) s.w.setTime(s.w.clockRef.ms + 2_000);
      return original(room, line, signer);
    };
    s.w.setTime(v.offerB!.expiresMs - 1_000); // the Buyer's own check passes: one second before the expiry, no margin
    const error = await STEPS.acceptLegB.run(s.c).then(
      () => undefined,
      (e: unknown) => e,
    );
    venue.post = original;
    return { s, error };
  }

  it("the Buyer's acceptLegB throws SwapExpiredError (it does not hand back the late accept B), the Seller refuses, next says abandoned, counts stay 0", async () => {
    const { s, error } = await lateStampedAcceptB();
    const v = await readSwap(s.w);
    expect(v.acceptBRecord!.timestampMs, "the venue stamped accept B at or after the expiry").toBeGreaterThanOrEqual(v.offerB!.expiresMs);
    expect(error).toBeInstanceOf(SwapExpiredError);
    expect((error as SwapExpiredError).offerId).toBe(v.offerB!.id);
    expect((error as SwapExpiredError).expiresMs).toBe(v.offerB!.expiresMs);
    expect((error as SwapExpiredError).message, "accept B IS in the room: the message does not claim nothing was posted").not.toMatch(/nothing was posted/);
    expect((error as SwapExpiredError).message).toMatch(/nothing was locked/);

    // the Seller refuses to lock leg B against it
    await expect(s.c.seller.lockLegB(v.acceptBRecord!)).rejects.toBeInstanceOf(SwapExpiredError);
    expect(await s.w.paper.read(v.acceptB!.contract), "leg B's paper note never reads locked").toBeNull();

    // the Buyer's record holds the pairing and the landed accept B; next says abandoned (record only: it needs no read of the venue)
    expect((await buyerRecordOf(s.w)).frames.acceptB?.record).toBeDefined();
    const back = await resumedBuyer(s);
    expect(back.next).toBe("abandoned");
    expect((await resumedBuyer(s)).next, "and it stays abandoned").toBe("abandoned");
    // a runner that calls the step anyway is refused again with the typed error, and nothing is posted a second time
    const before = (await s.w.venue.read(OFFER_ROOM)).length;
    await expect(STEPS.acceptLegB.run(s.c)).rejects.toBeInstanceOf(SwapExpiredError);
    expect((await s.w.venue.read(OFFER_ROOM)).length, "no second accept B").toBe(before);
    // the Buyer never moves on: leg B does not verify, so leg A is never locked
    await expect(STEPS.verify.run(s.c)).rejects.toThrow(/does not verify/);
    expect(counts(s.w)).toMatchObject({ locks: 0, claims: 0 });
  });

  it("the same refusal in the live process: a second call in the flow that was refused is refused too, and the flow holds no pairing", async () => {
    const { s, error } = await lateStampedAcceptB();
    expect(error).toBeInstanceOf(SwapExpiredError);
    await expect(STEPS.acceptLegB.run(s.c)).rejects.toBeInstanceOf(SwapExpiredError);
    await expect(STEPS.verify.run(s.c)).rejects.toThrow(/has not been accepted yet/);
  });

  it("abandoned holds only while leg B is unverified: a leg B note somebody else wrote, verified by hand, takes the flow back to the usual route", async () => {
    const { s } = await lateStampedAcceptB();
    const v = await readSwap(s.w);
    const resumed = await resumedBuyer(s);
    expect(resumed.next).toBe("abandoned");
    // paper notes are not bound to who wrote them: a stranger (or a Seller build without the R3-01 refusal) writes leg B's note
    await strangerPaper(s.w).lock(offerAcceptLockTerms(v.offerB!, v.acceptB!));
    await resumed.flow.verifyLegBLocked(); // by hand: legBVerified
    expect((await resumedBuyer(s)).next, "R3-01 names abandoned only for an unverified leg B").toBe("postAccountLineA");
  });

  it("control: an accept B stamped in time is returned as before, and next goes on to verifyLegBLocked", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA]);
    const v = await readSwap(s.w);
    s.w.setTime(v.offerB!.expiresMs - 3_000); // the venue stamps the post at this same clock: well before the expiry
    await STEPS.acceptLegB.run(s.c);
    const after = await readSwap(s.w);
    expect(after.acceptBRecord!.timestampMs).toBeLessThan(v.offerB!.expiresMs);
    expect((await resumedBuyer(s)).next).toBe("verifyLegBLocked");
  });
});

describe("R3-01 (control): a lock attempt that was saved is recovered whatever the accept B's stamp", () => {
  /** The Seller's lock-B attempt is saved and the note IS written, then the process dies before the lock frame is posted: the record says "attempted". */
  async function lockAttemptedNoteWritten(): Promise<Started> {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.sellerLine]);
    const fail = failVenuePosts(s.w.venue, (_room, line) => tryDecodeFrame(line)?.type === "lock");
    await expect(s.c.seller.lockLegB((await readSwap(s.w)).acceptBRecord)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const saved = await sellerRecordOf(s.w);
    expect(saved.attemptedAcceptB, "the attempt is saved").toBeDefined();
    expect(await s.w.paper.read(saved.attemptedAcceptB!), "and the note was written").toMatchObject({ status: "locked" });
    return s;
  }

  /** Rewrites the stored accept B record's venue stamp (the signature does not cover it): a record saved by a build without the R3-01 refusal. */
  async function restampSavedAcceptB(w: World, timestampMs: number): Promise<void> {
    const key = await sellerKeyOf(w.stores.seller);
    const bytes = (await w.stores.seller.load(key))!;
    const record = decodeFlowRecord(bytes, key) as SellerFlowRecord;
    const slot = record.frames.acceptB;
    if (slot?.record === undefined) throw new Error("test: the saved accept B has no signed record");
    const edited: SellerFlowRecord = { ...record, frames: { ...record.frames, acceptB: { ...slot, record: { ...slot.record, timestampMs } } } };
    await w.stores.seller.save(key, encodeFlowRecord(edited), flowDigest(bytes));
  }

  it("lockLegB() with no argument and lockLegB(record) both recognise the lock that landed (its lock frame is posted once, the note is the one note) though accept B is stamped late", async () => {
    const s = await lockAttemptedNoteWritten();
    const offerB = (await readSwap(s.w)).offerB!;
    await restampSavedAcceptB(s.w, offerB.expiresMs + 5_000);
    const contractB = (await sellerRecordOf(s.w)).attemptedAcceptB!;
    expect((await s.w.venue.read(dealRoom(contractB))).filter((r) => tryDecodeFrame(r.line)?.type === "lock")).toHaveLength(0);

    const back = await resumedSeller(s);
    expect(back.next).toBe("lockLegB");
    expect(back.flow.recordedAcceptB!.timestampMs, "the saved record is stamped late").toBeGreaterThanOrEqual(offerB.expiresMs);
    await back.flow.lockLegB(); // no argument: continues from the saved record, not refused
    expect(await s.w.paper.read(contractB)).toMatchObject({ status: "locked" });
    expect((await s.w.venue.read(dealRoom(contractB))).filter((r) => tryDecodeFrame(r.line)?.type === "lock")).toHaveLength(1);
    // a repeat with the late record the runner holds is the recorded result: nothing is locked or posted twice
    await back.flow.lockLegB(back.flow.recordedAcceptB);
    expect((await s.w.venue.read(dealRoom(contractB))).filter((r) => tryDecodeFrame(r.line)?.type === "lock")).toHaveLength(1);
    expect((await resumedSeller(s)).next).toBe("claimLegA");
  });

  it("the attempt is saved but the note's outcome was never recorded: lockLegB() reads leg B's note from the paper rail, adopts it (no second write) and posts the frame, though accept B is stamped late", async () => {
    const s = await lockAttemptedNoteWritten();
    const offerB = (await readSwap(s.w)).offerB!;
    const contractB = (await sellerRecordOf(s.w)).attemptedAcceptB!;
    const noteBefore = await s.w.paper.read(contractB);
    expect(noteBefore).toMatchObject({ status: "locked" });
    // the record keeps the attempt but not that the lock landed (a save that never happened), and a late stamp on the saved accept B
    const key = await sellerKeyOf(s.w.stores.seller);
    const bytes = (await s.w.stores.seller.load(key))!;
    const record = decodeFlowRecord(bytes, key) as SellerFlowRecord;
    const slot = record.frames.acceptB;
    if (slot?.record === undefined) throw new Error("test: the saved accept B has no signed record");
    const { lockedLegBContract: _landed, ...rest } = record;
    const edited: SellerFlowRecord = { ...rest, frames: { ...record.frames, acceptB: { ...slot, record: { ...slot.record, timestampMs: offerB.expiresMs + 5_000 } } } };
    await s.w.stores.seller.save(key, encodeFlowRecord(edited), flowDigest(bytes));

    const back = await resumedSeller(s);
    expect(back.next).toBe("lockLegB");
    await back.flow.lockLegB();
    expect(await s.w.paper.read(contractB), "the note that was there is the note that is: nothing was written again").toEqual(noteBefore);
    expect((await sellerRecordOf(s.w)).lockedLegBContract, "recognised and recorded").toBe(contractB);
    expect((await s.w.venue.read(dealRoom(contractB))).filter((r) => tryDecodeFrame(r.line)?.type === "lock")).toHaveLength(1);
  });

  it("a flow whose attempt is saved is also recovered when the runner hands in the late record itself", async () => {
    const s = await lockAttemptedNoteWritten();
    const view = await readSwap(s.w);
    const contractB = (await sellerRecordOf(s.w)).attemptedAcceptB!;
    const back = await resumedSeller(s);
    const late: TranscriptRecord = { ...view.acceptBRecord!, timestampMs: view.offerB!.expiresMs + 5_000 }; // the signature does not cover the stamp
    await back.flow.lockLegB(late);
    expect(await s.w.paper.read(contractB)).toMatchObject({ status: "locked" });
    expect((await s.w.venue.read(dealRoom(contractB))).filter((r) => tryDecodeFrame(r.line)?.type === "lock")).toHaveLength(1);
  });
});
