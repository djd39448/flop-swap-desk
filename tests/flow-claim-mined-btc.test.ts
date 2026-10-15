// SPDX-License-Identifier: MIT
//
// tests/flow-claim-mined-btc.test.ts: P10 B7 (P8 checkpoint decision 7), the Seller's Bitcoin claim counts as LANDED only once it is mined. The flows are the real
// ones, with stores, over the Bitcoin ledger fake of the crash matrix (tests/helpers/ledger-rail.ts), whose chain here does NOT mine on its own: a sent claim sits in
// the mempool until `chain.mine()`, and `chain.evictClaim(txid)` drops it. The rule under test, from the reason it exists: a claim seen only in the mempool has
// already shown the preimage; if the Seller stopped there and the claim were dropped, the Buyer could learn the secret, claim leg B and refund leg A after its
// refund time, and the Seller would lose leg A. So:
//
//   1  a claim that is broadcast and not mined leaves the Seller at its claim step (`next` is `claimLegA`, no receipt, `claimOutcome` none), with the reveal posted
//      (the secret is public and tclk takes a reveal only before refundAfterMs) and the claim's txid and exact bytes saved BEFORE it was sent;
//   2  mined, it settles as before (receipt, `claimOutcome` landed, `done`); with a chain that mines at once, one call settles;
//   3  a claim the node still holds is never sent again, in this process or after a restart; the Buyer still learns the secret from the mempool;
//   4  a claim that left the mempool unmined is sent again as the SAME bytes while leg A's funding output is unspent, also after the claim-by, never as a new
//      spend with another fee (claims built stays 1), and under the bound of P10-FUND-01/03 (P10-FIXES-R1.md decision 1): at any time once leg B's note reads
//      claimed with this swap's secret (the Buyer holds leg B), else for a claim the node had accepted only before leg A's refund time minus the claim-inclusion
//      margin (past it the typed ClaimResendTooLateError, nothing sent);
//   5  a claim that may never have been sent (signed and saved, the process died before the send) is a FIRST claim: its re-send keeps every guard;
//   6  a funding output spent by another transaction is not re-sent;
//   7  a node that refuses the saved bytes is a typed error for a person, nothing new is built.

import { dealRoom, tryDecodeFrame } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { RailRecoveryRefusedError } from "../src/client/counter-rail.js";
import { decodeFlowRecord, encodeFlowRecord, redactFlowRecord, type SellerFlowRecord } from "../src/client/flow-record.js";
import { flowDigest } from "../src/client/flow-store.js";
import { BTC_LOCAL_POLICY } from "../src/client/policy.js";
import { ClaimNotMinedError, ClaimResendTooLateError, ClaimSupersededError, SellerFlow } from "../src/client/seller.js";
import { Controller, PREFIX, STEPS, frameCounts, readSwap, type Ctx, type Mode, type World } from "./helpers/crash-matrix.js";
import { BuyerFlow } from "../src/client/buyer.js";
import { sellerKeyOf } from "./helpers/seller-key.js";
import type { LedgerChain } from "./helpers/ledger-rail.js";
import { ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { contractsOf, resumedSeller, sellerRecordOf, started, type Started } from "./helpers/resume-world.js";

/** A Bitcoin ledger world after the Buyer locked leg A, on a chain that mines only when told to. */
async function lockedWorld(options: { autoMine?: boolean; steps?: Parameters<typeof started>[1] } = {}): Promise<{ s: Started; chain: LedgerChain; statement: string }> {
  let chain: LedgerChain | undefined;
  const s = await started(
    ledgerWorldWith("btc", (c) => {
      chain = c;
      c.autoMineClaims = options.autoMine ?? false;
    }),
    options.steps,
  );
  if (chain === undefined) throw new Error("test: no chain");
  return { s, chain, statement: s.c.seller.statement! };
}

const dealRoomA = async (w: World): Promise<string> => dealRoom((await contractsOf(w)).contractA);

/** The Buyer learns the secret (the reveal frame, or the mempool) and takes leg B: leg B's paper note then reads claimed with this swap's secret. */
const buyerTakesLegB = async (s: Started): Promise<void> => {
  await s.c.buyer.claimLegB(await s.c.buyer.learnSecret());
};

/** The last moment a saved claim may be sent again without leg B claimed: leg A's refund time minus the policy's claim-inclusion margin (the rail's last-moment guard). */
const notAfterMsOf = (w: World): number => w.refundAt.legA - BTC_LOCAL_POLICY.claimInclusionMarginMs;

async function legAFrames(w: World): Promise<{ reveal: number; receipt: number }> {
  const counts = await frameCounts(w, await dealRoomA(w));
  return { reveal: counts.reveal ?? 0, receipt: counts.receipt ?? 0 };
}

const claimTxOf = async (w: World): Promise<NonNullable<SellerFlowRecord["claimTx"]>> => {
  const claimTx = (await sellerRecordOf(w)).claimTx;
  if (claimTx === undefined) throw new Error("test: the Seller's record holds no claim transaction");
  return claimTx;
};

/** What a rejected promise rejected with (the test fails if it resolved). */
async function rejection(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error("test: the call was expected to be refused");
    },
    (error: unknown) => error,
  );
}

describe("P10 B7: a claim that is broadcast and not mined is not landed", () => {
  it("the Seller stays at its claim step: ClaimNotMinedError, the reveal is posted, no receipt, claimOutcome none, next claimLegA, one claim built and sent", async () => {
    const { s, chain, statement } = await lockedWorld();
    const error = await rejection(s.c.seller.claimLegA(statement));
    expect(error).toBeInstanceOf(ClaimNotMinedError);
    const notMined = error as ClaimNotMinedError;
    expect(notMined.txid).toBe((await claimTxOf(s.w)).txid);
    expect(notMined.message).toContain("broadcast but not mined");
    expect(notMined.message).toContain(notMined.txid ?? "x");

    expect(chain.counts.claimBuilt).toBe(1);
    expect(chain.counts.claimSent).toBe(1);
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 0 }); // the secret is public; the claim is not paid yet
    const record = await sellerRecordOf(s.w);
    expect(record.claimAttempted).toBe(true);
    expect(record.claimOutcome).toBe("none");
    expect(record.claimTx?.sent).toBe(true);
    expect(record.receiptPosted).toBe(false);
    expect((await resumedSeller(s)).next).toBe("claimLegA"); // today (before B7) the Seller was `done` here, and nobody would send a dropped claim again
  });

  it("the claim's txid and exact bytes are saved BEFORE it is sent (record before send): the save lands first, then the send", async () => {
    const { s, chain, statement } = await lockedWorld();
    const seen: string[] = [];
    s.w.stores.seller.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      if (record.role === "seller" && record.claimTx !== undefined) seen.push(`save claimTx sent=${record.claimTx.sent === true} sentOnChain=${chain.counts.claimSent}`);
      return undefined;
    });
    await rejection(s.c.seller.claimLegA(statement));
    expect(seen[0]).toBe("save claimTx sent=false sentOnChain=0"); // recorded, nothing sent yet
    expect(seen.some((line) => line === "save claimTx sent=true sentOnChain=1")).toBe(true);
    // the saved bytes are the ones the chain holds
    const claimTx = await claimTxOf(s.w);
    expect(chain.claimBytes.get(claimTx.txid)?.rawTx).toBe(claimTx.rawTx);
  });

  it("a refused save of the claim's record stops the claim before the send: nothing is sent (the save is awaited)", async () => {
    const { s, chain, statement } = await lockedWorld();
    s.w.stores.seller.failSaveWhen((_n, key, bytes) => {
      const record = decodeFlowRecord(bytes, key);
      return record.role === "seller" && record.claimTx !== undefined ? "reject" : undefined;
    });
    await rejection(s.c.seller.claimLegA(statement));
    expect(chain.counts.claimSent).toBe(0);
    expect(chain.knownTxs.size).toBe(1); // the Buyer's funding only
  });

  it("mined, it settles as before: the same call a block later posts the receipt, claimOutcome is landed, next is done, nothing is sent again", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    chain.mine();
    const result = await s.c.seller.claimLegA(statement);
    expect(result.receipt).toBeDefined();
    expect(result.reveal).toBeDefined();
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
    const record = await sellerRecordOf(s.w);
    expect(record.claimOutcome).toBe("landed");
    expect(record.receiptPosted).toBe(true);
    expect((await resumedSeller(s)).next).toBe("done");
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
  });

  it("the same, in a resumed process: restart while the claim is unmined, mine, and the new process settles it", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    const back = await resumedSeller(s);
    expect(back.next).toBe("claimLegA");
    chain.mine();
    await back.flow.claimLegA(statement);
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
    expect((await resumedSeller(s)).next).toBe("done");
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
  });

  it("on a chain that mines at once, one call settles (the fast path is unchanged)", async () => {
    const { s, chain, statement } = await lockedWorld({ autoMine: true });
    const result = await s.c.seller.claimLegA(statement);
    expect(result.receipt).toBeDefined();
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
    expect((await sellerRecordOf(s.w)).claimOutcome).toBe("landed");
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
  });
});

describe("P10 B7: a claim the node still holds is never sent again, and the Buyer still learns the secret from the mempool", () => {
  it("repeated calls, in this process and in a restarted one, answer ClaimNotMinedError and send and build nothing new", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    const before = { ...chain.counts };
    const roomBefore = (await s.w.venue.read(await dealRoomA(s.w))).length;
    for (let i = 0; i < 2; i += 1) expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    const back = await resumedSeller(s);
    expect(back.next).toBe("claimLegA");
    expect(await rejection(back.flow.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toEqual(before); // nothing built, nothing sent, nothing re-sent
    expect((await s.w.venue.read(await dealRoomA(s.w))).length).toBe(roomBefore); // no second reveal either
    expect(chain.scanFrom.length).toBeGreaterThan(0); // it read the chain, from the marker it saved with the attempt
  });

  it("the Buyer learns the secret from the unmined claim (no reveal frame needed): findClaimedPreimage and checkPendingClaim see the mempool", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement, { skipReveal: true }));
    expect(await legAFrames(s.w)).toEqual({ reveal: 0, receipt: 0 }); // no frame: the chain is the only place the secret is
    const terms = { rail: "btc-htlc" } as never;
    const connected = await s.w.buyerOptions().rail.connect(terms, {});
    const ref = [...chain.outputs.keys()][0]!;
    expect(await connected.findClaimedPreimage(ref, undefined)).toBe(s.w.hashLock.preimage);
    expect(await connected.checkPendingClaim?.(ref)).toBe(s.w.hashLock.preimage);
    // and the Buyer flow itself learns it and takes leg B, which is what the Seller's rule is protecting against
    const learned = await s.c.buyer.learnSecret();
    expect(learned).toBe(s.w.hashLock.preimage);
  });
});

describe("P10 B7: a claim that left the mempool unmined is sent again as the SAME bytes, also after the claim-by", () => {
  async function evicted(): Promise<{ s: Started; chain: LedgerChain; statement: string; txid: string; rawTx: string }> {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    const { txid, rawTx } = await claimTxOf(s.w);
    chain.evictClaim(txid);
    return { s, chain, statement, txid, rawTx };
  }

  it("inside the window: the identical bytes are sent once, nothing is built, the same txid is back, and a block settles it", async () => {
    const { s, chain, statement, txid, rawTx } = await evicted();
    expect(chain.knownTxs.has(txid)).toBe(false); // the premise: the node dropped it
    expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 2, rebroadcasts: 1 });
    expect(chain.knownTxs.has(txid)).toBe(true);
    expect(await claimTxOf(s.w)).toEqual({ txid, rawTx, sent: true }); // the record is untouched
    chain.mine();
    await s.c.seller.claimLegA(statement);
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
    expect(chain.counts).toMatchObject({ claimBuilt: 1, rebroadcasts: 1 });
  });

  it("after the claim-by (and past the claim-inclusion margin): re-sent all the same, because the secret is public already", async () => {
    const { s, chain, statement, txid } = await evicted();
    const view = await readSwap(s.w);
    s.w.setTime(view.offerA!.claimByMs + 10 * 60_000);
    expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, rebroadcasts: 1 });
    expect(chain.knownTxs.has(txid)).toBe(true);
  });

  it("after leg A's refund time, while the funding output is still unspent and the Buyer holds leg B: re-sent in a restarted process, the same bytes", async () => {
    const { s, chain, statement, txid, rawTx } = await evicted();
    await buyerTakesLegB(s); // P10-FUND-03: past refundAfterMs minus the margin the re-send needs leg B claimed with the secret (the reveal frame is in the room)
    s.w.setTime(s.w.refundAt.legA + 60 * 60_000);
    const back = await resumedSeller(s);
    expect(back.next).toBe("claimLegA");
    expect(await rejection(back.flow.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, rebroadcasts: 1 });
    expect(chain.claimBytes.get(txid)?.rawTx).toBe(rawTx);
    expect(chain.knownTxs.has(txid)).toBe(true);
  });

  it("never a new spend: however often it is dropped, only the one recorded claim is ever built", async () => {
    const { s, chain, statement, txid } = await evicted();
    for (let i = 0; i < 3; i += 1) {
      expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
      chain.evictClaim(txid);
    }
    expect(chain.counts.claimBuilt).toBe(1);
    expect(chain.claimBytes.size).toBe(1);
  });

  it("a node that refuses the saved bytes is RailRecoveryRefusedError for a person: nothing is built, nothing is sent", async () => {
    const { s, chain, statement } = await evicted();
    chain.refuseClaimResend = true;
    const error = await rejection(s.c.seller.claimLegA(statement));
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("rebroadcast-refused");
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
  });
});

describe("P10 B7: a funding output spent by another transaction is not re-sent", () => {
  it("the Buyer's refund took the output after the claim dropped: ClaimSupersededError (the claim had been accepted), no re-send, no receipt", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    const { txid } = await claimTxOf(s.w);
    chain.evictClaim(txid);
    s.w.setTime(s.w.refundAt.legA);
    await s.c.buyer.refundLegA(); // the Buyer's refund (its own flow): the output is spent by the refund
    const before = { ...chain.counts };
    const error = await rejection(s.c.seller.claimLegA(statement));
    expect(error).toBeInstanceOf(ClaimSupersededError);
    expect((error as ClaimSupersededError).sent).toBe(true);
    expect((error as ClaimSupersededError).message).toContain("leg B is exposed");
    expect(chain.counts).toEqual(before);
    const sellerReceipts = (await s.w.venue.read(await dealRoomA(s.w))).filter((record) => record.sender === s.w.dids.seller && tryDecodeFrame(record.line)?.type === "receipt");
    expect(sellerReceipts).toHaveLength(0); // the Buyer's refund receipt is in the room; the Seller posted no receipt of a claim
    expect((await sellerRecordOf(s.w)).receiptPosted).toBe(false);
    expect((await resumedSeller(s)).next).toBe("claimLegA"); // a person has to act; the flow offers no safe step
  });
});

// A process that dies right after the claim is signed and saved, before it is sent: the record says the claim may never have been sent.
async function diedBeforeClaimSend(mode: Mode = "before"): Promise<{ s: Started; chain: LedgerChain; statement: string }> {
  let chain: LedgerChain | undefined;
  // a reference run numbers the outward actions; the cut is the claim's send
  const reference = new Controller();
  const refWorld = ledgerWorldWith("btc", () => undefined)(reference);
  const refCtx: Ctx = { w: refWorld, buyer: new BuyerFlow(refWorld.buyerOptions()), seller: new SellerFlow(refWorld.sellerOptions()), history: [] };
  for (const step of [...PREFIX, STEPS.lockLegA, STEPS.claimLegA]) await step.run(refCtx);
  const n = reference.actions.find((action) => action.what === "chain:claim.send")?.n;
  if (n === undefined) throw new Error("test: no claim send in the reference run");

  const ctl = new Controller([{ n, mode }]);
  const w = ledgerWorldWith("btc", (c) => {
    chain = c;
    c.autoMineClaims = false;
  })(ctl);
  ctl.attachStore(w.stores.buyer, "buyer");
  ctl.attachStore(w.stores.seller, "seller");
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of [...PREFIX, STEPS.lockLegA]) await step.run(c);
  await seller.claimLegA(seller.statement!).catch(() => undefined);
  expect(ctl.isDead("seller")).toBe(true);
  if (chain === undefined) throw new Error("test: no chain");
  return { s: { ctl, w, c }, chain, statement: seller.statement! };
}

describe("P10 B7: a claim that may never have been sent is a FIRST claim and keeps every guard", () => {
  it("signed, saved, never sent (the process died before the send): the record has no 'sent', the node does not know it", async () => {
    const { s, chain } = await diedBeforeClaimSend();
    const claimTx = await claimTxOf(s.w);
    expect(claimTx.sent).toBeUndefined();
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 0 });
    expect(chain.knownTxs.has(claimTx.txid)).toBe(false);
    expect((await resumedSeller(s)).next).toBe("claimLegA");
  });

  it("inside the window the restart sends the identical saved bytes (one build, one send), and a block settles it", async () => {
    const { s, chain, statement } = await diedBeforeClaimSend();
    const { txid } = await claimTxOf(s.w);
    const back = await resumedSeller(s);
    expect(await rejection(back.flow.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 1 });
    expect(chain.knownTxs.has(txid)).toBe(true);
    expect((await claimTxOf(s.w)).sent).toBe(true);
    chain.mine();
    await back.flow.claimLegA(statement);
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
  });

  it("past the claim-by the restart REFUSES with the first-claim guard and sends nothing: the secret was never made public, and the claim-by is not widened", async () => {
    const { s, chain, statement } = await diedBeforeClaimSend();
    const view = await readSwap(s.w);
    s.w.setTime(view.offerA!.claimByMs + 10 * 60_000);
    const back = await resumedSeller(s);
    const error = await rejection(back.flow.claimLegA(statement));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/at\/after its claimByMs/);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 0, rebroadcasts: 0 });
    expect((await legAFrames(s.w)).reveal).toBe(0);
  });

  it("past the claim-inclusion margin before leg A's refund time: refused the same way, nothing sent", async () => {
    const { s, chain, statement } = await diedBeforeClaimSend();
    const view = await readSwap(s.w);
    s.w.setTime(view.offerA!.refundAfterMs - 30 * 60_000); // inside the 60 minute margin
    const back = await resumedSeller(s);
    const error = await rejection(back.flow.claimLegA(statement));
    expect((error as Error).message).toMatch(/claim-inclusion margin|claimByMs/);
    expect(chain.counts.claimSent).toBe(0);
  });

  it("the output is spent by the Buyer's refund before the restart: ClaimSupersededError (sent=false: the node never saw the claim), nothing is sent", async () => {
    const { s, chain, statement } = await diedBeforeClaimSend();
    s.w.setTime(s.w.refundAt.legA);
    await s.c.buyer.refundLegA(); // the Buyer's own refund takes the output
    const back = await resumedSeller(s);
    const error = await rejection(back.flow.claimLegA(statement));
    expect(error).toBeInstanceOf(ClaimSupersededError);
    expect((error as ClaimSupersededError).sent).toBe(false);
    expect((error as ClaimSupersededError).message).toContain("never been seen by the node");
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 0, rebroadcasts: 0 });
    expect((await legAFrames(s.w)).reveal).toBe(0); // the secret was never made public by this flow
  });

  it("a FIRST claim keeps every guard it had: past the claim-by nothing is signed, recorded or sent", async () => {
    const { s, chain, statement } = await lockedWorld();
    const view = await readSwap(s.w);
    s.w.setTime(view.offerA!.claimByMs + 1);
    const error = await rejection(s.c.seller.claimLegA(statement));
    expect((error as Error).message).toMatch(/at\/after its claimByMs/);
    expect(chain.counts).toMatchObject({ claimBuilt: 0, claimSent: 0 });
    expect((await sellerRecordOf(s.w)).claimTx).toBeUndefined();
    expect((await sellerRecordOf(s.w)).claimAttempted).toBe(false);
  });
});

// P10-FUND-01 and P10-FUND-03 (P10-FIXES-R1.md decision 1). The earlier reasoning ("the secret is already public, so a re-send reveals nothing new") fails when the first broadcast
// was evicted before the Buyer saw it: the re-send is then the Buyer's first chance to learn the secret, and one sent after leg B's claim-by could take leg A from a Buyer who can no longer
// claim leg B. The rule, for a recorded claim the node no longer knows while leg A's funding output is unspent: (a) leg B's note reads claimed with this swap's secret: re-send at any time,
// `sent` or not; (b) else for a claim marked `sent`: only before leg A's refund time minus the claim-inclusion margin, else ClaimResendTooLateError; (c) else every first-claim guard.
describe("P10-FUND-01: the Buyer already holds leg B: the saved claim is sent again at any time, also when it was never marked sent", () => {
  it.each([
    ["past the claim-by", (_s: Started, claimByMs: number): number => claimByMs + 10 * 60_000],
    ["past leg A's refund time", (s: Started, _claimByMs: number): number => s.w.refundAt.legA + 60 * 60_000],
  ] as const)(
    "the node accepted the claim, the mark was lost with the process, the Buyer took leg B from the mempool, the claim was evicted: %s, the identical bytes go out once",
    async (_label, when) => {
      const { s, chain, statement } = await diedBeforeClaimSend("after-store-fail");
      const { txid, rawTx, sent } = await claimTxOf(s.w);
      expect(sent).toBeUndefined(); // the premise: the record never learned that the node accepted the claim
      expect(chain.knownTxs.has(txid)).toBe(true); // ...which it did
      await buyerTakesLegB(s); // no reveal frame was ever posted: the Buyer reads the mempool
      expect(await legAFrames(s.w)).toEqual({ reveal: 0, receipt: 0 });
      chain.evictClaim(txid);
      s.w.setTime(when(s, (await readSwap(s.w)).offerA!.claimByMs));

      const back = await resumedSeller(s);
      expect(back.next).toBe("claimLegA");
      expect(await rejection(back.flow.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError); // back in the mempool, not mined
      expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 2, rebroadcasts: 1 });
      expect(chain.claimBytes.get(txid)?.rawTx).toBe(rawTx);
      expect(chain.knownTxs.has(txid)).toBe(true);
      expect(await claimTxOf(s.w)).toEqual({ txid, rawTx, sent: true });
      chain.mine();
      await back.flow.claimLegA(statement);
      expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
    },
  );

  it("control: the same premise with leg B NOT claimed keeps every first-claim guard: past the claim-by nothing is sent", async () => {
    const { s, chain, statement } = await diedBeforeClaimSend("after-store-fail");
    const { txid } = await claimTxOf(s.w);
    chain.evictClaim(txid);
    s.w.setTime((await readSwap(s.w)).offerA!.claimByMs + 10 * 60_000);
    const back = await resumedSeller(s);
    const error = await rejection(back.flow.claimLegA(statement));
    expect((error as Error).message).toMatch(/at\/after its claimByMs/);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
    expect((await claimTxOf(s.w)).sent).toBeUndefined();
  });
});

describe("P10-FUND-03: a claim the node accepted and dropped is sent again only while it can still land before leg A's refund time, unless the Buyer holds leg B", () => {
  async function acceptedThenEvicted(): Promise<{ s: Started; chain: LedgerChain; statement: string; txid: string; rawTx: string }> {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    const { txid, rawTx, sent } = await claimTxOf(s.w);
    expect(sent).toBe(true);
    chain.evictClaim(txid);
    return { s, chain, statement, txid, rawTx };
  }

  it.each([
    ["exactly at the bound (refundAfterMs minus the margin)", (s: Started) => notAfterMsOf(s.w)],
    ["inside the margin, before leg A's refund time", (s: Started) => s.w.refundAt.legA - 30 * 60_000],
    ["past leg A's refund time", (s: Started) => s.w.refundAt.legA + 60 * 60_000],
  ] as const)("leg B unclaimed, %s: ClaimResendTooLateError, nothing is sent, in this process and in a restarted one", async (_label, when) => {
    const { s, chain, statement, txid, rawTx } = await acceptedThenEvicted();
    s.w.setTime(when(s));
    const before = { ...chain.counts };
    const error = await rejection(s.c.seller.claimLegA(statement));
    expect(error).toBeInstanceOf(ClaimResendTooLateError);
    const tooLate = error as ClaimResendTooLateError;
    expect(tooLate.txid).toBe(txid);
    expect(tooLate.notAfterMs).toBe(notAfterMsOf(s.w));
    expect(tooLate.message).toContain("Nothing was sent");
    expect(tooLate.message).toContain("may be refunding leg A");
    expect(tooLate.message).toContain("without the time to claim leg B");
    expect(tooLate.message).toContain("call claimLegA() again");
    expect(chain.counts).toEqual(before);
    expect(chain.knownTxs.has(txid)).toBe(false);
    expect(await claimTxOf(s.w)).toEqual({ txid, rawTx, sent: true }); // the record is untouched
    const back = await resumedSeller(s);
    expect(back.next).toBe("claimLegA");
    expect(await rejection(back.flow.claimLegA(statement))).toBeInstanceOf(ClaimResendTooLateError);
    expect(chain.counts).toEqual(before);
    expect((await sellerRecordOf(s.w)).receiptPosted).toBe(false);
  });

  it("the refusal is not for ever: once the Buyer has claimed leg B with the secret, the next claimLegA sends the saved bytes once", async () => {
    const { s, chain, statement, txid, rawTx } = await acceptedThenEvicted();
    s.w.setTime(s.w.refundAt.legA + 60 * 60_000);
    expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimResendTooLateError);
    await buyerTakesLegB(s); // the reveal frame has been in the room since the first broadcast
    expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 2, rebroadcasts: 1 });
    expect(chain.claimBytes.get(txid)?.rawTx).toBe(rawTx);
    expect(chain.knownTxs.has(txid)).toBe(true);
  });

  it("leg B claimed with the secret, past the bound: one identical re-send, whatever the clock says", async () => {
    const { s, chain, statement, txid, rawTx } = await acceptedThenEvicted();
    await buyerTakesLegB(s);
    s.w.setTime(s.w.refundAt.legA + 60 * 60_000);
    expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 2, rebroadcasts: 1 });
    expect(chain.claimBytes.get(txid)?.rawTx).toBe(rawTx);
    chain.mine();
    await s.c.seller.claimLegA(statement);
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
  });

  it("leg B unclaimed, one millisecond before the bound: one identical re-send (as before this fix)", async () => {
    const { s, chain, statement, txid, rawTx } = await acceptedThenEvicted();
    s.w.setTime(notAfterMsOf(s.w) - 1);
    expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 2, rebroadcasts: 1 });
    expect(chain.claimBytes.get(txid)?.rawTx).toBe(rawTx);
    expect(chain.knownTxs.has(txid)).toBe(true);
  });

  it("a funding output spent by the Buyer's refund is still ClaimSupersededError, not the too-late refusal (nothing is sent)", async () => {
    const { s, chain, statement } = await acceptedThenEvicted();
    s.w.setTime(s.w.refundAt.legA);
    await s.c.buyer.refundLegA();
    const before = { ...chain.counts };
    expect(await rejection(s.c.seller.claimLegA(statement))).toBeInstanceOf(ClaimSupersededError);
    expect(chain.counts).toEqual(before);
  });
});

describe("P10 B7: the record", () => {
  it("claimTx is a field of the Seller's own record only, holds the preimage only there, and redactFlowRecord masks the bytes", async () => {
    const { s, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    const seller = await sellerRecordOf(s.w);
    const key = await sellerKeyOf(s.w.stores.seller);
    const bytes = encodeFlowRecord(seller);
    expect(decodeFlowRecord(bytes, key)).toEqual(seller); // it round-trips
    // a Buyer's store never holds a claim record
    for (const save of s.w.stores.buyer.saves) expect(new TextDecoder().decode(save.bytes)).not.toContain("claimTx");
    // redaction hides the claim bytes when they carry the preimage (here: planted)
    const planted: SellerFlowRecord = { ...seller, claimTx: { txid: "ab".repeat(32), rawTx: `0200${s.w.hashLock.preimage.slice(2)}00`, sent: true } };
    const redacted = redactFlowRecord(planted) as unknown as { claimTx: { rawTx: string } };
    expect(redacted.claimTx.rawTx).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain(s.w.hashLock.preimage.slice(2));
  });

  it("a record written before this change (claim attempted, no claim bytes) still decodes; an unmined claim it sees is ClaimNotMinedError with no txid, and mined it settles", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    // drop the claim bytes from the stored record, as a record written by the previous build has none
    const key = await sellerKeyOf(s.w.stores.seller);
    const current = (await s.w.stores.seller.load(key))!;
    const record = decodeFlowRecord(current, key) as SellerFlowRecord;
    const { claimTx: _dropped, ...legacy } = record;
    void _dropped;
    await s.w.stores.seller.save(key, encodeFlowRecord(legacy as SellerFlowRecord), flowDigest(current));
    const back = await resumedSeller(s);
    const error = await rejection(back.flow.claimLegA(statement));
    expect(error).toBeInstanceOf(ClaimNotMinedError);
    expect((error as ClaimNotMinedError).txid).toBeUndefined();
    expect((error as ClaimNotMinedError).message).toContain("kept no claim bytes");
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
    chain.mine();
    await back.flow.claimLegA(statement);
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
  });
});

describe("P10 B7: the txid decides what the scan cannot (a claim mined below the saved marker)", () => {
  it("the node reports a confirmation for the recorded txid although the block scan from the marker misses it: it settles, nothing is re-sent", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    chain.mine();
    const output = [...chain.outputs.values()][0]!;
    output.claimHeight = (output.claimHeight ?? 0) - 50; // a deep reorg re-included it far below the saved marker
    await s.c.seller.claimLegA(statement);
    expect(await legAFrames(s.w)).toEqual({ reveal: 1, receipt: 1 });
    expect(chain.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
  });
});

describe("P10 B7: without a store the same rule holds in the same process", () => {
  it("a Seller with no store: broadcast is not landed, a repeat sends nothing, a block settles", async () => {
    let chain: LedgerChain | undefined;
    const ctl = new Controller();
    const w = ledgerWorldWith("btc", (c) => {
      chain = c;
      c.autoMineClaims = false;
    })(ctl);
    const { store: _store, ...noStore } = w.sellerOptions();
    void _store;
    const seller = new SellerFlow(noStore);
    const buyer = new BuyerFlow(w.buyerOptions());
    const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
    for (const step of [...PREFIX, STEPS.lockLegA]) await step.run(c);
    const statement = seller.statement!;
    expect(await rejection(seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(await rejection(seller.claimLegA(statement))).toBeInstanceOf(ClaimNotMinedError);
    expect(chain!.counts).toMatchObject({ claimBuilt: 1, claimSent: 1, rebroadcasts: 0 });
    chain!.mine();
    const result = await seller.claimLegA(statement);
    expect(result.receipt).toBeDefined();
    expect(await legAFrames(w)).toEqual({ reveal: 1, receipt: 1 });
    // and an evicted claim is sent again, identically, in the same process
    expect(chain!.counts.claimBuilt).toBe(1);
  });
});

describe("P10 B7: the frames are posted once whatever the order of events (a reveal first, then the receipt after the block)", () => {
  it("tclk's fold accepts the reveal posted at broadcast and the receipt posted after the block: leg A ends claimed with no rejected step", async () => {
    const { s, chain, statement } = await lockedWorld();
    await rejection(s.c.seller.claimLegA(statement));
    chain.mine();
    await s.c.seller.claimLegA(statement);
    const records = await s.w.venue.read(await dealRoomA(s.w));
    const types = records.map((record) => tryDecodeFrame(record.line)?.type ?? "line");
    expect(types.filter((type) => type === "reveal")).toHaveLength(1);
    expect(types.filter((type) => type === "receipt")).toHaveLength(1);
    expect(types.indexOf("reveal")).toBeLessThan(types.indexOf("receipt"));
  });
});
