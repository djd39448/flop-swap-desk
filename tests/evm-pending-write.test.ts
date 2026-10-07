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

import { MemoryNoteStore, PaperRail, generateHashLock, verifyHashPreimage } from "@flop-labs/tclk";
import { encodeFunctionResult, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { BuyerFlow, LockPendingError, type BidParams } from "../src/client/buyer.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { decodeFlowRecord, type BuyerFlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import { MemoryFlowStore, flowKey } from "../src/client/flow-store.js";
import { ClaimPendingError, SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { EvmHtlcRail, EvmReceiptTimeoutError } from "../src/rails/evm-htlc.js";
import { EVM_HASH_RAIL_ABI, type AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { makeLocalAccount, localSigningRpc, type LocalSigningRpc } from "./helpers/evm-local.js";
import { identity } from "./helpers/identity.js";
import { scriptedRpc } from "./helpers/scripted-rpc.js";

const T0 = 1_700_000_000_000;
const RAIL = getAddress(`0x${Buffer.from("p94-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("p94-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const HASH = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const BID = (swapId: string): BidParams => ({
  swapId,
  wantAsset: "FLOP",
  wantAmount: "52070000",
  wantRail: "flop-htlc",
  amount: "1000000",
  asset: "USDC",
  claimByMs: T0 + 60 * 60_000,
  refundAfterMs: T0 + 90 * 60_000,
  expiresMs: T0 + 30 * 60_000,
});
const LEG_B = { claimByMs: T0 + 120 * 60_000, refundAfterMs: T0 + 180 * 60_000, expiresMs: T0 + 40 * 60_000 };

/** Both parties with local accounts and a store each, over one mock node, through the pairing, leg B's paper lock and both account lines; `receiptTimeoutMs` 150
 *  (or `options.receiptTimeoutMs`). `options.upperCaseHashes` makes both wires answer every send's hash in upper case (P94-PIN-01). */
async function pairedSwap(options: { receiptTimeoutMs?: number; upperCaseHashes?: boolean } = {}) {
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const node = new EvmMockNode(clock, RAIL, TOKEN, []);
  node.configExtras = { receiptTimeoutMs: options.receiptTimeoutMs ?? 150 };
  const buyerAccount = await makeLocalAccount();
  const sellerAccount = await makeLocalAccount();
  const buyerWire = localSigningRpc(node);
  const sellerWire = localSigningRpc(node);
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
    rail: createEvmCounterRail({ config: node.config(), rpc: buyerWire.rpc, account: buyerAccount, clock }),
    clock,
    store: stores.buyer,
  });
  const sellerOptions = () => ({
    identity: sellerId,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config: node.config(), rpc: sellerWire.rpc, account: sellerAccount, clock }),
    clock,
    store: stores.seller,
  });
  const buyer = new BuyerFlow(buyerOptions());
  const seller = new SellerFlow(sellerOptions());
  const swapId = computeSwapId(buyerId.did, "000000b4");
  const offerA = await buyer.bid(BID(swapId));
  const { acceptA, acceptARecord, offerBRecord } = await seller.acceptLegA(offerA, LEG_B, T0);
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
  return { node, buyer, seller, buyerWire, sellerWire, stores, swapId, buyerOptions, sellerOptions, acceptA, exposeTxLookups, buyerAccount };
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
