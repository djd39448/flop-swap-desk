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
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buyerLockOnRecord, EXIT, FLOW_MESSAGE, loadRunnerAccount, parseRunRecord, refundTimeReached, runRehearsal, untilRefundTime, waitLockFinal, type FinalityWorld, type RehearsalEnv, type RehearsalMode } from "../src/client/rehearsal-run.js";
import { encodeFlowRecord, newBuyerRecord } from "../src/client/flow-record.js";
import { FileFlowStore, flowKey } from "../src/client/flow-store.js";
import { parseRehearsalConfig } from "../src/client/rehearsal-config.js";
import { loadOrCreateIdentity } from "../src/client/rehearsal-world.js";
import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
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
  /** F3 (P9 review round 1): Base Sepolia still runs under the anvil policy, so a NEW swap on it is refused until P9-4. The rigs that want every row of a healthy
   *  dry run use the anvil pin (31337) on the same fake chain, with maxLogRange 500 so the log rows read the same. */
  anvil?: boolean;
  /** With `anvil`: the config's maxLogRange (default 500). */
  maxLogRange?: number;
  chain?: FakeChainOptions;
  codeHash?: string;
  skipSellerKey?: boolean;
  configExtra?: Record<string, unknown>;
  /** Fields merged into `rails.evm` after the rig's own (KR2-1: an `assets` book with another name in it). */
  evmExtra?: Record<string, unknown>;
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
    ...(options.anvil === true ? { chainId: 31337 } : {}),
    ...options.chain,
  });
  const served = await serveFakeChain(chain, SECRET_PATH);
  closers.push(served.close);
  const config = {
    rails: {
      evm: {
        pin: options.anvil === true ? ANVIL_LOCAL_PIN : BASE_SEPOLIA_PIN,
        endpoint: options.endpoint ?? served.url,
        contract: CONTRACT,
        assets: { USDC: TOKEN },
        contractCodeHash: options.codeHash ?? FAKE_ESCROW_CODE_HASH,
        ...(options.anvil === true ? { maxLogRange: options.maxLogRange ?? 500 } : {}),
        ...options.evmExtra,
      },
    },
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
    const rig = await makeRig({ anvil: true });
    const result = await run(rig);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain(rig.buyer);
    expect(result.stdout).toContain(rig.seller);
    expect(result.stdout).toContain("RESULT: every check that is needed holds");
    expect(result.stdout).toMatch(/OK\s+chain id\s+31337 matches the pin anvil-local/);
    expect(result.stdout).toMatch(/OK\s+escrow code\s+\d+ bytes, keccak 0x[0-9a-f]{64} is the pinned contractCodeHash/);
    expect(result.stdout).toMatch(/OK\s+log range\s+maxLogRange 500: the endpoint accepted 500 blocks and refused 501/);
    // F1: the scans' reach (100 calls of 500 blocks) is set against leg A's window at the block time measured from the chain (2 s here).
    expect(result.stdout).toMatch(/OK\s+log scan reach\s+100 calls of maxLogRange 500 read 50000 blocks above a marker .*; leg A's window needs \d+ blocks .* at 2\.0 s a block, plus 256 of marker margin\): it fits/);
    expect(result.stdout).toContain("Plan (nothing below has happened");
    expect(result.stdout).toContain("This was a dry run: no transaction was sent, no file was written.");
    // Not the endpoint: the host appears, the URL and its path never.
    expect(result.stdout).toContain("host 127.0.0.1:");
    expect(result.stdout).not.toContain("SECRETPATHKEYPART");
    expect(result.stdout).not.toContain("http://127.0.0.1");
    expect(rig.leaks(result.stdout) || rig.leaks(result.stderr)).toBe(false);
    // K1: no configured key-file path is printed anywhere, not even for a key file that loads (the plan names the accounts, not the files).
    expect(result.stdout + result.stderr).not.toMatch(/buyer\.key|seller\.key/);
    // Nothing written (not even the state directory), nothing sent (reads only).
    expect(await exists(rig.stateDir)).toBe(false);
    expect(await exists(rig.outDir)).toBe(false);
    expect(rig.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);
    expect(rig.chain.methods).toContain("eth_getCode");
  });

  // F3 with R1-FUND-06 (P9 review round 1): Base Sepolia still runs under the anvil deadline policy, so a NEW swap there is refused until P9-4.
  it("a dry run on Base Sepolia (chain 84532) with the known-good deadlines exits 3 on the deadlines row, and --yes refuses; --refund is not blocked by it (F3)", async () => {
    const dry = await makeRig();
    const result = await run(dry);
    expect(result.code).toBe(EXIT.preflight);
    expect(result.stdout).toMatch(/FAIL\s+deadlines\s+no Base Sepolia policy yet \(P9-4\)/);
    expect(result.stdout).toContain("Nothing was sent. Fix the failed checks");
    expect(result.stdout).not.toContain("This was a dry run");
    expect(result.stdout).toMatch(/OK\s+chain id\s+84532 matches the pin base-sepolia/); // everything else about the chain is fine
    expect(result.stdout.match(/^ {2}FAIL {2}\S+/gm)).toEqual(["  FAIL  deadlines"]); // the deadlines row is the only failure

    const yes = await makeRig();
    const refused = await run(yes, "yes");
    expect(refused.code).toBe(EXIT.preflight);
    expect(refused.stdout).toContain("--yes refuses to broadcast unless every needed check holds");
    expect(refused.stdout).toMatch(/FAIL\s+deadlines\s+no Base Sepolia policy yet/);
    expect(await exists(join(yes.stateDir, "run.json"))).toBe(false);
    expect(yes.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);

    // --refund (of a swap already begun) never reads the row: it is a fresh-run check.
    const refund = await makeRig();
    await writeRun(refund, {}, true);
    const refunded = await run(refund, "refund");
    expect(refunded.stdout).not.toContain("no Base Sepolia policy yet");
    expect(refunded.stdout).not.toMatch(/deadlines/);
    expect(refunded.stdout).not.toContain("a check it needs failed");
    expect(refunded.code).toBe(EXIT.refused); // past the pre-flight, it stops at the Buyer's empty store: nothing to refund
    expect(refunded.stderr).toContain("holds no record");
  });

  // F1 runner part (P9 review round 1): 100 calls of maxLogRange blocks must reach as far as leg A's window is long, or a late claim cannot be found.
  it("a dry run with a cap of 300 and a 26-hour leg A window at 2-second blocks exits 3 on the log scan reach row, printing both numbers; at 500 the same window passes (F1)", async () => {
    const deadlines = {
      legA: { claimByMin: 1500, refundAfterMin: 1570, expiresMin: 30 }, // the lock is expected 10 minutes in: the window is 26 hours
      legB: { claimByMin: 3000, refundAfterMin: 6000, expiresMin: 40 },
    };
    const low = await makeRig({ anvil: true, maxLogRange: 300, chain: { logCap: 300 }, configExtra: { deadlines } });
    const refused = await run(low);
    expect(refused.code).toBe(EXIT.preflight);
    expect(refused.stdout.match(/^ {2}FAIL {2}.{1,20}?(?= {2})/gm)).toEqual(["  FAIL  log scan reach"]); // the only failure
    expect(refused.stdout).toMatch(/FAIL\s+log scan reach\s+100 calls of maxLogRange 300 read 30000 blocks above a marker .*; leg A's window needs 47056 blocks \(1560\.0 min from the lock to the refund time at 2\.0 s a block, plus 256 of marker margin\)/);
    expect(refused.stdout).toContain("raise maxLogRange (to at least 471) if the endpoint allows it, or shorten leg A's window");
    expect(refused.stdout).toContain("Nothing was sent. Fix the failed checks");
    const wide = await makeRig({ anvil: true, maxLogRange: 500, chain: { logCap: 500 }, configExtra: { deadlines } });
    const passed = await run(wide);
    expect(passed.code).toBe(EXIT.ok);
    expect(passed.stdout).toMatch(/OK\s+log scan reach\s+100 calls of maxLogRange 500 read 50000 blocks above a marker .*needs 47056 blocks/);
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

  it("shows a key file that does not load as a failed row with the field and the problem (no path, no key)", async () => {
    const rig = await makeRig({ skipSellerKey: true });
    const result = await run(rig);
    expect(result.code).toBe(EXIT.preflight);
    // K1: the row names the field and the problem, never the configured path (nor the loader's own text, which carries it).
    expect(result.stdout).toMatch(/FAIL\s+seller account\s+sellerKeyFile: no such file\n/);
    expect(result.stdout).not.toContain("seller.key");
    expect(result.stdout).not.toContain("evm key file");
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
    // A seller with no ETH is also fine for a refund: leg B refunds on paper. The Buyer holds what is left after the approve and the lock (R1-FUND-01:
    // the dry run's need, 1.44e12 wei at the fake chain's gas price, less the 258,000 gas they spent), not a whole ETH.
    const left = 1_182_000_000_000n;
    rig.chain.handlers.eth_getBalance = (params) => ({ result: String(params[0]).toLowerCase() === rig.seller.toLowerCase() ? "0x0" : `0x${left.toString(16)}` });

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

// K1 (P9 review round 1, critical by the rubric): a private key an operator pastes into a key-file field with one slip used to be printed back by
// the pre-flight ("FAIL buyer account evm key file <dir>\0x<63 hex>: no such file", 63 of 64 digits, in every mode). Two defences are pinned: the
// config refuses any run of 32 or more hex digits (and any phrase of 11 or more words), and the runner never prints a configured key-file path
// whatever the value is. Every key here is generated now and only ever scanned for (keyScanner answers a boolean).
describe("K1: a key pasted into a key-file field is never printed back", () => {
  /** The pasted key, and the values an operator could have typed for it: one slip (the config refuses these) and two or more (it cannot see these). */
  function pastedForms(): { key: `0x${string}`; oneSlip: Array<[string, string]>; manySlips: Array<[string, string]> } {
    const key = generatePrivateKey();
    return {
      key,
      oneSlip: [
        ["63 hex digits", key.slice(0, -1)],
        ["a space after digit 32", `${key.slice(0, 34)} ${key.slice(34)}`],
        ["a newline after digit 32", `${key.slice(0, 34)}\n${key.slice(34)}`],
        ["a letter O for a zero", `${key.slice(0, 30)}O${key.slice(31)}`],
      ],
      // No unbroken run of 32 digits: the config's guard cannot know these hold a key, so only the runner's own rule keeps them off the screen.
      manySlips: [
        ["runs of 20 digits split by spaces", `${key.slice(0, 22)} ${key.slice(22, 42)} ${key.slice(42)}`],
        ["runs of 20 digits split by newlines", `${key.slice(0, 22)}\n${key.slice(22, 42)}\n${key.slice(42)}`],
        ["runs of 17 digits split by dots", key.slice(2).replace(/(.{17})/g, "$1.")],
      ],
    };
  }

  it("the four near-miss forms (a dropped digit, a space, a newline, an O for a zero) are refused by the config in a dry run: exit 2, by field name, nothing printed", async () => {
    const { key, oneSlip } = pastedForms();
    const scan = keyScanner(key);
    for (const [label, value] of oneSlip) {
      const rig = await makeRig({ configExtra: { buyerKeyFile: value } });
      const result = await run(rig);
      expect(result.code, label).toBe(EXIT.config);
      expect(result.stderr, label).toContain("buyerKeyFile looks like key material");
      expect(result.stdout, label).toBe("");
      expect(scan(result.stdout) || scan(result.stderr), `${label}: no window of the pasted key may reach out or err`).toBe(false);
      expect(rig.chain.methods, label).toEqual([]); // refused before the endpoint was touched
    }
  });

  it("a key broken into runs the config cannot see is still never printed: dry run, --yes, --resume and --refund all say 'buyerKeyFile: <problem>' and nothing else", async () => {
    const { key, manySlips } = pastedForms();
    const scan = keyScanner(key);
    for (const [label, value] of manySlips) {
      expect(scan(value), `${label}: the value must hold windows of the key, or this test proves nothing`).toBe(true);
      for (const mode of ["dry", "yes", "resume", "refund"] as const) {
        const rig = await makeRig({ configExtra: { buyerKeyFile: value } });
        if (mode === "resume" || mode === "refund") await writeRun(rig, {}, true);
        const result = await run(rig, mode);
        const where = `${label}, ${mode}`;
        expect(result.code, where).toBe(EXIT.preflight);
        expect(result.stdout, where).toMatch(/FAIL\s+buyer account\s+buyerKeyFile: (no such file|the file cannot be read)\n/);
        expect(result.stdout, where).toContain("Nothing was sent");
        expect(result.stdout, where).not.toContain("evm key file");
        expect(scan(result.stdout) || scan(result.stderr), `${where}: no window of the pasted key may reach out or err`).toBe(false);
        expect(result.stdout, where).toContain(rig.seller); // the other account still shows
        expect(rig.chain.methods.filter((m) => WRITES.includes(m)), where).toEqual([]);
      }
    }
  });

  it("every refusal of a key file is '<field>: <fixed sentence>': no path, no content, whatever the file holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rh-keyfile-"));
    dirs.push(dir);
    const pasted = generatePrivateKey();
    const scan = keyScanner(pasted);
    const sentence = async (name: string, content: string | null): Promise<string> => {
      const path = join(dir, name);
      if (content !== null) await writeFile(path, content, { mode: 0o600 });
      const loaded = await loadRunnerAccount(path, "sellerKeyFile", () => undefined);
      if (!("problem" in loaded)) throw new Error(`${name}: the key file loaded`);
      expect(loaded.problem, name).not.toContain(dir);
      expect(loaded.problem, name).not.toContain(name);
      expect(scan(loaded.problem), name).toBe(false);
      return loaded.problem;
    };
    // The file name carries the pasted key's digits: the case K1 is about (a key typed where a path belongs).
    expect(await sentence(pasted.slice(2, 22), null)).toBe("sellerKeyFile: no such file");
    expect(await sentence("empty.key", "")).toBe("sellerKeyFile: the file is empty");
    expect(await sentence("phrase.key", "legal winner thank year wave sausage worth useful legal winner thank yellow\n")).toContain("sellerKeyFile: the key line contains whitespace");
    expect(await sentence("short.key", `${pasted.slice(0, -1)}\n`)).toBe("sellerKeyFile: the key is not 0x followed by exactly 64 hex characters");
    expect(await sentence("zero.key", `0x${"00".repeat(32)}\n`)).toBe("sellerKeyFile: the 32 bytes are not a valid secp256k1 private key");
    await mkdir(join(dir, "dir.key"));
    expect(await sentence("dir.key", null)).toBe("sellerKeyFile: the path is not a regular file (a directory or other special file)");
  });

  it("loads a good key file (no problem, the address) and shows the loader's group-or-other warning by field name, never with the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rh-keyfile-"));
    dirs.push(dir);
    const key = generatePrivateKey();
    const path = join(dir, "open.key");
    await writeFile(path, `${key}\n`, { mode: 0o644 });
    await chmod(path, 0o644); // whatever the umask was (a no-op on Windows, where the loader's mode check is skipped by its own rule)
    const lines: string[] = [];
    const loaded = await loadRunnerAccount(path, "buyerKeyFile", (line) => void lines.push(line), "linux");
    if (!("account" in loaded)) throw new Error("the key file did not load");
    expect(loaded.account.address).toBe(privateKeyToAccount(key).address);
    expect(lines).toEqual(["buyerKeyFile: the key file can be read by group or other users; run chmod 600 on it (the key was loaded anyway)"]);
    expect(lines.join("\n")).not.toContain(dir);
    // On Windows the mode bits mean nothing and there is never a warning.
    const quiet: string[] = [];
    expect("account" in (await loadRunnerAccount(path, "buyerKeyFile", (line) => void quiet.push(line), "win32"))).toBe(true);
    expect(quiet).toEqual([]);
  });
});

// K2 (P9 review round 1, critical by the rubric): the same 0x + 64 hex shape as a key made a key pasted into contractCodeHash pass the config and
// print whole in the escrow-code row of the dry run. The pinned value is now shown as its first 10 characters only.
describe("K2: a key pasted into contractCodeHash is never printed back", () => {
  it("a dry run (and --yes) against a chain whose escrow does not hash to it fails the row without a single window of it", async () => {
    for (const mode of ["dry", "yes"] as const) {
      const pasted = generatePrivateKey();
      const scan = keyScanner(pasted);
      const rig = await makeRig({ codeHash: pasted });
      const result = await run(rig, mode);
      expect(result.code, mode).toBe(EXIT.preflight);
      expect(result.stdout, mode).toMatch(/FAIL\s+escrow code\s+the \d+ bytes of code at 0x[0-9a-fA-F]{40} hash to 0x[0-9a-f]{64}, not the pinned contractCodeHash 0x[0-9a-f]{8}\.\.\.\n/);
      expect(result.stdout, mode).toContain(FAKE_ESCROW_CODE_HASH.toLowerCase()); // the observed hash (public code) is printed in full
      expect(scan(result.stdout) || scan(result.stderr), `${mode}: no window of the pasted key may reach out or err`).toBe(false);
      expect(result.stdout, mode).not.toContain(pasted);
      expect(rig.chain.methods.filter((m) => WRITES.includes(m)), mode).toEqual([]);
    }
  });

  it("the empty-code and unreadable-code rows do not print it either", async () => {
    for (const code of ["0x", "error"] as const) {
      const pasted = generatePrivateKey();
      const scan = keyScanner(pasted);
      const rig = await makeRig({ codeHash: pasted, chain: { code } });
      const result = await run(rig);
      expect(result.code, code).toBe(EXIT.preflight);
      expect(result.stdout, code).toMatch(/FAIL\s+escrow code/);
      expect(scan(result.stdout) || scan(result.stderr), code).toBe(false);
    }
  });
});

// KR2-1 (P9 review round 2, critical by the rubric): the key-echo class of K1 and K2 was still open for five more places a key can be pasted into by
// the same clipboard mix-up: `out` (a dry run exited 0 and printed it twice), --state-dir, the config path, a `rails.evm.assets` name (quoted by the
// rail's refusal, or silently carried into the bundle's rails.json when its value is an address) and the endpoint's host. Every one is now refused by
// field or argument name, with exit 2, before the chain is touched, and nothing is written. Every key here is generated now and only ever scanned
// for (keyScanner answers a boolean); a failing assertion names a mode and a field and never a byte of a key.
describe("KR2-1: a key pasted into out, --state-dir, the config path, an asset name or the endpoint host is never printed back", () => {
  /** Labels (never names or contents) of the places under `dir` whose NAME or CONTENT holds a window of the key; the config file the test itself wrote (it
   *  holds the pasted value, as the operator's file would) is the one thing not read. */
  async function placesWith(dir: string, scan: (text: string) => boolean, input: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (at: string): Promise<void> => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (scan(entry.name)) found.push(`a name of kind ${entry.isDirectory() ? "directory" : "file"}`);
        if (entry.isDirectory()) await walk(path);
        else if (path !== input && scan(await readFile(path, "latin1"))) found.push(`the content of a file ${relative(dir, path).split(/[\\/]/).length} deep`);
      }
    };
    await walk(dir);
    return found;
  }

  /** What every case must show: exit 2, the named field or argument, nothing on stdout, no window of the key anywhere, the endpoint never touched. */
  async function expectRefused(rig: Rig, result: Outcome, scan: (text: string) => boolean, named: string, where: string): Promise<void> {
    expect(result.code, where).toBe(EXIT.config);
    expect(result.stderr, where).toContain(named);
    expect(result.stdout, where).toBe("");
    expect(scan(result.stdout) || scan(result.stderr), `${where}: no window of the pasted key may reach out or err`).toBe(false);
    expect(await placesWith(rig.dir, scan, rig.configPath), `${where}: nothing the run wrote may hold a window of the key`).toEqual([]);
    expect(rig.chain.methods, where).toEqual([]); // refused before the endpoint was touched
    expect(await exists(rig.outDir), where).toBe(false);
  }

  async function runWith(rig: Rig, mode: RehearsalMode, over: { configPath?: string; stateDir?: string }): Promise<Outcome> {
    const out: string[] = [];
    const err: string[] = [];
    const env: RehearsalEnv = { now: () => Date.now(), sleep: async () => undefined, out: (line) => void out.push(line), err: (line) => void err.push(line) };
    const code = await runRehearsal({ configPath: over.configPath ?? rig.configPath, mode, stateDir: over.stateDir ?? rig.stateDir, env });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  }

  it("out: the bundle directory is refused by field name in a dry run and in --yes (a dry run used to exit 0 and print it twice)", async () => {
    for (const mode of ["dry", "yes"] as const) {
      const key = generatePrivateKey();
      const scan = keyScanner(key);
      const rig = await makeRig({ anvil: true, configExtra: { out: key } });
      const result = await run(rig, mode);
      await expectRefused(rig, result, scan, "out looks like key material", `out, ${mode}`);
      expect(await exists(rig.stateDir), `out, ${mode}`).toBe(false);
    }
  });

  it("out: one slip, a path that ends in the key, and a phrase are refused too", async () => {
    const key = generatePrivateKey();
    const scan = keyScanner(key);
    for (const [label, value] of [
      ["63 digits", key.slice(0, -1)],
      ["a space inside", `${key.slice(0, 34)} ${key.slice(34)}`],
      ["a directory path ending in the key", `/home/someone/bundles/${key}`],
      ["a 12-word phrase", "legal winner thank year wave sausage worth useful legal winner thank yellow"],
    ] as const) {
      const rig = await makeRig({ anvil: true, configExtra: { out: value } });
      await expectRefused(rig, await run(rig), scan, "out looks like key material", `out (${label})`);
    }
  });

  it("--state-dir: refused by argument name in a dry run, --yes, --resume and --refund, before anything is read or created", async () => {
    for (const mode of ["dry", "yes", "resume", "refund"] as const) {
      const key = generatePrivateKey();
      const scan = keyScanner(key);
      const rig = await makeRig({ anvil: true });
      const stateDir = join(rig.dir, key);
      const result = await runWith(rig, mode, { stateDir });
      await expectRefused(rig, result, scan, "--state-dir looks like key material", `--state-dir, ${mode}`);
      expect(await exists(stateDir), `--state-dir, ${mode}`).toBe(false);
    }
  });

  it("the config path: refused by argument name, whether the key is the whole path or a directory in it", async () => {
    const key = generatePrivateKey();
    const scan = keyScanner(key);
    const rig = await makeRig({ anvil: true });
    for (const [label, configPath] of [
      ["the key itself", key],
      ["a directory named by the key", join(rig.dir, key, "config.json")],
    ] as const) {
      const result = await runWith(rig, "dry", { configPath });
      await expectRefused(rig, result, scan, "the config path looks like key material", `config path (${label})`);
    }
  });

  it("a rails.evm.assets name: refused by field name whether its value is not an address (the rail used to quote it) or IS one (it used to ride into rails.json)", async () => {
    for (const mode of ["dry", "yes"] as const) {
      for (const [label, value] of [
        ["a value that is not an address", "not-an-address"],
        ["an address", "0x00000000000000000000000000000000000000a1"],
      ] as const) {
        const key = generatePrivateKey();
        const scan = keyScanner(key);
        const rig = await makeRig({ anvil: true, evmExtra: { assets: { USDC: TOKEN, [key]: value } } });
        const result = await run(rig, mode);
        await expectRefused(rig, result, scan, "rails.evm.assets: the name at position 2 is not a short plain name", `assets name (${label}), ${mode}`);
        expect(await exists(rig.stateDir), `assets name (${label}), ${mode}`).toBe(false);
      }
    }
    // 32 hex digits are a plain-looking name by length, and still key material.
    const half = generatePrivateKey().slice(2, 34);
    const rig = await makeRig({ anvil: true, evmExtra: { assets: { USDC: TOKEN, [half]: "0x00000000000000000000000000000000000000a1" } } });
    const result = await run(rig);
    expect(result.code).toBe(EXIT.config);
    expect(result.stderr).toContain("rails.evm.assets: the name at position 2");
    expect(result.stderr).not.toContain(half);
  });

  it("the endpoint's host: refused by field name (it is printed on every run and a transport error names it)", async () => {
    for (const mode of ["dry", "yes"] as const) {
      const key = generatePrivateKey();
      const scan = keyScanner(key);
      const rig = await makeRig({ anvil: true, endpoint: `http://${key}.invalid/v2/x` });
      const result = await run(rig, mode);
      await expectRefused(rig, result, scan, "rails.evm.endpoint's host looks like key material", `endpoint host, ${mode}`);
    }
  });

  it("ordinary values are not refused: a UUID in a path, a short hex name, a long English path (no false positive on what a person really types)", async () => {
    const rig = await makeRig({
      anvil: true,
      configExtra: { out: "bundles/97811a09-a70d-4b56-ad4f-e4c4e7e05f8a/the-first-swap-of-the-week-on-base-sepolia" },
      evmExtra: { assets: { USDC: TOKEN, "usdc-0123456789abcdef": TOKEN } },
    });
    const result = await run(rig);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("This was a dry run");
  });
});

// R1-FUND-01 with F2 (P9 review round 1): --refund and --resume asked again for the Buyer's approve and lock gas after it was spent, and --refund
// needed the Seller's key file too. A Buyer left with the dry run's need minus what the approve and the lock spent (1.44e12 - 258,000 x 1e6 wei, at a
// gas price of 1e6) is 2.9 times over what a refund can cost, and an honest refund must go ahead.
describe("R1-FUND-01: --refund and --resume size the Buyer's ETH row by what is left to send", () => {
  const LEFT = 1_182_000_000_000n; // the dry run's need (1.44e12) minus the approve and the lock (258,000 gas at 1e6 wei)

  /** The Buyer holds `buyerWei`; the Seller holds `sellerWei` (a refund does not need its gas: leg B refunds on paper; a resume does: it may claim). */
  function fund(rig: Rig, buyerWei: bigint, sellerWei = 10n ** 18n): void {
    rig.chain.handlers.eth_getBalance = (params) => ({ result: `0x${(String(params[0]).toLowerCase() === rig.buyer.toLowerCase() ? buyerWei : sellerWei).toString(16)}` });
  }

  /** What a Buyer that locked leg A leaves in the store: a record whose lock carries its write evidence (a landed lock). */
  async function writeBuyerRecord(rig: Rig, withLock: boolean, swapId = `0x${"11".repeat(32)}`): Promise<void> {
    const record = newBuyerRecord({ swapId, did: "did:key:z6Mkbuyer", railId: "evm-htlc", caip2: "eip155:84532", deploymentId: "evm:test", nowMs: Date.now() });
    const stored = withLock ? { ...record, lock: { attempted: true, evidence: { ref: `0x${"ab".repeat(32)}`, raw: [] }, framePosted: false } } : { ...record, lock: { attempted: true, framePosted: false } };
    await new FileFlowStore(join(rig.stateDir, "buyer", "flows")).save(flowKey("buyer", swapId), encodeFlowRecord(stored), null);
  }

  it("--refund goes past the pre-flight for a Buyer left with the need minus the approve and the lock, and says what the row reserves", async () => {
    const rig = await makeRig({ chain: { gasPriceWei: 1_000_000n } });
    fund(rig, LEFT, 0n); // the Seller holds nothing: a refund does not need it
    await writeRun(rig, {}, true);
    const result = await run(rig, "refund");
    expect(result.stdout).toMatch(/OK\s+buyer ETH\s+0x[0-9a-fA-F]{40}: 0\.000001182 ETH, needs 0\.0000004 ETH for the refund \(the approve and the lock are already sent\) \(200000 gas ceiling; Base's L1 data fee is not included\)/);
    expect(result.stdout).not.toContain("a check it needs failed");
    expect(result.stdout).not.toMatch(/FAIL\s+buyer ETH/);
    expect(result.code).toBe(EXIT.refused); // past the pre-flight, it stops at the Buyer's empty store: nothing to refund
    expect(result.stderr).toContain("holds no record");
    expect(rig.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);
  });

  it("--refund still stops for a Buyer who cannot pay the refund itself (one wei short of its own need)", async () => {
    const rig = await makeRig({ chain: { gasPriceWei: 1_000_000n } });
    fund(rig, 400_000_000_000n - 1n); // 200,000 gas x 1e6 x 2, less one wei
    await writeRun(rig, {}, true);
    const result = await run(rig, "refund");
    expect(result.code).toBe(EXIT.preflight);
    expect(result.stdout).toMatch(/FAIL\s+buyer ETH\s+.*fund it first/);
    expect(result.stdout).toContain("--refund did nothing because a check it needs failed");
  });

  it("--resume reserves only the refund once a lock is on record, and the whole need before one is", async () => {
    const withLock = await makeRig({ chain: { gasPriceWei: 1_000_000n } });
    fund(withLock, LEFT);
    await writeRun(withLock, {}, true);
    await writeBuyerRecord(withLock, true);
    const resumed = await run(withLock, "resume");
    expect(resumed.stdout).toMatch(/OK\s+buyer ETH\s+.*for the refund \(the approve and the lock are already sent\)/);
    expect(resumed.stdout).not.toContain("--resume did nothing because a check it needs failed");
    expect(withLock.chain.methods.filter((m) => WRITES.includes(m))).toEqual([]);

    // The lock was attempted but nothing proves it landed: the Buyer may still have to approve and lock, so the full need stays.
    const attempted = await makeRig({ chain: { gasPriceWei: 1_000_000n } });
    fund(attempted, LEFT);
    await writeRun(attempted, {}, true);
    await writeBuyerRecord(attempted, false);
    const refused = await run(attempted, "resume");
    expect(refused.code).toBe(EXIT.preflight);
    expect(refused.stdout).toMatch(/FAIL\s+buyer ETH\s+.*for approve, lock and a refund/);

    // No Buyer record at all: the same.
    const none = await makeRig({ chain: { gasPriceWei: 1_000_000n } });
    fund(none, LEFT);
    await writeRun(none, {}, true);
    const nothing = await run(none, "resume");
    expect(nothing.code).toBe(EXIT.preflight);
    expect(nothing.stdout).toMatch(/FAIL\s+buyer ETH\s+.*for approve, lock and a refund/);
  });

  it("a fresh run (dry run and --yes) keeps the full need: the same Buyer is short", async () => {
    for (const mode of ["dry", "yes"] as const) {
      const rig = await makeRig({ chain: { gasPriceWei: 1_000_000n } });
      fund(rig, LEFT);
      const result = await run(rig, mode);
      expect(result.code, mode).toBe(EXIT.preflight);
      expect(result.stdout, mode).toMatch(/FAIL\s+buyer ETH\s+.*for approve, lock and a refund/);
    }
  });

  it("buyerLockOnRecord reads the record only: a lock with evidence is true; no record, no lock, an attempt without evidence and a damaged file are false", async () => {
    const rig = await makeRig();
    const swapId = `0x${"11".repeat(32)}`;
    await mkdir(rig.stateDir, { recursive: true });
    expect(await buyerLockOnRecord(rig.stateDir, swapId)).toBe(false); // no store at all (and none is created by the look)
    expect(await exists(join(rig.stateDir, "buyer"))).toBe(false);
    await writeBuyerRecord(rig, false, swapId);
    expect(await buyerLockOnRecord(rig.stateDir, swapId)).toBe(false);
    await rm(join(rig.stateDir, "buyer"), { recursive: true });
    await writeBuyerRecord(rig, true, swapId);
    expect(await buyerLockOnRecord(rig.stateDir, swapId)).toBe(true);
    expect(await buyerLockOnRecord(rig.stateDir, `0x${"22".repeat(32)}`)).toBe(false); // another swap
    expect(await buyerLockOnRecord(rig.stateDir, "not a swap id")).toBe(false);
    const file = join(rig.stateDir, "buyer", "flows", `buyer-${swapId}.json`);
    await writeFile(file, "damaged");
    expect(await buyerLockOnRecord(rig.stateDir, swapId)).toBe(false);
  });

  it("--refund does not need the Seller's key file (a refund uses none of the Seller's EVM keys): it shows a warning and goes on; --resume and the dry run still fail on it", async () => {
    const rig = await makeRig({ skipSellerKey: true });
    await writeRun(rig, {}, true);
    const refund = await run(rig, "refund");
    expect(refund.stdout).toMatch(/WARN\s+seller account\s+\(not needed for this mode\) sellerKeyFile: no such file/);
    expect(refund.stdout).not.toContain("a check it needs failed");
    expect(refund.code).toBe(EXIT.refused); // past the pre-flight and the account checks, it stops at the Buyer's empty store
    expect(refund.stderr).toContain("holds no record");
    expect(refund.stderr).not.toContain("a key file did not load");
    for (const mode of ["resume", "dry"] as const) {
      const result = await run(rig, mode);
      expect(result.code, mode).toBe(EXIT.preflight);
      expect(result.stdout, mode).toMatch(/FAIL\s+seller account\s+sellerKeyFile: no such file/);
    }
  });

  it("--refund with a Seller key file that names ANOTHER account than the run's is still refused", async () => {
    const rig = await makeRig();
    await writeRun(rig, { sellerAccount: `0x${"22".repeat(20)}` }, true);
    const refund = await run(rig, "refund");
    expect(refund.code).toBe(EXIT.refused);
    expect(refund.stderr).toContain("the key files now name other accounts than the ones this run started with");
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

describe("the runner reacts to the flows' own refusals by their text", () => {
  const source = async (name: string): Promise<string> => readFile(join(REPO_ROOT, "src", "client", name), "utf8");

  it("matches the texts the flows really carry (a flow that rewords one breaks this test, not a run)", async () => {
    const seller = await source("seller.ts");
    const buyer = await source("buyer.ts");
    // `claimLegA`'s four deadline refusals (before and after the finality read), and its finality refusal.
    expect(seller).toContain("seller: refusing to claim leg A at/after its claimByMs (chain time) (B2/C3)");
    expect(seller).toContain("seller: refusing to claim leg A at/after its claimByMs (chain time, re-checked after verifyLockFinal) (E4)");
    expect(seller).toContain("less than the claim-inclusion margin");
    expect(seller).toContain("seller: refusing to claim leg A before verifyLockFinal(A) is true (D-11)");
    expect(buyer).toContain("buyer: refund signed but not yet confirmed");
    expect(buyer).toContain("buyer: leg A was never locked, nothing to refund");
    for (const text of [
      "seller: refusing to claim leg A at/after its claimByMs (chain time) (B2/C3)",
      "seller: refusing to claim leg A at/after its claimByMs (chain time, re-checked after verifyLockFinal) (E4)",
      "seller: refusing to claim leg A - less than the claim-inclusion margin (300000 ms) remains before refundAfterMs (chain time) (B2/C3)",
    ]) {
      expect(FLOW_MESSAGE.claimWindowClosed.test(text), text).toBe(true);
      expect(FLOW_MESSAGE.lockNotFinal.test(text), text).toBe(false);
    }
    const notFinal = "seller: refusing to claim leg A before verifyLockFinal(A) is true (D-11): no lock at the finalized view";
    expect(FLOW_MESSAGE.lockNotFinal.test(notFinal)).toBe(true);
    expect(FLOW_MESSAGE.claimWindowClosed.test(notFinal)).toBe(false);
    expect(FLOW_MESSAGE.refundUnconfirmed.test("buyer: refund signed but not yet confirmed; it may never have been sent; call refundLegA() again later (G7)")).toBe(true);
    expect(FLOW_MESSAGE.neverLocked.test("buyer: leg A was never locked, nothing to refund")).toBe(true);
    // And they do not fire on each other or on an unrelated refusal.
    expect(FLOW_MESSAGE.refundUnconfirmed.test("buyer: leg A was never locked, nothing to refund")).toBe(false);
    expect(FLOW_MESSAGE.neverLocked.test("buyer: refund signed but not yet confirmed")).toBe(false);
    for (const pattern of Object.values(FLOW_MESSAGE)) expect(pattern.test("evm-htlc: connected chain id 1 does not match pin")).toBe(false);
  });
});

// R1-FUND-07 (P9 review round 1): after a recovered lock (one with no block number on record: a lock receipt timeout, a kill between the broadcast
// and the save) the runner skipped the finality wait and its claim loop gave up after 20 re-reads, about 100 s at the default poll, so a finalized
// lag of 15 to 39 minutes took many manual --resume runs. The fake chain is read-only (the settle itself is tests-anvil/rehearsal-runner.anvil.test.ts,
// "a resume whose lock record has no block number"), so the wait is pinned here through the function the runner calls, against a finalized block that
// passes the head only after more than 20 polls.
describe("R1-FUND-07: a lock with no block number on record is waited for, not given up on", () => {
  const hex = (n: bigint): string => `0x${n.toString(16)}`;

  function finalityWorld(options: { head: bigint; finalized: bigint; step: bigint; pollMs?: number; waitLimitMs?: number }): { world: FinalityWorld; state: { sleeps: number[]; logs: string[]; reads: number; waitedMs: number } } {
    const pollMs = options.pollMs ?? 5_000;
    const state = { sleeps: [] as number[], logs: [] as string[], reads: 0, waitedMs: 0 };
    let finalized = options.finalized;
    let t = 1_790_000_000_000;
    const rpc = {
      request: async ({ method, params }: { method: string; params?: readonly unknown[] }): Promise<unknown> => {
        if (method === "eth_blockNumber") return hex(options.head);
        if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
        if (params?.[0] === "latest") return { number: hex(options.head) };
        const number = finalized; // the "finalized" tag: it moves up by `step` blocks at every look
        finalized += options.step;
        state.reads += 1;
        return { number: hex(number) };
      },
    } as unknown as CapturingRpc;
    const config = parseRehearsalConfig(
      {
        rails: { evm: { pin: BASE_SEPOLIA_PIN, endpoint: "https://sepolia.base.org", contract: CONTRACT, assets: { USDC: TOKEN }, contractCodeHash: FAKE_ESCROW_CODE_HASH } },
        buyerKeyFile: "b.key",
        sellerKeyFile: "s.key",
        amount: "1000000",
        out: "bundle",
        pollMs,
        ...(options.waitLimitMs === undefined ? {} : { waitLimitMs: options.waitLimitMs }),
      },
      "/base",
    );
    const env: RehearsalEnv = {
      now: () => t,
      sleep: async (ms) => void (state.sleeps.push(ms), (t += ms), (state.waitedMs += ms)),
      out: () => undefined,
      err: () => undefined,
    };
    return { world: { config, env, rpc, log: (line) => void state.logs.push(line), pollMs }, state };
  }

  it("waits until the finalized block passes the head when the lock has no block number: more than 20 polls, then it returns", async () => {
    const { world, state } = finalityWorld({ head: 1_000n, finalized: 900n, step: 4n }); // 25 looks to get from 900 to 1000
    await waitLockFinal(world, undefined);
    expect(state.sleeps.length).toBeGreaterThan(20);
    expect(state.sleeps.length).toBe(25);
    expect(state.waitedMs).toBeGreaterThan(20 * 5_000); // longer than the 20 re-reads the claim loop used to give up after
    expect(state.logs.some((line) => line.includes("has no block number on record") && line.includes("block 1000"))).toBe(true);
  });

  it("with a block number it waits for that block only (as before), and returns at once when it is already final", async () => {
    const withBlock = finalityWorld({ head: 1_000n, finalized: 900n, step: 4n });
    await waitLockFinal(withBlock.world, 920n);
    expect(withBlock.state.sleeps.length).toBe(5); // 900, 904, 908, 912, 916, 920
    expect(withBlock.state.logs.some((line) => line.includes("no block number"))).toBe(false);
    const already = finalityWorld({ head: 1_000n, finalized: 990n, step: 1n });
    await waitLockFinal(already.world, 950n);
    expect(already.state.sleeps).toEqual([]);
  });

  it("is bounded by waitLimitMs like every wait: a finalized block that never passes the head ends in a refusal that names --resume", async () => {
    const stuck = finalityWorld({ head: 1_000n, finalized: 900n, step: 0n, pollMs: 5_000, waitLimitMs: 60_000 });
    await expect(waitLockFinal(stuck.world, undefined)).rejects.toThrow(/was not final after \d+ s \(waitLimitMs\); run --resume to keep waiting/);
    expect(stuck.state.waitedMs).toBeGreaterThan(60_000);
  });
});

describe("K3: every failure text the runner prints is redacted before it is cut", () => {
  it("no describeFailure call in the runner is given an identity redactor (the claim, re-read and lock read-back messages use the endpoint redactor)", async () => {
    const text = await readFile(join(REPO_ROOT, "src", "client", "rehearsal-run.ts"), "utf8");
    const calls = text.match(/describeFailure\([^\n]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) expect(call, call).not.toMatch(/\(t\) => t|\(text\) => text|\(x\) => x/);
  });
});

describe("R1-FUND-04: the runner's own texts do not promise that a resume sends nothing twice", () => {
  const PROMISE = /there is never a second lock or claim/;
  const TRUTH = /a repeated lock or claim is refused by the contract and costs only gas/;

  it("the runner's header, the command line's usage and the README say a repeated lock or claim is refused by the contract and costs only gas", async () => {
    for (const file of [join("src", "client", "rehearsal-run.ts"), join("bin", "swap-rehearsal-evm.mjs"), "README.md"]) {
      // The sentence may be wrapped over comment or indentation lines: compare it with the whitespace and comment marks folded.
      const text = (await readFile(join(REPO_ROOT, file), "utf8")).replace(/\s*\n\s*(\/\/\s*)?/g, " ");
      expect(text, file).not.toMatch(PROMISE);
      expect(text, file).toMatch(TRUTH);
    }
  });

  it("the closed-claim-window reaction says an earlier claim may still be pending, and what to run", async () => {
    const text = await readFile(join(REPO_ROOT, "src", "client", "rehearsal-run.ts"), "utf8");
    const reaction = text.match(/the Seller's claim window has closed[^\n]*/)?.[0] ?? "";
    expect(reaction).toMatch(/a claim this run sent earlier may still be pending/);
    expect(reaction).toMatch(/--refund/);
    expect(reaction).toMatch(/--resume/);
    expect(reaction).not.toMatch(/leg A will go back to the Buyer:/);
  });
});

describe("refundTimeReached", () => {
  it("needs the local clock AND the chain's head at or past the refund time (the contract judges the chain's)", () => {
    expect(refundTimeReached(1_000, 1_000, 1_000)).toBe(true);
    expect(refundTimeReached(2_000, 2_000, 1_000)).toBe(true);
    expect(refundTimeReached(2_000, 999, 1_000)).toBe(false); // the clock is ahead of a chain that has not got there
    expect(refundTimeReached(999, 2_000, 1_000)).toBe(false); // the chain is ahead of a clock that has not got there
    expect(refundTimeReached(999, 999, 1_000)).toBe(false);
  });
});

describe("untilRefundTime (--refund and --refund --wait)", () => {
  /** A fake world: `t` is the machine clock and the runner's clock, `sleep` moves it, the chain's head trails it by `headLagMs`. */
  function world(headLagMs: number | undefined) {
    const state = { t: 1_000_000_000_000, sleeps: [] as number[], logs: [] as string[], headReads: 0 };
    return {
      state,
      params: (refundAfterMs: number, wait: boolean) => ({
        label: "leg A",
        refundAfterMs,
        local: () => state.t,
        head: headLagMs === undefined ? undefined : async () => (state.headReads += 1, state.t - headLagMs),
        wait,
        now: () => state.t,
        sleep: async (ms: number) => void (state.sleeps.push(ms), (state.t += ms)),
        pollMs: 5_000,
        log: (line: string) => void state.logs.push(line),
      }),
    };
  }

  it("without --wait, a refund time that has not come is reported once (false), with both clocks named, and nothing sleeps", async () => {
    const w = world(5_000);
    const reached = await untilRefundTime(w.params(w.state.t + 60_000, false));
    expect(reached).toBe(false);
    expect(w.state.sleeps).toEqual([]);
    expect(w.state.logs).toHaveLength(1);
    expect(w.state.logs[0]).toContain("leg A is refundable from");
    expect(w.state.logs[0]).toContain("the local clock reads");
    expect(w.state.logs[0]).toContain("the chain's head");
    expect(w.state.logs[0]).toContain("add --wait");
  });

  it("is true at once when both clocks are past it", async () => {
    const w = world(5_000);
    expect(await untilRefundTime(w.params(w.state.t - 6_000, false))).toBe(true);
    expect(w.state.logs).toEqual([]);
  });

  it("with --wait, sleeps until the chain's head (the slower clock) has passed it too, then is true", async () => {
    const w = world(20_000); // the head trails the local clock by 20 s
    const refundAfter = w.state.t + 30_000;
    expect(await untilRefundTime(w.params(refundAfter, true))).toBe(true);
    expect(w.state.t - 20_000).toBeGreaterThanOrEqual(refundAfter); // not before the head got there
    expect(w.state.sleeps.length).toBeGreaterThan(1);
    expect(w.state.sleeps.every((ms) => ms === 5_000)).toBe(true);
    expect(w.state.logs.some((l) => l.includes("waiting for leg A's refund time"))).toBe(true);
    expect(w.state.headReads).toBeGreaterThan(1);
  });

  it("says how long there is to go by the slower of the two clocks", async () => {
    const w = world(10 * 60_000); // the head trails the local clock by 10 minutes
    expect(await untilRefundTime(w.params(w.state.t + 5 * 60_000, true))).toBe(true);
    expect(w.state.logs[0]).toContain("(15 min to go)"); // 5 minutes for the local clock, 15 for the head
  });

  it("a leg with no chain (leg B's paper note) is judged by the local clock alone and never reads a head", async () => {
    const w = world(undefined);
    const refundAfter = w.state.t + 12_000;
    expect(await untilRefundTime(w.params(refundAfter, true))).toBe(true);
    expect(w.state.t).toBeGreaterThanOrEqual(refundAfter);
    expect(w.state.headReads).toBe(0);
    const reported = world(undefined);
    expect(await untilRefundTime(reported.params(reported.state.t + 1_000, false))).toBe(false);
    expect(reported.state.logs[0]).not.toContain("the chain's head");
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

function bin(args: string[], script = BIN): Promise<BinResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
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

  it("answers --help and a bad command line without a build, and says what to do when a real run has none", async () => {
    // A copy of the script with no ../dist beside it, as a checkout that was never built.
    const dir = await mkdtemp(join(tmpdir(), "rh-nobuild-"));
    dirs.push(dir);
    await mkdir(join(dir, "bin"));
    const script = join(dir, "bin", "swap-rehearsal-evm.mjs");
    await copyFile(BIN, script);
    const help = await bin(["--help"], script);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: node bin/swap-rehearsal-evm.mjs");
    const bad = await bin(["a.json", "--wait"], script);
    expect(bad.code).toBe(EXIT.config);
    expect(bad.stderr).toContain("Usage: node bin/swap-rehearsal-evm.mjs");
    const real = await bin([join(dir, "config.json")], script);
    expect(real.code).toBe(EXIT.config);
    expect(real.stderr).toContain("cannot load the runner");
    expect(real.stderr).toContain("run npm run build first");
    // A build that is there but broken is not "run the build": the real error comes through.
    await mkdir(join(dir, "dist", "client"), { recursive: true });
    await writeFile(join(dir, "dist", "client", "rehearsal-run.js"), "export const broken = ;\n");
    const broken = await bin([join(dir, "config.json")], script);
    expect(broken.code).not.toBe(0);
    expect(broken.stderr).toContain("SyntaxError");
    expect(broken.stderr).not.toContain("run npm run build first");
  });

  it("exits 2 on a config that is missing, naming the file", async () => {
    const result = await bin([join(tmpdir(), "no-such-rehearsal-config.json")]);
    expect(result.code).toBe(EXIT.config);
    expect(result.stderr).toContain("cannot read the config file");
  });
  // KR2-1: a key typed where a path belongs (the shell history already holds it, but the output comes back to the session) is refused with a fixed
  // sentence that names the argument, exit 2, before the config is read or the state directory touched.
  it("refuses a config path or a --state-dir that looks like key material: exit 2, the argument named, no window of the key in any output, nothing created", async () => {
    const key = generatePrivateKey();
    const scan = keyScanner(key);
    const rig = await makeRig({ anvil: true });
    const before = await readdir(rig.dir);
    for (const [label, args, named] of [
      ["the config path", [key], "the config path looks like key material"],
      ["the config path, one slip", [key.slice(0, -1), "--yes"], "the config path looks like key material"],
      ["--state-dir", [rig.configPath, "--state-dir", key], "--state-dir looks like key material"],
      ["--state-dir, a path that ends in the key", [rig.configPath, "--state-dir", join("some", "dir", key), "--resume"], "--state-dir looks like key material"],
      ["--state-dir with --refund", [rig.configPath, "--state-dir", key, "--refund", "--wait"], "--state-dir looks like key material"],
    ] as const) {
      const result = await bin([...args]);
      expect(result.code, label).toBe(EXIT.config);
      expect(result.stderr, label).toContain(named);
      expect(result.stdout, label).toBe("");
      expect(scan(result.stdout) || scan(result.stderr), `${label}: no window of the pasted key may reach out or err`).toBe(false);
    }
    expect(await readdir(rig.dir)).toEqual(before);
    expect(await exists(join(REPO_ROOT, key))).toBe(false);
    expect(rig.chain.methods).toEqual([]);
  });


  it("runs the dry run end to end through the command line against the fake chain: exit 0, a table, no key, no write", async () => {
    const rig = await makeRig({ anvil: true });
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
