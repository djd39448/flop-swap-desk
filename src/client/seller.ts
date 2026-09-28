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
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6.

import type { Address, Hex } from "viem";
import {
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  PaperRail,
  type AcceptFrame,
  type HashLock,
  type LockFrame,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { checkOrientation, classifySwapOffer, legBContext } from "../profile.js";
import { formatAccountLine, resolveAccounts } from "../rails/account-line.js";
import { EvmHtlcRail, type EvmRailConfig, type WriteEvidence } from "../rails/evm-htlc.js";
import type { CapturingRpc } from "../rails/rpc-capture.js";
import type { AddressBook } from "../vendor/evm-hash-rail.js";
import { offerAcceptLockTerms } from "../swap.js";
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

  constructor(options: SellerFlowOptions) {
    this.identity = options.identity;
    this.venue = options.venue;
    this.paperRail = options.paperRail;
    this.account = options.account;
    this.rpc = options.rpc;
    this.evmConfig = options.evmConfig;
    this.clock = options.clock;
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
   */
  async acceptLegA(offerA: OfferFrame, legB: LegBDeadlines): Promise<AcceptLegAResult> {
    if (this.offerA !== undefined) throw new Error("seller: leg A already accepted for this flow");

    const classification = classifySwapOffer(offerA);
    if (classification === null || classification.context.leg !== "a") {
      throw new Error("seller: refusing to accept — offer is not a leg-A swap offer");
    }
    const orientation = checkOrientation(offerA, classification.context);
    if (!orientation.ok) {
      throw new Error(`seller: refusing to accept an unsafe leg A offer: ${orientation.reason}`);
    }

    const hashLock = generateHashLock();
    const acceptA = makeAccept(offerA, { from: this.identity.did, statement: hashLock.hash });
    await this.venue.post("tclk-offers", encodeFrame(acceptA), this.identity);

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
    await this.venue.post("tclk-offers", encodeFrame(offerB), this.identity);

    // Only now, after both posts succeeded, does this flow consider leg A accepted — a post
    // failure must not leave `this.hashLock` set with nothing on the venue to back it.
    this.offerA = offerA;
    this.acceptA = acceptA;
    this.hashLock = hashLock;
    this.offerB = offerB;
    return { acceptA, offerB };
  }

  /** Post this Seller's own EVM account (D-08) into leg A's deal room, as the payee — required
   *  before the Buyer may lock (SPEC §3, §6). */
  async postAccountLineA(evmAddress: Address): Promise<TranscriptRecord> {
    const { acceptA } = this.requireAcceptedA();
    const line = formatAccountLine({ railId: "evm-htlc", caip2: this.evmConfig.pin.caip2, address: evmAddress });
    return this.venue.post(dealRoom(acceptA.contract), line, this.identity);
  }

  /** Lock leg B on the paper rail once the Buyer's own accept names our `offerB` — the payer
   *  (this Seller) is the only party the tclk state machine lets post the `lock` frame. */
  async lockLegB(acceptB: AcceptFrame): Promise<TranscriptRecord> {
    if (this.offerB === undefined) throw new Error("seller: leg B has not been opened yet");
    if (acceptB.ref !== this.offerB.id) {
      throw new Error("seller: refusing to lock — accept does not reference this flow's leg B offer");
    }
    const termsB = offerAcceptLockTerms(this.offerB, acceptB);
    await this.paperRail.lock(termsB);
    this.lockedLegBContract = acceptB.contract;
    const lockFrame: LockFrame = { type: "lock", from: this.identity.did, contract: acceptB.contract, rail: "paper", ref: acceptB.contract };
    return this.venue.post(dealRoom(acceptB.contract), encodeFrame(lockFrame), this.identity);
  }

  /**
   * D-11: claim leg A only once `verifyLockFinal(A)` is `true` (a real, finalized on-chain
   * lock matching every term — never a tclk frame alone) and strictly before `A.claimByMs`.
   * Reveals the secret by posting it (SPEC's "reveal is public by design"); never logs it
   * before this. `options.skipReveal` exists only for SPEC §6 scenario 5 (a claim that lands
   * on chain without its reveal frame ever being posted — a real race a Buyer must still
   * recover from via `findClaimedPreimage`, not something this class should make hard to
   * exercise); every other caller leaves it unset.
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
    if (this.clock() >= offerA.claimByMs) {
      throw new Error("seller: refusing to claim leg A at/after its claimByMs");
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
    const evidence = await rail.verifyLockFinal(termsA, hashLockHex, accounts);
    if (evidence.lock.railVerified !== true) {
      throw new Error(
        `seller: refusing to claim leg A before verifyLockFinal(A) is true (D-11): ${evidence.lock.reason ?? "unverified"}`,
      );
    }

    const writeEvidence = await rail.claim(hashLockHex, this.hashLock.preimage as Hex);

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
