// SPDX-License-Identifier: MIT
//
// tests/rail-recovery-near.test.ts: P8-RESUME-SPEC.md "Rail seam" and "Rail recovery" for the NEAR leg. A Buyer that
// dies between `prepareLock` and the end of `commitLock` must find out what became of the ONE signed transaction, from
// the transaction hash and bytes it persisted:
//   - `prepareLock` hands out the hash and the complete signed bytes;
//   - `recoverLock` reads the access key's nonce FIRST, then the transaction by hash, then the lock by ref, and says
//     `never-landed` only when the nonce has moved past the transaction's and nothing else shows it (a landing between
//     the reads cannot be missed because the views only move forward);
//   - a refund hands its hash and bytes to `onSigned` before anything is sent, and `recoverRefund` resolves it.
// Runs against a method-dispatching mock of the near-sandbox JSON-RPC surface (no node, no key outside memory).

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import type { LockTerms } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { RailRecoveryRefusedError, type ConnectedCounterAssetRail, type LockRecovery, type PreparedLock } from "../src/client/counter-rail.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { buildSignedTransaction, decodeSignedTransactionHeader, encodeSignedTransaction } from "../src/rails/near-borsh.js";
import { NEAR_SANDBOX_PIN, NearLockRefusedError, NearTxFailedError, type NearRailConfig } from "../src/rails/near-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";

// -- fixtures ------------------------------------------------------------------------------------------------------

const CONTRACT = "htlc.near-sandbox-flop";
const USDC = "usdc.near-sandbox-flop";
const HTLC_CODE_HASH = "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT";
const CONFIG: NearRailConfig = { pin: NEAR_SANDBOX_PIN, endpoint: "http://127.0.0.1:9999", contract: CONTRACT, assets: { USDC }, htlcCodeHash: HTLC_CODE_HASH };
const BUYER_ACCOUNT = "buyer.near-sandbox-flop";
const SELLER_ACCOUNT = "seller.near-sandbox-flop";
const buyerSigner = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(1));
const sellerSigner = InMemoryNearSigner.generate(SELLER_ACCOUNT, new Uint8Array(32).fill(2));
const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
const REF = `${HASH_LOCK}:${BUYER_ACCOUNT}`;
const BLOCK_HASH = "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM";
const CLAIM_BY_MS = 1_700_000_000_000;
const REFUND_AFTER_MS = 1_800_000_000_000;

function lockTerms(): LockTerms {
  return {
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
}
const ACCOUNTS = { payer: BUYER_ACCOUNT, payee: SELLER_ACCOUNT };

// -- the mock node -----------------------------------------------------------------------------------------------------

interface Call {
  method: string;
  params: unknown;
}
interface Node {
  /** The access key's nonce at the final block. */
  keyNonce: number;
  /** What `get_lock` answers (null: no lock). */
  lock: Record<string, unknown> | null;
  /** What `EXPERIMENTAL_tx_status` answers for the hash asked about. */
  tx: "unknown" | "timeout" | "transport-error" | ((txHash: string) => Record<string, unknown>);
  /** What `send_tx` answers (and the hook that changes the world when a transaction is sent). */
  onSend?: (signedTxBase64: string) => Record<string, unknown>;
  /** `status().chain_id` per call, last one repeats. */
  chainIds: string[];
  /** Runs before the reply to a named method, so a test can move the chain between two reads. */
  before?: (method: string) => void;
  calls: Call[];
}

function lockRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "Locked",
    payer: BUYER_ACCOUNT,
    payee: SELLER_ACCOUNT,
    token: USDC,
    amount: "1000000",
    claim_by_ms: String(CLAIM_BY_MS),
    refund_after_ms: String(REFUND_AFTER_MS),
    ...overrides,
  };
}

function newNode(overrides: Partial<Node> = {}): Node {
  return { keyNonce: 4, lock: null, tx: "unknown", chainIds: ["near-sandbox-flop"], calls: [], ...overrides };
}

function functionCall(methodName: string, args: unknown, deposit: string): Record<string, unknown> {
  return { FunctionCall: { method_name: methodName, args: Buffer.from(JSON.stringify(args)).toString("base64"), gas: 20_000_000_000_000, deposit } };
}
function lockCall(): Record<string, unknown> {
  const msg = { hash_lock: HASH_LOCK.slice(2), payee: SELLER_ACCOUNT, claim_by_ms: String(CLAIM_BY_MS), refund_after_ms: String(REFUND_AFTER_MS) };
  return functionCall("ft_transfer_call", { receiver_id: CONTRACT, amount: "1000000", msg: JSON.stringify(msg) }, "1");
}
function refundCall(): Record<string, unknown> {
  return functionCall("refund", { hash_lock: HASH_LOCK.slice(2) }, "0");
}

/** A final outcome for one of this rail's own transactions, in the shape EXPERIMENTAL_tx_status answers with. */
function outcome(kind: "lock" | "refund", txHash: string, status?: unknown): Record<string, unknown> {
  return {
    status: status ?? { SuccessValue: kind === "lock" ? Buffer.from(JSON.stringify("1000000")).toString("base64") : "" },
    transaction: {
      signer_id: BUYER_ACCOUNT,
      public_key: buyerSigner.publicKey,
      receiver_id: kind === "lock" ? USDC : CONTRACT,
      nonce: 5,
      hash: txHash,
      actions: [kind === "lock" ? lockCall() : refundCall()],
    },
    transaction_outcome: { id: txHash, block_hash: "known-block-hash" },
  };
}

function reply(node: Node, method: string, params: Record<string, unknown>): { result?: unknown; error?: Record<string, unknown> } {
  node.before?.(method);
  switch (method) {
    case "status": {
      const id = node.chainIds.length > 1 ? (node.chainIds.shift() as string) : (node.chainIds[0] as string);
      return { result: { chain_id: id, protocol_version: 86, sync_info: {} } };
    }
    case "block":
      return { result: { header: { height: 10, hash: BLOCK_HASH, timestamp_nanosec: "1800000000000000000" } } }; // chain time past refundAfterMs
    case "query": {
      switch (params.request_type) {
        case "view_account":
          return { result: { amount: "1000000000000000000000000", code_hash: HTLC_CODE_HASH, block_height: 1, block_hash: "bh" } };
        case "view_access_key_list":
          return { result: { keys: [], block_height: 1, block_hash: "bh" } };
        case "view_access_key":
          return { result: { nonce: node.keyNonce, permission: "FullAccess", block_height: 1, block_hash: "bh" } };
        case "call_function":
          return { result: { result: Array.from(new TextEncoder().encode(JSON.stringify(node.lock))), logs: [], block_height: 1, block_hash: "bh" } };
        default:
          return { error: { code: -32601, message: `unexpected query ${String(params.request_type)}` } };
      }
    }
    case "send_tx":
      if (node.onSend === undefined) return { error: { code: -32601, message: "this test does not send" } };
      return { result: node.onSend(String(params.signed_tx_base64)) };
    case "EXPERIMENTAL_tx_status": {
      if (node.tx === "unknown") return { error: { code: -32000, message: "Server error", name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };
      if (node.tx === "timeout") return { error: { code: -32000, message: "Server error", name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: {} } } };
      if (node.tx === "transport-error") return { error: { code: -32603, message: "internal error" } };
      return { result: node.tx(String(params.tx_hash)) };
    }
    default:
      return { error: { code: -32601, message: `unexpected method ${method}` } };
  }
}

async function connect(node: Node): Promise<ConnectedCounterAssetRail> {
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: Record<string, unknown> };
    node.calls.push({ method: body.method, params: body.params });
    const answer = reply(node, body.method, Array.isArray(body.params) ? {} : body.params);
    const text = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer });
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  const rpc = new CapturingRpc({ endpoint: CONFIG.endpoint, fetch: fetchImpl, clock: () => 5000 });
  const rail = createNearCounterRail({ config: CONFIG, rpc, signer: buyerSigner, clock: () => 5000 });
  return rail.connect(lockTerms(), ACCOUNTS);
}

const methods = (node: Node): string[] => node.calls.map((c) => c.method);
const afterConnect = (node: Node, from: number): Call[] => node.calls.slice(from);
const requestType = (call: Call): unknown => (call.params as Record<string, unknown>).request_type;

async function prepared(node: Node): Promise<{ rail: ConnectedCounterAssetRail; prepared: PreparedLock; txHash: string; signedTxBase64: string }> {
  const rail = await connect(node);
  const result = await rail.prepareLock(lockTerms(), 0);
  const recovery = result.recovery;
  if (recovery?.chain !== "near") throw new Error("test: expected a near recovery handle");
  return { rail, prepared: result, txHash: recovery.txHash, signedTxBase64: recovery.signedTxBase64 };
}

// -- prepareLock hands out the handle ----------------------------------------------------------------------------------

describe("NEAR prepareLock: the recovery handle", () => {
  it("returns the transaction hash and the complete signed bytes next to the ref, and sends nothing", async () => {
    const node = newNode({ keyNonce: 4 });
    const { prepared: p, txHash, signedTxBase64 } = await prepared(node);
    expect(p.ref).toBe(REF);
    expect(base58.decode(txHash)).toHaveLength(32);
    // the bytes decode to this rail's own account, key and the next nonce, and hash to the recorded hash
    const header = decodeSignedTransactionHeader(Uint8Array.from(Buffer.from(signedTxBase64, "base64")));
    expect(header.signerId).toBe(BUYER_ACCOUNT);
    expect(`ed25519:${base58.encode(header.publicKey.data)}`).toBe(buyerSigner.publicKey);
    expect(header.nonce).toBe(5n);
    expect(header.txHashBase58).toBe(txHash);
    expect(methods(node)).not.toContain("send_tx");
    expect(JSON.parse(JSON.stringify(p))).toEqual(p); // plain JSON data
  });

  it("commitLock sends exactly the bytes that were handed out", async () => {
    const sent: string[] = [];
    const node = newNode({
      onSend: (signed) => {
        sent.push(signed);
        node.lock = lockRow();
        return outcome("lock", base58.encode(sha256(Buffer.from(signed, "base64").subarray(0, -65))));
      },
    });
    const { rail, signedTxBase64, txHash } = await prepared(node);
    const evidence = await rail.commitLock();
    expect(sent).toEqual([signedTxBase64]);
    expect(evidence.txHash).toBe(txHash);
  });
});

// -- recoverLock -------------------------------------------------------------------------------------------------------

describe("NEAR recoverLock", () => {
  it("a transaction the node holds, with its lock on chain, is landed; the nonce is read BEFORE the transaction and the lock", async () => {
    const node = newNode({ lock: lockRow() });
    const { rail, prepared: p, txHash } = await prepared(node);
    node.tx = (hash) => outcome("lock", hash);
    const from = node.calls.length;
    await expect(rail.recoverLock(p)).resolves.toBe("landed");
    expect(txHash).toBe(txHash);
    const seen = afterConnect(node, from);
    const nonceAt = seen.findIndex((c) => c.method === "query" && requestType(c) === "view_access_key");
    const txAt = seen.findIndex((c) => c.method === "EXPERIMENTAL_tx_status");
    expect(nonceAt).toBeGreaterThanOrEqual(0);
    expect(txAt).toBeGreaterThan(nonceAt);
    expect(seen.find((c) => c.method === "EXPERIMENTAL_tx_status")?.params).toEqual({ tx_hash: txHash, sender_account_id: BUYER_ACCOUNT, wait_until: "FINAL" });
    expect(methods(node)).not.toContain("send_tx"); // nothing is ever sent by a recovery
  });

  it("a node that has forgotten the transaction but shows the lock (payer-keyed ref) is still landed, whatever the nonce says", async () => {
    const node = newNode({ lock: lockRow({ status: "Claimed", preimage: PREIMAGE_HEX }), keyNonce: 99 });
    const { rail, prepared: p } = await prepared(node);
    node.tx = "unknown";
    await expect(rail.recoverLock(p)).resolves.toBe("landed");
  });

  it("unknown to the node, no lock, and the access key's nonce moved past the transaction's: never-landed (it can no longer be accepted)", async () => {
    const node = newNode({ keyNonce: 4 });
    const { rail, prepared: p } = await prepared(node); // the signed transaction has nonce 5
    node.tx = "unknown";
    node.keyNonce = 5; // another transaction of this key took nonce 5
    await expect(rail.recoverLock(p)).resolves.toBe("never-landed");
    node.keyNonce = 40;
    await expect(rail.recoverLock(p)).resolves.toBe("never-landed");
    expect(methods(node)).not.toContain("send_tx");
  });

  it("unknown to the node, no lock, nonce still below the transaction's: pending (it may be in flight or never sent), and nothing new is signed", async () => {
    const node = newNode({ keyNonce: 4 });
    const { rail, prepared: p } = await prepared(node);
    node.tx = "unknown";
    const blockReadsBefore = node.calls.filter((c) => c.method === "block").length; // building a transaction reads a block
    await expect(rail.recoverLock(p)).resolves.toBe("pending");
    await expect(rail.recoverLock(p)).resolves.toBe("pending");
    expect(methods(node)).not.toContain("send_tx");
    expect(node.calls.filter((c) => c.method === "block").length).toBe(blockReadsBefore); // so a recovery signed nothing
  });

  it("a node still waiting for finality (TIMEOUT_ERROR) is pending, even if the nonce already moved: the transaction may still land", async () => {
    const node = newNode({ keyNonce: 4 });
    const { rail, prepared: p } = await prepared(node);
    node.tx = "timeout";
    node.keyNonce = 50;
    await expect(rail.recoverLock(p)).resolves.toBe("pending");
  });

  it("a landing BETWEEN the nonce read and the transaction read is landed, not never-landed (the nonce is read first)", async () => {
    const node = newNode({ keyNonce: 4 });
    const { rail, prepared: p } = await prepared(node);
    node.tx = "unknown";
    // the first read (the nonce) sees 4 ... then the transaction lands and the key's nonce moves
    node.before = (method) => {
      if (method === "EXPERIMENTAL_tx_status") {
        node.keyNonce = 5;
        node.lock = lockRow();
        node.tx = (hash) => outcome("lock", hash);
      }
    };
    await expect(rail.recoverLock(p)).resolves.toBe("landed");
  });

  it("a lock transaction that executed and FAILED propagates its typed error (never folded into never-landed)", async () => {
    const node = newNode({ lock: null });
    const { rail, prepared: p } = await prepared(node);
    node.tx = (hash) => outcome("lock", hash, { Failure: { ActionError: { kind: "FunctionCallError" } } });
    await expect(rail.recoverLock(p)).rejects.toBeInstanceOf(NearTxFailedError);
  });

  it("a lock the receiver refused (used amount 0) propagates NearLockRefusedError", async () => {
    const node = newNode({ lock: lockRow() });
    const { rail, prepared: p } = await prepared(node);
    node.tx = (hash) => outcome("lock", hash, { SuccessValue: Buffer.from(JSON.stringify("0")).toString("base64") });
    await expect(rail.recoverLock(p)).rejects.toBeInstanceOf(NearLockRefusedError);
  });

  it("a transport failure while asking by hash is an error, not 'unknown'", async () => {
    const node = newNode({ keyNonce: 4 });
    const { rail, prepared: p } = await prepared(node);
    node.tx = "transport-error";
    node.keyNonce = 50;
    await expect(rail.recoverLock(p)).rejects.toThrow(/internal error/);
  });

  it("an unusable nonce view stops the recovery with an error (no verdict from the other reads alone)", async () => {
    const node = newNode({ keyNonce: 4 });
    const { rail, prepared: p } = await prepared(node);
    node.keyNonce = Number.NaN; // serialised as null: not a usable access key view
    await expect(rail.recoverLock(p)).rejects.toThrow(/usable access key view/);
  });
});

describe("NEAR recovery handle checks", () => {
  it("refuses a missing handle, another rail's handle, a bad ref, and a handle that is not this account's own transaction, before any call", async () => {
    const node = newNode();
    const { rail, prepared: p, txHash, signedTxBase64 } = await prepared(node);

    // a transaction signed by the SELLER's key, built with the same real encoder
    const built = await buildSignedTransaction(
      { signerId: SELLER_ACCOUNT, publicKey: { keyType: "ED25519", data: base58.decode(sellerSigner.publicKey.slice("ed25519:".length)) }, nonce: 5n, receiverId: USDC, blockHash: base58.decode(BLOCK_HASH), actions: [{ type: "Transfer", deposit: 1n }] },
      (hash) => sellerSigner.sign(hash) as Uint8Array,
    );
    const sellers: LockRecovery = { chain: "near", txHash: built.txHashBase58, signedTxBase64: Buffer.from(built.signedBytes).toString("base64") };

    const cases: Array<[string, PreparedLock, string]> = [
      ["no handle", { ref: p.ref }, "no-handle"],
      ["another rail's handle", { ref: p.ref, recovery: { chain: "btc", txid: "aa".repeat(32), rawTx: "00" } }, "handle-mismatch"],
      ["a ref that is not a near ref", { ref: HASH_LOCK, recovery: p.recovery as LockRecovery }, "handle-mismatch"],
      ["a ref for another payer", { ref: `${HASH_LOCK}:${SELLER_ACCOUNT}`, recovery: p.recovery as LockRecovery }, "handle-mismatch"],
      ["a ref for another hash lock", { ref: `0x${"99".repeat(32)}:${BUYER_ACCOUNT}`, recovery: p.recovery as LockRecovery }, "handle-mismatch"],
      ["a hash that is not the bytes' hash", { ref: p.ref, recovery: { chain: "near", txHash: base58.encode(new Uint8Array(32).fill(7)), signedTxBase64 } }, "handle-mismatch"],
      ["bytes that do not decode", { ref: p.ref, recovery: { chain: "near", txHash, signedTxBase64: "AAAA" } }, "handle-mismatch"],
      ["a transaction signed by another account and key", { ref: p.ref, recovery: sellers }, "handle-mismatch"],
    ];
    const from = node.calls.length;
    for (const [label, prep, code] of cases) {
      const error = await rail.recoverLock(prep).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(RailRecoveryRefusedError);
      expect((error as RailRecoveryRefusedError).code, label).toBe(code);
    }
    expect(node.calls.length).toBe(from); // not one RPC call for any of them
  });
});

// -- decodeSignedTransactionHeader -------------------------------------------------------------------------------------

describe("decodeSignedTransactionHeader", () => {
  async function build(nonce: bigint, signer = buyerSigner) {
    return buildSignedTransaction(
      { signerId: signer.accountId, publicKey: { keyType: "ED25519", data: base58.decode(signer.publicKey.slice("ed25519:".length)) }, nonce, receiverId: USDC, blockHash: base58.decode(BLOCK_HASH), actions: [{ type: "Transfer", deposit: 1n }] },
      (hash) => signer.sign(hash) as Uint8Array,
    );
  }

  it("reads back the signer, key, nonce and the transaction hash `buildSignedTransaction` recorded", async () => {
    for (const nonce of [1n, 5n, 4_294_967_296n, 2n ** 63n]) {
      const built = await build(nonce);
      const header = decodeSignedTransactionHeader(built.signedBytes);
      expect(header.signerId).toBe(BUYER_ACCOUNT);
      expect(header.nonce).toBe(nonce);
      expect(header.txHashBase58).toBe(built.txHashBase58);
      expect(bytesToHex(header.publicKey.data)).toBe(bytesToHex(base58.decode(buyerSigner.publicKey.slice("ed25519:".length))));
    }
  });

  it("works on a view into a larger buffer (a Buffer slice has a non-zero byteOffset)", async () => {
    const built = await build(9n);
    const padded = new Uint8Array(built.signedBytes.length + 10);
    padded.set(built.signedBytes, 7);
    expect(decodeSignedTransactionHeader(padded.subarray(7, 7 + built.signedBytes.length)).nonce).toBe(9n);
  });

  it("refuses anything that does not fit the layout", async () => {
    const built = await build(5n);
    expect(() => decodeSignedTransactionHeader(new Uint8Array(10))).toThrow(/too short/);
    expect(() => decodeSignedTransactionHeader(built.signedBytes.subarray(0, 40))).toThrow();
    const badLength = Uint8Array.from(built.signedBytes);
    new DataView(badLength.buffer).setUint32(0, 1000, true);
    expect(() => decodeSignedTransactionHeader(badLength)).toThrow(/implausible signer id length/);
    const badKeyType = Uint8Array.from(built.signedBytes);
    badKeyType[4 + BUYER_ACCOUNT.length] = 1;
    expect(() => decodeSignedTransactionHeader(badKeyType)).toThrow(/not ed25519/);
    const badSignatureTag = Uint8Array.from(built.signedBytes);
    badSignatureTag[badSignatureTag.length - 65] = 1;
    expect(() => decodeSignedTransactionHeader(badSignatureTag)).toThrow(/signature is not ed25519/);
    const notUtf8 = Uint8Array.from(built.signedBytes);
    notUtf8[4] = 0xff;
    expect(() => decodeSignedTransactionHeader(notUtf8)).toThrow();
    // keep encodeSignedTransaction referenced: the layout under test is the one it writes
    expect(encodeSignedTransaction(built.signed)).toEqual(built.signedBytes);
  });
});

// -- refund: record before send ----------------------------------------------------------------------------------------

describe("NEAR refund: onSigned / onNotBroadcast", () => {
  /** The world for a refund: the lock is Locked, chain time is past refundAfterMs, a sent refund flips it to Refunded. */
  function refundWorld(overrides: Partial<Node> = {}): Node {
    const node = newNode({
      lock: lockRow(),
      onSend: (signed) => {
        node.lock = lockRow({ status: "Refunded" });
        return outcome("refund", base58.encode(sha256(Buffer.from(signed, "base64").subarray(0, -65))));
      },
      ...overrides,
    });
    return node;
  }

  it("hands the refund's hash and exact bytes to onSigned BEFORE send_tx, and sends those same bytes", async () => {
    const node = refundWorld();
    const rail = await connect(node);
    const events: Array<{ recovery: LockRecovery; sendsSoFar: number }> = [];
    const evidence = await rail.refund(REF, {
      onSigned: (recovery) => {
        events.push({ recovery, sendsSoFar: methods(node).filter((m) => m === "send_tx").length });
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.sendsSoFar).toBe(0);
    const recovery = events[0]?.recovery;
    if (recovery?.chain !== "near") throw new Error("expected a near handle");
    const sent = node.calls.filter((c) => c.method === "send_tx");
    expect(sent).toHaveLength(1);
    expect((sent[0]?.params as Record<string, unknown>).signed_tx_base64).toBe(recovery.signedTxBase64);
    expect(evidence.txHash).toBe(recovery.txHash);
    expect(decodeSignedTransactionHeader(Uint8Array.from(Buffer.from(recovery.signedTxBase64, "base64"))).txHashBase58).toBe(recovery.txHash);
  });

  it("an onSigned that fails (the store write failed) stops the refund before anything is sent", async () => {
    const node = refundWorld();
    const rail = await connect(node);
    await expect(
      rail.refund(REF, {
        onSigned: () => {
          throw new Error("store write failed");
        },
      }),
    ).rejects.toThrow(/store write failed/);
    expect(methods(node)).not.toContain("send_tx");
  });

  it("onNotBroadcast fires when the chain pin check before the send fails (nothing was sent), with the same handle onSigned got", async () => {
    // status #1 is connect's own, #2 is refund's first pin check, #3 is sendPrepared's: that one answers another chain
    const node = refundWorld({ chainIds: ["near-sandbox-flop", "near-sandbox-flop", "testnet"] });
    const rail = await connect(node);
    const signed: LockRecovery[] = [];
    const dropped: LockRecovery[] = [];
    await expect(rail.refund(REF, { onSigned: (r) => void signed.push(r), onNotBroadcast: (r) => void dropped.push(r) })).rejects.toThrow(/does not match pin/);
    expect(signed).toHaveLength(1);
    expect(dropped).toEqual(signed);
    expect(methods(node)).not.toContain("send_tx");
  });

  it("with no options the refund behaves exactly as before", async () => {
    const node = refundWorld();
    const rail = await connect(node);
    await expect(rail.refund(REF)).resolves.toMatchObject({ ref: REF });
  });
});

// -- recoverRefund -----------------------------------------------------------------------------------------------------

describe("NEAR recoverRefund", () => {
  /** A refund handle from a real signed refund, with the world rolled back to 'before it was sent'. */
  async function signedRefund(): Promise<{ node: Node; rail: ConnectedCounterAssetRail; recovery: LockRecovery; txHash: string }> {
    const node = newNode({
      lock: lockRow(),
      onSend: (signed) => {
        node.lock = lockRow({ status: "Refunded" });
        return outcome("refund", base58.encode(sha256(Buffer.from(signed, "base64").subarray(0, -65))));
      },
    });
    const rail = await connect(node);
    let recovery: LockRecovery | undefined;
    await rail.refund(REF, { onSigned: (r) => void (recovery = r) });
    if (recovery?.chain !== "near") throw new Error("expected a near handle");
    node.lock = lockRow(); // the crash: the process never learned that the refund was sent
    return { node, rail, recovery, txHash: recovery.txHash };
  }

  it("a refund the node holds, with the lock Refunded, is landed", async () => {
    const { node, rail, recovery } = await signedRefund();
    node.lock = lockRow({ status: "Refunded" });
    node.tx = (hash) => outcome("refund", hash);
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("landed");
  });

  it("forgotten by the node but the lock reads Refunded: landed", async () => {
    const { node, rail, recovery } = await signedRefund();
    node.tx = "unknown";
    node.lock = lockRow({ status: "Refunded" });
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("landed");
  });

  it("unknown, the lock still Locked: pending while the nonce is below the refund's, never-landed once it has moved past", async () => {
    const { node, rail, recovery } = await signedRefund();
    node.tx = "unknown";
    const header = decodeSignedTransactionHeader(Uint8Array.from(Buffer.from((recovery as { signedTxBase64: string }).signedTxBase64, "base64")));
    node.keyNonce = Number(header.nonce) - 1;
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("pending");
    node.keyNonce = Number(header.nonce);
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("never-landed");
  });

  it("a lock that is merely Locked is NOT 'landed' for a refund (only a lock recovery treats any row as landed)", async () => {
    const { node, rail, recovery } = await signedRefund();
    node.tx = "unknown";
    node.keyNonce = 0;
    node.lock = lockRow({ status: "Locked" });
    await expect(rail.recoverRefund?.(REF, recovery)).resolves.toBe("pending");
  });

  it("a recovered refund that did not refund propagates its typed failure; a wrong handle is refused before any call", async () => {
    const { node, rail, recovery } = await signedRefund();
    node.tx = (hash) => outcome("refund", hash, { Failure: { ActionError: { kind: "FunctionCallError" } } });
    await expect(rail.recoverRefund?.(REF, recovery)).rejects.toBeInstanceOf(NearTxFailedError);
    const from = node.calls.length;
    await expect(rail.recoverRefund?.(REF, { chain: "sol", signature: "s", blockhash: "b", lastValidBlockHeight: 1 })).rejects.toBeInstanceOf(RailRecoveryRefusedError);
    expect(node.calls.length).toBe(from);
  });
});
