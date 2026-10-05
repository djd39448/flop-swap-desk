// SPDX-License-Identifier: MIT
//
// tests/rail-recovery-evm.test.ts: P8-RESUME-SPEC.md "Rail seam" and "Rail recovery" for the EVM leg. An EVM lock
// needs no recovery handle: its ref IS the hash lock, a repeated `approve` is harmless, and a repeated `lock` reverts
// on the contract's duplicate hash-lock check. So a restarted Buyer reads the lock by its hash lock:
//   - a row owned by this account is `landed` (whatever its status);
//   - no row is `never-landed`, in the weak sense documented on `recoverLock` (re-running `commitLock` cannot lock twice);
//   - a row owned by another payer can never become this party's lock: a typed `lock-conflict`.
// Runs against a mocked JSON-RPC node (the pattern tests/client-flows.test.ts uses): no anvil.

import type { LockTerms } from "@flop-labs/tclk";
import { decodeFunctionData, encodeFunctionResult, getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { RailRecoveryRefusedError } from "../src/client/counter-rail.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { ANVIL_LOCAL_PIN, EvmHtlcRail, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";

function addr(tag: string): Address {
  return getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
}
const RAIL_CONTRACT = addr("rail-recovery-evm-rail");
const TOKEN = addr("rail-recovery-evm-usdc");
const BUYER = addr("rail-recovery-evm-buyer");
const SELLER = addr("rail-recovery-evm-seller");
const STRANGER = addr("rail-recovery-evm-other");
const HASH_LOCK = `0x${"11".repeat(32)}` as Hex;

const config: EvmRailConfig = { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: RAIL_CONTRACT, assets: { USDC: TOKEN } };

function lockTerms(): LockTerms {
  return {
    contract: `0x${"22".repeat(32)}`,
    lock: "hash",
    statement: HASH_LOCK,
    amount: "1000000",
    asset: "USDC",
    payer: "did:key:payer",
    payee: "did:key:payee",
    claimByMs: 1_700_003_600_000,
    refundAfterMs: 1_700_005_400_000,
  };
}

interface Row {
  payer: Address;
  payee: Address;
  status: number;
}

/** A node that answers `eth_chainId` and `eth_call locks(hashLock)`; every other method is recorded and answered with
 *  an error, so a write attempt would be seen (and would fail the test). */
function node(row: Row | "transport-error"): { rpc: CapturingRpc; methods: string[]; callData: string[] } {
  const methods: string[] = [];
  const callData: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ data?: string; to?: string }> };
    methods.push(body.method);
    let envelope: Record<string, unknown>;
    if (body.method === "eth_chainId") {
      envelope = { jsonrpc: "2.0", id: body.id, result: `0x${ANVIL_LOCAL_PIN.chainId.toString(16)}` };
    } else if (body.method === "eth_call") {
      const data = String(body.params[0]?.data);
      callData.push(data);
      if (row === "transport-error") {
        envelope = { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "node unavailable" } };
      } else {
        const result = encodeFunctionResult({
          abi: EVM_HASH_RAIL_ABI,
          functionName: "locks",
          result: [row.payer, row.payee, TOKEN, 1_000_000n, 1_700_003_600_000n, 1_700_005_400_000n, row.status],
        });
        envelope = { jsonrpc: "2.0", id: body.id, result };
      }
    } else {
      envelope = { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `unexpected ${body.method}` } };
    }
    const text = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { rpc: new CapturingRpc({ endpoint: "http://mock-evm", fetch: fetchImpl }), methods, callData };
}

async function connect(rpc: CapturingRpc) {
  const adapter = createEvmCounterRail({ config, rpc, account: BUYER, clock: () => 1_700_000_000_000 });
  return adapter.connect(lockTerms(), { payee: SELLER, payer: BUYER });
}

describe("EVM prepareLock: no recovery handle", () => {
  it("returns just the hash lock as the ref (the lock is keyed by it) and no recovery", async () => {
    const { rpc } = node({ payer: BUYER, payee: SELLER, status: 0 });
    const prepared = await (await connect(rpc)).prepareLock(lockTerms(), 0);
    expect(prepared).toEqual({ ref: HASH_LOCK });
    expect("recovery" in prepared).toBe(false);
  });

  it("has no recoverRefund: its refund leaves no handle before the send (a repeated refund is read from the lock's own state)", async () => {
    const { rpc } = node({ payer: BUYER, payee: SELLER, status: 0 });
    const connected = await connect(rpc);
    expect(connected.recoverRefund).toBeUndefined();
  });
});

describe("EVM recoverLock", () => {
  it.each([
    [1, "Locked"],
    [2, "Claimed"],
    [3, "Refunded"],
  ])("a row owned by this account with status %i (%s) is landed", async (status) => {
    const { rpc, methods, callData } = node({ payer: BUYER, payee: SELLER, status });
    const connected = await connect(rpc);
    await expect(connected.recoverLock({ ref: HASH_LOCK })).resolves.toBe("landed");
    // exactly one read, and it is locks(hashLock); no write of any kind
    expect(callData).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: EVM_HASH_RAIL_ABI, data: callData[0] as Hex });
    expect(decoded.functionName).toBe("locks");
    expect(decoded.args).toEqual([HASH_LOCK]);
    expect(methods.filter((m) => m.startsWith("eth_send") || m === "personal_sign")).toEqual([]);
  });

  it("no row at all is never-landed in the weak EVM sense, and still no write is made", async () => {
    const { rpc, methods } = node({ payer: BUYER, payee: SELLER, status: 0 });
    const connected = await connect(rpc);
    await expect(connected.recoverLock({ ref: HASH_LOCK })).resolves.toBe("never-landed");
    expect(methods.filter((m) => m.startsWith("eth_send"))).toEqual([]);
  });

  it("a row owned by another payer is a lock-conflict (this party's lock can never land), not landed and not never-landed", async () => {
    const { rpc } = node({ payer: STRANGER, payee: SELLER, status: 1 });
    const connected = await connect(rpc);
    const error = await connected.recoverLock({ ref: HASH_LOCK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("lock-conflict");
    expect((error as Error).message).toContain(STRANGER);
  });

  it("an unknown status byte is an error, never folded into never-landed", async () => {
    const { rpc } = node({ payer: BUYER, payee: SELLER, status: 9 });
    const connected = await connect(rpc);
    await expect(connected.recoverLock({ ref: HASH_LOCK })).rejects.toThrow();
  });

  it("a transport failure is an error, never folded into never-landed", async () => {
    const { rpc } = node("transport-error");
    const connected = await connect(rpc);
    const error = await connected.recoverLock({ ref: HASH_LOCK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RailRecoveryRefusedError);
  });
});

describe("EvmHtlcRail.readLock", () => {
  it("decodes the row and reports null for status None", async () => {
    const present = node({ payer: BUYER, payee: SELLER, status: 1 });
    const rail = await EvmHtlcRail.connect({ config, rpc: present.rpc, account: BUYER, addressBook: { resolve: () => BUYER } });
    await expect(rail.readLock(HASH_LOCK)).resolves.toEqual({
      status: "Locked",
      payer: BUYER,
      payee: SELLER,
      token: TOKEN,
      amount: 1_000_000n,
      claimByMs: 1_700_003_600_000n,
      refundAfterMs: 1_700_005_400_000n,
    });
    const absent = node({ payer: BUYER, payee: SELLER, status: 0 });
    const rail2 = await EvmHtlcRail.connect({ config, rpc: absent.rpc, account: BUYER, addressBook: { resolve: () => BUYER } });
    await expect(rail2.readLock(HASH_LOCK)).resolves.toBeNull();
  });
});
