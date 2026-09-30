// SPDX-License-Identifier: MIT
//
// tests/sol-rpc.test.ts - SolRpc over CapturingRpc: request shapes, typed errors from the STRUCTURED cause
// (JSON-RPC `code` and `data.err`, not prose), transport failures that stay failures, and the response
// byte cap. The error bodies follow the shapes Agave's RPC server documents for its custom errors
// (Solana JSON-RPC docs: sendTransaction / simulateTransaction preflight failure, -32005 node unhealthy,
// -32004/-32007/-32009 block or slot unavailable, -32016 minimum context slot). The real validator confirms
// them in SB-int; nothing here claims to have captured them from one.

import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { CapturingRpc } from "../src/rails/rpc-capture.js";
import {
  SOL_MAX_RESPONSE_BYTES,
  SolBlockNotAvailableError,
  SolBlockhashNotFoundError,
  SolMinContextSlotError,
  SolNodeUnhealthyError,
  SolResponseTooLargeError,
  SolRpc,
  SolRpcError,
  SolSimulationFailedError,
  programErrorCode,
} from "../src/rails/sol-rpc.js";
import { compileLegacyMessage, signTransaction } from "../src/rails/sol-tx.js";
import { InMemorySolSigner } from "../src/rails/sol-signer-memory.js";

function scripted(
  bodies: unknown[],
  opts: { maxResponseBytes?: number; headers?: Record<string, string> } = {},
): { rpc: CapturingRpc; sol: SolRpc; requests: Array<{ method: string; params: unknown[] }> } {
  const requests: Array<{ method: string; params: unknown[] }> = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    requests.push({ method: parsed.method, params: parsed.params });
    const next = bodies[i];
    i += 1;
    if (next instanceof Error) throw next;
    const text = typeof next === "string" ? next : JSON.stringify({ jsonrpc: "2.0", id: 1, ...(next as object) });
    const bytes = new TextEncoder().encode(text);
    return {
      text: async () => text,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      headers: { get: (n: string) => opts.headers?.[n.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as typeof fetch;
  const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => 1, ...(opts.maxResponseBytes === undefined ? {} : { maxResponseBytes: opts.maxResponseBytes }) });
  return { rpc, sol: new SolRpc(rpc), requests };
}

const ok = (result: unknown): { result: unknown } => ({ result });
const err = (code: number, message: string, data?: unknown): { error: unknown } => ({ error: { code, message, ...(data === undefined ? {} : { data }) } });

describe("typed errors from the structured cause", () => {
  it("-32002 with data.err 'BlockhashNotFound' is SolBlockhashNotFoundError (a preflight refusal, nothing broadcast)", async () => {
    const { sol } = scripted([err(-32002, "Transaction simulation failed: Blockhash not found", { accounts: null, err: "BlockhashNotFound", logs: [], returnData: null, unitsConsumed: 0 })]);
    const e = await sol.sendTransaction(new Uint8Array([1])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SolBlockhashNotFoundError);
    expect(e).toBeInstanceOf(SolSimulationFailedError);
    expect((e as SolBlockhashNotFoundError).phase).toBe("preflight");
  });

  it("-32002 with an InstructionError keeps err, logs and units, and the custom code is readable", async () => {
    const structured = { InstructionError: [0, { Custom: 19 }] };
    const { sol } = scripted([err(-32002, "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x13", { err: structured, logs: ["Program log: x"], unitsConsumed: 900 })]);
    const e = (await sol.sendTransaction(new Uint8Array([1])).catch((x: unknown) => x)) as SolSimulationFailedError;
    expect(e).toBeInstanceOf(SolSimulationFailedError);
    expect(e.err).toEqual(structured);
    expect(e.logs).toEqual(["Program log: x"]);
    expect(e.unitsConsumed).toBe(900);
    expect(programErrorCode(e.err)).toBe(19);
  });

  it("the mapping does not depend on the message text (same code and data, different prose)", async () => {
    const { sol } = scripted([err(-32002, "totally different words", { err: "BlockhashNotFound", logs: [] })]);
    await expect(sol.sendTransaction(new Uint8Array([1]))).rejects.toBeInstanceOf(SolBlockhashNotFoundError);
    const other = scripted([err(-32002, "Blockhash not found", { err: { InstructionError: [0, "Custom"] }, logs: [] })]);
    const e = await other.sol.sendTransaction(new Uint8Array([1])).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(SolBlockhashNotFoundError);
    expect(e).toBeInstanceOf(SolSimulationFailedError);
  });

  it("-32005 unhealthy, -32004/-32007/-32009 block unavailable, -32016 min context slot (with the reported slot), anything else SolRpcError", async () => {
    const { sol } = scripted([
      err(-32005, "Node is behind by 100 slots", { numSlotsBehind: 100 }),
      err(-32004, "Block not available for slot 5"),
      err(-32007, "Slot 5 was skipped, or missing due to ledger jump to recent snapshot"),
      err(-32009, "Slot 5 was skipped, or missing in long-term storage"),
      err(-32016, "Minimum context slot has not been reached", { contextSlot: 42 }),
      err(-32602, "Invalid params"),
      err(-32603, "Internal error"),
    ]);
    await expect(sol.getSlot("finalized")).rejects.toBeInstanceOf(SolNodeUnhealthyError);
    await expect(sol.getBlockTime(5)).rejects.toBeInstanceOf(SolBlockNotAvailableError);
    await expect(sol.getBlockTime(5)).rejects.toBeInstanceOf(SolBlockNotAvailableError);
    await expect(sol.getBlockTime(5)).rejects.toBeInstanceOf(SolBlockNotAvailableError);
    const minCtx = (await sol.getAccountInfo("11111111111111111111111111111111", { minContextSlot: 50 }).catch((x: unknown) => x)) as SolMinContextSlotError;
    expect(minCtx).toBeInstanceOf(SolMinContextSlotError);
    expect(minCtx.contextSlot).toBe(42);
    const invalid = (await sol.getSlot("finalized").catch((x: unknown) => x)) as SolRpcError;
    expect(invalid).toBeInstanceOf(SolRpcError);
    expect(invalid.constructor).toBe(SolRpcError);
    expect(invalid.code).toBe(-32602);
    await expect(sol.getSlot("finalized")).rejects.toMatchObject({ code: -32603 });
  });

  it("programErrorCode reads only {InstructionError: [i, {Custom: n}]}", () => {
    expect(programErrorCode({ InstructionError: [0, { Custom: 7 }] })).toBe(7);
    for (const v of [null, "BlockhashNotFound", { InstructionError: [0, "InvalidInstructionData"] }, { InstructionError: [0] }, { Other: 1 }, 5, undefined]) expect(programErrorCode(v)).toBeNull();
  });
});

describe("transport failures are failures", () => {
  it("a network error is rethrown unchanged, never turned into a Solana-specific answer", async () => {
    const boom = new Error("ECONNREFUSED");
    const { sol } = scripted([boom]);
    await expect(sol.getSignatureStatuses(["a"])).rejects.toBe(boom);
  });

  it("a body that is not JSON, or not a JSON-RPC object, is a plain Error", async () => {
    const { sol } = scripted(["<html>502</html>", "null"]);
    await expect(sol.getSlot("finalized")).rejects.toThrow(/not valid JSON/);
    await expect(sol.getSlot("finalized")).rejects.toThrow(/not a JSON-RPC object/);
  });

  it("an over-cap response is SolResponseTooLargeError and is NOT recorded as a completed read", async () => {
    const big = { result: { context: { slot: 1 }, value: "x".repeat(500) } };
    const { sol, rpc } = scripted([big], { maxResponseBytes: 100 });
    await expect(sol.getAccountInfo("11111111111111111111111111111111")).rejects.toBeInstanceOf(SolResponseTooLargeError);
    expect(rpc.exchanges()).toHaveLength(0);
  });

  it("a declared Content-Length over the cap is refused before the body is read", async () => {
    const { sol, rpc } = scripted([ok(1)], { maxResponseBytes: 100, headers: { "content-length": "5000" } });
    await expect(sol.getSlot("finalized")).rejects.toBeInstanceOf(SolResponseTooLargeError);
    expect(rpc.exchanges()).toHaveLength(0);
  });

  it("the documented default cap is 4 MiB, above a reviewed program's base64 ProgramData", () => {
    expect(SOL_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("request shapes and 'not found' answers", () => {
  it("getSlot / getBlockHeight / getLatestBlockhash pass the commitment; results are checked", async () => {
    const { sol, requests } = scripted([ok(77), ok(66), ok({ context: { slot: 9 }, value: { blockhash: "abc", lastValidBlockHeight: 200 } })]);
    expect(await sol.getSlot("finalized")).toBe(77);
    expect(await sol.getBlockHeight("finalized")).toBe(66);
    expect(await sol.getLatestBlockhash("confirmed")).toEqual({ blockhash: "abc", lastValidBlockHeight: 200, contextSlot: 9 });
    expect(requests.map((r) => r.params)).toEqual([[{ commitment: "finalized" }], [{ commitment: "finalized" }], [{ commitment: "confirmed" }]]);
  });

  it("getAccountInfo asks for base64 with commitment and minContextSlot; null value is 'no account', not an error", async () => {
    const { sol, requests } = scripted([
      ok({ context: { slot: 5 }, value: null }),
      ok({ context: { slot: 6 }, value: { lamports: 3, owner: "11111111111111111111111111111111", data: [base64.encode(new Uint8Array([1, 2])), "base64"], executable: false, rentEpoch: 0 } }),
    ]);
    expect(await sol.getAccountInfo("k", { commitment: "finalized", minContextSlot: 4 })).toEqual({ contextSlot: 5, account: null });
    expect(requests[0]?.params).toEqual(["k", { encoding: "base64", commitment: "finalized", minContextSlot: 4 }]);
    const found = await sol.getAccountInfo("k");
    expect(found.account?.data).toEqual(new Uint8Array([1, 2]));
    expect(found.account?.lamports).toBe(3);
    expect(requests[1]?.params).toEqual(["k", { encoding: "base64" }]);
  });

  it("getMultipleAccounts is one call at one context slot and the count must match", async () => {
    const { sol } = scripted([ok({ context: { slot: 7 }, value: [null, null] }), ok({ context: { slot: 7 }, value: [null] })]);
    expect(await sol.getMultipleAccounts(["a", "b"], { commitment: "finalized" })).toEqual({ contextSlot: 7, accounts: [null, null] });
    await expect(sol.getMultipleAccounts(["a", "b"])).rejects.toThrow(/wrong number/);
  });

  it("malformed account data or shapes are refused, never coerced", async () => {
    const { sol } = scripted([ok({ context: { slot: 1 }, value: { lamports: 1, owner: "x", data: "notarray", executable: false } }), ok("not an object"), ok({ context: { slot: "1" }, value: null })]);
    await expect(sol.getAccountInfo("k")).rejects.toThrow(/base64/);
    await expect(sol.getAccountInfo("k")).rejects.toThrow(/not an object/);
    await expect(sol.getAccountInfo("k")).rejects.toThrow(/not a number/);
  });

  it("simulateTransaction returns a set err as a RESULT (sigVerify defaults to true)", async () => {
    const { sol, requests } = scripted([ok({ context: { slot: 3 }, value: { err: { InstructionError: [0, { Custom: 19 }] }, logs: ["l"], unitsConsumed: 5 } })]);
    const out = await sol.simulateTransaction(new Uint8Array([9]), { commitment: "confirmed" });
    expect(out).toEqual({ contextSlot: 3, err: { InstructionError: [0, { Custom: 19 }] }, logs: ["l"], unitsConsumed: 5 });
    expect(requests[0]?.params).toEqual([base64.encode(new Uint8Array([9])), { encoding: "base64", sigVerify: true, commitment: "confirmed" }]);
  });

  it("sendTransaction keeps the preflight ON unless asked otherwise", async () => {
    const { sol, requests } = scripted([ok("sig1"), ok("sig2")]);
    expect(await sol.sendTransaction(new Uint8Array([1]), { preflightCommitment: "confirmed" })).toBe("sig1");
    expect(requests[0]?.params[1]).toEqual({ encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" });
    await sol.sendTransaction(new Uint8Array([1]), { skipPreflight: true });
    expect((requests[1]?.params[1] as { skipPreflight: boolean }).skipPreflight).toBe(true);
  });

  it("getSignatureStatuses searches history; null entries mean 'no status'; an unknown confirmationStatus is refused", async () => {
    const { sol, requests } = scripted([
      ok({ context: { slot: 1 }, value: [null, { slot: 4, confirmations: null, err: null, confirmationStatus: "finalized" }] }),
      ok({ context: { slot: 1 }, value: [{ slot: 4, confirmations: 1, err: null, confirmationStatus: "bogus" }] }),
    ]);
    expect(await sol.getSignatureStatuses(["a", "b"])).toEqual([null, { slot: 4, confirmations: null, err: null, confirmationStatus: "finalized" }]);
    expect(requests[0]?.params[1]).toEqual({ searchTransactionHistory: true });
    await expect(sol.getSignatureStatuses(["a"])).rejects.toThrow(/confirmationStatus/);
  });

  it("getTransaction: null is 'no such transaction'; a v0 or undecodable transaction comes back with transaction null", async () => {
    const signer = InMemorySolSigner.generate(new Uint8Array(32).fill(1));
    const msg = compileLegacyMessage({ feePayer: signer.publicKeyBytes, recentBlockhash: new Uint8Array(32), instructions: [{ programId: new Uint8Array(32).fill(4), accounts: [], data: Uint8Array.of(1) }] });
    const tx = await signTransaction(msg, [signer]);
    const { sol, requests } = scripted([
      ok(null),
      ok({ slot: 8, blockTime: 1700000000, meta: { err: null }, transaction: [base64.encode(tx.bytes), "base64"], version: "legacy" }),
      ok({ slot: 8, blockTime: null, meta: { err: null }, transaction: [base64.encode(Uint8Array.of(0x80, 1, 2)), "base64"], version: 0 }),
    ]);
    expect(await sol.getTransaction("s", "finalized")).toBeNull();
    const fetched = await sol.getTransaction("s", "finalized");
    expect(fetched?.transaction?.signature).toBe(tx.signature);
    expect(fetched).toMatchObject({ slot: 8, blockTime: 1700000000, err: null });
    expect((await sol.getTransaction("s", "finalized"))?.transaction).toBeNull();
    expect(requests[0]?.params[1]).toEqual({ encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 });
  });

  it("getSignaturesForAddress pages with before/limit and keeps failed transactions' err", async () => {
    const { sol, requests } = scripted([ok([{ signature: "s1", slot: 3, err: { InstructionError: [0, { Custom: 19 }] }, blockTime: null }, { signature: "s2", slot: 2, err: null, blockTime: 5 }]), ok("nope")]);
    const list = await sol.getSignaturesForAddress("addr", { commitment: "finalized", limit: 25, before: "s0" });
    expect(list).toEqual([
      { signature: "s1", slot: 3, err: { InstructionError: [0, { Custom: 19 }] }, blockTime: null },
      { signature: "s2", slot: 2, err: null, blockTime: 5 },
    ]);
    expect(requests[0]?.params).toEqual(["addr", { commitment: "finalized", limit: 25, before: "s0" }]);
    await expect(sol.getSignaturesForAddress("addr", { commitment: "finalized" })).rejects.toThrow(/array/);
  });

  it("getBlockTime null is 'no time', getGenesisHash/getVersion are checked, requestAirdrop returns the signature", async () => {
    const { sol } = scripted([ok(null), ok(1700000000), ok("GenesisHash"), ok({ "solana-core": "4.3.0", "feature-set": 5 }), ok("airdropsig"), ok(12)]);
    expect(await sol.getBlockTime(1)).toBeNull();
    expect(await sol.getBlockTime(1)).toBe(1700000000);
    expect(await sol.getGenesisHash()).toBe("GenesisHash");
    expect(await sol.getVersion()).toEqual({ solanaCore: "4.3.0", featureSet: 5 });
    expect(await sol.requestAirdrop("k", 5)).toBe("airdropsig");
    await expect(sol.getGenesisHash()).rejects.toThrow(/not a string/);
  });
});
