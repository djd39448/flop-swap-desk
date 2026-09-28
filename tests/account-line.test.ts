// SPDX-License-Identifier: MIT
//
// tests/account-line.test.ts — P22-P24-EVM-SPEC.md §3 (D-08 option A): grammar vectors for
// `formatAccountLine`/`parseAccountLine`, then `resolveAccounts`'s sender-binding, room-scoping,
// other-rail/other-chain-ignore and conflict-means-unresolved rules, built against signed
// `TranscriptRecord`s the same way `tests/helpers/identity.ts` builds them for every other
// fixture in this repo (so `verifyTranscriptRecord` accepts them exactly like a real transcript).

import { getAddress } from "viem";
import { dealRoom, OFFER_ROOM } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import {
  formatAccountLine,
  parseAccountLine,
  resolveAccounts,
  RAIL_NAMESPACES,
} from "../src/rails/account-line.js";
import { identity, record, recordSignedBy, unsignedRecord } from "./helpers/identity.js";

const T0 = 1_758_000_000_000;

const buyer = identity("d4".repeat(32)); // the payer in every fixture below
const seller = identity("e5".repeat(32)); // the payee in every fixture below

// A contract id only needs to satisfy tclk's own shape (`0x` + 64 hex) — resolveAccounts never
// looks at an offer/accept, only at `dealRoom(contract)` and the two DIDs it's given.
const CONTRACT = `0x${"ab".repeat(32)}`;
const ROOM = dealRoom(CONTRACT);
const OTHER_CONTRACT = `0x${"cd".repeat(32)}`;

const RAIL = "evm-htlc";
const CAIP2 = "eip155:31337"; // ANVIL_LOCAL_PIN.caip2

const CHECKSUM_ADDRESS = getAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
const LOWER_ADDRESS = CHECKSUM_ADDRESS.toLowerCase();
// Flip the case of one letter that IS a letter in the checksum, so the result is neither
// all-lowercase nor the real checksum — the one shape the grammar refuses.
const BAD_CHECKSUM_ADDRESS = `${CHECKSUM_ADDRESS.slice(0, 5)}${
  CHECKSUM_ADDRESS[5] === CHECKSUM_ADDRESS[5]!.toLowerCase()
    ? CHECKSUM_ADDRESS[5]!.toUpperCase()
    : CHECKSUM_ADDRESS[5]!.toLowerCase()
}${CHECKSUM_ADDRESS.slice(6)}`;

function fakeAddress(tag: string): string {
  const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
  return `0x${hex}`;
}

describe("account-line grammar", () => {
  describe("parseAccountLine", () => {
    it("accepts a valid lowercase address", () => {
      const line = `swap1 account evm-htlc eip155:31337:${LOWER_ADDRESS}`;
      expect(parseAccountLine(line)).toEqual({ railId: "evm-htlc", caip2: CAIP2, address: LOWER_ADDRESS });
    });

    it("accepts a valid EIP-55 checksum address, normalized to lowercase", () => {
      const line = `swap1 account evm-htlc eip155:31337:${CHECKSUM_ADDRESS}`;
      expect(parseAccountLine(line)).toEqual({ railId: "evm-htlc", caip2: CAIP2, address: LOWER_ADDRESS });
    });

    it("rejects a mixed-case address that fails the checksum", () => {
      expect(BAD_CHECKSUM_ADDRESS).not.toBe(CHECKSUM_ADDRESS);
      expect(BAD_CHECKSUM_ADDRESS.toLowerCase()).toBe(LOWER_ADDRESS);
      const line = `swap1 account evm-htlc eip155:31337:${BAD_CHECKSUM_ADDRESS}`;
      expect(parseAccountLine(line)).toBeNull();
    });

    it("rejects an all-uppercase address (neither lowercase nor a real checksum)", () => {
      const line = `swap1 account evm-htlc eip155:31337:${CHECKSUM_ADDRESS.toUpperCase()}`;
      expect(parseAccountLine(line)).toBeNull();
    });

    it("rejects a chain id with a leading zero", () => {
      const line = `swap1 account evm-htlc eip155:084532:${LOWER_ADDRESS}`;
      expect(parseAccountLine(line)).toBeNull();
    });

    it("accepts chain id 0 (no leading zero, the digit itself)", () => {
      const line = `swap1 account evm-htlc eip155:0:${LOWER_ADDRESS}`;
      expect(parseAccountLine(line)).toEqual({ railId: "evm-htlc", caip2: "eip155:0", address: LOWER_ADDRESS });
    });

    it("rejects an extra space between 'account' and the rail id", () => {
      expect(parseAccountLine(`swap1 account  evm-htlc eip155:31337:${LOWER_ADDRESS}`)).toBeNull();
    });

    it("rejects an extra space between the rail id and the caip-10 account", () => {
      expect(parseAccountLine(`swap1 account evm-htlc  eip155:31337:${LOWER_ADDRESS}`)).toBeNull();
    });

    it("rejects a trailing space", () => {
      expect(parseAccountLine(`swap1 account evm-htlc eip155:31337:${LOWER_ADDRESS} `)).toBeNull();
    });

    it("rejects a leading space", () => {
      expect(parseAccountLine(` swap1 account evm-htlc eip155:31337:${LOWER_ADDRESS}`)).toBeNull();
    });

    it("rejects the wrong namespace for the rail (evm-htlc wants eip155, not bip122)", () => {
      const line = `swap1 account evm-htlc bip122:0:${fakeAddress("btc")}`;
      expect(parseAccountLine(line)).toBeNull();
    });

    it("rejects the wrong namespace the other way (btc-htlc wants bip122, not eip155)", () => {
      const line = `swap1 account btc-htlc eip155:31337:${LOWER_ADDRESS}`;
      expect(parseAccountLine(line)).toBeNull();
    });

    it("rejects a rail id tclk has never registered", () => {
      expect(parseAccountLine(`swap1 account sol-htlc eip155:31337:${LOWER_ADDRESS}`)).toBeNull();
    });

    it("rejects a rail id tclk registers but this module has no chain namespace for (paper)", () => {
      expect(parseAccountLine(`swap1 account paper eip155:31337:${LOWER_ADDRESS}`)).toBeNull();
    });

    it("rejects a non-canonical rail spelling even if it would normalize to a known rail", () => {
      // normalizeRailId lowercases before checking the registry; the wire form must already be
      // canonical (the same rule offer/lock frames enforce on `rails`/`rail`).
      expect(parseAccountLine(`swap1 account EVM-HTLC eip155:31337:${LOWER_ADDRESS}`)).toBeNull();
    });

    it("rejects a caip-10 token that isn't exactly three colon-separated parts", () => {
      expect(parseAccountLine(`swap1 account evm-htlc eip155:${LOWER_ADDRESS}`)).toBeNull();
      expect(parseAccountLine(`swap1 account evm-htlc eip155:31337:extra:${LOWER_ADDRESS}`)).toBeNull();
    });

    it("parses a btc-htlc/bip122 line under the generic CAIP-10 grammar (no eip155-specific rule applies)", () => {
      const line = `swap1 account btc-htlc bip122:000000000019d6689c085ae1:${fakeAddress("btc")}`;
      expect(parseAccountLine(line)).toEqual({
        railId: "btc-htlc",
        caip2: "bip122:000000000019d6689c085ae1",
        address: fakeAddress("btc"),
      });
    });

    it("is never thrown at by malformed input", () => {
      expect(() => parseAccountLine("")).not.toThrow();
      expect(() => parseAccountLine("not an account line at all")).not.toThrow();
      expect(() => parseAccountLine("swap1 account")).not.toThrow();
      expect(parseAccountLine("")).toBeNull();
      expect(parseAccountLine("not an account line at all")).toBeNull();
      expect(parseAccountLine("swap1 account")).toBeNull();
    });
  });

  describe("formatAccountLine", () => {
    it("round-trips through parseAccountLine", () => {
      const line = formatAccountLine({ railId: "evm-htlc", caip2: CAIP2, address: CHECKSUM_ADDRESS });
      expect(line).toBe(`swap1 account evm-htlc eip155:31337:${LOWER_ADDRESS}`);
      expect(parseAccountLine(line)).toEqual({ railId: "evm-htlc", caip2: CAIP2, address: LOWER_ADDRESS });
    });

    it("throws on a non-canonical rail id", () => {
      expect(() => formatAccountLine({ railId: "EVM-HTLC", caip2: CAIP2, address: LOWER_ADDRESS })).toThrow(
        /non-canonical rail id/,
      );
    });

    it("throws on a rail tclk has never registered", () => {
      expect(() => formatAccountLine({ railId: "sol-htlc", caip2: "solana:1", address: "x" })).toThrow();
    });

    it("throws on a rail this module has no chain namespace for", () => {
      expect(() => formatAccountLine({ railId: "paper", caip2: CAIP2, address: LOWER_ADDRESS })).toThrow(
        /no chain-account namespace/,
      );
    });

    it("throws when the caip2 namespace does not match the rail", () => {
      expect(() => formatAccountLine({ railId: "evm-htlc", caip2: "bip122:0", address: fakeAddress("x") })).toThrow(
        /does not match rail/,
      );
    });

    it("throws on an address that fails eip155's grammar", () => {
      expect(() => formatAccountLine({ railId: "evm-htlc", caip2: CAIP2, address: BAD_CHECKSUM_ADDRESS })).toThrow();
      expect(() => formatAccountLine({ railId: "evm-htlc", caip2: CAIP2, address: "not-hex" })).toThrow();
    });
  });

  it("RAIL_NAMESPACES documents the table docs/PROFILE.md §3.5 describes", () => {
    expect(RAIL_NAMESPACES).toEqual({ "evm-htlc": "eip155", "btc-htlc": "bip122", "near-htlc": "near" });
  });
});

describe("resolveAccounts", () => {
  const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: RAIL, caip2: CAIP2 };

  function accountLineRecord(seq: number, signer: typeof buyer, address: string, room: string = ROOM): ReturnType<typeof record> {
    return record(room, seq, T0 + seq * 60_000, signer, formatAccountLine({ railId: RAIL, caip2: CAIP2, address }));
  }

  it("resolves the payer's line to `payer`, never `payee` (sender binding)", () => {
    const records = [accountLineRecord(1, buyer, LOWER_ADDRESS)];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBe(LOWER_ADDRESS);
    expect(result.payee).toBeUndefined();
  });

  it("resolves the payee's line to `payee`, never `payer` (sender binding, the other way)", () => {
    const records = [accountLineRecord(1, seller, LOWER_ADDRESS)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBe(LOWER_ADDRESS);
    expect(result.payer).toBeUndefined();
  });

  it("resolves both independently when both parties post", () => {
    const records = [accountLineRecord(1, buyer, LOWER_ADDRESS), accountLineRecord(2, seller, fakeAddress("seller"))];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBe(LOWER_ADDRESS);
    expect(result.payee).toBe(fakeAddress("seller"));
    expect(result.reasons).toEqual([]);
  });

  it("a line signed by the payer is the payer's claim, not the payee's, regardless of room convention", () => {
    // Even though room A's convention is "the Seller posts first", nothing in the grammar lets
    // a line name whose account it is — only `record.sender` does.
    const records = [accountLineRecord(1, buyer, LOWER_ADDRESS)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.payer).toBe(LOWER_ADDRESS);
  });

  it("ignores an unsigned record even if its line is a well-formed account line", () => {
    const line = formatAccountLine({ railId: RAIL, caip2: CAIP2, address: LOWER_ADDRESS });
    const records = [unsignedRecord(ROOM, 1, T0, line)];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
  });

  it("ignores a forged record (signature does not match the claimed sender)", () => {
    const line = formatAccountLine({ railId: RAIL, caip2: CAIP2, address: LOWER_ADDRESS });
    // Actually signed by the seller, but claims to be from the buyer (payer) — the signature
    // check fails, so this never counts as the payer's claim.
    const records = [recordSignedBy(ROOM, 1, T0, seller, buyer.did, line)];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
  });

  it("a conflict (two disagreeing lines from the same party) leaves that party unresolved, not first-wins", () => {
    const records = [
      accountLineRecord(1, buyer, LOWER_ADDRESS),
      accountLineRecord(2, buyer, fakeAddress("second-claim")),
    ];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.reasons.some((r) => r.includes("conflicting account lines") && r.includes(buyer.did))).toBe(true);
  });

  it("repeating the same address twice is not a conflict", () => {
    const records = [accountLineRecord(1, buyer, LOWER_ADDRESS), accountLineRecord(2, buyer, LOWER_ADDRESS)];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBe(LOWER_ADDRESS);
    expect(result.reasons).toEqual([]);
  });

  it("ignores a line for a different chain (same rail, different caip2) and says why", () => {
    const otherChainLine = formatAccountLine({ railId: RAIL, caip2: "eip155:1", address: LOWER_ADDRESS });
    const records = [record(ROOM, 1, T0, seller, otherChainLine)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons.some((r) => r.includes("eip155:1"))).toBe(true);
  });

  it("ignores a line for a different rail and says why", () => {
    const otherRailLine = formatAccountLine({
      railId: "btc-htlc",
      caip2: "bip122:000000000019d6689c085ae1",
      address: fakeAddress("btc"),
    });
    const records = [record(ROOM, 1, T0, seller, otherRailLine)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons.some((r) => r.includes("btc-htlc"))).toBe(true);
  });

  it("ignores a record posted in a different room, even byte-identical otherwise", () => {
    const line = formatAccountLine({ railId: RAIL, caip2: CAIP2, address: LOWER_ADDRESS });
    const otherRoom = dealRoom(OTHER_CONTRACT);
    const records = [record(otherRoom, 1, T0, seller, line)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons).toEqual([]); // a different room isn't "ignored with a reason" — it's simply not this swap's line
  });

  it("ignores a record posted in the shared offer room, not the swap's own deal room", () => {
    const line = formatAccountLine({ railId: RAIL, caip2: CAIP2, address: LOWER_ADDRESS });
    const records = [record(OFFER_ROOM, 1, T0, seller, line)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
  });

  it("ignores a line from a DID that is neither party to this swap", () => {
    const stranger = identity("f6".repeat(32));
    const line = formatAccountLine({ railId: RAIL, caip2: CAIP2, address: LOWER_ADDRESS });
    const records = [record(ROOM, 1, T0, stranger, line)];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
  });

  it("only the payee's line is required to resolve; the payer's stays undefined with no reasons", () => {
    const records = [accountLineRecord(1, seller, LOWER_ADDRESS)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBe(LOWER_ADDRESS);
    expect(result.payer).toBeUndefined();
    expect(result.reasons).toEqual([]); // absence alone is not a fold-worthy reason
  });

  it("returns everyone unresolved, with a reason, for an unregistered rail", () => {
    const result = resolveAccounts([], { ...input, rail: "sol-htlc" });
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns everyone unresolved, with a reason, for a malformed contract id", () => {
    const result = resolveAccounts([], { ...input, contract: "not-a-contract-id" });
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
