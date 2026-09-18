// SPDX-License-Identifier: MIT
//
// Tests for src/deadlines.ts: the R10.2 arithmetic, the ms->block conversion, and
// SPEC §3.5 rules 1-3 over a real tclk `OfferFrame` pair.

import { describe, expect, it } from "vitest";
import type { OfferFrame } from "@flop-labs/tclk";
import {
  DEFAULT_POLICY_EXAMPLE,
  blocksBetween,
  checkSwapDeadlines,
  timelockSymmetryMinimumBlocks,
} from "../src/deadlines.js";
import type { DeadlinePolicy } from "../src/types.js";
import { buildLegA, buildLegB, buildWorkedExample } from "./helpers/offers.js";

const T0 = 1_735_000_000_000;

/** Malformed operands for a field that must be a positive (> 0) safe integer. */
const MALFORMED: unknown[] = [Number.NaN, -1, 0, 1.5, "1", Number.POSITIVE_INFINITY, undefined];

/** Malformed operands for a field that must be a non-negative (>= 0) safe integer — 0 is valid. */
const MALFORMED_NONNEGATIVE: unknown[] = MALFORMED.filter((v) => v !== 0);

/** Malformed operands for a field with no sign constraint (just "must be a safe integer"). */
const MALFORMED_ANY_INTEGER: unknown[] = MALFORMED.filter((v) => v !== -1 && v !== 0);

describe("timelockSymmetryMinimumBlocks (R10.2)", () => {
  // Golden values independently verified by bdunn77 (2026-09-18) against
  // flop-labs/tclk#171's `timelockSymmetryMinimum`, maxFinalityStallBlocks = 3600, p = 20.
  it.each([
    [1000, 0, 4600],
    [1000, 10, 4610],
    [100_000, 0, 120_000],
    [3600, 0, 7200], // finality branch dominates: 3600 + max(720, 3600)
  ])("tOther=%d lag=%d -> %d", (tOther, lag, expected) => {
    expect(timelockSymmetryMinimumBlocks(tOther, 20, 3600, lag)).toBe(expected);
  });

  it("a larger finality lag raises the requirement", () => {
    const noLag = timelockSymmetryMinimumBlocks(1000, 20, 3600, 0);
    const withLag = timelockSymmetryMinimumBlocks(1000, 20, 3600, 10);
    expect(withLag).toBeGreaterThan(noLag);
    expect(noLag).toBe(4600);
    expect(withLag).toBe(4610);
  });

  it("throws on a non-safe-integer or negative operand (0 is valid for all four)", () => {
    for (const bad of MALFORMED_NONNEGATIVE) {
      expect(() => timelockSymmetryMinimumBlocks(bad as number, 20, 3600, 0)).toThrow();
      expect(() => timelockSymmetryMinimumBlocks(1000, bad as number, 3600, 0)).toThrow();
      expect(() => timelockSymmetryMinimumBlocks(1000, 20, bad as number, 0)).toThrow();
      expect(() => timelockSymmetryMinimumBlocks(1000, 20, 3600, bad as number)).toThrow();
    }
    // 0 is a legitimate value for every one of these operands.
    expect(timelockSymmetryMinimumBlocks(0, 0, 0, 0)).toBe(0);
  });
});

describe("blocksBetween", () => {
  it("matches the tclk#171 blocksUntil golden value", () => {
    // blocksUntil({number:10, timestampMs:1e6}, 1_005_001) -> 6
    expect(blocksBetween(1_000_000, 1_005_001, 1000)).toBe(6);
  });

  it("rounds up, including exact-boundary cases", () => {
    expect(blocksBetween(0, 1000, 1000)).toBe(1);
    expect(blocksBetween(0, 1001, 1000)).toBe(2);
    expect(blocksBetween(0, 999, 1000)).toBe(1);
  });

  it("throws on a bad operand", () => {
    // fromMs/toMs carry no sign constraint: -1 and 0 are legitimate ms values.
    for (const bad of MALFORMED_ANY_INTEGER) {
      expect(() => blocksBetween(bad as number, 1000, 1000)).toThrow();
      expect(() => blocksBetween(0, bad as number, 1000)).toThrow();
    }
    expect(blocksBetween(-1, 1000, 1000)).toBe(2);
    expect(blocksBetween(0, -1000, 1000)).toBe(-1);
    // blockMs must additionally be strictly positive.
    for (const bad of MALFORMED_ANY_INTEGER) {
      expect(() => blocksBetween(0, 1000, bad as number)).toThrow();
    }
    expect(() => blocksBetween(0, 1000, 0)).toThrow();
    expect(() => blocksBetween(0, 1000, -1)).toThrow();
  });
});

describe("checkSwapDeadlines — SPEC §3.5 worked example", () => {
  it("passes with the exact worked-example deadlines", () => {
    const { legA, legB } = buildWorkedExample(T0);
    const result = checkSwapDeadlines(legA, legB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.tOtherBlocks).toBe(3600);
    expect(result.tFlopBlocks).toBe(10_800);
    expect(result.requiredTFlopBlocks).toBe(7200);
    expect(result.requiredBClaimByMs).toBe(legA.refundAfterMs + DEFAULT_POLICY_EXAMPLE.finalityAMs);
    expect(result.requiredBRefundAfterMs).toBe(T0 + 7200 * DEFAULT_POLICY_EXAMPLE.flopBlockMs);
  });

  it("fails one block short of the R10.2 requirement, naming the numbers", () => {
    const legA = buildLegA(T0, { claimByMs: T0 + 45 * 60_000, refundAfterMs: T0 + 60 * 60_000 });
    // required = 7200 blocks; make tFlop = 7199 (one block short) and nothing else.
    const legB = buildLegB(T0, legA, {
      claimByMs: T0 + 70 * 60_000,
      refundAfterMs: T0 + 7199 * 1000,
    });
    const result = checkSwapDeadlines(legA, legB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.tFlopBlocks).toBe(7199);
    expect(result.requiredTFlopBlocks).toBe(7200);
    expect(result.violations).toEqual([
      `rule 3: tFlop 7199 blocks < required 7200 blocks (tOther 3600 blocks, margin 20%, ` +
        `stall 3600, lag 0; legB.refundAfterMs must be >= ${T0 + 7200 * 1000})`,
    ]);
  });
});

describe("checkSwapDeadlines — each rule violated independently", () => {
  it("rule 1 only: reveal window too short", () => {
    const legA = buildLegA(T0, {
      claimByMs: T0 + 15 * 60_000,
      refundAfterMs: T0 + 20 * 60_000, // < 30 min minRevealWindowMs
    });
    const legB = buildLegB(T0, legA, {
      claimByMs: T0 + 70 * 60_000,
      refundAfterMs: T0 + 3 * 60 * 60_000,
    });
    const result = checkSwapDeadlines(legA, legB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/^rule 1: reveal window 1200000 ms/);
  });

  it("rule 2 only: legB.claimByMs does not survive chain A finality", () => {
    const legARefundAfter = T0 + 60 * 60_000;
    const legBClaimBy = T0 + 65 * 60_000; // required is legA.refundAfterMs(60m) + finalityAMs(10m) = 70m
    const legA = buildLegA(T0, { claimByMs: T0 + 45 * 60_000, refundAfterMs: legARefundAfter });
    const legB = buildLegB(T0, legA, {
      claimByMs: legBClaimBy,
      refundAfterMs: T0 + 3 * 60 * 60_000,
    });
    const result = checkSwapDeadlines(legA, legB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toBe(
      `rule 2: legB.claimByMs ${legBClaimBy} < required ${legARefundAfter + DEFAULT_POLICY_EXAMPLE.finalityAMs} ms ` +
        `(legA.refundAfterMs ${legARefundAfter} + finalityAMs ${DEFAULT_POLICY_EXAMPLE.finalityAMs})`,
    );
  });

  it("rule 3 only: R10.2 timelock symmetry violated", () => {
    const legA = buildLegA(T0, { claimByMs: T0 + 45 * 60_000, refundAfterMs: T0 + 60 * 60_000 });
    const legB = buildLegB(T0, legA, {
      claimByMs: T0 + 70 * 60_000,
      refundAfterMs: T0 + 90 * 60_000, // 5400 blocks, well under the required 7200
    });
    const result = checkSwapDeadlines(legA, legB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/^rule 3: tFlop 5400 blocks < required 7200 blocks/);
  });
});

describe("checkSwapDeadlines — a larger finality lag raises the requirement", () => {
  it("a pair that clears rule 3 at lag=0 fails at lag=10", () => {
    // tOther = 1000 blocks (T0 -> T0+1_000_000ms); required at lag=0 is 4600 (golden above).
    const legA = buildLegA(T0, { claimByMs: T0 + 500_000, refundAfterMs: T0 + 1_000_000 });
    const legB = buildLegB(T0, legA, {
      claimByMs: T0 + 1_000_000,
      refundAfterMs: T0 + 4_600_000, // exactly the lag=0 requirement (tOther=1000 -> 4600)
    });

    // Rules 1-2 are not this test's concern: zero out their margins so only rule 3 moves.
    const lagZero: DeadlinePolicy = { ...DEFAULT_POLICY_EXAMPLE, finalityAMs: 0, minRevealWindowMs: 0 };
    const lagTen: DeadlinePolicy = { ...lagZero, flopFinalityLagBlocks: 10 };

    const withoutLag = checkSwapDeadlines(legA, legB, T0, lagZero);
    expect(withoutLag.ok).toBe(true);
    expect(withoutLag.requiredTFlopBlocks).toBe(4600);

    const withLag = checkSwapDeadlines(legA, legB, T0, lagTen);
    expect(withLag.ok).toBe(false);
    expect(withLag.requiredTFlopBlocks).toBe(4610);
    expect(withLag.violations[0]).toMatch(/^rule 3: tFlop 4600 blocks < required 4610 blocks/);
  });
});

describe("checkSwapDeadlines — malformed operands fail closed, never throw", () => {
  const { legA: goodLegA, legB: goodLegB } = buildWorkedExample(T0);

  it.each(MALFORMED)("malformed lockTimeMs (%p) yields ok:false, not a throw", (bad) => {
    expect(() => checkSwapDeadlines(goodLegA, goodLegB, bad as number, DEFAULT_POLICY_EXAMPLE)).not.toThrow();
    const result = checkSwapDeadlines(goodLegA, goodLegB, bad as number, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it.each(MALFORMED)("malformed legA.refundAfterMs (%p) yields ok:false, not a throw", (bad) => {
    const brokenLegA = { ...goodLegA, refundAfterMs: bad } as unknown as OfferFrame;
    expect(() => checkSwapDeadlines(brokenLegA, goodLegB, T0, DEFAULT_POLICY_EXAMPLE)).not.toThrow();
    const result = checkSwapDeadlines(brokenLegA, goodLegB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it.each(MALFORMED)("malformed legB.claimByMs (%p) yields ok:false, not a throw", (bad) => {
    const brokenLegB = { ...goodLegB, claimByMs: bad } as unknown as OfferFrame;
    expect(() => checkSwapDeadlines(goodLegA, brokenLegB, T0, DEFAULT_POLICY_EXAMPLE)).not.toThrow();
    const result = checkSwapDeadlines(goodLegA, brokenLegB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it.each(MALFORMED)("malformed policy.flopBlockMs (%p) yields ok:false, not a throw", (bad) => {
    const brokenPolicy = { ...DEFAULT_POLICY_EXAMPLE, flopBlockMs: bad } as unknown as DeadlinePolicy;
    expect(() => checkSwapDeadlines(goodLegA, goodLegB, T0, brokenPolicy)).not.toThrow();
    const result = checkSwapDeadlines(goodLegA, goodLegB, T0, brokenPolicy);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it.each(MALFORMED_NONNEGATIVE)("malformed policy.flopFinalityLagBlocks (%p) yields ok:false, not a throw", (bad) => {
    const brokenPolicy = { ...DEFAULT_POLICY_EXAMPLE, flopFinalityLagBlocks: bad } as unknown as DeadlinePolicy;
    expect(() => checkSwapDeadlines(goodLegA, goodLegB, T0, brokenPolicy)).not.toThrow();
    const result = checkSwapDeadlines(goodLegA, goodLegB, T0, brokenPolicy);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("undefined policy yields ok:false, not a throw", () => {
    expect(() =>
      checkSwapDeadlines(goodLegA, goodLegB, T0, undefined as unknown as DeadlinePolicy),
    ).not.toThrow();
    const result = checkSwapDeadlines(goodLegA, goodLegB, T0, undefined as unknown as DeadlinePolicy);
    expect(result.ok).toBe(false);
  });

  it("null/undefined legs yield ok:false, not a throw", () => {
    expect(() =>
      checkSwapDeadlines(null as unknown as OfferFrame, goodLegB, T0, DEFAULT_POLICY_EXAMPLE),
    ).not.toThrow();
    expect(() =>
      checkSwapDeadlines(goodLegA, undefined as unknown as OfferFrame, T0, DEFAULT_POLICY_EXAMPLE),
    ).not.toThrow();
    expect(
      checkSwapDeadlines(null as unknown as OfferFrame, goodLegB, T0, DEFAULT_POLICY_EXAMPLE).ok,
    ).toBe(false);
    expect(
      checkSwapDeadlines(goodLegA, undefined as unknown as OfferFrame, T0, DEFAULT_POLICY_EXAMPLE).ok,
    ).toBe(false);
  });

  it("legA.claimByMs >= legA.refundAfterMs (tclk's own invariant) yields ok:false, not a throw", () => {
    const brokenLegA = { ...goodLegA, claimByMs: goodLegA.refundAfterMs + 1 } as unknown as OfferFrame;
    expect(() => checkSwapDeadlines(brokenLegA, goodLegB, T0, DEFAULT_POLICY_EXAMPLE)).not.toThrow();
    const result = checkSwapDeadlines(brokenLegA, goodLegB, T0, DEFAULT_POLICY_EXAMPLE);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes("must be strictly before"))).toBe(true);
  });
});

describe("DEFAULT_POLICY_EXAMPLE", () => {
  it("matches SPEC §3.5's worked-example knobs exactly", () => {
    expect(DEFAULT_POLICY_EXAMPLE).toEqual({
      minRevealWindowMs: 30 * 60 * 1000,
      finalityAMs: 10 * 60 * 1000,
      flopMarginPercent: 20,
      flopMaxFinalityStallBlocks: 3600,
      flopFinalityLagBlocks: 0,
      flopBlockMs: 1000,
    });
  });
});
