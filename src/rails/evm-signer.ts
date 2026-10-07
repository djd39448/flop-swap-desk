// SPDX-License-Identifier: MIT
//
// P9 fix pass, R1-FUND-02 (the A10 chain pin must bind what a LOCAL account signs): with a viem `LocalAccount` the node does not
// sign, this process does, and viem takes the nonce, the gas limit and the fee caps from whatever the endpoint answers (one
// `eth_fillTransaction` where the node has it, else the individual reads). Before this module nothing bounded those answers: an
// endpoint that said "chain 31337" to `eth_chainId` could still fill chain id 8453, a 500,000 gas limit and a fee cap of
// 10,000 gwei, and viem signed it. Two defences, both here and both refusals (nothing in this module ever sends anything):
//
//   1. `guardLocalAccount`: the account handed to viem is a sealed wrapper (the same `sealLocalAccount` the key-file loader uses:
//      `address` and `type` are the only enumerable members, JSON, `String()` and `util.inspect` show nothing else) whose
//      `signTransaction` refuses, with a typed `EvmSignerRefusedError`, a transaction whose chain id is not the pinned one, whose
//      gas limit is above `EVM_MAX_GAS_PER_WRITE`, or whose fee caps are above the configured ceiling (or are missing).
//   2. `refuseFillTransaction`: the transport the wallet client uses answers `eth_fillTransaction` with a JSON-RPC
//      method-not-found error without asking the endpoint, so viem takes the chain id from the pinned chain and reads nonce, gas
//      and fees one by one (each of those answers then meets the guard above).
//
// The refusal error carries no transaction field at all (no `data`, which for a claim holds the preimage, no gas, no fee): only
// which rule fired and the configured limit. Nothing here ever sees, stores or prints a key.

import type { LocalAccount } from "viem/accounts";

import { sealLocalAccount } from "../client/evm-key-file.js";
import { RpcCaptureError } from "./rpc-capture.js";

/** The most gas any one write of this rail may ask for. Above every measured write on anvil (approve 44k, lock 214k, claim 65k). */
export const EVM_MAX_GAS_PER_WRITE = 500_000n;

/** The default `EvmRailConfig.maxFeePerGasWei`: 1,000 gwei. Anvil's fees are a few gwei, so it passes there; the Base Sepolia value is P9-4's. */
export const EVM_DEFAULT_MAX_FEE_PER_GAS_WEI = 1_000_000_000_000n;

/** Which signing rule refused. */
export type EvmSignerRule = "chain-id" | "gas" | "fee";

/**
 * `signTransaction` refused to sign. `rule` names the check; `limit` is the configured bound as a decimal string (the pinned chain id,
 * the gas ceiling, the fee ceiling in wei). The observed transaction is deliberately NOT carried: no field of it is in the message or on
 * the error, because a claim's calldata is the secret.
 */
export class EvmSignerRefusedError extends Error {
  readonly rule: EvmSignerRule;
  readonly limit: string;
  /** viem and the vendored rail read `shortMessage` first; the same text, so a wrapped copy of this error never falls back to a dump. */
  readonly shortMessage: string;

  constructor(rule: EvmSignerRule, limit: string) {
    const text =
      rule === "chain-id"
        ? `the transaction's chain id is not the pinned chain id ${limit}`
        : rule === "gas"
          ? `the transaction's gas limit is missing or above the ceiling of ${limit} for one write`
          : `the transaction's fee cap is missing or above the ceiling of ${limit} wei (EvmRailConfig.maxFeePerGasWei)`;
    super(`evm-htlc: refusing to sign: ${text}`);
    this.name = "EvmSignerRefusedError";
    this.rule = rule;
    this.limit = limit;
    this.shortMessage = this.message;
  }
}

/** What a local account may sign: the pinned chain id, the gas ceiling and the fee ceiling (wei, applied to every fee field). */
export interface EvmSigningLimits {
  chainId: number;
  maxGas: bigint;
  maxFeePerGas: bigint;
}

/** Shared by the guard (which records a refusal) and the rail (which reads it back after viem and the vendored rail have wrapped the error). */
export interface EvmSignerWatch {
  refused: EvmSignerRefusedError | undefined;
}

/** A transaction field as a bigint: a bigint, or a safe-integer number; anything else (absent, a string, a float) is `undefined`. */
function amountOf(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return undefined;
}

/** The first rule `transaction` breaks, or `undefined`. Pure; reads three fee fields, the gas limit and the chain id only. */
export function signingRefusal(transaction: unknown, limits: EvmSigningLimits): EvmSignerRefusedError | undefined {
  const tx = (typeof transaction === "object" && transaction !== null ? transaction : {}) as Record<string, unknown>;
  const chainId = amountOf(tx.chainId);
  if (chainId === undefined || chainId !== BigInt(limits.chainId)) return new EvmSignerRefusedError("chain-id", String(limits.chainId));
  const gas = amountOf(tx.gas);
  if (gas === undefined || gas > limits.maxGas) return new EvmSignerRefusedError("gas", String(limits.maxGas));
  const caps = [tx.maxFeePerGas, tx.gasPrice, tx.maxPriorityFeePerGas];
  const present = caps.filter((cap) => cap !== undefined);
  // An EIP-1559 transaction names maxFeePerGas and a legacy one gasPrice: one of them must be there, and every fee field that is must be bounded.
  const unbounded = tx.maxFeePerGas === undefined && tx.gasPrice === undefined;
  const tooHigh = present.some((cap) => {
    const amount = amountOf(cap);
    return amount === undefined || amount > limits.maxFeePerGas;
  });
  if (unbounded || tooHigh) return new EvmSignerRefusedError("fee", String(limits.maxFeePerGas));
  return undefined;
}

/**
 * `account` (a sealed `LocalAccount` from `loadEvmLocalAccount`) with a `signTransaction` that refuses what `limits` forbids. The result
 * is sealed the same way the loader seals: frozen, `address` and `type: "local"` the only enumerable members, the signing functions
 * non-enumerable, `toJSON`, `toString` and `util.inspect` answering with the address and type only. A refusal is also recorded in `watch`
 * (when given) so the rail can throw the typed error itself after viem has wrapped it.
 */
export function guardLocalAccount(account: LocalAccount, limits: EvmSigningLimits, watch?: EvmSignerWatch): LocalAccount {
  const signTransaction = async (transaction: unknown, options?: unknown): Promise<unknown> => {
    const refused = signingRefusal(transaction, limits);
    if (refused !== undefined) {
      if (watch !== undefined) watch.refused = refused;
      throw refused;
    }
    return (account.signTransaction as (transaction: unknown, options?: unknown) => Promise<unknown>)(transaction, options);
  };
  const wrapped = {
    address: account.address,
    type: "local",
    source: "privateKey",
    publicKey: account.publicKey,
    sign: account.sign,
    signAuthorization: account.signAuthorization,
    signMessage: account.signMessage,
    signTypedData: account.signTypedData,
    signTransaction,
  };
  return sealLocalAccount(wrapped as unknown as LocalAccount);
}

/** The provider shape viem's `custom` transport takes: just `request`. */
export interface EvmRequestProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/**
 * `provider` with `eth_fillTransaction` answered here, as a JSON-RPC method-not-found error (-32601), never asked of the endpoint and so
 * never captured as an exchange. viem then takes the chain id from the pinned chain and reads the nonce, the block, the fees and the gas
 * estimate individually. Every other method goes through unchanged.
 */
export function refuseFillTransaction(provider: EvmRequestProvider): EvmRequestProvider {
  return {
    async request(args) {
      if (args.method === "eth_fillTransaction") {
        throw new RpcCaptureError(-32601, "the method eth_fillTransaction does not exist/is not available (this build never lets an endpoint fill a transaction it signs)");
      }
      return provider.request(args);
    },
  };
}
