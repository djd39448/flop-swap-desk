// SPDX-License-Identifier: MIT
//
// tests/resume-secrets.test.ts - P8-RESUME-SPEC.md "Tests" (the scan of sample records for the forbidden field names) and rule 5 (the
// preimage is written to exactly one place, the Seller's own record), as a scan over everything the flows and the stores put on disk
// or into a store in this suite:
//   - the sample records every persistence test uses;
//   - the saves of real swaps on every harness (a whole run, and runs cut in the middle), both roles;
//   - the files a FileFlowStore writes, names included;
//   - the persistence sources themselves (no field named after key material).
// "Forbidden" is what the four rails' fixture key scans refuse: PEM markers, `PRIVATE KEY`, `mnemonic`, `seed phrase` and the field names
// `secret_key`, `private_key`, `secretKey`, `keypair`; plus any 32-byte seed a test world derived a key from, in every text form.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { encodeFlowRecord } from "../src/client/flow-record.js";
import { FileFlowStore, flowKey } from "../src/client/flow-store.js";
import { Controller, REFUND_BOTH, SETTLE, containsSecret, runScript } from "./helpers/crash-matrix.js";
import { identity } from "./helpers/identity.js";
import { SAMPLE_PREIMAGE, SAMPLE_SWAP_ID, sampleBuyerRecord, sampleRecords, sampleSellerRecord } from "./helpers/flow-record-samples.js";
import { WORLDS } from "./helpers/matrix-worlds.js";
import { keyMaterialProblems, scanStores, seedForms } from "./helpers/secret-scan.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("the scan has teeth", () => {
  const seed = new Uint8Array(32).fill(7);

  it("flags every forbidden field name and marker, and a key seed in each of its forms", () => {
    for (const planted of ['{"secret_key":"x"}', '{"private_key":"x"}', '{"secretKey":"x"}', '{"keypair":"x"}', "a mnemonic here", "the seed phrase", "-----BEGIN OPENSSH", "PRIVATE KEY"]) {
      expect(keyMaterialProblems(planted, "planted", [])).not.toEqual([]);
    }
    for (const form of seedForms(seed)) expect(keyMaterialProblems(`{"x":"${form}"}`, "planted", [seed])).not.toEqual([]);
  });

  it("passes a record that carries no key material", () => {
    expect(keyMaterialProblems(text(encodeFlowRecord(sampleBuyerRecord())), "buyer sample", [seed])).toEqual([]);
  });
});

describe("the sample records every persistence test uses", () => {
  it("name no key material, and only the Seller's holds the preimage", () => {
    for (const record of sampleRecords()) {
      const encoded = text(encodeFlowRecord(record));
      expect(keyMaterialProblems(encoded, `${record.role} sample`, [])).toEqual([]);
      expect(encoded.includes(SAMPLE_PREIMAGE.slice(2))).toBe(record.role === "seller");
    }
  });
});

describe.each(WORLDS)("the saves of real swaps: $name", ({ factory }) => {
  it("the world lists the seeds its parties' DID keys come from (so the scan looks for the right bytes)", () => {
    const w = factory(new Controller());
    const [buyerSeed, sellerSeed] = w.keySeeds;
    expect([identity(Buffer.from(buyerSeed!).toString("hex")).did, identity(Buffer.from(sellerSeed!).toString("hex")).did]).toEqual([w.dids.buyer, w.dids.seller]);
    expect(w.keySeeds.length).toBeGreaterThanOrEqual(2);
  });

  it("a whole swap settled: no forbidden name, no key seed, the secret only in the Seller's saves", async () => {
    const run = await runScript(factory, SETTLE, []);
    expect(await scanStores(run.world)).toEqual([]);
    expect(run.world.stores.seller.saves.some((save) => containsSecret(text(save.bytes), run.world.hashLock))).toBe(true); // the scan can see it
  });

  it("a whole swap refunded on both legs: the same", async () => {
    const run = await runScript(factory, REFUND_BOTH, []);
    expect(await scanStores(run.world)).toEqual([]);
  });

  it("a swap cut around the claim, the reveal and the leg B claim, then resumed: the same", async () => {
    const reference = await runScript(factory, SETTLE, []);
    const wanted = ["chain:claim", "chain:claim.send", "note:claim", "post:reveal"];
    const cuts = reference.world.ctl.actions.filter((action) => wanted.includes(action.what));
    expect(cuts.length).toBeGreaterThan(2);
    for (const action of cuts) {
      for (const mode of ["before", "after-store-fail", "after-store-ok"] as const) {
        const run = await runScript(factory, SETTLE, [{ n: action.n, mode }]);
        expect(await scanStores(run.world)).toEqual([]);
      }
    }
  });
});

describe("the files a FileFlowStore writes", () => {
  it("hold no key material, the Buyer's holds no preimage, the Seller's does, and nothing else is left in the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p8-secrets-"));
    try {
      const store = new FileFlowStore(dir);
      await store.save(flowKey("buyer", SAMPLE_SWAP_ID), encodeFlowRecord(sampleBuyerRecord()));
      await store.save(flowKey("seller", SAMPLE_SWAP_ID), encodeFlowRecord(sampleSellerRecord()));
      const names = (await readdir(dir)).sort();
      expect(names).toEqual([`buyer-${SAMPLE_SWAP_ID}.json`, `seller-${SAMPLE_SWAP_ID}.json`]); // no stray temp file
      for (const name of names) {
        const body = await readFile(join(dir, name), "utf8");
        expect(keyMaterialProblems(`${name}\n${body}`, name, [])).toEqual([]);
        expect(body.includes(SAMPLE_PREIMAGE.slice(2))).toBe(name.startsWith("seller-"));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the persistence sources", () => {
  it("name no field after key material (no secret_key, private_key, secretKey, keypair, mnemonic, seed phrase, PEM marker)", async () => {
    for (const file of ["flow-record.ts", "flow-store.ts", "flow-resume.ts"]) {
      const source = await readFile(new URL(`../src/client/${file}`, import.meta.url), "utf8");
      expect(keyMaterialProblems(source, file, [])).toEqual([]);
    }
  });
});
