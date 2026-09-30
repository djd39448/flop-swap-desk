// SPDX-License-Identifier: MIT
//
// The ONLY concrete `SolSigner` this build constructs (P6-SOL-SPEC.md section 1): an ed25519 keypair
// generated in process memory, for tests and the SB-int harness. It never persists a key, never returns
// or logs the secret, and no production module imports this file (`sol-htlc.ts` only sees the `SolSigner`
// interface), so nothing in this build's wiring can reach a real key by accident. Mirrors
// `near-signer-memory.ts` (NEAR D1): the secret key is an ES `#private` field, not TypeScript's
// erased-at-compile-time `private`, so `JSON.stringify`, `util.inspect`, `Object.keys`, `Reflect.ownKeys`
// and structured clone cannot reach it; `toJSON` and `[inspect.custom]` return only the public key.
//
// The account and the key are only ever tied together by the caller (the SB-int harness funds this public
// key through the validator faucet's `requestAirdrop`); there is no way to import a key from a file or
// from the environment here on purpose: `generate(seed)` takes an in-memory seed that exists only for
// deterministic hermetic tests.

import { inspect } from "node:util";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

import type { SolSigner } from "./sol-htlc.js";

export class InMemorySolSigner implements SolSigner {
  /** base58 of the 32-byte public key (the account address). */
  readonly publicKey: string;
  readonly publicKeyBytes: Uint8Array;
  #secretKey: Uint8Array;

  private constructor(secretKey: Uint8Array, publicKeyBytes: Uint8Array) {
    this.#secretKey = secretKey;
    this.publicKeyBytes = publicKeyBytes;
    this.publicKey = base58.encode(publicKeyBytes);
  }

  /** A fresh keypair. `seed`, when given, is only ever a deterministic test value (for example
   *  `new Uint8Array(32).fill(1)`), never read from env or disk by this class. Omitted, the CSPRNG is used. */
  static generate(seed?: Uint8Array): InMemorySolSigner {
    if (seed !== undefined && seed.length !== 32) throw new Error("sol-signer-memory: a seed is exactly 32 bytes");
    const keys = ed25519.keygen(seed);
    return new InMemorySolSigner(keys.secretKey, keys.publicKey);
  }

  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.#secretKey);
  }

  /** `JSON.stringify(signer)` (directly or nested in a rail or a harness handle) sees only this. */
  toJSON(): { publicKey: string } {
    return { publicKey: this.publicKey };
  }

  /** `util.inspect(signer)` (directly or nested via `console.log`) sees only this. */
  [inspect.custom](): string {
    return `InMemorySolSigner ${inspect({ publicKey: this.publicKey })}`;
  }
}
