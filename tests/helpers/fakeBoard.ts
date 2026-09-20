// SPDX-License-Identifier: MIT
//
// Minimal stand-in for src/board.ts (owned by another builder, not yet written). Just
// enough of `buildBoard`'s shape to exercise watcher.ts's own behavior — persistence,
// swaps.jsonl status-change diffing, the HIT marker — without depending on the real fold,
// pairing or deadline logic. NOT a model of the real board; do not copy its pairing rules.

import { dealRoom, tryDecodeFrame, type OfferFrame } from "@flop-labs/tclk";
import { classifySwapOffer } from "../../src/profile.js";
import type { Board, BoardInput, SwapStatus, SwapView } from "../../src/types.js";

export function fakeBuildBoard({ offers, dealRooms }: BoardInput): Board {
  const offerFrames = new Map<string, OfferFrame>();
  const acceptsByRef = new Map<string, { contract: string }>();

  for (const rec of offers) {
    const frame = tryDecodeFrame(rec.line);
    if (frame === null) continue;
    if (frame.type === "offer") offerFrames.set(frame.id, frame);
    else if (frame.type === "accept") acceptsByRef.set(frame.ref, { contract: frame.contract });
  }

  const legAs = new Map<string, OfferFrame>();
  const legBs = new Map<string, OfferFrame>();
  for (const offer of offerFrames.values()) {
    const classified = classifySwapOffer(offer);
    if (classified === null) continue;
    if (classified.context.leg === "a") legAs.set(classified.swapId, offer);
    else legBs.set(classified.swapId, offer);
  }

  const swapIds = new Set<string>([...legAs.keys(), ...legBs.keys()]);
  const swaps: SwapView[] = [];

  for (const swapId of swapIds) {
    const legA = legAs.get(swapId) ?? null;
    const legB = legBs.get(swapId) ?? null;
    const legAAccept = legA ? acceptsByRef.get(legA.id) ?? null : null;
    const legBAccept = legB ? acceptsByRef.get(legB.id) ?? null : null;

    let status: SwapStatus = "bid";
    if (legA && legAAccept) status = "accepted";
    if (legA && legB && legAAccept && legBAccept) status = "paired";

    if (status === "paired" && legBAccept) {
      const room = dealRoom(legBAccept.contract);
      const records = dealRooms.get(room) ?? [];
      const locked = records.some((rec) => {
        const frame = tryDecodeFrame(rec.line);
        return frame !== null && frame.type === "lock" && frame.contract === legBAccept.contract;
      });
      if (locked) status = "b-locked";
    }

    swaps.push({
      swapId,
      status,
      legAOfferId: legA?.id ?? null,
      legBOfferId: legB?.id ?? null,
      buyerDid: legA?.from ?? null,
      sellerDid: legB?.from ?? null,
      feeBps: null,
      legA: null,
      legB: null,
      evidence: {},
      reasons: [],
    });
  }

  return { swaps, unpaired: [] };
}
