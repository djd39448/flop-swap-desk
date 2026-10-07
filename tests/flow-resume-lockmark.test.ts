// SPDX-License-Identifier: MIT
//
// tests/flow-resume-lockmark.test.ts - P9-4 decision 4 (P9-4-DECISIONS-2026-10-07.md; spec P9-4 question "the Buyer's lock marker margin"): the Buyer's EVM
// lock marker is saved with a reorg margin, like the Seller's claim marker (tests/flow-resume-reorg.test.ts, R2-13).
//
// The marker is the chain tip read just before the lock is prepared, and it starts every later scan for the Seller's claim (`learnSecret`, and the scans of a
// resumed flow). A reorg that branches below that tip can re-include the lock and the claim in blocks UNDER the marker; a scan that starts at the marker then
// never sees the claim and the resumed Buyer cannot learn the secret from the chain (a Buyer that learns it from the Seller's reveal frame is unaffected).
// The Base Sepolia safe head trails the unsafe tip by up to 98 blocks in the 24-hour sample, so the margin is 256 (the Seller's number): saved marker = tip - 256,
// floored at 0, EVM only. Each test below is built on the REAL flows over the stateful mock node and fails without the margin.

import { dealRoom, tryDecodeFrame, verifyHashPreimage } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { LOCK_MARKER_REORG_MARGIN_EVM, lockMarkerWithReorgMargin } from "../src/client/buyer.js";
import { markerFromJson } from "../src/client/flow-record.js";
import { CLAIM_MARKER_REORG_MARGIN_EVM } from "../src/client/seller.js";
import { PREFIX, STEPS, readSwap } from "./helpers/crash-matrix.js";
import type { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmWorldWith } from "./helpers/matrix-worlds.js";
import { buyerRecordOf, resumedBuyer, started, type Started } from "./helpers/resume-world.js";

/** The swap through the Buyer's lock and the Seller's claim, with the reveal frame NOT posted (so the Buyer can only learn the secret from the chain). */
async function claimedWithoutReveal(configure: (node: EvmMockNode) => void): Promise<{ s: Started; node: EvmMockNode; statement: string; rawMarker: bigint }> {
  let node: EvmMockNode | undefined;
  const s = await started(
    evmWorldWith((n) => {
      configure(n);
      node = n;
    }),
    [...PREFIX, STEPS.lockLegA],
  );
  if (node === undefined) throw new Error("test: no node");
  const rawMarker = node.blockNumber - 2n; // the tip before the lock's approve and lock each mined one block
  const statement = s.c.seller.statement;
  if (statement === undefined) throw new Error("test: the Seller has no statement");
  await s.c.seller.claimLegA(statement, { skipReveal: true });
  expect(s.w.counts().claims).toBe(1);
  return { s, node, statement, rawMarker };
}

const far = (node: EvmMockNode): void => {
  node.blockNumber = 1000n; // far past the margin: the saved marker is the tip minus the margin, not the floor
};

async function learnedByResumedBuyer(s: Started, statement: string): Promise<boolean> {
  const back = await resumedBuyer(s);
  const secret = await back.flow.learnSecret().catch(() => undefined);
  return secret !== undefined && verifyHashPreimage(statement, secret);
}

describe("P9-4 decision 4: the Buyer's lock marker is saved with a reorg margin (EVM)", () => {
  it("the saved marker is the tip read before the lock minus 256 (bigint arithmetic), and it is the start of the scan the resumed Buyer makes", async () => {
    const { s, node, statement, rawMarker } = await claimedWithoutReveal(far);
    expect(rawMarker).toBe(1000n);
    const saved = markerFromJson((await buyerRecordOf(s.w)).lock.fromBlock!);
    expect(saved).toBe(rawMarker - 256n);
    node.logQueries.length = 0;
    expect(await learnedByResumedBuyer(s, statement)).toBe(true);
    expect(node.logQueries[0], "the scan starts at the saved marker").toBe(rawMarker - 256n);
  });

  it("a lock and its claim a reorg re-included 200 blocks below the marker (the tip the lock saw) are still found by the resumed Buyer", async () => {
    const { s, node, statement, rawMarker } = await claimedWithoutReveal(far);
    node.reorgLog("Locked", statement, rawMarker - 201n); // the lock sits below the marker...
    node.reorgLog("Claimed", statement, rawMarker - 200n); // ...and the claim after it, still below the marker, above the saved one (the marker minus 256)
    expect(await learnedByResumedBuyer(s, statement)).toBe(true);
  });

  it("the boundary: a claim at exactly the saved marker is found; one block below it is not (a refusal, never a wrong answer)", async () => {
    const edge = await claimedWithoutReveal(far);
    edge.node.reorgLog("Claimed", edge.statement, edge.rawMarker - 256n);
    expect(await learnedByResumedBuyer(edge.s, edge.statement)).toBe(true);

    const past = await claimedWithoutReveal(far);
    past.node.reorgLog("Claimed", past.statement, past.rawMarker - 257n);
    expect(await learnedByResumedBuyer(past.s, past.statement)).toBe(false);
  });

  it("near genesis the marker is floored at 0", async () => {
    const { s } = await claimedWithoutReveal(() => undefined); // the mock node starts at block 5
    expect(markerFromJson((await buyerRecordOf(s.w)).lock.fromBlock!)).toBe(0n);
  });

  it("on a 500-block endpoint (Base Sepolia) the resumed scan covers the margin in calls of at most 500 blocks, starting at the saved marker", async () => {
    const { s, node, statement, rawMarker } = await claimedWithoutReveal((n) => {
      n.chainId = 84532;
      n.blockNumber = 1000n;
      n.maxLogSpan = 500n; // the public endpoint's cap: a wider range is refused
    });
    node.reorgLog("Claimed", statement, rawMarker - 200n);
    node.logRanges.length = 0;
    expect(await learnedByResumedBuyer(s, statement)).toBe(true);
    expect(node.logRanges.length).toBeGreaterThanOrEqual(1);
    expect(node.logRanges[0]?.from).toBe(rawMarker - 256n);
    for (const range of node.logRanges) expect(range.to - range.from + 1n, "no call is wider than the endpoint's cap").toBeLessThanOrEqual(500n);
  });

  it("a Buyer that reads the Seller's reveal frame does not scan at all (the margin changes nothing for it)", async () => {
    const { s, node, statement } = await claimedWithoutReveal(far);
    const contractA = (await readSwap(s.w)).acceptA!.contract;
    // post the Seller's reveal the ordinary way: the Buyer takes the secret from it
    await s.c.seller.claimLegA(statement); // recognised from the chain: the missing reveal and receipt are posted now
    const records = await s.w.venue.read(dealRoom(contractA));
    expect(records.some((record) => tryDecodeFrame(record.line)?.type === "reveal")).toBe(true);
    node.logQueries.length = 0;
    expect(await learnedByResumedBuyer(s, statement)).toBe(true);
    expect(node.logQueries, "no log query: the frame answered").toEqual([]);
  });
});

describe("P9-4 decision 4: lockMarkerWithReorgMargin", () => {
  it("the margin is the Seller's 256: above the sample's largest safe-head lag (98 blocks), under the endpoint's 500-block range", () => {
    expect(LOCK_MARKER_REORG_MARGIN_EVM).toBe(256);
    expect(LOCK_MARKER_REORG_MARGIN_EVM).toBe(CLAIM_MARKER_REORG_MARGIN_EVM);
    expect(LOCK_MARKER_REORG_MARGIN_EVM).toBeGreaterThan(98);
    expect(LOCK_MARKER_REORG_MARGIN_EVM).toBeLessThan(500);
  });

  it("subtracts the margin from an EVM marker (bigint), floors at 0, and leaves every other marker alone", () => {
    expect(lockMarkerWithReorgMargin(1000n)).toBe(744n);
    expect(lockMarkerWithReorgMargin(257n)).toBe(1n);
    expect(lockMarkerWithReorgMargin(256n)).toBe(0n);
    expect(lockMarkerWithReorgMargin(255n)).toBe(0n);
    expect(lockMarkerWithReorgMargin(0n)).toBe(0n);
    expect(lockMarkerWithReorgMargin(2n ** 80n)).toBe(2n ** 80n - 256n); // no precision is lost
    // Bitcoin heights, NEAR heights and Solana slots are numbers: unchanged (their margins, where they have one, are the Seller's)
    for (const other of [700, 7, 0, 1.5, -1, -5n, "12", undefined, null]) expect(lockMarkerWithReorgMargin(other)).toBe(other);
  });
});
