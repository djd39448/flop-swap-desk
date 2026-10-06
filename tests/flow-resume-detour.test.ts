// SPDX-License-Identifier: MIT
//
// R3-03 (P8-FIXES-R3.md, decision 2): the Buyer's `next` after a SAVED refund attempt and a by-hand claim of leg B.
//
// Once `refundLegA` saved its attempt (`refund.attempted`), `nextStep` answered refundLegA unless a claim of leg A had been seen
// (`refund.claimSeen`). A person who then ran learnSecret and claimLegB by hand (the README allows the Buyer's calls whatever `next`
// says) left a flow whose `next` said refundLegA for ever, while refundLegA refuses on every call ("already claimed leg B"). Now this
// flow's own claim of leg B leaves the refund route like a seen claim does: `next` says learnSecret until leg B's receipt landed, then
// done, and no refund is ever sent after the flow's own leg B claim. `legBClaimAdopted` (a note somebody else wrote) stays unread there.
//
// Two ways into the state, both over the EVM world:
//   - fund variant: the Seller claimed leg A; the Buyer's refund attempt was saved and the process died before the refund was sent;
//   - idempotency variant: the Buyer's refund landed and the process died before its frames were posted; the Seller then posted a reveal
//     without claiming. The frames of that leg A refund stay unposted (the transcript only): the flow's own claim of leg B ends the route.

import { tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, runScript, type Ctx, type World } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied, crashRail, failVenuePosts } from "./helpers/resume-flows.js";
import { buyerRecordOf, postRevealFrame, resumedBuyer, started, strangerPaper, type Started } from "./helpers/resume-world.js";

const refundNote = /already claimed leg B/;

/** The Seller claimed leg A; the Buyer's refund attempt is saved at leg A's refund time and the process dies before the refund call. */
async function savedAttemptAfterSellerClaim(): Promise<Started> {
  const s = await started(evmWorld, [...PREFIX, STEPS.lockLegA, STEPS.claimLegA]);
  s.w.setTime(s.w.refundAt.legA);
  const dying = await resumedBuyer(s, (o) => ({ rail: crashRail(o.rail, { before: ["refund", "verifyLockFinal"] }) }));
  expect(dying.next, "before the refund attempt the Seller's claim of leg A points at the secret").toBe("learnSecret");
  await expect(dying.flow.refundLegA()).rejects.toBeInstanceOf(ProcessDied);
  const record = await buyerRecordOf(s.w);
  expect(record.refund.attempted, "the attempt is saved").toBe(true);
  expect(record.refund.claimSeen, "and no claim of leg A was recorded").toBeUndefined();
  return s;
}

describe("R3-03 (fund variant): a saved refund attempt, the Seller claimed leg A, a person claims leg B by hand", () => {
  it("next stays refundLegA until the by-hand claim of leg B (control), then says done: never refundLegA, and no refund is ever sent", async () => {
    const s = await savedAttemptAfterSellerClaim();
    const cut = await resumedBuyer(s);
    expect(cut.next, "control: a saved attempt, no claim seen, no leg B claim: the refund route stays open").toBe("refundLegA");

    await cut.flow.claimLegB(await cut.flow.learnSecret()); // by hand
    const record = await buyerRecordOf(s.w);
    expect(record.legBClaimed).toBe(true);
    expect(record.refund.attempted).toBe(true);

    const back = await resumedBuyer(s);
    expect(back.next, "this flow's own claim of leg B ends the refund route").toBe("done");
    // a runner that ignores next and calls refundLegA anyway is refused, and nothing is sent
    await expect(back.flow.refundLegA()).rejects.toThrow(refundNote);
    expect((await resumedBuyer(s)).next).toBe("done");
    expect(s.w.counts()).toMatchObject({ locks: 1, claims: 1, refunds: 0, refundBuilds: 0 });
    expect((await s.w.paper.read((await buyerRecordOf(s.w)).contractB!))?.status).toBe("claimed");
  });

  it("a claim of leg B whose receipt frame is not posted yet says learnSecret (the way back into claimLegB), then done once it is", async () => {
    const s = await savedAttemptAfterSellerClaim();
    const cut = await resumedBuyer(s);
    const secret = await cut.flow.learnSecret();
    const fail = failVenuePosts(s.w.venue, (_room, line) => tryDecodeFrame(line)?.type === "receipt");
    await expect(cut.flow.claimLegB(secret)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const record = await buyerRecordOf(s.w);
    expect(record.legBClaimed, "the paper claim was made and saved before the receipt post").toBe(true);

    const mid = await resumedBuyer(s);
    expect(mid.next).toBe("learnSecret");
    await mid.flow.claimLegB(await mid.flow.learnSecret());
    expect((await resumedBuyer(s)).next).toBe("done");
    expect(s.w.counts()).toMatchObject({ locks: 1, claims: 1, refunds: 0 });
  });

  it("a note somebody else wrote (an ADOPTED claim of leg B, not this flow's own) does not leave the refund route: next stays refundLegA", async () => {
    const s = await savedAttemptAfterSellerClaim();
    const cut = await resumedBuyer(s);
    expect(cut.next).toBe("refundLegA");
    // the Seller (who holds the secret) writes leg B's note claimed outside any flow: paper notes are not bound to who wrote them
    const record = await buyerRecordOf(s.w);
    await strangerPaper(s.w).claim(record.contractB!, s.w.hashLock.preimage);
    const back = await resumedBuyer(s);
    expect(back.next, "R1-06: an adopted-only claim is deliberately not read here").toBe("refundLegA");
  });
});

describe("R3-03 (idempotency variant): the refund landed, its frames were never posted, a person claims leg B by hand", () => {
  /** Cut the Buyer right before its first refund frame post: the refund is on chain, nothing about it is in the room. */
  async function refundLandedFramesUnposted(): Promise<{ w: World; ctl: Controller }> {
    const steps = [...PREFIX, STEPS.lockLegA, STEPS.legARefundTime, STEPS.refundLegA];
    const reference = await runScript(evmWorld, steps, []);
    const action = reference.world.ctl.actions.find((c) => c.role === "buyer" && c.what.startsWith("post:refund"));
    if (action === undefined) throw new Error(`no post:refund action: ${reference.world.ctl.actions.map((a) => a.what).join(",")}`);
    const ctl = new Controller([{ n: action.n, mode: "before" }]);
    const w = evmWorld(ctl);
    ctl.attachStore(w.stores.buyer, "buyer");
    ctl.attachStore(w.stores.seller, "seller");
    const buyer = new BuyerFlow(w.buyerOptions());
    const seller = new SellerFlow(w.sellerOptions());
    const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
    for (const step of [...PREFIX, STEPS.lockLegA]) await step.run(c);
    w.setTime(w.refundAt.legA);
    await buyer.refundLegA().catch(() => undefined);
    expect(ctl.isDead("buyer"), "the Buyer died right before its refund frames").toBe(true);
    expect(w.counts().refunds, "the refund is on chain").toBe(1);
    return { w, ctl };
  }

  it("next says done after the by-hand claim of leg B (it said refundLegA for ever); one refund, no second one", async () => {
    const { w, ctl } = await refundLandedFramesUnposted();
    // the Seller (who always holds the secret) posts a reveal without claiming leg A
    const saved = await buyerRecordOf(w);
    await postRevealFrame(w, saved.lock.prepared?.ref ?? saved.lock.evidence!.ref);

    const resume = async () => {
      ctl.restart("buyer");
      return BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId });
    };
    const first = await resume();
    expect(first.next, "control: a saved attempt, no claim seen, no leg B claim").toBe("refundLegA");
    await first.flow.claimLegB(await first.flow.learnSecret()); // by hand

    const nexts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const again = await resume();
      nexts.push(again.next);
      await expect(again.flow.refundLegA()).rejects.toThrow(refundNote);
    }
    expect(nexts).toEqual(["done", "done", "done"]);
    expect(w.counts().refunds, "the landed refund is the only one").toBe(1);
  });
});
