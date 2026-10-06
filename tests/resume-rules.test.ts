// SPDX-License-Identifier: MIT
//
// tests/resume-rules.test.ts - P8-RESUME-SPEC.md "Rule" and "Recover paths": the tests that were MISSING.
//
// Every rule and every recover path of the spec was disabled in turn (a local edit of src/, never committed) and the whole hermetic suite
// run; the table of what failed is in the report of that package. Fifteen of the fifty-eight edits survived: nothing failed without them.
// Each test below kills one or two of those survivors (its header names the edit). They run on the Solana stateful harness (the richest
// recovery handles), on the EVM mock node, and on the stateful fake ledger rail for the Bitcoin-only rules that no real harness reaches.
//
//   rule 1  the Seller's account line (its address and exact text) is saved before it is posted
//   rule 2  a Solana claim that may still land across a restart; a Bitcoin refund that can no longer land; a fresh lock must be the same lock
//   rule 3  the Seller never builds a second, different account line
//   rule 4  a resumed step runs the guard the original runs (status, chain clock, deadlines, refund time)
//   rule 6  the frames of a stored record are recomputed, not trusted
//   paths   reconcileLegB posts the missing lock frame; a confirmed lock is returned as recorded; the refund that lost to a claim is
//           routed to learnSecret; reconcileLockA records the lock as confirmed

import { PaperRail, dealRoom, encodeFrame, tryDecodeFrame, type AcceptFrame } from "@flop-labs/tclk";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { RailRecoveryRefusedError } from "../src/client/counter-rail.js";
import { FlowRecordConflictError, FlowRecordMismatchError, decodeFlowRecord, encodeFlowRecord, type FlowRecord } from "../src/client/flow-record.js";
import { flowKey } from "../src/client/flow-store.js";
import { PREFIX, STEPS, SETTLE, readSwap, resumeRole, runScript } from "./helpers/crash-matrix.js";
import { evmWorld, ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { ProcessDied, crashRail, failVenuePosts } from "./helpers/resume-flows.js";
import { bid, buyerRecord, framesOf, isFrame, isLine, legA, restartBuyer, restartSeller, rig, sellerRecord, toLines, toLocked, toPaired, type Rig } from "./helpers/resume-sol-rig.js";
import { legBDeadlines } from "./helpers/sol-flow-harness.js";
import type { LedgerChain } from "./helpers/ledger-rail.js";

/** Reads a stored record, lets `edit` change it, and stores the result again (valid shape, valid checksum). */
async function tamper(r: Rig, role: "buyer" | "seller", edit: (record: Record<string, unknown>) => void): Promise<void> {
  const key = flowKey(role, r.swapId);
  const store = role === "buyer" ? r.buyerStore : r.sellerStore;
  const record = decodeFlowRecord((await store.load(key))!, key);
  const plain = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  edit(plain);
  await store.save(key, encodeFlowRecord(plain as unknown as FlowRecord));
}

const sigOf = (params: unknown): string => base58.encode(Buffer.from(params as string, "base64").subarray(1, 65));

// --- rules 1 and 3: the Seller's account line --------------------------------------------------------------------------

describe("rules 1 and 3: the Seller's account line is built once, saved before it is posted, and never replaced by another", () => {
  it("a line saved but not posted is posted as the identical text; another address is refused; a posted line is adopted", async () => {
    const r = rig();
    const p = await toPaired(r);
    const room = dealRoom(p.contractA);
    const own = async () => (await r.h.venue.read(room)).filter((rec) => rec.sender === r.h.seller.did);
    const fail = failVenuePosts(r.h.venue, (roomName, line) => roomName === room && isLine(line));
    await expect(r.seller.postAccountLineA(r.h.sellerWallet.publicKey)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const saved = await sellerRecord(r);
    expect(saved.ownAccountLine?.address).toBe(r.h.sellerWallet.publicKey); // saved BEFORE the post
    expect(await own()).toHaveLength(0);

    expect(await restartSeller(r)).toBe("postAccountLineA");
    await expect(r.seller.postAccountLineA(r.h.buyerWallet.publicKey)).rejects.toBeInstanceOf(FlowRecordConflictError); // never a second, different line
    const record = await r.seller.postAccountLineA(r.h.sellerWallet.publicKey);
    expect(record.line).toBe(saved.ownAccountLine!.text);
    const again = await r.seller.postAccountLineA(r.h.sellerWallet.publicKey);
    expect(again.seq).toBe(record.seq);
    expect(await own()).toHaveLength(1);
  });
});

// --- rule 2: never twice where twice can lose funds ------------------------------------------------------------------------

describe("rule 2: a signed transaction that may still land is never answered by a second one", () => {
  it("Solana claim: accepted by the node but not landed, the process dies; the restart signs nothing until that blockhash expired, then one claim pays", async () => {
    const r = rig();
    const p = await toLocked(r);
    r.h.node.chain.once("sendTransaction", (params) => sigOf(params[0])); // accepted, never lands
    await expect(r.seller.claimLegA(p.accepted.acceptA.statement)).rejects.toThrow();
    const saved = await sellerRecord(r);
    expect(saved.claimRecords).toHaveLength(1); // the signature was saved BEFORE the send

    await restartSeller(r);
    await expect(r.seller.claimLegA(p.accepted.acceptA.statement)).rejects.toThrow(/not settled yet/); // the first may still land
    await expect(r.seller.claimLegA(p.accepted.acceptA.statement)).rejects.toThrow(/not settled yet/);
    expect(r.h.node.sent.claim).toBe(0); // no second claim while the first could land
    r.h.node.chain.finalizedHeight = saved.claimRecords[0]!.lastValidBlockHeight + 1; // its blockhash expired: it can never land
    const result = await r.seller.claimLegA(p.accepted.acceptA.statement);
    expect(result.receipt).toBeDefined();
    expect(r.h.node.sent.claim).toBe(1);
  });

  it("Solana (S2-1): a resumed Buyer claims leg B only once leg A reads Claimed; before that nothing is saved or written, after it the claim goes through", async () => {
    const r = rig();
    const p = await toLocked(r);
    await restartBuyer(r);
    await expect(r.buyer.claimLegB(r.h.sellerLock.preimage)).rejects.toThrow(/S2-1/); // the secret is known, leg A is still locked
    expect((await buyerRecord(r)).legBClaimAttempted).toBe(false);
    const note = new PaperRail(r.h.noteStore, r.h.clock);
    expect((await note.read(p.contractB))?.status).toBe("locked");

    await r.seller.claimLegA(p.accepted.acceptA.statement);
    await restartBuyer(r);
    await r.buyer.claimLegB(await r.buyer.learnSecret());
    expect((await note.read(p.contractB))?.status).toBe("claimed");
  });

  it("a fresh lock built after a proven never-landed must be the SAME lock: a different outpoint is refused and nothing is sent", async () => {
    const factory = ledgerWorldWith("btc", (chain) => void (chain.provesNeverLanded = true));
    const reference = await runScript(factory, SETTLE, []);
    const send = reference.world.ctl.actions.find((action) => action.what === "chain:lock.send")!;
    let chainOf: LedgerChain | undefined;
    const spy = ledgerWorldWith("btc", (chain) => {
      chain.provesNeverLanded = true;
      chainOf = chain;
    });
    const error = await runScript(spy, SETTLE, [{ n: send.n, mode: "before" }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("handle-mismatch");
    expect(chainOf!.counts.fundSent).toBe(0); // the first lock never reached the chain, and the second was refused
    expect(chainOf!.counts.fundBuilt).toBe(2);
  });

  it("Bitcoin: a recorded refund that can no longer land (its output was spent by another transaction) never leads to a second refund", async () => {
    let chainOf: LedgerChain | undefined;
    const factory = ledgerWorldWith("btc", (chain) => void (chainOf = chain));
    const script = [...PREFIX, STEPS.lockLegA, STEPS.legARefundTime, STEPS.refundLegA];
    const reference = await runScript(factory, script, []);
    const send = reference.world.ctl.actions.find((action) => action.what === "chain:refund.send")!;
    const error = await runScript(factory, script, [{ n: send.n, mode: "before" }], {
      afterResume: () => {
        // the Seller's claim lands while the Buyer is down, and neither the pending-claim read nor the evidence reader shows it yet
        for (const output of chainOf!.outputs.values()) {
          output.status = "claimed";
          output.preimage = reference.world.hashLock.preimage;
        }
        chainOf!.hideSpends = true;
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/can no longer land/);
    expect(chainOf!.counts.refundBuilt).toBe(1); // the recorded refund is the only one ever built
    expect(chainOf!.counts.refundSent).toBe(0);
  });
});

// --- rule 4: a resumed step runs the guard the original runs -----------------------------------------------------------------

describe("rule 4: a resumed step runs the guards its original runs", () => {
  async function diedBeforeCommit() {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { before: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    await restartBuyer(r);
    return { r, p };
  }

  it("lockLegA: leg B taken meanwhile by someone holding the secret stops the recovery before the chain is asked; nothing is sent", async () => {
    const { r, p } = await diedBeforeCommit();
    await new PaperRail(r.h.noteStore, r.h.clock).claim(p.contractB, r.h.sellerLock.preimage);
    await expect(r.buyer.lockLegA()).rejects.toThrow(/leg B no longer verifies/);
    expect(r.h.node.sent.lock).toBe(0);
  });

  it("lockLegA (Solana): a chain clock that drifted from the local clock stops the recovery before the chain is asked", async () => {
    const { r } = await diedBeforeCommit();
    r.h.node.nowMs = r.h.clockRef.ms + 10 * 60_000;
    await expect(r.buyer.lockLegA()).rejects.toThrow(/finalized clock/);
    expect(r.h.node.sent.lock).toBe(0);
  });

  it("lockLegA: a lock that is confirmed and announced is returned as recorded, without a guard or a chain read, even when the deadlines have since passed", async () => {
    const r = rig();
    const p = await toLocked(r);
    const recorded = (await buyerRecord(r)).lock.evidence!;
    r.h.setTime(legA.refundAfterMs); // far too late for a safe lock: a recovery would refuse
    await restartBuyer(r);
    const again = await r.buyer.lockLegA();
    expect(again.writeEvidence.ref).toBe(recorded.ref);
    expect(r.h.node.sent.lock).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });

  it("acceptLegB with a store runs the deadline arithmetic: an unsafe lock time is refused and nothing is posted or saved", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    await expect(r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.refundAfterMs)).rejects.toThrow(/unsafe deadlines/);
    const buyers = (await r.h.venue.read("tclk-offers")).filter((rec) => rec.sender === r.h.buyer.did && isFrame(rec.line, "accept"));
    expect(buyers).toHaveLength(0);
    expect((await buyerRecord(r)).frames.acceptB).toBeUndefined();
  });

  it("acceptLegB resumed after its accept B text was saved: deadlines that are unsafe now refuse it and nothing is posted", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const fail = failVenuePosts(r.h.venue, (_room, line) => isFrame(line, "accept") && (tryDecodeFrame(line) as AcceptFrame).from === r.h.buyer.did);
    await expect(r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    expect((await buyerRecord(r)).frames.acceptB).toBeDefined();
    await restartBuyer(r);
    await expect(r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.refundAfterMs)).rejects.toThrow(/unsafe deadlines/);
    expect((await r.h.venue.read("tclk-offers")).filter((rec) => rec.sender === r.h.buyer.did && isFrame(rec.line, "accept"))).toHaveLength(0);
  });

  it("refundLegA resumed before leg A's refundAfterMs refuses with the flow's own reason and signs nothing", async () => {
    const r = rig();
    await toLocked(r);
    await restartBuyer(r);
    await expect(r.buyer.refundLegA()).rejects.toThrow(/before its refundAfterMs/);
    expect(r.h.node.sent.refund).toBe(0);
    expect((await buyerRecord(r)).refund.attempted).toBe(false);
  });

  it("refundLegB resumed before leg B's refundAfterMs refuses with the flow's own reason and records no refund intent", async () => {
    const r = rig();
    await toPaired(r);
    await restartSeller(r);
    await expect(r.seller.refundLegB()).rejects.toThrow(/before its refundAfterMs/);
    expect((await sellerRecord(r)).legBRefund.attempted).toBe(false);
  });
});

// --- rule 6: the frames of a stored record are recomputed ----------------------------------------------------------------

describe("rule 6: a stored record's contract ids are recomputed from its frames, never trusted", () => {
  const forged = `0x${"ee".repeat(32)}`;

  async function forgeAccept(r: Rig, role: "buyer" | "seller", slot: "acceptA" | "acceptB", field: "contractA" | "contractB"): Promise<void> {
    await tamper(r, role, (record) => {
      const frames = record.frames as Record<string, { text: string; record?: unknown } | undefined>;
      const accept = tryDecodeFrame(frames[slot]!.text) as AcceptFrame;
      frames[slot] = { text: encodeFrame({ ...accept, contract: forged }) }; // the signed record no longer matches: dropped
      record[field] = forged; // the record's own field agrees with the forged frame, so only the recomputation can notice
    });
  }

  it("a Buyer record whose accept A frame names a contract its offer and accept do not derive", async () => {
    const r = rig();
    await toPaired(r);
    await forgeAccept(r, "buyer", "acceptA", "contractA");
    const error = await restartBuyer(r).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe("contractA");
  });

  it("a Buyer record whose accept B frame names a contract its offer and accept do not derive", async () => {
    const r = rig();
    await toPaired(r);
    await forgeAccept(r, "buyer", "acceptB", "contractB");
    const error = await restartBuyer(r).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe("contractB");
  });

  it("a Seller record whose accept A frame names a contract its offer and accept do not derive", async () => {
    const r = rig();
    await toPaired(r);
    await forgeAccept(r, "seller", "acceptA", "contractA");
    const error = await restartSeller(r).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe("contractA");
  });
});

// --- recover paths ------------------------------------------------------------------------------------------------------

describe("recover paths that had no test of their own", () => {
  it("Seller lock B: reconcileLegB posts the lock frame a dead process never posted (once), after a restart", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
    const roomB = dealRoom(acceptB.contract);
    const fail = failVenuePosts(r.h.venue, (room, line) => room === roomB && isFrame(line, "lock"));
    await expect(r.seller.lockLegB(acceptBRecord)).rejects.toBeInstanceOf(ProcessDied); // the note was written, the frame was not
    fail.restore();
    expect(await framesOf(r, roomB, "lock")).toHaveLength(0);

    await restartSeller(r);
    await expect(r.seller.reconcileLegB()).resolves.toEqual({ locked: true });
    expect(await framesOf(r, roomB, "lock")).toHaveLength(1);
    await r.seller.reconcileLegB(); // again: adopted, not posted twice
    expect(await framesOf(r, roomB, "lock")).toHaveLength(1);
  });

  it("Buyer lock A: reconcileLockA records a lock the chain shows as confirmed, so the record no longer needs a recovery", async () => {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { after: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    expect((await buyerRecord(r)).lock.evidence).toBeUndefined();

    await restartBuyer(r);
    await expect(r.buyer.reconcileLockA()).resolves.toMatchObject({ locked: true });
    const after = await buyerRecord(r);
    expect(after.lock.evidence?.ref).toBe(after.lock.prepared!.ref);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
    expect(r.h.node.sent.lock).toBe(1);
  });

  it("Buyer refund A (EVM): a refund that lost to the Seller's claim is routed to learnSecret on the restart, and the Buyer then takes leg B", async () => {
    const run = await runScript(evmWorld, [...PREFIX, STEPS.lockLegA, STEPS.claimLegA, STEPS.legARefundTime], []);
    const c = run.ctx;
    await expect(c.buyer.refundLegA()).rejects.toThrow(); // the contract refuses: the lock was claimed
    await resumeRole(c, "buyer");
    await expect(c.buyer.refundLegA()).rejects.toThrow(/learnSecret/);
    expect(run.world.counts().refunds).toBe(0);
    await STEPS.learnAndClaimB.run(c);
    const view = await readSwap(run.world);
    expect((await run.world.paper.read(view.acceptB!.contract))?.status).toBe("claimed");
  });
});
