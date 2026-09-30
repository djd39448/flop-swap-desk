// SPDX-License-Identifier: MIT
//
// tests/near-signer-memory.test.ts — P5-NEAR-FIXES.md D1 [C7]: `InMemoryNearSigner`'s own secret
// key lives in an ES `#secretKey` field (a real, engine-enforced private field, invisible to
// every reflection API), not TypeScript's `private` (a compile-time-only label that leaves the
// value an ordinary enumerable runtime property). This file proves the key bytes never reach
// `JSON.stringify` or `util.inspect` output for three shapes the fix list names explicitly: the
// signer itself, a rail that holds one (`createNearCounterRail`'s own `NearCounterRail`), and an
// object shaped like `tests-near/helpers/sandbox.ts`'s own `NearSandboxHandle` (a plain object
// whose `buyer`/`seller` fields nest a signer) — without needing a real sandbox, since the leak
// this fix closes lives entirely in the signer class itself and any object nesting it inherits
// the fix automatically through `toJSON`/`[util.inspect.custom]`'s own recursive use by both
// `JSON.stringify` and `util.inspect`.

import { inspect } from "node:util";

import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { NEAR_SANDBOX_PIN, type NearRailConfig } from "../src/rails/near-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { createNearCounterRail } from "../src/client/near-rail.js";

// A 64-byte "seed || publicKey" secret key, base58-encoded exactly the way NEAR's own
// `validator_key.json` and `fromNearSecretKey`'s own input do it — the shape whose leak this fix
// closes. Built from a real keypair (not a random string) so a naive substring/length scan of
// the output would have a real chance to catch it if the fix regressed.
function realSecretKeyWireForm(): { accountId: string; secretKeyWire: string; signer: InMemoryNearSigner } {
  const accountId = "leak-check.near-sandbox-flop";
  const seed = new Uint8Array(32).fill(9);
  const signer = InMemoryNearSigner.generate(accountId, seed);
  const secretKeyWire = `ed25519:${base58.encode(new Uint8Array([...seed, ...signer.publicKeyRaw()]))}`;
  return { accountId, secretKeyWire, signer };
}

/** Every base58 substring of `text` at least 40 characters long — long enough to contain a
 *  32-byte seed or a 64-byte secret key's own encoding, so this catches a leak in ANY position,
 *  not only a field literally named `secretKey`. */
function base58RunsAtLeast(text: string, minLength: number): string[] {
  const matches = text.match(/[1-9A-HJ-NP-Za-km-z]+/g) ?? [];
  return matches.filter((run) => run.length >= minLength);
}

function assertNoKeyBytes(value: unknown, seed: Uint8Array) {
  const json = JSON.stringify(value);
  const inspected = inspect(value, { depth: 10 });
  for (const text of [json, inspected]) {
    // The raw 32-byte seed must not appear verbatim, base58-encoded, in either serialization.
    expect(text).not.toContain(base58.encode(seed));
    // Nor must ANY sufficiently long base58 run appear at all -- a public key alone (32 bytes,
    // "ed25519:" + ~44 base58 chars) is fine and expected to appear; a run this long (>= 60 base58
    // chars, comfortably past a 32-byte public key's own ~44-char encoding) would only ever arise
    // from a 64-byte secret-key-shaped value, which this signer must never emit.
    expect(base58RunsAtLeast(text, 60)).toEqual([]);
  }
}

describe("InMemoryNearSigner — D1: the secret key is a real private field", () => {
  it("JSON.stringify(signer) and util.inspect(signer) carry only accountId/publicKey, never the secret key", () => {
    const seed = new Uint8Array(32).fill(3);
    const signer = InMemoryNearSigner.generate("alice.near-sandbox-flop", seed);

    expect(JSON.stringify(signer)).toBe(JSON.stringify({ accountId: signer.accountId, publicKey: signer.publicKey }));
    expect(inspect(signer)).toContain(signer.accountId);
    expect(inspect(signer)).toContain(signer.publicKey);
    assertNoKeyBytes(signer, seed);
  });

  it("fromNearSecretKey's own reconstructed signer (the validator_key.json path) leaks nothing either", () => {
    const { accountId, secretKeyWire, signer: reference } = realSecretKeyWireForm();
    const signer = InMemoryNearSigner.fromNearSecretKey(accountId, secretKeyWire);
    expect(signer.publicKey).toBe(reference.publicKey);
    // Sanity: the wire-form input really does contain the seed (would fail the assertion below
    // if it did not -- proving the test is actually exercising something).
    expect(secretKeyWire.length).toBeGreaterThan(60);
    assertNoKeyBytes(signer, new Uint8Array(32).fill(9));
  });

  it("fromNearSecretKey's errors never echo a character of the input (D4)", () => {
    const inputs = [
      "secp256k1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo",
      "Q3zHkRvmXaPtWnE9sYdLuBc7",
      "ed25519:0OIl*#!?0OIl",
      `ed25519:${"1".repeat(20)}`,
    ];
    for (const input of inputs) {
      let message = "";
      try {
        InMemoryNearSigner.fromNearSecretKey("alice.near-sandbox-flop", input);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      const payload = input.slice(input.indexOf(":") + 1);
      for (let i = 0; i + 4 <= payload.length; i++) {
        expect(message).not.toContain(payload.slice(i, i + 4));
      }
    }
  });

  it("the #secretKey field is invisible to every reflection API, not merely omitted from toJSON/inspect", () => {
    const signer = InMemoryNearSigner.generate("bob.near-sandbox-flop");
    expect(Object.keys(signer)).not.toContain("secretKey");
    expect(Object.getOwnPropertyNames(signer)).not.toContain("secretKey");
    expect(Reflect.ownKeys(signer)).not.toContain("secretKey");
    // TypeScript's own compile-time `private` (still used for `publicKeyBytes`) does NOT hide a
    // field this way -- it remains an ordinary enumerable property. Confirms this test would
    // have caught the pre-fix shape (`private readonly secretKey`) had it still been in use: an
    // ES `#`-private field is the only one of the two that vanishes from these lists.
    expect(Object.getOwnPropertyNames(signer)).toContain("publicKeyBytes");
  });

  it("a rail holding a signer (createNearCounterRail) leaks nothing either", () => {
    const seed = new Uint8Array(32).fill(5);
    const signer = InMemoryNearSigner.generate("carol.near-sandbox-flop", seed);
    const config: NearRailConfig = {
      pin: NEAR_SANDBOX_PIN,
      endpoint: "http://127.0.0.1:9999",
      contract: "htlc.near-sandbox-flop",
      assets: { USDC: "usdc.near-sandbox-flop" },
      htlcCodeHash: "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT",
    };
    const rail = createNearCounterRail({
      config,
      rpc: new CapturingRpc({ endpoint: config.endpoint }),
      signer,
      clock: () => Date.now(),
    });
    assertNoKeyBytes(rail, seed);
  });

  it("an object shaped like NearSandboxHandle (buyer/seller nesting a signer) leaks nothing either", () => {
    const buyerSeed = new Uint8Array(32).fill(6);
    const sellerSeed = new Uint8Array(32).fill(7);
    const fakeHandleShape = {
      endpoint: "http://127.0.0.1:9999",
      buyer: { accountId: "buyer.test.near", signer: InMemoryNearSigner.generate("buyer.test.near", buyerSeed) },
      seller: { accountId: "seller.test.near", signer: InMemoryNearSigner.generate("seller.test.near", sellerSeed) },
      usdcToken: "usdc.test.near",
      htlcContract: "htlc.test.near",
    };
    assertNoKeyBytes(fakeHandleShape, buyerSeed);
    assertNoKeyBytes(fakeHandleShape, sellerSeed);
  });
});
