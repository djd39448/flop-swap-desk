// SPDX-License-Identifier: MIT
//
// P10 B4 (the KR3-3 rule of P9 review round 3, shared): the one way a rail module speaks of a pin's text in a refusal.
//
// A pin name, a caip2 or a network name read from a hand-written rails file has no key field, so a key (or a phrase) pasted into the
// wrong field would otherwise come back whole in the refusal, and those refusals reach terminals, logs and the output of
// `bin/watch.mjs` (the sweep's `railsConfigError`, its notes and stderr) and `examples/audit-export.mjs --rails`. A refusal therefore
// quotes such a text only when it is a short plain text (`PIN_TEXT_SHAPE`) and otherwise says `UNPLAIN_PIN_TEXT`, a fixed sentence
// that holds no byte of the value. The EVM rail has applied this rule since KR3-3; the Bitcoin, NEAR and Solana rails (and their client
// wrappers) import it from here. This module imports nothing, so a rail and the client may both import it.

/**
 * The shape of a pin name or caip2 a refusal may quote: 1 to 40 letters, digits and `: _ . -` (`base-sepolia`, `anvil-local`,
 * `eip155:84532`, `bip122:` plus 32 hex digits). It is the runner's own `PIN_TEXT` (src/client/rehearsal-config.ts holds its pin
 * fields to this same shape). A 64-hex run (a genesis hash, a key) is never this shape, whatever it is.
 */
export const PIN_TEXT_SHAPE = /^[A-Za-z0-9:_.-]{1,40}$/;

/**
 * How a refusal speaks of a pin text that is NOT a short plain text (`PIN_TEXT_SHAPE`): it never quotes it. The sentence is fixed and
 * reads after "got", "is" or "network", so it carries no article of its own.
 */
export const UNPLAIN_PIN_TEXT = "a pin name (or caip2) that is not a short plain text";

/** The text between double quotes when `text` is a short plain text, and `null` when it is anything else (a value that must not be quoted). */
export function quotedPinText(text: unknown): string | null {
  return typeof text === "string" && PIN_TEXT_SHAPE.test(text) ? `"${text}"` : null;
}

/** `quotedPinText(text)`, or `UNPLAIN_PIN_TEXT` when the text is not a short plain text: for a refusal that has no other way to name the value. */
export function quotedPinTextOrPlaceholder(text: unknown): string {
  return quotedPinText(text) ?? UNPLAIN_PIN_TEXT;
}

/** How many leading characters of a pinned hash a refusal may show: eight, far below the 16-hex window of the key scanners, as `shortPinnedHash` does for the EVM code hash (K2). */
const PINNED_VALUE_SHOWN_CHARS = 8;

/** A pinned hash as the configs of this build hold one: a single run of letters and digits (lowercase hex for a Solana program hash, base58 for a NEAR code hash), 16 to 128 characters. */
const PINNED_VALUE_SHAPE = /^[A-Za-z0-9]{16,128}$/;

/**
 * How a refusal speaks of a pinned value that is NOT in the shape of a hash (a phrase, a sentence, anything with a space or a symbol): it never quotes any of it. Fixed,
 * like `UNPLAIN_PIN_TEXT`.
 */
export const UNPLAIN_PINNED_VALUE = "a pinned value that is not a hash";

/**
 * P10 B4 (the K2 rule of P9 review round 1, for the NEAR code hash and the Solana program hash): a pinned hash has the same shape as a private key (64 hex digits, or a base58
 * run of the same weight), and a config check cannot tell one from the other, so a refusal never prints a pinned hash in full. This is its first eight characters between double
 * quotes and `...` (`"5CVXgVR5..."`), when it is one run of letters and digits, and `UNPLAIN_PINNED_VALUE` for anything else. The observed hash (public code) is the one a refusal may print whole.
 */
export function shortPinnedValue(text: unknown): string {
  return typeof text === "string" && PINNED_VALUE_SHAPE.test(text) ? `"${text.slice(0, PINNED_VALUE_SHOWN_CHARS)}..."` : UNPLAIN_PINNED_VALUE;
}
