// SPDX-License-Identifier: MIT
//
// tests-regtest/client-flows-k.regtest.test.ts — P4-BTC-FIXES-R3.md K1 (and, appended
// alongside it, K2): the scenarios that need a real bitcoind mempool (a genuine, unmined
// broadcast) and so cannot be driven hermetically. K1: the Buyer's own learnSecret finds a claim
// that has been broadcast but never mined. Mirrors tests-regtest/client-flows-g.regtest.test.ts's
// own harness shape.
//
// Design source: flop-contrib/handoff/P4-BTC-FIXES-R3.md K1.

import { MemoryNoteStore, PaperRail } from "@flop-labs/tclk";
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
  const sellerFlow = new SellerFlow({ identity: seller.identity, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock });

  async function warpTo(nowMs: number): Promise<void> {
    clockRef.ms = nowMs;
    await node.setMockTime(Math.floor(nowMs / 1000) + 1);
    await node.mine(11);
  }
  async function mineBlocks(n: number): Promise<void> {
    await node.mine(n);
  }

  return { clockRef, clock, venue, noteStore, buyerFlow, sellerFlow, buyerRail, sellerRail, warpTo, mineBlocks };
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

describe("K1 — a pending (unmined) claim, on a real bitcoind mempool", () => {
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
    expect(secret).toBe((h.sellerFlow as unknown as { hashLock: { preimage: string } }).hashLock.preimage);

    // And the secret genuinely settles leg B (SPEC's own promise: a learned secret always works).
    const claimed = await h.buyerFlow.claimLegB(secret);
    expect(claimed.receipt).toBeDefined();
  }, 120_000);
});
