// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { encodeFunctionResult, type Address } from "viem";
import { buildBoard } from "../src/board.js";
import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { formatAccountLine, formatPubkeyLine } from "../src/rails/account-line.js";
import { BTC_REGTEST_PIN, type BtcRailConfig } from "../src/rails/btc-htlc.js";
import { BTC_REGTEST_NETWORK, buildHtlcScript } from "../src/rails/btc-script.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";
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

// `root` lives one level down inside a private `sandbox` so "never writes outside root" can
// check root's siblings without racing other test files (or anything else on the machine)
// creating entries directly under the shared system temp dir.
let sandbox: string;
let root: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "swap-desk-watcher-"));
  root = join(sandbox, "root");
  await mkdir(root);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
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

  it("classifies a non-2xx export response (a 502 gateway page) as a transport error, not a parse error, and says the status code (H4)", async () => {
    const gatewayPage = "<html><body>502 Bad Gateway</body></html>";
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 502, body: gatewayPage };
      return { status: 404, body: "" };
    }, []);

    const report = await runSweep({ ...baseOptions(), fetch: fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.offerParseError).toBeUndefined();
    expect(report.transport).toBeDefined();
    expect(report.transport?.error).toBe("http 502");
    expect(existsSync(join(root, "board.json"))).toBe(false);

    // A gateway error page is not the export: nothing was written under raw/tclk-offers/.
    expect(existsSync(join(root, "raw", "tclk-offers"))).toBe(false);
  });

  it("classifies a 503 export response the same way, with its own status code", async () => {
    const fetchImpl = makeFetch((url) => {
      if (url.endsWith("/r/tclk-offers/export")) return { status: 503, body: "Service Unavailable" };
      return { status: 404, body: "" };
    }, []);

    const report = await runSweep({ ...baseOptions(), fetch: fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.offerParseError).toBeUndefined();
    expect(report.transport?.error).toBe("http 503");
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
    // H3: settlementView rides beside status on every swaps.jsonl line.
    expect(JSON.parse(jsonlLines[0]!).settlementView).toEqual({ a: "none", b: "none" });
    expect(JSON.parse(jsonlLines[1]!).settlementView).toEqual({ a: "none", b: "none" });

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

    expect(await readdir(sandbox)).toEqual(["root"]);
    await runSweep({ ...baseOptions(), fetch: fetchImpl });

    // `root` is still the only entry in its private parent — nothing appeared beside it.
    expect(await readdir(sandbox)).toEqual(["root"]);
    expect(existsSync(join(root, "board.json"))).toBe(true);
  });

  describe("swap archive (H2, tclk#181)", () => {
    it("archives each leg's offer-room lines the first sweep that sees them, byte-exact, surviving a later sweep whose ring has already dropped the earlier lines", async () => {
      const swap = buildSwap("ffff0001", 1, NOW - 200_000);
      const legARows = swap.rows.slice(0, 2); // offerA, acceptA
      const legBRows = swap.rows.slice(2, 4); // offerB, acceptB

      // Sweep 1: only leg A is on the (synthetic) ring -- leg B hasn't been posted yet.
      const export1 = ndjson(legARows);
      const fetch1 = makeFetch((url) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: export1 };
        return { status: 200, body: dealRoomBody([]) };
      }, []);
      const report1 = await runSweep({ ...baseOptions(), fetch: fetch1 });
      expect(report1.ok).toBe(true);

      const legAOfferPath = join(root, "raw", "swaps", swap.swapId, "offer-room", `${legARows[0]!.seq}.line`);
      const legAAcceptPath = join(root, "raw", "swaps", swap.swapId, "offer-room", `${legARows[1]!.seq}.line`);
      expect(existsSync(legAOfferPath)).toBe(true);
      expect(existsSync(legAAcceptPath)).toBe(true);
      expect((await readFile(legAOfferPath, "utf8")).trim()).toBe(JSON.stringify(legARows[0]));
      expect((await readFile(legAAcceptPath, "utf8")).trim()).toBe(JSON.stringify(legARows[1]));

      // Sweep 2: the ring has rolled -- leg A's lines are gone from this sweep's export,
      // only leg B is now visible (leg B was just posted).
      const export2 = ndjson(legBRows);
      const fetch2 = makeFetch((url) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: export2 };
        return { status: 200, body: dealRoomBody([]) };
      }, []);
      const report2 = await runSweep({ ...baseOptions({ nowMs: () => NOW - 100_000 }), fetch: fetch2 });
      expect(report2.ok).toBe(true);

      // Leg A's archive is untouched (idempotent) even though sweep 2 never saw it again.
      expect(existsSync(legAOfferPath)).toBe(true);
      expect((await readFile(legAOfferPath, "utf8")).trim()).toBe(JSON.stringify(legARows[0]));

      const legBOfferPath = join(root, "raw", "swaps", swap.swapId, "offer-room", `${legBRows[0]!.seq}.line`);
      const legBAcceptPath = join(root, "raw", "swaps", swap.swapId, "offer-room", `${legBRows[1]!.seq}.line`);
      expect(existsSync(legBOfferPath)).toBe(true);
      expect(existsSync(legBAcceptPath)).toBe(true);
      expect((await readFile(legBOfferPath, "utf8")).trim()).toBe(JSON.stringify(legBRows[0]));
      expect((await readFile(legBAcceptPath, "utf8")).trim()).toBe(JSON.stringify(legBRows[1]));
    });

    it("archives a swap's deal-room capture under raw/swaps/<swapId>/deal-rooms/, refreshed every sweep", async () => {
      const swap = buildSwap("ffff0002", 1, NOW - 200_000);
      const exportBody = ndjson(swap.rows);
      const room = dealRoom(swap.legBAccept.contract);

      const fetch1 = makeFetch((url) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
        if (url.includes(room)) return { status: 200, body: dealRoomBody([]) };
        return { status: 404, body: "" };
      }, []);
      const report1 = await runSweep({ ...baseOptions(), fetch: fetch1 });
      expect(report1.ok).toBe(true);

      const archivePath = join(root, "raw", "swaps", swap.swapId, "deal-rooms", `${room}.json`);
      expect(existsSync(archivePath)).toBe(true);
      expect(await readFile(archivePath, "utf8")).toBe(dealRoomBody([]));

      const lockFrame = {
        type: "lock" as const,
        from: seller.did,
        contract: swap.legBAccept.contract,
        rail: "flop-htlc",
        ref: "flop-escrow-1",
      };
      const lockRow = rowFromRecord(record(room, 1, NOW - 90_000, seller, encodeFrame(lockFrame)));
      const fetch2 = makeFetch((url) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
        if (url.includes(room)) return { status: 200, body: dealRoomBody([lockRow]) };
        return { status: 404, body: "" };
      }, []);
      const report2 = await runSweep({ ...baseOptions({ nowMs: () => NOW - 80_000 }), fetch: fetch2 });
      expect(report2.ok).toBe(true);

      // Overwritten with the freshest body: a deal room accumulates frames over the swap's
      // life (lock, reveal, receipt, …), so only the latest capture has everything a replay
      // needs -- unlike the immutable offer-room lines above.
      expect(await readFile(archivePath, "utf8")).toBe(dealRoomBody([lockRow]));
    });
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
      return found as {
        swapId: string;
        status: string;
        reasons: string[];
        settlementView: { a: string; b: string };
      };
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
      // H3: both notes were claimed, so the rail evidence alone settles both legs' views.
      expect(view.settlementView).toEqual({ a: "claimed", b: "claimed" });
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

  describe("chain evidence (evm-htlc rail, P22-P24-EVM-SPEC.md §5)", () => {
    function addr(tag: string): Address {
      const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
      return `0x${hex}` as Address;
    }

    const RAIL_CONTRACT = addr("evm-rail-contract");
    const TOKEN = addr("usdc-token");
    const BUYER_ADDR = addr("buyer-evm-addr");
    const SELLER_ADDR = addr("seller-evm-addr");
    const BLOCK_HASH = `0x${"cd".repeat(32)}`;

    const EVM_CONFIG: EvmRailConfig = {
      pin: ANVIL_LOCAL_PIN,
      endpoint: "http://127.0.0.1:9999/rpc",
      contract: RAIL_CONTRACT,
      assets: { USDC: TOKEN },
    };

    /** Same shape as `buildSwap`, but leg A's own deal room also carries its `evm-htlc` lock
     *  frame (posted by its payer, the Buyer) and both parties' D-08 account lines. */
    function buildEvmSwap(nonceHex: string, baseSeq: number, baseMs: number) {
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

      const offerRows = [
        record(OFFER_ROOM, baseSeq, baseMs, buyer, encodeFrame(legAOffer)),
        record(OFFER_ROOM, baseSeq + 1, baseMs + 1, seller, encodeFrame(legAAccept)),
        record(OFFER_ROOM, baseSeq + 2, baseMs + 2, seller, encodeFrame(legBOffer)),
        record(OFFER_ROOM, baseSeq + 3, baseMs + 3, buyer, encodeFrame(legBAccept)),
      ].map(rowFromRecord);

      const dealRoomA = dealRoom(legAAccept.contract);
      const dealRoomB = dealRoom(legBAccept.contract);
      const legATerms = offerAcceptLockTerms(legAOffer, legAAccept);
      const lockA: LockFrame = { type: "lock", from: buyer.did, contract: legAAccept.contract, rail: "evm-htlc", ref: lock.hash };

      function dealRowsA(baseDealMs: number) {
        const sellerLine = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: SELLER_ADDR });
        const buyerLine = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: BUYER_ADDR });
        return [
          rowFromRecord(record(dealRoomA, 1, baseDealMs, buyer, encodeFrame(lockA))),
          rowFromRecord(record(dealRoomA, 2, baseDealMs + 1, seller, sellerLine)),
          rowFromRecord(record(dealRoomA, 3, baseDealMs + 2, buyer, buyerLine)),
        ];
      }

      return { swapId, lock, legAOffer, legAAccept, legBOffer, legBAccept, offerRows, dealRoomA, dealRoomB, legATerms, dealRowsA };
    }

    /** A locked-status `locks()` ABI-encoding matching `terms`, for the synthetic `eth_call`. */
    function encodeLockedResult(terms: { amount: string; claimByMs: number; refundAfterMs: number }): string {
      return encodeFunctionResult({
        abi: EVM_HASH_RAIL_ABI,
        functionName: "locks",
        result: [BUYER_ADDR, SELLER_ADDR, TOKEN, BigInt(terms.amount), BigInt(terms.claimByMs), BigInt(terms.refundAfterMs), 1 /* Locked */],
      });
    }

    type RpcOutcome = { result: unknown } | { errorMessage: string } | "throw";

    /** A combined fetch: technocore-style GET/POST responses (via `technocore`, same shape
     *  `makeFetch`'s router returns) plus JSON-RPC POSTs to `rpcEndpoint`, routed by the
     *  request body's own `method` field (through `rpcResult`). */
    function makeEvmFetch(opts: {
      technocore: (url: string) => FakeResponse;
      rpcEndpoint: string;
      rpcResult: (method: string, params: unknown) => RpcOutcome;
      calls: Array<{ url: string; body?: string }>;
    }): typeof fetch {
      return (async (input: unknown, init?: unknown) => {
        const url = String(input);
        const body = (init as { body?: string } | undefined)?.body;
        opts.calls.push({ url, body });
        if (url === opts.rpcEndpoint && typeof body === "string") {
          const parsed = JSON.parse(body) as { id: number; method: string; params: unknown };
          const outcome = opts.rpcResult(parsed.method, parsed.params);
          if (outcome === "throw") throw new TypeError(`rpc endpoint unreachable: ${parsed.method}`);
          const envelope =
            "errorMessage" in outcome
              ? { jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: outcome.errorMessage } }
              : { jsonrpc: "2.0", id: parsed.id, result: outcome.result };
          const text = JSON.stringify(envelope);
          const bytes = new TextEncoder().encode(text);
          return { status: 200, text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
        }
        const outcome = opts.technocore(url);
        return { status: outcome.status, text: async () => outcome.body } as Response;
      }) as typeof fetch;
    }

    function evmRpcResponder(callResult: string): (method: string, params: unknown) => RpcOutcome {
      return (method) => {
        if (method === "eth_chainId") return { result: `0x${ANVIL_LOCAL_PIN.chainId.toString(16)}` };
        if (method === "eth_getBlockByNumber") return { result: { number: "0x5", hash: BLOCK_HASH } };
        if (method === "eth_call") return { result: callResult };
        return { errorMessage: `unexpected method ${method}` };
      };
    }

    it("captures a locked evm-htlc leg live, writes raw/rpc + raw/evm + rails.json, and reports chainReads", async () => {
      const swap = buildEvmSwap("aaaa1001", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);
      const callResult = encodeLockedResult(swap.legATerms);

      const calls: Array<{ url: string; body?: string }> = [];
      const fetchImpl = makeEvmFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: evmRpcResponder(callResult),
        calls,
      });

      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG } }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.chainReads).toBe(1);
      expect(report.chainReadsSkipped).toEqual([]);

      const railsJson = JSON.parse(await readFile(join(root, "rails.json"), "utf8"));
      expect(railsJson).toEqual({ evm: EVM_CONFIG });

      const evmDir = join(root, "raw", "evm", swap.lock.hash);
      const evmFiles = await readdir(evmDir);
      expect(evmFiles.length).toBe(1);
      const index = JSON.parse(await readFile(join(evmDir, evmFiles[0]!), "utf8"));
      expect(index.hashLock).toBe(swap.lock.hash);
      expect(index.exchanges).toHaveLength(3);

      const rpcFiles = await readdir(join(root, "raw", "rpc"));
      expect(rpcFiles.length).toBe(3);

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = board.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(view).toBeDefined();
      expect(view.evidence.aRail).toMatchObject({ status: "locked", final: true });
      expect(view.evidence.a.railVerified).toBe(true);
    });

    // P22-P24-EVM-FIXES-R2.md D7: a live-vs-replay equivalence test through the *real* watcher
    // (`runSweep`, not a hand-built index/config fixture) and the *real* `examples/audit-
    // export.mjs` CLI (a genuine child process), at two different `nowMs` values — the sweep's
    // own fixed `NOW` (2025-12-24) versus the CLI's baked-in `Date.now()` (whenever this test
    // actually runs, always meaningfully later). The verdict must agree either way, since it
    // rests on the capture's own frozen `checkedAtMs` (A7), never on whichever wall clock
    // happened to be replaying it.
    it("D7: the real watcher's own live capture replays identically through the real audit-export CLI, at a different nowMs", async () => {
      const swap = buildEvmSwap("aaaa1099", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);
      const callResult = encodeLockedResult(swap.legATerms);

      const calls: Array<{ url: string; body?: string }> = [];
      const fetchImpl = makeEvmFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: evmRpcResponder(callResult),
        calls,
      });

      // The real watcher, live, at its own fixed sweep time (`baseOptions`'s `nowMs: () => NOW`).
      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG } }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.chainReads).toBe(1);

      const liveBoard = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const liveView = liveBoard.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(liveView).toBeDefined();
      expect(liveView.evidence.a.railVerified).toBe(true);
      expect(liveView.settlementView.a).toBe("funded");

      // The real audit-export CLI, replaying the exact same on-disk root the sweep above just
      // wrote — its own `nowMs` is `Date.now()`, never overridden, genuinely different from
      // `NOW` (fixed, always in the past relative to whenever this test runs).
      const script = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "audit-export.mjs");
      const result = spawnSync(process.execPath, [script, "--root", root, "--json"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      const replayed = JSON.parse(result.stdout) as {
        swaps: Array<{
          swapId: string;
          settlementView: { a: string };
          finalizedRefs: string[];
          evidence: { a?: { railVerified: boolean | null; reason?: string; finalizedRef?: string }; aRail?: unknown };
        }>;
      };
      const replayedSwap = replayed.swaps.find((s) => s.swapId === swap.swapId);
      expect(replayedSwap).toBeDefined();
      expect(replayedSwap!.settlementView.a).toBe(liveView.settlementView.a);
      expect(replayedSwap!.finalizedRefs.some((ref) => ref.startsWith("anvil-local:finalized:5:"))).toBe(true);

      // P22-P24-EVM-FIXES-R3.md F4: compare the actual verdict in full, never just the coarser
      // settlementView a mismatched reason or a stale rail observation could still coincide on.
      expect(replayedSwap!.evidence.a?.railVerified).toBe(liveView.evidence.a.railVerified);
      expect(replayedSwap!.evidence.a?.reason).toBe(liveView.evidence.a.reason);
      expect(replayedSwap!.evidence.a?.finalizedRef).toBe(liveView.evidence.a.finalizedRef);
      expect(replayedSwap!.evidence.aRail).toEqual(liveView.evidence.aRail);
    });

    it("a second sweep with the same config does not rewrite rails.json", async () => {
      const swap = buildEvmSwap("aaaa1002", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const fetchImpl = makeEvmFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          return { status: 200, body: dealRoomBody([]) };
        },
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: evmRpcResponder(encodeLockedResult(swap.legATerms)),
        calls: [],
      });

      await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG } }), fetch: fetchImpl });
      const firstWrite = await readFile(join(root, "rails.json"), "utf8");
      await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG }, nowMs: () => NOW + 1000 }), fetch: fetchImpl });
      const secondWrite = await readFile(join(root, "rails.json"), "utf8");
      expect(secondWrite).toBe(firstWrite);
    });

    it("P22-P24-EVM-FIXES-R3.md F1: a transport failure on the chain read is recorded as a skip AND writes this sweep's own failure index", async () => {
      const swap = buildEvmSwap("aaaa1003", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);

      const fetchImpl = makeEvmFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: () => "throw",
        calls: [],
      });

      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG } }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.chainReads).toBe(0);
      expect(report.chainReadsSkipped).toHaveLength(1);
      expect(report.chainReadsSkipped![0]!.contract).toBe(swap.legAAccept.contract);

      // F1: a failure index IS written for this sweep's own hashLock — never silently absent —
      // so a later replay's "latest capture" is this sweep's own failed attempt, never whatever
      // an earlier sweep may have left behind (the pre-F1 behaviour this test used to pin: no
      // raw/evm directory at all).
      const evmDir = join(root, "raw", "evm", swap.lock.hash);
      const files = await readdir(evmDir);
      expect(files).toHaveLength(1);
      const failureIndex = JSON.parse(await readFile(join(evmDir, files[0]!), "utf8"));
      expect(typeof failureIndex.error).toBe("string");
      expect(failureIndex.exchanges).toEqual([]);
      expect(report.chainReadsSkipped![0]!.reason).toBe(failureIndex.error);

      // The live board reports no verdict for this leg — never a stale "locked" for a chain it
      // could not actually read this sweep.
      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = board.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(view.evidence.a.railVerified).toBeNull();
    });

    it("P22-P24-EVM-FIXES-R3.md F1: the reviewer's rate-limited second sweep — live and replay agree, never the first sweep's stale success", async () => {
      const swap = buildEvmSwap("aaaa1006", 1, NOW - 200_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 150_000);
      const callResult = encodeLockedResult(swap.legATerms);

      const technocore = (url: string) => {
        if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
        if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
        if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
        return { status: 404, body: "" };
      };

      // Sweep 1: the endpoint is healthy — a clean, verified Locked capture.
      const firstFetch = makeEvmFetch({ technocore, rpcEndpoint: EVM_CONFIG.endpoint, rpcResult: evmRpcResponder(callResult), calls: [] });
      const firstReport = await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG } }), fetch: firstFetch });
      expect(firstReport.chainReads).toBe(1);
      const firstBoard = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const firstView = firstBoard.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(firstView.evidence.a.railVerified).toBe(true);

      // Sweep 2, a little later: the endpoint is now rate-limited on every RPC call — a
      // genuine JSON-RPC error reply (recorded, not a transport failure), the reviewer's own
      // probe.
      const secondFetch = makeEvmFetch({
        technocore,
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: () => ({ errorMessage: "rate limited, try again" }),
        calls: [],
      });
      const secondReport = await runSweep({
        ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG }, nowMs: () => NOW + 1000 }),
        fetch: secondFetch,
      });
      expect(secondReport.chainReads).toBe(0);
      expect(secondReport.chainReadsSkipped).toHaveLength(1);

      const secondBoard = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const secondView = secondBoard.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      // The live board never keeps serving sweep 1's stale "true" once sweep 2 has its own
      // (failed) attempt on file — this sweep's own verdict is "could not check".
      expect(secondView.evidence.a.railVerified).toBeNull();

      // The offline replay of the exact same on-disk root reaches the identical verdict: its
      // "latest capture" for this hashLock is sweep 2's own failed attempt, never sweep 1's
      // stale (but genuinely captured) success.
      const script = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "audit-export.mjs");
      const result = spawnSync(process.execPath, [script, "--root", root, "--json"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      const replayed = JSON.parse(result.stdout) as {
        swaps: Array<{ swapId: string; evidence: { a?: { railVerified: boolean | null } } }>;
      };
      const replayedSwap = replayed.swaps.find((s) => s.swapId === swap.swapId);
      expect(replayedSwap).toBeDefined();
      expect(replayedSwap!.evidence.a?.railVerified ?? null).toBeNull();
      expect(replayedSwap!.evidence.a?.railVerified ?? null).toBe(secondView.evidence.a.railVerified);
    });

    it("no rails configured: no RPC endpoint is ever touched, and the report carries no chain fields at all", async () => {
      const swap = buildEvmSwap("aaaa1004", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);
      const calls: Array<{ url: string; body?: string }> = [];

      const fetchImpl = makeEvmFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: () => "throw", // would blow up the sweep if ever called
        calls,
      });

      // No `options.rails` at all — the live watch's own default.
      const report = await runSweep({ ...baseOptions({ board: buildBoard }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.chainReads).toBeUndefined();
      expect(report.chainReadsSkipped).toBeUndefined();
      expect(calls.some((c) => c.url === EVM_CONFIG.endpoint)).toBe(false);
      expect(existsSync(join(root, "rails.json"))).toBe(false);
      expect(existsSync(join(root, "raw", "evm"))).toBe(false);

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = board.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(view).toBeDefined();
      expect(view.evidence.aRail).toBeUndefined();
      expect(view.evidence.a).toBeUndefined();
    });

    // P22-P24-EVM-FIXES.md A6 (deliberate behaviour change): the fetch decision (whether to
    // spend a live RPC round trip capturing a leg) is driven by the lock the tclk contract
    // machine actually accepted, never merely the first authenticated-looking payer frame.
    it("A6: a rejected lock frame (wrong rail for this leg) followed by the accepted evm-htlc one is what gets captured live", async () => {
      const swap = buildEvmSwap("aaaa1005", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);

      // buildEvmSwap's legA offers only ["evm-htlc"] — a "paper" lock is never an offered
      // rail, so tclk's own machine rejects it; the payer's later evm-htlc lock is accepted.
      const rejectedPaperLockA: LockFrame = { type: "lock", from: buyer.did, contract: swap.legAAccept.contract, rail: "paper", ref: swap.legAAccept.contract };
      const acceptedEvmLockA: LockFrame = { type: "lock", from: buyer.did, contract: swap.legAAccept.contract, rail: "evm-htlc", ref: swap.lock.hash };
      const sellerLine = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: SELLER_ADDR });
      const buyerLine = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: BUYER_ADDR });
      const dealARows = [
        rowFromRecord(record(swap.dealRoomA, 1, NOW - 50_000, buyer, encodeFrame(rejectedPaperLockA))),
        rowFromRecord(record(swap.dealRoomA, 2, NOW - 49_000, buyer, encodeFrame(acceptedEvmLockA))),
        rowFromRecord(record(swap.dealRoomA, 3, NOW - 48_000, seller, sellerLine)),
        rowFromRecord(record(swap.dealRoomA, 4, NOW - 47_000, buyer, buyerLine)),
      ];
      const callResult = encodeLockedResult(swap.legATerms);

      const fetchImpl = makeEvmFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: evmRpcResponder(callResult),
        calls: [],
      });

      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG } }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.chainReads).toBe(1);
      expect(report.chainReadsSkipped).toEqual([]);

      const evmDir = join(root, "raw", "evm", swap.lock.hash);
      const evmFiles = await readdir(evmDir);
      expect(evmFiles.length).toBe(1);
      const index = JSON.parse(await readFile(join(evmDir, evmFiles[0]!), "utf8"));
      expect(index.hashLock).toBe(swap.lock.hash);

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = board.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(view).toBeDefined();
      expect(view.evidence.a.rail).toBe("evm-htlc");
      expect(view.evidence.a.railVerified).toBe(true);
    });

    // P22-P24-EVM-FIXES.md A3: a malformed `options.rails.evm` fails the whole sweep closed,
    // before Step 1 (the offer-room fetch) ever runs — not merely "chain reads skipped".
    it("A3: a malformed options.rails.evm fails the sweep closed, before any fetch at all", async () => {
      const swap = buildEvmSwap("aaaa1006", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const calls: Array<{ url: string; body?: string }> = [];
      const fetchImpl = makeEvmFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          return { status: 200, body: dealRoomBody([]) };
        },
        rpcEndpoint: EVM_CONFIG.endpoint,
        rpcResult: () => "throw", // would fail the test with an unrelated message if ever reached
        calls,
      });

      // Ethereum mainnet (1) is off the A3 allow list (31337/84532 only).
      const badConfig: EvmRailConfig = { ...EVM_CONFIG, pin: { ...EVM_CONFIG.pin, chainId: 1, caip2: "eip155:1" } };
      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: badConfig } }), fetch: fetchImpl });

      expect(report.ok).toBe(false);
      expect(report.railsConfigError).toMatch(/not on the allow list/);
      expect(calls).toEqual([]); // nothing was ever fetched — not even the offer-room export
      expect(existsSync(join(root, "board.json"))).toBe(false);
    });
  });

  // P4-BTC-SPEC.md §7: the btc-htlc twin of the evm-htlc "chain evidence" block above — same
  // "nothing runs unless the caller configured this rail" contract, adapted for Bitcoin's own
  // shape (an opaque funding outpoint, node-level JSON-RPC reads instead of eth_call).
  describe("chain evidence (btc-htlc rail, P4-BTC-SPEC.md §7)", () => {
    const FUND_TXID = "ab08a3ba29a27d8ccbc37fe3efe3f56018e34978328bc421361e688dc8d66694";
    const FUND_VOUT = 1;
    const REF = `${FUND_TXID}:${FUND_VOUT}`;
    const AMOUNT_SATS = 100_000_000n;
    const PAYEE_PUBKEY = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a"; // seller
    const PAYER_PUBKEY = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627"; // buyer
    const TIP_HEIGHT = 110;
    const FUNDING_BLOCK_HASH = "bb".repeat(32);

    const BTC_CONFIG: BtcRailConfig = { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:19999" };

    /** Same shape as `buildEvmSwap`, but leg A's rail is `btc-htlc`, its own outpoint `ref` is
     *  fixed (`REF` — chosen at fund time, never derived from terms), and its deal room carries
     *  both parties' D-08 pubkey lines (P4-BTC-SPEC.md §6), not a single account line. */
    function buildBtcSwap(nonceHex: string, baseSeq: number, baseMs: number) {
      const swapId = makeSwapId(buyer.did, nonceHex);
      const lock = generateHashLock();

      const legAOffer = makeOffer({
        from: buyer.did,
        role: "payer",
        amount: AMOUNT_SATS.toString(),
        asset: "BTC",
        lock: "hash",
        rails: ["btc-htlc"],
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

      const offerRows = [
        record(OFFER_ROOM, baseSeq, baseMs, buyer, encodeFrame(legAOffer)),
        record(OFFER_ROOM, baseSeq + 1, baseMs + 1, seller, encodeFrame(legAAccept)),
        record(OFFER_ROOM, baseSeq + 2, baseMs + 2, seller, encodeFrame(legBOffer)),
        record(OFFER_ROOM, baseSeq + 3, baseMs + 3, buyer, encodeFrame(legBAccept)),
      ].map(rowFromRecord);

      const dealRoomA = dealRoom(legAAccept.contract);
      const dealRoomB = dealRoom(legBAccept.contract);
      const legATerms = offerAcceptLockTerms(legAOffer, legAAccept);
      const lockA: LockFrame = { type: "lock", from: buyer.did, contract: legAAccept.contract, rail: "btc-htlc", ref: REF };

      function dealRowsA(baseDealMs: number) {
        const sellerLine = formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: PAYEE_PUBKEY });
        const buyerLine = formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: PAYER_PUBKEY });
        return [
          rowFromRecord(record(dealRoomA, 1, baseDealMs, buyer, encodeFrame(lockA))),
          rowFromRecord(record(dealRoomA, 2, baseDealMs + 1, seller, sellerLine)),
          rowFromRecord(record(dealRoomA, 3, baseDealMs + 2, buyer, buyerLine)),
        ];
      }

      return { swapId, lock, legAOffer, legAAccept, legBOffer, legBAccept, offerRows, dealRoomA, dealRoomB, legATerms, dealRowsA };
    }

    function scriptFor(hashLockHex: string, locktime: number) {
      return buildHtlcScript(
        { hashLock: hexToBytes(hashLockHex.slice(2)), payeePubkey: hexToBytes(PAYEE_PUBKEY), payerPubkey: hexToBytes(PAYER_PUBKEY), locktime },
        BTC_REGTEST_NETWORK,
      );
    }

    /** A 2-output funding transaction whose vout `FUND_VOUT` output is the real HTLC script for
     *  `hashLockHex`/`locktime` — the same technique tests/btc-evidence.test.ts's own
     *  `fakeRawFundingTxHex` uses. */
    function fakeRawFundingTxHex(scriptPubKey: Uint8Array, amountSats: bigint): string {
      const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
      tx.addInput({ txid: new Uint8Array(32), index: 0, witnessUtxo: { amount: 1n, script: new Uint8Array([0x00]) } });
      tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(0)]), amount: 1_000_000n });
      tx.addOutput({ script: scriptPubKey, amount: amountSats });
      return bytesToHex(tx.unsignedTx);
    }

    type RpcOutcome = { result: unknown } | { errorMessage: string } | "throw";

    /** A combined fetch: technocore-style GET/POST responses plus JSON-RPC POSTs to
     *  `rpcEndpoint` (bitcoind-shaped, no `path` distinction needed here since the watcher's own
     *  btc chain-read step never targets a per-wallet path — see `captureBtcLeg`). */
    function makeBtcFetch(opts: {
      technocore: (url: string) => FakeResponse;
      rpcEndpoint: string;
      rpcResult: (method: string, params: unknown) => RpcOutcome;
      calls: Array<{ url: string; body?: string; headers?: Record<string, string> }>;
    }): typeof fetch {
      return (async (input: unknown, init?: unknown) => {
        const url = String(input);
        const initObj = init as { body?: string; headers?: Record<string, string> } | undefined;
        opts.calls.push({ url, body: initObj?.body, headers: initObj?.headers });
        if (url === opts.rpcEndpoint && typeof initObj?.body === "string") {
          const parsed = JSON.parse(initObj.body) as { id: number | string; method: string; params: unknown };
          const outcome = opts.rpcResult(parsed.method, parsed.params);
          if (outcome === "throw") throw new TypeError(`rpc endpoint unreachable: ${parsed.method}`);
          const envelope =
            "errorMessage" in outcome
              ? { jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: outcome.errorMessage } }
              : { jsonrpc: "2.0", id: parsed.id, result: outcome.result };
          const text = JSON.stringify(envelope);
          const bytes = new TextEncoder().encode(text);
          return { status: 200, text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
        }
        const outcome = opts.technocore(url);
        return { status: outcome.status, text: async () => outcome.body } as Response;
      }) as typeof fetch;
    }

    /** Responds as a funded, unspent, sufficiently-confirmed outpoint whose funding script
     *  matches `terms`. */
    function btcRpcResponder(terms: { statement: string; refundAfterMs: number }): (method: string, params: unknown) => RpcOutcome {
      const locktime = terms.refundAfterMs / 1000;
      const scriptPubKey = scriptFor(terms.statement, locktime).scriptPubKey;
      const rawHex = fakeRawFundingTxHex(scriptPubKey, AMOUNT_SATS);
      return (method, params) => {
        if (method === "getblockchaininfo") return { result: { chain: "regtest", blocks: TIP_HEIGHT } };
        if (method === "getblockhash" && Array.isArray(params) && params[0] === 0) return { result: BTC_REGTEST_PIN.genesisHash };
        if (method === "getrawtransaction") return { result: { hex: rawHex, confirmations: 2, blockhash: FUNDING_BLOCK_HASH } };
        if (method === "gettxout") return { result: { confirmations: 2, value: 1.0, scriptPubKey: { hex: bytesToHex(scriptPubKey) } } };
        if (method === "getblockheader") return { result: { height: TIP_HEIGHT - 1 } }; // H6: real height, read directly
        return { errorMessage: `unexpected method ${method}` };
      };
    }

    it("captures a locked btc-htlc leg live, writes raw/rpc + raw/btc + rails.json, and reports btcChainReads", async () => {
      const swap = buildBtcSwap("bbbb1001", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);

      const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = [];
      const fetchImpl = makeBtcFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: BTC_CONFIG.endpoint,
        rpcResult: btcRpcResponder({ statement: swap.lock.hash, refundAfterMs: swap.legAOffer.refundAfterMs }),
        calls,
      });

      const report = await runSweep({
        ...baseOptions({ board: buildBoard, rails: { btc: BTC_CONFIG }, btcRpcHeaders: () => ({ Authorization: "Basic dGVzdDp0ZXN0" }) }),
        fetch: fetchImpl,
      });
      expect(report.ok).toBe(true);
      expect(report.btcChainReads).toBe(1);
      expect(report.btcChainReadsSkipped).toEqual([]);
      // chainReads (the EVM field) never appears at all — this sweep never configured rails.evm.
      expect(report.chainReads).toBeUndefined();

      const railsJson = JSON.parse(await readFile(join(root, "rails.json"), "utf8"));
      expect(railsJson).toEqual({ btc: BTC_CONFIG });

      const btcDir = join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`);
      const btcFiles = await readdir(btcDir);
      expect(btcFiles.length).toBe(1);
      const index = JSON.parse(await readFile(join(btcDir, btcFiles[0]!), "utf8"));
      expect(index.ref).toBe(REF);
      // H6 added a fifth exchange (getblockheader, for the funding block's real height).
      expect(index.exchanges).toHaveLength(5);

      const rpcFiles = await readdir(join(root, "raw", "rpc"));
      expect(rpcFiles.length).toBe(5);

      // The node's cookie-derived auth header reached the RPC call but was never recorded on
      // any captured exchange, request body, or written index/rails.json (the keyless rule's
      // "never logged, never persisted" extended to the RPC cookie, P4-BTC-SPEC.md §1/§4).
      const rpcCall = calls.find((c) => c.url === BTC_CONFIG.endpoint);
      expect(rpcCall?.headers?.Authorization).toBe("Basic dGVzdDp0ZXN0");
      const wholeIndexText = JSON.stringify(index);
      expect(wholeIndexText).not.toContain("Authorization");
      expect(wholeIndexText).not.toContain("dGVzdDp0ZXN0");
      expect(JSON.stringify(railsJson)).not.toContain("dGVzdDp0ZXN0");

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = board.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(view).toBeDefined();
      expect(view.evidence.aRail).toMatchObject({ status: "locked", final: true });
      expect(view.evidence.a.railVerified).toBe(true);
    });

    it("a transport failure on the btc chain read is recorded as a skip AND writes this sweep's own failure index (mirrors F1)", async () => {
      const swap = buildBtcSwap("bbbb1002", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);

      const fetchImpl = makeBtcFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: BTC_CONFIG.endpoint,
        rpcResult: () => "throw",
        calls: [],
      });

      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { btc: BTC_CONFIG } }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.btcChainReads).toBe(0);
      expect(report.btcChainReadsSkipped).toHaveLength(1);
      expect(report.btcChainReadsSkipped![0]!.contract).toBe(swap.legAAccept.contract);

      const btcDir = join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`);
      const files = await readdir(btcDir);
      expect(files).toHaveLength(1);
      const failureIndex = JSON.parse(await readFile(join(btcDir, files[0]!), "utf8"));
      expect(typeof failureIndex.error).toBe("string");
      expect(failureIndex.exchanges).toEqual([]);
      expect(report.btcChainReadsSkipped![0]!.reason).toBe(failureIndex.error);

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = board.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(view.evidence.a.railVerified).toBeNull();
    });

    it("no rails configured: no RPC endpoint is ever touched, and the report carries no btc chain fields at all", async () => {
      const swap = buildBtcSwap("bbbb1003", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);
      const calls: Array<{ url: string; body?: string }> = [];

      const fetchImpl = makeBtcFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: BTC_CONFIG.endpoint,
        rpcResult: () => "throw",
        calls,
      });

      const report = await runSweep({ ...baseOptions({ board: buildBoard }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.btcChainReads).toBeUndefined();
      expect(report.btcChainReadsSkipped).toBeUndefined();
      expect(calls.some((c) => c.url === BTC_CONFIG.endpoint)).toBe(false);
      expect(existsSync(join(root, "rails.json"))).toBe(false);
      expect(existsSync(join(root, "raw", "btc"))).toBe(false);

      const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
      const view = board.swaps.find((s: { swapId: string }) => s.swapId === swap.swapId);
      expect(view).toBeDefined();
      expect(view.evidence.aRail).toBeUndefined();
      expect(view.evidence.a).toBeUndefined();
    });

    it("A3 (mirrored): a malformed options.rails.btc fails the sweep closed, before any fetch at all", async () => {
      const swap = buildBtcSwap("bbbb1004", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const calls: Array<{ url: string; body?: string }> = [];
      const fetchImpl = makeBtcFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          return { status: 200, body: dealRoomBody([]) };
        },
        rpcEndpoint: BTC_CONFIG.endpoint,
        rpcResult: () => "throw",
        calls,
      });

      // "mainnet" is off the allow list (regtest/signet only).
      const badConfig = { ...BTC_CONFIG, pin: { ...BTC_CONFIG.pin, network: "mainnet" as unknown as "regtest" } };
      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { btc: badConfig } }), fetch: fetchImpl });

      expect(report.ok).toBe(false);
      expect(report.railsConfigError).toMatch(/not on the allow list/);
      expect(calls).toEqual([]);
      expect(existsSync(join(root, "board.json"))).toBe(false);
    });

    it("both rails configured: rails.json carries both, keyed evm-first-then-btc", async () => {
      const swap = buildBtcSwap("bbbb1005", 1, NOW - 100_000);
      const exportBody = ndjson(swap.offerRows);
      const dealARows = swap.dealRowsA(NOW - 50_000);
      const EVM_CONFIG: EvmRailConfig = {
        pin: ANVIL_LOCAL_PIN,
        endpoint: "http://127.0.0.1:9998/rpc",
        contract: "0x1111111111111111111111111111111111111111".slice(0, 42) as `0x${string}`,
        assets: {},
      };

      const fetchImpl = makeBtcFetch({
        technocore: (url) => {
          if (url.endsWith("/r/tclk-offers/export")) return { status: 200, body: exportBody };
          if (url.includes(swap.dealRoomA)) return { status: 200, body: dealRoomBody(dealARows) };
          if (url.includes(swap.dealRoomB)) return { status: 200, body: dealRoomBody([]) };
          return { status: 404, body: "" };
        },
        rpcEndpoint: BTC_CONFIG.endpoint,
        rpcResult: btcRpcResponder({ statement: swap.lock.hash, refundAfterMs: swap.legAOffer.refundAfterMs }),
        calls: [],
      });

      const report = await runSweep({ ...baseOptions({ board: buildBoard, rails: { evm: EVM_CONFIG, btc: BTC_CONFIG } }), fetch: fetchImpl });
      expect(report.ok).toBe(true);
      expect(report.btcChainReads).toBe(1);
      // The evm rail was configured but its own endpoint was never touched by this test's
      // fetch, so its own chain read fails closed as a skip — irrelevant to what this test
      // pins (rails.json's own key order/shape with both configured).
      const railsJson = JSON.parse(await readFile(join(root, "rails.json"), "utf8"));
      expect(Object.keys(railsJson)).toEqual(["evm", "btc"]);
      expect(railsJson).toEqual({ evm: EVM_CONFIG, btc: BTC_CONFIG });
    });
  });
});
