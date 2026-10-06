// SPDX-License-Identifier: MIT
//
// R2-06 (P8-FIXES-R2.md, decision 6), the Buyer's half: offer expiry. tclk's machine rejects an accept at or after the offer's
// `expiresMs` ("offer has expired"). The Buyer therefore
//   - refuses an accept A record timestamped at or after offer A's `expiresMs` (the record's own timestamp decides, not the clock):
//     an accept like that never folded into leg A's transcript, so the swap it would pair with never existed for the venue;
//   - refuses to post accept B at or after offer B's `expiresMs` by the flow clock;
//   both with the typed `SwapExpiredError`, with nothing posted and nothing saved (leg A is never locked before accept B, so refusing
//   is always safe);
//   - and `next` says "abandoned" (nothing to call, nothing at stake) for a pairing that was saved whose accept B never landed
//     before offer B expired, instead of "acceptLegB" for ever.
// The real flows over the EVM mock node: offer A expires at T0 + 30 min, offer B at T0 + 40 min.

import { OFFER_ROOM, encodeFrame, makeAccept, tryDecodeFrame, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SwapExpiredError } from "../src/client/flow-resume.js";
import { STEPS, readSwap, type SwapView } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied, failVenuePosts, loseVenueReplies } from "./helpers/resume-flows.js";
import { buyerRecordOf, resumedBuyer, started, type Started } from "./helpers/resume-world.js";

/** A bid and the Seller's accept A / offer B, early (before either offer expires). */
async function accepted(): Promise<{ s: Started; v: SwapView & Required<Pick<SwapView, "offerA" | "offerB" | "offerBRecord" | "acceptA" | "acceptARecord">> }> {
  const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA]);
  const v = await readSwap(s.w);
  if (v.offerA === undefined || v.offerB === undefined || v.offerBRecord === undefined || v.acceptA === undefined || v.acceptARecord === undefined) throw new Error("test: the pairing frames are not in the venue");
  return { s, v: { ...v, offerA: v.offerA, offerB: v.offerB, offerBRecord: v.offerBRecord, acceptA: v.acceptA, acceptARecord: v.acceptARecord } };
}

/** The same Seller's accept of the same offer A (same statement, a fresh nonce), posted by the venue at clock `at`. */
async function acceptAAt(s: Started, v: Awaited<ReturnType<typeof accepted>>["v"], at: number): Promise<TranscriptRecord> {
  s.w.setTime(at);
  return s.w.venue.post(OFFER_ROOM, encodeFrame(makeAccept(v.offerA, { from: s.w.dids.seller, statement: v.acceptA.statement })), s.w.sellerOptions().identity);
}

const buyerAcceptsIn = async (s: Started): Promise<number> => ((await readSwap(s.w)).acceptB === undefined ? 0 : 1);
/** True for an accept frame the Buyer posts (its accept B). */
const isBuyerAccept = (s: Started, line: string): boolean => {
  const frame = tryDecodeFrame(line);
  return frame?.type === "accept" && frame.from === s.w.dids.buyer;
};

describe("R2-06 (Buyer): an accept A timestamped at or after offer A's expiry is refused", () => {
  for (const delta of [0, 60_000]) {
    it(`accept A at expiresMs + ${delta}: acceptLegB rejects with SwapExpiredError, accept B is not posted, nothing is saved`, async () => {
      const { s, v } = await accepted();
      const late = await acceptAAt(s, v, v.offerA.expiresMs + delta);
      expect(late.timestampMs).toBe(v.offerA.expiresMs + delta);
      const error = await s.c.buyer.acceptLegB(v.offerBRecord, late, s.w.lockTimeMs).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SwapExpiredError);
      expect((error as SwapExpiredError).offerId).toBe(v.offerA.id);
      expect((error as SwapExpiredError).expiresMs).toBe(v.offerA.expiresMs);
      expect(await buyerAcceptsIn(s), "no accept B in the venue").toBe(0);
      const record = await buyerRecordOf(s.w);
      expect(record.frames.acceptB, "no pairing saved").toBeUndefined();
      expect(record.legB).toBeUndefined();
      expect((await resumedBuyer(s)).next).toBe("acceptLegB");
    });
  }

  it("control: one millisecond before the expiry the same accept A pairs and accept B is posted", async () => {
    const { s, v } = await accepted();
    const ok = await acceptAAt(s, v, v.offerA.expiresMs - 1);
    await s.c.buyer.acceptLegB(v.offerBRecord, ok, s.w.lockTimeMs);
    expect(await buyerAcceptsIn(s)).toBe(1);
  });

  it("the same without a store (the check is not a store feature)", async () => {
    const s = await started(evmWorld, []);
    const { store: _store, ...rest } = s.w.buyerOptions();
    const buyer = new BuyerFlow(rest);
    s.c.buyer = buyer;
    await buyer.bid(s.w.bidParams);
    await STEPS.acceptLegA.run(s.c);
    const v = await readSwap(s.w);
    const late = await acceptAAt(s, { ...(v as Awaited<ReturnType<typeof accepted>>["v"]) }, s.w.bidParams.expiresMs);
    await expect(buyer.acceptLegB(v.offerBRecord!, late, s.w.lockTimeMs)).rejects.toBeInstanceOf(SwapExpiredError);
    expect(await buyerAcceptsIn(s)).toBe(0);
  });
});

describe("R2-06 (Buyer): accept B is not posted at or after offer B's expiry", () => {
  it("at expiresMs: acceptLegB rejects with SwapExpiredError, nothing is posted, nothing is saved", async () => {
    const { s, v } = await accepted();
    s.w.setTime(v.offerB.expiresMs);
    const error = await s.c.buyer.acceptLegB(v.offerBRecord, v.acceptARecord, s.w.lockTimeMs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwapExpiredError);
    expect((error as SwapExpiredError).offerId).toBe(v.offerB.id);
    expect((error as SwapExpiredError).expiresMs).toBe(v.offerB.expiresMs);
    expect(await buyerAcceptsIn(s)).toBe(0);
    const record = await buyerRecordOf(s.w);
    expect(record.frames.acceptB).toBeUndefined();
    expect(record.legB).toBeUndefined();
    expect((await resumedBuyer(s)).next, "an unsaved pairing names no offer B: the clock alone does not abandon it").toBe("acceptLegB");
  });

  it("control: one millisecond before the expiry accept B is posted", async () => {
    const { s, v } = await accepted();
    s.w.setTime(v.offerB.expiresMs - 1);
    await s.c.buyer.acceptLegB(v.offerBRecord, v.acceptARecord, s.w.lockTimeMs);
    expect(await buyerAcceptsIn(s)).toBe(1);
  });

  it("the same without a store", async () => {
    const s = await started(evmWorld, []);
    const { store: _store, ...rest } = s.w.buyerOptions();
    s.c.buyer = new BuyerFlow(rest);
    await s.c.buyer.bid(s.w.bidParams);
    await STEPS.acceptLegA.run(s.c);
    const v = await readSwap(s.w);
    s.w.setTime(v.offerB!.expiresMs);
    await expect(s.c.buyer.acceptLegB(v.offerBRecord!, v.acceptARecord!, s.w.lockTimeMs)).rejects.toBeInstanceOf(SwapExpiredError);
    expect(await buyerAcceptsIn(s)).toBe(0);
  });
});

describe("R2-06 (Buyer): a saved pairing whose accept B never landed before offer B expired is abandoned", () => {
  /** The pairing is saved and the accept B post never reaches the venue (the process dies before it). */
  async function savedNeverPosted() {
    const { s, v } = await accepted();
    const fail = failVenuePosts(s.w.venue, (_room, line) => isBuyerAccept(s, line));
    await expect(STEPS.acceptLegB.run(s.c)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const record = await buyerRecordOf(s.w);
    expect(record.frames.acceptB, "the pairing and accept B's text are saved").toBeDefined();
    expect(record.legB?.expiresMs).toBe(v.offerB.expiresMs);
    expect(await buyerAcceptsIn(s)).toBe(0);
    return { s, v };
  }

  it("before the expiry next says acceptLegB and the call posts the saved text; at the expiry next says abandoned and acceptLegB refuses, posting nothing", async () => {
    const early = await savedNeverPosted();
    early.s.w.setTime(early.v.offerB.expiresMs - 1);
    const back = await resumedBuyer(early.s);
    expect(back.next).toBe("acceptLegB");
    await STEPS.acceptLegB.run(early.s.c);
    expect(await buyerAcceptsIn(early.s)).toBe(1);

    const late = await savedNeverPosted();
    late.s.w.setTime(late.v.offerB.expiresMs);
    expect((await resumedBuyer(late.s)).next).toBe("abandoned");
    await expect(STEPS.acceptLegB.run(late.s.c)).rejects.toBeInstanceOf(SwapExpiredError);
    expect(await buyerAcceptsIn(late.s), "nothing was posted").toBe(0);
    expect((await resumedBuyer(late.s)).next, "and it stays abandoned").toBe("abandoned");
  });

  it("an accept B that DID land (its reply was lost, its mark never saved) is adopted by acceptLegB even after the expiry: the guard is for posting only", async () => {
    const { s, v } = await accepted();
    const lose = loseVenueReplies(s.w.venue, (_room, line) => isBuyerAccept(s, line));
    await expect(STEPS.acceptLegB.run(s.c)).rejects.toBeInstanceOf(ProcessDied);
    lose.restore();
    expect(await buyerAcceptsIn(s)).toBe(1);
    s.w.setTime(v.offerB.expiresMs + 60_000);
    // `next` is derived from the record and the clock alone (no venue read), so it says abandoned; a runner that calls the step anyway
    // adopts the line that is already in the room, and nothing is posted a second time.
    expect((await resumedBuyer(s)).next).toBe("abandoned");
    await STEPS.acceptLegB.run(s.c);
    const room = (await s.w.venue.read(OFFER_ROOM)).filter((r) => isBuyerAccept(s, r.line));
    expect(room).toHaveLength(1);
    expect((await resumedBuyer(s)).next).toBe("verifyLegBLocked");
  });
});
