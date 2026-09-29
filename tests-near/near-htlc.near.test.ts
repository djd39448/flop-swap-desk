// SPDX-License-Identifier: MIT
//
// tests-near/near-htlc.near.test.ts — Stage NB-int (P5-NEAR-SPEC.md §5): adapter integration
// through the REAL rail, against a real `near-sandbox` node (tests-near/helpers/sandbox.ts) — one
// real htlc + mock-ft contract pair, real signed transactions, no mocks. Mirrors
// tests-regtest/btc-htlc.regtest.test.ts's own shape (one `describe`, a shared `beforeAll`-built
// node, direct-rail-level scenarios) for the NEAR side of the same test architecture.
//
// Gas measurement (D-N9): `measuredGasBurnt` below reads the REAL total gas burnt (transaction
// outcome + every receipt outcome) straight out of each write's own captured `send_tx` exchange —
// never estimated. The three "measures real gas burn" assertions log their own totals; the
// commit landing this file corrects `FT_TRANSFER_CALL_GAS`/`CLAIM_REFUND_GAS`
// (src/rails/near-htlc.ts) from the provisional 100/60 Tgas to what was actually measured here,
// with the numbers in that commit's own message (D-N9's own instruction).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LockTerms } from "@flop-labs/tclk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

import { buildSignedTransaction, type NearAction } from "../src/rails/near-borsh.js";
import { captureNearLeg, nearEvidence, type NearAccounts, type NearCapture } from "../src/rails/near-evidence.js";
import { NearHtlcRail, type NearHtlcTerms, type NearSigner } from "../src/rails/near-htlc.js";
import { NearRpc } from "../src/rails/near-rpc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc, verifiedExchangeBytes, type Exchange } from "../src/rails/rpc-capture.js";
import { startNearSandbox, type NearSandboxHandle } from "./helpers/sandbox.js";

const TGAS = 1_000_000_000_000n;

interface RawFinalExecutionOutcome {
  transaction_outcome?: { outcome?: { gas_burnt?: number } };
  receipts_outcome?: Array<{ outcome?: { gas_burnt?: number } }>;
}

/** Real total gas burnt for the whole receipt chain (D-N9) — the transaction's own outcome plus
 *  every receipt it produced, straight from the write's own captured `send_tx` response. Reads
 *  the LAST `send_tx` exchange in `rpc`'s log (a rail write's own `sendPrepared` is the only
 *  caller of `send_tx` on this transport). */
function measuredGasBurnt(rpc: CapturingRpc): bigint {
  const exchanges = rpc.exchanges();
  const sendTx = [...exchanges].reverse().find((e) => e.method === "send_tx");
  if (sendTx === undefined) throw new Error("test: no send_tx exchange captured on this rpc instance");
  const parsed = JSON.parse(sendTx.responseBody) as { result?: RawFinalExecutionOutcome };
  const outcome = parsed.result;
  if (outcome === undefined) throw new Error("test: send_tx response carried no result");
  let total = BigInt(outcome.transaction_outcome?.outcome?.gas_burnt ?? 0);
  for (const r of outcome.receipts_outcome ?? []) total += BigInt(r.outcome?.gas_burnt ?? 0);
  return total;
}

function randomHashLock(): { preimageHex: string; preimage0x: string; hashLockHex: string; hashLock0x: string } {
  const preimage = randomBytes(32);
  const hashLock = sha256(preimage);
  const preimageHex = bytesToHex(preimage);
  const hashLockHex = bytesToHex(hashLock);
  return { preimageHex, preimage0x: `0x${preimageHex}`, hashLockHex, hashLock0x: `0x${hashLockHex}` };
}

interface LockViewRaw {
  payer: string;
  payee: string;
  token: string;
  amount: string;
  claim_by_ms: string;
  refund_after_ms: string;
  status: string;
  preimage: string | null;
}

describe("near-htlc (sandbox)", () => {
  let sandbox: NearSandboxHandle;

  beforeAll(async () => {
    sandbox = await startNearSandbox();
  }, 300_000);

  afterAll(async () => {
    if (sandbox !== undefined) await sandbox.stop();
  });

  async function chainNowMs(): Promise<number> {
    const rpc = sandbox.createCapturingRpc();
    const near = new NearRpc(rpc);
    const block = await near.block({ finality: "final" });
    return Number(BigInt(block.header.timestampNs) / 1_000_000n);
  }

  async function getLockView(hashLock0x: string): Promise<LockViewRaw | null> {
    const rpc = sandbox.createCapturingRpc();
    const near = new NearRpc(rpc);
    const result = await near.callFunction(sandbox.htlcContract, "get_lock", { hash_lock: hashLock0x.slice(2) });
    return JSON.parse(result.resultText) as LockViewRaw | null;
  }

  function connect(signer: NearSigner): Promise<{ rail: NearHtlcRail; rpc: CapturingRpc }> {
    const rpc = sandbox.createCapturingRpc();
    return NearHtlcRail.connect({ config: sandbox.config, rpc, signer, clock: Date.now }).then((rail) => ({ rail, rpc }));
  }

  function decodePublicKeyRaw(publicKey: string): Uint8Array {
    return base58.decode(publicKey.slice("ed25519:".length));
  }

  /** Low-level signed-transaction sender for scenarios that must go AROUND `NearHtlcRail`'s own
   *  TS-side guards on purpose (test 8's "forced past the pre-check", test 7's malformed msg) —
   *  the same shape as `tests-near/helpers/sandbox.ts`'s own (private) setup sender, duplicated
   *  here deliberately small rather than exported from the harness, so the harness's own
   *  construction-time invariants stay off limits to a test that wants to violate them on
   *  purpose. */
  async function sendRawTx(rpc: CapturingRpc, signer: NearSigner, signerAccountId: string, receiverId: string, actions: NearAction[]) {
    const near = new NearRpc(rpc);
    const accessKey = await near.viewAccessKey(signerAccountId, signer.publicKey);
    const block = await near.block({ finality: "final" });
    const built = await buildSignedTransaction(
      {
        signerId: signerAccountId,
        publicKey: { keyType: "ED25519", data: decodePublicKeyRaw(signer.publicKey) },
        nonce: BigInt(accessKey.nonce) + 1n,
        receiverId,
        blockHash: base58.decode(block.header.hash),
        actions,
      },
      (hash) => signer.sign(hash),
    );
    return near.sendTx(Buffer.from(built.signedBytes).toString("base64"), "FINAL");
  }

  function ftTransferCallAction(receiverId: string, amount: string, msg: string, gas = 100n * TGAS): NearAction {
    return {
      type: "FunctionCall",
      methodName: "ft_transfer_call",
      args: new TextEncoder().encode(JSON.stringify({ receiver_id: receiverId, amount, msg })),
      gas,
      deposit: 1n,
    };
  }

  function lockMsg(hashLockHex: string, payee: string, claimByMs: number, refundAfterMs: number): string {
    return JSON.stringify({ hash_lock: hashLockHex, payee, claim_by_ms: String(claimByMs), refund_after_ms: String(refundAfterMs) });
  }

  function lockTermsFixture(hashLock0x: string, amount: string, claimByMs: number, refundAfterMs: number): LockTerms {
    return {
      contract: "test-swap-contract",
      lock: "hash",
      statement: hashLock0x,
      amount,
      asset: "USDC",
      payer: "did:example:buyer",
      payee: "did:example:seller",
      claimByMs,
      refundAfterMs,
    };
  }

  it("lock (ft_transfer_call) creates a Locked lock whose get_lock matches the terms", async () => {
    const { preimage0x: _preimage0x, hashLock0x, hashLockHex } = randomHashLock();
    void _preimage0x;
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 20 * 60_000;
    const amount = "1000";

    const { rail: buyerRail, rpc: buyerRpc } = await connect(sandbox.buyer.signer);
    const terms: NearHtlcTerms = { hashLock: hashLock0x, amount, payee: sandbox.seller.accountId, claimByMs, refundAfterMs };
    const { ref } = await buyerRail.prepareLock(terms);
    expect(ref).toBe(hashLock0x);
    const evidence = await buyerRail.commitLock();
    expect(evidence.ref).toBe(hashLock0x);
    expect(evidence.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(evidence.blockHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);

    const gas = measuredGasBurnt(buyerRpc);
    console.log(`[gas] ft_transfer_call (lock) total gas_burnt = ${gas.toString()} (${(Number(gas) / 1e12).toFixed(2)} Tgas)`);
    expect(gas).toBeGreaterThan(0n);

    const view = await getLockView(hashLock0x);
    expect(view).not.toBeNull();
    expect(view?.status).toBe("Locked");
    expect(view?.payer).toBe(sandbox.buyer.accountId);
    expect(view?.payee).toBe(sandbox.seller.accountId);
    expect(view?.token).toBe(sandbox.usdcToken);
    expect(view?.amount).toBe(amount);
    expect(view?.claim_by_ms).toBe(String(claimByMs));
    expect(view?.refund_after_ms).toBe(String(refundAfterMs));
    expect(view?.preimage).toBeNull();
    void hashLockHex;
  });

  it("claim with the right preimage pays the seller and get_lock shows Claimed + preimage", async () => {
    const { preimage0x, hashLock0x } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 20 * 60_000;
    const amount = "2500";

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    const balanceBefore = BigInt(await sandbox.usdcBalanceOf(sandbox.seller.accountId));

    const { rail: sellerRail, rpc: sellerRpc } = await connect(sandbox.seller.signer);
    const notAfterMs = refundAfterMs - 60_000;
    const evidence = await sellerRail.claim(hashLock0x, preimage0x, notAfterMs);
    expect(evidence.ref).toBe(hashLock0x);

    const gas = measuredGasBurnt(sellerRpc);
    console.log(`[gas] claim total gas_burnt = ${gas.toString()} (${(Number(gas) / 1e12).toFixed(2)} Tgas)`);
    expect(gas).toBeGreaterThan(0n);

    const balanceAfter = BigInt(await sandbox.usdcBalanceOf(sandbox.seller.accountId));
    expect(balanceAfter).toBe(balanceBefore + BigInt(amount));

    const view = await getLockView(hashLock0x);
    expect(view?.status).toBe("Claimed");
    expect(view?.preimage).toBe(preimage0x.slice(2));
  });

  it("claim with the wrong preimage is refused before ever sending a transaction", async () => {
    const { hashLock0x } = randomHashLock();
    const wrongPreimage = randomBytes(32);
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 20 * 60_000;

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount: "1", payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    const { rail: sellerRail, rpc: sellerRpc } = await connect(sandbox.seller.signer);
    await expect(sellerRail.claim(hashLock0x, `0x${bytesToHex(wrongPreimage)}`, refundAfterMs - 1000)).rejects.toThrow(/does not open hashLock/);
    expect(sellerRpc.exchanges().some((e) => e.method === "send_tx")).toBe(false);
  });

  it("refund before refundAfterMs is refused", async () => {
    const { hashLock0x } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 60 * 60_000; // far future

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount: "1", payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    await expect(buyerRail.refund(hashLock0x)).rejects.toThrow(/chain time has not yet reached refundAfterMs/);
  });

  it("refund after refundAfterMs (reached via fastForward) pays the buyer back; claim afterward is refused", async () => {
    const { preimage0x, hashLock0x } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 2_000;
    const refundAfterMs = now + 4_000;
    const amount = "777";

    const { rail: buyerRail, rpc: buyerRpc } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    const balanceBefore = BigInt(await sandbox.usdcBalanceOf(sandbox.buyer.accountId));

    await sandbox.fastForward(150); // ~ comfortably past a few-second window (D-N7: timestamp advances with height)

    const refundRail = buyerRail;
    const evidence = await refundRail.refund(hashLock0x);
    expect(evidence.ref).toBe(hashLock0x);

    const gas = measuredGasBurnt(buyerRpc);
    console.log(`[gas] refund total gas_burnt = ${gas.toString()} (${(Number(gas) / 1e12).toFixed(2)} Tgas)`);
    expect(gas).toBeGreaterThan(0n);

    const balanceAfter = BigInt(await sandbox.usdcBalanceOf(sandbox.buyer.accountId));
    expect(balanceAfter).toBe(balanceBefore + BigInt(amount));

    const view = await getLockView(hashLock0x);
    expect(view?.status).toBe("Refunded");

    // claim after a refund is refused (the lock is no longer Locked).
    const { rail: sellerRail } = await connect(sandbox.seller.signer);
    await expect(sellerRail.claim(hashLock0x, preimage0x, refundAfterMs + 60_000)).rejects.toThrow(/not in a claimable "Locked" state/);
  });

  it("a malformed ft_transfer_call msg is refused by ft_on_transfer and the full amount returns to the buyer, with no lock created", async () => {
    const buyerBalanceBefore = BigInt(await sandbox.usdcBalanceOf(sandbox.buyer.accountId));
    const rpc = sandbox.createCapturingRpc();
    const outcome = await sendRawTx(rpc, sandbox.buyer.signer, sandbox.buyer.accountId, sandbox.usdcToken, [
      ftTransferCallAction(sandbox.htlcContract, "321", "not json at all"),
    ]);
    const status = outcome.status as Record<string, unknown>;
    expect("Failure" in status).toBe(false);

    const buyerBalanceAfter = BigInt(await sandbox.usdcBalanceOf(sandbox.buyer.accountId));
    expect(buyerBalanceAfter).toBe(buyerBalanceBefore); // refused in full, round-tripped back to the buyer
  });

  it("claim to an unregistered payee is refused before sending (pre-check); forced past the pre-check, the callback reverts to Locked with the preimage now public", async () => {
    const { preimageHex, preimage0x, hashLock0x, hashLockHex } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 20 * 60_000;
    const amount = "42";
    const unregisteredPayee = "nobody.test.near"; // syntactically valid NEAR account id, never storage_deposit'd on the token

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: unregisteredPayee, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    // Pre-check: NearHtlcRail.claim's own no-secret storage_balance_of check refuses before ever
    // signing or sending — proven by asserting no send_tx exchange happened.
    const { rail: sellerRail, rpc: sellerRpc } = await connect(sandbox.seller.signer);
    await expect(sellerRail.claim(hashLock0x, preimage0x, refundAfterMs - 1000)).rejects.toThrow(/is not storage-registered/);
    expect(sellerRpc.exchanges().some((e) => e.method === "send_tx")).toBe(false);

    // Forced past the pre-check: build and send the claim transaction directly, bypassing
    // NearHtlcRail's own TS-side guard entirely.
    const rawRpc = sandbox.createCapturingRpc();
    const outcome = await sendRawTx(rawRpc, sandbox.seller.signer, sandbox.seller.accountId, sandbox.htlcContract, [
      {
        type: "FunctionCall",
        methodName: "claim",
        args: new TextEncoder().encode(JSON.stringify({ hash_lock: hashLockHex, preimage: preimageHex })),
        gas: 60n * TGAS,
        deposit: 0n,
      },
    ]);
    const status = outcome.status as Record<string, unknown>;
    expect("Failure" in status).toBe(false); // the OUTER claim() call succeeds; the inner transfer promise is what fails

    const view = await getLockView(hashLock0x);
    // Documented consequence (contracts-near/README.md "known limits"): the payout callback
    // failed (the token's own ft_transfer panics on an unregistered receiver), so status reverts
    // to Locked -- but the preimage was already revealed by claim() itself, before the transfer
    // promise ever ran, so it stays public even though the claim did not pay out.
    expect(view?.status).toBe("Locked");
    expect(view?.preimage).toBe(preimageHex);

    // The Buyer must still learn `s` from this revealed-but-Locked state (its leg A is spent
    // for good: the contract refuses the refund and the Seller may retry the payout any time),
    // otherwise it misses leg B — findClaimedPreimage does not gate on the status.
    await expect(buyerRail.findClaimedPreimage(hashLock0x)).resolves.toBe(preimage0x);
    await expect(buyerRail.refund(hashLock0x)).rejects.toThrow();
  });

  it("recovers a lost reply by transaction hash; an unknown transaction hash resolves to null", async () => {
    const { hashLock0x } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 20 * 60_000;

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount: "9", payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
    const evidence = await buyerRail.commitLock();

    const recovered = await buyerRail.recoverByTxHash(evidence.txHash, sandbox.buyer.accountId);
    expect(recovered).not.toBeNull();
    expect(recovered?.blockHash).toBe(evidence.blockHash);

    const fakeTxHash = base58.encode(randomBytes(32));
    const notFound = await buyerRail.recoverByTxHash(fakeTxHash, sandbox.buyer.accountId);
    expect(notFound).toBeNull();
  });

  it("evidence reader (captureNearLeg + nearEvidence) reports locked, claimed and refunded from the live chain", async () => {
    // Locked.
    {
      const { hashLock0x } = randomHashLock();
      const now = await chainNowMs();
      const claimByMs = now + 10 * 60_000;
      const refundAfterMs = now + 20 * 60_000;
      const amount = "555";
      const { rail: buyerRail } = await connect(sandbox.buyer.signer);
      await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
      await buyerRail.commitLock();

      const terms = lockTermsFixture(hashLock0x, amount, claimByMs, refundAfterMs);
      const accounts: NearAccounts = { payee: sandbox.seller.accountId, payer: sandbox.buyer.accountId };
      const evidenceRpc = sandbox.createCapturingRpc();
      const { index, exchanges } = await captureNearLeg(evidenceRpc, sandbox.config, terms, accounts, hashLock0x, Date.now());
      const capture: NearCapture = { index, bytes: verifiedExchangeBytes(exchanges as Exchange[]) };
      const result = nearEvidence({ terms, config: sandbox.config, accounts, capture });
      expect(result.lock.railVerified).toBe(true);
      expect(result.rail?.status).toBe("locked");
      expect(result.rail?.final).toBe(true);
    }

    // Claimed.
    {
      const { preimage0x, hashLock0x } = randomHashLock();
      const now = await chainNowMs();
      const claimByMs = now + 10 * 60_000;
      const refundAfterMs = now + 20 * 60_000;
      const amount = "666";
      const { rail: buyerRail } = await connect(sandbox.buyer.signer);
      await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
      await buyerRail.commitLock();
      const { rail: sellerRail } = await connect(sandbox.seller.signer);
      await sellerRail.claim(hashLock0x, preimage0x, refundAfterMs - 1000);

      const terms = lockTermsFixture(hashLock0x, amount, claimByMs, refundAfterMs);
      const accounts: NearAccounts = { payee: sandbox.seller.accountId, payer: sandbox.buyer.accountId };
      const evidenceRpc = sandbox.createCapturingRpc();
      const { index, exchanges } = await captureNearLeg(evidenceRpc, sandbox.config, terms, accounts, hashLock0x, Date.now());
      const capture: NearCapture = { index, bytes: verifiedExchangeBytes(exchanges as Exchange[]) };
      const result = nearEvidence({ terms, config: sandbox.config, accounts, capture });
      expect(result.rail?.status).toBe("claimed");
    }

    // Refunded.
    {
      const { hashLock0x } = randomHashLock();
      const now = await chainNowMs();
      const claimByMs = now + 2_000;
      const refundAfterMs = now + 4_000;
      const amount = "888";
      const { rail: buyerRail } = await connect(sandbox.buyer.signer);
      await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
      await buyerRail.commitLock();
      await sandbox.fastForward(150);
      await buyerRail.refund(hashLock0x);

      const terms = lockTermsFixture(hashLock0x, amount, claimByMs, refundAfterMs);
      const accounts: NearAccounts = { payee: sandbox.seller.accountId, payer: sandbox.buyer.accountId };
      const evidenceRpc = sandbox.createCapturingRpc();
      const { index, exchanges } = await captureNearLeg(evidenceRpc, sandbox.config, terms, accounts, hashLock0x, Date.now());
      const capture: NearCapture = { index, bytes: verifiedExchangeBytes(exchanges as Exchange[]) };
      const result = nearEvidence({ terms, config: sandbox.config, accounts, capture });
      expect(result.rail?.status).toBe("refunded");
    }
  });
});
