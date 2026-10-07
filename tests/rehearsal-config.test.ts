// SPDX-License-Identifier: MIT
//
// tests/rehearsal-config.test.ts: P9-6, the config file of the EVM rehearsal runner (src/client/rehearsal-config.ts). The config is
// closed (an unknown field is refused by name, never by value), the EVM block that reaches the bundle is rebuilt from known fields
// only, the endpoint may carry no credentials, a Base Sepolia config needs its code pin, and the chain clock exists for anvil only.
// No chain, no key file, no network: data in, a validated config or a typed refusal out.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { english, generateMnemonic, generatePrivateKey } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";

import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN } from "../src/rails/evm-htlc.js";
import { BASE_SEPOLIA_POLICY, KNOWN_GOOD_DEADLINES_BY_CHAIN } from "../src/client/policy.js";
import {
  absoluteDeadlines,
  endpointHost,
  KNOWN_GOOD_DEADLINES,
  loadRehearsalConfig,
  LOCK_ESTIMATE_MS,
  looksLikeKeyMaterial,
  parseRehearsalConfig,
  RehearsalConfigError,
} from "../src/client/rehearsal-config.js";
import { decimalKeyScanner, phraseScanner, strippedKeyScanner } from "./helpers/evm-local.js";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CODE_HASH = `0x${"6a".repeat(32)}`;
const BASE = resolve(tmpdir(), "rh-config-base");

function anvilConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rails: { evm: { pin: ANVIL_LOCAL_PIN, endpoint: "http://127.0.0.1:8545", contract: CONTRACT, assets: { USDC: TOKEN } } },
    buyerKeyFile: "keys/buyer.key",
    sellerKeyFile: "keys/seller.key",
    amount: "1000000",
    out: "bundle",
    ...extra,
  };
}

function baseSepoliaConfig(evmExtra: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...anvilConfig(),
    rails: { evm: { pin: BASE_SEPOLIA_PIN, endpoint: "https://sepolia.base.org", contract: CONTRACT, assets: { USDC: TOKEN }, contractCodeHash: CODE_HASH, ...evmExtra } },
    ...extra,
  };
}

function refusal(value: unknown): string {
  try {
    parseRehearsalConfig(value, BASE);
  } catch (error) {
    expect(error).toBeInstanceOf(RehearsalConfigError);
    return (error as Error).message;
  }
  throw new Error("the config was accepted");
}

describe("parseRehearsalConfig", () => {
  it("accepts a minimal anvil config, resolves paths against the base directory and fills the defaults", () => {
    const config = parseRehearsalConfig(anvilConfig(), BASE, "x.json");
    expect(config.file).toBe("x.json");
    expect(config.buyerKeyFile).toBe(resolve(BASE, "keys/buyer.key"));
    expect(config.sellerKeyFile).toBe(resolve(BASE, "keys/seller.key"));
    expect(config.out).toBe(resolve(BASE, "bundle"));
    expect(config.asset).toBe("USDC");
    expect(config.flopAmount).toBe("52070000");
    expect(config.clock).toBe("system");
    expect(config.pollMs).toBe(5_000);
    expect(config.waitLimitMs).toBe(2 * 60 * 60_000);
    expect(config.deadlinesSource).toBe("known-good");
    expect(config.deadlines).toBe(KNOWN_GOOD_DEADLINES[31337]); // an anvil pin resolves to the anvil set
    expect(config.rails.evm.contract).toBe(CONTRACT);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("keeps an absolute path as it is", () => {
    const abs = resolve(tmpdir(), "elsewhere", "buyer.key");
    expect(parseRehearsalConfig(anvilConfig({ buyerKeyFile: abs }), BASE).buyerKeyFile).toBe(abs);
  });

  it("accepts a Base Sepolia config with its code pin, and refuses one without (rule 2 reaches the runner's config)", () => {
    const config = parseRehearsalConfig(baseSepoliaConfig(), BASE);
    expect(config.rails.evm.pin.chainId).toBe(84532);
    expect(config.rails.evm.contractCodeHash).toBe(CODE_HASH);
    const { contractCodeHash: _dropped, ...withoutPin } = (baseSepoliaConfig().rails as { evm: Record<string, unknown> }).evm;
    const message = refusal({ ...baseSepoliaConfig(), rails: { evm: withoutPin } });
    expect(message).toContain("contractCodeHash");
  });

  it("carries maxLogRange, receiptTimeoutMs and an explicit finality through to the EVM config it hands on", () => {
    const config = parseRehearsalConfig(baseSepoliaConfig({ maxLogRange: 300, receiptTimeoutMs: 600_000 }), BASE);
    expect(config.rails.evm.maxLogRange).toBe(300);
    expect(config.rails.evm.receiptTimeoutMs).toBe(600_000);
  });

  it("refuses a field it does not know, at every level, by name and never by value", () => {
    const secret = `0x${"c0ffee".repeat(10)}c0ff`;
    const cases: Array<[string, unknown, string]> = [
      ["privateKey", anvilConfig({ privateKey: secret }), "privateKey"],
      ["buyerKey", anvilConfig({ buyerKey: secret }), "buyerKey"],
      ["rails.solana", anvilConfig({ rails: { evm: (anvilConfig().rails as { evm: unknown }).evm, solana: { programId: "x" } } }), "rails.solana"],
      ["rails.evm.key", { ...anvilConfig(), rails: { evm: { ...(anvilConfig().rails as { evm: object }).evm, key: secret } } }, "rails.evm.key"],
      [
        "rails.evm.pin.key",
        { ...anvilConfig(), rails: { evm: { ...(anvilConfig().rails as { evm: object }).evm, pin: { ...ANVIL_LOCAL_PIN, key: secret } } } },
        "rails.evm.pin.key",
      ],
      [
        "rails.evm.pin.finality.key",
        { ...anvilConfig(), rails: { evm: { ...(anvilConfig().rails as { evm: object }).evm, pin: { ...ANVIL_LOCAL_PIN, finality: { mode: "tag", tag: "finalized", key: secret } } } } },
        "rails.evm.pin.finality.key",
      ],
      ["deadlines.extra", anvilConfig({ deadlines: { ...KNOWN_GOOD_DEADLINES[31337], extra: secret } }), "deadlines.extra"],
      ["deadlines.legA.extra", anvilConfig({ deadlines: { legA: { ...KNOWN_GOOD_DEADLINES[31337].legA, extra: secret }, legB: KNOWN_GOOD_DEADLINES[31337].legB } }), "deadlines.legA.extra"],
    ];
    for (const [label, value, field] of cases) {
      const message = refusal(value);
      expect(message, label).toContain(`${field} is not a field this runner knows`);
      expect(message, label).not.toContain(secret);
    }
  });

  it("never prints a field NAME that is itself a secret", () => {
    const secretName = "c0".repeat(32);
    const message = refusal({ ...anvilConfig(), [secretName]: "x" });
    expect(message).toContain("<unprintable name>");
    expect(message).not.toContain(secretName);
  });

  it("does not write unknown fields of the EVM block into the config it returns (what the bundle's rails.json will hold)", () => {
    const config = parseRehearsalConfig(anvilConfig(), BASE);
    expect(Object.keys(config.rails.evm).sort()).toEqual(["assets", "contract", "endpoint", "pin"]);
    expect(Object.keys(config.rails.evm.pin).sort()).toEqual(["caip2", "chainId", "finality", "name"]);
  });

  it("refuses an endpoint with credentials, a query, a fragment, or another scheme", () => {
    const withEndpoint = (endpoint: string): Record<string, unknown> => ({ ...anvilConfig(), rails: { evm: { ...(anvilConfig().rails as { evm: object }).evm, endpoint } } });
    expect(refusal(withEndpoint("https://user:pw@rpc.example/"))).toContain("must not carry credentials");
    expect(refusal(withEndpoint("https://rpc.example/?apikey=abc"))).toContain("must not carry a query or a fragment");
    expect(refusal(withEndpoint("https://rpc.example/#frag"))).toContain("must not carry a query or a fragment");
    expect(refusal(withEndpoint("ftp://rpc.example/"))).toContain("http or https");
    expect(refusal(withEndpoint("not a url"))).toContain("not a URL");
    // And none of those refusals echoes the URL.
    expect(refusal(withEndpoint("https://user:pw@rpc.example/"))).not.toContain("rpc.example");
  });

  it("refuses chain ids and pins the EVM rules refuse (mainnet, a wrong name) and Base mainnet USDC", () => {
    const evm = (anvilConfig().rails as { evm: object }).evm;
    expect(refusal({ ...anvilConfig(), rails: { evm: { ...evm, pin: { ...ANVIL_LOCAL_PIN, chainId: 8453, caip2: "eip155:8453", name: "base" } } } })).toContain("allow list");
    expect(refusal({ ...anvilConfig(), rails: { evm: { ...evm, assets: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } } } })).toContain("Base mainnet USDC");
  });

  it("refuses two key files that are the same file, and a key file that is not a path", () => {
    expect(refusal(anvilConfig({ sellerKeyFile: "keys/buyer.key" }))).toContain("the same file");
    expect(refusal(anvilConfig({ buyerKeyFile: "" }))).toContain("buyerKeyFile must be a non-empty string");
    expect(refusal(anvilConfig({ sellerKeyFile: 7 }))).toContain("sellerKeyFile must be a non-empty string");
  });

  it("refuses a key file field that holds key material instead of a path, by field name, and never prints it", () => {
    const key = `0x${"1f".repeat(32)}`;
    const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    for (const [field, value] of [
      ["buyerKeyFile", key],
      ["sellerKeyFile", key.slice(2)],
      ["buyerKeyFile", `keys/${key}.key`],
      ["sellerKeyFile", phrase],
    ] as const) {
      const message = refusal(anvilConfig({ [field]: value }));
      expect(message, field).toContain(`${field} looks like key material`);
      expect(message, field).not.toContain(key.slice(2, 20));
      expect(message, field).not.toContain("winner");
    }
    // An ordinary path with spaces and digits is a path.
    expect(parseRehearsalConfig(anvilConfig({ buyerKeyFile: "C:/Program Files/keys/base-sepolia.buyer.key" }), BASE).buyerKeyFile).toContain("base-sepolia.buyer.key");
    expect(parseRehearsalConfig(anvilConfig({ buyerKeyFile: "base keys here" }), BASE).buyerKeyFile).toContain("base keys here"); // a few plain words are a path; a phrase has eleven or more
  });

  // K1 (P9 review round 1): a key pasted with ONE slip passed the old guard (an unbroken run of 64 hex digits) and the dry run printed 63 of its digits.
  it("refuses a key pasted with one slip (a dropped digit, a space, a newline, an O for a zero) and a 32-digit run, by field name, without echoing any of it", () => {
    const key = generatePrivateKey(); // generated now, never written anywhere
    const scan = strippedKeyScanner(key);
    const slipped: Array<[string, string]> = [
      ["63 hex digits", key.slice(0, -1)],
      ["a digit dropped at the front", `0x${key.slice(3)}`],
      ["a space after digit 32", `${key.slice(0, 34)} ${key.slice(34)}`],
      ["a newline after digit 32", `${key.slice(0, 34)}\n${key.slice(34)}`],
      ["a tab after digit 40", `${key.slice(0, 42)}\t${key.slice(42)}`],
      ["a letter O for a zero", `${key.slice(0, 30)}O${key.slice(31)}`],
      ["a letter l for a one", `${key.slice(0, 50)}l${key.slice(51)}`],
      ["no 0x, 63 digits", key.slice(3)],
      ["upper case", key.toUpperCase().replace("0X", "0x")],
      ["exactly 32 hex digits", key.slice(2, 34)],
      ["32 hex digits inside a path", `keys/${key.slice(2, 34)}.key`],
      ["32 upper-case hex digits", key.slice(2, 34).toUpperCase()],
    ];
    for (const field of ["buyerKeyFile", "sellerKeyFile"] as const) {
      for (const [label, value] of slipped) {
        expect(scan(value) || value.length >= 32, `${label}: the value must hold key material for this test to mean anything`).toBe(true);
        const message = refusal(anvilConfig({ [field]: value }));
        expect(message, `${field} ${label}`).toContain(`${field} looks like key material`);
        expect(scan(message), `${field} ${label}: the refusal must not print any window of the key`).toBe(false);
        expect(message, `${field} ${label}`).not.toContain(key.slice(2, 20));
      }
    }
  });

  it("refuses a phrase of eleven or more words in any letter case, and takes ten words, or words with other characters, for a path", () => {
    const eleven = "legal winner thank year wave sausage worth useful legal winner thank";
    const twelveUpper = "Legal Winner Thank Year Wave Sausage Worth Useful Legal Winner Thank Yellow";
    const long = `${eleven} ${eleven} yellow`;
    for (const phrase of [eleven, twelveUpper, eleven.toUpperCase(), long, `  ${eleven}  `, eleven.split(" ").join("\n"), "abandonxx ".repeat(11).trim()]) {
      const message = refusal(anvilConfig({ buyerKeyFile: phrase }));
      expect(message).toContain("buyerKeyFile looks like key material");
      expect(message).not.toContain("winner");
      expect(message).not.toContain("WINNER");
    }
    // Ten words, or eleven tokens of which one is not a BIP-39 word, are a path (a person's folder name), not a mnemonic.
    expect(parseRehearsalConfig(anvilConfig({ buyerKeyFile: "legal winner thank year wave sausage worth useful legal winner" }), BASE).buyerKeyFile).toContain("sausage");
    expect(parseRehearsalConfig(anvilConfig({ buyerKeyFile: `${eleven.replace("sausage", "xyzzy")}.key` }), BASE).buyerKeyFile).toContain("xyzzy");
    // KR3-2: digits glued to a word do not protect a phrase any more (the phrase rule cuts at every non-letter), so this is refused.
    expect(refusal(anvilConfig({ buyerKeyFile: `${eleven.replace("thank", "thank2")}.key` }))).toContain("buyerKeyFile looks like key material");
    // A run of 31 hex digits is a path.
    expect(parseRehearsalConfig(anvilConfig({ buyerKeyFile: `keys/${"ab".repeat(15)}c.key` }), BASE).buyerKeyFile).toContain("c.key");
  });

  it("refuses a pin name or caip2 that is not a short plain text by field name, so a key pasted there is not quoted back by the rail's own refusal", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const evm = (anvilConfig().rails as { evm: object }).evm;
    for (const field of ["name", "caip2"] as const) {
      for (const value of [key, `x ${key}`, "", "a".repeat(41), 7, null]) {
        const message = refusal({ ...anvilConfig(), rails: { evm: { ...evm, pin: { ...ANVIL_LOCAL_PIN, [field]: value } } } });
        expect(message, `${field} ${typeof value}`).toContain(`rails.evm.pin.${field} must be a short plain text`);
        expect(scan(message), `${field}: no window of the pasted key may be quoted`).toBe(false);
      }
    }
    // The README's pins are plain texts and still pass; the rail's own name check still names a wrong one.
    expect(parseRehearsalConfig(baseSepoliaConfig(), BASE).rails.evm.pin.name).toBe("base-sepolia");
    expect(refusal({ ...anvilConfig(), rails: { evm: { ...evm, pin: { ...ANVIL_LOCAL_PIN, name: "base-sepolia" } } } })).toContain("rails.evm:");
  });

  // KR2-1 (P9 review round 2): one exported rule, applied to every value the runner prints back or writes into the bundle.
  it("looksLikeKeyMaterial is one rule: 32 hex digits in a run, or eleven words of letters; a UUID, a Windows path and a few plain words are not key material", () => {
    const key = generatePrivateKey();
    for (const value of [key, key.slice(2), key.slice(3), key.slice(2, 34), `dir/${key.slice(2, 34)}.key`, key.toUpperCase().replace("0X", "0x"), `${key.slice(0, 34)} ${key.slice(34)}`]) {
      expect(looksLikeKeyMaterial(value), "a key or a slipped key").toBe(true);
    }
    expect(looksLikeKeyMaterial("legal winner thank year wave sausage worth useful legal winner thank")).toBe(true);
    for (const value of [
      "",
      "bundle",
      "97811a09-a70d-4b56-ad4f-e4c4e7e05f8a",
      "C:\\Users\\someone\\AppData\\Local\\Temp\\claude\\scratchpad\\p9fix2",
      "C:/Program Files/keys/base-sepolia.buyer.key",
      key.slice(2, 33), // 31 digits
      "ab".repeat(15),
      "legal winner thank year wave sausage worth useful legal winner", // ten words
      "sepolia.base.org",
      "127.0.0.1:8545",
    ]) {
      expect(looksLikeKeyMaterial(value), value).toBe(false);
    }
  });

  it("refuses key material in out, in every asset name, in the asset field and in the endpoint host, by field name, without echoing any window of it", () => {
    const key = generatePrivateKey();
    const scan = strippedKeyScanner(key);
    const evm = (anvilConfig().rails as { evm: Record<string, unknown> }).evm;
    const withEvm = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...anvilConfig(), rails: { evm: { ...evm, ...extra } } });
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["out", "out looks like key material", anvilConfig({ out: key })],
      ["out, one slip", "out looks like key material", anvilConfig({ out: key.slice(0, -1) })],
      ["out, a path that ends in the key", "out looks like key material", anvilConfig({ out: `bundles/${key}` })],
      ["an asset name, with a value that is not an address", "rails.evm.assets: the name at position 2", withEvm({ assets: { USDC: TOKEN, [key]: "nope" } })],
      ["an asset name, with an address as its value", "rails.evm.assets: the name at position 2", withEvm({ assets: { USDC: TOKEN, [key]: TOKEN } })],
      ["an asset name of 32 hex digits", "rails.evm.assets: the name at position 2", withEvm({ assets: { USDC: TOKEN, [key.slice(2, 34)]: TOKEN } })],
      ["an asset name with a space and the key", "rails.evm.assets: the name at position 1", withEvm({ assets: { [`x ${key}`]: TOKEN, USDC: TOKEN } })],
      ["the asset field", "asset must be a short plain name", anvilConfig({ asset: key })],
      ["the endpoint's host", "rails.evm.endpoint's host looks like key material", withEvm({ endpoint: `https://${key}.example.org/v2/x` })],
      ["the endpoint's host, upper case", "rails.evm.endpoint's host looks like key material", withEvm({ endpoint: `https://${key.toUpperCase().replace("0X", "0x")}.example.org` })],
    ];
    for (const [label, named, config] of cases) {
      const message = refusal(config);
      expect(message, label).toContain(named);
      expect(scan(message), `${label}: no window of the pasted key may be quoted`).toBe(false);
    }
    // The endpoint's PATH stays documented only: it cannot be told from a provider's API-key path, and it is never printed.
    expect(parseRehearsalConfig(withEvm({ endpoint: `https://sepolia.base.org/v2/${key.slice(2, 34)}` }), BASE).rails.evm.endpoint).toContain("/v2/");
  });

  it("holds every asset name to a short plain name before the rail's own checks run: the rail's refusals never see (or quote) a name that is not one", () => {
    const evm = (anvilConfig().rails as { evm: Record<string, unknown> }).evm;
    const withAssets = (assets: Record<string, unknown>): Record<string, unknown> => ({ ...anvilConfig(), rails: { evm: { ...evm, assets } } });
    for (const name of ["", "a b", "usdc.test", "x".repeat(33), "ü", "a/b", "0x" + "ab".repeat(20)]) {
      expect(refusal(withAssets({ USDC: TOKEN, [name]: TOKEN })), JSON.stringify(name.length)).toContain("rails.evm.assets: the name at position 2 is not a short plain name");
    }
    // The README's names pass, with the value checks of the rail after them.
    expect(parseRehearsalConfig(withAssets({ USDC: TOKEN, "usdc-test_2": TOKEN }), BASE).rails.evm.assets["usdc-test_2"]).toBe(TOKEN);
    expect(refusal(withAssets({ USDC: "nope" }))).toContain('assets["USDC"] must be a 0x-address');
  });

  it("names the 32-digit and 11-word rule in the refusal (and no longer says a run of 64)", () => {
    const message = refusal(anvilConfig({ buyerKeyFile: "ab".repeat(16) }));
    expect(message).toContain("a run of 32 or more hex digits");
    expect(message).toContain("a phrase of 11 or more words");
  });

  it("inherits the rail's maxLogRange floor: a cap below 257 blocks is refused by field name, 257 and the default are accepted (F1)", () => {
    for (const low of [1, 10, 100, 256]) {
      expect(refusal(baseSepoliaConfig({ maxLogRange: low })), String(low)).toMatch(/rails\.evm: .*maxLogRange must be at least 257/);
    }
    expect(parseRehearsalConfig(baseSepoliaConfig({ maxLogRange: 257 }), BASE).rails.evm.maxLogRange).toBe(257);
    expect(parseRehearsalConfig(baseSepoliaConfig({ maxLogRange: 500 }), BASE).rails.evm.maxLogRange).toBe(500);
    expect(parseRehearsalConfig(baseSepoliaConfig(), BASE).rails.evm.maxLogRange).toBeUndefined(); // the chain's default (500) applies
  });

  it("checks the amount, the asset and the FLOP amount", () => {
    expect(refusal(anvilConfig({ amount: "0" }))).toContain("amount must be a positive decimal integer string");
    expect(refusal(anvilConfig({ amount: "1.5" }))).toContain("amount must be a positive decimal integer string");
    expect(refusal(anvilConfig({ amount: 1000000 }))).toContain("amount must be a non-empty string");
    expect(refusal(anvilConfig({ asset: "DAI" }))).toContain('asset "DAI" is not a key of rails.evm.assets');
    expect(refusal(anvilConfig({ asset: "bad asset" }))).toContain("asset must be a short plain name");
    expect(refusal(anvilConfig({ flopAmount: "-3" }))).toContain("flopAmount must be a positive decimal integer string");
    expect(parseRehearsalConfig(anvilConfig({ flopAmount: "99" }), BASE).flopAmount).toBe("99");
  });

  // KR3-2 (P9 review round 3): the rule saw a contiguous 32-hex run or a value that is ENTIRELY 11 or more bare letter words, so a whole key in groups or with
  // invisible separators, and any decorated seed phrase, was printed by out, --state-dir and the config path. Every key and phrase here is generated now and
  // only ever scanned for or compared, never written down; the assertions print labels and booleans.
  it("KR3-2: refuses a key in groups or with invisible separators and a decorated seed phrase, by field name, without quoting any of it; a UUID, paths and plain text pass", () => {
    const key = generatePrivateKey();
    const bare = key.slice(2);
    const words = generateMnemonic(english).split(" ");
    const phrase = words.join(" ");
    const cut = (size: number, separator: string): string => bare.match(new RegExp(`.{1,${size}}`, "g"))!.join(separator);
    const scanKey = strippedKeyScanner(key);
    const scanPhrase = phraseScanner(words);
    const refused: Array<[string, string]> = [
      ["a key in groups of 4 separated by spaces", `0x${cut(4, " ")}`],
      ["a key in groups of 8 separated by tabs", cut(8, "\t")],
      ["a key in groups of 4 separated by newlines", cut(4, "\n")],
      ["a key with U+200B (zero-width space) every 15 characters", `0x${cut(15, "\u200b")}`],
      ["a key with U+00AD (soft hyphen) every 15 characters", `0x${cut(15, "\u00ad")}`],
      ["a key with U+200D (zero-width joiner) every 7 characters", `0x${cut(7, "\u200d")}`],
      ["a key with U+FEFF every 9 characters", cut(9, "\ufeff")],
      ["a key in groups of 4 inside a path", `bundles/${cut(4, " ")}/run`],
      ["a numbered phrase", words.map((word, index) => `${index + 1}. ${word}`).join(" ")],
      ["a labelled phrase", `Phrase: ${phrase}`],
      ["a phrase with commas", words.join(",")],
      ["a phrase with commas and spaces", words.join(", ")],
      ["a phrase with hyphens", words.join("-")],
      ["a phrase with a trailing period", `${phrase}.`],
      ["a phrase as a POSIX path segment", `bundles/${phrase}`],
      ["a phrase as a Windows path segment", `C:\\Users\\x\\${phrase}\\config.json`],
      ["a phrase in upper case", phrase.toUpperCase()],
      ["eleven words of the phrase, comma separated", words.slice(0, 11).join(",")],
      ["a phrase with one word replaced by a number", [...words.slice(0, 5), "7", ...words.slice(6)].join(" ")],
    ];
    for (const [label, value] of refused) {
      expect(scanKey(value) || scanPhrase(value), `${label}: the value must hold the key or the phrase, or this test proves nothing`).toBe(true);
      expect(looksLikeKeyMaterial(value), label).toBe(true);
      for (const field of ["buyerKeyFile", "sellerKeyFile", "out"] as const) {
        const message = refusal(anvilConfig({ [field]: value }));
        expect(message, `${field}: ${label}`).toContain(`${field} looks like key material`);
        expect(scanKey(message) || scanPhrase(message), `${field}: ${label}: the refusal must not quote any window of it`).toBe(false);
      }
    }
    // Ordinary values are not key material: a UUID, a run label, typical POSIX and Windows paths, a spaced file name, a 10-word phrase of ordinary words, hosts.
    for (const value of [
      "97811a09-a70d-4b56-ad4f-e4c4e7e05f8a",
      "bundles/run-2026-10-07",
      "C:/Users/x/out",
      "C:\\Users\\someone\\AppData\\Local\\Temp\\rh-run-a1B2c3",
      "/home/someone/bundles/the-first-swap-of-the-week-on-base-sepolia",
      "My Documents/base sepolia keys/buyer.key",
      "my first swap of the whole week on base sepolia",
      "legal winner thank year wave sausage worth useful legal winner", // ten words of the list
      "sepolia.base.org",
      "base-sepolia-rpc.publicnode.com",
      "base-sepolia.g.alchemy.com",
      "localhost",
      "127.0.0.1:8545",
      "ab".repeat(15),
    ]) {
      expect(looksLikeKeyMaterial(value), value).toBe(false);
    }
    // The separators the rule strips are whitespace and format characters, never hyphens: a UUID in a path stays a path.
    expect(parseRehearsalConfig(anvilConfig({ out: "bundles/97811a09-a70d-4b56-ad4f-e4c4e7e05f8a" }), BASE).out).toContain("a70d");
  });

  // KR3-1 (P9 review round 3): a private key written in decimal fits the amount shape (up to 78 digits) and used to be printed by the plan and the terms
  // row, and (flopAmount) written into run.json, both flow records, the venue and the bundle's offer transcript.
  it("KR3-1: refuses a key written in decimal in amount and in flopAmount, by field name, without quoting any window of it; 31 digits still pass, 32 do not", () => {
    for (const field of ["amount", "flopAmount"] as const) {
      const key = generatePrivateKey();
      const decimal = BigInt(key).toString(10);
      const scan = decimalKeyScanner(key);
      expect(scan(decimal), `${field}: the value must hold windows of the key, or this test proves nothing`).toBe(true);
      expect(decimal.length, field).toBeGreaterThanOrEqual(32);
      let error: unknown;
      try {
        parseRehearsalConfig(anvilConfig({ [field]: decimal }), BASE);
      } catch (caught) {
        error = caught;
      }
      expect(error, `${field}: a key in decimal must be refused`).toBeInstanceOf(RehearsalConfigError);
      const message = (error as Error).message;
      expect(message, field).toContain(`${field} looks like key material`);
      expect(scan(message), `${field}: no window of the pasted key may be quoted`).toBe(false);
      expect(message, field).not.toContain(decimal.slice(0, 12));
    }
    // The edge is the rule's: 31 digits are an amount (as far as shape goes), 32 or more digits are a run of 32 hex digits.
    for (const field of ["amount", "flopAmount"] as const) {
      const thirtyOne = `1${"0".repeat(30)}`;
      expect(parseRehearsalConfig(anvilConfig({ [field]: thirtyOne }), BASE)[field], field).toBe(thirtyOne);
      expect(refusal(anvilConfig({ [field]: `1${"0".repeat(31)}` })), field).toContain(`${field} looks like key material`);
      expect(refusal(anvilConfig({ [field]: `${"9".repeat(78)}` })), field).toContain(`${field} looks like key material`);
    }
    // The two fields' other refusals are unchanged (and still never quote the value).
    expect(refusal(anvilConfig({ amount: "0" }))).toContain("amount must be a positive decimal integer string");
    expect(refusal(anvilConfig({ flopAmount: "1.5" }))).toContain("flopAmount must be a positive decimal integer string");
  });

  // P9-4 decision 14 (spec rule 1, no key in a log or a capture): a seed phrase with an invisible format character inside each word was the one form the
  // README listed as unseen. The phrase tests now run on the value with every format character (`\p{Cf}`) removed as well.
  it("P9-4 d14: a seed phrase with a zero-width or other format character inside each word is refused by field name, and never quoted; ordinary text with such a character is not", () => {
    const words = generateMnemonic(english).split(" ");
    const scanPhrase = phraseScanner(words);
    const noFormat = (text: string): string => text.replace(/\p{Cf}/gu, "");
    const inside = (word: string, mark: string): string => `${word.slice(0, 2)}${mark}${word.slice(2)}`;
    const marked = (mark: string, separator = " "): string => words.map((word) => inside(word, mark)).join(separator);
    const refused: Array<[string, string]> = [
      ["U+200B (zero-width space) inside each word", marked("\u200b")],
      ["U+200D (zero-width joiner) inside each word", marked("\u200d")],
      ["U+00AD (soft hyphen) inside each word", marked("\u00ad")],
      ["U+FEFF inside each word", marked("\ufeff")],
      ["U+2060 (word joiner) inside each word, one per line", marked("\u2060", "\n")],
      ["a numbered phrase with U+200B inside each word", words.map((word, index) => `${index + 1}. ${inside(word, "\u200b")}`).join(" ")],
      ["a phrase with commas and U+200B inside each word", marked("\u200b", ",")],
      ["a phrase as a path segment with U+200B inside each word", `bundles/${marked("\u200b")}`],
      ["eleven words of the phrase with U+200B inside each", words.slice(0, 11).map((word) => inside(word, "\u200b")).join(" ")],
      ["a phrase with U+200B inside every second word only", words.map((word, index) => (index % 2 === 0 ? inside(word, "\u200b") : word)).join(" ")],
    ];
    for (const [label, value] of refused) {
      expect(noFormat(value), `${label}: the invisible characters are what hid it`).not.toBe(value);
      expect(scanPhrase(noFormat(value)), `${label}: the value must hold the phrase, or this test proves nothing`).toBe(true);
      expect(looksLikeKeyMaterial(value), label).toBe(true);
      for (const field of ["buyerKeyFile", "sellerKeyFile", "out"] as const) {
        const message = refusal(anvilConfig({ [field]: value }));
        expect(message, `${field}: ${label}`).toContain(`${field} looks like key material`);
        expect(scanPhrase(noFormat(message)), `${field}: ${label}: the refusal must not quote any window of the phrase`).toBe(false);
      }
    }
    // The same through an asset name, which shares the rule.
    const phrase = marked("\u200b");
    expect(refusal({ ...anvilConfig(), rails: { evm: { pin: ANVIL_LOCAL_PIN, endpoint: "http://127.0.0.1:8545", contract: CONTRACT, assets: { [phrase]: TOKEN } } } })).toContain("rails.evm.assets");
    // Ordinary text is still ordinary: a format character in a path, ten words (with one inside each), and a plain phrase of ten words.
    for (const value of [
      "bundles/run\u200b-2026-10-07",
      "C:\\Users\\someone\u200b\\out",
      words.slice(0, 10).map((word) => inside(word, "\u200b")).join(" "),
      "my first swap of the whole week on base sepolia",
    ]) {
      expect(looksLikeKeyMaterial(value), value).toBe(false);
    }
  });

  it("accepts explicit deadlines and refuses malformed ones", () => {
    const explicit = { legA: { claimByMin: 40, refundAfterMin: 50, expiresMin: 20 }, legB: { claimByMin: 70, refundAfterMin: 110, expiresMin: 30 } };
    const config = parseRehearsalConfig(anvilConfig({ deadlines: explicit }), BASE);
    expect(config.deadlinesSource).toBe("explicit");
    expect(config.deadlines).toEqual(explicit);
    expect(parseRehearsalConfig(anvilConfig({ deadlines: "known-good" }), BASE).deadlinesSource).toBe("known-good");
    expect(refusal(anvilConfig({ deadlines: "soon" }))).toContain("deadlines");
    expect(refusal(anvilConfig({ deadlines: { legA: explicit.legA } }))).toContain("deadlines.legB must be an object");
    expect(refusal(anvilConfig({ deadlines: { ...explicit, legA: { claimByMin: 50, refundAfterMin: 50, expiresMin: 20 } } }))).toContain("claimByMin must be before refundAfterMin");
    expect(refusal(anvilConfig({ deadlines: { ...explicit, legA: { claimByMin: 40.5, refundAfterMin: 50, expiresMin: 20 } } }))).toContain("deadlines.legA.claimByMin must be an integer");
    expect(refusal(anvilConfig({ deadlines: { ...explicit, legB: { claimByMin: 70, refundAfterMin: 110, expiresMin: 0 } } }))).toContain("deadlines.legB.expiresMin must be an integer");
  });

  it('allows clock "chain" for anvil only and checks the polling bounds', () => {
    expect(parseRehearsalConfig(anvilConfig({ clock: "chain" }), BASE).clock).toBe("chain");
    expect(refusal(baseSepoliaConfig({}, { clock: "chain" }))).toContain("local anvil node only");
    expect(refusal(anvilConfig({ clock: "wall" }))).toContain('clock must be "system" or "chain"');
    expect(refusal(anvilConfig({ pollMs: 10 }))).toContain("pollMs must be an integer from 50");
    expect(refusal(anvilConfig({ pollMs: 5000, waitLimitMs: 1000 }))).toContain("waitLimitMs must be an integer from 5000");
    const config = parseRehearsalConfig(anvilConfig({ pollMs: 250, waitLimitMs: 60_000 }), BASE);
    expect(config.pollMs).toBe(250);
    expect(config.waitLimitMs).toBe(60_000);
  });

  // P9-4 decision 9: the late-claim wait, the never-locked verdict wait and the recovered-lock wait are all bounded by waitLimitMs, so on Base Sepolia it may not be
  // under one finality budget (BASE_SEPOLIA_POLICY.finalityAMs, 80 minutes). Anvil keeps its short limits (the suites run at a few seconds).
  it("P9-4 d9: on Base Sepolia waitLimitMs may not be below the policy's finality budget (80 min), refused by field name; the default and the budget itself pass; anvil is unchanged", () => {
    expect(BASE_SEPOLIA_POLICY.finalityAMs).toBe(4_800_000);
    const below = refusal(baseSepoliaConfig({}, { waitLimitMs: BASE_SEPOLIA_POLICY.finalityAMs - 1 }));
    expect(below).toContain("waitLimitMs 4799999 is below the finality budget of base-sepolia (4800000 ms, 80 min)");
    expect(refusal(baseSepoliaConfig({}, { waitLimitMs: 60_000, pollMs: 250 }))).toContain("waitLimitMs 60000 is below the finality budget");
    expect(refusal(baseSepoliaConfig({}, { waitLimitMs: 1_200_000 }))).toContain("waitLimitMs 1200000 is below the finality budget"); // the anvil budget (20 min) is not enough there
    expect(parseRehearsalConfig(baseSepoliaConfig({}, { waitLimitMs: BASE_SEPOLIA_POLICY.finalityAMs }), BASE).waitLimitMs).toBe(4_800_000);
    expect(parseRehearsalConfig(baseSepoliaConfig({}, { waitLimitMs: 6 * 60 * 60_000 }), BASE).waitLimitMs).toBe(21_600_000);
    expect(parseRehearsalConfig(baseSepoliaConfig(), BASE).waitLimitMs).toBeGreaterThanOrEqual(BASE_SEPOLIA_POLICY.finalityAMs); // the default holds the floor
    // The field's own shape refusals come first and are unchanged.
    expect(refusal(baseSepoliaConfig({}, { waitLimitMs: "4800000" }))).toContain("waitLimitMs must be an integer from");
    // Anvil: no floor (a short wait limit is what the live suites use).
    expect(parseRehearsalConfig(anvilConfig({ pollMs: 50, waitLimitMs: 100 }), BASE).waitLimitMs).toBe(100);
    expect(parseRehearsalConfig(anvilConfig({ pollMs: 250, waitLimitMs: 3_000 }), BASE).waitLimitMs).toBe(3_000);
  });

  // P9-4 decision 2 (runner part): "known-good" (and an absent deadlines) resolves by the pin's chain id, to the set that satisfies every rule under THAT chain's policy.
  it("P9-4 d2: known-good deadlines resolve by the pin's chain id: anvil +60/+90/+120/+180, Base Sepolia +115/+135/+225/+285; an explicit set is the person's own", () => {
    expect(Object.keys(KNOWN_GOOD_DEADLINES).sort()).toEqual(["31337", "84532"]);
    const anvil = parseRehearsalConfig(anvilConfig(), BASE);
    expect(anvil.deadlinesSource).toBe("known-good");
    expect(anvil.deadlines).toBe(KNOWN_GOOD_DEADLINES[31337]);
    expect(anvil.deadlines).toEqual({ legA: { claimByMin: 60, refundAfterMin: 90, expiresMin: 30 }, legB: { claimByMin: 120, refundAfterMin: 180, expiresMin: 40 } });
    for (const deadlines of [undefined, "known-good"]) {
      const base = parseRehearsalConfig(baseSepoliaConfig({}, deadlines === undefined ? {} : { deadlines }), BASE);
      expect(base.deadlinesSource, String(deadlines)).toBe("known-good");
      expect(base.deadlines, String(deadlines)).toBe(KNOWN_GOOD_DEADLINES[84532]);
      expect(base.deadlines, String(deadlines)).toEqual({ legA: { claimByMin: 115, refundAfterMin: 135, expiresMin: 30 }, legB: { claimByMin: 225, refundAfterMin: 285, expiresMin: 40 } });
      expect(parseRehearsalConfig(anvilConfig(deadlines === undefined ? {} : { deadlines }), BASE).deadlines, String(deadlines)).toBe(KNOWN_GOOD_DEADLINES[31337]);
    }
    // The table the runner reads is the policy module's, so it cannot drift from the set the deadline tests pin.
    expect(KNOWN_GOOD_DEADLINES).toBe(KNOWN_GOOD_DEADLINES_BY_CHAIN);
    expect(Object.isFrozen(KNOWN_GOOD_DEADLINES)).toBe(true);
    // An explicit set is used as given, on either chain (the pre-flight then judges it against the chain's policy).
    const explicit = { legA: { claimByMin: 40, refundAfterMin: 50, expiresMin: 20 }, legB: { claimByMin: 70, refundAfterMin: 110, expiresMin: 30 } };
    const given = parseRehearsalConfig(baseSepoliaConfig({}, { deadlines: explicit }), BASE);
    expect(given.deadlinesSource).toBe("explicit");
    expect(given.deadlines).toEqual(explicit);
    expect(absoluteDeadlines(parseRehearsalConfig(baseSepoliaConfig(), BASE).deadlines, 0).legB.refundAfterMs).toBe(285 * 60_000);
  });

  // P9-4 decision 3: Base Sepolia pins finality to the chain's `finalized` tag. The rail's own check refuses confirmations mode and a fallback there; the runner's config
  // names the field, and never a value.
  it("P9-4 d3: on Base Sepolia confirmations mode and any fallbackConfirmations are refused by field name (and never echoed); anvil keeps both", () => {
    const confirmations = refusal(baseSepoliaConfig({ pin: { ...BASE_SEPOLIA_PIN, finality: { mode: "confirmations", confirmations: 12 } } }));
    expect(confirmations).toContain('rails.evm.pin.finality.mode is "confirmations", which base-sepolia (84532) refuses');
    const fallback = refusal(baseSepoliaConfig({ pin: { ...BASE_SEPOLIA_PIN, finality: { mode: "tag", tag: "finalized", fallbackConfirmations: 200 } } }));
    expect(fallback).toContain("rails.evm.pin.finality.fallbackConfirmations is set, which base-sepolia (84532) refuses");
    expect(fallback).not.toContain("200");
    // A value that is not even a number is refused the same way and never quoted.
    const secret = `0x${"c0ffee".repeat(10)}c0ff`;
    const odd = refusal(baseSepoliaConfig({ pin: { ...BASE_SEPOLIA_PIN, finality: { mode: "tag", tag: "finalized", fallbackConfirmations: secret } } }));
    expect(odd).toContain("rails.evm.pin.finality.fallbackConfirmations is set");
    expect(odd).not.toContain(secret);
    expect(odd).not.toContain("c0ffee");
    // The plain tag pin is what the README shows, and it passes.
    expect(parseRehearsalConfig(baseSepoliaConfig({ pin: { ...BASE_SEPOLIA_PIN, finality: { mode: "tag", tag: "finalized" } } }), BASE).rails.evm.pin.finality).toEqual({ mode: "tag", tag: "finalized" });
    // Anvil keeps both (its local node has no finalized block of its own to rely on in every suite).
    const anvilWith = (finality: Record<string, unknown>): Record<string, unknown> => ({
      ...anvilConfig(),
      rails: { evm: { pin: { ...ANVIL_LOCAL_PIN, finality }, endpoint: "http://127.0.0.1:8545", contract: CONTRACT, assets: { USDC: TOKEN } } },
    });
    expect(parseRehearsalConfig(anvilWith({ mode: "confirmations", confirmations: 12 }), BASE).rails.evm.pin.finality).toEqual({ mode: "confirmations", confirmations: 12 });
    expect(parseRehearsalConfig(anvilWith({ mode: "tag", tag: "finalized", fallbackConfirmations: 200 }), BASE).rails.evm.pin.finality).toEqual({ mode: "tag", tag: "finalized", fallbackConfirmations: 200 });
  });

  it("refuses a config that is not an object, and rails that are not", () => {
    expect(refusal(null)).toContain("the config must be an object");
    expect(refusal([])).toContain("the config must be an object");
    expect(refusal({ ...anvilConfig(), rails: null })).toContain("rails must be an object");
    expect(refusal({ ...anvilConfig(), rails: {} })).toContain("rails.evm must be an object");
  });
});

describe("loadRehearsalConfig", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "rh-cfg-"));
    dirs.push(dir);
    return dir;
  };

  it("reads a config file and resolves its relative paths against the file's own directory", async () => {
    const dir = await temp();
    await writeFile(join(dir, "c.json"), JSON.stringify(anvilConfig()));
    const config = await loadRehearsalConfig(join(dir, "c.json"));
    expect(config.file).toBe(join(dir, "c.json"));
    expect(config.buyerKeyFile).toBe(join(dir, "keys", "buyer.key"));
    expect(config.out).toBe(join(dir, "bundle"));
  });

  it("accepts UTF-8 with a byte order mark (Windows PowerShell writes one) and names UTF-16 instead of calling it invalid", async () => {
    const dir = await temp();
    const json = JSON.stringify(anvilConfig());
    await writeFile(join(dir, "bom.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")]));
    expect((await loadRehearsalConfig(join(dir, "bom.json"))).asset).toBe("USDC");
    await writeFile(join(dir, "utf16le.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")]));
    await expect(loadRehearsalConfig(join(dir, "utf16le.json"))).rejects.toThrow(/is UTF-16 text; save it as UTF-8/);
    await writeFile(join(dir, "utf16be.json"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(json, "utf16le").swap16()]));
    await expect(loadRehearsalConfig(join(dir, "utf16be.json"))).rejects.toThrow(/is UTF-16 text; save it as UTF-8/);
  });

  it("refuses a missing file and a file that is not JSON without echoing any content", async () => {
    const dir = await temp();
    await expect(loadRehearsalConfig(join(dir, "missing.json"))).rejects.toThrow(/cannot read the config file/);
    const secret = `0x${"ab".repeat(32)}`;
    await writeFile(join(dir, "bad.json"), `{ "privateKey": "${secret}" `);
    const error = await loadRehearsalConfig(join(dir, "bad.json")).catch((e: Error) => e);
    expect(error).toBeInstanceOf(RehearsalConfigError);
    expect((error as Error).message).toContain("is not valid JSON");
    expect((error as Error).message).not.toContain(secret);
  });
});

describe("deadlines and the endpoint host", () => {
  it("lays the known-good minutes on the run's start", () => {
    const abs = absoluteDeadlines(KNOWN_GOOD_DEADLINES[31337], 1_000_000_000_000);
    expect(abs.legA).toEqual({ claimByMs: 1_000_000_000_000 + 60 * 60_000, refundAfterMs: 1_000_000_000_000 + 90 * 60_000, expiresMs: 1_000_000_000_000 + 30 * 60_000 });
    expect(abs.legB).toEqual({ claimByMs: 1_000_000_000_000 + 120 * 60_000, refundAfterMs: 1_000_000_000_000 + 180 * 60_000, expiresMs: 1_000_000_000_000 + 40 * 60_000 });
    expect(LOCK_ESTIMATE_MS).toBe(10 * 60_000);
  });

  it("names the host of an endpoint and never its path", () => {
    expect(endpointHost("https://sepolia.base.org/v2/SECRETSECRET")).toBe("sepolia.base.org");
    expect(endpointHost("http://127.0.0.1:8545")).toBe("127.0.0.1:8545");
    expect(endpointHost("nonsense")).toBe("<invalid url>");
  });
});

// K4 (P9 review round 1): `git check-ignore keys/buyer.key` printed nothing, so `git add -A` could stage a key file kept inside the repository.
describe("key files are ignored by git", () => {
  it(".gitignore names *.key", async () => {
    const text = await readFile(fileURLToPath(new URL("../.gitignore", import.meta.url)), "utf8");
    expect(text.split("\n").map((line) => line.trim())).toContain("*.key");
  });
});
