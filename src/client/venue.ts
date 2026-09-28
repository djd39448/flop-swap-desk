// SPDX-License-Identifier: MIT
//
// P22-P24-EVM-SPEC.md §6: the venue abstraction the Seller/Buyer client step functions
// (src/client/seller.ts, src/client/buyer.ts) post through and read from. `MemoryVenue` is the
// keyless, local stand-in for technocore.chat used by the anvil end-to-end tests and
// src/client/bundle.ts: in-memory rooms, a per-room monotonically increasing `seq`, and
// `timestampMs` from an injected clock — never `Date.now()` in here (house rule: no clock in a
// function that isn't explicitly given one). Every record it produces is signed exactly the way
// tests/helpers/identity.ts's `record()` builds one (nonce `String(10_000 + seq)`, signature
// over `${room}|${nonce}|${line}`), so `verifyTranscriptRecord` accepts it — the two must never
// diverge, since a client flow driven through `MemoryVenue` and a fixture built with the test
// helper both end up folded by the exact same `foldTranscript`.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §6.

import type { TranscriptRecord } from "@flop-labs/tclk";

/**
 * A tclk did:key identity that can sign a canonical `${room}|${nonce}|${line}` string — the
 * same shape tests/helpers/identity.ts's `Identity` already is. A real signer (as opposed to a
 * test fixture's) belongs to a caller of this module, never to `src/` (this build holds no
 * private key material of any kind — D-10 is about EVM accounts, but the same spirit applies to
 * every other key this repo touches).
 */
export interface Signer {
  did: string;
  sign(canonical: string): string;
}

/**
 * Posts a line to a room and reads a room back — the only I/O surface the client step functions
 * touch. A real deployment's implementation talks to technocore over HTTP; this module only
 * ships the keyless, in-memory one (`MemoryVenue`), which is what the anvil end-to-end tests and
 * `src/client/bundle.ts` drive.
 */
export interface Venue {
  post(room: string, line: string, signer: Signer): Promise<TranscriptRecord>;
  read(room: string): Promise<readonly TranscriptRecord[]>;
}

/**
 * Local, in-memory `Venue`: every room starts empty, `seq` is 1-based and per-room, and
 * `timestampMs` comes from `clock()` at post time — never advanced or read anywhere else in
 * this module. This is the local build's stand-in for technocore.chat; it is never pointed at a
 * real network (D-10: no key, no network, no venue this build doesn't fully control).
 */
export class MemoryVenue implements Venue {
  private readonly rooms = new Map<string, TranscriptRecord[]>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  async post(room: string, line: string, signer: Signer): Promise<TranscriptRecord> {
    const records = this.rooms.get(room) ?? [];
    const seq = records.length + 1;
    const nonce = String(10_000 + seq);
    const record: TranscriptRecord = {
      room,
      seq,
      timestampMs: this.clock(),
      sender: signer.did,
      nonce,
      signature: signer.sign(`${room}|${nonce}|${line}`),
      line,
    };
    records.push(record);
    this.rooms.set(room, records);
    return record;
  }

  async read(room: string): Promise<readonly TranscriptRecord[]> {
    return [...(this.rooms.get(room) ?? [])];
  }
}
