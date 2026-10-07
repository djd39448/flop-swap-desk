// SPDX-License-Identifier: MIT
//
// P9-1 test helpers for the local signer path (src/client/evm-key-file.ts). A key is generated AT TEST TIME (viem
// `generatePrivateKey`), written once to a temporary file in a fresh directory and loaded through the real
// `loadEvmLocalAccount`, so every test that signs locally exercises the same loader and the same sealed account a runner
// gets. The file is removed straight after the load. No key is a literal in this repo, none is returned, logged or kept in
// a variable that outlives the call.
//
// `localSigningRpc` is the wire side: a `CapturingRpc` over the stateful mock node (tests/helpers/evm-mock-node.ts) that also
// answers what viem asks of a node when it signs locally: the account's transaction count, a gas estimate, the fee reads, and
// `eth_sendRawTransaction` (decoded here, its sender recovered from the signature, its nonce and chain id checked, then applied
// to the node as the equivalent send). A test reads `calls` to see exactly which methods went over the wire.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAddress, parseTransaction, recoverTransactionAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, type LocalAccount } from "viem/accounts";

import { loadEvmLocalAccount } from "../../src/client/evm-key-file.js";
import { CapturingRpc } from "../../src/rails/rpc-capture.js";
import type { EvmMockNode } from "./evm-mock-node.js";

/**
 * A scanner for one key: `scan(text)` answers whether `text` contains the key (any 16-hex-digit window of it, either case, with
 * or without the 0x). It returns a boolean only, so an assertion built on it can never print the key.
 */
export function keyScanner(key: Hex): (text: string) => boolean {
  const bare = key.slice(2).toLowerCase();
  const windows: string[] = [];
  for (let i = 0; i + 16 <= bare.length; i += 1) windows.push(bare.slice(i, i + 16));
  return (text) => {
    const lower = text.toLowerCase();
    return windows.some((piece) => lower.includes(piece));
  };
}

/**
 * KR3-2: `keyScanner` for output that may show the key cut by separators: `scan(text)` answers whether `text` holds a 16-hex-digit window of the key as it
 * stands OR once every whitespace and format character (`\p{Cf}`: U+200B, U+00AD and the like) is removed, which is how a terminal shows a key written in
 * groups or with invisible separators. A superset of `keyScanner`; a boolean only.
 */
export function strippedKeyScanner(key: Hex): (text: string) => boolean {
  const plain = keyScanner(key);
  return (text) => plain(text) || plain(text.replace(/[\s\p{Cf}]/gu, ""));
}

/**
 * KR3-2: a scanner for a seed phrase given as its words: `scan(text)` answers whether `text` holds any 4 consecutive words of it, in order, with anything
 * but letters between them (a space, a number, a comma, a slash, a backslash). A boolean only, so a failing assertion never prints a word.
 */
export function phraseScanner(words: readonly string[]): (text: string) => boolean {
  const patterns: RegExp[] = [];
  for (let i = 0; i + 4 <= words.length; i += 1) patterns.push(new RegExp(words.slice(i, i + 4).join("[^a-z]+")));
  return (text) => {
    const lower = text.toLowerCase();
    return patterns.some((pattern) => pattern.test(lower));
  };
}

/**
 * KR3-1: the same for a key written in decimal (`BigInt(key).toString(10)`, 76 to 78 digits): `scan(text)` answers whether `text` holds any window of
 * 20 consecutive digits of it. A boolean only, so an assertion built on it can never print the key.
 */
export function decimalKeyScanner(key: Hex): (text: string) => boolean {
  const decimal = BigInt(key).toString(10);
  const windows: string[] = [];
  for (let i = 0; i + 20 <= decimal.length; i += 1) windows.push(decimal.slice(i, i + 20));
  return (text) => windows.some((piece) => text.includes(piece));
}

/**
 * A fresh account whose key was generated now, written to a mode-0600 temp file, loaded by the real loader, and deleted.
 * `leaks(text)` is `keyScanner` for that key: the key itself never leaves this function, so a test can scan every capture, frame,
 * store record and rendering for it and can never print it.
 */
export async function makeLocalAccountWithScan(): Promise<{ account: LocalAccount; leaks: (text: string) => boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "evmk-"));
  const key = generatePrivateKey();
  try {
    const path = join(dir, "a.key");
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    const account = await loadEvmLocalAccount(path);
    return { account, leaks: keyScanner(key) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fresh local account (see `makeLocalAccountWithScan`). */
export async function makeLocalAccount(): Promise<LocalAccount> {
  return (await makeLocalAccountWithScan()).account;
}

export interface RawSend {
  from: Address;
  nonce: number;
  chainId: number | undefined;
  to: Address | null | undefined;
  data: Hex | undefined;
}

export interface LocalSigningRpc {
  rpc: CapturingRpc;
  /** Every JSON-RPC method that reached the node, in order (also what `rpc.exchanges()` recorded). */
  calls: string[];
  /** Every `eth_sendRawTransaction` that was decoded and applied. */
  rawSends: RawSend[];
  /** When true `eth_getTransactionReceipt` answers null for every hash (a chain that never confirms). */
  holdReceipts: boolean;
  /** Overrides what `eth_getTransactionCount` answers for an address (a node that is behind), once per entry. */
  countOverride: Map<string, number>;
  /** A hostile or odd endpoint: the result this wire answers for a method INSTEAD of its own answer (a value, or a function of the call's params).
   *  A method that is never asked (the rail answers `eth_fillTransaction` itself) is simply never reached. */
  answers: Map<string, unknown>;
}

type Envelope = { result?: unknown; error?: { code: number; message: string } };

/**
 * A `CapturingRpc` that answers like a node a local signer talks to. `node` is the shared state; each party builds its own
 * `localSigningRpc(node)` (like a per-party `CapturingRpc`). `expectedChainId` is what a signed transaction must carry.
 */
export function localSigningRpc(node: EvmMockNode, expectedChainId = 31337): LocalSigningRpc {
  const inner = node.rpc();
  const counts = new Map<string, number>();
  const state: LocalSigningRpc = {
    rpc: undefined as unknown as CapturingRpc,
    calls: [],
    rawSends: [],
    holdReceipts: false,
    countOverride: new Map(),
    answers: new Map(),
  };

  const delegate = async (method: string, params: readonly unknown[]): Promise<Envelope> => {
    try {
      return { result: await inner.request({ method, params: [...params] }) };
    } catch (error) {
      const e = error as { code?: number; message?: string };
      return { error: { code: e.code ?? -32000, message: e.message ?? String(error) } };
    }
  };

  const handle = async (method: string, params: readonly unknown[]): Promise<Envelope> => {
    state.calls.push(method);
    if (state.answers.has(method)) {
      const answer = state.answers.get(method);
      return { result: typeof answer === "function" ? (answer as (params: readonly unknown[]) => unknown)(params) : answer };
    }
    switch (method) {
      case "eth_sendTransaction":
        return { error: { code: -32601, message: "the method eth_sendTransaction does not exist/is not available (no key here)" } };
      case "personal_sign":
        return { error: { code: -32601, message: "the method personal_sign does not exist/is not available (no key here)" } };
      case "eth_getTransactionCount": {
        const who = String(params[0]).toLowerCase();
        const overridden = state.countOverride.get(who);
        return { result: `0x${(overridden ?? counts.get(who) ?? 0).toString(16)}` };
      }
      case "eth_estimateGas":
        return { result: "0x30d40" };
      case "eth_maxPriorityFeePerGas":
        return { result: "0x3b9aca00" };
      case "eth_gasPrice":
        return { result: "0x3b9aca07" };
      case "eth_feeHistory":
        return { result: { oldestBlock: "0x1", baseFeePerGas: ["0x7", "0x7"], gasUsedRatio: [0.5], reward: [["0x3b9aca00"]] } };
      case "eth_getBlockByNumber": {
        const answered = await delegate(method, params);
        if (answered.result !== undefined && answered.result !== null && typeof answered.result === "object") {
          return { result: { ...(answered.result as object), baseFeePerGas: "0x7", gasLimit: "0x1c9c380", gasUsed: "0x0" } };
        }
        return answered;
      }
      case "eth_getTransactionReceipt":
        if (state.holdReceipts) return { result: null };
        return delegate(method, params);
      case "eth_getTransactionByHash":
        return { result: null };
      case "eth_sendRawTransaction": {
        const raw = String(params[0]) as Hex;
        const parsed = parseTransaction(raw);
        const from = getAddress(await recoverTransactionAddress({ serializedTransaction: raw as never }));
        const expected = counts.get(from.toLowerCase()) ?? 0;
        const send: RawSend = { from, nonce: parsed.nonce ?? -1, chainId: parsed.chainId, to: parsed.to, data: parsed.data };
        state.rawSends.push(send);
        if (parsed.chainId !== expectedChainId) return { error: { code: -32000, message: "invalid chain id for signer" } };
        if (parsed.nonce !== expected) return { error: { code: -32000, message: `nonce too ${(parsed.nonce ?? 0) < expected ? "low" : "high"}: next nonce ${expected}, tx nonce ${parsed.nonce}` } };
        // The node's own fault knobs apply: a send it refuses is not applied (the nonce stays), a send whose reply it loses IS
        // applied (the nonce moves) although the caller sees an error.
        const sendsBefore = node.sends.length;
        const applied = await delegate("eth_sendTransaction", [{ from, to: parsed.to, data: parsed.data }]);
        if (node.sends.length > sendsBefore) counts.set(from.toLowerCase(), expected + 1);
        return applied;
      }
      default:
        return delegate(method, params);
    }
  };

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number | string; method: string; params: readonly unknown[] };
    const response = await handle(body.method, body.params);
    const envelope = response.error !== undefined ? { jsonrpc: "2.0", id: body.id, error: response.error } : { jsonrpc: "2.0", id: body.id, result: response.result };
    const text = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  state.rpc = new CapturingRpc({ endpoint: "http://mock-evm", fetch: fetchImpl });
  return state;
}
