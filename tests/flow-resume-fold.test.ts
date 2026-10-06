// SPDX-License-Identifier: MIT
//
// R2-16 (P8-FIXES-R2.md, decision 7): tclk's machine rejects a `lock` frame at or after the offer's `refundAfterMs` ("refund window is
// already open"). A lock the Buyer recognises that late (a resumed lockLegA that reads the chain first and finds the lock landed) is
// recorded, but its frame is no longer posted: it would never fold into the swap. The frames of the refund path are unchanged: after a
// refund the Buyer posts its refund and receipt frames as before (the machine rejects them too while leg A only reads `accepted`; this is
// documented, funds are unaffected).
//
// Ported from the archived review scratch test (idempotency lens, "IDEM2-4") with the assertions turned into the fixed behaviour. EVM
// mock node, the Buyer's lock lands and the process dies right after `commitLock`, before the evidence or the lock frame is saved.

import { dealRoom, foldTranscript, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { PREFIX, STEPS, readSwap, type World } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied, crashRail } from "./helpers/resume-flows.js";
import { buyerRecordOf, resumedBuyer, started, type Started } from "./helpers/resume-world.js";

async function foldLegA(w: World) {
  const v = await readSwap(w);
  const room = await w.venue.read(dealRoom(v.acceptA!.contract));
  const fold = foldTranscript([v.offerARecord!, v.acceptARecord!, ...room]);
  return {
    status: fold.state?.status,
    // the two account lines in the room are not tclk frames (no type); every step with a type is a frame the machine judged
    steps: fold.steps.slice(2).filter((s) => s.type !== undefined).map((s) => `${s.type}:${s.ok ? "ok" : "rejected"}`),
    frames: room.map((r) => tryDecodeFrame(r.line)?.type ?? "line"),
  };
}

/** The Buyer locked leg A on chain and the process died right after `commitLock` (nothing of it saved but the prepared lock). */
async function lockLandedUnrecorded(): Promise<Started> {
  const s = await started(evmWorld, PREFIX);
  const back = await resumedBuyer(s, (o) => ({ rail: crashRail(o.rail, { after: ["commitLock"] }) }));
  await expect(back.flow.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
  return s;
}

describe("R2-16: a lock recognised at or after leg A's refund time posts no lock frame", () => {
  it("lockLegA (recognised whatever the clock says) at refundAfterMs + 1: the lock is recorded, the room holds NO lock frame, the fold stays accepted, next names refundLegA", async () => {
    const s = await lockLandedUnrecorded();
    s.w.setTime(s.w.refundAt.legA + 1);
    const back = await resumedBuyer(s);
    expect(back.next).toBe("refundLegA"); // the F1b branch: attempted, not recognised, leg A's refund time has come
    await back.flow.lockLegA();

    const record = await buyerRecordOf(s.w);
    expect(record.lock.evidence, "the landed lock is recorded").toBeDefined();
    expect(record.lock.framePosted).toBe(false);
    const fold = await foldLegA(s.w);
    expect(fold.frames.filter((type) => type === "lock"), "a lock frame the machine would reject is not posted").toHaveLength(0);
    expect(fold.status).toBe("accepted");
    expect(fold.steps).toEqual([]); // nothing was posted into leg A's deal room that the machine would have had to reject

    expect((await resumedBuyer(s)).next).toBe("refundLegA"); // a landed, unannounced lock after the refund time: the way out is the refund
  });

  it("exactly at refundAfterMs the frame is already refused by the machine, so it is skipped; one millisecond earlier it is posted and folds locked", async () => {
    const atTime = await lockLandedUnrecorded();
    atTime.w.setTime(atTime.w.refundAt.legA);
    await (await resumedBuyer(atTime)).flow.lockLegA();
    expect((await foldLegA(atTime.w)).frames.filter((type) => type === "lock")).toHaveLength(0);

    const before = await lockLandedUnrecorded();
    before.w.setTime(before.w.refundAt.legA - 1);
    await (await resumedBuyer(before)).flow.lockLegA();
    const fold = await foldLegA(before.w);
    expect(fold.frames.filter((type) => type === "lock")).toHaveLength(1);
    expect(fold.status).toBe("locked");
    expect(fold.steps).toEqual(["lock:ok"]);
    expect((await buyerRecordOf(before.w)).lock.framePosted).toBe(true);
  });

  it("the refund path is unchanged: after the skipped lock frame refundLegA refunds, and its refund and receipt frames are posted as before", async () => {
    const s = await lockLandedUnrecorded();
    s.w.setTime(s.w.refundAt.legA + 1);
    const back = await resumedBuyer(s);
    await back.flow.lockLegA();
    await back.flow.refundLegA();
    expect(s.w.counts()).toMatchObject({ locks: 1, claims: 0, refunds: 1 });
    const fold = await foldLegA(s.w);
    expect(fold.frames).toEqual(expect.arrayContaining(["refund", "receipt"]));
    expect(fold.frames).not.toContain("lock");
    expect((await resumedBuyer(s)).next).toBe("done");
  });

  it("a runner that follows next (refundLegA straight away) never posted a lock frame either; the refund frames are the same as above", async () => {
    const s = await lockLandedUnrecorded();
    s.w.setTime(s.w.refundAt.legA + 1);
    const back = await resumedBuyer(s);
    expect(back.next).toBe("refundLegA");
    await back.flow.refundLegA();
    const fold = await foldLegA(s.w);
    expect(fold.frames).not.toContain("lock");
    expect(fold.frames).toEqual(expect.arrayContaining(["refund", "receipt"]));
  });
});
