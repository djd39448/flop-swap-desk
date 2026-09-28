// SPDX-License-Identifier: MIT
//
// P22-P24-EVM-SPEC.md §6: the Seller's side of one swap — accepts leg A (the counter-asset,
// on `evm-htlc`), mints the hash statement, opens leg B (FLOP, on tclk's `paper` rail), and
// only ever claims leg A once the chain itself says the lock is final. Every step is an
// explicit method a runner calls in order (no hidden timers, no background polling); each one
// either succeeds or throws an `Error` naming the rule it refused to break — never a silent
// no-op. The secret is minted with tclk's own CSPRNG-backed `generateHashLock()`
// (vendor/tclk/src/hex.ts's `randomU8a`, Web Crypto) and lives only in a private field of this
// class: no step here ever logs it, returns it, or writes it to a frame before `claimLegA`
// reveals it on purpose.
//
// Money-moving calls (`paperRail.lock/refund`, `evmRail.claim`) are delegated to the rails
// themselves, which enforce their own predicates independently (tclk's `PaperRail`, the
// vendored `EvmHashRail` via `src/rails/evm-htlc.ts`'s `EvmHtlcRail`) — this module adds the
// cross-leg and D-11 finality checks the rails have no way to know about on their own.
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
// lands; `EvmHtlcRail.claim` itself now simulates before ever broadcasting (P22-P24-EVM-FIXES
// .md B2, `src/rails/evm-htlc.ts`).
//
// B5: this flow keeps every EVM write's raw `Exchange`s (`this.exchanges`) so a bundle writer
// (`src/client/bundle.ts`) can persist them into `raw/rpc/`, making every sha256 in
// `WriteEvidence.raw` resolve to real bytes on disk.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6; P22-P24-EVM-FIXES.md B1, B2, B3, B5.

import type { Address, Hex } from "viem";
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
import { formatAccountLine, resolveAccounts } from "../rails/account-line.js";
import { EvmHtlcRail, type EvmRailConfig, type WriteEvidence } from "../rails/evm-htlc.js";
import type { CapturingRpc, Exchange } from "../rails/rpc-capture.js";
import type { AddressBook } from "../vendor/evm-hash-rail.js";
import { offerAcceptLockTerms } from "../swap.js";
import { EVM_LOCAL_POLICY } from "./policy.js";
import type { Signer, Venue } from "./venue.js";

/** Leg B never calls a write path that needs to resolve a counterparty's chain address (the
 *  paper rail has no such notion); only `EvmHtlcRail.lock` does. A Seller never locks leg A
 *  (the Buyer does), so every `EvmHtlcRail` this class connects only ever calls `claim` —
 *  which the vendored rail (`src/vendor/evm-hash-rail.ts`) never resolves through the address
 *  book at all. This inert book exists only so `EvmHtlcRail.connect`'s type has something to
 *  hold; a call into it would be this module's own bug, not a real address gap. */
function inertAddressBook(): AddressBook {
  return {
    resolve(did: string): Address {
      throw new Error(`seller: address book has no resolution for ${did} (not needed for claim/refund)`);
    },
  };
}

export interface SellerFlowOptions {
  identity: Signer;
  venue: Venue;
  /** Backs leg B (FLOP on tclk's `paper` rail) — a rehearsal surface, shared with the Buyer's
   *  own `PaperRail` instance over one `NoteStore` (`vendor/tclk/src/paper-rail.ts`). */
  paperRail: PaperRail;
  /** This party's own EVM account and the JSON-RPC transport leg A's writes go through — no
   *  private key anywhere (D-10): `EvmHtlcRail.connect` builds a viem `WalletClient` on the
   *  plain address alone. */
  account: Address;
  rpc: CapturingRpc;
  evmConfig: EvmRailConfig;
  /** Wall-clock ms, injected — never `Date.now()` inside this class (house rule). */
  clock: () => number;
}

export interface AcceptLegAResult {
  acceptA: AcceptFrame;
  /** The signed record `acceptA` was actually posted as — a runner hands this straight to
   *  `BuyerFlow.acceptLegB` (B3: it requires the authenticated record, not the bare frame). */
  acceptARecord: TranscriptRecord;
  offerB: OfferFrame;
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
  private readonly account: Address;
  private readonly rpc: CapturingRpc;
  private readonly evmConfig: EvmRailConfig;
  private readonly clock: () => number;

  private offerA?: OfferFrame;
  private acceptA?: AcceptFrame;
  private offerB?: OfferFrame;
  private hashLock?: HashLock;
  private lockedLegBContract?: string;
  /** B5: every EVM write's own raw `Exchange`s, in call order, so a bundle writer can persist
   *  them into `raw/rpc/` (every sha256 a `WriteEvidence.raw` names must resolve to real
   *  bytes). Paper-rail writes (`lockLegB`, `refundLegB`) never touch `this.rpc`, so nothing is
   *  added for them. */
  private readonly writeExchanges: Exchange[] = [];

  constructor(options: SellerFlowOptions) {
    this.identity = options.identity;
    this.venue = options.venue;
    this.paperRail = options.paperRail;
    this.account = options.account;
    this.rpc = options.rpc;
    this.evmConfig = options.evmConfig;
    this.clock = options.clock;
  }

  /** B5: every EVM write this flow has made so far, in call order. */
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
    if (inclusionWindowMs < EVM_LOCAL_POLICY.claimInclusionMarginMs) {
      throw new Error(
        `seller: refusing to accept leg A — its claimByMs..refundAfterMs window (${inclusionWindowMs} ms) is ` +
          `below the EVM claim-inclusion margin (${EVM_LOCAL_POLICY.claimInclusionMarginMs} ms) (B2)`,
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
    const deadlineCheck = checkSwapDeadlines(offerA, offerB, lockTimeMs, EVM_LOCAL_POLICY);
    if (!deadlineCheck.ok) {
      throw new Error(
        `seller: refusing to accept leg A — the leg B deadlines it would propose are unsafe: ${deadlineCheck.violations.join("; ")}`,
      );
    }

    const acceptARecord = await this.venue.post("tclk-offers", encodeFrame(acceptA), this.identity);
    await this.venue.post("tclk-offers", encodeFrame(offerB), this.identity);

    // Only now, after both posts succeeded, does this flow consider leg A accepted — a post
    // failure must not leave `this.hashLock` set with nothing on the venue to back it.
    this.offerA = offerA;
    this.acceptA = acceptA;
    this.hashLock = hashLock;
    this.offerB = offerB;
    return { acceptA, acceptARecord, offerB };
  }

  /** Post this Seller's own EVM account (D-08) into leg A's deal room, as the payee — required
   *  before the Buyer may lock (SPEC §3, §6). */
  async postAccountLineA(evmAddress: Address): Promise<TranscriptRecord> {
    const { acceptA } = this.requireAcceptedA();
    const line = formatAccountLine({ railId: "evm-htlc", caip2: this.evmConfig.pin.caip2, address: evmAddress });
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
   */
  async lockLegB(acceptBRecord: TranscriptRecord): Promise<TranscriptRecord> {
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
    await this.paperRail.lock(termsB);
    this.lockedLegBContract = acceptB.contract;
    const lockFrame: LockFrame = { type: "lock", from: this.identity.did, contract: acceptB.contract, rail: "paper", ref: acceptB.contract };
    return this.venue.post(dealRoom(acceptB.contract), encodeFrame(lockFrame), this.identity);
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
   * judged against the *chain's* own clock (`rail.latestBlockTimestampMs()`), never wall-clock
   * or `this.clock()`, since chain time is what the contract will actually see when this claim
   * lands. `EvmHtlcRail.claim` itself additionally simulates before ever broadcasting
   * (`src/rails/evm-htlc.ts`), so a claim that would revert (e.g. a blacklisted payee) is never
   * sent at all — this method's own margin check exists so a doomed-by-timing claim is refused
   * before spending a round trip finding that out via simulation.
   */
  async claimLegA(
    hashLockHex: Hex,
    options?: { skipReveal?: boolean },
  ): Promise<{ evidence: WriteEvidence; reveal?: TranscriptRecord; receipt: TranscriptRecord }> {
    const { offerA, acceptA } = this.requireAcceptedA();
    if (this.hashLock === undefined) throw new Error("seller: no secret minted for this flow");
    if (hashLockHex !== this.hashLock.hash) {
      throw new Error("seller: refusing to claim — hashLock does not match this flow's own statement");
    }

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    const accounts = resolveAccounts(dealRoomARecords, {
      contract: acceptA.contract,
      payerDid: termsA.payer,
      payeeDid: termsA.payee,
      rail: "evm-htlc",
      caip2: this.evmConfig.pin.caip2,
    });

    const rail = await EvmHtlcRail.connect({
      config: this.evmConfig,
      rpc: this.rpc,
      account: this.account,
      addressBook: inertAddressBook(),
      clock: this.clock,
    });

    // B2: chain time, not wall-clock — read before verifyLockFinal (whose own capture drains
    // this rail's exchange log when it finishes).
    const chainTimeMs = await rail.latestBlockTimestampMs();
    if (chainTimeMs >= offerA.claimByMs) {
      throw new Error("seller: refusing to claim leg A at/after its claimByMs (chain time) (B2)");
    }
    if (offerA.refundAfterMs - chainTimeMs < EVM_LOCAL_POLICY.claimInclusionMarginMs) {
      throw new Error(
        `seller: refusing to claim leg A — less than the claim-inclusion margin ` +
          `(${EVM_LOCAL_POLICY.claimInclusionMarginMs} ms) remains before refundAfterMs (chain time) (B2)`,
      );
    }

    const evidence = await rail.verifyLockFinal(termsA, hashLockHex, accounts);
    if (evidence.lock.railVerified !== true) {
      throw new Error(
        `seller: refusing to claim leg A before verifyLockFinal(A) is true (D-11): ${evidence.lock.reason ?? "unverified"}`,
      );
    }

    const before = this.rpc.exchanges().length;
    const writeEvidence = await rail.claim(hashLockHex, this.hashLock.preimage as Hex);
    this.writeExchanges.push(...this.rpc.exchanges().slice(before)); // B5

    const reveal = options?.skipReveal === true
      ? undefined
      : await this.venue.post(
          dealRoom(acceptA.contract),
          encodeFrame({ type: "reveal", from: this.identity.did, contract: acceptA.contract, ref: hashLockHex, secret: this.hashLock.preimage }),
          this.identity,
        );
    const receipt = await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "receipt", from: this.identity.did, contract: acceptA.contract, outcome: "claimed", rail: "evm-htlc", ref: hashLockHex }),
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
