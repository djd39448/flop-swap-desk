// SPDX-License-Identifier: MIT
//
// tests-regtest/claim-mined.regtest.test.ts: P10 B7 (P8 checkpoint decision 7) on a real bitcoind regtest node: a Bitcoin Seller claim counts as LANDED only once it is
// mined. The reason it exists: a claim seen only in the mempool has already shown the preimage; if the Seller stopped and the claim were dropped, the Buyer could learn
// the secret, claim leg B and refund leg A after its refund time, and the Seller would lose leg A. What is proven here from the wire, with the restarted process's own
// transport counting every JSON-RPC call it makes (a wallet signing call, a `testmempoolaccept`, a `sendrawtransaction`), not from the flow's report:
//
//   1  a claim that is broadcast and NOT mined leaves the Seller at its claim step (`ClaimNotMinedError`, `next` is `claimLegA`, the reveal is posted, no receipt, the claim's
//      txid and exact bytes are in the stored record from before the send), and the claim sits in the node's mempool; one block settles it as before
//   2  a restarted Seller whose claim is still in the mempool signs, tests and sends NOTHING (the node holds it); a block later it settles
//   3  a claim that left the mempool unmined (a real eviction, `-mempoolexpiry=1`) is sent again as the SAME bytes by a restarted process, also after the claim-by: the new
//      process makes no wallet signing call, one `testmempoolaccept` and one `sendrawtransaction` carrying exactly the recorded bytes, the mempool holds the same txid again,
//      and a block settles the swap (the Buyer takes leg B with the secret)
//   4  a funding output spent by another transaction (the Buyer's refund, after the claim dropped) is NOT re-sent: `ClaimSupersededError`, nothing sent, no claim in the mempool
// `npm run test:regtest` only; `npm test` never spawns bitcoind.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryNoteStore, PaperRail, dealRoom, generateHashLock, tryDecodeFrame, verifyHashPreimage } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { decodeFlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import { FileFlowStore, type FlowStore } from "../src/client/flow-store.js";
import { ClaimNotMinedError, ClaimSupersededError, SellerFlow, type SellerFlowOptions } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { BTC_REGTEST_PIN, keyFromAddressInfo, type BtcRailConfig, type BtcSignerKey } from "../src/rails/btc-htlc.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { countingFetch, RecordingStore, type CountingFetch } from "../tests/helpers/live-resume.js";
import { startBitcoind, type BitcoindHandle, type RegtestWallet } from "./helpers/bitcoind.js";
import { claimBroadcast } from "./helpers/claim.js";

const scratch: string[] = [];
let scenarioCount = 0;

function keyFor(wallet: RegtestWallet): BtcSignerKey {
  return keyFromAddressInfo({ pubkey: wallet.pubkey, hdmasterfingerprint: wallet.hdMasterFingerprint, hdkeypath: wallet.hdKeyPath });
}

const ident = (tag: number): Identity => identity(tag.toString(16).padStart(2, "0").repeat(32));

/** A 5 hour refund window on leg A with the claim-by 3 hours in, as tests-regtest/client-flows-g uses. */
const legADeadlines = (t0: number) => ({ claimByMs: t0 + 3 * 60 * 60_000, refundAfterMs: t0 + 5 * 60 * 60_000, expiresMs: t0 + 30 * 60_000 });
const legBDeadlines = (t0: number) => ({ claimByMs: t0 + 9 * 60 * 60_000, refundAfterMs: t0 + 20 * 60 * 60_000, expiresMs: t0 + 40 * 60_000 });

async function currentMediantimeMs(node: BitcoindHandle): Promise<number> {
  const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
  return info.mediantime * 1000;
}

/** One swap's world on `node`: the venue and notes, a Buyer (no store), and a Seller whose record lives in a FileFlowStore directory, so a fresh process can resume it. */
async function buildSwap(node: BitcoindHandle, config: BtcRailConfig) {
  scenarioCount += 1;
  const buyer = ident(150 + scenarioCount * 2);
  const seller = ident(151 + scenarioCount * 2);
  const t0 = await currentMediantimeMs(node);
  const clockRef = { ms: t0 };
  const clock = (): number => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const dir = await mkdtemp(join(tmpdir(), "flop-claim-mined-"));
  scratch.push(dir);
  const sellerStore = new RecordingStore(new FileFlowStore(dir));
  const sellerLock = generateHashLock();

  const buyerRail = createBtcCounterRail({ config, rpc: node.createCapturingRpc(), wallet: node.buyer.wallet, key: keyFor(node.buyer), destinationAddress: node.buyer.address, clock });
  const buyerFlow = new BuyerFlow({ identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail, clock });

  /** A Seller process: its own transport (`calls` counts what it sent) and rail, over the shared venue, notes, clock and store directory. */
  function sellerProc(): { calls: CountingFetch; options: SellerFlowOptions & { store: FlowStore } } {
    const calls = countingFetch();
    const rail = createBtcCounterRail({
      config,
      rpc: node.createCapturingRpc({ fetch: calls.fetch }),
      wallet: node.seller.wallet,
      key: keyFor(node.seller),
      destinationAddress: node.seller.address,
      clock,
    });
    return { calls, options: { identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail, clock, store: sellerStore, mintHashLock: () => sellerLock } };
  }

  async function pairAndLock() {
    const first = sellerProc();
    const sellerFlow = new SellerFlow(first.options);
    const swapId = computeSwapId(buyer.did, `0000a${scenarioCount.toString(16).padStart(3, "0")}`);
    const offerA = await buyerFlow.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "BTC", ...legADeadlines(t0) });
    const { acceptA, acceptARecord, offerBRecord } = await sellerFlow.acceptLegA(offerA, legBDeadlines(t0), t0);
    const { acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, t0);
    await sellerFlow.lockLegB(acceptBRecord);
    await buyerFlow.verifyLegBLocked();
    await sellerFlow.postAccountLineA(node.seller.pubkey.toLowerCase());
    await buyerFlow.postAccountLineA(node.buyer.pubkey.toLowerCase());
    const lockA = await buyerFlow.lockLegA();
    await node.mine(2); // the funding's own confirmations (this file's N is 2), needed for the first claim's verifyLockFinal
    return { sellerFlow, first, swapId, offerA, acceptA, lockA, statement: acceptA.statement };
  }

  /** A restarted Seller process, resumed from the store directory alone. */
  async function restartSeller(swapId: string, contractA: string) {
    const proc = sellerProc();
    const resumed = await SellerFlow.resume({ ...proc.options, swapId, contractA });
    return { ...resumed, calls: proc.calls };
  }

  async function sellerRecord(contractA: string): Promise<SellerFlowRecord> {
    const key = `seller:${contractA}`;
    const bytes = await sellerStore.load(key);
    if (bytes === null) throw new Error("test: no Seller record");
    const record = decodeFlowRecord(bytes, key);
    if (record.role !== "seller") throw new Error("test: not a Seller record");
    return record;
  }

  const frames = async (contractA: string, type: string): Promise<number> => (await venue.read(dealRoom(contractA))).filter((record) => tryDecodeFrame(record.line)?.type === type && record.sender === seller.did).length;

  return { t0, clockRef, venue, buyerFlow, sellerLock, sellerStore, pairAndLock, restartSeller, sellerRecord, frames, seller };
}

const mempoolOf = (node: BitcoindHandle): Promise<string[]> => node.rpcCall<string[]>("getrawmempool", []);
const signingCalls = (calls: CountingFetch): number => calls.count("walletprocesspsbt") + calls.count("walletcreatefundedpsbt");

describe("P10 B7 on bitcoind regtest: a claim is landed only once it is mined", () => {
  let node: BitcoindHandle;
  let config: BtcRailConfig;
  beforeAll(async () => {
    node = await startBitcoind();
    config = { pin: { ...BTC_REGTEST_PIN, finality: { confirmations: 2 } }, endpoint: node.endpoint };
  }, 120_000);
  afterAll(async () => {
    await node?.stop();
    if (process.env.KEEP_REGTEST_BUNDLES !== "1") await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("1: broadcast and not mined: the Seller stays at its claim step, the claim is in the mempool and in the record from before the send; a block settles it", async () => {
    const w = await buildSwap(node, config);
    const { sellerFlow, acceptA, statement, swapId } = await w.pairAndLock();

    const pending = await claimBroadcast(sellerFlow, statement);
    expect(pending).toBeInstanceOf(ClaimNotMinedError);
    const mempool = await mempoolOf(node);
    expect(mempool).toHaveLength(1);
    expect(mempool[0]).toBe(pending.txid); // the claim really is only in the node's mempool

    const record = await w.sellerRecord(acceptA.contract);
    expect(record.claimOutcome).toBe("none"); // not landed
    expect(record.claimTx?.txid).toBe(pending.txid);
    expect(record.claimTx?.sent).toBe(true);
    const raw = await node.rpcCall<string>("getrawtransaction", [pending.txid as string, false]);
    expect(record.claimTx?.rawTx).toBe(raw); // the saved bytes are exactly the claim the node holds
    expect(await w.frames(acceptA.contract, "reveal")).toBe(1);
    expect(await w.frames(acceptA.contract, "receipt")).toBe(0);
    expect((await w.restartSeller(swapId, acceptA.contract)).next).toBe("claimLegA");

    await node.mine(1);
    const claimed = await sellerFlow.claimLegA(statement);
    expect(claimed.receipt).toBeDefined();
    expect(claimed.evidence.txid).toBe(pending.txid);
    expect((await w.sellerRecord(acceptA.contract)).claimOutcome).toBe("landed");
    expect(await w.frames(acceptA.contract, "receipt")).toBe(1);
    expect((await w.restartSeller(swapId, acceptA.contract)).next).toBe("done");
    expect(await mempoolOf(node)).toEqual([]);
  }, 120_000);

  it("2: a restarted Seller whose claim is still in the mempool signs, tests and sends nothing; a block later it settles", async () => {
    const w = await buildSwap(node, config);
    const { sellerFlow, acceptA, statement, swapId } = await w.pairAndLock();
    const pending = await claimBroadcast(sellerFlow, statement);
    const mempoolBefore = await mempoolOf(node);

    const restarted = await w.restartSeller(swapId, acceptA.contract);
    expect(restarted.next).toBe("claimLegA");
    const again = await restarted.flow.claimLegA(statement).then(() => undefined, (error: unknown) => error);
    expect(again).toBeInstanceOf(ClaimNotMinedError);
    expect((again as ClaimNotMinedError).txid).toBe(pending.txid);
    expect(signingCalls(restarted.calls), "the wallet signed nothing").toBe(0);
    expect(restarted.calls.count("testmempoolaccept")).toBe(0);
    expect(restarted.calls.count("sendrawtransaction")).toBe(0);
    expect(await mempoolOf(node)).toEqual(mempoolBefore);
    expect(await w.frames(acceptA.contract, "reveal")).toBe(1); // still just the one

    await node.mine(1);
    const claimed = await restarted.flow.claimLegA(statement);
    expect(claimed.receipt).toBeDefined();
    expect(restarted.calls.count("sendrawtransaction")).toBe(0);
    expect(await w.frames(acceptA.contract, "receipt")).toBe(1);
  }, 120_000);

  it("the Buyer still learns the secret from the unmined claim (nothing on the Buyer's path changed): the mempool is read, no block, no reveal frame", async () => {
    const w = await buildSwap(node, config);
    const { sellerFlow, statement } = await w.pairAndLock();
    await claimBroadcast(sellerFlow, statement, { skipReveal: true });
    expect(await mempoolOf(node)).toHaveLength(1);
    const secret = await w.buyerFlow.learnSecret();
    expect(verifyHashPreimage(statement, secret)).toBe(true);
    expect(secret).toBe(w.sellerLock.preimage);
    await w.buyerFlow.claimLegB(secret);
    await node.mine(1);
    await sellerFlow.claimLegA(statement, { skipReveal: true }); // the Seller's claim settles too
  }, 120_000);

  it("a first claim keeps its guards: past the claim-by nothing is signed, recorded or sent", async () => {
    const w = await buildSwap(node, config);
    const { sellerFlow, offerA, statement, acceptA, first } = await w.pairAndLock();
    const signedBefore = first.calls.count("walletprocesspsbt"); // the Seller's BIP-322 account proof is one signing call already
    w.clockRef.ms = offerA.claimByMs + 60_000;
    await expect(sellerFlow.claimLegA(statement)).rejects.toThrow(/at\/after its claimByMs/);
    expect(first.calls.count("walletprocesspsbt")).toBe(signedBefore);
    expect(first.calls.count("sendrawtransaction")).toBe(0);
    expect((await w.sellerRecord(acceptA.contract)).claimTx).toBeUndefined();
    expect(await mempoolOf(node)).toEqual([]);
  }, 120_000);
});

// A real mempool eviction needs its own node (`-mempoolexpiry=1`, as client-flows-g's R2-1 does).
describe("P10 B7 on bitcoind regtest: a claim the node dropped is sent again as the same bytes, and a spent funding output is not", () => {
  let node: BitcoindHandle;
  let config: BtcRailConfig;
  beforeAll(async () => {
    node = await startBitcoind({ extraArgs: ["-mempoolexpiry=1"] });
    config = { pin: { ...BTC_REGTEST_PIN, finality: { confirmations: 2 } }, endpoint: node.endpoint };
  }, 120_000);
  afterAll(async () => {
    await node?.stop();
    if (process.env.KEEP_REGTEST_BUNDLES !== "1") await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // Mock time only moves forward here; every move goes through setNodeTime, so the latest one is known.
  let lastMockSeconds = 0;
  async function setNodeTime(seconds: number): Promise<void> {
    lastMockSeconds = Math.max(lastMockSeconds, seconds);
    await node.setMockTime(lastMockSeconds);
  }

  /** Mock time moves two hours past the node's one-hour expiry and one unrelated transaction is submitted: bitcoind sweeps expired entries when it accepts a new one. */
  async function expireMempool(): Promise<void> {
    const info = await node.rpcCall<{ time: number; mediantime: number }>("getblockchaininfo", []);
    await setNodeTime(Math.max(info.time, info.mediantime, lastMockSeconds) + 2 * 60 * 60);
    await node.rpcCall("sendtoaddress", [node.seller.address, 0.0001], `/wallet/${node.buyer.wallet}`);
  }

  it("3: evicted unmined, then re-sent by a restarted process past the claim-by: the SAME bytes, no signing, one test, one send; a block settles the swap", async () => {
    const w = await buildSwap(node, config);
    const { sellerFlow, offerA, acceptA, statement, swapId } = await w.pairAndLock();
    const pending = await claimBroadcast(sellerFlow, statement);
    const txid = pending.txid as string;
    const recorded = (await w.sellerRecord(acceptA.contract)).claimTx;
    expect(recorded?.txid).toBe(txid);

    await expireMempool();
    expect(await mempoolOf(node)).not.toContain(txid); // the premise: the node dropped the claim
    const [fundTxid, fundVout] = (await w.sellerRecord(acceptA.contract)).frozenLegARailRef!.split(":");
    expect(await node.rpcCall("gettxout", [fundTxid, Number(fundVout), true])).not.toBeNull(); // and the funding output is unspent

    w.clockRef.ms = offerA.claimByMs + 60 * 60_000; // past the claim-by: the first-claim guard would refuse a NEW claim now
    const restarted = await w.restartSeller(swapId, acceptA.contract);
    expect(restarted.next).toBe("claimLegA");
    const outcome = await restarted.flow.claimLegA(statement).then(() => undefined, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(ClaimNotMinedError); // back in the mempool, not mined
    expect((outcome as ClaimNotMinedError).txid).toBe(txid);
    expect(signingCalls(restarted.calls), "no new claim was signed or built").toBe(0);
    expect(restarted.calls.count("testmempoolaccept")).toBe(1);
    expect(restarted.calls.count("sendrawtransaction")).toBe(1);
    const send = restarted.calls.requests.find((call) => call.method === "sendrawtransaction");
    expect((send?.params as string[])[0]).toBe(recorded?.rawTx); // the identical recorded bytes
    expect(await mempoolOf(node)).toContain(txid); // the same txid again
    const spender = await node.rpcCall<Array<{ spendingtxid?: string }>>("gettxspendingprevout", [[{ txid: fundTxid, vout: Number(fundVout) }]]);
    expect(spender[0]?.spendingtxid).toBe(txid); // and it is what spends the funding output

    await node.mine(1);
    const claimed = await restarted.flow.claimLegA(statement);
    expect(claimed.receipt).toBeDefined();
    expect((await w.sellerRecord(acceptA.contract)).claimOutcome).toBe("landed");
    expect(restarted.calls.count("sendrawtransaction")).toBe(1); // still just the one re-send

    // and the swap settles: the Buyer learns the secret (from the reveal frame, and the chain) and takes leg B
    const secret = await w.buyerFlow.learnSecret();
    expect(secret).toBe(w.sellerLock.preimage);
    await w.buyerFlow.claimLegB(secret);
  }, 180_000);

  it("4: the funding output was spent by another transaction (the Buyer's refund, once the claim dropped): not re-sent, ClaimSupersededError, no claim in the mempool", async () => {
    const w = await buildSwap(node, config);
    const { sellerFlow, offerA, acceptA, statement, swapId } = await w.pairAndLock();
    const pending = await claimBroadcast(sellerFlow, statement);
    const txid = pending.txid as string;

    await expireMempool();
    expect(await mempoolOf(node)).not.toContain(txid);

    // leg A's refund time comes (the chain's median time passes it) and the Buyer's own flow refunds the output
    const refundAtMs = offerA.refundAfterMs + 5 * 60_000;
    w.clockRef.ms = refundAtMs;
    await setNodeTime(Math.floor(refundAtMs / 1000) + 1);
    await node.mine(11);
    await expect(w.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/); // broadcast, awaiting its confirmations
    await node.mine(2);
    const refunded = await w.buyerFlow.refundLegA();
    expect(refunded.ref).toBe((await w.sellerRecord(acceptA.contract)).frozenLegARailRef);

    const restarted = await w.restartSeller(swapId, acceptA.contract);
    const outcome = await restarted.flow.claimLegA(statement).then(() => undefined, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(ClaimSupersededError);
    expect((outcome as ClaimSupersededError).sent).toBe(true);
    expect(restarted.calls.count("sendrawtransaction")).toBe(0);
    expect(restarted.calls.count("testmempoolaccept")).toBe(0);
    expect(signingCalls(restarted.calls)).toBe(0);
    expect(await mempoolOf(node)).not.toContain(txid);
    expect((await w.sellerRecord(acceptA.contract)).claimOutcome).toBe("none"); // never counted as landed
    expect(await w.frames(acceptA.contract, "receipt")).toBe(0);
  }, 180_000);
});
