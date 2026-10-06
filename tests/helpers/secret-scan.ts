// SPDX-License-Identifier: MIT
//
// The secret scan of the P8 persistence (P8-RESUME-SPEC.md "Tests", rule 5): what a flow writes to its store may hold the swap preimage
// only in the Seller's record, and no store entry may name a key-material field (the field names and markers the four rails' fixture
// key scans refuse) or carry any key a test world derived its keys from.

import { base58, base64, base64url } from "@scure/base";

import type { MemoryFlowStore } from "../../src/client/flow-store.js";
import { containsSecret, storeTexts, type Role, type World } from "./crash-matrix.js";
import { FORBIDDEN_FIELD_PATTERN } from "./flow-record-samples.js";

/** Every text form a 32-byte seed takes: hex (both cases), base64 and base64url (with and without padding), base58, and a JSON array. */
export function seedForms(seed: Uint8Array): string[] {
  const hex = Buffer.from(seed).toString("hex");
  return [
    hex,
    hex.toUpperCase(),
    base64.encode(seed),
    base64.encode(seed).replace(/=+$/, ""),
    base64url.encode(seed),
    base64url.encode(seed).replace(/=+$/, ""),
    base58.encode(seed),
    JSON.stringify(Array.from(seed)),
    Array.from(seed).join(","),
  ];
}

/** What is wrong with `text`, as sentences: a forbidden field name or marker, or a seed the world derived a key from. */
export function keyMaterialProblems(text: string, label: string, seeds: readonly Uint8Array[]): string[] {
  const problems: string[] = [];
  const hit = FORBIDDEN_FIELD_PATTERN.exec(text);
  if (hit !== null) problems.push(`${label}: the forbidden token ${JSON.stringify(hit[0])}`);
  for (const seed of seeds) {
    for (const form of seedForms(seed)) {
      if (text.includes(form)) problems.push(`${label}: a key seed (${form.slice(0, 8)}...)`);
    }
  }
  return problems;
}

/** The whole scan of one world's two stores after a run: every historical save of both roles, and the key names of the stores. */
export async function scanStores(w: World): Promise<string[]> {
  const problems: string[] = [];
  const roles: Role[] = ["buyer", "seller"];
  for (const role of roles) {
    const store: MemoryFlowStore = w.stores[role];
    storeTexts(store).forEach((text, index) => {
      const label = `${w.name} ${role} store save ${index + 1}`;
      problems.push(...keyMaterialProblems(text, label, w.keySeeds));
      if (role === "buyer" && containsSecret(text, w.hashLock)) problems.push(`${label}: the swap preimage (only the Seller's record may hold it)`);
      if (role === "buyer" && /"preimage"/.test(text)) problems.push(`${label}: a preimage field in a Buyer record`);
    });
    for (const key of await store.list()) problems.push(...keyMaterialProblems(key, `${w.name} ${role} store key`, w.keySeeds));
  }
  return problems;
}
