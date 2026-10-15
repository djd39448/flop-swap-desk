// SPDX-License-Identifier: MIT
//
// tests/sol-pin-text.test.ts: P10 B4, the Solana part (the KR3-3 rule of P9 review round 3 and the K2 rule of round 1, shared through src/rails/pin-text.ts). The Solana
// rail's own refusals used to quote the pin name, the pin's caip2 and the pinned programHash whole, and those texts reach `bin/watch.mjs --rails` (the sweep's
// `railsConfigError`, its notes and stderr) and `examples/audit-export.mjs --rails` (the config check and the evidence reasons the replayed board prints), files that
// have no key field: a key or a seed phrase pasted into the wrong field of a hand-written rails file came back in the message. A programHash is 64 lowercase hex digits,
// exactly the shape of a key, so it passes the config check with one in it. They now quote a pin text only when it is a short plain text (`PIN_TEXT_SHAPE`), as the EVM
// and Bitcoin rails do, and otherwise say the fixed `UNPLAIN_PIN_TEXT`; the pinned programHash appears only as its first eight characters. Every key and phrase here is
// generated now and only ever scanned for (the scanners answer booleans, and an assertion on a text that could hold a key is made on a boolean, so a failing run never
// prints a byte of one).

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LockTerms } from "@flop-labs/tclk";
import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSolCounterRail } from "../src/client/sol-rail.js";
import { PIN_TEXT_SHAPE, UNPLAIN_PIN_TEXT } from "../src/rails/pin-text.js";
import { CapturingRpc, verifiedExchangeBytes } from "../src/rails/rpc-capture.js";
import { captureSolLeg, solEvidence, type SolCapture } from "../src/rails/sol-evidence.js";
import {
  SOL_DEVNET_PIN,
  SOL_HTLC_PROGRAM_ID,
  SOL_LOCAL_PIN,
  SolHtlcRail,
  checkSolRailConfig,
  solGenesisProblem,
  validateSolRailConfig,
  type SolRailConfig,
} from "../src/rails/sol-htlc.js";
import { InMemorySolSigner } from "../src/rails/sol-signer-memory.js";
import { pubkeyToBase58 } from "../src/rails/sol-tx.js";
import { runSweep } from "../src/watcher.js";
import { phraseScanner, strippedKeyScanner } from "./helpers/evm-local.js";
import { FAKE_PROGRAM_HASH, makeWorld, putLockedEscrow, type World } from "./helpers/sol-fake-chain.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadRails } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const MINT = pubkeyToBase58(new Uint8Array(32).fill(0x91));
const OTHER_HASH = "d".repeat(64); // a well-formed programHash that is not any chain's

/** A hand-written rails.sol block as `watch.mjs --rails` or `audit-export --rails` would load it, with some fields replaced. */
function solBlock(overrides: { pin?: Record<string, unknown>; programId?: unknown; programHash?: unknown; usdc?: unknown } = {}): Record<string, unknown> {
  return {
    pin: overrides.pin ?? { ...SOL_LOCAL_PIN },
    endpoint: "http://127.0.0.1:8899",
    programId: overrides.programId ?? SOL_HTLC_PROGRAM_ID,
    programHash: overrides.programHash ?? FAKE_PROGRAM_HASH,
    assets: { USDC: overrides.usdc ?? MINT },
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sol-pin-text-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function reasonOf(value: unknown): string {
  const checked = checkSolRailConfig(value);
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
    ["the key with a prefix and a space", `sol ${key}`],
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

describe("P10 B4 (Solana): what the Solana rail's own pins look like to the shared helper", () => {
  it("both Solana pins of this build have a name and a caip2 of the plain shape, so neither is ever hidden", () => {
    for (const pin of [SOL_LOCAL_PIN, SOL_DEVNET_PIN]) {
      expect(PIN_TEXT_SHAPE.test(pin.name), pin.caip2).toBe(true);
      expect(PIN_TEXT_SHAPE.test(pin.caip2), pin.caip2).toBe(true);
      expect(PIN_TEXT_SHAPE.test(pin.caip2.slice("solana:".length)), `${pin.caip2}: the reference alone`).toBe(true);
    }
  });
});

describe("P10 B4 (Solana): the config check never quotes a pin text that is not a short plain text", () => {
  it("a key as pin.name is not quoted by checkSolRailConfig, in any spelling", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    for (const [label, value] of spellingsOf(key)) {
      expect(scan(value), `${label}: the value must hold the key, or this test proves nothing`).toBe(true);
      const checked = checkSolRailConfig(solBlock({ pin: { ...SOL_LOCAL_PIN, name: value } }));
      expect(checked.ok, label).toBe(false);
      const reason = checked.ok ? "" : checked.reason;
      expect(scan(reason), `${label}: no window of the key may be quoted`).toBe(false);
      expect(reason.includes(UNPLAIN_PIN_TEXT), `${label}: the refusal says the value is not a short plain text`).toBe(true); // a boolean
    }
  });

  it("a seed phrase as pin.name is not quoted either", () => {
    const words = generateMnemonic(english).split(" ");
    const scan = phraseScanner(words);
    for (const [label, value] of phraseSpellings(words)) {
      expect(scan(value), `${label}: the value must hold the phrase`).toBe(true);
      const reason = reasonOf(solBlock({ pin: { ...SOL_DEVNET_PIN, name: value } }));
      expect(reason.length > 0, `${label}: refused`).toBe(true);
      expect(scan(reason), `${label}: no four words of the phrase may be quoted`).toBe(false);
      expect(reason.includes(UNPLAIN_PIN_TEXT), label).toBe(true);
    }
  });

  it("a key or a phrase as pin.caip2 is refused by the shape check, which names no value; validateSolRailConfig called on its own does not quote it either", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const words = generateMnemonic(english).split(" ");
    for (const value of [key, key.slice(2), `solana:${key.slice(2)}`, words.join(" "), `solana:${words.join(" ")}`]) {
      const reason = reasonOf(solBlock({ pin: { ...SOL_LOCAL_PIN, caip2: value } }));
      expect(reason.length > 0, "refused").toBe(true);
      expect(scan(reason) || phraseScanner(words)(reason), "the shape check names no value").toBe(false);
    }
    // the same call, directly (a caller that skips the shape check)
    const direct = throwsWith(() => validateSolRailConfig(solBlock({ pin: { ...SOL_LOCAL_PIN, caip2: `solana:${key.slice(2)}` } }) as unknown as SolRailConfig));
    expect(direct.includes("is not on the allow list"), "validateSolRailConfig refuses a key as a caip2").toBe(true);
    expect(direct.includes(UNPLAIN_PIN_TEXT)).toBe(true);
    expect(scan(direct), "validateSolRailConfig, caip2").toBe(false);
    const directName = throwsWith(() => validateSolRailConfig(solBlock({ pin: { ...SOL_LOCAL_PIN, name: key } }) as unknown as SolRailConfig));
    expect(directName.includes("does not match the known pin's own name"), "validateSolRailConfig refuses a key as a name").toBe(true);
    expect(scan(directName), "validateSolRailConfig, name").toBe(false);
  });

  it("a plain but wrong name or caip2 is still quoted, so the person can see what to fix; mainnet is still refused by name", () => {
    expect(reasonOf(solBlock({ pin: { ...SOL_LOCAL_PIN, name: "renamed" } }))).toBe(
      `sol-htlc: pin.name "renamed" does not match the known pin's own name "solana-localnet-flop" for this chain`,
    );
    expect(reasonOf(solBlock({ pin: { ...SOL_LOCAL_PIN, caip2: "solana:testnet" } }))).toBe(
      'sol-htlc: chain "solana:testnet" is not on the allow list (solana:localnet-flop, solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 only)',
    );
    expect(reasonOf(solBlock({ pin: { name: "solana-mainnet-beta", caip2: "solana:mainnet", commitment: "finalized" } }))).toBe(
      "sol-htlc: refusing mainnet by name (this build never touches mainnet)",
    );
    // a valid config is accepted as it always was
    expect(checkSolRailConfig(solBlock()).ok).toBe(true);
    expect(checkSolRailConfig(solBlock({ pin: { ...SOL_DEVNET_PIN } })).ok).toBe(true);
  });

  it("the edge is the EVM rail's own: 40 plain characters are quoted, 41 are not, and a space, a slash or a non-ASCII letter is never plain", () => {
    const forty = `a${"b".repeat(39)}`;
    expect(reasonOf(solBlock({ pin: { ...SOL_LOCAL_PIN, name: forty } }))).toContain(`pin.name "${forty}" does not match`);
    expect(reasonOf(solBlock({ pin: { ...SOL_LOCAL_PIN, name: `${forty}c` } }))).toContain(`pin.name ${UNPLAIN_PIN_TEXT} does not match`);
    for (const name of ["two words", "a/b", "caf" + String.fromCharCode(0xe9), "tab\there", 'quote"d']) {
      const reason = reasonOf(solBlock({ pin: { ...SOL_LOCAL_PIN, name } }));
      expect(reason, JSON.stringify(name.length)).toContain(`pin.name ${UNPLAIN_PIN_TEXT} does not match`);
      expect(reason.includes(name), JSON.stringify(name.length)).toBe(false);
    }
  });
});

describe("P10 B4 (Solana): solGenesisProblem (shared by connect and the evidence reader) names no pin text that is not a short plain text", () => {
  it("a key or a phrase as the pin's name or reference is not quoted, on either branch", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const words = generateMnemonic(english).split(" ");
    const phrase = phraseScanner(words);
    const publicGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoVCnqeeF";
    const otherGenesis = "ZZZZRABZaYq6iMfeYKouRu166VU2xqa1wcaWoVCnqeeF";
    // the local-validator branch: a public cluster's genesis under a pin named by a key / a phrase
    const local = solGenesisProblem({ name: key, caip2: SOL_LOCAL_PIN.caip2, commitment: "finalized" }, publicGenesis) ?? "";
    expect(local.includes("is a local validator"), "the local branch refuses a public genesis").toBe(true);
    expect(scan(local), "local branch, name").toBe(false);
    expect((solGenesisProblem({ name: words.join(" "), caip2: SOL_LOCAL_PIN.caip2, commitment: "finalized" }, publicGenesis) ?? "").length > 0).toBe(true);
    expect(phrase(solGenesisProblem({ name: words.join(" "), caip2: SOL_LOCAL_PIN.caip2, commitment: "finalized" }, publicGenesis) ?? ""), "local branch, phrase").toBe(false);
    // the reference branch: a genesis that does not start with the pin's reference
    const byName = solGenesisProblem({ name: key, caip2: SOL_DEVNET_PIN.caip2, commitment: "finalized" }, otherGenesis) ?? "";
    expect(byName.includes("does not match pin"), "the reference branch refuses a foreign genesis").toBe(true);
    expect(scan(byName), "reference branch, name").toBe(false);
    const byReference = solGenesisProblem({ name: SOL_DEVNET_PIN.name, caip2: `solana:${key.slice(2)}`, commitment: "finalized" }, otherGenesis) ?? "";
    expect(byReference.includes("does not match pin"), "the reference branch refuses a foreign genesis").toBe(true);
    expect(scan(byReference), "reference branch, reference").toBe(false);
    expect(byReference.includes(UNPLAIN_PIN_TEXT)).toBe(true);
  });

  it("a plain pin is named exactly as before; the endpoint's genesis hash is still named (public)", () => {
    const foreign = "ZZZZRABZaYq6iMfeYKouRu166VU2xqa1wcaWoVCnqeeF";
    expect(solGenesisProblem(SOL_DEVNET_PIN, foreign)).toBe(
      `sol-htlc: connected genesis "${foreign}" does not match pin "solana-devnet-UNVERIFIED" (expected reference "EtWTRABZaYq6iMfeYKouRu166VU2xqa1")`,
    );
    expect(solGenesisProblem(SOL_LOCAL_PIN, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoVCnqeeF")).toBe(
      "sol-htlc: pin \"solana-localnet-flop\" is a local validator but the endpoint reports a public cluster's genesis hash",
    );
    expect(solGenesisProblem(SOL_DEVNET_PIN, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoVCnqeeF")).toBeNull();
  });
});

describe("P10 B4 (Solana): what bin/watch.mjs --rails and examples/audit-export.mjs --rails print holds no window of it", () => {
  it("the sweep's railsConfigError and notes (what watch.mjs prints) hold no window of it", async () => {
    for (const field of ["name", "caip2"] as const) {
      const key = generatePrivateKey();
      const scan = strippedKeyScanner(key);
      const report = await runSweep({
        root,
        baseUrl: "https://technocore.example",
        nowMs: () => 1_735_000_000_000,
        rails: { sol: solBlock({ pin: { ...SOL_LOCAL_PIN, [field]: key } }) as never },
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
      expect(notes.includes("rails.sol config is invalid, sweep aborted"), field).toBe(true);
      if (field === "name") expect(railsConfigError.includes(UNPLAIN_PIN_TEXT), "the sweep aborted on this very config").toBe(true);
    }
  });

  it("bin/watch.mjs --rails (stdout and stderr) and examples/audit-export.mjs --rails (loadRails and the CLI) print no window of a key or a phrase", async () => {
    const words = generateMnemonic(english).split(" ");
    const cases: Array<[string, string, (text: string) => boolean, Record<string, unknown>]> = [];
    {
      const key = generatePrivateKey();
      cases.push(["key as name", "name", strippedKeyScanner(key), solBlock({ pin: { ...SOL_LOCAL_PIN, name: key } })]);
      cases.push(["key as caip2", "caip2", strippedKeyScanner(key), solBlock({ pin: { ...SOL_LOCAL_PIN, caip2: key } })]);
      cases.push(["phrase as name", "name", phraseScanner(words), solBlock({ pin: { ...SOL_LOCAL_PIN, name: words.join(" ") } })]);
    }
    let n = 0;
    for (const [label, field, scan, block] of cases) {
      n += 1;
      const railsFile = join(root, `rails-${n}.json`);
      await writeFile(railsFile, JSON.stringify({ sol: block }));

      // watch.mjs validates the rails file before any network call, so this run is hermetic
      const watched = spawnSync(process.execPath, [join(repoRoot, "bin", "watch.mjs"), "--root", join(root, `watch-${n}`), "--rails", railsFile, "--base-url", "http://127.0.0.1:1", "--once"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(watched.status, `${label}: watch.mjs refuses the config`).toBe(3);
      expect(watched.stderr.includes("rails config invalid"), `${label}: watch.mjs says why`).toBe(true);
      if (field === "name") expect(watched.stderr.includes(UNPLAIN_PIN_TEXT), `${label}: watch.mjs says the value is not a short plain text`).toBe(true);
      expect(scan(watched.stdout), `${label}: watch.mjs stdout`).toBe(false);
      expect(scan(watched.stderr), `${label}: watch.mjs stderr`).toBe(false);

      // audit-export: the loader, with an explicit --rails file and with DIR/rails.json
      const viaFile = throwsWith(() => loadRails(root, railsFile));
      expect(viaFile.includes("sol rail config is invalid"), `${label}: loadRails refuses it`).toBe(true);
      expect(scan(viaFile), `${label}: loadRails (--rails FILE) message`).toBe(false);
      await writeFile(join(root, "rails.json"), JSON.stringify({ sol: block }));
      expect(scan(throwsWith(() => loadRails(root, undefined))), `${label}: loadRails (DIR/rails.json) message`).toBe(false);

      // and the compiled CLI, over a watch root that has a raw/ directory (without one it stops before it reads the rails file)
      await rm(join(root, "rails.json"), { force: true });
      await mkdir(join(root, "raw"), { recursive: true });
      const exported = spawnSync(process.execPath, [join(repoRoot, "examples", "audit-export.mjs"), "--root", root, "--rails", railsFile], { cwd: repoRoot, encoding: "utf8" });
      expect(exported.stderr.includes("sol rail config is invalid"), `${label}: audit-export refuses the config`).toBe(true);
      expect(scan(exported.stdout), `${label}: audit-export stdout`).toBe(false);
      expect(scan(exported.stderr), `${label}: audit-export stderr`).toBe(false);
    }
  });
});

// -- the connect-time refusals (the scripted fake node of tests/helpers/sol-fake-chain.ts) ------------------------------------------------------------------------------

function connectWith(w: World, config: unknown): Promise<SolHtlcRail> {
  return SolHtlcRail.connect({ config: config as SolRailConfig, rpc: w.rpc, signer: w.buyer, clock: w.clock, sleep: w.sleep, pollIntervalMs: 10, finalityTimeoutMs: 100 });
}

describe("P10 B4 (Solana): the connect-time refusals name no pin text that is not a short plain text", () => {
  it("connect refuses a key or a phrase as a pin name, through the config check, without quoting it", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const w = makeWorld();
    const message = await rejectsWith(() => connectWith(w, solBlock({ pin: { ...SOL_LOCAL_PIN, name: key } })));
    expect(message.includes("refusing to connect"), "connect refuses a key as the name").toBe(true);
    expect(scan(message), "connect, name").toBe(false);
    expect(w.chain.requests.length, "no request was made").toBe(0);
    const words = generateMnemonic(english).split(" ");
    const phraseMessage = await rejectsWith(() => connectWith(makeWorld(), solBlock({ pin: { ...SOL_LOCAL_PIN, name: words.join(" ") } })));
    expect(phraseMessage.includes("refusing to connect"), "connect refuses a phrase as the name").toBe(true);
    expect(phraseScanner(words)(phraseMessage), "connect, phrase").toBe(false);
  });

  it("a key as the pinned programHash (64 lowercase hex digits passes the config check) is shown as eight characters at most", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const asHash = key.slice(2); // lower case hex: the shape the config check requires of a programHash
    expect(scan(asHash)).toBe(true);
    expect(checkSolRailConfig(solBlock({ programHash: asHash })).ok, "the config check accepts it").toBe(true);
    const w = makeWorld();
    const message = await rejectsWith(() => connectWith(w, { ...w.config, programHash: asHash }));
    expect(message.includes("does not match the pinned programHash"), "refused on the hash").toBe(true);
    expect(scan(message), "no window of the key as the pinned hash").toBe(false);
    expect(message.includes(`"${asHash.slice(0, 8)}..."`), "its first eight characters, between quotes").toBe(true);
    // upper case, a 0x prefix: the shape check refuses them, naming no value
    for (const value of [asHash.toUpperCase(), key]) {
      const shape = await rejectsWith(() => connectWith(w, { ...w.config, programHash: value }));
      expect(shape.includes("refusing to connect"), "refused by the shape check").toBe(true);
      expect(scan(shape), "the shape check names no value").toBe(false);
    }
  });

  it("a canonical config's refusals read as they did, except that the pinned programHash is its first eight characters", async () => {
    const w = makeWorld();
    const mismatch = await rejectsWith(() => connectWith(w, { ...w.config, programHash: OTHER_HASH }));
    expect(mismatch).toBe(`sol-htlc: refusing to connect - the ProgramData hash does not match the pinned programHash "${OTHER_HASH.slice(0, 8)}..."`);
    const devnet = makeWorld();
    const wrongGenesis = await rejectsWith(() => connectWith(devnet, { ...devnet.config, pin: { ...SOL_DEVNET_PIN } }));
    expect(wrongGenesis).toContain(`does not match pin "solana-devnet-UNVERIFIED" (expected reference "EtWTRABZaYq6iMfeYKouRu166VU2xqa1")`);
  });
});

// -- the evidence reader (what audit-export and the replayed board print) ---------------------------------------------------------------------------------------------

const NOW = 1_800_000_000_500;

function termsFor(w: World): LockTerms {
  return {
    contract: `0x${"11".repeat(32)}`,
    lock: "hash",
    statement: w.hashLock,
    amount: w.terms.amount,
    asset: "USDC",
    payer: "did:key:zPayer",
    payee: "did:key:zPayee",
    claimByMs: w.terms.claimByMs,
    refundAfterMs: w.terms.refundAfterMs,
  };
}

async function captureOf(w: World, config: SolRailConfig): Promise<SolCapture> {
  const { index, exchanges } = await captureSolLeg(w.rpc, config, termsFor(w), { payee: w.seller.publicKey, payer: w.buyer.publicKey }, w.ref, NOW);
  return { index, bytes: verifiedExchangeBytes(exchanges) };
}

function reasonFor(w: World, capture: SolCapture, config: SolRailConfig): string {
  return solEvidence({ terms: termsFor(w), config, accounts: { payee: w.seller.publicKey, payer: w.buyer.publicKey }, capture }).lock.reason ?? "";
}

describe("P10 B4 (Solana): the evidence reasons (audit-export, the replayed board) name no pin text that is not a short plain text", () => {
  it("a key as the auditor's pin name, or as the pin name a capture carries, is not quoted in the reason", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const w = makeWorld();
    putLockedEscrow(w);
    const capture = await captureOf(w, w.config);

    const auditor = reasonFor(w, capture, { ...w.config, pin: { ...SOL_LOCAL_PIN, name: key } });
    expect(auditor.includes("the auditor's own config is invalid"), "the auditor's config is refused").toBe(true);
    expect(scan(auditor), "no window of the key (auditor's config)").toBe(false);
    expect(auditor.includes(UNPLAIN_PIN_TEXT)).toBe(true);

    const tampered: SolCapture = { index: structuredClone(capture.index), bytes: capture.bytes };
    (tampered.index.config as { pin: { name: string } }).pin.name = key;
    const captured = reasonFor(w, tampered, w.config);
    expect(captured.includes("capture's own config is invalid"), "the captured config is refused").toBe(true);
    expect(scan(captured), "no window of the key (captured config)").toBe(false);
    expect(captured.includes(UNPLAIN_PIN_TEXT)).toBe(true);
  });

  it("a key as the pinned programHash never reaches the reason (the reader names no pinned value at all)", async () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const w = makeWorld();
    putLockedEscrow(w);
    const config: SolRailConfig = { ...w.config, programHash: key.slice(2) };
    const reason = reasonFor(w, await captureOf(w, config), config);
    expect(reason.includes("does not match the pinned programHash"), "the program is refused on its hash").toBe(true);
    expect(scan(reason), "no window of the key").toBe(false);
  });
});

// -- the client wrapper's deployment id --------------------------------------------------------------------------------------------------------------------------

describe("P10 B4 (Solana): the client wrapper's deployment id never carries a key or a phrase", () => {
  const signer = InMemorySolSigner.generate(new Uint8Array(32).fill(11));
  const deadRpc = new CapturingRpc({
    endpoint: "http://127.0.0.1:9",
    fetch: (async () => {
      throw new Error("deploymentId must be derived from the config alone (no network call)");
    }) as typeof fetch,
  });
  const idOf = (block: Record<string, unknown>): string => createSolCounterRail({ config: block as unknown as SolRailConfig, rpc: deadRpc, signer, clock: () => NOW }).deploymentId;

  it("a config that can connect keeps the id it always had, byte for byte", () => {
    expect(idOf(solBlock())).toBe(`sol-htlc:program=${SOL_HTLC_PROGRAM_ID}:mint=${MINT}`);
    expect(idOf(solBlock({ usdc: pubkeyToBase58(new Uint8Array(32).fill(0x92)) }))).not.toBe(idOf(solBlock()));
  });

  it("a key or a phrase as the program id or the mint: none of it is in the id", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const words = generateMnemonic(english).split(" ");
    const phrase = phraseScanner(words);
    for (const value of [key, key.slice(2), key.toUpperCase(), `solana ${key}`]) {
      expect(scan(idOf(solBlock({ programId: value }))), "a key as the program id").toBe(false);
      expect(scan(idOf(solBlock({ usdc: value }))), "a key as the mint").toBe(false);
    }
    expect(phrase(idOf(solBlock({ programId: words.join(" ") }))), "a phrase as the program id").toBe(false);
    expect(phrase(idOf(solBlock({ usdc: words.join(" ") }))), "a phrase as the mint").toBe(false);
    expect(idOf(solBlock({ usdc: key.slice(2) })).endsWith(":mint=unpinned")).toBe(true);
    expect(idOf(solBlock({ programId: key.slice(2) })).startsWith("sol-htlc:program=unpinned:")).toBe(true);
  });
});
