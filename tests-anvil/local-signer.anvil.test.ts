// SPDX-License-Identifier: MIT
//
// tests-anvil/local-signer.anvil.test.ts - P9-1 (handoff/P9-G1-READINESS-SPEC.md): the Buyer and Seller flows end to end on a
// real anvil node with LOCAL accounts instead of anvil's unlocked ones. Each party's key is generated at test time (viem
// `generatePrivateKey`), written to a mode-0600 temp file and loaded through the real `loadEvmLocalAccount`
// (tests/helpers/evm-local.ts); anvil's account 0 funds them with ETH and test USDC and signs nothing else. Everything the
// flows then do on chain is signed in this process and sent as `eth_sendRawTransaction`: the settle path, the refund path,
// and the EIP-191 account-line proofs (account.signMessage, no personal_sign) that the Buyer's lock requires to resolve.
// The settled and refunded runs are also written as bundles and replayed through `examples/audit-export.mjs`, and every file
// of the bundle is scanned for the key. `npm run test:anvil` only. The Address-based scenarios stay in
// tests-anvil/client-flows.anvil.test.ts, unchanged.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, paperNote, verifyHashPreimage } from "@flop-labs/tclk";
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { resolveAccounts } from "../src/rails/account-line.js";
import { ANVIL_LOCAL_PIN, EvmHtlcRail, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc, type Exchange } from "../src/rails/rpc-capture.js";
import { makeLocalAccountWithScan } from "../tests/helpers/evm-local.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

const GENESIS_SECONDS = 1_700_000_000;
const GENESIS_MS = GENESIS_SECONDS * 1_000;

const TOKEN_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** The same deadlines tests-anvil/client-flows.anvil.test.ts uses (both satisfy EVM_LOCAL_POLICY). */
function legADeadlines(t0: number) {
  return { claimByMs: t0 + 60 * 60_000, refundAfterMs: t0 + 90 * 60_000, expiresMs: t0 + 30 * 60_000 };
}
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 120 * 60_000, refundAfterMs: t0 + 180 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

interface Party {
  identity: Identity;
  account: LocalAccount;
  rpc: CapturingRpc;
}

describe("Seller/Buyer client flows with LOCAL accounts against a real anvil node", () => {
  let anvil: AnvilHandle;
  let funder: Address;
  let config: EvmRailConfig;
  let tokenContract: Address;
  const roots: string[] = [];

  beforeAll(async () => {
    anvil = await startAnvil({ timestampSeconds: GENESIS_SECONDS });
    const [first] = anvil.accounts;
    if (first === undefined) throw new Error("test setup: anvil did not expose an account");
    funder = first;
    const deployed = await deployRailContracts(anvil.endpoint, funder);
    tokenContract = deployed.tokenContract;
    config = { pin: ANVIL_LOCAL_PIN, endpoint: anvil.endpoint, contract: deployed.railContract, assets: { USDC: tokenContract } };
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
    await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function waitForReceipt(hash: Hex): Promise<void> {
    for (;;) {
      const receipt = await anvil.rpcCall<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
      if (receipt !== null) {
        if (receipt.status !== "0x1") throw new Error("test setup: a funding transaction reverted");
        return;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  /** Anvil's account 0 (unlocked) pays 10 ETH and mints 100 test USDC to an address; nothing else of anvil's is used. */
  async function fund(to: Address): Promise<void> {
    await waitForReceipt(await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: funder, to, value: "0x8ac7230489e80000" }]));
    const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "mint", args: [to, 100_000_000n] });
    await waitForReceipt(await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: funder, to: tokenContract, data }]));
  }

  async function tokenBalance(who: Address): Promise<bigint> {
    const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: "balanceOf", args: [who] });
    return BigInt(await anvil.rpcCall<Hex>("eth_call", [{ to: tokenContract, data }, "latest"]));
  }

  async function ethBalance(who: Address): Promise<bigint> {
    return BigInt(await anvil.rpcCall<Hex>("eth_getBalance", [who, "latest"]));
  }

  async function currentChainTimeMs(): Promise<number> {
    const block = await anvil.rpcCall<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    return Number.parseInt(block.timestamp, 16) * 1_000;
  }

  /** Two fresh local parties (keys generated now, funded now) and one swap's local state, as in the Address-based suite. */
  async function setup(buyerSeed: string, sellerSeed: string) {
    const buyerKeyed = await makeLocalAccountWithScan();
    const sellerKeyed = await makeLocalAccountWithScan();
    await fund(buyerKeyed.account.address);
    await fund(sellerKeyed.account.address);
    const buyer: Party = { identity: identity(buyerSeed.repeat(32)), account: buyerKeyed.account, rpc: new CapturingRpc({ endpoint: anvil.endpoint }) };
    const seller: Party = { identity: identity(sellerSeed.repeat(32)), account: sellerKeyed.account, rpc: new CapturingRpc({ endpoint: anvil.endpoint }) };
    const t0 = await currentChainTimeMs();
    const clockRef = { ms: t0 };
    const clock = () => clockRef.ms;
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const buyerFlow = new BuyerFlow({
      identity: buyer.identity,
      venue,
      paperRail: new PaperRail(noteStore, clock),
      rail: createEvmCounterRail({ config, rpc: buyer.rpc, account: buyer.account, clock }),
      clock,
    });
    const sellerFlow = new SellerFlow({
      identity: seller.identity,
      venue,
      paperRail: new PaperRail(noteStore, clock),
      rail: createEvmCounterRail({ config, rpc: seller.rpc, account: seller.account, clock }),
      clock,
    });
    const leaks = (text: string): boolean => buyerKeyed.leaks(text) || sellerKeyed.leaks(text);

    async function warpTo(nowMs: number): Promise<void> {
      clockRef.ms = nowMs;
      await anvil.rpcCall("evm_setNextBlockTimestamp", [Math.ceil(nowMs / 1000) + 1]);
      await anvil.rpcCall("anvil_mine", ["0x1"]);
    }
    async function mineBlocks(n: number): Promise<void> {
      await anvil.rpcCall("anvil_mine", [`0x${n.toString(16)}`]);
    }

    /** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both PROVEN account lines (signed locally). */
    const swapId = computeSwapId(buyer.identity.did, `0000${buyerSeed}${sellerSeed}`);
    const offerA = await buyerFlow.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legADeadlines(t0) });
    const { acceptA, acceptARecord, offerB, offerBRecord } = await sellerFlow.acceptLegA(offerA, legBDeadlines(t0), t0);
    const { acceptB, acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, t0);
    await sellerFlow.lockLegB(acceptBRecord);
    await buyerFlow.verifyLegBLocked();
    await sellerFlow.postAccountLineA(seller.account.address);
    await buyerFlow.postAccountLineA(buyer.account.address);

    return { buyer, seller, buyerFlow, sellerFlow, venue, noteStore, clock, warpTo, mineBlocks, swapId, offerA, offerB, acceptA, acceptB, leaks };
  }

  /** Writes the bundle (to a fresh mkdtemp directory), scans every file in it for the keys, and replays it with audit-export. */
  async function bundleAndReplay(args: {
    scenario: string;
    swapId: string;
    status: string;
    venue: MemoryVenue;
    acceptAContract: string;
    acceptBContract: string;
    noteStore: MemoryNoteStore;
    hashLock: Hex;
    nowMs: number;
    writes: BundleEvidenceSummary["writes"];
    writeExchanges: readonly Exchange[];
    leaks: (text: string) => boolean;
  }): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), `flop-evm-local-${args.scenario}-`));
    roots.push(root);
    const dealRoomA = dealRoom(args.acceptAContract);
    const dealRoomB = dealRoom(args.acceptBContract);
    const { ns, key } = paperNote(args.acceptBContract);
    const rawNote = args.noteStore.raw(ns, key);
    await writeBundle({
      root,
      nowMs: args.nowMs,
      offerRoomRecords: await args.venue.read(OFFER_ROOM),
      dealRooms: new Map([
        [dealRoomA, await args.venue.read(dealRoomA)],
        [dealRoomB, await args.venue.read(dealRoomB)],
      ]),
      paperNotes: rawNote === undefined ? new Map() : new Map([[args.acceptBContract, rawNote]]),
      writeExchanges: args.writeExchanges,
      evm: { config, rpc: new CapturingRpc({ endpoint: anvil.endpoint }), hashLock: args.hashLock },
      evidence: {
        swapId: args.swapId,
        legA: { contract: args.acceptAContract, rail: "evm-htlc" },
        legB: { contract: args.acceptBContract, rail: "paper" },
        feeBps: 0,
        writes: args.writes,
        startedAtMs: GENESIS_MS,
        finishedAtMs: args.nowMs,
      },
    });

    // Rule 1, end to end: no file the bundle holds carries either key.
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(path)));
        else out.push(path);
      }
      return out;
    };
    const files = await walk(root);
    expect(files.length).toBeGreaterThan(5);
    let leaked = false;
    for (const file of files) if (args.leaks(await readFile(file, "utf8"))) leaked = true;
    expect(leaked).toBe(false); // a boolean: a failure must never print a key

    const replay = await execFileAsync(process.execPath, [join(REPO_ROOT, "examples", "audit-export.mjs"), "--root", root, "--expect", `${args.swapId}=${args.status}`], { cwd: REPO_ROOT }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
    );
    expect(replay.stderr).toBe("");
    expect(replay.code).toBe(0);
  }

  function methodsOf(exchanges: readonly Exchange[]): string[] {
    return exchanges.map((exchange) => exchange.method);
  }

  /** Every write is a raw transaction; nothing was sent through anvil's unlocked-account path; nothing was signed over RPC. The
   *  nonce, gas and fee fields came from viem's defaults over the same CapturingRpc, read one by one: the rail answers
   *  `eth_fillTransaction` itself (R1-FUND-02), so it is never asked of anvil and never captured. */
  function expectLocalSigning(writeExchanges: readonly Exchange[]): void {
    const methods = methodsOf(writeExchanges);
    expect(methods).toContain("eth_sendRawTransaction");
    expect(methods).not.toContain("eth_sendTransaction");
    expect(methods).not.toContain("personal_sign");
    expect(methods).not.toContain("eth_fillTransaction");
    expect(methods).toContain("eth_getTransactionCount");
    expect(methods).toContain("eth_estimateGas");
  }

  it("scenario L1: settled with two local accounts; proofs resolve, writes are raw transactions, bundle replays with no key in it", async () => {
    const s = await setup("61", "62");
    const buyerEthBefore = await ethBalance(s.buyer.account.address);
    const sellerEthBefore = await ethBalance(s.seller.account.address);

    // The EIP-191 account-line proof, signed locally, resolves under the `required` policy for both parties.
    const records = await s.venue.read(dealRoom(s.acceptA.contract));
    const resolved = resolveAccounts(records, {
      contract: s.acceptA.contract,
      payerDid: s.buyer.identity.did,
      payeeDid: s.seller.identity.did,
      rail: "evm-htlc",
      caip2: "eip155:31337",
      proof: { mode: "required" },
    });
    expect(resolved.payer).toBe(s.buyer.account.address.toLowerCase());
    expect(resolved.payee).toBe(s.seller.account.address.toLowerCase());

    const lockA = await s.buyerFlow.lockLegA();
    await s.mineBlocks(2);
    const claimed = await s.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
    await s.mineBlocks(2);
    const secret = await s.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await s.buyerFlow.claimLegB(secret);

    // The chain accepted transactions signed here: the lock and the claim were sent by the two local accounts.
    const lockTx = await anvil.rpcCall<{ from: string; type: string }>("eth_getTransactionByHash", [lockA.writeEvidence.txHash]);
    expect(lockTx.from.toLowerCase()).toBe(s.buyer.account.address.toLowerCase());
    expect(lockTx.type).toBe("0x2");
    const claimTx = await anvil.rpcCall<{ from: string }>("eth_getTransactionByHash", [claimed.evidence.txHash]);
    expect(claimTx.from.toLowerCase()).toBe(s.seller.account.address.toLowerCase());
    expect(await tokenBalance(s.seller.account.address)).toBe(101_000_000n); // minted 100 USDC, then paid 1 USDC by the claim
    expect(await tokenBalance(s.buyer.account.address)).toBe(99_000_000n);
    // Each paid its own gas: both ETH balances went down.
    expect(await ethBalance(s.buyer.account.address)).toBeLessThan(buyerEthBefore);
    expect(await ethBalance(s.seller.account.address)).toBeLessThan(sellerEthBefore);

    expectLocalSigning(s.buyerFlow.exchanges);
    expectLocalSigning(s.sellerFlow.exchanges);

    await bundleAndReplay({
      scenario: "settled",
      swapId: s.swapId,
      status: "settled",
      venue: s.venue,
      acceptAContract: s.acceptA.contract,
      acceptBContract: s.acceptB.contract,
      noteStore: s.noteStore,
      hashLock: lockA.hashLock as Hex,
      nowMs: s.clock(),
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: claimed.evidence },
      ],
      writeExchanges: [...s.buyerFlow.exchanges, ...s.sellerFlow.exchanges],
      leaks: s.leaks,
    });
  }, 60_000);

  it("scenario L2: refunded with two local accounts; the Buyer's refund is a raw transaction by the Buyer's own account", async () => {
    const s = await setup("63", "64");
    const lockA = await s.buyerFlow.lockLegA();
    await s.mineBlocks(2);

    // The Seller never claims. Both windows pass; each party refunds its own leg.
    await s.warpTo(s.offerA.refundAfterMs + 60_000);
    await expect(s.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);
    await s.mineBlocks(2);
    const refundA = await s.buyerFlow.refundLegA();
    expect(refundA.event).toBe("Refunded");
    await s.warpTo(s.offerB.refundAfterMs + 60_000);
    const refundB = await s.sellerFlow.refundLegB();
    expect(refundB.refund).toBeDefined();
    await s.mineBlocks(2);

    const refundTx = await anvil.rpcCall<{ from: string }>("eth_getTransactionByHash", [refundA.txHash]);
    expect(refundTx.from.toLowerCase()).toBe(s.buyer.account.address.toLowerCase());
    expect(await tokenBalance(s.buyer.account.address)).toBe(100_000_000n); // the 1 USDC came back
    expectLocalSigning(s.buyerFlow.exchanges);
    expect(methodsOf(s.sellerFlow.exchanges)).not.toContain("eth_sendRawTransaction"); // the Seller never wrote on EVM here

    await bundleAndReplay({
      scenario: "refunded",
      swapId: s.swapId,
      status: "refunded",
      venue: s.venue,
      acceptAContract: s.acceptA.contract,
      acceptBContract: s.acceptB.contract,
      noteStore: s.noteStore,
      hashLock: lockA.hashLock as Hex,
      nowMs: s.clock(),
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: "evm-htlc", evidence: refundA },
      ],
      writeExchanges: [...s.buyerFlow.exchanges, ...s.sellerFlow.exchanges],
      leaks: s.leaks,
    });
  }, 60_000);

  it("scenario L3: a local account that is not funded cannot send, and nothing is locked", async () => {
    const buyerKeyed = await makeLocalAccountWithScan();
    const rpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const rail = await EvmHtlcRail.connect({ config, rpc, account: buyerKeyed.account, addressBook: { resolve: () => buyerKeyed.account.address }, clock: () => GENESIS_MS });
    await expect(rail.approve("USDC", "1000000")).rejects.toThrow(); // no ETH for gas: the node refuses the raw transaction
    expect(methodsOf(rpc.exchanges())).not.toContain("eth_sendTransaction");
    expect(await tokenBalance(buyerKeyed.account.address)).toBe(0n);
  }, 60_000);
});
