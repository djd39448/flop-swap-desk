// SPDX-License-Identifier: MIT
//
// The swap profile (SPEC §3): how two tclk/1 offers declare themselves legs of one swap using
// only the signed `offer.job` field. No new frame types; no wire change. Everything here is a
// pure function over frames the tclk/1 decoder already validated. Fail closed: anything not
// exactly the documented shape is "not a swap leg", never a guess.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { OfferFrame } from "@flop-labs/tclk";
import { normalizeRailId } from "@flop-labs/tclk";

import {
  FLOP_ASSET,
  FLOP_RAIL,
  SWAP_ID_DOMAIN,
  SWAP_PROTO,
  type LegAContext,
  type LegBContext,
  type SwapContext,
} from "./types.js";

const HEX32 = /^0x[0-9a-f]{64}$/;
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const AMOUNT = /^[1-9][0-9]*$/;
const ASSET = /^[A-Za-z0-9_-]{1,32}$/;
const NONCE = /^[0-9a-f]{8,64}$/;

/** `0x` + sha256(`FLOP::swap::v1|<buyer did>|<nonce>`). The Buyer mints the nonce. */
export function swapId(buyerDid: string, nonce: string): string {
  if (!DID.test(buyerDid)) throw new Error("swap: buyer must be an Ed25519 did:key");
  if (!NONCE.test(nonce)) throw new Error("swap: nonce must be 8–64 lowercase hex chars");
  const preimage = `${SWAP_ID_DOMAIN}|${buyerDid}|${nonce}`;
  return `0x${bytesToHex(sha256(new TextEncoder().encode(preimage)))}`;
}

export function isSwapId(value: unknown): value is string {
  return typeof value === "string" && HEX32.test(value);
}

/** Encode leg A's context: what the Buyer wants for the counter-asset it pays. */
export function legAContext(want: Omit<LegAContext, "leg">): string {
  if (!ASSET.test(want.wantAsset)) throw new Error("swap: wantAsset is not a tclk asset id");
  if (!AMOUNT.test(want.wantAmount)) throw new Error("swap: wantAmount must be a decimal integer");
  const rail = normalizeRailId(want.wantRail);
  return `a|${want.wantAsset}|${want.wantAmount}|${rail}`;
}

/** Encode leg B's context: the leg A offer this FLOP leg answers. */
export function legBContext(legAOfferId: string): string {
  if (!HEX32.test(legAOfferId)) throw new Error("swap: legAOfferId must be a 0x-prefixed sha256");
  return `b|${legAOfferId}`;
}

/** Parse a `job.context`. Null on anything that is not exactly one of the two grammars. */
export function parseSwapContext(context: unknown): SwapContext | null {
  if (typeof context !== "string") return null;
  const parts = context.split("|");
  if (parts[0] === "a" && parts.length === 4) {
    const [, wantAsset, wantAmount, wantRail] = parts as [string, string, string, string];
    if (!ASSET.test(wantAsset) || !AMOUNT.test(wantAmount)) return null;
    let rail: string;
    try {
      rail = normalizeRailId(wantRail);
    } catch {
      return null;
    }
    if (rail !== wantRail) return null; // must already be canonical on the wire
    return { leg: "a", wantAsset, wantAmount, wantRail: rail };
  }
  if (parts[0] === "b" && parts.length === 2) {
    const legAOfferId = parts[1] as string;
    if (!HEX32.test(legAOfferId)) return null;
    return { leg: "b", legAOfferId };
  }
  return null;
}

export interface SwapLegClassification {
  swapId: string;
  context: SwapContext;
}

/**
 * Is this validated tclk/1 offer a swap leg? Returns its swap id and parsed context, or null.
 * Structural only — pairing, orientation and deadlines are checked in `pair.ts`/`deadlines.ts`.
 */
export function classifySwapOffer(offer: OfferFrame): SwapLegClassification | null {
  const job = offer.job;
  if (!job || job.proto !== SWAP_PROTO || !isSwapId(job.id)) return null;
  const context = parseSwapContext(job.context);
  if (context === null) return null;
  return { swapId: job.id, context };
}

export type OrientationVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * SPEC §3.1 (decision D-01): leg A is Buyer-opened as `payer` with a non-FLOP asset; leg B is
 * Seller-opened as `payer` with asset FLOP and rail set containing `flop-htlc`. Any other
 * orientation would move the secret away from the FLOP seller and flip R10.2.
 */
export function checkOrientation(offer: OfferFrame, context: SwapContext): OrientationVerdict {
  if (offer.role !== "payer") {
    return { ok: false, reason: `leg ${context.leg} must be opened by its payer (got role ${offer.role})` };
  }
  if (offer.lock !== "hash") {
    return { ok: false, reason: "v1 supports hash locks only" };
  }
  let rails: string[];
  try {
    rails = offer.rails.map(normalizeRailId);
  } catch {
    return { ok: false, reason: "offer names an unregistered rail" };
  }
  if (context.leg === "a") {
    if (offer.asset === FLOP_ASSET) {
      return { ok: false, reason: "leg A must pay a non-FLOP counter-asset" };
    }
    if (rails.includes(FLOP_RAIL)) {
      return { ok: false, reason: "leg A must not settle on flop-htlc" };
    }
    if (context.wantRail !== FLOP_RAIL) {
      return { ok: false, reason: `leg A must want ${FLOP_RAIL} (got ${context.wantRail})` };
    }
    return { ok: true };
  }
  if (offer.asset !== FLOP_ASSET) {
    return { ok: false, reason: `leg B must pay ${FLOP_ASSET} (got ${offer.asset})` };
  }
  if (!rails.includes(FLOP_RAIL)) {
    return { ok: false, reason: `leg B rails must include ${FLOP_RAIL}` };
  }
  return { ok: true };
}

/** The DID-note token a Seller adds beside tclk's own `tclk1:<rails>` token. A routing hint. */
export const SELLER_CAPABILITY_TOKEN = "swap1:sell-flop";

export function hasSellerCapability(note: string): boolean {
  return note.split(/\s+/).includes(SELLER_CAPABILITY_TOKEN);
}

export { LegAContext, LegBContext };
