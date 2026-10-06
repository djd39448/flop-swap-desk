// SPDX-License-Identifier: MIT
//
// tests/flow-resume-sell.test.ts - review round 1, the Seller's side (src/client/seller.ts):
//
//   R1-03  a refused store save is a crash of the in-memory Seller: every public step refuses until `resume()`, so a retry never sends a claim
//          the record never saw (case C of the review: the claim was sent twice-over-a-restart and the reveal and receipt never posted)
//   R1-16  overlapping calls of postAccountLineA, claimLegA and refundLegB are refused (one account line, one claim, one refund)
//   R1-09  a claim signature is recorded once, so a signer that reports it twice cannot break every later save
//   R1-02  two `acceptLegA` calls of ONE offer on one store: one accept A, and the other call is refused before it mints or posts anything
//   R1-14  the record is keyed by leg A's contract id, so an offer another DID wrote with a copied swap id cannot take the honest Seller's slot
//   R1-11  only the lock frame tclk's machine accepted for contract A stops the Seller's account line, never a stranger's
//   R1-13  a resumed claim is looked for from the block marker saved with the attempt (never from genesis), and a claim recorded as landed
//          is not searched for at all
//
// The flows are the real ones, with stores, over the EVM mock node, the Solana node and the Bitcoin ledger fake of the crash matrix.

import { OFFER_ROOM, dealRoom, encodeFrame, generateHashLock, tryDecodeFrame, type OfferFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { decodeFlowRecord, FlowRecordConflictError, FlowRecordMismatchError, markerFromJson } from "../src/client/flow-record.js";
import { FlowNotFoundError } from "../src/client/flow-resume.js";
import { FlowRecordExistsError, FlowStoreFaultError, FlowStoreWriteFailedError } from "../src/client/flow-store.js";
import { SellerFlow, RevealNotPostedError } from "../src/client/seller.js";
import { PREFIX, STEPS, readSwap } from "./helpers/crash-matrix.js";
import { identity } from "./helpers/identity.js";
import type { EvmMockNode } from "./helpers/evm-mock-node.js";
import { ledgerWorldWith, evmWorld, evmWorldWith, solWorld } from "./helpers/matrix-worlds.js";
import { ProcessDied, crashRail, failVenuePosts } from "./helpers/resume-flows.js";
import { contractsOf, resumedSeller, sellerRecordOf, started, type Started } from "./helpers/resume-world.js";
import type { LedgerChain } from "./helpers/ledger-rail.js";
import { framesIn } from "./helpers/sol-flow-harness.js";

const BEFORE_LINES = [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB, STEPS.lockLegB, STEPS.verify] as const;

/** The Seller's save of `claimAttempted` (the first save that says a claim may be on its way) is refused, like every save after it. */
function refuseClaimAttemptSaves(s: Started): void {
  s.w.stores.seller.failSaveWhen((_n, key, bytes) => {
    const record = decodeFlowRecord(bytes, key);
    return record.role === "seller" && record.claimAttempted ? "reject" : undefined;
  });
}

const framesOfType = async (s: Started, room: string, type: string): Promise<number> => framesIn(await s.w.venue.read(room), type).length;

describe("R1-03 (EVM, case C): a refused claimAttempted save is a crash; the retry sends nothing, the restart claims once and posts the frames", () => {
  it("the claim is not sent behind a refused save, in this process or by the retry; after the restart: one claim, one reveal, one receipt", async () => {
    const s = await started(evmWorld);
    const statement = s.c.seller.statement!;
    refuseClaimAttemptSaves(s);

    await expect(s.c.seller.claimLegA(statement)).rejects.toBeInstanceOf(FlowStoreFaultError); // the save is refused: nothing was sent
    expect(s.w.counts().claims).toBe(0);
    // the retry in the same process: the in-memory `claimAttempted` latch was never made durable, so it must NOT be acted on
    await expect(s.c.seller.claimLegA(statement)).rejects.toBeInstanceOf(FlowStoreWriteFailedError);
    expect(s.w.counts().claims, "before the fix the retry skipped the save and sent the claim").toBe(0);
    expect((await sellerRecordOf(s.w)).claimAttempted).toBe(false);

    s.w.stores.seller.clearFaults();
    const back = await resumedSeller(s);
    expect(back.next).toBe("claimLegA");
    await back.flow.claimLegA(statement);
    expect(s.w.counts().claims).toBe(1);
    const { contractA } = await contractsOf(s.w);
    expect(await framesOfType(s, dealRoom(contractA), "reveal")).toBe(1);
    expect(await framesOfType(s, dealRoom(contractA), "receipt")).toBe(1);
  });
});

describe("R1-03: every public step of a Seller whose save was refused refuses, and does nothing outward", () => {
  it("acceptLegA, postAccountLineA, lockLegB, reconcileLegB, claimLegA, refundLegB", async () => {
    const s = await started(evmWorld);
    const statement = s.c.seller.statement!;
    const view = await readSwap(s.w);
    refuseClaimAttemptSaves(s);
    await expect(s.c.seller.claimLegA(statement)).rejects.toBeInstanceOf(FlowStoreFaultError); // the flow is failed now
    const before = s.w.counts();
    const offersBefore = (await s.w.venue.read(OFFER_ROOM)).length;
    const { contractA, contractB } = await contractsOf(s.w);
    const roomsBefore = [(await s.w.venue.read(dealRoom(contractA))).length, (await s.w.venue.read(dealRoom(contractB))).length];
    s.w.setTime(s.w.refundAt.legB); // so no step refuses for another reason first

    const steps: Array<[string, () => Promise<unknown>]> = [
      ["acceptLegA", () => s.c.seller.acceptLegA(view.offerA!, s.w.legB, s.w.lockTimeMs)],
      ["postAccountLineA", () => s.c.seller.postAccountLineA(s.w.addresses.seller)],
      ["lockLegB", () => s.c.seller.lockLegB(view.acceptBRecord!)],
      ["reconcileLegB", () => s.c.seller.reconcileLegB()],
      ["claimLegA", () => s.c.seller.claimLegA(statement)],
      ["refundLegB", () => s.c.seller.refundLegB()],
    ];
    for (const [name, run] of steps) {
      const error = await run().then(() => undefined, (e: unknown) => e);
      expect(error, name).toBeInstanceOf(FlowStoreWriteFailedError);
    }
    expect(s.w.counts()).toEqual(before);
    expect((await s.w.venue.read(OFFER_ROOM)).length).toBe(offersBefore);
    expect([(await s.w.venue.read(dealRoom(contractA))).length, (await s.w.venue.read(dealRoom(contractB))).length]).toEqual(roomsBefore);
    expect((await s.w.paper.read(contractB))?.status, "leg B was not refunded behind the failed journal").toBe("locked");
  });
});

describe("R1-03: the store failure is reported FIRST, whatever else is wrong with the call", () => {
  it("a failed Seller answers with the store's error even to a call its own argument checks would refuse (the uniform entry rule)", async () => {
    const s = await started(evmWorld);
    const view = await readSwap(s.w);
    refuseClaimAttemptSaves(s);
    await expect(s.c.seller.claimLegA(s.c.seller.statement!)).rejects.toBeInstanceOf(FlowStoreFaultError); // the flow is failed now
    const wrong: Array<[string, () => Promise<unknown>]> = [
      ["postAccountLineA for another address than the saved one", () => s.c.seller.postAccountLineA("0x0000000000000000000000000000000000000001")],
      ["lockLegB with a record that does not authenticate", () => s.c.seller.lockLegB({ ...view.acceptBRecord!, signature: "AAAA" })],
      ["refundLegB before leg B's refund time", () => s.c.seller.refundLegB()],
      ["claimLegA with a hash lock that is not this flow's own", () => s.c.seller.claimLegA(`0x${"11".repeat(32)}`)],
    ];
    for (const [name, run] of wrong) {
      const error = await run().then(() => undefined, (e: unknown) => e);
      expect(error, name).toBeInstanceOf(FlowStoreWriteFailedError);
    }
  });

  it("reconcileLegB on a failed Seller that never tried a leg B lock reports the store failure, not 'nothing to reconcile'", async () => {
    const s = await started(evmWorld, [STEPS.bid, STEPS.acceptLegA, STEPS.acceptLegB]);
    s.w.stores.seller.failSaveWhen(() => "reject");
    await expect(s.c.seller.postAccountLineA(s.w.addresses.seller)).rejects.toBeInstanceOf(FlowStoreFaultError); // the flow is failed now
    await expect(s.c.seller.reconcileLegB()).rejects.toBeInstanceOf(FlowStoreWriteFailedError);
  });
});

describe("R1-16: overlapping calls of one Seller step are refused", () => {
  it("two postAccountLineA calls for two addresses: one line is posted and the second call throws", async () => {
    const s = await started(evmWorld, BEFORE_LINES);
    const results = await Promise.allSettled([s.c.seller.postAccountLineA(s.w.addresses.seller), s.c.seller.postAccountLineA("0x0000000000000000000000000000000000000001")]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringMatching(/already in flight/) });
    const { contractA } = await contractsOf(s.w);
    const lines = (await s.w.venue.read(dealRoom(contractA))).filter((record) => record.sender === s.w.dids.seller && tryDecodeFrame(record.line) === null);
    expect(lines).toHaveLength(1);
    expect((await sellerRecordOf(s.w)).ownAccountLine?.address).toBe(s.w.addresses.seller);
  });

  it("two claimLegA calls at once: one claim is sent and the second call throws", async () => {
    const s = await started(evmWorld);
    const statement = s.c.seller.statement!;
    const results = await Promise.allSettled([s.c.seller.claimLegA(statement), s.c.seller.claimLegA(statement)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/already in flight/);
    expect(s.w.counts().claims).toBe(1);
  });

  it("two refundLegB calls at once: leg B is refunded once and the second call throws", async () => {
    const s = await started(evmWorld, [...PREFIX, STEPS.legBRefundTime]);
    const results = await Promise.allSettled([s.c.seller.refundLegB(), s.c.seller.refundLegB()]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/already in flight/);
    const { contractB } = await contractsOf(s.w);
    expect((await s.w.paper.read(contractB))?.status).toBe("refunded");
    expect(await framesOfType(s, dealRoom(contractB), "refund")).toBe(1);
  });
});

/** A rail whose connected `claim` reports its signed record to `onSigned` TWICE (a signer that calls its recorder again). */
function reportsSignatureTwice(rail: CounterAssetRail): CounterAssetRail {
  return new Proxy(rail, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async (...args: Parameters<CounterAssetRail["connect"]>) => {
          const connected = await target.connect(...args);
          return new Proxy(connected, {
            get(inner, name, innerReceiver) {
              if (name === "claim") {
                return (ref: string, secret: string, notAfterMs: number, options?: Parameters<typeof inner.claim>[3]) => {
                  const twice =
                    options?.onSigned === undefined
                      ? options
                      : {
                          ...options,
                          onSigned: async (record: Parameters<NonNullable<NonNullable<typeof options>["onSigned"]>>[0]) => {
                            await options.onSigned?.(record);
                            await options.onSigned?.(record);
                          },
                        };
                  return inner.claim(ref, secret, notAfterMs, twice);
                };
              }
              const value: unknown = Reflect.get(inner, name, innerReceiver);
              return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(inner) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("R1-09 (Solana): a claim signature is recorded once", () => {
  it("a signer that reports the same signature twice does not break the save: the claim lands and the list is empty again", async () => {
    const s = await started(solWorld);
    await resumedSeller(s, (o) => ({ rail: reportsSignatureTwice(o.rail) }));
    const result = await s.c.seller.claimLegA(s.c.seller.statement!);
    expect(result.receipt).toBeDefined();
    const record = await sellerRecordOf(s.w);
    expect(record.claimOutcome).toBe("landed");
    expect(record.claimRecords).toEqual([]);
  });
});

describe("R1-02 (d): two acceptLegA calls of one offer on one store", () => {
  async function offerAndOptions(): Promise<{ s: Started; offerA: OfferFrame; mints: () => number; options: () => SellerFlowOptionsOf }> {
    const s = await started(evmWorld, [STEPS.bid]);
    const offerA = (await readSwap(s.w)).offerA!;
    let mints = 0;
    return {
      s,
      offerA,
      mints: () => mints,
      options: () => ({
        ...s.w.sellerOptions(),
        mintHashLock: () => {
          mints += 1;
          return generateHashLock();
        },
      }),
    };
  }
  type SellerFlowOptionsOf = ConstructorParameters<typeof SellerFlow>[0];
  const acceptA = async (s: Started): Promise<number> => framesIn(await s.w.venue.read(OFFER_ROOM), "accept").filter((r) => r.sender === s.w.dids.seller).length;

  it("at once: one accept A, one typed refusal, and the loser never minted a secret", async () => {
    const { s, offerA, mints, options } = await offerAndOptions();
    const results = await Promise.allSettled([new SellerFlow(options()).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs), new SellerFlow(options()).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refusal = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as unknown;
    expect(refusal).toBeInstanceOf(FlowRecordExistsError);
    expect(mints(), "the refused call is stopped before it mints").toBe(1);
    expect(await acceptA(s)).toBe(1);
    expect(await s.w.stores.seller.list()).toHaveLength(1);
  });

  it("in turn: the second call is refused before it mints, and the error names the stored record's key", async () => {
    const { s, offerA, mints, options } = await offerAndOptions();
    await new SellerFlow(options()).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs);
    const refusal = await new SellerFlow(options()).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FlowRecordExistsError);
    expect((refusal as FlowRecordExistsError).key).toBe((await s.w.stores.seller.list())[0]);
    expect(mints()).toBe(1);
    expect(await acceptA(s)).toBe(1);
  });
});

describe("R1-14: the Seller's record is keyed by leg A's contract id, so a copied swap id cannot take its slot", () => {
  it("another DID's offer with the same swap id gets its own record, the honest offer is still accepted, and resume by contract A returns the honest swap", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    const honest = (await readSwap(s.w)).offerA!;
    const { store: _store, ...unstored } = s.w.buyerOptions();
    const squatter = new BuyerFlow({ ...unstored, identity: identity("55".repeat(32)) });
    const copied = await squatter.bid(s.w.bidParams); // the same swap id, another Buyer
    expect(copied.job?.id).toBe(honest.job?.id);
    expect(copied.from).not.toBe(honest.from);

    const options = (): ConstructorParameters<typeof SellerFlow>[0] => ({ ...s.w.sellerOptions(), mintHashLock: () => generateHashLock() });
    const first = new SellerFlow(options());
    await first.acceptLegA(copied, s.w.legB, s.w.lockTimeMs); // the squatter's offer was accepted first
    const second = new SellerFlow(options());
    const accepted = await second.acceptLegA(honest, s.w.legB, s.w.lockTimeMs); // before the fix: FlowRecordExistsError, the slot was taken
    const keys = await s.w.stores.seller.list();
    expect(keys).toHaveLength(2);
    expect(keys).toContain(`seller:${accepted.acceptA.contract}`);

    const resumed = await SellerFlow.resume({ ...options(), store: s.w.stores.seller, contractA: accepted.acceptA.contract, swapId: s.w.swapId });
    expect(resumed.flow.recordedOfferA?.from).toBe(honest.from);
    expect(resumed.next).toBe("postAccountLineA");

    // the swap id is only a cross-check: another swap id than the stored one stops the resume
    const wrong = await SellerFlow.resume({ ...options(), store: s.w.stores.seller, contractA: accepted.acceptA.contract, swapId: `0x${"ab".repeat(32)}` }).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(FlowRecordMismatchError);
    expect((wrong as FlowRecordMismatchError).field).toBe("swapId");
    // and a contract A the store holds no record for is "not found", never a squatter's record
    await expect(SellerFlow.resume({ ...options(), store: s.w.stores.seller, contractA: `0x${"cd".repeat(32)}` })).rejects.toBeInstanceOf(FlowNotFoundError);
  });
});

describe("R1-11: a stranger's lock frame in leg A's deal room never blocks the Seller's account line", () => {
  const stranger = identity("77".repeat(32));

  it("the stranger's frame (tclk's machine rejects it) is not counted: the line posts and the Buyer locks; the Buyer's own accepted frame still blocks a late line", async () => {
    const s = await started(evmWorld, BEFORE_LINES);
    const view = await readSwap(s.w);
    const contract = view.acceptA!.contract;
    await s.w.venue.post(dealRoom(contract), encodeFrame({ type: "lock", from: stranger.did, contract, rail: "evm-htlc", ref: view.acceptA!.statement }), stranger);

    await s.c.seller.postAccountLineA(s.w.addresses.seller); // before the fix: FlowRecordConflictError, for ever
    await s.c.buyer.postAccountLineA(s.w.addresses.buyer);
    await s.c.buyer.lockLegA(); // so the Buyer's lock goes through
    expect(s.w.counts().locks).toBe(1);

    // the control: the Buyer's own lock frame (the one tclk's machine accepted) in the room before the Seller's line stops it
    const late = await started(evmWorld, BEFORE_LINES);
    const lateView = await readSwap(late.w);
    const lateContract = lateView.acceptA!.contract;
    await late.w.venue.post(
      dealRoom(lateContract),
      encodeFrame({ type: "lock", from: late.w.dids.buyer, contract: lateContract, rail: "evm-htlc", ref: lateView.acceptA!.statement }),
      late.w.buyerOptions().identity,
    );
    await expect(late.c.seller.postAccountLineA(late.w.addresses.seller)).rejects.toBeInstanceOf(FlowRecordConflictError);
  });

  it("without the offer A record (it rolled off the ring when the Seller accepted): only a lock frame from the offer's sender counts", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    const offerA = (await readSwap(s.w)).offerA!;
    // the offers room reads empty while the Seller accepts, so it never captures the signed record of offer A
    const venue = s.w.venue as unknown as { read: (room: string) => Promise<unknown> };
    const original = venue.read.bind(venue);
    venue.read = async (room: string) => (room === OFFER_ROOM ? [] : original(room));
    try {
      await s.c.seller.acceptLegA(offerA, s.w.legB, s.w.lockTimeMs);
    } finally {
      venue.read = original;
    }
    expect((await sellerRecordOf(s.w)).frames.offerA?.record, "the fallback path is the one under test: offer A's signed record was never captured").toBeUndefined();
    await STEPS.acceptLegB.run(s.c);
    await STEPS.lockLegB.run(s.c);
    await STEPS.verify.run(s.c);
    const view = await readSwap(s.w);
    const contract = view.acceptA!.contract;
    await s.w.venue.post(dealRoom(contract), encodeFrame({ type: "lock", from: stranger.did, contract, rail: "evm-htlc", ref: view.acceptA!.statement }), stranger);
    await s.c.seller.postAccountLineA(s.w.addresses.seller); // the stranger is not the payer: not counted
    expect(await framesOfType(s, dealRoom(contract), "lock")).toBe(1);

    const late = await started(evmWorld, [STEPS.bid]);
    const lateOffer = (await readSwap(late.w)).offerA!;
    const lateVenue = late.w.venue as unknown as { read: (room: string) => Promise<unknown> };
    const lateOriginal = lateVenue.read.bind(lateVenue);
    lateVenue.read = async (room: string) => (room === OFFER_ROOM ? [] : lateOriginal(room));
    try {
      await late.c.seller.acceptLegA(lateOffer, late.w.legB, late.w.lockTimeMs);
    } finally {
      lateVenue.read = lateOriginal;
    }
    await STEPS.acceptLegB.run(late.c);
    await STEPS.lockLegB.run(late.c);
    await STEPS.verify.run(late.c);
    const lateView = await readSwap(late.w);
    const lateContract = lateView.acceptA!.contract;
    await late.w.venue.post(
      dealRoom(lateContract),
      encodeFrame({ type: "lock", from: late.w.dids.buyer, contract: lateContract, rail: "evm-htlc", ref: lateView.acceptA!.statement }),
      late.w.buyerOptions().identity,
    );
    await expect(late.c.seller.postAccountLineA(late.w.addresses.seller)).rejects.toBeInstanceOf(FlowRecordConflictError);
  });
});

describe("R1-13 (EVM): a resumed claim is looked for from the saved block marker, never from genesis", () => {
  const chainAdvanced = (node: EvmMockNode): void => {
    node.blockNumber = 500n; // the chain is far past block 0 when the lock lands
    node.maxLogSpan = 10n; // a public RPC that refuses a scan over more than 10 blocks
  };

  it("the claim was sent and the process died: the resumed claimLegA scans from the marker and posts the reveal and the receipt", async () => {
    let node: EvmMockNode | undefined;
    const s = await started(evmWorldWith((n) => ((node = n), chainAdvanced(n))));
    const statement = s.c.seller.statement!;
    await resumedSeller(s, (o) => ({ rail: crashRail(o.rail, { after: ["claim"] }) }));
    await expect(s.c.seller.claimLegA(statement)).rejects.toBeInstanceOf(ProcessDied);
    expect(s.w.counts().claims).toBe(1);
    const saved = await sellerRecordOf(s.w);
    expect(saved.claimAttempted).toBe(true);
    expect(saved.claimFromBlock, "the marker is saved with the attempt, before the first send").toBeDefined();
    expect(markerFromJson(saved.claimFromBlock!)).toBeGreaterThan(500n);

    const back = await resumedSeller(s);
    const result = await back.flow.claimLegA(statement); // before the fix: the scan started at block 0 and the capped RPC refused it
    expect(result.receipt).toBeDefined();
    expect(s.w.counts().claims, "nothing is claimed twice").toBe(1);
    const { contractA } = await contractsOf(s.w);
    expect(await framesOfType(s, dealRoom(contractA), "reveal")).toBe(1);
    expect(await framesOfType(s, dealRoom(contractA), "receipt")).toBe(1);
    expect(Math.min(...node!.logQueries.slice(-1).map(Number))).toBeGreaterThan(500);
  });

  it("a claim the record shows as landed is not searched for at all: with every log query refused the missing frames are still posted", async () => {
    let node: EvmMockNode | undefined;
    const s = await started(evmWorldWith((n) => void (node = n)));
    const statement = s.c.seller.statement!;
    const { contractA } = await contractsOf(s.w);
    const mute = failVenuePosts(s.w.venue, (room, line) => room === dealRoom(contractA) && tryDecodeFrame(line)?.type === "reveal", 3);
    await expect(s.c.seller.claimLegA(statement)).rejects.toBeInstanceOf(RevealNotPostedError); // the claim landed, the reveal never posted
    mute.restore();
    expect((await sellerRecordOf(s.w)).claimOutcome).toBe("landed");

    node!.refuseLogs = true; // a provider that no longer answers log queries
    const queriesBefore = node!.logQueries.length;
    const back = await resumedSeller(s);
    await back.flow.claimLegA(statement);
    expect(node!.logQueries.length, "no scan was made").toBe(queriesBefore);
    expect(await framesOfType(s, dealRoom(contractA), "reveal")).toBe(1);
    expect(await framesOfType(s, dealRoom(contractA), "receipt")).toBe(1);
    expect(s.w.counts().claims).toBe(1);
  });
});

describe("R1-13 (Bitcoin): the resumed recovery scans only from the saved marker height", () => {
  it("the marker is the tip height read before the first send, and findClaimedPreimage is given it", async () => {
    let chain: LedgerChain | undefined;
    const s = await started(ledgerWorldWith("btc", (c) => void (chain = c)));
    chain!.height = 700;
    const statement = s.c.seller.statement!;
    await resumedSeller(s, (o) => ({ rail: crashRail(o.rail, { after: ["claim"] }) }));
    await expect(s.c.seller.claimLegA(statement)).rejects.toBeInstanceOf(ProcessDied);
    const saved = await sellerRecordOf(s.w);
    expect(saved.claimFromBlock).toEqual({ kind: "number", value: "700" });

    chain!.scanFrom.length = 0;
    chain!.height = 705;
    const back = await resumedSeller(s);
    await back.flow.claimLegA(statement);
    expect(chain!.scanFrom, "every scan of the resumed recovery starts at the saved marker").toEqual([700]);
    expect(s.w.counts().claims).toBe(1);
  });
});
