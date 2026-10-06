// SPDX-License-Identifier: MIT
//
// Shared setup for the review-round-1 flow tests that run the REAL flows over one of the crash-matrix worlds
// (tests/helpers/matrix-worlds.ts): start a world with some steps done, restart a role (a new epoch, a fresh flow resumed from its store)
// and read a role's stored record. The matrix worlds wrap every outward channel so a test can count what reached the chain and the venue.

import { PaperRail, dealRoom, encodeFrame, type TranscriptRecord } from "@flop-labs/tclk";

import { BuyerFlow } from "../../src/client/buyer.js";
import { decodeFlowRecord, type BuyerFlowRecord, type SellerFlowRecord } from "../../src/client/flow-record.js";
import { flowKey } from "../../src/client/flow-store.js";
import { SellerFlow } from "../../src/client/seller.js";
import { Controller, PREFIX, STEPS, readSwap, type Ctx, type Step, type World, type WorldFactory } from "./crash-matrix.js";
import { sellerKeyOf } from "./seller-key.js";

export interface Started {
  ctl: Controller;
  w: World;
  c: Ctx;
}

/** A world with both flows built and `steps` done (default: everything up to and including the Buyer's lock of leg A). */
export async function started(factory: WorldFactory, steps: readonly Step[] = [...PREFIX, STEPS.lockLegA]): Promise<Started> {
  const ctl = new Controller();
  const w = factory(ctl);
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of steps) await step.run(c);
  return { ctl, w, c };
}

type BuyerOptions = ReturnType<World["buyerOptions"]>;
type SellerOptions = ReturnType<World["sellerOptions"]>;

/** Restarts the Buyer (a new epoch) and resumes a fresh flow from the store. `tweak` receives the new epoch's options and may swap
 *  parts of them (a paper rail or a counter rail that fails). */
export async function resumedBuyer(s: Started, tweak: (options: BuyerOptions) => Partial<BuyerOptions> = () => ({})): Promise<{ flow: BuyerFlow; next: string }> {
  s.ctl.restart("buyer");
  const options = s.w.buyerOptions();
  const result = await BuyerFlow.resume({ ...options, ...tweak(options), store: s.w.stores.buyer, swapId: s.w.swapId });
  s.c.buyer = result.flow;
  s.c.history.push(result.flow);
  return result;
}

/** The same for the Seller, which is resumed by leg A's contract id (R1-14). */
export async function resumedSeller(s: Started, tweak: (options: SellerOptions) => Partial<SellerOptions> = () => ({})): Promise<{ flow: SellerFlow; next: string }> {
  s.ctl.restart("seller");
  const options = s.w.sellerOptions();
  const key = await sellerKeyOf(s.w.stores.seller);
  const result = await SellerFlow.resume({ ...options, ...tweak(options), store: s.w.stores.seller, swapId: s.w.swapId, contractA: key.slice("seller:".length) });
  s.c.seller = result.flow;
  s.c.history.push(result.flow);
  return result;
}

export async function buyerRecordOf(w: World): Promise<BuyerFlowRecord> {
  const key = flowKey("buyer", w.swapId);
  return decodeFlowRecord((await w.stores.buyer.load(key))!, key) as BuyerFlowRecord;
}

export async function sellerRecordOf(w: World): Promise<SellerFlowRecord> {
  const key = await sellerKeyOf(w.stores.seller);
  return decodeFlowRecord((await w.stores.seller.load(key))!, key) as SellerFlowRecord;
}

/** A paper rail on the world's note store that is not instrumented: what the Seller, or anyone who holds the secret, writes leg B's
 *  note with outside any flow. */
export function strangerPaper(w: World): PaperRail {
  return new PaperRail(w.noteStore, () => w.clockRef.ms);
}

/** The Seller (who always holds the secret) posts a reveal frame for leg A, outside its flow, without claiming leg A on chain. `ref`
 *  is leg A's rail ref (the recorded one: the hash lock on EVM, the outpoint on Bitcoin). */
export async function postRevealFrame(w: World, ref: string): Promise<TranscriptRecord> {
  const view = await readSwap(w);
  const contract = view.acceptA!.contract;
  return w.venue.post(dealRoom(contract), encodeFrame({ type: "reveal", from: w.dids.seller, contract, ref, secret: w.hashLock.preimage }), w.sellerOptions().identity);
}

/** The contract ids of the two legs, as the venue shows them. */
export async function contractsOf(w: World): Promise<{ contractA: string; contractB: string }> {
  const view = await readSwap(w);
  return { contractA: view.acceptA!.contract, contractB: view.acceptB!.contract };
}
