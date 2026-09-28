// SPDX-License-Identifier: MIT
//
// tests/evm-evidence.test.ts — P22-P24-EVM-SPEC.md §4: synthetic ABI-encoded responses (built
// with viem's own encoders) covering every branch of `evmEvidence`'s fail-closed decode, plus
// live-vs-replay equivalence: the same bytes, captured live and reloaded from disk, must
// produce byte-identical evidence.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import type { LockTerms } from "@flop-labs/tclk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";
import { CapturingRpc, readCapture, writeCapture } from "../src/rails/rpc-capture.js";
import type { EvmChainPin, EvmRailConfig } from "../src/rails/evm-htlc.js";
import {
  captureEvmLeg,
  evmEvidence,
  type EvmAccounts,
  type EvmCapture,
  type EvmCaptureIndex,
  type EvmCaptureIndexExchange,
} from "../src/rails/evm-evidence.js";

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

function jsonRpcResult(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonRpcError(id: number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Deterministic 20-byte address from a short tag, for readable fixtures. */
function addr(tag: string): Address {
  const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
  return `0x${hex}` as Address;
}

const RAIL_CONTRACT = addr("rail-contract");
const TOKEN = addr("usdc-token");
const PAYER = addr("payer");
const PAYEE = addr("payee");
const OTHER = addr("someone-else");
const BLOCK_HASH = ("0x" + "cd".repeat(32)) as Hex;
const FALLBACK_BLOCK_HASH = ("0x" + "ef".repeat(32)) as Hex;

const PIN: EvmChainPin = { chainId: 31337, name: "anvil-local", caip2: "eip155:31337", finality: { mode: "tag", tag: "finalized" } };

const CONFIG: EvmRailConfig = {
  pin: PIN,
  endpoint: "http://127.0.0.1:9999",
  contract: RAIL_CONTRACT,
  assets: { USDC: TOKEN },
};

const TERMS: LockTerms = {
  contract: "0x" + "11".repeat(32),
  lock: "hash",
  statement: "0x" + "22".repeat(32),
  amount: "1000000",
  asset: "USDC",
  payer: "did:key:zPayer",
  payee: "did:key:zPayee",
  claimByMs: 1_700_000_000_000,
  refundAfterMs: 1_700_003_600_000,
};

const HASH_LOCK = TERMS.statement;
const ACCOUNTS: EvmAccounts = { payee: PAYEE, payer: PAYER };
const CHECKED_AT_MS = 1_700_000_500_000;

const enum Status {
  None = 0,
  Locked = 1,
  Claimed = 2,
  Refunded = 3,
}

function encodeLocksResult(args: {
  payer?: Address;
  payee?: Address;
  token?: Address;
  amount?: bigint;
  claimByMs?: bigint;
  refundAfterMs?: bigint;
  status: number;
}): Hex {
  return encodeFunctionResult({
    abi: EVM_HASH_RAIL_ABI,
    functionName: "locks",
    result: [
      args.payer ?? PAYER,
      args.payee ?? PAYEE,
      args.token ?? TOKEN,
      args.amount ?? BigInt(TERMS.amount),
      args.claimByMs ?? BigInt(TERMS.claimByMs),
      args.refundAfterMs ?? BigInt(TERMS.refundAfterMs),
      args.status,
    ],
  });
}

interface ExchangeSpec {
  method: string;
  params: unknown;
  body: string;
}

/** The real `locks(hashLock)` calldata — P22-P24-EVM-FIXES.md A1 now requires a captured
 *  `eth_call`'s own request to actually carry this (not a placeholder), or the exchange fails
 *  to bind. */
function locksCallData(hashLock: string): Hex {
  return encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [hashLock as Hex] });
}

/** Also builds each exchange's request/response bytes so A1's binding (requestBody parses to
 *  exactly the declared method/params; the response's own `id` matches) holds by default —
 *  every `it.each`/override in this file that wants a *tampered* exchange does so explicitly,
 *  never by accident of a sloppy fixture. */
function buildCapture(opts: {
  hashLock?: string;
  contract?: Address;
  chainId?: number;
  finality?: EvmCaptureIndex["finality"];
  config?: EvmRailConfig;
  exchanges: ExchangeSpec[];
}): EvmCapture {
  const bySha = new Map<string, Uint8Array>();
  const exchanges: EvmCaptureIndexExchange[] = opts.exchanges.map((spec, i) => {
    const sha = sha256Hex(spec.body);
    bySha.set(sha, new TextEncoder().encode(spec.body));
    return {
      method: spec.method,
      params: spec.params,
      requestBody: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: spec.method, params: spec.params }),
      responseSha256: sha,
      atMs: CHECKED_AT_MS - 1000 + i,
    };
  });
  const index: EvmCaptureIndex = {
    v: 1,
    rail: "evm-htlc",
    chainId: opts.chainId ?? PIN.chainId,
    caip2: PIN.caip2,
    pin: PIN.name,
    endpoint: CONFIG.endpoint,
    contract: opts.contract ?? CONFIG.contract,
    hashLock: opts.hashLock ?? HASH_LOCK,
    checkedAtMs: CHECKED_AT_MS,
    finality: opts.finality ?? { mode: "tag", tag: "finalized" },
    config: opts.config ?? CONFIG,
    exchanges,
  };
  return { index, bytes: bySha };
}

/** The standard three-exchange sequence (chainId, finalized tag, eth_call) for a status/field
 *  combination, with room to override or omit any single exchange. */
function standardExchanges(opts: {
  chainId?: number;
  chainIdError?: boolean;
  blockHash?: Hex | null;
  omitBlock?: boolean;
  callResult?: Hex;
  callError?: boolean;
  omitCall?: boolean;
}): ExchangeSpec[] {
  const specs: ExchangeSpec[] = [
    {
      method: "eth_chainId",
      params: [],
      body: opts.chainIdError
        ? jsonRpcError(1, -32601, "method not found")
        : jsonRpcResult(1, `0x${(opts.chainId ?? PIN.chainId).toString(16)}`),
    },
  ];
  if (!opts.omitBlock) {
    specs.push({
      method: "eth_getBlockByNumber",
      params: ["finalized", false],
      body:
        opts.blockHash === null
          ? jsonRpcResult(2, null)
          : jsonRpcResult(2, { number: "0x5", hash: opts.blockHash ?? BLOCK_HASH }),
    });
  }
  if (!opts.omitCall) {
    specs.push({
      method: "eth_call",
      params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: opts.blockHash ?? BLOCK_HASH }],
      body: opts.callError ? jsonRpcError(3, -32000, "execution reverted") : jsonRpcResult(3, opts.callResult ?? "0x"),
    });
  }
  return specs;
}

const FINALIZED_REF = `anvil-local:finalized:5:${BLOCK_HASH}`;

describe("evmEvidence — happy path", () => {
  it("locked, all fields and both accounts match -> railVerified true, rail locked+final", async () => {
    const capture = buildCapture({
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }),
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });

    expect(result.lock.railVerified).toBe(true);
    expect(result.rail).toEqual({ status: "locked", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
    expect(result.lock.finalizedRef).toBe(FINALIZED_REF);
    expect(result.lock.ref).toBe(HASH_LOCK);
    expect(result.lock.rail).toBe("evm-htlc");
    expect(result.lock.raw).toEqual(capture.index.exchanges.map((e) => e.responseSha256));
  });

  it("locked, payer unbound (no payer account line) -> still true, reason notes it", async () => {
    const capture = buildCapture({
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }),
    });
    const result = await evmEvidence({
      terms: TERMS,
      config: CONFIG,
      accounts: { payee: PAYEE },
      capture,
    });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.reason).toMatch(/payer unbound/);
  });
});

describe("evmEvidence — ref/lock gate", () => {
  it("ref (index.hashLock) not equal to terms.statement -> railVerified false, no rail", async () => {
    const capture = buildCapture({
      hashLock: "0x" + "99".repeat(32),
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }),
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });

  it("terms.lock !== 'hash' -> railVerified false, no rail", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const pointTerms: LockTerms = { ...TERMS, lock: "point" };
    const result = await evmEvidence({ terms: pointTerms, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });
});

describe("evmEvidence — chain id and contract checks", () => {
  it("captured chain id differs from the pin -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ chainId: 84532, callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not match pin/);
  });

  it("eth_chainId exchange itself is an rpc error -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ chainIdError: true, callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc rejected eth_chainId/);
  });

  it("index.contract differs from config.contract -> railVerified null", async () => {
    const capture = buildCapture({
      contract: addr("a-different-contract"),
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }),
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/contract does not match/);
  });

  // P22-P24-EVM-FIXES.md A2: every hex value is validated before hexToNumber — never a thrown
  // exception on captured data.
  it("eth_chainId result is null (not a hex string at all) -> railVerified null, never throws", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, null) },
        ...standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }).slice(1),
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/malformed eth_chainId result/);
  });

  it("eth_chainId result is a non-hex string -> railVerified null, never throws", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "not-hex-at-all") },
        ...standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }).slice(1),
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/malformed eth_chainId result/);
  });
});

describe("evmEvidence — finalized-view resolution", () => {
  // P22-P24-EVM-FIXES.md A2: the finalized block's own `.number` is a hex value read from
  // captured (untrusted) data — never handed to hexToNumber unchecked.
  it("finalized tag's block has a non-hex number field -> railVerified null, never throws", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcResult(2, { number: "not-hex", hash: BLOCK_HASH }) },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
  });

  it("rpc lacks the finalized tag and no fallbackConfirmations is configured -> fail closed", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcError(2, -32601, "unsupported") },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("rpc lacks the finalized tag and no fallbackConfirmations is configured");
    expect(result.rail).toBeUndefined();
  });

  it("finalized tag returns null (no such block yet) and no fallback -> fail closed the same way", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcResult(2, null) },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc lacks the finalized tag/);
  });

  it("finalized tag returns a block with no hash and no fallback -> fail closed", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcResult(2, { number: "0x5", hash: null }) },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
  });

  it("tag rejected but fallbackConfirmations configured -> falls back to latest-N, confirmations-N finalizedRef", async () => {
    const configWithFallback: EvmRailConfig = {
      ...CONFIG,
      pin: { ...PIN, finality: { mode: "tag", tag: "finalized", fallbackConfirmations: 2 } },
    };
    const capture = buildCapture({
      config: configWithFallback, // A4: replay decodes per the config this was captured under
      finality: { mode: "tag", tag: "finalized" },
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcError(2, -32601, "unsupported") },
        { method: "eth_blockNumber", params: [], body: jsonRpcResult(3, "0x9") },
        {
          method: "eth_getBlockByNumber",
          params: ["0x7", false],
          body: jsonRpcResult(4, { number: "0x7", hash: FALLBACK_BLOCK_HASH }),
        },
        {
          method: "eth_call",
          params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(5, encodeLocksResult({ status: Status.Locked })),
        },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: configWithFallback, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.finalizedRef).toBe(`anvil-local:confirmations-2:7:${FALLBACK_BLOCK_HASH}`);
  });

  it("mode 'confirmations' always uses latest-N, regardless of any tag", async () => {
    const confirmationsConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 3 } } };
    const capture = buildCapture({
      config: confirmationsConfig, // A4: replay decodes per the config this was captured under
      finality: { mode: "confirmations", confirmations: 3 },
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "0x7a69") },
        { method: "eth_blockNumber", params: [], body: jsonRpcResult(2, "0xa") },
        {
          method: "eth_getBlockByNumber",
          params: ["0x7", false],
          body: jsonRpcResult(3, { number: "0x7", hash: FALLBACK_BLOCK_HASH }),
        },
        {
          method: "eth_call",
          params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(4, encodeLocksResult({ status: Status.Locked })),
        },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: confirmationsConfig, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.finalizedRef).toBe(`anvil-local:confirmations-3:7:${FALLBACK_BLOCK_HASH}`);
  });
});

describe("evmEvidence — the eth_call read itself", () => {
  it("missing/tampered capture (no eth_call exchange at all) -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ omitCall: true }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("every capture byte is missing (tampered/never written) -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const tampered: EvmCapture = { index: capture.index, bytes: new Map() };
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: tampered });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("eth_call rpc error -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callError: true }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc rejected eth_call/);
  });

  it("malformed locks() result (not valid ABI-encoded output) -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: "0x1234" as Hex }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("malformed locks() result");
  });
});

describe("evmEvidence — on-chain status", () => {
  it("status None -> railVerified null, 'no lock at the finalized view', no rail", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.None }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("no lock at the finalized view");
    expect(result.rail).toBeUndefined();
  });

  it("status Claimed -> railVerified false, rail observation claimed/final", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Claimed }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "claimed", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
  });

  it("status Refunded -> railVerified false, rail observation refunded/final", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Refunded }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "refunded", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
  });

  // P22-P24-EVM-FIXES.md A2: an on-chain status outside 0..3 (the contract's own declared
  // range) must never be silently treated as Locked — it decodes to "malformed", not a guess.
  it("status 7 (outside the contract's declared range) -> railVerified null, 'unknown status', no rail", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: 7 }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("malformed locks() result (unknown status)");
    expect(result.rail).toBeUndefined();
  });
});

describe("evmEvidence — Locked branch field-by-field compare", () => {
  it("payee has no account line -> railVerified null, rail still reported", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: { payer: PAYER }, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("payee has no account line");
    expect(result.rail?.status).toBe("locked");
  });

  it("asset has no configured token address -> railVerified null, rail still reported", async () => {
    const noAssetConfig: EvmRailConfig = { ...CONFIG, assets: {} };
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: noAssetConfig, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/has no configured token address/);
    expect(result.rail?.status).toBe("locked");
  });

  it.each([
    ["payee", { payee: OTHER }, /payee differs/],
    ["token", { token: OTHER }, /token differs/],
    ["amount", { amount: BigInt(TERMS.amount) + 1n }, /amount differs/],
    ["claimByMs", { claimByMs: BigInt(TERMS.claimByMs) + 1n }, /claimByMs differs/],
    ["refundAfterMs", { refundAfterMs: BigInt(TERMS.refundAfterMs) + 1n }, /refundAfterMs differs/],
    ["payer", { payer: OTHER }, /payer differs/],
  ] as const)("%s mismatch -> railVerified false, rail still reported", async (_label, overrides, pattern) => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked, ...overrides }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(pattern);
    expect(result.rail?.status).toBe("locked");
  });

  it("payer mismatch is NOT checked when the payer account line is unbound", async () => {
    const capture = buildCapture({
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked, payer: OTHER }) }),
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: { payee: PAYEE }, capture });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.reason).toMatch(/payer unbound/);
  });

  it("addresses compare case-insensitively (isAddressEqual)", async () => {
    const upper = PAYEE.toUpperCase().replace("0X", "0x") as Address;
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked, payee: upper }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(true);
  });
});

describe("captureEvmLeg + evmEvidence — live vs replay equivalence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flop-swap-desk-evm-evidence-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("the same captured bytes produce identical evidence live (in-memory) and replayed (from disk)", async () => {
    const callResult = encodeLocksResult({ status: Status.Locked });
    let nextId = 1;
    const responses: Record<string, string> = {
      eth_chainId: jsonRpcResult(0, "0x7a69"),
      eth_getBlockByNumber: jsonRpcResult(0, { number: "0x5", hash: BLOCK_HASH }),
      eth_call: jsonRpcResult(0, callResult),
    };
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number };
      nextId += 1;
      const template = JSON.parse(responses[body.method] ?? "{}") as { result: unknown };
      return { text: async () => jsonRpcResult(body.id, template.result) } as Response;
    }) as typeof fetch;

    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index, exchanges } = await captureEvmLeg(rpc, CONFIG, HASH_LOCK, CHECKED_AT_MS);
    expect(nextId).toBeGreaterThan(1);

    const liveCapture: EvmCapture = {
      index,
      bytes: new Map(exchanges.map((e) => [e.responseSha256, new TextEncoder().encode(e.responseBody)])),
    };
    const liveResult = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: liveCapture });
    expect(liveResult.lock.railVerified).toBe(true);

    await writeCapture(root, exchanges);
    const replayBytes = new Map(
      await Promise.all(
        index.exchanges.map(async (e): Promise<[string, Uint8Array | null]> => {
          const body = await readCapture(root, e.responseSha256);
          return [e.responseSha256, body === null ? null : new TextEncoder().encode(body)];
        }),
      ),
    );
    const replayCapture: EvmCapture = { index, bytes: replayBytes };
    const replayResult = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: replayCapture });

    expect(replayResult).toEqual(liveResult);
  });
});

// P22-P24-EVM-FIXES.md A1: every exchange this decodes from must be bound to what it actually
// claims to be — never merely trusted because a candidate exchange's own (editable) `.method`/
// `.params` metadata said so. Each test below tampers exactly one thing a real attacker could
// edit in the index file and confirms the leg comes back unverified, never thrown.
describe("evmEvidence — A1: bind every exchange to its request", () => {
  it("a genuine response from a different exchange spliced in as the eth_call's own -> unverified (id mismatch)", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const blockSha = capture.index.exchanges[1]!.responseSha256;
    const spliced: EvmCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) => (i === 2 ? { ...exchange, responseSha256: blockSha } : exchange)),
    };
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: spliced, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("the finalized-tag exchange's own requestBody was rewritten to ask for latest instead -> unverified", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const tamperedExchanges = capture.index.exchanges.map((exchange, i) =>
      i === 1
        ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: ["latest", false] }) }
        : exchange,
    );
    const tampered: EvmCaptureIndex = { ...capture.index, exchanges: tamperedExchanges };
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: tampered, bytes: capture.bytes } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("the eth_call request targets a different contract than config.contract -> unverified", () => {
    const wrongTo = addr("a-sneaky-contract");
    const exchanges = standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }).map((spec) =>
      spec.method === "eth_call" ? { ...spec, params: [{ to: wrongTo, data: locksCallData(HASH_LOCK) }, { blockHash: BLOCK_HASH }] } : spec,
    );
    const capture = buildCapture({ exchanges });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this deployment's contract/);
  });

  it("the eth_call request encodes a different hashLock's calldata -> unverified", () => {
    const wrongHashLock = "0x" + "77".repeat(32);
    const exchanges = standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }).map((spec) =>
      spec.method === "eth_call" ? { ...spec, params: [{ to: CONFIG.contract, data: locksCallData(wrongHashLock) }, { blockHash: BLOCK_HASH }] } : spec,
    );
    const capture = buildCapture({ exchanges });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not encode locks\(hashLock\)/);
  });

  it("the eth_call request is pinned to a different block hash than the finalized view -> unverified", () => {
    const wrongHash = ("0x" + "99".repeat(32)) as Hex;
    const exchanges = standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }).map((spec) =>
      spec.method === "eth_call" ? { ...spec, params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: wrongHash }] } : spec,
    );
    const capture = buildCapture({ exchanges });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/not pinned to the finalized block/);
  });
});

// P22-P24-EVM-FIXES.md A4: a capture's own config (frozen at capture time) must agree with the
// auditor's supplied config on chain id, contract and this leg's asset — otherwise a later
// rails.json edit could silently change how an old capture replays.
describe("evmEvidence — A4: the capture's own config must match the auditor's", () => {
  it("captured config's pin.chainId differs from the auditor's -> railVerified null", () => {
    const capturedConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, chainId: 84532 } };
    const capture = buildCapture({ config: capturedConfig, exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture was taken under a different rail config/);
  });

  it("captured config's contract differs from the auditor's -> railVerified null", () => {
    const capturedConfig: EvmRailConfig = { ...CONFIG, contract: addr("a-different-contract") };
    const capture = buildCapture({ config: capturedConfig, exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture was taken under a different rail config/);
  });

  it("captured config's asset token address differs from the auditor's -> railVerified null", () => {
    const capturedConfig: EvmRailConfig = { ...CONFIG, assets: { USDC: addr("a-different-usdc") } };
    const capture = buildCapture({ config: capturedConfig, exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture was taken under a different rail config/);
  });

  it("a pre-A4 capture with no config field at all -> railVerified null, never trusted implicitly", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const noConfigIndex = { ...capture.index } as Partial<EvmCaptureIndex>;
    delete noConfigIndex.config;
    const result = evmEvidence({
      terms: TERMS,
      config: CONFIG,
      accounts: ACCOUNTS,
      capture: { index: noConfigIndex as EvmCaptureIndex, bytes: capture.bytes },
    });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no usable config/);
  });

  it("captured config's finality is malformed (confirmations <= 0) -> railVerified null", () => {
    const capturedConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 0 } } };
    const capture = buildCapture({ config: capturedConfig, exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/finality config is malformed/);
  });
});
