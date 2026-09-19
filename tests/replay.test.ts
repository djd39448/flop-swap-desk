// SPDX-License-Identifier: MIT
//
// foldCaptured / findSwapLegCandidates (src/replay.ts): the shared "assemble → evidence →
// buildBoard" step, exercised directly (not through the watcher's own fetch machinery) so
// it is provably usable standalone — exactly how examples/audit-export.mjs uses it.

import {
  OFFER_ROOM,
  dealRoom,
  encodeFrame,
  encodePaperRecord,
  generateHashLock,
  makeAccept,
  makeOffer,
  type LockFrame,
  type RevealFrame,
} from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { findSwapLegCandidates, foldCaptured } from "../src/replay.js";
import { identity, record } from "./helpers/identity.js";

const T0 = 1_758_000_000_000;
const MIN = 60_000;

const buyer = identity("d4".repeat(32));
const seller = identity("e5".repeat(32));

function buildPaperSwap() {
  const swapId = makeSwapId(buyer.did, "f001f001f001f001");
  const lock = generateHashLock();

  const legAOffer = makeOffer({
    from: buyer.did,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["paper"],
    claimByMs: T0 + 45 * MIN,
    refundAfterMs: T0 + 60 * MIN,
    expiresMs: T0 + 30 * MIN,
    job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash });

  const legBOffer = makeOffer({
    from: seller.did,
    role: "payer",
    amount: "52070000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc", "paper"],
    claimByMs: T0 + 70 * MIN,
    refundAfterMs: T0 + 180 * MIN,
    expiresMs: T0 + 40 * MIN,
    job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash });

  const offers = [
    record(OFFER_ROOM, 1, T0, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, 2, T0 + 1 * MIN, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(legBAccept)),
  ];

  const dealRoomB = dealRoom(legBAccept.contract);
  const lockB: LockFrame = { type: "lock", from: seller.did, contract: legBAccept.contract, rail: "paper", ref: legBAccept.contract };
  const revealB: RevealFrame = { type: "reveal", from: buyer.did, contract: legBAccept.contract, ref: legBAccept.contract, secret: lock.preimage };
  const dealRoomsB = [
    record(dealRoomB, 1, T0 + 4 * MIN, seller, encodeFrame(lockB)),
    record(dealRoomB, 2, T0 + 5 * MIN, buyer, encodeFrame(revealB)),
  ];

  return { swapId, lock, legAOffer, legAAccept, legBOffer, legBAccept, offers, dealRoomB, dealRoomsB };
}

describe("findSwapLegCandidates", () => {
  it("finds both legs' contracts, carrying swapId/leg/offer/accept", () => {
    const s = buildPaperSwap();
    const { candidates, swapLegOffers } = findSwapLegCandidates(s.offers);
    expect(swapLegOffers).toBe(2);
    expect(candidates.map((c) => c.contract).sort()).toEqual(
      [s.legAAccept.contract, s.legBAccept.contract].sort(),
    );
    const legB = candidates.find((c) => c.contract === s.legBAccept.contract)!;
    expect(legB.leg).toBe("b");
    expect(legB.swapId).toBe(s.swapId);
    expect(legB.offer.refundAfterMs).toBe(s.legBOffer.refundAfterMs);
    expect(legB.accept.statement).toBe(s.legBAccept.statement);
  });
});

describe("foldCaptured", () => {
  it("folds a captured paper note into evidence and settles/advances accordingly", () => {
    const s = buildPaperSwap();
    const noteValue = encodePaperRecord({
      status: "locked",
      lock: "hash",
      statement: s.lock.hash,
      refundAfterMs: s.legBOffer.refundAfterMs,
    });
    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomB, s.dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteValue}\n`, endpoint: "kv:test" }]]),
      nowMs: T0 + 6 * MIN,
    });
    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.b?.rail).toBe("paper");
    expect(view!.evidence.b?.verified).toBe(true);
    expect(view!.evidence.bRail?.status).toBe("locked");
    expect(view!.reasons).toContain("paper rail: rehearsal only, no value");
  });

  it("a candidate with a paper lock but no captured note gets no evidence for that leg", () => {
    const s = buildPaperSwap();
    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomB, s.dealRoomsB]]),
      notes: new Map(), // nothing captured — mirrors a 404 or an uncaptured replay
      nowMs: T0 + 6 * MIN,
    });
    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.b).toBeUndefined();
    expect(view!.evidence.bRail).toBeUndefined();
  });
});
