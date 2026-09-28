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

import { EVM_HASH_RAIL_ABI, EvmHashRail, type AddressBook, type AssetBook } from "../vendor/evm-hash-rail.js";
import { captureEvmLeg, evmEvidence, EVM_RAIL_ID, hashLockRefMismatch, type EvmAccounts, type EvmEvidenceResult } from "./evm-evidence.js";
import { verifiedExchangeBytes, type CapturingRpc } from "./rpc-capture.js";

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

/** P22-P24-EVM-FIXES.md A3: only these two chain ids are accepted anywhere in this build — an
 *  allow list, not a deny list, so an id nobody thought to name (a testnet nobody's heard of,
 *  a typo, a future mainnet) is refused by default instead of silently let through. */
const ALLOWED_CHAIN_IDS: ReadonlySet<number> = new Set([31337, 84532]);

/** P22-P24-EVM-FIXES-R2.md C5: the one canonical name each allow-listed chain id may be pinned
 *  under — checked in `validateEvmRailConfig` alongside the allow list itself, so a config
 *  cannot pin a legitimate chain id (31337, 84532) under some other name. Without this, a
 *  config's `pin.name` (which ends up inside every `finalizedRef` this build writes, and in
 *  `MAINNET_DENY_LIST` lookups) could disagree with the chain id it is actually numerically
 *  pinned to — e.g. claiming "base-sepolia" for a config actually pinned to 31337 — letting a
 *  captured or replayed config's own provenance strings lie about which deployment produced
 *  them, even though `pin.caip2 === "eip155:" + pin.chainId` (checked separately, in
 *  `evmRailConfigShapeReason`) already held. */
const CANONICAL_PIN_NAMES: ReadonlyMap<number, string> = new Map([
  [31337, "anvil-local"],
  [84532, "base-sepolia"],
]);

/** Kept only to name a well-known mainnet in the refusal message when the offending chain id
 *  happens to be one of these — the allow list above is what actually gates a chain id now,
 *  never this map (A3: "the old named list stays only to give a better error message"). */
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

/** Static checks on a config that don't need a live chain: the pin's chain id is on the A3
 *  allow list (31337 anvil-local, 84532 base-sepolia — nothing else), no asset resolves to
 *  Base mainnet USDC, and the finality knobs are sane. `connect()` runs this before ever
 *  touching the network. Throws with a reason; `checkEvmRailConfig` below wraps it (plus a
 *  runtime shape check) for callers that take a config as untyped data (a `--rails` file, a
 *  captured `rails.json`) rather than as a compiler-checked `EvmRailConfig`. */
export function validateEvmRailConfig(config: EvmRailConfig): void {
  if (!ALLOWED_CHAIN_IDS.has(config.pin.chainId)) {
    const denyName = MAINNET_DENY_LIST.get(config.pin.chainId);
    throw new Error(
      `evm-htlc: chain id ${config.pin.chainId} is not on the allow list (31337 anvil-local, 84532 base-sepolia only)` +
        (denyName !== undefined ? `; ${config.pin.chainId} is ${denyName}` : ""),
    );
  }
  // C5: the chain id is on the allow list, but is it pinned under *its* canonical name? A
  // config that got chainId right and name wrong would otherwise pass every other check here.
  const canonicalName = CANONICAL_PIN_NAMES.get(config.pin.chainId);
  if (canonicalName !== undefined && config.pin.name !== canonicalName) {
    throw new Error(
      `evm-htlc: chain id ${config.pin.chainId} must be pinned as "${canonicalName}", got "${config.pin.name}"`,
    );
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

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * P22-P24-EVM-FIXES.md A3: whether `value` even has the shape of an `EvmRailConfig` — every
 * field present and typed, and `pin.caip2` actually derived from `pin.chainId` (`"eip155:" +
 * chainId`, never a value that could disagree with the chain id everything else here trusts).
 * `null` when the shape checks out; otherwise the first reason it doesn't. This runs before
 * `validateEvmRailConfig` (which assumes a well-typed `EvmRailConfig` already) at every place
 * a rail config enters this build as untrusted data rather than compiler-checked source: a
 * live sweep's `--rails` file, an offline replay's `rails.json`/`--rails` file, and a folded
 * replay's own `rails.evm` input.
 */
export function evmRailConfigShapeReason(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "evm rail config is not an object";
  const v = value as Record<string, unknown>;

  if (v.pin === null || typeof v.pin !== "object") return "evm rail config: pin is not an object";
  const pin = v.pin as Record<string, unknown>;
  if (typeof pin.chainId !== "number" || !Number.isInteger(pin.chainId) || pin.chainId <= 0) {
    return "evm rail config: pin.chainId must be a positive integer";
  }
  if (typeof pin.name !== "string" || pin.name === "") return "evm rail config: pin.name must be a non-empty string";
  if (typeof pin.caip2 !== "string") return "evm rail config: pin.caip2 must be a string";
  if (pin.caip2 !== `eip155:${pin.chainId}`) {
    return `evm rail config: pin.caip2 "${pin.caip2}" does not match pin.chainId ${pin.chainId} (expected "eip155:${pin.chainId}")`;
  }
  if (pin.finality === null || typeof pin.finality !== "object") return "evm rail config: pin.finality is not an object";
  const finality = pin.finality as Record<string, unknown>;
  if (finality.mode === "tag") {
    if (finality.tag !== "finalized") return 'evm rail config: pin.finality.tag must be "finalized"';
    if (
      finality.fallbackConfirmations !== undefined &&
      (typeof finality.fallbackConfirmations !== "number" || !Number.isInteger(finality.fallbackConfirmations) || finality.fallbackConfirmations <= 0)
    ) {
      return "evm rail config: pin.finality.fallbackConfirmations must be a positive integer";
    }
  } else if (finality.mode === "confirmations") {
    if (typeof finality.confirmations !== "number" || !Number.isInteger(finality.confirmations) || finality.confirmations <= 0) {
      return "evm rail config: pin.finality.confirmations must be a positive integer";
    }
  } else {
    return 'evm rail config: pin.finality.mode must be "tag" or "confirmations"';
  }

  if (typeof v.endpoint !== "string" || v.endpoint === "") return "evm rail config: endpoint must be a non-empty string";
  if (typeof v.contract !== "string" || !HEX_ADDRESS.test(v.contract)) {
    return "evm rail config: contract must be a 0x-address";
  }
  if (v.assets === null || typeof v.assets !== "object" || Array.isArray(v.assets)) {
    return "evm rail config: assets must be an object";
  }
  for (const [asset, address] of Object.entries(v.assets as Record<string, unknown>)) {
    if (typeof address !== "string" || !HEX_ADDRESS.test(address)) {
      return `evm rail config: assets["${asset}"] must be a 0x-address`;
    }
  }
  return null;
}

export type EvmRailConfigCheck = { ok: true; config: EvmRailConfig } | { ok: false; reason: string };

/**
 * P22-P24-EVM-FIXES.md A3: the one check every entry point runs on a rail config it did not
 * itself construct from compiler-checked source — `src/watcher.ts`'s `runSweep` (a `--rails`
 * file), `src/replay.ts`'s `foldCaptured` (the same, or a captured `rails.json`), and
 * `examples/audit-export.mjs`'s own rails loading. Never throws: a shape problem or an
 * `validateEvmRailConfig` refusal (chain id off the allow list, D-09 asset, bad finality
 * knobs) both come back as `{ ok: false, reason }`, so every caller can fail closed with a
 * clear, specific message instead of an uncaught exception.
 */
export function checkEvmRailConfig(value: unknown): EvmRailConfigCheck {
  const shapeReason = evmRailConfigShapeReason(value);
  if (shapeReason !== null) return { ok: false, reason: shapeReason };
  const config = value as EvmRailConfig;
  try {
    validateEvmRailConfig(config);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, config };
}

/** B2: pull the short revert reason out of a viem simulate/call error the same way
 *  `src/vendor/evm-hash-rail.ts`'s (private, unexported) `extractRevertReason` does for a
 *  mined-but-reverted write — never throws itself, never the raw ABI-encoding dump. */
function extractShortMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const withMessage = err as { shortMessage?: unknown; message?: unknown };
    if (typeof withMessage.shortMessage === "string") return withMessage.shortMessage;
    if (typeof withMessage.message === "string") return withMessage.message;
  }
  return String(err);
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
   * Async factory (§2.2 point 1): validates the config statically, then calls `eth_chainId` and
   * refuses — throws — when it differs from `options.config.pin`, naming both ids and the
   * deny-list name for whichever one is denied (the pin itself was already cleared by the
   * static check, so only a connected chain that turns out to be a denied one can still name
   * itself here).
   *
   * P22-P24-EVM-FIXES-R2.md C5: runs the *full* `checkEvmRailConfig` (shape — including
   * `pin.caip2 === "eip155:" + pin.chainId` — plus the A3 allow list, the D-09 asset check, the
   * new C5 pin-name-tied-to-chain-id check, and finality knob sanity), never just the "config is
   * already well-typed" half `validateEvmRailConfig` alone used to run here. `options.config` is
   * compiler-checked at this call site today, but this constructor is not the only path a config
   * can reach it through — a client flow's `evmConfig` can just as easily have come from a parsed
   * file as a watcher's or replay's config can, and TypeScript offers no protection once JS
   * actually runs. Every entry point now runs the same one rule.
   */
  static async connect(options: EvmHtlcRailOptions): Promise<EvmHtlcRail> {
    const configCheck = checkEvmRailConfig(options.config);
    if (!configCheck.ok) {
      throw new Error(`evm-htlc: refusing to connect — ${configCheck.reason}`);
    }

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

    // P22-P24-EVM-FIXES.md A10: this check's own `eth_chainId` exchange has done its job (a
    // mismatch already threw above) — drain it now so a rail instance that lives on to make
    // writes never has it sitting in the log for the first write's own snapshot-at-start to
    // see (a write's `WriteEvidence.raw` must hold only that write's own exchanges).
    options.rpc.drain();

    return new EvmHtlcRail(options.config, options.rpc, publicClient, walletClient, rail, options.clock ?? Date.now);
  }

  private resolveAsset(asset: string): Address {
    const address = this.config.assets[asset];
    if (address === undefined) throw new Error(`evm-htlc: no configured token address for asset "${asset}"`);
    return address;
  }

  /** P22-P24-EVM-FIXES.md A10: re-checked before every write (lock/claim/refund/approve), not
   *  only once at `connect()` time — a long-lived rail instance drives an entire swap, and
   *  refusing to sign anywhere but the pinned chain is cheap insurance against a reused RPC
   *  endpoint having quietly started answering for a different chain since connect. */
  private async assertPinnedChainId(): Promise<void> {
    const chainIdHex = (await this.rpc.request({ method: "eth_chainId", params: [] })) as Hex;
    const chainId = hexToNumber(chainIdHex);
    if (chainId !== this.config.pin.chainId) {
      throw new Error(
        `evm-htlc: chain id ${chainId} no longer matches pin "${this.config.pin.name}" ` +
          `(expected ${this.config.pin.chainId}); refusing to write`,
      );
    }
  }

  /** ERC20 `approve` to the rail contract, receipt checked. Not itself a `lock`/`claim`/
   *  `refund`, so it returns just the tx hash plus the raw sha256s it produced, not a
   *  `WriteEvidence` (there is no rail event to bind it to). */
  async approve(asset: string, amount: string): Promise<{ txHash: Hex; raw: string[] }> {
    const token = this.resolveAsset(asset);
    await this.assertPinnedChainId();
    // A10: snapshot the exchange log length *before* this write (the same pattern
    // `captureEvmLeg` uses), so `raw` below can be sliced to exactly this call's own
    // exchanges — never `drain()`, which would also sweep up anything an earlier, un-drained
    // read (a `verifyLockFinal` a caller chose not to drain) left sitting in the log.
    const before = this.rpc.exchanges().length;
    // P22-P24-EVM-FIXES-R2.md D1: "a comparably unique id for write-path captures" — this
    // `rpc` instance is long-lived across a whole swap's worth of writes, so its ids must not
    // collide across two different `approve` calls the way two different `CapturingRpc`
    // instances' plain sequences could (see `CapturingRpc.setIdNamespace`).
    this.rpc.setIdNamespace(`write-approve:${asset}:${this.clock()}`);
    let hash: Hex;
    try {
      hash = await this.walletClient.writeContract({
        address: token,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [this.config.contract, BigInt(amount)],
      });
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`evm-htlc: approve transaction mined but reverted on-chain (hash: ${hash})`);
    }
    const raw = this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
    return { txHash: hash, raw };
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
    await this.assertPinnedChainId();
    const before = this.rpc.exchanges().length;
    // D1: see the identical comment on `approve` above.
    this.rpc.setIdNamespace(`write-lock:${terms.statement}:${this.clock()}`);
    try {
      const fromBlock = await this.publicClient.getBlockNumber();
      await this.rail.lock(terms);
      return await this.captureWriteEvidence("Locked", terms.statement as Hex, fromBlock, before);
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
  }

  /**
   * P22-P24-EVM-FIXES.md B2 (USD-COIN-FIT-2026-09-28.md: "a reverted claim still leaks the
   * secret"): a claim against a blacklisted (or otherwise refusing) payee still reverts
   * on-chain, but the preimage is already public in the reverted transaction's own calldata the
   * moment it is broadcast — mined or not, the leak already happened. Simulating first
   * (`eth_call` at `latest`, never a real transaction) means a doomed claim is never sent at
   * all; any revert cause refuses it, not only a blacklist.
   */
  async claim(hashLock: Hex, secret: Hex): Promise<WriteEvidence> {
    await this.assertPinnedChainId();
    await this.simulateClaimOrThrow(hashLock, secret);
    const before = this.rpc.exchanges().length;
    // D1: see the identical comment on `approve` above.
    this.rpc.setIdNamespace(`write-claim:${hashLock}:${this.clock()}`);
    try {
      const fromBlock = await this.publicClient.getBlockNumber();
      await this.rail.claim(hashLock, secret);
      return await this.captureWriteEvidence("Claimed", hashLock, fromBlock, before);
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
  }

  /** `eth_call` the vendored contract's own `claim(hashLock, preimage)` through this rail's
   *  `walletClient.account` — never broadcasts. Throws (never broadcasts) when the simulation
   *  reverts, for any reason.
   *
   *  P22-P24-EVM-FIXES-R2.md C3: judged at the `pending` block, never `latest`. An idle chain's
   *  `latest` block can lag real time indefinitely — nothing forces a new block just because
   *  time passes — so simulating against it can see a stale "still within `refundAfterMs`"
   *  reading for a claim that will actually land well after `refundAfterMs` once it is finally
   *  mined (the contract's own `claim()` also enforces `block.timestamp * 1000 <
   *  refundAfterMs`, and a claim that reverts on-chain still publishes the secret in its own
   *  calldata the moment it is broadcast — USD-COIN-FIT-2026-09-28). `pending` is every EVM
   *  node's own best-effort next-block timestamp (`max(parent + 1, wall clock)` on anvil,
   *  empirically verified 2026-09-28 against anvil 1.8.3 — it visibly tracks real elapsed time
   *  during an idle gap where `latest` does not move), so it never reports a time earlier than
   *  the one this claim will actually be evaluated at once sent. */
  private async simulateClaimOrThrow(hashLock: Hex, secret: Hex): Promise<void> {
    try {
      await this.publicClient.simulateContract({
        address: this.config.contract,
        abi: EVM_HASH_RAIL_ABI,
        functionName: "claim",
        args: [hashLock, secret],
        account: this.walletClient.account,
        blockTag: "pending",
      });
    } catch (err) {
      throw new Error(`evm-htlc: refusing to broadcast claim — it simulates to a revert (${extractShortMessage(err)})`);
    }
  }

  /** B2: the contract's only clock is `block.timestamp`; this reads the chain's own current
   *  time (the latest block), never wall-clock or an injected `clock()` — `claimByMs` and the
   *  claim-inclusion margin must be judged against what the contract itself will see when a
   *  claim transaction actually lands, not against a client's local notion of "now". */
  async latestBlockTimestampMs(): Promise<number> {
    const result = (await this.rpc.request({ method: "eth_getBlockByNumber", params: ["latest", false] })) as {
      timestamp?: Hex;
    } | null;
    if (result === null || typeof result.timestamp !== "string") {
      throw new Error("evm-htlc: eth_getBlockByNumber(latest) returned no usable timestamp");
    }
    return hexToNumber(result.timestamp) * 1000;
  }

  async refund(hashLock: Hex): Promise<WriteEvidence> {
    await this.assertPinnedChainId();
    const before = this.rpc.exchanges().length;
    // D1: see the identical comment on `approve` above.
    this.rpc.setIdNamespace(`write-refund:${hashLock}:${this.clock()}`);
    try {
      const fromBlock = await this.publicClient.getBlockNumber();
      await this.rail.refund(hashLock);
      return await this.captureWriteEvidence("Refunded", hashLock, fromBlock, before);
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
  }

  /** Records `eth_blockNumber` before the write, then looks the matching event up with a
   *  bounded `eth_getLogs` (`address` = the rail contract, `topics` = [event signature,
   *  hashLock], `fromBlock` = the recorded block, `toBlock` = "latest"). Exactly one matching
   *  log is required — zero or several throws, never guesses which one. `before` (A10) is the
   *  exchange log length this write's own caller (`lock`/`claim`/`refund`) snapshotted right
   *  before it started, so `raw` below can be sliced to exactly this write's own exchanges. */
  private async captureWriteEvidence(event: WriteEventName, hashLock: Hex, fromBlock: bigint, before: number): Promise<WriteEvidence> {
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
    const raw = this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
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
    const bytes = verifiedExchangeBytes(exchanges);
    const result = evmEvidence({
      terms,
      config: this.config,
      accounts,
      capture: { index, bytes },
    });
    // A10: `captureEvmLeg` only *peeks* the log (`rpc.exchanges().slice(before)`), and this
    // call already holds everything it needs in `exchanges`/`result` above — drain it now
    // rather than let a long-lived rail instance's exchange log grow forever across a whole
    // swap's worth of polling, and so a later write's own snapshot-at-start starts clean.
    this.rpc.drain();
    return result;
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
