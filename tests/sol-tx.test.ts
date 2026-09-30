// SPDX-License-Identifier: MIT
//
// tests/sol-tx.test.ts - the first-party Solana legacy-transaction codec against PUBLIC vectors.
//
// Sources (all public, all crates.io packages of Anza's Solana SDK; source repository
// https://github.com/anza-xyz/solana-sdk, and https://github.com/anza-xyz/agave for the short-vec crate):
//   - solana-short-vec 3.3.0, src/lib.rs: `test_short_vec_encode_len`, `test_deserialize` (the shortvec
//     encodings and the strict-decode refusals below are copied from those tests),
//   - solana-transaction 4.3.0, src/lib.rs: `create_sample_transaction` + `test_sdk_serialize` (a complete
//     serialized signed legacy transaction; the SDK's own comment: "Detect binary changes in the serialized
//     transaction data, which could have a downstream affect on SDKs and applications"),
//   - solana-address 2.8.0, src/lib.rs: `test_create_program_address` (program-derived address vectors).
// No private key literal appears here: the sample transaction's signature is checked against the PUBLIC
// key that is its fee payer (account 0 of the message).

import { describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

import {
  compileLegacyMessage,
  createProgramAddress,
  decodeLegacyMessage,
  decodeShortvec,
  decodeTransaction,
  encodeShortvec,
  encodeTransaction,
  findProgramAddress,
  isOnCurve,
  isValidPubkeyBase58,
  pubkeyFromBase58,
  pubkeyToBase58,
  signTransaction,
  verifyTransactionSignatures,
  type SolTxSigner,
} from "../src/rails/sol-tx.js";

// solana-transaction 4.3.0 test_sdk_serialize's expected bytes, verbatim.
const SAMPLE_TX = Uint8Array.from([
  1, 120, 138, 162, 185, 59, 209, 241, 157, 71, 157, 74, 131, 4, 87, 54, 28, 38, 180, 222, 82, 64, 62, 61, 62, 22, 46, 17, 203, 187, 136, 62, 43, 11,
  38, 235, 17, 239, 82, 240, 139, 130, 217, 227, 214, 9, 242, 141, 223, 94, 29, 184, 110, 62, 32, 87, 137, 63, 139, 100, 221, 20, 137, 4, 5, 1, 0, 1,
  3, 36, 100, 158, 252, 33, 161, 97, 185, 62, 89, 99, 195, 250, 249, 187, 189, 171, 118, 241, 90, 248, 14, 68, 219, 231, 62, 157, 5, 142, 27, 210,
  117, 1, 1, 1, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 8, 7, 6, 5, 4, 1, 1, 1, 2, 2, 2, 4, 5, 6, 7, 8, 9, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 9, 8, 7, 6, 5, 4, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  2, 2, 0, 1, 3, 1, 2, 3,
]);

// create_sample_transaction's public inputs: the fee payer's PUBLIC key (the second half of the SDK's test
// keypair; the secret half is deliberately not reproduced), the `to` account, the program id, the data.
const PAYER = Uint8Array.from([36, 100, 158, 252, 33, 161, 97, 185, 62, 89, 99, 195, 250, 249, 187, 189, 171, 118, 241, 90, 248, 14, 68, 219, 231, 62, 157, 5, 142, 27, 210, 117]);
const TO = Uint8Array.from([1, 1, 1, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 8, 7, 6, 5, 4, 1, 1, 1]);
const PROGRAM = Uint8Array.from([2, 2, 2, 4, 5, 6, 7, 8, 9, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 8, 7, 6, 5, 4, 2, 2, 2]);
const ZERO_HASH = new Uint8Array(32);

function sampleMessage() {
  return compileLegacyMessage({
    feePayer: PAYER,
    recentBlockhash: ZERO_HASH,
    instructions: [
      {
        programId: PROGRAM,
        accounts: [
          { pubkey: PAYER, isSigner: true, isWritable: true },
          { pubkey: TO, isSigner: false, isWritable: true },
        ],
        data: Uint8Array.from([1, 2, 3]),
      },
    ],
  });
}

describe("shortvec (solana-short-vec 3.3.0 vectors)", () => {
  const encodeCases: Array<[number, number[]]> = [
    [0x0, [0x0]],
    [0x7f, [0x7f]],
    [0x80, [0x80, 0x01]],
    [0xff, [0xff, 0x01]],
    [0x100, [0x80, 0x02]],
    [0x7fff, [0xff, 0xff, 0x01]],
    [0xffff, [0xff, 0xff, 0x03]],
  ];
  for (const [value, bytes] of encodeCases) {
    it(`encodes ${value} and decodes it back`, () => {
      expect(Array.from(encodeShortvec(value))).toEqual(bytes);
      expect(decodeShortvec(Uint8Array.from(bytes), 0)).toEqual({ value, next: bytes.length });
    });
  }
  for (const [value, bytes] of [
    [0x07ff, [0xff, 0x0f]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x80, 0x80, 0x01]],
  ] as Array<[number, number[]]>) {
    it(`decodes ${value}`, () => {
      expect(decodeShortvec(Uint8Array.from(bytes), 0).value).toBe(value);
      expect(Array.from(encodeShortvec(value))).toEqual(bytes);
    });
  }
  it("refuses aliased, over-long, truncated and over-range encodings (test_deserialize's bad cases)", () => {
    const bad: number[][] = [
      [0x80, 0x00], // alias of 0
      [0x80, 0x80, 0x00],
      [0xff, 0x00], // alias of 0x7f
      [0xff, 0x80, 0x00],
      [0x80, 0x81, 0x00],
      [0xff, 0xff, 0x00],
      [0x80], // truncated
      [0x80, 0x80, 0x80, 0x00], // four bytes
      [0x80, 0x80, 0x04], // 0x10000, out of range
      [0x80, 0x80, 0x06],
    ];
    for (const bytes of bad) expect(() => decodeShortvec(Uint8Array.from(bytes), 0), JSON.stringify(bytes)).toThrow();
  });
  it("encode refuses values outside 0..65535", () => {
    expect(() => encodeShortvec(65536)).toThrow();
    expect(() => encodeShortvec(-1)).toThrow();
    expect(() => encodeShortvec(1.5)).toThrow();
  });
});

describe("legacy transaction (solana-transaction 4.3.0 test_sdk_serialize)", () => {
  it("compiles the sample message to exactly the SDK's message bytes", () => {
    const message = sampleMessage();
    expect(Array.from(message.bytes)).toEqual(Array.from(SAMPLE_TX.slice(1 + 64)));
    expect(message.header).toEqual({ numRequiredSignatures: 1, numReadonlySigned: 0, numReadonlyUnsigned: 1 });
  });

  it("decodes the SDK's serialized transaction, its signature verifies under the fee payer, and the id is the first signature in base58", () => {
    const tx = decodeTransaction(SAMPLE_TX);
    expect(tx.signatures).toHaveLength(1);
    expect(Array.from(tx.message.accountKeys[0] ?? [])).toEqual(Array.from(PAYER));
    expect(verifyTransactionSignatures(tx)).toBe(true);
    expect(tx.signature).toBe(base58.encode(SAMPLE_TX.slice(1, 65)));
    expect(tx.message.instructions).toHaveLength(1);
    expect(Array.from(tx.message.instructions[0]?.data ?? [])).toEqual([1, 2, 3]);
  });

  it("re-assembling the SDK's signature over our compiled message reproduces the SDK's bytes exactly", () => {
    const wire = encodeTransaction([SAMPLE_TX.slice(1, 65)], sampleMessage().bytes);
    expect(Array.from(wire)).toEqual(Array.from(SAMPLE_TX));
  });

  it("a flipped message byte breaks the SDK signature (the signature covers the message bytes)", () => {
    const tampered = SAMPLE_TX.slice();
    tampered[tampered.length - 1] = 4;
    expect(verifyTransactionSignatures(decodeTransaction(tampered))).toBe(false);
  });

  it("decodeLegacyMessage is strict: trailing bytes, truncation and a signature-count mismatch are refused", () => {
    const messageBytes = SAMPLE_TX.slice(65);
    expect(decodeLegacyMessage(messageBytes).instructions).toHaveLength(1);
    expect(() => decodeLegacyMessage(Uint8Array.from([...messageBytes, 0]))).toThrow(/trailing/);
    expect(() => decodeLegacyMessage(messageBytes.slice(0, messageBytes.length - 1))).toThrow();
    expect(() => decodeTransaction(Uint8Array.from([...SAMPLE_TX, 0]))).toThrow(/trailing/);
    const twoSigs = Uint8Array.from([2, ...SAMPLE_TX.slice(1, 65), ...SAMPLE_TX.slice(1, 65), ...SAMPLE_TX.slice(65)]);
    expect(() => decodeTransaction(twoSigs)).toThrow(/signature count/);
  });

  it("refuses a versioned (v0) message and out-of-range indexes", () => {
    const v0 = Uint8Array.from([0x80, ...SAMPLE_TX.slice(65)]);
    expect(() => decodeLegacyMessage(v0)).toThrow(/versioned/);
    const bad = SAMPLE_TX.slice(65);
    bad[bad.length - 6] = 9; // programIdIndex byte
    expect(() => decodeLegacyMessage(bad)).toThrow(/out of range/);
  });
});

describe("message compilation rules", () => {
  const A = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const B = Uint8Array.from({ length: 32 }, (_, i) => i + 50);
  const C = Uint8Array.from({ length: 32 }, (_, i) => i + 100);
  const P = Uint8Array.from({ length: 32 }, (_, i) => i + 150);
  const H = new Uint8Array(32).fill(7);

  it("orders accounts signer+writable, signer+readonly, writable, readonly with the fee payer first, and merges duplicate flags", () => {
    const m = compileLegacyMessage({
      feePayer: A,
      recentBlockhash: H,
      instructions: [
        {
          programId: P,
          accounts: [
            { pubkey: C, isSigner: false, isWritable: false },
            { pubkey: B, isSigner: true, isWritable: false },
            { pubkey: C, isSigner: false, isWritable: true }, // merges to writable
          ],
          data: Uint8Array.of(9),
        },
      ],
    });
    expect(m.accountKeys.map((k) => Array.from(k)[0])).toEqual([1, 50, 100, 150]);
    expect(m.header).toEqual({ numRequiredSignatures: 2, numReadonlySigned: 1, numReadonlyUnsigned: 1 });
    expect(decodeLegacyMessage(m.bytes).instructions[0]?.accountIndexes).toEqual([2, 1, 2]);
  });

  it("a program id that an instruction also lists as writable stays writable", () => {
    const m = compileLegacyMessage({
      feePayer: A,
      recentBlockhash: H,
      instructions: [{ programId: P, accounts: [{ pubkey: P, isSigner: false, isWritable: true }], data: new Uint8Array() }],
    });
    expect(m.header.numReadonlyUnsigned).toBe(0);
  });
});

describe("signTransaction", () => {
  function signerFor(seed: number): SolTxSigner & { pub: Uint8Array } {
    const keys = ed25519.keygen(new Uint8Array(32).fill(seed));
    return { pub: keys.publicKey, publicKeyBytes: keys.publicKey, sign: (m) => ed25519.sign(m, keys.secretKey) };
  }

  it("signs in account-key order, the id is the first signature, and the result decodes and verifies", async () => {
    const payer = signerFor(1);
    const other = signerFor(2);
    const m = compileLegacyMessage({
      feePayer: payer.pub,
      recentBlockhash: new Uint8Array(32).fill(3),
      instructions: [{ programId: PROGRAM, accounts: [{ pubkey: other.pub, isSigner: true, isWritable: false }], data: Uint8Array.of(1) }],
    });
    const tx = await signTransaction(m, [other, payer]); // order of the signers argument does not matter
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signature).toBe(base58.encode(tx.signatures[0] as Uint8Array));
    const back = decodeTransaction(tx.bytes);
    expect(back.signature).toBe(tx.signature);
    expect(verifyTransactionSignatures(back)).toBe(true);
    // the first signature is the fee payer's
    expect(ed25519.verify(back.signatures[0] as Uint8Array, m.bytes, payer.pub)).toBe(true);
  });

  it("refuses a missing signer, a garbage signature and an oversized transaction", async () => {
    const payer = signerFor(1);
    const m = compileLegacyMessage({ feePayer: payer.pub, recentBlockhash: new Uint8Array(32), instructions: [{ programId: PROGRAM, accounts: [], data: Uint8Array.of(1) }] });
    await expect(signTransaction(m, [])).rejects.toThrow(/no signer supplied/);
    await expect(signTransaction(m, [{ publicKeyBytes: payer.pub, sign: () => new Uint8Array(64) }])).rejects.toThrow(/does not verify/);
    await expect(signTransaction(m, [{ publicKeyBytes: payer.pub, sign: () => new Uint8Array(10) }])).rejects.toThrow(/not 64 bytes/);
    const big = compileLegacyMessage({ feePayer: payer.pub, recentBlockhash: new Uint8Array(32), instructions: [{ programId: PROGRAM, accounts: [], data: new Uint8Array(1300) }] });
    await expect(signTransaction(big, [payer])).rejects.toThrow(/1232/);
  });
});

describe("program-derived addresses (solana-address 2.8.0 test_create_program_address)", () => {
  const upgradeable = pubkeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111");
  const seedPubey = pubkeyFromBase58("SeedPubey1111111111111111111111111111111111");
  const text = (bytes: Uint8Array | null): string | null => (bytes === null ? null : pubkeyToBase58(bytes));
  const enc = new TextEncoder();

  it("matches the SDK's published derivations", () => {
    expect(text(createProgramAddress([new Uint8Array(0), Uint8Array.of(1)], upgradeable))).toBe("BwqrghZA2htAcqq8dzP1WDAhTXYTYWj7CHxF5j7TDBAe");
    expect(text(createProgramAddress([enc.encode("☉"), Uint8Array.of(0)], upgradeable))).toBe("13yWmRpaTR4r5nAktwLqMpRNr28tnVUZw26rTvPSSB19");
    expect(text(createProgramAddress([enc.encode("Talking"), enc.encode("Squirrels")], upgradeable))).toBe("2fnQrngrQT4SeLcdToJAD96phoEjNL2man2kfRLCASVk");
    expect(text(createProgramAddress([seedPubey, Uint8Array.of(1)], upgradeable))).toBe("976ymqVnfE32QFe6NfGDctSvVa36LWnvYxhU6G2232YL");
    expect(text(createProgramAddress([enc.encode("Talking")], upgradeable))).not.toBe("2fnQrngrQT4SeLcdToJAD96phoEjNL2man2kfRLCASVk");
  });

  it("refuses over-long seeds and too many seeds, and findProgramAddress agrees with createProgramAddress", () => {
    expect(() => createProgramAddress([new Uint8Array(33)], upgradeable)).toThrow(/32 bytes/);
    expect(() => createProgramAddress(Array.from({ length: 17 }, () => new Uint8Array(1)), upgradeable)).toThrow(/16 seeds/);
    const { address, bump } = findProgramAddress([enc.encode("Lil'"), enc.encode("Bits")], upgradeable);
    expect(Array.from(createProgramAddress([enc.encode("Lil'"), enc.encode("Bits"), Uint8Array.of(bump)], upgradeable) ?? [])).toEqual(Array.from(address));
    expect(isOnCurve(address)).toBe(false);
  });

  it("isOnCurve: a real public key is on the curve, a derived address never is", () => {
    expect(isOnCurve(PAYER)).toBe(true);
    expect(isOnCurve(ed25519.keygen(new Uint8Array(32).fill(5)).publicKey)).toBe(true);
    expect(isOnCurve(sha256(Uint8Array.of(1)).slice(0, 31))).toBe(false); // wrong length
  });
});

describe("base58 public keys", () => {
  it("accepts only the canonical 32-byte spelling", () => {
    const system = "11111111111111111111111111111111";
    expect(Array.from(pubkeyFromBase58(system))).toEqual(new Array(32).fill(0));
    expect(isValidPubkeyBase58(system)).toBe(true);
    expect(isValidPubkeyBase58("1111111111111111111111111111111")).toBe(false); // 31 bytes
    expect(isValidPubkeyBase58("0OIl" + "1".repeat(30))).toBe(false); // characters outside the alphabet
    expect(isValidPubkeyBase58(42)).toBe(false);
    expect(() => pubkeyToBase58(new Uint8Array(31))).toThrow();
  });
});
