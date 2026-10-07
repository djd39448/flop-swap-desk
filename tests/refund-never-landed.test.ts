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
// read BEFORE anything is sent. A row at the FINALIZED block is recorded as a lock that landed and the refund goes ahead as before (R3-FUND-02: never a row
// seen only at the latest block). No row and a FINALIZED block at or past leg A's refund time is the verdict "never locked" (the escrow refuses a lock in any
// block at or past that time), recorded in the Buyer's record so `next` says `done`; no row and no such finalized block yet is the typed `RefundNotFinalYetError`,
// recording nothing. R3-FUND-03 (b): a recorded verdict is answered after one read of the row at the latest block, which may show the verdict was wrong.
// Everything runs on the EVM matrix world (tests/helpers/matrix-worlds.ts) over the stateful mock node; nothing is mocked in the flow.

import { describe, expect, it } from "vitest";

import { decodeFunctionData, type Address, type Hex } from "viem";

import { LockExistsAfterVerdictError, RefundNotFinalYetError } from "../src/client/buyer.js";
import { RailRecoveryRefusedError } from "../src/client/counter-rail.js";
import { FLOW_MESSAGE, refundLegAWaiting } from "../src/client/rehearsal-run.js";
import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";
import { PREFIX } from "./helpers/crash-matrix.js";
import { EvmMockNode, type SendKind } from "./helpers/evm-mock-node.js";
import { finalityWorld } from "./helpers/finality-world.js";
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

    // the same text again, from the flow that recorded it and from a resumed one, each after ONE read of the lock's row at the latest block (R3-FUND-03 (b)) and no write
    const reads = node.requests.length;
    const resumedAgain = await resumedBuyer(s);
    expect(resumedAgain.next).toBe("done");
    const second = await failure(resumedAgain.flow.refundLegA());
    expect((second as Error).message).toBe(NEVER_LOCKED);
    const third = await failure(resumed.flow.refundLegA());
    expect((third as Error).message).toBe(NEVER_LOCKED);
    const asked = node.requests.slice(reads);
    expect(asked.filter((method) => method === "eth_call"), "a recorded verdict is answered after one row read per call").toHaveLength(2);
    expect(asked.filter((method) => method.startsWith("eth_send")), "and no write").toEqual([]);
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

// R3-FUND-02 (P9 review round 3), the review's case F-A: a lock whose reply was lost sits in an UNSAFE block. At leg A's refund time the row is read at the latest block
// and used to be recorded as landed (evidence); a reorg then drops that block, and a lock cannot land again at or past the refund time, so every later refund reverted on an
// unknown lock for ever and the verdict was out of reach. Evidence now needs a row at the FINALIZED block; a row seen only at the latest block is "not final yet".
describe("R3-FUND-02: a lock seen only at the latest block is not evidence", () => {
  /** The review's state: the lock applied with its reply lost (no evidence), the clock at the refund time + 1 s, and the row deleted right after the FIRST `locks()` read. */
  async function reorgedAfterFirstRead(): Promise<{ s: Started; node: EvmMockNode; key: string }> {
    let node: EvmMockNode | undefined;
    const s = await started(evmWorldWith((n) => void (node = n)), PREFIX);
    node!.loseNextSendReply("lock"); // the lock is applied in an (unsafe) block; its reply is lost: attempt, no evidence
    await expect(s.c.buyer.lockLegA()).rejects.toThrow();
    const key = s.w.hashLock.hash.toLowerCase();
    expect(node!.rows.get(key)).toBeDefined();
    expect((await buyerRecordOf(s.w)).lock.evidence).toBeUndefined();
    s.w.setTime(s.w.refundAt.legA + 1);
    const patched = node as unknown as { call: (c: { to?: string; data?: string }) => unknown };
    const original = patched.call.bind(node);
    let seen = 0;
    patched.call = (c) => {
      const answer = original(c);
      try {
        const decoded = decodeFunctionData({ abi: EVM_HASH_RAIL_ABI, data: c.data as Hex });
        if (decoded.functionName === "locks" && node!.rows.has(key) && (seen += 1) === 1) node!.rows.delete(key);
      } catch {
        /* a token call */
      }
      return answer;
    };
    return { s, node: node!, key };
  }

  it("the first refundLegA records no evidence from a row seen only at latest ('not final yet'); once the finalized block is past the refund time with no row, it is the verdict", async () => {
    const { s, node } = await reorgedAfterFirstRead();
    const first = await resumedBuyer(s);
    expect(first.next).toBe("refundLegA");
    expect(await failure(first.flow.refundLegA())).toBeInstanceOf(RefundNotFinalYetError);
    const record = await buyerRecordOf(s.w);
    expect(record.lock.evidence, "no lock evidence from a row that was only at the latest block").toBeUndefined();
    expect(record.lock.neverLanded).toBeUndefined();
    expect(node.rows.size).toBe(0);

    s.w.setTime(s.w.refundAt.legA + 60 * MIN);
    const again = await resumedBuyer(s);
    expect(((await failure(again.flow.refundLegA())) as Error).message).toBe(NEVER_LOCKED);
    expect((await buyerRecordOf(s.w)).lock.neverLanded).toBe(true);
    expect((await resumedBuyer(s)).next).toBe("done");
    expect(node.count("refund")).toBe(0);
  });

  it("--refund (the runner's loop) ends in the verdict, which leg B's refund and the bundle follow as refunded-b: nothing was sent", async () => {
    const { s, node } = await reorgedAfterFirstRead();
    const { world, logs } = finalityWorld(s, node);
    const { flow } = await resumedBuyer(s);
    expect(await refundLegAWaiting(world, flow, s.w.hashLock.hash)).toBeUndefined(); // undefined = leg A was never locked: driveRefund then refunds leg B and replays to refunded-b
    expect(logs.some((line) => line.includes("a lock cannot be ruled out until the finalized block has passed leg A's refund time"))).toBe(true);
    expect((await buyerRecordOf(s.w)).lock.neverLanded).toBe(true);
    expect(s.w.counts()).toEqual({ locks: 1, claims: 0, refunds: 0, refundBuilds: 0 }); // the one lock is the setup's
  });
});

// R3-FUND-03 (b), the review's case F-D: the verdict is permanent and used to be answered with no read, so a lock that does exist after all (a verdict reached on a
// weaker "finalized" block, or through another endpoint) was never refunded by the flow and the run ended refunded-b. One read of the row at the latest block now turns that
// into a typed refusal for a person, and sends nothing.
describe("R3-FUND-03 (b): a lock of this Buyer that exists after the verdict is a refusal for a person", () => {
  const lockRow = (s: Started, node: EvmMockNode, payer: Address): void => {
    node.rows.set(s.w.hashLock.hash.toLowerCase(), {
      payer,
      payee: s.w.addresses.seller as Address,
      token: node.token,
      amount: 1n,
      claimByMs: BigInt(s.w.refundAt.legA - 30 * MIN),
      refundAfterMs: BigInt(s.w.refundAt.legA),
      status: 1,
    });
  };

  it("after the verdict, a Buyer-owned Locked row gives LockExistsAfterVerdictError naming the hash lock (not the never-locked text), nothing sent, the verdict untouched; a row of another payer, or none, keeps the verdict", async () => {
    const { s, node } = await guardStalled();
    s.w.setTime(s.w.refundAt.legA + 1);
    const first = await resumedBuyer(s);
    expect(((await failure(first.flow.refundLegA())) as Error).message).toBe(NEVER_LOCKED);
    expect((await buyerRecordOf(s.w)).lock.neverLanded).toBe(true);

    lockRow(s, node, "0x00000000000000000000000000000000000000f1" as Address); // a squatter's row: it cannot be this Buyer's lock
    const squatted = await failure((await resumedBuyer(s)).flow.refundLegA());
    expect((squatted as Error).message).toBe(NEVER_LOCKED);

    lockRow(s, node, s.w.addresses.buyer as Address); // the Buyer's own lock, after all
    const again = await resumedBuyer(s);
    expect(again.next, "the record still says done").toBe("done");
    const error = await failure(again.flow.refundLegA());
    expect(error).toBeInstanceOf(LockExistsAfterVerdictError);
    expect((error as Error).message).toContain(s.w.hashLock.hash);
    expect((error as Error).message).toMatch(/refund it by hand/);
    expect((error as Error).message).not.toMatch(/never locked, nothing to refund/);
    expect(FLOW_MESSAGE.neverLocked.test((error as Error).message), "the runner does not read it as the verdict").toBe(false);
    expect(FLOW_MESSAGE.legAClaimed.test((error as Error).message) || FLOW_MESSAGE.refundUnconfirmed.test((error as Error).message)).toBe(false);
    expect(s.w.counts()).toEqual(NO_CHAIN_WRITES);
    expect((await buyerRecordOf(s.w)).lock.neverLanded, "the record is not rewritten").toBe(true);

    node.rows.delete(s.w.hashLock.hash.toLowerCase());
    expect(((await failure((await resumedBuyer(s)).flow.refundLegA())) as Error).message).toBe(NEVER_LOCKED);
  });

  it("the runner's loop does not turn it into a verdict: refundLegAWaiting throws it, so --refund exits 4 with the by-hand text", async () => {
    const { s, node } = await guardStalled();
    s.w.setTime(s.w.refundAt.legA + 1);
    await failure((await resumedBuyer(s)).flow.refundLegA());
    lockRow(s, node, s.w.addresses.buyer as Address);
    const { world } = finalityWorld(s, node);
    await expect(refundLegAWaiting(world, (await resumedBuyer(s)).flow, s.w.hashLock.hash)).rejects.toThrow(/a lock exists under hash lock 0x[0-9a-f]{64} although the recorded verdict said .*refund it by hand/);
  });
});
