// SPDX-License-Identifier: MIT
//
// Board (SPEC §4): folds every offer in `tclk-offers` into per-swap views. Pairing trusts
// only signed, authenticated frames in the right room; a forged `from`, an unsigned lane,
// a wrong-room record, or a malformed line is skipped before it ever reaches a fold. Every
// leg-A swap offer becomes exactly one `SwapView` (an open bid is still a board entry, per
// SPEC §4's "open bids" output) — `unpaired` holds only leg-B offers that never attach to
// any leg A (unknown reference, or lost the earliest-seq tie-break).
// Design: flop-contrib/SPEC-ATOMIC-SWAP-DESK.md (draft 0.1, 2026-09-18), §4.

import {
  dealRoom,
  OFFER_ROOM,
  tryDecodeFrame,
  verifyTranscriptRecord,
  type AcceptFrame,
  type OfferFrame,
  type TclkFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { classifySwapOffer } from "./profile.js";
import { foldSwap } from "./swap.js";
import type { Board, BoardInput, LegAContext, LegBContext, SwapEvidence, SwapView } from "./types.js";

interface AuthenticatedFrame {
  record: TranscriptRecord;
  frame: TclkFrame;
}

/** Signed lane, right room, unforged sender — everything else is anonymous input. */
function authenticateOffers(records: readonly TranscriptRecord[]): AuthenticatedFrame[] {
  const out: AuthenticatedFrame[] = [];
  for (const record of records) {
    if (record.room !== OFFER_ROOM) continue;
    if (!verifyTranscriptRecord(record).ok) continue;
    const frame = tryDecodeFrame(record.line);
    if (frame === null) continue;
    if (frame.from !== record.sender) continue;
    out.push({ record, frame });
  }
  return out;
}

interface LegACandidate {
  record: TranscriptRecord;
  offer: OfferFrame;
  swapId: string;
  context: LegAContext;
}

interface LegBCandidate {
  record: TranscriptRecord;
  offer: OfferFrame;
  swapId: string;
  context: LegBContext;
}

function buildLegRecords(
  offerRecord: TranscriptRecord,
  accept: AuthenticatedFrame | undefined,
  dealRooms: ReadonlyMap<string, readonly TranscriptRecord[]>,
): TranscriptRecord[] {
  const records: TranscriptRecord[] = [offerRecord];
  if (accept === undefined) return records;
  records.push(accept.record);
  const contract = (accept.frame as AcceptFrame).contract;
  const room = dealRoom(contract);
  const dealRecords = dealRooms.get(room);
  if (dealRecords !== undefined) records.push(...dealRecords);
  return records;
}

interface ChosenAccept {
  accept: AuthenticatedFrame | undefined;
  /** H4: true iff picking `accept` depended on the offers-room export's row order rather
   *  than a matching counterparty — only possible when there was more than one candidate to
   *  choose among (with exactly one, no reordering of the input could have changed the
   *  answer, so it is not order-*dependent*, just order-*only* input). tclk#175. */
  coordinationOnly: boolean;
}

/** The accept from `counterparty` if one exists, else the earliest; undefined when none. */
function chooseAccept(
  accepts: readonly AuthenticatedFrame[] | undefined,
  counterparty: string | undefined,
): ChosenAccept {
  if (accepts === undefined || accepts.length === 0) return { accept: undefined, coordinationOnly: false };
  if (counterparty !== undefined) {
    const own = accepts.find((candidate) => candidate.frame.from === counterparty);
    if (own !== undefined) return { accept: own, coordinationOnly: false };
  }
  return { accept: accepts[0], coordinationOnly: accepts.length > 1 };
}

/** Assemble one pair's `SwapEvidence` from per-leg evidence keyed by each leg's own accepted
 *  contract id; `undefined` when neither leg has any. */
function pairEvidence(
  byContract: BoardInput["evidence"],
  acceptA: AuthenticatedFrame | undefined,
  acceptB: AuthenticatedFrame | undefined,
): SwapEvidence | undefined {
  if (byContract === undefined) return undefined;
  const legA = acceptA === undefined ? undefined : byContract.get((acceptA.frame as AcceptFrame).contract);
  const legB = acceptB === undefined ? undefined : byContract.get((acceptB.frame as AcceptFrame).contract);
  if (legA === undefined && legB === undefined) return undefined;
  const out: SwapEvidence = {};
  if (legA !== undefined) {
    out.a = legA.lock;
    if (legA.rail !== undefined) out.aRail = legA.rail;
  }
  if (legB !== undefined) {
    out.b = legB.lock;
    if (legB.rail !== undefined) out.bRail = legB.rail;
  }
  return out;
}

/** Fold every offer in `input.offers` (all of `tclk-offers`, venue order) into a board. */
export function buildBoard(input: BoardInput): Board {
  const authed = authenticateOffers(input.offers);

  const legAByOfferId = new Map<string, LegACandidate>();
  const legBCandidates: LegBCandidate[] = [];
  const seenOfferIds = new Set<string>();
  // First accept seen (in venue order) per `ref`, provided its offer already appeared —
  // mirrors tclk's own handshake rule: an accept cannot rewrite board history.
  // Every authenticated accept per offer id, in venue order. A busy board accepts a bid within
  // seconds from strangers; the accept that belongs to a swap is the one from the counterparty
  // who opened the other leg (leg A: the Seller who opened leg B; leg B: the Buyer who opened
  // leg A). Only when no other leg exists does the earliest accept stand in.
  const acceptsByRef = new Map<string, AuthenticatedFrame[]>();

  for (const authenticated of authed) {
    const { record, frame } = authenticated;
    if (frame.type === "offer") {
      seenOfferIds.add(frame.id);
      const classification = classifySwapOffer(frame);
      if (classification === null) continue; // non-swap traffic: ignored silently
      if (classification.context.leg === "a") {
        if (!legAByOfferId.has(frame.id)) {
          legAByOfferId.set(frame.id, {
            record,
            offer: frame,
            swapId: classification.swapId,
            context: classification.context,
          });
        }
      } else {
        legBCandidates.push({
          record,
          offer: frame,
          swapId: classification.swapId,
          context: classification.context,
        });
      }
      continue;
    }
    if (frame.type === "accept") {
      if (!seenOfferIds.has(frame.ref)) continue;
      const list = acceptsByRef.get(frame.ref);
      if (list === undefined) acceptsByRef.set(frame.ref, [authenticated]);
      else list.push(authenticated);
    }
  }

  const legBByLegAOfferId = new Map<string, LegBCandidate>();
  const unpaired: Array<{ offerId: string; reason: string }> = [];

  const orderedLegB = [...legBCandidates].sort((left, right) => left.record.seq - right.record.seq);
  for (const candidate of orderedLegB) {
    const legAOfferId = candidate.context.legAOfferId;
    if (!legAByOfferId.has(legAOfferId)) {
      unpaired.push({
        offerId: candidate.offer.id,
        reason: "leg B names an unknown leg A offer id",
      });
      continue;
    }
    if (legBByLegAOfferId.has(legAOfferId)) {
      unpaired.push({ offerId: candidate.offer.id, reason: "leg A already paired" });
      continue;
    }
    legBByLegAOfferId.set(legAOfferId, candidate);
  }

  const swaps: SwapView[] = [];
  const swapIdCount = new Map<string, number>();
  for (const legA of legAByOfferId.values()) swapIdCount.set(legA.swapId, (swapIdCount.get(legA.swapId) ?? 0) + 1);

  for (const [legAOfferId, legA] of legAByOfferId) {
    const duplicated = (swapIdCount.get(legA.swapId) ?? 0) > 1;
    const legB = legBByLegAOfferId.get(legAOfferId);
    const acceptAChoice = chooseAccept(acceptsByRef.get(legAOfferId), legB?.offer.from);
    const legARecords = buildLegRecords(legA.record, acceptAChoice.accept, input.dealRooms);
    const acceptBChoice = legB
      ? chooseAccept(acceptsByRef.get(legB.offer.id), legA.offer.from)
      : { accept: undefined, coordinationOnly: false };
    const legBRecords = legB ? buildLegRecords(legB.record, acceptBChoice.accept, input.dealRooms) : [];
    // tclk#194 finding 2: `swapId` is not unique (a buyer picks the nonce), so evidence is looked
    // up by the two accepted contract ids of THIS pair � and not at all when the swapId is
    // shared by more than one active swap, so neither can fold past what its own frames prove.
    const evidence = duplicated ? undefined : pairEvidence(input.evidence, acceptAChoice.accept, acceptBChoice.accept);
    const view = foldSwap(
      evidence === undefined
        ? { legA: legARecords, legB: legBRecords, nowMs: input.nowMs }
        : { legA: legARecords, legB: legBRecords, evidence, nowMs: input.nowMs },
    );
    if (duplicated) {
      view.reasons.push(
        `swapId ${legA.swapId} is shared by ${swapIdCount.get(legA.swapId)} active swaps (same buyer and nonce) � no rail evidence is looked up for any of them; each folds only as far as its own frames prove`,
      );
    }
    // H4: foldSwap has no visibility into how an accept was chosen among several candidates
    // for the same offer id — that choice happens here, before folding — so it is appended
    // after the fact rather than threaded through as another input (tclk#175).
    if (acceptAChoice.coordinationOnly && acceptAChoice.accept !== undefined) {
      view.coordinationOnly.push({
        basis: "coordination-only",
        reason: "leg A's accept chosen by export row order among several candidates, not a matching counterparty",
      });
    }
    if (acceptBChoice.coordinationOnly && acceptBChoice.accept !== undefined) {
      view.coordinationOnly.push({
        basis: "coordination-only",
        reason: "leg B's accept chosen by export row order among several candidates, not a matching counterparty",
      });
    }
    swaps.push(view);
  }

  return { swaps, unpaired };
}
