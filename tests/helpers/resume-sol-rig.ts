// SPDX-License-Identifier: MIT
//
// The Solana rig for the P8 crash-resume tests: a stateful harness whose two flows have stores, the steps that drive a swap to a
// given point, "restart" (drop the flow, resume a fresh one from its store) and the decoded records. Shared by
// tests/flow-resume-sol.test.ts and tests/flow-resume-validate.test.ts.

import { tryDecodeFrame, type OfferFrame, type TranscriptRecord } from "@flop-labs/tclk";

import type { BuyerFlow } from "../../src/client/buyer.js";
import { decodeFlowRecord, type BuyerFlowRecord, type SellerFlowRecord } from "../../src/client/flow-record.js";
import { MemoryFlowStore, flowKey } from "../../src/client/flow-store.js";
import type { SellerFlow } from "../../src/client/seller.js";
import { swapId as computeSwapId } from "../../src/profile.js";
import { resumeBuyer, resumeSeller } from "./resume-flows.js";
import { BID, T0, framesIn, legADeadlines, legBDeadlines, solHarness, type SolHarness } from "./sol-flow-harness.js";

export const NONCE = "00000001";
export const WINDOW_MS = 6 * 60 * 60_000;
export const legA = legADeadlines(WINDOW_MS);

export interface Rig {
  h: SolHarness;
  buyerStore: MemoryFlowStore;
  sellerStore: MemoryFlowStore;
  swapId: string;
  buyer: BuyerFlow;
  seller: SellerFlow;
}

export function rig(): Rig {
  const buyerStore = new MemoryFlowStore();
  const sellerStore = new MemoryFlowStore();
  const h = solHarness({ buyerStore, sellerStore });
  return { h, buyerStore, sellerStore, swapId: computeSwapId(h.buyer.did, NONCE), buyer: h.buyerFlow, seller: h.sellerFlow };
}

export const bidParams = (r: Rig) => ({ swapId: r.swapId, ...BID, claimByMs: legA.claimByMs, refundAfterMs: legA.refundAfterMs, expiresMs: T0 + 10 * 60_000 });
export const bid = (r: Rig): Promise<OfferFrame> => r.buyer.bid(bidParams(r));

/** Drops the current Buyer and builds a fresh one from the store; returns the next step it names. */
export async function restartBuyer(r: Rig, extra = {}) {
  const resumed = await resumeBuyer(r.h.buyerOptions, r.buyerStore, r.swapId, extra);
  r.buyer = resumed.flow;
  return resumed.next;
}
export async function restartSeller(r: Rig, extra = {}) {
  const resumed = await resumeSeller(r.h.sellerOptions, r.sellerStore, r.swapId, extra);
  r.seller = resumed.flow;
  return resumed.next;
}

export async function buyerRecord(r: Rig): Promise<BuyerFlowRecord> {
  const key = flowKey("buyer", r.swapId);
  return decodeFlowRecord((await r.buyerStore.load(key))!, key) as BuyerFlowRecord;
}
export async function sellerRecord(r: Rig): Promise<SellerFlowRecord> {
  const key = flowKey("seller", r.swapId);
  return decodeFlowRecord((await r.sellerStore.load(key))!, key) as SellerFlowRecord;
}

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked, all through the rig's current flows. */
export async function toPaired(r: Rig) {
  const offerA = await bid(r);
  const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
  const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
  await r.seller.lockLegB(acceptBRecord);
  await r.buyer.verifyLegBLocked();
  return { offerA, accepted, acceptB, acceptBRecord, contractA: accepted.acceptA.contract, contractB: acceptB.contract };
}
export async function toLines(r: Rig) {
  const p = await toPaired(r);
  await r.seller.postAccountLineA(r.h.sellerWallet.publicKey);
  await r.buyer.postAccountLineA(r.h.buyerWallet.publicKey);
  return p;
}
export async function toLocked(r: Rig) {
  const p = await toLines(r);
  await r.buyer.lockLegA();
  return p;
}


export const framesOf = async (r: Rig, room: string, type: string): Promise<TranscriptRecord[]> => framesIn(await r.h.venue.read(room), type);
export const isFrame = (line: string, type: string): boolean => tryDecodeFrame(line)?.type === type;
export const isLine = (line: string): boolean => tryDecodeFrame(line) === null; // an account line is not a tclk frame
