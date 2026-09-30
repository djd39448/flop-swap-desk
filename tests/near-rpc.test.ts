// SPDX-License-Identifier: MIT
//
// tests/near-rpc.test.ts — `NearRpc` exercised against a mocked `fetch`, exactly like
// `tests/rpc-capture.test.ts` exercises the shared `CapturingRpc` itself: no network, no
// process. Each test pins one method's own request shape (method name + params) and response
// decoding, plus the two distinct error paths (`RpcCaptureError` → a typed `NearRpcError`
// subclass; a successful `query` response carrying `result.error` → `NearFunctionCallPanicError`).

import { describe, expect, it, vi } from "vitest";

import { CapturingRpc } from "../src/rails/rpc-capture.js";
import {
  NearExpiredTransactionError,
  NearFunctionCallPanicError,
  NearInvalidNonceError,
  NearRpc,
  NearRpcError,
  NearTimeoutError,
  NearUnknownTransactionError,
} from "../src/rails/near-rpc.js";

/** Mirrors `tests/rpc-capture.test.ts`'s own `fakeFetch` — a `fetch`-shaped stub answering each
 *  call with the next canned body, in order, and recording every request it saw. */
function fakeFetch(bodies: string[]): { fetch: typeof fetch; requests: Array<{ method: string; params: unknown }> } {
  const requests: Array<{ method: string; params: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    requests.push({ method: parsed.method, params: parsed.params });
    const body = bodies[i];
    i += 1;
    if (body === undefined) throw new Error("fakeFetch: ran out of canned responses");
    const bytes = new TextEncoder().encode(body);
    return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function ok(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcNear(bodies: string[]) {
  const { fetch: fetchImpl, requests } = fakeFetch(bodies);
  const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: fetchImpl, clock: () => 1000 });
  return { near: new NearRpc(rpc), rpc, requests };
}

describe("NearRpc.status", () => {
  it("calls status with no params and decodes chainId/protocolVersion", async () => {
    const { near, requests } = rpcNear([ok(1, { chain_id: "near-sandbox-flop", protocol_version: 86, sync_info: {} })]);
    const status = await near.status();
    expect(requests[0]).toEqual({ method: "status", params: [] });
    expect(status.chainId).toBe("near-sandbox-flop");
    expect(status.protocolVersion).toBe(86);
  });

  it("throws when chain_id/protocol_version are missing", async () => {
    const { near } = rpcNear([ok(1, { sync_info: {} })]);
    await expect(near.status()).rejects.toThrow(/chain_id/);
  });
});

describe("NearRpc.block", () => {
  it("sends finality params and decodes the header", async () => {
    const { near, requests } = rpcNear([
      ok(1, { header: { height: 42, hash: "abc123", timestamp_nanosec: "1700000000000000000" }, chunks: [] }),
    ]);
    const block = await near.block({ finality: "final" });
    expect(requests[0]).toEqual({ method: "block", params: { finality: "final" } });
    expect(block.header).toEqual({ height: 42, hash: "abc123", timestampNs: "1700000000000000000" });
  });

  it("sends block_id params when given a block id instead of finality", async () => {
    const { near, requests } = rpcNear([ok(1, { header: { height: 1, hash: "h", timestamp_nanosec: "1" } })]);
    await near.block({ blockId: "abc123" });
    expect(requests[0]).toEqual({ method: "block", params: { block_id: "abc123" } });
  });
});

describe("NearRpc.viewAccount / viewAccessKey", () => {
  it("view_account: request shape and decoding", async () => {
    const { near, requests } = rpcNear([
      ok(1, { amount: "1000", code_hash: "11111111111111111111111111111111", block_height: 5, block_hash: "bh" }),
    ]);
    const view = await near.viewAccount("buyer.near-sandbox-flop");
    expect(requests[0]).toEqual({
      method: "query",
      params: { request_type: "view_account", account_id: "buyer.near-sandbox-flop", finality: "final" },
    });
    expect(view.amount).toBe("1000");
    expect(view.blockHeight).toBe(5);
  });

  it("view_access_key: request shape and decoding", async () => {
    const { near, requests } = rpcNear([
      ok(1, { nonce: 7, permission: "FullAccess", block_height: 5, block_hash: "bh" }),
    ]);
    const view = await near.viewAccessKey("buyer.near-sandbox-flop", "ed25519:abc");
    expect(requests[0]).toEqual({
      method: "query",
      params: { request_type: "view_access_key", account_id: "buyer.near-sandbox-flop", public_key: "ed25519:abc", finality: "final" },
    });
    expect(view.nonce).toBe(7);
    expect(view.permission).toBe("FullAccess");
  });

  // H6
  it("view_access_key_list: request shape and decoding", async () => {
    const { near, requests } = rpcNear([
      ok(1, {
        keys: [{ public_key: "ed25519:abc", access_key: { nonce: 3, permission: "FullAccess" } }],
        block_height: 5,
        block_hash: "bh",
      }),
    ]);
    const view = await near.viewAccessKeyList("htlc.near-sandbox-flop", { blockId: 5 });
    expect(requests[0]).toEqual({
      method: "query",
      params: { request_type: "view_access_key_list", account_id: "htlc.near-sandbox-flop", block_id: 5 },
    });
    expect(view.keys).toEqual([{ publicKey: "ed25519:abc", nonce: 3, permission: "FullAccess" }]);
    expect(view.blockHeight).toBe(5);
  });

  it("view_access_key_list: an empty key list decodes to zero keys", async () => {
    const { near } = rpcNear([ok(1, { keys: [], block_height: 5, block_hash: "bh" })]);
    const view = await near.viewAccessKeyList("htlc.near-sandbox-flop");
    expect(view.keys).toHaveLength(0);
  });

  it("view_access_key_list: throws on a malformed key entry", async () => {
    const { near } = rpcNear([ok(1, { keys: [{ public_key: "ed25519:abc" }], block_height: 5, block_hash: "bh" })]);
    await expect(near.viewAccessKeyList("htlc.near-sandbox-flop")).rejects.toThrow(/malformed key entry/);
  });
});

describe("NearRpc.callFunction", () => {
  it("base64-encodes JSON args, decodes the byte-array result as UTF-8 text", async () => {
    const payload = { status: "Locked" };
    const resultBytes = Array.from(new TextEncoder().encode(JSON.stringify(payload)));
    const { near, requests } = rpcNear([ok(1, { result: resultBytes, logs: ["a log line"], block_height: 9, block_hash: "bh9" })]);

    const result = await near.callFunction("htlc.near-sandbox-flop", "get_lock", { hash_lock: "aa" });

    const sentParams = requests[0]?.params as Record<string, unknown>;
    expect(sentParams.request_type).toBe("call_function");
    expect(sentParams.method_name).toBe("get_lock");
    const decodedArgs = JSON.parse(Buffer.from(String(sentParams.args_base64), "base64").toString("utf-8"));
    expect(decodedArgs).toEqual({ hash_lock: "aa" });

    expect(JSON.parse(result.resultText)).toEqual(payload);
    expect(result.logs).toEqual(["a log line"]);
    expect(result.blockHeight).toBe(9);
  });

  it("throws NearFunctionCallPanicError when the (successful, 200) response carries result.error", async () => {
    const { near } = rpcNear([ok(1, { error: "panicked: assertion failed", logs: [], block_height: 1, block_hash: "bh" })]);
    const error: unknown = await near.callFunction("htlc.near-sandbox-flop", "get_lock", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NearFunctionCallPanicError);
    expect((error as Error).message).toMatch(/panicked/);
  });
});

describe("NearRpc.sendTx / txStatus — outcome decoding", () => {
  it("sendTx sends signed_tx_base64 + wait_until and decodes transaction_outcome", async () => {
    const { near, requests } = rpcNear([
      ok(1, { status: { SuccessValue: "" }, transaction_outcome: { id: "txid1", block_hash: "blockhash1" } }),
    ]);
    const outcome = await near.sendTx("BASE64==", "FINAL");
    expect(requests[0]).toEqual({ method: "send_tx", params: { signed_tx_base64: "BASE64==", wait_until: "FINAL" } });
    expect(outcome.transactionOutcome).toEqual({ id: "txid1", blockHash: "blockhash1" });
  });

  it("txStatus uses EXPERIMENTAL_tx_status with object params and wait_until FINAL by default (H10)", async () => {
    const { near, requests } = rpcNear([
      ok(1, { status: {}, transaction_outcome: { id: "txid1", block_hash: "blockhash1" } }),
    ]);
    await near.txStatus("txid1", "buyer.near-sandbox-flop");
    expect(requests[0]).toEqual({
      method: "EXPERIMENTAL_tx_status",
      params: { tx_hash: "txid1", sender_account_id: "buyer.near-sandbox-flop", wait_until: "FINAL" },
    });
  });

  it("txStatus carries the transaction body the node reports, and undefined when absent (H10)", async () => {
    const withTx = rpcNear([ok(1, { status: {}, transaction: { signer_id: "buyer.near-sandbox-flop" }, transaction_outcome: { id: "t", block_hash: "b" } })]);
    expect((await withTx.near.txStatus("t", "buyer.near-sandbox-flop")).transaction).toEqual({ signer_id: "buyer.near-sandbox-flop" });
    const without = rpcNear([ok(1, { status: {}, transaction_outcome: { id: "t", block_hash: "b" } })]);
    expect((await without.near.txStatus("t", "buyer.near-sandbox-flop")).transaction).toBeUndefined();
  });
});

// H13: reads made through `withReadTimeout` give up; `send_tx` and `txStatus` (which wait for
// finality) are never bounded by it.
describe("NearRpc.withReadTimeout (H13)", () => {
  function hangingNear(): { near: NearRpc } {
    const fetchImpl = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: fetchImpl, clock: () => 1000 });
    return { near: new NearRpc(rpc) };
  }

  it("a read that never answers is abandoned with a plain Error after the bound", async () => {
    vi.useFakeTimers();
    try {
      const { near } = hangingNear();
      const bounded = near.withReadTimeout(5_000);
      const outcome = bounded.block({ finality: "final" }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_001);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NearRpcError);
      expect((error as Error).message).toMatch(/block read did not answer within 5000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("send_tx and txStatus are NOT bounded (they wait for finality)", async () => {
    vi.useFakeTimers();
    try {
      const { near } = hangingNear();
      const bounded = near.withReadTimeout(5_000);
      let settled = false;
      const send = bounded.sendTx("x").then(() => (settled = true), () => (settled = true));
      const status = bounded.txStatus("h", "a").then(() => (settled = true), () => (settled = true));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);
      void send;
      void status;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unbounded client (the default) never times a read out by itself", async () => {
    vi.useFakeTimers();
    try {
      const { near } = hangingNear();
      let settled = false;
      const read = near.block({ finality: "final" }).then(() => (settled = true), () => (settled = true));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);
      void read;
    } finally {
      vi.useRealTimers();
    }
  });
});

// H4: NEAR's own documented JSON-RPC 2.0 error shape (docs.near.org "RPC Endpoints" / errors
// reference, and confirmed structurally by `handoff/research/near-rpc-and-signing-2026-09-29.md`'s
// own named error kinds: UNKNOWN_TRANSACTION, TIMEOUT_ERROR, INVALID_TRANSACTION,
// EXPIRED_TRANSACTION) — the top-level `error` object itself carries `name`/`cause`/`code`/
// `data`/`message` as SIBLINGS, e.g.:
//   { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN_TRANSACTION", "info": {...} },
//     "code": -32000, "data": "Transaction ... doesn't exist", "message": "Server error" }
// H11: the INVALID_TRANSACTION bodies below (nonce, expired) are REAL replies captured from a
// near-sandbox run, not built from documentation; `tests-near/near-rpc-errors.near.test.ts`
// forces the same two errors against a live node. UNKNOWN_TRANSACTION and the plain
// code/message fallback are exercised live by `tests-near/near-htlc.near.test.ts`'s own
// recoverByTxHash sandbox test.
describe("NEAR error mapping", () => {
  function errBody(id: number, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function structuredErrBody(id: number, outerName: string, cause: unknown, code: number, data: unknown, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { name: outerName, cause, code, data, message } });
  }

  describe("structured cause (H4: NEAR's own documented error shape)", () => {
    it("maps cause.name UNKNOWN_TRANSACTION to NearUnknownTransactionError", async () => {
      const { near } = rpcNear([
        structuredErrBody(1, "HANDLER_ERROR", { name: "UNKNOWN_TRANSACTION", info: { requested_transaction_hash: "x" } }, -32000, "Transaction x doesn't exist", "Server error"),
      ]);
      await expect(near.txStatus("x", "y")).rejects.toBeInstanceOf(NearUnknownTransactionError);
    });

    it("maps cause.name TIMEOUT_ERROR to NearTimeoutError, never to NearUnknownTransactionError (H4: never absent)", async () => {
      const { near } = rpcNear([structuredErrBody(1, "HANDLER_ERROR", { name: "TIMEOUT_ERROR" }, -32000, "Timeout", "Server error")]);
      const error: unknown = await near.txStatus("x", "y").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NearTimeoutError);
      expect(error).not.toBeInstanceOf(NearUnknownTransactionError);
    });

    // H11: these two bodies are the node's REAL replies, captured from a near-sandbox run
    // (near-sandbox 2.x, chain near-sandbox-flop, 2026-09-30, tests-near probe): a `send_tx` whose
    // nonce is not above the access key's, and one whose block hash is older than the validity
    // window (after sandbox_fast_forward). Only the JSON-RPC "id" is rewritten to fit this mock.
    // The reason sits in error.data.TxExecutionError.InvalidTxError; cause.info is EMPTY.
    const REAL_INVALID_NONCE =
      '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{"ak_nonce":20000001,"tx_nonce":20000001}}}}},"id":1}';
    const REAL_EXPIRED =
      '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{},"name":"INVALID_TRANSACTION"},"code":-32000,"message":"Server error","data":{"TxExecutionError":{"InvalidTxError":"Expired"}}},"id":1}';

    it("maps the node's real InvalidNonce reply (data.TxExecutionError.InvalidTxError.InvalidNonce) to NearInvalidNonceError (H11)", async () => {
      const { near } = rpcNear([REAL_INVALID_NONCE]);
      await expect(near.sendTx("x")).rejects.toBeInstanceOf(NearInvalidNonceError);
    });

    it("maps the node's real Expired reply (data.TxExecutionError.InvalidTxError = \"Expired\") to NearExpiredTransactionError (H11)", async () => {
      const { near } = rpcNear([REAL_EXPIRED]);
      await expect(near.sendTx("x")).rejects.toBeInstanceOf(NearExpiredTransactionError);
    });

    it("H11: the old invented shape (reason only in cause.info) is no longer recognised as a nonce/expiry error", async () => {
      const { near } = rpcNear([
        structuredErrBody(1, "HANDLER_ERROR", { name: "INVALID_TRANSACTION", info: { InvalidTxError: { InvalidNonce: { tx_nonce: 5, ak_nonce: 10 } } } }, -32000, "Invalid tx", "Server error"),
      ]);
      const error: unknown = await near.sendTx("x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NearRpcError);
      expect(error).not.toBeInstanceOf(NearInvalidNonceError);
    });

    it("an INVALID_TRANSACTION cause naming neither InvalidNonce nor Expired falls back to the base NearRpcError", async () => {
      const { near } = rpcNear([
        structuredErrBody(1, "HANDLER_ERROR", { name: "INVALID_TRANSACTION", info: {} }, -32000, { TxExecutionError: { InvalidTxError: "InvalidSignature" } }, "Server error"),
      ]);
      const error: unknown = await near.sendTx("x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NearRpcError);
      expect(error).not.toBeInstanceOf(NearInvalidNonceError);
      expect(error).not.toBeInstanceOf(NearExpiredTransactionError);
    });

    it("an unrecognised cause.name falls back to the base NearRpcError, never guessed as unknown/timeout", async () => {
      const { near } = rpcNear([structuredErrBody(1, "HANDLER_ERROR", { name: "NOT_SYNCED_YET" }, -32000, "not synced", "Server error")]);
      const error: unknown = await near.status().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NearRpcError);
      expect(error).not.toBeInstanceOf(NearUnknownTransactionError);
      expect(error).not.toBeInstanceOf(NearTimeoutError);
    });
  });

  describe("message-only fallback (no structured cause present — a caller/test that only supplies {code, message})", () => {
    it("maps an UNKNOWN_TRANSACTION message to NearUnknownTransactionError", async () => {
      const { near } = rpcNear([errBody(1, -32000, "Server error: [UNKNOWN_TRANSACTION] transaction not found")]);
      await expect(near.txStatus("x", "y")).rejects.toBeInstanceOf(NearUnknownTransactionError);
    });

    it("maps an InvalidNonce message to NearInvalidNonceError", async () => {
      const { near } = rpcNear([errBody(1, -32000, "InvalidNonce: nonce too low")]);
      await expect(near.sendTx("x")).rejects.toBeInstanceOf(NearInvalidNonceError);
    });

    it("maps an expired message to NearExpiredTransactionError", async () => {
      const { near } = rpcNear([errBody(1, -32000, "Transaction has expired")]);
      await expect(near.sendTx("x")).rejects.toBeInstanceOf(NearExpiredTransactionError);
    });

    // H4: the old heuristic (`code === -32000 && message === "Server error"` => unknown) is gone
    // — an ambiguous generic error with NO structured cause and no recognisable message text is
    // no longer guessed as "unknown" (which could wrongly make a caller treat a genuine timeout
    // as "never reached the network").
    it("does NOT guess NearUnknownTransactionError for a bare -32000/'Server error' with no structured cause", async () => {
      const { near } = rpcNear([errBody(1, -32000, "Server error")]);
      const error: unknown = await near.txStatus("x", "y").catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(NearUnknownTransactionError);
      expect(error).toBeInstanceOf(NearRpcError);
    });

    it("falls back to the base NearRpcError for an unrecognised message, preserving code", async () => {
      const { near } = rpcNear([errBody(1, -32603, "Internal error")]);
      const error: unknown = await near.status().catch((e: unknown) => e);
      expect(error).toMatchObject({ code: -32603 });
      expect(error).not.toBeInstanceOf(NearUnknownTransactionError);
      expect(error).toBeInstanceOf(NearRpcError);
    });
  });

  it("rethrows a non-RpcCaptureError (e.g. a JSON parse failure) unchanged", async () => {
    const { fetch: fetchImpl } = fakeFetch(["not json"]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    const near = new NearRpc(rpc);
    await expect(near.status()).rejects.not.toBeInstanceOf(NearRpcError);
  });
});
