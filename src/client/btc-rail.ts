// SPDX-License-Identifier: MIT
//
// P4-BTC-SPEC.md §7a: the `btc-htlc` implementation of `CounterAssetRail`
// (src/client/counter-rail.ts) — thin wrappers around the existing, untouched
// src/rails/btc-htlc.ts (keyless writes, via a bitcoind wallet's own `walletprocesspsbt`) and
// src/rails/btc-evidence.ts (the pure, synchronous "capture live, then decide" evidence
// reader). Mirrors src/client/evm-rail.ts's own split exactly: one class implements
// `CounterAssetRail` (config + this party's own wallet/key/destination baked in once), whose
// `connect()` re-checks the chain pin (`BtcHtlc Rail.connect`) and hands back a
// `ConnectedCounterAssetRail` bound to this swap's own `terms`/resolved `accounts`.
//
// P4-BTC-SPEC.md §6: a P2WSH script commits to BOTH parties' public keys (the refund branch
// checks the payer's own CHECKSIG, not merely a timelock) — unlike `evm-htlc`, where only the
// payee's account is ever needed to lock or claim, every write this adapter makes needs BOTH
// `accounts.payer` and `accounts.payee` already resolved (`requireBothPubkeys` below refuses,
// rather than guess, the moment either is missing). A caller (`src/client/buyer.ts`/`seller.ts`)
// must therefore resolve accounts from the leg's own deal room before calling `connect()` for
// ANY write on this rail — including `refund`/`findClaimedPreimage`, which never needed a
// resolved account at all on the EVM side.
//
// Design source: flop-contrib/handoff/P4-BTC-SPEC.md §4, §6, §7a;
// flop-contrib/handoff/research/btc-regtest-probe-2026-09-28.md.

import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import { formatPubkeyLine, resolvePubkeys } from "../rails/account-line.js";
import { btcEvidence, captureBtcLeg, BTC_RAIL_ID, type BtcAccounts, type BtcCapture } from "../rails/btc-evidence.js";
import {
  assetIdFor,
  BTC_MIN_LOCKABLE_SATS,
  BtcHtlcRail,
  type BtcHtlcTerms,
  type BtcRailConfig,
  type BtcSignerKey,
  type BtcWalletHandle,
  type PreparedFunding,
} from "../rails/btc-htlc.js";
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
import { BTC_LOCAL_POLICY, type RailLocalPolicy } from "./policy.js";

export interface BtcCounterRailOptions {
  config: BtcRailConfig;
  /** The transport every read and write goes through — also this rail's `CaptureSink`. */
  rpc: CapturingRpc;
  /** This party's own bitcoind wallet name (`"buyer"` or `"seller"` in this build's own regtest
   *  harness) — every wallet RPC a write makes targets `/wallet/<wallet>`
   *  (`src/rails/btc-htlc.ts`'s own convention; never a shared node-level call). */
  wallet: string;
  /** This party's own public signing identity (compressed pubkey + BIP32 fingerprint/path) —
   *  never a private key (P4-BTC-SPEC.md §1). Must equal whichever of the leg's
   *  `payerPubkey`/`payeePubkey` this party actually is; `src/rails/btc-htlc.ts`'s own
   *  fund/claim/refund each re-check this before doing anything else. */
  key: BtcSignerKey;
  /** Where this party's own claim/refund proceeds go — "each party's own choice at spend time"
   *  (P4-BTC-SPEC.md §3), never resolved from the deal room or from `accounts`. */
  destinationAddress: string;
  clock: () => number;
}

/** P4-BTC-SPEC.md §6: both parties' pubkeys, resolved — required for every write on this rail
 *  (unlike EVM, where only the payee's account ever matters). Throws, never guesses, the moment
 *  either is missing, so a caller discovers this before it goes anywhere near a PSBT builder. */
function requireBothPubkeys(accounts: RailAccounts): { payeePubkey: string; payerPubkey: string } {
  if (accounts.payee === undefined || accounts.payer === undefined) {
    throw new Error(
      "btc-rail: refusing to proceed — this leg needs BOTH parties' resolved pubkeys (P4-BTC-SPEC.md §6); " +
        `payee is ${accounts.payee === undefined ? "unresolved" : "resolved"}, ` +
        `payer is ${accounts.payer === undefined ? "unresolved" : "resolved"}`,
    );
  }
  return { payeePubkey: accounts.payee, payerPubkey: accounts.payer };
}

function toBtcHtlcTerms(terms: LockTerms, accounts: RailAccounts): BtcHtlcTerms {
  if (terms.lock !== "hash") {
    throw new Error(`btc-rail: only hash locks are supported, got ${terms.lock}`);
  }
  const { payeePubkey, payerPubkey } = requireBothPubkeys(accounts);
  return { hashLock: terms.statement, amountSats: terms.amount, refundAfterMs: terms.refundAfterMs, payeePubkey, payerPubkey };
}

function toWriteEvidence(evidence: { ref: string; txid: string; blockHeight: number | null; blockHash: string | null; raw: string[]; rawTx?: string }): RailWriteEvidence {
  return {
    ref: evidence.ref,
    txid: evidence.txid,
    blockHeight: evidence.blockHeight,
    blockHash: evidence.blockHash,
    raw: evidence.raw,
    ...(evidence.rawTx === undefined ? {} : { rawTx: evidence.rawTx }),
  };
}

class ConnectedBtcCounterRail implements ConnectedCounterAssetRail {
  private readonly btcRail: BtcHtlcRail;
  private readonly options: BtcCounterRailOptions;
  private readonly terms: LockTerms;
  private readonly accounts: RailAccounts;
  /** G3 (client half of H2): what `prepareLock` built and signed but has not yet broadcast —
   *  `commitLock` consumes exactly this, never re-derives it, so the transaction that gets
   *  broadcast is byte-identical to the one whose `ref` was already recorded. */
  private prepared: PreparedFunding | undefined;

  constructor(btcRail: BtcHtlcRail, options: BtcCounterRailOptions, terms: LockTerms, accounts: RailAccounts) {
    this.btcRail = btcRail;
    this.options = options;
    this.terms = terms;
    this.accounts = accounts;
  }

  get exchanges(): readonly Exchange[] {
    return this.options.rpc.exchanges();
  }

  private ownWallet(): BtcWalletHandle {
    return { wallet: this.options.wallet, key: this.options.key };
  }

  /** G3: builds and signs the funding PSBT (via `BtcHtlcRail.prepareFunding`) WITHOUT
   *  broadcasting it — the outpoint (`ref`) is already fully determined by the transaction's own
   *  bytes at this point, so a caller can record it before ever risking a broadcast. */
  async prepareLock(terms: LockTerms, feeBps: number): Promise<PreparedLock> {
    if (feeBps !== 0) {
      throw new Error("btc-rail: this deployment has no fee; declared feeBps must be 0");
    }
    const btcTerms = toBtcHtlcTerms(terms, this.accounts);
    const prepared = await this.btcRail.prepareFunding(btcTerms, this.ownWallet());
    this.prepared = prepared;
    return { ref: prepared.ref };
  }

  /** G3: broadcasts exactly what `prepareLock` most recently prepared. */
  async commitLock(): Promise<RailWriteEvidence> {
    if (this.prepared === undefined) {
      throw new Error("btc-rail: commitLock called before prepareLock");
    }
    const prepared = this.prepared;
    this.prepared = undefined;
    const evidence = await this.btcRail.broadcastFunding(prepared);
    return toWriteEvidence(evidence);
  }

  /** The Seller's claim — `src/rails/btc-htlc.ts`'s own `claim()` re-checks `notAfterMs` against
   *  fresh chain time as the very last read, and runs `testmempoolaccept` before ever
   *  broadcasting (P4-BTC-SPEC.md §4/§7a); this wrapper adds no behaviour of its own. */
  async claim(ref: string, secret: string, notAfterMs: number): Promise<RailWriteEvidence> {
    const btcTerms = toBtcHtlcTerms(this.terms, this.accounts);
    const evidence = await this.btcRail.claim(ref, btcTerms, secret, this.ownWallet(), this.options.destinationAddress, notAfterMs);
    return toWriteEvidence(evidence);
  }

  async refund(ref: string): Promise<RailWriteEvidence> {
    const btcTerms = toBtcHtlcTerms(this.terms, this.accounts);
    const evidence = await this.btcRail.refund(ref, btcTerms, this.ownWallet(), this.options.destinationAddress);
    return toWriteEvidence(evidence);
  }

  /** P4-BTC-FIXES-R2.md R2-1: re-check the chain and re-send `priorEvidence`'s own recorded
   *  bytes (`priorEvidence.rawTx`/`priorEvidence.txid`) if they have dropped — see
   *  `BtcHtlcRail.resendRefundIfDropped`'s own doc for the exact conditions. `priorEvidence`
   *  unchanged (never a new write, never a thrown "cannot resend") when there is nothing to
   *  resend from at all — unreachable via `BuyerFlow`, which always records `refund()`'s own
   *  `rawTx` before this could ever be called, kept defensive rather than assumed. */
  async resendRefundIfDropped(ref: string, priorEvidence: RailWriteEvidence): Promise<RailWriteEvidence> {
    if (priorEvidence.rawTx === undefined || priorEvidence.txid === undefined) {
      return priorEvidence;
    }
    const result = await this.btcRail.resendRefundIfDropped(ref, priorEvidence.txid, priorEvidence.rawTx);
    return result.resent ? { ...priorEvidence, txid: result.txid, raw: result.raw } : priorEvidence;
  }

  /** D-11: capture live, then decide (`src/rails/btc-evidence.ts`) — never throws for a
   *  chain-state reason, only a genuine transport failure. */
  async verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult> {
    const nowMs = this.options.clock();
    const { index, exchanges } = await captureBtcLeg(this.options.rpc, this.options.config, ref, nowMs);
    const bytes = verifiedExchangeBytes(exchanges);
    const capture: BtcCapture = { index, bytes };
    const btcAccounts: BtcAccounts = {
      ...(accounts.payee === undefined ? {} : { payeePubkey: accounts.payee }),
      ...(accounts.payer === undefined ? {} : { payerPubkey: accounts.payer }),
    };
    return btcEvidence({ terms, config: this.options.config, accounts: btcAccounts, capture });
  }

  /** Bounded block scan (`BtcHtlcRail.findClaimPreimage`) for the secret that opened this leg's
   *  own `terms.statement` — `ref` is the funding outpoint (never the hashLock, unlike EVM's
   *  `findClaimedPreimage`, whose own `ref` argument *is* the hashLock — P4-BTC-SPEC.md §4). */
  async findClaimedPreimage(ref: string, fromMarker?: RailBlockMarker): Promise<string | null> {
    const fromHeight = typeof fromMarker === "number" ? fromMarker : 0;
    return this.btcRail.findClaimPreimage(ref, this.terms.statement, fromHeight);
  }

  /** P4-BTC-FIXES-R3.md K2: the same mempool-and-chain-aware search `findClaimedPreimage` already
   *  does (K1) — exposed under its own name so `BuyerFlow.refundLegA` can check for a claimed or
   *  claim-pending outpoint BEFORE ever building a refund against it, rather than discovering the
   *  same fact only once `testmempoolaccept` rejects the doomed transaction it just built and
   *  signed. */
  async checkPendingClaim(ref: string, fromMarker?: RailBlockMarker): Promise<string | null> {
    return this.findClaimedPreimage(ref, fromMarker);
  }

  /** The chain's own tip block time — the Bitcoin twin of `evm-rail.ts`'s
   *  `latestBlockTimestampMs()`; every `claimByMs`/margin guard in the shared flow judges
   *  against this, never wall-clock alone. */
  async chainTimeMs(): Promise<number> {
    return this.btcRail.tipBlockTimeMs();
  }

  /** The chain's current tip height — this rail's own `RailBlockMarker` (a `number`), suitable
   *  as a later `findClaimedPreimage`'s own bounded-scan start. Read directly off `rpc`, exactly
   *  the way `evm-rail.ts`'s `currentBlockMarker` reads `eth_blockNumber` directly rather than
   *  through `BtcHtlcRail` (this is a plain read, not a rail write). */
  async currentBlockMarker(): Promise<RailBlockMarker> {
    const info = await this.options.rpc.request({ method: "getblockchaininfo", params: [] });
    const blocks = (info as { blocks?: unknown }).blocks;
    if (typeof blocks !== "number" || !Number.isInteger(blocks)) {
      throw new Error("btc-rail: getblockchaininfo did not return an integer block height");
    }
    return blocks;
  }
}

class BtcCounterRail implements CounterAssetRail {
  readonly railId: string = BTC_RAIL_ID;
  readonly caip2: string;
  /** G5: frozen, never a constructor option — see `CounterAssetRail.policy`'s own doc. */
  readonly policy: RailLocalPolicy = BTC_LOCAL_POLICY;
  /** G6: the fixed fee plus the worst-case dust limit, with margin — see
   *  `BTC_MIN_LOCKABLE_SATS`'s own doc. */
  readonly minLockableAmount: string = BTC_MIN_LOCKABLE_SATS.toString();
  /** K3: the asset id this configured rail settles (`config.asset`, defaulted to `BTC_ASSET_ID`). */
  readonly assetId: string;
  private readonly options: BtcCounterRailOptions;

  constructor(options: BtcCounterRailOptions) {
    this.options = options;
    this.caip2 = options.config.pin.caip2;
    this.assetId = assetIdFor(options.config);
  }

  /** D-08/§6: a `btc-htlc` leg posts a *pubkey* line, not an account/address line — the P2WSH
   *  script commits to public keys, and both parties post one. `address` here is this party's
   *  own compressed pubkey hex, in the generic `CounterAssetRail.formatAccountLine(address)`
   *  slot every rail shares. */
  formatAccountLine(address: string): string {
    return formatPubkeyLine({ railId: this.railId, caip2: this.caip2, pubkey: address });
  }

  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts {
    const resolved = resolvePubkeys(records, { ...input, rail: this.railId, caip2: this.caip2 });
    return {
      ...(resolved.payer === undefined ? {} : { payer: resolved.payer }),
      ...(resolved.payee === undefined ? {} : { payee: resolved.payee }),
    };
  }

  async connect(terms: LockTerms, accounts: RailAccounts): Promise<ConnectedCounterAssetRail> {
    const btcRail = await BtcHtlcRail.connect({ config: this.options.config, rpc: this.options.rpc, clock: this.options.clock });
    return new ConnectedBtcCounterRail(btcRail, this.options, terms, accounts);
  }
}

/** Build the `btc-htlc` implementation of `CounterAssetRail` — the only construction path a
 *  flow (or a test harness) needs; `BtcCounterRail`/`ConnectedBtcCounterRail` are internal. */
export function createBtcCounterRail(options: BtcCounterRailOptions): CounterAssetRail {
  return new BtcCounterRail(options);
}
