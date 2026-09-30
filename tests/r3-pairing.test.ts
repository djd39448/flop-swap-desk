// SPDX-License-Identifier: MIT
//
// R3-2 / R3-3 (focused re-review of the tclk#194 fix): a stranger who accepts leg A and posts
// their own leg B first must not hide the real swap; the bundle must never take a stranger's
// pairing; audit-export --expect is ambiguous only among same-signer leg-A offers.

import { OFFER_ROOM, encodeFrame, generateHashLock, makeAccept, makeOffer, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { buildBoard } from "../src/board.js";
import { selectBundleSwap } from "../src/client/bundle.js";
import { legAContext, legBContext } from "../src/profile.js";
import { foldCaptured } from "../src/replay.js";
import { identity, record } from "./helpers/identity.js";
import { scenario } from "./helpers/scenario.js";
// @ts-expect-error plain .mjs, no type declarations
import { statusForExpectation } from "../examples/audit-export.mjs";

const T0 = 1_758_000_000_000;
const MIN = 60_000;
const buyer = identity("a1".repeat(32));
const seller = identity("b2".repeat(32));
const stranger = identity("c3".repeat(32));

function strangerFrames(s: ReturnType<typeof scenario>) {
  const acceptA = makeAccept(s.frames.offerA, {
    from: stranger.did,
    statement: generateHashLock().hash,
    nonce: "5a5a5a5a5a5a5a5a",
  });
  const offerB = makeOffer({
    from: stranger.did,
    role: "payer",
    amount: "52070000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: T0 + 70 * MIN,
    refundAfterMs: T0 + 180 * MIN,
    expiresMs: T0 + 40 * MIN,
    job: { proto: "swap", id: s.swapId, context: legBContext(s.frames.offerA.id) },
    nonce: "5b5b5b5b5b5b5b5b",
  });
  return { acceptA, offerB };
}

function order(records: TranscriptRecord[]): TranscriptRecord[] {
  return records.map((r, i) => ({ ...r, seq: i + 1 }));
}

describe("R3-2: the crossing pair wins over a stranger's leg B", () => {
  for (const strangerAcceptsFirst of [true, false]) {
    it(`stranger accept ${strangerAcceptsFirst ? "before" : "after"} the Seller's: real swap folds to its true status`, () => {
      const s = scenario({ buyer, seller, t0: T0, swapNonce: "7777777777777777" });
      const x = strangerFrames(s);
      const sAccept = record(OFFER_ROOM, 0, T0 + 500, stranger, encodeFrame(x.acceptA));
      const sOffer = record(OFFER_ROOM, 0, T0 + 600, stranger, encodeFrame(x.offerB));
      const offers = order(
        strangerAcceptsFirst
          ? [s.records.offerA, sAccept, sOffer, s.records.acceptA, s.records.offerB, s.records.acceptB]
          : [s.records.offerA, s.records.acceptA, sAccept, sOffer, s.records.offerB, s.records.acceptB],
      );
      const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 4 * MIN });
      expect(board.swaps).toHaveLength(1);
      const view = board.swaps[0]!;
      expect(view.status).toBe("paired");
      expect(view.sellerDid).toBe(seller.did);
      expect(view.legBOfferId).toBe(s.frames.offerB.id);
      expect(view.coordinationOnly).toEqual([]);
      expect(board.unpaired.map((u) => u.offerId)).toEqual([x.offerB.id]);
    });
  }

  it("with no crossing pair the row-order fallback is used and flagged coordination-only", () => {
    const s = scenario({ buyer, seller, t0: T0, swapNonce: "7777777777777777" });
    const x = strangerFrames(s);
    const offers = order([
      s.records.offerA,
      record(OFFER_ROOM, 0, T0 + 500, stranger, encodeFrame(x.acceptA)),
      record(OFFER_ROOM, 0, T0 + 600, stranger, encodeFrame(x.offerB)),
    ]);
    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 4 * MIN });
    const view = board.swaps[0]!;
    expect(view.legBOfferId).toBe(x.offerB.id);
    expect(view.coordinationOnly.some((f) => f.reason.includes("no crossing pair"))).toBe(true);
  });

  it("selectBundleSwap never takes a stranger's pairing that shares the swapId", () => {
    const s = scenario({ buyer, seller, t0: T0, swapNonce: "7777777777777777" });
    const x = strangerFrames(s);
    // Board holds only the stranger's pairing (the real leg B is missing from this export).
    const offers = order([
      s.records.offerA,
      record(OFFER_ROOM, 0, T0 + 500, stranger, encodeFrame(x.acceptA)),
      record(OFFER_ROOM, 0, T0 + 600, stranger, encodeFrame(x.offerB)),
    ]);
    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 4 * MIN });
    expect(board.swaps[0]!.legA?.state?.contract).toBe(x.acceptA.contract);
    const chosen = selectBundleSwap(board.swaps, {
      swapId: s.swapId,
      legA: { contract: s.frames.acceptA.contract, rail: "evm-htlc" },
      legB: { contract: s.frames.acceptB.contract, rail: "flop-htlc" },
    });
    expect(chosen).toBeUndefined();
  });
});

describe("R3-3: audit-export --expect ignores another signer's copy of a swapId", () => {
  it("a stranger's copy does not make the victim's swapId ambiguous", () => {
    const s = scenario({ buyer, seller, t0: T0, swapNonce: "7777777777777777" });
    const copy = makeOffer({
      from: stranger.did,
      role: "payer",
      amount: "1000",
      asset: "USDC",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: T0 + 45 * MIN,
      refundAfterMs: T0 + 60 * MIN,
      expiresMs: T0 + 30 * MIN,
      job: { proto: "swap", id: s.swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "1", wantRail: "flop-htlc" }) },
      nonce: "6a6a6a6a6a6a6a6a",
    });
    const offers = order([...s.mainline.slice(0, 5), record(OFFER_ROOM, 0, T0 + 20 * MIN, stranger, encodeFrame(copy))]);
    const board = foldCaptured({ offers, dealRooms: new Map(), notes: new Map(), nowMs: T0 + 9 * MIN });
    expect(board.swaps).toHaveLength(2);
    const victim = board.swaps.find((v) => v.legAOfferId === s.frames.offerA.id)!;
    expect(statusForExpectation(board.swaps, s.swapId)).toBe(victim.status);
  });
});
