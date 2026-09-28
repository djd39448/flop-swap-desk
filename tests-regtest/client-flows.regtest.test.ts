// SPDX-License-Identifier: MIT
//
// tests-regtest/client-flows.regtest.test.ts — P4-BTC-SPEC.md §7, stage BB4b: the Seller/Buyer
// client flows (src/client/seller.ts, src/client/buyer.ts) end to end against a real bitcoind
// -regtest node, with the counter-asset leg on `btc-htlc` (src/client/btc-rail.ts) and the FLOP
// leg on tclk's own `PaperRail` over one in-memory `NoteStore`. Mirrors
// tests-anvil/client-flows.anvil.test.ts's own structure exactly (one fresh node for the whole
// file, `writeBundle` + `examples/audit-export.mjs` replay per scenario, `CAPTURE_*_FIXTURES`),
// swapped for Bitcoin's own primitives: real wallets, real mined confirmations, `setmocktime` +
// mining (never `evm_setNextBlockTimestamp`) to move the chain's own median time past.
//
// Every scenario advances leg A's own deadlines from the LIVE node's own `mediantime` — never a
// fixed synthetic epoch the way the anvil suite's `GENESIS_SECONDS` can be, because a regtest
// block's own timestamp is real wall-clock time unless `setmocktime` was called (probe gotcha,
// `handoff/research/btc-regtest-probe-2026-09-28.md` "Gotchas for the real build"). `finality:
// {confirmations: 2}` (not `BTC_REGTEST_PIN`'s own default of 1) throughout this file, so
// "claim refused before N confirmations" (scenario 4) is meaningful.
//
// P4-BTC-SPEC.md §7's six scenarios: settled; refunded (Seller never reveals — Buyer refunds A
// after MTP passes T, Seller refunds B); refunded-b (Buyer never funds); claim refused before N
// confirmations; the Buyer learns `s` from the chain alone; a claim that fails
// `testmempoolaccept` is never broadcast (here: the outpoint the Seller is about to claim was
// already spent by the Buyer's own refund — every one of `BtcHtlcRail.claim()`'s own preimage/
// script/fee pre-checks still passes, so only the chain's own mempool policy catches this,
// distinct from `tests-regtest/btc-htlc.regtest.test.ts`'s own wrong-preimage trigger for the
// identical guard).
//
// Fixtures `fixtures/btc-regtest-2026-09-28/{settled,refunded,refunded-b}/`, regenerated only
// with `CAPTURE_BTC_FIXTURES=1` (mirrors P22-P24-EVM-FIXES.md B4's `CAPTURE_EVM_FIXTURES`
// exactly); every other run writes to a fresh `mkdtemp` directory, cleaned up in `afterAll`
// unless `KEEP_REGTEST_BUNDLES=1`.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, paperNote, verifyHashPreimage, type LockTerms } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import type { BtcAccounts } from "../src/rails/btc-evidence.js";
import { BTC_REGTEST_PIN, BtcHtlcRail, keyFromAddressInfo, type BtcHtlcTerms, type BtcRailConfig, type BtcSignerKey } from "../src/rails/btc-htlc.js";
import { CapturingRpc, type Exchange } from "../src/rails/rpc-capture.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { identity, type Identity } from "../tests/helpers/identity.js";
import { startBitcoind, type BitcoindHandle, type RegtestWallet } from "./helpers/bitcoind.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXTURES_ROOT = join(REPO_ROOT, "fixtures", "btc-regtest-2026-09-28");

/** Mirrors P22-P24-EVM-FIXES.md B4's `CAPTURE_EVM_FIXTURES` exactly, for the Bitcoin fixtures. */
const CAPTURE_FIXTURES = process.env.CAPTURE_BTC_FIXTURES === "1";

/** Every scenario's own `mkdtemp` bundle directory (never the committed fixtures under
 *  `CAPTURE_FIXTURES`), removed in `afterAll` unless `KEEP_REGTEST_BUNDLES=1`. */
const scenarioRoots: string[] = [];

async function scenarioRoot(scenario: string): Promise<string> {
  if (CAPTURE_FIXTURES) {
    const dir = join(FIXTURES_ROOT, scenario);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return dir;
  }
  const dir = await mkdtemp(join(tmpdir(), `flop-btc-regtest-${scenario}-`));
  scenarioRoots.push(dir);
  return dir;
}

function keyFor(wallet: RegtestWallet): BtcSignerKey {
  return keyFromAddressInfo({ pubkey: wallet.pubkey, hdmasterfingerprint: wallet.hdMasterFingerprint, hdkeypath: wallet.hdKeyPath });
}

async function currentMediantimeMs(node: BitcoindHandle): Promise<number> {
  const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
  return info.mediantime * 1000;
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

/** Leg A: a 5-hour refundAfterMs from `t0` (the live node's own current mediantime) comfortably
 *  clears BTC_LOCAL_POLICY's own minRevealWindowMs (60 min) and claimInclusionMarginMs (60 min)
 *  with room to spare for the ~1 h median-time-past lag the CLTV branch itself imposes. */
function legADeadlines(t0: number) {
  return { claimByMs: t0 + 3 * 60 * 60_000, refundAfterMs: t0 + 5 * 60 * 60_000, expiresMs: t0 + 30 * 60_000 };
}

/** Leg B: sized so `checkSwapDeadlines(offerA, offerB, t0, BTC_LOCAL_POLICY)` holds — rule 2
 *  needs `legB.claimByMs >= legA.refundAfterMs (t0+5h) + finalityAMs (P4-BTC-FIXES.md G5: raised
 *  to 3h)` = `t0+8h`; `claimByMs` below is `t0+9h`, a full hour of margin rather than sitting
 *  exactly on the boundary. Rule 3 (R10.2, 1 s FLOP blocks) needs `legB.refundAfterMs >= t0 +
 *  ~6h` at `lockTimeMs = t0`. Both flows re-check live regardless. */
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 9 * 60 * 60_000, refundAfterMs: t0 + 20 * 60 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

interface Party {
  identity: Identity;
  rpc: CapturingRpc;
}

function setupSwap(node: BitcoindHandle, config: BtcRailConfig, buyer: Party, seller: Party, t0: number) {
  const clockRef = { ms: t0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();

  const buyerRail: CounterAssetRail = createBtcCounterRail({
    config,
    rpc: buyer.rpc,
    wallet: node.buyer.wallet,
    key: keyFor(node.buyer),
    destinationAddress: node.buyer.address,
    clock,
  });
  const sellerRail: CounterAssetRail = createBtcCounterRail({
    config,
    rpc: seller.rpc,
    wallet: node.seller.wallet,
    key: keyFor(node.seller),
    destinationAddress: node.seller.address,
    clock,
  });

  // P4-BTC-FIXES.md G5: the policy comes from the rail itself now (`buyerRail.policy` /
  // `sellerRail.policy`, both `BTC_LOCAL_POLICY` — `BtcCounterRail`'s own frozen constant) —
  // there is no longer a constructor option to pass one through.
  const buyerFlow = new BuyerFlow({
    identity: buyer.identity,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: buyerRail,
    clock,
  });
  const sellerFlow = new SellerFlow({
    identity: seller.identity,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: sellerRail,
    clock,
  });

  /** Advances both the JS clock every flow reads AND the chain's own median time past together
   *  (probe Q4: `setmocktime` + mining 11+ blocks so MTP itself moves) — the Bitcoin twin of the
   *  anvil suite's own `warpTo`. */
  async function warpTo(nowMs: number): Promise<void> {
    clockRef.ms = nowMs;
    await node.setMockTime(Math.floor(nowMs / 1000) + 1);
    await node.mine(11);
  }

  async function mineBlocks(n: number): Promise<void> {
    await node.mine(n);
  }

  return { clockRef, clock, venue, noteStore, buyerFlow, sellerFlow, buyerRail, sellerRail, warpTo, mineBlocks };
}

type Swap = ReturnType<typeof setupSwap>;

describe("Seller/Buyer client flows against a real bitcoind -regtest node", () => {
  let node: BitcoindHandle;
  let config: BtcRailConfig;

  beforeAll(async () => {
    node = await startBitcoind();
    // 2 confirmations (not BTC_REGTEST_PIN's own default of 1) so scenario 4 ("claim refused
    // before N confirmations") is meaningful.
    config = { pin: { ...BTC_REGTEST_PIN, finality: { confirmations: 2 } }, endpoint: node.endpoint };
  }, 120_000);

  afterAll(async () => {
    await node?.stop();
    if (process.env.KEEP_REGTEST_BUNDLES !== "1") {
      await Promise.all(scenarioRoots.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  function freshParty(id: Identity): Party {
    return { identity: id, rpc: node.createCapturingRpc() };
  }

  function ident(tag: number): Identity {
    return identity(tag.toString(16).padStart(2, "0").repeat(32));
  }

  /** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both pubkey lines — the
   *  prefix every scenario below shares. D-08/§6: BOTH parties post a pubkey line for a
   *  `btc-htlc` leg, never an address line. */
  async function pairAndLockB(nonceHex: string, buyer: Identity, h: Swap, t0: number) {
    const swapId = computeSwapId(buyer.did, nonceHex);
    const offerA = await h.buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "1000000", // sats
      asset: "BTC",
      ...legADeadlines(t0),
    });

    const { acceptA, acceptARecord, offerB, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(t0), t0);
    const { acceptB, acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, t0);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    await h.sellerFlow.postAccountLineA(node.seller.pubkey.toLowerCase());
    await h.buyerFlow.postAccountLineA(node.buyer.pubkey.toLowerCase());

    return { swapId, offerA, offerB, acceptA, acceptB };
  }

  /** Both parties' resolved pubkeys for leg A, exactly as `SellerFlow.claimLegA`/
   *  `BuyerFlow.lockLegA` resolve them internally — recomputed here (through the SAME public
   *  `CounterAssetRail.resolveAccounts`) only because a bundle's own BTC capture needs them and
   *  a flow keeps no such state exposed after the fact. */
  async function resolveBtcAccounts(h: Swap, rail: CounterAssetRail, contract: string, terms: LockTerms): Promise<BtcAccounts> {
    const records = await h.venue.read(dealRoom(contract));
    const resolved = rail.resolveAccounts(records, { contract, payerDid: terms.payer, payeeDid: terms.payee });
    return {
      ...(resolved.payee === undefined ? {} : { payeePubkey: resolved.payee }),
      ...(resolved.payer === undefined ? {} : { payerPubkey: resolved.payer }),
    };
  }

  /** Writes a watch-root bundle for `swapId` (a fresh `mkdtemp` directory, or — only under
   *  `CAPTURE_BTC_FIXTURES=1` — the named committed fixture directory) and replays it through
   *  `examples/audit-export.mjs` as a real child process (`npm run build` having already
   *  produced `dist/`), asserting the exit code the spec calls for. */
  async function writeAndReplay(args: {
    scenario: string;
    swapId: string;
    status: string;
    venue: MemoryVenue;
    acceptAContract: string;
    acceptBContract: string;
    noteStore: MemoryNoteStore;
    btc?: { ref: string; terms: LockTerms; accounts: BtcAccounts };
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
      legA: { contract: args.acceptAContract, rail: "btc-htlc" },
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
      ...(args.btc === undefined
        ? {}
        : { btc: { config, rpc: node.createCapturingRpc(), ref: args.btc.ref, terms: args.btc.terms, accounts: args.btc.accounts } }),
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
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);
    const startedAtMs = h.clock();

    const { swapId, offerA, acceptA, acceptB } = await pairAndLockB("00000001", buyer, h, t0);

    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(2);

    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.reveal).toBeDefined();
    await h.mineBlocks(2);

    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const accounts = await resolveBtcAccounts(h, h.buyerRail, acceptA.contract, termsA);

    await writeAndReplay({
      scenario: "settled",
      swapId,
      status: "settled",
      venue: h.venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore: h.noteStore,
      btc: { ref: lockA.writeEvidence.ref, terms: termsA, accounts },
      startedAtMs,
      nowMs: h.clock(),
      writes: [
        { leg: "a", step: "lock", rail: "btc-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "btc-htlc", evidence: claimed.evidence },
      ],
      writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
    });
  }, 120_000);

  it("scenario 2: refunded — Seller never reveals; Buyer refunds A after MTP passes T, Seller refunds B -> refunded", async () => {
    const buyer = ident(3);
    const seller = ident(4);
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);
    const startedAtMs = h.clock();

    const { swapId, offerA, offerB, acceptA, acceptB } = await pairAndLockB("00000002", buyer, h, t0);

    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(2);

    // The Seller never claims/reveals. Push median time past legA.refundAfterMs, then each
    // party refunds its own leg.
    await h.warpTo(offerA.refundAfterMs + 5 * 60_000);
    // P4-BTC-FIXES.md G7: refundLegA now broadcasts, then reports success only once the refund
    // itself is confirmed (this file's own config requires 2 confirmations) — the first call
    // broadcasts and finds it unconfirmed (a regtest node never auto-mines); mining enough blocks,
    // then calling again (a no-op re-check, never a second broadcast), lets it report success.
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);
    await h.mineBlocks(2);
    const refundA = await h.buyerFlow.refundLegA();
    expect(refundA.txid).toMatch(/^[0-9a-f]{64}$/);

    await h.warpTo(offerB.refundAfterMs + 60_000);
    const refundB = await h.sellerFlow.refundLegB();
    expect(refundB.refund).toBeDefined();

    const termsA = offerAcceptLockTerms(offerA, acceptA);
    const accounts = await resolveBtcAccounts(h, h.buyerRail, acceptA.contract, termsA);

    await writeAndReplay({
      scenario: "refunded",
      swapId,
      status: "refunded",
      venue: h.venue,
      acceptAContract: acceptA.contract,
      acceptBContract: acceptB.contract,
      noteStore: h.noteStore,
      btc: { ref: lockA.writeEvidence.ref, terms: termsA, accounts },
      startedAtMs,
      nowMs: h.clock(),
      writes: [
        { leg: "a", step: "lock", rail: "btc-htlc", evidence: lockA.writeEvidence },
        { leg: "a", step: "refund", rail: "btc-htlc", evidence: refundA },
      ],
      writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
    });
  }, 120_000);

  it("scenario 3: refunded-b — Buyer never funds A; Seller refunds B -> refunded-b", async () => {
    const buyer = ident(5);
    const seller = ident(6);
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);
    const startedAtMs = h.clock();

    const { swapId, offerB, acceptA, acceptB } = await pairAndLockB("00000003", buyer, h, t0);

    // The Buyer never calls lockLegA at all. Once B's refund window opens, the Seller refunds it.
    await h.warpTo(offerB.refundAfterMs + 60_000);
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

  it("scenario 4: claim refused before N confirmations, allowed once N is reached", async () => {
    const buyer = ident(7);
    const seller = ident(8);
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

    await pairAndLockB("00000004", buyer, h, t0);
    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(1); // only 1 of this file's own 2 required confirmations

    await expect(h.sellerFlow.claimLegA(lockA.hashLock)).rejects.toThrow(/verifyLockFinal\(A\) is true/);

    await h.mineBlocks(1); // now 2
    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.ref).toBe(lockA.writeEvidence.ref);
  }, 120_000);

  it("scenario 5: Seller claims without posting reveal A; Buyer learns s from the chain", async () => {
    const buyer = ident(9);
    const seller = ident(10);
    const t0 = await currentMediantimeMs(node);
    const h = setupSwap(node, config, freshParty(buyer), freshParty(seller), t0);

    await pairAndLockB("00000005", buyer, h, t0);
    const lockA = await h.buyerFlow.lockLegA();
    await h.mineBlocks(2);

    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock, { skipReveal: true });
    expect(claimed.reveal).toBeUndefined();
    await h.mineBlocks(1);

    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);
  }, 120_000);

  describe("scenario 6: a claim that fails testmempoolaccept is never broadcast", () => {
    it("the Seller's own well-formed claim (right secret, right script, right fee) is rejected once the outpoint is already spent", async () => {
      const buyerKey: BtcSignerKey = keyFor(node.buyer);
      const sellerKey: BtcSignerKey = keyFor(node.seller);
      const buyerWallet = { wallet: node.buyer.wallet, key: buyerKey };
      const sellerWallet = { wallet: node.seller.wallet, key: sellerKey };

      const buyerRail = await BtcHtlcRail.connect({ config, rpc: node.createCapturingRpc() });
      const sellerRail = await BtcHtlcRail.connect({ config, rpc: node.createCapturingRpc() });

      const preimage = randomBytes(32);
      const hashLock = sha256(preimage);
      const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
      const t = info.mediantime + 120; // just above current mediantime — not yet reachable
      const refundAfterMs = t * 1000;
      const terms: BtcHtlcTerms = {
        hashLock: `0x${bytesToHex(hashLock)}`,
        amountSats: "1000000",
        refundAfterMs,
        payeePubkey: node.seller.pubkey.toLowerCase(),
        payerPubkey: node.buyer.pubkey.toLowerCase(),
      };

      const fundEvidence = await buyerRail.fund(terms, buyerWallet);
      await node.mine(2);

      // The Buyer refunds first (probe Q4: setmocktime + mine 11 so MTP itself passes T),
      // spending the outpoint via the timelock branch.
      await node.setMockTime(t + 200);
      await node.mine(11);
      await buyerRail.refund(fundEvidence.ref, terms, buyerWallet, node.buyer.address);
      await node.mine(1);

      // The Seller, unaware the outpoint is already spent, builds a claim with the REAL secret —
      // every one of BtcHtlcRail.claim()'s own preimage-hash, script-match and fee pre-checks
      // still passes (they only ever look at `terms`/the funding output, never spentness); only
      // the chain's own mempool policy can catch this now, since the outpoint no longer exists
      // to spend. `broadcastOrThrow` must refuse it there, and `sendrawtransaction` must never
      // run.
      await expect(
        sellerRail.claim(fundEvidence.ref, terms, `0x${bytesToHex(preimage)}`, sellerWallet, node.seller.address, refundAfterMs + 3600_000),
      ).rejects.toThrow(/testmempoolaccept/);

      const mempool = await node.rpcCall<string[]>("getrawmempool", []);
      expect(mempool).toEqual([]);
    }, 120_000);
  });
});
