// SPDX-License-Identifier: MIT
//
// tests/flow-resume-refund.test.ts - review round 1, the Buyer's refund path (src/client/buyer.ts refundLegA / recoverRefundA):
//
//   R1-09  the refund note of a paper note that reads claimed is recorded ONCE, not once per call: 64 failed attempts used to
//          fill the capped list and every later save failed before the refund was signed, in this process and after a restart
//   R1-08  a recorded refund that LANDED AND FAILED (a NEAR payout, a Solana refund) is resolved, and exactly one fresh refund follows
//   R1-15  a refund that lost the race to a claim persists a "claim seen" flag, so `next` says learnSecret, not refundLegA for ever
//   R1-16  overlapping refundLegA calls are refused (at most one refund build)
//
// The rails are the real ones over their stateful harnesses (Solana node, NEAR RPC simulator) or the stateful ledger fake (Bitcoin).

import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { decodeFlowRecord, type BuyerFlowRecord } from "../src/client/flow-record.js";
import { flowKey } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, readSwap, type Ctx, type World, type WorldFactory } from "./helpers/crash-matrix.js";
import { ledgerWorldWith, solWorld } from "./helpers/matrix-worlds.js";

async function started(factory: WorldFactory, steps = [...PREFIX, STEPS.lockLegA]): Promise<{ ctl: Controller; w: World; c: Ctx }> {
  const ctl = new Controller();
  const w = factory(ctl);
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of steps) await step.run(c);
  return { ctl, w, c };
}

/** Restarts the Buyer (a new epoch) and resumes a fresh flow from the store. `tweak` receives the new epoch's options (the rail the
 *  world wraps for THIS process) and may swap parts of them, e.g. a rail that fails. */
async function resumed(s: { ctl: Controller; w: World; c: Ctx }, tweak: (options: ReturnType<World["buyerOptions"]>) => Partial<ReturnType<World["buyerOptions"]>> = () => ({})): Promise<BuyerFlow> {
  s.ctl.restart("buyer");
  const options = s.w.buyerOptions();
  const result = await BuyerFlow.resume({ ...options, ...tweak(options), store: s.w.stores.buyer, swapId: s.w.swapId });
  s.c.buyer = result.flow;
  s.c.history.push(result.flow);
  return result.flow;
}

async function buyerRecordOf(w: World): Promise<BuyerFlowRecord> {
  const key = flowKey("buyer", w.swapId);
  return decodeFlowRecord((await w.stores.buyer.load(key))!, key) as BuyerFlowRecord;
}

/** A rail whose connected `refund` throws while `state.down` (an RPC outage); everything else passes through. */
function flaky(rail: CounterAssetRail, state: { down: boolean }): CounterAssetRail {
  return new Proxy(rail, {
    get(target, prop, receiver) {
      if (prop === "connect") {
        return async (...args: Parameters<CounterAssetRail["connect"]>) => {
          const connected = await target.connect(...args);
          return new Proxy(connected, {
            get(ct, cp, cr) {
              if (cp === "refund") {
                return async (...a: unknown[]) => {
                  if (state.down) throw new Error("rpc: fetch failed (simulated outage)");
                  return (ct.refund as (...x: unknown[]) => unknown)(...a);
                };
              }
              const v: unknown = Reflect.get(ct, cp, cr);
              return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(ct) : v;
            },
          });
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe("R1-09: the refund note of a claimed paper note is recorded once, so the refund stays reachable (Solana)", () => {
  /** Anyone who holds the secret writes leg B's paper note as claimed at no cost; the refund deliberately goes on past it. */
  async function outage(restartAfter: boolean): Promise<{ w: World; flow: BuyerFlow; failures: number }> {
    const s = await started(solWorld);
    const contractB = (await readSwap(s.w)).acceptB!.contract;
    await s.w.paper.claim(contractB, s.w.hashLock.preimage);
    s.w.setTime(s.w.refundAt.legA);
    const state = { down: true };
    let flow = await resumed(s, (options) => ({ rail: flaky(options.rail, state) }));
    let failures = 0;
    for (let i = 0; i < 100; i += 1) {
      const error = await flow.refundLegA().then(() => undefined, (e: unknown) => e);
      if (error instanceof Error && /simulated outage/.test(error.message)) failures += 1;
      else throw error ?? new Error("a refund went through during the outage");
    }
    expect(s.w.counts().refunds).toBe(0);
    state.down = false; // the outage is over
    if (restartAfter) flow = await resumed(s); // a fresh process, a healthy rail
    else expect(flow.refundNotes).toHaveLength(1);
    return { w: s.w, flow, failures };
  }

  it("100 failed refund attempts leave ONE note; when the rail recovers the refund is sent, once, in the same process", async () => {
    const { w, flow, failures } = await outage(false);
    expect(failures).toBe(100);
    expect((await buyerRecordOf(w)).refundNotes).toHaveLength(1); // on disk too
    await flow.refundLegA();
    expect(w.counts().refunds).toBe(1);
    expect(flow.refundNotes).toHaveLength(1);
    expect((await buyerRecordOf(w)).refundNotes).toHaveLength(1);
  });

  it("the same after a restart: the fresh process refunds (it used to refuse before signing, calling the healthy record corrupt)", async () => {
    const { w, flow } = await outage(true);
    expect(flow.refundNotes).toHaveLength(1);
    await flow.refundLegA();
    expect(w.counts().refunds).toBe(1);
    expect((await buyerRecordOf(w)).refundNotes).toHaveLength(1);
  });
});

describe("R1-16: overlapping calls of one Buyer step in one process are refused (in-flight flags)", () => {
  it("two overlapping postAccountLineA calls for two addresses: the second is refused, only the first line is built and saved", async () => {
    const s = await started(ledgerWorldWith("btc", () => undefined), PREFIX.slice(0, 6)); // everything up to verifyLegBLocked
    const first = s.c.buyer.postAccountLineA(s.w.addresses.buyer);
    const second = s.c.buyer.postAccountLineA(s.w.addresses.seller);
    await expect(second).rejects.toThrow(/already in flight/);
    await first;
    expect((await buyerRecordOf(s.w)).ownAccountLine?.address).toBe(s.w.addresses.buyer);
    await s.c.buyer.postAccountLineA(s.w.addresses.buyer); // a later call (nothing in flight) is the ordinary confirmed repeat
  });

  it("two overlapping refundLegA calls on Bitcoin: the second is refused and exactly ONE refund is built", async () => {
    const s = await started(ledgerWorldWith("btc", () => undefined));
    s.w.setTime(s.w.refundAt.legA);
    const first = s.c.buyer.refundLegA();
    const second = s.c.buyer.refundLegA();
    await expect(second).rejects.toThrow(/already in flight/);
    await first;
    expect(s.w.counts().refundBuilds).toBe(1);
    expect(s.w.counts().refunds).toBe(1);
  });

  it("two overlapping claimLegB calls: the second is refused, the first claims leg B and posts its frames once", async () => {
    const s = await started(ledgerWorldWith("btc", () => undefined), [...PREFIX, STEPS.lockLegA, STEPS.claimLegA]);
    const secret = await s.c.buyer.learnSecret();
    const first = s.c.buyer.claimLegB(secret);
    const second = s.c.buyer.claimLegB(secret);
    await expect(second).rejects.toThrow(/already in flight/);
    await first;
    const view = await readSwap(s.w);
    expect((await s.w.paper.read(view.acceptB!.contract))?.status).toBe("claimed");
    expect((await buyerRecordOf(s.w)).legBClaimed).toBe(true);
  });
});
