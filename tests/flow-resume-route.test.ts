// SPDX-License-Identifier: MIT
//
// R2-02 (P8-FIXES-R2.md, decision 2): the Buyer's `next` after a refund that routed to a claim BEFORE refundAttempted was set.
//
// The case (variant F1b): the Buyer's lock lands and its lock frame post lands, but the save after the post is lost, so the record
// lacks the frame. The honest Seller sees the frame and claims leg A. The Buyer stays down past leg A's refund time; leg B stays
// claimable until its own refund time, a long while later. On resume `next` is refundLegA (the lock was attempted and not recognised,
// and leg A's refund time has come). On a rail with `checkPendingClaim` (Bitcoin, NEAR, Solana) refundLegA reads leg A's claim through
// it BEFORE it saves a refund attempt, persists claimSeen and throws the routing error. Before the fix `next` stayed refundLegA for
// ever (a runner that follows `next` never claimed leg B), and after the Buyer's own claimLegB it still did not say done.
//
// Each world runs the same steps: cut the Buyer at the lock frame post (after-store-fail), the Seller claims leg A, the clock moves to
// leg A's refund time, and the Buyer resumes. next === refundLegA and refundLegA throws the routing error; resume again: next ===
// learnSecret (the fix); learnSecret and claimLegB succeed; resume again: next === done, and no second refund was ever started.
// EVM has no `checkPendingClaim`: its refund is attempted first, so it never took this route; kept below as the negative control.

import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, runScript, type Ctx, type Mode, type World, type WorldFactory } from "./helpers/crash-matrix.js";
import { evmWorld, ledgerWorldWith, nearWorld, solWorld } from "./helpers/matrix-worlds.js";
import { buyerRecordOf, contractsOf, postRevealFrame, strangerPaper } from "./helpers/resume-world.js";

async function actionNumber(factory: WorldFactory, prefix: string): Promise<number> {
  const reference = await runScript(factory, [...PREFIX, STEPS.lockLegA], []);
  const action = reference.world.ctl.actions.find((candidate) => candidate.role === "buyer" && candidate.what.startsWith(prefix));
  if (action === undefined) throw new Error(`no outward action ${prefix}: ${reference.world.ctl.actions.map((a) => a.what).join(",")}`);
  return action.n;
}

interface Run {
  nextAfterRoute: string[];
  nextAfterOwnClaim: string;
  refundErrors: string[];
  counts: unknown;
  refundAttemptedInRecord: boolean;
}

interface Cut {
  ctl: Controller;
  w: World;
  seller: SellerFlow;
}

/** The Buyer is cut at the lock frame post (the post lands, the save after it is refused or the process dies right after it). */
async function cutAtLockFrame(factory: WorldFactory, mode: Mode): Promise<Cut> {
  const n = await actionNumber(factory, "post:lock");
  const ctl = new Controller([{ n, mode }]);
  const w = factory(ctl);
  ctl.attachStore(w.stores.buyer, "buyer");
  ctl.attachStore(w.stores.seller, "seller");
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of PREFIX) await step.run(c);
  await buyer.lockLegA().catch(() => undefined);
  expect(ctl.isDead("buyer")).toBe(true);
  return { ctl, w, seller };
}

async function resumeBuyer(cut: Cut): Promise<{ flow: BuyerFlow; next: string }> {
  cut.ctl.restart("buyer");
  return BuyerFlow.resume({ ...cut.w.buyerOptions(), store: cut.w.stores.buyer, swapId: cut.w.swapId });
}

async function scenario(factory: WorldFactory, mode: Mode): Promise<Run> {
  const cut = await cutAtLockFrame(factory, mode);
  const { w } = cut;
  // the lock frame is in the room (its post landed, the save after it was lost): the honest Seller claims leg A
  await cut.seller.claimLegA(cut.seller.statement!);
  w.setTime(w.refundAt.legA); // the Buyer comes back at leg A's refund time; leg B refunds at refundAt.legB

  const nextAfterRoute: string[] = [];
  const refundErrors: string[] = [];
  // first resume: the lock is attempted and not recognised, leg A's refund time has come
  const first = await resumeBuyer(cut);
  nextAfterRoute.push(first.next);
  await first.flow.refundLegA().then(
    () => refundErrors.push("refundLegA resolved"),
    (error: unknown) => refundErrors.push((error as Error).message),
  );
  // second resume: the routing fact is saved, so the way on is learnSecret then claimLegB
  const second = await resumeBuyer(cut);
  nextAfterRoute.push(second.next);
  const secret = await second.flow.learnSecret();
  await second.flow.claimLegB(secret);
  // third resume: the Buyer's own claim of leg B is recorded, the swap is done
  const third = await resumeBuyer(cut);
  const record = await buyerRecordOf(w);
  return {
    nextAfterRoute,
    nextAfterOwnClaim: third.next,
    refundErrors,
    counts: w.counts(),
    refundAttemptedInRecord: record.refund.attempted,
  };
}

function expectFixed(run: Run): void {
  expect({ nextAfterRoute: run.nextAfterRoute, nextAfterOwnClaim: run.nextAfterOwnClaim }).toEqual({
    nextAfterRoute: ["refundLegA", "learnSecret"],
    nextAfterOwnClaim: "done",
  });
  expect(run.refundErrors).toHaveLength(1);
  expect(run.refundErrors[0]).toMatch(/learnSecret\(\) then claimLegB\(\)/);
  // no refund was started on the way: the claim won and leg B was claimed by the Buyer
  expect(run.counts).toMatchObject({ locks: 1, claims: 1, refunds: 0, refundBuilds: 0 });
  expect(run.refundAttemptedInRecord).toBe(false);
}

describe("R2-02: next after a refund that routed to the claim before refundAttempted was set", () => {
  it("btc ledger world: refundLegA routes, next says learnSecret, then done after the Buyer's own claimLegB", async () => {
    expectFixed(await scenario(ledgerWorldWith("btc", () => undefined), "after-store-fail"));
  });

  it("near (real rail over the RPC simulator): the same", async () => {
    expectFixed(await scenario(nearWorld, "after-store-fail"));
  });

  it("sol (real rail over the stateful node): the same", async () => {
    expectFixed(await scenario(solWorld, "after-store-fail"));
  });

  it("btc ledger world, the store write after the lock frame commits and the process dies (after-store-ok): the lock frame is recorded, the same route holds", async () => {
    // Here the record holds the frame, so the F1b branch is not the one taken; next must still end at done after the claim.
    const run = await scenario(ledgerWorldWith("btc", () => undefined), "after-store-ok");
    expect(run.nextAfterOwnClaim).toBe("done");
    expect(run.counts).toMatchObject({ locks: 1, claims: 1, refunds: 0 });
  });
});

describe("R2-02 negative control: EVM (no checkPendingClaim) already took the learnSecret route", () => {
  it("evm: the refund is attempted first, then routed; next says learnSecret, then done after claimLegB", async () => {
    const run = await scenario(evmWorld, "after-store-fail");
    // EVM has no pending-claim read: refundLegA attempts the refund first (refundAttempted saved), which the contract refuses
    // for a claimed lock, then routes. `next` was already learnSecret on this route before the fix and must stay so.
    expect(run.nextAfterRoute[1]).toBe("learnSecret");
    expect(run.nextAfterOwnClaim).toBe("done");
    expect(run.counts).toMatchObject({ locks: 1, claims: 1 });
  });
});

describe("R2-02 guard: an adopted-only leg B claim stays on the refund doorway (R1-06)", () => {
  for (const [name, factory] of [
    ["btc ledger world", ledgerWorldWith("btc", () => undefined)],
    ["evm", evmWorld],
  ] as const) {
    it(`${name}: the Seller wrote leg B's note claimed and posted a reveal, never claimed leg A: next stays refundLegA (not learnSecret, not done), and the refund goes`, async () => {
      const cut = await cutAtLockFrame(factory, "after-store-fail");
      const { w } = cut;
      const ref = (await buyerRecordOf(w)).lock.prepared!.ref;
      const { contractB } = await contractsOf(w);
      await strangerPaper(w).claim(contractB, w.hashLock.preimage); // a note anyone holding the secret can write at no cost
      await postRevealFrame(w, ref);
      w.setTime(w.refundAt.legA);

      const first = await resumeBuyer(cut);
      expect(first.next).toBe("refundLegA");
      await first.flow.claimLegB(await first.flow.learnSecret()); // the note reads claimed with this secret: ADOPTED, not this flow's own
      const adopted = await buyerRecordOf(w);
      expect(adopted.legBClaimed).toBe(false);
      expect(adopted.legBClaimAdopted).toBe(true);

      const again = await resumeBuyer(cut);
      expect(again.next, "an adopted claim is not a reason to leave the refund doorway").toBe("refundLegA");
      await again.flow.refundLegA();
      expect(w.counts()).toMatchObject({ locks: 1, claims: 0, refunds: 1 });
    });
  }
});
