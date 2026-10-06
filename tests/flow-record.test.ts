// SPDX-License-Identifier: MIT
//
// tests/flow-record.test.ts: P8-RESUME-SPEC.md "Surface" (the record), rules 1, 3, 5 and 6. The record is what a
// resumed flow trusts, so what it accepts and what it refuses are pinned here:
//   - a full round trip for both roles (every optional field, every recovery variant);
//   - the checksum, the version, the closed schema: any damage, unknown version or unknown field is a typed error,
//     never an empty record (rule 6);
//   - the preimage is written to exactly one place, the Seller's record, and a Buyer record cannot carry one (rule 5);
//   - the frame ledger refuses a second, different text for a kind (rule 3, "never a second, different account line");
//   - the identity pin against the runner's objects, and the load/save helpers over both stores.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dealRoom, OFFER_ROOM } from "@flop-labs/tclk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FLOW_RECORD_VERSION,
  FlowRecordConflictError,
  FlowRecordError,
  FlowRecordInvalidError,
  FlowRecordMismatchError,
  FlowRecordVersionError,
  bumped,
  checkRecordIdentity,
  cloneFlowRecord,
  decodeFlowRecord,
  encodeFlowRecord,
  evidenceFromJson,
  evidenceToJson,
  ledgerEntry,
  loadFlowRecord,
  loadFlowRecordWithDigest,
  markerFromJson,
  markerToJson,
  newBuyerRecord,
  newSellerRecord,
  railDeploymentId,
  recordKey,
  redactFlowRecord,
  saveFlowRecord,
  withLedgerIntent,
  withLedgerLanded,
  type FlowRecord,
} from "../src/client/flow-record.js";
import { FileFlowStore, FlowRecordStaleError, FlowStoreCorruptError, MemoryFlowStore, flowDigest, flowKey } from "../src/client/flow-store.js";
import {
  FORBIDDEN_FIELD_PATTERN,
  SAMPLE_BUYER,
  SAMPLE_CONTRACT_A,
  SAMPLE_CONTRACT_B,
  SAMPLE_PREIMAGE,
  SAMPLE_SELLER,
  SAMPLE_STATEMENT,
  SAMPLE_SWAP_ID,
  assertNoForbiddenFields,
  sampleBuyerRecord,
  sampleRecords,
  sampleSellerRecord,
} from "./helpers/flow-record-samples.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The test's own canonical JSON and envelope: pins the on-disk format independently of the module under test. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
function envelope(record: unknown, overrides: { v?: unknown; sum?: string } = {}): Uint8Array {
  const body = canonical(record);
  const sum = overrides.sum ?? createHash("sha256").update(body, "utf8").digest("hex");
  return bytes(`{"v":${JSON.stringify("v" in overrides ? overrides.v : 1)},"sum":"${sum}","record":${body}}`);
}
const plain = (record: FlowRecord): Record<string, unknown> => JSON.parse(JSON.stringify(record)) as Record<string, unknown>;

describe("round trip", () => {
  it.each(sampleRecords().map((r) => [r.role, r] as const))("a fully populated %s record decodes to exactly what was encoded", (_role, record) => {
    const encoded = encodeFlowRecord(record);
    const decoded = decodeFlowRecord(encoded, recordKey(record));
    expect(decoded).toEqual(record);
    // and the bytes are stable: encoding what was decoded gives the same bytes
    expect(text(encodeFlowRecord(decoded))).toBe(text(encoded));
  });

  it("the bytes are the documented envelope: {v:1, sum = sha256 of the record's canonical JSON, record}", () => {
    const record = sampleSellerRecord();
    const parsed = JSON.parse(text(encodeFlowRecord(record))) as { v: number; sum: string; record: unknown };
    expect(Object.keys(parsed).sort()).toEqual(["record", "sum", "v"]);
    expect(parsed.v).toBe(FLOW_RECORD_VERSION);
    expect(parsed.sum).toBe(createHash("sha256").update(canonical(parsed.record), "utf8").digest("hex"));
    expect(parsed.record).toEqual(plain(record));
  });

  it("fresh records are valid and minimal", () => {
    const buyer = newBuyerRecord({ swapId: SAMPLE_SWAP_ID, did: SAMPLE_BUYER.did, railId: "evm-htlc", caip2: "eip155:31337", deploymentId: "evm:0xrail:0xtoken", nowMs: 1_700_000_000_000 });
    expect(buyer).toMatchObject({ v: 1, role: "buyer", revision: 1, lock: { attempted: false, framePosted: false }, legBClaimAttempted: false, legBClaimed: false, ledger: [], refundNotes: [] });
    expect(decodeFlowRecord(encodeFlowRecord(buyer))).toEqual(buyer);
    const seller = newSellerRecord({
      swapId: SAMPLE_SWAP_ID,
      did: SAMPLE_SELLER.did,
      railId: "evm-htlc",
      caip2: "eip155:31337",
      deploymentId: "evm:0xrail:0xtoken",
      nowMs: 1_700_000_000_000,
      contractA: SAMPLE_CONTRACT_A,
      preimage: SAMPLE_PREIMAGE,
      statement: SAMPLE_STATEMENT,
    });
    expect(seller).toMatchObject({ v: 1, role: "seller", revision: 1, contractA: SAMPLE_CONTRACT_A, claimAttempted: false, claimOutcome: "none", claimRecords: [], revealPosted: false });
    expect(decodeFlowRecord(encodeFlowRecord(seller))).toEqual(seller);
  });

  it("refuses to build a Seller record whose preimage does not open its statement", () => {
    expect(() =>
      newSellerRecord({
        swapId: SAMPLE_SWAP_ID,
        did: SAMPLE_SELLER.did,
        railId: "evm-htlc",
        caip2: "eip155:31337",
        deploymentId: "evm:0xrail:0xtoken",
        nowMs: 1,
        contractA: SAMPLE_CONTRACT_A,
        preimage: `0x${"11".repeat(32)}`,
        statement: SAMPLE_STATEMENT,
      }),
    ).toThrow(FlowRecordInvalidError); // R1-09: a record the builder refuses is not a corrupt STORED record
  });

  it("keeps non-ASCII text intact (a UTF-8 round trip)", () => {
    const record = sampleBuyerRecord();
    record.refundNotes = ["a note with accents and symbols: caf\u00e9 \u2192 \u00fcber \u{1F512}"];
    expect(decodeFlowRecord(encodeFlowRecord(record))).toEqual(record);
  });
});

describe("rule 6: damage is a typed error, never an empty record", () => {
  const good = (): Uint8Array => encodeFlowRecord(sampleSellerRecord());

  it("empty, truncated, non-UTF-8 and non-JSON bytes", () => {
    const full = good();
    for (const damaged of [new Uint8Array(0), full.subarray(0, full.length - 7), full.subarray(0, 12), Uint8Array.from([0xff, 0xfe, 0x7b, 0x7d]), bytes("not json at all")]) {
      expect(() => decodeFlowRecord(damaged, "seller:" + SAMPLE_CONTRACT_A)).toThrow(FlowStoreCorruptError);
    }
  });

  it("a JSON value that is not the envelope (array, string, null, missing or extra keys)", () => {
    for (const value of ["[]", '"x"', "null", "{}", '{"v":1}', '{"v":1,"sum":"00"}', '{"v":1,"record":{}}']) {
      expect(() => decodeFlowRecord(bytes(value)), value).toThrow(/Flow|flow/);
    }
    const record = plain(sampleBuyerRecord());
    expect(() => decodeFlowRecord(bytes(`{"v":1,"sum":"x","record":${canonical(record)},"extra":1}`))).toThrow(FlowStoreCorruptError);
  });

  it("a body edited after the checksum was made (a flag flipped, still valid JSON)", () => {
    const original = good();
    const tampered = text(original).replace('"revealPosted":false', '"revealPosted":true');
    expect(tampered).not.toBe(text(original));
    expect(() => decodeFlowRecord(bytes(tampered))).toThrow(FlowStoreCorruptError);
    expect(() => decodeFlowRecord(bytes(tampered))).toThrow(/checksum/);
  });

  it("a wrong or missing checksum", () => {
    const record = plain(sampleSellerRecord());
    expect(() => decodeFlowRecord(envelope(record, { sum: "0".repeat(64) }))).toThrow(/checksum/);
    expect(() => decodeFlowRecord(bytes(`{"v":1,"sum":7,"record":${canonical(record)}}`))).toThrow(FlowStoreCorruptError);
  });

  it("an unknown version is FlowRecordVersionError: on the envelope, and on the record under a valid checksum", () => {
    const record = plain(sampleSellerRecord());
    for (const v of [2, 0, "1", null, 1.5]) {
      const error = (() => {
        try {
          decodeFlowRecord(envelope(record, { v }), "seller:" + SAMPLE_CONTRACT_A);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error, JSON.stringify(v)).toBeInstanceOf(FlowRecordVersionError);
    }
    expect(() => decodeFlowRecord(bytes(`{"sum":"x","record":${canonical(record)}}`))).toThrow(FlowRecordVersionError); // no version at all
    // the record's own version is checked too, even when the envelope and the checksum are consistent
    const inner = { ...record, v: 2 };
    const error = (() => {
      try {
        decodeFlowRecord(envelope(inner));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FlowRecordVersionError);
    expect((error as FlowRecordVersionError).version).toBe(2);
  });

  it("a record that is a real object but not a record", () => {
    for (const record of [null, [], "x", 3, { v: 1 }, { v: 1, role: "operator" }]) {
      expect(() => decodeFlowRecord(envelope(record)), JSON.stringify(record)).toThrow(FlowStoreCorruptError);
    }
    expect(() => decodeFlowRecord(envelope({}))).toThrow(FlowRecordVersionError); // no version at all
  });

  it("names the offending path in the error", () => {
    const record = plain(sampleSellerRecord());
    (record.legBRefund as Record<string, unknown>).done = "yes";
    const error = (() => {
      try {
        decodeFlowRecord(envelope(record), "seller:" + SAMPLE_CONTRACT_A);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FlowStoreCorruptError);
    expect((error as FlowStoreCorruptError).reason).toMatch(/record\.legBRefund\.done/);
    expect((error as FlowStoreCorruptError).key).toBe("seller:" + SAMPLE_CONTRACT_A);
  });

  it("a record cannot be encoded if it would not read back: FlowRecordInvalidError, never FlowStoreCorruptError (R1-09)", () => {
    const broken = sampleBuyerRecord();
    (broken as { revision: number }).revision = 0;
    const error = (() => {
      try {
        encodeFlowRecord(broken);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FlowRecordInvalidError);
    expect(error).not.toBeInstanceOf(FlowStoreCorruptError);
    expect((error as FlowRecordInvalidError).reason).toMatch(/record\.revision/);
    expect((error as FlowRecordInvalidError).key).toBe(recordKey(broken));
  });
});

describe("the closed schema: every field type, every unknown field", () => {
  type Mutation = [label: string, edit: (record: Record<string, unknown>) => void];
  const at = (record: Record<string, unknown>, ...path: string[]): Record<string, unknown> => path.reduce((o, k) => o[k] as Record<string, unknown>, record);
  /** A well-formed signed-record JSON for ledger entry `i` of `r`, to be broken one field at a time. */
  const landedRecordOf = (r: Record<string, unknown>, i: number): Record<string, unknown> => {
    const entry = (r.ledger as Array<Record<string, unknown>>)[i]!;
    const landed = entry.landed as { seq: number; nonce: string | null };
    return { room: entry.room, seq: landed.seq, timestampMs: 1, sender: r.did, nonce: landed.nonce, signature: "sig", line: entry.text };
  };

  const common: Mutation[] = [
    ["an unknown top-level field", (r) => void (r.surprise = 1)],
    ["swapId not 0x + 64 hex", (r) => void (r.swapId = "0x1234")],
    ["swapId in upper case", (r) => void (r.swapId = SAMPLE_SWAP_ID.toUpperCase().replace("0X", "0x"))],
    ["a did that is not did:key", (r) => void (r.did = "alice")],
    ["an empty railId", (r) => void (r.railId = "")],
    ["no deploymentId (R1-05: required for every record created from now on)", (r) => void delete r.deploymentId],
    ["an empty deploymentId", (r) => void (r.deploymentId = "")],
    ["a deploymentId that is not a string", (r) => void (r.deploymentId = 7)],
    ["a deploymentId over 512 characters", (r) => void (r.deploymentId = "d".repeat(513))],
    ["a non-integer createdAtMs", (r) => void (r.createdAtMs = 1.5)],
    ["a negative createdAtMs", (r) => void (r.createdAtMs = -1)],
    ["updatedAtMs before createdAtMs", (r) => void (r.updatedAtMs = 5)],
    ["revision 0", (r) => void (r.revision = 0)],
    ["a string revision", (r) => void (r.revision = "9")],
    ["a contract id that is not 0x + 64 hex", (r) => void (r.contractA = "contract")],
    ["lockTimeMs as a string", (r) => void (r.lockTimeMs = "soon")],
    ["legB missing a field", (r) => void delete at(r, "legB").expiresMs],
    ["legB with an extra field", (r) => void (at(r, "legB").extra = 1)],
    ["frames with an unknown slot", (r) => void (at(r, "frames").offerC = { text: "tclk1 {}" })],
    ["a frame text that is not a tclk/1 line", (r) => void (at(r, "frames", "offerA").text = "hello")],
    ["a frame text with a newline", (r) => void (at(r, "frames", "offerA").text = "tclk1 a\nb")],
    ["a slot record whose line is not the slot's text", (r) => void (at(r, "frames", "offerA", "record").line = "tclk1 {\"other\":1}")],
    ["a slot record with seq 0", (r) => void (at(r, "frames", "offerA", "record").seq = 0)],
    ["a slot record with an extra field", (r) => void (at(r, "frames", "offerA", "record").extra = 1)],
    ["a ledger that is not an array", (r) => void (r.ledger = {})],
    ["a ledger kind that does not exist", (r) => void (((r.ledger as unknown[])[0] as Record<string, unknown>).kind = "refund-c")],
    ["a ledger entry with an extra field", (r) => void (((r.ledger as unknown[])[0] as Record<string, unknown>).extra = 1)],
    ["a ledger entry landed at seq 0", (r) => void (((r.ledger as Array<Record<string, unknown>>)[0]!.landed as Record<string, unknown>).seq = 0)],
    ["a landed record whose line is not the entry's text", (r) => void (((r.ledger as Array<Record<string, unknown>>)[0]!.landed as Record<string, unknown>).record = { ...landedRecordOf(r, 0), line: "tclk1 {\"other\":1}" })],
    ["a landed record whose seq is not the mark's seq", (r) => void (((r.ledger as Array<Record<string, unknown>>)[0]!.landed as Record<string, unknown>).record = { ...landedRecordOf(r, 0), seq: 99 })],
    ["a landed record whose room is not the entry's room", (r) => void (((r.ledger as Array<Record<string, unknown>>)[0]!.landed as Record<string, unknown>).record = { ...landedRecordOf(r, 0), room: "tclk-other" })],
    ["a landed record sent by another party", (r) => void (((r.ledger as Array<Record<string, unknown>>)[0]!.landed as Record<string, unknown>).record = { ...landedRecordOf(r, 0), sender: "did:key:zOther" })],
    ["a ledger entry with a multi-line text", (r) => void (((r.ledger as unknown[])[0] as Record<string, unknown>).text = "a\nb")],
    ["a duplicate ledger kind", (r) => void (r.ledger as unknown[]).push({ ...((r.ledger as unknown[])[0] as Record<string, unknown>) })],
    ["an offers-room kind posted to a deal room", (r) => void (((r.ledger as unknown[])[0] as Record<string, unknown>).room = dealRoom(SAMPLE_CONTRACT_A))],
    ["a deal-room kind posted to the wrong room", (r) => void (((r.ledger as unknown[])[2] as Record<string, unknown>).room = dealRoom(SAMPLE_CONTRACT_B))],
    ["a deal-room kind posted to the offers room", (r) => void (((r.ledger as unknown[])[2] as Record<string, unknown>).room = OFFER_ROOM)],
  ];

  const buyerOnly: Mutation[] = [
    ["a preimage on a Buyer record (rule 5: it lives only in the Seller's record)", (r) => void (r.preimage = SAMPLE_PREIMAGE)],
    ["a statement on a Buyer record", (r) => void (r.statement = SAMPLE_STATEMENT)],
    ["a Seller-only ledger kind", (r) => void (r.ledger as unknown[]).push({ kind: "accept-a", room: OFFER_ROOM, text: "tclk1 {}" })],
    ["a reveal-b entry that holds the full reveal text instead of its digest (R1-18)", (r) => void (((r.ledger as unknown[])[4] as Record<string, unknown>).text = "tclk1 {\"type\":\"reveal\"}")],
    ["a reveal-b digest in upper case", (r) => void (((r.ledger as unknown[])[4] as Record<string, unknown>).text = `sha256:${"3C".repeat(32)}`)],
    ["a reveal-b entry with a landed record (its line would carry the secret)", (r) => void (((r.ledger as unknown[])[4] as Record<string, unknown>).landed = { seq: 7, nonce: null, record: { room: dealRoom(SAMPLE_CONTRACT_B), seq: 7, timestampMs: 1, sender: r.did, nonce: null, signature: "s", line: `sha256:${"3c".repeat(32)}` } })],
    ["legBVerified as a string", (r) => void (r.legBVerified = "true")],
    ["lock missing", (r) => void delete r.lock],
    ["lock with an unknown field", (r) => void (at(r, "lock").secret = "x")],
    ["a prepared lock on a lock that was never attempted", (r) => void (at(r, "lock").attempted = false)],
    ["a recovery for an unknown chain", (r) => void (at(r, "lock", "prepared", "recovery").chain = "doge")],
    ["a btc recovery with upper-case hex", (r) => void (at(r, "lock", "prepared", "recovery").rawTx = "DEADBEEF")],
    ["a btc recovery with odd-length hex", (r) => void (at(r, "lock", "prepared", "recovery").rawTx = "abc")],
    ["a btc recovery with a short txid", (r) => void (at(r, "lock", "prepared", "recovery").txid = "ab")],
    ["a btc recovery with an extra field", (r) => void (at(r, "lock", "prepared", "recovery").signature = "x")],
    ["a block marker of an unknown kind", (r) => void (at(r, "lock", "fromBlock").kind = "float")],
    ["a block marker that is not digits", (r) => void (at(r, "lock", "fromBlock").value = "-5")],
    ["a number marker beyond a safe integer", (r) => void ((at(r, "lock", "fromBlock").kind = "number"), (at(r, "lock", "fromBlock").value = "9007199254740993"))],
    ["lock evidence with an unknown event", (r) => void (at(r, "lock", "evidence").event = "Burned")],
    ["lock evidence with a non-numeric blockNumber", (r) => void (at(r, "lock", "evidence").blockNumber = "0x10")],
    ["lock evidence raw that is not an array", (r) => void (at(r, "lock", "evidence").raw = "x")],
    ["a hashLock that is not 0x + 64 hex", (r) => void (at(r, "lock").hashLock = "abc")],
    ["a refund recovery on a refund that was never attempted", (r) => void (at(r, "refund").attempted = false)],
    ["legBClaimed without legBClaimAttempted", (r) => void ((r.legBClaimed = true), (r.legBClaimAttempted = false))],
    ["legBClaimAdopted without legBClaimAttempted (R1-06)", (r) => void ((r.legBClaimAdopted = true), (r.legBClaimAttempted = false))],
    ["legBClaimAdopted together with legBClaimed: a claim is this flow's own or adopted, never both (R1-06)", (r) => void (r.legBClaimed = true)],
    ["a legBClaimAdopted of false (R1-06: it is true or absent)", (r) => void (r.legBClaimAdopted = false)],
    ["refundNotes that are not strings", (r) => void (r.refundNotes = [1])],
    ["a refund.claimSeen of false (R1-15: it is true or absent)", (r) => void (at(r, "refund").claimSeen = false)],
    ["a refund.claimSeen that is not a boolean (R1-15)", (r) => void (at(r, "refund").claimSeen = "yes")],
    ["an account line missing its text", (r) => void delete at(r, "ownAccountLine").text],
  ];

  const sellerOnly: Mutation[] = [
    ["a Seller record with no preimage", (r) => void delete r.preimage],
    ["a Seller record with no contractA (R1-14: it is the record's key, so it exists from birth)", (r) => void delete r.contractA],
    ["a Seller record whose contractA is not 0x + 64 hex", (r) => void (r.contractA = "contract")],
    ["a preimage that does not open the statement", (r) => void (r.preimage = `0x${"22".repeat(32)}`)],
    ["a preimage that is not 0x + 64 hex", (r) => void (r.preimage = "secret")],
    ["a Buyer-only field on a Seller record", (r) => void (r.legBVerified = true)],
    ["a Buyer-only ledger kind", (r) => void (r.ledger as unknown[]).push({ kind: "lock-a", room: dealRoom(SAMPLE_CONTRACT_A), text: "tclk1 {}" })],
    ["lockedLegBContract different from attemptedAcceptB", (r) => void (r.lockedLegBContract = `0x${"77".repeat(32)}`)],
    ["lockedLegBContract without attemptedAcceptB", (r) => void delete r.attemptedAcceptB],
    ["a claim outcome without claimAttempted", (r) => void (r.claimAttempted = false)],
    ["a claimFromBlock marker without claimAttempted (R1-13: it is saved with the attempt)", (r) => void ((r.claimAttempted = false), (r.claimOutcome = "none"), (r.claimRecords = []), delete r.publicClaimSignature)],
    ["a claimFromBlock marker of an unknown kind (R1-13)", (r) => void (at(r, "claimFromBlock").kind = "float")],
    ["a claimFromBlock marker that is not digits (R1-13)", (r) => void (at(r, "claimFromBlock").value = "-1")],
    ["failed-public without the proof signature", (r) => void delete r.publicClaimSignature],
    ["an unknown claim outcome", (r) => void (r.claimOutcome = "paid")],
    ["a claim record with no signature", (r) => void delete ((r.claimRecords as unknown[])[0] as Record<string, unknown>).signature],
    ["a claim record with a negative height", (r) => void (((r.claimRecords as unknown[])[0] as Record<string, unknown>).lastValidBlockHeight = -1)],
    ["the same claim signature twice", (r) => void (r.claimRecords as unknown[]).push({ ...((r.claimRecords as unknown[])[0] as Record<string, unknown>) })],
    ["negative neverLandedClaims", (r) => void (r.neverLandedClaims = -1)],
    ["legBRefund missing a flag", (r) => void delete at(r, "legBRefund").done],
    ["frozen accounts with an unknown field", (r) => void (at(r, "frozenLegAAccounts").extra = "x")],
  ];

  it.each(common)("buyer: %s is refused", (_label, edit) => {
    const record = plain(sampleBuyerRecord());
    edit(record);
    expect(() => decodeFlowRecord(envelope(record))).toThrow(FlowStoreCorruptError);
  });
  it.each(common)("seller: %s is refused", (_label, edit) => {
    const record = plain(sampleSellerRecord());
    // ledger index 2 is the account line in both samples; frames.offerA.record exists in both
    edit(record);
    expect(() => decodeFlowRecord(envelope(record))).toThrow(FlowStoreCorruptError);
  });
  it.each(buyerOnly)("buyer only: %s is refused", (_label, edit) => {
    const record = plain(sampleBuyerRecord());
    edit(record);
    expect(() => decodeFlowRecord(envelope(record))).toThrow(FlowStoreCorruptError);
  });
  it.each(sellerOnly)("seller only: %s is refused", (_label, edit) => {
    const record = plain(sampleSellerRecord());
    edit(record);
    expect(() => decodeFlowRecord(envelope(record))).toThrow(FlowStoreCorruptError);
  });

  it("the samples themselves pass every one of those checks unmutated (so each refusal above is caused by its edit)", () => {
    for (const record of sampleRecords()) expect(() => decodeFlowRecord(envelope(plain(record)))).not.toThrow();
  });

  it("accepts the other two recovery variants and a bigint marker", () => {
    const buyer = plain(sampleBuyerRecord());
    const lock = buyer.lock as Record<string, unknown>;
    lock.prepared = { ref: `${SAMPLE_STATEMENT}:buyer.near`, recovery: { chain: "near", txHash: "4wVf7Tj2", signedTxBase64: "AAECAwQ=" } };
    lock.fromBlock = { kind: "bigint", value: "123456789012345678901234567890" };
    (buyer.refund as Record<string, unknown>).recovery = { chain: "sol", signature: "5zzy", blockhash: "H", lastValidBlockHeight: 5082, signedSlot: 5031 };
    const decoded = decodeFlowRecord(envelope(buyer));
    expect(decoded).toEqual(buyer);
  });
});

describe("rule 5: the preimage lives in exactly one place", () => {
  it("only the Seller's bytes hold the preimage; a Buyer record cannot", () => {
    const buyerBytes = text(encodeFlowRecord(sampleBuyerRecord()));
    const sellerBytes = text(encodeFlowRecord(sampleSellerRecord()));
    expect(sellerBytes).toContain(SAMPLE_PREIMAGE.slice(2));
    expect(buyerBytes).not.toContain(SAMPLE_PREIMAGE.slice(2));
    expect(buyerBytes).not.toMatch(/preimage/);
  });

  it("redactFlowRecord is fit for a log: no preimage hex, the rest intact; a Buyer record is unchanged", () => {
    const seller = sampleSellerRecord();
    const redacted = redactFlowRecord(seller);
    expect(JSON.stringify(redacted)).not.toContain(SAMPLE_PREIMAGE.slice(2));
    expect(redacted.preimage).toBe("[redacted]");
    expect(redacted.statement).toBe(SAMPLE_STATEMENT);
    expect(seller.preimage).toBe(SAMPLE_PREIMAGE); // the record itself is untouched
    const buyer = sampleBuyerRecord();
    expect(redactFlowRecord(buyer)).toEqual(plain(buyer));
  });

  it("no sample record carries a forbidden field name or key marker (the fixture scans' regex, applied to what a flow persists)", () => {
    for (const record of sampleRecords()) assertNoForbiddenFields(encodeFlowRecord(record), `${record.role} sample`);
    // and the scan has teeth
    expect(() => assertNoForbiddenFields('{"secretKey":"x"}')).toThrow(/forbidden/);
    expect(() => assertNoForbiddenFields("-----BEGIN PRIVATE KEY-----")).toThrow(/forbidden/);
    expect(FORBIDDEN_FIELD_PATTERN.test('"mnemonic"')).toBe(true);
  });

  it("every field name the schema knows is free of the forbidden words", () => {
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          names.add(k);
          walk(v);
        }
      }
    };
    sampleRecords().forEach(walk);
    expect(names.has("preimage")).toBe(true);
    for (const name of names) expect(name, name).not.toMatch(/secret_key|private_key|secretKey|keypair|mnemonic|seed/i);
  });
});

describe("the key pins the record", () => {
  it("a record stored under another role's or another swap's key is a mismatch, not a resume", () => {
    const bytesOfBuyer = encodeFlowRecord(sampleBuyerRecord());
    expect(() => decodeFlowRecord(bytesOfBuyer, flowKey("seller", SAMPLE_CONTRACT_A))).toThrow(FlowRecordMismatchError);
    expect(() => decodeFlowRecord(bytesOfBuyer, flowKey("buyer", `0x${"01".repeat(32)}`))).toThrow(FlowRecordMismatchError);
    expect(() => decodeFlowRecord(bytesOfBuyer, flowKey("buyer", SAMPLE_SWAP_ID))).not.toThrow();
    const error = (() => {
      try {
        decodeFlowRecord(bytesOfBuyer, flowKey("seller", SAMPLE_CONTRACT_A));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect((error as FlowRecordMismatchError).field).toBe("role");
  });
});

describe("checkRecordIdentity: the runner's DID, rail, chain and contracts must match", () => {
  const expected = () => ({
    role: "seller" as const,
    swapId: SAMPLE_SWAP_ID,
    did: SAMPLE_SELLER.did,
    railId: "trustcore.sol-htlc-v1",
    caip2: "solana:localnet-flop",
    deploymentId: "sol:program-sample:mint-sample",
  });

  it("passes when everything matches (contracts only when both sides know them)", () => {
    const record = sampleSellerRecord();
    expect(() => checkRecordIdentity(record, expected())).not.toThrow();
    expect(() => checkRecordIdentity(record, { ...expected(), contractA: SAMPLE_CONTRACT_A, contractB: SAMPLE_CONTRACT_B })).not.toThrow();
    const young = newBuyerRecord({ ...expected(), nowMs: 1 });
    expect(() => checkRecordIdentity(young, { ...expected(), role: "buyer", contractA: SAMPLE_CONTRACT_A })).not.toThrow(); // a Buyer record has none yet
    expect(() => checkRecordIdentity(record, { role: "seller", did: SAMPLE_SELLER.did, railId: "trustcore.sol-htlc-v1", caip2: "solana:localnet-flop" })).not.toThrow(); // a Seller resumes by contractA: swapId is optional
  });

  it.each([
    ["role", { role: "buyer" as const }],
    ["swapId", { swapId: `0x${"02".repeat(32)}` }],
    ["did", { did: SAMPLE_BUYER.did }],
    ["railId", { railId: "evm-htlc" }],
    ["caip2", { caip2: "solana:devnet" }],
    ["deploymentId", { deploymentId: "sol:another-program:mint-sample" }],
    ["contractA", { contractA: `0x${"03".repeat(32)}` }],
    ["contractB", { contractB: `0x${"04".repeat(32)}` }],
  ])("a different %s is a FlowRecordMismatchError naming it", (field, change) => {
    const error = (() => {
      try {
        checkRecordIdentity(sampleSellerRecord(), { ...expected(), ...change });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe(field);
  });
});

describe("rule 3: the frame ledger", () => {
  const roomA = dealRoom(SAMPLE_CONTRACT_A);
  const fresh = () => {
    const record = newBuyerRecord({ swapId: SAMPLE_SWAP_ID, did: SAMPLE_BUYER.did, railId: "evm-htlc", caip2: "eip155:31337", deploymentId: "evm:0xrail:0xtoken", nowMs: 1 });
    return { ...record, contractA: SAMPLE_CONTRACT_A };
  };

  it("records the intent before the post, and the same text again is a no-op", () => {
    const record = fresh();
    const once = withLedgerIntent(record, { kind: "account-a", room: roomA, text: "acct line v1" });
    expect(once.ledger).toEqual([{ kind: "account-a", room: roomA, text: "acct line v1" }]);
    expect(record.ledger).toEqual([]); // the input is not mutated
    const twice = withLedgerIntent(once, { kind: "account-a", room: roomA, text: "acct line v1" });
    expect(twice).toBe(once); // identical bytes: nothing to write
  });

  it("refuses a second, different account line (or any second text for a kind) and a different room", () => {
    const once = withLedgerIntent(fresh(), { kind: "account-a", room: roomA, text: "acct line v1" });
    expect(() => withLedgerIntent(once, { kind: "account-a", room: roomA, text: "acct line v2" })).toThrow(FlowRecordConflictError);
    expect(() => withLedgerIntent(once, { kind: "account-a", room: dealRoom(SAMPLE_CONTRACT_B), text: "acct line v1" })).toThrow(FlowRecordConflictError);
  });

  it("refuses an entry the role never posts or whose room does not fit (the record stays valid)", () => {
    expect(() => withLedgerIntent(fresh(), { kind: "accept-a", room: OFFER_ROOM, text: "tclk1 {}" })).toThrow(FlowRecordInvalidError);
    expect(() => withLedgerIntent(fresh(), { kind: "lock-a", room: dealRoom(SAMPLE_CONTRACT_B), text: "tclk1 {}" })).toThrow(FlowRecordInvalidError);
  });

  it("marks an entry landed with the venue's seq and nonce; repeating the same is a no-op, a different seq is a conflict", () => {
    const intent = withLedgerIntent(fresh(), { kind: "lock-a", room: roomA, text: "tclk1 {\"lock\":1}" });
    const landed = withLedgerLanded(intent, "lock-a", { seq: 3, nonce: "10003" });
    expect(ledgerEntry(landed, "lock-a")?.landed).toEqual({ seq: 3, nonce: "10003" });
    expect(ledgerEntry(intent, "lock-a")?.landed).toBeUndefined();
    expect(withLedgerLanded(landed, "lock-a", { seq: 3, nonce: "10003" })).toBe(landed);
    expect(() => withLedgerLanded(landed, "lock-a", { seq: 4, nonce: "10004" })).toThrow(FlowRecordConflictError);
    expect(() => withLedgerLanded(fresh(), "lock-a", { seq: 1, nonce: null })).toThrow(FlowRecordConflictError);
    expect(withLedgerLanded(intent, "lock-a", { seq: 9, nonce: null }).ledger[0]?.landed).toEqual({ seq: 9, nonce: null });
  });

  it("an intent survives encode/decode with its landed state", () => {
    const record = withLedgerLanded(withLedgerIntent(fresh(), { kind: "lock-a", room: roomA, text: "tclk1 {\"lock\":1}" }), "lock-a", { seq: 3, nonce: "10003" });
    expect(decodeFlowRecord(encodeFlowRecord(record))).toEqual(record);
  });
});

describe("bumped / cloneFlowRecord", () => {
  it("bumps the revision and never lets updatedAtMs go backwards, leaving the original alone", () => {
    const record = sampleSellerRecord();
    const later = bumped(record, record.updatedAtMs + 500);
    expect(later.revision).toBe(record.revision + 1);
    expect(later.updatedAtMs).toBe(record.updatedAtMs + 500);
    expect(record.revision).toBe(12);
    const earlier = bumped(record, 5);
    expect(earlier.updatedAtMs).toBe(record.updatedAtMs); // a clock that moved back changes nothing
    expect(decodeFlowRecord(encodeFlowRecord(later))).toEqual(later);
  });

  it("cloneFlowRecord is a deep copy", () => {
    const record = sampleBuyerRecord();
    const copy = cloneFlowRecord(record);
    copy.refundNotes.push("x");
    (copy.ledger[0] as { text: string }).text = "changed";
    expect(record.refundNotes).toHaveLength(1);
    expect(record.ledger[0]?.text).not.toBe("changed");
  });
});

describe("values that are not plain JSON", () => {
  it("block markers: bigint (EVM) and number (the others) round-trip; anything else cannot be persisted", () => {
    expect(markerToJson(123n)).toEqual({ kind: "bigint", value: "123" });
    expect(markerToJson(0)).toEqual({ kind: "number", value: "0" });
    expect(markerFromJson(markerToJson(10n ** 30n))).toBe(10n ** 30n);
    expect(markerFromJson(markerToJson(200))).toBe(200);
    for (const bad of [-1n, -1, 1.5, Number.NaN, "5", null, undefined, {}, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => markerToJson(bad), String(bad)).toThrow(FlowRecordError);
    }
  });

  it("write evidence: bigint block numbers survive as digits, absent fields stay absent", () => {
    const evm = { ref: `0x${"11".repeat(32)}`, event: "Locked" as const, txHash: `0x${"aa".repeat(32)}`, blockNumber: 31337n * 10n ** 20n, blockHash: `0x${"bb".repeat(32)}`, logIndex: 3, raw: ["r1", "r2"] };
    const json = evidenceToJson(evm);
    expect(json.blockNumber).toBe("3133700000000000000000000");
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(evidenceFromJson(json)).toEqual(evm);
    const btc = { ref: "ab:1", txid: "ab", blockHeight: null, blockHash: null, raw: [], rawTx: "00" };
    expect(evidenceFromJson(evidenceToJson(btc))).toEqual(btc);
    const sol = { ref: "r", txHash: "sig", blockHeight: 12, raw: ["x"], claimedByAnotherTransaction: true as const };
    expect(evidenceFromJson(evidenceToJson(sol))).toEqual(sol);
    expect("blockNumber" in evidenceToJson(btc)).toBe(false);
  });
});

describe("loadFlowRecord / saveFlowRecord over both stores", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flowrecord-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when nothing was saved, and the record when it was (memory store)", async () => {
    const store = new MemoryFlowStore();
    expect(await loadFlowRecord(store, "seller", SAMPLE_CONTRACT_A)).toBeNull();
    const record = sampleSellerRecord();
    await saveFlowRecord(store, record, null);
    expect(await store.list()).toEqual([flowKey("seller", SAMPLE_CONTRACT_A)]); // a Seller record is keyed by contractA (R1-14)
    expect(await loadFlowRecord(store, "seller", SAMPLE_CONTRACT_A)).toEqual(record);
    expect(await loadFlowRecord(store, "seller", SAMPLE_SWAP_ID)).toBeNull(); // the swap id is not its key
    expect(await loadFlowRecord(store, "buyer", SAMPLE_SWAP_ID)).toBeNull();
  });

  it("round-trips through a file store, and a fresh instance (a restarted process) reads the same record", async () => {
    const dir = join(root, "flows");
    await saveFlowRecord(new FileFlowStore(dir), sampleBuyerRecord(), null);
    expect(await loadFlowRecord(new FileFlowStore(dir), "buyer", SAMPLE_SWAP_ID)).toEqual(sampleBuyerRecord());
  });

  it("a damaged file is a typed error from load, never null: a corrupt store header, and a corrupt record under a valid header", async () => {
    const dir = join(root, "flows");
    const store = new FileFlowStore(dir);
    await saveFlowRecord(store, sampleSellerRecord(), null);
    const file = join(dir, `seller-${SAMPLE_CONTRACT_A}.json`);
    const whole = readFileSync(file);
    writeFileSync(file, whole.subarray(0, whole.length - 9)); // truncated on disk
    await expect(loadFlowRecord(store, "seller", SAMPLE_CONTRACT_A)).rejects.toThrow(FlowStoreCorruptError);
    // a store that hands back bytes that are not a record at all
    const memory = new MemoryFlowStore();
    const key = flowKey("seller", SAMPLE_CONTRACT_A);
    await memory.save(key, bytes("{}"), null);
    await expect(loadFlowRecord(memory, "seller", SAMPLE_CONTRACT_A)).rejects.toThrow(FlowRecordVersionError);
    await memory.save(key, bytes("garbage"), flowDigest(bytes("{}")));
    await expect(loadFlowRecord(memory, "seller", SAMPLE_CONTRACT_A)).rejects.toThrow(FlowStoreCorruptError);
  });

  it("a failed store write propagates (the flow must not go on): nothing is stored, the old record survives", async () => {
    const store = new MemoryFlowStore();
    const first = sampleBuyerRecord();
    const digest = await saveFlowRecord(store, first, null);
    store.failSave(2);
    await expect(saveFlowRecord(store, bumped(first, first.updatedAtMs + 1), digest)).rejects.toThrow(/injected fault/);
    expect(await loadFlowRecord(store, "buyer", SAMPLE_SWAP_ID)).toEqual(first);
  });

  it("only the Seller's store entry holds the preimage", async () => {
    const store = new MemoryFlowStore();
    await saveFlowRecord(store, sampleBuyerRecord(), null);
    await saveFlowRecord(store, sampleSellerRecord(), null);
    for (const key of await store.list()) {
      const holds = text((await store.load(key))!).includes(SAMPLE_PREIMAGE.slice(2));
      expect(holds, key).toBe(key.startsWith("seller:"));
    }
  });
});

describe("R1-14: a Seller record is keyed by leg A's contract id, a Buyer record by the swap id", () => {
  it("recordKey: buyer:<swapId> and seller:<contractA>", () => {
    expect(recordKey(sampleBuyerRecord())).toBe(`buyer:${SAMPLE_SWAP_ID}`);
    expect(recordKey(sampleSellerRecord())).toBe(`seller:${SAMPLE_CONTRACT_A}`);
  });

  it("a Seller record decoded under seller:<swapId> is a mismatch naming contractA: a squatter's copied swap id takes no slot", () => {
    const bytesOfSeller = encodeFlowRecord(sampleSellerRecord());
    expect(() => decodeFlowRecord(bytesOfSeller, flowKey("seller", SAMPLE_CONTRACT_A))).not.toThrow();
    const error = (() => {
      try {
        decodeFlowRecord(bytesOfSeller, flowKey("seller", SAMPLE_SWAP_ID));
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe("contractA");
    expect((error as FlowRecordMismatchError).expected).toBe(SAMPLE_SWAP_ID);
    expect((error as FlowRecordMismatchError).actual).toBe(SAMPLE_CONTRACT_A);
  });

  it("two Seller records with one swap id and different contract ids live in two separate slots", async () => {
    const store = new MemoryFlowStore();
    const one = sampleSellerRecord();
    const otherContract = `0x${"d4".repeat(32)}`;
    const other = sampleSellerRecord();
    const two = { ...other, contractA: otherContract, ledger: other.ledger.map((e) => (e.room === dealRoom(SAMPLE_CONTRACT_A) ? { ...e, room: dealRoom(otherContract) } : e)) };
    await saveFlowRecord(store, one, null);
    await saveFlowRecord(store, two, null); // no FlowRecordExistsError: the swap id is not the key
    expect(await store.list()).toEqual([`seller:${one.contractA}`, `seller:${two.contractA}`].sort());
    expect((await loadFlowRecord(store, "seller", one.contractA))?.swapId).toBe(two.swapId);
  });
});

describe("R1-05: the record pins the rail's deployment", () => {
  it("railDeploymentId is the rail's own deploymentId once it has one, else a value derived from its rail id", () => {
    expect(railDeploymentId({ railId: "evm-htlc" })).toBe("rail:evm-htlc");
    expect(railDeploymentId({ railId: "evm-htlc", deploymentId: "evm:0xaa:0xbb" })).toBe("evm:0xaa:0xbb");
  });

  it("a record created for one deployment refuses another on resume: FlowRecordMismatchError naming deploymentId", () => {
    const record = sampleBuyerRecord();
    const base = { role: "buyer" as const, swapId: SAMPLE_SWAP_ID, did: SAMPLE_BUYER.did, railId: "btc-htlc", caip2: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328" };
    expect(() => checkRecordIdentity(record, { ...base, deploymentId: record.deploymentId })).not.toThrow();
    const error = (() => {
      try {
        checkRecordIdentity(record, { ...base, deploymentId: "evm:0xother:0xtoken" });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(FlowRecordMismatchError);
    expect((error as FlowRecordMismatchError).field).toBe("deploymentId");
    expect((error as FlowRecordMismatchError).actual).toBe(record.deploymentId);
  });

  it("the field is part of the stored bytes and cannot be dropped: a record without it neither encodes nor decodes", () => {
    const record = sampleSellerRecord();
    expect(text(encodeFlowRecord(record))).toContain(`"deploymentId":"${record.deploymentId}"`);
    const without = { ...record } as Partial<FlowRecord>;
    delete without.deploymentId;
    expect(() => encodeFlowRecord(without as FlowRecord)).toThrow(FlowRecordInvalidError);
    expect(() => decodeFlowRecord(envelope(without))).toThrow(FlowStoreCorruptError);
  });
});

describe("R1-18: a Buyer never holds the secret, not even in a ledger entry", () => {
  const revealText = `tclk1 {"type":"reveal","from":"${SAMPLE_BUYER.did}","contract":"${SAMPLE_CONTRACT_B}","ref":"${SAMPLE_CONTRACT_B}","secret":"${SAMPLE_PREIMAGE}"}`;
  const withReveal = (entryText: string): FlowRecord => {
    const record = sampleBuyerRecord();
    return { ...record, ledger: record.ledger.map((entry) => (entry.kind === "reveal-b" ? { ...entry, text: entryText } : entry)) };
  };

  it("a Buyer reveal-b entry that holds the full reveal text (the preimage) is refused when encoded and when decoded", () => {
    const full = withReveal(revealText);
    expect(() => encodeFlowRecord(full)).toThrow(FlowRecordInvalidError);
    expect(() => encodeFlowRecord(full)).toThrow(/reveal-b/);
    // and a file that somehow holds one is refused on load as well (defence in depth: the writer is one flag at one call site)
    expect(() => decodeFlowRecord(envelope(plain(full)), recordKey(full))).toThrow(FlowStoreCorruptError);
    expect(() => decodeFlowRecord(envelope(plain(full)), recordKey(full))).toThrow(/reveal-b/);
  });

  it("the digest form is accepted, and a Seller's own reveal-a keeps its full text (it is the Seller's record)", () => {
    const digest = withReveal(`sha256:${"ab".repeat(32)}`);
    expect(decodeFlowRecord(encodeFlowRecord(digest), recordKey(digest))).toEqual(digest);
    const seller = sampleSellerRecord();
    const sellerReveal = { ...seller, ledger: seller.ledger.map((entry) => (entry.kind === "reveal-a" ? { ...entry, text: revealText } : entry)) };
    expect(text(encodeFlowRecord(sellerReveal))).toContain(SAMPLE_PREIMAGE.slice(2));
  });
});

describe("R1-12 (record part): a landed mark can carry the signed record", () => {
  const roomA = dealRoom(SAMPLE_CONTRACT_A);
  const recordFor = (line: string) => ({ room: roomA, seq: 5, timestampMs: 1_700_000_000_500, sender: SAMPLE_BUYER.did, nonce: "10005", signature: "sig-5", line });

  it("round-trips, and is the signed record of this party's own line", () => {
    const base = sampleBuyerRecord();
    const entry = { kind: "lock-a" as const, room: roomA, text: "tclk1 {\"lock\":1}" };
    const record: FlowRecord = {
      ...base,
      ledger: [...base.ledger.filter((e) => e.kind !== "lock-a"), { ...entry, landed: { seq: 5, nonce: "10005", record: recordFor(entry.text) } }],
    };
    expect(decodeFlowRecord(encodeFlowRecord(record), recordKey(record))).toEqual(record);
    expect(ledgerEntry(withLedgerLanded(withLedgerIntent(fresh(), entry), "lock-a", { seq: 5, nonce: "10005", record: recordFor(entry.text) }), "lock-a")?.landed?.record?.seq).toBe(5);
  });

  function fresh() {
    return { ...newBuyerRecord({ swapId: SAMPLE_SWAP_ID, did: SAMPLE_BUYER.did, railId: "evm-htlc", caip2: "eip155:31337", deploymentId: "evm:0xrail:0xtoken", nowMs: 1 }), contractA: SAMPLE_CONTRACT_A };
  }
});

describe("R1-02 (record part): saveFlowRecord and loadFlowRecordWithDigest are a compare-and-swap pair", () => {
  it("the digest a load returns is the one the next save must present; a stale one is FlowRecordStaleError", async () => {
    const store = new MemoryFlowStore();
    const first = sampleBuyerRecord();
    const digest = await saveFlowRecord(store, first, null);
    const loaded = await loadFlowRecordWithDigest(store, "buyer", SAMPLE_SWAP_ID);
    expect(loaded?.digest).toBe(digest);
    expect(loaded?.digest).toBe(flowDigest((await store.load(recordKey(first)))!));
    const next = await saveFlowRecord(store, bumped(first, first.updatedAtMs + 1), digest);
    expect(next).not.toBe(digest);
    await expect(saveFlowRecord(store, bumped(first, first.updatedAtMs + 2), digest)).rejects.toBeInstanceOf(FlowRecordStaleError);
  });
});
