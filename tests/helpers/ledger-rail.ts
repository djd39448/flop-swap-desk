// SPDX-License-Identifier: MIT
//
// A STATEFUL fake counter-asset rail for the P8 crash-resume matrix (tests/resume-*.test.ts): one in-memory "chain" (a ledger of
// locked outputs and the transactions the node knows) shared by both parties, and one `CounterAssetRail` per party over it. It
// stands in for the Bitcoin and the NEAR adapters at the rail SEAM (src/client/counter-rail.ts) with the semantics the resume
// spec gives each, so the REAL BuyerFlow / SellerFlow recover paths run against a chain that remembers what was sent:
//
//   flavour "btc"  (rail id btc-htlc): the ref is an outpoint `txid:0` that exists only once a funding was PREPARED (a second
//                  prepare picks another input and so another outpoint); the recovery handle is `{txid, rawTx}`; `recoverLock`
//                  only READS (R1-01 part 2): the node knows the txid (`landed`) or not (`unknown`, never pending or
//                  never-landed), and `resendLock` sends the IDENTICAL bytes; a refund is recorded with `onSigned` before it is
//                  sent, `recoverRefund` reads (`landed`, `unknown` while the output is unspent, `never-landed` once another
//                  transaction spent it) and `resendRefund` re-sends the identical bytes while the output is unspent;
//                  `checkPendingClaim` and `resendRefundIfDropped` exist. P10 B7: a claim is SIGNED (its txid and bytes go to `onSignedTx` before
//                  anything is sent), then SENT; with `chain.autoMineClaims` (the default: the chain is instant) it is mined at once, otherwise it
//                  sits in the "mempool" (the preimage is visible to `findClaimedPreimage` and `checkPendingClaim`, the output still reads `locked`
//                  to the evidence reader) until `chain.mine()`, and `chain.evictClaim(txid)` drops it. The three Bitcoin settlement methods exist:
//                  `claimIsMined` (a mined spend, by height), `claimTxStatus` (read the txid: mined, in the mempool, unknown, spent by another
//                  transaction) and `resendClaimTx` (the identical bytes, never a new claim).
//   flavour "near" (rail id near-htlc): the ref is `0x<hash lock>:<payer>`; the handle is `{txHash, signedTxBase64}`; a lock the
//                  node has no row for is `never-landed` (the nonce proof; `nonceProof: false` makes it `pending`, the real
//                  adapter's stall); `lockRecorded` and `checkPendingClaim` exist.
//
// The chain is instant (every send is mined at once, final at once): what these tests pin is the flows' behaviour across a
// restart, not mempool or finality timing (those have their own suites). Every real network send goes through
// `hooks.act(...)`, which is where the matrix cuts the process; `hooks.alive()` is the zombie guard of a dead instance.
//
// The counters are the matrix's oracle: how many fundings / claims / refunds were BUILT and how many were actually SENT.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verifySecret, verifyTranscriptRecord, type LockTerms, type TranscriptRecord } from "@flop-labs/tclk";

import {
  RailRecoveryRefusedError,
  type ClaimTxResend,
  type ClaimTxStatus,
  type ConnectedCounterAssetRail,
  type CounterAssetRail,
  type LockRecovery,
  type LockRecoveryOutcome,
  type LockResendOutcome,
  type PreparedLock,
  type RailAccounts,
  type RailBlockMarker,
  type RailClaimOptions,
  type RailEvidenceResult,
  type RailRefundOptions,
  type RailWriteEvidence,
} from "../../src/client/counter-rail.js";
import { BTC_LOCAL_POLICY, NEAR_LOCAL_POLICY, type RailLocalPolicy } from "../../src/client/policy.js";
import { BTC_MIN_LOCKABLE_SATS } from "../../src/rails/btc-htlc.js";
import { NEAR_AMOUNT_FLOOR } from "../../src/rails/near-htlc.js";
import type { Exchange } from "../../src/rails/rpc-capture.js";

export type LedgerFlavour = "btc" | "near";

export interface LedgerHooks {
  /** One outward network action of this party (`what` names it). The matrix may cut the process before, or after, `run`. */
  act<T>(what: string, run: () => Promise<T>): Promise<T>;
  /** Throws when the instance using this rail is a dead process. */
  alive(): void;
}

interface Output {
  ref: string;
  hashLock: string;
  payer: string;
  payee: string;
  amount: string;
  claimByMs: number;
  refundAfterMs: number;
  status: "locked" | "claimed" | "refunded";
  preimage?: string;
  fundingTxid: string;
  /** The chain height the claim was mined at (set by `claim`); a test moves it to model a reorg that mines the claim lower (R2-13). */
  claimHeight?: number;
  /** P10 B7: a claim the node holds but no block does (the output still reads `locked` to the evidence reader). */
  mempoolSpend?: { txid: string; preimage: string };
  /** P10 B7: the txid of the claim that was mined. */
  minedClaimTxid?: string;
}

export interface LedgerCounts {
  /** Fundings (locks) built / actually sent. */
  fundBuilt: number;
  fundSent: number;
  /** P10 B7 (Bitcoin): claims built (signed). A claim is built once per swap, however many times it is sent. */
  claimBuilt: number;
  claimSent: number;
  /** Refunds built (signed) / actually sent. A refund built but never sent never reached the network. */
  refundBuilt: number;
  refundSent: number;
  /** Identical-bytes re-sends made by a recovery. */
  rebroadcasts: number;
}

interface PreparedFunding {
  ref: string;
  txid: string;
  hashLock: string;
  payer: string;
  payee: string;
  amount: string;
  claimByMs: number;
  refundAfterMs: number;
}

/** The shared chain: outputs by outpoint, the txids the node knows, counters, and the knobs a test can turn. */
export class LedgerChain {
  readonly outputs = new Map<string, Output>();
  readonly knownTxs = new Set<string>();
  /** What each built funding's bytes mean, by txid (the "wallet": a persisted funding can be sent again from its bytes alone). */
  readonly builtFundings = new Map<string, PreparedFunding>();
  readonly counts: LedgerCounts = { fundBuilt: 0, fundSent: 0, claimBuilt: 0, claimSent: 0, refundBuilt: 0, refundSent: 0, rebroadcasts: 0 };
  /** P10 B7 (Bitcoin): what the "wallet" signed, by claim txid: the identical bytes can be sent again from the txid alone. */
  readonly claimBytes = new Map<string, { ref: string; secret: string; rawTx: string }>();
  /** P10 B7 (Bitcoin): true (the default, "the chain is instant"): a sent claim is mined at once. False: it sits in the mempool until `mine()`. */
  autoMineClaims = true;
  /** P10 B7 (Bitcoin): the node refuses a recorded claim it is asked to send again (its inputs are gone, or its fee is below the minimum). */
  refuseClaimResend = false;
  /** P10 B7 (Bitcoin): a block is mined: every claim in the mempool is in it. */
  mine(): void {
    this.height += 1;
    for (const output of this.outputs.values()) {
      if (output.mempoolSpend === undefined) continue;
      output.status = "claimed";
      output.preimage = output.mempoolSpend.preimage;
      output.minedClaimTxid = output.mempoolSpend.txid;
      output.claimHeight = this.height;
      delete output.mempoolSpend;
    }
  }
  /** P10 B7 (Bitcoin): the node drops a claim from its mempool (an expiry, a restart without the mempool): the output is unspent again, the txid unknown. */
  evictClaim(txid: string): void {
    for (const output of this.outputs.values()) {
      if (output.mempoolSpend?.txid === txid) delete output.mempoolSpend;
    }
    this.knownTxs.delete(txid);
  }
  /** Bitcoin: the node refuses to take a persisted funding again (its inputs are gone). */
  refuseRebroadcast = false;
  /** NEAR: a transaction that was never sent is provably dead (the access key's nonce moved past it). */
  nonceProof = true;
  /** Bitcoin, a rail that does not exist: `recoverLock` answers "never landed" for a funding the node does not know (the real
   *  adapter never does; this lets a test hand the flow a re-prepared lock with another outpoint). */
  provesNeverLanded = false;
  /** An output spent by a transaction the evidence reader and the pending-claim read do not show (a spend that is not a refund the
   *  Buyer knows and not yet a claim anyone can read). */
  hideSpends = false;
  height = 100;
  /** The `fromMarker` of every `findClaimedPreimage` call (R1-13: a resumed Seller must scan from the marker it saved, never from genesis). */
  readonly scanFrom: unknown[] = [];
  private serial = 0;

  constructor(readonly nowMs: () => number) {}

  next(): number {
    this.serial += 1;
    return this.serial;
  }
}

const hex = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text)));

/** The line this fake rail posts: not a tclk frame, bound to the rail, the contract, the address and the DID. */
function lineFor(railId: string, contract: string, address: string, did: string): string {
  return `ledger-account ${railId} ${contract} ${address} ${did}`;
}

export interface LedgerRailOptions {
  chain: LedgerChain;
  flavour: LedgerFlavour;
  /** This party's own chain address (a pubkey on btc, an account id on near). */
  address: string;
  hooks: LedgerHooks;
}

export const LEDGER_BTC_ADDRESS = { buyer: `02${"a".repeat(64)}`, seller: `03${"b".repeat(64)}` } as const;
export const LEDGER_NEAR_ADDRESS = { buyer: "buyer.near-sandbox-flop", seller: "seller.near-sandbox-flop" } as const;

export function createLedgerRail(options: LedgerRailOptions): CounterAssetRail {
  return new LedgerRail(options);
}

class LedgerRail implements CounterAssetRail {
  readonly railId: string;
  readonly caip2: string;
  /** The value `railDeploymentId` derives for a rail that has none (`rail:<railId>`): the records these fakes write
   *  carry it either way, so declaring it changes nothing but the type (`CounterAssetRail.deploymentId` is required). */
  readonly deploymentId: string;
  readonly policy: RailLocalPolicy;
  readonly minLockableAmount: string;
  readonly assetId?: string;

  constructor(private readonly options: LedgerRailOptions) {
    const btc = options.flavour === "btc";
    this.railId = btc ? "btc-htlc" : "near-htlc";
    this.deploymentId = `rail:${this.railId}`;
    this.caip2 = btc ? "bip122:0f9188f13cb7b2c71f2a335e3a4fc328" : "near:sandbox-flop";
    this.policy = btc ? BTC_LOCAL_POLICY : NEAR_LOCAL_POLICY;
    this.minLockableAmount = btc ? BTC_MIN_LOCKABLE_SATS.toString() : NEAR_AMOUNT_FLOOR;
    if (btc) this.assetId = "BTC";
  }

  formatAccountLine(address: string): string {
    return lineFor(this.railId, "-", address, "-");
  }

  async proveAccountLine(input: { address: string; did: string; contract: string }): Promise<string> {
    this.options.hooks.alive();
    if (input.address !== this.options.address) throw new Error("ledger rail: an account line may only name this party's own address");
    return lineFor(this.railId, input.contract, input.address, input.did);
  }

  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts {
    // Every one of a party's own matching lines must agree; a line at or after `beforeSeq` does not count (it was posted after the lock).
    const addressOf = (did: string): string | undefined => {
      const seen = new Set<string>();
      for (const record of records) {
        if (record.sender !== did || !verifyTranscriptRecord(record).ok) continue;
        if (input.beforeSeq !== undefined && record.seq >= input.beforeSeq) continue;
        const parts = record.line.split(" ");
        if (parts[0] !== "ledger-account" || parts[1] !== this.railId || parts[2] !== input.contract || parts[4] !== did) continue;
        seen.add(parts[3] as string);
      }
      return seen.size === 1 ? [...seen][0] : undefined;
    };
    const payer = addressOf(input.payerDid);
    const payee = addressOf(input.payeeDid);
    return { ...(payer === undefined ? {} : { payer }), ...(payee === undefined ? {} : { payee }) };
  }

  async connect(terms: LockTerms, accounts: RailAccounts): Promise<ConnectedCounterAssetRail> {
    this.options.hooks.alive();
    return new LedgerConnected(this.options, this.railId, terms, accounts);
  }
}

class LedgerConnected implements ConnectedCounterAssetRail {
  readonly exchanges: readonly Exchange[] = [];
  private prepared: PreparedFunding | undefined;
  readonly resendRefundIfDropped?: (ref: string, priorEvidence: RailWriteEvidence) => Promise<RailWriteEvidence>;
  readonly lockRecorded?: (ref: string) => Promise<{ exists: boolean; reason?: string }>;
  /** Bitcoin only (R1-01 part 2): the identical-bytes re-sends; the near flavour never answers `unknown` and has none. */
  readonly resendLock?: (prepared: PreparedLock) => Promise<LockResendOutcome>;
  readonly resendRefund?: (ref: string, recovery: LockRecovery) => Promise<LockResendOutcome>;
  /** P10 B7, Bitcoin only: the three settlement methods of a claim (a mined spend, the status of the recorded txid, the identical bytes again). */
  readonly claimIsMined?: (ref: string, fromMarker?: RailBlockMarker) => Promise<boolean>;
  readonly claimTxStatus?: (ref: string, recovery: LockRecovery) => Promise<ClaimTxStatus>;
  readonly resendClaimTx?: (ref: string, recovery: LockRecovery, options?: { notAfterMs?: number }) => Promise<ClaimTxResend>;

  constructor(
    private readonly options: LedgerRailOptions,
    private readonly railId: string,
    private readonly terms: LockTerms,
    private readonly accounts: RailAccounts,
  ) {
    if (options.flavour === "btc") {
      this.resendLock = (prepared) => this.btcResendLock(prepared);
      this.resendRefund = (ref, recovery) => this.btcResendRefund(ref, recovery);
      this.claimIsMined = (ref, fromMarker) => this.btcClaimIsMined(ref, fromMarker);
      this.claimTxStatus = (ref, recovery) => this.btcClaimTxStatus(ref, recovery);
      this.resendClaimTx = (ref, recovery, options) => this.btcResendClaimTx(ref, recovery, options);
      this.resendRefundIfDropped = async (ref, prior) => {
        this.options.hooks.alive();
        const output = this.options.chain.outputs.get(ref);
        const txid = prior.txid;
        if (output?.status === "locked" && txid !== undefined && prior.rawTx !== undefined && !this.options.chain.knownTxs.has(txid)) {
          await this.sendRefund(ref, { chain: "btc", txid, rawTx: prior.rawTx }, "refund.resend");
        }
        return prior;
      };
    } else {
      this.lockRecorded = async (ref) => {
        this.options.hooks.alive();
        const output = this.options.chain.outputs.get(ref);
        return output !== undefined && output.payer === this.options.address ? { exists: true } : { exists: false, reason: "no lock recorded" };
      };
    }
  }

  private get chain(): LedgerChain {
    return this.options.chain;
  }

  async signAccountProof(): Promise<never> {
    throw new Error("ledger rail: the flows post the line proveAccountLine builds; signAccountProof is never reached");
  }

  // --- lock -------------------------------------------------------------------------------------------------------------

  async prepareLock(terms: LockTerms, feeBps: number): Promise<PreparedLock> {
    this.options.hooks.alive();
    if (feeBps !== 0) throw new Error("ledger rail: this deployment has no fee");
    if (this.accounts.payer === undefined || this.accounts.payee === undefined) throw new Error("ledger rail: both accounts are needed to lock");
    const serial = this.chain.next();
    this.chain.counts.fundBuilt += 1;
    const btc = this.options.flavour === "btc";
    // btc: a second prepare picks other inputs, so another txid and another outpoint. near: the ref is fixed by hash lock + payer.
    const txid = hex(`fund|${terms.statement}|${serial}`);
    const ref = btc ? `${txid}:0` : `${terms.statement}:${this.accounts.payer}`;
    this.prepared = {
      ref,
      txid,
      hashLock: terms.statement,
      payer: this.accounts.payer,
      payee: this.accounts.payee,
      amount: terms.amount,
      claimByMs: terms.claimByMs,
      refundAfterMs: terms.refundAfterMs,
    };
    this.chain.builtFundings.set(txid, this.prepared);
    const recovery: LockRecovery = btc
      ? { chain: "btc", txid, rawTx: hex(`raw-funding|${txid}`) }
      : { chain: "near", txHash: txid, signedTxBase64: Buffer.from(`signed-funding-${txid}`).toString("base64") };
    return { ref, recovery };
  }

  private applyFunding(funding: PreparedFunding): void {
    if (this.chain.knownTxs.has(funding.txid)) return; // "already known": the identical bytes again are accepted and change nothing
    this.chain.knownTxs.add(funding.txid);
    this.chain.counts.fundSent += 1;
    this.chain.outputs.set(funding.ref, {
      ref: funding.ref,
      hashLock: funding.hashLock,
      payer: funding.payer,
      payee: funding.payee,
      amount: funding.amount,
      claimByMs: funding.claimByMs,
      refundAfterMs: funding.refundAfterMs,
      status: "locked",
      fundingTxid: funding.txid,
    });
  }

  async commitLock(): Promise<RailWriteEvidence> {
    this.options.hooks.alive();
    const funding = this.prepared;
    if (funding === undefined) throw new Error("ledger rail: commitLock without prepareLock");
    await this.options.hooks.act("lock.send", async () => this.applyFunding(funding));
    return { ref: funding.ref, raw: [], ...(this.options.flavour === "btc" ? { txid: funding.txid } : {}) };
  }

  async recoverLock(prepared: PreparedLock): Promise<LockRecoveryOutcome> {
    this.options.hooks.alive();
    const handle = prepared.recovery;
    if (handle === undefined) throw new RailRecoveryRefusedError("no-handle", prepared.ref, "the ledger rail needs the recovery handle");
    if (this.options.flavour === "btc") {
      if (handle.chain !== "btc") throw new RailRecoveryRefusedError("handle-mismatch", prepared.ref, `a ${handle.chain} handle for the btc rail`);
      // READ-ONLY: the node knows the funding or it does not. Nothing is sent here (`resendLock` sends).
      if (this.chain.knownTxs.has(handle.txid)) return "landed";
      if (this.chain.provesNeverLanded) return "never-landed";
      return "unknown";
    }
    if (handle.chain !== "near") throw new RailRecoveryRefusedError("handle-mismatch", prepared.ref, `a ${handle.chain} handle for the near rail`);
    if (this.chain.outputs.has(prepared.ref)) return "landed";
    return this.chain.nonceProof ? "never-landed" : "pending";
  }

  /** Bitcoin: the identical persisted bytes go out again, once (`recoverLock` answered `unknown`). A node that refuses them is a typed
   *  error for a person (a second funding is never built). */
  private async btcResendLock(prepared: PreparedLock): Promise<LockResendOutcome> {
    this.options.hooks.alive();
    const handle = prepared.recovery;
    if (handle === undefined) throw new RailRecoveryRefusedError("no-handle", prepared.ref, "the ledger rail needs the recovery handle");
    if (handle.chain !== "btc") throw new RailRecoveryRefusedError("handle-mismatch", prepared.ref, `a ${handle.chain} handle for the btc rail`);
    if (this.chain.knownTxs.has(handle.txid)) return "landed"; // it landed meanwhile: nothing to send
    if (this.chain.refuseRebroadcast) throw new RailRecoveryRefusedError("rebroadcast-refused", prepared.ref, "the node refuses the persisted funding (its inputs are gone)");
    // Identical bytes, again. The matrix keeps the facts of the funding on the chain object by txid.
    const funding = this.chain.builtFundings.get(handle.txid);
    if (funding === undefined) throw new RailRecoveryRefusedError("handle-mismatch", prepared.ref, "this chain never built that funding");
    await this.options.hooks.act("lock.rebroadcast", async () => {
      this.chain.counts.rebroadcasts += 1;
      this.applyFunding(funding);
    });
    return "landed";
  }

  // --- claim ------------------------------------------------------------------------------------------------------------

  /** The claim lands on the chain: in a block at once (the default) or in the mempool. The identical bytes again are "already known" and change nothing. */
  private applyClaim(output: Output, txid: string, secret: string): void {
    if (this.chain.knownTxs.has(txid)) return;
    this.chain.counts.claimSent += 1;
    this.chain.knownTxs.add(txid);
    if (this.chain.autoMineClaims) {
      output.status = "claimed";
      output.preimage = secret;
      output.minedClaimTxid = txid;
      output.claimHeight = this.chain.height;
    } else {
      output.mempoolSpend = { txid, preimage: secret };
    }
  }

  async claim(ref: string, secret: string, notAfterMs: number, options: RailClaimOptions = {}): Promise<RailWriteEvidence> {
    this.options.hooks.alive();
    const output = this.chain.outputs.get(ref);
    if (output === undefined) throw new Error("ledger rail: no such output");
    const btc = this.options.flavour === "btc";
    const txid = hex(`claim|${ref}`);
    if (output.status !== "locked") throw new Error(`ledger rail: claim refused, the output is ${output.status}`);
    if (btc && output.mempoolSpend !== undefined && output.mempoolSpend.txid !== txid) throw new Error("ledger rail: claim refused, the output is spent in the mempool by another transaction");
    if (!verifySecret("hash", output.hashLock, secret)) throw new Error("ledger rail: claim refused, the secret does not open the statement");
    // NEAR's contract refuses a claim at or after refundAfterMs; Bitcoin has no on-chain claim deadline (a claim and a refund race).
    if (this.options.flavour === "near" && this.chain.nowMs() >= output.refundAfterMs) throw new Error("ledger rail: claim refused, too late");
    if (btc) {
      // P10 B7 (record before send): the claim is signed (its bytes are the same whenever it is built), the recorder hears of it, then the last deadline read, then the send.
      const rawTx = hex(`raw-claim|${txid}`);
      if (!this.chain.claimBytes.has(txid)) {
        this.chain.counts.claimBuilt += 1;
        this.chain.claimBytes.set(txid, { ref, secret, rawTx });
      }
      const handle: LockRecovery = { chain: "btc", txid, rawTx };
      if (options.onSignedTx !== undefined) await options.onSignedTx(handle);
      if (this.chain.nowMs() >= notAfterMs) {
        if (options.onNotBroadcastTx !== undefined) await options.onNotBroadcastTx(handle);
        throw new Error("ledger rail: claim refused, at or after notAfterMs");
      }
    }
    await this.options.hooks.act("claim.send", async () => {
      if (btc) {
        this.applyClaim(output, txid, secret);
        return;
      }
      this.chain.counts.claimSent += 1;
      output.status = "claimed";
      output.preimage = secret;
      output.claimHeight = this.chain.height;
      this.chain.knownTxs.add(hex(`claim|${ref}`));
    });
    return { ref, raw: [], ...(btc ? { txid } : {}) };
  }

  // --- P10 B7: Bitcoin's claim settlement ------------------------------------------------------------------------------------

  /** A mined spend of the output by its hash branch, found by a scan that starts at the marker (a claim a reorg mined below it is not seen). */
  private async btcClaimIsMined(ref: string, fromMarker?: RailBlockMarker): Promise<boolean> {
    this.options.hooks.alive();
    const output = this.chain.outputs.get(ref);
    if (output?.status !== "claimed" || output.claimHeight === undefined) return false;
    return !(typeof fromMarker === "number" && output.claimHeight < fromMarker);
  }

  /** What the node says of the recorded claim's txid (READ-ONLY, like the real adapter's). */
  private async btcClaimTxStatus(ref: string, recovery: LockRecovery): Promise<ClaimTxStatus> {
    this.options.hooks.alive();
    if (recovery.chain !== "btc") throw new RailRecoveryRefusedError("handle-mismatch", ref, `a ${recovery.chain} handle for the btc rail`);
    const output = this.chain.outputs.get(ref);
    if (this.chain.knownTxs.has(recovery.txid)) return output?.minedClaimTxid === recovery.txid && output.status === "claimed" ? "mined" : "in-mempool";
    return output?.status === "locked" && output.mempoolSpend === undefined ? "unknown" : "spent-by-other";
  }

  /** The identical recorded claim bytes go out again, once: never a new claim. */
  private async btcResendClaimTx(ref: string, recovery: LockRecovery, options?: { notAfterMs?: number }): Promise<ClaimTxResend> {
    this.options.hooks.alive();
    if (recovery.chain !== "btc") throw new RailRecoveryRefusedError("handle-mismatch", ref, `a ${recovery.chain} handle for the btc rail`);
    const output = this.chain.outputs.get(ref);
    const bytes = this.chain.claimBytes.get(recovery.txid);
    if (output === undefined || bytes === undefined || bytes.ref !== ref || bytes.rawTx !== recovery.rawTx) {
      throw new RailRecoveryRefusedError("handle-mismatch", ref, "this chain never signed that claim");
    }
    if (this.chain.knownTxs.has(recovery.txid)) return output.minedClaimTxid === recovery.txid && output.status === "claimed" ? "mined" : "in-mempool";
    if (output.status !== "locked" || output.mempoolSpend !== undefined) return "spent-by-other";
    if (this.chain.refuseClaimResend) throw new RailRecoveryRefusedError("rebroadcast-refused", ref, "the node refuses the recorded claim");
    if (options?.notAfterMs !== undefined && this.chain.nowMs() >= options.notAfterMs) throw new Error("ledger rail: the claim re-send refused, at or after notAfterMs");
    await this.options.hooks.act("claim.rebroadcast", async () => {
      this.chain.counts.rebroadcasts += 1;
      this.applyClaim(output, recovery.txid, bytes.secret);
    });
    // (the send mined it at once, or left it in the mempool)
    return (output as Output).status === "claimed" ? "mined" : "in-mempool";
  }

  // --- refund -----------------------------------------------------------------------------------------------------------

  private async sendRefund(ref: string, handle: LockRecovery, what: string): Promise<void> {
    const output = this.chain.outputs.get(ref);
    if (output === undefined) throw new Error("ledger rail: no such output");
    await this.options.hooks.act(what, async () => {
      if (output.status !== "locked") throw new Error(`ledger rail: refund refused, the output is ${output.status}`);
      this.chain.counts.refundSent += 1;
      output.status = "refunded";
      this.chain.knownTxs.add(handle.chain === "btc" ? handle.txid : handle.chain === "near" ? handle.txHash : "");
    });
  }

  async refund(ref: string, options: RailRefundOptions = {}): Promise<RailWriteEvidence> {
    this.options.hooks.alive();
    const output = this.chain.outputs.get(ref);
    if (output === undefined) throw new Error("ledger rail: no such output");
    if (output.status !== "locked") throw new Error(`ledger rail: refund refused, the output is ${output.status}`);
    if (output.payer !== this.options.address) throw new Error("ledger rail: only the payer can refund");
    if (this.chain.nowMs() < output.refundAfterMs) throw new Error("ledger rail: refund refused, too early");
    const serial = this.chain.next();
    this.chain.counts.refundBuilt += 1;
    const btc = this.options.flavour === "btc";
    const txid = hex(`refund|${ref}|${serial}`);
    const handle: LockRecovery = btc
      ? { chain: "btc", txid, rawTx: hex(`raw-refund|${txid}`) }
      : { chain: "near", txHash: txid, signedTxBase64: Buffer.from(`signed-refund-${txid}`).toString("base64") };
    // Rule 1: the signed refund is handed to the recorder BEFORE anything is sent.
    if (options.onSigned !== undefined) await options.onSigned(handle);
    // (the matrix's "before refund.send" is exactly the point where the signed refund is saved and nothing is sent)
    await this.sendRefund(ref, handle, "refund.send");
    return { ref, raw: [], ...(btc ? { txid, rawTx: hex(`raw-refund|${txid}`) } : {}) };
  }

  async recoverRefund(ref: string, recovery: LockRecovery): Promise<LockRecoveryOutcome> {
    this.options.hooks.alive();
    const output = this.chain.outputs.get(ref);
    const btc = this.options.flavour === "btc";
    if (btc) {
      if (recovery.chain !== "btc") throw new RailRecoveryRefusedError("handle-mismatch", ref, `a ${recovery.chain} handle for the btc rail`);
      // READ-ONLY (R1-01 part 2): `resendRefund` re-sends.
      if (this.chain.knownTxs.has(recovery.txid)) return "landed";
      if (output?.status === "locked") return "unknown"; // dropped (or never sent) while the output is unspent
      return "never-landed"; // the output is spent by another transaction (a claim)
    }
    if (recovery.chain !== "near") throw new RailRecoveryRefusedError("handle-mismatch", ref, `a ${recovery.chain} handle for the near rail`);
    if (output?.status === "refunded") return "landed";
    return this.chain.nonceProof ? "never-landed" : "pending";
  }

  /** Bitcoin: the identical recorded refund bytes go out again, only while the funding output is still unspent, never a second build. */
  private async btcResendRefund(ref: string, recovery: LockRecovery): Promise<LockResendOutcome> {
    this.options.hooks.alive();
    const output = this.chain.outputs.get(ref);
    if (recovery.chain !== "btc") throw new RailRecoveryRefusedError("handle-mismatch", ref, `a ${recovery.chain} handle for the btc rail`);
    if (this.chain.knownTxs.has(recovery.txid)) return "landed";
    if (output?.status === "locked") {
      await this.sendRefund(ref, recovery, "refund.rebroadcast");
      this.chain.counts.rebroadcasts += 1;
      return "landed";
    }
    return "never-landed";
  }

  // --- reads ------------------------------------------------------------------------------------------------------------

  async checkPendingClaim(ref: string): Promise<string | null> {
    this.options.hooks.alive();
    if (this.chain.hideSpends) return null;
    const output = this.chain.outputs.get(ref);
    if (output?.mempoolSpend !== undefined) return output.mempoolSpend.preimage;
    return output?.status === "claimed" && output.preimage !== undefined ? output.preimage : null;
  }

  async verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult> {
    this.options.hooks.alive();
    const checkedAtMs = this.chain.nowMs();
    const output = this.chain.outputs.get(ref);
    const base = { rail: this.railId, ref, terms: { ...terms }, checkedAtMs };
    if (output === undefined) return { lock: { ...base, railVerified: false, reason: "no output under that ref" } };
    const matches =
      output.hashLock === terms.statement &&
      output.amount === terms.amount &&
      output.claimByMs === terms.claimByMs &&
      output.refundAfterMs === terms.refundAfterMs &&
      (accounts.payee === undefined || output.payee === accounts.payee);
    if (!matches) return { lock: { ...base, railVerified: false, reason: "the output does not match the leg's terms" } };
    if (this.chain.hideSpends && output.status !== "locked") return { lock: { ...base, railVerified: true } };
    return {
      lock: { ...base, railVerified: true },
      rail: { status: output.status, final: true, checkedAtMs, rail: this.railId, ref, contract: terms.contract, terms: { ...terms } },
    };
  }

  async findClaimedPreimage(ref: string, fromMarker?: RailBlockMarker): Promise<string | null> {
    this.options.hooks.alive();
    this.chain.scanFrom.push(fromMarker);
    const output = this.chain.outputs.get(ref);
    if (output?.mempoolSpend !== undefined) return output.mempoolSpend.preimage; // the mempool step of the real scan (K1)
    // a bounded block scan starts at the marker: a claim mined below it is not seen (R2-13)
    if (typeof fromMarker === "number" && output?.claimHeight !== undefined && output.claimHeight < fromMarker) return null;
    return output?.status === "claimed" && output.preimage !== undefined ? output.preimage : null;
  }

  async chainTimeMs(): Promise<number> {
    this.options.hooks.alive();
    return this.chain.nowMs();
  }

  async currentBlockMarker(): Promise<RailBlockMarker> {
    this.options.hooks.alive();
    return this.chain.height;
  }
}
