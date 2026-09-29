// SPDX-License-Identifier: MIT
//
// D-N1: a first-party borsh writer for the NEAR structures this leg ever sends —
// `TransactionV0` and `SignedTransaction`, plus the five action variants the HTLC
// lock/claim/refund flow needs (`CreateAccount`, `Transfer`, `AddKey` full-access,
// `DeployContract`, `FunctionCall`). No near-api-js, no `@near-js/*`, no near-workspaces, no npm
// `borsh` package — a small first-party writer per D-N1, kept deliberately narrow (only the
// structs this build ever sends; not a general-purpose borsh codec, and no deserializer).
//
// Tag values (action variants, `PublicKey`/`Signature`'s own `KeyType`, `AccessKeyPermission`)
// come straight from nearcore's own `near-primitives` enum declaration order, which borsh
// serializes as the plain 0-based index of the variant as written in the Rust source — this is
// the same convention `tests/near-borsh.test.ts` independently confirms against a real
// near-api-js fixture (see that file's header for the cited vectors).
//
// Signing: ed25519 over `sha256(borsh(tx))` (`@noble/curves/ed25519`, `@noble/hashes/sha2`) —
// the NEAR transaction hash this build records everywhere (D-N4) is exactly that sha256, base58
// encoded (`@scure/base`).
//
// Design source: flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md D-N1;
// flop-contrib/handoff/P5-NEAR-SPEC.md §3/§4;
// flop-contrib/handoff/research/near-rpc-and-signing-2026-09-29.md.

import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/**
 * A minimal growable byte writer — u8/u32/u64/u128 little-endian, u32-length-prefixed strings
 * and byte vectors, and raw fixed-length byte blocks (a public key, a hash, a signature). Every
 * numeric writer takes `number | bigint` and always emits the fixed width borsh defines for that
 * type (u32: 4 bytes; u64/u128: 8/16 bytes) regardless of the value's own magnitude — never a
 * variable-length encoding.
 */
export class BorshWriter {
  private readonly chunks: Uint8Array[] = [];

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
  }

  writeU8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error(`near-borsh: u8 out of range: ${value}`);
    }
    this.push(Uint8Array.of(value));
  }

  writeU32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`near-borsh: u32 out of range: ${value}`);
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.push(bytes);
  }

  writeU64(value: number | bigint): void {
    const v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error(`near-borsh: u64 out of range: ${v}`);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, v, true);
    this.push(bytes);
  }

  writeU128(value: number | bigint): void {
    const v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n || v > (1n << 128n) - 1n) throw new Error(`near-borsh: u128 out of range: ${v}`);
    const bytes = new Uint8Array(16);
    let x = v;
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.push(bytes);
  }

  /** Raw fixed-length bytes, no length prefix — a public key, a hash, a signature. */
  writeBytes(bytes: Uint8Array): void {
    this.push(bytes);
  }

  /** borsh's `Vec<u8>` shape: a u32 length prefix, then the raw bytes — a contract's `code`, a
   *  function call's `args`. Never used for a fixed-length field (a pubkey, a hash): those go
   *  through `writeBytes` alone. */
  writeByteVec(bytes: Uint8Array): void {
    this.writeU32(bytes.length);
    this.push(bytes);
  }

  writeString(value: string): void {
    this.writeByteVec(new TextEncoder().encode(value));
  }

  toBytes(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Only ED25519 (nearcore's `KeyType::ED25519 = 0`) — this build never uses a secp256k1 NEAR
 *  key. */
export interface Ed25519PublicKey {
  keyType: "ED25519";
  /** 32 bytes, raw (not base58/base64-encoded). */
  data: Uint8Array;
}

export interface Ed25519Signature {
  keyType: "ED25519";
  /** 64 bytes, raw. */
  data: Uint8Array;
}

function writePublicKey(w: BorshWriter, key: Ed25519PublicKey): void {
  if (key.data.length !== 32) throw new Error("near-borsh: ed25519 public key must be exactly 32 bytes");
  w.writeU8(0); // KeyType::ED25519
  w.writeBytes(key.data);
}

function writeSignature(w: BorshWriter, sig: Ed25519Signature): void {
  if (sig.data.length !== 64) throw new Error("near-borsh: ed25519 signature must be exactly 64 bytes");
  w.writeU8(0); // Signature::ED25519
  w.writeBytes(sig.data);
}

/**
 * The six `Action` variants this build ever constructs — nearcore's own `Action` enum has more
 * (Stake, DeleteAccount, the meta-tx Delegate action, …); none of those are needed here, so none
 * are implemented (an attempt to write one that isn't in this union is a compile-time error, not
 * a silent wrong tag). Tags below are the plain declaration-order index of each variant
 * nearcore's own `Action` enum uses (`CreateAccount = 0`, `DeployContract = 1`, `FunctionCall =
 * 2`, `Transfer = 3`, `Stake = 4` [unused here], `AddKey = 5`, `DeleteKey = 6`).
 *
 * H6: `DeleteKey` is the harness's own tool for locking a deployed contract account down to zero
 * access keys after setup finishes (`tests-near/helpers/sandbox.ts`) — never used by the rail
 * itself (`near-htlc.ts` never deletes a key), only by the test harness driving the sandbox.
 */
export type NearAction =
  | { type: "CreateAccount" }
  | { type: "DeployContract"; code: Uint8Array }
  | { type: "FunctionCall"; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { type: "Transfer"; deposit: bigint }
  | { type: "AddKey"; publicKey: Ed25519PublicKey; nonce: bigint; permission: "FullAccess" }
  | { type: "DeleteKey"; publicKey: Ed25519PublicKey };

function writeAction(w: BorshWriter, action: NearAction): void {
  switch (action.type) {
    case "CreateAccount":
      w.writeU8(0);
      return;
    case "DeployContract":
      w.writeU8(1);
      w.writeByteVec(action.code);
      return;
    case "FunctionCall":
      w.writeU8(2);
      w.writeString(action.methodName);
      w.writeByteVec(action.args);
      w.writeU64(action.gas);
      w.writeU128(action.deposit);
      return;
    case "Transfer":
      w.writeU8(3);
      w.writeU128(action.deposit);
      return;
    case "AddKey":
      w.writeU8(5);
      writePublicKey(w, action.publicKey);
      w.writeU64(action.nonce);
      // AccessKeyPermission::FunctionCall = 0 (unused here), FullAccess = 1.
      w.writeU8(1);
      return;
    case "DeleteKey":
      w.writeU8(6);
      writePublicKey(w, action.publicKey);
      return;
    default: {
      // Exhaustiveness guard — a new NearAction variant that forgets to extend this switch fails
      // to compile, rather than silently writing nothing.
      const _never: never = action;
      throw new Error(`near-borsh: unhandled action type ${JSON.stringify(_never)}`);
    }
  }
}

/** nearcore's `TransactionV0` — the pre-priority-fee transaction shape this build always uses
 *  (D-N1/D-N11); never wrapped in the newer `Transaction` enum's own variant tag (confirmed
 *  against a real near-api-js fixture — see `tests/near-borsh.test.ts`). */
export interface NearTransactionV0 {
  signerId: string;
  publicKey: Ed25519PublicKey;
  nonce: bigint;
  receiverId: string;
  /** 32 bytes, raw. */
  blockHash: Uint8Array;
  actions: readonly NearAction[];
}

export function encodeTransactionV0(tx: NearTransactionV0): Uint8Array {
  if (tx.blockHash.length !== 32) throw new Error("near-borsh: blockHash must be exactly 32 bytes");
  const w = new BorshWriter();
  w.writeString(tx.signerId);
  writePublicKey(w, tx.publicKey);
  w.writeU64(tx.nonce);
  w.writeString(tx.receiverId);
  w.writeBytes(tx.blockHash);
  w.writeU32(tx.actions.length);
  for (const action of tx.actions) writeAction(w, action);
  return w.toBytes();
}

export interface NearSignedTransaction {
  transaction: NearTransactionV0;
  signature: Ed25519Signature;
}

/** `SignedTransaction { transaction: TransactionV0 (bare, no enum wrapper), signature }` —
 *  confirmed against a real near-api-js roundtrip fixture (`tests/near-borsh.test.ts`): the
 *  transaction's own bytes are written first, with no length prefix and no enum tag in front of
 *  them, immediately followed by the signature. */
export function encodeSignedTransaction(signed: NearSignedTransaction): Uint8Array {
  const txBytes = encodeTransactionV0(signed.transaction);
  const w = new BorshWriter();
  w.writeBytes(txBytes);
  writeSignature(w, signed.signature);
  return w.toBytes();
}

/** D-N4: "tx hash = sha256(borsh(tx))" — the value this build records everywhere (`prepareLock`/
 *  `commitLock`/`claim`/`refund`'s own `txHash`, `recoverByTxHash`'s lookup key) before ever
 *  broadcasting. */
export function transactionHashBytes(tx: NearTransactionV0): Uint8Array {
  return sha256(encodeTransactionV0(tx));
}

export interface BuiltSignedTransaction {
  signed: NearSignedTransaction;
  /** The unsigned transaction's own borsh bytes (what `hash` is a sha256 of). */
  txBytes: Uint8Array;
  /** sha256(txBytes), raw. */
  hash: Uint8Array;
  /** The full `SignedTransaction` borsh bytes — what a caller base64-encodes for `send_tx`. */
  signedBytes: Uint8Array;
  /** D-N4's own recorded form: base58 of `hash`. */
  txHashBase58: string;
}

/**
 * D-N1/D-N4: "sign-and-record, then broadcast" — builds the unsigned transaction's borsh bytes,
 * hashes them, hands the hash to `sign` (never the raw tx bytes — NEAR signs the sha256, not the
 * message directly), and returns everything a caller needs to record BEFORE ever sending
 * anything: the recoverable `txHashBase58` (`recoverByTxHash`'s lookup key) and the exact
 * `signedBytes` to broadcast. `sign` may be sync or async (an in-memory signer is sync; a future
 * remote/hardware one would not be).
 */
export async function buildSignedTransaction(
  tx: NearTransactionV0,
  sign: (hash: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<BuiltSignedTransaction> {
  const txBytes = encodeTransactionV0(tx);
  const hash = sha256(txBytes);
  const signatureData = await sign(hash);
  if (signatureData.length !== 64) {
    throw new Error("near-borsh: signer must return a 64-byte ed25519 signature");
  }
  const signed: NearSignedTransaction = { transaction: tx, signature: { keyType: "ED25519", data: signatureData } };
  const signedBytes = encodeSignedTransaction(signed);
  return { signed, txBytes, hash, signedBytes, txHashBase58: base58.encode(hash) };
}
