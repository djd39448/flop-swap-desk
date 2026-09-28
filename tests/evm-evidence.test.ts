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
import { encodeFunctionResult, type Address, type Hex } from "viem";
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

function buildCapture(opts: {
  hashLock?: string;
  contract?: Address;
  chainId?: number;
  finality?: EvmCaptureIndex["finality"];
  exchanges: ExchangeSpec[];
}): EvmCapture {
  const bySha = new Map<string, string>();
  const exchanges: EvmCaptureIndexExchange[] = opts.exchanges.map((spec, i) => {
    const sha = sha256Hex(spec.body);
    bySha.set(sha, spec.body);
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
    exchanges,
  };
  return { index, load: (sha256Hex_) => bySha.get(sha256Hex_) ?? null };
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
      params: [{ to: CONFIG.contract, data: "0xdeadbeef" }, { blockHash: opts.blockHash ?? BLOCK_HASH }],
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
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });

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
      checkedAtMs: CHECKED_AT_MS,
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
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });

  it("terms.lock !== 'hash' -> railVerified false, no rail", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const pointTerms: LockTerms = { ...TERMS, lock: "point" };
    const result = await evmEvidence({ terms: pointTerms, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });
});

describe("evmEvidence — chain id and contract checks", () => {
  it("captured chain id differs from the pin -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ chainId: 84532, callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not match pin/);
  });

  it("eth_chainId exchange itself is an rpc error -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ chainIdError: true, callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc rejected eth_chainId/);
  });

  it("index.contract differs from config.contract -> railVerified null", async () => {
    const capture = buildCapture({
      contract: addr("a-different-contract"),
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }),
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/contract does not match/);
  });
});

describe("evmEvidence — finalized-view resolution", () => {
  it("rpc lacks the finalized tag and no fallbackConfirmations is configured -> fail closed", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(1, "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcError(2, -32601, "unsupported") },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
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
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
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
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
  });

  it("tag rejected but fallbackConfirmations configured -> falls back to latest-N, confirmations-N finalizedRef", async () => {
    const configWithFallback: EvmRailConfig = {
      ...CONFIG,
      pin: { ...PIN, finality: { mode: "tag", tag: "finalized", fallbackConfirmations: 2 } },
    };
    const capture = buildCapture({
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
          params: [{ to: CONFIG.contract, data: "0xdeadbeef" }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(5, encodeLocksResult({ status: Status.Locked })),
        },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: configWithFallback, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.finalizedRef).toBe(`anvil-local:confirmations-2:7:${FALLBACK_BLOCK_HASH}`);
  });

  it("mode 'confirmations' always uses latest-N, regardless of any tag", async () => {
    const confirmationsConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 3 } } };
    const capture = buildCapture({
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
          params: [{ to: CONFIG.contract, data: "0xdeadbeef" }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(4, encodeLocksResult({ status: Status.Locked })),
        },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: confirmationsConfig, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.finalizedRef).toBe(`anvil-local:confirmations-3:7:${FALLBACK_BLOCK_HASH}`);
  });
});

describe("evmEvidence — the eth_call read itself", () => {
  it("missing/tampered capture (no eth_call exchange at all) -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ omitCall: true }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("capture.load returns null for the eth_call exchange (tampered file) -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const tampered: EvmCapture = { index: capture.index, load: async () => null };
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: tampered, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
  });

  it("eth_call rpc error -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callError: true }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc rejected eth_call/);
  });

  it("malformed locks() result (not valid ABI-encoded output) -> railVerified null", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: "0x1234" as Hex }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("malformed locks() result");
  });
});

describe("evmEvidence — on-chain status", () => {
  it("status None -> railVerified null, 'no lock at the finalized view', no rail", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.None }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("no lock at the finalized view");
    expect(result.rail).toBeUndefined();
  });

  it("status Claimed -> railVerified false, rail observation claimed/final", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Claimed }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "claimed", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
  });

  it("status Refunded -> railVerified false, rail observation refunded/final", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Refunded }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "refunded", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
  });
});

describe("evmEvidence — Locked branch field-by-field compare", () => {
  it("payee has no account line -> railVerified null, rail still reported", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: { payer: PAYER }, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toBe("payee has no account line");
    expect(result.rail?.status).toBe("locked");
  });

  it("asset has no configured token address -> railVerified null, rail still reported", async () => {
    const noAssetConfig: EvmRailConfig = { ...CONFIG, assets: {} };
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = await evmEvidence({ terms: TERMS, config: noAssetConfig, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
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
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(pattern);
    expect(result.rail?.status).toBe("locked");
  });

  it("payer mismatch is NOT checked when the payer account line is unbound", async () => {
    const capture = buildCapture({
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked, payer: OTHER }) }),
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: { payee: PAYEE }, capture, checkedAtMs: CHECKED_AT_MS });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.reason).toMatch(/payer unbound/);
  });

  it("addresses compare case-insensitively (isAddressEqual)", async () => {
    const upper = PAYEE.toUpperCase().replace("0X", "0x") as Address;
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked, payee: upper }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture, checkedAtMs: CHECKED_AT_MS });
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
      load: (sha) => exchanges.find((e) => e.responseSha256 === sha)?.responseBody ?? null,
    };
    const liveResult = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: liveCapture, checkedAtMs: CHECKED_AT_MS });
    expect(liveResult.lock.railVerified).toBe(true);

    await writeCapture(root, exchanges);
    const replayCapture: EvmCapture = { index, load: (sha) => readCapture(root, sha) };
    const replayResult = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: replayCapture, checkedAtMs: CHECKED_AT_MS });

    expect(replayResult).toEqual(liveResult);
  });
});
