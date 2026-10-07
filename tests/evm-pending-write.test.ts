// SPDX-License-Identifier: MIT
//
// tests/evm-pending-write.test.ts - P9-4 decision 7 (R1-FUND-04; P9-4-DECISIONS-2026-10-07.md): a write whose receipt wait timed out is not sent again while the
// node still holds it.
//
// With a local account every write is `eth_sendRawTransaction`; on a slow public chain the receipt wait can time out (`EvmReceiptTimeoutError`) while the node
// still holds the transaction in its pool. Before this decision a resumed Buyer read "no lock row" as `never-landed` and sent an approve and a lock AGAIN, and a
// resumed Seller whose claim was not on chain yet signed a second claim (the contract refuses the duplicate, so only gas was lost, but the pool filled with
// transactions that could not both succeed). Now the flow saves the hash of a LOCK write or a CLAIM write that timed out in the P8 record (a new strictly decoded
// optional field: `lock.prepared.recovery = { chain: "evm", txHash }` for the Buyer, `claimTxHash` for the Seller, extended in place, record version unchanged),
// and `recoverLock` / the resumed `claimLegA` ask the node about that hash (`eth_getTransactionByHash`, then the receipt of a mined one):
//   pending   (the node holds it)              -> the flow's pending path (`LockPendingError`, `ClaimPendingError`): nothing is sent;
//   success   (mined; the lock row / claim log of the same read do not show it yet) -> pending as well (the endpoint's answers disagree; ask again);
//   reverted  (mined and reverted: it did nothing) -> proceeds as today: a fresh, fully guarded attempt;
//   unknown   (the node does not know the hash)    -> proceeds as today.
// The pool is the mock node's `holdNextSend`: the raw transaction is accepted and its hash answered, nothing is mined; `releaseHeld()` mines it later.
// Keys are generated at test time; none is printed.

import { MemoryNoteStore, PaperRail, generateHashLock, verifyHashPreimage, type HashLock } from "@flop-labs/tclk";
import { encodeFunctionResult, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { BuyerFlow, LockPendingError, type BidParams } from "../src/client/buyer.js";
import type { CounterAssetRail, RailWriteBroadcast } from "../src/client/counter-rail.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { decodeFlowRecord, type BuyerFlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import { MemoryFlowStore, flowKey } from "../src/client/flow-store.js";
import { knownGoodDeadlinesFor } from "../src/client/policy.js";
import { ClaimPendingError, SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { EVM_CLAIM_RECEIPT_WAIT_MS_BASE_SEPOLIA, EvmHtlcRail, EvmReceiptTimeoutError } from "../src/rails/evm-htlc.js";
import { EVM_HASH_RAIL_ABI, type AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { makeLocalAccount, localSigningRpc, type LocalSigningRpc } from "./helpers/evm-local.js";
import { identity } from "./helpers/identity.js";
import { scriptedRpc } from "./helpers/scripted-rpc.js";

const T0 = 1_700_000_000_000;
const RAIL = getAddress(`0x${Buffer.from("p94-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("p94-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const HASH = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const MIN = 60_000;

/** The known-good deadline set of the chain (anvil: leg A +60/+90, leg B +120/+180; Base Sepolia: +115/+135 and +225/+285), as ms from `T0`. */
function deadlinesOf(chainId: 31337 | 84532) {
  const set = knownGoodDeadlinesFor(chainId);
  const at = (minutes: number): number => T0 + minutes * MIN;
  return {
    legA: { claimByMs: at(set.legA.claimByMin), refundAfterMs: at(set.legA.refundAfterMin), expiresMs: at(set.legA.expiresMin) },
    legB: { claimByMs: at(set.legB.claimByMin), refundAfterMs: at(set.legB.refundAfterMin), expiresMs: at(set.legB.expiresMin) },
  };
}

const BID = (swapId: string, legA: { claimByMs: number; refundAfterMs: number; expiresMs: number }): BidParams => ({
  swapId,
  wantAsset: "FLOP",
  wantAmount: "52070000",
  wantRail: "flop-htlc",
  amount: "1000000",
  asset: "USDC",
  ...legA,
});

/** Both parties with local accounts and a store each, over one mock node, through the pairing, leg B's paper lock and both account lines; `receiptTimeoutMs` 150
 *  (or `options.receiptTimeoutMs`). `options.upperCaseHashes` makes both wires answer every send's hash in upper case (P94-PIN-01). `options.chainId` 84532 pins the node
 *  and the rails to Base Sepolia (its deadline set, its policy, a `receiptTimeoutMs` of 10 s to 1 h); `options.onClaimSent` and `options.mintHashLock` go to the Seller
 *  (P94-FUND-01); `options.wrapRail` wraps both parties' rail objects (a test that watches the connected handles). */
async function pairedSwap(
  options: {
    receiptTimeoutMs?: number;
    upperCaseHashes?: boolean;
    chainId?: 31337 | 84532;
    onClaimSent?: (txHash: string) => void;
    mintHashLock?: () => HashLock;
    wrapRail?: (rail: CounterAssetRail) => CounterAssetRail;
  } = {},
) {
  const chainId = options.chainId ?? 31337;
  const dead = deadlinesOf(chainId);
  const wrapRail = options.wrapRail ?? ((rail: CounterAssetRail) => rail);
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const node = new EvmMockNode(clock, RAIL, TOKEN, []);
  node.chainId = chainId;
  node.configExtras = { receiptTimeoutMs: options.receiptTimeoutMs ?? 150 };
  const buyerAccount = await makeLocalAccount();
  const sellerAccount = await makeLocalAccount();
  const buyerWire = localSigningRpc(node, chainId);
  const sellerWire = localSigningRpc(node, chainId);
  buyerWire.upperCaseHashes = options.upperCaseHashes ?? false;
  sellerWire.upperCaseHashes = options.upperCaseHashes ?? false;
  const buyerId = identity("61".repeat(32));
  const sellerId = identity("62".repeat(32));
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const stores = { buyer: new MemoryFlowStore(), seller: new MemoryFlowStore() };
  const buyerOptions = () => ({
    identity: buyerId,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: wrapRail(createEvmCounterRail({ config: node.config(), rpc: buyerWire.rpc, account: buyerAccount, clock })),
    clock,
    store: stores.buyer,
  });
  const sellerOptions = () => ({
    identity: sellerId,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: wrapRail(createEvmCounterRail({ config: node.config(), rpc: sellerWire.rpc, account: sellerAccount, clock })),
    clock,
    store: stores.seller,
    ...(options.onClaimSent === undefined ? {} : { onClaimSent: options.onClaimSent }),
    ...(options.mintHashLock === undefined ? {} : { mintHashLock: options.mintHashLock }),
  });
  const buyer = new BuyerFlow(buyerOptions());
  const seller = new SellerFlow(sellerOptions());
  const swapId = computeSwapId(buyerId.did, "000000b4");
  const offerA = await buyer.bid(BID(swapId, dead.legA));
  const { acceptA, acceptARecord, offerBRecord } = await seller.acceptLegA(offerA, dead.legB, T0);
  const { acceptBRecord } = await buyer.acceptLegB(offerBRecord, acceptARecord, T0);
  await seller.lockLegB(acceptBRecord);
  await buyer.verifyLegBLocked();
  await seller.postAccountLineA(sellerAccount.address);
  await buyer.postAccountLineA(buyerAccount.address);
  /** The node and both wires now answer `eth_getTransactionByHash` (after the timeout the test is asking about a hash the node holds or has mined). */
  const exposeTxLookups = (): void => {
    node.answerTxByHash = true;
    buyerWire.byHash = "node";
    sellerWire.byHash = "node";
  };
  return { node, buyer, seller, buyerWire, sellerWire, stores, swapId, buyerOptions, sellerOptions, acceptA, exposeTxLookups, buyerAccount, clockRef };
}

const buyerRecord = async (stores: { buyer: MemoryFlowStore }, swapId: string): Promise<BuyerFlowRecord> => {
  const key = flowKey("buyer", swapId);
  return decodeFlowRecord((await stores.buyer.load(key))!, key) as BuyerFlowRecord;
};
const sellerRecord = async (stores: { seller: MemoryFlowStore }, contractA: string): Promise<SellerFlowRecord> => {
  const key = flowKey("seller", contractA);
  return decodeFlowRecord((await stores.seller.load(key))!, key) as SellerFlowRecord;
};

/** The ABI-encoded answer of `locks(hashLock)` for a row with this status (0 = no lock) and a zero payer: what a lagging node would answer. */
const lockRowAnswer = (status: 0 | 1): Hex => {
  const zero: Address = "0x0000000000000000000000000000000000000000";
  return encodeFunctionResult({
    abi: EVM_HASH_RAIL_ABI,
    functionName: "locks",
    result: status === 0 ? [zero, zero, zero, 0n, 0n, 0n, 0] : [zero, zero, TOKEN, 1n, BigInt(T0 + 60 * 60_000), BigInt(T0 + 90 * 60_000), status],
  });
};

const caught = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe("P9-4 decision 7: the Buyer's lock write that timed out is asked about before another is sent", () => {
  it("the review's case: the raw lock is pooled and not mined, the receipt wait times out at 150 ms; recoverLock answers pending, and no second approve or lock goes out", async () => {
    const r = await pairedSwap();
    r.node.holdNextSend("lock"); // the approve is mined, the lock is accepted into the pool and never mined
    const timeout = await caught(r.buyer.lockLegA());
    expect(timeout).toBeInstanceOf(EvmReceiptTimeoutError);
    const hash = (timeout as EvmReceiptTimeoutError).hash;
    expect((timeout as EvmReceiptTimeoutError).write).toBe("lock");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.node.held).toHaveLength(1);
    expect(r.node.count("approve")).toBe(1);
    expect(r.node.count("lock")).toBe(0);
    const sentBefore = r.buyerWire.rawSends.length;
    expect(sentBefore).toBe(2); // approve, lock

    // the hash is in the P8 record, strictly decoded, and it is the only thing that changed about the prepared handle
    const saved = await buyerRecord(r.stores, r.swapId);
    expect(saved.lock.prepared?.recovery).toEqual({ chain: "evm", txHash: hash });
    expect(saved.lock.prepared?.ref).toMatch(/^0x[0-9a-f]{64}$/);

    r.exposeTxLookups();

    // the same process: a second lockLegA is the pending path, nothing signed
    const again = await caught(r.buyer.lockLegA());
    expect(again).toBeInstanceOf(LockPendingError);
    expect(r.buyerWire.rawSends.length).toBe(sentBefore);

    // a fresh process resumed from the store: the same answer
    const resumed = await BuyerFlow.resume({ ...r.buyerOptions(), swapId: r.swapId });
    const refused = await caught(resumed.flow.lockLegA());
    expect(refused).toBeInstanceOf(LockPendingError);
    expect(r.buyerWire.rawSends.length, "no second approve, no second lock").toBe(sentBefore);
    expect(r.node.count("approve")).toBe(1);
    expect(r.node.count("lock")).toBe(0);

    // the node mines the pooled lock: the row is there and the resumed flow records the landed lock; still exactly one lock and one approve
    r.node.releaseHeld();
    const done = await resumed.flow.lockLegA();
    expect(done.hashLock).toBe(saved.lock.prepared?.ref);
    expect(r.node.count("lock")).toBe(1);
    expect(r.node.count("approve")).toBe(1);
    expect(r.buyerWire.rawSends.length).toBe(sentBefore);
  });

  it("the node says the lock was MINED and succeeded but this endpoint's row read still shows no lock (the answers disagree): pending, not never-landed, and nothing is sent", async () => {
    const r = await pairedSwap();
    r.node.holdNextSend("lock");
    expect(await caught(r.buyer.lockLegA())).toBeInstanceOf(EvmReceiptTimeoutError);
    r.node.releaseHeld(); // mined, receipt status 1
    r.exposeTxLookups();
    r.buyerWire.answers.set("eth_call", lockRowAnswer(0)); // the locks() read comes from a node that has not seen the block: no lock
    const sentBefore = r.buyerWire.rawSends.length;
    const resumed = await BuyerFlow.resume({ ...r.buyerOptions(), swapId: r.swapId });
    expect(await caught(resumed.flow.lockLegA())).toBeInstanceOf(LockPendingError);
    expect(r.buyerWire.rawSends.length, "no second approve, no second lock").toBe(sentBefore);
    expect(r.node.count("lock")).toBe(1);
    expect(r.node.count("approve")).toBe(1);
  });

  it("a hash the node does not know (the pool dropped it) proceeds as today: one fresh approve and lock, and the swap goes on", async () => {
    const r = await pairedSwap();
    r.node.holdNextSend("lock");
    expect(await caught(r.buyer.lockLegA())).toBeInstanceOf(EvmReceiptTimeoutError);
    r.node.dropHeld();
    r.exposeTxLookups();
    const sentBefore = r.buyerWire.rawSends.length;
    r.node.configExtras = {}; // the retry waits for its receipts normally
    const resumed = await BuyerFlow.resume({ ...r.buyerOptions(), swapId: r.swapId });
    const locked = await resumed.flow.lockLegA();
    expect(locked.writeEvidence.event).toBe("Locked");
    expect(r.node.count("lock")).toBe(1);
    expect(r.node.count("approve")).toBe(2); // the first approve, and a repeated one: harmless
    expect(r.buyerWire.rawSends.length).toBe(sentBefore + 2);
  });

  it("a lock that was mined and REVERTED did nothing: the resumed flow sends a fresh one", async () => {
    const r = await pairedSwap();
    r.node.holdNextSend("lock");
    expect(await caught(r.buyer.lockLegA())).toBeInstanceOf(EvmReceiptTimeoutError);
    r.node.failHeld();
    r.exposeTxLookups();
    r.node.configExtras = {};
    const resumed = await BuyerFlow.resume({ ...r.buyerOptions(), swapId: r.swapId });
    const locked = await resumed.flow.lockLegA();
    expect(locked.writeEvidence.event).toBe("Locked");
    expect(r.node.count("lock")).toBe(1);
  });

  it("only a LOCK write's hash is saved: an approve that times out leaves the handle empty, and the retry sends a fresh approve and lock as before", async () => {
    const r = await pairedSwap();
    r.node.holdNextSend("approve");
    const timeout = await caught(r.buyer.lockLegA());
    expect(timeout).toBeInstanceOf(EvmReceiptTimeoutError);
    expect((timeout as EvmReceiptTimeoutError).write).toBe("approve");
    expect((await buyerRecord(r.stores, r.swapId)).lock.prepared?.recovery).toBeUndefined();
    r.node.dropHeld();
    r.node.configExtras = {};
    r.exposeTxLookups();
    const resumed = await BuyerFlow.resume({ ...r.buyerOptions(), swapId: r.swapId });
    expect((await resumed.flow.lockLegA()).writeEvidence.event).toBe("Locked");
    expect(r.node.count("lock")).toBe(1);
  });
});

describe("P9-4 decision 7: the Seller's claim write that timed out is asked about before a second claim is signed", () => {
  async function lockedSwap() {
    const r = await pairedSwap();
    const lockA = await r.buyer.lockLegA();
    return { ...r, lockA };
  }

  it("the raw claim is pooled and not mined: the hash is saved, a second claimLegA and a resumed one are ClaimPendingError with no second signature; once it is mined the resumed Seller finishes and posts the frames", async () => {
    const r = await lockedSwap();
    r.node.holdNextSend("claim");
    const timeout = await caught(r.seller.claimLegA(r.lockA.hashLock));
    expect(timeout).toBeInstanceOf(EvmReceiptTimeoutError);
    const hash = (timeout as EvmReceiptTimeoutError).hash;
    expect((timeout as EvmReceiptTimeoutError).write).toBe("claim");
    expect(r.node.held).toHaveLength(1);
    expect(r.node.count("claim")).toBe(0);
    const sentBefore = r.sellerWire.rawSends.length;
    expect(sentBefore).toBe(1);
    expect((await sellerRecord(r.stores, r.acceptA.contract)).claimTxHash).toBe(hash);

    r.exposeTxLookups();
    const again = await caught(r.seller.claimLegA(r.lockA.hashLock));
    expect(again).toBeInstanceOf(ClaimPendingError);
    expect((again as ClaimPendingError).txHash).toBe(hash);
    expect((again as ClaimPendingError).status).toBe("pending");
    expect(r.sellerWire.rawSends.length).toBe(sentBefore);

    const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
    expect(await caught(resumed.flow.claimLegA(r.lockA.hashLock))).toBeInstanceOf(ClaimPendingError);
    expect(r.sellerWire.rawSends.length, "no second claim was signed").toBe(sentBefore);
    expect(r.node.count("claim")).toBe(0);

    r.node.releaseHeld(); // the node mines the held claim
    const claimed = await resumed.flow.claimLegA(r.lockA.hashLock);
    expect(claimed.receipt).toBeDefined();
    expect(claimed.reveal).toBeDefined();
    expect(r.node.count("claim")).toBe(1);
    expect(r.sellerWire.rawSends.length).toBe(sentBefore);
    const secret = await r.buyer.learnSecret();
    expect(verifyHashPreimage(r.lockA.hashLock, secret)).toBe(true);
  });

  it("the node says the claim was MINED and succeeded but this endpoint's lock row and claim log do not show it yet (the answers disagree): ClaimPendingError (success), nothing is signed", async () => {
    const r = await lockedSwap();
    r.node.holdNextSend("claim");
    expect(await caught(r.seller.claimLegA(r.lockA.hashLock))).toBeInstanceOf(EvmReceiptTimeoutError);
    r.node.releaseHeld(); // mined, receipt status 1
    r.exposeTxLookups();
    r.sellerWire.answers.set("eth_call", lockRowAnswer(1)); // the row still reads Locked
    r.sellerWire.answers.set("eth_getLogs", []); // and the log scan sees no claim
    const sentBefore = r.sellerWire.rawSends.length;
    const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
    const refused = await caught(resumed.flow.claimLegA(r.lockA.hashLock));
    expect(refused).toBeInstanceOf(ClaimPendingError);
    expect((refused as ClaimPendingError).status).toBe("success");
    expect(r.sellerWire.rawSends.length, "no second claim was signed").toBe(sentBefore);
    expect(r.node.count("claim")).toBe(1);
  });

  it("a claim that was mined and REVERTED did nothing (the lock is still open): the resumed Seller signs a fresh, fully guarded claim and it lands", async () => {
    const r = await lockedSwap();
    r.node.holdNextSend("claim");
    expect(await caught(r.seller.claimLegA(r.lockA.hashLock))).toBeInstanceOf(EvmReceiptTimeoutError);
    r.node.failHeld();
    r.exposeTxLookups();
    r.node.configExtras = {};
    const sentBefore = r.sellerWire.rawSends.length;
    const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
    const claimed = await resumed.flow.claimLegA(r.lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
    expect(r.node.count("claim")).toBe(1);
    expect(r.sellerWire.rawSends.length).toBe(sentBefore + 1);
  });

  it("a hash the node does not know proceeds as today: the resumed Seller signs one fresh claim", async () => {
    const r = await lockedSwap();
    r.node.holdNextSend("claim");
    expect(await caught(r.seller.claimLegA(r.lockA.hashLock))).toBeInstanceOf(EvmReceiptTimeoutError);
    r.node.dropHeld();
    r.exposeTxLookups();
    r.node.configExtras = {};
    const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
    expect((await resumed.flow.claimLegA(r.lockA.hashLock)).evidence.event).toBe("Claimed");
    expect(r.node.count("claim")).toBe(1);
  });
});

describe("P94-PIN-01: a node that answers an upper-case hash does not switch the protection of decision 7 off", () => {
  it("the Buyer's lock: the saved handle is the lower-case hash, and the resumed Buyer ends with LockPendingError, not a new approve and lock", async () => {
    const r = await pairedSwap({ upperCaseHashes: true });
    r.node.holdNextSend("lock");
    const timeout = await caught(r.buyer.lockLegA());
    expect(timeout).toBeInstanceOf(EvmReceiptTimeoutError);
    const hash = (timeout as EvmReceiptTimeoutError).hash;
    const held = r.node.held[0]!.txHash; // the node keys it in lower case: the very transaction it holds, which the wire answered in upper case
    expect(held).toMatch(/^0x[0-9a-f]{64}$/);
    expect(held).not.toBe(held.toUpperCase().replace("0X", "0x")); // letters in it: the upper-case answer is a different text
    expect((await buyerRecord(r.stores, r.swapId)).lock.prepared?.recovery).toEqual({ chain: "evm", txHash: held });

    r.exposeTxLookups();
    const sentBefore = r.buyerWire.rawSends.length;
    const resumed = await BuyerFlow.resume({ ...r.buyerOptions(), swapId: r.swapId });
    expect(await caught(resumed.flow.lockLegA())).toBeInstanceOf(LockPendingError);
    expect(r.buyerWire.rawSends.length, "no second approve, no second lock").toBe(sentBefore);
    expect(r.node.count("approve")).toBe(1);
    expect(r.node.count("lock")).toBe(0);
    expect(hash).toBe(held);
  });

  it("the Seller's claim: claimTxHash is saved in lower case, and the resumed claim ends with ClaimPendingError, not a second claim", async () => {
    const r = await pairedSwap({ upperCaseHashes: true });
    const lockA = await r.buyer.lockLegA();
    r.node.holdNextSend("claim");
    const timeout = await caught(r.seller.claimLegA(lockA.hashLock));
    expect(timeout).toBeInstanceOf(EvmReceiptTimeoutError);
    const hash = (timeout as EvmReceiptTimeoutError).hash;
    const held = r.node.held[0]!.txHash;
    expect(held).toMatch(/^0x[0-9a-f]{64}$/);
    expect(held).not.toBe(held.toUpperCase().replace("0X", "0x"));
    expect((await sellerRecord(r.stores, r.acceptA.contract)).claimTxHash).toBe(held);

    r.exposeTxLookups();
    const sentBefore = r.sellerWire.rawSends.length;
    const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
    const refused = await caught(resumed.flow.claimLegA(lockA.hashLock));
    expect(refused).toBeInstanceOf(ClaimPendingError);
    expect((refused as ClaimPendingError).txHash).toBe(held);
    expect(r.sellerWire.rawSends.length, "no second claim was signed").toBe(sentBefore);
    expect(r.node.count("claim")).toBe(0);
    expect(hash).toBe(held);
  });

  it("EvmReceiptTimeoutError itself keeps the hash in lower case whatever case it was built with (and the message names that hash)", () => {
    const upper = `0x${"AB".repeat(32)}` as Hex;
    const error = new EvmReceiptTimeoutError(upper, 1_000, "lock");
    expect(error.hash).toBe(`0x${"ab".repeat(32)}`);
    expect(error.message).toContain(`0x${"ab".repeat(32)}`);
    expect(error.message).not.toContain("AB");
  });
});

describe("P94-FUND-01: the claim's hash is shown the moment it is broadcast, and its receipt wait is short on Base Sepolia", () => {
  it("the review's case: 900 ms into the claim's receipt wait the Seller's record holds claimTxHash (saved before the runner's callback ran) and the callback has the hash, once", async () => {
    const sent: string[] = [];
    const snapshots: Array<Promise<Uint8Array | null>> = [];
    let r!: Awaited<ReturnType<typeof pairedSwap>>;
    r = await pairedSwap({
      receiptTimeoutMs: 2_500,
      onClaimSent: (hash) => {
        sent.push(hash);
        snapshots.push(r.stores.seller.load(flowKey("seller", r.acceptA.contract))); // what the store held at the moment the callback ran
      },
    });
    const lockA = await r.buyer.lockLegA();
    r.node.holdNextSend("claim"); // the raw claim is accepted into the pool and never mined: the receipt wait runs until it times out
    let settled = false;
    const claiming = caught(r.seller.claimLegA(lockA.hashLock)).then((error) => {
      settled = true;
      return error;
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(settled, "the receipt wait is still running").toBe(false);
    const held = r.node.held[0]!.txHash;
    expect(r.sellerWire.rawSends.length).toBe(1); // the claim, with its preimage, is out
    const during = await sellerRecord(r.stores, r.acceptA.contract);
    expect(during.claimAttempted).toBe(true);
    expect(during.claimTxHash).toBe(held); // today: undefined until the wait ends
    expect(sent).toEqual([held]); // the runner has it too
    expect(r.seller.claimSentHash).toBe(held);
    const atCallback = decodeFlowRecord((await snapshots[0]!)!, flowKey("seller", r.acceptA.contract)) as SellerFlowRecord;
    expect(atCallback.claimTxHash, "saved before the callback ran").toBe(held);

    const ended = await claiming;
    expect(ended).toBeInstanceOf(EvmReceiptTimeoutError);
    expect((ended as EvmReceiptTimeoutError).hash).toBe(held);
    expect((ended as EvmReceiptTimeoutError).timeoutMs).toBe(2_500); // anvil: the configured value, unchanged
    expect(sent, "told once, not again at the timeout").toEqual([held]);
    expect((await sellerRecord(r.stores, r.acceptA.contract)).claimTxHash).toBe(held);
  });

  it("an upper-case answer is saved and shown in lower case from the broadcast on (the broadcast event lower-cases it too)", async () => {
    const sent: string[] = [];
    const r = await pairedSwap({ receiptTimeoutMs: 2_500, upperCaseHashes: true, onClaimSent: (hash) => void sent.push(hash) });
    const lockA = await r.buyer.lockLegA();
    r.node.holdNextSend("claim");
    const claiming = caught(r.seller.claimLegA(lockA.hashLock));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const held = r.node.held[0]!.txHash;
    expect(held).not.toBe(held.toUpperCase().replace("0X", "0x")); // the wire answered it in upper case
    expect((await sellerRecord(r.stores, r.acceptA.contract)).claimTxHash).toBe(held);
    expect(sent).toEqual([held]);
    expect(await claiming).toBeInstanceOf(EvmReceiptTimeoutError);
  });

  it("a claim refused before it is sent (past claim-by) shows no hash and saves none", async () => {
    const sent: string[] = [];
    const r = await pairedSwap({ onClaimSent: (hash) => void sent.push(hash) });
    const lockA = await r.buyer.lockLegA();
    r.clockRef.ms = T0 + 61 * MIN; // anvil's leg A claim-by is +60
    await expect(r.seller.claimLegA(lockA.hashLock)).rejects.toThrow(/claimByMs/);
    expect(sent).toEqual([]);
    expect(r.sellerWire.rawSends.length).toBe(0);
    expect(r.seller.claimSentHash).toBeUndefined();
    expect((await sellerRecord(r.stores, r.acceptA.contract)).claimTxHash).toBeUndefined();
  });

  it("a callback that throws changes nothing: the claim lands, its hash is in the record, and the frames are posted", async () => {
    const r = await pairedSwap({
      onClaimSent: () => {
        throw new Error("the runner's printer broke");
      },
    });
    const lockA = await r.buyer.lockLegA();
    const claimed = await r.seller.claimLegA(lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
    expect(claimed.reveal).toBeDefined();
    expect(claimed.receipt).toBeDefined();
    expect(r.node.count("claim")).toBe(1);
    const record = await sellerRecord(r.stores, r.acceptA.contract);
    expect(record.claimTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(record.claimOutcome).toBe("landed");
  });

  it("the connected rail tells every write's hash (approve, lock, claim) before its receipt wait, lower-cased, to every listener; a listener that throws or is slow changes nothing", async () => {
    const events: Array<{ write: RailWriteBroadcast["write"]; hash: string; receiptReads: number }> = [];
    let node!: EvmMockNode;
    const wrap = (rail: CounterAssetRail): CounterAssetRail =>
      Object.create(rail, {
        connect: {
          value: async (...args: Parameters<CounterAssetRail["connect"]>) => {
            const connected = await rail.connect(...args);
            connected.onWriteBroadcast?.((event) => {
              events.push({ write: event.write, hash: event.hash, receiptReads: node.requests.filter((m) => m === "eth_getTransactionReceipt").length });
            });
            connected.onWriteBroadcast?.(() => {
              throw new Error("a listener that breaks");
            });
            const off = connected.onWriteBroadcast?.(async () => {
              events.push({ write: undefined, hash: "removed listener ran", receiptReads: -1 });
            });
            off?.(); // removed again at once: it must never run
            connected.onWriteBroadcast?.(async () => {
              await new Promise((resolve) => setTimeout(resolve, 20)); // a slow listener is awaited, the write is not skipped
            });
            return connected;
          },
        },
      }) as CounterAssetRail;
    const r = await pairedSwap({ upperCaseHashes: true, wrapRail: wrap });
    node = r.node;
    const lockA = await r.buyer.lockLegA();
    await r.seller.claimLegA(lockA.hashLock);
    expect(events.map((event) => event.write)).toEqual(["approve", "lock", "claim"]);
    for (const event of events) expect(event.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(events.map((event) => event.hash)).size).toBe(3);
    expect(events[0]!.receiptReads, "told before anything asked for a receipt").toBe(0);
    expect(events[1]!.receiptReads).toBeGreaterThan(0); // the approve's wait ran between the first and the second
    expect(events[2]!.receiptReads).toBeGreaterThan(events[1]!.receiptReads);
    expect(events.some((event) => event.receiptReads === -1)).toBe(false);
    expect(r.node.count("claim")).toBe(1);
    expect(r.node.count("lock")).toBe(1);
  });

  describe("the pending claim's sentence (ClaimPendingError)", () => {
    const refundMs = T0 + 90 * MIN;
    const hash = `0x${"ab".repeat(32)}`;

    it("through the resumed Seller: it names the hash, the minutes left before leg A's refund time, that time, and the by-hand step; it holds no preimage", async () => {
      const secret = generateHashLock();
      const r = await pairedSwap({ mintHashLock: () => secret });
      const lockA = await r.buyer.lockLegA();
      r.node.holdNextSend("claim");
      expect(await caught(r.seller.claimLegA(lockA.hashLock))).toBeInstanceOf(EvmReceiptTimeoutError);
      const held = r.node.held[0]!.txHash;
      r.exposeTxLookups();
      r.clockRef.ms = T0 + 30 * MIN; // 60 minutes before leg A's refund time (+90), still inside its claim window
      const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
      const refused = await caught(resumed.flow.claimLegA(lockA.hashLock));
      expect(refused).toBeInstanceOf(ClaimPendingError);
      const text = (refused as ClaimPendingError).message;
      expect(text).toContain(held);
      expect(text).toContain("60 min left before leg A's refund time");
      expect(text).toContain(`before leg A's refund time at ${new Date(refundMs).toISOString()}`);
      expect(text).toContain("speed the claim up with the same nonce and a higher fee from a wallet that holds the key file's key");
      expect(text).toContain("A stuck claim is not re-priced");
      expect(text.includes(secret.preimage) || text.includes(secret.preimage.slice(2))).toBe(false);
      expect((refused as ClaimPendingError).minutesLeft).toBe(60);
      expect((refused as ClaimPendingError).refundAfterMs).toBe(refundMs);
      expect(r.node.count("claim")).toBe(0); // nothing new was signed
    });

    it("past leg A's refund time it says the claim can no longer land and a speed-up cannot help (no instruction to send anything)", async () => {
      const r = await pairedSwap();
      const lockA = await r.buyer.lockLegA();
      r.node.holdNextSend("claim");
      expect(await caught(r.seller.claimLegA(lockA.hashLock))).toBeInstanceOf(EvmReceiptTimeoutError);
      r.exposeTxLookups();
      r.clockRef.ms = refundMs + MIN;
      const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
      const refused = await caught(resumed.flow.claimLegA(lockA.hashLock));
      expect(refused).toBeInstanceOf(ClaimPendingError);
      const text = (refused as ClaimPendingError).message;
      expect(text).toContain(`leg A's refund time (${new Date(refundMs).toISOString()}) has passed`);
      expect(text).not.toMatch(/speed the claim up/);
      expect((refused as ClaimPendingError).minutesLeft).toBe(0);
    });

    it("the sentence by cases: minutes, under a minute, passed, no timing (hash and remedy only), a bad timing is no timing, and a mined claim keeps the plain sentence", () => {
      const at = (leftMs: number) => new ClaimPendingError(hash, "pending", { refundAfterMs: refundMs, nowMs: refundMs - leftMs }).message;
      expect(at(5 * MIN + 59_000)).toContain("5 min left before leg A's refund time; speed the claim up with the same nonce");
      expect(at(30_000)).toContain("under 1 min left before leg A's refund time; speed the claim up");
      expect(at(0)).toContain("has passed, so it can no longer land");
      expect(at(-MIN)).toContain("has passed, so it can no longer land");
      for (const text of [at(5 * MIN), at(30_000)]) expect(text).toContain(hash);
      const bare = new ClaimPendingError(hash, "pending");
      expect(bare.message).toContain(hash);
      expect(bare.message).toContain("speed the claim up with the same nonce and a higher fee from a wallet that holds the key file's key, before leg A's refund time (README");
      expect(bare.message).not.toMatch(/min left|has passed/);
      expect(bare.minutesLeft).toBeUndefined();
      expect(bare.refundAfterMs).toBeUndefined();
      for (const bad of [{ refundAfterMs: Number.NaN, nowMs: 1 }, { refundAfterMs: 1, nowMs: Number.POSITIVE_INFINITY }, { refundAfterMs: 9e15, nowMs: 1 }]) {
        const odd = new ClaimPendingError(hash, "pending", bad);
        expect(odd.message).not.toMatch(/min left|has passed|Invalid/);
        expect(odd.minutesLeft).toBeUndefined();
      }
      const mined = new ClaimPendingError(hash, "success", { refundAfterMs: refundMs, nowMs: refundMs - 10 * MIN });
      expect(mined.message).toContain("mined but not visible to the lock and log reads yet");
      expect(mined.message).not.toMatch(/speed the claim up/);
      expect(mined.message).toContain(hash);
      expect(mined.name).toBe("ClaimPendingError");
      expect(mined.txHash).toBe(hash);
      expect(mined.status).toBe("success");
    });
  });

  describe("Base Sepolia: the claim's own receipt wait is bounded to 180 s, the other writes keep receiptTimeoutMs", () => {
    /** Runs `work` under fake timers, advancing one second at a time up to `limitMs`; the elapsed virtual time when it settled (`undefined` if it did not) and its value. */
    async function settleWithin<T>(work: Promise<T>, limitMs: number): Promise<{ elapsedMs: number | undefined; value: T | undefined }> {
      let elapsedMs: number | undefined;
      let value: T | undefined;
      let now = 0;
      void work.then((v) => {
        elapsedMs = now;
        value = v;
      });
      while (elapsedMs === undefined && now < limitMs) {
        await vi.advanceTimersByTimeAsync(1_000);
        now += 1_000;
      }
      return { elapsedMs, value };
    }

    it("receiptTimeoutMs one hour: the claim's wait ends by 180 s with the typed timeout; a lock's wait is still running past 180 s and ends at the hour", async () => {
      const claimSwap = await pairedSwap({ chainId: 84532, receiptTimeoutMs: 3_600_000 });
      const lockA = await claimSwap.buyer.lockLegA();
      claimSwap.node.holdNextSend("claim");
      const lockSwap = await pairedSwap({ chainId: 84532, receiptTimeoutMs: 3_600_000 });
      lockSwap.node.holdNextSend("lock");
      vi.useFakeTimers();
      try {
        const claim = await settleWithin(caught(claimSwap.seller.claimLegA(lockA.hashLock)), 3_700_000);
        expect(claim.elapsedMs, "the claim's wait ended").toBeDefined();
        expect(claim.elapsedMs!).toBeLessThanOrEqual(EVM_CLAIM_RECEIPT_WAIT_MS_BASE_SEPOLIA + 2_000);
        expect(claim.elapsedMs!).toBeGreaterThanOrEqual(EVM_CLAIM_RECEIPT_WAIT_MS_BASE_SEPOLIA - 5_000);
        expect(claim.value).toBeInstanceOf(EvmReceiptTimeoutError);
        expect((claim.value as EvmReceiptTimeoutError).write).toBe("claim");
        expect((claim.value as EvmReceiptTimeoutError).timeoutMs).toBe(180_000);

        const lock = await settleWithin(caught(lockSwap.buyer.lockLegA()), 3_700_000);
        expect(lock.elapsedMs, "the lock's wait ended too").toBeDefined();
        expect(lock.elapsedMs!).toBeGreaterThan(3_000_000); // far past the claim's 180 s: its configured hour
        expect(lock.value).toBeInstanceOf(EvmReceiptTimeoutError);
        expect((lock.value as EvmReceiptTimeoutError).write).toBe("lock");
        expect((lock.value as EvmReceiptTimeoutError).timeoutMs).toBe(3_600_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a receiptTimeoutMs below 180 s is kept for the claim (the cap only lowers)", async () => {
      const r = await pairedSwap({ chainId: 84532, receiptTimeoutMs: 20_000 });
      const lockA = await r.buyer.lockLegA();
      r.node.holdNextSend("claim");
      vi.useFakeTimers();
      try {
        const claim = await settleWithin(caught(r.seller.claimLegA(lockA.hashLock)), 200_000);
        expect(claim.elapsedMs!).toBeLessThanOrEqual(22_000);
        expect((claim.value as EvmReceiptTimeoutError).timeoutMs).toBe(20_000);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("P9-4 decision 7: EvmHtlcRail.transactionStatus reads the node, and never reads a bad answer as unknown", () => {
  const TX = HASH(0xabc);
  async function railAnswering(answers: { byHash: unknown; receipt?: unknown }) {
    const scripted = scriptedRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getTransactionByHash: () => (answers.byHash instanceof Error ? { error: { code: -32000, message: answers.byHash.message } } : { result: answers.byHash }),
      eth_getTransactionReceipt: () => ({ result: answers.receipt ?? null }),
    });
    const node = new EvmMockNode(() => T0, RAIL, TOKEN, []);
    const book: AddressBook = { resolve: () => getAddress("0x00000000000000000000000000000000000000b1") };
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: scripted.rpc, account: getAddress("0x00000000000000000000000000000000000000b1"), addressBook: book, clock: () => T0 });
    scripted.calls.length = 0;
    return { rail, calls: scripted.calls };
  }

  it("null is unknown; a transaction with no block is pending; a mined one is success or reverted by its receipt; mined with no receipt is pending", async () => {
    expect(await (await railAnswering({ byHash: null })).rail.transactionStatus(TX)).toBe("unknown");
    const pending = await railAnswering({ byHash: { hash: TX, blockNumber: null } });
    expect(await pending.rail.transactionStatus(TX)).toBe("pending");
    expect(pending.calls.map((call) => call.method)).toEqual(["eth_getTransactionByHash"]); // no receipt asked for a transaction with no block
    const mined = { hash: TX.toUpperCase().replace("0X", "0x"), blockNumber: "0x10" };
    expect(await (await railAnswering({ byHash: mined, receipt: { status: "0x1" } })).rail.transactionStatus(TX)).toBe("success");
    expect(await (await railAnswering({ byHash: mined, receipt: { status: "0x0" } })).rail.transactionStatus(TX)).toBe("reverted");
    expect(await (await railAnswering({ byHash: mined, receipt: null })).rail.transactionStatus(TX)).toBe("pending");
  });

  it("an answer for another transaction, a malformed one, a receipt with no usable status, or a failed read throws (never unknown)", async () => {
    await expect((await railAnswering({ byHash: { hash: HASH(1), blockNumber: null } })).rail.transactionStatus(TX)).rejects.toThrow(/another transaction/);
    await expect((await railAnswering({ byHash: "0x1" })).rail.transactionStatus(TX)).rejects.toThrow(/not a transaction/);
    await expect((await railAnswering({ byHash: { hash: TX, blockNumber: "pending" } })).rail.transactionStatus(TX)).rejects.toThrow(/not a hex number/);
    await expect((await railAnswering({ byHash: { hash: TX, blockNumber: "0x10" }, receipt: { status: "0x2" } })).rail.transactionStatus(TX)).rejects.toThrow(/usable status/);
    await expect((await railAnswering({ byHash: new Error("rate limited") })).rail.transactionStatus(TX)).rejects.toThrow();
  });
});
