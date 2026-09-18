// SPDX-License-Identifier: MIT
//
// paperEvidence + stripNoteBanner: every branch of P05-SPEC.md deliverable 1's table, plus a
// golden built from the live G0 rehearsal note value (statement/refundAfterMs/secret quoted
// verbatim in the spec — no network access here).

import { encodePaperRecord, generateHashLock, generatePointLock, paperNote, type PaperRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { PAPER_RAIL_ID, paperEvidence, stripNoteBanner, type PaperLegTerms } from "../src/paper-evidence.js";

const WARNING_SUFFIX = "; paper rail holds no value and a stranger can overwrite it";
const T0 = 1_758_000_000_000;
const ENDPOINT = "https://technocore.example/kv/tclk-paper-ab/cdef0123456789";

const lock = generateHashLock();
const CONTRACT = `0x${"ab".repeat(32)}`;

function terms(overrides: Partial<PaperLegTerms> = {}): PaperLegTerms {
  return {
    contract: CONTRACT,
    lock: "hash",
    statement: lock.hash,
    refundAfterMs: T0 + 3_600_000,
    ...overrides,
  };
}

function note(record: PaperRecord): string {
  return encodePaperRecord(record);
}

describe("stripNoteBanner", () => {
  it("returns the note value: last non-empty line, trailing newline removed", () => {
    const body = "!! UNTRUSTED CONTENT — read-only, world-writable\n\ntclkpaper1 locked hash 0xabc 123\n";
    expect(stripNoteBanner(body)).toBe("tclkpaper1 locked hash 0xabc 123");
  });

  it("works with no trailing newline", () => {
    expect(stripNoteBanner("banner\n\nvalue")).toBe("value");
  });

  it("returns null when nothing non-empty remains", () => {
    expect(stripNoteBanner("")).toBeNull();
    expect(stripNoteBanner("\n\n\n")).toBeNull();
  });

  it("never throws on non-string input", () => {
    // @ts-expect-error deliberately anonymous/hostile input
    expect(stripNoteBanner(null)).toBeNull();
  });
});

describe("paperEvidence", () => {
  it("noteValue null: verified false, reason 'no paper record', no rail", () => {
    const result = paperEvidence(terms(), null, T0, ENDPOINT);
    expect(result.rail).toBeUndefined();
    expect(result.lock.rail).toBe(PAPER_RAIL_ID);
    expect(result.lock.ref).toBe(CONTRACT);
    expect(result.lock.endpoint).toBe(ENDPOINT);
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`no paper record${WARNING_SUFFIX}`);
  });

  it("unreadable note value: verified false, reason 'unreadable paper record', no rail", () => {
    const result = paperEvidence(terms(), "not a paper record at all", T0, ENDPOINT);
    expect(result.rail).toBeUndefined();
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`unreadable paper record${WARNING_SUFFIX}`);
  });

  it("terms mismatch on lock kind: no rail", () => {
    // A validly-encoded point-lock record (decodes fine) checked against hash-lock terms.
    const point = generatePointLock();
    const value = note({ status: "locked", lock: "point", statement: point.statement, refundAfterMs: terms().refundAfterMs });
    const result = paperEvidence(terms(), value, T0, ENDPOINT);
    expect(result.rail).toBeUndefined();
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`paper record terms differ from the contract${WARNING_SUFFIX}`);
  });

  it("terms mismatch on statement: no rail", () => {
    const other = generateHashLock();
    const value = note({ status: "locked", lock: "hash", statement: other.hash, refundAfterMs: terms().refundAfterMs });
    const result = paperEvidence(terms(), value, T0, ENDPOINT);
    expect(result.rail).toBeUndefined();
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`paper record terms differ from the contract${WARNING_SUFFIX}`);
  });

  it("terms mismatch on refundAfterMs: no rail", () => {
    const value = note({ status: "locked", lock: "hash", statement: lock.hash, refundAfterMs: terms().refundAfterMs + 1 });
    const result = paperEvidence(terms(), value, T0, ENDPOINT);
    expect(result.rail).toBeUndefined();
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`paper record terms differ from the contract${WARNING_SUFFIX}`);
  });

  it("claimed record whose secret does not open the statement: no rail", () => {
    const wrongSecret = generateHashLock().preimage; // does not open `lock.hash`
    const value = note({
      status: "claimed",
      lock: "hash",
      statement: lock.hash,
      refundAfterMs: terms().refundAfterMs,
      secret: wrongSecret,
    });
    const result = paperEvidence(terms(), value, T0, ENDPOINT);
    expect(result.rail).toBeUndefined();
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`claimed record's secret does not open the statement${WARNING_SUFFIX}`);
  });

  it("matching locked record: verified true, rail present, final true", () => {
    const value = note({ status: "locked", lock: "hash", statement: lock.hash, refundAfterMs: terms().refundAfterMs });
    const result = paperEvidence(terms(), value, T0, ENDPOINT);
    expect(result.lock.verified).toBe(true);
    expect(result.lock.reason).toBe(`paper record is locked${WARNING_SUFFIX}`);
    expect(result.rail).toEqual({
      status: "locked",
      final: true,
      checkedAtMs: T0,
      finalizedRef: expect.stringMatching(/^paper:sha256:[0-9a-f]{64}$/),
    });
  });

  it("matching claimed record with a secret that opens the statement: verified false, rail present", () => {
    const value = note({
      status: "claimed",
      lock: "hash",
      statement: lock.hash,
      refundAfterMs: terms().refundAfterMs,
      secret: lock.preimage,
    });
    const result = paperEvidence(terms(), value, T0, ENDPOINT);
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`paper record is claimed${WARNING_SUFFIX}`);
    expect(result.rail?.status).toBe("claimed");
    expect(result.rail?.final).toBe(true);
  });

  it("matching refunded record: verified false, rail present", () => {
    const value = note({ status: "refunded", lock: "hash", statement: lock.hash, refundAfterMs: terms().refundAfterMs });
    const result = paperEvidence(terms(), value, T0, ENDPOINT);
    expect(result.lock.verified).toBe(false);
    expect(result.lock.reason).toBe(`paper record is refunded${WARNING_SUFFIX}`);
    expect(result.rail?.status).toBe("refunded");
    expect(result.rail?.final).toBe(true);
  });

  it("every reason is present and ends with the paper-rail warning", () => {
    const cases: Array<string | null> = [
      null,
      "garbage",
      note({ status: "locked", lock: "hash", statement: generateHashLock().hash, refundAfterMs: terms().refundAfterMs }),
      note({ status: "locked", lock: "hash", statement: lock.hash, refundAfterMs: terms().refundAfterMs }),
      note({ status: "refunded", lock: "hash", statement: lock.hash, refundAfterMs: terms().refundAfterMs }),
    ];
    for (const value of cases) {
      const result = paperEvidence(terms(), value, T0, ENDPOINT);
      expect(result.lock.reason).toBeDefined();
      expect(result.lock.reason?.endsWith(WARNING_SUFFIX)).toBe(true);
    }
  });

  // Golden: the live G0 rehearsal note for leg A's contract (P05-SPEC.md "Live facts"),
  // re-verified with curl 2026-09-18. `secret` opens `statement`
  // (sha256(secret) === statement), confirmed independently before this test was written.
  describe("golden: G0 rehearsal leg A note", () => {
    const contract = "0xf9b7b56103f8268faf0b4afe8b5fda0cd45fef3c273002edf7a229a086e00d8f";
    const statement = "0xd23e9bb2438bbdd020561aeca491f197df35a2919fca67013791ed536dd99d21";
    const refundAfterMs = 1_789_768_619_605;
    const secret = "0x31cbb194b2895ee578e22935023bbb38c71460f0212a5d958d9f229b7aefb896";
    const { ns, key } = paperNote(contract);
    const endpoint = `https://technocore.chat/kv/${ns}/${key}`;
    const noteValue = `tclkpaper1 claimed hash ${statement} ${refundAfterMs} ${secret}`;

    it("decodes and verifies as a matching, claimed (settled-rehearsal) record", () => {
      const result = paperEvidence(
        { contract, lock: "hash", statement, refundAfterMs },
        noteValue,
        T0,
        endpoint,
      );
      expect(result.lock.rail).toBe(PAPER_RAIL_ID);
      expect(result.lock.ref).toBe(contract);
      expect(result.lock.endpoint).toBe(endpoint);
      expect(result.lock.verified).toBe(false); // claimed, not locked: no longer open
      expect(result.lock.reason).toBe(`paper record is claimed${WARNING_SUFFIX}`);
      expect(result.rail).toEqual({
        status: "claimed",
        final: true,
        checkedAtMs: T0,
        finalizedRef: expect.stringMatching(/^paper:sha256:[0-9a-f]{64}$/),
      });
    });
  });
});
