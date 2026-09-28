// SPDX-License-Identifier: MIT
//
// P22-P24-EVM-FIXES.md B3: the EVM deadline policy, pinned once here as an exported constant
// instead of taken from whatever a runner happens to pass in. Before this fix, `BuyerFlow
// .acceptLegB` accepted a caller-supplied `DeadlinePolicy` — a runner (or a compromised one)
// could hand it a slack policy and the Buyer would check its own safety against numbers it
// never chose. `minRevealWindowMs` (45 min) and `finalityAMs` (20 min) are the EVM-local-run
// values P22-P24-EVM-SPEC.md §6 derives from PHASE2-PREP.md §3 (Base Sepolia inclusion +
// finality lag, widened for anvil's own margin); the R10.2 knobs are the existing FLOP
// constants `src/deadlines.ts`'s `DEFAULT_POLICY_EXAMPLE` already pins (20% margin, 3600-block
// stall, no observed lag, 1 s blocks) — unchanged, since R10.2 is a FLOP-side rule, not an EVM
// one.
//
// `claimInclusionMarginMs` is new here (B2): the minimum gap this build insists on between
// "now" (or, at claim time, the chain's own `block.timestamp`) and `A.refundAfterMs` before it
// will accept a leg A offer or send a claim. `EvmHashRail.sol` enforces only `refundAfterMs`
// on-chain (`claimByMs` is a client-side courtesy the contract never checks), so a claim sent
// with only seconds of slack could still land after `refundAfterMs` opens if it sits in the
// mempool a while — racing the Buyer's own refund. Five minutes comfortably covers anvil's
// (near-instant) and Base Sepolia's (~2 s blocks, occasional reorg-driven resubmits) inclusion
// time without materially narrowing the 90-minute leg-A window PHASE2-PREP.md §3 proposes.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-FIXES.md B2, B3.

import { DEFAULT_POLICY_EXAMPLE } from "../deadlines.js";
import type { DeadlinePolicy } from "../types.js";

export interface EvmLocalPolicy extends DeadlinePolicy {
  /** B2: the minimum `refundAfterMs - now` (wall-clock at accept time; chain time at claim
   *  time) this build will accept before refusing a leg A offer, or refusing to send a claim. */
  claimInclusionMarginMs: number;
}

export const EVM_LOCAL_POLICY: EvmLocalPolicy = Object.freeze({
  ...DEFAULT_POLICY_EXAMPLE,
  minRevealWindowMs: 45 * 60_000,
  finalityAMs: 20 * 60_000,
  claimInclusionMarginMs: 5 * 60_000,
});
