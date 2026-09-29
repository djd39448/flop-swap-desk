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
  formatPubkeyLine,
  parseAccountLine,
  parsePubkeyLine,
  resolveAccounts,
  resolvePubkeys,
  PUBKEY_RAIL_NAMESPACES,
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

// ── near-htlc account line (D-N5) ───────────────────────────────────────────────────────────
//
// near-htlc uses an account line (D-N5), never a pubkey line: the contract authorises by
// account id (`predecessor_account_id`), unlike btc-htlc's P2WSH script (P4-BTC-SPEC.md §6),
// which commits to public keys. `swap1 account near-htlc near:<chain id>:<account id>` — the
// account id itself uses NEAR's own grammar (`validateNearAccountId` in account-line.ts), which
// accepts `_` as a separator — a deliberate, documented deviation from the generic CAIP-10
// address grammar (`CAIP10_ADDRESS`, which has no `_`).

const NEAR_RAIL = "near-htlc";
const NEAR_CAIP2 = "near:near-sandbox-flop"; // NEAR_SANDBOX_PIN.caip2

function nearAccountLine(seq: number, signer: typeof buyer, accountId: string, room: string = ROOM): ReturnType<typeof record> {
  return record(room, seq, T0 + seq * 60_000, signer, formatAccountLine({ railId: NEAR_RAIL, caip2: NEAR_CAIP2, address: accountId }));
}

describe("near-htlc account line grammar (D-N5)", () => {
  describe("parseAccountLine", () => {
    it("accepts a plain NEAR account id", () => {
      const line = `swap1 account near-htlc ${NEAR_CAIP2}:alice.near-sandbox-flop`;
      expect(parseAccountLine(line)).toEqual({ railId: "near-htlc", caip2: NEAR_CAIP2, address: "alice.near-sandbox-flop" });
    });

    it("accepts an account id with an underscore separator (the documented deviation from generic CAIP-10)", () => {
      const line = `swap1 account near-htlc ${NEAR_CAIP2}:alice_capital.near-sandbox-flop`;
      expect(parseAccountLine(line)).toEqual({ railId: "near-htlc", caip2: NEAR_CAIP2, address: "alice_capital.near-sandbox-flop" });
    });

    it("accepts a 64-hex-char implicit account id (the maximum length)", () => {
      const implicitId = "ab".repeat(32); // 64 chars
      expect(implicitId).toHaveLength(64);
      const line = `swap1 account near-htlc ${NEAR_CAIP2}:${implicitId}`;
      expect(parseAccountLine(line)).toEqual({ railId: "near-htlc", caip2: NEAR_CAIP2, address: implicitId });
    });

    it("accepts a hyphen separator", () => {
      const line = `swap1 account near-htlc ${NEAR_CAIP2}:my-account.near-sandbox-flop`;
      expect(parseAccountLine(line)).toEqual({ railId: "near-htlc", caip2: NEAR_CAIP2, address: "my-account.near-sandbox-flop" });
    });

    it("rejects an uppercase account id (NEAR account ids are always lowercase)", () => {
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:Alice.near-sandbox-flop`)).toBeNull();
    });

    it("rejects a 1-character account id (below the 2-char minimum)", () => {
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:a`)).toBeNull();
    });

    it("rejects an account id over 64 characters", () => {
      const tooLong = "a".repeat(65);
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:${tooLong}`)).toBeNull();
    });

    it("rejects a leading separator", () => {
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:.alice`)).toBeNull();
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:-alice`)).toBeNull();
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:_alice`)).toBeNull();
    });

    it("rejects a trailing separator", () => {
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:alice.`)).toBeNull();
    });

    it("rejects a doubled-up separator", () => {
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:alice..near`)).toBeNull();
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:alice__near`)).toBeNull();
    });

    it("rejects a character outside [a-z0-9._-] (e.g. a space-free but illegal symbol)", () => {
      expect(parseAccountLine(`swap1 account near-htlc ${NEAR_CAIP2}:alice@near`)).toBeNull();
    });

    it("rejects the wrong namespace for the rail (near-htlc wants near, not eip155)", () => {
      expect(parseAccountLine(`swap1 account near-htlc eip155:31337:${LOWER_ADDRESS}`)).toBeNull();
    });
  });

  describe("formatAccountLine", () => {
    it("round-trips through parseAccountLine", () => {
      const line = formatAccountLine({ railId: "near-htlc", caip2: NEAR_CAIP2, address: "alice.near-sandbox-flop" });
      expect(line).toBe(`swap1 account near-htlc ${NEAR_CAIP2}:alice.near-sandbox-flop`);
      expect(parseAccountLine(line)).toEqual({ railId: "near-htlc", caip2: NEAR_CAIP2, address: "alice.near-sandbox-flop" });
    });

    it("throws on an account id that fails NEAR's own grammar", () => {
      expect(() => formatAccountLine({ railId: "near-htlc", caip2: NEAR_CAIP2, address: "Alice.near" })).toThrow();
      expect(() => formatAccountLine({ railId: "near-htlc", caip2: NEAR_CAIP2, address: "a" })).toThrow();
    });
  });

  it("near-htlc is NOT in PUBKEY_RAIL_NAMESPACES — this rail uses an account line only, never a pubkey line (D-N5)", () => {
    expect(PUBKEY_RAIL_NAMESPACES).not.toHaveProperty("near-htlc");
  });
});

describe("resolveAccounts — near-htlc", () => {
  const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: NEAR_RAIL, caip2: NEAR_CAIP2 };

  it("resolves the payee's line to `payee`, sender-bound", () => {
    const records = [nearAccountLine(1, seller, "seller.near-sandbox-flop")];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBe("seller.near-sandbox-flop");
    expect(result.payer).toBeUndefined();
  });

  it("resolves both independently when both parties post", () => {
    const records = [nearAccountLine(1, buyer, "buyer.near-sandbox-flop"), nearAccountLine(2, seller, "seller.near-sandbox-flop")];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBe("buyer.near-sandbox-flop");
    expect(result.payee).toBe("seller.near-sandbox-flop");
    expect(result.reasons).toEqual([]);
  });

  it("a conflict (two disagreeing lines from the same party) leaves that party unresolved, not first-wins", () => {
    const records = [nearAccountLine(1, seller, "seller.near-sandbox-flop"), nearAccountLine(2, seller, "seller-two.near-sandbox-flop")];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons.some((r) => r.includes("conflicting account lines") && r.includes(seller.did))).toBe(true);
  });

  it("G1: a line posted after the accepted lock (beforeSeq) is ignored entirely", () => {
    const records = [nearAccountLine(1, seller, "seller.near-sandbox-flop"), nearAccountLine(5, seller, "seller-late.near-sandbox-flop")];
    const result = resolveAccounts(records, { ...input, beforeSeq: 3 });
    expect(result.payee).toBe("seller.near-sandbox-flop"); // only the earlier line counts
  });

  it("ignores a line for a different chain (same rail, different caip2) and says why", () => {
    const otherChainLine = formatAccountLine({ railId: NEAR_RAIL, caip2: "near:testnet", address: "seller.testnet" });
    const records = [record(ROOM, 1, T0, seller, otherChainLine)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons.some((r) => r.includes("near:testnet"))).toBe(true);
  });

  it("ignores an unsigned record even if its line is a well-formed account line", () => {
    const line = formatAccountLine({ railId: NEAR_RAIL, caip2: NEAR_CAIP2, address: "seller.near-sandbox-flop" });
    const records = [unsignedRecord(ROOM, 1, T0, line)];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBeUndefined();
  });

  it("only the payee's line is required to resolve; the payer's stays undefined with no reasons", () => {
    const records = [nearAccountLine(1, seller, "seller.near-sandbox-flop")];
    const result = resolveAccounts(records, input);
    expect(result.payee).toBe("seller.near-sandbox-flop");
    expect(result.payer).toBeUndefined();
    expect(result.reasons).toEqual([]);
  });
});

// ── the pubkey line (P4-BTC-SPEC.md §6) ─────────────────────────────────────────────────────

const BTC_RAIL = "btc-htlc";
const BTC_CAIP2 = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328"; // BTC_REGTEST_PIN.caip2
const PAYEE_PUBKEY = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a";
const PAYER_PUBKEY = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627";

function fakePubkey(tag: string, prefix: "02" | "03" = "02"): string {
  const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(64, "0").slice(0, 64);
  return `${prefix}${hex}`;
}

describe("pubkey-line grammar", () => {
  describe("parsePubkeyLine", () => {
    it("accepts a well-formed btc-htlc/bip122 line", () => {
      const line = `swap1 pubkey btc-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY}`;
      expect(parsePubkeyLine(line)).toEqual({ railId: "btc-htlc", caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY });
    });

    it("accepts a 0x03-prefixed pubkey", () => {
      const line = `swap1 pubkey btc-htlc ${BTC_CAIP2} ${PAYER_PUBKEY}`;
      expect(parsePubkeyLine(line)?.pubkey).toBe(PAYER_PUBKEY);
    });

    it("rejects an uppercase pubkey (never normalized — must already be lowercase)", () => {
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY.toUpperCase()}`)).toBeNull();
    });

    it("rejects a pubkey that is the wrong length", () => {
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY}ab`)).toBeNull();
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY.slice(0, -2)}`)).toBeNull();
    });

    it("rejects a pubkey with a bad prefix byte (not 02/03)", () => {
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc ${BTC_CAIP2} 04${PAYEE_PUBKEY.slice(2)}`)).toBeNull();
    });

    it("rejects a mixed-case (non-hex-lowercase) reference", () => {
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc bip122:0F9188F13CB7B2C71F2A335E3A4FC328 ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects a reference that is not 32 hex chars (bip122's own grammar)", () => {
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc bip122:abcd ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects the wrong namespace for the rail (btc-htlc wants bip122, not eip155)", () => {
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc eip155:31337 ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects a rail with no pubkey-line rule (evm-htlc)", () => {
      expect(parsePubkeyLine(`swap1 pubkey evm-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects a rail tclk has never registered", () => {
      expect(parsePubkeyLine(`swap1 pubkey sol-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects a non-canonical rail spelling", () => {
      expect(parsePubkeyLine(`swap1 pubkey BTC-HTLC ${BTC_CAIP2} ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects CAIP-10's legacy <address>@<caip-2> account form spliced into the caip-2 token", () => {
      // The legacy (pre-2021) CAIP-10 form has no room in a bare `namespace:reference` token —
      // it fails on the namespace check (the token before the first ":" is not "bip122" at all).
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc somebtcaddress@bip122:0f9188f13cb7b2c71f2a335e3a4fc328 ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects a caip-2 token with three colon-separated parts (a full caip-10 triplet, not a bare caip-2 id)", () => {
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc ${BTC_CAIP2}:someaddress ${PAYEE_PUBKEY}`)).toBeNull();
    });

    it("rejects an extra space anywhere in the line", () => {
      expect(parsePubkeyLine(`swap1 pubkey  btc-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY}`)).toBeNull();
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc  ${BTC_CAIP2} ${PAYEE_PUBKEY}`)).toBeNull();
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc ${BTC_CAIP2}  ${PAYEE_PUBKEY}`)).toBeNull();
      expect(parsePubkeyLine(`swap1 pubkey btc-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY} `)).toBeNull();
    });

    it("is never thrown at by malformed input", () => {
      expect(() => parsePubkeyLine("")).not.toThrow();
      expect(() => parsePubkeyLine("not a pubkey line at all")).not.toThrow();
      expect(() => parsePubkeyLine("swap1 pubkey")).not.toThrow();
      expect(parsePubkeyLine("")).toBeNull();
      expect(parsePubkeyLine("swap1 pubkey")).toBeNull();
    });

    it("does not accept an account-line-shaped line (different grammar, different token count)", () => {
      expect(parsePubkeyLine(`swap1 account btc-htlc ${BTC_CAIP2}:${PAYEE_PUBKEY}`)).toBeNull();
    });
  });

  describe("formatPubkeyLine", () => {
    it("round-trips through parsePubkeyLine", () => {
      const line = formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY });
      expect(line).toBe(`swap1 pubkey btc-htlc ${BTC_CAIP2} ${PAYEE_PUBKEY}`);
      expect(parsePubkeyLine(line)).toEqual({ railId: "btc-htlc", caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY });
    });

    it("throws on a non-canonical rail id", () => {
      expect(() => formatPubkeyLine({ railId: "BTC-HTLC", caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY })).toThrow(/non-canonical rail id/);
    });

    it("throws on a rail with no pubkey-line rule", () => {
      expect(() => formatPubkeyLine({ railId: "evm-htlc", caip2: "eip155:31337", pubkey: PAYEE_PUBKEY })).toThrow(
        /no pubkey-line namespace/,
      );
    });

    it("throws on a rail tclk has never registered", () => {
      expect(() => formatPubkeyLine({ railId: "sol-htlc", caip2: "solana:1", pubkey: PAYEE_PUBKEY })).toThrow();
    });

    it("throws when the caip2 namespace does not match the rail", () => {
      expect(() => formatPubkeyLine({ railId: "btc-htlc", caip2: "eip155:31337", pubkey: PAYEE_PUBKEY })).toThrow(
        /does not match rail/,
      );
    });

    it("throws on a malformed pubkey", () => {
      expect(() => formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_CAIP2, pubkey: "not-hex" })).toThrow();
      expect(() => formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY.toUpperCase() })).toThrow();
    });

    it("throws on a malformed caip2 (not namespace:reference)", () => {
      expect(() => formatPubkeyLine({ railId: "btc-htlc", caip2: "bip122", pubkey: PAYEE_PUBKEY })).toThrow(/malformed caip2/);
    });
  });

  it("PUBKEY_RAIL_NAMESPACES documents only btc-htlc today (P4-BTC-SPEC.md §6)", () => {
    expect(PUBKEY_RAIL_NAMESPACES).toEqual({ "btc-htlc": "bip122" });
  });
});

describe("resolvePubkeys", () => {
  const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: BTC_RAIL, caip2: BTC_CAIP2 };

  function pubkeyLineRecord(seq: number, signer: typeof buyer, pubkey: string, room: string = ROOM): ReturnType<typeof record> {
    return record(room, seq, T0 + seq * 60_000, signer, formatPubkeyLine({ railId: BTC_RAIL, caip2: BTC_CAIP2, pubkey }));
  }

  it("resolves the payer's line to `payer`, never `payee` (sender binding)", () => {
    const records = [pubkeyLineRecord(1, buyer, PAYER_PUBKEY)];
    const result = resolvePubkeys(records, input);
    expect(result.payer).toBe(PAYER_PUBKEY);
    expect(result.payee).toBeUndefined();
  });

  it("resolves the payee's line to `payee`, never `payer` (the other way)", () => {
    const records = [pubkeyLineRecord(1, seller, PAYEE_PUBKEY)];
    const result = resolvePubkeys(records, input);
    expect(result.payee).toBe(PAYEE_PUBKEY);
    expect(result.payer).toBeUndefined();
  });

  it("resolves both independently when both parties post — required for a btc-htlc leg (P4-BTC-SPEC.md §6)", () => {
    const records = [pubkeyLineRecord(1, buyer, PAYER_PUBKEY), pubkeyLineRecord(2, seller, PAYEE_PUBKEY)];
    const result = resolvePubkeys(records, input);
    expect(result.payer).toBe(PAYER_PUBKEY);
    expect(result.payee).toBe(PAYEE_PUBKEY);
    expect(result.reasons).toEqual([]);
  });

  it("ignores an unsigned record even if its line is a well-formed pubkey line", () => {
    const line = formatPubkeyLine({ railId: BTC_RAIL, caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY });
    const records = [unsignedRecord(ROOM, 1, T0, line)];
    const result = resolvePubkeys(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
  });

  it("ignores a forged record (signature does not match the claimed sender)", () => {
    const line = formatPubkeyLine({ railId: BTC_RAIL, caip2: BTC_CAIP2, pubkey: PAYER_PUBKEY });
    const records = [recordSignedBy(ROOM, 1, T0, seller, buyer.did, line)];
    const result = resolvePubkeys(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
  });

  it("a conflict (two disagreeing lines from the same party) leaves that party unresolved, not first-wins", () => {
    const records = [pubkeyLineRecord(1, buyer, PAYER_PUBKEY), pubkeyLineRecord(2, buyer, fakePubkey("second-claim"))];
    const result = resolvePubkeys(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.reasons.some((r) => r.includes("conflicting pubkey lines") && r.includes(buyer.did))).toBe(true);
  });

  it("repeating the same pubkey twice is not a conflict", () => {
    const records = [pubkeyLineRecord(1, buyer, PAYER_PUBKEY), pubkeyLineRecord(2, buyer, PAYER_PUBKEY)];
    const result = resolvePubkeys(records, input);
    expect(result.payer).toBe(PAYER_PUBKEY);
    expect(result.reasons).toEqual([]);
  });

  it("ignores a line for a different chain (same rail, different caip2) and says why", () => {
    const otherChain = "bip122:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // any other well-formed 32-hex bip122 reference
    const otherChainLine = formatPubkeyLine({ railId: BTC_RAIL, caip2: otherChain, pubkey: PAYEE_PUBKEY });
    const records = [record(ROOM, 1, T0, seller, otherChainLine)];
    const result = resolvePubkeys(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons.some((r) => r.includes(otherChain))).toBe(true);
  });

  it("ignores a line for a different rail and says why", () => {
    const otherRailLine = formatAccountLine({ railId: "evm-htlc", caip2: "eip155:31337", address: getAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045") });
    const records = [record(ROOM, 1, T0, seller, otherRailLine)];
    const result = resolvePubkeys(records, input);
    expect(result.payee).toBeUndefined();
  });

  it("ignores a record posted in a different room, even byte-identical otherwise", () => {
    const line = formatPubkeyLine({ railId: BTC_RAIL, caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY });
    const otherRoom = dealRoom(OTHER_CONTRACT);
    const records = [record(otherRoom, 1, T0, seller, line)];
    const result = resolvePubkeys(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons).toEqual([]);
  });

  it("ignores a record posted in the shared offer room, not the swap's own deal room", () => {
    const line = formatPubkeyLine({ railId: BTC_RAIL, caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY });
    const records = [record(OFFER_ROOM, 1, T0, seller, line)];
    const result = resolvePubkeys(records, input);
    expect(result.payee).toBeUndefined();
  });

  it("ignores a line from a DID that is neither party to this swap", () => {
    const stranger = identity("f6".repeat(32));
    const line = formatPubkeyLine({ railId: BTC_RAIL, caip2: BTC_CAIP2, pubkey: PAYEE_PUBKEY });
    const records = [record(ROOM, 1, T0, stranger, line)];
    const result = resolvePubkeys(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
  });

  it("an account line in the same room does not satisfy the pubkey-line requirement", () => {
    const accountLine = formatAccountLine({ railId: "evm-htlc", caip2: "eip155:31337", address: getAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045") });
    const records = [record(ROOM, 1, T0, seller, accountLine)];
    const result = resolvePubkeys(records, input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons).toEqual([]); // not a pubkey line at all — silently not counted, same as any other unrelated line
  });

  it("returns everyone unresolved, with a reason, for an unregistered rail", () => {
    const result = resolvePubkeys([], { ...input, rail: "sol-htlc" });
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns everyone unresolved, with a reason, for a malformed contract id", () => {
    const result = resolvePubkeys([], { ...input, contract: "not-a-contract-id" });
    expect(result.payer).toBeUndefined();
    expect(result.payee).toBeUndefined();
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
