// SPDX-License-Identifier: MIT
//
// `bip322`: proof-of-control for a `btc-htlc` pubkey line (handoff/P7-ACCOUNT-PROOF-SPEC.md).
// BIP-322 "simple" signature (https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki) for
// the P2WPKH address of the line's compressed pubkey, over the account-proof message.
//
//   message_hash = tagged sha256 "BIP0322-signed-message" of the UTF-8 message
//   to_spend     = tx v0, locktime 0; one input (prevout 000..0:0xFFFFFFFF, sequence 0,
//                  scriptSig = OP_0 PUSH32 message_hash); one output (value 0, scriptPubKey =
//                  the P2WPKH script of the pubkey)
//   to_sign      = tx v0, locktime 0; one input (prevout to_spend:0, sequence 0); one output
//                  (value 0, OP_RETURN)
//   signature    = base64 of the consensus-serialized witness stack [<DER sig || 0x01>, <pubkey>]
//                  that spends to_spend:0 in to_sign (BIP-143 sighash, SIGHASH_ALL)
//
// Signing is keyless, exactly like the leg's own writes: the node's wallet signs the PSBT of
// `to_sign` with `walletprocesspsbt` (`bip322ProofPsbt`, `bip322WitnessFromSignedTx`); this file
// never sees a private key. Verification is pure and needs only the pubkey: the address a P2WPKH
// script pays to is a hash of that pubkey, so the proof shows control of the key behind the
// line's pubkey without consulting any chain. The network does not enter (an address's HRP is not
// part of the script). Only the simple format for P2WPKH is accepted (no "full" format, no other
// script types, no other sighash types): anything else does not verify.
//
// The BIP-322 test vectors (the bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l key, messages "" and
// "Hello World") are pinned in tests/btc-proof.test.ts.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { RawWitness, Transaction } from "@scure/btc-signer";

import type { AccountProofVerifier } from "./account-proof.js";

const PUBKEY_SHAPE = /^0[23][0-9a-f]{64}$/;
const SIGHASH_ALL = 1;

function dsha256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

/** BIP-340-style tagged hash with the BIP-322 tag. */
export function bip322MessageHash(message: string): Uint8Array {
  const tag = sha256(new TextEncoder().encode("BIP0322-signed-message"));
  return sha256(concatBytes(tag, tag, new TextEncoder().encode(message)));
}

function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

/** The P2WPKH scriptPubKey of a compressed pubkey: `OP_0 PUSH20 hash160(pubkey)`. */
export function p2wpkhScript(pubkey: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));
}

/** The BIP-143 scriptCode of a P2WPKH input: the P2PKH script of the same key hash. */
function p2wpkhScriptCode(pubkey: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(pubkey), new Uint8Array([0x88, 0xac]));
}

/** `to_spend` of BIP-322 for this message and scriptPubKey, non-witness serialization; `txid` is
 *  the displayed (reversed) id, which is also what `Transaction.addInput({ txid })` takes. */
export function bip322ToSpend(message: string, scriptPubKey: Uint8Array): { raw: Uint8Array; txid: string } {
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), bip322MessageHash(message));
  const raw = concatBytes(
    new Uint8Array([0, 0, 0, 0]), // version 0
    new Uint8Array([1]), // one input
    new Uint8Array(32), // prevout txid: all zeros
    new Uint8Array([0xff, 0xff, 0xff, 0xff]), // prevout index 0xFFFFFFFF
    new Uint8Array([scriptSig.length]),
    scriptSig,
    new Uint8Array([0, 0, 0, 0]), // sequence 0
    new Uint8Array([1]), // one output
    new Uint8Array(8), // value 0
    new Uint8Array([scriptPubKey.length]),
    scriptPubKey,
    new Uint8Array(4), // locktime 0
  );
  return { raw, txid: bytesToHex(dsha256(raw).reverse()) };
}

function buildToSign(message: string, pubkey: Uint8Array): Transaction {
  const script = p2wpkhScript(pubkey);
  const toSpend = bip322ToSpend(message, script);
  const tx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  tx.addInput({ txid: toSpend.txid, index: 0, sequence: 0, witnessUtxo: { script, amount: 0n } });
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n }); // OP_RETURN
  return tx;
}

/** The BIP-322 txids for a message and pubkey (the BIP's own test vectors list them). */
export function bip322Txids(message: string, pubkeyHex: string): { toSpend: string; toSign: string } {
  const pubkey = hexToBytes(pubkeyHex);
  return {
    toSpend: bip322ToSpend(message, p2wpkhScript(pubkey)).txid,
    toSign: buildToSign(message, pubkey).id,
  };
}

/**
 * The PSBT (base64) of `to_sign` for the node's wallet to sign: `witness_utxo` (amount 0, the
 * P2WPKH script) and the wallet key's own BIP32 derivation so `walletprocesspsbt` finds its key.
 * Keyless: public data only.
 */
export function bip322ProofPsbt(
  message: string,
  pubkeyHex: string,
  derivation: { fingerprint: number; path: readonly number[] },
): string {
  if (!PUBKEY_SHAPE.test(pubkeyHex)) throw new Error("bip322: malformed compressed pubkey");
  const pubkey = hexToBytes(pubkeyHex);
  const script = p2wpkhScript(pubkey);
  const toSpend = bip322ToSpend(message, script);
  const tx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  tx.addInput({
    txid: toSpend.txid,
    index: 0,
    sequence: 0,
    witnessUtxo: { script, amount: 0n },
    bip32Derivation: [[pubkey, { fingerprint: derivation.fingerprint, path: [...derivation.path] }]],
  });
  tx.addOutput({ script: new Uint8Array([0x6a]), amount: 0n });
  return Buffer.from(tx.toPSBT()).toString("base64");
}

/** From the finalized transaction the wallet returned (`walletprocesspsbt`'s `hex`), the BIP-322
 *  simple signature: base64 of the input's consensus-serialized witness stack. */
export function bip322WitnessFromSignedTx(hex: string): string {
  const tx = Transaction.fromRaw(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
  const witness = tx.getInput(0).finalScriptWitness;
  if (witness === undefined || witness.length === 0) throw new Error("bip322: the signed transaction has no witness");
  return Buffer.from(RawWitness.encode(witness)).toString("base64");
}

/** `bip322`: a BIP-322 simple signature (base64 witness stack) for the P2WPKH address of the
 *  pubkey the line names (`subject`: 33-byte compressed pubkey hex), over `ctx.message`. */
export const bip322Verifier: AccountProofVerifier = {
  scheme: "bip322",
  verify(ctx) {
    try {
      if (ctx.proof.publicKey !== undefined) return false; // the line's own pubkey is the key
      if (!PUBKEY_SHAPE.test(ctx.subject)) return false;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(ctx.proof.signature)) return false;
      const raw = Uint8Array.from(Buffer.from(ctx.proof.signature, "base64"));
      // Canonical base64 only: a re-encode must give the same token back.
      if (Buffer.from(raw).toString("base64") !== ctx.proof.signature) return false;
      const witness = RawWitness.decode(raw);
      if (witness.length !== 2) return false;
      // Canonical witness serialization: re-encoding must reproduce the exact bytes.
      if (bytesToHex(RawWitness.encode(witness)) !== bytesToHex(raw)) return false;
      const sigWithType = witness[0]!;
      const witnessKey = witness[1]!;
      const pubkey = hexToBytes(ctx.subject);
      if (bytesToHex(witnessKey) !== ctx.subject) return false;
      if (sigWithType.length < 9 || sigWithType.at(-1) !== SIGHASH_ALL) return false;
      const digest = buildToSign(ctx.message, pubkey).preimageWitnessV0(0, p2wpkhScriptCode(pubkey), SIGHASH_ALL, 0n);
      return secp256k1.verify(sigWithType.slice(0, -1), digest, pubkey, { format: "der", prehash: false });
    } catch {
      return false;
    }
  },
};
