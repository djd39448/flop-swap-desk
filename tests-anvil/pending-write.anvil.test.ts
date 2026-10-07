// SPDX-License-Identifier: MIT
//
// tests-anvil/pending-write.anvil.test.ts - P9-4 decision 7 (R1-FUND-04) on a REAL anvil node: a lock or claim write whose receipt wait timed out is asked about
// by hash before it is sent again. The raw transaction is "pooled without being mined" the way a congested public endpoint holds it: a fetch wrapper in front of the
// rail switches anvil's automine off (`evm_setAutomine`) just before it forwards the lock's (or the claim's) `eth_sendRawTransaction`, so the node ACCEPTS the
// transaction, answers its hash, and keeps it in its own pool (a real `eth_getTransactionByHash` answer with no block) until the test mines a block. With
// `receiptTimeoutMs` 6,000 (above viem's 4-second polling interval: a real node answers the first receipt read, made at once, with nothing even for a transaction it mines at once, so a shorter wait would time out an ordinary approve; the hermetic suite's 150 ms is for its instant mock) the receipt wait times out (`EvmReceiptTimeoutError`), the flow saves the hash in the P8 record, and:
//   - a second `lockLegA()` and a resumed one answer `LockPendingError` with no second approve and no second lock sent;
//   - a second `claimLegA()` and a resumed one answer `ClaimPendingError` with no second claim signed;
//   - once a block is mined the resumed flow recognises the transaction and finishes (one lock, one claim on chain).
// Keys are generated at test time and loaded through the real key-file loader; none is printed. `npm run test:anvil` only.

import { MemoryNoteStore, PaperRail, verifyHashPreimage } from "@flop-labs/tclk";
import { encodeFunctionData, parseTransaction, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BuyerFlow, LockPendingError } from "../src/client/buyer.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { MemoryFlowStore } from "../src/client/flow-store.js";
import { ClaimPendingError, SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { ANVIL_LOCAL_PIN, EvmReceiptTimeoutError, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { makeLocalAccount } from "../tests/helpers/evm-local.js";
import { identity } from "../tests/helpers/identity.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const GENESIS_SECONDS = 1_700_000_000;

const TOKEN_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

const legA = (t0: number) => ({ claimByMs: t0 + 60 * 60_000, refundAfterMs: t0 + 90 * 60_000, expiresMs: t0 + 30 * 60_000 });
const legB = (t0: number) => ({ claimByMs: t0 + 120 * 60_000, refundAfterMs: t0 + 180 * 60_000, expiresMs: t0 + 40 * 60_000 });

const caught = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe("a write the node still holds is not sent again (real anvil, local accounts, receiptTimeoutMs 6,000)", () => {
  let anvil: AnvilHandle;
  let funder: Address;
  let config: EvmRailConfig;
  let tokenContract: Address;
  let railContract: Address;

  beforeAll(async () => {
    anvil = await startAnvil({ timestampSeconds: GENESIS_SECONDS });
    const [first] = anvil.accounts;
    if (first === undefined) throw new Error("test setup: anvil did not expose an account");
    funder = first;
    const deployed = await deployRailContracts(anvil.endpoint, funder);
    tokenContract = deployed.tokenContract;
    railContract = deployed.railContract;
    config = { pin: ANVIL_LOCAL_PIN, endpoint: anvil.endpoint, contract: railContract, assets: { USDC: tokenContract }, receiptTimeoutMs: 6_000 };
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  // a test that fails while a transaction is held must not leave anvil's automine off for the next one
  beforeEach(async () => {
    await anvil.rpcCall("evm_setAutomine", [true]);
  });

  async function waitForReceipt(hash: Hex): Promise<void> {
    for (;;) {
      const receipt = await anvil.rpcCall<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
      if (receipt !== null) {
        if (receipt.status !== "0x1") throw new Error("test setup: a funding transaction reverted");
        return;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  async function fund(to: Address): Promise<void> {
    await waitForReceipt(await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: funder, to, value: "0x8ac7230489e80000" }]));
    const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [to, 100_000_000n] });
    await waitForReceipt(await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: funder, to: tokenContract, data }]));
  }

  async function currentChainTimeMs(): Promise<number> {
    const block = await anvil.rpcCall<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    return Number.parseInt(block.timestamp, 16) * 1_000;
  }

  /**
   * A transport to anvil that POOLS one kind of raw transaction: when the next `eth_sendRawTransaction` is sent to `railContract` (the lock, or the claim: the
   * approve goes to the token) and `pool` says so, anvil's automine is switched off right before it is forwarded, so anvil holds it without mining it.
   */
  function poolingRpc(pool: { next: boolean }): { rpc: CapturingRpc; sends: { count: number } } {
    // the wrapper counts the raw sends itself: the capturing transport's own log is drained at every connect, so it cannot be counted across a test
    const sends = { count: 0 };
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
      if (body.method === "eth_sendRawTransaction") sends.count += 1;
      if (pool.next && body.method === "eth_sendRawTransaction") {
        const parsed = parseTransaction(String(body.params?.[0]) as Hex);
        if (parsed.to?.toLowerCase() === railContract.toLowerCase()) {
          pool.next = false;
          await anvil.rpcCall("evm_setAutomine", [false]);
        }
      }
      return fetch(url as string, init);
    }) as typeof fetch;
    return { rpc: new CapturingRpc({ endpoint: anvil.endpoint, fetch: fetchImpl }), sends };
  }

  async function setup(buyerSeed: string, sellerSeed: string) {
    const buyerAccount: LocalAccount = await makeLocalAccount();
    const sellerAccount: LocalAccount = await makeLocalAccount();
    await fund(buyerAccount.address);
    await fund(sellerAccount.address);
    const pool = { next: false };
    const buyerWire = poolingRpc(pool);
    const sellerWire = poolingRpc(pool);
    const buyerRpc = buyerWire.rpc;
    const sellerRpc = sellerWire.rpc;
    const buyerId = identity(buyerSeed.repeat(32));
    const sellerId = identity(sellerSeed.repeat(32));
    const t0 = await currentChainTimeMs();
    const clock = (): number => t0;
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const stores = { buyer: new MemoryFlowStore(), seller: new MemoryFlowStore() };
    const buyerOptions = () => ({ identity: buyerId, venue, paperRail: new PaperRail(noteStore, clock), rail: createEvmCounterRail({ config, rpc: buyerRpc, account: buyerAccount, clock }), clock, store: stores.buyer });
    const sellerOptions = () => ({ identity: sellerId, venue, paperRail: new PaperRail(noteStore, clock), rail: createEvmCounterRail({ config, rpc: sellerRpc, account: sellerAccount, clock }), clock, store: stores.seller });
    const buyer = new BuyerFlow(buyerOptions());
    const seller = new SellerFlow(sellerOptions());
    const swapId = computeSwapId(buyerId.did, `0000${buyerSeed}${sellerSeed}`);
    const offerA = await buyer.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legA(t0) });
    const { acceptA, acceptARecord, offerBRecord } = await seller.acceptLegA(offerA, legB(t0), t0);
    const { acceptBRecord } = await buyer.acceptLegB(offerBRecord, acceptARecord, t0);
    await seller.lockLegB(acceptBRecord);
    await buyer.verifyLegBLocked();
    await seller.postAccountLineA(sellerAccount.address);
    await buyer.postAccountLineA(buyerAccount.address);
    return { buyer, seller, buyerSends: buyerWire.sends, sellerSends: sellerWire.sends, pool, swapId, acceptA, buyerOptions, sellerOptions };
  }

  async function mine(blocks: number): Promise<void> {
    await anvil.rpcCall("evm_setAutomine", [true]); // the held transaction is mined by the next block of any kind
    await anvil.rpcCall("anvil_mine", [`0x${blocks.toString(16)}`]);
  }

  it("the Buyer's lock is held by the node: the timeout is typed, a second and a resumed lockLegA are pending, nothing is sent again; once mined, the resumed flow finishes with one lock and one approve", async () => {
    const s = await setup("71", "72");
    s.pool.next = true; // the lock (sent to the escrow) is pooled; the approve (sent to the token) was already mined by then
    const timeout = await caught(s.buyer.lockLegA());
    expect(timeout).toBeInstanceOf(EvmReceiptTimeoutError);
    expect((timeout as EvmReceiptTimeoutError).write).toBe("lock");
    const hash = (timeout as EvmReceiptTimeoutError).hash;

    // a REAL node's answer for a transaction it holds: known, with no block
    const held = await anvil.rpcCall<{ hash: string; blockNumber: Hex | null } | null>("eth_getTransactionByHash", [hash]);
    expect(held?.hash.toLowerCase()).toBe(hash.toLowerCase());
    expect(held?.blockNumber).toBeNull();
    expect(await anvil.rpcCall("eth_getTransactionReceipt", [hash])).toBeNull();
    const sentBefore = s.buyerSends.count;
    expect(sentBefore).toBe(2); // approve, lock

    expect(await caught(s.buyer.lockLegA())).toBeInstanceOf(LockPendingError);
    const resumed = await BuyerFlow.resume({ ...s.buyerOptions(), swapId: s.swapId });
    expect(await caught(resumed.flow.lockLegA())).toBeInstanceOf(LockPendingError);
    expect(s.buyerSends.count, "no second approve, no second lock").toBe(sentBefore);

    await mine(1); // the node mines what it holds
    const locked = await resumed.flow.lockLegA();
    expect(locked.hashLock).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.buyerSends.count).toBe(sentBefore);
    const mined = await anvil.rpcCall<{ blockNumber: Hex | null } | null>("eth_getTransactionByHash", [hash]);
    expect(mined?.blockNumber).not.toBeNull();
  }, 120_000);

  it("the Seller's claim is held by the node: a second and a resumed claimLegA are ClaimPendingError with no second claim signed; once mined the resumed Seller posts the frames and the Buyer learns the secret", async () => {
    const s = await setup("73", "74");
    const lockA = await s.buyer.lockLegA();
    await mine(3); // the lock is final: anvil's finalized block trails the head by two
    s.pool.next = true; // the claim (sent to the escrow) is pooled
    const timeout = await caught(s.seller.claimLegA(lockA.hashLock));
    expect(timeout).toBeInstanceOf(EvmReceiptTimeoutError);
    expect((timeout as EvmReceiptTimeoutError).write).toBe("claim");
    const sentBefore = s.sellerSends.count;
    expect(sentBefore).toBe(1);

    const again = await caught(s.seller.claimLegA(lockA.hashLock));
    expect(again).toBeInstanceOf(ClaimPendingError);
    expect((again as ClaimPendingError).status).toBe("pending");
    const resumed = await SellerFlow.resume({ ...s.sellerOptions(), swapId: s.swapId, contractA: s.acceptA.contract });
    expect(await caught(resumed.flow.claimLegA(lockA.hashLock))).toBeInstanceOf(ClaimPendingError);
    expect(s.sellerSends.count, "no second claim was signed").toBe(sentBefore);

    await mine(1);
    const claimed = await resumed.flow.claimLegA(lockA.hashLock);
    expect(claimed.receipt).toBeDefined();
    expect(claimed.reveal).toBeDefined();
    expect(s.sellerSends.count).toBe(sentBefore);
    const secret = await s.buyer.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await s.buyer.claimLegB(secret);
  }, 120_000);
});
