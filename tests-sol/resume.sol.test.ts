// SPDX-License-Identifier: MIT
//
// tests-sol/resume.sol.test.ts - P8-RESUME-SPEC.md "Tests", the Solana part: three scenarios on a real `solana-test-validator`
// (tests-sol/helpers/validator.ts) with the real reviewed `htlc.so`. In each one a transaction was signed, recorded in the flow's
// FileFlowStore and sent; it landed; the reply never reached the process; a fresh process resumes from the store directory alone and
// resolves the RECORDED signature on chain - it never signs the same thing a second time.
//
//   1  lock: the Buyer's lock send landed and its reply was lost. The restart's `recoverLock` asks the chain about the recorded
//      signature (`LockPendingError` while it is not finalized, and nothing new is signed meanwhile), then finds it landed, posts
//      the lock frame once and sends nothing. The swap then settles.
//   2  claim: the Seller's claim send landed and its reply was lost. The record holds the claim signature; the restart resolves it
//      (landed), posts the reveal and receipt once, signs and sends no second claim. The swap then settles.
//   3  refund: the Buyer's refund send landed and its reply was lost. The record holds the refund signature; the restart resolves
//      it, posts the refund and receipt frames once, signs no second refund. The Seller then refunds leg B, and the swap is replayed
//      as `refunded`. This scenario crosses `refundAfterMs` on the real chain, so it uses the compressed window of
//      tests-sol/client-flows scenario 2 (about 7 real minutes; the flow clock runs behind wall time so the flows' own 45 minute
//      rule still holds).
//
// The lost reply is real: a `fetch` wrapper performs the `sendTransaction` request, reads the node's answer and throws it away. The
// restarted process's transport is a counter and the tests assert it sent no `sendTransaction`. Every scenario ends with the venue
// audit, the secret scan over every save of both stores, and the offline replay with `examples/audit-export.mjs --expect`.
// Run only this file: `npx vitest run --config vitest.sol.config.ts tests-sol/resume.sol.test.ts`. `npm test` never spawns a validator.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, generateHashLock, paperNote, tryDecodeFrame, verifyHashPreimage, type HashLock, type TranscriptRecord } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow, LockPendingError, type BuyerFlowOptions } from "../src/client/buyer.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { decodeFlowRecord, type BuyerFlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import { FileFlowStore, flowKey, type FlowStore } from "../src/client/flow-store.js";
import { SellerFlow, type SellerFlowOptions } from "../src/client/seller.js";
import { createSolCounterRail } from "../src/client/sol-rail.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { SOL_RAIL_ID } from "../src/rails/custom-rails.js";
import type { SolAccounts } from "../src/rails/sol-evidence.js";
import type { Exchange } from "../src/rails/rpc-capture.js";
import { SolHtlcRail, type SolSigner } from "../src/rails/sol-htlc.js";
import { SolRpc } from "../src/rails/sol-rpc.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { assertSavesClean, countingFetch, lossyFetch, RecordingStore, swapProblems, type CountingFetch, type Outcome } from "../tests/helpers/live-resume.js";
import { startSolValidator, type SolParty, type SolValidatorHandle } from "./helpers/validator.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every scenario's bundle directory and store directories, removed in `afterAll` (`KEEP_SOL_BUNDLES=1` keeps them). */
const scratch: string[] = [];

async function scratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `flop-resume-sol-${label}-`));
  scratch.push(dir);
  return dir;
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

interface LegWindows {
  lockTimeMs: number;
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
}

/** An HONEST leg-A window anchored at the flow clock `t0` (the same numbers tests-sol/client-flows uses). */
function honestLegA(t0: number): LegWindows {
  return { lockTimeMs: t0, claimByMs: t0 + 20 * MINUTE, refundAfterMs: t0 + 47 * MINUTE, expiresMs: t0 + 10 * MINUTE };
}
function legBWindows(t0: number) {
  return { claimByMs: t0 + 12 * HOUR, refundAfterMs: t0 + 24 * HOUR, expiresMs: t0 + 40 * MINUTE };
}

interface Proc<O, T extends CountingFetch = CountingFetch> {
  options: O;
  calls: T;
}

describe("Resume on a real solana-test-validator: a send landed, its reply was lost, a fresh process resolves the recorded signature", () => {
  let v: SolValidatorHandle;
  let scenarioNumber = 0;

  beforeAll(async () => {
    v = await startSolValidator();
  }, 600_000);

  afterAll(async () => {
    if (v !== undefined) await v.stop();
    if (process.env.KEEP_SOL_BUNDLES !== "1") await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** One swap's world: the venue, the notes, the flow clock (wall time plus `skew.ms`), both store directories, the Seller's secret. */
  async function newWorld(options: { skewMs?: number } = {}) {
    scenarioNumber += 1;
    const tag = 0x70 + scenarioNumber * 2;
    const seedHex = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);
    const buyer: Identity = identity(seedHex(tag));
    const seller: Identity = identity(seedHex(tag + 1));
    const seeds = [tag, tag + 1].map((n) => Buffer.from(seedHex(n), "hex"));
    const skew = { ms: options.skewMs ?? 0 };
    const clock = (): number => Date.now() + skew.ms;
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const buyerStore = new RecordingStore(new FileFlowStore(await scratchDir("buyer")));
    const sellerStore = new RecordingStore(new FileFlowStore(await scratchDir("seller")));
    const sellerLock: HashLock = generateHashLock();
    // R3-7: the compressed-window scenario runs the flow clock tens of minutes behind the chain on purpose, so it widens the bound.
    const skewBound = options.skewMs === undefined ? {} : { maxChainClockSkewMs: 24 * 60 * MINUTE, unsafeAllowWideClockSkewForTests: true };

    function buyerProc<T extends CountingFetch = CountingFetch>(calls?: T): Proc<BuyerFlowOptions & { store: FlowStore }, T> {
      const transport = (calls ?? countingFetch()) as T;
      const rail: CounterAssetRail = createSolCounterRail({ config: v.config, rpc: v.createCapturingRpc({ fetch: transport.fetch }), signer: v.buyer.signer as SolSigner, clock, ...skewBound });
      return { calls: transport, options: { identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail, clock, store: buyerStore } };
    }
    function sellerProc<T extends CountingFetch = CountingFetch>(calls?: T): Proc<SellerFlowOptions & { store: FlowStore }, T> {
      const transport = (calls ?? countingFetch()) as T;
      const rail: CounterAssetRail = createSolCounterRail({ config: v.config, rpc: v.createCapturingRpc({ fetch: transport.fetch }), signer: v.seller.signer as SolSigner, clock, ...skewBound });
      return { calls: transport, options: { identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail, clock, store: sellerStore, mintHashLock: () => sellerLock } };
    }
    return { buyer, seller, seeds, skew, clock, venue, noteStore, buyerStore, sellerStore, sellerLock, buyerProc, sellerProc, nonce: scenarioNumber.toString(16).padStart(8, "0") };
  }
  type World = Awaited<ReturnType<typeof newWorld>>;

  /** The chain's own FINALIZED slot time (what the adapter's claim and refund windows are judged against). */
  async function chainTimeMs(): Promise<number> {
    const sol = new SolRpc(v.createCapturingRpc());
    const slot = await sol.getSlot("finalized");
    const seconds = await sol.getBlockTime(slot);
    if (seconds === null) throw new Error("test: the finalized slot has no block time");
    return seconds * 1000;
  }

  async function waitChainTime(atLeastMs: number, timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await chainTimeMs()) >= atLeastMs) return;
      if (Date.now() >= deadline) throw new Error("test: the chain time never reached the target");
      await sleep(2000);
    }
  }

  async function escrowStatus(ref: string): Promise<string | null> {
    const rail = await SolHtlcRail.connect({ config: v.config, rpc: v.createCapturingRpc(), signer: v.buyer.signer as SolSigner });
    return (await rail.getEscrow(ref)).escrow?.status ?? null;
  }

  async function waitEscrowStatus(ref: string, status: string, timeoutMs = 180_000): Promise<void> {
    for (const deadline = Date.now() + timeoutMs; ; ) {
      if ((await escrowStatus(ref)) === status) return;
      if (Date.now() >= deadline) throw new Error(`test: the escrow never reached ${status} at finalized`);
      await sleep(1000);
    }
  }

  async function signatureStatus(signature: string): Promise<{ confirmationStatus: string | null; err: unknown } | null> {
    const [status] = await new SolRpc(v.createCapturingRpc()).getSignatureStatuses([signature]);
    return status === undefined || status === null ? null : { confirmationStatus: status.confirmationStatus, err: status.err };
  }

  /** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both PROVEN account lines, with flows that write to their stores. */
  async function pairWithLines(w: World, buyerFlow: BuyerFlow, sellerFlow: SellerFlow, legA: LegWindows) {
    const swapId = computeSwapId(w.buyer.did, w.nonce);
    const offerA = await buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "500000", // 0.5 USDC (6 decimals)
      asset: "USDC",
      claimByMs: legA.claimByMs,
      refundAfterMs: legA.refundAfterMs,
      expiresMs: legA.expiresMs,
    });
    const { acceptA, acceptARecord, offerB, offerBRecord } = await sellerFlow.acceptLegA(offerA, legBWindows(legA.lockTimeMs), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
    await sellerFlow.lockLegB(acceptBRecord);
    await buyerFlow.verifyLegBLocked();
    await sellerFlow.postAccountLineA(v.seller.address);
    await buyerFlow.postAccountLineA(v.buyer.address);
    const statement = acceptA.statement;
    return { swapId, offerA, offerB, acceptA, acceptB, statement, ref: `${statement}:${v.buyer.address}`, termsA: offerAcceptLockTerms(offerA, acceptA) };
  }
  type Paired = Awaited<ReturnType<typeof pairWithLines>>;

  async function readRecord(store: RecordingStore, role: "buyer", swapId: string): Promise<BuyerFlowRecord>;
  async function readRecord(store: RecordingStore, role: "seller", swapId: string): Promise<SellerFlowRecord>;
  async function readRecord(store: RecordingStore, role: "buyer" | "seller", swapId: string): Promise<BuyerFlowRecord | SellerFlowRecord> {
    const key = flowKey(role, swapId);
    const bytes = await store.load(key);
    if (bytes === null) throw new Error(`test: the ${role} has no stored record`);
    const record = decodeFlowRecord(bytes, key);
    if (record.role !== role) throw new Error(`test: the stored record is not a ${role}'s`);
    return record;
  }

  /** The audits every finished scenario ends with, then the offline replay of its bundle (as tests-sol/client-flows does). */
  async function finish(args: { scenario: string; w: World; p: Paired; rail: CounterAssetRail; outcome: Outcome; writes: BundleEvidenceSummary["writes"]; startedAtMs: number; exchanges: BundleExchanges }): Promise<void> {
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
    const resolved = args.rail.resolveAccounts(await w.venue.read(dealRoomA), { contract: p.acceptA.contract, payerDid: p.termsA.payer, payeeDid: p.termsA.payee });
    const accounts: SolAccounts = { ...(resolved.payee === undefined ? {} : { payee: resolved.payee }), ...(resolved.payer === undefined ? {} : { payer: resolved.payer }) };
    const nowMs = w.clock();
    const summary: BundleEvidenceSummary = {
      swapId: p.swapId,
      legA: { contract: p.acceptA.contract, rail: SOL_RAIL_ID },
      legB: { contract: p.acceptB.contract, rail: "paper" },
      feeBps: 0,
      writes: args.writes,
      startedAtMs: args.startedAtMs,
      finishedAtMs: nowMs,
    };
    await writeBundle({
      root,
      nowMs,
      offerRoomRecords: await w.venue.read(OFFER_ROOM),
      dealRooms: new Map([
        [dealRoomA, await w.venue.read(dealRoomA)],
        [dealRoomB, await w.venue.read(dealRoomB)],
      ]),
      paperNotes: rawNote === undefined ? new Map() : new Map([[p.acceptB.contract, rawNote]]),
      writeExchanges: args.exchanges,
      sol: { config: v.config, rpc: v.createCapturingRpc(), ref: p.ref, terms: p.termsA, accounts },
      evidence: summary,
    });
    const result = await runAuditExport(root, `${p.swapId}=${args.outcome}`);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  }
  type BundleExchanges = readonly Exchange[];

  // -- 1 -----------------------------------------------------------------------------------------------------

  it("1: the lock send landed and its reply was lost: the restart resolves the recorded signature (pending, then landed), posts the lock frame once, sends nothing", async () => {
    const w = await newWorld();
    const startedAtMs = w.clock();
    const lossy = lossyFetch("sendTransaction");
    const first = w.buyerProc(lossy);
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairWithLines(w, buyerFlow, sellerFlow, honestLegA(w.clock()));
    const roomA = dealRoom(p.acceptA.contract);
    const buyerBefore = (await v.usdcBalanceOf(v.buyer.address)) as bigint;

    lossy.arm();
    await expect(buyerFlow.lockLegA()).rejects.toThrow(/connection reset while reading the reply to sendTransaction/);
    expect(lossy.lost()).toBe(1);
    const saved = await readRecord(w.buyerStore, "buyer", p.swapId);
    const handle = saved.lock.prepared?.recovery;
    if (handle === undefined || handle.chain !== "sol") throw new Error("test: no Solana recovery handle was recorded before commitLock");
    expect(saved.lock.attempted).toBe(true);
    expect(saved.lock.prepared?.ref).toBe(p.ref);
    expect(framesIn(await w.venue.read(roomA), "lock")).toHaveLength(0);

    // A new process. Until the chain decides, it signs nothing: LockPendingError; then the recorded signature is found landed.
    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("lockLegA");
    let lockA: Awaited<ReturnType<BuyerFlow["lockLegA"]>> | undefined;
    let pendingAnswers = 0;
    for (const deadline = Date.now() + 240_000; lockA === undefined; ) {
      try {
        lockA = await resumed.flow.lockLegA();
      } catch (error) {
        if (!(error instanceof LockPendingError)) throw error;
        pendingAnswers += 1;
        if (Date.now() >= deadline) throw new Error("test: the recorded lock never resolved");
        await sleep(2000);
      }
    }
    expect(pendingAnswers).toBeGreaterThanOrEqual(1); // the validator finalizes about 15 s behind the tip, so the first answer is "pending"
    expect(lockA.writeEvidence.ref).toBe(p.ref);
    expect(restarted.calls.count("sendTransaction")).toBe(0); // nothing was sent again, nothing new signed
    expect(await escrowStatus(p.ref)).toBe("Locked");
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(buyerBefore - 500_000n); // locked exactly once
    expect(framesIn(await w.venue.read(roomA), "lock")).toHaveLength(1);
    await resumed.flow.lockLegA(); // confirmed: the recorded result, nothing posted again
    expect(framesIn(await w.venue.read(roomA), "lock")).toHaveLength(1);

    const claimed = await sellerFlow.claimLegA(p.statement);
    expect(claimed.reveal).toBeDefined();
    const secret = await resumed.flow.learnSecret();
    expect(verifyHashPreimage(p.statement, secret)).toBe(true);
    expect(secret).toBe(w.sellerLock.preimage);
    await resumed.flow.claimLegB(secret);
    await finish({
      scenario: "lock-lost",
      w,
      p,
      rail: restarted.options.rail,
      outcome: "settled",
      startedAtMs,
      exchanges: [...buyerFlow.exchanges, ...resumed.flow.exchanges, ...sellerFlow.exchanges],
      writes: [
        { leg: "a", step: "lock", rail: SOL_RAIL_ID, evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: SOL_RAIL_ID, evidence: claimed.evidence },
      ],
    });
  }, 900_000);

  // -- 2 -----------------------------------------------------------------------------------------------------

  it("2: the claim send landed and its reply was lost: the record holds the claim signature, the restart resolves it (landed), posts the frames once, signs no second claim", async () => {
    const w = await newWorld();
    const startedAtMs = w.clock();
    const lossy = lossyFetch("sendTransaction");
    const first = w.sellerProc(lossy);
    const buyerFlow = new BuyerFlow(w.buyerProc().options);
    const sellerFlow = new SellerFlow(first.options);
    const p = await pairWithLines(w, buyerFlow, sellerFlow, honestLegA(w.clock()));
    const roomA = dealRoom(p.acceptA.contract);
    const lockA = await buyerFlow.lockLegA();
    const sellerBefore = (await v.usdcBalanceOf(v.seller.address)) ?? 0n;

    lossy.arm();
    await expect(sellerFlow.claimLegA(p.statement)).rejects.toThrow(/connection reset while reading the reply to sendTransaction/);
    expect(lossy.lost()).toBe(1);
    expect(first.calls.count("sendTransaction")).toBe(1);
    expect(framesIn(await w.venue.read(roomA), "reveal")).toHaveLength(0);
    // The claim signature was recorded before the send; it is the one transaction that lands.
    const saved = await readRecord(w.sellerStore, "seller", p.swapId);
    expect(saved.claimAttempted).toBe(true);
    expect(saved.claimRecords).toHaveLength(1);
    const claimSignature = saved.claimRecords[0]?.signature;
    if (claimSignature === undefined) throw new Error("test: no claim signature was recorded");
    await waitEscrowStatus(p.ref, "Claimed");
    expect(await signatureStatus(claimSignature)).toMatchObject({ confirmationStatus: "finalized", err: null });

    // A new process: the recorded signature is resolved on chain, nothing is signed again.
    const restarted = w.sellerProc();
    const resumed = await SellerFlow.resume({ ...restarted.options, swapId: p.swapId, contractA: p.acceptA.contract });
    expect(resumed.next).toBe("claimLegA");
    expect(resumed.flow.statement).toBe(p.statement);
    const claimed = await resumed.flow.claimLegA(p.statement);
    expect(claimed.reveal).toBeDefined();
    expect(claimed.receipt).toBeDefined();
    expect(restarted.calls.count("sendTransaction")).toBe(0); // no second claim
    expect(await v.usdcBalanceOf(v.seller.address)).toBe(sellerBefore + 500_000n); // paid exactly once
    const after = await w.venue.read(roomA);
    expect(framesIn(after, "reveal")).toHaveLength(1);
    expect(framesIn(after, "receipt")).toHaveLength(1);
    await resumed.flow.claimLegA(p.statement); // confirmed: the recorded frames, nothing posted again
    expect((await w.venue.read(roomA)).length).toBe(after.length);
    expect((await readRecord(w.sellerStore, "seller", p.swapId)).claimRecords).toHaveLength(0); // resolved: the record is dropped
    expect((await SellerFlow.resume({ ...w.sellerProc().options, swapId: p.swapId, contractA: p.acceptA.contract })).next).toBe("done");

    const secret = await buyerFlow.learnSecret();
    expect(secret).toBe(w.sellerLock.preimage);
    await buyerFlow.claimLegB(secret);
    await finish({
      scenario: "claim-lost",
      w,
      p,
      rail: restarted.options.rail,
      outcome: "settled",
      startedAtMs,
      exchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges, ...resumed.flow.exchanges],
      writes: [
        { leg: "a", step: "lock", rail: SOL_RAIL_ID, evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: SOL_RAIL_ID, evidence: claimed.evidence },
      ],
    });
  }, 900_000);

  // -- 3 -----------------------------------------------------------------------------------------------------

  it("3: the refund send landed and its reply was lost: the record holds the refund signature, the restart resolves it, posts the refund and receipt frames once, signs no second refund", async () => {
    // COMPRESSED window (see tests-sol/client-flows scenario 2): refundAfterMs is about 7 real minutes away and the flow clock runs
    // behind wall time so that the flows' own rule (at least 45 minutes from lock to refund) still sees 48 minutes.
    const refundAfterMs = Date.now() + 7 * MINUTE;
    const w = await newWorld({ skewMs: -(48 * MINUTE - 7 * MINUTE) });
    const t0 = w.clock();
    const lossy = lossyFetch("sendTransaction");
    const first = w.buyerProc(lossy);
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const legA: LegWindows = { lockTimeMs: t0, claimByMs: refundAfterMs - 5 * MINUTE - 1000, refundAfterMs, expiresMs: t0 + 30 * MINUTE };
    expect(refundAfterMs - t0).toBeGreaterThanOrEqual(47 * MINUTE);
    const p = await pairWithLines(w, buyerFlow, sellerFlow, legA);
    const roomA = dealRoom(p.acceptA.contract);
    const buyerBefore = (await v.usdcBalanceOf(v.buyer.address)) as bigint;
    const lockA = await buyerFlow.lockLegA();
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(buyerBefore - 500_000n);

    // The Seller never claims. The flow clock moves to real time and the REAL chain time is waited for.
    w.skew.ms = 0;
    while (Date.now() <= refundAfterMs + 1000) await sleep(1000);
    await waitChainTime(refundAfterMs);
    lossy.arm();
    await expect(buyerFlow.refundLegA()).rejects.toThrow(/connection reset while reading the reply to sendTransaction/);
    expect(lossy.lost()).toBe(1);
    expect(first.calls.count("sendTransaction")).toBe(2); // the lock and the refund
    expect(framesIn(await w.venue.read(roomA), "refund")).toHaveLength(0);
    // The refund signature was recorded before the send (the Buyer used to record none); it is the one transaction that lands.
    const saved = await readRecord(w.buyerStore, "buyer", p.swapId);
    const handle = saved.refund.recovery;
    if (handle === undefined || handle.chain !== "sol") throw new Error("test: no refund signature was recorded before the send");
    expect(saved.refund.attempted).toBe(true);
    await waitEscrowStatus(p.ref, "Refunded");
    expect(await signatureStatus(handle.signature)).toMatchObject({ confirmationStatus: "finalized", err: null });

    // A new process: the recorded signature is resolved, nothing is signed again.
    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("refundLegA");
    const refundA = await resumed.flow.refundLegA();
    expect(refundA.ref).toBe(p.ref);
    expect(restarted.calls.count("sendTransaction")).toBe(0); // no second refund
    expect(await v.usdcBalanceOf(v.buyer.address)).toBe(buyerBefore); // refunded exactly once
    const after = await w.venue.read(roomA);
    expect(framesIn(after, "refund")).toHaveLength(1);
    expect(framesIn(after, "receipt")).toHaveLength(1);
    expect((await BuyerFlow.resume({ ...w.buyerProc().options, swapId: p.swapId })).next).toBe("done");

    // Leg B (paper) needs only the flow clock, which is free to move arbitrarily far.
    w.skew.ms = 25 * HOUR;
    expect((await sellerFlow.refundLegB()).refund).toBeDefined();
    await finish({
      scenario: "refund-lost",
      w,
      p,
      rail: restarted.options.rail,
      outcome: "refunded",
      startedAtMs: t0,
      exchanges: [...buyerFlow.exchanges, ...resumed.flow.exchanges, ...sellerFlow.exchanges],
      writes: [
        { leg: "a", step: "lock", rail: SOL_RAIL_ID, evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: SOL_RAIL_ID, evidence: refundA },
      ],
    });
  }, 1_200_000);
});
