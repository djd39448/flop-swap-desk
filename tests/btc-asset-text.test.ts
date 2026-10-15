// SPDX-License-Identifier: MIT
//
// tests/btc-asset-text.test.ts: P10-KEY-02 (P10-FIXES-R1.md decision 4). `rails.btc.asset` is a config text of a hand-written rails file, which has no key field, and it used to
// reach three kinds of output whole: the evidence reason of a leg whose asset does not match (`btcEvidence`, read by `audit-export --rails` and the board), and the refusals of the
// Seller (`acceptLegA`) and the Buyer (`bid`, `lockLegA`) when an offer names another asset. A key or a phrase pasted into that field came back in them. Now the config check holds
// `asset` to the short plain name shape (`ASSET_NAME_SHAPE`, the EVM `assets` names' own) and refuses anything else by field name, and every message that names the rail's asset
// quotes it only through `quotedAssetNameOrPlaceholder`. Canonical names (`BTC`, `sBTC`, any plain name) are quoted exactly as before. Every key and phrase here is generated now
// and only ever scanned for (the scanners answer booleans, and an assertion on a text that could hold a key is made on a boolean, so a failing run never prints a byte of one).

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { LockTerms } from "@flop-labs/tclk";
import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { btcEvidence, type BtcCapture } from "../src/rails/btc-evidence.js";
import { BTC_REGTEST_PIN, checkBtcRailConfig, type BtcRailConfig } from "../src/rails/btc-htlc.js";
import { ASSET_NAME_SHAPE as EVM_ASSET_NAME_SHAPE } from "../src/rails/evm-htlc.js";
import { ASSET_NAME_SHAPE, quotedAssetNameOrPlaceholder, UNPLAIN_ASSET_NAME } from "../src/rails/pin-text.js";
import { runSweep } from "../src/watcher.js";
import { Controller, STEPS, readSwap } from "./helpers/crash-matrix.js";
import { phraseScanner, strippedKeyScanner } from "./helpers/evm-local.js";
import { ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { resumedBuyer, started } from "./helpers/resume-world.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadRails } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/** A rails.btc block as `watch.mjs --rails` or `audit-export --rails` would load it, with the asset field set. */
function btcBlock(asset: unknown): Record<string, unknown> {
  return { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:18443", asset };
}

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

async function rejectsWith(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/**
 * The spellings a key takes when someone pastes it into a field. A key CUT to 32 characters or fewer is itself a plain name and is quoted by design, the residual the pin texts
 * already have (PROVENANCE, B4): the shape cannot tell a short plain name from half a key.
 */
function spellingsOf(key: `0x${string}`): Array<[string, string]> {
  return [
    ["the key", key],
    ["the key without 0x", key.slice(2)],
    ["upper case", key.toUpperCase().replace("0X", "0x")],
    ["the key with a prefix and a space", `btc ${key}`],
    ["the key cut by spaces", key.slice(2).match(/.{1,8}/g)!.join(" ")],
  ];
}

/** A rail that reports another asset id than the one it was built with (the shape of a config whose `asset` is a pasted key), over the same fake chain. */
function withAsset(rail: CounterAssetRail, assetId: string): CounterAssetRail {
  return Object.create(rail, { assetId: { value: assetId, enumerable: true } }) as CounterAssetRail;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "btc-asset-text-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("P10-KEY-02: the shape and the helper are the EVM rail's own", () => {
  it("ASSET_NAME_SHAPE is one object for both rails; the helper quotes a plain name exactly as before and hides anything else", () => {
    expect(EVM_ASSET_NAME_SHAPE).toBe(ASSET_NAME_SHAPE);
    expect(quotedAssetNameOrPlaceholder("BTC")).toBe('"BTC"');
    expect(quotedAssetNameOrPlaceholder("sBTC")).toBe('"sBTC"');
    for (const text of ["", "two words", "a.b", "a/b", "x".repeat(33), "0".repeat(64), 7, null, undefined, { asset: "BTC" }]) {
      expect(quotedAssetNameOrPlaceholder(text), String(typeof text)).toBe(UNPLAIN_ASSET_NAME);
    }
    expect(UNPLAIN_ASSET_NAME).toBe("an asset whose name is not a short plain name");
  });
});

describe("P10-KEY-02: the Bitcoin config check holds asset to a short plain name, by field name", () => {
  it("plain names pass, including the canonical ones and the edge of the shape; everything else is refused", () => {
    for (const asset of [undefined, "BTC", "sBTC", "wbtc-test_1", "a", "x".repeat(32)]) {
      const value = asset === undefined ? { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:18443" } : btcBlock(asset);
      expect(checkBtcRailConfig(value).ok, String(asset)).toBe(true);
    }
    for (const asset of ["", "x".repeat(33), "two words", "a.b", "a/b", 7, null, {}, ["BTC"]]) {
      const reason = reasonOf(btcBlock(asset));
      expect(reason, JSON.stringify(asset)).toContain("asset must be a short plain name");
    }
  });

  it("a key as asset is refused by field name in every spelling, and no window of it is quoted", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    for (const [label, value] of spellingsOf(key)) {
      expect(scan(value), `${label}: the value must hold the key, or this test proves nothing`).toBe(true);
      const checked = checkBtcRailConfig(btcBlock(value));
      expect(checked.ok, label).toBe(false);
      const reason = checked.ok ? "" : checked.reason;
      expect(reason.includes("asset must be a short plain name"), `${label}: the refusal names the field`).toBe(true);
      expect(scan(reason), `${label}: no window of the key may be quoted`).toBe(false);
    }
  });

  it("a seed phrase as asset is refused and not quoted either", () => {
    const words = generateMnemonic(english).split(" ");
    const scan = phraseScanner(words);
    for (const [label, value] of [
      ["the phrase", words.join(" ")],
      ["numbered", words.map((word, index) => `${index + 1}. ${word}`).join(" ")],
      ["with commas", words.join(", ")],
    ] as const) {
      expect(scan(value), `${label}: the value must hold the phrase`).toBe(true);
      const reason = reasonOf(btcBlock(value));
      expect(reason.length > 0, `${label}: refused`).toBe(true);
      expect(scan(reason), `${label}: no four words of the phrase may be quoted`).toBe(false);
    }
  });
});

describe("P10-KEY-02: no message that names the rail's asset quotes a config text that is not a plain name", () => {
  /** A leg of the shape `btcEvidence` reads first, with a capture that only needs its ref: the asset check is the first thing after the ref check. */
  function mismatchedLeg(): { terms: LockTerms; capture: BtcCapture } {
    const label = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text)));
    const terms = {
      lock: "hash",
      statement: `0x${label("key02 statement")}`,
      amount: "100000000",
      refundAfterMs: 1_700_000_000_000,
      claimByMs: 1_699_990_000_000,
      payer: "did:key:payer",
      payee: "did:key:payee",
      asset: "USDC",
      contract: `0x${label("key02 contract")}`,
    } as unknown as LockTerms;
    const capture = { index: { ref: `${label("key02 funding")}:1`, checkedAtMs: 1_690_000_000_000, exchanges: [] } } as unknown as BtcCapture;
    return { terms, capture };
  }

  it("btcEvidence: a leg whose asset does not match says so without quoting a key used as the rail's own asset; a plain name is quoted as before", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const { terms, capture } = mismatchedLeg();
    for (const [label, value] of spellingsOf(key)) {
      const config = { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:18443", asset: value } as unknown as BtcRailConfig;
      const result = btcEvidence({ terms, config, accounts: {} as never, capture });
      const reason = result.lock.reason ?? "";
      expect(result.lock.railVerified, label).toBe(false);
      expect(reason.includes("does not match this rail's own asset"), `${label}: still a K3 refusal`).toBe(true);
      expect(scan(reason), `${label}: no window of the key`).toBe(false);
      expect(reason.includes(UNPLAIN_ASSET_NAME), `${label}: it says the asset is not a short plain name`).toBe(true);
    }
    for (const asset of [undefined, "BTC", "sBTC"]) {
      const config = { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:18443", ...(asset === undefined ? {} : { asset }) } as BtcRailConfig;
      const reason = btcEvidence({ terms, config, accounts: {} as never, capture }).lock.reason;
      expect(reason).toBe(`btc-htlc: leg asset "USDC" does not match this rail's own asset "${asset ?? "BTC"}" (K3)`);
    }
  });

  it("the Seller's acceptLegA, the Buyer's bid and the Buyer's lockLegA name the rail's asset only if it is a plain name", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const factory = ledgerWorldWith("btc", () => undefined);

    // the Seller: an offer for BTC against a rail that reports the pasted key as its asset
    const sellerWorld = factory(new Controller());
    const buyer = new BuyerFlow(sellerWorld.buyerOptions());
    await STEPS.bid.run({ w: sellerWorld, buyer, seller: new SellerFlow(sellerWorld.sellerOptions()), history: [] });
    const offerA = (await readSwap(sellerWorld)).offerA!;
    for (const [label, value] of spellingsOf(key)) {
      const options = sellerWorld.sellerOptions();
      const seller = new SellerFlow({ ...options, rail: withAsset(options.rail, value) });
      const message = await rejectsWith(() => seller.acceptLegA(offerA, sellerWorld.legB, sellerWorld.lockTimeMs));
      expect(message.includes("refusing to accept leg A - asset"), `seller ${label}: refused at the asset check`).toBe(true);
      expect(scan(message), `seller ${label}: no window of the key`).toBe(false);
      expect(message.includes(UNPLAIN_ASSET_NAME), `seller ${label}`).toBe(true);
    }
    const plainSeller = new SellerFlow({ ...sellerWorld.sellerOptions(), rail: withAsset(sellerWorld.sellerOptions().rail, "sBTC") });
    expect(await rejectsWith(() => plainSeller.acceptLegA(offerA, sellerWorld.legB, sellerWorld.lockTimeMs))).toContain(`does not match this rail's own asset "sBTC" (K3)`);

    // the Buyer's bid
    const bidWorld = factory(new Controller());
    for (const [label, value] of spellingsOf(key)) {
      const options = bidWorld.buyerOptions();
      const bidder = new BuyerFlow({ ...options, rail: withAsset(options.rail, value) });
      const message = await rejectsWith(() => bidder.bid(bidWorld.bidParams));
      expect(message.includes("refusing to bid asset"), `bid ${label}: refused at the asset check`).toBe(true);
      expect(scan(message), `bid ${label}: no window of the key`).toBe(false);
      expect(message.includes(UNPLAIN_ASSET_NAME), `bid ${label}`).toBe(true);
    }
    const plainBidder = new BuyerFlow({ ...bidWorld.buyerOptions(), rail: withAsset(bidWorld.buyerOptions().rail, "sBTC") });
    expect(await rejectsWith(() => plainBidder.bid(bidWorld.bidParams))).toContain(`this rail only ever settles "sBTC" (K3)`);

    // the Buyer's lockLegA, in a process resumed over a rail that now reports another asset
    const lockWorld = await started(factory, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.sellerLine, STEPS.lockLegB, STEPS.verify, STEPS.buyerLine]);
    for (const [label, value] of spellingsOf(key)) {
      const back = await resumedBuyer(lockWorld, (options) => ({ rail: withAsset(options.rail, value) }));
      const message = await rejectsWith(() => back.flow.lockLegA());
      expect(message.includes("refusing to lock leg A - asset"), `lock ${label}: refused at the asset check`).toBe(true);
      expect(scan(message), `lock ${label}: no window of the key`).toBe(false);
      expect(message.includes(UNPLAIN_ASSET_NAME), `lock ${label}`).toBe(true);
    }
  });
});

describe("P10-KEY-02: what watch.mjs and audit-export print holds no window of a key used as rails.btc.asset", () => {
  it("the sweep's railsConfigError and notes hold no window of it", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const report = await runSweep({
      root,
      baseUrl: "https://technocore.example",
      nowMs: () => 1_735_000_000_000,
      rails: { btc: btcBlock(key) as never },
      board: (() => {
        throw new Error("the board must not be built for an invalid rails config");
      }) as never,
      fetch: (async () => {
        throw new Error("no network for an invalid rails config");
      }) as never,
    });
    const railsConfigError = report.railsConfigError ?? "";
    const notes = report.notes.join("\n");
    expect(scan(railsConfigError), "railsConfigError must hold no window of the key").toBe(false);
    expect(scan(notes), "the notes must hold no window of the key").toBe(false);
    expect(railsConfigError.includes("asset must be a short plain name"), "the sweep aborted on this very field").toBe(true);
  });

  it("bin/watch.mjs --rails and examples/audit-export.mjs --rails (loadRails and the CLI over a root with raw/) print no window of it", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const railsFile = join(root, "rails-asset.json");
    await writeFile(railsFile, JSON.stringify({ btc: btcBlock(key) }));

    // watch.mjs validates the rails file before any network call, so this run is hermetic; the base URL is a closed local port all the same, so that even a build that did not refuse
    // the config would only fail to reach a venue (it must never reach a real one)
    const watched = spawnSync(process.execPath, [join(repoRoot, "bin", "watch.mjs"), "--root", join(root, "watch-asset"), "--base-url", "http://127.0.0.1:1", "--rails", railsFile, "--once"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(watched.status, "watch.mjs refuses the config").toBe(3);
    expect(watched.stderr.includes("asset must be a short plain name"), "watch.mjs names the field").toBe(true);
    expect(scan(watched.stdout), "watch.mjs stdout").toBe(false);
    expect(scan(watched.stderr), "watch.mjs stderr").toBe(false);

    // audit-export: the loader, with an explicit --rails file and with DIR/rails.json
    const viaFile = throwsWith(() => loadRails(root, railsFile));
    expect(viaFile.includes("btc rail config is invalid"), "loadRails refuses it").toBe(true);
    expect(scan(viaFile), "loadRails (--rails FILE) message").toBe(false);
    await writeFile(join(root, "rails.json"), JSON.stringify({ btc: btcBlock(key) }));
    expect(scan(throwsWith(() => loadRails(root, undefined))), "loadRails (DIR/rails.json) message").toBe(false);

    // and the compiled CLI over a watch root that has a raw/ directory
    await rm(join(root, "rails.json"), { force: true });
    await mkdir(join(root, "raw"), { recursive: true });
    const exported = spawnSync(process.execPath, [join(repoRoot, "examples", "audit-export.mjs"), "--root", root, "--rails", railsFile], { cwd: repoRoot, encoding: "utf8" });
    expect(exported.status, "audit-export reads the root and refuses the rails file").not.toBe(0);
    expect(exported.stderr.includes("asset must be a short plain name"), "audit-export names the field").toBe(true);
    expect(scan(exported.stdout), "audit-export stdout").toBe(false);
    expect(scan(exported.stderr), "audit-export stderr").toBe(false);
  });
});
