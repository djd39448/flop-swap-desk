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

import type { Exchange } from "../rails/rpc-capture.js";
import type { LockEvidence, RailObservation } from "../types.js";

/** The parties' resolved chain identities for this swap's leg (D-08/§6): a chain address for
 *  `evm-htlc`, a compressed pubkey for `btc-htlc` once its own adapter lands — deliberately
 *  opaque strings here, since only the adapter that produced them knows how to use them. Only
 *  the payee's is required for a lock to verify; the payer's is optional corroboration. */
export interface RailAccounts {
  payer?: string;
  payee?: string;
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
 * One party's live handle on a rail leg — built fresh whenever a flow needs to write or read
 * (never held across a whole swap; `src/rails/evm-htlc.ts`'s `EvmHtlcRail.connect()` already
 * re-checks the pin on every connect, and this interface's `connect()` is that same call,
 * reached through `CounterAssetRail` instead of the concrete adapter). A Bitcoin adapter
 * implements this same shape once it lands (P4-BTC-SPEC.md §7a).
 */
export interface ConnectedCounterAssetRail {
  /** The Buyer's own lock — the only write a Seller's connected handle should never call
   *  (nothing here enforces that; `SellerFlow` simply never calls it, the same discipline its
   *  own comments document). `feeBps` is basis points on this leg's own amount; a deployment
   *  with no fee concept refuses anything but `0`. */
  lock(terms: LockTerms, feeBps: number): Promise<RailWriteEvidence>;
  /** The Seller's claim — `notAfterMs` is this write's own last-moment deadline bound
   *  (re-checked against fresh chain time immediately before broadcast,
   *  P22-P24-EVM-FIXES-R3.md E4); a rail whose claim path could otherwise leak a secret on
   *  simulation alone runs its own preimage-free pre-checks before ever risking it on a wire
   *  (E5) — both already true of `src/rails/evm-htlc.ts`'s `EvmHtlcRail.claim`, which this
   *  rail's own adapter wraps unchanged. */
  claim(ref: string, secret: string, notAfterMs: number): Promise<RailWriteEvidence>;
  refund(ref: string): Promise<RailWriteEvidence>;
  /** D-11: capture live, then decide — never throws for a chain-state reason, only a genuine
   *  transport failure. */
  verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult>;
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

  /** D-08: format this party's own line to post into the leg's deal room. */
  formatAccountLine(address: string): string;

  /** D-08: resolve the parties' chain identities from a leg's deal-room records — only a
   *  record that both verifies and matches this rail id/chain counts; per party, every one of
   *  its own matching lines must agree, or that party's own identity is unresolved (never
   *  "first wins"). Only the payee's is required for a lock to verify. */
  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string },
  ): RailAccounts;

  /** Connect (validates the static config, then a live pin check) and bind the handle to this
   *  swap's own `terms` (so its address/pubkey book can map `terms.payer`/`terms.payee` to the
   *  identities this adapter already knows or `accounts` resolved) — never cached, called fresh
   *  by a flow every time it needs to write or read. */
  connect(terms: LockTerms, accounts: RailAccounts): Promise<ConnectedCounterAssetRail>;
}
