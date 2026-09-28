// SPDX-License-Identifier: MIT
//
// tests-regtest/helpers/bitcoind.ts — P4-BTC-SPEC.md §0/§1/§2: finds and spawns a throwaway,
// single-node `bitcoind -regtest` for the regtest-only suite (`npm run test:regtest`), never
// used by the hermetic `npm test`. Resolution order: `BITCOIND_BIN` env, then
// `C:\Users\trustcore-rdp\tools\bitcoin-core-31.1\bitcoin-31.1\bin\bitcoind(.exe)` (Dave's
// machine), then bare `bitcoind` on PATH. A missing/unspawnable binary throws a clear error —
// `startBitcoind` is normally called from a `beforeAll`, so that failure fails the whole regtest
// file with an obvious cause (spec: "a missing bitcoind FAILS it") rather than a mysterious
// timeout.
//
// Windows gotcha (probe): `-daemon` is not supported on this build, so bitcoind is spawned as an
// ordinary foreground child process (`node:child_process.spawn`, exactly like
// tests-anvil/helpers/anvil.ts spawns anvil) and its own RPC readiness is polled instead of
// waiting for a daemonizing parent to exit.
//
// Keyless (P4-BTC-SPEC.md §1): one node, two named descriptor wallets (`buyer`, `seller`), both
// created with `disable_private_keys: false` so the NODE'S OWN wallet holds and uses every key —
// this module never calls `dumpprivkey`, `dumpwallet`, or `listdescriptors true`, and never
// reads or stores anything but each wallet's own PUBLIC `getaddressinfo` (pubkey, master
// fingerprint, HD path). The node's RPC cookie is read once from the throwaway datadir and
// handed to every caller only as an HTTP Basic-auth header (`CapturingRpc`'s `headers` option,
// or this module's own `rpcCall`) — never logged, never returned as part of any object a test
// might serialize into a fixture or a captured index.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

import { CapturingRpc, type CapturingRpcOptions } from "../../src/rails/rpc-capture.js";

function resolveBitcoindBin(): string {
  const fromEnv = process.env.BITCOIND_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const candidate = "C:\\Users\\trustcore-rdp\\tools\\bitcoin-core-31.1\\bitcoin-31.1\\bin\\bitcoind.exe";
  if (platform === "win32" && existsSync(candidate)) return candidate;
  return "bitcoind"; // resolved via PATH by the OS/child_process itself
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
        reject(new Error("bitcoind helper: could not allocate a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/** Bare JSON-RPC call for this module's own setup work (wallet creation, mining, cookie-auth
 *  plumbing) — deliberately not a `CapturingRpc` (nothing here is evidence a test is checking);
 *  `createCapturingRpc` below hands every regtest test the real capturing transport instead. */
async function rpcCall<T = unknown>(endpoint: string, authHeader: string, method: string, params: unknown[], walletPath?: string): Promise<T> {
  const url = walletPath === undefined ? endpoint : `${endpoint}${walletPath}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as JsonRpcResponse<T>;
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function waitForCookie(cookiePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(cookiePath)) {
      const content = (await readFile(cookiePath, "utf8")).trim();
      if (content.length > 0) return content;
    }
    if (Date.now() >= deadline) {
      throw new Error(`bitcoind helper: cookie file never appeared at ${cookiePath}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForRpcReady(endpoint: string, authHeader: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await rpcCall(endpoint, authHeader, "getblockchaininfo", []);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`bitcoind helper: node at ${endpoint} never answered getblockchaininfo (last error: ${String(lastError)})`);
}

/** One wallet's own public identity, as its own `getaddressinfo` reports it — a compressed
 *  pubkey, a BIP32 master fingerprint, and this address's own HD path. Never a key. Left in
 *  Core's own wire shapes (bare hex fingerprint, `m/84h/1h/0h/0/0`-style path string) rather than
 *  parsed here, so this helper stays independent of src/rails/btc-htlc.ts's own types — a
 *  regtest test converts what it needs with that module's own `keyFromAddressInfo`. */
export interface RegtestWallet {
  wallet: string;
  address: string;
  pubkey: string;
  hdMasterFingerprint: string;
  hdKeyPath: string;
}

export interface BitcoindHandle {
  endpoint: string;
  genesisHash: string;
  buyer: RegtestWallet;
  seller: RegtestWallet;
  /** Bare JSON-RPC call with the node's own cookie auth — `walletPath` (e.g. `"/wallet/buyer"`)
   *  targets that wallet; omitted, the call targets the node directly. */
  rpcCall<T = unknown>(method: string, params: unknown[], walletPath?: string): Promise<T>;
  /** A `CapturingRpc` pre-wired with this node's endpoint and cookie-auth header — what a
   *  regtest test hands to `BtcHtlcRail.connect`/`fund`/`claim`/`refund` so those calls go
   *  through the real capturing transport (P4-BTC-SPEC.md §4). The cookie itself never appears
   *  in anything this returns (see `rpc-capture.ts`'s `headers` option doc). */
  createCapturingRpc(options?: Omit<CapturingRpcOptions, "endpoint" | "headers">): CapturingRpc;
  /** `generatetoaddress(blocks, address)` — node-level, no wallet needed. Defaults to the
   *  buyer's own address when `address` is omitted. Returns the mined block hashes. */
  mine(blocks: number, address?: string): Promise<string[]>;
  setMockTime(unixSeconds: number): Promise<void>;
  /** Stops the one child process this handle spawned (never anything found by image name) and,
   *  unless `KEEP_BITCOIND_DATADIR=1` is set, removes its throwaway datadir. */
  stop(): Promise<void>;
}

export interface StartBitcoindOptions {
  /** Blocks mined to the buyer's own address at startup so `buyer.sendtoaddress` has spendable
   *  funds immediately (coinbase needs 100 confirmations to mature). Default 101. */
  fundingBlocks?: number;
  /** P4-BTC-FIXES-R2.md R2-1: extra `bitcoind` command-line flags appended after this helper's
   *  own fixed set (e.g. `["-mempoolexpiry=1"]` for a test that needs a real mempool eviction) —
   *  never used for anything key-related (P4-BTC-SPEC.md §1 still applies in full). */
  extraArgs?: string[];
}

/**
 * Spawn one throwaway `bitcoind -regtest` node with a fresh datadir under `os.tmpdir()`, wait
 * for it to answer RPC, create the `buyer`/`seller` descriptor wallets, and mine enough blocks
 * for the buyer to have spendable funds. Mirrors tests-anvil/helpers/anvil.ts's shape and
 * lifecycle (resolve binary → spawn → poll ready → hand back a typed handle with its own
 * `stop()`) for the Bitcoin side of the same test architecture.
 */
export async function startBitcoind(options: StartBitcoindOptions = {}): Promise<BitcoindHandle> {
  const bin = resolveBitcoindBin();
  const rpcPort = await freePort();
  const datadir = await mkdtemp(join(tmpdir(), "flop-swap-desk-btc-regtest-"));

  const args = [
    "-regtest",
    "-server=1",
    "-listen=0", // no p2p peers needed for a single throwaway node — also means no -port to allocate
    "-txindex=1", // required to getrawtransaction an arbitrary (non-wallet) txid, e.g. the HTLC funding tx
    "-fallbackfee=0.0002",
    `-datadir=${datadir}`,
    `-rpcport=${rpcPort}`,
    "-rpcbind=127.0.0.1",
    "-rpcallowip=127.0.0.1",
    ...(options.extraArgs ?? []),
  ];

  let child: ChildProcess;
  try {
    child = spawn(bin, args, { stdio: "ignore" });
  } catch (error) {
    throw new Error(
      `bitcoind helper: could not spawn "${bin}" (set BITCOIND_BIN, or install Bitcoin Core 31.1 at the tools path — see P4-BTC-SPEC.md §0): ${String(error)}`,
    );
  }
  const spawnError = await new Promise<Error | null>((resolveSpawn) => {
    child.once("error", (error) => resolveSpawn(error));
    setTimeout(() => resolveSpawn(null), 200); // no 'error' within a grace period means it started
  });
  if (spawnError !== null) {
    await rm(datadir, { recursive: true, force: true });
    throw new Error(`bitcoind helper: "${bin}" failed to start: ${spawnError.message}`);
  }

  let stopped = false;
  const stopChild = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(resolveStop, 5000); // never hang the suite on a stuck child
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      child.kill();
    });
  };

  const endpoint = `http://127.0.0.1:${rpcPort}`;
  const cookiePath = join(datadir, "regtest", ".cookie");
  let authHeader: string;
  try {
    const cookie = await waitForCookie(cookiePath, 20_000);
    authHeader = `Basic ${Buffer.from(cookie).toString("base64")}`;
    await waitForRpcReady(endpoint, authHeader, 20_000);
  } catch (error) {
    await stopChild();
    await rm(datadir, { recursive: true, force: true });
    throw error;
  }

  try {
    const genesisHash = await rpcCall<string>(endpoint, authHeader, "getblockhash", [0]);

    async function createWallet(name: string): Promise<RegtestWallet> {
      await rpcCall(endpoint, authHeader, "createwallet", [name, false, false, "", false, true]);
      const address = await rpcCall<string>(endpoint, authHeader, "getnewaddress", ["", "bech32"], `/wallet/${name}`);
      const info = await rpcCall<{ pubkey: string; hdmasterfingerprint: string; hdkeypath: string }>(
        endpoint,
        authHeader,
        "getaddressinfo",
        [address],
        `/wallet/${name}`,
      );
      return { wallet: name, address, pubkey: info.pubkey, hdMasterFingerprint: info.hdmasterfingerprint, hdKeyPath: info.hdkeypath };
    }

    const buyer = await createWallet("buyer");
    const seller = await createWallet("seller");

    const fundingBlocks = options.fundingBlocks ?? 101;
    await rpcCall(endpoint, authHeader, "generatetoaddress", [fundingBlocks, buyer.address]);

    return {
      endpoint,
      genesisHash,
      buyer,
      seller,
      rpcCall: (method, params, walletPath) => rpcCall(endpoint, authHeader, method, params, walletPath),
      createCapturingRpc: (rpcOptions) => new CapturingRpc({ endpoint, headers: () => ({ Authorization: authHeader }), ...rpcOptions }),
      mine: (blocks, address) => rpcCall(endpoint, authHeader, "generatetoaddress", [blocks, address ?? buyer.address]),
      setMockTime: (unixSeconds) => rpcCall(endpoint, authHeader, "setmocktime", [unixSeconds]),
      stop: async () => {
        await stopChild();
        if (process.env.KEEP_BITCOIND_DATADIR !== "1") {
          await rm(datadir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await stopChild();
    await rm(datadir, { recursive: true, force: true });
    throw error;
  }
}
