// SPDX-License-Identifier: MIT
//
// R2-17 (P8-FIXES-R2.md, decision 7): after a `never-landed` answer and before the saved lock handle is replaced by a fresh
// `prepareLock`, the Buyer reads the lock by its ref once more, after a short delay on the rail's own injected sleep. `never-landed` is
// proven only against a consistent node: a lagging member of a load-balanced endpoint can call a lock dead that landed elsewhere (NEAR's
// `Expired` is also nearcore's answer for a base block hash it does not know). A lock found by the second read is recorded as landed
// and nothing new is signed; before the fix the flow replaced the handle, signed and sent a second lock (which the contract refuses as a
// duplicate: a stall and a refund, never a double lock, but the original was never announced and the swap was lost to the Seller).
//
// The real BuyerFlow and SellerFlow over the real NEAR rail over the stateful NEAR RPC simulator (tests/helpers/near-stateful-rpc.ts).
// The lagging read: the node hides the lock transaction by hash (`txStatusUnknown`) and creates the lock row only several blocks after
// the lock was included (`lockRowDelayBlocks`), so the rail's own three-block look still shows nothing and answers never-landed; the
// rail's injected sleep (`settleDelay`) then lets the simulated chain move on and the second read finds the row.

import { MemoryNoteStore, PaperRail, dealRoom, generateHashLock, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow, type BuyerFlowOptions } from "../src/client/buyer.js";
import { decodeFlowRecord, type BuyerFlowRecord } from "../src/client/flow-record.js";
import { MemoryFlowStore, flowKey } from "../src/client/flow-store.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { decodeSignedTransactionHeader } from "../src/rails/near-borsh.js";
import { NEAR_LOCK_REREAD_DELAY_MS } from "../src/rails/near-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { identity, type Identity } from "./helpers/identity.js";
import { BUYER_ACCOUNT, CONTRACT, HTLC_CODE_HASH, SELLER_ACCOUNT, StatefulNearRpc, USDC, fetchFor, nearConfig } from "./helpers/near-stateful-rpc.js";
import { ProcessDied, crashRail, resumeBuyer } from "./helpers/resume-flows.js";

const T0 = 1_700_000_000_000;
const ident = (tag: number): Identity => identity(tag.toString(16).padStart(2, "0").repeat(32));
const lockTimeMs = T0 + 30 * 60_000;
const legA = { claimByMs: lockTimeMs + 5 * 60_000, refundAfterMs: lockTimeMs + 6 * 60 * 60_000, expiresMs: T0 + 10 * 60_000 };
const legB = { claimByMs: T0 + 12 * 60 * 60_000, refundAfterMs: T0 + 24 * 60 * 60_000, expiresMs: T0 + 60 * 60_000 };

/** How many blocks the simulated chain moves on while the rail waits its `settleDelay`: enough for a delayed lock row to appear. */
const SETTLE_BLOCKS = 10;

function harness() {
  const node = new StatefulNearRpc(CONTRACT, USDC, HTLC_CODE_HASH, T0);
  const config = nearConfig();
  const clockRef = { ms: T0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const sleeps: number[] = [];
  // the rail's injected sleep: every wait moves the simulated chain on; the rail's `settleDelay` (the long one) moves it a lot
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    node.advanceBlocks(ms >= NEAR_LOCK_REREAD_DELAY_MS ? SETTLE_BLOCKS : 1);
  };
  const buyerSigner = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(11));
  const sellerSigner = InMemoryNearSigner.generate(SELLER_ACCOUNT, new Uint8Array(32).fill(22));
  const base = fetchFor(node);
  const rail = (signer: InMemoryNearSigner) => () => createNearCounterRail({ config, rpc: new CapturingRpc({ endpoint: config.endpoint, fetch: base, clock }), signer, clock: () => node.nowMs, sleep });
  const buyerRail = rail(buyerSigner);
  const buyerStore = new MemoryFlowStore();
  const buyerOptions: BuyerFlowOptions = { identity: ident(1), venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail(), clock, store: buyerStore };
  const sellerLock = generateHashLock();
  const sellerFlow = new SellerFlow({ identity: ident(2), venue, paperRail: new PaperRail(noteStore, clock), rail: rail(sellerSigner)(), clock, store: new MemoryFlowStore(), mintHashLock: () => sellerLock });
  return { node, venue, buyerOptions, buyerStore, buyerFlow: new BuyerFlow(buyerOptions), buyerRail, sellerFlow, sleeps, swapId: computeSwapId(ident(1).did, "00000001") };
}
type Harness = ReturnType<typeof harness>;

async function toLines(h: Harness) {
  h.node.registerStorage(BUYER_ACCOUNT);
  h.node.registerStorage(SELLER_ACCOUNT);
  const offerA = await h.buyerFlow.bid({ swapId: h.swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legA });
  const accepted = await h.sellerFlow.acceptLegA(offerA, legB, lockTimeMs);
  const { acceptBRecord } = await h.buyerFlow.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, lockTimeMs);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
  await h.buyerFlow.postAccountLineA(BUYER_ACCOUNT);
  return { contractA: accepted.acceptA.contract, statement: accepted.acceptA.statement };
}

async function restart(h: Harness, extra: Partial<BuyerFlowOptions> = {}) {
  return resumeBuyer({ ...h.buyerOptions, rail: h.buyerRail() }, h.buyerStore, h.swapId, extra);
}

const buyerRecord = async (h: Harness): Promise<BuyerFlowRecord> => {
  const key = flowKey("buyer", h.swapId);
  return decodeFlowRecord((await h.buyerStore.load(key))!, key) as BuyerFlowRecord;
};

describe("R2-17 (NEAR): a lock that landed behind a lagging read is found by the second read, not replaced", () => {
  it("the node hides the transaction and creates the row late: the rail says never-landed, the second read finds the lock, it is recorded as landed and NOTHING new is sent", async () => {
    const h = harness();
    const p = await toLines(h);
    h.node.lockRowDelayBlocks = 8; // the row appears 8 blocks after the lock was included: later than the rail's own three-block look
    h.node.dropNextSendTxReply = true; // the lock lands, its reply is lost
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow();
    h.node.txStatusUnknown = true; // a lagging member: it does not know the transaction by hash either
    expect(h.node.lockSendTxCalls).toBe(1);

    const resumed = await restart(h);
    expect(resumed.next).toBe("lockLegA");
    const sleepsBefore = h.sleeps.length;
    const locked = await resumed.flow.lockLegA();
    expect(locked.writeEvidence.ref).toBe(`${p.statement}:${BUYER_ACCOUNT}`);
    expect(h.sleeps.slice(sleepsBefore), "the rail's settleDelay ran between the never-landed answer and the second read").toContain(NEAR_LOCK_REREAD_DELAY_MS);

    // nothing was signed or sent after the first lock: no replacement of the saved handle, no second lock transaction
    expect(h.node.lockSendTxCalls).toBe(1);
    expect(h.node.lockRowsCreated).toBe(1);
    expect(h.node.sendTxReceived).toBe(1);
    const record = await buyerRecord(h);
    expect(record.lock.evidence?.ref).toBe(`${p.statement}:${BUYER_ACCOUNT}`);
    expect(record.lock.framePosted, "the lock is announced").toBe(true);
    const room = await h.venue.read(dealRoom(p.contractA));
    expect(room.filter((r) => tryDecodeFrame(r.line)?.type === "lock")).toHaveLength(1);
    expect((await restart(h)).next).toBe("learnSecret");
  });

  it("control: a lock that truly never landed (another transaction took the nonce) is still replaced by exactly ONE fresh lock, after the same second read finds nothing", async () => {
    const h = harness();
    await toLines(h);
    const dying = await restart(h, { rail: crashRail(h.buyerRail(), { before: ["commitLock"] }) });
    await expect(dying.flow.lockLegA()).rejects.toBeInstanceOf(ProcessDied); // signed and saved, never sent
    expect(h.node.sendTxReceived).toBe(0);
    const recovery = (await buyerRecord(h)).lock.prepared?.recovery;
    if (recovery?.chain !== "near") throw new Error("test: expected a near handle");
    h.node.consumeNonce(BUYER_ACCOUNT, Number(decodeSignedTransactionHeader(Uint8Array.from(Buffer.from(recovery.signedTxBase64, "base64"))).nonce));

    const resumed = await restart(h);
    const sleepsBefore = h.sleeps.length;
    await resumed.flow.lockLegA();
    expect(h.sleeps.slice(sleepsBefore)).toContain(NEAR_LOCK_REREAD_DELAY_MS); // the second read happened, and found nothing
    expect(h.node.lockSendTxCalls, "one fresh lock, the first was never sent").toBe(1);
    expect(h.node.lockRowsCreated).toBe(1);
    expect((await buyerRecord(h)).lock.framePosted).toBe(true);
  });
});
