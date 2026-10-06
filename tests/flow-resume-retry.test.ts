// SPDX-License-Identifier: MIT
//
// tests/flow-resume-retry.test.ts - review round 1, R1-03 (flows part): a REFUSED store save is a crash of the in-memory flow.
//
// Before the fix the journal documented "the next call goes through the step's recover path" for a failed save, so a runner that
// retried in the same process acted on latches the store never saw: on Bitcoin the retry broadcast a funding whose handle was never
// saved, and after the restart a second funding went out. Now the journal keeps the last durable record, marks itself failed, and
// every public step of the flow throws `FlowStoreWriteFailedError` until the runner builds a fresh flow with `resume()`:
//
//   case A  a refused prepared-lock save: the retry refuses and sends nothing; the restart sends exactly one funding
//   case B  a refused lock-frame intent save: the retry posts nothing; the restart posts the one frame, with a room read
//   table   every public step of a Buyer whose save was refused refuses, and does nothing outward
//
// (The Seller's steps are the Seller fixer's; the journal-level behaviour is in tests/flow-journal.test.ts.)

import { dealRoom, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { decodeFlowRecord, type BuyerFlowRecord } from "../src/client/flow-record.js";
import { FlowStoreFaultError, FlowStoreWriteFailedError, flowKey } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, readSwap, type Ctx, type World, type WorldFactory } from "./helpers/crash-matrix.js";
import { evmWorld, ledgerWorldWith } from "./helpers/matrix-worlds.js";
import type { LedgerChain } from "./helpers/ledger-rail.js";

interface Setup {
  ctl: Controller;
  w: World;
  c: Ctx;
}

/** A world with both flows built and every step before the Buyer's lock done. */
async function prefixed(factory: WorldFactory): Promise<Setup> {
  const ctl = new Controller();
  const w = factory(ctl);
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of PREFIX) await step.run(c);
  return { ctl, w, c };
}

async function buyerRecordOf(w: World): Promise<BuyerFlowRecord> {
  const key = flowKey("buyer", w.swapId);
  return decodeFlowRecord((await w.stores.buyer.load(key))!, key) as BuyerFlowRecord;
}

async function restartBuyer(s: Setup): Promise<{ flow: BuyerFlow; next: string }> {
  s.ctl.restart("buyer");
  const resumed = await BuyerFlow.resume({ ...s.w.buyerOptions(), store: s.w.stores.buyer, swapId: s.w.swapId });
  s.c.buyer = resumed.flow;
  return resumed;
}

const lockFrames = async (w: World): Promise<number> => {
  const contractA = (await readSwap(w)).acceptA!.contract;
  return (await w.venue.read(dealRoom(contractA))).filter((record) => tryDecodeFrame(record.line)?.type === "lock").length;
};

describe("R1-03 case A (Bitcoin): a refused prepared-lock save, a retry in the same process, then a restart", () => {
  it("the retry refuses and sends nothing; after the restart exactly ONE funding goes out and is announced once", async () => {
    let chain: LedgerChain | undefined;
    const s = await prefixed(ledgerWorldWith("btc", (c) => void (chain = c)));
    const { w } = s;
    w.stores.buyer.failSaveWhen(() => "reject"); // e.g. ENOSPC: every save is refused until an operator frees space

    // call 1: the save of the prepared lock is refused, so nothing is sent (rule 1)
    await expect(s.c.buyer.lockLegA()).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(w.counts().locks).toBe(0);

    // call 2, same process: the in-memory latch (a prepared funding) must NOT be acted on; before the fix this broadcast it
    const retry = await s.c.buyer.lockLegA().catch((error: unknown) => error);
    expect(retry).toBeInstanceOf(FlowStoreWriteFailedError);
    expect(w.counts().locks).toBe(0);
    expect(chain!.counts.rebroadcasts).toBe(0);
    const stored = await buyerRecordOf(w);
    expect(stored.lock.attempted).toBe(false); // the store says what is true: nothing was attempted
    expect(stored.lock.prepared).toBeUndefined();

    // the operator frees the disk, the process restarts and resumes from the store
    w.stores.buyer.clearFaults();
    const resumed = await restartBuyer(s);
    expect(resumed.next).toBe("lockLegA");
    await resumed.flow.lockLegA();
    expect(w.counts().locks).toBe(1); // ONE funding overall, where the unfixed flow sent two
    expect(chain!.outputs.size).toBe(1);
    expect(await lockFrames(w)).toBe(1);
  });
});

describe("R1-03 case B: a refused lock-frame intent save, a retry in the same process, then a restart", () => {
  it("the retry posts nothing; the restart posts the one lock frame (after a room read)", async () => {
    const s = await prefixed(ledgerWorldWith("btc", () => undefined));
    const { w } = s;
    const key = flowKey("buyer", w.swapId);
    let failing = true;
    w.stores.buyer.failSaveWhen((_n, _key, bytes) => {
      if (!failing) return undefined;
      return decodeFlowRecord(bytes, key).ledger.some((entry) => entry.kind === "lock-a") ? "reject" : undefined;
    });
    // funded, the evidence saved, then the save of the lock frame's ledger intent is refused
    await expect(s.c.buyer.lockLegA()).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(w.counts().locks).toBe(1);
    expect(await lockFrames(w)).toBe(0);

    // same process: the frame must not be posted without a durable intent
    await expect(s.c.buyer.lockLegA()).rejects.toBeInstanceOf(FlowStoreWriteFailedError);
    expect(await lockFrames(w)).toBe(0);
    expect((await buyerRecordOf(w)).ledger.some((entry) => entry.kind === "lock-a")).toBe(false);

    failing = false;
    const resumed = await restartBuyer(s);
    expect(resumed.next).toBe("lockLegA"); // the lock is recorded; only its frame is missing
    await resumed.flow.lockLegA();
    expect(await lockFrames(w)).toBe(1);
    expect(w.counts().locks).toBe(1);
  });
});

describe("R1-03: every public step of a Buyer whose save was refused refuses, and does nothing outward", () => {
  it("bid, acceptLegB, verifyLegBLocked, postAccountLineA, lockLegA, reconcileLockA, learnSecret, claimLegB, refundLegA", async () => {
    const s = await prefixed(evmWorld);
    const { w } = s;
    const view = await readSwap(w);
    w.stores.buyer.failSaveWhen(() => "reject");
    await expect(s.c.buyer.lockLegA()).rejects.toBeInstanceOf(FlowStoreFaultError); // the flow is failed now
    const before = w.counts();
    const offersBefore = (await w.venue.read("tclk-offers")).length;
    w.setTime(w.refundAt.legA); // so no step refuses for another reason first

    const steps: Array<[string, () => Promise<unknown>]> = [
      ["bid", () => s.c.buyer.bid(w.bidParams)],
      ["acceptLegB", () => s.c.buyer.acceptLegB(view.offerBRecord!, view.acceptARecord!, w.lockTimeMs)],
      ["verifyLegBLocked", () => s.c.buyer.verifyLegBLocked()],
      ["postAccountLineA", () => s.c.buyer.postAccountLineA(w.addresses.buyer)],
      ["lockLegA", () => s.c.buyer.lockLegA()],
      ["reconcileLockA", () => s.c.buyer.reconcileLockA()],
      ["learnSecret", () => s.c.buyer.learnSecret()],
      ["claimLegB", () => s.c.buyer.claimLegB(w.hashLock.preimage)],
      ["refundLegA", () => s.c.buyer.refundLegA()],
    ];
    for (const [name, run] of steps) {
      const error = await run().then(() => undefined, (e: unknown) => e);
      expect(error, name).toBeInstanceOf(FlowStoreWriteFailedError);
    }
    expect(w.counts()).toEqual(before); // no lock, claim or refund
    expect((await w.venue.read("tclk-offers")).length).toBe(offersBefore);
    expect(await lockFrames(w)).toBe(0);
  });
});
