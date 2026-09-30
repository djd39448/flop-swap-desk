// SPDX-License-Identifier: MIT
//
// tests/near-ref.test.ts — the shared near-htlc ref helper (squatting fix): `0x<hash lock>:<payer>`.

import { describe, expect, it } from "vitest";

import { formatNearRef, parseNearRef, requireNearRef } from "../src/rails/near-ref.js";

const HASH_LOCK = `0x${"ab".repeat(32)}`;
const PAYER = "buyer.near-sandbox-flop";

describe("near ref", () => {
  it("formats and parses a round trip", () => {
    const ref = formatNearRef(HASH_LOCK, PAYER);
    expect(ref).toBe(`${HASH_LOCK}:${PAYER}`);
    expect(parseNearRef(ref)).toEqual({ hashLock: HASH_LOCK, payer: PAYER });
    expect(requireNearRef(ref)).toEqual({ hashLock: HASH_LOCK, payer: PAYER });
  });

  it("accepts underscores, dashes and dots in the payer (the account-id grammar)", () => {
    expect(parseNearRef(`${HASH_LOCK}:a_b-c.d`)).toEqual({ hashLock: HASH_LOCK, payer: "a_b-c.d" });
  });

  it("refuses the pre-fix bare hash lock", () => {
    expect(parseNearRef(HASH_LOCK)).toBeNull();
    expect(() => requireNearRef(HASH_LOCK)).toThrow(/ref must be 0x/);
  });

  it.each([
    ["an empty payer", `${HASH_LOCK}:`],
    ["an uppercase payer", `${HASH_LOCK}:Buyer.near`],
    ["a payer with a colon (would make the ref ambiguous)", `${HASH_LOCK}:a:b`],
    ["a one-character payer", `${HASH_LOCK}:a`],
    ["a payer with a leading separator", `${HASH_LOCK}:.abc`],
    ["a payer with doubled separators", `${HASH_LOCK}:a..b`],
    ["a payer longer than 64 characters", `${HASH_LOCK}:${"a".repeat(65)}`],
    ["an uppercase hash lock", `0x${"AB".repeat(32)}:${PAYER}`],
    ["a short hash lock", `0x${"ab".repeat(31)}:${PAYER}`],
    ["a hash lock without 0x", `${"ab".repeat(32)}00:${PAYER}`],
    ["a swapped order", `${PAYER}:${HASH_LOCK}`],
    ["whitespace", ` ${HASH_LOCK}:${PAYER}`],
    ["a trailing newline", `${HASH_LOCK}:${PAYER}\n`],
  ])("refuses %s", (_label, ref) => {
    expect(parseNearRef(ref)).toBeNull();
  });

  it("refuses non-strings", () => {
    expect(parseNearRef(undefined)).toBeNull();
    expect(parseNearRef(null)).toBeNull();
    expect(parseNearRef(42)).toBeNull();
  });

  it("formatNearRef throws on an invalid hash lock or payer", () => {
    expect(() => formatNearRef("0x1234", PAYER)).toThrow(/hashLock/);
    expect(() => formatNearRef(HASH_LOCK, "Bad Account")).toThrow(/payer/);
  });
});
