// SPDX-License-Identifier: MIT
//
// A NEAR swap for the flow-level resume tests of review round 2: the REAL NEAR rail (src/client/near-rail.ts) over the RPC-level simulator
// (tests/helpers/near-stateful-rpc.ts), one MemoryFlowStore per role, and the swap taken up to the Buyer's lock of leg A. The test then
// drives the Seller from there (a payout that fails, a restart, the Buyer's claim of leg B).

import { MemoryNoteStore, PaperRail, generateHashLock } from "@flop-labs/tclk";

import { BuyerFlow, type BuyerFlowOptions } from "../../src/client/buyer.js";
import { MemoryFlowStore } from "../../src/client/flow-store.js";
import { createNearCounterRail } from "../../src/client/near-rail.js";
import { SellerFlow, type SellerFlowOptions } from "../../src/client/seller.js";
import { MemoryVenue } from "../../src/client/venue.js";
import { swapId as computeSwapId } from "../../src/profile.js";
import { InMemoryNearSigner } from "../../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../../src/rails/rpc-capture.js";
import { identity, type Identity } from "./identity.js";
import { BUYER_ACCOUNT, CONTRACT, HTLC_CODE_HASH, SELLER_ACCOUNT, StatefulNearRpc, USDC, fetchFor, nearConfig } from "./near-stateful-rpc.js";

export const T0 = 1_700_000_000_000;
const ident = (tag: number): Identity => identity(tag.toString(16).padStart(2, "0").repeat(32));
export const lockTimeMs = T0 + 30 * 60_000;
export const legA = { claimByMs: lockTimeMs + 5 * 60_000, refundAfterMs: lockTimeMs + 6 * 60 * 60_000, expiresMs: T0 + 10 * 60_000 };
export const legB = { claimByMs: T0 + 12 * 60 * 60_000, refundAfterMs: T0 + 24 * 60 * 60_000, expiresMs: T0 + 60 * 60_000 };

/** The real NEAR rail over the RPC simulator, a flow store per role, and the swap taken up to the Buyer's lock of leg A. */
export async function nearSwap() {
  const node = new StatefulNearRpc(CONTRACT, USDC, HTLC_CODE_HASH, T0);
  const config = nearConfig();
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const fetchImpl = fetchFor(node);
  const sleep = async (): Promise<void> => node.advanceBlocks(1);
  const buyerSigner = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(11));
  const sellerSigner = InMemoryNearSigner.generate(SELLER_ACCOUNT, new Uint8Array(32).fill(22));
  const railFor = (signer: InMemoryNearSigner) => createNearCounterRail({ config, rpc: new CapturingRpc({ endpoint: config.endpoint, fetch: fetchImpl, clock }), signer, clock: () => node.nowMs, sleep });
  const buyerStore = new MemoryFlowStore();
  const sellerStore = new MemoryFlowStore();
  const sellerLock = generateHashLock();
  const buyerOptions: BuyerFlowOptions = { identity: ident(1), venue, paperRail: new PaperRail(noteStore, clock), rail: railFor(buyerSigner), clock, store: buyerStore };
  const sellerOptions: SellerFlowOptions = { identity: ident(2), venue, paperRail: new PaperRail(noteStore, clock), rail: railFor(sellerSigner), clock, store: sellerStore, mintHashLock: () => sellerLock };
  const setTime = (ms: number): void => {
    clockRef.ms = ms;
    node.nowMs = ms;
  };
  const swapId = computeSwapId(ident(1).did, "00000001");
  const buyer = new BuyerFlow(buyerOptions);
  const seller = new SellerFlow(sellerOptions);
  node.registerStorage(BUYER_ACCOUNT);
  node.registerStorage(SELLER_ACCOUNT);
  const offerA = await buyer.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legA });
  const accepted = await seller.acceptLegA(offerA, legB, lockTimeMs);
  const { acceptBRecord } = await buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, lockTimeMs);
  await seller.lockLegB(acceptBRecord);
  await buyer.verifyLegBLocked();
  await seller.postAccountLineA(SELLER_ACCOUNT);
  await buyer.postAccountLineA(BUYER_ACCOUNT);
  setTime(lockTimeMs);
  await buyer.lockLegA();
  return { node, noteStore, buyer, seller, buyerOptions, sellerOptions, sellerStore, swapId, setTime, statement: accepted.acceptA.statement };
}

