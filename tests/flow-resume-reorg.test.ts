// SPDX-License-Identifier: MIT
//
// R2-13 (P8-FIXES-R2.md): the Seller's claim block marker is saved with a reorg margin. R1-13 made a resumed claimLegA look for its own claim from a
// block marker saved with the attempt (the chain tip when the first claim was about to be sent) instead of from genesis. A reorg that branches
// BELOW that tip can mine the claim into a block under the marker: the bounded scan starting at the marker never sees the Seller's own landed claim, its
// reveal and receipt are never posted, and a new claim is refused (the output is spent). The marker is therefore saved as the tip minus
// CLAIM_MARKER_REORG_MARGIN_BTC (6) on Bitcoin or CLAIM_MARKER_REORG_MARGIN_EVM (64) on EVM, floored at 0 (bigint arithmetic on EVM).
//
// Each world cuts the Seller right after the claim's send (the claim is on chain, its outcome unsaved), simulates the reorg (the claim now sits one block
// below the raw marker), and resumes: claimLegA must find the claim, post the reveal and the receipt, and send nothing.

import { dealRoom, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { markerFromJson } from "../src/client/flow-record.js";
import { CLAIM_MARKER_REORG_MARGIN_BTC, CLAIM_MARKER_REORG_MARGIN_EVM, SellerFlow, claimMarkerWithReorgMargin } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, readSwap, runScript, type Ctx, type World, type WorldFactory } from "./helpers/crash-matrix.js";
import type { EvmMockNode } from "./helpers/evm-mock-node.js";
import type { LedgerChain } from "./helpers/ledger-rail.js";
import { evmWorldWith, ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { sellerContractA } from "./helpers/seller-key.js";
import { sellerRecordOf } from "./helpers/resume-world.js";

/** The number of the Seller's claim send in a reference run (`what` is the world's own label for it). */
async function claimSendNumber(factory: WorldFactory, what: string): Promise<number> {
  const reference = await runScript(factory, [...PREFIX, STEPS.lockLegA, STEPS.claimLegA], []);
  const action = reference.world.ctl.actions.find((candidate) => candidate.role === "seller" && candidate.what === what);
  if (action === undefined) throw new Error(`no seller action ${what}: ${reference.world.ctl.actions.map((a) => `${a.role}:${a.what}`).join(",")}`);
  return action.n;
}

/** Runs the swap to the Seller's claim and kills the Seller right after the send (the store write after it is refused). */
async function cutAfterClaimSend(factory: WorldFactory, what: string): Promise<{ w: World; c: Ctx; statement: string }> {
  const n = await claimSendNumber(factory, what);
  const ctl = new Controller([{ n, mode: "after-store-fail" }]);
  const w = factory(ctl);
  ctl.attachStore(w.stores.buyer, "buyer");
  ctl.attachStore(w.stores.seller, "seller");
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of [...PREFIX, STEPS.lockLegA]) await step.run(c);
  const statement = seller.statement;
  if (statement === undefined) throw new Error("the Seller has no statement");
  await seller.claimLegA(statement).catch(() => undefined);
  expect(ctl.isDead("seller"), "the Seller died right after the claim send").toBe(true);
  expect(w.counts().claims, "the claim is on chain").toBe(1);
  return { w, c, statement };
}

async function resumeSeller(w: World): Promise<{ flow: SellerFlow; next: string }> {
  w.ctl.restart("seller");
  return SellerFlow.resume({ ...w.sellerOptions(), store: w.stores.seller, swapId: w.swapId, contractA: await sellerContractA(w.stores.seller) });
}

async function framesIn(w: World, room: string, type: string): Promise<number> {
  return (await w.venue.read(room)).filter((record) => tryDecodeFrame(record.line)?.type === type).length;
}

/** The resumed Seller finds the claim, posts reveal and receipt once, and sends nothing. */
async function expectFoundAndFinished(w: World, statement: string): Promise<void> {
  const back = await resumeSeller(w);
  expect(back.next).toBe("claimLegA");
  const result = await back.flow.claimLegA(statement);
  expect(result.receipt).toBeDefined();
  expect(w.counts().claims, "nothing is claimed twice").toBe(1);
  const contractA = (await readSwap(w)).acceptA!.contract;
  expect(await framesIn(w, dealRoom(contractA), "reveal")).toBe(1);
  expect(await framesIn(w, dealRoom(contractA), "receipt")).toBe(1);
  expect((await resumeSeller(w)).next).toBe("done");
}

describe("R2-13 (EVM): a claim a reorg mined below the raw marker is still found by the resumed claimLegA", () => {
  /** The swap cut right after the claim send on a chain far past the margin; `rawMarker` is the tip read before the send (the send mined the next block). */
  async function cutOnEvm(): Promise<{ w: World; statement: string; node: EvmMockNode; rawMarker: bigint }> {
    let node: EvmMockNode | undefined;
    const factory = evmWorldWith((n) => {
      n.blockNumber = 1000n; // far past the margin: the saved marker is the tip minus 64, not the floor
      node = n;
    });
    const { w, statement } = await cutAfterClaimSend(factory, "chain:claim");
    if (node === undefined) throw new Error("test: no node");
    return { w, statement, node, rawMarker: node.blockNumber - 1n };
  }

  it("the claim moved one block below the raw marker (a reorg) is found: reveal and receipt are posted, no second claim", async () => {
    const { w, statement, node, rawMarker } = await cutOnEvm();
    node.reorgLog("Claimed", statement, rawMarker - 1n);
    await expectFoundAndFinished(w, statement);
  });

  it("the boundary: a claim at exactly rawMarker - 64 is found", async () => {
    const { w, statement, node, rawMarker } = await cutOnEvm();
    node.reorgLog("Claimed", statement, rawMarker - BigInt(CLAIM_MARKER_REORG_MARGIN_EVM));
    await expectFoundAndFinished(w, statement);
  });

  it("the saved marker is the tip read before the send minus 64 (bigint arithmetic)", async () => {
    const { w, rawMarker } = await cutOnEvm();
    expect(markerFromJson((await sellerRecordOf(w)).claimFromBlock!)).toBe(rawMarker - 64n);
  });

  it("near genesis the marker is floored at 0", async () => {
    const { w } = await cutAfterClaimSend(evmWorldWith(() => undefined), "chain:claim"); // the mock node starts at block 5
    expect(markerFromJson((await sellerRecordOf(w)).claimFromBlock!)).toBe(0n);
  });
});

describe("R2-13 (Bitcoin ledger world): a claim a reorg mined below the raw marker height is still found", () => {
  async function cutOnBitcoin(height: number): Promise<{ w: World; statement: string; chain: LedgerChain }> {
    let chain: LedgerChain | undefined;
    const { w, statement } = await cutAfterClaimSend(ledgerWorldWith("btc", (c) => ((chain = c), (c.height = height))), "chain:claim.send");
    if (chain === undefined) throw new Error("test: no chain");
    return { w, statement, chain };
  }

  it("the claim at one block below the raw marker height (a reorg) is found by a scan that starts at the saved marker", async () => {
    const { w, statement, chain } = await cutOnBitcoin(700);
    const output = [...chain.outputs.values()][0];
    if (output === undefined) throw new Error("test: no output");
    expect(output.claimHeight, "the claim was mined at the tip").toBe(700);
    output.claimHeight = 699; // the reorg: below the raw marker 700
    chain.scanFrom.length = 0;
    await expectFoundAndFinished(w, statement);
    expect(chain.scanFrom, "the scan started at the saved marker").toEqual([700 - CLAIM_MARKER_REORG_MARGIN_BTC]);
  });

  it("the saved marker is the tip height minus 6", async () => {
    const { w } = await cutOnBitcoin(700);
    expect((await sellerRecordOf(w)).claimFromBlock).toEqual({ kind: "number", value: "694" });
  });

  it("near genesis the marker is floored at 0", async () => {
    const { w } = await cutOnBitcoin(3);
    expect((await sellerRecordOf(w)).claimFromBlock).toEqual({ kind: "number", value: "0" });
  });
});

describe("R2-13: claimMarkerWithReorgMargin", () => {
  it("subtracts the margin of the marker's kind and floors at 0; anything that is not a marker is left for the save to refuse", () => {
    expect(CLAIM_MARKER_REORG_MARGIN_BTC).toBe(6);
    expect(CLAIM_MARKER_REORG_MARGIN_EVM).toBe(64);
    expect(claimMarkerWithReorgMargin(1000n)).toBe(936n);
    expect(claimMarkerWithReorgMargin(65n)).toBe(1n);
    expect(claimMarkerWithReorgMargin(64n)).toBe(0n);
    expect(claimMarkerWithReorgMargin(63n)).toBe(0n);
    expect(claimMarkerWithReorgMargin(0n)).toBe(0n);
    expect(claimMarkerWithReorgMargin(2n ** 80n)).toBe(2n ** 80n - 64n); // bigint arithmetic: no precision is lost
    expect(claimMarkerWithReorgMargin(700)).toBe(694);
    expect(claimMarkerWithReorgMargin(7)).toBe(1);
    expect(claimMarkerWithReorgMargin(6)).toBe(0);
    expect(claimMarkerWithReorgMargin(5)).toBe(0);
    expect(claimMarkerWithReorgMargin(0)).toBe(0);
    for (const odd of [1.5, -1, -5n, Number.MAX_SAFE_INTEGER + 2, "12", undefined, null]) expect(claimMarkerWithReorgMargin(odd)).toBe(odd);
  });
});
