// SPDX-License-Identifier: MIT
//
// tests-near/client-flows.near.test.ts — Stage NB-int part 2 (P5-NEAR-SPEC.md §5): the
// Seller/Buyer client flows (src/client/seller.ts, src/client/buyer.ts) end to end against a
// real `near-sandbox` node (tests-near/helpers/sandbox.ts), with the counter-asset leg on
// `near-htlc` (src/client/near-rail.ts) and the FLOP leg on tclk's own `PaperRail` over one
// in-memory `NoteStore`. Mirrors tests-regtest/client-flows.regtest.test.ts's own structure
// (one shared node for the whole file, `writeBundle` + `examples/audit-export.mjs` replay per
// scenario, `CAPTURE_NEAR_FIXTURES`) with NEAR's own primitives swapped in for Bitcoin's:
// account ids instead of a dual-pubkey script (D-N5), the `0x<hash lock>:<payer>` write ref
// instead of a funding outpoint (squatting fix, replacing D-N4), and `sandbox.fastForward` (D-N7: the FINAL block's own
// timestamp advances with height under fast-forward) to cross a `refundAfterMs` deadline instead
// of Bitcoin's `setmocktime` + mining.
//
// Every leg-A deadline below is anchored to the SANDBOX's own current final-block chain time
// (`chainNowMs()`), read fresh per scenario — never a fixed synthetic epoch — because
// `NearHtlcRail.claim()`/`.refund()` always judge their own window against a fresh `final` read
// (D-N7), never wall-clock. `legADeadlines`' own window (47 min) is sized just over
// `NEAR_LOCAL_POLICY.minRevealWindowMs` (45 min — `src/client/policy.ts` reuses EVM's own value
// verbatim, per D-N8's own explicit "not re-derived, pending NB-int's own live sandbox timing";
// this file measures the sandbox's own real timing but does not itself tighten that shared
// constant — see `legADeadlines`' own doc comment) — the minimum this build's own shared flow
// logic will accept — to keep the "refunded" scenario's own `fastForward` call (the only one this
// file needs) to on the order of a minute or two of real wall time rather than the much longer
// real time a wider, more "realistic" window would cost (measured empirically this stage:
// near-sandbox's own `sandbox_fast_forward` costs ~9-13 ms of real wall time per simulated block,
// and D-N7 found ~337 ms of simulated chain time per fast-forwarded block, so crossing ~48 min of
// simulated time costs on the order of 8-9k blocks, ~75-115 s of real time — this is why this
// file, unlike the mocked `tests/client-flows-near.test.ts`, cannot simply pick hour-scale windows
// the way that hermetic file does).
//
// Leg B (the FLOP/`paper` leg) is governed only by this harness's own JS clock (`clock()`),
// never the NEAR chain — so warping it forward (scenario "refunded"'s own leg-B refund, `refunded
// -b`'s only refund) is a free `clockRef.ms = ...` assignment, no sandbox interaction at all.
//
// Scenario 4 ("claim refused before finality") has no BTC-style confirmations count to wait on —
// NEAR's own `send_tx` with `wait_until: "FINAL"` (D-N4/D-N9) already blocks until a write is
// finalized, so there is no observable "broadcast but not yet final" window for a write that
// actually happened. Instead this file exercises the same underlying guard
// (`SellerFlow.claimLegA`'s own `D-11` check, `evidence.lock.railVerified !== true`, the
// identical `/verifyLockFinal\(A\) is true/` message BTC's own scenario 4 pins) against a lock
// that was never written at all: the Seller attempts to claim before the Buyer ever calls
// `lockLegA()`, which fails the exact same guard for the exact same reason (no finalized on-chain
// lock exists yet) as a not-yet-final write would.
//
// Scenario 7 ("lost replies") is scoped to what `src/client/near-rail.ts`'s own header comment
// documents: `NearHtlcRail.recoverByTxHash` exists for "a caller resuming after an interruption
// between `sendPrepared`'s own `send_tx` and its return" — it is a rail-level primitive
// (`tests-near/near-htlc.near.test.ts` already pins it directly), never something
// `BuyerFlow`/`SellerFlow` call internally (D-N6: NEAR has no mempool-drop concept for the flow
// layer's own `resendRefundIfDropped` machinery to paper over the way BTC's does). This file's
// own version shows the SAME recovery mechanism from inside a real client flow: after the
// Buyer's `lockLegA()` completes normally (frames posted), a caller who separately holds only the
// write's own recorded `txHash` recovers evidence from the chain that is byte-identical
// (`blockHash`) to what the flow itself received — proving that had this reply actually been
// lost, the exact same evidence (and so the exact same frame) was still recoverable, without
// claiming this build's `BuyerFlow` retries automatically (it does not, by design).
//
// Fixtures `fixtures/near-sandbox-2026-09-29/{settled,refunded,refunded-b}/`, regenerated only
// with `CAPTURE_NEAR_FIXTURES=1` (mirrors `CAPTURE_BTC_FIXTURES` exactly); every other run writes
// to a fresh `mkdtemp` directory, cleaned up in `afterAll` unless `KEEP_NEAR_BUNDLES=1`.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { base58 } from "@scure/base";
import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, paperNote, tryDecodeFrame, verifyHashPreimage, type LockTerms } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { buildSignedTransaction, type NearAction } from "../src/rails/near-borsh.js";
import type { NearAccounts } from "../src/rails/near-evidence.js";
import { NearHtlcRail, type NearRailConfig, type NearSigner } from "../src/rails/near-htlc.js";
import { NearRpc, NearTimeoutError } from "../src/rails/near-rpc.js";
import { CapturingRpc, type Exchange } from "../src/rails/rpc-capture.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { startNearSandbox, type NearSandboxHandle } from "./helpers/sandbox.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXTURES_ROOT = join(REPO_ROOT, "fixtures", "near-sandbox-2026-09-29");

/** Mirrors `CAPTURE_BTC_FIXTURES`/`CAPTURE_EVM_FIXTURES` exactly, for the NEAR fixtures. */
const CAPTURE_FIXTURES = process.env.CAPTURE_NEAR_FIXTURES === "1";

/** Every scenario's own `mkdtemp` bundle directory (never the committed fixtures under
 *  `CAPTURE_FIXTURES`), removed in `afterAll` unless `KEEP_NEAR_BUNDLES=1`. */
const scenarioRoots: string[] = [];

async function scenarioRoot(scenario: string): Promise<string> {
  if (CAPTURE_FIXTURES) {
    const dir = join(FIXTURES_ROOT, scenario);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return dir;
  }
  const dir = await mkdtemp(join(tmpdir(), `flop-near-sandbox-${scenario}-`));
  scenarioRoots.push(dir);
  return dir;
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

/** D-N7 (measured this stage, `tests-near/helpers/sandbox.ts` header): ~337 ms of simulated
 *  chain time per block under `sandbox_fast_forward`. Used only to size how many blocks to ask
 *  for — `warpChainPast` still re-reads the real chain time to confirm, never trusts this
 *  estimate alone. */
const SIMULATED_MS_PER_FASTFORWARD_BLOCK = 337;

/** Leg A: a 47-minute `refundAfterMs - lockTimeMs` window — just over
 *  `NEAR_LOCAL_POLICY.minRevealWindowMs` (45 min: `src/client/policy.ts` reuses EVM's own value
 *  verbatim, per D-N8's own explicit "not re-derived, pending NB-int's own live sandbox timing"
 *  — this stage measures the sandbox's own timing (this file's header comment) but does not
 *  itself tighten that constant, since doing so would also need to stay green against every
 *  other existing suite that already pins it, out of scope for this stage's own deliverable),
 *  sized to keep this file's one real `fastForward` (in the "refunded" scenario) to on the order
 *  of a minute or two of wall time (see this file's own header comment) rather than the much
 *  longer real time a wider "realistic" window would cost. */
function legADeadlines(t0: number) {
  return { lockTimeMs: t0, claimByMs: t0 + 20 * 60_000, refundAfterMs: t0 + 47 * 60_000, expiresMs: t0 + 10 * 60_000 };
}

/** Leg B (paper/FLOP): governed only by this harness's own JS clock, never the chain — sized
 *  comfortably clear of every `NEAR_LOCAL_POLICY` number (rule 2: `legB.claimByMs >=
 *  legA.refundAfterMs + finalityAMs` = `t0 + 42min`; 12h is a full order of magnitude of margin,
 *  not a boundary value this file needs to dial precisely, since warping the JS clock is free. */
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 12 * 60 * 60_000, refundAfterMs: t0 + 24 * 60 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

interface Party {
  identity: Identity;
  rpc: CapturingRpc;
}

function setupSwap(sandbox: NearSandboxHandle, config: NearRailConfig, buyer: Party, seller: Party, t0: number) {
  const clockRef = { ms: t0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();

  const buyerRail: CounterAssetRail = createNearCounterRail({ config, rpc: buyer.rpc, signer: sandbox.buyer.signer, clock });
  const sellerRail: CounterAssetRail = createNearCounterRail({ config, rpc: seller.rpc, signer: sandbox.seller.signer, clock });

  const buyerFlow = new BuyerFlow({ identity: buyer.identity, venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail, clock });
  const sellerFlow = new SellerFlow({ identity: seller.identity, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock });

  /** Advances the JS clock only — the leg-B (paper) twin of the regtest suite's own `warpTo`,
   *  minus any chain interaction at all: leg B's own deadlines never touch the NEAR chain. */
  function warpJsClock(nowMs: number): void {
    clockRef.ms = nowMs;
  }

  return { clockRef, clock, venue, noteStore, buyerFlow, sellerFlow, buyerRail, sellerRail, warpJsClock };
}

type Swap = ReturnType<typeof setupSwap>;

describe("Seller/Buyer client flows against a real near-sandbox node", () => {
  let sandbox: NearSandboxHandle;

  beforeAll(async () => {
    sandbox = await startNearSandbox();
  }, 300_000);

  afterAll(async () => {
    if (sandbox !== undefined) await sandbox.stop();
    if (process.env.KEEP_NEAR_BUNDLES !== "1") {
      await Promise.all(scenarioRoots.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  function freshParty(id: Identity): Party {
    return { identity: id, rpc: sandbox.createCapturingRpc() };
  }

  function ident(tag: number): Identity {
    return identity(tag.toString(16).padStart(2, "0").repeat(32));
  }

  /** The sandbox's own current FINAL block chain time (D-N7) — every scenario's own leg-A
   *  deadlines are anchored to this, read fresh, never a fixed epoch. Mirrors
   *  tests-near/near-htlc.near.test.ts's own `chainNowMs`. */
  async function chainNowMs(): Promise<number> {
    const rpc = sandbox.createCapturingRpc();
    const near = new NearRpc(rpc);
    const block = await near.block({ finality: "final" });
    return Number(BigInt(block.header.timestampNs) / 1_000_000n);
  }

  /** `CapturingRpc`'s own default RPC timeout is 45 s (`src/rails/rpc-capture.ts`'s
   *  `DEFAULT_RPC_TIMEOUT_MS`) — a single `sandbox_fast_forward` call producing more than
   *  roughly 3k blocks (measured this stage: ~9-13 ms of real wall time per block) risks aborting
   *  on that timeout even though the sandbox itself would have answered eventually. Chunked well
   *  under that budget so a large warp (this file's "refunded" scenario) never needs it raised. */
  const MAX_BLOCKS_PER_FASTFORWARD_CALL = 2_000;

  /** Advances the REAL sandbox chain time past `targetMs` (D-N7: `sandbox.fastForward` advances
   *  the final block's own timestamp) by estimating the block count from
   *  `SIMULATED_MS_PER_FASTFORWARD_BLOCK` in chunks of at most `MAX_BLOCKS_PER_FASTFORWARD_CALL`,
   *  re-reading real chain time between chunks to confirm — never trusts the estimate alone. */
  async function warpChainPast(targetMs: number, marginMs = 90_000): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = await chainNowMs();
      const deltaMs = targetMs + marginMs - now;
      if (deltaMs <= 0) return;
      const blocks = Math.min(MAX_BLOCKS_PER_FASTFORWARD_CALL, Math.max(1, Math.ceil(deltaMs / SIMULATED_MS_PER_FASTFORWARD_BLOCK)));
      await sandbox.fastForward(blocks);
    }
    const finalNow = await chainNowMs();
    expect(finalNow).toBeGreaterThanOrEqual(targetMs);
  }

  /** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both account lines — the
   *  prefix every scenario below shares. D-N5: both parties post an ACCOUNT-id line for a
   *  `near-htlc` leg (never a pubkey line, unlike `btc-htlc`). `sellerPayeeAddress` defaults to
   *  the Seller's own NEAR account id; scenario 6 overrides it with a deliberately unregistered
   *  one, since `near-htlc`'s payout is permissionless and pays whatever account the accepted
   *  account line named, never the caller's own signer account. */
  async function pairAndLockB(nonceHex: string, buyer: Identity, h: Swap, t0: number, sellerPayeeAddress = sandbox.seller.accountId) {
    const swapId = computeSwapId(buyer.did, nonceHex);
    const legA = legADeadlines(t0);
    const offerA = await h.buyerFlow.bid({
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

    const { acceptA, acceptARecord, offerB, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(t0), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    await h.sellerFlow.postAccountLineA(sellerPayeeAddress);
    await h.buyerFlow.postAccountLineA(sandbox.buyer.accountId);

    return { swapId, offerA, offerB, acceptA, acceptB };
  }

  /** Both parties' resolved account ids for leg A, exactly as `SellerFlow.claimLegA`/
   *  `BuyerFlow.lockLegA` resolve them internally (through the SAME public
   *  `CounterAssetRail.resolveAccounts`) — needed here only because a bundle's own NEAR capture
   *  needs them and a flow keeps no such state exposed after the fact. */
  async function resolveNearAccounts(h: Swap, rail: CounterAssetRail, contract: string, terms: LockTerms): Promise<NearAccounts> {
    const records = await h.venue.read(dealRoom(contract));
    const resolved = rail.resolveAccounts(records, { contract, payerDid: terms.payer, payeeDid: terms.payee });
    return {
      ...(resolved.payee === undefined ? {} : { payee: resolved.payee }),
      ...(resolved.payer === undefined ? {} : { payer: resolved.payer }),
    };
  }

  /** Writes a watch-root bundle for `swapId` (a fresh `mkdtemp` directory, or — only under
   *  `CAPTURE_NEAR_FIXTURES=1` — the named committed fixture directory) and replays it through
   *  `examples/audit-export.mjs` as a real child process, asserting the exit code the spec calls
   *  for. Mirrors `tests-regtest/client-flows.regtest.test.ts`'s own `writeAndReplay` exactly,
   *  with `near` in place of `btc`. */
  async function writeAndReplay(args: {
    scenario: string;
    swapId: string;
    status: string;
    venue: MemoryVenue;
    acceptAContract: string;
    acceptBContract: string;
    noteStore: MemoryNoteStore;
    near?: { ref: string; terms: LockTerms; accounts: NearAccounts };
    startedAtMs: number;
    nowMs: number;
    writes: BundleEvidenceSummary["writes"];
    writeExchanges: readonly Exchange[];
  }): Promise<string> {
    const root = await scenarioRoot(args.scenario);

    const dealRoomA = dealRoom(args.acceptAContract);
    const dealRoomB = dealRoom(args.acceptBContract);
    const { ns, key } = paperNote(args.acceptBContract);
    const rawNote = args.noteStore.raw(ns, key);

    const summary: BundleEvidenceSummary = {
      swapId: args.swapId,
      legA: { contract: args.acceptAContract, rail: "near-htlc" },
      legB: { contract: args.acceptBContract, rail: "paper" },
      feeBps: 0,
      writes: args.writes,
      startedAtMs: args.startedAtMs,
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
      ...(args.near === undefined
        ? {}
        : { near: { config: sandbox.config, rpc: sandbox.createCapturingRpc(), ref: args.near.ref, terms: args.near.terms, accounts: args.near.accounts } }),
      evidence: summary,
    });

    const result = await runAuditExport(root, `${args.swapId}=${args.status}`);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return root;
  }

  it("scenario 1: happy path -> settled", async () => {
    const buyer = ident(1);
    const seller = ident(2);
    const t0 = await chainNowMs();
    const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);
    const startedAtMs = h.clock();

    const { swapId, offerA, acceptA, acceptB } = await pairAndLockB("00000001", buyer, h, t0);

    const lockA = await h.buyerFlow.lockLegA();
    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.reveal).toBeDefined();

    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const accounts = await resolveNearAccounts(h, h.buyerRail, acceptA.contract, termsA);

    await writeAndReplay({
      scenario: "settled",
      swapId,
      status: "settled",
      venue: h.venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore: h.noteStore,
      near: { ref: lockA.writeEvidence.ref, terms: termsA, accounts },
      startedAtMs,
      nowMs: h.clock(),
      writes: [
        { leg: "a", step: "lock", rail: "near-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "near-htlc", evidence: claimed.evidence },
      ],
      writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
    });
  }, 120_000);

  // Squatting fix: a third account holding the configured token locks 1 unit under the swap's
  // (public) hash lock BEFORE the Buyer's lockLegA. Pre-fix the Buyer's real lock was refused and
  // the swap died; now the lock is keyed by (payer, hash lock) and the whole swap settles, with
  // the squatter's own unit left for its own payer.
  it("squatting fix: a third account locks 1 unit under the swap's hash lock before lockLegA; the swap still settles", async () => {
    const buyer = ident(41);
    const seller = ident(42);
    const t0 = await chainNowMs();
    const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);
    const startedAtMs = h.clock();

    const { swapId, offerA, acceptA, acceptB } = await pairAndLockB("00000041", buyer, h, t0);
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");

    // The squat: any holder of the token reads the hash lock off the public offer and locks first.
    const squatter = await sandbox.createFundedAccount("squatter2.test.near");
    await sandbox.mintUsdc(squatter.accountId, "10");
    const squatterRpc = sandbox.createCapturingRpc();
    const squatterRail = await NearHtlcRail.connect({ config: sandbox.config, rpc: squatterRpc, signer: squatter.signer, clock: Date.now });
    await squatterRail.prepareLock({
      hashLock: statement,
      amount: "1",
      payee: sandbox.seller.accountId,
      claimByMs: offerA.claimByMs,
      refundAfterMs: offerA.refundAfterMs,
    });
    await squatterRail.commitLock();

    // The Buyer's real lock still goes through, and its ref names the Buyer.
    const lockA = await h.buyerFlow.lockLegA();
    expect(lockA.writeEvidence.ref).toBe(`${statement}:${sandbox.buyer.accountId}`);
    const lockFrame = (await h.venue.read(dealRoom(acceptA.contract))).map((r) => tryDecodeFrame(r.line)).find((f) => f?.type === "lock");
    expect((lockFrame as { ref: string } | undefined)?.ref).toBe(lockA.writeEvidence.ref);

    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.reveal).toBeDefined();
    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);

    // The squatter's own unit is untouched: still Locked under ITS OWN key.
    const near = new NearRpc(sandbox.createCapturingRpc());
    const squatView = JSON.parse((await near.callFunction(sandbox.htlcContract, "get_lock", { hash_lock: statement.slice(2), payer: squatter.accountId })).resultText) as { status: string };
    expect(squatView.status).toBe("Locked");

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const accounts = await resolveNearAccounts(h, h.buyerRail, acceptA.contract, termsA);
    await writeAndReplay({
      scenario: "squat-settled",
      swapId,
      status: "settled",
      venue: h.venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore: h.noteStore,
      near: { ref: lockA.writeEvidence.ref, terms: termsA, accounts },
      startedAtMs,
      nowMs: h.clock(),
      writes: [
        { leg: "a", step: "lock", rail: "near-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "near-htlc", evidence: claimed.evidence },
      ],
      writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
    });
  }, 120_000);

  it(
    "scenario 2: refunded — Seller never claims; Buyer refunds A after refundAfterMs (real chain time, via fastForward), Seller refunds B -> refunded",
    async () => {
      const buyer = ident(3);
      const seller = ident(4);
      const t0 = await chainNowMs();
      const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);
      const startedAtMs = h.clock();

      const { swapId, offerA, offerB, acceptA, acceptB } = await pairAndLockB("00000002", buyer, h, t0);

      const lockA = await h.buyerFlow.lockLegA();

      // Guard 1 (buyer.ts's own, JS-clock-gated, cheap): still before offerA.refundAfterMs by
      // this harness's own clock — no chain call needed to refuse this.
      await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/before its refundAfterMs/);

      // Advance the JS clock past offerA.refundAfterMs, but NOT the real chain yet: the rail's
      // own `refund()` re-checks against fresh CHAIN time (D-N7), so this must still refuse.
      h.warpJsClock(offerA.refundAfterMs + 60_000);
      await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/chain time has not yet reached refundAfterMs/);

      // Now actually cross refundAfterMs on the real sandbox chain (D-N7's own fastForward).
      await warpChainPast(offerA.refundAfterMs);
      const refundA = await h.buyerFlow.refundLegA();
      expect(refundA.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);

      // Leg B (paper) needs only the JS clock, which is free to warp arbitrarily far.
      h.warpJsClock(offerB.refundAfterMs + 60_000);
      const refundB = await h.sellerFlow.refundLegB();
      expect(refundB.refund).toBeDefined();

      const termsA = offerAcceptLockTerms(offerA, acceptA);
      const accounts = await resolveNearAccounts(h, h.buyerRail, acceptA.contract, termsA);

      await writeAndReplay({
        scenario: "refunded",
        swapId,
        status: "refunded",
        venue: h.venue,
        acceptAContract: acceptA.contract,
        acceptBContract: acceptB.contract,
        noteStore: h.noteStore,
        near: { ref: lockA.writeEvidence.ref, terms: termsA, accounts },
        startedAtMs,
        nowMs: h.clock(),
        writes: [
          { leg: "a", step: "lock", rail: "near-htlc", evidence: lockA.writeEvidence },
          { leg: "a", step: "refund", rail: "near-htlc", evidence: refundA },
        ],
        writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
      });
    },
    300_000,
  );

  it("scenario 3: refunded-b — Buyer never locks A; Seller refunds B -> refunded-b", async () => {
    const buyer = ident(5);
    const seller = ident(6);
    const t0 = await chainNowMs();
    const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);
    const startedAtMs = h.clock();

    const { swapId, offerB, acceptA, acceptB } = await pairAndLockB("00000003", buyer, h, t0);

    // The Buyer never calls lockLegA at all -- no NEAR write, no chain interaction for leg A ever
    // happens. Once B's refund window opens (the JS clock alone), the Seller refunds it.
    h.warpJsClock(offerB.refundAfterMs + 60_000);
    const refundB = await h.sellerFlow.refundLegB();
    expect(refundB.refund).toBeDefined();

    await writeAndReplay({
      scenario: "refunded-b",
      swapId,
      status: "refunded-b",
      venue: h.venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore: h.noteStore,
      startedAtMs,
      nowMs: h.clock(),
      writes: [{ leg: "b", step: "refund", rail: "paper", evidence: {} }],
      writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
    });
  }, 120_000);

  it("scenario 4: claim refused before finality (no on-chain lock exists yet), allowed once the lock is actually final", async () => {
    const buyer = ident(9);
    const seller = ident(10);
    const t0 = await chainNowMs();
    const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);

    const { offerA, acceptA } = await pairAndLockB("00000005", buyer, h, t0);
    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const hashLock = termsA.statement;

    // The Buyer has not called lockLegA yet -- there is no finalized on-chain lock for the
    // Seller's own claimLegA to verify against (D-11). `SellerFlow.claimLegA`'s own guard --
    // `evidence.lock.railVerified !== true` -- throws the identical message BTC's own scenario 4
    // pins ("before verifyLockFinal(A) is true"), for the same underlying reason a not-yet-final
    // write would: the chain shows no finalized lock matching these terms.
    await expect(h.sellerFlow.claimLegA(hashLock)).rejects.toThrow(/before verifyLockFinal\(A\) is true/);

    // Now the Buyer actually locks -- send_tx with wait_until: "FINAL" (D-N4/D-N9) means the
    // write is already final by the time lockLegA() returns, so the very next claim succeeds.
    const lockA = await h.buyerFlow.lockLegA();
    expect(lockA.hashLock).toBe(hashLock);
    const claimed = await h.sellerFlow.claimLegA(hashLock);
    expect(claimed.evidence.ref).toBe(lockA.writeEvidence.ref);
  }, 120_000);

  it("scenario 5: Seller claims without posting a reveal frame; Buyer learns s from the chain alone (get_lock)", async () => {
    const buyer = ident(11);
    const seller = ident(12);
    const t0 = await chainNowMs();
    const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);

    await pairAndLockB("00000006", buyer, h, t0);
    const lockA = await h.buyerFlow.lockLegA();

    // near-htlc's own `send_tx wait_until: "FINAL"` (D-N4/D-N9) waits for the ENTIRE receipt
    // chain (the outer claim() call plus its ft_transfer/callback promises) to finish and finalize
    // before ever returning, so a lock this build's own `claim()` write produces is always
    // observed as `Claimed`, never a transiently-visible `Claiming` -- unlike Bitcoin's own
    // mempool-then-mined staging. `Claiming`/`Claimed` are treated identically by
    // `NearHtlcRail.findClaimedPreimage` (both already carry the preimage the moment `claim()`
    // runs -- see that method's own doc comment), and `tests-near/near-htlc.near.test.ts` already
    // pins the raw `get_lock` shape directly at the rail level; this scenario's own job is the
    // CLIENT-FLOW path: no reveal frame ever posted, and the Buyer still recovers the secret.
    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock, { skipReveal: true });
    expect(claimed.reveal).toBeUndefined();

    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);
  }, 120_000);

  it("scenario 6: a claim to an unregistered payee is refused before ever sending a transaction", async () => {
    const buyer = ident(13);
    const seller = ident(14);
    const t0 = await chainNowMs();
    const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);

    // near-htlc's own payout is permissionless and pays whatever account the ACCEPTED account
    // line named (D-N5), never the caller's own signer account -- so the Seller posting a
    // deliberately unregistered account here (never created, never storage_deposit'd on the
    // token) is enough to reproduce P5-NEAR-SPEC.md §4's own no-secret storage_balance_of
    // pre-check, using only this sandbox's own existing accounts (no new account creation
    // needed). Mirrors tests-near/near-htlc.near.test.ts's own `unregisteredPayee` at the rail
    // level, here exercised through the real client flow.
    const unregisteredPayee = "nobody.test.near";
    const { offerA, acceptA } = await pairAndLockB("00000007", buyer, h, t0, unregisteredPayee);

    const lockA = await h.buyerFlow.lockLegA();
    void offerA;
    void acceptA;

    // NearHtlcRail.claim()'s own pre-check (`storage_balance_of(payee)`) refuses before ever
    // signing or sending -- SellerFlow.claimLegA does not catch this, so it propagates unchanged.
    await expect(h.sellerFlow.claimLegA(lockA.hashLock)).rejects.toThrow(/is not storage-registered/);
    expect(h.sellerFlow.exchanges.some((e) => e.method === "send_tx")).toBe(false);
  }, 120_000);

  it("scenario 7: lost-reply recovery — a caller who lost commitLock's own reply recovers byte-identical evidence via recoverByTxHash (D-N4)", async () => {
    const buyer = ident(15);
    const seller = ident(16);
    const t0 = await chainNowMs();
    const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);

    await pairAndLockB("00000008", buyer, h, t0);
    const lockA = await h.buyerFlow.lockLegA(); // a normal, successful write -- frames posted.

    // A caller holding only the write's own recorded txHash (never re-signing, never re-sending
    // blind -- D-N4) independently recovers the SAME finalized outcome from the chain, through a
    // freshly-connected rail instance (as a process resuming after losing the original reply
    // would have to). The recovered blockHash matches the one the flow itself received, proving
    // the exact same evidence -- and so the exact same frame -- was recoverable even if the
    // original reply to commitLock() had genuinely never arrived.
    const recoveryRail = await NearHtlcRail.connect({
      config: sandbox.config,
      rpc: sandbox.createCapturingRpc(),
      signer: sandbox.buyer.signer,
      clock: Date.now,
    });
    // H4: `recoverByTxHash` now takes the CALLER's own expected ref and returns it as
    // `evidence.ref` verbatim — never the raw txHash (A9: an evidence reader keys and re-binds
    // captures by ref, so returning anything else would silently mislabel a recovered write).
    // Here the caller's own ref is `0x<hash lock>:<payer>` (squatting fix: near-htlc's own write ref).
    const recovered = await recoveryRail.recoverByTxHash(lockA.writeEvidence.txHash, sandbox.buyer.accountId, lockA.writeEvidence.ref);
    expect(recovered).not.toBeNull();
    expect(recovered?.blockHash).toBe(lockA.writeEvidence.blockHash);
    expect(recovered?.ref).toBe(lockA.writeEvidence.ref);

    // H4 (confirmed live in tests-near/near-htlc.near.test.ts, this same finding): a hash the
    // node has NEVER seen at all does not answer quickly with "not found" — `EXPERIMENTAL_tx_
    // status` long-polls until its own internal wait expires, then answers with a structured
    // `TIMEOUT_ERROR` cause, which `recoverByTxHash` reports as `NearTimeoutError`, never
    // collapsing it to `null` (H4: "returns null only for unknown", and a genuine "ask again" is
    // not the same as "never broadcast"). Intentionally slow — waits out the node's own timeout.
    const flippedLastChar = lockA.writeEvidence.txHash.endsWith("z") ? "y" : "z";
    await expect(
      recoveryRail.recoverByTxHash(`${lockA.writeEvidence.txHash.slice(0, -1)}${flippedLastChar}`, sandbox.buyer.accountId, lockA.writeEvidence.ref),
    ).rejects.toBeInstanceOf(NearTimeoutError);
  }, 120_000);

  /** P5-NEAR-FIXES.md G3's own decode of the signer's `ed25519:<base58>` public key string —
   *  duplicated tiny rather than exported from near-htlc.ts (that file's own `decodePublicKey`
   *  is private), the same choice tests-near/near-htlc.near.test.ts's own `decodePublicKeyRaw`
   *  makes for the identical reason. */
  function decodePublicKeyRaw(publicKey: string): Uint8Array {
    return base58.decode(publicKey.slice("ed25519:".length));
  }

  /** A minimal raw signed-transaction sender, deliberately going AROUND `NearHtlcRail`'s own
   *  TS-side guards — used here only to pay another account's storage deposit on the token
   *  (`storage_deposit`, NEP-145), the one setup step scenario 8 needs that no existing client
   *  method performs. Mirrors tests-near/near-htlc.near.test.ts's own `sendRawTx` (kept separate
   *  rather than imported, the same reasoning that file's own header gives: a test that reaches
   *  for this should not also inherit the harness's own construction-time invariants). */
  async function sendRawTx(rpc: CapturingRpc, signer: NearSigner, signerAccountId: string, receiverId: string, actions: NearAction[]) {
    const near = new NearRpc(rpc);
    const accessKey = await near.viewAccessKey(signerAccountId, signer.publicKey);
    const block = await near.block({ finality: "final" });
    const built = await buildSignedTransaction(
      {
        signerId: signerAccountId,
        publicKey: { keyType: "ED25519", data: decodePublicKeyRaw(signer.publicKey) },
        nonce: BigInt(accessKey.nonce) + 1n,
        receiverId,
        blockHash: base58.decode(block.header.hash),
        actions,
      },
      (hash) => signer.sign(hash),
    );
    return near.sendTx(Buffer.from(built.signedBytes).toString("base64"), "FINAL");
  }

  it(
    "scenario 8 (G3): claiming to an unregistered payee is refused by the real pre-check; once the payee registers, a plain retry through the real client flow pays",
    async () => {
      const buyer = ident(17);
      const seller = ident(18);
      const t0 = await chainNowMs();
      const h = setupSwap(sandbox, sandbox.config, freshParty(buyer), freshParty(seller), t0);

      // Mirrors scenario 6's own setup (the accepted account line names a payee that was never
      // storage_deposit'd on the token) — G3's own sandbox scenario is this same starting point,
      // continued past the first refusal: register the payee, then retry through the SAME
      // SellerFlow instance (never a fresh one), proving the real client flow's own G2/G3 checks
      // (findClaimedPreimage first, for near-htlc) neither block nor mis-route an ordinary retry
      // that never actually revealed anything on its failed first attempt (the adapter's own
      // no-secret storage_balance_of pre-check refuses BEFORE ever signing — P5-NEAR-SPEC.md §4).
      const unregisteredPayee = "nobody-g3.test.near";
      const { acceptA } = await pairAndLockB("00000009", buyer, h, t0, unregisteredPayee);

      const lockA = await h.buyerFlow.lockLegA();

      await expect(h.sellerFlow.claimLegA(lockA.hashLock)).rejects.toThrow(/is not storage-registered/);
      expect(h.sellerFlow.exchanges.some((e) => e.method === "send_tx")).toBe(false);

      // Register the payee (any signer may pay another account's own storage deposit) — no new
      // account creation needed, mirrors near-htlc.near.test.ts's own H2 sandbox test.
      await sendRawTx(sandbox.createCapturingRpc(), sandbox.buyer.signer, sandbox.buyer.accountId, sandbox.usdcToken, [
        {
          type: "FunctionCall",
          methodName: "storage_deposit",
          args: new TextEncoder().encode(JSON.stringify({ account_id: unregisteredPayee })),
          gas: 30_000_000_000_000n,
          deposit: 50_000_000_000_000_000_000_000n / 20n,
        },
      ]);

      const balanceBefore = BigInt(await sandbox.usdcBalanceOf(unregisteredPayee));
      // The SAME SellerFlow instance, retried — nothing was ever revealed by the first (refused)
      // attempt, so this is an ordinary claim that must simply succeed now that the pre-check
      // passes; `findClaimedPreimage` (G2/G3's own first check) correctly finds nothing of this
      // flow's own to report, and falls through to the normal guarded path unchanged.
      const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
      expect(claimed.receipt).toBeDefined();
      const balanceAfter = BigInt(await sandbox.usdcBalanceOf(unregisteredPayee));
      expect(balanceAfter).toBeGreaterThan(balanceBefore);
      void acceptA;
    },
    120_000,
  );
});
