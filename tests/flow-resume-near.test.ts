// SPDX-License-Identifier: MIT
//
// tests/flow-resume-near.test.ts - review round 1, the Buyer's NEAR paths at the FLOW level: the real BuyerFlow / SellerFlow with stores,
// over the real NEAR rail, over the stateful NEAR RPC simulator (tests/helpers/near-stateful-rpc.ts) that remembers every transaction,
// moves its blocks on demand and answers `send_tx` the way a real node does (`Expired`, invalid nonce).
//
//   R1-01 + R1-04  a lock that landed and was then claimed is recognised by the resumed lockLegA, whatever the clock says
//   R1-08          a refund that LANDED AND FAILED (the payout failed and the lock went back to Locked) is resolved: one fresh refund follows
//   R1-10          a refund signed and saved but never sent: the identical bytes are sent after the restart and land; once the node calls
//                  them Expired, exactly one fresh refund lands; while the node cannot be reached the call says it is not confirmed and
//                  that the refund may never have been sent

import { MemoryNoteStore, PaperRail, generateHashLock } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow, type BuyerFlowOptions } from "../src/client/buyer.js";
import { MemoryFlowStore } from "../src/client/flow-store.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { identity, type Identity } from "./helpers/identity.js";
import { BUYER_ACCOUNT, CONTRACT, HTLC_CODE_HASH, SELLER_ACCOUNT, StatefulNearRpc, USDC, fetchFor, nearConfig } from "./helpers/near-stateful-rpc.js";
import { ProcessDied, crashRail, resumeBuyer } from "./helpers/resume-flows.js";

const T0 = 1_700_000_000_000;
const ident = (tag: number): Identity => identity(tag.toString(16).padStart(2, "0").repeat(32));
const lockTimeMs = T0 + 30 * 60_000;
const legA = { claimByMs: lockTimeMs + 5 * 60_000, refundAfterMs: lockTimeMs + 6 * 60 * 60_000, expiresMs: T0 + 10 * 60_000 };
const legB = { claimByMs: T0 + 12 * 60 * 60_000, refundAfterMs: T0 + 24 * 60 * 60_000, expiresMs: T0 + 60 * 60_000 };

function harness() {
  const node = new StatefulNearRpc(CONTRACT, USDC, HTLC_CODE_HASH, T0);
  const config = nearConfig();
  const clockRef = { ms: T0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const net = { failSend: false };
  const base = fetchFor(node);
  const buyerFetch = (async (url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { method: string };
    if (net.failSend && parsed.method === "send_tx") throw new Error("connection reset (test: the send never reached the node)");
    return base(url as string, init);
  }) as typeof fetch;
  // the rail's three-block wait (R1-19) uses this sleep: the simulated chain moves on by one block per poll
  const sleep = async (): Promise<void> => node.advanceBlocks(1);
  const buyerSigner = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(11));
  const sellerSigner = InMemoryNearSigner.generate(SELLER_ACCOUNT, new Uint8Array(32).fill(22));
  const buyerRail = () => createNearCounterRail({ config, rpc: new CapturingRpc({ endpoint: config.endpoint, fetch: buyerFetch, clock }), signer: buyerSigner, clock: () => node.nowMs, sleep });
  const sellerRail = createNearCounterRail({ config, rpc: new CapturingRpc({ endpoint: config.endpoint, fetch: base, clock }), signer: sellerSigner, clock: () => node.nowMs, sleep });
  const buyerStore = new MemoryFlowStore();
  const buyerOptions: BuyerFlowOptions = { identity: ident(1), venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail(), clock, store: buyerStore };
  const sellerLock = generateHashLock();
  const sellerFlow = new SellerFlow({ identity: ident(2), venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock, store: new MemoryFlowStore(), mintHashLock: () => sellerLock });
  const setTime = (ms: number) => {
    clockRef.ms = ms;
    node.nowMs = ms;
  };
  return { node, net, buyerOptions, buyerStore, buyerFlow: new BuyerFlow(buyerOptions), buyerRail, sellerRail, sellerFlow, sellerLock, noteStore, setTime, clockRef, swapId: computeSwapId(ident(1).did, "00000001") };
}
type Harness = ReturnType<typeof harness>;

/** bid ... postAccountLineA: everything before the Buyer's lock. */
async function toLines(h: Harness) {
  h.node.registerStorage(BUYER_ACCOUNT);
  h.node.registerStorage(SELLER_ACCOUNT);
  const offerA = await h.buyerFlow.bid({ swapId: h.swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legA });
  const accepted = await h.sellerFlow.acceptLegA(offerA, legB, lockTimeMs);
  const { acceptB, acceptBRecord } = await h.buyerFlow.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, lockTimeMs);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
  await h.buyerFlow.postAccountLineA(BUYER_ACCOUNT);
  return { offerA, accepted, acceptB, statement: accepted.acceptA.statement, contractB: acceptB.contract };
}

/** A Buyer resumed from the store (a fresh rail, a fresh connection), the way a restarted process gets one. */
async function restart(h: Harness, extra: Partial<BuyerFlowOptions> = {}) {
  const resumed = await resumeBuyer({ ...h.buyerOptions, rail: h.buyerRail() }, h.buyerStore, h.swapId, extra);
  return resumed;
}

const outcome = (run: Promise<unknown>): Promise<string> => run.then(() => "ok", (e: unknown) => `${(e as Error).name}: ${(e as Error).message}`);

describe("R1-01 + R1-04 (NEAR): a lock that landed and was then claimed is recognised whatever the clock says", () => {
  it("lockLegA resolves (before: NearLockUnknownError / a guard refusal), next becomes learnSecret, learnSecret returns the preimage, claimLegB succeeds", async () => {
    const h = harness();
    const p = await toLines(h);
    const dying = await restart(h, { rail: crashRail(h.buyerRail(), { after: ["commitLock"] }) });
    await expect(dying.flow.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Locked");

    // the Seller claims the lock it can see on chain without waiting for the Buyer's lock frame (outside its flow)
    const termsA = offerAcceptLockTerms(p.offerA, p.accepted.acceptA);
    const sellerConnected = await h.sellerRail.connect(termsA, { payer: BUYER_ACCOUNT, payee: SELLER_ACCOUNT });
    await sellerConnected.claim(`${p.statement}:${BUYER_ACCOUNT}`, h.sellerLock.preimage, legA.refundAfterMs - 60_000);
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Claimed");

    h.setTime(legA.refundAfterMs - 1); // far outside the guard window: a new lock would be refused
    const resumed = await restart(h);
    expect(resumed.next).toBe("lockLegA");
    await resumed.flow.lockLegA();
    expect(h.node.lockSendTxCalls).toBe(1); // nothing new was sent
    const again = await restart(h);
    expect(again.next).toBe("learnSecret");
    const secret = await again.flow.learnSecret();
    expect(secret).toBe(h.sellerLock.preimage);
    await again.flow.claimLegB(secret);
    expect((await new PaperRail(h.noteStore, () => h.clockRef.ms).read(p.contractB))?.status).toBe("claimed");
  });
});

describe("R1-08 (NEAR): a refund that landed and failed is resolved, and exactly one fresh refund follows", () => {
  /** A lock, then chain time past leg A's refund time, then the payout of a refund fails (the Buyer's token storage is gone). */
  async function failedRefund() {
    const h = harness();
    const p = await toLines(h);
    await h.buyerFlow.lockLegA();
    h.setTime(legA.refundAfterMs + 1);
    h.node.unregisterStorage(BUYER_ACCOUNT); // the contract puts the lock back to Locked when the payout fails
    const first = await outcome(h.buyerFlow.refundLegA());
    expect(first).toMatch(/NearRefundFailedError/);
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Locked");
    expect(h.node.refundSendTxCalls).toBe(1);
    return { h, p };
  }

  it("the Buyer registers storage and calls again: the second refundLegA refunds (before: NearRefundFailedError for ever)", async () => {
    const { h, p } = await failedRefund();
    h.node.registerStorage(BUYER_ACCOUNT);
    await h.buyerFlow.refundLegA();
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Refunded");
    expect(h.node.refundSendTxCalls).toBe(2); // the failed one and ONE fresh refund
  });

  it("the same after a restart", async () => {
    const { h, p } = await failedRefund();
    h.node.registerStorage(BUYER_ACCOUNT);
    const resumed = await restart(h);
    expect(resumed.next).toBe("refundLegA");
    await resumed.flow.refundLegA();
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Refunded");
    expect(h.node.refundSendTxCalls).toBe(2);
    expect((await restart(h)).next).toBe("done");
  });

  it("while the payout still fails, every call says so with the same typed error and builds ONE more refund at most per call", async () => {
    const { h } = await failedRefund(); // storage is still unregistered
    const second = await outcome(h.buyerFlow.refundLegA());
    expect(second).toMatch(/NearRefundFailedError/);
    expect(h.node.refundSendTxCalls).toBe(2); // each call builds one fresh refund (the failed one is resolved), never two
  });
});

describe("R1-10 (NEAR): a refund signed and saved but never sent", () => {
  /** The refund is signed and handed to the recorder, and the process dies before the send reaches the node. */
  async function signedNeverSent() {
    const h = harness();
    const p = await toLines(h);
    await h.buyerFlow.lockLegA();
    h.setTime(legA.refundAfterMs + 1);
    h.net.failSend = true;
    const first = await outcome(h.buyerFlow.refundLegA());
    expect(first).toMatch(/connection reset/);
    h.net.failSend = false;
    expect(h.node.refundSendTxCalls).toBe(0);
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Locked");
    return { h, p };
  }

  it("days later the restart sends the IDENTICAL saved bytes and the refund lands (before: pending for ever)", async () => {
    const { h, p } = await signedNeverSent();
    h.setTime(legA.refundAfterMs + 3 * 24 * 60 * 60_000);
    const resumed = await restart(h);
    expect(resumed.next).toBe("refundLegA");
    await resumed.flow.refundLegA();
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Refunded");
    expect(h.node.refundSendTxCalls).toBe(1); // the saved refund, once
    expect(h.node.sendTxExpired).toBe(0);
    expect((await restart(h)).next).toBe("done");
  });

  it("the node calls the saved bytes Expired: exactly one FRESH refund is built and it lands", async () => {
    const { h, p } = await signedNeverSent();
    h.node.advanceBlocks(h.node.txValidityPeriodBlocks + 10); // the signed block hash is now too old for the node
    const resumed = await restart(h);
    await resumed.flow.refundLegA();
    expect(h.node.sendTxExpired).toBe(1);
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Refunded");
    expect(h.node.refundSendTxCalls).toBe(1); // the expired send was refused; one fresh refund landed
  });

  it("while the node cannot be reached the call says the refund is not confirmed AND that it may never have been sent; nothing new is signed", async () => {
    const { h, p } = await signedNeverSent();
    h.net.failSend = true;
    const resumed = await restart(h);
    const message = await outcome(resumed.flow.refundLegA());
    expect(message).toMatch(/refund signed but not yet confirmed; it may never have been sent/);
    expect(h.node.refundSendTxCalls).toBe(0);
    expect(h.node.getLockRow(p.statement.slice(2))?.status).toBe("Locked");
  });
});

describe("R1-01 (NEAR): a lock signed and never sent is re-sent only after the guards", () => {
  it("outside the guard window the saved bytes are NOT sent and the call refuses; inside it the identical bytes go out once", async () => {
    const h = harness();
    await toLines(h);
    const dying = await restart(h, { rail: crashRail(h.buyerRail(), { before: ["commitLock"] }) });
    await expect(dying.flow.lockLegA()).rejects.toBeInstanceOf(ProcessDied); // signed and saved, never sent
    expect(h.node.sendTxReceived).toBe(0);

    h.setTime(legA.refundAfterMs - 1); // far outside the lock-time guard
    const late = await restart(h);
    expect(late.next).toBe("lockLegA");
    await expect(late.flow.lockLegA()).rejects.toThrow(/deadlines are no longer safe at lock time/);
    expect(h.node.sendTxReceived).toBe(0); // the identical bytes were not re-sent: that would be a new lock action
    expect(h.node.lockSendTxCalls).toBe(0);

    h.setTime(lockTimeMs); // back inside the window, the same record recovers: the identical bytes, once
    const inWindow = await restart(h);
    await inWindow.flow.lockLegA();
    expect(h.node.lockSendTxCalls).toBe(1);
    expect(h.node.sendTxReceived).toBe(1);
  });
});
