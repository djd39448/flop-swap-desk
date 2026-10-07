// SPDX-License-Identifier: MIT
//
// A fake read-only chain for the P9-6 hermetic tests (the rehearsal runner's pre-flight and dry run): it answers every read the
// pre-flight makes the way the public Base Sepolia endpoint does, with the knobs a test needs to break one answer at a time
// (a missing `finalized` tag, a block lag, an `eth_getLogs` range cap that counts both ends, a balance, a code, a clock). It has no
// write methods: `eth_sendRawTransaction` and `eth_sendTransaction` are answered with an error and recorded, so a test can assert
// that nothing was ever sent. The handlers are plain data -> data functions (`ScriptedHandler`, tests/helpers/scripted-rpc.ts), used
// directly through a stub `fetch` or behind a throwaway local HTTP server (`serveFakeChain`).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { keccak256, type Address, type Hex } from "viem";

import type { ScriptedHandler } from "./scripted-rpc.js";

/** A small stand-in for the escrow's runtime code (any bytes will do: the pre-flight only hashes them). */
export const FAKE_ESCROW_CODE: Hex = "0x6080604052348015600e575f5ffd5b50600436106100565760003560e01c8063ab12cd3414610059575b5f5ffd5b610061610063565b005b565bfea164736f6c6343000818000a";
export const FAKE_ESCROW_CODE_HASH: Hex = keccak256(FAKE_ESCROW_CODE);

export interface FakeChainOptions {
  chainId?: number;
  /** What `eth_getCode` answers for the escrow: a hex string, or "error" for a JSON-RPC error. Default `FAKE_ESCROW_CODE`. */
  code?: Hex | "error";
  headNumber?: bigint;
  /** The head block's timestamp in seconds. Default: a fixed instant, so the test passes the same instant as its clock. */
  headTimestampSec?: number;
  /** How far the `finalized` block trails the head, in blocks and seconds. Defaults: 600 blocks, 1200 s (Base Sepolia's order of magnitude). */
  finalizedLagBlocks?: bigint;
  finalizedLagSec?: number;
  /** `finalized` answers an error (a node without the tag). */
  noFinalizedTag?: boolean;
  /** The `pending` block: "ok" (a number and a hash), "bare" (a timestamp only, as some nodes answer), "error", or "null". */
  pending?: "ok" | "bare" | "error" | "null";
  /** Reading `locks()` at the finalized block's hash answers an error (a pruned node). */
  noStateAtFinalized?: boolean;
  /** What reading `locks()` at a block selected by hash answers INSTEAD of seven zero words: `"0x"` is what a node says for a block where the contract
   *  is not there yet (a deploy younger than the finalized lag); a short hex string is an answer that is no ABI row. */
  stateAtFinalizedAnswer?: string;
  /** Seconds between two blocks, as the timestamps of the blocks read by number show it (the head and the finalized tag keep their own). Default 2 (Base Sepolia). */
  blockTimeSec?: number;
  /** `eth_getLogs` refuses a range of more than this many blocks, both ends counted; null: no cap. Default 500. */
  logCap?: number | null;
  /** The gas price in wei. Default 1,000,000 (0.001 gwei). */
  gasPriceWei?: bigint;
  /** P9-4 decision 6: the transaction counts by address (lower case): `latest`, and `pending` (default: the same). An address not listed has count 0 in both. */
  nonces?: Record<string, { latest: bigint; pending?: bigint }>;
  /** P9-4 decision 6: `eth_getTransactionCount` answers an error (a node that does not count). */
  noNonces?: boolean;
  /** P9-4 decision 5: the base fee per gas every block carries, in wei (Base Sepolia's is far under a gwei). Default 500,000 (0.0005 gwei); `null`: blocks carry no `baseFeePerGas` (a chain without EIP-1559). */
  baseFeePerGasWei?: bigint | null;
  /** P9-4 decision 5: what `eth_maxPriorityFeePerGas` answers, in wei. Default 100,000 (0.0001 gwei); `null`: the node answers an error (viem then falls back to gas price minus base fee). */
  priorityFeeWei?: bigint | null;
  /** Native balances by address (lower case). Default: every account holds 1 ETH. */
  ethBalances?: Record<string, bigint>;
  /** Token balances and allowances by address (lower case). */
  tokenBalances?: Record<string, bigint>;
  allowances?: Record<string, bigint>;
  /** The token's `decimals()`: a number, or null for a token that does not answer it. Default 6. */
  decimals?: number | null;
}

export interface FakeChain {
  handlers: Record<string, ScriptedHandler>;
  /** Every method that reached the node, in order. */
  methods: string[];
  /** Every `eth_getLogs` range asked: [fromBlock, toBlock] as numbers. */
  logRanges: Array<[bigint, bigint]>;
  /** P9-4 decision 6: every `eth_getTransactionCount` asked, as [address (lower case), block tag]. */
  nonceReads: Array<[string, string]>;
}

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;

/** Builds the answers. `tokenAddress` and `escrowAddress` route `eth_call` and `eth_getCode`. */
export function fakeChain(options: FakeChainOptions = {}): FakeChain {
  const chainId = options.chainId ?? 84532;
  const head = options.headNumber ?? 40_000_000n;
  const headTs = options.headTimestampSec ?? 1_790_000_000;
  const lagBlocks = options.finalizedLagBlocks ?? 600n;
  const lagSec = options.finalizedLagSec ?? 1200;
  const logCap = options.logCap === undefined ? 500 : options.logCap;
  const methods: string[] = [];
  const logRanges: Array<[bigint, bigint]> = [];
  const nonceReads: Array<[string, string]> = [];

  const baseFee = options.baseFeePerGasWei === undefined ? 500_000n : options.baseFeePerGasWei;
  const block = (number: bigint, tsSec: number): Record<string, unknown> => ({
    number: hex(number),
    hash: hashOf(number),
    timestamp: hex(BigInt(tsSec)),
    ...(baseFee === null ? {} : { baseFeePerGas: hex(baseFee) }),
  });
  const blockByTag = (tag: unknown): { result?: unknown; error?: { code: number; message: string } } => {
    if (tag === "latest") return { result: block(head, headTs) };
    if (tag === "finalized") {
      if (options.noFinalizedTag === true) return { error: { code: -32602, message: "invalid block tag finalized" } };
      return { result: block(head - lagBlocks, headTs - lagSec) };
    }
    if (tag === "pending") {
      switch (options.pending ?? "ok") {
        case "error":
          return { error: { code: -32601, message: "pending is not supported" } };
        case "null":
          return { result: null };
        case "bare":
          return { result: { number: null, hash: null, timestamp: hex(BigInt(headTs + 2)) } };
        default:
          return { result: block(head + 1n, headTs + 2) };
      }
    }
    if (typeof tag === "string" && /^0x[0-9a-fA-F]+$/.test(tag)) {
      const number = BigInt(tag);
      return { result: block(number, headTs - Number(head - number) * (options.blockTimeSec ?? 2)) };
    }
    return { error: { code: -32602, message: "bad block tag" } };
  };

  const handlers: Record<string, ScriptedHandler> = {
    eth_chainId: () => {
      methods.push("eth_chainId");
      return { result: hex(BigInt(chainId)) };
    },
    eth_getCode: () => {
      methods.push("eth_getCode");
      return options.code === "error" ? { error: { code: -32000, message: "state unavailable" } } : { result: options.code ?? FAKE_ESCROW_CODE };
    },
    eth_getBlockByNumber: (params) => {
      methods.push("eth_getBlockByNumber");
      return blockByTag(params[0]);
    },
    eth_blockNumber: () => {
      methods.push("eth_blockNumber");
      return { result: hex(head) };
    },
    eth_gasPrice: () => {
      methods.push("eth_gasPrice");
      return { result: hex(options.gasPriceWei ?? 1_000_000n) };
    },
    eth_getTransactionCount: (params) => {
      methods.push("eth_getTransactionCount");
      const who = String(params[0]).toLowerCase();
      const tag = String(params[1]);
      nonceReads.push([who, tag]);
      if (options.noNonces === true) return { error: { code: -32601, message: "the method eth_getTransactionCount does not exist" } };
      const entry = options.nonces?.[who];
      return { result: hex(tag === "pending" ? (entry?.pending ?? entry?.latest ?? 0n) : (entry?.latest ?? 0n)) };
    },
    eth_maxPriorityFeePerGas: () => {
      methods.push("eth_maxPriorityFeePerGas");
      return options.priorityFeeWei === null ? { error: { code: -32601, message: "the method eth_maxPriorityFeePerGas does not exist" } } : { result: hex(options.priorityFeeWei ?? 100_000n) };
    },
    eth_getBalance: (params) => {
      methods.push("eth_getBalance");
      const who = String(params[0]).toLowerCase();
      return { result: hex(options.ethBalances?.[who] ?? 1_000_000_000_000_000_000n) };
    },
    eth_getLogs: (params) => {
      methods.push("eth_getLogs");
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(filter.fromBlock);
      const to = filter.toBlock === "latest" ? head : BigInt(filter.toBlock);
      logRanges.push([from, to]);
      if (logCap !== null && to - from + 1n > BigInt(logCap)) return { error: { code: -32600, message: `eth_getLogs is limited to a ${logCap} range` } };
      return { result: [] };
    },
    eth_call: (params) => {
      methods.push("eth_call");
      const call = params[0] as { to: string; data: string };
      const selector = call.data.slice(0, 10);
      const owner = `0x${call.data.slice(34, 74)}`.toLowerCase();
      switch (selector) {
        case "0x70a08231": // balanceOf(address)
          return { result: word(options.tokenBalances?.[owner] ?? 0n) };
        case "0xdd62ed3e": // allowance(address,address)
          return { result: word(options.allowances?.[owner] ?? 0n) };
        case "0x313ce567": // decimals()
          return options.decimals === null ? { error: { code: -32000, message: "execution reverted" } } : { result: word(BigInt(options.decimals ?? 6)) };
        default: {
          // locks(bytes32): seven zero words, read at a block selected by hash
          const selector2 = params[1] as { blockHash?: string } | string | undefined;
          if (typeof selector2 === "object" && selector2 !== null && options.noStateAtFinalized === true) {
            return { error: { code: -32000, message: "missing trie node" } };
          }
          if (typeof selector2 === "object" && selector2 !== null && options.stateAtFinalizedAnswer !== undefined) {
            return { result: options.stateAtFinalizedAnswer };
          }
          return { result: `0x${"00".repeat(32 * 7)}` };
        }
      }
    },
    eth_sendRawTransaction: () => {
      methods.push("eth_sendRawTransaction");
      return { error: { code: -32000, message: "the fake chain is read-only" } };
    },
    eth_sendTransaction: () => {
      methods.push("eth_sendTransaction");
      return { error: { code: -32000, message: "the fake chain is read-only" } };
    },
  };
  return { handlers, methods, logRanges, nonceReads };
}

/** Serves `handlers` as a JSON-RPC endpoint on 127.0.0.1. `close()` ends it. */
export async function serveFakeChain(chain: FakeChain, path = ""): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number | string; method: string; params: readonly unknown[] };
      const handler = chain.handlers[body.method];
      const answer = handler === undefined ? { error: { code: -32601, message: `unexpected ${body.method}` } } : handler(body.params);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(answer.error !== undefined ? { jsonrpc: "2.0", id: body.id, error: answer.error } : { jsonrpc: "2.0", id: body.id, result: answer.result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export type { Address };
