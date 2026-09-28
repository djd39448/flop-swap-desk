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
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6; P22-P24-EVM-FIXES.md B1, B2, B3,
// B5; P22-P24-EVM-FIXES-R2.md C1, C3; P22-P24-EVM-FIXES-R3.md E2, E4; P4-BTC-SPEC.md §7a.

import {
  contractId,
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  tryDecodeFrame,
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
import type { Exchange } from "../rails/rpc-capture.js";
import { findAuthenticatedLock } from "../replay.js";
import { offerAcceptLockTerms } from "../swap.js";
import type { CounterAssetRail, RailWriteEvidence } from "./counter-rail.js";
import { EVM_LOCAL_POLICY, type RailLocalPolicy } from "./policy.js";
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
  /** The deadline policy every `checkSwapDeadlines`/margin guard in this flow checks against —
   *  `EVM_LOCAL_POLICY` when omitted (see `BuyerFlowOptions.policy`'s identical doc); a
   *  `btc-htlc` rail is paired with `BTC_LOCAL_POLICY`. */
  policy?: RailLocalPolicy;
  /** Wall-clock ms, injected — never `Date.now()` inside this class (house rule). */
  clock: () => number;
}

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
export class SellerFlow {
  private readonly identity: Signer;
  private readonly venue: Venue;
  private readonly paperRail: PaperRail;
  private readonly rail: CounterAssetRail;
  private readonly policy: RailLocalPolicy;
  private readonly clock: () => number;

  private offerA?: OfferFrame;
  private acceptA?: AcceptFrame;
  private offerB?: OfferFrame;
  private hashLock?: HashLock;
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
    this.policy = options.policy ?? EVM_LOCAL_POLICY;
    this.clock = options.clock;
  }

  /** B5: every leg-A write this flow has made so far, in call order. */
  get exchanges(): readonly Exchange[] {
    return this.writeExchanges;
  }

  /** The hash statement this Seller minted for the swap, once `acceptLegA` has run — safe to
   *  publish (it is what `acceptA.statement` already carries); never the preimage. */
  get statement(): string | undefined {
    return this.hashLock?.hash;
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
    if (this.offerA !== undefined) throw new Error("seller: leg A already accepted for this flow");

    const classification = classifySwapOffer(offerA);
    if (classification === null || classification.context.leg !== "a") {
      throw new Error("seller: refusing to accept — offer is not a leg-A swap offer");
    }
    const orientation = checkOrientation(offerA, classification.context);
    if (!orientation.ok) {
      throw new Error(`seller: refusing to accept an unsafe leg A offer: ${orientation.reason}`);
    }

    const inclusionWindowMs = offerA.refundAfterMs - offerA.claimByMs;
    if (inclusionWindowMs < this.policy.claimInclusionMarginMs) {
      throw new Error(
        `seller: refusing to accept leg A — its claimByMs..refundAfterMs window (${inclusionWindowMs} ms) is ` +
          `below the EVM claim-inclusion margin (${this.policy.claimInclusionMarginMs} ms) (B2)`,
      );
    }

    const hashLock = generateHashLock();
    const acceptA = makeAccept(offerA, { from: this.identity.did, statement: hashLock.hash });

    const offerB = makeOffer({
      from: this.identity.did,
      role: "payer",
      amount: classification.context.wantAmount,
      asset: classification.context.wantAsset,
      lock: "hash",
      // The declared want-rail (e.g. "flop-htlc") plus "paper" (tclk's own rehearsal rail,
      // which is what this build actually settles leg B on — there is no FLOP chain adapter
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

    // B2: the pair this Seller is about to propose, checked before anything is posted — a
    // runner that got `legB`'s deadlines wrong should not be able to make this flow commit to
    // a hash statement (and a public offer B) that the Buyer's own check would refuse anyway.
    const deadlineCheck = checkSwapDeadlines(offerA, offerB, lockTimeMs, this.policy);
    if (!deadlineCheck.ok) {
      throw new Error(
        `seller: refusing to accept leg A — the leg B deadlines it would propose are unsafe: ${deadlineCheck.violations.join("; ")}`,
      );
    }

    const acceptARecord = await this.venue.post("tclk-offers", encodeFrame(acceptA), this.identity);
    const offerBRecord = await this.venue.post("tclk-offers", encodeFrame(offerB), this.identity);

    // Only now, after both posts succeeded, does this flow consider leg A accepted — a post
    // failure must not leave `this.hashLock` set with nothing on the venue to back it.
    this.offerA = offerA;
    this.acceptA = acceptA;
    this.hashLock = hashLock;
    this.offerB = offerB;
    return { acceptA, acceptARecord, offerB, offerBRecord };
  }

  /** Post this Seller's own leg-A account/key line (D-08) into leg A's deal room, as the payee
   *  — required before the Buyer may lock (SPEC §3, §6). */
  async postAccountLineA(address: string): Promise<TranscriptRecord> {
    const { acceptA } = this.requireAcceptedA();
    const line = this.rail.formatAccountLine(address);
    return this.venue.post(dealRoom(acceptA.contract), line, this.identity);
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
    if (this.attemptedAcceptB !== undefined || this.legBLockPending) {
      throw new Error("seller: refusing to lock leg B — already locked, or a lock is already in flight (C1)");
    }
    this.legBLockPending = true;
    try {
      if (this.offerB === undefined) throw new Error("seller: leg B has not been opened yet");
      if (this.hashLock === undefined) throw new Error("seller: no secret minted for this flow");
      const { offerA } = this.requireAcceptedA();
      const offerB = this.offerB;

      if (acceptBRecord.room !== OFFER_ROOM || !verifyTranscriptRecord(acceptBRecord).ok) {
        throw new Error("seller: refusing to lock leg B — accept record does not authenticate (B1)");
      }
      const frame = tryDecodeFrame(acceptBRecord.line);
      if (frame === null || frame.type !== "accept" || frame.from !== acceptBRecord.sender) {
        throw new Error("seller: refusing to lock leg B — record is not an authenticated accept frame (B1)");
      }
      if (frame.statement !== this.hashLock.hash) {
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

      const acceptB = frame;
      const termsB = offerAcceptLockTerms(offerB, acceptB);
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
    if (locked) this.lockedLegBContract = acceptB.contract;
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
  ): Promise<{ evidence: RailWriteEvidence; reveal?: TranscriptRecord; receipt: TranscriptRecord }> {
    const { offerA, acceptA } = this.requireAcceptedA();
    if (this.hashLock === undefined) throw new Error("seller: no secret minted for this flow");
    if (hashLockHex !== this.hashLock.hash) {
      throw new Error("seller: refusing to claim — hashLock does not match this flow's own statement");
    }

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    const accounts = this.rail.resolveAccounts(dealRoomARecords, {
      contract: acceptA.contract,
      payerDid: termsA.payer,
      payeeDid: termsA.payee,
    });

    const connected = await this.rail.connect(termsA, accounts);

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
    if (offerA.refundAfterMs - chainNow < this.policy.claimInclusionMarginMs) {
      throw new Error(
        `seller: refusing to claim leg A — less than the claim-inclusion margin ` +
          `(${this.policy.claimInclusionMarginMs} ms) remains before refundAfterMs (chain time) (B2/C3)`,
      );
    }

    // P4-BTC-SPEC.md §7a: the rail's own write ref for this leg's lock — the Buyer's outpoint
    // for btc-htlc, the hashLock itself for evm-htlc (where the two happen to coincide, which is
    // why `hashLockHex` alone used to double as both, and remains the fallback below). Read from
    // the Buyer's own authenticated lock frame in leg A's deal room when one exists; a leg whose
    // rail's ref is always the hashLock (evm-htlc — verified on-chain by `verifyLockFinal` alone,
    // never by trusting this frame) has no need of one, so its absence is never itself a refusal
    // here — only `verifyLockFinal`/`claim` below can fail this claim closed.
    const lockFrame = findAuthenticatedLock(dealRoomARecords, acceptA.contract, termsA.payer);
    const railRef = lockFrame !== null && lockFrame.rail === this.rail.railId ? lockFrame.ref : hashLockHex;

    const evidence = await connected.verifyLockFinal(termsA, railRef, accounts);
    if (evidence.lock.railVerified !== true) {
      throw new Error(
        `seller: refusing to claim leg A before verifyLockFinal(A) is true (D-11): ${evidence.lock.reason ?? "unverified"}`,
      );
    }

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
    if (offerA.refundAfterMs - chainNowAfterVerify < this.policy.claimInclusionMarginMs) {
      throw new Error(
        `seller: refusing to claim leg A — less than the claim-inclusion margin ` +
          `(${this.policy.claimInclusionMarginMs} ms) remains before refundAfterMs ` +
          `(chain time, re-checked after verifyLockFinal) (E4)`,
      );
    }

    // E4: the leg-A rail's own `claim` re-checks this same bound once more, against its own
    // freshly-read chain time, immediately before it actually broadcasts (defense in depth
    // against however long its own preimage-free pre-checks (E5) themselves take).
    const notAfterMs = offerA.refundAfterMs - this.policy.claimInclusionMarginMs;
    const before = connected.exchanges.length;
    const writeEvidence = await connected.claim(railRef, this.hashLock.preimage, notAfterMs);
    this.writeExchanges.push(...connected.exchanges.slice(before)); // B5

    // vendor/tclk/src/machine.ts's own "reveal" transition requires the frame's `ref`, when
    // present, to equal the contract's own accepted `railRef` (identical rule to refund/receipt
    // above) — `railRef`, never `hashLockHex` (only ever the same value by coincidence for
    // evm-htlc; for btc-htlc a reveal naming the hashLock instead of the outpoint is REJECTED by
    // the machine, leaving leg A stuck at `"locked"` forever despite a real, valid claim).
    const reveal = options?.skipReveal === true
      ? undefined
      : await this.venue.post(
          dealRoom(acceptA.contract),
          encodeFrame({ type: "reveal", from: this.identity.did, contract: acceptA.contract, ref: railRef, secret: this.hashLock.preimage }),
          this.identity,
        );
    // tclk's own machine requires a receipt frame's `ref`, when present, to equal the contract's
    // own accepted `railRef` (vendor/tclk/src/machine.ts) — `railRef`, never `hashLockHex` (only
    // ever the same value by coincidence for evm-htlc).
    const receipt = await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "receipt", from: this.identity.did, contract: acceptA.contract, outcome: "claimed", rail: this.rail.railId, ref: railRef }),
      this.identity,
    );

    return { evidence: writeEvidence, ...(reveal === undefined ? {} : { reveal }), receipt };
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
    await this.paperRail.refund(contractB);
    const refund = await this.venue.post(
      dealRoom(contractB),
      encodeFrame({ type: "refund", from: this.identity.did, contract: contractB, ref: contractB }),
      this.identity,
    );
    const receipt = await this.venue.post(
      dealRoom(contractB),
      encodeFrame({ type: "receipt", from: this.identity.did, contract: contractB, outcome: "refunded", rail: "paper", ref: contractB }),
      this.identity,
    );
    return { refund, receipt };
  }
}
