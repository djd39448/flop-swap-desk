// SPDX-License-Identifier: MIT
//
// P22-P24-EVM-SPEC.md §6: the Seller's side of one swap — accepts leg A (the counter-asset, on
// its own rail), mints the hash statement, opens leg B (FLOP, on tclk's `paper` rail), and only
// ever claims leg A once the chain itself says the lock is final. Every step is an explicit
// method a runner calls in order (no hidden timers, no background polling); each one either
// succeeds or throws an `Error` naming the rule it refused to break — never a silent no-op. The
// secret is minted with tclk's own CSPRNG-backed `generateHashLock()` (vendor/tclk/src/hex.ts's
// `randomU8a`, Web Crypto) and lives only in a private field of this class: no step here ever
// logs it, returns it, or writes it to a frame before `claimLegA` reveals it on purpose.
//
// Money-moving calls (`paperRail.lock/refund`, the leg-A rail's `claim`) are delegated to the
// rails themselves, which enforce their own predicates independently (tclk's `PaperRail`, and
// whatever `CounterAssetRail` (src/client/counter-rail.ts) this flow was built with — `evm-htlc`
// today, via `src/client/evm-rail.ts`'s adapter around the vendored `EvmHashRail`) — this module
// adds the cross-leg and D-11 finality checks the rails have no way to know about on their own.
//
// P4-BTC-SPEC.md §7a ("one client, many rails"): this class no longer imports a specific rail's
// adapter at all — `SellerFlowOptions.rail` is a `CounterAssetRail`, and every write/read this
// class makes against leg A goes through it. No behaviour change for EVM: `src/client/evm-rail
// .ts`'s adapter makes exactly the same calls, in the same order, against the same
// `CapturingRpc`, that this class used to make directly against `EvmHtlcRail`.
//
// P22-P24-EVM-FIXES.md B1 (CRITICAL): `lockLegB` used to trust a caller-supplied `AcceptFrame`
// object outright — any DID could hand this flow an accept naming its own hash statement, and
// this class would lock the FLOP leg for it (the reviewer proved this takes the FLOP: the
// attacker never needs the Buyer's own leg-A preimage, only its own, which it minted itself).
// `lockLegB` now takes the *record* the accept must have arrived as (`OFFER_ROOM`, signed) and
// re-derives every fact it trusts from that record and this flow's own state: the record
// authenticates (`verifyTranscriptRecord` + `frame.from === record.sender`, never a frame whose
// claimed sender differs from who actually signed it), the statement is this Seller's own
// minted one (never the acceptor's), the acceptor is the same Buyer who opened leg A, the ref
// names this flow's own leg B offer, and the contract id is the one tclk itself derives for
// that exact offer/accept pair (`contractId`, recomputed here — never merely copied from the
// frame, which is attacker-controlled data until this check runs).
//
// B2/B3: `EVM_LOCAL_POLICY` (src/client/policy.ts) replaces a runner-supplied deadline policy;
// `acceptLegA` refuses a leg A offer whose own claimBy/refundAfter gap is already below the
// EVM claim-inclusion margin, and checks the leg B deadlines it is about to propose the same
// way `BuyerFlow.acceptLegB` will. `claimLegA` reads the chain's own clock (never wall-clock)
// for the claimByMs/margin guard, since that is what the contract will see when the claim
// lands; the leg-A rail's own `claim` itself simulates before ever broadcasting
// (P22-P24-EVM-FIXES.md B2, `src/rails/evm-htlc.ts`).
//
// B5: this flow keeps every leg-A write's raw `Exchange`s (`this.exchanges`) so a bundle writer
// (`src/client/bundle.ts`) can persist them into `raw/rpc/`, making every sha256 in
// `WriteEvidence.raw` resolve to real bytes on disk.
//
// P22-P24-EVM-FIXES-R2.md C1: `lockLegB` refuses a second lock attempt for this flow's own leg
// B — already locked, or another call already in flight — before doing anything else, closing a
// gap where two independently genuine accepts (each under its own fresh nonce, hence its own
// tclk contract id) could otherwise both reach `paperRail.lock`. C3: `claimLegA`'s claimByMs and
// claim-inclusion-margin guards now judge against `max(chain time, wall clock)`, never chain
// time alone — an idle chain's own last block can lag real time indefinitely, which chain time
// alone would otherwise read as more safety margin than actually remains.
//
// P22-P24-EVM-FIXES-R3.md E2: `lockLegB`'s own leg-B latch (`attemptedAcceptB`, replacing a
// latch keyed only on confirmed success) never reopens once any lock has been attempted, even
// if the attempt itself threw — `reconcileLegB()` is the only way to learn whether it actually
// landed, and it only ever checks the same contract, never a different one. E4: `claimLegA`
// re-reads chain time and re-applies its own claimByMs/margin guards a second time immediately
// after `verifyLockFinal` returns (which can itself take a long time on a slow RPC), and passes
// the leg-A rail's `claim` a `notAfterMs` bound for its own last-moment check.
//
// SB3a (P6-SOL-SPEC.md): the Solana leg runs through this same class. the Solana rail id (`SOL_RAIL_ID`) is an owner-
// namespaced custom rail id tclk's closed registry does not know, so every frame this class emits for leg A
// (the `claimed` receipt) and the orientation check of leg A's offer read the rail id through the rail's OWN
// registry (`CounterAssetRail.railRegistry`, never global). Like NEAR, a Solana lock's ref is
// `0x<hash lock>:<payer>` (checked against this Seller's own hash lock, the payer taken from the authenticated
// lock frame), and `claimLegA` first resolves every claim signature this flow recorded (S2-2: each is latched
// before it is simulated or sent; it landed, failed with the secret public, or never landed). The flow never scans
// history (S2-3): a flow that never signed a claim does the ordinary guarded claim. A claim that fails with the
// secret public is never just rethrown: it is retried at once through `options.retryPublicSecret`, which the rail
// allows only after proving the secret public from THAT recorded transaction, and the reveal follows the retry
// (S2-4; each reveal attempt is bounded by a timeout).
//
// P8-RESUME-SPEC.md (crash-resume): with an optional `store` (src/client/flow-store.ts) this flow writes its swap
// record BEFORE every outward action (the minted secret and the exact bytes of accept A / offer B before accept A
// is posted; the leg B lock intent before the note write; every claim signature before it is sent; the exact text
// of every frame and account line before `venue.post`) and `SellerFlow.resume` rebuilds the flow from that record
// in a fresh process. Without a store the flow behaves exactly as before and cannot be resumed. The preimage lives
// in an ES `#private` field (and, with a store, in this flow's own record); `toJSON` and `util.inspect` show
// public data only, like the signers.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6; P22-P24-EVM-FIXES.md B1, B2, B3,
// B5; P22-P24-EVM-FIXES-R2.md C1, C3; P22-P24-EVM-FIXES-R3.md E2, E4; P4-BTC-SPEC.md §7a;
// P6-SOL-SPEC.md sections 3-5; P8-RESUME-SPEC.md.

import { inspect } from "node:util";

import {
  contractId,
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  tryDecodeFrame,
  verifyHashPreimage,
  verifyTranscriptRecord,
  OFFER_ROOM,
  PaperRail,
  type AcceptFrame,
  type HashLock,
  type LockFrame,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { checkSwapDeadlines } from "../deadlines.js";
import { checkOrientation, classifySwapOffer, legBContext } from "../profile.js";
import { encodeFrameWith } from "../rails/custom-frames.js";
import { SOL_RAIL_ID } from "../rails/custom-rails.js";
import { EVM_RAIL_ID } from "../rails/evm-evidence.js";
import { NEAR_RAIL_ID } from "../rails/near-evidence.js";
import { parseNearRef } from "../rails/near-ref.js";
import { NearPayoutFailedError } from "../rails/near-htlc.js";
import { SOL_CLAIM_LANDING_MARGIN_MS, SolClaimFailedError, SolNotLandedError, SolPendingError, parseSolRef } from "../rails/sol-htlc.js";
import type { Exchange } from "../rails/rpc-capture.js";
import { findAuthenticatedLock, foldAcceptedLock } from "../replay.js";
import { offerAcceptLockTerms } from "../swap.js";
import { belowMinLockable, type ConnectedCounterAssetRail, type CounterAssetRail, type RailAccounts, type RailClaimRecord, type RailWriteEvidence } from "./counter-rail.js";
import {
  FlowRecordConflictError,
  FlowRecordMismatchError,
  checkRecordIdentity,
  newSellerRecord,
  withLedgerIntent,
  type SellerFlowRecord,
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
  type JournalDeps,
  type SellerNextStep,
} from "./flow-resume.js";
import { FlowStoreCorruptError, type FlowStore } from "./flow-store.js";
import { chainClockProblem } from "./policy.js";
import type { Signer, Venue } from "./venue.js";

export interface SellerFlowOptions {
  identity: Signer;
  venue: Venue;
  /** Backs leg B (FLOP on tclk's `paper` rail) — a rehearsal surface, shared with the Buyer's
   *  own `PaperRail` instance over one `NoteStore` (`vendor/tclk/src/paper-rail.ts`). */
  paperRail: PaperRail;
  /** Leg A's counter-asset rail (P4-BTC-SPEC.md §7a) — `evm-htlc` today
   *  (`src/client/evm-rail.ts`'s `createEvmCounterRail`), `btc-htlc` via
   *  `src/client/btc-rail.ts`'s `createBtcCounterRail`. This Seller only ever claims or refunds
   *  through it; only the Buyer ever locks. */
  rail: CounterAssetRail;
  /** Wall-clock ms, injected — never `Date.now()` inside this class (house rule). */
  clock: () => number;
  /** S2-4, Solana only: how long one reveal-frame post may take before that attempt is abandoned (a stalled venue
   *  must never hold up the claim retry or the call). Default 10 s. A real timer, not the injected clock. */
  revealPostTimeoutMs?: number;
  /** P8-RESUME-SPEC.md: where this flow writes its swap record (see the header). Absent = today's behaviour: nothing
   *  is written and the flow cannot be resumed. The directory behind a `FileFlowStore` is secret-grade: this
   *  record holds the swap preimage. */
  store?: FlowStore;
  /** The source of the swap secret, injected like `clock`. Default: tclk's CSPRNG-backed `generateHashLock`. Only a
   *  test passes anything else (to know the secret it would otherwise never see); a production caller leaves it unset. */
  mintHashLock?: () => HashLock;
}

/** `SellerFlow.resume` options: the constructor's, plus the store and the swap to continue. `contractA` /
 *  `contractB` are the runner's own knowledge of the two tclk contract ids, if it has any: a stored record that
 *  names another contract stops `resume` with `FlowRecordMismatchError`. */
export type SellerResumeOptions = SellerFlowOptions & { store: FlowStore; swapId: string; contractA?: string; contractB?: string };

export interface AcceptLegAResult {
  acceptA: AcceptFrame;
  /** The signed record `acceptA` was actually posted as — a runner hands this straight to
   *  `BuyerFlow.acceptLegB` (B3: it requires the authenticated record, not the bare frame). */
  acceptARecord: TranscriptRecord;
  offerB: OfferFrame;
  /** P22-P24-EVM-FIXES-R2.md C2: the signed record `offerB` was actually posted as — a runner
   *  hands this, not the bare frame, straight to `BuyerFlow.acceptLegB` (it now requires the
   *  authenticated record, the same way B3 already required one for leg A's accept). */
  offerBRecord: TranscriptRecord;
}

/** Leg B's deadlines (SPEC §3.5 rules 2-3 sized against whatever `lockTimeMs` the runner
 *  expects leg A to lock at) — the Seller does not compute these itself; a runner that already
 *  knows the deadline policy passes them in, and the Buyer's own `acceptLegB` safety check
 *  (`src/client/buyer.ts`) is what actually refuses an unsafe pair, exactly the way a real
 *  counterparty would reject a bad offer rather than trust the sender to have gotten the
 *  arithmetic right. */
export interface LegBDeadlines {
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
}

/**
 * One Seller's view of one swap. Constructed once per swap; every method is a single explicit
 * step, meant to be called in the order SPEC §6 lists: `acceptLegA` → `postAccountLineA` →
 * `lockLegB` → (`claimLegA` | `refundLegB`).
 */
/** P5-NEAR-FIXES-R2.md G6: the reveal frame could not be posted after the secret was already
 *  public on chain (or the chain claim already landed). tclk's machine only accepts a reveal
 *  while the contract is still `locked`; once the buyer's `refund` frame lands after
 *  `refundAfterMs` the reveal is rejected and the claim can never be recorded in the transcript.
 *  So the reveal MUST land before `refundAfterMs`: call `claimLegA` again (it re-posts only what
 *  is missing) before that time. */
export class RevealNotPostedError extends Error {
  readonly refundAfterMs: number;
  constructor(refundAfterMs: number, cause: unknown, detail: string) {
    super(
      `seller: the reveal frame did not post after ${REVEAL_POST_ATTEMPTS} attempts - the reveal must land before refundAfterMs (${refundAfterMs}); retry claimLegA before then (${detail}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "RevealNotPostedError";
    this.refundAfterMs = refundAfterMs;
  }
}

/** R3-2: a Solana claim whose signed bytes were handed to the network but never landed (starved: the blockhash
 *  expired with no status). The secret was BROADCAST, so it may have been seen, and the claim did not pay the
 *  Seller. Thrown to the runner when the Seller cannot finish the claim (the landing bound passed, the attempts
 *  ran out, or another refusal); `cause` is the final reason. A flow that later lands a claim reports the count in
 *  the result's `neverLandedClaims` instead. Never a silent drop. */
export class SolClaimStarvedError extends Error {
  readonly neverLandedClaims: number;
  constructor(neverLandedClaims: number, cause: unknown) {
    super(
      `seller: secret broadcast but not landed (possibly seen): ${neverLandedClaims} claim(s) never landed and the claim could not be completed (${cause instanceof Error ? cause.message : String(cause)}); leg B exposed until legB.refundAfterMs`,
      { cause },
    );
    this.name = "SolClaimStarvedError";
    this.neverLandedClaims = neverLandedClaims;
  }
}

/** R3-2: the most claims re-signed (at a raised priority fee) after a never-landed outcome inside one `claimLegA`
 *  call; the landing bound normally ends the effort first. */
const SOL_NEVER_LANDED_MAX_RESIGNS = 6;

/** Bounded immediate retries for the reveal post (G6). */
const REVEAL_POST_ATTEMPTS = 3;

/** S2-4: the default bound on one reveal post attempt on the Solana rail. */
const SOL_REVEAL_POST_TIMEOUT_MS = 10_000;

/** SB3a: how many times `claimLegA` retries, at once, a Solana claim that FAILED with the secret already
 *  public (each retry is a fresh signed transaction; the rail proves the secret is public before it skips the
 *  deadline bounds, and refuses once chain time reaches `refund_after_ms`). */
const SOL_PUBLIC_SECRET_RETRIES = 2;

/** The rails whose lock ref is `0x<hash lock>:<payer>` (payer-keyed locks): how each parses it. `undefined` for
 *  a rail with another ref shape. */
function payerKeyedRefParser(railId: string): ((ref: string) => { hashLock: string } | null) | undefined {
  if (railId === NEAR_RAIL_ID) return parseNearRef;
  if (railId === SOL_RAIL_ID) return parseSolRef;
  return undefined;
}

export class SellerFlow {
  private readonly identity: Signer;
  private readonly venue: Venue;
  private readonly paperRail: PaperRail;
  private readonly rail: CounterAssetRail;
  private readonly clock: () => number;

  private offerA?: OfferFrame;
  private acceptA?: AcceptFrame;
  /** P4-BTC-FIXES.md G1/G8: the actual signed records leg A's offer/accept arrived as —
   *  captured once, in `acceptLegA`, so `claimLegA` can later fold this leg's own transcript
   *  (`foldAcceptedLock`) to learn the lock rail/ref the tclk contract machine actually
   *  *accepted*, and the venue `seq` it was accepted at, without ever re-deriving them from a
   *  bare, caller-supplied frame. `undefined` only when a caller bypassed `acceptLegA` entirely
   *  (a test harness injecting state directly) — `claimLegA` falls back to the pre-G8 behaviour
   *  in that case. */
  private offerARecord?: TranscriptRecord;
  private acceptARecord?: TranscriptRecord;
  /** P4-BTC-FIXES.md G1: this leg's resolved payer/payee identities and the rail ref
   *  `claimLegA` actually claimed with, frozen the first time `verifyLockFinal` returns `true` —
   *  a pubkey/account line posted after that point can neither help nor hinder a later call. */
  private frozenLegAAccounts?: RailAccounts;
  private frozenLegARailRef?: string;
  /** P5-NEAR-FIXES-R2.md G6: latches for the leg-A reveal and receipt frames this flow instance
   *  has already posted (per contract + ref), so a retry of `claimLegA` (the G2 path, or a claim
   *  whose reveal post failed) re-posts only what is still missing and never doubles a frame. */
  private revealPosted?: { key: string; record: TranscriptRecord };
  // SOL-C1: the signature of this flow's own claim that landed and failed on Solana (its instruction data holds the secret).
  private publicClaimSignature?: string;
  // S2-2: every Solana claim this flow signed and has not yet resolved, latched BEFORE it is simulated or sent (signature,
  // blockhash, lastValidBlockHeight). `claimLegA` resolves each of them by signature before it does anything else.
  private claimRecords: RailClaimRecord[] = [];
  // R3-2: how many of this flow's Solana claims were broadcast and never landed (secret possibly seen). Each raises
  // the priority fee of the next claim and keeps the Seller claiming up to the landing bound.
  private neverLandedClaims = 0;
  private readonly revealPostTimeoutMs: number;
  private receiptPosted?: { key: string; record: TranscriptRecord };
  private offerB?: OfferFrame;
  /** The swap secret (rule 5): an ES `#private` field, so `JSON.stringify`, `util.inspect`, `Object.keys`, `Reflect.ownKeys`
   *  and structured clone cannot reach it. */
  #hashLock?: HashLock;
  /** P8: this flow's journal over its stored record. It holds the preimage (the Seller's record is its one home), so
   *  it is `#private` too. Present only with a store, once the first record exists. */
  #journal?: FlowJournal<SellerFlowRecord>;
  private readonly store: FlowStore | undefined;
  private readonly mintHashLock: () => HashLock;
  /** P8: the signed records leg B's offer and the Buyer's accept B arrived as (kept in the stored record's frame slots). */
  private offerBRecord?: TranscriptRecord;
  private acceptBRecord?: TranscriptRecord;
  /** P8: true from just before the first leg A claim is sent, on any rail (stored; `claimLegA` then asks the chain
   *  whether that claim landed before it ever signs another). */
  private claimAttempted = false;
  private claimOutcome: "none" | "landed" | "failed-public" = "none";
  private legBRefundAttempted = false;
  private legBRefundDone = false;
  /** P8: a same-process double call of `acceptLegA` is refused while one is in flight (store mode only). */
  private acceptLegAPending = false;
  private lockedLegBContract?: string;
  /** P22-P24-EVM-FIXES-R3.md E2: the accept `lockLegB` is about to call `paperRail.lock` for,
   *  recorded *before* that call runs and never cleared afterward, success or failure — see
   *  `lockLegB`'s own comment. `lockedLegBContract` only ever means "we confirmed the lock
   *  landed"; this means "we attempted one", which must latch permanently the moment it is
   *  true, since a `NoteStore` that commits its write and then throws (a crash, a dropped ack)
   *  leaves this flow genuinely unable to tell the two apart from the exception alone. The only
   *  way past a set `attemptedAcceptB` is `reconcileLegB()`, and it only ever reads the rail for
   *  *this* same accept's own contract — this flow never locks under a different one, ever. */
  private attemptedAcceptB?: AcceptFrame;
  /** P22-P24-EVM-FIXES-R2.md C1: set synchronously, before `lockLegB`'s first `await`, so a
   *  second call that starts while the first is still in flight sees it already set — the same
   *  re-entry pattern `acceptLegA` gets for free by checking `this.offerA` as its very first
   *  statement. `lockedLegBContract` alone is not enough: two independently genuine accepts for
   *  the same leg B offer (different nonces, tclk#contract ids) would otherwise both be free to
   *  race `paperRail.lock` under two different contracts before either sets
   *  `lockedLegBContract`. */
  private legBLockPending = false;
  /** B5: every leg-A write's own raw `Exchange`s, in call order, so a bundle writer can persist
   *  them into `raw/rpc/` (every sha256 a `WriteEvidence.raw` names must resolve to real
   *  bytes). Paper-rail writes (`lockLegB`, `refundLegB`) never touch leg A's rail, so nothing
   *  is added for them. */
  private readonly writeExchanges: Exchange[] = [];

  constructor(options: SellerFlowOptions) {
    this.identity = options.identity;
    this.venue = options.venue;
    this.paperRail = options.paperRail;
    this.rail = options.rail;
    this.clock = options.clock;
    this.revealPostTimeoutMs = options.revealPostTimeoutMs ?? SOL_REVEAL_POST_TIMEOUT_MS;
    this.store = options.store;
    this.mintHashLock = options.mintHashLock ?? generateHashLock;
  }

  /** B5: every leg-A write this flow has made so far, in call order. */
  get exchanges(): readonly Exchange[] {
    return this.writeExchanges;
  }

  /** The hash statement this Seller minted for the swap, once `acceptLegA` has run — safe to
   *  publish (it is what `acceptA.statement` already carries); never the preimage. */
  get statement(): string | undefined {
    return this.#hashLock?.hash;
  }

  /** P8: the swap id this flow's record is stored under, once the record exists (public data). */
  get swapId(): string | undefined {
    return this.#journal?.record.swapId;
  }

  /** P8: the Buyer's leg A offer this swap was started from, as the record kept it, so a resumed runner that no longer
   *  has it (the offers room is a short ring) can pass it to `acceptLegA` again. Public data. */
  get recordedOfferA(): OfferFrame | undefined {
    const record = this.#journal?.record;
    return record === undefined ? undefined : offerFromSlot(`seller:${record.swapId}`, "offerA", record.frames.offerA);
  }

  /** P8: public data only (rule 5). `JSON.stringify(flow)` sees nothing else. */
  toJSON(): { role: "seller"; swapId: string | undefined; did: string; railId: string; caip2: string; statement: string | undefined } {
    return { role: "seller", swapId: this.swapId, did: this.identity.did, railId: this.rail.railId, caip2: this.rail.caip2, statement: this.statement };
  }

  /** P8: `util.inspect(flow)` (directly or nested via `console.log`) sees only this (rule 5). */
  [inspect.custom](): string {
    return `SellerFlow ${inspect(this.toJSON())}`;
  }

  private journalDeps(store: FlowStore): JournalDeps {
    return { store, venue: this.venue, identity: this.identity, clock: this.clock };
  }

  /** P8: the next safe step by the stored record alone (no I/O). After leg B's `refundAfterMs` the runner may call
   *  `refundLegB` where this says `claimLegA`. */
  private nextStep(): SellerNextStep {
    const journal = this.#journal;
    if (journal === undefined) return "acceptLegA";
    if (!(journal.isLanded("accept-a") && journal.isLanded("offer-b"))) return "acceptLegA";
    if (this.legBRefundAttempted || this.legBRefundDone) return journal.isLanded("receipt-refund-b") ? "done" : "refundLegB";
    // A leg B lock that was started is finished first (its recover path), whatever else is still open.
    const lockStarted = this.attemptedAcceptB !== undefined;
    const lockFinished = this.lockedLegBContract !== undefined && journal.isLanded("lock-b");
    if (lockStarted && !lockFinished) return "lockLegB";
    if (!journal.isLanded("account-a")) return "postAccountLineA";
    if (!lockFinished) return "lockLegB";
    if (journal.isLanded("receipt-a")) return "done";
    return "claimLegA";
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
  static async resume(options: SellerResumeOptions): Promise<{ flow: SellerFlow; next: SellerNextStep }> {
    const flow = new SellerFlow(options);
    await flow.restore(options);
    return { flow, next: flow.nextStep() };
  }

  private async restore(options: SellerResumeOptions): Promise<void> {
    const journal = await FlowJournal.open(this.journalDeps(options.store), "seller", options.swapId);
    const record = journal.record;
    if (record.role !== "seller") throw new FlowRecordMismatchError("role", "seller", record.role);
    checkRecordIdentity(record, {
      role: "seller",
      swapId: options.swapId,
      did: this.identity.did,
      railId: this.rail.railId,
      caip2: this.rail.caip2,
      ...(options.contractA === undefined ? {} : { contractA: options.contractA }),
      ...(options.contractB === undefined ? {} : { contractB: options.contractB }),
    });
    this.applyRecord(record);
    const typed = journal as unknown as FlowJournal<SellerFlowRecord>;
    typed.setProjector((next) => this.project(next));
    this.#journal = typed;
  }

  /** Rebuilds every latch from a stored record, after checking that its frames add up (the contract ids are recomputed,
   *  never trusted). */
  private applyRecord(record: SellerFlowRecord): void {
    const key = `seller:${record.swapId}`;
    const f = record.frames;
    const offerA = offerFromSlot(key, "offerA", f.offerA);
    const acceptA = acceptFromSlot(key, "acceptA", f.acceptA);
    const offerB = offerFromSlot(key, "offerB", f.offerB);
    const acceptB = acceptFromSlot(key, "acceptB", f.acceptB);

    this.#hashLock = { preimage: record.preimage, hash: record.statement };

    if (offerA !== undefined) {
      const classified = classifySwapOffer(offerA);
      if (classified === null || classified.context.leg !== "a" || classified.swapId !== record.swapId) {
        throw new FlowStoreCorruptError(key, "frames.offerA is not a leg A swap offer of this swap");
      }
    }
    if (acceptA !== undefined) {
      if (offerA === undefined) throw new FlowStoreCorruptError(key, "frames.acceptA without frames.offerA");
      if (acceptA.from !== record.did || acceptA.ref !== offerA.id || acceptA.statement !== record.statement) {
        throw new FlowStoreCorruptError(key, "frames.acceptA is not this Seller's accept of the stored leg A offer and statement");
      }
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
      if (offerA === undefined) throw new FlowStoreCorruptError(key, "frames.offerB without frames.offerA");
      const classified = classifySwapOffer(offerB);
      if (offerB.from !== record.did || classified === null || classified.context.leg !== "b" || classified.context.legAOfferId !== offerA.id) {
        throw new FlowStoreCorruptError(key, "frames.offerB is not this Seller's leg B offer of the stored leg A offer");
      }
    }
    if (acceptB !== undefined) {
      if (offerA === undefined || offerB === undefined) throw new FlowStoreCorruptError(key, "frames.acceptB without the offers it answers");
      if (acceptB.ref !== offerB.id || acceptB.from !== offerA.from || acceptB.statement !== record.statement) {
        throw new FlowStoreCorruptError(key, "frames.acceptB is not the leg A Buyer's accept of the stored leg B offer and statement");
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
    if (record.attemptedAcceptB !== undefined && (acceptB === undefined || acceptB.contract !== record.attemptedAcceptB)) {
      throw new FlowStoreCorruptError(key, "attemptedAcceptB does not name the stored accept B");
    }

    const offerARecord = slotRecord(key, "offerA", f.offerA, offerA?.from ?? "");
    const acceptARecord = slotRecord(key, "acceptA", f.acceptA, record.did);
    const offerBRecord = slotRecord(key, "offerB", f.offerB, record.did);
    const acceptBRecord = slotRecord(key, "acceptB", f.acceptB, acceptB?.from ?? "");

    // Leg A counts as accepted (and `acceptLegA` as done) only once both of its posts landed.
    const acceptDone = ledgerLanded(record, "accept-a") && ledgerLanded(record, "offer-b");
    if (acceptDone) {
      if (offerA === undefined || acceptA === undefined || offerB === undefined) {
        throw new FlowStoreCorruptError(key, "the ledger says accept A and offer B landed but their frames are missing");
      }
      this.offerA = offerA;
      this.acceptA = acceptA;
      this.offerB = offerB;
      if (offerARecord !== undefined) {
        this.offerARecord = offerARecord;
        if (acceptARecord !== undefined) this.acceptARecord = acceptARecord;
      }
    }
    if (offerBRecord !== undefined) this.offerBRecord = offerBRecord;
    if (acceptBRecord !== undefined) this.acceptBRecord = acceptBRecord;
    if (record.attemptedAcceptB !== undefined && acceptB !== undefined) this.attemptedAcceptB = acceptB;
    if (record.lockedLegBContract !== undefined) this.lockedLegBContract = record.lockedLegBContract;
    if (record.frozenLegAAccounts !== undefined && record.frozenLegARailRef !== undefined) {
      this.frozenLegAAccounts = accountsFromJson(record.frozenLegAAccounts);
      this.frozenLegARailRef = record.frozenLegARailRef;
    }
    this.claimAttempted = record.claimAttempted;
    this.claimRecords = record.claimRecords.map((entry) => ({ ...entry }));
    if (record.publicClaimSignature !== undefined) this.publicClaimSignature = record.publicClaimSignature;
    this.neverLandedClaims = record.neverLandedClaims;
    this.claimOutcome = record.claimOutcome;
    this.legBRefundAttempted = record.legBRefund.attempted;
    this.legBRefundDone = record.legBRefund.done;
  }

  /** The flow's live state laid over a record (the journal calls this on every save). Only things a resumed flow
   *  needs are copied; the frames, the ledger and the revision stay the record's own. */
  private project(r: SellerFlowRecord): SellerFlowRecord {
    return {
      ...r,
      ...(this.attemptedAcceptB === undefined ? {} : { attemptedAcceptB: this.attemptedAcceptB.contract }),
      ...(this.lockedLegBContract === undefined ? {} : { lockedLegBContract: this.lockedLegBContract }),
      ...(this.frozenLegAAccounts === undefined ? {} : { frozenLegAAccounts: accountsToJson(this.frozenLegAAccounts) }),
      ...(this.frozenLegARailRef === undefined ? {} : { frozenLegARailRef: this.frozenLegARailRef }),
      claimAttempted: this.claimAttempted,
      claimRecords: this.claimRecords.map((entry) => ({ ...entry })),
      ...(this.publicClaimSignature === undefined ? {} : { publicClaimSignature: this.publicClaimSignature }),
      neverLandedClaims: this.neverLandedClaims,
      claimOutcome: this.claimOutcome,
      revealPosted: ledgerLanded(r, "reveal-a"),
      receiptPosted: ledgerLanded(r, "receipt-a"),
      legBRefund: { attempted: this.legBRefundAttempted, done: this.legBRefundDone, framesPosted: ledgerLanded(r, "receipt-refund-b") },
    };
  }

  /** Saves the record now (the live state laid over it). A no-op without a store. */
  private async persist(): Promise<void> {
    await this.#journal?.update((r) => r);
  }

  private requireAcceptedA(): { offerA: OfferFrame; acceptA: AcceptFrame } {
    if (this.offerA === undefined || this.acceptA === undefined) {
      throw new Error("seller: leg A has not been accepted yet");
    }
    return { offerA: this.offerA, acceptA: this.acceptA };
  }

  /**
   * Accept the Buyer's leg A offer: mint a fresh CSPRNG hash statement (never logged, never
   * returned — only `acceptA.statement`, its public half, leaves this method), post the accept,
   * then open leg B naming the same statement's contract and copying leg A's own declared
   * want-asset/amount/rail (SPEC §3.3) — never re-typed by hand, since the offer already
   * committed to them under signature.
   *
   * B2: refuses an offer whose own `claimByMs..refundAfterMs` gap is already below the EVM
   * claim-inclusion margin (there would be no safe window left to claim in even before any
   * chain-time drift), and — since this Seller is the one who chooses leg B's deadlines —
   * refuses to propose a `legB`/`lockTimeMs` combination its own `checkSwapDeadlines` (the same
   * check, same pinned `EVM_LOCAL_POLICY`, `BuyerFlow.acceptLegB` will run independently) would
   * already call unsafe, rather than let the Buyer be the only side that ever notices.
   * `lockTimeMs` is the runner's best estimate of when leg A will actually lock (the same value
   * it will later pass to `BuyerFlow.acceptLegB`/`lockLegA`) — both sides check the same pair
   * against the same clock, never trusting the other to have done the arithmetic right.
   */
  async acceptLegA(offerA: OfferFrame, legB: LegBDeadlines, lockTimeMs: number): Promise<AcceptLegAResult> {
    if (this.offerA !== undefined) {
      if (this.store === undefined) throw new Error("seller: leg A already accepted for this flow");
      // P8: confirmed already (this process, or rebuilt from the record): the recorded result, nothing posted again.
      return this.recordedAcceptResult(offerA);
    }
    if (this.store === undefined) return this.acceptLegAUnlatched(offerA, legB, lockTimeMs);
    // P8: a same-process double call is refused while one is in flight (the record, not this flag, decides a repeat).
    if (this.acceptLegAPending) throw new Error("seller: refusing to accept leg A - another call is already in flight");
    this.acceptLegAPending = true;
    try {
      return await this.acceptLegAUnlatched(offerA, legB, lockTimeMs);
    } finally {
      this.acceptLegAPending = false;
    }
  }

  /** P8: the result of an `acceptLegA` that is already confirmed, read back from the record's frame slots. */
  private recordedAcceptResult(offerA: OfferFrame): AcceptLegAResult {
    const record = this.#journal?.record;
    if (record === undefined || this.acceptA === undefined || this.offerB === undefined) throw new Error("seller: leg A has not been accepted yet");
    if (record.frames.offerA?.text !== encodeFrameWith(offerA, this.rail.railRegistry)) {
      throw new FlowRecordConflictError("seller: this flow already accepted a different leg A offer than the one supplied");
    }
    const acceptARecord = record.frames.acceptA?.record;
    const offerBRecord = record.frames.offerB?.record;
    if (acceptARecord === undefined || offerBRecord === undefined) throw new FlowStoreCorruptError(`seller:${record.swapId}`, "accept A is recorded as done but its signed records are missing");
    return { acceptA: this.acceptA, acceptARecord: recordFromJson(acceptARecord), offerB: this.offerB, offerBRecord: recordFromJson(offerBRecord) };
  }

  private async acceptLegAUnlatched(offerA: OfferFrame, legB: LegBDeadlines, lockTimeMs: number): Promise<AcceptLegAResult> {
    const classification = classifySwapOffer(offerA);
    if (classification === null || classification.context.leg !== "a") {
      throw new Error("seller: refusing to accept — offer is not a leg-A swap offer");
    }
    const orientation = checkOrientation(offerA, classification.context, this.rail.railRegistry);
    if (!orientation.ok) {
      throw new Error(`seller: refusing to accept an unsafe leg A offer: ${orientation.reason}`);
    }
    // SB3a: a rail with a custom id (Solana) only ever accepts a leg A that OFFERS it: an offer whose own
    // rail list does not name this rail can never be locked on it.
    if (this.rail.railRegistry !== undefined && !offerA.rails.includes(this.rail.railId)) {
      throw new Error(
        `seller: refusing to accept leg A - its rails (${offerA.rails.join(", ")}) do not include this rail's own "${this.rail.railId}"`,
      );
    }

    // P4-BTC-FIXES-R3.md K3: refuse an offer whose declared asset does not match this rail's own
    // single settled asset — before ever minting a statement or posting anything for it (a rail
    // that declares no single asset, e.g. evm-htlc, never triggers this: no behaviour change).
    if (this.rail.assetId !== undefined && offerA.asset !== this.rail.assetId) {
      throw new Error(
        `seller: refusing to accept leg A — asset "${offerA.asset}" does not match this rail's own asset "${this.rail.assetId}" (K3)`,
      );
    }

    // P4-BTC-FIXES.md G6: refuse an amount this rail could never actually lock (below the fixed
    // spend fee plus the worst-case dust limit, with margin) before ever minting a statement or
    // posting anything for it.
    if (belowMinLockable(this.rail, offerA.amount)) {
      throw new Error(
        `seller: refusing to accept leg A — ${offerA.amount} ${offerA.asset} is below this rail's minimum lockable amount ` +
          `${this.rail.minLockableAmount} (G6)`,
      );
    }

    // R3-7 (Solana only): refuse while the chain's finalized clock and the local clock disagree by more than the named
    // bound (a rail without `chainClockMs` is never checked).
    if (this.rail.chainClockMs !== undefined) {
      const problem = chainClockProblem(await this.rail.chainClockMs(), this.clock(), this.rail.maxChainClockSkewMs);
      if (problem !== null) throw new Error(`seller: refusing to accept leg A - ${problem}`);
    }

    const inclusionWindowMs = offerA.refundAfterMs - offerA.claimByMs;
    if (inclusionWindowMs < this.rail.policy.claimInclusionMarginMs) {
      throw new Error(
        `seller: refusing to accept leg A — its claimByMs..refundAfterMs window (${inclusionWindowMs} ms) is ` +
          `below the EVM claim-inclusion margin (${this.rail.policy.claimInclusionMarginMs} ms) (B2)`,
      );
    }

    // P8: with a store, an earlier call (this process, or a dead one) may already have saved the frames it chose and
    // the secret minted for them. Those exact frames and that secret are reused: a second accept A with another
    // statement would strand the first one's preimage.
    const stored = this.#journal?.record;
    const storedKey = stored === undefined ? "" : `seller:${stored.swapId}`;
    const storedAccept = stored === undefined ? undefined : acceptFromSlot(storedKey, "acceptA", stored.frames.acceptA);
    const storedOfferB = stored === undefined ? undefined : offerFromSlot(storedKey, "offerB", stored.frames.offerB);
    let hashLock: HashLock;
    let acceptA: AcceptFrame;
    let offerB: OfferFrame;
    if (stored !== undefined && storedAccept !== undefined && storedOfferB !== undefined) {
      if (stored.frames.offerA?.text !== encodeFrameWith(offerA, this.rail.railRegistry)) {
        throw new FlowRecordConflictError("seller: a different leg A offer than the one this swap's saved accept answers (a party never posts a second, different frame)");
      }
      hashLock = { preimage: stored.preimage, hash: stored.statement };
      acceptA = storedAccept;
      offerB = storedOfferB;
    } else {
      hashLock = this.mintHashLock();
      if (!verifyHashPreimage(hashLock.hash, hashLock.preimage)) throw new Error("seller: the minted hash lock's preimage does not open its statement");
      acceptA = makeAccept(offerA, { from: this.identity.did, statement: hashLock.hash });
      offerB = makeOffer({
        from: this.identity.did,
        role: "payer",
        amount: classification.context.wantAmount,
        asset: classification.context.wantAsset,
        lock: "hash",
        // The declared want-rail (e.g. "flop-htlc") plus "paper" (tclk's own rehearsal rail,
        // which is what this build actually settles leg B on - there is no FLOP chain adapter
        // yet): `checkOrientation` requires the want-rail be offered, and the `lock` frame this
        // flow posts (`lockLegB`) declares `rail: "paper"`, which the tclk state machine only
        // accepts when the offer itself lists it (same convention as the 2026-09-18 rehearsal
        // fixture's `offerB.rails: ["flop-htlc", "paper"]`).
        rails: [classification.context.wantRail, "paper"],
        claimByMs: legB.claimByMs,
        refundAfterMs: legB.refundAfterMs,
        expiresMs: legB.expiresMs,
        job: { proto: "swap", id: classification.swapId, context: legBContext(offerA.id) },
      });
    }

    // B2: the pair this Seller is about to propose, checked before anything is posted — a
    // runner that got `legB`'s deadlines wrong should not be able to make this flow commit to
    // a hash statement (and a public offer B) that the Buyer's own check would refuse anyway.
    const deadlineCheck = checkSwapDeadlines(offerA, offerB, lockTimeMs, this.rail.policy);
    if (!deadlineCheck.ok) {
      throw new Error(
        `seller: refusing to accept leg A — the leg B deadlines it would propose are unsafe: ${deadlineCheck.violations.join("; ")}`,
      );
    }

    if (this.store !== undefined) return this.acceptLegAPersisted(offerA, classification.swapId, legB, lockTimeMs, hashLock, acceptA, offerB);

    const acceptARecord = await this.venue.post("tclk-offers", encodeFrame(acceptA), this.identity);
    const offerBRecord = await this.venue.post("tclk-offers", encodeFrame(offerB), this.identity);

    // P4-BTC-FIXES.md G1/G8: capture the actual signed record leg A's own offer arrived as, so
    // `claimLegA` can later fold this leg's real transcript (`foldAcceptedLock`) instead of
    // re-deriving facts from the bare `offerA` frame this method was handed. Best-effort: `null`
    // only if the offer genuinely never reached `tclk-offers` under this exact id (a caller that
    // handed this method a frame that was never actually posted) — `claimLegA` falls back to its
    // pre-G8 behaviour in that case, so this can never make an otherwise-working flow throw here.
    const offerARecord = await this.findOfferRecord(offerA.id);

    // Only now, after both posts succeeded, does this flow consider leg A accepted — a post
    // failure must not leave `this.#hashLock` set with nothing on the venue to back it.
    this.offerA = offerA;
    this.acceptA = acceptA;
    this.#hashLock = hashLock;
    this.offerB = offerB;
    if (offerARecord !== null) {
      this.offerARecord = offerARecord;
      this.acceptARecord = acceptARecord;
    }
    return { acceptA, acceptARecord, offerB, offerBRecord };
  }

  /** P4-BTC-FIXES.md G1/G8: find the authenticated `tclk-offers` record for the offer named
   *  `offerId` — the Buyer's own original, signed post, never re-derived from the bare frame a
   *  caller handed `acceptLegA`. `null` when no such authenticated record exists (never thrown:
   *  the caller falls back to the pre-G8 behaviour in that case). */
  private async findOfferRecord(offerId: string): Promise<TranscriptRecord | null> {
    const offerRoomRecords = await this.venue.read(OFFER_ROOM);
    for (const candidate of offerRoomRecords) {
      if (candidate.room !== OFFER_ROOM || !verifyTranscriptRecord(candidate).ok) continue;
      const frame = tryDecodeFrame(candidate.line);
      if (frame !== null && frame.type === "offer" && frame.from === candidate.sender && frame.id === offerId) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * P8-RESUME-SPEC.md rules 1 and 3: the store-backed half of `acceptLegA`. The record (the minted secret, the exact
   * text of accept A and offer B, the deadlines) is saved BEFORE the first post, because accept A makes the statement
   * public; then each frame is posted once as exactly that text, or adopted when the room already holds it (a
   * resumed call after a crash between the two posts). Nothing is assigned to the flow until both landed.
   */
  private async acceptLegAPersisted(
    offerA: OfferFrame,
    swapId: string,
    legB: LegBDeadlines,
    lockTimeMs: number,
    hashLock: HashLock,
    acceptA: AcceptFrame,
    offerB: OfferFrame,
  ): Promise<AcceptLegAResult> {
    const store = this.store;
    if (store === undefined) throw new Error("seller: no store"); // unreachable: the caller checked
    const acceptAText = encodeFrame(acceptA);
    const offerBText = encodeFrame(offerB);
    if (this.#journal === undefined) {
      let initial: SellerFlowRecord = {
        ...newSellerRecord({
          swapId,
          did: this.identity.did,
          railId: this.rail.railId,
          caip2: this.rail.caip2,
          nowMs: this.clock(),
          preimage: hashLock.preimage,
          statement: hashLock.hash,
        }),
        frames: { offerA: { text: encodeFrameWith(offerA, this.rail.railRegistry) }, acceptA: { text: acceptAText }, offerB: { text: offerBText } },
        contractA: acceptA.contract,
        lockTimeMs,
        legB: { claimByMs: legB.claimByMs, refundAfterMs: legB.refundAfterMs, expiresMs: legB.expiresMs },
      };
      initial = withLedgerIntent(initial, { kind: "accept-a", room: OFFER_ROOM, text: acceptAText });
      initial = withLedgerIntent(initial, { kind: "offer-b", room: OFFER_ROOM, text: offerBText });
      // Rule 1: the secret and the exact frames are durable BEFORE accept A is posted (the statement is public from that post).
      const journal = await FlowJournal.begin(this.journalDeps(store), initial);
      journal.setProjector((next) => this.project(next));
      this.#journal = journal;
    }
    const journal = this.#journal;
    this.#hashLock = hashLock;
    const acceptARecord = await journal.ensurePosted({ kind: "accept-a", room: OFFER_ROOM, text: acceptAText, slot: "acceptA" });
    const offerBRecord = await journal.ensurePosted({ kind: "offer-b", room: OFFER_ROOM, text: offerBText, slot: "offerB" });

    // G1/G8, as in the unstored path: the Buyer's own signed offer record, best effort.
    const storedOfferA = journal.record.frames.offerA?.record;
    const offerARecord = storedOfferA !== undefined ? recordFromJson(storedOfferA) : await this.findOfferRecord(offerA.id);
    if (offerARecord !== null && storedOfferA === undefined) {
      await journal.update((r) => ({ ...r, frames: { ...r.frames, offerA: { text: r.frames.offerA?.text ?? encodeFrameWith(offerA, this.rail.railRegistry), record: recordToJson(offerARecord) } } }));
    }
    this.offerA = offerA;
    this.acceptA = acceptA;
    this.offerB = offerB;
    this.offerBRecord = offerBRecord;
    if (offerARecord !== null) {
      this.offerARecord = offerARecord;
      this.acceptARecord = acceptARecord;
    }
    return { acceptA, acceptARecord, offerB, offerBRecord };
  }

  /** Post this Seller's own leg-A account/key line (D-08) into leg A's deal room, as the payee
   *  - required before the Buyer may lock (SPEC section 3, section 6).
   *
   *  P8-RESUME-SPEC.md rules 1 and 3: with a store, the proven line is built ONCE and its exact text saved before it
   *  is posted; a repeat (or a resumed call) re-posts only that text, only when the room lacks it, and never once leg
   *  A's lock frame is in the room (a line after it would not count). A different address than the saved one is
   *  refused: a party never posts a second, different account line. */
  async postAccountLineA(address: string): Promise<TranscriptRecord> {
    const { offerA, acceptA } = this.requireAcceptedA();
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
    const saved = journal.record.ownAccountLine;
    if (saved !== undefined && saved.address !== address) {
      throw new FlowRecordConflictError("seller: this swap's account line was already built for another address; a party never posts a second, different account line");
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
      guard: (roomRecords) => {
        const lockPosted = roomRecords.some((candidate) => verifyTranscriptRecord(candidate).ok && tryDecodeFrame(candidate.line)?.type === "lock");
        if (lockPosted) {
          throw new FlowRecordConflictError("seller: refusing to post the account line - leg A's lock frame is already in the room, so the line would not count (rule 3)");
        }
      },
    });
  }

  /**
   * Lock leg B on the paper rail once the Buyer's own accept names our `offerB` — the payer
   * (this Seller) is the only party the tclk state machine lets post the `lock` frame.
   *
   * P22-P24-EVM-FIXES.md B1 (CRITICAL): `acceptBRecord` must be the actual signed record the
   * accept arrived as (`OFFER_ROOM`, the same lane offers/accepts are posted to) — this method
   * re-derives every fact it trusts from it rather than from a caller-supplied `AcceptFrame`
   * object, which is exactly what let any DID lock leg B for itself under its own statement
   * before this fix. In order: the record authenticates for `OFFER_ROOM` (signed, and the frame
   * really is from whoever signed it — `frame.from === record.sender`, never merely a
   * structurally-valid frame someone else relayed); the frame is an `accept`; its `statement`
   * is this flow's *own* minted statement (never the acceptor's — this alone defeats the
   * reviewer's attack, since an attacker who does not know this Seller's preimage cannot use
   * this Seller's statement to claim anything); its `from` is the same Buyer who opened leg A
   * (`offerA.from`) — a stranger cannot accept leg B even if it somehow learned the statement;
   * its `ref` names this flow's own `offerB`; and its `contract` is exactly the id tclk itself
   * derives for that offer/accept pair (`contractId`, recomputed — never merely trusted from
   * the frame).
   *
   * P22-P24-EVM-FIXES-R2.md C1: refuses outright when leg B is already locked, or another call
   * is already in flight — checked, and the in-flight flag set, before anything else runs
   * (including before this method's first `await`), so two calls issued back to back (even two
   * independently genuine accepts for the same leg B offer, each under its own fresh nonce and
   * therefore its own tclk contract id) can never both reach `paperRail.lock`.
   *
   * P22-P24-EVM-FIXES-R3.md E2: the same guard now also refuses once any lock has ever been
   * *attempted* (`attemptedAcceptB`), whether or not it is known to have succeeded — a failed
   * `paperRail.lock` call (a `NoteStore` that commits its write and then throws) must not leave
   * this flow free to believe leg B was never touched and try again, possibly under a different
   * contract, while the first attempt may have actually landed. `reconcileLegB()` is the only
   * way to learn the truth about that one attempt; this method itself never retries.
   */
  async lockLegB(acceptBRecord: TranscriptRecord): Promise<TranscriptRecord> {
    // P8: with a store, an attempt that was saved without an outcome is not refused but RECOVERED (below); a
    // same-process double call is still refused while one is in flight.
    if ((this.attemptedAcceptB !== undefined && this.#journal === undefined) || this.legBLockPending) {
      throw new Error("seller: refusing to lock leg B — already locked, or a lock is already in flight (C1)");
    }
    this.legBLockPending = true;
    try {
      if (this.offerB === undefined) throw new Error("seller: leg B has not been opened yet");
      if (this.#hashLock === undefined) throw new Error("seller: no secret minted for this flow");
      const { offerA } = this.requireAcceptedA();
      const offerB = this.offerB;

      if (acceptBRecord.room !== OFFER_ROOM || !verifyTranscriptRecord(acceptBRecord).ok) {
        throw new Error("seller: refusing to lock leg B — accept record does not authenticate (B1)");
      }
      const frame = tryDecodeFrame(acceptBRecord.line);
      if (frame === null || frame.type !== "accept" || frame.from !== acceptBRecord.sender) {
        throw new Error("seller: refusing to lock leg B — record is not an authenticated accept frame (B1)");
      }
      if (frame.statement !== this.#hashLock.hash) {
        throw new Error("seller: refusing to lock leg B — accept statement is not this flow's own minted statement (B1)");
      }
      if (frame.from !== offerA.from) {
        throw new Error("seller: refusing to lock leg B — accept is not from the Buyer who opened leg A (B1)");
      }
      if (frame.ref !== offerB.id) {
        throw new Error("seller: refusing to lock leg B — accept does not reference this flow's leg B offer (B1)");
      }
      const expectedContract = contractId(offerB, {
        from: frame.from,
        ref: frame.ref,
        statement: frame.statement,
        ...(frame.paymentKey === undefined ? {} : { paymentKey: frame.paymentKey }),
        nonce: frame.nonce,
      });
      if (frame.contract !== expectedContract) {
        throw new Error("seller: refusing to lock leg B — accept contract id does not match this offer/accept pair (B1)");
      }

      // R4-6 (Solana only): re-check the chain clock right before leg B's value moves (acceptLegA checked it much
      // earlier). Before the E2 latch, so a refusal leaves the flow free to retry once the clocks agree again.
      if (this.rail.chainClockMs !== undefined) {
        const problem = chainClockProblem(await this.rail.chainClockMs(), this.clock(), this.rail.maxChainClockSkewMs);
        if (problem !== null) throw new Error(`seller: refusing to lock leg B - ${problem}`);
      }

      const acceptB = frame;
      const termsB = offerAcceptLockTerms(offerB, acceptB);
      if (this.#journal !== undefined) return await this.lockLegBPersisted(acceptB, acceptBRecord, termsB);
      // E2: latch the attempted accept *before* calling `paperRail.lock` — if that call throws
      // after its own write actually committed (a crash, a dropped ack), this flow must still
      // remember which contract it tried, permanently, rather than forget the attempt the
      // moment the promise rejects.
      this.attemptedAcceptB = acceptB;
      await this.paperRail.lock(termsB);
      this.lockedLegBContract = acceptB.contract;
      const lockFrame: LockFrame = { type: "lock", from: this.identity.did, contract: acceptB.contract, rail: "paper", ref: acceptB.contract };
      return await this.venue.post(dealRoom(acceptB.contract), encodeFrame(lockFrame), this.identity);
    } finally {
      // E2: `attemptedAcceptB` is deliberately NEVER cleared here, success or failure — see the
      // field's own comment and `reconcileLegB` below.
      this.legBLockPending = false;
    }
  }

  /** The text of the `lock` frame this Seller posts for leg B (the paper rail, ref = the contract). */
  private lockFrameB(contract: string): string {
    const lockFrame: LockFrame = { type: "lock", from: this.identity.did, contract, rail: "paper", ref: contract };
    return encodeFrame(lockFrame);
  }

  /**
   * P8-RESUME-SPEC.md "Seller lock B" (rules 1, 2 and 3): the intent (which accept, the signed accept record, the
   * lock frame's text) is saved BEFORE the note write. `paperRail.lock` is set-if-absent: when it refuses because a
   * record exists, a read decides, and a note that carries our terms is ADOPTED (an earlier attempt, ours, landed). Then
   * the lock frame is posted once as the saved text, or adopted from the deal room. This is the whole recovery:
   * a lock whose frame never got posted is finished by the same call, and a second, different accept B is refused.
   */
  private async lockLegBPersisted(acceptB: AcceptFrame, acceptBRecord: TranscriptRecord, termsB: ReturnType<typeof offerAcceptLockTerms>): Promise<TranscriptRecord> {
    const journal = this.#journal;
    if (journal === undefined) throw new Error("seller: no journal"); // unreachable: the caller checked
    if (this.attemptedAcceptB !== undefined && this.attemptedAcceptB.contract !== acceptB.contract) {
      throw new FlowRecordConflictError("seller: refusing to lock leg B for a different accept than the one already attempted (E2, C1)");
    }
    this.attemptedAcceptB = acceptB;
    this.acceptBRecord = acceptBRecord;
    await journal.update((r) => ({
      ...r,
      contractB: acceptB.contract,
      frames: { ...r.frames, acceptB: { text: acceptBRecord.line, record: recordToJson(acceptBRecord) } },
    })); // attemptedAcceptB rides in through the projection: durable BEFORE the note write
    if (this.lockedLegBContract !== acceptB.contract) {
      try {
        await this.paperRail.lock(termsB);
      } catch (error) {
        // A repeated attempt, or one whose acknowledgement was lost: the note is ours if it carries our terms.
        if (!(await this.paperRail.verifyLock(termsB, acceptB.contract))) throw error;
      }
      this.lockedLegBContract = acceptB.contract;
      await this.persist();
    }
    return journal.ensurePosted({ kind: "lock-b", room: dealRoom(acceptB.contract), text: this.lockFrameB(acceptB.contract) });
  }

  /**
   * P22-P24-EVM-FIXES-R3.md E2: the only way forward after a `lockLegB` call that threw — reads
   * the paper rail for the *exact* contract this flow attempted (never a different one) and
   * reports the truth `lockLegB` itself could not: whether the lock actually landed despite the
   * error, or never happened at all. Sets `lockedLegBContract` (so `refundLegB` can proceed)
   * when it did. Throws if `lockLegB` was never called, or never got far enough to attempt a
   * lock (nothing to reconcile).
   */
  async reconcileLegB(): Promise<{ locked: boolean }> {
    if (this.attemptedAcceptB === undefined) {
      throw new Error("seller: nothing to reconcile — leg B lock was never attempted (E2)");
    }
    if (this.offerB === undefined) throw new Error("seller: leg B has not been opened yet");
    const acceptB = this.attemptedAcceptB;
    const termsB = offerAcceptLockTerms(this.offerB, acceptB);
    const locked = await this.paperRail.verifyLock(termsB, acceptB.contract);
    if (locked) {
      this.lockedLegBContract = acceptB.contract;
      // P8: a lock the read found is saved, and its lock frame is posted if the deal room lacks it (this closes the
      // gap where a lock whose frame never posted stayed unannounced for good).
      if (this.#journal !== undefined) {
        await this.persist();
        await this.#journal.ensurePosted({ kind: "lock-b", room: dealRoom(acceptB.contract), text: this.lockFrameB(acceptB.contract) });
      }
    }
    return { locked };
  }

  /**
   * D-11: claim leg A only once `verifyLockFinal(A)` is `true` (a real, finalized on-chain
   * lock matching every term — never a tclk frame alone). Reveals the secret by posting it
   * (SPEC's "reveal is public by design"); never logs it before this. `options.skipReveal`
   * exists only for SPEC §6 scenario 5 (a claim that lands on chain without its reveal frame
   * ever being posted — a real race a Buyer must still recover from via `findClaimedPreimage`,
   * not something this class should make hard to exercise); every other caller leaves it unset.
   *
   * P22-P24-EVM-FIXES.md B2: `EvmHashRail.sol` enforces only `refundAfterMs` on-chain —
   * `claimByMs` and the claim-inclusion margin are this client's own guard, and they must be
   * judged against the *rail's* own clock (`rail.chainTimeMs()`), never wall-clock or
   * `this.clock()`, since chain time is what the contract will actually see when this claim
   * lands. The leg-A rail's own `claim` itself additionally simulates before ever broadcasting
   * (`src/rails/evm-htlc.ts`), so a claim that would revert (e.g. a blacklisted payee) is never
   * sent at all — this method's own margin check exists so a doomed-by-timing claim is refused
   * before spending a round trip finding that out via simulation.
   */
  async claimLegA(
    hashLockHex: string,
    options?: { skipReveal?: boolean },
  ): Promise<{ evidence: RailWriteEvidence; reveal?: TranscriptRecord; receipt: TranscriptRecord; neverLandedClaims?: number }> {
    const { offerA, acceptA } = this.requireAcceptedA();
    if (this.#hashLock === undefined) throw new Error("seller: no secret minted for this flow");
    if (hashLockHex !== this.#hashLock.hash) {
      throw new Error("seller: refusing to claim — hashLock does not match this flow's own statement");
    }

    const termsA = offerAcceptLockTerms(offerA, acceptA);

    // P4-BTC-FIXES.md G1: once this leg's lock has verified, its resolved accounts and railRef
    // are frozen permanently — a later call (only reachable when an earlier one threw before
    // ever verifying, e.g. before enough confirmations existed) reuses them rather than ever
    // re-reading the deal room, so a pubkey/account line posted meanwhile can neither help nor
    // hinder this call.
    let accounts: RailAccounts;
    let railRef: string;
    if (this.frozenLegAAccounts !== undefined && this.frozenLegARailRef !== undefined) {
      accounts = this.frozenLegAAccounts;
      railRef = this.frozenLegARailRef;
    } else {
      const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));

      // P4-BTC-FIXES.md G8: the lock rail/ref the tclk contract machine actually *accepted* for
      // this leg — never merely the first authenticated-looking payer frame
      // `findAuthenticatedLock` would find — and, alongside it, the venue seq it was accepted at
      // (G1: bounds the pubkey/account-line resolution below to lines posted strictly before
      // that point, so a line posted after the Buyer's lock can neither newly resolve nor
      // conflict-and-unresolve a party's identity for this, necessarily-later, resolution).
      const accepted =
        this.offerARecord !== undefined && this.acceptARecord !== undefined
          ? foldAcceptedLock(this.offerARecord, this.acceptARecord, dealRoomARecords)
          : null;
      // Fallback for a caller that bypassed `acceptLegA` (this flow never captured the offer's
      // own record) — the pre-G8 check, unchanged.
      const legacyLockFrame = accepted === null ? findAuthenticatedLock(dealRoomARecords, acceptA.contract, termsA.payer) : null;

      if (accepted !== null && accepted.rail === this.rail.railId) {
        // For EVM the rail ref IS the hashLock this Seller already knows authoritatively — never
        // trust the frame's own copy of it. For every other rail (btc-htlc: a funding outpoint
        // this Seller has no other way to learn) the frame's own accepted ref is the only source.
        // near-htlc (squatting fix, replacing D-N4/G5's "ref = hash lock"): the ref is
        // `0x<hash lock>:<payer>`; the Seller checks the hash-lock part against its own and takes
        // the payer part from the ref (authenticated: the lock frame is a signed record from the
        // Buyer, and the contract keys each lock by (payer, hash lock)).
        const payerKeyed = payerKeyedRefParser(this.rail.railId);
        if (payerKeyed !== undefined) {
          const parsedRef = payerKeyed(accepted.railRef);
          if (parsedRef === null || parsedRef.hashLock !== hashLockHex) {
            throw new Error(
              `seller: refusing to claim leg A — the accepted lock frame's own ref is not 0x<this flow's own hash lock>:<payer> (G5/G8, rail "${this.rail.railId}")`,
            );
          }
          railRef = accepted.railRef;
        } else if (this.rail.railId === EVM_RAIL_ID) {
          // G5: an accepted lock frame naming a DIFFERENT ref for one of these rails is not "the
          // frame is more current" — it is wrong. Refuse rather than silently prefer this
          // Seller's own value while ignoring the disagreement.
          if (accepted.railRef !== hashLockHex) {
            throw new Error(
              `seller: refusing to claim leg A — the accepted lock frame's own ref does not match this flow's own hash lock (G5/G8, rail "${this.rail.railId}")`,
            );
          }
          railRef = hashLockHex;
        } else {
          railRef = accepted.railRef;
        }
      } else if (legacyLockFrame !== null && legacyLockFrame.rail === this.rail.railId) {
        railRef = legacyLockFrame.ref;
        const legacyParser = payerKeyedRefParser(this.rail.railId);
        if (legacyParser !== undefined && legacyParser(railRef)?.hashLock !== hashLockHex) {
          throw new Error(
            `seller: refusing to claim leg A — the lock frame's own ref is not 0x<this flow's own hash lock>:<payer> (G5, rail "${this.rail.railId}")`,
          );
        }
      } else if (payerKeyedRefParser(this.rail.railId) !== undefined) {
        // No accepted lock frame names a payer, so there is no ref to read the lock by.
        throw new Error(
          `seller: refusing to claim leg A before verifyLockFinal(A) is true (D-11): no accepted lock frame carries a ${this.rail.railId} ref (0x<hash lock>:<payer>) yet`,
        );
      } else {
        railRef = hashLockHex;
      }

      accounts = this.rail.resolveAccounts(dealRoomARecords, {
        contract: acceptA.contract,
        payerDid: termsA.payer,
        payeeDid: termsA.payee,
        ...(accepted !== null ? { beforeSeq: accepted.seq } : {}),
      });
    }

    const connected = await this.rail.connect(termsA, accounts);

    // P5-NEAR-FIXES.md G2/G3: check chain state for THIS flow's own secret before ever touching
    // a deadline guard or risking a write. A retry after a lost reply from an already-successful
    // claim (G2) must recognise success from the chain rather than treat "unverified/expired" as
    // a reason to refuse; a retry after a claim whose payout failed but which already revealed
    // the preimage on chain (G3, the flow-side twin of the adapter's own H2) must skip the
    // claimByMs/margin guards below, since the contract's own F4 rule permits exactly this retry
    // past them. `findClaimedPreimage` returns a preimage regardless of whether it is EVM's own
    // `Claimed` log or near-htlc's revealed-but-`Locked` state (H2's own doc) — `verifyLockFinal`
    // is what tells the two apart.
    //
    // Scoped to `near-htlc` only (never EVM/BTC — P4-BTC-SPEC.md §7a's "no behaviour change"
    // rule): this extra read has a real cost (EVM's own `findClaimedPreimage` is a bounded
    // `eth_getLogs` scan), and neither EVM nor Bitcoin's own `claim()` has an H2-shaped
    // revealed-retry concept for this to protect against — a lost-reply retry on those rails is
    // already handled by their own rail-level idempotency/simulation, unchanged by this build.
    let skipDeadlineGuards = false;
    // SB3a/S2-2/S2-3: on the Solana rail this flow never scans history. Every claim it signed was latched before it was
    // sent; each is resolved here by its signature (landed, failed with the secret public, or never landed), and only
    // a failed one makes the secret public. A flow that never signed a claim has no leak of its own to find and does
    // the ordinary guarded claim; its one read of the escrow (Claimed with its own preimage) cannot be padded.
    const isSol = this.rail.railId === SOL_RAIL_ID;
    if (isSol) {
      const landed = await this.resolveRecordedClaims(connected, railRef);
      if (landed !== null) {
        await this.freezeLegA(accounts, railRef);
        const reveal = options?.skipReveal === true
          ? undefined
          : await this.postRevealLatched(acceptA.contract, railRef, offerA.refundAfterMs, "claim already landed on chain");
        const receipt = await this.postReceiptLatched(acceptA.contract, railRef);
        return { evidence: landed, ...(reveal === undefined ? {} : { reveal }), receipt, ...this.neverLandedField() };
      }
    }
    // P8 (rule 2, "decides by reading the chain"): with a store, a claim that was attempted on ANY rail (the flag is
    // saved before the first send) is looked for on chain before another is built: a Bitcoin claim whose reply was
    // lost and which mined before the retry, or an EVM claim that landed before a crash, posts its frames now. These
    // rails post the frames right after their write returns, so a claim the chain shows is treated as landed; NEAR and
    // Solana keep their finality rule below.
    const lookedUpOnChain = this.#journal !== undefined && this.claimAttempted && this.rail.railId !== NEAR_RAIL_ID && !isSol;
    if (this.rail.railId === NEAR_RAIL_ID || isSol || lookedUpOnChain) {
      const priorPreimage = isSol && this.publicClaimSignature !== undefined ? this.#hashLock.preimage : await connected.findClaimedPreimage(railRef);
      const revealedIsOwn = priorPreimage !== null && priorPreimage === this.#hashLock.preimage;

      if (revealedIsOwn) {
        const priorEvidence = await connected.verifyLockFinal(termsA, railRef, accounts);
        await this.freezeLegA(accounts, railRef);
        if (lookedUpOnChain || (priorEvidence.rail?.status === "claimed" && priorEvidence.rail.final)) {
          // G2: the chain already agrees this claim landed — post the frames (idempotent per
          // flow instance) and send nothing.
          this.claimOutcome = "landed";
          await this.persist();
          const reveal = options?.skipReveal === true
            ? undefined
            : await this.postRevealLatched(acceptA.contract, railRef, offerA.refundAfterMs, "claim already landed on chain");
          const receipt = await this.postReceiptLatched(acceptA.contract, railRef);
          return { evidence: { ref: railRef, raw: [] }, ...(reveal === undefined ? {} : { reveal }), receipt };
        }
        // G3: revealed, but not (or no longer) finally claimed — fall through to a claim retry
        // below, skipping the deadline guards the adapter's own H2 rule already permits skipping.
        // S2-4: on Solana the retry is sent BEFORE any reveal post (the retry is what pays the Seller; the reveal
        // frame follows it, and is posted best-effort if the retry cannot land).
        skipDeadlineGuards = true;
      }
    }

    // R3-2: after a claim that never landed the secret may already have been seen, so the Seller keeps claiming up to
    // the rail's own landing bound (refundAfterMs minus the landing margin) instead of stopping at the policy margin;
    // the rail still refuses a claim that could land at or after refundAfterMs.
    const possiblySeen = isSol && this.neverLandedClaims > 0;
    if (possiblySeen && !skipDeadlineGuards) {
      // R4-6: the possibly-seen path skips the policy-margin guards below, but it keeps a flow-level lock confirmation
      // (the rail's own pre-read of the escrow is then not the only one): leg A must still verify as locked.
      const confirm = await connected.verifyLockFinal(termsA, railRef, accounts);
      if (confirm.lock.railVerified !== true) {
        throw new Error(
          `seller: refusing to claim leg A on the possibly-seen path before verifyLockFinal(A) is true (R4-6): ${confirm.lock.reason ?? "unverified"}`,
        );
      }
      await this.freezeLegA(accounts, railRef);
    }
    if (!skipDeadlineGuards && !possiblySeen) {
      // B2/C3: read before verifyLockFinal (whose own capture drains this rail's exchange log
      // when it finishes). Neither the chain's own last block nor wall-clock alone is safe to
      // judge this against: an idle chain's `latest` block can lag real time indefinitely
      // (nothing forces a new block just because time passes), so trusting it alone risks a stale
      // "still safe" reading for a claim that will actually land well after `refundAfterMs` once
      // it is finally mined; trusting wall-clock alone was the pre-B2 bug (this process's own
      // clock lagging a chain that has already moved past the deadline). `chainNow` takes
      // whichever of the two already reports the more dangerous (later) time — it is never
      // earlier than either one alone, so it can only make this guard more conservative, never
      // less.
      const chainTimeMs = await connected.chainTimeMs();
      const chainNow = Math.max(chainTimeMs, this.clock());
      if (chainNow >= offerA.claimByMs) {
        throw new Error("seller: refusing to claim leg A at/after its claimByMs (chain time) (B2/C3)");
      }
      if (offerA.refundAfterMs - chainNow < this.rail.policy.claimInclusionMarginMs) {
        throw new Error(
          `seller: refusing to claim leg A — less than the claim-inclusion margin ` +
            `(${this.rail.policy.claimInclusionMarginMs} ms) remains before refundAfterMs (chain time) (B2/C3)`,
        );
      }

      const evidence = await connected.verifyLockFinal(termsA, railRef, accounts);
      if (evidence.lock.railVerified !== true) {
        throw new Error(
          `seller: refusing to claim leg A before verifyLockFinal(A) is true (D-11): ${evidence.lock.reason ?? "unverified"}`,
        );
      }

      // P4-BTC-FIXES.md G1: freeze the accounts/railRef this call resolved, now that the lock has
      // verified for the first time — a later call (from a runner retrying after some other
      // failure below) must never re-resolve them.
      await this.freezeLegA(accounts, railRef);

      // P22-P24-EVM-FIXES-R3.md E4: `verifyLockFinal` can itself take a long time (a slow or
      // rate-limited RPC — the reviewer's own probe was a 29-minute `locks()` read); the margin
      // checked above, before it ran, is not evidence that any margin still remains now that it
      // has returned. Re-read chain time and re-apply the identical claimByMs/margin guards
      // immediately before ever calling `claim()` — never trusting the earlier reading alone.
      const chainTimeAfterVerifyMs = await connected.chainTimeMs();
      const chainNowAfterVerify = Math.max(chainTimeAfterVerifyMs, this.clock());
      if (chainNowAfterVerify >= offerA.claimByMs) {
        throw new Error("seller: refusing to claim leg A at/after its claimByMs (chain time, re-checked after verifyLockFinal) (E4)");
      }
      if (offerA.refundAfterMs - chainNowAfterVerify < this.rail.policy.claimInclusionMarginMs) {
        throw new Error(
          `seller: refusing to claim leg A — less than the claim-inclusion margin ` +
            `(${this.rail.policy.claimInclusionMarginMs} ms) remains before refundAfterMs ` +
            `(chain time, re-checked after verifyLockFinal) (E4)`,
        );
      }
    }

    // E4: the leg-A rail's own `claim` re-checks this same bound once more, against its own
    // freshly-read chain time, immediately before it actually broadcasts (defense in depth
    // against however long its own preimage-free pre-checks (E5) themselves take) — skipped
    // internally by the adapter itself on a revealed retry (H2/G3).
    const policyNotAfterMs = offerA.refundAfterMs - this.rail.policy.claimInclusionMarginMs;
    let notAfterMs = possiblySeen ? offerA.refundAfterMs - SOL_CLAIM_LANDING_MARGIN_MS : policyNotAfterMs;
    let writeEvidence: RailWriteEvidence;
    let resigns = 0;
    // SB3a: on Solana a claim retried because the chain already showed this flow's own secret public uses the
    // rail's public-secret mode (the rail proves that on chain again before it skips the bounds).
    let retryPublicSecret = isSol && skipDeadlineGuards;
    // P8 (rule 1): from here a claim may reach the network. The flag, with the frozen accounts and ref, is durable
    // BEFORE the first send on any rail (a Solana claim signature follows through `onSigned`, below).
    if (!this.claimAttempted) {
      this.claimAttempted = true;
      await this.persist();
    }
    for (let retries = 0; ; retries += 1) {
      const before = connected.exchanges.length;
      try {
        const solRecording = isSol
          ? {
              ...(this.neverLandedClaims > 0 ? { priorityFeeAttempt: this.neverLandedClaims } : {}),
              // P8: awaited by the rail BEFORE anything is simulated or sent, so the signature is durable first.
              onSigned: async (record: RailClaimRecord): Promise<void> => {
                this.claimRecords.push(record);
                await this.persist();
              },
              onNotBroadcast: async (record: RailClaimRecord): Promise<void> => {
                this.dropClaimRecord(record.signature);
                await this.persist();
              },
            }
          : {};
        writeEvidence = retryPublicSecret
          ? await connected.claim(railRef, this.#hashLock.preimage, notAfterMs, {
              retryPublicSecret: true,
              ...(this.publicClaimSignature === undefined ? {} : { proofSignature: this.publicClaimSignature }),
              ...solRecording,
            })
          : isSol
            ? await connected.claim(railRef, this.#hashLock.preimage, notAfterMs, solRecording)
            : await connected.claim(railRef, this.#hashLock.preimage, notAfterMs);
        this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
        if (writeEvidence.txHash !== undefined) this.dropClaimRecord(writeEvidence.txHash); // resolved: it landed
        this.claimOutcome = "landed";
        await this.persist();
        break;
      } catch (error) {
        this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
        // R3-2: a claim that was broadcast and never landed (starved). The secret may have been seen; count it (the
        // next claim is priced higher) and sign again while the rail's landing bound still allows it. The bound ends
        // the effort with the starved error below, never a silent drop.
        if (isSol && error instanceof SolNotLandedError) {
          this.neverLandedClaims += 1;
          this.dropClaimRecord(error.signature);
          await this.persist();
          if (resigns < SOL_NEVER_LANDED_MAX_RESIGNS) {
            resigns += 1;
            notAfterMs = offerA.refundAfterMs - SOL_CLAIM_LANDING_MARGIN_MS;
            continue;
          }
        }
        // S1 (contracts-sol/README.md): a Solana claim that landed and FAILED published the secret in its
        // instruction data. The reveal is posted (the secret is public regardless; it must land before
        // refundAfterMs, G6), and the claim is retried AT ONCE: the Buyer can read the secret off that failed
        // transaction and claim leg B, so the Seller's only protection is to be paid before the window closes.
        if (error instanceof SolClaimFailedError && error.secretPublic) {
          this.publicClaimSignature = error.signature; // SOL-C1
          this.dropClaimRecord(error.signature); // resolved: it landed and failed
          if (this.claimOutcome === "none") this.claimOutcome = "failed-public";
          await this.persist();
          // S2-4: the retry goes out first (it is what pays the Seller); the reveal frame follows the landed claim
          // (the post after the loop) or, when the retries are exhausted, just below.
          // R4-5: a public-secret retry is bounded by the window it must land in. Once the chain's (or the local) time has
          // reached refundAfterMs no claim can pay the Seller (the program refuses it) and the reveal frame is no longer
          // accepted, so the effort stops here and the original failure is reported. Inside the window the retry is
          // still sent even when landing + finality + the reveal post may not all fit: it is the only way to be paid,
          // and the reveal post below then raises RevealNotPostedError when venue time has passed refundAfterMs.
          if (retries < SOL_PUBLIC_SECRET_RETRIES) {
            const chainNowMs = Math.max(await connected.chainTimeMs(), this.clock());
            if (chainNowMs < offerA.refundAfterMs) {
              retryPublicSecret = true;
              continue;
            }
          }
        }
        // SOL-C4/C5: the secret is public on chain and the claim could not be completed: the reveal frame is owed
        // (it must land before refundAfterMs, G6), posted best-effort so a failing post never hides the real error.
        // R3-10: no longer on Solana. A reveal frame is posted only once the escrow reads Claimed (consistent with
        // the Buyer's rule): a claim that landed and failed pays nobody, so nothing is revealed for it here.
        // P5-NEAR-FIXES.md G1 (the flow-side twin of the adapter's own H1): a write's own
        // chain-level failure is never silently treated as success. `NearPayoutFailedError` means
        // the claim call itself ran and revealed the preimage on chain (the contract's own F4
        // rule) but the inner payout promise failed — the secret is now public regardless, so the
        // reveal frame is safe (and useful, it helps the Buyer learn `s` sooner) to post, but there
        // is no receipt to post: this flow does not know the payout landed, and must not claim it
        // did. Any other failure (`NearTxFailedError`: the transaction itself never took effect,
        // or any other rail's own claim failure) posts nothing at all.
        if (error instanceof NearPayoutFailedError && options?.skipReveal !== true) {
          // G6: the secret is public on chain now, so the tclk reveal must still land before
          // refundAfterMs. Retried, and if it still fails the distinct RevealNotPostedError (its
          // message carries the payout failure) replaces the bare payout error.
          await this.postRevealLatched(acceptA.contract, railRef, offerA.refundAfterMs, `payout failed: ${error.message}`);
        }
        if (isSol && this.neverLandedClaims > 0 && !(error instanceof SolPendingError) && !(error instanceof SolClaimFailedError) && !(error instanceof RevealNotPostedError) && !(error instanceof SolClaimStarvedError)) {
          throw new SolClaimStarvedError(this.neverLandedClaims, error);
        }
        throw error;
      }
    }

    // vendor/tclk/src/machine.ts's own "reveal" transition requires the frame's `ref`, when
    // present, to equal the contract's own accepted `railRef` (identical rule to refund/receipt
    // above) — `railRef`, never `hashLockHex` (only ever the same value by coincidence for
    // evm-htlc; for btc-htlc a reveal naming the hashLock instead of the outpoint is REJECTED by
    // the machine, leaving leg A stuck at `"locked"` forever despite a real, valid claim).
    const reveal = options?.skipReveal === true
      ? undefined
      : await this.postRevealLatched(acceptA.contract, railRef, offerA.refundAfterMs, "claim landed on chain");
    // tclk's own machine requires a receipt frame's `ref`, when present, to equal the contract's
    // own accepted `railRef` (vendor/tclk/src/machine.ts) — `railRef`, never `hashLockHex` (only
    // ever the same value by coincidence for evm-htlc).
    const receipt = await this.postReceiptLatched(acceptA.contract, railRef);

    return { evidence: writeEvidence, ...(reveal === undefined ? {} : { reveal }), receipt, ...this.neverLandedField() };
  }

  /** G1: freeze this leg's resolved accounts and rail ref the first time they are relied on. P8: and save them. */
  private async freezeLegA(accounts: RailAccounts, railRef: string): Promise<void> {
    if (this.frozenLegAAccounts !== undefined) return;
    this.frozenLegAAccounts = accounts;
    this.frozenLegARailRef = railRef;
    await this.persist();
  }

  private neverLandedField(): { neverLandedClaims?: number } {
    return this.neverLandedClaims > 0 ? { neverLandedClaims: this.neverLandedClaims } : {};
  }

  private dropClaimRecord(signature: string): void {
    this.claimRecords = this.claimRecords.filter((record) => record.signature !== signature);
  }

  /** S2-2 (Solana): resolves every recorded claim by its signature, oldest first, before anything new is signed.
   *  Returns the evidence of a claim that LANDED (the Seller was paid: nothing more to send), else `null`. A claim
   *  that landed and FAILED sets the public-secret proof (its own signature); one that never landed is dropped. A
   *  claim that is not decided yet (`SolPendingError`) or a transport failure propagates and keeps its record: the
   *  caller retries `claimLegA` later, and no second claim is signed while an earlier one could still land. */
  private async resolveRecordedClaims(connected: ConnectedCounterAssetRail, railRef: string): Promise<RailWriteEvidence | null> {
    if (connected.recoverClaim === undefined) return null;
    for (const record of [...this.claimRecords]) {
      let recovery;
      try {
        recovery = await connected.recoverClaim(railRef, record);
      } catch (error) {
        // R3-3: once the secret is public, an earlier retry that is still undecided must not hold up the next one
        // (that wait is what a starved or slow retry would turn into a lost payout). The record stays latched (it may
        // still land and is resolved on a later call); a fresh claim is signed now, and whichever lands first pays.
        if (error instanceof SolPendingError && this.publicClaimSignature !== undefined) continue;
        throw error;
      }
      this.dropClaimRecord(record.signature);
      if (recovery.outcome === "never-landed") this.neverLandedClaims += 1; // R3-2: broadcast, never landed: possibly seen
      if (recovery.outcome === "landed") {
        this.claimRecords = [];
        this.claimOutcome = "landed";
        await this.persist();
        return recovery.evidence;
      }
      if (recovery.outcome === "failed-public" && this.publicClaimSignature === undefined) {
        this.publicClaimSignature = record.signature;
        if (this.claimOutcome === "none") this.claimOutcome = "failed-public";
      }
      await this.persist();
    }
    return null;
  }

  /** G6: post the leg-A reveal once per (contract, ref); retried a bounded number of times, then
   *  a distinct `RevealNotPostedError` (never a silent skip). */
  private async postRevealLatched(contract: string, ref: string, refundAfterMs: number, detail: string): Promise<TranscriptRecord> {
    const key = `${contract}|${ref}`;
    if (this.revealPosted?.key === key) return this.revealPosted.record;
    let last: unknown;
    const journal = this.#journal;
    const isSolRail = this.rail.railId === SOL_RAIL_ID;
    for (let attempt = 0; attempt < REVEAL_POST_ATTEMPTS; attempt++) {
      // R4-5 (Solana): tclk's machine only accepts a reveal while the contract is still locked, and the buyer's refund
      // frame may land from refundAfterMs on. Once venue time (the flow's clock, the same one the venue stamps with) is
      // past it the post is not attempted: the claim is on chain but cannot be recorded. The fold reports it
      // ("leg A claimed on chain but its reveal frame was not recorded").
      if (this.rail.railId === SOL_RAIL_ID && this.clock() >= refundAfterMs) {
        throw new RevealNotPostedError(refundAfterMs, last ?? new Error("venue time is at/after refundAfterMs"), `${detail}; not attempted after refundAfterMs`);
      }
      try {
        const line = encodeFrame({ type: "reveal", from: this.identity.did, contract, ref, secret: this.#hashLock!.preimage });
        // P8 (rules 1 and 3): with a store the exact text is saved before the first attempt, an earlier attempt's line in
        // the room is adopted, and the landed seq is saved after. This record is the Seller's own, so the text (which
        // carries the preimage) is allowed to be in it.
        const record = journal !== undefined
          ? await journal.ensurePosted({
              kind: "reveal-a",
              room: dealRoom(contract),
              text: line,
              ...(isSolRail
                ? {
                    post: (room: string, text: string) => this.postBounded(room, text),
                    read: (room: string) => this.bounded(this.venue.read(room), "the deal room read"),
                  }
                : {}),
            })
          : isSolRail
            ? await this.postBounded(dealRoom(contract), line)
            : await this.venue.post(dealRoom(contract), line, this.identity);
        this.revealPosted = { key, record };
        return record;
      } catch (error) {
        last = error;
        // S2-4: an attempt that timed out may still have landed; adopt it instead of posting a second reveal.
        if (isSolRail) {
          const adopted = await this.findOwnRevealBounded(contract, ref);
          if (adopted !== null) {
            if (journal !== undefined) {
              await journal.adopt({ kind: "reveal-a", room: dealRoom(contract), text: adopted.line }, adopted);
            }
            this.revealPosted = { key, record: adopted };
            return adopted;
          }
        }
      }
    }
    throw new RevealNotPostedError(refundAfterMs, last, detail);
  }

  /** S2-4: one venue call bounded by `revealPostTimeoutMs` (a real timer): a stalled venue rejects instead of hanging. */
  private bounded<T>(work: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`seller: ${what} did not answer within ${this.revealPostTimeoutMs} ms`)), this.revealPostTimeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private postBounded(room: string, line: string): Promise<TranscriptRecord> {
    return this.bounded(this.venue.post(room, line, this.identity), "the reveal post");
  }

  /** This Seller's own reveal frame already in leg A's deal room (from an attempt whose answer was lost), or null. */
  private async findOwnRevealBounded(contract: string, ref: string): Promise<TranscriptRecord | null> {
    try {
      const records = await this.bounded(this.venue.read(dealRoom(contract)), "the deal room read");
      for (const record of records) {
        if (record.sender !== this.identity.did || !verifyTranscriptRecord(record).ok) continue;
        const frame = tryDecodeFrame(record.line);
        if (frame !== null && frame.type === "reveal" && frame.contract === contract && frame.ref === ref && frame.secret === this.#hashLock?.preimage) return record;
      }
    } catch {
      // a venue that cannot answer is the same as no adoption: the next attempt posts
    }
    return null;
  }

  /** G6: post the leg-A `claimed` receipt once per (contract, ref). */
  private async postReceiptLatched(contract: string, ref: string): Promise<TranscriptRecord> {
    const key = `${contract}|${ref}`;
    if (this.receiptPosted?.key === key) return this.receiptPosted.record;
    const line = encodeFrameWith({ type: "receipt", from: this.identity.did, contract, outcome: "claimed", rail: this.rail.railId, ref }, this.rail.railRegistry);
    const record =
      this.#journal !== undefined
        ? await this.#journal.ensurePosted({ kind: "receipt-a", room: dealRoom(contract), text: line })
        : await this.venue.post(dealRoom(contract), line, this.identity);
    this.receiptPosted = { key, record };
    return record;
  }

  /** Refund leg B only at/after `B.refundAfterMs` (the tclk `PaperRail` itself also enforces
   *  this and would throw; this check exists so the error names the rule from this class's own
   *  vocabulary, not the rail's). */
  async refundLegB(): Promise<{ refund: TranscriptRecord; receipt: TranscriptRecord }> {
    if (this.offerB === undefined || this.acceptA === undefined) {
      throw new Error("seller: leg B has not been opened yet");
    }
    const offerB = this.offerB;
    if (this.clock() < offerB.refundAfterMs) {
      throw new Error("seller: refusing to refund leg B before its refundAfterMs");
    }
    // `acceptB`'s contract is what `lockLegB` locked; refund needs the same ref (SPEC/tclk:
    // refund.ref, when present, must equal the lock's own railRef, which for paper is the
    // contract itself). The caller only ever reaches this after `lockLegB`, so we recover the
    // contract from the last-posted leg-B deal room this flow itself locked into.
    const contractB = this.lockedLegBContract;
    if (contractB === undefined) throw new Error("seller: leg B was never locked, nothing to refund");
    const refundText = encodeFrame({ type: "refund", from: this.identity.did, contract: contractB, ref: contractB });
    const receiptText = encodeFrame({ type: "receipt", from: this.identity.did, contract: contractB, outcome: "refunded", rail: "paper", ref: contractB });
    const journal = this.#journal;
    if (journal === undefined) {
      await this.paperRail.refund(contractB);
      const refund = await this.venue.post(dealRoom(contractB), refundText, this.identity);
      const receipt = await this.venue.post(dealRoom(contractB), receiptText, this.identity);
      return { refund, receipt };
    }
    // P8 (rules 1 and 3): the intent is saved BEFORE the note write. The repeated paper write that threw "refund on a
    // refunded record" is no longer reached: a note that already shows our refund is taken as done, and the missing
    // frames are posted (each once, as the saved text, or adopted).
    if (!this.legBRefundDone) {
      this.legBRefundAttempted = true;
      await this.persist();
      try {
        await this.paperRail.refund(contractB);
      } catch (error) {
        const note = await this.paperRail.read(contractB);
        if (note === null || note.status !== "refunded") throw error;
      }
      this.legBRefundDone = true;
      await this.persist();
    }
    const refund = await journal.ensurePosted({ kind: "refund-b", room: dealRoom(contractB), text: refundText });
    const receipt = await journal.ensurePosted({ kind: "receipt-refund-b", room: dealRoom(contractB), text: receiptText });
    return { refund, receipt };
  }
}
