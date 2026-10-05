// SPDX-License-Identifier: MIT
//
// tests-regtest/client-flows-k.regtest.test.ts — P4-BTC-FIXES-R3.md K1/K2: the scenarios that
// need a real bitcoind mempool (a genuine, unmined broadcast) and so cannot be driven
// hermetically: K1 (the Buyer's own learnSecret finds a claim that has been broadcast but never
// mined), and K2 (refundLegA reads that same pending-claim state BEFORE ever building a refund,
// and routes to learnSecret()/claimLegB() instead of racing a doomed broadcast). Mirrors
// tests-regtest/client-flows-g.regtest.test.ts's own harness shape.
//
// Design source: flop-contrib/handoff/P4-BTC-FIXES-R3.md K1, K2.

import { MemoryNoteStore, PaperRail, generateHashLock } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { BTC_REGTEST_PIN, keyFromAddressInfo, type BtcRailConfig, type BtcSignerKey } from "../src/rails/btc-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { startBitcoind, type BitcoindHandle, type RegtestWallet } from "./helpers/bitcoind.js";

function keyFor(wallet: RegtestWallet): BtcSignerKey {
  return keyFromAddressInfo({ pubkey: wallet.pubkey, hdmasterfingerprint: wallet.hdMasterFingerprint, hdkeypath: wallet.hdKeyPath });
}

async function currentMediantimeMs(node: BitcoindHandle): Promise<number> {
  const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
  return info.mediantime * 1000;
}

/** Leg A: a 5-hour refundAfterMs from `t0`, mirroring client-flows-g.regtest.test.ts's own
 *  sizing — comfortably clears BTC_LOCAL_POLICY's 60-minute numbers with room for the ~1h MTP
 *  lag. */
function legADeadlines(t0: number) {
  return { claimByMs: t0 + 3 * 60 * 60_000, refundAfterMs: t0 + 5 * 60 * 60_000, expiresMs: t0 + 30 * 60_000 };
}
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 9 * 60 * 60_000, refundAfterMs: t0 + 20 * 60 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

interface Party {
  identity: Identity;
  rpc: CapturingRpc;
}

function setupSwap(node: BitcoindHandle, config: BtcRailConfig, buyer: Party, seller: Party, t0: number) {
  const clockRef = { ms: t0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();

  const buyerRail: CounterAssetRail = createBtcCounterRail({
    config,
    rpc: buyer.rpc,
    wallet: node.buyer.wallet,
    key: keyFor(node.buyer),
    destinationAddress: node.buyer.address,
    clock,
  });
  const sellerRail: CounterAssetRail = createBtcCounterRail({
    config,
    rpc: seller.rpc,
    wallet: node.seller.wallet,
    key: keyFor(node.seller),
    destinationAddress: node.seller.address,
    clock,
  });

  const buyerFlow = new BuyerFlow({ identity: buyer.identity, venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail, clock });
  // P8: the Seller keeps its secret in a #private field, so the harness injects the lock it mints and tests read it here.
  const sellerLock = generateHashLock();
  const sellerFlow = new SellerFlow({ identity: seller.identity, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock, mintHashLock: () => sellerLock });

  async function warpTo(nowMs: number): Promise<void> {
    clockRef.ms = nowMs;
    await node.setMockTime(Math.floor(nowMs / 1000) + 1);
    await node.mine(11);
  }
  async function mineBlocks(n: number): Promise<void> {
    await node.mine(n);
  }

  return { clockRef, clock, venue, noteStore, buyerFlow, sellerFlow, sellerLock, buyerRail, sellerRail, warpTo, mineBlocks };
}

type Swap = ReturnType<typeof setupSwap>;

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both pubkey lines — every
 *  scenario below's shared prefix, up to (but not including) `lockLegA`. */
async function pairAndVerify(nonceHex: string, buyer: Identity, h: Swap, t0: number, node: BitcoindHandle) {
  const swapId = computeSwapId(buyer.did, nonceHex);
  const offerA = await h.buyerFlow.bid({
    swapId,
    wantAsset: "FLOP",
    wantAmount: "52070000",
    wantRail: "flop-htlc",
    amount: "1000000",
    asset: "BTC",
    ...legADeadlines(t0),
  });
  const { acceptA, acceptARecord, offerB, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(t0), t0);
  const { acceptB, acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, t0);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  await h.sellerFlow.postAccountLineA(node.seller.pubkey.toLowerCase());
  await h.buyerFlow.postAccountLineA(node.buyer.pubkey.toLowerCase());
  return { swapId, offerA, offerB, acceptA, acceptB };
}

describe("K1/K2 — a pending (unmined) claim, on a real bitcoind mempool", () => {
  let node: BitcoindHandle;
  let config: BtcRailConfig;

  beforeAll(async () => {
    node = await startBitcoind();
    config = { pin: { ...BTC_REGTEST_PIN, finality: { confirmations: 2 } }, endpoint: node.endpoint };
  }, 120_000);

  afterAll(async () => {
    await node?.stop();
  });

  function freshParty(id: Identity): Party {
    return { identity: id, rpc: node.createCapturingRpc() };
  }
  function ident(tag: number): Identity {
    return identity(tag.toString(16).padStart(2, "0").repeat(32));
  }

  it("K1: the Buyer's learnSecret finds a claim the Seller broadcast but never revealed and never mined", async () => {
    const buyer = ident(121);
    const seller = ident(122);
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

    await pairAndVerify("00000121", buyer, h, t0, node);
    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(2); // the funding's own confirmations, needed for claimLegA's verifyLockFinal

    // The Seller claims, but posts NO reveal frame (options.skipReveal), and deliberately no
    // block is mined afterward — the claim sits in the mempool alone. Before K1, the Buyer's own
    // learnSecret (via findClaimedPreimage's bounded BLOCK scan) would find nothing here at all.
    await h.sellerFlow.claimLegA(lockA.hashLock, { skipReveal: true });

    const mempool = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempool).toHaveLength(1); // the claim really is only in the mempool

    const secret = await h.buyerFlow.learnSecret();
    expect(secret).toBe(h.sellerLock.preimage);

    // And the secret genuinely settles leg B (SPEC's own promise: a learned secret always works).
    const claimed = await h.buyerFlow.claimLegB(secret);
    expect(claimed.receipt).toBeDefined();
  }, 120_000);

  it("K2: refundLegA reads the pending claim before ever building a refund, and routes to learnSecret()/claimLegB() with a clear message", async () => {
    const buyer = ident(123);
    const seller = ident(124);
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

    const { offerA } = await pairAndVerify("00000122", buyer, h, t0, node);
    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(2);

    // The Seller claims (no reveal frame, no block mined) — exactly the race K1/K2 describe: a
    // claim the Buyer would otherwise not know about until (and unless) a block confirms it.
    await h.sellerFlow.claimLegA(lockA.hashLock, { skipReveal: true });

    // Past refundAfterMs now, so a Buyer that never learned about the claim would normally reach
    // for refundLegA — K2 requires it to check the outpoint's own state FIRST and refuse with a
    // clear, actionable reason instead of racing a doomed broadcast (or, worse, actually managing
    // to double-spend the mempool before the claim mines). This advances only the FLOW's own
    // clock (never the chain's real median-time-past, which `warpTo` would also mine 11 blocks
    // to advance) — the claim must stay genuinely UNMINED for this to test the pending-claim
    // check rather than the already-confirmed one.
    h.clockRef.ms = offerA.refundAfterMs + 5 * 60_000;
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/claimed/);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/learnSecret\(\) then claimLegB\(\)/);

    // The chain never gained a second (refund) transaction from that refusal.
    const mempool = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempool).toHaveLength(1); // still just the Seller's own claim

    const secret = await h.buyerFlow.learnSecret();
    const claimed = await h.buyerFlow.claimLegB(secret);
    expect(claimed.receipt).toBeDefined();
  }, 120_000);
});

// P4-BTC-FIXES-R3.md K2: "Do the same for the Seller's claim, so a lost claim reply still lets
// the Seller post its reveal and receipt (and confirm the claim through the evidence reader)."
describe("K2 — a lost claim reply still lets the Seller post its reveal and receipt", () => {
  let node: BitcoindHandle;
  let config: BtcRailConfig;

  beforeAll(async () => {
    node = await startBitcoind();
    config = { pin: { ...BTC_REGTEST_PIN, finality: { confirmations: 2 } }, endpoint: node.endpoint };
  }, 120_000);

  afterAll(async () => {
    await node?.stop();
  });

  function ident(tag: number): Identity {
    return identity(tag.toString(16).padStart(2, "0").repeat(32));
  }

  it("a lost sendrawtransaction reply on the Seller's own claim is recovered on retry (K2's 'already known' success), and reveal/receipt post", async () => {
    const buyer = ident(125);
    const seller = ident(126);
    const t0 = await currentMediantimeMs(node);

    // A fetch that lets the Seller's OWN `sendrawtransaction` (the claim) genuinely reach the
    // node, but then throws before the caller ever sees the response — mirrors
    // client-flows-g.regtest.test.ts's own G3 flaky-transport probe, applied to a claim instead
    // of a funding.
    let brokenOnce = false;
    const flakyFetch: typeof fetch = async (url, init) => {
      let method = "";
      try {
        method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method ?? "";
      } catch {
        /* not JSON: let it through unmodified below */
      }
      const response = await fetch(url, init);
      if (method === "sendrawtransaction" && !brokenOnce) {
        brokenOnce = true;
        await response.arrayBuffer(); // let the real bytes land before "losing" them
        throw new Error("client-flows-k.regtest.test.ts: simulated lost read after the Seller's own claim broadcast (K2)");
      }
      return response;
    };

    const buyerParty: Party = { identity: buyer, rpc: node.createCapturingRpc() };
    const sellerParty: Party = { identity: seller, rpc: node.createCapturingRpc({ fetch: flakyFetch }) };
    const h = setupSwap(node, config, buyerParty, sellerParty, t0);

    await pairAndVerify("00000125", buyer, h, t0, node);
    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(2);

    // The claim genuinely reaches the node, but this flow's own `claimLegA` never sees a
    // successful return — no reveal/receipt frame is posted yet.
    await expect(h.sellerFlow.claimLegA(lockA.hashLock)).rejects.toThrow(/simulated lost read after the Seller's own claim broadcast/);

    const mempool = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempool).toHaveLength(1); // the claim really did land, just unseen by this flow

    // K2: retrying `claimLegA` rebuilds the IDENTICAL, deterministic claim transaction; Core's own
    // "txn-already-known" answer is now recognized as success (rather than a fresh failure), so
    // this reports the SAME txid and — for the first time — posts the reveal and receipt frames.
    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(claimed.reveal).toBeDefined();
    expect(claimed.receipt).toBeDefined();

    // Never a second, separately-broadcast claim transaction.
    const mempoolAfter = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempoolAfter).toEqual(mempool);

    // The evidence reader itself confirms the claim once mined — the money side of this, not
    // merely the two frames.
    await h.mineBlocks(2);
    const secret = await h.buyerFlow.learnSecret();
    expect(secret).toBe(h.sellerLock.preimage);
  }, 120_000);
});
