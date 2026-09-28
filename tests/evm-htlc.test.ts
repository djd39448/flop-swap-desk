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
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  numberToHex,
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
  checkEvmRailConfig,
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
    const text = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
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
  // P22-P24-EVM-FIXES.md A3: an allow list, not a deny list — 8453 (base mainnet) is refused
  // because it is not 31337/84532, and the old named list only makes the message friendlier.
  it("refuses a chain id not on the allow list, by name when it is a known mainnet, before ever touching the network", async () => {
    const config: EvmRailConfig = configFor({ chainId: 8453, name: "base-mainnet-oops", caip2: "eip155:8453", finality: { mode: "tag", tag: "finalized" } });
    const { rpc } = mockCapturingRpc({
      // No handlers at all: if connect() ever called the network, this would throw and fail
      // the test with a different message than the one we assert on.
    });
    await expect(EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(
      /chain id 8453 is not on the allow list.*8453 is base mainnet/,
    );
  });

  it("refuses a chain id not on the allow list even with no deny-list name for it (an unnamed testnet)", async () => {
    const config: EvmRailConfig = configFor({ chainId: 5, name: "goerli", caip2: "eip155:5", finality: { mode: "tag", tag: "finalized" } });
    const { rpc } = mockCapturingRpc({});
    await expect(EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(
      /chain id 5 is not on the allow list \(31337 anvil-local, 84532 base-sepolia only\)$/,
    );
  });

  it("accepts base-sepolia (84532), the one non-anvil id on the allow list, without a live chain", () => {
    const config = configFor(BASE_SEPOLIA_PIN);
    expect(() => validateEvmRailConfig(config)).not.toThrow();
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

  // P22-P24-EVM-FIXES-R2.md C5: "one config rule for every entry point" — a chain id that is
  // otherwise allow-listed and shape-valid, pinned under the *wrong* canonical name.
  it("C5: refuses a chain id pinned under the wrong canonical name (31337 claimed as base-sepolia)", () => {
    const config = configFor({ chainId: 31337, name: "base-sepolia", caip2: "eip155:31337", finality: { mode: "tag", tag: "finalized" } });
    expect(() => validateEvmRailConfig(config)).toThrow(/chain id 31337 must be pinned as "anvil-local", got "base-sepolia"/);
  });

  it("C5: refuses a chain id pinned under the wrong canonical name (84532 claimed as anvil-local)", () => {
    const config = configFor({ chainId: 84532, name: "anvil-local", caip2: "eip155:84532", finality: { mode: "tag", tag: "finalized" } });
    expect(() => validateEvmRailConfig(config)).toThrow(/chain id 84532 must be pinned as "base-sepolia", got "anvil-local"/);
  });

  // C5: `connect()` used to run only `validateEvmRailConfig` (the allow list, the D-09 asset
  // check, the finality knobs) — never the shape check (`pin.caip2 === "eip155:" + pin.chainId`)
  // that `checkEvmRailConfig` also runs. A config whose numeric chain id is fine but whose
  // `caip2` disagrees with it would have connected without complaint before this fix.
  it("C5: connect() itself now refuses a config whose pin.caip2 does not match pin.chainId, before ever touching the network", async () => {
    const config = configFor({ chainId: 31337, name: "anvil-local", caip2: "eip155:1", finality: { mode: "tag", tag: "finalized" } });
    const { rpc } = mockCapturingRpc({}); // no handlers: connect() must refuse before any RPC call
    await expect(EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(
      /pin\.caip2 "eip155:1" does not match pin\.chainId 31337/,
    );
  });
});

// P22-P24-EVM-FIXES.md A3: `checkEvmRailConfig` is what every entry point that takes a rail
// config as untrusted data (a `--rails` file, a captured `rails.json`, `foldCaptured`'s own
// `rails.evm` input) runs instead of the throwing `validateEvmRailConfig` directly — a shape
// problem or an allow-list/D-09/finality refusal both come back as `{ ok: false, reason }`.
describe("checkEvmRailConfig — shape check plus validateEvmRailConfig, never throwing", () => {
  it("ok:true for a well-formed, allow-listed config", () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const result = checkEvmRailConfig(config);
    expect(result).toEqual({ ok: true, config });
  });

  it("ok:false, not thrown, for a chain id off the allow list", () => {
    const config = configFor({ chainId: 8453, name: "base-mainnet-oops", caip2: "eip155:8453", finality: { mode: "tag", tag: "finalized" } });
    const result = checkEvmRailConfig(config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/not on the allow list/);
  });

  it("ok:false for a non-object value", () => {
    expect(checkEvmRailConfig(null).ok).toBe(false);
    expect(checkEvmRailConfig("nope").ok).toBe(false);
    expect(checkEvmRailConfig(undefined).ok).toBe(false);
  });

  it("ok:false when pin.caip2 does not actually derive from pin.chainId", () => {
    const config = { ...configFor(ANVIL_LOCAL_PIN), pin: { ...ANVIL_LOCAL_PIN, caip2: "eip155:1" } };
    const result = checkEvmRailConfig(config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/does not match pin\.chainId/);
  });

  it("ok:false when a required field is missing entirely", () => {
    const { endpoint: _endpoint, ...withoutEndpoint } = configFor(ANVIL_LOCAL_PIN);
    const result = checkEvmRailConfig(withoutEndpoint);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/endpoint must be/);
  });

  it("ok:false when an asset address is not a 0x-address", () => {
    const config = { ...configFor(ANVIL_LOCAL_PIN), assets: { USDC: "not-an-address" } };
    const result = checkEvmRailConfig(config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/assets\["USDC"\] must be a 0x-address/);
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

  // P22-P24-EVM-FIXES-R3.md E5: `claim()` no longer runs one preimage-carrying simulation —
  // it runs two preimage-free ones, routed by which contract (`to`) and which function
  // (`data`'s own selector) each `eth_call` targets: a zero-preimage `claim()` against the
  // rail contract (must revert with its own exact "secret does not open the statement"
  // reason), a `locks(hashLock)` read against the rail contract (used to learn payee/token/
  // amount for the second check), and an ERC20 `transfer` simulate against the token contract,
  // impersonated from the rail contract's own address (must succeed). E4: the pending-block
  // read `eth_getBlockByNumber("pending", …)` this rail's own last-moment guard makes.
  const LOCKS_SELECTOR = encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [TERMS.statement as Hex] }).slice(0, 10);
  const CLAIM_SUCCEEDS_LOCKS_RESULT = encodeFunctionResult({
    abi: EVM_HASH_RAIL_ABI,
    functionName: "locks",
    result: [PAYER, PAYEE, TOKEN, BigInt(TERMS.amount), BigInt(TERMS.claimByMs), BigInt(TERMS.refundAfterMs), 1],
  });
  const ERC20_BOOL_TRUE = `0x${"0".repeat(63)}1` as Hex;

  /** A `pending` block comfortably before `TERMS.refundAfterMs` (and any `notAfterMs` this
   *  block's own tests pass in), so E4's own last-moment guard never trips unless a test
   *  deliberately arranges otherwise. */
  function pendingBlockHandlers() {
    return { eth_getBlockByNumber: () => ({ result: { timestamp: numberToHex(Math.floor((TERMS.claimByMs - 5 * 60_000) / 1000)) } }) };
  }

  /** claim()'s own `eth_call` traffic for a claim that should be allowed to broadcast:
   *  check (a) sees the zero-preimage revert it expects, the `locks()` read reports a real,
   *  matching, `Locked` lock, and check (b)'s ERC20 transfer simulation succeeds. */
  function claimAllowedEthCall(params: readonly unknown[]): { result?: unknown; error?: { code: number; message: string } } {
    const [callObject] = params as [{ to?: string; data?: string }];
    const to = (callObject.to ?? "").toLowerCase();
    if (to === TOKEN.toLowerCase()) return { result: ERC20_BOOL_TRUE };
    const data = (callObject.data ?? "").toLowerCase();
    if (data.startsWith(LOCKS_SELECTOR)) return { result: CLAIM_SUCCEEDS_LOCKS_RESULT };
    return { error: { code: 3, message: "execution reverted: EvmHashRail: secret does not open the statement" } };
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
    const { rpc } = mockCapturingRpc({ ...lockHandlers([log]), ...pendingBlockHandlers(), eth_call: claimAllowedEthCall });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    const evidence = await rail.claim(TERMS.statement as Hex, secret, TERMS.refundAfterMs);
    expect(evidence.event).toBe("Claimed");
  });

  // P22-P24-EVM-FIXES.md B2 (USD-COIN-FIT-2026-09-28.md). P22-P24-EVM-FIXES-R3.md E5: the
  // pre-check simulation is now preimage-free (E5(a): a zero-preimage `claim()` simulate) —
  // a mock that reverts every `eth_call` with an unrelated reason ("blacklisted") no longer
  // reaches the old single-simulation message; it fails the *new* pre-check instead, for a
  // different (but still fund-safety-equivalent) reason: the pre-check never saw proof of an
  // open, in-window lock. Either way the claim never broadcasts.
  it("claim() never broadcasts when the pre-check simulation does not show an open, in-window lock", async () => {
    const secret = ("0x" + "cd".repeat(32)) as Hex;
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc, calls } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_call: () => ({ error: { code: 3, message: "execution reverted: EvmHashRail: blacklisted" } }),
      // No eth_sendTransaction/eth_getTransactionReceipt/eth_blockNumber/eth_getBlockByNumber
      // handlers at all: if claim() ever broadcast (or even reached the E4 pending-time check)
      // past the pre-check above, this mock would throw "unexpected method" instead of failing
      // with the assertion below.
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.claim(TERMS.statement as Hex, secret, TERMS.refundAfterMs)).rejects.toThrow(
      /pre-check simulation did not show an open, in-window lock/,
    );
    expect(calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  // P22-P24-EVM-FIXES-R3.md E5(b): the zero-preimage pre-check (a) passes (a real, open,
  // in-window lock), but the payout itself (b) is blocked — a blacklisted payee, or a paused
  // token. The real claim, carrying the real secret, must never be sent.
  it("claim() never broadcasts when the payout itself simulates to a revert (E5(b))", async () => {
    const secret = ("0x" + "cd".repeat(32)) as Hex;
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc, calls } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_call: (params) => {
        const [callObject] = params as [{ to?: string; data?: string }];
        const to = (callObject.to ?? "").toLowerCase();
        if (to === TOKEN.toLowerCase()) {
          return { error: { code: 3, message: "execution reverted: blacklisted payee" } };
        }
        const data = (callObject.data ?? "").toLowerCase();
        if (data.startsWith(LOCKS_SELECTOR)) return { result: CLAIM_SUCCEEDS_LOCKS_RESULT };
        return { error: { code: 3, message: "execution reverted: EvmHashRail: secret does not open the statement" } };
      },
      // No eth_sendTransaction handler: the real claim (carrying the real secret) must never
      // be sent once the payout pre-check fails.
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.claim(TERMS.statement as Hex, secret, TERMS.refundAfterMs)).rejects.toThrow(/payout itself simulates to a revert/);
    expect(calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  // P22-P24-EVM-FIXES-R3.md E5(a): a zero preimage can never actually open a real hashLock — an
  // endpoint whose zero-preimage simulation does NOT revert at all cannot be trusted to reflect
  // the real contract, and the real claim must never be sent to it.
  it("claim() never broadcasts when the zero-preimage pre-check unexpectedly does not revert", async () => {
    const secret = ("0x" + "cd".repeat(32)) as Hex;
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc, calls } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      // Every eth_call "succeeds" (no revert at all) — including the zero-preimage claim
      // simulate, which for a real hashLock should be impossible.
      eth_call: () => ({ result: "0x" }),
      // No eth_sendTransaction handler: the real claim must never be sent.
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.claim(TERMS.statement as Hex, secret, TERMS.refundAfterMs)).rejects.toThrow(
      /pre-check simulation unexpectedly did not revert for a zero preimage/,
    );
    expect(calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });

  // P22-P24-EVM-FIXES-R3.md E4: both pre-checks (a)/(b) pass, but the chain's own `pending`
  // view is already at/after the caller's `notAfterMs` bound — the real claim must never be
  // sent, even though nothing about the lock itself looked wrong.
  it("claim() never broadcasts when pending chain time is at/after the given notAfterMs (E4)", async () => {
    const secret = ("0x" + "cd".repeat(32)) as Hex;
    const config = configFor(ANVIL_LOCAL_PIN);
    const notAfterMs = TERMS.refundAfterMs - 5 * 60_000;
    const { rpc, calls } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_call: claimAllowedEthCall,
      // The pending block is already at notAfterMs itself.
      eth_getBlockByNumber: () => ({ result: { timestamp: numberToHex(Math.floor(notAfterMs / 1000)) } }),
      // No eth_sendTransaction handler: the real claim must never be sent.
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(rail.claim(TERMS.statement as Hex, secret, notAfterMs)).rejects.toThrow(
      /pending chain time .* is at\/after the given deadline/,
    );
    expect(calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
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

  // P22-P24-EVM-FIXES.md A10.
  it("WriteEvidence.raw holds only this write's own exchanges, never anything already sitting in the shared rpc's log", async () => {
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

    // Simulate something else having shared this `CapturingRpc` instance and left its own
    // exchanges sitting in the log un-drained — exactly what `captureEvmLeg` does on purpose
    // (it only ever peeks, `rpc.exchanges().slice(before)`, never drains): the old
    // `drain()`-based implementation would have swept these into the *next* write's own
    // `WriteEvidence.raw` too.
    await rpc.request({ method: "eth_chainId", params: [] });
    await rpc.request({ method: "eth_chainId", params: [] });
    const priorHashes = new Set(rpc.exchanges().map((exchange) => exchange.responseSha256));
    expect(priorHashes.size).toBe(2);

    const evidence = await rail.lock(TERMS, 0);

    expect(evidence.raw.length).toBeGreaterThan(0);
    for (const hash of evidence.raw) expect(priorHashes.has(hash)).toBe(false);
  });

  it("connect()'s own eth_chainId exchange is drained, never sitting around for the first write's raw", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({ eth_chainId: () => ({ result: "0x7a69" }) });
    await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    expect(rpc.exchanges()).toHaveLength(0);
  });

  it("verifyLockFinal drains its own captured exchanges rather than leaving them in the log forever", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    const { rpc } = mockCapturingRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
      eth_call: () => ({ result: encodeFunctionResult({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", result: [PAYER, PAYEE, TOKEN, BigInt(TERMS.amount), BigInt(TERMS.claimByMs), BigInt(TERMS.refundAfterMs), 1] }) }),
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
    await rail.verifyLockFinal(TERMS, TERMS.statement, { payee: PAYEE, payer: PAYER });
    expect(rpc.exchanges()).toHaveLength(0);
  });

  it("re-checks eth_chainId against the pin before every write, refusing if it no longer matches", async () => {
    const config = configFor(ANVIL_LOCAL_PIN);
    let chainIdCalls = 0;
    const { rpc } = mockCapturingRpc({
      // First call is connect()'s own; every call after that (the A10 recheck) answers with a
      // different chain id, as if this long-lived rail's RPC endpoint got pointed elsewhere.
      eth_chainId: () => {
        chainIdCalls += 1;
        return { result: chainIdCalls === 1 ? "0x7a69" : "0x2105" };
      },
    });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });

    await expect(rail.lock(TERMS, 0)).rejects.toThrow(/chain id 8453 no longer matches pin "anvil-local"/);
    await expect(rail.claim(TERMS.statement as Hex, ("0x" + "cd".repeat(32)) as Hex, TERMS.refundAfterMs)).rejects.toThrow(
      /no longer matches pin/,
    );
    await expect(rail.refund(TERMS.statement as Hex)).rejects.toThrow(/no longer matches pin/);
    await expect(rail.approve("USDC", "1")).rejects.toThrow(/no longer matches pin/);
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

  // P22-P24-EVM-FIXES.md A8: `ref`/`terms.lock` are checked before any RPC — a malformed ref
  // or lock kind can never resolve to real evidence, so `verifyLockFinal` must refuse without
  // ever calling `captureEvmLeg`'s transport. Every handler below is a genuinely working one
  // (a broken guard would not crash — it would quietly complete a live round trip and still
  // land on the same "ref/lock mismatch" verdict via `evmEvidence`'s own gate), so the only
  // way to actually catch a regression is counting `calls`: `connect()` makes exactly one
  // (`eth_chainId`); `verifyLockFinal` must add zero more.
  describe("verifyLockFinal — A8: refuses before any RPC", () => {
    it('terms.lock !== "hash" -> railVerified false, no RPC beyond connect()', async () => {
      const config = configFor(ANVIL_LOCAL_PIN);
      const { rpc, calls } = mockCapturingRpc({
        eth_chainId: () => ({ result: "0x7a69" }),
        eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
        eth_call: () => ({ result: locksResult(1) }),
      });
      const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
      expect(calls).toHaveLength(1); // just connect()'s own eth_chainId
      const pointTerms: LockTerms = { ...TERMS, lock: "point" };
      const evidence = await rail.verifyLockFinal(pointTerms, pointTerms.statement, { payee: PAYEE });
      expect(evidence.lock.railVerified).toBe(false);
      expect(evidence.lock.reason).toMatch(/ref\/lock mismatch/);
      expect(calls).toHaveLength(1); // verifyLockFinal touched the RPC zero times
    });

    it("ref !== terms.statement -> railVerified false, no RPC beyond connect()", async () => {
      const config = configFor(ANVIL_LOCAL_PIN);
      const { rpc, calls } = mockCapturingRpc({
        eth_chainId: () => ({ result: "0x7a69" }),
        eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
        eth_call: () => ({ result: locksResult(1) }),
      });
      const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
      const wrongRef = "0x" + "ab".repeat(32);
      const evidence = await rail.verifyLockFinal(TERMS, wrongRef, { payee: PAYEE, payer: PAYER });
      expect(evidence.lock.railVerified).toBe(false);
      expect(evidence.lock.reason).toMatch(/ref\/lock mismatch/);
      expect(evidence.lock.ref).toBe(wrongRef);
      expect(calls).toHaveLength(1); // verifyLockFinal touched the RPC zero times
    });

    it("a malformed hashLock shape (not 0x + 64 lowercase hex) -> railVerified false, no RPC beyond connect()", async () => {
      const config = configFor(ANVIL_LOCAL_PIN);
      const { rpc, calls } = mockCapturingRpc({
        eth_chainId: () => ({ result: "0x7a69" }),
        eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
        eth_call: () => ({ result: locksResult(1) }),
      });
      const rail = await EvmHtlcRail.connect({ config, rpc, account: PAYER, addressBook: ADDRESS_BOOK, clock: NOW });
      const evidence = await rail.verifyLockFinal(TERMS, "0xnothex", { payee: PAYEE });
      expect(evidence.lock.railVerified).toBe(false);
      expect(evidence.lock.reason).toMatch(/ref\/lock mismatch/);
      expect(calls).toHaveLength(1); // verifyLockFinal touched the RPC zero times
    });
  });

  // P22-P24-EVM-FIXES.md A8, `captureEvmLeg`'s own copy of the guard (called directly, the
  // way `src/watcher.ts` does, rather than through `verifyLockFinal`).
  describe("captureEvmLeg — A8: refuses a malformed hashLock before any RPC", () => {
    it("returns an empty-exchange index and makes zero RPC calls", async () => {
      const config = configFor(ANVIL_LOCAL_PIN);
      const { rpc, calls } = mockCapturingRpc({
        eth_chainId: () => ({ result: "0x7a69" }),
        eth_getBlockByNumber: () => ({ result: { number: "0x5", hash: BLOCK_HASH } }),
        eth_call: () => ({ result: locksResult(1) }),
      });
      const { captureEvmLeg } = await import("../src/rails/evm-evidence.js");
      const { index, exchanges } = await captureEvmLeg(rpc, config, "not-a-hash-lock", NOW());
      expect(exchanges).toEqual([]);
      expect(index.exchanges).toEqual([]);
      expect(index.hashLock).toBe("not-a-hash-lock");
      expect(calls).toHaveLength(0);
    });
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
