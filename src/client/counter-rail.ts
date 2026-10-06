// SPDX-License-Identifier: MIT
//
// P4-BTC-SPEC.md §7a ("One client, many rails"): the counter-asset leg's own rail, extracted
// behind one interface so src/client/seller.ts and src/client/buyer.ts never import a specific
// rail's adapter directly. Every safety property the three EVM review rounds put in place —
// authenticated records, recomputed contract ids, the right counterparty/statement/amount, the
// per-swap latches, record-before-send, the last-moment claim guards judged against
// max(chain time, clock), a write's own notAfterMs bound, a claim path that never risks the
// real secret before it must — lives in the shared flow (seller.ts/buyer.ts) or inside a
// specific adapter's own write path (src/client/evm-rail.ts wraps src/rails/evm-htlc.ts's
// EvmHtlcRail, whose claim() already runs P22-P24-EVM-FIXES-R3.md E5's two preimage-free
// pre-checks before ever broadcasting). This file only fixes the *shape* every rail must
// present; it never re-implements any of those checks itself.
//
// P4-BTC-SPEC.md §7a: "no behaviour change" for EVM — src/client/evm-rail.ts's adapter is a
// thin wrapper around the existing, untouched src/rails/evm-htlc.ts; every RPC call this build
// makes, in the same order, against the same captured exchanges, is unchanged by this file's
// existence. A rail whose own write evidence looks nothing like an EVM event log (Bitcoin: a
// UTXO outpoint, no `event` name) will need `RailWriteEvidence` generalized when its own
// adapter lands (P4-BTC-SPEC.md §4/§7) — today's shape mirrors evm-htlc.ts's `WriteEvidence`
// unchanged, since EVM is the only adapter that exists yet.
//
// Design source: flop-contrib/handoff/P4-BTC-SPEC.md §7a; P22-P24-EVM-FIXES.md, -R2.md, -R3.md
// (every safety property named above).

import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import type { AccountProof } from "../rails/account-proof.js";
import type { CustomRailRegistry } from "../rails/custom-rails.js";
import type { Exchange } from "../rails/rpc-capture.js";
import type { LockEvidence, RailObservation } from "../types.js";
import type { RailLocalPolicy } from "./policy.js";

/** The parties' resolved chain identities for this swap's leg (D-08/§6): a chain address for
 *  `evm-htlc`, a compressed pubkey for `btc-htlc` once its own adapter lands — deliberately
 *  opaque strings here, since only the adapter that produced them knows how to use them. Only
 *  the payee's is required for a lock to verify; the payer's is optional corroboration. */
export interface RailAccounts {
  payer?: string;
  payee?: string;
  /** P7, `near-htlc` only: the public key each party's proven account line carries. The rail's
   *  evidence read must show it is a FullAccess key of that account (the proof alone shows only
   *  that the key signed). Absent for every other rail and for the pre-proof fold. */
  payerKey?: string;
  payeeKey?: string;
}

/**
 * What one `lock`/`claim`/`refund` write produced, bound to whatever finality-relevant
 * identity the underlying chain gives a write. `raw` lists (in call order) the response sha256s
 * of every exchange that produced it (P22-P24-EVM-SPEC.md §5). `ref` is the only field every
 * rail fills in: an EVM write's own hashLock (§2.2 point 2) today, a Bitcoin write's own
 * outpoint (P4-BTC-SPEC.md §4) once that adapter lands.
 *
 * P4-BTC-SPEC.md §7a: this shape was EVM's alone before the Bitcoin adapter landed (see this
 * file's own earlier header comment, which predicted exactly this) — an EVM write has an
 * on-chain *event log* (`event`/`txHash`/`blockNumber`/`logIndex`), while a Bitcoin write has a
 * UTXO's own transaction id and (once read back) a confirming block (`txid`/`blockHeight`); a
 * fresh write's `blockHash`/`blockHeight` are `null` immediately after broadcast for Bitcoin
 * (populating them is the pure evidence reader's job, `src/rails/btc-evidence.ts`, never the
 * write path's own). Every one of these rail-specific fields is therefore optional here, so
 * `ConnectedEvmCounterRail` (all EVM fields, always present) and `ConnectedBtcCounterRail`
 * (`ref`/`raw`/`txid`/`blockHeight`, `event`/`txHash`/`blockNumber`/`logIndex` absent) both
 * satisfy this one interface without either rail's own concrete `WriteEvidence` type changing
 * shape.
 */
export interface RailWriteEvidence {
  ref: string;
  /** EVM only (`src/rails/evm-htlc.ts`'s `WriteEvidence.event`) — absent for a rail with no
   *  on-chain event-log concept. */
  event?: "Locked" | "Claimed" | "Refunded";
  txHash?: string;
  blockNumber?: bigint;
  blockHash?: string | null;
  logIndex?: number;
  raw: string[];
  /** Bitcoin only (`src/rails/btc-htlc.ts`'s `WriteEvidence.txid`) — this write's own
   *  transaction id (the funding tx for `fund`, the spending tx for `claim`/`refund`). */
  txid?: string;
  /** Bitcoin only — `null` immediately after broadcast (a regtest node never auto-mines); the
   *  evidence reader, not this write, is what later confirms a height. */
  blockHeight?: number | null;
  /** P4-BTC-FIXES-R2.md R2-1: a Bitcoin REFUND's own exact signed transaction bytes (hex) —
   *  `src/rails/btc-htlc.ts`'s `WriteEvidence.rawTx` — kept so a later retry can re-send the
   *  IDENTICAL bytes if they drop out of the mempool without confirming
   *  (`ConnectedCounterAssetRail.resendRefundIfDropped`), never rebuilding or re-signing. Absent
   *  for every other write (fund/claim never need a retry-resend path; EVM has no such concept). */
  rawTx?: string;
  /** Solana only (SOL-A4): a claim whose own transaction FAILED, but the escrow is Claimed with this claim's
   *  own preimage because another transaction landed first; the payee was paid and nothing needs retrying. */
  claimedByAnotherTransaction?: true;
}

/** D-11's "capture live, then decide" contract (mirrors `src/rails/evm-evidence.ts`'s
 *  `EvmEvidenceResult` exactly): `lock` is the rail's own fail-closed verdict at the finalized
 *  view, `rail` an optional terminal-side observation. */
export interface RailEvidenceResult {
  lock: LockEvidence;
  rail?: RailObservation;
}

/** An opaque "where the chain is now" marker, suitable as `findClaimedPreimage`'s own bounded
 *  search start (an EVM block number today; a Bitcoin block height once that adapter lands) —
 *  a flow only ever stores and replays this value, never inspects it. */
export type RailBlockMarker = unknown;

/**
 * SB3a, Solana only: `retryPublicSecret` asks the rail to retry a claim whose secret is ALREADY public (an
 * earlier claim landed and failed, so the preimage sits in that transaction's instruction data). The rail
 * itself proves on chain that this secret is public before it skips the deadline and landing bounds (they
 * protect a still-private secret and would only stop the Seller from being paid); a rail with no such concept
 * ignores the option. The flow passes it only for a rail that has one, and only after the chain showed the
 * secret public.
 */
export interface RailClaimOptions {
  retryPublicSecret?: boolean;
  /** Solana only (SOL-C1): the signature of this flow's own failed claim, the retry's proof of a public secret. */
  proofSignature?: string;
  /** Solana only (R3-2): how many earlier claims of this flow never landed; each raises the priority fee. */
  priorityFeeAttempt?: number;
  /** Solana only (S2-2): called with the claim's signature and `lastValidBlockHeight` once it is signed and BEFORE
   *  anything is simulated or sent, so the caller can latch it and resolve it later (a lost reply, a crash). */
  onSigned?: (record: RailClaimRecord) => void | Promise<void>;
  /** Solana only (S2-2): called when a recorded claim was provably never handed to the network (nothing to resolve). */
  onNotBroadcast?: (record: RailClaimRecord) => void | Promise<void>;
}

/** Solana only (S2-2): what a Seller records about one claim it signed, enough to resolve it later by signature. */
export interface RailClaimRecord {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Solana only (R3-4): the slot the blockhash was read at (a node with no history back to it cannot prove "never landed"). */
  signedSlot?: number;
}

/** Solana only (S2-2): what became of one recorded claim. `landed`: it (or another transaction with this secret)
 *  claimed the lock; `failed-public`: it landed and FAILED, so the secret is public and `record.signature` proves it;
 *  `never-landed`: its blockhash expired with no status, it can never land. A claim that is not decided yet is a
 *  thrown `SolPendingError` (check again shortly); never one of these. */
export type RailClaimRecovery =
  | { outcome: "landed"; evidence: RailWriteEvidence }
  | { outcome: "failed-public" }
  | { outcome: "never-landed" };

/**
 * P4-BTC-FIXES.md G3 (client half of H2)/G2's own "record before sending" rule, generalised
 * over every rail: everything a caller needs to RECORD, before ever risking a broadcast that
 * might succeed on the wire without this flow ever learning so (a flaky read on the response,
 * a crash between `testmempoolaccept` and `sendrawtransaction`'s own reply). `ref` is already
 * knowable before broadcast for every rail this build has: a Bitcoin outpoint hashes the
 * PREPARED transaction's own bytes (never assigned by the network), and an EVM write's own ref
 * is simply the hashLock, known before ANY write happens at all (P22-P24-EVM-FIXES-R3.md E3).
 * `commitLock()` is the only way to actually broadcast what this prepared.
 */
export interface PreparedLock {
  ref: string;
  /**
   * P8-RESUME-SPEC.md (rule 1, "durable before visible"): the rail's own handle on the transaction `prepareLock`
   * built and signed, which a caller persists together with `ref` BEFORE `commitLock()` and hands back to
   * `recoverLock` after a crash. Absent for a rail that needs none (`evm-htlc`: the ref IS the hash lock, and a
   * repeated lock is refused by the contract on a duplicate hash lock).
   */
  recovery?: LockRecovery;
}

/**
 * P8-RESUME-SPEC.md: what a caller must keep about ONE signed transaction to find out later whether it landed,
 * one tagged shape per rail (`chain` names the rail family; it is not the canonical rail id). Plain JSON data, no
 * secret in it: a signed transaction is public once broadcast, and none of these shapes carries a key.
 *   - `btc`: the funding (or refund) transaction's id and its complete signed bytes, hex. Re-sending the identical
 *     bytes is always safe (same txid), and the txid is what the node is asked about.
 *   - `near`: the transaction hash (base58) and the complete signed transaction (base64). The hash is the lookup key
 *     (`EXPERIMENTAL_tx_status`); the bytes carry the nonce that decides whether the transaction can still land.
 *   - `sol`: the transaction signature (base58), the blockhash it was signed against, the last block height at which
 *     that blockhash is still valid, and the slot it was read at (a node with no ledger back to it cannot prove
 *     "never landed", see `RailClaimRecord`).
 */
export type LockRecovery =
  | { chain: "btc"; txid: string; rawTx: string }
  | { chain: "near"; txHash: string; signedTxBase64: string }
  | { chain: "sol"; signature: string; blockhash: string; lastValidBlockHeight: number; signedSlot?: number };

/**
 * P8-RESUME-SPEC.md: what the chain says about a recorded transaction (a lock via `recoverLock`, a refund via
 * `recoverRefund`). Reading and re-sending are two separate calls (review round 1, R1-01): `recoverLock` and
 * `recoverRefund` only READ, they never send anything, so a caller can run its own deadline and clock guards (rule 4)
 * between "what became of it" and "send it again".
 *   - `landed`: it is on chain (the caller then reads the evidence it needs, `verifyLockFinal` or `lockRecorded`).
 *   - `pending`: not decided yet, nothing new may be signed or sent, ask again later.
 *   - `never-landed`: the rail can PROVE the transaction can no longer land (Solana: the blockhash expired with no
 *     status and the node's ledger covers the signing slot; NEAR: the access key's nonce moved to or past the
 *     transaction's and, three blocks later, no lock shows; Bitcoin refund: the funding output is spent by another
 *     transaction), so a fresh one may be built. EVM answers it for "no lock is visible", see `EvmHtlcRail.readLock`.
 *   - `unknown`: the node does not know the transaction and the rail cannot prove it dead (Bitcoin: the txid is
 *     unknown, a signed transaction stays valid as long as its inputs are unspent; NEAR: unknown to the node, no lock
 *     row, nonce not yet past). Nothing new may be SIGNED. The caller may re-send the IDENTICAL persisted bytes with
 *     `resendLock` / `resendRefund` once its own guards allow a new outward action; that call is what settles it.
 */
export type LockRecoveryOutcome = "landed" | "never-landed" | "pending" | "unknown";

/**
 * R1-01 (part 2): what `resendLock` / `resendRefund` answer after sending the identical persisted bytes once (or after
 * finding there was nothing left to send): `landed` (accepted, or already known), `never-landed` (the rail proved the
 * bytes can no longer land: NEAR's `Expired` or invalid-nonce answer, after a re-read of the lock row three blocks
 * later; Bitcoin refund: the funding output is spent by another transaction), or `pending` (the send's own outcome is
 * not known: a transport failure, or a node still waiting for finality; nothing was signed, ask again later). A
 * Bitcoin funding the node refuses is a thrown `RailRecoveryRefusedError("rebroadcast-refused")`, never an outcome.
 */
export type LockResendOutcome = "landed" | "never-landed" | "pending";

/**
 * P8-RESUME-SPEC.md: the recorder a refund accepts, the twin of the Solana claim's `onSigned` / `onNotBroadcast`
 * (`RailClaimOptions`). `onSigned` receives the signed refund's recovery handle once it is signed and BEFORE it is
 * sent (awaited), so a caller can persist it and resolve it later with `recoverRefund`; `onNotBroadcast` receives
 * the same handle when the refund was provably never handed to the network (the caller may drop its record). A rail
 * that can give no handle before the send (`evm-htlc`: the node signs and sends in one JSON-RPC call) never calls
 * either.
 */
export interface RailRefundOptions {
  onSigned?: (recovery: LockRecovery) => void | Promise<void>;
  onNotBroadcast?: (recovery: LockRecovery) => void | Promise<void>;
}

/** Why a recovery refused to proceed. `no-handle`: the rail needs a recovery handle and the record has none.
 *  `handle-mismatch`: the handle is for another rail, or does not belong to this ref or is internally inconsistent.
 *  `rebroadcast-refused` (Bitcoin, thrown by `resendLock`): the node refused the persisted signed bytes (inputs gone, a
 *  conflicting spend, a policy rejection): a second funding must NOT be built automatically (it could double-spend the
 *  swap's inputs or create a second outpoint), so a person decides. `lock-conflict` (EVM): a lock exists under this hash lock
 *  that is not this party's own, so this party's lock can never land. */
export type RailRecoveryCode = "no-handle" | "handle-mismatch" | "rebroadcast-refused" | "lock-conflict";

/** A typed refusal from `recoverLock` / `recoverRefund`: the flow stops and a person decides. Never retried. */
export class RailRecoveryRefusedError extends Error {
  readonly code: RailRecoveryCode;
  readonly ref: string;
  constructor(code: RailRecoveryCode, ref: string, detail: string) {
    super(`rail recovery refused (${code}) for ${ref}: ${detail}`);
    this.name = "RailRecoveryRefusedError";
    this.code = code;
    this.ref = ref;
  }
}

/**
 * One party's live handle on a rail leg — built fresh whenever a flow needs to write or read
 * (never held across a whole swap; `src/rails/evm-htlc.ts`'s `EvmHtlcRail.connect()` already
 * re-checks the pin on every connect, and this interface's `connect()` is that same call,
 * reached through `CounterAssetRail` instead of the concrete adapter). A Bitcoin adapter
 * implements this same shape once it lands (P4-BTC-SPEC.md §7a).
 */
export interface ConnectedCounterAssetRail {
  /**
   * G3/G2: build (and, for a rail that needs one, sign) the Buyer's own lock transaction
   * WITHOUT broadcasting it, returning enough (`PreparedLock.ref`) to record before ever
   * touching a network call that could succeed without this flow ever finding out —
   * `commitLock()` is the only way to actually send it. The only write a Seller's connected
   * handle should never call (nothing here enforces that; `SellerFlow` simply never calls it,
   * the same discipline its own comments document). `feeBps` is basis points on this leg's own
   * amount; a deployment with no fee concept refuses anything but `0`.
   */
  prepareLock(terms: LockTerms, feeBps: number): Promise<PreparedLock>;
  /**
   * P7 (handoff/P7-ACCOUNT-PROOF-SPEC.md): sign `message` (the exact string `accountProofMessage` /
   * `pubkeyProofMessage` builds for this party's own account line) with this party's chain key and
   * return the proof the line carries. Keyless where the chain allows (EVM: the node signs over
   * RPC; Bitcoin: the node wallet signs a BIP-322 PSBT; NEAR: the in-memory signer, D-N2). Refuses
   * a message that does not name this handle's own account or key.
   */
  signAccountProof(message: string): Promise<AccountProof>;
  /** Broadcasts whatever `prepareLock` most recently prepared on this same connected handle;
   *  throws if `prepareLock` was never called first. */
  commitLock(): Promise<RailWriteEvidence>;
  /** The Seller's claim — `notAfterMs` is this write's own last-moment deadline bound
   *  (re-checked against fresh chain time immediately before broadcast,
   *  P22-P24-EVM-FIXES-R3.md E4); a rail whose claim path could otherwise leak a secret on
   *  simulation alone runs its own preimage-free pre-checks before ever risking it on a wire
   *  (E5) — both already true of `src/rails/evm-htlc.ts`'s `EvmHtlcRail.claim`, which this
   *  rail's own adapter wraps unchanged. */
  claim(ref: string, secret: string, notAfterMs: number, options?: RailClaimOptions): Promise<RailWriteEvidence>;
  /**
   * The Buyer's refund. `options.onSigned` receives the signed refund's recovery handle BEFORE it is sent (P8:
   * persisted, so a restart can resolve it with `recoverRefund` instead of building a second refund);
   * `options.onNotBroadcast` is the twin for a refund provably never handed to the network. Both are optional and a
   * rail that can give no pre-send handle never calls them. No behaviour change for a caller that passes no options.
   */
  refund(ref: string, options?: RailRefundOptions): Promise<RailWriteEvidence>;
  /**
   * P8-RESUME-SPEC.md "Buyer lock A": after a crash between `prepareLock` and the end of `commitLock`, find out from
   * the chain what became of the ONE transaction `prepareLock` signed, using the persisted `PreparedLock` (`ref` plus
   * `recovery`). READ-ONLY (R1-01): it never signs anything and never sends anything, on any rail. Per rail: Bitcoin
   * asks the node about the funding txid (`landed` when the node knows it, else `unknown`); NEAR asks by transaction
   * hash, then by the lock itself, then compares the access key's nonce (`never-landed` only when the nonce has moved
   * to or past the transaction's and a re-read three blocks later still shows no lock; `unknown` while the nonce is
   * below it); Solana asks by signature (`never-landed` only when the blockhash expired and the node's ledger covers
   * the signing slot); EVM reads the lock by its hash lock. A typed chain failure of the transaction itself
   * (`NearTxFailedError`, `SolLockRefusedError`, ...) propagates unchanged. A caller runs its own deadline guards
   * before any NEW outward action that follows (`resendLock`, a fresh `prepareLock`; rule 4); recognising a lock that
   * already landed is not one.
   */
  recoverLock(prepared: PreparedLock): Promise<LockRecoveryOutcome>;
  /**
   * R1-01 (part 2): re-send the IDENTICAL persisted bytes of the lock `prepared` names, once, after `recoverLock`
   * answered `unknown`. Never signs anything new, and can never move funds twice (identical bytes have one hash and
   * one nonce). Bitcoin re-broadcasts the funding (`rebroadcastFunding`); NEAR sends the persisted
   * `signedTxBase64`. It first re-reads (a transaction that landed meanwhile is answered `landed` without a send).
   * Optional: a rail that never answers `unknown` (`evm-htlc`, `sol-htlc`) omits it. The caller applies its rule-4
   * guards (deadline, leg-B note, chain clock) BEFORE calling this.
   */
  resendLock?(prepared: PreparedLock): Promise<LockResendOutcome>;
  /** P8-RESUME-SPEC.md "Buyer refund A": the refund twin of `recoverLock`, resolving a refund recorded through
   *  `refund`'s `onSigned`. Optional: `evm-htlc` omits it (its refund leaves no handle before the send; a repeated
   *  refund is recognised from the lock's own state). READ-ONLY, like `recoverLock`: the identical recorded bytes are
   *  re-sent only by `resendRefund`. */
  recoverRefund?(ref: string, recovery: LockRecovery): Promise<LockRecoveryOutcome>;
  /** R1-01 (part 2): the refund twin of `resendLock`: re-send the IDENTICAL recorded refund bytes once, after
   *  `recoverRefund` answered `unknown`. Bitcoin re-sends only while the funding output is still unspent by anyone
   *  (the existing `resendRefundIfDropped` rule); NEAR sends the persisted bytes only while the lock still reads
   *  `Locked`. Never signs anything new. Optional, like `recoverRefund`. */
  resendRefund?(ref: string, recovery: LockRecovery): Promise<LockResendOutcome>;
  /** Solana only (S2-2): resolve one recorded claim by its signature (never by a scan or a resend). Optional: a rail
   *  with no such concept omits it. */
  recoverClaim?(ref: string, record: RailClaimRecord): Promise<RailClaimRecovery>;
  /** P4-BTC-FIXES-R2.md R2-1: on a refund retry (this connected handle's own `refund()` already
   *  broadcast once), re-check the chain and re-send `priorEvidence`'s own EXACT bytes
   *  (`priorEvidence.rawTx`) if they have genuinely dropped (not in the mempool, not confirmed)
   *  while the escrow remains unspent by anyone — idempotent (identical bytes reproduce the
   *  identical txid), and never rebuilds or re-signs. Optional: a rail with no such concept
   *  (today: `evm-htlc` — no behaviour change for EVM) simply omits it; `BuyerFlow.refundLegA`
   *  only calls this when the connected handle actually implements it, and otherwise treats
   *  `priorEvidence` as still the live truth. */
  resendRefundIfDropped?(ref: string, priorEvidence: RailWriteEvidence): Promise<RailWriteEvidence>;
  /** P4-BTC-FIXES-R3.md K2: read the outpoint's own present state — including a claim that has
   *  only been broadcast, not yet mined (K1) — BEFORE a caller ever builds a refund against it.
   *  Returns the learned secret once the outpoint has been (or is being) claimed, `null` when it
   *  has not. Optional, like `resendRefundIfDropped`: a rail with no such concept (`evm-htlc`,
   *  whose own `refund()` already simulates before ever broadcasting and so discovers a lost race
   *  on its own, with no behaviour change here) simply omits it — `BuyerFlow.refundLegA` only
   *  calls this when the connected handle actually implements it. */
  checkPendingClaim?(ref: string, fromMarker?: RailBlockMarker): Promise<string | null>;
  /** D-11: capture live, then decide — never throws for a chain-state reason, only a genuine
   *  transport failure. */
  verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult>;
  /** P5-NEAR-FIXES.md G4: a cheap, PERMISSIVE existence check — does a lock for this ref exist on
   *  chain at all, owned by this connected handle's own signer/payer, with terms matching what
   *  this handle was `connect()`-ed with? Unlike `verifyLockFinal`, this never withholds an
   *  answer merely because some OTHER field the strict evidence pipeline also checks (near-htlc:
   *  the payee's own storage registration) fails to match — it exists specifically for
   *  `reconcileLockA` to tell "I did lock this, even though the strict reader can't yet fully
   *  vouch for it" apart from "nothing is there at all". Optional: a rail with no cheaper way to
   *  answer this than the strict reader already gives (`evm-htlc`, `btc-htlc`: no behaviour
   *  change for either) simply omits it. */
  lockRecorded?(ref: string): Promise<{ exists: boolean; reason?: string }>;
  /** R2-17: wait a short while in the rail's OWN time base (its injected `sleep`, which a test harness moves its simulated chain with,
   *  and a real deployment backs with a timer), so a lagging member of a load-balanced endpoint can catch up before the caller reads the
   *  chain ONCE more. `BuyerFlow.recoverLockA` calls it between a `never-landed` answer and the read that decides whether a lock exists
   *  after all. Optional: a rail with no injected sleep (`evm-htlc`, `btc-htlc`) omits it and the caller reads again at once. */
  settleDelay?(): Promise<void>;
  /** How the Buyer learns `s` when the Seller claims on chain without ever posting a reveal
   *  frame — a bounded search from `fromMarker` (omitted: the adapter's own genesis default). */
  findClaimedPreimage(ref: string, fromMarker?: RailBlockMarker): Promise<string | null>;
  /** The chain's own current time (never wall-clock) — every `claimByMs`/margin guard in the
   *  shared flow judges against this, never `Date.now()` or an injected `clock()` alone. */
  chainTimeMs(): Promise<number>;
  /** A snapshot of "where the chain is now", suitable as a later `findClaimedPreimage`'s own
   *  `fromMarker` — taken right before a lock write (P22-P24-EVM-FIXES-R3.md E3: recorded
   *  before the write is even sent), so a bounded search can never start after it. */
  currentBlockMarker(): Promise<RailBlockMarker>;
  /** Every exchange this connected handle has produced so far, in call order (B5: a flow drains
   *  this into its own write-evidence log right after a write it cares about, the same
   *  before/after slicing pattern `EvmHtlcRail`'s own write methods already use internally). */
  readonly exchanges: readonly Exchange[];
}

/**
 * A party's own binding to one counter-asset rail — config, transport, account and clock baked
 * in once (mirrors the pre-stage `SellerFlowOptions`/`BuyerFlowOptions` fields, now behind one
 * field instead of several). `railId`/`caip2` back the D-08 account-line form; `connect()` is
 * called fresh by a flow every time it needs to write or read, exactly the way
 * `EvmHtlcRail.connect()` was called directly before this stage — never cached across a whole
 * swap.
 */
export interface CounterAssetRail {
  /** Canonical tclk rail id this adapter speaks for (e.g. `"evm-htlc"`) — tags every D-08 line
   *  this adapter builds and every account resolution it performs. */
  readonly railId: string;
  /** This rail's own pinned chain id, CAIP-2 form (e.g. `"eip155:31337"`) — embedded in every
   *  D-08 line this adapter's `formatAccountLine` builds. */
  readonly caip2: string;
  /**
   * R1-05: which deployment of this rail the leg runs on, as one stable ASCII string a record stores at its birth and
   * `resume` compares. Two rails that talk to different deployments must differ, and one rail must give the same
   * value every time it is built from the same config (it is derived from the config alone: no network call, no clock).
   * EVM: the escrow contract and the token addresses. NEAR: the HTLC contract account, the token account and the
   * contract code hash. Solana: the program id and the mint. Bitcoin: the network name and the genesis hash prefix.
   * Why it matters: `evm-htlc` finds a lock by its hash lock at the configured contract, so a runner restarted against
   * another contract would read "no row" as "never landed" and lock again, while the first lock can still be claimed.
   */
  readonly deploymentId: string;

  /** D-08: format this party's own line to post into the leg's deal room, WITHOUT a proof. Such a
   *  line never resolves (P7: every resolver requires a proof); the flows post
   *  `proveAccountLine`'s line instead. Kept for tests that need an unproven line. */
  formatAccountLine(address: string): string;

  /** P7 (handoff/P7-ACCOUNT-PROOF-SPEC.md): this party's own PROVEN line for the leg's deal room —
   *  the message that binds `did` (the record's sender) and `contract` (the leg's tclk contract) to
   *  `address` is signed by this party's own chain key through a connected handle
   *  (`signAccountProof`) and the line carries the proof. `terms` only lets the rail connect; it
   *  never changes what is signed. Refuses an `address` that is not this party's own. */
  proveAccountLine(input: { address: string; did: string; contract: string; terms: LockTerms }): Promise<string>;

  /** R3-7 (Solana only): the chain's own finalized clock, readable without any swap's terms or accounts, so a flow can
   *  refuse to start when the chain and the local clock disagree by more than `SOL_CHAIN_CLOCK_SKEW_MS`. A rail that
   *  leaves it out is never checked (EVM, Bitcoin and NEAR behave exactly as before). */
  chainClockMs?(): Promise<number>;
  /** R3-7: the bound the flows apply to `chainClockMs` (default `SOL_CHAIN_CLOCK_SKEW_MS`); a harness-only override. */
  readonly maxChainClockSkewMs?: number;

  /** D-08: resolve the parties' chain identities from a leg's deal-room records — only a
   *  record that both verifies and matches this rail id/chain counts; per party, every one of
   *  its own matching lines must agree, or that party's own identity is unresolved (never
   *  "first wins"). Only the payee's is required for a lock to verify. */
  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts;

  /** Connect (validates the static config, then a live pin check) and bind the handle to this
   *  swap's own `terms` (so its address/pubkey book can map `terms.payer`/`terms.payee` to the
   *  identities this adapter already knows or `accounts` resolved) — never cached, called fresh
   *  by a flow every time it needs to write or read. */
  connect(terms: LockTerms, accounts: RailAccounts): Promise<ConnectedCounterAssetRail>;

  /** P4-BTC-FIXES.md G5: this rail's own frozen local deadline policy (`EVM_LOCAL_POLICY` /
   *  `BTC_LOCAL_POLICY`, src/client/policy.ts) — the only source `BuyerFlow`/`SellerFlow` ever
   *  read one from (the flows' own `options.policy` constructor field is gone); a flow can
   *  therefore never run one rail's leg under another rail's deadline numbers, whatever a caller
   *  passes in. */
  readonly policy: RailLocalPolicy;

  /** P4-BTC-FIXES.md G6: the smallest `terms.amount` (decimal string, this rail's own smallest
   *  unit — satoshis for `btc-htlc`) this rail will ever lock — below the fixed spend fee plus
   *  the worst-case dust limit, a claim or refund's own single output could never itself be a
   *  standard, relayable transaction. `undefined` for a rail with no such floor (`evm-htlc`: an
   *  ERC20 balance has no dust concept). `BuyerFlow.bid`/`lockLegA` and `SellerFlow.acceptLegA`
   *  refuse an amount below this before ever touching the network. */
  readonly minLockableAmount?: string;

  /** P4-BTC-FIXES-R3.md K3: the one asset id this rail ever settles (`"BTC"` for `btc-htlc`) —
   *  `undefined` for a rail that settles more than one (`evm-htlc`'s own asset book already fails
   *  closed on an unconfigured asset at write time, so it declares no single id here: no
   *  behaviour change for EVM). `BuyerFlow.bid`/`lockLegA` and `SellerFlow.acceptLegA` refuse an
   *  offer whose declared asset differs from this, before ever touching the network, whenever a
   *  rail declares one. */
  readonly assetId?: string;

  /** SB3a: this rail's OWN custom rail registry (`src/rails/custom-rails.ts`), when its rail id is an
   *  owner-namespaced custom id that tclk's closed registry does not know (the Solana leg). Every frame the
   *  flows emit for this rail (the leg A offer, the lock and receipt frames) and every orientation check
   *  reads its rail ids through it, so the id is admitted per rail object, never process-global. `undefined`
   *  for every rail tclk already knows: no behaviour change for EVM, Bitcoin or NEAR. */
  readonly railRegistry?: CustomRailRegistry;
}

/** P4-BTC-FIXES.md G6: `true` iff `amount` (a decimal-integer string, this rail's own smallest
 *  unit) is below `rail.minLockableAmount` — `false` for a rail with no floor. Shared by
 *  `BuyerFlow.bid`/`lockLegA` and `SellerFlow.acceptLegA` so the three call sites can never
 *  drift on what "below the floor" means. */
export function belowMinLockable(rail: CounterAssetRail, amount: string): boolean {
  return rail.minLockableAmount !== undefined && BigInt(amount) < BigInt(rail.minLockableAmount);
}
