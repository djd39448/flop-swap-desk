// SPDX-License-Identifier: MIT
//
// Helpers shared by the live P8 resume suites (tests-anvil, tests-regtest, tests-near, tests-sol; P8-RESUME-SPEC.md "Tests", the
// live part). A "process" in those suites is a flow instance plus the rail, the transport and the paper rail it was handed; a
// crash drops it, and a fresh process is built over the same venue, note store, chain, clock and FileFlowStore directory. What this
// file gives them:
//   - `RecordingStore`: wraps any FlowStore and keeps the text of every save that succeeded, so a suite can scan every historical
//     record a party wrote (rule 5) and not only the last one;
//   - `countingFetch` / `lossyFetch`: wrappers for `CapturingRpc`'s `fetch` option. The first counts the JSON-RPC methods one
//     process sent (how a suite proves "no second lock, no second claim"); the second performs a request for real and then loses
//     the reply, once, when armed (a send that landed whose answer never came back);
//   - `assertSavesClean`: no store save names key material, no Buyer save holds the swap preimage;
//   - `swapProblems`: the venue-side audit of a finished swap (each frame exactly once per contract, tclk's own fold accepts every
//     step and ends where the swap should, the leg B note), the same checks the hermetic crash matrix makes.

import { OFFER_ROOM, dealRoom, foldTranscript, tryDecodeFrame, type TranscriptRecord } from "@flop-labs/tclk";

import type { FlowStore } from "../../src/client/flow-store.js";
import type { Venue } from "../../src/client/venue.js";
import { keyMaterialProblems } from "./secret-scan.js";

const decoder = new TextDecoder();

/** A store that keeps the text of every save that went through (a refused save is not recorded). */
export class RecordingStore implements FlowStore {
  readonly saved: string[] = [];
  readonly inner: FlowStore;
  constructor(inner: FlowStore) {
    this.inner = inner;
  }
  load(key: string): Promise<Uint8Array | null> {
    return this.inner.load(key);
  }
  async save(key: string, bytes: Uint8Array): Promise<void> {
    await this.inner.save(key, bytes);
    this.saved.push(decoder.decode(bytes));
  }
  list(): Promise<string[]> {
    return this.inner.list();
  }
}

/** One JSON-RPC call as it went out on the wire. */
export interface SentCall {
  method: string;
  params: unknown;
}

/** The JSON-RPC calls in a request body (a batch has several), or none for a body that is not JSON-RPC. */
function callsOf(init: RequestInit | undefined): SentCall[] {
  if (typeof init?.body !== "string") return [];
  try {
    const parsed = JSON.parse(init.body) as unknown;
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    return calls.flatMap((call) => {
      const { method, params } = (call ?? {}) as { method?: unknown; params?: unknown };
      return typeof method === "string" ? [{ method, params }] : [];
    });
  } catch {
    return [];
  }
}

const methodsOf = (init: RequestInit | undefined): string[] => callsOf(init).map((call) => call.method);

export interface CountingFetch {
  fetch: typeof fetch;
  /** Every method this transport sent, in order. */
  readonly methods: string[];
  /** Every call this transport sent, in order, with its params. */
  readonly requests: SentCall[];
  count(method: string): number;
}

/** Wraps `inner` (default: the platform `fetch`) and records the JSON-RPC calls that pass through. */
export function countingFetch(inner?: typeof fetch): CountingFetch {
  const methods: string[] = [];
  const requests: SentCall[] = [];
  const counting: typeof fetch = async (input, init) => {
    for (const call of callsOf(init)) {
      methods.push(call.method);
      requests.push(call);
    }
    return (inner ?? fetch)(input, init);
  };
  return { fetch: counting, methods, requests, count: (method) => methods.filter((m) => m === method).length };
}

export interface LossyFetch extends CountingFetch {
  /** The next request whose methods include `method` is performed for real, its reply is read and thrown away, and the call fails. */
  arm(): void;
  /** How many replies were lost so far. */
  lost(): number;
}

/** A counting `fetch` that can lose ONE reply for `method` after the request really went out (the send landed, the answer did not). */
export function lossyFetch(method: string, inner?: typeof fetch): LossyFetch {
  const counting = countingFetch(inner);
  let armed = false;
  let lost = 0;
  const lossy: typeof fetch = async (input, init) => {
    const response = await counting.fetch(input, init);
    if (armed && methodsOf(init).includes(method)) {
      armed = false;
      lost += 1;
      await response.arrayBuffer(); // the node has answered; the answer never reaches the caller
      throw new Error(`connection reset while reading the reply to ${method} (test)`);
    }
    return response;
  };
  return {
    fetch: lossy,
    methods: counting.methods,
    requests: counting.requests,
    count: counting.count,
    arm: () => {
      armed = true;
    },
    lost: () => lost,
  };
}

export interface DroppingFetch extends CountingFetch {
  /** The next request whose methods include `method` is NOT sent at all and the call fails (the process died before the send). */
  arm(): void;
  /** How many requests were dropped so far. */
  dropped(): number;
}

/** A counting `fetch` that can drop ONE request for `method` before it reaches the node (signed and recorded, never sent). */
export function droppingFetch(method: string, inner?: typeof fetch): DroppingFetch {
  const counting = countingFetch(inner);
  let armed = false;
  let dropped = 0;
  const dropping: typeof fetch = async (input, init) => {
    if (armed && methodsOf(init).includes(method)) {
      armed = false;
      dropped += 1;
      throw new Error(`connection refused before sending ${method} (test)`);
    }
    return counting.fetch(input, init);
  };
  return {
    fetch: dropping,
    methods: counting.methods,
    requests: counting.requests,
    count: counting.count,
    arm: () => {
      armed = true;
    },
    dropped: () => dropped,
  };
}

/** The bare hex of a `0x` preimage, lowercase and uppercase: the forms a record would carry it in. */
function preimageForms(preimage: string): string[] {
  const bare = preimage.replace(/^0x/, "");
  return [bare.toLowerCase(), bare.toUpperCase()];
}

/**
 * Rule 5 on what the two parties wrote to their stores over the whole run: no save names a key-material field or carries a key
 * seed the suite derived a key from, no Buyer save holds the swap preimage or has a `preimage` field, and the Seller's own saves do
 * show it (so the check is not blind). Returns the problems as sentences.
 */
export function assertSavesClean(args: { buyer: RecordingStore; seller: RecordingStore; preimage: string; seeds: readonly Uint8Array[] }): string[] {
  const problems: string[] = [];
  const forms = preimageForms(args.preimage);
  args.buyer.saved.forEach((text, index) => {
    const label = `buyer store save ${index + 1}`;
    problems.push(...keyMaterialProblems(text, label, args.seeds));
    if (forms.some((form) => text.includes(form))) problems.push(`${label}: the swap preimage (only the Seller's record may hold it)`);
    if (/"preimage"/.test(text)) problems.push(`${label}: a preimage field in a Buyer record`);
  });
  args.seller.saved.forEach((text, index) => {
    problems.push(...keyMaterialProblems(text, `seller store save ${index + 1}`, args.seeds));
  });
  if (args.buyer.saved.length === 0) problems.push("the Buyer never saved a record");
  if (!args.seller.saved.some((text) => forms.some((form) => text.includes(form)))) problems.push("the Seller's saves never show the preimage: the scan is blind");
  return problems;
}

export type Outcome = "settled" | "refunded";

interface FrameCounts {
  [type: string]: number;
}

async function counts(venue: Venue, room: string): Promise<FrameCounts> {
  const out: FrameCounts = {};
  for (const record of await venue.read(room)) {
    const type = tryDecodeFrame(record.line)?.type ?? "line";
    out[type] = (out[type] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const sorted = (c: FrameCounts): FrameCounts => Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)));

/**
 * The venue-side audit of a finished swap, as sentences (empty = right): the offers room holds the two offers and the two accepts
 * once each; deal room A holds the two account lines and, once each, the frames of the outcome (lock, then reveal and receipt for
 * `settled`, refund and receipt for `refunded`); deal room B holds its own; tclk's fold of each leg ends where the outcome says and
 * rejected no step (a frame posted twice would be a rejected step); both account lines come before the lock frame.
 */
export async function swapProblems(args: {
  venue: Venue;
  contractA: string;
  contractB: string;
  offerAId: string;
  offerBId: string;
  buyerDid: string;
  sellerDid: string;
  outcome: Outcome;
}): Promise<string[]> {
  const problems: string[] = [];
  const check = (label: string, actual: unknown, wanted: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) problems.push(`${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  };
  const roomA = dealRoom(args.contractA);
  const roomB = dealRoom(args.contractB);
  check("offers room", await counts(args.venue, OFFER_ROOM), { accept: 2, offer: 2 });
  const settled = args.outcome === "settled";
  check("deal room A", await counts(args.venue, roomA), sorted(settled ? { line: 2, lock: 1, reveal: 1, receipt: 1 } : { line: 2, lock: 1, refund: 1, receipt: 1 }));
  check("deal room B", await counts(args.venue, roomB), sorted(settled ? { lock: 1, reveal: 1, receipt: 1 } : { lock: 1, refund: 1, receipt: 1 }));

  const offers = await args.venue.read(OFFER_ROOM);
  const pick = (match: (frame: ReturnType<typeof tryDecodeFrame>) => boolean): TranscriptRecord | undefined => offers.find((record) => match(tryDecodeFrame(record.line)));
  const offerA = pick((f) => f?.type === "offer" && f.id === args.offerAId);
  const offerB = pick((f) => f?.type === "offer" && f.id === args.offerBId);
  const acceptA = pick((f) => f?.type === "accept" && f.contract === args.contractA);
  const acceptB = pick((f) => f?.type === "accept" && f.contract === args.contractB);
  const want = settled ? "claimed" : "refunded";
  if (offerA === undefined || acceptA === undefined || offerB === undefined || acceptB === undefined) {
    problems.push("the offers room does not hold the swap's four signed records");
    return problems;
  }
  const legs: Array<[string, TranscriptRecord, TranscriptRecord, string]> = [
    ["leg A", offerA, acceptA, roomA],
    ["leg B", offerB, acceptB, roomB],
  ];
  for (const [label, offer, accept, room] of legs) {
    const folded = foldTranscript([offer, accept, ...(await args.venue.read(room))]);
    check(`${label} status`, folded.state?.status, want);
    check(
      `${label} rejected steps`,
      folded.steps.filter((step) => !step.ok && step.type !== undefined).map((step) => `${step.type}@${step.seq}`),
      [],
    );
  }
  const recordsA = await args.venue.read(roomA);
  const lockSeq = recordsA.find((record) => tryDecodeFrame(record.line)?.type === "lock")?.seq ?? Number.POSITIVE_INFINITY;
  for (const did of [args.buyerDid, args.sellerDid]) {
    const lines = recordsA.filter((record) => record.sender === did && tryDecodeFrame(record.line) === null);
    check(`account lines of ${did.slice(-6)}`, lines.length, 1);
    if (lines.some((record) => record.seq > lockSeq)) problems.push(`${did.slice(-6)} posted an account line after the lock frame`);
  }
  return problems;
}
