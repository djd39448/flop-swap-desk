// SPDX-License-Identifier: MIT
//
// Regression tests for Viriat01's review of flop-labs/tclk#194 (2026-09-28):
//   (1) a `RailObservation` must be bound to the leg's accepted rail/ref/contract/terms before
//       the fold may use it for funded/claimed/refunded/settled;
//   (2) `swapId` is not unique, so evidence must be keyed per pair (leg contract), and two
//       active swaps sharing a swapId must never look up evidence at all.

import {
  OFFER_ROOM,
  contractId,
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

import { buildBoard } from "../src/board.js";
import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { findSwapLegCandidates, foldCaptured } from "../src/replay.js";
import { foldSwap } from "../src/swap.js";
import type { RailObservation } from "../src/types.js";
import { identity, record } from "./helpers/identity.js";
import { observe } from "./helpers/observations.js";
import { scenario } from "./helpers/scenario.js";

const T0 = 1_758_000_000_000;
const MIN = 60_000;

const buyer = identity("a1".repeat(32));
const seller = identity("b2".repeat(32));

function claimedScenario() {
  const s = scenario({ buyer, seller, t0: T0 });
  return {
    s,
    legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.revealA],
    legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.revealB],
  };
}

describe("finding 1: rail observations are bound to the leg's accepted pair", () => {
  it("REPRODUCTION: wrong-ref/wrong-amount LockEvidence with railVerified false plus two bare final 'claimed' observations does NOT fold to settled", () => {
    const { s, legA, legB } = claimedScenario();
    const wrongA = { ...s.legATerms, amount: "1" };
    const wrongB = { ...s.legBTerms, amount: "2" };
    const view = foldSwap({
      legA,
      legB,
      evidence: {
        a: { rail: "evm-htlc", ref: "0xwrong", terms: wrongA, railVerified: false, checkedAtMs: T0 },
        b: { rail: "flop-htlc", ref: "wrong", terms: wrongB, railVerified: false, checkedAtMs: T0 },
        // A bare observation, exactly what the pre-fix type allowed.
        aRail: { status: "claimed", final: true, checkedAtMs: T0 } as unknown as RailObservation,
        bRail: { status: "claimed", final: true, checkedAtMs: T0 } as unknown as RailObservation,
      },
      nowMs: T0 + 9 * MIN,
    });
    expect(view.status).not.toBe("settled");
    expect(view.status).toBe("revealed");
    expect(view.reasons.filter((r) => r.includes("rail observation ignored"))).toHaveLength(2);
    expect(view.evidence.aRail).toBeUndefined();
    expect(view.evidence.bRail).toBeUndefined();
    expect(view.settlementView).toEqual({ a: "unverified", b: "unverified" });
  });

  it("control: correctly bound final 'claimed' observations on both legs still settle, with no ignore reason", () => {
    const { s, legA, legB } = claimedScenario();
    const view = foldSwap({
      legA,
      legB,
      evidence: { aRail: observe(s, "a", "claimed", T0), bRail: observe(s, "b", "claimed", T0) },
      nowMs: T0 + 9 * MIN,
    });
    expect(view.status).toBe("settled");
    expect(view.reasons.some((r) => r.includes("ignored"))).toBe(false);
  });

  const mutations: Array<[string, (o: RailObservation) => RailObservation]> = [
    ["rail", (o) => ({ ...o, rail: "btc-htlc" })],
    ["ref", (o) => ({ ...o, ref: "0xsomeoneelses" })],
    ["contract", (o) => ({ ...o, contract: "0x" + "9".repeat(64) })],
    ["terms.amount", (o) => ({ ...o, terms: { ...o.terms, amount: "999999" } })],
    ["terms.statement", (o) => ({ ...o, terms: { ...o.terms, statement: "0x" + "8".repeat(64) } })],
    ["terms.payee", (o) => ({ ...o, terms: { ...o.terms, payee: o.terms.payer, payer: o.terms.payee } })],
    ["terms.refundAfterMs", (o) => ({ ...o, terms: { ...o.terms, refundAfterMs: o.terms.refundAfterMs + 1 } })],
    ["missing binding", (o) => ({ status: o.status, final: o.final, checkedAtMs: o.checkedAtMs }) as unknown as RailObservation],
  ];

  for (const [name, mutate] of mutations) {
    it(`a mismatched ${name} refuses the observation for settled, claimed, funded and refunded alike`, () => {
      const { s, legA, legB } = claimedScenario();
      // settled / claimed
      const settled = foldSwap({
        legA,
        legB,
        evidence: { aRail: mutate(observe(s, "a", "claimed", T0)), bRail: observe(s, "b", "claimed", T0) },
        nowMs: T0 + 9 * MIN,
      });
      expect(settled.status).toBe("revealed");
      expect(settled.reasons.some((r) => r.startsWith("leg A rail observation ignored"))).toBe(true);
      expect(settled.settlementView.a).toBe("none");

      // funded
      const funded = foldSwap({
        legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
        legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
        evidence: { bRail: mutate(observe(s, "b", "locked", T0)) },
        nowMs: T0 + 5 * MIN,
      });
      expect(funded.settlementView.b).toBe("none");
      expect(funded.reasons.some((r) => r.startsWith("leg B rail observation ignored"))).toBe(true);

      // refunded
      const refunded = foldSwap({
        legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
        legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
        evidence: { aRail: mutate(observe(s, "a", "refunded", T0)) },
        nowMs: T0 + 61 * MIN,
      });
      expect(refunded.status).not.toBe("refunded-a");
      expect(refunded.settlementView.a).toBe("none");
    });
  }

  it("an observation for a leg with no accepted lock frame is refused", () => {
    const s = scenario({ buyer, seller, t0: T0 });
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB],
      evidence: { aRail: observe(s, "a", "refunded", T0) },
      nowMs: T0 + 61 * MIN,
    });
    expect(view.status).not.toBe("refunded-a");
    expect(view.reasons.some((r) => r.includes("no accepted lock frame"))).toBe(true);
  });

  it("LockEvidence for another rail/ref does not corroborate a lock", () => {
    const s = scenario({ buyer, seller, t0: T0 });
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: { b: { rail: "flop-htlc", ref: "some-other-escrow", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 } },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.reasons).toContain("leg B lock evidence is for a different rail/ref than the accepted lock frame");
  });
});

// Two distinct, fully-signed paper-rail swaps from the same buyer with the same swapId (same nonce).
function paperPair(tag: string) {
  const swapId = makeSwapId(buyer.did, "f001f001f001f001"); // the SAME buyer + nonce for both pairs
  const lock = generateHashLock();
  const nonce = (suffix: string) => `${tag}${suffix}`.padEnd(16, "0");
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
    nonce: nonce("a"),
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash, nonce: nonce("b") });
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
    nonce: nonce("c"),
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash, nonce: nonce("d") });

  const lockFrame = (contract: string, from: string): LockFrame => ({ type: "lock", from, contract, rail: "paper", ref: contract });
  const revealFrame = (contract: string, from: string): RevealFrame => ({ type: "reveal", from, contract, ref: contract, secret: lock.preimage });
  const roomA = dealRoom(legAAccept.contract);
  const roomB = dealRoom(legBAccept.contract);
  const dealRooms = new Map([
    [
      roomB,
      [
        record(roomB, 1, T0 + 4 * MIN, seller, encodeFrame(lockFrame(legBAccept.contract, seller.did))),
        record(roomB, 2, T0 + 7 * MIN, buyer, encodeFrame(revealFrame(legBAccept.contract, buyer.did))),
      ],
    ],
    [
      roomA,
      [
        record(roomA, 1, T0 + 5 * MIN, buyer, encodeFrame(lockFrame(legAAccept.contract, buyer.did))),
        record(roomA, 2, T0 + 6 * MIN, seller, encodeFrame(revealFrame(legAAccept.contract, seller.did))),
      ],
    ],
  ]);
  const claimedNote = (refundAfterMs: number) =>
    encodePaperRecord({ status: "claimed", lock: "hash", statement: lock.hash, refundAfterMs, secret: lock.preimage });
  const offerRecords = (seq0: number, dt: number) => [
    record(OFFER_ROOM, seq0, T0 + dt, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, seq0 + 1, T0 + 1 * MIN + dt, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, seq0 + 2, T0 + 2 * MIN + dt, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, seq0 + 3, T0 + 3 * MIN + dt, buyer, encodeFrame(legBAccept)),
  ];
  const notes = () =>
    new Map([
      [legAAccept.contract, { body: claimedNote(legAOffer.refundAfterMs), endpoint: "kv:a" }],
      [legBAccept.contract, { body: claimedNote(legBOffer.refundAfterMs), endpoint: "kv:b" }],
    ]);
  return { swapId, legAOffer, legAAccept, legBOffer, legBAccept, dealRooms, offerRecords, notes };
}

describe("finding 2: swapId is not a unique key for evidence", () => {
  it("V3: a stranger copying a settled swap's public swapId into an offer of their own changes nothing for the victim", () => {
    const one = paperPair("aa01");
    const stranger = identity("c3".repeat(32));
    const copied = makeOffer({
      from: stranger.did,
      role: "payer",
      amount: "1000",
      asset: "USDC",
      lock: "hash",
      rails: ["paper"],
      claimByMs: T0 + 45 * MIN,
      refundAfterMs: T0 + 60 * MIN,
      expiresMs: T0 + 30 * MIN,
      job: { proto: "swap", id: one.swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "1", wantRail: "flop-htlc" }) },
      nonce: "5eed5eed5eed5eed",
    });
    const offers = [...one.offerRecords(1, 0), record(OFFER_ROOM, 5, T0 + 20 * MIN, stranger, encodeFrame(copied))];
    const board = foldCaptured({ offers, dealRooms: one.dealRooms, notes: one.notes(), nowMs: T0 + 9 * MIN });
    const victim = board.swaps.find((view) => view.legAOfferId === one.legAOffer.id)!;
    expect(victim.status).toBe("settled");
    expect(victim.evidence.aRail).toBeDefined();
    expect(victim.evidence.bRail).toBeDefined();
    // A different signer's copy is not the same buyer's reuse: nothing is reported on the victim.
    expect(victim.reasons.some((r) => r.includes("shared by"))).toBe(false);
    const copy = board.swaps.find((view) => view.legAOfferId === copied.id)!;
    expect(copy.status).toBe("bid");
    expect(copy.evidence.aRail).toBeUndefined();
  });

  it("two distinct pairs with the same buyer and nonce, one pair's evidence: only that pair settles (V3), both report the shared swapId as information", () => {
    const one = paperPair("aa01");
    const two = paperPair("bb02");
    expect(two.swapId).toBe(one.swapId);
    expect(two.legAAccept.contract).not.toBe(one.legAAccept.contract);

    const offers = [...one.offerRecords(1, 0), ...two.offerRecords(5, 10)];
    const dealRooms = new Map([...one.dealRooms, ...two.dealRooms]);
    // Evidence (claimed paper notes) exists for pair 1 ONLY.
    const board = foldCaptured({ offers, dealRooms, notes: one.notes(), nowMs: T0 + 9 * MIN });
    expect(board.swaps).toHaveLength(2);
    const byOffer = new Map(board.swaps.map((view) => [view.legAOfferId, view]));
    const v1 = byOffer.get(one.legAOffer.id)!;
    const v2 = byOffer.get(two.legAOffer.id)!;
    // Pair 1 folds from its own evidence; pair 2 never borrows it.
    expect(v1.status).toBe("settled");
    expect(v2.status).not.toBe("settled");
    expect(v2.evidence.aRail).toBeUndefined();
    expect(v2.evidence.bRail).toBeUndefined();
    for (const view of board.swaps) {
      expect(view.reasons.some((r) => r.includes("shared by 2 leg-A offers signed by the same buyer") && r.includes("information only"))).toBe(true);
    }
  });

  it("control: the same pair alone (no duplicate swapId) settles from its own evidence", () => {
    const one = paperPair("aa01");
    const board = foldCaptured({ offers: one.offerRecords(1, 0), dealRooms: one.dealRooms, notes: one.notes(), nowMs: T0 + 9 * MIN });
    expect(board.swaps).toHaveLength(1);
    expect(board.swaps[0]!.status).toBe("settled");
    expect(board.swaps[0]!.pairKey).toBe(`${one.legAOffer.id}|${one.legAAccept.contract}|${one.legBAccept.contract}`);
  });

  it("buildBoard: evidence is keyed by leg contract; another pair's evidence is never applied", () => {
    const one = paperPair("aa01");
    const two = paperPair("bb02");
    const board = buildBoard({
      offers: one.offerRecords(1, 0),
      dealRooms: one.dealRooms,
      // keyed by a contract that belongs to the OTHER pair: must never be applied here
      evidence: new Map([
        [
          two.legBAccept.contract,
          { lock: { rail: "paper", ref: two.legBAccept.contract, terms: {} as never, railVerified: true, checkedAtMs: T0 } },
        ],
      ]),
      nowMs: T0 + 9 * MIN,
    });
    expect(board.swaps[0]!.evidence.b).toBeUndefined();
  });
});

describe("V5: only genuine accepts key candidates and evidence", () => {
  const other = identity("d4".repeat(32));

  it("a forged accept (real contract id, another signer) cannot displace the genuine candidate or borrow its evidence", () => {
    const one = paperPair("aa01");
    const forged = { ...one.legAAccept, from: other.did };
    // The forged accept arrives first in row order.
    const rows = [
      record(OFFER_ROOM, 1, T0, buyer, encodeFrame(one.legAOffer)),
      record(OFFER_ROOM, 2, T0 + 30_000, other, encodeFrame(forged)),
      record(OFFER_ROOM, 3, T0 + 1 * MIN, seller, encodeFrame(one.legAAccept)),
      record(OFFER_ROOM, 4, T0 + 2 * MIN, seller, encodeFrame(one.legBOffer)),
      record(OFFER_ROOM, 5, T0 + 3 * MIN, buyer, encodeFrame(one.legBAccept)),
    ];
    const { candidates } = findSwapLegCandidates(rows);
    const forA = candidates.filter((c) => c.contract === one.legAAccept.contract);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.accept.from).toBe(seller.did);
    expect(forA[0]!.acceptSeq).toBe(3);

    const board = foldCaptured({ offers: rows, dealRooms: one.dealRooms, notes: one.notes(), nowMs: T0 + 9 * MIN });
    expect(board.swaps).toHaveLength(1);
    expect(board.swaps[0]!.status).toBe("settled");
  });

  it("a self-accept (accept signed by the offerer) is not a candidate and buildBoard never keys evidence by it", () => {
    const one = paperPair("aa01");
    const core = { from: buyer.did, ref: one.legAOffer.id, statement: generateHashLock().hash, nonce: "5e1f5e1f5e1f5e1f" };
    const selfAccept = { type: "accept" as const, ...core, contract: contractId(one.legAOffer, core) };
    const only = [record(OFFER_ROOM, 1, T0, buyer, encodeFrame(one.legAOffer)), record(OFFER_ROOM, 2, T0 + MIN, buyer, encodeFrame(selfAccept))];
    expect(findSwapLegCandidates(only).candidates).toHaveLength(0);
    const board = buildBoard({
      offers: only,
      dealRooms: new Map(),
      evidence: new Map([[selfAccept.contract, { lock: { rail: "paper", ref: selfAccept.contract, terms: {} as never, railVerified: true, checkedAtMs: T0 } }]]),
      nowMs: T0 + 2 * MIN,
    });
    expect(board.swaps[0]!.status).toBe("bid");
    expect(board.swaps[0]!.evidence.a).toBeUndefined();
  });

  it("an accept whose contract does not match its own offer/accept core is dropped", () => {
    const one = paperPair("aa01");
    const bogus = { ...one.legAAccept, contract: "0x" + "7".repeat(64) };
    const only = [record(OFFER_ROOM, 1, T0, buyer, encodeFrame(one.legAOffer)), record(OFFER_ROOM, 2, T0 + MIN, seller, encodeFrame(bogus))];
    expect(findSwapLegCandidates(only).candidates).toHaveLength(0);
    expect(buildBoard({ offers: only, dealRooms: new Map(), nowMs: T0 + 2 * MIN }).swaps[0]!.status).toBe("bid");
  });
});

describe("V6: leg B belongs to the DID that accepted leg A", () => {
  const stranger = identity("c3".repeat(32));
  const strangerLegB = (one: ReturnType<typeof paperPair>) =>
    makeOffer({
      from: stranger.did,
      role: "payer",
      amount: "52070000",
      asset: "FLOP",
      lock: "hash",
      rails: ["paper"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: one.swapId, context: legBContext(one.legAOffer.id) },
      nonce: "5747a4ce5747a4ce",
    });

  it("an earlier leg-B offer from a stranger does not pair; the accepter's leg B does", () => {
    const one = paperPair("aa01");
    const squat = strangerLegB(one);
    const offers = [
      record(OFFER_ROOM, 1, T0, buyer, encodeFrame(one.legAOffer)),
      record(OFFER_ROOM, 2, T0 + 30_000, stranger, encodeFrame(squat)), // earliest leg B
      record(OFFER_ROOM, 3, T0 + 1 * MIN, seller, encodeFrame(one.legAAccept)),
      record(OFFER_ROOM, 4, T0 + 2 * MIN, seller, encodeFrame(one.legBOffer)),
      record(OFFER_ROOM, 5, T0 + 3 * MIN, buyer, encodeFrame(one.legBAccept)),
    ];
    const board = buildBoard({ offers, dealRooms: one.dealRooms, nowMs: T0 + 9 * MIN });
    expect(board.swaps).toHaveLength(1);
    expect(board.swaps[0]!.legBOfferId).toBe(one.legBOffer.id);
    expect(board.swaps[0]!.sellerDid).toBe(seller.did);
    expect(board.unpaired.find((u) => u.offerId === squat.id)?.reason).toBe("leg B is not signed by the DID that accepted leg A");
  });

  it("with no accept on leg A, the earliest leg B stands in and is marked coordination-only", () => {
    const one = paperPair("aa01");
    const offers = [record(OFFER_ROOM, 1, T0, buyer, encodeFrame(one.legAOffer)), record(OFFER_ROOM, 2, T0 + MIN, seller, encodeFrame(one.legBOffer))];
    const board = buildBoard({ offers, dealRooms: new Map(), nowMs: T0 + 2 * MIN });
    expect(board.swaps[0]!.legBOfferId).toBe(one.legBOffer.id);
    expect(board.swaps[0]!.coordinationOnly.some((c) => c.reason.includes("no accept"))).toBe(true);
  });
});

describe("V4: the paper rail keeps folding a refund frame on its own", () => {
  it("a paper leg A with a refund frame and no chain observation is still refunded-a", () => {
    const one = paperPair("aa01");
    const offers = one.offerRecords(1, 0);
    const roomA = dealRoom(one.legAAccept.contract);
    const refund = record(
      roomA,
      2,
      T0 + 61 * MIN,
      buyer,
      encodeFrame({ type: "refund", from: buyer.did, contract: one.legAAccept.contract, ref: one.legAAccept.contract }),
    );
    const view = foldSwap({ legA: [offers[0]!, offers[1]!, one.dealRooms.get(roomA)![0]!, refund], legB: [], nowMs: T0 + 62 * MIN });
    expect(view.status).toBe("refunded-a");
    expect(view.reasons.some((r) => r.includes("not corroborated by chain evidence"))).toBe(false);
  });
});
