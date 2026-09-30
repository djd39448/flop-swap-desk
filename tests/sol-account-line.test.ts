// SPDX-License-Identifier: MIT
//
// tests/sol-account-line.test.ts - the Solana account line (`swap1 account <SOL_RAIL_ID> solana:<ref>:<base58>`)
// through the custom-rails registry: `formatSolAccountLine` / `resolveSolAccounts`. The rules of
// `resolveAccounts` (sender-bound, room-scoped, lines before the accepted lock only, other rails and chains
// ignored, conflicts unresolved) are re-proved here for the Solana id, because the id reaches the resolver only
// through a caller-owned registry and a regression there would silently drop or widen the lines.

import { dealRoom } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { formatAccountLine, formatSolAccountLine, resolveSolAccounts } from "../src/rails/account-line.js";
import { SOL_RAIL_ID, createCustomRailRegistry, createSolRailRegistry } from "../src/rails/custom-rails.js";
import { pubkeyToBase58 } from "../src/rails/sol-tx.js";
import { identity, record, recordSignedBy, unsignedRecord } from "./helpers/identity.js";

const T0 = 1_758_000_000_000;
const buyer = identity("d4".repeat(32));
const seller = identity("e5".repeat(32));
const outsider = identity("f6".repeat(32));
const CONTRACT = `0x${"ab".repeat(32)}`;
const ROOM = dealRoom(CONTRACT);
const CAIP2 = "solana:localnet-flop";
const BUYER_KEY = pubkeyToBase58(new Uint8Array(32).fill(1));
const SELLER_KEY = pubkeyToBase58(new Uint8Array(32).fill(2));
const OTHER_KEY = pubkeyToBase58(new Uint8Array(32).fill(3));
const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, caip2: CAIP2 };

function line(seq: number, signer: typeof buyer, address: string, room: string = ROOM, caip2: string = CAIP2): ReturnType<typeof record> {
  return record(room, seq, T0 + seq * 60_000, signer, formatSolAccountLine({ caip2, address }));
}

describe("formatSolAccountLine", () => {
  it("builds the line with the one Solana rail id and refuses anything that is not a canonical 32-byte base58 address", () => {
    expect(formatSolAccountLine({ caip2: CAIP2, address: SELLER_KEY })).toBe(`swap1 account ${SOL_RAIL_ID} ${CAIP2}:${SELLER_KEY}`);
    expect(() => formatSolAccountLine({ caip2: CAIP2, address: "0x" + "ab".repeat(20) })).toThrow(/not a valid solana address/);
    expect(() => formatSolAccountLine({ caip2: CAIP2, address: SELLER_KEY.slice(1) })).toThrow();
    expect(() => formatSolAccountLine({ caip2: "eip155:1", address: SELLER_KEY })).toThrow(/does not match rail/);
  });

  it("is closed without the registry that admits the id: a registry that does not admit it refuses", () => {
    expect(() => formatSolAccountLine({ caip2: CAIP2, address: SELLER_KEY }, createCustomRailRegistry([]))).toThrow(/unknown rail id|malformed rail id/);
    expect(() => formatAccountLine({ railId: SOL_RAIL_ID, caip2: CAIP2, address: SELLER_KEY })).toThrow(/unknown rail id|malformed rail id/);
  });
});

describe("resolveSolAccounts", () => {
  it("resolves each party from its own line (sender binding), payer and payee independently", () => {
    const result = resolveSolAccounts([line(1, buyer, BUYER_KEY), line(2, seller, SELLER_KEY)], input);
    expect(result).toEqual({ reasons: [], payer: BUYER_KEY, payee: SELLER_KEY });
    expect(resolveSolAccounts([line(1, buyer, BUYER_KEY)], input).payee).toBeUndefined();
    expect(resolveSolAccounts([line(1, seller, SELLER_KEY)], input).payer).toBeUndefined();
  });

  it("only lines BEFORE the accepted lock count (beforeSeq): a later line neither resolves nor un-resolves a party", () => {
    const records = [line(1, seller, SELLER_KEY), line(5, seller, OTHER_KEY), line(6, buyer, BUYER_KEY)];
    const early = resolveSolAccounts(records, { ...input, beforeSeq: 5 });
    expect(early.payee).toBe(SELLER_KEY);
    expect(early.payer).toBeUndefined();
    expect(early.reasons).toEqual([]);
    // without the bound, the later disagreeing line makes the payee unresolved
    expect(resolveSolAccounts(records, input).payee).toBeUndefined();
  });

  it("conflicting lines from one party leave it unresolved, not first-wins; a repeated identical line is no conflict", () => {
    const conflict = resolveSolAccounts([line(1, seller, SELLER_KEY), line(2, seller, OTHER_KEY)], input);
    expect(conflict.payee).toBeUndefined();
    expect(conflict.reasons.some((r) => r.includes("conflicting account lines") && r.includes(seller.did))).toBe(true);
    expect(resolveSolAccounts([line(1, seller, SELLER_KEY), line(2, seller, SELLER_KEY)], input).payee).toBe(SELLER_KEY);
  });

  it("ignores an unsigned record, a forged sender, a line in another room, and a sender who is not a party", () => {
    const text = formatSolAccountLine({ caip2: CAIP2, address: SELLER_KEY });
    expect(resolveSolAccounts([unsignedRecord(ROOM, 1, T0, text)], input).payee).toBeUndefined();
    expect(resolveSolAccounts([recordSignedBy(ROOM, 1, T0, outsider, seller.did, text)], input).payee).toBeUndefined();
    expect(resolveSolAccounts([line(1, seller, SELLER_KEY, dealRoom(`0x${"cd".repeat(32)}`))], input).payee).toBeUndefined();
    expect(resolveSolAccounts([line(1, outsider, SELLER_KEY)], input)).toEqual({ reasons: [] });
  });

  it("a line for another chain is ignored with a reason, a line for another rail is ignored with a reason", () => {
    const other = resolveSolAccounts([line(1, seller, SELLER_KEY, ROOM, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")], input);
    expect(other.payee).toBeUndefined();
    expect(other.reasons.some((r) => r.includes("not \"solana:localnet-flop\""))).toBe(true);
    // an EVM line in the same room never resolves a Solana address (and does not throw)
    const evm = record(ROOM, 1, T0, seller, `swap1 account evm-htlc eip155:31337:0x${"ab".repeat(20)}`);
    const evmResult = resolveSolAccounts([evm], input);
    expect(evmResult.payee).toBeUndefined();
    expect(evmResult.reasons[0]).toMatch(/rail "evm-htlc", not "trustcore\.sol-htlc-v1"/);
  });

  it("an explicit registry that does not admit the id resolves nothing (the id is never process-global)", () => {
    const result = resolveSolAccounts([line(1, seller, SELLER_KEY)], { ...input, railRegistry: createCustomRailRegistry([]) });
    expect(result.payee).toBeUndefined();
    expect(result.reasons[0]).toMatch(/not a registered rail id/);
    expect(resolveSolAccounts([line(1, seller, SELLER_KEY)], { ...input, railRegistry: createSolRailRegistry() }).payee).toBe(SELLER_KEY);
  });
});
