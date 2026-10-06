// SPDX-License-Identifier: MIT
//
// R2-15 (P8-FIXES-R2.md, test only): R1-08's Solana "landed and failed" refund at the FLOW level, the counterpart of the NEAR test in
// tests/flow-resume-near.test.ts. A Solana refund can LAND on chain with an error (here: the program's own clock lags behind the flow's,
// so the program refuses a refund the flow thought was due, after the node's preflight already passed). A transaction that landed can
// never land again, so the recorded refund is resolved: `recoverRefund` throws `SolRefundFailedError` for its handle, the escrow reads
// Locked and final, nobody claimed, and EXACTLY ONE fresh refund follows. The flow treats the typed error as an outcome only through
// `isLandedAndFailedRefund` (buyer.ts): remove `SolRefundFailedError` from it and the second call below rethrows the failure for ever.
//
// The real BuyerFlow with a store over the real Solana rail over the stateful Solana node (the rig of tests/flow-resume-sol.test.ts).

import { dealRoom } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { SolRefundFailedError } from "../src/rails/sol-htlc.js";
import { buyerRecord, framesOf, legA, restartBuyer, rig, toLocked } from "./helpers/resume-sol-rig.js";

describe("R2-15 (Solana): a refund that landed and failed is resolved, and exactly one fresh refund follows", () => {
  it("the program's clock lags behind the flow's: the first refund lands with an error, the restart resolves it, one fresh refund refunds the escrow", async () => {
    const r = rig();
    const { node } = r.h;
    const p = await toLocked(r);
    const escrowOf = () => node.escrow(p.accepted.acceptA.statement, r.h.buyerWallet.publicKey);
    expect(escrowOf()?.status).toBe("Locked");

    // the flow's clock says leg A's refund time has come; the program's own clock (finalized block time) is a minute behind it after the
    // node's preflight passed: the refund is sent, lands, and the program refuses it
    r.h.setTime(legA.refundAfterMs);
    node.midFlight = (kind) => {
      if (kind === "refund") node.nowMs = legA.refundAfterMs - 60_000;
    };
    await expect(r.buyer.refundLegA()).rejects.toBeInstanceOf(SolRefundFailedError);
    expect(node.sent.refund).toBe(1);
    const landed = node.history.filter((entry) => entry.kind === "refund");
    expect(landed).toHaveLength(1);
    expect(landed[0]?.err, "the refund LANDED with an error").not.toBeNull();
    expect(escrowOf()?.status, "the escrow reads Locked: nothing was refunded and nobody claimed").toBe("Locked");
    const failed = await buyerRecord(r);
    expect(failed.refund.attempted).toBe(true);
    const failedHandle = failed.refund.recovery;
    if (failedHandle?.chain !== "sol") throw new Error("expected the failed refund's Solana handle to be saved");
    expect(failed.refund.evidence).toBeUndefined();

    // the program's clock catches up; the process restarts: `recoverRefund` throws SolRefundFailedError for the saved handle, which the
    // flow resolves (the lock reads Locked and final), and ONE fresh refund is built, sent and confirmed
    node.midFlight = undefined;
    node.nowMs = legA.refundAfterMs;
    expect(await restartBuyer(r)).toBe("refundLegA");
    await r.buyer.refundLegA();

    expect(node.sent.refund, "the failed refund and exactly one fresh one").toBe(2);
    expect(escrowOf()?.status).toBe("Refunded");
    const refunded = await buyerRecord(r);
    expect(refunded.refund.evidence, "the evidence is recorded").toBeDefined();
    expect(refunded.refund.framesPosted).toBe(true);
    const freshHandle = refunded.refund.recovery;
    if (freshHandle?.chain !== "sol") throw new Error("expected the fresh refund's Solana handle");
    expect(freshHandle.signature, "the failed refund's handle was replaced by the fresh refund's").not.toBe(failedHandle.signature);
    for (const type of ["refund", "receipt"]) expect(await framesOf(r, dealRoom(p.contractA), type)).toHaveLength(1);
    expect(await restartBuyer(r)).toBe("done");
    expect(node.sent.refund, "a later call refunds nothing more").toBe(2);
    await r.buyer.refundLegA();
    expect(node.sent.refund).toBe(2);
  });

  it("while the program's clock still lags, every call says so with the typed error and builds at most ONE more refund per call", async () => {
    const r = rig();
    const { node } = r.h;
    await toLocked(r);
    r.h.setTime(legA.refundAfterMs);
    node.midFlight = (kind) => {
      if (kind === "refund") node.nowMs = legA.refundAfterMs - 60_000;
    };
    await expect(r.buyer.refundLegA()).rejects.toBeInstanceOf(SolRefundFailedError);
    await restartBuyer(r);
    node.nowMs = legA.refundAfterMs; // the preflight passes again; the hook lags the program's clock once more before the refund executes
    await expect(r.buyer.refundLegA()).rejects.toBeInstanceOf(SolRefundFailedError);
    expect(node.sent.refund, "the failed one, then one more per call").toBe(2);
  });
});
