// SPDX-License-Identifier: MIT
//
// Pure evidence adapter for tclk's `paper` rail (vendor/tclk/src/paper-rail.ts): turns one
// `/kv/<ns>/<key>` note body into the `LockEvidence`/`RailObservation` shapes `src/swap.ts`
// already understands. No I/O, no clock, no network — the caller fetches the note and
// supplies its body (or `null` when absent) and the time it was checked.
//
// The paper rail holds no value and its records are world-writable (see the warning atop
// vendor/tclk/src/paper-rail.ts); every verdict this module returns says so, because a
// reader who only sees `verified:true` could otherwise mistake a rehearsal note for a
// payment. Fail closed: anything that does not decode, or does not match the contract's
// own terms, is "unknown"/"differs", never guessed.
// Design source: flop-contrib/handoff/P05-SPEC.md, deliverable 1.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodePaperRecord, verifySecret, type LockKind } from "@flop-labs/tclk";

import type { LockEvidence, RailObservation } from "./types.js";

/** `LockEvidence.rail` value this module always sets. */
export const PAPER_RAIL_ID = "paper";

const WARNING = "paper rail holds no value and a stranger can overwrite it";

function paperReason(base: string): string {
  return `${base}; ${WARNING}`;
}

/**
 * Extract the note value from a technocore `/kv` read. technocore prefixes every note body
 * with a banner line starting `!! `, then a blank line, then the value; return the value
 * (its last non-empty line, with no trailing newline). `null` when nothing non-empty
 * remains. Never throws — a `/kv` body is anonymous input.
 */
export function stripNoteBanner(body: string): string | null {
  if (typeof body !== "string") return null;
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.length > 0) return line;
  }
  return null;
}

/**
 * The terms a paper record is checked against — taken from the contract's own offer/accept,
 * never from the deal room or the note itself (see `src/watcher.ts`'s candidate lookup).
 */
export interface PaperLegTerms {
  contract: string;
  lock: LockKind;
  statement: string;
  refundAfterMs: number;
}

export interface PaperEvidenceResult {
  lock: LockEvidence;
  rail?: RailObservation;
}

function termsMatch(terms: PaperLegTerms, record: { lock: LockKind; statement: string; refundAfterMs: number }): boolean {
  return (
    record.lock === terms.lock &&
    record.statement === terms.statement &&
    record.refundAfterMs === terms.refundAfterMs
  );
}

/**
 * Turn one `/kv` read into evidence for `terms.contract`'s lock. See P05-SPEC.md deliverable
 * 1 for the branch table this implements verbatim.
 */
export function paperEvidence(
  terms: PaperLegTerms,
  noteValue: string | null,
  checkedAtMs: number,
  endpoint: string,
): PaperEvidenceResult {
  const base = { rail: PAPER_RAIL_ID, ref: terms.contract, checkedAtMs, endpoint };

  if (noteValue === null) {
    return { lock: { ...base, verified: false, reason: paperReason("no paper record") } };
  }

  const record = decodePaperRecord(noteValue);
  if (record === null) {
    return { lock: { ...base, verified: false, reason: paperReason("unreadable paper record") } };
  }

  if (!termsMatch(terms, record)) {
    return {
      lock: { ...base, verified: false, reason: paperReason("paper record terms differ from the contract") },
    };
  }

  if (record.status === "claimed" && !verifySecret(record.lock, record.statement, record.secret ?? "")) {
    return {
      lock: {
        ...base,
        verified: false,
        reason: paperReason("claimed record's secret does not open the statement"),
      },
    };
  }

  // Terms match and (if claimed) the secret opens the statement: tclk's own
  // `PaperRail.verifyLock` would answer `true` iff the record is still `locked`.
  const finalizedRef = `paper:sha256:${bytesToHex(sha256(new TextEncoder().encode(noteValue)))}`;
  const verified = record.status === "locked";
  const rail: RailObservation = {
    status: record.status,
    final: true,
    checkedAtMs,
    finalizedRef,
  };
  return {
    lock: { ...base, verified, reason: paperReason(`paper record is ${record.status}`) },
    rail,
  };
}
