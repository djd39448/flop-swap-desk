// SPDX-License-Identifier: MIT
//
// P4-BTC-SPEC.md §7a: the `evm-htlc` implementation of `CounterAssetRail`
// (src/client/counter-rail.ts) — a thin wrapper around the existing, untouched
// src/rails/evm-htlc.ts. No behaviour change: every call this makes is exactly the call
// src/client/seller.ts and src/client/buyer.ts made directly against `EvmHtlcRail` before this
// stage, in the same order, against the same `CapturingRpc` instance — so every existing EVM
// unit, anvil and fixture test stays green unchanged.
//
// Design source: flop-contrib/handoff/P4-BTC-SPEC.md §7a.

import { isAddressEqual, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import { accountProofMessage, formatAccountLine, resolveAccounts } from "../rails/account-line.js";
import { eip191Verifier, type AccountProof } from "../rails/account-proof.js";
import { EVM_RAIL_ID, type EvmAccounts } from "../rails/evm-evidence.js";
import { EvmHtlcRail, MAX_LOOKUP_PAUSE_MS, type EvmRailConfig } from "../rails/evm-htlc.js";
import type { CapturingRpc, Exchange } from "../rails/rpc-capture.js";
import type { AddressBook } from "../vendor/evm-hash-rail.js";
import {
  RailRecoveryRefusedError,
  type ConnectedCounterAssetRail,
  type CounterAssetRail,
  type LockAbsence,
  type LockRecoveryOutcome,
  type PreparedLock,
  type RailAccounts,
  type RailBlockMarker,
  type RailCommitOptions,
  type RailEvidenceResult,
  type RailRefundOptions,
  type RailWriteEvidence,
} from "./counter-rail.js";
import { evmLocalPolicyFor, type EvmLocalPolicy } from "./policy.js";

export interface EvmCounterRailOptions {
  config: EvmRailConfig;
  /** The transport every read and write goes through — also this rail's `CaptureSink`. */
  rpc: CapturingRpc;
  /**
   * This party's own EVM account: an `Address` (a JSON-RPC account: the node holds the key and signs over RPC, anvil's
   * unlocked accounts) or a viem `LocalAccount` (P9-1: loaded from a key file by `loadEvmLocalAccount`; viem signs locally,
   * every write goes out as `eth_sendRawTransaction` and the account proof is `account.signMessage`). No private key
   * is held, stored or printed by this module either way (D-10); only the address is ever shown.
   */
  account: Address | LocalAccount;
  clock: () => number;
  /**
   * P9-4 decision 10: the runner's poll interval (ms). On a chain other than Base Sepolia the write lookup pauses this long between its re-plans
   * (1 s, the anvil policy's block time, when omitted); on Base Sepolia the pause is the policy's block time (2 s) whatever this says.
   */
  pollMs?: number;
  /** P9-4 decision 10: the pause itself (a timer by default); a test injects one that records the pauses. */
  sleep?: (ms: number) => Promise<void>;
}

/** The address of either kind of account. */
function addressOf(account: Address | LocalAccount): Address {
  return typeof account === "string" ? account : account.address;
}

/**
 * Builds the `AddressBook` `EvmHtlcRail.connect()` needs for its own `.lock()` write:
 * `terms.payee` resolves to `accounts.payee` (D-08's own resolution — required only when a
 * flow is actually about to lock); `terms.payer` resolves to this party's own configured
 * account (always known, never resolved externally — the same as every inline address book
 * `src/client/seller.ts`/`buyer.ts` built directly before this stage). Never invoked at all on
 * a connected handle that only ever claims/refunds/verifies (a Seller's own rail handle,
 * exactly like the pre-stage `inertAddressBook()` it replaces).
 */
function addressBookFor(terms: LockTerms, accounts: RailAccounts, ownAccount: Address): AddressBook {
  return {
    resolve(did: string): Address {
      if (accounts.payee !== undefined && did === terms.payee) return accounts.payee as Address;
      if (did === terms.payer) return ownAccount;
      throw new Error(`evm-rail: no resolved address for ${did}`);
    },
  };
}

class ConnectedEvmCounterRail implements ConnectedCounterAssetRail {
  private readonly rail: EvmHtlcRail;
  private readonly rpc: CapturingRpc;
  /** This party's address, whichever kind of account it has. */
  private readonly account: Address;
  /** Set only for a local account: the object that signs the account proof (never a key, never printed). */
  private readonly local: LocalAccount | undefined;
  private readonly caip2: string;
  /** G3: `prepareLock`'s own recorded intent — EVM's write ref (the hashLock) is already known
   *  before any write happens at all (P22-P24-EVM-FIXES-R3.md E3), so preparing needs no network
   *  call of its own; `commitLock` consumes this and does the real approve+lock. */
  private prepared: { terms: LockTerms; feeBps: number } | undefined;

  constructor(rail: EvmHtlcRail, rpc: CapturingRpc, account: Address | LocalAccount, caip2: string) {
    this.rail = rail;
    this.rpc = rpc;
    this.account = addressOf(account);
    this.local = typeof account === "string" ? undefined : account;
    this.caip2 = caip2;
  }

  /** P7: EIP-191 by this party's own account. A JSON-RPC account: `personal_sign` over RPC, the node holds the key and
   *  signs, this code never sees one (D-10). A local account (P9-1): `account.signMessage` signs in this process (the
   *  same EIP-191 message hash; no `personal_sign` call goes out). Either way the signature is re-verified locally
   *  (the same `eip191` verifier a resolver uses) before it is returned, so a signer that signs with the wrong account
   *  or returns garbage is refused here, not discovered at resolution. */
  async signAccountProof(message: string): Promise<AccountProof> {
    const own = `${this.caip2}:${this.account.toLowerCase()}`;
    if (!message.endsWith(`|${own}`)) {
      throw new Error("evm-rail: refusing to sign an account proof for a message that does not name this handle's own account");
    }
    let signed: unknown;
    if (this.local !== undefined) {
      signed = await this.local.signMessage({ message });
    } else {
      const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
      signed = await this.rpc.request({ method: "personal_sign", params: [hex, this.account] });
    }
    if (typeof signed !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signed)) {
      throw new Error(`evm-rail: ${this.local !== undefined ? "the local account's signMessage" : "personal_sign"} did not return a 65-byte signature`);
    }
    const bytes = Buffer.from(signed.slice(2), "hex");
    // Some nodes return v as 0/1; EIP-191 tooling (and the verifier) use 27/28.
    if (bytes[64]! < 27) bytes[64] = bytes[64]! + 27;
    const proof: AccountProof = { scheme: "eip191", signature: bytes.toString("hex") };
    const ok = eip191Verifier.verify({
      message,
      railId: "evm-htlc",
      caip2: this.caip2,
      subject: this.account.toLowerCase(),
      proof,
    });
    if (!ok) {
      throw new Error(
        this.local !== undefined
          ? "evm-rail: the local account's signature does not verify for this account"
          : "evm-rail: the node's personal_sign signature does not verify for this account",
      );
    }
    return proof;
  }

  get exchanges(): readonly Exchange[] {
    return this.rpc.exchanges();
  }

  async prepareLock(terms: LockTerms, feeBps: number): Promise<PreparedLock> {
    this.prepared = { terms, feeBps };
    return { ref: terms.statement };
  }

  /** Mirrors `src/client/buyer.ts`'s pre-stage `lockLegA`: an ERC20 `approve` to the rail
   *  contract always precedes the lock write itself — `EvmHashRail.lock`'s own `transferFrom`
   *  reverts on-chain without it. Both writes land on the same `CapturingRpc` log this
   *  connected handle's `exchanges` getter already exposes, so a flow's own before/after slicing
   *  around this one call still captures both (B5), exactly as it did when a flow called
   *  `approve` then `lock` directly. R1-FUND-08: the approve's receipt wait can take up to `receiptTimeoutMs`, and the vendored lock itself checks
   *  only `clock < refundAfterMs`, so the caller's deadline guard (`options.beforeFinalSend`: the flow's SPEC 3.5 arithmetic at the clock of that
   *  moment) runs AGAIN after the approve's receipt and before the lock; if it throws, no lock is sent (the approve stands: an allowance, no value). */
  async commitLock(options?: RailCommitOptions): Promise<RailWriteEvidence> {
    if (this.prepared === undefined) {
      throw new Error("evm-rail: commitLock called before prepareLock");
    }
    const { terms, feeBps } = this.prepared;
    this.prepared = undefined;
    await this.rail.approve(terms.asset, terms.amount);
    await options?.beforeFinalSend?.();
    return this.rail.lock(terms, feeBps);
  }

  async claim(ref: string, secret: string, notAfterMs: number): Promise<RailWriteEvidence> {
    return this.rail.claim(ref as Hex, secret as Hex, notAfterMs);
  }

  /** P8: `evm-htlc` takes the recorder options for interface symmetry and never calls them: with a JSON-RPC account the
   *  node signs and sends in one call, and with a local account (P9-1) the transaction is signed and broadcast inside
   *  viem's `sendTransaction`, which returns only the hash once the node has it, so there is no signed refund to hand
   *  over before the send either way (and `LockRecovery`'s EVM shape is for a LOCK write that timed out, never for a refund). The P8
   *  order holds for a local account exactly as for a JSON-RPC one: the flow persists its intent first, then calls
   *  this. A repeated refund after a crash is recognised from the lock's own state (`verifyLockFinal` reads
   *  `refunded`), not from a handle. */
  async refund(ref: string, _options?: RailRefundOptions): Promise<RailWriteEvidence> {
    return this.rail.refund(ref as Hex);
  }

  /**
   * P8-RESUME-SPEC.md "Buyer lock A", EVM: no handle exists or is needed, the ref IS the hash lock. A row stored
   * under it at the latest block, owned by this account as payer, is `landed` (whatever its status: a claim or refund
   * already moved it on). No row is `never-landed` in the weak sense this rail can offer: EVM cannot prove a
   * transaction is not still pending in some node's pool, but a repeated `approve` is harmless and a repeated `lock`
   * reverts on the contract's duplicate hash-lock check, so re-running `commitLock` cannot lock twice. A row owned by
   * another payer can never be turned into this party's lock: `RailRecoveryRefusedError("lock-conflict")`. Read-only,
   * like every rail's `recoverLock` (R1-01); this rail never answers `unknown` and has no `resendLock`.
   */
  async recoverLock(prepared: PreparedLock): Promise<LockRecoveryOutcome> {
    const row = await this.rail.readLock(prepared.ref as Hex);
    if (row !== null) {
      if (!isAddressEqual(row.payer, this.account)) {
        throw new RailRecoveryRefusedError(
          "lock-conflict",
          prepared.ref,
          `a lock already exists under this hash lock with payer ${row.payer}, not this account ${this.account}`,
        );
      }
      return "landed";
    }
    // P9-4 decision 7 (R1-FUND-04): no row at the latest block. When the flow saved the hash of a lock write whose receipt wait timed out, the node is
    // asked about it before this answers "never-landed" (which lets the flow send an approve and a lock again): a transaction the node still holds is
    // `pending` (nothing new is sent), one that was mined and reverted did nothing (`never-landed`), one it does not know is `never-landed` as before.
    // A transaction mined successfully whose row this read does not show is not decided either (the endpoint's answers disagree): `pending`, ask again.
    const recovery = prepared.recovery;
    if (recovery === undefined) return "never-landed";
    if (recovery.chain !== "evm") {
      throw new RailRecoveryRefusedError("handle-mismatch", prepared.ref, `a ${recovery.chain} recovery handle was given to the evm-htlc rail`);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(recovery.txHash)) {
      throw new RailRecoveryRefusedError("handle-mismatch", prepared.ref, "the saved EVM recovery handle does not hold a transaction hash");
    }
    const status = await this.rail.transactionStatus(recovery.txHash as Hex);
    return status === "pending" || status === "success" ? "pending" : "never-landed";
  }

  /** P9-4 decision 7: what the node says of a write this party sent and stopped waiting for; see `EvmHtlcRail.transactionStatus`. */
  async transactionStatus(txHash: string): Promise<"pending" | "success" | "reverted" | "unknown"> {
    return this.rail.transactionStatus(txHash as Hex);
  }

  async verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult> {
    return this.rail.verifyLockFinal(terms, ref, accounts as EvmAccounts);
  }

  /** P9-3: chunked to the config's `maxLogRange` (500 on Base Sepolia), OLDEST range first from the marker (R1-FUND-03: a claim lies in the first
   *  ranges above it), at most `MAX_LOG_SCAN_CHUNKS` calls, a typed `EvmLogScanBoundError` past that; this is the scan of the resumed Seller's own
   *  claim and of the Buyer's secret discovery alike. */
  async findClaimedPreimage(ref: string, fromMarker?: RailBlockMarker): Promise<string | null> {
    const fromBlock = typeof fromMarker === "bigint" ? fromMarker : 0n;
    return this.rail.findClaimedPreimage(ref as Hex, fromBlock);
  }

  /** R1-FUND-03: the lock's own row at the latest block (`locks(hashLock)`): Claimed, with this account as its payee, is a claim that paid this party.
   *  One read, no log scan; a transport failure propagates (never read as "not paid"). */
  async claimPaidOut(ref: string): Promise<boolean> {
    const row = await this.rail.readLock(ref as Hex);
    return row !== null && row.status === "Claimed" && isAddressEqual(row.payee, this.account);
  }

  /**
   * R2-FUND-01: what became of a lock attempt that has no evidence, read BEFORE `BuyerFlow.refundLegA` sends anything (see
   * `EvmHtlcRail.readLockAbsence`). A row AT THE FINALIZED BLOCK owned by this account is `landed` (the flow records it and refunds as before;
   * R3-FUND-02: a row seen only at the latest block is not final and is never `landed`); a row there owned by another payer is the same
   * `lock-conflict` refusal `recoverLock` gives, never "landed" and never "never locked"; no row with a finalized block at or past `refundAfterMs`
   * is `never-locked` (the contract refuses a lock in any later block); anything else, including a row seen only at the latest block and an
   * error on the finalized-tag read (R3-FUND-03), is `not-final`.
   */
  async lockAbsence(ref: string, refundAfterMs: number): Promise<LockAbsence> {
    const found = await this.rail.readLockAbsence(ref as Hex, refundAfterMs);
    if (found.kind === "not-final") return "not-final";
    if (found.kind === "never-locked") return "never-locked";
    if (!isAddressEqual(found.row.payer, this.account)) {
      throw new RailRecoveryRefusedError(
        "lock-conflict",
        ref,
        `a lock already exists under this hash lock with payer ${found.row.payer}, not this account ${this.account}`,
      );
    }
    return "landed";
  }

  async chainTimeMs(): Promise<number> {
    return this.rail.latestBlockTimestampMs();
  }

  /** Mirrors `src/client/buyer.ts`'s pre-stage `lockLegA` reading `eth_blockNumber` directly off
   *  the same `CapturingRpc` this connected handle's `EvmHtlcRail` was built with — never routed
   *  through the wallet/public client machinery, exactly as before. */
  async currentBlockMarker(): Promise<RailBlockMarker> {
    const hex = await this.rpc.request({ method: "eth_blockNumber", params: [] });
    return BigInt(hex as string);
  }
}

/** R1-05: the escrow contract and every configured token, lowercased and in a fixed order (assets sorted by name), so
 *  the same config always gives the same string and another contract or token gives another one. */
export function evmDeploymentId(config: EvmRailConfig): string {
  const assets = Object.keys(config.assets)
    .sort()
    .map((name) => `${name}=${config.assets[name]?.toLowerCase() ?? ""}`)
    .join(",");
  return `evm-htlc:contract=${config.contract.toLowerCase()}:assets=${assets}`;
}

class EvmCounterRail implements CounterAssetRail {
  readonly railId: string = EVM_RAIL_ID;
  readonly caip2: string;
  /** P9-4 decision 1: the pin's chain id, kept to select the policy (never printed: a config that is not a number here is not echoed). */
  private readonly chainId: number;
  /** G5: frozen, never a constructor option (see `CounterAssetRail.policy`'s own doc). P9-4 decision 1: selected by the pin's chain id
   *  (`evmLocalPolicyFor`): `EVM_LOCAL_POLICY` for anvil (31337), `BASE_SEPOLIA_POLICY` for Base Sepolia (84532); any other chain id has no
   *  policy and this throws `EvmPolicyUnavailableError` (so does `connect()`, before anything is read or sent). */
  get policy(): EvmLocalPolicy {
    return evmLocalPolicyFor(this.chainId);
  }
  /** R1-05: the escrow contract and the token addresses. The lock is found by its hash lock AT this contract, so a
   *  record resumed against another contract would read "no row" as "never landed" and lock again. */
  readonly deploymentId: string;
  private readonly options: EvmCounterRailOptions;

  constructor(options: EvmCounterRailOptions) {
    this.options = options;
    this.caip2 = options.config.pin.caip2;
    this.chainId = options.config.pin.chainId;
    this.deploymentId = evmDeploymentId(options.config);
  }

  /** P9-4 decision 10: the pause before each re-plan of the write lookup: the policy's block time on Base Sepolia (2 s), else the runner's poll interval,
   *  else the policy's block time (anvil: 1 s). */
  private lookupPauseMs(): number {
    const policy = this.policy;
    if (this.chainId === 84532) return policy.blockTimeMs;
    const poll = this.options.pollMs;
    return poll !== undefined && Number.isSafeInteger(poll) && poll >= 0 ? Math.min(poll, MAX_LOOKUP_PAUSE_MS) : policy.blockTimeMs;
  }

  formatAccountLine(address: string): string {
    return formatAccountLine({ railId: this.railId, caip2: this.caip2, address });
  }

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
    };
  }

  async connect(terms: LockTerms, accounts: RailAccounts): Promise<ConnectedCounterAssetRail> {
    // P9-4 decision 1: a chain with no deadline policy is refused before anything is read or sent (the typed `EvmPolicyUnavailableError`).
    void this.policy;
    const addressBook = addressBookFor(terms, accounts, addressOf(this.options.account));
    const rail = await EvmHtlcRail.connect({
      config: this.options.config,
      rpc: this.options.rpc,
      account: this.options.account,
      addressBook,
      clock: this.options.clock,
      lookupPauseMs: this.lookupPauseMs(),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
    });
    return new ConnectedEvmCounterRail(rail, this.options.rpc, this.options.account, this.caip2);
  }
}

/** Build the `evm-htlc` implementation of `CounterAssetRail` — the only construction path a
 *  flow (or a test harness) needs; `EvmCounterRail`/`ConnectedEvmCounterRail` are internal. */
export function createEvmCounterRail(options: EvmCounterRailOptions): CounterAssetRail {
  return new EvmCounterRail(options);
}
