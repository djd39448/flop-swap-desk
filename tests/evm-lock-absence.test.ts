// SPDX-License-Identifier: MIT
//
// tests/evm-lock-absence.test.ts - P9 review round 2, R2-FUND-01 at the rail: `EvmHtlcRail.finalizedBlock` and `readLockAbsence`
// (src/rails/evm-htlc.ts), the reads behind the Buyer's verdict "this lock attempt never landed and never can".
//
// `readLockAbsence(hashLock, refundAfterMs)` is read-only. It reads the finalized block FIRST, then the lock at the latest block; a row there is
// `landed`. With no row it says `never-locked` only when the finalized block's timestamp is at or past `refundAfterMs` (the escrow refuses a lock in any
// block at or past that time) AND the lock is absent at that finalized block too, read once more there; `not-final` otherwise. A failed read or a
// malformed answer propagates: it is never read as "absent". The finalized block follows the rail's own finality knob exactly like the evidence reader.
// Scripted JSON-RPC answers (tests/helpers/scripted-rpc.ts), so each answer is the test's own.

import { getAddress, encodeFunctionResult, numberToHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { ANVIL_LOCAL_PIN, EvmHtlcRail, type EvmFinality, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { EVM_HASH_RAIL_ABI, type AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { scriptedRpc, type ScriptedHandler } from "./helpers/scripted-rpc.js";

const NOW = (): number => 1_700_000_000_000;
const REFUND_AFTER_MS = 1_700_005_400_000;
const HASH_LOCK = `0x${"5a".repeat(32)}` as Hex;
const RAIL = getAddress(`0x${Buffer.from("absence-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("absence-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const PAYER = getAddress("0x00000000000000000000000000000000000000b1");
const BOOK: AddressBook = { resolve: () => PAYER };

const block = (number: number, timestampMs: number): { number: string; hash: string; timestamp: string } => ({
  number: numberToHex(number),
  hash: `0x${number.toString(16).padStart(64, "0")}`,
  timestamp: numberToHex(Math.floor(timestampMs / 1000)),
});

function row(status: 0 | 1 | 2 | 3): Hex {
  const zero: Address = "0x0000000000000000000000000000000000000000";
  return encodeFunctionResult({
    abi: EVM_HASH_RAIL_ABI,
    functionName: "locks",
    result: status === 0 ? [zero, zero, zero, 0n, 0n, 0n, 0] : [PAYER, PAYER, TOKEN, 1n, BigInt(REFUND_AFTER_MS - 1), BigInt(REFUND_AFTER_MS), status],
  });
}

function configWith(finality: EvmFinality): EvmRailConfig {
  const base = new EvmMockNode(NOW, RAIL, TOKEN, []).config();
  return { ...base, pin: { ...ANVIL_LOCAL_PIN, finality } };
}

async function railOver(handlers: Record<string, ScriptedHandler>, finality: EvmFinality = { mode: "tag", tag: "finalized" }) {
  const scripted = scriptedRpc({ eth_chainId: () => ({ result: "0x7a69" }), ...handlers });
  const rail = await EvmHtlcRail.connect({ config: configWith(finality), rpc: scripted.rpc, account: PAYER, addressBook: BOOK, clock: NOW });
  scripted.calls.length = 0; // connect's own chain id read is not what these tests count
  return { rail, calls: scripted.calls };
}

const methods = (calls: Array<{ method: string }>): string[] => calls.map((call) => call.method);

describe("R2-FUND-01 finalizedBlock: the rail's own finality knob, read like the evidence reader reads it", () => {
  it("the finalized tag, served: its number and timestamp (ms), by one call", async () => {
    const { rail, calls } = await railOver({ eth_getBlockByNumber: () => ({ result: block(900, REFUND_AFTER_MS + 2000) }) });
    expect(await rail.finalizedBlock()).toEqual({ number: 900n, timestampMs: REFUND_AFTER_MS + 2000 });
    expect(calls).toEqual([{ method: "eth_getBlockByNumber", params: ["finalized", false] }]);
  });

  it("a tag the node does not serve falls back to the head minus fallbackConfirmations, when the config names one", async () => {
    const { rail, calls } = await railOver(
      {
        eth_getBlockByNumber: (params) => (params[0] === "finalized" ? { error: { code: -32602, message: "invalid block tag" } } : { result: block(95, REFUND_AFTER_MS) }),
        eth_blockNumber: () => ({ result: numberToHex(100) }),
      },
      { mode: "tag", tag: "finalized", fallbackConfirmations: 5 },
    );
    expect(await rail.finalizedBlock()).toEqual({ number: 95n, timestampMs: REFUND_AFTER_MS });
    expect(calls.map((call) => [call.method, call.params[0]])).toEqual([
      ["eth_getBlockByNumber", "finalized"],
      ["eth_blockNumber", undefined],
      ["eth_getBlockByNumber", "0x5f"],
    ]);
  });

  it("a tag the node does not serve and no fallback: no finalized block at all (null), never a guess from the head", async () => {
    const { rail, calls } = await railOver({ eth_getBlockByNumber: () => ({ error: { code: -32602, message: "invalid block tag" } }) });
    expect(await rail.finalizedBlock()).toBeNull();
    expect(methods(calls)).toEqual(["eth_getBlockByNumber"]);
  });

  it("confirmations mode: the block that many below the head; a chain younger than that has none", async () => {
    const young = await railOver({ eth_blockNumber: () => ({ result: numberToHex(2) }) }, { mode: "confirmations", confirmations: 3 });
    expect(await young.rail.finalizedBlock()).toBeNull();
    expect(methods(young.calls)).toEqual(["eth_blockNumber"]); // no block read at a negative number
    const { rail, calls } = await railOver(
      { eth_blockNumber: () => ({ result: numberToHex(50) }), eth_getBlockByNumber: (params) => ({ result: block(Number(BigInt(params[0] as string)), REFUND_AFTER_MS) }) },
      { mode: "confirmations", confirmations: 3 },
    );
    expect(await rail.finalizedBlock()).toEqual({ number: 47n, timestampMs: REFUND_AFTER_MS });
    expect(calls.map((call) => call.params[0])).toEqual([undefined, "0x2f"]);
  });

  it.each([
    ["no block (null)", () => ({ result: null })],
    ["a block without a timestamp", () => ({ result: { number: "0x10", hash: `0x${"11".repeat(32)}` } })],
    ["a timestamp that is not hex", () => ({ result: { number: "0x10", timestamp: "soon" } })],
    ["a number that is not hex", () => ({ result: { number: "ten", timestamp: "0x65" } })],
    ["something that is not a block", () => ({ result: "0x1" })],
  ])("%s is no finalized block (null): a malformed answer is never read as a final one", async (_label, handler) => {
    const { rail } = await railOver({ eth_getBlockByNumber: handler });
    expect(await rail.finalizedBlock()).toBeNull();
  });
});

describe("R2-FUND-01 readLockAbsence: landed, never-locked, not-final", () => {
  const finalizedAt = (timestampMs: number, number = 900): ScriptedHandler => () => ({ result: block(number, timestampMs) });
  const noRow: ScriptedHandler = () => ({ result: row(0) });

  it("a row at the latest block is `landed` (the finalized block is read first, the lock second, and nothing is read at the finalized block)", async () => {
    const { rail, calls } = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 1), eth_call: () => ({ result: row(1) }) });
    const found = await rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS);
    expect(found.kind).toBe("landed");
    expect(methods(calls)).toEqual(["eth_getBlockByNumber", "eth_call"]);
    // whatever its status: a claim or a refund already moved it on, and it is still a lock that landed
    for (const status of [2, 3] as const) {
      const again = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 1), eth_call: () => ({ result: row(status) }) });
      expect((await again.rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).kind).toBe("landed");
    }
  });

  it("no row and a finalized block past the refund time is `never-locked`, after a second read of the lock AT that finalized block", async () => {
    const { rail, calls } = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 1000, 900), eth_call: noRow });
    const found = await rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS);
    expect(found).toEqual({ kind: "never-locked", finalized: { number: 900n, timestampMs: REFUND_AFTER_MS + 1000 } });
    expect(methods(calls)).toEqual(["eth_getBlockByNumber", "eth_call", "eth_call"]);
    expect(calls[1]?.params[1]).toBe("latest");
    expect(calls[2]?.params[1]).toBe(numberToHex(900)); // the same lock, read at the finalized block itself
  });

  it("exactly at the refund time is the verdict; one millisecond before it is `not-final`, with no second read", async () => {
    const at = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS), eth_call: noRow });
    expect((await at.rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).kind).toBe("never-locked");
    const before = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS - 1000), eth_call: noRow });
    expect((await before.rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).kind).toBe("not-final");
    expect(methods(before.calls)).toEqual(["eth_getBlockByNumber", "eth_call"]);
  });

  it("no finalized block at all is `not-final`, even though no row exists and the chain may be long past the refund time", async () => {
    const { rail } = await railOver({ eth_getBlockByNumber: () => ({ error: { code: -32602, message: "invalid block tag" } }), eth_call: noRow });
    expect((await rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).kind).toBe("not-final");
  });

  it("a node that answers 'no row' at the latest block but HAS the lock at the finalized block (it lags the node that named it) is `landed`, not never", async () => {
    const { rail } = await railOver({
      eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 5000),
      eth_call: (params) => ({ result: params[1] === "latest" ? row(0) : row(1) }),
    });
    expect((await rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).kind).toBe("landed");
  });

  it("a read that fails is never read as 'absent': an error answer at the latest block, at the finalized block, or a status byte no contract has, propagates", async () => {
    const latestFails = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 1), eth_call: () => ({ error: { code: -32000, message: "node is down" } }) });
    await expect(latestFails.rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).rejects.toThrow();
    const finalizedFails = await railOver({
      eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 1),
      eth_call: (params) => (params[1] === "latest" ? { result: row(0) } : { error: { code: -32000, message: "missing trie node" } }),
    });
    await expect(finalizedFails.rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).rejects.toThrow();
    const oddStatus = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 1), eth_call: () => ({ result: row(1).replace(/0{63}1$/, `${"0".repeat(63)}9`) as Hex }) });
    await expect(oddStatus.rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS)).rejects.toThrow();
  });

  it("it only reads: no eth_sendRawTransaction, eth_sendTransaction or any write method is ever asked", async () => {
    const { rail, calls } = await railOver({ eth_getBlockByNumber: finalizedAt(REFUND_AFTER_MS + 1), eth_call: noRow });
    await rail.readLockAbsence(HASH_LOCK, REFUND_AFTER_MS);
    expect(methods(calls).filter((method) => method.startsWith("eth_send") || method === "personal_sign")).toEqual([]);
  });
});
