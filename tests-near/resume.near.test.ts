// SPDX-License-Identifier: MIT
//
// tests-near/resume.near.test.ts - P8-RESUME-SPEC.md "Tests", the NEAR part: one scenario on a real near-sandbox node. The
// Seller's claim of leg A landed on chain (final) and the reply to its `send_tx` was lost, so the process never knew; a fresh
// process resumes from the Seller's FileFlowStore directory alone, finds its own preimage revealed on the lock (`Claimed`, final),
// posts the reveal and receipt frames once and sends no second claim; the Buyer then learns the secret from the reveal frame and
// claims leg B, and the swap is replayed offline with `examples/audit-export.mjs --expect swapId=settled` as
// tests-near/client-flows does.
//
// The lost reply is real: a `fetch` wrapper lets the Seller's `send_tx` go to the sandbox, waits for the sandbox's own FINAL answer
// and throws it away. The restarted process's transport is a counter, and the test asserts it sent no `send_tx` at all.
// `npm run test:near` only; `npm test` never spawns near-sandbox.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, generateHashLock, paperNote, tryDecodeFrame, verifyHashPreimage, type HashLock, type LockTerms, type TranscriptRecord } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow, type BuyerFlowOptions } from "../src/client/buyer.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { FileFlowStore, type FlowStore } from "../src/client/flow-store.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { SellerFlow, type SellerFlowOptions } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import type { NearAccounts } from "../src/rails/near-evidence.js";
import { NearRpc } from "../src/rails/near-rpc.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { assertSavesClean, countingFetch, lossyFetch, RecordingStore, swapProblems, type CountingFetch, type LossyFetch } from "../tests/helpers/live-resume.js";
import { startNearSandbox, type NearSandboxHandle } from "./helpers/sandbox.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/** The bundle directory and the two store directories, removed in `afterAll` (`KEEP_NEAR_BUNDLES=1` keeps them). */
const scratch: string[] = [];

async function scratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `flop-resume-near-${label}-`));
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

/** The same windows tests-near/client-flows uses: a 47 minute leg A window, a 24 hour leg B window (paper, flow clock only). */
function legADeadlines(t0: number) {
  return { lockTimeMs: t0, claimByMs: t0 + 20 * 60_000, refundAfterMs: t0 + 47 * 60_000, expiresMs: t0 + 10 * 60_000 };
}
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 12 * 60 * 60_000, refundAfterMs: t0 + 24 * 60 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

interface Proc<O, T extends CountingFetch = CountingFetch> {
  options: O;
  calls: T;
}

describe("Resume on a real near-sandbox node: a Seller whose claim landed and whose reply was lost", () => {
  let sandbox: NearSandboxHandle;

  beforeAll(async () => {
    sandbox = await startNearSandbox();
  }, 300_000);

  afterAll(async () => {
    if (sandbox !== undefined) await sandbox.stop();
    if (process.env.KEEP_NEAR_BUNDLES !== "1") await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function chainNowMs(): Promise<number> {
    const block = await new NearRpc(sandbox.createCapturingRpc()).block({ finality: "final" });
    return Number(BigInt(block.header.timestampNs) / 1_000_000n);
  }

  it("the claim landed (final) and its reply was lost: the restart reads its own preimage off the lock, posts the reveal and receipt once, sends no second claim", async () => {
    const buyer: Identity = identity("a1".repeat(32));
    const seller: Identity = identity("a2".repeat(32));
    const seeds = ["a1", "a2"].map((hex) => Buffer.from(hex.repeat(32), "hex"));
    const t0 = await chainNowMs();
    const clockRef = { ms: t0 };
    const clock = (): number => clockRef.ms;
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const buyerStore = new RecordingStore(new FileFlowStore(await scratchDir("buyer")));
    const sellerStore = new RecordingStore(new FileFlowStore(await scratchDir("seller")));
    const sellerLock: HashLock = generateHashLock();

    function buyerProc(): Proc<BuyerFlowOptions & { store: FlowStore }> {
      const calls = countingFetch();
      const rail: CounterAssetRail = createNearCounterRail({ config: sandbox.config, rpc: sandbox.createCapturingRpc({ fetch: calls.fetch }), signer: sandbox.buyer.signer, clock });
      return { calls, options: { identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail, clock, store: buyerStore } };
    }
    function sellerProc(transport?: LossyFetch): Proc<SellerFlowOptions & { store: FlowStore }, CountingFetch> {
      const calls: CountingFetch = transport ?? countingFetch();
      const rail: CounterAssetRail = createNearCounterRail({ config: sandbox.config, rpc: sandbox.createCapturingRpc({ fetch: calls.fetch }), signer: sandbox.seller.signer, clock });
      return { calls, options: { identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail, clock, store: sellerStore, mintHashLock: () => sellerLock } };
    }

    const lossy = lossyFetch("send_tx");
    const buyerFlow = new BuyerFlow(buyerProc().options);
    const first = sellerProc(lossy);
    const sellerFlow = new SellerFlow(first.options);

    // bid -> accepts -> leg B locked -> both account lines -> the Buyer's lock (the Seller's flow writes its store throughout)
    const swapId = computeSwapId(buyer.did, "000000a1");
    const legA = legADeadlines(t0);
    const offerA = await buyerFlow.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "500000", asset: "USDC", claimByMs: legA.claimByMs, refundAfterMs: legA.refundAfterMs, expiresMs: legA.expiresMs });
    const { acceptA, acceptARecord, offerB, offerBRecord } = await sellerFlow.acceptLegA(offerA, legBDeadlines(t0), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
    await sellerFlow.lockLegB(acceptBRecord);
    await buyerFlow.verifyLegBLocked();
    await sellerFlow.postAccountLineA(sandbox.seller.accountId);
    await buyerFlow.postAccountLineA(sandbox.buyer.accountId);
    const lockA = await buyerFlow.lockLegA();
    const statement = acceptA.statement;
    const roomA = dealRoom(acceptA.contract);
    expect(framesIn(await venue.read(roomA), "lock")).toHaveLength(1);

    // The claim goes out and lands; its answer never reaches the process.
    lossy.arm();
    await expect(sellerFlow.claimLegA(statement)).rejects.toThrow(/connection reset while reading the reply to send_tx/);
    expect(lossy.lost()).toBe(1);
    expect(first.calls.count("send_tx")).toBe(1);
    const near = new NearRpc(sandbox.createCapturingRpc());
    const view = JSON.parse((await near.callFunction(sandbox.htlcContract, "get_lock", { hash_lock: statement.slice(2), payer: sandbox.buyer.accountId })).resultText) as { status: string };
    expect(view.status).toBe("Claimed"); // it did land
    expect(framesIn(await venue.read(roomA), "reveal")).toHaveLength(0);

    // A new process: nothing in memory, only the Seller's store directory.
    const restarted = sellerProc();
    const resumed = await SellerFlow.resume({ ...restarted.options, swapId });
    expect(resumed.next).toBe("claimLegA");
    expect(resumed.flow.statement).toBe(statement);
    const claimed = await resumed.flow.claimLegA(statement);
    expect(claimed.reveal).toBeDefined();
    expect(claimed.receipt).toBeDefined();
    expect(restarted.calls.count("send_tx")).toBe(0); // no second claim
    const after = await venue.read(roomA);
    expect(framesIn(after, "reveal")).toHaveLength(1);
    expect(framesIn(after, "receipt")).toHaveLength(1);
    await resumed.flow.claimLegA(statement); // confirmed: the recorded frames, nothing posted again
    expect((await venue.read(roomA)).length).toBe(after.length);
    expect((await SellerFlow.resume({ ...sellerProc().options, swapId })).next).toBe("done");

    const secret = await buyerFlow.learnSecret();
    expect(verifyHashPreimage(statement, secret)).toBe(true);
    expect(secret).toBe(sellerLock.preimage);
    await buyerFlow.claimLegB(secret);

    // The audits, then the offline replay of the bundle.
    expect(
      await swapProblems({ venue, contractA: acceptA.contract, contractB: acceptB.contract, offerAId: offerA.id, offerBId: offerB.id, buyerDid: buyer.did, sellerDid: seller.did, outcome: "settled" }),
    ).toEqual([]);
    expect(assertSavesClean({ buyer: buyerStore, seller: sellerStore, preimage: sellerLock.preimage, seeds })).toEqual([]);

    const termsA: LockTerms = offerAcceptLockTerms(offerA, acceptA);
    const resolved = restarted.options.rail.resolveAccounts(await venue.read(roomA), { contract: acceptA.contract, payerDid: termsA.payer, payeeDid: termsA.payee });
    const accounts: NearAccounts = {
      ...(resolved.payee === undefined ? {} : { payee: resolved.payee }),
      ...(resolved.payer === undefined ? {} : { payer: resolved.payer }),
      ...(resolved.payeeKey === undefined ? {} : { payeeKey: resolved.payeeKey }),
      ...(resolved.payerKey === undefined ? {} : { payerKey: resolved.payerKey }),
    };
    const root = await scratchDir("bundle");
    const roomB = dealRoom(acceptB.contract);
    const { ns, key } = paperNote(acceptB.contract);
    const rawNote = noteStore.raw(ns, key);
    const summary: BundleEvidenceSummary = {
      swapId,
      legA: { contract: acceptA.contract, rail: "near-htlc" },
      legB: { contract: acceptB.contract, rail: "paper" },
      feeBps: 0,
      writes: [
        { leg: "a", step: "lock", rail: "near-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "near-htlc", evidence: claimed.evidence },
      ],
      startedAtMs: t0,
      finishedAtMs: clock(),
    };
    await writeBundle({
      root,
      nowMs: clock(),
      offerRoomRecords: await venue.read(OFFER_ROOM),
      dealRooms: new Map([
        [roomA, await venue.read(roomA)],
        [roomB, await venue.read(roomB)],
      ]),
      paperNotes: rawNote === undefined ? new Map() : new Map([[acceptB.contract, rawNote]]),
      writeExchanges: [...buyerFlow.exchanges, ...sellerFlow.exchanges, ...resumed.flow.exchanges],
      near: { config: sandbox.config, rpc: sandbox.createCapturingRpc(), ref: lockA.writeEvidence.ref, terms: termsA, accounts },
      evidence: summary,
    });
    const result = await runAuditExport(root, `${swapId}=settled`);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  }, 180_000);
});
