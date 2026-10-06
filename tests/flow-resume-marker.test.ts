// SPDX-License-Identifier: MIT
//
// tests/flow-resume-marker.test.ts - review round 2, R2-09 at flow level: a projection error must fail the journal.
//
// The journal used to fail only for `FlowRecordInvalidError`. A rail whose `currentBlockMarker` answers something that cannot be persisted
// (1.5, say; none of the four shipped adapters can) made the Seller's projector throw a plain `FlowRecordError` while a latch was already set
// in memory: call 1 of `claimLegA` set `claimAttempted`, its save threw, and the journal stayed usable; call 2 skipped the save (the latch was
// set) and SENT the claim, which landed. After a restart the record said `claimAttempted=false`, the guards read the lock Claimed, and the reveal
// and receipt were never posted. Now any projection, bump or encode error fails the journal: call 2 is refused before it sends anything.
//
// Ported from the secrets and store lens of review round 2 (SEC2-E).

import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import type { ConnectedCounterAssetRail, CounterAssetRail } from "../src/client/counter-rail.js";
import { FlowRecordInvalidError } from "../src/client/flow-record.js";
import { FlowStoreWriteFailedError } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, type Ctx } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { sellerContractA, sellerKeyOf } from "./helpers/seller-key.js";

/** `rail` with the connected rail's `currentBlockMarker` answering `answer()` instead of the real marker. */
function withBlockMarker(rail: CounterAssetRail, answer: () => unknown): CounterAssetRail {
  const bindFunctions = (target: object, property: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };
  return new Proxy(rail, {
    get(target, property) {
      if (property !== "connect") return bindFunctions(target, property);
      return async (...args: Parameters<CounterAssetRail["connect"]>): Promise<ConnectedCounterAssetRail> => {
        const connected = await target.connect(...args);
        return new Proxy(connected, {
          get(inner, name) {
            if (name === "currentBlockMarker") {
              return async () => {
                const forced = answer();
                return forced === undefined ? inner.currentBlockMarker() : forced;
              };
            }
            return bindFunctions(inner, name);
          },
        });
      };
    },
  });
}

describe("R2-09: a rail that cannot give a persistable block marker", () => {
  it("claimLegA call 1 fails and fails the journal; call 2 is FlowStoreWriteFailedError and sends no claim; the restart claims once and posts the frames", async () => {
    const w = evmWorld(new Controller());
    let marker: unknown = undefined; // undefined: the real marker
    const sellerOptions = w.sellerOptions();
    const buyer = new BuyerFlow(w.buyerOptions());
    const seller = new SellerFlow({ ...sellerOptions, rail: withBlockMarker(sellerOptions.rail, () => marker) });
    const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
    for (const step of [...PREFIX, STEPS.lockLegA]) await step.run(c);
    const statement = seller.statement;
    if (statement === undefined) throw new Error("the Seller has no statement");

    marker = 1.5; // from here the rail answers a marker that cannot be saved
    const first = await seller.claimLegA(statement).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(FlowStoreWriteFailedError);
    expect((first as FlowStoreWriteFailedError).cause).toBeInstanceOf(FlowRecordInvalidError);
    expect(w.counts().claims).toBe(0);

    const second = await seller.claimLegA(statement).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(FlowStoreWriteFailedError);
    expect(w.counts().claims).toBe(0); // nothing was sent: the latch the failed save left in memory is not acted on

    // the store still says "not attempted": a restart decides from the chain and the venue
    marker = undefined;
    const contractA = await sellerContractA(w.stores.seller);
    expect(await sellerKeyOf(w.stores.seller)).toBe(`seller:${contractA}`);
    const resumed = await SellerFlow.resume({ ...w.sellerOptions(), store: w.stores.seller, swapId: w.swapId, contractA });
    expect(resumed.next).toBe("claimLegA");
    await resumed.flow.claimLegA(resumed.flow.statement ?? statement);
    expect(w.counts().claims).toBe(1);
    const again = await SellerFlow.resume({ ...w.sellerOptions(), store: w.stores.seller, swapId: w.swapId, contractA });
    expect(again.next).toBe("done"); // the reveal and the receipt were posted
  });
});
