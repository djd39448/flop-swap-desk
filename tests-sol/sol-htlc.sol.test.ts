// SPDX-License-Identifier: MIT
//
// tests-sol/sol-htlc.sol.test.ts - Stage SB-int (P6-SOL-SPEC.md section 5): the adapter (`SolHtlcRail`) and
// the evidence reader (`captureSolLeg` + `solEvidence`) against a REAL `solana-test-validator` with the real
// reviewed `htlc.so` loaded at genesis (tests-sol/helpers/validator.ts): real signed transactions, no mocks.
// Mirrors tests-near/near-htlc.near.test.ts for the Solana side. The NEAR round-1 probes' Solana twins:
//   - a failed claim is reported as a failed claim (typed), the escrow stays Locked and refundable, and the
//     Buyer recovers the secret from the failed transaction (the S1 leak class);
//   - a squat by another payer under the same hash lock does not block (escrow keyed by payer);
//   - a duplicate lock is refused by the program before anything is sent;
//   - a lost reply is recovered by signature; an expired blockhash means never included.
//
// Timing: this validator finalizes about 13-15 s behind the tip, and every rail write waits for FINALIZED, so
// one write is 15-30 s. Windows are real seconds (no warp): the refund scenarios use lock windows of a
// minute or two; the claim scenarios use long windows because the adapter refuses a claim that could still
// land within its 120 s landing margin of `refund_after_ms` (SOL_CLAIM_LANDING_MARGIN_MS).
//
// MEASURED (this validator, Agave 4.3.0): compute units and fees are logged as "SOL MEASURED ..." lines.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LockTerms } from "@flop-labs/tclk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

import { CapturingRpc, verifiedExchangeBytes, type Exchange } from "../src/rails/rpc-capture.js";
import { captureSolLeg, solEvidence, type SolAccounts, type SolCapture } from "../src/rails/sol-evidence.js";
import {
  SOL_CLAIM_LANDING_MARGIN_MS,
  SOL_DEVNET_PIN,
  SolClaimFailedError,
  SolClaimTooLateError,
  SolHtlcRail,
  SolPendingError,
  claimInstructionData,
  escrowAddress,
  refundInstructionData,
  vaultAddress,
  type SolHtlcTerms,
  type SolPreparedRecord,
  type SolRailConfig,
  type SolSigner,
} from "../src/rails/sol-htlc.js";
import { SolBlockhashNotFoundError, SolRpc, SolSimulationFailedError } from "../src/rails/sol-rpc.js";
import { TOKEN_PROGRAM_ID, associatedTokenAddress } from "../src/rails/sol-spl.js";
import { compileLegacyMessage, pubkeyFromBase58, pubkeyToBase58, signTransaction, type SolInstruction, type SolTransaction } from "../src/rails/sol-tx.js";
import { startSolValidator, type SolParty, type SolValidatorHandle } from "./helpers/validator.js";

const MINUTE = 60_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function newSecret(): { preimage: string; hashLock: string } {
  const bytes = randomBytes(32);
  return { preimage: `0x${bytesToHex(bytes)}`, hashLock: `0x${bytesToHex(sha256(bytes))}` };
}

describe("sol-htlc (solana-test-validator)", () => {
  let v: SolValidatorHandle;

  beforeAll(async () => {
    v = await startSolValidator();
  }, 600_000);

  afterAll(async () => {
    if (v !== undefined) await v.stop();
  });

  async function connect(party: SolParty, config: SolRailConfig = v.config, rpc: CapturingRpc = v.createCapturingRpc()): Promise<{ rail: SolHtlcRail; rpc: CapturingRpc }> {
    const rail = await SolHtlcRail.connect({ config, rpc, signer: party.signer as SolSigner });
    return { rail, rpc };
  }

  function sendCount(rpc: CapturingRpc): number {
    return rpc.exchanges().filter((e) => e.method === "sendTransaction").length;
  }

  /** "Now" for choosing windows: the later of chain time and the local clock (the adapter's own rule). */
  async function nowMs(rail: SolHtlcRail): Promise<number> {
    return Math.max(await rail.chainTimeMs(), Date.now());
  }

  async function waitChainTime(rail: SolHtlcRail, atLeastMs: number, timeoutMs = 240_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await rail.chainTimeMs()) >= atLeastMs) return;
      if (Date.now() >= deadline) throw new Error("test: chain time never reached the target");
      await sleep(2000);
    }
  }

  /** Real fee and compute units of a landed transaction, from the node (public data). */
  async function txMeta(signature: string): Promise<{ fee: number; computeUnits: number; err: unknown }> {
    const response = await fetch(v.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }] }),
    });
    const body = (await response.json()) as { result?: { meta?: { fee?: number; computeUnitsConsumed?: number; err?: unknown } } };
    const meta = body.result?.meta;
    if (meta === undefined || typeof meta.fee !== "number" || typeof meta.computeUnitsConsumed !== "number") throw new Error(`test: no meta for ${signature}`);
    return { fee: meta.fee, computeUnits: meta.computeUnitsConsumed, err: meta.err ?? null };
  }

  function measured(label: string, meta: { fee: number; computeUnits: number }): void {
    console.log(`SOL MEASURED ${label}: computeUnits=${String(meta.computeUnits)} feeLamports=${String(meta.fee)}`);
    expect(meta.computeUnits).toBeGreaterThan(0);
    expect(meta.computeUnits).toBeLessThan(200_000);
  }

  function lockTermsFixture(hashLock: string, amount: string, claimByMs: number, refundAfterMs: number): LockTerms {
    return { contract: "test-swap-contract", lock: "hash", statement: hashLock, amount, asset: "USDC", payer: "did:example:buyer", payee: "did:example:seller", claimByMs, refundAfterMs };
  }

  async function evidenceFor(ref: string, terms: LockTerms, accounts: SolAccounts): Promise<ReturnType<typeof solEvidence>> {
    const evidenceRpc = v.createCapturingRpc();
    const { index, exchanges } = await captureSolLeg(evidenceRpc, v.config, terms, accounts, ref, Date.now());
    expect(index.error).toBeUndefined();
    const capture: SolCapture = { index, bytes: verifiedExchangeBytes(exchanges as Exchange[]) };
    return solEvidence({ terms, config: v.config, accounts, capture });
  }

  /** A signed claim or refund transaction built OUTSIDE the rail, to go around its own guards on purpose
   *  (a claim forced past the pre-check, a claim signed then held until its blockhash expires). */
  async function rawWrite(kind: "claim" | "refund", ref: string, payer: string, payee: string, preimage: string | null, feePayer: SolParty, payeeTokenAccount?: Uint8Array): Promise<{ tx: SolTransaction; record: SolPreparedRecord }> {
    const hashLock = ref.slice(0, 66);
    const escrow = escrowAddress(v.config.programId, payer, hashLock).address;
    const vault = vaultAddress(v.config.programId, escrow).address;
    const mint = pubkeyFromBase58(v.mint);
    const programId = pubkeyFromBase58(v.config.programId);
    const tokenProgram = pubkeyFromBase58(TOKEN_PROGRAM_ID);
    const destination = payeeTokenAccount ?? associatedTokenAddress(pubkeyFromBase58(payee), mint);
    let instruction: SolInstruction;
    if (kind === "claim") {
      if (preimage === null) throw new Error("test: a claim needs a preimage");
      instruction = {
        programId,
        accounts: [
          { pubkey: escrow, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ],
        data: claimInstructionData(hexToBytes(preimage.slice(2))),
      };
    } else {
      instruction = {
        programId,
        accounts: [
          { pubkey: feePayer.signer.publicKeyBytes, isSigner: true, isWritable: false },
          { pubkey: escrow, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ],
        data: refundInstructionData(),
      };
    }
    const sol = new SolRpc(v.createCapturingRpc());
    const latest = await sol.getLatestBlockhash("confirmed");
    const message = compileLegacyMessage({ feePayer: feePayer.signer.publicKeyBytes, recentBlockhash: pubkeyFromBase58(latest.blockhash), instructions: [instruction] });
    const tx = await signTransaction(message, [feePayer.signer]);
    return { tx, record: { kind, ref, signature: tx.signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight } };
  }

  async function lockOn(buyerRail: SolHtlcRail, hashLock: string, amount: string, payee: string, claimByMs: number, refundAfterMs: number): Promise<{ record: SolPreparedRecord; signature: string }> {
    const record = await buyerRail.prepareLock({ hashLock, amount, payee, claimByMs, refundAfterMs });
    const evidence = await buyerRail.commitLock();
    expect(evidence.signature).toBe(record.signature);
    return { record, signature: evidence.signature };
  }

  // ---------------------------------------------------------------------------------------------------------

  it("connect(): accepts the reviewed program; refuses a wrong program hash, the devnet pin, a mainnet-named pin and a non-mint", async () => {
    const { rail } = await connect(v.buyer);
    expect(rail.signerPublicKey).toBe(v.buyer.address);

    await expect(connect(v.buyer, { ...v.config, programHash: "00".repeat(32) })).rejects.toThrow(/ProgramData hash does not match/);
    await expect(connect(v.buyer, { ...v.config, programHash: v.config.programHash.replace(/^./, (c) => (c === "a" ? "b" : "a")) })).rejects.toThrow(/ProgramData hash does not match/);
    // The devnet pin needs a genesis that starts with devnet's reference; this validator's does not.
    await expect(connect(v.buyer, { ...v.config, pin: SOL_DEVNET_PIN })).rejects.toThrow(/does not match pin/);
    await expect(connect(v.buyer, { ...v.config, pin: { ...v.config.pin, name: "solana-mainnet-beta" } })).rejects.toThrow(/mainnet/);
    // A mint that is not a mint (the seller's wallet address: a system account).
    await expect(connect(v.buyer, { ...v.config, assets: { USDC: v.seller.address } })).rejects.toThrow(/mint/);
    // Any programId other than the fixed keyless one is refused before any read.
    await expect(connect(v.buyer, { ...v.config, programId: v.seller.address })).rejects.toThrow(/programId/);
  });

  it("lock then evidence locked: the escrow and the vault hold the terms, the Buyer paid, evidence reports locked (measures compute units and fee)", async () => {
    const { hashLock } = newSecret();
    const { rail: buyerRail, rpc } = await connect(v.buyer);
    const now = await nowMs(buyerRail);
    const claimByMs = now + 10 * MINUTE;
    const refundAfterMs = now + 20 * MINUTE;
    const amount = "555";
    const before = (await v.usdcBalanceOf(v.buyer.address)) as bigint;

    const record = await buyerRail.prepareLock({ hashLock, amount, payee: v.seller.address, claimByMs, refundAfterMs });
    expect(record.kind).toBe("lock");
    expect(record.ref).toBe(`${hashLock}:${v.buyer.address}`);
    expect(record.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,100}$/);
    // Nothing is sent by preparing: the signature is known BEFORE the transaction leaves.
    expect(sendCount(rpc)).toBe(0);
    const evidence = await buyerRail.commitLock();
    expect(sendCount(rpc)).toBe(1);
    expect(evidence.signature).toBe(record.signature);
    expect(evidence.ref).toBe(record.ref);
    // A second commit is impossible (consumed).
    await expect(buyerRail.commitLock()).rejects.toThrow(/no prepared lock/);

    const { escrow } = await buyerRail.getEscrow(record.ref);
    expect(escrow).toMatchObject({ status: "Locked", revealed: false, payer: v.buyer.address, payee: v.seller.address, mint: v.mint, hashLock, amount, claimByMs, refundAfterMs, preimage: null });
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(before - 555n);
    const escrowKey = escrowAddress(v.config.programId, v.buyer.address, hashLock).address;
    const vaultKey = pubkeyToBase58(vaultAddress(v.config.programId, escrowKey).address);
    const sol = new SolRpc(v.createCapturingRpc());
    const vaultInfo = await sol.getAccountInfo(vaultKey, { commitment: "finalized" });
    expect(vaultInfo.account?.owner).toBe(TOKEN_PROGRAM_ID);
    expect(new DataView(vaultInfo.account?.data.buffer as ArrayBuffer, (vaultInfo.account?.data.byteOffset as number) + 64, 8).getBigUint64(0, true)).toBe(555n);
    measured("lock", await txMeta(record.signature));

    const terms = lockTermsFixture(hashLock, amount, claimByMs, refundAfterMs);
    const result = await evidenceFor(record.ref, terms, { payee: v.seller.address, payer: v.buyer.address });
    expect(result.lock.railVerified).toBe(true);
    expect(result.rail?.status).toBe("locked");
    expect(result.rail?.final).toBe(true);
  });

  it("claim: a wrong preimage is refused before sending; the right one pays the payee and evidence reports claimed with the preimage", async () => {
    const { preimage, hashLock } = newSecret();
    const other = newSecret();
    const { rail: buyerRail } = await connect(v.buyer);
    const now = await nowMs(buyerRail);
    const claimByMs = now + 10 * MINUTE;
    const refundAfterMs = now + 20 * MINUTE;
    const amount = "666";
    const { record } = await lockOn(buyerRail, hashLock, amount, v.seller.address, claimByMs, refundAfterMs);
    const sellerBefore = (await v.usdcBalanceOf(v.seller.address)) ?? 0n;

    const { rail: sellerRail, rpc: sellerRpc } = await connect(v.seller);
    await expect(sellerRail.claim(record.ref, other.preimage, claimByMs)).rejects.toThrow(/does not open hashLock/);
    expect(sendCount(sellerRpc)).toBe(0);

    let recorded: SolPreparedRecord | null = null;
    const evidence = await sellerRail.claim(record.ref, preimage, claimByMs, (r) => {
      recorded = r;
    });
    expect(sendCount(sellerRpc)).toBe(1);
    // Record-before-send: the callback saw exactly the signature that landed.
    expect((recorded as SolPreparedRecord | null)?.signature).toBe(evidence.signature);
    expect((recorded as SolPreparedRecord | null)?.kind).toBe("claim");

    const { escrow } = await sellerRail.getEscrow(record.ref);
    expect(escrow).toMatchObject({ status: "Claimed", revealed: true, preimage });
    expect(await v.usdcBalanceOf(v.seller.address)).toBe(sellerBefore + 666n);
    measured("claim", await txMeta(evidence.signature));
    // The Buyer reads the secret off the chain.
    expect(await buyerRail.findClaimedPreimage(record.ref)).toBe(preimage);
    // A second claim is refused up front (not Locked any more).
    await expect(sellerRail.claim(record.ref, preimage, claimByMs)).rejects.toThrow(/not in a claimable "Locked" state/);

    const terms = lockTermsFixture(hashLock, amount, claimByMs, refundAfterMs);
    const result = await evidenceFor(record.ref, terms, { payee: v.seller.address, payer: v.buyer.address });
    expect(result.rail?.status).toBe("claimed");
    expect(result.lock.railVerified).toBe(false);
  });

  it("refund: refused before the window (pre-check and the program itself), a claim near the window is refused too, and after it the Buyer is paid back and evidence reports refunded", async () => {
    const { preimage, hashLock } = newSecret();
    const { rail: buyerRail, rpc: buyerRpc } = await connect(v.buyer);
    const start = await nowMs(buyerRail);
    const claimByMs = start + 20_000;
    const refundAfterMs = start + 50_000;
    const amount = "888";
    const before = (await v.usdcBalanceOf(v.buyer.address)) as bigint;
    const { record } = await lockOn(buyerRail, hashLock, amount, v.seller.address, claimByMs, refundAfterMs);
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(before - 888n);

    // Too early: the adapter refuses on chain time and never sends.
    const sendsBefore = sendCount(buyerRpc);
    await expect(buyerRail.refund(record.ref)).rejects.toThrow(/chain time has not yet reached refundAfterMs/);
    expect(sendCount(buyerRpc)).toBe(sendsBefore);
    // ...and the PROGRAM refuses it too: simulating a hand-built refund gives RefundTooEarly (22).
    const early = await rawWrite("refund", record.ref, v.buyer.address, v.buyer.address, null, v.buyer);
    const sim = await new SolRpc(v.createCapturingRpc()).simulateTransaction(early.tx.bytes, { commitment: "confirmed" });
    expect(sim.err).toEqual({ InstructionError: [0, { Custom: 22 }] });

    // A claim that cannot be guaranteed to land before the window is refused (nothing signed or sent).
    const { rail: sellerRail, rpc: sellerRpc } = await connect(v.seller);
    await expect(sellerRail.claim(record.ref, preimage, refundAfterMs - 60_000)).rejects.toThrow(/landing margin/);
    await expect(sellerRail.claim(record.ref, preimage, refundAfterMs - SOL_CLAIM_LANDING_MARGIN_MS - 1000)).rejects.toBeInstanceOf(SolClaimTooLateError);
    expect(sendCount(sellerRpc)).toBe(0);

    await waitChainTime(buyerRail, refundAfterMs);
    let recorded: SolPreparedRecord | null = null;
    const evidence = await buyerRail.refund(record.ref, (r) => {
      recorded = r;
    });
    expect((recorded as SolPreparedRecord | null)?.signature).toBe(evidence.signature);
    const { escrow } = await buyerRail.getEscrow(record.ref);
    expect(escrow?.status).toBe("Refunded");
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(before);
    measured("refund", await txMeta(evidence.signature));
    // After a refund a claim is refused up front.
    await expect(sellerRail.claim(record.ref, preimage, claimByMs)).rejects.toThrow(/not in a claimable "Locked" state/);
    // Only the payer can refund.
    await expect(sellerRail.refund(record.ref)).rejects.toThrow(/payer's own key/);

    const terms = lockTermsFixture(hashLock, amount, claimByMs, refundAfterMs);
    const result = await evidenceFor(record.ref, terms, { payee: v.seller.address, payer: v.buyer.address });
    expect(result.rail?.status).toBe("refunded");
  });

  it("squat: another payer locking under the same hash lock does not block; the escrows are separate and the real one is claimable", async () => {
    const { preimage, hashLock } = newSecret();
    const squatter = await v.createParty({ usdc: 1000n });
    const { rail: squatRail } = await connect(squatter);
    const { rail: buyerRail } = await connect(v.buyer);
    const now = await nowMs(buyerRail);
    const claimByMs = now + 10 * MINUTE;
    const refundAfterMs = now + 20 * MINUTE;

    // The squatter locks first, under the (public) hash lock, naming itself payee.
    const squat = await lockOn(squatRail, hashLock, "7", squatter.address, claimByMs, refundAfterMs);
    // The Buyer's own lock under the same hash lock still lands.
    const real = await lockOn(buyerRail, hashLock, "321", v.seller.address, claimByMs, refundAfterMs);
    expect(squat.record.ref).not.toBe(real.record.ref);
    expect((await buyerRail.getEscrow(real.record.ref)).escrow).toMatchObject({ status: "Locked", payer: v.buyer.address, payee: v.seller.address, amount: "321" });
    expect((await buyerRail.getEscrow(squat.record.ref)).escrow).toMatchObject({ status: "Locked", payer: squatter.address, payee: squatter.address, amount: "7" });

    // Re-locking the same (payer, hash lock) is refused up front.
    await expect(buyerRail.prepareLock({ hashLock, amount: "1", payee: v.seller.address, claimByMs, refundAfterMs })).rejects.toThrow(/escrow already exists/);

    // The Seller claims the REAL escrow; the squatter's stays Locked.
    const sellerBefore = (await v.usdcBalanceOf(v.seller.address)) ?? 0n;
    const { rail: sellerRail } = await connect(v.seller);
    await sellerRail.claim(real.record.ref, preimage, claimByMs);
    expect(await v.usdcBalanceOf(v.seller.address)).toBe(sellerBefore + 321n);
    expect((await buyerRail.getEscrow(real.record.ref)).escrow?.status).toBe("Claimed");
    expect((await buyerRail.getEscrow(squat.record.ref)).escrow?.status).toBe("Locked");
  });

  it("duplicate lock: two prepared locks for the same payer and hash lock - the second is refused by the program before anything is sent (typed), one escrow, one debit", async () => {
    const { hashLock } = newSecret();
    const { rail: a } = await connect(v.buyer);
    const { rail: b, rpc: rpcB } = await connect(v.buyer);
    const now = await nowMs(a);
    const terms: SolHtlcTerms = { hashLock, amount: "10", payee: v.seller.address, claimByMs: now + 10 * MINUTE, refundAfterMs: now + 20 * MINUTE };
    const before = (await v.usdcBalanceOf(v.buyer.address)) as bigint;
    await a.prepareLock(terms);
    // Different terms (an identical prepared transaction would be the SAME transaction, AlreadyProcessed).
    await b.prepareLock({ ...terms, amount: "11" }); // both saw "no escrow yet"
    await a.commitLock();
    const error = await b.commitLock().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SolSimulationFailedError);
    expect((error as SolSimulationFailedError).err).toEqual({ InstructionError: [0, { Custom: 15 }] }); // EscrowExists
    expect(sendCount(rpcB)).toBe(0);
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(before - 10n);
  });

  it("failed claim (payee token account missing): refused by the pre-check; forced past it, it fails on chain, is reported as a failed claim, leaves the escrow Locked and refundable, and the Buyer recovers the secret from the failed transaction", async () => {
    const { preimage, hashLock } = newSecret();
    const payee = await v.createParty({ tokenAccount: false, sol: 1 });
    const { rail: buyerRail } = await connect(v.buyer);
    const start = await nowMs(buyerRail);
    const claimByMs = start + 30_000;
    const refundAfterMs = start + 150_000;
    const amount = "444";
    const before = (await v.usdcBalanceOf(v.buyer.address)) as bigint;
    const { record } = await lockOn(buyerRail, hashLock, amount, payee.address, claimByMs, refundAfterMs);
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(before - 444n);

    // 1. The adapter's pre-check refuses: no token account for the payee, so nothing is signed or sent.
    const { rail: payeeRail, rpc: payeeRpc } = await connect(payee);
    await expect(payeeRail.claim(record.ref, preimage, refundAfterMs - SOL_CLAIM_LANDING_MARGIN_MS - 1000)).rejects.toThrow(/associated token account does not exist/);
    expect(sendCount(payeeRpc)).toBe(0);

    // 2. Forced past the pre-check (a hand-built claim sent with preflight skipped): it LANDS and FAILS.
    const forced = await rawWrite("claim", record.ref, v.buyer.address, payee.address, preimage, payee);
    const sol = new SolRpc(v.createCapturingRpc());
    expect(await sol.sendTransaction(forced.tx.bytes, { skipPreflight: true })).toBe(forced.record.signature);

    // 3. The rail reports it as a failed claim (typed, secretPublic), by signature.
    let failure: unknown = null;
    for (const deadline = Date.now() + 120_000; ; ) {
      try {
        await payeeRail.recoverBySignature(forced.record);
        throw new Error("test: the forced claim unexpectedly succeeded");
      } catch (error) {
        if (error instanceof SolPendingError) {
          if (Date.now() >= deadline) throw error;
          await sleep(1000);
          continue;
        }
        failure = error;
        break;
      }
    }
    expect(failure).toBeInstanceOf(SolClaimFailedError);
    const failed = failure as SolClaimFailedError;
    expect(failed.secretPublic).toBe(true);
    expect(failed.signature).toBe(forced.record.signature);
    expect(failed.programError).toEqual({ code: 17, name: "BadTokenAccount" });
    const meta = await txMeta(forced.record.signature);
    expect(meta.err).not.toBeNull();
    measured("failed claim (BadTokenAccount)", meta);

    // 4. The escrow is still Locked with the whole amount, and no preimage is stored.
    const { escrow } = await buyerRail.getEscrow(record.ref);
    expect(escrow).toMatchObject({ status: "Locked", revealed: false, preimage: null, amount });

    // 5. The Buyer recovers the secret from the FAILED transaction (S1: it is public in the instruction data).
    expect(await buyerRail.findClaimedPreimage(record.ref)).toBe(preimage);
    // A different escrow's history never yields this secret.
    const unrelated = newSecret();
    const unrelatedRef = `${unrelated.hashLock}:${v.buyer.address}`;
    expect(await buyerRail.findClaimedPreimage(unrelatedRef)).toBeNull();

    // 6. ...and it is refundable once the window closes.
    await waitChainTime(buyerRail, refundAfterMs);
    await buyerRail.refund(record.ref);
    expect((await buyerRail.getEscrow(record.ref)).escrow?.status).toBe("Refunded");
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(before);
  });

  it("a claim signed with a blockhash that then expires is never included: rejected typed at preflight, dropped if forced, escrow stays Locked, recovery says never landed", async () => {
    const { preimage, hashLock } = newSecret();
    const { rail: buyerRail } = await connect(v.buyer);
    const now = await nowMs(buyerRail);
    const claimByMs = now + 10 * MINUTE;
    const refundAfterMs = now + 20 * MINUTE;
    const { record } = await lockOn(buyerRail, hashLock, "99", v.seller.address, claimByMs, refundAfterMs);

    // A valid claim, signed now and HELD (never sent).
    const held = await rawWrite("claim", record.ref, v.buyer.address, v.seller.address, preimage, v.seller);
    const { rail: sellerRail } = await connect(v.seller);
    // Still inside its lifetime the recovery is undecided, never "never landed".
    await expect(sellerRail.recoverBySignature(held.record)).rejects.toBeInstanceOf(SolPendingError);

    // Wait until the finalized block height is past lastValidBlockHeight (150 blocks plus finality lag).
    const sol = new SolRpc(v.createCapturingRpc());
    for (const deadline = Date.now() + 200_000; ; ) {
      if ((await sol.getBlockHeight("finalized")) > held.record.lastValidBlockHeight + 1) break;
      if (Date.now() >= deadline) throw new Error("test: the blockhash never expired");
      await sleep(3000);
    }

    // (a) With preflight the node refuses it, typed.
    await expect(sol.sendTransaction(held.tx.bytes, { preflightCommitment: "confirmed" })).rejects.toBeInstanceOf(SolBlockhashNotFoundError);
    // (b) Even forced past preflight it can never be included.
    await sol.sendTransaction(held.tx.bytes, { skipPreflight: true }).catch(() => undefined);
    await sleep(8000);
    expect((await sol.getSignatureStatuses([held.record.signature]))[0]).toBeNull();
    const escrowKey = pubkeyToBase58(escrowAddress(v.config.programId, v.buyer.address, hashLock).address);
    const history = await sol.getSignaturesForAddress(escrowKey, { commitment: "finalized", limit: 20 });
    expect(history.map((h) => h.signature)).not.toContain(held.record.signature);
    expect((await sellerRail.getEscrow(record.ref)).escrow).toMatchObject({ status: "Locked", revealed: false });
    // (c) Recovery: expired blockhash and no status is the one case reported as "never landed".
    expect(await sellerRail.recoverBySignature(held.record)).toBeNull();
    // (d) The secret never became public through it.
    expect(await buyerRail.findClaimedPreimage(record.ref)).toBeNull();
  });

  it("lost reply: a lock and a claim whose send reply was lost are recovered by their recorded signature", async () => {
    // A fetch that performs the real request and then loses the reply, for sendTransaction only, once armed.
    let armed = false;
    const losingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : {};
      if (armed && body.method === "sendTransaction") {
        armed = false;
        await response.arrayBuffer();
        throw new Error("connection reset while reading the reply");
      }
      return response;
    };
    const lossyRpc = (): CapturingRpc => v.createCapturingRpc({ fetch: losingFetch });

    const { preimage, hashLock } = newSecret();
    const { rail: buyerRail } = await connect(v.buyer, v.config, lossyRpc());
    const now = await nowMs(buyerRail);
    const claimByMs = now + 10 * MINUTE;
    const refundAfterMs = now + 20 * MINUTE;
    const amount = "123";

    // Lock: the transport error is rethrown unchanged (never folded into "not landed").
    const record = await buyerRail.prepareLock({ hashLock, amount, payee: v.seller.address, claimByMs, refundAfterMs });
    armed = true;
    await expect(buyerRail.commitLock()).rejects.toThrow(/connection reset/);
    expect(armed).toBe(false);
    const recoverUntilSettled = async (rail: SolHtlcRail, rec: SolPreparedRecord): Promise<NonNullable<Awaited<ReturnType<SolHtlcRail["recoverBySignature"]>>>> => {
      for (const deadline = Date.now() + 120_000; ; ) {
        try {
          const evidence = await rail.recoverBySignature(rec);
          if (evidence === null) throw new Error("test: recovery said never landed for a transaction that was sent");
          return evidence;
        } catch (error) {
          if (!(error instanceof SolPendingError) || Date.now() >= deadline) throw error;
          await sleep(1000);
        }
      }
    };
    const lockEvidence = await recoverUntilSettled(buyerRail, record);
    expect(lockEvidence.signature).toBe(record.signature);
    expect((await buyerRail.getEscrow(record.ref)).escrow).toMatchObject({ status: "Locked", amount });

    // Claim: the same, through the onSigned record.
    const { rail: sellerRail } = await connect(v.seller, v.config, lossyRpc());
    let recorded: SolPreparedRecord | null = null;
    armed = true;
    await expect(
      sellerRail.claim(record.ref, preimage, claimByMs, (r) => {
        recorded = r;
      }),
    ).rejects.toThrow(/connection reset/);
    expect(recorded).not.toBeNull();
    const claimEvidence = await recoverUntilSettled(sellerRail, recorded as unknown as SolPreparedRecord);
    expect(claimEvidence.signature).toBe((recorded as unknown as SolPreparedRecord).signature);
    expect((await sellerRail.getEscrow(record.ref)).escrow).toMatchObject({ status: "Claimed", preimage });
  });

  it("SB-int hygiene: the party signers never leak a key through JSON or inspect", () => {
    for (const party of [v.buyer, v.seller]) {
      const text = JSON.stringify(party);
      expect(text).not.toMatch(/secret/i);
      expect(Object.keys(party.signer)).not.toContain("secretKey");
    }
  });
});
