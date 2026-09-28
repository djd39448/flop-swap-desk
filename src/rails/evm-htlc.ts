// SPDX-License-Identifier: MIT
//
// The desk-facing `evm-htlc` adapter: wraps src/vendor/evm-hash-rail.ts (byte-identical,
// never edited) and adds what a real deployment needs that the vendored binding doesn't try
// to be — a chain pin with a mainnet deny list, byte-exact write evidence, and a fail-closed
// finalized-view read shared with the offline replay (src/rails/evm-evidence.ts). Every write
// goes through a viem `WalletClient` built on a plain address (`createWalletClient({ account:
// <address>, transport })`, a JSON-RPC account): no private key, mnemonic or seed for any EVM
// account exists anywhere in this build (D-10). `connect()` refuses to even start against a
// mainnet chain id, pinned or actually connected to, and refuses to configure Base mainnet
// USDC in the asset book (D-09) — this is the local, keyless build; a real key on Base Sepolia
// is Dave's own G1 step, loaded from env, never printed, and not built here.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §1, §2.2.

import {
  createPublicClient,
  createWalletClient,
  custom,
  hexToNumber,
  isAddressEqual,
  type Address,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { LockTerms } from "@flop-labs/tclk";
import { verifyHashPreimage } from "@flop-labs/tclk";

import { EvmHashRail, type AddressBook, type AssetBook } from "../vendor/evm-hash-rail.js";
import { captureEvmLeg, evmEvidence, EVM_RAIL_ID, hashLockRefMismatch, type EvmAccounts, type EvmEvidenceResult } from "./evm-evidence.js";
import type { CapturingRpc } from "./rpc-capture.js";

/** §2.2 point 1. Only `"finalized"` is a defined tag today; the union leaves room for a
 *  future one without widening every caller to a bare string. */
export type EvmFinality =
  | { mode: "tag"; tag: "finalized"; fallbackConfirmations?: number }
  | { mode: "confirmations"; confirmations: number };

export interface EvmChainPin {
  chainId: number;
  name: string;
  caip2: string;
  finality: EvmFinality;
}

export interface EvmRailConfig {
  pin: EvmChainPin;
  endpoint: string;
  contract: Address;
  assets: Record<string, Address>;
}

export const BASE_SEPOLIA_PIN: EvmChainPin = {
  chainId: 84532,
  name: "base-sepolia",
  caip2: "eip155:84532",
  finality: { mode: "tag", tag: "finalized" },
};

export const ANVIL_LOCAL_PIN: EvmChainPin = {
  chainId: 31337,
  name: "anvil-local",
  caip2: "eip155:31337",
  finality: { mode: "tag", tag: "finalized" },
};

/** Refused by name even if someone pins one of these — never live traffic in this build. */
const MAINNET_DENY_LIST: ReadonlyMap<number, string> = new Map([
  [1, "ethereum mainnet"],
  [8453, "base mainnet"],
  [10, "op mainnet"],
  [42161, "arbitrum one"],
  [137, "polygon pos"],
  [56, "bnb smart chain"],
  [43114, "avalanche c-chain"],
]);

/** D-09: this exact token must never appear in an asset book, on any chain id — it is Base
 *  mainnet's real USDC, and this build never holds mainnet value. */
export const BASE_MAINNET_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function validateFinality(finality: EvmFinality): void {
  if (finality.mode === "confirmations") {
    if (!Number.isInteger(finality.confirmations) || finality.confirmations <= 0) {
      throw new Error("evm-htlc: confirmations must be a positive integer");
    }
    return;
  }
  if (
    finality.fallbackConfirmations !== undefined &&
    (!Number.isInteger(finality.fallbackConfirmations) || finality.fallbackConfirmations <= 0)
  ) {
    throw new Error("evm-htlc: fallbackConfirmations must be a positive integer");
  }
}

/** Static checks on a config that don't need a live chain: the pin itself isn't deny-listed,
 *  no asset resolves to Base mainnet USDC, and the finality knobs are sane. `connect()` runs
 *  this before ever touching the network. */
export function validateEvmRailConfig(config: EvmRailConfig): void {
  const pinDenyName = MAINNET_DENY_LIST.get(config.pin.chainId);
  if (pinDenyName !== undefined) {
    throw new Error(`evm-htlc: chain id ${config.pin.chainId} is deny-listed as ${pinDenyName}; refusing to pin it`);
  }
  for (const [asset, address] of Object.entries(config.assets)) {
    if (isAddressEqual(address, BASE_MAINNET_USDC)) {
      throw new Error(
        `evm-htlc: asset "${asset}" resolves to Base mainnet USDC (${BASE_MAINNET_USDC}); refusing to configure it (D-09)`,
      );
    }
  }
  validateFinality(config.pin.finality);
}

function chainFromPin(pin: EvmChainPin): Chain {
  return {
    id: pin.chainId,
    name: pin.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  };
}

function assetBookFrom(assets: Record<string, Address>): AssetBook {
  return {
    resolve(asset: string): Address {
      const address = assets[asset];
      if (address === undefined) throw new Error(`evm-htlc: no configured token address for asset "${asset}"`);
      return address;
    },
  };
}

// contracts/EvmHashRail.sol's events, reproduced here (not vendored — the vendored ABI only
// carries the functions) so `getLogs` can filter by event + `hashLock` the idiomatic viem way
// (`event`/`args`), which is what actually builds the `[topicHash(event), hashLock]` filter
// §2.2 point 2 describes — this viem version's typed `getLogs` has no raw `topics` parameter.
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

type WriteEventName = "Locked" | "Claimed" | "Refunded";

const WRITE_EVENT_ABI = {
  Locked: LOCKED_EVENT,
  Claimed: CLAIMED_EVENT,
  Refunded: REFUNDED_EVENT,
} as const;

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** §2.2 point 2: what one `lock`/`claim`/`refund` write produced, bound to the single
 *  on-chain event it must have emitted. `raw` lists (in call order) the response sha256s of
 *  every exchange that produced this — the block-number read, the write itself, its receipt
 *  poll, and the bounded `eth_getLogs` lookup. */
export interface WriteEvidence {
  ref: Hex;
  event: WriteEventName;
  txHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
  raw: string[];
}

export interface EvmHtlcRailOptions {
  config: EvmRailConfig;
  /** The transport every read and write goes through — also this rail's `CaptureSink`. */
  rpc: CapturingRpc;
  /** This party's own EVM address. A JSON-RPC account: `createWalletClient({ account, ... })`
   *  never holds or asks for a private key (D-10). */
  account: Address;
  /** Resolves a counterparty's tclk DID to its EVM address for the vendored rail's write path
   *  (`lock()` needs the payee's address). Populated from `src/rails/account-line.ts`'s
   *  `resolveAccounts` in the client, out of this Stage's scope. */
  addressBook: AddressBook;
  clock?: () => number;
}

/**
 * The desk's `evm-htlc` rail handle: one instance per party, bound to one EVM account and one
 * pinned chain. Build it with `EvmHtlcRail.connect(...)`, never `new` — connecting is where
 * the chain pin and the config's asset book get checked against reality.
 */
export class EvmHtlcRail {
  private readonly config: EvmRailConfig;
  private readonly rpc: CapturingRpc;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  private readonly rail: EvmHashRail;
  private readonly clock: () => number;

  private constructor(
    config: EvmRailConfig,
    rpc: CapturingRpc,
    publicClient: PublicClient,
    walletClient: WalletClient<Transport, Chain, Account>,
    rail: EvmHashRail,
    clock: () => number,
  ) {
    this.config = config;
    this.rpc = rpc;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.rail = rail;
    this.clock = clock;
  }

  /**
   * Async factory (§2.2 point 1): validates the config statically (deny list, D-09 asset
   * check, finality knobs), then calls `eth_chainId` and refuses — throws — when it differs
   * from `options.config.pin`, naming both ids and the deny-list name for whichever one is
   * denied (the pin itself was already cleared by the static check, so only a connected chain
   * that turns out to be a denied one can still name itself here).
   */
  static async connect(options: EvmHtlcRailOptions): Promise<EvmHtlcRail> {
    validateEvmRailConfig(options.config);

    const chain = chainFromPin(options.config.pin);
    const transport = custom(options.rpc);
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account: options.account, chain, transport });

    const liveChainIdHex = (await options.rpc.request({ method: "eth_chainId", params: [] })) as Hex;
    const liveChainId = hexToNumber(liveChainIdHex);
    if (liveChainId !== options.config.pin.chainId) {
      const denyName = MAINNET_DENY_LIST.get(liveChainId);
      throw new Error(
        `evm-htlc: connected chain id ${liveChainId} does not match pin "${options.config.pin.name}" ` +
          `(expected ${options.config.pin.chainId})` +
          (denyName !== undefined ? `; ${liveChainId} is deny-listed as ${denyName}` : ""),
      );
    }

    const rail = new EvmHashRail({
      publicClient,
      walletClient,
      contractAddress: options.config.contract,
      addressBook: options.addressBook,
      assetBook: assetBookFrom(options.config.assets),
      // exactOptionalPropertyTypes: omit the key entirely rather than pass `clock: undefined`.
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });

    return new EvmHtlcRail(options.config, options.rpc, publicClient, walletClient, rail, options.clock ?? Date.now);
  }

  private resolveAsset(asset: string): Address {
    const address = this.config.assets[asset];
    if (address === undefined) throw new Error(`evm-htlc: no configured token address for asset "${asset}"`);
    return address;
  }

  /** ERC20 `approve` to the rail contract, receipt checked. Not itself a `lock`/`claim`/
   *  `refund`, so it returns just the tx hash plus the raw sha256s it produced, not a
   *  `WriteEvidence` (there is no rail event to bind it to). */
  async approve(asset: string, amount: string): Promise<{ txHash: Hex; raw: string[] }> {
    const token = this.resolveAsset(asset);
    const hash = await this.walletClient.writeContract({
      address: token,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [this.config.contract, BigInt(amount)],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`evm-htlc: approve transaction mined but reverted on-chain (hash: ${hash})`);
    }
    return { txHash: hash, raw: this.rpc.drain().map((exchange) => exchange.responseSha256) };
  }

  /** §2.2 point 2: hash-lock only, and this deployment's `EvmHashRail` has no fee (profile
   *  v1.1) — a declared leg-A `feeBps` other than 0 is refused before anything is sent. */
  async lock(terms: LockTerms, feeBps: number): Promise<WriteEvidence> {
    if (terms.lock !== "hash") {
      throw new Error(`evm-htlc: only hash locks are supported, got ${terms.lock}`);
    }
    if (feeBps !== 0) {
      throw new Error("evm-htlc: this deployment has no fee; declared feeBps must be 0");
    }
    const fromBlock = await this.publicClient.getBlockNumber();
    await this.rail.lock(terms);
    return this.captureWriteEvidence("Locked", terms.statement as Hex, fromBlock);
  }

  async claim(hashLock: Hex, secret: Hex): Promise<WriteEvidence> {
    const fromBlock = await this.publicClient.getBlockNumber();
    await this.rail.claim(hashLock, secret);
    return this.captureWriteEvidence("Claimed", hashLock, fromBlock);
  }

  async refund(hashLock: Hex): Promise<WriteEvidence> {
    const fromBlock = await this.publicClient.getBlockNumber();
    await this.rail.refund(hashLock);
    return this.captureWriteEvidence("Refunded", hashLock, fromBlock);
  }

  /** Records `eth_blockNumber` before the write, then looks the matching event up with a
   *  bounded `eth_getLogs` (`address` = the rail contract, `topics` = [event signature,
   *  hashLock], `fromBlock` = the recorded block, `toBlock` = "latest"). Exactly one matching
   *  log is required — zero or several throws, never guesses which one. */
  private async captureWriteEvidence(event: WriteEventName, hashLock: Hex, fromBlock: bigint): Promise<WriteEvidence> {
    const logs = await this.publicClient.getLogs({
      address: this.config.contract,
      event: WRITE_EVENT_ABI[event],
      args: { hashLock },
      fromBlock,
      toBlock: "latest",
    });
    if (logs.length !== 1) {
      throw new Error(
        `evm-htlc: expected exactly one ${event} log for ${hashLock} in blocks [${fromBlock}, latest], found ${logs.length}`,
      );
    }
    const [log] = logs;
    if (
      log === undefined ||
      log.blockNumber === null ||
      log.blockHash === null ||
      log.transactionHash === null ||
      log.logIndex === null
    ) {
      throw new Error(`evm-htlc: ${event} log for ${hashLock} is missing block/tx identity`);
    }
    const raw = this.rpc.drain().map((exchange) => exchange.responseSha256);
    return {
      ref: hashLock,
      event,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      logIndex: log.logIndex,
      raw,
    };
  }

  /**
   * §2.2 point 3, implemented per §4 as "capture live, then evmEvidence": performs the live
   * read once (`captureEvmLeg`) and hands the exact bytes it produced straight to the pure
   * decoder, so the verdict this returns and the verdict a later replay of the same bytes
   * returns can never diverge. P22-P24-EVM-FIXES.md A8: `ref`/`terms.lock` are checked
   * *before* `captureEvmLeg` ever runs — a malformed ref can never resolve to real evidence,
   * so there is no reason to spend a live round trip finding that out. Otherwise never throws
   * for a chain-state reason (an absent lock, a mismatched field, a chain the RPC lacks a
   * finalized view for) — only a genuine transport failure (the node unreachable) propagates.
   */
  async verifyLockFinal(terms: LockTerms, ref: string, accounts: EvmAccounts): Promise<EvmEvidenceResult> {
    if (hashLockRefMismatch(terms, ref)) {
      return {
        lock: {
          rail: EVM_RAIL_ID,
          ref,
          terms,
          checkedAtMs: this.clock(),
          endpoint: this.config.endpoint,
          railVerified: false,
          reason: 'evm-htlc: ref/lock mismatch (ref must equal terms.statement and lock must be "hash")',
        },
      };
    }
    const checkedAtMs = this.clock();
    const { index, exchanges } = await captureEvmLeg(this.rpc, this.config, ref, checkedAtMs);
    const bytes = new Map(exchanges.map((exchange) => [exchange.responseSha256, new TextEncoder().encode(exchange.responseBody)]));
    return evmEvidence({
      terms,
      config: this.config,
      accounts,
      capture: { index, bytes },
    });
  }

  /** §2.2 point 4: bounded `eth_getLogs` for `Claimed(hashLock, preimage)`; returns the
   *  preimage only if it actually opens the statement (`sha256(preimage) === hashLock`) —
   *  never trusts the log's shape alone. How the Buyer learns `s` when the Seller claims on
   *  chain before (or without) posting its reveal frame. */
  async findClaimedPreimage(hashLock: Hex, fromBlock: bigint): Promise<Hex | null> {
    const logs = await this.publicClient.getLogs({
      address: this.config.contract,
      event: CLAIMED_EVENT,
      args: { hashLock },
      fromBlock,
      toBlock: "latest",
    });
    for (const log of logs) {
      const preimage = log.args.preimage;
      if (preimage !== undefined && verifyHashPreimage(hashLock, preimage)) return preimage;
    }
    return null;
  }
}
