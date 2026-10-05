// SPDX-License-Identifier: MIT
//
// tests/rail-recovery-sol.test.ts: P8-RESUME-SPEC.md "Rail seam" and "Rail recovery" for the Solana leg. A Buyer that
// dies between `prepareLock` and the end of `commitLock` (or between a refund's signing and its confirmation) must
// find out what became of the ONE transaction it signed, from the signature record it persisted:
//   - `prepareLock` hands out the signature, blockhash, last valid height and signing slot;
//   - `recoverLock` / `recoverRefund` resolve that record by signature (`SolHtlcRail.recoverBySignature`): landed
//     once finalized, pending while the blockhash is valid or the node cannot speak for the signing slot,
//     never-landed only when the blockhash expired with no status and the ledger covers the slot;
//   - a refund hands its record to `onSigned` before anything is simulated or sent, like the Seller's claim does.
// Runs on the REAL Solana rail over the stateful fake node (the program's state machine, no validator).

import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { RailRecoveryRefusedError, type ConnectedCounterAssetRail, type LockRecovery, type PreparedLock } from "../src/client/counter-rail.js";
import { SolLockRefusedError, SolRefundFailedError } from "../src/rails/sol-htlc.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { lockedFlow, pairWithLines, solHarness, type SolHarness } from "./helpers/sol-flow-harness.js";

function signatureOf(base64Tx: string): string {
  return base58.encode(Buffer.from(base64Tx, "base64").subarray(1, 65));
}

/** The leg's lock terms and both parties' proven wallets, as the Buyer flow would resolve them. */
function legOf(h: SolHarness, p: { offerA: Parameters<typeof offerAcceptLockTerms>[0]; acceptA: Parameters<typeof offerAcceptLockTerms>[1] }) {
  return { terms: offerAcceptLockTerms(p.offerA, p.acceptA), accounts: { payer: h.buyerWallet.publicKey, payee: h.sellerWallet.publicKey } };
}

async function prepare(h: SolHarness, leg: ReturnType<typeof legOf>): Promise<{ rail: ConnectedCounterAssetRail; prepared: PreparedLock; recovery: Extract<LockRecovery, { chain: "sol" }> }> {
  const rail = await h.buyerRail.connect(leg.terms, leg.accounts);
  const prepared = await rail.prepareLock(leg.terms, 0);
  if (prepared.recovery?.chain !== "sol") throw new Error("test: expected a sol recovery handle");
  return { rail, prepared, recovery: prepared.recovery };
}

const fresh = (h: SolHarness, leg: ReturnType<typeof legOf>): Promise<ConnectedCounterAssetRail> => h.buyerRail.connect(leg.terms, leg.accounts); // a restarted process connects anew

describe("Solana prepareLock: the recovery handle", () => {
  it("returns the signature, blockhash, last valid height and signing slot next to the ref, and sends nothing", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { prepared, recovery } = await prepare(h, leg);
    expect(prepared.ref).toBe(`${p.statement}:${h.buyerWallet.publicKey}`);
    expect(base58.decode(recovery.signature)).toHaveLength(64);
    expect(recovery.blockhash).toBe(h.node.chain.blockhash);
    expect(recovery.lastValidBlockHeight).toBe(h.node.chain.lastValidBlockHeight);
    expect(typeof recovery.signedSlot).toBe("number");
    expect(h.node.sent.lock).toBe(0);
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared); // plain JSON data
  });

  it("commitLock sends the transaction whose signature was handed out", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const { rail, recovery } = await prepare(h, legOf(h, p));
    const evidence = await rail.commitLock();
    expect(evidence.txHash).toBe(recovery.signature);
    expect(h.node.history.map((t) => [t.kind, t.signature])).toEqual([["lock", recovery.signature]]);
  });
});

describe("Solana recoverLock", () => {
  it("a lock that landed with its reply lost is landed, found by signature, and nothing is sent again", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { rail, prepared } = await prepare(h, leg);
    h.node.dropNextSendReplyFor = "lock";
    await expect(rail.commitLock()).rejects.toThrow(/connection reset/);
    // the process "restarts": a new connected handle, only the persisted PreparedLock in hand
    await expect((await fresh(h, leg)).recoverLock(prepared)).resolves.toBe("landed");
    expect(h.node.sent.lock).toBe(1);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
  });

  it("signed but never sent (a crash before commitLock): pending while the blockhash is valid, never-landed once it expired; a fresh prepare is then allowed", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { prepared, recovery } = await prepare(h, leg);
    const restarted = await fresh(h, leg);
    await expect(restarted.recoverLock(prepared)).resolves.toBe("pending");
    h.node.chain.finalizedHeight = recovery.lastValidBlockHeight; // the last valid height itself is still valid
    await expect(restarted.recoverLock(prepared)).resolves.toBe("pending");
    h.node.chain.finalizedHeight = recovery.lastValidBlockHeight + 1;
    await expect(restarted.recoverLock(prepared)).resolves.toBe("never-landed");
    expect(h.node.sent.lock).toBe(0); // recovery sent and signed nothing

    // never-landed is the proof that building a fresh lock is safe: it lands, and the OLD record still says never-landed
    h.node.chain.finalizedHeight = 4_900;
    h.node.chain.blockhash = base58.encode(new Uint8Array(32).fill(0x55)); // a real chain hands out a new blockhash
    h.node.chain.lastValidBlockHeight = 5_300;
    const second = await prepare(h, leg);
    expect(second.recovery.signature).not.toBe(recovery.signature);
    await second.rail.commitLock();
    expect(h.node.sent.lock).toBe(1);
    h.node.chain.finalizedHeight = recovery.lastValidBlockHeight + 1;
    await expect((await fresh(h, leg)).recoverLock(prepared)).resolves.toBe("never-landed");
    await expect((await fresh(h, leg)).recoverLock(second.prepared)).resolves.toBe("landed");
  });

  it("accepted by the node but not landed: pending until the blockhash expires, then never-landed", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { rail, prepared, recovery } = await prepare(h, leg);
    h.node.chain.once("sendTransaction", (params) => signatureOf(params[0] as string)); // accepted, never lands
    await expect(rail.commitLock()).rejects.toThrow(/not settled yet|Pending/i);
    const restarted = await fresh(h, leg);
    await expect(restarted.recoverLock(prepared)).resolves.toBe("pending");
    h.node.chain.finalizedHeight = recovery.lastValidBlockHeight + 1;
    await expect(restarted.recoverLock(prepared)).resolves.toBe("never-landed");
    expect(h.node.sent.lock).toBe(0);
  });

  it("a node whose ledger starts after the signing slot cannot prove never-landed: pending even after expiry (R3-4)", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { prepared, recovery } = await prepare(h, leg);
    h.node.chain.finalizedHeight = recovery.lastValidBlockHeight + 1;
    h.node.chain.firstAvailableBlock = (recovery.signedSlot ?? 0) + 1_000;
    await expect((await fresh(h, leg)).recoverLock(prepared)).resolves.toBe("pending");
    h.node.chain.firstAvailableBlock = 0;
    await expect((await fresh(h, leg)).recoverLock(prepared)).resolves.toBe("never-landed");
  });

  it("a lock transaction that landed and FAILED propagates its typed error (never folded into never-landed)", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { rail, prepared } = await prepare(h, leg);
    h.node.midFlight = (kind) => {
      if (kind === "lock") h.node.closeToken(h.buyerWallet.publicKeyBytes); // the payer's token account vanishes after the preflight
    };
    await expect(rail.commitLock()).rejects.toBeInstanceOf(SolLockRefusedError);
    h.node.midFlight = undefined;
    await expect((await fresh(h, leg)).recoverLock(prepared)).rejects.toBeInstanceOf(SolLockRefusedError);
  });

  it("a transport failure while asking is an error, not a verdict", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { prepared } = await prepare(h, leg);
    const restarted = await fresh(h, leg);
    h.node.chain.once("getSignatureStatuses", () => {
      throw new Error("connection reset (test: transport failure while polling)");
    });
    await expect(restarted.recoverLock(prepared)).rejects.toThrow(/connection reset/);
    await expect(restarted.recoverLock(prepared)).resolves.toBe("pending"); // and it asks again fine
  });

  it("refuses a missing handle, another rail's handle, and a handle or ref that is not this leg's own, before any call", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const leg = legOf(h, p);
    const { rail, prepared, recovery } = await prepare(h, leg);
    const before = h.node.chain.requests.length;
    const otherPayerRef = `${p.statement}:${h.sellerWallet.publicKey}`;
    const otherHashRef = `0x${"99".repeat(32)}:${h.buyerWallet.publicKey}`;
    const cases: Array<[string, PreparedLock, string]> = [
      ["no handle", { ref: prepared.ref }, "no-handle"],
      ["another rail's handle", { ref: prepared.ref, recovery: { chain: "btc", txid: "aa".repeat(32), rawTx: "00" } }, "handle-mismatch"],
      ["a ref that is not a sol ref", { ref: p.statement, recovery }, "handle-mismatch"],
      ["a ref for another payer", { ref: otherPayerRef, recovery }, "handle-mismatch"],
      ["a ref for another hash lock", { ref: otherHashRef, recovery }, "handle-mismatch"],
      ["an unusable last valid height", { ref: prepared.ref, recovery: { ...recovery, lastValidBlockHeight: -1 } }, "handle-mismatch"],
      ["an empty signature", { ref: prepared.ref, recovery: { ...recovery, signature: "" } }, "handle-mismatch"],
    ];
    for (const [label, prep, code] of cases) {
      const error = await rail.recoverLock(prep).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(RailRecoveryRefusedError);
      expect((error as RailRecoveryRefusedError).code, label).toBe(code);
    }
    expect(h.node.chain.requests.length).toBe(before);
  });
});

// -- refund: record before send ----------------------------------------------------------------------------------------

describe("Solana refund: onSigned / onNotBroadcast", () => {
  async function lockedAndDue() {
    const h = solHarness();
    const p = await lockedFlow(h);
    const leg = legOf(h, p);
    h.setTime(p.offerA.refundAfterMs + 60_000); // chain time is past refundAfterMs
    return { h, p, leg, ref: p.ref };
  }

  it("hands the refund's signature record to onSigned BEFORE anything is simulated or sent, and that is the signature that lands", async () => {
    const { h, leg, ref } = await lockedAndDue();
    const rail = await fresh(h, leg);
    const events: Array<{ recovery: LockRecovery; sentSoFar: number; simulationsSoFar: number }> = [];
    const evidence = await rail.refund(ref, {
      onSigned: (recovery) => {
        events.push({ recovery, sentSoFar: h.node.sent.refund, simulationsSoFar: h.node.chain.count("simulateTransaction") });
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.sentSoFar).toBe(0);
    const recovery = events[0]?.recovery;
    if (recovery?.chain !== "sol") throw new Error("expected a sol handle");
    expect(recovery.signature).toBe(evidence.txHash);
    expect(h.node.history.filter((t) => t.kind === "refund").map((t) => t.signature)).toEqual([recovery.signature]);
    expect(h.node.escrow(leg.terms.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
    // the simulation count at onSigned time is what it was before the refund simulated (it simulates after recording)
    expect(h.node.chain.count("simulateTransaction")).toBeGreaterThan(events[0]?.simulationsSoFar ?? 99);
  });

  it("an onSigned that fails (the store write failed) stops the refund before anything is simulated or sent", async () => {
    const { h, leg, ref } = await lockedAndDue();
    const rail = await fresh(h, leg);
    const simulationsBefore = h.node.chain.count("simulateTransaction");
    await expect(
      rail.refund(ref, {
        onSigned: () => {
          throw new Error("store write failed");
        },
      }),
    ).rejects.toThrow(/store write failed/);
    expect(h.node.sent.refund).toBe(0);
    expect(h.node.chain.count("simulateTransaction")).toBe(simulationsBefore);
  });

  it("onNotBroadcast fires with the same record when the simulation refused the refund (it never reached the network)", async () => {
    const { h, leg, ref } = await lockedAndDue();
    const rail = await fresh(h, leg);
    h.node.chain.override("simulateTransaction", (_p, c) => ({ context: c.ctx("confirmed"), value: { err: { InstructionError: [0, { Custom: 17 }] }, logs: [], unitsConsumed: 1 } }));
    const signed: LockRecovery[] = [];
    const dropped: LockRecovery[] = [];
    await expect(rail.refund(ref, { onSigned: (r) => void signed.push(r), onNotBroadcast: (r) => void dropped.push(r) })).rejects.toThrow();
    expect(signed).toHaveLength(1);
    expect(dropped).toEqual(signed);
    expect(h.node.sent.refund).toBe(0);
  });

  it("with no options the refund behaves exactly as before", async () => {
    const { h, leg, ref } = await lockedAndDue();
    const rail = await fresh(h, leg);
    await expect(rail.refund(ref)).resolves.toMatchObject({ ref });
    expect(h.node.sent.refund).toBe(1);
  });
});

describe("Solana recoverRefund", () => {
  async function dueAndSigned() {
    const h = solHarness();
    const p = await lockedFlow(h);
    const leg = legOf(h, p);
    h.setTime(p.offerA.refundAfterMs + 60_000);
    let recovery: LockRecovery | undefined;
    const rail = await fresh(h, leg);
    return {
      h,
      p,
      leg,
      ref: p.ref,
      sign: async (): Promise<Extract<LockRecovery, { chain: "sol" }>> => {
        await rail.refund(p.ref, { onSigned: (r) => void (recovery = r) }).catch(() => undefined);
        if (recovery?.chain !== "sol") throw new Error("expected a sol handle");
        return recovery;
      },
    };
  }

  it("a refund that landed with its reply lost is landed, found by signature; no second refund is sent", async () => {
    const { h, leg, ref, sign } = await dueAndSigned();
    h.node.dropNextSendReplyFor = "refund";
    const recovery = await sign();
    expect(h.node.escrow(leg.terms.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
    await expect((await fresh(h, leg)).recoverRefund?.(ref, recovery)).resolves.toBe("landed");
    expect(h.node.sent.refund).toBe(1);
  });

  it("signed and accepted but not landed: pending until the blockhash expires, then never-landed (a fresh refund may then be built)", async () => {
    const { h, leg, ref, sign } = await dueAndSigned();
    h.node.chain.once("sendTransaction", (params) => signatureOf(params[0] as string));
    const recovery = await sign();
    const restarted = await fresh(h, leg);
    await expect(restarted.recoverRefund?.(ref, recovery)).resolves.toBe("pending");
    h.node.chain.finalizedHeight = recovery.lastValidBlockHeight + 1;
    await expect(restarted.recoverRefund?.(ref, recovery)).resolves.toBe("never-landed");
    expect(h.node.sent.refund).toBe(0);
    // the proof allows one more refund, which lands
    h.node.chain.finalizedHeight = 4_900;
    await expect((await fresh(h, leg)).refund(ref)).resolves.toMatchObject({ ref });
    expect(h.node.sent.refund).toBe(1);
  });

  it("a refund transaction that landed and FAILED propagates SolRefundFailedError", async () => {
    const { h, leg, ref, sign } = await dueAndSigned();
    h.node.midFlight = (kind) => {
      if (kind === "refund") h.node.closeToken(h.buyerWallet.publicKeyBytes); // the payer's token account vanishes after the preflight
    };
    const recovery = await sign();
    h.node.midFlight = undefined;
    await expect((await fresh(h, leg)).recoverRefund?.(ref, recovery)).rejects.toBeInstanceOf(SolRefundFailedError);
  });

  it("a handle for another rail, or a ref that is not this leg's own, is refused before any call", async () => {
    const { h, leg, ref, sign } = await dueAndSigned();
    const recovery = await sign();
    const rail = await fresh(h, leg);
    const before = h.node.chain.requests.length;
    await expect(rail.recoverRefund?.(ref, { chain: "near", txHash: "x", signedTxBase64: "AAAA" })).rejects.toBeInstanceOf(RailRecoveryRefusedError);
    await expect(rail.recoverRefund?.(`${leg.terms.statement}:${h.sellerWallet.publicKey}`, recovery)).rejects.toBeInstanceOf(RailRecoveryRefusedError);
    expect(h.node.chain.requests.length).toBe(before);
  });
});
