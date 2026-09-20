# Fees

The profile carries a fee field. Every deployment we operate sets it to zero. A fee, if ever
charged, is a fixed number in an immutable contract, paid only on a completed swap, published in
advance, and the same for everyone.

This page is the one place that wording points to: what the fee field is, how it would be
enforced if it were ever nonzero, and what is true about it **today**. There is nothing to sign
up for and nothing to configure — this page exists so the claim above is checkable, not so it
can be changed quietly.

## Today: zero on every deployment we operate

Every `flop-swap-desk` deployment we run sets the fee to **zero on every deployment we
operate**. Leg A's offer declares `feeBps: 0` (`legAContext()`'s default, `src/profile.ts`); the
board shows `feeBps` for every swap, and it reads `0`. No deployment we control charges anything.

## The mechanism (how a fee would work, if one were ever nonzero)

- **Declared, signed, fixed.** Leg A's `job.context` carries `<fee-bps>` — a decimal integer
  0…10000 (basis points of leg A's `amount`, the counter-asset the Buyer pays). The Buyer signs
  it in the offer; the Seller signs it by accepting. It cannot be changed after the fact by
  either party or by us.
- **Enforced only by an immutable contract, paid only on success.** The counter-asset leg's
  escrow contract holds `feeBps` and `feeRecipient` as immutables set at deployment. A
  successful `claim` pays `amount − floor(amount · feeBps / 10000)` to the payee and the
  remainder (the fee) to the recipient, in the same transaction. A `refund` always returns
  `amount` in full to the payer — **the fee is paid only when the swap completes, never on a
  refund.** Zero-fee deployments (every deployment we operate today) use the unmodified vendored
  contract, which has no fee logic at all.
- **`floor`, not round.** The fee is `floor(amount · feeBps / 10000)`; any remainder from the
  division stays with the payee, never with the recipient.
- **Policy maximum: 100 bps.** The desk's own client refuses to bid or accept a leg-A offer
  whose declared fee exceeds **100 bps (1%)** without an explicit operator override, and refuses
  any offer whose declared bps does not match the on-chain value of the escrow it names.

## Recipient

**None published yet.** No fee recipient address exists today because no deployment we operate
charges a fee. A Phase 2 testnet recipient is TBD by Dave; a mainnet recipient (and its legal
owner) is decided at Phase 5, after the counsel read decision D-17 requires. Whenever a recipient
is published, it will be receive-only — its key will never touch a machine that also holds
trading keys.

## How a change would be announced

A nonzero fee, or a different recipient, is **a different deployment** — never a runtime toggle
on an existing one. If we ever operate one:

- it is published on this page, with the deployment's bps, contract address and recipient;
- it is pinned in the desk's own configuration, so the client refuses any leg-A offer that
  disagrees with the deployment it names;
- it is shown on the board, in the open, on every swap that uses it — never hidden or
  discretionary.

## What this page does not promise

No promises are made here about future fees, tokens, or airdrops. This page describes a
mechanism and today's setting; it is not a commitment to ever charge anything, and nothing here
should be read as one.

## See also

- `PROFILE.md` §3.7 — the profile-level specification of `<fee-bps>` and the well-formed-pair
  rule it participates in.
- `flop-contrib/SPEC-ATOMIC-SWAP-DESK.md` §3.7 — the design source (decisions D-12…D-17).
- `flop-contrib/handoff/FEES-PLAN-2026-09-19.md` — the plan this page and §3.7 implement.
