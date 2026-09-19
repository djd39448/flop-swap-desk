// SPDX-License-Identifier: MIT
//
// loadOffers (examples/audit-export.mjs): dedupe on the raw NDJSON lines before validation,
// so a watch root whose export ring recaptures the same window in every sweep is folded
// once per unique record, not once per file it happens to appear in. A follow-up to P0.5
// deliverable 3 — a real watch root (24 overlapping exports) made the naive per-file
// parseTranscriptExport-then-merge approach take minutes; this is the fix + regression test.

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeFrame, generateHashLock, makeAccept, makeOffer, OFFER_ROOM } from "@flop-labs/tclk";
import { legAContext, swapId as makeSwapId } from "../src/profile.js";
import { identity, record } from "./helpers/identity.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadOffers } from "../examples/audit-export.mjs";

const buyer = identity("a7".repeat(32));
const seller = identity("b8".repeat(32));
const T0 = 1_758_000_000_000;

function wireRow(rec: ReturnType<typeof record>) {
  return JSON.stringify({ seq: rec.seq, ts: new Date(rec.timestampMs).toISOString(), from: rec.sender, nonce: rec.nonce, sig: rec.signature, text: rec.line });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "audit-export-load-offers-"));
  await mkdir(join(root, "raw", OFFER_ROOM), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadOffers", () => {
  it("unions two overlapping exports, deduped by seq, and folds to the same records as a single non-duplicated export", async () => {
    const swapId = makeSwapId(buyer.did, "9001900190019001");
    const lock = generateHashLock();
    const offerA = makeOffer({
      from: buyer.did, role: "payer", amount: "1000", asset: "USDC", lock: "hash", rails: ["evm-htlc"],
      claimByMs: T0 + 3_600_000, refundAfterMs: T0 + 7_200_000, expiresMs: T0 + 600_000,
      job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
    });
    const acceptA = makeAccept(offerA, { from: seller.did, statement: lock.hash });
    const rowOffer = record(OFFER_ROOM, 1, T0, buyer, encodeFrame(offerA));
    const rowAccept = record(OFFER_ROOM, 2, T0 + 1000, seller, encodeFrame(acceptA));

    // File 1: just the offer. File 2 (a later sweep): the offer again (same seq, identical
    // bytes — the venue never rewrites a seq) plus the accept. File-name order matters:
    // "b" sorts after "a".
    await writeFile(join(root, "raw", OFFER_ROOM, "a-2026-09-18T00-00-00.000Z.jsonl"), `${wireRow(rowOffer)}\n`);
    await writeFile(
      join(root, "raw", OFFER_ROOM, "b-2026-09-18T00-10-00.000Z.jsonl"),
      `${wireRow(rowOffer)}\n${wireRow(rowAccept)}\n`,
    );

    const { records, malformedLines } = loadOffers(root);
    expect(malformedLines).toBe(0);
    expect(records.map((r: { seq: number }) => r.seq)).toEqual([1, 2]);
    // The retained line is byte-identical to the original signed line (no reserialization).
    expect(records[0].line).toBe(rowOffer.line);
    expect(records[1].line).toBe(rowAccept.line);
  });

  it("skips a malformed line (not JSON, and JSON but not a valid record) with a count, never throwing", async () => {
    const rowOffer = record(OFFER_ROOM, 1, T0, buyer, "tclk1 not-a-real-frame-but-well-formed-json-envelope");
    const goodLine = wireRow(rowOffer);
    const notJson = "{this is not json";
    const missingTs = JSON.stringify({ seq: 2, from: buyer.did, text: "x", nonce: "1", sig: "y" }); // no `ts`
    const badSeq = JSON.stringify({ seq: -1, ts: new Date(T0).toISOString(), from: buyer.did, text: "x" });

    await writeFile(
      join(root, "raw", OFFER_ROOM, "only.jsonl"),
      `${goodLine}\n${notJson}\n${missingTs}\n${badSeq}\n`,
    );

    const { records, malformedLines } = loadOffers(root);
    // notJson has no seq at all (fails the cheap check); missingTs has a seq but fails
    // transcriptRecord's own validation; badSeq fails the cheap non-negative check.
    expect(malformedLines).toBe(3);
    expect(records.length).toBe(1);
    expect(records[0].seq).toBe(1);
  });

  it("an empty (no raw/tclk-offers directory) root returns no records, no throw", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "audit-export-empty-"));
    try {
      const { records, malformedLines } = loadOffers(emptyRoot);
      expect(records).toEqual([]);
      expect(malformedLines).toBe(0);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
