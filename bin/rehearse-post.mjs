#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The dedicated G0 rehearsal poster (Dave, 2026-09-18: "dedicated poster", "parametric").
// Regenerates the approved plan at the real t0 (same nonce seed, same preimage: only the
// timestamp fields change), then plays both sides of ONE two-leg PaperRail swap on the venue,
// posting only the plan's byte-identical lines through the signed lane, verifying each write by
// re-reading the venue, and logging every receipt. The Buyer learns the secret the honest way:
// by reading the Seller's reveal frame back from the deal room, not from local memory.
//
// Dry-run by default: prints what it would do and touches nothing. `--yes` posts.
// The `paper` rail holds no value. Seeds are Ed25519 chat-signing seeds, never wallets.
//
// Usage:
//   node bin/rehearse-post.mjs --buyer-seed FILE --seller-seed FILE --preimage-file FILE \
//     --nonce-seed "<ascii>" --out DIR [--base-url https://technocore.chat] [--t0 ISO] \
//     [--ledger FILE] [--expect-buyer-did did:key:…] [--expect-seller-did did:key:…] [--yes]
//
// Exit: 0 done (or dry-run) · 2 bad arguments/identity · 4 venue refused or verification failed.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";

import {
  OFFER_ROOM, PaperRail, applyFrame, openContract, lockTerms, tryDecodeFrame, verifySecret,
  transcriptRecord, verifyTranscriptRecord,
} from "@flop-labs/tclk";
import { buildPlan, renderPlan } from "./rehearsal-plan.mjs";

// ── args ─────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}
const YES = process.argv.includes("--yes");
const BASE = arg("base-url", "https://technocore.chat").replace(/\/+$/, "");
const out = arg("out");
mkdirSync(out, { recursive: true });
const LOG = join(out, "post-log.jsonl");
const LEDGER = arg("ledger", "");
const UA = "flop-swap-desk-rehearsal/0.0.1 (+https://github.com/djd39448/flop-swap-desk)";

// ── identities ───────────────────────────────────────────────────────────────
function signerFromSeedFile(file) {
  const t = readFileSync(file, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(t)) { console.error(`${file}: not a 32-byte hex seed`); process.exit(2); }
  const hex = t.startsWith("0x") ? t.slice(2) : t;
  const seed = Uint8Array.from(Buffer.from(hex, "hex"));
  const did = "did:key:z" + base58.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]));
  return { did, sign: (c) => base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(c), seed)) };
}
const buyer = signerFromSeedFile(arg("buyer-seed"));
const seller = signerFromSeedFile(arg("seller-seed"));
for (const [name, s, expect] of [["buyer", buyer, arg("expect-buyer-did", "")], ["seller", seller, arg("expect-seller-did", "")]]) {
  if (expect && s.did !== expect) { console.error(`${name} seed derives ${s.did}, expected ${expect}`); process.exit(2); }
}
if (buyer.did === seller.did) { console.error("buyer and seller must differ"); process.exit(2); }

// ── plan (regenerated at the real t0) ────────────────────────────────────────
const t0 = arg("t0", "") ? Date.parse(arg("t0")) : Date.now() + 3 * 60_000;
const plan = buildPlan({
  buyerDid: buyer.did, sellerDid: seller.did, t0,
  nonceSeed: arg("nonce-seed"), preimageHex: readFileSync(arg("preimage-file"), "utf8").trim(),
});
writeFileSync(join(out, "plan.posted.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ...plan }, null, 2) + "\n");
const signers = { buyer, seller };

// ── venue ────────────────────────────────────────────────────────────────────
let lastNonce = 0;
const nextNonce = () => (lastNonce = Math.max(Date.now(), lastNonce + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, init, what) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch(url, { ...init, redirect: "error", headers: { "user-agent": UA, ...(init?.headers ?? {}) } });
    if (res.status === 429 && attempt < 4) { await sleep(20_000 * attempt); continue; }
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  }
  throw new Error(`${what}: gave up after 429s`);
}

function log(row) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  appendFileSync(LOG, line + "\n");
  console.log(line.length > 220 ? line.slice(0, 217) + "..." : line);
}

async function readRoom(room, limit = 200) {
  const r = await req(`${BASE}/r/${room}?format=json&limit=${limit}`, undefined, `read ${room}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`read ${room}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  // The venue emits the transport nonce as a bare number past 2^53; keep its digits (watcher.ts).
  const fixed = r.body.replace(/(?<!\\)"nonce"(\s*:\s*)(\d+)(?=\s*[,}\r\n])/g, '"nonce"$1"$2"');
  const view = JSON.parse(fixed);
  const msgs = Array.isArray(view) ? view : view.messages ?? [];
  return msgs.map((m) => transcriptRecord(room, m));
}

/** Newest seq in a room (0 for an empty/absent room), for a `since=` verification window. */
async function newestSeq(room) {
  const recs = await readRoom(room, 1);
  return recs.at(-1)?.seq ?? 0;
}

/** Poll `since=<seq>` until our exact line from our DID appears (the busy board can lag a read). */
async function findLanded(room, sinceSeq, did, text) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const r = await req(`${BASE}/r/${room}?since=${sinceSeq}&format=json&limit=200`, undefined, `poll ${room}`);
    if (r.ok) {
      const fixed = r.body.replace(/(?<!\\)"nonce"(\s*:\s*)(\d+)(?=\s*[,}\r\n])/g, '"nonce"$1"$2"');
      let view;
      try { view = JSON.parse(fixed); } catch { view = null; }
      const msgs = Array.isArray(view) ? view : view?.messages ?? [];
      for (const m of msgs) {
        let rec;
        try { rec = transcriptRecord(room, m); } catch { continue; }
        if (rec.sender === did && rec.line === text) return rec;
      }
    }
    await sleep(1500);
  }
  return null;
}

async function post(who, room, text) {
  const signer = signers[who];
  const before = await newestSeq(room);
  const nonce = nextNonce();
  const sig = signer.sign(`${room}|${nonce}|${text}`);
  const r = await req(`${BASE}/r/${room}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: signer.did, sig, nonce: String(nonce), text }),
  }, `post ${room}`);
  // 422 = the room already holds this exact text recently; if it is OURS it counts as landed.
  if (!r.ok && r.status !== 422) throw new Error(`post to ${room} refused: HTTP ${r.status} ${r.body.slice(0, 300)}`);
  const hit = await findLanded(room, Math.max(0, before - 400), signer.did, text);
  if (!hit) throw new Error(`post to ${room}: HTTP ${r.status} but our line was not found since seq ${before - 400}`);
  const v = verifyTranscriptRecord(hit);
  if (!v.ok) throw new Error(`post to ${room}: landed record does not verify: ${v.reason}`);
  return hit.seq;
}

const notes = {
  async get(ns, key) {
    const r = await req(`${BASE}/kv/${ns}/${key}`, undefined, `kv get ${ns}/${key}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`kv get ${ns}/${key}: HTTP ${r.status}`);
    const value = r.body.split("\n").filter((l) => !l.startsWith("!!") && l.trim() !== "").join("\n").trimEnd();
    return value === "" ? null : value;
  },
  async set(ns, key, value, condition) {
    const q = condition === undefined ? "" : "ifAbsent" in condition ? "?if_absent=1" : `?if=${encodeURIComponent(condition.if)}`;
    const r = await req(`${BASE}/kv/${ns}/${key}/set/${encodeURIComponent(value)}${q}`, undefined, `kv set ${ns}/${key}`);
    if (r.status === 409) return false;
    if (!r.ok) throw new Error(`kv set ${ns}/${key}: HTTP ${r.status} ${r.body.slice(0, 200)}`);
    return true;
  },
};
const rail = new PaperRail(notes);

function ledger(row) {
  if (!LEDGER) return;
  appendFileSync(LEDGER, JSON.stringify(row) + "\n");
}

// ── the choreography ─────────────────────────────────────────────────────────
const F = plan.frames;
const S = Object.fromEntries(plan.steps.map((s) => [s.n, s]));
const identityName = (who) => (who === "buyer" ? "oas" : "swap-seller");

// --resume-from N: steps below N are taken as already on the venue (a previous run's receipts
// in post-log.jsonl); their frames are folded locally, nothing is re-posted. Requires --t0 of
// the earlier run so the regenerated bytes are identical (plan.posted.json → inputs.t0).
const RESUME_FROM = Number(arg("resume-from", "1"));
if (!Number.isSafeInteger(RESUME_FROM) || RESUME_FROM < 1 || RESUME_FROM > 15) { console.error("bad --resume-from"); process.exit(2); }

async function postStep(n) {
  const s = S[n];
  if (n < RESUME_FROM) { log({ step: n, resumed: true, who: s.who, room: s.room, kind: s.kind }); return -2; }
  if (!YES) { log({ step: n, dry: true, who: s.who, room: s.room, kind: s.kind, chars: s.text.length }); return -1; }
  const seq = await post(s.who, s.room, s.text);
  log({ step: n, who: s.who, did: signers[s.who].did, room: s.room, kind: "post", seq, frame: s.frame });
  ledger({ ts: Date.now() / 1000, room: s.room, seq, text: s.text, verified: true, identity: identityName(s.who), did: signers[s.who].did, source: "flop-swap-desk rehearse-post" });
  await sleep(2500);
  return seq;
}

async function main() {
  console.log(renderPlan(plan, true));
  console.log(YES ? "\n== POSTING ==" : "\n== DRY RUN (add --yes to post) ==");
  if (!YES) { for (const s of plan.steps) await postStep(s.n); return; }

  // Local views of each leg, folded exactly as a third party would.
  let stateA = openContract(F.offerA);
  let stateB = openContract(F.offerB);
  const step = (state, frame) => { const r = applyFrame(state, frame, Date.now()); if (!r.ok) throw new Error(`local fold rejected ${frame.type}: ${r.reason}`); return r.state; };

  await postStep(1);
  await postStep(2); stateA = step(stateA, F.acceptA);
  await postStep(3);
  await postStep(4); stateB = step(openContract(F.offerB), F.acceptB);

  // 5: Seller locks leg B on the paper rail (library semantics: set-if-absent, refuses a stale window).
  const refB = await rail.lock(lockTerms(stateB));
  log({ step: 5, who: "seller", kind: "note-set-if-absent", ns: S[5].ns, key: S[5].key, ref: refB });
  await sleep(2500);
  await postStep(6); stateB = step(stateB, F.lockB);

  // 7: Buyer verifies note B against its own view before locking A.
  if (!(await rail.verifyLock(lockTerms(stateB), refB))) throw new Error("buyer: verifyLock(B) false; refusing to lock A");
  const refA = await rail.lock(lockTerms(stateA));
  log({ step: 7, who: "buyer", kind: "note-set-if-absent", ns: S[7].ns, key: S[7].key, ref: refA, verifiedB: true });
  await sleep(2500);
  await postStep(8); stateA = step(stateA, F.lockA);

  // 9–10: Seller claims A with the secret (CAS note), then posts the reveal.
  if (!(await rail.verifyLock(lockTerms(stateA), refA))) throw new Error("seller: verifyLock(A) false; refusing to reveal");
  await rail.claim(refA, plan.secret);
  log({ step: 9, who: "seller", kind: "note-cas", ns: S[9].ns, key: S[9].key, ref: refA });
  await sleep(2500);
  await postStep(10);

  // 11–12: Buyer reads the reveal from deal room A, verifies it, claims B, posts reveal B.
  const roomARecords = await readRoom(plan.legA.dealRoom);
  const revealRec = roomARecords.find((rec) => rec.sender === seller.did && verifyTranscriptRecord(rec).ok && tryDecodeFrame(rec.line)?.type === "reveal");
  if (!revealRec) throw new Error("buyer: no verified reveal from the seller in deal room A");
  const learned = tryDecodeFrame(revealRec.line).secret;
  if (!verifySecret("hash", plan.statement, learned)) throw new Error("buyer: learned secret does not open the statement");
  stateA = step(stateA, tryDecodeFrame(revealRec.line));
  await rail.claim(refB, learned);
  log({ step: 11, who: "buyer", kind: "note-cas", ns: S[11].ns, key: S[11].key, ref: refB, learnedFromSeq: revealRec.seq });
  await sleep(2500);
  await postStep(12); stateB = step(stateB, F.revealB);

  await postStep(13); stateA = step(stateA, F.receiptA);
  await postStep(14); stateB = step(stateB, F.receiptB);
  log({ done: true, swapId: plan.swapId, legA: { contract: plan.legA.contract, room: plan.legA.dealRoom, status: stateA.status }, legB: { contract: plan.legB.contract, room: plan.legB.dealRoom, status: stateB.status } });
}

main().catch((e) => { log({ error: String(e?.message ?? e) }); process.exit(4); });
