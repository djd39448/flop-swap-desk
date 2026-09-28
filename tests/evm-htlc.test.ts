// SPDX-License-Identifier: MIT
//
// tests/evm-htlc.test.ts — P22-P24-EVM-SPEC.md §2.3: EvmHtlcRail exercised end to end against
// a mocked EIP-1193 transport (the pattern in tests/vendor-evm-hash-rail.test.ts), but through
// this repo's own CapturingRpc (a mocked `fetch`, not a bare provider stub) so the adapter's
// capture/replay wiring is exercised the same way production code drives it. Covers the parts
// of §2.2 unique to the adapter (connect()'s chain-pin/deny-list/asset-book checks, feeBps
// refusal, bounded eth_getLogs write evidence, findClaimedPreimage) plus a representative slice
// of the finalized-view branches through `verifyLockFinal` end to end — the exhaustive
// field-by-field matrix lives in tests/evm-evidence.test.ts against the pure decoder directly.

import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import type { LockTerms } from "@flop-labs/tclk";
import { generateHashLock } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { EVM_HASH_RAIL_ABI, type AddressBook } from "../src/vendor/evm-hash-rail.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import {
  ANVIL_LOCAL_PIN,
  BASE_MAINNET_USDC,
  BASE_SEPOLIA_PIN,
  EvmHtlcRail,
  validateEvmRailConfig,
  type EvmChainPin,
  type EvmRailConfig,
} from "../src/rails/evm-htlc.js";

function addr(tag: string): Address {
  const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
  return getAddress(`0x${hex}`);
}

const RAIL_CONTRACT = addr("rail-contract");
const TOKEN = addr("usdc-token");
const PAYER = addr("payer-account");
const PAYEE = addr("payee-account");
const BLOCK_HASH = ("0x" + "cd".repeat(32)) as Hex;
const FALLBACK_HASH = ("0x" + "ef".repeat(32)) as Hex;
const TX_HASH = ("0x" + "aa".repeat(32)) as Hex;

const LOCKED_EVENT = {
  type: "event",
  name: "Locked",
  inputs: [
    { name: "hashLock", type: "bytes32", indexed: true },
    { name: "payer", type: "address", indexed: true },
    { name: "payee", type: "address", indexed: true },
    { name: "token", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "claimByMs", type: "uint256", indexed: false },
    { name: "refundAfterMs", type: "uint256", indexed: false },
  ],
} as const;
const CLAIMED_EVENT = {
  type: "event",
  name: "Claimed",
  inputs: [
    { name: "hashLock", type: "bytes32", indexed: true },
    { name: "preimage", type: "bytes32", indexed: false },
  ],
} as const;
const REFUNDED_EVENT = {
  type: "event",
  name: "Refunded",
  inputs: [{ name: "hashLock", type: "bytes32", indexed: true }],
} as const;

function buildLog(
  eventAbi: typeof LOCKED_EVENT | typeof CLAIMED_EVENT | typeof REFUNDED_EVENT,
  args: Record<string, unknown>,
  meta: { blockNumber: string; blockHash: Hex; txHash: Hex; logIndex: string },
) {
  const topics = encodeEventTopics({ abi: [eventAbi], eventName: eventAbi.name, args } as never);
  const nonIndexed = eventAbi.inputs.filter((input) => !input.indexed);
  const data =
    nonIndexed.length === 0
      ? ("0x" as Hex)
      : encodeAbiParameters(
          nonIndexed as readonly { name: string; type: string }[],
          nonIndexed.map((input) => args[input.name]),
        );
  return {
    address: RAIL_CONTRACT,
    topics,
    data,
    blockNumber: meta.blockNumber,
    blockHash: meta.blockHash,
    transactionHash: meta.txHash,
    transactionIndex: "0x0",
    logIndex: meta.logIndex,
    removed: false,
  };
}

type Responder = (params: readonly unknown[]) => { result?: unknown; error?: { code: number; message: string } };

function mockCapturingRpc(handlers: Record<string, Responder>): { rpc: CapturingRpc; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (handler === undefined) throw new Error(`mock rpc: unexpected method ${body.method}`);
    const response = handler(body.params);
    const envelope =
      response.error !== undefined
        ? { jsonrpc: "2.0", id: body.id, error: response.error }
        : { jsonrpc: "2.0", id: body.id, result: response.result };
    return { text: async () => JSON.stringify(envelope) } as Response;
  }) as typeof fetch;
  const rpc = new CapturingRpc({ endpoint: "http://mock-anvil", fetch: fetchImpl, clock: () => 1_700_000_500_000 });
  return { rpc, calls };
}

const ADDRESS_BOOK: AddressBook = {
  resolve: (did) => (did === TERMS.payee ? PAYEE : PAYER),
};

const HASH_LOCK = generateHashLock();

/** Well before TERMS.refundAfterMs, so the vendored rail's own local-time guard never trips
 *  (its `clock` defaults to `Date.now()`, which is long past this fixture's 2023 deadlines). */
const NOW = () => 1_700_000_500_000;

const TERMS: LockTerms = {
  contract: "0x" + "11".repeat(32),
  lock: "hash",
  statement: HASH_LOCK.hash,
  amount: "1000000",
  asset: "USDC",
  payer: "did:key:zPayer",
  payee: "did:key:zPayee",
  claimByMs: 1_700_000_000_000,
  refundAfterMs: 1_700_003_600_000,
};

function configFor(pin: EvmChainPin): EvmRailConfig {
  return { pin, endpoint: "http://mock-anvil", contract: RAIL_CONTRACT, assets: { USDC: TOKEN } };
}

describe("validateEvmRailConfig / connect — chain pin and asset book", () => {
  it("refuses a deny-listed chain id in the pin itself, by name, before ever touching the network", async () => {
    const config: EvmRailConfig = configFor({ chainId: 8453, name: "base-mainnet-oops", caip2: "eip155:8453", finality: { mode: "tag", tag: "finalized" } });
    const { rpc } = mockCapturingRpc({
      // No handlers at all: if connect() ever called the network, this would throw and fail
      // the test with a different message than the one we assert on.
    });
    await expect(EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(
      /deny-listed as base mainnet/,
    );
  });

  it("refuses when the live chain id differs from the pin (BASE_SEPOLIA_PIN against a 31337 node)", async () => {
    const config = configFor(BASE_SEPOLIA_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }) });
    await expect(EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(
      /connected chain id 31337 does not match pin "base-sepolia"/,
    );
  });

  it("names the deny-listed chain when the LIVE chain id (not the pin) turns out to be denied", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x2105" }) }); // 8453 = base mainnet
    await expect(EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(
      /8453 is deny-listed as base mainnet/,
    );
  });

  it("connects when the live chain id matches the pin", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }) });
    await expect(EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW })).resolves.toBeInstanceOf(
      EvmHtlcRail,
    );
  });

  it("refuses Base mainnet USDC anywhere in the asset book (D-09), even on an otherwise-fine pin", () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    config.assets.USDC = BASE_MAINNET_USDC;
    expect(() => validateEvmRailConfig(config)).toThrow(/Base mainnet USDC/);
  });

  it("rejects a non-positive-integer confirmations count", () => {
    const config = configFor({ chainId: 31337, name: "anvil-local", caip2: "eip155:31337", finality: { mode: "confirmations", confirmations: 0 } });
    expect(() => validateEvmRailConfig(config)).toThrow(/confirmations must be a positive integer/);
  });

  it("rejects a non-positive-integer fallbackConfirmations", () => {
    const config = configFor({ chainId: 31337, name: "anvil-local", caip2: "eip155:31337", finality: { mode: "tag", tag: "finalized", fallbackConfirmations: -1 } });
    expect(() => validateEvmRailConfig(config)).toThrow(/fallbackConfirmations must be a positive integer/);
  });
});

describe("EvmHtlcRail.lock — feeBps and lock-kind refusal", () => {
  it("refuses a declared feeBps other than 0 without ever touching the network", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }) });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.lock(TERMS, 25)).rejects.toThrow(/declared feeBps must be 0/);
  });

  it("refuses terms.lock !== 'hash'", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }) });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.lock({ ...TERMS, lock: "point" }, 0)).rejects.toThrow(/only hash locks/);
  });
});

describe("EvmHtlcRail write path — bounded eth_getLogs -> WriteEvidence", () => {
  function lockHandlers(logs: unknown[]) {
    return {
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_blockNumber: () => ({ result: "0x5" }),
      eth_sendTransaction: () => ({ result: TX_HASH }),
      eth_getTransactionReceipt: () => ({
        result: {
          status: "0x1",
          transactionHash: TX_HASH,
          blockHash: BLOCK_HASH,
          blockNumber: "0x6",
          transactionIndex: "0x0",
          from: PAYER,
          to: RAIL_CONTRACT,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          type: "0x2",
        },
      }),
      eth_getLogs: () => ({ result: logs }),
    };
  }

  it("happy path: exactly one Locked log -> WriteEvidence with matching identity and raw sha256s", async () => {
    const log = buildLog(
      LOCKED_EVENT,
      {
        hashLock: TERMS.statement,
        payer: PAYER,
        payee: PAYEE,
        token: TOKEN,
        amount: BigInt(TERMS.amount),
        claimByMs: BigInt(TERMS.claimByMs),
        refundAfterMs: BigInt(TERMS.refundAfterMs),
      },
      { blockNumber: "0x6", blockHash: BLOCK_HASH, txHash: TX_HASH, logIndex: "0x0" },
    );
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc(lockHandlers([log]));
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });

    const evidence = await rail.lock(TERMS, 0);

    expect(evidence.event).toBe("Locked");
    expect(evidence.ref).toBe(TERMS.statement);
    expect(evidence.txHash).toBe(TX_HASH);
    expect(evidence.blockHash).toBe(BLOCK_HASH);
    expect(evidence.blockNumber).toBe(6n);
    expect(evidence.logIndex).toBe(0);
    expect(evidence.raw.length).toBeGreaterThan(0);
  });

  it("zero matching logs -> throws rather than guessing", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc(lockHandlers([]));
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.lock(TERMS, 0)).rejects.toThrow(/expected exactly one Locked log/);
  });

  it("several matching logs -> throws rather than guessing", async () => {
    const log = buildLog(
      LOCKED_EVENT,
      {
        hashLock: TERMS.statement,
        payer: PAYER,
        payee: PAYEE,
        token: TOKEN,
        amount: BigInt(TERMS.amount),
        claimByMs: BigInt(TERMS.claimByMs),
        refundAfterMs: BigInt(TERMS.refundAfterMs),
      },
      { blockNumber: "0x6", blockHash: BLOCK_HASH, txHash: TX_HASH, logIndex: "0x0" },
    );
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc(lockHandlers([log, log]));
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.lock(TERMS, 0)).rejects.toThrow(/found 2/);
  });

  it("claim() resolves against the Claimed event", async () => {
    const secret = ("0x" + "cd".repeat(32)) as Hex;
    const log = buildLog(
      CLAIMED_EVENT,
      { hashLock: TERMS.statement, preimage: secret },
      { blockNumber: "0x7", blockHash: BLOCK_HASH, txHash: TX_HASH, logIndex: "0x0" },
    );
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc(lockHandlers([log]));
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.claim(TERMS.statement as Hex, secret);
    expect(evidence.event).toBe("Claimed");
  });

  it("refund() resolves against the Refunded event", async () => {
    const log = buildLog(
      REFUNDED_EVENT,
      { hashLock: TERMS.statement },
      { blockNumber: "0x9", blockHash: BLOCK_HASH, txHash: TX_HASH, logIndex: "0x0" },
    );
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc(lockHandlers([log]));
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.refund(TERMS.statement as Hex);
    expect(evidence.event).toBe("Refunded");
  });
});

describe("EvmHtlcRail.approve", () => {
  it("checks the receipt and returns the tx hash plus raw sha256s", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_sendTransaction: () => ({ result: TX_HASH }),
      eth_getTransactionReceipt: () => ({
        result: {
          status: "0x1",
          transactionHash: TX_HASH,
          blockHash: BLOCK_HASH,
          blockNumber: "0x2",
          transactionIndex: "0x0",
          from: PAYER,
          to: TOKEN,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          type: "0x2",
        },
      }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const result = await rail.approve("USDC", "1000000");
    expect(result.txHash).toBe(TX_HASH);
    expect(result.raw.length).toBeGreaterThan(0);
  });

  it("rejects an approve whose receipt reverted on-chain", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_sendTransaction: () => ({ result: TX_HASH }),
      eth_getTransactionReceipt: () => ({
        result: {
          status: "0x0",
          transactionHash: TX_HASH,
          blockHash: BLOCK_HASH,
          blockNumber: "0x2",
          transactionIndex: "0x0",
          from: PAYER,
          to: TOKEN,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          type: "0x2",
        },
      }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.approve("USDC", "1000000")).rejects.toThrow(/mined but reverted/);
  });

  it("refuses an asset with no configured token address", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }) });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.approve("NOPE", "1")).rejects.toThrow(/no configured token address/);
  });
});

describe("EvmHtlcRail.verifyLockFinal — representative finalized-view branches end to end", () => {
  function locksResult(status: number, overrides: Partial<{ payer: Address; payee: Address; token: Address; amount: bigint; claimByMs: bigint; refundAfterMs: bigint }> = {}) {
    return encodeFunctionResult({
      abi: EVM_HASH_RAIL_ABI,
      functionName: "locks",
      result: [
        overrides.payer ?? PAYER,
        overrides.payee ?? PAYEE,
        overrides.token ?? TOKEN,
        overrides.amount ?? BigInt(TERMS.amount),
        overrides.claimByMs ?? BigInt(TERMS.claimByMs),
        overrides.refundAfterMs ?? BigInt(TERMS.refundAfterMs),
        status,
      ],
    });
  }

  it("locked, all fields match -> railVerified true, rail locked/final", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: locksResult(1) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE, payer: PAYER });
    expect(evidence.lock.railVerified).toBe(true);
    expect(evidence.rail).toEqual({ status: "locked", final: true, checkedAtMs: expect.any(Number), finalizedRef: `anvil-local:finalized:5:${BLOCK_HASH}` });
  });

  it("status None -> railVerified null", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: locksResult(0) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE });
    expect(evidence.lock.railVerified).toBeNull();
    expect(evidence.rail).toBeUndefined();
  });

  it("status Claimed -> railVerified false, rail claimed/final", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: locksResult(2) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE });
    expect(evidence.lock.railVerified).toBe(false);
    expect(evidence.rail?.status).toBe("claimed");
  });

  it("status Refunded -> railVerified false, rail refunded/final", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: locksResult(3) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE });
    expect(evidence.lock.railVerified).toBe(false);
    expect(evidence.rail?.status).toBe("refunded");
  });

  it("a mismatching field (amount) -> railVerified false, rail still reported", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: locksResult(1, { amount: 1n }) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE, payer: PAYER });
    expect(evidence.lock.railVerified).toBe(false);
    expect(evidence.lock.reason).toMatch(/amount differs/);
  });

  it("payer unbound -> still true, reason notes it", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: locksResult(1) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE });
    expect(evidence.lock.railVerified).toBe(true);
    expect(evidence.lock.reason).toMatch(/payer unbound/);
  });

  it("casing-insensitive address compare: on-chain payee in lowercase still matches a checksummed account line", async () => {
    const lowerPayee = PAYEE.toLowerCase() as Address;
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: locksResult(1, { payee: lowerPayee }) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE, payer: PAYER });
    expect(evidence.lock.railVerified).toBe(true);
  });

  it("fallback path: the finalized tag is rejected, fallbackConfirmations configured -> true, confirmations-N finalizedRef", async () => {
    const config = configFor({ ...ANVIL_LOCAL_PIN, finality: { mode: "tag", tag: "finalized", fallbackConfirmations: 2 } });
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: (params) =>
        params[0] === "finalized"
          ? { error: { code: -32601, message: "unsupported block tag" } }
          : { result: { number: "0x7", hash: FALLBACK_HASH } },
      eth_blockNumber: () => ({ result: "0x9" }),
      eth_call: () => ({ result: locksResult(1) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE, payer: PAYER });
    expect(evidence.lock.railVerified).toBe(true);
    expect(evidence.lock.finalizedRef).toBe(`anvil-local:confirmations-2:7:${FALLBACK_HASH}`);
  });

  it("fail-closed without a fallback: the finalized tag is rejected and no fallbackConfirmations is configured -> null", async () => {
    const config = configFor(ANVIL_LOCAL_PIN); // no fallbackConfirmations
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ error: { code: -32601, message: "unsupported block tag" } }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE, payer: PAYER });
    expect(evidence.lock.railVerified).toBeNull();
    expect(evidence.lock.reason).toMatch(/no fallbackConfirmations is configured/);
  });
});

describe("EvmHtlcRail.findClaimedPreimage", () => {
  it("returns the preimage from a Claimed log that actually opens the hashLock", async () => {
    const log = buildLog(
      CLAIMED_EVENT,
      { hashLock: HASH_LOCK.hash, preimage: HASH_LOCK.preimage },
      { blockNumber: "0x7", blockHash: BLOCK_HASH, txHash: TX_HASH, logIndex: "0x0" },
    );
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }), eth_getLogs: () => ({ result: [log] }) });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });

    const found = await rail.findClaimedPreimage(HASH_LOCK.hash as Hex, 0n);
    expect(found).toBe(HASH_LOCK.preimage);
  });

  it("rejects a non-opening preimage rather than trusting the log's shape", async () => {
    const wrongPreimage = ("0x" + "00".repeat(32)) as Hex;
    const log = buildLog(
      CLAIMED_EVENT,
      { hashLock: HASH_LOCK.hash, preimage: wrongPreimage },
      { blockNumber: "0x7", blockHash: BLOCK_HASH, txHash: TX_HASH, logIndex: "0x0" },
    );
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }), eth_getLogs: () => ({ result: [log] }) });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });

    const found = await rail.findClaimedPreimage(HASH_LOCK.hash as Hex, 0n);
    expect(found).toBeNull();
  });

  it("returns null when there is no Claimed log at all", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }), eth_getLogs: () => ({ result: [] }) });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.findClaimedPreimage(HASH_LOCK.hash as Hex, 0n)).resolves.toBeNull();
  });
});
