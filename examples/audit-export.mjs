#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Offline audit replay (P05-SPEC.md deliverable 3): reproduce a watch root's board purely
// from what a live sweep already wrote to disk — the offer-room export(s), each swap's deal
// room capture(s), any paper-rail note(s), and (P22-P24-EVM-SPEC.md §5) any captured EVM
// chain reads — through the exact same fold the live watcher uses (src/replay.ts's
// `foldCaptured`). Opens no network connection: every input below is a file read under
// `--root`, and folding only touches the filesystem through `readCapture`'s own re-hashing
// reads. `SPEC-ATOMIC-SWAP-DESK.md` §8 Phase 1 done-when: "folded to `settled` by the
// watcher; export persisted; audit replays from export alone … `examples/audit-export.mjs`
// verifies it."
//
// P22-P24-EVM-FIXES-R3.md F3 — say what this proves, and no more: re-reading a capture this
// way detects a capture file that was *damaged, truncated, spliced from another capture,
// answered for a different request, or taken under a different rail config* — a
// `raw/rpc/<sha256>.json` whose bytes no longer match its name, a rewritten request, a
// swapped-in genuine response from a different capture (fails closed either way, A1/D1/F2 in
// `src/rails/evm-evidence.ts`) — and fails that leg closed. It does **not** detect forgery: a
// fabricated or edited RPC response, saved under the sha256 of its own new bytes and internally
// consistent with everything else in the capture, replays exactly as a genuine one would, and
// nothing proves the capturing process told the truth about the chain to begin with. This build adds no
// signing keys to close that gap (D-10 stays keyless). The independent check for any EVM leg
// is its own `finalizedRef` (`<pin>:finalized:<n>:<blockHash>`): it names a real block hash on
// the real chain, so anyone with their own RPC access to that chain can re-query
// `locks(hashLock)` at that exact block and compare, without trusting this repository, this
// script, or whoever ran the sweep that produced the capture.
//
//   node examples/audit-export.mjs --root DIR [--expect <swapId>=<status>]... [--rails FILE] [--json]
//
// Requires a build first: npm run build (this reads ../dist/, not ../src/).
//
// Exit codes: 0 ok (and every --expect held); 1 an --expect did not hold; 2 bad arguments
// (nothing was read, or --rails did not name readable JSON); 3 `DIR/raw` is missing.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { OFFER_ROOM, paperNote, transcriptRecord } from "@flop-labs/tclk";

import { quoteBigNonces } from "../dist/watcher.js";
import { findSwapLegCandidates, foldCaptured } from "../dist/replay.js";
import { loadBtcCapture } from "../dist/rails/btc-evidence.js";
import { checkBtcRailConfig } from "../dist/rails/btc-htlc.js";
import { loadEvmCapture } from "../dist/rails/evm-evidence.js";
import { checkEvmRailConfig } from "../dist/rails/evm-htlc.js";
import { loadNearCapture, nearCaptureKey } from "../dist/rails/near-evidence.js";
import { checkNearRailConfig } from "../dist/rails/near-htlc.js";

const USAGE = `Usage: node examples/audit-export.mjs --root DIR [--expect <swapId>=<status>] [--rails FILE] [--json]

Offline: reads DIR/raw/ (and DIR/rails.json) only. Opens no network connection.

  DIR/raw/tclk-offers/*.jsonl       one or more byte-exact offer-room exports (union, deduped
                                    by seq — later files in name order win a seq collision)
  DIR/raw/mb-p-tclk-*/*.json        one or more deal-room captures per room (latest used)
  DIR/raw/kv/<ns>/<key>/*.txt       one or more paper-rail note captures per note (latest used)
  DIR/raw/evm/<hashLock>/*.json     one or more EVM chain-read capture indexes per hashLock
                                    (newest only; an unreadable newest index gives that leg
                                    no evidence, never an older capture); their raw bytes are
                                    re-verified from DIR/raw/rpc/<sha256>.json through
                                    readCapture — a damaged or missing file fails that leg's
                                    evidence closed, never the whole replay. This detects corruption, splicing and
                                    config drift in what was captured, never forgery of the
                                    capture itself: independently re-query locks(hashLock) at
                                    the block named by the leg's own finalizedRef to check the
                                    real chain (see this file's header, F3).
  DIR/raw/btc/<txid>-<vout>/*.json  one or more Bitcoin chain-read capture indexes per funding
                                    outpoint (P4-BTC-SPEC.md §7 — newest only, same "never
                                    falls back" rule as raw/evm above; their raw bytes are
                                    re-verified from DIR/raw/rpc/<sha256>.json the same way).
                                    The honesty limit is identical to F3 above: this detects
                                    corruption/splicing/config drift, never forgery — the
                                    independent check is a leg's own finalizedRef, which names
                                    a real block hash and height anyone can re-query.
  DIR/raw/near/<hashLock>/<legContract>/*.json  one or more NEAR chain-read capture indexes per
                                    (hash lock, leg contract) pair (P5-NEAR-FIXES.md E1 — newest
                                    per pair only, same "never falls back" rule as raw/evm above;
                                    their raw bytes are re-verified from DIR/raw/rpc/<sha256>.json
                                    the same way). Keyed by the PAIR, not the hash lock alone, so
                                    two different leg contracts that happen to share one hash
                                    lock (a copycat pair, or H7's own hash-lock-squatting
                                    scenario) never overwrite or fold into each other's evidence
                                    — a hash lock directory holding more than one leg-contract
                                    subdirectory is reported as a note, never an error. Same
                                    honesty limit as F3 above: this detects corruption/splicing/
                                    config drift, never forgery — the independent check is a
                                    leg's own finalizedRef, which names a real block hash and
                                    height anyone with their own RPC access to that chain can
                                    re-query.
  DIR/rails.json                   { "evm"?: EvmRailConfig, "btc"?: BtcRailConfig,
                                    "near"?: NearRailConfig } the sweep that captured DIR used
                                    (P22-P24-EVM-SPEC.md §5; P4-BTC-SPEC.md §7;
                                    P5-NEAR-SPEC.md §4) — absent unless a chain rail was
                                    configured for that sweep.

Options:
  --root DIR              Required. A watch root written by src/watcher.ts (or a fixture
                           shaped like one — see fixtures/rehearsal-2026-09-18/).
  --expect S=STATUS        May repeat. Exit 1 unless swap S folds to exactly STATUS.
  --rails FILE             Use this JSON file ({ "evm": EvmRailConfig }) instead of
                           DIR/rails.json — e.g. to replay a capture against a config it
                           wasn't written next to.
  --json                   Print the result as JSON instead of a human-readable report.
  -h, --help               Show this message and exit 0.
`;

function parseArgs(argv) {
  const out = { root: null, expect: [], railsFile: null, json: false, help: false };
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
    if (arg === "--rails") {
      out.railsFile = argv[++i] ?? null;
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

/**
 * H2 (tclk#181): every `raw/swaps/<swapId>/offer-room/*.line` file the watcher archived —
 * one exact offer-room export line each, captured the first sweep that saw it, byte-exact
 * (see `archiveSwapOfferLines` in `src/watcher.ts`). The offers room is a byte ring that only
 * holds "tens of minutes" of traffic, so `loadOffers`'s own union of `raw/tclk-offers/*.jsonl`
 * exports can be missing a seq an old sweep saw once and a newer sweep's export no longer
 * carries; this fills exactly those gaps, never overriding a seq the ring union already has.
 */
function loadArchivedOfferLines(root) {
  const swapsDir = join(root, "raw", "swaps");
  const records = [];
  let entries;
  try {
    entries = readdirSync(swapsDir, { withFileTypes: true });
  } catch {
    return records;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(swapsDir, entry.name, "offer-room");
    for (const name of listFiles(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      for (const line of quoteBigNonces(text).split("\n")) {
        if (line.trim() === "") continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue; // a corrupted archive line is skipped, not fatal
        }
        try {
          records.push(transcriptRecord(OFFER_ROOM, value));
        } catch {
          continue;
        }
      }
    }
  }
  return records;
}

/**
 * H2 (tclk#181): every `raw/swaps/<swapId>/deal-rooms/<room>.json` the watcher archived —
 * the swap's own deal room(s), always the latest capture (`archiveSwapDealRoom`). Used only
 * to fill in a room `loadDealRooms` did not find under `raw/<room>/` (e.g. its timestamped
 * captures were pruned for disk space); the primary path wins when both exist.
 */
function loadDealRoomsFromSwapArchive(root) {
  const swapsDir = join(root, "raw", "swaps");
  const dealRooms = new Map();
  let entries;
  try {
    entries = readdirSync(swapsDir, { withFileTypes: true });
  } catch {
    return dealRooms;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(swapsDir, entry.name, "deal-rooms");
    for (const name of listFiles(dir)) {
      if (!name.endsWith(".json")) continue;
      const room = name.slice(0, -".json".length);
      if (dealRooms.has(room)) continue; // first (only) archived capture wins per room here
      const body = readFileSync(join(dir, name), "utf8");
      dealRooms.set(room, normalizeDealRoomBody(room, body));
    }
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

/** Every `raw/evm/<hashLock>/*.json` capture index (P22-P24-EVM-SPEC.md §4/§5), the newest
 *  one per hashLock — `loadEvmCapture` (src/rails/evm-evidence.ts, P22-P24-EVM-FIXES.md A11/
 *  A5) does the actual file I/O: it reads only the newest `*.json` index (never a `*.tmp-*`
 *  write-in-progress leftover), and if that file is unparseable or malformed the leg gets no
 *  evidence at all; it never falls back to an older capture, which would replay a previous
 *  sweep's verdict as current. It pre-loads + re-verifies the raw bytes from
 *  `raw/rpc/<sha256>.json` through `readCapture`, so a tampered or missing response file fails
 *  only that hashLock's evidence, never the replay itself. `notes` (pushed onto the array a
 *  caller supplies, A5's "with a note") names the bad newest file.
 *  No network: every byte comes from `--root`. Async only for this file-reading step —
 *  `foldCaptured` itself stays synchronous (A11). */
async function loadEvmCaptures(root, notes = []) {
  const evmDir = join(root, "raw", "evm");
  const chain = new Map();
  let entries;
  try {
    entries = readdirSync(evmDir, { withFileTypes: true });
  } catch {
    return chain;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hashLock = entry.name;
    const { capture, skipped } = await loadEvmCapture(root, hashLock);
    if (capture !== null) chain.set(hashLock, capture);
    for (const name of skipped) {
      notes.push(`raw/evm/${hashLock}/${name}: invalid newest capture index, skipped; this leg has no chain evidence (A5)`);
    }
  }
  return chain;
}

/** Every `raw/btc/<txid>-<vout>/*.json` capture index (P4-BTC-SPEC.md §7), the newest one per
 *  outpoint — the Bitcoin twin of `loadEvmCaptures` above, over `loadBtcCapture`
 *  (src/rails/btc-evidence.ts) instead of `loadEvmCapture`. Directory names are
 *  `<64-hex txid>-<vout>` (a hyphen, never the ref's own `:` — not a legal Windows filename
 *  character); reconstructed back into `"<txid>:<vout>"` before calling `loadBtcCapture`, which
 *  expects the ref in that shape. A directory name that doesn't match is skipped, not fatal —
 *  same tolerant treatment as every other read of anonymous on-disk state in this file. */
async function loadBtcCaptures(root, notes = []) {
  const btcDir = join(root, "raw", "btc");
  const chain = new Map();
  let entries;
  try {
    entries = readdirSync(btcDir, { withFileTypes: true });
  } catch {
    return chain;
  }
  const REF_DIR_SHAPE = /^([0-9a-f]{64})-([0-9]+)$/;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = REF_DIR_SHAPE.exec(entry.name);
    if (match === null) continue; // not a ref-shaped directory: skipped, not fatal
    const ref = `${match[1]}:${match[2]}`;
    const { capture, skipped } = await loadBtcCapture(root, ref);
    if (capture !== null) chain.set(ref, capture);
    for (const name of skipped) {
      notes.push(`raw/btc/${entry.name}/${name}: invalid newest capture index, skipped; this leg has no chain evidence`);
    }
  }
  return chain;
}

/** Every `raw/near/<hashLock>/<legContract>/*.json` capture index (P5-NEAR-FIXES.md E1), the
 *  newest one per (hashLock, legContract) pair — the NEAR twin of `loadEvmCaptures` above, over
 *  `loadNearCapture` (src/rails/near-evidence.ts) instead of `loadEvmCapture`. Directory names
 *  (both levels) are the hash lock / leg contract id as-is (`0x` + hex, no `:`, already
 *  filename-safe — unlike Bitcoin's `<txid>-<vout>` rewrite). Unlike EVM/Bitcoin, this is a
 *  TWO-level scan: a hash lock directory holding more than one leg-contract subdirectory means
 *  more than one leg accepted that exact hash lock this watch root ever saw (a copycat pair, or
 *  H7's own hash-lock-squatting scenario) — reported as a note, never an error; each leg's own
 *  capture is folded from its own subdirectory, untouched by the other's. The directory carries
 *  only the hash-lock part of the ref (squatting fix: the ref is `0x<hash lock>:<payer>`); each
 *  index records the full ref, and the fold requires it to equal the accepted lock frame's own. */
async function loadNearCaptures(root, notes = []) {
  const nearDir = join(root, "raw", "near");
  const chain = new Map();
  let hashLockEntries;
  try {
    hashLockEntries = readdirSync(nearDir, { withFileTypes: true });
  } catch {
    return chain;
  }
  for (const hashLockEntry of hashLockEntries) {
    if (!hashLockEntry.isDirectory()) continue;
    const hashLock = hashLockEntry.name;
    let legContractEntries;
    try {
      legContractEntries = readdirSync(join(nearDir, hashLock), { withFileTypes: true });
    } catch {
      continue;
    }
    const legContracts = legContractEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (legContracts.length > 1) {
      notes.push(
        `raw/near/${hashLock}: ${legContracts.length} different leg contracts captured under this hash lock ` +
          `(${[...legContracts].sort().join(", ")}) — kept separate, per-leg, never folded together`,
      );
    }
    for (const legContract of legContracts) {
      const { capture, skipped } = await loadNearCapture(root, hashLock, legContract);
      if (capture !== null) chain.set(nearCaptureKey(hashLock, legContract), capture);
      for (const name of skipped) {
        notes.push(
          `raw/near/${hashLock}/${legContract}/${name}: invalid newest capture index, skipped; this leg has no chain evidence`,
        );
      }
    }
  }
  return chain;
}

/** `{ "evm": EvmRailConfig }` for the fold's `rails` input (P22-P24-EVM-SPEC.md §5):
 *  `railsFileOverride` (`--rails FILE`) when given, else `DIR/rails.json`. `undefined` when
 *  neither exists — a watch root a chain rail was never configured for, folded exactly as
 *  before this option existed. Throws (a bad argument, per `main`'s exit code 2) when
 *  `--rails` named a file that could not be read or parsed, or when either file's own `evm`
 *  config fails `checkEvmRailConfig` (P22-P24-EVM-FIXES.md A3: shape check plus the allow
 *  list/D-09/finality checks) — a captured `rails.json` is just as untrusted as any other file
 *  under `--root`, so it gets validated the same way a live sweep's own `--rails` file does.
 *  `DIR/rails.json` being absent is not an error, since most watch roots never had one. */
function loadRails(root, railsFileOverride) {
  const path = railsFileOverride ?? join(root, "rails.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (railsFileOverride === undefined) return undefined; // DIR/rails.json is optional
    throw new Error(`cannot read --rails file ${path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--rails file ${path} is not valid JSON: ${error.message}`);
  }
  if (parsed !== null && typeof parsed === "object" && parsed.evm !== undefined) {
    const check = checkEvmRailConfig(parsed.evm);
    if (!check.ok) {
      throw new Error(`${path}: evm rail config is invalid: ${check.reason}`);
    }
  }
  if (parsed !== null && typeof parsed === "object" && parsed.btc !== undefined) {
    const check = checkBtcRailConfig(parsed.btc);
    if (!check.ok) {
      throw new Error(`${path}: btc rail config is invalid: ${check.reason}`);
    }
  }
  if (parsed !== null && typeof parsed === "object" && parsed.near !== undefined) {
    const check = checkNearRailConfig(parsed.near);
    if (!check.ok) {
      throw new Error(`${path}: near rail config is invalid: ${check.reason}`);
    }
  }
  return parsed;
}

function collectSeqs(steps, offerRoomSeqs, dealRoomSeqs) {
  for (const step of steps) {
    if (step.room === OFFER_ROOM) offerRoomSeqs.add(step.seq);
    else dealRoomSeqs.add(step.seq);
  }
}

/** P22-P24-EVM-FIXES-R3.md F4: the fields a live-vs-replay equivalence test actually needs to
 *  compare "in full" — `railVerified` and its `reason`, never just the coarser `settlementView`
 *  a mismatched verdict could still agree on by coincidence. `undefined` (never a thrown access
 *  on `undefined`) when this leg has no evidence at all. */
function describeLockEvidence(evidence) {
  if (evidence === undefined) return undefined;
  return { rail: evidence.rail, railVerified: evidence.railVerified, reason: evidence.reason, finalizedRef: evidence.finalizedRef };
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
    // H3: money state per leg, from rail evidence alone (tclk PR #173 vocabulary).
    settlementView: view.settlementView,
    // H4: verdicts here that rest on unsigned venue ts or export row order (tclk#175).
    coordinationOnly: view.coordinationOnly,
    reasons: view.reasons,
    buyerDid: view.buyerDid,
    sellerDid: view.sellerDid,
    feeBps: view.feeBps,
    offerRoomSeqs: [...offerRoomSeqs].sort((a, b) => a - b),
    dealRoomSeqs: [...dealRoomSeqs].sort((a, b) => a - b),
    finalizedRefs,
    // F4: each leg's own rail verdict (railVerified/reason/finalizedRef) and the terminal-side
    // rail observation (aRail/bRail) — a live sweep and this replay must agree on these exactly,
    // not merely on the coarser settlementView/status a divergence could still coincide on.
    evidence: {
      a: describeLockEvidence(view.evidence.a),
      b: describeLockEvidence(view.evidence.b),
      aRail: view.evidence.aRail,
      bRail: view.evidence.bRail,
    },
  };
}

function printReport(swaps, unpaired) {
  for (const swap of swaps) {
    process.stdout.write(`swap ${swap.swapId ?? "(unpaired)"} -> ${swap.status}\n`);
    process.stdout.write(`  settlementView: a=${swap.settlementView.a} b=${swap.settlementView.b}\n`);
    process.stdout.write(`  buyer=${swap.buyerDid ?? "?"} seller=${swap.sellerDid ?? "?"} feeBps=${swap.feeBps ?? "?"}\n`);
    process.stdout.write(`  offer-room seqs: ${swap.offerRoomSeqs.join(", ") || "(none)"}\n`);
    process.stdout.write(`  deal-room seqs:  ${swap.dealRoomSeqs.join(", ") || "(none)"}\n`);
    for (const ref of swap.finalizedRefs) process.stdout.write(`  finalizedRef: ${ref}\n`);
    // F4: railVerified (and its reason) for each leg that has any evidence at all.
    if (swap.evidence.a !== undefined) {
      process.stdout.write(`  evidence a: railVerified=${swap.evidence.a.railVerified} (${swap.evidence.a.reason ?? "no reason given"})\n`);
    }
    if (swap.evidence.b !== undefined) {
      process.stdout.write(`  evidence b: railVerified=${swap.evidence.b.railVerified} (${swap.evidence.b.reason ?? "no reason given"})\n`);
    }
    for (const flag of swap.coordinationOnly) process.stdout.write(`  coordination-only: ${flag.reason}\n`);
    for (const reason of swap.reasons) process.stdout.write(`  reason: ${reason}\n`);
  }
  if (unpaired.length > 0) {
    process.stdout.write("unpaired offers:\n");
    for (const u of unpaired) process.stdout.write(`  ${u.offerId}: ${u.reason}\n`);
  }
}

async function main() {
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

  let rails;
  try {
    rails = loadRails(args.root, args.railsFile ?? undefined);
  } catch (error) {
    process.stderr.write(`audit-export: ${error.message}\n`);
    return 2;
  }

  const { records: ringOffers, malformedLines } = loadOffers(args.root);
  // H2 (tclk#181): fill in any seq the ring's own export union no longer has from the
  // per-swap archive, so a swap still replays after the offers room has rolled past it.
  const offersBySeq = new Map(ringOffers.map((r) => [r.seq, r]));
  let archivedOfferLines = 0;
  for (const archived of loadArchivedOfferLines(args.root)) {
    if (offersBySeq.has(archived.seq)) continue;
    offersBySeq.set(archived.seq, archived);
    archivedOfferLines += 1;
  }
  const offers = [...offersBySeq.values()].sort((a, b) => a.seq - b.seq);

  const dealRooms = loadDealRooms(args.root);
  for (const [room, records] of loadDealRoomsFromSwapArchive(args.root)) {
    if (!dealRooms.has(room)) dealRooms.set(room, records);
  }

  const notes = loadNotes(args.root, offers);
  // P22-P24-EVM-SPEC.md §5: chain-read captures and their pinned config, both optional and
  // both absent from a watch root that never configured a chain rail — foldCaptured then
  // folds exactly as it always did. Still no network: readCapture only ever reads --root.
  // A5: `evmCaptureNotes` collects one line per invalid newest capture index (that leg fails closed).
  const evmCaptureNotes = [];
  const chain = await loadEvmCaptures(args.root, evmCaptureNotes);
  const btcCaptureNotes = [];
  const btcChain = await loadBtcCaptures(args.root, btcCaptureNotes);
  const nearCaptureNotes = [];
  const nearChain = await loadNearCaptures(args.root, nearCaptureNotes);
  const board = foldCaptured({ offers, dealRooms, notes, chain, btcChain, nearChain, rails, nowMs: Date.now() });
  const swaps = board.swaps.map(describeSwap);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          swaps,
          unpaired: board.unpaired,
          malformedOfferLines: malformedLines,
          archivedOfferLines,
          evmCaptureNotes,
          btcCaptureNotes,
          nearCaptureNotes,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (malformedLines > 0) {
      process.stdout.write(`offers: skipped ${malformedLines} malformed line(s) across raw/${OFFER_ROOM}/*.jsonl\n`);
    }
    if (archivedOfferLines > 0) {
      process.stdout.write(`offers: recovered ${archivedOfferLines} line(s) from raw/swaps/*/offer-room/ (ring rolled)\n`);
    }
    for (const note of evmCaptureNotes) process.stdout.write(`${note}\n`);
    for (const note of btcCaptureNotes) process.stdout.write(`${note}\n`);
    for (const note of nearCaptureNotes) process.stdout.write(`${note}\n`);
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
export {
  loadOffers,
  loadDealRooms,
  loadNotes,
  loadArchivedOfferLines,
  loadDealRoomsFromSwapArchive,
  loadEvmCaptures,
  loadBtcCaptures,
  loadNearCaptures,
  loadRails,
  describeSwap,
  parseArgs,
};
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`audit-export: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 3;
    },
  );
}
