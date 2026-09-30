// SPDX-License-Identifier: MIT
//
// Shared harness for the Solana client-flow tests (tests/client-flows-sol.test.ts, tests/audit-export-sol.test.ts):
// the REAL `BuyerFlow` / `SellerFlow` over the REAL Solana counter rail (`createSolCounterRail`) over the REAL
// adapter and evidence reader, with only the wire faked by the stateful node (tests/helpers/sol-stateful-chain.ts).
// Two real in-memory wallets (throwaway seeds, never a real key), both parties' token accounts funded on the
// fake node, one shared in-memory venue and one shared paper-rail note store (leg B).

import { dealRoom, MemoryNoteStore, PaperRail, tryDecodeFrame, type TranscriptRecord } from "@flop-labs/tclk";

import { BuyerFlow } from "../../src/client/buyer.js";
import { createSolCounterRail } from "../../src/client/sol-rail.js";
import { SellerFlow } from "../../src/client/seller.js";
import { MemoryVenue } from "../../src/client/venue.js";
import { swapId as computeSwapId } from "../../src/profile.js";
import { InMemorySolSigner } from "../../src/rails/sol-signer-memory.js";
import { identity, type Identity } from "./identity.js";
import { StatefulSolNode } from "./sol-stateful-chain.js";

export const T0 = 1_700_000_000_000;

export function ident(tag: number): Identity {
  return identity(tag.toString(16).padStart(2, "0").repeat(32));
}

/** Leg A sized so its window (`refundAfterMs - a fixed 30-min lockTimeMs`) is exactly `windowMs`. */
export function legADeadlines(windowMs: number) {
  const lockTimeMs = T0 + 30 * 60_000;
  return { claimByMs: lockTimeMs + 5 * 60_000, refundAfterMs: lockTimeMs + windowMs, expiresMs: T0 + 10 * 60_000, lockTimeMs };
}
export function legBDeadlines() {
  return { claimByMs: T0 + 12 * 60 * 60_000, refundAfterMs: T0 + 24 * 60 * 60_000, expiresMs: T0 + 60 * 60_000 };
}

export interface SolHarnessOptions {
  /** Seeds for the two wallets (default 11 and 12), so two harnesses in one test get distinct wallets. */
  buyerSeed?: number;
  sellerSeed?: number;
  /** Fund the Buyer's and Seller's token accounts (default: Buyer 5 USDC, Seller an empty account). */
  buyerBalance?: bigint | null;
  sellerAccount?: boolean;
}

export function solHarness(options: SolHarnessOptions = {}) {
  const node = new StatefulSolNode();
  node.nowMs = T0;
  const buyer = ident(1);
  const seller = ident(2);
  // The flows' wall clock (`clockRef`) and the node's chain time (`node.nowMs`, also what the rails' injected
  // clock reads) are separate on purpose: a test can make either one the unsafe reading. `setTime` moves both.
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const setTime = (ms: number): void => {
    clockRef.ms = ms;
    node.nowMs = ms;
  };
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();

  const buyerWallet = InMemorySolSigner.generate(new Uint8Array(32).fill(options.buyerSeed ?? 11));
  const sellerWallet = InMemorySolSigner.generate(new Uint8Array(32).fill(options.sellerSeed ?? 12));
  if (options.buyerBalance !== null) node.fundToken(buyerWallet.publicKeyBytes, options.buyerBalance ?? 5_000_000n);
  if (options.sellerAccount !== false) node.fundToken(sellerWallet.publicKeyBytes, 0n);

  const railOptions = { config: node.config, clock: node.clock, sleep: node.sleep, pollIntervalMs: 10, finalityTimeoutMs: 100 };
  const buyerRail = createSolCounterRail({ ...railOptions, rpc: node.rpc(), signer: buyerWallet });
  const sellerRail = createSolCounterRail({ ...railOptions, rpc: node.rpc(), signer: sellerWallet });

  const buyerFlow = new BuyerFlow({ identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail, clock });
  const sellerFlow = new SellerFlow({ identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock });
  return { node, buyer, seller, buyerWallet, sellerWallet, buyerRail, sellerRail, venue, noteStore, clockRef, clock, setTime, buyerFlow, sellerFlow };
}

export type SolHarness = ReturnType<typeof solHarness>;

export const BID = {
  wantAsset: "FLOP",
  wantAmount: "52070000",
  wantRail: "flop-htlc",
  amount: "1000000",
  asset: "USDC",
};

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked: the pairing prefix (no account lines, no
 *  leg A lock). */
export async function pair(h: SolHarness, windowMs = 6 * 60 * 60_000, nonce = "00000001", claimByMs?: number) {
  const legA = legADeadlines(windowMs);
  if (claimByMs !== undefined) legA.claimByMs = claimByMs;
  const swapId = computeSwapId(h.buyer.did, nonce);
  const offerA = await h.buyerFlow.bid({
    swapId,
    ...BID,
    claimByMs: legA.claimByMs,
    refundAfterMs: legA.refundAfterMs,
    expiresMs: T0 + 10 * 60_000,
  });
  const { acceptA, acceptARecord, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
  const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  const statement = h.sellerFlow.statement;
  if (statement === undefined) throw new Error("test setup: the Seller's statement was never minted");
  return { swapId, offerA, acceptA, acceptARecord, offerBRecord, acceptBRecord, legA, statement };
}

/** The pairing prefix plus both PROVEN account lines. */
export async function pairWithLines(h: SolHarness, windowMs = 6 * 60 * 60_000, nonce = "00000001", claimByMs?: number) {
  const p = await pair(h, windowMs, nonce, claimByMs);
  await h.sellerFlow.postAccountLineA(h.sellerWallet.publicKey);
  await h.buyerFlow.postAccountLineA(h.buyerWallet.publicKey);
  return p;
}

/** The whole happy prefix up to (not including) a claim or refund: paired, lines posted, leg A locked. */
export async function lockedFlow(h: SolHarness, windowMs = 6 * 60 * 60_000, nonce = "00000001", claimByMs?: number) {
  const p = await pairWithLines(h, windowMs, nonce, claimByMs);
  await h.buyerFlow.lockLegA();
  return { ...p, ref: `${p.statement}:${h.buyerWallet.publicKey}` };
}

export function dealRoomOf(acceptA: { contract: string }): string {
  return dealRoom(acceptA.contract);
}

export function framesIn(records: readonly TranscriptRecord[], type: string): TranscriptRecord[] {
  return records.filter((r) => tryDecodeFrame(r.line)?.type === type);
}

/** Make `venue.post` throw for the next `count` frames of `type` (everything else passes through). Returns how
 *  many failed. */
export function failPosts(h: { venue: MemoryVenue }, type: string, count: number): { failed: () => number } {
  const venue = h.venue as unknown as { post: (room: string, line: string, id: unknown) => Promise<unknown> };
  const original = venue.post.bind(venue);
  let failed = 0;
  venue.post = async (room, line, id) => {
    const frame = tryDecodeFrame(line) as { type?: string } | null;
    if (frame?.type === type && failed < count) {
      failed += 1;
      throw new Error("venue unreachable (test)");
    }
    return original(room, line, id);
  };
  return { failed: () => failed };
}
