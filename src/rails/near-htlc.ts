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
// the ref (the hash lock) is known before ever touching the network. `claim`/`refund` are single
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
} from "./near-rpc.js";
import type { CapturingRpc } from "./rpc-capture.js";

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
}

/** D-N5: NEAR account ids permit `_` (a deliberate deviation from the generic CAIP-10 charset,
 *  documented here rather than silently accepted): lowercase letters, digits, and `-`/`_`/`.` as
 *  interior separators, 2-64 chars, never leading/trailing or doubled-up separators. This is a
 *  practical subset of NEAR's own account-id grammar (a valid NEAR id can also nest a top-level
 *  account through multiple `.` segments — matched here too, since each segment obeys the same
 *  rule). */
const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

const HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/;
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

function validateTerms(terms: NearHtlcTerms): void {
  if (!HASH_LOCK_SHAPE.test(terms.hashLock)) {
    throw new Error("near-htlc: hashLock must be 0x + 64 lowercase hex (sha256 statement)");
  }
  if (!NEAR_ACCOUNT_ID.test(terms.payee)) {
    throw new Error("near-htlc: payee must be a valid NEAR account id");
  }
  if (!NONNEG_DECIMAL.test(terms.amount) || BigInt(terms.amount) < BigInt(NEAR_AMOUNT_FLOOR)) {
    throw new Error(`near-htlc: amount must be a decimal-integer string >= the floor (${NEAR_AMOUNT_FLOOR})`);
  }
  if (!(terms.claimByMs < terms.refundAfterMs)) {
    throw new Error("near-htlc: claimByMs must be strictly before refundAfterMs");
  }
}

/** D-N9: explicit gas constants, mirroring the contract's own (measured once live, NB-int
 *  corrects these in the commit message that does the measuring). */
const TGAS = 1_000_000_000_000n;
export const FT_TRANSFER_CALL_GAS = 100n * TGAS;
export const CLAIM_REFUND_GAS = 60n * TGAS;
const ONE_YOCTO = 1n;

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

// --- The rail ------------------------------------------------------------------------------------

export interface NearHtlcRailOptions {
  config: NearRailConfig;
  rpc: CapturingRpc;
  signer: NearSigner;
  clock?: () => number;
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
  private prepared: NearPreparedWrite | null = null;

  private constructor(config: NearRailConfig, rpc: CapturingRpc, near: NearRpc, signer: NearSigner, clock: () => number) {
    this.config = config;
    this.rpc = rpc;
    this.near = near;
    this.signer = signer;
    this.signerPublicKeyBytes = decodePublicKey(signer.publicKey);
    this.clock = clock;
  }

  static async connect(options: NearHtlcRailOptions): Promise<NearHtlcRail> {
    const configCheck = checkNearRailConfig(options.config);
    if (!configCheck.ok) {
      throw new Error(`near-htlc: refusing to connect — ${configCheck.reason}`);
    }
    const near = new NearRpc(options.rpc);
    const rail = new NearHtlcRail(configCheck.config, options.rpc, near, options.signer, options.clock ?? Date.now);
    await rail.assertPinnedChain();
    // A10-equivalent: connect's own exchanges never linger into a later write's own
    // snapshot-at-start.
    options.rpc.drain();
    return rail;
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

  /** Broadcasts a previously built-and-signed write (`wait_until: "FINAL"`, D-N9), then reads
   *  the height of the block the outcome names (the outcome itself only ever carries a hash, not
   *  a height). `before` (A10) is this write's own exchange-log snapshot-at-start, so `raw` below
   *  covers exactly this write's own exchanges — never an earlier, un-drained read. */
  private async sendPrepared(prepared: NearPreparedWrite): Promise<NearWriteEvidence> {
    await this.assertPinnedChain();
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
    const block = await this.near.block({ blockId: outcome.transactionOutcome.blockHash });
    const raw = this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
    return { ref: prepared.ref, txHash: prepared.txHash, blockHeight: block.header.height, blockHash: outcome.transactionOutcome.blockHash, raw };
  }

  /**
   * D-N4: builds and signs the Buyer's `ft_transfer_call` lock — `receiver_id` = the HTLC
   * contract, `msg` = the JSON the contract's own `ft_on_transfer` parses (hash_lock without its
   * `0x` prefix, payee, claim_by_ms/refund_after_ms as strings, matching the contract's own u64
   * JSON convention) — and records `{ ref, txHash }` WITHOUT sending. `ref` is the hash lock
   * itself (D-N4: "known before any write"), not the transaction hash. A caller records this
   * return value before ever calling `commitLock()`.
   */
  async prepareLock(terms: NearHtlcTerms): Promise<{ ref: string; txHash: string }> {
    validateTerms(terms);
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
    this.prepared = { ref: terms.hashLock, txHash: built.txHash, signedTxBase64: built.signedTxBase64 };
    return { ref: terms.hashLock, txHash: built.txHash };
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
  private async getLock(hashLock: string, ref: NearBlockRef = { finality: "final" }): Promise<NearLockView | null> {
    const result = await this.near.callFunction(this.config.contract, "get_lock", { hash_lock: hashLock.slice(2) }, ref);
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
   */
  async claim(hashLock: string, preimage: string, notAfterMs: number): Promise<NearWriteEvidence> {
    if (!HASH_LOCK_SHAPE.test(hashLock)) throw new Error("near-htlc: hashLock must be 0x + 64 lowercase hex");
    if (!SECRET_SHAPE.test(preimage)) throw new Error("near-htlc: preimage must be 0x + 64 lowercase hex");
    const preimageBytes = hexToBytes(preimage.slice(2));
    const hashLockBytes = hexToBytes(hashLock.slice(2));
    if (!bytesEqual(sha256(preimageBytes), hashLockBytes)) {
      throw new Error("near-htlc: preimage does not open hashLock (sha256 mismatch) — refusing to build a claim that can never verify");
    }
    await this.assertPinnedChain();

    const lockView = await this.getLock(hashLock);
    if (lockView === null || lockView.status !== "Locked") {
      throw new Error(`near-htlc: refusing to claim — lock is not in a claimable "Locked" state (got ${lockView?.status ?? "none"})`);
    }
    const preClaimNowMs = await this.chainTimeMs();
    if (!(preClaimNowMs < lockView.refundAfterMs)) {
      throw new Error("near-htlc: refusing to claim — chain time is already at/after refundAfterMs");
    }
    const storage = await this.storageBalanceOf(lockView.payee);
    if (storage === null) {
      throw new Error(`near-htlc: refusing to claim — payee "${lockView.payee}" is not storage-registered on the token (the payout would fail)`);
    }

    const action: NearAction = {
      type: "FunctionCall",
      methodName: "claim",
      args: new TextEncoder().encode(JSON.stringify({ hash_lock: hashLock.slice(2), preimage: preimage.slice(2) })),
      gas: CLAIM_REFUND_GAS,
      deposit: 0n,
    };
    const built = await this.buildAndSign(this.config.contract, [action]);

    // The deadline guard is the LAST read before broadcast — nothing but sendPrepared's own
    // assertPinnedChain + send_tx follow.
    const finalNowMs = await this.chainTimeMs();
    if (finalNowMs >= notAfterMs) {
      throw new Error(`near-htlc: refusing to broadcast claim — chain time ${finalNowMs} is at/after the given deadline (notAfterMs ${notAfterMs})`);
    }

    return this.sendPrepared({ ref: hashLock, txHash: built.txHash, signedTxBase64: built.signedTxBase64 });
  }

  /**
   * The same two-step as `claim` (sign-and-record, then send): `get_lock` shows `Locked`, the
   * caller's own signer is the lock's `payer` (mirrors `btc-htlc.ts`'s "refund must be signed by
   * the payer's own wallet"), and chain time has reached `refundAfterMs` — all against a fresh
   * `final` read — before anything is built or signed.
   */
  async refund(hashLock: string): Promise<NearWriteEvidence> {
    if (!HASH_LOCK_SHAPE.test(hashLock)) throw new Error("near-htlc: hashLock must be 0x + 64 lowercase hex");
    await this.assertPinnedChain();

    const lockView = await this.getLock(hashLock);
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
    return this.sendPrepared({ ref: hashLock, txHash: built.txHash, signedTxBase64: built.signedTxBase64 });
  }

  /**
   * D-N4's lost-reply recovery path: `EXPERIMENTAL_tx_status` by the write's own recorded
   * `txHash` + sender — for a caller resuming after an interruption between `sendPrepared`'s own
   * `send_tx` and its return, which must never re-sign or re-send blind. `null` (never throws)
   * when the node has no record of this transaction at all (`NearUnknownTransactionError`) —
   * every other error propagates (mirrors `btc-htlc.ts`'s `recoverFunding`'s own R2-2 rule: only
   * a genuine "not found" answer may collapse to "never reached the network").
   */
  async recoverByTxHash(txHash: string, senderAccountId: string): Promise<NearWriteEvidence | null> {
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    let outcome;
    try {
      outcome = await this.near.txStatus(txHash, senderAccountId);
    } catch (error) {
      if (error instanceof NearUnknownTransactionError) return null;
      throw error;
    }
    const block = await this.near.block({ blockId: outcome.transactionOutcome.blockHash });
    const raw = this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
    return { ref: txHash, txHash, blockHeight: block.header.height, blockHash: outcome.transactionOutcome.blockHash, raw };
  }

  /** D-N6: the Buyer's own cheap way to learn the secret from a pending OR already-final claim —
   *  `get_lock` in `Claiming` (the payout callback hasn't landed yet) or `Claimed` both carry the
   *  preimage (it becomes public the moment `claim()` is called, not only once it settles). Only
   *  ever returns a preimage that actually opens `hashLock` — never trusts the view's own shape
   *  alone (mirrors `evm-htlc.ts`'s `findClaimedPreimage`). */
  async findClaimedPreimage(hashLock: string): Promise<string | null> {
    if (!HASH_LOCK_SHAPE.test(hashLock)) throw new Error("near-htlc: hashLock must be 0x + 64 lowercase hex");
    const lock = await this.getLock(hashLock);
    if (lock === null || lock.preimage === null) return null;
    if (lock.status !== "Claiming" && lock.status !== "Claimed") return null;
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
  async checkPendingClaim(hashLock: string): Promise<string | null> {
    return this.findClaimedPreimage(hashLock);
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
