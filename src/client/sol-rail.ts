// SPDX-License-Identifier: MIT
//
// P6-SOL-SPEC.md sections 3-5 (stage SB3a): the Solana (`SOL_RAIL_ID`) implementation of `CounterAssetRail`
// (src/client/counter-rail.ts) - thin wrappers around the existing, untouched src/rails/sol-htlc.ts (keyless
// writes through an in-memory `SolSigner`) and src/rails/sol-evidence.ts (the pure, synchronous "capture live,
// then decide" evidence reader). Mirrors src/client/near-rail.ts exactly in shape: like NEAR, a Solana leg
// posts a single account line per party (the wallet address), and the write path's own `ref`
// (`0x<hash lock>:<payer>`, `formatSolRef`) is known before anything is sent, so `prepareLock` needs no network
// call of its own beyond the adapter's own pre-checks.
//
// What is Solana-specific (contracts-sol/README.md "client duties", SB1 finding S1):
//   - `claim` passes the flow's `notAfterMs` through to `SolHtlcRail.claim`, which simulates first (a claim the
//     runtime would refuse is never sent, so a refusal does not publish the secret), refuses a claim that could
//     still land at or after `refund_after_ms` (the landing bound), and confirms Claimed on chain. A claim that
//     lands and FAILS publishes the secret in its instruction data; that is `SolClaimFailedError`
//     (`secretPublic`), and the Seller flow retries at once through `options.retryPublicSecret` (the rail proves
//     on chain that the secret is public before it skips the bounds).
//   - `findClaimedPreimage` / `checkPendingClaim` (S2-1/S2-3) read ONLY the escrow's own state at finalized: the
//     preimage it stores once it is Claimed. A secret leaked by a FAILED claim is deliberately not looked for (it
//     is not a payment; the Buyer claims leg B only once leg A reads Claimed), and no flow ever scans the escrow's
//     history, which anyone can pad past any limit. The whole-history scan stays on `SolHtlcRail` for third-party
//     readers.
//   - `claim` hands every signature it signs to `options.onSigned` BEFORE anything is simulated or sent, and
//     `recoverClaim` resolves one recorded signature (landed, failed with the secret public, never landed) (S2-2).
//   - Before it signs a claim this wrapper reads the escrow and checks who it pays and the amount and times
//     against THIS leg's own terms (NEAR H12's twin), and refuses a claim with no resolved payee.
//
// Design source: flop-contrib/handoff/P6-SOL-SPEC.md sections 3-5; P7-ACCOUNT-PROOF-SPEC.md (proof-of-control
// lines, the `ed25519` scheme); P5-NEAR-FIXES.md / -R2.md (every class mirrored); contracts-sol/README.md.

import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { accountProofMessage, formatAccountLine, formatSolAccountLine, resolveSolAccounts } from "../rails/account-line.js";
import { ed25519Verifier, type AccountProof } from "../rails/account-proof.js";
import { createSolRailRegistry, SOL_RAIL_ID, type CustomRailRegistry } from "../rails/custom-rails.js";
import { verifiedExchangeBytes, type CapturingRpc, type Exchange } from "../rails/rpc-capture.js";
import { captureSolLeg, solEvidence, type SolAccounts, type SolCapture } from "../rails/sol-evidence.js";
import {
  SOL_AMOUNT_FLOOR,
  SOL_ASSET_ID,
  SolClaimFailedError,
  SolHtlcRail,
  parseSolRef,
  type SolHtlcRailOptions,
  type SolClaimOptions,
  type SolHtlcTerms,
  type SolPreparedRecord,
  type SolRailConfig,
  type SolSigner,
  type SolWriteEvidence,
} from "../rails/sol-htlc.js";
import type {
  ConnectedCounterAssetRail,
  CounterAssetRail,
  PreparedLock,
  RailAccounts,
  RailBlockMarker,
  RailClaimOptions,
  RailClaimRecord,
  RailClaimRecovery,
  RailEvidenceResult,
  RailWriteEvidence,
} from "./counter-rail.js";
import { SOL_LOCAL_POLICY, type RailLocalPolicy } from "./policy.js";

export interface SolCounterRailOptions {
  config: SolRailConfig;
  /** The transport every read and write goes through - also this rail's capture sink. */
  rpc: CapturingRpc;
  /** This party's own keyless signer - never a raw key; the concrete in-memory implementation lives only in
   *  `sol-signer-memory.ts` (test and harness code). */
  signer: SolSigner;
  clock: () => number;
  /** Harness-only passthroughs to `SolHtlcRail.connect` (polling cadence and waits; tests inject a fake clock
   *  advance). The claim guard's own timing constants are NOT overridable from here. */
  sleep?: SolHtlcRailOptions["sleep"];
  pollIntervalMs?: number;
  finalityTimeoutMs?: number;
}

/** Only the payee's resolved wallet address is ever required to build a lock: the payer's own identity is the
 *  connected handle's own signer (never resolved externally, as near-rail's). Throws, never guesses, the
 *  moment the payee is missing, so a caller learns this before anything goes near `prepareLock`. */
function toSolHtlcTerms(terms: LockTerms, accounts: RailAccounts): SolHtlcTerms {
  if (terms.lock !== "hash") throw new Error(`sol-rail: only hash locks are supported, got ${terms.lock}`);
  if (accounts.payee === undefined) {
    throw new Error("sol-rail: refusing to proceed - this leg needs the payee's resolved Solana wallet address (its proven account line)");
  }
  return {
    hashLock: terms.statement,
    amount: terms.amount,
    payee: accounts.payee,
    claimByMs: terms.claimByMs,
    refundAfterMs: terms.refundAfterMs,
  };
}

function toWriteEvidence(evidence: SolWriteEvidence): RailWriteEvidence {
  return {
    ref: evidence.ref,
    txHash: evidence.signature,
    // the slot the transaction was included in (this rail's "block height")
    blockHeight: evidence.slot,
    raw: evidence.raw,
    ...(evidence.claimedByAnotherTransaction === true ? { claimedByAnotherTransaction: true as const } : {}),
  };
}

function toClaimRecord(record: SolPreparedRecord): RailClaimRecord {
  return { signature: record.signature, blockhash: record.blockhash, lastValidBlockHeight: record.lastValidBlockHeight };
}

class ConnectedSolCounterRail implements ConnectedCounterAssetRail {
  private readonly solRail: SolHtlcRail;
  private readonly options: SolCounterRailOptions;
  private readonly accounts: RailAccounts;
  /** This leg's own frozen terms, kept for the claim pre-check and `lockRecorded`. */
  private readonly terms: LockTerms;

  constructor(solRail: SolHtlcRail, options: SolCounterRailOptions, accounts: RailAccounts, terms: LockTerms) {
    this.solRail = solRail;
    this.options = options;
    this.accounts = accounts;
    this.terms = terms;
  }

  get exchanges(): readonly Exchange[] {
    return this.options.rpc.exchanges();
  }

  /** P7: an `ed25519` signature over `message` (`accountProofMessage`) by this party's own in-memory wallet
   *  key (the key never leaves the signer). A Solana address IS the public key, so the line needs no separate
   *  key token. Re-verified locally before it is returned; refuses a message that does not name this handle's
   *  own wallet. */
  async signAccountProof(message: string): Promise<AccountProof> {
    const signer = this.options.signer;
    if (!message.endsWith(`|${this.options.config.pin.caip2}:${signer.publicKey}`)) {
      throw new Error("sol-rail: refusing to sign an account proof for a message that does not name this handle's own wallet");
    }
    const signature = await signer.sign(new TextEncoder().encode(message));
    if (signature.length !== 64) throw new Error("sol-rail: the signer did not return a 64-byte ed25519 signature");
    const proof: AccountProof = { scheme: "ed25519", signature: bytesToHex(signature) };
    const ok =
      ed25519.verify(signature, new TextEncoder().encode(message), signer.publicKeyBytes) &&
      ed25519Verifier.verify({ message, railId: SOL_RAIL_ID, caip2: this.options.config.pin.caip2, subject: signer.publicKey, proof });
    if (!ok) throw new Error("sol-rail: the signer's ed25519 signature does not verify against its own public key");
    return proof;
  }

  /** Builds and signs the Buyer's lock WITHOUT broadcasting it (`SolHtlcRail.prepareLock`, which also refuses
   *  an existing escrow for this payer and hash lock, and a missing, frozen or too-small payer token account).
   *  `ref` is `0x<hash lock>:<payer>`, known before the network is touched. */
  async prepareLock(terms: LockTerms, feeBps: number): Promise<PreparedLock> {
    if (feeBps !== 0) throw new Error("sol-rail: this deployment has no fee; declared feeBps must be 0");
    const record = await this.solRail.prepareLock(toSolHtlcTerms(terms, this.accounts));
    return { ref: record.ref };
  }

  /** Sends exactly what `prepareLock` most recently built. Returns evidence only after the escrow at FINALIZED
   *  holds this signer's own terms (the adapter's own chain confirmation); otherwise a typed error. */
  async commitLock(): Promise<RailWriteEvidence> {
    return toWriteEvidence(await this.solRail.commitLock());
  }

  /** The Seller's claim. Before anything is signed this wrapper reads the escrow and checks who it pays and
   *  its mint, amount and times against THIS leg's own terms (the payee is the account line resolved for this
   *  leg); then `SolHtlcRail.claim` runs its own preimage-free pre-checks, the landing bound against
   *  `notAfterMs`, simulate-first and the last-moment guard. `options.retryPublicSecret` is the Seller's retry
   *  of a claim that failed with the secret already public; the adapter proves that on chain. */
  async claim(ref: string, secret: string, notAfterMs: number, options?: RailClaimOptions): Promise<RailWriteEvidence> {
    const parsed = parseSolRef(ref);
    if (parsed === null) throw new Error("sol-rail: ref must be 0x<hash lock>:<payer>");
    if (this.accounts.payee === undefined) {
      throw new Error("sol-rail: refusing to claim - this leg's payee account line has not resolved");
    }
    const expected = toSolHtlcTerms(this.terms, this.accounts);
    if (parsed.hashLock !== expected.hashLock) throw new Error("sol-rail: refusing to claim - the ref's hash lock is not this leg's own");
    const { escrow } = await this.solRail.getEscrow(ref);
    if (escrow === null) throw new Error("sol-rail: refusing to claim - no escrow exists for this ref");
    const problem = escrowTermsProblem(escrow, expected, this.options.config.assets.USDC, this.accounts.payer);
    if (problem !== null) throw new Error(`sol-rail: refusing to claim - ${problem}`);
    const claimOptions: SolClaimOptions = {
      ...(options?.retryPublicSecret === true ? { retryPublicSecret: true } : {}),
      ...(options?.retryPublicSecret === true && options.proofSignature !== undefined ? { proofSignature: options.proofSignature } : {}),
      ...(options?.onNotBroadcast === undefined ? {} : { onNotBroadcast: (record: SolPreparedRecord) => options.onNotBroadcast?.(toClaimRecord(record)) }),
    };
    const onSigned = options?.onSigned === undefined ? undefined : (record: SolPreparedRecord) => options.onSigned?.(toClaimRecord(record));
    const evidence = await this.solRail.claim(ref, secret, notAfterMs, onSigned, claimOptions);
    return toWriteEvidence(evidence);
  }

  /** S2-2: resolves one recorded claim by its signature. `SolPendingError` while undecided; a transport failure
   *  rethrown unchanged. A claim that landed and FAILED is `failed-public` only when that finalized transaction
   *  itself carries a secret that opens this lock (polled until readable), never taken on anyone's word. */
  async recoverClaim(ref: string, record: RailClaimRecord): Promise<RailClaimRecovery> {
    try {
      const evidence = await this.solRail.recoverBySignature({ kind: "claim", ref, signature: record.signature, blockhash: record.blockhash, lastValidBlockHeight: record.lastValidBlockHeight });
      if (evidence === null) return { outcome: "never-landed" };
      return { outcome: "landed", evidence: toWriteEvidence(evidence) };
    } catch (error) {
      if (error instanceof SolClaimFailedError) {
        const carried = await this.solRail.awaitPreimageFromSignature(ref, record.signature);
        if (carried === null) return { outcome: "never-landed" }; // failed, and it published no secret that opens this lock
        return { outcome: "failed-public" };
      }
      throw error;
    }
  }

  /** `SolHtlcRail.refund` itself re-checks (against fresh finalized reads) that the caller's signer IS the
   *  escrow's payer and that chain time has reached `refund_after_ms`, before signing. */
  async refund(ref: string): Promise<RailWriteEvidence> {
    return toWriteEvidence(await this.solRail.refund(ref));
  }

  // `resendRefundIfDropped` is deliberately not implemented: Solana has no mempool a signed transaction can
  // silently drop out of in a way a resend of different bytes would fix; a lost reply is recovered by the
  // recorded signature (`SolHtlcRail.recoverBySignature`), never by a resend.

  /** The Buyer's own pending-claim check, run before a refund is ever built. On Solana (S2-1/S2-3) this reads ONLY the
   *  escrow's own state at finalized: the preimage it stores once it is Claimed. A secret leaked by a FAILED claim
   *  does not mean the Seller was paid (a failed claim leaves no state), so it is deliberately not looked for: the
   *  Buyer claims leg B only after leg A reads Claimed, and never scans history. */
  async checkPendingClaim(ref: string, _fromMarker?: RailBlockMarker): Promise<string | null> {
    return this.solRail.claimedPreimage(ref);
  }

  /** Capture live, then decide (`src/rails/sol-evidence.ts`): one finalized view, never throws for a chain-state
   *  reason, only a genuine transport failure. The payer's and the payee's PROVEN lines (`accounts`) are both
   *  required for a verified lock (P7 fix F1); a participant's own flow needs no other key reads on Solana. */
  async verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult> {
    const nowMs = this.options.clock();
    const solAccounts: SolAccounts = {
      ...(accounts.payee === undefined ? {} : { payee: accounts.payee }),
      ...(accounts.payer === undefined ? {} : { payer: accounts.payer }),
    };
    const { index, exchanges } = await captureSolLeg(this.options.rpc, this.options.config, terms, solAccounts, ref, nowMs);
    const bytes = verifiedExchangeBytes(exchanges);
    const capture: SolCapture = { index, bytes };
    return solEvidence({ terms, config: this.options.config, accounts: solAccounts, capture });
  }

  /** How the Buyer learns `s` (S2-1): the preimage stored in the escrow once it is Claimed at finalized, and nothing
   *  else. No history scan on this rail's flows (the whole-history scan stays on `SolHtlcRail` for third-party
   *  readers): a scan can be padded past any limit, and a failed claim's leak is not a payment. */
  async findClaimedPreimage(ref: string, _fromMarker?: RailBlockMarker): Promise<string | null> {
    return this.solRail.claimedPreimage(ref);
  }

  /** The chain's own FINALIZED slot time - never wall-clock. */
  async chainTimeMs(): Promise<number> {
    return this.solRail.chainTimeMs();
  }

  /** The finalized slot, kept for interface symmetry (`findClaimedPreimage` reads the escrow's own history, not
   *  a bounded block scan). */
  async currentBlockMarker(): Promise<RailBlockMarker> {
    return this.solRail.currentBlockMarker();
  }

  /** A permissive existence check (G4), read directly from the escrow and never through the strict evidence
   *  pipeline (which withholds `rail` when ANY field, such as the payee's token account, fails to match):
   *  confirms only that an escrow exists under `ref`, its payer is this connected handle's own signer and its
   *  amount equals this leg's own terms. It never vouches that the payout could land. */
  async lockRecorded(ref: string): Promise<{ exists: boolean; reason?: string }> {
    const parsed = parseSolRef(ref);
    if (this.terms.lock !== "hash" || parsed === null || parsed.hashLock !== this.terms.statement) {
      return { exists: false, reason: "sol-rail: ref is not 0x<hash lock>:<payer> for this leg's own hash lock (G4)" };
    }
    if (parsed.payer !== this.options.signer.publicKey) {
      return { exists: false, reason: "sol-rail: the ref's payer is not this signer's own wallet" };
    }
    let escrow;
    try {
      escrow = (await this.solRail.getEscrow(ref)).escrow;
    } catch (error) {
      return { exists: false, reason: `sol-rail: lockRecorded could not read the escrow: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (escrow === null) return { exists: false, reason: "sol-rail: no escrow recorded for this ref" };
    // (the escrow's own payer equals the ref's payer: `getEscrow` refuses an escrow whose payer or hash lock
    // differ from the address it was read at, so the check above already names this signer)
    if (escrow.amount !== this.terms.amount) {
      return { exists: false, reason: "sol-rail: an escrow exists for this payer but its amount does not match this leg's own terms" };
    }
    return { exists: true };
  }
}

/** The escrow must pay who THIS leg says, for this leg's mint, amount and times (NEAR H12's twin). `null` when it does. */
function escrowTermsProblem(
  escrow: { payer: string; payee: string; mint: string; amount: string; claimByMs: number; refundAfterMs: number; hashLock: string },
  expected: SolHtlcTerms,
  mint: string,
  payer: string | undefined,
): string | null {
  if (escrow.hashLock !== expected.hashLock) return "the escrow's hash lock is not this leg's own";
  if (escrow.payee !== expected.payee) return "the escrow pays a different wallet than this leg's resolved payee";
  if (escrow.mint !== mint) return "the escrow is for a different mint";
  if (escrow.amount !== expected.amount) return "the escrow's amount differs from this leg's own terms";
  if (escrow.claimByMs !== expected.claimByMs) return "the escrow's claimByMs differs from this leg's own terms";
  if (escrow.refundAfterMs !== expected.refundAfterMs) return "the escrow's refundAfterMs differs from this leg's own terms";
  if (payer !== undefined && escrow.payer !== payer) return "the escrow's payer differs from this leg's resolved payer";
  return null;
}

class SolCounterRail implements CounterAssetRail {
  readonly railId: string = SOL_RAIL_ID;
  readonly caip2: string;
  /** Frozen, never a constructor option - see `CounterAssetRail.policy`. */
  readonly policy: RailLocalPolicy = SOL_LOCAL_POLICY;
  /** One micro-USDC unit (the program refuses 0). */
  readonly minLockableAmount: string = SOL_AMOUNT_FLOOR;
  /** The one asset id this configured rail ever settles. */
  readonly assetId: string = SOL_ASSET_ID;
  /** This rail object's own registry (never process-global): the flows read the rail id through it. */
  readonly railRegistry: CustomRailRegistry = createSolRailRegistry();
  private readonly options: SolCounterRailOptions;

  constructor(options: SolCounterRailOptions) {
    this.options = options;
    this.caip2 = options.config.pin.caip2;
  }

  /** An UNPROVEN Solana account line (it never resolves; P7 requires a proof). Kept for tests. */
  formatAccountLine(address: string): string {
    return formatSolAccountLine({ caip2: this.caip2, address }, this.railRegistry);
  }

  /** P7: the proven account line - the wallet's `ed25519` signature over `accountProofMessage`. Refuses an
   *  address that is not this party's own wallet. */
  async proveAccountLine(input: { address: string; did: string; contract: string; terms: LockTerms }): Promise<string> {
    if (input.address !== this.options.signer.publicKey) {
      throw new Error("sol-rail: refusing to prove an account line for an address that is not this party's own wallet");
    }
    const message = accountProofMessage(
      { did: input.did, contract: input.contract, railId: this.railId, caip2: this.caip2, address: input.address },
      this.railRegistry,
    );
    const connected = await this.connect(input.terms, {});
    const proof = await connected.signAccountProof(message);
    return formatAccountLine({ railId: this.railId, caip2: this.caip2, address: input.address, proof }, this.railRegistry);
  }

  /** Resolves each party's PROVEN wallet from the leg's deal room, bounded (when `beforeSeq` is given) to lines
   *  posted before the accepted lock frame. */
  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts {
    const resolved = resolveSolAccounts(records, { ...input, caip2: this.caip2, railRegistry: this.railRegistry });
    return {
      ...(resolved.payer === undefined ? {} : { payer: resolved.payer }),
      ...(resolved.payee === undefined ? {} : { payee: resolved.payee }),
    };
  }

  async connect(terms: LockTerms, accounts: RailAccounts): Promise<ConnectedCounterAssetRail> {
    const solRail = await SolHtlcRail.connect({
      config: this.options.config,
      rpc: this.options.rpc,
      signer: this.options.signer,
      clock: this.options.clock,
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      ...(this.options.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.options.pollIntervalMs }),
      ...(this.options.finalityTimeoutMs === undefined ? {} : { finalityTimeoutMs: this.options.finalityTimeoutMs }),
    });
    return new ConnectedSolCounterRail(solRail, this.options, accounts, terms);
  }
}

/** Build the Solana (`SOL_RAIL_ID`) implementation of `CounterAssetRail` - the only construction path a flow
 *  (or a test harness) needs; `SolCounterRail` / `ConnectedSolCounterRail` are internal. */
export function createSolCounterRail(options: SolCounterRailOptions): CounterAssetRail {
  return new SolCounterRail(options);
}
