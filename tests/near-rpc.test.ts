// SPDX-License-Identifier: MIT
//
// tests/near-rpc.test.ts — `NearRpc` exercised against a mocked `fetch`, exactly like
// `tests/rpc-capture.test.ts` exercises the shared `CapturingRpc` itself: no network, no
// process. Each test pins one method's own request shape (method name + params) and response
// decoding, plus the two distinct error paths (`RpcCaptureError` → a typed `NearRpcError`
// subclass; a successful `query` response carrying `result.error` → `NearFunctionCallPanicError`).

import { describe, expect, it } from "vitest";

import { CapturingRpc } from "../src/rails/rpc-capture.js";
import {
  NearExpiredTransactionError,
  NearFunctionCallPanicError,
  NearInvalidNonceError,
  NearRpc,
  NearRpcError,
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

  it("txStatus uses EXPERIMENTAL_tx_status with array params [hash, sender]", async () => {
    const { near, requests } = rpcNear([
      ok(1, { status: {}, transaction_outcome: { id: "txid1", block_hash: "blockhash1" } }),
    ]);
    await near.txStatus("txid1", "buyer.near-sandbox-flop");
    expect(requests[0]).toEqual({ method: "EXPERIMENTAL_tx_status", params: ["txid1", "buyer.near-sandbox-flop"] });
  });
});

describe("NEAR error mapping", () => {
  function errBody(id: number, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }

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

  it("falls back to the base NearRpcError for an unrecognised message, preserving code", async () => {
    const { near } = rpcNear([errBody(1, -32603, "Internal error")]);
    const error: unknown = await near.status().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: -32603 });
    expect(error).not.toBeInstanceOf(NearUnknownTransactionError);
    expect(error).toBeInstanceOf(NearRpcError);
  });

  it("rethrows a non-RpcCaptureError (e.g. a JSON parse failure) unchanged", async () => {
    const { fetch: fetchImpl } = fakeFetch(["not json"]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    const near = new NearRpc(rpc);
    await expect(near.status()).rejects.not.toBeInstanceOf(NearRpcError);
  });
});
