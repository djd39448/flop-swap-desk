// SPDX-License-Identifier: MIT
//
// foldSwap: every SPEC §4 composite state reachable from a fixture, plus the §6 forgeries
// that must be rejected without advancing state, and the evidence semantics the SPEC left
// as caller-supplied slack (lock-without-evidence, verified:false, settlement finality).

import {
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  OFFER_ROOM,
  type LockTerms,
} from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { legAContext, legBContext, swapId as computeSwapId } from "../src/profile.js";
import { foldSwap } from "../src/swap.js";
import { identity, record, unsignedRecord } from "./helpers/identity.js";
import { scenario } from "./helpers/scenario.js";

const T0 = 1_758_000_000_000;
const MIN = 60_000;

const buyer = identity("a1".repeat(32));
const seller = identity("b2".repeat(32));
const stranger = identity("c3".repeat(32));

function build(t0 = T0) {
  return scenario({ buyer, seller, t0 });
}

describe("foldSwap — SPEC §4 states", () => {
  it("bid: leg A offered, nothing else", () => {
    const s = build();
    const view = foldSwap({ legA: [s.records.offerA], legB: [], nowMs: T0 + 1 });
    expect(view.status).toBe("bid");
    expect(view.swapId).toBe(s.swapId);
    expect(view.buyerDid).toBe(buyer.did);
  });

  it("bid: leg A offered, leg B also only offered (neither accepted)", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA],
      legB: [s.records.offerB],
      nowMs: T0 + 2 * MIN + 1,
    });
    expect(view.status).toBe("bid");
  });

  it("accepted: leg A accepted, no leg B yet", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [],
      nowMs: T0 + 2 * MIN,
    });
    expect(view.status).toBe("accepted");
    expect(view.sellerDid).toBe(seller.did);
  });

  it("accepted: leg A accepted, leg B offered but not yet accepted", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB],
      nowMs: T0 + 3 * MIN,
    });
    expect(view.status).toBe("accepted");
  });

  it("paired: both legs accepted, statements and parties cross", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB],
      nowMs: T0 + 4 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.buyerDid).toBe(buyer.did);
    expect(view.sellerDid).toBe(seller.did);
    expect(view.feeBps).toBe(0);
  });

  it("paired: leg A declares feeBps 25 (profile v1.1, SPEC §3.7) — pairs and reports feeBps 25", () => {
    const s = scenario({ buyer, seller, t0: T0, feeBps: 25 });
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB],
      nowMs: T0 + 4 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.feeBps).toBe(25);
  });

  it("paired: a legacy 4-segment leg A context still pairs, reporting feeBps 0", () => {
    const s = scenario({ buyer, seller, t0: T0, legAContextRaw: "a|FLOP|52070000|flop-htlc" });
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB],
      nowMs: T0 + 4 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.feeBps).toBe(0);
  });

  it("paired with a reason when leg B is locked but unverified (evidence absent)", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.reasons).toContain("leg B lock unverified");
  });

  it("paired with a reason when leg B lock evidence is explicitly verified:false", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: {
          rail: "flop-htlc",
          ref: "flop-escrow-1",
          terms: s.legBTerms,
          railVerified: false,
          checkedAtMs: T0 + 5 * MIN,
          reason: "rpc says not found",
        },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.reasons).toContain("leg B lock unverified");
  });

  it("b-locked: leg B locked and verified", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("b-locked");
  });

  it("b-locked with a reason when leg A is locked but unverified", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 6 * MIN,
    });
    expect(view.status).toBe("b-locked");
    expect(view.reasons).toContain("leg A lock unverified");
  });

  it("a-locked: leg A locked and verified, leg B already locked+verified", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        a: { rail: "evm-htlc", ref: "evm-escrow-1", terms: s.legATerms, railVerified: true, checkedAtMs: T0 + 6 * MIN },
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 6 * MIN,
    });
    expect(view.status).toBe("a-locked");
  });

  it("revealed: leg A reveal verifies against the statement", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.revealA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      nowMs: T0 + 7 * MIN,
    });
    expect(view.status).toBe("revealed");
    expect(view.secret).toBe(s.lock.preimage);
  });

  it("revealed when the Buyer's leg B reveal lands before any leg A reveal frame", () => {
    // The Seller claimed on chain A without posting its reveal frame; the Buyer learned the
    // secret from the chain and revealed on leg B. tclk verified that secret against the
    // shared statement, so it is public: report `revealed`, never a stale `paired`.
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.revealB],
      evidence: { b: { rail: "flop-htlc", ref: s.frames.lockB.ref, terms: s.legBTerms, railVerified: true, checkedAtMs: T0 } },
      nowMs: T0 + 7 * MIN,
    });
    expect(view.status).toBe("revealed");
    expect(view.secret).toBe(s.lock.preimage);
    expect(view.reasons).toContain("secret revealed on leg B before leg A's reveal frame");
  });

  it("revealed with 'awaiting finality' once both legs have claimed but rails are not final", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.revealA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.revealB],
      nowMs: T0 + 8 * MIN,
    });
    expect(view.status).toBe("revealed");
    expect(view.reasons).toContain("awaiting finality");
  });

  it("K4: a leg whose rail is still 'locked' (final, but never claimed) stays 'revealed', never 'settled'", () => {
    // The reviewer's case: leg A has a reveal frame (so legAState.status is tclk's own
    // "claimed"), leg B likewise has a reveal frame, but leg A's own RAIL observation is still
    // `locked` (final:true — e.g. a Bitcoin funding output sitting at its required confirmation
    // count, simply never yet spent). Before K4, checking `final` alone would fold this straight
    // to `settled`, reporting money moved that the rail never actually observed moving.
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.revealA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.revealB],
      evidence: {
        aRail: { status: "locked", final: true, checkedAtMs: T0 + 9 * MIN },
        bRail: { status: "claimed", final: true, checkedAtMs: T0 + 9 * MIN },
      },
      nowMs: T0 + 9 * MIN,
    });
    expect(view.status).toBe("revealed");
    expect(view.reasons).toContain("awaiting finality");
  });

  it("settled: both legs claimed and both rails report final", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.revealA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.revealB],
      evidence: {
        aRail: { status: "claimed", final: true, checkedAtMs: T0 + 9 * MIN },
        bRail: { status: "claimed", final: true, checkedAtMs: T0 + 9 * MIN },
      },
      nowMs: T0 + 9 * MIN,
    });
    expect(view.status).toBe("settled");
  });

  it("settled: a full paper rehearsal (both legs' evidence from the paper rail) still settles, with the rehearsal reason", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.revealA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.revealB],
      evidence: {
        a: { rail: "paper", ref: s.frames.lockA.contract, terms: s.legATerms, railVerified: false, checkedAtMs: T0 + 9 * MIN, reason: "paper record is claimed; paper rail holds no value and a stranger can overwrite it" },
        b: { rail: "paper", ref: s.frames.lockB.contract, terms: s.legBTerms, railVerified: false, checkedAtMs: T0 + 9 * MIN, reason: "paper record is claimed; paper rail holds no value and a stranger can overwrite it" },
        aRail: { status: "claimed", final: true, checkedAtMs: T0 + 9 * MIN },
        bRail: { status: "claimed", final: true, checkedAtMs: T0 + 9 * MIN },
      },
      nowMs: T0 + 9 * MIN,
    });
    expect(view.status).toBe("settled");
    expect(view.reasons).toContain("paper rail: rehearsal only, no value");
  });

  it("refunded-a: leg A refunded via tclk state", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.refundA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      nowMs: s.frames.offerA.refundAfterMs + 2 * MIN,
    });
    expect(view.status).toBe("refunded-a");
  });

  it("refunded-b: leg B refunded via tclk state", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.refundB],
      nowMs: s.frames.offerB.refundAfterMs + 2 * MIN,
    });
    expect(view.status).toBe("refunded-b");
  });

  it("refunded: both legs refunded", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.refundA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.refundB],
      nowMs: s.frames.offerB.refundAfterMs + 2 * MIN,
    });
    expect(view.status).toBe("refunded");
  });

  it("refunded-a from rail evidence alone (no on-chain refund frame observed)", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: { aRail: { status: "refunded", final: true, checkedAtMs: T0 + 61 * MIN } },
      nowMs: T0 + 61 * MIN,
    });
    expect(view.status).toBe("refunded-a");
  });

  // P5-NEAR-FIXES.md E3: a refund frame conflicting with a chain rail's own `claimed`/`locked`
  // observation must never fold to refunded-a/refunded-b/refunded — only that leg's own rail
  // (when one is watching) decides, and the frame's disagreement is reported, not trusted.
  it("E3: leg A's refund frame conflicts with its own chain evidence (claimed) — falls through to refunded-b, not refunded", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.refundA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB, s.records.refundB],
      evidence: { aRail: { status: "claimed", final: true, checkedAtMs: T0 + 61 * MIN } },
      nowMs: s.frames.offerB.refundAfterMs + 2 * MIN,
    });
    // Leg A's own frame says refunded but its own chain rail says claimed+final — never trusted
    // on the frame's say alone; leg B has no rail evidence at all, so its own frunded frame
    // still folds the old (unaffected) way.
    expect(view.status).toBe("refunded-b");
    expect(view.status).not.toBe("refunded");
    expect(view.reasons.some((r) => r.includes("leg A refund frame conflicts with its own chain evidence"))).toBe(true);
  });

  it("E3: leg A's refund frame conflicts with its own chain evidence (locked) with no leg B — never folds to refunded-a", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, s.records.refundA],
      legB: [],
      evidence: { aRail: { status: "locked", final: true, checkedAtMs: T0 + 61 * MIN } },
      nowMs: s.frames.offerA.refundAfterMs + 2 * MIN,
    });
    expect(view.status).not.toBe("refunded-a");
    expect(view.reasons.some((r) => r.includes("leg A refund frame conflicts with its own chain evidence"))).toBe(true);
    expect(view.reasons).toContain("leg A advanced with no leg B present");
  });

  // A rail's own refunded+final observation is still sufficient entirely on its own (no frame
  // at all needed) — E3 only tightens the case where a frame DISAGREES with the rail, it never
  // weakens the "rail evidence alone" case tested just above.
  it("E3: a rail's own refunded+final observation still folds to refunded-a with no refund frame at all", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: { aRail: { status: "refunded", final: true, checkedAtMs: T0 + 61 * MIN } },
      nowMs: T0 + 61 * MIN,
    });
    expect(view.status).toBe("refunded-a");
    expect(view.reasons.some((r) => r.includes("conflicts"))).toBe(false);
  });

  it("abandoned: paired but leg B never locked before leg A's offer expired", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB],
      nowMs: s.frames.offerA.expiresMs + 1_000,
    });
    expect(view.status).toBe("abandoned");
  });

  it("abandoned: b-locked but leg A never locked before its claim deadline", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: s.frames.offerA.claimByMs + 1_000,
    });
    expect(view.status).toBe("abandoned");
  });

  it("abandoned: either leg cancelled", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.cancelA],
      legB: [s.records.offerB, s.records.acceptB],
      nowMs: T0 + 4 * MIN,
    });
    expect(view.status).toBe("abandoned");
  });

  it("abandoned: leg A cancelled with no leg B ever offered", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.cancelA],
      legB: [],
      nowMs: T0 + 4 * MIN,
    });
    expect(view.status).toBe("abandoned");
  });

  it("flags but does not block a lock-order violation (leg A locked before leg B)", () => {
    const s = build();
    const earlyLockA = record(s.dealRoomA, 1, T0 + 3 * MIN + 30_000, buyer, encodeFrame(s.frames.lockA));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, earlyLockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 4 * MIN },
      },
      nowMs: T0 + 6 * MIN,
    });
    expect(view.reasons).toContain("lock order violated: A before B");
    expect(view.status).toBe("b-locked");
    // H4 (tclk#175): this verdict compares two records' unsigned venue timestamps.
    expect(view.coordinationOnly).toContainEqual({
      basis: "coordination-only",
      reason: "lock order violated: A before B (depends on unsigned venue ts)",
    });
  });

  it("no coordination-only flags on the ordinary happy path (no lock-order issue)", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        a: { rail: "evm-htlc", ref: "evm-escrow-1", terms: s.legATerms, railVerified: true, checkedAtMs: T0 + 6 * MIN },
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 6 * MIN,
    });
    expect(view.status).toBe("a-locked");
    expect(view.coordinationOnly).toEqual([]);
  });
});

describe("foldSwap — nine-field lock check (tclk#180)", () => {
  // tclk#180: PaperRail.verifyLock (and a rail's own check in general) compares only
  // status/lock/statement/refundAfterMs — four of the nine LockTerms fields. The fold must
  // never rely on a rail's `railVerified` alone: it independently checks all nine fields on
  // the evidence's own `terms` against the accepted offer's terms before a leg counts as
  // locked, and names the mismatched field when they differ.
  const s = build();

  const fieldMismatches: Array<{ field: keyof LockTerms; corrupt: (terms: LockTerms) => LockTerms }> = [
    { field: "contract", corrupt: (t) => ({ ...t, contract: `0x${"99".repeat(32)}` }) },
    { field: "lock", corrupt: (t) => ({ ...t, lock: t.lock === "hash" ? "point" : "hash" }) },
    { field: "statement", corrupt: (t) => ({ ...t, statement: `0x${"88".repeat(32)}` }) },
    { field: "amount", corrupt: (t) => ({ ...t, amount: "1" }) },
    { field: "asset", corrupt: (t) => ({ ...t, asset: "WRONG-ASSET" }) },
    { field: "payer", corrupt: (t) => ({ ...t, payer: stranger.did }) },
    { field: "payee", corrupt: (t) => ({ ...t, payee: stranger.did }) },
    { field: "claimByMs", corrupt: (t) => ({ ...t, claimByMs: t.claimByMs + 1 }) },
    { field: "refundAfterMs", corrupt: (t) => ({ ...t, refundAfterMs: t.refundAfterMs + 1 }) },
  ];

  it.each(fieldMismatches)(
    "leg B stays unlocked (not b-locked) when evidence.terms.$field differs from the accepted offer",
    ({ field, corrupt }) => {
      const view = foldSwap({
        legA: [s.records.offerA, s.records.acceptA],
        legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
        evidence: {
          b: {
            rail: "flop-htlc",
            ref: "flop-escrow-1",
            terms: corrupt(s.legBTerms),
            railVerified: true,
            checkedAtMs: T0 + 5 * MIN,
          },
        },
        nowMs: T0 + 5 * MIN,
      });
      expect(view.status).toBe("paired");
      expect(view.reasons.some((r) => r.includes(`${field} mismatch`))).toBe(true);
    },
  );

  it("leg A stays unlocked (b-locked, not a-locked) when its evidence terms differ from the accepted offer", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        a: {
          rail: "evm-htlc",
          ref: "evm-escrow-1",
          terms: { ...s.legATerms, amount: "1" },
          railVerified: true,
          checkedAtMs: T0 + 6 * MIN,
        },
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 6 * MIN,
    });
    expect(view.status).toBe("b-locked");
    expect(view.reasons.some((r) => r.includes("leg A lock terms differ from the accepted offer: amount mismatch"))).toBe(
      true,
    );
  });

  it("a rail's railVerified:true is not sufficient alone when terms otherwise match but the field check would matter", () => {
    // Same terms as the accepted offer (all nine fields correct) and railVerified:true:
    // corroborated, reaches b-locked. This is the control for the mismatch cases above.
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("b-locked");
  });

  it("leg B stays unlocked when the rail's own railVerified is false even though terms match exactly", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: false, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.reasons).toContain("leg B lock unverified");
  });

  it("leg B stays unlocked when the rail's own railVerified is null (no evidence to check) even with correct terms", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: null, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("paired");
    expect(view.reasons).toContain("leg B lock unverified");
  });
});

describe("foldSwap — settlementView (H3, tclk PR #173 vocabulary)", () => {
  // Rail evidence only, never tclk frames: computed once and present on every status,
  // including the earliest ones, where no lock has even been attempted yet.
  const s = build();

  it("both legs 'none' with no evidence at all, even at 'bid'", () => {
    const view = foldSwap({ legA: [s.records.offerA], legB: [], nowMs: T0 + 1 });
    expect(view.status).toBe("bid");
    expect(view.settlementView).toEqual({ a: "none", b: "none" });
  });

  it("'none' when the evidence's own railVerified is null (nothing to check, e.g. no paper note yet)", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB],
      evidence: {
        b: { rail: "paper", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: null, checkedAtMs: T0 },
      },
      nowMs: T0 + 4 * MIN,
    });
    expect(view.settlementView.b).toBe("none");
  });

  it("'unverified' when a rail record was found but its terms mismatch (tclk#180) — no RailObservation", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB],
      evidence: {
        b: { rail: "paper", ref: "flop-escrow-1", terms: { ...s.legBTerms, amount: "1" }, railVerified: true, checkedAtMs: T0 },
      },
      nowMs: T0 + 4 * MIN,
    });
    // railVerified:true is what the rail itself claims; the terms mismatch overrides it —
    // evaluateLock treats the leg as uncorroborated either way, and there is still no
    // RailObservation for settlementView to read a status from.
    expect(view.settlementView.b).toBe("unverified");
  });

  it("'funded' when the RailObservation reports 'locked'", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "paper", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 },
        bRail: { status: "locked", final: true, checkedAtMs: T0 },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.settlementView.b).toBe("funded");
  });

  it("'claimed' when the RailObservation reports 'claimed', independent of frame-derived status", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        bRail: { status: "claimed", final: true, checkedAtMs: T0 },
      },
      nowMs: T0 + 5 * MIN,
    });
    // Leg B's tclk frames never reveal here (no reveal frame at all) -- the frame-derived
    // composite status cannot be "settled"/"revealed" from this alone, yet the rail already
    // says claimed: proof settlementView never reads frames, only rail evidence.
    expect(view.status).not.toBe("revealed");
    expect(view.status).not.toBe("settled");
    expect(view.settlementView.b).toBe("claimed");
  });

  it("'refunded' when the RailObservation reports 'refunded'", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        bRail: { status: "refunded", final: true, checkedAtMs: T0 },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.settlementView.b).toBe("refunded");
  });

  it("each leg's settlementView is independent (A funded, B none)", () => {
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB, s.records.acceptB],
      evidence: {
        aRail: { status: "locked", final: true, checkedAtMs: T0 },
      },
      nowMs: T0 + 5 * MIN,
    });
    expect(view.settlementView).toEqual({ a: "funded", b: "none" });
  });
});

describe("foldSwap — unpaired (≥4 distinct causes)", () => {
  it("unpaired when leg A has no records at all", () => {
    const view = foldSwap({ legA: [], legB: [], nowMs: T0 });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg A did not fold to an open contract");
  });

  it("unpaired when leg A offer does not carry a swap job", () => {
    const plain = makeOffer({
      from: buyer.did,
      role: "payer",
      amount: "10",
      asset: "USDC",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: T0 + 1_000,
      refundAfterMs: T0 + 2_000,
      expiresMs: T0 + 900,
      nonce: "ffffffffffffffff",
    });
    const rec = record(OFFER_ROOM, 1, T0, buyer, encodeFrame(plain));
    const view = foldSwap({ legA: [rec], legB: [], nowMs: T0 + 1 });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg A offer is not a swap leg");
  });

  it("unpaired when the leg-A slot holds a leg-B-context offer", () => {
    const s = build();
    const view = foldSwap({ legA: [s.records.offerB], legB: [], nowMs: T0 + 2 * MIN + 1 });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg A offer carries a leg-b context");
  });

  it("unpaired when leg B's swapId differs from leg A's", () => {
    const s = build();
    const otherSwapId = computeSwapId(buyer.did, "fedcba9876543210");
    const wrongOfferB = makeOffer({
      from: seller.did,
      role: "payer",
      amount: "52070000",
      asset: "FLOP",
      lock: "hash",
      rails: ["flop-htlc"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: otherSwapId, context: legBContext(s.frames.offerA.id) },
      nonce: "b088b088b088b088",
    });
    const rec = record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(wrongOfferB));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [rec],
      nowMs: T0 + 3 * MIN,
    });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg B swapId does not match leg A");
  });

  it("unpaired when leg B references a leg A offer id that isn't leg A's", () => {
    const s = build();
    const wrongOfferB = makeOffer({
      from: seller.did,
      role: "payer",
      amount: "52070000",
      asset: "FLOP",
      lock: "hash",
      rails: ["flop-htlc"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: s.swapId, context: legBContext(`0x${"22".repeat(32)}`) },
      nonce: "b099b099b099b099",
    });
    const rec = record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(wrongOfferB));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [rec],
      nowMs: T0 + 3 * MIN,
    });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg B context does not name leg A's offer id");
  });

  it("unpaired when leg B is accepted by someone other than the buyer", () => {
    const s = build();
    const badAcceptB = makeAccept(s.frames.offerB, {
      from: stranger.did,
      statement: s.lock.hash,
      nonce: "b077b077b077b077",
    });
    const rec = record(OFFER_ROOM, 4, T0 + 3 * MIN, stranger, encodeFrame(badAcceptB));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, rec],
      nowMs: T0 + 4 * MIN,
    });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg A/B parties do not cross (buyer/seller mismatch)");
  });

  it("unpaired when leg B's accept carries a different statement than leg A's", () => {
    const s = build();
    const otherLock = generateHashLock();
    const badAcceptB = makeAccept(s.frames.offerB, {
      from: buyer.did,
      statement: otherLock.hash,
      nonce: "b066b066b066b066",
    });
    const rec = record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(badAcceptB));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, rec],
      nowMs: T0 + 4 * MIN,
    });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg A/B statements do not match");
  });

  it("unpaired when leg A is locked but leg B was never accepted", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA],
      legB: [s.records.offerB],
      nowMs: T0 + 5 * MIN,
    });
    expect(view.status).toBe("unpaired");
    expect(view.reasons).toContain("leg B not yet accepted");
  });
});

describe("foldSwap — orientation-unsupported (≥3 distinct causes)", () => {
  it("rejects a leg A offer opened by the seller as payee", () => {
    const id = computeSwapId(buyer.did, "1111111111111111");
    const offer = makeOffer({
      from: seller.did,
      role: "payee",
      amount: "1000",
      asset: "USDC",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: T0 + 45 * MIN,
      refundAfterMs: T0 + 60 * MIN,
      expiresMs: T0 + 30 * MIN,
      job: {
        proto: "swap",
        id,
        context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }),
      },
      nonce: "a111a111a111a111",
    });
    const rec = record(OFFER_ROOM, 1, T0, seller, encodeFrame(offer));
    const view = foldSwap({ legA: [rec], legB: [], nowMs: T0 + 1 });
    expect(view.status).toBe("orientation-unsupported");
  });

  it("rejects a leg A offer that itself settles in FLOP", () => {
    const id = computeSwapId(buyer.did, "2222222222222222");
    const offer = makeOffer({
      from: buyer.did,
      role: "payer",
      amount: "1000",
      asset: "FLOP",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: T0 + 45 * MIN,
      refundAfterMs: T0 + 60 * MIN,
      expiresMs: T0 + 30 * MIN,
      job: {
        proto: "swap",
        id,
        context: legAContext({ wantAsset: "FLOP", wantAmount: "1", wantRail: "flop-htlc" }),
      },
      nonce: "a222a222a222a222",
    });
    const rec = record(OFFER_ROOM, 1, T0, buyer, encodeFrame(offer));
    const view = foldSwap({ legA: [rec], legB: [], nowMs: T0 + 1 });
    expect(view.status).toBe("orientation-unsupported");
  });

  it("rejects a leg B offer that pays the wrong asset", () => {
    const s = build();
    const offer = makeOffer({
      from: seller.did,
      role: "payer",
      amount: "1000",
      asset: "USDT",
      lock: "hash",
      rails: ["flop-htlc"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: s.swapId, context: legBContext(s.frames.offerA.id) },
      nonce: "b111b111b111b111",
    });
    const rec = record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(offer));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [rec],
      nowMs: T0 + 3 * MIN,
    });
    expect(view.status).toBe("orientation-unsupported");
  });

  it("rejects a leg B offer missing the flop-htlc rail", () => {
    const s = build();
    const offer = makeOffer({
      from: seller.did,
      role: "payer",
      amount: "52070000",
      asset: "FLOP",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: s.swapId, context: legBContext(s.frames.offerA.id) },
      nonce: "b222b222b222b222",
    });
    const rec = record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(offer));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [rec],
      nowMs: T0 + 3 * MIN,
    });
    expect(view.status).toBe("orientation-unsupported");
  });
});

describe("foldSwap — SPEC §6 forgeries are rejected without advancing state", () => {
  it("rejects an unsigned offer record", () => {
    const s = build();
    const unsigned = unsignedRecord(OFFER_ROOM, 1, T0, s.records.offerA.line);
    const view = foldSwap({ legA: [unsigned], legB: [], nowMs: T0 + 1 });
    expect(view.status).toBe("unpaired");
    expect(view.reasons.some((r) => r.includes("record is unsigned"))).toBe(true);
  });

  it("rejects a frame whose `from` does not match the record's actual signer", () => {
    const s = build();
    const forged = record(OFFER_ROOM, 1, T0, stranger, s.records.offerA.line);
    const view = foldSwap({ legA: [forged], legB: [], nowMs: T0 + 1 });
    expect(view.status).toBe("unpaired");
    expect(view.reasons.some((r) => r.includes("does not match the record sender"))).toBe(true);
  });

  it("rejects a lock frame posted outside the contract's derived deal room", () => {
    const s = build();
    const wrongRoomLock = record("lobby", 1, T0 + 5 * MIN, buyer, encodeFrame(s.frames.lockA));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, wrongRoomLock],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      nowMs: T0 + 5 * MIN + 1,
    });
    expect(view.status).toBe("paired");
    expect(view.reasons.some((r) => r.includes("derived deal room"))).toBe(true);
  });

  it("rejects a lock claimed by a stranger DID rather than the leg's payer", () => {
    const s = build();
    const forgedLock = {
      type: "lock" as const,
      from: stranger.did,
      contract: s.frames.acceptB.contract,
      rail: "flop-htlc",
      ref: "flop-escrow-evil",
    };
    const rec = record(s.dealRoomB, 1, T0 + 4 * MIN, stranger, encodeFrame(forgedLock));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA],
      legB: [s.records.offerB, s.records.acceptB, rec],
      nowMs: T0 + 4 * MIN + 1,
    });
    expect(view.status).toBe("paired");
    expect(view.reasons.some((r) => r.includes("only the payer locks"))).toBe(true);
  });

  it("rejects a reveal with a wrong secret without reaching revealed", () => {
    const s = build();
    const wrongReveal = {
      type: "reveal" as const,
      from: seller.did,
      contract: s.frames.acceptA.contract,
      ref: "evm-escrow-1",
      secret: `0x${"11".repeat(32)}`,
    };
    const wrongRevealRecord = record(s.dealRoomA, 2, T0 + 6 * MIN, seller, encodeFrame(wrongReveal));
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.lockA, wrongRevealRecord],
      legB: [s.records.offerB, s.records.acceptB, s.records.lockB],
      evidence: {
        b: { rail: "flop-htlc", ref: "flop-escrow-1", terms: s.legBTerms, railVerified: true, checkedAtMs: T0 + 5 * MIN },
      },
      nowMs: T0 + 6 * MIN,
    });
    expect(view.status).not.toBe("revealed");
    expect(view.reasons.some((r) => r.includes("secret does not open the statement"))).toBe(true);
  });

  it("does not double-apply a replayed accept frame", () => {
    const s = build();
    const view = foldSwap({
      legA: [s.records.offerA, s.records.acceptA, s.records.acceptA],
      legB: [],
      nowMs: T0 + 2 * MIN,
    });
    expect(view.status).toBe("accepted");
    expect(view.reasons.some((r) => r.includes("accept in status accepted"))).toBe(true);
  });
});
