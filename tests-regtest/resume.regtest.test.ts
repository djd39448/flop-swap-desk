// SPDX-License-Identifier: MIT
//
// tests-regtest/resume.regtest.test.ts - P8-RESUME-SPEC.md "Tests", the Bitcoin part: the Buyer process dies at the two instants
// where a Bitcoin transaction exists only as signed bytes, a fresh process resumes from its FileFlowStore directory alone, and the
// swap ends in the right status, replayed offline with `examples/audit-export.mjs --expect` as tests-regtest/client-flows does.
//
// Bitcoin is the rail where a second attempt can lose money (a second funding picks other inputs and makes a second outpoint; a
// second refund can race the first), so the rule under test is rule 2: the restart never re-prepares, it re-sends the SAME recorded
// bytes. Each test proves that from the wire, not from the flow's own report: the restarted process's transport is a counter, and
// the test reads the exact bytes of every `sendrawtransaction` it made and the number of wallet signing calls (zero).
//
//   1  crash between `prepareLock` and `commitLock`: the funding rawTx is in the record, the node never saw it. The restart's
//      `recoverLock` re-broadcasts the recorded bytes (the node then holds exactly the recorded txid), posts the lock frame once.
//   1b the funding broadcast landed and its reply was lost: the node already knows the recorded txid, so the restart sends nothing.
//   2  the refund broadcast landed and its reply was lost, then the refund fell out of the node's mempool (a real eviction, a node
//      with `-mempoolexpiry=1`): the restart's `recoverRefund` re-sends the recorded refund bytes while the funding output is
//      unspent, never signs a second refund; mined, the swap refunds.
//   2b the refund was signed and recorded and the process died before sending it: same recovery, no eviction needed.
// `npm run test:regtest` only; `npm test` never spawns bitcoind.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, generateHashLock, paperNote, tryDecodeFrame, verifyHashPreimage, type HashLock, type LockTerms, type TranscriptRecord } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow, type BuyerFlowOptions } from "../src/client/buyer.js";
import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { decodeFlowRecord, type BuyerFlowRecord } from "../src/client/flow-record.js";
import { FileFlowStore, flowKey, type FlowStore } from "../src/client/flow-store.js";
import { SellerFlow, type SellerFlowOptions } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import type { BtcAccounts } from "../src/rails/btc-evidence.js";
import { BTC_REGTEST_PIN, keyFromAddressInfo, type BtcRailConfig, type BtcSignerKey } from "../src/rails/btc-htlc.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { assertSavesClean, countingFetch, droppingFetch, lossyFetch, RecordingStore, swapProblems, type CountingFetch, type Outcome } from "../tests/helpers/live-resume.js";
import { crashRail } from "../tests/helpers/resume-flows.js";
import { startBitcoind, type BitcoindHandle, type RegtestWallet } from "./helpers/bitcoind.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

/** Every scenario's bundle directory and store directories, removed in `afterAll` (`KEEP_REGTEST_BUNDLES=1` keeps them). */
const scratch: string[] = [];

async function scratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `flop-resume-btc-${label}-`));
  scratch.push(dir);
  return dir;
}

function keyFor(wallet: RegtestWallet): BtcSignerKey {
  return keyFromAddressInfo({ pubkey: wallet.pubkey, hdmasterfingerprint: wallet.hdMasterFingerprint, hdkeypath: wallet.hdKeyPath });
}

async function currentMediantimeMs(node: BitcoindHandle): Promise<number> {
  const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
  return info.mediantime * 1000;
}

/** The same windows tests-regtest/client-flows-g uses: a 5 hour refund window on leg A, comfortably clear of BTC_LOCAL_POLICY. */
function legADeadlines(t0: number) {
  return { claimByMs: t0 + 3 * 60 * 60_000, refundAfterMs: t0 + 5 * 60 * 60_000, expiresMs: t0 + 30 * 60_000 };
}
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 9 * 60 * 60_000, refundAfterMs: t0 + 20 * 60 * 60_000, expiresMs: t0 + 40 * 60_000 };
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
interface Proc<O, T extends CountingFetch = CountingFetch> {
  options: O;
  calls: T;
}

/** The two things a Bitcoin lock or refund must never do twice: sign with the wallet. */
const walletSigns = (calls: CountingFetch): number => calls.count("walletcreatefundedpsbt") + calls.count("walletprocesspsbt");

let scenarioCount = 0;

function installSuite(label: string, startNode: () => Promise<BitcoindHandle>, body: (ctx: { node: () => BitcoindHandle; config: () => BtcRailConfig; world: () => Promise<World> }) => void): void {
  describe(label, () => {
    let node: BitcoindHandle;
    let config: BtcRailConfig;
    beforeAll(async () => {
      node = await startNode();
      config = { pin: { ...BTC_REGTEST_PIN, finality: { confirmations: 2 } }, endpoint: node.endpoint };
    }, 120_000);
    afterAll(async () => {
      await node?.stop();
      if (process.env.KEEP_REGTEST_BUNDLES !== "1") await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });
    body({ node: () => node, config: () => config, world: () => buildWorld(node, config) });
  });
}

/** One swap's world: the venue, the note store, the clock, both parties' store directories and the secret the Seller mints. */
async function buildWorld(node: BitcoindHandle, config: BtcRailConfig) {
  scenarioCount += 1;
  const tag = 100 + scenarioCount * 2;
  const seedHex = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);
  const buyer: Identity = identity(seedHex(tag));
  const seller: Identity = identity(seedHex(tag + 1));
  const seeds = [tag, tag + 1].map((n) => Buffer.from(seedHex(n), "hex"));
  const t0 = await currentMediantimeMs(node);
  const clockRef = { ms: t0 };
  const clock = (): number => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const buyerStore = new RecordingStore(new FileFlowStore(await scratchDir("buyer")));
  const sellerStore = new RecordingStore(new FileFlowStore(await scratchDir("seller")));
  const sellerLock: HashLock = generateHashLock();

  /** A new Buyer process: its own transport (`calls`) and rail, a fresh `PaperRail` over the shared notes. */
  function buyerProc<T extends CountingFetch = CountingFetch>(calls?: T, wrap?: (rail: CounterAssetRail) => CounterAssetRail): Proc<BuyerFlowOptions & { store: FlowStore }, T> {
    const transport = (calls ?? countingFetch()) as T;
    const rail = createBtcCounterRail({
      config,
      rpc: node.createCapturingRpc({ fetch: transport.fetch }),
      wallet: node.buyer.wallet,
      key: keyFor(node.buyer),
      destinationAddress: node.buyer.address,
      clock,
    });
    return { calls: transport, options: { identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: wrap === undefined ? rail : wrap(rail), clock, store: buyerStore } };
  }
  function sellerProc(): Proc<SellerFlowOptions & { store: FlowStore }> {
    const calls = countingFetch();
    const rail = createBtcCounterRail({
      config,
      rpc: node.createCapturingRpc({ fetch: calls.fetch }),
      wallet: node.seller.wallet,
      key: keyFor(node.seller),
      destinationAddress: node.seller.address,
      clock,
    });
    return { calls, options: { identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail, clock, store: sellerStore, mintHashLock: () => sellerLock } };
  }

  /** `setmocktime` plus enough blocks that the chain's median time passes `nowMs` (as client-flows-g does). */
  async function warpTo(nowMs: number): Promise<void> {
    clockRef.ms = nowMs;
    await node.setMockTime(Math.floor(nowMs / 1000) + 1);
    await node.mine(11);
  }
  const mineBlocks = async (n: number): Promise<void> => void (await node.mine(n));

  return { node, config, t0, buyer, seller, seeds, clockRef, clock, venue, noteStore, buyerStore, sellerStore, sellerLock, buyerProc, sellerProc, warpTo, mineBlocks, nonce: scenarioCount.toString(16).padStart(8, "0") };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both pubkey lines, with flows that write to their stores. */
async function pairAndVerify(w: World, buyerFlow: BuyerFlow, sellerFlow: SellerFlow) {
  const swapId = computeSwapId(w.buyer.did, w.nonce);
  const offerA = await buyerFlow.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "BTC", ...legADeadlines(w.t0) });
  const { acceptA, acceptARecord, offerB, offerBRecord } = await sellerFlow.acceptLegA(offerA, legBDeadlines(w.t0), w.t0);
  const { acceptB, acceptBRecord } = await buyerFlow.acceptLegB(offerBRecord, acceptARecord, w.t0);
  await sellerFlow.lockLegB(acceptBRecord);
  await buyerFlow.verifyLegBLocked();
  await sellerFlow.postAccountLineA(w.node.seller.pubkey.toLowerCase());
  await buyerFlow.postAccountLineA(w.node.buyer.pubkey.toLowerCase());
  return { swapId, offerA, offerB, acceptA, acceptB, statement: acceptA.statement, termsA: offerAcceptLockTerms(offerA, acceptA) };
}
type Paired = Awaited<ReturnType<typeof pairAndVerify>>;

/** The Buyer's stored record, decoded by the library's own decoder. */
async function readBuyerRecord(w: World, swapId: string): Promise<BuyerFlowRecord> {
  const key = flowKey("buyer", swapId);
  const bytes = await w.buyerStore.load(key);
  if (bytes === null) throw new Error("test: the Buyer has no stored record");
  const record = decodeFlowRecord(bytes, key);
  if (record.role !== "buyer") throw new Error("test: the stored record is not a Buyer's");
  return record;
}

/** Both parties' resolved pubkeys for leg A, as the flows resolve them (a bundle's Bitcoin capture needs them). */
async function resolveBtcAccounts(w: World, rail: CounterAssetRail, contract: string, terms: LockTerms): Promise<BtcAccounts> {
  const resolved = rail.resolveAccounts(await w.venue.read(dealRoom(contract)), { contract, payerDid: terms.payer, payeeDid: terms.payee });
  return {
    ...(resolved.payee === undefined ? {} : { payeePubkey: resolved.payee }),
    ...(resolved.payer === undefined ? {} : { payerPubkey: resolved.payer }),
  };
}

/** The audits every finished scenario ends with, then the offline replay of its bundle (as tests-regtest/client-flows does). */
async function finish(args: {
  scenario: string;
  w: World;
  p: Paired;
  rail: CounterAssetRail;
  lockRef: string;
  outcome: Outcome;
  writes: BundleEvidenceSummary["writes"];
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
    legA: { contract: p.acceptA.contract, rail: "btc-htlc" },
    legB: { contract: p.acceptB.contract, rail: "paper" },
    feeBps: 0,
    writes: args.writes,
    startedAtMs: w.t0,
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
    btc: { config: w.config, rpc: w.node.createCapturingRpc(), ref: args.lockRef, terms: p.termsA, accounts: await resolveBtcAccounts(w, args.rail, p.acceptA.contract, p.termsA) },
    evidence: summary,
  });
  const result = await runAuditExport(root, `${p.swapId}=${args.outcome}`);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
}

// -- the suites ----------------------------------------------------------------------------------------------------

installSuite("Resume on bitcoind regtest: the Buyer's funding and refund exist only as recorded bytes", () => startBitcoind(), ({ node, world }) => {
  /** After the Buyer's lock frame is posted: finality, the Seller's claim, the Buyer learns the secret and claims leg B. */
  async function settle(w: World, p: Paired, buyerFlow: BuyerFlow, sellerFlow: SellerFlow): Promise<void> {
    await w.mineBlocks(2);
    const claimed = await sellerFlow.claimLegA(p.statement);
    expect(claimed.reveal).toBeDefined();
    await w.mineBlocks(2);
    const secret = await buyerFlow.learnSecret();
    expect(verifyHashPreimage(p.statement, secret)).toBe(true);
    expect(secret).toBe(w.sellerLock.preimage);
    await buyerFlow.claimLegB(secret);
  }

  it("1: the funding was signed and recorded and the process died before sending it: the restart re-sends the SAME bytes, signs nothing new", async () => {
    const w = await world();
    const crashed = w.buyerProc(countingFetch(), (rail) => crashRail(rail, { before: ["commitLock"] }));
    const buyerFlow = new BuyerFlow(crashed.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairAndVerify(w, buyerFlow, sellerFlow);

    await expect(buyerFlow.lockLegA()).rejects.toThrow(/process died before commitLock/);
    const saved = await readBuyerRecord(w, p.swapId);
    const handle = saved.lock.prepared?.recovery;
    if (handle === undefined || handle.chain !== "btc" || saved.lock.prepared === undefined) throw new Error("test: no Bitcoin recovery handle was recorded before commitLock");
    expect(saved.lock.attempted).toBe(true);
    expect(saved.lock.prepared.ref.startsWith(`${handle.txid}:`)).toBe(true);
    expect(crashed.calls.count("sendrawtransaction")).toBe(0);
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toEqual([]);
    await expect(node().rpcCall("getrawtransaction", [handle.txid])).rejects.toThrow(); // the node has never seen it

    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("lockLegA");
    const lockA = await resumed.flow.lockLegA();
    expect(lockA.writeEvidence.ref).toBe(saved.lock.prepared.ref);
    const sends = restarted.calls.requests.filter((call) => call.method === "sendrawtransaction");
    expect(sends).toHaveLength(1);
    expect((sends[0]?.params as unknown[])[0]).toBe(handle.rawTx); // the identical recorded bytes
    expect(walletSigns(restarted.calls)).toBe(0); // nothing new was built or signed
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toEqual([handle.txid]); // one funding, the recorded one
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(1);
    await resumed.flow.lockLegA(); // confirmed: the recorded result, nothing posted or sent again
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(1);
    expect(restarted.calls.count("sendrawtransaction")).toBe(1);

    await settle(w, p, resumed.flow, sellerFlow);
    await finish({
      scenario: "funding-unsent",
      w,
      p,
      rail: restarted.options.rail,
      lockRef: lockA.writeEvidence.ref,
      outcome: "settled",
      writes: [
        { leg: "a", step: "lock", rail: "btc-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "btc-htlc", evidence: { ref: lockA.writeEvidence.ref, raw: [] } },
      ],
    });
  }, 120_000);

  it("1b: the funding broadcast landed and its reply was lost: the node already knows the recorded txid, so the restart sends nothing at all", async () => {
    const w = await world();
    const lossy = lossyFetch("sendrawtransaction");
    const first = w.buyerProc(lossy);
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairAndVerify(w, buyerFlow, sellerFlow);

    lossy.arm();
    await expect(buyerFlow.lockLegA()).rejects.toThrow(/connection reset while reading the reply to sendrawtransaction/);
    expect(lossy.lost()).toBe(1);
    const saved = await readBuyerRecord(w, p.swapId);
    const handle = saved.lock.prepared?.recovery;
    if (handle === undefined || handle.chain !== "btc") throw new Error("test: no Bitcoin recovery handle was recorded");
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toEqual([handle.txid]); // it did reach the node
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(0);

    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("lockLegA");
    const lockA = await resumed.flow.lockLegA();
    expect(lockA.writeEvidence.ref).toBe(saved.lock.prepared?.ref);
    expect(restarted.calls.count("sendrawtransaction")).toBe(0);
    expect(walletSigns(restarted.calls)).toBe(0);
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toEqual([handle.txid]);
    expect(framesIn(await w.venue.read(dealRoom(p.acceptA.contract)), "lock")).toHaveLength(1);

    await settle(w, p, resumed.flow, sellerFlow);
    await finish({
      scenario: "funding-lost",
      w,
      p,
      rail: restarted.options.rail,
      lockRef: lockA.writeEvidence.ref,
      outcome: "settled",
      writes: [
        { leg: "a", step: "lock", rail: "btc-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "btc-htlc", evidence: { ref: lockA.writeEvidence.ref, raw: [] } },
      ],
    });
  }, 120_000);

  it("2b: the refund was signed and recorded and the process died before sending it: the restart re-sends the recorded refund bytes, signs no second refund", async () => {
    const w = await world();
    const dropping = droppingFetch("sendrawtransaction");
    const first = w.buyerProc(dropping);
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairAndVerify(w, buyerFlow, sellerFlow);
    const lockA = await buyerFlow.lockLegA();
    await w.mineBlocks(2);

    await w.warpTo(p.offerA.refundAfterMs + 5 * 60_000); // the Seller never claims
    dropping.arm();
    await expect(buyerFlow.refundLegA()).rejects.toThrow(/connection refused before sending sendrawtransaction/);
    expect(dropping.dropped()).toBe(1);
    const saved = await readBuyerRecord(w, p.swapId);
    const handle = saved.refund.recovery;
    if (handle === undefined || handle.chain !== "btc") throw new Error("test: no refund handle was recorded before the send");
    expect(saved.refund.attempted).toBe(true);
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toEqual([]); // the refund never reached the node
    const [fundTxid, fundVout] = lockA.writeEvidence.ref.split(":");
    expect(await node().rpcCall("gettxout", [fundTxid, Number(fundVout), true])).not.toBeNull(); // the funding output is unspent

    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("refundLegA");
    await expect(resumed.flow.refundLegA()).rejects.toThrow(/not yet confirmed/); // re-sent, not mined yet
    const sends = restarted.calls.requests.filter((call) => call.method === "sendrawtransaction");
    expect(sends).toHaveLength(1);
    expect((sends[0]?.params as unknown[])[0]).toBe(handle.rawTx); // the identical recorded bytes
    expect(walletSigns(restarted.calls)).toBe(0); // no second refund was built or signed
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toEqual([handle.txid]);

    await w.mineBlocks(2);
    const refundA = await resumed.flow.refundLegA();
    expect(refundA.txid).toBe(handle.txid);
    expect(restarted.calls.count("sendrawtransaction")).toBe(1);
    expect(walletSigns(restarted.calls)).toBe(0);
    const roomA = await w.venue.read(dealRoom(p.acceptA.contract));
    expect(framesIn(roomA, "refund")).toHaveLength(1);
    expect(framesIn(roomA, "receipt")).toHaveLength(1);
    expect((await BuyerFlow.resume({ ...w.buyerProc().options, swapId: p.swapId })).next).toBe("done");

    await w.warpTo(p.offerB.refundAfterMs + 60_000);
    expect((await sellerFlow.refundLegB()).refund).toBeDefined();
    await w.mineBlocks(2);
    await finish({
      scenario: "refund-unsent",
      w,
      p,
      rail: restarted.options.rail,
      lockRef: lockA.writeEvidence.ref,
      outcome: "refunded",
      writes: [
        { leg: "a", step: "lock", rail: "btc-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: "btc-htlc", evidence: refundA },
      ],
    });
  }, 120_000);
});

// A real mempool eviction needs its own node (`-mempoolexpiry=1`, as client-flows-g's R2-1 does), so this is a separate suite.
installSuite("Resume on bitcoind regtest: a refund whose reply was lost and that then left the mempool", () => startBitcoind({ extraArgs: ["-mempoolexpiry=1"] }), ({ node, world }) => {
  it("2: the refund broadcast landed, its reply was lost, then it expired from the mempool: the restart re-sends the recorded bytes (same txid), the swap refunds", async () => {
    const w = await world();
    const lossy = lossyFetch("sendrawtransaction");
    const first = w.buyerProc(lossy);
    const buyerFlow = new BuyerFlow(first.options);
    const sellerFlow = new SellerFlow(w.sellerProc().options);
    const p = await pairAndVerify(w, buyerFlow, sellerFlow);
    const lockA = await buyerFlow.lockLegA();
    await w.mineBlocks(2);

    const refundAtMs = p.offerA.refundAfterMs + 5 * 60_000;
    await w.warpTo(refundAtMs); // the Seller never claims
    lossy.arm();
    await expect(buyerFlow.refundLegA()).rejects.toThrow(/connection reset while reading the reply to sendrawtransaction/);
    expect(lossy.lost()).toBe(1);
    const saved = await readBuyerRecord(w, p.swapId);
    const handle = saved.refund.recovery;
    if (handle === undefined || handle.chain !== "btc") throw new Error("test: no refund handle was recorded before the send");
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toEqual([handle.txid]); // the refund did reach the node

    // Past the node's 1 hour mempool expiry, one unrelated transaction makes it sweep: the refund is gone, the funding unspent.
    await node().setMockTime(Math.floor(refundAtMs / 1000) + 1 + 2 * 60 * 60);
    await node().rpcCall("sendtoaddress", [node().seller.address, 0.0001], `/wallet/${node().buyer.wallet}`);
    expect(await node().rpcCall<string[]>("getrawmempool", [])).not.toContain(handle.txid);
    const [fundTxid, fundVout] = lockA.writeEvidence.ref.split(":");
    expect(await node().rpcCall("gettxout", [fundTxid, Number(fundVout), true])).not.toBeNull();

    const restarted = w.buyerProc();
    const resumed = await BuyerFlow.resume({ ...restarted.options, swapId: p.swapId });
    expect(resumed.next).toBe("refundLegA");
    await expect(resumed.flow.refundLegA()).rejects.toThrow(/not yet confirmed/);
    const sends = restarted.calls.requests.filter((call) => call.method === "sendrawtransaction");
    expect(sends).toHaveLength(1);
    expect((sends[0]?.params as unknown[])[0]).toBe(handle.rawTx); // the identical recorded bytes, back in the mempool
    expect(walletSigns(restarted.calls)).toBe(0);
    expect(await node().rpcCall<string[]>("getrawmempool", [])).toContain(handle.txid);

    await w.mineBlocks(2);
    const refundA = await resumed.flow.refundLegA();
    expect(refundA.txid).toBe(handle.txid);
    expect(restarted.calls.count("sendrawtransaction")).toBe(1);
    const roomA = await w.venue.read(dealRoom(p.acceptA.contract));
    expect(framesIn(roomA, "refund")).toHaveLength(1);
    expect(framesIn(roomA, "receipt")).toHaveLength(1);

    await w.warpTo(p.offerB.refundAfterMs + 60_000);
    expect((await sellerFlow.refundLegB()).refund).toBeDefined();
    await w.mineBlocks(2);
    await finish({
      scenario: "refund-lost",
      w,
      p,
      rail: restarted.options.rail,
      lockRef: lockA.writeEvidence.ref,
      outcome: "refunded",
      writes: [
        { leg: "a", step: "lock", rail: "btc-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: "btc-htlc", evidence: refundA },
      ],
    });
  }, 120_000);
});
