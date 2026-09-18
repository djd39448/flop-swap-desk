// SPDX-License-Identifier: MIT
//
// Tests for src/profile.ts (SPEC §3): swap ids, context grammars, structural
// classification, and orientation (decision D-01). profile.ts is not rewritten here —
// only exercised.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generatePointLock, type OfferFrame } from "@flop-labs/tclk";
import {
  SELLER_CAPABILITY_TOKEN,
  checkOrientation,
  classifySwapOffer,
  hasSellerCapability,
  legAContext,
  legBContext,
  parseSwapContext,
  swapId,
} from "../src/profile.js";
import type { LegAContext, LegBContext, SwapContext } from "../src/types.js";
import { BUYER_DID, SELLER_DID } from "./helpers/identities.js";
import { buildLegA, buildLegB, SWAP_ID } from "./helpers/offers.js";

const T0 = 1_735_000_000_000;

describe("swapId", () => {
  it("is 0x + sha256(FLOP::swap::v1|<buyer did>|<nonce>) — computed independently here", () => {
    const nonce = "00000001";
    const expected = `0x${bytesToHex(sha256(new TextEncoder().encode(`FLOP::swap::v1|${BUYER_DID}|${nonce}`)))}`;
    expect(swapId(BUYER_DID, nonce)).toBe(expected);
  });

  it("is deterministic", () => {
    expect(swapId(BUYER_DID, "00000001")).toBe(swapId(BUYER_DID, "00000001"));
  });

  it("differs when the buyer or the nonce differs", () => {
    expect(swapId(BUYER_DID, "00000001")).not.toBe(swapId(BUYER_DID, "00000002"));
    expect(swapId(BUYER_DID, "00000001")).not.toBe(swapId(SELLER_DID, "00000001"));
  });

  it("throws on a malformed buyer did or nonce", () => {
    expect(() => swapId("not-a-did", "00000001")).toThrow();
    expect(() => swapId(BUYER_DID, "not-hex")).toThrow();
    expect(() => swapId(BUYER_DID, "")).toThrow();
  });
});

describe("legAContext / legBContext round-trip through parseSwapContext", () => {
  it("leg A", () => {
    const ctx = legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" });
    expect(ctx).toBe("a|FLOP|52070000|flop-htlc");
    const parsed = parseSwapContext(ctx);
    const expected: LegAContext = { leg: "a", wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" };
    expect(parsed).toEqual(expected);
  });

  it("leg B", () => {
    const legAOfferId = `0x${"a".repeat(64)}`;
    const ctx = legBContext(legAOfferId);
    expect(ctx).toBe(`b|${legAOfferId}`);
    const parsed = parseSwapContext(ctx);
    const expected: LegBContext = { leg: "b", legAOfferId };
    expect(parsed).toEqual(expected);
  });

  it("legAContext throws on a bad amount or asset", () => {
    expect(() => legAContext({ wantAsset: "FLOP", wantAmount: "0", wantRail: "flop-htlc" })).toThrow();
    expect(() => legAContext({ wantAsset: "FLOP", wantAmount: "01", wantRail: "flop-htlc" })).toThrow();
    expect(() => legAContext({ wantAsset: "FL/OP", wantAmount: "1", wantRail: "flop-htlc" })).toThrow();
  });

  it("legBContext throws on a non-offer-id string", () => {
    expect(() => legBContext("not-a-contract-id")).toThrow();
  });
});

describe("parseSwapContext — malformed input returns null, never throws", () => {
  const legAOfferId = `0x${"b".repeat(64)}`;

  const cases: Array<[string, unknown]> = [
    ["not a string", 42],
    ["not a string (undefined)", undefined],
    ["not a string (object)", { leg: "a" }],
    ["empty string", ""],
    ["leg a, too few parts", "a|FLOP|100"],
    ["leg a, too many parts", "a|FLOP|100|flop-htlc|extra"],
    ["leg a, non-canonical rail spelling FLOP-HTLC", "a|FLOP|100|FLOP-HTLC"],
    ["leg a, non-canonical rail spelling with trailing dot", "a|FLOP|100|flop-htlc."],
    ["leg a, unregistered rail", "a|FLOP|100|not-a-rail"],
    ["leg a, bad amount zero", "a|FLOP|0|flop-htlc"],
    ["leg a, bad amount leading zero", "a|FLOP|01|flop-htlc"],
    ["leg a, bad amount non-numeric", "a|FLOP|abc|flop-htlc"],
    ["leg a, bad asset (slash)", "a|FL/OP|100|flop-htlc"],
    ["leg a, bad asset (empty)", "a||100|flop-htlc"],
    ["leg b, too few parts", "b"],
    ["leg b, too many parts", `b|${legAOfferId}|extra`],
    ["leg b, offer id not hex32", "b|not-a-contract-id"],
    ["leg b, offer id missing 0x", `b|${legAOfferId.slice(2)}`],
    ["unknown leg letter", `c|${legAOfferId}`],
  ];

  it.each(cases)("%s", (_label, input) => {
    expect(() => parseSwapContext(input as never)).not.toThrow();
    expect(parseSwapContext(input as never)).toBeNull();
  });
});

describe("classifySwapOffer", () => {
  const legA = buildLegA(T0, { claimByMs: T0 + 45 * 60_000, refundAfterMs: T0 + 60 * 60_000 });
  const legB = buildLegB(T0, legA, { claimByMs: T0 + 70 * 60_000, refundAfterMs: T0 + 3 * 60 * 60_000 });

  it("classifies a well-formed leg A offer", () => {
    expect(classifySwapOffer(legA)).toEqual({
      swapId: SWAP_ID,
      context: { leg: "a", wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" },
    });
  });

  it("classifies a well-formed leg B offer", () => {
    expect(classifySwapOffer(legB)).toEqual({
      swapId: SWAP_ID,
      context: { leg: "b", legAOfferId: legA.id },
    });
  });

  it("rejects a proto mismatch", () => {
    const notASwap: OfferFrame = { ...legA, job: { ...legA.job!, proto: "a2a" } };
    expect(classifySwapOffer(notASwap)).toBeNull();
  });

  it("rejects an offer with no job at all", () => {
    const { job: _job, ...rest } = legA;
    const noJob = rest as OfferFrame;
    expect(classifySwapOffer(noJob)).toBeNull();
  });

  it("rejects a malformed job.id", () => {
    const badId: OfferFrame = { ...legA, job: { ...legA.job!, id: "not-a-swap-id" } };
    expect(classifySwapOffer(badId)).toBeNull();
  });

  it("rejects a malformed job.context", () => {
    const badContext: OfferFrame = { ...legA, job: { ...legA.job!, context: "z|nonsense" } };
    expect(classifySwapOffer(badContext)).toBeNull();
  });
});

describe("checkOrientation (SPEC §3.1, decision D-01)", () => {
  const legA = buildLegA(T0, { claimByMs: T0 + 45 * 60_000, refundAfterMs: T0 + 60 * 60_000 });
  const legB = buildLegB(T0, legA, { claimByMs: T0 + 70 * 60_000, refundAfterMs: T0 + 3 * 60 * 60_000 });
  const legAContextValue: LegAContext = { leg: "a", wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" };
  const legBContextValue: LegBContext = { leg: "b", legAOfferId: legA.id };

  it("accepts a well-formed leg A (Buyer-opened, payer, non-FLOP asset)", () => {
    expect(checkOrientation(legA, legAContextValue)).toEqual({ ok: true });
  });

  it("accepts a well-formed leg B (Seller-opened, payer, FLOP asset, flop-htlc rail)", () => {
    expect(checkOrientation(legB, legBContextValue)).toEqual({ ok: true });
  });

  it("rejects payee-opened offers (D-01: bids are Buyer-initiated)", () => {
    const payeeOpened = buildLegA(T0, {
      claimByMs: T0 + 45 * 60_000,
      refundAfterMs: T0 + 60 * 60_000,
    });
    const asPayee: OfferFrame = { ...payeeOpened, role: "payee" };
    const verdict = checkOrientation(asPayee, legAContextValue);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/must be opened by its payer/);
  });

  it("rejects point locks (v1 is hash-lock only)", () => {
    const point = generatePointLock();
    const pointOffer: OfferFrame = { ...legA, lock: "point", paymentKey: point.statement };
    const verdict = checkOrientation(pointOffer, legAContextValue);
    expect(verdict).toEqual({ ok: false, reason: "v1 supports hash locks only" });
  });

  it("rejects an offer naming an unregistered rail", () => {
    const brokenRails: OfferFrame = { ...legA, rails: ["not-a-registered-rail"] };
    const verdict = checkOrientation(brokenRails, legAContextValue);
    expect(verdict).toEqual({ ok: false, reason: "offer names an unregistered rail" });
  });

  it("rejects leg A paying FLOP", () => {
    const paysFlop: OfferFrame = { ...legA, asset: "FLOP" };
    const verdict = checkOrientation(paysFlop, legAContextValue);
    expect(verdict).toEqual({ ok: false, reason: "leg A must pay a non-FLOP counter-asset" });
  });

  it("rejects leg A settling on flop-htlc", () => {
    const settlesOnFlop: OfferFrame = { ...legA, rails: ["evm-htlc", "flop-htlc"] };
    const verdict = checkOrientation(settlesOnFlop, legAContextValue);
    expect(verdict).toEqual({ ok: false, reason: "leg A must not settle on flop-htlc" });
  });

  it("rejects leg A wanting a non-flop-htlc rail", () => {
    const wantsOther: LegAContext = { ...legAContextValue, wantRail: "x402" };
    const verdict = checkOrientation(legA, wantsOther);
    expect(verdict).toEqual({ ok: false, reason: "leg A must want flop-htlc (got x402)" });
  });

  it("rejects leg B paying a non-FLOP asset", () => {
    const paysOther: OfferFrame = { ...legB, asset: "USDC" };
    const verdict = checkOrientation(paysOther, legBContextValue);
    expect(verdict).toEqual({ ok: false, reason: "leg B must pay FLOP (got USDC)" });
  });

  it("rejects leg B without the flop-htlc rail", () => {
    const noFlopRail: OfferFrame = { ...legB, rails: ["x402"] };
    const verdict = checkOrientation(noFlopRail, legBContextValue);
    expect(verdict).toEqual({ ok: false, reason: "leg B rails must include flop-htlc" });
  });
});

describe("hasSellerCapability", () => {
  it("finds the token among others", () => {
    expect(hasSellerCapability(`tclk1:flop-htlc,evm-htlc ${SELLER_CAPABILITY_TOKEN}`)).toBe(true);
  });

  it("is false without the token", () => {
    expect(hasSellerCapability("tclk1:flop-htlc,evm-htlc")).toBe(false);
  });

  it("is false for an empty note", () => {
    expect(hasSellerCapability("")).toBe(false);
  });

  it("matches the exact token only", () => {
    expect(hasSellerCapability("swap1:sell-flop-extra")).toBe(false);
    expect(hasSellerCapability(SELLER_CAPABILITY_TOKEN)).toBe(true);
  });
});
