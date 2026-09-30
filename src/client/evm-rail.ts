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

import type { Address, Hex } from "viem";
import type { LockTerms, TranscriptRecord } from "@flop-labs/tclk";

import { formatAccountLine, resolveAccounts } from "../rails/account-line.js";
import { EVM_RAIL_ID, type EvmAccounts } from "../rails/evm-evidence.js";
import { EvmHtlcRail, type EvmRailConfig } from "../rails/evm-htlc.js";
import type { CapturingRpc, Exchange } from "../rails/rpc-capture.js";
import type { AddressBook } from "../vendor/evm-hash-rail.js";
import type {
  ConnectedCounterAssetRail,
  CounterAssetRail,
  PreparedLock,
  RailAccounts,
  RailBlockMarker,
  RailEvidenceResult,
  RailWriteEvidence,
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
  /** G3: `prepareLock`'s own recorded intent — EVM's write ref (the hashLock) is already known
   *  before any write happens at all (P22-P24-EVM-FIXES-R3.md E3), so preparing needs no network
   *  call of its own; `commitLock` consumes this and does the real approve+lock. */
  private prepared: { terms: LockTerms; feeBps: number } | undefined;

  constructor(rail: EvmHtlcRail, rpc: CapturingRpc) {
    this.rail = rail;
    this.rpc = rpc;
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

  async refund(ref: string): Promise<RailWriteEvidence> {
    return this.rail.refund(ref as Hex);
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

  resolveAccounts(
    records: readonly TranscriptRecord[],
    input: { contract: string; payerDid: string; payeeDid: string; beforeSeq?: number },
  ): RailAccounts {
    const resolved = resolveAccounts(records, {
      ...input,
      rail: this.railId,
      caip2: this.caip2,
      proof: { mode: "legacy-unproven" }, // P7: migrate to { mode: "required" } in the Rails stage
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
    return new ConnectedEvmCounterRail(rail, this.options.rpc);
  }
}

/** Build the `evm-htlc` implementation of `CounterAssetRail` — the only construction path a
 *  flow (or a test harness) needs; `EvmCounterRail`/`ConnectedEvmCounterRail` are internal. */
export function createEvmCounterRail(options: EvmCounterRailOptions): CounterAssetRail {
  return new EvmCounterRail(options);
}
