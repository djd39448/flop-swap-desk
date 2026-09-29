// SPDX-License-Identifier: MIT
//
// §1 (keyless build): the ONLY concrete `NearSigner` this build ever constructs — an ed25519
// keypair generated in process memory (`@noble/curves/ed25519`'s own `keygen`), used solely by
// tests and the (later, NB-int) sandbox harness. Never persists a key to disk, never logs or
// returns the secret key from anywhere on this class, and this file is never imported by
// `near-htlc.ts` or any other production module — a caller must import it by name to get one, so
// nothing in this build's own wiring can ever reach a real key by accident. Mirrors the Bitcoin/
// EVM legs' own keyless rule (D-10/P4-BTC-SPEC.md §1): no private key, WIF, xprv, seed or
// mnemonic for either party lives anywhere else in this build.
//
// Design source: flop-contrib/handoff/P5-NEAR-SPEC.md §1;
// flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md D-N2.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

import type { NearSigner } from "./near-htlc.js";

/**
 * An in-memory ed25519 signer. `accountId` is whatever the caller says it is — this class never
 * asserts that the account and the key actually correspond on any chain; the (later) sandbox
 * harness is responsible for creating an account keyed to this exact public key before this
 * signer is used to sign anything for it. `publicKey` is NEAR's own `"ed25519:<base58>"` string
 * form, the same shape `view_access_key`'s own `public_key` param and `AddKey`'s own on-chain
 * key both use.
 */
export class InMemoryNearSigner implements NearSigner {
  readonly accountId: string;
  readonly publicKey: string;
  private readonly secretKey: Uint8Array;
  private readonly publicKeyBytes: Uint8Array;

  private constructor(accountId: string, secretKey: Uint8Array, publicKeyBytes: Uint8Array) {
    this.accountId = accountId;
    this.secretKey = secretKey;
    this.publicKeyBytes = publicKeyBytes;
    this.publicKey = `ed25519:${base58.encode(publicKeyBytes)}`;
  }

  /** Generates a fresh keypair. `seed`, when given, is ONLY ever a deterministic value for a
   *  test fixture (e.g. `new Uint8Array(32).fill(1)`) — never read from env, disk, or anywhere
   *  else a real value could reach it. Omitted, this uses `@noble/curves`'s own CSPRNG. */
  static generate(accountId: string, seed?: Uint8Array): InMemoryNearSigner {
    const keys = ed25519.keygen(seed);
    return new InMemoryNearSigner(accountId, keys.secretKey, keys.publicKey);
  }

  /** The raw 32-byte public key — what `near-htlc.ts` embeds in a `TransactionV0.publicKey`. */
  publicKeyRaw(): Uint8Array {
    return this.publicKeyBytes;
  }

  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.secretKey);
  }
}
