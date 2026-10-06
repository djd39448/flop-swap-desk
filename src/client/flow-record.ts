// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Surface" (the record), rules 1, 3, 5 and 6: the versioned, validated JSON shape one Buyer or
// Seller flow persists through a `FlowStore` (src/client/flow-store.ts) so a fresh process can continue the swap.
//
// What lives here, and only this:
//   - the record types (`v: 1`, discriminated by `role`): the common part (identity, the four swap frames and their
//     signed venue records as they become known, the contracts, the deadlines, a FRAME LEDGER of everything this
//     party posts), the Seller part (the preimage, the leg B lock latch, the frozen leg A accounts, the Solana claim
//     records, the claim outcome, the reveal/receipt latches, the leg B refund state) and the Buyer part (leg B
//     pairing, its own account line, the lock state with the rail's recovery handle, the leg B claim latch, the leg A
//     refund state with its recovery handle, the refund notes);
//   - `encodeFlowRecord` / `decodeFlowRecord`: the bytes are UTF-8 JSON `{"v":1,"sum":"<sha256>","record":{...}}`
//     where `sum` is the sha256 of the record's canonical JSON. `decode` is STRICT: invalid JSON, a checksum that does
//     not match, an unknown version, an unknown field, a wrong type, a preimage on a Buyer record or a preimage that
//     does not open its statement are all typed errors, never an empty record (rule 6). A record the BUILDER side
//     refuses (`encodeFlowRecord`, and every `new*Record` / `with*` helper) is a different error,
//     `FlowRecordInvalidError`: `FlowStoreCorruptError` keeps one meaning, "the stored bytes failed their checksum or
//     schema on load" (review round 1, R1-09);
//   - pure helpers to build and update a record (`newBuyerRecord`, `newSellerRecord`, `withLedgerIntent`,
//     `withLedgerLanded`, `bumped`) and to check it against the runner's objects (`checkRecordIdentity`);
//   - the record's KEY (`recordKey`): `buyer:<swapId>` for a Buyer, `seller:<contractA>` for a Seller (R1-14: the swap id
//     is chosen by the Buyer and nobody can authenticate it, so a Seller record is keyed by leg A's contract id, which
//     binds the signed offer and the Seller's own accept and is computable before accept A is posted). `decode` checks
//     the key's id against the record it opened.
//
// The frame ledger is how "same bytes, once" (rule 3) works: a frame's exact text is written to the ledger BEFORE
// `venue.post` (`withLedgerIntent`), and the record's `seq` and `nonce` are added once it landed
// (`withLedgerLanded`). A second, DIFFERENT text for a kind that already has one is refused outright: a party never
// posts a second, different account line (nor any other frame).
//
// The preimage (Seller record only) is the swap's one secret. It is written to exactly one place, this record, and
// `redactFlowRecord` is the only form of a record fit for a log or an error message.

import { createHash } from "node:crypto";
import { OFFER_ROOM, dealRoom, verifyHashPreimage } from "@flop-labs/tclk";

import type { LockRecovery, RailBlockMarker, RailClaimRecord, RailWriteEvidence } from "./counter-rail.js";
import { FlowStoreCorruptError, flowDigest, flowKey, parseFlowKey, type FlowRole, type FlowStore } from "./flow-store.js";

export const FLOW_RECORD_VERSION = 1 as const;

/** The most bytes a record may have; a real one is a few kilobytes. */
export const MAX_FLOW_RECORD_BYTES = 1_048_576;

// --- errors ---------------------------------------------------------------------------------------------------------

/** Base of the errors this module adds to `FlowStoreCorruptError` (bad bytes or bad shape). */
export class FlowRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowRecordError";
  }
}

/** The record (or its envelope) carries a version this build does not know. Refused, never read as empty. */
export class FlowRecordVersionError extends FlowRecordError {
  readonly key: string;
  readonly version: unknown;
  constructor(key: string, version: unknown) {
    super(`flow record: "${key}" has version ${JSON.stringify(version)}, this build reads version ${FLOW_RECORD_VERSION} only`);
    this.name = "FlowRecordVersionError";
    this.key = key;
    this.version = version;
  }
}

/** A well-formed record that does not belong to what the runner supplied (another DID, rail, chain, contract, role or
 *  swap). `resume` stops: continuing would act for the wrong party or on the wrong chain. */
export class FlowRecordMismatchError extends FlowRecordError {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
  constructor(field: string, expected: string, actual: string) {
    super(`flow record: the stored record's ${field} is ${actual}, the runner supplied ${expected}`);
    this.name = "FlowRecordMismatchError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/** A record this build refuses to WRITE: it would not read back (a field of the wrong shape, a list over its cap, a
 *  reveal-b entry that holds more than a digest, ...). Nothing was saved. Distinct from `FlowStoreCorruptError`, which
 *  means "the stored bytes failed their checksum or schema on load" (R1-09): a healthy store is never called corrupt
 *  because the flow tried to save something invalid. */
export class FlowRecordInvalidError extends FlowRecordError {
  readonly key: string;
  readonly reason: string;
  constructor(key: string, reason: string) {
    super(`flow record: "${key}" is not a record this build may save: ${reason}`);
    this.name = "FlowRecordInvalidError";
    this.key = key;
    this.reason = reason;
  }
}

/** A caller tried to record something a record must never hold (a second, different text for a posted frame, ...). */
export class FlowRecordConflictError extends FlowRecordError {
  constructor(message: string) {
    super(message);
    this.name = "FlowRecordConflictError";
  }
}

// --- types ----------------------------------------------------------------------------------------------------------

/** One signed venue record, as `venue.post` / `venue.read` return it (a `TranscriptRecord`). */
export interface TranscriptRecordJson {
  room: string;
  seq: number;
  timestampMs: number;
  sender: string;
  nonce: string | null;
  signature: string | null;
  line: string;
}

/** The exact text of one of the swap's four frames, and its signed venue record once known (`record.line === text`). */
export interface FrameSlot {
  text: string;
  record?: TranscriptRecordJson;
}

export interface SwapFrames {
  offerA?: FrameSlot;
  acceptA?: FrameSlot;
  offerB?: FrameSlot;
  acceptB?: FrameSlot;
}

/** Everything a party posts, by what it is. Offers and accepts go to the offers room, the rest to a deal room. */
export type LedgerKind =
  | "offer-a" // Buyer: the leg A offer
  | "accept-a" // Seller: accept A
  | "offer-b" // Seller: the leg B offer
  | "accept-b" // Buyer: accept B
  | "account-a" // either party: its own proven account (or pubkey) line in leg A's deal room
  | "lock-a" // Buyer: leg A's lock frame
  | "lock-b" // Seller: leg B's lock frame
  | "reveal-a" // Seller: reveal after claiming leg A
  | "receipt-a" // Seller: receipt after claiming leg A
  | "reveal-b" // Buyer: reveal after claiming leg B
  | "receipt-b" // Buyer: receipt after claiming leg B
  | "refund-a" // Buyer: refund frame for leg A
  | "receipt-refund-a" // Buyer: receipt after the leg A refund
  | "refund-b" // Seller: refund frame for leg B
  | "receipt-refund-b"; // Seller: receipt after the leg B refund

const OFFER_ROOM_KINDS: ReadonlySet<LedgerKind> = new Set(["offer-a", "accept-a", "offer-b", "accept-b"]);
const BUYER_KINDS: ReadonlySet<LedgerKind> = new Set(["offer-a", "accept-b", "account-a", "lock-a", "reveal-b", "receipt-b", "refund-a", "receipt-refund-a"]);
const SELLER_KINDS: ReadonlySet<LedgerKind> = new Set(["accept-a", "offer-b", "account-a", "lock-b", "reveal-a", "receipt-a", "refund-b", "receipt-refund-b"]);
/** Which swap contract a deal-room kind belongs to: leg A's, or leg B's. */
const KIND_CONTRACT: Readonly<Record<string, "contractA" | "contractB">> = {
  "account-a": "contractA",
  "lock-a": "contractA",
  "reveal-a": "contractA",
  "receipt-a": "contractA",
  "refund-a": "contractA",
  "receipt-refund-a": "contractA",
  "lock-b": "contractB",
  "reveal-b": "contractB",
  "receipt-b": "contractB",
  "refund-b": "contractB",
  "receipt-refund-b": "contractB",
};
const ALL_KINDS: ReadonlySet<string> = new Set([...BUYER_KINDS, ...SELLER_KINDS]);

/** One frame or line this party posts: where, the exact text, and once it landed the venue's `seq` and `nonce`. */
export interface LedgerEntry {
  kind: LedgerKind;
  room: string;
  text: string;
  /** `record` is the whole signed venue record, kept (R1-12) so a step that is already confirmed can hand back what the
   *  venue holds without reading the room again. Absent for a kind whose frame slot holds the record, and ALWAYS absent
   *  for a Buyer's `reveal-b` (its text is held as a digest only: the record's line would carry the secret). */
  landed?: { seq: number; nonce: string | null; record?: TranscriptRecordJson };
}

/** `RailAccounts`, as plain data. */
export interface RailAccountsJson {
  payer?: string;
  payee?: string;
  payerKey?: string;
  payeeKey?: string;
}

/** A `RailBlockMarker` as plain data: an EVM block number is a bigint, the other rails use a number. */
export interface BlockMarkerJson {
  kind: "bigint" | "number";
  /** Decimal digits. */
  value: string;
}

/** A `RailWriteEvidence` as plain data (`blockNumber` as decimal digits). */
export interface WriteEvidenceJson {
  ref: string;
  raw: string[];
  event?: "Locked" | "Claimed" | "Refunded";
  txHash?: string;
  blockNumber?: string;
  blockHash?: string | null;
  logIndex?: number;
  txid?: string;
  blockHeight?: number | null;
  rawTx?: string;
  claimedByAnotherTransaction?: true;
}

export interface LegBDeadlinesJson {
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
}

export interface FlowRecordBase {
  v: typeof FLOW_RECORD_VERSION;
  role: FlowRole;
  /** `0x` + 64 hex: the swap this record belongs to. */
  swapId: string;
  /** This party's DID. */
  did: string;
  /** The leg A rail's id and chain (CAIP-2), pinned against the runner's rail on resume. */
  railId: string;
  caip2: string;
  /** The rail's deployment identity (R1-05): which contract, token, program or network the lock was sent to. Pinned
   *  against the runner's rail on resume: a record written for one deployment never continues against another. */
  deploymentId: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** 1 on creation, +1 on every save: a stale or replayed record is recognisable. */
  revision: number;
  frames: SwapFrames;
  /** Leg A's and leg B's tclk contract ids (`0x` + 64 hex), as they become known. */
  contractA?: string;
  contractB?: string;
  /** The runner's estimate of when leg A locks (the `lockTimeMs` argument of `acceptLegA` / `acceptLegB`). */
  lockTimeMs?: number;
  legB?: LegBDeadlinesJson;
  /** Everything this party posts or is about to post, oldest first, at most one entry per kind. */
  ledger: LedgerEntry[];
}

export interface SellerFlowState {
  /** Leg A's tclk contract id (`0x` + 64 hex): the record's key (`seller:<contractA>`), set from the record's birth. */
  contractA: string;
  /** The swap's one secret: `0x` + 64 hex, sha256 of which is `statement`. Never logged, never in a frame before the reveal. */
  preimage: string;
  statement: string;
  /** The E2 latch: the contract id of the accept `paperRail.lock` was (or is about to be) called for. Set BEFORE the note write. */
  attemptedAcceptB?: string;
  /** Set once the leg B lock is confirmed on the note (equals `attemptedAcceptB`). */
  lockedLegBContract?: string;
  frozenLegAAccounts?: RailAccountsJson;
  frozenLegARailRef?: string;
  /** This party's own proven account (or pubkey) line: the address, and the exact text posted (the Buyer's twin). */
  ownAccountLine?: { address: string; text: string };
  /** True from just before the first leg A claim is sent, on any rail. */
  claimAttempted: boolean;
  /** R1-13: where the chain was when `claimAttempted` was saved (EVM and Bitcoin only, the rails whose `findClaimedPreimage` scans blocks): a
   *  claim lands after it, so a resumed `claimLegA` looks for its own claim from here instead of from genesis. Saved in the same save as
   *  `claimAttempted`, before the first send. */
  claimFromBlock?: BlockMarkerJson;
  /** Solana: every claim signature signed and not yet resolved (recorded before simulate/send). */
  claimRecords: RailClaimRecord[];
  publicClaimSignature?: string;
  neverLandedClaims: number;
  claimOutcome: "none" | "landed" | "failed-public";
  revealPosted: boolean;
  receiptPosted: boolean;
  legBRefund: { attempted: boolean; done: boolean; framesPosted: boolean };
}

export interface BuyerFlowState {
  legBVerified: boolean;
  /** This party's own proven account (or pubkey) line: the address, and the exact text posted. */
  ownAccountLine?: { address: string; text: string };
  lock: {
    /** The G2 latch: set BEFORE `commitLock`; outcome unknown until the chain says. */
    attempted: boolean;
    /** What `prepareLock` returned: the ref and the rail's recovery handle (persist BEFORE `commitLock`). */
    prepared?: { ref: string; recovery?: LockRecovery };
    fromBlock?: BlockMarkerJson;
    accounts?: RailAccountsJson;
    hashLock?: string;
    evidence?: WriteEvidenceJson;
    framePosted: boolean;
  };
  /** Set BEFORE the paper-note claim of leg B is written; cleared again only when leg B's note proves the attempt did not land
   *  (the note is refunded or missing, or leg B's refund time has come: R1-07). */
  legBClaimAttempted: boolean;
  /** True only when THIS flow's own paper claim of leg B returned (R1-06). Once true, the Buyer never refunds leg A. */
  legBClaimed: boolean;
  /** R1-06: leg B's paper note already read claimed with this swap's secret when the flow looked at it, and this flow's own claim did
   *  not return. Paper notes are not bound to who wrote them, so such a claim is ADOPTED (the frames are posted) but never bars the
   *  refund of leg A. Mutually exclusive with `legBClaimed`; needs `legBClaimAttempted`. */
  legBClaimAdopted?: true;
  refund: {
    attempted: boolean;
    /** The refund's signature / txid / bytes, recorded before it is sent where the rail can give one. */
    recovery?: LockRecovery;
    evidence?: WriteEvidenceJson;
    framesPosted: boolean;
    /** R1-15: set once `refundLegA` found leg A claimed (the refund lost the race to a claim) and routed the Buyer to
     *  `learnSecret`: from then on `next` says `learnSecret`, not `refundLegA` for ever. Also set (R1-06) when `claimLegB`, adopting
     *  a leg B note that was already claimed, read leg A Claimed: the one fact "leg A was seen claimed". */
    claimSeen?: true;
  };
  refundNotes: string[];
}

export type SellerFlowRecord = FlowRecordBase & { role: "seller" } & SellerFlowState;
export type BuyerFlowRecord = FlowRecordBase & { role: "buyer" } & BuyerFlowState;
export type FlowRecord = SellerFlowRecord | BuyerFlowRecord;

// --- conversions for the values that are not plain JSON ----------------------------------------------------------------

/** A `RailBlockMarker` (bigint for EVM, number for the others) as data. Anything else cannot be resumed from. */
export function markerToJson(marker: RailBlockMarker): BlockMarkerJson {
  if (typeof marker === "bigint" && marker >= 0n) return { kind: "bigint", value: marker.toString() };
  if (typeof marker === "number" && Number.isSafeInteger(marker) && marker >= 0) return { kind: "number", value: String(marker) };
  throw new FlowRecordError("flow record: a block marker must be a non-negative bigint or safe integer to be persisted");
}

export function markerFromJson(json: BlockMarkerJson): RailBlockMarker {
  return json.kind === "bigint" ? BigInt(json.value) : Number(json.value);
}

export function evidenceToJson(evidence: RailWriteEvidence): WriteEvidenceJson {
  return {
    ref: evidence.ref,
    raw: [...evidence.raw],
    ...(evidence.event === undefined ? {} : { event: evidence.event }),
    ...(evidence.txHash === undefined ? {} : { txHash: evidence.txHash }),
    ...(evidence.blockNumber === undefined ? {} : { blockNumber: evidence.blockNumber.toString() }),
    ...(evidence.blockHash === undefined ? {} : { blockHash: evidence.blockHash }),
    ...(evidence.logIndex === undefined ? {} : { logIndex: evidence.logIndex }),
    ...(evidence.txid === undefined ? {} : { txid: evidence.txid }),
    ...(evidence.blockHeight === undefined ? {} : { blockHeight: evidence.blockHeight }),
    ...(evidence.rawTx === undefined ? {} : { rawTx: evidence.rawTx }),
    ...(evidence.claimedByAnotherTransaction === undefined ? {} : { claimedByAnotherTransaction: true as const }),
  };
}

export function evidenceFromJson(json: WriteEvidenceJson): RailWriteEvidence {
  return {
    ref: json.ref,
    raw: [...json.raw],
    ...(json.event === undefined ? {} : { event: json.event }),
    ...(json.txHash === undefined ? {} : { txHash: json.txHash }),
    ...(json.blockNumber === undefined ? {} : { blockNumber: BigInt(json.blockNumber) }),
    ...(json.blockHash === undefined ? {} : { blockHash: json.blockHash }),
    ...(json.logIndex === undefined ? {} : { logIndex: json.logIndex }),
    ...(json.txid === undefined ? {} : { txid: json.txid }),
    ...(json.blockHeight === undefined ? {} : { blockHeight: json.blockHeight }),
    ...(json.rawTx === undefined ? {} : { rawTx: json.rawTx }),
    ...(json.claimedByAnotherTransaction === undefined ? {} : { claimedByAnotherTransaction: true as const }),
  };
}

// --- construction and pure updates ------------------------------------------------------------------------------------

export interface NewRecordInit {
  swapId: string;
  did: string;
  railId: string;
  caip2: string;
  /** The rail's deployment identity: see `railDeploymentId`. */
  deploymentId: string;
  nowMs: number;
}

/** The deployment identity a record pins for `rail`: the rail's own `deploymentId` once its adapter exposes one (R1-05),
 *  else a value derived from its rail id (which `railId` already pins, so nothing weaker than before is recorded). */
export function railDeploymentId(rail: { railId: string; deploymentId?: string }): string {
  return rail.deploymentId ?? `rail:${rail.railId}`;
}

function base(role: FlowRole, init: NewRecordInit): FlowRecordBase {
  return {
    v: FLOW_RECORD_VERSION,
    role,
    swapId: init.swapId,
    did: init.did,
    railId: init.railId,
    caip2: init.caip2,
    deploymentId: init.deploymentId,
    createdAtMs: init.nowMs,
    updatedAtMs: init.nowMs,
    revision: 1,
    frames: {},
    ledger: [],
  };
}

export function newBuyerRecord(init: NewRecordInit): BuyerFlowRecord {
  const record: BuyerFlowRecord = {
    ...base("buyer", init),
    role: "buyer",
    legBVerified: false,
    lock: { attempted: false, framePosted: false },
    legBClaimAttempted: false,
    legBClaimed: false,
    refund: { attempted: false, framesPosted: false },
    refundNotes: [],
  };
  return checked(record);
}

export function newSellerRecord(init: NewRecordInit & { contractA: string; preimage: string; statement: string }): SellerFlowRecord {
  const record: SellerFlowRecord = {
    ...base("seller", init),
    role: "seller",
    contractA: init.contractA,
    preimage: init.preimage,
    statement: init.statement,
    claimAttempted: false,
    claimRecords: [],
    neverLandedClaims: 0,
    claimOutcome: "none",
    revealPosted: false,
    receiptPosted: false,
    legBRefund: { attempted: false, done: false, framesPosted: false },
  };
  return checked(record);
}

/** A deep copy of a record: plain data, so a JSON round trip is exact. */
export function cloneFlowRecord<T extends FlowRecord>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

/** A copy of `record` with `revision` + 1 and `updatedAtMs` = `nowMs` (never earlier than before). The one thing to
 *  do to a record right before it is saved. */
export function bumped<T extends FlowRecord>(record: T, nowMs: number): T {
  const copy = cloneFlowRecord(record);
  copy.revision = record.revision + 1;
  copy.updatedAtMs = Math.max(record.updatedAtMs, nowMs);
  return copy;
}

export function ledgerEntry(record: FlowRecord, kind: LedgerKind): LedgerEntry | undefined {
  return record.ledger.find((entry) => entry.kind === kind);
}

/** The key a record is stored under: `buyer:<swapId>` for a Buyer, `seller:<contractA>` for a Seller (R1-14). */
export function recordKey(record: FlowRecord): string {
  return record.role === "seller" ? flowKey("seller", record.contractA) : flowKey("buyer", record.swapId);
}

/**
 * Writes the INTENT to post `text` into `room` as `kind`, a copy of the record to persist BEFORE `venue.post`
 * (rule 1). The same kind with the same room and text is a no-op (resume re-announces the identical bytes, rule 3);
 * the same kind with a different room or text throws `FlowRecordConflictError`: a party never posts a second,
 * different frame or account line.
 */
export function withLedgerIntent<T extends FlowRecord>(record: T, entry: { kind: LedgerKind; room: string; text: string }): T {
  const existing = ledgerEntry(record, entry.kind);
  if (existing !== undefined) {
    if (existing.room !== entry.room || existing.text !== entry.text) {
      throw new FlowRecordConflictError(`flow record: "${entry.kind}" was already recorded with different text or room; a party never posts a second, different frame`);
    }
    return record;
  }
  const copy = cloneFlowRecord(record);
  copy.ledger.push({ kind: entry.kind, room: entry.room, text: entry.text });
  return checked(copy);
}

/** A copy with the venue's `seq` and `nonce` (and, where the caller keeps it, the signed record) added to the ledger
 *  entry of `kind` (idempotent for the same values; a different seq or nonce for a landed entry is a conflict). */
export function withLedgerLanded<T extends FlowRecord>(record: T, kind: LedgerKind, landed: { seq: number; nonce: string | null; record?: TranscriptRecordJson }): T {
  const existing = ledgerEntry(record, kind);
  if (existing === undefined) throw new FlowRecordConflictError(`flow record: "${kind}" has no ledger entry to mark as landed`);
  if (existing.landed !== undefined) {
    if (existing.landed.seq !== landed.seq || existing.landed.nonce !== landed.nonce) {
      throw new FlowRecordConflictError(`flow record: "${kind}" already landed at seq ${existing.landed.seq}, not ${landed.seq}`);
    }
    return record;
  }
  const copy = cloneFlowRecord(record);
  const entry = ledgerEntry(copy, kind);
  if (entry === undefined) throw new FlowRecordConflictError("flow record: ledger entry vanished on copy"); // unreachable
  entry.landed = { seq: landed.seq, nonce: landed.nonce, ...(landed.record === undefined ? {} : { record: landed.record }) };
  return checked(copy);
}

/** A record that is safe to put in a log or an error message: the preimage is replaced. */
export function redactFlowRecord(record: FlowRecord): Record<string, unknown> {
  const copy = cloneFlowRecord(record) as unknown as Record<string, unknown> & { ledger: LedgerEntry[] };
  if ("preimage" in copy && typeof copy.preimage === "string") {
    const secretHex = copy.preimage.replace(/^0x/, "");
    // The Seller's reveal frame carries the preimage in its text (and in the signed record kept beside it): that entry
    // is masked too.
    for (const entry of copy.ledger) {
      if (secretHex !== "" && entry.text.includes(secretHex)) entry.text = "[redacted]";
      if (secretHex !== "" && entry.landed?.record !== undefined && entry.landed.record.line.includes(secretHex)) entry.landed.record.line = "[redacted]";
    }
    copy.preimage = "[redacted]";
  }
  return copy;
}

/** Throws `FlowRecordMismatchError` unless the record belongs to what the runner supplied. Every field is compared
 *  only when BOTH sides know it (`swapId` is optional because a Seller resumes by `contractA`, with the swap id as a
 *  cross-check only; a Buyer record has no `contractA` / `contractB` yet before its accept). `deploymentId` (R1-05) is
 *  the rail's deployment identity: a record never continues against another contract, program or network. */
export function checkRecordIdentity(
  record: FlowRecord,
  expected: { role: FlowRole; swapId?: string; did: string; railId: string; caip2: string; deploymentId?: string; contractA?: string; contractB?: string },
): void {
  const compare = (field: string, want: string | undefined, have: string | undefined): void => {
    if (want !== undefined && have !== undefined && want !== have) throw new FlowRecordMismatchError(field, want, have);
  };
  compare("role", expected.role, record.role);
  compare("swapId", expected.swapId, record.swapId);
  compare("did", expected.did, record.did);
  compare("railId", expected.railId, record.railId);
  compare("caip2", expected.caip2, record.caip2);
  compare("deploymentId", expected.deploymentId, record.deploymentId);
  compare("contractA", expected.contractA, record.contractA);
  compare("contractB", expected.contractB, record.contractB);
}

// --- encode / decode ---------------------------------------------------------------------------------------------------

/** JSON with every object's keys sorted, so the same data always has the same bytes (and the same checksum). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const item = object[key];
    if (item === undefined) continue; // JSON.stringify drops undefined properties too
    parts.push(`${JSON.stringify(key)}:${canonical(item)}`);
  }
  return `{${parts.join(",")}}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Validates (a record that would not read back is refused here, not discovered at resume) and serialises. A record
 *  that fails validation is `FlowRecordInvalidError` naming the offending path, never `FlowStoreCorruptError` (R1-09). */
export function encodeFlowRecord(record: FlowRecord): Uint8Array {
  const key = describeKey(record);
  const plain = JSON.parse(JSON.stringify(record)) as unknown;
  parseRecord(plain, key, true); // throws FlowRecordInvalidError with the offending path
  const body = canonical(plain);
  const text = `{"v":${FLOW_RECORD_VERSION},"sum":"${sha256Hex(body)}","record":${body}}`;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_FLOW_RECORD_BYTES) throw new FlowRecordInvalidError(key, `the record is ${bytes.length} bytes, over the ${MAX_FLOW_RECORD_BYTES}-byte cap`);
  return bytes;
}

/** A label for a record in an error message: its key when it has one, else what it can be called. */
function describeKey(record: FlowRecord): string {
  try {
    return recordKey(record);
  } catch {
    return `${String((record as { role?: unknown }).role)}:${String((record as { swapId?: unknown }).swapId)}`;
  }
}

/** The record the bytes hold, or a typed error: `FlowStoreCorruptError` (not JSON, checksum mismatch, wrong shape,
 *  an unknown field), `FlowRecordVersionError` (a version this build does not know) or `FlowRecordMismatchError`
 *  (the stored role is not the one `key` names, or the key's id is not the record's: the swap id for a Buyer record,
 *  leg A's contract id for a Seller record). Never an empty record. */
export function decodeFlowRecord(bytes: Uint8Array, key = "<record>"): FlowRecord {
  if (bytes.length > MAX_FLOW_RECORD_BYTES) throw new FlowStoreCorruptError(key, `record is ${bytes.length} bytes, over the ${MAX_FLOW_RECORD_BYTES}-byte cap`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FlowStoreCorruptError(key, "record is not valid UTF-8");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new FlowStoreCorruptError(key, "record is not valid JSON");
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) throw new FlowStoreCorruptError(key, "record envelope is not an object");
  const outer = envelope as Record<string, unknown>;
  if (outer.v !== FLOW_RECORD_VERSION) throw new FlowRecordVersionError(key, outer.v);
  const extra = Object.keys(outer).filter((name) => name !== "v" && name !== "sum" && name !== "record");
  if (extra.length > 0 || typeof outer.sum !== "string" || !("record" in outer)) {
    throw new FlowStoreCorruptError(key, 'record envelope must be exactly {"v","sum","record"}');
  }
  if (sha256Hex(canonical(outer.record)) !== outer.sum) throw new FlowStoreCorruptError(key, "record checksum does not match its body");
  const inner = outer.record;
  if (inner !== null && typeof inner === "object" && !Array.isArray(inner) && (inner as Record<string, unknown>).v !== FLOW_RECORD_VERSION) {
    throw new FlowRecordVersionError(key, (inner as Record<string, unknown>).v);
  }
  const record = parseRecord(inner, key, false);
  if (key !== "<record>") {
    const named = parseFlowKey(key);
    if (named.role !== record.role) throw new FlowRecordMismatchError("role", named.role, record.role);
    if (record.role === "seller") {
      if (named.swapId !== record.contractA) throw new FlowRecordMismatchError("contractA", named.swapId, record.contractA);
    } else if (named.swapId !== record.swapId) {
      throw new FlowRecordMismatchError("swapId", named.swapId, record.swapId);
    }
  }
  return record;
}

/** A stored record together with the digest `FlowStore.save` wants as `expected` for the next save of it. */
export interface LoadedFlowRecord {
  record: FlowRecord;
  /** sha256 hex of the stored bytes the record was decoded from. */
  digest: string;
}

/** The record stored for (`role`, `id`) and the digest of its bytes, or `null` when none was ever saved. `id` is the swap
 *  id for a Buyer and leg A's contract id for a Seller (R1-14). A damaged one throws (see `decodeFlowRecord`). */
export async function loadFlowRecordWithDigest(store: FlowStore, role: FlowRole, id: string): Promise<LoadedFlowRecord | null> {
  const key = flowKey(role, id);
  const bytes = await store.load(key);
  return bytes === null ? null : { record: decodeFlowRecord(bytes, key), digest: flowDigest(bytes) };
}

/** The record stored for (`role`, `id`), or `null` when none was ever saved. A damaged one throws (see `decode`). */
export async function loadFlowRecord(store: FlowStore, role: FlowRole, id: string): Promise<FlowRecord | null> {
  return (await loadFlowRecordWithDigest(store, role, id))?.record ?? null;
}

/** Encodes `record` (validating it) and saves it under its own key, as a compare-and-swap: `expected` is the digest of
 *  the bytes the caller last loaded or wrote (`null` = create). Resolves only once the bytes are durable. Returns the
 *  digest of the bytes now stored, which is the `expected` of the next save. */
export async function saveFlowRecord(store: FlowStore, record: FlowRecord, expected: string | null): Promise<string> {
  const bytes = encodeFlowRecord(record);
  await store.save(recordKey(record), bytes, expected);
  return flowDigest(bytes);
}

// --- the strict reader --------------------------------------------------------------------------------------------------

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX_EVEN = /^([0-9a-f]{2})+$/;
const DID = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DIGITS = /^[0-9]+$/;
const MAX_TEXT = 8192;

/** Parse, don't validate: turns an untrusted JSON value into the typed record or throws `FlowStoreCorruptError` naming
 *  the first bad path. Every object is closed: an unknown key is an error. */
class Reader {
  /** `building`: the record is being WRITTEN (encode, or a helper that built it): a failure is `FlowRecordInvalidError`.
   *  Otherwise the bytes were READ from a store: a failure is `FlowStoreCorruptError` (R1-09). */
  constructor(
    private readonly key: string,
    private readonly building: boolean,
  ) {}

  fail(path: string, message: string): never {
    if (this.building) throw new FlowRecordInvalidError(this.key, `${path}: ${message}`);
    throw new FlowStoreCorruptError(this.key, `${path}: ${message}`);
  }

  object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) this.fail(path, "must be an object");
    const record = value as Record<string, unknown>;
    for (const name of required) if (!(name in record)) this.fail(`${path}.${name}`, "is required");
    const allowed = new Set([...required, ...optional]);
    for (const name of Object.keys(record)) if (!allowed.has(name)) this.fail(`${path}.${name}`, "is not a field of this record");
    return record;
  }

  string(value: unknown, path: string, options: { pattern?: RegExp; max?: number; allowEmpty?: boolean } = {}): string {
    if (typeof value !== "string") this.fail(path, "must be a string");
    if (value.length === 0 && options.allowEmpty !== true) this.fail(path, "must not be empty");
    if (value.length > (options.max ?? MAX_TEXT)) this.fail(path, "is too long");
    if (options.pattern !== undefined && !options.pattern.test(value)) this.fail(path, "has the wrong shape");
    return value;
  }

  line(value: unknown, path: string): string {
    const text = this.string(value, path);
    if (/[\r\n]/.test(text)) this.fail(path, "must be a single line");
    return text;
  }

  int(value: unknown, path: string, min = 0): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) this.fail(path, `must be a safe integer >= ${min}`);
    return value;
  }

  bool(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") this.fail(path, "must be a boolean");
    return value;
  }

  array(value: unknown, path: string, max = 1024): unknown[] {
    if (!Array.isArray(value)) this.fail(path, "must be an array");
    if (value.length > max) this.fail(path, "has too many entries");
    return value;
  }

  nullableString(value: unknown, path: string): string | null {
    return value === null ? null : this.string(value, path, { allowEmpty: true });
  }

  optional<T>(source: Record<string, unknown>, name: string, parse: (value: unknown, path: string) => T, path: string): T | undefined {
    return name in source ? parse(source[name], `${path}.${name}`) : undefined;
  }

  transcriptRecord(value: unknown, path: string): TranscriptRecordJson {
    const o = this.object(value, path, ["room", "seq", "timestampMs", "sender", "nonce", "signature", "line"]);
    return {
      room: this.string(o.room, `${path}.room`),
      seq: this.int(o.seq, `${path}.seq`, 1),
      timestampMs: this.int(o.timestampMs, `${path}.timestampMs`),
      sender: this.string(o.sender, `${path}.sender`),
      nonce: this.nullableString(o.nonce, `${path}.nonce`),
      signature: this.nullableString(o.signature, `${path}.signature`),
      line: this.line(o.line, `${path}.line`),
    };
  }

  frameSlot(value: unknown, path: string): FrameSlot {
    const o = this.object(value, path, ["text"], ["record"]);
    const text = this.line(o.text, `${path}.text`);
    if (!text.startsWith("tclk1 ")) this.fail(`${path}.text`, "is not a tclk/1 frame line");
    const record = this.optional(o, "record", (v, p) => this.transcriptRecord(v, p), path);
    if (record !== undefined && record.line !== text) this.fail(`${path}.record.line`, "is not the slot's own text");
    return { text, ...(record === undefined ? {} : { record }) };
  }

  accounts(value: unknown, path: string): RailAccountsJson {
    const o = this.object(value, path, [], ["payer", "payee", "payerKey", "payeeKey"]);
    const out: RailAccountsJson = {};
    for (const name of ["payer", "payee", "payerKey", "payeeKey"] as const) {
      if (name in o) out[name] = this.string(o[name], `${path}.${name}`);
    }
    return out;
  }

  marker(value: unknown, path: string): BlockMarkerJson {
    const o = this.object(value, path, ["kind", "value"]);
    if (o.kind !== "bigint" && o.kind !== "number") this.fail(`${path}.kind`, 'must be "bigint" or "number"');
    const digits = this.string(o.value, `${path}.value`, { pattern: DIGITS, max: 80 });
    if (o.kind === "number" && !Number.isSafeInteger(Number(digits))) this.fail(`${path}.value`, "is not a safe integer");
    return { kind: o.kind, value: digits };
  }

  evidence(value: unknown, path: string): WriteEvidenceJson {
    const o = this.object(value, path, ["ref", "raw"], ["event", "txHash", "blockNumber", "blockHash", "logIndex", "txid", "blockHeight", "rawTx", "claimedByAnotherTransaction"]);
    const out: WriteEvidenceJson = {
      ref: this.string(o.ref, `${path}.ref`),
      raw: this.array(o.raw, `${path}.raw`).map((item, i) => this.string(item, `${path}.raw[${i}]`)),
    };
    if ("event" in o) {
      if (o.event !== "Locked" && o.event !== "Claimed" && o.event !== "Refunded") this.fail(`${path}.event`, "must be Locked, Claimed or Refunded");
      out.event = o.event;
    }
    if ("txHash" in o) out.txHash = this.string(o.txHash, `${path}.txHash`);
    if ("blockNumber" in o) out.blockNumber = this.string(o.blockNumber, `${path}.blockNumber`, { pattern: DIGITS, max: 80 });
    if ("blockHash" in o) out.blockHash = o.blockHash === null ? null : this.string(o.blockHash, `${path}.blockHash`);
    if ("logIndex" in o) out.logIndex = this.int(o.logIndex, `${path}.logIndex`);
    if ("txid" in o) out.txid = this.string(o.txid, `${path}.txid`);
    if ("blockHeight" in o) out.blockHeight = o.blockHeight === null ? null : this.int(o.blockHeight, `${path}.blockHeight`);
    if ("rawTx" in o) out.rawTx = this.string(o.rawTx, `${path}.rawTx`, { pattern: HEX_EVEN, max: MAX_FLOW_RECORD_BYTES });
    if ("claimedByAnotherTransaction" in o) {
      if (o.claimedByAnotherTransaction !== true) this.fail(`${path}.claimedByAnotherTransaction`, "must be true when present");
      out.claimedByAnotherTransaction = true;
    }
    return out;
  }

  recovery(value: unknown, path: string): LockRecovery {
    if (value === null || typeof value !== "object" || Array.isArray(value)) this.fail(path, "must be an object");
    const chain = (value as Record<string, unknown>).chain;
    if (chain === "btc") {
      const o = this.object(value, path, ["chain", "txid", "rawTx"]);
      return {
        chain: "btc",
        txid: this.string(o.txid, `${path}.txid`, { pattern: /^[0-9a-f]{64}$/ }),
        rawTx: this.string(o.rawTx, `${path}.rawTx`, { pattern: HEX_EVEN, max: MAX_FLOW_RECORD_BYTES }),
      };
    }
    if (chain === "near") {
      const o = this.object(value, path, ["chain", "txHash", "signedTxBase64"]);
      return {
        chain: "near",
        txHash: this.string(o.txHash, `${path}.txHash`, { max: 128 }),
        signedTxBase64: this.string(o.signedTxBase64, `${path}.signedTxBase64`, { pattern: BASE64, max: MAX_FLOW_RECORD_BYTES }),
      };
    }
    if (chain === "sol") {
      const o = this.object(value, path, ["chain", "signature", "blockhash", "lastValidBlockHeight"], ["signedSlot"]);
      const signedSlot = this.optional(o, "signedSlot", (v, p) => this.int(v, p), path);
      return {
        chain: "sol",
        signature: this.string(o.signature, `${path}.signature`, { max: 128 }),
        blockhash: this.string(o.blockhash, `${path}.blockhash`, { max: 128 }),
        lastValidBlockHeight: this.int(o.lastValidBlockHeight, `${path}.lastValidBlockHeight`),
        ...(signedSlot === undefined ? {} : { signedSlot }),
      };
    }
    return this.fail(`${path}.chain`, 'must be "btc", "near" or "sol"');
  }

  claimRecord(value: unknown, path: string): RailClaimRecord {
    const o = this.object(value, path, ["signature", "blockhash", "lastValidBlockHeight"], ["signedSlot"]);
    const signedSlot = this.optional(o, "signedSlot", (v, p) => this.int(v, p), path);
    return {
      signature: this.string(o.signature, `${path}.signature`, { max: 128 }),
      blockhash: this.string(o.blockhash, `${path}.blockhash`, { max: 128 }),
      lastValidBlockHeight: this.int(o.lastValidBlockHeight, `${path}.lastValidBlockHeight`),
      ...(signedSlot === undefined ? {} : { signedSlot }),
    };
  }
}

const COMMON_REQUIRED = ["v", "role", "swapId", "did", "railId", "caip2", "deploymentId", "createdAtMs", "updatedAtMs", "revision", "frames", "ledger"] as const;
const COMMON_OPTIONAL = ["contractB", "lockTimeMs", "legB"] as const;
// A Seller record is keyed by contract A (R1-14), so it has one from birth; a Buyer learns it with accept A.
const SELLER_REQUIRED = ["contractA", "preimage", "statement", "claimAttempted", "claimRecords", "neverLandedClaims", "claimOutcome", "revealPosted", "receiptPosted", "legBRefund"] as const;
const SELLER_OPTIONAL = ["attemptedAcceptB", "lockedLegBContract", "frozenLegAAccounts", "frozenLegARailRef", "ownAccountLine", "publicClaimSignature", "claimFromBlock"] as const;
const BUYER_REQUIRED = ["legBVerified", "lock", "legBClaimAttempted", "legBClaimed", "refund", "refundNotes"] as const;
const BUYER_OPTIONAL = ["contractA", "ownAccountLine", "legBClaimAdopted"] as const;

/** A Buyer's `reveal-b` entry holds only the digest of the reveal text (R1-18): the full text carries the secret. */
const DIGEST_TEXT = /^sha256:[0-9a-f]{64}$/;

function parseRecord(value: unknown, key: string, building: boolean): FlowRecord {
  const r: Reader = new Reader(key, building);
  const path = "record";
  if (value === null || typeof value !== "object" || Array.isArray(value)) r.fail(path, "must be an object");
  const role = (value as Record<string, unknown>).role;
  if (role !== "buyer" && role !== "seller") r.fail(`${path}.role`, 'must be "buyer" or "seller"');
  const o =
    role === "seller"
      ? r.object(value, path, [...COMMON_REQUIRED, ...SELLER_REQUIRED], [...COMMON_OPTIONAL, ...SELLER_OPTIONAL])
      : r.object(value, path, [...COMMON_REQUIRED, ...BUYER_REQUIRED], [...COMMON_OPTIONAL, ...BUYER_OPTIONAL]);

  if (o.v !== FLOW_RECORD_VERSION) throw new FlowRecordVersionError(key, o.v);
  const swapId = r.string(o.swapId, `${path}.swapId`, { pattern: HEX32 });
  const createdAtMs = r.int(o.createdAtMs, `${path}.createdAtMs`);
  const updatedAtMs = r.int(o.updatedAtMs, `${path}.updatedAtMs`);
  if (updatedAtMs < createdAtMs) r.fail(`${path}.updatedAtMs`, "is earlier than createdAtMs");

  const frames = r.object(o.frames, `${path}.frames`, [], ["offerA", "acceptA", "offerB", "acceptB"]);
  const swapFrames: SwapFrames = {};
  for (const slot of ["offerA", "acceptA", "offerB", "acceptB"] as const) {
    if (slot in frames) swapFrames[slot] = r.frameSlot(frames[slot], `${path}.frames.${slot}`);
  }

  const contractA = r.optional(o, "contractA", (v, p) => r.string(v, p, { pattern: HEX32 }), path);
  const contractB = r.optional(o, "contractB", (v, p) => r.string(v, p, { pattern: HEX32 }), path);
  const lockTimeMs = r.optional(o, "lockTimeMs", (v, p) => r.int(v, p), path);
  const legB = r.optional(
    o,
    "legB",
    (v, p) => {
      const l = r.object(v, p, ["claimByMs", "refundAfterMs", "expiresMs"]);
      return { claimByMs: r.int(l.claimByMs, `${p}.claimByMs`), refundAfterMs: r.int(l.refundAfterMs, `${p}.refundAfterMs`), expiresMs: r.int(l.expiresMs, `${p}.expiresMs`) };
    },
    path,
  );

  const did = r.string(o.did, `${path}.did`, { pattern: DID });
  const ledger = parseLedger(r, o.ledger, `${path}.ledger`, role, did, contractA, contractB);

  const common: FlowRecordBase = {
    v: FLOW_RECORD_VERSION,
    role,
    swapId,
    did,
    railId: r.string(o.railId, `${path}.railId`, { max: 128 }),
    caip2: r.string(o.caip2, `${path}.caip2`, { max: 128 }),
    deploymentId: r.string(o.deploymentId, `${path}.deploymentId`, { max: 512 }),
    createdAtMs,
    updatedAtMs,
    revision: r.int(o.revision, `${path}.revision`, 1),
    frames: swapFrames,
    ...(contractA === undefined ? {} : { contractA }),
    ...(contractB === undefined ? {} : { contractB }),
    ...(lockTimeMs === undefined ? {} : { lockTimeMs }),
    ...(legB === undefined ? {} : { legB }),
    ledger,
  };

  return role === "seller" ? parseSeller(r, o, path, common) : parseBuyer(r, o, path, common);
}

function parseLedger(r: Reader, value: unknown, path: string, role: FlowRole, did: string, contractA: string | undefined, contractB: string | undefined): LedgerEntry[] {
  const allowed = role === "buyer" ? BUYER_KINDS : SELLER_KINDS;
  const seen = new Set<string>();
  return r.array(value, path, 64).map((item, i) => {
    const p = `${path}[${i}]`;
    const o = r.object(item, p, ["kind", "room", "text"], ["landed"]);
    const kind = r.string(o.kind, `${p}.kind`, { max: 40 });
    if (!ALL_KINDS.has(kind)) r.fail(`${p}.kind`, "is not a ledger kind");
    if (!allowed.has(kind as LedgerKind)) r.fail(`${p}.kind`, `is not something a ${role} posts`);
    if (seen.has(kind)) r.fail(`${p}.kind`, "appears twice: a party records one text per kind");
    seen.add(kind);
    const room = r.string(o.room, `${p}.room`, { max: 128 });
    if (OFFER_ROOM_KINDS.has(kind as LedgerKind)) {
      if (room !== OFFER_ROOM) r.fail(`${p}.room`, `must be ${OFFER_ROOM}`);
    } else {
      const contract = KIND_CONTRACT[kind] === "contractA" ? contractA : contractB;
      if (contract !== undefined && room !== dealRoom(contract)) r.fail(`${p}.room`, "is not the deal room of this kind's contract");
    }
    const text = r.line(o.text, `${p}.text`);
    // R1-18: the Buyer never holds the secret. Its reveal-b entry is the digest of the text, whatever a caller passes.
    const digestOnly = role === "buyer" && kind === "reveal-b";
    if (digestOnly && !DIGEST_TEXT.test(text)) r.fail(`${p}.text`, "a Buyer's reveal-b entry may hold only the sha256 digest of the reveal text, never the text (it carries the secret)");
    const entry: LedgerEntry = { kind: kind as LedgerKind, room, text };
    if ("landed" in o) {
      const l = r.object(o.landed, `${p}.landed`, ["seq", "nonce"], ["record"]);
      const seq = r.int(l.seq, `${p}.landed.seq`, 1);
      const nonce = r.nullableString(l.nonce, `${p}.landed.nonce`);
      const record = r.optional(l, "record", (v, rp) => r.transcriptRecord(v, rp), `${p}.landed`);
      if (record !== undefined) {
        if (digestOnly) r.fail(`${p}.landed.record`, "must be absent for a reveal-b entry: its line carries the secret");
        if (record.room !== room || record.line !== text || record.seq !== seq || record.nonce !== nonce || record.sender !== did) {
          r.fail(`${p}.landed.record`, "is not this party's own record of the entry's text, room, seq and nonce");
        }
      }
      entry.landed = { seq, nonce, ...(record === undefined ? {} : { record }) };
    }
    return entry;
  });
}

function parseSeller(r: Reader, o: Record<string, unknown>, path: string, common: FlowRecordBase): SellerFlowRecord {
  const contractA = common.contractA;
  if (contractA === undefined) r.fail(`${path}.contractA`, "is required: a Seller record is keyed by leg A's contract id"); // unreachable: the field is required
  const preimage = r.string(o.preimage, `${path}.preimage`, { pattern: HEX32 });
  const statement = r.string(o.statement, `${path}.statement`, { pattern: HEX32 });
  if (!verifyHashPreimage(statement, preimage)) r.fail(`${path}.preimage`, "does not open the statement");
  const attemptedAcceptB = r.optional(o, "attemptedAcceptB", (v, p) => r.string(v, p, { pattern: HEX32 }), path);
  const lockedLegBContract = r.optional(o, "lockedLegBContract", (v, p) => r.string(v, p, { pattern: HEX32 }), path);
  if (lockedLegBContract !== undefined && lockedLegBContract !== attemptedAcceptB) {
    r.fail(`${path}.lockedLegBContract`, "must equal attemptedAcceptB: the leg B lock is only ever confirmed for the accept that was tried");
  }
  const claimRecords = r.array(o.claimRecords, `${path}.claimRecords`, 64).map((item, i) => r.claimRecord(item, `${path}.claimRecords[${i}]`));
  if (new Set(claimRecords.map((c) => c.signature)).size !== claimRecords.length) r.fail(`${path}.claimRecords`, "lists a signature twice");
  const publicClaimSignature = r.optional(o, "publicClaimSignature", (v, p) => r.string(v, p, { max: 128 }), path);
  const claimOutcome = o.claimOutcome;
  if (claimOutcome !== "none" && claimOutcome !== "landed" && claimOutcome !== "failed-public") r.fail(`${path}.claimOutcome`, 'must be "none", "landed" or "failed-public"');
  const claimAttempted = r.bool(o.claimAttempted, `${path}.claimAttempted`);
  if (claimOutcome !== "none" && !claimAttempted) r.fail(`${path}.claimOutcome`, "a claim outcome needs claimAttempted");
  const claimFromBlock = r.optional(o, "claimFromBlock", (v, p) => r.marker(v, p), path);
  if (claimFromBlock !== undefined && !claimAttempted) r.fail(`${path}.claimFromBlock`, "is saved with claimAttempted and needs it");
  if (claimOutcome === "failed-public" && publicClaimSignature === undefined) r.fail(`${path}.publicClaimSignature`, "is required for a failed-public claim: it is the proof the secret is public");
  const refundObject = r.object(o.legBRefund, `${path}.legBRefund`, ["attempted", "done", "framesPosted"]);
  const frozenLegAAccounts = r.optional(o, "frozenLegAAccounts", (v, p) => r.accounts(v, p), path);
  const frozenLegARailRef = r.optional(o, "frozenLegARailRef", (v, p) => r.string(v, p), path);
  const ownAccountLine = r.optional(
    o,
    "ownAccountLine",
    (v, p) => {
      const l = r.object(v, p, ["address", "text"]);
      return { address: r.string(l.address, `${p}.address`), text: r.line(l.text, `${p}.text`) };
    },
    path,
  );
  return {
    ...common,
    role: "seller",
    contractA,
    preimage,
    statement,
    ...(attemptedAcceptB === undefined ? {} : { attemptedAcceptB }),
    ...(lockedLegBContract === undefined ? {} : { lockedLegBContract }),
    ...(frozenLegAAccounts === undefined ? {} : { frozenLegAAccounts }),
    ...(frozenLegARailRef === undefined ? {} : { frozenLegARailRef }),
    ...(ownAccountLine === undefined ? {} : { ownAccountLine }),
    claimAttempted,
    ...(claimFromBlock === undefined ? {} : { claimFromBlock }),
    claimRecords,
    ...(publicClaimSignature === undefined ? {} : { publicClaimSignature }),
    neverLandedClaims: r.int(o.neverLandedClaims, `${path}.neverLandedClaims`),
    claimOutcome,
    revealPosted: r.bool(o.revealPosted, `${path}.revealPosted`),
    receiptPosted: r.bool(o.receiptPosted, `${path}.receiptPosted`),
    legBRefund: {
      attempted: r.bool(refundObject.attempted, `${path}.legBRefund.attempted`),
      done: r.bool(refundObject.done, `${path}.legBRefund.done`),
      framesPosted: r.bool(refundObject.framesPosted, `${path}.legBRefund.framesPosted`),
    },
  };
}

function parseBuyer(r: Reader, o: Record<string, unknown>, path: string, common: FlowRecordBase): BuyerFlowRecord {
  const ownAccountLine = r.optional(
    o,
    "ownAccountLine",
    (v, p) => {
      const l = r.object(v, p, ["address", "text"]);
      return { address: r.string(l.address, `${p}.address`), text: r.line(l.text, `${p}.text`) };
    },
    path,
  );
  const lockObject = r.object(o.lock, `${path}.lock`, ["attempted", "framePosted"], ["prepared", "fromBlock", "accounts", "hashLock", "evidence"]);
  const prepared = r.optional(
    lockObject,
    "prepared",
    (v, p) => {
      const q = r.object(v, p, ["ref"], ["recovery"]);
      const recovery = r.optional(q, "recovery", (x, pp) => r.recovery(x, pp), p);
      return { ref: r.string(q.ref, `${p}.ref`), ...(recovery === undefined ? {} : { recovery }) };
    },
    `${path}.lock`,
  );
  const fromBlock = r.optional(lockObject, "fromBlock", (v, p) => r.marker(v, p), `${path}.lock`);
  const accounts = r.optional(lockObject, "accounts", (v, p) => r.accounts(v, p), `${path}.lock`);
  const hashLock = r.optional(lockObject, "hashLock", (v, p) => r.string(v, p, { pattern: HEX32 }), `${path}.lock`);
  const evidence = r.optional(lockObject, "evidence", (v, p) => r.evidence(v, p), `${path}.lock`);
  const attempted = r.bool(lockObject.attempted, `${path}.lock.attempted`);
  if (!attempted && (prepared !== undefined || evidence !== undefined)) r.fail(`${path}.lock.attempted`, "must be true once a lock was prepared or has evidence");

  const refundObject = r.object(o.refund, `${path}.refund`, ["attempted", "framesPosted"], ["recovery", "evidence", "claimSeen"]);
  const refundClaimSeen = r.optional(
    refundObject,
    "claimSeen",
    (v, p) => {
      if (r.bool(v, p) !== true) r.fail(p, "must be true when present");
      return true as const;
    },
    `${path}.refund`,
  );
  const refundRecovery = r.optional(refundObject, "recovery", (v, p) => r.recovery(v, p), `${path}.refund`);
  const refundEvidence = r.optional(refundObject, "evidence", (v, p) => r.evidence(v, p), `${path}.refund`);
  const refundAttempted = r.bool(refundObject.attempted, `${path}.refund.attempted`);
  if (!refundAttempted && (refundRecovery !== undefined || refundEvidence !== undefined)) r.fail(`${path}.refund.attempted`, "must be true once a refund was signed or has evidence");

  const legBClaimAttempted = r.bool(o.legBClaimAttempted, `${path}.legBClaimAttempted`);
  const legBClaimed = r.bool(o.legBClaimed, `${path}.legBClaimed`);
  if (legBClaimed && !legBClaimAttempted) r.fail(`${path}.legBClaimed`, "needs legBClaimAttempted");
  const legBClaimAdopted = r.optional(
    o,
    "legBClaimAdopted",
    (v, p) => {
      if (r.bool(v, p) !== true) r.fail(p, "must be true when present");
      return true as const;
    },
    path,
  );
  if (legBClaimAdopted !== undefined && !legBClaimAttempted) r.fail(`${path}.legBClaimAdopted`, "needs legBClaimAttempted");
  if (legBClaimAdopted !== undefined && legBClaimed) r.fail(`${path}.legBClaimAdopted`, "a leg B claim is this flow's own or adopted, never both");

  return {
    ...common,
    role: "buyer",
    legBVerified: r.bool(o.legBVerified, `${path}.legBVerified`),
    ...(ownAccountLine === undefined ? {} : { ownAccountLine }),
    lock: {
      attempted,
      ...(prepared === undefined ? {} : { prepared }),
      ...(fromBlock === undefined ? {} : { fromBlock }),
      ...(accounts === undefined ? {} : { accounts }),
      ...(hashLock === undefined ? {} : { hashLock }),
      ...(evidence === undefined ? {} : { evidence }),
      framePosted: r.bool(lockObject.framePosted, `${path}.lock.framePosted`),
    },
    legBClaimAttempted,
    legBClaimed,
    ...(legBClaimAdopted === undefined ? {} : { legBClaimAdopted }),
    refund: {
      attempted: refundAttempted,
      ...(refundRecovery === undefined ? {} : { recovery: refundRecovery }),
      ...(refundEvidence === undefined ? {} : { evidence: refundEvidence }),
      framesPosted: r.bool(refundObject.framesPosted, `${path}.refund.framesPosted`),
      ...(refundClaimSeen === undefined ? {} : { claimSeen: refundClaimSeen }),
    },
    refundNotes: r.array(o.refundNotes, `${path}.refundNotes`, 64).map((item, i) => r.string(item, `${path}.refundNotes[${i}]`, { max: 1024 })),
  };
}

/** Runs the reader over a record the caller just built, so a bad one never leaves the helper that made it. A failure is
 *  `FlowRecordInvalidError` (R1-09). */
function checked<T extends FlowRecord>(record: T): T {
  parseRecord(JSON.parse(JSON.stringify(record)) as unknown, describeKey(record), true);
  return record;
}
