// SPDX-License-Identifier: MIT
//
// tests/client-flows-near.test.ts — P5-NEAR-SPEC.md §7a: hermetic unit tests (a scriptable fake
// `CounterAssetRail` + `MemoryVenue`, mirroring tests/client-flows-btc.test.ts's own pattern) for
// the near-htlc-flavoured client-flow behaviour, over the same shared `BuyerFlow`/`SellerFlow`
// logic Group G's Bitcoin fixes (and the R3 K-series) hardened: the amount floor and asset check
// refusing before ever touching the rail, one funding per swap (the latch), a recorded funding
// that can be announced once confirmed even when its own post failed, the local deadline policy
// coming from the rail (never a caller), the last-moment claim guard judged against
// max(chainTime, clock) — never either alone, a refund counting only once confirmed, D-N6's own
// `checkPendingClaim` routing a pending claim to `learnSecret()`/`claimLegB()` before ever
// building a doomed refund, and `learnSecret()` recovering the preimage both from a posted
// `reveal` frame and (SPEC §6 scenario 5) from a `Claiming`/`Claimed` on-chain read alone.
//
// `FakeCounterAssetRail`/`FakeConnectedRail` below stand in for `src/client/near-rail.ts`'s real
// adapter — whose own writes need a real (or sandboxed) NEAR RPC endpoint and a live signer to do
// anything (D-N2/D-10) — so this file can drive `BuyerFlow`/`SellerFlow`'s own logic under full,
// deterministic control: no chain, no timers, and (per `unimplemented` below) a loud failure the
// moment a refusal this file expects to happen early reaches any rail call it never configured.
// This mirrors client-flows-btc.test.ts's own choice exactly (that file does not open a real
// bitcoind connection either); `near-rail.ts`'s own wiring onto the real `NearHtlcRail`/
// `nearEvidence` is exercised by tests/near-htlc.test.ts and tests/near-evidence.test.ts (mocked
// JSON-RPC, no network) instead — this file's own job is the RAIL-AGNOSTIC flow logic, configured
// to near-htlc's own shape (the squatting-fix ref 0x<hash lock>:<payer>, D-N5's account-id accounts,
// D-N6's `checkPendingClaim`-yes/`resendRefundIfDropped`-no rail shape, D-N8's policy numbers).
//
// P5-NEAR-SPEC.md §4's own storage-registration pre-check (near-htlc.ts's own `claim()`: a
// payee who was never storage-registered on the USDC token can never actually receive a payout)
// is a rail-internal refusal, not something `SellerFlow.claimLegA` computes itself — it is unit
// tested directly against the real adapter in tests/near-htlc.test.ts; this file instead pins
// that `SellerFlow.claimLegA` PROPAGATES that refusal from the rail's own `claim()` call without
// swallowing it or posting a reveal frame it can't back up (see "claim refused when the payee is
// unregistered" below).
//
// Design source: flop-contrib/handoff/P4-BTC-FIXES.md G1-G9; P4-BTC-FIXES-R3.md K1-K6 (the
// shared client-flow contract every rail's own tests pin); P5-NEAR-DECISIONS-2026-09-29.md
// D-N4..D-N8, D-N10.

import { dealRoom, MemoryNoteStore, PaperRail, tryDecodeFrame, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue, type Signer, type Venue } from "../src/client/venue.js";
import { NEAR_LOCAL_POLICY } from "../src/client/policy.js";
import {
  belowMinLockable,
  type ConnectedCounterAssetRail,
  type CounterAssetRail,
  type PreparedLock,
  type RailAccounts,
  type RailBlockMarker,
  type RailEvidenceResult,
  type RailWriteEvidence,
} from "../src/client/counter-rail.js";
import { NEAR_AMOUNT_FLOOR, NEAR_ASSET_ID } from "../src/rails/near-htlc.js";
import type { Exchange } from "../src/rails/rpc-capture.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { identity, type Identity } from "./helpers/identity.js";

const T0 = 1_700_000_000_000;
const DUMMY_PAYER_ACCOUNT = "buyer.near-sandbox-flop";
const DUMMY_PAYEE_ACCOUNT = "seller.near-sandbox-flop";
// Squatting fix (replacing D-N4): near-htlc's own write ref is `0x<hash lock>:<payer account>` —
// the payer here is the Buyer's own dummy account.
const REF = `0x${"aa".repeat(32)}:${DUMMY_PAYER_ACCOUNT}`;
/** The ref the real near-rail adapter returns for a Buyer locking under `statement`. */
function nearRefOf(statement: string): string {
  return `${statement}:${DUMMY_PAYER_ACCOUNT}`;
}

function ident(tag: number): Identity {
  return identity(tag.toString(16).padStart(2, "0").repeat(32));
}

/** Leg A sized so its own window (`refundAfterMs - a fixed 30-min lockTimeMs`) is exactly
 *  `windowMs` — lets a test dial the reveal window (rule 1) or the claim-inclusion gap right up
 *  to (or just under) NEAR_LOCAL_POLICY's own 45/5-minute numbers. `lockTimeMs` is rule 1's
 *  generic "when leg A locks" input (src/deadlines.ts's own `checkSwapDeadlines`) — not itself a
 *  Bitcoin CLTV concept, so this helper transfers unchanged from client-flows-btc.test.ts. */
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
  claim?: (ref?: string) => Promise<RailWriteEvidence>;
  refund?: () => Promise<RailWriteEvidence>;
  /** D-N6: near-htlc's real adapter never implements this (see near-rail.ts's own header
   *  comment) — a script that omits this leaves the field entirely absent on the connected
   *  handle (never merely `undefined` via `unimplemented`), exactly like the real adapter, so
   *  `BuyerFlow.refundLegA`'s own `connected.resendRefundIfDropped !== undefined` check sees the
   *  same thing it would against the real near-htlc rail. Kept in the script type only so a test
   *  CAN prove the flow still works even if some future rail's fake supplied one; no test below
   *  exercises it, since D-N6 means near-rail.ts never will.
   */
  resendRefundIfDropped?: () => Promise<RailWriteEvidence>;
  verifyLockFinal?: () => Promise<RailEvidenceResult>;
  findClaimedPreimage?: () => Promise<string | null>;
  /** D-N6: near-htlc's real adapter DOES implement this (`NearHtlcRail.checkPendingClaim`, the
   *  same cheap `get_lock` read as `findClaimedPreimage` — NEAR has no mempool race to check
   *  separately). */
  checkPendingClaim?: () => Promise<string | null>;
  chainTimeMs?: () => Promise<number>;
  currentBlockMarker?: () => Promise<RailBlockMarker>;
}

class FakeConnectedRail implements ConnectedCounterAssetRail {
  readonly exchanges: readonly Exchange[] = [];
  // P7: these fakes post unproven lines (the flows do not post proofs yet), so signing is never reached.
  async signAccountProof(): Promise<never> {
    throw new Error("FakeConnectedRail: signAccountProof is not scripted");
  }
  readonly resendRefundIfDropped?: (ref: string, priorEvidence: RailWriteEvidence) => Promise<RailWriteEvidence>;
  readonly checkPendingClaim?: (ref: string, fromMarker?: RailBlockMarker) => Promise<string | null>;
  constructor(private readonly script: FakeRailScript) {
    if (script.resendRefundIfDropped !== undefined) {
      const resend = script.resendRefundIfDropped;
      this.resendRefundIfDropped = async () => resend();
    }
    if (script.checkPendingClaim !== undefined) {
      const check = script.checkPendingClaim;
      this.checkPendingClaim = async () => check();
    }
  }
  async prepareLock(): Promise<PreparedLock> {
    return (this.script.prepareLock ?? (() => unimplemented("prepareLock")))();
  }
  async commitLock(): Promise<RailWriteEvidence> {
    return (this.script.commitLock ?? (() => unimplemented("commitLock")))();
  }
  async claim(ref?: string): Promise<RailWriteEvidence> {
    return (this.script.claim ?? (() => unimplemented("claim")))(ref);
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

/** Stands in for `src/client/near-rail.ts`'s `NearCounterRail` — same shape (`railId:
 *  "near-htlc"`, `policy: NEAR_LOCAL_POLICY`, `minLockableAmount: NEAR_AMOUNT_FLOOR`, `assetId:
 *  NEAR_ASSET_ID`), fully scriptable via `FakeRailScript` so a test can drive exactly the
 *  sequence of writes/reads it needs. */
class FakeCounterAssetRail implements CounterAssetRail {
  readonly railId = "near-htlc";
  readonly caip2 = "near:near-sandbox-flop";
  readonly policy = NEAR_LOCAL_POLICY;
  readonly minLockableAmount: string | undefined;
  readonly assetId: string | undefined;
  connectCalls = 0;

  constructor(
    private readonly script: FakeRailScript,
    minLockableAmount?: string,
    assetId?: string,
  ) {
    this.minLockableAmount = minLockableAmount;
    this.assetId = assetId;
  }

  formatAccountLine(address: string): string {
    return `swap1 account near-htlc near-sandbox-flop ${address}`;
  }

  resolveAccounts(): RailAccounts {
    // No test below ever needs this fake to actually read the deal room — a refusal under test
    // either happens before any account is ever resolved, or the test only cares about the
    // scripted write/read sequence past that point.
    return { payer: DUMMY_PAYER_ACCOUNT, payee: DUMMY_PAYEE_ACCOUNT };
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

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both account lines — the
 *  full happy prefix up to (but not including) `lockLegA`, mirroring
 *  tests/client-flows-btc.test.ts's own `pairLockBAndAccountLines`. `window` is leg A's own
 *  refundAfterMs-minus-lockTimeMs window (default: a full 6h, comfortably clear of every
 *  NEAR_LOCAL_POLICY number this file dials). */
async function pairLockBAndAccountLines(h: ReturnType<typeof harness>, windowMs = 6 * 60 * 60_000) {
  const legA = legADeadlines(windowMs);
  const swapId = computeSwapId(h.buyer.did, "00000001");
  const offerA = await h.buyerFlow.bid({
    swapId,
    wantAsset: "FLOP",
    wantAmount: "52070000",
    wantRail: "flop-htlc",
    amount: "1000000",
    asset: "USDC",
    claimByMs: legA.claimByMs,
    refundAfterMs: legA.refundAfterMs,
    expiresMs: T0 + 10 * 60_000,
  });
  const { acceptA, acceptARecord, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
  const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  await h.sellerFlow.postAccountLineA(DUMMY_PAYEE_ACCOUNT);
  await h.buyerFlow.postAccountLineA(DUMMY_PAYER_ACCOUNT);
  return { swapId, offerA, acceptA };
}

// ── D-N8: the amount floor ───────────────────────────────────────────────────────────────────

describe("D-N8 — the near-htlc rail's amount floor", () => {
  // Unlike Bitcoin's own dust-limit-driven floor (BTC_MIN_LOCKABLE_SATS, comfortably above
  // tclk's own "amount must be a non-empty numeric string" grammar), NEAR_AMOUNT_FLOOR ("1") IS
  // tclk's own smallest representable amount — `makeOffer` itself already refuses `amount: "0"`
  // as malformed (vendor/tclk/src/frames.ts), a layer more fundamental than any rail's own
  // `minLockableAmount` check, so there is no amount both valid enough for `BuyerFlow.bid` to
  // build an offer from AND below this rail's own floor. `belowMinLockable` (the shared helper
  // `BuyerFlow.bid`/`SellerFlow.acceptLegA` both call — src/client/counter-rail.ts) is therefore
  // pinned directly instead, the same mechanism the BTC/EVM flow-level refusal tests exercise
  // indirectly through a real offer.
  it("belowMinLockable reports '0' as below NEAR_AMOUNT_FLOOR, and '1' (the floor itself) as not", () => {
    const rail = new FakeCounterAssetRail({}, NEAR_AMOUNT_FLOOR);
    expect(belowMinLockable(rail, "0")).toBe(true);
    expect(belowMinLockable(rail, NEAR_AMOUNT_FLOOR)).toBe(false);
    expect(belowMinLockable(rail, "1000000")).toBe(false);
  });

  it("a rail with no declared minLockableAmount (evm-htlc-shaped) never reports anything as below the floor", () => {
    const rail = new FakeCounterAssetRail({}); // minLockableAmount left undefined
    expect(belowMinLockable(rail, "0")).toBe(false);
  });
});

// ── D-N8/K3: the near-htlc leg checks its asset ─────────────────────────────────────────────

describe("D-N8/K3 — the near-htlc rail checks its asset", () => {
  it("BuyerFlow.bid refuses a 'BTC'-labelled leg against a near-htlc rail, before ever touching it", async () => {
    const rail = new FakeCounterAssetRail({}, undefined, NEAR_ASSET_ID);
    const h = harness(rail, new FakeCounterAssetRail({}));
    await expect(
      h.buyerFlow.bid({
        swapId: computeSwapId(h.buyer.did, "00000001"),
        wantAsset: "FLOP",
        wantAmount: "1",
        wantRail: "flop-htlc",
        asset: "BTC", // the reviewer's mislabelled leg
        amount: "1000000",
        ...legADeadlines(6 * 60 * 60_000),
      }),
    ).rejects.toThrow(/asset "BTC".*only ever settles "USDC"/);
    expect(rail.connectCalls).toBe(0);
  });

  it("SellerFlow.acceptLegA refuses a 'BTC'-labelled leg even though the Buyer's own rail let it through", async () => {
    const h = harness(new FakeCounterAssetRail({}), new FakeCounterAssetRail({}, undefined, NEAR_ASSET_ID));
    const offerA = await h.buyerFlow.bid({
      swapId: computeSwapId(h.buyer.did, "00000001"),
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      asset: "BTC",
      amount: "1000000",
      ...legADeadlines(6 * 60 * 60_000),
    });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legADeadlines(6 * 60 * 60_000).lockTimeMs)).rejects.toThrow(
      /asset "BTC".*does not match this rail's own asset "USDC"/,
    );
  });
});

// ── D-N8: the policy belongs to the rail ────────────────────────────────────────────────────

describe("D-N8 — a NEAR flow uses NEAR_LOCAL_POLICY's own 45/5-minute numbers", () => {
  it("refuses a leg-A window under 45 minutes (rule 1: the Seller's own reveal window)", async () => {
    const h = harness(new FakeCounterAssetRail({}), new FakeCounterAssetRail({}));
    const lockTimeMs = T0 + 30 * 60_000;
    // claimByMs..refundAfterMs is a wide 70-minute gap (clear of the 5-minute claim-inclusion
    // margin, checked first), but refundAfterMs is only 40 minutes past lockTimeMs — under
    // NEAR_LOCAL_POLICY.minRevealWindowMs (45 min), rule 1's own number.
    const refundAfterMs = lockTimeMs + 40 * 60_000;
    const claimByMs = refundAfterMs - 70 * 60_000;
    const offerA = await h.buyerFlow.bid({
      swapId: computeSwapId(h.buyer.did, "00000001"),
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      claimByMs,
      refundAfterMs,
      expiresMs: T0 + 10 * 60_000,
    });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), lockTimeMs)).rejects.toThrow(
      /leg B deadlines it would propose are unsafe/,
    );
  });

  it("refuses to accept a leg A offer whose claim/refund gap is inside the 5-minute claim-inclusion margin", async () => {
    const h = harness(new FakeCounterAssetRail({}), new FakeCounterAssetRail({}));
    const lockTimeMs = T0 + 30 * 60_000;
    const offerA = await h.buyerFlow.bid({
      swapId: computeSwapId(h.buyer.did, "00000001"),
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      claimByMs: lockTimeMs + 6 * 60 * 60_000,
      refundAfterMs: lockTimeMs + 6 * 60 * 60_000 + 2 * 60_000, // 2-minute gap: under the 5-minute margin
      expiresMs: T0 + 10 * 60_000,
    });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), lockTimeMs)).rejects.toThrow(/claim-inclusion margin/);
  });
});

// ── G2: one funding per swap ─────────────────────────────────────────────────────────────────

// ── G5: the rail ref IS the Seller's own minted hash lock ───────────────────────────────────

describe("G5 — near-htlc's own rail ref IS the Seller's minted hash lock", () => {
  it("claimLegA refuses when the accepted lock frame's own ref disagrees with the Seller's own statement", async () => {
    // Unlike every other test in this file (which echoes the Seller's real statement, per G5),
    // this fake buyer rail deliberately locks under a DIFFERENT ref — modelling a Buyer (buggy
    // or malicious) whose accepted lock frame names a ref that isn't this Seller's own hash lock.
    const WRONG_REF = `0x${"bb".repeat(32)}:${DUMMY_PAYER_ACCOUNT}`;
    const buyerRail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: WRONG_REF }),
      commitLock: async () => ({ ref: WRONG_REF, raw: [] }),
    });
    const sellerRail = new FakeCounterAssetRail({});
    const h = harness(buyerRail, sellerRail);
    await pairLockBAndAccountLines(h);
    await h.buyerFlow.lockLegA();
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
    await expect(h.sellerFlow.claimLegA(statement)).rejects.toThrow(/accepted lock frame's own ref is not 0x<this flow's own hash lock>:<payer> \(G5/);
  });

  it("claimLegA refuses a lock frame whose ref is the bare hash lock (the pre-fix shape: no payer)", async () => {
    const hBox: { h?: ReturnType<typeof harness> } = {};
    const buyerRail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: hBox.h!.sellerFlow.statement! }),
      commitLock: async () => ({ ref: hBox.h!.sellerFlow.statement!, raw: [] }),
    });
    const h = harness(buyerRail, new FakeCounterAssetRail({}));
    hBox.h = h;
    await pairLockBAndAccountLines(h);
    await h.buyerFlow.lockLegA();
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
    await expect(h.sellerFlow.claimLegA(statement)).rejects.toThrow(/not 0x<this flow's own hash lock>:<payer>/);
  });

  it("claimLegA accepts a ref naming its own hash lock and takes the payer from the ref: the rail is asked to claim under exactly that ref", async () => {
    const hBox: { h?: ReturnType<typeof harness> } = {};
    const PAYER_FROM_FRAME = "someone-paying.near-sandbox-flop"; // not the harness dummy payer: proves the ref is taken from the frame
    const frameRef = () => `${hBox.h!.sellerFlow.statement!}:${PAYER_FROM_FRAME}`;
    const buyerRail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: frameRef() }),
      commitLock: async () => ({ ref: frameRef(), raw: [] }),
    });
    const claimedWith: string[] = [];
    const sellerRail = new FakeCounterAssetRail({});
    const h = harness(buyerRail, sellerRail);
    hBox.h = h;
    (sellerRail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        findClaimedPreimage: async () => null,
        currentBlockMarker: async () => 0,
        chainTimeMs: async () => T0,
        verifyLockFinal: async () => ({
          lock: { rail: "near-htlc", ref: frameRef(), terms: {} as never, railVerified: true, checkedAtMs: 0 },
          rail: { status: claimedWith.length === 0 ? "locked" : "claimed", final: true, checkedAtMs: 0, finalizedRef: "near-sandbox:final:1:x" },
        }),
        claim: async (ref: string) => {
          claimedWith.push(ref);
          return { ref, raw: [] };
        },
      });
    await pairLockBAndAccountLines(h);
    await h.buyerFlow.lockLegA();
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
    await h.sellerFlow.claimLegA(statement);
    expect(claimedWith).toEqual([frameRef()]);
  });
});

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

// ── record-before-send / K5: a recorded funding can be announced ───────────────────────────

/** A `Venue` wrapper that throws once, the first time a posted `line` matches `shouldFail` —
 *  simulates a lock-frame post that itself fails (a dropped ack, a venue-side error) even though
 *  the underlying write it is announcing genuinely landed. */
class FailOnceVenue implements Venue {
  private failed = false;
  constructor(
    private readonly inner: Venue,
    private readonly shouldFail: (line: string) => boolean,
  ) {}
  async post(room: string, line: string, signer: Signer): Promise<TranscriptRecord> {
    if (!this.failed && this.shouldFail(line)) {
      this.failed = true;
      throw new Error("FailOnceVenue: simulated failed post");
    }
    return this.inner.post(room, line, signer);
  }
  async read(room: string): Promise<readonly TranscriptRecord[]> {
    return this.inner.read(room);
  }
}

function lockFramesIn(records: readonly TranscriptRecord[]): TranscriptRecord[] {
  return records.filter((record) => tryDecodeFrame(record.line)?.type === "lock");
}

describe("record-before-send / K5 — a recorded funding can be announced", () => {
  it("reconcileLockA posts the lock frame once the chain confirms it, when lockLegA's own post of it failed", async () => {
    const buyer = ident(1);
    const seller = ident(2);
    const clockRef = { ms: T0 };
    const clock = () => clockRef.ms;
    const innerVenue = new MemoryVenue(clock);
    // Leg A's own lock frame carries `"type":"lock"` AND this leg's own hash lock (`REF`, D-N4:
    // the ref IS the hashLock); leg B's paper-rail lock frame also says `"type":"lock"` but never
    // names this ref, so only leg A's own post ever fails.
    const venue = new FailOnceVenue(innerVenue, (line) => line.includes('"type":"lock"') && line.includes(REF));
    const noteStore = new MemoryNoteStore();
    const rail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: REF }),
      commitLock: async () => ({ ref: REF, raw: [] }),
    });
    const sellerRail = new FakeCounterAssetRail({});
    const buyerFlow = new BuyerFlow({ identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail, clock });
    const sellerFlow = new SellerFlow({ identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock });
    const h = { buyer, seller, clockRef, clock, buyerFlow, sellerFlow } as unknown as ReturnType<typeof harness>;
    const { acceptA } = await pairLockBAndAccountLines(h);
    const dealRoomA = dealRoom(acceptA.contract);

    // The write genuinely lands (commitLock resolves), but announcing it fails — lockLegA itself
    // must surface that failure rather than swallow it.
    await expect(buyerFlow.lockLegA()).rejects.toThrow(/simulated failed post/);
    expect(lockFramesIn(await venue.read(dealRoomA))).toHaveLength(0);

    // The chain now confirms the lock really is there (a real evidence reader would report this
    // once near-evidence.ts's own D-N10 finalized read matches).
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        verifyLockFinal: async () => ({
          lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
          rail: { status: "locked", final: true, checkedAtMs: 0 },
        }),
      });

    const reconciled = await buyerFlow.reconcileLockA();
    expect(reconciled.locked).toBe(true);
    expect(lockFramesIn(await venue.read(dealRoomA))).toHaveLength(1);

    // Idempotent: a second reconcile (or a runner that calls it defensively) never posts twice.
    await buyerFlow.reconcileLockA();
    expect(lockFramesIn(await venue.read(dealRoomA))).toHaveLength(1);
  });
});

// ── last-moment claim guard: max(chain time, clock) ──────────────────────────────────────────

describe("B2/C3/E4 — the last-moment claim guard is judged against max(chain time, clock), never either alone", () => {
  async function lockedForClaim(): Promise<{
    h: ReturnType<typeof harness>;
    sellerRail: FakeCounterAssetRail;
    offerA: Awaited<ReturnType<typeof pairLockBAndAccountLines>>["offerA"];
    statement: string;
  }> {
    // P5-NEAR-FIXES.md G5: the fake rail's own write ref must echo the Seller's real minted
    // statement (see the identical comment elsewhere in this file) — otherwise `claimLegA`'s new
    // G5 ref-mismatch check throws first, before ever reaching the deadline guards these two
    // tests actually mean to exercise.
    const hBox: { h?: ReturnType<typeof harness> } = {};
    const buyerRail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: nearRefOf(hBox.h!.sellerFlow.statement!) }),
      commitLock: async () => ({ ref: nearRefOf(hBox.h!.sellerFlow.statement!), raw: [] }),
    });
    const sellerRail = new FakeCounterAssetRail({});
    const h = harness(buyerRail, sellerRail);
    hBox.h = h;
    const { offerA } = await pairLockBAndAccountLines(h);
    await h.buyerFlow.lockLegA();
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
    return { h, sellerRail, offerA, statement };
  }

  it("refuses a claim when the CHAIN's own time is already unsafe even though wall-clock still looks early", async () => {
    const { h, sellerRail, offerA, statement } = await lockedForClaim();
    // Wall-clock (this.clock()) is still comfortably early; the rail's own chain time is not —
    // max() must pick the chain's own (later, more dangerous) reading.
    h.clockRef.ms = offerA.refundAfterMs - 6 * 60 * 60_000;
    (sellerRail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      // P5-NEAR-FIXES.md G2/G3: nothing has claimed yet — must be scripted to answer `null`.
      new FakeConnectedRail({ findClaimedPreimage: async () => null, chainTimeMs: async () => offerA.claimByMs });
    await expect(h.sellerFlow.claimLegA(statement)).rejects.toThrow(/refusing to claim leg A at\/after its claimByMs/);
  });

  it("refuses a claim when WALL-CLOCK is already unsafe even though the chain's own time still looks early", async () => {
    const { h, sellerRail, offerA, statement } = await lockedForClaim();
    h.clockRef.ms = offerA.claimByMs; // wall-clock at/after claimByMs
    (sellerRail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({ findClaimedPreimage: async () => null, chainTimeMs: async () => offerA.refundAfterMs - 6 * 60 * 60_000 }); // chain still looks early
    await expect(h.sellerFlow.claimLegA(statement)).rejects.toThrow(/refusing to claim leg A at\/after its claimByMs/);
  });
});

// ── G7/D-N6: a refund counts only when confirmed ────────────────────────────────────────────

describe("G7/D-N6 — a refund counts only when confirmed", () => {
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
            ? { lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: null, checkedAtMs: 0 } }
            : {
                lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
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

  it("refuses to report a refund when the lock was claimed instead (lost the race)", async () => {
    const { h, rail } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        refund: async () => ({ ref: REF, raw: [] }),
        verifyLockFinal: async () => ({
          lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: false, checkedAtMs: 0 },
          rail: { status: "claimed", final: true, checkedAtMs: 0 },
        }),
      });

    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/claimed instead/);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/learnSecret\(\) then claimLegB\(\)/);
  });

  it("D-N6: reads the lock's own state before ever building a refund, and routes a pending claim to learnSecret()/claimLegB() without ever broadcasting", async () => {
    let refundCalls = 0;
    let checkCalls = 0;
    const { h, rail } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        checkPendingClaim: async () => {
          checkCalls += 1;
          return `0x${"11".repeat(32)}`;
        },
        refund: async () => {
          refundCalls += 1; // must never be reached — checkPendingClaim already found a claim
          return { ref: REF, raw: [] };
        },
      });

    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/claimed/);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/learnSecret\(\) then claimLegB\(\)/);
    expect(checkCalls).toBe(2);
    expect(refundCalls).toBe(0); // never even attempted a doomed broadcast
  });

  it("D-N6: a refund retry re-checks for a pending claim and routes to learnSecret()/claimLegB() when the Seller claims mid-retry", async () => {
    let refundCalls = 0;
    let claimSeen = false;
    const { h, rail } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        // First call: nothing has claimed the lock yet. After the refund goes out, the Seller's
        // own claim shows up as `Claiming` on the next read (D-N6: no mempool race on NEAR — a
        // transaction either executed or it did not — so this models "the Seller's claim landed
        // between our two calls", not a dropped/replaced broadcast the way Bitcoin's mempool can).
        checkPendingClaim: async () => (claimSeen ? `0x${"22".repeat(32)}` : null),
        refund: async () => {
          refundCalls += 1;
          claimSeen = true;
          return { ref: REF, raw: [] };
        },
        verifyLockFinal: async () => ({
          lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
          rail: { status: "locked", final: true, checkedAtMs: 0 },
        }),
      });

    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/learnSecret\(\) then claimLegB\(\)/);
    expect(refundCalls).toBe(1);
  });

  it("D-N6: a rail with no resendRefundIfDropped concept (matches near-rail.ts's real shape) never has it called, and a confirmed refund still reports", async () => {
    let refundCalls = 0;
    let verifyCalls = 0;
    const { h, rail } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        // No `resendRefundIfDropped` in this script at all — the connected handle's own field
        // stays absent (see FakeConnectedRail's constructor), exactly like near-rail.ts's real
        // adapter (D-N6), so BuyerFlow must never even attempt to call it.
        refund: async () => {
          refundCalls += 1;
          return { ref: REF, raw: [] };
        },
        verifyLockFinal: async () => {
          verifyCalls += 1;
          return verifyCalls === 1
            ? { lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: null, checkedAtMs: 0 } }
            : {
                lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
                rail: { status: "refunded", final: true, checkedAtMs: 0 },
              };
        },
      });

    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/not yet confirmed/);
    await h.buyerFlow.refundLegA();
    expect(refundCalls).toBe(1);
  });

  it("posts the refund/receipt frames only once even across a retried call", async () => {
    const { h, rail, dealRoomA } = await lockedFlow();
    (rail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        refund: async () => ({ ref: REF, raw: [] }),
        verifyLockFinal: async () => ({
          lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
          rail: { status: "refunded", final: true, checkedAtMs: 0 },
        }),
      });

    await h.buyerFlow.refundLegA();
    const recordsAfterFirst = (await h.venue.read(dealRoomA)).length;
    await h.buyerFlow.refundLegA();
    const recordsAfterSecond = (await h.venue.read(dealRoomA)).length;
    expect(recordsAfterSecond).toBe(recordsAfterFirst);
  });
});

// ── learnSecret: a reveal frame, or (SPEC §6 scenario 5) a Claiming/Claimed read alone ────────

describe("learnSecret — from a posted reveal frame, or from a Claiming/Claimed lock alone (D-N6)", () => {
  async function lockedFlowWithSeller(): Promise<{
    h: ReturnType<typeof harness>;
    buyerRail: FakeCounterAssetRail;
    sellerRail: FakeCounterAssetRail;
  }> {
    // P5-NEAR-FIXES.md G5: `near-htlc`'s own write ref IS the Seller's minted hash lock (D-N4),
    // never a fixed dummy value unrelated to it — `SellerFlow.claimLegA` now enforces this
    // (rejecting a mismatched accepted-lock-frame ref exactly like `evm-htlc`), so this fake
    // rail's own `ref` must echo the real statement, the same way the real near-rail.ts adapter
    // always does. `hBox` exists only because the statement isn't minted (via `acceptLegA`,
    // inside `pairLockBAndAccountLines` below) until after `harness()` itself needs `buyerRail`.
    const hBox: { h?: ReturnType<typeof harness> } = {};
    const buyerRail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: nearRefOf(hBox.h!.sellerFlow.statement!) }),
      commitLock: async () => ({ ref: nearRefOf(hBox.h!.sellerFlow.statement!), raw: [] }),
    });
    const sellerRail = new FakeCounterAssetRail({});
    const h = harness(buyerRail, sellerRail);
    hBox.h = h;
    await pairLockBAndAccountLines(h);
    await h.buyerFlow.lockLegA();
    return { h, buyerRail, sellerRail };
  }

  it("recovers the secret from the Seller's own posted reveal frame, without ever calling the rail's findClaimedPreimage", async () => {
    const { h, sellerRail } = await lockedFlowWithSeller();
    (sellerRail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        // P5-NEAR-FIXES.md G2/G3: SellerFlow.claimLegA now checks findClaimedPreimage first, for
        // near-htlc — nothing has claimed yet, so this must be scripted to answer `null`.
        findClaimedPreimage: async () => null,
        chainTimeMs: async () => h.clockRef.ms,
        verifyLockFinal: async () => ({
          lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
          rail: { status: "locked", final: true, checkedAtMs: 0 },
        }),
        claim: async () => ({ ref: REF, raw: [] }),
      });

    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
    // The Seller genuinely claims and reveals — this is the real path a claim takes, so the
    // Buyer's own `learnSecret()` below finds a real, correctly-signed reveal frame naming the
    // real hashLock (D-N4: railRef IS the hashLock for near-htlc).
    await h.sellerFlow.claimLegA(statement);

    // If this ever fell through to `findClaimedPreimage` (buyerRail's own script has none), it
    // would throw `unimplemented("findClaimedPreimage")` — so a successful, correct resolve here
    // proves the reveal-frame path was taken.
    const secret = await h.buyerFlow.learnSecret();
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(0);
  });

  it("SPEC §6 scenario 5: with no reveal frame posted, recovers the secret from the rail's own findClaimedPreimage (a Claiming or Claimed on-chain read)", async () => {
    const { h, buyerRail } = await lockedFlowWithSeller();
    const PREIMAGE = `0x${"33".repeat(32)}`;
    let calls = 0;
    (buyerRail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        findClaimedPreimage: async () => {
          calls += 1;
          // near-htlc's own `findClaimedPreimage` (D-N6) already re-verifies this actually opens
          // the hashLock before ever returning it — `BuyerFlow.learnSecret` trusts the rail here,
          // never re-checking it itself (mirrors evm-htlc's identical contract).
          return PREIMAGE;
        },
      });

    // No reveal frame was ever posted for this leg — the deal room only has the two account
    // lines and the lock frame from pairLockBAndAccountLines/lockLegA.
    const secret = await h.buyerFlow.learnSecret();
    expect(secret).toBe(PREIMAGE);
    expect(calls).toBe(1);
  });

  it("throws when neither a reveal frame nor a claimed/claiming read exists yet", async () => {
    const { h, buyerRail } = await lockedFlowWithSeller();
    (buyerRail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({ findClaimedPreimage: async () => null });
    await expect(h.buyerFlow.learnSecret()).rejects.toThrow(/no reveal frame and no Claimed log yet/);
  });
});

// ── claim refused when the payee is unregistered (near-htlc's own D-N10 pre-check) ───────────

describe("claim refused when the payee is unregistered (near-htlc's own storage-registration pre-check)", () => {
  it("SellerFlow.claimLegA propagates the rail's own refusal without swallowing it, and posts no reveal frame", async () => {
    // P5-NEAR-FIXES.md G5: see the identical comment on `lockedFlowWithSeller` above — the fake
    // rail's own write ref must echo the Seller's real minted statement.
    const hBox: { h?: ReturnType<typeof harness> } = {};
    const buyerRail = new FakeCounterAssetRail({
      currentBlockMarker: async () => 0,
      prepareLock: async () => ({ ref: nearRefOf(hBox.h!.sellerFlow.statement!) }),
      commitLock: async () => ({ ref: nearRefOf(hBox.h!.sellerFlow.statement!), raw: [] }),
    });
    const sellerRail = new FakeCounterAssetRail({});
    const h = harness(buyerRail, sellerRail);
    hBox.h = h;
    const { acceptA } = await pairLockBAndAccountLines(h);
    await h.buyerFlow.lockLegA();

    (sellerRail as unknown as { connect: () => Promise<ConnectedCounterAssetRail> }).connect = async () =>
      new FakeConnectedRail({
        // P5-NEAR-FIXES.md G2/G3: see the identical comment above — nothing has claimed yet.
        findClaimedPreimage: async () => null,
        chainTimeMs: async () => h.clockRef.ms,
        verifyLockFinal: async () => ({
          lock: { rail: "near-htlc", ref: REF, terms: {} as never, railVerified: true, checkedAtMs: 0 },
          rail: { status: "locked", final: true, checkedAtMs: 0 },
        }),
        // Mirrors near-htlc.ts's own `claim()` throwing exactly this message when
        // `storage_balance_of(payee)` reads back `null` (D-N10) — this test pins that
        // SellerFlow.claimLegA surfaces that refusal verbatim, never retries around it, and never
        // posts a reveal frame for a claim that never actually broadcast.
        claim: async () => {
          throw new Error('near-htlc: refusing to claim — payee "seller.near-sandbox-flop" is not storage-registered on the token (the payout would fail)');
        },
      });

    const dealRoomA = dealRoom(acceptA.contract);
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
    const before = (await h.venue.read(dealRoomA)).length;
    await expect(h.sellerFlow.claimLegA(statement)).rejects.toThrow(/not storage-registered on the token/);
    const after = (await h.venue.read(dealRoomA)).length;
    expect(after).toBe(before); // no reveal/receipt frame was posted for a claim that never broadcast
  });
});
