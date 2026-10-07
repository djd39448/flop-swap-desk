// SPDX-License-Identifier: MIT
//
// tests/evm-policy.test.ts - P9-4 decision 1 (P9-4-DECISIONS-2026-10-07.md; spec package P9-4, rule 3: the finality budget is set from the measured lag, not
// from anvil): the EVM deadline policy is selected by the PIN'S CHAIN ID on the rail object (`evmLocalPolicyFor`, read through `CounterAssetRail.policy`),
// never by a constructor option. 31337 keeps `EVM_LOCAL_POLICY` (the very same object); 84532 gets `BASE_SEPOLIA_POLICY`; any other chain id has no policy
// and the rail refuses at `connect()` with the typed `EvmPolicyUnavailableError`, before it reads or sends anything.
//
// The three Base Sepolia numbers come from the full 24-hour sample (handoff/research/base-sepolia-finality-2026-10-06.jsonl, read by a short script; the
// file lives outside this repository, so these tests pin the numbers it gave and do not read it): 288 samples, finalized lag minimum 868 s, median 1,156 s,
// p90 1,348 s, MAXIMUM 3,086 s; safe-head lag maximum 98 blocks; block time 2.0 s in every sample.

import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { createEvmCounterRail } from "../src/client/evm-rail.js";
import {
  BASE_SEPOLIA_POLICY,
  EVM_LOCAL_POLICY,
  EvmPolicyUnavailableError,
  evmLocalPolicyFor,
} from "../src/client/policy.js";
import { DEFAULT_POLICY_EXAMPLE } from "../src/deadlines.js";
import type { LockTerms } from "@flop-labs/tclk";
import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { keyScanner } from "./helpers/evm-local.js";
import { generatePrivateKey } from "viem/accounts";

const clock = (): number => 1_790_000_000_000;
const RAIL = getAddress(`0x${Buffer.from("policy-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("policy-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const ACCOUNT: Address = getAddress("0x00000000000000000000000000000000000000b1");

/** The sample's largest finalized lag (seconds) and the rule that turns it into the budget (spec P9-4: maximum x 1.5, rounded UP to 5 minutes). */
const SAMPLE_MAX_FINALIZED_LAG_S = 3_086;
const FIVE_MIN_S = 300;

function nodeOn(chainId: number): EvmMockNode {
  const node = new EvmMockNode(clock, RAIL, TOKEN, []);
  node.chainId = chainId;
  return node;
}

const TERMS: LockTerms = {
  lock: "hash",
  statement: `0x${"ab".repeat(32)}`,
  asset: "USDC",
  amount: "1000000",
  payer: "did:key:z6Mkpayer",
  payee: "did:key:z6Mkpayee",
  claimByMs: clock() + 60_000,
  refundAfterMs: clock() + 120_000,
} as unknown as LockTerms;

describe("P9-4 decision 1: BASE_SEPOLIA_POLICY's three numbers are pinned", () => {
  it("finalityAMs is 80 minutes: the sample's maximum finalized lag x 1.5, rounded UP to a multiple of 5 minutes", () => {
    const raw = SAMPLE_MAX_FINALIZED_LAG_S * 1.5; // 4,629 s
    const budgetS = Math.ceil(raw / FIVE_MIN_S) * FIVE_MIN_S;
    expect(raw).toBe(4_629);
    expect(budgetS).toBe(4_800);
    expect(BASE_SEPOLIA_POLICY.finalityAMs).toBe(budgetS * 1000);
    expect(BASE_SEPOLIA_POLICY.finalityAMs).toBe(4_800_000);
    expect(BASE_SEPOLIA_POLICY.finalityAMs).toBe(80 * 60_000);
    // it is a bound ABOVE the largest lag seen, by the whole 50 % margin and a little more
    expect(BASE_SEPOLIA_POLICY.finalityAMs).toBeGreaterThanOrEqual(SAMPLE_MAX_FINALIZED_LAG_S * 1.5 * 1000);
  });

  it("claimInclusionMarginMs is 10 minutes and minRevealWindowMs is 45 minutes", () => {
    expect(BASE_SEPOLIA_POLICY.claimInclusionMarginMs).toBe(10 * 60_000);
    expect(BASE_SEPOLIA_POLICY.claimInclusionMarginMs).toBe(600_000);
    expect(BASE_SEPOLIA_POLICY.minRevealWindowMs).toBe(45 * 60_000);
    expect(BASE_SEPOLIA_POLICY.minRevealWindowMs).toBe(2_700_000);
  });

  it("the block time is the sample's 2.0 s, and the FLOP-side R10.2 knobs are the example's (a FLOP rule, not an EVM one)", () => {
    expect(BASE_SEPOLIA_POLICY.blockTimeMs).toBe(2_000);
    expect(BASE_SEPOLIA_POLICY.flopMarginPercent).toBe(DEFAULT_POLICY_EXAMPLE.flopMarginPercent);
    expect(BASE_SEPOLIA_POLICY.flopMaxFinalityStallBlocks).toBe(DEFAULT_POLICY_EXAMPLE.flopMaxFinalityStallBlocks);
    expect(BASE_SEPOLIA_POLICY.flopFinalityLagBlocks).toBe(DEFAULT_POLICY_EXAMPLE.flopFinalityLagBlocks);
    expect(BASE_SEPOLIA_POLICY.flopBlockMs).toBe(DEFAULT_POLICY_EXAMPLE.flopBlockMs);
  });

  it("is frozen, and every other policy is untouched: anvil keeps 20 minutes of finality, a 5-minute claim margin and a 1-second block", () => {
    expect(Object.isFrozen(BASE_SEPOLIA_POLICY)).toBe(true);
    expect(Object.isFrozen(EVM_LOCAL_POLICY)).toBe(true);
    expect(EVM_LOCAL_POLICY.finalityAMs).toBe(20 * 60_000);
    expect(EVM_LOCAL_POLICY.claimInclusionMarginMs).toBe(5 * 60_000);
    expect(EVM_LOCAL_POLICY.minRevealWindowMs).toBe(45 * 60_000);
    expect(EVM_LOCAL_POLICY.blockTimeMs).toBe(1_000);
  });
});

describe("P9-4 decision 1: the policy is selected by the pin's chain id", () => {
  it("evmLocalPolicyFor: 31337 is EVM_LOCAL_POLICY (the same object), 84532 is BASE_SEPOLIA_POLICY (the same object)", () => {
    expect(evmLocalPolicyFor(31337)).toBe(EVM_LOCAL_POLICY);
    expect(evmLocalPolicyFor(84532)).toBe(BASE_SEPOLIA_POLICY);
  });

  it.each([1, 8453, 10, 5, 11155111, 0, -1, 31338, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("evmLocalPolicyFor(%p) has no policy: the typed error", (chainId) => {
    expect(() => evmLocalPolicyFor(chainId)).toThrow(EvmPolicyUnavailableError);
  });

  it("the rail object's `policy` follows the pin: anvil keeps the anvil policy, Base Sepolia gets its own", () => {
    const anvil = nodeOn(31337);
    const sepolia = nodeOn(84532);
    expect(createEvmCounterRail({ config: anvil.config(), rpc: anvil.rpc(), account: ACCOUNT, clock }).policy).toBe(EVM_LOCAL_POLICY);
    expect(createEvmCounterRail({ config: sepolia.config(), rpc: sepolia.rpc(), account: ACCOUNT, clock }).policy).toBe(BASE_SEPOLIA_POLICY);
  });

  it("is never a constructor option: a `policy` handed to the factory is ignored, on either chain", () => {
    const anvil = nodeOn(31337);
    const sepolia = nodeOn(84532);
    const slack = { ...BASE_SEPOLIA_POLICY, finalityAMs: 1, claimInclusionMarginMs: 1 };
    const onSepolia = createEvmCounterRail({ config: sepolia.config(), rpc: sepolia.rpc(), account: ACCOUNT, clock, policy: slack } as never);
    expect(onSepolia.policy).toBe(BASE_SEPOLIA_POLICY);
    expect(onSepolia.policy.finalityAMs).toBe(4_800_000);
    const onAnvil = createEvmCounterRail({ config: anvil.config(), rpc: anvil.rpc(), account: ACCOUNT, clock, policy: BASE_SEPOLIA_POLICY } as never);
    expect(onAnvil.policy).toBe(EVM_LOCAL_POLICY);
  });

  /** A rail pinned to a chain no policy exists for: the config the rail's own allow list would also refuse. */
  function railOnUnlistedChain(chainId: number, node: EvmMockNode) {
    const config = {
      pin: { chainId, name: "elsewhere", caip2: `eip155:${chainId}`, finality: { mode: "tag", tag: "finalized" } },
      endpoint: "http://mock-evm",
      contract: RAIL,
      assets: { USDC: TOKEN },
    } as unknown as EvmRailConfig;
    return createEvmCounterRail({ config, rpc: node.rpc(), account: ACCOUNT, clock });
  }

  it.each([1, 8453, 5, 31338])("any other EVM chain id (%i): `connect()` refuses with the typed error before one request is made, and `policy` throws it too", async (chainId) => {
    const node = nodeOn(chainId);
    const rail = railOnUnlistedChain(chainId, node);
    expect(() => rail.policy).toThrow(EvmPolicyUnavailableError);
    const refused = await rail.connect(TERMS, {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(EvmPolicyUnavailableError);
    expect((refused as EvmPolicyUnavailableError).chainId).toBe(chainId);
    expect((refused as Error).message).toContain(`chain id ${chainId}`);
    expect(node.requests, "nothing was read or sent").toEqual([]);
  });

  it("the typed error shows only a whole number: a chain id that is really text (a key pasted into the wrong place) is never echoed", () => {
    const key = generatePrivateKey();
    const scan = keyScanner(key);
    const error = new EvmPolicyUnavailableError(key as unknown as number);
    expect(scan(error.message)).toBe(false);
    expect(scan(String(error.stack))).toBe(false);
    expect(Number.isNaN(error.chainId)).toBe(true);
    expect(error.message).toContain("(not an integer)");
  });

  it("the pins this build ships map to the policies by their chain ids", () => {
    expect(evmLocalPolicyFor(ANVIL_LOCAL_PIN.chainId)).toBe(EVM_LOCAL_POLICY);
    expect(evmLocalPolicyFor(BASE_SEPOLIA_PIN.chainId)).toBe(BASE_SEPOLIA_POLICY);
  });
});
