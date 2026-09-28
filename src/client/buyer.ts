// SPDX-License-Identifier: MIT
//
// P22-P24-EVM-SPEC.md §6: the Buyer's side of one swap — opens leg A (the counter-asset,
// on `evm-htlc`), accepts leg B (FLOP, on tclk's `paper` rail) only once the deadline
// arithmetic is safe, and refuses to lock leg A until both the Seller's chain account has
// resolved (D-08) and leg B itself verifies. Every step is an explicit method a runner calls
// in order; each either succeeds or throws an `Error` naming the rule it refused to break.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6.

import type { Address, Hex } from "viem";
import {
  dealRoom,
  encodeFrame,
  makeAccept,
  makeOffer,
  PaperRail,
  tryDecodeFrame,
  verifySecret,
  verifyTranscriptRecord,
  type AcceptFrame,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { checkSwapDeadlines } from "../deadlines.js";
import { checkOrientation, classifySwapOffer, legAContext } from "../profile.js";
import { formatAccountLine, resolveAccounts } from "../rails/account-line.js";
import { EvmHtlcRail, type EvmRailConfig, type WriteEvidence } from "../rails/evm-htlc.js";
import type { CapturingRpc } from "../rails/rpc-capture.js";
import type { DeadlinePolicy } from "../types.js";
import type { AddressBook } from "../vendor/evm-hash-rail.js";
import { offerAcceptLockTerms } from "../swap.js";
import type { Signer, Venue } from "./venue.js";

/** `EvmHtlcRail.claim`/`.refund`/`.verifyLockFinal` never resolve through the address book
 *  (see the identical note in `src/client/seller.ts`); only `.lock` does, and this Buyer
 *  builds a real one for that call from `resolveAccounts`'s own resolved payee, right before
 *  using it (`lockLegA` below) — never at connect time, since the Seller's account line does
 *  not exist yet when a Buyer flow is constructed. */
function inertAddressBook(): AddressBook {
  return {
    resolve(did: string): Address {
      throw new Error(`buyer: address book has no resolution for ${did} (not needed for claim/refund/verify)`);
    },
  };
}

export interface BuyerFlowOptions {
  identity: Signer;
  venue: Venue;
  /** Backs leg B (FLOP on tclk's `paper` rail), sharing one `NoteStore` with the Seller's own
   *  `PaperRail` instance. */
  paperRail: PaperRail;
  account: Address;
  rpc: CapturingRpc;
  evmConfig: EvmRailConfig;
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
  private readonly account: Address;
  private readonly rpc: CapturingRpc;
  private readonly evmConfig: EvmRailConfig;
  private readonly clock: () => number;

  private offerA?: OfferFrame;
  private offerB?: OfferFrame;
  private acceptA?: AcceptFrame;
  private acceptB?: AcceptFrame;
  private legBVerified = false;
  private lockedHashLock?: Hex;
  private lockedFromBlock?: bigint;

  constructor(options: BuyerFlowOptions) {
    this.identity = options.identity;
    this.venue = options.venue;
    this.paperRail = options.paperRail;
    this.account = options.account;
    this.rpc = options.rpc;
    this.evmConfig = options.evmConfig;
    this.clock = options.clock;
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
      rails: ["evm-htlc"],
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
   * Accept leg B — but only after `checkSwapDeadlines` (SPEC §3.5 rules 1-3) passes for the
   * pair at the runner's declared `lockTimeMs`; a bad Seller offer (or a bad policy) is refused
   * here, before this Buyer commits to the countdown by posting a signed accept.
   */
  async acceptLegB(offerB: OfferFrame, acceptA: AcceptFrame, policy: DeadlinePolicy, lockTimeMs: number): Promise<AcceptFrame> {
    if (this.offerA === undefined) throw new Error("buyer: no leg A offer to pair leg B against");
    if (acceptA.ref !== this.offerA.id) {
      throw new Error("buyer: refusing to accept — the leg A accept does not reference this flow's own offer");
    }
    const classification = classifySwapOffer(offerB);
    if (classification === null || classification.context.leg !== "b" || classification.context.legAOfferId !== this.offerA.id) {
      throw new Error("buyer: refusing to accept — offer is not leg B of this swap");
    }
    const orientation = checkOrientation(offerB, classification.context);
    if (!orientation.ok) {
      throw new Error(`buyer: refusing to accept an unsafe leg B offer: ${orientation.reason}`);
    }
    const deadlineCheck = checkSwapDeadlines(this.offerA, offerB, lockTimeMs, policy);
    if (!deadlineCheck.ok) {
      throw new Error(`buyer: refusing to accept leg B — unsafe deadlines: ${deadlineCheck.violations.join("; ")}`);
    }

    const acceptB = makeAccept(offerB, { from: this.identity.did, statement: acceptA.statement });
    await this.venue.post("tclk-offers", encodeFrame(acceptB), this.identity);

    this.offerB = offerB;
    this.acceptA = acceptA;
    this.acceptB = acceptB;
    return acceptB;
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

  /** Post this Buyer's own EVM account (D-08) into leg A's deal room, as (optional)
   *  corroborating payer information. */
  async postAccountLineA(evmAddress: Address): Promise<TranscriptRecord> {
    const { acceptA } = this.requirePaired();
    const line = formatAccountLine({ railId: "evm-htlc", caip2: this.evmConfig.pin.caip2, address: evmAddress });
    return this.venue.post(dealRoom(acceptA.contract), line, this.identity);
  }

  /**
   * Lock leg A on `evm-htlc` — refused until leg B has verified (`verifyLegBLocked`) and the
   * Seller's own account line resolves in leg A's deal room (D-08: only the payee's line is
   * required). The write path's `AddressBook` is built here, from the resolved payee, right
   * before the one call (`EvmHashRail.lock`) that ever needs to resolve a counterparty address.
   */
  async lockLegA(): Promise<{ hashLock: Hex; writeEvidence: WriteEvidence }> {
    if (!this.legBVerified) {
      throw new Error("buyer: refusing to lock leg A before leg B verifies");
    }
    const { offerA, acceptA } = this.requirePaired();
    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    const accounts = resolveAccounts(dealRoomARecords, {
      contract: acceptA.contract,
      payerDid: termsA.payer,
      payeeDid: termsA.payee,
      rail: "evm-htlc",
      caip2: this.evmConfig.pin.caip2,
    });
    const payee = accounts.payee;
    if (payee === undefined) {
      throw new Error("buyer: refusing to lock leg A — the Seller's account line has not resolved (D-08)");
    }

    const addressBook: AddressBook = {
      resolve: (did: string): Address => {
        if (did === termsA.payee) return payee;
        if (did === termsA.payer) return this.account;
        throw new Error(`buyer: no resolved address for ${did}`);
      },
    };
    const rail = await EvmHtlcRail.connect({ config: this.evmConfig, rpc: this.rpc, account: this.account, addressBook, clock: this.clock });

    const fromBlock = await this.rpc
      .request({ method: "eth_blockNumber", params: [] })
      .then((hex) => BigInt(hex as string));
    await rail.approve(termsA.asset, termsA.amount);
    const writeEvidence = await rail.lock(termsA, 0);
    const hashLock = writeEvidence.ref;

    await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "lock", from: this.identity.did, contract: acceptA.contract, rail: "evm-htlc", ref: hashLock }),
      this.identity,
    );

    this.lockedHashLock = hashLock;
    this.lockedFromBlock = fromBlock;
    return { hashLock, writeEvidence };
  }

  /** Learn the secret from the Seller's signed `reveal` frame when it posted one, or (SPEC
   *  §6 scenario 5) from the on-chain `Claimed` log when the Seller claimed without posting
   *  it — never guesses: a candidate preimage is only accepted once it actually opens the
   *  statement (`findClaimedPreimage` already re-checks this; `parseSwapContext`-level frame
   *  authentication covers the reveal-frame path here). */
  async learnSecret(): Promise<Hex> {
    const { acceptA } = this.requirePaired();
    if (this.lockedHashLock === undefined) throw new Error("buyer: leg A has not been locked yet");
    const hashLock = this.lockedHashLock;

    const dealRoomARecords = await this.venue.read(dealRoom(acceptA.contract));
    for (const record of dealRoomARecords) {
      if (!verifyTranscriptRecord(record).ok) continue;
      const frame = tryDecodeFrame(record.line);
      if (frame === null || frame.type !== "reveal" || frame.from !== record.sender) continue;
      if (frame.contract !== acceptA.contract) continue;
      if (frame.ref !== undefined && frame.ref !== hashLock) continue;
      if (verifySecret("hash", hashLock, frame.secret)) return frame.secret as Hex;
    }

    const rail = await EvmHtlcRail.connect({
      config: this.evmConfig,
      rpc: this.rpc,
      account: this.account,
      addressBook: inertAddressBook(),
      clock: this.clock,
    });
    const fromBlock = this.lockedFromBlock ?? 0n;
    const preimage = await rail.findClaimedPreimage(hashLock, fromBlock);
    if (preimage === null) {
      throw new Error("buyer: refusing to guess the secret — no reveal frame and no Claimed log yet");
    }
    return preimage;
  }

  /** Claim leg B on the paper rail with the learned secret, then reveal it there too (SPEC:
   *  the Buyer's own reveal on leg B, distinct from the Seller's reveal on leg A). */
  async claimLegB(secret: Hex): Promise<{ reveal: TranscriptRecord; receipt: TranscriptRecord }> {
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

  /** Refund leg A only at/after `A.refundAfterMs` — the vendored rail's own `refund` also
   *  enforces this on-chain; this check exists so a caller sees this class's own reason. */
  async refundLegA(): Promise<WriteEvidence> {
    const { offerA, acceptA } = this.requirePaired();
    if (this.lockedHashLock === undefined) throw new Error("buyer: leg A was never locked, nothing to refund");
    if (this.clock() < offerA.refundAfterMs) {
      throw new Error("buyer: refusing to refund leg A before its refundAfterMs");
    }
    const hashLock = this.lockedHashLock;
    const rail = await EvmHtlcRail.connect({
      config: this.evmConfig,
      rpc: this.rpc,
      account: this.account,
      addressBook: inertAddressBook(),
      clock: this.clock,
    });
    const writeEvidence = await rail.refund(hashLock);
    await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "refund", from: this.identity.did, contract: acceptA.contract, ref: hashLock }),
      this.identity,
    );
    await this.venue.post(
      dealRoom(acceptA.contract),
      encodeFrame({ type: "receipt", from: this.identity.did, contract: acceptA.contract, outcome: "refunded", rail: "evm-htlc", ref: hashLock }),
      this.identity,
    );
    return writeEvidence;
  }
}
