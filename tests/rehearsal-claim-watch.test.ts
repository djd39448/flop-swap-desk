// SPDX-License-Identifier: MIT
//
// P94-FUND-01 (P9-FIXES-R4 decision 1), the runner's part, end to end against a REAL Seller on the stateful mock node: the claim of leg A is accepted into the node's pool and never
// mined (`holdNextSend`), its receipt wait runs for 2.5 s, and the runner's own pieces (the claim watch that `runRehearsal` hands the Seller as `onClaimSent`, and the sentence that
// ends the run) are driven exactly as the runner drives them. Nothing about the flow is mocked; only the wire is fake. What is pinned: 900 ms into the wait the Seller's record holds the
// claim's hash and the runner's output holds "claim of leg A sent: tx 0x<hash>"; while the wait lasts the runner prints "still not mined, N min before leg A's refund time" with N from
// its clock; the line stops with the wait; the first run's timeout and a resumed Seller's ClaimPendingError both end with one sentence that names the hash, the minutes left and the
// by-hand step; and neither the preimage nor a key is in any line. (The pieces alone: tests/rehearsal-run.test.ts; the runner as a process on a real node: tests-anvil.)
//
// Keys here are generated now, only ever scanned for (a boolean), and never printed.

import { readFile } from "node:fs/promises";

import { MemoryNoteStore, PaperRail } from "@flop-labs/tclk";
import { getAddress, keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import { BuyerFlow, type BidParams } from "../src/client/buyer.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { decodeFlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import { MemoryFlowStore, flowKey } from "../src/client/flow-store.js";
import { knownGoodDeadlinesFor } from "../src/client/policy.js";
import { createClaimWatch, pendingWriteRefusal } from "../src/client/rehearsal-run.js";
import { ClaimPendingError, SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { EvmReceiptTimeoutError } from "../src/rails/evm-htlc.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { localSigningRpc, makeLocalAccountWithScan } from "./helpers/evm-local.js";
import { identity } from "./helpers/identity.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const RAIL = getAddress(`0x${Buffer.from("p94-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("p94-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const TICK = /^still not mined, [0-9]+ min before leg A's refund time$/;
const FIXED = /^(claim of leg A sent: tx 0x[0-9a-f]{64}|still not mined, [0-9]+ min before leg A's refund time)$/;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const caught = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

/** Waits (really) until `test` holds, for at most `ms`. */
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (test()) return true;
    await pause(20);
  }
  return test();
}

/**
 * Both parties over one mock node (anvil's known-good deadline set: leg A claim-by +60 min, refund +90), through the pairing, leg B's paper lock and both account lines. The Seller is
 * given the runner's claim watch as `onClaimSent`, with a tick of 250 ms (the runner's is a minute). `lines` is the runner's output.
 */
async function rig(receiptTimeoutMs: number) {
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const set = knownGoodDeadlinesFor(31337);
  const at = (minutes: number): number => T0 + minutes * MIN;
  const dead = {
    legA: { claimByMs: at(set.legA.claimByMin), refundAfterMs: at(set.legA.refundAfterMin), expiresMs: at(set.legA.expiresMin) },
    legB: { claimByMs: at(set.legB.claimByMin), refundAfterMs: at(set.legB.refundAfterMin), expiresMs: at(set.legB.expiresMin) },
  };
  const node = new EvmMockNode(clock, RAIL, TOKEN, []);
  node.configExtras = { receiptTimeoutMs };
  const buyerKey = await makeLocalAccountWithScan();
  const sellerKey = await makeLocalAccountWithScan();
  const buyerWire = localSigningRpc(node);
  const sellerWire = localSigningRpc(node);
  const lines: string[] = [];
  /** P10 B6: what both rails reported through `onWarning` (the runner passes its error stream there). */
  const warnings: string[] = [];
  const watch = createClaimWatch({ log: (line) => void lines.push(line), clock, refundAfterMs: dead.legA.refundAfterMs, tickMs: 250 });
  const buyerId = identity("61".repeat(32));
  const sellerId = identity("62".repeat(32));
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const stores = { buyer: new MemoryFlowStore(), seller: new MemoryFlowStore() };
  const sellerOptions = () => ({
    identity: sellerId,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config: node.config(), rpc: sellerWire.rpc, account: sellerKey.account, clock, onWarning: (text) => void warnings.push(text) }),
    clock,
    store: stores.seller,
    onClaimSent: watch.onClaimSent,
  });
  const buyer = new BuyerFlow({
    identity: buyerId,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config: node.config(), rpc: buyerWire.rpc, account: buyerKey.account, clock, onWarning: (text) => void warnings.push(text) }),
    clock,
    store: stores.buyer,
  });
  const seller = new SellerFlow(sellerOptions());
  const swapId = computeSwapId(buyerId.did, "000000b6");
  const bid: BidParams = { swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...dead.legA };
  const offerA = await buyer.bid(bid);
  const { acceptA, acceptARecord, offerBRecord } = await seller.acceptLegA(offerA, dead.legB, T0);
  const { acceptBRecord } = await buyer.acceptLegB(offerBRecord, acceptARecord, T0);
  await seller.lockLegB(acceptBRecord);
  await buyer.verifyLegBLocked();
  await seller.postAccountLineA(sellerKey.account.address);
  await buyer.postAccountLineA(buyerKey.account.address);
  const lockA = await buyer.lockLegA();
  const record = async (): Promise<SellerFlowRecord> => {
    const key = flowKey("seller", acceptA.contract);
    return decodeFlowRecord((await stores.seller.load(key))!, key) as SellerFlowRecord;
  };
  return { node, seller, sellerWire, stores, swapId, sellerOptions, acceptA, lockA, lines, warnings, watch, clockRef, clock, record, refundAfterMs: dead.legA.refundAfterMs, leaks: (text: string) => buyerKey.leaks(text) || sellerKey.leaks(text) };
}

describe("P94-FUND-01 (runner part, end to end): a claim the node accepts and never mines is shown while its receipt wait runs", () => {
  it("the review's case: 900 ms into the wait the record holds the hash and the output holds 'claim of leg A sent: tx <hash>', then a line a minute (here every 250 ms) with the minutes from the runner's clock, until the wait ends; then one sentence", async () => {
    const r = await rig(2_500);
    r.node.holdNextSend("claim"); // the claim, with its preimage, is accepted into the pool and never mined
    let ended = false;
    // The runner's claim loop: the watch is stopped when the call returns or throws.
    const claiming = caught(r.seller.claimLegA(r.lockA.hashLock)).then((error) => {
      r.watch.stop();
      ended = true;
      return error;
    });
    await pause(900);
    expect(ended, "the receipt wait is still running").toBe(false);
    const held = r.node.held[0]!.txHash;
    expect(r.sellerWire.rawSends.length).toBe(1);
    expect((await r.record()).claimTxHash).toBe(held); // today: undefined until the wait ends
    expect(r.lines[0]).toBe(`claim of leg A sent: tx ${held}`); // today: nothing at all
    expect(await until(() => r.lines.some((line) => TICK.test(line)), 600)).toBe(true);
    expect(r.lines.find((line) => TICK.test(line))).toBe("still not mined, 90 min before leg A's refund time"); // anvil's leg A refund time is +90 min; the runner's clock is at the start

    // The runner's clock moves ten minutes: the next line says 80.
    r.clockRef.ms = T0 + 10 * MIN;
    expect(await until(() => r.lines.includes("still not mined, 80 min before leg A's refund time"), 1_000)).toBe(true);
    expect(ended, "still inside the wait").toBe(false);

    const error = await claiming;
    expect(error).toBeInstanceOf(EvmReceiptTimeoutError);
    expect((error as EvmReceiptTimeoutError).write).toBe("claim");
    expect((error as EvmReceiptTimeoutError).hash).toBe(held);
    // The line ended with the wait: nothing more is printed.
    const printed = r.lines.length;
    await pause(700);
    expect(r.lines.length).toBe(printed);
    for (const line of r.lines) expect(FIXED.test(line), line).toBe(true);
    expect(r.lines.filter((line) => line.startsWith("claim of leg A sent")).length).toBe(1);

    // The run ends with ONE sentence that carries the public hash, the minutes left, the by-hand step; no preimage anywhere.
    const sentence = pendingWriteRefusal(error, { refundAfterMs: r.refundAfterMs, nowMs: r.clock() }) ?? "";
    expect(sentence).toContain(`(tx ${held})`);
    expect(sentence).toContain("80 min before leg A's refund time");
    expect(sentence).toContain("speed the claim up by hand with the same nonce and a higher fee from a wallet that holds the key file's key");
    expect(sentence).toContain(`before leg A's refund time at ${new Date(r.refundAfterMs).toISOString()} (README, "A stuck claim is not re-priced"), then run --resume again; nothing new was signed`);
    const preimage = (await r.record()).preimage;
    expect([...r.lines, sentence].some((text) => text.includes(preimage) || text.includes(preimage.replace(/^0x/, "")))).toBe(false);
    expect([...r.lines, sentence].some((text) => r.leaks(text))).toBe(false);
  });

  it("a resumed Seller whose saved claim the node still holds ends with the same sentence (ClaimPendingError), prints no 'sent' line (nothing is broadcast) and signs nothing", async () => {
    const r = await rig(1_500);
    r.node.holdNextSend("claim");
    const first = await caught(r.seller.claimLegA(r.lockA.hashLock));
    r.watch.stop();
    expect(first).toBeInstanceOf(EvmReceiptTimeoutError);
    const held = r.node.held[0]!.txHash;
    const linesAfterFirst = r.lines.length;
    const sends = r.sellerWire.rawSends.length;

    // The node now answers about the hash (it holds the transaction, unmined): a fresh process resumes the Seller from its record.
    r.node.answerTxByHash = true;
    r.sellerWire.byHash = "node";
    r.clockRef.ms = T0 + 30 * MIN;
    const resumed = await SellerFlow.resume({ ...r.sellerOptions(), swapId: r.swapId, contractA: r.acceptA.contract });
    const again = await caught(resumed.flow.claimLegA(r.lockA.hashLock));
    r.watch.stop();
    expect(again).toBeInstanceOf(ClaimPendingError);
    expect((again as ClaimPendingError).status).toBe("pending");
    expect(r.sellerWire.rawSends.length, "no second claim was signed").toBe(sends);
    expect(r.lines.length, "nothing was broadcast, so no 'sent' line").toBe(linesAfterFirst);

    const sentence = pendingWriteRefusal(again, { refundAfterMs: r.refundAfterMs, nowMs: r.clock() }) ?? "";
    expect(sentence).toContain(`(tx ${held})`);
    expect(sentence).toContain("60 min before leg A's refund time"); // +90 min refund, the clock at +30
    expect(sentence).toContain("speed the claim up by hand with the same nonce and a higher fee from a wallet that holds the key file's key");
    expect(sentence).toContain("then run --resume again; nothing new was signed");
    expect(sentence).not.toContain("claimLegA()");
    // The same error without the runner's clock still carries the hash, the minutes (the Seller's own) and the step.
    const own = pendingWriteRefusal(again) ?? "";
    expect(own).toContain(`(tx ${held})`);
    expect(own).toContain("60 min before leg A's refund time");
    const preimage = (await r.record()).preimage;
    expect(sentence.includes(preimage) || own.includes(preimage)).toBe(false);
  });

  it("past leg A's refund time the sentence says the claim can no longer land and does not advise a speed-up", async () => {
    const r = await rig(1_200);
    r.node.holdNextSend("claim");
    const first = await caught(r.seller.claimLegA(r.lockA.hashLock));
    r.watch.stop();
    expect(first).toBeInstanceOf(EvmReceiptTimeoutError);
    const held = r.node.held[0]!.txHash;
    const sentence = pendingWriteRefusal(first, { refundAfterMs: r.refundAfterMs, nowMs: r.refundAfterMs + 5 * MIN }) ?? "";
    expect(sentence).toContain(`(tx ${held})`);
    expect(sentence).toContain(`leg A's refund time (${new Date(r.refundAfterMs).toISOString()}) has passed, so it can no longer land`);
    expect(sentence).not.toContain("speed the claim up by hand");
    expect(sentence).toContain("run --resume first");
    expect(sentence).toContain("run --refund");
  });

  // P10 B6 (runner part): the line the runner prints the moment a claim is broadcast, and the sentence that ends a run with a claim still pending, name the claim by the keccak256 of the
  // bytes the Seller signed, not by what the endpoint answered. The endpoint here answers another well-formed hash for the claim (the node still holds it under its true hash); the
  // wrong hash appears only in the warning the rail reports (the runner prints that on its error stream), once.
  it("P10 B6: an endpoint that answers the wrong hash for the claim: 'claim of leg A sent: tx <hash>', the saved hash and the ending sentence carry keccak256 of the raw claim; the wrong hash is only in the one warning", async () => {
    const r = await rig(2_500);
    r.node.holdNextSend("claim");
    r.node.answerWrongHashForNextSend("claim");
    const claiming = caught(r.seller.claimLegA(r.lockA.hashLock)).then((error) => {
      r.watch.stop();
      return error;
    });
    await pause(900);
    const computed = keccak256(r.sellerWire.rawSends[0]!.raw);
    expect(r.node.held[0]!.txHash, "the node holds the claim under its true hash").toBe(computed);
    expect(r.lines[0]).toBe(`claim of leg A sent: tx ${computed}`); // today: the endpoint's wrong hash
    expect((await r.record()).claimTxHash).toBe(computed);
    expect(r.warnings).toHaveLength(1);
    const [wrong, ...rest] = r.warnings[0]!.match(/0x[0-9a-f]{64}/g)!;
    expect(rest).toEqual([computed]);
    expect(wrong).not.toBe(computed);

    const error = await claiming;
    expect(error).toBeInstanceOf(EvmReceiptTimeoutError);
    expect((error as EvmReceiptTimeoutError).hash).toBe(computed);
    const sentence = pendingWriteRefusal(error, { refundAfterMs: r.refundAfterMs, nowMs: r.clock() }) ?? "";
    expect(sentence).toContain(`(tx ${computed})`);
    // the wrong answer is in no runner line and in no sentence: only in the rail's warning
    expect([...r.lines, sentence].some((text) => text.includes(wrong!))).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.includes(computed) && r.warnings[0]!.includes(wrong!)).toBe(true);
    const preimage = (await r.record()).preimage;
    expect([...r.lines, sentence, ...r.warnings].some((text) => text.includes(preimage) || text.includes(preimage.replace(/^0x/, "")) || r.leaks(text))).toBe(false);
  });

  it("P10 B6: the runner hands its error stream to the rails as onWarning (source pin: the warning reaches the operator, redacted like every runner line)", async () => {
    const text = await readFile(new URL("../src/client/rehearsal-run.ts", import.meta.url), "utf8");
    expect(text).toContain("account, clock, pollMs: config.pollMs, onWarning: errLine }),");
    expect(text).toContain("const errLine = (line: string): void => env.err(redact(line));");
  });
});
