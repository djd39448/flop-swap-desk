// SPDX-License-Identifier: MIT
//
// P10 B4 (the KR3-3 rule of P9 review round 3, shared): the one way a rail module speaks of a pin's text in a refusal.
//
// A pin name, a caip2 or a network name read from a hand-written rails file has no key field, so a key (or a phrase) pasted into the
// wrong field would otherwise come back whole in the refusal, and those refusals reach terminals, logs and the output of
// `bin/watch.mjs` (the sweep's `railsConfigError`, its notes and stderr) and `examples/audit-export.mjs --rails`. A refusal therefore
// quotes such a text only when it is a short plain text (`PIN_TEXT_SHAPE`) and otherwise says `UNPLAIN_PIN_TEXT`, a fixed sentence
// that holds no byte of the value. The EVM rail has applied this rule since KR3-3; the Bitcoin rail (and its client wrapper) import it
// from here, and the NEAR and Solana rails are to do the same. This module imports nothing, so a rail and the client may both import it.

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
