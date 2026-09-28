// SPDX-License-Identifier: MIT
//
// tests/evm-evidence.test.ts — P22-P24-EVM-SPEC.md §4: synthetic ABI-encoded responses (built
// with viem's own encoders) covering every branch of `evmEvidence`'s fail-closed decode, plus
// live-vs-replay equivalence: the same bytes, captured live and reloaded from disk, must
// produce byte-identical evidence.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  loadEvmCapture,
  type EvmAccounts,
  type EvmCapture,
  type EvmCaptureIndex,
  type EvmCaptureIndexExchange,
} from "../src/rails/evm-evidence.js";

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function jsonRpcError(id: number | string, code: number, message: string): string {
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

/** P22-P24-EVM-FIXES-R2.md D1: the capture-bound id format every real capture now uses
 *  (`CapturingRpc.setIdNamespace`) — `"<hashLock>:<checkedAtMs>:<n>"` — so `bindExchange`'s new
 *  "id is bound to this capture" check passes for every fixture in this file that isn't
 *  deliberately tampering something else first. */
function evmId(n: number, hashLock: string = HASH_LOCK, checkedAtMs: number = CHECKED_AT_MS): string {
  return `${hashLock}:${checkedAtMs}:${n}`;
}

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
      requestBody: JSON.stringify({ jsonrpc: "2.0", id: evmId(i + 1, opts.hashLock ?? HASH_LOCK), method: spec.method, params: spec.params }),
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
        ? jsonRpcError(evmId(1), -32601, "method not found")
        : jsonRpcResult(evmId(1), `0x${(opts.chainId ?? PIN.chainId).toString(16)}`),
    },
  ];
  if (!opts.omitBlock) {
    specs.push({
      method: "eth_getBlockByNumber",
      params: ["finalized", false],
      body:
        opts.blockHash === null
          ? jsonRpcResult(evmId(2), null)
          : jsonRpcResult(evmId(2), { number: "0x5", hash: opts.blockHash ?? BLOCK_HASH }),
    });
  }
  if (!opts.omitCall) {
    specs.push({
      method: "eth_call",
      params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: opts.blockHash ?? BLOCK_HASH }],
      body: opts.callError ? jsonRpcError(evmId(3), -32000, "execution reverted") : jsonRpcResult(evmId(3), opts.callResult ?? "0x"),
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

  // P22-P24-EVM-FIXES-R2.md D4: the reviewer's demonstration — a captured contract address that
  // isn't even shaped like an address must fail this leg closed, never throw out of evmEvidence
  // (viem's `isAddressEqual` throws `InvalidAddressError` on anything that fails `isAddress`).
  it("index.contract is 'nope' (not a valid address at all) -> railVerified null, never throws", async () => {
    const capture = buildCapture({
      contract: "nope" as Address,
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }),
    });
    expect(() => evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture })).not.toThrow();
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/not a valid address/);
  });

  // D4: the same guard on the eth_call request's own `to` field — a wrong-length hex string
  // used to sail past the old generic `HEX_VALUE` regex and reach (and crash) `isAddressEqual`.
  it("eth_call request's own 'to' is hex but the wrong length for an address -> railVerified null, never throws", () => {
    const exchanges = standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }).map((spec) =>
      spec.method === "eth_call" ? { ...spec, params: [{ to: "0x1234", data: locksCallData(HASH_LOCK) }, { blockHash: BLOCK_HASH }] } : spec,
    );
    const capture = buildCapture({ exchanges });
    expect(() => evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture })).not.toThrow();
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not target this deployment's contract/);
  });

  // P22-P24-EVM-FIXES.md A2: every hex value is validated before hexToNumber — never a thrown
  // exception on captured data.
  it("eth_chainId result is null (not a hex string at all) -> railVerified null, never throws", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), null) },
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
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), "not-hex-at-all") },
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
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcResult(evmId(2), { number: "not-hex", hash: BLOCK_HASH }) },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
  });

  it("rpc lacks the finalized tag and no fallbackConfirmations is configured -> fail closed", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcError(evmId(2), -32601, "unsupported") },
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
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcResult(evmId(2), null) },
      ],
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc lacks the finalized tag/);
  });

  it("finalized tag returns a block with no hash and no fallback -> fail closed", async () => {
    const capture = buildCapture({
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcResult(evmId(2), { number: "0x5", hash: null }) },
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
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), "0x7a69") },
        { method: "eth_getBlockByNumber", params: ["finalized", false], body: jsonRpcError(evmId(2), -32601, "unsupported") },
        { method: "eth_blockNumber", params: [], body: jsonRpcResult(evmId(3), "0x9") },
        {
          method: "eth_getBlockByNumber",
          params: ["0x7", false],
          body: jsonRpcResult(evmId(4), { number: "0x7", hash: FALLBACK_BLOCK_HASH }),
        },
        {
          method: "eth_call",
          params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(evmId(5), encodeLocksResult({ status: Status.Locked })),
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
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), "0x7a69") },
        { method: "eth_blockNumber", params: [], body: jsonRpcResult(evmId(2), "0xa") },
        {
          method: "eth_getBlockByNumber",
          params: ["0x7", false],
          body: jsonRpcResult(evmId(3), { number: "0x7", hash: FALLBACK_BLOCK_HASH }),
        },
        {
          method: "eth_call",
          params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(evmId(4), encodeLocksResult({ status: Status.Locked })),
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

// P22-P24-EVM-FIXES-R2.md D1: "the locks() tuple keeps [payee, token, amount, claimByMs,
// refundAfterMs, payer] after the status changes" — a genuine read of *this* hashLock's own
// claimed/refunded state must still show those fields matching terms/accounts, the same
// field-by-field compare the Locked branch already does. `src/swap.ts`'s
// `settlementViewForLeg` trusts `rail.status` ahead of `railVerified`, so this is what actually
// stops an inconsistent (or, absent D1's id-binding fix, substituted) read from reporting a leg
// claimed/refunded that was never really this swap's own lock.
describe("evmEvidence — D1: Claimed/Refunded also compare the locks() tuple", () => {
  it("status Claimed but on-chain payee differs from the account line -> railVerified null, no rail asserted", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Claimed, payee: OTHER }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.rail).toBeUndefined();
    expect(result.lock.reason).toMatch(/reports claimed, but its other fields do not match/);
  });

  it("status Refunded but the on-chain amount differs from terms -> railVerified null, no rail asserted", async () => {
    const capture = buildCapture({
      exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Refunded, amount: BigInt(TERMS.amount) + 1n }) }),
    });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.rail).toBeUndefined();
    expect(result.lock.reason).toMatch(/reports refunded, but its other fields do not match/);
  });

  it("status Claimed with no payee account line -> railVerified null, no rail asserted (cannot confirm it is this swap's own lock)", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Claimed }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: { payer: PAYER }, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.rail).toBeUndefined();
  });

  it("status Refunded, fields all match -> unaffected: still railVerified false, rail refunded/final", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Refunded }) }) });
    const result = await evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "refunded", final: true, checkedAtMs: CHECKED_AT_MS, finalizedRef: FINALIZED_REF });
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
      const text = jsonRpcResult(body.id, template.result);
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;

    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index, exchanges } = await captureEvmLeg(rpc, CONFIG, HASH_LOCK, CHECKED_AT_MS);
    expect(nextId).toBeGreaterThan(1);

    // D2: the in-memory map is built straight from each exchange's own `responseBytes` — never
    // a re-encode of `responseBody` (lossy for anything that isn't valid UTF-8).
    const liveCapture: EvmCapture = {
      index,
      bytes: new Map(exchanges.map((e) => [e.responseSha256, e.responseBytes])),
    };
    const liveResult = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: liveCapture });
    expect(liveResult.lock.railVerified).toBe(true);

    await writeCapture(root, exchanges);
    const replayBytes = new Map(
      await Promise.all(
        index.exchanges.map(async (e): Promise<[string, Uint8Array | null]> => {
          // D2: `readCapture` now hands back the exact re-verified bytes directly.
          return [e.responseSha256, await readCapture(root, e.responseSha256)];
        }),
      ),
    );
    const replayCapture: EvmCapture = { index, bytes: replayBytes };
    const replayResult = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: replayCapture });

    expect(replayResult).toEqual(liveResult);
  });

  // P22-P24-EVM-FIXES-R2.md D2: "a response with a UTF-8 BOM or an invalid byte gives the same
  // verdict live and in replay" — a byte that is not valid UTF-8 at all must fail closed
  // identically on both sides, never differently because one side went through a lossy
  // decode-then-re-encode string round trip and the other didn't.
  it("a response containing a byte that is not valid UTF-8 fails closed identically live and replayed", async () => {
    // A genuine UTF-8 BOM (EF BB BF) followed by a lone continuation byte (0x80) standing in
    // for the eth_call response — not valid UTF-8 at any position, so a non-fatal decode would
    // silently replace it with U+FFFD (which would re-encode to *different* bytes than these).
    const invalidUtf8 = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x80, 0x7d]);
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: string };
      if (body.method === "eth_call") {
        return { text: async () => "", arrayBuffer: async () => invalidUtf8.buffer } as Response;
      }
      const text = jsonRpcResult(body.id, body.method === "eth_chainId" ? "0x7a69" : { number: "0x5", hash: BLOCK_HASH });
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;

    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: fetchImpl, clock: () => CHECKED_AT_MS });
    const { index, exchanges } = await captureEvmLeg(rpc, CONFIG, HASH_LOCK, CHECKED_AT_MS);

    const liveCapture: EvmCapture = { index, bytes: new Map(exchanges.map((e) => [e.responseSha256, e.responseBytes])) };
    const liveResult = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: liveCapture });
    expect(liveResult.lock.railVerified).toBeNull();
    expect(liveResult.lock.reason).toMatch(/missing\/tampered capture/);

    await writeCapture(root, exchanges);
    const replayBytes = new Map(
      await Promise.all(
        index.exchanges.map(async (e): Promise<[string, Uint8Array | null]> => [e.responseSha256, await readCapture(root, e.responseSha256)]),
      ),
    );
    const replayResult = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index, bytes: replayBytes } });

    expect(replayResult).toEqual(liveResult);
  });
});

// P22-P24-EVM-FIXES-R2.md D5: `captureEvmLeg` parses every live value with the same guard the
// replay-side decoder uses on captured data — never a bare `hexToNumber`/`numberToHex`, both of
// which throw. A malformed value, or `latest < confirmations`, stops reading and returns
// whatever was captured so far (never a thrown exception out of a live sweep).
describe("captureEvmLeg — D5: never throws on bad live chain data", () => {
  function fetchReturning(bodiesByMethod: Record<string, string>): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      const text = bodiesByMethod[body.method] ?? jsonRpcResult("0", null);
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
  }

  it("a malformed eth_chainId result (not hex) never throws; returns the one exchange captured so far", async () => {
    const fetchImpl = fetchReturning({ eth_chainId: jsonRpcResult(evmId(1), "not-hex-at-all") });
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => CHECKED_AT_MS });

    const { index, exchanges } = await captureEvmLeg(rpc, CONFIG, HASH_LOCK, CHECKED_AT_MS);

    expect(exchanges).toHaveLength(1);
    expect(index.chainId).toBe(0);
    expect(index.exchanges).toHaveLength(1);
    expect(index.exchanges[0]?.method).toBe("eth_chainId");
  });

  it("confirmations mode: a malformed eth_blockNumber result never throws; stops after chainId", async () => {
    const confirmationsConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 2 } } };
    const fetchImpl = fetchReturning({
      eth_chainId: jsonRpcResult(evmId(1), `0x${PIN.chainId.toString(16)}`),
      eth_blockNumber: jsonRpcResult(evmId(2), "not-hex-either"),
    });
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => CHECKED_AT_MS });

    const { index, exchanges } = await captureEvmLeg(rpc, confirmationsConfig, HASH_LOCK, CHECKED_AT_MS);

    expect(exchanges).toHaveLength(2); // eth_chainId + eth_blockNumber — never reaches eth_call
    expect(index.chainId).toBe(PIN.chainId);
    expect(index.exchanges.map((e) => e.method)).toEqual(["eth_chainId", "eth_blockNumber"]);
  });

  it("confirmations mode: latest < confirmations never sends a negative block number, never throws", async () => {
    const confirmationsConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 5 } } };
    const fetchImpl = fetchReturning({
      eth_chainId: jsonRpcResult(evmId(1), `0x${PIN.chainId.toString(16)}`),
      eth_blockNumber: jsonRpcResult(evmId(2), "0x2"), // latest = 2, confirmations = 5
    });
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl, clock: () => CHECKED_AT_MS });

    const { index, exchanges } = await captureEvmLeg(rpc, confirmationsConfig, HASH_LOCK, CHECKED_AT_MS);

    // Never an eth_getBlockByNumber call at all — n would have been negative.
    expect(index.exchanges.map((e) => e.method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    expect(exchanges).toHaveLength(2);

    // The partial capture still fails closed identically on replay.
    const bytes = new Map(exchanges.map((e) => [e.responseSha256, e.responseBytes]));
    const result = evmEvidence({ terms: TERMS, config: confirmationsConfig, accounts: ACCOUNTS, capture: { index, bytes } });
    expect(result.lock.railVerified).toBeNull();
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

// P22-P24-EVM-FIXES-R2.md D1: JSON-RPC ids restart at 1 (or at "n" for any fixed namespace)
// per `CapturingRpc` instance/session, so a genuine response captured under a *different*
// hashLock/checkedAtMs could otherwise be spliced into this capture's index — with a forged
// request whose id is simply copied verbatim off that borrowed response — and still "bind"
// (A1's own checks: method/params echo correctly, and the response id equals the request id).
// Only tying every id to the specific capture it was minted for (`CapturingRpc.setIdNamespace`,
// `idBoundToCapture`) catches this. These are "the reviewer's swap": a genuine refunded
// capture's own locks() response spliced into a settled copy, and the reverse.
describe("evmEvidence — D1: ids are bound to their own capture, not merely internally consistent", () => {
  const OTHER_HASH_LOCK = "0x" + "55".repeat(32);
  const OTHER_CHECKED_AT_MS = CHECKED_AT_MS + 5_000;

  /** The strongest splice an attacker who can edit only the index file (never mint a real RPC
   *  response) can mount: `responseSha256` points at a *genuine* eth_call response real bytes
   *  really produced — for a different swap's own capture (`OTHER_HASH_LOCK`/
   *  `OTHER_CHECKED_AT_MS`) — while the forged `requestBody`/`params` around it are freely
   *  authored to look exactly like *this* capture's own eth_call (the right contract, the right
   *  hashLock's calldata, the right finalized block hash), with the id copied verbatim off the
   *  borrowed response so the plain "response id equals request id" check still holds. */
  function spliceInGenuineOtherCall(status: number): { exchange: EvmCaptureIndexExchange; bytes: [string, Uint8Array] } {
    const genuineOtherId = evmId(3, OTHER_HASH_LOCK, OTHER_CHECKED_AT_MS);
    const genuineOtherBody = jsonRpcResult(genuineOtherId, encodeLocksResult({ status }));
    const sha = sha256Hex(genuineOtherBody);
    const params = [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: BLOCK_HASH }];
    const exchange: EvmCaptureIndexExchange = {
      method: "eth_call",
      params,
      requestBody: JSON.stringify({ jsonrpc: "2.0", id: genuineOtherId, method: "eth_call", params }),
      responseSha256: sha,
      atMs: CHECKED_AT_MS,
    };
    return { exchange, bytes: [sha, new TextEncoder().encode(genuineOtherBody)] };
  }

  it("the refunded fixture's genuine locks() response spliced into a settled copy fails closed, never silently refunded", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const { exchange: forgedCall, bytes: donorBytes } = spliceInGenuineOtherCall(Status.Refunded);
    const bytes = new Map(capture.bytes);
    bytes.set(...donorBytes);
    const splicedIndex: EvmCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) => (i === 2 ? forgedCall : exchange)),
    };

    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: splicedIndex, bytes } });
    expect(result.lock.railVerified).not.toBe(true);
    expect(result.rail).toBeUndefined(); // never asserts "refunded" for this swap
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
    expect(result.lock.reason).toMatch(/not bound to this capture/);
  });

  it("the reverse: a settled fixture's genuine Locked response spliced into a refunded copy fails closed, never silently locked", () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Refunded }) }) });
    const { exchange: forgedCall, bytes: donorBytes } = spliceInGenuineOtherCall(Status.Locked);
    const bytes = new Map(capture.bytes);
    bytes.set(...donorBytes);
    const splicedIndex: EvmCaptureIndex = {
      ...capture.index,
      exchanges: capture.index.exchanges.map((exchange, i) => (i === 2 ? forgedCall : exchange)),
    };

    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture: { index: splicedIndex, bytes } });
    expect(result.lock.railVerified).not.toBe(true);
    expect(result.rail).toBeUndefined(); // never asserts "locked" (let alone verified) for this swap
    expect(result.lock.reason).toMatch(/missing\/tampered capture/);
    expect(result.lock.reason).toMatch(/not bound to this capture/);
  });
});

// P22-P24-EVM-FIXES.md A4: a capture's own config (frozen at capture time) must agree with the
// auditor's supplied config on chain id, contract and this leg's asset — otherwise a later
// rails.json edit could silently change how an old capture replays.
describe("evmEvidence — A4: the capture's own config must match the auditor's", () => {
  it("captured config's pin.chainId differs from the auditor's -> railVerified null", () => {
    // A self-consistent (shape-valid) captured config pinned to the *other* allow-listed chain
    // id, so this exercises the A4 cross-check specifically, not D3's `checkEvmRailConfig` shape
    // gate (a chainId/caip2 mismatch within the captured config itself is covered separately).
    const capturedConfig: EvmRailConfig = {
      ...CONFIG,
      pin: { chainId: 84532, name: "base-sepolia", caip2: "eip155:84532", finality: PIN.finality },
    };
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
    expect(result.lock.reason).toMatch(/capture's own config is invalid/);
  });

  it("captured config's finality is malformed (confirmations <= 0) -> railVerified null", () => {
    const capturedConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 0 } } };
    const capture = buildCapture({ config: capturedConfig, exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture's own config is invalid.*positive integer/);
  });
});

// P22-P24-EVM-FIXES-R2.md D3: a captured config's finality may never be *weaker* than the
// auditor's own — the reviewer's demonstration was editing the index's own `pin.finality.tag`
// to `"latest"` (paired with a genuine `eth_getBlockByNumber("latest", false)` capture, always
// obtainable, unlike a true "finalized" read) so a barely-confirmed, reorg-prone block would be
// treated as though it were genuinely finalized.
describe("evmEvidence — D3: a captured finality can never be weaker than the auditor's", () => {
  it("the reviewer's tag: 'latest' edit -> railVerified null, never treated as finalized", () => {
    const capturedConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "tag", tag: "latest" as "finalized" } } };
    const capture = buildCapture({
      config: capturedConfig,
      finality: { mode: "tag", tag: "latest" as "finalized" },
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), `0x${PIN.chainId.toString(16)}`) },
        {
          method: "eth_getBlockByNumber",
          params: ["latest", false],
          body: jsonRpcResult(evmId(2), { number: "0x5", hash: BLOCK_HASH }),
        },
        {
          method: "eth_call",
          params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: BLOCK_HASH }],
          body: jsonRpcResult(evmId(3), encodeLocksResult({ status: Status.Locked })),
        },
      ],
    });
    const result = evmEvidence({ terms: TERMS, config: CONFIG, accounts: ACCOUNTS, capture });
    // `"latest"` is not even a valid tag value at all (checkEvmRailConfig's shape check, run on
    // the captured config per D3, already refuses it on its own) — whichever specific check
    // catches it, the edited capture must never be treated as finalized.
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/capture's own config is invalid/);
    expect(result.rail).toBeUndefined();
  });

  it("a confirmations count raised above the auditor's is still accepted (stronger, not weaker)", () => {
    const confirmationsConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 2 } } };
    const capturedConfig: EvmRailConfig = { ...confirmationsConfig, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 5 } } };
    const capture = buildCapture({
      config: capturedConfig,
      finality: { mode: "confirmations", confirmations: 5 },
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), `0x${PIN.chainId.toString(16)}`) },
        { method: "eth_blockNumber", params: [], body: jsonRpcResult(evmId(2), "0xa") },
        {
          method: "eth_getBlockByNumber",
          params: ["0x5", false],
          body: jsonRpcResult(evmId(3), { number: "0x5", hash: FALLBACK_BLOCK_HASH }),
        },
        {
          method: "eth_call",
          params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(evmId(4), encodeLocksResult({ status: Status.Locked })),
        },
      ],
    });
    const result = evmEvidence({ terms: TERMS, config: confirmationsConfig, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(true);
  });

  it("a confirmations count lowered below the auditor's is refused (weaker)", () => {
    const confirmationsConfig: EvmRailConfig = { ...CONFIG, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 5 } } };
    const capturedConfig: EvmRailConfig = { ...confirmationsConfig, pin: { ...PIN, finality: { mode: "confirmations", confirmations: 1 } } };
    const capture = buildCapture({
      config: capturedConfig,
      finality: { mode: "confirmations", confirmations: 1 },
      exchanges: [
        { method: "eth_chainId", params: [], body: jsonRpcResult(evmId(1), `0x${PIN.chainId.toString(16)}`) },
        { method: "eth_blockNumber", params: [], body: jsonRpcResult(evmId(2), "0x6") },
        {
          method: "eth_getBlockByNumber",
          params: ["0x5", false],
          body: jsonRpcResult(evmId(3), { number: "0x5", hash: FALLBACK_BLOCK_HASH }),
        },
        {
          method: "eth_call",
          params: [{ to: CONFIG.contract, data: locksCallData(HASH_LOCK) }, { blockHash: FALLBACK_BLOCK_HASH }],
          body: jsonRpcResult(evmId(4), encodeLocksResult({ status: Status.Locked })),
        },
      ],
    });
    const result = evmEvidence({ terms: TERMS, config: confirmationsConfig, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/finality is weaker than the auditor/);
  });

  it("the captured config's own endpoint and pin name are what LockEvidence reports, not the auditor's", () => {
    const capturedConfig: EvmRailConfig = { ...CONFIG, endpoint: "http://captured-endpoint:1234", pin: { ...PIN, name: "captured-pin-name" } };
    const auditorConfig: EvmRailConfig = { ...CONFIG, endpoint: "http://auditor-endpoint:5678" };
    const capture = buildCapture({ config: capturedConfig, exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    const result = evmEvidence({ terms: TERMS, config: auditorConfig, accounts: ACCOUNTS, capture });
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.endpoint).toBe("http://captured-endpoint:1234");
    expect(result.lock.finalizedRef).toBe(`captured-pin-name:finalized:5:${BLOCK_HASH}`);
  });
});

// P22-P24-EVM-FIXES.md A5: `loadEvmCapture` (the one place a replay reads `raw/evm/<hashLock>/
// *.json` off disk) must never trust "the lexicographically last filename" blindly — only
// `*.json` files are candidates (never a `*.tmp-*` write-in-progress leftover), each candidate
// is parsed and shape-checked before use, and a bad *latest* file falls back to the newest one
// that actually validates rather than failing the whole hashLock closed.
describe("loadEvmCapture — A5: defensive index loading", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flop-swap-desk-load-evm-capture-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeIndexFile(name: string, index: unknown): Promise<void> {
    const dir = join(root, "raw", "evm", HASH_LOCK);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), typeof index === "string" ? index : JSON.stringify(index));
  }

  async function writeRawRpc(bytes: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const dir = join(root, "raw", "rpc");
    await mkdir(dir, { recursive: true });
    for (const [sha, body] of bytes) await writeFile(join(dir, `${sha}.json`), body);
  }

  it("no capture directory at all -> capture null, nothing skipped", async () => {
    await expect(loadEvmCapture(root, HASH_LOCK)).resolves.toEqual({ capture: null, skipped: [] });
  });

  it("a real, valid index loads with pre-verified bytes and nothing skipped", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    await writeRawRpc(capture.bytes);
    await writeIndexFile("2026-09-28T00-00-00.000Z.json", capture.index);

    const result = await loadEvmCapture(root, HASH_LOCK);
    expect(result.skipped).toEqual([]);
    expect(result.capture?.index.hashLock).toBe(HASH_LOCK);
  });

  it("ignores a *.tmp-* write-in-progress leftover from an interrupted atomic write (never even a candidate)", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    await writeRawRpc(capture.bytes);
    await writeIndexFile("2026-09-28T00-00-00.000Z.json", capture.index);
    // The exact shape `writeFileAtomic` (src/watcher.ts / rpc-capture.ts) leaves behind if a
    // process dies between its write() and its rename() — lexically after the real file, but
    // never a candidate.
    await writeIndexFile("2026-09-28T00-00-01.000Z.json.tmp-4242-xy1", "{{{ not even close to json");

    const result = await loadEvmCapture(root, HASH_LOCK);
    expect(result.skipped).toEqual([]);
    expect(result.capture?.index.hashLock).toBe(HASH_LOCK);
  });

  it("ignores a non-.json file in the directory entirely (never counted as skipped)", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    await writeRawRpc(capture.bytes);
    await writeIndexFile("2026-09-28T00-00-00.000Z.json", capture.index);
    await writeIndexFile("README.txt", "not an index at all");

    const result = await loadEvmCapture(root, HASH_LOCK);
    expect(result.skipped).toEqual([]);
    expect(result.capture).not.toBeNull();
  });

  it("falls back to the newest *valid* file when the newest one is corrupted JSON, with a note", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    await writeRawRpc(capture.bytes);
    await writeIndexFile("2026-09-28T00-00-00.000Z.json", capture.index); // older, valid
    await writeIndexFile("2026-09-28T00-00-01.000Z.json", "{ this is not valid json"); // newer, corrupt

    const result = await loadEvmCapture(root, HASH_LOCK);
    expect(result.skipped).toEqual(["2026-09-28T00-00-01.000Z.json"]);
    expect(result.capture?.index.hashLock).toBe(HASH_LOCK);
  });

  it("falls back to the newest valid file when the newest one fails shape validation (wrong hashLock)", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    await writeRawRpc(capture.bytes);
    await writeIndexFile("2026-09-28T00-00-00.000Z.json", capture.index); // older, valid
    await writeIndexFile("2026-09-28T00-00-01.000Z.json", { ...capture.index, hashLock: "0x" + "ff".repeat(32) }); // newer: wrong hashLock

    const result = await loadEvmCapture(root, HASH_LOCK);
    expect(result.skipped).toEqual(["2026-09-28T00-00-01.000Z.json"]);
    expect(result.capture?.index.hashLock).toBe(HASH_LOCK);
  });

  it("falls back to the newest valid file when the newest one fails shape validation (wrong v/rail, malformed exchanges)", async () => {
    const capture = buildCapture({ exchanges: standardExchanges({ callResult: encodeLocksResult({ status: Status.Locked }) }) });
    await writeRawRpc(capture.bytes);
    await writeIndexFile("2026-09-28T00-00-00.000Z.json", capture.index); // older, valid
    await writeIndexFile("2026-09-28T00-00-01.000Z.json", { ...capture.index, v: 2 }); // newer: wrong version
    await writeIndexFile("2026-09-28T00-00-02.000Z.json", { ...capture.index, exchanges: "not an array" }); // newest: malformed

    const result = await loadEvmCapture(root, HASH_LOCK);
    expect(result.skipped).toEqual(["2026-09-28T00-00-02.000Z.json", "2026-09-28T00-00-01.000Z.json"]);
    expect(result.capture?.index.hashLock).toBe(HASH_LOCK);
  });

  it("capture null and every candidate skipped when none validate -- fails this leg closed, never thrown", async () => {
    await writeIndexFile("2026-09-28T00-00-00.000Z.json", { v: 2, rail: "evm-htlc", hashLock: HASH_LOCK, exchanges: [] });
    await writeIndexFile("2026-09-28T00-00-01.000Z.json", "not even json");

    const result = await loadEvmCapture(root, HASH_LOCK);
    expect(result.capture).toBeNull();
    expect(result.skipped.sort()).toEqual(["2026-09-28T00-00-00.000Z.json", "2026-09-28T00-00-01.000Z.json"]);
  });
});
