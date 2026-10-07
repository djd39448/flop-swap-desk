// SPDX-License-Identifier: MIT
//
// tests/rail-pin-text.test.ts: KR3-3 (P9 review round 3). The EVM rail's own refusals quote `pin.name` and `pin.caip2`, and those texts reach `bin/watch.mjs` (the
// sweep's `railsConfigError`, its notes and stderr) and `examples/audit-export.mjs --rails`, files that have no key field. A key pasted into either field of a
// hand-written rails file used to come back whole. The refusals now quote the two values only when they are a short plain text (`PIN_TEXT_SHAPE`), as
// `UNPLAIN_ASSET` does for asset names. Every key here is generated now and only ever scanned for (the scanners answer booleans, and an assertion on a text that
// could hold a key is made on a boolean, so a failing run never prints a byte of one).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BTC_REGTEST_PIN, BTC_SIGNET_PIN } from "../src/rails/btc-htlc.js";
import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN, checkEvmRailConfig, PIN_TEXT_SHAPE } from "../src/rails/evm-htlc.js";
import { NEAR_SANDBOX_PIN, NEAR_TESTNET_PIN } from "../src/rails/near-htlc.js";
import { SOL_DEVNET_PIN, SOL_LOCAL_PIN } from "../src/rails/sol-htlc.js";
import { runSweep } from "../src/watcher.js";
import { strippedKeyScanner } from "./helpers/evm-local.js";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const UNPLAIN = "a pin name (or caip2) that is not a short plain text";

/** A hand-written rails.evm block as `watch.mjs --rails` or `audit-export --rails` would load it, with one field of its pin replaced. */
function evmBlock(pin: Record<string, unknown>): Record<string, unknown> {
  return {
    pin,
    endpoint: "https://sepolia.base.org",
    contract: CONTRACT,
    assets: { USDC: TOKEN },
    contractCodeHash: `0x${"ab".repeat(32)}`,
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pin-text-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** What a sweep says about a rails.evm block: the report's railsConfigError and every note, joined. */
async function sweepTexts(evm: Record<string, unknown>): Promise<{ railsConfigError: string; notes: string }> {
  const report = await runSweep({
    root,
    baseUrl: "https://technocore.example",
    nowMs: () => 1_735_000_000_000,
    rails: { evm: evm as never },
    board: (() => {
      throw new Error("the board must not be built for an invalid rails config");
    }) as never,
    fetch: (async () => {
      throw new Error("no network for an invalid rails config");
    }) as never,
  });
  return { railsConfigError: report.railsConfigError ?? "", notes: report.notes.join("\n") };
}

describe("KR3-3: the rail's refusals never quote a pin name or caip2 that is not a short plain text", () => {
  it("a key as pin.name or as pin.caip2 is not quoted by checkEvmRailConfig, in any case or with a prefix", async () => {
    for (const field of ["name", "caip2"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      for (const [label, value] of [
        ["the key", key],
        ["the key without 0x", key.slice(2)],
        ["upper case", key.toUpperCase().replace("0X", "0x")],
        ["the key with a prefix and a space", `base ${key}`],
        ["the key cut by spaces", key.slice(2).match(/.{1,8}/g)!.join(" ")],
      ] as const) {
        expect(scan(value), `${field} ${label}: the value must hold the key, or this test proves nothing`).toBe(true);
        const checked = checkEvmRailConfig(evmBlock({ ...BASE_SEPOLIA_PIN, [field]: value }));
        expect(checked.ok, `${field} ${label}`).toBe(false);
        const reason = checked.ok ? "" : checked.reason;
        expect(scan(reason), `${field} ${label}: no window of the key may be quoted`).toBe(false);
        expect(reason.includes(UNPLAIN), `${field} ${label}: the refusal says the value is not a short plain text`).toBe(true); // a boolean: a failing run must not print the reason
      }
    }
  });

  it("the sweep's railsConfigError and notes (what watch.mjs prints) hold no window of it either", async () => {
    for (const field of ["name", "caip2"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      const { railsConfigError, notes } = await sweepTexts(evmBlock({ ...BASE_SEPOLIA_PIN, [field]: key }));
      expect(scan(railsConfigError), `${field}: railsConfigError must hold no window of the key`).toBe(false);
      expect(scan(notes), `${field}: the notes must hold no window of the key`).toBe(false);
      expect(railsConfigError.includes(UNPLAIN), `${field}: the sweep aborted on this very config`).toBe(true);
      expect(notes.includes("rails.evm config is invalid, sweep aborted"), field).toBe(true);
    }
  });

  it("a plain but wrong name or caip2 is still quoted, so the person can see what to fix", async () => {
    // A name wrong for its chain id: base-sepolia on the anvil chain id, and a made-up name on Base Sepolia.
    const wrongOnAnvil = checkEvmRailConfig(evmBlock({ ...ANVIL_LOCAL_PIN, name: "base-sepolia" }));
    expect(wrongOnAnvil.ok).toBe(false);
    expect(wrongOnAnvil.ok ? "" : wrongOnAnvil.reason).toContain('chain id 31337 must be pinned as "anvil-local", got "base-sepolia"');
    const wrongOnBase = checkEvmRailConfig(evmBlock({ ...BASE_SEPOLIA_PIN, name: "my-testnet_2.0" }));
    expect(wrongOnBase.ok ? "" : wrongOnBase.reason).toContain('must be pinned as "base-sepolia", got "my-testnet_2.0"');
    // A caip2 that does not match its chain id.
    const wrongCaip2 = checkEvmRailConfig(evmBlock({ ...BASE_SEPOLIA_PIN, caip2: "eip155:1" }));
    expect(wrongCaip2.ok ? "" : wrongCaip2.reason).toContain('pin.caip2 "eip155:1" does not match pin.chainId 84532 (expected "eip155:84532")');
    // The sweep reports the same sentences.
    expect((await sweepTexts(evmBlock({ ...BASE_SEPOLIA_PIN, caip2: "eip155:1" }))).railsConfigError).toContain('pin.caip2 "eip155:1" does not match');
    expect((await sweepTexts(evmBlock({ ...ANVIL_LOCAL_PIN, name: "base-sepolia" }))).railsConfigError).toContain('got "base-sepolia"');
  });

  it("the edge is the runner's own: 40 plain characters are quoted, 41 are not, and a space, a slash or a non-ASCII letter is never plain", () => {
    const forty = `a${"b".repeat(39)}`;
    const reasonOf = (pin: Record<string, unknown>): string => {
      const checked = checkEvmRailConfig(evmBlock(pin));
      return checked.ok ? "" : checked.reason;
    };
    expect(reasonOf({ ...BASE_SEPOLIA_PIN, name: forty })).toContain(`got "${forty}"`);
    expect(reasonOf({ ...BASE_SEPOLIA_PIN, name: `${forty}c` })).toContain(`got ${UNPLAIN}`);
    for (const name of ["two words", "a/b", "caf\u00e9", "tab\there", "quote\"d"]) {
      const reason = reasonOf({ ...BASE_SEPOLIA_PIN, name });
      expect(reason, JSON.stringify(name.length)).toContain(`got ${UNPLAIN}`);
      expect(reason, JSON.stringify(name.length)).not.toContain(name);
    }
    expect(reasonOf({ ...BASE_SEPOLIA_PIN, caip2: `eip155:${"9".repeat(40)}` })).toContain(`pin.caip2 is ${UNPLAIN} and does not match`);
  });

  it("every real pin of this build (eip155:84532, the anvil pin, bip122:..., near:..., solana:...) has a name and a caip2 of the plain shape, so none is ever hidden", () => {
    const pins = [BASE_SEPOLIA_PIN, ANVIL_LOCAL_PIN, BTC_REGTEST_PIN, BTC_SIGNET_PIN, NEAR_SANDBOX_PIN, NEAR_TESTNET_PIN, SOL_LOCAL_PIN, SOL_DEVNET_PIN];
    for (const pin of pins) {
      expect(PIN_TEXT_SHAPE.test(pin.name), `name of ${pin.caip2.split(":")[0]}`).toBe(true);
      expect(PIN_TEXT_SHAPE.test(pin.caip2), `caip2 of ${pin.caip2.split(":")[0]}`).toBe(true);
    }
    expect(BASE_SEPOLIA_PIN.caip2).toBe("eip155:84532");
    expect(BTC_REGTEST_PIN.caip2.startsWith("bip122:")).toBe(true);
    // The two pins a rails.evm block may carry are still accepted end to end.
    expect(checkEvmRailConfig(evmBlock({ ...BASE_SEPOLIA_PIN })).ok).toBe(true);
    expect(checkEvmRailConfig({ ...evmBlock({ ...ANVIL_LOCAL_PIN }), endpoint: "http://127.0.0.1:8545" }).ok).toBe(true);
  });
});
