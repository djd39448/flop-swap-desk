// SPDX-License-Identifier: MIT
//
// R3-16 (P8-FIXES-R3.md, decision 7), the Solana twin of tests/flow-resume-lag.test.ts (R2-17, NEAR): after a `never-landed` answer and before the
// saved lock handle is replaced by a fresh `prepareLock`, the Buyer reads the lock by its ref once more, after the rail's short `settleDelay`
// (`SOL_RECHECK_DELAY_MS` on the rail's injected sleep). `never-landed` is proven only against a consistent node: one member of a load-balanced
// Solana endpoint can lag behind the rest, so the first status read can say "no status, blockhash expired, no such transaction" for a lock that
// landed. The lock found by the second read is recorded as landed and NOTHING new is signed; without the second read the flow replaced the saved
// handle and sent a fresh lock (which the program refuses as a duplicate: the original lock was never announced, so the Seller never claimed it and
// the swap was lost to a refund).
//
// The real BuyerFlow and SellerFlow over the real Solana rail over the stateful node (tests/helpers/sol-stateful-chain.ts), hermetic, no validator.
// The lagging read is the fake chain's `lagUntilMs`: the node hides the lock's signature, its stored transaction and its escrow and vault accounts
// until its clock reaches `lagUntilMs`; the rail's injected sleep (`settleDelay`) is what moves that clock.

import { dealRoom } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { SOL_RECHECK_DELAY_MS } from "../src/client/sol-rail.js";
import { SOL_HTLC_PROGRAM_ID, escrowAddress, vaultAddress } from "../src/rails/sol-htlc.js";
import { pubkeyToBase58 } from "../src/rails/sol-tx.js";
import { ProcessDied, crashRail } from "./helpers/resume-flows.js";
import { buyerRecord, expireBuyerLock, framesOf, restartBuyer, rig, toLines, type Rig } from "./helpers/resume-sol-rig.js";

/** The Buyer's lock landed and its process died right after `commitLock` (the evidence was never saved): the saved record holds the signed handle. */
async function lockLandedProcessDied(): Promise<{ r: Rig; contractA: string; ref: string; signature: string }> {
  const r = rig();
  const p = await toLines(r);
  await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { after: ["commitLock"] }) });
  await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
  expect(r.h.node.sent.lock, "the lock landed").toBe(1);
  const saved = await buyerRecord(r);
  const handle = saved.lock.prepared?.recovery;
  if (handle === undefined || handle.chain !== "sol") throw new Error("test: expected a saved Solana handle");
  expect(saved.lock.evidence, "the process died before the evidence was saved").toBeUndefined();
  return { r, contractA: p.contractA, ref: saved.lock.prepared!.ref, signature: handle.signature };
}

/** The node's own reading is that the signed blockhash has expired (so the rail can answer `never-landed`), and it still lags: it does not hold
 *  the lock's signature, transaction, escrow or vault yet. It catches up once its clock has moved on by `SOL_RECHECK_DELAY_MS`. */
async function makeNodeLag(r: Rig, ref: string, signature: string): Promise<void> {
  await expireBuyerLock(r);
  const chain = r.h.node.chain;
  const [hashLock, payer] = ref.split(":") as [string, string];
  const escrow = escrowAddress(SOL_HTLC_PROGRAM_ID, payer, hashLock).address;
  chain.lagHides.signatures.add(signature);
  chain.lagHides.keys.add(pubkeyToBase58(escrow));
  chain.lagHides.keys.add(pubkeyToBase58(vaultAddress(SOL_HTLC_PROGRAM_ID, escrow).address));
  chain.lagUntilMs = chain.finalizedTimeMs + SOL_RECHECK_DELAY_MS;
}

describe("R3-16 (Solana): a lock that landed behind a lagging read is found by the second read, not replaced", () => {
  it("the first read answers never-landed for a lock that landed: the settleDelay read finds it, it is recorded and announced, and NOTHING new is signed or sent", async () => {
    const { r, contractA, ref, signature } = await lockLandedProcessDied();
    await makeNodeLag(r, ref, signature);
    const chain = r.h.node.chain;
    expect(chain.lagging(), "the node lags when the flow resumes").toBe(true);
    const clockBefore = chain.finalizedTimeMs;

    expect(await restartBuyer(r)).toBe("lockLegA");
    const locked = await r.buyer.lockLegA();

    expect(chain.lagServed, "the lagging node really did answer 'nothing there' to the first reads").toBeGreaterThan(0);
    expect(chain.finalizedTimeMs - clockBefore, "the rail's settleDelay ran: its injected sleep moved the node's clock by SOL_RECHECK_DELAY_MS").toBeGreaterThanOrEqual(SOL_RECHECK_DELAY_MS);
    expect(chain.lagging(), "and the node caught up").toBe(false);
    expect(locked.writeEvidence.ref).toBe(ref);
    // the original lock was adopted: no fresh lock was signed or sent, the saved handle is still the original one
    expect(r.h.node.sent.lock).toBe(1);
    expect(r.h.node.history.filter((tx) => tx.kind === "lock")).toHaveLength(1);
    const record = await buyerRecord(r);
    expect(record.lock.prepared?.recovery).toMatchObject({ chain: "sol", signature });
    expect(record.lock.framePosted, "the lock is announced").toBe(true);
    expect(await framesOf(r, dealRoom(contractA), "lock")).toHaveLength(1);
    expect(await restartBuyer(r)).toBe("learnSecret");
  });

  it("control: a lock that truly never landed is replaced by exactly ONE fresh lock, after the same second read finds nothing", async () => {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { before: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied); // signed and saved, never sent
    expect(r.h.node.sent.lock).toBe(0);
    const saved = await buyerRecord(r);
    await expireBuyerLock(r); // the blockhash expired with no status for the signature: never-landed is provable
    const clockBefore = r.h.node.chain.finalizedTimeMs;

    await restartBuyer(r);
    await r.buyer.lockLegA();
    expect(r.h.node.chain.finalizedTimeMs - clockBefore, "the second read happened after the settleDelay, and found nothing").toBeGreaterThanOrEqual(SOL_RECHECK_DELAY_MS);
    expect(r.h.node.sent.lock, "one fresh lock: the first was never sent").toBe(1);
    expect((await buyerRecord(r)).lock.prepared?.recovery, "the fresh handle replaced the dead one").not.toEqual(saved.lock.prepared?.recovery);
    expect((await buyerRecord(r)).lock.framePosted).toBe(true);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });
});
