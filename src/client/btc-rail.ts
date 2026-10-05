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

import { hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import { formatPubkeyLine, pubkeyProofMessage, resolvePubkeys } from "../rails/account-line.js";
import type { AccountProof } from "../rails/account-proof.js";
import { bip322ProofPsbt, bip322Verifier, bip322WitnessFromSignedTx } from "../rails/btc-proof.js";
import { btcEvidence, captureBtcLeg, BTC_RAIL_ID, type BtcAccounts, type BtcCapture } from "../rails/btc-evidence.js";
import {
  assetIdFor,
  BTC_MIN_LOCKABLE_SATS,
  BtcBroadcastRefusedError,
  BtcHtlcRail,
  type BtcHtlcTerms,
  type BtcRailConfig,
  type BtcSignerKey,
  type BtcWalletHandle,
  type PreparedFunding,
} from "../rails/btc-htlc.js";
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

const TXID_SHAPE = /^[0-9a-f]{64}$/;
const OUTPOINT_SHAPE = /^([0-9a-f]{64}):[0-9]+$/;

/** P8: a Bitcoin recovery handle (`{ chain: "btc", txid, rawTx }`), checked for shape and for internal consistency
 *  (the bytes hash to the txid) before anything is asked of the node. `ref` is the funding outpoint of a lock, or
 *  the funding outpoint a refund spends; `fundingTxidMustMatch` is true for a lock handle, whose txid IS the ref's. */
function requireBtcHandle(ref: string, recovery: LockRecovery | undefined, fundingTxidMustMatch: boolean): { txid: string; rawTx: string } {
  if (recovery === undefined) {
    throw new RailRecoveryRefusedError("no-handle", ref, "btc-htlc needs the funding transaction's txid and bytes recorded at prepareLock");
  }
  if (recovery.chain !== "btc") {
    throw new RailRecoveryRefusedError("handle-mismatch", ref, `a ${recovery.chain} recovery handle was given to the btc-htlc rail`);
  }
  if (!TXID_SHAPE.test(recovery.txid) || !/^([0-9a-f]{2})+$/.test(recovery.rawTx)) {
    throw new RailRecoveryRefusedError("handle-mismatch", ref, "the recorded txid or rawTx is not lowercase hex of the expected shape");
  }
  const outpoint = OUTPOINT_SHAPE.exec(ref);
  if (outpoint === null) throw new RailRecoveryRefusedError("handle-mismatch", ref, 'ref is not "<64-hex txid>:<vout>"');
  if (fundingTxidMustMatch && outpoint[1] !== recovery.txid) {
    throw new RailRecoveryRefusedError("handle-mismatch", ref, "the recorded funding txid is not the txid of this ref's outpoint");
  }
  let decoded: string;
  try {
    decoded = Transaction.fromRaw(hexToBytes(recovery.rawTx), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;
  } catch {
    throw new RailRecoveryRefusedError("handle-mismatch", ref, "the recorded rawTx does not decode as a transaction");
  }
  if (decoded !== recovery.txid) {
    throw new RailRecoveryRefusedError("handle-mismatch", ref, "the recorded rawTx does not hash to the recorded txid");
  }
  return { txid: recovery.txid, rawTx: recovery.rawTx };
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

  /** P7: a BIP-322 simple signature by this party's own wallet key for the P2WPKH address of its
   *  pubkey, over `message` (`pubkeyProofMessage`). Keyless: the PSBT of BIP-322's `to_sign` goes
   *  to the node wallet's own `walletprocesspsbt`, exactly like the leg's own writes, and only the
   *  public witness comes back. The result is re-verified locally before it is returned. */
  async signAccountProof(message: string): Promise<AccountProof> {
    const { pubkey } = this.options.key;
    if (!message.endsWith(`|${this.options.config.pin.caip2}:${pubkey.toLowerCase()}`)) {
      throw new Error("btc-rail: refusing to sign an account proof for a message that does not name this handle's own pubkey");
    }
    const psbt = bip322ProofPsbt(message, pubkey.toLowerCase(), {
      fingerprint: this.options.key.fingerprint,
      path: this.options.key.path,
    });
    const processed = (await this.options.rpc.request({
      method: "walletprocesspsbt",
      params: [psbt],
      path: `/wallet/${this.options.wallet}`,
    })) as { complete?: boolean; hex?: string };
    if (processed.complete !== true || typeof processed.hex !== "string") {
      throw new Error("btc-rail: walletprocesspsbt did not produce a complete BIP-322 proof transaction");
    }
    const proof: AccountProof = { scheme: "bip322", signature: bip322WitnessFromSignedTx(processed.hex) };
    const ok = bip322Verifier.verify({
      message,
      railId: BTC_RAIL_ID,
      caip2: this.options.config.pin.caip2,
      subject: pubkey.toLowerCase(),
      proof,
    });
    if (!ok) throw new Error("btc-rail: the wallet's BIP-322 signature does not verify for this pubkey");
    return proof;
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
    // P8: the funding transaction's txid and exact signed bytes, for the caller to persist BEFORE `commitLock`.
    return { ref: prepared.ref, recovery: { chain: "btc", txid: prepared.txid, rawTx: prepared.rawTx } };
  }

  /**
   * P8-RESUME-SPEC.md "Buyer lock A", Bitcoin: never re-prepares. The node is asked about the persisted funding txid
   * (`recoverFunding`): known (mempool or chain) is `landed`. Unknown: the IDENTICAL persisted bytes are re-sent
   * (`rebroadcastFunding`: `testmempoolaccept` then `sendrawtransaction`, "already known" counting as success) and an
   * accepted re-send is `landed`. A node that refuses the bytes (inputs spent, a conflicting transaction, policy)
   * throws `RailRecoveryRefusedError("rebroadcast-refused")`: a second funding could double-spend the swap's inputs
   * or create a second outpoint, so a person decides. This rail never answers `pending` or `never-landed`, and no
   * wallet call (`walletcreatefundedpsbt`, `walletprocesspsbt`) is ever made here.
   */
  async recoverLock(prepared: PreparedLock): Promise<LockRecoveryOutcome> {
    const handle = requireBtcHandle(prepared.ref, prepared.recovery, true);
    const known = await this.btcRail.recoverFunding(handle.txid);
    if (known.broadcast) return "landed";
    try {
      await this.btcRail.rebroadcastFunding(prepared.ref, handle.rawTx);
    } catch (error) {
      if (error instanceof BtcBroadcastRefusedError) {
        throw new RailRecoveryRefusedError(
          "rebroadcast-refused",
          prepared.ref,
          `the node refuses the recorded funding transaction ${handle.txid} (${error.reason}); it was not re-prepared`,
        );
      }
      throw error;
    }
    return "landed";
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

  async refund(ref: string, options?: RailRefundOptions): Promise<RailWriteEvidence> {
    const btcTerms = toBtcHtlcTerms(this.terms, this.accounts);
    // P8: the refund's txid and exact bytes go to the recorder after signing and before anything is sent.
    const evidence = await this.btcRail.refund(ref, btcTerms, this.ownWallet(), this.options.destinationAddress, {
      ...(options?.onSigned === undefined ? {} : { onSigned: (signed: { txid: string; rawTx: string }) => options.onSigned?.({ chain: "btc", ...signed }) }),
      ...(options?.onNotBroadcast === undefined
        ? {}
        : { onNotBroadcast: (signed: { txid: string; rawTx: string }) => options.onNotBroadcast?.({ chain: "btc", ...signed }) }),
    });
    return toWriteEvidence(evidence);
  }

  /**
   * P8-RESUME-SPEC.md "Buyer refund A", Bitcoin: resolves the ONE refund this flow signed, from its recorded txid and
   * bytes. Known to the node: `landed` once it has a confirmation, else `pending`. Unknown: `resendRefundIfDropped`
   * decides (it re-sends the IDENTICAL bytes only while the funding output is still unspent by anyone, mempool
   * included, and never builds a second refund): re-sent is `pending`; not re-sent means that output is spent by
   * another transaction (a claim), so this refund can no longer land: `never-landed` (a caller then routes to
   * `learnSecret`). The txid is looked up once more before that verdict, so a refund that reached the node between
   * the two reads is never called dead.
   */
  async recoverRefund(ref: string, recovery: LockRecovery): Promise<LockRecoveryOutcome> {
    const handle = requireBtcHandle(ref, recovery, false);
    const known = await this.btcRail.recoverFunding(handle.txid);
    if (known.broadcast) return known.confirmations !== null && known.confirmations >= 1 ? "landed" : "pending";
    const result = await this.btcRail.resendRefundIfDropped(ref, handle.txid, handle.rawTx);
    if (result.resent) return "pending";
    const again = await this.btcRail.recoverFunding(handle.txid);
    if (again.broadcast) return again.confirmations !== null && again.confirmations >= 1 ? "landed" : "pending";
    return "never-landed";
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

  /** P7: the proven pubkey line — a BIP-322 proof by the wallet key for the P2WPKH address of
   *  `address` (the pubkey), signed keylessly by the node wallet. */
  async proveAccountLine(input: { address: string; did: string; contract: string; terms: LockTerms }): Promise<string> {
    const message = pubkeyProofMessage({
      did: input.did,
      contract: input.contract,
      railId: this.railId,
      caip2: this.caip2,
      pubkey: input.address,
    });
    const connected = await this.connect(input.terms, {});
    const proof = await connected.signAccountProof(message);
    return formatPubkeyLine({ railId: this.railId, caip2: this.caip2, pubkey: input.address, proof });
  }

  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts {
    const resolved = resolvePubkeys(records, {
      ...input,
      rail: this.railId,
      caip2: this.caip2,
      proof: { mode: "required" }, // P7: only proven lines resolve
    });
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
