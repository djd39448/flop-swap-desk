// SPDX-License-Identifier: MIT
//
// tests/deadlines-policy.test.ts - P9-4 decision 2 (P9-4-DECISIONS-2026-10-07.md): the known-good deadline set of EACH EVM chain, derived with
// `checkSwapDeadlines` under that chain's own policy and pinned here, with the slack of every rule written down.
//
// A "known-good" set is the one set per chain that satisfies every rule with at least 5 minutes to spare on each:
//   rule 1  (SPEC 3.5)  the Seller's reveal window: leg A's refund time minus the lock time is at least `minRevealWindowMs`;
//   rule 2  (SPEC 3.5)  the leg-linking rule: leg B's claim-by is at least leg A's refund time plus `finalityAMs`;
//   rule 3  (R10.2)     timelock symmetry in FLOP blocks from the lock time;
//   the claim margin    leg A's refund time minus its claim-by is at least `claimInclusionMarginMs` (the Seller refuses to accept below it);
//   the finality row    (the dry run's `finality budget` row) the finality budget plus the 10-minute lock allowance fits between the run's start and leg A's claim-by;
//   the claim pipeline  the lock estimate (10 min) + the finality budget + the lock allowance (10 min) + the claim pipeline after the Seller's last guard
//                       (about 5.25 min) fit between the run's start and leg A's claim-by, so the Seller can still claim when the lock reads final only at the
//                       end of the budget.
// All times are minutes from the run's start; the lock is expected `LOCK_ESTIMATE_MS` (10 min) after it.

import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { BASE_SEPOLIA_POLICY, EVM_LOCAL_POLICY, KNOWN_GOOD_DEADLINES_BY_CHAIN, EvmPolicyUnavailableError, knownGoodDeadlinesFor, type KnownGoodDeadlineMinutes } from "../src/client/policy.js";
import { KNOWN_GOOD_DEADLINES, LOCK_ESTIMATE_MS } from "../src/client/rehearsal-config.js";
import { LOCK_SETTLE_ALLOWANCE_MS } from "../src/client/rehearsal-preflight.js";
import { checkSwapDeadlines } from "../src/deadlines.js";
import { DEFAULT_RPC_TIMEOUT_MS } from "../src/rails/rpc-capture.js";
import type { DeadlinePolicy } from "../src/types.js";
import { Controller } from "./helpers/crash-matrix.js";
import { evmWorldWith } from "./helpers/matrix-worlds.js";
import { buildLegA, buildLegB } from "./helpers/offers.js";

const MIN = 60_000;
const T0 = 1_790_000_000_000; // the run's start

/** The sample's largest finalized lag, 3,086 s (51.4 min): what the pipeline row is also judged against, to show how much room the budget leaves above it. */
const SAMPLE_MAX_LAG_MS = 3_086_000;

/** The worst case between the claim's last deadline guard and its broadcast (the spec's post-guard window): six single-attempt RPC calls (nonce, block,
 *  priority fee, gas price, estimate, send), each bounded at `DEFAULT_RPC_TIMEOUT_MS`, plus up to one more timeout of staleness in the guard's own pending read. */
const POST_GUARD_CALLS = 6;
const CLAIM_PIPELINE_MS = POST_GUARD_CALLS * DEFAULT_RPC_TIMEOUT_MS + DEFAULT_RPC_TIMEOUT_MS;

interface Slack {
  ok: boolean;
  violations: string[];
  rule1: number;
  rule2: number;
  rule3: number;
  claimMargin: number;
  finalityRow: number;
  pipeline: number;
  pipelineAtSampleMax: number;
  claimLandsBeforeRefundMargin: number;
}

/** Every rule's slack in minutes for `set` under `policy`, the lock `LOCK_ESTIMATE_MS` after the start. */
function slackOf(set: KnownGoodDeadlineMinutes, policy: DeadlinePolicy & { claimInclusionMarginMs: number }, lockAfterStartMs = LOCK_ESTIMATE_MS): Slack {
  const at = (min: number): number => T0 + min * MIN;
  const legA = buildLegA(T0, { claimByMs: at(set.legA.claimByMin), refundAfterMs: at(set.legA.refundAfterMin), expiresMs: at(set.legA.expiresMin) });
  const legB = buildLegB(T0, legA, { claimByMs: at(set.legB.claimByMin), refundAfterMs: at(set.legB.refundAfterMin), expiresMs: at(set.legB.expiresMin) });
  const lockTimeMs = T0 + lockAfterStartMs;
  const checked = checkSwapDeadlines(legA, legB, lockTimeMs, policy);
  const claimByFromStart = legA.claimByMs - T0;
  return {
    ok: checked.ok,
    violations: checked.violations,
    rule1: (legA.refundAfterMs - lockTimeMs - policy.minRevealWindowMs) / MIN,
    rule2: (legB.claimByMs - checked.requiredBClaimByMs) / MIN,
    rule3: (legB.refundAfterMs - checked.requiredBRefundAfterMs) / MIN,
    claimMargin: (legA.refundAfterMs - legA.claimByMs - policy.claimInclusionMarginMs) / MIN,
    finalityRow: (claimByFromStart - (policy.finalityAMs + LOCK_SETTLE_ALLOWANCE_MS)) / MIN,
    pipeline: (claimByFromStart - (LOCK_ESTIMATE_MS + policy.finalityAMs + LOCK_SETTLE_ALLOWANCE_MS + CLAIM_PIPELINE_MS)) / MIN,
    pipelineAtSampleMax: (claimByFromStart - (LOCK_ESTIMATE_MS + SAMPLE_MAX_LAG_MS + LOCK_SETTLE_ALLOWANCE_MS + CLAIM_PIPELINE_MS)) / MIN,
    claimLandsBeforeRefundMargin: (legA.refundAfterMs - (legA.claimByMs + CLAIM_PIPELINE_MS)) / MIN,
  };
}

const BASE = KNOWN_GOOD_DEADLINES_BY_CHAIN[84532];
const ANVIL = KNOWN_GOOD_DEADLINES_BY_CHAIN[31337];

describe("P9-4 decision 2: the known-good sets are pinned", () => {
  it("anvil (31337): +60/+90 for leg A and +120/+180 for leg B, and it is the very set the runner's config holds today", () => {
    expect(ANVIL).toEqual({
      legA: { claimByMin: 60, refundAfterMin: 90, expiresMin: 30 },
      legB: { claimByMin: 120, refundAfterMin: 180, expiresMin: 40 },
    });
    expect(KNOWN_GOOD_DEADLINES[31337]).toEqual(ANVIL); // no drift between the per-chain table and the runner's config (per chain id since P9-4 decision 2)
    expect(KNOWN_GOOD_DEADLINES[84532]).toEqual(BASE);
  });

  it("Base Sepolia (84532): leg A claim by +115 refund from +135, leg B claim by +225 refund from +285 (offers expire at +30 and +40)", () => {
    expect(BASE).toEqual({
      legA: { claimByMin: 115, refundAfterMin: 135, expiresMin: 30 },
      legB: { claimByMin: 225, refundAfterMin: 285, expiresMin: 40 },
    });
  });

  it("knownGoodDeadlinesFor selects by chain id and refuses any other with the typed error; the table is frozen", () => {
    expect(knownGoodDeadlinesFor(31337)).toBe(ANVIL);
    expect(knownGoodDeadlinesFor(84532)).toBe(BASE);
    for (const other of [1, 8453, 5, 0, Number.NaN]) expect(() => knownGoodDeadlinesFor(other)).toThrow(EvmPolicyUnavailableError);
    expect(Object.isFrozen(KNOWN_GOOD_DEADLINES_BY_CHAIN)).toBe(true);
    expect(Object.isFrozen(BASE)).toBe(true);
    expect(Object.isFrozen(BASE.legA)).toBe(true);
  });
});

describe("P9-4 decision 2: every rule holds under the chain's own policy, with the slack written down", () => {
  it("anvil's set under EVM_LOCAL_POLICY: all rules pass, rule 2 has 10 minutes to spare", () => {
    const slack = slackOf(ANVIL, EVM_LOCAL_POLICY);
    expect(slack.violations).toEqual([]);
    expect(slack.ok).toBe(true);
    expect(slack.rule1).toBe(35); // 90 - 10 - 45
    expect(slack.rule2).toBe(10); // 120 - (90 + 20)
    expect(slack.rule3).toBe(30);
    expect(slack.claimMargin).toBe(25); // 30 - 5
  });

  it("Base Sepolia's set under BASE_SEPOLIA_POLICY: all rules pass, each with at least 5 minutes to spare (the numbers)", () => {
    const slack = slackOf(BASE, BASE_SEPOLIA_POLICY);
    expect(slack.violations).toEqual([]);
    expect(slack.ok).toBe(true);
    expect(slack.rule1).toBe(80); // refund +135, lock +10, window 45: 135 - 10 - 45
    expect(slack.rule2).toBe(10); // leg B claim-by +225 against 135 + 80
    expect(slack.rule3).toBe(90); // leg B refund +285 against the 195 R10.2 asks (the 3,600-block stall allowance dominates the 20 % margin)
    expect(slack.claimMargin).toBe(10); // 20 minutes between claim-by and refund, the margin is 10
    expect(slack.finalityRow).toBe(25); // 115 - (80 + 10)
    expect(slack.pipeline).toBe(9.75); // 115 - (10 + 80 + 10 + 5.25)
    expect(slack.pipelineAtSampleMax).toBeCloseTo(38.3167, 3); // against the sample's own largest lag (3,086 s) instead of the budget
    for (const [name, value] of Object.entries({ rule1: slack.rule1, rule2: slack.rule2, rule3: slack.rule3, claimMargin: slack.claimMargin, finalityRow: slack.finalityRow, pipeline: slack.pipeline })) {
      expect(value, `${name} keeps at least 5 minutes of slack`).toBeGreaterThanOrEqual(5);
    }
  });

  it("the Seller's claim-by binds well before leg A's refund time: a claim whose last guard passes just before it still lands 14.75 minutes before refunds open, more than the 10-minute margin", () => {
    expect(BASE.legA.refundAfterMin - BASE.legA.claimByMin).toBe(20);
    const slack = slackOf(BASE, BASE_SEPOLIA_POLICY);
    expect(slack.claimLandsBeforeRefundMargin).toBe(14.75);
    expect(slack.claimLandsBeforeRefundMargin * MIN).toBeGreaterThan(BASE_SEPOLIA_POLICY.claimInclusionMarginMs);
  });

  it("the worst-case claim pipeline is 5.25 minutes: six single-attempt calls and one stale read at 45 s each; the Base Sepolia margin covers it with room, the anvil margin does not", () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(45_000);
    expect(CLAIM_PIPELINE_MS).toBe(315_000);
    expect(CLAIM_PIPELINE_MS / MIN).toBe(5.25);
    expect(BASE_SEPOLIA_POLICY.claimInclusionMarginMs - CLAIM_PIPELINE_MS).toBe(285_000); // 4.75 minutes of room
    expect(BASE_SEPOLIA_POLICY.claimInclusionMarginMs).toBeGreaterThan(CLAIM_PIPELINE_MS);
    // anvil's 5-minute margin is BELOW that worst case: it is safe there only because anvil's claim-by binds 30 minutes before the refund time and
    // anvil answers in milliseconds (a note for the reader, pinned so the two policies are not read as equal)
    expect(EVM_LOCAL_POLICY.claimInclusionMarginMs).toBeLessThan(CLAIM_PIPELINE_MS);
  });

  it("rule 1 holds for a lock at any minute up to 90 after the start and breaks at 91 (a 135-minute leg A against the 45-minute reveal window)", () => {
    for (let after = 0; after <= 90; after += 1) expect(slackOf(BASE, BASE_SEPOLIA_POLICY, after * MIN).ok, `lock ${after} min after the start`).toBe(true);
    const late = slackOf(BASE, BASE_SEPOLIA_POLICY, 91 * MIN);
    expect(late.ok).toBe(false);
    expect(late.violations).toHaveLength(1);
    expect(late.violations[0]).toMatch(/^rule 1: reveal window/);
  });

  it("the log scan reach holds: 135 minutes at 2-second blocks plus the 256-block marker margin is far below 100 calls of 500 blocks", () => {
    const blocks = (BASE.legA.refundAfterMin * MIN) / BASE_SEPOLIA_POLICY.blockTimeMs + 256;
    expect(blocks).toBe(4_306);
    expect(blocks).toBeLessThan(100 * 500);
  });

  it("the wall-clock cost of a refund rehearsal on this set is 285 minutes (4 h 45 min), leg B's refund time; a refund of leg A is possible from +135", () => {
    expect(BASE.legB.refundAfterMin).toBe(285);
    expect(BASE.legB.refundAfterMin / 60).toBe(4.75);
    expect(BASE.legA.refundAfterMin + BASE_SEPOLIA_POLICY.finalityAMs / MIN).toBeLessThan(BASE.legB.refundAfterMin); // leg A's refund reads final before leg B's refund time
  });
});

describe("P9-4 decision 2: the numbers are tight where they should be (each rule breaks exactly past its slack)", () => {
  const shift = (set: KnownGoodDeadlineMinutes, change: { legA?: Partial<KnownGoodDeadlineMinutes["legA"]>; legB?: Partial<KnownGoodDeadlineMinutes["legB"]> }): KnownGoodDeadlineMinutes => ({
    legA: { ...set.legA, ...change.legA },
    legB: { ...set.legB, ...change.legB },
  });

  it("rule 2 (leg-linking): leg B's claim-by 10 minutes earlier still passes at zero slack, 11 minutes earlier breaks it", () => {
    expect(slackOf(shift(BASE, { legB: { claimByMin: 215 } }), BASE_SEPOLIA_POLICY)).toMatchObject({ ok: true, rule2: 0 });
    const broken = slackOf(shift(BASE, { legB: { claimByMin: 214 } }), BASE_SEPOLIA_POLICY);
    expect(broken.ok).toBe(false);
    expect(broken.violations).toHaveLength(1);
    expect(broken.violations[0]).toMatch(/^rule 2: legB\.claimByMs \d+ < required \d+ ms \(legA\.refundAfterMs \d+ \+ finalityAMs 4800000\)$/);
  });

  it("rule 3 (R10.2) never binds on this set: it asks leg B's refund time at +195, below the +215 floor rule 2 puts under leg B's claim-by (the refund time must follow the claim-by)", () => {
    const smallest = slackOf(shift(BASE, { legB: { claimByMin: 215, refundAfterMin: 216 } }), BASE_SEPOLIA_POLICY);
    expect(smallest).toMatchObject({ ok: true, rule2: 0, rule3: 21 });
    // the symmetry itself, written out: tOther = 125 minutes of 1-second FLOP blocks = 7,500; the 3,600-block stall allowance beats the 20 % margin (1,500)
    expect(slackOf(BASE, BASE_SEPOLIA_POLICY).rule3).toBe(90);
  });

  it("the claim margin: a claim-by 10 minutes before the refund time is the edge (zero slack)", () => {
    const edge = slackOf(shift(BASE, { legA: { refundAfterMin: 125 } }), BASE_SEPOLIA_POLICY);
    expect(edge.claimMargin).toBe(0);
    expect(BASE_SEPOLIA_POLICY.claimInclusionMarginMs).toBe((125 - 115) * MIN);
  });
});

describe("P9-4 decision 2: the flows judge the claim margin with the chain's own policy (the Seller's accept check)", () => {
  /** A Seller on a mock node pinned to `chainId`, answering an offer whose leg A claim-by is `gapMin` minutes before its refund time. */
  async function acceptWithGap(chainId: 31337 | 84532, claimByMin: number, gapMin: number): Promise<unknown> {
    const w = evmWorldWith((node) => {
      node.chainId = chainId;
    })(new Controller());
    const buyer = new BuyerFlow(w.buyerOptions());
    const seller = new SellerFlow(w.sellerOptions());
    const start = w.lockTimeMs; // the world's own clock origin (the lock is at the start here)
    const offerA = await buyer.bid({ ...w.bidParams, claimByMs: start + claimByMin * MIN, refundAfterMs: start + (claimByMin + gapMin) * MIN });
    return seller.acceptLegA(offerA, w.legB, w.lockTimeMs).then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  }

  it("Base Sepolia: a 9-minute gap is refused naming the 10-minute margin (600000 ms), a 10-minute gap is accepted", async () => {
    expect(await acceptWithGap(84532, 125, 9)).toMatch(/below the EVM claim-inclusion margin \(600000 ms\)/);
    expect(await acceptWithGap(84532, 125, 10)).toBe("accepted");
  });

  it("anvil keeps its 5-minute margin: a 4-minute gap is refused naming 300000 ms, a 5-minute gap is accepted", async () => {
    expect(await acceptWithGap(31337, 60, 4)).toMatch(/below the EVM claim-inclusion margin \(300000 ms\)/);
    expect(await acceptWithGap(31337, 60, 5)).toBe("accepted");
  });
});

describe("P9-4 decision 2: why the earlier sets are not Base Sepolia's", () => {
  it("anvil's set under the Base Sepolia policy breaks exactly the leg-linking rule: leg B's claim-by is 30 minutes after leg A's refund time, the budget asks 80", () => {
    const slack = slackOf(ANVIL, BASE_SEPOLIA_POLICY);
    expect(slack.ok).toBe(false);
    expect(slack.violations).toHaveLength(1);
    expect(slack.violations[0]).toMatch(/^rule 2: /);
    expect(slack.rule2).toBe(-50);
  });

  it("the main loop's starting point (+90/+120/+200/+260) passes the machine rules but with no slack on rule 2 and on the finality row (the adjustment above)", () => {
    const start: KnownGoodDeadlineMinutes = {
      legA: { claimByMin: 90, refundAfterMin: 120, expiresMin: 30 },
      legB: { claimByMin: 200, refundAfterMin: 260, expiresMin: 40 },
    };
    const slack = slackOf(start, BASE_SEPOLIA_POLICY);
    expect(slack.ok).toBe(true);
    expect(slack.rule2).toBe(0);
    expect(slack.finalityRow).toBe(0);
    expect(slack.pipeline).toBeLessThan(0); // and the claim pipeline does not fit once the budget, not the observed maximum, is the lag
    expect(slack.pipelineAtSampleMax).toBeGreaterThan(5); // it would against the sample's own maximum
  });
});
