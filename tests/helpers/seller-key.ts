// SPDX-License-Identifier: MIT
//
// A Seller record is keyed by leg A's tclk contract id, `seller:<contractA>` (R1-14), not by the swap id. A test that
// holds only a store and a swap id finds the Seller's record through the store's own listing: these helpers do that, and
// `plant` overwrites a stored value the way a test that edits a record on disk needs to (the store is a compare-and-swap,
// so the overwrite names the digest of what is there).

import { flowDigest, type FlowStore } from "../../src/client/flow-store.js";

/** The id a Seller resume is given when the store holds no Seller record at all (it names nothing, so resume must say
 *  "not found"). */
export const ABSENT_CONTRACT_A = `0x${"00".repeat(32)}`;

/** The `seller:<contractA>` key of the Seller record a store holds. Exactly one is expected. */
export async function sellerKeyOf(store: FlowStore): Promise<string> {
  const keys = (await store.list()).filter((key) => key.startsWith("seller:"));
  if (keys.length !== 1) throw new Error(`expected exactly one Seller record in the store, found ${keys.length}`);
  return keys[0] as string;
}

/** Leg A's contract id the Seller record in `store` is keyed by. */
export async function sellerContractA(store: FlowStore): Promise<string> {
  return (await sellerKeyOf(store)).slice("seller:".length);
}

/** The same, or `ABSENT_CONTRACT_A` when the store holds no Seller record. */
export async function sellerContractAOrAbsent(store: FlowStore): Promise<string> {
  const keys = (await store.list()).filter((key) => key.startsWith("seller:"));
  return keys.length === 1 ? (keys[0] as string).slice("seller:".length) : ABSENT_CONTRACT_A;
}

/** Overwrites what `store` holds under `key` with `bytes` (creates it when there is nothing). For tests that damage or
 *  edit a stored record: the compare-and-swap is satisfied with the digest of the current value. */
export async function plant(store: FlowStore, key: string, bytes: Uint8Array): Promise<void> {
  const current = await store.load(key);
  await store.save(key, bytes, current === null ? null : flowDigest(current));
}
