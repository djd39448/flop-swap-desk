// SPDX-License-Identifier: MIT
//
// tests/flow-resume-validate.test.ts - P8-RESUME-SPEC.md rules 1 and 6 at the flows' own surface:
//   - `resume` validates the stored record against the runner's objects and fails closed with a typed error (no record, a damaged one,
//     another version, another DID, rail, chain or contract, frames that do not add up); it never starts over from an empty state;
//   - a NEW flow never overwrites a swap that already has a record (the runner must `resume`);
//   - durable before visible: when the store refuses to save an intent, the outward action it announces does not happen.
// Runs on the Solana stateful harness with a `MemoryFlowStore` (fault injection) and, for the rail pin, an EVM rail object.

import { tryDecodeFrame, type AcceptFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow, LockPendingError } from "../src/client/buyer.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import {
  FlowRecordMismatchError,
  FlowRecordVersionError,
  decodeFlowRecord,
  encodeFlowRecord,
  type FlowRecord,
} from "../src/client/flow-record.js";
import { FlowNotFoundError, FlowRecordExistsError } from "../src/client/flow-resume.js";
import { FlowStoreCorruptError, FlowStoreFaultError, flowKey } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { ANVIL_LOCAL_PIN } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { bid, bidParams, framesOf, isFrame, legA, restartBuyer, restartSeller, rig, toLines, toLocked, toPaired, type Rig } from "./helpers/resume-sol-rig.js";
import { framesIn, legBDeadlines } from "./helpers/sol-flow-harness.js";
import { dealRoom } from "@flop-labs/tclk";

/** Reads a stored record, lets `edit` change it, and stores the result again (valid shape, valid checksum). */
async function tamper(r: Rig, role: "buyer" | "seller", edit: (record: Record<string, unknown>) => void): Promise<void> {
  const key = flowKey(role, r.swapId);
  const store = role === "buyer" ? r.buyerStore : r.sellerStore;
  const record = decodeFlowRecord((await store.load(key))!, key);
  const plain = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  edit(plain);
  await store.save(key, encodeFlowRecord(plain as unknown as FlowRecord));
}

/** An EVM rail that is never called (resume reads the store only): only its ids matter. */
function evmRail(r: Rig) {
  const never = new CapturingRpc({
    endpoint: "http://never.invalid",
    fetch: (async () => {
      throw new Error("test: resume must not touch the chain");
    }) as unknown as typeof fetch,
  });
  return createEvmCounterRail({
    config: { pin: ANVIL_LOCAL_PIN, endpoint: "http://never.invalid", contract: "0x00000000000000000000000000000000000000aa", assets: { USDC: "0x00000000000000000000000000000000000000bb" } },
    rpc: never,
    account: "0x00000000000000000000000000000000000000cc",
    clock: r.h.clock,
  });
}

describe("resume fails closed on bad state (rule 6)", () => {
  it("nothing stored under the key: a typed FlowNotFoundError for both roles, never an empty flow", async () => {
    const r = rig();
    await expect(restartBuyer(r)).rejects.toBeInstanceOf(FlowNotFoundError);
    await expect(restartSeller(r)).rejects.toBeInstanceOf(FlowNotFoundError);
  });

  it("a damaged record (a flipped byte) is a FlowStoreCorruptError, and a new flow does not overwrite it", async () => {
    const r = rig();
    await toPaired(r);
    const key = flowKey("buyer", r.swapId);
    const bytes = (await r.buyerStore.load(key))!;
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    await r.buyerStore.save(key, bytes);
    await expect(restartBuyer(r)).rejects.toBeInstanceOf(FlowStoreCorruptError);
    // starting the swap over on top of it is refused too (the record is there, even if unreadable)
    const fresh = new BuyerFlow(r.h.buyerOptions);
    await expect(fresh.bid(bidParams(r))).rejects.toBeInstanceOf(FlowRecordExistsError);
  });

  it("a record from another version is a FlowRecordVersionError", async () => {
    const r = rig();
    await toPaired(r);
    const key = flowKey("seller", r.swapId);
    const text = new TextDecoder().decode((await r.sellerStore.load(key))!).replace('{"v":1,', '{"v":2,');
    await r.sellerStore.save(key, new TextEncoder().encode(text));
    await expect(restartSeller(r)).rejects.toBeInstanceOf(FlowRecordVersionError);
  });

  it("a record stored under the other role's key is a FlowRecordMismatchError", async () => {
    const r = rig();
    await toPaired(r);
    await r.buyerStore.save(flowKey("buyer", r.swapId), (await r.sellerStore.load(flowKey("seller", r.swapId)))!);
    const error = await restartBuyer(r).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe("role");
  });

  it("another DID is refused: a Buyer record resumed by the Seller's identity, and the other way round", async () => {
    const r = rig();
    await toPaired(r);
    const asSeller = await restartBuyer(r, { identity: r.h.seller }).catch((e: unknown) => e);
    expect(asSeller).toBeInstanceOf(FlowRecordMismatchError);
    expect((asSeller as FlowRecordMismatchError).field).toBe("did");
    const asBuyer = await restartSeller(r, { identity: r.h.buyer }).catch((e: unknown) => e);
    expect(asBuyer).toBeInstanceOf(FlowRecordMismatchError);
    expect((asBuyer as FlowRecordMismatchError).field).toBe("did");
  });

  it("another rail or chain is refused: an EVM rail over a Solana record, and a record whose chain id was changed", async () => {
    const r = rig();
    await toPaired(r);
    const wrongRail = await restartBuyer(r, { rail: evmRail(r) }).catch((e: unknown) => e);
    expect(wrongRail).toBeInstanceOf(FlowRecordMismatchError);
    expect((wrongRail as FlowRecordMismatchError).field).toBe("railId");
    await tamper(r, "seller", (record) => void (record.caip2 = "solana:somewhere-else"));
    const wrongChain = await restartSeller(r).catch((e: unknown) => e);
    expect(wrongChain).toBeInstanceOf(FlowRecordMismatchError);
    expect((wrongChain as FlowRecordMismatchError).field).toBe("caip2");
  });

  it("the runner's own contract ids are pinned: a different contract A or B is refused", async () => {
    const r = rig();
    const p = await toPaired(r);
    const other = `0x${"cd".repeat(32)}`;
    const a = await restartBuyer(r, { contractA: other }).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(FlowRecordMismatchError);
    expect((a as FlowRecordMismatchError).field).toBe("contractA");
    const b = await restartSeller(r, { contractB: other }).catch((e: unknown) => e);
    expect(b).toBeInstanceOf(FlowRecordMismatchError);
    expect((b as FlowRecordMismatchError).field).toBe("contractB");
    // the right ids pass
    await expect(restartBuyer(r, { contractA: p.contractA, contractB: p.contractB })).resolves.toBeDefined();
  });

  it("frames that do not add up are refused although the record is well formed: a contract id that is not the one the frames derive", async () => {
    const r = rig();
    await toPaired(r);
    await tamper(r, "buyer", (record) => void (record.contractA = `0x${"ee".repeat(32)}`));
    const error = await restartBuyer(r).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe("contractA");
  });

  it("an accept B that is not this Buyer's is refused", async () => {
    const r = rig();
    await toPaired(r);
    // swap the stored accept B text for the Seller's accept A text (a well-formed accept frame, from someone else)
    const acceptAText = (await r.h.venue.read("tclk-offers")).map((rec) => rec.line).find((line) => isFrame(line, "accept") && (tryDecodeFrame(line) as AcceptFrame).from === r.h.seller.did)!;
    await tamper(r, "buyer", (record) => {
      const frames = record.frames as Record<string, { text: string; record?: unknown }>;
      frames.acceptB = { text: acceptAText };
    });
    await expect(restartBuyer(r)).rejects.toBeInstanceOf(FlowStoreCorruptError);
  });
});

describe("a new flow never overwrites a stored swap", () => {
  it("bid and acceptLegA over an existing record are refused (resume is the way back in), and nothing is posted", async () => {
    const r = rig();
    const p = await toPaired(r);
    const offersBefore = (await r.h.venue.read("tclk-offers")).length;
    const freshBuyer = new BuyerFlow(r.h.buyerOptions);
    await expect(freshBuyer.bid(bidParams(r))).rejects.toBeInstanceOf(FlowRecordExistsError);
    const freshSeller = new SellerFlow(r.h.sellerOptions);
    await expect(freshSeller.acceptLegA(p.offerA, legBDeadlines(), legA.lockTimeMs)).rejects.toBeInstanceOf(FlowRecordExistsError);
    expect((await r.h.venue.read("tclk-offers")).length).toBe(offersBefore);
  });
});

describe("durable before visible: when the intent cannot be saved, the action does not happen (rule 1)", () => {
  it("the Seller's secret and accept A: if the first save fails, accept A is never posted (the statement stays private)", async () => {
    const r = rig();
    const offerA = await bid(r);
    r.sellerStore.failSave(1, "reject");
    await expect(r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs)).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept")).toHaveLength(0);
  });

  it("the Buyer's prepared lock: if the save before commitLock fails, nothing is sent; the next call starts clean", async () => {
    const r = rig();
    await toLines(r);
    r.buyerStore.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      return record.role === "buyer" && record.lock.prepared !== undefined && record.lock.evidence === undefined ? "reject" : undefined;
    });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(r.h.node.sent.lock).toBe(0);
    // the failed save was kept in memory as an intent; the same call now recovers: the signed lock was never sent, so it is pending
    r.buyerStore.clearFaults();
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(LockPendingError);
    expect(r.h.node.sent.lock).toBe(0);
  });

  it("the Seller's claim signature: if the save that carries it fails, the claim is not sent (nothing leaks)", async () => {
    const r = rig();
    await toLocked(r);
    r.sellerStore.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      return record.role === "seller" && record.claimRecords.length > 0 ? "reject" : undefined;
    });
    await expect(r.seller.claimLegA(r.seller.statement!)).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(r.h.node.sent.claim).toBe(0);
  });

  it("the Seller's claimAttempted flag: if its save fails, the claim is not even signed", async () => {
    const r = rig();
    await toLocked(r);
    r.sellerStore.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      return record.role === "seller" && record.claimAttempted ? "reject" : undefined;
    });
    await expect(r.seller.claimLegA(r.seller.statement!)).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(r.h.node.sent.claim).toBe(0);
    expect((await r.h.venue.read("tclk-offers")).length).toBeGreaterThan(0);
  });

  it("the Buyer's refund intent: if its save fails, no refund is signed or sent", async () => {
    const r = rig();
    await toLocked(r);
    r.h.setTime(legA.refundAfterMs);
    r.buyerStore.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      return record.role === "buyer" && record.refund.attempted ? "reject" : undefined;
    });
    await expect(r.buyer.refundLegA()).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(r.h.node.sent.refund).toBe(0);
  });

  it("a frame's text: if the ledger save fails, the frame is not posted (here the lock frame, after the lock landed)", async () => {
    const r = rig();
    const p = await toLines(r);
    r.buyerStore.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      return record.ledger.some((entry) => entry.kind === "lock-a") ? "reject" : undefined;
    });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(FlowStoreFaultError);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(0);
    expect(r.h.node.sent.lock).toBe(1); // the lock is on chain: recovery, not a second lock
    r.buyerStore.clearFaults();
    await restartBuyer(r);
    await r.buyer.lockLegA();
    expect(r.h.node.sent.lock).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });

  it("the write landed but the store's confirmation was lost (commit-then-throw): the next call goes through recovery, never a second action", async () => {
    const r = rig();
    const p = await toLines(r);
    r.buyerStore.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      return record.role === "buyer" && record.lock.evidence !== undefined && !record.lock.framePosted ? "commit-then-throw" : undefined;
    });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(FlowStoreFaultError);
    r.buyerStore.clearFaults();
    await restartBuyer(r); // the stored record is the one whose confirmation was lost: evidence recorded, frame not posted
    await r.buyer.lockLegA();
    expect(r.h.node.sent.lock).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
  });
});
