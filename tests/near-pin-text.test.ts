// SPDX-License-Identifier: MIT
//
// tests/near-pin-text.test.ts: P10 B4, the NEAR part (the KR3-3 rule of P9 review round 3 and the K2 rule of round 1, shared through src/rails/pin-text.ts). The NEAR
// rail's own refusals used to quote the chain id, the pin name, the contract account and the pinned contract code hash whole, and those texts reach `bin/watch.mjs
// --rails` (the sweep's `railsConfigError`, its notes and stderr) and `examples/audit-export.mjs --rails` (the config check and the evidence reasons the replayed board
// prints), files that have no key field: a key or a seed phrase pasted into the wrong field of a hand-written rails file came back in the message. They now quote a pin
// text only when it is a short plain text (`PIN_TEXT_SHAPE`), as the EVM and Bitcoin rails do, and otherwise say the fixed `UNPLAIN_PIN_TEXT`; the pinned code hash (it
// has the shape of a key and the config check takes any non-empty string for it) appears only as its first eight characters. Every key and phrase here is generated
// now and only ever scanned for (the scanners answer booleans, and an assertion on a text that could hold a key is made on a boolean, so a failing run never prints a
// byte of one).

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LockTerms } from "@flop-labs/tclk";
import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNearCounterRail } from "../src/client/near-rail.js";
import { captureNearLeg, nearEvidence } from "../src/rails/near-evidence.js";
import { checkNearRailConfig, NEAR_SANDBOX_PIN, NEAR_TESTNET_PIN, NearHtlcRail, validateNearRailConfig, type NearRailConfig } from "../src/rails/near-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { PIN_TEXT_SHAPE, shortPinnedValue, UNPLAIN_PIN_TEXT, UNPLAIN_PINNED_VALUE } from "../src/rails/pin-text.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { runSweep } from "../src/watcher.js";
import { phraseScanner, strippedKeyScanner } from "./helpers/evm-local.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadRails } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const EM = String.fromCharCode(0x2014); // the dash of the connect refusals, spelled without a non-ASCII byte in this file
const CONTRACT = "htlc.near-sandbox-flop";
const USDC = "usdc.near-sandbox-flop";
const HTLC_CODE_HASH = "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT"; // a real-shaped code hash (base58 of 32 bytes)
const OTHER_CODE_HASH = "6DWYhR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT";
const BUYER_ACCOUNT = "buyer.near-sandbox-flop";
const SELLER_ACCOUNT = "seller.near-sandbox-flop";

/** A hand-written rails.near block as `watch.mjs --rails` or `audit-export --rails` would load it, with some fields replaced. */
function nearBlock(
  overrides: { pin?: Record<string, unknown>; contract?: unknown; usdc?: unknown; htlcCodeHash?: unknown } = {},
): Record<string, unknown> {
  return {
    pin: overrides.pin ?? { ...NEAR_SANDBOX_PIN },
    endpoint: "http://127.0.0.1:9999",
    contract: overrides.contract ?? CONTRACT,
    assets: { USDC: overrides.usdc ?? USDC },
    htlcCodeHash: overrides.htlcCodeHash ?? HTLC_CODE_HASH,
  };
}

/** The pin of a rails.near block with one text replaced; a chain id keeps `caip2` consistent (`near:<chainId>`), as a careful hand-writer's file would. */
function pinWith(field: "name" | "chainId", value: string): Record<string, unknown> {
  return field === "name" ? { ...NEAR_SANDBOX_PIN, name: value } : { ...NEAR_SANDBOX_PIN, chainId: value, caip2: `near:${value}` };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "near-pin-text-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function reasonOf(value: unknown): string {
  const checked = checkNearRailConfig(value);
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

/** The spellings a key takes when someone pastes it into a field. */
function spellingsOf(key: `0x${string}`): Array<[string, string]> {
  return [
    ["the key", key],
    ["the key without 0x", key.slice(2)],
    ["upper case", key.toUpperCase().replace("0X", "0x")],
    ["the key with a prefix and a space", `near ${key}`],
    ["the key cut by spaces", key.slice(2).match(/.{1,8}/g)!.join(" ")],
  ];
}

function phraseSpellings(words: readonly string[]): Array<[string, string]> {
  return [
    ["the phrase", words.join(" ")],
    ["numbered", words.map((word, index) => `${index + 1}. ${word}`).join(" ")],
    ["with commas", words.join(", ")],
  ];
}

describe("P10 B4 (NEAR): the shared helper, and what the NEAR rail's own pins look like to it", () => {
  it("both NEAR pins of this build have a name, a chain id and a caip2 of the plain shape, so none is ever hidden", () => {
    for (const pin of [NEAR_SANDBOX_PIN, NEAR_TESTNET_PIN]) {
      expect(PIN_TEXT_SHAPE.test(pin.name), pin.chainId).toBe(true);
      expect(PIN_TEXT_SHAPE.test(pin.chainId), pin.chainId).toBe(true);
      expect(PIN_TEXT_SHAPE.test(pin.caip2), pin.chainId).toBe(true);
    }
  });

  it("shortPinnedValue shows eight characters of a hash-shaped value and nothing of any other text", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    expect(shortPinnedValue(HTLC_CODE_HASH)).toBe('"5CVXgVR5..."');
    expect(shortPinnedValue(key.slice(2))).toBe(`"${key.slice(2, 10)}..."`);
    expect(scan(shortPinnedValue(key.slice(2))), "eight characters are no window of the key").toBe(false);
    expect(scan(shortPinnedValue(key)), "with 0x, still no window").toBe(false);
    const words = generateMnemonic(english).split(" ");
    for (const text of [words.join(" "), "two words", "", "short", "a".repeat(129), `${HTLC_CODE_HASH}!`, 7, null, undefined, { hash: HTLC_CODE_HASH }]) {
      expect(shortPinnedValue(text), typeof text).toBe(UNPLAIN_PINNED_VALUE);
    }
    expect(phraseScanner(words)(shortPinnedValue(words.join(" ")))).toBe(false);
  });
});

describe("P10 B4 (NEAR): the config check never quotes a pin text that is not a short plain text", () => {
  it("a key as pin.name or pin.chainId is not quoted by checkNearRailConfig, in any spelling", () => {
    for (const field of ["name", "chainId"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      for (const [label, value] of spellingsOf(key)) {
        expect(scan(value), `${field} ${label}: the value must hold the key, or this test proves nothing`).toBe(true);
        const checked = checkNearRailConfig(nearBlock({ pin: pinWith(field, value) }));
        expect(checked.ok, `${field} ${label}`).toBe(false);
        const reason = checked.ok ? "" : checked.reason;
        expect(scan(reason), `${field} ${label}: no window of the key may be quoted`).toBe(false);
        expect(reason.includes(UNPLAIN_PIN_TEXT), `${field} ${label}: the refusal says the value is not a short plain text`).toBe(true); // a boolean
      }
    }
  });

  it("a seed phrase as pin.name or pin.chainId is not quoted either", () => {
    for (const field of ["name", "chainId"] as const) {
      const words = generateMnemonic(english).split(" ");
      const scan = phraseScanner(words);
      for (const [label, value] of phraseSpellings(words)) {
        expect(scan(value), `${field} ${label}: the value must hold the phrase`).toBe(true);
        const reason = reasonOf(nearBlock({ pin: pinWith(field, value) }));
        expect(reason.length > 0, `${field} ${label}: refused`).toBe(true);
        expect(scan(reason), `${field} ${label}: no four words of the phrase may be quoted`).toBe(false);
        expect(reason.includes(UNPLAIN_PIN_TEXT), `${field} ${label}`).toBe(true);
      }
    }
  });

  it("a key as pin.caip2 (the shape check names no value at all), and validateNearRailConfig called on its own, quote nothing", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const asCaip2 = reasonOf(nearBlock({ pin: { ...NEAR_SANDBOX_PIN, caip2: key } }));
    expect(asCaip2.length > 0 && !scan(asCaip2), "no window of the key as a caip2").toBe(true);
    const asChainId = throwsWith(() => validateNearRailConfig(nearBlock({ pin: pinWith("chainId", key) }) as unknown as NearRailConfig));
    expect(asChainId.includes("is not on the allow list"), "validateNearRailConfig refuses a key as a chain id").toBe(true);
    expect(scan(asChainId), "validateNearRailConfig, chain id").toBe(false);
    const asName = throwsWith(() => validateNearRailConfig(nearBlock({ pin: pinWith("name", key) }) as unknown as NearRailConfig));
    expect(asName.includes("does not match the known pin's own name"), "validateNearRailConfig refuses a key as a name").toBe(true);
    expect(scan(asName), "validateNearRailConfig, name").toBe(false);
  });

  it("a plain but wrong name or chain id is still quoted, so the person can see what to fix; mainnet is still refused by name", () => {
    expect(reasonOf(nearBlock({ pin: pinWith("name", "renamed-sandbox") }))).toBe(
      `near-htlc: pin.name "renamed-sandbox" does not match the known pin's own name "near-sandbox" for this chain id`,
    );
    expect(reasonOf(nearBlock({ pin: pinWith("chainId", "devnet") }))).toBe(
      'near-htlc: chain id "devnet" is not on the allow list (near-sandbox-flop, testnet only)',
    );
    expect(reasonOf(nearBlock({ pin: pinWith("chainId", "mainnet") }))).toBe(
      'near-htlc: chain id "mainnet" is not on the allow list (near-sandbox-flop, testnet only); refusing mainnet by name',
    );
    // a valid config is accepted as it always was
    expect(checkNearRailConfig(nearBlock()).ok).toBe(true);
    expect(checkNearRailConfig(nearBlock({ pin: { ...NEAR_TESTNET_PIN } })).ok).toBe(true);
  });

  it("the edge is the EVM rail's own: 40 plain characters are quoted, 41 are not, and a space, a slash or a non-ASCII letter is never plain", () => {
    const forty = `a${"b".repeat(39)}`;
    expect(reasonOf(nearBlock({ pin: pinWith("name", forty) }))).toContain(`pin.name "${forty}" does not match`);
    expect(reasonOf(nearBlock({ pin: pinWith("name", `${forty}c`) }))).toContain(`pin.name ${UNPLAIN_PIN_TEXT} does not match`);
    expect(reasonOf(nearBlock({ pin: pinWith("chainId", forty) }))).toContain(`chain id "${forty}" is not on the allow list`);
    expect(reasonOf(nearBlock({ pin: pinWith("chainId", `${forty}c`) }))).toContain(`chain id ${UNPLAIN_PIN_TEXT} is not on the allow list`);
    for (const name of ["two words", "a/b", "caf" + String.fromCharCode(0xe9), "tab\there", 'quote"d']) {
      const reason = reasonOf(nearBlock({ pin: pinWith("name", name) }));
      expect(reason, JSON.stringify(name.length)).toContain(`pin.name ${UNPLAIN_PIN_TEXT} does not match`);
      expect(reason.includes(name), JSON.stringify(name.length)).toBe(false);
    }
  });
});

describe("P10 B4 (NEAR): what bin/watch.mjs --rails and examples/audit-export.mjs --rails print holds no window of it", () => {
  it("the sweep's railsConfigError and notes (what watch.mjs prints) hold no window of it", async () => {
    for (const field of ["name", "chainId"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      const report = await runSweep({
        root,
        baseUrl: "https://technocore.example",
        nowMs: () => 1_735_000_000_000,
        rails: { near: nearBlock({ pin: pinWith(field, key) }) as never },
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
      expect(notes.includes("rails.near config is invalid, sweep aborted"), field).toBe(true);
    }
  });

  it("bin/watch.mjs --rails (stdout and stderr) and examples/audit-export.mjs --rails (loadRails and the CLI) print no window of a key or a phrase", async () => {
    const words = generateMnemonic(english).split(" ");
    const cases: Array<[string, string, (text: string) => boolean, Record<string, unknown>]> = [];
    for (const field of ["name", "chainId"] as const) {
      const key = generatePrivateKey();
      cases.push([`key as ${field}`, field, strippedKeyScanner(key), nearBlock({ pin: pinWith(field, key) })]);
      cases.push([`phrase as ${field}`, field, phraseScanner(words), nearBlock({ pin: pinWith(field, words.join(" ")) })]);
    }
    let n = 0;
    for (const [label, field, scan, block] of cases) {
      n += 1;
      const railsFile = join(root, `rails-${n}.json`);
      await writeFile(railsFile, JSON.stringify({ near: block }));

      // watch.mjs validates the rails file before any network call, so this run is hermetic
      const watched = spawnSync(process.execPath, [join(repoRoot, "bin", "watch.mjs"), "--root", join(root, `watch-${n}`), "--rails", railsFile, "--base-url", "http://127.0.0.1:1", "--once"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(watched.status, `${label}: watch.mjs refuses the config`).toBe(3);
      expect(watched.stderr.includes(UNPLAIN_PIN_TEXT), `${label}: watch.mjs says the value is not a short plain text`).toBe(true);
      expect(scan(watched.stdout), `${label}: watch.mjs stdout`).toBe(false);
      expect(scan(watched.stderr), `${label}: watch.mjs stderr`).toBe(false);

      // audit-export: the loader, with an explicit --rails file and with DIR/rails.json
      const viaFile = throwsWith(() => loadRails(root, railsFile));
      expect(viaFile.includes("near rail config is invalid"), `${label} (${field}): loadRails refuses it`).toBe(true);
      expect(scan(viaFile), `${label}: loadRails (--rails FILE) message`).toBe(false);
      await writeFile(join(root, "rails.json"), JSON.stringify({ near: block }));
      expect(scan(throwsWith(() => loadRails(root, undefined))), `${label}: loadRails (DIR/rails.json) message`).toBe(false);

      // and the compiled CLI, over a watch root that has a raw/ directory (without one it stops before it reads the rails file)
      await rm(join(root, "rails.json"), { force: true });
      await mkdir(join(root, "raw"), { recursive: true });
      const exported = spawnSync(process.execPath, [join(repoRoot, "examples", "audit-export.mjs"), "--root", root, "--rails", railsFile], { cwd: repoRoot, encoding: "utf8" });
      expect(exported.stderr.includes("near rail config is invalid"), `${label}: audit-export refuses the config`).toBe(true);
      expect(scan(exported.stdout), `${label}: audit-export stdout`).toBe(false);
      expect(scan(exported.stderr), `${label}: audit-export stderr`).toBe(false);
    }
  });
});

// -- the connect-time refusals (a mocked node: the same canned-body pattern as tests/near-htlc.test.ts) --------------------------------------------------------------

const BLOCK_HASH_BASE58 = "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM"; // a real 32-byte base58 value

function ok(result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}

/** The four calls every `connect()` makes: `status`, `block(final)`, `view_account` and `view_access_key_list`, the last two pinned to that one block. */
function connectBodies(options: { codeHash?: string; keys?: string[] } = {}): string[] {
  return [
    ok({ chain_id: "near-sandbox-flop", protocol_version: 86, sync_info: {} }),
    ok({ header: { height: 1, hash: BLOCK_HASH_BASE58, timestamp_nanosec: "1690000000000000000" } }),
    ok({ amount: "1000000000000000000000000", code_hash: options.codeHash ?? HTLC_CODE_HASH, block_height: 1, block_hash: "bh" }),
    ok({ keys: (options.keys ?? []).map((pk) => ({ public_key: pk, access_key: { nonce: 0, permission: "FullAccess" } })), block_height: 1, block_hash: "bh" }),
  ];
}

function connectWith(config: unknown, bodies: string[]): Promise<NearHtlcRail> {
  let i = 0;
  const fetchImpl = (async () => {
    const body = bodies[i];
    i += 1;
    if (body === undefined) throw new Error("fakeFetch: ran out of canned responses");
    const bytes = new TextEncoder().encode(body);
    return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: fetchImpl, clock: () => 5000 });
  const signer = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(1));
  return NearHtlcRail.connect({ config: config as NearRailConfig, rpc, signer, clock: () => 5000 });
}

describe("P10 B4 (NEAR): the connect-time refusals name no pin text that is not a short plain text", () => {
  it("connect refuses a key or a phrase as a pin name or chain id, through the config check, without quoting it", async () => {
    for (const field of ["name", "chainId"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      const message = await rejectsWith(() => connectWith(nearBlock({ pin: pinWith(field, key) }), []));
      expect(message.includes("refusing to connect"), `connect refuses a key as ${field}`).toBe(true);
      expect(scan(message), `connect, ${field}`).toBe(false);
      const words = generateMnemonic(english).split(" ");
      const phraseMessage = await rejectsWith(() => connectWith(nearBlock({ pin: pinWith(field, words.join(" ")) }), []));
      expect(phraseMessage.includes("refusing to connect"), `connect refuses a phrase as ${field}`).toBe(true);
      expect(phraseScanner(words)(phraseMessage), `connect, ${field}, phrase`).toBe(false);
    }
  });

  it("a key as the contract account (a run of 64 hex digits is a valid NEAR account id) is not quoted by the code-hash or the access-key refusal", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const asContract = key.slice(2); // lower case hex: passes the account-id grammar, so the config check accepts it
    expect(scan(asContract)).toBe(true);
    expect(checkNearRailConfig(nearBlock({ contract: asContract })).ok, "the config check accepts it").toBe(true);

    const wrongHash = await rejectsWith(() => connectWith(nearBlock({ contract: asContract }), connectBodies({ codeHash: OTHER_CODE_HASH })));
    expect(wrongHash.includes("does not match the pinned htlcCodeHash"), "the code-hash refusal").toBe(true);
    expect(scan(wrongHash), "no window of the key as the contract (code hash)").toBe(false);
    expect(wrongHash.includes(UNPLAIN_PIN_TEXT)).toBe(true);
    expect(wrongHash.includes(`code_hash "${OTHER_CODE_HASH}"`), "the live code hash (public) is still named whole").toBe(true);

    const withKeys = await rejectsWith(() => connectWith(nearBlock({ contract: asContract }), connectBodies({ keys: ["ed25519:11111111111111111111111111111111"] })));
    expect(withKeys.includes("access key(s)"), "the access-key refusal").toBe(true);
    expect(scan(withKeys), "no window of the key as the contract (access keys)").toBe(false);
  });

  it("a key or a phrase as the pinned htlcCodeHash is shown as eight characters at most, or not at all", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    for (const [label, value] of [["the key", key], ["the key without 0x", key.slice(2)], ["upper case", key.slice(2).toUpperCase()]] as Array<[string, string]>) {
      expect(scan(value), `${label}: the value must hold the key`).toBe(true);
      const message = await rejectsWith(() => connectWith(nearBlock({ htlcCodeHash: value }), connectBodies({ codeHash: OTHER_CODE_HASH })));
      expect(message.includes("does not match the pinned htlcCodeHash"), `${label}: refused on the hash`).toBe(true);
      expect(scan(message), `${label}: no window of the key as the pinned hash`).toBe(false);
    }
    const words = generateMnemonic(english).split(" ");
    const phraseMessage = await rejectsWith(() => connectWith(nearBlock({ htlcCodeHash: words.join(" ") }), connectBodies({ codeHash: OTHER_CODE_HASH })));
    expect(phraseMessage.includes("does not match the pinned htlcCodeHash"), "refused on the hash").toBe(true);
    expect(phraseScanner(words)(phraseMessage), "no four words of the phrase as the pinned hash").toBe(false);
    expect(phraseMessage.includes(UNPLAIN_PINNED_VALUE)).toBe(true);
  });

  it("a canonical config's refusals read as they did, except that the pinned hash is its first eight characters", async () => {
    const mismatch = await rejectsWith(() => connectWith(nearBlock(), connectBodies({ codeHash: OTHER_CODE_HASH })));
    expect(mismatch).toBe(
      `near-htlc: refusing to connect ${EM} contract "${CONTRACT}" code_hash "${OTHER_CODE_HASH}" does not match the pinned htlcCodeHash "5CVXgVR5..."`,
    );
    const keyed = await rejectsWith(() => connectWith(nearBlock(), connectBodies({ keys: ["ed25519:11111111111111111111111111111111"] })));
    expect(keyed).toBe(`near-htlc: refusing to connect ${EM} contract "${CONTRACT}" still holds 1 access key(s) (must be locked to zero keys, H6)`);
  });
});

// -- the evidence reader (what audit-export and the replayed board print) -------------------------------------------------------------------------------------------

const HASH_LOCK = `0x${"ab".repeat(32)}`;
const REF = `${HASH_LOCK}:${BUYER_ACCOUNT}`;
const TERMS: LockTerms = {
  contract: "0x" + "11".repeat(32),
  lock: "hash",
  statement: HASH_LOCK,
  amount: "1000000",
  asset: "USDC",
  payer: "did:key:zPayer",
  payee: "did:key:zPayee",
  claimByMs: 1_700_000_000_000,
  refundAfterMs: 1_700_003_600_000,
};
const BLOCK_HEIGHT = 42;
const NOW_MS = 1_700_000_900_000;

function resultBytesOf(payload: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Echoes back whatever id the real outgoing request minted, paired with the next canned RESULT in call order (as tests/near-evidence.test.ts does). */
function echoingFetch(resultsInOrder: unknown[]): typeof fetch {
  let i = 0;
  return (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { id: string | number };
    const result = resultsInOrder[i];
    i += 1;
    if (result === undefined) throw new Error(`echoingFetch: ran out of canned responses (call #${i})`);
    const body = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result });
    const bytes = new TextEncoder().encode(body);
    return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
}

/** The reason `nearEvidence` gives for a live capture of a Locked lock whose contract reads `codeHash` and holds `keys`, under `config`. */
async function evidenceReason(config: NearRailConfig, view: { codeHash: string; keys: unknown[] }): Promise<string> {
  const results = [
    { chain_id: config.pin.chainId, protocol_version: 86, sync_info: {} },
    { header: { height: BLOCK_HEIGHT, hash: BLOCK_HASH_BASE58, timestamp_nanosec: "1700000500000000000" } },
    {
      result: resultBytesOf({ status: "Locked", payer: BUYER_ACCOUNT, payee: SELLER_ACCOUNT, token: config.assets.USDC, amount: "1000000", claim_by_ms: String(TERMS.claimByMs), refund_after_ms: String(TERMS.refundAfterMs) }),
      logs: [],
      block_height: BLOCK_HEIGHT,
      block_hash: BLOCK_HASH_BASE58,
    },
    { amount: "1000000000000000000000000", locked: "0", code_hash: view.codeHash, storage_usage: 200000, storage_paid_at: 0, block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH_BASE58 },
    { keys: view.keys, block_height: BLOCK_HEIGHT, block_hash: BLOCK_HASH_BASE58 },
  ];
  const rpc = new CapturingRpc({ endpoint: config.endpoint, fetch: echoingFetch(results), clock: () => NOW_MS });
  const { index, exchanges } = await captureNearLeg(rpc, config, TERMS, {}, REF, NOW_MS);
  const bytes = new Map<string, Uint8Array>();
  for (const exchange of exchanges) bytes.set(exchange.responseSha256, exchange.responseBytes);
  const result = nearEvidence({ terms: TERMS, config, accounts: { payee: SELLER_ACCOUNT, payer: BUYER_ACCOUNT }, capture: { index, bytes }, keyControl: "flow" });
  return result.lock.reason ?? "";
}

const FULL_KEY = { public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp", access_key: { nonce: 0, permission: "FullAccess" } };

describe("P10 B4 (NEAR): the evidence reasons (audit-export, the replayed board) name no pin text that is not a short plain text", () => {
  it("a canonical config's reasons read as they did, except that the pinned hash is its first eight characters", async () => {
    const config = nearBlock() as unknown as NearRailConfig;
    expect(await evidenceReason(config, { codeHash: OTHER_CODE_HASH, keys: [] })).toBe(
      `near-htlc: contract "${CONTRACT}" code_hash "${OTHER_CODE_HASH}" is not the pinned htlcCodeHash "5CVXgVR5..." (H8)`,
    );
    expect(await evidenceReason(config, { codeHash: HTLC_CODE_HASH, keys: [FULL_KEY] })).toBe(
      `near-htlc: contract "${CONTRACT}" still holds 1 access key(s) -- not the locked deployment (H8)`,
    );
  });

  it("a key as the contract account or as the pinned htlcCodeHash, and a phrase as the pinned htlcCodeHash, leave no window in the reason", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const contractReason = await evidenceReason(nearBlock({ contract: key.slice(2) }) as unknown as NearRailConfig, { codeHash: OTHER_CODE_HASH, keys: [] });
    expect(contractReason.includes("is not the pinned htlcCodeHash"), "the contract is refused on its code hash").toBe(true);
    expect(scan(contractReason), "no window of the key as the contract (code hash)").toBe(false);
    const keysReason = await evidenceReason(nearBlock({ contract: key.slice(2) }) as unknown as NearRailConfig, { codeHash: HTLC_CODE_HASH, keys: [FULL_KEY] });
    expect(keysReason.includes("still holds 1 access key(s)"), "the contract is refused on its access keys").toBe(true);
    expect(scan(keysReason), "no window of the key as the contract (access keys)").toBe(false);

    const key2 = generatePrivateKey();
    const scan2 = strippedKeyScanner(key2);
    for (const value of [key2, key2.slice(2)]) {
      const reason = await evidenceReason(nearBlock({ htlcCodeHash: value }) as unknown as NearRailConfig, { codeHash: OTHER_CODE_HASH, keys: [] });
      expect(reason.includes("is not the pinned htlcCodeHash"), "refused on the pinned hash").toBe(true);
      expect(scan2(reason), "no window of the key as the pinned hash").toBe(false);
    }
    const words = generateMnemonic(english).split(" ");
    const phraseReason = await evidenceReason(nearBlock({ htlcCodeHash: words.join(" ") }) as unknown as NearRailConfig, { codeHash: OTHER_CODE_HASH, keys: [] });
    expect(phraseReason.includes("is not the pinned htlcCodeHash"), "refused on the pinned hash").toBe(true);
    expect(phraseScanner(words)(phraseReason), "no four words of the phrase as the pinned hash").toBe(false);
  });
});

// -- the client wrapper's deployment id --------------------------------------------------------------------------------------------------------------------------

describe("P10 B4 (NEAR): the client wrapper's deployment id never carries a key or a phrase", () => {
  const signer = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(11));
  const deadRpc = new CapturingRpc({
    endpoint: "http://127.0.0.1:9",
    fetch: (async () => {
      throw new Error("deploymentId must be derived from the config alone (no network call)");
    }) as typeof fetch,
  });
  const idOf = (block: Record<string, unknown>): string => createNearCounterRail({ config: block as unknown as NearRailConfig, rpc: deadRpc, signer, clock: () => NOW_MS }).deploymentId;

  it("a config that can connect keeps the id it always had, byte for byte", () => {
    expect(idOf(nearBlock())).toBe(`near-htlc:contract=${CONTRACT}:token=${USDC}:code=${HTLC_CODE_HASH}`);
    expect(idOf(nearBlock({ pin: { ...NEAR_TESTNET_PIN }, contract: "my_htlc.testnet", usdc: "usdc.fakes.testnet" }))).toBe(
      `near-htlc:contract=my_htlc.testnet:token=usdc.fakes.testnet:code=${HTLC_CODE_HASH}`,
    );
  });

  it("a key as the pinned hash, a phrase as the pinned hash, a key or a phrase as an account: none of it is in the id", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const words = generateMnemonic(english).split(" ");
    const phrase = phraseScanner(words);
    for (const value of [key, key.slice(2), key.toUpperCase()]) {
      expect(scan(idOf(nearBlock({ htlcCodeHash: value }))), "a key as the code hash").toBe(false);
      expect(scan(idOf(nearBlock({ contract: value }))), "a key as the contract").toBe(false);
      expect(scan(idOf(nearBlock({ usdc: value }))), "a key as the token account").toBe(false);
    }
    expect(phrase(idOf(nearBlock({ htlcCodeHash: words.join(" ") }))), "a phrase as the code hash").toBe(false);
    expect(phrase(idOf(nearBlock({ contract: words.join(" ") }))), "a phrase as the contract").toBe(false);
    expect(phrase(idOf(nearBlock({ usdc: words.join(" ") }))), "a phrase as the token account").toBe(false);
    expect(idOf(nearBlock({ htlcCodeHash: key })).endsWith(":code=unpinned")).toBe(true);
  });

  it("two deployments whose contract is a run of 64 hex digits still get two ids (a digest, never the digits)", () => {
    const a = generatePrivateKey().slice(2);
    const b = generatePrivateKey().slice(2);
    const first = idOf(nearBlock({ contract: a }));
    expect(first).toBe(idOf(nearBlock({ contract: a })));
    expect(first).not.toBe(idOf(nearBlock({ contract: b })));
    expect(first.includes(a)).toBe(false);
    expect(first.startsWith("near-htlc:contract=sha256-")).toBe(true);
    expect(first).toMatch(/^[\x20-\x7e]+$/);
    expect(first.length).toBeLessThanOrEqual(512);
  });
});
