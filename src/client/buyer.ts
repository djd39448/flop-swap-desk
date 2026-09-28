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
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6; P22-P24-EVM-FIXES.md B3, B5;
// P22-P24-EVM-FIXES-R2.md C2, C4; P22-P24-EVM-FIXES-R3.md E1, E3; P4-BTC-SPEC.md §7a.

import {
  contractId,
  dealRoom,
  encodeFrame,
  makeAccept,
  makeOffer,
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
import { checkLegBMatchesWant, checkOrientation, classifySwapOffer, legAContext } from "../profile.js";
import type { Exchange } from "../rails/rpc-capture.js";
import { offerAcceptLockTerms } from "../swap.js";
import type { CounterAssetRail, RailBlockMarker, RailWriteEvidence } from "./counter-rail.js";
import { EVM_LOCAL_POLICY, type RailLocalPolicy } from "./policy.js";
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
  /** The deadline policy every `checkSwapDeadlines`/margin guard in this flow checks against —
   *  `EVM_LOCAL_POLICY` when omitted (P4-BTC-SPEC.md §7a: this field did not exist before the
   *  Bitcoin leg, so every pre-existing caller that never passed one keeps its exact prior
   *  behaviour unchanged); a `btc-htlc` rail is paired with `BTC_LOCAL_POLICY`. */
  policy?: RailLocalPolicy;
  clock: () => number;
}

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
 * One Buyer's view of one swap. Call order (SPEC §6): `bid` → `acceptLegB` →
 * `verifyLegBLocked` → `postAccountLineA` → `lockLegA` → (`learnSecret` → `claimLegB`) |
 * `refundLegA`.
 */
export class BuyerFlow {
  private readonly identity: Signer;
  private readonly venue: Venue;
  private readonly paperRail: PaperRail;
  private readonly rail: CounterAssetRail;
  private readonly policy: RailLocalPolicy;
  private readonly clock: () => number;

  private offerA?: OfferFrame;
  private offerB?: OfferFrame;
  private acceptA?: AcceptFrame;
  private acceptB?: AcceptFrame;
  /** P22-P24-EVM-FIXES-R3.md E1: set synchronously, before `acceptLegB`'s first `await`, the
   *  same re-entry pattern `SellerFlow.lockLegB` uses (C1) — so two calls issued back to back
   *  (even two independently genuine `offerB`/`acceptA` pairs, e.g. a Seller who posted a
   *  second leg-B offer for the same leg A) can never both pair this flow to a leg B. */
  private legBPairingPending = false;
  private legBVerified = false;
  private lockedHashLock?: string;
  /** P4-BTC-SPEC.md §7a: the leg-A rail's own write ref for this flow's lock — `hashLock` for
   *  `evm-htlc` (`WriteEvidence.ref === terms.statement`), the funding outpoint
   *  (`"<txid>:<vout>"`) for `btc-htlc`. `refundLegA`/`learnSecret` must use THIS, never
   *  `lockedHashLock`, wherever the rail's own interface asks for a `ref` — the two happen to be
   *  the same value for `evm-htlc` today, which is exactly why this distinction was invisible
   *  before a second, outpoint-keyed rail existed. */
  private lockedRailRef?: string;
  private lockedFromBlock?: RailBlockMarker;
  /** B5: every leg-A write this flow has made so far (`lockLegA`'s lock, `refundLegA`'s
   *  refund), in call order — see the identical field on `SellerFlow`. */
  private readonly writeExchanges: Exchange[] = [];

  constructor(options: BuyerFlowOptions) {
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

  private requirePaired(): { offerA: OfferFrame; offerB: OfferFrame; acceptA: AcceptFrame; acceptB: AcceptFrame } {
    if (this.offerA === undefined || this.offerB === undefined || this.acceptA === undefined || this.acceptB === undefined) {
      throw new Error("buyer: leg B has not been accepted yet");
    }
    return { offerA: this.offerA, offerB: this.offerB, acceptA: this.acceptA, acceptB: this.acceptB };
  }

  /** Open leg A: a bid naming the counter-asset this Buyer pays and the FLOP it wants back,
   *  with `rails: ["evm-htlc"]` and `feeBps` 0 (every deployment we operate). */
  async bid(params: BidParams): Promise<OfferFrame> {
    if (this.offerA !== undefined) throw new Error("buyer: already bid for this flow");
    const offerA = makeOffer({
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
    });
    await this.venue.post("tclk-offers", encodeFrame(offerA), this.identity);
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
    if (this.offerA === undefined) throw new Error("buyer: no leg A offer to pair leg B against");
    if (this.offerB !== undefined || this.legBPairingPending) {
      throw new Error("buyer: refusing to accept leg B — already paired, or a pairing is already in flight (E1)");
    }
    this.legBPairingPending = true;
    try {
      return await this.acceptLegBUnlatched(offerBRecord, acceptARecord, lockTimeMs);
    } finally {
      this.legBPairingPending = false;
    }
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
    const deadlineCheck = checkSwapDeadlines(this.offerA, offerB, lockTimeMs, this.policy);
    if (!deadlineCheck.ok) {
      throw new Error(`buyer: refusing to accept leg B — unsafe deadlines: ${deadlineCheck.violations.join("; ")}`);
    }

    const acceptB = makeAccept(offerB, { from: this.identity.did, statement: acceptAFrame.statement });
    const acceptBRecord = await this.venue.post("tclk-offers", encodeFrame(acceptB), this.identity);

    this.offerB = offerB;
    this.acceptA = acceptAFrame;
    this.acceptB = acceptB;
    return { acceptB, acceptBRecord };
  }

  /** Verify leg B is actually locked on the paper rail before trusting it as cover for locking
   *  leg A — a signed `lock` frame alone is not evidence of anything (tclk#180). */
  async verifyLegBLocked(): Promise<void> {
    const { offerB, acceptB } = this.requirePaired();
    const termsB = offerAcceptLockTerms(offerB, acceptB);
    const verified = await this.paperRail.verifyLock(termsB, acceptB.contract);
    if (!verified) {
      throw new Error("buyer: refusing to proceed — leg B does not verify on the paper rail");
    }
    this.legBVerified = true;
  }

  /** Post this Buyer's own leg-A account/key line (D-08) into leg A's deal room, as (optional)
   *  corroborating payer information. */
  async postAccountLineA(address: string): Promise<TranscriptRecord> {
    const { acceptA } = this.requirePaired();
    const line = this.rail.formatAccountLine(address);
    return this.venue.post(dealRoom(acceptA.contract), line, this.identity);
  }

  /**
   * Lock leg A on this flow's counter-asset rail — refused until leg B has verified
   * (`verifyLegBLocked`) and the Seller's own account line resolves in leg A's deal room (D-08:
   * only the payee's line is required). The rail's own connected handle resolves the payee's
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
    if (!this.legBVerified) {
      throw new Error("buyer: refusing to lock leg A before leg B verifies");
    }
    const { offerA, offerB, acceptA, acceptB } = this.requirePaired();

    const deadlineCheck = checkSwapDeadlines(offerA, offerB, this.clock(), this.policy);
    if (!deadlineCheck.ok) {
      throw new Error(
        `buyer: refusing to lock leg A — deadlines are no longer safe at lock time (B3): ${deadlineCheck.violations.join("; ")}`,
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

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    const accounts = this.rail.resolveAccounts(dealRoomARecords, {
      contract: acceptA.contract,
      payerDid: termsA.payer,
      payeeDid: termsA.payee,
    });
    if (accounts.payee === undefined) {
      throw new Error("buyer: refusing to lock leg A — the Seller's account line has not resolved (D-08)");
    }

    const connected = await this.rail.connect(termsA, accounts);

    const fromBlock = await connected.currentBlockMarker();

    // P22-P24-EVM-FIXES-R3.md E3: record this flow's own lock state from what it already knows
    // — `termsA.statement` is the hash lock the Seller committed to in `acceptA`, known before
    // this flow ever touches the chain — BEFORE the lock write ever runs, not after.
    // `refundLegA` and `learnSecret` then read the chain itself as the truth; a failed evidence
    // capture or a failed lock-frame post below must never leave this flow believing leg A was
    // "never locked" when the on-chain write may already have succeeded.
    const hashLock = termsA.statement;
    this.lockedHashLock = hashLock;
    this.lockedFromBlock = fromBlock;

    const before = connected.exchanges.length;
    const writeEvidence = await connected.lock(termsA, 0);
    this.writeExchanges.push(...connected.exchanges.slice(before)); // B5

    // P4-BTC-SPEC.md §7a: the rail's own write ref (an outpoint for btc-htlc, the hashLock for
    // evm-htlc) — recorded before the lock frame that announces it is ever posted, so a failed
    // post still leaves this flow able to recover it from `writeEvidence` alone.
    this.lockedRailRef = writeEvidence.ref;

    await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "lock", from: this.identity.did, contract: acceptA.contract, rail: this.rail.railId, ref: writeEvidence.ref }),
      this.identity,
    );

    return { hashLock, writeEvidence };
  }

  /** Learn the secret from the Seller's signed `reveal` frame when it posted one, or (SPEC
   *  §6 scenario 5) from the on-chain `Claimed` log when the Seller claimed without posting
   *  it — never guesses: a candidate preimage is only accepted once it actually opens the
   *  statement (`findClaimedPreimage` already re-checks this; `parseSwapContext`-level frame
   *  authentication covers the reveal-frame path here). */
  async learnSecret(): Promise<string> {
    const { offerA, acceptA } = this.requirePaired();
    if (this.lockedHashLock === undefined) throw new Error("buyer: leg A has not been locked yet");
    const hashLock = this.lockedHashLock;
    // P22-P24-EVM-FIXES-R3.md E3's own recovery path: if `lockLegA`'s own write threw AFTER its
    // real on-chain effect landed but BEFORE it returned a `writeEvidence` (e.g. its bounded
    // event-log lookup found nothing), `lockedRailRef` was never set — fall back to the hashLock
    // recorded before the write ever ran, which IS a valid `evm-htlc` ref (the two coincide by
    // construction, `src/rails/evm-htlc.ts`'s own `lock()`). For `btc-htlc`, where the two are
    // never the same value, this fallback cannot recover the real outpoint — a documented limit
    // of a rail whose own write ref does not exist until the write itself returns (README
    // "Bitcoin leg" known limits).
    const railRef = this.lockedRailRef ?? hashLock;

    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    for (const record of dealRoomARecords) {
      if (!verifyTranscriptRecord(record).ok) continue;
      const frame = tryDecodeFrame(record.line);
      if (frame === null || frame.type !== "reveal" || frame.from !== record.sender) continue;
      if (frame.contract !== acceptA.contract) continue;
      if (frame.ref !== undefined && frame.ref !== hashLock) continue;
      if (verifySecret("hash", hashLock, frame.secret)) return frame.secret;
    }

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    // P4-BTC-SPEC.md §6/§7a: a btc-htlc leg's `findClaimedPreimage` needs no resolved account of
    // its own (it only scans a bounded block window for a witness item that opens the hashLock
    // `connect()` already bound `termsA` with), but `connect()` itself is shared with the leg's
    // other writes — resolving accounts here costs nothing for evm-htlc (never used) and is
    // harmless for btc-htlc even though this particular call never needs them.
    const accounts = this.rail.resolveAccounts(dealRoomARecords, {
      contract: acceptA.contract,
      payerDid: termsA.payer,
      payeeDid: termsA.payee,
    });
    const connected = await this.rail.connect(termsA, accounts);
    const preimage = await connected.findClaimedPreimage(railRef, this.lockedFromBlock);
    if (preimage === null) {
      throw new Error("buyer: refusing to guess the secret — no reveal frame and no Claimed log yet");
    }
    return preimage;
  }

  /** Claim leg B on the paper rail with the learned secret, then reveal it there too (SPEC:
   *  the Buyer's own reveal on leg B, distinct from the Seller's reveal on leg A). */
  async claimLegB(secret: string): Promise<{ reveal: TranscriptRecord; receipt: TranscriptRecord }> {
    const { offerB, acceptB } = this.requirePaired();
    const termsB = offerAcceptLockTerms(offerB, acceptB);
    if (!verifySecret(termsB.lock, termsB.statement, secret)) {
      throw new Error("buyer: refusing to claim leg B — secret does not open its statement");
    }
    await this.paperRail.claim(acceptB.contract, secret);
    const reveal = await this.venue.post(
      dealRoom(acceptB.contract),
      encodeFrame({ type: "reveal", from: this.identity.did, contract: acceptB.contract, ref: acceptB.contract, secret }),
      this.identity,
    );
    const receipt = await this.venue.post(
      dealRoom(acceptB.contract),
      encodeFrame({ type: "receipt", from: this.identity.did, contract: acceptB.contract, outcome: "claimed", rail: "paper", ref: acceptB.contract }),
      this.identity,
    );
    return { reveal, receipt };
  }

  /** Refund leg A only at/after `A.refundAfterMs` — the leg-A rail's own `refund` also enforces
   *  this on-chain; this check exists so a caller sees this class's own reason. */
  async refundLegA(): Promise<RailWriteEvidence> {
    const { offerA, acceptA } = this.requirePaired();
    if (this.lockedHashLock === undefined) throw new Error("buyer: leg A was never locked, nothing to refund");
    if (this.clock() < offerA.refundAfterMs) {
      throw new Error("buyer: refusing to refund leg A before its refundAfterMs");
    }
    // E3's own recovery path (see the identical comment on `learnSecret`): fall back to the
    // pre-recorded hashLock when the write itself never returned a `writeEvidence` — valid for
    // `evm-htlc`, a documented limit for `btc-htlc`.
    const railRef = this.lockedRailRef ?? this.lockedHashLock;
    const termsA = offerAcceptLockTerms(offerA, acceptA);
    // P4-BTC-SPEC.md §6: unlike evm-htlc (whose `refund` needs no resolved account at all), a
    // btc-htlc refund needs BOTH parties' pubkeys to rebuild its own witnessScript — resolve
    // them from the deal room the same way `lockLegA`/`claimLegA` already do, rather than
    // connecting with an empty `RailAccounts` and letting the rail discover the gap itself.
    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    const accounts = this.rail.resolveAccounts(dealRoomARecords, {
      contract: acceptA.contract,
      payerDid: termsA.payer,
      payeeDid: termsA.payee,
    });
    const connected = await this.rail.connect(termsA, accounts);
    const before = connected.exchanges.length;
    const writeEvidence = await connected.refund(railRef);
    this.writeExchanges.push(...connected.exchanges.slice(before)); // B5
    // tclk's own machine requires a refund/receipt frame's `ref`, when present, to equal the
    // contract's own accepted `railRef` (vendor/tclk/src/machine.ts) — the rail's own write ref,
    // never `lockedHashLock` (only ever true by coincidence for evm-htlc).
    await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "refund", from: this.identity.did, contract: acceptA.contract, ref: railRef }),
      this.identity,
    );
    await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "receipt", from: this.identity.did, contract: acceptA.contract, outcome: "refunded", rail: this.rail.railId, ref: railRef }),
      this.identity,
    );
    return writeEvidence;
  }
}
