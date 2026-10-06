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
- **Client** (`src/client`): the party-side agent that holds *your* keys and drives the rails: the Buyer and
  Seller flows (`BuyerFlow`, `SellerFlow`), one adapter per counter-asset rail (EVM, Bitcoin, NEAR and Solana, see
  the leg sections below) and crash-resume (see "Resume").

Design document: `SPEC-ATOMIC-SWAP-DESK.md` in
[djd39448/flop-contrib](https://github.com/djd39448/flop-contrib).

## Status

The profile is **v1.1**: leg A's offer carries a fee field (`feeBps`), and it is zero on every
deployment we run — see `docs/FEES.md`.

**Alpha, Phase 0, keyless.** Nothing here moves value. There is no FLOP testnet RPC yet; the
FLOP leg is bound through tclk PR #171's mock chain only. The FLOP leg's only rail with a read path today
is tclk's `paper` rail (`vendor/tclk/src/paper-rail.ts`) — a rehearsal surface that holds no
value and whose records anyone can overwrite; the board can fold a fully-rehearsed swap all the
way to `settled` on paper evidence, but every reason trail it produces says so
(`"paper rail: rehearsal only, no value"`). **The Phase 0 verdict is choreography only (`PaperRail`
verifies 4 of 9 `LockTerms` fields, tclk#180):** the fold independently checks all nine before a
leg counts as locked (`src/swap.ts`, §3.4 of `docs/PROFILE.md`), but the paper rail's own record
can only ever attest to `status`/`lock`/`statement`/`refundAfterMs` — so a `settled` paper
rehearsal proves the choreography and the pairing rules, never amount or payee integrity. The
counter-asset legs are further along: `evm-htlc`, `btc-htlc`, `near-htlc` and `trustcore.sol-htlc-v1` each have
a read path (the fail-closed finalized-view readers `src/rails/evm-evidence.ts`, `btc-evidence.ts`,
`near-evidence.ts` and `sol-evidence.ts`) and a client adapter, exercised against a local node or sandbox, and the
Seller and Buyer flows drive a whole swap on them, crash-resume included (see the leg sections and "Resume").
`flop-htlc` still has no read path, so a swap whose FLOP leg is a real chain lock cannot advance past `paired`
today, by design and not by accident (fail closed). Every end-to-end atomicity claim remains PENDING until yellow
paper open item E.48 closes, and this repository does not present one.

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
  itself after `refundAfterMs`), but the board shows leg A as never funded. With a `store`, the next
  `lockLegA` call (or `reconcileLockA()`), in this process or after a restart, reads the lock by its hash
  lock, records it and posts the lock frame, so the board catches up (not at or after leg A's `refundAfterMs`, when
  tclk's machine would reject the frame: see "Limits of resume"); without a store only
  `reconcileLockA()` in the same process does.
- **A claim's last guard still has two round trips after it.** viem's chain-id assertion and
  `eth_sendTransaction` follow the final deadline check, each a single attempt (transport retries
  are off) bounded by the RPC timeout (45 s by default), well inside the 5-minute
  claim-inclusion margin.
- **The claim endpoint is trusted with the preimage** at the moment the claim is sent (see
  above).
- **A restart costs gas at most.** After a crash a repeated `approve`, `lock`, `claim` or `refund` is refused by the
  contract (a duplicate hash lock, a spent status), so a resumed EVM flow cannot lock or pay twice; the price of
  the repeat is gas (see "Resume").

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
- **Two lost-reply cases end with the money right but the frames missing (a flow without a store).** (1) If the Seller's
  claim broadcast reply is lost and the claim is mined before the retry, `claimLegA` refuses on the
  retry (the lock now reads `claimed`), so the Seller's reveal and receipt frames are never posted;
  the Seller already has the BTC and the Buyer still learns the secret from the chain. (2) If the
  Buyer's refund broadcast reply is lost and the refund is mined (and its output spent) before the
  retry, `refundLegA` fails with the node's raw rejection instead of posting its refund frames; the
  Buyer already has its BTC back. In both cases the watcher's evidence still shows the leg's real
  state from the chain. With a `store` both are closed: a resumed (or retried) `claimLegA` looks for its own
  claim on chain, mempool first, from the block marker saved with the attempt and posts the reveal and receipt
  frames, and `refundLegA` resolves its recorded refund by txid and posts the refund frames (see "Resume").
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
  With a `store` the flow itself re-sends the saved funding bytes once (identical bytes, same txid, never a second
  outpoint) after its own guards, and never re-prepares.
- **Fees are a fixed constant, not estimated.** `DEFAULT_FEE_SATS` (`src/rails/btc-htlc.ts`) is
  subtracted from every claim/refund's single output; real fee estimation is out of scope for
  this build (P4-BTC-SPEC.md §0).
- **One node, one confirmation policy, no reorg handling.** This build's own regtest harness
  mines on demand and never reorgs; a real deployment choosing how many confirmations count as
  final for a given amount, and how to handle a reorg past that depth, is out of scope here.
- **Crash recovery has two limits of its own.** A node that refuses to re-broadcast a saved funding (its inputs
  spent, a conflicting transaction, a policy rejection) stops the flow with a typed error
  (`rebroadcast-refused`), and a person checks the wallet before any new attempt, because a second funding is a
  second outpoint. And the hermetic double-funding tests use a ledger fake that mines instantly and always picks
  other inputs, which real Bitcoin Core coin selection does not promise, so they prove the flow logic, not the
  node's behaviour (see "Resume").

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
  With a `store` the latches live in the saved record and a resumed flow posts only the frame still missing; without
  one they live in the flow instance and a new process re-posts. tclk's machine accepts a reveal
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
  `contracts-near/README.md`. Crash recovery cannot move such a lock either (see "Resume").
- **A revealed lock cannot be refunded (F4), with consequences.** Once a claim has revealed the
  preimage, the contract refuses `refund` even after `refundAfterMs`, and the claim may be retried
  at any time. If the payee never becomes storage-registered, the payer's funds on that leg stay
  locked; the payer's only recourse is to use the now-public preimage on the other leg. The
  adapter mirrors this: a revealed-but-`Locked` lock is retried without the deadline guards (H2)
  but only after verifying the preimage opens the hash lock, and the evidence reader reports it as
  revealed rather than `locked` (E4).
- **A lock or refund that was signed, saved and never sent is proven dead only by re-sending it.** The node does not
  know such a transaction and nothing moves the access key's nonce, so the flow sends the identical saved bytes
  once, after its own guards, and takes the node's `Expired` or invalid-nonce answer, plus a read of the lock row
  three blocks later, as the proof (about 14 s of waiting at most, then `pending`). That path, and the node's
  answer to a re-send of bytes that already executed, are tested against the RPC simulator and mocks with the error
  shapes a real node gave; the live NEAR suite never ages a transaction past its validity. A node that stays
  unreachable leaves it `pending`, and a person's three routes are written down in "Resume".
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
  the Claimed escrow's stored preimage (`learnSecret` reads the chain; a reveal frame alone is never enough) and
  claims leg B; balances move by exactly the amount.
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
- *a claim that lands and fails*: the Seller's claim is made to land and fail on the real chain. Since the claim
  creates the payee's token account itself, a vanished account no longer fails it; what does is the claimer's own
  wallet being unable to pay the rent of that account. Just before the claim is forwarded the test closes the
  payee's token account, drains the Seller's SOL and forwards the claim with its preflight skipped, so it lands
  and fails inside its own create-account instruction (`InstructionError` index 2: compute limit, price, create,
  claim) with the preimage in its data; this is a test device, nothing in the product does it, and a transaction
  frozen mid-flight or landing late fails differently (a late landing at or after `refund_after_ms` fails with
  `ClaimWindowClosed`). The secret is then public in a failed transaction. Either the retry goes out at once in
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
which also scans every committed file for these shapes of key material (each has a planted-leak test; every
base58, base64 and base64url shape is matched as a STANDALONE token only, so a key embedded in a longer token or
glued to a prefix or suffix is not seen): field
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
- *A paper note about leg B never stops the Buyer's refund of leg A.* `refundLegA` first checks leg A itself: when leg A reads Claimed
  (or this flow already claimed leg B) it routes to "call learnSecret() then claimLegB()", so a paid Seller never
  sees a refund. Only then, on Solana and only before this flow's first refund broadcast, does it read leg B's own
  record. In this build leg B is the paper rail, whose note is unauthenticated and moves no value: the Seller (who
  always holds the secret) or anyone holding a leaked secret can write a valid "claimed" note at no cost, so obeying it
  would let them freeze the Buyer's real refund of leg A (found and proven by the round-4 re-review). The note is
  therefore only recorded in `refundNotes`: a proven note (its lock, statement and refundAfterMs equal leg B's terms
  and its secret opens the statement) is recorded as "the secret is public and leg B's paper note reads claimed",
  anything else as "not a proven claim", and the refund goes ahead either way. `LegBClaimedError` is reserved for a
  future value-bearing leg-B rail whose claim is shown by bound chain evidence; nothing throws it while leg B is paper. If a claim of leg A only becomes final while the refund is being
  sent (the finality-lag window), the refund's own failure is replaced by the routing error "call learnSecret() then
  claimLegB()". The Buyer's rule (claim leg B only once leg A reads Claimed) prevents only the Buyer's OWN
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
  expired with no status). A never-landed claim is dropped and counted (`neverLandedClaims`), and the secret is then
  treated as possibly seen: the next claim is re-signed at a doubled priority fee, bounded by the landing bound
  instead of the policy margin, and still preceded by a flow-level `verifyLockFinal` confirmation that leg A is
  locked; past the bound the end of the effort is `SolClaimStarvedError`, never a silent drop. A signature that is not decided yet (`SolPendingError`) or a transport error while
  resolving it stops the call with the record kept: no second claim is signed while an earlier one could still
  land. Proof of a public secret is always that one named finalized transaction, polled until it is readable,
  never a scan. With a `store` the recorded signatures are saved with the swap before they are sent, and
  `SellerFlow.resume` restores them and resolves each one before any new claim (see "Resume").
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
  call ends without one. The retry is bounded by the window: once chain or local time has reached
  `refundAfterMs` no retry is sent (the original failure is reported). Inside the window it is still sent even
  when landing, finality and the reveal post may not all fit before `refundAfterMs` (it is the only way to be paid),
  and the reveal post is not attempted once venue time is past `refundAfterMs`: `RevealNotPostedError` is raised.
  A claim that is Claimed on chain but whose reveal could not be recorded makes the fold push "leg A claimed on chain
  but its reveal frame was not recorded" (`LEG_A_CLAIMED_REVEAL_NOT_RECORDED`).

Before signing, the client rail checks who the escrow pays and its mint, amount and times against this leg's
own terms, and refuses a claim with no resolved payee line. Both parties' proven `ed25519` lines are required,
for the Seller's claim and for every evidence reader.

**Restart.** A `SellerFlow` or `BuyerFlow` built with a `store` can be resumed after a crash. Every lock, claim and
refund signature above is written to the store (with its `lastValidBlockHeight`) before it is sent, and a fresh process
resolves each one by its signature before it signs anything new. The "Resume" section below covers all four rails,
what a person still does, and what a flow without a store costs.

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
  claim of the flow that never landed (at most 10 doublings, never above the cap). The priority fee is therefore
  bounded: at most 1,000,000 micro-lamports x 50,000 compute units = 50 lamports per claim (15 per refund at
  15,000 units), on top of the 5,000-lamport base fee and the payee account's rent. The Seller then keeps claiming up to the landing bound (not the
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
  deadline is refused before it is signed or simulated (live test: no simulate exchange is made). A bundle
  persists response bytes only, never that request, and the response that did hold the secret (reading a failed
  claim transaction) is held back until the reveal is posted; see "Resume".
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
  payee's token account and drain the Seller's SOL just before the claim is forwarded, with its preflight
  skipped, so the claim's own account creation fails (the claim creates the account itself, so closing it alone
  no longer makes a claim fail); nothing in the product does that.
- **Not exercised end to end live:** a lost reply on a refund of a flow with no store (hermetic:
  `tests/client-flows-sol.test.ts`; the adapter's own recovery by signature is live in
  `tests-sol/sol-htlc.sol.test.ts`), a claim whose blockhash expires (adapter live suite), and evidence capture
  under network latency (see the limit above). With a store, a lost reply on a lock, a claim and a refund are each
  run live by `tests-sol/resume.sol.test.ts` (the restart resolves the recorded signature and sends nothing
  again). Timing
  measured: the client-flow file ran in 779 s on the first full run (11 tests including the 7-minute refund
  wait; one claim or lock is 15-30 s).
- **The program is unaudited and localnet-only.** The devnet pin (`SOL_DEVNET_PIN`) has never met a real
  devnet and is marked UNVERIFIED; mainnet is refused by name and by genesis hash. Every write waits for
  FINALIZED (about 15-30 s here); a real cluster's timing was not measured.

## Resume

A flow built with a `store` writes its swap record down BEFORE anything the outside world can see: a venue post, a
paper-note write, a chain broadcast. A process that dies at any instant can then be replaced. A fresh process, given
the same store and the same objects the runner supplies (identity, venue, paper rail, counter-asset rail, clock),
continues the same swap or stops with a typed error. Nothing on the wire changed for this: no frame, contract, program
or paper-rail rule is different, `vendor/tclk` and `src/vendor/evm-hash-rail.ts` are byte-identical, and
**`docs/PROFILE.md` is unchanged** for that reason. A flow built without a `store` behaves exactly as before, writes
nothing and cannot be resumed (see "Without a store" at the end of this section), except that it too refuses to answer
an expired offer (see "Offers that expired" below).

```ts
// FileFlowStore lives in src/client/flow-store.ts; the default directory for a runner is .state/flows/ (gitignored)
const store = new FileFlowStore(".state/flows");

// the first run: the same options as before, plus the store
const buyer = new BuyerFlow({ identity, venue, paperRail, rail, clock, store });

// after a crash, in a new process: the same store, the same kind of objects, and the key of the swap
const { flow, next } = await BuyerFlow.resume({ identity, venue, paperRail, rail, clock, store, swapId });
const { flow, next } = await SellerFlow.resume({ identity, venue, paperRail, rail, clock, store, contractA });
```

`resume` reads the store only: it posts nothing and touches no chain. `next` is the name of the next safe step, taken
from the record and the clock alone (no venue or chain read), and every step then recovers before it acts: an intent
that was saved without a known outcome reads the chain and the venue first (see "What a resumed step does" below).
`next` is advice, not a lock. The Buyer's names are `bid`, `acceptLegB`, `verifyLegBLocked`, `postAccountLineA`,
`lockLegA`, `learnSecret`, `refundLegA`, `done` and `abandoned`; the Seller's are `acceptLegA`, `postAccountLineA`,
`lockLegB`, `claimLegA`, `refundLegB`, `done` and `abandoned`. `abandoned` means the swap can no longer proceed and has
nothing at stake: an accept that never landed before the offer it answers expired, or an accept B that the venue stamped
at or after leg B's offer expiry while nothing is locked (see "Offers that expired" under "What a resumed step does").
There is nothing to call; the runner drops the swap, and starts again from a fresh offer if it wants one. Not every
dead end is named `abandoned`: the states where a runner that obeys only `next` waits with nothing at stake are listed
under "Limits of resume".
`learnSecret` is also the way back into `claimLegB`: the Buyer's record never holds the secret, so it is
read again from the deal room or the chain. After leg A's `refundAfterMs` a Buyer may call `refundLegA` where `next`
says `learnSecret`; after leg B's `refundAfterMs` a Seller may call `refundLegB` where `next` says `claimLegA`. Because
the offers room is a short ring, the runner can pass what the record kept: `BuyerFlow.recordedPairing` (leg B's offer
and leg A's accept as signed records, for `acceptLegB`), `SellerFlow.recordedOfferA` (for `acceptLegA`) and
`SellerFlow.recordedAcceptB` (the Buyer's accept B, once a `lockLegB` saved it: `lockLegB(flow.recordedAcceptB)` and
`lockLegB()` with no argument both continue that lock, and only that lock).

The Seller's record is keyed `seller:<contractA>` (leg A's tclk contract id), the Buyer's `buyer:<swapId>`; `store.list()`
names every record. The swap id is chosen by the Buyer and nobody can authenticate it, so a stranger's offer that
copies a swap id could otherwise take the Seller's slot; the contract id binds the Buyer's signed offer and the
Seller's own accept and is known before accept A is posted. `SellerFlow.resume` therefore takes `contractA` and accepts
`swapId` only as a cross-check. A second `acceptLegA` of one offer on one store is refused with `FlowRecordExistsError`
before anything is minted or posted; resume that swap instead. What fences two accepts of one offer is written
under "One process per swap" below (it is not the per-key compare-and-swap), and so is the rule that a Seller record
that cannot be read blocks every new accept on its store.

`resume` fails closed. It stops with a typed error and never starts from an empty state: `FlowNotFoundError` (nothing
was ever saved under the key), `FlowStoreCorruptError` (truncated, corrupted or not a record), `FlowRecordVersionError`
(a version this build does not read) and `FlowRecordMismatchError` (the record names another DID, rail, chain, swap,
contract or deployment than the runner supplied, or its own frames do not add up). The deployment is pinned: the rail
gives a `deploymentId` derived from its config alone (EVM: the escrow contract and the token addresses; NEAR: the
contract account, the token account and the contract's code hash; Solana: the program id and the mint; Bitcoin: the
network name and the genesis hash prefix), the record stores it when the swap begins and `resume` compares it. A runner
restarted against another contract is refused instead of reading "no lock there" as "never locked" and locking again
while the first lock can still land. The EVM id covers every asset the rail is configured with, not only the swap's
own: any change to the EVM asset list (a token added to the config, say) refuses `resume` of every swap in flight with
a `FlowRecordMismatchError` on `deploymentId` until the config is put back. That fails closed, on purpose; the swap
itself is not harmed.

### What a resumed flow promises

1. **Written before it is visible.** The Seller's secret and the exact bytes of accept A and leg B's offer are saved
   before accept A is posted (the statement is public from that post). The Buyer's prepared lock (the reference plus
   the rail's recovery handle) is saved before `commitLock`. Every claim or refund signature is saved before it is
   sent. The exact text of every frame and account line is saved before `venue.post`.
2. **Never twice where twice can lose funds.** A resumed flow never builds a second leg A lock while the first can
   still land, never signs a second claim while an earlier one could still land (Solana), never SENDS a second
   Bitcoin refund while the first may be pending (at most one Bitcoin refund is sent; a refund whose handle save was
   refused after signing never left the process and may be built once more after the restart, see "Limits of
   resume"), and keeps the Solana Buyer rule (leg B is claimed only once leg A reads Claimed). It decides by reading
   the chain and the venue, never by assuming the crash came before the action.
3. **Same bytes, once.** A frame or account line is re-posted only as the identical saved text, and only after a read
   of the room shows it absent; an identical text already in the room is adopted; a line the record shows as landed is
   never posted again. A party never posts a second, different account line, and never an account line once leg A's
   lock frame is in the room.
4. **Every guard still runs, for every new action.** How rule 4 is read: the deadline, leg-B note and chain-clock guards
   gate every new lock action, meaning a fresh lock or a re-broadcast. Recognising a lock that already landed and
   recording it is not a new lock and happens whatever the clock says, and so does posting its frame, except at or
   after leg A's refund time (next sentences); the Seller's own claim guards decide whether the lock can still be
   claimed. So a Buyer that restarts long after its lock landed (and after the Seller claimed it) is not stuck on a
   deadline error: `lockLegA` reads the chain first, records the lock and posts its frame (unless leg A's refund time
   has come), and `next` points on to `learnSecret`, or to `refundLegA` once leg A's refund time has come. A lock
   recognised at or after leg A's `refundAfterMs` cannot be accepted by tclk's machine, which rejects a lock frame from
   that moment: the lock is recorded and not announced, and the refund frames that follow are rejected as well, so the
   transcript folds to `accepted` (see "Limits of resume").
5. **The secret stays private.** It is written to exactly one place, the Seller's own record, and appears in no log,
   frame (before the reveal), fixture, capture or bundle written by library code. The Seller keeps it, and the
   exchanges of a claim that did not land, in ES `#private` fields: `JSON.stringify(flow)` and `util.inspect(flow)`
   show public data only, and none of the flow's own fields holds an encoding of the secret, even after a claim the
   node refused (`Object.entries(flow)` and `util.inspect(flow, { customInspect: false })` at its default depth show
   none, leaving aside the runner's rail object, next). That object is the one exception, and it is not the flow's: the
   rail the runner supplies keeps its own capture log in memory, claim request bodies, secret included. What the
   decoder of a Buyer record enforces, on write and on read: no preimage field; a reveal-b ledger entry that is a
   sha256 digest of the text, never the text; and no string anywhere in the record that holds a run of exactly 64 hex
   digits (with or without `0x`, either case) opening the lock's hash lock. Today's writers put the secret nowhere in a
   Buyer record, and that last check is the net under them: it does not see a secret glued into a longer run of hex
   digits, nor the secret in base64 or any other encoding, nor a record whose lock has no hash lock yet.
6. **Fail closed on bad state.** See `resume` above.

### The store and its directory

`FlowStore` is three methods over opaque bytes, `load`, `save` and `list`, plus three optional members that a store with
real storage behind it offers: `scopeId` and `exclusive` for the Seller's begin (see "One process per swap") and
`locationOf`, the file that holds a key's record, which an error message uses to name the record a person must act on
(`FileFlowStore` only).
`MemoryFlowStore` is the test store (it can fail the n-th save on purpose). `FileFlowStore(dir)` keeps one file per
swap, `<role>-<id>.json` (`buyer-0x...` and `seller-0x...`: a key's `:` is not legal in a Windows file name), and
checks every key against its grammar so nothing outside `dir` is ever touched.

- **A save is a compare-and-swap.** The caller passes the sha256 of the bytes it last loaded or wrote (`null` means
  create, there must be nothing there yet), and the store refuses with a typed error when it holds something else
  (`FlowRecordStaleError`; `FlowRecordExistsError` for a create over an existing record). `FileFlowStore` runs each
  save inside a per-key critical section held by an `O_EXCL` lock file `<role>-<id>.lock` that carries the holder's
  pid: compare, remove that key's stale `.tmp-` files, write a temp file in the same directory, fsync it, rename it
  over the record, then fsync the directory (POSIX) or flush the renamed file (Windows). `save` resolves only once
  the bytes are durable, and a flow adopts a record in memory only after its save resolved.
- **A refused save makes the flow a crashed one.** Whatever the reason (stale, exists, locked, a disk error, a record
  that would not encode, a latch of the flow that the record cannot hold), the flow keeps the last durable record and
  every later public step throws `FlowStoreWriteFailedError` until the runner drops the flow and builds a new one with
  `resume()`. Whatever the flow latched in memory behind the refused save (a prepared lock, a claim attempt) was never
  made durable and is never acted on again. A retry in the same process therefore cannot fund twice behind a store
  that said no.
- **Each file carries a header with its payload's length and sha256**, and the record carries its own checksum, so a
  truncated or corrupted file is a `FlowStoreCorruptError` on load, never an empty answer. These checksums detect
  truncation and corruption, not tampering: they are not keyed, so anyone who can write the store directory can
  produce a record that loads cleanly. Decoding is strict: closed objects, no unknown fields, and for a Buyer record
  no preimage field, a reveal-b ledger entry that is a sha256 digest, and no standalone run of 64 hex digits that opens
  the lock's hash lock (item 5 above says what that net does not see); a Seller's secret must open its statement.
- **The directory is secret-grade, exactly like a key file.** Before the reveal the Seller's record holds the swap
  secret (and it keeps holding it afterwards). `FileFlowStore` creates the directory with mode `0o700` and the files
  with `0o600` where the platform honours modes. On Windows those modes do nothing and each record inherits its
  folder's permissions: put `.state/flows` in a folder that only the runner's account, plus SYSTEM and Administrators,
  can read (check it with `icacls`). A drive root may grant Authenticated Users modify, and a sandbox group had modify
  even under the profile's Temp folder on the development machine; do not assume a folder is private.
- **Windows cannot sync the folder after a rename.** The store flushes the renamed file instead (best effort); that
  narrows the window but is not proven to close it. A power cut just after a save can bring back the previous record,
  and the resumed flow then reruns its recover path from that earlier point. On POSIX the directory is synced, only
  `EINVAL` and `ENOTSUP` from that sync are tolerated (a file system that cannot do it), and any other failure fails
  the save.

### One process per swap

Run one process per swap. The store has one writer per record: a second instance on the same record is refused at its
first save with `FlowRecordStaleError`, so it cannot reset the first one's lock or fund leg A a second time. That
refusal is reliable except in one narrow window: two live instances that both meet a leftover lock file (a dead
process's, say) can interleave breaking it and taking it so that both of their saves pass (argued, not run). It needs
the very misuse this section forbids, so the rule stays one live flow per swap. A runner
that times out a step must still drop the old flow object, or kill its process, before it calls `resume`: a hung step
that wakes up later is refused at its next save, but the rule stays one live flow per swap. Inside one flow,
overlapping calls are refused as well: a second call of a step that is already in flight throws, and `claimLegB` and
`refundLegA` share one such flag (each decides from the other's outcome), so the Buyer never claims leg B and refunds
leg A at the same time.

- **The lock file.** `<role>-<id>.lock` exists only while a save runs (a few file operations) and carries the holder's
  pid and a random token. A save that finds it held by a live process waits up to five seconds (`lockWaitMs`), then
  fails with `FlowStoreLockedError`, which names the file and the holder's pid: another process is writing this
  record, so this one must not. A lock left behind by a process that is gone is broken automatically. So is one that
  names the runner's OWN pid after a restart: the process keeps a set of the lock files it holds right now, and a file
  with its own pid that is not in that set was left by a predecessor (killed inside a save, or a release that could not
  remove its file), so it is broken and the save goes on, with nothing for the desk operator to do. That is the common
  case for node running as pid 1 in a container, where every restart has the same pid. `FlowStoreLockedError` carries
  a `reason`, and its message says what a person can do about it; it never says "another instance" for the runner's
  own pid, and nothing is written in any case:
  - `held`, a live holder. "A save in this same process (pid N)" means a save of this very process is still running (a
    hung write): wait for it or drop the flow. A live pid that is not this process's says that another instance owns
    the swap. A pid that an unrelated process now has looks live as well (a recycled pid, or one that an early-boot
    service took after a reboot that killed a save mid-write; there is no boot-time heuristic): the message says so,
    and once no instance of the swap is running the operator removes the file it names.
  - `stale`, a leftover that cannot be removed. A lock naming a dead pid, or this very pid without this process
    holding it, is broken; if the file is still there after five attempts (a read-only attribute, a handle that
    forbids deletion) the error reads "a stale lock file naming pid N could not be removed: remove <path>". Remove
    that file by hand at the path the error names: no process is writing the record.
  - `unreadable`, the save's own lock file stayed unreadable through the retries of a transient EPERM, EBUSY or EACCES
    (a scanner or indexer holding it) when the save looked at it just before the rename: "the lock file could not be
    read ... nothing was renamed". The flow fails like after any refused save and the runner resumes; no other instance
    is involved.
  - `lost`, the save's own lock file was removed or replaced while the save held it (nothing was renamed).
- **One thread per store directory, a hard rule.** The set of held locks, and the begin queue below, belong to one
  thread (each worker thread has its own), while a lock file names only the process's pid, which all of its threads
  share. Two worker threads on one store directory therefore each take the other's live lock for a leftover of their
  own pid and break it: they lose the single-writer guarantee and the begin fence, a save can be lost, and one offer
  can be accepted twice (two secrets, two different accept A frames). Nothing detects it. A worker thread with a
  directory of its own is fine, a respawned one included (it breaks its predecessor's leftover, as a restarted process
  does). The store does not try to tell threads apart: worker thread ids are not stable across a respawn.
- **Where the directory may live.** On a local file system, used from one host and one pid namespace: no network share
  and no directory shared between containers. Liveness is judged by pid, and a pid cannot be judged across hosts or pid
  namespaces: there a live holder's lock reads as a dead one and is broken, and the compare-and-swap can be lost
  between its last look at the lock and the rename.
- **What fences two accepts of one offer.** Not the per-key compare-and-swap: two accepts of one offer mint two
  secrets and so name two different leg A contracts, hence two different record keys, and the swap never compares
  them. The Seller's begin (the scan for a record of this offer, the mint of the secret and the create of the record)
  is one critical section instead. In one thread, every store object on one directory shares one begin queue
  (`FlowStore.scopeId` is the resolved directory, lower-cased on Windows). Across processes,
  `FileFlowStore.exclusive("seller-begin")` runs the same three steps while it holds a lock file `seller-begin.lock`
  in the directory, taken exactly like a record's lock (a dead holder's file, or one naming the runner's own pid that
  it does not hold, is broken; a live holder gives `FlowStoreLockedError` after `lockWaitMs`, and a leftover that
  cannot be removed gives it with `reason` `stale`). The file is outside the key grammar and `list()` never shows it,
  and, being a file, it also covers a second spelling of the directory (a symlink or a junction) that the queue does
  not see. A store that offers neither (`MemoryFlowStore`, or a runner's own `FlowStore` with no `scopeId` and no
  `exclusive`) is fenced per store object only: run one Seller process on it. A refused begin says "another Seller
  begin is running (pid N)" ("in this same process" for the runner's own pid), not that another instance owns a swap,
  and it has minted and posted nothing. A begin lock left behind by a live Seller process (its release could not read
  or remove the file) blocks every other Seller process on that store, each accept being refused with that error,
  until that process begins again (it then breaks its own leftover) or exits; remove `seller-begin.lock` by hand if it
  persists. There is no background retry. A pid that an unrelated process now has looks live here as well, and the
  message then says so and names the file to remove by hand.
- **A Seller record that cannot be read blocks new accepts.** The begin scan reads every `seller:` record on the store.
  A record that fails its checksum or schema (`FlowStoreCorruptError`), carries a version this build does not read
  (`FlowRecordVersionError`), names another key or role (`FlowRecordMismatchError`) or cannot be loaded at all (a disk
  error) is never skipped: `acceptLegA` throws that error, whatever the offer, because an unreadable record cannot be
  shown not to be this offer's, and a second accept over it would mint a second secret and post a second, different
  accept A. A load error that was transient stops that one call; a damaged file stops every call until a person moves
  it aside (it may hold a secret a swap still needs, so the flow never moves it). Never reuse the offer. The error
  names the record it stopped at, its store key and, for `FileFlowStore`, the file ("the begin scan stopped at the
  stored record "seller:0x..." (file ...)"), so the person who moves it aside knows which one; it keeps the class and
  the fields the load raised.

### What a resumed step does

A saved transaction is asked about by its own handle, and the answer is one of four things. `landed`: it is on chain,
the evidence is recorded and the frame is posted. `pending`: not decided yet; nothing new is signed, ask again later
(`LockPendingError` for a lock; for a refund the message says it is signed but not yet confirmed and may never have
been sent). `never-landed`: the rail can prove it can no longer land, so one fresh transaction may follow (for a lock,
after one more read of it by its ref: see the NEAR and Solana bullets). `unknown` (Bitcoin and NEAR only): the node
has never seen the transaction and cannot prove it dead, so the flow re-sends the IDENTICAL saved bytes once, after
its own guards (identical bytes have one hash and one nonce, so this can never move funds twice; nothing is ever
signed again). The read never sends anything on any rail; a re-send is a separate call. A transaction that landed and
FAILED on chain (a NEAR refund whose payout failed, a Solana refund that failed) is resolved: it can never land again,
and exactly one fresh refund follows once the lock reads Locked and final. A refund that lost the race to a claim says
so, saves it, and `next` then says `learnSecret` (`done` once leg B's receipt is posted), whether or not a refund
attempt was already saved: a claim that `refundLegA` saw, or this flow's own claim of leg B, also wins in `next` over
the route for a lock that was attempted and not yet recognised. This flow's own claim of leg B also ends the refund
route after a refund attempt was saved: a person who ran `learnSecret` and `claimLegB` by hand is not sent back to
`refundLegA`, which refuses for ever once leg B is claimed, and `next` says `learnSecret` until leg B's receipt is
posted, then `done`. The frames of a leg A refund that had landed and were not yet posted then stay unposted (the
transcript only). The Seller has the mirror: a `refundLegB` that leg B's
claim made impossible (the paper rail refused it, and leg B's note reads claimed with a secret that opens this swap's
statement) clears the refund latch, saves `legBClaimSeen` and throws an error that names `claimLegA`; `next` then says
`claimLegA` (`done` once leg A's receipt is posted), and a repeat of `refundLegB` throws the same error without
reading the paper note or saving anything. A claimed note whose secret does not open the statement is not that claim:
the refusal and the latch stay as they were.

- **Leg B, the paper note (every rail).** A Seller's lock of leg B is a set-if-absent write; a repeat that finds a note
  already there reads it, adopts it when it carries this swap's terms, then posts the saved lock frame if the deal
  room lacks it (this also closes the old gap that `reconcileLegB` never re-posted the lock frame). When the note
  already shows this party's own claim or refund, the missing frames are posted; the repeated paper write that used to
  fail ("claim on a claimed record") is not reached.
- **Offers that expired (every rail).** tclk's machine rejects an accept stamped at or after its offer's `expiresMs`, so
  an accept posted then would never fold into the swap, while both parties went on to lock and claim real value on a
  swap the venue never accepted. A resumed Seller (which re-posts its saved accept A after any downtime) therefore
  refuses to post, or re-post, an accept A that has not landed once its clock is within `SELLER_OFFER_EXPIRY_MARGIN_MS`
  (5 seconds) of offer A's `expiresMs`. The Buyer refuses an accept A record whose own timestamp is at or after offer
  A's `expiresMs`, and refuses to post accept B at or after offer B's `expiresMs` by its clock (it keeps no margin: the
  5 seconds belong to the Seller's accept A post). The venue stamps a post when it arrives, a moment after the poster
  looked at its own clock, and its clock can run ahead, so a check of the clock alone is not enough for accept B. The
  Seller therefore also refuses to lock leg B against an accept B record whose own stamp is at or after offer B's
  `expiresMs` (no margin; nothing is saved, locked or posted, and the Seller's `next` stays `lockLegB`), and the Buyer,
  with a store, throws the same refusal instead of returning an accept B that the venue stamped at or after that time,
  whether it posted the line, adopted a copy from the room or is asked again on a resumed flow. The Seller's check runs
  only while no leg B lock attempt is recorded: an attempt that was recorded is recovered whatever the stamp of its
  accept B, because recognising a lock that may have landed is not a new action. The refusal is a `SwapExpiredError`
  (exported by `src/client/flow-resume.ts`, carrying `offerId` and `expiresMs`): nothing is minted, saved, posted or
  locked, and nothing can be at stake, because no lock exists on either leg before accept B. The one exception to
  "posted" is the Buyer's refusal of an accept B stamped late: that accept was posted before its stamp was known, so it
  is in the room and in the record, and the message says so; nothing is locked. An accept that DID land and whose mark
  was lost is still adopted: the refusals of a clock apply only where the line has to be posted, while the checks of a
  stamp read the landed record, adopted or not. A flow without a store is held to the same refusals, except that the
  Buyer returns the accept B it got back whatever its stamp (the Seller refuses it all the same). Once the offer has
  expired, `next` says `abandoned` for a Seller whose accept A is not recorded as landed (offer A, with the same margin)
  and for a Buyer whose saved pairing has no landed accept B (offer B). A Buyer whose accept B landed with a stamp at or
  after offer B's `expiresMs` is `abandoned` too, from the saved record whatever the clock says, while leg B is not
  verified and no lock of leg A was attempted. So `next` never names a step that will refuse for ever in those cases;
  the swap starts again from a fresh offer. The Seller has no mirror for the stamp (its record holds no accept B before
  a lock attempt), so its `next` stays `lockLegB` once offer B has expired unanswered or answered late (see "Limits of
  resume").
- **EVM.** The lock has no handle: the reference is the hash lock. A row under it, owned by this account, is `landed`
  (whatever status it has since reached). No row means the lock may be sent again: `approve` is harmless to repeat and
  a repeated `lock` is refused by the contract's duplicate hash-lock check, so a repeat can lock only once. A lock
  under this hash lock owned by another payer is refused by name (`lock-conflict`). A repeated refund is recognised
  from the lock's own state. The Seller looks for its own preimage in the contract's `Claimed` log from the block
  marker saved with its claim attempt; found, it posts the reveal and receipt and signs nothing. The marker is the
  chain tip when the attempt was saved minus a reorg margin (`CLAIM_MARKER_REORG_MARGIN_EVM`, 256 blocks, floored at 0),
  so a claim that a reorg mines below that tip is still inside the scan. The margin is 256 because the Base Sepolia safe
  head was measured 8 to 91 blocks behind its tip (92 samples on 2026-10-06, 90th percentile 79): an unsafe-head reorg
  can re-include a claim well below the tip its attempt saw, and a resumed Seller that misses its own landed claim never
  posts its reveal and receipt (liveness only, the Buyer still learns the secret from its own scan); the earlier 64 sat
  inside that lag. The price is one `eth_getLogs` over about 256 blocks more, which stays under the 500-block window
  recorded for the public Base Sepolia endpoint. That scan is one call from the marker to the tip and is not split into
  chunks, so a `claimLegA` that comes more than about 244 blocks after the attempt was saved (about 8 minutes at Base's
  2-second blocks) asks such an endpoint for more than its window: the call fails before anything is sent or posted, and
  so does every retry, until the runner uses an endpoint with a wider window (argued from the window, not run against
  that endpoint). The Buyer's lock marker keeps no margin; that is not a route under the default pin, which reads the
  lock at the finalized tag, but a deployment that pins by confirmations below the chain's reorg depth needs one there
  as well. After a restart a repeated approve, lock, claim or refund is refused by the contract, so the only cost is
  gas.
- **Bitcoin.** The funding transaction's id and its complete signed bytes are saved before the broadcast, and a
  resumed flow never re-prepares (a second preparation could pick other inputs and make a second outpoint). The node is
  asked about the txid, mempool included: known is `landed`, unknown is `unknown`, and after the guards the identical
  bytes are re-sent once. A refund is saved the same way: known with a confirmation is `landed`, known without one is
  `pending`, unknown while the funding output is still unspent means the identical refund bytes are re-sent, and unknown
  because another transaction spent the output means it can no longer land (no second refund is built; the Buyer is
  told to call `learnSecret()`). The Seller's claim is looked for on chain, mempool first, from the block marker saved
  with the attempt; a claim whose reply was lost and which mined before the retry now gets its frames posted. The
  marker is the tip minus `CLAIM_MARKER_REORG_MARGIN_BTC` (6 blocks, floored at 0), for the same reorg reason: a claim
  that a reorg mines below the tip is found, not claimed again.
- **NEAR.** A lock or refund is saved as its transaction hash plus its complete signed bytes before it is sent. The
  read asks by hash, then by the lock row at a final block (a lock row in any state counts as a landed lock; for a
  refund `Refunded` is landed and `Refunding` is pending), and answers `unknown` while the access key's nonce is still
  below the transaction's. A transaction that was signed, saved and never sent is proven dead by sending the identical
  bytes: the node's own `Expired` answer, or an invalid-nonce answer, gives `never-landed`, but only after the lock row
  is read again at a final block three blocks later and still shows nothing (a chain that does not move in that wait
  of about 14 seconds is `pending`). A refund is re-sent only while its lock still reads `Locked`. The Seller's claim
  is recognised from its own preimage on the lock, `Claimed` and final. Recovery assumes one consistent RPC node
  per chain. NEAR's `Expired` is also what nearcore answers for a base block hash it does not know, so a lagging node
  behind a load balancer can answer `never-landed` for a lock that landed elsewhere. Before a saved lock is replaced
  after a `never-landed` answer, the Buyer therefore reads the lock by its ref once more, after a short wait on the
  rail's own injected sleep (`settleDelay`, 2 seconds here: `NEAR_LOCK_REREAD_DELAY_MS`), and a lock found by that read
  is recorded as landed with nothing new signed. A node that stays behind for longer can still give a false
  `never-landed`: the fresh lock is then refused as a duplicate (payer, hash lock) and its tokens returned, the
  original lock is never announced, the Seller never claims it, and the swap ends in a refund after leg A's refund
  time. A double lock never happens.
- **Solana.** A lock, a claim and a refund are each saved as their signature, blockhash, last valid block height and
  signing slot before they are sent, and are resolved by that signature, never by a scan and never by signing again.
  `landed` is finalized with the escrow holding this leg's terms (an escrow that has since been claimed or refunded
  still counts as this payer's landed lock); `pending` is no status while the blockhash is still valid, a signature not
  yet finalized, or a node whose ledger starts after the signing slot; `never-landed` is a blockhash that expired with
  no status, no finalized transaction, and a ledger that reaches back to the signing slot. Solana never answers
  `unknown` and nothing is re-sent. The Seller restores its recorded claim signatures and resolves each one before any
  new claim; a never-landed claim is dropped and counted, and the next one is re-signed at a doubled priority fee. The
  one-consistent-node assumption holds here too (a load-balanced endpoint can have a member that lags a few slots):
  after a `never-landed` answer the escrow is read by its ref once more, after `settleDelay` (`SOL_RECHECK_DELAY_MS`,
  2 seconds), and a fresh lock that the program refuses as a duplicate of an escrow that did land ends in a refund
  after leg A's refund time, never in a second escrow.

### What still needs a person

A person can always call `learnSecret()`, `claimLegB()`, `reconcileLockA()` and `refundLegA()` by hand on a Buyer flow
that is still usable, whatever `next` says; each one reads the chain before it acts. The same holds for `claimLegA()`
and `refundLegB()` on a Seller flow that is still usable, each behind its own guards (`refundLegB` refuses before leg
B's `refundAfterMs`). After leg B was claimed, the Seller's way to its payout is `claimLegA()`, not `refundLegB()`. On
NEAR a revealed lock's claim retry skips the deadline guards (see "Known limits of the NEAR leg"), so `claimLegA()`
still works after leg B's refund time; on the other rails it refuses after leg A's `claimByMs`, and nothing is left
for the Seller to call (a liveness cost only: `next` then names a call that refuses). Beyond that, per rail:

- **NEAR.** A refund or lock that was signed and saved but never sent shows `pending` while the node is unreachable, or
  while the chain does not move. The flow settles it itself once the node answers (it sends the saved bytes, or sees
  `Expired`); when it cannot, a person has three routes: wait until the node answers `Expired` for the saved bytes
  (the node's transaction validity period, a genesis setting counted in blocks, runs out), broadcast the saved signed
  bytes (`signedTxBase64` in the record's recovery handle) by hand while they are still valid, or call the HTLC
  contract's refund directly. Also on NEAR, a lock stuck in `Claiming` or `Refunding` has no recovery method (a refund
  of a lock that reads `Refunding` is reported `pending`); see "Known limits of the NEAR leg".
- **Solana.** A starved claim, where the landing bound ran out: `SolClaimStarvedError` ("leg B exposed until
  legB.refundAfterMs") leaves the secret possibly seen, and settling needs a person.
- **Bitcoin.** If the node refuses to re-broadcast a saved funding (its inputs spent, a conflicting transaction, a
  policy rejection), the flow stops with a typed error (`RailRecoveryRefusedError`, code `rebroadcast-refused`). Check
  the wallet before any new attempt: a second funding is a second outpoint, and the flow never builds one by itself.
  Also: a Seller's claim that was broadcast and then left the mempool without being mined (evicted or replaced) leaves
  leg A unspent while the flows can read as finished. The Seller counts a broadcast claim as landed and posts its
  reveal, a Buyer that saw the claim only in the mempool follows `next` to `learnSecret`, learns the secret from the
  reveal and claims leg B, and the Seller's flow does not look at the claim again. A person re-broadcasts the Seller's
  claim before leg A's `refundAfterMs`; after that time the claim races the Buyer's refund (see "Known limits of the
  Bitcoin leg"). A runner that only follows `next` never does this. Recording the claim as landed only at one
  confirmation is on the Bitcoin-leg backlog and is not built.
- **EVM.** A lock under this hash lock that is not this account's (`lock-conflict`).
- **Any rail.** A lock or funding created outside the record (for example by another instance that ran without a store,
  or against a store since lost) is never refunded by the flow: find it on chain and refund it by hand after its
  timelock. A record that is corrupt or missing is a `FlowStoreCorruptError` or `FlowNotFoundError`, and the by-hand
  table below applies.

### Limits of resume

- **Paper notes are not bound to who wrote them.** Anyone who knows the secret can mark leg B's note `claimed`, and
  anyone can post a reveal frame. The flow cannot tell the Buyer's own claim, after a lost reply, from someone else's,
  so a paper note never blocks the Buyer's leg A refund: only a claim this flow made itself (the paper claim returned)
  does, and a note found already claimed with the swap's secret is adopted (frames posted, note recorded once) and
  leaves the refund available. By design, if this flow's own claim of leg B landed and its reply was lost, and nobody
  claimed leg A, the Buyer may refund leg A after its refund time and end with both legs on the paper rail. On testnet
  the paper leg moves no value. A guarantee of "never refund after a leg B claim" that survives a lost reply would need
  claimant-bound notes, which the vendored paper rail does not have. The same ending is reachable on Bitcoin when the
  Seller's claim of leg A drops out of the mempool after the Buyer adopted its own lost-reply claim of leg B; it too
  matters only once leg B carries value, and claimant-bound notes would close it as well.
- **A bundle written after a resume lacks the crashed process's RPC exchanges.** Those exchanges are evidence, not
  state, and are not persisted. Board and watcher captures stay replayable.
- **A Solana bundle written before the reveal.** A Solana claim's `simulateTransaction` request carries the signed
  claim, and with it the secret, to the configured endpoint (see the Solana limits). A bundle persists response bytes
  only, never request bodies. But after a claim that LANDED AND FAILED, reading the failed transaction
  (`getTransaction`, used to prove the secret public before the retry) returns the signed claim, secret included.
  Those exchanges used to go into the Seller's exchanges and so into a bundle written before the reveal; now the
  exchanges of failed claim attempts are held back until the reveal frame is posted, and `tests/bundle-leak.test.ts`
  scans every byte and file name of a real bundle for the secret in every common encoding. Two windows remain, both
  after the secret is already public on chain, and both by either party: a Seller claim that landed and then had its
  reveal post fail keeps its exchanges in the list at once; and a Buyer refund that fails on a lock that is already
  `Claimed` (it lost the race to a claim) keeps the exchanges it captured, which include the NEAR `get_lock` response
  or the Solana `Claimed` escrow, preimage included. A bundle written in either window can hold the secret.
- **A ring venue can repeat a line.** On a ring venue (the short offers room), a line whose landing was never confirmed
  and which has already rolled off cannot be told apart from one that never landed, so the flow posts the identical
  text again. Readers may then see a duplicate, which tclk's machine rejects when it sees the original first. A line
  the record shows as landed is never posted again, so this applies only to lines whose landing reply was lost.
- **After leg A's refund time `next` can name `refundLegA` for a lock that never reached the chain.** The record
  alone cannot tell a lock that was prepared and never sent from one that landed. `refundLegA` then fails with the
  rail's own error on every call and `next` does not change. Nothing is at risk (there is nothing to refund), but a
  runner driven only by `next` must stop after repeated errors. On the other variant, a lock that DID land and whose
  lock frame was never recorded, `refundLegA` works and its refund and receipt frames are rejected by tclk's machine
  (next bullet); if the Seller claimed that lock, `refundLegA` finds the claim and `next` says `learnSecret`.
- **A lock recognised late is not announced, and tclk's machine rejects what follows.** The machine rejects a `lock`
  frame at or after the offer's `refundAfterMs`. A lock recognised at or after leg A's refund time (a Buyer that
  restarts late, or one whose lock frame was never recorded) is therefore recorded but its lock frame is not posted (a
  flow without a store posts it as before), and the refund and receipt frames that `refundLegA` then posts are
  rejected as well: leg A's transcript folds to `accepted`. The mirror case comes earlier: if the Seller claims through
  the hash-lock fallback (EVM) before the Buyer's lock frame is posted, the Seller's reveal and receipt are rejected
  while leg A is only `accepted`, and the lock frame that follows folds the transcript to `locked` for ever, even after
  the swap settled. Funds are unaffected in every case; the transcript and `audit-export` then disagree with the chain.
- **Frames after a leg B claim that `refundLegA` adopted.** When `refundLegA`'s settle path finds leg B's paper note
  already claimed with this swap's secret, it adopts that claim and goes on with the refund; it does not post
  `reveal-b` and `receipt-b`. They are posted only when `claimLegB` is called. Once the refund frames land, `next` says
  `done`, so a runner driven only by `next` never posts them. Frames only, with no effect on funds or on the secret: a
  runner that wants a complete leg B transcript calls `claimLegB`, and `next` does not ask for it.
- **Leg A refund frames after the Buyer's own claim of leg B.** A refund of leg A can have landed with its refund and
  receipt frames not yet posted (the process died between them). If a person then runs `learnSecret` and `claimLegB` by
  hand (a Seller having posted its reveal without claiming leg A), `next` leaves the refund route for good and
  `refundLegA` refuses, so those frames are never posted: leg A's transcript lacks its refund. The transcript only; the
  refund itself landed.
- **At most one Bitcoin refund is sent; one may be built twice.** A Bitcoin refund's signed bytes go to the flow's save
  (the `onSigned` recorder) before the rail broadcasts them. If that save is refused, the first signed bytes never left
  the process, and after the restart the flow builds the refund once more (usually the same transaction, with the same
  txid). Once a refund's bytes are in the record, the restart re-sends those bytes and builds no other.
- **`abandoned` comes from the record and the clock, not from the venue.** `next` does no I/O, so it says `abandoned`
  for an accept that is not recorded as landed even when the line did land in the room and only its mark was lost. A
  runner that obeys `next` then drops a swap that `acceptLegA` or `acceptLegB` would still have adopted. For a Seller
  nothing is at stake (no lock on either leg, the secret never revealed: its accept A may be public, its secret is
  not), and no Buyer can have paired, because offer B is posted only after accept A's landed mark is saved. For a Buyer
  nothing is at stake either (leg A is never locked before accept B), but the Seller's leg B, locked on the strength of
  the landed accept B, stays locked until its refund time. Two edges of the expiry checks: the Seller does not test an
  accept A it adopts against the offer's expiry by the record's own timestamp, so an accept A that the venue stamped at
  or after `expiresMs` is adopted by the Seller and refused by the Buyer (`SwapExpiredError`), and the swap stalls with
  nothing locked; a FRESH accept A ends the same way when the venue stamps it late although the Seller's own check
  passed (the venue's clock more than 5 seconds ahead of the Seller's, or a post slower than that margin); and the
  Seller's 5 seconds on the accept A post are the only margin, because the Buyer's checks and the Seller's check of
  accept B's stamp have none. In both stalls the Seller's `next` keeps naming `lockLegB` (after its account line) for
  ever, because its record holds no accept B before it attempts a lock and nothing tells it that the Buyer will never
  answer.
- **Waits with nothing at stake that `next` does not call `abandoned`.** A runner that obeys only `next` waits, or
  retries a step that refuses, in these states, and in each of them no lock exists on the side that waits: a Buyer
  whose offer A expired with no pairing saved (`next` stays `acceptLegB`); a pairing that `acceptLegB` refused by the
  accept A stamp (nothing is saved, `next` stays `acceptLegB`); an accept B that landed in time and that the Seller
  never answers with a lock (`verifyLegBLocked`); leg B verified, leg A not locked and the lock deadlines no longer safe
  (`lockLegA` refuses and `next` stays `lockLegA`); and a Seller whose offer B expired unanswered, or was answered
  late (`lockLegB`; the late accept A of the previous bullet is the same wait). Whatever was locked on the OTHER side
  has its own doorway: the Seller refunds leg B after leg B's `refundAfterMs`, the Buyer refunds leg A after leg A's. A
  runner driven only by `next` needs a time limit of its own, or a stop after repeated errors.
- **The Bitcoin tests use a ledger fake.** The hermetic Bitcoin ledger fake mines instantly and always picks other
  inputs for a second funding; real Bitcoin Core coin selection differs (on a real wallet that holds the coins, a second
  preparation after the first broadcast would fund again; argued, not run). The double-funding tests therefore prove the
  flow logic, not the node's behaviour. The funding and refund re-sends are also run against a real `bitcoind`
  (`npm run test:regtest`).
- **What the tests exercise.** `npm test` runs a crash matrix that cuts both roles at every outward boundary, three
  ways (before the action, after it with the store write failing, after the store confirmed it), on five harnesses
  (the EVM mock node, the Bitcoin and NEAR fake rails, the NEAR RPC-level simulator and the Solana stateful node), plus
  the recovery itself being cut, time passing during the crash, a store that keeps refusing saves and two live
  instances on one store. The live suites add: anvil, six crash cuts (after `commitLock`, after the claim, after the
  refund, each cut two ways); regtest, four cuts around a funding and a refund (the saved bytes re-sent, or nothing
  re-sent when the node already knows them); NEAR, one scenario (a claim that landed with its reply lost); Solana,
  three scenarios (a lock, a claim and a refund whose replies were lost, each resolved by the recorded signature).
  NEAR's `Expired` and invalid-nonce answers, and the re-send of bytes that already executed, were tested against the
  simulator and mocks with the error shapes a real node gave; the live NEAR suite does not age a transaction past its
  validity. The saved block marker of a Seller claim (EVM, Bitcoin) is tested on a mock node and the ledger fake, not
  on a real node. Review round 2 added hermetic tests for the lock file left under the runner's own pid (planted, and
  after a refused read in `release`), two accepts of one offer through two store objects and through a real child
  process, an unreadable Seller record under the begin scan, a refund that lost the race to a claim on Bitcoin, NEAR and
  Solana, the Seller's refund that leg B's claim made impossible (the NEAR rail over the simulator), offers that
  expired, the claim marker under a reorg (the EVM mock node and the Bitcoin ledger fake), a NEAR lock whose lookup
  lagged (simulator only, like the `Expired` answers above), and a Solana refund that landed and failed because the
  program's clock lagged the flow's (`tests/flow-resume-sol-refund.test.ts`). Review round 3 added hermetic tests for
  an accept B that the venue stamped at or after offer B's expiry (the Seller's refusal, the Buyer's refusal and its
  `abandoned`, and a saved lock attempt that is still recovered), the Buyer's by-hand claim of leg B after a saved
  refund attempt, a claim re-included 200 blocks below the tip (the 256-block margin), one failed read of the lock file
  inside a save, the `reason` and wording of each lock refusal, the begin scan's error naming its record, and a Solana
  lock whose first status read lags (the real rail over the stateful node, `tests/flow-resume-sol-lag.test.ts`).
- **First-party and unaudited.** `src/client/flow-store.ts`, `flow-record.ts`, `flow-resume.ts` and the resume tests are
  first-party, unaudited and testnet-only (`PROVENANCE.md`).

### Without a store

A flow built without a `store` keeps its swap state in memory only; a process that dies loses it and nothing can rebuild
it. The same holds when the store is lost. Two differences from the rest of this section: the offer-expiry refusals (see
"Offers that expired") apply to a flow without a store as well (all but the Buyer's check of the stamp of the accept B
it got back, which is on the store path only), and a flow without a store still posts a lock frame at
or after leg A's refund time (only a flow with a store skips it). What a crash then costs, and what a person must do
(the table is written for the Solana leg: read the escrow by its ref with `getEscrow` and act by hand; the other rails
read their own lock by its ref the same way):

| Crash after | What is lost | What a person must do |
| --- | --- | --- |
| The Seller accepted leg A (secret minted) | the preimage, so the claim is impossible | nothing is locked yet; start a new swap. Never reuse the offer |
| The Seller locked leg B | the preimage (leg B can only be refunded) | after leg B's `refundAfterMs` the Seller refunds leg B by hand on the paper rail |
| The Buyer prepared the lock, before it landed | the prepared ref and signature | read the escrow at the payer-keyed ref; if it exists, it is refundable by the Buyer after `refund_after_ms` |
| The Buyer locked leg A | the flow state (accounts, ref, leg B pairing) | refund leg A by hand after `refund_after_ms` unless the escrow reads Claimed; never refund when leg B was claimed |
| The Seller signed a claim, before it was recorded as landed | the signature and `lastValidBlockHeight` | read the escrow: Claimed means the Seller was paid (post the frames by hand); Locked means send a fresh claim before `refund_after_ms` |
| The Seller claimed, before the reveal frame posted | the reveal and receipt latches | the Buyer reads the preimage off the Claimed escrow (`learnSecret` does not need the frame) and claims leg B |
| The Buyer learned the secret, before it claimed leg B | the secret | read it from the Claimed escrow's stored preimage and claim leg B on the paper rail before leg B's `refundAfterMs` |

## What this is not

No AMM, no pool, no custody, no relayer (yellow paper R10.4's allowlisted relayer is
not used: each party redeems its own leg), no point/adaptor locks (tclk's adaptor path is
unaudited reference crypto), no mainnet value. The profile carries a fee field (`docs/FEES.md`),
but every deployment we operate sets it to zero; no deployment here charges anything.

## License

MIT for this repo's own code. Vendored and derived files keep their upstream license — see
`PROVENANCE.md` for the full file-by-file list, sources and hashes.
