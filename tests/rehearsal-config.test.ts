// SPDX-License-Identifier: MIT
//
// tests/rehearsal-config.test.ts: P9-6, the config file of the EVM rehearsal runner (src/client/rehearsal-config.ts). The config is
// closed (an unknown field is refused by name, never by value), the EVM block that reaches the bundle is rebuilt from known fields
// only, the endpoint may carry no credentials, a Base Sepolia config needs its code pin, and the chain clock exists for anvil only.
// No chain, no key file, no network: data in, a validated config or a typed refusal out.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN } from "../src/rails/evm-htlc.js";
import {
  absoluteDeadlines,
  endpointHost,
  KNOWN_GOOD_DEADLINES,
  loadRehearsalConfig,
  LOCK_ESTIMATE_MS,
  parseRehearsalConfig,
  RehearsalConfigError,
} from "../src/client/rehearsal-config.js";

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
    expect(config.deadlines).toBe(KNOWN_GOOD_DEADLINES);
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
    const config = parseRehearsalConfig(baseSepoliaConfig({ maxLogRange: 250, receiptTimeoutMs: 600_000 }), BASE);
    expect(config.rails.evm.maxLogRange).toBe(250);
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
      ["deadlines.extra", anvilConfig({ deadlines: { ...KNOWN_GOOD_DEADLINES, extra: secret } }), "deadlines.extra"],
      ["deadlines.legA.extra", anvilConfig({ deadlines: { legA: { ...KNOWN_GOOD_DEADLINES.legA, extra: secret }, legB: KNOWN_GOOD_DEADLINES.legB } }), "deadlines.legA.extra"],
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
    expect(parseRehearsalConfig(anvilConfig({ buyerKeyFile: "base keys here" }), BASE).buyerKeyFile).toContain("base keys here"); // a few plain words are a path; a phrase has twelve
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
    const abs = absoluteDeadlines(KNOWN_GOOD_DEADLINES, 1_000_000_000_000);
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
