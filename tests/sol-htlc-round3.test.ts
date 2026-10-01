// SPDX-License-Identifier: MIT
//
// tests/sol-htlc-round3.test.ts - P6-SOL-FIXES-R3.md Seller items R3-1, R3-2, R3-4, R3-5 at the adapter (the flow
// items R3-2/R3-3 are in tests/client-flows-sol.test.ts), against the scripted fake node. Each test fails without
// its fix (the fix was reverted once to confirm).

import { describe, expect, it } from "vitest";

import { CapturingRpc } from "../src/rails/rpc-capture.js";
import {
  SOL_CLAIM_COMPUTE_UNIT_LIMIT,
  SOL_PRIORITY_FEE_CAP_MICRO_LAMPORTS,
  SOL_PRIORITY_FEE_FLOOR_MICRO_LAMPORTS,
  SOL_REFUND_COMPUTE_UNIT_LIMIT,
  SolClaimTooLateError,
  SolHtlcRail,
  SolNotLandedError,
  SolPendingError,
  type SolPreparedRecord,
} from "../src/rails/sol-htlc.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src/rails/sol-spl.js";
import { pubkeyToBase58, type SolTransaction } from "../src/rails/sol-tx.js";
import { FakeRpcError, makeWorld, putLockedEscrow, tokenAccountBytes, type World } from "./helpers/sol-fake-chain.js";

async function railFor(w: World, signer = w.seller): Promise<SolHtlcRail> {
  return SolHtlcRail.connect({ config: w.config, rpc: w.rpc, signer, clock: w.clock, sleep: w.sleep, pollIntervalMs: 10, finalityTimeoutMs: 100 });
}

const OK = (): { slot: number; confirmations: null; err: null; confirmationStatus: "finalized" } => ({ slot: 5_000, confirmations: null, err: null, confirmationStatus: "finalized" });

function claimOnSend(w: World, sent: SolTransaction[]): void {
  w.chain.onSend = (tx, chain) => {
    sent.push(tx);
    chain.statuses.set(tx.signature, OK());
    putLockedEscrow(w, { status: "Claimed", preimage: w.preimage, amount: 0n });
  };
}

function programs(tx: SolTransaction): string[] {
  const keys = tx.message.accountKeys.map(pubkeyToBase58);
  return tx.message.instructions.map((ix) => keys[ix.programIdIndex] as string);
}

function priceOf(tx: SolTransaction): bigint {
  const ix = tx.message.instructions[1]!;
  expect(ix.data[0]).toBe(3);
  return new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
}

function limitOf(tx: SolTransaction): number {
  const ix = tx.message.instructions[0]!;
  expect(ix.data[0]).toBe(2);
  return new DataView(ix.data.buffer, ix.data.byteOffset + 1, 4).getUint32(0, true);
}

describe("R3-1: the claim creates the payee's token account itself", () => {
  it("a missing payee token account no longer refuses the claim: CreateIdempotent(payer = the claimer, owner = the payee, mint) comes before the claim and the claim lands", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.accounts.delete(pubkeyToBase58(w.keys.sellerToken));
    const sent: SolTransaction[] = [];
    claimOnSend(w, sent);
    const rail = await railFor(w);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).resolves.toMatchObject({ ref: w.ref });
    const tx = sent[0] as SolTransaction;
    expect(programs(tx)).toEqual([COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, w.config.programId]);
    const keys = tx.message.accountKeys.map(pubkeyToBase58);
    const ata = tx.message.instructions[2]!;
    expect(ata.data).toEqual(Uint8Array.of(1));
    expect(ata.accountIndexes.map((i) => keys[i])).toEqual([
      w.seller.publicKey,
      pubkeyToBase58(w.keys.sellerToken),
      w.seller.publicKey, // the escrow's payee (here the same wallet as the claimer)
      w.config.assets.USDC,
      SYSTEM_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
    ]);
  });

  it("the payee need not be the claimer: the account is created for the ESCROW's payee, paid by the claimer", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.accounts.delete(pubkeyToBase58(w.keys.sellerToken));
    const sent: SolTransaction[] = [];
    claimOnSend(w, sent);
    const rail = await railFor(w, w.buyer); // anyone may claim for the payee
    await rail.claim(w.ref, w.preimageHex, w.terms.claimByMs);
    const tx = sent[0] as SolTransaction;
    const keys = tx.message.accountKeys.map(pubkeyToBase58);
    const ata = tx.message.instructions[2]!;
    const named = ata.accountIndexes.map((i) => keys[i]);
    expect(named[0]).toBe(w.buyer.publicKey);
    expect(named[2]).toBe(w.seller.publicKey);
    expect(named[1]).toBe(pubkeyToBase58(w.keys.sellerToken));
  });

  it("a pre-funded, empty system-owned account at the token account's address (a griefing donation) counts as missing, not as a refusal", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.put(w.keys.sellerToken, { lamports: 5, owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(0), executable: false });
    const sent: SolTransaction[] = [];
    claimOnSend(w, sent);
    const rail = await railFor(w);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).resolves.toBeDefined();
    expect(sent).toHaveLength(1);
  });

  it("an account that exists but is wrong is still refused (frozen, other mint, other owner) and nothing is simulated or sent", async () => {
    for (const mutate of [
      (d: Uint8Array) => void (d[108] = 2),
      (d: Uint8Array) => d.set(new Uint8Array(32).fill(1), 0),
      (d: Uint8Array) => d.set(new Uint8Array(32).fill(1), 32),
    ]) {
      const w = makeWorld();
      putLockedEscrow(w);
      mutate(w.chain.get(w.keys.sellerToken)!.data);
      const rail = await railFor(w);
      await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).rejects.toThrow(/payee's associated token account/);
      expect(w.chain.count("simulateTransaction")).toBe(0);
      expect(w.chain.count("sendTransaction")).toBe(0);
    }
  });

  it("the claim is still found by preimageFromSignature (the Claim instruction sits after the budget and token-account instructions)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const sent: SolTransaction[] = [];
    claimOnSend(w, sent);
    const rail = await railFor(w);
    await rail.claim(w.ref, w.preimageHex, w.terms.claimByMs);
    const tx = sent[0] as SolTransaction;
    w.chain.transactions.set(tx.signature, { slot: 5_000, blockTime: null, err: null, bytes: tx.bytes });
    expect(await rail.preimageFromSignature(w.ref, tx.signature)).toBe(w.preimageHex);
  });
});

describe("R3-2: compute limit and priority fee on every claim and refund", () => {
  async function claimPrice(w: World, attempt: number): Promise<{ price: bigint; tx: SolTransaction }> {
    putLockedEscrow(w);
    const sent: SolTransaction[] = [];
    claimOnSend(w, sent);
    const rail = await railFor(w);
    await rail.claim(w.ref, w.preimageHex, w.terms.claimByMs, undefined, { priorityFeeAttempt: attempt });
    const tx = sent[0] as SolTransaction;
    return { price: priceOf(tx), tx };
  }

  it("a claim carries the named compute-unit limit and a price (the floor when the node reports no recent fees)", async () => {
    const w = makeWorld();
    const { price, tx } = await claimPrice(w, 0);
    expect(limitOf(tx)).toBe(SOL_CLAIM_COMPUTE_UNIT_LIMIT);
    expect(price).toBe(SOL_PRIORITY_FEE_FLOOR_MICRO_LAMPORTS);
  });

  it("the price is the 75th percentile of the recent fees over the claim's writable accounts, and the request names exactly those accounts", async () => {
    const w = makeWorld();
    w.chain.prioritizationFees = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90_000].map((fee, slot) => ({ slot, prioritizationFee: fee }));
    const { price } = await claimPrice(w, 0);
    expect(price).toBe(70n < SOL_PRIORITY_FEE_FLOOR_MICRO_LAMPORTS ? SOL_PRIORITY_FEE_FLOOR_MICRO_LAMPORTS : 70n);
    w.chain.prioritizationFees = [1, 2, 3, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000].map((fee, slot) => ({ slot, prioritizationFee: fee }));
    const w2 = makeWorld();
    w2.chain.prioritizationFees = w.chain.prioritizationFees;
    expect((await claimPrice(w2, 0)).price).toBe(8_000n);
    const asked = w2.chain.requests.find((r) => r.method === "getRecentPrioritizationFees")!;
    expect(asked.params[0]).toEqual([pubkeyToBase58(w2.keys.escrow), pubkeyToBase58(w2.keys.vault), pubkeyToBase58(w2.keys.sellerToken)]);
  });

  it("each earlier never-landed claim doubles the price, bounded by the cap", async () => {
    const prices: bigint[] = [];
    for (const attempt of [0, 1, 2, 3, 40]) prices.push((await claimPrice(makeWorld(), attempt)).price);
    expect(prices.slice(0, 4)).toEqual([1_000n, 2_000n, 4_000n, 8_000n]);
    expect(prices[4]).toBe(SOL_PRIORITY_FEE_CAP_MICRO_LAMPORTS);
    const w = makeWorld();
    w.chain.prioritizationFees = [{ slot: 1, prioritizationFee: 900_000_000 }];
    expect((await claimPrice(w, 0)).price).toBe(SOL_PRIORITY_FEE_CAP_MICRO_LAMPORTS);
  });

  it("a node that cannot price fees does not stop the claim: the floor applies", async () => {
    const w = makeWorld();
    w.chain.override("getRecentPrioritizationFees", () => {
      throw new FakeRpcError(-32601, "Method not found");
    });
    expect((await claimPrice(w, 0)).price).toBe(SOL_PRIORITY_FEE_FLOOR_MICRO_LAMPORTS);
  });

  it("a refund carries the budget instructions too (its own, smaller limit)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.now.ms = w.terms.refundAfterMs + 1_000;
    w.chain.finalizedTimeMs = w.terms.refundAfterMs + 1_000;
    const sent: SolTransaction[] = [];
    w.chain.onSend = (tx, chain) => {
      sent.push(tx);
      chain.statuses.set(tx.signature, OK());
      putLockedEscrow(w, { status: "Refunded", amount: 0n });
    };
    const rail = await railFor(w, w.buyer);
    await rail.refund(w.ref);
    const tx = sent[0] as SolTransaction;
    expect(programs(tx)).toEqual([COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, w.config.programId]);
    expect(limitOf(tx)).toBe(SOL_REFUND_COMPUTE_UNIT_LIMIT);
    expect(priceOf(tx)).toBe(SOL_PRIORITY_FEE_FLOOR_MICRO_LAMPORTS);
  });
});

describe("R3-4: transaction history is required, and 'never landed' is confirmed", () => {
  it("connect refuses an endpoint that does not serve transaction history (fail closed), and one whose probe fails for any reason", async () => {
    const w = makeWorld();
    w.chain.override("getSignaturesForAddress", () => {
      throw new FakeRpcError(-32011, "Transaction history is not available from this node");
    });
    await expect(railFor(w)).rejects.toThrow(/does not serve transaction history/);
    const w2 = makeWorld();
    w2.chain.override("getFirstAvailableBlock", () => {
      throw new FakeRpcError(-32601, "Method not found");
    });
    await expect(railFor(w2)).rejects.toThrow(/does not serve transaction history/);
  });

  async function expiredLockRecord(w: World): Promise<{ rail: SolHtlcRail; record: SolPreparedRecord }> {
    const rail = await railFor(w, w.buyer);
    const record = await rail.prepareLock(w.terms);
    w.chain.finalizedHeight = record.lastValidBlockHeight + 1;
    return { rail, record };
  }

  it("a signature with no status past its blockhash expiry is 'never landed' only when getTransaction(finalized) also finds nothing", async () => {
    const w = makeWorld();
    const { rail, record } = await expiredLockRecord(w);
    await expect(rail.recoverBySignature(record)).resolves.toBeNull();
    expect(w.chain.count("getTransaction")).toBe(1);
  });

  it("a transaction the status cache missed but getTransaction(finalized) has is LANDED, never 'never landed'", async () => {
    const w = makeWorld();
    const { rail, record } = await expiredLockRecord(w);
    putLockedEscrow(w);
    w.chain.transactions.set(record.signature, { slot: 5_000, blockTime: null, err: null, bytes: new Uint8Array(1) });
    w.chain.override("getTransaction", (p, c) => {
      const t = c.transactions.get(p[0] as string)!;
      return { slot: t.slot, blockTime: null, meta: { err: null }, transaction: [Buffer.from(t.bytes).toString("base64"), "base64"], version: "legacy" };
    });
    await expect(rail.recoverBySignature(record)).resolves.toMatchObject({ ref: w.ref, signature: record.signature });
  });

  it("a node whose ledger starts after the slot the transaction was signed at cannot prove 'never landed': it is pending (recover and the write path)", async () => {
    const w = makeWorld();
    const { rail, record } = await expiredLockRecord(w);
    expect(record.signedSlot).toBeDefined();
    w.chain.firstAvailableBlock = (record.signedSlot as number) + 1;
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolPendingError);

    const w2 = makeWorld();
    w2.chain.onSend = () => undefined; // dropped by the network
    const rail2 = await railFor(w2, w2.buyer);
    const record2 = await rail2.prepareLock(w2.terms);
    w2.chain.finalizedHeight = record2.lastValidBlockHeight + 1;
    w2.chain.firstAvailableBlock = (record2.signedSlot as number) + 1;
    await expect(rail2.commitLock()).rejects.toBeInstanceOf(SolPendingError);
    w2.chain.firstAvailableBlock = 0;
    const rail3 = await railFor(w2, w2.buyer);
    w2.chain.finalizedHeight = 4_900;
    await rail3.prepareLock(w2.terms);
    w2.chain.finalizedHeight = 99_999;
    await expect(rail3.commitLock()).rejects.toBeInstanceOf(SolNotLandedError);
  });
});

describe("R3-5: lastValidBlockHeight is clamped to max(reported, processed height + 151)", () => {
  it("a node that reports a last valid height below the processed height plus 151 is not believed", async () => {
    const w = makeWorld();
    w.chain.lastValidBlockHeight = w.chain.confirmedHeight + 10;
    const rail = await railFor(w, w.buyer);
    const record = await rail.prepareLock(w.terms);
    expect(record.lastValidBlockHeight).toBe(w.chain.confirmedHeight + 151);
  });

  it("a reported height above the clamp is kept", async () => {
    const w = makeWorld();
    w.chain.lastValidBlockHeight = w.chain.confirmedHeight + 400;
    const rail = await railFor(w, w.buyer);
    const record = await rail.prepareLock(w.terms);
    expect(record.lastValidBlockHeight).toBe(w.chain.confirmedHeight + 400);
  });

  it("the landing bound uses the clamped height: a claim that a low report would have allowed is refused as too late", async () => {
    // refundAfter 130 s out; a reported height only 100 blocks past finalized would land by 60 s + 30 s, but the clamped
    // height leaves 182 blocks (109 s + 30 s) and the claim could still land past refundAfterMs
    const w = makeWorld({ refundAfterMs: 1_800_000_000_000 + 130_000, claimByMs: 1_800_000_000_000 + 5_000 });
    putLockedEscrow(w);
    w.chain.lastValidBlockHeight = w.chain.finalizedHeight + 100;
    const rail = await railFor(w);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).rejects.toBeInstanceOf(SolClaimTooLateError);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });
});

describe("unused-import guard (round 3)", () => {
  it("keeps shared helpers referenced", () => {
    expect(CapturingRpc).toBeDefined();
    expect(tokenAccountBytes).toBeDefined();
  });
});
