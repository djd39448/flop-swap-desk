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
//
// D1 (fix list round 1, C7): the secret key is a REAL private field (an ES `#secretKey`, not
// TypeScript's `private`, which is erased at compile time and leaves the value an ordinary
// enumerable property on the runtime object — reachable by `JSON.stringify`, `util.inspect`,
// `Object.keys`/`Reflect.ownKeys`, and structured-clone alike). `toJSON()` and
// `[util.inspect.custom]()` below are the only two ways this class's own bytes ever reach a
// string or a logged object, and both return only `accountId`/`publicKey` — never `secretKey` or
// `publicKeyBytes`. This is the class's own answer to D-N2's "never logs or returns the secret
// key from anywhere on this class": with a real private field, no serializer or inspector can
// walk to it by accident, whereas the old `private readonly secretKey` was a compile-time-only
// label that `JSON.stringify(signer)` and `util.inspect(signer)` would both have happily printed.

import { inspect } from "node:util";

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
  #secretKey: Uint8Array;
  private readonly publicKeyBytes: Uint8Array;

  private constructor(accountId: string, secretKey: Uint8Array, publicKeyBytes: Uint8Array) {
    this.accountId = accountId;
    this.#secretKey = secretKey;
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

  /** D-N2 (NB-int only): reconstructs the signer for the sandbox's OWN pre-generated validator
   *  account (`test.near`) from its `validator_key.json` `secret_key` string — the ONLY key this
   *  build ever reads off disk, and only through `wsl.exe -- cat` straight into memory, never
   *  written to disk on the Windows side, never logged (`tests-near/helpers/sandbox.ts` is the
   *  sole caller). NEAR's own `secret_key` wire format is `"ed25519:<base58(64 bytes)>"`, where
   *  the 64 bytes are `seed(32) || publicKey(32)` — the same nacl/libsodium "extended secret key"
   *  convention `@noble/curves/ed25519`'s own `keygen(seed)` already expects for its `seed`
   *  parameter (confirmed empirically against a real sandbox-generated key: the seed's own
   *  derived public key equals the file's own `public_key`, checked by the caller). Only the
   *  first 32 bytes (the seed) are ever used; the trailing 32 (the public key) are re-derived by
   *  `keygen` itself, never trusted blindly from the file. */
  static fromNearSecretKey(accountId: string, secretKey: string): InMemoryNearSigner {
    // D4: no error message here ever includes a character of the input (not a prefix, not a
    // base58 decoder's "unknown letter"): the input is a secret key.
    const prefix = "ed25519:";
    if (!secretKey.startsWith(prefix)) {
      throw new Error("near-signer-memory: unsupported secret key format (only ed25519: is supported)");
    }
    let decoded: Uint8Array;
    try {
      decoded = base58.decode(secretKey.slice(prefix.length));
    } catch {
      throw new Error("near-signer-memory: secret key is not valid base58");
    }
    if (decoded.length !== 64) {
      throw new Error("near-signer-memory: ed25519 secret key must decode to exactly 64 bytes (seed || publicKey)");
    }
    const seed = decoded.slice(0, 32);
    return InMemoryNearSigner.generate(accountId, seed);
  }

  /** The raw 32-byte public key — what `near-htlc.ts` embeds in a `TransactionV0.publicKey`. */
  publicKeyRaw(): Uint8Array {
    return this.publicKeyBytes;
  }

  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.#secretKey);
  }

  /** `JSON.stringify(signer)` (directly, or nested inside a rail or a sandbox handle) sees only
   *  this — never `#secretKey` or `publicKeyBytes`. */
  toJSON(): { accountId: string; publicKey: string } {
    return { accountId: this.accountId, publicKey: this.publicKey };
  }

  /** `util.inspect(signer)` (directly, or nested via `console.log`/Node's own default object
   *  formatting) sees only this — same fields as `toJSON()`, same reason. */
  [inspect.custom](): string {
    return `InMemoryNearSigner ${inspect({ accountId: this.accountId, publicKey: this.publicKey })}`;
  }
}
