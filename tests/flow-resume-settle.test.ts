// SPDX-License-Identifier: MIT
//
// R2-10 (P8-FIXES-R2.md): claimLegB and refundLegA are mutually exclusive in one process (one shared in-flight flag).
//
// The case: a dishonest Seller posts a reveal frame without ever claiming leg A. After leg A's refund time a runner calls claimLegB and
// refundLegA in the same tick. Before the fix they held different in-flight flags and both ran: claimLegB wrote leg B's note, refundLegA's
// settle read the note as claimed with this swap's secret, ADOPTED it and refunded leg A; when claimLegB's paper call then returned it set
// `legBClaimed` too, and the record (adopted and claimed are mutually exclusive) could no longer be encoded: the journal failed, possibly
// after the leg A refund was already sent. With one shared flag the second call is refused with the in-flight error and the first runs
// alone.

import { PaperRail } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { PREFIX, STEPS } from "./helpers/crash-matrix.js";
import { evmWorld, ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { buyerRecordOf, postRevealFrame, resumedBuyer, started, type Started } from "./helpers/resume-world.js";

/** A paper rail whose claim LANDS and then waits a moment before it returns, so a call that runs meanwhile reads the note claimed. */
function slowClaim(real: PaperRail, ms: number): PaperRail {
  return Object.create(real, {
    claim: {
      value: async (ref: string, secret: string) => {
        await real.claim(ref, secret);
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
  }) as PaperRail;
}

async function rigged(factory: Parameters<typeof started>[0]): Promise<{ s: Started; secret: string }> {
  const s = await started(factory, [...PREFIX, STEPS.lockLegA]);
  await postRevealFrame(s.w, (await buyerRecordOf(s.w)).lock.evidence!.ref); // the Seller reveals and never claims leg A
  await resumedBuyer(s, (o) => ({ paperRail: slowClaim(o.paperRail, 60) }));
  s.w.setTime(s.w.refundAt.legA);
  return { s, secret: await s.c.buyer.learnSecret() };
}

for (const [name, factory] of [
  ["evm", evmWorld],
  ["btc ledger world", ledgerWorldWith("btc", () => undefined)],
] as const) {
  describe(`R2-10 (${name}): claimLegB and refundLegA share one in-flight flag`, () => {
    it("claimLegB first, refundLegA in the same tick: the refund is refused as in flight, the claim completes, the record never holds both flags, the journal stays usable", async () => {
      const { s, secret } = await rigged(factory);
      const claim = s.c.buyer.claimLegB(secret);
      const refund = s.c.buyer.refundLegA();
      await expect(refund).rejects.toThrow(/already in flight/);
      await claim;
      const record = await buyerRecordOf(s.w);
      expect(record.legBClaimed).toBe(true);
      expect(record.legBClaimAdopted).toBeUndefined();
      expect(s.w.counts().refunds, "no refund of leg A was sent next to the claim of leg B").toBe(0);
      // the journal is usable: a repeat of the step is the recorded result, and the refund is refused for the claim, not for a dead journal
      await s.c.buyer.claimLegB(secret);
      await expect(s.c.buyer.refundLegA()).rejects.toThrow(/already claimed leg B/);
    });

    it("refundLegA first, claimLegB in the same tick: the claim is refused as in flight, the refund completes, the record never holds both flags, the journal stays usable", async () => {
      const { s, secret } = await rigged(factory);
      const refund = s.c.buyer.refundLegA();
      const claim = s.c.buyer.claimLegB(secret);
      await expect(claim).rejects.toThrow(/already in flight/);
      await refund;
      const record = await buyerRecordOf(s.w);
      expect(record.legBClaimed && record.legBClaimAdopted === true).toBe(false);
      expect(s.w.counts().refunds).toBe(1);
      await expect(s.c.buyer.refundLegA()).resolves.toBeDefined(); // a repeat of the finished refund is the ordinary confirmed repeat
    });

    it("a call made after the first one finished is not refused (the flag is cleared when the call ends, however it ends)", async () => {
      const { s, secret } = await rigged(factory);
      await s.c.buyer.claimLegB(secret);
      await expect(s.c.buyer.refundLegA()).rejects.toThrow(/already claimed leg B/); // refused for the claim, not as in flight
      await s.c.buyer.claimLegB(secret); // and the claim can be repeated
    });
  });
}
