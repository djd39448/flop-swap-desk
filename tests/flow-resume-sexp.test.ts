// SPDX-License-Identifier: MIT
//
// R2-06 (P8-FIXES-R2.md, decision 6), the Seller's half: offer A's expiry. tclk's machine rejects an accept at or after the offer's
// `expiresMs` ("offer has expired"). A resumed Seller that comes back after the expiry used to re-post its saved accept A anyway (rule 3
// allows only identical bytes, rule 4 says a re-send is a NEW outward action that must pass the deadline guards): the Buyer paired, both
// locked and the Seller claimed real value on a swap the venue never accepted, and every machine-based guard quietly stopped firing.
//
// Now acceptLegA refuses to post (or re-post) an accept A that has not landed once the flow's clock is within SELLER_OFFER_EXPIRY_MARGIN_MS of
// offer A's `expiresMs`: SwapExpiredError, nothing posted, nothing minted, nothing saved. An accept A that DID land (its reply lost, its mark
// never saved) is still adopted: the guard is for posting only. `next` says "abandoned" for an accept A that is not recorded as landed once
// the offer has expired: nothing is at stake (no lock on either leg, the statement never public).
//
// Ported from the idempotency lens of review round 2 (IDEM2-6). The EVM world: offer A expires at T0 + 30 min.

import { OFFER_ROOM, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { FlowRecordExistsError, SwapExpiredError } from "../src/client/flow-resume.js";
import { SELLER_OFFER_EXPIRY_MARGIN_MS, SellerFlow } from "../src/client/seller.js";
import { STEPS, readSwap } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied, failVenuePosts, loseVenueReplies } from "./helpers/resume-flows.js";
import { resumedSeller, sellerRecordOf, started, type Started } from "./helpers/resume-world.js";

const isSellerAccept = (s: Started, line: string): boolean => {
  const frame = tryDecodeFrame(line);
  return frame?.type === "accept" && frame.from === s.w.dids.seller;
};

/** The Seller's frames of kind `type` in the offers room. */
async function sellerFrames(s: Started, type: "accept" | "offer"): Promise<number> {
  return (await s.w.venue.read(OFFER_ROOM)).filter((record) => record.sender === s.w.dids.seller && tryDecodeFrame(record.line)?.type === type).length;
}

/** The bid is in the room, the Seller saved its secret and its accept A / offer B, and the accept A post never reached the venue. */
async function acceptNeverLanded(): Promise<Started> {
  const s = await started(evmWorld, [STEPS.bid]);
  const fail = failVenuePosts(s.w.venue, (_room, line) => isSellerAccept(s, line));
  await expect(STEPS.acceptLegA.run(s.c)).rejects.toBeInstanceOf(ProcessDied);
  fail.restore();
  const record = await sellerRecordOf(s.w);
  expect(record.ledger.find((entry) => entry.kind === "accept-a")?.landed, "accept A's text is saved and did not land").toBeUndefined();
  expect(await sellerFrames(s, "accept")).toBe(0);
  return s;
}

const expiresMs = (s: Started): number => s.w.bidParams.expiresMs;

describe("R2-06 (Seller): a saved accept A is not re-posted once offer A has expired", () => {
  it("the post never landed, the Seller resumes after offerA.expiresMs: next says abandoned, acceptLegA rejects with SwapExpiredError and posts nothing; no lock, no claim", async () => {
    const s = await acceptNeverLanded();
    s.w.setTime(expiresMs(s) + 60_000); // the restart comes after offer A expired
    const before = await sellerRecordOf(s.w);
    const back = await resumedSeller(s);
    expect(back.next).toBe("abandoned");
    const offerA = back.flow.recordedOfferA;
    expect(offerA).toBeDefined();
    const error = await back.flow.acceptLegA(offerA!, s.w.legB, s.w.lockTimeMs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwapExpiredError);
    expect((error as SwapExpiredError).offerId).toBe(offerA!.id);
    expect((error as SwapExpiredError).expiresMs).toBe(expiresMs(s));
    // nothing was posted, nothing was saved, nothing reached a chain
    expect(await sellerFrames(s, "accept")).toBe(0);
    expect(await sellerFrames(s, "offer")).toBe(0);
    expect((await readSwap(s.w)).acceptA).toBeUndefined();
    expect(await sellerRecordOf(s.w)).toEqual(before);
    expect(s.w.counts()).toMatchObject({ locks: 0, claims: 0, refunds: 0 });
    // the rest of the swap cannot even start: the Buyer finds neither offer B nor accept A to answer
    await expect(STEPS.acceptLegB.run(s.c)).rejects.toThrow(/is not in the venue yet/);
    expect(s.w.counts()).toMatchObject({ locks: 0, claims: 0 });
    // and it stays abandoned
    expect((await resumedSeller(s)).next).toBe("abandoned");
  });

  it("the boundary: SELLER_OFFER_EXPIRY_MARGIN_MS before the expiry the saved text is still re-posted and the swap goes on; at the margin next says abandoned and the call refuses", async () => {
    const early = await acceptNeverLanded();
    early.w.setTime(expiresMs(early) - SELLER_OFFER_EXPIRY_MARGIN_MS - 1);
    expect((await resumedSeller(early)).next).toBe("acceptLegA");
    await STEPS.acceptLegA.run(early.c);
    expect(await sellerFrames(early, "accept"), "the saved text was posted once").toBe(1);
    expect((await resumedSeller(early)).next).toBe("postAccountLineA");

    const late = await acceptNeverLanded();
    late.w.setTime(expiresMs(late) - SELLER_OFFER_EXPIRY_MARGIN_MS);
    expect((await resumedSeller(late)).next).toBe("abandoned");
    await expect(STEPS.acceptLegA.run(late.c)).rejects.toBeInstanceOf(SwapExpiredError);
    expect(await sellerFrames(late, "accept")).toBe(0);
  });

  it("an accept A that DID land (its reply was lost, its mark never saved) is adopted after the expiry, not refused and not posted twice: the guard is for posting only", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    const lose = loseVenueReplies(s.w.venue, (_room, line) => isSellerAccept(s, line));
    await expect(STEPS.acceptLegA.run(s.c)).rejects.toBeInstanceOf(ProcessDied);
    lose.restore();
    expect(await sellerFrames(s, "accept")).toBe(1);
    s.w.setTime(expiresMs(s) + 60_000);
    const back = await resumedSeller(s);
    // the record alone cannot tell (next reads no room): it says abandoned, and a runner that obeys it drops a swap with nothing at stake
    expect(back.next).toBe("abandoned");
    // a call anyway adopts the line that is in the room and finishes accept A and offer B
    await back.flow.acceptLegA(back.flow.recordedOfferA!, s.w.legB, s.w.lockTimeMs);
    expect(await sellerFrames(s, "accept"), "adopted, not posted again").toBe(1);
    expect(await sellerFrames(s, "offer")).toBe(1);
    expect((await resumedSeller(s)).next).toBe("postAccountLineA");
  });
});

describe("R2-06 (Seller): a NEW accept of an expired offer mints and saves nothing", () => {
  it("with a store: SwapExpiredError, no record in the store, nothing posted", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    s.w.setTime(expiresMs(s));
    const error = await STEPS.acceptLegA.run(s.c).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwapExpiredError);
    expect(await s.w.stores.seller.list(), "no secret was minted: no record exists").toEqual([]);
    expect(await sellerFrames(s, "accept")).toBe(0);
    expect(await sellerFrames(s, "offer")).toBe(0);
  });

  it("without a store: the same, nothing posted", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    const { store: _store, ...rest } = s.w.sellerOptions();
    const seller = new SellerFlow(rest);
    s.w.setTime(expiresMs(s) + 1);
    const offerA = (await readSwap(s.w)).offerA!;
    await expect(seller.acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)).rejects.toBeInstanceOf(SwapExpiredError);
    expect(await sellerFrames(s, "accept")).toBe(0);
    expect(seller.statement, "no statement was minted").toBeUndefined();
  });

  it("control: before the margin the same call accepts", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    s.w.setTime(expiresMs(s) - SELLER_OFFER_EXPIRY_MARGIN_MS - 1);
    await STEPS.acceptLegA.run(s.c);
    expect(await sellerFrames(s, "accept")).toBe(1);
  });

  it("a repeat of an accept that already began, after the expiry, is still FlowRecordExistsError (it names the record to resume), not SwapExpiredError", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA]);
    s.w.setTime(expiresMs(s) + 1);
    const again = new SellerFlow(s.w.sellerOptions());
    const offerA = (await readSwap(s.w)).offerA!;
    await expect(again.acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)).rejects.toBeInstanceOf(FlowRecordExistsError);
  });
});
