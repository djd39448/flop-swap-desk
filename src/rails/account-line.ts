// SPDX-License-Identifier: MIT
//
// D-08 option A: how the two parties in one leg's own deal room exchange the chain address a
// rail should pay/read, without tclk/1 growing a DID→chain-address field of its own (tclk's
// DIDs are Ed25519, a chain account is unrelated key material — the same reason
// src/vendor/evm-hash-rail.ts's AddressBook is a caller-supplied mapping, not part of
// LockTerms). The account line is one plain, non-tclk line posted in the leg's own deal room:
//
//   swap1 account <rail-id> <caip-10 account>
//
// `<rail-id>` is canonical per tclk's own closed registry (`@flop-labs/tclk`'s
// `CANONICAL_RAIL_IDS`); `<caip-10 account>` is `namespace:reference:address` (CAIP-10),
// namespace fixed by the rail (`RAIL_NAMESPACES` below). `evm-htlc` ↔ `eip155` and (D-N5)
// `near-htlc` ↔ `near` each have their own chain-specific address grammar in this build
// (`validateEip155Address`/`validateNearAccountId`); `btc-htlc` is reserved in tclk's registry
// for its own account-line-shaped chain (it in fact uses the separate pubkey line below, P4-BTC-
// SPEC.md §6) and parses under the generic CAIP-10 address grammar only (`validateGenericCaip10`
// below) — the wire shape CAIP-10 itself defines, not that chain's own semantic rules, which is
// deferred to that rail's own build stage.
//
// The binding DID is `record.sender` (whoever signed the record), never a field inside the line.
// P7 (handoff/P7-ACCOUNT-PROOF-SPEC.md, closing R3-1): a line may end with `proof <scheme>:<sig>
// [<key>]`, a signature by the chain key over a message binding that DID, the leg's contract id,
// the rail and the account (`src/rails/account-proof.ts`); under a `required` proof policy a
// line counts only if the proof verifies. The transcript record alone proves who posted a line,
// never that the poster controls the named chain account. `resolveAccounts` folds every account line in one leg's deal
// room into at most one address per party, refusing (not "first wins") when a party's own lines
// disagree — ordering inside a room is venue-controlled (H4, tclk#175), so it is never used to
// break a tie about which of a party's own claims is the real one.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §3 (D-08 option A);
// docs/PROFILE.md §3.5 documents this for a profile reader.

import { isAddress, type Address } from "viem";
import {
  dealRoom,
  MAX_FRAME_CHARS,
  normalizeRailId,
  verifyTranscriptRecord,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import {
  buildAccountProofMessage,
  checkLineProof,
  formatProofField,
  parseProofTokens,
  type AccountProof,
  type ProofPolicy,
} from "./account-proof.js";

/** Rail → CAIP-2 namespace (SPEC §3): `evm-htlc` ↔ `eip155` is the only pair with a
 *  chain-specific address grammar in this build (see `validateEip155Address`); `btc-htlc`/
 *  `near-htlc` are listed so a wrong-namespace line for either is rejected for the right reason
 *  (namespace mismatch, not "unknown rail"), and their accounts still parse under the generic
 *  CAIP-10 grammar (`validateGenericCaip10`) so a line naming one of them is a real, resolvable
 *  account line — just without that chain's own semantic checks, which is that rail's own build
 *  stage's job. Solana has no tclk rail id yet (`CANONICAL_RAIL_IDS` has none), so it cannot
 *  appear here at all. */
export const RAIL_NAMESPACES: Readonly<Record<string, string>> = {
  "evm-htlc": "eip155",
  "btc-htlc": "bip122",
  "near-htlc": "near",
};

/** CAIP-2 `eip155` reference: a decimal chain id, no leading zeros (SPEC §3). */
const EIP155_REFERENCE = /^(0|[1-9][0-9]*)$/;

/** `swap1 account <rail-id> <caip-10 account>` — single ASCII spaces, no trailing space. Two
 *  captured tokens; each is further decomposed (rail id; namespace:reference:address) below. */
const LINE_PATTERN = /^swap1 account (\S+) (\S+)(?: proof (\S+)(?: (\S+))?)?$/;

export interface ParsedAccountLine {
  /** Canonical per tclk's registry (e.g. `"evm-htlc"`) — never an alias, never a non-canonical
   *  spelling (rejected at parse time, same rule `requireCanonicalRail` uses on tclk frames). */
  railId: string;
  /** `namespace:reference` (e.g. `"eip155:31337"`) — compare against a chain pin's own
   *  `caip2` field (`EvmChainPin.caip2`) to decide whether a line is this chain's. */
  caip2: string;
  /** The chain address, normalized (eip155: lowercased after checksum validation — see
   *  `isAddress`'s comparison rule below). */
  address: string;
  /** The trailing `proof <scheme>:<signature>[ <key>]` field (P7), when the line has one. Its
   *  presence says nothing about validity: `resolveAccounts` checks it. */
  proof?: AccountProof;
}

/**
 * eip155's address grammar (SPEC §3): `0x` + 40 hex, all-lowercase or a valid EIP-55 checksum —
 * viem's `isAddress` (default `strict: true`) already implements exactly this rule (lowercase
 * always passes; anything with mixed case must match `checksumAddress` or is refused). Returns
 * the normalized (lowercased) address, or `null` on anything else, including all-uppercase
 * (neither all-lowercase nor a real checksum) and a mixed-case string that fails the checksum.
 */
function validateEip155Address(reference: string, address: string): string | null {
  if (!EIP155_REFERENCE.test(reference)) return null;
  if (!isAddress(address)) return null;
  return address.toLowerCase();
}

/** CAIP-2's own reference grammar and CAIP-10's own address grammar, verbatim (the CASA specs,
 *  not this repo's invention) — used for a namespace this build has no chain-specific rule for
 *  yet (`btc-htlc`). This is the wire shape only: it says nothing about whether a given string is
 *  a real Bitcoin address (bech32 checksum, …) — that is that rail's own build stage's job, same
 *  as `eip155`/`near` had their own rules added (above/below). No normalization: this namespace's
 *  own casing convention is not known here. */
const CAIP2_REFERENCE = /^[-a-zA-Z0-9]{1,32}$/;
const CAIP10_ADDRESS = /^[-.%a-zA-Z0-9]{1,128}$/;

function validateGenericCaip10(reference: string, address: string): string | null {
  if (!CAIP2_REFERENCE.test(reference)) return null;
  if (!CAIP10_ADDRESS.test(address)) return null;
  return address;
}

/** D-N5: NEAR's own account-id grammar (mirrors `src/rails/near-htlc.ts`'s identical private
 *  `NEAR_ACCOUNT_ID` — kept as its own copy here rather than a cross-file import, the same way
 *  each rail's own evidence/account-line code already owns small local copies of shared shape
 *  checks elsewhere in this build): 2-64 chars, lowercase-alphanumeric segments joined by a
 *  single `-`, `_` or `.` separator — never leading/trailing or doubled-up. `_` is accepted here
 *  even though it is NOT part of the generic CAIP-10 address grammar above (`CAIP10_ADDRESS`
 *  has no `_`) — a deliberate, documented deviation: a real NEAR account (an implicit 64-hex-char
 *  account, or a named one like `alice_capital.near-sandbox-flop`) can legitimately contain one,
 *  and refusing it here would make a genuine NEAR account line unparseable. The chain id itself
 *  (the CAIP-2 reference, e.g. `"near-sandbox-flop"`, `"testnet"`) still uses the generic CAIP-2
 *  reference grammar (`CAIP2_REFERENCE`) — NEAR's own chain ids are plain identifiers, not
 *  NEAR-account-shaped. */
const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

function validateNearAccountId(reference: string, address: string): string | null {
  if (!CAIP2_REFERENCE.test(reference)) return null;
  if (!NEAR_ACCOUNT_ID.test(address)) return null;
  return address;
}

/** Shared core of `formatAccountLine`/`parseAccountLine`: validate one namespace's
 *  reference+address grammar. */
function validateChainAddress(namespace: string, reference: string, address: string): string | null {
  if (namespace === "eip155") return validateEip155Address(reference, address);
  if (namespace === "near") return validateNearAccountId(reference, address);
  return validateGenericCaip10(reference, address);
}

/**
 * Build the line to post. Throws (never a silent guess) on a non-canonical or unmapped rail id,
 * a `caip2` whose namespace does not match that rail, or an address that fails the namespace's
 * grammar — this produces a line that is about to be signed and posted, so the same
 * fail-loud-on-write rule `src/profile.ts`'s `legAContext`/`legBContext` use applies here too.
 */
export function formatAccountLine(input: {
  railId: string;
  caip2: string;
  address: string;
  /** P7: the chain key's proof over `accountProofMessage(...)`; omitted only for a line that is
   *  deliberately unproven (it will not resolve under a `required` proof policy). */
  proof?: AccountProof;
}): string {
  const railId = normalizeRailId(input.railId);
  if (railId !== input.railId) {
    throw new Error(`account-line: non-canonical rail id: ${input.railId}; use ${railId}`);
  }
  const namespace = RAIL_NAMESPACES[railId];
  if (namespace === undefined) {
    throw new Error(`account-line: rail "${railId}" has no chain-account namespace (D-08, SPEC §3)`);
  }
  const caip2Parts = input.caip2.split(":");
  const ns = caip2Parts[0];
  const reference = caip2Parts[1];
  if (caip2Parts.length !== 2 || ns === undefined || reference === undefined || ns === "" || reference === "") {
    throw new Error(`account-line: malformed caip2 "${input.caip2}" (expected namespace:reference)`);
  }
  if (ns !== namespace) {
    throw new Error(`account-line: caip2 namespace "${ns}" does not match rail "${railId}" (expected "${namespace}")`);
  }
  const normalizedAddress = validateChainAddress(namespace, reference, input.address);
  if (normalizedAddress === null) {
    throw new Error(`account-line: "${input.address}" is not a valid ${namespace} address for reference "${reference}"`);
  }
  const line = `swap1 account ${railId} ${ns}:${reference}:${normalizedAddress}${
    input.proof === undefined ? "" : ` proof ${formatProofField(input.proof)}`
  }`;
  if (line.length > MAX_FRAME_CHARS) {
    throw new Error(`account-line: line is ${line.length} chars, over the room-message cap of ${MAX_FRAME_CHARS}`);
  }
  return line;
}

/**
 * The exact message the chain key must sign for an account line (P7): binds the signer's DID
 * (`did`: the sender of the record that will carry the line), the leg's tclk contract id, the
 * rail and the account as the line will spell it (normalized). Throws on a non-canonical input,
 * like `formatAccountLine`.
 */
export function accountProofMessage(input: {
  did: string;
  contract: string;
  railId: string;
  caip2: string;
  address: string;
}): string {
  const line = formatAccountLine({ railId: input.railId, caip2: input.caip2, address: input.address });
  const parsed = parseAccountLine(line);
  if (parsed === null) throw new Error("account-line: cannot build a proof message for this account");
  return buildAccountProofMessage({
    did: input.did,
    contract: input.contract,
    railId: parsed.railId,
    account: `${parsed.caip2}:${parsed.address}`,
  });
}

/**
 * Parse one deal-room line. Strict, never throws on malformed input (this reads anonymous
 * text from a signed-but-otherwise-arbitrary transcript line) — `null` for anything that is not
 * exactly the documented grammar: a non-canonical or unregistered rail id, a caip-10 token that
 * doesn't split into exactly three non-empty `:`-separated parts, a namespace that doesn't match
 * the rail, or an address that fails that namespace's grammar (`eip155`: a reference with a
 * leading zero, or an address that is neither all-lowercase nor a valid EIP-55 checksum; any
 * other mapped namespace: the generic CAIP-2/CAIP-10 reference/address grammar).
 */
export function parseAccountLine(line: string): ParsedAccountLine | null {
  if (typeof line !== "string") return null;
  const match = LINE_PATTERN.exec(line);
  if (match === null) return null;
  if (line.length > MAX_FRAME_CHARS) return null;
  const railToken = match[1];
  const caipToken = match[2];
  if (railToken === undefined || caipToken === undefined) return null;
  // A trailing proof must be well formed: `proof` with a malformed body is a malformed line
  // (null), never a line that quietly counts as if it had no proof.
  let proof: AccountProof | undefined;
  if (match[3] !== undefined) {
    const parsedProof = parseProofTokens(match[3], match[4]);
    if (parsedProof === null) return null;
    proof = parsedProof;
  }

  let railId: string;
  try {
    railId = normalizeRailId(railToken);
  } catch {
    return null;
  }
  if (railId !== railToken) return null; // must already be canonical on the wire

  const namespace = RAIL_NAMESPACES[railId];
  if (namespace === undefined) return null; // not a rail this module maps to a chain namespace

  const parts = caipToken.split(":");
  if (parts.length !== 3) return null;
  const ns = parts[0];
  const reference = parts[1];
  const address = parts[2];
  if (ns === undefined || reference === undefined || address === undefined) return null;
  if (ns !== namespace) return null; // wrong namespace for this rail

  const normalizedAddress = validateChainAddress(namespace, reference, address);
  if (normalizedAddress === null) return null;

  return { railId, caip2: `${ns}:${reference}`, address: normalizedAddress, ...(proof === undefined ? {} : { proof }) };
}

// ── the pubkey line (P4-BTC-SPEC.md §6) ─────────────────────────────────────────────────────
//
// A P2WSH script commits to PUBLIC KEYS, not addresses — and the refund branch commits to the
// PAYER's key too, unlike the account line's address (which only ever needs to name where a
// payout should land). A payee resolving `btc-htlc`'s witnessScript therefore needs both
// parties' pubkeys, not just an address for its own counterparty, so this is a second, separate
// line form next to the account line above:
//
//   swap1 pubkey <rail-id> <caip-2 (namespace:reference)> <33-byte compressed pubkey hex>
//
// Same rules as the account line: single ASCII spaces, no trailing space, a non-canonical rail
// id rejected outright, the binding DID is `record.sender` (never a field inside the line), and
// `resolvePubkeys` folds a room's lines to at most one pubkey per party under the identical
// sender-binding/room-scoping/other-rail-or-chain-ignored/conflict-means-unresolved rules
// `resolveAccounts` already applies. Unlike the account line (only the payee's is required),
// P4-BTC-SPEC.md §6 requires BOTH parties to post one for a `btc-htlc` leg — that requirement is
// the caller's own job (e.g. `src/rails/btc-evidence.ts` refusing to verify a lock when either
// pubkey is missing), not something `resolvePubkeys` enforces itself (it only ever reports what
// it can resolve, exactly like `resolveAccounts`).
//
// Only `btc-htlc` has a pubkey-line rule today; another rail that later needs one (`near-htlc`
// commits to a public key too, in principle) reuses this same grammar under its own rail id and
// CAIP-2 namespace.

/** Rail → CAIP-2 namespace, for the pubkey line only (a separate map from `RAIL_NAMESPACES`
 *  above, since a rail can have an account-line rule, a pubkey-line rule, both, or neither —
 *  `evm-htlc`'s P2SH-free EOA commitment never needs the payer's pubkey, so it has no entry
 *  here). */
export const PUBKEY_RAIL_NAMESPACES: Readonly<Record<string, string>> = {
  "btc-htlc": "bip122",
};

/** bip122's own CAIP-2 reference grammar (CAIP-2: "bip122" = Bitcoin/blockchain-based chains):
 *  32 lowercase hex characters — the chain's genesis block hash prefix, exactly what
 *  `BtcChainPin.caip2` (`src/rails/btc-htlc.ts`) carries. Deliberately narrower than
 *  `CAIP2_REFERENCE` (the generic `[-a-zA-Z0-9]{1,32}` used above for a namespace with no
 *  chain-specific rule yet): a bip122 reference is *always* hex, so accepting anything looser
 *  would let a malformed or mixed-case reference through this grammar even though it could never
 *  be a real bip122 chain id. This also rejects CAIP-10's legacy (pre-2021) `<address>@<caip-2
 *  id>` account form outright — that form has no `namespace:reference` shape at all (there is no
 *  `@` in a bare CAIP-2 token to begin with), so it can never match this pattern, or the pubkey
 *  line's own three-token grammar below, no matter how it's spliced in. */
const BIP122_REFERENCE = /^[0-9a-f]{32}$/;

/** 33-byte compressed secp256k1 point, bare lowercase hex (Bitcoin convention) — the same shape
 *  `src/rails/btc-htlc.ts`'s own `PUBKEY_SHAPE` checks. */
const PUBKEY_SHAPE = /^0[23][0-9a-f]{64}$/;

/** Shared core of `formatPubkeyLine`/`parsePubkeyLine`: validate one namespace's reference+pubkey
 *  grammar. Only `bip122` has a rule today; any other namespace (including one with an
 *  account-line rule) has none, so it always refuses — a pubkey line for a rail this module maps
 *  to a namespace without a pubkey-line rule of its own is not a line this function can ever
 *  produce or accept. */
function validatePubkeyForNamespace(namespace: string, reference: string, pubkey: string): string | null {
  if (namespace !== "bip122") return null;
  if (!BIP122_REFERENCE.test(reference)) return null;
  if (!PUBKEY_SHAPE.test(pubkey)) return null;
  return pubkey;
}

/** `swap1 pubkey <rail-id> <caip-2> <pubkey>` — four tokens (unlike the account line's three):
 *  the CAIP-2 chain id and the pubkey are separate tokens here, since a CAIP-2 id
 *  (`namespace:reference`) has no address segment to share a token with in the first place. */
const PUBKEY_LINE_PATTERN = /^swap1 pubkey (\S+) (\S+) (\S+)(?: proof (\S+)(?: (\S+))?)?$/;

export interface ParsedPubkeyLine {
  /** Canonical per tclk's registry, exactly like `ParsedAccountLine.railId`. */
  railId: string;
  /** `namespace:reference` — compare against a chain pin's own `caip2` field. */
  caip2: string;
  /** The 33-byte compressed pubkey, lowercase hex (already normalized by `PUBKEY_SHAPE`). */
  pubkey: string;
  /** The trailing proof field (P7), when present; `resolvePubkeys` checks it. */
  proof?: AccountProof;
}

/**
 * Build the pubkey line to post. Throws (never a silent guess) on a non-canonical or unmapped
 * rail id, a `caip2` whose namespace does not match that rail, or a pubkey that fails the
 * namespace's grammar — same fail-loud-on-write rule `formatAccountLine` follows.
 */
export function formatPubkeyLine(input: {
  railId: string;
  caip2: string;
  pubkey: string;
  /** P7: the chain key's proof over `pubkeyProofMessage(...)`. */
  proof?: AccountProof;
}): string {
  const railId = normalizeRailId(input.railId);
  if (railId !== input.railId) {
    throw new Error(`pubkey-line: non-canonical rail id: ${input.railId}; use ${railId}`);
  }
  const namespace = PUBKEY_RAIL_NAMESPACES[railId];
  if (namespace === undefined) {
    throw new Error(`pubkey-line: rail "${railId}" has no pubkey-line namespace (P4-BTC-SPEC.md §6)`);
  }
  const caip2Parts = input.caip2.split(":");
  const ns = caip2Parts[0];
  const reference = caip2Parts[1];
  if (caip2Parts.length !== 2 || ns === undefined || reference === undefined || ns === "" || reference === "") {
    throw new Error(`pubkey-line: malformed caip2 "${input.caip2}" (expected namespace:reference)`);
  }
  if (ns !== namespace) {
    throw new Error(`pubkey-line: caip2 namespace "${ns}" does not match rail "${railId}" (expected "${namespace}")`);
  }
  const normalizedPubkey = validatePubkeyForNamespace(namespace, reference, input.pubkey);
  if (normalizedPubkey === null) {
    throw new Error(`pubkey-line: "${input.pubkey}" is not a valid ${namespace} pubkey for reference "${reference}"`);
  }
  const line = `swap1 pubkey ${railId} ${ns}:${reference} ${normalizedPubkey}${
    input.proof === undefined ? "" : ` proof ${formatProofField(input.proof)}`
  }`;
  if (line.length > MAX_FRAME_CHARS) {
    throw new Error(`pubkey-line: line is ${line.length} chars, over the room-message cap of ${MAX_FRAME_CHARS}`);
  }
  return line;
}

/**
 * The exact message the chain key must sign for a pubkey line (P7). The "account" the message
 * names is `<caip2>:<pubkey hex>`: the pubkey line names a key, not an address. (The `bip322`
 * verifier derives the P2WPKH address from that key itself.)
 */
export function pubkeyProofMessage(input: {
  did: string;
  contract: string;
  railId: string;
  caip2: string;
  pubkey: string;
}): string {
  const line = formatPubkeyLine({ railId: input.railId, caip2: input.caip2, pubkey: input.pubkey });
  const parsed = parsePubkeyLine(line);
  if (parsed === null) throw new Error("pubkey-line: cannot build a proof message for this pubkey");
  return buildAccountProofMessage({
    did: input.did,
    contract: input.contract,
    railId: parsed.railId,
    account: `${parsed.caip2}:${parsed.pubkey}`,
  });
}

/**
 * Parse one deal-room pubkey line. Strict, never throws — `null` for anything that is not
 * exactly the documented grammar: a non-canonical or unregistered rail id, a rail with no
 * pubkey-line rule, a caip-2 token that isn't exactly two non-empty `:`-separated parts, a
 * namespace that doesn't match the rail, or a pubkey that fails that namespace's grammar
 * (bip122: a reference that isn't 32 lowercase hex chars, or a pubkey that isn't a 33-byte
 * compressed point). This also refuses CAIP-10's legacy `<address>@<caip-2 id>` form: that form
 * cannot appear as this line's third token at all (there is no room for an `@`-joined address in
 * a bare `namespace:reference` token), so it simply never matches `LINE_PATTERN`'s three-token
 * shape or `BIP122_REFERENCE`'s hex-only grammar.
 */
export function parsePubkeyLine(line: string): ParsedPubkeyLine | null {
  if (typeof line !== "string") return null;
  const match = PUBKEY_LINE_PATTERN.exec(line);
  if (match === null) return null;
  if (line.length > MAX_FRAME_CHARS) return null;
  const railToken = match[1];
  const caipToken = match[2];
  const pubkeyToken = match[3];
  if (railToken === undefined || caipToken === undefined || pubkeyToken === undefined) return null;
  let proof: AccountProof | undefined;
  if (match[4] !== undefined) {
    const parsedProof = parseProofTokens(match[4], match[5]);
    if (parsedProof === null) return null;
    proof = parsedProof;
  }

  let railId: string;
  try {
    railId = normalizeRailId(railToken);
  } catch {
    return null;
  }
  if (railId !== railToken) return null; // must already be canonical on the wire

  const namespace = PUBKEY_RAIL_NAMESPACES[railId];
  if (namespace === undefined) return null; // this rail has no pubkey-line rule

  const parts = caipToken.split(":");
  if (parts.length !== 2) return null;
  const ns = parts[0];
  const reference = parts[1];
  if (ns === undefined || reference === undefined || ns === "" || reference === "") return null;
  if (ns !== namespace) return null; // wrong namespace for this rail

  const normalizedPubkey = validatePubkeyForNamespace(namespace, reference, pubkeyToken);
  if (normalizedPubkey === null) return null;

  return { railId, caip2: `${ns}:${reference}`, pubkey: normalizedPubkey, ...(proof === undefined ? {} : { proof }) };
}

export interface ResolvePubkeysInput {
  /** The tclk contract id whose own deal room is the only room a pubkey line for this leg may be
   *  posted in — identical scoping rule to `ResolveAccountsInput.contract`. */
  contract: string;
  payerDid: string;
  payeeDid: string;
  /** Canonical rail id this resolution is for (e.g. `"btc-htlc"`). */
  rail: string;
  /** The chain pin's own `caip2` (e.g. `BtcChainPin.caip2`). */
  caip2: string;
  /** P4-BTC-FIXES.md G1: when set, a candidate record with `seq >= beforeSeq` is ignored
   *  entirely — "only lines posted before the accepted lock frame" — so a line posted after a
   *  swap's own leg-A lock was accepted can neither newly resolve nor conflict-and-unresolve a
   *  party's pubkey for a caller (`SellerFlow.claimLegA`) whose own resolution necessarily runs
   *  after that lock exists in the room. Omitted (the default): every record counts, unchanged
   *  from this function's behaviour before G1 (every non-flow caller — `src/replay.ts`'s
   *  `foldCaptured`, the live watcher, `examples/audit-export.mjs` — never passes this). */
  beforeSeq?: number;
  /** P7: how proofs are treated. Required (no default) so every call site states its choice:
   *  `{ mode: "required" }` counts only lines whose proof verifies for this sender, contract,
   *  rail and account; `{ mode: "legacy-unproven" }` is the pre-P7 fold, kept for tests only (no
   *  production call site uses it; a test pins that). */
  proof: ProofPolicy;
}

export interface ResolvedPubkeys {
  payer?: string;
  payee?: string;
  /** Identical purpose to `ResolvedAccounts.reasons` — every line this fold ignored or refused,
   *  or a conflict among one party's own lines. Empty when nothing did. */
  reasons: string[];
}

/**
 * Fold one leg's deal-room records into at most one resolved pubkey per party — the pubkey-line
 * twin of `resolveAccounts`, with the identical rules: only a record that both verifies
 * (`verifyTranscriptRecord(record).ok`) and sits in `dealRoom(contract)` counts; the binding DID
 * is `record.sender`; a line for a different rail or chain is ignored (with a reason); a sender
 * that is neither `payerDid` nor `payeeDid` is ignored silently; and disagreement among one
 * party's own (otherwise valid, matching) lines makes that party's pubkey **unresolved**, never
 * "first wins". Unlike `resolveAccounts` (only the payee's line is required by D-08), a
 * `btc-htlc` leg's own lock verification (P4-BTC-SPEC.md §6) needs BOTH parties' pubkeys — this
 * function still resolves each independently and leaves enforcing "both must be present" to its
 * caller, exactly the same split `resolveAccounts` already draws between "what resolved" and
 * "what a lock check requires".
 */
export function resolvePubkeys(records: readonly TranscriptRecord[], input: ResolvePubkeysInput): ResolvedPubkeys {
  const reasons: string[] = [];

  let rail: string;
  try {
    rail = normalizeRailId(input.rail);
  } catch {
    return { reasons: [`pubkey-line: "${input.rail}" is not a registered rail id`] };
  }

  let room: string;
  try {
    room = dealRoom(input.contract);
  } catch {
    return { reasons: [`pubkey-line: "${input.contract}" is not a valid contract id`] };
  }

  const pubkeysByDid = new Map<string, Set<string>>();

  for (const candidate of records) {
    if (input.beforeSeq !== undefined && candidate.seq >= input.beforeSeq) continue; // G1: after the accepted lock
    if (!verifyTranscriptRecord(candidate).ok) continue; // unsigned or forged: not authenticated
    if (candidate.room !== room) continue; // not this leg's own deal room

    const parsed = parsePubkeyLine(candidate.line);
    if (parsed === null) continue; // not a pubkey line at all (some other frame/line)

    if (parsed.railId !== rail) {
      reasons.push(
        `pubkey-line: ${candidate.sender} posted a pubkey line for rail "${parsed.railId}", not "${rail}" (ignored)`,
      );
      continue;
    }
    if (parsed.caip2 !== input.caip2) {
      reasons.push(
        `pubkey-line: ${candidate.sender} posted a pubkey line for chain "${parsed.caip2}", not "${input.caip2}" (ignored)`,
      );
      continue;
    }

    if (candidate.sender !== input.payerDid && candidate.sender !== input.payeeDid) continue; // not a party to this swap

    if (input.proof.mode === "required") {
      const why = checkLineProof({
        policy: input.proof,
        did: candidate.sender,
        contract: input.contract,
        railId: rail,
        caip2: input.caip2,
        account: `${parsed.caip2}:${parsed.pubkey}`,
        subject: parsed.pubkey,
        proof: parsed.proof,
      });
      if (why !== null) {
        reasons.push(`pubkey-line: ${candidate.sender} posted a pubkey line that is not proven (${why}); ignored`);
        continue;
      }
    }

    const seen = pubkeysByDid.get(candidate.sender) ?? new Set<string>();
    seen.add(parsed.pubkey);
    pubkeysByDid.set(candidate.sender, seen);
  }

  function resolve(did: string, role: "payer" | "payee"): string | undefined {
    const seen = pubkeysByDid.get(did);
    if (seen === undefined || seen.size === 0) return undefined;
    if (seen.size > 1) {
      reasons.push(`pubkey-line: conflicting pubkey lines for the ${role} (${did})`);
      return undefined;
    }
    const [pubkey] = seen;
    return pubkey;
  }

  const payer = resolve(input.payerDid, "payer");
  const payee = resolve(input.payeeDid, "payee");

  return {
    reasons,
    ...(payer === undefined ? {} : { payer }),
    ...(payee === undefined ? {} : { payee }),
  };
}

export interface ResolveAccountsInput {
  /** The tclk contract id whose own deal room (`dealRoom(contract)`) is the only room an
   *  account line for this leg may be posted in. */
  contract: string;
  payerDid: string;
  payeeDid: string;
  /** Canonical rail id this resolution is for (e.g. `"evm-htlc"`) — a line for any other rail
   *  is ignored (with a reason), never coerced. */
  rail: string;
  /** The chain pin's own `caip2` (e.g. `EvmChainPin.caip2`) — a line for any other chain is
   *  ignored (with a reason), even if it is otherwise a well-formed line for the same rail id
   *  (a rail id like `evm-htlc` is not itself chain-specific; the pin is). */
  caip2: string;
  /** P4-BTC-FIXES.md G1 (see `ResolvePubkeysInput.beforeSeq`'s identical doc) — omitted by every
   *  non-flow caller. */
  beforeSeq?: number;
  /** P7: see `ResolvePubkeysInput.proof`. */
  proof: ProofPolicy;
}

export interface ResolvedAccounts {
  payer?: Address;
  payee?: Address;
  /** The public key the party's proven line carries (NEAR's `nep413`), present only under a
   *  `required` proof policy and only for a scheme that puts a key on the line. The NEAR evidence
   *  reader must show it is a FullAccess key of the account at the finalized block. */
  payerKey?: string;
  payeeKey?: string;
  /** Every notable thing this resolution ignored or refused: a line for a different rail or
   *  chain, or conflicting lines from the same party. Empty when nothing did. */
  reasons: string[];
}

/**
 * Fold one leg's deal-room records into at most one resolved address per party (SPEC §3): only
 * records that verify (`verifyTranscriptRecord(record).ok`) and sit in `dealRoom(contract)`
 * count; the binding DID is `record.sender` — a line cannot speak for another DID, so a line
 * the payer signed is the payer's claim, never the payee's, regardless of what room convention
 * says about who "should" post there. Lines for a different rail or chain are ignored (with a
 * reason); a sender that is neither `payerDid` nor `payeeDid` is ignored silently (its line is
 * not about either party in this swap). Per DID, every one of its valid, matching lines must
 * agree exactly (after the namespace's own address normalization, already applied by
 * `parseAccountLine`) — disagreement makes that DID **unresolved** ("conflicting account
 * lines"), never "first wins" (room ordering is venue-controlled, H4/tclk#175). Only the
 * payee's line is required for a lock to verify (D-08); the payer's is optional corroboration.
 */
export function resolveAccounts(
  records: readonly TranscriptRecord[],
  input: ResolveAccountsInput,
): ResolvedAccounts {
  const reasons: string[] = [];

  let rail: string;
  try {
    rail = normalizeRailId(input.rail);
  } catch {
    return { reasons: [`account-line: "${input.rail}" is not a registered rail id`] };
  }

  let room: string;
  try {
    room = dealRoom(input.contract);
  } catch {
    return { reasons: [`account-line: "${input.contract}" is not a valid contract id`] };
  }

  const addressesByDid = new Map<string, Set<string>>();

  for (const candidate of records) {
    if (input.beforeSeq !== undefined && candidate.seq >= input.beforeSeq) continue; // G1: after the accepted lock
    if (!verifyTranscriptRecord(candidate).ok) continue; // unsigned or forged: not authenticated
    if (candidate.room !== room) continue; // not this leg's own deal room

    const parsed = parseAccountLine(candidate.line);
    if (parsed === null) continue; // not an account line at all (some other frame/line)

    if (parsed.railId !== rail) {
      reasons.push(
        `account-line: ${candidate.sender} posted an account line for rail "${parsed.railId}", not "${rail}" (ignored)`,
      );
      continue;
    }
    if (parsed.caip2 !== input.caip2) {
      reasons.push(
        `account-line: ${candidate.sender} posted an account line for chain "${parsed.caip2}", not "${input.caip2}" (ignored)`,
      );
      continue;
    }

    if (candidate.sender !== input.payerDid && candidate.sender !== input.payeeDid) continue; // not a party to this swap

    if (input.proof.mode === "required") {
      const why = checkLineProof({
        policy: input.proof,
        did: candidate.sender,
        contract: input.contract,
        railId: rail,
        caip2: input.caip2,
        account: `${parsed.caip2}:${parsed.address}`,
        subject: parsed.address,
        proof: parsed.proof,
      });
      if (why !== null) {
        reasons.push(`account-line: ${candidate.sender} posted an account line that is not proven (${why}); ignored`);
        continue;
      }
    }

    // The address is the identity; a proof's public key (NEAR) is part of it under a required
    // policy, so two lines naming one account with different keys are a conflict, never a pick.
    const identity = input.proof.mode === "required" && parsed.proof?.publicKey !== undefined
      ? `${parsed.address}\n${parsed.proof.publicKey}`
      : parsed.address;
    const seen = addressesByDid.get(candidate.sender) ?? new Set<string>();
    seen.add(identity);
    addressesByDid.set(candidate.sender, seen);
  }

  function resolve(did: string, role: "payer" | "payee"): { address: Address; key?: string } | undefined {
    const seen = addressesByDid.get(did);
    if (seen === undefined || seen.size === 0) return undefined;
    if (seen.size > 1) {
      reasons.push(`account-line: conflicting account lines for the ${role} (${did})`);
      return undefined;
    }
    const [identity] = seen;
    const [address, key] = identity!.split("\n");
    return { address: address as Address, ...(key === undefined ? {} : { key }) };
  }

  const payer = resolve(input.payerDid, "payer");
  const payee = resolve(input.payeeDid, "payee");

  return {
    reasons,
    ...(payer === undefined ? {} : { payer: payer.address }),
    ...(payee === undefined ? {} : { payee: payee.address }),
    ...(payer?.key === undefined ? {} : { payerKey: payer.key }),
    ...(payee?.key === undefined ? {} : { payeeKey: payee.key }),
  };
}
