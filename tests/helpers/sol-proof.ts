// SPDX-License-Identifier: MIT
//
// Test helper: a throwaway Solana wallet (an Ed25519 key derived from a fill byte, never a real key) and the
// P7 proven account line it would post (`ed25519` over `accountProofMessage`, SOL_RAIL_ID through the
// custom-rails registry).

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { accountProofMessage, formatSolAccountLine } from "../../src/rails/account-line.js";
import { SOL_RAIL_ID, createSolRailRegistry, type CustomRailRegistry } from "../../src/rails/custom-rails.js";
import { pubkeyToBase58 } from "../../src/rails/sol-tx.js";

export interface TestSolWallet {
  /** The base58 wallet address (= the Ed25519 public key). */
  address: string;
  sign(message: string): string;
}

/** A deterministic test wallet: secret = 32 bytes of `fill`. */
export function solWallet(fill: number): TestSolWallet {
  const secret = new Uint8Array(32).fill(fill);
  const pub = ed25519.getPublicKey(secret);
  return { address: pubkeyToBase58(pub), sign: (message) => bytesToHex(ed25519.sign(new TextEncoder().encode(message), secret)) };
}

/** The proven Solana account line `wallet` posts as `did` for `contract` on `caip2`. */
export function provenSolLine(
  wallet: TestSolWallet,
  did: string,
  contract: string,
  caip2: string,
  registry: CustomRailRegistry = createSolRailRegistry(),
): string {
  const message = accountProofMessage({ did, contract, railId: SOL_RAIL_ID, caip2, address: wallet.address }, registry);
  return formatSolAccountLine({ caip2, address: wallet.address, proof: { scheme: "ed25519", signature: wallet.sign(message) } }, registry);
}
