// SPDX-License-Identifier: MIT
//
// Composite swap fold (SPEC §4): pairs the independent tclk/1 folds of two legs into one
// `SwapView`. Pure and fail-closed — this never throws on data; anything it cannot make
// sense of becomes a status plus a reason, never an exception. All rail-observation and
// clock inputs are supplied by the caller (`SwapFoldInput.evidence`, `.nowMs`); nothing
// here reads a clock or a network.
// Design: flop-contrib/SPEC-ATOMIC-SWAP-DESK.md (draft 0.1, 2026-09-18), §4.

import {
  contractId,
  foldTranscript,
  lockTerms,
  type AcceptFrame,
  type ContractState,
  type LockTerms,
  type OfferFrame,
  type TranscriptFoldResult,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { PAPER_RAIL_ID } from "./paper-evidence.js";
import { checkOrientation, classifySwapOffer } from "./profile.js";
import type { LockEvidence, RailObservation, SettlementView, SwapEvidence, SwapFoldInput, SwapView } from "./types.js";

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

/**
 * V5 (P5-NEAR-FIXES-R2, tclk#194 review C3): an accept counts, for pairing, candidate discovery
 * and evidence keys, only when its `contract` is the id tclk derives from THIS offer and the
 * accept's own core, and it was not signed by the offerer. A forged accept naming a real
 * contract id (to displace the genuine candidate or borrow its evidence) fails the first test;
 * a self-accept fails the second.
 */
export function isGenuineAccept(offer: OfferFrame, accept: AcceptFrame): boolean {
  if (accept.ref !== offer.id || accept.from === offer.from) return false;
  try {
    return (
      accept.contract ===
      contractId(offer, {
        from: accept.from,
        ref: accept.ref,
        statement: accept.statement,
        ...(accept.paymentKey === undefined ? {} : { paymentKey: accept.paymentKey }),
        nonce: accept.nonce,
      })
    );
  } catch {
    return false;
  }
}

/** The unique per-pair identifier (tclk#194 finding 2): leg A's offer id plus both legs'
 *  contract ids. `swapId` is a hash of the buyer's DID and a buyer-chosen nonce and is not
 *  unique across pairs. */
export function pairKey(legAOfferId: string, legAContract: string, legBContract: string): string {
  return `${legAOfferId}|${legAContract}|${legBContract}`;
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
  state: ContractState,
): LockEvaluation {
  if (evidence === undefined) return { corroborated: false };
  // tclk#194: the evidence must also be for the rail and ref the contract machine accepted.
  if (evidence.rail !== state.rail || evidence.ref !== state.railRef) {
    return {
      corroborated: false,
      reason: `leg ${leg} lock evidence is for a different rail/ref than the accepted lock frame`,
    };
  }
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

/**
 * tclk#194 finding 1: a `RailObservation` is used only when it is bound to THIS leg's accepted
 * offer/accept pair and accepted lock frame — its rail id, ref and contract equal the lock the
 * tclk machine accepted, and its copy of the nine `LockTerms` equals the leg's own
 * `lockTerms()`. Anything else (missing binding fields, a leg with no accepted lock, any field
 * that differs) is refused: a reason is pushed and the observation is treated as absent, so it
 * can contribute to none of funded / claimed / refunded / settled. Pure; never throws.
 */
function bindObservation(
  leg: "A" | "B",
  state: ContractState | null,
  observation: RailObservation | undefined,
  reasons: string[],
): RailObservation | undefined {
  if (observation === undefined) return undefined;
  const refuse = (why: string): undefined => {
    reasons.push(`leg ${leg} rail observation ignored: ${why}`);
    return undefined;
  };
  const claimed = observation as Partial<RailObservation>;
  if (
    typeof claimed.rail !== "string" ||
    typeof claimed.ref !== "string" ||
    typeof claimed.contract !== "string" ||
    typeof claimed.terms !== "object" ||
    claimed.terms === null
  ) {
    return refuse("it carries no rail/ref/contract/terms binding");
  }
  if (state === null || state.rail === undefined || state.railRef === undefined) {
    return refuse("the leg has no accepted lock frame to bind it to");
  }
  let expected: LockTerms;
  try {
    expected = lockTerms(state);
  } catch {
    return refuse("the leg has no accepted offer/accept pair to bind it to");
  }
  if (claimed.rail !== state.rail) return refuse("rail differs from the accepted lock frame's rail");
  if (claimed.ref !== state.railRef) return refuse("ref differs from the accepted lock frame's ref");
  if (claimed.contract !== expected.contract) return refuse("contract differs from the leg's accepted contract");
  const mismatch = lockTermsMismatch(expected, claimed.terms as LockTerms);
  if (mismatch !== null) return refuse(`terms differ from the accepted offer/accept pair: ${mismatch} mismatch`);
  return observation;
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

/** P5-NEAR-FIXES.md E3 + P5-NEAR-FIXES-R2.md V4: a leg's own `refund` frame never folds a chain
 *  leg to `refunded`/`refunded-a`/`refunded-b` on its own. For a leg whose accepted rail is a chain
 *  rail (anything but `paper`), `refunded` requires a bound rail observation that is `refunded`
 *  and final; a refund frame without one (no observation, or one refused by `bindObservation`)
 *  pushes "refund frame not corroborated by chain evidence" and does not fold. A refund frame
 *  that disagrees with a `claimed` or `locked` observation is a real conflict (a stale client, a
 *  race, or worse) and is reported the same way. The paper rail is a rehearsal with no chain
 *  behind it (`evidence.aRail`/`bRail` stay undefined for it), so it keeps falling back to the
 *  frame alone, unchanged.
 */
function refundedFold(
  legLabel: "A" | "B",
  state: ContractState,
  rail: RailObservation | undefined,
  reasons: string[],
): boolean {
  if (state.status !== "refunded") return rail?.status === "refunded" && rail.final === true;
  if (state.rail === PAPER_RAIL_ID && rail === undefined) return true;
  const railRefunded = rail !== undefined && rail.status === "refunded" && rail.final === true;
  if (!railRefunded) {
    reasons.push(
      rail === undefined
        ? `leg ${legLabel} refund frame not corroborated by chain evidence — not folded to refunded`
        : `leg ${legLabel} refund frame conflicts with its own chain evidence (rail reports "${rail.status}"${rail.final ? "" : ", not final"}) — refund frame not corroborated by chain evidence, not folded to refunded`,
    );
  }
  return railRefunded;
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
  const suppliedEvidence = input.evidence ?? {};

  const legAFold = foldLeg(input.legA);
  const legBFold = foldLeg(input.legB);
  collectStepReasons(legAFold, "legA", reasons);
  collectStepReasons(legBFold, "legB", reasons);

  // tclk#194 finding 1: rail observations are bound to each leg's accepted pair/lock before
  // anything below may read them; a refused one is absent from `evidence` from here on.
  const evidence: SwapEvidence = { ...suppliedEvidence };
  delete evidence.aRail;
  delete evidence.bRail;
  const aRail = bindObservation("A", legAFold?.state ?? null, suppliedEvidence.aRail, reasons);
  const bRail = bindObservation("B", legBFold?.state ?? null, suppliedEvidence.bRail, reasons);
  if (aRail !== undefined) evidence.aRail = aRail;
  if (bRail !== undefined) evidence.bRail = bRail;

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
    pairKey: null,
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
      // E3: same rule as the paired-legs branch below — a refund frame conflicting with leg
      // A's own chain evidence never folds to refunded-a.
      if (refundedFold("A", legAState, evidence.aRail, reasons)) {
        reasons.push("leg A refunded with no leg B");
        view.status = "refunded-a";
        return view;
      }
      reasons.push("leg A advanced with no leg B present");
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
  if (legAState.contract !== undefined && legBState.contract !== undefined) {
    view.pairKey = pairKey(legAOffer.id, legAState.contract, legBState.contract);
  }

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

  // E3: keyed off each leg's own chain rail observation when one exists, never the frame alone.
  const refundedA = refundedFold("A", legAState, evidence.aRail, reasons);
  const refundedB = refundedFold("B", legBState, evidence.bRail, reasons);
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
      // P4-BTC-FIXES-R3.md K4: `settled` means both rail OBSERVATIONS report `claimed` (and
      // final) — not merely `final`. A leg whose rail is still `locked` (a reveal frame posted,
      // but the on-chain claim not yet observed) is final in the trivial sense of "nothing left
      // to wait for at this confirmation count" without ever having been claimed at all; folding
      // that to `settled` would report money moved that the rail never actually saw move.
      if (evidence.aRail?.status === "claimed" && evidence.aRail.final === true && evidence.bRail?.status === "claimed" && evidence.bRail.final === true) {
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
  const legBEvaluation = evaluateLock(evidence.b, lockTerms(legBState), "B", legBState);
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

  const legAEvaluation = evaluateLock(evidence.a, lockTerms(legAState), "A", legAState);
  if (!legAEvaluation.corroborated) {
    reasons.push(legAEvaluation.reason ?? "leg A lock unverified");
    view.status = "b-locked";
    return view;
  }

  view.status = "a-locked";
  return view;
}
