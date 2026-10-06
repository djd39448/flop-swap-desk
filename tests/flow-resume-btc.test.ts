// SPDX-License-Identifier: MIT
//
// tests/flow-resume-btc.test.ts - review round 1, R1-01 on Bitcoin (the stateful ledger fake, `btc` flavour): the chain is READ before
// any guard, and the identical saved funding is RE-SENT only after the guards.
//
// Bitcoin never proves a funding dead (a signed transaction stays valid while its inputs are unspent), so a funding the node does not
// know is `unknown`: the flow may send the identical saved bytes once more, which is a NEW outward action and therefore runs every
// rule-4 guard first (the deadline arithmetic among them). A funding the node knows is simply recognised, whatever the clock says.

import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { RailRecoveryRefusedError } from "../src/client/counter-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, runScript, type Ctx, type Mode, type World } from "./helpers/crash-matrix.js";
import { ledgerWorldWith } from "./helpers/matrix-worlds.js";
import type { LedgerChain } from "./helpers/ledger-rail.js";

/** The number of the outward action `what` in a reference run of `steps` (the cut points are numbered in order). */
async function actionNumber(steps: Parameters<typeof runScript>[1], what: string): Promise<number> {
  const reference = await runScript(ledgerWorldWith("btc", () => undefined), steps, []);
  const action = reference.world.ctl.actions.find((candidate) => candidate.what === what);
  if (action === undefined) throw new Error(`no outward action ${what} in the reference run`);
  return action.n;
}

interface Crashed {
  ctl: Controller;
  w: World;
  c: Ctx;
  chain: LedgerChain;
}

/** A swap up to the Buyer's lock, whose process is cut at the funding send (`mode`), and a dead Buyer. */
async function crashedAtFunding(mode: Mode): Promise<Crashed> {
  const n = await actionNumber([...PREFIX, STEPS.lockLegA], "chain:lock.send");
  let chain: LedgerChain | undefined;
  const ctl = new Controller([{ n, mode }]);
  const w = ledgerWorldWith("btc", (c) => void (chain = c))(ctl);
  ctl.attachStore(w.stores.buyer, "buyer");
  ctl.attachStore(w.stores.seller, "seller");
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of PREFIX) await step.run(c);
  await buyer.lockLegA().catch(() => undefined);
  expect(ctl.isDead("buyer")).toBe(true);
  return { ctl, w, c, chain: chain! };
}

async function restartBuyer(s: Crashed): Promise<{ flow: BuyerFlow; next: string }> {
  s.ctl.restart("buyer");
  const resumed = await BuyerFlow.resume({ ...s.w.buyerOptions(), store: s.w.stores.buyer, swapId: s.w.swapId });
  s.c.buyer = resumed.flow;
  return resumed;
}

describe("R1-01 on Bitcoin: a funding the node does not know is re-sent only after the guards", () => {
  it("the funding was saved and never sent: inside the guard window the identical bytes are sent once; outside it nothing is sent and the call refuses", async () => {
    const s = await crashedAtFunding("before");
    expect(s.chain.counts.fundSent).toBe(0);
    expect(s.chain.counts.fundBuilt).toBe(1);

    // the clock has moved on: the reveal window is shorter than rule 1 asks for. The node does not know the funding, so
    // re-sending it would be a NEW lock action, and the guards stop it.
    const inWindow = s.w.clockRef.ms;
    s.w.setTime(s.w.refundAt.legA - 1);
    let resumed = await restartBuyer(s);
    expect(resumed.next).toBe("lockLegA");
    await expect(resumed.flow.lockLegA()).rejects.toThrow(/deadlines are no longer safe at lock time/);
    expect(s.chain.counts.rebroadcasts).toBe(0); // before the fix recoverLock re-broadcast inside the read, past the window
    expect(s.chain.counts.fundSent).toBe(0);
    expect(s.chain.counts.fundBuilt).toBe(1); // and no second funding was built

    // back inside the window the very same record recovers: the identical bytes go out, once
    s.w.setTime(inWindow);
    resumed = await restartBuyer(s);
    await resumed.flow.lockLegA();
    expect(s.chain.counts.rebroadcasts).toBe(1);
    expect(s.chain.counts.fundSent).toBe(1);
    expect(s.chain.counts.fundBuilt).toBe(1);
  });

  it("the funding LANDED and its record was lost: it is recognised past the guard window, nothing is sent again, and the Buyer is routed on", async () => {
    const s = await crashedAtFunding("after-store-fail");
    expect(s.chain.counts.fundSent).toBe(1); // on the chain; the record of it was refused
    s.w.setTime(s.w.refundAt.legA - 1); // outside the guard window, before leg A's refund time
    const resumed = await restartBuyer(s);
    expect(resumed.next).toBe("lockLegA");
    await resumed.flow.lockLegA(); // a lock that landed is recognised whatever the clock says
    expect(s.chain.counts.rebroadcasts).toBe(0);
    expect(s.chain.counts.fundSent).toBe(1);
    expect((await restartBuyer(s)).next).toBe("learnSecret");
  });

  it("past leg A's refund time an unrecognised lock is routed to refundLegA, which refunds the funding that landed", async () => {
    const s = await crashedAtFunding("after-store-fail");
    s.w.setTime(s.w.refundAt.legA);
    const resumed = await restartBuyer(s);
    expect(resumed.next).toBe("refundLegA"); // F1b: not lockLegA for ever
    await resumed.flow.lockLegA(); // recognised and announced
    await resumed.flow.refundLegA();
    expect(s.w.counts().refunds).toBe(1);
    expect(s.chain.counts.fundSent).toBe(1);
    expect((await restartBuyer(s)).next).toBe("done");
  });

  it("a node that refuses the saved funding is a typed error for a person, after the guards; no second funding is built", async () => {
    const s = await crashedAtFunding("before");
    s.chain.refuseRebroadcast = true; // its inputs are gone
    const resumed = await restartBuyer(s);
    const error = await resumed.flow.lockLegA().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("rebroadcast-refused");
    expect(s.chain.counts.fundBuilt).toBe(1);
    expect(s.chain.counts.fundSent).toBe(0);
  });
});
