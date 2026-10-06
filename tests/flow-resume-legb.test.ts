// SPDX-License-Identifier: MIT
//
// tests/flow-resume-legb.test.ts - review round 1, the Buyer's leg B claim and what it does to the refund of leg A:
//
//   R1-06  leg B's paper note is not bound to who wrote it: the Seller (who always holds the secret), or anyone holding a leaked one, can
//          write it `claimed` at no cost and post a reveal frame without ever claiming leg A. A claim found on the note is ADOPTED (its
//          frames are posted, the note is recorded once) and never bars the refund of leg A; only a claim THIS flow made does, and `next`
//          never says done for an adopted claim while leg A has not been seen claimed. (Ports F2 on EVM and F2-btc on Bitcoin.)
//   R1-07  `legBClaimAttempted` is cleared when leg B's note proves the attempt did not land (refunded, missing, or leg B's refund time
//          has come); a claim that is still possible keeps the refund refused. (Ports F3, same process and after a resume, plus the
//          crash between the saved latch and the note write.)
//
// The flows are the real ones, with a store, over the EVM mock node and the Bitcoin ledger fake of the crash matrix.

import { PaperRail, dealRoom, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { LEDGER_BTC_ADDRESS, type LedgerChain } from "./helpers/ledger-rail.js";
import { evmWorld, ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { ProcessDied } from "./helpers/resume-flows.js";
import { buyerRecordOf, contractsOf, postRevealFrame, resumedBuyer, started, strangerPaper, type Started } from "./helpers/resume-world.js";

/** A paper rail whose claim LANDS and then the process dies (the reply is lost, and the process never reads the note back) / whose claim
 *  dies BEFORE the note write. */
function dyingClaim(real: PaperRail, when: "after" | "before"): PaperRail {
  return Object.create(real, {
    claim: {
      value: async (ref: string, secret: string) => {
        if (when === "before") throw new ProcessDied("before the leg B note write");
        await real.claim(ref, secret);
        throw new ProcessDied("after the leg B note write");
      },
    },
    ...(when === "after"
      ? {
          read: {
            value: async () => {
              throw new ProcessDied("before reading the leg B note back");
            },
          },
        }
      : {}),
  }) as PaperRail;
}

const lockedRef = async (s: Started): Promise<string> => (await buyerRecordOf(s.w)).lock.evidence!.ref;

/** The Seller writes leg B's note `claimed` and posts a reveal frame, and never claims leg A. */
async function sellerWritesNoteAndReveal(s: Started): Promise<void> {
  const { contractB } = await contractsOf(s.w);
  await strangerPaper(s.w).claim(contractB, s.w.hashLock.preimage);
  await postRevealFrame(s.w, await lockedRef(s));
}

describe("R1-06 (EVM, F2): a leg B note the Seller wrote claimed never freezes the Buyer's refund of leg A", () => {
  it("the claim is adopted (frames posted, note recorded once), next is not done, and at leg A's refund time refundLegA refunds", async () => {
    const s = await started(evmWorld);
    await sellerWritesNoteAndReveal(s);
    const secret = await s.c.buyer.learnSecret();
    await s.c.buyer.claimLegB(secret); // paperRail.claim throws "claim on a claimed record"; the note carries this swap's secret

    const adopted = await buyerRecordOf(s.w);
    expect(adopted.legBClaimed, "this flow did not make the claim").toBe(false);
    expect(adopted.legBClaimAdopted).toBe(true);
    expect(adopted.refundNotes).toHaveLength(1);
    expect(adopted.refund.claimSeen, "leg A was not seen claimed: the Seller never claimed it").toBeUndefined();
    const roomB = await s.w.venue.read(dealRoom((await contractsOf(s.w)).contractB));
    expect(roomB.filter((r) => ["reveal", "receipt"].includes(tryDecodeFrame(r.line)?.type ?? "")), "the reveal and receipt frames of leg B were posted").toHaveLength(2);

    await s.c.buyer.claimLegB(secret); // a repeat is the recorded result and adds no second note
    expect((await buyerRecordOf(s.w)).refundNotes).toHaveLength(1);

    const again = await resumedBuyer(s);
    expect(again.next, "an adopted claim with leg A not seen claimed is never done").toBe("learnSecret");

    s.w.setTime(s.w.refundAt.legA);
    await again.flow.refundLegA(); // before the fix: "this flow already claimed leg B", for ever, while leg A stayed locked
    expect(s.w.counts()).toMatchObject({ locks: 1, claims: 0, refunds: 1 });
    expect((await resumedBuyer(s)).next).toBe("done");
  });

  it("a claim THIS flow made (paperRail.claim returned) still bars the refund, in this process and after a restart", async () => {
    const s = await started(evmWorld);
    await postRevealFrame(s.w, await lockedRef(s)); // the secret is public; the Seller wrote no note
    await s.c.buyer.claimLegB(await s.c.buyer.learnSecret());
    expect((await buyerRecordOf(s.w)).legBClaimed).toBe(true);
    expect((await buyerRecordOf(s.w)).legBClaimAdopted).toBeUndefined();
    s.w.setTime(s.w.refundAt.legA);
    await expect(s.c.buyer.refundLegA()).rejects.toThrow(/already claimed leg B/);
    await expect((await resumedBuyer(s)).flow.refundLegA()).rejects.toThrow(/already claimed leg B/);
    expect(s.w.counts().refunds).toBe(0);
  });

  it("the Buyer's own claim landed and its reply was lost, and the Seller claimed leg A: the restart adopts it, and next says done once leg A is seen claimed", async () => {
    const s = await started(evmWorld);
    await s.c.seller.claimLegA(s.c.seller.statement!); // the honest Seller claims leg A on chain and reveals
    const secret = await s.c.buyer.learnSecret();
    await resumedBuyer(s, (o) => ({ paperRail: dyingClaim(o.paperRail, "after") }));
    await expect(s.c.buyer.claimLegB(secret)).rejects.toBeInstanceOf(ProcessDied);
    const saved = await buyerRecordOf(s.w);
    expect(saved.legBClaimAttempted).toBe(true);
    expect(saved.legBClaimed).toBe(false);

    const back = await resumedBuyer(s);
    expect(back.next).toBe("learnSecret");
    await back.flow.claimLegB(secret);
    const done = await buyerRecordOf(s.w);
    expect(done.legBClaimAdopted).toBe(true);
    expect(done.refund.claimSeen, "leg A read claimed, so nothing is left to refund").toBe(true);
    expect((await resumedBuyer(s)).next, "before the leg A read it stayed learnSecret for ever, a livelock for a runner driven by next").toBe("done");
  });
});

describe("R1-06 (Bitcoin, F2-btc): the Seller cannot keep an unlimited option on leg A by writing leg B's note", () => {
  it("the adopted claim does not bar the refund: refundLegA refunds, and the Seller's late claim of leg A fails", async () => {
    let chain: LedgerChain | undefined;
    const s = await started(ledgerWorldWith("btc", (c) => void (chain = c)));
    await sellerWritesNoteAndReveal(s);
    await s.c.buyer.claimLegB(await s.c.buyer.learnSecret());
    expect((await buyerRecordOf(s.w)).legBClaimAdopted).toBe(true);
    expect((await resumedBuyer(s)).next).toBe("learnSecret");

    s.w.setTime(s.w.refundAt.legA + 60_000);
    await s.c.buyer.refundLegA();
    expect(s.w.counts()).toMatchObject({ locks: 1, claims: 0, refunds: 1 });

    // much later the Seller tries to claim leg A (Bitcoin has no on-chain claim deadline): the output is already refunded
    s.w.setTime(s.w.refundAt.legA + 6 * 60 * 60_000);
    const sellerRail = await s.w.sellerOptions().rail.connect({} as never, { payer: LEDGER_BTC_ADDRESS.buyer, payee: LEDGER_BTC_ADDRESS.seller });
    await expect(sellerRail.claim([...chain!.outputs.keys()][0]!, s.w.hashLock.preimage, Number.MAX_SAFE_INTEGER)).rejects.toThrow(/the output is refunded/);
    expect((await resumedBuyer(s)).next).toBe("done");
  });
});

describe("R1-07 (EVM, F3): a leg B claim attempt that provably did not land never freezes the refund", () => {
  it("claimLegB fails past leg B's refund time: the latch is cleared and refundLegA refunds, in this process", async () => {
    const s = await started(evmWorld);
    await postRevealFrame(s.w, await lockedRef(s)); // a reveal frame without a chain claim
    s.w.setTime(s.w.refundAt.legB);
    const secret = await s.c.buyer.learnSecret();
    await expect(s.c.buyer.claimLegB(secret)).rejects.toThrow(/claim after refundAfterMs/);
    expect((await buyerRecordOf(s.w)).legBClaimAttempted, "the note is still locked but past its refund time: the attempt did not land").toBe(false);
    await s.c.buyer.refundLegA(); // before the fix: "a claim of leg B was attempted and its outcome is not recorded", for ever
    expect(s.w.counts().refunds).toBe(1);
  });

  it("the same after a resume", async () => {
    const s = await started(evmWorld);
    await postRevealFrame(s.w, await lockedRef(s));
    s.w.setTime(s.w.refundAt.legB);
    await expect(s.c.buyer.claimLegB(await s.c.buyer.learnSecret())).rejects.toThrow(/claim after refundAfterMs/);
    const back = await resumedBuyer(s);
    await back.flow.refundLegA();
    expect(s.w.counts().refunds).toBe(1);
    expect((await resumedBuyer(s)).next).toBe("done");
  });

  it("the crash variant: the process dies after the latch was saved and before the note write; resumed at leg B's refund time, refundLegA refunds", async () => {
    const s = await started(evmWorld);
    await postRevealFrame(s.w, await lockedRef(s));
    const secret = await s.c.buyer.learnSecret();
    await resumedBuyer(s, (o) => ({ paperRail: dyingClaim(o.paperRail, "before") }));
    await expect(s.c.buyer.claimLegB(secret)).rejects.toBeInstanceOf(ProcessDied);
    expect((await buyerRecordOf(s.w)).legBClaimAttempted).toBe(true); // saved before the note write, as rule 1 says

    s.w.setTime(s.w.refundAt.legB);
    const back = await resumedBuyer(s);
    await back.flow.refundLegA(); // the note reads locked but leg B's refund time has come: the attempt cannot have landed
    expect(s.w.counts().refunds).toBe(1);
    expect((await buyerRecordOf(s.w)).legBClaimAttempted).toBe(false);
  });

  it("a claim that is still possible keeps the refund refused (the attempt may yet land), and the claim then settles it", async () => {
    const s = await started(evmWorld);
    await postRevealFrame(s.w, await lockedRef(s));
    const secret = await s.c.buyer.learnSecret();
    await resumedBuyer(s, (o) => ({ paperRail: dyingClaim(o.paperRail, "before") }));
    await expect(s.c.buyer.claimLegB(secret)).rejects.toBeInstanceOf(ProcessDied);

    s.w.setTime(s.w.refundAt.legA); // leg A's refund time, but leg B's note is locked and its refund time is far away
    const back = await resumedBuyer(s);
    await expect(back.flow.refundLegA()).rejects.toThrow(/a claim of leg B was attempted and its outcome is not recorded/);
    expect(s.w.counts().refunds).toBe(0);
    expect((await buyerRecordOf(s.w)).legBClaimAttempted).toBe(true);

    await back.flow.claimLegB(secret); // the claim goes through now, as this flow's own
    expect((await buyerRecordOf(s.w)).legBClaimed).toBe(true);
    await expect(back.flow.refundLegA()).rejects.toThrow(/already claimed leg B/);
  });
});
