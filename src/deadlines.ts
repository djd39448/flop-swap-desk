// SPDX-License-Identifier: MIT
//
// SPEC §3.5 deadline discipline: the arithmetic that makes the swap profile atomic.
// Rules 1-3 below are checked by `checkSwapDeadlines`; rule 4 (lock order: B before A) is
// the fold's job (`pair.ts`), not this module's, because it depends on which `lock` frames
// were actually observed, not on the offers' declared deadlines.
//
// `timelockSymmetryMinimumBlocks` reproduces yellow paper v0.5.0 R10.2
// (`docs/flop-yellowpaper-v0.5.0.md` ~L758-770):
//
//   T_FLOP >= T_other + max(ceil(T_other * p / 100), max_finality_stall + current_finality_lag)
//
// and is cross-checked in tests against the independently verified golden values for
// `flop-labs/tclk#171`'s `timelockSymmetryMinimum` (bdunn77, 2026-09-18). This module does not
// import that PR's code (it is unmerged and only readable from a local scratchpad); it is a
// clean-room implementation from the yellow paper text, and the tests assert the same golden
// values as evidence the two agree.
//
// Fail-closed throughout: `checkSwapDeadlines` never throws — a malformed operand anywhere
// (a leg, `lockTimeMs`, or a policy field) becomes a violation string and `ok: false`. The two
// arithmetic helpers below DO throw on bad operands (documented per-function); the composite
// checker treats every call into them as a trust boundary and wraps it.

import type { OfferFrame } from "@flop-labs/tclk";
import type { DeadlineCheck, DeadlinePolicy } from "./types.js";

/**
 * The worked example in SPEC §3.5: minRevealWindowMs 30 min, finalityAMs 10 min, R10.2
 * `p` = 20, `max_finality_stall` = 3_600 FLOP blocks (as `flop-labs/tclk#171` uses), no
 * observed finality lag, 1 s FLOP blocks (yellow paper §2). Exported under this explicit
 * name — there is no silent default, the same rule `validateDeadlines` and
 * `FLOP_HTLC_PARAMS_V050` both state for their own knobs.
 */
export const DEFAULT_POLICY_EXAMPLE: DeadlinePolicy = Object.freeze({
  minRevealWindowMs: 30 * 60 * 1000,
  finalityAMs: 10 * 60 * 1000,
  flopMarginPercent: 20,
  flopMaxFinalityStallBlocks: 3_600,
  flopFinalityLagBlocks: 0,
  flopBlockMs: 1_000,
});

/** True iff `v` is a number, finite, integer-valued and safe (matches tclk's own `requireMs` style). */
function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

/**
 * R10.2 solved for the smallest admissible FLOP timelock, in blocks:
 * `T_other + max(ceil(T_other * p / 100), max_finality_stall + current_finality_lag)`.
 * Pure; throws on any operand that is not a safe non-negative integer, so a malformed
 * clock or a negative block count can never quietly widen (or narrow) the requirement.
 */
export function timelockSymmetryMinimumBlocks(
  tOtherBlocks: number,
  marginPercent: number,
  maxFinalityStallBlocks: number,
  finalityLagBlocks: number,
): number {
  if (!isSafeInt(tOtherBlocks) || tOtherBlocks < 0) {
    throw new Error(`deadlines: tOtherBlocks must be a non-negative safe integer, got ${describe(tOtherBlocks)}`);
  }
  if (!isSafeInt(marginPercent) || marginPercent < 0) {
    throw new Error(`deadlines: marginPercent must be a non-negative safe integer, got ${describe(marginPercent)}`);
  }
  if (!isSafeInt(maxFinalityStallBlocks) || maxFinalityStallBlocks < 0) {
    throw new Error(
      `deadlines: maxFinalityStallBlocks must be a non-negative safe integer, got ${describe(maxFinalityStallBlocks)}`,
    );
  }
  if (!isSafeInt(finalityLagBlocks) || finalityLagBlocks < 0) {
    throw new Error(
      `deadlines: finalityLagBlocks must be a non-negative safe integer, got ${describe(finalityLagBlocks)}`,
    );
  }
  const percentMargin = Math.ceil((tOtherBlocks * marginPercent) / 100);
  const finalityMargin = maxFinalityStallBlocks + finalityLagBlocks;
  return tOtherBlocks + Math.max(percentMargin, finalityMargin);
}

/**
 * Blocks from wall-clock `fromMs` until `toMs` at `blockMs` per block, rounded up (may be
 * zero or negative — a deadline already in the past from `fromMs`'s point of view is a
 * caller concern, not this function's). Pure; throws on any operand that is not a safe
 * integer, or a non-positive `blockMs`.
 */
export function blocksBetween(fromMs: number, toMs: number, blockMs: number): number {
  if (!isSafeInt(fromMs)) {
    throw new Error(`deadlines: fromMs must be a safe integer, got ${describe(fromMs)}`);
  }
  if (!isSafeInt(toMs)) {
    throw new Error(`deadlines: toMs must be a safe integer, got ${describe(toMs)}`);
  }
  if (!isSafeInt(blockMs) || blockMs <= 0) {
    throw new Error(`deadlines: blockMs must be a positive safe integer, got ${describe(blockMs)}`);
  }
  return Math.ceil((toMs - fromMs) / blockMs);
}

function describe(v: unknown): string {
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (typeof v === "number" && !Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  return String(v);
}

/** A positive (> 0) safe integer — what every deadline field and `lockTimeMs` must be. */
function isPositiveSafeInt(v: unknown): v is number {
  return isSafeInt(v) && v > 0;
}

/** A non-negative (>= 0) safe integer — what every policy margin/lag field must be. */
function isNonNegativeSafeInt(v: unknown): v is number {
  return isSafeInt(v) && v >= 0;
}

/**
 * tclk's own per-leg invariants (SPEC.md §3.1: `claimByMs < refundAfterMs` strictly; every
 * deadline a positive safe-integer unix-ms). Appends violations for `label` (`"legA"` /
 * `"legB"`) and returns whether the leg was well-formed enough to use in rules 1-3.
 */
function checkLegInvariants(label: string, leg: OfferFrame, violations: string[]): boolean {
  if (leg === null || leg === undefined || typeof leg !== "object") {
    violations.push(`${label}: offer must be an object, got ${describe(leg)}`);
    return false;
  }
  let ok = true;
  if (!isPositiveSafeInt(leg.claimByMs)) {
    violations.push(`${label}.claimByMs must be a positive safe integer, got ${describe(leg.claimByMs)}`);
    ok = false;
  }
  if (!isPositiveSafeInt(leg.refundAfterMs)) {
    violations.push(`${label}.refundAfterMs must be a positive safe integer, got ${describe(leg.refundAfterMs)}`);
    ok = false;
  }
  if (!isPositiveSafeInt(leg.expiresMs)) {
    violations.push(`${label}.expiresMs must be a positive safe integer, got ${describe(leg.expiresMs)}`);
    ok = false;
  }
  if (ok && !(leg.claimByMs < leg.refundAfterMs)) {
    violations.push(
      `${label}: claimByMs ${leg.claimByMs} must be strictly before refundAfterMs ${leg.refundAfterMs}`,
    );
    ok = false;
  }
  return ok;
}

const POLICY_FIELDS: ReadonlyArray<{
  key: keyof DeadlinePolicy;
  predicate: (v: unknown) => v is number;
  kind: "positive" | "non-negative";
}> = [
  { key: "minRevealWindowMs", predicate: isNonNegativeSafeInt, kind: "non-negative" },
  { key: "finalityAMs", predicate: isNonNegativeSafeInt, kind: "non-negative" },
  { key: "flopMarginPercent", predicate: isNonNegativeSafeInt, kind: "non-negative" },
  { key: "flopMaxFinalityStallBlocks", predicate: isNonNegativeSafeInt, kind: "non-negative" },
  { key: "flopFinalityLagBlocks", predicate: isNonNegativeSafeInt, kind: "non-negative" },
  { key: "flopBlockMs", predicate: isPositiveSafeInt, kind: "positive" },
];

/** Every field present and numerically sane; appends violations and returns the verdict. */
function checkPolicy(policy: DeadlinePolicy, violations: string[]): boolean {
  if (policy === null || policy === undefined || typeof policy !== "object") {
    violations.push(`policy must be an object, got ${describe(policy)}`);
    return false;
  }
  let ok = true;
  for (const { key, predicate, kind } of POLICY_FIELDS) {
    const value: unknown = policy[key];
    if (!predicate(value)) {
      violations.push(`policy.${key} must be a ${kind} safe integer, got ${describe(value)}`);
      ok = false;
    }
  }
  return ok;
}

/**
 * SPEC §3.5 rules 1-3, fail-closed. `checkSwapDeadlines` never throws: a malformed leg,
 * `lockTimeMs`, or policy field is reported as a violation and `ok: false`, never an
 * exception — the two arithmetic helpers above are wrapped so their throws become
 * violations too. Rule 4 (lock order) is not checked here; it belongs to the fold, which
 * knows what was actually locked and in what order.
 */
export function checkSwapDeadlines(
  legA: OfferFrame,
  legB: OfferFrame,
  lockTimeMs: number,
  policy: DeadlinePolicy,
): DeadlineCheck {
  const violations: string[] = [];

  if (!isPositiveSafeInt(lockTimeMs)) {
    violations.push(`lockTimeMs must be a positive safe integer, got ${describe(lockTimeMs)}`);
  }
  const legAOk = checkLegInvariants("legA", legA, violations);
  const legBOk = checkLegInvariants("legB", legB, violations);
  const policyOk = checkPolicy(policy, violations);

  const unresolved: DeadlineCheck = {
    ok: false,
    violations,
    requiredBRefundAfterMs: NaN,
    requiredBClaimByMs: NaN,
    tOtherBlocks: NaN,
    tFlopBlocks: NaN,
    requiredTFlopBlocks: NaN,
  };

  if (!isPositiveSafeInt(lockTimeMs) || !legAOk || !legBOk || !policyOk) {
    // Fundamentals broken: rules 1-3 need every one of these to do arithmetic on. Bail
    // out with what we already know, rather than guess at partial results.
    return unresolved;
  }

  // From here every operand rules 1-3 touch is a validated positive safe integer.
  const requiredBClaimByMs = legA.refundAfterMs + policy.finalityAMs;

  // Rule 1: the Seller's real reveal window on chain A after lock A.
  const revealWindowMs = legA.refundAfterMs - lockTimeMs;
  if (revealWindowMs < policy.minRevealWindowMs) {
    violations.push(
      `rule 1: reveal window ${revealWindowMs} ms (legA.refundAfterMs ${legA.refundAfterMs} - ` +
        `lockTimeMs ${lockTimeMs}) < required minRevealWindowMs ${policy.minRevealWindowMs} ms`,
    );
  }

  // Rule 2: the Buyer must still be able to redeem FLOP after the latest Seller reveal
  // plus chain A's finality/observation lag.
  if (legB.claimByMs < requiredBClaimByMs) {
    violations.push(
      `rule 2: legB.claimByMs ${legB.claimByMs} < required ${requiredBClaimByMs} ms ` +
        `(legA.refundAfterMs ${legA.refundAfterMs} + finalityAMs ${policy.finalityAMs})`,
    );
  }

  // Rule 3: R10.2 timelock symmetry, in FLOP blocks from lockTimeMs.
  let tOtherBlocks = NaN;
  let tFlopBlocks = NaN;
  let requiredTFlopBlocks = NaN;
  let requiredBRefundAfterMs = NaN;
  try {
    tOtherBlocks = blocksBetween(lockTimeMs, legA.refundAfterMs, policy.flopBlockMs);
    tFlopBlocks = blocksBetween(lockTimeMs, legB.refundAfterMs, policy.flopBlockMs);
    requiredTFlopBlocks = timelockSymmetryMinimumBlocks(
      tOtherBlocks,
      policy.flopMarginPercent,
      policy.flopMaxFinalityStallBlocks,
      policy.flopFinalityLagBlocks,
    );
    requiredBRefundAfterMs = lockTimeMs + requiredTFlopBlocks * policy.flopBlockMs;
    if (tFlopBlocks < requiredTFlopBlocks) {
      violations.push(
        `rule 3: tFlop ${tFlopBlocks} blocks < required ${requiredTFlopBlocks} blocks ` +
          `(tOther ${tOtherBlocks} blocks, margin ${policy.flopMarginPercent}%, ` +
          `stall ${policy.flopMaxFinalityStallBlocks}, lag ${policy.flopFinalityLagBlocks}; ` +
          `legB.refundAfterMs must be >= ${requiredBRefundAfterMs})`,
      );
    }
  } catch (err) {
    // blocksBetween/timelockSymmetryMinimumBlocks are trust-boundary calls: every operand
    // was validated above, so a throw here would mean a bug in this module, not bad input —
    // still reported as a violation rather than propagated, per the fail-closed contract.
    violations.push(`rule 3: could not evaluate R10.2 (${err instanceof Error ? err.message : String(err)})`);
  }

  return {
    ok: violations.length === 0,
    violations,
    requiredBRefundAfterMs,
    requiredBClaimByMs,
    tOtherBlocks,
    tFlopBlocks,
    requiredTFlopBlocks,
  };
}
