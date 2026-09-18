// SPDX-License-Identifier: MIT
//
// buildBoard: grouping tclk-offers into per-swap views, with multiple swaps interleaved,
// non-swap tclk traffic mixed in (ignored silently), a competing second leg B (loses the
// earliest-seq tie-break, reported in `unpaired`), and forged/unsigned noise (skipped
// before it ever reaches a fold).

import { encodeFrame, generateHashLock, makeAccept, makeOffer, OFFER_ROOM, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { buildBoard } from "../src/board.js";
import { legBContext } from "../src/profile.js";
import { identity, record, unsignedRecord } from "./helpers/identity.js";
import { scenario } from "./helpers/scenario.js";

const T0 = 1_758_000_000_000;
const MIN = 60_000;

const buyer = identity("a1".repeat(32));
const seller = identity("b2".repeat(32));
const rivalSeller = identity("d4".repeat(32));
const stranger = identity("c3".repeat(32));

/** Re-numbers a record's `seq` to reflect one shared room's venue order. Signatures cover
 *  `room|nonce|line`, not `seq`, so this cannot invalidate an already-signed record. */
function seqCounter(): (r: TranscriptRecord) => TranscriptRecord {
  let n = 0;
  return (r) => ({ ...r, seq: ++n });
}

describe("buildBoard", () => {
  it("pairs two interleaved swaps, ignores non-swap traffic, and skips forged noise", () => {
    const s1 = scenario({
      buyer,
      seller,
      t0: T0,
      swapNonce: "1111111111111111",
      offerANonce: "1a1a1a1a1a1a1a1a",
      acceptANonce: "1b1b1b1b1b1b1b1b",
      offerBNonce: "1c1c1c1c1c1c1c1c",
      acceptBNonce: "1d1d1d1d1d1d1d1d",
    });
    const s2 = scenario({
      buyer,
      seller,
      t0: T0 + 50 * MIN,
      swapNonce: "2222222222222222",
      offerANonce: "2a2a2a2a2a2a2a2a",
      acceptANonce: "2b2b2b2b2b2b2b2b",
      offerBNonce: "2c2c2c2c2c2c2c2c",
      acceptBNonce: "2d2d2d2d2d2d2d2d",
    });

    // Real-looking non-swap tclk traffic (a plain x402 payment offer with a random nonce).
    const noiseOffer = makeOffer({
      from: stranger.did,
      role: "payer",
      amount: "5",
      asset: "USD",
      lock: "hash",
      rails: ["x402"],
      claimByMs: T0 + 10 * MIN,
      refundAfterMs: T0 + 20 * MIN,
      expiresMs: T0 + 5 * MIN,
      nonce: "9f9f9f9f9f9f9f9f",
    });
    const noiseOffer2 = makeOffer({
      from: buyer.did,
      role: "payee",
      amount: "42",
      asset: "memory-credit",
      lock: "hash",
      rails: ["memory"],
      claimByMs: T0 + 15 * MIN,
      refundAfterMs: T0 + 25 * MIN,
      expiresMs: T0 + 8 * MIN,
      nonce: "8e8e8e8e8e8e8e8e",
    });

    const seq = seqCounter();
    const offers: TranscriptRecord[] = [
      seq(s1.records.offerA),
      seq(record(OFFER_ROOM, 0, T0 + 1, stranger, encodeFrame(noiseOffer))),
      seq(s1.records.acceptA),
      seq(s1.records.offerB),
      seq(s1.records.acceptB),
      seq(record(OFFER_ROOM, 0, T0 + 2, buyer, encodeFrame(noiseOffer2))),
      seq(s2.records.offerA),
      seq(s2.records.acceptA),
      seq(s2.records.offerB),
      seq(s2.records.acceptB),
    ];

    const dealRooms = new Map<string, readonly TranscriptRecord[]>([
      [s1.dealRoomB, [s1.records.lockB]],
    ]);
    const evidence = new Map([[s1.swapId, { b: { rail: "flop-htlc", ref: "flop-escrow-1", verified: true, checkedAtMs: T0 + 5 * MIN } }]]);

    const board = buildBoard({ offers, dealRooms, evidence, nowMs: T0 + 6 * MIN });

    expect(board.swaps).toHaveLength(2);
    const bySwapId = new Map(board.swaps.map((view) => [view.swapId, view]));
    expect(bySwapId.get(s1.swapId)?.status).toBe("b-locked");
    expect(bySwapId.get(s2.swapId)?.status).toBe("paired");
    // Non-swap traffic never produces a swap view or an unpaired entry.
    expect(board.unpaired).toHaveLength(0);
  });

  it("pairs leg A with the Seller's accept even when a stranger accepted the bid first (live 2026-09-18)", () => {
    // On the real board, bots accepted our leg A bid within seconds. The accept that belongs to
    // the swap is the one from the party who opened leg B; the stranger's earlier accept is a
    // different, unrelated contract and must not capture the pairing.
    const s1 = scenario({ buyer, seller, t0: T0, swapNonce: "4444444444444444" });
    const strangerAccept = makeAccept(s1.frames.offerA, {
      from: stranger.did,
      statement: generateHashLock().hash,
      nonce: "abababababababab",
    });

    const seq = seqCounter();
    const offers: TranscriptRecord[] = [
      seq(s1.records.offerA),
      seq(record(OFFER_ROOM, 0, T0 + 500, stranger, encodeFrame(strangerAccept))), // first accept
      seq(s1.records.acceptA), // the Seller's accept, later
      seq(s1.records.offerB),
      seq(s1.records.acceptB),
    ];

    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 4 * MIN });

    expect(board.swaps).toHaveLength(1);
    expect(board.swaps[0]?.status).toBe("paired");
    expect(board.swaps[0]?.sellerDid).toBe(seller.did);
    expect(board.unpaired).toEqual([]);

    // With no leg B at all, the earliest accept stands in (an ordinary accepted bid).
    const lone = buildBoard({ offers: offers.slice(0, 3), dealRooms: new Map(), nowMs: T0 + 4 * MIN });
    expect(lone.swaps[0]?.status).toBe("accepted");
    expect(lone.swaps[0]?.sellerDid).toBe(stranger.did);
  });

  it("reports a competing second leg B as unpaired, loses the earliest-seq tie-break", () => {
    const s1 = scenario({ buyer, seller, t0: T0, swapNonce: "3333333333333333" });

    const rogueOfferB = makeOffer({
      from: rivalSeller.did,
      role: "payer",
      amount: "52070000",
      asset: "FLOP",
      lock: "hash",
      rails: ["flop-htlc"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: s1.swapId, context: legBContext(s1.frames.offerA.id) },
      nonce: "eeeeeeeeeeeeeeee",
    });

    const seq = seqCounter();
    const offers: TranscriptRecord[] = [
      seq(s1.records.offerA),
      seq(s1.records.acceptA),
      seq(s1.records.offerB), // the honest leg B — earlier seq, wins the pairing
      seq(s1.records.acceptB),
      seq(record(OFFER_ROOM, 0, T0 + 3 * MIN, rivalSeller, encodeFrame(rogueOfferB))), // later — loses
    ];

    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 4 * MIN });

    expect(board.swaps).toHaveLength(1);
    expect(board.swaps[0]?.status).toBe("paired");
    expect(board.unpaired).toEqual([{ offerId: rogueOfferB.id, reason: "leg A already paired" }]);
  });

  it("reports an orphan leg B (unknown leg A) as unpaired", () => {
    const orphanId = `0x${"77".repeat(32)}`;
    const orphanOfferB = makeOffer({
      from: seller.did,
      role: "payer",
      amount: "1",
      asset: "FLOP",
      lock: "hash",
      rails: ["flop-htlc"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: {
        proto: "swap",
        id: `0x${"66".repeat(32)}`,
        context: legBContext(orphanId),
      },
      nonce: "dddddddddddddddd",
    });
    const seq = seqCounter();
    const offers = [seq(record(OFFER_ROOM, 0, T0, seller, encodeFrame(orphanOfferB)))];

    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 1 });
    expect(board.swaps).toHaveLength(0);
    expect(board.unpaired).toEqual([
      { offerId: orphanOfferB.id, reason: "leg B names an unknown leg A offer id" },
    ]);
  });

  it("skips an unsigned record and a record posted in the wrong room without pairing them", () => {
    const s1 = scenario({ buyer, seller, t0: T0, swapNonce: "4444444444444444" });
    const seq = seqCounter();
    const offers: TranscriptRecord[] = [
      seq(s1.records.offerA),
      seq(unsignedRecord(OFFER_ROOM, 0, T0 + 1, s1.records.acceptA.line)), // forged: unsigned
      seq(record("lobby", 0, T0 + 1, seller, s1.records.acceptA.line)), // forged: wrong room
    ];

    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 2 * MIN });

    // The real accept never authenticated, so leg A is still just a bid.
    expect(board.swaps).toHaveLength(1);
    expect(board.swaps[0]?.status).toBe("bid");
    expect(board.unpaired).toHaveLength(0);
  });

  it("never lets identity count influence pairing (three honest offers, one swap)", () => {
    const s1 = scenario({ buyer, seller, t0: T0, swapNonce: "5555555555555555" });
    const extraLock = generateHashLock();
    const decoyOffer = makeOffer({
      from: stranger.did,
      role: "payer",
      amount: "1",
      asset: "USDC",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: T0 + 5 * MIN,
      refundAfterMs: T0 + 10 * MIN,
      expiresMs: T0 + 2 * MIN,
      nonce: "cacacacacacacaca",
    });
    void extraLock;
    const seq = seqCounter();
    const offers: TranscriptRecord[] = [
      seq(record(OFFER_ROOM, 0, T0, stranger, encodeFrame(decoyOffer))),
      seq(s1.records.offerA),
      seq(s1.records.acceptA),
      seq(s1.records.offerB),
      seq(s1.records.acceptB),
    ];
    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 4 * MIN });
    expect(board.swaps).toHaveLength(1);
    expect(board.swaps[0]?.status).toBe("paired");
  });
});
