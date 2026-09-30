// SPDX-License-Identifier: MIT
//
// `nep413`: proof-of-control for a `near-htlc` account line (handoff/P7-ACCOUNT-PROOF-SPEC.md).
// NEP-413, the NEAR message-signing standard (https://github.com/near/NEPs/blob/master/neps/nep-0413.md):
//
//   payload   = Borsh{ message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }
//   signed    = ed25519( sha256( Borsh(u32 2^31 + 413) || Borsh(payload) ) )
//
// The standard's nonce is caller-chosen. Here it is sha256 of the account-proof message (the
// message already binds DID, contract, rail and account, so this is unique per tuple and a
// wallet that lets the app pick the nonce can produce the same signature), the recipient is
// the constant `NEP413_RECIPIENT`, and callbackUrl is None.
//
// Line: `proof nep413:<128 lowercase hex, the raw 64-byte ed25519 signature> ed25519:<base58 public key>`.
//
// What this verifier proves: that the holder of the key named on the line signed this exact
// message. What it cannot prove alone: that the key belongs to the account. That is chain state,
// read at the same finalized block as the rest of the NEAR evidence (`view_access_key(account,
// public_key)`, required to be a FullAccess key, in `src/rails/near-evidence.ts`). A line whose
// key is not a full-access key of the account at that block never verifies the lock.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

import type { AccountProof, AccountProofVerifier } from "./account-proof.js";

/** NEP-413 tag: 2^31 + 413, a Borsh u32. */
export const NEP413_TAG = 2_147_484_061;
/** The fixed recipient field of the payload. */
export const NEP413_RECIPIENT = "flop-swap-desk";

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concatBytes(u32le(bytes.length), bytes);
}

/** The 32 bytes a NEP-413 signer signs for this message. */
export function nep413SignedHash(message: string): Uint8Array {
  const nonce = sha256(new TextEncoder().encode(message));
  const payload = concatBytes(
    borshString(message),
    nonce,
    borshString(NEP413_RECIPIENT),
    new Uint8Array([0]), // callbackUrl: None
  );
  return sha256(concatBytes(u32le(NEP413_TAG), payload));
}

/** Decode `ed25519:<base58>` to its 32 raw bytes, or null. */
export function decodeNearEd25519Key(key: string): Uint8Array | null {
  if (!key.startsWith("ed25519:")) return null;
  try {
    const bytes = base58.decode(key.slice("ed25519:".length));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** Sign `message` (the account-proof message) with an in-memory NEAR key: the `AccountProof` a
 *  `near-htlc` line carries. `signer.sign` is the only thing touched; no key leaves it. */
export async function signNep413(
  signer: { readonly publicKey: string; sign(message: Uint8Array): Uint8Array | Promise<Uint8Array> },
  message: string,
): Promise<AccountProof> {
  const signature = await signer.sign(nep413SignedHash(message));
  if (signature.length !== 64) throw new Error("nep413: the signer did not return a 64-byte ed25519 signature");
  return { scheme: "nep413", signature: bytesToHex(signature), publicKey: signer.publicKey };
}

/** `nep413`: checks the signature against the key on the line. Does NOT decide that the key
 *  controls the account (see the header): the evidence reader does. */
export const nep413Verifier: AccountProofVerifier = {
  scheme: "nep413",
  verify(ctx) {
    try {
      if (!/^[0-9a-f]{128}$/.test(ctx.proof.signature)) return false;
      if (ctx.proof.publicKey === undefined) return false;
      const key = decodeNearEd25519Key(ctx.proof.publicKey);
      if (key === null) return false;
      const signature = Uint8Array.from(ctx.proof.signature.match(/../g)!.map((b) => Number.parseInt(b, 16)));
      return ed25519.verify(signature, nep413SignedHash(ctx.message), key);
    } catch {
      return false;
    }
  },
};
