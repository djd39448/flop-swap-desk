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
import type { Board, BoardInput, LegAContext, LegBContext, SwapView } from "./types.js";

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

/** The accept from `counterparty` if one exists, else the earliest; undefined when none. */
function chooseAccept(
  accepts: readonly AuthenticatedFrame[] | undefined,
  counterparty: string | undefined,
): AuthenticatedFrame | undefined {
  if (accepts === undefined || accepts.length === 0) return undefined;
  if (counterparty !== undefined) {
    const own = accepts.find((candidate) => candidate.frame.from === counterparty);
    if (own !== undefined) return own;
  }
  return accepts[0];
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
  for (const [legAOfferId, legA] of legAByOfferId) {
    const legB = legBByLegAOfferId.get(legAOfferId);
    const acceptA = chooseAccept(acceptsByRef.get(legAOfferId), legB?.offer.from);
    const legARecords = buildLegRecords(legA.record, acceptA, input.dealRooms);
    const legBRecords = legB
      ? buildLegRecords(legB.record, chooseAccept(acceptsByRef.get(legB.offer.id), legA.offer.from), input.dealRooms)
      : [];
    const evidence = input.evidence?.get(legA.swapId);
    swaps.push(
      foldSwap(
        evidence === undefined
          ? { legA: legARecords, legB: legBRecords, nowMs: input.nowMs }
          : { legA: legARecords, legB: legBRecords, evidence, nowMs: input.nowMs },
      ),
    );
  }

  return { swaps, unpaired };
}
