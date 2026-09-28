// SPDX-License-Identifier: MIT
//
// tests/rpc-capture.test.ts — P22-P24-EVM-SPEC.md §2.3: capture bytes and hashes, and tamper
// detection in `readCapture`. `CapturingRpc` is exercised against a mocked `fetch` (an
// EIP-1193 transport has no real network involvement to speak of; the point here is the
// byte-exact recording, not any particular chain's wire format).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CapturingRpc, RpcCaptureError, readCapture, writeCapture } from "../src/rails/rpc-capture.js";

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

/** A `fetch`-shaped stub that answers each call with the next body in `bodies`, in order,
 *  and records every `(url, init)` it was called with. */
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

describe("CapturingRpc.request", () => {
  it("POSTs a JSON-RPC 2.0 body it serialised itself, with an incrementing id", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":"0x7a69"}']);
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: fetchImpl, clock: () => 1000 });

    const result = await rpc.request({ method: "eth_chainId", params: [] });

    expect(result).toBe("0x7a69");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9999");
    expect(calls[0]?.init.method).toBe("POST");
    const sentBody = JSON.parse(String(calls[0]?.init.body));
    expect(sentBody).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  });

  it("increments the request id across calls on the same instance", async () => {
    const { fetch: fetchImpl } = fakeFetch([
      '{"jsonrpc":"2.0","id":1,"result":"0x1"}',
      '{"jsonrpc":"2.0","id":2,"result":"0x2"}',
    ]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await rpc.request({ method: "eth_blockNumber", params: [] });
    await rpc.request({ method: "eth_blockNumber", params: [] });
    const ids = rpc.exchanges().map((exchange) => JSON.parse(exchange.requestBody).id);
    expect(ids).toEqual([1, 2]);
  });

  it("records method, params, requestBody, responseBody, responseSha256 and the injected clock's atMs", async () => {
    const responseBody = '{"jsonrpc":"2.0","id":1,"result":"0x2a"}';
    const { fetch: fetchImpl } = fakeFetch([responseBody]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => 424242 });

    await rpc.request({ method: "eth_getBalance", params: ["0xabc", "latest"] });

    const [exchange] = rpc.exchanges();
    expect(exchange).toBeDefined();
    expect(exchange?.method).toBe("eth_getBalance");
    expect(exchange?.params).toEqual(["0xabc", "latest"]);
    expect(exchange?.responseBody).toBe(responseBody);
    expect(exchange?.responseSha256).toBe(sha256Hex(responseBody));
    expect(exchange?.atMs).toBe(424242);
  });

  it("throws an RpcCaptureError carrying the JSON-RPC code/message, but still records the exchange", async () => {
    const { fetch: fetchImpl } = fakeFetch(['{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}']);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });

    await expect(rpc.request({ method: "eth_call", params: [] })).rejects.toMatchObject({
      code: -32602,
      message: "bad params",
    });
    expect(rpc.exchanges()).toHaveLength(1);
  });

  it("throws (but still records the exchange) when the response body is not valid JSON", async () => {
    const { fetch: fetchImpl } = fakeFetch(["not json at all"]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });

    await expect(rpc.request({ method: "eth_chainId", params: [] })).rejects.toThrow();
    expect(rpc.exchanges()).toHaveLength(1);
    expect(rpc.exchanges()[0]?.responseBody).toBe("not json at all");
  });

  // P22-P24-EVM-FIXES.md A9: hash the wire bytes via arrayBuffer(), never a `.text()`
  // decode/re-encode round trip, and abort a stalled call instead of hanging forever.
  it("hashes the exact wire bytes from arrayBuffer(), never calling text() to do it", async () => {
    const trueBytes = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
    const fetchImpl = (async () => ({
      text: async () => {
        throw new Error("must not call text() to hash the response");
      },
      arrayBuffer: async () => trueBytes.buffer,
    })) as unknown as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });

    await rpc.request({ method: "eth_chainId", params: [] });

    const [exchange] = rpc.exchanges();
    expect(exchange?.responseSha256).toBe(sha256Hex(new TextDecoder().decode(trueBytes)));
    expect(exchange?.responseBody).toBe(new TextDecoder().decode(trueBytes));
  });

  it("passes an AbortSignal to fetch on every call", async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      const body = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
      const bytes = new TextEncoder().encode(body);
      return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, timeoutMs: 5_000 });

    await rpc.request({ method: "eth_chainId", params: [] });

    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(sawSignal?.aborted).toBe(false);
  });

  it("aborts a stalled request after timeoutMs, so a dead RPC endpoint cannot hang a sweep", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, timeoutMs: 20 });

    await expect(rpc.request({ method: "eth_chainId", params: [] })).rejects.toThrow(/abort/i);
  });

  it("never aborts when timeoutMs is not configured (the default)", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
      const bytes = new TextEncoder().encode(body);
      expect(init?.signal?.aborted).toBe(false);
      return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await expect(rpc.request({ method: "eth_chainId", params: [] })).resolves.toBe("0x1");
  });

  it("exchanges() peeks without clearing; drain() takes and clears", async () => {
    const { fetch: fetchImpl } = fakeFetch([
      '{"jsonrpc":"2.0","id":1,"result":"0x1"}',
      '{"jsonrpc":"2.0","id":2,"result":"0x2"}',
    ]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await rpc.request({ method: "a", params: [] });
    await rpc.request({ method: "b", params: [] });

    expect(rpc.exchanges()).toHaveLength(2);
    expect(rpc.exchanges()).toHaveLength(2); // peeking again changes nothing

    const drained = rpc.drain();
    expect(drained).toHaveLength(2);
    expect(rpc.exchanges()).toHaveLength(0); // cleared
  });
});

describe("writeCapture / readCapture", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flop-swap-desk-rpc-capture-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes each exchange's responseBody byte-exact to raw/rpc/<sha256>.json", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":"0x7a69"}';
    const hash = sha256Hex(body);
    await writeCapture(root, [{ method: "eth_chainId", params: [], requestBody: "{}", responseBody: body, responseSha256: hash, atMs: 1 }]);

    const onDisk = await readFile(join(root, "raw", "rpc", `${hash}.json`), "utf8");
    expect(onDisk).toBe(body);
  });

  it("is idempotent: writing the same exchange twice does not throw and leaves the same bytes", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
    const hash = sha256Hex(body);
    const exchange = { method: "m", params: [], requestBody: "{}", responseBody: body, responseSha256: hash, atMs: 1 };
    await writeCapture(root, [exchange]);
    await expect(writeCapture(root, [exchange])).resolves.toBeUndefined();
    const onDisk = await readFile(join(root, "raw", "rpc", `${hash}.json`), "utf8");
    expect(onDisk).toBe(body);
  });

  it("readCapture returns the exact bytes when the hash matches", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
    const hash = sha256Hex(body);
    await writeCapture(root, [{ method: "m", params: [], requestBody: "{}", responseBody: body, responseSha256: hash, atMs: 1 }]);

    await expect(readCapture(root, hash)).resolves.toBe(body);
  });

  it("readCapture returns null for a missing file", async () => {
    await expect(readCapture(root, "a".repeat(64))).resolves.toBeNull();
  });

  it("readCapture returns null when the on-disk bytes have been tampered with (hash no longer matches)", async () => {
    const original = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
    const hash = sha256Hex(original);
    await writeCapture(root, [{ method: "m", params: [], requestBody: "{}", responseBody: original, responseSha256: hash, atMs: 1 }]);

    // Tamper with the file in place — the name still claims `hash`, the content no longer
    // hashes to it.
    await writeFile(join(root, "raw", "rpc", `${hash}.json`), '{"jsonrpc":"2.0","id":1,"result":"0xTAMPERED"}');

    await expect(readCapture(root, hash)).resolves.toBeNull();
  });

  it("readCapture refuses a malformed sha256 (never touches the filesystem for it)", async () => {
    await expect(readCapture(root, "../../etc/passwd")).resolves.toBeNull();
    await expect(readCapture(root, "not-hex")).resolves.toBeNull();
    await expect(readCapture(root, "A".repeat(64))).resolves.toBeNull(); // uppercase refused
  });
});

describe("RpcCaptureError", () => {
  it("is a real Error subclass carrying code and message", () => {
    const error = new RpcCaptureError(-32000, "boom");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(-32000);
    expect(error.message).toBe("boom");
    expect(error.name).toBe("RpcCaptureError");
  });
});
