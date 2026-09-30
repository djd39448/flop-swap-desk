// SPDX-License-Identifier: MIT
//
// First-party Solana legacy-transaction codec for the desk's Solana leg (P6-SOL-SPEC.md section 3): no
// `@solana/*` dependency, only the already-installed `@noble/curves` (ed25519), `@noble/hashes` (sha256)
// and `@scure/base` (base58).
//
// What is here:
//   - shortvec (compact-u16) encode and STRICT decode (aliased and over-long encodings are refused),
//   - a legacy message compiler (account ordering: signer+writable, signer+readonly, writable, readonly;
//     the fee payer first) and a strict decoder that must consume every byte,
//   - transaction assembly: the signature array, then the message; the transaction id is the FIRST
//     signature in base58 (known before anything is sent, which is what record-before-send needs),
//   - program-derived addresses (`createProgramAddress` / `findProgramAddress`) and the on-curve test.
//
// Public vectors the tests pin (URLs cited in tests/sol-tx.test.ts):
//   - the shortvec cases and the strict-decode refusals in crates.io `solana-short-vec` 3.3.0 (src/lib.rs:
//     `test_short_vec_encode_len`, `test_deserialize`),
//   - the whole serialized sample transaction in crates.io `solana-transaction` 4.3.0 (src/lib.rs:
//     `test_sdk_serialize`, source repository https://github.com/anza-xyz/solana-sdk),
//   - the program-derived-address cases in crates.io `solana-address` 2.8.0 (src/lib.rs:
//     `test_create_program_address`, same repository).
// The validator is the final oracle (SB-int).

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/** A legacy transaction must fit one UDP packet: 1232 bytes (the network's own limit). */
export const SOL_MAX_TX_BYTES = 1232;
export const SOL_SIGNATURE_BYTES = 64;
export const SOL_PUBKEY_BYTES = 32;

// --- base58 pubkeys ---------------------------------------------------------------------------------

/** Decodes a canonical base58 pubkey (exactly 32 bytes; re-encoding must give the same text). Throws. */
export function pubkeyFromBase58(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
    throw new Error("sol-tx: not a base58 public key");
  }
  const bytes = base58.decode(text);
  if (bytes.length !== SOL_PUBKEY_BYTES || base58.encode(bytes) !== text) {
    throw new Error("sol-tx: base58 public key must decode to exactly 32 bytes (canonical spelling)");
  }
  return bytes;
}

export function pubkeyToBase58(bytes: Uint8Array): string {
  if (bytes.length !== SOL_PUBKEY_BYTES) throw new Error("sol-tx: a public key is exactly 32 bytes");
  return base58.encode(bytes);
}

export function isValidPubkeyBase58(text: unknown): text is string {
  if (typeof text !== "string") return false;
  try {
    pubkeyFromBase58(text);
    return true;
  } catch {
    return false;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- shortvec (compact-u16) ---------------------------------------------------------------------------

/** Encodes 0..65535 as 1-3 bytes, 7 bits per byte, low group first, high bit = "more follows". */
export function encodeShortvec(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error("sol-tx: shortvec value must be 0..65535");
  const out: number[] = [];
  let rem = value;
  for (;;) {
    let elem = rem & 0x7f;
    rem >>>= 7;
    if (rem === 0) {
      out.push(elem);
      break;
    }
    elem |= 0x80;
    out.push(elem);
  }
  return Uint8Array.from(out);
}

/** Strict decode at `offset`: 1-3 bytes, value <= 0xffff, and CANONICAL (a longer encoding of a value
 *  that fits in fewer bytes, such as `[0x80, 0x00]`, is refused). Throws on anything else. */
export function decodeShortvec(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) throw new Error("sol-tx: shortvec runs past the end of the buffer");
    const group = byte & 0x7f;
    if (i === 2 && (byte & 0x80) !== 0) throw new Error("sol-tx: shortvec is longer than 3 bytes");
    value += group * 128 ** i;
    if (value > 0xffff) throw new Error("sol-tx: shortvec value exceeds 65535");
    if ((byte & 0x80) === 0) {
      if (i > 0 && group === 0) throw new Error("sol-tx: shortvec is not canonical (aliased length)");
      return { value, next: offset + i + 1 };
    }
  }
  throw new Error("sol-tx: shortvec is longer than 3 bytes");
}

function compactArray(items: readonly Uint8Array[]): Uint8Array {
  return concatBytes(encodeShortvec(items.length), ...items);
}

// --- messages -----------------------------------------------------------------------------------------

export interface SolAccountMeta {
  pubkey: Uint8Array;
  isSigner: boolean;
  isWritable: boolean;
}

export interface SolInstruction {
  programId: Uint8Array;
  accounts: readonly SolAccountMeta[];
  data: Uint8Array;
}

export interface SolCompiledInstruction {
  programIdIndex: number;
  accountIndexes: readonly number[];
  data: Uint8Array;
}

export interface SolMessageHeader {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
}

export interface SolCompiledMessage {
  header: SolMessageHeader;
  accountKeys: readonly Uint8Array[];
  recentBlockhash: Uint8Array;
  instructions: readonly SolCompiledInstruction[];
  /** The exact wire bytes of the message (what is signed). */
  bytes: Uint8Array;
}

function keyText(key: Uint8Array): string {
  return base58.encode(key);
}

/**
 * Compiles instructions into a legacy message. The fee payer is account 0 (signer, writable). Account
 * order is signer+writable, signer+readonly, non-signer+writable, non-signer+readonly, each in order of
 * first appearance; duplicate keys merge their flags (signer/writable if ANY use needs it); a program id
 * is a read-only non-signer unless an instruction also lists it with stronger flags.
 */
export function compileLegacyMessage(input: {
  feePayer: Uint8Array;
  recentBlockhash: Uint8Array;
  instructions: readonly SolInstruction[];
}): SolCompiledMessage {
  if (input.feePayer.length !== 32) throw new Error("sol-tx: fee payer must be 32 bytes");
  if (input.recentBlockhash.length !== 32) throw new Error("sol-tx: recent blockhash must be 32 bytes");

  type Entry = { key: Uint8Array; isSigner: boolean; isWritable: boolean; order: number };
  const entries = new Map<string, Entry>();
  let order = 0;
  const touch = (key: Uint8Array, isSigner: boolean, isWritable: boolean): void => {
    if (key.length !== 32) throw new Error("sol-tx: every account key must be 32 bytes");
    const id = keyText(key);
    const existing = entries.get(id);
    if (existing === undefined) {
      entries.set(id, { key, isSigner, isWritable, order });
      order += 1;
    } else {
      existing.isSigner = existing.isSigner || isSigner;
      existing.isWritable = existing.isWritable || isWritable;
    }
  };

  touch(input.feePayer, true, true);
  for (const ix of input.instructions) {
    for (const meta of ix.accounts) touch(meta.pubkey, meta.isSigner, meta.isWritable);
    touch(ix.programId, false, false);
  }

  const all = [...entries.values()];
  const payerId = keyText(input.feePayer);
  const rank = (e: Entry): number => (e.isSigner ? (e.isWritable ? 0 : 1) : e.isWritable ? 2 : 3);
  const ordered = all.sort((a, b) => {
    // the fee payer is always first; otherwise category, then first appearance
    if (keyText(a.key) === payerId) return -1;
    if (keyText(b.key) === payerId) return 1;
    return rank(a) - rank(b) || a.order - b.order;
  });
  if (ordered.length > 255) throw new Error("sol-tx: too many accounts (a legacy message indexes accounts with one byte)");

  const numRequiredSignatures = ordered.filter((e) => e.isSigner).length;
  const numReadonlySigned = ordered.filter((e) => e.isSigner && !e.isWritable).length;
  const numReadonlyUnsigned = ordered.filter((e) => !e.isSigner && !e.isWritable).length;
  const indexOf = new Map<string, number>(ordered.map((e, i) => [keyText(e.key), i]));

  const instructions: SolCompiledInstruction[] = input.instructions.map((ix) => {
    const programIdIndex = indexOf.get(keyText(ix.programId));
    if (programIdIndex === undefined) throw new Error("sol-tx: internal - program id missing from the account list");
    const accountIndexes = ix.accounts.map((meta) => {
      const index = indexOf.get(keyText(meta.pubkey));
      if (index === undefined) throw new Error("sol-tx: internal - account missing from the account list");
      return index;
    });
    return { programIdIndex, accountIndexes, data: ix.data };
  });

  const header: SolMessageHeader = { numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned };
  const accountKeys = ordered.map((e) => e.key);
  const bytes = concatBytes(
    Uint8Array.of(numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned),
    compactArray(accountKeys),
    input.recentBlockhash,
    compactArray(
      instructions.map((ix) =>
        concatBytes(
          Uint8Array.of(ix.programIdIndex),
          compactArray(ix.accountIndexes.map((i) => Uint8Array.of(i))),
          encodeShortvec(ix.data.length),
          ix.data,
        ),
      ),
    ),
  );
  return { header, accountKeys, recentBlockhash: input.recentBlockhash, instructions, bytes };
}

class Reader {
  offset: number;
  constructor(private readonly bytes: Uint8Array, offset = 0) {
    this.offset = offset;
  }
  u8(): number {
    const b = this.bytes[this.offset];
    if (b === undefined) throw new Error("sol-tx: unexpected end of data");
    this.offset += 1;
    return b;
  }
  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new Error("sol-tx: unexpected end of data");
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  shortvec(): number {
    const r = decodeShortvec(this.bytes, this.offset);
    this.offset = r.next;
    return r.value;
  }
  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function readMessage(reader: Reader, messageStart: number, whole: Uint8Array): SolCompiledMessage {
  const first = whole[messageStart];
  if (first === undefined) throw new Error("sol-tx: empty message");
  if ((first & 0x80) !== 0) throw new Error("sol-tx: versioned (v0) messages are not supported by this codec");
  const numRequiredSignatures = reader.u8();
  const numReadonlySigned = reader.u8();
  const numReadonlyUnsigned = reader.u8();
  const keyCount = reader.shortvec();
  const accountKeys: Uint8Array[] = [];
  for (let i = 0; i < keyCount; i += 1) accountKeys.push(reader.take(32));
  if (numRequiredSignatures < 1) throw new Error("sol-tx: a message needs at least one signature (the fee payer)");
  if (numReadonlySigned >= numRequiredSignatures) throw new Error("sol-tx: the fee payer cannot be read-only");
  if (numRequiredSignatures + numReadonlyUnsigned > keyCount) throw new Error("sol-tx: header counts exceed the account list");
  const recentBlockhash = reader.take(32);
  const ixCount = reader.shortvec();
  const instructions: SolCompiledInstruction[] = [];
  for (let i = 0; i < ixCount; i += 1) {
    const programIdIndex = reader.u8();
    const accCount = reader.shortvec();
    const accountIndexes: number[] = [];
    for (let j = 0; j < accCount; j += 1) accountIndexes.push(reader.u8());
    const dataLen = reader.shortvec();
    const data = reader.take(dataLen);
    if (programIdIndex >= keyCount) throw new Error("sol-tx: program id index out of range");
    if (programIdIndex === 0) throw new Error("sol-tx: the fee payer cannot be a program");
    for (const index of accountIndexes) if (index >= keyCount) throw new Error("sol-tx: account index out of range");
    instructions.push({ programIdIndex, accountIndexes, data });
  }
  return {
    header: { numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned },
    accountKeys,
    recentBlockhash,
    instructions,
    bytes: whole.slice(messageStart, reader.offset),
  };
}

/** Strict decode of a legacy message: every byte consumed, every index in range. Throws. */
export function decodeLegacyMessage(bytes: Uint8Array): SolCompiledMessage {
  const reader = new Reader(bytes);
  const message = readMessage(reader, 0, bytes);
  if (!reader.done) throw new Error("sol-tx: trailing bytes after the message");
  return message;
}

// --- transactions -------------------------------------------------------------------------------------

export interface SolTransaction {
  signatures: readonly Uint8Array[];
  message: SolCompiledMessage;
  /** The exact wire bytes. */
  bytes: Uint8Array;
  /** The transaction id: the FIRST signature in base58. */
  signature: string;
}

/** The transaction id (first signature, base58): known as soon as the transaction is signed. */
export function transactionId(firstSignature: Uint8Array): string {
  if (firstSignature.length !== SOL_SIGNATURE_BYTES) throw new Error("sol-tx: a signature is exactly 64 bytes");
  return base58.encode(firstSignature);
}

export function encodeTransaction(signatures: readonly Uint8Array[], messageBytes: Uint8Array): Uint8Array {
  for (const s of signatures) if (s.length !== SOL_SIGNATURE_BYTES) throw new Error("sol-tx: a signature is exactly 64 bytes");
  return concatBytes(compactArray(signatures), messageBytes);
}

/** Strict decode of a legacy transaction: signature count equals `numRequiredSignatures`, all bytes used. */
export function decodeTransaction(bytes: Uint8Array): SolTransaction {
  const reader = new Reader(bytes);
  const sigCount = reader.shortvec();
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < sigCount; i += 1) signatures.push(reader.take(SOL_SIGNATURE_BYTES));
  const messageStart = reader.offset;
  const message = readMessage(reader, messageStart, bytes);
  if (!reader.done) throw new Error("sol-tx: trailing bytes after the transaction");
  if (sigCount !== message.header.numRequiredSignatures) throw new Error("sol-tx: signature count does not match the message header");
  const first = signatures[0];
  if (first === undefined) throw new Error("sol-tx: no signatures");
  return { signatures, message, bytes, signature: transactionId(first) };
}

export interface SolTxSigner {
  /** 32-byte public key. */
  readonly publicKeyBytes: Uint8Array;
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/**
 * Signs `message` with one signer per required signature (matched by public key, placed in account-key
 * order) and returns the transaction. Enforces the 1232-byte limit. Every signature is checked to verify
 * under its key before this returns, so a signer that returns garbage is caught here, not by the network.
 */
export async function signTransaction(message: SolCompiledMessage, signers: readonly SolTxSigner[]): Promise<SolTransaction> {
  const required = message.header.numRequiredSignatures;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < required; i += 1) {
    const key = message.accountKeys[i];
    if (key === undefined) throw new Error("sol-tx: internal - missing signer key");
    const signer = signers.find((s) => bytesEqual(s.publicKeyBytes, key));
    if (signer === undefined) throw new Error(`sol-tx: no signer supplied for required signature ${i} (${base58.encode(key)})`);
    const signature = await signer.sign(message.bytes);
    if (signature.length !== SOL_SIGNATURE_BYTES) throw new Error("sol-tx: signer returned a signature that is not 64 bytes");
    if (!ed25519.verify(signature, message.bytes, key)) throw new Error("sol-tx: signer returned a signature that does not verify");
    signatures.push(signature);
  }
  const bytes = encodeTransaction(signatures, message.bytes);
  if (bytes.length > SOL_MAX_TX_BYTES) throw new Error(`sol-tx: transaction is ${bytes.length} bytes, over the ${SOL_MAX_TX_BYTES}-byte limit`);
  const first = signatures[0];
  if (first === undefined) throw new Error("sol-tx: internal - no signatures");
  return { signatures, message, bytes, signature: transactionId(first) };
}

/** True when every signature verifies under its account key over the message bytes. Never throws. */
export function verifyTransactionSignatures(tx: SolTransaction): boolean {
  try {
    return tx.signatures.every((signature, i) => {
      const key = tx.message.accountKeys[i];
      return key !== undefined && ed25519.verify(signature, tx.message.bytes, key);
    });
  } catch {
    return false;
  }
}

// --- program-derived addresses ------------------------------------------------------------------------

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** True when the 32 bytes decode to a point on the ed25519 curve (a real key could exist for it). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True for an encoding that is NOT a usable wallet key: small-order points (the identity, its torsion
 *  neighbours) and any non-canonical encoding (re-encoding differs). Nobody can sign for these under Solana's
 *  strict signature verification, so a token account owned by one could never be spent from. Malformed
 *  encodings count as unusable too. */
export function isSmallOrderOrNonCanonical(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return true;
  try {
    const point = ed25519.Point.fromBytes(bytes);
    return point.isSmallOrder() || !bytesEqual(point.toBytes(), bytes);
  } catch {
    return true;
  }
}

/** `sha256(seeds || programId || "ProgramDerivedAddress")`; `null` when the result is ON the curve (a
 *  program-derived address must be off it). At most 16 seeds of at most 32 bytes each. */
export function createProgramAddress(seeds: readonly Uint8Array[], programId: Uint8Array): Uint8Array | null {
  if (seeds.length > 16) throw new Error("sol-tx: at most 16 seeds");
  for (const seed of seeds) if (seed.length > 32) throw new Error("sol-tx: a seed is at most 32 bytes");
  const hash = sha256(concatBytes(...seeds, programId, PDA_MARKER));
  return isOnCurve(hash) ? null : hash;
}

/** The first bump (255 down to 0) whose derived address is off the curve. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: Uint8Array): { address: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const address = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (address !== null) return { address, bump };
  }
  throw new Error("sol-tx: no viable bump seed");
}
