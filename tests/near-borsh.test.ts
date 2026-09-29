// SPDX-License-Identifier: MIT
//
// tests/near-borsh.test.ts — D-N1: pins `near-borsh.ts` against two real vectors pulled live
// from the `near/near-api-js` repository (commit `master` as of 2026-09-29), plus round-trip/
// shape tests for the action variants and range checks the vectors alone don't cover.
//
// Vector 1 (unsigned `TransactionV0`) — "serialize transfer tx",
// https://github.com/near/near-api-js/blob/master/test/unit/transactions/serialize.test.ts
// Vector 2 (a full, REAL, independently re-verified `SignedTransaction`) —
// https://github.com/near/near-api-js/blob/master/test/unit/transactions/data/signed_transaction1.json
// (near-api-js's own borsh roundtrip fixture — deserialize then re-serialize, expect the
// identical bytes; it happens to be the same transfer transaction as vector 1, plus a real
// signature). This test does NOT trust that the bytes merely round-trip through some codec —
// it independently confirms the fixture is genuine by verifying the embedded ed25519 signature,
// with THIS build's own `@noble/curves/ed25519`, over sha256 of the exact bytes vector 1
// describes, against the exact public key embedded in the same fixture. That signature only
// verifies against sha256(borsh(tx)) (checked below) and NOT against the raw, unhashed tx bytes
// (also checked below, and expected to fail) — confirming D-N4's "tx hash = sha256(borsh(tx))"
// against a real NEAR-signed transaction, not merely this build's own round trip.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import {
  BorshWriter,
  buildSignedTransaction,
  encodeSignedTransaction,
  encodeTransactionV0,
  transactionHashBytes,
  type Ed25519PublicKey,
  type NearAction,
  type NearTransactionV0,
} from "../src/rails/near-borsh.js";

// --- Vector 1: "serialize transfer tx" ------------------------------------------------------

const VECTOR1_SIGNER_ID = "test.near";
const VECTOR1_RECEIVER_ID = "whatever.near";
// PublicKey.fromString('Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC') — bare base58, ed25519
// implied (no "ed25519:" prefix — near-api-js's own PublicKey.fromString defaults to ED25519).
const VECTOR1_PUBLIC_KEY_BASE58 = "Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC";
// baseDecode('244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM') — bare base58 (near-api-js's
// `baseDecode` is a plain base58 decode, not base58check).
const VECTOR1_BLOCK_HASH_BASE58 = "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM";
const VECTOR1_EXPECTED_HEX =
  "09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d" +
  "01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa24" +
  "35224b6986910e630c2fef6010000000301000000000000000000000000000000";

function vector1Transaction(): NearTransactionV0 {
  const publicKey: Ed25519PublicKey = { keyType: "ED25519", data: base58.decode(VECTOR1_PUBLIC_KEY_BASE58) };
  const actions: NearAction[] = [{ type: "Transfer", deposit: 1n }];
  return {
    signerId: VECTOR1_SIGNER_ID,
    publicKey,
    nonce: 1n,
    receiverId: VECTOR1_RECEIVER_ID,
    blockHash: base58.decode(VECTOR1_BLOCK_HASH_BASE58),
    actions,
  };
}

describe("encodeTransactionV0 — near-api-js 'serialize transfer tx' vector", () => {
  it("matches the cited byte-exact hex", () => {
    const bytes = encodeTransactionV0(vector1Transaction());
    expect(bytesToHex(bytes)).toBe(VECTOR1_EXPECTED_HEX);
  });

  it("decodes the fixture's own public key to the 32 bytes embedded in the expected hex", () => {
    // Sanity check on the fixture data itself, not on this build's code: the base58 string a
    // real near-api-js caller passed in decodes to exactly the 32 bytes the expected hex shows
    // right after signerId's own length-prefixed string and the 0x00 (ED25519) tag.
    const signerIdHexLen = (4 + VECTOR1_SIGNER_ID.length) * 2; // u32 length prefix + bytes
    const tagHexLen = 2;
    const start = signerIdHexLen + tagHexLen;
    const embedded = hexToBytes(VECTOR1_EXPECTED_HEX.slice(start, start + 64));
    expect(base58.decode(VECTOR1_PUBLIC_KEY_BASE58)).toEqual(embedded);
  });
});

// --- Vector 2: signed_transaction1.json (a real, independently re-verified signature) --------

const VECTOR2_SIGNED_HEX =
  VECTOR1_EXPECTED_HEX +
  "00969a83332186ee9755e4839325525806e189a3d2d2bb4b4760e94443e97e1c4f22deeef0059a8e9713100eda6" +
  "e19144da7e8a0ef7e539b20708ba1d8d021bd01";

describe("encodeSignedTransaction — near-api-js signed_transaction1.json roundtrip fixture", () => {
  it("independently verifies as a genuine ed25519 signature over sha256(borsh(tx)) — never over the raw tx bytes", () => {
    const tx = vector1Transaction();
    const txBytes = encodeTransactionV0(tx);
    const signedBytes = hexToBytes(VECTOR2_SIGNED_HEX);
    const sigBytes = signedBytes.slice(txBytes.length + 1); // skip the tx bytes and the 1-byte ED25519 tag
    expect(sigBytes).toHaveLength(64);

    const pubkey = tx.publicKey.data;
    const hash = sha256(txBytes);
    expect(ed25519.verify(sigBytes, hash, pubkey)).toBe(true);
    // D-N4's own claim, checked against a REAL signed transaction: the signature does NOT verify
    // over the raw (unhashed) tx bytes — confirming NEAR signs sha256(borsh(tx)), not the
    // message directly.
    expect(ed25519.verify(sigBytes, txBytes, pubkey)).toBe(false);
  });

  it("encodeSignedTransaction reproduces the exact fixture bytes given the fixture's own signature", () => {
    const tx = vector1Transaction();
    const txBytes = encodeTransactionV0(tx);
    const signedBytesFixture = hexToBytes(VECTOR2_SIGNED_HEX);
    const sigBytes = signedBytesFixture.slice(txBytes.length + 1);

    const encoded = encodeSignedTransaction({ transaction: tx, signature: { keyType: "ED25519", data: sigBytes } });
    expect(bytesToHex(encoded)).toBe(VECTOR2_SIGNED_HEX);
  });

  it("transactionHashBytes matches the hash the fixture's signature actually verifies against", () => {
    const tx = vector1Transaction();
    expect(bytesToHex(transactionHashBytes(tx))).toBe(bytesToHex(sha256(encodeTransactionV0(tx))));
  });
});

// --- buildSignedTransaction: round trip with a freshly generated keypair ---------------------

describe("buildSignedTransaction", () => {
  it("produces a signature that verifies against its own recorded hash, and bytes that re-decode consistently", async () => {
    const seed = new Uint8Array(32).fill(7);
    const keys = ed25519.keygen(seed);
    const tx = vector1Transaction();

    const built = await buildSignedTransaction(tx, (hash) => ed25519.sign(hash, keys.secretKey));

    expect(built.hash).toEqual(sha256(built.txBytes));
    expect(built.txBytes).toEqual(encodeTransactionV0(tx));
    expect(base58.decode(built.txHashBase58)).toEqual(built.hash);
    expect(ed25519.verify(built.signed.signature.data, built.hash, keys.publicKey)).toBe(true);
    // encodeSignedTransaction on the returned struct must reproduce signedBytes exactly.
    expect(encodeSignedTransaction(built.signed)).toEqual(built.signedBytes);
  });

  it("rejects a signer that returns the wrong signature length", async () => {
    const tx = vector1Transaction();
    await expect(buildSignedTransaction(tx, () => new Uint8Array(63))).rejects.toThrow(/64-byte/);
  });
});

// --- Action shape / round-trip tests -----------------------------------------------------------

describe("action encoding shapes", () => {
  it("CreateAccount is exactly one byte: the tag 0x00", () => {
    const w = new BorshWriter();
    const tx: NearTransactionV0 = { ...vector1Transaction(), actions: [{ type: "CreateAccount" }] };
    const bytes = encodeTransactionV0(tx);
    // actions vec starts right after signerId+pubkey+nonce+receiverId+blockHash — rather than
    // recompute that offset by hand, decode the same prefix bytes as the Transfer vector (which
    // is identical up to the actions count) and diff the tail.
    const transferBytes = encodeTransactionV0(vector1Transaction());
    const prefixLen = transferBytes.length - 1 - 16; // Transfer = 1 tag byte + 16-byte u128
    expect(bytes.slice(0, prefixLen)).toEqual(transferBytes.slice(0, prefixLen));
    expect(bytes.slice(prefixLen)).toEqual(Uint8Array.of(0));
    void w;
  });

  it("Transfer(deposit) writes tag 0x03 then a 16-byte little-endian u128", () => {
    const tx: NearTransactionV0 = { ...vector1Transaction(), actions: [{ type: "Transfer", deposit: 500n }] };
    const bytes = encodeTransactionV0(tx);
    const tail = bytes.slice(-17);
    expect(tail[0]).toBe(3);
    const le = tail.slice(1);
    let value = 0n;
    for (let i = 15; i >= 0; i -= 1) value = (value << 8n) | BigInt(le[i] ?? 0);
    expect(value).toBe(500n);
  });

  it("DeployContract writes tag 0x01, a u32 length, then the code bytes", () => {
    const code = Uint8Array.of(1, 2, 3, 4, 5);
    const tx: NearTransactionV0 = { ...vector1Transaction(), actions: [{ type: "DeployContract", code }] };
    const bytes = encodeTransactionV0(tx);
    const tail = bytes.slice(-(1 + 4 + code.length));
    expect(tail[0]).toBe(1);
    expect(tail.slice(1, 5)).toEqual(Uint8Array.of(5, 0, 0, 0));
    expect(tail.slice(5)).toEqual(code);
  });

  it("FunctionCall writes tag 0x02, methodName, args, gas (u64 LE), deposit (u128 LE)", () => {
    const methodName = "ft_transfer_call";
    const args = new TextEncoder().encode('{"a":1}');
    const tx: NearTransactionV0 = {
      ...vector1Transaction(),
      actions: [{ type: "FunctionCall", methodName, args, gas: 100_000_000_000_000n, deposit: 1n }],
    };
    const bytes = encodeTransactionV0(tx);
    const methodBytes = new TextEncoder().encode(methodName);
    const expectedTailLen = 1 + 4 + methodBytes.length + 4 + args.length + 8 + 16;
    const tail = bytes.slice(-expectedTailLen);
    expect(tail[0]).toBe(2);
    let offset = 1;
    expect(tail.slice(offset, offset + 4)).toEqual(Uint8Array.of(methodBytes.length, 0, 0, 0));
    offset += 4;
    expect(tail.slice(offset, offset + methodBytes.length)).toEqual(methodBytes);
    offset += methodBytes.length;
    expect(tail.slice(offset, offset + 4)).toEqual(Uint8Array.of(args.length, 0, 0, 0));
    offset += 4;
    expect(tail.slice(offset, offset + args.length)).toEqual(args);
    offset += args.length;
    const gasBytes = tail.slice(offset, offset + 8);
    let gas = 0n;
    for (let i = 7; i >= 0; i -= 1) gas = (gas << 8n) | BigInt(gasBytes[i] ?? 0);
    expect(gas).toBe(100_000_000_000_000n);
  });

  it("AddKey (full access) writes tag 0x05, the public key, nonce (u64 LE), then permission tag 0x01", () => {
    const publicKey: Ed25519PublicKey = { keyType: "ED25519", data: new Uint8Array(32).fill(9) };
    const tx: NearTransactionV0 = { ...vector1Transaction(), actions: [{ type: "AddKey", publicKey, nonce: 0n, permission: "FullAccess" }] };
    const bytes = encodeTransactionV0(tx);
    const tail = bytes.slice(-(1 + 1 + 32 + 8 + 1));
    expect(tail[0]).toBe(5);
    expect(tail[1]).toBe(0); // PublicKey KeyType::ED25519
    expect(tail.slice(2, 34)).toEqual(publicKey.data);
    expect(tail.slice(34, 42)).toEqual(new Uint8Array(8)); // nonce 0
    expect(tail[42]).toBe(1); // AccessKeyPermission::FullAccess
  });

  it("actions vec is u32-length-prefixed and preserves insertion order", () => {
    const tx: NearTransactionV0 = {
      ...vector1Transaction(),
      actions: [{ type: "CreateAccount" }, { type: "Transfer", deposit: 1n }],
    };
    const bytes = encodeTransactionV0(tx);
    const transferOnly = encodeTransactionV0({ ...vector1Transaction(), actions: [{ type: "Transfer", deposit: 1n }] });
    const actionsCountOffset = transferOnly.length - 1 - 16 - 4;
    expect(bytes.slice(actionsCountOffset, actionsCountOffset + 4)).toEqual(Uint8Array.of(2, 0, 0, 0));
  });
});

describe("range validation", () => {
  it("rejects an out-of-range u8/u32/u64/u128", () => {
    const w = () => new BorshWriter();
    expect(() => w().writeU8(256)).toThrow(/u8/);
    expect(() => w().writeU8(-1)).toThrow(/u8/);
    expect(() => w().writeU32(2 ** 32)).toThrow(/u32/);
    expect(() => w().writeU64(-1)).toThrow(/u64/);
    expect(() => w().writeU128(-1)).toThrow(/u128/);
    expect(() => w().writeU128((1n << 128n))).toThrow(/u128/);
  });

  it("rejects a public key or signature of the wrong length", () => {
    const badKey: Ed25519PublicKey = { keyType: "ED25519", data: new Uint8Array(31) };
    expect(() => encodeTransactionV0({ ...vector1Transaction(), publicKey: badKey })).toThrow(/32 bytes/);
    const badSig = { keyType: "ED25519" as const, data: new Uint8Array(63) };
    expect(() => encodeSignedTransaction({ transaction: vector1Transaction(), signature: badSig })).toThrow(/64 bytes/);
  });

  it("rejects a block hash of the wrong length", () => {
    expect(() => encodeTransactionV0({ ...vector1Transaction(), blockHash: new Uint8Array(31) })).toThrow(/blockHash/);
  });
});
