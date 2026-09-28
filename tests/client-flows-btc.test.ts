// SPDX-License-Identifier: MIT
//
// tests/client-flows-btc.test.ts — P4-BTC-FIXES.md G9: hermetic unit tests (a scriptable fake
// `CounterAssetRail` + `MemoryVenue`, mirroring tests/client-flows.test.ts's own pattern) for the
// Bitcoin-flavoured client-flow behaviour Group G added: G2 (one funding per swap), G5 (the
// Bitcoin-local deadline policy actually comes from the rail, never a caller), G6 (the amount
// floor), and G7 (a refund only counts once confirmed, and one that lost the race to a claim is
// never reported as a refund). `FakeCounterAssetRail`/`FakeConnectedRail` below stand in for
// `src/client/btc-rail.ts`'s real adapter — whose own writes need a live bitcoind wallet to sign
// anything (P4-BTC-SPEC.md §1) — so this file can drive `BuyerFlow`/`SellerFlow`'s own logic
// under full, deterministic control: no chain, no timers, and (per `unimplemented` below) a loud
// failure the moment a refusal this file expects to happen early reaches any rail call it never
// configured. The real end-to-end behaviour (real PSBTs, real confirmations, the reviewer's
// actual pubkey-line and flaky-transport probes) is covered on a real bitcoind node by
// tests-regtest/client-flows.regtest.test.ts.
//
// Design source: flop-contrib/handoff/P4-BTC-FIXES.md G2, G5, G6, G7, G9.

import { dealRoom, MemoryNoteStore, PaperRail } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { BTC_LOCAL_POLICY } from "../src/client/policy.js";
import type {
  ConnectedCounterAssetRail,
  CounterAssetRail,
  PreparedLock,
  RailAccounts,
  RailBlockMarker,
  RailEvidenceResult,
  RailWriteEvidence,
} from "../src/client/counter-rail.js";
import { BTC_MIN_LOCKABLE_SATS } from "../src/rails/btc-htlc.js";
import type { Exchange } from "../src/rails/rpc-capture.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { identity, type Identity } from "./helpers/identity.js";

const T0 = 1_700_000_000_000;
const BTC_MIN_LOCKABLE = BTC_MIN_LOCKABLE_SATS.toString();
const DUMMY_PAYER_PUBKEY = `02${"a".repeat(64)}`;
const DUMMY_PAYEE_PUBKEY = `03${"b".repeat(64)}`;
const REF = `${"aa".repeat(32)}:0`;

function ident(tag: number): Identity {
  return identity(tag.toString(16).padStart(2, "0").repeat(32));
}

/** Leg A sized so its own window (`refundAfterMs - a fixed 30-min lockTimeMs`) is exactly
 *  `windowMs` — lets a test dial the reveal window (rule 1) or the claim-inclusion gap right up
 *  to (or just under) BTC_LOCAL_POLICY's own 60-minute numbers. */
function legADeadlines(windowMs: number) {
  const lockTimeMs = T0 + 30 * 60_000;
  return { claimByMs: lockTimeMs + 5 * 60_000, refundAfterMs: lockTimeMs + windowMs, expiresMs: T0 + 10 * 60_000, lockTimeMs };
}
function legBDeadlines() {
  return { claimByMs: T0 + 12 * 60 * 60_000, refundAfterMs: T0 + 24 * 60 * 60_000, expiresMs: T0 + 60 * 60_000 };
}

function unimplemented(name: string): never {
  throw new Error(`FakeCounterAssetRail: ${name} was not configured for this test (G9: hermetic — no rail call this test didn't script)`);
}

interface FakeRailScript {
  prepareLock?: () => Promise<PreparedLock>;
  commitLock?: () => Promise<RailWriteEvidence>;
  claim?: () => Promise<RailWriteEvidence>;
  refund?: () => Promise<RailWriteEvidence>;
  verifyLockFinal?: () => Promise<RailEvidenceResult>;
  findClaimedPreimage?: () => Promise<string | null>;
  chainTimeMs?: () => Promise<number>;
  currentBlockMarker?: () => Promise<RailBlockMarker>;
}

class FakeConnectedRail implements ConnectedCounterAssetRail {
  readonly exchanges: readonly Exchange[] = [];
  constructor(private readonly script: FakeRailScript) {}
  async prepareLock(): Promise<PreparedLock> {
    return (this.script.prepareLock ?? (() => unimplemented("prepareLock")))();
  }
  async commitLock(): Promise<RailWriteEvidence> {
    return (this.script.commitLock ?? (() => unimplemented("commitLock")))();
  }
  async claim(): Promise<RailWriteEvidence> {
    return (this.script.claim ?? (() => unimplemented("claim")))();
  }
  async refund(): Promise<RailWriteEvidence> {
    return (this.script.refund ?? (() => unimplemented("refund")))();
  }
  async verifyLockFinal(): Promise<RailEvidenceResult> {
    return (this.script.verifyLockFinal ?? (() => unimplemented("verifyLockFinal")))();
  }
  async findClaimedPreimage(): Promise<string | null> {
    return (this.script.findClaimedPreimage ?? (() => unimplemented("findClaimedPreimage")))();
  }
  async chainTimeMs(): Promise<number> {
    return (this.script.chainTimeMs ?? (() => unimplemented("chainTimeMs")))();
  }
  async currentBlockMarker(): Promise<RailBlockMarker> {
    return (this.script.currentBlockMarker ?? (() => unimplemented("currentBlockMarker")))();
  }
}

/** Stands in for `src/client/btc-rail.ts`'s `BtcCounterRail` — same shape (`railId: "btc-htlc"`,
 *  `policy: BTC_LOCAL_POLICY`, an optional `minLockableAmount`), fully scriptable via
 *  `FakeRailScript` so a test can drive exactly the sequence of writes/reads it needs. */
class FakeCounterAssetRail implements CounterAssetRail {
  readonly railId = "btc-htlc";
  readonly caip2 = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328";
  readonly policy = BTC_LOCAL_POLICY;
  readonly minLockableAmount: string | undefined;
  connectCalls = 0;

  constructor(
    private readonly script: FakeRailScript,
    minLockableAmount?: string,
  ) {
    this.minLockableAmount = minLockableAmount;
  }

  formatAccountLine(pubkey: string): string {
    return `swap1 pubkey btc-htlc ${this.caip2.split(":")[1]} ${pubkey}`;
  }

  resolveAccounts(): RailAccounts {
    // No test below ever needs this fake to actually read the deal room — a refusal under test
    // either happens before any account is ever resolved, or the test only cares about the
    // scripted write/read sequence past that point.
    return { payer: DUMMY_PAYER_PUBKEY, payee: DUMMY_PAYEE_PUBKEY };
  }

  async connect(): Promise<ConnectedCounterAssetRail> {
    this.connectCalls += 1;
    return new FakeConnectedRail(this.script);
  }
}

function harness(buyerRail: CounterAssetRail, sellerRail: CounterAssetRail) {
  const buyer = ident(1);
  const seller = ident(2);
  const clockRef = { ms: T0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const buyerFlow = new BuyerFlow({ identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail, clock });
  const sellerFlow = new SellerFlow({ identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock });
  return { buyer, seller, venue, clockRef, clock, buyerFlow, sellerFlow };
}

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both pubkey lines — the
 *  full happy prefix up to (but not including) `lockLegA`, mirroring
 *  tests/client-flows.test.ts's own `pairLockBAndAccountLines`. `window` is leg A's own
 *  refundAfterMs-minus-lockTimeMs window (default: a full 6h, comfortably clear of every
 *  BTC_LOCAL_POLICY number this file dials). */
async function pairLockBAndAccountLines(h: ReturnType<typeof harness>, windowMs = 6 * 60 * 60_000) {
  const legA = legADeadlines(windowMs);
  const swapId = computeSwapId(h.buyer.did, "00000001");
  const offerA = await h.buyerFlow.bid({
    swapId,
    wantAsset: "FLOP",
    wantAmount: "52070000",
    wantRail: "flop-htlc",
    amount: "1000000",
    asset: "BTC",
    claimByMs: legA.claimByMs,
    refundAfterMs: legA.refundAfterMs,
    expiresMs: T0 + 10 * 60_000,
  });
  const { acceptA, acceptARecord, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
  const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  await h.sellerFlow.postAccountLineA(DUMMY_PAYEE_PUBKEY);
  await h.buyerFlow.postAccountLineA(DUMMY_PAYER_PUBKEY);
  return { swapId, offerA, acceptA };
}

// ── G6: the amount floor ─────────────────────────────────────────────────────────────────────

describe("G6 — the Bitcoin rail's amount floor", () => {
  it("BuyerFlow.bid refuses 1,200 sats before ever touching the rail", async () => {
    const rail = new FakeCounterAssetRail({}, BTC_MIN_LOCKABLE);
    const h = harness(rail, new FakeCounterAssetRail({}));
    await expect(
      h.buyerFlow.bid({
        swapId: computeSwapId(h.buyer.did, "00000001"),
        wantAsset: "FLOP",
        wantAmount: "1",
        wantRail: "flop-htlc",
        amount: "1200",
        asset: "BTC",
        ...legADeadlines(6 * 60 * 60_000),
      }),
    ).rejects.toThrow(/below this rail's minimum lockable amount/);
    expect(rail.connectCalls).toBe(0);
  });

  it("BuyerFlow.bid refuses 900 sats before ever touching the rail", async () => {
    const rail = new FakeCounterAssetRail({}, BTC_MIN_LOCKABLE);
    const h = harness(rail, new FakeCounterAssetRail({}));
    await expect(
      h.buyerFlow.bid({
        swapId: computeSwapId(h.buyer.did, "00000001"),
        wantAsset: "FLOP",
        wantAmount: "1",
        wantRail: "flop-htlc",
        amount: "900",
        asset: "BTC",
        ...legADeadlines(6 * 60 * 60_000),
      }),
    ).rejects.toThrow(/below this rail's minimum lockable amount/);
  });

  it("SellerFlow.acceptLegA refuses a leg A offer below the floor even though the Buyer's own bid() let it through", async () => {
    // A Buyer whose own rail has no floor configured (simulating a careless/malicious Buyer)
    // successfully bids 1,200 sats; the Seller's own rail DOES have the real floor, and must
    // refuse to accept it — never trusting the Buyer to have checked.
    const h = harness(new FakeCounterAssetRail({}), new FakeCounterAssetRail({}, BTC_MIN_LOCKABLE));
    const offerA = await h.buyerFlow.bid({
      swapId: computeSwapId(h.buyer.did, "00000001"),
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      amount: "1200",
      asset: "BTC",
      ...legADeadlines(6 * 60 * 60_000),
    });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legADeadlines(6 * 60 * 60_000).lockTimeMs)).rejects.toThrow(
      /below this rail's minimum lockable amount/,
    );
  });
});

// ── G5: the policy belongs to the rail ───────────────────────────────────────────────────────

describe("G5 — a Bitcoin flow uses BTC_LOCAL_POLICY's own 60-minute numbers", () => {
  it("refuses a leg-A window under 60 minutes (rule 1: the Seller's own reveal window)", async () => {
    const h = harness(new FakeCounterAssetRail({}), new FakeCounterAssetRail({}));
    const lockTimeMs = T0 + 30 * 60_000;
    // claimByMs..refundAfterMs is a wide 70-minute gap (clear of the 60-minute claim-inclusion
    // margin, checked first), but refundAfterMs is only 50 minutes past lockTimeMs — under
    // BTC_LOCAL_POLICY.minRevealWindowMs (60 min), rule 1's own number.
    const refundAfterMs = lockTimeMs + 50 * 60_000;
    const claimByMs = refundAfterMs - 70 * 60_000;
    const offerA = await h.buyerFlow.bid({
      swapId: computeSwapId(h.buyer.did, "00000001"),
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "BTC",
      claimByMs,
      refundAfterMs,
      expiresMs: T0 + 10 * 60_000,
    });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), lockTimeMs)).rejects.toThrow(
      /leg B deadlines it would propose are unsafe/,
    );
  });

  it("refuses to accept a leg A offer whose claim/refund gap is inside the 60-minute claim-inclusion margin", async () => {
    const h = harness(new FakeCounterAssetRail({}), new FakeCounterAssetRail({}));
    const lockTimeMs = T0 + 30 * 60_000;
    const offerA = await h.buyerFlow.bid({
      swapId: computeSwapId(h.buyer.did, "00000001"),
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "BTC",
      claimByMs: lockTimeMs + 6 * 60 * 60_000,
      refundAfterMs: lockTimeMs + 6 * 60 * 60_000 + 30 * 60_000, // 30-minute gap: under the 60-minute margin
      expiresMs: T0 + 10 * 60_000,
    });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), lockTimeMs)).rejects.toThrow(/claim-inclusion margin/);
  });
});

// ── G2: one funding per swap ─────────────────────────────────────────────────────────────────

describe("G2 — one funding per swap", () => {
  it("a second lockLegA call throws, and the rail's own commitLock is never called a second time", async () => {
    let commitCalls = 0;
    let prepareCalls = 0;
    const rail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => {
        prepareCalls += 1;
        return { ref: REF };
      },
      commitLock: async () => {
        commitCalls += 1;
        return { ref: REF, raw: [] };
      },
    });
    const h = harness(rail, new FakeCounterAssetRail({}));
    await pairLockBAndAccountLines(h);

    await expect(h.buyerFlow.lockLegA()).resolves.toBeDefined();
    expect(prepareCalls).toBe(1);
    expect(commitCalls).toBe(1);

    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/already attempted, or a lock is already in flight \(G2\)/);
    // The latch refuses before ever calling the rail again — neither counter moves.
    expect(prepareCalls).toBe(1);
    expect(commitCalls).toBe(1);
  });

  it("refuses a concurrent second lock attempt while the first is still in flight", async () => {
    let resolveFirstCommit: (() => void) | undefined;
    const commitGate = new Promise<void>((resolve) => {
      resolveFirstCommit = resolve;
    });
    const rail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: REF }),
      commitLock: async () => {
        await commitGate;
        return { ref: REF, raw: [] };
      },
    });
    const h = harness(rail, new FakeCounterAssetRail({}));
    await pairLockBAndAccountLines(h);

    const first = h.buyerFlow.lockLegA();
    const second = h.buyerFlow.lockLegA();
    await expect(second).rejects.toThrow(/already attempted, or a lock is already in flight \(G2\)/);
    resolveFirstCommit?.();
    await expect(first).resolves.toBeDefined();
  });

  it("reconcileLockA throws when nothing was ever attempted", async () => {
    const h = harness(new FakeCounterAssetRail({}), new FakeCounterAssetRail({}));
    await pairLockBAndAccountLines(h);
    await expect(h.buyerFlow.reconcileLockA()).rejects.toThrow(/leg A lock was never attempted/);
  });
});

// ── G7: a refund counts only when confirmed ─────────────────────────────────────────────────

describe("G7 — a refund counts only when confirmed", () => {
  async function lockedFlow(): Promise<{ h: ReturnType<typeof harness>; rail: FakeCounterAssetRail; dealRoomA: string }> {
    const rail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: REF }),
      commitLock: async () => ({ ref: REF, raw: [] }),
    });
    const h = harness(rail, new FakeCounterAssetRail({}));
    const { offerA, acceptA } = await pairLockBAndAccountLines(h);
    await h.buyerFlow.lockLegA();
    h.clockRef.ms = offerA.refundAfterMs;
    return { h, rail, dealRoomA: dealRoom(acceptA.contract) };
  }

  it("throws 'not yet confirmed' after broadcasting, and never re-broadcasts on a retry that finds it confirmed", async () => {
    let refundCalls = 0;
    let verifyCalls = 0;
    const { h, rail } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        refund: async () => {
          refundCalls += 1;
          return { ref: REF, raw: [] };
        },
        verifyLockFinal: async () => {
          verifyCalls += 1;
          return verifyCalls === 1
            ? { lock: { rail: "btc-htlc", ref: REF, terms: {} as never, railVerified: null, checkedAtMs: 0 } }
            : {
                lock: { rail: "btc-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
                rail: { status: "refunded", final: true, checkedAtMs: 0 },
              };
        },
      });

    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);
    expect(refundCalls).toBe(1);
    const refundA = await h.buyerFlow.refundLegA();
    expect(refundA.ref).toBe(REF);
    // The retry re-checked, but never re-broadcast.
    expect(refundCalls).toBe(1);
    expect(verifyCalls).toBe(2);
  });

  it("refuses to report a refund when the outpoint was claimed instead (lost the race)", async () => {
    const { h, rail } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        refund: async () => ({ ref: REF, raw: [] }),
        verifyLockFinal: async () => ({
          lock: { rail: "btc-htlc", ref: REF, terms: {} as never, railVerified: false, checkedAtMs: 0 },
          rail: { status: "claimed", final: true, checkedAtMs: 0 },
        }),
      });

    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/claimed instead/);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/learnSecret\(\) then claimLegB\(\)/);
  });

  it("posts the refund/receipt frames only once even across a retried call", async () => {
    const { h, rail, dealRoomA } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        refund: async () => ({ ref: REF, raw: [] }),
        verifyLockFinal: async () => ({
          lock: { rail: "btc-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
          rail: { status: "refunded", final: true, checkedAtMs: 0 },
        }),
      });

    await h.buyerFlow.refundLegA();
    const recordsAfterFirst = (await h.venue.read(dealRoomA)).length;
    // A second call (a runner that doesn't know the first already succeeded) must never post the
    // refund/receipt frames again.
    await h.buyerFlow.refundLegA();
    const recordsAfterSecond = (await h.venue.read(dealRoomA)).length;
    expect(recordsAfterSecond).toBe(recordsAfterFirst);
  });
});
