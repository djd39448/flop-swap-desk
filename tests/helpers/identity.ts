// SPDX-License-Identifier: MIT
//
// Ed25519 identity + signed-record helpers for tests. Copied from vendor/tclk's own
// tests/transcript.test.ts (lines ~20-60) so fixtures built here produce exactly the
// records `foldTranscript`/`verifyTranscriptRecord` accept: the signature covers
// `<room>|<nonce>|<line>` and the sender is a `did:key:z6Mk…` Ed25519 key.

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64urlnopad } from "@scure/base";
import type { TranscriptRecord } from "@flop-labs/tclk";

export interface Identity {
  did: string;
  sign(canonical: string): string;
}

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16)));
}

/** Derive a did:key Ed25519 identity from a 32-byte hex seed. */
export function identity(seedHex: string): Identity {
  const seed = bytes(seedHex);
  const publicKey = ed25519.getPublicKey(seed);
  const tagged = Uint8Array.from([0xed, 0x01, ...publicKey]);
  return {
    did: `did:key:z${base58.encode(tagged)}`,
    sign(canonical: string) {
      return base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed));
    },
  };
}

/** Build one signed technocore record for `line` in `room` at `seq`/`timestampMs`. */
export function record(
  room: string,
  seq: number,
  timestampMs: number,
  signer: Identity,
  line: string,
): TranscriptRecord {
  const nonce = String(10_000 + seq);
  return {
    room,
    seq,
    timestampMs,
    sender: signer.did,
    nonce,
    signature: signer.sign(`${room}|${nonce}|${line}`),
    line,
  };
}

/** Same record, but signed by a different identity than the one it claims to be from —
 *  for "record in the wrong room" / "wrong-signer from" style forgery fixtures, combine
 *  this with a `line` whose embedded `from` still names the honest party. */
export function recordSignedBy(
  room: string,
  seq: number,
  timestampMs: number,
  signer: Identity,
  claimedSender: string,
  line: string,
): TranscriptRecord {
  const nonce = String(10_000 + seq);
  return {
    room,
    seq,
    timestampMs,
    sender: claimedSender,
    nonce,
    signature: signer.sign(`${room}|${nonce}|${line}`),
    line,
  };
}

/** Same record with no signature/nonce at all — the unsigned-lane fixture. */
export function unsignedRecord(room: string, seq: number, timestampMs: number, line: string): TranscriptRecord {
  return { room, seq, timestampMs, sender: "did:key:z6Mkunsigned0000000000000000000000000000000000", nonce: null, signature: null, line };
}
