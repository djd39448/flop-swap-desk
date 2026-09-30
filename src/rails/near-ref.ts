// SPDX-License-Identifier: MIT
//
// The `near-htlc` lock ref (P5-NEAR-SQUAT-FIX.md, replacing D-N4): `0x<hash lock hex>:<payer
// account id>`. The contract keys every lock by (payer, hash lock) so a third party who locks
// under a public hash lock first can no longer block the real payer's own lock; the ref therefore
// has to name the payer too. It is known before any write (the payer is the Buyer's own signer),
// so record-before-send still holds. tclk's lock-frame `ref` is a free string; Bitcoin's
// `txid:vout` is the precedent for a compound one.
//
// One shared, pure helper: every place that builds, parses or compares a NEAR ref uses this file,
// so no caller re-implements the grammar. Anything that does not match exactly is invalid.

/** The NEAR account-id grammar this build accepts (no `:` — that is what makes the ref, and the
 *  contract's own `"<payer>:<hash lock>"` storage key, unambiguous). */
export const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

/** `0x` + 64 lowercase hex — tclk's own hash-statement grammar. */
export const NEAR_HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/;

export interface NearRef {
  /** `0x` + 64 lowercase hex. */
  hashLock: string;
  /** The account that locked the tokens (the lock's payer). */
  payer: string;
}

/** `0x<hash lock>:<payer>`. Throws on an invalid hash lock or payer, never returns a ref that
 *  `parseNearRef` would refuse. */
export function formatNearRef(hashLock: string, payer: string): string {
  if (!NEAR_HASH_LOCK_SHAPE.test(hashLock)) {
    throw new Error("near-htlc: hashLock must be 0x + 64 lowercase hex (sha256 statement)");
  }
  if (!NEAR_ACCOUNT_ID.test(payer)) {
    throw new Error("near-htlc: payer must be a valid NEAR account id");
  }
  return `${hashLock}:${payer}`;
}

/** Parses a NEAR ref, or returns `null` for anything that is not exactly
 *  `0x` + 64 lowercase hex + `:` + a valid NEAR account id. */
export function parseNearRef(ref: unknown): NearRef | null {
  if (typeof ref !== "string") return null;
  const colon = ref.indexOf(":");
  if (colon !== 66) return null; // "0x" + 64 hex is exactly 66 characters
  const hashLock = ref.slice(0, colon);
  const payer = ref.slice(colon + 1);
  if (!NEAR_HASH_LOCK_SHAPE.test(hashLock) || !NEAR_ACCOUNT_ID.test(payer)) return null;
  return { hashLock, payer };
}

/** Like `parseNearRef` but throws a caller-facing error. */
export function requireNearRef(ref: string): NearRef {
  const parsed = parseNearRef(ref);
  if (parsed === null) {
    throw new Error("near-htlc: ref must be 0x + 64 lowercase hex + ':' + a valid NEAR account id (payer)");
  }
  return parsed;
}
