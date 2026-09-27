// SPDX-License-Identifier: MIT
//
// Composite swap fold (SPEC §4): pairs the independent tclk/1 folds of two legs into one
// `SwapView`. Pure and fail-closed — this never throws on data; anything it cannot make
// sense of becomes a status plus a reason, never an exception. All rail-observation and
// clock inputs are supplied by the caller (`SwapFoldInput.evidence`, `.nowMs`); nothing
// here reads a clock or a network.
// Design: flop-contrib/SPEC-ATOMIC-SWAP-DESK.md (draft 0.1, 2026-09-18), §4.

import {
  foldTranscript,
  lockTerms,
  type AcceptFrame,
  type LockTerms,
  type OfferFrame,
  type TranscriptFoldResult,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { PAPER_RAIL_ID } from "./paper-evidence.js";
import { checkOrientation, classifySwapOffer } from "./profile.js";
import type { LockEvidence, RailObservation, SettlementView, SwapFoldInput, SwapView } from "./types.js";

/** Pushed once, on every status (including `settled`), when either leg's lock evidence
 *  came from tclk's `paper` rail — a rehearsal record, never a payment (see
 *  vendor/tclk/src/paper-rail.ts's own warning). */
export const PAPER_REHEARSAL_REASON = "paper rail: rehearsal only, no value";

/**
 * The full nine-field `LockTerms` an accepted offer/accept pair commits to, computed the
 * same way tclk's own `lockTerms(state)` would once the contract is accepted
 * (`vendor/tclk/src/machine.ts`'s role-based payer/payee assignment: the offerer is payer
 * when `offer.role === "payer"`, else the acceptor is). Reproduced here (rather than
 * requiring a full fold) because a caller that has only the authenticated offer/accept pair
 * — `src/replay.ts`'s candidate discovery, before any leg is folded — already has everything
 * this needs and nothing else.
 */
export function offerAcceptLockTerms(offer: OfferFrame, accept: AcceptFrame): LockTerms {
  const offerIsPayer = offer.role === "payer";
  return {
    contract: accept.contract,
    lock: offer.lock,
    statement: accept.statement,
    amount: offer.amount,
    asset: offer.asset,
    payer: offerIsPayer ? offer.from : accept.from,
    payee: offerIsPayer ? accept.from : offer.from,
    claimByMs: offer.claimByMs,
    refundAfterMs: offer.refundAfterMs,
  };
}

/** tclk#180: `PaperRail.verifyLock` (and a rail's own check in general) may compare fewer
 *  than all nine `LockTerms` fields — this is the full field list, in the order H1-SPEC and
 *  D-03 name them, that the fold itself always checks before a leg counts as locked. */
const LOCK_TERMS_FIELDS: ReadonlyArray<keyof LockTerms> = [
  "contract",
  "lock",
  "statement",
  "amount",
  "asset",
  "payer",
  "payee",
  "claimByMs",
  "refundAfterMs",
];

/** The name of the first `LockTerms` field where `actual` differs from `expected`, or `null`
 *  when all nine match. */
function lockTermsMismatch(expected: LockTerms, actual: LockTerms): keyof LockTerms | null {
  for (const field of LOCK_TERMS_FIELDS) {
    if (expected[field] !== actual[field]) return field;
  }
  return null;
}

interface LockEvaluation {
  corroborated: boolean;
  reason?: string;
}

/**
 * A leg counts as locked only when its evidence's claimed `LockTerms` equal the accepted
 * offer's own terms in all nine fields *and* the rail corroborates the lock (`railVerified
 * === true`) — a rail's own verifyLock is corroboration, never sufficient alone (tclk#180).
 * Absent evidence, or evidence whose terms mismatch, or a rail that says `false`/`null`, all
 * leave the leg uncorroborated; a terms mismatch gets a reason naming the field, everything
 * else falls back to the caller's generic "lock unverified" reason.
 */
function evaluateLock(
  evidence: LockEvidence | undefined,
  expected: LockTerms,
  leg: "A" | "B",
): LockEvaluation {
  if (evidence === undefined) return { corroborated: false };
  const mismatch = lockTermsMismatch(expected, evidence.terms);
  if (mismatch !== null) {
    return {
      corroborated: false,
      reason: `leg ${leg} lock terms differ from the accepted offer: ${mismatch} mismatch`,
    };
  }
  if (evidence.railVerified !== true) return { corroborated: false };
  return { corroborated: true };
}

/** `RailObservation.status` (this repo's internal, paper-rail-shaped vocabulary) to the H3
 *  settlement view (tclk PR #173's vocabulary, pinned above). A `RailObservation` only ever
 *  exists once a rail's record decodes and its terms match the contract's own (see
 *  `paper-evidence.ts`'s `paperEvidence`), so its presence is itself trustworthy rail
 *  evidence — independent of `LockEvidence.railVerified`, which answers a narrower question
 *  ("is it currently locked", tclk#180) than "what do we know about this leg's money".
 */
const RAIL_STATUS_TO_SETTLEMENT_VIEW: Readonly<Record<RailObservation["status"], SettlementView>> = {
  locked: "funded",
  claimed: "claimed",
  refunded: "refunded",
};

/**
 * H3: a leg's settlement view from rail evidence alone, never from tclk frames — a signed
 * `reveal` frame proves the choreography advanced, not that a rail moved anything. `none`
 * when there is nothing to go on at all (no evidence, or evidence whose `railVerified` is
 * `null` — nothing existed to check, e.g. no paper note posted yet); `unverified` when a rail
 * record was found but does not corroborate the expected terms (tclk#180 mismatch, unreadable
 * record, or a claimed record whose secret does not open the statement); otherwise the
 * `RailObservation`'s own status, mapped above.
 */
function settlementViewForLeg(evidence: LockEvidence | undefined, rail: RailObservation | undefined): SettlementView {
  if (rail !== undefined) return RAIL_STATUS_TO_SETTLEMENT_VIEW[rail.status];
  if (evidence === undefined || evidence.railVerified === null) return "none";
  return "unverified";
}

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
    // H3: rail-evidence-only, computed once here so it is set on every return path below,
    // independent of how far (or whether) the frame-derived choreography status advances.
    settlementView: {
      a: settlementViewForLeg(evidence.a, evidence.aRail),
      b: settlementViewForLeg(evidence.b, evidence.bRail),
    },
    // H4: board.ts appends its own entries here too (an accept chosen by export row order),
    // for verdicts this function has no visibility into.
    coordinationOnly: [],
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
    const reason = "lock order violated: A before B";
    reasons.push(reason);
    // H4: this verdict compares two records' unsigned venue `timestampMs` against each
    // other (tclk#175/#93/#96) — the venue's own metadata, not covered by either sender's
    // signature.
    view.coordinationOnly.push({ basis: "coordination-only", reason: `${reason} (depends on unsigned venue ts)` });
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

  if (!bLocked) {
    if (nowMs >= legAOffer.expiresMs) {
      reasons.push("leg B never locked before leg A's offer expired");
      view.status = "abandoned";
      return view;
    }
    view.status = "paired";
    return view;
  }

  // H1 (tclk#180): a leg counts as locked only once its evidence's LockTerms equal the
  // accepted offer's own terms in all nine fields; a rail's own verifyLock (`railVerified`)
  // is corroboration on top of that, never sufficient alone.
  const legBEvaluation = evaluateLock(evidence.b, lockTerms(legBState), "B");
  if (!legBEvaluation.corroborated) {
    reasons.push(legBEvaluation.reason ?? "leg B lock unverified");
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

  const legAEvaluation = evaluateLock(evidence.a, lockTerms(legAState), "A");
  if (!legAEvaluation.corroborated) {
    reasons.push(legAEvaluation.reason ?? "leg A lock unverified");
    view.status = "b-locked";
    return view;
  }

  view.status = "a-locked";
  return view;
}
