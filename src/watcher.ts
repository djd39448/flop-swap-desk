// SPDX-License-Identifier: MIT
//
// P0.4 — the read-only watcher. Mirrors agentsearch-hermes/bin/deal_watch.py's shape (same
// endpoints, "never posts" contract, exit-code semantics) but folds through @flop-labs/tclk's
// fail-closed decoders instead of a hand-rolled JSON sniff, and produces the board (SPEC §4)
// instead of a flat log. Every write stays under `options.root`. Nothing here signs or posts;
// a signing/payment key in scope would be a bug.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  OFFER_ROOM,
  dealRoom,
  parseTranscriptExport,
  transcriptRecord,
  tryDecodeFrame,
  verifyTranscriptRecord,
  type TclkFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { classifySwapOffer } from "./profile.js";
import type { Board, BoardInput, SwapStatus } from "./types.js";

// SPEC §4 order; "reaches paired or later" = rank ≥ `paired`, never the two failure states
// (`unpaired`, `orientation-unsupported`), which never passed through it.
const STATUS_RANK: Record<SwapStatus, number> = {
  bid: 0,
  accepted: 1,
  paired: 2,
  "b-locked": 3,
  "a-locked": 4,
  revealed: 5,
  settled: 6,
  "refunded-a": 6,
  "refunded-b": 6,
  refunded: 6,
  abandoned: 6,
  unpaired: -1,
  "orientation-unsupported": -1,
};

export interface SweepTransportError { url: string; error: string }
export interface DealRoomSkip { room: string; contract: string; reason: string }

export interface SweepReport {
  ok: boolean;
  sweptAtMs: number;
  baseUrl: string;
  offerRecords: number; // records folded out of the tclk-offers export this sweep
  offerParseError?: string; // set (with ok:false) when the export failed to parse
  swapLegOffers: number; // authenticated offers classified as a swap leg (SPEC §3.3)
  dealRoomsFetched: number;
  dealRoomsSkipped: DealRoomSkip[];
  swapsByStatus?: Record<string, number>; // board.swaps grouped by status
  swapsWritten: number; // lines appended to swaps.jsonl this sweep (status changes only)
  hitCreated: boolean;
  transport?: SweepTransportError; // any transport-level failure; ends the sweep
  notes: string[];
}

export interface RunSweepOptions {
  root: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  nowMs?: () => number;
  maxDealRooms?: number;
  timeoutMs?: number;
  userAgent?: string;
  board?: (input: BoardInput) => Board;
}

const DEFAULT_BASE_URL = "https://technocore.chat";
const DEFAULT_MAX_DEAL_ROOMS = 50;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_USER_AGENT = "flop-swap-desk-watcher/0.1 (+https://github.com/djd39448/flop-swap-desk)";
const NO_EVIDENCE_NOTE = "no rail evidence: states beyond paired are unreachable in Phase 0";

interface StateFile {
  statuses: Record<string, SwapStatus>;
  hitCreated: boolean;
}

// Lazily loads the real buildBoard. Not a static import: another builder owns src/board.ts,
// and a missing file there must not fail *this* module's build.
async function loadDefaultBoard(): Promise<(input: BoardInput) => Board> {
  const modulePath = "./board.js";
  let mod: { buildBoard?: (input: BoardInput) => Board };
  try {
    mod = (await import(modulePath)) as { buildBoard?: (input: BoardInput) => Board };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`watcher: no board module at src/board.ts to load (${reason}); pass options.board`);
  }
  if (typeof mod.buildBoard !== "function") {
    throw new Error("watcher: src/board.ts has no buildBoard export; pass options.board");
  }
  return mod.buildBoard;
}

function isoStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/:/g, "-");
}

// Resolve a path under root; refuse anything that would escape it (defense in depth — every
// segment we build a path from is already validated by tclk's own room-name grammar).
function underRoot(root: string, ...segments: string[]): string {
  const resolvedRoot = join(root);
  const resolved = join(resolvedRoot, ...segments);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || rel === "") {
    throw new Error(`watcher: refusing to write outside root: ${segments.join("/")}`);
  }
  return resolved;
}

async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "user-agent": userAgent },
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

// An offer/accept authenticated for the signed lane in tclk-offers (the same checks as
// transcript.ts's private authenticatedFrame, built from the exported primitives only).
function authenticatedOfferRoomFrame(record: TranscriptRecord): TclkFrame | null {
  if (record.room !== OFFER_ROOM || !verifyTranscriptRecord(record).ok) return null;
  const frame = tryDecodeFrame(record.line);
  return frame !== null && frame.from === record.sender ? frame : null;
}

interface CandidateContract { contract: string; offerSeq: number }

// Which contracts' deal rooms are worth polling: authenticated offers that declare
// themselves a swap leg (SPEC §3.3), matched to their authenticated accept for the contract
// id. Ordered by the offer's own seq (it always precedes the accept), so a cap keeps the
// earliest bids.
function findSwapLegCandidates(offerRoomRecords: readonly TranscriptRecord[]): {
  candidates: CandidateContract[];
  swapLegOffers: number;
} {
  const swapLegOfferIds = new Map<string, number>(); // offer id -> record seq
  for (const record of offerRoomRecords) {
    const frame = authenticatedOfferRoomFrame(record);
    if (frame !== null && frame.type === "offer" && classifySwapOffer(frame) !== null) {
      swapLegOfferIds.set(frame.id, record.seq);
    }
  }

  const byContract = new Map<string, CandidateContract>();
  for (const record of offerRoomRecords) {
    const frame = authenticatedOfferRoomFrame(record);
    if (frame === null || frame.type !== "accept") continue;
    const offerSeq = swapLegOfferIds.get(frame.ref);
    if (offerSeq === undefined) continue;
    const existing = byContract.get(frame.contract);
    if (existing === undefined || offerSeq < existing.offerSeq) {
      byContract.set(frame.contract, { contract: frame.contract, offerSeq });
    }
  }

  return {
    candidates: [...byContract.values()].sort((a, b) => a.offerSeq - b.offerSeq),
    swapLegOffers: swapLegOfferIds.size,
  };
}

async function readStateFile(path: string): Promise<StateFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StateFile>;
    return {
      statuses: parsed.statuses && typeof parsed.statuses === "object" ? parsed.statuses : {},
      hitCreated: parsed.hitCreated === true,
    };
  } catch {
    return { statuses: {}, hitCreated: false };
  }
}

/**
 * The venue serves the transport `nonce` as a bare JSON number of ~19 digits (past 2^53), so
 * `JSON.parse` rounds it before any tclk code runs and the signed record can no longer be
 * verified (tclk issues #78/#149; upstream fix PR #82 still open at the pinned commit).
 * Recover the exact digits from the wire bytes: quote every top-level `"nonce": <digits>`
 * value. The lookbehind skips the escaped `\"nonce\"` inside a frame's `text` (whose value is
 * quoted hex anyway, so `\d+` would not match it). Persisted raw files are never rewritten;
 * this runs on the in-memory copy only.
 */
export function quoteBigNonces(text: string): string {
  return text.replace(/(?<!\\)"nonce"(\s*:\s*)(\d+)(?=\s*[,}\r\n])/g, '"nonce"$1"$2"');
}

// Normalize a ?format=json deal-room body: {messages:[...]} or a bare array (verified live
// 2026-09-18: `{room,count,first_seq,last_seq,generation,messages:[{seq,ts,from,text,nonce,sig}]}`).
// A bad message is skipped, not fatal to the sweep.
function normalizeDealRoomBody(room: string, body: string): { records: TranscriptRecord[]; skippedCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteBigNonces(body));
  } catch {
    return { records: [], skippedCount: 0 };
  }
  const messages: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages)
      ? (parsed as { messages: unknown[] }).messages
      : [];
  const records: TranscriptRecord[] = [];
  let skippedCount = 0;
  for (const message of messages) {
    try {
      records.push(transcriptRecord(room, message));
    } catch {
      skippedCount += 1;
    }
  }
  return { records, skippedCount };
}

function emptyReport(nowMs: number, baseUrl: string, notes: string[]): SweepReport {
  return {
    ok: false,
    sweptAtMs: nowMs,
    baseUrl,
    offerRecords: 0,
    swapLegOffers: 0,
    dealRoomsFetched: 0,
    dealRoomsSkipped: [],
    swapsWritten: 0,
    hitCreated: false,
    notes,
  };
}

/**
 * Run one read-only sweep: fetch `tclk-offers/export`, persist it, derive and poll the deal
 * rooms for swap-leg contracts, fold the board, and append status-change lines to
 * `swaps.jsonl`. Never throws — every failure comes back as `{ ok: false, ... }`.
 */
export async function runSweep(options: RunSweepOptions): Promise<SweepReport> {
  try {
    return await sweepOnce(options);
  } catch (error) {
    // Belt and suspenders: sweepOnce reports every anticipated failure (transport, parse)
    // as `{ ok: false }`. Anything that still throws (a path escaping root, board.ts
    // missing with no options.board, …) must not escape runSweep either.
    const reason = error instanceof Error ? error.message : String(error);
    const report = emptyReport(
      (options.nowMs ?? Date.now)(),
      options.baseUrl ?? DEFAULT_BASE_URL,
      [NO_EVIDENCE_NOTE, `sweep failed before completing: ${reason}`],
    );
    return report;
  }
}

async function sweepOnce(options: RunSweepOptions): Promise<SweepReport> {
  const root = options.root;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const nowMs = (options.nowMs ?? Date.now)();
  const maxDealRooms = options.maxDealRooms ?? DEFAULT_MAX_DEAL_ROOMS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  // Only touches src/board.js when the caller did not supply its own board function.
  const buildBoard = options.board ?? (await loadDefaultBoard());

  const sweepIso = isoStamp(nowMs);
  const notes: string[] = [NO_EVIDENCE_NOTE];
  const report = emptyReport(nowMs, baseUrl, notes);

  // Step 1: fetch and persist the offer-room export, byte-exact, before any parsing.
  const exportUrl = `${baseUrl}/r/${OFFER_ROOM}/export`;
  let exportBody: string;
  try {
    exportBody = (await fetchWithTimeout(fetchImpl, exportUrl, timeoutMs, userAgent)).body;
  } catch (error) {
    report.transport = { url: exportUrl, error: error instanceof Error ? error.message : String(error) };
    return report;
  }

  await writeFileAtomic(underRoot(root, "raw", OFFER_ROOM, `${sweepIso}.jsonl`), exportBody);

  let offerRoomRecords: TranscriptRecord[];
  try {
    offerRoomRecords = parseTranscriptExport(OFFER_ROOM, quoteBigNonces(exportBody));
  } catch (error) {
    report.offerParseError = error instanceof Error ? error.message : String(error);
    return report;
  }
  report.offerRecords = offerRoomRecords.length;

  // Step 2: which contracts' deal rooms are worth polling, and fetch them.
  const { candidates, swapLegOffers } = findSwapLegCandidates(offerRoomRecords);
  report.swapLegOffers = swapLegOffers;
  const dealRooms = new Map<string, readonly TranscriptRecord[]>();

  for (const candidate of candidates.slice(0, maxDealRooms)) {
    let room: string;
    try {
      room = dealRoom(candidate.contract);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid contract id";
      report.dealRoomsSkipped.push({ room: "", contract: candidate.contract, reason });
      continue;
    }

    let body: string;
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/r/${room}?format=json&limit=200`,
        timeoutMs,
        userAgent,
      );
      if (response.status === 404) {
        report.dealRoomsSkipped.push({ room, contract: candidate.contract, reason: "404" });
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        report.dealRoomsSkipped.push({ room, contract: candidate.contract, reason: `http ${response.status}` });
        continue;
      }
      body = response.body;
    } catch (error) {
      // A single deal room's transport failure does not fail the sweep (SPEC §4: "a deal
      // room may 404 or be empty"); recorded and the sweep continues, like deal_watch.py's
      // per-room `errors` map.
      report.dealRoomsSkipped.push({
        room,
        contract: candidate.contract,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    await writeFileAtomic(underRoot(root, "raw", room, `${sweepIso}.json`), body);
    const { records, skippedCount } = normalizeDealRoomBody(room, body);
    dealRooms.set(room, records);
    report.dealRoomsFetched += 1;
    if (skippedCount > 0) notes.push(`${room}: skipped ${skippedCount} malformed message(s)`);
  }

  // Step 3: fold the board. `evidence` is always absent in Phase 0 (no rail read paths).
  const board = buildBoard({ offers: offerRoomRecords, dealRooms, nowMs });

  const swapsByStatus: Record<string, number> = {};
  for (const swap of board.swaps) swapsByStatus[swap.status] = (swapsByStatus[swap.status] ?? 0) + 1;
  report.swapsByStatus = swapsByStatus;

  // Step 4: write board.json atomically, append swaps.jsonl on status change, touch HIT once.
  const boardDocument = {
    ...board,
    sweptAtMs: nowMs,
    baseUrl,
    offerRecords: report.offerRecords,
    dealRoomsFetched: report.dealRoomsFetched,
    notes,
  };
  await writeFileAtomic(underRoot(root, "board.json"), `${JSON.stringify(boardDocument, null, 2)}\n`);

  const statePath = underRoot(root, "state.json");
  const state = await readStateFile(statePath);
  const newLines: string[] = [];
  let reachedPairedOrLater = false;

  for (const swap of board.swaps) {
    if (swap.swapId === null) continue;
    if (state.statuses[swap.swapId] !== swap.status) {
      state.statuses[swap.swapId] = swap.status;
      newLines.push(
        JSON.stringify({
          sweptAtMs: nowMs,
          swapId: swap.swapId,
          status: swap.status,
          legAOfferId: swap.legAOfferId,
          legBOfferId: swap.legBOfferId,
          buyerDid: swap.buyerDid,
          sellerDid: swap.sellerDid,
          reasons: swap.reasons,
        }),
      );
    }
    if (STATUS_RANK[swap.status] >= STATUS_RANK.paired) reachedPairedOrLater = true;
  }

  if (newLines.length > 0) {
    const swapsJsonlPath = underRoot(root, "swaps.jsonl");
    const existing = await readFile(swapsJsonlPath, "utf8").catch(() => "");
    await writeFileAtomic(swapsJsonlPath, existing + newLines.map((line) => `${line}\n`).join(""));
    report.swapsWritten = newLines.length;
  }

  const hitPath = underRoot(root, "HIT");
  if (reachedPairedOrLater && !state.hitCreated && !existsSync(hitPath)) {
    await writeFileAtomic(hitPath, `${new Date(nowMs).toISOString()}\n`);
    state.hitCreated = true;
    report.hitCreated = true;
  }

  await writeFileAtomic(statePath, JSON.stringify(state, null, 2));
  report.ok = true;
  return report;
}
