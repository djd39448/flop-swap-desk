// SPDX-License-Identifier: MIT
//
// Composite swap fold (SPEC §4): pairs the independent tclk/1 folds of two legs into one
// `SwapView`. Pure and fail-closed — this never throws on data; anything it cannot make
// sense of becomes a status plus a reason, never an exception. All rail-observation and
// clock inputs are supplied by the caller (`SwapFoldInput.evidence`, `.nowMs`); nothing
// here reads a clock or a network.
// Design: flop-contrib/SPEC-ATOMIC-SWAP-DESK.md (draft 0.1, 2026-09-18), §4.

import { foldTranscript, type TranscriptFoldResult, type TranscriptRecord } from "@flop-labs/tclk";

import { PAPER_RAIL_ID } from "./paper-evidence.js";
import { checkOrientation, classifySwapOffer } from "./profile.js";
import type { SwapFoldInput, SwapView } from "./types.js";

/** Pushed once, on every status (including `settled`), when either leg's lock evidence
 *  came from tclk's `paper` rail — a rehearsal record, never a payment (see
 *  vendor/tclk/src/paper-rail.ts's own warning). */
export const PAPER_REHEARSAL_REASON = "paper rail: rehearsal only, no value";

function foldLeg(records: readonly TranscriptRecord[]): TranscriptFoldResult | null {
  return records.length === 0 ? null : foldTranscript(records);
}

/** Carry a leg's rejected-step audit trail into the swap-level reasons, per SPEC §4. */
function collectStepReasons(
  fold: TranscriptFoldResult | null,
  leg: "legA" | "legB",
  reasons: string[],
): void {
  if (fold === null) return;
  for (const step of fold.steps) {
    if (!step.ok) reasons.push(`${leg} step ${step.seq}: ${step.reason ?? "rejected"}`);
  }
}

/** The venue timestamp of a leg's first successful `lock` step, or null if it never locked. */
function lockTimestampMs(
  records: readonly TranscriptRecord[],
  fold: TranscriptFoldResult | null,
): number | null {
  if (fold === null) return null;
  const step = fold.steps.find((candidate) => candidate.type === "lock" && candidate.ok);
  if (step === undefined) return null;
  const record = records[step.index];
  return record ? record.timestampMs : null;
}

/** SPEC §3.5 rule 4: the secret holder (Seller, leg B) must lock before the Buyer (leg A). */
function lockOrderViolated(
  legARecords: readonly TranscriptRecord[],
  legAFold: TranscriptFoldResult | null,
  legBRecords: readonly TranscriptRecord[],
  legBFold: TranscriptFoldResult | null,
): boolean {
  const aLockMs = lockTimestampMs(legARecords, legAFold);
  const bLockMs = lockTimestampMs(legBRecords, legBFold);
  if (aLockMs === null || bLockMs === null) return false;
  return aLockMs < bLockMs;
}

/**
 * Fold two legs' transcripts into one composite swap view. See SPEC §4's state table;
 * the derivation order below (cancel → refund → claim/settle → lock stages → paired →
 * bid/accepted) is this implementation's tie-break where the table leaves slack — see
 * the P0.2 build report for the specific calls made (abandonment windows, refund-from-
 * evidence, and what happens to states the table does not name, such as a leg-B accept
 * without leg-A ever having accepted).
 */
export function foldSwap(input: SwapFoldInput): SwapView {
  const nowMs = input.nowMs;
  const reasons: string[] = [];
  const evidence = input.evidence ?? {};

  const legAFold = foldLeg(input.legA);
  const legBFold = foldLeg(input.legB);
  collectStepReasons(legAFold, "legA", reasons);
  collectStepReasons(legBFold, "legB", reasons);

  if (evidence.a?.rail === PAPER_RAIL_ID || evidence.b?.rail === PAPER_RAIL_ID) {
    reasons.push(PAPER_REHEARSAL_REASON);
  }

  const view: SwapView = {
    swapId: null,
    status: "unpaired",
    legAOfferId: null,
    legBOfferId: null,
    buyerDid: null,
    sellerDid: null,
    feeBps: null,
    legA: legAFold,
    legB: legBFold,
    evidence,
    reasons,
  };

  const legAState = legAFold?.state ?? null;
  if (legAState === null) {
    reasons.push("leg A did not fold to an open contract");
    return view;
  }

  const legAOffer = legAState.offer;
  view.legAOfferId = legAOffer.id;

  const legAClass = classifySwapOffer(legAOffer);
  if (legAClass === null) {
    reasons.push("leg A offer is not a swap leg");
    return view;
  }
  if (legAClass.context.leg !== "a") {
    reasons.push("leg A offer carries a leg-b context");
    return view;
  }
  view.swapId = legAClass.swapId;
  view.feeBps = legAClass.context.feeBps;

  const legAOrientation = checkOrientation(legAOffer, legAClass.context);
  if (!legAOrientation.ok) {
    reasons.push(legAOrientation.reason);
    view.status = "orientation-unsupported";
    return view;
  }
  view.buyerDid = legAOffer.from;

  const legBState = legBFold?.state ?? null;

  if (legBState === null) {
    if (legAState.status === "proposed") {
      view.status = "bid";
      return view;
    }
    if (legAState.status === "accepted") {
      view.sellerDid = legAState.payeeDid ?? null;
      view.status = "accepted";
      return view;
    }
    if (legAState.status === "cancelled") {
      reasons.push("leg A cancelled");
      view.status = "abandoned";
      return view;
    }
    if (legAState.status === "refunded") {
      reasons.push("leg A refunded with no leg B");
      view.status = "refunded-a";
      return view;
    }
    reasons.push("leg A advanced with no leg B present");
    return view;
  }

  const legBOffer = legBState.offer;
  view.legBOfferId = legBOffer.id;

  const legBClass = classifySwapOffer(legBOffer);
  if (legBClass === null) {
    reasons.push("leg B offer is not a swap leg");
    return view;
  }
  if (legBClass.context.leg !== "b") {
    reasons.push("leg B offer carries a leg-a context");
    return view;
  }
  if (legBClass.swapId !== legAClass.swapId) {
    reasons.push("leg B swapId does not match leg A");
    return view;
  }
  if (legBClass.context.legAOfferId !== legAOffer.id) {
    reasons.push("leg B context does not name leg A's offer id");
    return view;
  }

  const legBOrientation = checkOrientation(legBOffer, legBClass.context);
  if (!legBOrientation.ok) {
    reasons.push(legBOrientation.reason);
    view.status = "orientation-unsupported";
    return view;
  }
  view.sellerDid = legBOffer.from;

  if (legAState.status === "proposed") {
    reasons.push("leg B exists before leg A was accepted");
    view.status = legBState.status === "proposed" ? "bid" : "unpaired";
    return view;
  }

  if (legAState.status === "accepted" && legBState.status === "proposed") {
    view.status = "accepted";
    return view;
  }

  if (legBState.status === "proposed") {
    reasons.push("leg B not yet accepted");
    return view;
  }

  // Both legs are accepted or further along: SPEC §3.3's party-crossing and statement
  // checks apply from here.
  if (
    legAState.payerDid === undefined ||
    legAState.payeeDid === undefined ||
    legBState.payerDid === undefined ||
    legBState.payeeDid === undefined
  ) {
    reasons.push("leg missing payer/payee after accept");
    return view;
  }
  if (legAState.payerDid !== legBState.payeeDid || legAState.payeeDid !== legBState.payerDid) {
    reasons.push("leg A/B parties do not cross (buyer/seller mismatch)");
    return view;
  }
  if (legAState.statement !== legBState.statement) {
    reasons.push("leg A/B statements do not match");
    return view;
  }

  view.buyerDid = legAState.payerDid;
  view.sellerDid = legAState.payeeDid;

  if (lockOrderViolated(input.legA, legAFold, input.legB, legBFold)) {
    reasons.push("lock order violated: A before B");
  }

  if (legAState.status === "cancelled" || legBState.status === "cancelled") {
    reasons.push(`leg ${legAState.status === "cancelled" ? "A" : "B"} cancelled`);
    view.status = "abandoned";
    return view;
  }

  const refundedA =
    legAState.status === "refunded" ||
    (evidence.aRail?.status === "refunded" && evidence.aRail.final === true);
  const refundedB =
    legBState.status === "refunded" ||
    (evidence.bRail?.status === "refunded" && evidence.bRail.final === true);
  if (refundedA && refundedB) {
    view.status = "refunded";
    return view;
  }
  if (refundedA) {
    view.status = "refunded-a";
    return view;
  }
  if (refundedB) {
    view.status = "refunded-b";
    return view;
  }

  if (legAState.status === "claimed") {
    if (legAState.secret !== undefined) view.secret = legAState.secret;
    if (legBState.status === "claimed") {
      if (evidence.aRail?.final === true && evidence.bRail?.final === true) {
        view.status = "settled";
        return view;
      }
      reasons.push("awaiting finality");
    }
    view.status = "revealed";
    return view;
  }

  // The Buyer can only reveal on leg B with a secret that opens the shared statement, and
  // tclk's machine verified it. So a leg-B claim without a leg-A reveal frame means the
  // Seller claimed on chain A without posting (or the frame is late): the secret is public
  // either way, which is what "revealed" reports. Fail toward disclosure, not silence.
  if (legBState.status === "claimed") {
    if (legBState.secret !== undefined) view.secret = legBState.secret;
    reasons.push("secret revealed on leg B before leg A's reveal frame");
    view.status = "revealed";
    return view;
  }

  const bLocked = legBState.status === "locked";
  const bLockedVerified = bLocked && evidence.b?.verified === true;

  if (!bLocked) {
    if (nowMs >= legAOffer.expiresMs) {
      reasons.push("leg B never locked before leg A's offer expired");
      view.status = "abandoned";
      return view;
    }
    view.status = "paired";
    return view;
  }

  if (!bLockedVerified) {
    reasons.push("leg B lock unverified");
    view.status = "paired";
    return view;
  }

  // `legAState.status === "claimed"` already handled (and returned) above.
  const aLocked = legAState.status === "locked";
  if (!aLocked) {
    if (nowMs >= legAOffer.claimByMs) {
      reasons.push("leg A never locked before its claim deadline");
      view.status = "abandoned";
      return view;
    }
    view.status = "b-locked";
    return view;
  }

  if (evidence.a?.verified !== true) {
    reasons.push("leg A lock unverified");
    view.status = "b-locked";
    return view;
  }

  view.status = "a-locked";
  return view;
}
