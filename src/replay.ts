// SPDX-License-Identifier: MIT
//
// The "assemble inputs → evidence → buildBoard" step, factored out of `src/watcher.ts` so a
// live sweep and an offline replay (`examples/audit-export.mjs`) share exactly one code
// path and can never silently diverge (P05-SPEC.md deliverable 3). Everything here is pure
// over already-collected bytes: no fetch, no clock read. `findSwapLegCandidates` is also
// reused by the watcher itself, to decide which deal rooms and paper notes are worth
// fetching in the first place.

import {
  dealRoom,
  paperNote,
  tryDecodeFrame,
  verifyTranscriptRecord,
  OFFER_ROOM,
  type AcceptFrame,
  type OfferFrame,
  type TclkFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { buildBoard as defaultBuildBoard } from "./board.js";
import { paperEvidence, stripNoteBanner, PAPER_RAIL_ID } from "./paper-evidence.js";
import { classifySwapOffer } from "./profile.js";
import type { Board, BoardInput, SwapEvidence, SwapLeg } from "./types.js";

// An offer/accept authenticated for the signed lane in tclk-offers (the same checks as
// transcript.ts's private authenticatedFrame, built from the exported primitives only).
function authenticatedOfferRoomFrame(record: TranscriptRecord): TclkFrame | null {
  if (record.room !== OFFER_ROOM || !verifyTranscriptRecord(record).ok) return null;
  const frame = tryDecodeFrame(record.line);
  return frame !== null && frame.from === record.sender ? frame : null;
}

// Same authentication (signed lane, unforged `from`) without the room restriction, for
// scanning a swap's own derived deal room.
function authenticatedFrame(record: TranscriptRecord): TclkFrame | null {
  if (!verifyTranscriptRecord(record).ok) return null;
  const frame = tryDecodeFrame(record.line);
  return frame !== null && frame.from === record.sender ? frame : null;
}

interface SwapLegOffer { seq: number; swapId: string; leg: SwapLeg; offer: OfferFrame }

export interface SwapLegCandidate {
  contract: string;
  offerSeq: number;
  swapId: string;
  leg: SwapLeg;
  offer: OfferFrame;
  accept: AcceptFrame;
}

/**
 * Which contracts' deal rooms (and, transitively, paper notes) are worth polling or
 * replaying: authenticated offers that declare themselves a swap leg (SPEC §3.3), matched
 * to their authenticated accept for the contract id. Ordered by the offer's own seq (it
 * always precedes the accept), so a caller's cap keeps the earliest bids. Carries the
 * offer/accept frames along too, so a paper note's terms (offer.lock, offer.refundAfterMs,
 * accept.statement) and the candidate's swapId/leg (for `BoardInput.evidence`) never need a
 * second pass over the export.
 *
 * Single pass over `offerRoomRecords`, in order: authenticates (and Ed25519-verifies) each
 * record exactly once, same as `src/board.ts`'s own `authenticateOffers`/pairing already
 * does — an accept is only matched if its offer already appeared earlier in `offerRoomRecords`,
 * which is always true for real venue traffic (an accept can only name an offer id that
 * already exists) and for any caller here (the live watcher's export order; the offline
 * replay's `loadOffers`, which explicitly seq-sorts before returning). A two-pass version
 * that re-verified every record for each pass was the actual cost behind a slow replay
 * against a watch root accumulating many overlapping exports — Ed25519 verification, not
 * JSON parsing, dominates at that scale.
 */
export function findSwapLegCandidates(offerRoomRecords: readonly TranscriptRecord[]): {
  candidates: SwapLegCandidate[];
  swapLegOffers: number;
} {
  const swapLegOfferIds = new Map<string, SwapLegOffer>(); // offer id -> {seq, swapId, leg, offer}
  const byContract = new Map<string, SwapLegCandidate>();

  for (const record of offerRoomRecords) {
    const frame = authenticatedOfferRoomFrame(record);
    if (frame === null) continue;

    if (frame.type === "offer") {
      const classification = classifySwapOffer(frame);
      if (classification === null) continue;
      swapLegOfferIds.set(frame.id, {
        seq: record.seq,
        swapId: classification.swapId,
        leg: classification.context.leg,
        offer: frame,
      });
      continue;
    }

    if (frame.type === "accept") {
      const legOffer = swapLegOfferIds.get(frame.ref);
      if (legOffer === undefined) continue;
      const existing = byContract.get(frame.contract);
      if (existing === undefined || legOffer.seq < existing.offerSeq) {
        byContract.set(frame.contract, {
          contract: frame.contract,
          offerSeq: legOffer.seq,
          swapId: legOffer.swapId,
          leg: legOffer.leg,
          offer: legOffer.offer,
          accept: frame,
        });
      }
    }
  }

  return {
    candidates: [...byContract.values()].sort((a, b) => a.offerSeq - b.offerSeq),
    swapLegOffers: swapLegOfferIds.size,
  };
}

/**
 * True iff a candidate's own deal room carries an authenticated paper-rail lock for its own
 * contract — `{type:"lock", contract, rail:"paper", ref:contract}`, the convention the live
 * G0 rehearsal used (P05-SPEC.md "Live facts": the paper rail's `ref` is the contract id
 * itself, since `paperNote()` is keyed by contract, not a separate escrow id).
 */
export function hasAuthenticatedPaperLock(records: readonly TranscriptRecord[], contract: string): boolean {
  return records.some((record) => {
    const frame = authenticatedFrame(record);
    return (
      frame !== null &&
      frame.type === "lock" &&
      frame.contract === contract &&
      frame.rail === PAPER_RAIL_ID &&
      frame.ref === contract
    );
  });
}

/** One captured paper-rail note: its raw `/kv` body (banner included) and the endpoint it
 *  was (or, for a replay, would have been) read from — carried through into `LockEvidence
 *  .endpoint` so an audit trail names its source either way. */
export interface CapturedNote {
  body: string;
  endpoint: string;
}

export interface FoldCapturedInput {
  offers: readonly TranscriptRecord[];
  /** Deal-room records keyed by room name, exactly like `BoardInput.dealRooms`. */
  dealRooms: ReadonlyMap<string, readonly TranscriptRecord[]>;
  /** Captured paper notes keyed by the contract id they were fetched (or read) for. A
   *  swap-leg candidate with an authenticated paper lock but no entry here gets no
   *  evidence for that leg — identical treatment whether the note 404'd, failed some other
   *  way, or (in a replay) was never captured. */
  notes: ReadonlyMap<string, CapturedNote>;
  nowMs: number;
  board?: (input: BoardInput) => Board;
}

/**
 * The shared fold: candidates → paper evidence (only where a candidate's deal room shows an
 * authenticated paper lock AND a note was captured for that contract) → `buildBoard`. A
 * live sweep (`src/watcher.ts`) and an offline replay (`examples/audit-export.mjs`) both
 * call this after collecting their own bytes, so they can never fold differently.
 */
export function foldCaptured(input: FoldCapturedInput): Board {
  const buildBoardFn = input.board ?? defaultBuildBoard;
  const { candidates } = findSwapLegCandidates(input.offers);
  const evidenceBySwap = new Map<string, SwapEvidence>();

  for (const candidate of candidates) {
    const room = dealRoom(candidate.contract);
    const dealRoomRecords = input.dealRooms.get(room) ?? [];
    if (!hasAuthenticatedPaperLock(dealRoomRecords, candidate.contract)) continue;

    const captured = input.notes.get(candidate.contract);
    if (captured === undefined) continue; // not fetched/not found: evidence absent

    const noteValue = stripNoteBanner(captured.body);
    const result = paperEvidence(
      {
        contract: candidate.contract,
        lock: candidate.offer.lock,
        statement: candidate.accept.statement,
        refundAfterMs: candidate.offer.refundAfterMs,
      },
      noteValue,
      input.nowMs,
      captured.endpoint,
    );

    const entry: SwapEvidence = evidenceBySwap.get(candidate.swapId) ?? {};
    if (candidate.leg === "a") {
      entry.a = result.lock;
      if (result.rail !== undefined) entry.aRail = result.rail;
    } else {
      entry.b = result.lock;
      if (result.rail !== undefined) entry.bRail = result.rail;
    }
    evidenceBySwap.set(candidate.swapId, entry);
  }

  return buildBoardFn({
    offers: input.offers,
    dealRooms: input.dealRooms,
    evidence: evidenceBySwap,
    nowMs: input.nowMs,
  });
}

/** Where `paperNote(contract)` puts a note on disk under a watch root: `raw/kv/<ns>/<key>`. */
export function noteDir(contract: string): { ns: string; key: string; dir: string } {
  const { ns, key } = paperNote(contract);
  return { ns, key, dir: `raw/kv/${ns}/${key}` };
}
