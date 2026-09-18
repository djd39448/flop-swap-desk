// SPDX-License-Identifier: MIT
//
// Shared shapes for the atomic swap desk. Everything here is a *view* derived from signed
// tclk/1 transcripts plus rail observations; nothing here is an authority over money.
// Design: flop-contrib/SPEC-ATOMIC-SWAP-DESK.md (draft 0.1, 2026-09-18), §3–§4.

import type { OfferFrame, TranscriptFoldResult, TranscriptRecord } from "@flop-labs/tclk";

/** `offer.job.proto` value that marks a tclk/1 offer as one leg of a swap. */
export const SWAP_PROTO = "swap";

/** Domain tag for `swapId` (sha256 over `FLOP::swap::v1|<buyer did>|<nonce>`). */
export const SWAP_ID_DOMAIN = "FLOP::swap::v1";

/** The FLOP leg's only asset and rail in v1. */
export const FLOP_ASSET = "FLOP";
export const FLOP_RAIL = "flop-htlc";

export type SwapLeg = "a" | "b";

/**
 * Leg A (`job.context = "a|<want-asset>|<want-amount>|<want-rail>"`): the Buyer pays the
 * counter-asset and states what it wants in return (FLOP amount in VFY, rail `flop-htlc`).
 */
export interface LegAContext {
  leg: "a";
  wantAsset: string;
  wantAmount: string;
  wantRail: string;
}

/** Leg B (`job.context = "b|<legA offer id>"`): the Seller pays FLOP against a named leg A. */
export interface LegBContext {
  leg: "b";
  legAOfferId: string;
}

export type SwapContext = LegAContext | LegBContext;

/** Composite swap states, SPEC §4. Order is not meaningful; see `SWAP_TERMINAL_STATUSES`. */
export type SwapStatus =
  | "bid"
  | "accepted"
  | "paired"
  | "b-locked"
  | "a-locked"
  | "revealed"
  | "settled"
  | "refunded-a"
  | "refunded-b"
  | "refunded"
  | "abandoned"
  | "unpaired"
  | "orientation-unsupported";

export const SWAP_TERMINAL_STATUSES: ReadonlySet<SwapStatus> = new Set<SwapStatus>([
  "settled",
  "refunded",
  "abandoned",
  "unpaired",
  "orientation-unsupported",
]);

/**
 * What a rail read path reported about an announced lock. `verified` is the rail's
 * fail-closed `verifyLock` answer at the *finalized* view; `finalizedRef` names the
 * block/height/finality id it was checked against so anyone can re-check. Absent evidence
 * is "unknown", never "verified".
 */
export interface LockEvidence {
  rail: string;
  ref: string;
  verified: boolean;
  checkedAtMs: number;
  finalizedRef?: string;
  endpoint?: string;
  reason?: string;
}

/**
 * Terminal-side rail observations the fold may not learn from frames alone (a refund taken
 * on chain without a `refund` frame, a claim's finality). Optional inputs; absent = unknown.
 */
export interface RailObservation {
  status: "locked" | "claimed" | "refunded";
  final: boolean;
  checkedAtMs: number;
  finalizedRef?: string;
}

export interface SwapEvidence {
  a?: LockEvidence;
  b?: LockEvidence;
  aRail?: RailObservation;
  bRail?: RailObservation;
}

/** The desk's view of one swap. Every field is derived; `reasons` says why, fail-closed. */
export interface SwapView {
  swapId: string | null;
  status: SwapStatus;
  /** Leg A offer id (the Buyer's bid) when known. */
  legAOfferId: string | null;
  legBOfferId: string | null;
  buyerDid: string | null;
  sellerDid: string | null;
  legA: TranscriptFoldResult | null;
  legB: TranscriptFoldResult | null;
  evidence: SwapEvidence;
  reasons: string[];
  /** The revealed preimage once leg A's reveal verified (world-readable by design). */
  secret?: string;
}

/** Inputs to a composite fold: the two legs' records in venue order, plus rail evidence. */
export interface SwapFoldInput {
  legA: readonly TranscriptRecord[];
  legB: readonly TranscriptRecord[];
  evidence?: SwapEvidence;
  nowMs: number;
}

/** Policy knobs for SPEC §3.5; there is no safe universal default, so callers supply them. */
export interface DeadlinePolicy {
  /** Rule 1: the Seller's minimum real window to reveal on chain A after seeing lock A. */
  minRevealWindowMs: number;
  /** Rule 2: chain A's finality/observation lag the Buyer must survive after the last reveal. */
  finalityAMs: number;
  /** R10.2 `p` (yellow paper v0.5.0: 20). */
  flopMarginPercent: number;
  /** R10.2 `max_finality_stall` in FLOP blocks (PR tclk#171 uses 3_600). */
  flopMaxFinalityStallBlocks: number;
  /** R10.2 `current_finality_lag` in FLOP blocks, observed (best − finalized). */
  flopFinalityLagBlocks: number;
  /** FLOP block time in ms (yellow paper §2: 1 s). */
  flopBlockMs: number;
}

export interface DeadlineCheck {
  ok: boolean;
  violations: string[];
  /** Rule 3's minimum for `legB.refundAfterMs` given the policy and `lockTimeMs`. */
  requiredBRefundAfterMs: number;
  /** Rule 2's minimum for `legB.claimByMs`. */
  requiredBClaimByMs: number;
  /** R10.2 operands in FLOP blocks, for the audit trail. */
  tOtherBlocks: number;
  tFlopBlocks: number;
  requiredTFlopBlocks: number;
}

/** A board is every swap the fold could derive from a set of rooms. */
export interface BoardInput {
  offers: readonly TranscriptRecord[];
  /** Deal-room records keyed by room name (`mb-p-tclk-<16 hex>`). */
  dealRooms: ReadonlyMap<string, readonly TranscriptRecord[]>;
  evidence?: ReadonlyMap<string, SwapEvidence>;
  nowMs: number;
}

export interface Board {
  swaps: SwapView[];
  /** Offers carrying `job.proto === "swap"` that no well-formed pair uses, with why. */
  unpaired: Array<{ offerId: string; reason: string }>;
}

export type OfferPredicate = (offer: OfferFrame) => boolean;
