#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate the exact frame set and note writes for a PaperRail rehearsal of one two-leg swap
// (SPEC-ATOMIC-SWAP-DESK.md Phase 1, gate G0). Deterministic: the same inputs reproduce the
// same bytes, so an approver can read them, the poster can regenerate them at posting time
// with the real t0, and an auditor can diff what was posted against what was approved.
//
// This script POSTS NOTHING and SIGNS NOTHING. It writes one plan file under --out.
// The `paper` rail holds no value (tclk SPEC §5); this is choreography on real rooms only.
//
// Usage:
//   node bin/rehearsal.mjs --buyer-did did:key:z6Mk… --seller-did did:key:z6Mk… \
//     --t0 2026-09-19T15:00:00Z --nonce-seed <ascii> --preimage-file <32-byte hex file> \
//     --out <dir> [--counter-asset USDC --counter-amount 1000000 --flop-amount 1000000000000000000]
//
// Requires `npm run build` first (imports the vendored tclk dist).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  OFFER_ROOM, dealRoom, encodeFrame, makeAccept, makeOffer, hashLockFromPreimage,
  encodePaperRecord, paperNote, openContract, applyFrame,
} from "@flop-labs/tclk";
import { legAContext, legBContext, swapId } from "../dist/profile.js";
import { checkSwapDeadlines, DEFAULT_POLICY_EXAMPLE } from "../dist/deadlines.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const buyerDid = arg("buyer-did");
const sellerDid = arg("seller-did");
const t0 = Date.parse(arg("t0"));
if (!Number.isSafeInteger(t0)) { console.error("bad --t0"); process.exit(2); }
const nonceSeed = arg("nonce-seed");
const preimageFile = arg("preimage-file");
const out = arg("out");
const counterAsset = arg("counter-asset", "USDC");
const counterAmount = arg("counter-amount", "1000000");            // 1 USDC in 6 decimals
const flopAmount = arg("flop-amount", "1000000000000000000");       // 1 FLOP in VFY (18 dec)

mkdirSync(out, { recursive: true });
if (!existsSync(preimageFile)) {
  writeFileSync(preimageFile, "0x" + randomBytes(32).toString("hex"), { encoding: "utf8" });
}
const preimageHex = readFileSync(preimageFile, "utf8").trim();
const lock = hashLockFromPreimage(preimageHex);

/** Frame nonces: 16 hex chars from sha256(nonceSeed|label). Unique per label, reproducible. */
const nonce = (label) => createHash("sha256").update(`${nonceSeed}|${label}`).digest("hex").slice(0, 16);
const MIN = 60_000;

// SPEC §3.5 worked example, anchored at t0 (the moment leg B is expected to lock).
const A = { claimByMs: t0 + 45 * MIN, refundAfterMs: t0 + 60 * MIN, expiresMs: t0 + 30 * MIN };
const B = { claimByMs: t0 + 70 * MIN, refundAfterMs: t0 + 180 * MIN, expiresMs: t0 + 40 * MIN };

const id = swapId(buyerDid, nonce("swap"));

const offerA = makeOffer({
  from: buyerDid, role: "payer", amount: counterAmount, asset: counterAsset, lock: "hash",
  rails: ["evm-htlc", "paper"], ...A,
  job: { proto: "swap", id, context: legAContext({ wantAsset: "FLOP", wantAmount: flopAmount, wantRail: "flop-htlc" }) },
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

const lockB = { type: "lock", from: sellerDid, contract: acceptB.contract, rail: "paper", ref: acceptB.contract };
const lockA = { type: "lock", from: buyerDid, contract: acceptA.contract, rail: "paper", ref: acceptA.contract };
const revealA = { type: "reveal", from: sellerDid, contract: acceptA.contract, ref: acceptA.contract, secret: lock.preimage };
const revealB = { type: "reveal", from: buyerDid, contract: acceptB.contract, ref: acceptB.contract, secret: lock.preimage };
const receiptA = { type: "receipt", from: buyerDid, contract: acceptA.contract, outcome: "claimed", rail: "paper", ref: acceptA.contract };
const receiptB = { type: "receipt", from: sellerDid, contract: acceptB.contract, outcome: "claimed", rail: "paper", ref: acceptB.contract };

// PaperRail note writes (tclk src/paper-rail.ts): lock = set if absent; claim = CAS from the
// locked record to the claimed record carrying the secret.
const paperLocked = (statement, refundAfterMs) => encodePaperRecord({ status: "locked", lock: "hash", statement, refundAfterMs });
const paperClaimed = (statement, refundAfterMs) => encodePaperRecord({ status: "claimed", lock: "hash", statement, refundAfterMs, secret: lock.preimage });

const steps = [
  { n: 1, who: "buyer",  room: OFFER_ROOM, kind: "post", text: encodeFrame(offerA),  note: "leg A offer: Buyer pays counter-asset, wants FLOP" },
  { n: 2, who: "seller", room: OFFER_ROOM, kind: "post", text: encodeFrame(acceptA), note: "leg A accept: Seller mints the secret, statement = sha256(s)" },
  { n: 3, who: "seller", room: OFFER_ROOM, kind: "post", text: encodeFrame(offerB),  note: "leg B offer: Seller pays FLOP, context names leg A's offer id" },
  { n: 4, who: "buyer",  room: OFFER_ROOM, kind: "post", text: encodeFrame(acceptB), note: "leg B accept: Buyer copies the same statement" },
  { n: 5, who: "seller", room: `kv/${noteB.ns}/${noteB.key}`, kind: "note-set-if-absent", text: paperLocked(lock.hash, B.refundAfterMs), note: "PaperRail lock B (t0)" },
  { n: 6, who: "seller", room: roomB, kind: "post", text: encodeFrame(lockB),   note: "lock B frame (ref = contract id; paper rail)" },
  { n: 7, who: "buyer",  room: `kv/${noteA.ns}/${noteA.key}`, kind: "note-set-if-absent", text: paperLocked(lock.hash, A.refundAfterMs), note: "PaperRail lock A, only after verifying note B" },
  { n: 8, who: "buyer",  room: roomA, kind: "post", text: encodeFrame(lockA),   note: "lock A frame" },
  { n: 9, who: "seller", room: `kv/${noteA.ns}/${noteA.key}`, kind: "note-cas", text: paperClaimed(lock.hash, A.refundAfterMs), ifValue: paperLocked(lock.hash, A.refundAfterMs), note: "PaperRail claim A with the secret (the reveal)" },
  { n: 10, who: "seller", room: roomA, kind: "post", text: encodeFrame(revealA), note: "reveal A frame: the secret is now public" },
  { n: 11, who: "buyer",  room: `kv/${noteB.ns}/${noteB.key}`, kind: "note-cas", text: paperClaimed(lock.hash, B.refundAfterMs), ifValue: paperLocked(lock.hash, B.refundAfterMs), note: "PaperRail claim B with the secret read from reveal A" },
  { n: 12, who: "buyer",  room: roomB, kind: "post", text: encodeFrame(revealB), note: "reveal B frame" },
  { n: 13, who: "buyer",  room: roomA, kind: "post", text: encodeFrame(receiptA), note: "receipt A (post-terminal acknowledgment)" },
  { n: 14, who: "seller", room: roomB, kind: "post", text: encodeFrame(receiptB), note: "receipt B" },
];

// Self-check 1: tclk's own machine accepts every frame in order (no clock dependence beyond t0).
function dryRun(offer, accept, lockF, revealF, receiptF, at) {
  let s = openContract(offer);
  for (const [f, t] of [[accept, at + 1], [lockF, at + 2 * MIN], [revealF, at + 5 * MIN], [receiptF, at + 6 * MIN]]) {
    const r = applyFrame(s, f, t);
    if (!r.ok) throw new Error(`self-check: ${f.type} rejected: ${r.reason}`);
    s = r.state;
  }
  return s.status;
}
const statusA = dryRun(offerA, acceptA, lockA, revealA, receiptA, t0);
const statusB = dryRun(offerB, acceptB, lockB, revealB, receiptB, t0);

// Self-check 2: the desk's deadline rules hold for these two offers at lock time t0.
const deadlines = checkSwapDeadlines(offerA, offerB, t0, DEFAULT_POLICY_EXAMPLE);

// Self-check 3: the desk's composite fold reaches `revealed` on unsigned-free synthetic records?
// (foldSwap needs signed records; the poster produces those. Skipped here on purpose.)

const plan = {
  generatedAt: new Date().toISOString(),
  inputs: { buyerDid, sellerDid, t0: new Date(t0).toISOString(), nonceSeed, counterAsset, counterAmount, flopAmount },
  swapId: id,
  statement: lock.hash,
  preimageFile,                        // the secret stays in this file; it appears in steps 9–12 only
  legA: { offerId: offerA.id, contract: acceptA.contract, dealRoom: roomA, note: noteA, deadlines: A },
  legB: { offerId: offerB.id, contract: acceptB.contract, dealRoom: roomB, note: noteB, deadlines: B },
  selfCheck: { machineA: statusA, machineB: statusB, deadlines },
  steps,
};
writeFileSync(join(out, "plan.json"), JSON.stringify(plan, null, 2) + "\n");

const redact = (t) => t.replaceAll(lock.preimage, "<PREIMAGE-64-HEX>");
const lines = [];
lines.push(`# PaperRail rehearsal plan (G0) — generated ${plan.generatedAt}`);
lines.push(`swapId ${id}`);
lines.push(`statement ${lock.hash}`);
lines.push(`buyer  ${buyerDid}`);
lines.push(`seller ${sellerDid}`);
lines.push(`t0 ${plan.inputs.t0} (leg B lock time; every deadline is relative to it)`);
lines.push(`legA offer ${offerA.id} contract ${acceptA.contract} room ${roomA}`);
lines.push(`legB offer ${offerB.id} contract ${acceptB.contract} room ${roomB}`);
lines.push(`self-check machine A=${statusA} B=${statusB}; deadlines ok=${deadlines.ok} tOther=${deadlines.tOtherBlocks} tFlop=${deadlines.tFlopBlocks} required=${deadlines.requiredTFlopBlocks}`);
lines.push("");
for (const s of steps) {
  lines.push(`## ${s.n}. ${s.who} → ${s.kind} ${s.room}   (${s.text.length} chars) — ${s.note}`);
  if (s.ifValue) lines.push(`if=${s.ifValue}`);
  lines.push(redact(s.text));
  lines.push("");
}
writeFileSync(join(out, "plan.txt"), lines.join("\n"));
console.log(lines.join("\n"));
