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
import {
  NearHtlcRail,
  NearLockRefusedError,
  NearPayoutFailedError,
  NearTxFailedError,
  type NearHtlcTerms,
  type NearSigner,
} from "../src/rails/near-htlc.js";
import { NearRpc, NearTimeoutError, type NearWaitUntil } from "../src/rails/near-rpc.js";
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
  async function sendRawTx(rpc: CapturingRpc, signer: NearSigner, signerAccountId: string, receiverId: string, actions: NearAction[], waitUntil: NearWaitUntil = "FINAL") {
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
    return near.sendTx(Buffer.from(built.signedBytes).toString("base64"), waitUntil);
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

  /** NEP-145, one-yocto pattern — `force` omitted (the caller's own balance must be zero, true
   *  for a payee that has never been paid out). */
  function storageUnregisterAction(): NearAction {
    return {
      type: "FunctionCall",
      methodName: "storage_unregister",
      args: new TextEncoder().encode(JSON.stringify({})),
      gas: 30n * TGAS,
      deposit: 1n,
    };
  }

  function storageDepositAction(accountId: string, depositYocto: bigint): NearAction {
    return {
      type: "FunctionCall",
      methodName: "storage_deposit",
      args: new TextEncoder().encode(JSON.stringify({ account_id: accountId })),
      gas: 30n * TGAS,
      deposit: depositYocto,
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

    const recovered = await buyerRail.recoverByTxHash(evidence.txHash, sandbox.buyer.accountId, hashLock0x);
    expect(recovered).not.toBeNull();
    expect(recovered?.blockHash).toBe(evidence.blockHash);
    expect(recovered?.ref).toBe(hashLock0x); // H4: the CALLER's own expectedRef, not the raw txHash

    // H4 (confirmed live, this stage): `EXPERIMENTAL_tx_status` for a hash the node has NEVER
    // seen does not answer quickly with a "not found" error the way a view call would — it
    // long-polls until its own internal wait expires, then answers with a structured
    // `TIMEOUT_ERROR` cause (near-rpc.ts's own file-header comment). `recoverByTxHash` reports
    // that as `NearTimeoutError`, never collapsing it to `null` — a genuine "I don't know, ask
    // again" is not the same as "this was never broadcast" (H4: "returns null only for
    // unknown"). This assertion is intentionally slow (waits out the node's own real timeout).
    const fakeTxHash = base58.encode(randomBytes(32));
    await expect(buyerRail.recoverByTxHash(fakeTxHash, sandbox.buyer.accountId, hashLock0x)).rejects.toBeInstanceOf(NearTimeoutError);
  });

  // ── H1 S1/S2/S3 probes, the H2 revealed-lock retry, and H6's code-hash/key-list checks ──────

  it("H1 S1 (sandbox): the payee is unregistered between the adapter's own pre-check and the send — claim throws NearPayoutFailedError, preimage still revealed", async () => {
    const { preimageHex, preimage0x, hashLock0x } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 20 * 60_000;
    const amount = "111";

    // A FRESH payee with a GUARANTEED zero balance — `sandbox.seller` is reused (and credited)
    // across this whole file's earlier tests, and near-contract-standards' own
    // `storage_unregister` panics rather than unregistering when the caller's own balance is
    // nonzero, so it would never actually leave the registered state below.
    const payee = await sandbox.createFundedAccount("s1-payee.test.near");

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: payee.accountId, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    // Unregister the payee with `wait_until: "INCLUDED"` (optimistic — resolves once applied to
    // the chain's real current state, not once FINAL). `NearHtlcRail`'s own pre-check
    // (`storage_balance_of`) always reads at "final" (D-N10), which trails the optimistic head by
    // ~2 blocks (D-N3/D-N7) — so the pre-check below still sees the payee as registered, exactly
    // reproducing "registered at the pre-check, unregistered by the time the write actually
    // executes" without any artificial delay or timing guess: the claim TRANSACTION itself,
    // whenever the validator processes it, always runs against the chain's real (already
    // unregistered) current state, never against a stale "final" snapshot.
    const unregRpc = sandbox.createCapturingRpc();
    try {
      await sendRawTx(unregRpc, payee.signer, payee.accountId, sandbox.usdcToken, [storageUnregisterAction()], "INCLUDED");
    } catch (error) {
      // `wait_until: "INCLUDED"`'s own response is lighter than the full FinalExecutionOutcome
      // shape `NearRpc`'s `decodeOutcome` expects (built around "FINAL", the only level
      // production code ever uses) — the transaction is still genuinely included on chain by the
      // time this resolves or throws this specific decode error; only rethrow anything else.
      if (!(error instanceof Error) || !error.message.includes("outcome is missing")) throw error;
    }

    // Submitted by the BUYER, not the seller: `claim` is permissionless (any account may send
    // it), and using a different signer than the one that just sent the unregister avoids a
    // spurious nonce collision — the seller's own access key nonce (read at "final", D-N10) still
    // lags ~2 blocks behind its own just-included unregister transaction, so a SECOND
    // "final"-pinned nonce read for the SAME key could otherwise race the first and pick the same
    // next nonce, an artifact of this test's own race technique rather than anything H1 is about.
    let caught: unknown;
    try {
      // H3: notAfterMs must clear the 30s landing margin before refundAfterMs on an unrevealed
      // (first) attempt, or the adapter's own margin guard would refuse before ever reaching the
      // network — this scenario is about the payout callback failing, not the margin guard.
      await buyerRail.claim(hashLock0x, preimage0x, refundAfterMs - 60_000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NearPayoutFailedError);
    expect((caught as NearPayoutFailedError).preimage).toBe(preimage0x);

    const view = await getLockView(hashLock0x);
    expect(view?.status).toBe("Locked");
    expect(view?.preimage).toBe(preimageHex);
  });

  it("H1 S2 (sandbox): refunding a revealed-but-Locked lock is refused by the contract itself — refund() throws NearTxFailedError", async () => {
    const { preimageHex, preimage0x, hashLock0x, hashLockHex } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 2_000;
    const refundAfterMs = now + 4_000;
    const amount = "222";
    const unregisteredPayee = "nobody-s2.test.near"; // syntactically valid, never storage_deposit'd

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: unregisteredPayee, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    // Force a revealed-but-Locked lock: claim is permissionless, so the seller's own signer can
    // send it directly for an unregistered payee, bypassing NearHtlcRail's own pre-check on
    // purpose (mirrors the existing "claim to an unregistered payee" scenario above).
    await sendRawTx(sandbox.createCapturingRpc(), sandbox.seller.signer, sandbox.seller.accountId, sandbox.htlcContract, [
      { type: "FunctionCall", methodName: "claim", args: new TextEncoder().encode(JSON.stringify({ hash_lock: hashLockHex, preimage: preimageHex })), gas: 60n * TGAS, deposit: 0n },
    ]);
    const preClaim = await getLockView(hashLock0x);
    expect(preClaim?.status).toBe("Locked");
    expect(preClaim?.preimage).toBe(preimageHex);

    await sandbox.fastForward(150); // past refundAfterMs

    await expect(buyerRail.refund(hashLock0x)).rejects.toThrow(NearTxFailedError);
    // the preimage is still public and the lock is untouched by the refused refund attempt.
    const after = await getLockView(hashLock0x);
    expect(after?.status).toBe("Locked");
    expect(after?.preimage).toBe(preimageHex);
    void preimage0x;
  });

  it("H1 S3 (sandbox): a duplicate hash_lock is refused by ft_on_transfer even though the outer transfer call succeeds — commitLock throws NearLockRefusedError", async () => {
    const { hashLock0x } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 10 * 60_000;
    const refundAfterMs = now + 20 * 60_000;

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount: "10", payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
    const firstEvidence = await buyerRail.commitLock();
    expect(firstEvidence.ref).toBe(hashLock0x);

    // Second attempt under the SAME hash lock, a different amount — the contract's own
    // first-writer-wins rule refuses it (ft_on_transfer returns the full amount), but the OUTER
    // ft_transfer_call transaction itself still reports Success. The adapter's own post-send
    // get_lock re-read (H1) must catch that the terms it sent don't match what is actually on
    // chain (still the FIRST lock, amount "10").
    const { rail: buyerRail2 } = await connect(sandbox.buyer.signer);
    await buyerRail2.prepareLock({ hashLock: hashLock0x, amount: "99", payee: sandbox.seller.accountId, claimByMs, refundAfterMs });
    await expect(buyerRail2.commitLock()).rejects.toThrow(NearLockRefusedError);

    // The original lock is untouched.
    const view = await getLockView(hashLock0x);
    expect(view?.amount).toBe("10");
  });

  it("H2 (sandbox): a revealed-but-Locked claim retried past refundAfterMs succeeds once the payee is registered", async () => {
    const { preimageHex, preimage0x, hashLock0x, hashLockHex } = randomHashLock();
    const now = await chainNowMs();
    const claimByMs = now + 2_000;
    const refundAfterMs = now + 4_000;
    const amount = "321";
    const unregisteredPayee = "nobody-h2.test.near";

    const { rail: buyerRail } = await connect(sandbox.buyer.signer);
    await buyerRail.prepareLock({ hashLock: hashLock0x, amount, payee: unregisteredPayee, claimByMs, refundAfterMs });
    await buyerRail.commitLock();

    // Force a revealed-but-Locked lock (same pattern as S2 above): the payout fails because the
    // payee was never storage-registered.
    await sendRawTx(sandbox.createCapturingRpc(), sandbox.seller.signer, sandbox.seller.accountId, sandbox.htlcContract, [
      { type: "FunctionCall", methodName: "claim", args: new TextEncoder().encode(JSON.stringify({ hash_lock: hashLockHex, preimage: preimageHex })), gas: 60n * TGAS, deposit: 0n },
    ]);
    expect((await getLockView(hashLock0x))?.status).toBe("Locked");

    await sandbox.fastForward(150); // now well past refundAfterMs

    // An UNREVEALED retry would be refused here (H2 never applies) — proven hermetically
    // (tests/near-htlc.test.ts); this scenario is already revealed, so the retry exemption does
    // apply. Register the payee (any signer may pay another account's own storage deposit), then
    // retry through the REAL adapter — notAfterMs is deliberately already in the past, which
    // would be refused up front (H3) on an unrevealed lock, but must succeed here.
    await sendRawTx(sandbox.createCapturingRpc(), sandbox.buyer.signer, sandbox.buyer.accountId, sandbox.usdcToken, [
      storageDepositAction(unregisteredPayee, 50_000_000_000_000_000_000_000n / 20n),
    ]);

    const balanceBefore = BigInt(await sandbox.usdcBalanceOf(unregisteredPayee));
    const { rail: sellerRail } = await connect(sandbox.seller.signer);
    const evidence = await sellerRail.claim(hashLock0x, preimage0x, refundAfterMs - 1_000); // already in the past
    expect(evidence.ref).toBe(hashLock0x);

    const balanceAfter = BigInt(await sandbox.usdcBalanceOf(unregisteredPayee));
    expect(balanceAfter).toBe(balanceBefore + BigInt(amount));
    expect((await getLockView(hashLock0x))?.status).toBe("Claimed");
  });

  it("H6 (sandbox): connect() refuses when htlcCodeHash does not match the live contract's own code_hash", async () => {
    const wrongHash = base58.encode(sha256(new TextEncoder().encode("definitely not the reviewed wasm")));
    const badConfig = { ...sandbox.config, htlcCodeHash: wrongHash };
    const rpc = sandbox.createCapturingRpc();
    await expect(NearHtlcRail.connect({ config: badConfig, rpc, signer: sandbox.buyer.signer, clock: Date.now })).rejects.toThrow(/code_hash/);
  });

  it("H6 (sandbox): connect() refuses when the contract still holds an access key", async () => {
    const { contract, codeHash } = await sandbox.deployUnlockedHtlcClone("htlc-unlocked.test.near");
    const badConfig = { ...sandbox.config, contract, htlcCodeHash: codeHash };
    const rpc = sandbox.createCapturingRpc();
    await expect(NearHtlcRail.connect({ config: badConfig, rpc, signer: sandbox.buyer.signer, clock: Date.now })).rejects.toThrow(/access key/);
  });

  it("H6 (sandbox): connect() succeeds against the suite's own locked, correctly-hashed contract (sanity — proven implicitly by every other test, asserted explicitly here)", async () => {
    const rpc = sandbox.createCapturingRpc();
    const rail = await NearHtlcRail.connect({ config: sandbox.config, rpc, signer: sandbox.buyer.signer, clock: Date.now });
    expect(rail).toBeInstanceOf(NearHtlcRail);
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
      await sellerRail.claim(hashLock0x, preimage0x, refundAfterMs - 60_000); // H3: clear the landing margin

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
