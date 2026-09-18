// SPDX-License-Identifier: MIT
//
// Fixed did:key identities for tests and fixtures, derived from the same two seeds
// `vendor/tclk/tests/transcript.test.ts` uses (`payer` / `payee` there). We don't sign
// anything here — `makeOffer`/`makeAccept` build unsigned frame objects; transport
// signing is technocore's job and out of scope for this repo — so we only need the two
// `did:key` strings, computed once (`ed25519.getPublicKey` + the `did:key` multicodec
// tag `0xed01`, base58-encoded) and hard-coded below rather than re-derived at test time,
// which would need `@noble/curves`/`@scure/base` — not on this package's allowed-import
// list (Node stdlib, `@flop-labs/tclk`, `@noble/hashes`, `./types.js`/`./profile.js`).

/** Seed `9d61b19d…` in transcript.test.ts (there: `payer`). Buyer in our fixtures. */
export const BUYER_DID = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";

/** Seed `4ccd089b…` in transcript.test.ts (there: `payee`). Seller in our fixtures. */
export const SELLER_DID = "did:key:z6MkiaMbhXHNA4eJVCCj8dbzKzTgYDKf6crKgHVHid1F1WCT";
