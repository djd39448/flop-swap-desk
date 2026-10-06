// SPDX-License-Identifier: MIT
//
// tests/flow-resume-two.test.ts - review round 1, R1-02 at the Buyer: two live instances on one record (a supervisor that believes the
// first process died and starts a second; a runner that times a hung call out and resumes while the call is still running).
//
// Before the single-writer store, each instance's latches were its own: both funded Bitcoin leg A, the record named the second funding while
// the Seller claimed the first, and the Buyer could neither learn the secret nor refund the first output. Now the second instance's first
// save is refused (`FlowRecordStaleError`), so it never sends anything. The matrix (tests/resume-matrix-*.test.ts, "two Buyer instances")
// covers both lock calls at once and in turn on every rail; these are the two other orders the review found:
//
//   F-C2  P1 locks, then P2 only records a verification: P2's save is stale, so it cannot reset P1's lock section
//   F-C4  one process: a hung `prepareLock`, a fresh flow resumed meanwhile, the hung call wakes up: still ONE funding

import { dealRoom, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { FlowRecordStaleError, FlowStoreWriteFailedError } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, readSwap, type Ctx, type World } from "./helpers/crash-matrix.js";
import { btcWorld } from "./helpers/matrix-worlds.js";

async function paired(options: { slowPrepare?: { gate: Promise<void> } } = {}): Promise<{ w: World; c: Ctx; ctl: Controller }> {
  const ctl = new Controller();
  const w = btcWorld(ctl);
  const base = w.buyerOptions();
  const rail = options.slowPrepare === undefined ? base.rail : hangingPrepare(base.rail, options.slowPrepare.gate);
  const buyer = new BuyerFlow({ ...base, rail });
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of PREFIX) await step.run(c);
  return { w, c, ctl };
}

/** A rail whose FIRST connected `prepareLock` waits for `gate` (a slow wallet or a hung RPC). */
function hangingPrepare(rail: CounterAssetRail, gate: Promise<void>): CounterAssetRail {
  let first = true;
  return new Proxy(rail, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === "connect") {
        return async (...args: Parameters<CounterAssetRail["connect"]>) => {
          const connected = await target.connect(...args);
          return new Proxy(connected, {
            get(t, p2) {
              const v: unknown = Reflect.get(t, p2, t);
              if (p2 === "prepareLock" && first) {
                first = false;
                return async (...a: unknown[]) => {
                  await gate;
                  return (v as (...x: unknown[]) => unknown).apply(t, a);
                };
              }
              return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
            },
          });
        };
      }
      return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const lockFrames = async (w: World): Promise<number> => {
  const contractA = (await readSwap(w)).acceptA!.contract;
  return (await w.venue.read(dealRoom(contractA))).filter((record) => tryDecodeFrame(record.line)?.type === "lock").length;
};

describe("R1-02, F-C2: a second instance that only records a verification cannot reset the first one's lock section", () => {
  it("P1 locks, then P2's verifyLegBLocked is refused as stale; a third resume sees P1's lock (next is not lockLegA) and funds nothing", async () => {
    const { w, c } = await paired();
    const p2 = (await BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId })).flow; // same store, still next = lockLegA
    await c.buyer.lockLegA();
    expect(w.counts().locks).toBe(1);

    const stale = await p2.verifyLegBLocked().catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(FlowRecordStaleError); // before: the save went through and erased the lock

    const third = await BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId });
    expect(third.next).toBe("learnSecret"); // before: lockLegA, and a second funding
    expect(w.counts().locks).toBe(1);
    expect(await lockFrames(w)).toBe(1);
  });
});

describe("R1-02, F-C4: a runner that abandons a hung lockLegA and resumes a fresh flow", () => {
  it("the hung call wakes up after the fresh flow locked: it is refused at its save, and there is ONE funding and one lock frame", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { w, c } = await paired({ slowPrepare: { gate } });
    const hung = c.buyer.lockLegA(); // hangs in prepareLock (a slow wallet, a hung RPC)
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.counts().locks).toBe(0);

    // the runner times the step out and resumes a fresh flow from the store, in the same process
    const fresh = await BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId });
    expect(fresh.next).toBe("lockLegA");
    await fresh.flow.lockLegA();
    expect(w.counts().locks).toBe(1);

    release(); // the hung call wakes up and carries on with the prepared funding it held in memory
    const late = await hung.then(() => undefined, (error: unknown) => error);
    expect(late).toBeInstanceOf(FlowStoreWriteFailedError); // refused at its first save (stale); before the fix it broadcast a second funding
    expect(w.counts().locks).toBe(1);
    expect(await lockFrames(w)).toBe(1);
  });
});
