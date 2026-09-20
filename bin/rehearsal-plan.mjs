// SPDX-License-Identifier: MIT
//
// The G0 rehearsal plan builder, shared by `rehearsal.mjs` (print for approval) and
// `rehearse-post.mjs` (regenerate at the real t0 and post byte-identical lines). Pure: no
// clock, no network, no files. Same inputs → same bytes. The `paper` rail holds no value.
//
// This plan is the one that was reviewed and posted for the 2026-09-18 G0 rehearsal. Any
// *new* rehearsal run from this builder -- a different t0, different parties, or after any
// change to this file -- is a new plan and needs its own approval before it is posted; past
// approval of one plan is not standing approval for another.

import { createHash } from "node:crypto";

import {
  OFFER_ROOM, dealRoom, encodeFrame, makeAccept, makeOffer, hashLockFromPreimage,
  encodePaperRecord, paperNote, openContract, applyFrame,
} from "@flop-labs/tclk";
import { legAContext, legBContext, swapId } from "../dist/profile.js";
import { checkSwapDeadlines, DEFAULT_POLICY_EXAMPLE } from "../dist/deadlines.js";

export const MIN = 60_000;

/** SPEC §3.5 worked example, anchored at t0 (the moment leg B is expected to lock). */
export function deadlinesFor(t0) {
  return {
    A: { claimByMs: t0 + 45 * MIN, refundAfterMs: t0 + 60 * MIN, expiresMs: t0 + 30 * MIN },
    B: { claimByMs: t0 + 70 * MIN, refundAfterMs: t0 + 180 * MIN, expiresMs: t0 + 40 * MIN },
  };
}

/**
 * @param {{buyerDid:string, sellerDid:string, t0:number, nonceSeed:string, preimageHex:string,
 *          counterAsset?:string, counterAmount?:string, flopAmount?:string}} inputs
 */
export function buildPlan(inputs) {
  const {
    buyerDid, sellerDid, t0, nonceSeed, preimageHex,
    counterAsset = "USDC", counterAmount = "1000000", flopAmount = "1000000000000000000",
  } = inputs;
  if (!Number.isSafeInteger(t0) || t0 <= 0) throw new Error("plan: t0 must be unix ms");
  const lock = hashLockFromPreimage(preimageHex);
  const nonce = (label) => createHash("sha256").update(`${nonceSeed}|${label}`).digest("hex").slice(0, 16);
  const { A, B } = deadlinesFor(t0);
  const id = swapId(buyerDid, nonce("swap"));

  const offerA = makeOffer({
    from: buyerDid, role: "payer", amount: counterAmount, asset: counterAsset, lock: "hash",
    rails: ["evm-htlc", "paper"], ...A,
    job: { proto: "swap", id, context: legAContext({ wantAsset: "FLOP", wantAmount: flopAmount, wantRail: "flop-htlc", feeBps: 0 }) },
    nonce: nonce("offerA"),
  });
  const acceptA = makeAccept(offerA, { from: sellerDid, statement: lock.hash, nonce: nonce("acceptA") });
  const offerB = makeOffer({
    from: sellerDid, role: "payer", amount: flopAmount, asset: "FLOP", lock: "hash",
    rails: ["flop-htlc", "paper"], ...B,
    job: { proto: "swap", id, context: legBContext(offerA.id) },
    nonce: nonce("offerB"),
  });
  const acceptB = makeAccept(offerB, { from: buyerDid, statement: lock.hash, nonce: nonce("acceptB") });

  const roomA = dealRoom(acceptA.contract);
  const roomB = dealRoom(acceptB.contract);
  const noteA = paperNote(acceptA.contract);
  const noteB = paperNote(acceptB.contract);

  const frames = {
    offerA, acceptA, offerB, acceptB,
    lockB: { type: "lock", from: sellerDid, contract: acceptB.contract, rail: "paper", ref: acceptB.contract },
    lockA: { type: "lock", from: buyerDid, contract: acceptA.contract, rail: "paper", ref: acceptA.contract },
    revealA: { type: "reveal", from: sellerDid, contract: acceptA.contract, ref: acceptA.contract, secret: lock.preimage },
    revealB: { type: "reveal", from: buyerDid, contract: acceptB.contract, ref: acceptB.contract, secret: lock.preimage },
    receiptA: { type: "receipt", from: buyerDid, contract: acceptA.contract, outcome: "claimed", rail: "paper", ref: acceptA.contract },
    receiptB: { type: "receipt", from: sellerDid, contract: acceptB.contract, outcome: "claimed", rail: "paper", ref: acceptB.contract },
  };

  const paperLocked = (refundAfterMs) => encodePaperRecord({ status: "locked", lock: "hash", statement: lock.hash, refundAfterMs });
  const paperClaimed = (refundAfterMs) => encodePaperRecord({ status: "claimed", lock: "hash", statement: lock.hash, refundAfterMs, secret: lock.preimage });

  const steps = [
    { n: 1, who: "buyer", room: OFFER_ROOM, kind: "post", frame: "offerA", text: encodeFrame(offerA), note: "leg A offer: Buyer pays counter-asset, wants FLOP" },
    { n: 2, who: "seller", room: OFFER_ROOM, kind: "post", frame: "acceptA", text: encodeFrame(acceptA), note: "leg A accept: Seller mints the secret, statement = sha256(s)" },
    { n: 3, who: "seller", room: OFFER_ROOM, kind: "post", frame: "offerB", text: encodeFrame(offerB), note: "leg B offer: Seller pays FLOP, context names leg A's offer id" },
    { n: 4, who: "buyer", room: OFFER_ROOM, kind: "post", frame: "acceptB", text: encodeFrame(acceptB), note: "leg B accept: Buyer copies the same statement" },
    { n: 5, who: "seller", room: `kv/${noteB.ns}/${noteB.key}`, ns: noteB.ns, key: noteB.key, kind: "note-set-if-absent", text: paperLocked(B.refundAfterMs), note: "PaperRail lock B (t0)" },
    { n: 6, who: "seller", room: roomB, kind: "post", frame: "lockB", text: encodeFrame(frames.lockB), note: "lock B frame (ref = contract id; paper rail)" },
    { n: 7, who: "buyer", room: `kv/${noteA.ns}/${noteA.key}`, ns: noteA.ns, key: noteA.key, kind: "note-set-if-absent", text: paperLocked(A.refundAfterMs), note: "PaperRail lock A, only after verifying note B" },
    { n: 8, who: "buyer", room: roomA, kind: "post", frame: "lockA", text: encodeFrame(frames.lockA), note: "lock A frame" },
    { n: 9, who: "seller", room: `kv/${noteA.ns}/${noteA.key}`, ns: noteA.ns, key: noteA.key, kind: "note-cas", text: paperClaimed(A.refundAfterMs), ifValue: paperLocked(A.refundAfterMs), note: "PaperRail claim A with the secret (the reveal)" },
    { n: 10, who: "seller", room: roomA, kind: "post", frame: "revealA", text: encodeFrame(frames.revealA), note: "reveal A frame: the secret is now public" },
    { n: 11, who: "buyer", room: `kv/${noteB.ns}/${noteB.key}`, ns: noteB.ns, key: noteB.key, kind: "note-cas", text: paperClaimed(B.refundAfterMs), ifValue: paperLocked(B.refundAfterMs), note: "PaperRail claim B with the secret read from reveal A" },
    { n: 12, who: "buyer", room: roomB, kind: "post", frame: "revealB", text: encodeFrame(frames.revealB), note: "reveal B frame" },
    { n: 13, who: "buyer", room: roomA, kind: "post", frame: "receiptA", text: encodeFrame(frames.receiptA), note: "receipt A (post-terminal acknowledgment)" },
    { n: 14, who: "seller", room: roomB, kind: "post", frame: "receiptB", text: encodeFrame(frames.receiptB), note: "receipt B" },
  ];

  // Self-check 1: tclk's own machine accepts every frame of each leg in order.
  const dryRun = (offer, accept, lockF, revealF, receiptF) => {
    let s = openContract(offer);
    for (const [f, t] of [[accept, t0 + 1], [lockF, t0 + 2 * MIN], [revealF, t0 + 5 * MIN], [receiptF, t0 + 6 * MIN]]) {
      const r = applyFrame(s, f, t);
      if (!r.ok) throw new Error(`plan self-check: ${f.type} rejected: ${r.reason}`);
      s = r.state;
    }
    return s.status;
  };
  const machineA = dryRun(offerA, acceptA, frames.lockA, frames.revealA, frames.receiptA);
  const machineB = dryRun(offerB, acceptB, frames.lockB, frames.revealB, frames.receiptB);
  // Self-check 2: the desk's own deadline rules at lock time t0.
  const deadlines = checkSwapDeadlines(offerA, offerB, t0, DEFAULT_POLICY_EXAMPLE);
  if (!deadlines.ok) throw new Error(`plan self-check: deadlines: ${deadlines.violations.join("; ")}`);

  return {
    inputs: { buyerDid, sellerDid, t0: new Date(t0).toISOString(), t0Ms: t0, nonceSeed, counterAsset, counterAmount, flopAmount },
    swapId: id,
    statement: lock.hash,
    secret: lock.preimage,
    legA: { offerId: offerA.id, contract: acceptA.contract, dealRoom: roomA, note: noteA, deadlines: A },
    legB: { offerId: offerB.id, contract: acceptB.contract, dealRoom: roomB, note: noteB, deadlines: B },
    selfCheck: { machineA, machineB, deadlines },
    frames,
    steps,
  };
}

/** Human-readable plan; the secret is redacted unless `redact` is false. */
export function renderPlan(plan, redact = true) {
  const r = (t) => (redact ? t.replaceAll(plan.secret, "<PREIMAGE-64-HEX>") : t);
  const lines = [];
  lines.push(`# PaperRail rehearsal plan (G0)`);
  lines.push(`swapId ${plan.swapId}`);
  lines.push(`statement ${plan.statement}`);
  lines.push(`buyer  ${plan.inputs.buyerDid}`);
  lines.push(`seller ${plan.inputs.sellerDid}`);
  lines.push(`t0 ${plan.inputs.t0} (leg B lock time; every deadline is relative to it)`);
  lines.push(`legA offer ${plan.legA.offerId} contract ${plan.legA.contract} room ${plan.legA.dealRoom}`);
  lines.push(`legB offer ${plan.legB.offerId} contract ${plan.legB.contract} room ${plan.legB.dealRoom}`);
  const d = plan.selfCheck.deadlines;
  lines.push(`self-check machine A=${plan.selfCheck.machineA} B=${plan.selfCheck.machineB}; deadlines ok=${d.ok} tOther=${d.tOtherBlocks} tFlop=${d.tFlopBlocks} required=${d.requiredTFlopBlocks}`);
  lines.push("");
  for (const s of plan.steps) {
    lines.push(`## ${s.n}. ${s.who} → ${s.kind} ${s.room}   (${s.text.length} chars) — ${s.note}`);
    if (s.ifValue) lines.push(`if=${r(s.ifValue)}`);
    lines.push(r(s.text));
    lines.push("");
  }
  return lines.join("\n");
}
