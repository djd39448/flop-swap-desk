// SPDX-License-Identifier: MIT
//
// P5-NEAR-SPEC.md §4/§7a: the `near-htlc` implementation of `CounterAssetRail`
// (src/client/counter-rail.ts) — thin wrappers around the existing, untouched
// src/rails/near-htlc.ts (keyless writes, via an in-memory `NearSigner` — D-N2/D-10) and
// src/rails/near-evidence.ts (the pure, synchronous "capture live, then decide" evidence
// reader). Mirrors src/client/evm-rail.ts's own split exactly, not src/client/btc-rail.ts's:
// like EVM (and unlike Bitcoin's dual-pubkey P2WSH script), a near-htlc leg posts a single
// account-id line per party (D-N5), and the write path's own `ref` (the hash lock) is known
// before any write happens at all (D-N4), so `prepareLock` needs no network call of its own —
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

import { formatAccountLine, resolveAccounts } from "../rails/account-line.js";
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
import { NearRpc } from "../rails/near-rpc.js";
import { verifiedExchangeBytes, type CapturingRpc, type Exchange } from "../rails/rpc-capture.js";
import type {
  ConnectedCounterAssetRail,
  CounterAssetRail,
  PreparedLock,
  RailAccounts,
  RailBlockMarker,
  RailEvidenceResult,
  RailWriteEvidence,
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

  /** G3/D-N4: builds and signs the Buyer's `ft_transfer_call` lock (via `NearHtlcRail
   *  .prepareLock`) WITHOUT broadcasting it — `ref` (the hash lock) is already fully known
   *  before this ever touches the network, exactly like `evm-rail.ts`'s own `prepareLock`, never
   *  Bitcoin's own PSBT-building shortcut for the same reason EVM doesn't need one either. */
  async prepareLock(terms: LockTerms, feeBps: number): Promise<PreparedLock> {
    if (feeBps !== 0) {
      throw new Error("near-rail: this deployment has no fee; declared feeBps must be 0");
    }
    const nearTerms = toNearHtlcTerms(terms, this.accounts);
    const { ref } = await this.nearRail.prepareLock(nearTerms);
    return { ref };
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
    const evidence = await this.nearRail.claim(ref, secret, notAfterMs);
    return toWriteEvidence(evidence);
  }

  /** `NearHtlcRail.refund` itself re-checks (against a fresh `Locked` read) that the caller's
   *  own signer IS the lock's payer and that chain time has reached `refundAfterMs`, before ever
   *  signing — this wrapper adds no behaviour of its own. */
  async refund(ref: string): Promise<RailWriteEvidence> {
    const evidence = await this.nearRail.refund(ref);
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
    const { index, exchanges } = await captureNearLeg(this.options.rpc, this.options.config, terms, nearAccounts, ref, nowMs);
    const bytes = verifiedExchangeBytes(exchanges);
    const capture: NearCapture = { index, bytes };
    return nearEvidence({ terms, config: this.options.config, accounts: nearAccounts, capture });
  }

  /** How the Buyer learns `s` when the Seller claims on chain without ever posting a reveal
   *  frame — `ref` is the hash lock itself (D-N4: unlike Bitcoin, where `ref` is the funding
   *  outpoint, never the hashLock). `fromMarker` is accepted for interface symmetry with the
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
    if (this.terms.lock !== "hash" || ref !== this.terms.statement) {
      return { exists: false, reason: "near-rail: ref does not match this leg's own hash lock (G4)" };
    }
    const near = new NearRpc(this.options.rpc);
    let resultText: string;
    try {
      const result = await near.callFunction(this.options.config.contract, "get_lock", { hash_lock: ref.slice(2) });
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

  /** D-N5: resolves each party's account line from the leg's own deal room, bounded (when the
   *  caller supplies `beforeSeq`) to lines posted before the accepted lock frame — the account
   *  line, before the accepted lock only, exactly as the shared G1 rule already applies to the
   *  other rails' own resolution. */
  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts {
    const resolved = resolveAccounts(records, { ...input, rail: this.railId, caip2: this.caip2 });
    return {
      ...(resolved.payer === undefined ? {} : { payer: resolved.payer }),
      ...(resolved.payee === undefined ? {} : { payee: resolved.payee }),
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
