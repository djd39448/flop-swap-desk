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

/**
 * P4-BTC-SPEC.md §7a: the shape every rail's own local deadline policy shares —
 * `checkSwapDeadlines`'s own `DeadlinePolicy` plus B2's `claimInclusionMarginMs`. Before the
 * Bitcoin leg existed, `EVM_LOCAL_POLICY` was simply hardcoded into `src/client/buyer.ts`/
 * `seller.ts`; those flows now take a `RailLocalPolicy` alongside their `CounterAssetRail`
 * (`BuyerFlowOptions.policy`/`SellerFlowOptions.policy`, defaulting to `EVM_LOCAL_POLICY` when
 * omitted, so every pre-existing caller that never passed one keeps its exact prior behaviour) —
 * `EvmLocalPolicy` and `BtcLocalPolicy` below are both just this same shape, named per rail only
 * for readability at each constant's own definition.
 */
export interface RailLocalPolicy extends DeadlinePolicy {
  claimInclusionMarginMs: number;
}

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

// P4-BTC-SPEC.md §7 ("Bitcoin deadline policy"): the Bitcoin-local twin of `EVM_LOCAL_POLICY`,
// sized for this build's own regtest pin (`BTC_REGTEST_PIN`, 1 confirmation) rather than a real
// mainnet/signet deployment.
//
// `minRevealWindowMs` (>= 6 blocks, "60 min" per spec): the Seller's own real window, after
// seeing leg A locked, to broadcast its claim before the refund race described below gets
// tight — spec §3's "no claim deadline on chain" means this is a client-side courtesy, not
// something the chain enforces, so it is sized the same order of magnitude as EVM's own 45 min
// rather than shaved to the bare regtest minimum.
//
// `finalityAMs` (N confirmations plus a 2 h median-time-past budget): `btc-script.ts`'s own
// documented consequence of the unix-time CLTV rule is that a refund's real, chain-observable
// time lags `refundAfterMs` by roughly an hour (median-time-past of the last 11 blocks) — this
// build budgets a full 2 h so the Buyer's own rule-2 check (`legB.claimByMs >=
// legA.refundAfterMs + finalityAMs`) stays safe even on a slow or irregularly-mined chain, well
// above the ~1 h MTP lag alone. `BTC_REGTEST_PIN.finality.confirmations` (1) contributes
// negligibly next to that lag on a regtest node that mines on demand, so this constant does not
// scale it in separately — a real mainnet/signet pin choosing more confirmations would need its
// own wider constant, out of scope here (P4-BTC-SPEC.md §0).
//
// `claimInclusionMarginMs` (60 min, spec's own "a claim-inclusion margin of 60 min"): the
// Seller's own `claimLegA`-equivalent last-moment guard — the minimum gap this build insists on
// between "now" (chain tip time, `BtcHtlcRail.tipBlockTimeMs`) and `A.refundAfterMs` before it
// will accept a leg A offer or send a claim, and the same margin `A.claimByMs` is derived from
// below `A.refundAfterMs`, so the Buyer's own post-`T` refund is never crowded by a claim that
// might still land after the refund race opens (spec §7's "the Buyer must be able to refund
// promptly; B.claimBy must still be open when a late claim lands"). Wider than EVM's 5 min
// because Bitcoin has no on-chain claim deadline at all (spec §3), so this client-side margin is
// this build's *only* defense against the claim/refund race, not merely a mempool-inclusion
// buffer on top of an enforced deadline.
export interface BtcLocalPolicy extends DeadlinePolicy {
  claimInclusionMarginMs: number;
}

export const BTC_LOCAL_POLICY: BtcLocalPolicy = Object.freeze({
  ...DEFAULT_POLICY_EXAMPLE,
  minRevealWindowMs: 60 * 60_000,
  finalityAMs: 2 * 60 * 60_000,
  claimInclusionMarginMs: 60 * 60_000,
});
