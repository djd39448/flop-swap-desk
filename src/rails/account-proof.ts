// SPDX-License-Identifier: MIT
//
// Proof-of-control for D-08 account/pubkey lines (handoff/P7-ACCOUNT-PROOF-SPEC.md, closing the
// R3-1 mirror-swap limit). Every account or pubkey line carries a signature, by the chain key
// that controls the named account, over a message that binds the signer's DID, the leg's tclk
// contract id, the rail id and the account. A mirror pair has a different contract id, so it
// cannot produce a valid proof for a victim's accounts.
//
//   message := FLOP::swap::account-proof::v1|<did>|<contract id>|<rail id>|<caip10 account>
//   field   := proof <scheme>:<signature>[ <key>]          (the trailing part of a line)
//
// This file is the shared core only: the message builder, the proof-field grammar, the verifier
// interface (one verifier per scheme, pluggable) and the two verifiers that need nothing but a
// library call: `eip191` (EVM) and `ed25519` (Solana, and the signature step of NEAR's nep413).
// `bip322` (btc-proof.ts) and `nep413` (near-proof.ts) plug into the same interface and are
// registered in `DEFAULT_PROOF_VERIFIERS` below.
//
// Verifiers are synchronous because every resolver (`resolveAccounts`, `resolvePubkeys`,
// `foldCaptured`, the watcher) is a synchronous fold. `eip191` therefore recovers the signer
// with viem's own synchronous primitives (`hashMessage`, `publicKeyToAddress`) over noble's
// secp256k1 recovery, the computation `recoverMessageAddress` performs (that function is async
// only by declaration); the test file cross-checks the two on real signatures.

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base58 } from "@scure/base";
import { hashMessage } from "viem";
import { publicKeyToAddress } from "viem/utils";
import { normalizeRailId } from "@flop-labs/tclk";

import { bip322Verifier } from "./btc-proof.js";
import { nep413Verifier } from "./near-proof.js";

export const ACCOUNT_PROOF_MESSAGE_PREFIX = "FLOP::swap::account-proof::v1";

/** Which scheme(s) may prove an account on which rail (P7 spec "Schemes per rail"). `ed25519` is
 *  the Solana rail's scheme; that rail has no tclk id yet, so it has no entry here and a caller
 *  that adds it passes `allowedSchemes` explicitly. */
export const RAIL_PROOF_SCHEMES: Readonly<Record<string, readonly string[]>> = {
  "evm-htlc": ["eip191"],
  "btc-htlc": ["bip322"],
  "near-htlc": ["nep413"],
};

const DID_SHAPE = /^did:[a-z0-9]+:[A-Za-z0-9._%:-]+$/;
const CONTRACT_SHAPE = /^0x[0-9a-f]{64}$/;
/** namespace:reference:address, nothing that could contain the message separator or whitespace. */
const ACCOUNT_SHAPE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-._%a-zA-Z0-9]{1,128}$/;

export interface AccountProofMessageInput {
  /** The signed record's sender: the party whose account this is. */
  did: string;
  /** The leg's tclk contract id (`0x` + 64 lowercase hex). */
  contract: string;
  /** Canonical rail id. */
  railId: string;
  /** The CAIP-10 account the line names, exactly as the line spells it after normalization
   *  (`namespace:reference:address`; for a pubkey line, `namespace:reference:<pubkey hex>`). */
  account: string;
}

/**
 * The exact message a chain key signs. Throws on any field that is not canonical or could make
 * two different tuples render the same string (a `|`, whitespace or control character).
 */
export function buildAccountProofMessage(input: AccountProofMessageInput): string {
  if (!DID_SHAPE.test(input.did)) throw new Error(`account-proof: malformed did "${input.did}"`);
  if (!CONTRACT_SHAPE.test(input.contract)) throw new Error(`account-proof: malformed contract id "${input.contract}"`);
  let railId: string;
  try {
    railId = normalizeRailId(input.railId);
  } catch {
    throw new Error(`account-proof: "${input.railId}" is not a registered rail id`);
  }
  if (railId !== input.railId) throw new Error(`account-proof: non-canonical rail id: ${input.railId}; use ${railId}`);
  if (!ACCOUNT_SHAPE.test(input.account)) throw new Error(`account-proof: malformed account "${input.account}"`);
  return [ACCOUNT_PROOF_MESSAGE_PREFIX, input.did, input.contract, railId, input.account].join("|");
}

// ── the proof field ─────────────────────────────────────────────────────────────────────────

export interface AccountProof {
  /** Scheme id (`eip191`, `bip322`, `nep413`, `ed25519`, ...): `[a-z0-9][a-z0-9-]{0,15}`. */
  scheme: string;
  /** The encoded signature, as the scheme defines it (a single token, no spaces). */
  signature: string;
  /** The public key, where the scheme needs it on the line (NEAR, where the key is not the
   *  account). Its encoding is the scheme's own. */
  publicKey?: string;
}

const SCHEME_SHAPE = /^[a-z0-9][a-z0-9-]{0,15}$/;
const SIGNATURE_SHAPE = /^[A-Za-z0-9+/=_.-]{1,2048}$/;
const KEY_SHAPE = /^[A-Za-z0-9:+/=_.-]{1,256}$/;

/** The trailing part of a line: `<scheme>:<signature>[ <key>]` (after the literal `proof `). */
export function formatProofField(proof: AccountProof): string {
  if (!SCHEME_SHAPE.test(proof.scheme)) throw new Error(`account-proof: malformed scheme "${proof.scheme}"`);
  if (!SIGNATURE_SHAPE.test(proof.signature)) throw new Error("account-proof: malformed signature token");
  if (proof.publicKey !== undefined && !KEY_SHAPE.test(proof.publicKey)) {
    throw new Error("account-proof: malformed public key token");
  }
  return `${proof.scheme}:${proof.signature}${proof.publicKey === undefined ? "" : ` ${proof.publicKey}`}`;
}

/** Parse the two trailing tokens of a line (`<scheme>:<signature>` and an optional key). Strict:
 *  `null` on anything else. Never throws. */
export function parseProofTokens(schemeAndSignature: string, key: string | undefined): AccountProof | null {
  const colon = schemeAndSignature.indexOf(":");
  if (colon <= 0) return null;
  const scheme = schemeAndSignature.slice(0, colon);
  const signature = schemeAndSignature.slice(colon + 1);
  if (!SCHEME_SHAPE.test(scheme) || !SIGNATURE_SHAPE.test(signature)) return null;
  if (key !== undefined && !KEY_SHAPE.test(key)) return null;
  return { scheme, signature, ...(key === undefined ? {} : { publicKey: key }) };
}

// ── the verifier interface ──────────────────────────────────────────────────────────────────

export interface ProofVerifyContext {
  /** The exact message that must have been signed (`buildAccountProofMessage`). */
  message: string;
  railId: string;
  /** `namespace:reference` of the chain. */
  caip2: string;
  /** The normalized address the line names; for a pubkey line, the pubkey hex. */
  subject: string;
  proof: AccountProof;
}

/** One proof scheme. `verify` must never throw (return false on anything malformed) and must
 *  decide only from its arguments. */
export interface AccountProofVerifier {
  readonly scheme: string;
  verify(ctx: ProofVerifyContext): boolean;
}

export type ProofVerifierRegistry = ReadonlyMap<string, AccountProofVerifier>;

export function createProofVerifierRegistry(verifiers: readonly AccountProofVerifier[]): ProofVerifierRegistry {
  const map = new Map<string, AccountProofVerifier>();
  for (const v of verifiers) {
    if (map.has(v.scheme)) throw new Error(`account-proof: duplicate verifier for scheme "${v.scheme}"`);
    map.set(v.scheme, v);
  }
  return map;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── eip191 ──────────────────────────────────────────────────────────────────────────────────

/** secp256k1 n/2: signatures with s above it are the malleable twin and are refused (F5). */
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** `eip191`: `personal_sign` (EIP-191 version 0x45) of the message. Signature token: 65 bytes
 *  r||s||v as 130 bare lowercase hex chars, v = 27 or 28. The recovered address must equal the
 *  line's (lowercase) address. */
export const eip191Verifier: AccountProofVerifier = {
  scheme: "eip191",
  verify(ctx) {
    try {
      const sig = hexToBytes(ctx.proof.signature);
      if (sig === null || sig.length !== 65 || ctx.proof.publicKey !== undefined) return false;
      const v = sig[64]!;
      if (v !== 27 && v !== 28) return false;
      // P7 fix pass (F5): canonical proofs only; the high-s twin (r, n-s, v xor 1) also recovers the same
      // address, so refuse it.
      if (BigInt(`0x${bytesToHex(sig.slice(32, 64))}`) > SECP256K1_HALF_ORDER) return false;
      const digest = hexToBytes(hashMessage(ctx.message).slice(2));
      if (digest === null) return false;
      const point = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact")
        .addRecoveryBit(v - 27)
        .recoverPublicKey(digest);
      const recovered = publicKeyToAddress(`0x${bytesToHex(point.toBytes(false))}`);
      return recovered.toLowerCase() === ctx.subject.toLowerCase();
    } catch {
      return false;
    }
  },
};

// ── ed25519 ─────────────────────────────────────────────────────────────────────────────────

/** `ed25519`: a raw Ed25519 signature (64 bytes, 128 bare lowercase hex chars) over the UTF-8
 *  message. The public key is the line's key token (32 bytes, 64 hex) if present, else the
 *  subject decoded as a base58 32-byte key (Solana: the address is the public key). When both
 *  exist they must agree. This checks that the signature is by that key; that the key controls
 *  the account is the caller's rule (Solana: same thing; NEAR: access-key evidence). */
export const ed25519Verifier: AccountProofVerifier = {
  scheme: "ed25519",
  verify(ctx) {
    try {
      const sig = hexToBytes(ctx.proof.signature);
      if (sig === null || sig.length !== 64) return false;
      let addressKey: Uint8Array | null = null;
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ctx.subject)) {
        const decoded = base58.decode(ctx.subject);
        if (decoded.length === 32) addressKey = decoded;
      }
      let key: Uint8Array | null = null;
      if (ctx.proof.publicKey !== undefined) {
        key = hexToBytes(ctx.proof.publicKey);
        if (key === null || key.length !== 32) return false;
        if (addressKey !== null && bytesToHex(addressKey) !== bytesToHex(key)) return false;
      } else {
        key = addressKey;
      }
      if (key === null) return false;
      return ed25519.verify(sig, new TextEncoder().encode(ctx.message), key);
    } catch {
      return false;
    }
  },
};

/** Every scheme this build verifies: `eip191` (EVM), `bip322` (`src/rails/btc-proof.ts`), `nep413`
 *  (`src/rails/near-proof.ts`; the signature only, the key-on-account check is the NEAR evidence
 *  reader's) and `ed25519` (Solana). */
export const DEFAULT_PROOF_VERIFIERS: ProofVerifierRegistry = createProofVerifierRegistry([
  eip191Verifier,
  bip322Verifier,
  nep413Verifier,
  ed25519Verifier,
]);

// ── the resolution policy ───────────────────────────────────────────────────────────────────

/**
 * How a resolver treats proofs. `required` is the binding rule: a line counts only if its proof
 * verifies for this sender DID, contract, rail and account. `legacy-unproven` is the pre-P7
 * behaviour (proofs ignored), kept only for tests that need an unproven fold; no production call
 * site uses it (a test pins that).
 */
export type ProofPolicy =
  | {
      mode: "required";
      /** Default: `DEFAULT_PROOF_VERIFIERS`. */
      verifiers?: ProofVerifierRegistry;
      /** Default: `RAIL_PROOF_SCHEMES[rail]`. */
      allowedSchemes?: readonly string[];
    }
  | { mode: "legacy-unproven" };

/**
 * Decide one line's proof. Returns `null` when it verifies, else the reason it does not. Pure.
 */
export function checkLineProof(args: {
  policy: Extract<ProofPolicy, { mode: "required" }>;
  did: string;
  contract: string;
  railId: string;
  /** The account string that goes into the message (`namespace:reference:address`). */
  account: string;
  /** The value handed to the verifier as `subject`. */
  subject: string;
  caip2: string;
  proof: AccountProof | undefined;
}): string | null {
  if (args.proof === undefined) return "no proof";
  const allowed = args.policy.allowedSchemes ?? RAIL_PROOF_SCHEMES[args.railId] ?? [];
  if (!allowed.includes(args.proof.scheme)) {
    return `scheme "${args.proof.scheme}" is not accepted for rail "${args.railId}"`;
  }
  const verifier = (args.policy.verifiers ?? DEFAULT_PROOF_VERIFIERS).get(args.proof.scheme);
  if (verifier === undefined) return `no verifier for scheme "${args.proof.scheme}"`;
  let message: string;
  try {
    message = buildAccountProofMessage({
      did: args.did,
      contract: args.contract,
      railId: args.railId,
      account: args.account,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "cannot build the proof message";
  }
  let ok = false;
  try {
    ok = verifier.verify({
      message,
      railId: args.railId,
      caip2: args.caip2,
      subject: args.subject,
      proof: args.proof,
    });
  } catch {
    ok = false;
  }
  return ok ? null : "proof does not verify for this sender, contract, rail and account";
}
