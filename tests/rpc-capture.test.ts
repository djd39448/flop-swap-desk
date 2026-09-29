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

import { CapturingRpc, DEFAULT_MAX_RESPONSE_BYTES, RpcCaptureError, readCapture, writeCapture } from "../src/rails/rpc-capture.js";

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

  // P22-P24-EVM-FIXES-R2.md D6: the timeout must cover the response BODY, not only the initial
  // connection — `fetch()` commonly resolves once headers arrive while the body keeps
  // streaming. Clearing the timer right after `fetchImpl` resolves (the pre-D6 bug) leaves
  // `controller.abort()` never called at all, so a server that stalls mid-body would hang the
  // subsequent `arrayBuffer()` read forever instead of ever rejecting.
  it("D6: aborts a stalled response BODY after timeoutMs, even though the connection itself resolved promptly", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      // The connection resolves immediately (as if headers arrived right away) — only the body
      // read stalls, tied to the same AbortSignal a real fetch() Response would honor.
      return {
        text: async () => {
          throw new Error("must not call text() to hash the response");
        },
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      } as unknown as Response;
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

// P5-NEAR-FIXES.md E5: a byte cap on captured responses — over the cap, the read aborts with a
// transport-class error (never an RpcCaptureError) and is never recorded as an exchange at all.
describe("CapturingRpc maxResponseBytes (E5)", () => {
  it("defaults to 4 MiB", () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("refuses a response whose declared content-length exceeds maxResponseBytes, before ever buffering it", async () => {
    let bodyRead = false;
    const fetchImpl = (async () =>
      ({
        headers: { get: (name: string) => (name === "content-length" ? "1000" : null) },
        arrayBuffer: async () => {
          bodyRead = true;
          return new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":"0x1"}').buffer;
        },
      }) as unknown as Response) as typeof fetch;
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, maxResponseBytes: 10 });

    await expect(rpc.request({ method: "eth_chainId", params: [] })).rejects.toThrow(/exceeding maxResponseBytes/);
    expect(bodyRead).toBe(false);
    expect(rpc.exchanges()).toHaveLength(0);
  });

  it("refuses an over-cap response with no content-length header, after buffering it", async () => {
    const bigBody = `{"jsonrpc":"2.0","id":1,"result":"${"a".repeat(100)}"}`;
    const { fetch: fetchImpl } = fakeFetch([bigBody]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, maxResponseBytes: 10 });

    await expect(rpc.request({ method: "eth_chainId", params: [] })).rejects.toThrow(/exceeding maxResponseBytes/);
    expect(rpc.exchanges()).toHaveLength(0); // never recorded — not a completed read
  });

  it("never refuses a response under the cap (the default, and every existing EVM/Bitcoin call, is unaffected)", async () => {
    const { fetch: fetchImpl } = fakeFetch(['{"jsonrpc":"2.0","id":1,"result":"0x1"}']);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await expect(rpc.request({ method: "eth_chainId", params: [] })).resolves.toBe("0x1");
    expect(rpc.exchanges()).toHaveLength(1);
  });

  it("a thrown maxResponseBytes error is a plain Error, never an RpcCaptureError", async () => {
    const { fetch: fetchImpl } = fakeFetch([`{"jsonrpc":"2.0","id":1,"result":"${"a".repeat(100)}"}`]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, maxResponseBytes: 10 });
    try {
      await rpc.request({ method: "eth_chainId", params: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).not.toBeInstanceOf(RpcCaptureError);
      expect(error).toBeInstanceOf(Error);
    }
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

  /** D2: builds a minimal well-formed `Exchange` for a given wire-bytes payload — every field
   *  `writeCapture` might touch, `responseBytes` (the source of truth from here on) computed
   *  from the same bytes `responseBody`/`responseSha256` describe, exactly like `CapturingRpc`
   *  itself builds one. */
  function exchangeFor(bytes: Uint8Array): { method: string; params: unknown; requestBody: string; responseBody: string; responseBytes: Uint8Array; responseSha256: string; atMs: number } {
    return {
      method: "m",
      params: [],
      requestBody: "{}",
      responseBody: new TextDecoder("utf-8").decode(bytes),
      responseBytes: bytes,
      responseSha256: bytesToHex(sha256(bytes)),
      atMs: 1,
    };
  }

  it("writes each exchange's responseBytes byte-exact to raw/rpc/<sha256>.json", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":"0x7a69"}';
    const bytes = new TextEncoder().encode(body);
    const hash = sha256Hex(body);
    await writeCapture(root, [exchangeFor(bytes)]);

    const onDisk = await readFile(join(root, "raw", "rpc", `${hash}.json`), "utf8");
    expect(onDisk).toBe(body);
  });

  it("is idempotent: writing the same exchange twice does not throw and leaves the same bytes", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
    const exchange = exchangeFor(new TextEncoder().encode(body));
    await writeCapture(root, [exchange]);
    await expect(writeCapture(root, [exchange])).resolves.toBeUndefined();
    const onDisk = await readFile(join(root, "raw", "rpc", `${exchange.responseSha256}.json`), "utf8");
    expect(onDisk).toBe(body);
  });

  it("readCapture returns the exact bytes when the hash matches", async () => {
    const body = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
    const bytes = new TextEncoder().encode(body);
    const hash = sha256Hex(body);
    await writeCapture(root, [exchangeFor(bytes)]);

    await expect(readCapture(root, hash)).resolves.toEqual(bytes);
  });

  it("readCapture returns null for a missing file", async () => {
    await expect(readCapture(root, "a".repeat(64))).resolves.toBeNull();
  });

  it("readCapture returns null when the on-disk bytes have been tampered with (hash no longer matches)", async () => {
    const original = '{"jsonrpc":"2.0","id":1,"result":"0x1"}';
    const hash = sha256Hex(original);
    await writeCapture(root, [exchangeFor(new TextEncoder().encode(original))]);

    // Tamper with the file in place — the name still claims `hash`, the content no longer
    // hashes to it.
    await writeFile(join(root, "raw", "rpc", `${hash}.json`), '{"jsonrpc":"2.0","id":1,"result":"0xTAMPERED"}');

    await expect(readCapture(root, hash)).resolves.toBeNull();
  });

  // P22-P24-EVM-FIXES-R2.md D2: "a response with a UTF-8 BOM or an invalid byte gives the same
  // verdict live and in replay" — writeCapture/readCapture must round-trip the exact bytes, not
  // a decoded-then-re-encoded string (which is lossy for a byte that isn't valid UTF-8 at all).
  it("round-trips a response body that is not valid UTF-8 byte-for-byte (never a lossy string round trip)", async () => {
    // A genuine UTF-8 BOM (EF BB BF) followed by a lone continuation byte (0x80), which on its
    // own is not valid UTF-8 at any position — a non-fatal decode would replace it with U+FFFD,
    // and re-encoding *that* would produce different bytes than these.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x80, 0x7d]); // BOM + "{" + invalid + "}"
    const hash = bytesToHex(sha256(bytes));
    await writeCapture(root, [exchangeFor(bytes)]);

    const onDiskBuffer = await readFile(join(root, "raw", "rpc", `${hash}.json`));
    expect(new Uint8Array(onDiskBuffer)).toEqual(bytes);

    const replayed = await readCapture(root, hash);
    expect(replayed).toEqual(bytes);
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

// P22-P24-EVM-FIXES-R2.md D1: a plain auto-incrementing id is unique only within one
// `CapturingRpc` instance's own lifetime — it always restarts at 1 for a fresh instance — so a
// caller whose instance spans more than one logical "capture" (a swap's own hashLock, say) must
// be able to bind every id it mints to that capture instead, so a genuine response minted under
// a *different* namespace can never be mistaken for one of this capture's own exchanges by id
// alone (see src/rails/evm-evidence.ts's `idBoundToCapture`/`bindExchange`).
describe("CapturingRpc.setIdNamespace", () => {
  it("mints `${namespace}:${n}` (n restarting at 1) once a namespace is set", async () => {
    const { fetch: fetchImpl } = fakeFetch([
      '{"jsonrpc":"2.0","id":"swap-a:1","result":"0x1"}',
      '{"jsonrpc":"2.0","id":"swap-a:2","result":"0x2"}',
    ]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    rpc.setIdNamespace("swap-a");
    await rpc.request({ method: "eth_chainId", params: [] });
    await rpc.request({ method: "eth_blockNumber", params: [] });
    const ids = rpc.exchanges().map((exchange) => JSON.parse(exchange.requestBody).id);
    expect(ids).toEqual(["swap-a:1", "swap-a:2"]);
  });

  it("two different namespaces never mint the same id, even at the same position", async () => {
    const { fetch: fetchImpl } = fakeFetch([
      '{"jsonrpc":"2.0","id":"swap-a:1","result":"0x1"}',
      '{"jsonrpc":"2.0","id":"swap-b:1","result":"0x2"}',
    ]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    rpc.setIdNamespace("swap-a");
    await rpc.request({ method: "eth_chainId", params: [] });
    rpc.setIdNamespace("swap-b");
    await rpc.request({ method: "eth_chainId", params: [] });
    const ids = rpc.exchanges().map((exchange) => JSON.parse(exchange.requestBody).id);
    expect(ids).toEqual(["swap-a:1", "swap-b:1"]);
  });

  it("passing undefined restores the bare auto-incrementing integer sequence", async () => {
    const { fetch: fetchImpl } = fakeFetch([
      '{"jsonrpc":"2.0","id":"swap-a:1","result":"0x1"}',
      '{"jsonrpc":"2.0","id":1,"result":"0x2"}',
    ]);
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    rpc.setIdNamespace("swap-a");
    await rpc.request({ method: "eth_chainId", params: [] });
    rpc.setIdNamespace(undefined);
    await rpc.request({ method: "eth_blockNumber", params: [] });
    const ids = rpc.exchanges().map((exchange) => JSON.parse(exchange.requestBody).id);
    expect(ids).toEqual(["swap-a:1", 1]);
  });
});
