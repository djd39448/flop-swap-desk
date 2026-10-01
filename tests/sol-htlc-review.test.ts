// SPDX-License-Identifier: MIT
//
// tests/sol-htlc-review.test.ts - the fixes for the Solana TypeScript review (findings SOL-A1..A6), each with
// a test that fails without it. Same scripted fake node as tests/sol-htlc.test.ts (tests/helpers/sol-fake-chain.ts);
// the live twins of A1, A2, A3 and A4 are in tests-sol/sol-htlc.sol.test.ts.

import { describe, expect, it } from "vitest";

import { SolClaimFailedError, SolClaimTooLateError, SolHtlcRail, SolLockRefusedError, claimInstructionData, SOL_HTLC_PROGRAM_ID } from "../src/rails/sol-htlc.js";
import { InMemorySolSigner } from "../src/rails/sol-signer-memory.js";
import { TOKEN_PROGRAM_ID } from "../src/rails/sol-spl.js";
import { compileLegacyMessage, isSmallOrderOrNonCanonical, pubkeyFromBase58, pubkeyToBase58, signTransaction, type SolTransaction } from "../src/rails/sol-tx.js";
import { makeWorld, putLockedEscrow, tokenAccountBytes, type World } from "./helpers/sol-fake-chain.js";

const NOW = 1_800_000_000_000;

async function railFor(w: World, signer: InMemorySolSigner = w.buyer): Promise<SolHtlcRail> {
  return SolHtlcRail.connect({ config: w.config, rpc: w.rpc, signer, clock: w.clock, sleep: w.sleep, pollIntervalMs: 10, finalityTimeoutMs: 100 });
}

const OK = (): { slot: number; confirmations: null; err: null; confirmationStatus: "finalized" } => ({ slot: 5_000, confirmations: null, err: null, confirmationStatus: "finalized" });
const CUSTOM = (n: number): unknown => ({ InstructionError: [0, { Custom: n }] });

function setVault(w: World, amount: bigint): void {
  w.chain.put(w.keys.vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.keys.escrow, amount }), executable: false });
}

function claimOnSend(w: World): void {
  w.chain.onSend = (tx, chain) => {
    chain.statuses.set(tx.signature, OK());
    putLockedEscrow(w, { status: "Claimed", preimage: w.preimage, amount: 0n });
  };
}

/** A signed claim transaction as it would sit in the escrow's history. */
async function claimTx(w: World): Promise<SolTransaction> {
  const message = compileLegacyMessage({
    feePayer: w.seller.publicKeyBytes,
    recentBlockhash: new Uint8Array(32).fill(1),
    instructions: [
      {
        programId: pubkeyFromBase58(SOL_HTLC_PROGRAM_ID),
        accounts: [
          { pubkey: w.keys.escrow, isSigner: false, isWritable: true },
          { pubkey: w.keys.vault, isSigner: false, isWritable: true },
        ],
        data: claimInstructionData(w.preimage),
      },
    ],
  });
  return signTransaction(message, [w.seller]);
}

function historyWithFailedClaim(w: World, tx: SolTransaction): void {
  w.chain.addressSignatures.set(pubkeyToBase58(w.keys.escrow), [{ signature: tx.signature, slot: 4_000, err: CUSTOM(17) }]);
  w.chain.transactions.set(tx.signature, { slot: 4_000, blockTime: null, err: CUSTOM(17), bytes: tx.bytes });
}

describe("SOL-A1: a stray donation to the vault does not turn a landed lock into 'nothing was locked'", () => {
  it("commitLock resolves when the vault holds MORE than the amount at the confirm read", async () => {
    const w = makeWorld();
    w.chain.onSend = (tx, chain) => {
      chain.statuses.set(tx.signature, OK());
      putLockedEscrow(w);
      setVault(w, BigInt(w.terms.amount) + 1n); // a third party donated 1 unit
    };
    const rail = await railFor(w);
    const record = await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).resolves.toMatchObject({ ref: w.ref, signature: record.signature });
  });

  it("recoverBySignature resolves the same way", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    const record = await rail.prepareLock(w.terms);
    w.chain.statuses.set(record.signature, OK());
    putLockedEscrow(w);
    setVault(w, BigInt(w.terms.amount) + 1n);
    await expect(rail.recoverBySignature(record)).resolves.toMatchObject({ signature: record.signature });
  });

  it("a vault holding LESS than the amount is still a refused lock", async () => {
    const w = makeWorld();
    w.chain.onSend = (tx, chain) => {
      chain.statuses.set(tx.signature, OK());
      putLockedEscrow(w);
      setVault(w, BigInt(w.terms.amount) - 1n);
    };
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).rejects.toBeInstanceOf(SolLockRefusedError);
  });
});

describe("SOL-A2: a claim whose secret is already public can be retried inside the old landing bounds", () => {
  // refund window 130 s out: a fresh blockhash could still land past it (138.6 s at the slow estimate), so the
  // ordinary claim is refused as too late; but if an earlier claim already published the secret that refusal
  // only stops the Seller from being paid.
  const tight = (): World => makeWorld({ refundAfterMs: NOW + 130_000, claimByMs: NOW + 5_000 });

  it("without the flag the same claim is refused as too late (the private-secret rule is unchanged)", async () => {
    const w = tight();
    putLockedEscrow(w);
    historyWithFailedClaim(w, await claimTx(w));
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).rejects.toBeInstanceOf(SolClaimTooLateError);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("with retryPublicSecret and an on-chain proof the claim is sent, even past notAfterMs and the landing bound", async () => {
    const w = tight();
    putLockedEscrow(w);
    const failed = await claimTx(w);
    historyWithFailedClaim(w, failed);
    claimOnSend(w);
    w.now.ms = NOW + 60_000; // already past notAfterMs (NOW + 5 s)
    w.chain.finalizedTimeMs = NOW + 60_000;
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs, undefined, { retryPublicSecret: true, proofSignature: failed.signature })).resolves.toMatchObject({ ref: w.ref });
    expect(w.chain.count("simulateTransaction")).toBe(1);
    expect(w.chain.count("sendTransaction")).toBe(1);
  });

  it("S2-2/S2-3: the proof is the named transaction only: a failed claim sitting in the escrow's history is not a proof without its signature", async () => {
    const w = tight();
    putLockedEscrow(w);
    historyWithFailedClaim(w, await claimTx(w));
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs, undefined, { retryPublicSecret: true })).rejects.toThrow(/no claim carrying this preimage/);
    expect(w.chain.count("getSignaturesForAddress")).toBe(0);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("the flag needs on-chain proof that this preimage is public: without a failed claim in the history it is refused and nothing is signed or sent", async () => {
    const w = tight();
    putLockedEscrow(w);
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs, undefined, { retryPublicSecret: true })).rejects.toThrow(/no claim carrying this preimage/);
    expect(w.chain.count("simulateTransaction")).toBe(0);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("the retry still stops once chain time is at/after refundAfterMs, and still needs a Locked escrow and a simulation that passes", async () => {
    const w = tight();
    putLockedEscrow(w);
    const failed = await claimTx(w);
    historyWithFailedClaim(w, failed);
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    w.now.ms = NOW + 130_000;
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs, undefined, { retryPublicSecret: true, proofSignature: failed.signature })).rejects.toThrow(/at\/after refundAfterMs/);

    const w2 = tight();
    putLockedEscrow(w2);
    const failed2 = await claimTx(w2);
    historyWithFailedClaim(w2, failed2);
    w2.chain.simulateErr = CUSTOM(17);
    const rail2 = await railFor(w2, w2.seller);
    await expect(rail2.claim(w2.ref, w2.preimageHex, w2.terms.claimByMs, undefined, { retryPublicSecret: true, proofSignature: failed2.signature })).rejects.toThrow();
    expect(w2.chain.count("sendTransaction")).toBe(0);
  });
});

describe("SOL-A3: a claim whose own deadline has passed is neither signed nor simulated", () => {
  it("throws before onSigned and before any simulateTransaction/sendTransaction exchange", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    let signed = 0;
    await expect(rail.claim(w.ref, w.preimageHex, NOW - 60_000, () => void (signed += 1))).rejects.toThrow(/has already passed/);
    expect(signed).toBe(0);
    expect(w.chain.count("simulateTransaction")).toBe(0);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });
});

describe("SOL-A4: a claim that failed only because another transaction already claimed is not 'retry at once'", () => {
  it("send path: the failed claim resolves to evidence flagged claimedByAnotherTransaction when the escrow is Claimed with our preimage", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.onSend = (tx, chain) => {
      chain.statuses.set(tx.signature, { slot: 5_000, confirmations: null, err: CUSTOM(18), confirmationStatus: "finalized" }); // NotLocked
      putLockedEscrow(w, { status: "Claimed", preimage: w.preimage, amount: 0n });
    };
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).resolves.toMatchObject({ ref: w.ref, claimedByAnotherTransaction: true });
  });

  it("recoverBySignature resolves the same way; a Locked escrow, a different stored preimage, or a failed escrow read still throw SolClaimFailedError", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const rail = await railFor(w, w.seller);
    const record = { kind: "claim" as const, ref: w.ref, signature: "sig", blockhash: w.chain.blockhash, lastValidBlockHeight: w.chain.lastValidBlockHeight };
    w.chain.statuses.set("sig", { slot: 5_000, confirmations: null, err: CUSTOM(18), confirmationStatus: "finalized" });

    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolClaimFailedError); // still Locked
    putLockedEscrow(w, { status: "Claimed", preimage: new Uint8Array(32).fill(1), amount: 0n });
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolClaimFailedError); // preimage does not open the lock
    putLockedEscrow(w, { status: "Claimed", preimage: w.preimage, amount: 0n });
    await expect(rail.recoverBySignature(record)).resolves.toMatchObject({ claimedByAnotherTransaction: true });
    w.chain.override("getMultipleAccounts", () => {
      throw new Error("ECONNRESET");
    });
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolClaimFailedError); // fail closed
  });

  it("lock and refund kinds are unchanged: a failed status is never rescued by escrow state", async () => {
    const w = makeWorld();
    putLockedEscrow(w, { status: "Claimed", preimage: w.preimage, amount: 0n });
    const rail = await railFor(w);
    const base = { ref: w.ref, signature: "sig2", blockhash: w.chain.blockhash, lastValidBlockHeight: w.chain.lastValidBlockHeight };
    w.chain.statuses.set("sig2", { slot: 5_000, confirmations: null, err: CUSTOM(18), confirmationStatus: "finalized" });
    await expect(rail.recoverBySignature({ ...base, kind: "lock" })).rejects.toBeInstanceOf(SolLockRefusedError);
  });
});

describe("SOL-A6: a payee that is a small-order or non-canonical ed25519 point is refused", () => {
  const identity = (): Uint8Array => {
    const b = new Uint8Array(32);
    b[0] = 1; // y = 1: the identity point
    return b;
  };
  const orderTwo = (): Uint8Array => {
    const b = new Uint8Array(32).fill(0xff);
    b[0] = 0xec; // y = p - 1: the point (0, -1) of order 2
    b[31] = 0x7f;
    return b;
  };

  it("the helper classifies small-order, non-canonical and ordinary keys", () => {
    expect(isSmallOrderOrNonCanonical(identity())).toBe(true);
    expect(isSmallOrderOrNonCanonical(orderTwo())).toBe(true);
    const nonCanonical = identity();
    nonCanonical.fill(0xff, 1, 31);
    nonCanonical[0] = 0xee; // y = p + 1 written out, which decodes as the identity when reduced
    nonCanonical[31] = 0x7f;
    expect(isSmallOrderOrNonCanonical(nonCanonical)).toBe(true);
    expect(isSmallOrderOrNonCanonical(pubkeyFromBase58(makeWorld().seller.publicKey))).toBe(false);
    expect(isSmallOrderOrNonCanonical(new Uint8Array(31))).toBe(true);
  });

  it("prepareLock refuses them before any read of the chain for the lock", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    for (const key of [identity(), orderTwo()]) {
      await expect(rail.prepareLock({ ...w.terms, payee: pubkeyToBase58(key) })).rejects.toThrow(/small-order or non-canonical/);
    }
    expect(w.chain.count("sendTransaction")).toBe(0);
  });
});
