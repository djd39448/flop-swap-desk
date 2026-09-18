// SPDX-License-Identifier: MIT
//
// Builds a complete, correctly-signed two-leg swap transcript (SPEC §3.4) for a given
// Buyer/Seller pair, so tests can compose whatever prefix or alternate ending they need:
// `[offerA]` is a `bid`, `[..., acceptA, offerB, acceptB]` is `paired`, swapping the tail
// for `refundA`/`refundB`/`cancelA` reaches the abort paths, and so on. Deadlines follow
// SPEC §3.5's worked example (leg A: claimBy t0+45m, refundAfter t0+60m; leg B: claimBy
// t0+70m, refundAfter t0+180m).

import {
  dealRoom,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  OFFER_ROOM,
  type AcceptFrame,
  type CancelFrame,
  type HashLock,
  type LockFrame,
  type OfferFrame,
  type RefundFrame,
  type RevealFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { legAContext, legBContext, swapId as computeSwapId } from "../../src/profile.js";
import { type Identity, record } from "./identity.js";

const MINUTE_MS = 60_000;

export interface ScenarioOptions {
  buyer: Identity;
  seller: Identity;
  t0: number;
  swapNonce?: string;
  offerANonce?: string;
  acceptANonce?: string;
  offerBNonce?: string;
  acceptBNonce?: string;
  buyerPayAmount?: string;
  wantAmount?: string;
}

export interface ScenarioFrames {
  offerA: OfferFrame;
  acceptA: AcceptFrame;
  offerB: OfferFrame;
  acceptB: AcceptFrame;
  lockA: LockFrame;
  lockB: LockFrame;
  revealA: RevealFrame;
  revealB: RevealFrame;
  refundA: RefundFrame;
  refundB: RefundFrame;
  cancelA: CancelFrame;
}

export interface ScenarioRecords {
  offerA: TranscriptRecord;
  acceptA: TranscriptRecord;
  offerB: TranscriptRecord;
  acceptB: TranscriptRecord;
  lockB: TranscriptRecord;
  lockA: TranscriptRecord;
  revealA: TranscriptRecord;
  revealB: TranscriptRecord;
  refundA: TranscriptRecord;
  refundB: TranscriptRecord;
  cancelA: TranscriptRecord;
}

export interface Scenario {
  swapId: string;
  lock: HashLock;
  dealRoomA: string;
  dealRoomB: string;
  frames: ScenarioFrames;
  records: ScenarioRecords;
  /** The mainline happy path, in venue order: bid → accepted → paired → b-locked →
   *  a-locked → revealed → settled. Slice it for any earlier state. */
  mainline: TranscriptRecord[];
}

export function scenario(options: ScenarioOptions): Scenario {
  const { buyer, seller, t0 } = options;
  const swapNonce = options.swapNonce ?? "0123456789abcdef";
  const swap = computeSwapId(buyer.did, swapNonce);
  const lock = generateHashLock();

  const legAClaimByMs = t0 + 45 * MINUTE_MS;
  const legARefundAfterMs = t0 + 60 * MINUTE_MS;
  const legAExpiresMs = t0 + 30 * MINUTE_MS;
  const legBClaimByMs = t0 + 70 * MINUTE_MS;
  const legBRefundAfterMs = t0 + 180 * MINUTE_MS;
  const legBExpiresMs = t0 + 40 * MINUTE_MS;

  const offerA = makeOffer({
    from: buyer.did,
    role: "payer",
    amount: options.buyerPayAmount ?? "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["evm-htlc"],
    claimByMs: legAClaimByMs,
    refundAfterMs: legARefundAfterMs,
    expiresMs: legAExpiresMs,
    job: {
      proto: "swap",
      id: swap,
      context: legAContext({
        wantAsset: "FLOP",
        wantAmount: options.wantAmount ?? "52070000",
        wantRail: "flop-htlc",
      }),
    },
    nonce: options.offerANonce ?? "a001a001a001a001",
  });

  const acceptA = makeAccept(offerA, {
    from: seller.did,
    statement: lock.hash,
    nonce: options.acceptANonce ?? "a002a002a002a002",
  });

  const offerB = makeOffer({
    from: seller.did,
    role: "payer",
    amount: options.wantAmount ?? "52070000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: legBClaimByMs,
    refundAfterMs: legBRefundAfterMs,
    expiresMs: legBExpiresMs,
    job: { proto: "swap", id: swap, context: legBContext(offerA.id) },
    nonce: options.offerBNonce ?? "b001b001b001b001",
  });

  const acceptB = makeAccept(offerB, {
    from: buyer.did,
    statement: lock.hash,
    nonce: options.acceptBNonce ?? "b002b002b002b002",
  });

  const dealRoomA = dealRoom(acceptA.contract);
  const dealRoomB = dealRoom(acceptB.contract);

  const lockB: LockFrame = {
    type: "lock",
    from: seller.did,
    contract: acceptB.contract,
    rail: "flop-htlc",
    ref: "flop-escrow-1",
  };
  const lockA: LockFrame = {
    type: "lock",
    from: buyer.did,
    contract: acceptA.contract,
    rail: "evm-htlc",
    ref: "evm-escrow-1",
  };
  const revealA: RevealFrame = {
    type: "reveal",
    from: seller.did,
    contract: acceptA.contract,
    ref: "evm-escrow-1",
    secret: lock.preimage,
  };
  const revealB: RevealFrame = {
    type: "reveal",
    from: buyer.did,
    contract: acceptB.contract,
    ref: "flop-escrow-1",
    secret: lock.preimage,
  };
  const refundA: RefundFrame = {
    type: "refund",
    from: buyer.did,
    contract: acceptA.contract,
    ref: "evm-escrow-1",
  };
  const refundB: RefundFrame = {
    type: "refund",
    from: seller.did,
    contract: acceptB.contract,
    ref: "flop-escrow-1",
  };
  const cancelA: CancelFrame = {
    type: "cancel",
    from: seller.did,
    contract: acceptA.contract,
    reason: "rehearsal abort",
  };

  const records: ScenarioRecords = {
    offerA: record(OFFER_ROOM, 1, t0, buyer, encodeFrame(offerA)),
    acceptA: record(OFFER_ROOM, 2, t0 + 1 * MINUTE_MS, seller, encodeFrame(acceptA)),
    offerB: record(OFFER_ROOM, 3, t0 + 2 * MINUTE_MS, seller, encodeFrame(offerB)),
    acceptB: record(OFFER_ROOM, 4, t0 + 3 * MINUTE_MS, buyer, encodeFrame(acceptB)),
    lockB: record(dealRoomB, 1, t0 + 4 * MINUTE_MS, seller, encodeFrame(lockB)),
    lockA: record(dealRoomA, 1, t0 + 5 * MINUTE_MS, buyer, encodeFrame(lockA)),
    revealA: record(dealRoomA, 2, t0 + 6 * MINUTE_MS, seller, encodeFrame(revealA)),
    revealB: record(dealRoomB, 2, t0 + 7 * MINUTE_MS, buyer, encodeFrame(revealB)),
    refundA: record(dealRoomA, 2, legARefundAfterMs + 1 * MINUTE_MS, buyer, encodeFrame(refundA)),
    refundB: record(dealRoomB, 2, legBRefundAfterMs + 1 * MINUTE_MS, seller, encodeFrame(refundB)),
    cancelA: record(dealRoomA, 1, t0 + 3.5 * MINUTE_MS, seller, encodeFrame(cancelA)),
  };

  const mainline = [
    records.offerA,
    records.acceptA,
    records.offerB,
    records.acceptB,
    records.lockB,
    records.lockA,
    records.revealA,
    records.revealB,
  ];

  return {
    swapId: swap,
    lock,
    dealRoomA,
    dealRoomB,
    frames: {
      offerA,
      acceptA,
      offerB,
      acceptB,
      lockA,
      lockB,
      revealA,
      revealB,
      refundA,
      refundB,
      cancelA,
    },
    records,
    mainline,
  };
}
