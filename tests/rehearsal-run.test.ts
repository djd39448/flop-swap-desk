// SPDX-License-Identifier: MIT
//
// tests/rehearsal-run.test.ts: P9-6 (rule 4, "nothing public before Dave"), the runner's front door without a chain that moves value:
// `runRehearsal` and bin/swap-rehearsal-evm.mjs against a fake READ-ONLY chain served over a throwaway local HTTP server (the fake
// refuses every write method and records it), with key files generated now. What is pinned here: the dry run (the default) reads, prints
// a table with the two addresses and never a key or the endpoint, writes nothing and exits 0; every refusal path (a failed pre-flight,
// `--yes` with a failed pre-flight, a missing run, a bad config, a bad key file, a failing endpoint) exits with its own code and sends and
// writes nothing; and the command line is strict. The swap itself (settle, refund, a kill and a resume) is tests-anvil/rehearsal-runner.
// anvil.test.ts, on a real node.

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXIT, parseRunRecord, runRehearsal, type RehearsalEnv, type RehearsalMode } from "../src/client/rehearsal-run.js";
import { loadOrCreateIdentity } from "../src/client/rehearsal-world.js";
import { BASE_SEPOLIA_PIN } from "../src/rails/evm-htlc.js";
import { keyScanner } from "./helpers/evm-local.js";
import { fakeChain, FAKE_ESCROW_CODE_HASH, serveFakeChain, type FakeChain, type FakeChainOptions } from "./helpers/fake-chain.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BIN = join(REPO_ROOT, "bin", "swap-rehearsal-evm.mjs");
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SECRET_PATH = "/v2/SECRETPATHKEYPART";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Rig {
  dir: string;
  configPath: string;
  stateDir: string;
  outDir: string;
  buyer: string;
  seller: string;
  leaks: (text: string) => boolean;
  chain: FakeChain;
}

interface RigOptions {
  chain?: FakeChainOptions;
  codeHash?: string;
  skipSellerKey?: boolean;
  configExtra?: Record<string, unknown>;
  endpoint?: string;
}

async function makeRig(options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "rh-run-"));
  dirs.push(dir);
  const keys = [generatePrivateKey(), generatePrivateKey()];
  const accounts = keys.map((key) => privateKeyToAccount(key));
  await mkdir(join(dir, "keys"));
  await writeFile(join(dir, "keys", "buyer.key"), `${keys[0]}\n`, { mode: 0o600 });
  if (options.skipSellerKey !== true) await writeFile(join(dir, "keys", "seller.key"), `${keys[1]}\n`, { mode: 0o600 });
  const buyer = accounts[0]!.address;
  const seller = accounts[1]!.address;
  const chain = fakeChain({
    headTimestampSec: Math.floor(Date.now() / 1000),
    tokenBalances: { [buyer.toLowerCase()]: 100_000_000n },
    ...options.chain,
  });
  const served = await serveFakeChain(chain, SECRET_PATH);
  closers.push(served.close);
  const config = {
    rails: { evm: { pin: BASE_SEPOLIA_PIN, endpoint: options.endpoint ?? served.url, contract: CONTRACT, assets: { USDC: TOKEN }, contractCodeHash: options.codeHash ?? FAKE_ESCROW_CODE_HASH } },
    buyerKeyFile: "keys/buyer.key",
    sellerKeyFile: "keys/seller.key",
    amount: "1000000",
    out: "bundle",
    ...options.configExtra,
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const scanners = keys.map((key) => keyScanner(key));
  return { dir, configPath, stateDir: join(dir, "state"), outDir: join(dir, "bundle"), buyer, seller, leaks: (text) => scanners.some((scan) => scan(text)), chain };
}

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(rig: Rig, mode: RehearsalMode = "dry", extra: { stopAfter?: "lock"; wait?: boolean } = {}): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const env: RehearsalEnv = {
    now: () => Date.now(),
    sleep: async () => undefined,
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
  };
  const code = await runRehearsal({ configPath: rig.configPath, mode, stateDir: rig.stateDir, env, ...extra });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const WRITES = ["eth_sendRawTransaction", "eth_sendTransaction"];

describe("the dry run (the default mode) against a fake read-only chain", () => {
  it("prints the table with both addresses, no key and no URL, writes nothing, sends nothing, exits 0", async () => {
    const rig = await makeRig();
    const result = await run(rig);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain(rig.buyer);
    expect(result.stdout).toContain(rig.seller);
    expect(result.stdout).toContain("RESULT: every check that is needed holds");
    expect(result.stdout).toMatch(/OK\s+chain id\s+84532 matches the pin base-sepolia/);
    expect(result.stdout).toMatch(/OK\s+escrow code\s+\d+ bytes, keccak 0x[0-9a-f]{64} is the pinned contractCodeHash/);
    expect(result.stdout).toMatch(/OK\s+log range\s+maxLogRange 500: the endpoint accepted 500 blocks and refused 501/);
    expect(result.stdout).toContain("Plan (nothing below has happened");
    expect(result.stdout).toContain("This was a dry run: no transaction was sent, no file was written.");
    // Not the endpoint: the host appears, the URL and its path never.
    expect(result.stdout).toContain("host 127.0.0.1:");
    expect(result.stdout).not.toContain("SECRETPATHKEYPART");
    expect(result.stdout).not.toContain("http://127.0.0.1");
    expect(rig.leaks(result.stdout) || rig.leaks(result.stderr)).toBe(false);
    // Nothing written (not even the state directory), nothing sent (reads only).
    expect(await exists(rig.stateDir)).toBe(false);
    expect(await exists(rig.outDir)).toBe(false);
    expect(rig.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);
    expect(rig.chain.methods).toContain("eth_getCode");
  });

  it("exits 3 and says nothing was sent when a check fails (a wrong code pin, a Buyer short of tokens, no finalized tag)", async () => {
    for (const [label, options, row] of [
      ["wrong code pin", { codeHash: `0x${"ab".repeat(32)}` }, /FAIL\s+escrow code/],
      ["short of tokens", { chain: { tokenBalances: {} } }, /FAIL\s+buyer token/],
      ["no finalized tag", { chain: { noFinalizedTag: true } }, /FAIL\s+finalized/],
    ] as const) {
      const rig = await makeRig(options);
      const result = await run(rig);
      expect(result.code, label).toBe(EXIT.preflight);
      expect(result.stdout, label).toMatch(row);
      expect(result.stdout, label).toContain("Nothing was sent. Fix the failed checks");
      expect(result.stdout, label).not.toContain("This was a dry run");
      expect(await exists(rig.stateDir), label).toBe(false);
      expect(rig.chain.methods.filter((m) => WRITES.includes(m)), label).toEqual([]);
      expect(rig.leaks(result.stdout), label).toBe(false);
    }
  });

  it("shows a key file that does not load as a failed row with the loader's own text (a path and a problem, no key)", async () => {
    const rig = await makeRig({ skipSellerKey: true });
    const result = await run(rig);
    expect(result.code).toBe(EXIT.preflight);
    expect(result.stdout).toMatch(/FAIL\s+seller account\s+evm key file .*seller\.key: no such file/);
    expect(result.stdout).toContain(rig.buyer); // the other account still shows
    expect(rig.leaks(result.stdout)).toBe(false);
  });

  it("refuses a state directory that already holds a run, and a bundle directory that is not empty", async () => {
    const rig = await makeRig();
    await mkdir(rig.stateDir, { recursive: true });
    await writeFile(join(rig.stateDir, "run.json"), "{}");
    await mkdir(rig.outDir);
    await writeFile(join(rig.outDir, "old.txt"), "x");
    // The run file is not one this build reads: the dry run refuses it by name instead of ignoring it.
    const unreadable = await run(rig);
    expect(unreadable.code).toBe(EXIT.config);
    expect(unreadable.stderr).toContain("is not a run record this build reads");
    await rm(join(rig.stateDir, "run.json"));
    const full = await run(rig);
    expect(full.code).toBe(EXIT.preflight);
    expect(full.stdout).toMatch(/FAIL\s+bundle directory\s+.*is not empty/);
  });
});

describe("the other modes refuse without a run, and --yes refuses on a failed pre-flight", () => {
  it("--yes with a failed pre-flight sends nothing, creates no run and says why", async () => {
    const rig = await makeRig({ codeHash: `0x${"cd".repeat(32)}` });
    const result = await run(rig, "yes");
    expect(result.code).toBe(EXIT.preflight);
    expect(result.stdout).toContain("--yes refuses to broadcast unless every needed check holds");
    expect(await exists(join(rig.stateDir, "run.json"))).toBe(false);
    expect(await exists(rig.outDir)).toBe(false);
    expect(rig.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);
    // The runner lock it took is gone again.
    expect(await exists(join(rig.stateDir, "runner.lock"))).toBe(false);
  });

  it.each([["resume", "resume"], ["refund", "refund"]] as const)("--%s in a state directory with no run exits 4 and sends nothing", async (mode, verb) => {
    const rig = await makeRig();
    const result = await run(rig, mode);
    expect(result.code).toBe(EXIT.refused);
    expect(result.stderr).toContain(`there is nothing to ${verb} here`);
    expect(rig.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);
    expect(await exists(join(rig.stateDir, "run.json"))).toBe(false);
  });
});

/** A valid run record for `rig` (what a --yes run would have written), so --resume and --refund get past their first look at the state directory. */
async function writeRun(rig: Rig, overrides: Record<string, unknown> = {}, withIdentities = false): Promise<void> {
  const t0 = Date.now() - 4 * 60 * 60_000; // four hours ago: every deadline of the known-good set has passed
  const dids = withIdentities
    ? {
        buyerDid: (await loadOrCreateIdentity(join(rig.stateDir, "buyer", "ed25519.seed"))).did,
        sellerDid: (await loadOrCreateIdentity(join(rig.stateDir, "seller", "ed25519.seed"))).did,
      }
    : { buyerDid: "did:key:z6Mkbuyer", sellerDid: "did:key:z6Mkseller" };
  const run = {
    v: 1,
    swapId: `0x${"11".repeat(32)}`,
    nonce: "0123456789abcdef",
    t0Ms: t0,
    lockTimeMs: t0 + 600_000,
    chainId: 84532,
    contract: CONTRACT,
    asset: "USDC",
    amount: "1000000",
    flopAmount: "52070000",
    deadlines: {
      legA: { claimByMs: t0 + 3_600_000, refundAfterMs: t0 + 5_400_000, expiresMs: t0 + 1_800_000 },
      legB: { claimByMs: t0 + 7_200_000, refundAfterMs: t0 + 10_800_000, expiresMs: t0 + 2_400_000 },
    },
    stopAfter: null,
    ...dids,
    buyerAccount: rig.buyer.toLowerCase(),
    sellerAccount: rig.seller.toLowerCase(),
    ...overrides,
  };
  await mkdir(rig.stateDir, { recursive: true });
  await writeFile(join(rig.stateDir, "run.json"), JSON.stringify(run));
}

describe("--resume and --refund look at the run before they touch anything", () => {
  it("refuse key files that name other accounts than the run started with, before any seed or record is written", async () => {
    const rig = await makeRig();
    await writeRun(rig, { sellerAccount: `0x${"22".repeat(20)}` });
    for (const mode of ["resume", "refund"] as const) {
      const result = await run(rig, mode);
      expect(result.code, mode).toBe(EXIT.refused);
      expect(result.stderr, mode).toContain("the key files now name other accounts than the ones this run started with");
    }
    expect((await readdir(rig.stateDir)).sort()).toEqual(["run.json"]); // no seed, no flow directory, no lock left
    expect(rig.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);
  });

  it("refuse a config that is no longer the run's (another amount, another escrow, another chain)", async () => {
    const rig = await makeRig();
    await writeRun(rig, { amount: "2000000" });
    const result = await run(rig, "resume");
    expect(result.code).toBe(EXIT.refused);
    expect(result.stderr).toContain("the config no longer matches this run: the run's amount is not the config's amount");
    await writeRun(rig, { contract: "0x00000000000000000000000000000000000000a1" });
    expect((await run(rig, "refund")).stderr).toContain("another escrow contract");
    await writeRun(rig, { chainId: 31337 });
    expect((await run(rig, "resume")).stderr).toContain("the run was started on chain 31337, the config pins 84532");
  });

  it("let a refund go ahead when only the rows a refund does not use fail (shown as warnings), and stop a resume on the same chain", async () => {
    const chainOptions: FakeChainOptions = { pending: "error", logCap: 100, ethBalances: {} };
    const rig = await makeRig({ chain: chainOptions });
    await writeRun(rig, {}, true);
    // A seller with no ETH is also fine for a refund: leg B refunds on paper.
    rig.chain.handlers.eth_getBalance = (params) => ({ result: String(params[0]).toLowerCase() === rig.seller.toLowerCase() ? "0x0" : "0xde0b6b3a7640000" });

    const refund = await run(rig, "refund");
    expect(refund.stdout).toMatch(/WARN\s+pending\s+\(not needed for this mode\)/);
    expect(refund.stdout).toMatch(/WARN\s+log range\s+\(not needed for this mode\)/);
    expect(refund.stdout).toMatch(/WARN\s+seller ETH\s+\(not needed for this mode\)/);
    expect(refund.stdout).not.toContain("a check it needs failed");
    expect(refund.code).toBe(EXIT.refused); // past the pre-flight, it stops at the Buyer's empty store: nothing to refund
    expect(refund.stderr).toContain("holds no record");

    const resume = await run(rig, "resume");
    expect(resume.code).toBe(EXIT.preflight);
    expect(resume.stdout).toMatch(/FAIL\s+pending/);
    expect(resume.stdout).toContain("--resume did nothing because a check it needs failed");
  });
});

describe("bad configs and a failing endpoint", () => {
  it("exits 2 on a config it refuses, naming the field and never echoing a pasted key", async () => {
    const key = generatePrivateKey();
    const rig = await makeRig({ configExtra: { buyerPrivateKey: key } });
    const result = await run(rig);
    expect(result.code).toBe(EXIT.config);
    expect(result.stderr).toContain("buyerPrivateKey is not a field this runner knows");
    expect(result.stdout).toBe("");
    expect(keyScanner(key)(result.stderr)).toBe(false);
    expect(rig.chain.methods).toEqual([]); // the endpoint was never touched
  });

  it("exits 2 on a config file that is missing", async () => {
    const rig = await makeRig();
    const out: string[] = [];
    const code = await runRehearsal({ configPath: join(rig.dir, "missing.json"), mode: "dry", stateDir: rig.stateDir, env: { now: () => Date.now(), sleep: async () => undefined, out: () => undefined, err: (l) => void out.push(l) } });
    expect(code).toBe(EXIT.config);
    expect(out.join("\n")).toContain("cannot read the config file");
  });

  it("never prints an endpoint that a transport error names", async () => {
    // A node that declares an enormous reply: CapturingRpc refuses it with a message that names its endpoint (path and all).
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": String(64 * 1024 * 1024) });
      response.write("x");
      setTimeout(() => response.destroy(), 200);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}${SECRET_PATH}`;
    const rig = await makeRig({ endpoint });
    const result = await run(rig);
    expect(result.code).toBe(EXIT.preflight);
    expect(result.stdout).toContain("<rpc endpoint>");
    expect(result.stdout).not.toContain("SECRETPATHKEYPART");
    expect(result.stderr).not.toContain("SECRETPATHKEYPART");
    expect(result.stdout).toMatch(/FAIL\s+chain id\s+eth_chainId failed/);
  });
});

describe("parseRunRecord", () => {
  const good = {
    v: 1,
    swapId: `0x${"11".repeat(32)}`,
    nonce: "0123456789abcdef",
    t0Ms: 1_790_000_000_000,
    lockTimeMs: 1_790_000_600_000,
    chainId: 84532,
    contract: CONTRACT,
    asset: "USDC",
    amount: "1000000",
    flopAmount: "52070000",
    deadlines: {
      legA: { claimByMs: 1_790_003_600_000, refundAfterMs: 1_790_005_400_000, expiresMs: 1_790_001_800_000 },
      legB: { claimByMs: 1_790_007_200_000, refundAfterMs: 1_790_010_800_000, expiresMs: 1_790_002_400_000 },
    },
    stopAfter: null,
    buyerDid: "did:key:z6Mkbuyer",
    sellerDid: "did:key:z6Mkseller",
    buyerAccount: `0x${"b1".repeat(20)}`,
    sellerAccount: `0x${"5e".repeat(20)}`,
  };

  it("reads a record this build writes, and refuses anything else, by what is wrong and never by content", () => {
    expect(parseRunRecord(JSON.stringify(good), "p")).toEqual(good);
    expect(parseRunRecord(JSON.stringify({ ...good, stopAfter: "lock" }), "p").stopAfter).toBe("lock");
    const bad = (value: unknown): string => {
      try {
        parseRunRecord(typeof value === "string" ? value : JSON.stringify(value), "p");
      } catch (error) {
        return (error as Error).message;
      }
      return "accepted";
    };
    expect(bad("{ nope")).toContain("is not valid JSON");
    expect(bad([])).toContain("not an object");
    expect(bad({ ...good, extra: "0x" })).toContain("its fields are not the known ones");
    const { stopAfter: _s, ...missing } = good;
    expect(bad(missing)).toContain("its fields are not the known ones");
    expect(bad({ ...good, v: 2 })).toContain("version");
    expect(bad({ ...good, swapId: "0x12" })).toContain("swapId");
    expect(bad({ ...good, nonce: "XYZ" })).toContain("nonce");
    expect(bad({ ...good, t0Ms: 1.5 })).toContain("times");
    expect(bad({ ...good, chainId: 0 })).toContain("chainId");
    expect(bad({ ...good, contract: "0x12" })).toContain("contract");
    expect(bad({ ...good, asset: "a b" })).toContain("asset");
    expect(bad({ ...good, amount: "01" })).toContain("amount");
    expect(bad({ ...good, flopAmount: "0" })).toContain("flopAmount");
    expect(bad({ ...good, deadlines: { legA: good.deadlines.legA } })).toContain("deadlines");
    expect(bad({ ...good, deadlines: { ...good.deadlines, legB: { ...good.deadlines.legB, extra: 1 } } })).toContain("deadlines");
    expect(bad({ ...good, stopAfter: "bid" })).toContain("stopAfter");
    expect(bad({ ...good, buyerDid: 7 })).toContain("DIDs");
    expect(bad({ ...good, buyerAccount: "0xABC" })).toContain("buyerAccount");
    expect(bad({ ...good, sellerAccount: good.sellerAccount.toUpperCase().replace("0X", "0x") })).toContain("sellerAccount");
  });
});

interface BinResult {
  code: number;
  stdout: string;
  stderr: string;
}

function bin(args: string[]): Promise<BinResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("bin/swap-rehearsal-evm.mjs (needs a build: npm test builds first)", () => {
  beforeAll(async () => {
    await access(join(REPO_ROOT, "dist", "client", "rehearsal-run.js")).catch(() => {
      throw new Error("dist/client/rehearsal-run.js is missing: run npm run build");
    });
  });

  it("prints its usage for --help (exit 0) and for a bad command line (exit 2)", async () => {
    const help = await bin(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: node bin/swap-rehearsal-evm.mjs <config.json>");
    expect(help.stdout).toContain("DRY RUN");
    for (const args of [
      [],
      ["a.json", "b.json"],
      ["a.json", "--yes", "--resume"],
      ["a.json", "--refund", "--yes"],
      ["a.json", "--stop-after", "lock"],
      ["a.json", "--yes", "--stop-after", "soon"],
      ["a.json", "--yes", "--stop-after"],
      ["a.json", "--wait"],
      ["a.json", "--resume", "--wait"],
      ["a.json", "--state-dir"],
      ["a.json", "--bogus"],
    ]) {
      const result = await bin(args);
      expect(result.code, args.join(" ")).toBe(EXIT.config);
      expect(result.stderr, args.join(" ")).toContain("Usage: node bin/swap-rehearsal-evm.mjs");
    }
  });

  it("exits 2 on a config that is missing, naming the file", async () => {
    const result = await bin([join(tmpdir(), "no-such-rehearsal-config.json")]);
    expect(result.code).toBe(EXIT.config);
    expect(result.stderr).toContain("cannot read the config file");
  });

  it("runs the dry run end to end through the command line against the fake chain: exit 0, a table, no key, no write", async () => {
    const rig = await makeRig();
    const result = await bin([rig.configPath, "--state-dir", rig.stateDir]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(rig.buyer);
    expect(result.stdout).toContain(rig.seller);
    expect(result.stdout).toContain("RESULT: every check that is needed holds");
    expect(rig.leaks(result.stdout)).toBe(false);
    expect(await exists(rig.stateDir)).toBe(false);
    expect(await readdir(rig.dir)).toEqual(["config.json", "keys"]);
    expect(rig.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);
  });

  it("exits 3 through the command line when a check fails, and the failed pre-flight leaves the directory as it was", async () => {
    const rig = await makeRig({ codeHash: `0x${"ef".repeat(32)}` });
    const before = await readFile(rig.configPath, "utf8");
    const result = await bin([rig.configPath, "--state-dir", rig.stateDir, "--yes"]);
    expect(result.code).toBe(EXIT.preflight);
    expect(result.stdout).toContain("--yes refuses to broadcast");
    expect(await exists(join(rig.stateDir, "run.json"))).toBe(false);
    expect(await readFile(rig.configPath, "utf8")).toBe(before);
  });
});
