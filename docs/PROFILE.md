# The swap profile (`job.proto = "swap"`)

Version: profile v1.1 (adds leg A's `<fee-bps>` segment, §3.3; the v1.0 4-segment grammar
still reads, as `feeBps: 0`).

Status: draft, Phase 0 (keyless, no posts). Design source: `flop-contrib/SPEC-ATOMIC-SWAP-DESK.md`
§3 (this document rewrites that section for an outside `tclk/1` implementer who has never seen
the FLOP repos). Nothing here has been proposed upstream, posted, or deployed.

## 1. Purpose

`tclk/1` (Technocore Lock Protocol) gives two agents a signed transcript and one settlement-rail
interface per contract — but a `tclk/1` contract is a single directional HTLC payment: one payer,
one payee, one rail. Trading FLOP against another chain's asset needs **two** such contracts,
each on a different rail, that succeed or fail together. `tclk/1`'s own extension author (sv,
`flop-labs/tclk#57`/`#58`) explicitly defers "routed, general atomic-swap, multipart, and
point/adaptor profiles" — this is that missing layer, built entirely on top of the existing wire
format.

This is a **convention**, not a protocol change. It adds no new frame type and changes no
existing field. Everything it needs rides in `offer.job`, the one extension point `tclk/1`'s
schema already reserves (`{proto, id, context?}`, `schema/tclk1-frames.schema.json`,
`additionalProperties: false`). Any conforming `tclk/1` client — including ones that have never
heard of this document — can build, accept, lock, reveal and refund the two legs; only a client
that wants to *recognize* the pairing needs to read `job` the way this document says to.

The FLOP-network HTLC this profile ultimately settles against is yellow paper v0.5.0 §10 (states
CREATED → SETTLED | REFUNDED; requirements R10.1–R10.5). §10.2 of the yellow paper is explicit
that pairing a FLOP-leg HTLC with a second chain's HTLC is an open conformance question
(E.48, tracking issue flop-core#1498): direction, chain/asset binding, timeout orientation,
per-leg finality, and relayer recovery are all unratified there. This document is one concrete,
documented answer to that question, built above `tclk/1` rather than by changing §10's runtime.

## 2. Roles and the secret-ownership rule (decision D-01)

- **Seller** sells FLOP. **Buyer** pays the counter-asset (USDC on an EVM chain first; BTC and
  NEAR are later phases, §8 of the SPEC).
- **The Seller always holds the secret.**

Why this orientation and not its mirror image, in two independent facts this profile did not
invent:

1. **`tclk/1`'s acceptor mints the statement.** §3.2 of the `tclk/1` SPEC: for a hash lock, "the
   payee mints the preimage... and sends `statement = sha256(preimage)`". The *acceptor* of an
   offer is always the one who mints — there is no way, inside `tclk/1` as written, for the
   offer's opener to be the one who knows the secret. (sv lists this — "condition creation
   through the acceptor field rather than the payee role" — as a wart of `tclk/1`, `#57`; this
   profile works with the primitive as shipped rather than waiting for a v2.)
2. **Yellow paper R10.2 (timelock symmetry) is oriented.** R10.2 requires
   `T_FLOP ≥ T_other + margin` — the FLOP-leg timelock must be the *longer* one, by construction.
   If the Buyer held the secret, the Seller's FLOP leg would need to be the *short* leg for the
   Seller to have a safe reveal window, which is exactly backwards from what R10.2 requires when
   FLOP is `T_FLOP`. The only orientation that satisfies R10.2 as the yellow paper wrote it is
   the one where the FLOP leg is long, which forces the FLOP leg's payer (the Seller) to be the
   one who accepts it — and therefore, by fact 1, the one who mints.

Putting the two together: the Seller must be the acceptor of the counter-asset leg (to mint the
one shared secret) and the payer of the FLOP leg (so the FLOP leg is the long leg R10.2 needs).
**Consequently, v1 bids are Buyer-initiated**: the Buyer opens leg A as `role: "payer"`. A Seller
who wants to advertise interest posts a request-for-bids using the discovery convention in SPEC
§3.6 (an ordinary room line or DID-note token, not a `tclk/1` frame) and waits for a bid — it
never opens leg A itself. A Seller-opened leg-A offer (`role: "payee"`) would hand the secret to
the Buyer and invert R10.2's orientation; a compliant watcher marks such an offer
`orientation:unsupported` and a compliant client refuses to accept it (`checkOrientation` in
`src/profile.ts` implements exactly this refusal — see §3 below).

## 3. Two contracts, one statement

| leg | offer opened by | payer → payee | asset | rail | who mints `statement` | timelock |
|---|---|---|---|---|---|---|
| A | Buyer (`role: payer`) | Buyer → Seller | counter-asset | `evm-htlc` / `btc-htlc` / `near-htlc` | Seller, at accept (`H = sha256(s)`) | short |
| B | Seller (`role: payer`) | Seller → Buyer | `FLOP` | `flop-htlc` | Buyer, at accept, **copying `H` from leg A** | long |

Leg B's acceptor (the Buyer) never learns the preimage `s` from minting — it only needs `H` to
put in its own `accept.statement`. The Buyer learns `s` when the Seller's leg-A `reveal` lands in
leg A's deal room (world-readable by design — `tclk/1` SPEC §1, §7), then posts its own `reveal`
on leg B, satisfying `tclk/1`'s "payee only" reveal guard (§3.4) because the Buyer is leg B's
payee.

### 3.1 `job.context` grammars

Both legs carry `job.proto = "swap"` and the same `job.id = swapId`. `swapId` is
`0x` + `sha256("FLOP::swap::v1|" + buyerDid + "|" + nonce)` — the Buyer mints the nonce
(`src/profile.ts:swapId`). This is a domain-tagged hash exactly like `tclk/1`'s own `offerId`/
`contractId` (`tclk/1` SPEC §3.1, `TCLK_DOMAIN`), just with its own domain string so a `swap` id
can never collide with a `tclk/1` offer or contract id.

```
leg A (v1.1)  job.context = "a|<want-asset>|<want-amount>|<want-rail>|<fee-bps>"
leg A (v1.0)  job.context = "a|<want-asset>|<want-amount>|<want-rail>"        → reads as feeBps 0
leg B         job.context = "b|<leg-A offer id>"                              (unchanged)
reserved      job.context = "f|<leg-B offer id>|<fee-amount>"                (fee leg, Phase 3/F4; parses to null until then)
```

- Leg A's context states what the Buyer wants for the counter-asset it pays: the FLOP amount (in
  the chain's minimal unit) and rail (`flop-htlc` in v1). `wantAsset` matches `tclk/1`'s asset
  grammar; `wantAmount` is a decimal integer with no leading zero; `wantRail` MUST already be
  canonical per `tclk/1` SPEC §5's rail-id grammar — a context naming `FLOP-HTLC` or
  `flop-htlc.` is rejected, not silently normalized, because the context is inside the
  Ed25519-signed offer and normalizing it after the fact would let two implementations disagree
  about what was signed.
- **`<fee-bps>` (v1.1, §3.3):** a fifth segment, `^(0|[1-9][0-9]{0,3}|10000)$` — a decimal integer
  0…10000, no leading zeros, no sign, no decimals, basis points of leg A's `amount`. A 4-segment
  leg A (the v1.0 grammar) is still read, as `feeBps: 0`, so Phase 0 vectors and the
  2026-09-18 rehearsal fixture stay valid. `legAContext()` (`src/profile.ts`) emits the 5-segment
  form, defaulting `feeBps` to `0` when the caller omits it.
- Leg B's context names leg A's **offer id** (not the `swapId`) so a fold can pair the two legs
  without trusting `swapId` alone — the offer id is itself a hash committing to leg A's full
  content, so leg B is provably answering that specific offer and no other. Leg B carries no fee
  in v1.1.
- `job.context = "f|…"` is **reserved** for the Phase 3 fee leg (§3.3, F4) — a third `tclk/1`
  contract under the shared statement `H`, needed only once a claiming agent holds FLOP keys
  online. It is not implemented in v1.1: `parseSwapContext` always returns `null` for it.
- `parseSwapContext` (`src/profile.ts`) is fail-closed: exactly one of the grammars above parses;
  anything else — wrong part count, a non-canonical rail spelling, a malformed amount, asset or
  fee-bps, an offer id that is not `0x` + 64 lowercase hex — returns `null`, never a guess and
  never a throw.

### 3.2 The well-formed-pair predicate

A pair of offers is a well-formed swap iff **all** of:

1. Both `job.proto == "swap"` and `job.id` (the `swapId`) is equal on both.
2. Leg B's context names leg A's offer id.
3. Leg A: `role == "payer"`, `lock == "hash"`, `asset != "FLOP"`, `rails` does **not** include
   `flop-htlc`, its context's `wantRail == "flop-htlc"`, and its context's `<fee-bps>` parses
   (§3.3).
4. Leg B: `role == "payer"`, `lock == "hash"`, `asset == "FLOP"`, `rails` includes `flop-htlc`.
5. The two offers name the same two DIDs with roles crossed (leg A's `from` is the Buyer, leg B's
   `from` is the Seller, and leg A's counterparty at accept is leg B's `from` and vice versa).
6. Leg B's accepted `statement` equals leg A's accepted `statement`.
7. The deadlines satisfy §5 below.

Rules 3–4 are `checkOrientation` in `src/profile.ts` (decision D-01, §2 above); classifying which
grammar a `job.context` matches is `classifySwapOffer`. Rules 5–6 (cross-checking the two
accepted contracts) and the fold that actually walks a transcript to find candidate pairs are the
board's job (`SPEC-ATOMIC-SWAP-DESK.md` §4 P0.2), not this document's — this document specifies
the predicate, not the code that walks live transcripts to evaluate it. Anything that fails any
rule is `unpaired` and never advances a swap's composite state.

### 3.3 Fees (profile v1.1; design source SPEC §3.7, decisions D-12…D-17; plan in `flop-contrib/handoff/FEES-PLAN-2026-09-19.md`)

The profile carries a fee field. Every deployment we operate sets it to zero. A fee, if ever
charged, is a fixed number in an immutable contract, paid only on a completed swap, published in
advance, and the same for everyone.

- **Declared, signed, fixed.** Leg A's context carries `<fee-bps>` (§3.1): a decimal integer
  `^(0|[1-9][0-9]{0,3}|10000)$`, basis points of leg A's `amount` (the counter-asset the Buyer
  pays). The Buyer signs it in the offer; the Seller signs it by accepting. The 4-segment v1.0
  grammar is still read (`feeBps: 0`), so Phase 0 vectors and the 2026-09-18 rehearsal fixture
  stay valid.
- **Enforced only by an immutable contract, paid only on success.** On the counter-asset leg the
  escrow contract (`EvmHashRailFee.sol`, derived from the vendored `EvmHashRail.sol`) holds
  `feeBps` and `feeRecipient` as immutables: a successful `claim` pays
  `amount − floor(amount · feeBps / 10000)` to the payee and the remainder to the recipient in
  one transaction; a `refund` returns `amount` in full to the payer. Zero-fee deployments use the
  unmodified vendored contract. A different fee or recipient is a different deployment, published
  in `docs/FEES.md` and pinned in the desk's own config — never chosen at runtime.
- **Client and board rules.** A compliant client refuses any leg-A offer whose declared bps
  differs from the on-chain value of the escrow it names, or whose recipient is not the published
  one; it refuses bids or accepts above a policy maximum (default 100 bps = 1%) without an
  explicit override. The board shows `feeBps` and the escrow address for every swap; nothing
  about fees is hidden or discretionary.
- **Recipient is receive-only.** The fee address per chain is one the desk operator controls; its key never
  touches this machine. G1 (trading keys) does not gate the recipient (D-14).
- **FLOP-side fee is Phase 3 (F4), not v1.1.** FLOP has no contract layer, so a fee on the FLOP
  leg can only be a third `tclk/1` contract to the desk under the same shared statement `H`
  (`job.context = "f|<leg-B offer id>|<fee-amount>"`, `claimBy ≥ B.claimBy`) — it needs a
  claiming agent with FLOP keys online, so it is designed and decided in Phase 3. v1.1 only
  reserves the prefix: `parseSwapContext` returns `null` for it (§3.1).
- **Every deployment we operate sets the fee to zero until Phase 5**, when the mainnet number,
  the recipient and its legal owner are decided after the counsel read decision D-17 requires.
  No promises are made here about future fees, tokens, or airdrops — see `docs/FEES.md`.

## 4. Sequence

```
Buyer                                   board (tclk-offers)                              Seller
  │── offer A (pay USDC, want FLOP, job swap) ──────▶│                                       │
  │                                                  │◀── accept A (mints s, statement H) ───│
  │                                                  │◀── offer B (pay FLOP, job swap→A) ────│
  │── accept B (statement = H) ──────────────────────▶│                                       │
  │                                                  │                                       │
  │              [deal room B]                       │           Seller locks FLOP under H, T_FLOP (long)
  │◀──────────── lock B (ref = FLOP escrow id) ──────────────────────────────────────────────│
  │  Buyer verifyLock(B) via own FLOP read path                                              │
  │              [deal room A]                       │                                       │
  │── lock A (ref = evm escrow) ─────────────────────────────────────────────────────────────▶│
  │                                           Seller verifyLock(A) via own EVM read path     │
  │◀──────────── reveal A (secret s; Seller claims USDC on chain) ───────────────────────────│
  │  Buyer reads s, claims FLOP on chain (redeem_htlc)                                       │
  │── reveal B (secret s) ───────────────────────────────────────────────────────────────────▶│
  │── receipt A / B ◀──▶ receipt A / B                                                        │
```

`accept`/`offer` for both legs live in `tclk-offers` (`tclk/1` SPEC §2 — a contract id needs both
halves public before either side can derive the deal room); everything from `lock` onward moves
to each leg's own derived, signed-only deal room. Leg B locks **before** leg A (the secret holder
locks first — rule 4 of §5 below); a compliant client refuses to lock A until `verifyLock(B)` is
true at its own finalized view of the FLOP chain.

## 5. Deadlines (SPEC §3.5) — the part that makes it atomic

Let `A.claimBy < A.refundAfter` and `B.claimBy < B.refundAfter` (`tclk/1`'s own per-contract
invariant, SPEC §3.1). Before accepting or locking, a compliant client enforces, in wall-clock ms:

1. **`A.refundAfter − lockTime ≥ minRevealWindowMs`** — the Seller's real window to reveal on
   chain A after seeing lock A (a rail-specific inclusion margin the caller supplies; `tclk/1`'s
   own `validateDeadlines` states the same rule — "there is no safe universal default").
2. **`B.claimBy ≥ A.refundAfter + finalityAMs`** — the Buyer must still be able to redeem FLOP
   after the *latest possible* Seller reveal, plus chain A's finality/observation lag.
3. **R10.2, translated to blocks from `lockTime`:**
   `tFlop ≥ timelockSymmetryMinimumBlocks(tOther, p, maxFinalityStall, finalityLag)`, where
   `tOther = blocksBetween(lockTime, A.refundAfter, flopBlockMs)`,
   `tFlop = blocksBetween(lockTime, B.refundAfter, flopBlockMs)`, and

   ```
   timelockSymmetryMinimumBlocks(tOther, p, maxFinalityStall, lag)
       = tOther + max(ceil(tOther * p / 100), maxFinalityStall + lag)
   ```

   which is yellow paper R10.2 verbatim (`docs/flop-yellowpaper-v0.5.0.md`, §10.1):
   `T_FLOP ≥ T_other + max(ceil(T_other·p/100), max_finality_stall + current_finality_lag)`,
   `p = htlc_timelock_symmetry_safety_margin_percent = 20`, FLOP blocks are 1 second (§2). This
   desk does not enforce R10.2 a second time against the chain — `flop-htlc` (once wired to a
   real FLOP RPC) re-derives it at `lock()` and `verifyLock()` and refuses a short escrow on its
   own; the desk's check exists so a client fails before spending a message or a lock attempt,
   not instead of the rail's own check.
4. **Lock order: B before A.** Not a deadline arithmetic rule — it depends on which `lock` frames
   were actually observed, so it is the fold's job (SPEC §4 P0.2), not the profile's or the
   deadline checker's.

`src/deadlines.ts` implements rules 1–3 as `checkSwapDeadlines(legA, legB, lockTimeMs, policy)`.
It is fail-closed: any malformed operand anywhere — a leg's deadline, `lockTimeMs`, or a policy
field — becomes a violation string and `ok: false`, never an exception. Every violation names the
numbers involved (e.g. `"rule 3: tFlop 7199 blocks < required 7200 blocks..."`) so a failure is
auditable without re-deriving the arithmetic by hand.

### Worked example

EVM L2 leg A, FLOP leg B, lock time `t0`:

| field | value |
|---|---|
| `A.claimBy` | `t0 + 45 min` |
| `A.refundAfter` | `t0 + 60 min` |
| `B.claimBy` | `t0 + 70 min` (≥ 60 min + 10 min finality) |
| `B.refundAfter` | `t0 + 3 h` (10 800 FLOP blocks — well above the 7 200 R10.2 requires, for slack) |

With `minRevealWindowMs = 30 min`, `finalityAMs = 10 min`, `p = 20`, `maxFinalityStallBlocks =
3600`, `finalityLagBlocks = 0`, `flopBlockMs = 1000` (`DEFAULT_POLICY_EXAMPLE` in
`src/deadlines.ts`, exported under that name — no silent default): `tOther = 3600` blocks,
required `= 3600 + max(720, 3600) = 7200` blocks, `tFlop = 10800 ≥ 7200` — the pair is `ok`. The
Seller is exposed for 3 hours; the Buyer for 1 hour (the "free option" residual, §7 below).

## 6. Abort paths

- **Buyer never locks A** → Seller `refund`s B after `T_FLOP`. Nobody's funds are at risk; the
  Seller's FLOP was never released.
- **Seller never reveals** → Buyer `refund`s A after `T_other`; Seller `refund`s B after
  `T_FLOP`. Neither side loses principal; the Buyer loses the option time it waited (§7).
- **Either side `cancel`s** before any lock exists — `tclk/1`'s own `cancel` frame, unchanged.

## 7. What this profile does not claim

- **No end-to-end atomicity claim is conforming.** Yellow paper E.48 (chain-pair qualification,
  §10.2, tracking flop-core#1498) is explicitly open — direction, per-leg finality, timeout
  orientation and relayer recovery for a *named pair* are unratified there. This profile is one
  documented, reviewable answer to those questions built on top of `tclk/1`; it is not itself a
  ratification of E.48, and nothing produced by this repo should be presented as one until E.48
  closes.
- **R10.2 is a necessary admission condition, not a timely-inclusion guarantee** (yellow paper
  §10.1's own words about R10.2). Satisfying the formula in §5 above means the *margin* is wide
  enough; it says nothing about whether a given transaction is actually included before its
  deadline.
- **Hash-lock only.** `tclk/1`'s point/adaptor path is unaudited reference crypto, not BIP-340,
  and `flop-labs/tclk#171` refuses point locks on the `flop-htlc` rail outright. `checkOrientation`
  rejects any offer with `lock != "hash"` for exactly this reason (§10.3's residual risk
  discussion and `tclk/1` SPEC §7 both flag the adaptor module as "unaudited reference
  cryptography... not for mainnet value flows").
- **MAD-HTLC (yellow paper §10.3) is a residual risk, not a solved one.** A rational counterparty
  can bribe fee-maximizing block authors to withhold an honest redeem/refund until the timelock
  flips; the local FLOP contract proves only that at most one of redeem/refund succeeds (R10.1),
  never that a redeem lands in time. Wide windows narrow the exposure; they do not remove it.
- **The "free option" is disclosed, not solved.** The second locker (the Buyer, per D-01) can
  wait to see the price move before locking A, at the cost of the Seller's window; the SPEC's
  threat-model table (§6) lists the mitigations this desk applies at later layers (short leg-A
  windows, reputation-tiered size caps, recorded `abandoned` outcomes) — none of which live in
  this profile or in `src/deadlines.ts`, which only checks that the windows a caller supplies are
  internally consistent.
- **No relayer, no custody, no fee.** `flop-htlc`'s `relay_preimage` (R10.4, a root-managed
  allowlist) is not used by this profile — each party redeems its own leg. This document defines
  no fee model (SPEC §7, §9 D-06).

## 8. Test vectors

`fixtures/vectors.json` (generated and checked byte-for-byte by `tests/vectors.test.ts`) is one
complete, deterministic swap pair built with `@flop-labs/tclk`'s own `makeOffer`/`makeAccept`/
`canonicalJson`/`encodeFrame` — the worked example from §5 above, with two fixed `did:key`
identities, fixed nonces, and a fixed (non-secret) 32-byte preimage, so every value in it is
reproducible from the source alone.

For this repo's checked-in vectors (regenerated for profile v1.1 — leg A's context now has five
segments, `…|flop-htlc|0`, so leg A/B offer id, contract id and deal room changed from the v1.0
vectors; `swapId` did not, since it hashes only the buyer DID and nonce, never the context):

- `swapId`: `0x73f7f4ef83a7da782f5f72f952db20fad75f99b76e6e374ea1a1e0dc88116995` (unchanged)
- leg A `offerId`: `0x4b9fc7e830d489c0942b598d86d2929bc9aaa6cfd78796b6cab526b1975fbc27`
- leg A `contractId`: `0xc91eb92501b6d2a3f9d9289a8cc316bb49667da763c0cb47cafa6c6697b006d5`
  (deal room `mb-p-tclk-c91eb92501b6d2a3`)
- leg B `offerId`: `0x4c4c316777a8759d936f1a09029ad0fab1df7f9ba73a423018d9138acdd98f2e`
- leg B `contractId`: `0xd326a2290f6e5b4ba79e05e685c94f069a94fc5754ba1f47fc87c4b09bbdf94d`
  (deal room `mb-p-tclk-d326a2290f6e5b4b`)
- `deadlineCheck.ok`: `true` (the §5 worked example, verbatim)

Regenerate with `WRITE_VECTORS=1 npx vitest run tests/vectors.test.ts` after reviewing the diff —
the file is a checked-in golden, not build output.

## 9. References

- `SPEC-ATOMIC-SWAP-DESK.md` §3, §3.5, §4, §6, §7, §9 (`flop-contrib`, this design's source).
- Yellow paper v0.5.0 (`flop-contrib/docs/flop-yellowpaper-v0.5.0.md`): §10 (HTLC state machine),
  R10.1–R10.5, §10.2 (chain-pair qualification, E.48), §10.3 (incentive robustness, MAD-HTLC),
  §6.5 (account/key formats per chain).
- `tclk/1` SPEC (`vendor/tclk/SPEC.md`): §2 (transport binding, rendezvous, deal rooms), §3.1–3.4
  (`offer`/`accept`/`lock`/`reveal` fields and guards), §5 (settlement rails, the closed rail
  registry, `flop-htlc`).
- `flop-labs/tclk#171` (`FlopHtlcRail`, `timelockSymmetryMinimum`, `blocksUntil`) — the rail-side
  re-derivation of R10.2 this profile's deadline checker cross-checks against, independently
  verified by bdunn77 (2026-09-18).
