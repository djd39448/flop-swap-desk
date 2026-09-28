// SPDX-License-Identifier: MIT
//
// loadArchivedOfferLines / loadDealRoomsFromSwapArchive (examples/audit-export.mjs, H2,
// tclk#181): the offers room is a byte ring that only holds "tens of minutes" of traffic, so
// a long-running watch root's own `raw/tclk-offers/*.jsonl` union can end up missing a seq an
// old (since-rotated) sweep once saw. This proves the offline replay still folds a swap fully
// when leg A's offer/accept exist ONLY in `raw/swaps/<swapId>/offer-room/` — i.e. after
// whatever export file first captured them is gone — by exercising exactly the merge
// `examples/audit-export.mjs`'s `main()` performs, not a reimplementation of it.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeFrame, generateHashLock, makeAccept, makeOffer, OFFER_ROOM } from "@flop-labs/tclk";
import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { foldCaptured } from "../src/replay.js";
import { identity, record } from "./helpers/identity.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadOffers, loadArchivedOfferLines } from "../examples/audit-export.mjs";

const buyer = identity("a3".repeat(32));
const seller = identity("b4".repeat(32));
const T0 = 1_758_000_000_000;
const MIN = 60_000;

function wireRow(rec: ReturnType<typeof record>) {
  return JSON.stringify({ seq: rec.seq, ts: new Date(rec.timestampMs).toISOString(), from: rec.sender, nonce: rec.nonce, sig: rec.signature, text: rec.line });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "audit-export-swap-archive-"));
  await mkdir(join(root, "raw", OFFER_ROOM), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadArchivedOfferLines + loadOffers merge (mirrors examples/audit-export.mjs main())", () => {
  it("replays a swap to 'paired' from only.jsonl (leg B) + the swap archive (leg A) after the ring has rolled past leg A", async () => {
    const swapId = makeSwapId(buyer.did, "a00ba00ba00ba00b");
    const lock = generateHashLock();

    const offerA = makeOffer({
      from: buyer.did, role: "payer", amount: "1000", asset: "USDC", lock: "hash", rails: ["evm-htlc"],
      claimByMs: T0 + 45 * MIN, refundAfterMs: T0 + 60 * MIN, expiresMs: T0 + 30 * MIN,
      job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
    });
    const acceptA = makeAccept(offerA, { from: seller.did, statement: lock.hash });
    const offerB = makeOffer({
      from: seller.did, role: "payer", amount: "52070000", asset: "FLOP", lock: "hash", rails: ["flop-htlc"],
      claimByMs: T0 + 70 * MIN, refundAfterMs: T0 + 180 * MIN, expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: swapId, context: legBContext(offerA.id) },
    });
    const acceptB = makeAccept(offerB, { from: buyer.did, statement: lock.hash });

    const rowOfferA = record(OFFER_ROOM, 1, T0, buyer, encodeFrame(offerA));
    const rowAcceptA = record(OFFER_ROOM, 2, T0 + 1 * MIN, seller, encodeFrame(acceptA));
    const rowOfferB = record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(offerB));
    const rowAcceptB = record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(acceptB));

    // Only leg B is in the (sole remaining) offer-room export -- leg A's lines rolled off the
    // venue's ring, and whatever earlier `raw/tclk-offers/*.jsonl` file once captured them has
    // since been pruned. This is the "ring no longer has the lines" state H2 exists for.
    await writeFile(
      join(root, "raw", OFFER_ROOM, "only.jsonl"),
      `${wireRow(rowOfferB)}\n${wireRow(rowAcceptB)}\n`,
    );

    // Leg A survives only in the per-swap archive the watcher wrote while it still had it.
    await mkdir(join(root, "raw", "swaps", swapId, "offer-room"), { recursive: true });
    await writeFile(join(root, "raw", "swaps", swapId, "offer-room", "1.line"), `${wireRow(rowOfferA)}\n`);
    await writeFile(join(root, "raw", "swaps", swapId, "offer-room", "2.line"), `${wireRow(rowAcceptA)}\n`);

    const { records: ringOffers } = loadOffers(root);
    expect(ringOffers.map((r: { seq: number }) => r.seq)).toEqual([3, 4]);

    // Without the archive, leg B's offer names a leg-A offer id nobody has ever seen: unpaired.
    const ringOnlyBoard = await foldCaptured({ offers: ringOffers, dealRooms: new Map(), notes: new Map(), nowMs: T0 + 4 * MIN });
    expect(ringOnlyBoard.swaps).toHaveLength(0);
    expect(ringOnlyBoard.unpaired).toEqual([{ offerId: offerB.id, reason: "leg B names an unknown leg A offer id" }]);

    // Exactly the merge examples/audit-export.mjs's main() performs: the ring union, with any
    // seq it is missing filled in from the swap archive.
    const archived = loadArchivedOfferLines(root);
    expect(archived.map((r: { seq: number }) => r.seq).sort((a: number, b: number) => a - b)).toEqual([1, 2]);
    const bySeq = new Map(ringOffers.map((r: { seq: number }) => [r.seq, r]));
    for (const r of archived) if (!bySeq.has(r.seq)) bySeq.set(r.seq, r);
    const offers = [...bySeq.values()].sort((a: { seq: number }, b: { seq: number }) => a.seq - b.seq);
    expect(offers.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3, 4]);

    const board = await foldCaptured({ offers, dealRooms: new Map(), notes: new Map(), nowMs: T0 + 4 * MIN });
    const view = board.swaps.find((s) => s.swapId === swapId);
    expect(view).toBeDefined();
    expect(view!.status).toBe("paired");
    expect(view!.buyerDid).toBe(buyer.did);
    expect(view!.sellerDid).toBe(seller.did);
  });

  it("an empty (no raw/swaps directory) root returns no archived records, no throw", () => {
    expect(loadArchivedOfferLines(root)).toEqual([]);
  });
});
