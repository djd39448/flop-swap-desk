// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dealRoom,
  encodeFrame,
  encodePaperRecord,
  generateHashLock,
  makeAccept,
  makeOffer,
  paperNote,
  type LockFrame,
  type ReceiptFrame,
  type RevealFrame,
} from "@flop-labs/tclk";
import { buildBoard } from "../src/board.js";
import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { quoteBigNonces, runSweep, type RunSweepOptions } from "../src/watcher.js";
import { identity, record } from "./helpers/identity.js";
import { fakeBuildBoard } from "./helpers/fakeBoard.js";

const OFFER_ROOM = "tclk-offers";
const NOW = 1_735_000_000_000;

// Test-local identities (this test file's own seeds; tests/helpers/identity.ts is shared
// and owned by another builder, so it is imported, not extended, here).
const buyer = identity("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const seller = identity("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
const stranger = identity("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7");

function ndjson(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

/** The `?format=json` deal-room shape: `{messages:[...]}` (transcriptRecord's other input
 * shape besides the bare-array form; see src/watcher.ts's normalizeDealRoomBody). */
function dealRoomBody(rows: unknown[]): string {
  return JSON.stringify({ messages: rows });
}

/** One offer-room record, wire-shaped the way `/export` and `?format=json` both report it. */
function wireRow(seq: number, timestampMs: number, sender: string, nonce: string, sig: string, line: string) {
  return { seq, ts: new Date(timestampMs).toISOString(), from: sender, nonce, sig, text: line };
}

function rowFromRecord(rec: ReturnType<typeof record>) {
  return wireRow(rec.seq, rec.timestampMs, rec.sender, rec.nonce as string, rec.signature as string, rec.line);
}

/** Build one full swap pair (leg A + leg B, each offer+accept) at a given base seq/time. */
function buildSwap(nonceHex: string, baseSeq: number, baseMs: number) {
  const swapId = makeSwapId(buyer.did, nonceHex);
  const lock = generateHashLock();

  const legAOffer = makeOffer({
    from: buyer.did,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["evm-htlc"],
    claimByMs: baseMs + 3_600_000,
    refundAfterMs: baseMs + 7_200_000,
    expiresMs: baseMs + 600_000,
    job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash });

  const legBOffer = makeOffer({
    from: seller.did,
    role: "payer",
    amount: "52070000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc"],
    claimByMs: baseMs + 10_800_000,
    refundAfterMs: baseMs + 14_400_000,
    expiresMs: baseMs + 600_000,
    job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash });

  const rows = [
    record(OFFER_ROOM, baseSeq, baseMs, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, baseSeq + 1, baseMs + 1, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, baseSeq + 2, baseMs + 2, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, baseSeq + 3, baseMs + 3, buyer, encodeFrame(legBAccept)),
  ].map(rowFromRecord);

  return { swapId, lock, legAOffer, legAAccept, legBOffer, legBAccept, rows };
}

/**
 * Same shape as `buildSwap`, but both legs offer (and lock on) the `paper` rail — the way
 * the live G0 rehearsal actually ran (P05-SPEC.md "Live facts": both deal rooms' lock
 * frames say `"rail":"paper","ref":"<contract>"`). Leg B keeps `flop-htlc` alongside
 * `paper` in its offered rails so `checkOrientation` (src/profile.ts, decision D-01) still
 * accepts it. Deal-room frames (lock/reveal/receipt) are built on request so each test can
 * choose how far a leg gets.
 */
function buildPaperSwap(nonceHex: string, baseSeq: number, baseMs: number) {
  const swapId = makeSwapId(buyer.did, nonceHex);
  const lock = generateHashLock();

  const legAOffer = makeOffer({
    from: buyer.did,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["paper"],
    claimByMs: baseMs + 3_600_000,
    refundAfterMs: baseMs + 7_200_000,
    expiresMs: baseMs + 600_000,
    job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash });

  const legBOffer = makeOffer({
    from: seller.did,
    role: "payer",
    amount: "52070000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc", "paper"],
    claimByMs: baseMs + 10_800_000,
    refundAfterMs: baseMs + 14_400_000,
    expiresMs: baseMs + 600_000,
    job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash });

  const offerRows = [
    record(OFFER_ROOM, baseSeq, baseMs, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, baseSeq + 1, baseMs + 1, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, baseSeq + 2, baseMs + 2, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, baseSeq + 3, baseMs + 3, buyer, encodeFrame(legBAccept)),
  ].map(rowFromRecord);

  const dealRoomA = dealRoom(legAAccept.contract);
  const dealRoomB = dealRoom(legBAccept.contract);

  // Leg A: Buyer is payer (locks), Seller is payee (reveals). Leg B: Seller is payer
  // (locks), Buyer is payee (reveals) — SPEC §2, "the Seller always holds the secret".
  const lockA: LockFrame = { type: "lock", from: buyer.did, contract: legAAccept.contract, rail: "paper", ref: legAAccept.contract };
  const lockB: LockFrame = { type: "lock", from: seller.did, contract: legBAccept.contract, rail: "paper", ref: legBAccept.contract };
  const revealA: RevealFrame = { type: "reveal", from: seller.did, contract: legAAccept.contract, ref: legAAccept.contract, secret: lock.preimage };
  const revealB: RevealFrame = { type: "reveal", from: buyer.did, contract: legBAccept.contract, ref: legBAccept.contract, secret: lock.preimage };
  const receiptA: ReceiptFrame = { type: "receipt", from: buyer.did, contract: legAAccept.contract, outcome: "claimed", rail: "paper", ref: legAAccept.contract };
  const receiptB: ReceiptFrame = { type: "receipt", from: seller.did, contract: legBAccept.contract, outcome: "claimed", rail: "paper", ref: legBAccept.contract };

  function dealRowsA(baseDealMs: number, throughReceipt = true) {
    const rows = [
      rowFromRecord(record(dealRoomA, 1, baseDealMs, buyer, encodeFrame(lockA))),
      rowFromRecord(record(dealRoomA, 2, baseDealMs + 1, seller, encodeFrame(revealA))),
    ];
    if (throughReceipt) rows.push(rowFromRecord(record(dealRoomA, 3, baseDealMs + 2, buyer, encodeFrame(receiptA))));
    return rows;
  }
  function dealRowsB(baseDealMs: number, throughReceipt = true) {
    const rows = [
      rowFromRecord(record(dealRoomB, 1, baseDealMs, seller, encodeFrame(lockB))),
      rowFromRecord(record(dealRoomB, 2, baseDealMs + 1, buyer, encodeFrame(revealB))),
    ];
    if (throughReceipt) rows.push(rowFromRecord(record(dealRoomB, 3, baseDealMs + 2, seller, encodeFrame(receiptB))));
    return rows;
  }
  /** Just the lock frame — leg stops at `locked`, never reveals. */
  function lockOnlyRowsB(baseDealMs: number) {
    return [rowFromRecord(record(dealRoomB, 1, baseDealMs, seller, encodeFrame(lockB)))];
  }

  const noteA = paperNote(legAAccept.contract);
  const noteB = paperNote(legBAccept.contract);

  return {
    swapId,
    lock,
    legAOffer,
    legAAccept,
    legBOffer,
    legBAccept,
    offerRows,
    dealRoomA,
    dealRoomB,
    dealRowsA,
    dealRowsB,
    lockOnlyRowsB,
    noteA,
    noteB,
  };
}

/** Wrap a note value the way technocore's `/kv` GET does: banner line, blank line, value. */
function bannered(value: string): string {
  return `!! UNTRUSTED CONTENT — read-only rehearsal record, world-writable, not authoritative\n\n${value}\n`;
}

interface FakeResponse {
  status: number;
  body: string;
}

type Router = (url: string, init: { redirect?: string; signal?: AbortSignal }) => FakeResponse | "hang" | Error;

function makeFetch(router: Router, calls: Array<{ url: string; init: unknown }>): typeof fetch {
  return (async (input: unknown, init?: unknown) => {
    const url = String(input);
    calls.push({ url, init });
    const outcome = router(url, (init ?? {}) as { redirect?: string; signal?: AbortSignal });
    if (outcome === "hang") {
      return new Promise((_, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }) as Promise<never>;
    }
    if (outcome instanceof Error) throw outcome;
    return {
      status: outcome.status,
      text: async () => outcome.body,
    } as Response;
  }) as typeof fetch;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "swap-desk-watcher-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function baseOptions(overrides: Partial<RunSweepOptions> = {}): Omit<RunSweepOptions, "fetch"> {
  return {
    root,
    baseUrl: "https://technocore.example",
    nowMs: () => NOW,
    board: fakeBuildBoard,
    ...overrides,
  };
}

describe("runSweep", () => {
  it("persists the offers export byte-exactly, even with nothing swap-shaped in it", async () => {
    const exportBody = ndjson([
      wireRow(1, NOW - 1000, stranger.did, "1", stranger.sign(`${OFFER_ROOM}|1|hello`), "hello"),
    ]);
    const calls: Array<{ url: string; init: unknown }> = [];
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      return { status: 404, body: "" };
    }, calls);

    const report = await runSweep({ ...baseOptions(), fetch: fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.transport).toBeUndefined();

    const isoDir = await readdir(join(root, "raw", "tclk-offers"));
    expect(isoDir.length).toBe(1);
    const written = await readFile(join(root, "raw", "tclk-offers", isoDir[0]!), "utf8");
    expect(written).toBe(exportBody);
  });

  it("recovers a 19-digit bare-number transport nonce from the wire bytes (tclk #78/#149)", async () => {
    // Live shape verified 2026-09-18: the venue emits `"nonce":1789760314323907204` as a JSON
    // number past 2^53. Build the line by hand so the digits are exact on the wire, sign over
    // the exact decimal text, and check the record authenticates and the raw file is untouched.
    const nonce = "1789760314323907204";
    const line = "hello big nonce";
    const sig = stranger.sign(`${OFFER_ROOM}|${nonce}|${line}`);
    const exportBody =
      `{"seq":6461256,"ts":"2026-09-18T19:02:45.501592Z","from":"${stranger.did}",` +
      `"text":"${line}","nonce":${nonce},"sig":"${sig}"}\n`;
    const dealBody =
      `{\n "room": "x",\n "messages": [\n  {\n   "seq": 18,\n   "ts": "2026-09-18T07:39:35.780992Z",\n` +
      `   "from": "${stranger.did}",\n   "text": "${line}",\n   "nonce": ${nonce},\n   "sig": "${sig}"\n  }\n ]\n}`;
    expect(String(JSON.parse(exportBody).nonce)).not.toBe(nonce); // the rounding this guards against
    expect(quoteBigNonces(exportBody)).toContain(`"nonce":"${nonce}"`);
    expect(quoteBigNonces(dealBody)).toContain(`"nonce": "${nonce}"`);
    // A frame-internal escaped nonce is left alone.
    const escaped = '{"text":"tclk1 {\\"nonce\\":\\"582f1027dad682e0\\"}","nonce":42}';
    expect(quoteBigNonces(escaped)).toBe('{"text":"tclk1 {\\"nonce\\":\\"582f1027dad682e0\\"}","nonce":"42"}');

    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      return { status: 404, body: "" };
    }, []);
    const report = await runSweep({ ...baseOptions(), fetch: fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.offerParseError).toBeUndefined();
    expect(report.offerRecords).toBe(1);
    const isoDir = await readdir(join(root, "raw", "tclk-offers"));
    expect(await readFile(join(root, "raw", "tclk-offers", isoDir[0]!), "utf8")).toBe(exportBody);
  });

  it("reports a malformed export row as ok:false with parseError, and writes no board.json", async () => {
    const badBody = '{"seq": 1, "ts": "not-a-timestamp", "from": "x", "text": "y"}\n';
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: badBody };
      return { status: 404, body: "" };
    }, []);

    const report = await runSweep({ ...baseOptions(), fetch: fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.offerParseError).toBeTruthy();
    expect(existsSync(join(root, "board.json"))).toBe(false);

    // The raw bytes were still persisted before the parse was attempted.
    const isoDir = await readdir(join(root, "raw", "tclk-offers"));
    expect(isoDir.length).toBe(1);
    expect(await readFile(join(root, "raw", "tclk-offers", isoDir[0]!), "utf8")).toBe(badBody);
  });

  it("only fetches deal rooms for swap-leg contracts, capped at maxDealRooms (earliest first)", async () => {
    const swapA = buildSwap("aaaa0001", 1, NOW - 10_000);
    const swapB = buildSwap("aaaa0002", 10, NOW - 9_000);
    const swapC = buildSwap("aaaa0003", 20, NOW - 8_000);

    // A plain, non-swap tclk/1 handshake (no `job`) — its contract must never be polled.
    const plainOffer = makeOffer({
      from: stranger.did,
      role: "payer",
      amount: "5",
      asset: "USDC",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: NOW + 3_600_000,
      refundAfterMs: NOW + 7_200_000,
      expiresMs: NOW + 600_000,
    });
    const plainLock = generateHashLock();
    const plainAccept = makeAccept(plainOffer, { from: buyer.did, statement: plainLock.hash });
    const plainRows = [
      record(OFFER_ROOM, 30, NOW - 1000, stranger, encodeFrame(plainOffer)),
      record(OFFER_ROOM, 31, NOW - 999, buyer, encodeFrame(plainAccept)),
    ].map(rowFromRecord);

    const exportBody = ndjson([...swapA.rows, ...swapB.rows, ...swapC.rows, ...plainRows]);
    const calls: Array<{ url: string; init: unknown }> = [];
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      return { status: 200, body: dealRoomBody([]) };
    }, calls);

    const report = await runSweep({ ...baseOptions({ maxDealRooms: 3 }), fetch: fetchImpl });
    expect(report.ok).toBe(true);
    // Each swap contributes 2 candidate contracts (leg A + leg B); capped at 3.
    expect(report.dealRoomsFetched).toBe(3);

    const requestedRooms = calls.map((c) => c.url);
    const plainRoom = dealRoom(plainAccept.contract);
    expect(requestedRooms.some((u) => u.includes(plainRoom))).toBe(false);

    const swapARoomA = dealRoom(swapA.legAAccept.contract);
    const swapARoomB = dealRoom(swapA.legBAccept.contract);
    expect(requestedRooms.some((u) => u.includes(swapARoomA))).toBe(true);
    expect(requestedRooms.some((u) => u.includes(swapARoomB))).toBe(true);
  });

  it("records and skips a 404 deal room without failing the sweep", async () => {
    const swap = buildSwap("bbbb0001", 1, NOW - 10_000);
    const exportBody = ndjson(swap.rows);
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      return { status: 404, body: "" };
    }, []);

    const report = await runSweep({ ...baseOptions(), fetch: fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.dealRoomsFetched).toBe(0);
    expect(report.dealRoomsSkipped.length).toBeGreaterThan(0);
    expect(report.dealRoomsSkipped.every((s) => s.reason === "404")).toBe(true);
  });

  it("appends to swaps.jsonl only when a swap's status changes, and touches HIT exactly once", async () => {
    const swap = buildSwap("cccc0001", 1, NOW - 100_000);
    const exportBody = ndjson(swap.rows);
    const room = dealRoom(swap.legBAccept.contract);

    // Sweep 1: paired, no lock yet.
    const fetch1 = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      if (url.includes(room)) return { status: 200, body: dealRoomBody([]) };
      return { status: 404, body: "" };
    }, []);
    const report1 = await runSweep({ ...baseOptions(), fetch: fetch1 });
    expect(report1.ok).toBe(true);
    expect(report1.swapsWritten).toBe(1);
    expect(report1.hitCreated).toBe(true);

    // Sweep 2: identical state — no new line, no second HIT write.
    const fetch2 = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      if (url.includes(room)) return { status: 200, body: dealRoomBody([]) };
      return { status: 404, body: "" };
    }, []);
    const report2 = await runSweep({ ...baseOptions({ nowMs: () => NOW + 1000 }), fetch: fetch2 });
    expect(report2.ok).toBe(true);
    expect(report2.swapsWritten).toBe(0);
    expect(report2.hitCreated).toBe(false);

    // Sweep 3: leg B's deal room now shows a lock frame — status flips to b-locked.
    const lockFrame = {
      type: "lock" as const,
      from: seller.did,
      contract: swap.legBAccept.contract,
      rail: "flop-htlc",
      ref: "flop-escrow-1",
    };
    const lockRow = rowFromRecord(record(room, 1, NOW + 500, seller, encodeFrame(lockFrame)));
    const fetch3 = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      if (url.includes(room)) return { status: 200, body: dealRoomBody([lockRow]) };
      return { status: 404, body: "" };
    }, []);
    const report3 = await runSweep({ ...baseOptions({ nowMs: () => NOW + 2000 }), fetch: fetch3 });
    expect(report3.ok).toBe(true);
    expect(report3.swapsWritten).toBe(1);
    expect(report3.hitCreated).toBe(false); // already created in sweep 1

    const jsonlLines = (await readFile(join(root, "swaps.jsonl"), "utf8")).trim().split("\n");
    expect(jsonlLines.length).toBe(2);
    expect(JSON.parse(jsonlLines[0]!).status).toBe("paired");
    expect(JSON.parse(jsonlLines[1]!).status).toBe("b-locked");

    const hitContent = await readFile(join(root, "HIT"), "utf8");
    expect(hitContent.trim().split("\n").length).toBe(1);
  });

  it("refuses a redirected response (redirect: 'error' is always sent, and the failure is reported)", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) {
        return new TypeError("fetch failed: redirected, and redirect mode is set to 'error'");
      }
      return { status: 404, body: "" };
    }, calls);

    const report = await runSweep({ ...baseOptions(), fetch: fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.transport?.error).toContain("redirect");
    expect(existsSync(join(root, "board.json"))).toBe(false);
    expect(calls.length).toBe(1);
    expect((calls[0]!.init as { redirect?: string }).redirect).toBe("error");
  });

  it("reports a timed-out export fetch as a transport failure", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return "hang";
      return { status: 404, body: "" };
    }, []);

    const report = await runSweep({ ...baseOptions({ timeoutMs: 50 }), fetch: fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.transport).toBeDefined();
    expect(report.transport?.url).toContain("tclk-offers/export");
  }, 5000);

  it("never writes outside root", async () => {
    const swap = buildSwap("dddd0001", 1, NOW - 10_000);
    const exportBody = ndjson(swap.rows);
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
      return { status: 200, body: dealRoomBody([]) };
    }, []);

    const beforeSiblings = await readdir(tmpdir());
    await runSweep({ ...baseOptions(), fetch: fetchImpl });
    const afterSiblings = await readdir(tmpdir());

    // The only new top-level entry under the system temp dir is `root` itself (created by
    // mkdtemp before the sweep ran) — nothing new appeared beside it.
    const newEntries = afterSiblings.filter((e) => !beforeSiblings.includes(e));
    expect(newEntries).toEqual([]);
    expect(existsSync(join(root, "board.json"))).toBe(true);
  });

  describe("paper-rail note evidence (P0.5)", () => {
    async function soleFile(...dir: string[]): Promise<string> {
      const entries = await readdir(join(root, ...dir));
      expect(entries.length).toBe(1);
      return readFile(join(root, ...dir, entries[0]!), "utf8");
    }

    function findSwap(board: { swaps: Array<{ swapId: string | null }> }, swapId: string) {
      const found = board.swaps.find((s) => s.swapId === swapId);
      expect(found).toBeDefined();
      return found as { swapId: string; status: string; reasons: string[] };
    }

    it("fetches both legs' paper notes, persists them byte-exact, and folds a full rehearsal to settled with the rehearsal reason", async () => {
      const swap = buildPaperSwap("eeee0001", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);
      const dealBRows = swap.dealRowsB(NOW - 49_000);

      const noteAValue = encodePaperRecord({
        status: "claimed",
        lock: "hash",
        statement: swap.lock.hash,
        refundAfterMs: swap.legAOffer.refundAfterMs,
        secret: swap.lock.preimage,
      });
      const noteBValue = encodePaperRecord({
        status: "claimed",
        lock: "hash",
        statement: swap.lock.hash,
        refundAfterMs: swap.legBOffer.refundAfterMs,
        secret: swap.lock.preimage,
      });
      const noteABody = bannered(noteAValue);
      const noteBBody = bannered(noteBValue);

      const calls: Array<{ url: string; init: unknown }> = [];
      const fetchImpl = makeFetch((url) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
        if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
        if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody(dealBRows) };
        if (url.includes(`/kv/${swap.noteA.ns}/${swap.noteA.key}`)) return { status: 200, body: noteABody };
        if (url.includes(`/kv/${swap.noteB.ns}/${swap.noteB.key}`)) return { status: 200, body: noteBBody };
        return { status: 404, body: "" };
      }, calls);

      const report = await runSweep({ ...baseOptions({ board: buildBoard }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.dealRoomsFetched).toBe(2);
      expect(report.noteFetches).toBe(2);
      expect(report.noteFetchesSkipped).toEqual([]);
      // Only the offer export, the two deal rooms, and the two notes — nothing else.
      expect(calls.length).toBe(5);

      expect(await soleFile("raw", "kv", swap.noteA.ns, swap.noteA.key)).toBe(noteABody);
      expect(await soleFile("raw", "kv", swap.noteB.ns, swap.noteB.key)).toBe(noteBBody);

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = findSwap(board, swap.swapId);
      expect(view.status).toBe("settled");
      expect(view.reasons).toContain("paper rail: rehearsal only, no value");
    });

    it("a 404 note leaves the swap at revealed/awaiting finality", async () => {
      const swap = buildPaperSwap("eeee0002", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);
      const dealBRows = swap.dealRowsB(NOW - 49_000);

      const noteBValue = encodePaperRecord({
        status: "claimed",
        lock: "hash",
        statement: swap.lock.hash,
        refundAfterMs: swap.legBOffer.refundAfterMs,
        secret: swap.lock.preimage,
      });
      const noteBBody = bannered(noteBValue);

      const calls: Array<{ url: string; init: unknown }> = [];
      const fetchImpl = makeFetch((url) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
        if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
        if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody(dealBRows) };
        if (url.includes(`/kv/${swap.noteA.ns}/${swap.noteA.key}`)) return { status: 404, body: "" };
        if (url.includes(`/kv/${swap.noteB.ns}/${swap.noteB.key}`)) return { status: 200, body: noteBBody };
        return { status: 404, body: "" };
      }, calls);

      const report = await runSweep({ ...baseOptions({ board: buildBoard }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.noteFetches).toBe(1); // only B — A's note is absent
      expect(report.noteFetchesSkipped).toEqual([]); // a 404 is absence, not a skip
      expect(existsSync(join(root, "raw", "kv", swap.noteA.ns, swap.noteA.key))).toBe(false);
      expect(calls.length).toBe(5);

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = findSwap(board, swap.swapId);
      expect(view.status).toBe("revealed");
      expect(view.reasons).toContain("awaiting finality");
      expect(view.reasons).toContain("paper rail: rehearsal only, no value");
    });

    it("a note whose statement differs from the contract leaves the lock unverified", async () => {
      const swap = buildPaperSwap("eeee0003", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      // Leg A never locks; leg B locks but does not reveal.
      const dealBRows = swap.lockOnlyRowsB(NOW - 49_000);

      const wrongStatement = generateHashLock().hash; // deliberately not swap.lock.hash
      const noteBValue = encodePaperRecord({
        status: "locked",
        lock: "hash",
        statement: wrongStatement,
        refundAfterMs: swap.legBOffer.refundAfterMs,
      });
      const noteBBody = bannered(noteBValue);

      const calls: Array<{ url: string; init: unknown }> = [];
      const fetchImpl = makeFetch((url) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
        if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody([]) };
        if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody(dealBRows) };
        if (url.includes(`/kv/${swap.noteB.ns}/${swap.noteB.key}`)) return { status: 200, body: noteBBody };
        return { status: 404, body: "" };
      }, calls);

      const report = await runSweep({ ...baseOptions({ board: buildBoard }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.noteFetches).toBe(1); // A never locked on paper: no note candidate for it
      expect(calls.length).toBe(4); // export, dealRoomA, dealRoomB, noteB — no noteA

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = findSwap(board, swap.swapId);
      expect(view.status).toBe("paired");
      expect(view.reasons).toContain("leg B lock unverified");
    });
  });
});
