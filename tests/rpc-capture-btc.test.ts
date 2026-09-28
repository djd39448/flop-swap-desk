// SPDX-License-Identifier: MIT
//
// tests/rpc-capture-btc.test.ts — P4-BTC-SPEC.md §1/§4, Stage BB1: the two `CapturingRpc`
// extensions the Bitcoin leg needs on top of the EVM-era behaviour (tests/rpc-capture.test.ts),
// exercised the same way — a mocked `fetch`, no real network or node.
//
//   1. An auth header (bitcoind's cookie-based Basic auth) that reaches the outgoing HTTP
//      request but is never recorded anywhere an `Exchange` (or anything written from one)
//      could leak it.
//   2. A per-call `path`, appended to the base endpoint, for bitcoind's per-wallet RPC dispatch
//      (`/wallet/<name>`) — every existing (EVM) caller, which never passes `path`, is
//      unaffected.

import { describe, expect, it } from "vitest";

import { CapturingRpc } from "../src/rails/rpc-capture.js";

function fakeFetch(bodies: string[]): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = bodies[i];
    i += 1;
    if (body === undefined) throw new Error("fakeFetch: ran out of canned responses");
    const bytes = new TextEncoder().encode(body);
    return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const SECRET_COOKIE = "__cookie__:超secretvalue-do-not-leak-9f8e7d6c5b4a";

describe("CapturingRpc auth header (never recorded)", () => {
  it("puts the header on the outgoing fetch request", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":true}']);
    const rpc = new CapturingRpc({
      endpoint: "http://127.0.0.1:19000",
      fetch: fetchImpl,
      headers: () => ({ Authorization: `Basic ${Buffer.from(SECRET_COOKIE).toString("base64")}` }),
    });

    await rpc.request({ method: "getblockchaininfo", params: [] });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(SECRET_COOKIE).toString("base64")}`);
    expect(headers["content-type"]).toBe("application/json"); // still set alongside the auth header
  });

  it("never appears anywhere on the recorded Exchange, live or serialized", async () => {
    const { fetch: fetchImpl } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":{"chain":"regtest"}}']);
    const rpc = new CapturingRpc({
      endpoint: "http://127.0.0.1:19000",
      fetch: fetchImpl,
      headers: () => ({ Authorization: `Basic ${Buffer.from(SECRET_COOKIE).toString("base64")}` }),
    });

    await rpc.request({ method: "getblockchaininfo", params: [] });

    const [exchange] = rpc.exchanges();
    expect(exchange).toBeDefined();
    const serialized = JSON.stringify(exchange, (_key, value) => (value instanceof Uint8Array ? Array.from(value) : value));
    expect(serialized).not.toContain(SECRET_COOKIE);
    expect(serialized).not.toContain(Buffer.from(SECRET_COOKIE).toString("base64"));
    expect(serialized).not.toContain("Authorization");
  });

  it("reads the header fresh on every call (a function, not a snapshot)", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch([
      '{"jsonrpc":"2.0","id":1,"result":"a"}',
      '{"jsonrpc":"2.0","id":2,"result":"b"}',
    ]);
    let cookie = "first-cookie";
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, headers: () => ({ Authorization: `Basic ${cookie}` }) });

    await rpc.request({ method: "m1", params: [] });
    cookie = "second-cookie"; // e.g. the node was restarted and re-cookied between calls
    await rpc.request({ method: "m2", params: [] });

    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Basic first-cookie");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe("Basic second-cookie");
  });

  it("defaults to no extra headers when none are configured (every EVM caller is unaffected)", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":"0x1"}']);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });

    await rpc.request({ method: "eth_chainId", params: [] });

    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("CapturingRpc per-call path (bitcoind wallet dispatch)", () => {
  it("appends path to the endpoint for a wallet-scoped call", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":{"complete":true,"hex":"02..."}}']);
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: fetchImpl });

    await rpc.request({ method: "walletprocesspsbt", params: ["cHNidA=="], path: "/wallet/buyer" });

    expect(calls[0]?.url).toBe("http://127.0.0.1:19000/wallet/buyer");
  });

  it("targets the bare endpoint when path is omitted, exactly like every existing (EVM) call", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":"regtest"}']);
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: fetchImpl });

    await rpc.request({ method: "getblockchaininfo", params: [] });

    expect(calls[0]?.url).toBe("http://127.0.0.1:19000");
  });

  it("treats an empty-string path the same as omitting it", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":1}']);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });

    await rpc.request({ method: "m", params: [], path: "" });

    expect(calls[0]?.url).toBe("http://x");
    expect(rpc.exchanges()[0]?.path).toBeUndefined();
  });

  it("records the path it targeted on the Exchange (not a secret, safe to keep)", async () => {
    const { fetch: fetchImpl } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":true}']);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });

    await rpc.request({ method: "sendtoaddress", params: ["addr", "1"], path: "/wallet/seller" });

    expect(rpc.exchanges()[0]?.path).toBe("/wallet/seller");
  });

  it("different wallet paths on the same instance still share one exchange log", async () => {
    const { fetch: fetchImpl } = fakeFetch([
      '{"jsonrpc":"2.0","id":1,"result":"buyer-result"}',
      '{"jsonrpc":"2.0","id":2,"result":"seller-result"}',
    ]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });

    await rpc.request({ method: "m", params: [], path: "/wallet/buyer" });
    await rpc.request({ method: "m", params: [], path: "/wallet/seller" });

    expect(rpc.exchanges().map((e) => e.path)).toEqual(["/wallet/buyer", "/wallet/seller"]);
  });
});
