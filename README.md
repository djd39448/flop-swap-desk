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

which overwrites `fixtures/evm-anvil-2026-09-28/{settled,refunded,refunded-b}/` in place. Commit
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
(`fixtures/evm-anvil-2026-09-28/{settled,refunded,refunded-b}/`, replayed hermetically by
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
prefix> <pubkey>`, `src/rails/account-line.ts`) rather than an address line.

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
default, so an ordinary `npm run test:regtest` never touches the three committed fixtures below.
Regenerating them is a deliberate, separate step:

```bash
CAPTURE_BTC_FIXTURES=1 npm run test:regtest
```

which overwrites `fixtures/btc-regtest-2026-09-28/{settled,refunded,refunded-b}/` in place.
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
(`fixtures/btc-regtest-2026-09-28/{settled,refunded,refunded-b}/`, replayed hermetically by
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
party (`swap1 account near-htlc near:<chain id>:<account id>`, D-N5) — the contract authorizes
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
completed write, called on the rail directly in a client-flow scenario). Recovery in the client
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
touches the three committed fixtures below. Regenerating them is a deliberate, separate step:

```bash
CAPTURE_NEAR_FIXTURES=1 npm run test:near
```

which overwrites `fixtures/near-sandbox-2026-09-29/{settled,refunded,refunded-b}/` in place.
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

**What this proves, and what it does not.** The three committed fixtures
(`fixtures/near-sandbox-2026-09-29/{settled,refunded,refunded-b}/`, replayed hermetically by
`tests/near-sandbox-fixtures.test.ts`) show a real `htlc` contract funded, claimed or refunded on
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
  no-secret `storage_balance_of` pre-check (P5-NEAR-SPEC.md §4) exists specifically to stop this
  build's own client from ever reaching that state through the normal claim path; it is only
  reachable by a caller that builds and sends the raw transaction directly, bypassing the
  adapter's own guard on purpose (exactly how this stage's own test reproduces it).
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
  refuses a contract that holds any access key (H6), but the NEP-141 token is checked only by
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

## What this is not

No AMM, no pool, no custody, no relayer (yellow paper R10.4's allowlisted relayer is
not used: each party redeems its own leg), no point/adaptor locks (tclk's adaptor path is
unaudited reference crypto), no mainnet value. The profile carries a fee field (`docs/FEES.md`),
but every deployment we operate sets it to zero; no deployment here charges anything.

## License

MIT for this repo's own code. Vendored and derived files keep their upstream license — see
`PROVENANCE.md` for the full file-by-file list, sources and hashes.
