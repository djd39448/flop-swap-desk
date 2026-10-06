// SPDX-License-Identifier: MIT
//
// tests/rail-recovery-near-sim.test.ts: the NEAR rail's recovery against the stateful node (tests/helpers/near-stateful-rpc.ts), which
// remembers every transaction, moves its blocks on demand and answers `send_tx` the way a real node does (`Expired`, invalid nonce).
// Review round 1 (P8-FIXES-R1.md), at the rail level:
//   - R1-10: a lock or refund that was signed, saved and never sent is `unknown` for the read; the identical bytes are sent once by
//     `resendLock` / `resendRefund` and either land or, once the node calls them `Expired`, are `never-landed` (a fresh one may follow);
//   - R1-19: a transaction whose nonce moved is only `never-landed` once the lock row was read three blocks later: the
//     `ft_on_transfer` receipt that creates the row comes a couple of blocks after the nonce moves.
// The reads never send: `node.sendTxReceived` is the oracle.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { LockTerms } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import type { ConnectedCounterAssetRail, LockRecovery, PreparedLock } from "../src/client/counter-rail.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { decodeSignedTransactionHeader } from "../src/rails/near-borsh.js";
import { NEAR_RECEIPT_SETTLE_BLOCKS, NEAR_SETTLE_MAX_POLLS } from "../src/rails/near-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { BUYER_ACCOUNT, CONTRACT, HTLC_CODE_HASH, SELLER_ACCOUNT, StatefulNearRpc, USDC, fetchFor, nearConfig } from "./helpers/near-stateful-rpc.js";

const T0 = 1_700_000_000_000;
const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
const HASH_HEX = HASH_LOCK.slice(2);
const REF = `${HASH_LOCK}:${BUYER_ACCOUNT}`;
const CLAIM_BY_MS = T0 + 60 * 60_000;
const REFUND_AFTER_MS = T0 + 2 * 60 * 60_000;

const terms: LockTerms = {
  contract: `0x${"33".repeat(32)}`,
  lock: "hash",
  statement: HASH_LOCK,
  amount: "1000000",
  asset: "USDC",
  payer: "did:key:payer",
  payee: "did:key:payee",
  claimByMs: CLAIM_BY_MS,
  refundAfterMs: REFUND_AFTER_MS,
};
const accounts = { payer: BUYER_ACCOUNT, payee: SELLER_ACCOUNT };

const buyerSigner = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(11));
const sellerSigner = InMemoryNearSigner.generate(SELLER_ACCOUNT, new Uint8Array(32).fill(22));

interface Cut {
  /** Every `send_tx` body that reached the wire, in order (the bytes the rail sent). */
  sent: string[];
  /** The next `send_tx` never reaches the node: the process "died" before it (a transport failure the rail sees). */
  failNextSend: boolean;
  /** Runs when a `send_tx` is about to reach the node (a place for another transaction to take the nonce first). */
  beforeSend: ((signedTxBase64: string) => void) | undefined;
  /** Runs after the node answered a `send_tx`, before the rail sees the answer (a place for the world to move on). */
  afterSend: (() => void) | undefined;
}

function world(options: { sleep?: () => Promise<void> } = {}) {
  const node = new StatefulNearRpc(CONTRACT, USDC, HTLC_CODE_HASH, T0);
  node.registerStorage(BUYER_ACCOUNT);
  node.registerStorage(SELLER_ACCOUNT);
  const config = nearConfig();
  const cut: Cut = { sent: [], failNextSend: false, beforeSend: undefined, afterSend: undefined };
  const base = fetchFor(node);
  const buyerFetch = (async (url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { method: string; params: { signed_tx_base64?: string } };
    if (parsed.method === "send_tx") {
      cut.sent.push(String(parsed.params.signed_tx_base64));
      if (cut.failNextSend) {
        cut.failNextSend = false;
        throw new Error("connection reset (test: the process died before the send reached the node)");
      }
      cut.beforeSend?.(String(parsed.params.signed_tx_base64));
      const answered = await base(url as string, init);
      cut.afterSend?.();
      return answered;
    }
    return base(url as string, init);
  }) as typeof fetch;
  const clock = () => node.nowMs;
  const rails = (sleep: () => Promise<void> = options.sleep ?? (async () => node.advanceBlocks(1))) => ({
    buyer: createNearCounterRail({ config, rpc: new CapturingRpc({ endpoint: config.endpoint, fetch: buyerFetch, clock }), signer: buyerSigner, clock, sleep }),
    seller: createNearCounterRail({ config, rpc: new CapturingRpc({ endpoint: config.endpoint, fetch: base, clock }), signer: sellerSigner, clock, sleep }),
  });
  const { buyer, seller } = rails();
  return {
    node,
    cut,
    /** A restarted process: a new rail object, a new connection, only what was persisted in hand. */
    freshBuyer: (): Promise<ConnectedCounterAssetRail> => rails().buyer.connect(terms, accounts),
    buyerAdapter: buyer,
    connectBuyer: (): Promise<ConnectedCounterAssetRail> => buyer.connect(terms, accounts),
    connectSeller: (): Promise<ConnectedCounterAssetRail> => seller.connect(terms, accounts),
    railsWith: rails,
  };
}
type World = ReturnType<typeof world>;

const nearHandle = (prepared: PreparedLock): Extract<LockRecovery, { chain: "near" }> => {
  if (prepared.recovery?.chain !== "near") throw new Error("test: expected a near handle");
  return prepared.recovery;
};
const row = (w: World) => w.node.getLockRow(HASH_HEX, BUYER_ACCOUNT);
const nonceOf = (recovery: Extract<LockRecovery, { chain: "near" }>): number => Number(decodeSignedTransactionHeader(Uint8Array.from(Buffer.from(recovery.signedTxBase64, "base64"))).nonce);

/** The Buyer's lock lands (prepare, then commit). */
async function lockLanded(w: World): Promise<PreparedLock> {
  const rail = await w.connectBuyer();
  const prepared = await rail.prepareLock(terms, 0);
  await rail.commitLock();
  expect(row(w)?.status).toBe("Locked");
  return prepared;
}

/** The Buyer's signed lock that never reached the node. */
async function lockSignedNeverSent(w: World): Promise<{ prepared: PreparedLock; recovery: Extract<LockRecovery, { chain: "near" }> }> {
  const rail = await w.connectBuyer();
  const prepared = await rail.prepareLock(terms, 0);
  return { prepared, recovery: nearHandle(prepared) };
}

/** The Buyer's refund, signed and handed to `onSigned`, that never reached the node (chain time is past refundAfterMs). */
async function refundSignedNeverSent(w: World): Promise<Extract<LockRecovery, { chain: "near" }>> {
  await lockLanded(w);
  w.node.nowMs = REFUND_AFTER_MS + 1;
  w.cut.failNextSend = true;
  const rail = await w.connectBuyer();
  let recovery: LockRecovery | undefined;
  await expect(rail.refund(REF, { onSigned: (r) => void (recovery = r) })).rejects.toThrow(/connection reset/);
  if (recovery?.chain !== "near") throw new Error("test: onSigned was not called with a near handle");
  expect(w.node.refundSendTxCalls).toBe(0);
  return recovery;
}

describe("R1-10: a signed refund or lock that was never sent", () => {
  it("the read says `unknown` and sends nothing; resendRefund sends the IDENTICAL bytes once and the refund lands", async () => {
    const w = world();
    const recovery = await refundSignedNeverSent(w);
    const rail = await w.freshBuyer();
    const received = w.node.sendTxReceived;
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("unknown");
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("unknown");
    expect(w.node.sendTxReceived).toBe(received);
    await expect(rail.resendRefund?.(REF, recovery)).resolves.toBe("landed");
    expect(w.cut.sent.at(-1)).toBe(recovery.signedTxBase64);
    expect(w.node.refundSendTxCalls).toBe(1);
    expect(row(w)?.status).toBe("Refunded");
  });

  it("days later, when the node calls the bytes Expired: never-landed, nothing was applied, and exactly one FRESH refund then lands", async () => {
    const w = world();
    w.node.txValidityPeriodBlocks = 50;
    const recovery = await refundSignedNeverSent(w);
    w.node.advanceBlocks(51);
    const rail = await w.freshBuyer();
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("unknown"); // the read cannot tell: the nonce never moved
    await expect(rail.resendRefund?.(REF, recovery)).resolves.toBe("never-landed");
    expect(w.node.sendTxExpired).toBe(1);
    expect(w.node.refundSendTxCalls).toBe(0);
    expect(row(w)?.status).toBe("Locked");
    // the proof makes one more refund safe, and it lands (a fresh transaction, built on a fresh block hash)
    await (await w.freshBuyer()).refund(REF);
    expect(w.node.refundSendTxCalls).toBe(1);
    expect(row(w)?.status).toBe("Refunded");
  });

  it("another transaction took the nonce between the read and the send: the node's invalid-nonce answer is never-landed once the lock still reads Locked three blocks later", async () => {
    const w = world();
    const recovery = await refundSignedNeverSent(w);
    w.cut.beforeSend = () => w.node.consumeNonce(BUYER_ACCOUNT, nonceOf(recovery));
    const rail = await w.freshBuyer();
    const startHeight = w.node.height;
    await expect(rail.resendRefund?.(REF, recovery)).resolves.toBe("never-landed");
    expect(w.node.sendTxInvalidNonce).toBe(1);
    expect(w.node.refundSendTxCalls).toBe(0);
    expect(w.node.height).toBeGreaterThanOrEqual(startHeight + NEAR_RECEIPT_SETTLE_BLOCKS);
  });

  it("a transport failure on the re-send is pending, and a second try (the network is back) lands it; the bytes are the same both times", async () => {
    const w = world();
    const recovery = await refundSignedNeverSent(w);
    const rail = await w.freshBuyer();
    w.cut.failNextSend = true;
    await expect(rail.resendRefund?.(REF, recovery)).resolves.toBe("pending");
    expect(w.node.refundSendTxCalls).toBe(0);
    await expect(rail.resendRefund?.(REF, recovery)).resolves.toBe("landed");
    expect(w.cut.sent.slice(-2)).toEqual([recovery.signedTxBase64, recovery.signedTxBase64]);
    expect(w.node.refundSendTxCalls).toBe(1);
  });

  it("a refund whose payout failed on chain (the lock back to Locked) is a typed NearRefundFailedError, never called never-landed", async () => {
    const w = world();
    const recovery = await refundSignedNeverSent(w);
    w.node.unregisterStorage(BUYER_ACCOUNT); // the refund's payout will fail: the contract puts the lock back to Locked
    const rail = await w.freshBuyer();
    await expect(rail.resendRefund?.(REF, recovery)).rejects.toMatchObject({ name: "NearRefundFailedError" });
    expect(w.node.refundSendTxCalls).toBe(1);
  });

  it("a lock signed and never sent: unknown; resendLock sends the identical bytes once and the lock lands, once", async () => {
    const w = world();
    const { prepared, recovery } = await lockSignedNeverSent(w);
    const rail = await w.freshBuyer();
    await expect(rail.recoverLock(prepared)).resolves.toBe("unknown");
    expect(w.node.sendTxReceived).toBe(0);
    await expect(rail.resendLock?.(prepared)).resolves.toBe("landed");
    expect(w.cut.sent).toEqual([recovery.signedTxBase64]);
    expect(w.node.lockRowsCreated).toBe(1);
    await expect(rail.recoverLock(prepared)).resolves.toBe("landed"); // and a later read agrees
    expect(w.node.lockSendTxCalls).toBe(1);
  });

  it("a lock signed and never sent, the bytes Expired: never-landed; one fresh lock then lands and there is exactly one lock", async () => {
    const w = world();
    w.node.txValidityPeriodBlocks = 50;
    const { prepared } = await lockSignedNeverSent(w);
    w.node.advanceBlocks(51);
    const rail = await w.freshBuyer();
    await expect(rail.recoverLock(prepared)).resolves.toBe("unknown");
    await expect(rail.resendLock?.(prepared)).resolves.toBe("never-landed");
    expect(w.node.sendTxExpired).toBe(1);
    expect(w.node.lockSendTxCalls).toBe(0);
    const again = await w.freshBuyer();
    const fresh = await again.prepareLock(terms, 0);
    expect(fresh.ref).toBe(prepared.ref); // the ref is the hash lock and the payer: the same lock, new transaction
    expect(nearHandle(fresh).txHash).not.toBe(nearHandle(prepared).txHash);
    await again.commitLock();
    expect(w.node.lockRowsCreated).toBe(1);
    expect(w.node.lockSendTxCalls).toBe(1);
  });
});

describe("R1-19: never-landed for a lock waits for the receipt (three blocks past the nonce)", () => {
  /** The Buyer's lock that landed with its reply lost, while the node hides the transaction and creates the row late. */
  async function landedButRowLate(w: World): Promise<PreparedLock> {
    w.node.lockRowDelayBlocks = 2;
    const rail = await w.connectBuyer();
    const prepared = await rail.prepareLock(terms, 0);
    w.node.dropNextSendTxReply = true;
    await expect(rail.commitLock()).rejects.toThrow();
    w.node.txStatusUnknown = true;
    return prepared;
  }

  it("the nonce moved, the node does not know the transaction and no row shows YET: landed once the row appears, never never-landed", async () => {
    const w = world();
    const prepared = await landedButRowLate(w);
    // the lock row exists in the node but is not visible at the head: a read right now shows nothing
    const rail = await w.freshBuyer();
    const startHeight = w.node.height;
    await expect(rail.recoverLock(prepared)).resolves.toBe("landed");
    expect(w.node.height).toBeGreaterThanOrEqual(startHeight + 1); // the rail waited for later blocks
    expect(w.node.lockRowsCreated).toBe(1);
    expect(w.node.sendTxReceived).toBe(1); // only the original send
  });

  it("the nonce moved but no lock ever shows (another transaction took it): never-landed, after a look three blocks past the nonce", async () => {
    const w = world();
    const { prepared, recovery } = await lockSignedNeverSent(w);
    w.node.consumeNonce(BUYER_ACCOUNT, nonceOf(recovery));
    const rail = await w.freshBuyer();
    const startHeight = w.node.height;
    await expect(rail.recoverLock(prepared)).resolves.toBe("never-landed");
    expect(w.node.height).toBeGreaterThanOrEqual(startHeight + NEAR_RECEIPT_SETTLE_BLOCKS);
  });

  it("a chain that does not move on (the wait runs out) is pending, never never-landed", async () => {
    const w = world();
    const { prepared, recovery } = await lockSignedNeverSent(w);
    w.node.consumeNonce(BUYER_ACCOUNT, nonceOf(recovery));
    let sleeps = 0;
    const stalled = w.railsWith(async () => void (sleeps += 1)).buyer;
    await expect((await stalled.connect(terms, accounts)).recoverLock(prepared)).resolves.toBe("pending");
    expect(sleeps).toBe(NEAR_SETTLE_MAX_POLLS);
  });
});
