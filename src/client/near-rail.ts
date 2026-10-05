// SPDX-License-Identifier: MIT
//
// P5-NEAR-SPEC.md §4/§7a: the `near-htlc` implementation of `CounterAssetRail`
// (src/client/counter-rail.ts) — thin wrappers around the existing, untouched
// src/rails/near-htlc.ts (keyless writes, via an in-memory `NearSigner` — D-N2/D-10) and
// src/rails/near-evidence.ts (the pure, synchronous "capture live, then decide" evidence
// reader). Mirrors src/client/evm-rail.ts's own split exactly, not src/client/btc-rail.ts's:
// like EVM (and unlike Bitcoin's dual-pubkey P2WSH script), a near-htlc leg posts a single
// account-id line per party (D-N5), and the write path's own `ref` (`0x<hash lock>:<payer>`,
// near-ref.ts) is known before any write happens at all (D-N4), so `prepareLock` needs no network call of its own —
// exactly EVM's own G3 shortcut, not Bitcoin's "build+sign a whole PSBT to learn the outpoint"
// one.
//
// D-N6: `resendRefundIfDropped` is deliberately OMITTED here — NEAR has no mempool a
// transaction can silently drop out of the way Bitcoin's fee-market mempool does (a NEAR
// `send_tx` either executes and is recorded, or the RPC call itself fails); there is nothing
// for a "resend the identical bytes" path to fix that `NearHtlcRail.recoverByTxHash` (a lost
// REPLY, not a lost transaction) doesn't already cover. `checkPendingClaim` IS implemented
// (D-N6): NEAR's own `Claiming` state already carries the preimage the moment `claim()` is
// called, so a caller building a refund can cheaply learn "someone else already claimed" before
// ever broadcasting one — the same purpose `BuyerFlow.refundLegA` already uses this for on the
// EVM/BTC rails.
//
// Design source: flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md (D-N1..D-N12);
// flop-contrib/handoff/P5-NEAR-SPEC.md §4/§7a; flop-contrib/handoff/P4-BTC-SPEC.md §7a (the
// shared CounterAssetRail contract every rail implements).

import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import { accountProofMessage, formatAccountLine, resolveAccounts } from "../rails/account-line.js";
import { base58 } from "@scure/base";

import type { AccountProof } from "../rails/account-proof.js";
import { decodeSignedTransactionHeader } from "../rails/near-borsh.js";
import { nearEvidence, captureNearLeg, NEAR_RAIL_ID, type NearAccounts, type NearCapture } from "../rails/near-evidence.js";
import {
  NEAR_AMOUNT_FLOOR,
  NEAR_ASSET_ID,
  NearHtlcRail,
  type NearHtlcTerms,
  type NearRailConfig,
  type NearSigner,
  type NearWriteEvidence,
} from "../rails/near-htlc.js";
import { nep413Verifier, signNep413 } from "../rails/near-proof.js";
import { parseNearRef } from "../rails/near-ref.js";
import { NearRpc, NearTimeoutError } from "../rails/near-rpc.js";
import { verifiedExchangeBytes, type CapturingRpc, type Exchange } from "../rails/rpc-capture.js";
import {
  RailRecoveryRefusedError,
  type ConnectedCounterAssetRail,
  type CounterAssetRail,
  type LockRecovery,
  type LockRecoveryOutcome,
  type PreparedLock,
  type RailAccounts,
  type RailBlockMarker,
  type RailEvidenceResult,
  type RailRefundOptions,
  type RailWriteEvidence,
} from "./counter-rail.js";
import { NEAR_LOCAL_POLICY, type RailLocalPolicy } from "./policy.js";

export interface NearCounterRailOptions {
  config: NearRailConfig;
  /** The transport every read and write goes through — also this rail's `CaptureSink`. */
  rpc: CapturingRpc;
  /** This party's own keyless signer (§1/D-N2/D-10) — never a raw key; the concrete in-memory
   *  implementation lives only in `near-signer-memory.ts` (test/harness code). */
  signer: NearSigner;
  clock: () => number;
}

/** D-N5: only the payee's resolved NEAR account id is ever required to build a lock — the
 *  payer's own identity is always the connected handle's own `signer.accountId` (never resolved
 *  externally, mirrors `evm-rail.ts`'s `addressBookFor`'s identical treatment of `ownAccount`).
 *  Throws, never guesses, the moment the payee is missing, so a caller discovers this before it
 *  goes anywhere near `prepareLock`. */
function toNearHtlcTerms(terms: LockTerms, accounts: RailAccounts): NearHtlcTerms {
  if (terms.lock !== "hash") {
    throw new Error(`near-rail: only hash locks are supported, got ${terms.lock}`);
  }
  if (accounts.payee === undefined) {
    throw new Error("near-rail: refusing to proceed — this leg needs the payee's resolved NEAR account id (D-N5)");
  }
  return {
    hashLock: terms.statement,
    amount: terms.amount,
    payee: accounts.payee,
    claimByMs: terms.claimByMs,
    refundAfterMs: terms.refundAfterMs,
  };
}

function toWriteEvidence(evidence: NearWriteEvidence): RailWriteEvidence {
  return { ref: evidence.ref, txHash: evidence.txHash, blockHeight: evidence.blockHeight, blockHash: evidence.blockHash, raw: evidence.raw };
}

class ConnectedNearCounterRail implements ConnectedCounterAssetRail {
  private readonly nearRail: NearHtlcRail;
  private readonly options: NearCounterRailOptions;
  private readonly accounts: RailAccounts;
  /** G4: this leg's own frozen terms, kept only for `lockRecorded`'s own permissive existence
   *  check — every other method here already gets what it needs from its own arguments. */
  private readonly terms: LockTerms;

  constructor(nearRail: NearHtlcRail, options: NearCounterRailOptions, accounts: RailAccounts, terms: LockTerms) {
    this.nearRail = nearRail;
    this.options = options;
    this.accounts = accounts;
    this.terms = terms;
  }

  get exchanges(): readonly Exchange[] {
    return this.options.rpc.exchanges();
  }

  /** P7: a NEP-413 signature over `message` (`accountProofMessage`) by this party's own in-memory
   *  full-access key (D-N2: the key never leaves the signer). The line carries the public key;
   *  that it is a FullAccess key of the account is the evidence reader's check. Re-verified
   *  locally before it is returned. */
  async signAccountProof(message: string): Promise<AccountProof> {
    const signer = this.options.signer;
    if (!message.endsWith(`|${this.options.config.pin.caip2}:${signer.accountId}`)) {
      throw new Error("near-rail: refusing to sign an account proof for a message that does not name this handle's own account");
    }
    const proof = await signNep413(signer, message);
    const ok = nep413Verifier.verify({
      message,
      railId: NEAR_RAIL_ID,
      caip2: this.options.config.pin.caip2,
      subject: signer.accountId,
      proof,
    });
    if (!ok) throw new Error("near-rail: the signer's NEP-413 signature does not verify against its own public key");
    return proof;
  }

  /** G3/D-N4: builds and signs the Buyer's `ft_transfer_call` lock (via `NearHtlcRail
   *  .prepareLock`) WITHOUT broadcasting it — `ref` (`0x<hash lock>:<payer>`, near-ref.ts) is already fully known
   *  before this ever touches the network, exactly like `evm-rail.ts`'s own `prepareLock`, never
   *  Bitcoin's own PSBT-building shortcut for the same reason EVM doesn't need one either. */
  async prepareLock(terms: LockTerms, feeBps: number): Promise<PreparedLock> {
    if (feeBps !== 0) {
      throw new Error("near-rail: this deployment has no fee; declared feeBps must be 0");
    }
    const nearTerms = toNearHtlcTerms(terms, this.accounts);
    const { ref, txHash, signedTxBase64 } = await this.nearRail.prepareLock(nearTerms);
    // P8: the transaction hash and the complete signed bytes, for the caller to persist BEFORE `commitLock`.
    return { ref, recovery: { chain: "near", txHash, signedTxBase64 } };
  }

  /**
   * P8-RESUME-SPEC.md "Buyer lock A", NEAR: what became of the ONE lock transaction `prepareLock` signed. Reads, in
   * this order: the access key's final nonce FIRST (a view that only moves forward, so a landing after it cannot be
   * missed by the reads below); then the transaction by its hash (`recoverByTxHash`; a hash the node holds is
   * `landed`, a node still waiting for finality is `pending`); then the lock itself by its payer-keyed ref (a row
   * there is `landed` even if the node has forgotten the transaction); and only if all three show nothing, the
   * nonce: at or past the transaction's own means it can never be accepted, `never-landed`; below it, `pending`
   * (it may still be in flight or may never have been sent; nothing new is signed either way). A typed chain failure
   * of the transaction (`NearTxFailedError`, `NearLockRefusedError`, `NearLockUnknownError`) propagates unchanged.
   */
  async recoverLock(prepared: PreparedLock): Promise<LockRecoveryOutcome> {
    return this.recoverWrite(prepared.ref, prepared.recovery, "lock");
  }

  /** P8-RESUME-SPEC.md "Buyer refund A", NEAR: the refund twin of `recoverLock`, over the handle `refund`'s
   *  `onSigned` recorded. `landed` also when the lock reads `Refunded`. */
  async recoverRefund(ref: string, recovery: LockRecovery): Promise<LockRecoveryOutcome> {
    return this.recoverWrite(ref, recovery, "refund");
  }

  private async recoverWrite(ref: string, recovery: LockRecovery | undefined, kind: "lock" | "refund"): Promise<LockRecoveryOutcome> {
    if (recovery === undefined) {
      throw new RailRecoveryRefusedError("no-handle", ref, "near-htlc needs the transaction hash and signed bytes recorded at prepare time");
    }
    if (recovery.chain !== "near") {
      throw new RailRecoveryRefusedError("handle-mismatch", ref, `a ${recovery.chain} recovery handle was given to the near-htlc rail`);
    }
    const signer = this.options.signer;
    const refParts = parseNearRef(ref);
    if (this.terms.lock !== "hash" || refParts === null || refParts.payer !== signer.accountId || refParts.hashLock !== this.terms.statement) {
      throw new RailRecoveryRefusedError("handle-mismatch", ref, "ref is not 0x<hash lock>:<payer> for this leg's own hash lock and this signer");
    }
    let header: ReturnType<typeof decodeSignedTransactionHeader>;
    try {
      header = decodeSignedTransactionHeader(Uint8Array.from(Buffer.from(recovery.signedTxBase64, "base64")));
    } catch (error) {
      throw new RailRecoveryRefusedError("handle-mismatch", ref, `the recorded signed transaction does not decode: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (header.txHashBase58 !== recovery.txHash) {
      throw new RailRecoveryRefusedError("handle-mismatch", ref, "the recorded signed transaction does not hash to the recorded transaction hash");
    }
    if (header.signerId !== signer.accountId || `ed25519:${base58.encode(header.publicKey.data)}` !== signer.publicKey) {
      throw new RailRecoveryRefusedError("handle-mismatch", ref, "the recorded transaction was not signed by this rail's own account and key");
    }

    const keyNonce = await this.nearRail.finalAccessKeyNonce();
    try {
      const evidence = await this.nearRail.recoverByTxHash(recovery.txHash, signer.accountId, ref);
      if (evidence !== null) return "landed";
    } catch (error) {
      // The node's wait for FINAL ran out: the transaction may still land. Not "unknown", and not an error.
      if (error instanceof NearTimeoutError) return "pending";
      throw error;
    }
    const lock = await this.nearRail.readLock(ref);
    if (lock !== null && (kind === "lock" || lock.status === "Refunded")) return "landed";
    return keyNonce >= header.nonce ? "never-landed" : "pending";
  }

  /** Sends exactly what `prepareLock` most recently built and signed — `NearHtlcRail.commitLock`
   *  itself throws if called without a prior `prepareLock`, so this wrapper adds no behaviour of
   *  its own. */
  async commitLock(): Promise<RailWriteEvidence> {
    const evidence = await this.nearRail.commitLock();
    return toWriteEvidence(evidence);
  }

  /** The Seller's claim — `NearHtlcRail.claim`'s own two preimage-free pre-checks (D-N10: a
   *  fresh `Locked` read still inside its window, and the payee storage-registered on the
   *  token) run before anything is ever signed, and `notAfterMs` is re-checked against fresh
   *  chain time as the LAST read before broadcast (P22-P24-EVM-FIXES-R3.md E4's rule, reused
   *  here) — this wrapper adds no behaviour of its own. */
  async claim(ref: string, secret: string, notAfterMs: number): Promise<RailWriteEvidence> {
    // H12: the adapter checks who the lock pays and its token, amount and times against THIS
    // leg's own terms (the payee is the account line resolved for this leg) before signing.
    const expected = this.accounts.payee === undefined ? undefined : toNearHtlcTerms(this.terms, this.accounts);
    const evidence = await this.nearRail.claim(ref, secret, notAfterMs, expected);
    return toWriteEvidence(evidence);
  }

  /** `NearHtlcRail.refund` itself re-checks (against a fresh `Locked` read) that the caller's
   *  own signer IS the lock's payer and that chain time has reached `refundAfterMs`, before ever
   *  signing — this wrapper adds no behaviour of its own. */
  async refund(ref: string, options?: RailRefundOptions): Promise<RailWriteEvidence> {
    // P8: the signed refund's hash and bytes go to the recorder after signing and before anything is sent.
    const evidence = await this.nearRail.refund(ref, {
      ...(options?.onSigned === undefined ? {} : { onSigned: (signed: { txHash: string; signedTxBase64: string }) => options.onSigned?.({ chain: "near", ...signed }) }),
      ...(options?.onNotBroadcast === undefined
        ? {}
        : { onNotSent: (signed: { txHash: string; signedTxBase64: string }) => options.onNotBroadcast?.({ chain: "near", ...signed }) }),
    });
    return toWriteEvidence(evidence);
  }

  // D-N6: `resendRefundIfDropped` is deliberately not implemented — see this file's own header
  // comment. NEAR has no mempool-drop concept for a refund to be resent against; a caller
  // recovering from a lost RPC reply after a genuine send uses `NearHtlcRail.recoverByTxHash`
  // (by the write's own recorded `txHash`), never a resend of different bytes.

  /** D-N6: the Buyer's own cheap pending-claim check, reused for `checkPendingClaim` exactly as
   *  `NearHtlcRail` itself documents (`Claiming` already carries the preimage the moment
   *  `claim()` is called) — `BuyerFlow.refundLegA` calls this before ever building a refund
   *  against an outpoint someone else may already be claiming. */
  async checkPendingClaim(ref: string, _fromMarker?: RailBlockMarker): Promise<string | null> {
    return this.nearRail.checkPendingClaim(ref);
  }

  /** D-11: capture live, then decide (`src/rails/near-evidence.ts`) — never throws for a
   *  chain-state reason, only a genuine transport failure. */
  async verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult> {
    const nowMs = this.options.clock();
    const nearAccounts: NearAccounts = {
      ...(accounts.payee === undefined ? {} : { payee: accounts.payee }),
      ...(accounts.payer === undefined ? {} : { payer: accounts.payer }),
    };
    // P7 fix pass (F2): a participant's own flow never reads or requires the parties' keys (no
    // `payeeKey`/`payerKey` here, `keyControl: "flow"`): a key rotated or deleted after the lock
    // must not gate the Seller's claim or the Buyer's refund confirmation. The proven lines are still
    // required; the board (replay, watcher, bundle) still requires the key reads.
    const { index, exchanges } = await captureNearLeg(this.options.rpc, this.options.config, terms, nearAccounts, ref, nowMs);
    const bytes = verifiedExchangeBytes(exchanges);
    const capture: NearCapture = { index, bytes };
    return nearEvidence({ terms, config: this.options.config, accounts: nearAccounts, capture, keyControl: "flow" });
  }

  /** How the Buyer learns `s` when the Seller claims on chain without ever posting a reveal
   *  frame — `ref` is `0x<hash lock>:<payer>` (near-ref.ts; unlike Bitcoin, where `ref` is the
   *  funding outpoint). `fromMarker` is accepted for interface symmetry with the
   *  other rails but unused: near-htlc's own `findClaimedPreimage` is a single `get_lock` read,
   *  not a bounded block scan (NEAR has no equivalent of "search N blocks of logs"). */
  async findClaimedPreimage(ref: string, _fromMarker?: RailBlockMarker): Promise<string | null> {
    return this.nearRail.findClaimedPreimage(ref);
  }

  /** The chain's own FINAL block time — never wall-clock; every `claimByMs`/margin guard in the
   *  shared flow judges against this. */
  async chainTimeMs(): Promise<number> {
    return this.nearRail.chainTimeMs();
  }

  /** The FINAL block's own height — this rail's own `RailBlockMarker` (a `number`, unused by
   *  `findClaimedPreimage` above — see its own doc), kept for interface symmetry with the other
   *  rails and for a later evidence reader that might want a "no earlier than" bound. */
  async currentBlockMarker(): Promise<RailBlockMarker> {
    return this.nearRail.currentBlockMarker();
  }

  /** G4: a permissive existence check, read directly against `get_lock` (never through
   *  `near-evidence.ts`'s own strict pipeline, which withholds `rail` the moment ANY field —
   *  including the payee's own storage registration, which has nothing to do with whether THIS
   *  signer genuinely locked this ref — fails to match). Confirms only: a lock exists under
   *  `ref`, its `payer` is this connected handle's own signer, and its `amount` matches this
   *  leg's own frozen terms — enough to answer "did I lock this" without ever vouching for
   *  whether the payout could actually land (that is exactly the question this check is NOT
   *  answering; `verifyLockFinal`'s own `railVerified`/`rail` remain the only source for that). */
  async lockRecorded(ref: string): Promise<{ exists: boolean; reason?: string }> {
    const refParts = parseNearRef(ref);
    if (this.terms.lock !== "hash" || refParts === null || refParts.hashLock !== this.terms.statement) {
      return { exists: false, reason: "near-rail: ref is not 0x<hash lock>:<payer> for this leg's own hash lock (G4)" };
    }
    if (refParts.payer !== this.options.signer.accountId) {
      return { exists: false, reason: "near-rail: the ref's payer is not this signer's own account" };
    }
    const near = new NearRpc(this.options.rpc);
    let resultText: string;
    try {
      const result = await near.callFunction(this.options.config.contract, "get_lock", { hash_lock: refParts.hashLock.slice(2), payer: refParts.payer });
      resultText = result.resultText;
    } catch (error) {
      return { exists: false, reason: `near-rail: lockRecorded could not read get_lock: ${error instanceof Error ? error.message : String(error)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(resultText);
    } catch {
      return { exists: false, reason: "near-rail: get_lock returned an unparseable body" };
    }
    if (parsed === null) return { exists: false, reason: "near-rail: no lock recorded for this hash lock" };
    if (typeof parsed !== "object") return { exists: false, reason: "near-rail: get_lock returned an unrecognised shape" };
    const v = parsed as Record<string, unknown>;
    if (typeof v.payer !== "string" || typeof v.amount !== "string") {
      return { exists: false, reason: "near-rail: get_lock returned an unrecognised shape" };
    }
    if (v.payer !== this.options.signer.accountId) {
      return { exists: false, reason: "near-rail: a lock exists under this hash but its payer is not this signer's own account" };
    }
    let onChainAmount: bigint;
    let expectedAmount: bigint;
    try {
      onChainAmount = BigInt(v.amount);
      expectedAmount = BigInt(this.terms.amount);
    } catch {
      return { exists: false, reason: "near-rail: get_lock returned an unusable amount" };
    }
    if (onChainAmount !== expectedAmount) {
      return { exists: false, reason: "near-rail: a lock exists for this payer but its amount does not match this leg's own terms" };
    }
    return { exists: true };
  }
}

class NearCounterRail implements CounterAssetRail {
  readonly railId: string = NEAR_RAIL_ID;
  readonly caip2: string;
  /** G5: frozen, never a constructor option — see `CounterAssetRail.policy`'s own doc. */
  readonly policy: RailLocalPolicy = NEAR_LOCAL_POLICY;
  /** D-N8: the smallest lockable amount — see `NEAR_AMOUNT_FLOOR`'s own doc. */
  readonly minLockableAmount: string = NEAR_AMOUNT_FLOOR;
  /** D-N8/K3: the one asset id this configured rail ever settles. */
  readonly assetId: string = NEAR_ASSET_ID;
  private readonly options: NearCounterRailOptions;

  constructor(options: NearCounterRailOptions) {
    this.options = options;
    this.caip2 = options.config.pin.caip2;
  }

  /** D-N5: a near-htlc leg posts an *account-id* line, not a pubkey line (mirrors
   *  `evm-rail.ts`'s own single-address `formatAccountLine`, never `btc-rail.ts`'s dual-pubkey
   *  one) — `address` here is this party's own NEAR account id, in the generic
   *  `CounterAssetRail.formatAccountLine(address)` slot every rail shares. */
  formatAccountLine(address: string): string {
    return formatAccountLine({ railId: this.railId, caip2: this.caip2, address });
  }

  /** P7: the proven account line — the NEP-413 proof carries the signer's public key, which the
   *  evidence read later checks is a FullAccess key of the account. */
  async proveAccountLine(input: { address: string; did: string; contract: string; terms: LockTerms }): Promise<string> {
    const message = accountProofMessage({
      did: input.did,
      contract: input.contract,
      railId: this.railId,
      caip2: this.caip2,
      address: input.address,
    });
    const connected = await this.connect(input.terms, {});
    const proof = await connected.signAccountProof(message);
    return formatAccountLine({ railId: this.railId, caip2: this.caip2, address: input.address, proof });
  }

  /** D-N5: resolves each party's account line from the leg's own deal room, bounded (when the
   *  caller supplies `beforeSeq`) to lines posted before the accepted lock frame — the account
   *  line, before the accepted lock only, exactly as the shared G1 rule already applies to the
   *  other rails' own resolution. */
  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts {
    const resolved = resolveAccounts(records, {
      ...input,
      rail: this.railId,
      caip2: this.caip2,
      proof: { mode: "required" }, // P7: only proven lines resolve
    });
    return {
      ...(resolved.payer === undefined ? {} : { payer: resolved.payer }),
      ...(resolved.payee === undefined ? {} : { payee: resolved.payee }),
      ...(resolved.payerKey === undefined ? {} : { payerKey: resolved.payerKey }),
      ...(resolved.payeeKey === undefined ? {} : { payeeKey: resolved.payeeKey }),
    };
  }

  async connect(terms: LockTerms, accounts: RailAccounts): Promise<ConnectedCounterAssetRail> {
    const nearRail = await NearHtlcRail.connect({
      config: this.options.config,
      rpc: this.options.rpc,
      signer: this.options.signer,
      clock: this.options.clock,
    });
    return new ConnectedNearCounterRail(nearRail, this.options, accounts, terms);
  }
}

/** Build the `near-htlc` implementation of `CounterAssetRail` — the only construction path a
 *  flow (or a test harness) needs; `NearCounterRail`/`ConnectedNearCounterRail` are internal. */
export function createNearCounterRail(options: NearCounterRailOptions): CounterAssetRail {
  return new NearCounterRail(options);
}
