// SPDX-License-Identifier: MIT
//
// tests/sol-compute-limits.test.ts - R3-17 (P8-FIXES-R3.md decision 12): the compute-unit limits the Solana rail
// puts on every claim and refund cover the measured base plus thirty bump attempts of the program's run-time vault
// derivation. The program's check_vault_key calls find_program_address on every claim and refund (and the
// associated-token program does the same when a claim creates the payee's account); each bump attempt costs 1,500
// units and the attempt count depends on the escrow key, so the cost is fixed per escrow but differs between escrows
// in 1,500-unit steps. The old limits (refund 15,000, claim 50,000) failed for an escrow needing six or more
// attempts, the same way on every retry. Hermetic: the live measurements stay in tests-sol/.

import { describe, expect, it } from "vitest";

import { SOL_CLAIM_COMPUTE_UNIT_LIMIT, SOL_REFUND_COMPUTE_UNIT_LIMIT } from "../src/rails/sol-htlc.js";

/** One bump attempt of find_program_address, in compute units. */
const BUMP_ATTEMPT_UNITS = 1_500;
/** The attempts the limits must cover: thirty-plus (one chance in two per extra attempt: below one in a billion). */
const BUMP_ATTEMPTS_COVERED = 30;
/** The two ComputeBudget instructions (limit and price) of every claim and refund. */
const BUDGET_INSTRUCTIONS_UNITS = 300;
/** MEASURED bases (Agave 4.3.0, tests-sol/sol-htlc.sol.test.ts): the smallest use seen for a refund and for a claim that creates the payee's account. */
const MEASURED_REFUND_BASE = 7_258;
const MEASURED_CLAIM_WITH_ACCOUNT_BASE = 22_061;
/** The limit the refund carried before R3-17, and the number of its multiples the refund limit must now exceed. */
const OLD_REFUND_LIMIT = 15_000;

describe("R3-17: the compute-unit limits cover the vault derivation's worst plausible attempt count", () => {
  it("the refund limit is at least the measured base plus 1,500 x 30 plus the two budget instructions (52,558)", () => {
    expect(MEASURED_REFUND_BASE + BUMP_ATTEMPT_UNITS * BUMP_ATTEMPTS_COVERED + BUDGET_INSTRUCTIONS_UNITS).toBe(52_558);
    expect(SOL_REFUND_COMPUTE_UNIT_LIMIT).toBeGreaterThanOrEqual(
      MEASURED_REFUND_BASE + BUMP_ATTEMPT_UNITS * BUMP_ATTEMPTS_COVERED + BUDGET_INSTRUCTIONS_UNITS,
    );
  });

  it("the claim limit is at least the measured claim-with-account base plus 1,500 x 30 plus the two budget instructions (67,361)", () => {
    expect(MEASURED_CLAIM_WITH_ACCOUNT_BASE + BUMP_ATTEMPT_UNITS * BUMP_ATTEMPTS_COVERED + BUDGET_INSTRUCTIONS_UNITS).toBe(67_361);
    expect(SOL_CLAIM_COMPUTE_UNIT_LIMIT).toBeGreaterThanOrEqual(
      MEASURED_CLAIM_WITH_ACCOUNT_BASE + BUMP_ATTEMPT_UNITS * BUMP_ATTEMPTS_COVERED + BUDGET_INSTRUCTIONS_UNITS,
    );
  });

  it("the refund limit is above three times the old 15,000 (the old limit failed for an escrow needing six or more attempts)", () => {
    expect(SOL_REFUND_COMPUTE_UNIT_LIMIT).toBeGreaterThan(OLD_REFUND_LIMIT * 3);
  });

  it("both limits stay inside what one transaction may request (1,400,000 units)", () => {
    expect(SOL_REFUND_COMPUTE_UNIT_LIMIT).toBeLessThanOrEqual(1_400_000);
    expect(SOL_CLAIM_COMPUTE_UNIT_LIMIT).toBeLessThanOrEqual(1_400_000);
  });
});
