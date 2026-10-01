// SPDX-License-Identifier: MIT
//
// Shared shapes for the atomic swap desk. Everything here is a *view* derived from signed
// tclk/1 transcripts plus rail observations; nothing here is an authority over money.
// Design: flop-contrib/SPEC-ATOMIC-SWAP-DESK.md (draft 0.1, 2026-09-18), §3–§4.

import type { LockTerms, OfferFrame, TranscriptFoldResult, TranscriptRecord } from "@flop-labs/tclk";

import type { CustomRailRegistry } from "./rails/custom-rails.js";

export type { LockTerms };

/** `offer.job.proto` value that marks a tclk/1 offer as one leg of a swap. */
export const SWAP_PROTO = "swap";

/** Domain tag for `swapId` (sha256 over `FLOP::swap::v1|<buyer did>|<nonce>`). */
export const SWAP_ID_DOMAIN = "FLOP::swap::v1";

/** The FLOP leg's only asset and rail in v1. */
export const FLOP_ASSET = "FLOP";
export const FLOP_RAIL = "flop-htlc";

export type SwapLeg = "a" | "b";

/** Maximum value of leg A's `<fee-bps>` segment (profile v1.1, SPEC §3.7). */
export const FEE_BPS_MAX = 10000;

/**
 * Grammar for leg A's `<fee-bps>` segment: a decimal integer 0…10000, no leading zeros, no
 * sign, no decimals — it sits inside the Ed25519-signed, id-committed offer, so the grammar
 * is exact and never normalized after the fact (same rule as the rail id today).
 */
export const FEE_BPS_PATTERN = /^(0|[1-9][0-9]{0,3}|10000)$/;

/**
 * Leg A (`job.context = "a|<want-asset>|<want-amount>|<want-rail>|<fee-bps>"`, profile v1.1):
 * the Buyer pays the counter-asset and states what it wants in return (FLOP amount in VFY,
 * rail `flop-htlc`). `feeBps` is basis points of leg A's `amount` (the counter-asset the
 * Buyer pays), declared in the signed offer; it is paid only on a completed claim, never on
 * refund, and is `0` on every deployment we operate (the 4-segment v1.0 form reads as `0`).
 */
export interface LegAContext {
  leg: "a";
  wantAsset: string;
  wantAmount: string;
  wantRail: string;
  feeBps: number;
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
 * What a rail read path reported about an announced lock. `finalizedRef` names the
 * block/height/finality id it was checked against so anyone can re-check. Absent evidence
 * is "unknown", never "verified".
 *
 * `terms` is the lock's own claimed `LockTerms` — all nine fields (contract, lock,
 * statement, amount, asset, payer, payee, claimByMs, refundAfterMs) the evidence was
 * checked against. `src/swap.ts`'s fold compares every one of them against the accepted
 * offer's own `lockTerms()` before a leg counts as locked; a rail's own check may cover
 * fewer (tclk#180: `PaperRail.verifyLock` compares four of the nine), so this field lets the
 * fold verify the rest itself instead of trusting whatever subset the rail bothered to check.
 *
 * `railVerified` is the rail's own fail-closed `verifyLock`-equivalent verdict at the
 * *finalized* view: `true`/`false` when the rail's own (possibly partial) check ran,
 * `null` when there was nothing to check against at all (e.g. no paper note posted yet).
 * Recorded as corroboration only — never sufficient alone to mark a leg locked (tclk#180).
 */
export interface LockEvidence {
  rail: string;
  ref: string;
  terms: LockTerms;
  railVerified: boolean | null;
  checkedAtMs: number;
  finalizedRef?: string;
  endpoint?: string;
  reason?: string;
  /** P22-P24-EVM-SPEC.md §5: sha256 (lowercase hex) of each byte-exact raw input the verdict
   *  rests on, in call order — a chain rail's `raw/rpc/<sha256>.json` captures (see
   *  `src/rails/rpc-capture.ts`). Absent for rails (e.g. `paper`) that don't capture raw
   *  bytes this way. */
  raw?: string[];
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
  /** R4-3: the chain's own time (ms) of the claim or refund transition this observation reports (slot/block time as the
   *  chain recorded it), when the reader could bind one. No reader sets it today; the fold's theft verdict needs it on
   *  BOTH legs, so without it the fold stays neutral. */
  transitionAtMs?: number;
  /** Binding (tclk#194 review, finding 1): what this observation is an observation OF. The fold
   *  (`src/swap.ts`) uses an observation only when every one of these equals the leg's own
   *  accepted offer/accept pair and its accepted lock frame — a bare `{status, final}` proves
   *  nothing about which swap it belongs to, so it is treated as absent. Filled by every
   *  evidence reader (paper, evm-htlc, btc-htlc, near-htlc) from the very terms/ref it checked. */
  /** The rail id the observation was read from (the accepted lock frame's `rail`). */
  rail: string;
  /** The rail-native lock reference it was read for (the accepted lock frame's `ref`). */
  ref: string;
  /** The tclk contract id of the leg (its deal room's contract; also `terms.contract`). */
  contract: string;
  /** A copy of the full nine-field `LockTerms` the observation was checked against. */
  terms: LockTerms;
}

/** The binding fields of a `RailObservation`, copied from the lock evidence the same reader
 *  built (its own `rail`/`ref`/`terms`) so the observation names exactly what it was checked
 *  against; `contract` is `terms.contract`. `terms` is copied, not shared. */
export function railBinding(lock: { rail: string; ref: string; terms: LockTerms }): Pick<RailObservation, "rail" | "ref" | "contract" | "terms"> {
  return { rail: lock.rail, ref: lock.ref, contract: lock.terms.contract, terms: { ...lock.terms } };
}

export interface SwapEvidence {
  a?: LockEvidence;
  b?: LockEvidence;
  aRail?: RailObservation;
  bRail?: RailObservation;
}

/**
 * H3: money state per leg, derived only from rail evidence (paper notes today; a chain read
 * once P2 lands) — never from tclk frames alone, so a signed `reveal` frame is never read as
 * `claimed`. Vocabulary pinned to `flop-labs/tclk` PR #173 at commit `0f94269` (see
 * PROVENANCE.md; nothing from that PR is vendored, this is a naming citation only). `unfunded`
 * is not reachable from the paper rail today (a paper record only exists once a leg locks —
 * there is no "checked and confirmed empty" state to report) but is part of the vocabulary for
 * when a chain rail can report it.
 */
export type SettlementView = "none" | "unverified" | "unfunded" | "funded" | "claimed" | "refunded";

/**
 * H4: a verdict this desk drew that rests on data the venue's signatures do not cover — an
 * unsigned venue `ts` (used to order two records against each other) or the export's row
 * order (used to break a tie among several candidates). Neither is forgeable into a fake
 * *frame*, but a venue (or a MITM of an unauthenticated read) could still misreport them, so
 * anything derived from them is labeled, never silently trusted the same as a signed field
 * (tclk#175, and the reordering/timestamp concerns in tclk#93/#96).
 */
export interface CoordinationOnlyFlag {
  basis: "coordination-only";
  reason: string;
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
  /** Leg A's declared `<fee-bps>` (profile v1.1, SPEC §3.7), once leg A's context is known;
   *  `null` before then (e.g. `unpaired`/`orientation-unsupported` with no usable context). */
  feeBps: number | null;
  legA: TranscriptFoldResult | null;
  legB: TranscriptFoldResult | null;
  /** Unique per-pair identifier `<legA offer id>|<legA contract>|<legB contract>` once both
   *  legs have been accepted (tclk#194 finding 2); `null` before then. `swapId` alone is not
   *  unique: it is a hash of the buyer's DID and a nonce the buyer chooses. */
  pairKey: string | null;
  /** The evidence the fold actually used: a rail observation that failed its binding to this
   *  pair (`src/swap.ts`) is removed here and explained in `reasons`. */
  evidence: SwapEvidence;
  /** H3: per-leg settlement view, from rail evidence alone — see `SettlementView`. */
  settlementView: { a: SettlementView; b: SettlementView };
  /** H4: every verdict folded into this view that rests on unsigned venue `ts` or export row
   *  order — see `CoordinationOnlyFlag`. Empty when nothing here depended on either. */
  coordinationOnly: CoordinationOnlyFlag[];
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
  /** SB3a: the caller-owned custom rail registry (never global) whose ids a leg's offer may name. Absent:
   *  tclk's closed rail registry only, exactly as before. */
  railRegistry?: CustomRailRegistry;
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
  /** Per-leg rail evidence keyed by the leg's own tclk contract id — unique per offer/accept
   *  pair (tclk#194 finding 2). Never keyed by `swapId`, which a buyer can reuse across
   *  distinct pairs. The board assembles a swap's `SwapEvidence` from the contract ids of the
   *  two accepts it actually paired, and looks nothing up at all for a `swapId` shared by more
   *  than one active swap. */
  evidence?: ReadonlyMap<string, LegEvidence>;
  nowMs: number;
  /** SB3a: the caller-owned custom rail registry (never global) whose ids a leg's offer may name. Absent:
   *  tclk's closed rail registry only, exactly as before. */
  railRegistry?: CustomRailRegistry;
}

/** One leg's rail evidence: the lock verdict plus the optional terminal-side observation. */
export interface LegEvidence {
  lock: LockEvidence;
  rail?: RailObservation;
}

export interface Board {
  swaps: SwapView[];
  /** Offers carrying `job.proto === "swap"` that no well-formed pair uses, with why. */
  unpaired: Array<{ offerId: string; reason: string }>;
}

export type OfferPredicate = (offer: OfferFrame) => boolean;
