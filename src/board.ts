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
import { foldSwap, isGenuineAccept } from "./swap.js";
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
 *  contract id (V5: the contract the tclk fold itself accepted, not a raw accept frame); `undefined`
 *  when neither leg has any. */
function pairEvidence(
  byContract: BoardInput["evidence"],
  contractA: string | undefined,
  contractB: string | undefined,
): SwapEvidence | undefined {
  if (byContract === undefined) return undefined;
  const legA = contractA === undefined ? undefined : byContract.get(contractA);
  const legB = contractB === undefined ? undefined : byContract.get(contractB);
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
  const offersById = new Map<string, OfferFrame>();
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
      if (!offersById.has(frame.id)) offersById.set(frame.id, frame);
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
      // V5: only a genuine accept (its contract is the id tclk derives from this offer and this
      // accept's own core; not signed by the offerer) can take part in pairing or key evidence.
      const acceptedOffer = offersById.get(frame.ref);
      if (acceptedOffer === undefined || !isGenuineAccept(acceptedOffer, frame)) continue;
      const list = acceptsByRef.get(frame.ref);
      if (list === undefined) acceptsByRef.set(frame.ref, [authenticated]);
      else list.push(authenticated);
    }
  }

  // V6 + R3-2: leg B belongs to the DID that accepted leg A, and the real pair is a crossing one:
  // leg B signed by an accepter of leg A AND carrying its own genuine accept from leg A's offerer
  // (the Buyer). A stranger who accepts leg A and posts their own leg B first has no such Buyer
  // accept, so they cannot hide the real swap. Among crossing candidates the one whose leg-A
  // accept is earliest wins. Only when no crossing pair exists does the earliest-seq leg B signed
  // by an accepter of leg A stand in (coordination-only, on export row order); when leg A has no
  // accept at all, the earliest-seq leg B stands in (also coordination-only).
  const legBByLegAOfferId = new Map<string, LegBCandidate>();
  const legBPairedByRowOrder = new Set<string>();
  const legBPairedNoCrossing = new Set<string>();
  const unpaired: Array<{ offerId: string; reason: string }> = [];

  const orderedLegB = [...legBCandidates].sort((left, right) => left.record.seq - right.record.seq);
  const candidatesByLegA = new Map<string, LegBCandidate[]>();
  for (const candidate of orderedLegB) {
    const list = candidatesByLegA.get(candidate.context.legAOfferId);
    if (list === undefined) candidatesByLegA.set(candidate.context.legAOfferId, [candidate]);
    else list.push(candidate);
  }
  for (const [legAOfferId, candidates] of candidatesByLegA) {
    const legA = legAByOfferId.get(legAOfferId);
    if (legA === undefined) continue;
    const accepts = acceptsByRef.get(legAOfferId) ?? [];
    if (accepts.length === 0) {
      legBByLegAOfferId.set(legAOfferId, candidates[0]!);
      legBPairedByRowOrder.add(legAOfferId);
      continue;
    }
    const acceptSeqOf = (did: string): number | undefined => {
      const seqs = accepts.filter((accept) => accept.frame.from === did).map((accept) => accept.record.seq);
      return seqs.length === 0 ? undefined : Math.min(...seqs);
    };
    let crossing: LegBCandidate | undefined;
    let crossingSeq = Infinity;
    let fallback: LegBCandidate | undefined;
    for (const candidate of candidates) {
      const aSeq = acceptSeqOf(candidate.offer.from);
      if (aSeq === undefined) continue;
      if (fallback === undefined) fallback = candidate;
      const buyerAccepted = (acceptsByRef.get(candidate.offer.id) ?? []).some(
        (accept) => accept.frame.from === legA.offer.from,
      );
      if (buyerAccepted && aSeq < crossingSeq) {
        crossing = candidate;
        crossingSeq = aSeq;
      }
    }
    const chosen = crossing ?? fallback;
    if (chosen === undefined) continue;
    legBByLegAOfferId.set(legAOfferId, chosen);
    if (crossing === undefined) legBPairedNoCrossing.add(legAOfferId);
  }
  for (const candidate of orderedLegB) {
    const legAOfferId = candidate.context.legAOfferId;
    if (!legAByOfferId.has(legAOfferId)) {
      unpaired.push({
        offerId: candidate.offer.id,
        reason: "leg B names an unknown leg A offer id",
      });
      continue;
    }
    const winner = legBByLegAOfferId.get(legAOfferId);
    if (winner === candidate) continue;
    if (winner !== undefined && winner.record.seq < candidate.record.seq) {
      unpaired.push({ offerId: candidate.offer.id, reason: "leg A already paired" });
      continue;
    }
    const accepts = acceptsByRef.get(legAOfferId) ?? [];
    if (accepts.length > 0 && !accepts.some((accept) => accept.frame.from === candidate.offer.from)) {
      unpaired.push({ offerId: candidate.offer.id, reason: "leg B is not signed by the DID that accepted leg A" });
    } else {
      unpaired.push({ offerId: candidate.offer.id, reason: "leg A already paired" });
    }
  }

  const swaps: SwapView[] = [];
  // V3: a shared swapId is information only. It is defined per buyer (a hash of the buyer's DID
  // and a nonce), so it can repeat only among leg-A offers signed by the same DID; another
  // signer copying a swapId into an offer of their own is not reported and changes nothing.
  const swapIdCount = new Map<string, number>();
  const sameBuyerKey = (legA: LegACandidate): string => `${legA.offer.from}|${legA.swapId}`;
  for (const legA of legAByOfferId.values()) {
    const key = sameBuyerKey(legA);
    swapIdCount.set(key, (swapIdCount.get(key) ?? 0) + 1);
  }

  for (const [legAOfferId, legA] of legAByOfferId) {
    const legB = legBByLegAOfferId.get(legAOfferId);
    const acceptAChoice = chooseAccept(acceptsByRef.get(legAOfferId), legB?.offer.from);
    const legARecords = buildLegRecords(legA.record, acceptAChoice.accept, input.dealRooms);
    const acceptBChoice = legB
      ? chooseAccept(acceptsByRef.get(legB.offer.id), legA.offer.from)
      : { accept: undefined, coordinationOnly: false };
    const legBRecords = legB ? buildLegRecords(legB.record, acceptBChoice.accept, input.dealRooms) : [];
    // tclk#194: `swapId` is not unique, so evidence is looked up by the two contract ids the
    // fold itself accepted for THIS pair, never by swapId. Fold once without evidence to learn
    // them; only when some evidence exists under those ids is the pair folded again with it.
    const bare = foldSwap({ legA: legARecords, legB: legBRecords, nowMs: input.nowMs });
    const evidence = pairEvidence(input.evidence, bare.legA?.state?.contract, bare.legB?.state?.contract);
    const view =
      evidence === undefined
        ? bare
        : foldSwap({ legA: legARecords, legB: legBRecords, evidence, nowMs: input.nowMs });
    const sharedCount = swapIdCount.get(sameBuyerKey(legA)) ?? 0;
    if (sharedCount > 1) {
      view.reasons.push(
        `swapId ${legA.swapId} is shared by ${sharedCount} leg-A offers signed by the same buyer (the swapId is defined per buyer) - information only: rail evidence is keyed per leg contract, so no swap uses another's evidence`,
      );
    }
    if (legB !== undefined && legBPairedByRowOrder.has(legAOfferId)) {
      view.coordinationOnly.push({
        basis: "coordination-only",
        reason: "leg B paired to a leg A with no accept by export row order (earliest seq), not by its accepter",
      });
    }
    if (legB !== undefined && legBPairedNoCrossing.has(legAOfferId)) {
      view.coordinationOnly.push({
        basis: "coordination-only",
        reason:
          "leg B paired by export row order among accepters of leg A: no leg B carries the Buyer's own accept (no crossing pair)",
      });
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
