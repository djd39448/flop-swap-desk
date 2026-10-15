// SPDX-License-Identifier: MIT
//
// tests-regtest/helpers/claim.ts: P10 B7. A Bitcoin claim counts as LANDED only once it is mined, and a regtest node never mines on its own, so the first
// `SellerFlow.claimLegA` of a swap broadcasts the claim (and posts the reveal) and then throws `ClaimNotMinedError`; a block settles it on the next call.
// These two helpers say that once for every regtest scenario that used to call `claimLegA` and get the receipt back.

import type { RailWriteEvidence } from "../../src/client/counter-rail.js";
import { ClaimNotMinedError, type SellerFlow } from "../../src/client/seller.js";

type ClaimResult = Awaited<ReturnType<SellerFlow["claimLegA"]>>;

/** The Seller's `claimLegA`, which must broadcast the claim and stop at `ClaimNotMinedError` (the claim is in the node's mempool, nothing is mined). Returns that error. */
export async function claimBroadcast(seller: SellerFlow, hashLock: string, options?: { skipReveal?: boolean }): Promise<ClaimNotMinedError> {
  const outcome = await seller.claimLegA(hashLock, options).then(
    () => "returned" as const,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ClaimNotMinedError)) {
    throw new Error(`test: the claim was expected to be broadcast and not mined, got ${outcome === "returned" ? "a landed claim" : outcome instanceof Error ? `${outcome.name}: ${outcome.message}` : String(outcome)}`);
  }
  return outcome;
}

/** `claimBroadcast`, then `mine()`, then `claimLegA` again: the claim settles. `broadcast` is the evidence of the write (its `raw` hashes resolve to the claim's exchanges). */
export async function claimAndMine(
  seller: SellerFlow,
  hashLock: string,
  mine: () => Promise<unknown>,
  options?: { skipReveal?: boolean },
): Promise<{ broadcast: RailWriteEvidence; claimed: ClaimResult }> {
  const pending = await claimBroadcast(seller, hashLock, options);
  await mine();
  return { broadcast: pending.evidence, claimed: await seller.claimLegA(hashLock, options) };
}
