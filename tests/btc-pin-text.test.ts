// SPDX-License-Identifier: MIT
//
// tests/btc-pin-text.test.ts: P10 B4, the Bitcoin part (the KR3-3 rule of P9 review round 3, shared through src/rails/pin-text.ts). The Bitcoin
// rail's own refusals that name a pin's `name`, `network` or genesis hash used to quote the value whole, and those texts reach `bin/watch.mjs --rails`
// (the sweep's `railsConfigError`, its notes and stderr) and `examples/audit-export.mjs --rails`, files that have no key field: a key or a seed phrase
// pasted into the wrong field of a hand-written rails file came back in the message. They now quote a pin text only when it is a short plain text
// (`PIN_TEXT_SHAPE`), as the EVM rail does, and otherwise say the fixed `UNPLAIN_PIN_TEXT`. Every key and phrase here is generated now and only ever
// scanned for (the scanners answer booleans, and an assertion on a text that could hold a key is made on a boolean, so a failing run never prints a
// byte of one).

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { btcLocalPolicyFor } from "../src/client/policy.js";
import { BTC_REGTEST_PIN, BTC_SIGNET_PIN, BtcHtlcRail, btcFeeRuleFor, checkBtcRailConfig, validateBtcRailConfig, type BtcRailConfig } from "../src/rails/btc-htlc.js";
import { PIN_TEXT_SHAPE as EVM_PIN_TEXT_SHAPE } from "../src/rails/evm-htlc.js";
import { PIN_TEXT_SHAPE, quotedPinText, quotedPinTextOrPlaceholder, UNPLAIN_PIN_TEXT } from "../src/rails/pin-text.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { runSweep } from "../src/watcher.js";
import { phraseScanner, strippedKeyScanner } from "./helpers/evm-local.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadRails } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/** A hand-written rails.btc block as `watch.mjs --rails` or `audit-export --rails` would load it, with the fields of its pin replaced. */
function btcBlock(pin: Record<string, unknown>): Record<string, unknown> {
  return { pin, endpoint: "http://127.0.0.1:18443" };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "btc-pin-text-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function reasonOf(value: unknown): string {
  const checked = checkBtcRailConfig(value);
  return checked.ok ? "" : checked.reason;
}

function throwsWith(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** The spellings a key takes when someone pastes it into a field. */
function spellingsOf(key: `0x${string}`): Array<[string, string]> {
  return [
    ["the key", key],
    ["the key without 0x", key.slice(2)],
    ["upper case", key.toUpperCase().replace("0X", "0x")],
    ["the key with a prefix and a space", `btc ${key}`],
    ["the key cut by spaces", key.slice(2).match(/.{1,8}/g)!.join(" ")],
  ];
}

describe("P10 B4: the shared helper, and the EVM rail still uses the very same one", () => {
  it("PIN_TEXT_SHAPE is one object for both rails; quotedPinText and the placeholder follow it", () => {
    expect(EVM_PIN_TEXT_SHAPE).toBe(PIN_TEXT_SHAPE);
    expect(quotedPinText("btc-regtest")).toBe('"btc-regtest"');
    expect(quotedPinText("bip122:0f9188f13cb7b2c71f2a335e3a4fc328")).not.toBeNull();
    for (const text of ["", "two words", "a/b", `a${"b".repeat(40)}`, "0".repeat(64), 7, null, undefined, { name: "x" }]) {
      expect(quotedPinText(text), String(typeof text)).toBeNull();
      expect(quotedPinTextOrPlaceholder(text), String(typeof text)).toBe(UNPLAIN_PIN_TEXT);
    }
    expect(UNPLAIN_PIN_TEXT).toBe("a pin name (or caip2) that is not a short plain text");
  });

  it("both Bitcoin pins of this build have a name and a caip2 of the plain shape, so neither is ever hidden", () => {
    for (const pin of [BTC_REGTEST_PIN, BTC_SIGNET_PIN]) {
      expect(PIN_TEXT_SHAPE.test(pin.name), pin.network).toBe(true);
      expect(PIN_TEXT_SHAPE.test(pin.caip2), pin.network).toBe(true);
    }
  });
});

describe("P10 B4: the Bitcoin rail's refusals never quote a pin text that is not a short plain text", () => {
  it("a key as pin.name or pin.network is not quoted by checkBtcRailConfig, in any spelling", () => {
    for (const field of ["name", "network"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      for (const [label, value] of spellingsOf(key)) {
        expect(scan(value), `${field} ${label}: the value must hold the key, or this test proves nothing`).toBe(true);
        const checked = checkBtcRailConfig(btcBlock({ ...BTC_REGTEST_PIN, [field]: value }));
        expect(checked.ok, `${field} ${label}`).toBe(false);
        const reason = checked.ok ? "" : checked.reason;
        expect(scan(reason), `${field} ${label}: no window of the key may be quoted`).toBe(false);
        expect(reason.includes(UNPLAIN_PIN_TEXT), `${field} ${label}: the refusal says the value is not a short plain text`).toBe(true); // a boolean
      }
    }
  });

  it("a seed phrase as pin.name or pin.network is not quoted either", () => {
    for (const field of ["name", "network"] as const) {
      const words = generateMnemonic(english).split(" ");
      const scan = phraseScanner(words);
      for (const [label, value] of [
        ["the phrase", words.join(" ")],
        ["numbered", words.map((word, index) => `${index + 1}. ${word}`).join(" ")],
        ["with commas", words.join(", ")],
      ] as const) {
        expect(scan(value), `${field} ${label}: the value must hold the phrase`).toBe(true);
        const reason = reasonOf(btcBlock({ ...BTC_REGTEST_PIN, [field]: value }));
        expect(reason.length > 0, `${field} ${label}: refused`).toBe(true);
        expect(scan(reason), `${field} ${label}: no four words of the phrase may be quoted`).toBe(false);
        expect(reason.includes(UNPLAIN_PIN_TEXT), `${field} ${label}`).toBe(true);
      }
    }
  });

  it("a key as pin.genesisHash (64 hex digits is a genesis hash's own shape) or as pin.caip2 is not quoted", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const hex = key.slice(2);
    // well-shaped (64 lowercase hex, caip2 derived from it), so it reaches the known-pin check, which must not name it
    const asGenesis = reasonOf(btcBlock({ ...BTC_REGTEST_PIN, genesisHash: hex, caip2: `bip122:${hex.slice(0, 32)}` }));
    expect(asGenesis.includes("does not match any known pin"), "the genesis is not a pin this build knows").toBe(true);
    expect(scan(asGenesis), "no window of the key as a genesis hash").toBe(false);
    expect(asGenesis.includes("not one this build pins")).toBe(true);
    // a caip2 that is not the genesis prefix, and a genesis hash that is not well-shaped, are refused by the shape check, which names no value at all
    const asCaip2 = reasonOf(btcBlock({ ...BTC_REGTEST_PIN, caip2: key }));
    expect(asCaip2.length > 0 && !scan(asCaip2), "no window of the key as a caip2").toBe(true);
    const asShortGenesis = reasonOf(btcBlock({ ...BTC_REGTEST_PIN, genesisHash: key }));
    expect(asShortGenesis.length > 0 && !scan(asShortGenesis), "no window of the key as a malformed genesis hash").toBe(true);
    // the same call, directly (a caller that skips the shape check)
    const direct = throwsWith(() => validateBtcRailConfig({ pin: { ...BTC_REGTEST_PIN, genesisHash: hex } as never, endpoint: "http://127.0.0.1:18443" }));
    expect(direct.length > 0 && !scan(direct), "validateBtcRailConfig on its own").toBe(true);
  });

  it("a genesis hash this build pins itself IS named (it is a public constant), so the person sees what to fix", () => {
    const reason = reasonOf(btcBlock({ ...BTC_REGTEST_PIN, network: "signet" }));
    expect(reason).toContain(`genesisHash ${BTC_REGTEST_PIN.genesisHash}`);
    expect(reason).toContain('(network "signet"');
  });

  it("the sweep's railsConfigError and notes (what watch.mjs prints) hold no window of it", async () => {
    for (const field of ["name", "network"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      const report = await runSweep({
        root,
        baseUrl: "https://technocore.example",
        nowMs: () => 1_735_000_000_000,
        rails: { btc: btcBlock({ ...BTC_REGTEST_PIN, [field]: key }) as never },
        board: (() => {
          throw new Error("the board must not be built for an invalid rails config");
        }) as never,
        fetch: (async () => {
          throw new Error("no network for an invalid rails config");
        }) as never,
      });
      const railsConfigError = report.railsConfigError ?? "";
      const notes = report.notes.join("\n");
      expect(scan(railsConfigError), `${field}: railsConfigError must hold no window of the key`).toBe(false);
      expect(scan(notes), `${field}: the notes must hold no window of the key`).toBe(false);
      expect(railsConfigError.includes(UNPLAIN_PIN_TEXT), `${field}: the sweep aborted on this very config`).toBe(true);
      expect(notes.includes("rails.btc config is invalid, sweep aborted"), field).toBe(true);
    }
  });

  it("bin/watch.mjs --rails (stdout and stderr) and examples/audit-export.mjs --rails (loadRails and the CLI) print no window of it", async () => {
    for (const field of ["name", "network"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      const railsFile = join(root, `rails-${field}.json`);
      await writeFile(railsFile, JSON.stringify({ btc: btcBlock({ ...BTC_REGTEST_PIN, [field]: key }) }));

      // watch.mjs validates the rails file before any network call, so this run is hermetic
      const watched = spawnSync(process.execPath, [join(repoRoot, "bin", "watch.mjs"), "--root", join(root, `watch-${field}`), "--rails", railsFile, "--once"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(watched.status, `${field}: watch.mjs refuses the config`).toBe(3);
      expect(watched.stderr.includes(UNPLAIN_PIN_TEXT), `${field}: watch.mjs says the value is not a short plain text`).toBe(true);
      expect(scan(watched.stdout), `${field}: watch.mjs stdout`).toBe(false);
      expect(scan(watched.stderr), `${field}: watch.mjs stderr`).toBe(false);

      // audit-export: the loader, with an explicit --rails file and with DIR/rails.json
      const viaFile = throwsWith(() => loadRails(root, railsFile));
      expect(viaFile.includes("btc rail config is invalid"), `${field}: loadRails refuses it`).toBe(true);
      expect(scan(viaFile), `${field}: loadRails (--rails FILE) message`).toBe(false);
      await writeFile(join(root, "rails.json"), JSON.stringify({ btc: btcBlock({ ...BTC_REGTEST_PIN, [field]: key }) }));
      expect(scan(throwsWith(() => loadRails(root, undefined))), `${field}: loadRails (DIR/rails.json) message`).toBe(false);

      // and the compiled CLI, over a watch root that has a raw/ directory
      await rm(join(root, "rails.json"), { force: true });
      await writeFile(join(root, ".keep"), "");
      const exported = spawnSync(process.execPath, [join(repoRoot, "examples", "audit-export.mjs"), "--root", root, "--rails", railsFile], { cwd: repoRoot, encoding: "utf8" });
      expect(scan(exported.stdout), `${field}: audit-export stdout`).toBe(false);
      expect(scan(exported.stderr), `${field}: audit-export stderr`).toBe(false);
    }
  });

  it("BtcHtlcRail.connect, createBtcCounterRail, btcFeeRuleFor and btcLocalPolicyFor refuse a key as a network or a name without quoting it", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:1", fetch: (() => Promise.reject(new Error("no network in this test"))) as typeof fetch });
    for (const field of ["name", "network"] as const) {
      const config = { pin: { ...BTC_REGTEST_PIN, [field]: key }, endpoint: "http://127.0.0.1:1" } as unknown as BtcRailConfig;
      const connectError = await BtcHtlcRail.connect({ config, rpc }).then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(connectError.includes("refusing to connect"), `connect refuses a key as ${field}`).toBe(true);
      expect(scan(connectError), `connect, ${field}`).toBe(false);
    }
    const key2 = generatePrivateKey();
    const scan2 = strippedKeyScanner(key2);
    expect(scan2(throwsWith(() => btcFeeRuleFor(key2))), "btcFeeRuleFor").toBe(false);
    expect(throwsWith(() => btcFeeRuleFor(key2)).includes("no fee rule for network"), "btcFeeRuleFor refuses").toBe(true);
    expect(scan2(throwsWith(() => btcLocalPolicyFor(key2))), "btcLocalPolicyFor").toBe(false);
    expect(throwsWith(() => btcLocalPolicyFor(key2)).includes("no policy for network"), "btcLocalPolicyFor refuses").toBe(true);
    const wrapped = throwsWith(() =>
      createBtcCounterRail({
        config: { pin: { ...BTC_REGTEST_PIN, network: key2 }, endpoint: "http://127.0.0.1:1" } as unknown as BtcRailConfig,
        rpc,
        wallet: "w",
        key: { pubkey: `02${"a".repeat(64)}`, fingerprint: 0, path: [] },
        destinationAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
        clock: () => 0,
      }),
    );
    expect(wrapped.includes("no policy for network"), "the client wrapper refuses").toBe(true);
    expect(scan2(wrapped), "createBtcCounterRail").toBe(false);
  });

  it("the client wrapper's deployment id never carries a genesis prefix that is not a pin this build knows", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const hex = key.slice(2);
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:1", fetch: (() => Promise.reject(new Error("no network in this test"))) as typeof fetch });
    const rail = createBtcCounterRail({
      config: { pin: { ...BTC_REGTEST_PIN, genesisHash: hex, caip2: `bip122:${hex.slice(0, 32)}` }, endpoint: "http://127.0.0.1:1" },
      rpc,
      wallet: "w",
      key: { pubkey: `02${"a".repeat(64)}`, fingerprint: 0, path: [] },
      destinationAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
      clock: () => 0,
    });
    expect(scan(rail.deploymentId), "deploymentId").toBe(false);
    // and a real pin's id is what it always was
    const real = createBtcCounterRail({
      config: { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:1" },
      rpc,
      wallet: "w",
      key: { pubkey: `02${"a".repeat(64)}`, fingerprint: 0, path: [] },
      destinationAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
      clock: () => 0,
    });
    expect(real.deploymentId).toBe("btc-htlc:network=regtest:genesis=0f9188f13cb7b2c71f2a335e3a4fc328");
  });

  it("a plain but wrong name or network is still quoted, so the person can see what to fix", () => {
    expect(reasonOf(btcBlock({ ...BTC_SIGNET_PIN, name: "btc-signet" }))).toContain(`pin.name "btc-signet" does not match the known pin's own name "btc-signet-UNVERIFIED"`);
    expect(reasonOf(btcBlock({ ...BTC_REGTEST_PIN, network: "mainnet" }))).toContain('network "mainnet" is not on the allow list');
    expect(throwsWith(() => btcFeeRuleFor("main"))).toContain('no fee rule for network "main"');
    expect(throwsWith(() => btcLocalPolicyFor("main"))).toContain('no policy for network "main"');
  });

  it("the edge is the EVM rail's own: 40 plain characters are quoted, 41 are not, and a space, a slash or a non-ASCII letter is never plain", () => {
    const forty = `a${"b".repeat(39)}`;
    expect(reasonOf(btcBlock({ ...BTC_REGTEST_PIN, name: forty }))).toContain(`pin.name "${forty}" does not match`);
    expect(reasonOf(btcBlock({ ...BTC_REGTEST_PIN, name: `${forty}c` }))).toContain(`pin.name ${UNPLAIN_PIN_TEXT} does not match`);
    for (const name of ["two words", "a/b", "caf\u00e9", "tab\there", 'quote"d']) {
      const reason = reasonOf(btcBlock({ ...BTC_REGTEST_PIN, name }));
      expect(reason, JSON.stringify(name.length)).toContain(`pin.name ${UNPLAIN_PIN_TEXT} does not match`);
      expect(reason.includes(name), JSON.stringify(name.length)).toBe(false);
    }
  });
});
