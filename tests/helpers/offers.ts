// SPDX-License-Identifier: MIT
//
// Shared offer builders for tests: a well-formed swap pair (SPEC §3.2-§3.3) built with
// tclk's own `makeOffer`, so every test exercises the same frame-construction path a real
// client would. Deadlines are the caller's to set per scenario; everything else is fixed.

import { makeOffer, type OfferFrame } from "@flop-labs/tclk";
import { legAContext, legBContext, swapId } from "../../src/profile.js";
import { BUYER_DID, SELLER_DID } from "./identities.js";

/** Fixed swap nonce so `swapId` is deterministic across the test suite. */
export const SWAP_NONCE = "00000001";

/** `swapId(BUYER_DID, SWAP_NONCE)` — the one swap id every test-suite fixture shares. */
export const SWAP_ID = swapId(BUYER_DID, SWAP_NONCE);

export interface LegDeadlines {
  claimByMs: number;
  refundAfterMs: number;
  expiresMs?: number;
}

/** Leg A: Buyer pays USDC on `evm-htlc`, wants 52070000 FLOP back via `flop-htlc`. */
export function buildLegA(t0: number, deadlines: LegDeadlines): OfferFrame {
  return makeOffer({
    from: BUYER_DID,
    role: "payer",
    amount: "1000000",
    asset: "USDC",
    lock: "hash",
    rails: ["evm-htlc"],
    claimByMs: deadlines.claimByMs,
    refundAfterMs: deadlines.refundAfterMs,
    expiresMs: deadlines.expiresMs ?? t0 - 5 * 60_000,
    job: {
      proto: "swap",
      id: SWAP_ID,
      context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }),
    },
    nonce: "a1a1a1a1",
  });
}

/** Leg B: Seller pays 52070000 FLOP on `flop-htlc`, answering `legA`'s offer id. */
export function buildLegB(t0: number, legA: OfferFrame, deadlines: LegDeadlines): OfferFrame {
  return makeOffer({
    from: SELLER_DID,
    role: "payer",
    amount: "52070000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: deadlines.claimByMs,
    refundAfterMs: deadlines.refundAfterMs,
    expiresMs: deadlines.expiresMs ?? t0 - 4 * 60_000,
    job: {
      proto: "swap",
      id: SWAP_ID,
      context: legBContext(legA.id),
    },
    nonce: "b2b2b2b2",
  });
}

/** SPEC §3.5's worked example, verbatim (EVM L2 leg A, FLOP leg B, lock time `t0`). */
export function buildWorkedExample(t0: number): { legA: OfferFrame; legB: OfferFrame } {
  const legA = buildLegA(t0, {
    claimByMs: t0 + 45 * 60_000,
    refundAfterMs: t0 + 60 * 60_000,
  });
  const legB = buildLegB(t0, legA, {
    claimByMs: t0 + 70 * 60_000,
    refundAfterMs: t0 + 3 * 60 * 60_000,
  });
  return { legA, legB };
}
