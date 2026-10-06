// SPDX-License-Identifier: MIT
//
// tests/flow-resume-ring.test.ts - review round 1, R1-12 at the flows: the offers room is a SHORT RING, so a read there can miss a line
// that did land. A step the record shows as confirmed must never post its line again because a read missed it:
//
//   B1  the Buyer's `acceptLegB`, called again with the recorded pairing, returns the recorded result: no second accept B, the ledger keeps
//       the original seq (before the fix the duplicate moved the recorded seq to itself)
//   B2  a Seller resumed after the ring rolled, whose accept A had landed and whose offer B reply was lost, posts no second accept A and keeps
//       the original accept A record (before the fix both frames were re-posted and the stored accept A became a duplicate dated after the
//       offer's expiry, which tclk's machine folds as "offer has expired")
//
// Every step is the real flow over the EVM mock node (tests/helpers/matrix-worlds.ts).

import { OFFER_ROOM, foldTranscript, tryDecodeFrame, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { ledgerEntry } from "../src/client/flow-record.js";
import { recordFromJson } from "../src/client/flow-resume.js";
import type { MemoryVenue } from "../src/client/venue.js";
import { STEPS, readSwap } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied, loseVenueReplies } from "./helpers/resume-flows.js";
import { buyerRecordOf, resumedBuyer, resumedSeller, sellerRecordOf, started } from "./helpers/resume-world.js";
import { framesIn } from "./helpers/sol-flow-harness.js";

/** The offers room as a short ring: from now on a read shows only lines posted after `cutoffSeq` (the older ones rolled out). */
function ringRollsOver(venue: MemoryVenue, room: string, cutoffSeq: number): { restore: () => void } {
  const target = venue as unknown as { read: (room: string) => Promise<readonly TranscriptRecord[]> };
  const original = target.read.bind(venue);
  target.read = async (name: string) => {
    const all = await original(name);
    return name === room ? all.filter((record) => record.seq > cutoffSeq) : all;
  };
  return {
    restore: () => {
      target.read = original;
    },
  };
}

describe("R1-12 B1: a confirmed acceptLegB called again posts nothing and keeps its ledger seq", () => {
  it("the ring rolled; acceptLegB with the recorded pairing returns the recorded accept B, even for a lock time that is no longer safe", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB]);
    const before = await buyerRecordOf(s.w);
    const landedSeq = ledgerEntry(before, "accept-b")!.landed!.seq;
    const ring = ringRollsOver(s.w.venue, OFFER_ROOM, (await s.w.venue.read(OFFER_ROOM)).length);
    try {
      const back = await resumedBuyer(s);
      expect(back.next).toBe("verifyLegBLocked");
      const pairing = back.flow.recordedPairing!;
      // the runner asks again with the recorded pairing and a lock time far later than the one the pairing was checked at: the deadline
      // arithmetic would refuse it, but a confirmed step answers with what was recorded
      const answer = await back.flow.acceptLegB(pairing.offerBRecord, pairing.acceptARecord, s.w.refundAt.legA);
      expect(answer.acceptBRecord.seq).toBe(landedSeq);
      expect(answer.acceptBRecord.line).toBe(before.frames.acceptB!.text);
    } finally {
      ring.restore();
    }
    const mine = framesIn(await s.w.venue.read(OFFER_ROOM), "accept").filter((record) => record.sender === s.w.dids.buyer);
    expect(mine, "no second accept B").toHaveLength(1);
    const after = await buyerRecordOf(s.w);
    expect(ledgerEntry(after, "accept-b")!.landed!.seq, "the ledger names the original seq").toBe(landedSeq);
    expect(after.frames.acceptB!.record!.seq).toBe(landedSeq);
  });

  it("a different pairing than the recorded one is still refused (a party never posts a second, different accept)", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB]);
    const back = await resumedBuyer(s);
    const pairing = back.flow.recordedPairing!;
    const other = { ...pairing.acceptARecord, line: `${pairing.acceptARecord.line} ` };
    await expect(back.flow.acceptLegB(pairing.offerBRecord, other, s.w.lockTimeMs)).rejects.toThrow(/different pairing/);
  });
});

describe("R1-12 B2: a Seller resumed after the ring rolled posts no second accept A", () => {
  it("accept A landed, the offer B reply was lost, the ring rolled and the offer expired: only offer B is posted again, accept A stays the original", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    const lose = loseVenueReplies(s.w.venue, (_room, line) => {
      const frame = tryDecodeFrame(line);
      return frame?.type === "offer" && frame.from === s.w.dids.seller;
    });
    await expect(STEPS.acceptLegA.run(s.c)).rejects.toBeInstanceOf(ProcessDied);
    lose.restore();
    const saved = await sellerRecordOf(s.w);
    expect(ledgerEntry(saved, "accept-a")!.landed, "accept A is confirmed").toBeDefined();
    expect(ledgerEntry(saved, "offer-b")!.landed, "offer B is not").toBeUndefined();
    const room = await s.w.venue.read(OFFER_ROOM);
    const originalOfferA = framesIn(room, "offer").find((record) => record.sender === s.w.dids.buyer)!;
    const originalAcceptA = framesIn(room, "accept").find((record) => record.sender === s.w.dids.seller)!;

    const ring = ringRollsOver(s.w.venue, OFFER_ROOM, room.length);
    try {
      s.w.setTime(s.w.bidParams.expiresMs + 60_000); // the restart comes after offer A's expiry
      const back = await resumedSeller(s);
      expect(back.next).toBe("acceptLegA");
      const offerA = back.flow.recordedOfferA!;
      await back.flow.acceptLegA(offerA, s.w.legB, s.w.lockTimeMs);
    } finally {
      ring.restore();
    }

    const all = await s.w.venue.read(OFFER_ROOM);
    const sellerAccepts = framesIn(all, "accept").filter((record) => record.sender === s.w.dids.seller);
    expect(sellerAccepts, "accept A is never posted again").toHaveLength(1);
    const stored = await sellerRecordOf(s.w);
    const storedAccept = recordFromJson(stored.frames.acceptA!.record!);
    expect(storedAccept.seq, "the stored accept A record is the original").toBe(originalAcceptA.seq);
    // tclk's machine still folds the stored pair as accepted (a duplicate dated after the expiry would be "offer has expired")
    const fold = foldTranscript([originalOfferA, storedAccept]);
    expect(fold.state?.status).toBe("accepted");
    const view = await readSwap(s.w);
    expect(view.acceptARecord?.seq).toBe(originalAcceptA.seq);
    // offer B had no confirmed landing and rolled off the ring, so it is the one line that is posted again, as the identical text
    // (the documented limit: a line whose landing was never confirmed cannot be told from one that never landed)
    expect(framesIn(all, "offer").filter((record) => record.sender === s.w.dids.seller).length).toBeLessThanOrEqual(2);
  });
});
