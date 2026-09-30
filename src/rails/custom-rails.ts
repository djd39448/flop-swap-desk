// SPDX-License-Identifier: MIT
//
// Desk-side shim for owner-namespaced custom rail ids (P6-SOL-SPEC.md section 4).
//
// tclk/1 keeps a CLOSED registry of rail ids (`CANONICAL_RAIL_IDS`); the vendored copy under
// `vendor/tclk` is never edited. The Solana leg's rail id is the owner-namespaced, versioned custom id
// shape that the tclk/2 proposal prescribes for custom rails (a caller-owned local registry), so this
// file gives the desk exactly that and nothing wider:
//
//   - `SOL_RAIL_ID` is the ONE place the Solana rail id is spelled (a test scans `src/` for a second
//     occurrence). A later rename is one edit here plus recaptured fixtures.
//   - `createCustomRailRegistry(...)` builds a caller-owned registry OBJECT. There is no module-level
//     registry, no mutable global and no setter on the object: what a registry admits is fixed when it is
//     built, and two registries never see each other. "Local configuration only, never process-global".
//   - A registry admits exactly the ids it was configured with, spelled exactly (no alias, no case
//     folding, no trimming) and never an id that tclk itself already knows (a custom id cannot shadow or
//     alias a canonical one).
//   - Everything that is not a configured custom id keeps tclk's closed-registry behaviour: an unknown id
//     still throws tclk's own error (`normalizeRailIdWith`), so this shim cannot widen what the vendored
//     library accepts.
//
// Frame emission (SB3) will call `requireAdmittedRailId`; account lines use `normalizeRailIdWith` already
// (see `src/rails/account-line.ts`).

import { normalizeRailId } from "@flop-labs/tclk";

/** The Solana leg's rail id: owner-namespaced, versioned (P6-SOL-SPEC.md section 4, decided 2026-09-30). */
export const SOL_RAIL_ID = "trustcore.sol-htlc-v1";

/** CAIP-2 namespace of the Solana leg's account lines. */
export const SOL_NAMESPACE = "solana";

/** Owner-namespaced, versioned: `<owner>.<name>-v<N>`, lowercase ASCII. */
const CUSTOM_RAIL_ID = /^[a-z][a-z0-9]{1,31}\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*-v[1-9][0-9]{0,3}$/;

export interface CustomRailSpec {
  /** The owner-namespaced id, exactly as it appears on the wire. */
  readonly id: string;
  /** The CAIP-2 namespace an account line for this rail must use. */
  readonly namespace: string;
}

/** A caller-owned, immutable set of custom rail ids. Never global. */
export interface CustomRailRegistry {
  /** True only for a configured id spelled exactly as configured. */
  has(id: string): boolean;
  /** The CAIP-2 namespace configured for `id`, or `undefined` when `id` is not admitted. */
  namespaceOf(id: string): string | undefined;
  /** The configured ids, in configuration order. */
  ids(): readonly string[];
}

/** True when tclk's own closed registry knows `id` (canonical or alias, any spelling it folds). */
function tclkKnows(id: string): boolean {
  try {
    normalizeRailId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a registry that admits exactly `specs`. Throws on a malformed id, a duplicate, an empty
 * namespace, or an id that tclk's closed registry already knows. The returned object is frozen and holds
 * its own copy of the configuration.
 */
export function createCustomRailRegistry(specs: readonly CustomRailSpec[]): CustomRailRegistry {
  const byId = new Map<string, string>();
  for (const spec of specs) {
    if (typeof spec.id !== "string" || !CUSTOM_RAIL_ID.test(spec.id)) {
      throw new Error(`custom-rails: "${String(spec.id)}" is not an owner-namespaced versioned rail id (<owner>.<name>-vN)`);
    }
    if (typeof spec.namespace !== "string" || !/^[-a-z0-9]{3,8}$/.test(spec.namespace)) {
      throw new Error(`custom-rails: "${spec.id}" needs a CAIP-2 namespace (3-8 chars of [-a-z0-9])`);
    }
    if (tclkKnows(spec.id)) {
      throw new Error(`custom-rails: "${spec.id}" collides with an id tclk already knows`);
    }
    if (byId.has(spec.id)) throw new Error(`custom-rails: duplicate rail id "${spec.id}"`);
    byId.set(spec.id, spec.namespace);
  }
  const ids = [...byId.keys()];
  return Object.freeze({
    has: (id: string): boolean => typeof id === "string" && byId.has(id),
    namespaceOf: (id: string): string | undefined => (typeof id === "string" ? byId.get(id) : undefined),
    ids: (): readonly string[] => [...ids],
  });
}

/** A registry that admits only the Solana leg's id. Every call builds a NEW object. */
export function createSolRailRegistry(): CustomRailRegistry {
  return createCustomRailRegistry([{ id: SOL_RAIL_ID, namespace: SOL_NAMESPACE }]);
}

/**
 * `normalizeRailId` extended by a caller-owned registry: a configured custom id (exact spelling) is
 * returned as is; anything else goes to tclk's own `normalizeRailId`, so an unknown or malformed id
 * throws tclk's error exactly as before. With no registry this IS `normalizeRailId`.
 */
export function normalizeRailIdWith(value: string, registry?: CustomRailRegistry): string {
  if (registry !== undefined && registry.has(value)) return value;
  return normalizeRailId(value);
}

/** Throws unless `id` is a custom id admitted by `registry` (frame emission, SB3). */
export function requireAdmittedRailId(id: string, registry: CustomRailRegistry): string {
  if (!registry.has(id)) throw new Error(`custom-rails: rail id "${String(id)}" is not admitted by this registry`);
  return id;
}
