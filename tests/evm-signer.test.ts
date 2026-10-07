// SPDX-License-Identifier: MIT
//
// tests/evm-signer.test.ts - P9 fix pass, R1-FUND-02 (src/rails/evm-signer.ts): what a LOCAL account may sign.
//
// Review round 1 proved that viem signs whatever chain id, gas limit and fee caps the endpoint's `eth_fillTransaction` answer carries
// (an endpoint that said 31337 to `eth_chainId` could still fill chain 8453 and 10,000 gwei, and the raw bytes were sent). The fix is
// two refusals, pinned here:
//   - the account viem signs with is a guarded, still sealed wrapper whose `signTransaction` refuses (typed `EvmSignerRefusedError`,
//     no transaction field in it) a chain id other than the pin's, a gas limit above `EVM_MAX_GAS_PER_WRITE`, and a fee cap above
//     `EvmRailConfig.maxFeePerGasWei` (default 1,000 gwei) or missing;
//   - the wallet client's transport answers `eth_fillTransaction` itself with method-not-found, so the chain id is the pinned one.
// Keys are generated at test time (tests/helpers/evm-local.ts); none is a literal and none is ever printed.

import { generateHashLock } from "@flop-labs/tclk";
import type { LockTerms } from "@flop-labs/tclk";
import { createWalletClient, custom, getAddress, recoverTransactionAddress, type Address, type Chain, type Hex } from "viem";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  EVM_DEFAULT_MAX_FEE_PER_GAS_WEI,
  EVM_MAX_GAS_PER_WRITE,
  EvmHtlcRail,
  EvmSignerRefusedError,
  checkEvmRailConfig,
  effectiveMaxFeePerGasWei,
} from "../src/rails/evm-htlc.js";
import { guardEstimateFeesPerGas, guardLocalAccount, refuseFillTransaction, signingRefusal, type EvmSignerWatch, type EvmSigningLimits } from "../src/rails/evm-signer.js";
import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { localSigningRpc, makeLocalAccount, makeLocalAccountWithScan } from "./helpers/evm-local.js";

const T0 = 1_700_000_000_000;
const RAIL = getAddress(`0x${Buffer.from("sg-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("sg-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const GWEI = 1_000_000_000n;
const LIMITS: EvmSigningLimits = { chainId: 31337, maxGas: EVM_MAX_GAS_PER_WRITE, maxFeePerGas: EVM_DEFAULT_MAX_FEE_PER_GAS_WEI };
const CHAIN: Chain = { id: 31337, name: "anvil-local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } };

function rig(): { node: EvmMockNode; clock: () => number } {
  const clock = (): number => T0;
  return { node: new EvmMockNode(clock, RAIL, TOKEN, []), clock };
}

const bookFor = (payer: Address, payee: Address): AddressBook => ({ resolve: (did) => (did === "did:key:zPayee" ? payee : payer) });

function termsFor(hash: string): LockTerms {
  return {
    contract: `0x${"11".repeat(32)}`,
    lock: "hash",
    statement: hash,
    amount: "1000000",
    asset: "USDC",
    payer: "did:key:zPayer",
    payee: "did:key:zPayee",
    claimByMs: T0 + 60 * 60_000,
    refundAfterMs: T0 + 90 * 60_000,
  };
}

/** A transaction the guard accepts (an EIP-1559 approve-sized one); tests spread over it. */
const SOUND = {
  type: "eip1559" as const,
  chainId: 31337,
  nonce: 0,
  to: TOKEN,
  value: 0n,
  data: "0x095ea7b3" as Hex,
  gas: 100_000n,
  maxFeePerGas: 2n * GWEI,
  maxPriorityFeePerGas: 1n * GWEI,
};

describe("R1-FUND-02 signingRefusal: the three rules, at their edges", () => {
  it("a sound transaction is not refused; exactly at the gas ceiling and at the fee ceiling is not refused", () => {
    expect(signingRefusal(SOUND, LIMITS)).toBeUndefined();
    expect(signingRefusal({ ...SOUND, gas: EVM_MAX_GAS_PER_WRITE }, LIMITS)).toBeUndefined();
    expect(signingRefusal({ ...SOUND, maxFeePerGas: LIMITS.maxFeePerGas, maxPriorityFeePerGas: LIMITS.maxFeePerGas }, LIMITS)).toBeUndefined();
    const legacy = { type: "legacy" as const, chainId: 31337, nonce: 0, to: TOKEN, value: 0n, data: "0x" as Hex, gas: 100_000n, gasPrice: LIMITS.maxFeePerGas };
    expect(signingRefusal(legacy, LIMITS)).toBeUndefined();
  });

  it("the ceilings are the ones the fix names: 500,000 gas and 1,000 gwei", () => {
    expect(EVM_MAX_GAS_PER_WRITE).toBe(500_000n);
    expect(EVM_DEFAULT_MAX_FEE_PER_GAS_WEI).toBe(1_000_000_000_000n);
  });

  it.each([[8453], [1], [84532], [0]])("chain id %i is refused when the pin is 31337 (rule chain-id)", (chainId) => {
    const refused = signingRefusal({ ...SOUND, chainId }, LIMITS);
    expect(refused).toBeInstanceOf(EvmSignerRefusedError);
    expect(refused?.rule).toBe("chain-id");
    expect(refused?.limit).toBe("31337");
  });

  it("a missing or non-numeric chain id is refused too (the pin cannot be inferred)", () => {
    const { chainId: _dropped, ...without } = SOUND;
    expect(signingRefusal(without, LIMITS)?.rule).toBe("chain-id");
    expect(signingRefusal({ ...SOUND, chainId: "31337" }, LIMITS)?.rule).toBe("chain-id");
    expect(signingRefusal(undefined, LIMITS)?.rule).toBe("chain-id");
  });

  it("a gas limit one above the ceiling is refused (rule gas); a missing one is refused too", () => {
    expect(signingRefusal({ ...SOUND, gas: EVM_MAX_GAS_PER_WRITE + 1n }, LIMITS)?.rule).toBe("gas");
    expect(signingRefusal({ ...SOUND, gas: 10n ** 12n }, LIMITS)?.rule).toBe("gas");
    const { gas: _dropped, ...without } = SOUND;
    expect(signingRefusal(without, LIMITS)?.rule).toBe("gas");
  });

  it("a fee cap one wei above the ceiling is refused, whichever field carries it (rule fee)", () => {
    const over = LIMITS.maxFeePerGas + 1n;
    expect(signingRefusal({ ...SOUND, maxFeePerGas: over }, LIMITS)?.rule).toBe("fee");
    expect(signingRefusal({ ...SOUND, maxPriorityFeePerGas: over }, LIMITS)?.rule).toBe("fee");
    expect(signingRefusal({ type: "legacy", chainId: 31337, gas: 100_000n, gasPrice: over }, LIMITS)?.rule).toBe("fee");
    expect(signingRefusal({ ...SOUND, maxFeePerGas: 10_000n * GWEI, maxPriorityFeePerGas: 10_000n * GWEI }, LIMITS)?.rule).toBe("fee");
  });

  it("no fee cap at all is refused (a transaction must name maxFeePerGas or gasPrice); a non-numeric one is refused", () => {
    const { maxFeePerGas: _a, maxPriorityFeePerGas: _b, ...without } = SOUND;
    expect(signingRefusal(without, LIMITS)?.rule).toBe("fee");
    expect(signingRefusal({ ...SOUND, maxFeePerGas: "0x1" }, LIMITS)?.rule).toBe("fee");
    expect(signingRefusal({ ...SOUND, maxFeePerGas: null }, LIMITS)?.rule).toBe("fee");
  });

  it("the chain id is judged first, then the gas, then the fees", () => {
    expect(signingRefusal({ ...SOUND, chainId: 8453, gas: 10n ** 9n, maxFeePerGas: 10n ** 18n }, LIMITS)?.rule).toBe("chain-id");
    expect(signingRefusal({ ...SOUND, gas: 10n ** 9n, maxFeePerGas: 10n ** 18n }, LIMITS)?.rule).toBe("gas");
  });

  it("the refusal carries no transaction field: not the data, the gas, the fee or the attempted chain id", () => {
    const tx = { ...SOUND, chainId: 8453, gas: 777_777n, maxFeePerGas: 123_456_789_012_345n, data: `0x${"de".repeat(32)}` as Hex };
    const refused = signingRefusal(tx, LIMITS) as EvmSignerRefusedError;
    const everything = [
      refused.message,
      refused.shortMessage,
      refused.stack ?? "",
      JSON.stringify(refused, Object.getOwnPropertyNames(refused)),
      inspect(refused, { showHidden: true, depth: 6 }),
    ].join("\n");
    for (const field of ["dededede", "777777", "123456789012345", "8453"]) expect(everything.includes(field), field).toBe(false);
    expect(Object.keys(refused).sort()).toEqual(["limit", "name", "rule", "shortMessage"]);
  });
});

describe("R1-FUND-02 maxFeePerGasWei: an optional, validated, positive integer-like config field", () => {
  const base = { pin: { chainId: 31337, name: "anvil-local", caip2: "eip155:31337", finality: { mode: "tag", tag: "finalized" } }, endpoint: "http://mock-evm", contract: RAIL, assets: { USDC: TOKEN } };

  it.each([[1], [5_000_000_000], [1_000_000_000_000], ["1"], ["1000000000000"], ["340282366920938463463374607431768211455"]])("%s is accepted", (value) => {
    expect(checkEvmRailConfig({ ...base, maxFeePerGasWei: value }).ok).toBe(true);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [1e30], ["0"], ["01"], ["-5"], ["1.5"], ["0x10"], [""], ["1".repeat(41)], [null], [true], [1n]])(
    "case %# (%s) is refused by field name",
    (value) => {
      const check = checkEvmRailConfig({ ...base, maxFeePerGasWei: value });
      expect(check.ok).toBe(false);
      expect(!check.ok && check.reason).toMatch(/maxFeePerGasWei must be a positive integer/);
    },
  );

  it("omitted, the ceiling is 1,000 gwei; a configured number or string wins", () => {
    const config = base as unknown as Parameters<typeof effectiveMaxFeePerGasWei>[0];
    expect(effectiveMaxFeePerGasWei(config)).toBe(1_000_000_000_000n);
    expect(effectiveMaxFeePerGasWei({ ...config, maxFeePerGasWei: 5_000_000_000 })).toBe(5_000_000_000n);
    expect(effectiveMaxFeePerGasWei({ ...config, maxFeePerGasWei: "123456789012345678901" })).toBe(123_456_789_012_345_678_901n);
  });

  it("an invalid value never falls back to the default (the helper throws)", () => {
    const config = base as unknown as Parameters<typeof effectiveMaxFeePerGasWei>[0];
    expect(() => effectiveMaxFeePerGasWei({ ...config, maxFeePerGasWei: 0 })).toThrow(/maxFeePerGasWei/);
  });
});

describe("R1-FUND-02 guardLocalAccount: refuses, signs what is sound, and stays sealed", () => {
  it("signs a sound transaction (the signature recovers to the account) and refuses each broken one with the typed error, recording it in the watch", async () => {
    const { account } = await makeLocalAccountWithScan();
    const watch: EvmSignerWatch = { refused: undefined };
    const guarded = guardLocalAccount(account, LIMITS, watch);
    expect(guarded.address).toBe(account.address);

    const signed = (await guarded.signTransaction(SOUND)) as Hex;
    expect(getAddress(await recoverTransactionAddress({ serializedTransaction: signed as never }))).toBe(account.address);
    expect(watch.refused).toBeUndefined();

    for (const [name, tx, rule] of [
      ["another chain id", { ...SOUND, chainId: 8453 }, "chain-id"],
      ["gas above the ceiling", { ...SOUND, gas: EVM_MAX_GAS_PER_WRITE + 1n }, "gas"],
      ["a fee cap above the ceiling", { ...SOUND, maxFeePerGas: 10_000n * GWEI, maxPriorityFeePerGas: 10_000n * GWEI }, "fee"],
    ] as const) {
      watch.refused = undefined;
      const error = await guarded.signTransaction(tx).then(() => undefined, (caught: unknown) => caught);
      expect(error, name).toBeInstanceOf(EvmSignerRefusedError);
      expect((error as EvmSignerRefusedError).rule, name).toBe(rule);
      expect(watch.refused, name).toBe(error);
    }
  });

  it("the wrapper is sealed like the loader's account: address and type only, to JSON, String(), inspect, spreads and structuredClone", async () => {
    const { account, leaks } = await makeLocalAccountWithScan();
    const guarded = guardLocalAccount(account, LIMITS);
    expect(Object.keys(guarded).sort()).toEqual(["address", "type"]);
    expect(Object.isFrozen(guarded)).toBe(true);
    expect(guarded.type).toBe("local");
    const shown = { address: account.address, type: "local" };
    expect(JSON.parse(JSON.stringify(guarded))).toEqual(shown);
    expect({ ...guarded }).toEqual(shown);
    expect(structuredClone(guarded)).toEqual(shown);
    expect(String(guarded)).toBe(String(account));
    expect(inspect(guarded)).toBe(inspect(account));
    const rendered = [JSON.stringify(guarded), String(guarded), inspect(guarded), inspect(guarded, { showHidden: true, customInspect: false, depth: 8 })].join("\n");
    expect(leaks(rendered)).toBe(false); // a boolean: a failure never prints the key
    // viem reads the signing functions by name: all of them are real, none is enumerable
    for (const name of ["signMessage", "signTransaction", "signTypedData", "publicKey", "source"] as const) {
      expect(Object.getOwnPropertyDescriptor(guarded, name)?.enumerable, name).toBe(false);
      expect(guarded[name], name).toBeDefined();
    }
  });

  it("a guarded account signs a message exactly like the account it wraps (the account proof is unaffected)", async () => {
    const { account } = await makeLocalAccountWithScan();
    const guarded = guardLocalAccount(account, LIMITS);
    const message = "an account proof message";
    expect(await guarded.signMessage({ message })).toBe(await account.signMessage({ message }));
  });
});

describe("R1-FUND-02 refuseFillTransaction: answered here, never asked of the endpoint", () => {
  it("eth_fillTransaction is a JSON-RPC method-not-found (-32601) and the provider is not reached; every other method passes through", async () => {
    const seen: string[] = [];
    const provider = refuseFillTransaction({
      async request(args) {
        seen.push(args.method);
        return "0x1";
      },
    });
    const error = (await provider.request({ method: "eth_fillTransaction", params: [{}] }).catch((caught: unknown) => caught)) as { code?: number; name?: string };
    expect(error.code).toBe(-32601);
    expect(error.name).toBe("RpcCaptureError");
    expect(seen).toEqual([]);
    expect(await provider.request({ method: "eth_chainId", params: [] })).toBe("0x1");
    expect(seen).toEqual(["eth_chainId"]);
  });
});

/** The hostile fill the review used: another chain (8453), 500,000 gas and 10,000 gwei fee caps, `to` and `input` echoed. */
function hostileFill(account: Address): (params: readonly unknown[]) => unknown {
  return (params) => {
    const request = params[0] as { to: Hex; data?: Hex; input?: Hex };
    return {
      raw: "0x",
      tx: {
        type: "0x2",
        chainId: "0x2105",
        nonce: "0x0",
        from: account,
        to: request.to,
        input: request.data ?? request.input ?? "0x",
        value: "0x0",
        gas: "0x7a120",
        maxFeePerGas: "0x9184e72a000",
        maxPriorityFeePerGas: "0x9184e72a000",
        accessList: [],
        hash: `0x${"00".repeat(32)}`,
        v: "0x0",
        r: "0x0",
        s: "0x0",
        yParity: "0x0",
      },
    };
  };
}

describe("R1-FUND-02 through the rail: an endpoint cannot make a local account sign what the pin forbids", () => {
  it("the review's fill attack: the endpoint's fill answer (chain 8453, 10,000 gwei) is never asked for; the signed chain id is the pin's", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    wire.answers.set("eth_fillTransaction", hostileFill(buyer.address));
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock });
    await rail.approve("USDC", "5");
    expect(wire.calls, "the endpoint was never asked to fill").not.toContain("eth_fillTransaction");
    expect(wire.rpc.exchanges().map((exchange) => exchange.method)).not.toContain("eth_fillTransaction");
    expect(wire.rawSends).toHaveLength(1);
    expect(wire.rawSends[0]?.chainId).toBe(31337);
  });

  it("the guard alone refuses the review's fill attack when a client does ask for the fill (nothing is sent)", async () => {
    const { node } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    wire.answers.set("eth_fillTransaction", hostileFill(buyer.address));
    const watch: EvmSignerWatch = { refused: undefined };
    const client = createWalletClient({ account: guardLocalAccount(buyer, LIMITS, watch), chain: CHAIN, transport: custom(wire.rpc, { retryCount: 0 }) });
    await expect(client.sendTransaction({ to: TOKEN, data: `0x095ea7b3${"00".repeat(64)}` })).rejects.toThrow();
    expect(wire.calls).toContain("eth_fillTransaction"); // this client's transport has no refusal: the attack reached viem
    expect(watch.refused).toBeInstanceOf(EvmSignerRefusedError);
    expect(watch.refused?.rule).toBe("chain-id");
    expect(wire.calls).not.toContain("eth_sendRawTransaction");
    expect(wire.rawSends).toEqual([]);
  });

  it("a gas estimate above the ceiling: approve throws the typed refusal (rule gas) and no raw transaction is sent", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    wire.answers.set("eth_estimateGas", `0x${(EVM_MAX_GAS_PER_WRITE + 1n).toString(16)}`);
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock });
    const error = await rail.approve("USDC", "5").then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmSignerRefusedError);
    expect((error as EvmSignerRefusedError).rule).toBe("gas");
    expect(wire.calls).not.toContain("eth_sendRawTransaction");
    expect(wire.rawSends).toEqual([]);
    expect(node.count("approve")).toBe(0);
  });

  it("the gas ceiling itself is signed (500,000 passes)", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    wire.answers.set("eth_estimateGas", `0x${EVM_MAX_GAS_PER_WRITE.toString(16)}`);
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock });
    await rail.approve("USDC", "5");
    expect(wire.rawSends).toHaveLength(1);
  });

  it("fee reads of 10,000 gwei: approve throws the typed refusal (rule fee) and no raw transaction is sent", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    wire.answers.set("eth_maxPriorityFeePerGas", "0x9184e72a000");
    wire.answers.set("eth_gasPrice", "0x9184e72a000");
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock });
    const error = await rail.approve("USDC", "5").then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmSignerRefusedError);
    expect((error as EvmSignerRefusedError).rule).toBe("fee");
    expect((error as EvmSignerRefusedError).limit).toBe("1000000000000");
    expect(wire.rawSends).toEqual([]);
    expect(node.count("approve")).toBe(0);
  });

  it("the ceiling is configurable: maxFeePerGasWei below the endpoint's fee refuses, above it signs", async () => {
    const buyer = await makeLocalAccount();
    const low = rig();
    const lowWire = localSigningRpc(low.node);
    low.node.configExtras = { maxFeePerGasWei: 500_000_000 }; // 0.5 gwei: under the mock's 1 gwei tip
    const lowRail = await EvmHtlcRail.connect({ config: low.node.config(), rpc: lowWire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock: low.clock });
    const refused = await lowRail.approve("USDC", "5").then(() => undefined, (caught: unknown) => caught);
    expect(refused).toBeInstanceOf(EvmSignerRefusedError);
    expect((refused as EvmSignerRefusedError).limit).toBe("500000000");
    expect(lowWire.rawSends).toEqual([]);

    const high = rig();
    const highWire = localSigningRpc(high.node);
    high.node.configExtras = { maxFeePerGasWei: "5000000000" };
    const highRail = await EvmHtlcRail.connect({ config: high.node.config(), rpc: highWire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock: high.clock });
    await highRail.approve("USDC", "5");
    expect(highWire.rawSends).toHaveLength(1);
  });

  it("lock and claim throw the typed refusal too (not the vendored rail's tclk text), send nothing, and the claim's error carries no preimage", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const seller = await makeLocalAccount();
    const buyerWire = localSigningRpc(node);
    const sellerWire = localSigningRpc(node);
    const book = bookFor(buyer.address, seller.address);
    const buyerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: buyerWire.rpc, account: buyer, addressBook: book, clock });
    const sellerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: sellerWire.rpc, account: seller, addressBook: book, clock });
    const secret = generateHashLock();

    await buyerRail.approve("USDC", "1000000");
    buyerWire.answers.set("eth_estimateGas", "0xf4240"); // 1,000,000 gas
    const lockError = await buyerRail.lock(termsFor(secret.hash), 0).then(() => undefined, (caught: unknown) => caught);
    expect(lockError).toBeInstanceOf(EvmSignerRefusedError);
    expect((lockError as EvmSignerRefusedError).rule).toBe("gas");
    expect(node.count("lock")).toBe(0);
    buyerWire.answers.delete("eth_estimateGas");
    await buyerRail.lock(termsFor(secret.hash), 0); // the same rail signs again once the endpoint is honest

    sellerWire.answers.set("eth_maxPriorityFeePerGas", "0x9184e72a000");
    const claimError = await sellerRail.claim(secret.hash as Hex, secret.preimage as Hex, T0 + 80 * 60_000).then(() => undefined, (caught: unknown) => caught);
    expect(claimError).toBeInstanceOf(EvmSignerRefusedError);
    expect((claimError as EvmSignerRefusedError).rule).toBe("fee");
    const text = [(claimError as Error).message, (claimError as Error).stack ?? "", JSON.stringify(claimError, Object.getOwnPropertyNames(claimError as object))].join("\n").toLowerCase();
    expect(text.includes(secret.preimage.slice(2).toLowerCase())).toBe(false);
    expect(sellerWire.rawSends).toEqual([]);
    expect(node.count("claim")).toBe(0);

    sellerWire.answers.delete("eth_maxPriorityFeePerGas");
    const claimed = await sellerRail.claim(secret.hash as Hex, secret.preimage as Hex, T0 + 80 * 60_000);
    expect(claimed.event).toBe("Claimed");
  });

  it("a JSON-RPC account (an address) is untouched: no guard, no fill refusal, the node signs", async () => {
    const { node, clock } = rig();
    const rpc = node.rpc();
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc, account: getAddress("0x00000000000000000000000000000000000000a1"), addressBook: bookFor(RAIL, RAIL), clock });
    await rail.approve("USDC", "5");
    expect(rpc.exchanges().map((exchange) => exchange.method)).toContain("eth_sendTransaction");
    expect(node.count("approve")).toBe(1);
  });
});

// R2-FUND-02 (P9 review round 2, decision 4): the sign-time fee refusal above fires in `signTransaction`, which viem calls only AFTER
// `eth_estimateGas`, and a claim's estimate carries `claim(hashLock, preimage)`. A claim refused for its fee therefore sent nothing to
// broadcast but had already shown the secret to the endpoint, and every retry showed it again. The wallet client's chain now carries a
// `fees.estimateFeesPerGas` hook (`guardEstimateFeesPerGas`) that computes viem's own caps and refuses above the ceiling before the estimate.
describe("R2-FUND-02: the fee ceiling is judged before any request that carries the preimage leaves", () => {
  const hexOf = (wei: bigint): string => `0x${wei.toString(16)}`;
  const carrying = (wire: ReturnType<typeof localSigningRpc>, preimage: string): string[] => {
    const bare = preimage.slice(2).toLowerCase();
    return wire.rpc.exchanges().filter((exchange) => exchange.requestBody.toLowerCase().includes(bare)).map((exchange) => exchange.method);
  };

  async function lockedWorld(config: Partial<{ maxFeePerGasWei: number | string }> = {}) {
    const { node, clock } = rig();
    node.configExtras = config;
    const buyer = await makeLocalAccount();
    const seller = await makeLocalAccount();
    const buyerWire = localSigningRpc(node);
    const sellerWire = localSigningRpc(node);
    const book = bookFor(buyer.address, seller.address);
    const buyerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: buyerWire.rpc, account: buyer, addressBook: book, clock });
    const sellerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: sellerWire.rpc, account: seller, addressBook: book, clock });
    const secret = generateHashLock();
    await buyerRail.approve("USDC", "1000000");
    await buyerRail.lock(termsFor(secret.hash), 0);
    return { node, sellerWire, sellerRail, secret };
  }

  it("the review's case: a 1,001 gwei priority fee refuses the claim (typed, rule fee) and NO request carrying the preimage is sent, on every retry", async () => {
    const { node, sellerWire, sellerRail, secret } = await lockedWorld();
    sellerWire.answers.set("eth_maxPriorityFeePerGas", hexOf(1_001n * GWEI));
    const estimates: string[] = [];
    sellerWire.answers.set("eth_estimateGas", (params: readonly unknown[]) => {
      estimates.push(JSON.stringify(params));
      return "0x30d40";
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const error = await sellerRail.claim(secret.hash as Hex, secret.preimage as Hex, T0 + 80 * 60_000).then(() => undefined, (caught: unknown) => caught);
      expect(error, `attempt ${attempt}`).toBeInstanceOf(EvmSignerRefusedError);
      expect((error as EvmSignerRefusedError).rule).toBe("fee");
      expect((error as EvmSignerRefusedError).limit).toBe("1000000000000");
    }
    expect(estimates, "no eth_estimateGas reached the endpoint for a refused claim").toEqual([]);
    expect(sellerWire.calls).not.toContain("eth_estimateGas");
    expect(sellerWire.calls).not.toContain("eth_fillTransaction");
    expect(carrying(sellerWire, secret.preimage), "no exchange of the Seller's capture carries the preimage").toEqual([]);
    expect(sellerWire.rawSends).toEqual([]);
    expect(node.count("claim")).toBe(0);

    // the fee market calms down: the same rail claims, and only now does the preimage reach a wire (the estimate, then the broadcast)
    sellerWire.answers.delete("eth_maxPriorityFeePerGas");
    const claimed = await sellerRail.claim(secret.hash as Hex, secret.preimage as Hex, T0 + 80 * 60_000);
    expect(claimed.event).toBe("Claimed");
    expect(estimates).toHaveLength(1);
    expect(carrying(sellerWire, secret.preimage)).toEqual(["eth_estimateGas", "eth_sendRawTransaction"]);
    expect(node.count("claim")).toBe(1);
  });

  it("a refusal on a claim leaves the Seller's own error free of the preimage, whichever way it is rendered", async () => {
    const { sellerWire, sellerRail, secret } = await lockedWorld();
    sellerWire.answers.set("eth_maxPriorityFeePerGas", hexOf(10_000n * GWEI));
    const error = await sellerRail.claim(secret.hash as Hex, secret.preimage as Hex, T0 + 80 * 60_000).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmSignerRefusedError);
    const bare = secret.preimage.slice(2).toLowerCase();
    const renderings = [String((error as Error).message), (error as Error).stack ?? "", inspect(error, { showHidden: true, depth: 10 }), JSON.stringify(error, Object.getOwnPropertyNames(error as object))];
    for (const rendering of renderings) expect(rendering.toLowerCase().includes(bare)).toBe(false);
    expect(carrying(sellerWire, secret.preimage)).toEqual([]);
  });

  it("the ceiling itself signs and one wei above it refuses before the estimate (base fee 7 wei x 1.2 rounds to 8, plus the tip)", async () => {
    const ceiling = 5n * GWEI;
    const at = await lockedWorld({ maxFeePerGasWei: ceiling.toString() });
    at.sellerWire.answers.set("eth_maxPriorityFeePerGas", hexOf(ceiling - 8n)); // maxFeePerGas = ceiling exactly
    const claimed = await at.sellerRail.claim(at.secret.hash as Hex, at.secret.preimage as Hex, T0 + 80 * 60_000);
    expect(claimed.event).toBe("Claimed");

    const over = await lockedWorld({ maxFeePerGasWei: ceiling.toString() });
    over.sellerWire.answers.set("eth_maxPriorityFeePerGas", hexOf(ceiling - 7n)); // maxFeePerGas = ceiling + 1
    const error = await over.sellerRail.claim(over.secret.hash as Hex, over.secret.preimage as Hex, T0 + 80 * 60_000).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmSignerRefusedError);
    expect((error as EvmSignerRefusedError).limit).toBe(ceiling.toString());
    expect(over.sellerWire.calls).not.toContain("eth_estimateGas");
    expect(carrying(over.sellerWire, over.secret.preimage)).toEqual([]);
  });

  it("a priority fee alone above the ceiling refuses too (the hook judges both caps)", async () => {
    const { sellerWire, sellerRail, secret } = await lockedWorld({ maxFeePerGasWei: (2n * GWEI).toString() });
    sellerWire.answers.set("eth_maxPriorityFeePerGas", hexOf(2n * GWEI + 1n));
    const error = await sellerRail.claim(secret.hash as Hex, secret.preimage as Hex, T0 + 80 * 60_000).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmSignerRefusedError);
    expect((error as EvmSignerRefusedError).rule).toBe("fee");
    expect(sellerWire.calls).not.toContain("eth_estimateGas");
  });

  it("the call order of a signed claim is unchanged by the hook: nonce, tip, estimate, broadcast", async () => {
    const { sellerWire, sellerRail, secret } = await lockedWorld();
    await sellerRail.claim(secret.hash as Hex, secret.preimage as Hex, T0 + 80 * 60_000);
    const order = sellerWire.calls.filter((method) => ["eth_getTransactionCount", "eth_maxPriorityFeePerGas", "eth_estimateGas", "eth_sendRawTransaction", "eth_gasPrice", "eth_feeHistory"].includes(method));
    expect(order).toEqual(["eth_getTransactionCount", "eth_maxPriorityFeePerGas", "eth_estimateGas", "eth_sendRawTransaction"]);
  });
});

describe("R2-FUND-02 guardEstimateFeesPerGas on its own", () => {
  const multiply = (value: bigint): bigint => (value * 12n) / 10n;
  const block = (baseFeePerGas: bigint | undefined) => ({ baseFeePerGas }) as never;
  const clientOf = (answers: Record<string, string>) => ({ request: async ({ method }: { method: string }) => answers[method] ?? "0x0" }) as never;

  it("EIP-1559: returns exactly viem's default caps (base fee x 1.2 plus the tip) when they are within the ceiling", async () => {
    const hook = guardEstimateFeesPerGas(10n * GWEI);
    const fees = await hook({ block: block(100n), client: clientOf({ eth_maxPriorityFeePerGas: "0x3b9aca00" }), multiply, request: undefined, type: "eip1559" } as never);
    expect(fees).toEqual({ maxFeePerGas: 120n + GWEI, maxPriorityFeePerGas: GWEI });
  });

  it("EIP-1559: the request's own caps are honoured as viem honours them, and still judged", async () => {
    const hook = guardEstimateFeesPerGas(10n * GWEI);
    const given = { maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 2n * GWEI };
    expect(await hook({ block: block(100n), client: clientOf({}), multiply, request: given, type: "eip1559" } as never)).toEqual(given);
    const watch: EvmSignerWatch = { refused: undefined };
    const tight = guardEstimateFeesPerGas(GWEI, watch);
    await expect(tight({ block: block(100n), client: clientOf({}), multiply, request: given, type: "eip1559" } as never)).rejects.toBeInstanceOf(EvmSignerRefusedError);
    expect(watch.refused?.rule).toBe("fee");
    expect(watch.refused?.limit).toBe(GWEI.toString());
  });

  it("legacy: the gas price times the multiplier is judged; a chain without a base fee returns null so viem's own refusal follows", async () => {
    const hook = guardEstimateFeesPerGas(10n * GWEI);
    expect(await hook({ block: block(undefined), client: clientOf({ eth_gasPrice: "0x3b9aca00" }), multiply, request: undefined, type: "legacy" } as never)).toEqual({ gasPrice: (GWEI * 12n) / 10n });
    await expect(hook({ block: block(undefined), client: clientOf({ eth_gasPrice: `0x${(20n * GWEI).toString(16)}` }), multiply, request: undefined, type: "legacy" } as never)).rejects.toBeInstanceOf(EvmSignerRefusedError);
    expect(await hook({ block: block(undefined), client: clientOf({}), multiply, request: undefined, type: "eip1559" } as never)).toBeNull();
  });
});
