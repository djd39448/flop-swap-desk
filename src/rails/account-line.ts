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
// namespace fixed by the rail (`RAIL_NAMESPACES` below — `evm-htlc` ↔ `eip155` is the only one
// with a chain-specific address grammar in this build; `btc-htlc`/`near-htlc` are reserved in
// tclk's registry for later chains and parse under the generic CAIP-10 address grammar only
// (`validateGenericCaip10` below) — the wire shape CAIP-10 itself defines, not that chain's own
// semantic rules (bech32, NEAR account names, …), which is deferred to that rail's own build
// stage).
//
// The line carries no signature of its own beyond the transcript record it rides in: the
// binding DID is `record.sender` (whoever signed the record), never a field inside the line —
// there is nothing in the grammar a forger could point at another party, so the fold need only
// trust `verifyTranscriptRecord`. `resolveAccounts` folds every account line in one leg's deal
// room into at most one address per party, refusing (not "first wins") when a party's own lines
// disagree — ordering inside a room is venue-controlled (H4, tclk#175), so it is never used to
// break a tie about which of a party's own claims is the real one.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-SPEC.md §3 (D-08 option A);
// docs/PROFILE.md §3.5 documents this for a profile reader.

import { isAddress, type Address } from "viem";
import {
  dealRoom,
  normalizeRailId,
  verifyTranscriptRecord,
  type TranscriptRecord,
} from "@flop-labs/tclk";

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
const LINE_PATTERN = /^swap1 account (\S+) (\S+)$/;

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
 *  yet (`btc-htlc`/`near-htlc`). This is the wire shape only: it says nothing about whether a
 *  given string is a real Bitcoin or NEAR address (bech32 checksum, NEAR account-name rules,
 *  …) — that is that rail's own build stage's job, same as `eip155` had its own rule added
 *  above. No normalization: neither namespace's casing convention is known here. */
const CAIP2_REFERENCE = /^[-a-zA-Z0-9]{1,32}$/;
const CAIP10_ADDRESS = /^[-.%a-zA-Z0-9]{1,128}$/;

function validateGenericCaip10(reference: string, address: string): string | null {
  if (!CAIP2_REFERENCE.test(reference)) return null;
  if (!CAIP10_ADDRESS.test(address)) return null;
  return address;
}

/** Shared core of `formatAccountLine`/`parseAccountLine`: validate one namespace's
 *  reference+address grammar. */
function validateChainAddress(namespace: string, reference: string, address: string): string | null {
  if (namespace === "eip155") return validateEip155Address(reference, address);
  return validateGenericCaip10(reference, address);
}

/**
 * Build the line to post. Throws (never a silent guess) on a non-canonical or unmapped rail id,
 * a `caip2` whose namespace does not match that rail, or an address that fails the namespace's
 * grammar — this produces a line that is about to be signed and posted, so the same
 * fail-loud-on-write rule `src/profile.ts`'s `legAContext`/`legBContext` use applies here too.
 */
export function formatAccountLine(input: { railId: string; caip2: string; address: string }): string {
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
  return `swap1 account ${railId} ${ns}:${reference}:${normalizedAddress}`;
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
  const railToken = match[1];
  const caipToken = match[2];
  if (railToken === undefined || caipToken === undefined) return null;

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

  return { railId, caip2: `${ns}:${reference}`, address: normalizedAddress };
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
}

export interface ResolvedAccounts {
  payer?: Address;
  payee?: Address;
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

    const seen = addressesByDid.get(candidate.sender) ?? new Set<string>();
    seen.add(parsed.address);
    addressesByDid.set(candidate.sender, seen);
  }

  function resolve(did: string, role: "payer" | "payee"): Address | undefined {
    const seen = addressesByDid.get(did);
    if (seen === undefined || seen.size === 0) return undefined;
    if (seen.size > 1) {
      reasons.push(`account-line: conflicting account lines for the ${role} (${did})`);
      return undefined;
    }
    const [address] = seen;
    return address as Address;
  }

  const payer = resolve(input.payerDid, "payer");
  const payee = resolve(input.payeeDid, "payee");

  return {
    reasons,
    ...(payer === undefined ? {} : { payer }),
    ...(payee === undefined ? {} : { payee }),
  };
}
