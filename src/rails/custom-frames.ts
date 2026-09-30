// SPDX-License-Identifier: MIT
//
// Desk-side frame emission for owner-namespaced custom rail ids (P6-SOL-SPEC.md section 4, stage SB3a).
//
// tclk/1 builds and encodes frames under a CLOSED rail registry: `makeOffer` normalizes every rail through
// `normalizeRailIds`, and `encodeFrame` refuses a non-canonical rail in an offer, a lock frame or a receipt
// (`validateEmissionRails`). The vendored `vendor/tclk` is never edited, so the Solana leg's id
// (`SOL_RAIL_ID`, src/rails/custom-rails.ts) cannot pass either call. Decoding is different:
// `validateFrame` (and so `tryDecodeFrame`, `foldTranscript`, the contract machine's own lock step, which
// accepts an exact rail the offer listed) already uses tclk's wider legacy rail grammar, so a frame that
// carries the custom id READS fine; only emitting one needs help. This file is that help, and nothing more:
//
//   - `makeOfferWith(fields, registry?)` and `encodeFrameWith(frame, registry?)` take the CALLER-OWNED registry
//     (`CounterAssetRail.railRegistry`; never a module-level one). A rail id is admitted for emission only when
//     that registry has it (`requireAdmittedRailId`); every other rail keeps tclk's own closed check, with
//     tclk's own error. With no registry, or a registry that admits none of the frame's rails, both functions
//     ARE tclk's `makeOffer` / `encodeFrame` (same call, same error).
//   - For a frame with a custom rail the bytes are produced exactly as tclk's `encodeFrame` would produce them
//     (validate, canonical JSON, ASCII escape, the room-message cap, printable ASCII) with only the closed
//     emission check replaced by the registry check. tests/custom-frames.test.ts pins that equivalence.
//
// Nothing here widens what tclk accepts: a frame with an unregistered rail still throws, and a caller without
// the registry (every EVM / Bitcoin / NEAR flow) behaves exactly as before.

import { randomBytes } from "node:crypto";

import {
  MAX_FRAME_CHARS,
  TCLK_PREFIX,
  canonicalJson,
  encodeFrame,
  makeOffer,
  normalizeRailId,
  offerId,
  validateFrame,
  type OfferFields,
  type OfferFrame,
  type TclkFrame,
} from "@flop-labs/tclk";

import { requireAdmittedRailId, type CustomRailRegistry } from "./custom-rails.js";

/** True when `registry` admits at least one of `rails` (spelled exactly). */
function anyAdmitted(rails: readonly string[], registry: CustomRailRegistry | undefined): boolean {
  return registry !== undefined && rails.some((rail) => typeof rail === "string" && registry.has(rail));
}

/** One rail for emission: an admitted custom id exactly as configured, otherwise tclk's own normalization. */
function emissionRail(rail: string, registry: CustomRailRegistry): string {
  return registry.has(rail) ? requireAdmittedRailId(rail, registry) : normalizeRailId(rail);
}

type MakeOfferInput = Omit<OfferFields, "type" | "nonce" | "rails"> & { rails: readonly string[]; nonce?: string };

/**
 * tclk's `makeOffer`, with `registry`'s custom rail ids admitted in `rails`. The rail set is deduplicated and
 * sorted lexically, exactly as tclk does it; the id is tclk's own `offerId` over the body, and the result is
 * re-validated by tclk's `validateFrame` (which recomputes the id).
 */
export function makeOfferWith(fields: MakeOfferInput, registry?: CustomRailRegistry): OfferFrame {
  if (registry === undefined || !Array.isArray(fields.rails) || !anyAdmitted(fields.rails, registry)) return makeOffer(fields);
  const rails = [...new Set(fields.rails.map((rail) => emissionRail(rail, registry)))].sort();
  const body: OfferFields = {
    ...fields,
    type: "offer",
    rails,
    nonce: fields.nonce ?? randomBytes(8).toString("hex"),
  };
  return validateFrame({ ...body, id: offerId(body) }) as OfferFrame;
}

/** The rails a frame declares (an offer's list, a lock frame's, a receipt's when present). */
function frameRails(frame: TclkFrame): readonly string[] {
  if (frame.type === "offer") return frame.rails;
  if (frame.type === "lock") return [frame.rail];
  if (frame.type === "receipt" && frame.rail !== undefined) return [frame.rail];
  return [];
}

/** Escape every non-ASCII char so the stored line equals the signed line (tclk's own `toAscii`). */
function toAscii(json: string): string {
  return json.replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * tclk's `encodeFrame`, with `registry`'s custom rail ids admitted for emission. A frame none of whose rails
 * the registry admits is encoded by tclk's own `encodeFrame` (so its closed check and error are unchanged).
 * Otherwise every rail must be admitted by the registry or canonical for tclk (an unknown id throws), and the
 * line is built exactly as tclk builds it.
 */
export function encodeFrameWith(frame: TclkFrame, registry?: CustomRailRegistry): string {
  const validated = validateFrame(frame);
  const rails = frameRails(validated);
  if (registry === undefined || !anyAdmitted(rails, registry)) return encodeFrame(frame);
  for (const rail of rails) {
    if (registry.has(rail)) continue;
    const canonical = normalizeRailId(rail);
    if (canonical !== rail) throw new Error(`tclk: non-canonical rail id: ${rail}; use ${canonical}`);
  }
  if (validated.type === "offer" && new Set(validated.rails).size !== validated.rails.length) {
    throw new Error("tclk: rails must not contain duplicates");
  }
  const line = TCLK_PREFIX + toAscii(canonicalJson(validated));
  if (line.length > MAX_FRAME_CHARS) {
    throw new Error(`tclk: frame exceeds the ${MAX_FRAME_CHARS}-char room-message cap (${line.length})`);
  }
  if (!/^[\x20-\x7e]*$/.test(line)) throw new Error("tclk: frame line contains non-printable-ASCII characters");
  return line;
}
