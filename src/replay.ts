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
  type LockFrame,
  type OfferFrame,
  type TclkFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { buildBoard as defaultBuildBoard } from "./board.js";
import { paperEvidence, stripNoteBanner, PAPER_RAIL_ID } from "./paper-evidence.js";
import { classifySwapOffer } from "./profile.js";
import { resolveAccounts } from "./rails/account-line.js";
import { evmEvidence, EVM_RAIL_ID, type EvmCapture } from "./rails/evm-evidence.js";
import type { EvmRailConfig } from "./rails/evm-htlc.js";
import { offerAcceptLockTerms } from "./swap.js";
import type { Board, BoardInput, LockEvidence, RailObservation, SwapEvidence, SwapLeg } from "./types.js";

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
  /** The accept's own offer-room seq (H2, tclk#181) — alongside `offerSeq`, the pair a
   *  caller needs to archive this leg's exact offer-room lines byte-for-byte before the
   *  venue's ring rolls past them. */
  acceptSeq: number;
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
          acceptSeq: record.seq,
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

/**
 * P22-P24-EVM-SPEC.md §5's payer-only rule, generalised over every rail: the authenticated
 * `lock` frame for `contract`, posted by its own leg's payer and no one else — only the party
 * who actually escrows a leg's funds can post the frame that says it is locked, so a
 * `verifyTranscriptRecord`-clean frame signed by anyone else (the payee, a stranger who
 * guessed the deal room) is not evidence of anything and must not be picked up as one.
 * `null` when no such record exists. Dispatching on the frame's own `.rail`/`.ref` is the
 * caller's job — `foldCaptured` below (paper vs `evm-htlc` vs anything else) and
 * `src/watcher.ts`'s own use of this to decide whether an EVM leg is worth capturing live.
 */
export function findAuthenticatedLock(
  records: readonly TranscriptRecord[],
  contract: string,
  payerDid: string,
): LockFrame | null {
  for (const record of records) {
    const frame = authenticatedFrame(record);
    if (frame !== null && frame.type === "lock" && frame.contract === contract && record.sender === payerDid) {
      return frame;
    }
  }
  return null;
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
  /** P22-P24-EVM-SPEC.md §5: captured EVM chain reads, keyed by hashLock — an `evm-htlc`
   *  lock frame's own `.ref`, which must equal the leg's `terms.statement` to be picked up at
   *  all (§2.2 point 3). A candidate whose deal room shows an authenticated `evm-htlc` lock
   *  but has no entry here gets no evidence for that leg, the same treatment as a paper
   *  candidate with no captured note — whether it was never captured, or a replay simply
   *  didn't have it on disk. Absent entirely behaves exactly like an empty map. */
  chain?: ReadonlyMap<string, EvmCapture>;
  /** The chain rails this fold may draw evidence from. Absent (the default — and what the
   *  live watch passes when it isn't given `RunSweepOptions.rails`): the `evm-htlc` branch
   *  below never runs at all, so `foldCaptured` is exactly the paper-only fold it always was,
   *  byte-for-byte (tests/replay.test.ts's "no rails configured" case pins this). */
  rails?: { evm?: EvmRailConfig };
  nowMs: number;
  board?: (input: BoardInput) => Board;
}

/**
 * The shared fold: candidates → rail evidence → `buildBoard`. A live sweep
 * (`src/watcher.ts`) and an offline replay (`examples/audit-export.mjs`) both call this after
 * collecting their own bytes, so they can never fold differently.
 *
 * For each candidate, `findAuthenticatedLock` finds the (at most one first-seen) `lock` frame
 * its own leg's payer posted in its own deal room, and this dispatches on that frame's `.rail`
 * (P22-P24-EVM-SPEC.md §5): `paper` (`ref === contract`, tclk's convention) → today's paper
 * path, reading the captured note the same way it always has; `evm-htlc` (`ref ===
 * terms.statement`, the hashLock) → `evmEvidence`, but only when a chain rail is configured
 * (`input.rails.evm`) AND a capture exists for that hashLock (`input.chain`) — accounts are
 * resolved fresh from the same deal room with `resolveAccounts`, never cached across
 * candidates, since each leg's own deal room is the only room its account lines can be posted
 * in; anything else (an unrecognised rail, or a rail/ref combination this build has no reader
 * for) gets no evidence, exactly like an absent lock frame does today.
 */
export function foldCaptured(input: FoldCapturedInput): Board {
  const buildBoardFn = input.board ?? defaultBuildBoard;
  const { candidates } = findSwapLegCandidates(input.offers);
  const evidenceBySwap = new Map<string, SwapEvidence>();
  const evmConfig = input.rails?.evm;

  for (const candidate of candidates) {
    const room = dealRoom(candidate.contract);
    const dealRoomRecords = input.dealRooms.get(room) ?? [];
    // Full nine-field LockTerms (H1, tclk#180), from the authenticated offer/accept pair
    // itself — never from the deal room or a rail's own record, both world-writable.
    const terms = offerAcceptLockTerms(candidate.offer, candidate.accept);
    const lockFrame = findAuthenticatedLock(dealRoomRecords, candidate.contract, terms.payer);
    if (lockFrame === null) continue;

    let result: { lock: LockEvidence; rail?: RailObservation } | undefined;

    if (lockFrame.rail === PAPER_RAIL_ID && lockFrame.ref === candidate.contract) {
      const captured = input.notes.get(candidate.contract);
      if (captured === undefined) continue; // not fetched/not found: evidence absent
      const noteValue = stripNoteBanner(captured.body);
      result = paperEvidence(terms, noteValue, input.nowMs, captured.endpoint);
    } else if (lockFrame.rail === EVM_RAIL_ID && lockFrame.ref === terms.statement) {
      if (evmConfig === undefined) continue; // no chain rail configured: no evidence at all
      const capture = input.chain?.get(lockFrame.ref);
      if (capture === undefined) continue; // not captured (yet, or ever): evidence absent
      const accounts = resolveAccounts(dealRoomRecords, {
        contract: candidate.contract,
        payerDid: terms.payer,
        payeeDid: terms.payee,
        rail: EVM_RAIL_ID,
        caip2: evmConfig.pin.caip2,
      });
      result = evmEvidence({ terms, config: evmConfig, accounts, capture });
    } else {
      continue; // an unrecognised rail, or a rail this build has no evidence reader for
    }

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
