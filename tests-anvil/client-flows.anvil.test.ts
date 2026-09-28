// SPDX-License-Identifier: MIT
//
// tests-anvil/client-flows.anvil.test.ts — P22-P24-EVM-SPEC.md §6: the Seller/Buyer client
// flows (src/client/seller.ts, src/client/buyer.ts) end to end against a real anvil node, with
// the counter-asset leg on `evm-htlc` and the FLOP leg on tclk's own `PaperRail` over one
// in-memory `NoteStore`. Every scenario drives the two flows through explicit steps only (no
// timers, no polling): the happy path to `settled`, both refund paths, the claim-before-
// finality refusal, and the Buyer learning the secret from the on-chain `Claimed` log alone.
// `npm run test:anvil` only — `npm test` never spawns anvil (tests-anvil/helpers/anvil.ts).
//
// P22-P24-EVM-FIXES.md B4: every scenario writes its bundle to a fresh `mkdtemp` directory by
// default — the committed fixtures under `fixtures/evm-anvil-2026-09-28/` are only ever
// (re)written when `CAPTURE_EVM_FIXTURES=1` is set (README "EVM leg (local, keyless)"). Before
// this fix, an ordinary `npm run test:anvil` run silently rewrote those three committed
// directories every time.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { encodeFunctionData, type Address, type Hex } from "viem";
import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, paperNote, verifyHashPreimage } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc, type Exchange } from "../src/rails/rpc-capture.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXTURES_ROOT = join(REPO_ROOT, "fixtures", "evm-anvil-2026-09-28");

/** B4: `CAPTURE_EVM_FIXTURES=1 npm run test:anvil` (re)writes the three committed fixtures in
 *  place; any other run (including a bare `npm run test:anvil`) writes to a fresh `mkdtemp`
 *  directory that nothing ever reads back, so the committed fixtures never move. */
const CAPTURE_FIXTURES = process.env.CAPTURE_EVM_FIXTURES === "1";

/** P22-P24-EVM-FIXES-R2.md D7: every scenario's own `mkdtemp` bundle directory (never the
 *  committed fixtures under `CAPTURE_FIXTURES` — those are never removed here), so `afterAll`
 *  can remove them once the suite is done — an ordinary `npm run test:anvil` run otherwise
 *  leaves five fresh directories under the OS temp dir behind every time it runs, forever.
 *  `KEEP_ANVIL_BUNDLES=1` skips the cleanup, for inspecting a scenario's exact written bundle
 *  by hand after the run. */
const scenarioRoots: string[] = [];

async function scenarioRoot(scenario: string): Promise<string> {
  if (CAPTURE_FIXTURES) {
    const dir = join(FIXTURES_ROOT, scenario);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return dir;
  }
  const dir = await mkdtemp(join(tmpdir(), `flop-evm-anvil-${scenario}-`));
  scenarioRoots.push(dir);
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

interface TxReceipt { status: string }

async function waitForReceipt(anvil: AnvilHandle, hash: Hex): Promise<TxReceipt> {
  for (;;) {
    const receipt = await anvil.rpcCall<TxReceipt | null>("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) return receipt;
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function mint(anvil: AnvilHandle, token: Address, to: Address, amount: bigint): Promise<void> {
  const data = encodeFunctionData({ abi: MOCK_ERC20_MINT_ABI, functionName: "mint", args: [to, amount] });
  const hash = await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: to, to: token, data }]);
  const receipt = await waitForReceipt(anvil, hash);
  if (receipt.status !== "0x1") throw new Error("test setup: mint reverted");
}

/** Genesis time this whole file's anvil node starts at. Every offer's deadlines below are
 *  anchored to this — never the real wall clock — so this file's lock windows stay clear of
 *  "now" no matter when the suite runs. */
const GENESIS_SECONDS = 1_700_000_000;
const GENESIS_MS = GENESIS_SECONDS * 1_000;

/** P22-P24-EVM-FIXES.md B3: the EVM deadline policy is now pinned in the client itself
 *  (`EVM_LOCAL_POLICY`) rather than taken from this runner — this file uses the same constant
 *  both flows check against, so its own sizing comments below stay accurate. */

/** Leg A: `refundAfterMs = t0 + 90 min` (SPEC §6); `claimByMs` comfortably inside that (B2: the
 *  90 min - 60 min = 30 min claim/refund gap comfortably clears `EVM_LOCAL_POLICY`'s 5 min
 *  claim-inclusion margin). */
function legADeadlines(t0: number) {
  return { claimByMs: t0 + 60 * 60_000, refundAfterMs: t0 + 90 * 60_000, expiresMs: t0 + 30 * 60_000 };
}

/** Leg B: sized so `checkSwapDeadlines(offerA, offerB, t0, EVM_LOCAL_POLICY)` holds — verified
 *  by hand against `EVM_LOCAL_POLICY` and `legADeadlines` above (rule 2 needs >= t0+110min,
 *  rule 3 needs >= t0+150min); both `sellerFlow.acceptLegA` and `buyerFlow.acceptLegB` re-check
 *  it live regardless. */
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 120 * 60_000, refundAfterMs: t0 + 180 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

interface Party {
  identity: Identity;
  account: Address;
  rpc: CapturingRpc;
}

/** The anvil chain's own current block timestamp, in ms. Every scenario below shares one
 *  anvil instance whose clock only ever moves forward (earlier scenarios' `warpTo` calls
 *  persist), so a swap's own `t0` must be read fresh here — never the fixed `GENESIS_MS` — or
 *  a later scenario's deadlines could already be in the past by the time it runs. */
async function currentChainTimeMs(anvil: AnvilHandle): Promise<number> {
  const block = await anvil.rpcCall<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
  return Number.parseInt(block.timestamp, 16) * 1_000;
}

/** One fresh swap's worth of local state: its own venue, its own paper `NoteStore` (so
 *  scenarios never see each other's paper records even though every scenario shares one anvil
 *  chain and one deployed `EvmHashRail`/`MockERC20` pair), and a mutable clock both flows
 *  read, seeded from `t0` (this swap's own present, per `currentChainTimeMs` above). */
function setupSwap(anvil: AnvilHandle, config: EvmRailConfig, buyer: Party, seller: Party, t0: number) {
  const clockRef = { ms: t0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();

  const buyerFlow = new BuyerFlow({
    identity: buyer.identity,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    account: buyer.account,
    rpc: buyer.rpc,
    evmConfig: config,
    clock,
  });
  const sellerFlow = new SellerFlow({
    identity: seller.identity,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    account: seller.account,
    rpc: seller.rpc,
    evmConfig: config,
    clock,
  });

  /** Advance both the JS clock every flow reads AND the anvil chain's own timestamp together —
   *  `EvmHashRail.sol` compares `block.timestamp * 1000` against `refundAfterMs`, so the two
   *  must never drift apart or a refund/claim guard would pass or fail for the wrong reason. */
  async function warpTo(nowMs: number): Promise<void> {
    clockRef.ms = nowMs;
    await anvil.rpcCall("evm_setNextBlockTimestamp", [Math.ceil(nowMs / 1000) + 1]);
    await anvil.rpcCall("anvil_mine", ["0x1"]);
  }

  async function mineBlocks(n: number): Promise<void> {
    await anvil.rpcCall("anvil_mine", [`0x${n.toString(16)}`]);
  }

  return { clockRef, clock, venue, noteStore, buyerFlow, sellerFlow, warpTo, mineBlocks };
}

async function runAuditExport(root: string, expectArg: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(REPO_ROOT, "examples", "audit-export.mjs"), "--root", root, "--expect", expectArg],
      { cwd: REPO_ROOT },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("Seller/Buyer client flows against a real anvil node", () => {
  let anvil: AnvilHandle;
  let railContract: Address;
  let tokenContract: Address;
  let buyerAccount: Address;
  let sellerAccount: Address;
  let config: EvmRailConfig;

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
    // D7: clean up every scenario's own mkdtemp bundle directory — never the committed
    // fixtures (CAPTURE_FIXTURES never pushes to `scenarioRoots`) — unless a caller explicitly
    // wants to inspect what got written.
    if (process.env.KEEP_ANVIL_BUNDLES !== "1") {
      await Promise.all(scenarioRoots.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  function freshParty(id: Identity, account: Address): Party {
    return { identity: id, account, rpc: new CapturingRpc({ endpoint: anvil.endpoint }) };
  }

  /** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both account lines —
   *  the prefix every scenario below shares. */
  async function pairAndLockB(
    nonceHex: string,
    buyer: Identity,
    seller: Identity,
    buyerFlow: BuyerFlow,
    sellerFlow: SellerFlow,
    t0: number,
  ) {
    const swapId = computeSwapId(buyer.did, nonceHex);
    const offerA = await buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      ...legADeadlines(t0),
    });

    const { acceptA, acceptARecord, offerB, offerBRecord } = await sellerFlow.acceptLegA(offerA, legBDeadlines(t0), t0);
    const { acceptB, acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, t0);
    await sellerFlow.lockLegB(acceptBRecord);
    await buyerFlow.verifyLegBLocked();
    await sellerFlow.postAccountLineA(sellerAccount);
    await buyerFlow.postAccountLineA(buyerAccount);

    return { swapId, offerA, offerB, acceptA, acceptB };
  }

  /** Writes a watch-root bundle for `swapId` (to a fresh `mkdtemp` directory, or — only under
   *  `CAPTURE_EVM_FIXTURES=1` — the named committed fixture directory, B4) and replays it
   *  through `examples/audit-export.mjs` (as a real child process, `npm run build` having
   *  already produced `dist/` before `test:anvil` runs vitest) — asserting the exit code the
   *  spec calls for. */
  async function writeAndReplay(args: {
    scenario: string;
    swapId: string;
    status: string;
    venue: MemoryVenue;
    acceptAContract: string;
    acceptBContract: string;
    noteStore: MemoryNoteStore;
    evm?: { hashLock: Hex };
    nowMs: number;
    writes: BundleEvidenceSummary["writes"];
    /** B5: every EVM write both flows made this scenario — `[...buyerFlow.exchanges,
     *  ...sellerFlow.exchanges]` — so `writeBundle` can persist them into `raw/rpc/`. */
    writeExchanges: readonly Exchange[];
  }): Promise<string> {
    const root = await scenarioRoot(args.scenario);

    const dealRoomA = dealRoom(args.acceptAContract);
    const dealRoomB = dealRoom(args.acceptBContract);
    const { ns, key } = paperNote(args.acceptBContract);
    const rawNote = args.noteStore.raw(ns, key);

    const summary: BundleEvidenceSummary = {
      swapId: args.swapId,
      legA: { contract: args.acceptAContract, rail: "evm-htlc" },
      legB: { contract: args.acceptBContract, rail: "paper" },
      feeBps: 0,
      writes: args.writes,
      startedAtMs: GENESIS_MS,
      finishedAtMs: args.nowMs,
    };

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
      ...(args.evm === undefined
        ? {}
        : { evm: { config, rpc: new CapturingRpc({ endpoint: anvil.endpoint }), hashLock: args.evm.hashLock } }),
      evidence: summary,
    });

    const result = await runAuditExport(root, `${args.swapId}=${args.status}`);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return root;
  }

  it("scenario 1: happy path -> settled", async () => {
    const buyer = identity("31".repeat(32));
    const seller = identity("32".repeat(32));
    const t0 = await currentChainTimeMs(anvil);
    const { venue, noteStore, sellerFlow, buyerFlow, mineBlocks, clock } = setupSwap(
      anvil,
      config,
      freshParty(buyer, buyerAccount),
      freshParty(seller, sellerAccount),
      t0,
    );

    const { swapId, acceptA, acceptB } = await pairAndLockB("00000001", buyer, seller, buyerFlow, sellerFlow, t0);

    const lockA = await buyerFlow.lockLegA();
    await mineBlocks(2);

    const claimed = await sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
    expect(claimed.reveal).toBeDefined();
    await mineBlocks(2);

    const secret = await buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await buyerFlow.claimLegB(secret);

    await writeAndReplay({
      scenario: "settled",
      swapId,
      status: "settled",
      venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore,
      evm: { hashLock: lockA.hashLock },
      nowMs: clock(),
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: claimed.evidence },
      ],
      writeExchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges],
    });
  }, 30_000);

  it("scenario 2: refunded (i) — Seller never reveals; Buyer refunds A, Seller refunds B -> refunded", async () => {
    const buyer = identity("33".repeat(32));
    const seller = identity("34".repeat(32));
    const t0 = await currentChainTimeMs(anvil);
    const { venue, noteStore, sellerFlow, buyerFlow, mineBlocks, warpTo, clock } = setupSwap(
      anvil,
      config,
      freshParty(buyer, buyerAccount),
      freshParty(seller, sellerAccount),
      t0,
    );

    const { swapId, acceptA, acceptB, offerA, offerB } = await pairAndLockB(
      "00000002",
      buyer,
      seller,
      buyerFlow,
      sellerFlow,
      t0,
    );

    const lockA = await buyerFlow.lockLegA();
    await mineBlocks(2);

    // The Seller never claims/reveals. Both refund windows pass; each party refunds its own leg.
    await warpTo(offerA.refundAfterMs + 60_000);
    const refundA = await buyerFlow.refundLegA();
    expect(refundA.event).toBe("Refunded");

    await warpTo(offerB.refundAfterMs + 60_000);
    const refundB = await sellerFlow.refundLegB();
    expect(refundB.refund).toBeDefined();

    await mineBlocks(2);

    await writeAndReplay({
      scenario: "refunded",
      swapId,
      status: "refunded",
      venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore,
      evm: { hashLock: lockA.hashLock },
      nowMs: clock(),
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: "evm-htlc", evidence: refundA },
      ],
      writeExchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges],
    });
  }, 30_000);

  it("scenario 3: refunded-b — Buyer never locks A; Seller refunds B -> refunded-b", async () => {
    const buyer = identity("35".repeat(32));
    const seller = identity("36".repeat(32));
    const t0 = await currentChainTimeMs(anvil);
    const { venue, noteStore, sellerFlow, buyerFlow, warpTo, clock } = setupSwap(
      anvil,
      config,
      freshParty(buyer, buyerAccount),
      freshParty(seller, sellerAccount),
      t0,
    );

    const { swapId, acceptA, acceptB, offerB } = await pairAndLockB(
      "00000003",
      buyer,
      seller,
      buyerFlow,
      sellerFlow,
      t0,
    );

    // The Buyer never calls lockLegA. Once B's refund window opens, the Seller refunds it.
    await warpTo(offerB.refundAfterMs + 60_000);
    const refundB = await sellerFlow.refundLegB();
    expect(refundB.refund).toBeDefined();

    await writeAndReplay({
      scenario: "refunded-b",
      swapId,
      status: "refunded-b",
      venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore,
      nowMs: clock(),
      writes: [{ leg: "b", step: "refund", rail: "paper", evidence: {} }],
      writeExchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges],
    });
  }, 30_000);

  it("scenario 4: claim refused before finality, allowed after 2 mined blocks", async () => {
    const buyer = identity("37".repeat(32));
    const seller = identity("38".repeat(32));
    const t0 = await currentChainTimeMs(anvil);
    const { sellerFlow, buyerFlow, mineBlocks } = setupSwap(
      anvil,
      config,
      freshParty(buyer, buyerAccount),
      freshParty(seller, sellerAccount),
      t0,
    );

    await pairAndLockB("00000004", buyer, seller, buyerFlow, sellerFlow, t0);
    const lockA = await buyerFlow.lockLegA();

    await expect(sellerFlow.claimLegA(lockA.hashLock)).rejects.toThrow(/verifyLockFinal\(A\) is true/);

    await mineBlocks(2);
    const claimed = await sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
  }, 30_000);

  it("scenario 5: Seller claims without posting reveal A; Buyer learns s from the Claimed log", async () => {
    const buyer = identity("39".repeat(32));
    const seller = identity("40".repeat(32));
    const t0 = await currentChainTimeMs(anvil);
    const { sellerFlow, buyerFlow, mineBlocks } = setupSwap(
      anvil,
      config,
      freshParty(buyer, buyerAccount),
      freshParty(seller, sellerAccount),
      t0,
    );

    await pairAndLockB("00000005", buyer, seller, buyerFlow, sellerFlow, t0);
    const lockA = await buyerFlow.lockLegA();
    await mineBlocks(2);

    const claimed = await sellerFlow.claimLegA(lockA.hashLock, { skipReveal: true });
    expect(claimed.reveal).toBeUndefined();
    await mineBlocks(2);

    const secret = await buyerFlow.learnSecret();
    await buyerFlow.claimLegB(secret);
  }, 30_000);
});
