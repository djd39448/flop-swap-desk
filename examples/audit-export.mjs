#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Offline audit replay (P05-SPEC.md deliverable 3): reproduce a watch root's board purely
// from what a live sweep already wrote to disk — the offer-room export(s), each swap's deal
// room capture(s), and any paper-rail note(s) — through the exact same fold the live watcher
// uses (src/replay.ts's `foldCaptured`), so a captured sweep can be re-verified without
// trusting the process that captured it. Opens no network connection: every input below is
// a file read under `--root`, and folding is pure. `SPEC-ATOMIC-SWAP-DESK.md` §8 Phase 1
// done-when: "folded to `settled` by the watcher; export persisted; audit replays from
// export alone … `examples/audit-export.mjs` verifies it."
//
//   node examples/audit-export.mjs --root DIR [--expect <swapId>=<status>]... [--json]
//
// Requires a build first: npm run build (this reads ../dist/, not ../src/).
//
// Exit codes: 0 ok (and every --expect held); 1 an --expect did not hold; 2 bad arguments
// (nothing was read); 3 `DIR/raw` is missing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { OFFER_ROOM, paperNote, transcriptRecord } from "@flop-labs/tclk";

import { quoteBigNonces } from "../dist/watcher.js";
import { findSwapLegCandidates, foldCaptured } from "../dist/replay.js";

const USAGE = `Usage: node examples/audit-export.mjs --root DIR [--expect <swapId>=<status>] [--json]

Offline: reads DIR/raw/ only. Opens no network connection.

  DIR/raw/tclk-offers/*.jsonl       one or more byte-exact offer-room exports (union, deduped
                                    by seq — later files in name order win a seq collision)
  DIR/raw/mb-p-tclk-*/*.json        one or more deal-room captures per room (latest used)
  DIR/raw/kv/<ns>/<key>/*.txt       one or more paper-rail note captures per note (latest used)

Options:
  --root DIR              Required. A watch root written by src/watcher.ts (or a fixture
                           shaped like one — see fixtures/rehearsal-2026-09-18/).
  --expect S=STATUS        May repeat. Exit 1 unless swap S folds to exactly STATUS.
  --json                   Print the result as JSON instead of a human-readable report.
  -h, --help               Show this message and exit 0.
`;

function parseArgs(argv) {
  const out = { root: null, expect: [], json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      out.root = argv[++i] ?? null;
      continue;
    }
    if (arg === "--expect") {
      const raw = argv[++i];
      const eq = typeof raw === "string" ? raw.indexOf("=") : -1;
      if (eq <= 0 || eq === raw.length - 1) return null;
      out.expect.push({ swapId: raw.slice(0, eq), status: raw.slice(eq + 1) });
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    return null;
  }
  if (out.root === null && !out.help) return null;
  return out;
}

/** Directory entries, oldest-first (ISO-stamped filenames sort chronologically); `[]` when
 *  the directory does not exist — a room or note this sweep never captured is not an error. */
function listFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Union of every `raw/tclk-offers/*.jsonl` export, deduped by seq — on the RAW parsed line,
 * BEFORE the expensive step (`transcriptRecord`'s field validation, and later the live
 * candidate scan's Ed25519 signature verification). A real watch root's export ring
 * recaptures the same ~36-minute window of venue-wide traffic in every sweep, so a swap
 * desk watching for hours accumulates dozens of files whose line sets mostly overlap;
 * fully validating (and, downstream, cryptographically verifying) the same line once per
 * file it appears in is pure waste that scales with wall-clock time, not with data. Only
 * the seq-deduped survivors are ever run through `transcriptRecord`.
 *
 * Later files (in `listFiles`'s name order — ISO-stamped filenames sort chronologically)
 * win a seq collision; the venue never rewrites a seq's content, so this is only ever a
 * tie-break among byte-identical copies, never a real conflict. A line that is not valid
 * JSON (at either stage) is skipped and counted, never thrown — a captured file, like any
 * `/kv` or room read, is anonymous input.
 */
function loadOffers(root) {
  const dir = join(root, "raw", OFFER_ROOM);
  const bySeq = new Map(); // seq -> parsed envelope (pre transcriptRecord validation)
  let malformedLines = 0;

  for (const name of listFiles(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    const normalized = quoteBigNonces(text); // same normalization the live sweep applies
    for (const line of normalized.split("\n")) {
      if (line.trim() === "") continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      if (value === null || typeof value !== "object" || !Number.isSafeInteger(value.seq) || value.seq < 0) {
        malformedLines += 1;
        continue;
      }
      bySeq.set(value.seq, value); // `value.text` — the byte-exact signed line — is untouched
    }
  }

  const records = [];
  for (const value of bySeq.values()) {
    try {
      records.push(transcriptRecord(OFFER_ROOM, value));
    } catch {
      // Passed the cheap seq check but failed transcriptRecord's full field validation
      // (bad timestamp, wrong field types, …): skipped and counted, same as above — never
      // lets one bad line in a huge capture discard every other record with it.
      malformedLines += 1;
    }
  }
  records.sort((a, b) => a.seq - b.seq);
  return { records, malformedLines };
}

/** Normalize a captured `?format=json` deal-room body — `{messages:[...]}` or a bare array
 *  — the same rule src/watcher.ts's normalizeDealRoomBody applies live. A malformed message
 *  is skipped, not fatal. */
function normalizeDealRoomBody(room, body) {
  let parsed;
  try {
    parsed = JSON.parse(quoteBigNonces(body));
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray(parsed.messages)
      ? parsed.messages
      : [];
  const records = [];
  for (const message of messages) {
    try {
      records.push(transcriptRecord(room, message));
    } catch {
      // malformed message: skipped, not fatal — anonymous input from a world-writable room.
    }
  }
  return records;
}

/** Every `raw/mb-p-tclk-*` directory: room name -> its latest capture's records. */
function loadDealRooms(root) {
  const rawDir = join(root, "raw");
  const dealRooms = new Map();
  let entries;
  try {
    entries = readdirSync(rawDir, { withFileTypes: true });
  } catch {
    return dealRooms;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("mb-p-tclk-")) continue;
    const files = listFiles(join(rawDir, entry.name));
    if (files.length === 0) continue;
    const latest = files[files.length - 1];
    const body = readFileSync(join(rawDir, entry.name, latest), "utf8");
    dealRooms.set(entry.name, normalizeDealRoomBody(entry.name, body));
  }
  return dealRooms;
}

/** Every swap-leg candidate's paper note (`raw/kv/<ns>/<key>/*.txt`, latest capture), keyed
 *  by contract — exactly the shape `foldCaptured` wants. A candidate with no captured note
 *  directory just gets no evidence for that leg (same as a live 404). */
function loadNotes(root, offers) {
  const { candidates } = findSwapLegCandidates(offers);
  const notes = new Map();
  for (const candidate of candidates) {
    const { ns, key } = paperNote(candidate.contract);
    const dir = join(root, "raw", "kv", ns, key);
    const files = listFiles(dir);
    if (files.length === 0) continue;
    const latest = files[files.length - 1];
    const body = readFileSync(join(dir, latest), "utf8");
    notes.set(candidate.contract, { body, endpoint: `https://technocore.chat/kv/${ns}/${key}` });
  }
  return notes;
}

function collectSeqs(steps, offerRoomSeqs, dealRoomSeqs) {
  for (const step of steps) {
    if (step.room === OFFER_ROOM) offerRoomSeqs.add(step.seq);
    else dealRoomSeqs.add(step.seq);
  }
}

function describeSwap(view) {
  const offerRoomSeqs = new Set();
  const dealRoomSeqs = new Set();
  if (view.legA) collectSeqs(view.legA.steps, offerRoomSeqs, dealRoomSeqs);
  if (view.legB) collectSeqs(view.legB.steps, offerRoomSeqs, dealRoomSeqs);
  const finalizedRefs = [view.evidence.aRail?.finalizedRef, view.evidence.bRail?.finalizedRef].filter(
    (ref) => ref !== undefined,
  );
  return {
    swapId: view.swapId,
    status: view.status,
    reasons: view.reasons,
    buyerDid: view.buyerDid,
    sellerDid: view.sellerDid,
    feeBps: view.feeBps,
    offerRoomSeqs: [...offerRoomSeqs].sort((a, b) => a - b),
    dealRoomSeqs: [...dealRoomSeqs].sort((a, b) => a - b),
    finalizedRefs,
  };
}

function printReport(swaps, unpaired) {
  for (const swap of swaps) {
    process.stdout.write(`swap ${swap.swapId ?? "(unpaired)"} -> ${swap.status}\n`);
    process.stdout.write(`  buyer=${swap.buyerDid ?? "?"} seller=${swap.sellerDid ?? "?"} feeBps=${swap.feeBps ?? "?"}\n`);
    process.stdout.write(`  offer-room seqs: ${swap.offerRoomSeqs.join(", ") || "(none)"}\n`);
    process.stdout.write(`  deal-room seqs:  ${swap.dealRoomSeqs.join(", ") || "(none)"}\n`);
    for (const ref of swap.finalizedRefs) process.stdout.write(`  finalizedRef: ${ref}\n`);
    for (const reason of swap.reasons) process.stdout.write(`  reason: ${reason}\n`);
  }
  if (unpaired.length > 0) {
    process.stdout.write("unpaired offers:\n");
    for (const u of unpaired) process.stdout.write(`  ${u.offerId}: ${u.reason}\n`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const rawDir = join(args.root, "raw");
  if (!existsSync(rawDir)) {
    process.stderr.write(`audit-export: no raw/ under ${args.root}\n`);
    return 3;
  }

  const { records: offers, malformedLines } = loadOffers(args.root);
  const dealRooms = loadDealRooms(args.root);
  const notes = loadNotes(args.root, offers);
  const board = foldCaptured({ offers, dealRooms, notes, nowMs: Date.now() });
  const swaps = board.swaps.map(describeSwap);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ swaps, unpaired: board.unpaired, malformedOfferLines: malformedLines }, null, 2)}\n`);
  } else {
    if (malformedLines > 0) {
      process.stdout.write(`offers: skipped ${malformedLines} malformed line(s) across raw/${OFFER_ROOM}/*.jsonl\n`);
    }
    printReport(swaps, board.unpaired);
  }

  let ok = true;
  for (const expectation of args.expect) {
    const found = swaps.find((s) => s.swapId === expectation.swapId);
    const actual = found ? found.status : "(swap not found)";
    if (actual !== expectation.status) {
      ok = false;
      process.stderr.write(`expect failed: ${expectation.swapId} = ${expectation.status}, got ${actual}\n`);
    }
  }

  return ok ? 0 : 1;
}

// Only run as a CLI when invoked directly (`node examples/audit-export.mjs ...`); importing
// this module (e.g. from a test, to exercise `loadOffers` directly) must not have the side
// effect of running the whole program.
export { loadOffers, loadDealRooms, loadNotes, describeSwap, parseArgs };
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
