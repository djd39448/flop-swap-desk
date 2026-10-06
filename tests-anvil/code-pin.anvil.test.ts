// SPDX-License-Identifier: MIT
//
// tests-anvil/code-pin.anvil.test.ts - P9-2 (handoff/P9-G1-READINESS-SPEC.md, rule 2): the contract code pin against a real anvil node.
//   - bin/evm-code-hash.mjs, spawned against the node, prints the keccak256 of the deployed contract's runtime code and its length,
//     the very hash the forge build of contracts/EvmHashRail.sol reports (so the value PROVENANCE.md records is the value a
//     deployment of this source shows on chain), and exits 3 on an address with no code;
//   - a config that carries that hash runs a whole swap to `settled` (every connect reads the code, every capture records the read), and
//     the bundle replays offline through examples/audit-export.mjs under the same pin;
//   - a config that carries a wrong hash is refused at connect before any write (no block is mined), by the adapter and by a flow's rail;
//   - the same bundle replayed under a wrong pin does not fold to settled (the evidence reader fails closed on the code).
// `npm run test:anvil` only. The other anvil files keep their unpinned configs on purpose: an anvil config without the field still works.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, generateHashLock, paperNote, verifyHashPreimage } from "@flop-labs/tclk";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { ANVIL_LOCAL_PIN, EvmContractCodeError, EvmHtlcRail, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { identity } from "../tests/helpers/identity.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const GENESIS_SECONDS = 1_700_000_000;
const GENESIS_MS = GENESIS_SECONDS * 1_000;
const WRONG_HASH = `0x${"ab".repeat(32)}` as Hex;

const MINT_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(script: string, args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(REPO_ROOT, script), ...args], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("the contract code pin against a real anvil node", () => {
  let anvil: AnvilHandle;
  let railContract: Address;
  let tokenContract: Address;
  let buyerAccount: Address;
  let sellerAccount: Address;
  let runtimeCode: Hex;
  let pinnedConfig: EvmRailConfig;
  const roots: string[] = [];

  beforeAll(async () => {
    anvil = await startAnvil({ timestampSeconds: GENESIS_SECONDS });
    const [first, second] = anvil.accounts;
    if (first === undefined || second === undefined) throw new Error("test setup: anvil did not expose two accounts");
    buyerAccount = first;
    sellerAccount = second;
    const deployed = await deployRailContracts(anvil.endpoint, buyerAccount);
    railContract = deployed.railContract;
    tokenContract = deployed.tokenContract;
    runtimeCode = await anvil.rpcCall<Hex>("eth_getCode", [railContract, "latest"]);
    // The hash a deployer reads off the chain, computed here from eth_getCode exactly as bin/evm-code-hash.mjs does.
    pinnedConfig = { pin: ANVIL_LOCAL_PIN, endpoint: anvil.endpoint, contract: railContract, assets: { USDC: tokenContract }, contractCodeHash: keccak256(runtimeCode) };

    const data = encodeFunctionData({ abi: MINT_ABI, functionName: "mint", args: [buyerAccount, 100_000_000n] });
    const hash = await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: buyerAccount, to: tokenContract, data }]);
    for (;;) {
      const receipt = await anvil.rpcCall<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
      if (receipt !== null) break;
      await new Promise((r) => setTimeout(r, 30));
    }
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
    await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function blockNumber(): Promise<bigint> {
    return BigInt(await anvil.rpcCall<Hex>("eth_blockNumber", []));
  }

  it("bin/evm-code-hash.mjs prints the keccak256 and length of the deployed runtime code, the hash forge's build reports", async () => {
    const result = await run("bin/evm-code-hash.mjs", [anvil.endpoint, railContract]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`keccak256 ${keccak256(runtimeCode)}\nbytes ${(runtimeCode.length - 2) / 2}\n`);

    // The build output the anvil helper deployed from: its `deployedBytecode` is the runtime code, so the chain must agree with it.
    const artifact = JSON.parse(await readFile(join(REPO_ROOT, "out", "EvmHashRail.sol", "EvmHashRail.json"), "utf8")) as { deployedBytecode: { object: Hex } };
    expect(keccak256(artifact.deployedBytecode.object)).toBe(keccak256(runtimeCode));
  });

  it("bin/evm-code-hash.mjs exits 3 with nothing on stdout for an address with no code (an anvil account)", async () => {
    const result = await run("bin/evm-code-hash.mjs", [anvil.endpoint, sellerAccount]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/no code at/);
  });

  it("connect with the hash of the deployed contract succeeds; with a wrong hash it throws EvmContractCodeError before any write", async () => {
    const good = await EvmHtlcRail.connect({
      config: pinnedConfig,
      rpc: new CapturingRpc({ endpoint: anvil.endpoint }),
      account: buyerAccount,
      addressBook: { resolve: () => sellerAccount },
    });
    expect(good).toBeInstanceOf(EvmHtlcRail);

    const before = await blockNumber();
    const error = await EvmHtlcRail.connect({
      config: { ...pinnedConfig, contractCodeHash: WRONG_HASH },
      rpc: new CapturingRpc({ endpoint: anvil.endpoint }),
      account: buyerAccount,
      addressBook: { resolve: () => sellerAccount },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmContractCodeError);
    expect((error as EvmContractCodeError).problem).toBe("mismatch");
    expect((error as EvmContractCodeError).observed).toBe(keccak256(runtimeCode));
    expect(await blockNumber(), "nothing was sent: no block was mined").toBe(before);

    // And through a flow's own rail (the first thing every flow step does).
    const rail = createEvmCounterRail({ config: { ...pinnedConfig, contractCodeHash: WRONG_HASH }, rpc: new CapturingRpc({ endpoint: anvil.endpoint }), account: buyerAccount, clock: () => GENESIS_MS });
    const terms = { contract: `0x${"11".repeat(32)}`, lock: "hash" as const, statement: generateHashLock().hash, amount: "1000000", asset: "USDC", payer: "did:key:zB", payee: "did:key:zS", claimByMs: GENESIS_MS + 3_600_000, refundAfterMs: GENESIS_MS + 5_400_000 };
    await expect(rail.connect(terms, { payee: sellerAccount, payer: buyerAccount })).rejects.toBeInstanceOf(EvmContractCodeError);
    expect(await blockNumber()).toBe(before);
  });

  it("a whole swap under the pin settles, and its bundle replays offline under the pin (settled) and under a wrong pin (not settled)", async () => {
    const buyer = identity("41".repeat(32));
    const seller = identity("42".repeat(32));
    const latest = await anvil.rpcCall<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    const t0 = Number.parseInt(latest.timestamp, 16) * 1_000;
    const clock = () => t0;
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const buyerRpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const sellerRpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const buyerFlow = new BuyerFlow({ identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: createEvmCounterRail({ config: pinnedConfig, rpc: buyerRpc, account: buyerAccount, clock }), clock });
    const sellerFlow = new SellerFlow({ identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail: createEvmCounterRail({ config: pinnedConfig, rpc: sellerRpc, account: sellerAccount, clock }), clock });

    const swapId = computeSwapId(buyer.did, "000000a1");
    const offerA = await buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      claimByMs: t0 + 60 * 60_000,
      refundAfterMs: t0 + 90 * 60_000,
      expiresMs: t0 + 30 * 60_000,
    });
    const legB = { claimByMs: t0 + 120 * 60_000, refundAfterMs: t0 + 180 * 60_000, expiresMs: t0 + 40 * 60_000 };
    const { acceptA, acceptARecord, offerBRecord } = await sellerFlow.acceptLegA(offerA, legB, t0);
    const { acceptB, acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, t0);
    await sellerFlow.lockLegB(acceptBRecord);
    await buyerFlow.verifyLegBLocked();
    await sellerFlow.postAccountLineA(sellerAccount);
    await buyerFlow.postAccountLineA(buyerAccount);

    const lockA = await buyerFlow.lockLegA();
    await anvil.rpcCall("anvil_mine", ["0x2"]);
    const claimed = await sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
    await anvil.rpcCall("anvil_mine", ["0x2"]);
    const secret = await buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await buyerFlow.claimLegB(secret);

    const root = await mkdtemp(join(tmpdir(), "flop-evm-codepin-"));
    roots.push(root);
    const dealRoomA = dealRoom(acceptA.contract);
    const dealRoomB = dealRoom(acceptB.contract);
    const { ns, key } = paperNote(acceptB.contract);
    const rawNote = noteStore.raw(ns, key);
    const summary: BundleEvidenceSummary = {
      swapId,
      legA: { contract: acceptA.contract, rail: "evm-htlc" },
      legB: { contract: acceptB.contract, rail: "paper" },
      feeBps: 0,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: claimed.evidence },
      ],
      startedAtMs: GENESIS_MS,
      finishedAtMs: clock(),
    };
    await writeBundle({
      root,
      nowMs: clock(),
      offerRoomRecords: await venue.read(OFFER_ROOM),
      dealRooms: new Map([
        [dealRoomA, await venue.read(dealRoomA)],
        [dealRoomB, await venue.read(dealRoomB)],
      ]),
      paperNotes: rawNote === undefined ? new Map() : new Map([[acceptB.contract, rawNote]]),
      writeExchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges],
      evm: { config: pinnedConfig, rpc: new CapturingRpc({ endpoint: anvil.endpoint }), hashLock: lockA.hashLock },
      evidence: summary,
    });

    const rails = JSON.parse(await readFile(join(root, "rails.json"), "utf8")) as { evm: EvmRailConfig };
    expect(rails.evm.contractCodeHash).toBe(keccak256(runtimeCode));
    // The capture of leg A's lock holds the code read, right after the chain id, as bytes an auditor can re-derive the verdict from.
    const captureDir = join(root, "raw", "evm", lockA.hashLock);
    const [captureFile] = await readdir(captureDir);
    const index = JSON.parse(await readFile(join(captureDir, captureFile ?? ""), "utf8")) as { exchanges: Array<{ method: string; params: unknown }> };
    expect(index.exchanges.map((exchange) => exchange.method).slice(0, 2)).toEqual(["eth_chainId", "eth_getCode"]);
    expect(index.exchanges[1]?.params).toEqual([railContract, "latest"]);

    const settled = await run("examples/audit-export.mjs", ["--root", root, "--expect", `${swapId}=settled`]);
    expect(settled.stderr).toBe("");
    expect(settled.code).toBe(0);

    // The same bytes under an auditor config whose pin names other code: the evidence reader fails closed, the swap is not settled.
    const wrongRails = join(root, "wrong-pin-rails.json");
    await writeFile(wrongRails, `${JSON.stringify({ evm: { ...rails.evm, contractCodeHash: WRONG_HASH } }, null, 2)}\n`);
    const refused = await run("examples/audit-export.mjs", ["--root", root, "--rails", wrongRails, "--expect", `${swapId}=settled`]);
    expect(refused.code, `audit-export under a wrong pin must not report settled: ${refused.stdout}${refused.stderr}`).not.toBe(0);
    expect(refused.stderr).toMatch(/= settled, got /);
    expect(refused.stdout).toMatch(/evidence a: railVerified=null \(evm-htlc: capture was taken without the auditor's contractCodeHash pin/);
  }, 60_000);
});
