// SPDX-License-Identifier: MIT
//
// The desk-facing `sol-htlc` adapter (P6-SOL-SPEC.md sections 3-5): a chain pin with an allow list, a
// program check (`connect()` reads the program account, the ProgramData hash and the upgrade authority),
// keyless writes through an in-memory signer, and the hole classes the NEAR review rounds found built in
// from the start (handoff/P5-NEAR-FIXES.md, P5-NEAR-SQUAT-FIX.md), plus the client duties the program's
// own README assigns to this layer (contracts-sol/README.md, review finding S1).
//
// What "the client duties" means here, because the program cannot do it:
//   - A claim publishes the preimage in its instruction data whether it succeeds or fails on chain. A claim
//     that lands at or after `refund_after_ms` fails with ClaimWindowClosed and STILL leaks the secret; the
//     escrow then stays Locked and refundable, so a Buyer (the payer of the escrow that was claimed late)
//     could take the other leg with the secret AND refund this one. So `claim` (1) SIMULATES first and
//     never sends a claim the runtime would refuse, (2) signs with a blockhash whose `lastValidBlockHeight`
//     expires (at a deliberately slow block-time estimate) before `refund_after_ms` minus a margin, so a
//     claim that cannot land in time is DROPPED by the network rather than executed late, and (3) when a
//     claim did land and fail, throws `SolClaimFailedError` (the secret is public; retry at once).
//   - `claim_by_ms` is not enforced on chain; the client enforces it (`notAfterMs`, judged against
//     max(chain time, clock) as the last read before sending).
//
// Every write follows one path: build and sign, RECORD the signature (the transaction id, known before
// anything is sent), simulate, send with preflight, wait until the signature is FINALIZED, then read the
// escrow at finalized and require the state the write was meant to produce. A write returns evidence only
// when the chain says so; otherwise it throws a typed error (`SolTxFailedError` and its subclasses).
// Recovery of a lost reply is by signature (`recoverBySignature`): "unknown" (`null`) is returned only when
// the blockhash has expired AND the node has no status for the signature; before that it throws
// `SolPendingError`, never a guess.
//
// This stage (SB2a) is the transport, signing and adapter. The pure replayable evidence reader
// (`sol-evidence.ts`), the client rail and the frames are later stages (SB2b, SB3).

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import {
  BPF_LOADER_UPGRADEABLE_ID,
  SPL_MINT_LEN,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  decodeMint,
  decodeTokenAccount,
} from "./sol-spl.js";
import {
  SolBlockhashNotFoundError,
  SolMinContextSlotError,
  SolRpc,
  SolSimulationFailedError,
  programErrorCode,
  type SolAccountInfo,
  type SolSignatureStatus,
} from "./sol-rpc.js";
import {
  bytesEqual,
  compileLegacyMessage,
  concatBytes,
  findProgramAddress,
  isOnCurve,
  isSmallOrderOrNonCanonical,
  isValidPubkeyBase58,
  pubkeyFromBase58,
  pubkeyToBase58,
  signTransaction,
  type SolInstruction,
  type SolTransaction,
  type SolTxSigner,
} from "./sol-tx.js";
import type { CapturingRpc } from "./rpc-capture.js";

// --- constants -----------------------------------------------------------------------------------------------

/** `base58(sha256("flop-swap-desk:sol-htlc:v1"))`: the program id is fixed and keyless (contracts-sol). */
export const SOL_HTLC_PROGRAM_ID = "GedsjashYAxaoETcwBZQR1YgBbuEaK8QiiKu2qi6xe6C";

/** The one asset this leg settles: USDC on every USD leg (P6-SOL-SPEC.md), never per-swap. */
export const SOL_ASSET_ID = "USDC";
/** The smallest lockable amount (one micro-USDC unit; the program refuses 0). */
export const SOL_AMOUNT_FLOOR = "1";
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** A blockhash is valid for 150 blocks after the one it names (the network's own MAX_PROCESSING_AGE). */
export const SOL_BLOCKHASH_VALIDITY_BLOCKS = 150;
/** The SLOW estimate of one block's duration, used ONLY to bound how late a signed transaction could still
 *  land: real blocks take about 400 ms (about 455 ms measured on the localnet, sol-probe README) and skipped
 *  slots make blocks rarer than slots, so 600 ms leaves headroom. A too-fast estimate would understate how
 *  long a claim can still land; a too-slow one only makes the client refuse claims earlier. */
export const SOL_SLOW_BLOCK_MS = 600;
/** Extra room between the latest possible landing time of a claim and `refund_after_ms`. */
export const SOL_EXPIRY_MARGIN_MS = 30_000;
/** The adapter's own last-moment bound on `claim`'s `notAfterMs`: it must leave at least this much before
 *  `refund_after_ms`, sized to one full blockhash lifetime at the slow estimate plus the margin (so 120 s).
 *  Mainnet-like clusters need the same; the localnet harness uses windows longer than this. */
export const SOL_CLAIM_LANDING_MARGIN_MS = SOL_BLOCKHASH_VALIDITY_BLOCKS * SOL_SLOW_BLOCK_MS + SOL_EXPIRY_MARGIN_MS;

/** `findClaimedPreimage` looks at no more than this many transactions of an escrow's history. */
export const SOL_PREIMAGE_SCAN_MAX_TRANSACTIONS = 100;
const SCAN_PAGE = 25;

// --- typed write errors ---------------------------------------------------------------------------------------

/** The program's `HtlcError` numbering (contracts-sol/htlc/src/lib.rs), for readable failure reports. */
export const SOL_HTLC_ERROR_NAMES: Readonly<Record<number, string>> = {
  1: "InvalidInstruction",
  2: "WrongProgramId",
  3: "ZeroAmount",
  4: "BadWindow",
  5: "WindowClosed",
  6: "PayeeIsProgramAccount",
  7: "WrongMint",
  8: "DuplicateAccount",
  9: "MissingSigner",
  10: "NotWritable",
  11: "WrongTokenProgram",
  12: "WrongSystemProgram",
  13: "WrongEscrowAddress",
  14: "WrongVaultAddress",
  15: "EscrowExists",
  16: "BadEscrowState",
  17: "BadTokenAccount",
  18: "NotLocked",
  19: "ClaimWindowClosed",
  20: "WrongPreimage",
  21: "NotPayer",
  22: "RefundTooEarly",
  23: "Overflow",
  24: "BadMint",
};

/** A write's transaction failed (or did not produce the intended state) on chain. `raw` is this write's own
 *  captured exchange hashes. */
export class SolTxFailedError extends Error {
  readonly signature: string;
  readonly err: unknown;
  readonly programError: { code: number; name: string } | null;
  readonly raw: readonly string[];
  constructor(message: string, signature: string, err: unknown, raw: readonly string[]) {
    super(message);
    this.name = "SolTxFailedError";
    this.signature = signature;
    this.err = err;
    const code = programErrorCode(err);
    this.programError = code === null ? null : { code, name: SOL_HTLC_ERROR_NAMES[code] ?? "Unknown" };
    this.raw = raw;
  }
}

/** The lock was refused: the transaction failed on chain (nothing moved; the fee was spent), or it
 *  succeeded but the escrow does not hold the terms that were sent. There is no lock to act on. */
export class SolLockRefusedError extends SolTxFailedError {
  constructor(signature: string, err: unknown, raw: readonly string[], detail?: string) {
    super(`sol-htlc: lock refused by the program, nothing was locked${detail === undefined ? "" : ` (${detail})`}`, signature, err, raw);
    this.name = "SolLockRefusedError";
  }
}

/** A claim landed and FAILED (or did not reach Claimed). The preimage is in that transaction's instruction
 *  data, so it is PUBLIC now (`secretPublic`): treat this as urgent and retry at once. */
export class SolClaimFailedError extends SolTxFailedError {
  readonly secretPublic = true;
  constructor(signature: string, err: unknown, raw: readonly string[], detail?: string) {
    super(`sol-htlc: claim failed on chain and the secret is now public, retry at once${detail === undefined ? "" : ` (${detail})`}`, signature, err, raw);
    this.name = "SolClaimFailedError";
  }
}

/** A refund landed and failed, or did not reach Refunded. */
export class SolRefundFailedError extends SolTxFailedError {
  constructor(signature: string, err: unknown, raw: readonly string[], detail?: string) {
    super(`sol-htlc: refund failed on chain${detail === undefined ? "" : ` (${detail})`}`, signature, err, raw);
    this.name = "SolRefundFailedError";
  }
}

/** The signature has no status and its blockhash has expired: the transaction can never land. For a claim
 *  the signed bytes were still handed to the network, so treat the secret as possibly seen. */
export class SolNotLandedError extends Error {
  readonly signature: string;
  constructor(signature: string) {
    super(`sol-htlc: transaction ${signature} never landed (its blockhash expired with no status)`);
    this.name = "SolNotLandedError";
    this.signature = signature;
  }
}

/** Neither landed-and-final nor provably dead yet. Check again shortly; never treat as either. */
export class SolPendingError extends Error {
  readonly signature: string;
  constructor(signature: string, detail: string) {
    super(`sol-htlc: transaction ${signature} is not settled yet (${detail}) - check again shortly`);
    this.name = "SolPendingError";
    this.signature = signature;
  }
}

/** A claim was refused because it could not be guaranteed to land (or be dropped) before the refund
 *  window opens. Nothing was signed or sent. */
export class SolClaimTooLateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolClaimTooLateError";
  }
}

// --- chain pin, allow list, config ---------------------------------------------------------------------------

export interface SolChainPin {
  name: string;
  /** `solana:<reference>`: a genesis-hash prefix for a public cluster, a fixed name for the localnet. */
  caip2: string;
  /** Every evidence read and every confirmation is at this commitment. */
  commitment: "finalized";
}

/** The local validator: its genesis hash changes on every `--reset`, so the pin is a fixed name and
 *  `connect()` instead refuses any genesis that belongs to a public cluster. */
export const SOL_LOCAL_PIN: SolChainPin = { name: "solana-localnet-flop", caip2: "solana:localnet-flop", commitment: "finalized" };

/** UNVERIFIED (never connected to a real devnet by this build): the CAIP-2 reference is the first 32
 *  characters of devnet's genesis hash. `connect()` requires the live genesis to match it. */
export const SOL_DEVNET_PIN: SolChainPin = { name: "solana-devnet-UNVERIFIED", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", commitment: "finalized" };

/** First 32 characters of the public clusters' genesis hashes (the CAIP-2 references). */
const MAINNET_GENESIS_PREFIX = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const TESTNET_GENESIS_PREFIX = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";
const DEVNET_GENESIS_PREFIX = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const PUBLIC_GENESIS_PREFIXES: readonly string[] = [MAINNET_GENESIS_PREFIX, TESTNET_GENESIS_PREFIX, DEVNET_GENESIS_PREFIX];

const KNOWN_PINS: readonly SolChainPin[] = [SOL_LOCAL_PIN, SOL_DEVNET_PIN];

function pinReference(pin: SolChainPin): string {
  return pin.caip2.slice("solana:".length);
}

/** Judges a genesis hash against a pin (the connect-time check, shared with the evidence reader): mainnet is
 *  refused by genesis; the local pin refuses every public cluster's genesis; any other pin needs the genesis
 *  to start with its CAIP-2 reference. `null` when the genesis is acceptable, else the reason. */
export function solGenesisProblem(pin: SolChainPin, genesis: string): string | null {
  const prefix = genesis.slice(0, 32);
  if (prefix === MAINNET_GENESIS_PREFIX) return "sol-htlc: this endpoint is mainnet (genesis hash); refusing by genesis";
  if (pin.caip2 === SOL_LOCAL_PIN.caip2) {
    if (PUBLIC_GENESIS_PREFIXES.includes(prefix)) {
      return `sol-htlc: pin "${pin.name}" is a local validator but the endpoint reports a public cluster's genesis hash`;
    }
  } else if (prefix !== pinReference(pin)) {
    return `sol-htlc: connected genesis "${genesis}" does not match pin "${pin.name}" (expected reference "${pinReference(pin)}")`;
  }
  return null;
}

function isMainnetish(pin: { name?: unknown; caip2?: unknown }): boolean {
  const name = typeof pin.name === "string" ? pin.name : "";
  const caip2 = typeof pin.caip2 === "string" ? pin.caip2 : "";
  return /mainnet/i.test(name) || /mainnet/i.test(caip2) || caip2 === `solana:${MAINNET_GENESIS_PREFIX}`;
}

/** No credentials here, ever. `programHash` is the sha256 (lowercase hex) of the reviewed `htlc.so`
 *  (`contracts-sol/build.sh` prints it); `assets.USDC` is the mint the program was BUILT for
 *  (`FLOP_SOL_USDC_MINT`, contracts-sol/README.md: a different mint is a different program hash). */
export interface SolRailConfig {
  pin: SolChainPin;
  endpoint: string;
  programId: string;
  programHash: string;
  assets: { USDC: string };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Shape-only check on a config that may have come from untrusted or untyped data. `null` when fine. */
export function solRailConfigShapeReason(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "sol rail config is not an object";
  const v = value as Record<string, unknown>;
  if (v.pin === null || typeof v.pin !== "object") return "sol rail config: pin is not an object";
  const pin = v.pin as Record<string, unknown>;
  if (typeof pin.name !== "string" || pin.name === "") return "sol rail config: pin.name must be a non-empty string";
  if (typeof pin.caip2 !== "string" || !/^solana:[-a-zA-Z0-9]{1,32}$/.test(pin.caip2)) return 'sol rail config: pin.caip2 must be "solana:<reference>"';
  if (pin.commitment !== "finalized") return 'sol rail config: pin.commitment must be "finalized"';
  if (typeof v.endpoint !== "string" || v.endpoint === "") return "sol rail config: endpoint must be a non-empty string";
  if (!isValidPubkeyBase58(v.programId)) return "sol rail config: programId must be a base58 public key";
  if (typeof v.programHash !== "string" || !HEX64.test(v.programHash)) return "sol rail config: programHash must be 64 lowercase hex characters (sha256 of the reviewed .so)";
  if (v.assets === null || typeof v.assets !== "object" || Array.isArray(v.assets)) return "sol rail config: assets must be an object";
  const assets = v.assets as Record<string, unknown>;
  if (!isValidPubkeyBase58(assets.USDC)) return "sol rail config: assets.USDC must be a base58 mint address";
  return null;
}

/** Runtime checks that need no chain: the pin is on the allow list (mainnet refused by name), equals a
 *  known pin exactly, the program id is the fixed keyless one, and the mint is not a program account. */
export function validateSolRailConfig(config: SolRailConfig): void {
  if (isMainnetish(config.pin)) {
    throw new Error("sol-htlc: refusing mainnet by name (this build never touches mainnet)");
  }
  const known = KNOWN_PINS.find((pin) => pin.caip2 === config.pin.caip2);
  if (known === undefined) {
    throw new Error(`sol-htlc: chain "${config.pin.caip2}" is not on the allow list (${KNOWN_PINS.map((p) => p.caip2).join(", ")} only)`);
  }
  if (config.pin.name !== known.name) {
    throw new Error(`sol-htlc: pin.name "${config.pin.name}" does not match the known pin's own name "${known.name}" for this chain`);
  }
  if (config.programId !== SOL_HTLC_PROGRAM_ID) {
    throw new Error(`sol-htlc: programId must be the fixed keyless id ${SOL_HTLC_PROGRAM_ID} (the program refuses to run under any other id)`);
  }
  for (const reserved of [SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, BPF_LOADER_UPGRADEABLE_ID, SOL_HTLC_PROGRAM_ID]) {
    if (config.assets.USDC === reserved) throw new Error("sol-htlc: assets.USDC must be a mint address, not a program id");
  }
}

export type SolRailConfigCheck = { ok: true; config: SolRailConfig } | { ok: false; reason: string };

export function checkSolRailConfig(value: unknown): SolRailConfigCheck {
  const shapeReason = solRailConfigShapeReason(value);
  if (shapeReason !== null) return { ok: false, reason: shapeReason };
  const config = value as SolRailConfig;
  try {
    validateSolRailConfig(config);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, config };
}

// --- signer -------------------------------------------------------------------------------------------------

/** The ONLY thing this rail touches to produce a signature: never a raw key. The concrete in-memory
 *  implementation lives in `sol-signer-memory.ts` (tests and harness only). */
export interface SolSigner extends SolTxSigner {
  /** base58 of `publicKeyBytes`. */
  readonly publicKey: string;
}

// --- refs, terms ---------------------------------------------------------------------------------------------

const HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/;
const SECRET_SHAPE = /^0x[0-9a-f]{64}$/;
const NONNEG_DECIMAL = /^(0|[1-9][0-9]*)$/;

/** The Solana ref: `0x<hash lock hex>:<payer base58>` (keyed by payer, P5-NEAR-SQUAT-FIX.md's design; the
 *  payer is the Buyer's own signer, so the ref is known before anything is sent). */
export function formatSolRef(hashLock: string, payer: string): string {
  if (!HASH_LOCK_SHAPE.test(hashLock)) throw new Error("sol-htlc: hashLock must be 0x + 64 lowercase hex");
  pubkeyFromBase58(payer);
  return `${hashLock}:${payer}`;
}

/** Strict: exactly `0x` + 64 lowercase hex, `:`, a canonical base58 32-byte key. `null` for anything else. */
export function parseSolRef(ref: unknown): { hashLock: string; payer: string } | null {
  if (typeof ref !== "string") return null;
  const match = /^(0x[0-9a-f]{64}):([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(ref);
  if (match === null) return null;
  const hashLock = match[1];
  const payer = match[2];
  if (hashLock === undefined || payer === undefined || !isValidPubkeyBase58(payer)) return null;
  return { hashLock, payer };
}

export interface SolHtlcTerms {
  /** sha256(preimage): `0x` + 64 lowercase hex (tclk's hash-statement grammar). */
  hashLock: string;
  /** Micro-USDC units, decimal-integer string, 1..2^64-1. */
  amount: string;
  /** base58 wallet address of the payee: the OWNER of the token account a claim pays (its associated
   *  token account for the mint; the claim derives it). Must be an on-curve key (something that can sign). */
  payee: string;
  claimByMs: number;
  refundAfterMs: number;
}

export function escrowAddress(programId: string, payer: string, hashLock: string): { address: Uint8Array; bump: number } {
  return findProgramAddress([new TextEncoder().encode("htlc"), pubkeyFromBase58(payer), hexToBytes(hashLock.slice(2))], pubkeyFromBase58(programId));
}

export function vaultAddress(programId: string, escrow: Uint8Array): { address: Uint8Array; bump: number } {
  return findProgramAddress([new TextEncoder().encode("vault"), escrow], pubkeyFromBase58(programId));
}

/** Refuses a payee that can never receive or never spend (NEAR H5's twin), and malformed terms. */
function validateTerms(terms: SolHtlcTerms, config: SolRailConfig, payer: string): void {
  if (!HASH_LOCK_SHAPE.test(terms.hashLock)) throw new Error("sol-htlc: hashLock must be 0x + 64 lowercase hex (sha256 statement)");
  if (!isValidPubkeyBase58(terms.payee)) throw new Error("sol-htlc: payee must be a base58 public key");
  const payeeBytes = pubkeyFromBase58(terms.payee);
  const reserved: Array<[string, string]> = [
    [SYSTEM_PROGRAM_ID, "the system program (the all-zero address)"],
    [config.programId, "the HTLC program"],
    [TOKEN_PROGRAM_ID, "the token program"],
    [ASSOCIATED_TOKEN_PROGRAM_ID, "the associated-token-account program"],
    [BPF_LOADER_UPGRADEABLE_ID, "the upgradeable loader"],
    [config.assets.USDC, "the USDC mint"],
  ];
  for (const [address, what] of reserved) {
    if (terms.payee === address) throw new Error(`sol-htlc: payee must not be ${what} (nobody can sign for it, the payout could never be spent)`);
  }
  const escrow = escrowAddress(config.programId, payer, terms.hashLock).address;
  if (bytesEqual(payeeBytes, escrow) || bytesEqual(payeeBytes, vaultAddress(config.programId, escrow).address)) {
    throw new Error("sol-htlc: payee must not be this lock's own escrow or vault address");
  }
  if (!isOnCurve(payeeBytes)) {
    throw new Error("sol-htlc: payee must be a wallet key (an on-curve address); an off-curve address such as a program-derived one has no key that can spend from it");
  }
  if (isSmallOrderOrNonCanonical(payeeBytes)) {
    throw new Error("sol-htlc: payee must not be a small-order or non-canonical ed25519 point (an on-curve encoding nobody can sign for under strict verification, so the payout could never be spent)");
  }
  if (!NONNEG_DECIMAL.test(terms.amount) || BigInt(terms.amount) < BigInt(SOL_AMOUNT_FLOOR) || BigInt(terms.amount) > U64_MAX) {
    throw new Error(`sol-htlc: amount must be a decimal-integer string from ${SOL_AMOUNT_FLOOR} to 2^64-1`);
  }
  if (!Number.isSafeInteger(terms.claimByMs) || !Number.isSafeInteger(terms.refundAfterMs) || terms.claimByMs <= 0 || terms.refundAfterMs <= 0) {
    throw new Error("sol-htlc: claimByMs and refundAfterMs must be positive safe integers (milliseconds)");
  }
  if (!(terms.claimByMs < terms.refundAfterMs)) throw new Error("sol-htlc: claimByMs must be strictly before refundAfterMs");
}

// --- escrow state --------------------------------------------------------------------------------------------

export const SOL_ESCROW_LEN = 188;
const STATE_VERSION = 1;
const STATUS_NAMES: Readonly<Record<number, SolEscrowStatus>> = { 1: "Locked", 2: "Claimed", 3: "Refunded" };

export type SolEscrowStatus = "Locked" | "Claimed" | "Refunded";

export interface SolEscrowView {
  status: SolEscrowStatus;
  revealed: boolean;
  bump: number;
  payer: string;
  payee: string;
  mint: string;
  hashLock: string;
  /** Decimal string. */
  amount: string;
  claimByMs: number;
  refundAfterMs: number;
  /** `0x`-hex, only when `revealed` (the program zeroes it until a claim). */
  preimage: string | null;
}

function safeI64(view: DataView, offset: number, what: string): number {
  const value = view.getBigInt64(offset, true);
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`sol-htlc: escrow ${what} is outside the safe integer range`);
  return Number(value);
}

/** Strict decode of the program's 188-byte escrow layout (contracts-sol/README.md "Accounts and state").
 *  Throws on any other length, version, status or flag byte. */
export function decodeEscrow(data: Uint8Array): SolEscrowView {
  if (data.length !== SOL_ESCROW_LEN) throw new Error(`sol-htlc: an escrow is ${SOL_ESCROW_LEN} bytes, got ${data.length}`);
  if (data[0] !== STATE_VERSION) throw new Error("sol-htlc: unknown escrow version");
  const status = STATUS_NAMES[data[1] as number];
  if (status === undefined) throw new Error("sol-htlc: unknown escrow status");
  const revealedByte = data[2];
  if (revealedByte !== 0 && revealedByte !== 1) throw new Error("sol-htlc: invalid escrow revealed byte");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    status,
    revealed: revealedByte === 1,
    bump: data[3] as number,
    payer: pubkeyToBase58(data.slice(4, 36)),
    payee: pubkeyToBase58(data.slice(36, 68)),
    mint: pubkeyToBase58(data.slice(68, 100)),
    hashLock: `0x${bytesToHex(data.slice(100, 132))}`,
    amount: view.getBigUint64(132, true).toString(),
    claimByMs: safeI64(view, 140, "claim_by_ms"),
    refundAfterMs: safeI64(view, 148, "refund_after_ms"),
    preimage: revealedByte === 1 ? `0x${bytesToHex(data.slice(156, 188))}` : null,
  };
}

// --- instruction encoders ------------------------------------------------------------------------------------

const TAG_LOCK = 0;
const TAG_CLAIM = 1;
const TAG_REFUND = 2;

function i64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** Lock data: tag 0, hash_lock[32], payee[32], claim_by_ms i64, refund_after_ms i64, amount u64 (89 bytes). */
export function lockInstructionData(terms: SolHtlcTerms): Uint8Array {
  return concatBytes(Uint8Array.of(TAG_LOCK), hexToBytes(terms.hashLock.slice(2)), pubkeyFromBase58(terms.payee), i64le(terms.claimByMs), i64le(terms.refundAfterMs), u64le(BigInt(terms.amount)));
}

/** Claim data: tag 1 then the 32-byte preimage (33 bytes). */
export function claimInstructionData(preimage: Uint8Array): Uint8Array {
  if (preimage.length !== 32) throw new Error("sol-htlc: preimage must be 32 bytes");
  return concatBytes(Uint8Array.of(TAG_CLAIM), preimage);
}

/** Refund data: tag 2 only (1 byte). */
export function refundInstructionData(): Uint8Array {
  return Uint8Array.of(TAG_REFUND);
}

// --- write records and evidence -----------------------------------------------------------------------------

export type SolWriteKind = "lock" | "claim" | "refund";

/** What a caller records BEFORE anything is sent (record-before-send): enough to recover by signature. */
export interface SolPreparedRecord {
  kind: SolWriteKind;
  ref: string;
  /** The transaction id: the first signature, base58. */
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Lock only: the exact terms that were signed (public data), needed to verify a recovered lock. */
  terms?: SolHtlcTerms;
}

export interface SolWriteEvidence {
  ref: string;
  signature: string;
  /** The slot the transaction was included in. */
  slot: number;
  raw: string[];
  /** Claim only (SOL-A4): the claim transaction itself FAILED, but the escrow is Claimed with this claim's
   *  own preimage (another transaction, for example a relayer's or a duplicate send from another fee payer,
   *  landed first). The payee was paid; there is nothing to retry. */
  claimedByAnotherTransaction?: true;
}

interface SolPreparedWrite {
  record: SolPreparedRecord;
  tx: SolTransaction;
  /** Runs after simulation, as the LAST read before broadcast. */
  guard?: () => Promise<void>;
}

// --- the rail ------------------------------------------------------------------------------------------------

export interface SolHtlcRailOptions {
  config: SolRailConfig;
  rpc: CapturingRpc;
  signer: SolSigner;
  clock?: () => number;
  /** Awaited between status polls. Default: a timer. Tests inject a fake-clock advance. */
  sleep?: (ms: number) => Promise<void>;
  /** Default 500 ms. */
  pollIntervalMs?: number;
  /** How long a write waits for FINALIZED before throwing `SolPendingError`. Default 120 s. */
  finalityTimeoutMs?: number;
  /** Harness-only override of the landing-bound estimate (see `SOL_SLOW_BLOCK_MS`, `SOL_EXPIRY_MARGIN_MS`).
   *  Loosening these weakens the claim guard; the defaults are the reviewed ones. */
  timing?: { slowBlockMs?: number; expiryMarginMs?: number };
}

export interface SolClaimOptions {
  /**
   * SOL-A2: retry a claim whose secret is ALREADY public (an earlier claim landed and failed, so the
   * preimage sits in that transaction's instruction data). Allowed only when the escrow's own on-chain
   * history proves this preimage is public (`findClaimedPreimage`); then `notAfterMs`, the landing margin and
   * the landing bound are skipped (they protect a secret that is still private and would only stop the Seller
   * from being paid) and only "the escrow is Locked, the payee's token account is usable, the simulation
   * passes and chain time is before `refund_after_ms`" remain. Never for a claim that was only possibly seen
   * (`SolNotLandedError`): that stays a decision for a person.
   */
  retryPublicSecret?: boolean;
}

/**
 * The desk's `sol-htlc` rail handle: one instance per party, bound to one signer and one pinned chain.
 * Build it with `SolHtlcRail.connect(...)`, never `new`: connecting is where the chain pin and the program
 * are checked against reality.
 */
export class SolHtlcRail {
  private readonly config: SolRailConfig;
  private readonly rpc: CapturingRpc;
  private readonly sol: SolRpc;
  private readonly signer: SolSigner;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly finalityTimeoutMs: number;
  private readonly slowBlockMs: number;
  private readonly expiryMarginMs: number;
  private readonly programId: Uint8Array;
  private readonly mint: Uint8Array;
  private prepared: SolPreparedWrite | null = null;

  private constructor(options: SolHtlcRailOptions, config: SolRailConfig) {
    this.config = config;
    this.rpc = options.rpc;
    this.sol = new SolRpc(options.rpc);
    this.signer = options.signer;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.finalityTimeoutMs = options.finalityTimeoutMs ?? 120_000;
    const slow = options.timing?.slowBlockMs ?? SOL_SLOW_BLOCK_MS;
    const margin = options.timing?.expiryMarginMs ?? SOL_EXPIRY_MARGIN_MS;
    if (!(slow >= 1) || !(margin >= 0)) throw new Error("sol-htlc: timing overrides must be slowBlockMs >= 1 and expiryMarginMs >= 0");
    this.slowBlockMs = slow;
    this.expiryMarginMs = margin;
    this.programId = pubkeyFromBase58(config.programId);
    this.mint = pubkeyFromBase58(config.assets.USDC);
    if (!bytesEqual(pubkeyFromBase58(options.signer.publicKey), options.signer.publicKeyBytes)) {
      throw new Error("sol-htlc: signer.publicKey does not match signer.publicKeyBytes");
    }
  }

  static async connect(options: SolHtlcRailOptions): Promise<SolHtlcRail> {
    const check = checkSolRailConfig(options.config);
    if (!check.ok) throw new Error(`sol-htlc: refusing to connect - ${check.reason}`);
    const rail = new SolHtlcRail(options, check.config);
    await rail.assertPinnedChain();
    await rail.assertProgram();
    // connect's own exchanges never linger into a later write's snapshot-at-start
    options.rpc.drain();
    return rail;
  }

  get signerPublicKey(): string {
    return this.signer.publicKey;
  }

  // -- pin, program ---------------------------------------------------------------------------------------

  /** Re-checked before every write (a long-lived rail instance drives a whole swap, so refusing to sign
   *  anywhere but the pinned chain is cheap insurance against an endpoint that started answering for a
   *  different chain). Mainnet is refused by genesis; the local pin refuses every public cluster's genesis. */
  private async assertPinnedChain(): Promise<void> {
    const problem = solGenesisProblem(this.config.pin, await this.sol.getGenesisHash());
    if (problem !== null) throw new Error(problem);
  }

  /**
   * The program and the mint, read at one finalized slot: the program account is an executable account of
   * the upgradeable loader pointing at the ProgramData address derived for it; the ProgramData bytes hash to
   * the pinned `programHash` (exact, or with trailing zero padding stripped); and the upgrade authority is
   * `None` or exactly the 32 zero bytes (contracts-sol/README.md: this validator records "no authority" as
   * the all-zero address, and nobody can sign for it because Solana verifies signatures strictly, so the
   * program is immutable in practice). Any other authority, including other low-order encodings, fails
   * closed. The mint must be an initialised classic mint. Fails closed with a thrown error, never a boolean.
   */
  private async assertProgram(): Promise<void> {
    const programKey = this.config.programId;
    const first = await this.sol.getAccountInfo(programKey, { commitment: "finalized" });
    const program = first.account;
    if (program === null) throw new Error("sol-htlc: refusing to connect - the program account does not exist");
    if (!program.executable) throw new Error("sol-htlc: refusing to connect - the program account is not executable");
    if (program.owner !== BPF_LOADER_UPGRADEABLE_ID) throw new Error("sol-htlc: refusing to connect - the program is not owned by the upgradeable loader");
    if (program.data.length !== 36 || new DataView(program.data.buffer, program.data.byteOffset).getUint32(0, true) !== 2) {
      throw new Error("sol-htlc: refusing to connect - the program account is not a Program{programdata_address}");
    }
    const programDataBytes = program.data.slice(4, 36);
    const expectedProgramData = findProgramAddress([this.programId], pubkeyFromBase58(BPF_LOADER_UPGRADEABLE_ID)).address;
    if (!bytesEqual(programDataBytes, expectedProgramData)) {
      throw new Error("sol-htlc: refusing to connect - the program's ProgramData address is not the one derived for it");
    }
    const both = await this.sol.getMultipleAccounts([pubkeyToBase58(programDataBytes), this.config.assets.USDC], {
      commitment: "finalized",
      minContextSlot: first.contextSlot,
    });
    const pd = both.accounts[0];
    const mint = both.accounts[1];
    if (pd === null || pd === undefined) throw new Error("sol-htlc: refusing to connect - the ProgramData account does not exist");
    if (pd.owner !== BPF_LOADER_UPGRADEABLE_ID) throw new Error("sol-htlc: refusing to connect - the ProgramData account is not owned by the upgradeable loader");
    const d = pd.data;
    if (d.length < 45 || new DataView(d.buffer, d.byteOffset).getUint32(0, true) !== 3) {
      throw new Error("sol-htlc: refusing to connect - the ProgramData account is malformed");
    }
    const authorityTag = d[12];
    if (authorityTag === 1) {
      if (!d.slice(13, 45).every((byte) => byte === 0)) {
        throw new Error("sol-htlc: refusing to connect - the program has an upgrade authority (only None or the all-zero address is accepted)");
      }
    } else if (authorityTag !== 0) {
      throw new Error("sol-htlc: refusing to connect - the ProgramData upgrade-authority option is malformed");
    }
    const elf = d.slice(45);
    let end = elf.length;
    while (end > 0 && elf[end - 1] === 0) end -= 1;
    const exact = bytesToHex(sha256(elf));
    const trimmed = bytesToHex(sha256(elf.slice(0, end)));
    if (exact !== this.config.programHash && trimmed !== this.config.programHash) {
      throw new Error(`sol-htlc: refusing to connect - the ProgramData hash does not match the pinned programHash "${this.config.programHash}"`);
    }
    if (mint === null || mint === undefined) throw new Error("sol-htlc: refusing to connect - the USDC mint account does not exist");
    if (mint.owner !== TOKEN_PROGRAM_ID || mint.data.length !== SPL_MINT_LEN) {
      throw new Error("sol-htlc: refusing to connect - the configured mint is not a classic SPL mint");
    }
    if (!decodeMint(mint.data).isInitialized) throw new Error("sol-htlc: refusing to connect - the configured mint is not initialised");
  }

  // -- reads ----------------------------------------------------------------------------------------------

  /** Reads accounts at finalized, retrying while the node has not yet reached `minContextSlot`. */
  private async readFinalized(keys: readonly Uint8Array[], minContextSlot?: number): Promise<{ contextSlot: number; accounts: (SolAccountInfo | null)[] }> {
    const texts = keys.map(pubkeyToBase58);
    const deadline = this.clock() + this.finalityTimeoutMs;
    for (;;) {
      try {
        return await this.sol.getMultipleAccounts(texts, {
          commitment: "finalized",
          ...(minContextSlot === undefined ? {} : { minContextSlot }),
        });
      } catch (error) {
        if (!(error instanceof SolMinContextSlotError) || this.clock() >= deadline) throw error;
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private escrowKeys(ref: { hashLock: string; payer: string }): { escrow: Uint8Array; vault: Uint8Array } {
    const escrow = escrowAddress(this.config.programId, ref.payer, ref.hashLock).address;
    return { escrow, vault: vaultAddress(this.config.programId, escrow).address };
  }

  private requireRef(ref: string): { hashLock: string; payer: string } {
    const parsed = parseSolRef(ref);
    if (parsed === null) throw new Error("sol-htlc: ref must be 0x<64 hex hash lock>:<payer base58>");
    return parsed;
  }

  /** The escrow for `ref` at one finalized slot: `null` when there is no program-owned account there. A
   *  program-owned account that does not decode throws (never a verdict). */
  async getEscrow(ref: string, minContextSlot?: number): Promise<{ contextSlot: number; escrow: SolEscrowView | null }> {
    const parsed = this.requireRef(ref);
    const { escrow } = this.escrowKeys(parsed);
    const read = await this.readFinalized([escrow], minContextSlot);
    const account = read.accounts[0] ?? null;
    return { contextSlot: read.contextSlot, escrow: this.viewEscrow(account, parsed) };
  }

  private viewEscrow(account: SolAccountInfo | null, ref: { hashLock: string; payer: string }): SolEscrowView | null {
    if (account === null) return null;
    if (account.owner !== this.config.programId) return null; // a system-owned pre-funded account is not an escrow
    const view = decodeEscrow(account.data);
    if (view.hashLock !== ref.hashLock || view.payer !== ref.payer) {
      throw new Error("sol-htlc: the escrow account's own payer/hash lock do not match its address");
    }
    return view;
  }

  /** The FINALIZED slot's own block time, in ms. Fails closed: a slot without a block time (skipped) or an
   *  unusable value throws; nothing guesses a deadline. */
  async chainTimeMs(): Promise<number> {
    const slot = await this.sol.getSlot("finalized");
    const seconds = await this.sol.getBlockTime(slot);
    if (seconds === null) throw new Error(`sol-htlc: no block time for finalized slot ${slot} - refusing to guess a chain-time deadline`);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("sol-htlc: block time is not a positive integer - refusing to guess a chain-time deadline");
    return seconds * 1000;
  }

  /** The finalized slot, a snapshot of "where the chain is now" for a later bounded search. */
  async currentBlockMarker(): Promise<number> {
    return this.sol.getSlot("finalized");
  }

  private tokenAccountProblem(account: SolAccountInfo | null, mint: Uint8Array, owner: Uint8Array): string | null {
    if (account === null) return "does not exist";
    if (account.owner !== TOKEN_PROGRAM_ID) return "is not owned by the classic token program";
    let token;
    try {
      token = decodeTokenAccount(account.data);
    } catch (error) {
      return error instanceof Error ? error.message : "is not a token account";
    }
    if (token.state === "uninitialized") return "is not initialised";
    if (token.state === "frozen") return "is frozen";
    if (!bytesEqual(token.mint, mint)) return "is for a different mint";
    if (!bytesEqual(token.owner, owner)) return "is owned by a different wallet";
    return null;
  }

  // -- blockhash, signing ---------------------------------------------------------------------------------

  private async buildAndSign(
    record: Omit<SolPreparedRecord, "signature" | "blockhash" | "lastValidBlockHeight">,
    instruction: SolInstruction,
    plan: { blockhash: string; lastValidBlockHeight: number },
    guard?: () => Promise<void>,
  ): Promise<SolPreparedWrite> {
    const message = compileLegacyMessage({
      feePayer: this.signer.publicKeyBytes,
      recentBlockhash: pubkeyFromBase58(plan.blockhash),
      instructions: [instruction],
    });
    const tx = await signTransaction(message, [this.signer]);
    const full: SolPreparedRecord = { ...record, signature: tx.signature, blockhash: plan.blockhash, lastValidBlockHeight: plan.lastValidBlockHeight };
    return { record: full, tx, ...(guard === undefined ? {} : { guard }) };
  }

  /** A blockhash from `confirmed` (longest life) with the FINALIZED block height (the conservative,
   *  lower reading: more blocks remaining means a later possible landing). */
  private async blockhashPlan(): Promise<{ blockhash: string; lastValidBlockHeight: number; finalizedHeight: number }> {
    const latest = await this.sol.getLatestBlockhash("confirmed");
    const finalizedHeight = await this.sol.getBlockHeight("finalized");
    return { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, finalizedHeight };
  }

  /** The latest time (ms) a transaction signed with `lastValidBlockHeight` could still be executed:
   *  now plus the remaining blocks at the SLOW block-time estimate. */
  private latestLandingMs(nowMs: number, lastValidBlockHeight: number, finalizedHeight: number): number {
    const remaining = Math.max(0, lastValidBlockHeight - finalizedHeight);
    return nowMs + remaining * this.slowBlockMs;
  }

  // -- the write path -------------------------------------------------------------------------------------

  private txFailure(kind: SolWriteKind, signature: string, err: unknown, raw: readonly string[], detail?: string): SolTxFailedError {
    if (kind === "lock") return new SolLockRefusedError(signature, err, raw, detail);
    if (kind === "claim") return new SolClaimFailedError(signature, err, raw, detail);
    return new SolRefundFailedError(signature, err, raw, detail);
  }

  /** Polls until the signature is FINALIZED, provably dead, or the timeout passes. The order matters: the
   *  finalized block height is read BEFORE the status, so a null status after a height past
   *  `lastValidBlockHeight` means no block that could hold the transaction is missing its status. */
  private async awaitFinalized(signature: string, lastValidBlockHeight: number): Promise<SolSignatureStatus> {
    const deadline = this.clock() + this.finalityTimeoutMs;
    for (;;) {
      const height = await this.sol.getBlockHeight("finalized");
      const [status] = await this.sol.getSignatureStatuses([signature]);
      if (status !== undefined && status !== null && status.confirmationStatus === "finalized") return status;
      if ((status === undefined || status === null) && height > lastValidBlockHeight) throw new SolNotLandedError(signature);
      if (this.clock() >= deadline) {
        throw new SolPendingError(signature, status === undefined || status === null ? "no status yet" : `status ${String(status.confirmationStatus)}`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** The chain-confirmed check for one write, given the finalized status. Throws the kind's typed error. */
  private async confirmWrite(record: SolPreparedRecord, status: SolSignatureStatus, raw: () => string[], claimPreimage?: string): Promise<SolWriteEvidence> {
    const { kind, signature } = record;
    if (status.err !== null) {
      if (kind === "claim") {
        const settled = await this.claimSettledByAnotherTransaction(record, status, raw, claimPreimage);
        if (settled !== null) return settled;
      }
      throw this.txFailure(kind, signature, status.err, raw());
    }
    const parsed = this.requireRef(record.ref);
    const { escrow, vault } = this.escrowKeys(parsed);
    const read = await this.readFinalized([escrow, vault], status.slot);
    const view = this.viewEscrow(read.accounts[0] ?? null, parsed);
    const evidence: SolWriteEvidence = { ref: record.ref, signature, slot: status.slot, raw: raw() };

    if (kind === "lock") {
      const terms = record.terms;
      if (terms === undefined) throw new Error("sol-htlc: internal - a lock record is missing its terms");
      if (view === null) throw new SolLockRefusedError(signature, null, raw(), "no escrow exists after the transaction");
      const vaultProblem = this.tokenAccountProblem(read.accounts[1] ?? null, this.mint, escrow);
      const vaultBalance = vaultProblem === null ? decodeTokenAccount((read.accounts[1] as SolAccountInfo).data).amount : null;
      const matches =
        view.status === "Locked" &&
        view.payer === this.signer.publicKey &&
        view.payee === terms.payee &&
        view.mint === this.config.assets.USDC &&
        view.amount === terms.amount &&
        view.claimByMs === terms.claimByMs &&
        view.refundAfterMs === terms.refundAfterMs &&
        view.hashLock === terms.hashLock &&
        vaultBalance !== null &&
        // SOL-A1: the vault is an ordinary token account, so anyone can add to it (the program adopts a stray
        // donation and pays the whole balance out). "At least the amount", the same rule the evidence reader
        // applies; an exact match would report a landed lock as "nothing was locked" after a 1-unit donation.
        vaultBalance >= BigInt(terms.amount);
      if (!matches) throw new SolLockRefusedError(signature, null, raw(), "the escrow does not hold the terms that were sent");
      return evidence;
    }

    if (kind === "claim") {
      const opens = view !== null && view.preimage !== null && bytesEqual(sha256(hexToBytes(view.preimage.slice(2))), hexToBytes(parsed.hashLock.slice(2)));
      const same = claimPreimage === undefined || (view !== null && view.preimage === claimPreimage);
      if (view !== null && view.status === "Claimed" && view.revealed && opens && same) return evidence;
      throw new SolClaimFailedError(signature, null, raw(), `the escrow is ${view?.status ?? "missing"} after a successful transaction`);
    }

    if (view !== null && view.status === "Refunded") return evidence;
    throw new SolRefundFailedError(signature, null, raw(), `the escrow is ${view?.status ?? "missing"} after a successful transaction`);
  }

  /** SOL-A4: a claim transaction that failed only because the escrow was already Claimed (a duplicate send,
   *  a relayer that won the race) is not "failed, retry at once": read the escrow at finalized, and when it is
   *  Claimed with a stored preimage that opens the hash lock (and equals this claim's own, when known) the
   *  payee was paid. Any read failure or any other state falls back to the typed failure (fail closed). */
  private async claimSettledByAnotherTransaction(
    record: SolPreparedRecord,
    status: SolSignatureStatus,
    raw: () => string[],
    claimPreimage?: string,
  ): Promise<SolWriteEvidence | null> {
    try {
      const parsed = this.requireRef(record.ref);
      const { escrow } = this.escrowKeys(parsed);
      const read = await this.readFinalized([escrow], status.slot);
      const view = this.viewEscrow(read.accounts[0] ?? null, parsed);
      if (view === null || view.status !== "Claimed" || !view.revealed || view.preimage === null) return null;
      if (!bytesEqual(sha256(hexToBytes(view.preimage.slice(2))), hexToBytes(parsed.hashLock.slice(2)))) return null;
      if (claimPreimage !== undefined && view.preimage !== claimPreimage) return null;
      return { ref: record.ref, signature: record.signature, slot: status.slot, raw: raw(), claimedByAnotherTransaction: true };
    } catch {
      return null;
    }
  }

  /** Simulate at `confirmed` (a `finalized` bank's clock is stale for the program's window checks); a set
   *  `err` throws typed and NOTHING is sent. */
  private async simulateOrThrow(tx: SolTransaction): Promise<void> {
    const sim = await this.sol.simulateTransaction(tx.bytes, { commitment: "confirmed", sigVerify: true });
    if (sim.err === null) return;
    if (sim.err === "BlockhashNotFound") throw new SolBlockhashNotFoundError({ phase: "simulate", logs: sim.logs, unitsConsumed: sim.unitsConsumed, code: -32002 });
    throw new SolSimulationFailedError({ phase: "simulate", err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed, code: -32002 });
  }

  /** Simulate, run the last-moment guard, send with preflight, wait finalized, confirm on chain. */
  private async sendPrepared(prepared: SolPreparedWrite, claimPreimage?: string): Promise<SolWriteEvidence> {
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    const raw = (): string[] => this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
    const { record, tx } = prepared;
    this.rpc.setIdNamespace(`write:${record.ref}:${this.clock()}`);
    try {
      await this.simulateOrThrow(tx);
      if (prepared.guard !== undefined) await prepared.guard();
      const reported = await this.sol.sendTransaction(tx.bytes, { preflightCommitment: "confirmed" });
      if (reported !== record.signature) {
        throw new Error(`sol-htlc: the node reported signature ${reported}, not the recorded ${record.signature}`);
      }
      const status = await this.awaitFinalized(record.signature, record.lastValidBlockHeight);
      return await this.confirmWrite(record, status, raw, claimPreimage);
    } finally {
      this.rpc.setIdNamespace(undefined);
    }
  }

  // -- lock -----------------------------------------------------------------------------------------------

  /**
   * Builds and signs the Buyer's Lock transaction and returns the record to persist BEFORE `commitLock()`
   * sends it: `ref` (`0x<hash lock>:<payer>`, known now) and `signature` (the transaction id, known now). It
   * refuses terms that can never work (see `validateTerms`), an escrow that already exists for this payer
   * and hash lock, and a payer token account that is missing, frozen, for another mint or too small.
   */
  async prepareLock(terms: SolHtlcTerms): Promise<SolPreparedRecord> {
    validateTerms(terms, this.config, this.signer.publicKey);
    await this.assertPinnedChain();
    const ref = formatSolRef(terms.hashLock, this.signer.publicKey);
    const { escrow, vault } = this.escrowKeys({ hashLock: terms.hashLock, payer: this.signer.publicKey });
    const payerToken = associatedTokenAddress(this.signer.publicKeyBytes, this.mint);
    const read = await this.readFinalized([escrow, payerToken]);
    const existing = read.accounts[0] ?? null;
    if (existing !== null && existing.owner === this.config.programId) {
      throw new Error("sol-htlc: refusing to lock - an escrow already exists for this payer and hash lock");
    }
    const problem = this.tokenAccountProblem(read.accounts[1] ?? null, this.mint, this.signer.publicKeyBytes);
    if (problem !== null) throw new Error(`sol-htlc: refusing to lock - the payer's token account ${problem}`);
    const balance = decodeTokenAccount((read.accounts[1] as SolAccountInfo).data).amount;
    if (balance < BigInt(terms.amount)) throw new Error("sol-htlc: refusing to lock - the payer's token account holds less than the amount");

    const instruction: SolInstruction = {
      programId: this.programId,
      accounts: [
        { pubkey: this.signer.publicKeyBytes, isSigner: true, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: this.mint, isSigner: false, isWritable: false },
        { pubkey: payerToken, isSigner: false, isWritable: true },
        { pubkey: pubkeyFromBase58(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        { pubkey: pubkeyFromBase58(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      ],
      data: lockInstructionData(terms),
    };
    const plan = await this.blockhashPlan();
    this.prepared = await this.buildAndSign({ kind: "lock", ref, terms }, instruction, plan);
    return this.prepared.record;
  }

  /** Sends exactly the transaction `prepareLock` built. Consumes it (a second call throws), so a caller
   *  can never double-send by accident. Returns evidence only after the escrow at FINALIZED holds this
   *  signer's own terms; otherwise a typed error (`SolLockRefusedError`, `SolSimulationFailedError`,
   *  `SolPendingError`, `SolNotLandedError`). A transport failure during send rethrows unchanged: recover by
   *  the recorded signature (`recoverBySignature`), never by re-signing blind. */
  async commitLock(): Promise<SolWriteEvidence> {
    if (this.prepared === null) throw new Error("sol-htlc: commitLock called with no prepared lock - call prepareLock first");
    const prepared = this.prepared;
    this.prepared = null;
    return this.sendPrepared(prepared);
  }

  // -- claim ----------------------------------------------------------------------------------------------

  /**
   * Claims the lock named by `ref` with `preimage`, judged against `notAfterMs` (the client-side claim
   * bound; the program enforces only `refund_after_ms`). Before anything is signed: the preimage must open
   * the hash lock; the escrow (read at finalized) must be Locked and this ref's own; chain time must be
   * before `refund_after_ms`; the payee's associated token account must exist, be initialised, unfrozen, for
   * the mint and owned by the payee; the vault must hold the amount; `notAfterMs` must leave at least
   * `SOL_CLAIM_LANDING_MARGIN_MS` before `refund_after_ms`; and the latest time a transaction with the fresh
   * blockhash could still land, plus the expiry margin, must be before `refund_after_ms` (otherwise a late
   * claim would be executed and publish the secret; `SolClaimTooLateError`). Then: sign, `onSigned` (record
   * the signature; awaited before anything is sent), simulate (a claim the runtime would refuse is never
   * sent, so a refusal here does not publish the secret), the last-moment guard with
   * `max(chain time, clock)` against `notAfterMs` and the landing bound, send, wait FINALIZED, confirm
   * Claimed on chain. A claim that landed and failed is `SolClaimFailedError` (the secret is public), except
   * when the escrow is Claimed with this preimage (another transaction won; SOL-A4).
   *
   * `notAfterMs` must still be in the future (SOL-A3): a claim past its own deadline is refused before it is
   * signed. NOTE: `simulateTransaction` carries the signed claim, and so the secret, to the configured
   * endpoint; the Seller's endpoint must be a node it trusts, as for the send path. For a secret that is
   * already public (an earlier claim landed and failed) `options.retryPublicSecret` retries without the
   * deadline and landing bounds (`SolClaimOptions`, SOL-A2).
   */
  async claim(
    ref: string,
    preimage: string,
    notAfterMs: number,
    onSigned?: (record: SolPreparedRecord) => void | Promise<void>,
    options: SolClaimOptions = {},
  ): Promise<SolWriteEvidence> {
    const parsed = this.requireRef(ref);
    if (!SECRET_SHAPE.test(preimage)) throw new Error("sol-htlc: preimage must be 0x + 64 lowercase hex");
    const preimageBytes = hexToBytes(preimage.slice(2));
    if (!bytesEqual(sha256(preimageBytes), hexToBytes(parsed.hashLock.slice(2)))) {
      throw new Error("sol-htlc: preimage does not open hashLock (sha256 mismatch) - refusing to build a claim that can never verify");
    }
    if (!Number.isFinite(notAfterMs)) throw new Error("sol-htlc: notAfterMs must be a finite number of milliseconds");
    await this.assertPinnedChain();

    const { escrow, vault } = this.escrowKeys(parsed);
    const first = await this.readFinalized([escrow]);
    const view = this.viewEscrow(first.accounts[0] ?? null, parsed);
    if (view === null || view.status !== "Locked") {
      throw new Error(`sol-htlc: refusing to claim - the escrow is not in a claimable "Locked" state (got ${view?.status ?? "none"})`);
    }
    if (view.mint !== this.config.assets.USDC) throw new Error("sol-htlc: refusing to claim - the escrow is for a different mint");
    const payeeBytes = pubkeyFromBase58(view.payee);
    const payeeToken = associatedTokenAddress(payeeBytes, this.mint);
    const second = await this.readFinalized([vault, payeeToken], first.contextSlot);
    const vaultProblem = this.tokenAccountProblem(second.accounts[0] ?? null, this.mint, escrow);
    if (vaultProblem !== null) throw new Error(`sol-htlc: refusing to claim - the vault ${vaultProblem}`);
    if (decodeTokenAccount((second.accounts[0] as SolAccountInfo).data).amount < BigInt(view.amount)) {
      throw new Error("sol-htlc: refusing to claim - the vault holds less than the escrow amount");
    }
    const payeeProblem = this.tokenAccountProblem(second.accounts[1] ?? null, this.mint, payeeBytes);
    if (payeeProblem !== null) throw new Error(`sol-htlc: refusing to claim - the payee's associated token account ${payeeProblem} (the payout would fail)`);

    const retry = options.retryPublicSecret === true;
    if (retry) {
      // SOL-A2: the retry mode exists only for a secret that is ALREADY public, and that is proven on chain,
      // never taken on the caller's word.
      const proven = await this.findClaimedPreimage(ref);
      if (proven !== preimage) {
        throw new Error("sol-htlc: refusing a public-secret retry - no claim carrying this preimage was found in this escrow's on-chain history");
      }
    }

    const nowMs = Math.max(await this.chainTimeMs(), this.clock());
    if (!(nowMs < view.refundAfterMs)) throw new Error("sol-htlc: refusing to claim - the clock is already at/after refundAfterMs");
    if (!retry && notAfterMs > view.refundAfterMs - SOL_CLAIM_LANDING_MARGIN_MS) {
      throw new Error(
        `sol-htlc: refusing to claim - notAfterMs (${notAfterMs}) leaves less than the ${SOL_CLAIM_LANDING_MARGIN_MS}ms landing margin before refundAfterMs (${view.refundAfterMs})`,
      );
    }
    const plan = await this.blockhashPlan();
    const bound = this.latestLandingMs(nowMs, plan.lastValidBlockHeight, plan.finalizedHeight) + this.expiryMarginMs;
    if (!retry && bound > view.refundAfterMs) {
      throw new SolClaimTooLateError(
        `sol-htlc: refusing to claim - a transaction signed now could still land as late as ${bound} ms, after refundAfterMs ${view.refundAfterMs} minus the ${this.expiryMarginMs}ms margin (the secret would be published by a claim that fails late)`,
      );
    }
    // SOL-A3: nothing is signed, handed to `onSigned` or sent to `simulateTransaction` (which carries the
    // signed claim, and so the secret, to the endpoint) for a claim whose own deadline has already passed.
    if (!retry && !(nowMs < notAfterMs)) {
      throw new Error(`sol-htlc: refusing to claim - the deadline notAfterMs (${notAfterMs}) has already passed (chain time/clock ${nowMs})`);
    }

    const instruction: SolInstruction = {
      programId: this.programId,
      accounts: [
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: this.mint, isSigner: false, isWritable: false },
        { pubkey: payeeToken, isSigner: false, isWritable: true },
        { pubkey: pubkeyFromBase58(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      ],
      data: claimInstructionData(preimageBytes),
    };
    const refundAfterMs = view.refundAfterMs;
    // The LAST reads before broadcast: fresh chain time and finalized height, judged against the client
    // bound and against the landing bound of THIS blockhash.
    const guard = async (): Promise<void> => {
      const finalNowMs = Math.max(await this.chainTimeMs(), this.clock());
      if (retry) {
        // The secret is already public, so a claim that lands late and fails leaks nothing new; only stop
        // once the window is closed (the program would refuse it and the Buyer may refund).
        if (finalNowMs >= refundAfterMs) throw new Error(`sol-htlc: refusing to broadcast the retry - chain time ${finalNowMs} is at/after refundAfterMs ${refundAfterMs}`);
        return;
      }
      if (finalNowMs >= notAfterMs) {
        throw new Error(`sol-htlc: refusing to broadcast claim - chain time ${finalNowMs} is at/after the given deadline (notAfterMs ${notAfterMs})`);
      }
      const height = await this.sol.getBlockHeight("finalized");
      const latest = this.latestLandingMs(finalNowMs, plan.lastValidBlockHeight, height) + this.expiryMarginMs;
      if (latest > refundAfterMs) {
        throw new SolClaimTooLateError(`sol-htlc: refusing to broadcast claim - it could still land as late as ${latest} ms, after refundAfterMs ${refundAfterMs} minus the margin`);
      }
    };
    const prepared = await this.buildAndSign({ kind: "claim", ref }, instruction, plan, guard);
    if (onSigned !== undefined) await onSigned(prepared.record);
    return this.sendPrepared(prepared, preimage);
  }

  // -- refund ---------------------------------------------------------------------------------------------

  /**
   * Refunds the lock named by `ref` (the signer must be its payer). Before anything is signed: the escrow at
   * finalized is Locked and this signer's own, finalized chain time has reached `refund_after_ms` (only the
   * chain's own time, never the local clock: a fast clock must not build a refund the program will refuse),
   * and the payer's associated token account is a usable destination. Then the common write path (record via
   * `onSigned`, simulate, send, FINALIZED, confirm Refunded).
   */
  async refund(ref: string, onSigned?: (record: SolPreparedRecord) => void | Promise<void>): Promise<SolWriteEvidence> {
    const parsed = this.requireRef(ref);
    if (parsed.payer !== this.signer.publicKey) {
      throw new Error("sol-htlc: refund must be signed by the payer's own key (the ref's payer must equal the signer)");
    }
    await this.assertPinnedChain();
    const { escrow, vault } = this.escrowKeys(parsed);
    const payerToken = associatedTokenAddress(this.signer.publicKeyBytes, this.mint);
    const first = await this.readFinalized([escrow, payerToken]);
    const view = this.viewEscrow(first.accounts[0] ?? null, parsed);
    if (view === null || view.status !== "Locked") {
      throw new Error(`sol-htlc: refusing to refund - the escrow is not in a refundable "Locked" state (got ${view?.status ?? "none"})`);
    }
    const problem = this.tokenAccountProblem(first.accounts[1] ?? null, this.mint, this.signer.publicKeyBytes);
    if (problem !== null) throw new Error(`sol-htlc: refusing to refund - the payer's token account ${problem}`);
    const nowMs = await this.chainTimeMs();
    if (!(nowMs >= view.refundAfterMs)) throw new Error("sol-htlc: refusing to refund - chain time has not yet reached refundAfterMs");

    const instruction: SolInstruction = {
      programId: this.programId,
      accounts: [
        { pubkey: this.signer.publicKeyBytes, isSigner: true, isWritable: false },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: this.mint, isSigner: false, isWritable: false },
        { pubkey: payerToken, isSigner: false, isWritable: true },
        { pubkey: pubkeyFromBase58(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      ],
      data: refundInstructionData(),
    };
    const plan = await this.blockhashPlan();
    const prepared = await this.buildAndSign({ kind: "refund", ref }, instruction, plan);
    if (onSigned !== undefined) await onSigned(prepared.record);
    return this.sendPrepared(prepared);
  }

  // -- recovery -------------------------------------------------------------------------------------------

  /**
   * Lost-reply recovery by the RECORDED signature (never by re-signing). Returns:
   *   - evidence, once the signature is FINALIZED and the escrow at finalized shows the write's effect;
   *   - `null` ("never landed"), ONLY when the record's blockhash has expired (finalized block height past
   *     `lastValidBlockHeight`, read before the status) AND the node has no status for the signature;
   * and throws `SolPendingError` while neither is decided (no status yet, or landed but not finalized), the
   * write's typed failure (`SolLockRefusedError` / `SolClaimFailedError` / `SolRefundFailedError`) when the
   * transaction is finalized with an error, and a transport failure unchanged.
   */
  async recoverBySignature(record: SolPreparedRecord): Promise<SolWriteEvidence | null> {
    if (parseSolRef(record.ref) === null) throw new Error("sol-htlc: recover needs the record's own ref");
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    const raw = (): string[] => this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
    const height = await this.sol.getBlockHeight("finalized");
    const [status] = await this.sol.getSignatureStatuses([record.signature]);
    if (status === undefined || status === null) {
      if (height > record.lastValidBlockHeight) return null;
      throw new SolPendingError(record.signature, "no status yet and the blockhash has not expired");
    }
    if (status.confirmationStatus !== "finalized") {
      throw new SolPendingError(record.signature, `status ${String(status.confirmationStatus)}, not finalized yet`);
    }
    return this.confirmWrite(record, status, raw);
  }

  // -- preimage discovery ---------------------------------------------------------------------------------

  /**
   * The secret, if it is public: from the escrow's stored preimage (a Claimed escrow), or, because a claim
   * that FAILS still publishes it in its instruction data (S1), from the escrow's own transaction history
   * (`getSignaturesForAddress` on the escrow, then `getTransaction` for each, both at finalized and bounded
   * by `SOL_PREIMAGE_SCAN_MAX_TRANSACTIONS`). Only a preimage that actually opens the hash lock is returned;
   * a Claim instruction is recognised only when it names this program, has the 33-byte claim shape, and its
   * first account is this escrow. A history longer than the bound is not exhaustively scanned (anyone can
   * pad an address's history); a claim buried under that padding is missed, which is why the Buyer also
   * reads the escrow itself first.
   */
  async findClaimedPreimage(ref: string): Promise<string | null> {
    const parsed = this.requireRef(ref);
    const hashLockBytes = hexToBytes(parsed.hashLock.slice(2));
    const opens = (bytes: Uint8Array): boolean => bytes.length === 32 && bytesEqual(sha256(bytes), hashLockBytes);
    const { escrow: view } = await this.getEscrow(ref);
    if (view !== null && view.preimage !== null && opens(hexToBytes(view.preimage.slice(2)))) return view.preimage;

    const { escrow } = this.escrowKeys(parsed);
    const escrowText = pubkeyToBase58(escrow);
    let inspected = 0;
    let before: string | undefined;
    while (inspected < SOL_PREIMAGE_SCAN_MAX_TRANSACTIONS) {
      const limit = Math.min(SCAN_PAGE, SOL_PREIMAGE_SCAN_MAX_TRANSACTIONS - inspected);
      const page = await this.sol.getSignaturesForAddress(escrowText, { commitment: "finalized", limit, ...(before === undefined ? {} : { before }) });
      for (const info of page) {
        inspected += 1;
        const fetched = await this.sol.getTransaction(info.signature, "finalized");
        if (fetched === null || fetched.transaction === null) continue;
        const found = this.preimageFromTransaction(fetched.transaction, escrow, opens);
        if (found !== null) return found;
      }
      const last = page[page.length - 1];
      if (page.length < limit || last === undefined) break;
      before = last.signature;
    }
    return null;
  }

  private preimageFromTransaction(tx: SolTransaction, escrow: Uint8Array, opens: (bytes: Uint8Array) => boolean): string | null {
    const keys = tx.message.accountKeys;
    for (const ix of tx.message.instructions) {
      const program = keys[ix.programIdIndex];
      if (program === undefined || !bytesEqual(program, this.programId)) continue;
      if (ix.data.length !== 33 || ix.data[0] !== TAG_CLAIM) continue;
      const first = ix.accountIndexes[0];
      const escrowKey = first === undefined ? undefined : keys[first];
      if (escrowKey === undefined || !bytesEqual(escrowKey, escrow)) continue;
      const candidate = ix.data.slice(1);
      if (opens(candidate)) return `0x${bytesToHex(candidate)}`;
    }
    return null;
  }

  /** A claim cannot be "pending" on Solana in a way that hides a secret from `findClaimedPreimage` (there is
   *  no mempool view); kept as its own name so a caller's intent - "is there a claim I should know about
   *  before building a refund" - reads clearly at the call site. */
  async checkPendingClaim(ref: string): Promise<string | null> {
    return this.findClaimedPreimage(ref);
  }
}
