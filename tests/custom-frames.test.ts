// SPDX-License-Identifier: MIT
//
// tests/custom-frames.test.ts - SB3a: frame emission for the owner-namespaced custom rail id
// (src/rails/custom-frames.ts), the desk-layer help that lets a caller-owned registry admit the Solana rail id
// for emission while the vendored tclk (closed registry, never edited) keeps refusing it for every other
// caller. What is pinned:
//   - a frame with only canonical rails is encoded BYTE-IDENTICALLY to tclk's own `encodeFrame`, with or without
//     a registry (so the shim changes nothing for EVM, Bitcoin or NEAR);
//   - a frame with the custom id is admitted only by a registry that has it; tclk itself, no registry and any
//     other registry refuse it with tclk's own closed-registry error;
//   - the custom frame is exactly what tclk would emit for it (same line grammar, id, caps), and decodes and
//     folds through tclk's own `decodeFrame` / contract machine;
//   - `makeOfferWith` dedupes and sorts like tclk's `makeOffer` and its id is tclk's own `offerId`.

import { MAX_FRAME_CHARS, applyFrame, decodeFrame, encodeFrame, makeAccept, makeOffer, offerId, openContract, tryDecodeFrame, validateFrame, type LockFrame, type OfferFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { encodeFrameWith, makeOfferWith } from "../src/rails/custom-frames.js";
import { SOL_RAIL_ID, createCustomRailRegistry, createSolRailRegistry } from "../src/rails/custom-rails.js";
import { legAContext } from "../src/profile.js";
import { identity } from "./helpers/identity.js";

const buyer = identity("a1".repeat(32));
const seller = identity("a2".repeat(32));
const T = 1_700_000_000_000;

const base = {
  from: buyer.did,
  role: "payer" as const,
  amount: "1000000",
  asset: "USDC",
  lock: "hash" as const,
  claimByMs: T + 3_600_000,
  refundAfterMs: T + 7_200_000,
  expiresMs: T + 600_000,
  nonce: "00112233445566aa",
};

describe("canonical rails: byte-identical to tclk, with or without a registry", () => {
  it("makeOfferWith equals makeOffer and encodeFrameWith equals encodeFrame", () => {
    const registry = createSolRailRegistry();
    for (const rails of [["evm-htlc"], ["flop-htlc", "paper"], ["paper", "flop-htlc"], [" EVM-HTLC "]]) {
      const plain = makeOffer({ ...base, rails });
      expect(makeOfferWith({ ...base, rails })).toEqual(plain);
      expect(makeOfferWith({ ...base, rails }, registry)).toEqual(plain);
      expect(encodeFrameWith(plain)).toBe(encodeFrame(plain));
      expect(encodeFrameWith(plain, registry)).toBe(encodeFrame(plain));
    }
    const lock: LockFrame = { type: "lock", from: buyer.did, contract: `0x${"11".repeat(32)}`, rail: "evm-htlc", ref: `0x${"22".repeat(32)}` };
    expect(encodeFrameWith(lock, registry)).toBe(encodeFrame(lock));
  });

  it("an unknown id keeps tclk's own closed-registry error, with or without a registry", () => {
    expect(() => makeOfferWith({ ...base, rails: ["acme.other-v1"] })).toThrow(/unknown rail id|malformed rail id/);
    expect(() => makeOfferWith({ ...base, rails: ["acme.other-v1"] }, createSolRailRegistry())).toThrow(/unknown rail id|malformed rail id/);
    expect(() => makeOfferWith({ ...base, rails: ["evm-htlc", "acme.other-v1"] }, createSolRailRegistry())).toThrow(/unknown rail id|malformed rail id/);
  });
});

describe("the custom rail id", () => {
  const registry = createSolRailRegistry();

  it("is refused by tclk itself and by everyone without the registry that has it", () => {
    expect(() => makeOffer({ ...base, rails: [SOL_RAIL_ID] })).toThrow(/unknown rail id|malformed rail id/);
    expect(() => makeOfferWith({ ...base, rails: [SOL_RAIL_ID] })).toThrow(/unknown rail id|malformed rail id/);
    expect(() => makeOfferWith({ ...base, rails: [SOL_RAIL_ID] }, createCustomRailRegistry([]))).toThrow(/unknown rail id|malformed rail id/);
    expect(() => makeOfferWith({ ...base, rails: [SOL_RAIL_ID] }, createCustomRailRegistry([{ id: "acme.other-htlc-v1", namespace: "acme" }]))).toThrow(/unknown rail id|malformed rail id/);
  });

  it("a registry admits exactly its spelling: a padded or re-cased id is not admitted", () => {
    expect(() => makeOfferWith({ ...base, rails: [` ${SOL_RAIL_ID}`] }, registry)).toThrow(/unknown rail id|malformed rail id/);
    expect(() => makeOfferWith({ ...base, rails: [SOL_RAIL_ID.toUpperCase()] }, registry)).toThrow(/unknown rail id|malformed rail id/);
  });

  it("makeOfferWith builds a valid offer: tclk's own id, deduped, sorted, mixed with canonical rails", () => {
    const offer = makeOfferWith({ ...base, rails: [SOL_RAIL_ID, "evm-htlc", SOL_RAIL_ID] }, registry);
    expect(offer.rails).toEqual(["evm-htlc", SOL_RAIL_ID].sort());
    const { id, ...fields } = offer;
    expect(id).toBe(offerId(fields));
    expect(validateFrame(offer)).toEqual(offer);
    // nonce minted when omitted: 16 lowercase hex
    const { nonce: _n, ...noNonce } = base;
    expect(makeOfferWith({ ...noNonce, rails: [SOL_RAIL_ID] }, registry).nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  it("encodeFrameWith emits the line tclk's grammar would: decodes back to the same frame, and tclk's encodeFrame refuses the same frame", () => {
    const offer = makeOfferWith({ ...base, rails: [SOL_RAIL_ID] }, registry);
    const line = encodeFrameWith(offer, registry);
    expect(line.startsWith("tclk1 ")).toBe(true);
    expect(decodeFrame(line)).toEqual(offer);
    expect(tryDecodeFrame(line)).toEqual(offer);
    expect(() => encodeFrame(offer)).toThrow(/unknown rail id|non-canonical|malformed rail id/);
    expect(() => encodeFrameWith(offer)).toThrow();
    expect(() => encodeFrameWith(offer, createCustomRailRegistry([]))).toThrow();
  });

  it("the line for a custom frame has the same bytes as the same frame with a canonical rail in the same place", () => {
    // swap the rail text in the custom line and compare to tclk's own line for the canonical twin: only the
    // rail list (and the id that commits to it) may differ; the grammar, key order and escaping are tclk's
    const custom = makeOfferWith({ ...base, rails: [SOL_RAIL_ID] }, registry);
    const twin = makeOffer({ ...base, rails: ["evm-htlc"] });
    const a = JSON.parse(encodeFrameWith(custom, registry).slice("tclk1 ".length)) as Record<string, unknown>;
    const b = JSON.parse(encodeFrame(twin).slice("tclk1 ".length)) as Record<string, unknown>;
    expect(Object.keys(a)).toEqual(Object.keys(b));
    const { id: _ia, rails: _ra, ...restA } = a;
    const { id: _ib, rails: _rb, ...restB } = b;
    expect(restA).toEqual(restB);
  });

  it("lock and receipt frames naming the custom id are admitted only through the registry and keep tclk's other rules", () => {
    const contract = `0x${"33".repeat(32)}`;
    const lock: LockFrame = { type: "lock", from: buyer.did, contract, rail: SOL_RAIL_ID, ref: `0x${"44".repeat(32)}:11111111111111111111111111111111` };
    const line = encodeFrameWith(lock, registry);
    expect(tryDecodeFrame(line)).toEqual(lock);
    expect(() => encodeFrame(lock)).toThrow();
    expect(() => encodeFrameWith(lock)).toThrow();
    const receipt = { type: "receipt", from: buyer.did, contract, outcome: "claimed", rail: SOL_RAIL_ID, ref: "x" } as const;
    expect(tryDecodeFrame(encodeFrameWith(receipt, registry))).toEqual(receipt);
    // tclk's own validation still applies to the rest of the frame
    expect(() => encodeFrameWith({ ...lock, from: "not-a-did" }, registry)).toThrow();
    expect(() => encodeFrameWith({ ...lock, ref: "é".repeat(5000) }, registry)).toThrow(/cap/);
    expect(() => encodeFrameWith({ ...lock, ref: "x".repeat(MAX_FRAME_CHARS) }, registry)).toThrow(/cap/);
  });

  it("non-ASCII text in a custom frame is escaped exactly as tclk escapes it", () => {
    const offer = makeOfferWith({ ...base, rails: [SOL_RAIL_ID], job: { proto: "swap", id: "café", context: "x" } } as never, registry);
    const line = encodeFrameWith(offer, registry);
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    expect(line).toContain("\\u00e9");
  });

  it("the tclk contract machine folds an offer, an accept and a lock frame that name the custom rail", () => {
    const offer = makeOfferWith({ ...base, rails: [SOL_RAIL_ID], job: { proto: "swap", id: `0x${"55".repeat(32)}`, context: legAContext({ wantAsset: "FLOP", wantAmount: "1", wantRail: "flop-htlc" }) } } as never, registry) as OfferFrame;
    const accept = makeAccept(offer, { from: seller.did, statement: `0x${"66".repeat(32)}` });
    let state = openContract(offer);
    const accepted = applyFrame(state, accept, T + 1);
    expect(accepted.ok).toBe(true);
    state = accepted.state;
    const ref = `0x${"66".repeat(32)}:11111111111111111111111111111111`;
    const locked = applyFrame(state, { type: "lock", from: buyer.did, contract: accept.contract, rail: SOL_RAIL_ID, ref }, T + 2);
    expect(locked.ok).toBe(true);
    expect(locked.state).toMatchObject({ status: "locked", rail: SOL_RAIL_ID, railRef: ref });
    // a lock naming a rail the offer did not list is still rejected by the machine
    const wrong = applyFrame(state, { type: "lock", from: buyer.did, contract: accept.contract, rail: "evm-htlc", ref }, T + 2);
    expect(wrong.ok).toBe(false);
  });
});
