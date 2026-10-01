# flop-swap-desk

A non-custodial atomic swap desk for FLOP: trade FLOP against another chain's asset with two
hash time-locked escrows, one shared secret, and no one in the middle holding anything.

- **Profile** (`docs/PROFILE.md`): how two ordinary [`tclk/1`](https://github.com/flop-labs/tclk)
  contracts declare themselves the legs of one swap using only the signed `offer.job` field.
  No new frame types, no wire change; any tclk/1 client can speak it.
- **Board + watcher** (`src/board.ts`, `src/watcher.ts`, `bin/watch.mjs`): a read-only fold of
  the `tclk-offers` room and each swap's derived deal room, using tclk's own fail-closed
  `foldTranscript`, that pairs legs, derives a composite swap state, and keeps a byte-exact
  audit trail. It holds no keys and cannot post, lock, claim, or refund.
- **Deadline checker** (`src/deadlines.ts`): the timelock rules that make the two legs atomic,
  including yellow paper R10.2 timelock symmetry in the orientation this profile fixes.
- **Client** (not yet built): the party-side agent that holds *your* keys and drives the rails.

Design document: `SPEC-ATOMIC-SWAP-DESK.md` in
[djd39448/flop-contrib](https://github.com/djd39448/flop-contrib).

## Status

The profile is **v1.1**: leg A's offer carries a fee field (`feeBps`), and it is zero on every
deployment we run — see `docs/FEES.md`.

**Alpha, Phase 0, keyless.** Nothing here moves value. There is no FLOP testnet RPC yet; the
FLOP leg is bound through tclk PR #171's mock chain only. The only rail with a read path today
is tclk's `paper` rail (`vendor/tclk/src/paper-rail.ts`) — a rehearsal surface that holds no
value and whose records anyone can overwrite; the board can fold a fully-rehearsed swap all the
way to `settled` on paper evidence, but every reason trail it produces says so
(`"paper rail: rehearsal only, no value"`). **The Phase 0 verdict is choreography only (`PaperRail`
verifies 4 of 9 `LockTerms` fields, tclk#180):** the fold independently checks all nine before a
leg counts as locked (`src/swap.ts`, §3.4 of `docs/PROFILE.md`), but the paper rail's own record
can only ever attest to `status`/`lock`/`statement`/`refundAfterMs` — so a `settled` paper
rehearsal proves the choreography and the pairing rules, never amount or payee integrity. Chain
rails (`evm-htlc`, `flop-htlc`, …) still have no read path, so a swap settling for real cannot
advance past `paired` today — by design, not by accident (fail closed). Every end-to-end
atomicity claim remains PENDING until yellow paper open item E.48 closes, and this repository
does not present one.

## The one rule that makes it work

The **Seller of FLOP always holds the secret**. It accepts the Buyer's counter-asset leg (leg A)
and mints the hash statement; it opens the FLOP leg (leg B) whose acceptor copies the same
statement. Leg B is always the long timelock. That single orientation satisfies R10.2 as the
yellow paper wrote it and tclk/1's acceptor-mints-statement rule at the same time. Bids are
therefore Buyer-initiated in v1; a Seller advertises with the DID-note token `swap1:sell-flop`
and waits for a bid.

## Build and test

```bash
npm install
npm test
```

`@flop-labs/tclk` is vendored as a git submodule (`vendor/tclk`) pinned to upstream `main`
commit `5cc4ab9`, because the npm release `0.1.0` predates the transcript fold this desk
depends on. `npm test` builds it first. Clone with `--recurse-submodules`.

## Audit replay

`examples/audit-export.mjs --root DIR [--expect <swapId>=<status>] [--json]` reproduces a
watch root's board — every swap's status, reasons, buyer/seller DIDs, the offer-room and
deal-room seqs it was derived from, and each rail's `finalizedRef` — purely from what
`src/watcher.ts` already wrote to `DIR/raw/`. It opens no network connection: the offer-room
export(s), each deal room's capture(s), any paper-rail note(s), and (once a chain rail is
configured — see "EVM leg" below) any captured EVM chain reads are read straight off disk and
folded through the same `foldCaptured` (`src/replay.ts`) the live watcher uses.

**What this replay proves, and what it does not (P22-P24-EVM-FIXES-R3.md F3).** Re-reading a
capture this way detects a capture file that was *damaged, truncated, spliced from another
capture, answered for a different request, or taken under a different rail config*, and fails
that leg closed. It does **not** detect forgery: a fabricated or edited RPC response, saved
under the sha256 of its own new bytes, replays exactly as a genuine one would, and nothing
proves the capturing process told the truth about the chain to begin with — this build adds no
signing keys to close that gap. For a chain leg, the independent
check is its own `finalizedRef`: it names a real block hash, so anyone with their own RPC
access to that chain can re-query `locks(hashLock)` at that exact block and compare, without
trusting this repository or whoever ran the sweep.

### Evidence is bound to the pair it belongs to (tclk#194 review, 2026-09-28)

Two rules the fold enforces on every rail (paper, `evm-htlc`, `btc-htlc`, `near-htlc`):

1. **A rail observation is used only if it is bound to the leg's accepted pair.** A
   `RailObservation` (`src/types.ts`) now carries `rail`, `ref`, `contract` and a copy of the
   nine `LockTerms` it was checked against, filled by every evidence reader from the same
   values as its `LockEvidence`. `src/swap.ts` (`bindObservation`) refuses an observation
   unless its rail and ref equal the accepted lock frame's, its contract equals the leg's
   accepted contract, and all nine terms equal the accepted offer/accept pair's own
   `lockTerms()`. A refused observation is dropped from `SwapView.evidence`, a reason is
   recorded, and it counts toward none of funded, claimed, refunded or settled. `LockEvidence`
   must likewise name the accepted rail and ref before a leg counts as locked.
2. **`swapId` is not a unique key.** It is a hash of the buyer's DID and a nonce the buyer
   picks, so one buyer can sign two different pairs with the same one. Board evidence
   (`BoardInput.evidence`) is keyed by each leg's own contract id (the contract the tclk fold
   itself accepted), and each swap gets a `pairKey` (`<leg A offer id>|<leg A contract>|<leg B
   contract>`); two pairs never share evidence. A shared `swapId` is information only: when
   several leg-A offers signed by the same buyer carry one `swapId`, each of those swaps gets a
   reason saying so, and nothing is blanked. Another signer copying a swap's public `swapId`
   into an offer of their own is not reported and changes nothing for the victim. Only genuine
   accepts (the contract id tclk derives from the offer and the accept's own core, not signed
   by the offerer) key candidates and evidence, and leg B pairs with the DID that accepted leg
   A (the earliest leg B stands in, marked coordination-only, only while leg A has no accept).
   The watcher tracks each swap under its own pair key, and `audit-export --expect` accepts a
   `pairKey` and reports a shared `swapId` as ambiguous.
3. **A refund frame never folds a chain leg on its own.** For a leg on a chain rail (anything
   but `paper`), `refunded`, `refunded-a` and `refunded-b` need a bound rail observation that is
   `refunded` and final; a refund frame without one is reported as "not corroborated by chain
   evidence" and does not fold, on every path.

The capture and evidence file formats are unchanged (the binding is computed at replay time
from the same terms), so no fixture was recaptured.

`fixtures/rehearsal-2026-09-18/` is a byte-exact, watch-root-shaped capture of the real
2026-09-18 G0 rehearsal on `paper` — the four `tclk-offers` lines that made the pair, both
deal rooms' lock/reveal/receipt, and both paper notes fetched once, live, with curl. Run it:

```bash
node examples/audit-export.mjs --root fixtures/rehearsal-2026-09-18 \
  --expect 0xb0fa70a3c2a914134967fa423ae3295c2e35b6c3dfd6d461fb7a17fef2430d46=settled
```

## EVM leg (local, keyless)

`src/rails/evm-htlc.ts` binds the vendored `EvmHashRail` (`src/vendor/evm-hash-rail.ts`,
`contracts/EvmHashRail.sol`) into a desk rail with a chain pin (an allow list accepts only
`anvil-local` 31337 and `base-sepolia` 84532, each tied to its one pin name; everything else is
refused, mainnets by name), byte-exact JSON-RPC capture (`src/rails/rpc-capture.ts`) so every verdict can be
re-derived from the exact bytes it rested on, and a fail-closed finalized-view read
(`src/rails/evm-evidence.ts`) shared between the live path and the offline replay. `src/client/`
(`venue.ts`, `seller.ts`, `buyer.ts`, `bundle.ts`) drives both parties of one swap end to end —
the counter-asset leg on `evm-htlc`, the FLOP leg on tclk's own `paper` rail (there is still no
real FLOP chain adapter) — against a real, local `anvil` node, with the D-08 account-line
exchange (`src/rails/account-line.ts`) in between.

Run it:

```bash
npm run test:anvil
```

This builds `dist/` and the contracts, then spawns a real `anvil` node (found via `ANVIL_BIN`,
`%USERPROFILE%\.foundry\bin\anvil`, or PATH — see `tests-anvil/helpers/anvil.ts`) and drives
`tests-anvil/evm-htlc.anvil.test.ts` (the adapter alone: chain-pin refusal, approve+lock,
`verifyLockFinal` before/after finality, claim, refund, `findClaimedPreimage`) and
`tests-anvil/client-flows.anvil.test.ts` (the Seller/Buyer flows end to end: the happy path to
`settled`; both refund paths, `refunded` and `refunded-b`; a claim refused before
`verifyLockFinal(A)` is `true` and allowed two blocks later; the Buyer learning the secret from
the on-chain `Claimed` log alone when the Seller never posts a reveal frame). `npm test` never
spawns `anvil` — a missing binary fails `test:anvil` loudly instead.

**Fixture capture is opt-in.** Every client-flow scenario writes its watch-root bundle to a
fresh `mkdtemp` directory by default, so an ordinary `npm run test:anvil` never touches the three
committed fixtures below. Regenerating them (after a change to the capture index format, the
evidence bundle shape, or the client flows themselves) is a deliberate, separate step:

```bash
CAPTURE_EVM_FIXTURES=1 npm run test:anvil
```

which overwrites `fixtures/evm-anvil-2026-09-28/{settled,refunded,refunded-b,squat}/` in place. Commit
the result and then confirm both that `tests/evm-anvil-fixtures.test.ts` (hermetic, `npm test`)
replays it and that a plain `npm run test:anvil` afterward leaves `git status` clean.

An ordinary (non-capture) run removes its own `mkdtemp` bundle directories once the suite
finishes, so `npm run test:anvil` never leaves anything behind under the OS temp dir; set
`KEEP_ANVIL_BUNDLES=1` to keep them around for inspecting a scenario's exact written bundle by
hand.

**Keyless throughout (D-10):** no private key, mnemonic, or seed for any EVM account exists
anywhere in this build — writes go out as JSON-RPC accounts (`eth_sendTransaction` from one of
anvil's own unlocked addresses) via a plain-address viem `WalletClient`. tclk's Ed25519 test
identities (`tests/helpers/identity.ts`) sign the deal-room transcript; they are not wallet keys.

**The claim endpoint sees the real preimage once, at the one moment it must.** Before
`EvmHtlcRail.claim` ever sends a real transaction, it runs two preimage-free simulations against
the configured RPC endpoint (`eth_call`, never broadcast): a zero-preimage `claim()` that must
revert with exactly the contract's own "secret does not open the statement" reason (proving the
lock exists, is open, and is still inside its window), and a simulated ERC20 payout impersonated
from the rail contract's own address (proving the transfer itself is not blocked, e.g. by a
blacklist or a pause). Neither of those ever carries the real secret. Only once both hold does
the real `claim(hashLock, preimage)` transaction go out — and broadcasting is inherently public,
so the configured RPC endpoint (and anyone else watching that transaction) does see the real
preimage at that final step. The endpoint a deployment's `EvmRailConfig.endpoint` points at must
therefore be one the operator trusts with that; this build never sends a claim before it has to.

**What this proves, and what it does not.** The three committed fixtures
(`fixtures/evm-anvil-2026-09-28/{settled,refunded,refunded-b,squat}/`, replayed hermetically by
`tests/evm-anvil-fixtures.test.ts`) show a real ERC20 escrowed, claimed or refunded on a real
EVM contract, with every verdict re-derivable from the exact captured RPC bytes — but on
`anvil-local` (chain id `31337`), an ephemeral node this repo itself starts and stops, never a
real network, and never with mainnet value at any point in this build (D-09/D-10). The
Base Sepolia deploy (P2.5) — a real testnet, a real key loaded from env and never printed, the
account lines exchanged for real — is Dave's own G1 step and is not built here.

Re-deriving a verdict from the captured bytes (see "Audit replay" above, F3) detects the bytes
being tampered with after the fact — never that the capturing process told the truth about the
chain to begin with. The independent check is each leg's own `finalizedRef`
(`anvil-local:finalized:<n>:<blockHash>`, or `base-sepolia:...` once P2.5 deploys): it names a
real block on the chain it was read from, so anyone with their own RPC access to that chain can
re-query `locks(hashLock)` at that exact block hash and compare against what this build
reported, independent of this repository entirely.

### Proof-of-control account lines (all three chain legs; closes R3-1, 2026-09-30)

The on-chain HTLC does not commit to the tclk contract id, so chain evidence alone shows that a lock
with these terms exists, not which tclk contract it belongs to. Before this change a stranger could
build a mirror pair (their own offers and accepts, a different contract id per leg) that re-posted a
real swap's account or pubkey lines and borrowed its on-chain evidence to fold to `settled`. The
account and pubkey lines are now proofs of control (`handoff/P7-ACCOUNT-PROOF-SPEC.md`).

**The guarantee.** Every D-08 account or pubkey line carries `proof <scheme>:<signature>[ <key>]`, a
signature by the chain key that controls the account over the exact message
`FLOP::swap::account-proof::v1|<did>|<contract id>|<rail id>|<account>`, where `did` is the sender
of the record that carries the line and `contract id` is the leg's tclk contract. A line counts only
if its record verifies, its sender is the party's DID, it precedes the accepted lock, and its proof
verifies for that sender, that contract, that rail and that account. A line without a verifying
proof is unresolved and fails closed, in the Buyer and Seller flows (`postAccountLineA` posts the
proven line, through the party's own connected handle; each side resolves only proven lines), the
evidence readers, the live watcher, the replay, the bundle and `audit-export`. A mirror pair has
other DIDs and other contract ids, so the victim's proofs do not verify for it: its payee stays
unresolved, its chain leg reads `railVerified` null with the reason and is never attributed the
victim's observation, it does not fold to `settled`, and the victim still does
(`tests/mirror-pair.test.ts`, over the committed settled fixture of each chain). A capture whose
lines lack proofs replays the same way, with the payee unresolved. Schemes by rail:

- `evm-htlc`: `eip191`, an EIP-191 `personal_sign` by the account; verified by recovering the
  address. Anvil's node-held accounts sign over RPC, so no key is in this repo's code.
- `btc-htlc`: `bip322`, a BIP-322 simple signature for the P2WPKH address of the pubkey line's key,
  signed keylessly by the node wallet (`walletprocesspsbt`) and verified with `@scure/btc-signer`;
  the BIP's published vectors are pinned in `tests/btc-proof.test.ts`.
- `near-htlc`: `nep413`, a NEP-413 signed message by a key of the account; the line carries the
  public key, and the capture reads `view_access_key(account, key)` at the same finalized block as
  the rest of the evidence and requires a FullAccess permission (a function-call key, a key the
  account does not hold, another account's key, a missing or mismatched read all give
  `railVerified` null). The key lives in an in-memory signer (D-N2).

**Its exact scope.**

- It proves that the party who posted a line controls the named chain account (or key) and meant it
  for this contract and this DID. It does not make the chain lock itself commit to the contract id:
  the on-chain lock format, the contracts and the vendored files are unchanged.
- It stops the mirror pair that does not control the victim's accounts. A stranger who does control
  the accounts it names (its own real lock, or a party colluding with the victim) is not stopped
  by this and is not claimed to be: that is a swap, not a mirror of someone else's.
- EVM proofs are EOA signatures. A contract account (EIP-1271) has no `eip191` proof and is
  refused. The Bitcoin proof is for the P2WPKH address of the key, not for the funded P2WSH.
- **Both parties' lines are required (fix pass, 2026-09-30).** On every chain leg a lock verifies only
  when the payee's AND the payer's proven lines resolve and match the chain lock (Bitcoin already
  needed both pubkeys). Before, the payer's line was optional corroboration, so the Buyer's own
  counterparty (who knows the hash lock and controls the payee account) could build a sock-puppet
  pair that borrowed the Buyer's real lock. `BuyerFlow.lockLegA` now refuses to lock until its own
  proven payer line resolves, and the Seller's claim check needs it.
- **Only lines posted before the accepted lock count on all three chains** (EVM replay and watcher
  previously also counted later lines; a late line could change a settled swap's verdict).
- NEAR's key-on-account check is a read at the capture's finalized block, so **the board** (replay,
  watcher, bundle, `audit-export`) reads it again on every capture: a key that is later deleted or
  rotated withdraws that capture's verification and its claimed/refunded observation, so a settled
  swap can regress on the board until the key is back. Nothing about funds changes. **A participant's
  own flow never reads the keys** (`keyControl: "flow"`): the Buyer cannot stall the Seller's claim
  by deleting its key (no free option), and a rotated key never blocks a refund confirmation. The
  lines are still required and signature-proven in the flows; only the key-on-account read is
  skipped there. A capture taken before this change has no key read and replays unverified.
- **Known limit (NEAR account recycling).** The key read is at the capture's block, not the lock's.
  If the victim's payee account is deleted and its name re-registered by an attacker (anyone can
  create a sub-account under a public registrar) who adds its own key, a mirror pair could then
  borrow the victim's historical claimed lock and verify. This needs the victim's account to be
  deleted and re-created; archival reads at the lock's block would close it and are not done. EVM
  and Bitcoin are not affected (the address or pubkey is the key).
- EVM proofs are canonical: the high-s twin of a signature is refused.
- The `rails.json` and capture formats gained the key reads for NEAR only; every chain fixture was
  recaptured once for this change (the deal-room lines changed). The 2026-09-18 paper rehearsal is
  unaffected. Solana adopts the same rule (`ed25519`) when its branch is rebased onto this one.

### Known limits of the EVM leg (recorded 2026-09-28 after three review rounds)

None of these can move value to the wrong party or reveal the secret without payment; each is
written down instead of hidden.

- **The FLOP leg is paper.** tclk's `paper` rail records only the lock kind, statement,
  refund time and status (tclk#180: four of nine terms), so the Buyer's check that leg B is
  locked cannot confirm leg B's amount or payee on a rail; the desk checks them from the signed
  offers instead. A real FLOP rail replaces this in Phase 3.
- **The replay shows the newest capture per input, not each sweep's view.** A sweep that could
  not read a leg's deal room (a fetch failure, or the `maxDealRooms` cap) writes no marker, so
  the offline replay can show that leg's older evidence while that sweep's live board showed
  none. This is staleness, never fabrication: every chain verdict names its own
  `finalizedRef` block. (A failed chain read or an unreadable newest capture index does fail
  the leg closed in both places.)
- **A lock whose evidence lookup fails is not announced.** If leg A's lock transaction mines but
  the adapter's bounded event lookup then fails, `BuyerFlow.lockLegA` throws before posting the
  `lock` frame. The funds stay safe (`refundLegA` works from the recorded hash lock and the chain
  itself after `refundAfterMs`), but the board shows leg A as never funded.
- **A claim's last guard still has two round trips after it.** viem's chain-id assertion and
  `eth_sendTransaction` follow the final deadline check, each a single attempt (transport retries
  are off) bounded by the RPC timeout (45 s by default), well inside the 5-minute
  claim-inclusion margin.
- **The claim endpoint is trusted with the preimage** at the moment the claim is sent (see
  above).

## Bitcoin leg (local, keyless)

`src/rails/btc-script.ts` builds the P2WSH HTLC (`andor(pk(payee),sha256(H),and_v(v:pk(payer),
after(T)))`, `@scure/btc-signer`'s `Script`/`p2wsh` coders — byte-identical to what Bitcoin Core
31.1 itself compiles, verified against a live regtest node,
`handoff/research/btc-regtest-probe-2026-09-28.md`), `src/rails/btc-htlc.ts` binds it into a desk
rail with a chain pin (an allow list accepts only `regtest` and an as-yet-unverified `signet`
pin; `main`/`test`/`testnet4` are refused by name) and keyless writes (fund/claim/refund) through
a bitcoind wallet's own `walletprocesspsbt` — never a private key, WIF, xprv, seed or mnemonic
anywhere in this build (P4-BTC-SPEC.md §1) — and `src/rails/btc-evidence.ts` is the fail-closed,
"capture live then decide" finalized-view reader shared between the live path and the offline
replay, the Bitcoin twin of `src/rails/evm-evidence.ts`. `src/client/btc-rail.ts` implements the
same `CounterAssetRail` interface `src/client/evm-rail.ts` does (`src/client/counter-rail.ts`,
"one client, many rails"), so `src/client/seller.ts`/`buyer.ts` drive a `btc-htlc` leg through the
identical Seller/Buyer flow, with a P2WSH script committing to **both** parties' public keys
(unlike an EVM EOA lock) exchanged as a D-08 pubkey line (`swap1 pubkey btc-htlc bip122:<genesis
prefix> <pubkey> proof bip322:<sig>`, `src/rails/account-line.ts`) rather than an address line.

Run it:

```bash
npm run test:regtest
```

This builds `dist/`, then spawns a real `bitcoind -regtest` node (found via `BITCOIND_BIN`, the
Bitcoin Core 31.1 install path baked into `tests-regtest/helpers/bitcoind.ts`, or PATH) with two
named descriptor wallets (`buyer`, `seller`) and drives `tests-regtest/btc-htlc.regtest.test.ts`
(the primitive and adapter alone: the witnessScript/address matching Core's own compiler, a real
keyless claim, the refund's non-final-until-median-time-past-reaches-`T` behaviour, a
wrong-preimage claim rejected by `testmempoolaccept`, `findClaimPreimage` recovering the secret)
and `tests-regtest/client-flows.regtest.test.ts` (the Seller/Buyer flows end to end: the happy
path to `settled`; both refund paths, `refunded` and `refunded-b`; a claim refused before this
file's own 2-confirmation finality and allowed once it is reached; the Buyer learning the secret
from the chain alone when the Seller never posts a reveal frame; a well-formed claim — right
secret, right script, right fee — refused by `testmempoolaccept`, and never broadcast, once its
own outpoint has already been spent by the Buyer's refund). `npm test` never spawns `bitcoind` — a
missing binary fails `test:regtest` loudly instead.

**Fixture capture is opt-in**, identical in shape to the EVM leg's own `CAPTURE_EVM_FIXTURES`:
every client-flow scenario writes its watch-root bundle to a fresh `mkdtemp` directory by
default, so an ordinary `npm run test:regtest` never touches the four committed fixtures below.
Regenerating them is a deliberate, separate step:

```bash
CAPTURE_BTC_FIXTURES=1 npm run test:regtest
```

which overwrites `fixtures/btc-regtest-2026-09-28/{settled,refunded,refunded-b,squat}/` in place.
Commit the result and then confirm both that `tests/btc-regtest-fixtures.test.ts` (hermetic,
`npm test`) replays it and that a plain `npm run test:regtest` afterward leaves `git status`
clean. An ordinary (non-capture) run removes its own `mkdtemp` bundle directories once the suite
finishes; set `KEEP_REGTEST_BUNDLES=1` to keep them around for inspecting a scenario's exact
written bundle by hand (and `KEEP_BITCOIND_DATADIR=1`, `tests-regtest/helpers/bitcoind.ts`, to
keep the node's own throwaway datadir).

**Keyless throughout (P4-BTC-SPEC.md §1):** every key this build ever handles is public — a
33-byte compressed pubkey, a BIP32 master fingerprint, an HD derivation path (all read off a
wallet's own `getaddressinfo`) — and every write goes out through that wallet's own
`walletprocesspsbt`, which signs and finalizes a hand-built PSBT (`witness_utxo` +
`witnessScript` + `bip32_derivation`, plus the BIP174 `sha256` preimage field for a claim) using
whichever of its own already-owned keys the derivation names. `dumpprivkey`, `dumpwallet` and
`listdescriptors true` are never called anywhere in this build, and the node's own RPC cookie
(a random local credential for a throwaway node) is read from its throwaway datadir and handed to
every call only as an HTTP Basic-auth header — never written into a rail config, a captured
exchange, a bundle, or a log.

**The real claim is checked before it is ever broadcast.** `BtcHtlcRail.claim()` verifies the
secret actually opens the hash lock, rebuilds the expected script and checks the funding output
against it, then runs `testmempoolaccept` on the fully-signed transaction — and only once that
passes does `sendrawtransaction` ever run. A claim that would fail (a stale outpoint already
spent by a refund, as scenario 6 above exercises; a policy the local mempool would otherwise
reject) is refused with the node's own reject-reason and never sent.

**What this proves, and what it does not.** The three committed fixtures
(`fixtures/btc-regtest-2026-09-28/{settled,refunded,refunded-b,squat}/`, replayed hermetically by
`tests/btc-regtest-fixtures.test.ts`) show a real P2WSH HTLC funded, claimed or refunded on a
real Bitcoin Core 31.1 node, with every verdict re-derivable from the exact captured RPC bytes —
but on `regtest`, an ephemeral node this repo itself starts and stops, never a real network, and
never with mainnet value at any point in this build. The signet deploy is Dave's own G1 step and
is not built here — `BTC_SIGNET_PIN` (`src/rails/btc-htlc.ts`) is present but named
`"btc-signet-UNVERIFIED"` and refuses to match a live node until its genesis hash has actually
been confirmed against one.

Re-deriving a verdict from the captured bytes (see "Audit replay" above, F3) detects the bytes
being tampered with after the fact — damaged, truncated, spliced from another capture, answered
for a different request, or taken under a different rail config — never that the capturing
process told the truth about the chain to begin with, and never forgery: a fabricated or edited
RPC response, saved under the sha256 of its own new bytes, replays exactly as a genuine one
would. The independent check is each leg's own `finalizedRef`
(`btc-regtest:confirmations-<N>:<height>:<blockHash>`): it names a real block on the chain it was
read from, so anyone with their own RPC access to that chain can re-query the same outpoint at
that exact block hash and compare against what this build reported, independent of this
repository entirely.

### Known limits of the Bitcoin leg

Each is written down instead of hidden. The first is a real risk that only the timing margins
bound (a party that misses its window can lose); none of the others can move value to the wrong
party or reveal the secret without payment.

- **No claim deadline on chain, so after `T` the claim and the refund race, and losing is
  dangerous.** The hash branch of the HTLC stays spendable until the refund branch is spent;
  Bitcoin Script has nothing like the EVM contract's `claim` deadline, only the CLTV `after(T)`
  guarding the refund. After `T` the Seller's claim and the Buyer's refund compete for the same
  outpoint, and full replace-by-fee is on by default in Bitcoin Core 28 and later. A Seller whose
  claim loses has already published the secret in the mempool, so the Buyer can take the FLOP leg
  as well as its refund. A Buyer whose refund is replaced by a later Seller claim loses the BTC
  unless it learns the secret from that claim and claims the FLOP leg before `B.claimByMs`. What
  protects each side is timing, not fees (fees are a fixed constant and this build never
  fee-bumps): the Seller's client claims only while `max(chain time, clock)` leaves at least 60
  minutes before `A.refundAfterMs` (`BTC_LOCAL_POLICY.claimInclusionMarginMs`), re-checked as the
  last step before broadcast; the Buyer's rule-2 margin (`finalityAMs`, 3 h) keeps `B.claimBy`
  open long enough after `T` to learn the secret from a late claim — including one the Seller has
  only broadcast, not yet mined: `learnSecret` (via `findClaimedPreimage`) checks the mempool
  first (`gettxspendingprevout`, then the spender's own witness), never only the bounded block scan
  (P4-BTC-FIXES-R3.md K1). `BuyerFlow.refundLegA` reads the outpoint's own state — a pending or
  already-mined claim included — on every call, retries included, *before* building or re-sending
  a refund, and routes to
  `learnSecret()`/`claimLegB()` with a clear reason the moment one is found, rather than racing a
  doomed broadcast (K2); once it does build one, it reports a refund only once it confirms, and
  re-sends the same recorded refund if it dropped out of the mempool. `claimByMs` itself is
  enforced only by the Seller's own client, and none of this removes the underlying race after
  `T` — it only ensures each side's own client sees the same chain/mempool state the other one
  does, as early as its own next read.
- **Two lost-reply cases end with the money right but the frames missing.** (1) If the Seller's
  claim broadcast reply is lost and the claim is mined before the retry, `claimLegA` refuses on the
  retry (the lock now reads `claimed`), so the Seller's reveal and receipt frames are never posted;
  the Seller already has the BTC and the Buyer still learns the secret from the chain. (2) If the
  Buyer's refund broadcast reply is lost and the refund is mined (and its output spent) before the
  retry, `refundLegA` fails with the node's raw rejection instead of posting its refund frames; the
  Buyer already has its BTC back. In both cases the watcher's evidence still shows the leg's real
  state from the chain.
- **The refund waits for median time past, which lags wall clock.** `T = refundAfterMs / 1000` is
  checked against the chain's median time of its last 11 blocks (BIP113), not the tip block's own
  timestamp or wall-clock "now" — so a refund's real, chain-observable availability lags
  `refundAfterMs` by roughly an hour on a normally-mining chain (probe gotcha,
  `src/rails/btc-script.ts`'s own `locktimeFromRefundAfterMs` doc comment).
  `BTC_LOCAL_POLICY.finalityAMs` (3 h — the ~1 h MTP lag plus a further budget for the refund's own
  confirmation, since a refund is not reported until confirmed) budgets for this.
- **The replay detects damage and splicing, not forgery.** Identical honesty limit to the EVM
  leg's own (see above) — re-reading a capture proves internal consistency and lets anyone
  independently re-query the named block; it does not prove the capturing node was telling the
  truth about the chain to begin with.
- **A lock write that never returns still leaves the outpoint recoverable.** `BuyerFlow.lockLegA`
  builds and signs the funding transaction (`prepareLock`) and records its own outpoint — already
  fully determined by the transaction's own bytes, never assigned by the network — *before* ever
  broadcasting it (`commitLock`). If the broadcast itself then fails, or a flaky read loses the
  response after a genuine broadcast, `lockLegA` throws before posting the `lock` frame, but
  `refundLegA`/`learnSecret` still work from the recorded outpoint (P4-BTC-FIXES.md G3), the same
  as the EVM leg's own pre-recorded hash lock (see its "Known limits" entry above) — this no longer
  needs the EVM-only fallback a `btc-htlc` leg could not previously use, since the outpoint is
  known before the write ever runs rather than only once it returns. A failure before
  `prepareLock` itself completes (nothing yet signed) leaves the board correctly showing leg A as
  never funded — fail closed, never fail silent.
- **Fees are a fixed constant, not estimated.** `DEFAULT_FEE_SATS` (`src/rails/btc-htlc.ts`) is
  subtracted from every claim/refund's single output; real fee estimation is out of scope for
  this build (P4-BTC-SPEC.md §0).
- **One node, one confirmation policy, no reorg handling.** This build's own regtest harness
  mines on demand and never reorgs; a real deployment choosing how many confirmations count as
  final for a given amount, and how to handle a reorg past that depth, is out of scope here.

## NEAR leg (local sandbox in WSL)

`contracts-near/` (a Cargo workspace: `htlc`, `mock-ft`) is a first-party, unaudited NEAR
contract pair — see `contracts-near/README.md` for the full guarantees list. `src/rails/
near-borsh.ts` is a small first-party borsh transaction writer (D-N1: no `near-api-js`, no
`@near-js/*`, no near-workspaces), `src/rails/near-rpc.ts` a thin fetch JSON-RPC client, `src/
rails/near-htlc.ts` the desk-facing `near-htlc` adapter (a chain pin allow-listing only
`near-sandbox-flop`/`testnet`, keyless writes through an in-memory `NearSigner`, D-N4's
sign-and-record-then-broadcast split so a write's own ref/txHash is known before it ever
broadcasts), and `src/rails/near-evidence.ts` the pure, fail-closed finalized-view evidence
reader, the NEAR twin of `src/rails/evm-evidence.ts`/`src/rails/btc-evidence.ts`. `src/client/
near-rail.ts` implements the same `CounterAssetRail` interface the EVM/Bitcoin legs do, so `src/
client/seller.ts`/`buyer.ts` drive a `near-htlc` leg through the identical Seller/Buyer flow.
Unlike Bitcoin's dual-pubkey script, a `near-htlc` leg posts a single D-08 ACCOUNT-id line per
party (`swap1 account near-htlc near:<chain id>:<account id> proof nep413:<sig> <key>`, D-N5) — the contract authorizes
by NEAR account id (`predecessor_account_id`), not by a pubkey the script itself commits to.

Run it:

```bash
npm run test:near
```

This builds `dist/`, then (inside WSL Ubuntu, Rust 1.98.1 + `wasm32-unknown-unknown`,
near-sandbox 2.13.4/protocol 86 — `contracts-near/README.md`'s own build instructions,
`tests-near/probe/README.md`'s WSL-invocation gotcha) builds both contracts, spawns a real
throwaway `near-sandbox` node (chain id `near-sandbox-flop`, D-N3), and drives `tests-near/
near-htlc.near.test.ts` (the adapter alone: lock, claim, wrong-preimage refusal, refund timing,
a malformed `ft_transfer_call` msg refunded in full, an unregistered-payee claim forced past its
own pre-check, `recoverByTxHash` against a completed write (and a timeout-class error for an
unknown hash), the H1-H6 chain-confirmation, revealed-lock-retry and code-hash-pin scenarios, and
the evidence reader end to end — this
is also where D-N9's real gas measurement was taken and `FT_TRANSFER_CALL_GAS`/
`CLAIM_REFUND_GAS` corrected from their provisional 100/60 Tgas to the measured 20/40 Tgas) and
`tests-near/client-flows.near.test.ts` (the Seller/Buyer flows end to end: the happy path to
`settled`; both refund paths, `refunded` and `refunded-b`, the Buyer's own refund crossing
`refundAfterMs` via `sandbox_fast_forward`'s real advance of the FINAL block's own timestamp,
D-N7; a claim refused before a finalized on-chain lock exists at all and allowed once the Buyer
actually locks — NEAR's own twin of the Bitcoin leg's "before N confirmations" scenario, since
`send_tx`'s own `wait_until: "FINAL"` leaves no observable "broadcast but not yet final" window
for a write that actually happened; the Buyer learning the secret from `get_lock` alone with no
reveal frame ever posted; a claim to an unregistered payee refused before ever sending a
transaction; a retry of a refused claim once the payee registers; and `recoverByTxHash` against a
completed write, called on the rail directly in a client-flow scenario; the hermetic
`tests/client-flows-near-rpc.test.ts` additionally pins the reveal handling below). Recovery in the client
flows is by hash-lock state (`get_lock`, the reader the flows re-derive their evidence from), not
by transaction hash: `recoverByTxHash` is a rail primitive pinned against a write that did
complete, and neither flow calls it. The lock is the only two-step write
(`prepareLock` signs and records the ref and transaction hash, `commitLock` broadcasts; the
sandbox suites also run the squat scenario at adapter level and through the client flows: a third
account locks under the swap's hash lock first, the Buyer's lock still lands, the Seller claims it
and the squatter refunds only its own unit);
`claim` and `refund` are single calls. `npm test` never spawns `near-sandbox`, builds no contract and opens no WSL process — a
missing toolchain or sandbox binary fails `test:near` loudly instead (P4-BTC-SPEC.md §7a's own
lessons checklist, reused here).

**Fixture capture is opt-in**, identical in shape to the EVM/Bitcoin legs' own
`CAPTURE_EVM_FIXTURES`/`CAPTURE_BTC_FIXTURES`: every client-flow scenario writes its watch-root
bundle to a fresh `mkdtemp` directory by default, so an ordinary `npm run test:near` never
touches the four committed fixtures below. Regenerating them is a deliberate, separate step:

```bash
CAPTURE_NEAR_FIXTURES=1 npm run test:near
```

which overwrites `fixtures/near-sandbox-2026-09-29/{settled,refunded,refunded-b,squat}/` in place.
Commit the result and then confirm both that `tests/near-sandbox-fixtures.test.ts` (hermetic,
`npm test`) replays it and that a plain `npm run test:near` afterward leaves `git status` clean.
An ordinary (non-capture) run removes its own `mkdtemp` bundle directories once the suite
finishes; set `KEEP_NEAR_BUNDLES=1` to keep them around for inspecting a scenario's exact written
bundle by hand (and `KEEP_NEAR_SANDBOX_HOME=1`, `tests-near/helpers/sandbox.ts`, to keep the
sandbox's own throwaway WSL home under `/tmp`).

**Keyless throughout except one sandbox-only bootstrap key (D-N2):** the ONLY key this build
ever reads off disk is the throwaway sandbox's own `test.near` validator key, read exactly once
into memory (`wsl.exe -- cat`, never a `bash -lc` string, never logged, never written to disk on
the Windows side, never returned from `tests-near/helpers/sandbox.ts` in any form) and used only
to sign the four `CreateAccount` transactions that bootstrap the buyer/seller/token/contract
accounts. Every account past that point — including both parties' own swap-signing keys — is a
fresh, in-memory, zero-value ed25519 keypair this process itself generates
(`InMemoryNearSigner.generate`), never written to disk, never printed, never in a fixture. This
is a deliberately narrower exception than the Bitcoin/EVM legs' own fully keyless design (NEAR
has no node-side signer the way a bitcoind wallet or anvil's own accounts do), approved by Dave
specifically for the sandboxed build (`handoff/P5-NEAR-SPEC.md` §1: "yes, in-memory throwaway
keys are fine").

**The ref names the payer, so hash-lock squatting is fixed.** The contract keys each lock by
(payer, hash lock) and the NEAR ref is `0x<hash lock hex>:<payer account id>` (`src/rails/
near-ref.ts`: `0x` + 64 lowercase hex + `:` + a valid NEAR account id, anything else is invalid).
It is known before any write (the payer is the Buyer's own signer), so record-before-send still
holds. Any holder of the configured token can still lock 1 unit under a public hash lock first,
but that lock sits under the squatter's own key and no longer blocks the Buyer's. The adapter's
`claim`, `refund`, `findClaimedPreimage`, `checkPendingClaim` and post-write re-reads take the ref
and pass the payer through (`refund` requires the ref's payer to equal the signer); the evidence
reader requires the captured `get_lock` request to name exactly the ref's hash lock and payer
(`{hash_lock, payer}`, nothing else) and the on-chain payer to equal the ref's payer, and a payer
account line, when present, must agree too; the Seller's G5 rule is now "the accepted lock frame's
ref must parse and its hash-lock part must equal my own hash lock", taking the payer from the ref
(the lock frame is the Buyer's signed record). Captures stay keyed by (hash lock, leg contract);
each index records the full ref, and the fold requires it to equal the accepted lock frame's own.
Contract signatures and the storage-key layout: `contracts-near/README.md`. A pre-fix bare
hash-lock ref, or one naming another hash lock, is rejected everywhere.

**The contract pin is part of the evidence, not only of `connect()` (H8).** Each capture also reads
`view_account` and `view_access_key_list` for the HTLC contract, pinned to the same final block hash
as `get_lock`, and the reader binds both like `get_lock` (request type, contract account, block
hash; the result must itself name that block). It reports a verdict only when the contract's
`code_hash` equals the config's `htlcCodeHash` and it holds zero access keys; otherwise
`railVerified` is null with the reason. `htlcCodeHash` also joins the captured-versus-auditor config
comparison, so a capture taken under a different pin never replays under the auditor's. The fixed
read order is now status, block, `get_lock`, `view_account`, `view_access_key_list`, then
`storage_balance_of` (only when a payee account line exists), then one `view_access_key` per proven
line's key (see "Proof-of-control account lines"); fixtures taken before H8 lack the two reads and
replay as unverified until recaptured.

**A claim is checked before it is ever broadcast.** `NearHtlcRail.claim()` verifies the preimage
actually opens the hash lock, reads a fresh `Locked` state still inside its window, and confirms
the payee is storage-registered on the token — all before anything is signed. A "locked" verdict
from the evidence reader proves only that the payee was storage-registered at that block;
the payee can still be unregistered afterwards, so it does not prove a later payout will land (the
adapter checks again immediately before each claim, and after the write re-reads `get_lock` to
confirm the chain agrees, H1). `notAfterMs` is re-checked against fresh chain time as the
very last read before broadcast. A claim that would fail any of these (the wrong preimage, a
lock that's expired or already resolved, a payee who was never storage-registered) is refused
client-side and never sent at all.

**Who a claim pays, and what a lock write proves (H9, H10, H12, H13).**
- *H12.* Before signing, `claim()` requires the lock's payee to be the expected payee (the signer
  itself, or the payee of the terms the caller passes; the client rail passes the leg's own terms)
  and the lock's token, amount and both times to equal them. Without expected terms only payee
  (the signer) and token are checked.
- *H9.* `commitLock` accepts a lock only when this transaction's own outcome says the whole amount
  was used (`ft_transfer_call` resolves to the used amount as a JSON string: `"10"` for a made
  lock, `"0"` for a refusal, both observed on a real sandbox) and the lock is `Locked` with the
  exact terms. A refusal (`NearLockRefusedError`, "tokens returned") is claimed only when the outcome
  says `"0"`; anything the outcome and the chain do not settle, including a lock not visible after
  one re-read at a later final block, throws `NearLockUnknownError` ("call reconcileLockA"), which
  does not say the tokens came back. A second identical lock attempt is therefore refused rather
  than mistaken for the first one.
- *H10.* `recoverByTxHash(txHash, sender, expectedRef)` waits for `FINAL`, decodes the transaction
  (signer and key, receiver, method, arguments) and recovers only this rail's own lock, claim or
  refund for that ref (`NearUnexpectedTransactionError` otherwise), then applies the same
  kind-specific post-checks and typed errors as a send.
- *H13.* Every read the rail makes has an explicit short timeout (`NEAR_PRESEND_READ_TIMEOUT_MS`,
  5 s; `send_tx` and the transaction lookup wait for finality and are not bounded by it). The claim's
  pinned-chain check now runs before its deadline guard, so the guard is the last read before
  broadcast, and `NEAR_CLAIM_LANDING_MARGIN_MS` (30 s) exceeds the timeout plus a few blocks.
  The read timeout abandons the call rather than cancelling it: an abandoned request may still
  complete and appear in the capture log.

**What this proves, and what it does not.** The four committed fixtures
(`fixtures/near-sandbox-2026-09-29/{settled,refunded,refunded-b,squat}/`, replayed hermetically by
`tests/near-sandbox-fixtures.test.ts`) were recaptured once after H8 (the code-hash and access-key
reads are in the captured bytes), and the replay checks in that test pass. They show a real `htlc` contract funded, claimed or refunded on
a real near-sandbox 2.13.4 node (`refunded-b` carries no NEAR bytes at all: the Buyer never locked
leg A, so it shows only the paper-rail fold and the absence of any NEAR write), with every verdict re-derivable from the exact captured RPC
bytes — but on a throwaway sandbox this repo itself starts and stops, never a real network, and
never with mainnet value at any point in this build. `NEAR_TESTNET_PIN` (`src/rails/
near-htlc.ts`) is present but named `"near-testnet-UNVERIFIED"` and refuses to match a live node
until this build has actually connected to NEAR testnet and confirmed it.

Re-deriving a verdict from the captured bytes detects the bytes being tampered with after the
fact — damaged, truncated, spliced from another capture, answered for a different request, or
taken under a different rail config — never that the capturing process told the truth about the
chain to begin with, and never forgery: a fabricated or edited RPC response, saved under the
sha256 of its own new bytes, replays exactly as a genuine one would (identical honesty limit to
the EVM/Bitcoin legs' own). The independent check is each leg's own `finalizedRef`
(`near-sandbox:final:<height>:<blockHash>`): it names a real block on the chain it was read from,
so anyone with their own RPC access to that chain can re-query the same lock at that exact block
hash and compare against what this build reported, independent of this repository entirely.

### Known limits of the NEAR leg

Each is written down instead of hidden, per the same discipline the EVM and Bitcoin legs' own
"Known limits" sections follow — only what this build's own tests actually prove is claimed here.

- **Reused, not re-derived, deadline margins.** `NEAR_LOCAL_POLICY` (`src/client/policy.ts`)
  reuses `EVM_LOCAL_POLICY`'s own `minRevealWindowMs` (45 min) and `finalityAMs` (20 min)
  verbatim, by D-N8's own explicit design ("not re-derived, pending NB-int's own live sandbox
  timing"). This stage measured the sandbox's own real timing (Doomslug finality in ~2 blocks,
  roughly 1.2-1.5 s at the sandbox's own ~0.6-0.7 s/block cadence — an order of magnitude faster
  than even anvil's near-instant EVM blocks) but did not tighten the shared constant to match,
  since doing so would need to stay green against every other suite that already pins today's
  numbers — out of scope for this stage's own deliverable. A real NEAR deployment's own margins
  are accordingly wider than the chain's own finality lag strictly requires, not narrower.
- **One throwaway sandbox node, no reorg handling.** Like the Bitcoin leg's own regtest node,
  this build's sandbox is a single node this repo itself starts and stops; it never reorgs, and a
  real deployment's own choice of what counts as final, and how to handle a reorg past that
  point, is out of scope here.
- **A malformed `ft_transfer_call` msg refunds in full, but the payer's storage stays touched
  for the duration.** `ft_on_transfer` returning the full amount for an invalid `msg` (an
  unparseable JSON body, a duplicate hash lock, a window violation) is the token's own standard
  NEP-141 refund path (near-contract-standards), not something this build's own contract code
  implements — verified working (`tests-near/near-htlc.near.test.ts`'s own malformed-`msg`
  scenario) but not owned by this repo's own code.
- **An unregistered payee's claim reveals the preimage without paying out.**
  `contracts-near/README.md`'s own documented consequence, exercised end to end by this stage's
  own client-flow scenario 6: `claim()`'s payout runs as an inner cross-contract promise, so a
  payee who was never `storage_deposit`'d on the token fails only that inner transfer — the
  preimage is already public (the contract wrote it before ever calling `ft_transfer`) even
  though the lock reverts back to `Locked` and no payout lands. `NearHtlcRail.claim()`'s own
  no-secret `storage_balance_of` pre-check (P5-NEAR-SPEC.md §4) narrows the window but cannot
  close it: a payee who is registered when the pre-check reads can be unregistered before the
  payout promise runs, and the hermetic client-flow scenario (`tests/client-flows-near-rpc.test.ts`,
  the payout armed to fail after the pre-check's reads) reaches this state through the ordinary
  claim path. The sandbox test reaches it by sending the raw transaction, bypassing the guard.
  The client then throws `NearPayoutFailedError` (see the next bullet for what is posted).
- **The reveal must land before `refundAfterMs` (G6).** After a claim whose payout failed, or a
  claim that landed on chain, the Seller posts the tclk reveal frame (retried up to 3 times) and
  throws `RevealNotPostedError` if it still fails; the message says the reveal must land before
  `refundAfterMs` and to call `claimLegA` again before then. A per-flow `revealPosted` /
  `receiptPosted` latch means that retry (and the chain-already-agrees path) posts only the frame
  that is missing and never a second copy; a `NearPayoutFailedError` posts a reveal but no receipt.
  The latches live in the flow instance: a new process re-posts. tclk's machine accepts a reveal
  only while the contract is `locked`, so a leg that is claimed on chain after `refundAfterMs`
  through the revealed-lock rule (F4/H2), once the Buyer's refund frame has landed, cannot be
  recorded in the tclk transcript (no test here exercises what the board then reports for that
  case).
- **Contract storage is never freed, and it is cheap to consume.** Claimed and refunded lock rows
  stay in contract storage forever, and any holder of the configured token can create one for a
  1-unit lock. The contract's reserve check then refuses new locks until someone tops the contract
  account up; nothing here bounds or reclaims that. (`contracts-near/README.md`.)
- **The response byte cap bounds memory only when the server sends `Content-Length`.** An oversized
  reply that declares its length is refused before its body is read; a chunked reply is buffered in
  full and checked afterwards (`DEFAULT_MAX_RESPONSE_BYTES`, 4 MiB), so a hostile endpoint can make
  the process buffer more than the cap before it is refused. A streaming cap is not implemented.
- **A stuck `Claiming`/`Refunding` lock has no recovery method (F5).** If the payout callback
  itself fails, the lock stays in that state and no method moves it out. Reachable only with a
  non-standard token whose `ft_transfer` result is not empty or JSON unit; the evidence reader
  reports `Claiming`/`Refunding` as non-final, never as an outcome. Full account in
  `contracts-near/README.md`.
- **A revealed lock cannot be refunded (F4), with consequences.** Once a claim has revealed the
  preimage, the contract refuses `refund` even after `refundAfterMs`, and the claim may be retried
  at any time. If the payee never becomes storage-registered, the payer's funds on that leg stay
  locked; the payer's only recourse is to use the now-public preimage on the other leg. The
  adapter mirrors this: a revealed-but-`Locked` lock is retried without the deadline guards (H2)
  but only after verifying the preimage opens the hash lock, and the evidence reader reports it as
  revealed rather than `locked` (E4).
- **The capture filename stamp is not bound.** `raw/near/<hashLock>/<legContract>/<stamp>.json`:
  the evidence reader sees only the parsed index, never the filename, so the stamp is a sort
  convention. It is not evidence of when a read was taken; the index's own fields are checked
  (`pin`, `caip2`, `endpoint` must equal the auditor's config, E6).
- **`audit-export`'s `rails.json` is a trust anchor.** By default the auditor reads the NEAR
  config (contract, token, code hash) from `DIR/rails.json`, which travels with the bundle and so
  can be edited together with it. For an independent audit pass `--rails` with the contract and
  token you know.
- **The token's code hash is not pinned.** `connect()` pins the `htlc` contract's code hash and
  refuses a contract that holds any access key (H6), and the evidence reader proves the same two
  facts per capture at the finalized block (H8), but the NEP-141 token is checked only by
  account id. Circle's USDC is upgradeable by its issuer; a code change there is not detected.
- **The landing margin is a sandbox figure.** `NEAR_CLAIM_LANDING_MARGIN_MS` (30 s) is sized for
  the sandbox's ~0.65 s blocks; it was not measured on testnet, and a testnet or mainnet
  deployment needs a measured, wider margin before any claim is trusted to land ahead of a refund.
- **The replay detects damage and splicing, not forgery.** Identical honesty limit to the
  EVM/Bitcoin legs' own (see above).
- **`sandbox_fast_forward`'s own simulated-time-per-block figure (D-N7, ~337 ms/block) was
  measured once, this stage, and is not chain-enforced.** It is this build's own test-harness
  convenience for crossing a `refundAfterMs` deadline without a real-time wait; nothing about it
  is a NEAR protocol guarantee, and a real deployment obviously has no such lever at all — real
  time simply has to pass.

## Solana leg (local validator in WSL)

`contracts-sol/` is a first-party, unaudited native-Rust escrow program (no Anchor); its README has
the byte layouts, error codes and the client duties it hands to this layer. The TypeScript side is
`src/rails/sol-htlc.ts` (the adapter: chain pin, program pin, keyless writes, chain-confirmed writes
with typed errors), `sol-evidence.ts` (the pure finalized-view evidence reader plus the one live
capture function), `sol-rpc.ts`, `sol-tx.ts`, `sol-spl.ts` (a first-party legacy-transaction and SPL
encoder over the already-installed `@noble/*` and `@scure/base`; no `@solana/*` dependency),
`sol-signer-memory.ts` (a key in an ES `#private` field, never serialised) and `custom-rails.ts`.

**The rail id is `trustcore.sol-htlc-v1`, and it is namespaced on purpose.** The vendored tclk knows
only its own rail ids and must not change, so a Solana leg cannot use a bare id such as
`sol-htlc`: that would look like an id tclk itself owns. `src/rails/custom-rails.ts` builds a frozen
per-caller registry (no module state) that admits this one id with the `solana` account-line
namespace and refuses every id tclk already knows. The id is spelled in exactly one constant
(`SOL_RAIL_ID`); a test scans `src/` for a second occurrence.

Run the live suites (needs WSL Ubuntu with Rust and Agave v4.3.0 under
`~/.local/share/agave/v4.3.0/bin`, see `handoff/research/sol-probe/README.md`):

```bash
npm run test:sol
```

This builds `dist/`, then runs two files one after the other, each with its own throwaway validator:
`tests-sol/sol-htlc.sol.test.ts` (the adapter and the evidence reader on real transactions) and
`tests-sol/client-flows.sol.test.ts` (the Seller and Buyer flows end to end). For each it runs
`contracts-sol/build.sh` (host tests, the SBF build, the litesvm tests) once per process, requires the built
`htlc.so` to hash to the reviewed pin, spawns one `solana-test-validator` through `wsl.exe` (ledger under WSL
`/tmp`, killed by pid only), and funds fresh in-memory keys through the faucet. It takes about 25 minutes
(the client-flow file alone about 13): this validator finalizes about 13-15 s behind the tip, every write
waits for FINALIZED, and chain time is wall time, so the one scenario that must cross `refundAfterMs` really
waits about 7 minutes. `npm test` (hermetic, `tests/sol-*.test.ts` on a scripted fake node and the committed
fixtures) never starts a process.

What is built: the program, the adapter, the evidence reader, the Solana account-line helpers and the
custom-rails registry, all proven by the hermetic suite and the live suite, and the client side:
`src/client/sol-rail.ts` (`createSolCounterRail`, the `CounterAssetRail` over the adapter, with
`SOL_LOCAL_POLICY`: 45 min reveal window, 20 min finality, a 5 min claim margin, which must exceed the
adapter's 120 s claim landing margin or no claim could ever be signed), the Seller/Buyer flows running
on it, `src/rails/custom-frames.ts` (frame emission for the custom rail id) and the watcher, replay,
bundle, `bin/watch.mjs` and `examples/audit-export.mjs` wiring (`rails.sol`, `raw/sol/<hash lock>/<leg
contract>/`). The flows are proven twice: hermetically (`tests/client-flows-sol.test.ts` drives the real flows
and the real adapter over a stateful fake Solana node that applies the escrow program's own state machine to
the transactions the adapter sends; `tests/audit-export-sol.test.ts`, `tests/custom-frames.test.ts`) and on
the real validator with the real program (`tests-sol/client-flows.sol.test.ts`, below).

**What the live client-flow suite proves** (real `solana-test-validator`, reviewed `htlc.so`, real signed
transactions, leg B on tclk's paper rail; one scenario each):

- *settled*: bid, accept, both proven `ed25519` account lines, lock, claim, the Buyer learns the secret from
  the Seller's reveal frame and claims leg B; balances move by exactly the amount.
- *refunded*: the Seller never claims; the Buyer's refund is refused by the flow while its clock is early, and
  by the adapter while the chain's own finalized time has not reached `refundAfterMs` even though wall time
  has (nothing is sent); once the real chain time passes it the refund lands, the Buyer is repaid in full and
  the Seller refunds leg B.
- *refunded-b*: the Buyer never locks; the Seller refunds leg B; a live read of the chain for the lock's ref
  shows no escrow (the fixture holds that read, and no Solana write).
- *a claim before the lock is final*: refused with no lock frame at all, and refused with a lock frame posted
  while the lock is only `confirmed` (the claim reads at FINALIZED); nothing is sent; once final, the same
  claim goes through.
- *no reveal frame*: the Seller claims with the reveal suppressed and the Buyer learns the secret from the
  chain alone.
- *a claim that lands and fails*: the Seller's claim is made to land and fail on the real chain (the payee's
  token account is closed just before the claim is forwarded, with its preflight skipped, which is the only way
  a claim can land and fail). The secret is then public in a failed transaction. Either the retry goes out at once in
  public-secret mode and the Seller is paid (the escrow's history shows exactly one failed claim with program error
  17 and the successful retry), the reveal frame following it once the escrow reads Claimed. When no retry
  can land, nobody was paid: the Buyer does NOT claim leg B on the leaked secret (`learnSecret` and `claimLegB`
  refuse while the escrow is not Claimed), refunds leg A once the real chain time passes `refundAfterMs`, and
  the Seller refunds leg B. When the failed claim's reply was lost and the escrow's history was padded past 5000
  entries, the retry still pays the Seller (it resolves the recorded signature and proves the secret public from
  that one transaction).
- *a squat*: another payer locks under the public hash lock first; the Buyer's own lock and the swap are
  unaffected and the squatter's escrow stays Locked.
- *lost replies*: a lock whose send reply was lost is found by `reconcileLockA` (the lock frame posts once);
  a claim whose reply was lost is recognised by its recorded signature once final (also with the escrow's
  history padded past 5000 entries), sent only once, frames posted once.
- *padding before the first claim*: 5001 padding transactions naming the escrow (about 0.025 SOL) do not stop
  the Seller's first claim: no flow scans history.
- *a mirror pair*: a stranger's copy of the victim's two proven lines does not resolve, so the victim's real
  on-chain lock is never verified for the mirror (and without the proof requirement it would be).

Three fixtures, `fixtures/sol-localnet-2026-09-30/{settled,refunded,refunded-b}/`, are captured from these
runs and replayed hermetically by `tests/sol-localnet-fixtures.test.ts` through `examples/audit-export.mjs`,
which also scans every committed file for these shapes of key material (each has a planted-leak test): field
names, PEM and mnemonic text; a 64-byte keypair in base58, base64, base64url or 128 hex characters; a JSON array
of 64 numbers; and a bare 32-byte seed in base58, base64, base64url or hex (with or without a `0x` prefix: hex is
matched by lookarounds on the hex digits, not by a word boundary) whose derived public key is present in the same
fixture, as a base58 address or as any 32 bytes inside a decoded base64 or base64url blob (account data, a signed
transaction). The scan walks every file under `fixtures/sol-localnet-2026-09-30/` (each scenario directory on its own
set of known public keys, so every capture, summary and `rails.json` in it is read);
it does not read `src/`, `tests/` or any other directory. It checks those shapes only: a seed whose public key appears nowhere in the fixture, a key that
was encrypted, chunked or otherwise transformed, and a value hidden inside a larger blob are not seen, so a
clean scan is not a proof that no key material exists (the fixtures hold only keys of a throwaway, zero-value,
in-memory run, and never a key file). To recapture them:

```bash
CAPTURE_SOL_FIXTURES=1 npm run test:sol
```

Commit the result, then confirm that `tests/sol-localnet-fixtures.test.ts` replays it and that a plain
`npm run test:sol` afterwards leaves `git status` clean (bundles go to `mkdtemp` directories removed at the end;
`KEEP_SOL_BUNDLES=1` keeps them, `KEEP_SOL_VALIDATOR_HOME=1` keeps the validator's home). `refunded-b`
carries a live read of the chain for the lock's ref that shows no escrow, and the `rails.json` the replay
needs to read a swap on the custom rail id at all; it holds no escrow and no Solana write.

**How the custom rail id reaches frames.** tclk's `makeOffer` and `encodeFrame` refuse any rail id outside
its closed registry, while its decoder, `foldTranscript` and contract machine already read a rail by the
wider tclk/1 grammar. `src/rails/custom-frames.ts` (`makeOfferWith`, `encodeFrameWith`) closes that gap
at the desk layer, without editing `vendor/tclk`: the rail object carries its own
`railRegistry` (`CounterAssetRail.railRegistry`, `undefined` for EVM, Bitcoin and NEAR), the flows pass it
to every frame they emit for leg A (the offer, the lock frame, the receipts) and to the orientation check,
and the watcher, replay and audit-export build one per fold only when `rails.sol` is configured. Nothing
is process-global; everyone else keeps tclk's closed check and its own error, and a Solana leg read
without `rails.sol` is reported as an unregistered rail.

**What the flows do on Solana that they do not on the other rails.** A claim carries the secret in its
instruction data whether it succeeds or fails, and a failed claim leaves no account state, so a public secret
does not mean the Seller was paid (the program refuses every claim at or after `refund_after_ms`).

- *The Buyer claims leg B only once leg A reads Claimed at finalized.* `learnSecret` returns the escrow's
  stored preimage when the escrow is Claimed, and otherwise throws "leg A not claimed on chain yet"; a reveal
  frame alone, or a secret leaked by a failed claim, never lets the Buyer claim leg B, and `claimLegB` refuses
  unless leg A is Claimed with that very secret. The Buyer never scans history, so nothing anyone can pad affects it.
- *The Buyer refunds leg A only while leg B is unclaimed.* `refundLegA` first checks leg A itself: when leg A reads Claimed
  (or this flow already claimed leg B) it routes to "call learnSecret() then claimLegB()", so a paid Seller never
  sees "leg A is owed". Only then, on Solana, does it read leg B's own record. That record counts as a claim only when
  it is a PROVEN claim: its lock, statement and refundAfterMs equal leg B's own terms and its secret opens the
  statement; a note that fails this is ignored (the reason is kept in `refundNotes`) and does not block the refund.
  On the paper rail the note is unauthenticated and anyone holding the secret can write it, so the refusal
  `LegBClaimedError` ("leg B was claimed with the public secret; leg A is owed to the Seller; settle by hand") means
  exactly "the secret is public and leg B reads claimed", nothing more. (When leg B is a value-bearing chain rail the
  check has to use bound chain evidence instead.) If a claim of leg A only becomes final while the refund is being
  sent (the finality-lag window), the refund's own failure is replaced by the routing error "call learnSecret() then
  claimLegB()". The Buyer's rule (refund leg A only while leg B is unclaimed) prevents only the Buyer's OWN
  refund-after-claim; it does not make the swap safe for everyone. Once the secret is public or possibly seen and the
  Seller's claim cannot land before `legA.refundAfterMs`, leg B is claimable by anyone holding the secret until
  `legB.refundAfterMs`, even after the Buyer's legitimate refund of leg A, and settling that needs a person. Known
  limit: after `refund_after_ms` only a refund can move leg A (the program refuses every later claim), so when leg B
  was claimed first, a person must pay the Seller outside the protocol. The fold's verdict on a refund of leg A after
  a leg-B claim is graded: `refunded-a` with the reason "leg A refunded after leg B was claimed: the Seller received
  neither leg" (`LEG_A_REFUNDED_AFTER_B_CLAIMED`, from `src/swap.ts`) ONLY when leg B's claim is on a value-bearing
  rail and its bound observation shows it before leg A's refund (`transitionAtMs`, chain time); otherwise the neutral
  reason "leg B claimed and leg A refunded; order or value not proven" (`LEG_A_REFUNDED_LEG_B_CLAIMED_UNPROVEN`). The
  paper rail is always neutral (a Seller can write a paper note after the fact), and no reader binds a transition
  time yet, so today every verdict is neutral. This repository has no reputation emitter; a reader that scores
  parties must not count either reason as proof of theft. EVM, Bitcoin and NEAR keep their own rules.
- *The chain's clock is checked before value moves.* `lockLegA` and the Seller's `acceptLegA` refuse when the
  chain's finalized clock and the local clock differ by more than 60 s (`SOL_CHAIN_CLOCK_SKEW_MS`). Known limit:
  the Buyer's protection on Solana is `legB.refundAfterMs - legA.refundAfterMs`; a chain halt or a clock lag longer
  than that is not covered by this check.
- *The Seller records every claim signature before sending.* `claim` hands the signature and its
  `lastValidBlockHeight` to `onSigned` before anything is simulated or sent (and drops it again through
  `onNotBroadcast` when the claim provably never reached the network). At the start of every `claimLegA` the
  Seller resolves each recorded signature by that signature: landed (nothing more to send; frames post once),
  landed and failed (the secret is public and that transaction proves it), or never landed (its blockhash
  expired with no status). A signature that is not decided yet (`SolPendingError`) or a transport error while
  resolving it stops the call with the record kept: no second claim is signed while an earlier one could still
  land. Proof of a public secret is always that one named finalized transaction, polled until it is readable,
  never a scan.
- *The Seller never scans history.* A flow that never signed a claim has no leak of its own to find and does
  the ordinary guarded claim; its only chain read for this is the escrow itself (Claimed with its own
  preimage). No path lets `SolHistoryTooLongError` block a claim. The whole-history scan stays on
  `SolHtlcRail.findClaimedPreimage` for third-party readers, where throwing past the limit is fine.
- *Retry first, reveal after, and only once Claimed.* After a claim that landed and failed, the public-secret retry
  (`claim(..., { retryPublicSecret: true, proofSignature })`, at most twice) is sent before any reveal post; the
  reveal post has a bounded timeout per attempt (`revealPostTimeoutMs`, default 10 s; an attempt that timed out
  is adopted from the deal room if it landed, never posted twice), so a stalled venue cannot hold up the retry or
  the call. The reveal frame is posted only once the escrow reads Claimed (the same rule the Buyer follows): a
  claim that landed and failed paid nobody, so no reveal frame is posted for it, and when no retry can land the
  call ends without one.

Before signing, the client rail checks who the escrow pays and its mint, amount and times against this leg's
own terms, and refuses a claim with no resolved payee line. Both parties' proven `ed25519` lines are required,
for the Seller's claim and for every evidence reader.

**Restart: no flow can be resumed today.** A `SellerFlow` or `BuyerFlow` holds its swap state in memory only, and no
constructor, method or file rebuilds it. A process that dies loses the flow, and a new flow object cannot continue
that swap. What a crash costs at each step, and what a person must do (read the escrow by its ref with `getEscrow`
and act by hand):

| Crash after | What is lost | What a person must do |
| --- | --- | --- |
| The Seller accepted leg A (secret minted) | the preimage, so the claim is impossible | nothing is locked yet; start a new swap. Never reuse the offer |
| The Seller locked leg B | the preimage (leg B can only be refunded) | after leg B's `refundAfterMs` the Seller refunds leg B by hand on the paper rail |
| The Buyer prepared the lock, before it landed | the prepared ref and signature | read the escrow at the payer-keyed ref; if it exists, it is refundable by the Buyer after `refund_after_ms` |
| The Buyer locked leg A | the flow state (accounts, ref, leg B pairing) | refund leg A by hand after `refund_after_ms` unless the escrow reads Claimed; never refund when leg B was claimed |
| The Seller signed a claim, before it was recorded as landed | the signature and `lastValidBlockHeight` | read the escrow: Claimed means the Seller was paid (post the frames by hand); Locked means send a fresh claim before `refund_after_ms` |
| The Seller claimed, before the reveal frame posted | the reveal and receipt latches | the Buyer reads the preimage off the Claimed escrow (`learnSecret` does not need the frame) and claims leg B |
| The Buyer learned the secret, before it claimed leg B | the secret | read it from the Claimed escrow's stored preimage and claim leg B on the paper rail before leg B's `refundAfterMs` |

The minimal persistence surface a future rehydrate API would need, per swap, is: the Seller's preimage, both
accepted offers and accepts, every claim signature with its `lastValidBlockHeight` (what `onSigned` hands over),
whether the leg B lock was attempted, and the reveal and receipt latches; for the Buyer, the prepared lock record
(the payer-keyed ref and the prepared signature, recorded before `commitLock`), the resolved accounts, the leg B
pairing and whether leg B was claimed. That is named future work; this round adds no rehydrate API.

### Known limits of the Solana leg

Only what the tests prove is claimed; the rest is written down.

- **The endpoint must serve transaction history (checked at `connect()`).** "Never landed" and every
  history-based proof rest on the node still holding the transactions. `connect()` probes once
  (`getFirstAvailableBlock` and `getSignaturesForAddress` on the program id) and refuses an endpoint that
  fails either (fail closed). Before a signature is believed never to have landed, the rail also asks
  `getTransaction(signature, finalized)`, and a node whose ledger starts after the slot the transaction was
  signed at is reported as pending, never as "never landed". The last valid block height used for the
  landing bound and for expiry is `max(reported, processed block height + 151)`.
- **A claim creates the payee's token account, and carries a priority fee.** Every claim is
  `SetComputeUnitLimit`, `SetComputeUnitPrice`, `CreateIdempotent` (payer: the claimer; owner: the escrow's
  payee) and the claim, so a payee account that vanishes between the simulation and the landing no longer
  makes a claim land and fail (live test). The claimer's wallet therefore needs SOL for the account's rent.
  A refund carries the two budget instructions. The price is the 75th percentile of recent fees over the
  claim's writable accounts (floor 1,000, cap 1,000,000 micro-lamports per unit), doubled for each earlier
  claim of the flow that never landed. The Seller then keeps claiming up to the landing bound (not the
  5-minute policy margin) and reports `neverLandedClaims` / `SolClaimStarvedError` ("secret broadcast but not
  landed, possibly seen"). Known limit: write-lock starvation on a busy cluster; the fee policy mitigates it,
  nothing guarantees inclusion. A starved claim leaves the secret possibly seen: leg B is then exposed (claimable by
  anyone holding the secret) until `legB.refundAfterMs`, even after the Buyer's legitimate refund of leg A, and
  settling needs a person (`SolClaimStarvedError` says "leg B exposed until legB.refundAfterMs"). In public-secret mode an undecided earlier retry never blocks the next claim.

- **A stray donation is adopted.** The vault is an ordinary token account, so anyone can add units to
  it, and the program pays the whole balance out. The adapter and the evidence reader therefore accept a
  vault holding AT LEAST the amount (live test: a 1-unit donation after the lock lands, `commitLock` and
  `recoverBySignature` still succeed). Every other escrow field is compared exactly.
- **A late claim can publish the secret, so a claim is bounded; a claim that already failed is not.**
  A claim carries the preimage in its instruction data whether it succeeds or fails. `claim` therefore
  refuses unless the deadline `notAfterMs` is still ahead, leaves 120 s before `refund_after_ms`, and its
  blockhash cannot land after `refund_after_ms` minus 30 s (measured live: 455 ms per block, so the
  600 ms estimate has about 70 s of slack). Once a claim has landed and failed the secret is public and
  those bounds only stop the Seller being paid, so `claim(..., { retryPublicSecret: true })` skips them
  (live test: retry pays the payee inside the old bounds and the Buyer's refund is then refused). It is
  allowed only when the escrow's own on-chain history proves the preimage is public. It is NOT offered
  for `SolNotLandedError` (a claim that was sent but never landed): there the secret is only possibly
  seen, which stays a decision for a person.
- **No flow reads the escrow's history; the scan is for third parties only.** A failed claim leaves no
  account state. The whole-history scan (`SolHtlcRail.findClaimedPreimage`) stays for a third-party reader that
  wants to know whether a secret was ever published: it needs an RPC node that retains the escrow's history (a
  pruned node can miss it), and a history longer than `SOL_PREIMAGE_SCAN_HARD_LIMIT_TRANSACTIONS` (5000) makes
  it throw instead of answering "none"; anyone can push an escrow's history past that for about 0.025 SOL, so
  it is never a safety input. The Seller proves its own public secret from the one recorded transaction
  (`proofSignature`), and the Buyer claims leg B only once the escrow itself reads Claimed, so padding cannot
  stop a payment or make the Buyer lose a leg. The price of that rule: a secret leaked by a failed claim is not
  acted on by the Buyer, so if the Seller cannot be paid the swap fails, but "both legs are refunded" is not guaranteed: while the secret is public
  leg B stays claimable by anyone holding it until `legB.refundAfterMs`, and a person must settle that.
- **`simulateTransaction` receives the signed claim.** The claim is simulated first so a claim the
  runtime would refuse is never sent, but the simulation request carries the signed transaction and so
  the secret. Use an endpoint you trust for the Seller, as for the send path. A claim past its own
  deadline is refused before it is signed or simulated (live test: no simulate exchange is made).
- **A claim that lost a race is not a failure.** If another transaction (a relayer, a duplicate send from
  another fee payer) claimed first, the failed transaction is reported as evidence with
  `claimedByAnotherTransaction: true` when the escrow is Claimed with this claim's preimage (live test).
  In every other state a failed claim is `SolClaimFailedError` with `secretPublic`.
- **A stalled or suspended validator is not covered (by analysis, not run).** The landing bound assumes
  blocks stay near 600 ms and the clock tracks blocks. If the average block time over one blockhash
  lifetime exceeds about 760 ms, or `Clock.unix_timestamp` jumps forward while block height stands still
  (a suspended WSL VM, for example), a claim signed before the stall can land after `refund_after_ms`,
  fail, and publish the secret. There is no slow-block check at claim time; do not suspend the host
  while a claim is in flight.
- **Evidence capture can fail under network latency (measured).** `captureSolLeg` makes five sequential
  `getAccountInfo` reads and the finalized slot advances about every 455 ms. With no added latency 20 of
  20 captures verified on the first attempt; with 60 ms added per call, 6 of 20 still straddled two slots
  after the 3 attempts and produced `railVerified: null`. That fails closed (no fund loss) but the Seller
  would not see "locked". Against a remote devnet RPC most captures would fail. A single
  `getMultipleAccounts` read would fix it and is not built.
- **Wallet keys only.** A payee that is off the curve, an all-zero or other small-order point, or a
  non-canonical encoding is refused before signing, because nobody can sign for it under strict
  verification. The payee comes from the counterparty's own account line.
- **`claim_by_ms` is enforced by the client only** (the program gates a claim on `refund_after_ms`), so
  leg safety is derived from `refund_after_ms`; see `contracts-sol/README.md`.
- **The replay detects damage and splicing, not forgery.** Same honesty limit as the EVM, Bitcoin and NEAR
  legs: a replayed bundle shows that recorded bytes are intact and belong together, not that a party with
  write access did not fabricate a whole consistent capture.
- **`rails.json` is a trust anchor.** The auditor reads the Solana config (endpoint, program id, program hash,
  mint, chain pin) from `DIR/rails.json`, which travels with the bundle and so can be edited together with it.
  For an independent audit supply the config you know instead.
- **The localnet pin carries no chain identity.** A validator's genesis hash changes on every reset, so
  `SOL_LOCAL_PIN` is a fixed name, and `connect()` only refuses a genesis that belongs to a public cluster. Any
  other endpoint, including a fake that reports an unknown genesis, satisfies it; what pins the program is its
  hash and the mint, not the chain. A real deployment needs a pin with a genesis reference (like the devnet
  pin) before anything is trusted to it.
- **`checkedAtMs` is the caller's clock.** The `checkedAtMs` of a Solana capture and of the observation built
  from it is the `nowMs` the caller passed to `captureSolLeg` (the flows pass their injected clock); it is not
  bound to the finalized slot's block time, so it says when the caller says it looked, not when the chain said
  so. Judgements about chain time use the finalized slot's own block time.
- **The live client-flow suite compresses one window and injects one failure (tests, not product).** A
  validator has no fast-forward, so the "refunded" scenario sets `refundAfterMs` about 7 real minutes away and
  runs the flow clock 41 minutes behind wall time, so the flows' own "45 minutes from the declared lock time to
  refund" rule is still satisfied; the declared lock time is an input of the flows and is never compared with
  the clock. Everything the chain decides is not compressed (the adapter judges windows against the chain's own
  finalized time, the program against its own clock; a scenario shows the adapter refusing a refund when wall
  time has passed `refundAfterMs` but the chain has not). The "claim lands and fails" scenarios close the
  payee's token account just before the claim is forwarded, with its preflight skipped, because that is the
  only way a claim can land and fail; nothing in the product does that.
- **Not exercised end to end live:** a lost reply on a refund (hermetic: `tests/client-flows-sol.test.ts`;
  the adapter's own recovery by signature is live in `tests-sol/sol-htlc.sol.test.ts`), a claim whose blockhash
  expires (adapter live suite), and evidence capture under network latency (see the limit above). Timing
  measured: the client-flow file ran in 779 s on the first full run (11 tests including the 7-minute refund
  wait; one claim or lock is 15-30 s).
- **The program is unaudited and localnet-only.** The devnet pin (`SOL_DEVNET_PIN`) has never met a real
  devnet and is marked UNVERIFIED; mainnet is refused by name and by genesis hash. Every write waits for
  FINALIZED (about 15-30 s here); a real cluster's timing was not measured.

## What this is not

No AMM, no pool, no custody, no relayer (yellow paper R10.4's allowlisted relayer is
not used: each party redeems its own leg), no point/adaptor locks (tclk's adaptor path is
unaudited reference crypto), no mainnet value. The profile carries a fee field (`docs/FEES.md`),
but every deployment we operate sets it to zero; no deployment here charges anything.

## License

MIT for this repo's own code. Vendored and derived files keep their upstream license — see
`PROVENANCE.md` for the full file-by-file list, sources and hashes.
