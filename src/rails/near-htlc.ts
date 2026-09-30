// SPDX-License-Identifier: MIT
//
// The desk-facing `near-htlc` adapter (P5-NEAR-SPEC.md §4): a chain pin with an allow list
// (near-sandbox-flop, testnet), a re-checked-before-every-write network guard, and keyless
// writes via an in-memory `NearSigner` (§1) — no private key, seed or mnemonic for either party
// is ever read from disk or env anywhere in this build; the concrete in-memory implementation
// lives only in `near-signer-memory.ts`, imported only by tests/harness code.
//
// D-N4's "sign-and-record, then broadcast" rule, generalised over every write this rail makes:
// `prepareLock`/`commitLock` split the lock write into "build+sign, record `ref`+`txHash`" and
// "actually broadcast" (mirroring `btc-htlc.ts`'s `prepareFunding`/`broadcastFunding`), because
// the ref (`0x<hash lock>:<payer>`) is known before ever touching the network. `claim`/`refund` are single
// calls that still internally sign-and-record before ever sending (the tx hash is deterministic
// from the signed bytes, so a caller recovering from a lost reply uses `recoverByTxHash`, never
// re-signs blind).
//
// Every write re-checks the pinned chain right before it signs (mirrors `btc-htlc.ts`'s
// `assertPinnedChain`/`evm-htlc.ts`'s `assertPinnedChainId` — A10's rule: a long-lived rail
// instance drives an entire swap, so refusing to sign anywhere but the pinned chain is cheap
// insurance against a reused RPC endpoint having quietly started answering for a different
// chain). `claim()`'s deadline guard (`notAfterMs`) is read fresh and re-checked as the LAST
// thing before broadcast (P22-P24-EVM-FIXES-R3.md E4's rule, reused here) — no earlier read,
// however recent, is trusted for it.
//
// This stage (NB2a) builds the borsh writer, the RPC client, and this adapter, all hermetically
// testable against a mocked RPC. The pure, replayable evidence reader (`near-evidence.ts`) and
// the rail-agnostic client wiring (`src/client/near-rail.ts`) are later stages, same as BB1 was
// for Bitcoin — `verifyLockFinal` is intentionally not implemented here.
//
// Design source: flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md (D-N1..D-N12);
// flop-contrib/handoff/P5-NEAR-SPEC.md §1/§3/§4.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

import { buildSignedTransaction, type NearAction, type NearTransactionV0 } from "./near-borsh.js";
import {
  NearFunctionCallPanicError,
  NearRpc,
  NearUnknownTransactionError,
  type NearBlockRef,
  type NearTxOutcome,
} from "./near-rpc.js";
import { formatNearRef, NEAR_ACCOUNT_ID, NEAR_HASH_LOCK_SHAPE, requireNearRef } from "./near-ref.js";
import type { CapturingRpc } from "./rpc-capture.js";

// --- H1: typed write-result errors ---------------------------------------------------------
//
// H1: "a write succeeds only when the chain says so." Every write this rail makes now goes
// through two gates before its evidence is ever handed back to a caller: (1) the transaction's
// own top-level `status` must not be `Failure` (a contract panic, an out-of-gas, ...) — checked
// first, inside `sendPrepared`/`recoverByTxHash`, and thrown as `NearTxFailedError`; (2) for a
// `Success` transaction, `sendPrepared` re-reads `get_lock` at `final` and confirms the write
// actually produced the state this rail's own caller asked for — a `ft_transfer_call` that ran
// to completion but never created the intended lock (S3: refused by `ft_on_transfer`) or a
// claim/refund whose OWN inner promise chain failed (S1: the payee was unregistered when the
// payout promise ran) both still return `Success` at the top level; only this second read
// catches them.

/** A transaction's own top-level `status` was `Failure` — the write never happened; the ref
 *  (hash lock or recovered tx hash) is NOT evidence of anything. `raw` is this write's own
 *  captured exchange hashes (never lost, even on failure — a caller reconstructing what happened
 *  still has the wire bytes). */
export class NearTxFailedError extends Error {
  readonly txHash: string;
  readonly failure: unknown;
  readonly raw: readonly string[];
  constructor(txHash: string, failure: unknown, raw: readonly string[]) {
    super(`near-htlc: transaction ${txHash} failed on chain: ${JSON.stringify(failure)}`);
    this.name = "NearTxFailedError";
    this.txHash = txHash;
    this.failure = failure;
    this.raw = raw;
  }
}

/** `commitLock`'s post-send check: the transaction was `Success`, but `get_lock` afterward does
 *  not show a lock owned by this signer with the exact terms it sent (S3: `ft_on_transfer`
 *  refused the transfer — bad msg, duplicate hash lock, a token that isn't the configured USDC,
 *  the contract's own storage-reserve guard, ...) — the token contract already refunded the
 *  sender in full; there is no lock to act on. */
export class NearLockRefusedError extends Error {
  readonly txHash: string;
  readonly raw: readonly string[];
  constructor(txHash: string, raw: readonly string[]) {
    super("near-htlc: lock refused by the contract, tokens returned");
    this.name = "NearLockRefusedError";
    this.txHash = txHash;
    this.raw = raw;
  }
}

/** H9: `commitLock` cannot tell whether THIS transaction made the lock -- the transaction's own
 *  `SuccessValue` did not say the whole amount was used, or the lock is not (yet) visible as
 *  `Locked` with these exact terms even after one re-read at a later final block. Deliberately
 *  non-committal: it does NOT say the tokens were returned (only `NearLockRefusedError`, on an
 *  outcome that says `"0"`, says that). The caller's next step is `reconcileLockA`. */
export class NearLockUnknownError extends Error {
  readonly txHash: string;
  readonly raw: readonly string[];
  constructor(txHash: string, detail: string, raw: readonly string[]) {
    super(`near-htlc: the lock outcome of transaction ${txHash} is unknown (${detail}) -- call reconcileLockA`);
    this.name = "NearLockUnknownError";
    this.txHash = txHash;
    this.raw = raw;
  }
}

/** H10: `recoverByTxHash` was handed a transaction that is not this rail's own write for the
 *  expected ref (another signer, another receiver, another method, another hash lock or payer). */
export class NearUnexpectedTransactionError extends Error {
  readonly txHash: string;
  constructor(txHash: string, detail: string) {
    super(`near-htlc: transaction ${txHash} is not this rail's write for the expected ref: ${detail}`);
    this.name = "NearUnexpectedTransactionError";
    this.txHash = txHash;
  }
}

/** `claim`'s post-send check: the transaction was `Success` (the `claim` method itself ran and
 *  revealed the preimage) but the contract's own inner `ft_transfer` payout promise failed (S1:
 *  the payee was unregistered by the time the payout promise ran), reverting the lock's status
 *  back to `Locked` while keeping the preimage public (the contract's own F4 rule). The preimage
 *  is included so a caller never has to make a second read just to learn it — the reveal frame
 *  may still be posted even though the payout itself must be retried (`H2`'s revealed-lock
 *  retry, once the underlying cause is fixed). */
export class NearPayoutFailedError extends Error {
  readonly txHash: string;
  readonly preimage: string | null;
  readonly raw: readonly string[];
  constructor(txHash: string, preimage: string | null, raw: readonly string[]) {
    super("near-htlc: payout failed, retry the claim");
    this.name = "NearPayoutFailedError";
    this.txHash = txHash;
    this.preimage = preimage;
    this.raw = raw;
  }
}

/** `claim`'s post-send check: the lock is still `Claiming` — the outer transaction settled at
 *  `final`, but the contract's own inner payout promise/callback had not yet resolved when this
 *  rail re-read `get_lock`. Neither success nor failure is known yet; a caller should re-check
 *  shortly rather than treat this as either. */
export class NearPendingError extends Error {
  readonly txHash: string;
  readonly raw: readonly string[];
  constructor(txHash: string, raw: readonly string[]) {
    super("near-htlc: claim is pending (Claiming) on chain — check again shortly");
    this.name = "NearPendingError";
    this.txHash = txHash;
    this.raw = raw;
  }
}

/** `refund`'s post-send check: the transaction was `Success` but `get_lock` afterward does not
 *  show `Refunded` (the inner `ft_transfer` payout promise failed — mirrors `NearPayoutFailedError`
 *  for the refund side, but refund never reveals a preimage, so there is nothing further to
 *  carry). */
export class NearRefundFailedError extends Error {
  readonly txHash: string;
  readonly raw: readonly string[];
  constructor(txHash: string, raw: readonly string[]) {
    super("near-htlc: refund failed on chain");
    this.name = "NearRefundFailedError";
    this.txHash = txHash;
    this.raw = raw;
  }
}

// --- Chain pin, allow list, config validation -------------------------------------------------

export interface NearChainPin {
  name: string;
  /** NEAR's own `chain_id`, as `status` reports it (e.g. `"near-sandbox-flop"`, `"testnet"`). */
  chainId: string;
  /** `near:<chainId>` — NEAR is not itself a registered CAIP-2 namespace with a fixed reference
   *  grammar the way `bip122`/`eip155` are; this build's own convention (D-N5/D-N3), used
   *  consistently in the pin, the account-line namespace, and every D-08 line. */
  caip2: string;
  /** NEAR's own finality is a gadget (Doomslug/Nightshade), not a confirmations count — this
   *  build only ever reads at `"final"` (D-N7/D-N10). */
  finality: "final";
}

/** D-N3: the sandbox's own fixed chain id, set in the throwaway home's `genesis.json` before
 *  `run`. Confirmed live once NB-int stands a sandbox up; until then this is the value the
 *  harness is instructed to configure, not yet observed against a real node. */
export const NEAR_SANDBOX_PIN: NearChainPin = {
  name: "near-sandbox",
  chainId: "near-sandbox-flop",
  caip2: "near:near-sandbox-flop",
  finality: "final",
};

/** UNVERIFIED (mirrors `btc-htlc.ts`'s own `BTC_SIGNET_PIN` convention): this build has never
 *  connected to a real NEAR testnet node. `connect()`'s own chain check refuses a live node that
 *  disagrees, so using this pin by mistake fails closed rather than silently mispinning. */
export const NEAR_TESTNET_PIN: NearChainPin = {
  name: "near-testnet-UNVERIFIED",
  chainId: "testnet",
  caip2: "near:testnet",
  finality: "final",
};

/** Allow list, not a deny list (mirrors the Bitcoin/EVM legs' own A3 rule): only these two chain
 *  ids are ever accepted, so a live `status().chain_id` of `"mainnet"` is refused by name, and so
 *  is anything nobody thought to name. */
const ALLOWED_CHAIN_IDS: ReadonlySet<string> = new Set(["near-sandbox-flop", "testnet"]);
const DENY_CHAIN_NAMES: ReadonlySet<string> = new Set(["mainnet"]);
const KNOWN_PINS: readonly NearChainPin[] = [NEAR_SANDBOX_PIN, NEAR_TESTNET_PIN];

function knownPinFor(chainId: string): NearChainPin | null {
  return KNOWN_PINS.find((pin) => pin.chainId === chainId) ?? null;
}

/** D-N8: this build's single settled asset (USDC on every USD leg, per the handoff's own
 *  cross-chain decision) — always `"USDC"`, never configurable per swap. */
export const NEAR_ASSET_ID = "USDC";

/** D-N8: the smallest lockable amount — "1" (one micro-USDC unit; the contract itself refuses
 *  `amount == 0`, per `ft_on_transfer`'s own validation). Exported for the (later) client rail's
 *  own `minLockableAmount`. */
export const NEAR_AMOUNT_FLOOR = "1";

/** No credentials here, ever — mirrors `btc-htlc.ts`'s `BtcRailConfig`/`evm-htlc.ts`'s
 *  `EvmRailConfig`. `assets.USDC` is the NEP-141 token's own account id, not a key. */
export interface NearRailConfig {
  pin: NearChainPin;
  endpoint: string;
  /** The HTLC contract's own NEAR account id. */
  contract: string;
  assets: { USDC: string };
  /** H6: base58 sha256 of the reviewed `htlc` contract wasm (the harness fills this from
   *  `build.sh`'s own output — see `tests-near/helpers/sandbox.ts`). Optional at the TYPE level
   *  only, so existing `NearRailConfig` object literals elsewhere in this repo built before H6
   *  continue to type-check; REQUIRED at the RUNTIME level by `nearRailConfigShapeReason` —
   *  `checkNearRailConfig`/`connect()` refuse any config missing it before ever touching the
   *  network. `connect()` then reads `view_account(contract).code_hash` and
   *  `view_access_key_list(contract)` at the same final block and refuses to connect unless the
   *  code hash matches exactly and the contract holds zero access keys (a locked, immutable
   *  deployment) — a compromised or since-redeployed contract must never be trusted as the
   *  reviewed one just because its account id matches. */
  htlcCodeHash?: string;
}

/** D-N5: NEAR account ids permit `_` (a deliberate deviation from the generic CAIP-10 charset,
 *  documented here rather than silently accepted): lowercase letters, digits, and `-`/`_`/`.` as
 *  interior separators, 2-64 chars, never leading/trailing or doubled-up separators. This is a
 *  practical subset of NEAR's own account-id grammar (a valid NEAR id can also nest a top-level
 *  account through multiple `.` segments — matched here too, since each segment obeys the same
 *  rule). */
// The grammar itself lives in `near-ref.ts` (shared with the ref helper: no `:` is what makes
// the compound ref unambiguous).

const HASH_LOCK_SHAPE = NEAR_HASH_LOCK_SHAPE;
const SECRET_SHAPE = /^0x[0-9a-f]{64}$/;
const NONNEG_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Shape-only check on a config that could have come from untrusted/untyped data — mirrors
 * `btcRailConfigShapeReason`/`evmRailConfigShapeReason`. `null` when the shape checks out;
 * otherwise the first reason it doesn't.
 */
export function nearRailConfigShapeReason(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "near rail config is not an object";
  const v = value as Record<string, unknown>;

  if (v.pin === null || typeof v.pin !== "object") return "near rail config: pin is not an object";
  const pin = v.pin as Record<string, unknown>;
  if (typeof pin.name !== "string" || pin.name === "") return "near rail config: pin.name must be a non-empty string";
  if (typeof pin.chainId !== "string" || pin.chainId === "") return "near rail config: pin.chainId must be a non-empty string";
  if (typeof pin.caip2 !== "string" || pin.caip2 !== `near:${pin.chainId}`) {
    return 'near rail config: pin.caip2 must be "near:<chainId>"';
  }
  if (pin.finality !== "final") return 'near rail config: pin.finality must be "final"';

  if (typeof v.endpoint !== "string" || v.endpoint === "") return "near rail config: endpoint must be a non-empty string";
  if (typeof v.contract !== "string" || !NEAR_ACCOUNT_ID.test(v.contract)) {
    return "near rail config: contract must be a valid NEAR account id";
  }
  if (v.assets === null || typeof v.assets !== "object" || Array.isArray(v.assets)) {
    return "near rail config: assets must be an object";
  }
  const assets = v.assets as Record<string, unknown>;
  if (typeof assets.USDC !== "string" || !NEAR_ACCOUNT_ID.test(assets.USDC)) {
    return "near rail config: assets.USDC must be a valid NEAR account id";
  }
  // H6: required at runtime (see the field's own doc comment for why it stays optional at the
  // type level).
  if (typeof v.htlcCodeHash !== "string" || v.htlcCodeHash === "") {
    return "near rail config: htlcCodeHash must be a non-empty string (H6: the pinned contract code hash)";
  }
  return null;
}

/** Runtime checks that don't need a live chain: the pin's chain id is on the allow list, is not
 *  a denied name (mainnet — refused explicitly, not merely by omission), matches a known pin
 *  exactly, and that known pin's own name (H3's "a config cannot rename a known pin" rule,
 *  reused here). `connect()` additionally checks the LIVE `status().chain_id` against this same
 *  allow list before ever comparing it to the pin. */
export function validateNearRailConfig(config: NearRailConfig): void {
  if (!ALLOWED_CHAIN_IDS.has(config.pin.chainId)) {
    throw new Error(
      `near-htlc: chain id "${config.pin.chainId}" is not on the allow list (near-sandbox-flop, testnet only)` +
        (DENY_CHAIN_NAMES.has(config.pin.chainId) ? `; refusing ${config.pin.chainId} by name` : ""),
    );
  }
  const known = knownPinFor(config.pin.chainId);
  if (known === null) {
    throw new Error(`near-htlc: chain id "${config.pin.chainId}" does not match any known pin (near-sandbox, near-testnet-UNVERIFIED)`);
  }
  if (config.pin.name !== known.name) {
    throw new Error(`near-htlc: pin.name "${config.pin.name}" does not match the known pin's own name "${known.name}" for this chain id`);
  }
}

export type NearRailConfigCheck = { ok: true; config: NearRailConfig } | { ok: false; reason: string };

export function checkNearRailConfig(value: unknown): NearRailConfigCheck {
  const shapeReason = nearRailConfigShapeReason(value);
  if (shapeReason !== null) return { ok: false, reason: shapeReason };
  const config = value as NearRailConfig;
  try {
    validateNearRailConfig(config);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, config };
}

// --- Signer ------------------------------------------------------------------------------------

/** §1: the ONLY thing this rail ever touches to produce a signature — never a raw key. The
 *  concrete in-memory implementation lives in `near-signer-memory.ts` (tests/harness only). */
export interface NearSigner {
  readonly accountId: string;
  /** `"ed25519:<base58>"` — NEAR's own public key string form. */
  readonly publicKey: string;
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

function decodePublicKey(publicKey: string): Uint8Array {
  const prefix = "ed25519:";
  if (!publicKey.startsWith(prefix)) {
    throw new Error(`near-htlc: unsupported public key format "${publicKey}" (only ed25519: is supported)`);
  }
  const bytes = base58.decode(publicKey.slice(prefix.length));
  if (bytes.length !== 32) throw new Error("near-htlc: ed25519 public key must decode to exactly 32 bytes");
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// --- Terms, gas, evidence types ----------------------------------------------------------------

export interface NearHtlcTerms {
  /** sha256(preimage) — `0x` + 64 lowercase hex (matches tclk's own hash-statement grammar). */
  hashLock: string;
  /** Micro-USDC units, decimal-integer string. */
  amount: string;
  payee: string;
  claimByMs: number;
  refundAfterMs: number;
}

/** H5: "refuse a payee that can never receive." A lock whose payee is the HTLC contract itself
 *  or the USDC token account itself can never be claimed by an actual counterparty — the
 *  contract's own `ft_on_transfer` refuses the SAME two accounts as payee (belt and suspenders:
 *  this adapter-side check means the Buyer's `prepareLock` never even signs such a transaction,
 *  and the contract-side check means it is refused even if some other caller sends it directly). */
function validateTerms(terms: NearHtlcTerms, config: NearRailConfig): void {
  if (!HASH_LOCK_SHAPE.test(terms.hashLock)) {
    throw new Error("near-htlc: hashLock must be 0x + 64 lowercase hex (sha256 statement)");
  }
  if (!NEAR_ACCOUNT_ID.test(terms.payee)) {
    throw new Error("near-htlc: payee must be a valid NEAR account id");
  }
  if (terms.payee === config.contract) {
    throw new Error("near-htlc: payee must not be the HTLC contract itself (H5: it could never receive or spend the payout)");
  }
  if (terms.payee === config.assets.USDC) {
    throw new Error("near-htlc: payee must not be the USDC token account itself (H5: it could never receive or spend the payout)");
  }
  if (!NONNEG_DECIMAL.test(terms.amount) || BigInt(terms.amount) < BigInt(NEAR_AMOUNT_FLOOR)) {
    throw new Error(`near-htlc: amount must be a decimal-integer string >= the floor (${NEAR_AMOUNT_FLOOR})`);
  }
  if (!(terms.claimByMs < terms.refundAfterMs)) {
    throw new Error("near-htlc: claimByMs must be strictly before refundAfterMs");
  }
}

/** D-N9: explicit gas constants. Corrected here (NB-int) from the provisional 100/60 Tgas
 *  against REAL measured burn on a live near-sandbox node (`tests-near/near-htlc.near.test.ts`'s
 *  own `measuredGasBurnt`, reading each write's own captured `send_tx` outcome's total gas burnt
 *  across the whole receipt chain — the transaction outcome plus every receipt it produced, as
 *  originally measured with the provisional 100/60 Tgas attached): `ft_transfer_call` (lock)
 *  burnt ~6.90 Tgas, `claim` ~7.36 Tgas, `refund` ~7.27 Tgas (this commit's own message carries
 *  the exact numbers).
 *
 *  `FT_TRANSFER_CALL_GAS` (20 Tgas, ~3x the measured 6.90) held up fine at that lower ceiling —
 *  `ft_on_transfer` never schedules a further cross-contract call of its own (only
 *  near-contract-standards' OWN `ft_resolve_transfer` chain does, which the token contract
 *  allocates internally). `claim`/`refund` are different: the CONTRACT itself statically
 *  sub-allocates `FT_TRANSFER_GAS` (10 Tgas) + `CALLBACK_GAS` (10 Tgas) = 20 Tgas out of
 *  whatever is attached to the outer `claim`/`refund` `FunctionCall`, and that reservation is
 *  checked eagerly against what remains AFTER the method's own pre-promise execution (account/
 *  storage reads, the sha256 check, the `LookupMap` write) — dropping `CLAIM_REFUND_GAS` to 20
 *  Tgas (tried during this same measurement pass) left no room for that overhead on top of the
 *  20 Tgas already earmarked for the two promises, and the payout callback failed every time
 *  (lock reverted to `Locked`, no payout) even though the FINAL measured burn (~7.3 Tgas) was
 *  well under 20 — confirming empirically that "total burn" and "gas that must be reservable
 *  when the promise is created" are two different constraints. 40 Tgas (double the contract's
 *  own 20 Tgas of static sub-allocations) is what this stage confirmed actually succeeds. */
const TGAS = 1_000_000_000_000n;
export const FT_TRANSFER_CALL_GAS = 20n * TGAS;
export const CLAIM_REFUND_GAS = 40n * TGAS;
const ONE_YOCTO = 1n;

/** H13: every read this rail makes before (and right after) a write gives up after this long
 *  (`send_tx`/`txStatus` are not reads and wait for finality). The claim's deadline guard is the
 *  last read before broadcast, so the worst case between "guard read answered" and "claim
 *  broadcast" is bounded by signing plus one round trip, and the worst case for a read that
 *  answers just under its bound is this many ms of staleness. */
export const NEAR_PRESEND_READ_TIMEOUT_MS = 5_000;

/** H3: the adapter's own last-moment guard on `claim`'s `notAfterMs` — a claim whose deadline
 *  leaves less than this much room before the lock's own `refundAfterMs` is refused before ever
 *  signing, so a claim that could plausibly land ON or AFTER the refund window opens (a race the
 *  Seller could lose to the Buyer's own refund) is never attempted in the first place. 30s is
 *  this build's own sandbox pin (blocks every ~0.65s, D-N3) — the comment on the constant itself
 *  is the record that a live testnet deployment needs a wider margin than this.
 *
 *  H13: it exceeds `NEAR_PRESEND_READ_TIMEOUT_MS` (the staleness of the guard's own read) by far
 *  more than a few blocks (finality plus inclusion is 2-3 blocks, ~2 s on the sandbox); a test
 *  pins that relation. */
export const NEAR_CLAIM_LANDING_MARGIN_MS = 30_000;

/** H9: how long `commitLock` waits before its one re-read of a lock that was not yet visible --
 *  long enough for a later final block on the sandbox (blocks ~0.65 s, finality ~2 blocks). */
export const NEAR_LOCK_REREAD_DELAY_MS = 2_000;

export interface NearWriteEvidence {
  ref: string;
  txHash: string;
  blockHeight: number;
  blockHash: string;
  raw: string[];
}

interface NearPreparedWrite {
  ref: string;
  txHash: string;
  signedTxBase64: string;
  /** H1: which write this is, so `sendPrepared`'s own post-send `get_lock` re-read knows what
   *  "the write actually took effect" means for THIS write. */
  kind: "lock" | "claim" | "refund";
  /** H1 (`kind: "lock"` only): the exact terms `prepareLock` signed — `sendPrepared` confirms
   *  `get_lock` afterward shows a lock owned by this signer with these exact terms before ever
   *  treating a `Success` transaction as evidence of a real lock (S3: `ft_on_transfer` can refuse
   *  the transfer while the outer transaction still succeeds). */
  lockTerms?: NearHtlcTerms;
}

interface NearLockView {
  status: "Locked" | "Claiming" | "Claimed" | "Refunding" | "Refunded";
  payer: string;
  payee: string;
  token: string;
  amount: string;
  claimByMs: number;
  refundAfterMs: number;
  /** `0x`-hex once known (Claiming/Claimed), else `null`. */
  preimage: string | null;
}

function parseLockView(text: string): NearLockView | null {
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (
    typeof v.status !== "string" ||
    typeof v.payer !== "string" ||
    typeof v.payee !== "string" ||
    typeof v.token !== "string" ||
    typeof v.amount !== "string" ||
    typeof v.claim_by_ms !== "string" ||
    typeof v.refund_after_ms !== "string"
  ) {
    throw new Error("near-htlc: get_lock returned an unrecognised LockView shape");
  }
  const preimage = typeof v.preimage === "string" ? `0x${v.preimage}` : null;
  return {
    status: v.status as NearLockView["status"],
    payer: v.payer,
    payee: v.payee,
    token: v.token,
    amount: v.amount,
    claimByMs: Number(v.claim_by_ms),
    refundAfterMs: Number(v.refund_after_ms),
    preimage,
  };
}

/** H9: `status.SuccessValue` is base64 of the JSON the method returned; for `ft_transfer_call` that
 *  is a JSON string holding the used amount (`"1000000"`, or `"0"` when refused). `null` when the
 *  status carries no such value or it is not a decimal-integer string. */
function successValueAmount(status: unknown): string | null {
  if (status === null || typeof status !== "object") return null;
  const value = (status as Record<string, unknown>).SuccessValue;
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
    return typeof parsed === "string" && NONNEG_DECIMAL.test(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// --- The rail ------------------------------------------------------------------------------------

export interface NearHtlcRailOptions {
  config: NearRailConfig;
  rpc: CapturingRpc;
  signer: NearSigner;
  clock?: () => number;
  /** Injected for tests (H9's re-read delay); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The desk's `near-htlc` rail handle: one instance per party, bound to one signer and one pinned
 * chain. Build it with `NearHtlcRail.connect(...)`, never `new` — connecting is where the chain
 * pin gets checked against reality (D-N3: `status().chain_id`/`protocol_version` recorded).
 */
export class NearHtlcRail {
  private readonly config: NearRailConfig;
  private readonly rpc: CapturingRpc;
  private readonly near: NearRpc;
  private readonly signer: NearSigner;
  private readonly signerPublicKeyBytes: Uint8Array;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private prepared: NearPreparedWrite | null = null;

  private constructor(config: NearRailConfig, rpc: CapturingRpc, near: NearRpc, signer: NearSigner, clock: () => number, sleep: (ms: number) => Promise<void>) {
    this.config = config;
    this.rpc = rpc;
    this.near = near;
    this.signer = signer;
    this.signerPublicKeyBytes = decodePublicKey(signer.publicKey);
    this.clock = clock;
    this.sleep = sleep;
  }

  static async connect(options: NearHtlcRailOptions): Promise<NearHtlcRail> {
    const configCheck = checkNearRailConfig(options.config);
    if (!configCheck.ok) {
      throw new Error(`near-htlc: refusing to connect — ${configCheck.reason}`);
    }
    // H13: every read is bounded by NEAR_PRESEND_READ_TIMEOUT_MS (send_tx/txStatus are not).
    const near = new NearRpc(options.rpc).withReadTimeout(NEAR_PRESEND_READ_TIMEOUT_MS);
    const rail = new NearHtlcRail(
      configCheck.config,
      options.rpc,
      near,
      options.signer,
      options.clock ?? Date.now,
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    );
    await rail.assertPinnedChain();
    await rail.assertLockedContract();
    // A10-equivalent: connect's own exchanges never linger into a later write's own
    // snapshot-at-start.
    options.rpc.drain();
    return rail;
  }

  /** H6: reads `view_account(contract)` and `view_access_key_list(contract)` at the SAME final
   *  block (fetched once, then both queries pinned to its height) and refuses to connect unless
   *  the contract's live `code_hash` matches the config's own pinned `htlcCodeHash` exactly and
   *  the contract account holds zero access keys — a deployment that still has a key could be
   *  redeployed to different code at any time, so "the account id matches" is never enough on
   *  its own to trust its code as the reviewed wasm. Fails closed: any mismatch throws, never a
   *  boolean this caller could accidentally ignore. */
  private async assertLockedContract(): Promise<void> {
    const block = await this.near.block({ finality: "final" });
    const ref: NearBlockRef = { blockId: block.header.height };
    const account = await this.near.viewAccount(this.config.contract, ref);
    if (account.codeHash !== this.config.htlcCodeHash) {
      throw new Error(
        `near-htlc: refusing to connect — contract "${this.config.contract}" code_hash "${account.codeHash}" does not match the pinned htlcCodeHash "${String(this.config.htlcCodeHash)}"`,
      );
    }
    const keyList = await this.near.viewAccessKeyList(this.config.contract, ref);
    if (keyList.keys.length !== 0) {
      throw new Error(
        `near-htlc: refusing to connect — contract "${this.config.contract}" still holds ${String(keyList.keys.length)} access key(s) (must be locked to zero keys, H6)`,
      );
    }
  }

  /** D-N3: `status().chain_id`/`protocol_version` are what this reads and records (`connect()`'s
   *  own captured exchange IS the record — there is nothing further to persist here). Re-checked
   *  before every write, mirroring `btc-htlc.ts`'s `assertPinnedChain`. */
  private async assertPinnedChain(): Promise<void> {
    const status = await this.near.status();
    if (!ALLOWED_CHAIN_IDS.has(status.chainId)) {
      throw new Error(
        `near-htlc: chain "${status.chainId}" is not on the allow list (near-sandbox-flop, testnet only)` +
          (DENY_CHAIN_NAMES.has(status.chainId) ? `; refusing ${status.chainId} by name` : ""),
      );
    }
    if (status.chainId !== this.config.pin.chainId) {
      throw new Error(
        `near-htlc: connected chain "${status.chainId}" does not match pin "${this.config.pin.name}" (expected "${this.config.pin.chainId}")`,
      );
    }
  }

  private resolveAsset(asset: string): string {
    const tokenAccount = this.config.assets[asset as "USDC"];
    if (tokenAccount === undefined) throw new Error(`near-htlc: no configured token account for asset "${asset}"`);
    return tokenAccount;
  }

  private async nextNonce(): Promise<bigint> {
    const key = await this.near.viewAccessKey(this.signer.accountId, this.signer.publicKey);
    return BigInt(key.nonce) + 1n;
  }

  private async recentBlockHashBytes(): Promise<Uint8Array> {
    const block = await this.near.block({ finality: "final" });
    return base58.decode(block.header.hash);
  }

  /** Builds, signs and records (but never sends) a transaction to `receiverId` — D-N4's
   *  "sign-and-record, then broadcast" rule: the tx hash is fully determined by the signed
   *  bytes, so it is known here, before this method's caller ever touches `sendTx`. */
  private async buildAndSign(receiverId: string, actions: NearAction[]): Promise<{ txHash: string; signedTxBase64: string }> {
    const nonce = await this.nextNonce();
    const blockHash = await this.recentBlockHashBytes();
    const tx: NearTransactionV0 = {
      signerId: this.signer.accountId,
      publicKey: { keyType: "ED25519", data: this.signerPublicKeyBytes },
      nonce,
      receiverId,
      blockHash,
      actions,
    };
    const built = await buildSignedTransaction(tx, (hash) => this.signer.sign(hash));
    return { txHash: built.txHashBase58, signedTxBase64: Buffer.from(built.signedBytes).toString("base64") };
  }

  /** Broadcasts a previously built-and-signed write (`wait_until: "FINAL"`, D-N9). `before` (A10)
   *  is this write's own exchange-log snapshot-at-start, so `raw` below covers exactly this
   *  write's own exchanges — never an earlier, un-drained read.
   *
   *  H1: "a write succeeds only when the chain says so" — two gates before this ever returns
   *  evidence to a caller. (1) The outcome's own top-level `status`: a `Failure` throws
   *  `NearTxFailedError` immediately, carrying the failure and this write's own captured
   *  exchanges — the ref is NOT evidence of anything at that point. (2) For a `Success`
   *  transaction, re-reads `get_lock` at `final` and confirms the write actually produced the
   *  state its own caller asked for — a `Success` transaction alone is not enough: `claim`/
   *  `refund`'s own inner `ft_transfer` payout promise can fail AFTER the outer method call
   *  already succeeded (S1), and `ft_transfer_call`'s own receiver-side `ft_on_transfer` can
   *  refuse the transfer while the token contract still reports `Success` for the transfer call
   *  itself (S3) — `kind`-specific below. */
  private async sendPrepared(prepared: NearPreparedWrite, options: { pinChecked?: boolean } = {}): Promise<NearWriteEvidence> {
    // H13: `claim` runs this check itself, BEFORE its deadline guard (the guard is the last read).
    if (options.pinChecked !== true) await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    // D1 (mirrors evm-htlc.ts's identical use): a comparably unique id for this write's own
    // captured exchanges, so a long-lived rail instance's ids never collide across two different
    // writes the way two different `CapturingRpc` instances' own plain sequences could.
    this.rpc.setIdNamespace(`write:${prepared.ref}:${this.clock()}`);
    let outcome;
    try {
      outcome = await this.near.sendTx(prepared.signedTxBase64, "FINAL");
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
    return this.confirmWrite(prepared, outcome, before);
  }

  /** The kind-specific post-checks shared by `sendPrepared` and `recoverByTxHash` (H10): a
   *  transaction is evidence of a write only once these pass. `before` is the exchange-log length
   *  at the start of this write/recovery, so `raw` covers exactly its own exchanges. */
  private async confirmWrite(
    prepared: { ref: string; txHash: string; kind: "lock" | "claim" | "refund"; lockTerms?: NearHtlcTerms | undefined },
    outcome: NearTxOutcome,
    before: number,
  ): Promise<NearWriteEvidence> {
    const raw = (): string[] => this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);

    const status = outcome.status as Record<string, unknown> | null | undefined;
    if (status !== null && status !== undefined && "Failure" in status) {
      throw new NearTxFailedError(prepared.txHash, status.Failure, raw());
    }

    // H9: what THIS transaction's own outcome says about the lock. `ft_transfer_call` resolves to
    // the amount the receiver actually used, as a JSON string: the whole amount when the lock was
    // made, "0" when `ft_on_transfer` refused it and the token returned everything.
    let terms: NearHtlcTerms | undefined;
    if (prepared.kind === "lock") {
      terms = prepared.lockTerms;
      if (terms === undefined) throw new Error("near-htlc: internal — a lock write is missing its own lockTerms");
      const used = successValueAmount(outcome.status);
      if (used === "0") throw new NearLockRefusedError(prepared.txHash, raw());
      if (used !== terms.amount) {
        throw new NearLockUnknownError(
          prepared.txHash,
          used === null ? "its outcome carries no readable used amount" : `its outcome used ${used}, not the ${terms.amount} sent`,
          raw(),
        );
      }
    }

    const block = await this.near.block({ blockId: outcome.transactionOutcome.blockHash });
    let lockView = await this.getLock(prepared.ref);
    const evidence: NearWriteEvidence = {
      ref: prepared.ref,
      txHash: prepared.txHash,
      blockHeight: block.header.height,
      blockHash: outcome.transactionOutcome.blockHash,
      raw: raw(),
    };

    if (prepared.kind === "lock" && terms !== undefined) {
      const tokenAccount = this.resolveAsset(NEAR_ASSET_ID);
      // A lock that is not visible yet gets exactly one re-read at a later final block.
      if (lockView === null) {
        await this.sleep(NEAR_LOCK_REREAD_DELAY_MS);
        lockView = await this.getLock(prepared.ref);
      }
      if (lockView === null) throw new NearLockUnknownError(prepared.txHash, "no lock is visible at the final block, even after a re-read", raw());
      const matches =
        lockView.status === "Locked" &&
        lockView.payer === this.signer.accountId &&
        lockView.payee === terms.payee &&
        lockView.token === tokenAccount &&
        lockView.amount === terms.amount &&
        lockView.claimByMs === terms.claimByMs &&
        lockView.refundAfterMs === terms.refundAfterMs;
      if (!matches) {
        throw new NearLockUnknownError(prepared.txHash, "its outcome says the amount was used but the lock at the final block is not Locked with these exact terms", raw());
      }
      return { ...evidence, raw: raw() };
    }

    if (prepared.kind === "claim") {
      if (lockView !== null && lockView.status === "Claimed") return evidence;
      if (lockView !== null && lockView.status === "Claiming") throw new NearPendingError(prepared.txHash, raw());
      // Locked (payout promise failed, F4 kept the preimage) or anything else unexpected: report
      // the payout as failed, carrying whatever preimage is now on chain (F4: revealed whether or
      // not the payout itself landed).
      throw new NearPayoutFailedError(prepared.txHash, lockView?.preimage ?? null, raw());
    }

    // prepared.kind === "refund"
    if (lockView !== null && lockView.status === "Refunded") return evidence;
    throw new NearRefundFailedError(prepared.txHash, raw());
  }

  /**
   * D-N4: builds and signs the Buyer's `ft_transfer_call` lock — `receiver_id` = the HTLC
   * contract, `msg` = the JSON the contract's own `ft_on_transfer` parses (hash_lock without its
   * `0x` prefix, payee, claim_by_ms/refund_after_ms as strings, matching the contract's own u64
   * JSON convention) — and records `{ ref, txHash }` WITHOUT sending. `ref` is `0x<hash lock>:<payer>`
   * (near-ref.ts; squatting fix, replacing D-N4 "ref = hash lock": known before any write), not the tx hash. A caller records this
   * return value before ever calling `commitLock()`.
   */
  async prepareLock(terms: NearHtlcTerms): Promise<{ ref: string; txHash: string }> {
    validateTerms(terms, this.config);
    await this.assertPinnedChain();
    const tokenAccount = this.resolveAsset(NEAR_ASSET_ID);
    const msg = JSON.stringify({
      hash_lock: terms.hashLock.slice(2),
      payee: terms.payee,
      claim_by_ms: String(terms.claimByMs),
      refund_after_ms: String(terms.refundAfterMs),
    });
    const args = { receiver_id: this.config.contract, amount: terms.amount, msg };
    const action: NearAction = {
      type: "FunctionCall",
      methodName: "ft_transfer_call",
      args: new TextEncoder().encode(JSON.stringify(args)),
      gas: FT_TRANSFER_CALL_GAS,
      deposit: ONE_YOCTO,
    };
    const built = await this.buildAndSign(tokenAccount, [action]);
    // The ref names the payer (this signer) too: locks are keyed by (payer, hash lock).
    const ref = formatNearRef(terms.hashLock, this.signer.accountId);
    this.prepared = { ref, txHash: built.txHash, signedTxBase64: built.signedTxBase64, kind: "lock", lockTerms: terms };
    return { ref, txHash: built.txHash };
  }

  /** Sends exactly the transaction `prepareLock` most recently built and signed. Throws if
   *  called without a prior `prepareLock` — mirrors `btc-htlc.ts`'s `broadcastFunding`'s own
   *  "only path a prepared write ever reaches the network" contract. Consumes the prepared write
   *  (a second call without an intervening `prepareLock` throws), so a caller can never
   *  accidentally double-send by calling this twice. */
  async commitLock(): Promise<NearWriteEvidence> {
    if (this.prepared === null) {
      throw new Error("near-htlc: commitLock called with no prepared lock — call prepareLock first");
    }
    const prepared = this.prepared;
    this.prepared = null;
    return this.sendPrepared(prepared);
  }

  /** D-N10: reads `get_lock` at the given block ref (default: `final`, matching every other
   *  evidence-style read in this build) and decodes it, or `null` when no lock exists under this
   *  hash. Never throws for "no such lock" — only for a malformed response shape or a genuine
   *  transport failure. */
  private async getLock(lockRef: string, ref: NearBlockRef = { finality: "final" }): Promise<NearLockView | null> {
    const { hashLock, payer } = requireNearRef(lockRef);
    const result = await this.near.callFunction(this.config.contract, "get_lock", { hash_lock: hashLock.slice(2), payer }, ref);
    return parseLockView(result.resultText);
  }

  private async storageBalanceOf(accountId: string): Promise<{ total: string; available: string } | null> {
    const tokenAccount = this.resolveAsset(NEAR_ASSET_ID);
    const result = await this.near.callFunction(tokenAccount, "storage_balance_of", { account_id: accountId });
    const parsed = JSON.parse(result.resultText) as unknown;
    if (parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    if (typeof v.total !== "string" || typeof v.available !== "string") return null;
    return { total: v.total, available: v.available };
  }

  /**
   * D-N10/§4: two no-secret pre-checks before ever signing a claim — `get_lock` shows `Locked`
   * and still inside its window (against a FRESH `final` read, not anything cached), and the
   * payee is storage-registered on the token (`storage_balance_of`, so a "locked" verdict also
   * proves the payout can land, mirroring D-N10's evidence-reader rule for the same reason). Only
   * once both pass is anything built or signed. `notAfterMs` is re-checked against fresh chain
   * time as the LAST read before broadcast (P22-P24-EVM-FIXES-R3.md E4's rule) — after the
   * pre-checks and the signing itself have already spent their own round trips, during which
   * real time keeps passing.
   *
   * H2: when `get_lock` already shows a revealed preimage (a retry after a payout that failed —
   * `NearPayoutFailedError`'s own scenario), the contract itself permits this retry past
   * `refund_after_ms` (its own F4 rule) — this adapter mirrors that: both the pre-check window
   * guard and H3's own last-moment `notAfterMs`/landing-margin guard are skipped, but the
   * storage-registration check is NOT (the payout can still fail again for the same reason).
   *
   * H3: the adapter's own last-moment guard, on an UNREVEALED lock only — `notAfterMs` is refused
   * up front if it would leave less than `NEAR_CLAIM_LANDING_MARGIN_MS` before the lock's own
   * `refund_after_ms` (a claim that could plausibly land at/after the refund window opens is
   * never attempted), and the final broadcast-time check judges `notAfterMs` against
   * `max(final block time, the injected clock)` rather than the block time alone — a node whose
   * own final-block cadence has stalled must never let a stale "chain time" understate how much
   * real time has actually passed.
   */
  async claim(ref: string, preimage: string, notAfterMs: number, expected?: NearHtlcTerms): Promise<NearWriteEvidence> {
    const { hashLock, payer } = requireNearRef(ref);
    if (expected !== undefined && expected.hashLock !== hashLock) {
      throw new Error("near-htlc: refusing to claim — the expected terms name another hash lock than the ref");
    }
    if (!SECRET_SHAPE.test(preimage)) throw new Error("near-htlc: preimage must be 0x + 64 lowercase hex");
    const preimageBytes = hexToBytes(preimage.slice(2));
    const hashLockBytes = hexToBytes(hashLock.slice(2));
    if (!bytesEqual(sha256(preimageBytes), hashLockBytes)) {
      throw new Error("near-htlc: preimage does not open hashLock (sha256 mismatch) — refusing to build a claim that can never verify");
    }
    await this.assertPinnedChain();

    const lockView = await this.getLock(ref);
    if (lockView === null || lockView.status !== "Locked") {
      throw new Error(`near-htlc: refusing to claim — lock is not in a claimable "Locked" state (got ${lockView?.status ?? "none"})`);
    }
    // H12: the claim pays the lock's own payee, so check WHO it pays (this signer, or the payee
    // the caller expects) and that token, amount and both times are the terms the caller expects
    // -- before anything is signed. Without `expected`, only the payee and the token are checked.
    const expectedPayee = expected?.payee ?? this.signer.accountId;
    if (lockView.payee !== expectedPayee) {
      throw new Error(`near-htlc: refusing to claim — the lock pays "${lockView.payee}", not the expected payee "${expectedPayee}" (H12)`);
    }
    if (lockView.token !== this.resolveAsset(NEAR_ASSET_ID)) {
      throw new Error(`near-htlc: refusing to claim — the lock's token "${lockView.token}" is not the configured USDC asset (H12)`);
    }
    if (expected !== undefined) {
      if (lockView.amount !== expected.amount) {
        throw new Error(`near-htlc: refusing to claim — the lock holds ${lockView.amount}, not the expected ${expected.amount} (H12)`);
      }
      if (lockView.claimByMs !== expected.claimByMs || lockView.refundAfterMs !== expected.refundAfterMs) {
        throw new Error("near-htlc: refusing to claim — the lock's claim/refund times differ from the expected terms (H12)");
      }
    }
    // H2: a revealed preimage means this is a retry the contract's own F4 rule permits past the
    // window — never trust the view's own shape alone (mirrors findClaimedPreimage's own check).
    const revealed = lockView.preimage !== null && bytesEqual(sha256(hexToBytes(lockView.preimage.slice(2))), hashLockBytes);
    const preClaimNowMs = await this.chainTimeMs();
    if (!revealed && !(preClaimNowMs < lockView.refundAfterMs)) {
      throw new Error("near-htlc: refusing to claim — chain time is already at/after refundAfterMs");
    }
    const storage = await this.storageBalanceOf(lockView.payee);
    if (storage === null) {
      throw new Error(`near-htlc: refusing to claim — payee "${lockView.payee}" is not storage-registered on the token (the payout would fail)`);
    }
    if (!revealed && notAfterMs > lockView.refundAfterMs - NEAR_CLAIM_LANDING_MARGIN_MS) {
      throw new Error(
        `near-htlc: refusing to claim — notAfterMs (${notAfterMs}) leaves less than the ${NEAR_CLAIM_LANDING_MARGIN_MS}ms landing margin before refundAfterMs (${lockView.refundAfterMs})`,
      );
    }

    const action: NearAction = {
      type: "FunctionCall",
      methodName: "claim",
      args: new TextEncoder().encode(JSON.stringify({ hash_lock: hashLock.slice(2), payer, preimage: preimage.slice(2) })),
      gas: CLAIM_REFUND_GAS,
      deposit: 0n,
    };
    const built = await this.buildAndSign(this.config.contract, [action]);

    // H13: the pinned-chain check runs BEFORE the deadline guard, so the guard is genuinely the
    // last read: nothing but the send itself follows it. Skipped on a revealed retry (H2).
    await this.assertPinnedChain();
    if (!revealed) {
      const finalNowMs = await this.chainTimeMs();
      const guardNowMs = Math.max(finalNowMs, this.clock());
      if (guardNowMs >= notAfterMs) {
        throw new Error(`near-htlc: refusing to broadcast claim — chain time ${guardNowMs} is at/after the given deadline (notAfterMs ${notAfterMs})`);
      }
    }

    return this.sendPrepared({ ref, txHash: built.txHash, signedTxBase64: built.signedTxBase64, kind: "claim" }, { pinChecked: true });
  }

  /**
   * The same two-step as `claim` (sign-and-record, then send): `get_lock` shows `Locked`, the
   * caller's own signer is the lock's `payer` (mirrors `btc-htlc.ts`'s "refund must be signed by
   * the payer's own wallet"), and chain time has reached `refundAfterMs` — all against a fresh
   * `final` read — before anything is built or signed.
   */
  async refund(ref: string): Promise<NearWriteEvidence> {
    const { hashLock, payer } = requireNearRef(ref);
    // The contract keys a refund by (predecessor, hash lock): only the payer's own signer can
    // ever reach its own lock, so a ref naming another payer is refused before anything is signed.
    if (payer !== this.signer.accountId) {
      throw new Error("near-htlc: refund must be signed by the payer's own account (the ref's payer must equal signer.accountId)");
    }
    await this.assertPinnedChain();

    const lockView = await this.getLock(ref);
    if (lockView === null || lockView.status !== "Locked") {
      throw new Error(`near-htlc: refusing to refund — lock is not in a refundable "Locked" state (got ${lockView?.status ?? "none"})`);
    }
    if (lockView.payer !== this.signer.accountId) {
      throw new Error("near-htlc: refund must be signed by the payer's own account (signer.accountId must equal the lock's payer)");
    }
    const nowMs = await this.chainTimeMs();
    if (!(nowMs >= lockView.refundAfterMs)) {
      throw new Error("near-htlc: refusing to refund — chain time has not yet reached refundAfterMs");
    }

    const action: NearAction = {
      type: "FunctionCall",
      methodName: "refund",
      args: new TextEncoder().encode(JSON.stringify({ hash_lock: hashLock.slice(2) })),
      gas: CLAIM_REFUND_GAS,
      deposit: 0n,
    };
    const built = await this.buildAndSign(this.config.contract, [action]);
    return this.sendPrepared({ ref, txHash: built.txHash, signedTxBase64: built.signedTxBase64, kind: "refund" });
  }

  /**
   * D-N4's lost-reply recovery path: `EXPERIMENTAL_tx_status` by the write's own recorded
   * `txHash` + sender — for a caller resuming after an interruption between `sendPrepared`'s own
   * `send_tx` and its return, which must never re-sign or re-send blind. `null` (never throws)
   * when the node has no record of this transaction at all (`NearUnknownTransactionError`) —
   * every other error propagates (mirrors `btc-htlc.ts`'s `recoverFunding`'s own R2-2 rule: only
   * a genuine "not found" answer may collapse to "never reached the network").
   *
   * H4: `expectedRef` is the caller's own ref (the hash lock this recovery is resuming) — the
   * evidence this returns carries THAT ref, never the raw `txHash` (A9: an evidence reader keys
   * and re-binds captures by ref, so returning anything else here would silently mislabel a
   * recovered write). H1's own status check applies here too: a transaction the node still has a
   * record of but that itself executed as `Failure` is reported as failed
   * (`NearTxFailedError`), never handed back as if it were evidence of a completed write.
   *
   * H10: the transaction is decoded (signer and key, receiver, method, args) and must be this
   * rail's own lock, claim or refund for `expectedRef`, else `NearUnexpectedTransactionError`;
   * the lookup waits for `FINAL`; and the same kind-specific post-checks and typed errors as
   * `sendPrepared` apply (`NearLockRefusedError`, `NearLockUnknownError`, `NearPendingError`, ...).
   */
  async recoverByTxHash(txHash: string, senderAccountId: string, expectedRef: string): Promise<NearWriteEvidence | null> {
    const refParts = requireNearRef(expectedRef);
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    let outcome;
    try {
      outcome = await this.near.txStatus(txHash, senderAccountId, "FINAL");
    } catch (error) {
      if (error instanceof NearUnknownTransactionError) return null;
      throw error;
    }
    // H10: only this rail's own write for `expectedRef` is ever recovered -- decode the
    // transaction itself (signer, receiver, method, args) rather than trusting the hash a caller
    // supplied -- then apply the same kind-specific post-checks (and typed errors) as a send.
    const write = this.classifyOwnWrite(outcome, txHash, senderAccountId, expectedRef, refParts);
    return this.confirmWrite({ ref: expectedRef, txHash, kind: write.kind, lockTerms: write.lockTerms }, outcome, before);
  }

  /** H10: proves `outcome`'s transaction is a write of THIS rail (this signer and key, this
   *  contract or token) for `expectedRef`, and names which kind -- or throws
   *  `NearUnexpectedTransactionError`. */
  private classifyOwnWrite(
    outcome: NearTxOutcome,
    txHash: string,
    senderAccountId: string,
    expectedRef: string,
    refParts: { hashLock: string; payer: string },
  ): { kind: "lock" | "claim" | "refund"; lockTerms?: NearHtlcTerms } {
    const refuse = (detail: string): never => {
      throw new NearUnexpectedTransactionError(txHash, detail);
    };
    const tx = outcome.transaction;
    if (tx === undefined) return refuse("the node's reply carries no transaction body to check");
    if (outcome.transactionOutcome.id !== txHash || (tx.hash !== undefined && tx.hash !== txHash)) {
      return refuse("the reply describes a different transaction hash");
    }
    if (senderAccountId !== this.signer.accountId || tx.signer_id !== this.signer.accountId) {
      return refuse("it was not signed by this rail's own account");
    }
    if (tx.public_key !== this.signer.publicKey) return refuse("it was not signed with this rail's own key");
    const actions = tx.actions;
    if (!Array.isArray(actions) || actions.length !== 1) return refuse("it does not carry exactly one action");
    const call = (actions[0] as Record<string, unknown> | null)?.FunctionCall as Record<string, unknown> | undefined;
    if (call === undefined || call === null || typeof call !== "object") return refuse("its one action is not a function call");
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(Buffer.from(String(call.args), "base64").toString("utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      return refuse("its call arguments are not a JSON object");
    }
    const keysAre = (value: Record<string, unknown>, ...names: string[]): boolean =>
      Object.keys(value).sort().join(",") === [...names].sort().join(",");
    const hashLockHex = refParts.hashLock.slice(2);
    const tokenAccount = this.resolveAsset(NEAR_ASSET_ID);

    if (tx.receiver_id === tokenAccount && call.method_name === "ft_transfer_call") {
      if (refParts.payer !== this.signer.accountId) return refuse("the ref's payer is not this signer, so it cannot be this signer's lock");
      if (String(call.deposit) !== "1") return refuse("a lock carries exactly 1 yoctoNEAR");
      if (!keysAre(args, "receiver_id", "amount", "msg") || args.receiver_id !== this.config.contract || typeof args.amount !== "string" || typeof args.msg !== "string") {
        return refuse("its ft_transfer_call arguments are not {receiver_id: this contract, amount, msg}");
      }
      let msg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(args.msg) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        msg = parsed as Record<string, unknown>;
      } catch {
        return refuse("its lock msg is not a JSON object");
      }
      if (
        !keysAre(msg, "hash_lock", "payee", "claim_by_ms", "refund_after_ms") ||
        msg.hash_lock !== hashLockHex ||
        typeof msg.payee !== "string" ||
        typeof msg.claim_by_ms !== "string" ||
        typeof msg.refund_after_ms !== "string" ||
        !NONNEG_DECIMAL.test(args.amount)
      ) {
        return refuse("its lock msg does not name this ref's hash lock in the expected shape");
      }
      return {
        kind: "lock",
        lockTerms: {
          hashLock: refParts.hashLock,
          amount: args.amount,
          payee: msg.payee,
          claimByMs: Number(msg.claim_by_ms),
          refundAfterMs: Number(msg.refund_after_ms),
        },
      };
    }

    if (tx.receiver_id === this.config.contract && call.method_name === "claim") {
      if (String(call.deposit) !== "0") return refuse("a claim carries no deposit");
      if (!keysAre(args, "hash_lock", "payer", "preimage") || args.hash_lock !== hashLockHex || args.payer !== refParts.payer || typeof args.preimage !== "string") {
        return refuse("its claim arguments do not name this ref's hash lock and payer");
      }
      return { kind: "claim" };
    }

    if (tx.receiver_id === this.config.contract && call.method_name === "refund") {
      if (refParts.payer !== this.signer.accountId) return refuse("the ref's payer is not this signer, so it cannot be this signer's refund");
      if (String(call.deposit) !== "0") return refuse("a refund carries no deposit");
      if (!keysAre(args, "hash_lock") || args.hash_lock !== hashLockHex) return refuse("its refund arguments do not name this ref's hash lock");
      return { kind: "refund" };
    }

    void expectedRef;
    return refuse(`receiver "${String(tx.receiver_id)}" method "${String(call.method_name)}" is none of this rail's writes`);
  }

  /** D-N6: the Buyer's own cheap way to learn the secret from a pending OR already-final claim —
   *  `get_lock` in `Claiming` (the payout callback hasn't landed yet) or `Claimed` both carry the
   *  preimage (it becomes public the moment `claim()` is called, not only once it settles). Only
   *  ever returns a preimage that actually opens `hashLock` — never trusts the view's own shape
   *  alone (mirrors `evm-htlc.ts`'s `findClaimedPreimage`).
   *
   *  The lock's STATUS is deliberately not consulted: a revealed preimage is public whatever the
   *  status says. The contract's own F4 rule means a claim whose payout failed (payee not
   *  storage-registered, token paused) drops the status back to `Locked` with the preimage kept
   *  and the refund refused forever — the Seller can retry its claim at any time from then on, so
   *  the Buyer's leg A is spent and its only remaining move is to take leg B with this secret.
   *  Gating on `Claiming`/`Claimed` here made `BuyerFlow.learnSecret` blind to exactly that
   *  state (main-loop review 2026-09-29): the Buyer would have missed leg B's own window. */
  async findClaimedPreimage(ref: string): Promise<string | null> {
    const { hashLock } = requireNearRef(ref);
    const lock = await this.getLock(ref);
    if (lock === null || lock.preimage === null) return null;
    const hashLockBytes = hexToBytes(hashLock.slice(2));
    const preimageBytes = hexToBytes(lock.preimage.slice(2));
    if (!bytesEqual(sha256(preimageBytes), hashLockBytes)) return null;
    return lock.preimage;
  }

  /** D-N6: NEAR has no mempool race (a transaction is executed or it is not), so
   *  `checkPendingClaim` is implemented cheaply as exactly `findClaimedPreimage` — a pending
   *  (`Claiming`) claim already carries the preimage, so there is nothing more a "pending" check
   *  needs to do that a final one doesn't already cover. Kept as its own named method (rather
   *  than only ever calling `findClaimedPreimage` directly) so a caller's intent — "is there a
   *  claim in flight I should know about before building a refund" — reads clearly at the call
   *  site, mirroring `ConnectedCounterAssetRail.checkPendingClaim`'s own documented purpose. */
  async checkPendingClaim(ref: string): Promise<string | null> {
    return this.findClaimedPreimage(ref);
  }

  /** D-N7: the FINAL block header's own `timestamp_nanosec`, ns→ms — never the wall clock; the
   *  contract compares `env::block_timestamp_ms()`. Fails closed (Bitcoin K6's rule, reused here)
   *  on a missing/non-finite/non-positive value rather than silently guessing a deadline. */
  async chainTimeMs(): Promise<number> {
    const block = await this.near.block({ finality: "final" });
    const ns = block.header.timestampNs;
    if (!/^[0-9]+$/.test(ns)) {
      throw new Error("near-htlc: block header timestamp_nanosec is not a non-negative integer string — refusing to guess a chain-time deadline");
    }
    const ms = BigInt(ns) / 1_000_000n;
    if (ms <= 0n || ms > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("near-htlc: block header timestamp_nanosec resolved to an unusable ms value — refusing to guess a chain-time deadline");
    }
    return Number(ms);
  }

  /** The FINAL block's own height — a snapshot of "where the chain is now", taken right before a
   *  lock write, for a later bounded search's own start (mirrors `RailBlockMarker`'s documented
   *  purpose; this build has no evidence reader yet to consume it — NB2a scope). */
  async currentBlockMarker(): Promise<number> {
    const block = await this.near.block({ finality: "final" });
    return block.header.height;
  }
}

// Re-exported so a caller catching a NEAR-specific panic from inside this rail's own reads
// (`getLock`/`storageBalanceOf`, both `callFunction` calls) doesn't need to import `near-rpc.ts`
// separately just for the one error type this rail can itself surface.
export { NearFunctionCallPanicError };
