// SPDX-License-Identifier: MIT
//
// Test helper: a `RailObservation` correctly bound (rail, ref, contract, terms) to one leg of a
// `scenario()`'s accepted offer/accept pair and its lock frame — what every real evidence reader
// (paper, evm-htlc, btc-htlc, near-htlc) produces for that leg (tclk#194 finding 1).

import type { RailObservation } from "../../src/types.js";
import type { Scenario } from "./scenario.js";

export function observe(
  s: Scenario,
  leg: "a" | "b",
  status: RailObservation["status"],
  checkedAtMs: number,
  overrides: Partial<RailObservation> = {},
): RailObservation {
  const lock = leg === "a" ? s.frames.lockA : s.frames.lockB;
  const terms = leg === "a" ? s.legATerms : s.legBTerms;
  return {
    status,
    final: true,
    checkedAtMs,
    rail: lock.rail,
    ref: lock.ref,
    contract: terms.contract,
    terms: { ...terms },
    ...overrides,
  };
}
