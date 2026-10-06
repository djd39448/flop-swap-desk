// SPDX-License-Identifier: MIT
//
// tests/flow-resume-sol.test.ts - P8-RESUME-SPEC.md "Surface" (flow API additions) and "Recover paths", on the Solana
// stateful harness: the REAL BuyerFlow / SellerFlow with a store, over the REAL Solana rail, over the stateful fake node.
// A "crash" is a flow instance that is dropped (or whose call threw `ProcessDied`); the test then resumes a FRESH instance
// from the same store over the same venue, note store, chain and clock, and checks what the spec says it must do:
//   rule 1 (durable before visible), rule 2 (never twice where twice can lose funds), rule 3 (same bytes, once),
//   rule 5 (the preimage stays private), rule 6 (fail closed on bad state).
// The full crash matrix (every boundary of every role on every harness) is the matrix builder's; these are the recover
// paths of the flows themselves.

import { base58 } from "@scure/base";
import { PaperRail, dealRoom, tryDecodeFrame, type AcceptFrame, type NoteStore, type OfferFrame } from "@flop-labs/tclk";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { LockPendingError } from "../src/client/buyer.js";
import { FlowRecordConflictError, ledgerEntry } from "../src/client/flow-record.js";
import { flowKey } from "../src/client/flow-store.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { encodeFrameWith } from "../src/rails/custom-frames.js";
import { SOL_RAIL_ID } from "../src/rails/custom-rails.js";
import { ProcessDied, crashRail, failVenuePosts, loseVenueReplies } from "./helpers/resume-flows.js";
import {
  bid,
  bidParams,
  buyerRecord,
  framesOf,
  isFrame,
  isLine,
  legA,
  rig,
  restartBuyer,
  restartSeller,
  sellerRecord,
  toLines,
  toLocked,
  toPaired,
} from "./helpers/resume-sol-rig.js";
import { framesIn, legBDeadlines, solHarness } from "./helpers/sol-flow-harness.js";

describe("resume: the whole swap, with both parties restarted after every step", () => {
  it("settles with one lock, one claim and each frame exactly once, and names the next step at every point", async () => {
    const r = rig();
    const { h } = r;
    const nexts: string[] = [];

    const offerA = await bid(r);
    nexts.push(`buyer:${await restartBuyer(r)}`);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    nexts.push(`seller:${await restartSeller(r)}`);
    const { acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.seller.lockLegB(acceptBRecord);
    nexts.push(`seller:${await restartSeller(r)}`);
    await r.buyer.verifyLegBLocked();
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.seller.postAccountLineA(h.sellerWallet.publicKey);
    nexts.push(`seller:${await restartSeller(r)}`);
    await r.buyer.postAccountLineA(h.buyerWallet.publicKey);
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.buyer.lockLegA();
    nexts.push(`buyer:${await restartBuyer(r)}`);
    await r.seller.claimLegA(r.seller.statement!);
    nexts.push(`seller:${await restartSeller(r)}`);
    const secret = await r.buyer.learnSecret();
    expect(secret).toBe(h.sellerLock.preimage);
    await r.buyer.claimLegB(secret);
    nexts.push(`buyer:${await restartBuyer(r)}`);

    expect(nexts).toEqual([
      "buyer:acceptLegB",
      "seller:postAccountLineA",
      "buyer:verifyLegBLocked",
      "seller:postAccountLineA",
      "buyer:postAccountLineA",
      "seller:claimLegA",
      "buyer:lockLegA",
      "buyer:learnSecret",
      "seller:done",
      "buyer:done",
    ]);
    expect(h.node.sent).toEqual({ lock: 1, claim: 1, refund: 0 });
    const roomA = dealRoom(accepted.acceptA.contract);
    for (const type of ["lock", "reveal", "receipt"]) expect(await framesOf(r, roomA, type)).toHaveLength(1);
    expect(framesIn(await h.venue.read("tclk-offers"), "offer")).toHaveLength(2);
    expect(framesIn(await h.venue.read("tclk-offers"), "accept")).toHaveLength(2);
  });

  it("a confirmed step called again returns the recorded result and does nothing (a same-process double call)", async () => {
    const r = rig();
    const p = await toLocked(r);
    const lockEvidence = await r.buyer.lockLegA(); // already confirmed: the recorded result
    expect(lockEvidence.writeEvidence.ref).toBe(`${p.accepted.acceptA.statement}:${r.h.buyerWallet.publicKey}`);
    expect(r.h.node.sent.lock).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);

    // the same for the earlier steps: nothing is posted twice
    const again = await r.seller.acceptLegA(p.offerA, legBDeadlines(), legA.lockTimeMs);
    expect(again.acceptA.contract).toBe(p.contractA);
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept")).toHaveLength(2);
    await r.buyer.bid(bidParams(r));
    expect(framesIn(await r.h.venue.read("tclk-offers"), "offer")).toHaveLength(2);
    await r.buyer.acceptLegB(again.offerBRecord, again.acceptARecord, legA.lockTimeMs);
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept")).toHaveLength(2);
  });

  it("two overlapping calls are still refused by the in-flight flag", async () => {
    const r = rig();
    await toLines(r);
    const first = r.buyer.lockLegA();
    await expect(r.buyer.lockLegA()).rejects.toThrow(/already attempted, or a lock is already in flight/);
    await first;
    expect(r.h.node.sent.lock).toBe(1);
  });
});

describe("resume: Seller accept A and offer B (rules 1 and 3)", () => {
  it("dies before accept A is posted: the preimage and the exact frames were saved first, the same statement is posted after the restart", async () => {
    const r = rig();
    const offerA = await bid(r);
    const fail = failVenuePosts(r.h.venue, (_room, line) => isFrame(line, "accept"));
    await expect(r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept")).toHaveLength(0); // nothing was visible
    const saved = await sellerRecord(r);
    expect(saved.preimage).toBe(r.h.sellerLock.preimage); // durable BEFORE accept A
    const acceptText = saved.frames.acceptA!.text;
    expect(ledgerEntry(saved, "accept-a")).toMatchObject({ text: acceptText });
    expect(ledgerEntry(saved, "accept-a")?.landed).toBeUndefined();

    let minted = 0;
    const next = await restartSeller(r, { mintHashLock: () => (minted += 1, r.h.sellerLock) });
    expect(next).toBe("acceptLegA");
    expect(r.seller.recordedOfferA).toEqual(offerA); // a resumed runner that lost the offer can read it back
    const accepted = await r.seller.acceptLegA(r.seller.recordedOfferA!, legBDeadlines(), legA.lockTimeMs);
    expect(minted).toBe(0); // no second secret
    const posted = framesIn(await r.h.venue.read("tclk-offers"), "accept");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.line).toBe(acceptText); // the identical bytes
    expect(accepted.acceptA.statement).toBe(saved.statement);
    expect((await sellerRecord(r)).frames.acceptA?.record?.seq).toBe(accepted.acceptARecord.seq);
  });

  it("accept A landed but its reply was lost, offer B then failed: the restart adopts accept A and posts only offer B", async () => {
    const r = rig();
    const offerA = await bid(r);
    const lost = loseVenueReplies(r.h.venue, (_room, line) => isFrame(line, "accept"));
    await expect(r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs)).rejects.toBeInstanceOf(ProcessDied);
    lost.restore();
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept")).toHaveLength(1); // landed, unknown to the flow
    expect(ledgerEntry(await sellerRecord(r), "accept-a")?.landed).toBeUndefined();
    await restartSeller(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept")).toHaveLength(1); // adopted, not posted again
    expect(framesIn(await r.h.venue.read("tclk-offers"), "offer")).toHaveLength(2); // the Buyer's offer A and the Seller's offer B
    expect(ledgerEntry(await sellerRecord(r), "accept-a")?.landed?.seq).toBe(accepted.acceptARecord.seq);
    // the swap goes on to the end with the same secret
    const { acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
    await r.seller.lockLegB(acceptBRecord);
  });

  it("offer B failed after accept A landed (in the same process, no restart): the next call posts offer B, accept A is not posted again", async () => {
    const r = rig();
    const offerA = await bid(r);
    const fail = failVenuePosts(r.h.venue, (_room, line) => isFrame(line, "offer") && (tryDecodeFrame(line) as OfferFrame).from === r.h.seller.did);
    await expect(r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept")).toHaveLength(1);
    expect(framesIn(await r.h.venue.read("tclk-offers"), "offer")).toHaveLength(2);
  });

  it("a different leg A offer than the one this swap saved is refused (a party never posts a second, different frame)", async () => {
    const r = rig();
    const offerA = await bid(r);
    const fail = failVenuePosts(r.h.venue, (_room, line) => isFrame(line, "accept"));
    await expect(r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    await restartSeller(r);
    // another genuine leg A offer from the same Buyer (a second harness mints it): not the one this swap saved
    const other = await solHarness().buyerFlow.bid({ ...bidParams(r), swapId: computeSwapId(r.h.buyer.did, "00000002") });
    await expect(r.seller.acceptLegA(other, legBDeadlines(), legA.lockTimeMs)).rejects.toThrow(/different leg A offer/);
  });
});

describe("resume: Buyer bid and accept B (rules 1 and 3)", () => {
  it("dies before the offer is posted: the restart posts the saved offer, not a second one with a fresh nonce", async () => {
    const r = rig();
    const fail = failVenuePosts(r.h.venue, (_room, line) => isFrame(line, "offer"));
    await expect(bid(r)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const saved = await buyerRecord(r);
    expect(saved.frames.offerA?.text).toBeDefined();
    expect(await restartBuyer(r)).toBe("bid");
    const offerA = await bid(r);
    const posted = framesIn(await r.h.venue.read("tclk-offers"), "offer");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.line).toBe(saved.frames.offerA!.text);
    expect(offerA.id).toBe((tryDecodeFrame(saved.frames.offerA!.text) as OfferFrame).id);
    // and a second bid for another swap through the same flow is refused
    await expect(r.buyer.bid({ ...bidParams(r), swapId: `0x${"ab".repeat(32)}` })).rejects.toBeInstanceOf(FlowRecordConflictError);
  });

  it("dies before accept B is posted: the restart posts the same accept B (same contract), and the pairing can be re-read from the flow", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const fail = failVenuePosts(r.h.venue, (_room, line) => isFrame(line, "accept") && (tryDecodeFrame(line) as AcceptFrame).from === r.h.buyer.did);
    await expect(r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const saved = await buyerRecord(r);
    expect(saved.contractB).toBeDefined();
    expect(await restartBuyer(r)).toBe("acceptLegB");
    const pairing = r.buyer.recordedPairing;
    expect(pairing?.offerBRecord.line).toBe(accepted.offerBRecord.line);
    expect(pairing?.acceptARecord.line).toBe(accepted.acceptARecord.line);
    const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(pairing!.offerBRecord, pairing!.acceptARecord, legA.lockTimeMs);
    expect(acceptB.contract).toBe(saved.contractB);
    expect(acceptBRecord.line).toBe(saved.frames.acceptB!.text);
    expect(framesIn(await r.h.venue.read("tclk-offers"), "accept").filter((rec) => (tryDecodeFrame(rec.line) as AcceptFrame).from === r.h.buyer.did)).toHaveLength(1);
    await r.seller.lockLegB(acceptBRecord); // the Seller locks leg B under the contract the Buyer kept
  });

  it("a pairing other than the saved one is refused", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const fail = failVenuePosts(r.h.venue, (_room, line) => isFrame(line, "accept") && (tryDecodeFrame(line) as AcceptFrame).from === r.h.buyer.did);
    await expect(r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    await restartBuyer(r);
    // a record whose text differs from the saved leg B offer: the saved pairing wins (and it does not even authenticate)
    const other = { ...accepted.offerBRecord, line: accepted.offerBRecord.line + " " };
    await expect(r.buyer.acceptLegB(other, accepted.acceptARecord, legA.lockTimeMs)).rejects.toThrow();
  });
});

describe("resume: account lines (rules 1 and 3)", () => {
  it("a line saved but not posted is posted as the identical text; another address is refused; a posted line is adopted", async () => {
    const r = rig();
    const p = await toPaired(r);
    const room = dealRoom(p.contractA);
    const fail = failVenuePosts(r.h.venue, (roomName, line) => roomName === room && isLine(line));
    await expect(r.buyer.postAccountLineA(r.h.buyerWallet.publicKey)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const saved = await buyerRecord(r);
    expect(saved.ownAccountLine?.address).toBe(r.h.buyerWallet.publicKey);
    expect((await r.h.venue.read(room)).filter((rec) => rec.sender === r.h.buyer.did)).toHaveLength(0);

    expect(await restartBuyer(r)).toBe("postAccountLineA");
    await expect(r.buyer.postAccountLineA(r.h.sellerWallet.publicKey)).rejects.toBeInstanceOf(FlowRecordConflictError); // never a second, different line
    const record = await r.buyer.postAccountLineA(r.h.buyerWallet.publicKey);
    expect(record.line).toBe(saved.ownAccountLine!.text);
    const again = await r.buyer.postAccountLineA(r.h.buyerWallet.publicKey); // adopted, not posted twice
    expect(again.seq).toBe(record.seq);
    expect((await r.h.venue.read(room)).filter((rec) => rec.sender === r.h.buyer.did)).toHaveLength(1);
  });

  it("no line is posted after the lock: an adopted line stays one line, and a missing one is refused once this Buyer's lock was attempted", async () => {
    const r = rig();
    const p = await toLocked(r);
    const room = dealRoom(p.contractA);
    const ownLines = async () => (await r.h.venue.read(room)).filter((rec) => rec.sender === r.h.buyer.did && isLine(rec.line));
    expect(await ownLines()).toHaveLength(1);
    await expect(r.buyer.postAccountLineA(r.h.buyerWallet.publicKey)).resolves.toBeDefined(); // present: adopted
    expect(await ownLines()).toHaveLength(1);

    // the line has vanished from the room (a venue that lost it): re-posting it now would put it AFTER the lock frame
    const rooms = (r.h.venue as unknown as { rooms: Map<string, unknown[]> }).rooms;
    rooms.set(room, (rooms.get(room) as Array<{ line: string; sender: string }>).filter((rec) => !(rec.sender === r.h.buyer.did && isLine(rec.line))));
    expect(await ownLines()).toHaveLength(0);
    await restartBuyer(r);
    await expect(r.buyer.postAccountLineA(r.h.buyerWallet.publicKey)).rejects.toBeInstanceOf(FlowRecordConflictError);
    expect(await ownLines()).toHaveLength(0);
  });

  it("the Seller's saved line is not posted once leg A's lock frame is in the room (it would not count)", async () => {
    const r = rig();
    const p = await toPaired(r);
    const room = dealRoom(p.contractA);
    const fail = failVenuePosts(r.h.venue, (roomName, line) => roomName === room && isLine(line));
    await expect(r.seller.postAccountLineA(r.h.sellerWallet.publicKey)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    // a lock frame appears in the room (here the Buyer's, posted directly)
    const lockText = encodeFrameWith({ type: "lock", from: r.h.buyer.did, contract: p.contractA, rail: SOL_RAIL_ID, ref: `${p.accepted.acceptA.statement}:${r.h.buyerWallet.publicKey}` }, r.h.buyerRail.railRegistry);
    await r.h.venue.post(room, lockText, r.h.buyer);
    await restartSeller(r);
    await expect(r.seller.postAccountLineA(r.h.sellerWallet.publicKey)).rejects.toBeInstanceOf(FlowRecordConflictError);
    expect((await r.h.venue.read(room)).filter((rec) => rec.sender === r.h.seller.did)).toHaveLength(0);
  });
});

describe("resume: Seller lock B (rules 1 and 3, the closed gap)", () => {
  it("the note was written but the lock frame never posted: the same call again adopts the note and posts the frame once", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
    const roomB = dealRoom(acceptB.contract);
    const fail = failVenuePosts(r.h.venue, (room, line) => room === roomB && isFrame(line, "lock"));
    await expect(r.seller.lockLegB(acceptBRecord)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    expect(await framesOf(r, roomB, "lock")).toHaveLength(0);
    const saved = await sellerRecord(r);
    expect(saved.attemptedAcceptB).toBe(acceptB.contract);
    expect(saved.lockedLegBContract).toBe(acceptB.contract); // the note write landed and was recorded

    expect(await restartSeller(r)).toBe("lockLegB");
    const frame = await r.seller.lockLegB(acceptBRecord);
    expect(isFrame(frame.line, "lock")).toBe(true);
    expect(await framesOf(r, roomB, "lock")).toHaveLength(1);
    await r.seller.lockLegB(acceptBRecord); // confirmed: the recorded frame, no second one
    expect(await framesOf(r, roomB, "lock")).toHaveLength(1);
    await r.buyer.verifyLegBLocked();
  });

  it("dies before the note is written: the attempt was saved, the restart writes the note once and posts the frame", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
    const dyingPaper = Object.create(r.h.sellerOptions.paperRail, {
      lock: {
        value: async () => {
          throw new ProcessDied("before the note write");
        },
      },
    }) as typeof r.h.sellerOptions.paperRail;
    await restartSeller(r, { paperRail: dyingPaper });
    await expect(r.seller.lockLegB(acceptBRecord)).rejects.toBeInstanceOf(ProcessDied);
    const saved = await sellerRecord(r);
    expect(saved.attemptedAcceptB).toBe(acceptB.contract);
    expect(saved.lockedLegBContract).toBeUndefined(); // attempted, outcome unknown
    await restartSeller(r);
    await r.seller.lockLegB(acceptBRecord);
    expect(await framesOf(r, dealRoom(acceptB.contract), "lock")).toHaveLength(1);
    await r.buyer.verifyLegBLocked();
  });
  it("the note write committed but its acknowledgement was lost: the saved attempt is adopted by a read, not written twice", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
    const lossy = new CommitsThenThrowsOnce(r.h.noteStore);
    // the write commits, the acknowledgement is lost, and the process dies before it can read the note back
    const dyingPaper = Object.create(new PaperRail(lossy, r.h.clock), {
      verifyLock: {
        value: async () => {
          throw new ProcessDied("before the verification read");
        },
      },
    }) as PaperRail;
    await restartSeller(r, { paperRail: dyingPaper });
    await expect(r.seller.lockLegB(acceptBRecord)).rejects.toBeInstanceOf(ProcessDied);
    const saved = await sellerRecord(r);
    expect(saved.attemptedAcceptB).toBe(acceptB.contract);
    expect(saved.lockedLegBContract).toBeUndefined(); // the flow cannot tell from the exception alone (E2)
    expect(await framesOf(r, dealRoom(acceptB.contract), "lock")).toHaveLength(0);

    await restartSeller(r);
    await r.seller.lockLegB(acceptBRecord); // paperRail.lock refuses ("already has a record"), the read finds our terms: adopted
    expect((await sellerRecord(r)).lockedLegBContract).toBe(acceptB.contract);
    expect(await framesOf(r, dealRoom(acceptB.contract), "lock")).toHaveLength(1);
    await r.buyer.verifyLegBLocked();
  });

  it("the note write committed and its acknowledgement was lost, but the process lived: the very same call reads the note back and goes on", async () => {
    const r = rig();
    const offerA = await bid(r);
    const accepted = await r.seller.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await r.buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, legA.lockTimeMs);
    await restartSeller(r, { paperRail: new PaperRail(new CommitsThenThrowsOnce(r.h.noteStore), r.h.clock) });
    await r.seller.lockLegB(acceptBRecord);
    expect((await sellerRecord(r)).lockedLegBContract).toBe(acceptB.contract);
    expect(await framesOf(r, dealRoom(acceptB.contract), "lock")).toHaveLength(1);
  });
});

describe("resume: Buyer lock A (rules 1, 2 and 4)", () => {
  it("commitLock landed but its reply was lost: the restart finds it by signature, posts the lock frame once and signs nothing", async () => {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { after: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    expect(r.h.node.sent.lock).toBe(1);
    const saved = await buyerRecord(r);
    expect(saved.lock.attempted).toBe(true);
    expect(saved.lock.prepared?.recovery?.chain).toBe("sol"); // the signature was saved BEFORE the send
    expect(saved.lock.evidence).toBeUndefined();
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(0);

    expect(await restartBuyer(r)).toBe("lockLegA");
    const result = await r.buyer.lockLegA();
    expect(result.writeEvidence.ref).toBe(saved.lock.prepared!.ref);
    expect(r.h.node.sent.lock).toBe(1); // no second lock
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
    expect((await buyerRecord(r)).lock).toMatchObject({ framePosted: true });
    expect(await restartBuyer(r)).toBe("learnSecret");
  });

  it("dies before commitLock: pending while the signed blockhash is valid (nothing new signed), then one fresh lock after it expired", async () => {
    const r = rig();
    const p = await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { before: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    expect(r.h.node.sent.lock).toBe(0);
    const saved = await buyerRecord(r);
    const handle = saved.lock.prepared!.recovery!;
    if (handle.chain !== "sol") throw new Error("expected a sol handle");

    await restartBuyer(r);
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(LockPendingError);
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(LockPendingError); // still pending; still nothing signed
    expect(r.h.node.sent.lock).toBe(0);

    // the blockhash expires on the chain with no status for the old signature: now a fresh lock is provably safe
    r.h.node.chain.finalizedHeight = handle.lastValidBlockHeight + 1;
    r.h.node.chain.blockhash = base58.encode(new Uint8Array(32).fill(0x66));
    r.h.node.chain.lastValidBlockHeight = handle.lastValidBlockHeight + 400;
    await r.buyer.lockLegA();
    expect(r.h.node.sent.lock).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "lock")).toHaveLength(1);
    const after = await buyerRecord(r);
    expect(after.lock.prepared!.recovery).not.toEqual(handle); // the fresh handle replaced the dead one
    expect(after.lock.prepared!.ref).toBe(saved.lock.prepared!.ref);
  });

  it("a restart does not skip the guards: deadlines that are no longer safe stop the recovery before the chain is asked", async () => {
    const r = rig();
    await toLines(r);
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { before: ["commitLock"] }) });
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    await restartBuyer(r);
    r.h.setTime(legA.refundAfterMs); // far too late for a safe lock
    await expect(r.buyer.lockLegA()).rejects.toThrow(/deadlines are no longer safe at lock time/);
    expect(r.h.node.sent.lock).toBe(0);
  });

  it("the lock frame failed to post after the lock landed: the same call again posts the saved frame once (no second lock)", async () => {
    const r = rig();
    const p = await toLines(r);
    const roomA = dealRoom(p.contractA);
    const fail = failVenuePosts(r.h.venue, (room, line) => room === roomA && isFrame(line, "lock"));
    await expect(r.buyer.lockLegA()).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    expect(r.h.node.sent.lock).toBe(1);
    const saved = await buyerRecord(r);
    expect(saved.lock.evidence).toBeDefined(); // confirmed before the frame
    expect(await restartBuyer(r)).toBe("lockLegA");
    await r.buyer.lockLegA();
    expect(r.h.node.sent.lock).toBe(1);
    const frames = await framesOf(r, roomA, "lock");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.line).toBe(ledgerEntry(await buyerRecord(r), "lock-a")!.text);
  });
});

describe("resume: Seller claim A (rules 1, 2 and 3)", () => {
  it("the claim landed and the reply was lost: the restart resolves the saved signature, posts reveal and receipt once, sends no second claim", async () => {
    const r = rig();
    const p = await toLocked(r);
    await restartSeller(r, { rail: crashRail(r.h.sellerRail, { after: ["claim"] }) });
    await expect(r.seller.claimLegA(r.seller.statement!)).rejects.toBeInstanceOf(ProcessDied);
    expect(r.h.node.sent.claim).toBe(1);
    const saved = await sellerRecord(r);
    expect(saved.claimAttempted).toBe(true);
    expect(saved.claimRecords).toHaveLength(1); // the signature was saved BEFORE the send
    expect(await framesOf(r, dealRoom(p.contractA), "reveal")).toHaveLength(0);

    expect(await restartSeller(r)).toBe("claimLegA");
    const result = await r.seller.claimLegA(r.seller.statement!);
    expect(result.reveal).toBeDefined();
    expect(r.h.node.sent.claim).toBe(1);
    for (const type of ["reveal", "receipt"]) expect(await framesOf(r, dealRoom(p.contractA), type)).toHaveLength(1);
    const done = await sellerRecord(r);
    expect(done.claimOutcome).toBe("landed");
    expect(done.claimRecords).toHaveLength(0);
    expect(await restartSeller(r)).toBe("done");
  });

  it("dies before the claim is sent: nothing was signed, the restart does the ordinary guarded claim once", async () => {
    const r = rig();
    await toLocked(r);
    await restartSeller(r, { rail: crashRail(r.h.sellerRail, { before: ["claim"] }) });
    await expect(r.seller.claimLegA(r.seller.statement!)).rejects.toBeInstanceOf(ProcessDied);
    expect(r.h.node.sent.claim).toBe(0);
    const saved = await sellerRecord(r);
    expect(saved.claimAttempted).toBe(true);
    expect(saved.claimRecords).toHaveLength(0);
    await restartSeller(r);
    await r.seller.claimLegA(r.seller.statement!);
    expect(r.h.node.sent.claim).toBe(1);
  });

  it("the claim landed but the reveal never posted: the restart posts the saved reveal (the same bytes) without claiming again", async () => {
    const r = rig();
    const p = await toLocked(r);
    const roomA = dealRoom(p.contractA);
    const fail = failVenuePosts(r.h.venue, (room, line) => room === roomA && isFrame(line, "reveal"), 3);
    await expect(r.seller.claimLegA(r.seller.statement!)).rejects.toThrow(/reveal frame did not post/);
    fail.restore();
    expect(r.h.node.sent.claim).toBe(1);
    const saved = await sellerRecord(r);
    expect(saved.claimOutcome).toBe("landed");
    const revealText = ledgerEntry(saved, "reveal-a")!.text;
    expect(revealText).toContain(r.h.sellerLock.preimage); // the Seller's own record may hold it (rule 5)

    await restartSeller(r);
    await r.seller.claimLegA(r.seller.statement!);
    expect(r.h.node.sent.claim).toBe(1);
    const reveals = await framesOf(r, roomA, "reveal");
    expect(reveals).toHaveLength(1);
    expect(reveals[0]!.line).toBe(revealText);
    expect(await framesOf(r, roomA, "receipt")).toHaveLength(1);
  });
});

describe("resume: Buyer leg B claim (rules 1 and 3, the closed paper gap)", () => {
  it("the paper note was claimed but the frames never posted: the repeat posts them and the note write is not repeated", async () => {
    const r = rig();
    const p = await toLocked(r);
    await r.seller.claimLegA(r.seller.statement!);
    const secret = await r.buyer.learnSecret();
    const roomB = dealRoom(p.contractB);
    const fail = failVenuePosts(r.h.venue, (room, line) => room === roomB && isFrame(line, "reveal"));
    await expect(r.buyer.claimLegB(secret)).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const saved = await buyerRecord(r);
    expect(saved.legBClaimed).toBe(true);
    expect(await framesOf(r, roomB, "reveal")).toHaveLength(0);

    expect(await restartBuyer(r)).toBe("learnSecret"); // the secret is read again, never stored
    const again = await r.buyer.claimLegB(await r.buyer.learnSecret());
    expect(isFrame(again.reveal.line, "reveal")).toBe(true);
    expect(await framesOf(r, roomB, "reveal")).toHaveLength(1);
    expect(await framesOf(r, roomB, "receipt")).toHaveLength(1);
    // rule 5: the Buyer's record never holds the secret; the reveal's ledger entry is a digest of its text
    const done = await buyerRecord(r);
    expect(ledgerEntry(done, "reveal-b")!.text).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const save of r.buyerStore.saves) expect(Buffer.from(save.bytes).toString("utf8")).not.toContain(r.h.sellerLock.preimage.slice(2));
    expect(await restartBuyer(r)).toBe("done");
  });

  it("the note write committed and the process died before it recorded that: the repeat sees our secret on the note and goes on", async () => {
    const r = rig();
    const p = await toLocked(r);
    await r.seller.claimLegA(r.seller.statement!);
    const secret = await r.buyer.learnSecret();
    const real = r.h.buyerOptions.paperRail;
    const dyingPaper = Object.create(real, {
      claim: {
        value: async (ref: string, s: string) => {
          await real.claim(ref, s); // the write lands ...
          throw new ProcessDied("after the note write"); // ... and the process never learns it
        },
      },
      read: {
        value: async () => {
          throw new ProcessDied("before reading the note back");
        },
      },
    }) as PaperRail;
    await restartBuyer(r, { paperRail: dyingPaper });
    await expect(r.buyer.claimLegB(secret)).rejects.toBeInstanceOf(ProcessDied);
    const saved = await buyerRecord(r);
    expect(saved.legBClaimAttempted).toBe(true);
    expect(saved.legBClaimed).toBe(false);
    await restartBuyer(r);
    await r.buyer.claimLegB(secret); // paperRail.claim now throws "claim on a claimed record"; the note shows this very secret
    expect((await buyerRecord(r)).legBClaimed).toBe(true);
    expect(await framesOf(r, dealRoom(p.contractB), "reveal")).toHaveLength(1);
    expect(await framesOf(r, dealRoom(p.contractB), "receipt")).toHaveLength(1);
  });

  it("a claim attempted with no known outcome blocks the refund (a refund never follows a leg B claim)", async () => {
    const r = rig();
    await toLocked(r);
    await r.seller.claimLegA(r.seller.statement!);
    const secret = await r.buyer.learnSecret();
    const dyingPaper = Object.create(r.h.buyerOptions.paperRail, {
      claim: {
        value: async () => {
          throw new ProcessDied("before the note write");
        },
      },
    }) as typeof r.h.buyerOptions.paperRail;
    await restartBuyer(r, { paperRail: dyingPaper });
    await expect(r.buyer.claimLegB(secret)).rejects.toBeInstanceOf(ProcessDied);
    await restartBuyer(r);
    r.h.setTime(legA.refundAfterMs);
    await expect(r.buyer.refundLegA()).rejects.toThrow(/claim of leg B was attempted/);
    expect(r.h.node.sent.refund).toBe(0);
    await r.buyer.claimLegB(secret); // the claim goes through, nothing stranded
  });
});

describe("resume: refunds (rules 1, 2 and 3)", () => {
  it("the Buyer's refund landed and the reply was lost: the restart recovers it by the saved signature and posts the frames once", async () => {
    const r = rig();
    const p = await toLocked(r);
    r.h.setTime(legA.refundAfterMs);
    // the refund lands; its reply is lost; and the process dies before it can recognise the success from the chain
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { after: ["refund"], before: ["verifyLockFinal"] }) });
    await expect(r.buyer.refundLegA()).rejects.toBeInstanceOf(ProcessDied);
    expect(r.h.node.sent.refund).toBe(1);
    const saved = await buyerRecord(r);
    expect(saved.refund.attempted).toBe(true);
    expect(saved.refund.recovery?.chain).toBe("sol"); // the refund signature was saved BEFORE the send
    expect(await framesOf(r, dealRoom(p.contractA), "refund")).toHaveLength(0);

    expect(await restartBuyer(r)).toBe("refundLegA");
    await r.buyer.refundLegA();
    expect(r.h.node.sent.refund).toBe(1);
    for (const type of ["refund", "receipt"]) expect(await framesOf(r, dealRoom(p.contractA), type)).toHaveLength(1);
    expect(await restartBuyer(r)).toBe("done");
  });

  it("dies before the refund is signed: no handle, the chain is read, exactly one refund is built", async () => {
    const r = rig();
    await toLocked(r);
    r.h.setTime(legA.refundAfterMs);
    await restartBuyer(r, { rail: crashRail(r.h.buyerRail, { before: ["refund"] }) });
    await expect(r.buyer.refundLegA()).rejects.toBeInstanceOf(ProcessDied);
    expect((await buyerRecord(r)).refund).toMatchObject({ attempted: true });
    expect((await buyerRecord(r)).refund.recovery).toBeUndefined();
    await restartBuyer(r);
    await r.buyer.refundLegA();
    expect(r.h.node.sent.refund).toBe(1);
  });

  it("a refund the node accepted but has not landed is awaited, never duplicated; once its blockhash expired one fresh refund is built", async () => {
    const r = rig();
    const p = await toLocked(r);
    r.h.setTime(legA.refundAfterMs);
    r.h.node.chain.once("sendTransaction", (params) => base58.encode(Buffer.from(params[0] as string, "base64").subarray(1, 65))); // accepted, never lands
    await expect(r.buyer.refundLegA()).rejects.toThrow();
    const saved = await buyerRecord(r);
    const handle = saved.refund.recovery;
    if (handle?.chain !== "sol") throw new Error("expected a sol refund handle");
    await restartBuyer(r);
    await expect(r.buyer.refundLegA()).rejects.toThrow(/not yet confirmed/);
    await expect(r.buyer.refundLegA()).rejects.toThrow(/not yet confirmed/);
    expect(r.h.node.sent.refund).toBe(0); // no second refund while the first could still land

    r.h.node.chain.finalizedHeight = handle.lastValidBlockHeight + 1;
    r.h.node.chain.blockhash = base58.encode(new Uint8Array(32).fill(0x77));
    r.h.node.chain.lastValidBlockHeight = handle.lastValidBlockHeight + 400;
    await r.buyer.refundLegA();
    expect(r.h.node.sent.refund).toBe(1);
    expect(await framesOf(r, dealRoom(p.contractA), "refund")).toHaveLength(1);
  });

  it("the Seller's leg B refund: the note write committed and the process died before it recorded that; the repeat sees the refunded note and posts the frames", async () => {
    const r = rig();
    const p = await toPaired(r);
    r.h.setTime(legBDeadlines().refundAfterMs);
    const real = r.h.sellerOptions.paperRail;
    const dyingPaper = Object.create(real, {
      refund: {
        value: async (ref: string) => {
          await real.refund(ref);
          throw new ProcessDied("after the note write");
        },
      },
      read: {
        value: async () => {
          throw new ProcessDied("before reading the note back");
        },
      },
    }) as PaperRail;
    await restartSeller(r, { paperRail: dyingPaper });
    await expect(r.seller.refundLegB()).rejects.toBeInstanceOf(ProcessDied);
    expect((await sellerRecord(r)).legBRefund).toMatchObject({ attempted: true, done: false });
    await restartSeller(r);
    await r.seller.refundLegB(); // paperRail.refund throws "refund on a refunded record"; the note shows the refund
    expect(await framesOf(r, dealRoom(p.contractB), "refund")).toHaveLength(1);
    expect(await framesOf(r, dealRoom(p.contractB), "receipt")).toHaveLength(1);
  });

  it("the Seller's leg B refund: the note was refunded but the frames never posted; the repeat posts them (no 'refund on a refunded record')", async () => {
    const r = rig();
    const p = await toPaired(r);
    r.h.setTime(legBDeadlines().refundAfterMs);
    const roomB = dealRoom(p.contractB);
    const fail = failVenuePosts(r.h.venue, (room, line) => room === roomB && isFrame(line, "refund"));
    await expect(r.seller.refundLegB()).rejects.toBeInstanceOf(ProcessDied);
    fail.restore();
    const saved = await sellerRecord(r);
    expect(saved.legBRefund).toMatchObject({ attempted: true, done: true, framesPosted: false });
    expect(await restartSeller(r)).toBe("refundLegB");
    await r.seller.refundLegB();
    expect(await framesOf(r, roomB, "refund")).toHaveLength(1);
    expect(await framesOf(r, roomB, "receipt")).toHaveLength(1);
    expect(await restartSeller(r)).toBe("done");
  });
});

describe("resume: the preimage stays private (rule 5)", () => {
  it("is in no Buyer record, no flow's JSON or inspect output, and no reachable field of either flow, before the reveal", async () => {
    const r = rig();
    await toLocked(r);
    const secretHex = r.h.sellerLock.preimage.slice(2);
    for (const save of r.buyerStore.saves) expect(Buffer.from(save.bytes).toString("utf8")).not.toContain(secretHex);
    // the Seller's record is its one home
    expect(Buffer.from((await r.sellerStore.load(flowKey("seller", r.swapId)))!).toString("utf8")).toContain(secretHex);
    for (const flow of [r.seller, r.buyer]) {
      expect(JSON.stringify(flow)).not.toContain(secretHex);
      expect(inspect(flow, { depth: Infinity, showHidden: true })).not.toContain(secretHex);
      expect(deepHas(flow, secretHex)).toBe(false);
    }
    expect(JSON.parse(JSON.stringify(r.seller))).toMatchObject({ role: "seller", did: r.h.seller.did, statement: r.seller.statement });
    expect(JSON.parse(JSON.stringify(r.buyer))).toMatchObject({ role: "buyer", did: r.h.buyer.did, swapId: r.swapId });
    // a resumed flow is just as quiet
    await restartSeller(r);
    expect(JSON.stringify(r.seller)).not.toContain(secretHex);
    expect(deepHas(r.seller, secretHex)).toBe(false);
  });
});

/** A note store whose first set-if-absent commits and then throws (the write landed, the acknowledgement did not). */
class CommitsThenThrowsOnce implements NoteStore {
  private thrown = false;
  constructor(private readonly inner: NoteStore) {}
  get(ns: string, key: string): Promise<string | null> {
    return this.inner.get(ns, key);
  }
  async set(ns: string, key: string, value: string, condition?: { ifAbsent: true } | { if: string }): Promise<boolean> {
    const won = await this.inner.set(ns, key, value, condition);
    if (!this.thrown && condition !== undefined && "ifAbsent" in condition) {
      this.thrown = true;
      throw new Error("note store: connection reset after the write committed (test)");
    }
    return won;
  }
}

/** Walks a value's own properties and array/map/set entries looking for `needle` in any string. */
function deepHas(root: unknown, needle: string, seen = new WeakSet<object>()): boolean {
  if (typeof root === "string") return root.includes(needle);
  if (root === null || typeof root !== "object") return false;
  if (seen.has(root)) return false;
  seen.add(root);
  if (root instanceof Map) return [...root.values(), ...root.keys()].some((item) => deepHas(item, needle, seen));
  if (root instanceof Set) return [...root].some((item) => deepHas(item, needle, seen));
  if (ArrayBuffer.isView(root)) return Buffer.from(root.buffer, root.byteOffset, root.byteLength).toString("hex").includes(needle);
  return Reflect.ownKeys(root).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(root, key);
    return descriptor !== undefined && "value" in descriptor && deepHas(descriptor.value, needle, seen);
  });
}
