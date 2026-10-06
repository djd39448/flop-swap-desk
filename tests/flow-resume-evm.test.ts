// SPDX-License-Identifier: MIT
//
// tests/flow-resume-evm.test.ts - P8-RESUME-SPEC.md "Recover paths" on the EVM mock RPC harness: the REAL BuyerFlow / SellerFlow
// with a store, over the REAL EVM counter rail and the REAL viem clients, over the STATEFUL mock node
// (tests/helpers/evm-mock-node.ts) that applies the EvmHashRail contract's own state machine to what the rail actually sends.
// EVM is the rail with no recovery handle (the ref IS the hash lock), so what these tests pin is the chain-first recovery:
//   - a restarted Buyer reads `locks(hashLock)`: its own row is `landed`, no row is `never-landed` (one fresh approve + lock; a repeated
//     lock cannot double-lock, the contract refuses a duplicate hash lock), another payer's row is a typed `lock-conflict`;
//   - a restarted Seller whose claim was attempted looks for its own preimage in the Claimed log BEFORE it builds another claim, and
//     posts the reveal and receipt frames that were lost (the closed "mined before retry, frames never posted" gap);
//   - a restarted Buyer whose refund was attempted reads the lock (Refunded and final) and posts the frames once.

import { MemoryNoteStore, PaperRail, dealRoom, tryDecodeFrame, type OfferFrame, type TranscriptRecord, type HashLock, generateHashLock } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow, type BuyerFlowOptions } from "../src/client/buyer.js";
import { RailRecoveryRefusedError } from "../src/client/counter-rail.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { MemoryFlowStore } from "../src/client/flow-store.js";
import { SellerFlow, type SellerFlowOptions } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { identity, type Identity } from "./helpers/identity.js";
import { evmSigner } from "./helpers/proven-lines.js";
import { ProcessDied, crashRail, resumeBuyer, resumeSeller } from "./helpers/resume-flows.js";
import { framesIn } from "./helpers/sol-flow-harness.js";
import { getAddress, type Address } from "viem";

function addr(tag: string): Address {
  return getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
}
const ident = (tag: number): Identity => identity(tag.toString(16).padStart(2, "0").repeat(32));

const T0 = 1_700_000_000_000;
const BUYER_SIGNER = evmSigner(0x411);
const SELLER_SIGNER = evmSigner(0x412);
const legAWindow = { claimByMs: T0 + 60 * 60_000, refundAfterMs: T0 + 90 * 60_000, expiresMs: T0 + 30 * 60_000 };
const legBWindow = { claimByMs: T0 + 120 * 60_000, refundAfterMs: T0 + 180 * 60_000, expiresMs: T0 + 40 * 60_000 };

interface Rig {
  node: EvmMockNode;
  clockRef: { ms: number };
  venue: MemoryVenue;
  noteStore: MemoryNoteStore;
  buyerStore: MemoryFlowStore;
  sellerStore: MemoryFlowStore;
  sellerLock: HashLock;
  buyerOptions: BuyerFlowOptions;
  sellerOptions: SellerFlowOptions;
  swapId: string;
  buyer: BuyerFlow;
  seller: SellerFlow;
  buyerIdentity: Identity;
}

function rig(): Rig {
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const node = new EvmMockNode(clock, addr("flow-resume-evm-rail"), addr("flow-resume-evm-usdc"), [BUYER_SIGNER, SELLER_SIGNER]);
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const buyerStore = new MemoryFlowStore();
  const sellerStore = new MemoryFlowStore();
  const sellerLock = generateHashLock();
  const buyerIdentity = ident(0x21);
  const buyerOptions: BuyerFlowOptions = {
    identity: buyerIdentity,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config: node.config(), rpc: node.rpc(), account: BUYER_SIGNER.address, clock }),
    clock,
    store: buyerStore,
  };
  const sellerOptions: SellerFlowOptions = {
    identity: ident(0x22),
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config: node.config(), rpc: node.rpc(), account: SELLER_SIGNER.address, clock }),
    clock,
    store: sellerStore,
    mintHashLock: () => sellerLock,
  };
  return {
    node,
    clockRef,
    venue,
    noteStore,
    buyerStore,
    sellerStore,
    sellerLock,
    buyerOptions,
    sellerOptions,
    swapId: computeSwapId(buyerIdentity.did, "00000001"),
    buyer: new BuyerFlow(buyerOptions),
    seller: new SellerFlow(sellerOptions),
    buyerIdentity,
  };
}

const bid = (r: Rig): Promise<OfferFrame> =>
  r.buyer.bid({ swapId: r.swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legAWindow });

async function restartBuyer(r: Rig, extra: Partial<BuyerFlowOptions> = {}) {
  const resumed = await resumeBuyer(r.buyerOptions, r.buyerStore, r.swapId, extra);
  r.buyer = resumed.flow;
  return resumed.next;
}
async function restartSeller(r: Rig, extra: Partial<SellerFlowOptions> = {}) {
  const resumed = await resumeSeller(r.sellerOptions, r.sellerStore, r.swapId, extra);
  r.seller = resumed.flow;
  return resumed.next;
}

async function toLines(r: Rig) {
  const offerA = await bid(r);
  const accepted = await r.seller.acceptLegA(offerA, legBWindow, T0);
  const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, T0);
  await r.seller.lockLegB(acceptBRecord);
  await r.buyer.verifyLegBLocked();
  await r.seller.postAccountLineA(SELLER_SIGNER.address);
  await r.buyer.postAccountLineA(BUYER_SIGNER.address);
  return { offerA, accepted, contractA: accepted.acceptA.contract, contractB: acceptB.contract, statement: accepted.acceptA.statement };
}

const framesOf = async (r: Rig, room: string, type: string): Promise<TranscriptRecord[]> => framesIn(await r.venue.read(room), type);

describe("EVM resume: the whole swap, with both parties restarted after every step", () => {
  it("settles with one approve, one lock, one claim and each frame exactly once", async () => {
    const r = rig();
    const nexts: string[] = [];
    const offerA = await bid(r);
    nexts.push(`buyer:${await restartBuyer(r)}`);
    const accepted = await r.seller.acceptLegA(offerA, legBWindow, T0);
    nexts.push(`seller:${await restartSeller(r)}`);
    const { acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, T0);
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.seller.lockLegB(acceptBRecord);
    nexts.push(`seller:${await restartSeller(r)}`);
    await r.buyer.verifyLegBLocked();
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.seller.postAccountLineA(SELLER_SIGNER.address);
    nexts.push(`seller:${await restartSeller(r)}`);
    await r.buyer.postAccountLineA(BUYER_SIGNER.address);
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.buyer.lockLegA();
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.seller.claimLegA(r.seller.statement!);
    nexts.push(`seller:${await restartSeller(r)}`);
    const secret = await r.buyer.learnSecret();
    expect(secret).toBe(r.sellerLock.preimage);
    await r.buyer.claimLegB(secret);
    nexts.push(`buyer:${await restartBuyer(r)}`);

    expect(nexts).toEqual([
      "buyer:acceptLegB",
      "seller:postAccountLineA",
      "buyer:verifyLegBLocked",
      "seller:postAccountLineA",
      "buyer:postAccountLineA",
      "seller:claimLegA",
      "buyer:lockLegA",
      "buyer:learnSecret",
      "seller:done",
      "buyer:done",
    ]);
    expect([r.node.count("approve"), r.node.count("lock"), r.node.count("claim"), r.node.count("refund")]).toEqual([1, 1, 1, 0]);
    const roomA = dealRoom(accepted.acceptA.contract);
    for (const type of ["lock", "reveal", "receipt"]) expect(await framesOf(r, roomA, type)).toHaveLength(1);
  });
});

describe("EVM resume: Buyer lock A (rules 1, 2 and 4)", () => {
  it("the lock mined but its evidence lookup failed: the restart reads locks(hashLock), posts the lock frame once, sends nothing", async () => {
    const r = rig();
    const p = await toLines(r);
    r.node.hideLogs = true; // the transactions mine; the Locked-event lookup finds nothing (E3)
    await expect(r.buyer.lockLegA()).rejects.toThrow(/expected exactly one Locked log/);
    r.node.hideLogs = false;
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([1, 1]);
    const saved = await r.buyerStore.load(`buyer:${r.swapId}`);
    expect(saved).not.toBeNull();
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(0);

    expect(await restartBuyer(r)).toBe("lockLegA");
    const result = await r.buyer.lockLegA();
    expect(result.writeEvidence.ref).toBe(p.statement);
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([1, 1]); // no second lock, no second approve
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
    await r.buyer.lockLegA(); // confirmed: the recorded result
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });

  it("the lock send's reply was lost after it landed: the restart finds the row and signs nothing new", async () => {
    const r = rig();
    const p = await toLines(r);
    r.node.loseNextSendReply("lock");
    await expect(r.buyer.lockLegA()).rejects.toThrow();
    expect(r.node.row(p.statement)?.status).toBe(1);
    await restartBuyer(r);
    await r.buyer.lockLegA();
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([1, 1]);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });

  it("approve landed and the lock never did: no row is never-landed, so one fresh approve + lock follows (a lock cannot double up)", async () => {
    const r = rig();
    const p = await toLines(r);
    r.node.rejectNextSend("lock");
    await expect(r.buyer.lockLegA()).rejects.toThrow();
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([1, 0]);
    expect(r.node.row(p.statement)).toBeUndefined();

    await restartBuyer(r);
    await r.buyer.lockLegA();
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([2, 1]); // a repeated approve is harmless; ONE lock
    expect(r.node.row(p.statement)?.status).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });

  it("dies before commitLock: the row is absent, one lock is sent after the restart (and nothing before)", async () => {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.buyerOptions.rail, { before: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toThrow(/process died before commitLock/);
    expect(r.node.count("lock")).toBe(0);
    await restartBuyer(r);
    await r.buyer.lockLegA();
    expect(r.node.count("lock")).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });

  it("another payer's row under this hash lock is a typed lock-conflict: the flow stops, nothing is sent", async () => {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.buyerOptions.rail, { before: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toThrow(/process died/);
    r.node.rows.set(p.statement.toLowerCase(), {
      payer: addr("flow-resume-evm-stranger"),
      payee: SELLER_SIGNER.address,
      token: r.node.token,
      amount: 1_000_000n,
      claimByMs: BigInt(legAWindow.claimByMs),
      refundAfterMs: BigInt(legAWindow.refundAfterMs),
      status: 1,
    });
    await restartBuyer(r);
    const error = await r.buyer.lockLegA().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("lock-conflict");
    expect(r.node.count("lock")).toBe(0);
    expect(r.node.count("approve")).toBe(0);
  });
});

describe("EVM resume: Seller claim A (rules 1, 2 and 3)", () => {
  it("the claim mined and its reply was lost: the restart finds its own preimage in the Claimed log, posts the frames once, sends no second claim", async () => {
    const r = rig();
    const p = await toLines(r);
    await r.buyer.lockLegA();
    r.node.loseNextSendReply("claim");
    await expect(r.seller.claimLegA(r.seller.statement!)).rejects.toThrow();
    expect(r.node.count("claim")).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "reveal")).toHaveLength(0);

    expect(await restartSeller(r)).toBe("claimLegA");
    const result = await r.seller.claimLegA(r.seller.statement!);
    expect(result.reveal).toBeDefined();
    expect(r.node.count("claim")).toBe(1);
    for (const type of ["reveal", "receipt"]) expect(await framesOf(r, dealRoom(p.contractA), type)).toHaveLength(1);
    expect(await restartSeller(r)).toBe("done");
    await r.seller.claimLegA(r.seller.statement!); // confirmed: the same frames, nothing posted again
    expect(await framesOf(r, dealRoom(p.contractA), "reveal")).toHaveLength(1);
  });

  it("the claim was attempted but never sent (the process died first): the restart sees no Claimed log and does the ordinary guarded claim", async () => {
    const r = rig();
    await toLines(r);
    await r.buyer.lockLegA();
    await restartSeller(r, { rail: crashRail(r.sellerOptions.rail, { before: ["claim"] }) });
    await expect(r.seller.claimLegA(r.seller.statement!)).rejects.toThrow(/process died before claim/);
    expect(r.node.count("claim")).toBe(0);
    await restartSeller(r);
    await r.seller.claimLegA(r.seller.statement!);
    expect(r.node.count("claim")).toBe(1);
  });
});

describe("EVM resume: Buyer refund A (rules 1, 2 and 3)", () => {
  it("the refund mined and the process died before it saw the answer: the restart reads Refunded and posts the frames once, no second refund", async () => {
    const r = rig();
    const p = await toLines(r);
    await r.buyer.lockLegA();
    r.clockRef.ms = legAWindow.refundAfterMs;
    r.node.loseNextSendReply("refund");
    await restartBuyer(r, { rail: crashRail(r.buyerOptions.rail, { before: ["verifyLockFinal"] }) });
    await expect(r.buyer.refundLegA()).rejects.toThrow(/process died before verifyLockFinal/);
    expect(r.node.count("refund")).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "refund")).toHaveLength(0);

    expect(await restartBuyer(r)).toBe("refundLegA");
    await r.buyer.refundLegA();
    expect(r.node.count("refund")).toBe(1);
    for (const type of ["refund", "receipt"]) expect(await framesOf(r, dealRoom(p.contractA), type)).toHaveLength(1);
    expect(await restartBuyer(r)).toBe("done");
  });

  it("the refund was attempted but never sent: the lock is still open, so exactly one refund follows the restart", async () => {
    const r = rig();
    const p = await toLines(r);
    await r.buyer.lockLegA();
    r.clockRef.ms = legAWindow.refundAfterMs;
    await restartBuyer(r, { rail: crashRail(r.buyerOptions.rail, { before: ["refund"] }) });
    await expect(r.buyer.refundLegA()).rejects.toThrow(/process died before refund/);
    expect(r.node.count("refund")).toBe(0);
    await restartBuyer(r);
    await r.buyer.refundLegA();
    expect(r.node.count("refund")).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "refund")).toHaveLength(1);
  });

  it("a refund after the Seller claimed is routed to learnSecret on the restart too (the claim wins, nothing is refunded)", async () => {
    const r = rig();
    await toLines(r);
    await r.buyer.lockLegA();
    await r.seller.claimLegA(r.seller.statement!);
    r.clockRef.ms = legAWindow.refundAfterMs - 1;
    await restartBuyer(r);
    // within the lock window the Buyer simply learns the secret and claims leg B
    const secret = await r.buyer.learnSecret();
    await r.buyer.claimLegB(secret);
    expect(r.node.count("refund")).toBe(0);
  });
});

// --- review round 1, R1-01: the chain is read BEFORE any guard, so a lock that landed is always recognised -----------------------------

describe("EVM resume R1-01: a lock that already landed is recognised whatever the clock says (rule 4 gates NEW actions only)", () => {
  /** The Buyer's approve and lock land and the process dies before the evidence or the lock frame is saved. */
  async function lockLandedUnrecorded(r: Rig) {
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.buyerOptions.rail, { after: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    expect(r.node.row(p.statement)?.status).toBe(1); // leg A is locked on chain
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(0);
    return p;
  }

  it("F1: the Seller claimed meanwhile (no lock frame needed on EVM) and the Buyer comes back 46 minutes later: lockLegA resolves, next becomes learnSecret, learnSecret returns the preimage, claimLegB succeeds before leg B's refund time", async () => {
    const r = rig();
    const p = await lockLandedUnrecorded(r);
    r.clockRef.ms = T0 + 2 * 60_000;
    await r.seller.claimLegA(r.seller.statement!);
    expect(r.node.row(p.statement)?.status).toBe(2); // Claimed: the secret is public on chain

    // 46 minutes after T0 the reveal window is shorter than the 45 minutes rule 1 asks for (it was 2 640 000 ms < 2 700 000 ms):
    // before the fix every lockLegA call threw "deadlines are no longer safe at lock time" before the chain was read, and nothing
    // ever named learnSecret, so leg B was refunded to the Seller at its refund time
    r.clockRef.ms = T0 + 46 * 60_000;
    expect(await restartBuyer(r)).toBe("lockLegA");
    const locked = await r.buyer.lockLegA();
    expect(locked.writeEvidence.ref).toBe(p.statement);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1); // a funded lock is never left unannounced
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([1, 1]); // nothing new was sent

    expect(await restartBuyer(r)).toBe("learnSecret");
    const secret = await r.buyer.learnSecret();
    expect(secret).toBe(r.sellerLock.preimage);
    r.clockRef.ms = legBWindow.refundAfterMs - 60_000;
    await r.buyer.claimLegB(secret);
    expect((await r.buyerOptions.paperRail.read(p.contractB))?.status).toBe("claimed");
    expect(await restartBuyer(r)).toBe("done");
  });

  it("F1, the leg-B note guard: once the secret is public anyone can write leg B's note as claimed; that no longer stops the Buyer from recognising its own landed lock", async () => {
    const r = rig();
    const p = await lockLandedUnrecorded(r);
    r.clockRef.ms = T0 + 2 * 60_000;
    await r.seller.claimLegA(r.seller.statement!);
    await new PaperRail(r.noteStore, () => r.clockRef.ms).claim(p.contractB, r.sellerLock.preimage); // a note written by someone who knows the secret
    expect(await restartBuyer(r)).toBe("lockLegA");
    await r.buyer.lockLegA(); // before the fix: "leg B no longer verifies on the paper rail (E1)"
    expect(await restartBuyer(r)).toBe("learnSecret");
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });

  it("F1b: the Seller never claims: after leg A's refundAfterMs next names refundLegA, lockLegA still records the landed lock, and refundLegA refunds (row status 3)", async () => {
    const r = rig();
    const p = await lockLandedUnrecorded(r);
    r.clockRef.ms = legAWindow.refundAfterMs + 1;
    expect(await restartBuyer(r)).toBe("refundLegA"); // before the fix: lockLegA for ever, though refundLegA would work
    await r.buyer.lockLegA(); // recognised and announced: no deadline guard applies to a lock that already landed
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([1, 1]);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
    await r.buyer.refundLegA();
    expect(r.node.row(p.statement)?.status).toBe(3);
    expect(r.node.count("refund")).toBe(1);
    expect(await restartBuyer(r)).toBe("done");
  });

  it("F1b, a runner that simply follows next: refundLegA goes straight from the unrecognised lock to the refund", async () => {
    const r = rig();
    const p = await lockLandedUnrecorded(r);
    r.clockRef.ms = legAWindow.refundAfterMs + 1;
    expect(await restartBuyer(r)).toBe("refundLegA");
    await r.buyer.refundLegA();
    expect(r.node.row(p.statement)?.status).toBe(3);
    expect(await restartBuyer(r)).toBe("done");
  });

  it("a lock that did NOT land is another matter: with the guard window gone, lockLegA refuses a NEW lock and sends nothing", async () => {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.buyerOptions.rail, { before: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    r.clockRef.ms = T0 + 46 * 60_000;
    expect(await restartBuyer(r)).toBe("lockLegA");
    await expect(r.buyer.lockLegA()).rejects.toThrow(/deadlines are no longer safe at lock time/);
    expect([r.node.count("approve"), r.node.count("lock")]).toEqual([0, 0]);
    expect(r.node.row(p.statement)).toBeUndefined();
  });
});
