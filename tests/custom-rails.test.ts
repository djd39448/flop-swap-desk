// SPDX-License-Identifier: MIT
//
// tests/custom-rails.test.ts - the desk-side custom rail id shim (P6-SOL-SPEC.md section 4) and its use by
// the account line: a caller-owned registry admits exactly the configured owner-namespaced ids; everything
// else keeps tclk's closed-registry behaviour; the vendored tclk is untouched; the Solana rail id is spelled
// in exactly one constant.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { dealRoom, normalizeRailId } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { formatAccountLine, parseAccountLine, resolveAccounts, RAIL_NAMESPACES } from "../src/rails/account-line.js";
import {
  SOL_NAMESPACE,
  SOL_RAIL_ID,
  createCustomRailRegistry,
  createSolRailRegistry,
  normalizeRailIdWith,
  requireAdmittedRailId,
} from "../src/rails/custom-rails.js";
import { pubkeyToBase58 } from "../src/rails/sol-tx.js";
import { identity, record } from "./helpers/identity.js";

const PUBKEY = pubkeyToBase58(new Uint8Array(32).fill(7));
const CAIP2 = "solana:localnet-flop";
const LINE = `swap1 account ${SOL_RAIL_ID} ${CAIP2}:${PUBKEY}`;

describe("SOL_RAIL_ID and the registry", () => {
  it("is the decided owner-namespaced custom id", () => {
    expect(SOL_RAIL_ID).toBe("trustcore.sol-htlc-v1");
    expect(SOL_NAMESPACE).toBe("solana");
  });

  it("admits exactly the configured ids, spelled exactly", () => {
    const registry = createSolRailRegistry();
    expect(registry.ids()).toEqual([SOL_RAIL_ID]);
    expect(registry.has(SOL_RAIL_ID)).toBe(true);
    expect(registry.namespaceOf(SOL_RAIL_ID)).toBe("solana");
    for (const other of ["evm-htlc", "trustcore.sol-htlc-v2", "TrustCore.sol-htlc-v1", " trustcore.sol-htlc-v1", "trustcore.sol-htlc-v1 ", "trustcore.sol-htlc", "", "constructor", "__proto__"]) {
      expect(registry.has(other), other).toBe(false);
      expect(registry.namespaceOf(other), other).toBeUndefined();
    }
    expect(registry.has(undefined as unknown as string)).toBe(false);
  });

  it("is a caller-owned object, never process-global: two registries never see each other and an empty one admits nothing", () => {
    const a = createSolRailRegistry();
    const b = createCustomRailRegistry([{ id: "acme.other-htlc-v3", namespace: "acme" }]);
    const none = createCustomRailRegistry([]);
    expect(a).not.toBe(createSolRailRegistry());
    expect(a.has("acme.other-htlc-v3")).toBe(false);
    expect(b.has(SOL_RAIL_ID)).toBe(false);
    expect(none.has(SOL_RAIL_ID)).toBe(false);
    expect(none.ids()).toEqual([]);
    // creating a registry elsewhere admitted nothing here (there is no shared state to leak into)
    expect(() => normalizeRailIdWith(SOL_RAIL_ID)).toThrow(/malformed rail id|unknown rail id/);
  });

  it("is immutable: its object is frozen and its id list is a copy", () => {
    const registry = createSolRailRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
    const ids = registry.ids() as string[];
    ids.push("evil.rail-v1");
    expect(registry.ids()).toEqual([SOL_RAIL_ID]);
    expect(() => {
      (registry as unknown as { has: () => boolean }).has = () => true;
    }).toThrow();
    expect(registry.has("evil.rail-v1")).toBe(false);
  });

  it("refuses malformed ids, duplicates, bad namespaces and ids that are not owner-namespaced and versioned", () => {
    const ns = "abc";
    for (const id of ["evm-htlc", "btc-htlc", "TrustCore.sol-htlc-v1", "trustcore.sol-htlc", "trustcore.sol-htlc-v0", "trustcore.sol-htlc-v01", ".sol-htlc-v1", "trustcore..sol-v1", "trustcore.sol htlc-v1", ""]) {
      expect(() => createCustomRailRegistry([{ id, namespace: ns }]), id).toThrow(/owner-namespaced/);
    }
    expect(() => createCustomRailRegistry([{ id: SOL_RAIL_ID, namespace: "" }])).toThrow(/namespace/);
    expect(() => createCustomRailRegistry([{ id: SOL_RAIL_ID, namespace: "A" }])).toThrow(/namespace/);
    expect(() =>
      createCustomRailRegistry([
        { id: SOL_RAIL_ID, namespace: "solana" },
        { id: SOL_RAIL_ID, namespace: "solana" },
      ]),
    ).toThrow(/duplicate/);
  });

  it("normalizeRailIdWith: a configured custom id passes, everything else is tclk's own closed behaviour", () => {
    const registry = createSolRailRegistry();
    expect(normalizeRailIdWith(SOL_RAIL_ID, registry)).toBe(SOL_RAIL_ID);
    expect(normalizeRailIdWith("evm-htlc", registry)).toBe("evm-htlc");
    expect(normalizeRailIdWith(" EVM-HTLC ", registry)).toBe(normalizeRailId(" EVM-HTLC "));
    // no aliasing of the custom id: a case-folded or padded spelling is NOT admitted and falls through to tclk's error
    expect(() => normalizeRailIdWith("Trustcore.sol-htlc-v1", registry)).toThrow(/malformed rail id|unknown rail id/);
    expect(() => normalizeRailIdWith(" trustcore.sol-htlc-v1", registry)).toThrow(/malformed rail id|unknown rail id/);
    expect(() => normalizeRailIdWith("acme.other-htlc-v1", registry)).toThrow(/unknown rail id|malformed rail id/);
    expect(() => normalizeRailIdWith("", registry)).toThrow();
    // without a registry it IS tclk's normalizeRailId
    expect(() => normalizeRailIdWith(SOL_RAIL_ID)).toThrow(normalizeRailIdThrows());
  });

  it("the vendored tclk registry is unchanged: it still refuses the custom id", () => {
    expect(() => normalizeRailId(SOL_RAIL_ID)).toThrow(/unknown rail id|malformed rail id/);
    expect(Object.keys(RAIL_NAMESPACES).sort()).toEqual(["btc-htlc", "evm-htlc", "near-htlc"]);
  });

  it("requireAdmittedRailId (frame emission, SB3) throws for anything the registry does not admit", () => {
    const registry = createSolRailRegistry();
    expect(requireAdmittedRailId(SOL_RAIL_ID, registry)).toBe(SOL_RAIL_ID);
    expect(() => requireAdmittedRailId("evm-htlc", registry)).toThrow(/not admitted/);
    expect(() => requireAdmittedRailId(SOL_RAIL_ID, createCustomRailRegistry([]))).toThrow(/not admitted/);
  });

  it("the Solana rail id is spelled in exactly one place under src/", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|mjs|js|json)$/.test(name)) {
          const count = readFileSync(path, "utf8").split(SOL_RAIL_ID).length - 1;
          for (let i = 0; i < count; i += 1) hits.push(path.replace(/\\/g, "/"));
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(hits).toEqual([expect.stringMatching(/src\/rails\/custom-rails\.ts$/)]);
  });
});

function normalizeRailIdThrows(): RegExp {
  return /unknown rail id|malformed rail id/;
}

describe("the account line with a custom rail registry", () => {
  const registry = createSolRailRegistry();

  it("formats and parses the Solana line only through the registry", () => {
    expect(formatAccountLine({ railId: SOL_RAIL_ID, caip2: CAIP2, address: PUBKEY }, registry)).toBe(LINE);
    expect(parseAccountLine(LINE, registry)).toEqual({ railId: SOL_RAIL_ID, caip2: CAIP2, address: PUBKEY });
    // closed by default: no registry, no line
    expect(() => formatAccountLine({ railId: SOL_RAIL_ID, caip2: CAIP2, address: PUBKEY })).toThrow(/unknown rail id|malformed rail id/);
    expect(parseAccountLine(LINE)).toBeNull();
    // a registry that does not admit it behaves like no registry
    expect(parseAccountLine(LINE, createCustomRailRegistry([]))).toBeNull();
  });

  it("a genesis-hash-prefix reference (a public cluster's caip2) is accepted too", () => {
    const line = `swap1 account ${SOL_RAIL_ID} solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${PUBKEY}`;
    expect(parseAccountLine(line, registry)?.caip2).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });

  it("refuses an address that is not the canonical base58 spelling of exactly 32 bytes", () => {
    for (const address of ["1".repeat(31), "1".repeat(33), `${PUBKEY}${PUBKEY}`, `0${PUBKEY.slice(1)}`, `${PUBKEY.slice(0, 10)}I${PUBKEY.slice(11)}`, PUBKEY.slice(0, 30), ""]) {
      expect(parseAccountLine(`swap1 account ${SOL_RAIL_ID} ${CAIP2}:${address}`, registry), address).toBeNull();
      expect(() => formatAccountLine({ railId: SOL_RAIL_ID, caip2: CAIP2, address }, registry), address).toThrow(/not a valid solana address/);
    }
    // case is significant in base58: a case-mangled spelling is never returned as OUR key
    const mangled = PUBKEY.toLowerCase() === PUBKEY ? PUBKEY.toUpperCase() : PUBKEY.toLowerCase();
    expect(parseAccountLine(`swap1 account ${SOL_RAIL_ID} ${CAIP2}:${mangled}`, registry)?.address ?? null).not.toBe(PUBKEY);
    // the all-zero key (the system program id) is a well-formed 32-byte address; whether a payee may be it is the adapter's rule, not the line's
    expect(parseAccountLine(`swap1 account ${SOL_RAIL_ID} ${CAIP2}:${"1".repeat(32)}`, registry)?.address).toBe("1".repeat(32));
  });

  it("refuses a wrong-namespace caip2, a malformed caip2 and a non-canonical rail spelling", () => {
    expect(parseAccountLine(`swap1 account ${SOL_RAIL_ID} near:localnet-flop:${PUBKEY}`, registry)).toBeNull();
    expect(parseAccountLine(`swap1 account ${SOL_RAIL_ID} eip155:1:${PUBKEY}`, registry)).toBeNull();
    expect(parseAccountLine(`swap1 account ${SOL_RAIL_ID} solana::${PUBKEY}`, registry)).toBeNull();
    expect(parseAccountLine(`swap1 account ${SOL_RAIL_ID} solana:${PUBKEY}`, registry)).toBeNull();
    expect(parseAccountLine(`swap1 account Trustcore.sol-htlc-v1 ${CAIP2}:${PUBKEY}`, registry)).toBeNull();
    expect(() => formatAccountLine({ railId: SOL_RAIL_ID, caip2: "near:x", address: PUBKEY }, registry)).toThrow(/does not match rail/);
  });

  it("the built-in rails parse exactly as before with a registry present", () => {
    const evm = "swap1 account evm-htlc eip155:31337:0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    expect(parseAccountLine(evm, registry)).toEqual(parseAccountLine(evm));
    const near = "swap1 account near-htlc near:near-sandbox-flop:buyer.near-sandbox-flop";
    expect(parseAccountLine(near, registry)).toEqual(parseAccountLine(near));
    expect(parseAccountLine(`swap1 account near-htlc solana:localnet-flop:${PUBKEY}`, registry)).toBeNull();
  });

  describe("resolveAccounts", () => {
    const buyer = identity("d4".repeat(32));
    const seller = identity("e5".repeat(32));
    const CONTRACT = `0x${"ab".repeat(32)}`;
    const ROOM = dealRoom(CONTRACT);
    const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: SOL_RAIL_ID, caip2: CAIP2 };
    const T0 = 1_758_000_000_000;

    it("resolves the Solana payee through the registry with the usual sender binding", () => {
      const payeeKey = pubkeyToBase58(new Uint8Array(32).fill(9));
      const records = [record(ROOM, 1, T0, seller, formatAccountLine({ railId: SOL_RAIL_ID, caip2: CAIP2, address: payeeKey }, registry))];
      const result = resolveAccounts(records, { ...input, railRegistry: registry });
      expect(result.payee).toBe(payeeKey);
      expect(result.payer).toBeUndefined();
      expect(result.reasons).toEqual([]);
    });

    it("without the registry the rail is unregistered and nothing resolves", () => {
      const records = [record(ROOM, 1, T0, seller, LINE)];
      const result = resolveAccounts(records, input);
      expect(result.payee).toBeUndefined();
      expect(result.reasons).toEqual([expect.stringContaining("not a registered rail id")]);
    });

    it("a line for another chain is ignored with a reason, and disagreeing lines leave the party unresolved", () => {
      const other = pubkeyToBase58(new Uint8Array(32).fill(3));
      const wrongChain = `swap1 account ${SOL_RAIL_ID} solana:devnet-x:${PUBKEY}`;
      const records = [record(ROOM, 1, T0, seller, wrongChain)];
      const wrong = resolveAccounts(records, { ...input, railRegistry: registry });
      expect(wrong.payee).toBeUndefined();
      expect(wrong.reasons.some((r) => r.includes("solana:devnet-x"))).toBe(true);
      const conflict = resolveAccounts(
        [record(ROOM, 1, T0, seller, LINE), record(ROOM, 2, T0 + 1, seller, `swap1 account ${SOL_RAIL_ID} ${CAIP2}:${other}`)],
        { ...input, railRegistry: registry },
      );
      expect(conflict.payee).toBeUndefined();
      expect(conflict.reasons.some((r) => r.includes("conflicting account lines"))).toBe(true);
    });
  });
});
