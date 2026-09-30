// SPDX-License-Identifier: MIT
//
// tests/sol-signer-memory.test.ts - the secret key is a REAL private field (NEAR D1's rule): it never reaches
// JSON.stringify, util.inspect, Object.keys / Reflect.ownKeys, structured clone or a rail that holds the
// signer. Mirrors tests/near-signer-memory.test.ts.

import { inspect } from "node:util";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { SolHtlcRail } from "../src/rails/sol-htlc.js";
import { InMemorySolSigner } from "../src/rails/sol-signer-memory.js";
import { makeWorld } from "./helpers/sol-fake-chain.js";

const SEED = new Uint8Array(32).fill(9);

function assertNoKeyBytes(value: unknown, signer: InMemorySolSigner): void {
  const seedB58 = base58.encode(SEED);
  const seedHex = Buffer.from(SEED).toString("hex");
  for (const text of [JSON.stringify(value), inspect(value, { depth: 10 })]) {
    expect(text).not.toContain(seedB58);
    expect(text).not.toContain(seedHex);
    expect(text).not.toMatch(/secret/i);
    expect(text).toContain(signer.publicKey);
    // no base58 run long enough to be a 64-byte secret key (a public key is at most 44 characters)
    expect((text.match(/[1-9A-HJ-NP-Za-km-z]{60,}/g) ?? []).length).toBe(0);
  }
}

describe("InMemorySolSigner", () => {
  it("signs verifiably and reports its public key in base58", () => {
    const signer = InMemorySolSigner.generate(SEED);
    const sig = signer.sign(new Uint8Array([1, 2, 3]));
    expect(ed25519.verify(sig, new Uint8Array([1, 2, 3]), signer.publicKeyBytes)).toBe(true);
    expect(signer.publicKey).toBe(base58.encode(signer.publicKeyBytes));
    expect(signer.publicKeyBytes).toEqual(ed25519.keygen(SEED).publicKey);
  });

  it("JSON.stringify and util.inspect carry only the public key", () => {
    const signer = InMemorySolSigner.generate(SEED);
    assertNoKeyBytes(signer, signer);
    expect(JSON.parse(JSON.stringify(signer))).toEqual({ publicKey: signer.publicKey });
  });

  it("the secret is not reachable by reflection: no own key, no symbol, no enumerable field holds it", () => {
    const signer = InMemorySolSigner.generate(SEED);
    const names = [...Object.getOwnPropertyNames(signer), ...Object.getOwnPropertySymbols(signer).map(String)];
    expect(names.sort()).toEqual(["publicKey", "publicKeyBytes"].sort());
    for (const key of Reflect.ownKeys(signer)) {
      const v = (signer as unknown as Record<string | symbol, unknown>)[key];
      if (v instanceof Uint8Array) expect(Buffer.from(v).toString("hex")).not.toContain(Buffer.from(SEED).toString("hex"));
    }
  });

  it("a rail holding a signer, and a harness-shaped handle nesting two signers, do not leak either", async () => {
    const w = makeWorld();
    const signer = InMemorySolSigner.generate(SEED);
    const rail = await SolHtlcRail.connect({ config: w.config, rpc: w.rpc, signer });
    assertNoKeyBytes({ rail, signer }, signer);
    assertNoKeyBytes({ buyer: signer, seller: InMemorySolSigner.generate(new Uint8Array(32).fill(4)), endpoint: "x" }, signer);
  });

  it("refuses a seed that is not 32 bytes, and generates distinct keys without a seed", () => {
    expect(() => InMemorySolSigner.generate(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(InMemorySolSigner.generate().publicKey).not.toBe(InMemorySolSigner.generate().publicKey);
  });
});
