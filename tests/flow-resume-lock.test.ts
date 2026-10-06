// SPDX-License-Identifier: MIT
//
// tests/flow-resume-lock.test.ts - review round 2, R2-01 at flow level: a lock file that names the runner's OWN pid.
//
// The Buyer locked leg A, the Seller claimed it and revealed, and the Buyer's process was killed inside a save's few file operations (a
// watchdog kill of a save hung in fsync, an OOM kill, a power cut). It restarts under the same pid, which is the norm for node as pid 1
// in a container. Before the fix every save of the Buyer's record then waited and failed with an error saying another instance owned the
// swap, so `claimLegB` could not even record its attempt and, at leg B's refund time, the Seller took leg B back: the Buyer paid and got
// nothing. Now a lock naming our own pid that this process does not hold is a predecessor's leftover and is broken.
//
// Ported from the idempotency lens of review round 2 (IDEM2-1), with its dead-pid control kept.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { FileFlowStore } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, readSwap, type Ctx, type World } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rsm-lock-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The Buyer locked leg A (its record lives in a FileFlowStore under `dir`) and the Seller claimed leg A and revealed. */
async function claimedByTheSeller(dir: string): Promise<{ w: World; c: Ctx }> {
  const w = evmWorld(new Controller());
  const buyer = new BuyerFlow({ ...w.buyerOptions(), store: new FileFlowStore(dir, { lockWaitMs: 150 }) });
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of [...PREFIX, STEPS.lockLegA, STEPS.claimLegA]) await step.run(c);
  return { w, c };
}

const lockOf = (w: World): string => `buyer-${w.swapId}.lock`;

describe("R2-01: the resumed Buyer after a kill inside a save, restarted under the same pid", () => {
  it("claimLegB goes through: leg B's note reads claimed, no lock file is left, and the next resume says done", async () => {
    const dir = join(root, "flows");
    mkdirSync(dir);
    const { w } = await claimedByTheSeller(dir);
    // the killed process's lock, naming the pid the restarted process has too
    writeFileSync(join(dir, lockOf(w)), `${process.pid}\nfedcba9876543210\n`);

    const resumed = await BuyerFlow.resume({ ...w.buyerOptions(), store: new FileFlowStore(dir, { lockWaitMs: 150 }), swapId: w.swapId });
    expect(resumed.next).toBe("learnSecret");
    const secret = await resumed.flow.learnSecret();
    expect(secret).toBe(w.hashLock.preimage);
    await resumed.flow.claimLegB(secret); // its first save is the one the leftover lock used to refuse

    const view = await readSwap(w);
    expect((await w.paper.read(view.acceptB!.contract))?.status).toBe("claimed");
    expect(readdirSync(dir)).toEqual([`buyer-${w.swapId}.json`]);
    const again = await BuyerFlow.resume({ ...w.buyerOptions(), store: new FileFlowStore(dir, { lockWaitMs: 150 }), swapId: w.swapId });
    expect(again.next).toBe("done");
  });

  it("control: the same lock file naming a dead pid is broken too and claimLegB goes through", async () => {
    const dir = join(root, "flows");
    mkdirSync(dir);
    const { w } = await claimedByTheSeller(dir);
    writeFileSync(join(dir, lockOf(w)), "4194300\nfedcba9876543210\n"); // no process has this pid

    const resumed = await BuyerFlow.resume({ ...w.buyerOptions(), store: new FileFlowStore(dir, { lockWaitMs: 150 }), swapId: w.swapId });
    await resumed.flow.claimLegB(await resumed.flow.learnSecret());
    const view = await readSwap(w);
    expect((await w.paper.read(view.acceptB!.contract))?.status).toBe("claimed");
    expect(readdirSync(dir)).toEqual([`buyer-${w.swapId}.json`]);
  });
});
