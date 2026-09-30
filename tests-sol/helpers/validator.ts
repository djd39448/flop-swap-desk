// SPDX-License-Identifier: MIT
//
// tests-sol/helpers/validator.ts - Stage SB-int (P6-SOL-SPEC.md section 5): spawns a throwaway
// single-node `solana-test-validator` inside WSL Ubuntu with the reviewed `htlc.so` loaded at genesis,
// creates the mock USDC mint at the program's compiled-in mint address, and funds fresh in-memory
// Buyer/Seller keys. Mirrors tests-near/helpers/sandbox.ts (build once per process -> spawn -> poll
// ready -> a typed handle with its own stop()) for the Solana side of the same test architecture.
//
// Keys (P6-SOL-SPEC.md section 1, approved 2026-09-30): every key this file touches is generated in
// this process's memory (`InMemorySolSigner`, the secret is an ES #private field) - the Buyer, the
// Seller, any extra party, and the mock mint's authority. None is ever written to disk, printed,
// logged or committed. The one file this helper writes into WSL is the mint account JSON, and it holds
// PUBLIC data only (the mint authority's public key, never a secret). The validator's own ledger key
// files (faucet, identity, vote, stake) are never opened: funding goes through the validator faucet's
// `requestAirdrop` RPC.
//
// Process lifecycle (sol-probe README gotcha 1): a background child of `wsl.exe` dies when the wsl.exe
// call returns, so the validator is started by `run-validator.sh` inside a `wsl.exe` child THIS process
// keeps attached for the whole run (`spawn`, `stdio: "ignore"`). The script records its own pid (an
// `exec` keeps it the validator's pid) and `stop()` kills exactly that pid, after checking that
// /proc/<pid>/cmdline names this handle's own home directory - never `pkill` by name (a NEAR sandbox
// from another builder may share this WSL instance).
//
// Argv arrays only (never `bash -lc "...$VAR..."` strings): every argument reaches the Linux side exactly
// as this module wrote it.
//
// The reviewed program: `SOL_HTLC_REVIEWED_SO_SHA256` is the sha256 of the `htlc.so` that
// `contracts-sol/build.sh` produced when the program was reviewed (SB1 fix S2/S5). It is the config's
// `programHash`, and the freshly built `.so` MUST hash to exactly it or the suite fails loudly: a changed
// program is a changed reviewed artifact and needs a new review and a new pin, never a silent re-pin.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

import {
  SOL_HTLC_PROGRAM_ID,
  SOL_LOCAL_PIN,
  type SolRailConfig,
} from "../../src/rails/sol-htlc.js";
import { CapturingRpc, type CapturingRpcOptions } from "../../src/rails/rpc-capture.js";
import { SOL_MAX_RESPONSE_BYTES, SolRpc, type SolCommitment } from "../../src/rails/sol-rpc.js";
import { InMemorySolSigner } from "../../src/rails/sol-signer-memory.js";
import {
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  decodeTokenAccount,
  mintTo,
} from "../../src/rails/sol-spl.js";
import {
  compileLegacyMessage,
  pubkeyFromBase58,
  pubkeyToBase58,
  signTransaction,
  type SolInstruction,
} from "../../src/rails/sol-tx.js";

const WSL_DISTRO = "Ubuntu";

/** sha256 of the reviewed `htlc.so` (`contracts-sol/build.sh`; SB1 fix S2/S5, program built for the default mock mint). */
export const SOL_HTLC_REVIEWED_SO_SHA256 = "ae1a357bc2efd927e8538b6a56ef469085f63d7f486bda142af40b65448f1967";

/** The keyless localnet mock USDC mint the program is built for: `base58(sha256("flop-swap-desk:sol-mock-usdc:v1"))`. */
export const SOL_MOCK_USDC_MINT = "91cjWuWZvm24ttxccaWHkAcXQcDw1jce4PNqknzRNSMz";
export const SOL_MOCK_USDC_DECIMALS = 6;

const LAMPORTS_PER_SOL = 1_000_000_000;
/** Rent-exempt minimum for an 82-byte mint at the default rent settings: (82 + 128) * 3480 * 2. */
const MINT_ACCOUNT_LAMPORTS = 1_461_600;

/** A worktree path, as WSL sees it under /mnt/<drive>. */
function toWslPath(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (match === null) throw new Error(`validator helper: cannot map "${windowsPath}" to a WSL path`);
  return `/mnt/${(match[1] as string).toLowerCase()}/${(match[2] as string).replace(/\\/g, "/")}`;
}

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(HELPERS_DIR, "..", "..");
const WORKTREE_WSL = toWslPath(WORKTREE);
const HELPERS_DIR_WSL = toWslPath(HELPERS_DIR);

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A synchronous `wsl.exe -d Ubuntu -- <argv>` call (an argv array, so nothing is shell-expanded). */
function runWslText(args: readonly string[], input?: string): RunResult {
  const r = spawnSync("wsl.exe", ["-d", WSL_DISTRO, "--", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runWslTextOrThrow(args: readonly string[], context: string, input?: string): string {
  const r = runWslText(args, input);
  if (r.status !== 0) throw new Error(`validator helper: ${context} failed (exit ${String(r.status)}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

function runWslBinary(args: readonly string[]): Buffer {
  const r = spawnSync("wsl.exe", ["-d", WSL_DISTRO, "--", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`validator helper: binary read of "${args.join(" ")}" failed (exit ${String(r.status)}): ${(r.stderr ?? Buffer.alloc(0)).toString("utf8")}`);
  }
  return r.stdout;
}

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolveFree) => {
    const server = createServer();
    server.unref();
    server.on("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

async function freePort(avoid: readonly number[] = []): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("validator helper: could not allocate a free port"));
          return;
        }
        const { port: p } = address;
        server.close(() => resolvePort(p));
      });
    });
    if (avoid.includes(port)) continue;
    return port;
  }
  throw new Error("validator helper: could not find a free port");
}

/** The validator also opens the pubsub websocket at rpc port + 1, so both must be free. */
async function freeRpcPort(avoid: readonly number[]): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await freePort(avoid);
    if (!avoid.includes(port + 1) && (await isPortFree(port + 1))) return port;
  }
  throw new Error("validator helper: could not find a free rpc port pair");
}

// --- build (once per process) ----------------------------------------------------------------------------

export interface BuiltProgram {
  soWslPath: string;
  soBytes: Uint8Array;
  soSha256: string;
}

/**
 * P4-BTC-SPEC.md 7a: a missing toolchain FAILS the whole file loudly (a `beforeAll` throw), never a silent
 * skip. Runs `contracts-sol/build.sh` (host unit tests, the SBF build, the litesvm tests against the built
 * `.so`) exactly once per process, reads the `.so` back and requires its sha256 to equal the reviewed pin.
 */
export async function buildProgram(): Promise<BuiltProgram> {
  const home = runWslTextOrThrow(["printenv", "HOME"], "resolving the WSL home directory").trim();
  const validatorBin = `${home}/.local/share/agave/v4.3.0/bin/solana-test-validator`;
  if (runWslText(["test", "-x", validatorBin]).status !== 0) {
    throw new Error(`validator helper: solana-test-validator not found at "${validatorBin}" (install Agave v4.3.0 in WSL - see handoff/research/sol-probe/README.md)`);
  }
  if (runWslText(["test", "-f", `${home}/.cargo/env`]).status !== 0) {
    throw new Error("validator helper: no Rust toolchain in WSL (~/.cargo/env missing) - see handoff/research/sol-probe/README.md");
  }
  const build = runWslText(["bash", `${WORKTREE_WSL}/contracts-sol/build.sh`]);
  if (build.status !== 0) {
    throw new Error(`validator helper: contracts-sol/build.sh failed (exit ${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
  }
  const soWslPath = `${home}/.cache/flop-sol-target/deploy/htlc.so`;
  if (runWslText(["test", "-f", soWslPath]).status !== 0) throw new Error(`validator helper: build.sh reported success but ${soWslPath} is missing`);
  const soBytes = new Uint8Array(runWslBinary(["cat", soWslPath]));
  const soSha256 = bytesToHex(sha256(soBytes));
  if (soSha256 !== SOL_HTLC_REVIEWED_SO_SHA256) {
    throw new Error(
      `validator helper: the built htlc.so hashes to ${soSha256}, not the reviewed ${SOL_HTLC_REVIEWED_SO_SHA256}. ` +
        "A changed program is a changed reviewed artifact: review it and update SOL_HTLC_REVIEWED_SO_SHA256 deliberately.",
    );
  }
  return { soWslPath, soBytes, soSha256 };
}

let buildOnce: Promise<BuiltProgram> | null = null;
function buildProgramOnce(): Promise<BuiltProgram> {
  buildOnce ??= buildProgram();
  return buildOnce;
}

// --- setup transactions ------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls a signature to `commitment` (throws on an on-chain error or a timeout). Setup only. */
async function waitForSignature(sol: SolRpc, signature: string, commitment: SolCommitment, timeoutMs = 120_000): Promise<number> {
  const order: Record<string, number> = { processed: 1, confirmed: 2, finalized: 3 };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [status] = await sol.getSignatureStatuses([signature]);
    if (status !== undefined && status !== null) {
      if (status.err !== null) throw new Error(`validator helper: setup transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus !== null && (order[status.confirmationStatus] ?? 0) >= (order[commitment] ?? 0)) return status.slot;
    }
    if (Date.now() >= deadline) throw new Error(`validator helper: setup transaction ${signature} did not reach ${commitment} in ${String(timeoutMs)} ms`);
    await sleep(250);
  }
}

/** Bare (non-capturing) sender for this helper's OWN setup work; every test gets a fresh CapturingRpc via
 *  `createCapturingRpc` instead. Sends with preflight on and waits for `confirmed`. */
async function sendSetupTx(sol: SolRpc, feePayer: InMemorySolSigner, extraSigners: readonly InMemorySolSigner[], instructions: SolInstruction[]): Promise<string> {
  const latest = await sol.getLatestBlockhash("confirmed");
  const message = compileLegacyMessage({ feePayer: feePayer.publicKeyBytes, recentBlockhash: pubkeyFromBase58(latest.blockhash), instructions });
  const tx = await signTransaction(message, [feePayer, ...extraSigners]);
  const reported = await sol.sendTransaction(tx.bytes, { preflightCommitment: "confirmed" });
  if (reported !== tx.signature) throw new Error("validator helper: the node reported a different signature than the one signed");
  await waitForSignature(sol, tx.signature, "confirmed");
  return tx.signature;
}

async function airdrop(sol: SolRpc, address: string, sol_: number): Promise<void> {
  const signature = await sol.requestAirdrop(address, Math.round(sol_ * LAMPORTS_PER_SOL));
  await waitForSignature(sol, signature, "confirmed");
}

/** A funded, keyed party. `tokenAccount` is the party's associated USDC token account (null when none was created). */
export interface SolParty {
  signer: InMemorySolSigner;
  address: string;
  tokenAccount: string | null;
}

export interface CreatePartyOptions {
  /** Micro-USDC minted to the party's token account (needs `tokenAccount`). Default 0. */
  usdc?: bigint;
  /** SOL airdropped for fees and rent. Default 10. */
  sol?: number;
  /** Create the party's associated USDC token account. Default true. */
  tokenAccount?: boolean;
}

export interface SolValidatorHandle {
  endpoint: string;
  /** The rail config for this validator: local pin, the fixed program id, the reviewed programHash, the mock mint. */
  config: SolRailConfig;
  mint: string;
  /** The reviewed `.so` bytes (public data), for tests that need the program's own bytes. */
  soBytes: Uint8Array;
  buyer: SolParty;
  seller: SolParty;
  /** A fresh `CapturingRpc` for a test's OWN evidence-bearing calls - never the setup transport. */
  createCapturingRpc(options?: Omit<CapturingRpcOptions, "endpoint">): CapturingRpc;
  /** A fresh funded party with its own in-memory key (waits until its setup is FINALIZED). */
  createParty(options?: CreatePartyOptions): Promise<SolParty>;
  /** Micro-USDC held by `owner`'s associated token account at finalized, or null when it has none. */
  usdcBalanceOf(owner: string): Promise<bigint | null>;
  /** Lamports of `address` at finalized (0 when the account does not exist). */
  lamportsOf(address: string): Promise<number>;
  /** Stops exactly this validator by pid and deletes its home; idempotent. */
  stop(): Promise<void>;
}

export interface StartSolValidatorOptions {
  /** Micro-USDC minted to the buyer at startup. Default 1_000_000_000 (1000 USDC at 6 decimals). */
  buyerMintAmount?: bigint;
}

/** 82-byte classic mint: authority COption tag u32 + key, supply u64, decimals u8, initialised u8, no freeze authority. */
function mintAccountData(authority: Uint8Array, decimals: number): Uint8Array {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  data.set(authority, 4);
  view.setBigUint64(36, 0n, true);
  data[44] = decimals;
  data[45] = 1;
  view.setUint32(46, 0, true);
  return data;
}

/**
 * Builds the program (once per process), starts one throwaway `solana-test-validator` with the program
 * loaded immutable and the mock USDC mint created at its fixed address, and funds a Buyer and a Seller
 * (fresh in-memory keys, associated token accounts, USDC minted to the Buyer). Everything setup did is
 * FINALIZED before this resolves, so the adapter's finalized reads see it.
 */
export async function startSolValidator(options: StartSolValidatorOptions = {}): Promise<SolValidatorHandle> {
  const built = await buildProgramOnce();

  const home = runWslTextOrThrow(["mktemp", "-d", "/tmp/flop-sol-validator-XXXXXX"], "creating a throwaway validator home").trim();
  let child: ChildProcess | null = null;
  let childExited = false;
  let pid: number | null = null;
  let stopped = false;

  const processAlive = (): boolean => pid !== null && runWslText(["kill", "-0", String(pid)]).status === 0;
  /** True only when the pid still names THIS handle's own validator (never a recycled pid). */
  const pidIsOurs = (): boolean => pid !== null && runWslText(["grep", "-aqF", home, `/proc/${String(pid)}/cmdline`]).status === 0;

  const logTail = (): string => runWsl(["tail", "-n", "30", `${home}/validator.log`]);
  function runWsl(args: readonly string[]): string {
    const r = runWslText(args);
    return r.stdout || r.stderr;
  }

  const stopProcess = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (pid !== null && pidIsOurs()) {
      runWslText(["kill", String(pid)]);
      for (let i = 0; i < 60 && processAlive(); i += 1) await sleep(500);
      if (processAlive() && pidIsOurs()) runWslText(["kill", "-9", String(pid)]);
      for (let i = 0; i < 20 && processAlive(); i += 1) await sleep(250);
    }
    if (child !== null && !childExited) {
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(resolveStop, 5000);
        child?.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
        child?.kill();
      });
    }
    if (process.env.KEEP_SOL_VALIDATOR_HOME !== "1") runWslText(["rm", "-rf", home]);
  };

  try {
    const mintAuthority = InMemorySolSigner.generate();
    const mintJson = JSON.stringify({
      pubkey: SOL_MOCK_USDC_MINT,
      account: {
        lamports: MINT_ACCOUNT_LAMPORTS,
        data: [base64.encode(mintAccountData(mintAuthority.publicKeyBytes, SOL_MOCK_USDC_DECIMALS)), "base64"],
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        rentEpoch: 0,
        space: 82,
      },
    });
    runWslTextOrThrow(["tee", `${home}/mint-account.json`], "writing the mint account JSON (public data)", mintJson);

    const rpcPort = await freeRpcPort([]);
    const faucetPort = await freePort([rpcPort, rpcPort + 1]);
    const gossipPort = await freePort([rpcPort, rpcPort + 1, faucetPort]);

    child = spawn(
      "wsl.exe",
      [
        "-d", WSL_DISTRO, "--", "bash", `${HELPERS_DIR_WSL}/run-validator.sh`,
        home, String(rpcPort), String(faucetPort), String(gossipPort),
        SOL_HTLC_PROGRAM_ID, built.soWslPath, SOL_MOCK_USDC_MINT, `${home}/mint-account.json`,
      ],
      { stdio: "ignore" },
    );
    child.once("exit", () => {
      childExited = true;
    });
    const spawnError = await new Promise<Error | null>((resolveSpawn) => {
      child?.once("error", (error) => resolveSpawn(error));
      setTimeout(() => resolveSpawn(null), 300);
    });
    if (spawnError !== null) throw new Error(`validator helper: wsl.exe failed to start: ${spawnError.message}`);

    // The script records its own pid before exec.
    {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const r = runWslText(["cat", `${home}/pid`]);
        const parsed = Number.parseInt(r.stdout.trim(), 10);
        if (r.status === 0 && Number.isInteger(parsed) && parsed > 1) {
          pid = parsed;
          break;
        }
        if (childExited || Date.now() >= deadline) throw new Error(`validator helper: the validator script never recorded a pid\n${logTail()}`);
        await sleep(100);
      }
    }

    const endpoint = `http://127.0.0.1:${rpcPort}`;
    const setupRpc = new CapturingRpc({ endpoint, maxResponseBytes: SOL_MAX_RESPONSE_BYTES });
    const sol = new SolRpc(setupRpc);

    // Ready: the node answers, and a FINALIZED slot exists with a block time (the adapter reads finalized).
    {
      const deadline = Date.now() + 90_000;
      let lastError: unknown;
      for (;;) {
        if (childExited) throw new Error(`validator helper: the validator exited during startup\n${logTail()}`);
        try {
          const finalized = await sol.getSlot("finalized");
          if (finalized > 2 && (await sol.getBlockTime(finalized)) !== null) break;
        } catch (error) {
          lastError = error;
        }
        if (Date.now() >= deadline) throw new Error(`validator helper: the validator at ${endpoint} never became ready (last error: ${String(lastError)})\n${logTail()}`);
        await sleep(300);
      }
      setupRpc.drain();
    }

    const finalizeSetup = async (signature: string): Promise<void> => {
      await waitForSignature(sol, signature, "finalized");
    };

    const createParty = async (opts: CreatePartyOptions = {}): Promise<SolParty> => {
      const signer = InMemorySolSigner.generate();
      const wantToken = opts.tokenAccount ?? true;
      const usdc = opts.usdc ?? 0n;
      if (usdc > 0n && !wantToken) throw new Error("validator helper: usdc needs a token account");
      await airdrop(sol, signer.publicKey, opts.sol ?? 10);
      let tokenAccount: string | null = null;
      if (wantToken) {
        const owner = signer.publicKeyBytes;
        const mint = pubkeyFromBase58(SOL_MOCK_USDC_MINT);
        const ata = associatedTokenAddress(owner, mint);
        tokenAccount = pubkeyToBase58(ata);
        const instructions: SolInstruction[] = [createAssociatedTokenAccountIdempotent({ payer: owner, owner, mint })];
        if (usdc > 0n) instructions.push(mintTo({ mint, destination: ata, authority: mintAuthority.publicKeyBytes, amount: usdc }));
        const signature = await sendSetupTx(sol, signer, usdc > 0n ? [mintAuthority] : [], instructions);
        await finalizeSetup(signature);
      } else {
        // Wait until the airdrop itself is finalized so a read at finalized sees the funded account.
        for (let i = 0; i < 200; i += 1) {
          const info = await sol.getAccountInfo(signer.publicKey, { commitment: "finalized" });
          if (info.account !== null) break;
          await sleep(500);
        }
      }
      setupRpc.drain();
      return { signer, address: signer.publicKey, tokenAccount };
    };

    const buyer = await createParty({ usdc: options.buyerMintAmount ?? 1_000_000_000n });
    const seller = await createParty({});

    const config: SolRailConfig = {
      pin: SOL_LOCAL_PIN,
      endpoint,
      programId: SOL_HTLC_PROGRAM_ID,
      programHash: SOL_HTLC_REVIEWED_SO_SHA256,
      assets: { USDC: SOL_MOCK_USDC_MINT },
    };

    return {
      endpoint,
      config,
      mint: SOL_MOCK_USDC_MINT,
      soBytes: built.soBytes,
      buyer,
      seller,
      createCapturingRpc: (rpcOptions) => new CapturingRpc({ endpoint, maxResponseBytes: SOL_MAX_RESPONSE_BYTES, ...rpcOptions }),
      createParty,
      usdcBalanceOf: async (owner) => {
        const ata = pubkeyToBase58(associatedTokenAddress(pubkeyFromBase58(owner), pubkeyFromBase58(SOL_MOCK_USDC_MINT)));
        const info = await sol.getAccountInfo(ata, { commitment: "finalized" });
        setupRpc.drain();
        return info.account === null ? null : decodeTokenAccount(info.account.data).amount;
      },
      lamportsOf: async (address) => {
        const info = await sol.getAccountInfo(address, { commitment: "finalized" });
        setupRpc.drain();
        return info.account === null ? 0 : info.account.lamports;
      },
      stop: stopProcess,
    };
  } catch (error) {
    await stopProcess();
    throw error;
  }
}
