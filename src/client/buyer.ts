// SPDX-License-Identifier: MIT
//
// P22-P24-EVM-SPEC.md §6: the Buyer's side of one swap — opens leg A (the counter-asset, on its
// own rail), accepts leg B (FLOP, on tclk's `paper` rail) only once the deadline arithmetic is
// safe, and refuses to lock leg A until both the Seller's chain account has resolved (D-08) and
// leg B itself verifies. Every step is an explicit method a runner calls in order; each either
// succeeds or throws an `Error` naming the rule it refused to break.
//
// P4-BTC-SPEC.md §7a ("one client, many rails"): this class no longer imports a specific rail's
// adapter at all — `BuyerFlowOptions.rail` is a `CounterAssetRail` (src/client/counter-rail.ts),
// and every write/read this class makes against leg A goes through it. No behaviour change for
// EVM: `src/client/evm-rail.ts`'s adapter makes exactly the same calls, in the same order,
// against the same `CapturingRpc`, that this class used to make directly against `EvmHtlcRail`.
//
// P22-P24-EVM-FIXES.md B3: `acceptLegB` used to take a caller-supplied `DeadlinePolicy` and a
// bare, unauthenticated `AcceptFrame` for leg A's accept — a runner (or a compromised one)
// could hand this flow a slack policy, or an accept frame nobody ever actually signed and
// posted, and `acceptLegB` would check its own safety against fiction. It now uses the pinned
// `EVM_LOCAL_POLICY` (src/client/policy.ts) and takes `acceptA` as the actual signed record it
// must have arrived as, requiring it to authenticate, to be from the same Seller who posted
// `offerB` (`offerB.from`), and to reference this flow's own leg A offer. `lockLegA` re-runs
// `checkSwapDeadlines` at the real lock time (`clock()`) before ever touching the chain — a
// pair that was safe at accept time is not guaranteed to still be safe by the time this Buyer
// actually locks.
//
// P22-P24-EVM-FIXES-R2.md C2: `acceptLegB`'s leg B offer itself was still a bare `OfferFrame`
// object — a caller could hand this flow an offer nobody ever actually signed and posted, and
// nothing here compared its `amount`/`asset`/`rails` against what this flow's own leg A offer
// declared wanting. `offerB` is now taken as the actual signed offer-room record it must have
// arrived as (authenticated the same way `acceptARecord` already was), and both `acceptLegB`
// and `lockLegA` check it against leg A's own context with `profile.ts`'s
// `checkLegBMatchesWant` — a Seller offering 1 FLOP against a 52,070,000 FLOP want is refused,
// not merely "some FLOP on some flop-htlc rail". C4: `acceptLegB` also recomputes the tclk
// contract id for leg A's own accept and requires it to equal `acceptA.contract`, the same way
// `SellerFlow.lockLegB` already does for leg B's — an accept whose `contract` field disagrees
// with what tclk itself derives for that offer/accept pair is refused rather than trusted.
//
// P22-P24-EVM-FIXES-R3.md E1: `acceptLegB` refuses a second pairing (already paired, or one in
// flight) the same way `SellerFlow.lockLegB` refuses a second leg-B lock (C1); `lockLegA`
// re-verifies leg B is *still* locked on the paper rail immediately before spending, never
// trusting `legBVerified` as anything but "was true once". E3: `lockLegA` records its own lock
// state (from `termsA.statement`, already known before ever touching the chain) before
// approve/lock ever run, so a failed evidence capture or a failed lock-frame post becomes
// "locked, evidence pending" to this flow, never "never locked".
//
// SB3a (P6-SOL-SPEC.md): the Solana leg runs through this same class. Its rail id is an owner-namespaced custom
// id tclk's closed registry does not know, so the leg A offer (`bid`), the `lock` frame and the `refunded`
// receipt are built and encoded through the rail's OWN registry (`CounterAssetRail.railRegistry`, never
// global; `src/rails/custom-frames.ts`). Everything else is the rail-agnostic flow: the lock frame is posted
// only after the adapter confirmed the escrow at FINALIZED, a refund is refused once the escrow itself reads
// Claimed at finalized, and the Buyer then learns the secret from the escrow's stored preimage and claims leg B.
// S2-1: on this rail the Buyer claims leg B ONLY once leg A reads Claimed at finalized, and it never scans
// history. A secret leaked by a FAILED claim is not a payment (a failed claim leaves no state, and the program
// refuses every claim at or after refund_after_ms), so claiming leg B on it would either cost the Seller leg B
// or freeze leg A; a failed Seller claim simply means the swap fails and both legs are refunded.
//
// P8-RESUME-SPEC.md (crash-resume): with an optional `store` (src/client/flow-store.ts) this flow writes its swap
// record BEFORE every outward action (the leg A offer and accept B text before they are posted; the prepared lock,
// ref plus the rail's recovery handle, before `commitLock`; the leg B claim intent before the note write; every
// refund signature before it is sent; the exact text of every frame and account line before `venue.post`) and
// `BuyerFlow.resume` rebuilds the flow from that record in a fresh process. `lockLegA`, `claimLegB` and `refundLegA`
// then recover instead of refusing: they read the chain and the venue first and re-post only the saved text, only
// when the room lacks it. Without a store the flow behaves exactly as before and cannot be resumed. The Buyer's
// record never holds the swap secret; `toJSON` and `util.inspect` show public data only.
//
// Review round 1 (P8-FIXES-R1.md), what a runner can rely on:
//  - R1-03: a save the store refused (or refused as stale, R1-02: another instance saved first) makes this flow a crashed one: every
//    public step throws `FlowStoreWriteFailedError` until the runner drops it and calls `resume()`. Nothing the failed instance latched
//    in memory (a prepared lock, a refund handle) is ever acted on.
//  - R1-01: a resumed `lockLegA` reads the chain BEFORE any guard. A lock that landed is recorded and announced whatever the clock
//    says (rule 4's guards gate every NEW lock action only: a fresh lock, the re-send of saved bytes); `next` names `refundLegA` once
//    leg A's refund time has come and a lock was attempted but not recognised yet.
//  - R1-08 / R1-15: a recorded refund that landed and failed is resolved (one fresh refund follows); a refund that lost the race to a
//    claim saves that fact, so `next` says `learnSecret`. R1-09: a refund note is recorded once. R1-16: overlapping calls of one step
//    are refused.
//  - R1-06 / R1-07: leg B's paper note is not bound to who wrote it. Only a claim THIS flow made (`paperRail.claim` returned) bars the refund of
//    leg A; a note found already claimed with the swap's secret is ADOPTED (frames posted, note recorded once) and never bars it, and `next` is
//    never `done` for an adopted claim until leg A was seen claimed. A claim attempt that provably did not land (leg B's note is refunded, missing,
//    or past its refund time) is cleared from the record; one that may still land keeps the refund refused. R1-12: a confirmed `acceptLegB`
//    returns its recorded result.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6; P22-P24-EVM-FIXES.md B3, B5;
// P22-P24-EVM-FIXES-R2.md C2, C4; P22-P24-EVM-FIXES-R3.md E1, E3; P4-BTC-SPEC.md §7a;
// P6-SOL-SPEC.md sections 3-5; P8-RESUME-SPEC.md.

import { inspect } from "node:util";

import {
  contractId,
  dealRoom,
  encodeFrame,
  makeAccept,
  PaperRail,
  tryDecodeFrame,
  verifySecret,
  verifyTranscriptRecord,
  OFFER_ROOM,
  type AcceptFrame,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { checkSwapDeadlines } from "../deadlines.js";
import { checkLegBMatchesWant, checkOrientation, classifySwapOffer, isSwapId, legAContext } from "../profile.js";
import { encodeFrameWith, makeOfferWith } from "../rails/custom-frames.js";
import { SOL_RAIL_ID } from "../rails/custom-rails.js";
import { NearRefundFailedError, NearTxFailedError } from "../rails/near-htlc.js";
import type { Exchange } from "../rails/rpc-capture.js";
import { SolRefundFailedError } from "../rails/sol-htlc.js";
import { offerAcceptLockTerms } from "../swap.js";
import {
  RailRecoveryRefusedError,
  belowMinLockable,
  type ConnectedCounterAssetRail,
  type CounterAssetRail,
  type LockRecovery,
  type LockRecoveryOutcome,
  type PreparedLock,
  type RailAccounts,
  type RailBlockMarker,
  type RailRefundOptions,
  type RailWriteEvidence,
} from "./counter-rail.js";
import {
  FlowRecordConflictError,
  FlowRecordMismatchError,
  checkRecordIdentity,
  evidenceFromJson,
  evidenceToJson,
  markerFromJson,
  markerToJson,
  newBuyerRecord,
  railDeploymentId,
  withLedgerIntent,
  type BuyerFlowRecord,
} from "./flow-record.js";
import {
  FlowJournal,
  acceptFromSlot,
  accountsFromJson,
  accountsToJson,
  ledgerLanded,
  offerFromSlot,
  recordFromJson,
  recordToJson,
  slotRecord,
  type BuyerNextStep,
  type JournalDeps,
} from "./flow-resume.js";
import { FlowStoreCorruptError, type FlowStore } from "./flow-store.js";
import { chainClockProblem } from "./policy.js";

export type { BuyerNextStep } from "./flow-resume.js";
import type { Signer, Venue } from "./venue.js";

export interface BuyerFlowOptions {
  identity: Signer;
  venue: Venue;
  /** Backs leg B (FLOP on tclk's `paper` rail), sharing one `NoteStore` with the Seller's own
   *  `PaperRail` instance. */
  paperRail: PaperRail;
  /** Leg A's counter-asset rail (P4-BTC-SPEC.md §7a) — `evm-htlc` today
   *  (`src/client/evm-rail.ts`'s `createEvmCounterRail`), `btc-htlc` via
   *  `src/client/btc-rail.ts`'s `createBtcCounterRail`. Only this Buyer ever locks leg A. */
  rail: CounterAssetRail;
  clock: () => number;
  /** P8-RESUME-SPEC.md: where this flow writes its swap record (see the header). Absent = today's behaviour: nothing
   *  is written and the flow cannot be resumed. */
  store?: FlowStore;
}

/** `BuyerFlow.resume` options: the constructor's, plus the store and the swap to continue. `contractA` / `contractB`
 *  are the runner's own knowledge of the two tclk contract ids, if it has any: a stored record that names another
 *  contract stops `resume` with `FlowRecordMismatchError`. */
export type BuyerResumeOptions = BuyerFlowOptions & { store: FlowStore; swapId: string; contractA?: string; contractB?: string };

export interface BidParams {
  swapId: string;
  wantAsset: string;
  wantAmount: string;
  wantRail: string;
  amount: string;
  asset: string;
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
}

/**
 * R3-6 / RR4-1: reserved for a VALUE-BEARING leg-B rail whose claim is shown by bound chain evidence (the Buyer then
 * holds leg B and must not also take leg A back). It is never thrown while leg B is the paper rail: a paper note is
 * unauthenticated and moves no value, and the Seller (who always holds the secret) or anyone holding a leaked secret
 * can write a valid "claimed" note at no cost, so obeying it would let them freeze the Buyer's real refund of leg A.
 */
export class LegBClaimedError extends Error {
  constructor() {
    super(
      "buyer: refusing to refund leg A - leg B's value-bearing claim is shown on chain, so this Buyer already holds leg B; " +
        "settle by hand (R3-6, RR4-1)",
    );
    this.name = "LegBClaimedError";
  }
}

/**
 * P8-RESUME-SPEC.md "Buyer lock A": `lockLegA` found a saved lock whose transaction the chain has not decided yet (a
 * Solana signature whose blockhash is still valid, a NEAR transaction still waiting for finality). Nothing new was
 * signed and nothing will be until the chain decides; call `lockLegA()` again later.
 */
export class LockPendingError extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(`buyer: the lock for ${ref} is not decided on chain yet - call lockLegA() again later; nothing new was signed (P8)`);
    this.name = "LockPendingError";
    this.ref = ref;
  }
}

/** R1-10: what a refund that was signed and saved but is not seen on chain yet says. It may never have been sent (the process may
 *  have died between signing and sending), which is why this is not "broadcast". */
const REFUND_UNCONFIRMED =
  "buyer: refund signed but not yet confirmed; it may never have been sent; call refundLegA() again later (G7)";

/** R1-08: a typed error that says the recorded refund transaction LANDED and FAILED on chain (it can never land again). */
function isLandedAndFailedRefund(error: unknown): boolean {
  return error instanceof NearRefundFailedError || error instanceof NearTxFailedError || error instanceof SolRefundFailedError;
}

/**
 * One Buyer's view of one swap. Call order (SPEC §6): `bid` → `acceptLegB` →
 * `verifyLegBLocked` → `postAccountLineA` → `lockLegA` → (`learnSecret` → `claimLegB`) |
 * `refundLegA`.
 */
export class BuyerFlow {
  private readonly identity: Signer;
  private readonly venue: Venue;
  private readonly paperRail: PaperRail;
  private readonly rail: CounterAssetRail;
  private readonly clock: () => number;

  private readonly store: FlowStore | undefined;
  /** P8: this flow's journal over its stored record. Present only with a store, once the first record exists. */
  #journal?: FlowJournal<BuyerFlowRecord>;
  private offerA?: OfferFrame;
  private offerB?: OfferFrame;
  private acceptA?: AcceptFrame;
  private acceptB?: AcceptFrame;
  /** P8: the signed venue records the four swap frames arrived as (kept in the stored record's frame slots). */
  private offerARecord?: TranscriptRecord;
  private offerBRecord?: TranscriptRecord;
  private acceptARecord?: TranscriptRecord;
  private acceptBRecord?: TranscriptRecord;
  /** P22-P24-EVM-FIXES-R3.md E1: set synchronously, before `acceptLegB`'s first `await`, the
   *  same re-entry pattern `SellerFlow.lockLegB` uses (C1) — so two calls issued back to back
   *  (even two independently genuine `offerB`/`acceptA` pairs, e.g. a Seller who posted a
   *  second leg-B offer for the same leg A) can never both pair this flow to a leg B. */
  private legBPairingPending = false;
  private legBVerified = false;
  /** P4-BTC-FIXES.md G2: set synchronously, before `lockLegA`'s first statement — the same
   *  re-entry pattern `legBPairingPending` uses above, so two `lockLegA` calls issued back to
   *  back can never both reach a write. */
  private legALockPending = false;
  /** G2: set once, right before `lockLegA` ever risks a broadcast, and NEVER cleared again —
   *  even if that attempt throws. The only way past it is `reconcileLockA()`; `lockLegA` itself
   *  never retries a funding it cannot be sure did not already reach the network. */
  private legALockAttempted = false;
  private lockedHashLock?: string;
  /** P4-BTC-SPEC.md §7a: the leg-A rail's own write ref for this flow's lock — `hashLock` for
   *  `evm-htlc` (`WriteEvidence.ref === terms.statement`), `0x<hash lock>:<payer>` for `near-htlc`, the funding outpoint
   *  (`"<txid>:<vout>"`) for `btc-htlc`. `refundLegA`/`learnSecret` must use THIS, never
   *  `lockedHashLock`, wherever the rail's own interface asks for a `ref` — the two happen to be
   *  the same value for `evm-htlc` today, which is exactly why this distinction was invisible
   *  before a second, outpoint-keyed rail existed. P4-BTC-FIXES.md G3: recorded from
   *  `prepareLock`'s own return, BEFORE `commitLock` ever broadcasts — so a failure anywhere
   *  after that point (a flaky read on the broadcast's own response) still leaves this flow able
   *  to recover the exact outpoint that was (or will be) created. */
  private lockedRailRef?: string;
  private lockedFromBlock?: RailBlockMarker;
  /** P4-BTC-FIXES.md G1: this leg's resolved payer/payee identities, frozen the moment
   *  `lockLegA` resolves them — BEFORE funding — and reused by every later step
   *  (`refundLegA`, `learnSecret`) instead of ever re-reading the deal room. A pubkey/account
   *  line posted after funding can therefore neither add to nor conflict with what this flow
   *  already committed to acting on. */
  private lockedAccounts?: RailAccounts;
  /** P4-BTC-FIXES-R3.md K5: set once this leg's own `lock` frame has actually posted — see
   *  `announceLockA`. */
  private lockFramePosted = false;
  /** P8: what `prepareLock` returned (the ref and the rail's recovery handle), saved BEFORE `commitLock`, and the
   *  lock's own write evidence once `commitLock` returned (or recovery found the lock landed). */
  private preparedLock?: PreparedLock;
  private lockEvidence?: RailWriteEvidence;
  /** P8: true from just before the leg B paper claim is written (saved first), and the signed refund's recovery handle
   *  from the moment the rail signed it until the refund is confirmed. */
  private legBClaimAttempted = false;
  /** R1-06: leg B's paper note already read claimed with this swap's secret when the flow looked at it and this flow's own claim never
   *  returned: ADOPTED, never a reason to refuse the refund of leg A (paper notes are not bound to who wrote them). */
  private legBClaimAdopted = false;
  private refundAttempted = false;
  /** R1-15: `refundLegA` found leg A claimed (the refund lost the race to a claim) and routed the Buyer to `learnSecret`. */
  private refundClaimSeen = false;
  /** R1-16: set synchronously at the start of `postAccountLineA`, `claimLegB` and `refundLegA` and cleared when the call ends,
   *  the same re-entry pattern `lockLegA` and `acceptLegB` use: two overlapping calls of one step can never both reach the
   *  rail or the venue (two refund builds, two account lines for two addresses, two claims). */
  private accountLinePending = false;
  private legBClaimPending = false;
  private refundPending = false;
  private refundRecovery: LockRecovery | undefined = undefined;
  /** R4-1 / RR4-1: what `refundLegA` recorded about a leg-B paper note that read claimed — a proven claim ("the secret
   *  is public and leg B's paper note reads claimed") or one ignored as not proven. Never a reason to refuse. */
  readonly refundNotes: string[] = [];

  /** G7: the refund's own write evidence, recorded the first time `refundLegA` actually
   *  broadcasts — a later call (made because the first one found the refund not yet confirmed)
   *  must never re-broadcast; it just re-checks. */
  private legARefundEvidence?: RailWriteEvidence;
  /** G7: `refundLegA`'s own refund/receipt frames are posted at most once — set only once the
   *  evidence reader itself confirms the refund. */
  private legARefundFramesPosted = false;
  // The Buyer never refunds leg A after it claimed leg B (every rail). On Solana (S2-1) leg B is claimed only once leg A
  // reads Claimed, so this latch can never contradict the chain there.
  private legBClaimed = false;
  /** B5: every leg-A write this flow has made so far (`lockLegA`'s lock, `refundLegA`'s
   *  refund), in call order — see the identical field on `SellerFlow`. */
  private readonly writeExchanges: Exchange[] = [];

  constructor(options: BuyerFlowOptions) {
    this.identity = options.identity;
    this.venue = options.venue;
    this.paperRail = options.paperRail;
    this.rail = options.rail;
    this.clock = options.clock;
    this.store = options.store;
  }

  /** B5: every leg-A write this flow has made so far, in call order. */
  get exchanges(): readonly Exchange[] {
    return this.writeExchanges;
  }

  /** P8: the swap id this flow's record is stored under, once the record exists (public data). */
  get swapId(): string | undefined {
    return this.#journal?.record.swapId;
  }

  /** P8: the two signed records `acceptLegB` needs (leg B's offer and leg A's accept), as the record kept them, so a
   *  resumed runner that no longer has them (the offers room is a short ring) can pass them again. */
  get recordedPairing(): { offerBRecord: TranscriptRecord; acceptARecord: TranscriptRecord } | undefined {
    const f = this.#journal?.record.frames;
    if (f?.offerB?.record === undefined || f.acceptA?.record === undefined) return undefined;
    return { offerBRecord: recordFromJson(f.offerB.record), acceptARecord: recordFromJson(f.acceptA.record) };
  }

  /** P8: public data only (rule 5). `JSON.stringify(flow)` sees nothing else. */
  toJSON(): { role: "buyer"; swapId: string | undefined; did: string; railId: string; caip2: string } {
    return { role: "buyer", swapId: this.swapId, did: this.identity.did, railId: this.rail.railId, caip2: this.rail.caip2 };
  }

  /** P8: `util.inspect(flow)` (directly or nested via `console.log`) sees only this (rule 5). */
  [inspect.custom](): string {
    return `BuyerFlow ${inspect(this.toJSON())}`;
  }

  private journalDeps(store: FlowStore): JournalDeps {
    return { store, venue: this.venue, identity: this.identity, clock: this.clock };
  }

  /** P8: the next safe step by the stored record alone (no I/O besides the clock). `"learnSecret"` is also the way back into
   *  `claimLegB` (the secret is never stored here, it is read again); after leg A's `refundAfterMs` a runner may call
   *  `refundLegA` where this says `learnSecret`. A lock that was attempted but is not recognised yet is `"lockLegA"` (it reads
   *  the chain first and records a lock that landed, at any time) until leg A's refund time, then `"refundLegA"` (R1-01). */
  private nextStep(): BuyerNextStep {
    const journal = this.#journal;
    if (journal === undefined || !journal.isLanded("offer-a")) return "bid";
    if (!journal.isLanded("accept-b")) return "acceptLegB";
    if (this.refundAttempted) {
      if (journal.isLanded("receipt-refund-a")) return "done";
      // R1-15: the refund lost the race to a claim: `refundLegA` only throws its routing error from here on, and the way on is
      // learnSecret then claimLegB (after which leg B's receipt makes the swap done), not refundLegA for ever.
      if (this.refundClaimSeen) return this.legBDone() ? "done" : "learnSecret";
      return "refundLegA";
    }
    if (!this.legBVerified) return "verifyLegBLocked";
    if (!journal.isLanded("account-a")) return "postAccountLineA";
    // R2-02: a claim of leg A seen on chain (refundLegA routed to it before a refund attempt was saved), or this flow's own claim of leg
    // B, wins over the F1b refund route below: the way on is learnSecret then claimLegB, and `done` once leg B's receipt landed. An
    // ADOPTED-only leg B note is not a reason to leave the refund doorway (R1-06), so `legBClaimAdopted` is deliberately not read here.
    if (this.refundClaimSeen || this.legBClaimed) return this.legBDone() ? "done" : "learnSecret";
    if (this.lockEvidence === undefined || !this.lockFramePosted) {
      // R1-01 (variant F1b): a lock that was attempted and is not recognised yet is read by `lockLegA`, which finds it landed
      // whatever the clock says. Once leg A's refund time has come, though, the way out of a landed lock is `refundLegA`
      // (nobody can claim it any more on the rails with a claim deadline), and `lockLegA` would only refuse a late new lock.
      if (this.legALockAttempted && this.offerA !== undefined && this.clock() >= this.offerA.refundAfterMs) return "refundLegA";
      return "lockLegA";
    }
    if (this.legBClaimAttempted || this.legBClaimed) return this.legBDone() ? "done" : "learnSecret";
    return "learnSecret";
  }

  /**
   * R1-06: leg B is settled for `next` when its receipt landed AND the claim is this flow's own, or was adopted and leg A has been seen
   * claimed (so nothing is left to refund). An adopted claim with leg A not seen claimed is NOT done: `next` keeps saying `learnSecret`,
   * which is the doorway to `refundLegA` after leg A's refund time (a Seller can write leg B's note `claimed` at no cost and never claim
   * leg A, so a paper note must never stop the Buyer's refund).
   */
  private legBDone(): boolean {
    const receipt = this.#journal?.isLanded("receipt-b") === true;
    return receipt && (this.legBClaimed || (this.legBClaimAdopted && this.refundClaimSeen));
  }

  /**
   * P8-RESUME-SPEC.md: continue a swap from its stored record in a fresh process. Loads and validates the record
   * (`FlowNotFoundError` when none; `FlowStoreCorruptError` / `FlowRecordVersionError` when it is damaged or from
   * another build; `FlowRecordMismatchError` when its DID, rail id, chain, swap or contract is not the one the runner
   * supplied or the record's own frames do not add up), rebuilds every latch from it, and returns the flow with the
   * name of the next safe step. Resume reads the store only: it posts nothing and touches no chain. Each step is then
   * idempotent against the record: an intent that was saved without an outcome runs its recover path, which reads the
   * chain and the venue before it acts.
   */
  static async resume(options: BuyerResumeOptions): Promise<{ flow: BuyerFlow; next: BuyerNextStep }> {
    const flow = new BuyerFlow(options);
    await flow.restore(options);
    return { flow, next: flow.nextStep() };
  }

  private async restore(options: BuyerResumeOptions): Promise<void> {
    const journal = await FlowJournal.open(this.journalDeps(options.store), "buyer", options.swapId);
    const record = journal.record;
    if (record.role !== "buyer") throw new FlowRecordMismatchError("role", "buyer", record.role);
    checkRecordIdentity(record, {
      role: "buyer",
      swapId: options.swapId,
      did: this.identity.did,
      railId: this.rail.railId,
      caip2: this.rail.caip2,
      deploymentId: railDeploymentId(this.rail), // R1-05: a record never continues against another deployment
      ...(options.contractA === undefined ? {} : { contractA: options.contractA }),
      ...(options.contractB === undefined ? {} : { contractB: options.contractB }),
    });
    this.applyRecord(record);
    const typed = journal as unknown as FlowJournal<BuyerFlowRecord>;
    typed.setProjector((next) => this.project(next));
    this.#journal = typed;
  }

  /** Rebuilds every latch from a stored record, after checking that its frames add up (the contract ids are recomputed,
   *  never trusted). */
  private applyRecord(record: BuyerFlowRecord): void {
    const key = `buyer:${record.swapId}`;
    const f = record.frames;
    const offerA = offerFromSlot(key, "offerA", f.offerA);
    const acceptA = acceptFromSlot(key, "acceptA", f.acceptA);
    const offerB = offerFromSlot(key, "offerB", f.offerB);
    const acceptB = acceptFromSlot(key, "acceptB", f.acceptB);

    if (offerA !== undefined) {
      const classified = classifySwapOffer(offerA);
      if (offerA.from !== record.did || classified === null || classified.context.leg !== "a" || classified.swapId !== record.swapId) {
        throw new FlowStoreCorruptError(key, "frames.offerA is not this Buyer's leg A offer of this swap");
      }
    }
    if (acceptA !== undefined) {
      if (offerA === undefined) throw new FlowStoreCorruptError(key, "frames.acceptA without frames.offerA");
      if (acceptA.ref !== offerA.id) throw new FlowStoreCorruptError(key, "frames.acceptA does not answer the stored leg A offer");
      const expected = contractId(offerA, {
        from: acceptA.from,
        ref: acceptA.ref,
        statement: acceptA.statement,
        ...(acceptA.paymentKey === undefined ? {} : { paymentKey: acceptA.paymentKey }),
        nonce: acceptA.nonce,
      });
      if (acceptA.contract !== expected) throw new FlowRecordMismatchError("contractA", expected, acceptA.contract);
      if (record.contractA !== undefined && record.contractA !== acceptA.contract) throw new FlowRecordMismatchError("contractA", acceptA.contract, record.contractA);
    }
    if (offerB !== undefined) {
      if (offerA === undefined || acceptA === undefined) throw new FlowStoreCorruptError(key, "frames.offerB without the leg A offer and accept it pairs with");
      const classified = classifySwapOffer(offerB);
      if (offerB.from !== acceptA.from || classified === null || classified.context.leg !== "b" || classified.context.legAOfferId !== offerA.id) {
        throw new FlowStoreCorruptError(key, "frames.offerB is not the leg B offer of the stored leg A offer, from the Seller who accepted it");
      }
    }
    if (acceptB !== undefined) {
      if (offerB === undefined || acceptA === undefined) throw new FlowStoreCorruptError(key, "frames.acceptB without the offer it answers");
      if (acceptB.from !== record.did || acceptB.ref !== offerB.id || acceptB.statement !== acceptA.statement) {
        throw new FlowStoreCorruptError(key, "frames.acceptB is not this Buyer's accept of the stored leg B offer, under leg A's statement");
      }
      const expected = contractId(offerB, {
        from: acceptB.from,
        ref: acceptB.ref,
        statement: acceptB.statement,
        ...(acceptB.paymentKey === undefined ? {} : { paymentKey: acceptB.paymentKey }),
        nonce: acceptB.nonce,
      });
      if (acceptB.contract !== expected) throw new FlowRecordMismatchError("contractB", expected, acceptB.contract);
      if (record.contractB !== undefined && record.contractB !== acceptB.contract) throw new FlowRecordMismatchError("contractB", acceptB.contract, record.contractB);
    }
    const sellerDid = acceptA?.from ?? "";
    const offerARecord = slotRecord(key, "offerA", f.offerA, record.did);
    const acceptARecord = slotRecord(key, "acceptA", f.acceptA, sellerDid);
    const offerBRecord = slotRecord(key, "offerB", f.offerB, sellerDid);
    const acceptBRecord = slotRecord(key, "acceptB", f.acceptB, record.did);

    if (ledgerLanded(record, "offer-a")) {
      if (offerA === undefined) throw new FlowStoreCorruptError(key, "the ledger says the leg A offer landed but its frame is missing");
      this.offerA = offerA;
    }
    if (ledgerLanded(record, "accept-b")) {
      if (offerA === undefined || offerB === undefined || acceptA === undefined || acceptB === undefined) {
        throw new FlowStoreCorruptError(key, "the ledger says accept B landed but the pairing's frames are missing");
      }
      this.offerB = offerB;
      this.acceptA = acceptA;
      this.acceptB = acceptB;
    }
    if (offerARecord !== undefined) this.offerARecord = offerARecord;
    if (acceptARecord !== undefined) this.acceptARecord = acceptARecord;
    if (offerBRecord !== undefined) this.offerBRecord = offerBRecord;
    if (acceptBRecord !== undefined) this.acceptBRecord = acceptBRecord;

    this.legBVerified = record.legBVerified;
    const lock = record.lock;
    if (lock.attempted && this.acceptA === undefined) throw new FlowStoreCorruptError(key, "a lock was attempted but accept B never landed");
    if (lock.hashLock !== undefined && acceptA !== undefined && lock.hashLock !== acceptA.statement) {
      throw new FlowRecordMismatchError("lock.hashLock", acceptA.statement, lock.hashLock);
    }
    this.legALockAttempted = lock.attempted;
    if (lock.prepared !== undefined) {
      this.preparedLock = lock.prepared.recovery === undefined ? { ref: lock.prepared.ref } : { ref: lock.prepared.ref, recovery: lock.prepared.recovery };
      this.lockedRailRef = lock.prepared.ref;
    } else if (lock.evidence !== undefined) {
      this.lockedRailRef = lock.evidence.ref;
    }
    if (lock.hashLock !== undefined) this.lockedHashLock = lock.hashLock;
    if (lock.fromBlock !== undefined) this.lockedFromBlock = markerFromJson(lock.fromBlock);
    if (lock.accounts !== undefined) this.lockedAccounts = accountsFromJson(lock.accounts);
    if (lock.evidence !== undefined) this.lockEvidence = evidenceFromJson(lock.evidence);
    this.lockFramePosted = lock.framePosted || ledgerLanded(record, "lock-a");
    this.legBClaimAttempted = record.legBClaimAttempted;
    this.legBClaimed = record.legBClaimed;
    this.legBClaimAdopted = record.legBClaimAdopted === true;
    this.refundAttempted = record.refund.attempted;
    this.refundClaimSeen = record.refund.claimSeen === true;
    if (record.refund.recovery !== undefined) this.refundRecovery = record.refund.recovery;
    if (record.refund.evidence !== undefined) this.legARefundEvidence = evidenceFromJson(record.refund.evidence);
    this.legARefundFramesPosted = record.refund.framesPosted || ledgerLanded(record, "receipt-refund-a");
    this.refundNotes.push(...record.refundNotes);
  }

  /** The flow's live state laid over a record (the journal calls this on every save). Only things a resumed flow
   *  needs are copied; the frames, the ledger, the account line and the revision stay the record's own. */
  private project(r: BuyerFlowRecord): BuyerFlowRecord {
    const prepared = this.preparedLock;
    return {
      ...r,
      legBVerified: this.legBVerified,
      lock: {
        attempted: this.legALockAttempted,
        ...(prepared === undefined ? {} : { prepared: prepared.recovery === undefined ? { ref: prepared.ref } : { ref: prepared.ref, recovery: prepared.recovery } }),
        ...(this.lockedFromBlock === undefined ? {} : { fromBlock: markerToJson(this.lockedFromBlock) }),
        ...(this.lockedAccounts === undefined ? {} : { accounts: accountsToJson(this.lockedAccounts) }),
        ...(this.lockedHashLock === undefined ? {} : { hashLock: this.lockedHashLock }),
        ...(this.lockEvidence === undefined ? {} : { evidence: evidenceToJson(this.lockEvidence) }),
        framePosted: this.lockFramePosted || ledgerLanded(r, "lock-a"),
      },
      legBClaimAttempted: this.legBClaimAttempted,
      legBClaimed: this.legBClaimed,
      ...(this.legBClaimAdopted ? { legBClaimAdopted: true as const } : {}),
      refund: {
        attempted: this.refundAttempted,
        ...(this.refundRecovery === undefined ? {} : { recovery: this.refundRecovery }),
        ...(this.legARefundEvidence === undefined ? {} : { evidence: evidenceToJson(this.legARefundEvidence) }),
        framesPosted: this.legARefundFramesPosted || ledgerLanded(r, "receipt-refund-a"),
        ...(this.refundClaimSeen ? { claimSeen: true as const } : {}),
      },
      refundNotes: [...this.refundNotes],
    };
  }

  /** Saves the record now (the live state laid over it). A no-op without a store. */
  private async persist(): Promise<void> {
    await this.#journal?.update((r) => r);
  }

  /**
   * R1-15: `refundLegA` found leg A claimed (the refund lost the race to a claim, or a claim is pending): the Buyer is routed to
   * `learnSecret` then `claimLegB`, and that fact is saved first, so after a restart `next` says learnSecret instead of
   * `refundLegA` for ever (a runner driven only by `next` would loop on this error and miss leg B).
   */
  private async routeToClaim(message: string): Promise<never> {
    if (this.#journal !== undefined && !this.refundClaimSeen) {
      this.refundClaimSeen = true;
      await this.persist();
    }
    throw new Error(message);
  }

  /**
   * R1-03: every public step starts here. A flow whose save was refused (the store refused it, the disk failed, a second
   * instance saved first) holds latches in memory that the store never saw: a prepared lock, a refund handle, a claim
   * attempt. Acting on them again could send a second lock or a second refund, so such a flow is treated as a crashed
   * one: every step throws `FlowStoreWriteFailedError` until the runner drops it and builds a new one with `resume()`.
   */
  private usable(): void {
    this.#journal?.assertUsable();
  }

  private requirePaired(): { offerA: OfferFrame; offerB: OfferFrame; acceptA: AcceptFrame; acceptB: AcceptFrame } {
    if (this.offerA === undefined || this.offerB === undefined || this.acceptA === undefined || this.acceptB === undefined) {
      throw new Error("buyer: leg B has not been accepted yet");
    }
    return { offerA: this.offerA, offerB: this.offerB, acceptA: this.acceptA, acceptB: this.acceptB };
  }

  /** Open leg A: a bid naming the counter-asset this Buyer pays and the FLOP it wants back,
   *  with `rails: ["evm-htlc"]` and `feeBps` 0 (every deployment we operate). */
  async bid(params: BidParams): Promise<OfferFrame> {
    this.usable();
    if (this.offerA !== undefined) {
      if (this.#journal === undefined) throw new Error("buyer: already bid for this flow");
      // P8: confirmed already (this process, or rebuilt from the record): the recorded offer, nothing posted again.
      if (params.swapId !== this.#journal.record.swapId) {
        throw new FlowRecordConflictError("buyer: this flow already bid for another swap; a party never posts a second, different frame");
      }
      return this.offerA;
    }
    // P4-BTC-FIXES-R3.md K3: refuse a bid whose declared asset does not match this rail's own
    // single settled asset (a rail that declares one at all — evm-htlc's own asset book already
    // fails closed on an unconfigured asset, so it never sets `assetId` and this never fires for
    // EVM: no behaviour change there).
    if (this.rail.assetId !== undefined && params.asset !== this.rail.assetId) {
      throw new Error(
        `buyer: refusing to bid asset "${params.asset}" — this rail only ever settles "${this.rail.assetId}" (K3)`,
      );
    }
    // G6: refuse an amount this rail could never actually lock (below the fixed spend fee plus
    // the worst-case dust limit, with margin) before ever posting a public offer for it.
    if (belowMinLockable(this.rail, params.amount)) {
      throw new Error(
        `buyer: refusing to bid ${params.amount} ${params.asset} — below this rail's minimum lockable amount ` +
          `${this.rail.minLockableAmount} (G6)`,
      );
    }
    // P8: with a store, an earlier call may already have saved the offer it chose: those exact bytes are posted, never
    // a second offer with a fresh nonce.
    const storedRecord = this.#journal?.record;
    const storedOffer = storedRecord === undefined ? undefined : offerFromSlot(`buyer:${storedRecord.swapId}`, "offerA", storedRecord.frames.offerA);
    if (storedRecord !== undefined && params.swapId !== storedRecord.swapId) {
      throw new FlowRecordConflictError("buyer: this flow already bid for another swap; a party never posts a second, different frame");
    }
    const offerA = storedOffer ?? makeOfferWith({
      from: this.identity.did,
      role: "payer",
      amount: params.amount,
      asset: params.asset,
      lock: "hash",
      rails: [this.rail.railId],
      claimByMs: params.claimByMs,
      refundAfterMs: params.refundAfterMs,
      expiresMs: params.expiresMs,
      job: {
        proto: "swap",
        id: params.swapId,
        context: legAContext({ wantAsset: params.wantAsset, wantAmount: params.wantAmount, wantRail: params.wantRail, feeBps: 0 }),
      },
    }, this.rail.railRegistry);
    if (this.store !== undefined) return this.bidPersisted(offerA, params.swapId);
    await this.venue.post("tclk-offers", encodeFrameWith(offerA, this.rail.railRegistry), this.identity);
    this.offerA = offerA;
    return offerA;
  }

  /** P8 (rules 1 and 3): the store-backed half of `bid`. The record (swap id, DID, rail, the offer's exact text) is
   *  saved BEFORE the offer is posted; a repeat posts only that text, or adopts it when the room already holds it. */
  private async bidPersisted(offerA: OfferFrame, swapId: string): Promise<OfferFrame> {
    const store = this.store;
    if (store === undefined) throw new Error("buyer: no store"); // unreachable: the caller checked
    if (!isSwapId(swapId)) throw new Error("buyer: a flow with a store needs a swapId of the form 0x + 64 lowercase hex (the record is stored under it)");
    const text = encodeFrameWith(offerA, this.rail.railRegistry);
    if (this.#journal === undefined) {
      let initial: BuyerFlowRecord = {
        ...newBuyerRecord({ swapId, did: this.identity.did, railId: this.rail.railId, caip2: this.rail.caip2, deploymentId: railDeploymentId(this.rail), nowMs: this.clock() }),
        frames: { offerA: { text } },
      };
      initial = withLedgerIntent(initial, { kind: "offer-a", room: OFFER_ROOM, text });
      const journal = await FlowJournal.begin(this.journalDeps(store), initial);
      journal.setProjector((next) => this.project(next));
      this.#journal = journal;
    }
    this.offerARecord = await this.#journal.ensurePosted({ kind: "offer-a", room: OFFER_ROOM, text, slot: "offerA" });
    this.offerA = offerA;
    return offerA;
  }

  /**
   * Accept leg B — but only after `checkSwapDeadlines` (SPEC §3.5 rules 1-3, the pinned
   * `EVM_LOCAL_POLICY`) passes for the pair at the runner's declared `lockTimeMs`; a bad Seller
   * offer is refused here, before this Buyer commits to the countdown by posting a signed
   * accept.
   *
   * P22-P24-EVM-FIXES.md B3: `acceptARecord` must be the actual signed record leg A's accept
   * arrived as (`OFFER_ROOM`) — authenticated (`verifyTranscriptRecord` + `frame.from ===
   * record.sender`), an `accept` frame, referencing this flow's own leg A offer, and *from the
   * Seller who posted `offerB`* (`acceptAFrame.from === offerB.from`) — never a bare `AcceptFrame`
   * object a caller merely asserts came from somewhere. `acceptB.statement` is copied straight
   * from the authenticated frame's own `statement`, so `acceptA.statement === acceptB.statement`
   * holds by construction, never by a separate check that could be skipped.
   *
   * P22-P24-EVM-FIXES-R2.md C4: also recomputes the tclk contract id for `(offerA, acceptA)` and
   * requires it to equal `acceptAFrame.contract`, the same way `SellerFlow.lockLegB` already does
   * for leg B's accept — the frame's own claimed `contract` field is otherwise attacker-controlled
   * data until this check runs.
   *
   * P22-P24-EVM-FIXES-R2.md C2: `offerBRecord` must likewise be the actual signed offer-room
   * record leg B's offer arrived as — authenticated and decoded the same way `acceptARecord` is
   * — and its own terms are checked against what this flow's leg A offer declared wanting
   * (`profile.ts`'s `checkLegBMatchesWant`): `checkOrientation` alone only ever verified that
   * leg B pays *some* FLOP on *a* flop-htlc rail, never that it is the amount/asset this Buyer
   * actually asked for.
   *
   * P22-P24-EVM-FIXES-R3.md E1: refuses outright when this flow is already paired to a leg B,
   * or another call is already in flight — checked, and the in-flight flag set, before anything
   * else runs (including before this method's first `await`), the same C1 pattern
   * `SellerFlow.lockLegB` uses. Without this, a second genuinely-signed `offerB`/`acceptA` pair
   * (a Seller race, or a second leg-B offer for the same leg A) could re-pair this flow after
   * `verifyLegBLocked`/`postAccountLineA` already ran against the first pairing, and `lockLegA`
   * would then spend real value against whichever pairing happened to be stored last — never
   * necessarily the one this flow itself actually verified.
   */
  async acceptLegB(
    offerBRecord: TranscriptRecord,
    acceptARecord: TranscriptRecord,
    lockTimeMs: number,
  ): Promise<{ acceptB: AcceptFrame; acceptBRecord: TranscriptRecord }> {
    this.usable();
    if (this.offerA === undefined) throw new Error("buyer: no leg A offer to pair leg B against");
    // R1-12: with a store, a pairing whose accept B the ledger shows as landed is DONE: the recorded result is returned, nothing is
    // re-verified, re-posted or read (the offers room is a short ring, so a read can miss a line that did land).
    if (this.#journal !== undefined && this.#journal.isLanded("accept-b") && this.acceptB !== undefined) return this.recordedPairingResult(offerBRecord, acceptARecord);
    // P8: with a store, a pairing that is already recorded is confirmed again (same frames only), not refused; a
    // same-process double call is still refused while one is in flight.
    if ((this.offerB !== undefined && this.#journal === undefined) || this.legBPairingPending) {
      throw new Error("buyer: refusing to accept leg B — already paired, or a pairing is already in flight (E1)");
    }
    this.legBPairingPending = true;
    try {
      return await this.acceptLegBUnlatched(offerBRecord, acceptARecord, lockTimeMs);
    } finally {
      this.legBPairingPending = false;
    }
  }

  /** R1-12: the result of an `acceptLegB` that is already confirmed, read back from the record's frame slots. Mirrors
   *  `SellerFlow.recordedAcceptResult`: the pairing the runner supplies must be the saved one (a party never posts a second,
   *  different accept), and then nothing but the stored answer is used. */
  private recordedPairingResult(offerBRecord: TranscriptRecord, acceptARecord: TranscriptRecord): { acceptB: AcceptFrame; acceptBRecord: TranscriptRecord } {
    const record = this.#journal?.record;
    const acceptB = this.acceptB;
    if (record === undefined || acceptB === undefined) throw new Error("buyer: leg B has not been accepted yet");
    if (record.frames.offerB?.text !== offerBRecord.line || record.frames.acceptA?.text !== acceptARecord.line) {
      throw new FlowRecordConflictError("buyer: a different pairing than the one this swap saved; a party never posts a second, different accept");
    }
    const stored = record.frames.acceptB?.record;
    if (stored === undefined) throw new FlowStoreCorruptError(`buyer:${record.swapId}`, "accept B is recorded as done but its signed record is missing");
    return { acceptB, acceptBRecord: recordFromJson(stored) };
  }

  private async acceptLegBUnlatched(
    offerBRecord: TranscriptRecord,
    acceptARecord: TranscriptRecord,
    lockTimeMs: number,
  ): Promise<{ acceptB: AcceptFrame; acceptBRecord: TranscriptRecord }> {
    // this.offerA is already known defined (checked by acceptLegB before this is called), but
    // TypeScript's narrowing does not survive the method boundary.
    if (this.offerA === undefined) throw new Error("buyer: no leg A offer to pair leg B against");

    if (acceptARecord.room !== OFFER_ROOM || !verifyTranscriptRecord(acceptARecord).ok) {
      throw new Error("buyer: refusing to accept leg B — leg A accept record does not authenticate (B3)");
    }
    const acceptAFrame = tryDecodeFrame(acceptARecord.line);
    if (acceptAFrame === null || acceptAFrame.type !== "accept" || acceptAFrame.from !== acceptARecord.sender) {
      throw new Error("buyer: refusing to accept leg B — leg A accept record is not an authenticated accept frame (B3)");
    }
    if (acceptAFrame.ref !== this.offerA.id) {
      throw new Error("buyer: refusing to accept — the leg A accept does not reference this flow's own offer");
    }
    const expectedContractA = contractId(this.offerA, {
      from: acceptAFrame.from,
      ref: acceptAFrame.ref,
      statement: acceptAFrame.statement,
      ...(acceptAFrame.paymentKey === undefined ? {} : { paymentKey: acceptAFrame.paymentKey }),
      nonce: acceptAFrame.nonce,
    });
    if (acceptAFrame.contract !== expectedContractA) {
      throw new Error("buyer: refusing to accept leg B — leg A accept's contract id does not match this offer/accept pair (C4)");
    }

    if (offerBRecord.room !== OFFER_ROOM || !verifyTranscriptRecord(offerBRecord).ok) {
      throw new Error("buyer: refusing to accept leg B — leg B offer record does not authenticate (C2)");
    }
    const offerB = tryDecodeFrame(offerBRecord.line);
    if (offerB === null || offerB.type !== "offer" || offerB.from !== offerBRecord.sender) {
      throw new Error("buyer: refusing to accept leg B — leg B offer record is not an authenticated offer frame (C2)");
    }

    if (acceptAFrame.from !== offerB.from) {
      throw new Error("buyer: refusing to accept leg B — leg A accept is not from the Seller who posted leg B's offer (B3)");
    }
    const legAClassification = classifySwapOffer(this.offerA);
    if (legAClassification === null || legAClassification.context.leg !== "a") {
      throw new Error("buyer: refusing to accept — this flow's own leg A offer is not a valid swap leg");
    }
    const classification = classifySwapOffer(offerB);
    if (classification === null || classification.context.leg !== "b" || classification.context.legAOfferId !== this.offerA.id) {
      throw new Error("buyer: refusing to accept — offer is not leg B of this swap");
    }
    const orientation = checkOrientation(offerB, classification.context);
    if (!orientation.ok) {
      throw new Error(`buyer: refusing to accept an unsafe leg B offer: ${orientation.reason}`);
    }
    const pairCheck = checkLegBMatchesWant(offerB, legAClassification.context);
    if (!pairCheck.ok) {
      throw new Error(`buyer: refusing to accept leg B — ${pairCheck.reason} (C2)`);
    }
    const deadlineCheck = checkSwapDeadlines(this.offerA, offerB, lockTimeMs, this.rail.policy);
    if (!deadlineCheck.ok) {
      throw new Error(`buyer: refusing to accept leg B — unsafe deadlines: ${deadlineCheck.violations.join("; ")}`);
    }

    if (this.store !== undefined) return this.acceptLegBPersisted(offerBRecord, acceptARecord, acceptAFrame, offerB, lockTimeMs);

    const acceptB = makeAccept(offerB, { from: this.identity.did, statement: acceptAFrame.statement });
    const acceptBRecord = await this.venue.post("tclk-offers", encodeFrame(acceptB), this.identity);

    this.offerB = offerB;
    this.acceptA = acceptAFrame;
    this.acceptB = acceptB;
    return { acceptB, acceptBRecord };
  }

  /**
   * P8 (rules 1 and 3): the store-backed half of `acceptLegB`, after every guard above ran again. The pairing (both
   * signed records, the contracts, the lock time, leg B's deadlines, the exact text of accept B) is saved BEFORE accept
   * B is posted; a repeat reuses those frames only (a different pairing is refused) and posts accept B once, or adopts
   * it from the room.
   */
  private async acceptLegBPersisted(
    offerBRecord: TranscriptRecord,
    acceptARecord: TranscriptRecord,
    acceptAFrame: AcceptFrame,
    offerB: OfferFrame,
    lockTimeMs: number,
  ): Promise<{ acceptB: AcceptFrame; acceptBRecord: TranscriptRecord }> {
    const journal = this.#journal;
    if (journal === undefined) throw new Error("buyer: no leg A offer to pair leg B against");
    const stored = journal.record;
    const storedAcceptB = acceptFromSlot(`buyer:${stored.swapId}`, "acceptB", stored.frames.acceptB);
    let acceptB: AcceptFrame;
    if (storedAcceptB !== undefined) {
      if (stored.frames.offerB?.text !== offerBRecord.line || stored.frames.acceptA?.text !== acceptARecord.line) {
        throw new FlowRecordConflictError("buyer: a different pairing than the one this swap saved; a party never posts a second, different accept");
      }
      acceptB = storedAcceptB;
    } else {
      acceptB = makeAccept(offerB, { from: this.identity.did, statement: acceptAFrame.statement });
      const chosen = acceptB;
      await journal.update((r) => ({
        ...r,
        contractA: acceptAFrame.contract,
        contractB: chosen.contract,
        lockTimeMs,
        legB: { claimByMs: offerB.claimByMs, refundAfterMs: offerB.refundAfterMs, expiresMs: offerB.expiresMs },
        frames: {
          ...r.frames,
          acceptA: { text: acceptARecord.line, record: recordToJson(acceptARecord) },
          offerB: { text: offerBRecord.line, record: recordToJson(offerBRecord) },
          acceptB: { text: encodeFrame(chosen) },
        },
      }));
    }
    const acceptBRecord = await journal.ensurePosted({ kind: "accept-b", room: OFFER_ROOM, text: encodeFrame(acceptB), slot: "acceptB" });
    this.offerB = offerB;
    this.acceptA = acceptAFrame;
    this.acceptB = acceptB;
    this.offerBRecord = offerBRecord;
    this.acceptARecord = acceptARecord;
    this.acceptBRecord = acceptBRecord;
    return { acceptB, acceptBRecord };
  }

  /** Verify leg B is actually locked on the paper rail before trusting it as cover for locking
   *  leg A — a signed `lock` frame alone is not evidence of anything (tclk#180). */
  async verifyLegBLocked(): Promise<void> {
    this.usable();
    const { offerB, acceptB } = this.requirePaired();
    const termsB = offerAcceptLockTerms(offerB, acceptB);
    const verified = await this.paperRail.verifyLock(termsB, acceptB.contract);
    if (!verified) {
      throw new Error("buyer: refusing to proceed — leg B does not verify on the paper rail");
    }
    this.legBVerified = true;
    await this.persist(); // P8
  }

  /** Post this Buyer's own proven leg-A account/key line (D-08) into leg A's deal room. Required
   *  (P7 fix pass F1): `lockLegA` refuses without it, and the Seller and every evidence reader need
   *  it to bind the lock's payer to this DID. */
  async postAccountLineA(address: string): Promise<TranscriptRecord> {
    this.usable();
    if (this.accountLinePending) throw new Error("buyer: refusing to post the account line - another postAccountLineA call is already in flight (R1-16)");
    this.accountLinePending = true;
    try {
      return await this.postAccountLineAUnlatched(address);
    } finally {
      this.accountLinePending = false;
    }
  }

  private async postAccountLineAUnlatched(address: string): Promise<TranscriptRecord> {
    const { offerA, acceptA } = this.requirePaired();
    const journal = this.#journal;
    if (journal === undefined) {
      // P7: a proven line - the chain key signs a message binding this DID and this leg's contract.
      const line = await this.rail.proveAccountLine({
        address,
        did: this.identity.did,
        contract: acceptA.contract,
        terms: offerAcceptLockTerms(offerA, acceptA),
      });
      return this.venue.post(dealRoom(acceptA.contract), line, this.identity);
    }
    // P8 (rules 1 and 3): the proven line is built ONCE and its exact text saved before it is posted; a repeat (or a
    // resumed call) re-posts only that text, only when the room lacks it, and never once this Buyer's lock was
    // attempted (a line after the lock frame would not count). A different address than the saved one is refused:
    // a party never posts a second, different account line.
    const saved = journal.record.ownAccountLine;
    if (saved !== undefined && saved.address !== address) {
      throw new FlowRecordConflictError("buyer: this swap's account line was already built for another address; a party never posts a second, different account line");
    }
    let text: string;
    if (saved !== undefined) {
      text = saved.text;
    } else {
      text = await this.rail.proveAccountLine({
        address,
        did: this.identity.did,
        contract: acceptA.contract,
        terms: offerAcceptLockTerms(offerA, acceptA),
      });
      await journal.update((r) => ({ ...r, ownAccountLine: { address, text } }));
    }
    return journal.ensurePosted({
      kind: "account-a",
      room: dealRoom(acceptA.contract),
      text,
      guard: () => {
        if (this.legALockAttempted || journal.hasEntry("lock-a")) {
          throw new FlowRecordConflictError("buyer: refusing to post the account line - this Buyer's lock was already attempted, so a line posted now would not count (rule 3)");
        }
      },
    });
  }

  /**
   * Lock leg A on this flow's counter-asset rail — refused until leg B has verified
   * (`verifyLegBLocked`) and both proven account lines resolve in leg A's deal room (the Seller's and,
   * since the P7 fix pass, this Buyer's own). The rail's own connected handle resolves the payee's
   * address/pubkey right before the one write (`lock`) that ever needs it.
   *
   * P22-P24-EVM-FIXES.md B3: re-runs `checkSwapDeadlines` (the pinned `EVM_LOCAL_POLICY`) with
   * `clock()` as the lock time before doing anything else — a pair that was safe when
   * `acceptLegB` checked it is not guaranteed to still be safe by the time this method actually
   * runs (a slow runner, a delayed leg B lock), and this is the last check before this Buyer
   * spends real value.
   *
   * P22-P24-EVM-FIXES-R3.md E1: also re-verifies leg B is *still* locked on the paper rail,
   * immediately before locking — `legBVerified` is a flag `verifyLegBLocked` set once and
   * never revisits; it is not evidence leg B is still locked right now, only that it was at some
   * earlier moment this flow chose to check. Closes the same window B3 already closes for the
   * deadline arithmetic, for leg B's own lock state instead.
   */
  async lockLegA(): Promise<{ hashLock: string; writeEvidence: RailWriteEvidence }> {
    this.usable(); // R1-03
    // P4-BTC-FIXES.md G2: refuse outright when this leg's lock has already been attempted
    // (whether or not it is known to have succeeded), or another call is already in flight —
    // checked, and the in-flight flag set, before anything else runs (including before this
    // method's first `await`), the same re-entry pattern `acceptLegB`/`SellerFlow.lockLegB` use
    // for their own latches. `reconcileLockA()` is the only way past a set `legALockAttempted`.
    // P8: with a store, a lock that was attempted without a known outcome is not refused but RECOVERED (in
    // `lockLegAUnlatched`); a same-process double call is still refused while one is in flight.
    if (this.legALockPending || (this.legALockAttempted && this.#journal === undefined)) {
      throw new Error("buyer: refusing to lock leg A — already attempted, or a lock is already in flight (G2)");
    }
    this.legALockPending = true;
    try {
      return await this.lockLegAUnlatched();
    } finally {
      this.legALockPending = false;
    }
  }

  private async lockLegAUnlatched(): Promise<{ hashLock: string; writeEvidence: RailWriteEvidence }> {
    if (!this.legBVerified) {
      throw new Error("buyer: refusing to lock leg A before leg B verifies");
    }
    const { offerA, offerB, acceptA, acceptB } = this.requirePaired();

    // P8: a lock the record shows as confirmed is not touched again; only its lock frame may still be missing.
    if (this.#journal !== undefined && this.lockEvidence !== undefined && this.lockedHashLock !== undefined) {
      await this.announceLockA(acceptA.contract, this.lockEvidence.ref);
      return { hashLock: this.lockedHashLock, writeEvidence: this.lockEvidence };
    }
    // P8, R1-01: a lock attempted without a known outcome (a crash, a failed reply) is RECOVERED, and recovery READS THE CHAIN
    // FIRST. Rule 4's guards (the deadline arithmetic, leg B's note, the chain clock, ...) gate every NEW outward action: a fresh
    // lock, a re-send of the saved bytes. Recognising a lock that already landed, recording it and posting its frame is not a new
    // lock and happens whatever the clock says; before this fix a guard that failed after the crash (the clock had moved on, the
    // Seller had claimed and so leg B's note read claimed) stopped the call before the chain was read, `next` stayed lockLegA for
    // ever, and the Buyer never learnt the secret of a lock that was already claimed. The Seller's own claim guards decide whether
    // a recorded lock can still be claimed.
    if (this.#journal !== undefined && this.legALockAttempted) return this.recoverLockA(offerA, offerB, acceptA, acceptB);

    await this.checkLockGuards(offerA, offerB, acceptB);

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    const accounts = this.rail.resolveAccounts(dealRoomARecords, {
      contract: acceptA.contract,
      payerDid: termsA.payer,
      payeeDid: termsA.payee,
    });
    this.checkAccounts(accounts);

    const connected = await this.rail.connect(termsA, accounts);
    await this.checkChainClock(connected);

    const fromBlock = await connected.currentBlockMarker();

    // G3 (client half of H2): build (and, for a rail that needs one, sign) the lock transaction
    // WITHOUT broadcasting it yet - `prepared.ref` is already fully determined at this point (a
    // Bitcoin outpoint hashes the prepared transaction's own bytes; an EVM ref is simply the
    // hashLock, already known regardless).
    const prepared = await connected.prepareLock(termsA, 0);

    // P22-P24-EVM-FIXES-R3.md E3 + P4-BTC-FIXES.md G1/G3: record everything `refundLegA`/
    // `learnSecret` will ever need BEFORE this flow ever risks a broadcast - the hash lock
    // (always known in advance), the resolved accounts (G1: frozen here, permanently, so a
    // pubkey/account line posted after this point can neither add to nor conflict with what this
    // flow already committed to acting on), and the rail's own write ref (G3: already known from
    // `prepared`, not from whatever `commitLock` eventually returns - a failed evidence capture
    // or a failed lock-frame post, or even a flaky read on the broadcast's own response, must
    // never leave this flow believing leg A was "never locked" when the write may already have
    // reached the network).
    const hashLock = termsA.statement;
    this.lockedHashLock = hashLock;
    this.lockedFromBlock = fromBlock;
    this.lockedAccounts = accounts;
    this.lockedRailRef = prepared.ref;

    // G2: from this point on this flow can no longer be sure a retry would not double-fund -
    // latch it permanently, right before the one call that might actually reach the network.
    this.legALockAttempted = true;
    this.preparedLock = prepared;
    // P8 (rule 1): the prepared lock (ref plus the rail's recovery handle), the hash lock, the marker and the frozen
    // accounts are durable BEFORE the broadcast. If this save fails nothing was sent; if another instance saved first the
    // compare-and-swap refuses this one (R1-02) and, as for any refused save, the flow is dead until `resume()` (R1-03).
    await this.persist();

    const before = connected.exchanges.length;
    const writeEvidence = await connected.commitLock();
    this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
    this.lockEvidence = writeEvidence;
    await this.persist();

    // P4-BTC-FIXES-R3.md K5: posting the lock frame is broken out into its own idempotent method
    // (`announceLockA`) so `reconcileLockA` can re-post it later if THIS post itself is what fails
    // (or is lost) - a genuinely-funded outpoint must never stay invisible to tclk's own machine
    // just because the one frame that would have announced it never landed.
    await this.announceLockA(acceptA.contract, writeEvidence.ref);

    return { hashLock, writeEvidence };
  }

  /**
   * Rule 4's guards for a NEW lock action (R1-01): a fresh lock, or the re-send of a saved one. The deadline arithmetic is
   * re-run with `clock()` as the lock time (P22-P24-EVM-FIXES.md B3); the asset, the amount floor and leg B's match to leg A's
   * want are re-checked (K3, G6, C2: defence in depth where real value is spent); and leg B must still verify on the paper
   * rail right now (E1: `legBVerified` is only "was true once"). Never run to RECOGNISE a lock that already landed.
   */
  private async checkLockGuards(offerA: OfferFrame, offerB: OfferFrame, acceptB: AcceptFrame): Promise<void> {
    const deadlineCheck = checkSwapDeadlines(offerA, offerB, this.clock(), this.rail.policy);
    if (!deadlineCheck.ok) {
      throw new Error(
        `buyer: refusing to lock leg A — deadlines are no longer safe at lock time (B3): ${deadlineCheck.violations.join("; ")}`,
      );
    }

    // K3: re-check the asset at lock time too — defense in depth, since `offerA.asset` cannot
    // have changed since `bid()` already checked it, but spending real value is exactly the
    // place to check "should never" rather than assume it.
    if (this.rail.assetId !== undefined && offerA.asset !== this.rail.assetId) {
      throw new Error(
        `buyer: refusing to lock leg A — asset "${offerA.asset}" does not match this rail's own asset "${this.rail.assetId}" (K3)`,
      );
    }

    // G6: re-check the amount floor at lock time too — defense in depth, since `offerA.amount`
    // cannot have changed since `bid()` already checked it, but spending real value is exactly
    // the place to check "should never" rather than assume it.
    if (belowMinLockable(this.rail, offerA.amount)) {
      throw new Error(
        `buyer: refusing to lock leg A — ${offerA.amount} ${offerA.asset} is below this rail's minimum lockable amount ` +
          `${this.rail.minLockableAmount} (G6)`,
      );
    }

    // C2: re-check leg B still answers what leg A asked for, the same way B3 re-checks
    // deadlines above — defense in depth, since this flow's own stored `offerA`/`offerB` should
    // never actually disagree with what `acceptLegB` already checked, but spending real value is
    // exactly the place to check "should never" rather than assume it.
    const legAClassification = classifySwapOffer(offerA);
    if (legAClassification === null || legAClassification.context.leg !== "a") {
      throw new Error("buyer: refusing to lock leg A — this flow's own leg A offer is not a valid swap leg");
    }
    const pairCheck = checkLegBMatchesWant(offerB, legAClassification.context);
    if (!pairCheck.ok) {
      throw new Error(`buyer: refusing to lock leg A — leg B no longer matches what leg A asked for: ${pairCheck.reason} (C2)`);
    }

    // E1: leg B must still verify right now, not merely have verified once.
    const termsB = offerAcceptLockTerms(offerB, acceptB);
    const legBStillLocked = await this.paperRail.verifyLock(termsB, acceptB.contract);
    if (!legBStillLocked) {
      throw new Error("buyer: refusing to lock leg A — leg B no longer verifies on the paper rail (E1)");
    }
  }

  /** D-08 and P7 (F1): the Seller's account line must have resolved, and so must this Buyer's own proven payer line. */
  private checkAccounts(accounts: RailAccounts): void {
    if (accounts.payee === undefined) {
      throw new Error("buyer: refusing to lock leg A — the Seller's account line has not resolved (D-08)");
    }
    // P7 fix pass (F1): our own proven payer line must also resolve before we lock. The Seller
    // and every evidence reader now require it; locking without it would only produce a lock that
    // reads unverified everywhere.
    if (accounts.payer === undefined) {
      throw new Error("buyer: refusing to lock leg A, our own proven payer account line has not resolved (P7)");
    }
  }

  /** R3-7 (Solana only): refuse to lock while the chain's finalized clock and the local clock disagree by more than the
   *  named bound. Known limit: the Buyer's protection on Solana is legB.refundAfterMs - legA.refundAfterMs; a halt or a
   *  clock lag longer than that is not covered. */
  private async checkChainClock(connected: ConnectedCounterAssetRail): Promise<void> {
    if (this.rail.railId !== SOL_RAIL_ID) return;
    const problem = chainClockProblem(await connected.chainTimeMs(), this.clock(), this.rail.maxChainClockSkewMs);
    if (problem !== null) throw new Error(`buyer: refusing to lock leg A - ${problem}`);
  }

  /**
   * P4-BTC-FIXES-R3.md K5: post this leg's own `lock` frame for the recorded outpoint —
   * idempotent (posts at most once per flow; tclk's own machine would reject a second `lock` for
   * an already-locked contract anyway, but this flag saves the round trip). Called directly by
   * `lockLegAUnlatched` right after a successful `commitLock`, and again by `reconcileLockA`
   * whenever the chain itself already shows the funding landed — so a lost `commitLock` reply, OR
   * a lock-frame post that itself failed the first time, never leaves a genuinely-funded outpoint
   * unannounced to tclk's own machine (which would otherwise eventually read as "never locked" and
   * force the swap toward refunds).
   */
  private async announceLockA(contract: string, ref: string): Promise<void> {
    if (this.lockFramePosted) return;
    const line = encodeFrameWith({ type: "lock", from: this.identity.did, contract, rail: this.rail.railId, ref }, this.rail.railRegistry);
    if (this.#journal !== undefined) {
      // P8 (rules 1 and 3): the exact text is saved before the post; a lock frame already in the room is adopted.
      await this.#journal.ensurePosted({ kind: "lock-a", room: dealRoom(contract), text: line });
    } else {
      await this.venue.post(dealRoom(contract), line, this.identity);
    }
    this.lockFramePosted = true;
    await this.persist();
  }

  /**
   * P8-RESUME-SPEC.md "Buyer lock A" (rules 1, 2 and 4), review round 1 R1-01: what a saved lock turned into. The chain is
   * READ FIRST, before any guard, because recognising a lock that already landed is not a new lock:
   *   - `landed`: the evidence is recorded and the lock frame is posted (once, as the saved text, or adopted), whatever the
   *     clock says, whatever leg B's note says, whatever the chain clock says. The Seller's own claim guards decide what can
   *     still follow; the Buyer is then routed to `learnSecret` (a claim) or `refundLegA` (after the refund time).
   *   - `pending`: `LockPendingError`; nothing was signed and nothing is sent.
   *   - `unknown` (Bitcoin: the node does not know the funding; NEAR: not known, no row, nonce not past) and `never-landed`
   *     (the rail proved the transaction can no longer land): from here on a NEW outward action may follow, so EVERY guard of
   *     the original `lockLegA` runs first. `unknown` is then settled by `resendLock`, which sends the identical saved bytes
   *     once (never a second funding; a node that refuses them is a typed error for a person); `never-landed` leads to
   *     exactly one fresh `prepareLock`, which is saved, then sent, and whose ref must be the saved one (a different one is
   *     refused).
   * The accounts are the ones frozen at the first attempt; the deal room is not read again (G1).
   */
  private async recoverLockA(
    offerA: OfferFrame,
    offerB: OfferFrame,
    acceptA: AcceptFrame,
    acceptB: AcceptFrame,
  ): Promise<{ hashLock: string; writeEvidence: RailWriteEvidence }> {
    const prepared = this.preparedLock;
    const hashLock = this.lockedHashLock;
    if (prepared === undefined || hashLock === undefined) {
      throw new Error("buyer: a lock was attempted but its prepared handle was not recorded; refusing to guess (rule 6)");
    }
    // G1: the accounts frozen at the first attempt.
    const accounts = this.lockedAccounts;
    if (accounts === undefined) throw new Error("buyer: refusing to recover the lock - its resolved accounts were never recorded");
    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const connected = await this.rail.connect(termsA, accounts);

    let outcome: LockRecoveryOutcome = await connected.recoverLock(prepared);
    if (outcome === "landed") return this.recordLockLanded(prepared, hashLock, acceptA.contract);
    if (outcome === "pending") throw new LockPendingError(prepared.ref);

    // `unknown` or `never-landed`: the next thing this flow does is a NEW outward action. Every guard first (rule 4).
    await this.checkLockGuards(offerA, offerB, acceptB);
    this.checkAccounts(accounts);
    await this.checkChainClock(connected);

    if (outcome === "unknown") {
      // `recoverLock` only READS (R1-01 part 2). The node does not know the transaction and the rail cannot prove it dead, so the
      // identical saved bytes are sent once more. A rail that answers `unknown` and has no `resendLock` cannot be recovered by this
      // flow: nothing is guessed.
      if (connected.resendLock === undefined) {
        throw new RailRecoveryRefusedError("no-handle", prepared.ref, "the rail does not know this transaction and offers no way to send it again");
      }
      outcome = await connected.resendLock(prepared);
      if (outcome === "landed") return this.recordLockLanded(prepared, hashLock, acceptA.contract);
      if (outcome === "pending") throw new LockPendingError(prepared.ref);
    }

    // never-landed: the rail proved the first transaction can no longer land, so ONE fresh lock for the same terms is built
    const fresh = await connected.prepareLock(termsA, 0);
    if (fresh.ref !== prepared.ref) {
      throw new RailRecoveryRefusedError("handle-mismatch", prepared.ref, `a fresh prepareLock named ${fresh.ref}; the saved lock is never replaced by a different one`);
    }
    this.preparedLock = fresh;
    await this.persist(); // BEFORE the second send
    const before = connected.exchanges.length;
    const writeEvidence = await connected.commitLock();
    this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
    this.lockEvidence = writeEvidence;
    await this.persist();
    await this.announceLockA(acceptA.contract, writeEvidence.ref);
    return { hashLock, writeEvidence };
  }

  /** The chain showed this flow's lock (R1-01: no guard applies): its evidence is recorded and its frame is posted. */
  private async recordLockLanded(prepared: PreparedLock, hashLock: string, contract: string): Promise<{ hashLock: string; writeEvidence: RailWriteEvidence }> {
    const writeEvidence: RailWriteEvidence = { ref: prepared.ref, raw: [], ...(prepared.recovery?.chain === "btc" ? { txid: prepared.recovery.txid } : {}) };
    this.lockEvidence = writeEvidence;
    await this.persist();
    await this.announceLockA(contract, writeEvidence.ref);
    return { hashLock, writeEvidence };
  }

  /**
   * P4-BTC-FIXES.md G2: the only way forward after a `lockLegA` call that threw once a lock has
   * already been attempted — recovers the truth about that ONE attempt from the chain itself
   * (via the recorded `lockedRailRef`), rather than ever funding a second time. `{ locked: false
   * }` when this flow never even got as far as recording a prepared ref (nothing to check yet);
   * a genuine `verifyLockFinal` observation (locked, claimed or refunded) at any point after that
   * reports `{ locked: true }`.
   *
   * P4-BTC-FIXES-R3.md K5: whenever the chain itself already shows the funding landed, this also
   * (re-)announces it (`announceLockA`) — a lost `commitLock` reply, or a lock-frame post that
   * itself failed, must not force the swap toward refunds just because tclk's own machine never
   * saw the `lock` frame despite the money genuinely being on chain.
   */
  async reconcileLockA(): Promise<{ locked: boolean; verified: boolean; reason?: string }> {
    this.usable(); // R1-03
    if (!this.legALockAttempted) {
      throw new Error("buyer: nothing to reconcile — leg A lock was never attempted (G2)");
    }
    if (this.lockedRailRef === undefined || this.lockedAccounts === undefined) {
      return { locked: false, verified: false };
    }
    const { offerA, acceptA } = this.requirePaired();
    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const connected = await this.rail.connect(termsA, this.lockedAccounts);
    const evidence = await connected.verifyLockFinal(termsA, this.lockedRailRef, this.lockedAccounts);
    if (evidence.rail !== undefined) {
      await this.recordLockSeen(this.lockedRailRef);
      await this.announceLockA(acceptA.contract, this.lockedRailRef);
      return { locked: true, verified: true };
    }
    // P5-NEAR-FIXES.md G4: the strict evidence pipeline withheld `rail` — for near-htlc this
    // happens whenever ANY checked field disagrees, including the payee's own storage
    // registration, which has nothing to do with whether THIS signer's lock genuinely exists.
    // A rail that can cheaply confirm mere existence (`lockRecorded`) still lets this Buyer
    // announce and report it, rather than silently treating "unverified" as "never locked".
    if (connected.lockRecorded !== undefined) {
      const recorded = await connected.lockRecorded(this.lockedRailRef);
      if (recorded.exists) {
        await this.recordLockSeen(this.lockedRailRef);
        await this.announceLockA(acceptA.contract, this.lockedRailRef);
        return { locked: true, verified: false, ...(evidence.lock.reason === undefined ? {} : { reason: evidence.lock.reason }) };
      }
    }
    return { locked: false, verified: false, ...(evidence.lock.reason === undefined ? {} : { reason: evidence.lock.reason }) };
  }

  /** P8: the chain showed this flow's lock; with a store, that is the lock's confirmation (the same as `commitLock`
   *  having returned): `lockLegA` then only finishes the lock frame. */
  private async recordLockSeen(ref: string): Promise<void> {
    if (this.#journal === undefined || this.lockEvidence !== undefined) return;
    this.lockEvidence = { ref, raw: [], ...(this.preparedLock?.recovery?.chain === "btc" ? { txid: this.preparedLock.recovery.txid } : {}) };
    await this.persist();
  }

  /** The secret from an authenticated Seller `reveal` frame in leg A's deal room that opens the hash lock, or
   *  null. */
  private async revealFromFrames(contract: string, railRef: string, hashLock: string): Promise<string | null> {
    const dealRoomARecords = await this.venue.read(dealRoom(contract));
    for (const record of dealRoomARecords) {
      if (!verifyTranscriptRecord(record).ok) continue;
      const frame = tryDecodeFrame(record.line);
      if (frame === null || frame.type !== "reveal" || frame.from !== record.sender) continue;
      if (frame.contract !== contract) continue;
      // P4-BTC-FIXES.md G4: the reveal's own `ref` names the leg's RECORDED RAIL REF (see SellerFlow.claimLegA).
      if (frame.ref !== undefined && frame.ref !== railRef) continue;
      if (verifySecret("hash", hashLock, frame.secret)) return frame.secret;
    }
    return null;
  }

  /** Learn the secret from the Seller's signed `reveal` frame when it posted one, or (SPEC
   *  §6 scenario 5) from the on-chain `Claimed` log when the Seller claimed without posting
   *  it — never guesses: a candidate preimage is only accepted once it actually opens the
   *  statement (`findClaimedPreimage` already re-checks this; `parseSwapContext`-level frame
   *  authentication covers the reveal-frame path here). */
  async learnSecret(): Promise<string> {
    this.usable(); // R1-03
    const { offerA, acceptA } = this.requirePaired();
    if (this.lockedHashLock === undefined) throw new Error("buyer: leg A has not been locked yet");
    const hashLock = this.lockedHashLock;
    // P22-P24-EVM-FIXES-R3.md E3's own recovery path: if `lockLegA`'s own write threw AFTER its
    // real on-chain effect landed but BEFORE it returned a `writeEvidence` (e.g. its bounded
    // event-log lookup found nothing), `lockedRailRef` was never set — fall back to the hashLock
    // recorded before the write ever ran, which IS a valid `evm-htlc` ref (the two coincide by
    // construction, `src/rails/evm-htlc.ts`'s own `lock()`). P4-BTC-FIXES.md G3 means this
    // fallback is no longer needed for `btc-htlc` either (the outpoint is recorded from
    // `prepareLock` before `commitLock` ever runs), but it is kept as a last resort.
    const railRef = this.lockedRailRef ?? hashLock;

    // S2-1 (Solana): the secret counts only once the escrow itself reads Claimed at finalized, and it is taken from the
    // escrow's stored preimage. A reveal frame alone, or a secret leaked by a FAILED claim, never lets the Buyer
    // claim leg B: a failed claim leaves no state and the Seller may not have been paid.
    if (this.rail.railId === SOL_RAIL_ID) {
      if (this.lockedAccounts === undefined) {
        throw new Error("buyer: refusing to guess the secret — leg A accounts were never resolved (G1)");
      }
      const connectedSol = await this.rail.connect(offerAcceptLockTerms(offerA, acceptA), this.lockedAccounts);
      const stored = await connectedSol.findClaimedPreimage(railRef, this.lockedFromBlock);
      if (stored === null) throw new Error("buyer: leg A not claimed on chain yet (the escrow does not read Claimed at finalized)");
      return stored;
    }

    const fromFrame = await this.revealFromFrames(acceptA.contract, railRef, hashLock);
    if (fromFrame !== null) return fromFrame;

    // P4-BTC-FIXES.md G1: use the accounts frozen at lock time — never re-read/re-resolve the
    // room here (a line posted after funding must neither help nor hinder this read).
    if (this.lockedAccounts === undefined) {
      throw new Error("buyer: refusing to guess the secret — leg A accounts were never resolved (G1)");
    }
    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const connected = await this.rail.connect(termsA, this.lockedAccounts);
    const preimage = await connected.findClaimedPreimage(railRef, this.lockedFromBlock);
    if (preimage === null) {
      throw new Error("buyer: refusing to guess the secret — no reveal frame and no Claimed log yet");
    }
    return preimage;
  }

  /** Claim leg B on the paper rail with the learned secret, then reveal it there too (SPEC:
   *  the Buyer's own reveal on leg B, distinct from the Seller's reveal on leg A). */
  async claimLegB(secret: string): Promise<{ reveal: TranscriptRecord; receipt: TranscriptRecord }> {
    this.usable(); // R1-03
    if (this.legBClaimPending) throw new Error("buyer: refusing to claim leg B - another claimLegB call is already in flight (R1-16)");
    this.legBClaimPending = true;
    try {
      return await this.claimLegBUnlatched(secret);
    } finally {
      this.legBClaimPending = false;
    }
  }

  private async claimLegBUnlatched(secret: string): Promise<{ reveal: TranscriptRecord; receipt: TranscriptRecord }> {
    const { offerB, acceptB } = this.requirePaired();
    const termsB = offerAcceptLockTerms(offerB, acceptB);
    if (!verifySecret(termsB.lock, termsB.statement, secret)) {
      throw new Error("buyer: refusing to claim leg B — secret does not open its statement");
    }
    // S2-1 (Solana): leg B is claimed only while leg A reads Claimed at finalized with this very secret.
    if (this.rail.railId === SOL_RAIL_ID) {
      const { offerA, acceptA } = this.requirePaired();
      const railRef = this.lockedRailRef ?? this.lockedHashLock;
      if (railRef === undefined || this.lockedAccounts === undefined) {
        throw new Error("buyer: refusing to claim leg B — leg A was never locked by this flow");
      }
      const connectedSol = await this.rail.connect(offerAcceptLockTerms(offerA, acceptA), this.lockedAccounts);
      const stored = await connectedSol.findClaimedPreimage(railRef, this.lockedFromBlock);
      if (stored === null || stored !== secret) {
        throw new Error("buyer: refusing to claim leg B — leg A is not Claimed on chain with this secret yet (S2-1)");
      }
    }
    const revealText = encodeFrame({ type: "reveal", from: this.identity.did, contract: acceptB.contract, ref: acceptB.contract, secret });
    const receiptText = encodeFrame({ type: "receipt", from: this.identity.did, contract: acceptB.contract, outcome: "claimed", rail: "paper", ref: acceptB.contract });
    const journal = this.#journal;
    if (journal === undefined) {
      await this.paperRail.claim(acceptB.contract, secret);
      this.legBClaimed = true;
      const reveal = await this.venue.post(dealRoom(acceptB.contract), revealText, this.identity);
      const receipt = await this.venue.post(dealRoom(acceptB.contract), receiptText, this.identity);
      return { reveal, receipt };
    }
    // P8 (rules 1 and 3): the intent is saved BEFORE the note write. The repeated paper write that threw "claim on a
    // claimed record" is no longer reached: a note that already shows this very secret is a claim of this swap, and the missing
    // frames are posted (each once, as the saved text, or adopted). The reveal frame carries the secret, so its ledger
    // entry holds only the digest of its text (rule 5: the secret is on no record but the Seller's); the text is built
    // again from the secret learned again.
    //
    // R1-06: only a paper claim THIS call made (`paperRail.claim` returned) sets `legBClaimed`, which bars the refund of leg A. A note
    // that was already claimed with the secret may be this flow's own claim from before a crash, or a note the Seller (who always holds
    // the secret) or anyone holding a leaked one wrote at no cost: the flow cannot tell them apart, so the claim is ADOPTED (recorded
    // once, the frames posted) and never bars the refund. R1-07: a refusal that is definitive (the note is refunded, or leg B's refund
    // time has come) clears the attempt latch, so a claim that provably did not land never freezes the refund either.
    if (!this.legBClaimed && !this.legBClaimAdopted) {
      this.legBClaimAttempted = true;
      await this.persist();
      let ownClaim = true;
      try {
        await this.paperRail.claim(acceptB.contract, secret);
      } catch (error) {
        const note = await this.paperRail.read(acceptB.contract);
        if (note !== null && note.status === "claimed" && note.secret === secret) {
          ownClaim = false;
        } else {
          if (!this.legBNoteClaimable(note)) {
            this.legBClaimAttempted = false; // R1-07: the attempt provably did not land
            await this.persist();
          }
          throw error;
        }
      }
      if (ownClaim) this.legBClaimed = true;
      else this.adoptLegBClaim();
      await this.persist();
    }
    const reveal = await journal.ensurePosted({ kind: "reveal-b", room: dealRoom(acceptB.contract), text: revealText, digestOnly: true });
    const receipt = await journal.ensurePosted({ kind: "receipt-b", room: dealRoom(acceptB.contract), text: receiptText });
    if (this.legBClaimAdopted) await this.noteLegAClaimSeen();
    return { reveal, receipt };
  }

  /** R1-07: leg B's paper note can still take a claim: it reads locked and leg B's refund time has not come. */
  private legBNoteClaimable(note: Awaited<ReturnType<PaperRail["read"]>>): boolean {
    return note !== null && note.status === "locked" && this.clock() < note.refundAfterMs;
  }

  /** R1-06: leg B's note read claimed with this swap's secret and this flow's own claim never returned. The claim is adopted: recorded
   *  once (like a refund note, never one entry per call), and from here the refund of leg A stays available. */
  private adoptLegBClaim(): void {
    this.legBClaimAdopted = true;
    const note =
      "leg B's paper note read claimed with this swap's secret and this flow's own claim never returned: the claim is adopted, not this flow's own; " +
      "paper notes are not bound to who wrote them, so the refund of leg A stays available (R1-06)";
    if (!this.refundNotes.includes(note)) this.refundNotes.push(note);
  }

  /**
   * R1-07: `refundLegA` found a leg B claim ATTEMPT whose outcome is not recorded. Leg B's note decides, never the latch:
   *  - claimed with this swap's secret: the claim is adopted (R1-06) and the refund goes on;
   *  - not claimed and no longer claimable (refunded, missing, or leg B's refund time has come): the attempt provably did not land, the
   *    latch is cleared and saved, and the refund goes on;
   *  - still locked and claimable: the attempt may yet land or may have landed unseen: the latch stays and the refund is refused.
   */
  private async settleLegBClaimAttempt(): Promise<void> {
    const { offerB, acceptB } = this.requirePaired();
    const termsB = offerAcceptLockTerms(offerB, acceptB);
    const note = await this.paperRail.read(acceptB.contract);
    if (note !== null && note.status === "claimed" && verifySecret(termsB.lock, termsB.statement, note.secret ?? "")) {
      this.adoptLegBClaim();
      await this.persist();
      return;
    }
    if (this.legBNoteClaimable(note)) {
      throw new Error("buyer: refusing to refund leg A - a claim of leg B was attempted and its outcome is not recorded; call learnSecret() then claimLegB() to settle it first (P8)");
    }
    this.legBClaimAttempted = false;
    await this.persist();
  }

  /** R1-06: after a claim of leg B was adopted, look once at leg A. Claimed means nothing is left to refund, and only then can `next`
   *  say done. A failed read, or a leg A that is not claimed (yet), leaves `next` at `learnSecret`, the safe direction. */
  private async noteLegAClaimSeen(): Promise<void> {
    if (this.refundClaimSeen || this.lockedAccounts === undefined) return;
    const railRef = this.lockedRailRef ?? this.lockedHashLock;
    if (railRef === undefined) return;
    const { offerA, acceptA } = this.requirePaired();
    try {
      const termsA = offerAcceptLockTerms(offerA, acceptA);
      const connected = await this.rail.connect(termsA, this.lockedAccounts);
      const evidence = await connected.verifyLockFinal(termsA, railRef, this.lockedAccounts);
      if (evidence.rail?.status !== "claimed") return;
    } catch {
      return;
    }
    this.refundClaimSeen = true;
    await this.persist();
  }

  /**
   * Refund leg A only at/after `A.refundAfterMs` — the leg-A rail's own `refund` also enforces
   * this on-chain; this check exists so a caller sees this class's own reason.
   *
   * P4-BTC-FIXES.md G1: uses `lockedAccounts`, frozen at lock time — never re-reads the deal
   * room (a pubkey/account line posted after funding can neither block nor help this call, and
   * this method depends on nothing the venue could have changed since).
   *
   * G7: builds and signs at most one refund transaction ever (this build's fixed fee carries no
   * bump to retry with anyway, and Core 28+'s own full-RBF-by-default policy means it is the
   * mempool's call, not this flow's, whether a second identical broadcast would do anything), and
   * reports success — posting the refund/receipt frames, at most once — only once the evidence
   * reader itself shows the refund confirmed. A broadcast the mempool accepted is not by itself
   * evidence of what will actually end up spending the outpoint: after `T` the claim and the
   * refund race (no on-chain claim deadline, README "Bitcoin leg"), so this checks the real
   * outcome rather than assume the refund it just sent is the one that won.
   *
   * P4-BTC-FIXES-R2.md R2-1: a retry (this method called again after an earlier call found the
   * refund not yet confirmed) never rebuilds or re-signs anything — but it is no longer a bare
   * re-check either. The already-broadcast refund can drop out of the mempool (expiry, an RBF
   * eviction by an unrelated transaction) without ever confirming, and while it stays dropped the
   * HTLC output remains unspent and claimable by the Seller. So every retry re-checks the chain
   * and, on a rail that implements it (`resendRefundIfDropped`), re-sends the SAME recorded bytes
   * when they have genuinely dropped and the escrow is still unspent — idempotent (the identical
   * bytes reproduce the identical txid), never a new write. If the outpoint was instead claimed,
   * the read below still routes to `learnSecret`/`claimLegB`, exactly as before.
   */
  async refundLegA(): Promise<RailWriteEvidence> {
    this.usable(); // R1-03
    if (this.refundPending) throw new Error("buyer: refusing to refund leg A - another refundLegA call is already in flight (R1-16)");
    this.refundPending = true;
    try {
      return await this.refundLegAUnlatched();
    } finally {
      this.refundPending = false;
    }
  }

  private async refundLegAUnlatched(): Promise<RailWriteEvidence> {
    const { offerA, acceptA } = this.requirePaired();
    if (this.lockedHashLock === undefined) throw new Error("buyer: leg A was never locked, nothing to refund");
    if (this.clock() < offerA.refundAfterMs) {
      throw new Error("buyer: refusing to refund leg A before its refundAfterMs");
    }
    // E3's own recovery path (see the identical comment on `learnSecret`): fall back to the
    // pre-recorded hashLock when the write itself never returned a `writeEvidence` — valid for
    // `evm-htlc`, and no longer needed for `btc-htlc` since G3 records the outpoint before
    // `commitLock` ever runs.
    const railRef = this.lockedRailRef ?? this.lockedHashLock;
    if (this.lockedAccounts === undefined) {
      throw new Error("buyer: refusing to refund leg A — leg A accounts were never resolved (G1)");
    }
    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const connected = await this.rail.connect(termsA, this.lockedAccounts);

    // P4-BTC-FIXES-R3.md K2: read the outpoint's own state — including a claim that has only
    // been broadcast, not yet mined (K1) — BEFORE ever building a refund against it. Building one
    // anyway and letting the rail's own broadcast-time check discover the missing input is too
    // late to route anywhere useful (a raw rejection, never this class's own clear reason).
    // Main-loop review 2026-09-28: this runs on EVERY call, retries included. A Seller can
    // replace the Buyer's pending refund with a higher-fee claim (full replace-by-fee); a retry
    // that skipped this check kept answering "not yet confirmed" instead of routing the Buyer to
    // learnSecret()/claimLegB() while its window on leg B was still open.
    // This flow already claimed leg B: refunding leg A now would take both legs.
    if (this.legBClaimed) {
      throw new Error("buyer: refusing to refund leg A — this flow already claimed leg B");
    }
    // P8: a leg B claim that was attempted without a known outcome might have been written. R1-07: leg B's note decides, never the
    // latch alone: a claim of this swap's secret is adopted (R1-06), one that provably did not land clears the latch, and only an
    // attempt that may still land refuses the refund (fail closed).
    if (this.legBClaimAttempted && !this.legBClaimAdopted) await this.settleLegBClaimAttempt();
    // R4-2 (Solana): leg A's own Claimed state is checked FIRST. On Solana (S2-1) `checkPendingClaim` reads only the
    // escrow's own state at finalized (Claimed and its stored preimage): no history scan, so nothing anyone can pad. A
    // paid Seller must always get the "call learnSecret() then claimLegB()" routing, never "leg A is owed". A leak by a
    // FAILED claim is not a payment and does not stop the refund: the Buyer never claims leg B on it.
    if (connected.checkPendingClaim !== undefined) {
      const pendingSecret = await connected.checkPendingClaim(railRef, this.lockedFromBlock);
      if (pendingSecret !== null) {
        return this.routeToClaim(
          "buyer: refusing to refund leg A — the lock has been claimed (on chain or already broadcast); " +
            "call learnSecret() then claimLegB() instead of refundLegA() (K2)",
        );
      }
    }
    // R3-6 / R4-1 / RR4-1 (Solana): leg B's own record is read next, and only before this flow's first refund
    // broadcast (RR4-2: once a refund was sent, a note cannot stop it and must not stop the retry that posts its
    // frames). This flow's leg B is the PAPER rail: its note is unauthenticated and moves no value, and the Seller (who
    // always holds the secret) or anyone holding a leaked secret can write a valid "claimed" note at no cost. Obeying
    // such a note would let them freeze the Buyer's real refund of leg A forever (round-4 re-review, proven), while a
    // paper "claimed" means nobody was paid. So the note is only RECORDED in `refundNotes` (proven: "the secret is
    // public and leg B's paper note reads claimed"; otherwise: ignored as not a proven claim) and the refund goes
    // ahead. `LegBClaimedError` is reserved for a value-bearing leg-B rail with bound chain evidence (none in this build).
    if (this.rail.railId === SOL_RAIL_ID && this.legARefundEvidence === undefined) {
      const { offerB, acceptB } = this.requirePaired();
      const legBRecord = await this.paperRail.read(acceptB.contract);
      if (legBRecord !== null && legBRecord.status === "claimed") {
        const termsB = offerAcceptLockTerms(offerB, acceptB);
        const proven =
          legBRecord.lock === termsB.lock &&
          legBRecord.statement === termsB.statement &&
          legBRecord.refundAfterMs === termsB.refundAfterMs &&
          verifySecret(termsB.lock, termsB.statement, legBRecord.secret ?? "");
        const note = proven
          ? "leg B's paper note is a proven claim: the secret is public and leg B's paper note reads claimed; paper moves no value, so the refund of leg A goes ahead (RR4-1)"
          : "leg B's paper note reads claimed but is not a proven claim (terms differ or its secret does not open the statement): ignored (R4-1)";
        // R1-09: a note is recorded ONCE. This block runs on every call until the refund's evidence exists, and every failed
        // attempt (an RPC outage, say) used to append the same text again; the stored list is capped, so after 64 attempts every
        // save failed before the refund was signed, in this process and after a restart. The same text is never recorded twice.
        if (!this.refundNotes.includes(note)) this.refundNotes.push(note);
      }
    }

    const journal = this.#journal;
    if (this.legARefundEvidence === undefined && journal !== undefined && this.refundAttempted) {
      await this.recoverRefundA(connected, termsA, railRef);
    }
    if (this.legARefundEvidence === undefined) {
      const before = connected.exchanges.length;
      // P8 (rule 1): the intent is saved BEFORE the rail signs, and the signature (the rail's recovery handle) BEFORE it
      // is sent (`onSigned`), so a restart never builds a second refund while the first may be pending (rule 2).
      let recorder: RailRefundOptions | undefined;
      if (journal !== undefined) {
        this.refundAttempted = true;
        await this.persist();
        recorder = {
          onSigned: async (recovery: LockRecovery): Promise<void> => {
            this.refundRecovery = recovery;
            await this.persist();
          },
          onNotBroadcast: async (): Promise<void> => {
            this.refundRecovery = undefined;
            await this.persist();
          },
        };
      }
      try {
        this.legARefundEvidence = recorder === undefined ? await connected.refund(railRef) : await connected.refund(railRef, recorder);
        this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
      } catch (error) {
        this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
        // P5-NEAR-FIXES.md G2: a retry after a lost reply from an ALREADY-successful refund must
        // recognise success from the chain rather than surface the write's own "not refundable"
        // refusal as failure (near-htlc's own `refund()` throws exactly that once `get_lock`
        // shows the lock is no longer `Locked` — which is also what a genuinely-succeeded-but-
        // lost-reply refund looks like on the next read). Only ever treated as success once the
        // evidence reader itself confirms `refunded`+final; any other outcome rethrows the
        // original error unchanged.
        const priorEvidence = await connected.verifyLockFinal(termsA, railRef, this.lockedAccounts);
        if (priorEvidence.rail?.status === "refunded" && priorEvidence.rail.final) {
          this.legARefundEvidence = { ref: railRef, raw: [] };
        } else if (priorEvidence.rail?.status === "claimed") {
          // R3-8 (Solana) and R1-15 (every rail): the refund failed because the lock was claimed (in the finality-lag window,
          // or by a claim the pre-check could not see yet): route to the claim path instead of surfacing the refund's own refusal.
          return this.routeToClaim(
            "buyer: refusing to refund leg A - the lock was claimed (seen after the refund failed); " +
              "call learnSecret() then claimLegB() instead of refundLegA() (R3-8)",
          );
        } else {
          throw error;
        }
      }
    } else if (connected.resendRefundIfDropped !== undefined) {
      // R2-1: a retry — the earlier broadcast may simply still be pending, or it may have
      // genuinely dropped out of the mempool while the HTLC stays unspent. Never re-builds or
      // re-signs; a rail with no such concept (evm-htlc) leaves `legARefundEvidence` untouched.
      const before = connected.exchanges.length;
      this.legARefundEvidence = await connected.resendRefundIfDropped(railRef, this.legARefundEvidence);
      this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
    }
    await this.persist(); // P8: the refund's evidence

    const evidence = await connected.verifyLockFinal(termsA, railRef, this.lockedAccounts);
    if (evidence.rail?.status === "claimed") {
      return this.routeToClaim(
        "buyer: refusing to report leg A refunded — the lock was claimed instead (the refund lost the race to a claim); " +
          "call learnSecret() then claimLegB() instead of refundLegA() (G7)",
      );
    }
    if (evidence.rail === undefined || evidence.rail.status !== "refunded" || !evidence.rail.final) {
      throw new Error(REFUND_UNCONFIRMED);
    }

    if (!this.legARefundFramesPosted) {
      // tclk's own machine requires a refund/receipt frame's `ref`, when present, to equal the
      // contract's own accepted `railRef` (vendor/tclk/src/machine.ts) — the rail's own write
      // ref, never `lockedHashLock` (only ever true by coincidence for evm-htlc).
      const refundText = encodeFrame({ type: "refund", from: this.identity.did, contract: acceptA.contract, ref: railRef });
      const receiptText = encodeFrameWith({ type: "receipt", from: this.identity.did, contract: acceptA.contract, outcome: "refunded", rail: this.rail.railId, ref: railRef }, this.rail.railRegistry);
      if (journal !== undefined) {
        // P8 (rules 1 and 3): each frame once, as the saved text, or adopted from the room.
        await journal.ensurePosted({ kind: "refund-a", room: dealRoom(acceptA.contract), text: refundText });
        await journal.ensurePosted({ kind: "receipt-refund-a", room: dealRoom(acceptA.contract), text: receiptText });
      } else {
        await this.venue.post(dealRoom(acceptA.contract), refundText, this.identity);
        await this.venue.post(dealRoom(acceptA.contract), receiptText, this.identity);
      }
      this.legARefundFramesPosted = true;
      await this.persist();
    }
    if (this.legARefundEvidence === undefined) throw new Error("buyer: the refund's evidence is missing"); // unreachable
    return this.legARefundEvidence;
  }

  /**
   * P8-RESUME-SPEC.md "Buyer refund A" (rules 1 and 2): a refund that was attempted without a known outcome. The chain
   * decides, never an assumption: with the refund's recorded handle the rail READS what became of THAT refund (R1-01 part 2:
   * `recoverRefund` never sends); when the node does not know it (`unknown`: Bitcoin while the funding output is unspent, NEAR
   * while it reads Locked) the identical recorded bytes are sent once with `resendRefund`, never a second refund built. The
   * rule-4 guards of a refund (leg A's refund time, the leg B claim latches, the pending-claim read) all ran at the top of
   * `refundLegA`, on this very call, before this one is reached. The lock itself is then read. Refunded and final: the
   * evidence is recorded and only the frames remain. Claimed instead: the Buyer is routed to `learnSecret`. A refund still
   * pending is awaited (`refundLegA` says so and sends nothing). Only a refund the rail proves can no longer land (NEAR,
   * Solana), one that LANDED AND FAILED (R1-08), or one that never got a handle (nothing was signed before the crash; EVM
   * keeps no handle and a repeat is refused by the contract) leaves the way open for exactly one fresh refund, which the
   * caller then builds with the same recorder.
   */
  private async recoverRefundA(
    connected: ConnectedCounterAssetRail,
    termsA: ReturnType<typeof offerAcceptLockTerms>,
    railRef: string,
  ): Promise<void> {
    if (this.lockedAccounts === undefined) throw new Error("buyer: refusing to refund leg A - leg A accounts were never resolved (G1)");
    const handle = this.refundRecovery;
    let outcome: LockRecoveryOutcome | "landed-failed" | undefined;
    if (handle !== undefined && connected.recoverRefund !== undefined) {
      try {
        outcome = await connected.recoverRefund(railRef, handle);
        if (outcome === "unknown" && connected.resendRefund !== undefined) outcome = await connected.resendRefund(railRef, handle);
      } catch (error) {
        // R1-08: the recorded refund LANDED and FAILED on chain (a NEAR payout that failed and put the lock back to Locked, a
        // transaction that failed, a Solana refund that failed). A transaction that landed can never land again, so it is
        // resolved; the lock itself says what follows. Any other error (a transport failure, a refused handle) is not an outcome.
        if (!isLandedAndFailedRefund(error)) throw error;
        outcome = "landed-failed";
      }
    }
    const observed = await connected.verifyLockFinal(termsA, railRef, this.lockedAccounts);
    if (observed.rail?.status === "refunded" && observed.rail.final) {
      this.legARefundEvidence = {
        ref: railRef,
        raw: [],
        ...(handle?.chain === "btc" ? { txid: handle.txid, rawTx: handle.rawTx } : {}),
      };
      await this.persist();
      return;
    }
    if (observed.rail?.status === "claimed") {
      return this.routeToClaim(
        "buyer: refusing to report leg A refunded - the lock was claimed instead (the refund lost the race to a claim); " +
          "call learnSecret() then claimLegB() instead of refundLegA() (G7)",
      );
    }
    if (outcome === "landed-failed") {
      // Locked and final: nothing was paid and nobody claimed; the failed refund's handle is cleared and ONE fresh refund follows.
      // Anything else (a transitional state, an evidence reader that withholds its answer) is not decided: ask again later.
      if (observed.rail?.status !== "locked" || !observed.rail.final) throw new Error(REFUND_UNCONFIRMED);
    } else if (outcome === "pending" || outcome === "landed" || outcome === "unknown") {
      throw new Error(REFUND_UNCONFIRMED);
    } else if (handle?.chain === "btc") {
      // never-landed on Bitcoin: the funding output is spent by another transaction. A second refund cannot spend it.
      throw new Error(
        "buyer: the recorded Bitcoin refund can no longer land (the funding output is spent by another transaction); " +
          "a second refund is not built - call learnSecret() then claimLegB() if it was claimed (K2, rule 2)",
      );
    }
    this.refundRecovery = undefined; // proven never to land, landed and failed, or never signed: one fresh refund follows
    await this.persist();
  }
}
