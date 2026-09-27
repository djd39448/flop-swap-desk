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
  paperNote,
  parseTranscriptExport,
  transcriptRecord,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import {
  findSwapLegCandidates,
  foldCaptured,
  hasAuthenticatedPaperLock,
  type CapturedNote,
  type SwapLegCandidate,
} from "./replay.js";
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
export interface NoteFetchSkip { note: string; contract: string; reason: string }

export interface SweepReport {
  ok: boolean;
  sweptAtMs: number;
  baseUrl: string;
  offerRecords: number; // records folded out of the tclk-offers export this sweep
  offerParseError?: string; // set (with ok:false) when the export failed to parse
  swapLegOffers: number; // authenticated offers classified as a swap leg (SPEC §3.3)
  dealRoomsFetched: number;
  dealRoomsSkipped: DealRoomSkip[];
  noteFetches: number; // paper-rail /kv notes fetched (200) and folded into evidence
  noteFetchesSkipped: NoteFetchSkip[]; // non-404 note-fetch failures; 404 = absent, not a skip
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
const NO_EVIDENCE_NOTE =
  "rail evidence: paper notes only (rehearsal records, no value); chain rails have no read path in Phase 0";

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

// H2 (tclk#181): the offers room is a byte ring that only holds "tens of minutes" of
// traffic, so a swap's offer/accept lines can roll off before a later sweep would otherwise
// see them again. `job.id` (swapId) is attacker-controlled free text (tclk's own
// `validateJob` only requires it be a non-empty string) — `underRoot` below already refuses
// any segment that would escape `root`, but this also refuses to archive under anything that
// is not the sha256 hex shape `swapId` is supposed to be, so a stray "/" or ".." in a hostile
// job.id produces one unarchived leg, never a surprising directory.
const SWAP_ID_SHAPE = /^0x[0-9a-f]{64}$/;

/** Every offer-room export line, indexed by its own `seq`, read straight off the untouched
 *  wire bytes (before `quoteBigNonces`) so a later archive write is the exact original text,
 *  not a reconstruction. Only `seq` is read here (always a small, safe venue-assigned
 *  integer); a big transport nonce elsewhere on the same line cannot corrupt it. Tolerant,
 *  like every other read of anonymous export bytes in this module: an unparseable line is
 *  simply not indexed. */
function rawLinesBySeq(exportBody: string): Map<number, string> {
  const bySeq = new Map<number, string>();
  for (const line of exportBody.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const seq = (value as { seq?: unknown }).seq;
    if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) bySeq.set(seq, line);
  }
  return bySeq;
}

/**
 * Archive one swap-leg candidate's exact offer-room lines (its offer and its accept) under
 * `raw/swaps/<swapId>/offer-room/<seq>.line`, the first sweep that has both on hand — every
 * later sweep is a no-op per line once written, since an offer or accept never changes once
 * posted. `examples/audit-export.mjs` folds these back in when the ring's own union no
 * longer has a seq.
 */
async function archiveSwapOfferLines(
  root: string,
  candidate: SwapLegCandidate,
  rawLineBySeq: ReadonlyMap<number, string>,
): Promise<void> {
  if (!SWAP_ID_SHAPE.test(candidate.swapId)) return;
  for (const seq of [candidate.offerSeq, candidate.acceptSeq]) {
    const path = underRoot(root, "raw", "swaps", candidate.swapId, "offer-room", `${seq}.line`);
    if (existsSync(path)) continue; // already archived from an earlier sweep
    const line = rawLineBySeq.get(seq);
    if (line === undefined) continue; // not on this sweep's own export: nothing to archive yet
    await writeFileAtomic(path, line.endsWith("\n") ? line : `${line}\n`);
  }
}

/** Archive a swap's deal-room body under `raw/swaps/<swapId>/deal-rooms/<room>.json`,
 *  byte-exact, alongside the timestamped `raw/<room>/<iso>.json` capture (H2, tclk#181).
 *  Unlike the offer-room lines, this is overwritten every sweep: a deal room accumulates
 *  frames over the swap's life (lock, reveal, receipt, …), so only the latest capture has
 *  everything a replay needs. */
async function archiveSwapDealRoom(root: string, swapId: string, room: string, body: string): Promise<void> {
  if (!SWAP_ID_SHAPE.test(swapId)) return;
  await writeFileAtomic(underRoot(root, "raw", "swaps", swapId, "deal-rooms", `${room}.json`), body);
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
    noteFetches: 0,
    noteFetchesSkipped: [],
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
  const rawLineBySeq = rawLinesBySeq(exportBody);

  // Step 2: which contracts' deal rooms are worth polling, and fetch them.
  const { candidates, swapLegOffers } = findSwapLegCandidates(offerRoomRecords);
  report.swapLegOffers = swapLegOffers;
  const dealRooms = new Map<string, readonly TranscriptRecord[]>();
  const cappedCandidates = candidates.slice(0, maxDealRooms);
  const roomByContract = new Map<string, string>();

  for (const candidate of cappedCandidates) {
    // H2 (tclk#181): archive this leg's exact offer-room lines now, independent of whether
    // the deal-room fetch below succeeds — the ring may already have rolled past them by the
    // time a later sweep runs.
    await archiveSwapOfferLines(root, candidate, rawLineBySeq);

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
    await archiveSwapDealRoom(root, candidate.swapId, room, body);
    const { records, skippedCount } = normalizeDealRoomBody(room, body);
    dealRooms.set(room, records);
    roomByContract.set(candidate.contract, room);
    report.dealRoomsFetched += 1;
    if (skippedCount > 0) notes.push(`${room}: skipped ${skippedCount} malformed message(s)`);
  }

  // Step 2.5: for every candidate whose (successfully fetched) deal room shows an
  // authenticated paper-rail lock on its own contract, read the paper rail's note — the
  // only rail with a read path in Phase 0 (see src/paper-evidence.ts). Just fetches and
  // persists; turning a captured note into evidence is `foldCaptured`'s job (src/replay.ts),
  // shared with the offline replay so the two can never fold differently.
  const capturedNotes = new Map<string, CapturedNote>();

  for (const candidate of cappedCandidates) {
    const room = roomByContract.get(candidate.contract);
    if (room === undefined) continue; // deal room wasn't fetched this sweep (404/error)
    const dealRoomRecords = dealRooms.get(room) ?? [];
    if (!hasAuthenticatedPaperLock(dealRoomRecords, candidate.contract)) continue;

    const { ns, key } = paperNote(candidate.contract);
    const noteUrl = `${baseUrl}/kv/${ns}/${key}`;
    const noteLabel = `${ns}/${key}`;

    let noteBody: string;
    try {
      const response = await fetchWithTimeout(fetchImpl, noteUrl, timeoutMs, userAgent);
      if (response.status === 404) continue; // absent record: nothing written, evidence absent
      if (response.status < 200 || response.status >= 300) {
        report.noteFetchesSkipped.push({
          note: noteLabel,
          contract: candidate.contract,
          reason: `http ${response.status}`,
        });
        continue;
      }
      noteBody = response.body;
    } catch (error) {
      report.noteFetchesSkipped.push({
        note: noteLabel,
        contract: candidate.contract,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    await writeFileAtomic(underRoot(root, "raw", "kv", ns, key, `${sweepIso}.txt`), noteBody);
    report.noteFetches += 1;
    capturedNotes.set(candidate.contract, { body: noteBody, endpoint: noteUrl });
  }

  // Step 3: fold the board — the same code path an offline replay uses.
  const board = foldCaptured({ offers: offerRoomRecords, dealRooms, notes: capturedNotes, nowMs, board: buildBoard });

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
          feeBps: swap.feeBps,
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
