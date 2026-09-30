// SPDX-License-Identifier: MIT
//
// tests-near/helpers/sandbox.ts — Stage NB-int (P5-NEAR-SPEC.md §5, D-N2/D-N3): spawns a
// throwaway, single-node `near-sandbox` inside WSL Ubuntu, builds and deploys the `htlc`/
// `mock-ft` contracts, and creates the buyer/seller/token/contract accounts with fresh in-memory
// ed25519 keys — mirrors tests-regtest/helpers/bitcoind.ts's own shape (bin resolution → spawn →
// poll ready → hand back a typed handle with its own stop()) for the NEAR side of the same test
// architecture.
//
// D-N2 (the ONLY key this build ever reads off disk): the throwaway sandbox home's own
// `validator_key.json` (`test.near`) is read exactly once, straight into memory, via
// `wsl.exe -- cat` — never through a `bash -lc` string carrying `$VAR`s (see the probe README's
// "Environment gotcha": that stripping is specific to this machine's own sandboxed Bash tool, not
// to `child_process.spawn`, but this file still avoids shell interpolation of untrusted values on
// principle) and never logged, printed, written to disk on the Windows side, or returned from
// this module in any form. `test.near`'s key is used ONLY to sign the four `CreateAccount`
// transactions below; every party- and contract-account key from that point on is a fresh
// in-memory keypair this process itself generates (`InMemoryNearSigner.generate`), never test.near
// again.
//
// D-N3 (confirmed empirically, this stage): `near-sandbox --home <dir> init --chain-id
// near-sandbox-flop --fast` sets `genesis.json`'s own `chain_id` directly — no hand-edit of
// genesis.json is needed (the spec's "init --chain-id if accepted, else edit genesis.json" — the
// flag IS accepted on 2.13.4/protocol 86, so the fallback path is dead code and was not written).
// `status().chain_id` then reports `"near-sandbox-flop"` exactly, matching `NEAR_SANDBOX_PIN`
// (`src/rails/near-htlc.ts`).
//
// D-N7 (confirmed empirically, this stage): `sandbox_fast_forward` DOES advance the FINAL block
// header's own `timestamp_nanosec`, not merely its height — a probe run fast-forwarding 100
// blocks advanced the final block's own timestamp by ~33.7s (~337ms of simulated time per block,
// close to the ~0.6-0.7s/block real cadence NB0 measured, scaled down under fast-forward). This
// means `fastForward()` below is a safe, fast way to cross a `refundAfterMs` deadline without a
// real-time wait, and the contract's own `env::block_timestamp_ms()` checks (claim/refund window)
// react to it correctly.
//
// Process lifecycle (confirmed empirically, this stage): killing the Windows-side `wsl.exe` child
// process that was spawned as `wsl.exe -d Ubuntu -- <near-sandbox binary> --home <dir> run`
// terminates the wrapped Linux `near-sandbox` process in the common case (checked with `pgrep`
// before/after `child.kill()` on a throwaway `sleep` child) — but a live run against this same
// stage found ONE `near-sandbox` process that survived a `child.kill()` (neard's own shutdown
// path can outlast the 5s grace window this module gives it). `stop()` below therefore ALSO runs
// a precise, home-directory-scoped fallback: `wsl.exe -- pkill -f <home>` — never `pkill -x
// near-sandbox` (D-N12: this worktree can be shared by parallel builders, each with their own
// throwaway home; a name-based pkill would kill every one of them). Matching on this handle's own
// unique `mktemp`-generated home path (present in `--home <dir>` on the real command line) can
// only ever match this handle's own process, even when several sandboxes run concurrently, and —
// called as a direct `wsl.exe -- pkill -f <home>` invocation rather than through an intermediate
// `bash -lc "..."` wrapper — never matches its own wrapping shell the way the probe README's
// "pkill -f matches its own wrapping bash -lc process" gotcha describes (there is no such wrapper
// here for this one call).
//
// Also confirmed empirically, this stage: `near-sandbox` binds TWO ports, not one — the RPC port
// (`config.json`'s `rpc.addr`, rewritten below) AND a p2p network port (`config.json`'s
// `network.addr`, default `0.0.0.0:24567`, left unchanged by earlier stages' probes). Leaving the
// network port at its fixed default made a second concurrent sandbox instance crash outright
// (`AddrInUse` on `0.0.0.0:24567`) during this stage's own testing — confirming the mirror map's
// own flag ("near-sandbox has both an RPC port and a network port; the helper needs to allocate
// both"). Both ports are rewritten to freshly allocated free ports below.
//
// Design source: flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md D-N1..D-N12;
// flop-contrib/handoff/P5-NEAR-SPEC.md §1/§5;
// flop-contrib/handoff/P4-BTC-SPEC.md §7a (the lessons checklist: never skip a missing toolchain,
// fail the whole file loudly instead);
// tests-regtest/helpers/bitcoind.ts (the pattern this file mirrors);
// tests-near/probe/README.md (the WSL-invocation gotcha and the NB0 findings this file builds on).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

import { buildSignedTransaction, type NearAction } from "../../src/rails/near-borsh.js";
import { NearRpc, type NearTxOutcome } from "../../src/rails/near-rpc.js";
import { InMemoryNearSigner } from "../../src/rails/near-signer-memory.js";
import type { NearRailConfig, NearSigner } from "../../src/rails/near-htlc.js";
import { NEAR_SANDBOX_PIN } from "../../src/rails/near-htlc.js";
import { CapturingRpc, type CapturingRpcOptions } from "../../src/rails/rpc-capture.js";

const WSL_DISTRO = "Ubuntu";
const TGAS = 1_000_000_000_000n;
const ONE_NEAR = 1_000_000_000_000_000_000_000_000n; // 1 NEAR, in yoctoNEAR

function resolveNearSandboxBin(): string {
  const fromEnv = process.env.NEAR_SANDBOX_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return "/home/trustcore-rdp/.near-sandbox/2.13.4/Linux-x86_64/near-sandbox"; // Dave's machine, per P5-NEAR-SPEC.md §0
}

/** The worktree's own path, as WSL sees it under `/mnt/c` — used only for the one-time
 *  `contracts-near/build.sh` invocation (a committed script; see that file's own header for why
 *  it is called this way rather than with inline `$VAR`s). */
const WORKTREE_WSL_PATH = "/mnt/c/Users/trustcore-rdp/flop-swap-desk-near";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A synchronous `wsl.exe -d Ubuntu -- <argv>` call, argv-array (D-N2: no shell string, so
 *  nothing here is ever subject to shell word-splitting or `$`-expansion of a value this module
 *  builds from untrusted or dynamic input — every argument reaches the wrapped Linux process
 *  exactly as this module wrote it). Text mode (utf8) — never used for binary payloads (the wasm
 *  reads below use `runWslBinary` instead). */
function runWslText(args: readonly string[]): RunResult {
  const r = spawnSync("wsl.exe", ["-d", WSL_DISTRO, "--", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runWslTextOrThrow(args: readonly string[], context: string): string {
  const r = runWslText(args);
  if (r.status !== 0) {
    throw new Error(`near-sandbox helper: ${context} failed (exit ${String(r.status)}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** Binary-safe `wsl.exe -- cat <path>` — used only to read the two built `.wasm` artifacts back
 *  into Node memory (never key material; see `readValidatorSecretKeyOnce` for the one place that
 *  reads a key, kept deliberately separate and smaller). */
function runWslBinary(args: readonly string[]): Buffer {
  const r = spawnSync("wsl.exe", ["-d", WSL_DISTRO, "--", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`near-sandbox helper: binary read of "${args.join(" ")}" failed (exit ${String(r.status)}): ${(r.stderr ?? Buffer.alloc(0)).toString("utf8")}`);
  }
  return r.stdout;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("near-sandbox helper: could not allocate a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

/** P4-BTC-SPEC.md §7a / this leg's own D-N2: a missing toolchain or sandbox binary FAILS the
 *  whole file loudly (via a `beforeAll` throw), rather than a silent skip or a mysterious
 *  timeout — mirrors `startBitcoind`'s identical rule for a missing `bitcoind`. Runs
 *  `contracts-near/build.sh` (already `cargo test --workspace`, then both release wasm32 builds)
 *  exactly once per suite — callers pass a module-level memoised promise (see `startNearSandbox`'s
 *  own doc) so a file with several `describe` blocks never rebuilds twice.
 */
export async function buildContracts(): Promise<{ htlcWasmPath: string; mockFtWasmPath: string; buildLog: string }> {
  const bin = resolveNearSandboxBin();
  const binCheck = runWslText([bin, "--help"]);
  if (binCheck.status !== 0) {
    throw new Error(
      `near-sandbox helper: could not run the sandbox binary at "${bin}" (set NEAR_SANDBOX_BIN, or install near-sandbox 2.13.4 — see P5-NEAR-SPEC.md §0): ${binCheck.stderr}`,
    );
  }
  const cargoCheck = runWslText(["bash", "-lc", "source $HOME/.cargo/env 2>/dev/null; command -v cargo"]);
  if (cargoCheck.status !== 0 || cargoCheck.stdout.trim() === "") {
    throw new Error("near-sandbox helper: no Rust/cargo toolchain found in WSL (source ~/.cargo/env) — see P5-NEAR-SPEC.md §0");
  }

  const build = runWslText(["bash", "-lc", `bash '${WORKTREE_WSL_PATH}/contracts-near/build.sh'`]);
  if (build.status !== 0) {
    throw new Error(`near-sandbox helper: contracts-near/build.sh failed (exit ${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
  }
  const targetDir = runWslTextOrThrow(["bash", "-lc", "echo $HOME/.cache/flop-near-target"], "resolving CARGO_TARGET_DIR").trim();
  const htlcWasmPath = `${targetDir}/wasm32-unknown-unknown/release/htlc.wasm`;
  const mockFtWasmPath = `${targetDir}/wasm32-unknown-unknown/release/mock_ft.wasm`;
  for (const p of [htlcWasmPath, mockFtWasmPath]) {
    const check = runWslText(["test", "-f", p]);
    if (check.status !== 0) throw new Error(`near-sandbox helper: build.sh reported success but wasm artifact is missing: ${p}`);
  }
  return { htlcWasmPath, mockFtWasmPath, buildLog: build.stdout };
}

// Memoised across every `startNearSandbox()` call in one process (one `vitest` worker), so a test
// file with multiple `describe`/`beforeAll` blocks builds the contracts at most once.
let buildOnce: ReturnType<typeof buildContracts> | null = null;
function buildContractsOnce(): ReturnType<typeof buildContracts> {
  buildOnce ??= buildContracts();
  return buildOnce;
}

function decodeNearPublicKey(publicKey: string): Uint8Array {
  const prefix = "ed25519:";
  if (!publicKey.startsWith(prefix)) throw new Error(`near-sandbox helper: unsupported public key format "${publicKey}"`);
  const bytes = base58.decode(publicKey.slice(prefix.length));
  if (bytes.length !== 32) throw new Error("near-sandbox helper: ed25519 public key must decode to exactly 32 bytes");
  return bytes;
}

/** Bare (non-capturing) tx builder/sender for this helper's OWN setup work (account creation,
 *  contract deployment/init, storage registration, minting) — deliberately not a
 *  `CapturingRpc`-backed evidence path (mirrors `tests-regtest/helpers/bitcoind.ts`'s own
 *  `rpcCall`: "nothing here is evidence a test is checking"; `sandboxRpc()` below hands every
 *  actual test its own fresh `CapturingRpc` instead). Signs and sends one transaction with
 *  `wait_until: "FINAL"` and throws on any execution failure (a `Failure` outcome), so a broken
 *  setup step fails the whole `beforeAll` loudly rather than leaving a half-built sandbox for a
 *  test to fail against mysteriously.
 */
async function sendSetupTx(near: NearRpc, signer: NearSigner, signerAccountId: string, receiverId: string, actions: NearAction[]): Promise<NearTxOutcome> {
  const accessKey = await near.viewAccessKey(signerAccountId, signer.publicKey);
  const nonce = BigInt(accessKey.nonce) + 1n;
  const block = await near.block({ finality: "final" });
  const blockHash = base58.decode(block.header.hash);
  const built = await buildSignedTransaction(
    {
      signerId: signerAccountId,
      publicKey: { keyType: "ED25519", data: decodeNearPublicKey(signer.publicKey) },
      nonce,
      receiverId,
      blockHash,
      actions,
    },
    (hash) => signer.sign(hash),
  );
  const signedTxBase64 = Buffer.from(built.signedBytes).toString("base64");
  const outcome = await near.sendTx(signedTxBase64, "FINAL");
  const status = outcome.status as Record<string, unknown> | undefined;
  if (status !== undefined && status !== null && "Failure" in status) {
    throw new Error(`near-sandbox helper: setup tx ${signerAccountId} -> ${receiverId} failed: ${JSON.stringify(status.Failure)}`);
  }
  return outcome;
}

/** `CreateAccount` + `Transfer` + `AddKey(FullAccess)` (+ optionally `DeployContract` +
 *  `FunctionCall("new", ...)` in the SAME transaction/receipt — the standard "create, fund, key,
 *  deploy, init" combined pattern) signed by `test.near`. `accountId` MUST be a direct sub-account
 *  of the signer (`<name>.test.near`) — a sandbox's `test.near` cannot create an arbitrary
 *  top-level name. Returns a fresh in-memory signer already keyed to the new account. */
async function createSubAccount(
  near: NearRpc,
  rootSigner: NearSigner,
  accountId: string,
  fundingYocto: bigint,
  init?: { wasm: Uint8Array; methodName: string; args: Record<string, unknown>; gas: bigint },
): Promise<InMemoryNearSigner> {
  const signer = InMemoryNearSigner.generate(accountId);
  const actions: NearAction[] = [
    { type: "CreateAccount" },
    { type: "Transfer", deposit: fundingYocto },
    { type: "AddKey", publicKey: { keyType: "ED25519", data: signer.publicKeyRaw() }, nonce: 0n, permission: "FullAccess" },
  ];
  if (init !== undefined) {
    actions.push({ type: "DeployContract", code: init.wasm });
    actions.push({
      type: "FunctionCall",
      methodName: init.methodName,
      args: new TextEncoder().encode(JSON.stringify(init.args)),
      gas: init.gas,
      deposit: 0n,
    });
  }
  await sendSetupTx(near, rootSigner, "test.near", accountId, actions);
  return signer;
}

async function callSetup(
  near: NearRpc,
  signer: NearSigner,
  signerAccountId: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  depositYocto: bigint,
): Promise<void> {
  await sendSetupTx(near, signer, signerAccountId, contractId, [
    { type: "FunctionCall", methodName, args: new TextEncoder().encode(JSON.stringify(args)), gas, deposit: depositYocto },
  ]);
}

export interface NearSandboxHandle {
  endpoint: string;
  config: NearRailConfig;
  buyer: { accountId: string; signer: NearSigner };
  seller: { accountId: string; signer: NearSigner };
  usdcToken: string;
  htlcContract: string;
  /** A fresh `CapturingRpc` for a test's OWN evidence-bearing calls — never the setup transport
   *  above. Mirrors `BitcoindHandle.createCapturingRpc`. */
  createCapturingRpc(options?: Omit<CapturingRpcOptions, "endpoint">): CapturingRpc;
  /** D-N7 (confirmed empirically — see this file's header): `sandbox_fast_forward` advances the
   *  FINAL block's own timestamp, not merely its height. Waits for the height to actually advance
   *  before resolving, so a caller's very next chain-time read reflects the fast-forward. */
  fastForward(blocks: number): Promise<void>;
  /** Balance of `accountId` on the configured USDC token, in micro-USDC (a decimal-integer
   *  string) — a small test convenience over `ft_balance_of`, going through the SAME setup
   *  (non-capturing) transport as account creation, never a test's own `CapturingRpc`. */
  usdcBalanceOf(accountId: string): Promise<string>;
  /** H6 test support only: deploys a SECOND copy of the exact same reviewed `htlc` wasm to a
   *  fresh sub-account of `test.near` that is deliberately left WITH its access key (never
   *  locked down the way `htlcContract` itself is by `startNearSandbox`) — exists purely so
   *  `NearHtlcRail.connect()`'s own "refuses when the contract still holds an access key" branch
   *  can be exercised against a real, live contract. `accountId` must be `<name>.test.near`. */
  deployUnlockedHtlcClone(accountId: string): Promise<{ contract: string; codeHash: string }>;
  /** Test support only: creates a fresh, funded, storage-registered (zero-balance) sub-account of
   *  `test.near` with its own in-memory signer — used where a test needs a payee GUARANTEED never
   *  to have received a payout before (e.g. H1's own S1 probe, which relies on
   *  `storage_unregister` actually succeeding: near-contract-standards' own implementation panics
   *  rather than unregistering when the caller's balance is nonzero, so `sandbox.seller` — reused
   *  and credited across this whole file's own tests — is never safe to reuse for that). */
  createFundedAccount(accountId: string): Promise<{ accountId: string; signer: NearSigner }>;
  /** Test support only (P7): a fresh, funded sub-account of `test.near` with its own in-memory
   *  FullAccess key that is deliberately NOT storage-registered on the token -- the payee of a
   *  payout that cannot land. Under proof-of-control the payee's account line must be signed by a
   *  key of that account, so a test that needs an unregistered payee needs a signer for it. */
  createUnregisteredAccount(accountId: string): Promise<{ accountId: string; signer: NearSigner }>;
  /** Test support only: mints `amount` micro-USDC to an already storage-registered account (the
   *  token is self-owned, so the setup signer can mint) — e.g. a squatter that needs a unit to lock. */
  mintUsdc(accountId: string, amount: string): Promise<void>;
  stop(): Promise<void>;
}

export interface StartNearSandboxOptions {
  /** Micro-USDC minted to the buyer at startup (decimal-integer string). Default "1000000000"
   *  (1000 USDC at the mock token's 6 decimals) — comfortably above every amount this suite's
   *  scenarios lock. */
  buyerMintAmount?: string;
}

/**
 * Builds the contracts (once per process — see `buildContractsOnce`), starts one throwaway
 * `near-sandbox` node with chain id `near-sandbox-flop` (D-N3) on a free port, creates
 * `buyer.test.near`/`seller.test.near` (funded, keyed, no contract), `usdc.test.near` (the
 * mock-ft token, self-owned so it can mint to itself, buyer and seller pre-registered for
 * storage) and `htlc.test.near` (the HTLC contract, configured with `usdc.test.near` as its one
 * allowed token, itself pre-registered for storage so its own `ft_transfer` payouts never fail on
 * an unregistered recipient), and mints USDC to the buyer.
 */
export async function startNearSandbox(options: StartNearSandboxOptions = {}): Promise<NearSandboxHandle> {
  const { htlcWasmPath, mockFtWasmPath } = await buildContractsOnce();
  const bin = resolveNearSandboxBin();

  const home = runWslTextOrThrow(["mktemp", "-d", "/tmp/flop-near-sandbox-XXXXXX"], "creating a throwaway sandbox home").trim();

  let child: ChildProcess | null = null;
  let stopped = false;

  const cleanupHome = async (): Promise<void> => {
    if (process.env.KEEP_NEAR_SANDBOX_HOME === "1") return;
    runWslText(["rm", "-rf", home]);
  };
  const stopChild = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child !== null) {
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(resolveStop, 5000); // never hang the suite on a stuck child
        child?.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
        child?.kill();
      });
    }
    // Fallback (see this file's own header comment): a `child.kill()` that reports "exited" on
    // the Windows side does not always mean the wrapped Linux process actually died — scoped
    // precisely to this handle's own unique home directory, never a name-based pkill.
    runWslText(["pkill", "-f", home]);
  };

  try {
    const init = runWslText([bin, "--home", home, "init", "--chain-id", NEAR_SANDBOX_PIN.chainId, "--fast"]);
    if (init.status !== 0) throw new Error(`near-sandbox helper: init failed: ${init.stdout}\n${init.stderr}`);

    const port = await freePort();
    const networkPort = await freePort();
    // Rewrite config.json's rpc.addr (default "0.0.0.0:3030") AND network.addr (default
    // "0.0.0.0:24567" — see this file's own header comment: a fixed network port crashes a
    // second concurrent sandbox with AddrInUse) to freshly allocated free ports, via
    // `wsl.exe -- tee` (argv, no shell interpolation of the JSON payload).
    const configText = runWslTextOrThrow(["cat", `${home}/config.json`], "reading config.json");
    const config = JSON.parse(configText) as Record<string, unknown>;
    (config.rpc as Record<string, unknown> | undefined) ??= {};
    (config.rpc as Record<string, unknown>).addr = `127.0.0.1:${port}`;
    (config.network as Record<string, unknown> | undefined) ??= {};
    (config.network as Record<string, unknown>).addr = `0.0.0.0:${networkPort}`;
    const teeResult = spawnSync("wsl.exe", ["-d", WSL_DISTRO, "--", "tee", `${home}/config.json`], {
      input: JSON.stringify(config),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (teeResult.status !== 0) throw new Error(`near-sandbox helper: rewriting config.json failed: ${teeResult.stderr}`);

    // D-N2: read test.near's own secret key exactly once, straight into memory — never logged,
    // never written to disk on the Windows side (see this file's own header comment).
    const validatorKeyJson = runWslTextOrThrow(["cat", `${home}/validator_key.json`], "reading validator_key.json");
    const validatorKey = JSON.parse(validatorKeyJson) as { account_id: string; public_key: string; secret_key: string };
    if (validatorKey.account_id !== "test.near") {
      throw new Error(`near-sandbox helper: unexpected validator account id "${validatorKey.account_id}" (expected "test.near")`);
    }
    const rootSigner = InMemoryNearSigner.fromNearSecretKey(validatorKey.account_id, validatorKey.secret_key);
    if (rootSigner.publicKey !== validatorKey.public_key) {
      throw new Error("near-sandbox helper: derived test.near public key does not match validator_key.json's own public_key (secret-key format assumption is wrong)");
    }

    child = spawn("wsl.exe", ["-d", WSL_DISTRO, "--", bin, "--home", home, "run"], { stdio: "ignore" });
    const spawnError = await new Promise<Error | null>((resolveSpawn) => {
      child?.once("error", (error) => resolveSpawn(error));
      setTimeout(() => resolveSpawn(null), 200);
    });
    if (spawnError !== null) throw new Error(`near-sandbox helper: "${bin}" failed to start: ${spawnError.message}`);

    const endpoint = `http://127.0.0.1:${port}`;
    const setupRpc = new CapturingRpc({ endpoint });
    const near = new NearRpc(setupRpc);

    // Poll status until ready (mirrors bitcoind.ts's waitForRpcReady).
    {
      const deadline = Date.now() + 20_000;
      let lastError: unknown;
      for (;;) {
        try {
          const status = await near.status();
          if (status.chainId !== NEAR_SANDBOX_PIN.chainId) {
            throw new Error(`near-sandbox helper: live chain id "${status.chainId}" does not match the configured "${NEAR_SANDBOX_PIN.chainId}" (D-N3)`);
          }
          break;
        } catch (error) {
          lastError = error;
          if (Date.now() >= deadline) throw new Error(`near-sandbox helper: node at ${endpoint} never answered status (last error: ${String(lastError)})`);
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      setupRpc.drain();
    }

    const htlcWasm = new Uint8Array(runWslBinary(["cat", htlcWasmPath]));
    const mockFtWasm = new Uint8Array(runWslBinary(["cat", mockFtWasmPath]));

    const usdcSigner = await createSubAccount(near, rootSigner, "usdc.test.near", 50n * ONE_NEAR, {
      wasm: mockFtWasm,
      methodName: "new",
      args: { owner_id: "usdc.test.near" },
      gas: 100n * TGAS,
    });
    const htlcSigner = await createSubAccount(near, rootSigner, "htlc.test.near", 50n * ONE_NEAR, {
      wasm: htlcWasm,
      methodName: "new",
      args: { usdc_token: "usdc.test.near" },
      gas: 100n * TGAS,
    });
    const buyerSigner = await createSubAccount(near, rootSigner, "buyer.test.near", 20n * ONE_NEAR);
    const sellerSigner = await createSubAccount(near, rootSigner, "seller.test.near", 20n * ONE_NEAR);

    // Storage-register buyer, seller, and the HTLC contract itself on the token (D-N10: a
    // "locked" verdict must also prove the payout can land; the contract's own `claim`/`refund`
    // pay OUT of its own balance via `ft_transfer` to buyer/seller, so both need registering, and
    // the HTLC account itself never needs to hold a balance but registering costs nothing extra
    // to skip — omitted deliberately: `ft_transfer_call`'s receiver is the HTLC contract, which
    // near-contract-standards' own `ft_transfer_call` path registers implicitly via the sender's
    // `ft_on_transfer` promise chain only if the receiver already exists as a NEP-141 account;
    // register it explicitly here so the very first lock never fails on this).
    const STORAGE_DEPOSIT_YOCTO = ONE_NEAR / 20n; // 0.05 NEAR — comfortably above NEP-145's bounds.min
    for (const [accountId, signer] of [
      ["buyer.test.near", buyerSigner],
      ["seller.test.near", sellerSigner],
      ["htlc.test.near", htlcSigner],
    ] as const) {
      await callSetup(near, signer, accountId, "usdc.test.near", "storage_deposit", {}, 30n * TGAS, STORAGE_DEPOSIT_YOCTO);
    }

    const buyerMintAmount = options.buyerMintAmount ?? "1000000000";
    await callSetup(near, usdcSigner, "usdc.test.near", "usdc.test.near", "mint", { account_id: "buyer.test.near", amount: buyerMintAmount }, 30n * TGAS, 0n);

    // H6: once every setup step that needed the HTLC contract account's own (throwaway) key has
    // run, remove that key — `NearHtlcRail.connect()` refuses to trust a deployed contract's code
    // as the reviewed wasm unless the account holds ZERO access keys (a key left in place could
    // redeploy the contract to different code at any later moment). This must be the LAST setup
    // action taken with `htlcSigner` — nothing below this point ever signs with it again.
    await sendSetupTx(near, htlcSigner, "htlc.test.near", "htlc.test.near", [
      { type: "DeleteKey", publicKey: { keyType: "ED25519", data: htlcSigner.publicKeyRaw() } },
    ]);

    // H6: the config's own pinned code hash — base58 of the raw sha256 of the exact wasm bytes
    // just deployed (matches `sandbox_patch_state`'s own convention per NB0; `view_account`'s
    // live `code_hash` is compared against this by `NearHtlcRail.connect()`).
    const htlcCodeHash = base58.encode(sha256(htlcWasm));

    const config2: NearRailConfig = {
      pin: NEAR_SANDBOX_PIN,
      endpoint,
      contract: "htlc.test.near",
      assets: { USDC: "usdc.test.near" },
      htlcCodeHash,
    };

    return {
      endpoint,
      config: config2,
      buyer: { accountId: "buyer.test.near", signer: buyerSigner },
      seller: { accountId: "seller.test.near", signer: sellerSigner },
      usdcToken: "usdc.test.near",
      htlcContract: "htlc.test.near",
      createCapturingRpc: (rpcOptions) => new CapturingRpc({ endpoint, ...rpcOptions }),
      fastForward: async (blocks) => {
        const before = await near.block({ finality: "final" });
        await setupRpc.request({ method: "sandbox_fast_forward", params: { delta_height: blocks } });
        const deadline = Date.now() + 30_000;
        for (;;) {
          const after = await near.block({ finality: "final" });
          if (after.header.height >= before.header.height + blocks) break;
          if (Date.now() >= deadline) throw new Error("near-sandbox helper: fastForward did not advance the final block height in time");
          await new Promise((r) => setTimeout(r, 200));
        }
        setupRpc.drain();
      },
      usdcBalanceOf: async (accountId) => {
        const result = await near.callFunction("usdc.test.near", "ft_balance_of", { account_id: accountId });
        setupRpc.drain();
        return JSON.parse(result.resultText) as string;
      },
      createUnregisteredAccount: async (accountId) => {
        const signer = await createSubAccount(near, rootSigner, accountId, 20n * ONE_NEAR);
        setupRpc.drain();
        return { accountId, signer };
      },
      createFundedAccount: async (accountId) => {
        const signer = await createSubAccount(near, rootSigner, accountId, 20n * ONE_NEAR);
        await callSetup(near, signer, accountId, "usdc.test.near", "storage_deposit", {}, 30n * TGAS, STORAGE_DEPOSIT_YOCTO);
        setupRpc.drain();
        return { accountId, signer };
      },
      mintUsdc: async (accountId, amount) => {
        await callSetup(near, usdcSigner, "usdc.test.near", "usdc.test.near", "mint", { account_id: accountId, amount }, 30n * TGAS, 0n);
        setupRpc.drain();
      },
      deployUnlockedHtlcClone: async (accountId) => {
        await createSubAccount(near, rootSigner, accountId, 50n * ONE_NEAR, {
          wasm: htlcWasm,
          methodName: "new",
          args: { usdc_token: "usdc.test.near" },
          gas: 100n * TGAS,
        });
        setupRpc.drain();
        return { contract: accountId, codeHash: htlcCodeHash };
      },
      stop: async () => {
        await stopChild();
        await cleanupHome();
      },
    };
  } catch (error) {
    await stopChild();
    await cleanupHome();
    throw error;
  }
}
