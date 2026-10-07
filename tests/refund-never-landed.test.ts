// SPDX-License-Identifier: MIT
//
// tests/refund-never-landed.test.ts - P9 review round 2, R2-FUND-01: a leg A lock attempt that never landed must end in a verdict, not a loop.
//
// The state: the Buyer's lock attempt has no evidence (the approve landed, the lock guard refused the lock after the approve's receipt, so no lock
// was ever sent; the same state follows a signer refusal of the lock, a lock dropped after a receipt timeout, or a kill between the approve and the
// lock). Once leg A's refund time came, `next` said `refundLegA`, and the refund reverted at the estimate ("refund on an unknown lock") for ever:
// the runner could neither refund nor finish, and the Seller's leg B refund was never reached.
//
// The fix (src/client/buyer.ts `refundLegAUnlatched`, src/rails/evm-htlc.ts `readLockAbsence`): with a lock attempted and no evidence, the chain is
// read BEFORE anything is sent. A row at the latest block is recorded as a lock that landed and the refund goes ahead as before. No row and a
// FINALIZED block at or past leg A's refund time is the verdict "never locked" (the escrow refuses a lock in any block at or past that time), recorded
// in the Buyer's record so `next` says `done`; no row and no such finalized block yet is the typed `RefundNotFinalYetError`, recording nothing.
// Everything runs on the EVM matrix world (tests/helpers/matrix-worlds.ts) over the stateful mock node; nothing is mocked in the flow.

import { describe, expect, it } from "vitest";

import { RefundNotFinalYetError } from "../src/client/buyer.js";
import { RailRecoveryRefusedError } from "../src/client/counter-rail.js";
import { FLOW_MESSAGE } from "../src/client/rehearsal-run.js";
import { PREFIX } from "./helpers/crash-matrix.js";
import { EvmMockNode, type SendKind } from "./helpers/evm-mock-node.js";
import { evmWorldWith } from "./helpers/matrix-worlds.js";
import { buyerRecordOf, resumedBuyer, resumedSeller, started, type Started } from "./helpers/resume-world.js";

const MIN = 60_000;
const NEVER_LOCKED = "buyer: leg A was never locked, nothing to refund";
const NO_CHAIN_WRITES = { locks: 0, claims: 0, refunds: 0, refundBuilds: 0 };

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (caught: unknown) => caught ?? new Error("rejected with nothing"),
  );

/** The review's state: the approve lands, the clock then moves 50 minutes (past the reveal window), and the lock guard refuses the lock. */
async function guardStalled(): Promise<{ s: Started; node: EvmMockNode }> {
  let node: EvmMockNode | undefined;
  const s = await started(evmWorldWith((n) => void (node = n)), PREFIX);
  const world = node!.hook!;
  let last: SendKind | undefined;
  node!.hook = {
    begin: (kind, from) => {
      last = kind;
      return world.begin(kind, from);
    },
    end: (token) => {
      world.end(token);
      if (last === "approve") s.w.setTime(s.w.lockTimeMs + 50 * MIN);
    },
  };
  await expect(s.c.buyer.lockLegA()).rejects.toThrow(/deadlines are no longer safe at lock time \(B3\)/);
  expect(node!.count("approve")).toBe(1);
  expect(node!.count("lock")).toBe(0);
  return { s, node: node! };
}

describe("R2-FUND-01: a lock attempt that never landed ends in a verdict", () => {
  it("the review's stall: after leg A's refund time is final, refundLegA says never locked, sends nothing, and records it so next stops naming refundLegA", async () => {
    const { s, node } = await guardStalled();
    const before = await buyerRecordOf(s.w);
    expect(before.lock.attempted).toBe(true);
    expect(before.lock.evidence).toBeUndefined();
    expect(before.lock.neverLanded).toBeUndefined();

    s.w.setTime(s.w.refundAt.legA + 1); // leg A's refund time has come, and the chain's finalized block is past it too
    const resumed = await resumedBuyer(s);
    expect(resumed.next, "before the read, the saved state still points at refundLegA").toBe("refundLegA");

    const error = await failure(resumed.flow.refundLegA());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(NEVER_LOCKED);
    expect(FLOW_MESSAGE.neverLocked.test((error as Error).message), "the runner recognises this text").toBe(true);
    expect(s.w.counts(), "nothing was sent: no lock, no claim, no refund").toEqual(NO_CHAIN_WRITES);
    expect(node.count("approve")).toBe(1);

    // the verdict is in the record, and a fresh process reads it: the Buyer's part is finished
    expect((await buyerRecordOf(s.w)).lock.neverLanded).toBe(true);
    expect((await resumedBuyer(s)).next).toBe("done");

    // the same text again, without reading the chain, from the flow that recorded it and from a resumed one
    const reads = node.requests.length;
    const resumedAgain = await resumedBuyer(s);
    expect(resumedAgain.next).toBe("done");
    const second = await failure(resumedAgain.flow.refundLegA());
    expect((second as Error).message).toBe(NEVER_LOCKED);
    const third = await failure(resumed.flow.refundLegA());
    expect((third as Error).message).toBe(NEVER_LOCKED);
    expect(node.requests.length, "a recorded verdict is answered without a chain read").toBe(reads);
    expect(s.w.counts()).toEqual(NO_CHAIN_WRITES);

    // no new lock may follow: the escrow refuses every lock from leg A's refund time on, and the flow says so without sending one
    const lock = await failure(resumedAgain.flow.lockLegA());
    expect((lock as Error).message).toMatch(/recorded as never landed/);
    expect(s.w.counts()).toEqual(NO_CHAIN_WRITES);
  });

  it("the swap then ends: the Seller refunds its paper leg B and both parties read done", async () => {
    const { s } = await guardStalled();
    s.w.setTime(s.w.refundAt.legA + 1);
    const resumed = await resumedBuyer(s);
    await failure(resumed.flow.refundLegA());

    s.w.setTime(s.w.refundAt.legB);
    const seller = await resumedSeller(s);
    await seller.flow.refundLegB(); // the Seller's own refund of leg B stands, whatever its `next` said before
    expect((await resumedSeller(s)).next).toBe("done");
    expect((await resumedBuyer(s)).next).toBe("done");
    expect(s.w.counts()).toEqual(NO_CHAIN_WRITES);
  });

  it("with the finalized block still below leg A's refund time the answer is the typed 'not final yet': nothing recorded, nothing sent, next unchanged", async () => {
    const { s, node } = await guardStalled();
    s.w.setTime(s.w.refundAt.legA + 1);
    node.finalizedLagMs = 10 * MIN; // the finalized block is ten minutes behind: it is before the refund time
    const resumed = await resumedBuyer(s);
    expect(resumed.next).toBe("refundLegA");

    const error = await failure(resumed.flow.refundLegA());
    expect(error).toBeInstanceOf(RefundNotFinalYetError);
    expect((error as Error).message).toMatch(/not final yet/);
    expect(FLOW_MESSAGE.neverLocked.test((error as Error).message), "never the never-locked verdict").toBe(false);
    expect((await buyerRecordOf(s.w)).lock.neverLanded, "nothing was recorded").toBeUndefined();
    expect((await resumedBuyer(s)).next).toBe("refundLegA");
    expect(s.w.counts()).toEqual(NO_CHAIN_WRITES);

    // the finalized block catches up with the refund time: now it is the verdict
    node.finalizedLagMs = 0;
    const later = await resumedBuyer(s);
    const verdict = await failure(later.flow.refundLegA());
    expect((verdict as Error).message).toBe(NEVER_LOCKED);
    expect((await resumedBuyer(s)).next).toBe("done");
  });

  it("the boundary is inclusive: a finalized block exactly at the refund time is the verdict, one second before it is not", async () => {
    const { s, node } = await guardStalled();
    s.w.setTime(s.w.refundAt.legA); // the local clock is exactly at the refund time
    node.finalizedLagMs = 1000;
    const early = await resumedBuyer(s);
    expect(await failure(early.flow.refundLegA())).toBeInstanceOf(RefundNotFinalYetError);
    node.finalizedLagMs = 0;
    const exact = await resumedBuyer(s);
    expect(((await failure(exact.flow.refundLegA())) as Error).message).toBe(NEVER_LOCKED);
  });

  it("a lock that DID land (its evidence was lost before the save) is recorded as landed and refunded as always: no verdict", async () => {
    let node: EvmMockNode | undefined;
    const s = await started(evmWorldWith((n) => void (node = n)), PREFIX);
    node!.loseNextSendReply("lock"); // the lock is applied, its reply is lost: the flow has no evidence
    await expect(s.c.buyer.lockLegA()).rejects.toThrow();
    expect(node!.count("lock")).toBe(1);
    const before = await buyerRecordOf(s.w);
    expect(before.lock.attempted).toBe(true);
    expect(before.lock.evidence).toBeUndefined();

    s.w.setTime(s.w.refundAt.legA + 1);
    const resumed = await resumedBuyer(s);
    expect(resumed.next).toBe("refundLegA");
    const refunded = await resumed.flow.refundLegA();
    expect(refunded.ref).toBeDefined();
    expect(node!.count("refund")).toBe(1);
    expect(node!.count("lock")).toBe(1);
    const after = await buyerRecordOf(s.w);
    expect(after.lock.evidence, "the lock the chain showed is recorded").toBeDefined();
    expect(after.lock.neverLanded).toBeUndefined();
    expect((await resumedBuyer(s)).next).toBe("done");
  });

  it("a lock under this hash lock owned by ANOTHER payer is a refusal for a person (lock-conflict): neither 'landed' nor 'never locked', nothing sent", async () => {
    const { s, node } = await guardStalled();
    node.rows.set(s.w.hashLock.hash.toLowerCase(), {
      payer: "0x00000000000000000000000000000000000000f1",
      payee: "0x00000000000000000000000000000000000000f2",
      token: node.token,
      amount: 1n,
      claimByMs: BigInt(s.w.refundAt.legA - 1),
      refundAfterMs: BigInt(s.w.refundAt.legA),
      status: 1,
    });
    s.w.setTime(s.w.refundAt.legA + 1);
    const resumed = await resumedBuyer(s);
    const error = await failure(resumed.flow.refundLegA());
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("lock-conflict");
    const record = await buyerRecordOf(s.w);
    expect(record.lock.neverLanded).toBeUndefined();
    expect(record.lock.evidence).toBeUndefined();
    expect(s.w.counts()).toEqual(NO_CHAIN_WRITES);
  });

  it("a lock the Buyer already holds evidence for refunds as before and records no verdict", async () => {
    const s = await started(evmWorldWith()); // the default script: everything up to and including the Buyer's lock of leg A
    s.w.setTime(s.w.refundAt.legA + 1);
    const resumed = await resumedBuyer(s);
    expect((await buyerRecordOf(s.w)).lock.evidence).toBeDefined();
    const refunded = await resumed.flow.refundLegA();
    expect(refunded.ref).toBeDefined();
    expect(s.w.counts().refunds).toBe(1);
    expect((await buyerRecordOf(s.w)).lock.neverLanded).toBeUndefined();
  });
});
