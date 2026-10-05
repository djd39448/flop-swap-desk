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
import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import { accountProofMessage, formatAccountLine, resolveAccounts } from "../rails/account-line.js";
import { eip191Verifier, type AccountProof } from "../rails/account-proof.js";
import { EVM_RAIL_ID, type EvmAccounts } from "../rails/evm-evidence.js";
import { EvmHtlcRail, type EvmRailConfig } from "../rails/evm-htlc.js";
import type { CapturingRpc, Exchange } from "../rails/rpc-capture.js";
import type { AddressBook } from "../vendor/evm-hash-rail.js";
import {
  RailRecoveryRefusedError,
  type ConnectedCounterAssetRail,
  type CounterAssetRail,
  type LockRecoveryOutcome,
  type PreparedLock,
  type RailAccounts,
  type RailBlockMarker,
  type RailEvidenceResult,
  type RailRefundOptions,
  type RailWriteEvidence,
} from "./counter-rail.js";
import { EVM_LOCAL_POLICY, type RailLocalPolicy } from "./policy.js";

export interface EvmCounterRailOptions {
  config: EvmRailConfig;
  /** The transport every read and write goes through — also this rail's `CaptureSink`. */
  rpc: CapturingRpc;
  /** This party's own EVM address. A JSON-RPC account: no private key anywhere (D-10). */
  account: Address;
  clock: () => number;
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
  private readonly account: Address;
  private readonly caip2: string;
  /** G3: `prepareLock`'s own recorded intent — EVM's write ref (the hashLock) is already known
   *  before any write happens at all (P22-P24-EVM-FIXES-R3.md E3), so preparing needs no network
   *  call of its own; `commitLock` consumes this and does the real approve+lock. */
  private prepared: { terms: LockTerms; feeBps: number } | undefined;

  constructor(rail: EvmHtlcRail, rpc: CapturingRpc, account: Address, caip2: string) {
    this.rail = rail;
    this.rpc = rpc;
    this.account = account;
    this.caip2 = caip2;
  }

  /** P7: EIP-191 `personal_sign` by this party's own JSON-RPC account: the node holds the key and
   *  signs over RPC, this code never sees one (D-10). The signature is re-verified locally (the
   *  same `eip191` verifier a resolver uses) before it is returned, so a node that signs with the
   *  wrong account or returns garbage is refused here, not discovered at resolution. */
  async signAccountProof(message: string): Promise<AccountProof> {
    const own = `${this.caip2}:${this.account.toLowerCase()}`;
    if (!message.endsWith(`|${own}`)) {
      throw new Error("evm-rail: refusing to sign an account proof for a message that does not name this handle's own account");
    }
    const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
    const signed = await this.rpc.request({ method: "personal_sign", params: [hex, this.account] });
    if (typeof signed !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signed)) {
      throw new Error("evm-rail: personal_sign did not return a 65-byte signature");
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
    if (!ok) throw new Error("evm-rail: the node's personal_sign signature does not verify for this account");
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
   *  `approve` then `lock` directly. */
  async commitLock(): Promise<RailWriteEvidence> {
    if (this.prepared === undefined) {
      throw new Error("evm-rail: commitLock called before prepareLock");
    }
    const { terms, feeBps } = this.prepared;
    this.prepared = undefined;
    await this.rail.approve(terms.asset, terms.amount);
    return this.rail.lock(terms, feeBps);
  }

  async claim(ref: string, secret: string, notAfterMs: number): Promise<RailWriteEvidence> {
    return this.rail.claim(ref as Hex, secret as Hex, notAfterMs);
  }

  /** P8: `evm-htlc` takes the recorder options for interface symmetry and never calls them: the node signs and sends
   *  in one JSON-RPC call, so there is no signed refund to hand over before the send. A repeated refund after a crash
   *  is recognised from the lock's own state (`verifyLockFinal` reads `refunded`), not from a handle. */
  async refund(ref: string, _options?: RailRefundOptions): Promise<RailWriteEvidence> {
    return this.rail.refund(ref as Hex);
  }

  /**
   * P8-RESUME-SPEC.md "Buyer lock A", EVM: no handle exists or is needed, the ref IS the hash lock. A row stored
   * under it at the latest block, owned by this account as payer, is `landed` (whatever its status: a claim or refund
   * already moved it on). No row is `never-landed` in the weak sense this rail can offer: EVM cannot prove a
   * transaction is not still pending in some node's pool, but a repeated `approve` is harmless and a repeated `lock`
   * reverts on the contract's duplicate hash-lock check, so re-running `commitLock` cannot lock twice. A row owned by
   * another payer can never be turned into this party's lock: `RailRecoveryRefusedError("lock-conflict")`.
   */
  async recoverLock(prepared: PreparedLock): Promise<LockRecoveryOutcome> {
    const row = await this.rail.readLock(prepared.ref as Hex);
    if (row === null) return "never-landed";
    if (!isAddressEqual(row.payer, this.account)) {
      throw new RailRecoveryRefusedError(
        "lock-conflict",
        prepared.ref,
        `a lock already exists under this hash lock with payer ${row.payer}, not this account ${this.account}`,
      );
    }
    return "landed";
  }

  async verifyLockFinal(terms: LockTerms, ref: string, accounts: RailAccounts): Promise<RailEvidenceResult> {
    return this.rail.verifyLockFinal(terms, ref, accounts as EvmAccounts);
  }

  async findClaimedPreimage(ref: string, fromMarker?: RailBlockMarker): Promise<string | null> {
    const fromBlock = typeof fromMarker === "bigint" ? fromMarker : 0n;
    return this.rail.findClaimedPreimage(ref as Hex, fromBlock);
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

class EvmCounterRail implements CounterAssetRail {
  readonly railId: string = EVM_RAIL_ID;
  readonly caip2: string;
  /** G5: frozen, never a constructor option — see `CounterAssetRail.policy`'s own doc. */
  readonly policy: RailLocalPolicy = EVM_LOCAL_POLICY;
  private readonly options: EvmCounterRailOptions;

  constructor(options: EvmCounterRailOptions) {
    this.options = options;
    this.caip2 = options.config.pin.caip2;
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
    const addressBook = addressBookFor(terms, accounts, this.options.account);
    const rail = await EvmHtlcRail.connect({
      config: this.options.config,
      rpc: this.options.rpc,
      account: this.options.account,
      addressBook,
      clock: this.options.clock,
    });
    return new ConnectedEvmCounterRail(rail, this.options.rpc, this.options.account, this.caip2);
  }
}

/** Build the `evm-htlc` implementation of `CounterAssetRail` — the only construction path a
 *  flow (or a test harness) needs; `EvmCounterRail`/`ConnectedEvmCounterRail` are internal. */
export function createEvmCounterRail(options: EvmCounterRailOptions): CounterAssetRail {
  return new EvmCounterRail(options);
}
