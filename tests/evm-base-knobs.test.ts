// SPDX-License-Identifier: MIT
//
// tests/evm-base-knobs.test.ts - P9-4 decisions 3, 5 and 8 (P9-4-DECISIONS-2026-10-07.md): the knobs a Base Sepolia (84532) config may not set loosely,
// checked by `checkEvmRailConfig` (so by `EvmHtlcRail.connect`, the runner's config check, `watch.mjs --rails` and `audit-export --rails` alike). Anvil (31337) is
// unchanged by every one of them, and a test of each says so.
//
//   3. finality on 84532 is the `finalized` tag with no `fallbackConfirmations`: confirmations mode and any fallback are refused, so the Buyer's permanent
//      never-locked verdict never rests on a fallback block there.
//   5. the fee ceiling of a local account defaults to 50 gwei on 84532 (1,000 gwei on anvil); a configured value below 1 gwei on 84532 is refused.
//   8. `receiptTimeoutMs` on 84532 lies between 10,000 and 3,600,000 ms (anvil: any positive integer up to a day, so the short timeout tests keep their values).

import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  ANVIL_LOCAL_PIN,
  BASE_SEPOLIA_DEFAULT_MAX_FEE_PER_GAS_WEI,
  BASE_SEPOLIA_MAX_RECEIPT_TIMEOUT_MS,
  BASE_SEPOLIA_MIN_MAX_FEE_PER_GAS_WEI,
  BASE_SEPOLIA_MIN_RECEIPT_TIMEOUT_MS,
  BASE_SEPOLIA_PIN,
  EVM_DEFAULT_MAX_FEE_PER_GAS_WEI,
  EvmHtlcRail,
  EvmSignerRefusedError,
  MAX_RECEIPT_TIMEOUT_MS,
  checkEvmRailConfig,
  effectiveMaxFeePerGasWei,
  validateEvmRailConfig,
  type EvmFinality,
  type EvmRailConfig,
} from "../src/rails/evm-htlc.js";
import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { localSigningRpc, makeLocalAccount } from "./helpers/evm-local.js";

const T0 = 1_790_000_000_000;
const clock = (): number => T0;
const RAIL = getAddress(`0x${Buffer.from("knob-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("knob-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const GWEI = 1_000_000_000n;
const CODE_HASH = `0x${"ab".repeat(32)}` as const;

/** A config for chain `chainId` with the given extras; Base Sepolia carries its required code hash. */
function configOn(chainId: 31337 | 84532, extra: Partial<EvmRailConfig> = {}, finality: EvmFinality = { mode: "tag", tag: "finalized" }): EvmRailConfig {
  const pin = chainId === 84532 ? BASE_SEPOLIA_PIN : ANVIL_LOCAL_PIN;
  return {
    pin: { ...pin, finality },
    endpoint: "http://mock-evm",
    contract: RAIL,
    assets: { USDC: TOKEN },
    ...(chainId === 84532 ? { contractCodeHash: CODE_HASH } : {}),
    ...extra,
  };
}

const reasonOf = (value: unknown): string | undefined => {
  const checked = checkEvmRailConfig(value);
  return checked.ok ? undefined : checked.reason;
};

describe("P9-4 decision 3: finality on Base Sepolia is the finalized tag, no fallback", () => {
  it("refuses confirmations mode on 84532 (by checkEvmRailConfig and by validateEvmRailConfig), naming the rule", () => {
    const config = configOn(84532, {}, { mode: "confirmations", confirmations: 12 });
    expect(reasonOf(config)).toMatch(/base-sepolia \(84532\) must pin finality to the finalized tag: confirmations mode is refused there/);
    expect(() => validateEvmRailConfig(config)).toThrow(/confirmations mode is refused there/);
  });

  it("refuses any fallbackConfirmations on 84532, the smallest and a large one alike", () => {
    for (const fallbackConfirmations of [1, 5, 200]) {
      const config = configOn(84532, {}, { mode: "tag", tag: "finalized", fallbackConfirmations });
      expect(reasonOf(config), `fallbackConfirmations ${fallbackConfirmations}`).toMatch(/must pin finality to the finalized tag with no fallbackConfirmations/);
    }
  });

  it("accepts the finalized tag with no fallback on 84532", () => {
    expect(reasonOf(configOn(84532))).toBeUndefined();
    expect(reasonOf(configOn(84532, {}, { mode: "tag", tag: "finalized" }))).toBeUndefined();
  });

  it("anvil keeps both modes: confirmations and a fallback are accepted there", () => {
    expect(reasonOf(configOn(31337, {}, { mode: "confirmations", confirmations: 3 }))).toBeUndefined();
    expect(reasonOf(configOn(31337, {}, { mode: "tag", tag: "finalized", fallbackConfirmations: 2 }))).toBeUndefined();
  });

  it("a malformed count keeps its own, more specific refusal (the shape check runs first)", () => {
    expect(reasonOf(configOn(84532, {}, { mode: "confirmations", confirmations: 0 }))).toMatch(/pin\.finality\.confirmations must be a positive integer/);
    expect(reasonOf(configOn(84532, {}, { mode: "tag", tag: "finalized", fallbackConfirmations: -1 }))).toMatch(/fallbackConfirmations must be a positive integer/);
  });

  it("connect() refuses a Base Sepolia pin with confirmations or a fallback before one request is made", async () => {
    for (const finality of [{ mode: "confirmations", confirmations: 12 }, { mode: "tag", tag: "finalized", fallbackConfirmations: 5 }] as EvmFinality[]) {
      const node = new EvmMockNode(clock, RAIL, TOKEN, []);
      node.chainId = 84532;
      const book: AddressBook = { resolve: () => getAddress("0x00000000000000000000000000000000000000b1") };
      await expect(
        EvmHtlcRail.connect({ config: { ...node.config(), pin: { ...BASE_SEPOLIA_PIN, finality } }, rpc: node.rpc(), account: getAddress("0x00000000000000000000000000000000000000b1"), addressBook: book, clock }),
      ).rejects.toThrow(/refusing to connect.*must pin finality to the finalized tag/);
      expect(node.requests, "nothing was read").toEqual([]);
    }
  });
});

describe("P9-4 decision 5 (rail part): the fee ceiling", () => {
  it("the constants: 50 gwei default and 1 gwei floor on Base Sepolia, 1,000 gwei on anvil", () => {
    expect(BASE_SEPOLIA_DEFAULT_MAX_FEE_PER_GAS_WEI).toBe(50n * GWEI);
    expect(BASE_SEPOLIA_MIN_MAX_FEE_PER_GAS_WEI).toBe(GWEI);
    expect(EVM_DEFAULT_MAX_FEE_PER_GAS_WEI).toBe(1_000n * GWEI);
  });

  it("omitted, the ceiling is 50 gwei on 84532 and 1,000 gwei on anvil; a configured value wins on both", () => {
    expect(effectiveMaxFeePerGasWei(configOn(84532))).toBe(50n * GWEI);
    expect(effectiveMaxFeePerGasWei(configOn(31337))).toBe(1_000n * GWEI);
    expect(effectiveMaxFeePerGasWei(configOn(84532, { maxFeePerGasWei: 2_000_000_000 }))).toBe(2n * GWEI);
    expect(effectiveMaxFeePerGasWei(configOn(84532, { maxFeePerGasWei: "75000000000" }))).toBe(75n * GWEI);
    expect(effectiveMaxFeePerGasWei(configOn(31337, { maxFeePerGasWei: 5_000_000_000 }))).toBe(5n * GWEI);
  });

  it("on 84532 a configured value below 1 gwei is refused (number or string), exactly 1 gwei is accepted", () => {
    for (const value of [1, 500_000_000, 999_999_999, "999999999", "1"]) {
      expect(reasonOf(configOn(84532, { maxFeePerGasWei: value })), `value ${String(value)}`).toMatch(/maxFeePerGasWei \d+ is below the 1000000000 wei \(1 gwei\) floor on base-sepolia \(84532\)/);
    }
    for (const value of [1_000_000_000, "1000000000", 50_000_000_000, "1000000000000"]) {
      expect(reasonOf(configOn(84532, { maxFeePerGasWei: value })), `value ${String(value)}`).toBeUndefined();
    }
  });

  it("anvil has no floor: a one-wei ceiling is still a valid (if useless) config there", () => {
    expect(reasonOf(configOn(31337, { maxFeePerGasWei: 1 }))).toBeUndefined();
    expect(reasonOf(configOn(31337, { maxFeePerGasWei: "999999999" }))).toBeUndefined();
  });

  const hexOf = (wei: bigint): string => `0x${wei.toString(16)}`;

  /** A local-account rail over a mock node of `chainId`, whose endpoint answers a priority fee of `tip`. */
  async function railWithTip(chainId: 31337 | 84532, tip: bigint, extra: Partial<EvmRailConfig> = {}) {
    const node = new EvmMockNode(clock, RAIL, TOKEN, []);
    node.chainId = chainId;
    node.configExtras = extra;
    const account = await makeLocalAccount();
    const wire = localSigningRpc(node, chainId);
    wire.answers.set("eth_maxPriorityFeePerGas", hexOf(tip));
    const book: AddressBook = { resolve: () => account.address as Address };
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account, addressBook: book, clock });
    return { node, wire, rail };
  }

  it("a local account on Base Sepolia refuses a 51 gwei fee by default (rule fee, limit 50 gwei) and sends nothing; 40 gwei signs", async () => {
    const high = await railWithTip(84532, 51n * GWEI);
    const error = await high.rail.approve("USDC", "5").then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmSignerRefusedError);
    expect((error as EvmSignerRefusedError).rule).toBe("fee");
    expect((error as EvmSignerRefusedError).limit).toBe("50000000000");
    expect(high.wire.rawSends).toEqual([]);

    const fine = await railWithTip(84532, 40n * GWEI);
    await fine.rail.approve("USDC", "5");
    expect(fine.wire.rawSends).toHaveLength(1);
  });

  it("anvil keeps 1,000 gwei: the same 51 gwei fee signs there", async () => {
    const anvil = await railWithTip(31337, 51n * GWEI);
    await anvil.rail.approve("USDC", "5");
    expect(anvil.wire.rawSends).toHaveLength(1);
  });

  it("a configured ceiling on Base Sepolia wins over the default: 80 gwei lets a 60 gwei fee through, 2 gwei refuses a 3 gwei one", async () => {
    const wide = await railWithTip(84532, 60n * GWEI, { maxFeePerGasWei: "80000000000" });
    await wide.rail.approve("USDC", "5");
    expect(wide.wire.rawSends).toHaveLength(1);
    const narrow = await railWithTip(84532, 3n * GWEI, { maxFeePerGasWei: 2_000_000_000 });
    const error = await narrow.rail.approve("USDC", "5").then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmSignerRefusedError);
    expect((error as EvmSignerRefusedError).limit).toBe("2000000000");
  });
});

describe("P9-4 decision 8: receiptTimeoutMs on Base Sepolia", () => {
  it("the constants: 10,000 ms floor, 3,600,000 ms cap (anvil's own cap is a day)", () => {
    expect(BASE_SEPOLIA_MIN_RECEIPT_TIMEOUT_MS).toBe(10_000);
    expect(BASE_SEPOLIA_MAX_RECEIPT_TIMEOUT_MS).toBe(3_600_000);
    expect(MAX_RECEIPT_TIMEOUT_MS).toBe(86_400_000);
  });

  it("84532: 9,999 and 3,600,001 are refused naming the range, 10,000 and 3,600,000 are accepted, omitted is accepted", () => {
    for (const value of [1, 150, 9_999, 3_600_001, 86_400_000]) {
      expect(reasonOf(configOn(84532, { receiptTimeoutMs: value })), `value ${value}`).toMatch(new RegExp(`receiptTimeoutMs ${value} is outside 10000 to 3600000 ms, the range allowed on base-sepolia \\(84532\\)`));
    }
    for (const value of [10_000, 180_000, 600_000, 3_600_000]) expect(reasonOf(configOn(84532, { receiptTimeoutMs: value })), `value ${value}`).toBeUndefined();
    expect(reasonOf(configOn(84532))).toBeUndefined();
  });

  it("anvil is unconstrained below the day: 1 ms and 150 ms (the short timeout tests) and a day are accepted; a day plus one is not", () => {
    for (const value of [1, 150, 9_999, 3_600_001, 86_400_000]) expect(reasonOf(configOn(31337, { receiptTimeoutMs: value })), `value ${value}`).toBeUndefined();
    expect(reasonOf(configOn(31337, { receiptTimeoutMs: 86_400_001 }))).toMatch(/receiptTimeoutMs must be a positive integer of at most 86400000/);
  });

  it("connect() on Base Sepolia refuses a 150 ms timeout before one request is made", async () => {
    const node = new EvmMockNode(clock, RAIL, TOKEN, []);
    node.chainId = 84532;
    node.configExtras = { receiptTimeoutMs: 150 };
    const book: AddressBook = { resolve: () => getAddress("0x00000000000000000000000000000000000000b1") };
    await expect(EvmHtlcRail.connect({ config: node.config(), rpc: node.rpc(), account: getAddress("0x00000000000000000000000000000000000000b1"), addressBook: book, clock })).rejects.toThrow(
      /refusing to connect.*receiptTimeoutMs 150 is outside 10000 to 3600000 ms/,
    );
    expect(node.requests).toEqual([]);
  });
});
