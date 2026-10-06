// SPDX-License-Identifier: MIT
//
// P9-2 (rule 2, "trust a contract by its code, not its address"): the one judgement both places that touch the escrow's
// code make, so they can never disagree. `EvmHtlcRail.connect()` (live, before any write) and `evmEvidence` (over the
// captured `eth_getCode` bytes, live or replayed) both hand the raw `eth_getCode` answer and the configured
// `contractCodeHash` to `judgeRuntimeCode`; a code that is empty, malformed or hashes differently is never trusted.
//
// Everything here is public data: a code hash and a byte length. No key, no secret, no clock, no network.

import { keccak256, type Hex } from "viem";

/** `EvmRailConfig.contractCodeHash`: `0x` and 64 hex digits (either case; every comparison lowercases). */
export const CODE_HASH_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/** What `eth_getCode` answers: `0x` for no code, otherwise whole bytes of hex. */
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

export type RuntimeCodeVerdict =
  | { ok: true; observed: Hex; bytes: number }
  | { ok: false; problem: "malformed" }
  | { ok: false; problem: "empty" }
  | { ok: false; problem: "mismatch"; observed: Hex; bytes: number };

/**
 * Judges one `eth_getCode` answer against the pinned hash. `result` is whatever the node returned (untrusted: a stranger's
 * RPC response or a replayed file); `pinned` is the config's `contractCodeHash`. Never throws.
 */
export function judgeRuntimeCode(result: unknown, pinned: string): RuntimeCodeVerdict {
  if (typeof result !== "string" || !HEX_BYTES.test(result)) return { ok: false, problem: "malformed" };
  if (result.length === 2) return { ok: false, problem: "empty" };
  const observed = keccak256(result as Hex);
  const bytes = (result.length - 2) / 2;
  if (observed.toLowerCase() !== pinned.toLowerCase()) return { ok: false, problem: "mismatch", observed, bytes };
  return { ok: true, observed, bytes };
}

/** The refusal text for a verdict that is not ok (shared by the connect error and the evidence reason; both add their own prefix). */
export function describeCodeProblem(verdict: Exclude<RuntimeCodeVerdict, { ok: true }>, contract: string, pinned: string): string {
  const expected = pinned.toLowerCase();
  switch (verdict.problem) {
    case "empty":
      return `no code at ${contract} (eth_getCode returned 0x), so it cannot be the pinned contractCodeHash ${expected}`;
    case "malformed":
      return `eth_getCode for ${contract} did not return hex bytes, so the pinned contractCodeHash ${expected} cannot be checked`;
    case "mismatch":
      return `the ${verdict.bytes} bytes of code at ${contract} hash to ${verdict.observed.toLowerCase()}, not the pinned contractCodeHash ${expected}`;
  }
}
