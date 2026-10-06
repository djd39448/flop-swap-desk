// SPDX-License-Identifier: MIT
//
// R2-03 (P8-FIXES-R2.md, decision 3): the Seller's mirror of the Buyer's routed refund. When `refundLegB` is called and the paper rail
// refuses because leg B's note was CLAIMED (the Buyer took leg B with this swap's secret), the refund latch used to stay set: `next` said
// refundLegB for ever and the error named nothing. On NEAR that stalls a next-driven Seller's payout: the Seller's claim of leg A had
// revealed the secret but its payout failed (the lock went back to Locked), the Buyer read the reveal and claimed leg B, and a revealed
// lock's claim retry works past the deadlines, so `claimLegA` still pays the Seller, but nothing ever said so.
//
// Now `refundLegB` that finds leg B's note claimed with this swap's secret clears `legBRefund.attempted`, saves `legBClaimSeen`, and throws
// an error that names `claimLegA`; `next` says `claimLegA` (or `done` once the receipt of leg A is posted). Ported from the fund-safety
// lens of review round 2 (FS2-2).

import { PaperRail, dealRoom, encodePaperRecord, paperNote, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { decodeFlowRecord, encodeFlowRecord, type FlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import type { MemoryFlowStore } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { NearPayoutFailedError } from "../src/rails/near-htlc.js";
import { STEPS, readSwap } from "./helpers/crash-matrix.js";
import { evmWorld, ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { legB, nearSwap, T0 } from "./helpers/near-swap-rig.js";
import { SELLER_ACCOUNT } from "./helpers/near-stateful-rpc.js";
import { resumedSeller, sellerRecordOf, started } from "./helpers/resume-world.js";
import { plant, sellerContractA, sellerKeyOf } from "./helpers/seller-key.js";

/** The Seller's stored record, decoded. */
async function storedSeller(store: MemoryFlowStore): Promise<SellerFlowRecord> {
  const key = await sellerKeyOf(store);
  return decodeFlowRecord((await store.load(key))!, key) as SellerFlowRecord;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

describe("R2-03: a refund of leg B that leg B's claim refused routes the Seller to claimLegA (NEAR, the payout stalled)", () => {
  it("payout failed, the Buyer claimed leg B, refundLegB at leg B's refund time names claimLegA; next says claimLegA, then claimLegA pays and next says done", async () => {
    const r = await nearSwap();
    // the Seller's payout fails (its token storage is gone): the secret is public on chain, the lock goes back to Locked
    r.node.armPayoutFailureAfterReads(SELLER_ACCOUNT, 2);
    const claimError = await r.seller.claimLegA(r.statement).catch((e: unknown) => e);
    expect(claimError).toBeInstanceOf(NearPayoutFailedError);
    expect(r.node.getLockRow(r.statement.slice(2))?.status).toBe("Locked");

    // the Buyer reads the reveal and claims leg B
    const secret = await r.buyer.learnSecret();
    await r.buyer.claimLegB(secret);

    // leg B's refund time: the Seller restarts. next says claimLegA (nothing is recorded as paid) and the runner may call refundLegB anyway
    r.setTime(legB.refundAfterMs);
    const contractA = await sellerContractA(r.sellerStore);
    const resume = () => SellerFlow.resume({ ...r.sellerOptions, store: r.sellerStore, swapId: r.swapId, contractA });
    const first = await resume();
    expect(first.next).toBe("claimLegA");
    const refundError = await first.flow.refundLegB().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refundError, "the paper rail refused: leg B was claimed").toBeInstanceOf(Error);
    expect(messageOf(refundError)).toMatch(/claimLegA\(\)/);

    // the fact is saved and the refund latch is cleared: next says claimLegA, not refundLegB for ever
    const record = await storedSeller(r.sellerStore);
    expect(record.legBClaimSeen).toBe(true);
    expect(record.legBRefund).toEqual({ attempted: false, done: false, framesPosted: false });
    const second = await resume();
    expect(second.next).toBe("claimLegA");

    // a repeat of the call routes the same way and saves nothing again
    const revision = record.revision;
    const again = await second.flow.refundLegB().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(messageOf(again)).toMatch(/claimLegA\(\)/);
    expect((await storedSeller(r.sellerStore)).revision).toBe(revision);

    // as next says: the payee's storage is registered again and claimLegA, a revealed retry past every deadline, pays the Seller
    r.node.registerStorage(SELLER_ACCOUNT);
    const paid = await second.flow.claimLegA(r.statement);
    expect(paid.receipt).toBeDefined();
    expect(r.node.getLockRow(r.statement.slice(2))?.status).toBe("Claimed");
    const done = await resume();
    expect(done.next).toBe("done");
    // the frames of leg A, each once: the reveal the failed payout posted, and the receipt the paid retry posted
    const room = await r.venue.read(dealRoom(contractA));
    expect(room.filter((record) => tryDecodeFrame(record.line)?.type === "reveal")).toHaveLength(1);
    expect(room.filter((record) => tryDecodeFrame(record.line)?.type === "receipt")).toHaveLength(1);
    // the swap never refunded leg B: the note is the Buyer's claim
    const noteB = await new PaperRail(r.noteStore, () => T0).read((await storedSeller(r.sellerStore)).lockedLegBContract ?? "");
    expect(noteB?.status).toBe("claimed");
  });
});

describe("R2-03: the same route when leg A is already paid (the receipt is posted): next says done", () => {
  for (const [name, factory] of [
    ["evm", evmWorld],
    ["btc ledger", ledgerWorldWith("btc", () => undefined)],
  ] as const) {
    it(`${name}: the Seller claimed and revealed, the Buyer claimed leg B, a refundLegB at leg B's refund time is refused naming claimLegA and next is done`, async () => {
      const s = await started(factory);
      await STEPS.claimLegA.run(s.c);
      await STEPS.learnAndClaimB.run(s.c);
      s.w.setTime(s.w.refundAt.legB);
      const error = await STEPS.refundLegB.run(s.c).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(messageOf(error)).toMatch(/claimLegA\(\)/);
      const record = await sellerRecordOf(s.w);
      expect(record.legBClaimSeen).toBe(true);
      expect(record.legBRefund.attempted).toBe(false);
      expect((await resumedSeller(s)).next).toBe("done");
      expect(s.w.counts().claims, "no second claim of leg A").toBe(1);
      expect(await s.w.paper.read((await readSwap(s.w)).acceptB!.contract)).toMatchObject({ status: "claimed" });
    });
  }
});

describe("R2-03: next reads the claim-seen fact before the refund latch", () => {
  it("a record that holds BOTH legBClaimSeen and legBRefund.attempted (the decoder allows it) still says claimLegA, then done once the receipt is posted", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.sellerLine, STEPS.lockLegB, STEPS.verify, STEPS.buyerLine, STEPS.lockLegA]);
    const key = await sellerKeyOf(s.w.stores.seller);
    const edit = async (change: (record: Record<string, unknown>) => void): Promise<void> => {
      const plain = JSON.parse(JSON.stringify(decodeFlowRecord((await s.w.stores.seller.load(key))!, key))) as Record<string, unknown>;
      change(plain);
      await plant(s.w.stores.seller, key, encodeFlowRecord(plain as unknown as FlowRecord));
    };
    await edit((record) => {
      record.legBClaimSeen = true;
      (record.legBRefund as Record<string, unknown>).attempted = true;
    });
    expect((await resumedSeller(s)).next, "the claim-seen fact outranks the refund latch").toBe("claimLegA");
    await STEPS.claimLegA.run(s.c);
    expect((await resumedSeller(s)).next).toBe("done");
  });
});

describe("R2-03: a refusal that is not leg B's claim keeps the refund latch (controls)", () => {
  it("the paper rail fails for another reason while the note is still locked: the error is the original one, the latch stays, next stays refundLegB, and a later refund works", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.sellerLine, STEPS.lockLegB]);
    s.w.setTime(s.w.refundAt.legB); // the Buyer never locked leg A: the Seller refunds leg B
    let failing = true;
    const flaky = await resumedSeller(s, (o) => ({
      paperRail: new Proxy(o.paperRail, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property === "refund" && failing) {
            return async () => {
              throw new Error("the note service is down (test)");
            };
          }
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    }));
    const error = await flaky.flow.refundLegB().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(messageOf(error)).toBe("the note service is down (test)");
    const record = await sellerRecordOf(s.w);
    expect(record.legBClaimSeen).toBeUndefined();
    expect(record.legBRefund.attempted).toBe(true);
    expect((await resumedSeller(s)).next).toBe("refundLegB");
    failing = false;
    await s.c.seller.refundLegB();
    expect((await resumedSeller(s)).next).toBe("done");
  });

  it("a claimed note whose secret does NOT open this swap's statement (a world-writable record, forged) is not leg B's claim: the original refusal, the latch stays", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.sellerLine, STEPS.lockLegB]);
    const contractB = (await readSwap(s.w)).acceptB!.contract;
    const real = await s.w.paper.read(contractB);
    expect(real?.status).toBe("locked");
    const { ns, key } = paperNote(contractB);
    const forged = encodePaperRecord({ status: "claimed", lock: "hash", statement: real!.statement, refundAfterMs: real!.refundAfterMs, secret: `0x${"11".repeat(32)}` });
    await s.w.noteStore.set(ns, key, forged);
    s.w.setTime(s.w.refundAt.legB);
    const error = await s.c.seller.refundLegB().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(messageOf(error)).toMatch(/refund on a claimed record/);
    const record = await sellerRecordOf(s.w);
    expect(record.legBClaimSeen).toBeUndefined();
    expect(record.legBRefund.attempted).toBe(true);
    expect((await resumedSeller(s)).next).toBe("refundLegB");
  });
});
