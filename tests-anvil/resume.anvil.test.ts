// SPDX-License-Identifier: MIT
//
// tests-anvil/resume.anvil.test.ts - P8-RESUME-SPEC.md "Tests", the anvil part: a Seller or a Buyer process dies at an awkward
// instant of a swap on a real anvil node, a fresh process resumes the swap from its FileFlowStore directory alone, and the swap
// ends in the right status, replayed offline with `examples/audit-export.mjs --expect` exactly as tests-anvil/client-flows does.
//
// A "process" is a flow instance with its own rail, its own `CapturingRpc` (whose `fetch` is a counter, so a test can say "this
// process sent no second lock") and its own `PaperRail`. A crash drops it. Everything else is the world the processes share: the
// venue, the paper note store, the chain and the clock. The two parties keep their records in two directories, as two real
// processes would, each through a `FileFlowStore` (temp file, fsync, rename) wrapped by a `RecordingStore` that keeps the text of
// every save so the secret scan (rule 5) covers the whole run.
//
// The cuts (the kinds of crash are the spec's; each is its own test):
//   1  after `commitLock` returned, before the lock frame, with the store never told (approve and lock are on chain, the process
//      died holding the answer): the restart reads `locks(hashLock)`, finds its own row, posts the lock frame once, sends nothing.
//   1b after `commitLock`, the store told, the lock frame post dies: the restart posts the saved frame once.
//   2  after the claim landed, the reveal frame post dies on every attempt: the restart finds its own preimage in the `Claimed`
//      log, posts the reveal and the receipt once, sends no second claim.
//   2b after the claim landed, the process dies holding the reply (nothing was posted at all): same recovery.
//   3  after the refund landed, the process dies holding the reply (EVM keeps no refund handle): the restart reads `Refunded`,
//      posts the refund and receipt frames once, sends no second refund.
//   3b after the refund is recorded and final, the refund frame post dies: the restart posts the frames once.
// `npm run test:anvil` only; `npm test` never spawns anvil.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, generateHashLock, paperNote, tryDecodeFrame, verifyHashPreimage, type HashLock, type TranscriptRecord } from "@flop-labs/tclk";
import { encodeFunctionData, toEventSelector, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow, type BuyerFlowOptions } from "../src/client/buyer.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { FileFlowStore, type FlowStore } from "../src/client/flow-store.js";
import { SellerFlow, type SellerFlowOptions } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc, type Exchange } from "../src/rails/rpc-capture.js";
import { assertSavesClean, countingFetch, RecordingStore, swapProblems, type CountingFetch, type Outcome } from "../tests/helpers/live-resume.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { crashRail, failVenuePosts } from "../tests/helpers/resume-flows.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/** Every scenario's own bundle directory and store directories, removed in `afterAll` (`KEEP_ANVIL_BUNDLES=1` keeps them). */
const scratch: string[] = [];

async function scratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `flop-resume-anvil-${label}-`));
  scratch.push(dir);
  return dir;
}

const MOCK_ERC20_MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

async function waitForReceipt(anvil: AnvilHandle, hash: Hex): Promise<{ status: string }> {
  for (;;) {
    const receipt = await anvil.rpcCall<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) return receipt;
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function mint(anvil: AnvilHandle, token: Address, to: Address, amount: bigint): Promise<void> {
  const data = encodeFunctionData({ abi: MOCK_ERC20_MINT_ABI, functionName: "mint", args: [to, amount] });
  const hash = await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: to, to: token, data }]);
  if ((await waitForReceipt(anvil, hash)).status !== "0x1") throw new Error("test setup: mint reverted");
}

const GENESIS_SECONDS = 1_700_000_000;
const GENESIS_MS = GENESIS_SECONDS * 1_000;

/** The same windows tests-anvil/client-flows.anvil.test.ts uses (sized against `EVM_LOCAL_POLICY`). */
function legADeadlines(t0: number) {
  return { claimByMs: t0 + 60 * 60_000, refundAfterMs: t0 + 90 * 60_000, expiresMs: t0 + 30 * 60_000 };
}
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 120 * 60_000, refundAfterMs: t0 + 180 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

async function currentChainTimeMs(anvil: AnvilHandle): Promise<number> {
  const block = await anvil.rpcCall<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
  return Number.parseInt(block.timestamp, 16) * 1_000;
}

async function runAuditExport(root: string, expectArg: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(REPO_ROOT, "examples", "audit-export.mjs"), "--root", root, "--expect", expectArg], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const framesIn = (records: readonly TranscriptRecord[], type: string): TranscriptRecord[] => records.filter((r) => tryDecodeFrame(r.line)?.type === type);

/** A process: the options its flow is built from, and the counter of what its transport sent. */
interface Proc<O> {
  options: O;
  calls: CountingFetch;
}

describe("Resume: a flow process dies mid-swap on a real anvil node and a fresh one finishes it from its store", () => {
  let anvil: AnvilHandle;
  let railContract: Address;
  let tokenContract: Address;
  let buyerAccount: Address;
  let sellerAccount: Address;
  let config: EvmRailConfig;
  let scenarioNumber = 0;

  beforeAll(async () => {
    anvil = await startAnvil({ timestampSeconds: GENESIS_SECONDS });
    const [first, second] = anvil.accounts;
    if (first === undefined || second === undefined) throw new Error("test setup: anvil did not expose two accounts");
    buyerAccount = first;
    sellerAccount = second;
    const deployed = await deployRailContracts(anvil.endpoint, buyerAccount);
    railContract = deployed.railContract;
    tokenContract = deployed.tokenContract;
    config = { pin: ANVIL_LOCAL_PIN, endpoint: anvil.endpoint, contract: railContract, assets: { USDC: tokenContract } };
    await mint(anvil, tokenContract, buyerAccount, 100_000_000n);
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
    if (process.env.KEEP_ANVIL_BUNDLES !== "1") await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** One swap's world: the venue, the note store, the clock, both parties' store directories and the secret the Seller mints. */
  async function newWorld() {
    scenarioNumber += 1;
    const tag = 60 + scenarioNumber * 2;
    const buyer: Identity = identity(tag.toString(16).padStart(2, "0").repeat(32));
    const seller: Identity = identity((tag + 1).toString(16).padStart(2, "0").repeat(32));
    const seeds = [tag, tag + 1].map((n) => Buffer.from(n.toString(16).padStart(2, "0").repeat(32), "hex"));
    const t0 = await currentChainTimeMs(anvil);
    const clockRef = { ms: t0 };
    const clock = (): number => clockRef.ms;
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const buyerStore = new RecordingStore(new FileFlowStore(await scratchDir("buyer")));
    const sellerStore = new RecordingStore(new FileFlowStore(await scratchDir("seller")));
    const sellerLock: HashLock = generateHashLock();

    /** A new Buyer process: its own transport and rail (the real rail, or `wrap` of it), a fresh `PaperRail` over the shared notes. */
    function buyerProc(wrap?: (rail: CounterAssetRail) => CounterAssetRail): Proc<BuyerFlowOptions & { store: FlowStore }> {
      const calls = countingFetch();
      const rpc = new CapturingRpc({ endpoint: anvil.endpoint, fetch: calls.fetch });
      const rail = createEvmCounterRail({ config, rpc, account: buyerAccount, clock });
      return { calls, options: { identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: wrap === undefined ? rail : wrap(rail), clock, store: buyerStore } };
    }
    function sellerProc(wrap?: (rail: CounterAssetRail) => CounterAssetRail): Proc<SellerFlowOptions & { store: FlowStore }> {
      const calls = countingFetch();
      const rpc = new CapturingRpc({ endpoint: anvil.endpoint, fetch: calls.fetch });
      const rail = createEvmCounterRail({ config, rpc, account: sellerAccount, clock });
      return {
        calls,
        options: { identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail: wrap === undefined ? rail : wrap(rail), clock, store: sellerStore, mintHashLock: () => sellerLock },
      };
    }

    /** The anvil chain's own timestamp and the flows' clock move together (`EvmHashRail.sol` compares `block.timestamp * 1000`). */
    async function warpTo(nowMs: number): Promise<void> {
      clockRef.ms = nowMs;
      await anvil.rpcCall("evm_setNextBlockTimestamp", [Math.ceil(nowMs / 1000) + 1]);
      await anvil.rpcCall("anvil_mine", ["0x1"]);
    }
    const mineBlocks = async (n: number): Promise<void> => void (await anvil.rpcCall("anvil_mine", [`0x${n.toString(16)}`]));

    return { t0, buyer, seller, seeds, clockRef, clock, venue, noteStore, buyerStore, sellerStore, sellerLock, buyerProc, sellerProc, warpTo, mineBlocks, nonce: scenarioNumber.toString(16).padStart(8, "0") };
  }
  type World = Awaited<ReturnType<typeof newWorld>>;

  /** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both account lines, with flows that write to their stores. */
  async function pairAndLockB(w: World, buyerFlow: BuyerFlow, sellerFlow: SellerFlow) {
    const swapId = computeSwapId(w.buyer.did, w.nonce);
    const offerA = await buyerFlow.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legADeadlines(w.t0) });
    const { acceptA, acceptARecord, offerB, offerBRecord } = await sellerFlow.acceptLegA(offerA, legBDeadlines(w.t0), w.t0);
    const { acceptB, acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, w.t0);
    await sellerFlow.lockLegB(acceptBRecord);
    await buyerFlow.verifyLegBLocked();
    await sellerFlow.postAccountLineA(sellerAccount);
    await buyerFlow.postAccountLineA(buyerAccount);
    return { swapId, offerA, offerB, acceptA, acceptB, statement: acceptA.statement };
  }
  type Paired = Awaited<ReturnType<typeof pairAndLockB>>;

  /** How many `Locked` / `Claimed` / `Refunded` logs the rail contract holds for this hash lock. */
  async function chainEvents(hashLock: string): Promise<{ locked: number; claimed: number; refunded: number }> {
    const selectors = {
      locked: toEventSelector("Locked(bytes32,address,address,address,uint256,uint256,uint256)"),
      claimed: toEventSelector("Claimed(bytes32,bytes32)"),
      refunded: toEventSelector("Refunded(bytes32)"),
    };
    const count = async (selector: Hex): Promise<number> =>
      (await anvil.rpcCall<unknown[]>("eth_getLogs", [{ address: railContract, fromBlock: "0x0", toBlock: "latest", topics: [selector, hashLock] }])).length;
    return { locked: await count(selectors.locked), claimed: await count(selectors.claimed), refunded: await count(selectors.refunded) };
  }

  /** The audits every finished scenario ends with, then the offline replay of its bundle (as tests-anvil/client-flows does). */
  async function finish(args: {
    scenario: string;
    w: World;
    p: Paired;
    outcome: Outcome;
    status: string;
    writes: BundleEvidenceSummary["writes"];
    exchanges: readonly Exchange[];
    withChainLeg: boolean;
  }): Promise<void> {
    const { w, p } = args;
    expect(
      await swapProblems({
        venue: w.venue,
        contractA: p.acceptA.contract,
        contractB: p.acceptB.contract,
        offerAId: p.offerA.id,
        offerBId: p.offerB.id,
        buyerDid: w.buyer.did,
        sellerDid: w.seller.did,
        outcome: args.outcome,
      }),
    ).toEqual([]);
    expect(assertSavesClean({ buyer: w.buyerStore, seller: w.sellerStore, preimage: w.sellerLock.preimage, seeds: w.seeds })).toEqual([]);

    const root = await scratchDir(args.scenario);
    const dealRoomA = dealRoom(p.acceptA.contract);
    const dealRoomB = dealRoom(p.acceptB.contract);
    const { ns, key } = paperNote(p.acceptB.contract);
    const rawNote = w.noteStore.raw(ns, key);
    const summary: BundleEvidenceSummary = {
      swapId: p.swapId,
      legA: { contract: p.acceptA.contract, rail: "evm-htlc" },
      legB: { contract: p.acceptB.contract, rail: "paper" },
      feeBps: 0,
      writes: args.writes,
      startedAtMs: GENESIS_MS,
      finishedAtMs: w.clock(),
    };
    await writeBundle({
      root,
      nowMs: w.clock(),
      offerRoomRecords: await w.venue.read(OFFER_ROOM),
      dealRooms: new Map([
        [dealRoomA, await w.venue.read(dealRoomA)],
        [dealRoomB, await w.venue.read(dealRoomB)],
      ]),
      paperNotes: rawNote === undefined ? new Map() : new Map([[p.acceptB.contract, rawNote]]),
      writeExchanges: args.exchanges,
      ...(args.withChainLeg ? { evm: { config, rpc: new CapturingRpc({ endpoint: anvil.endpoint }), hashLock: p.statement as Hex } } : {}),
      evidence: summary,
    });
    const result = await runAuditExport(root, `${p.swapId}=${args.status}`);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  }

  /** After the Buyer's lock frame is posted: finality, the Seller's claim, the Buyer learns the secret and claims leg B. */
  async function settle(w: World, p: Paired, buyerFlow: BuyerFlow, sellerFlow: SellerFlow): Promise<void> {
    await w.mineBlocks(2);
    const claimed = await sellerFlow.claimLegA(p.statement);
    expect(claimed.evidence.event).toBe("Claimed");
    await w.mineBlocks(2);
    const secret = await buyerFlow.learnSecret();
    expect(verifyHashPreimage(p.statement, secret)).toBe(true);
    expect(secret).toBe(w.sellerLock.preimage);
    await buyerFlow.claimLegB(secret);
  }

  // -- 1 -----------------------------------------------------------------------------------------------------

  it("1: the lock landed and the process died holding the answer (store never told, no lock frame): the restart finds its row, posts the frame once, sends nothing", async () => {
    const w = await newWorld();
    const crashed = w.buyerProc((rail) => crashRail(rail, { after: ["commitLock"] }));
    const buyerFlow = new BuyerFlow(crashed.options);
    const seller = w.sellerProc();
    const sellerFlow = new SellerFlow(seller.options);
    const p = await pairAndLockB(w, buyerFlow, sellerFlow);

    await expect(buyerFlow.lockLegA()).rejects.toThrow(/process died after commitLock/);
    expect(crashed.calls.count("eth_sendTransaction")).toBe(2); // the approve and the lock reached the chain
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 0, refunded: 0 });
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(0);

    // a new process: nothing in memory, only the store directory
    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("lockLegA");
    const lockA = await resumed.flow.lockLegA();
    expect(lockA.hashLock).toBe(p.statement);
    expect(lockA.writeEvidence.ref).toBe(p.statement);
    expect(restarted.calls.count("eth_sendTransaction")).toBe(0); // no second approve, no second lock
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 0, refunded: 0 });
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(1);
    await resumed.flow.lockLegA(); // confirmed: the recorded result, nothing posted again
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(1);
    expect((await BuyerFlow.resume({ ...w.buyerProc().options, swapId: p.swapId })).next).toBe("learnSecret");

    await settle(w, p, resumed.flow, sellerFlow);
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 1, refunded: 0 });
    await finish({
      scenario: "lock-lost",
      w,
      p,
      outcome: "settled",
      status: "settled",
      withChainLeg: true,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: { ref: p.statement, raw: [] } },
      ],
      exchanges: [...buyerFlow.exchanges, ...resumed.flow.exchanges, ...sellerFlow.exchanges],
    });
  }, 60_000);

  it("1b: the lock is recorded and the lock frame post dies: the restart posts the saved frame once, sends nothing", async () => {
    const w = await newWorld();
    const first = w.buyerProc();
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairAndLockB(w, buyerFlow, sellerFlow);

    const dying = failVenuePosts(w.venue, (_room, line) => tryDecodeFrame(line)?.type === "lock", 1);
    await expect(buyerFlow.lockLegA()).rejects.toThrow(/process died before posting/);
    dying.restore();
    expect(first.calls.count("eth_sendTransaction")).toBe(2);
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(0);

    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("lockLegA");
    const lockA = await resumed.flow.lockLegA();
    expect(restarted.calls.count("eth_sendTransaction")).toBe(0);
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 0, refunded: 0 });
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(1);

    await settle(w, p, resumed.flow, sellerFlow);
    await finish({
      scenario: "lock-frame",
      w,
      p,
      outcome: "settled",
      status: "settled",
      withChainLeg: true,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: { ref: p.statement, raw: [] } },
      ],
      exchanges: [...buyerFlow.exchanges, ...resumed.flow.exchanges, ...sellerFlow.exchanges],
    });
  }, 60_000);

  // -- 2 -----------------------------------------------------------------------------------------------------

  it("2: the claim landed and every reveal frame post dies: the restart finds its own preimage on chain, posts the reveal and receipt once, claims nothing again", async () => {
    const w = await newWorld();
    const buyerFlow = new BuyerFlow(w.buyerProc().options);
    const first = w.sellerProc();
    const sellerFlow = new SellerFlow(first.options);
    const p = await pairAndLockB(w, buyerFlow, sellerFlow);
    const lockA = await buyerFlow.lockLegA();
    await w.mineBlocks(2);

    const dying = failVenuePosts(w.venue, (_room, line) => tryDecodeFrame(line)?.type === "reveal", 1_000);
    await expect(sellerFlow.claimLegA(p.statement)).rejects.toThrow(/reveal frame did not post/);
    dying.restore();
    expect(first.calls.count("eth_sendTransaction")).toBe(1);
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 1, refunded: 0 });
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "reveal")).toHaveLength(0);

    const restarted = w.sellerProc();
    const resumed = await SellerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("claimLegA");
    expect(resumed.flow.statement).toBe(p.statement);
    const claimed = await resumed.flow.claimLegA(p.statement);
    expect(claimed.reveal).toBeDefined();
    expect(restarted.calls.count("eth_sendTransaction")).toBe(0); // no second claim
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 1, refunded: 0 });
    const roomA = await w.venue.read(dealRoom(p.acceptA.contract));
    expect(framesIn(roomA, "reveal")).toHaveLength(1);
    expect(framesIn(roomA, "receipt")).toHaveLength(1);
    expect((await SellerFlow.resume({ ...w.sellerProc().options, swapId: p.swapId })).next).toBe("done");

    await w.mineBlocks(2);
    const secret = await buyerFlow.learnSecret();
    expect(secret).toBe(w.sellerLock.preimage);
    await buyerFlow.claimLegB(secret);
    await finish({
      scenario: "reveal-lost",
      w,
      p,
      outcome: "settled",
      status: "settled",
      withChainLeg: true,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: claimed.evidence },
      ],
      exchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges, ...resumed.flow.exchanges],
    });
  }, 60_000);

  it("2b: the claim landed and the process died holding the reply (nothing posted): the restart finds its own preimage on chain and posts the frames once", async () => {
    const w = await newWorld();
    const buyerFlow = new BuyerFlow(w.buyerProc().options);
    const first = w.sellerProc((rail) => crashRail(rail, { after: ["claim"] }));
    const sellerFlow = new SellerFlow(first.options);
    const p = await pairAndLockB(w, buyerFlow, sellerFlow);
    const lockA = await buyerFlow.lockLegA();
    await w.mineBlocks(2);

    await expect(sellerFlow.claimLegA(p.statement)).rejects.toThrow(/process died after claim/);
    expect(first.calls.count("eth_sendTransaction")).toBe(1);
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 1, refunded: 0 });

    const restarted = w.sellerProc();
    const resumed = await SellerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("claimLegA");
    const claimed = await resumed.flow.claimLegA(p.statement);
    expect(claimed.reveal).toBeDefined();
    expect(restarted.calls.count("eth_sendTransaction")).toBe(0);
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 1, refunded: 0 });

    await w.mineBlocks(2);
    await buyerFlow.claimLegB(await buyerFlow.learnSecret());
    await finish({
      scenario: "claim-lost",
      w,
      p,
      outcome: "settled",
      status: "settled",
      withChainLeg: true,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: claimed.evidence },
      ],
      exchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges, ...resumed.flow.exchanges],
    });
  }, 60_000);

  // -- 3 -----------------------------------------------------------------------------------------------------

  it("3: the refund landed and the process died holding the reply: the restart reads Refunded, posts the refund and receipt frames once, refunds nothing again", async () => {
    const w = await newWorld();
    const first = w.buyerProc((rail) => crashRail(rail, { after: ["refund"] }));
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairAndLockB(w, buyerFlow, sellerFlow);
    const lockA = await buyerFlow.lockLegA();
    await w.mineBlocks(2);

    await w.warpTo(p.offerA.refundAfterMs + 60_000); // the Seller never claims
    await expect(buyerFlow.refundLegA()).rejects.toThrow(/process died after refund/);
    expect(first.calls.count("eth_sendTransaction")).toBe(3); // approve, lock, refund
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 0, refunded: 1 });
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "refund")).toHaveLength(0);
    await w.mineBlocks(2); // the refund is final by the time the new process looks

    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("refundLegA");
    const refundA = await resumed.flow.refundLegA();
    expect(refundA.ref).toBe(p.statement);
    expect(restarted.calls.count("eth_sendTransaction")).toBe(0); // no second refund
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 0, refunded: 1 });
    const roomA = await w.venue.read(dealRoom(p.acceptA.contract));
    expect(framesIn(roomA, "refund")).toHaveLength(1);
    expect(framesIn(roomA, "receipt")).toHaveLength(1);
    expect((await BuyerFlow.resume({ ...w.buyerProc().options, swapId: p.swapId })).next).toBe("done");

    await w.warpTo(p.offerB.refundAfterMs + 60_000);
    expect((await sellerFlow.refundLegB()).refund).toBeDefined();
    await w.mineBlocks(2);
    await finish({
      scenario: "refund-lost",
      w,
      p,
      outcome: "refunded",
      status: "refunded",
      withChainLeg: true,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: "evm-htlc", evidence: refundA },
      ],
      exchanges: [...buyerFlow.exchanges, ...resumed.flow.exchanges, ...sellerFlow.exchanges],
    });
  }, 60_000);

  it("3b: the refund is recorded and final and the refund frame post dies: the restart posts the frames once, refunds nothing again", async () => {
    const w = await newWorld();
    const first = w.buyerProc();
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairAndLockB(w, buyerFlow, sellerFlow);
    const lockA = await buyerFlow.lockLegA();
    await w.mineBlocks(2);

    await w.warpTo(p.offerA.refundAfterMs + 60_000);
    await expect(buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/); // sent; not final yet
    await w.mineBlocks(2);
    const dying = failVenuePosts(w.venue, (_room, line) => tryDecodeFrame(line)?.type === "refund", 1);
    await expect(buyerFlow.refundLegA()).rejects.toThrow(/process died before posting/);
    dying.restore();
    expect(first.calls.count("eth_sendTransaction")).toBe(3);
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "refund")).toHaveLength(0);

    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("refundLegA");
    const refundA = await resumed.flow.refundLegA();
    expect(restarted.calls.count("eth_sendTransaction")).toBe(0);
    expect(await chainEvents(p.statement)).toEqual({ locked: 1, claimed: 0, refunded: 1 });
    const roomA = await w.venue.read(dealRoom(p.acceptA.contract));
    expect(framesIn(roomA, "refund")).toHaveLength(1);
    expect(framesIn(roomA, "receipt")).toHaveLength(1);

    await w.warpTo(p.offerB.refundAfterMs + 60_000);
    expect((await sellerFlow.refundLegB()).refund).toBeDefined();
    await w.mineBlocks(2);
    await finish({
      scenario: "refund-frame",
      w,
      p,
      outcome: "refunded",
      status: "refunded",
      withChainLeg: true,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: "evm-htlc", evidence: refundA },
      ],
      exchanges: [...buyerFlow.exchanges, ...resumed.flow.exchanges, ...sellerFlow.exchanges],
    });
  }, 60_000);
});
