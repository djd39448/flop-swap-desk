// SPDX-License-Identifier: MIT
//
// tests-anvil/rehearsal-runner.anvil.test.ts - P9-6 (handoff/P9-G1-READINESS-SPEC.md, rule 4: "nothing public before Dave"): the EVM
// rehearsal runner, bin/swap-rehearsal-evm.mjs, run as a real child process against real anvil nodes with keys generated at test
// time. Each party's key is written to a mode-0600 temp file the config names; anvil's unlocked account 0 funds the two accounts
// and nothing else of anvil's is used. The runner reads the chain, signs in its own process and sends raw transactions.
//
//   dry run          the default mode prints the pre-flight table with both addresses, sends nothing, writes nothing, exits 0; and it
//                    fails closed (exit 3, "nothing was sent") for an unfunded Buyer, a pinned code hash the escrow does not have, a
//                    Buyer short of tokens, and a second run in a state directory that already holds a swap.
//   --yes            the whole choreography settles on the chain, the bundle lands in `out`, the runner's own `audit-export` replay and
//                    this test's replay both accept `settled`, and the chain shows one lock and one claim.
//   kill, --resume   the runner is killed once its lock has landed, and again once its claim has landed; a fresh process with --resume
//                    finishes the swap and the chain still shows one lock and one claim (and the accounts' transaction counts show
//                    no second approve, lock or claim).
//   --refund         on an anvil whose time is moved: `--yes --stop-after lock`, a refund run too early (exit 5, nothing sent), the
//                    refund after the deadlines (`refunded`), and a run killed before leg A was locked (`refunded-b`).
//
// Every case scans every file the runner wrote (the bundle and the whole state directory) and its stdout and stderr for BOTH private
// keys, and the bundle and the output for the two Ed25519 venue seeds too, as booleans only: a failure names a file, never a byte of
// a key. `npm run test:anvil` only; `npm test` never spawns anvil or the runner.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { encodeFunctionData, keccak256, pad, toEventSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeFlowRecord, encodeFlowRecord } from "../src/client/flow-record.js";
import { FileFlowStore, flowDigest, flowKey } from "../src/client/flow-store.js";
import { ANVIL_LOCAL_PIN } from "../src/rails/evm-htlc.js";
import { keyScanner } from "../tests/helpers/evm-local.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const RUNNER = join(REPO_ROOT, "bin", "swap-rehearsal-evm.mjs");
const AUDIT = join(REPO_ROOT, "examples", "audit-export.mjs");

const TOKEN_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const LOCKED = toEventSelector("Locked(bytes32,address,address,address,uint256,uint256,uint256)");
const CLAIMED = toEventSelector("Claimed(bytes32,bytes32)");
const REFUNDED = toEventSelector("Refunded(bytes32)");

const scratch: string[] = [];

interface Chain {
  anvil: AnvilHandle;
  contract: Address;
  token: Address;
  codeHash: Hex;
}

async function startChain(): Promise<Chain> {
  // Block time 1 s: the chain moves by itself, which a runner that waits for the finalized block needs. The genesis time is now, so the
  // runner's system clock and the chain's agree (the refund group moves the chain's time on purpose and uses the chain clock).
  const anvil = await startAnvil({ timestampSeconds: Math.floor(Date.now() / 1000), blockTimeSeconds: 1 });
  const deployer = anvil.accounts[0];
  if (deployer === undefined) throw new Error("test setup: anvil exposed no account");
  const deployed = await deployRailContracts(anvil.endpoint, deployer);
  const code = await anvil.rpcCall<Hex>("eth_getCode", [deployed.railContract, "latest"]);
  return { anvil, contract: deployed.railContract, token: deployed.tokenContract, codeHash: keccak256(code) };
}

async function receipt(anvil: AnvilHandle, hash: Hex): Promise<void> {
  for (;;) {
    const found = await anvil.rpcCall<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (found !== null) {
      if (found.status !== "0x1") throw new Error("test setup: a funding transaction reverted");
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Rig {
  dir: string;
  configPath: string;
  stateDir: string;
  outDir: string;
  keysDir: string;
  buyer: Address;
  seller: Address;
  /** True when `text` holds either private key (a boolean: a failing assertion can never print a key). */
  leaks: (text: string) => boolean;
}

interface RigOptions {
  /** Pin finality to this many confirmations instead of anvil's `finalized` tag (which trails the head by two blocks): a finality that lags
   *  longer than the receipt polling does, as a public chain's does, so the runner's waits are really needed. */
  confirmations?: number;
  clock?: "chain";
  fundBuyerEth?: boolean;
  buyerTokens?: bigint;
  codeHash?: Hex;
}

/** Two fresh parties: keys generated now into mode-0600 files, funded from anvil's account 0, and a config that names them. */
async function makeRig(chain: Chain, options: RigOptions = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "flop-rh-"));
  scratch.push(dir);
  const keysDir = join(dir, "keys");
  const keys = [generatePrivateKey(), generatePrivateKey()];
  const accounts = keys.map((key) => privateKeyToAccount(key));
  await mkdir(keysDir, { recursive: true });
  await writeFile(join(keysDir, "buyer.key"), `${keys[0]}\n`, { mode: 0o600 });
  await writeFile(join(keysDir, "seller.key"), `${keys[1]}\n`, { mode: 0o600 });
  const scanners = keys.map((key) => keyScanner(key));
  const [buyer, seller] = [accounts[0]!.address, accounts[1]!.address];

  const funder = chain.anvil.accounts[0]!;
  const tenEth = "0x8ac7230489e80000";
  if (options.fundBuyerEth !== false) await receipt(chain.anvil, await chain.anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: funder, to: buyer, value: tenEth }]));
  await receipt(chain.anvil, await chain.anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: funder, to: seller, value: tenEth }]));
  const tokens = options.buyerTokens ?? 100_000_000n;
  if (tokens > 0n) {
    const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [buyer, tokens] });
    await receipt(chain.anvil, await chain.anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: funder, to: chain.token, data }]));
  }

  const config = {
    rails: {
      evm: {
        pin: options.confirmations === undefined ? ANVIL_LOCAL_PIN : { ...ANVIL_LOCAL_PIN, finality: { mode: "confirmations", confirmations: options.confirmations } },
        endpoint: chain.anvil.endpoint,
        contract: chain.contract,
        assets: { USDC: chain.token },
        contractCodeHash: options.codeHash ?? chain.codeHash,
      },
    },
    buyerKeyFile: "keys/buyer.key",
    sellerKeyFile: "keys/seller.key",
    amount: "1000000",
    out: "bundle",
    pollMs: 250,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    dir,
    configPath,
    stateDir: join(dir, "state"),
    outDir: join(dir, "bundle"),
    keysDir,
    buyer,
    seller,
    leaks: (text) => scanners.some((scan) => scan(text)),
  };
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Running {
  done: Promise<RunResult>;
  waitForLine: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  kill: () => void;
}

/** Spawns the runner as a child process; `waitForLine` resolves once its stdout shows the pattern. */
function startRunner(rig: Rig, flags: string[]): Running {
  const child: ChildProcess = spawn(process.execPath, [RUNNER, rig.configPath, "--state-dir", rig.stateDir, ...flags], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const watchers: Array<() => void> = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    for (const watcher of [...watchers]) watcher();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<RunResult>((resolveDone) => {
    child.on("close", (code, signal) => {
      for (const watcher of [...watchers]) watcher();
      resolveDone({ code, signal, stdout, stderr });
    });
  });
  const waitForLine = (pattern: RegExp, timeoutMs = 60_000): Promise<void> =>
    new Promise<void>((resolveLine, reject) => {
      const timer = setTimeout(() => reject(new Error(`the runner never printed ${pattern}; output so far: ${stdout.slice(-600)}`)), timeoutMs);
      const check = (): void => {
        if (pattern.test(stdout)) {
          clearTimeout(timer);
          watchers.splice(watchers.indexOf(check), 1);
          resolveLine();
        } else if (child.exitCode !== null) {
          clearTimeout(timer);
          watchers.splice(watchers.indexOf(check), 1);
          reject(new Error(`the runner exited (${child.exitCode}) before it printed ${pattern}; output: ${stdout.slice(-600)} ${stderr.slice(-300)}`));
        }
      };
      watchers.push(check);
      check();
    });
  return { done, waitForLine, kill: () => void child.kill("SIGKILL") };
}

async function run(rig: Rig, flags: string[] = []): Promise<RunResult> {
  return startRunner(rig, flags).done;
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

/** Names (never contents) of every output and every file under `dirs` that holds either private key. Fails if there was nothing to scan. */
async function leakingPlaces(rig: Rig, dirs: string[], outputs: Record<string, string>): Promise<string[]> {
  const leaking: string[] = [];
  let scanned = 0;
  for (const [name, text] of Object.entries(outputs)) {
    scanned += 1;
    if (rig.leaks(text)) leaking.push(`output:${name}`);
  }
  for (const dir of dirs) {
    for (const file of await filesUnder(dir)) {
      scanned += 1;
      if (rig.leaks(await readFile(file, "latin1"))) leaking.push(relative(rig.dir, file));
    }
  }
  if (dirs.length > 0) expect(scanned).toBeGreaterThan(Object.keys(outputs).length); // the directories held files: the scan really read them
  return leaking;
}

/** The two Ed25519 venue seeds (state directory) must not reach the bundle or the output. */
async function leakingSeeds(rig: Rig, outputs: Record<string, string>): Promise<string[]> {
  const scanners = await Promise.all(
    ["buyer", "seller"].map(async (role) => keyScanner(`0x${(await readFile(join(rig.stateDir, role, "ed25519.seed"), "utf8")).trim()}` as Hex)),
  );
  const leaking: string[] = [];
  const check = (name: string, text: string): void => {
    if (scanners.some((scan) => scan(text))) leaking.push(name);
  };
  for (const [name, text] of Object.entries(outputs)) check(`output:${name}`, text);
  for (const file of await filesUnder(rig.outDir)) check(relative(rig.dir, file), await readFile(file, "latin1"));
  return leaking;
}

/** K5 (P8 rule 5 on the runner's surface): the Seller's swap secret, read from its flow record (the one place it is stored). */
async function sellerSecret(rig: Rig): Promise<Hex> {
  const store = new FileFlowStore(join(rig.stateDir, "seller", "flows"));
  const key = (await store.list()).find((candidate) => candidate.startsWith("seller:"));
  if (key === undefined) throw new Error("test setup: the Seller has no flow record");
  const bytes = await store.load(key);
  if (bytes === null) throw new Error("test setup: the Seller's flow record is gone");
  const record = decodeFlowRecord(bytes, key);
  if (record.role !== "seller") throw new Error("test setup: not a Seller record");
  return record.preimage as Hex;
}

/** A path under the rig's directory with `/` separators, for the allowed-place rules below. */
function slashed(rig: Rig, file: string): string {
  return relative(rig.dir, file).replaceAll("\\", "/");
}

/**
 * K5: names (never contents) of every output and every file under `dirs` that holds the secret, except the files `allowed` accepts. A run that
 * has not revealed (a stop after the lock, a refund) may hold the secret in the Seller's own flow record and nowhere else: no output line, no
 * venue or note file, no bundle file. Also proves the scan can see the secret where it lives (`where`, the files that hold it, is returned too).
 */
async function secretPlaces(
  rig: Rig,
  secret: Hex,
  dirs: string[],
  outputs: Record<string, string>,
  allowed: (relative: string) => boolean,
): Promise<{ stray: string[]; where: string[] }> {
  const scan = keyScanner(secret);
  const stray: string[] = [];
  const where: string[] = [];
  for (const [name, text] of Object.entries(outputs)) if (scan(text)) stray.push(`output:${name}`);
  for (const dir of dirs) {
    for (const file of await filesUnder(dir)) {
      if (!scan(await readFile(file, "latin1"))) continue;
      const name = slashed(rig, file);
      where.push(name);
      if (!allowed(name)) stray.push(name);
    }
  }
  return { stray, where };
}

/** Waits (the chain mines a block a second) until the head is at least block `number`. */
async function headAtLeast(chain: Chain, number: bigint): Promise<void> {
  for (;;) {
    if (BigInt(await chain.anvil.rpcCall<Hex>("eth_blockNumber", [])) >= number) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * R1-FUND-07: what a lock receipt timeout, or a kill between the broadcast and the save, leaves behind: the Buyer's record of its lock WITHOUT the
 * block the lock landed in (the evidence keeps its ref and no more, as `recordLockLanded` writes it). The record is rewritten through the store.
 */
async function dropLockBlock(rig: Rig): Promise<void> {
  const { swapId } = await readRun(rig);
  const store = new FileFlowStore(join(rig.stateDir, "buyer", "flows"));
  const key = flowKey("buyer", swapId);
  const bytes = await store.load(key);
  if (bytes === null) throw new Error("test setup: the Buyer has no flow record");
  const record = decodeFlowRecord(bytes, key);
  if (record.role !== "buyer" || record.lock.evidence === undefined) throw new Error("test setup: the Buyer's record holds no lock evidence");
  const { ref, raw } = record.lock.evidence;
  await store.save(key, encodeFlowRecord({ ...record, lock: { ...record.lock, evidence: { ref, raw } } }), flowDigest(bytes));
}

/** The Seller's flow record is the only allowed home of the secret before a reveal. */
const SELLER_FLOWS = /^state\/seller\/flows\/[^/]+$/;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function replay(root: string, expect_: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [AUDIT, "--root", root, "--expect", expect_], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

interface RunFile {
  swapId: string;
  deadlines: { legA: { claimByMs: number; refundAfterMs: number }; legB: { claimByMs: number; refundAfterMs: number } };
}

async function readRun(rig: Rig): Promise<RunFile> {
  return JSON.parse(await readFile(join(rig.stateDir, "run.json"), "utf8")) as RunFile;
}

/** What the chain says about the Buyer's swap: its Locked logs (payer = the Buyer), and the Claimed / Refunded logs of that hash lock. */
async function chainFacts(chain: Chain, rig: Rig): Promise<{ locked: number; claimed: number; refunded: number; buyerTxs: number; sellerTxs: number }> {
  const logs = async (topics: Array<Hex | null>): Promise<Array<{ topics: Hex[] }>> =>
    chain.anvil.rpcCall("eth_getLogs", [{ address: chain.contract, fromBlock: "0x0", toBlock: "latest", topics }]);
  const lockedLogs = await logs([LOCKED, null, pad(rig.buyer, { size: 32 })]);
  const hashLock = lockedLogs[0]?.topics[1];
  const claimed = hashLock === undefined ? [] : await logs([CLAIMED, hashLock]);
  const refunded = hashLock === undefined ? [] : await logs([REFUNDED, hashLock]);
  const count = async (who: Address): Promise<number> => Number(BigInt(await chain.anvil.rpcCall<Hex>("eth_getTransactionCount", [who, "latest"])));
  return { locked: lockedLogs.length, claimed: claimed.length, refunded: refunded.length, buyerTxs: await count(rig.buyer), sellerTxs: await count(rig.seller) };
}

async function tokenBalance(chain: Chain, who: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "balanceOf", args: [who] });
  return BigInt(await chain.anvil.rpcCall<Hex>("eth_call", [{ to: chain.token, data }, "latest"]));
}

/** K1: names (never contents) of every output and file under `dirs` that names a configured key file (its directory or either file name). */
async function keyFilePathPlaces(rig: Rig, dirs: string[], outputs: Record<string, string>): Promise<string[]> {
  const names = [rig.keysDir, "buyer.key", "seller.key"];
  const named = (text: string): boolean => names.some((name) => text.includes(name) || text.includes(name.replaceAll("\\", "\\\\")));
  const found: string[] = [];
  for (const [name, text] of Object.entries(outputs)) if (named(text)) found.push(`output:${name}`);
  for (const dir of dirs) {
    for (const file of await filesUnder(dir)) if (named(await readFile(file, "latin1"))) found.push(relative(rig.dir, file));
  }
  return found;
}

/** The checks every finished run ends with: no key anywhere, the bundle replays, and (given the status) the runner's own replay said so. */
async function expectCleanAndReplays(rig: Rig, result: RunResult, status: string): Promise<void> {
  const outputs = { stdout: result.stdout, stderr: result.stderr };
  expect(await leakingPlaces(rig, [rig.stateDir, rig.outDir], outputs)).toEqual([]);
  expect(await keyFilePathPlaces(rig, [rig.stateDir, rig.outDir], outputs)).toEqual([]); // K1: no configured key-file path in any output, record or bundle file
  expect(await leakingSeeds(rig, outputs)).toEqual([]);
  const { swapId } = await readRun(rig);
  const replayed = await replay(rig.outDir, `${swapId}=${status}`);
  expect(replayed.stderr).toBe("");
  expect(replayed.code).toBe(0);
}

describe("the EVM rehearsal runner (bin/swap-rehearsal-evm.mjs) against real anvil nodes", () => {
  let main: Chain;

  beforeAll(async () => {
    main = await startChain();
  }, 60_000);

  afterAll(async () => {
    await main?.anvil.stop();
  });

  // The warped chains below are separate nodes; `scratch` is removed once every group is done.
  afterAll(async () => {
    if (process.env.KEEP_ANVIL_BUNDLES !== "1") await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("the dry run (the default mode)", () => {
    it("prints the pre-flight table with both addresses and no key, sends nothing, writes nothing, exits 0", async () => {
      const rig = await makeRig(main);
      const result = await run(rig);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("DRY RUN");
      expect(result.stdout).toContain(rig.buyer);
      expect(result.stdout).toContain(rig.seller);
      expect(result.stdout).toContain("RESULT: every check that is needed holds");
      expect(result.stdout).toMatch(/OK\s+chain id\s+31337/);
      expect(result.stdout).toMatch(/OK\s+escrow code\s+\d+ bytes, keccak 0x[0-9a-f]{64} is the pinned contractCodeHash/);
      expect(result.stdout).toMatch(/OK\s+finalized\s+block \d+/);
      expect(result.stdout).toMatch(/OK\s+pending/);
      expect(result.stdout).toMatch(/OK\s+state at finalized/);
      expect(result.stdout).toMatch(/OK\s+buyer ETH/);
      expect(result.stdout).toMatch(/OK\s+seller ETH/);
      expect(result.stdout).toMatch(/OK\s+buyer token\s+the Buyer holds 100 USDC \(100000000 units\)/);
      expect(result.stdout).toMatch(/OK\s+deadlines/);
      expect(result.stdout).toContain("Plan (nothing below has happened");
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(main.anvil.endpoint); // only the host appears
      expect(await leakingPlaces(rig, [], { stdout: result.stdout, stderr: result.stderr })).toEqual([]);
      // Nothing written, nothing sent.
      expect(await exists(rig.stateDir)).toBe(false);
      expect(await exists(rig.outDir)).toBe(false);
      const facts = await chainFacts(main, rig);
      expect(facts).toEqual({ locked: 0, claimed: 0, refunded: 0, buyerTxs: 0, sellerTxs: 0 });
    }, 60_000);

    it("fails closed with exit 3 and 'Nothing was sent' for an unfunded Buyer, a wrong code pin and a Buyer short of tokens", async () => {
      const unfunded = await makeRig(main, { fundBuyerEth: false });
      const a = await run(unfunded);
      expect(a.code).toBe(3);
      expect(a.stdout).toMatch(/FAIL\s+buyer ETH/);
      expect(a.stdout).toContain("Nothing was sent");

      const wrongPin = await makeRig(main, { codeHash: `0x${"ab".repeat(32)}` });
      const b = await run(wrongPin);
      expect(b.code).toBe(3);
      expect(b.stdout).toMatch(/FAIL\s+escrow code/);

      const broke = await makeRig(main, { buyerTokens: 10n });
      const c = await run(broke);
      expect(c.code).toBe(3);
      expect(c.stdout).toMatch(/FAIL\s+buyer token/);

      for (const [rig, result] of [[unfunded, a], [wrongPin, b], [broke, c]] as const) {
        expect(await exists(rig.stateDir)).toBe(false);
        expect(await leakingPlaces(rig, [], { stdout: result.stdout, stderr: result.stderr })).toEqual([]);
        expect((await chainFacts(main, rig)).buyerTxs).toBe(0);
      }
    }, 120_000);

    it("refuses --yes with a failed pre-flight (nothing sent, no state written)", async () => {
      const rig = await makeRig(main, { fundBuyerEth: false });
      const result = await run(rig, ["--yes"]);
      expect(result.code).toBe(3);
      expect(result.stdout).toContain("--yes refuses to broadcast unless every needed check holds");
      expect(await exists(join(rig.stateDir, "run.json"))).toBe(false);
      expect(await exists(rig.outDir)).toBe(false);
    }, 60_000);
  });

  describe("--yes", () => {
    it("settles on the chain: one lock, one claim, the bundle replays to settled, no key anywhere; a second --yes in the same state directory is refused", async () => {
      const rig = await makeRig(main);
      const result = await run(rig, ["--yes"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      for (const marker of [
        "step buyer.bid done",
        "step seller.acceptLegA done",
        "step buyer.acceptLegB done",
        "step seller.lockLegB done",
        "step buyer.verifyLegBLocked done",
        "step seller.postAccountLineA done",
        "step buyer.postAccountLineA done",
        "step buyer.lockLegA done",
        "step seller.claimLegA done",
        "step buyer.learnSecret done",
        "step buyer.claimLegB done",
        "audit: the bundle replays offline to settled",
      ]) {
        expect(result.stdout).toContain(marker);
      }
      const facts = await chainFacts(main, rig);
      expect(facts).toEqual({ locked: 1, claimed: 1, refunded: 0, buyerTxs: 2, sellerTxs: 1 }); // approve + lock; claim
      expect(await tokenBalance(main, rig.seller)).toBe(1_000_000n);
      expect(await tokenBalance(main, rig.buyer)).toBe(99_000_000n);
      expect(await exists(join(rig.outDir, "rails.json"))).toBe(true);
      await expectCleanAndReplays(rig, result, "settled");

      // The state directory now holds this swap: another --yes would start a second one, and is refused before it sends anything.
      const again = await run(rig, ["--yes"]);
      expect(again.code).toBe(3);
      expect(again.stdout).toMatch(/FAIL\s+state directory/);
      expect(await chainFacts(main, rig)).toEqual(facts);

      // A finished run is only reported: --resume says so (exit 0), --refund refuses (exit 4), and neither touches the chain.
      const resumed = await run(rig, ["--resume"]);
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("this run already ended: swap");
      expect(resumed.stdout).toContain("settled");
      const refund = await run(rig, ["--refund"]);
      expect(refund.code).toBe(4);
      expect(refund.stderr).toContain("the run settled, so there is nothing to refund");
      expect(await chainFacts(main, rig)).toEqual(facts);
    }, 180_000);
  });

  describe("--yes on a chain whose finality lags", () => {
    it("waits for the lock and for the claim to be final (8 confirmations, a block a second): settles, and says it waited", async () => {
      await headAtLeast(main, 15n); // the finalized block (8 below the head) must be past the escrow's deploy, or the pre-flight's state read fails (F9)
      const rig = await makeRig(main, { confirmations: 8 });
      const result = await run(rig, ["--yes"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/OK\s+finalized\s+8 confirmations/);
      expect(result.stdout).toContain("waiting for the lock of leg A to be final");
      expect(result.stdout).toContain("waiting for the claim of leg A to be final");
      expect(result.stdout).toContain("audit: the bundle replays offline to settled");
      expect(await chainFacts(main, rig)).toEqual({ locked: 1, claimed: 1, refunded: 0, buyerTxs: 2, sellerTxs: 1 });
      await expectCleanAndReplays(rig, result, "settled");
    }, 180_000);
  });

  describe("a kill in the middle, then --resume", () => {
    it.each([
      ["after the lock landed", /step buyer\.lockLegA done/, { locked: 1, claimed: 0 }],
      ["after the claim landed", /step seller\.claimLegA done/, { locked: 1, claimed: 1 }],
      ["after the Buyer claimed leg B", /step buyer\.claimLegB done/, { locked: 1, claimed: 1 }],
    ] as const)("%s: a fresh process finishes the swap, with one lock and one claim", async (_label, marker, atKill) => {
      const rig = await makeRig(main);
      const first = startRunner(rig, ["--yes"]);
      await first.waitForLine(marker);
      first.kill();
      const killed = await first.done;
      expect(killed.code).not.toBe(0); // it died; it did not finish
      expect(await exists(rig.outDir)).toBe(false); // no bundle yet
      const midway = await chainFacts(main, rig);
      expect(midway.locked).toBe(atKill.locked);
      expect(midway.claimed).toBe(atKill.claimed);
      expect(midway.buyerTxs).toBe(2); // approve and lock, once

      const resumed = await run(rig, ["--resume"]);
      expect(resumed.stderr).toBe("");
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("continuing swap");
      expect(resumed.stdout).toContain("audit: the bundle replays offline to settled");
      expect(await chainFacts(main, rig)).toEqual({ locked: 1, claimed: 1, refunded: 0, buyerTxs: 2, sellerTxs: 1 });
      await expectCleanAndReplays(rig, { ...resumed, stdout: killed.stdout + resumed.stdout, stderr: killed.stderr + resumed.stderr }, "settled");
    }, 180_000);

    it("a resume whose lock record has no block number waits for the finalized block instead of giving up after 20 re-reads (R1-FUND-07)", async () => {
      // 15 confirmations at a block a second, polled every 250 ms: the lock reads final about 15 s after it landed, and the claim loop's 20 re-reads
      // used to last 5 s, so a runner that skipped the wait exited 4 ("before verifyLockFinal(A) is true") here.
      await headAtLeast(main, 25n); // the finalized block (15 below the head) must be past the escrow's deploy, or the pre-flight's state read fails (F9)
      const rig = await makeRig(main, { confirmations: 15 });
      const first = startRunner(rig, ["--yes"]);
      await first.waitForLine(/step buyer\.lockLegA done/);
      first.kill();
      const killed = await first.done;
      expect(killed.code).not.toBe(0);
      await dropLockBlock(rig);
      const resumed = await run(rig, ["--resume"]);
      expect(resumed.stderr).toBe("");
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("the lock of leg A has no block number on record");
      expect(resumed.stdout).toContain("audit: the bundle replays offline to settled");
      expect(await chainFacts(main, rig)).toEqual({ locked: 1, claimed: 1, refunded: 0, buyerTxs: 2, sellerTxs: 1 });
      await expectCleanAndReplays(rig, { ...resumed, stdout: killed.stdout + resumed.stdout, stderr: killed.stderr + resumed.stderr }, "settled");
    }, 240_000);

    it("--resume with nothing to resume (a state directory with no run) is refused with exit 4", async () => {
      const rig = await makeRig(main);
      const result = await run(rig, ["--resume"]);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("there is nothing to resume here");
    }, 60_000);
  });

  describe("--refund (an anvil whose time is moved)", () => {
    let warp: Chain;

    beforeAll(async () => {
      warp = await startChain();
    }, 60_000);

    afterAll(async () => {
      await warp?.anvil.stop();
    });

    /** Moves the chain's own clock to `ms` (the next block carries it); the runner's chain clock follows at its next start. */
    async function warpTo(ms: number): Promise<void> {
      await warp.anvil.rpcCall("evm_setNextBlockTimestamp", [Math.ceil(ms / 1000) + 1]);
      await warp.anvil.rpcCall("anvil_mine", ["0x1"]);
    }

    it("--yes --stop-after lock, a refund run too early (exit 5), then the refund after the deadlines: refunded, one lock, no claim", async () => {
      const rig = await makeRig(warp, { clock: "chain" });
      const locked = await run(rig, ["--yes", "--stop-after", "lock"]);
      expect(locked.stderr).toBe("");
      expect(locked.code).toBe(0);
      expect(locked.stdout).toContain("stopped after the lock, as asked");
      expect(await chainFacts(warp, rig)).toEqual({ locked: 1, claimed: 0, refunded: 0, buyerTxs: 2, sellerTxs: 0 });
      expect(await exists(rig.outDir)).toBe(false);

      // A run that was asked to stop after the lock stops there again when it is resumed: the Seller still does not claim.
      const resumed = await run(rig, ["--resume"]);
      expect(resumed.code).toBe(0);
      expect(resumed.stdout).toContain("stopped after the lock, as asked");
      expect(resumed.stdout).toContain("continuing swap");
      expect(await chainFacts(warp, rig)).toEqual({ locked: 1, claimed: 0, refunded: 0, buyerTxs: 2, sellerTxs: 0 });

      const early = await run(rig, ["--refund"]);
      expect(early.code).toBe(5);
      expect(early.stdout).toContain("leg A is refundable from");
      expect((await chainFacts(warp, rig)).refunded).toBe(0);

      // K5: nothing has been revealed (the Seller never claimed), so the Seller's secret is in its own flow record and nowhere else: not in any output
      // of the three runs so far, not in the venue or note files, not in any other record. (The control: the scan does see it in the Seller's record.)
      const secret = await sellerSecret(rig);
      const before = await secretPlaces(rig, secret, [rig.stateDir], { lockedOut: locked.stdout, lockedErr: locked.stderr, resumedOut: resumed.stdout, resumedErr: resumed.stderr, earlyOut: early.stdout, earlyErr: early.stderr }, (name) => SELLER_FLOWS.test(name));
      expect(before.stray).toEqual([]);
      expect(before.where.length).toBeGreaterThan(0);
      expect(before.where.every((name) => SELLER_FLOWS.test(name))).toBe(true);

      const { deadlines } = await readRun(rig);
      await warpTo(deadlines.legB.refundAfterMs + 60_000);
      const refunded = await run(rig, ["--refund"]);
      expect(refunded.stderr).toBe("");
      expect(refunded.code).toBe(0);
      expect(refunded.stdout).toContain("step buyer.refundLegA done");
      expect(refunded.stdout).toContain("step seller.refundLegB done");
      expect(refunded.stdout).toContain("audit: the bundle replays offline to refunded");
      expect(await chainFacts(warp, rig)).toEqual({ locked: 1, claimed: 0, refunded: 1, buyerTxs: 3, sellerTxs: 0 }); // approve, lock, refund
      // K5, after the refund: still only the Seller's record holds it, and the bundle (which replays to refunded) and every output are clean.
      const after = await secretPlaces(rig, secret, [rig.stateDir, rig.outDir], { lockedOut: locked.stdout, lockedErr: locked.stderr, earlyOut: early.stdout, refundedOut: refunded.stdout, refundedErr: refunded.stderr }, (name) => SELLER_FLOWS.test(name));
      expect(after.stray).toEqual([]);
      expect(after.where.length).toBeGreaterThan(0);
      expect(await tokenBalance(warp, rig.buyer)).toBe(100_000_000n); // the 1 USDC came back
      expect(await tokenBalance(warp, rig.seller)).toBe(0n);
      await expectCleanAndReplays(rig, { ...refunded, stdout: locked.stdout + early.stdout + refunded.stdout, stderr: locked.stderr + early.stderr + refunded.stderr }, "refunded");

      // A repeat is only reported (exit 0) and sends nothing; --resume on a refunded run refuses (exit 4).
      const repeat = await run(rig, ["--refund"]);
      expect(repeat.code).toBe(0);
      expect(repeat.stdout).toContain("this run already ended: swap");
      const resume = await run(rig, ["--resume"]);
      expect(resume.code).toBe(4);
      expect(resume.stderr).toContain("there is nothing to resume");
      expect(await chainFacts(warp, rig)).toEqual({ locked: 1, claimed: 0, refunded: 1, buyerTxs: 3, sellerTxs: 0 });
    }, 240_000);

    it("a refund runs without the Seller's key file (it uses none of the Seller's EVM keys): shown as a warning, refunded, one lock, the bundle replays (R1-FUND-01 with F2)", async () => {
      const rig = await makeRig(warp, { clock: "chain" });
      const locked = await run(rig, ["--yes", "--stop-after", "lock"]);
      expect(locked.code).toBe(0);
      await rm(join(rig.keysDir, "seller.key")); // the Seller's key file is gone (or never reachable from this machine any more)
      const { deadlines } = await readRun(rig);
      await warpTo(deadlines.legB.refundAfterMs + 60_000);
      const refunded = await run(rig, ["--refund"]);
      expect(refunded.stderr).toBe("");
      expect(refunded.code).toBe(0);
      expect(refunded.stdout).toMatch(/WARN\s+seller account\s+\(not needed for this mode\) sellerKeyFile: no such file/);
      expect(refunded.stdout).toContain("step buyer.refundLegA done");
      expect(refunded.stdout).toContain("step seller.refundLegB done");
      expect(refunded.stdout).toContain("audit: the bundle replays offline to refunded");
      expect(await chainFacts(warp, rig)).toEqual({ locked: 1, claimed: 0, refunded: 1, buyerTxs: 3, sellerTxs: 0 }); // the Seller sent nothing
      expect(await tokenBalance(warp, rig.buyer)).toBe(100_000_000n);
      await expectCleanAndReplays(rig, { ...refunded, stdout: locked.stdout + refunded.stdout, stderr: locked.stderr + refunded.stderr }, "refunded");
    }, 240_000);

    it("a refund that is not final yet is waited for (8 confirmations): the run says so and ends refunded", async () => {
      await headAtLeast(warp, 15n); // the finalized block (8 below the head) must be past the escrow's deploy, or the pre-flight's state read fails (F9)
      const rig = await makeRig(warp, { clock: "chain", confirmations: 8 });
      const locked = await run(rig, ["--yes", "--stop-after", "lock"]);
      expect(locked.code).toBe(0);
      const { deadlines } = await readRun(rig);
      await warpTo(deadlines.legB.refundAfterMs + 60_000);
      const refunded = await run(rig, ["--refund"]);
      expect(refunded.stderr).toBe("");
      expect(refunded.code).toBe(0);
      expect(refunded.stdout).toContain("the refund of leg A is not final yet; waiting for the finalized block to pass the current head");
      expect(refunded.stdout).toContain("audit: the bundle replays offline to refunded");
      expect(await chainFacts(warp, rig)).toEqual({ locked: 1, claimed: 0, refunded: 1, buyerTxs: 3, sellerTxs: 0 });
      const waited = await secretPlaces(rig, await sellerSecret(rig), [rig.stateDir, rig.outDir], { lockedOut: locked.stdout, lockedErr: locked.stderr, refundedOut: refunded.stdout, refundedErr: refunded.stderr }, (name) => SELLER_FLOWS.test(name)); // K5
      expect(waited.stray).toEqual([]);
      await expectCleanAndReplays(rig, { ...refunded, stdout: locked.stdout + refunded.stdout, stderr: locked.stderr + refunded.stderr }, "refunded");
    }, 240_000);

    it("a run killed before leg A was locked is refunded-b: leg B's paper note is refunded, nothing is locked on the chain", async () => {
      const rig = await makeRig(warp, { clock: "chain" });
      const first = startRunner(rig, ["--yes"]);
      await first.waitForLine(/step seller\.lockLegB done/);
      first.kill();
      const killed = await first.done;
      expect(killed.code).not.toBe(0);
      expect((await chainFacts(warp, rig)).locked).toBe(0);

      const { deadlines } = await readRun(rig);
      await warpTo(deadlines.legB.refundAfterMs + 60_000);
      const refunded = await run(rig, ["--refund"]);
      expect(refunded.stderr).toBe("");
      expect(refunded.code).toBe(0);
      expect(refunded.stdout).toContain("leg A was never locked");
      expect(refunded.stdout).toContain("audit: the bundle replays offline to refunded-b");
      expect((await chainFacts(warp, rig)).locked).toBe(0);
      const neverLocked = await secretPlaces(rig, await sellerSecret(rig), [rig.stateDir, rig.outDir], { killedOut: killed.stdout, killedErr: killed.stderr, refundedOut: refunded.stdout, refundedErr: refunded.stderr }, (name) => SELLER_FLOWS.test(name)); // K5
      expect(neverLocked.stray).toEqual([]);
      await expectCleanAndReplays(rig, { ...refunded, stdout: killed.stdout + refunded.stdout, stderr: killed.stderr + refunded.stderr }, "refunded-b");
    }, 240_000);
  });
});
