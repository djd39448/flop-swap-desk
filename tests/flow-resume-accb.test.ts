// SPDX-License-Identifier: MIT
//
// R2-07 (P8-FIXES-R2.md): the Seller saves the Buyer's signed accept B (frames.acceptB.record) with the lock-B intent, but gave no way to hand it
// back. The offers room is a short ring: when a lock was started (attemptedAcceptB saved) and the process died before the note was written,
// and the ring then rolled past accept B, `next` said lockLegB and the runner had no accept B to pass, so leg B never locked and the swap died
// before leg A (nothing was at stake: the Buyer's verifyLegBLocked refuses). Now `SellerFlow.recordedAcceptB` returns the saved record and
// `lockLegB()` with no argument continues from it. Ported from the idempotency lens of review round 2 (IDEM2-3).

import { OFFER_ROOM, dealRoom, tryDecodeFrame, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import type { MemoryVenue } from "../src/client/venue.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, STEPS, readSwap } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied } from "./helpers/resume-flows.js";
import { resumedSeller, sellerRecordOf, started, type Started } from "./helpers/resume-world.js";

/** Rooms drop every record at or below `cutoffSeq` from now on (the venue's ring rolled past them). */
function ringRollsOver(venue: MemoryVenue, room: string, cutoffSeq: number): void {
  const target = venue as unknown as { read: (room: string) => Promise<readonly TranscriptRecord[]> };
  const original = target.read.bind(venue);
  target.read = async (name: string) => {
    const all = await original(name);
    return name === room ? all.filter((record) => record.seq > cutoffSeq) : all;
  };
}

/** The lock-B attempt is saved (attemptedAcceptB, the signed accept B) and the process dies right before the note write; then the ring rolls. */
async function lockStartedThenRingRolled(): Promise<{ s: Started; original: TranscriptRecord }> {
  const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.sellerLine]);
  const dying = await resumedSeller(s, (o) => ({
    paperRail: new Proxy(o.paperRail, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property === "lock") {
          return async () => {
            throw new ProcessDied("before note:lock");
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }),
  }));
  const original = (await readSwap(s.w)).acceptBRecord;
  if (original === undefined) throw new Error("test: accept B is not in the venue");
  await expect(dying.flow.lockLegB(original)).rejects.toBeInstanceOf(ProcessDied);
  const record = await sellerRecordOf(s.w);
  expect(record.attemptedAcceptB, "the attempt is saved").toBeDefined();
  expect(record.frames.acceptB?.record, "with the signed accept B").toBeDefined();
  expect(await s.w.paper.read(record.attemptedAcceptB!), "the note was never written").toBeNull();
  ringRollsOver(s.w.venue, OFFER_ROOM, (await s.w.venue.read(OFFER_ROOM)).length);
  expect((await readSwap(s.w)).acceptBRecord, "accept B has rolled out of the offers room").toBeUndefined();
  return { s, original };
}

/** Seller lock frames in leg B's deal room, and leg B's note status. */
async function legBState(s: Started): Promise<{ lockFrames: number; note: string | undefined }> {
  const contractB = (await sellerRecordOf(s.w)).attemptedAcceptB!;
  const lockFrames = (await s.w.venue.read(dealRoom(contractB))).filter((record) => record.sender === s.w.dids.seller && tryDecodeFrame(record.line)?.type === "lock").length;
  return { lockFrames, note: (await s.w.paper.read(contractB))?.status };
}

describe("R2-07: the Seller hands back the Buyer's accept B it saved", () => {
  it("next is lockLegB, accept B is gone from the room, and lockLegB(flow.recordedAcceptB) locks leg B exactly once; the Buyer's verifyLegBLocked passes", async () => {
    const { s, original } = await lockStartedThenRingRolled();
    const back = await resumedSeller(s);
    expect(back.next).toBe("lockLegB");
    const saved = back.flow.recordedAcceptB;
    expect(saved, "the flow hands the saved record back").toBeDefined();
    expect(saved).toEqual(original);
    await back.flow.lockLegB(saved);
    expect(await legBState(s)).toEqual({ lockFrames: 1, note: "locked" });
    await s.c.buyer.verifyLegBLocked();
    expect((await resumedSeller(s)).next).toBe("claimLegA");
  });

  it("lockLegB() with no argument does the same", async () => {
    const { s } = await lockStartedThenRingRolled();
    const back = await resumedSeller(s);
    expect(back.next).toBe("lockLegB");
    await back.flow.lockLegB();
    expect(await legBState(s)).toEqual({ lockFrames: 1, note: "locked" });
    await s.c.buyer.verifyLegBLocked();
    // a repeat is the recorded result: nothing is locked or posted twice
    await back.flow.lockLegB();
    expect(await legBState(s)).toEqual({ lockFrames: 1, note: "locked" });
  });

  it("a flow whose lock was never attempted has no accept B of its own: recordedAcceptB is undefined and lockLegB() says what it needs", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.sellerLine]);
    const back = await resumedSeller(s);
    expect(back.next).toBe("lockLegB");
    expect(back.flow.recordedAcceptB).toBeUndefined();
    await expect(back.flow.lockLegB()).rejects.toThrow(/lockLegB needs the Buyer's accept B record/);
    expect(await sellerRecordOf(s.w).then((r) => r.attemptedAcceptB), "nothing was attempted by the refusal").toBeUndefined();
    // the runner's own record still works
    await back.flow.lockLegB((await readSwap(s.w)).acceptBRecord);
    expect((await sellerRecordOf(s.w)).lockedLegBContract).toBeDefined();
  });

  it("a flow that never began has no record to hand back", () => {
    const flow = new SellerFlow(evmWorld(new Controller()).sellerOptions());
    expect(flow.recordedAcceptB).toBeUndefined();
  });
});
