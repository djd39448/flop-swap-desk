// SPDX-License-Identifier: MIT
//
// tests-anvil/helpers/anvil.ts — P22-P24-EVM-SPEC.md §2.3: finds and spawns a local anvil
// node for the anvil-only test suite (`npm run test:anvil`), never used by the hermetic `npm
// test`. Resolution order: `ANVIL_BIN` env, then `%USERPROFILE%\.foundry\bin\anvil(.exe)`
// (Dave's machine), then bare `anvil` on PATH. A missing/unspawnable binary, or a node that
// never answers `eth_chainId`, throws a clear error — `startAnvil` is normally called from a
// `beforeAll`, so that failure fails the whole anvil test file with an obvious cause rather
// than a mysterious timeout deep in some other call.
//
// `--slots-in-an-epoch 1` (anvil 1.8.3, verified 2026-09-28 against a live instance): with one
// slot per epoch, anvil reports `safe = latest − 1`, `finalized = latest − 2`. `ANVIL_LOCAL_PIN`
// (src/rails/evm-htlc.ts) assumes exactly this.
//
// Also deploys `contracts/EvmHashRail.sol` and `contracts/mocks/MockERC20.sol` straight from
// forge's own `out/**/*.json` build output, over the bare JSON-RPC surface (no viem, no key —
// `eth_sendTransaction` from one of anvil's unlocked accounts by address, same as the desk
// adapter itself does; see D-10 in the spec).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

function resolveAnvilBin(): string {
  const fromEnv = process.env.ANVIL_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home !== undefined && home !== "") {
    const candidate = join(home, ".foundry", "bin", platform === "win32" ? "anvil.exe" : "anvil");
    if (existsSync(candidate)) return candidate;
  }
  return "anvil"; // resolved via PATH by the OS/child_process itself
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
        reject(new Error("anvil helper: could not allocate a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

interface JsonRpcResponse<T> { result?: T; error?: { code: number; message: string } }

async function rpcCall<T = unknown>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function waitForChainId(endpoint: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const hex = await rpcCall<string>(endpoint, "eth_chainId", []);
      return Number.parseInt(hex, 16);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`anvil helper: node at ${endpoint} never answered eth_chainId (last error: ${String(lastError)})`);
}

export interface AnvilHandle {
  endpoint: string;
  chainId: number;
  /** Every address anvil starts unlocked (`eth_accounts`), lowest index first. */
  accounts: `0x${string}`[];
  rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

export interface StartAnvilOptions {
  /** Genesis timestamp in whole seconds. Default: a fixed 2023-11-14 instant, well before any
   *  fixture's `claimByMs`/`refundAfterMs` unless the caller means to test a real time warp. */
  timestampSeconds?: number;
  /** Passed as `--chain-id` when set (anvil otherwise reports 31337). */
  chainId?: number;
}

/** Spawn one anvil node on a free port, wait for it to answer, and hand back a handle whose
 *  `stop()` kills only this one child process (never anything found by image name). */
export async function startAnvil(options: StartAnvilOptions = {}): Promise<AnvilHandle> {
  const bin = resolveAnvilBin();
  const port = await freePort();
  const timestampSeconds = options.timestampSeconds ?? 1_700_000_000;
  const args = ["--port", String(port), "--slots-in-an-epoch", "1", "--timestamp", String(timestampSeconds)];
  if (options.chainId !== undefined) args.push("--chain-id", String(options.chainId));

  let child: ChildProcess;
  try {
    child = spawn(bin, args, { stdio: "ignore" });
  } catch (error) {
    throw new Error(
      `anvil helper: could not spawn "${bin}" (set ANVIL_BIN, or put anvil on PATH — see .foundry/bin): ${String(error)}`,
    );
  }
  const spawnError = await new Promise<Error | null>((resolveSpawn) => {
    child.once("error", (error) => resolveSpawn(error));
    // No 'error' within a short grace period means the process actually started.
    setTimeout(() => resolveSpawn(null), 200);
  });
  if (spawnError !== null) {
    throw new Error(`anvil helper: "${bin}" failed to start: ${spawnError.message}`);
  }

  const endpoint = `http://127.0.0.1:${port}`;
  let chainId: number;
  try {
    chainId = await waitForChainId(endpoint, 20_000);
  } catch (error) {
    child.kill();
    throw error;
  }
  const accounts = await rpcCall<`0x${string}`[]>(endpoint, "eth_accounts", []);

  let stopped = false;
  return {
    endpoint,
    chainId,
    accounts,
    rpcCall: (method, params) => rpcCall(endpoint, method, params),
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(resolveStop, 3000); // never hang the suite on a stuck child
        child.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
        child.kill();
      });
    },
  };
}

async function loadForgeBytecode(relativeOutPath: string): Promise<string> {
  const raw = await readFile(join(REPO_ROOT, relativeOutPath), "utf8");
  const parsed = JSON.parse(raw) as { bytecode: { object: string } };
  return parsed.bytecode.object;
}

async function deployBytecode(endpoint: string, deployer: `0x${string}`, bytecode: string): Promise<`0x${string}`> {
  const hash = await rpcCall<`0x${string}`>(endpoint, "eth_sendTransaction", [{ from: deployer, data: bytecode }]);
  for (;;) {
    const receipt = await rpcCall<{ status: string; contractAddress: `0x${string}` } | null>(
      endpoint,
      "eth_getTransactionReceipt",
      [hash],
    );
    if (receipt !== null) {
      if (receipt.status !== "0x1") throw new Error(`anvil helper: deploy tx ${hash} reverted on-chain`);
      return receipt.contractAddress;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface DeployedContracts {
  railContract: `0x${string}`;
  tokenContract: `0x${string}`;
}

/** Deploys `EvmHashRail` and `MockERC20` from forge's `out/` build output (run `forge build`
 *  first — `npm run test:anvil` always does). Uses only a bare `eth_sendTransaction` from one
 *  of anvil's own unlocked accounts: no key, no viem, same as the rest of this harness. */
export async function deployRailContracts(endpoint: string, deployer: `0x${string}`): Promise<DeployedContracts> {
  const [railBytecode, tokenBytecode] = await Promise.all([
    loadForgeBytecode("out/EvmHashRail.sol/EvmHashRail.json"),
    loadForgeBytecode("out/MockERC20.sol/MockERC20.json"),
  ]);
  const railContract = await deployBytecode(endpoint, deployer, railBytecode);
  const tokenContract = await deployBytecode(endpoint, deployer, tokenBytecode);
  return { railContract, tokenContract };
}
