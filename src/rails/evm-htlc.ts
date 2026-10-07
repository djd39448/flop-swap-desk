// SPDX-License-Identifier: MIT
//
// The desk-facing `evm-htlc` adapter: wraps src/vendor/evm-hash-rail.ts (byte-identical,
// never edited) and adds what a real deployment needs that the vendored binding doesn't try
// to be — a chain pin with an allow list (anvil-local, base-sepolia), byte-exact write evidence, and a fail-closed
// finalized-view read shared with the offline replay (src/rails/evm-evidence.ts). Every write
// goes through a viem `WalletClient` built on the party's account, which is one of two things:
// a plain address (`createWalletClient({ account: <address>, transport })`, a JSON-RPC account:
// the node holds the key and signs over RPC, anvil's unlocked accounts) or a viem `LocalAccount`
// (P9-1: viem signs locally and every write goes out as `eth_sendRawTransaction`; the account
// comes from `loadEvmLocalAccount` in src/client/evm-key-file.ts, the one place a key file is
// read, and nothing in this file ever sees, stores or prints a key). No private key, mnemonic
// or seed for any EVM account exists anywhere in this repo (D-10). `connect()` refuses to even
// start against a mainnet chain id, pinned or actually connected to, and refuses to configure
// Base mainnet USDC in the asset book (D-09).
//
// P22-P24-EVM-FIXES-R3.md E4/E5: `claim()` now takes a `notAfterMs` bound (enforced against
// fresh `pending`-block time right before it broadcasts) and no longer hands the real preimage
// to the RPC endpoint until two preimage-free simulations already prove the lock is open-able
// and the payout is not blocked — see `claim()`'s and `simulateClaimPreChecksOrThrow`'s own
// comments below.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §1, §2.2; P22-P24-EVM-FIXES-R3.md
// E4, E5.

import {
  createPublicClient,
  createWalletClient,
  custom,
  hexToNumber,
  isAddress,
  isAddressEqual,
  numberToHex,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { LocalAccount } from "viem/accounts";
import type { LockTerms } from "@flop-labs/tclk";
import { verifyHashPreimage } from "@flop-labs/tclk";

import { EVM_HASH_RAIL_ABI, EvmHashRail, type AddressBook, type AssetBook } from "../vendor/evm-hash-rail.js";
import { CODE_HASH_SHAPE, describeCodeProblem, judgeRuntimeCode, shortPinnedHash } from "./evm-code-pin.js";
import { captureEvmLeg, evmEvidence, EVM_RAIL_ID, hashLockRefMismatch, type EvmAccounts, type EvmEvidenceResult } from "./evm-evidence.js";
import {
  EVM_DEFAULT_MAX_FEE_PER_GAS_WEI,
  EVM_MAX_GAS_PER_WRITE,
  guardEstimateFeesPerGas,
  guardLocalAccount,
  refuseFillTransaction,
  type EvmSignerRefusedError,
  type EvmSignerWatch,
} from "./evm-signer.js";
import { RpcCaptureError, verifiedExchangeBytes, type CapturingRpc } from "./rpc-capture.js";

export { EVM_DEFAULT_MAX_FEE_PER_GAS_WEI, EVM_MAX_GAS_PER_WRITE, EvmSignerRefusedError } from "./evm-signer.js";

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
  /**
   * P9-1: how long (ms) any one receipt wait (approve, lock, claim, refund) may poll before it gives up with an
   * `EvmReceiptTimeoutError`. Omitted: viem's own default, `VIEM_RECEIPT_TIMEOUT_MS` (180 s). A slower public chain
   * raises it; it never makes a write safer or less safe (the transaction is already broadcast when the wait starts),
   * it only decides how long this process waits before reporting "no receipt yet". A positive integer, at most
   * `MAX_RECEIPT_TIMEOUT_MS`. P9-4 decision 8: when `pin.chainId` is 84532 it must lie between
   * `BASE_SEPOLIA_MIN_RECEIPT_TIMEOUT_MS` (10,000) and `BASE_SEPOLIA_MAX_RECEIPT_TIMEOUT_MS` (3,600,000), a floor under which a normal
   * 2-second-block inclusion would be reported as "no receipt" and a cap past which a stuck write holds a run for more than an hour;
   * anvil is unconstrained (the short timeout tests keep their values).
   * P94-FUND-01: on 84532 the CLAIM's own receipt wait is bounded to `EVM_CLAIM_RECEIPT_WAIT_MS_BASE_SEPOLIA` (180,000 ms) whatever this says (a smaller value is
   * kept); approve, lock and refund use this value.
   */
  receiptTimeoutMs?: number;
  /**
   * P9-2 (rule 2): keccak256 of the escrow's deployed RUNTIME code, the bytes `eth_getCode` answers (`0x` and 64 hex digits;
   * `bin/evm-code-hash.mjs <rpc-url> <address>` prints it for a deployed contract, and PROVENANCE.md records the value the
   * vendored `EvmHashRail.sol` builds to). REQUIRED when `pin.chainId` is 84532 (a Base Sepolia config without it is refused);
   * optional on anvil. When present, `EvmHtlcRail.connect` reads `eth_getCode(contract, "latest")` and refuses a contract whose
   * code is empty or hashes differently (`EvmContractCodeError`, before any write), and the evidence reader captures the same
   * read and reports `railVerified: null` for a lock at a contract whose code differs, so the board never folds on an unpinned
   * contract. It is not part of `evmDeploymentId`: the contract address already names the deployment, the hash only proves
   * what is at it.
   */
  contractCodeHash?: Hex;
  /**
   * P9-3 (rule 3): the most blocks any one `eth_getLogs` call may span (inclusive of both ends), the endpoint's own cap. Every
   * log scan this build makes (the write-evidence lookup and `findClaimedPreimage`, including the resumed Seller's claim scan)
   * is split into calls of at most this many blocks. Omitted: `BASE_SEPOLIA_MAX_LOG_RANGE` (500) when `pin.chainId` is 84532,
   * no limit (one call to `latest`, as before) otherwise; see `effectiveMaxLogRange`. A positive integer of at least
   * `EVM_MIN_LOG_RANGE` (257): the resumed Seller's 256-block claim marker margin must fit in one call (R1-FUND-03).
   */
  maxLogRange?: number;
  /**
   * R1-FUND-02 (P9 fix pass): the highest fee, in wei per gas, a LOCAL account may sign for (`maxFeePerGas`, `maxPriorityFeePerGas` and
   * `gasPrice` of every transaction are each held to it; a transaction without a fee cap is refused too). A positive integer, given as
   * a number or as a string of decimal digits (a wei amount can outgrow a JSON number). Omitted: `EVM_DEFAULT_MAX_FEE_PER_GAS_WEI`
   * (1,000 gwei) on anvil, which it passes, and (P9-4 decision 5) `BASE_SEPOLIA_DEFAULT_MAX_FEE_PER_GAS_WEI` (50 gwei) when `pin.chainId`
   * is 84532: Base Sepolia's base fee is under a gwei, so 50 gwei leaves two orders of magnitude for a spike while refusing an absurd fill.
   * On 84532 a configured value below `BASE_SEPOLIA_MIN_MAX_FEE_PER_GAS_WEI` (1 gwei) is refused: a ceiling under the chain's own fee would
   * refuse every write. It binds only a local account (the node signs for a JSON-RPC one), together with the pinned chain id and
   * `EVM_MAX_GAS_PER_WRITE` (see src/rails/evm-signer.ts).
   */
  maxFeePerGasWei?: number | string;
}

/** P9-4 decision 5: the default fee ceiling (wei per gas) for a local account on Base Sepolia: 50 gwei (anvil keeps `EVM_DEFAULT_MAX_FEE_PER_GAS_WEI`, 1,000 gwei). */
export const BASE_SEPOLIA_DEFAULT_MAX_FEE_PER_GAS_WEI = 50_000_000_000n;

/** P9-4 decision 5: the lowest `maxFeePerGasWei` a Base Sepolia config may carry: 1 gwei. */
export const BASE_SEPOLIA_MIN_MAX_FEE_PER_GAS_WEI = 1_000_000_000n;

/** P9-4 decision 8: the lowest `receiptTimeoutMs` a Base Sepolia config may carry: 10 seconds. */
export const BASE_SEPOLIA_MIN_RECEIPT_TIMEOUT_MS = 10_000;

/** P9-4 decision 8: the highest `receiptTimeoutMs` a Base Sepolia config may carry: one hour. */
export const BASE_SEPOLIA_MAX_RECEIPT_TIMEOUT_MS = 3_600_000;

/**
 * P94-FUND-01 (P9-FIXES-R4 decision 1, part 2): on Base Sepolia the claim's OWN receipt wait ends after at most 180 seconds, whatever `receiptTimeoutMs` says
 * (decision 8's hour-long cap still holds for approve, lock and refund). A claim carries the swap's preimage, which is public in the pool from the moment it is
 * broadcast; if it sits unmined near leg A's refund time the only remedy is a by-hand same-nonce speed-up, and the operator reaches that only once this process stops
 * waiting and says so. A configured `receiptTimeoutMs` of an hour would hold that first report for longer than the whole slack between the claim's last deadline
 * guard and leg A's refund time (20 minutes between claim-by and refund on the known-good set). A configured value below 180 seconds is kept.
 */
export const EVM_CLAIM_RECEIPT_WAIT_MS_BASE_SEPOLIA = 180_000;

/** P9-3: the public Base Sepolia endpoint refuses `eth_getLogs` over more than 500 blocks (measured 2026-10-05,
 *  `handoff/G1-PREP-2026-10-05.md` section 2); the default `maxLogRange` for chain 84532. */
export const BASE_SEPOLIA_MAX_LOG_RANGE = 500;

/** P9-3: the hard bound on `eth_getLogs` calls one scan may make. At the Base Sepolia range that is 50,000 blocks (about 28 hours of
 *  2-second blocks) counted from the scan's start marker; a scan that would need more throws `EvmLogScanBoundError` instead of silently
 *  reading less. R1-FUND-03: scans read the OLDEST range first, from the marker, so the bound is a property of the leg's window (a claim
 *  lies in the first ranges above the marker), never of how late the scan runs. */
export const MAX_LOG_SCAN_CHUNKS = 100;

/** F7: how many times the write-evidence lookup re-plans (a fresh tip read, the whole range read again) when it finds no log before it
 *  gives up with "found 0". A load-balanced endpoint can answer the receipt from one node and the tip or the logs from another that has
 *  not seen the block yet; the write is on chain, so a bounded re-read is the answer, never a second write. P9-4 decision 10: each re-plan
 *  is preceded by a pause of about one block (`EvmHtlcRailOptions.lookupPauseMs`). */
export const EVM_WRITE_LOOKUP_REPLANS = 3;

/** P9-4 decision 10: the largest `lookupPauseMs` a rail accepts: one minute (a larger number is a typo for something else). */
export const MAX_LOOKUP_PAUSE_MS = 60_000;

/** R1-FUND-03: the smallest `maxLogRange` a config may carry: the resumed Seller's claim marker sits `CLAIM_MARKER_REORG_MARGIN_EVM` (256)
 *  blocks below the tip it read, so a range of at least 257 blocks keeps that margin inside one call. */
export const EVM_MIN_LOG_RANGE = 257;

const BASE_SEPOLIA_CHAIN_ID = 84532;

/** viem 2.56.8's default for `waitForTransactionReceipt`'s `timeout` (180 s); what an omitted `receiptTimeoutMs` means. */
export const VIEM_RECEIPT_TIMEOUT_MS = 180_000;

/** An upper bound on a configured `receiptTimeoutMs`: one day. A larger number is a typo for something else. */
export const MAX_RECEIPT_TIMEOUT_MS = 86_400_000;

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
      `evm-htlc: chain id ${config.pin.chainId} must be pinned as "${canonicalName}", got ${quotedPinText(config.pin.name) ?? UNPLAIN_PIN_TEXT}`,
    );
  }
  // P9-2 (rule 2): a Base Sepolia config trusts its escrow by code, never by address alone.
  if (config.pin.chainId === BASE_SEPOLIA_CHAIN_ID && config.contractCodeHash === undefined) {
    throw new Error(
      `evm-htlc: a base-sepolia (${BASE_SEPOLIA_CHAIN_ID}) config must carry contractCodeHash, the keccak256 of the escrow's runtime code ` +
        "(bin/evm-code-hash.mjs prints it for the deployed contract); refusing to trust a contract by its address alone",
    );
  }
  for (const [asset, address] of Object.entries(config.assets)) {
    if (isAddressEqual(address, BASE_MAINNET_USDC)) {
      throw new Error(
        `evm-htlc: ${ASSET_NAME_SHAPE.test(asset) ? `asset "${asset}"` : UNPLAIN_ASSET} resolves to Base mainnet USDC (${BASE_MAINNET_USDC}); refusing to configure it (D-09)`,
      );
    }
  }
  validateFinality(config.pin.finality);
  if (config.pin.chainId === BASE_SEPOLIA_CHAIN_ID) validateBaseSepoliaKnobs(config);
}

/**
 * P9-4 decisions 3, 5 and 8: the knobs a Base Sepolia (84532) config may not set loosely. Anvil is untouched by every one of them.
 *   3. finality is the `finalized` tag with no `fallbackConfirmations`: confirmations mode and any fallback are refused, so the Buyer's permanent
 *      never-locked verdict (and every read a flow routes on) never rests on a block a fixed number of confirmations below the head, which
 *      a reorg or a transient tag error could leave far ahead of the chain's real finalized block (R3-FUND-03).
 *   5. `maxFeePerGasWei`, when configured, is at least 1 gwei.
 *   8. `receiptTimeoutMs`, when configured, is between 10,000 and 3,600,000 ms.
 * The messages name a field and a number that already passed the shape check, never any other text of the config.
 */
function validateBaseSepoliaKnobs(config: EvmRailConfig): void {
  const finality = config.pin.finality;
  if (finality.mode === "confirmations") {
    throw new Error(
      `evm-htlc: base-sepolia (${BASE_SEPOLIA_CHAIN_ID}) must pin finality to the finalized tag: confirmations mode is refused there (every final read, and the Buyer's permanent never-locked verdict, must rest on the chain's own finalized block, never on a block a fixed number of confirmations below the head)`,
    );
  }
  if (finality.fallbackConfirmations !== undefined) {
    throw new Error(
      `evm-htlc: base-sepolia (${BASE_SEPOLIA_CHAIN_ID}) must pin finality to the finalized tag with no fallbackConfirmations: a block a fixed number of confirmations below the head is not a final one`,
    );
  }
  if (config.receiptTimeoutMs !== undefined && (config.receiptTimeoutMs < BASE_SEPOLIA_MIN_RECEIPT_TIMEOUT_MS || config.receiptTimeoutMs > BASE_SEPOLIA_MAX_RECEIPT_TIMEOUT_MS)) {
    throw new Error(
      `evm-htlc: receiptTimeoutMs ${config.receiptTimeoutMs} is outside ${BASE_SEPOLIA_MIN_RECEIPT_TIMEOUT_MS} to ${BASE_SEPOLIA_MAX_RECEIPT_TIMEOUT_MS} ms, the range allowed on base-sepolia (${BASE_SEPOLIA_CHAIN_ID})`,
    );
  }
  if (config.maxFeePerGasWei !== undefined) {
    const ceiling = maxFeePerGasWeiOf(config.maxFeePerGasWei);
    if (ceiling !== undefined && ceiling < BASE_SEPOLIA_MIN_MAX_FEE_PER_GAS_WEI) {
      throw new Error(
        `evm-htlc: maxFeePerGasWei ${ceiling} is below the ${BASE_SEPOLIA_MIN_MAX_FEE_PER_GAS_WEI} wei (1 gwei) floor on base-sepolia (${BASE_SEPOLIA_CHAIN_ID}): a ceiling under the chain's own fee would refuse every write`,
      );
    }
  }
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * KR2-1 (P9 review round 2): the shape of an asset name this build prints or writes down: 1 to 32 letters, digits, `-` and `_`
 * (`USDC`, `usdc-test`). The runner's config holds every `assets` name to it before anything else reads the config.
 */
export const ASSET_NAME_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * KR2-1: how the refusals of this module that name an asset speak of one whose name is NOT a plain name (`ASSET_NAME_SHAPE`): they never
 * quote it. A key pasted into the wrong place is the case this is for, and these texts reach terminals, logs and the output of
 * `watch.mjs` and `audit-export`, which this module cannot tell apart from the runner's.
 */
const UNPLAIN_ASSET = "an asset whose name is not a short plain name";

/**
 * KR3-3 (P9 review round 3): the shape of a pin name or caip2 this build quotes in a refusal: 1 to 40 letters, digits and `: _ . -` (`base-sepolia`, `anvil-local`,
 * `eip155:84532`, `bip122:` plus 32 hex digits). It is the runner's own `PIN_TEXT` (src/client/rehearsal-config.ts holds its pin fields to this same shape), and
 * it is defined here because a rail module never imports from the client.
 */
export const PIN_TEXT_SHAPE = /^[A-Za-z0-9:_.-]{1,40}$/;

/**
 * KR3-3: how the refusals of this module that name a pin's `name` or `caip2` speak of one that is NOT a short plain text (`PIN_TEXT_SHAPE`): they never quote it. The
 * refusals reach `watch.mjs` (`report.railsConfigError`, its notes and stderr) and `audit-export --rails`, whose files have no key field, so a key pasted into the
 * wrong field of a hand-written rails file would otherwise come back whole (the same class as `UNPLAIN_ASSET`).
 */
const UNPLAIN_PIN_TEXT = "a pin name (or caip2) that is not a short plain text";

/** The text between double quotes when `text` is a short plain text, and `null` when it is anything else (a value that must not be quoted). */
function quotedPinText(text: unknown): string | null {
  return typeof text === "string" && PIN_TEXT_SHAPE.test(text) ? `"${text}"` : null;
}

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
    const shown = quotedPinText(pin.caip2);
    return `evm rail config: pin.caip2 ${shown !== null ? shown : `is ${UNPLAIN_PIN_TEXT} and`} does not match pin.chainId ${pin.chainId} (expected "eip155:${pin.chainId}")`;
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
      return `evm rail config: ${ASSET_NAME_SHAPE.test(asset) ? `assets["${asset}"]` : UNPLAIN_ASSET} must be a 0x-address`;
    }
  }
  if (v.receiptTimeoutMs !== undefined) {
    if (
      typeof v.receiptTimeoutMs !== "number" ||
      !Number.isInteger(v.receiptTimeoutMs) ||
      v.receiptTimeoutMs <= 0 ||
      v.receiptTimeoutMs > MAX_RECEIPT_TIMEOUT_MS
    ) {
      return `evm rail config: receiptTimeoutMs must be a positive integer of at most ${MAX_RECEIPT_TIMEOUT_MS}`;
    }
  }
  if (v.contractCodeHash !== undefined && (typeof v.contractCodeHash !== "string" || !CODE_HASH_SHAPE.test(v.contractCodeHash))) {
    return "evm rail config: contractCodeHash must be 0x followed by 64 hex digits (the keccak256 of the escrow's runtime code)";
  }
  if (v.maxLogRange !== undefined && (typeof v.maxLogRange !== "number" || !Number.isSafeInteger(v.maxLogRange) || v.maxLogRange <= 0)) {
    return "evm rail config: maxLogRange must be a positive integer";
  }
  if (typeof v.maxLogRange === "number" && v.maxLogRange < EVM_MIN_LOG_RANGE) {
    return `evm rail config: maxLogRange must be at least ${EVM_MIN_LOG_RANGE} (the 256-block claim marker margin must fit in one eth_getLogs call), got ${v.maxLogRange}`;
  }
  if (v.maxFeePerGasWei !== undefined && maxFeePerGasWeiOf(v.maxFeePerGasWei) === undefined) {
    return "evm rail config: maxFeePerGasWei must be a positive integer (a number, or a string of decimal digits without leading zeros)";
  }
  return null;
}

/** A configured `maxFeePerGasWei` as a bigint, or `undefined` when it is not a positive integer (a safe-integer number, or 1 to 40 decimal digits). */
function maxFeePerGasWeiOf(value: unknown): bigint | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : undefined;
  if (typeof value === "string" && /^[1-9][0-9]{0,39}$/.test(value)) return BigInt(value);
  return undefined;
}

/** R1-FUND-02: the fee ceiling in force for `config`: the configured `maxFeePerGasWei`, else the chain's default (P9-4 decision 5:
 *  `BASE_SEPOLIA_DEFAULT_MAX_FEE_PER_GAS_WEI`, 50 gwei, on 84532; `EVM_DEFAULT_MAX_FEE_PER_GAS_WEI`, 1,000 gwei, elsewhere). */
export function effectiveMaxFeePerGasWei(config: EvmRailConfig): bigint {
  if (config.maxFeePerGasWei === undefined) {
    return config.pin.chainId === BASE_SEPOLIA_CHAIN_ID ? BASE_SEPOLIA_DEFAULT_MAX_FEE_PER_GAS_WEI : EVM_DEFAULT_MAX_FEE_PER_GAS_WEI;
  }
  const configured = maxFeePerGasWeiOf(config.maxFeePerGasWei);
  // Never a silent fall back to the (higher) default for a value that is not valid: a config that reaches here passed `checkEvmRailConfig`.
  if (configured === undefined) throw new Error("evm-htlc: maxFeePerGasWei must be a positive integer");
  return configured;
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

/** R2-FUND-01: a block answer as its number and timestamp (ms), or `null` when it is not a block with both as hex numbers. */
function blockHeadOf(value: unknown): EvmBlockHead | null {
  if (value === null || typeof value !== "object") return null;
  const { number, timestamp } = value as { number?: unknown; timestamp?: unknown };
  const hex = /^0x[0-9a-fA-F]+$/;
  if (typeof number !== "string" || !hex.test(number) || typeof timestamp !== "string" || !hex.test(timestamp)) return null;
  return { number: BigInt(number), timestampMs: Number(BigInt(timestamp) * 1000n) };
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

/** P22-P24-EVM-FIXES-R3.md E5(b): the payout `claim()` itself makes internally
 *  (`IERC20(held.token).transfer(held.payee, held.amount)`) — simulated here, impersonated
 *  from the rail contract's own address, before the real claim ever sends. */
const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** E5(a): a zero preimage never opens a real hashLock (sha256 preimage resistance) — simulating
 *  `claim(hashLock, ZERO_BYTES32)` and requiring the contract's own specific "secret does not
 *  open the statement" revert proves the lock exists, is `Locked`, and is inside its window,
 *  without this method ever naming the real secret to do it. */
const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

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

/** P8-RESUME-SPEC.md: the on-chain status of a lock that exists (the contract's `None` is reported as no record). */
export type EvmLockStatus = "Locked" | "Claimed" | "Refunded";

/** R2-FUND-01: a block's number and its timestamp in ms, as the chain answered them (the finalized block of a finality read). */
export interface EvmBlockHead {
  number: bigint;
  timestampMs: number;
}

/**
 * R2-FUND-01: what `readLockAbsence` found for a lock that was attempted and has no evidence. `landed`: a row exists AT THE FINALIZED BLOCK
 * (R3-FUND-02: a row seen only at the latest block is not final and is never evidence), whoever owns it. `never-locked`: no row at the finalized
 * block, that finalized block is at or past `refundAfterMs`, and no row at the latest block either; the contract refuses a lock in any block
 * whose timestamp is at or past `refundAfterMs`, so no later block can carry one and the attempt can never land. `not-final`: no verdict can be
 * given yet: no finalized block could be read, or it is before `refundAfterMs`, or a row is visible only at the latest block (a lock that is not
 * final yet, or an inconsistent read): ask again later.
 */
export type EvmLockAbsence = { kind: "landed"; row: EvmLockRecord } | { kind: "never-locked"; finalized: EvmBlockHead } | { kind: "not-final" };

/** P8-RESUME-SPEC.md: one `locks(hashLock)` row, decoded. */
export interface EvmLockRecord {
  status: EvmLockStatus;
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  claimByMs: bigint;
  refundAfterMs: bigint;
}

/** P9-4 decision 7: which write of the rail a receipt wait belongs to (`EvmReceiptTimeoutError.write`). */
export type EvmWriteKind = "approve" | "lock" | "claim" | "refund";

/**
 * P94-FUND-01 (P9-FIXES-R4 decision 1, part 1): one of this rail's writes was BROADCAST: the node accepted the signed transaction and answered `hash` (in lower case, a
 * public value), and the wait for its receipt is about to start. Every write passes through it (the vendored rail's own waits included). `write` names which write it is;
 * `undefined` only for a wait made outside a rail method. See `EvmHtlcRail.onWriteBroadcast`.
 */
export interface EvmWriteBroadcast {
  readonly write: EvmWriteKind | undefined;
  readonly hash: Hex;
}

/** A listener of `EvmHtlcRail.onWriteBroadcast`. It is awaited before the receipt wait starts (so a listener that saves the hash has it durable first) and it can never change
 *  what the write does: an error it throws is swallowed. */
export type EvmWriteBroadcastListener = (event: EvmWriteBroadcast) => void | Promise<void>;

/**
 * P94-PIN-01: a transaction hash as this build keeps it, in LOWER case. A node may answer `eth_sendRawTransaction` with an upper- or mixed-case hash
 * (viem returns it verbatim), but the flow records decode a saved hash strictly (`0x` and 64 lower-case hex digits), so a hash saved as the node wrote it
 * would be refused by the save and the protection of decision 7 (ask the node about the hash before sending again) would silently be off for that write.
 * Only the letters change, never the digits; a value that is not a string is returned as it is (the decoders refuse it).
 */
function lowerCaseHash(hash: Hex): Hex {
  return (typeof hash === "string" ? hash.toLowerCase() : hash) as Hex;
}

/**
 * P9-1: a receipt wait gave up (`EvmRailConfig.receiptTimeoutMs`, else viem's 180 s). The transaction named by `hash`
 * WAS broadcast (the node accepted it and returned the hash) and may still be mined; this error says only that this
 * process stopped waiting. It is what `approve`, `lock`, `claim` and `refund` throw when the wait times out (never a hang,
 * never the vendored rail's `tclk: Timed out ...` text), so a caller can tell "sent, outcome unknown" from "refused".
 * The right next step is to read the chain (`readLock`, `verifyLockFinal`, `findClaimedPreimage`) before sending anything
 * again; the P8 recover paths do exactly that. P9-4 decision 7 (R1-FUND-04): `write` names which write it was (the rail method that made it sets
 * it), so a flow saves only the hash of a lock or a claim, and a resumed flow asks the node about that hash (`EvmHtlcRail.transactionStatus`)
 * before it sends the write again.
 */
export class EvmReceiptTimeoutError extends Error {
  /** The transaction hash in LOWER case (P94-PIN-01: a node may answer an upper- or mixed-case hash, which a flow's record would then refuse to save). */
  readonly hash: Hex;
  readonly timeoutMs: number;
  /** Which write timed out; `undefined` only for a wait made outside a rail method. */
  readonly write: EvmWriteKind | undefined;
  constructor(hash: Hex, timeoutMs: number, write?: EvmWriteKind) {
    const lower = lowerCaseHash(hash);
    super(
      `evm-htlc: no receipt for transaction ${lower} within ${timeoutMs} ms; it was broadcast and may still be mined, ` +
        "so read the chain before sending anything again",
    );
    this.name = "EvmReceiptTimeoutError";
    this.hash = lower;
    this.timeoutMs = timeoutMs;
    this.write = write;
  }
}

/**
 * P9-4 decision 7: what the node says of a transaction this process once sent (`EvmHtlcRail.transactionStatus`).
 *   `pending`   the node holds it and has not mined it (or says it is mined but has no receipt for it yet: the answers disagree, nothing is decided);
 *   `success`   it is mined and its receipt says it succeeded;
 *   `reverted`  it is mined and its receipt says it reverted (it did nothing);
 *   `unknown`   the node does not know the hash (never held, dropped, or replaced).
 */
export type EvmTransactionStatus = "pending" | "success" | "reverted" | "unknown";

/**
 * P9-2 (rule 2): the code at `config.contract` is not the pinned one. `connect()` throws this before any write when the contract's
 * `eth_getCode` is empty (`problem: "empty"`), is not hex (`"malformed"`) or hashes to something other than `config.contractCodeHash`
 * (`"mismatch"`). `observed` (absent unless there was code to hash) is the keccak256 hash of public code, safe to print. R2-NOTE-a: `expected`
 * is the pinned value in its SHORT form only (`0x` and eight hex digits, then `...`: the same text the message shows), never the whole value.
 * A pinned `contractCodeHash` has the same shape as a private key, so an operator who pasted a key there by mistake must not see it in
 * `util.inspect`, `console.error` or `JSON.stringify` of this error either (an enumerable field would carry it to every one of those).
 */
export class EvmContractCodeError extends Error {
  readonly problem: "empty" | "malformed" | "mismatch";
  readonly contract: Address;
  readonly expected: string;
  readonly observed: Hex | undefined;
  constructor(problem: "empty" | "malformed" | "mismatch", contract: Address, expected: string, observed: Hex | undefined, text: string) {
    super(`evm-htlc: refusing to connect: ${text}`);
    this.name = "EvmContractCodeError";
    this.problem = problem;
    this.contract = contract;
    this.expected = expected;
    this.observed = observed;
  }
}

/**
 * P9-3 (rule 3): a log scan could not be completed inside `MAX_LOG_SCAN_CHUNKS` calls of `maxLogRange` blocks each, so part of the
 * range `[fromBlock, toBlock]` was NOT read (`unreadFrom`..`unreadTo` is that part: the NEWEST blocks, since R1-FUND-03 reads the
 * oldest range first from the marker). Nothing is ever truncated silently: a caller that gets this knows the scan is incomplete and
 * must not read "no log" from it. `findClaimedPreimage` throws it only when no preimage was found in the part it did read (a found
 * preimage is returned whatever lies above); the write-evidence lookup throws it before reading anything.
 */
export class EvmLogScanBoundError extends Error {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly unreadFrom: bigint;
  readonly unreadTo: bigint;
  readonly maxLogRange: number;
  readonly chunkBound: number;
  constructor(fromBlock: bigint, toBlock: bigint, unreadFrom: bigint, unreadTo: bigint, maxLogRange: number, chunkBound: number) {
    super(
      `evm-htlc: the log scan from block ${fromBlock} to ${toBlock} needs more than ${chunkBound} eth_getLogs calls of at most ${maxLogRange} blocks; ` +
        `blocks ${unreadFrom} to ${unreadTo} were not read, so the scan is incomplete`,
    );
    this.name = "EvmLogScanBoundError";
    this.fromBlock = fromBlock;
    this.toBlock = toBlock;
    this.unreadFrom = unreadFrom;
    this.unreadTo = unreadTo;
    this.maxLogRange = maxLogRange;
    this.chunkBound = chunkBound;
  }
}

/** P9-3: the `maxLogRange` in force for `config`: the configured one, else 500 on Base Sepolia, else `undefined` (no limit: one call to `latest`). */
export function effectiveMaxLogRange(config: EvmRailConfig): number | undefined {
  if (config.maxLogRange !== undefined) return config.maxLogRange;
  return config.pin.chainId === BASE_SEPOLIA_CHAIN_ID ? BASE_SEPOLIA_MAX_LOG_RANGE : undefined;
}

/**
 * R1-FUND-03: how many blocks above its start marker ONE scan reaches: `MAX_LOG_SCAN_CHUNKS` calls of `maxLogRange` blocks each, or
 * `undefined` when no limit is in force (one call to `latest`). Oldest range first, a claim lies in the first ranges above the marker, so the
 * bound holds exactly when this covers the leg's window: leg A's refund time minus its lock time at the chain's block time, plus the 256-block
 * claim marker margin. The dry run's pre-flight compares the two (the runner's part of the fix).
 */
export function evmLogScanCoverage(config: EvmRailConfig): number | undefined {
  const limit = effectiveMaxLogRange(config);
  return limit === undefined ? undefined : limit * MAX_LOG_SCAN_CHUNKS;
}

/** One `eth_getLogs` call of a scan: `to` is `"latest"` only for the unlimited single call. */
interface LogRange {
  from: bigint;
  to: bigint | "latest";
}

/** `planLogScan`'s answer: the calls to make (OLDEST first, from the scan's start), the tip they were cut from (absent when unlimited), the
 *  newer part that did not fit in `MAX_LOG_SCAN_CHUNKS` calls (absent when everything is covered) and the range limit in force. */
interface LogScanPlan {
  ranges: LogRange[];
  tip: bigint | undefined;
  unread: { from: bigint; to: bigint } | undefined;
  limit: number | undefined;
}

/** Shared by the wrapped public client (which records a timeout) and the rail (which reads it back after a vendored write
 *  has re-wrapped the error as `tclk: ...`). One write runs at a time on one rail handle. */
interface ReceiptWatch {
  timeout: EvmReceiptTimeoutError | undefined;
  /** F7: the block number of the last receipt a wait returned (the write's own block), so the evidence lookup never plans below it. */
  receiptBlock: bigint | undefined;
  /** P94-FUND-01: which of the rail's writes the receipt wait now running belongs to (set by the rail method around the write, cleared after it); `undefined` outside one. */
  write: EvmWriteKind | undefined;
  /** P94-FUND-01: called, awaited, with the write's hash (lower case) and kind BEFORE every receipt wait starts. Its errors never reach the wait. */
  onWaitStart: ((hash: Hex, write: EvmWriteKind | undefined) => void | Promise<void>) | undefined;
}

/** The viem `waitForTransactionReceipt` parameters, without naming a chain. */
type ReceiptWaitParameters = Parameters<PublicClient["waitForTransactionReceipt"]>[0];

/**
 * P9-1: returns `client` with its `waitForTransactionReceipt` replaced, so that EVERY receipt wait in this build (the
 * vendored rail's own, which cannot be edited, and `approve`'s) uses `receiptTimeoutMs` when one is configured (viem's own
 * default otherwise) and turns viem's timeout into `EvmReceiptTimeoutError`. The error is also recorded in `watch`, because
 * the vendored rail re-wraps whatever it catches as a plain `tclk: ...` Error.
 *
 * P94-FUND-01: (1) before the wait starts, `watch.onWaitStart` is told the write's hash (the write is already broadcast: its hash is the node's answer), so a flow can
 * save it and a runner can show it while the wait runs; its errors are swallowed. (2) `claimWaitCapMs` (Base Sepolia only) bounds the wait of a CLAIM to at most that many
 * milliseconds, whatever `receiptTimeoutMs` says; every other write keeps the configured value.
 */
function withReceiptTimeout(client: PublicClient, receiptTimeoutMs: number | undefined, watch: ReceiptWatch, claimWaitCapMs: number | undefined): PublicClient {
  const extended = client.extend(() => ({
    async waitForTransactionReceipt(parameters: ReceiptWaitParameters) {
      const write = watch.write;
      const configured = parameters.timeout ?? receiptTimeoutMs;
      const limit = write === "claim" && claimWaitCapMs !== undefined ? Math.min(configured ?? VIEM_RECEIPT_TIMEOUT_MS, claimWaitCapMs) : configured;
      const withTimeout = limit !== undefined && limit !== parameters.timeout ? { ...parameters, timeout: limit } : parameters;
      if (watch.onWaitStart !== undefined) {
        try {
          await watch.onWaitStart(lowerCaseHash(parameters.hash), write);
        } catch {
          // a listener (a flow saving the hash, a runner printing it) never changes what the wait does: the transaction is out either way
        }
      }
      try {
        const receipt = await client.waitForTransactionReceipt(withTimeout);
        watch.receiptBlock = receipt.blockNumber;
        return receipt;
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) {
          const typed = new EvmReceiptTimeoutError(parameters.hash, withTimeout.timeout ?? VIEM_RECEIPT_TIMEOUT_MS);
          watch.timeout = typed;
          throw typed;
        }
        throw error;
      }
    },
  }));
  return extended as unknown as PublicClient;
}

export interface EvmHtlcRailOptions {
  config: EvmRailConfig;
  /** The transport every read and write goes through — also this rail's `CaptureSink`. */
  rpc: CapturingRpc;
  /** This party's own EVM account, one of two things. An `Address` is a JSON-RPC account (`createWalletClient({ account,
   *  ... })` holds no key: the node answers `eth_sendTransaction`; anvil's unlocked accounts). A viem `LocalAccount`
   *  (P9-1, from `loadEvmLocalAccount`) signs locally: viem fills nonce, gas and fees through the same `rpc`
   *  (`eth_getTransactionCount`, `eth_estimateGas` and the fee reads, all public data; `eth_fillTransaction` is answered
   *  here with method-not-found and never asked of the endpoint, R1-FUND-02) and every write goes out as
   *  `eth_sendRawTransaction`, never `eth_sendTransaction`. The account viem signs with is a guarded wrapper (see
   *  src/rails/evm-signer.ts): it refuses any chain id but the pin's, a gas limit above `EVM_MAX_GAS_PER_WRITE` and a fee cap
   *  above `EvmRailConfig.maxFeePerGasWei`, with a typed `EvmSignerRefusedError`. This module never reads, stores or prints a key. */
  account: Address | LocalAccount;
  /** Resolves a counterparty's tclk DID to its EVM address for the vendored rail's write path
   *  (`lock()` needs the payee's address). Populated from `src/rails/account-line.ts`'s
   *  `resolveAccounts` in the client, out of this Stage's scope. */
  addressBook: AddressBook;
  clock?: () => number;
  /**
   * P9-4 decision 10 (P2R2-PIN-07): how long (ms) the write-evidence lookup pauses BEFORE each of its re-plans (a lookup that found no log re-reads the tip
   * and the whole range, at most `EVM_WRITE_LOOKUP_REPLANS` times). A log or a tip read a block behind the write's own receipt (a load-balanced endpoint)
   * is answered by waiting about one block, not by four reads in a row against the same stale view. A non-negative integer of at most
   * `MAX_LOOKUP_PAUSE_MS`. Omitted: no pause (the lookup re-plans at once, as before this option). `createEvmCounterRail` passes the chain's block time
   * (2 s on Base Sepolia, from its policy). A lookup that finds its log at once never pauses.
   */
  lookupPauseMs?: number;
  /** The pause itself: a timer by default; a test injects one that records the pauses (and, for a mock, lets a block pass). */
  sleep?: (ms: number) => Promise<void>;
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
  private readonly receiptWatch: ReceiptWatch;
  private readonly signerWatch: EvmSignerWatch;
  /** P9-4 decision 10: the pause before each re-plan of the write lookup (ms), and how it is made. */
  private readonly lookupPauseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** P94-FUND-01: the listeners `onWriteBroadcast` registered (the same set the receipt watch's `onWaitStart` walks). */
  private readonly broadcastListeners: Set<EvmWriteBroadcastListener>;

  private constructor(
    config: EvmRailConfig,
    rpc: CapturingRpc,
    publicClient: PublicClient,
    walletClient: WalletClient<Transport, Chain, Account>,
    rail: EvmHashRail,
    clock: () => number,
    receiptWatch: ReceiptWatch,
    signerWatch: EvmSignerWatch,
    lookupPauseMs: number,
    sleep: (ms: number) => Promise<void>,
    broadcastListeners: Set<EvmWriteBroadcastListener>,
  ) {
    this.config = config;
    this.rpc = rpc;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.rail = rail;
    this.clock = clock;
    this.receiptWatch = receiptWatch;
    this.signerWatch = signerWatch;
    this.lookupPauseMs = lookupPauseMs;
    this.sleep = sleep;
    this.broadcastListeners = broadcastListeners;
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
    const lookupPauseMs = options.lookupPauseMs ?? 0;
    if (typeof lookupPauseMs !== "number" || !Number.isSafeInteger(lookupPauseMs) || lookupPauseMs < 0 || lookupPauseMs > MAX_LOOKUP_PAUSE_MS) {
      throw new Error(`evm-htlc: refusing to connect - lookupPauseMs must be an integer from 0 to ${MAX_LOOKUP_PAUSE_MS}`);
    }

    const chain = chainFromPin(options.config.pin);
    // Main-loop review 2026-09-28 (after P22-P24-EVM-FIXES-R3.md E4): no transport-level
    // retries. viem's default (3 retries per request) let a rate-limited endpoint stretch the
    // gap between claim()'s last deadline guard and the broadcast well past the 5-minute
    // inclusion margin; with retries off, every request is one attempt bounded by the
    // CapturingRpc timeout, and every attempt is a single captured exchange.
    const transport = custom(options.rpc, { retryCount: 0 });
    if (typeof options.account !== "string") {
      // A LocalAccount (P9-1). Anything else (a smart account, a half-built object) is refused before a client is built.
      const local = options.account as { type?: unknown; address?: unknown; signTransaction?: unknown } | null;
      if (
        local === null ||
        typeof local !== "object" ||
        local.type !== "local" ||
        typeof local.address !== "string" ||
        !isAddress(local.address, { strict: false }) ||
        typeof local.signTransaction !== "function"
      ) {
        throw new Error("evm-htlc: refusing to connect: account must be an address or a local account");
      }
    }
    // P94-FUND-01: the listeners of `onWriteBroadcast`, told of every write's hash before its receipt wait starts (in order; an error of one never reaches the wait or the next).
    const broadcastListeners = new Set<EvmWriteBroadcastListener>();
    const receiptWatch: ReceiptWatch = {
      timeout: undefined,
      receiptBlock: undefined,
      write: undefined,
      onWaitStart: async (hash, write) => {
        for (const listener of [...broadcastListeners]) {
          try {
            await listener({ write, hash });
          } catch {
            // see EvmWriteBroadcastListener
          }
        }
      },
    };
    const signerWatch: EvmSignerWatch = { refused: undefined };
    const claimWaitCapMs = options.config.pin.chainId === BASE_SEPOLIA_CHAIN_ID ? EVM_CLAIM_RECEIPT_WAIT_MS_BASE_SEPOLIA : undefined;
    const publicClient = withReceiptTimeout(createPublicClient({ chain, transport }), options.config.receiptTimeoutMs, receiptWatch, claimWaitCapMs);
    // R1-FUND-02: a LOCAL account signs what viem hands it, and viem fills the chain id, gas and fee caps from the endpoint's answers.
    // Its account is therefore the guarded wrapper (a refusal of any chain id but the pin's, of a gas limit above EVM_MAX_GAS_PER_WRITE
    // and of a fee cap above the configured ceiling), and its transport answers `eth_fillTransaction` itself, with method-not-found, so
    // the chain id comes from the pinned chain and every other field from an individual read that the guard then judges.
    // A JSON-RPC account (an address) signs on the node and is unchanged.
    // R2-FUND-02: the same fee ceiling is also judged BEFORE `eth_estimateGas` (the call that carries a claim's preimage), by a `fees.estimateFeesPerGas`
    // hook on the wallet client's chain (and only there: the public client's chain has none). The sign-time guard above is the second line.
    const local = typeof options.account === "string" ? undefined : options.account;
    const maxFeePerGas = effectiveMaxFeePerGasWei(options.config);
    const walletClient =
      local === undefined
        ? createWalletClient({ account: options.account as Address, chain, transport })
        : createWalletClient({
            account: guardLocalAccount(local, { chainId: options.config.pin.chainId, maxGas: EVM_MAX_GAS_PER_WRITE, maxFeePerGas }, signerWatch),
            chain: { ...chain, fees: { estimateFeesPerGas: guardEstimateFeesPerGas(maxFeePerGas, signerWatch) } },
            transport: custom(refuseFillTransaction(options.rpc), { retryCount: 0 }),
          });

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

    // P9-2 (rule 2): a pinned contract is trusted by its code. One `eth_getCode` read, before any client is handed back, so no write can
    // happen against a different or empty contract. (Code at an address cannot change: the escrow has no upgrade path and no selfdestruct.)
    const pinnedCodeHash = options.config.contractCodeHash;
    if (pinnedCodeHash !== undefined) {
      const code = await options.rpc.request({ method: "eth_getCode", params: [options.config.contract, "latest"] });
      const verdict = judgeRuntimeCode(code, pinnedCodeHash);
      if (!verdict.ok) {
        throw new EvmContractCodeError(
          verdict.problem,
          options.config.contract,
          shortPinnedHash(pinnedCodeHash),
          verdict.problem === "mismatch" ? verdict.observed : undefined,
          describeCodeProblem(verdict, options.config.contract, pinnedCodeHash),
        );
      }
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

    return new EvmHtlcRail(
      options.config,
      options.rpc,
      publicClient,
      walletClient,
      rail,
      options.clock ?? Date.now,
      receiptWatch,
      signerWatch,
      lookupPauseMs,
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      broadcastListeners,
    );
  }

  /**
   * P94-FUND-01 (P9-FIXES-R4 decision 1, part 1): `listener` is called, and awaited, with the hash of EVERY write of this handle (approve, lock, claim, refund; the vendored rail's waits
   * included) the moment the node has accepted it and BEFORE the wait for its receipt starts, so the hash of a claim whose receipt never comes is already saved and shown while the wait
   * runs, not only after it ends. A public value (no key, no preimage). The listener cannot change what the write does: an error it throws is swallowed. Returns the function that removes it.
   */
  onWriteBroadcast(listener: EvmWriteBroadcastListener): () => void {
    this.broadcastListeners.add(listener);
    return () => {
      this.broadcastListeners.delete(listener);
    };
  }

  /** Runs one write through the vendored rail, which re-wraps every failure as `tclk: <reason>`: a receipt timeout recorded
   *  by the wrapped public client during this call is thrown back as the typed `EvmReceiptTimeoutError`. */
  private async viaVendoredRail(write: () => Promise<unknown>, kind: EvmWriteKind): Promise<void> {
    this.receiptWatch.timeout = undefined;
    this.receiptWatch.receiptBlock = undefined;
    this.signerWatch.refused = undefined;
    this.receiptWatch.write = kind; // P94-FUND-01: the wrapped public client reads it when the vendored write starts its receipt wait
    try {
      await write();
    } catch (error) {
      // R1-FUND-02: a signing refusal (nothing was sent) is thrown back typed, like a receipt timeout; the vendored rail has made it a `tclk: ...` Error.
      const refused = this.signerWatch.refused;
      if (refused !== undefined) throw refused;
      const timeout = this.receiptWatch.timeout as EvmReceiptTimeoutError | undefined; // set by the wrapped public client while `write` ran (the reset above narrows it)
      if (timeout !== undefined) throw new EvmReceiptTimeoutError(timeout.hash, timeout.timeoutMs, kind);
      throw error;
    } finally {
      this.receiptWatch.write = undefined;
    }
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
    this.signerWatch.refused = undefined;
    try {
      hash = await this.walletClient.writeContract({
        address: token,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [this.config.contract, BigInt(amount)],
      });
    } catch (error) {
      // R1-FUND-02: viem wraps the signer's refusal in its own error (whose text lists the request); the typed refusal is thrown instead.
      const refused: EvmSignerRefusedError | undefined = this.signerWatch.refused;
      if (refused !== undefined) throw refused;
      throw error;
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
    let receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
    this.receiptWatch.write = "approve"; // P94-FUND-01
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof EvmReceiptTimeoutError) throw new EvmReceiptTimeoutError(error.hash, error.timeoutMs, "approve");
      throw error;
    } finally {
      this.receiptWatch.write = undefined;
    }
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
      await this.viaVendoredRail(() => this.rail.lock(terms), "lock");
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
   * (`eth_call`, never a real transaction) means a doomed claim is never sent at all; any
   * revert cause refuses it, not only a blacklist.
   *
   * P22-P24-EVM-FIXES-R3.md E5: the simulation this used to run here carried the *real* secret
   * straight to whatever RPC endpoint this rail is configured against — an `eth_call`, never
   * broadcast, but the endpoint still saw the plaintext preimage on every attempt, successful
   * or not, before this method had even decided to send anything. `simulateClaimPreChecksOrThrow`
   * replaces it with two checks that never name the real secret; only once both pass does
   * `secret` ever reach a wire, and only then to broadcast the one real claim. README.md's EVM
   * section documents that the claim endpoint DOES see the real preimage at that final,
   * unavoidable step and must be one the operator trusts.
   *
   * P22-P24-EVM-FIXES-R3.md E4: `notAfterMs` (the caller's own `refundAfterMs −
   * claimInclusionMarginMs`) is enforced again, against fresh chain time, immediately before
   * the real broadcast — the last guard this method runs, after both pre-checks above have
   * already spent their own round trips (during which real wall-clock time keeps passing,
   * exactly what the reviewer's slow-RPC probe exploits).
   */
  async claim(hashLock: Hex, secret: Hex, notAfterMs: number): Promise<WriteEvidence> {
    await this.assertPinnedChainId();
    await this.simulateClaimPreChecksOrThrow(hashLock);
    const before = this.rpc.exchanges().length;
    // D1: see the identical comment on `approve` above.
    this.rpc.setIdNamespace(`write-claim:${hashLock}:${this.clock()}`);
    try {
      const fromBlock = await this.publicClient.getBlockNumber();
      // Main-loop review 2026-09-28: the deadline guard is the last read this method makes
      // before the claim transaction itself, so no slow read of ours can run between the guard
      // passing and the preimage going out. What follows is viem's own, each call a single
      // attempt with retries off and bounded by the CapturingRpc timeout: with a JSON-RPC
      // account, its chain-id assertion and `eth_sendTransaction`; with a local account (P9-1),
      // `eth_getTransactionCount`, `eth_getBlockByNumber`, the fee reads and `eth_estimateGas`
      // (`eth_fillTransaction` is answered with method-not-found inside this process and never
      // asked of the endpoint, R1-FUND-02), then `eth_sendRawTransaction`. The estimate carries
      // the real preimage in its calldata, as the broadcast does a moment later: the endpoint is
      // trusted with it either way, and nothing carries it before this guard
      // (tests/evm-local-signer.test.ts pins that). R2-FUND-02: the FEE ceiling is judged before
      // that estimate (the wallet client's chain hook, `guardEstimateFeesPerGas`, throws the typed
      // `fee` refusal before any request that carries the call data has left the process), so a claim
      // refused for its fee has sent nothing that holds the preimage; the sign-time guard is the second line.
      // The GAS ceiling can only follow the estimate (it judges the estimate), so a gas refusal has
      // already shown the preimage to the endpoint: only an endpoint that holds it anyway, or a claim
      // far larger than any measured one, triggers it. That is a handful of calls, not an
      // unbounded wait, and the policy's claimInclusionMarginMs is sized to cover it.
      await this.assertBeforeNotAfterMsOrThrow(notAfterMs);
      await this.viaVendoredRail(() => this.rail.claim(hashLock, secret), "claim");
      return await this.captureWriteEvidence("Claimed", hashLock, fromBlock, before);
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
  }

  /**
   * P22-P24-EVM-FIXES-R3.md E5: two preimage-free checks, both simulated (`eth_call`, never
   * broadcast) at the `pending` block (P22-P24-EVM-FIXES-R2.md C3's reasoning applies
   * identically here — `pending` never reports a time earlier than the one a real broadcast
   * will actually be evaluated at).
   *
   * (a) `claim(hashLock, ZERO_BYTES32)`: a zero preimage can never open a real hashLock, so the
   * *only* way this simulation can revert with exactly "EvmHashRail: secret does not open the
   * statement" is if every earlier `require` in the contract's own `claim()` already passed —
   * the lock exists, is `Locked` (not `None`/`Claimed`/`Refunded`), and `pending`'s own view is
   * still strictly before `refundAfterMs`. Any other revert (or no revert at all, which should
   * never happen for a real hashLock) refuses this claim with that other reason instead.
   *
   * (b) the lock's own `payee`/`token`/`amount` are public on-chain data (`locks(hashLock)`) —
   * reading them names no secret. Simulating the token's own `transfer(payee, amount)`,
   * impersonated from the rail contract's own address (exactly the internal call `claim()`
   * makes), proves the payout itself is not blocked — a blacklist, a pause, a token that has
   * quietly stopped honoring transfers — before the real secret is ever risked on a wire.
   */
  private async simulateClaimPreChecksOrThrow(hashLock: Hex): Promise<void> {
    let zeroPreimageReverted = false;
    try {
      await this.publicClient.simulateContract({
        address: this.config.contract,
        abi: EVM_HASH_RAIL_ABI,
        functionName: "claim",
        args: [hashLock, ZERO_BYTES32],
        account: this.walletClient.account,
        blockTag: "pending",
      });
    } catch (err) {
      const message = extractShortMessage(err);
      if (!message.includes("EvmHashRail: secret does not open the statement")) {
        throw new Error(
          `evm-htlc: refusing to broadcast claim — the pre-check simulation did not show an open, in-window lock (${message})`,
        );
      }
      zeroPreimageReverted = true;
    }
    // A zero preimage can never actually open a real hashLock (sha256 preimage resistance) — a
    // simulation that did NOT revert at all is not "fine", it means this endpoint's own
    // responses cannot be trusted to reflect the real contract (a stub, a lie, a bug), which is
    // exactly the situation this pre-check exists to catch before the real secret goes anywhere.
    if (!zeroPreimageReverted) {
      throw new Error(
        "evm-htlc: refusing to broadcast claim — the pre-check simulation unexpectedly did not revert for a zero preimage",
      );
    }

    const [, payee, token, amount] = await this.publicClient.readContract({
      address: this.config.contract,
      abi: EVM_HASH_RAIL_ABI,
      functionName: "locks",
      args: [hashLock],
    });
    try {
      await this.publicClient.simulateContract({
        address: token,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [payee, amount],
        account: this.config.contract,
        blockTag: "pending",
      });
    } catch (err) {
      throw new Error(`evm-htlc: refusing to broadcast claim — the payout itself simulates to a revert (${extractShortMessage(err)})`);
    }
  }

  /** P22-P24-EVM-FIXES-R3.md E4: the last guard before `claim()` ever broadcasts, read fresh
   *  here rather than trusted from anything a caller measured before calling this method — a
   *  caller's own pre-checks (`SellerFlow.claimLegA`'s chain-time guard) can still be stale by
   *  the time execution actually reaches this line if enough wall-clock time passed inside this
   *  same method's own two prior round trips. `max(pendingMs, clock())` never reports a time
   *  earlier than either input, the same rule C3's `chainNow` already applies elsewhere. */
  private async assertBeforeNotAfterMsOrThrow(notAfterMs: number): Promise<void> {
    const pendingMs = await this.pendingBlockTimestampMsOrThrow();
    const chainNow = Math.max(pendingMs, this.clock());
    if (chainNow >= notAfterMs) {
      throw new Error(
        `evm-htlc: refusing to broadcast claim — pending chain time ${chainNow} is at/after the given deadline (notAfterMs ${notAfterMs})`,
      );
    }
  }

  /** The `pending` twin of `latestBlockTimestampMs` — every EVM node's own best-effort
   *  next-block timestamp (`max(parent + 1, wall clock)` on anvil; P22-P24-EVM-FIXES-R2.md C3
   *  verified this empirically 2026-09-28 against anvil 1.8.3), so it never lags real elapsed
   *  time the way an idle chain's `latest` block can. */
  private async pendingBlockTimestampMsOrThrow(): Promise<number> {
    const result = (await this.rpc.request({ method: "eth_getBlockByNumber", params: ["pending", false] })) as {
      timestamp?: Hex;
    } | null;
    if (result === null || typeof result.timestamp !== "string") {
      throw new Error("evm-htlc: eth_getBlockByNumber(pending) returned no usable timestamp");
    }
    return hexToNumber(result.timestamp) * 1000;
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
      await this.viaVendoredRail(() => this.rail.refund(hashLock), "refund");
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
    // P9-3: the lookup is paged to the endpoint's range cap like every scan, and an answer needs every page: exactly one log across
    // them all. A range that cannot be covered inside the bound is refused up front (a part read would prove nothing about "one").
    // F7: the planned tip never lies below the block the write's own receipt came from (a tip read answered by a node that is behind
    // would cut the range below the write), and a lookup that finds NO log re-plans with a fresh tip and reads again, at most
    // `EVM_WRITE_LOOKUP_REPLANS` times, before it reports "found 0". Several logs are never retried.
    let plan = await this.planLogScan(fromBlock, this.receiptWatch.receiptBlock);
    if (plan.unread !== undefined) throw this.logScanBoundError(fromBlock, plan);
    let logs = await this.readWriteLogs(event, hashLock, plan);
    for (let replans = 0; logs.length === 0 && replans < EVM_WRITE_LOOKUP_REPLANS; replans += 1) {
      // P9-4 decision 10 (P2R2-PIN-07): about one block passes before the next read, so a view that is a block behind the write catches up instead of being read
      // four times in a row.
      if (this.lookupPauseMs > 0) await this.sleep(this.lookupPauseMs);
      plan = await this.planLogScan(fromBlock, this.receiptWatch.receiptBlock);
      if (plan.unread !== undefined) throw this.logScanBoundError(fromBlock, plan);
      logs = await this.readWriteLogs(event, hashLock, plan);
    }
    if (logs.length !== 1) {
      throw new Error(
        `evm-htlc: expected exactly one ${event} log for ${hashLock} in blocks [${fromBlock}, ${plan.tip ?? "latest"}], found ${logs.length}`,
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

  /** Every `event` log for `hashLock` across the planned ranges, oldest range first. */
  private async readWriteLogs(event: WriteEventName, hashLock: Hex, plan: LogScanPlan) {
    const logs = [];
    for (const range of plan.ranges) {
      logs.push(
        ...(await this.publicClient.getLogs({
          address: this.config.contract,
          event: WRITE_EVENT_ABI[event],
          args: { hashLock },
          fromBlock: range.from,
          toBlock: range.to,
        })),
      );
    }
    return logs;
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

  /**
   * P8-RESUME-SPEC.md "Buyer lock A": the lock stored under `hashLock` at the latest block (`locks(hashLock)`), or
   * `null` when the contract holds none (status `None`). A plain read, no write, no secret. It is the EVM recovery
   * handle: the ref of an EVM lock IS its hash lock, so a restarted Buyer finds out whether its `approve` + `lock`
   * pair landed by asking the contract, and a repeated `lock` for a hash lock that already has a row reverts on the
   * contract's own duplicate check. Throws on a status byte outside 0..3 (a node that does not speak for this
   * contract) and on a transport failure; neither is ever folded into `null`.
   */
  async readLock(hashLock: Hex, atBlock?: bigint): Promise<EvmLockRecord | null> {
    const [payer, payee, token, amount, claimByMs, refundAfterMs, status] = await this.publicClient.readContract({
      address: this.config.contract,
      abi: EVM_HASH_RAIL_ABI,
      functionName: "locks",
      args: [hashLock],
      // R2-FUND-01: a read pinned to one block (the finalized one); without it the latest block, as before.
      ...(atBlock === undefined ? {} : { blockNumber: atBlock }),
    });
    if (status === 0) return null;
    const names: Record<number, EvmLockStatus> = { 1: "Locked", 2: "Claimed", 3: "Refunded" };
    const name = names[status];
    if (name === undefined) throw new Error(`evm-htlc: locks(hashLock) returned an unknown status byte ${String(status)}`);
    return { status: name, payer, payee, token, amount, claimByMs, refundAfterMs };
  }

  /**
   * P9-4 decision 7 (R1-FUND-04): what the node says of a transaction this account sent and stopped waiting for (a write whose receipt wait timed out,
   * `EvmReceiptTimeoutError.hash`). Reads only: `eth_getTransactionByHash`, then, for a mined one, `eth_getTransactionReceipt`. `null` is `unknown`; a
   * transaction with no block is `pending` (the node still holds it); a mined one is read from its receipt (`success`, `reverted`), and a mined one with no
   * receipt yet is `pending` too (the two answers disagree: nothing is decided). An answer that names another transaction, or no usable status, or
   * a transport failure, throws: it is never read as `unknown` (which lets a flow send again).
   */
  async transactionStatus(txHash: Hex): Promise<EvmTransactionStatus> {
    const found = await this.rpc.request({ method: "eth_getTransactionByHash", params: [txHash] });
    if (found === null) return "unknown";
    if (typeof found !== "object" || Array.isArray(found)) throw new Error("evm-htlc: eth_getTransactionByHash answered something that is not a transaction");
    const tx = found as { hash?: unknown; blockNumber?: unknown };
    if (typeof tx.hash !== "string" || tx.hash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("evm-htlc: eth_getTransactionByHash answered another transaction than the one asked for");
    }
    if (tx.blockNumber === null || tx.blockNumber === undefined) return "pending";
    if (typeof tx.blockNumber !== "string" || !/^0x[0-9a-fA-F]+$/.test(tx.blockNumber)) {
      throw new Error("evm-htlc: eth_getTransactionByHash answered a block number that is not a hex number");
    }
    const receipt = await this.rpc.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt === null) return "pending";
    const status = typeof receipt === "object" && !Array.isArray(receipt) ? (receipt as { status?: unknown }).status : undefined;
    if (status === "0x1") return "success";
    if (status === "0x0") return "reverted";
    throw new Error("evm-htlc: eth_getTransactionReceipt answered a receipt without a usable status");
  }

  /**
   * R2-FUND-01: the chain's FINALIZED block under this rail's own finality knob (`config.pin.finality`, read the way the evidence reader
   * reads it: the `finalized` tag, else `fallbackConfirmations` blocks below the head, or the configured confirmations), as its number and
   * timestamp, or `null` when none can be read (the tag is not served and no fallback is configured, the chain is younger than the
   * confirmations, or the answer is not a block). `null` is never read as "final": a caller that needs a finalized block waits.
   */
  async finalizedBlock(): Promise<EvmBlockHead | null> {
    const finality = this.config.pin.finality;
    if (finality.mode === "confirmations") return this.numberedBlock(finality.confirmations);
    let tagged: EvmBlockHead | null = null;
    try {
      tagged = blockHeadOf(await this.rpc.request({ method: "eth_getBlockByNumber", params: [finality.tag, false] }));
    } catch {
      tagged = null; // a node that does not serve the tag (or an error reply): the same fallback as the evidence reader
    }
    if (tagged !== null) return tagged;
    return finality.fallbackConfirmations === undefined ? null : this.numberedBlock(finality.fallbackConfirmations);
  }

  private async numberedBlock(confirmations: number): Promise<EvmBlockHead | null> {
    const raw = await this.rpc.request({ method: "eth_blockNumber", params: [] });
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
    const target = BigInt(raw) - BigInt(confirmations);
    if (target < 0n) return null; // the chain has not produced that many blocks yet: nothing is final
    return blockHeadOf(await this.rpc.request({ method: "eth_getBlockByNumber", params: [numberToHex(target), false] }));
  }

  /**
   * R3-FUND-03 (P9 review round 3): the finalized block for the PERMANENT verdict of `readLockAbsence`. `finalizedBlock()` falls back to the
   * `fallbackConfirmations` block on ANY error or malformed answer to the tag read, which suits a reader that only waits and asks again; the verdict
   * is recorded for good, and one transient error (a rate limit, a 5xx) must not turn a block a few blocks below the head into "the finalized one"
   * while the real one is far behind. Here an error or a malformed answer to the tag read is "no finalized block" (`null`: not final, ask again), and
   * the fallback applies only when the node SAYS it does not serve the tag: a JSON-RPC error with code -32601 or -32602, or a `null` result. Confirmations
   * mode is read as `finalizedBlock()` reads it (an error there propagates).
   */
  private async finalizedBlockForVerdict(): Promise<EvmBlockHead | null> {
    const finality = this.config.pin.finality;
    if (finality.mode === "confirmations") return this.numberedBlock(finality.confirmations);
    const fallback = (): Promise<EvmBlockHead | null> => (finality.fallbackConfirmations === undefined ? Promise.resolve(null) : this.numberedBlock(finality.fallbackConfirmations));
    let answer: unknown;
    try {
      answer = await this.rpc.request({ method: "eth_getBlockByNumber", params: [finality.tag, false] });
    } catch (error) {
      return error instanceof RpcCaptureError && (error.code === -32601 || error.code === -32602) ? fallback() : null;
    }
    if (answer === null) return fallback();
    return blockHeadOf(answer);
  }

  /**
   * R2-FUND-01: has the lock this account tried to make under `hashLock` landed, or can it no longer land? Only reads; nothing is sent. The verdict
   * is permanent once recorded, so it rests on the FINALIZED block alone. R3-FUND-02 (P9 review round 3): `landed`, which the Buyer records as
   * evidence, is answered only from a row AT the finalized block; a row present only at the latest block is not final (an unsafe block can be
   * reorged away, and a lock cannot land again at or past the refund time) and gives `not-final`, which the runner waits out as it waits for the
   * typed error. With no row at the finalized block and that block's timestamp at or past `refundAfterMs`, the contract's own `lock` requires
   * `block.timestamp * 1000 < refundAfterMs` (contracts/EvmHashRail.sol), so a lock could only ever sit in a block BEFORE the finalized one, and the
   * decision is made by the row at that block alone: absent is `never-locked`. A row present only at latest there is an inconsistent read (no lock
   * can sit above the finalized block) and gives `not-final`. A finalized block before `refundAfterMs`, or none (R3-FUND-03: also an error or a
   * malformed answer to the tag read, see `finalizedBlockForVerdict`), is `not-final`. The latest row is read BEFORE the finalized one and is only ever
   * a hint, never evidence. A transport failure or a malformed answer to a row read propagates and is never read as "absent".
   */
  async readLockAbsence(hashLock: Hex, refundAfterMs: number): Promise<EvmLockAbsence> {
    const finalized = await this.finalizedBlockForVerdict();
    if (finalized === null) return { kind: "not-final" };
    const latest = await this.readLock(hashLock);
    const atFinalized = await this.readLock(hashLock, finalized.number);
    if (atFinalized !== null) return { kind: "landed", row: atFinalized };
    if (finalized.timestampMs < refundAfterMs) return { kind: "not-final" };
    if (latest !== null) return { kind: "not-final" };
    return { kind: "never-locked", finalized };
  }

  /** §2.2 point 4: bounded `eth_getLogs` for `Claimed(hashLock, preimage)`; returns the
   *  preimage only if it actually opens the statement (`sha256(preimage) === hashLock`) —
   *  never trusts the log's shape alone. How the Buyer learns `s` when the Seller claims on
   *  chain before (or without) posting its reveal frame. */
  async findClaimedPreimage(hashLock: Hex, fromBlock: bigint): Promise<Hex | null> {
    // P9-3 + R1-FUND-03: `[fromBlock, tip]` is read in ranges of at most the endpoint's cap, OLDEST range first from `fromBlock`: a
    // claim can only land before the leg's refund time, so it lies in the first ranges above the marker whenever the scan runs, and
    // the 100-call bound is a property of the leg's window, not of how late the scan is (newest first made an old claim unfindable).
    // A preimage found in any range is returned whatever lies above it. A range left unread when the bound runs out is never reported
    // as "no claim": the typed error says the scan is incomplete.
    const plan = await this.planLogScan(fromBlock);
    for (const range of plan.ranges) {
      const logs = await this.publicClient.getLogs({
        address: this.config.contract,
        event: CLAIMED_EVENT,
        args: { hashLock },
        fromBlock: range.from,
        toBlock: range.to,
      });
      for (const log of logs) {
        const preimage = log.args.preimage;
        if (preimage !== undefined && verifyHashPreimage(hashLock, preimage)) return preimage;
      }
    }
    if (plan.unread !== undefined) throw this.logScanBoundError(fromBlock, plan);
    return null;
  }

  /**
   * P9-3 (rule 3): the `eth_getLogs` ranges that cover `[fromBlock, tip]`, OLDEST first (R1-FUND-03). With no limit in force (anvil's
   * default) it is the one range `[fromBlock, "latest"]` as before and no tip is read. With a limit, the tip is read once, fresh
   * (`eth_blockNumber` through the capturing transport, never viem's cached block number), and the span is cut from `fromBlock` upwards
   * into ranges of at most `maxLogRange` blocks (both ends counted, so a 500-block range is `to - from + 1 = 500`), at most
   * `MAX_LOG_SCAN_CHUNKS` of them; whatever newer part does not fit is returned as `unread`, for the caller to refuse or report, never
   * silently dropped. A start above the tip has no range at all. `minTip` (F7) floors the tip read: a node a block or two behind the
   * write's own receipt must not cut the plan below the block the write landed in.
   */
  private async planLogScan(fromBlock: bigint, minTip?: bigint): Promise<LogScanPlan> {
    const limit = effectiveMaxLogRange(this.config);
    if (limit === undefined) return { ranges: [{ from: fromBlock, to: "latest" }], tip: undefined, unread: undefined, limit: undefined };
    const raw = await this.rpc.request({ method: "eth_blockNumber", params: [] });
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      throw new Error("evm-htlc: eth_blockNumber returned something that is not a hex number, so a log scan cannot be planned");
    }
    const read = BigInt(raw);
    const tip = minTip !== undefined && minTip > read ? minTip : read;
    const width = BigInt(limit);
    const ranges: LogRange[] = [];
    let low = fromBlock;
    while (low <= tip && ranges.length < MAX_LOG_SCAN_CHUNKS) {
      const high = low + width - 1n < tip ? low + width - 1n : tip;
      ranges.push({ from: low, to: high });
      low = high + 1n;
    }
    return { ranges, tip, unread: low <= tip ? { from: low, to: tip } : undefined, limit };
  }

  private logScanBoundError(fromBlock: bigint, plan: LogScanPlan): EvmLogScanBoundError {
    if (plan.unread === undefined || plan.tip === undefined || plan.limit === undefined) {
      throw new Error("evm-htlc: internal error: a log scan bound error without a bounded plan");
    }
    return new EvmLogScanBoundError(fromBlock, plan.tip, plan.unread.from, plan.unread.to, plan.limit, MAX_LOG_SCAN_CHUNKS);
  }
}
