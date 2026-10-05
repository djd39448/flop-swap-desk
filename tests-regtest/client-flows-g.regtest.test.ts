// SPDX-License-Identifier: MIT
//
// tests-regtest/client-flows-g.regtest.test.ts — P4-BTC-FIXES.md Group G, the scenarios that
// need a real bitcoind wallet's own PSBT signing (P4-BTC-SPEC.md §1: keyless — this build never
// holds a key of its own) and so cannot be driven hermetically: G1 (freeze the keys/script at
// funding; a pubkey line posted afterward neither helps nor hinders), G2 (one funding per swap,
// confirmed against the live chain), G3 (record before sending: a broadcast whose own response
// is lost still lets the Buyer recover), G4 (the Buyer reads a Bitcoin reveal by its outpoint
// ref, with no block mined), and G8 (the Seller's claim uses the lock the tclk machine actually
// accepted, never the first authenticated-looking payer frame). Mirrors
// tests-regtest/client-flows.regtest.test.ts's own harness shape; the three canonical fixtures
// (settled/refunded/refunded-b) live there, not here — nothing in this file writes a bundle.
//
// Design source: flop-contrib/handoff/P4-BTC-FIXES.md G1, G2, G3, G4, G8, G9.

import { MemoryNoteStore, PaperRail, dealRoom, encodeFrame, generateHashLock, tryDecodeFrame, verifyTranscriptRecord } from "@flop-labs/tclk";
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

/** Leg A: a 5-hour refundAfterMs from `t0`, mirroring client-flows.regtest.test.ts's own sizing —
 *  comfortably clears BTC_LOCAL_POLICY's 60-minute numbers with room for the ~1h MTP lag. */
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

describe("Group G — Bitcoin client-flow fixes that need a real bitcoind wallet", () => {
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

  describe("G1 — freeze the keys/script at funding; a later pubkey line neither helps nor hinders", () => {
    it("a second Seller pubkey line posted after funding does not block the Buyer's refund", async () => {
      const buyer = ident(101);
      const seller = ident(102);
      const t0 = await currentMediantimeMs(node);
      const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

      const { offerA, acceptA } = await pairAndVerify("00000101", buyer, h, t0, node);
      const lockA = await h.buyerFlow.lockLegA();
      await h.mineBlocks(2);

      // The reviewer's probe: a second, conflicting pubkey line for the Seller (payee), posted
      // AFTER the Buyer already funded. Before G1, the Buyer's own `refundLegA` re-read the deal
      // room and re-resolved accounts, so this conflicting pair would make the payee's own pubkey
      // unresolved and block the refund entirely.
      const otherPayeePubkey = `03${"ee".repeat(32)}`;
      await h.venue.post(dealRoom(acceptA.contract), h.sellerRail.formatAccountLine(otherPayeePubkey), seller);

      await h.warpTo(offerA.refundAfterMs + 5 * 60_000);
      await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);
      await h.mineBlocks(2);
      const refundA = await h.buyerFlow.refundLegA();
      expect(refundA.ref).toBe(lockA.writeEvidence.ref);
    }, 120_000);

    it("a second Buyer pubkey line posted after funding does not block the Seller's claim", async () => {
      const buyer = ident(103);
      const seller = ident(104);
      const t0 = await currentMediantimeMs(node);
      const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

      const { acceptA } = await pairAndVerify("00000102", buyer, h, t0, node);
      const lockA = await h.buyerFlow.lockLegA();
      await h.mineBlocks(2);

      // A second, conflicting pubkey line for the Buyer (payer), posted after funding — before
      // G1, the Seller's own `claimLegA` re-read the room fresh each time and would find the
      // payer's own pubkey unresolved (a conflict), refusing the claim.
      const otherPayerPubkey = `02${"cc".repeat(32)}`;
      await h.venue.post(dealRoom(acceptA.contract), h.buyerRail.formatAccountLine(otherPayerPubkey), buyer);

      const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
      expect(claimed.evidence.ref).toBe(lockA.writeEvidence.ref);
    }, 120_000);
  });

  describe("G2 — one funding per swap", () => {
    it("a second lockLegA call throws, and the chain holds exactly one HTLC output", async () => {
      const buyer = ident(105);
      const seller = ident(106);
      const t0 = await currentMediantimeMs(node);
      const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

      await pairAndVerify("00000103", buyer, h, t0, node);
      const lockA = await h.buyerFlow.lockLegA();

      const [txid, voutStr] = lockA.writeEvidence.ref.split(":");
      const funded = await node.rpcCall<{ value: number } | null>("gettxout", [txid, Number(voutStr), true]);
      expect(funded).not.toBeNull();
      expect(funded?.value).toBeCloseTo(0.01, 6); // 1,000,000 sats

      await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/already attempted, or a lock is already in flight \(G2\)/);

      // Still exactly the one funding output — a second attempt never reached the network.
      const stillFunded = await node.rpcCall<{ value: number } | null>("gettxout", [txid, Number(voutStr), true]);
      expect(stillFunded?.value).toBe(funded?.value);

      const reconciled = await h.buyerFlow.reconcileLockA();
      expect(reconciled.locked).toBe(false); // only 0 confirmations so far — not yet a final observation
      await h.mineBlocks(2);
      const reconciledAfterMining = await h.buyerFlow.reconcileLockA();
      expect(reconciledAfterMining.locked).toBe(true);
    }, 120_000);
  });

  describe("G3 — record before sending (client half of H2)", () => {
    it("a lost read right after a genuine broadcast still lets the Buyer refund from the recorded outpoint", async () => {
      const buyer = ident(107);
      const seller = ident(108);
      const t0 = await currentMediantimeMs(node);

      // A fetch that lets `sendrawtransaction` genuinely reach the node (so the funding really
      // broadcasts) but then throws before the caller ever sees the response — the reviewer's
      // "flaky-transport probe (a lost read after broadcast)".
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
          throw new Error("client-flows-g.regtest.test.ts: simulated lost read after broadcast (G3)");
        }
        return response;
      };

      const buyerParty: Party = { identity: buyer, rpc: node.createCapturingRpc({ fetch: flakyFetch }) };
      const h = setupSwap(node, config, buyerParty, freshParty(seller), t0);

      const { offerA } = await pairAndVerify("00000104", buyer, h, t0, node);

      // The broadcast genuinely reaches the node, but this flow's own `lockLegA` never sees a
      // successful return.
      await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/simulated lost read after broadcast/);

      await h.mineBlocks(2);
      // G3: the outpoint was recorded (from `prepareLock`) BEFORE the broadcast ever ran — refund
      // works off it even though `lockLegA` itself never returned.
      await h.warpTo(offerA.refundAfterMs + 5 * 60_000);
      await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);
      await h.mineBlocks(2);
      const refundA = await h.buyerFlow.refundLegA();
      expect(refundA.txid).toMatch(/^[0-9a-f]{64}$/);
    }, 120_000);
  });

  describe("G4 — the Buyer reads the Bitcoin reveal", () => {
    it("learns the secret from the reveal frame alone, with no block mined for the claim yet", async () => {
      const buyer = ident(109);
      const seller = ident(110);
      const t0 = await currentMediantimeMs(node);
      const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

      await pairAndVerify("00000105", buyer, h, t0, node);
      const lockA = await h.buyerFlow.lockLegA();
      await h.mineBlocks(2); // the funding's own confirmations, needed for claimLegA's verifyLockFinal

      // Posts the real reveal frame (ref: the outpoint, per SellerFlow.claimLegA); deliberately
      // NO blocks are mined afterward, so `findClaimedPreimage`'s own bounded scan would find
      // nothing yet — the reveal frame is the ONLY way `learnSecret` can succeed here.
      await h.sellerFlow.claimLegA(lockA.hashLock);

      const secret = await h.buyerFlow.learnSecret();
      expect(secret).toBe(h.sellerLock.preimage);
    }, 120_000);
  });

  describe("G8 — the Seller claims using the lock the tclk machine actually accepted", () => {
    it("a rejected earlier lock-shaped frame (posted after the refund window, per its own record) never shadows the real, later, accepted lock", async () => {
      const buyer = ident(111);
      const seller = ident(112);
      const t0 = await currentMediantimeMs(node);
      const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

      const { offerA, acceptA } = await pairAndVerify("00000106", buyer, h, t0, node);

      // A bogus, but fully authenticated, "lock" frame from the Buyer — the ONLY thing
      // `findAuthenticatedLock` (the pre-G8 check) verifies. Posted with the clock pushed past
      // this leg's own refundAfterMs, so the tclk contract machine itself rejects it ("refund
      // window is already open") the moment anything folds this leg's transcript — exactly the
      // A6/G8 case: authenticated, but never actually accepted.
      const bogusRef = `${"00".repeat(32)}:0`;
      const realNowMs = h.clockRef.ms;
      h.clockRef.ms = offerA.refundAfterMs + 1;
      await h.venue.post(
        dealRoom(acceptA.contract),
        encodeFrame({ type: "lock", from: buyer.did, contract: acceptA.contract, rail: "btc-htlc", ref: bogusRef }),
        buyer,
      );
      h.clockRef.ms = realNowMs;

      // The real funding — posted (and, per the machine, accepted) AFTER the bogus one in room
      // order, at a time when the refund window genuinely was not yet open.
      const lockA = await h.buyerFlow.lockLegA();
      await h.mineBlocks(2);

      // Sanity: the pre-G8 lower-level check really would have picked the bogus frame first (it
      // is earlier in room order and satisfies every check `findAuthenticatedLock` makes).
      const dealRoomARecords = await h.venue.read(dealRoom(acceptA.contract));
      const firstLockFrame = dealRoomARecords
        .map((record) => ({ record, frame: tryDecodeFrame(record.line) }))
        .find(({ record, frame }) => verifyTranscriptRecord(record).ok && frame !== null && frame.type === "lock");
      expect(firstLockFrame?.frame && (firstLockFrame.frame as { ref: string }).ref).toBe(bogusRef);

      // G8: the Seller's own claim must still work, using the REAL outpoint.
      const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
      expect(claimed.evidence.ref).toBe(lockA.writeEvidence.ref);
      expect(claimed.evidence.ref).not.toBe(bogusRef);
    }, 120_000);
  });
});

// P4-BTC-FIXES-R2.md R2-1: a real mempool eviction needs its own node (`-mempoolexpiry=1`), so
// this gets a separate top-level describe with its own bitcoind rather than sharing Group G's.
describe("R2-1 — a refund that drops out of the mempool is re-sent, unchanged, on retry", () => {
  let node: BitcoindHandle;
  let config: BtcRailConfig;

  beforeAll(async () => {
    // A 1-hour mempool expiry — short enough to force a real eviction inside one test, rather
    // than waiting anywhere near Core's own 336-hour default.
    node = await startBitcoind({ extraArgs: ["-mempoolexpiry=1"] });
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

  it("re-broadcasts the SAME recorded refund bytes once they expire from the mempool, and the leg still refunds after mining", async () => {
    const buyer = ident(201);
    const seller = ident(202);
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

    const { offerA } = await pairAndVerify("00000201", buyer, h, t0, node);
    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(2);

    const refundAtMs = offerA.refundAfterMs + 5 * 60_000;
    await h.warpTo(refundAtMs); // sets mocktime + mines 11 so median-time-past itself passes T

    // 1st call: broadcasts the refund (a regtest node never auto-mines, so it stays unconfirmed).
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);

    const mempoolAfterBroadcast = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempoolAfterBroadcast).toHaveLength(1);
    const refundTxid = mempoolAfterBroadcast[0];
    expect(refundTxid).toMatch(/^[0-9a-f]{64}$/);

    // Advance real (mocked) time 2h past the refund's own entry time — past the node's 1-hour
    // mempoolexpiry — then submit one unrelated transaction: bitcoind sweeps expired mempool
    // entries opportunistically when accepting a new one, which is what actually evicts the
    // refund (mining would instead CONFIRM it, defeating the point of this test).
    const entryTimeSec = Math.floor(refundAtMs / 1000) + 1; // mirrors warpTo's own mocktime formula
    await node.setMockTime(entryTimeSec + 2 * 60 * 60);
    await node.rpcCall("sendtoaddress", [node.seller.address, 0.0001], `/wallet/${node.buyer.wallet}`);

    const mempoolAfterEvict = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempoolAfterEvict).not.toContain(refundTxid); // the premise this test is checking

    const [fundTxid, fundVoutStr] = lockA.writeEvidence.ref.split(":");
    const stillUnspent = await node.rpcCall<{ value: number } | null>("gettxout", [fundTxid, Number(fundVoutStr), true]);
    expect(stillUnspent).not.toBeNull(); // the HTLC output is still there, claimable by the Seller

    // 2nd call (retry): R2-1's own resend path re-checks the chain, finds the refund genuinely
    // dropped while the escrow remains unspent, and re-sends the IDENTICAL recorded bytes — still
    // unconfirmed (nothing mined since), so this still reports "not yet confirmed", exactly as a
    // retry that found the refund merely still pending would.
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);

    const mempoolAfterResend = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempoolAfterResend).toContain(refundTxid); // back in the mempool — same txid, same bytes

    // 3rd call: now confirmed — reports success, using the SAME txid throughout (never a new,
    // separately-signed refund transaction).
    await h.mineBlocks(2);
    const refundA = await h.buyerFlow.refundLegA();
    expect(refundA.txid).toBe(refundTxid);
  }, 120_000);
});
