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
deal-room seqs it was derived from, and each paper note's `finalizedRef` — purely from what
`src/watcher.ts` already wrote to `DIR/raw/`. It opens no network connection: the offer-room
export(s), each deal room's capture(s), and any paper-rail note(s) are read straight off disk
and folded through the same `foldCaptured` (`src/replay.ts`) the live watcher uses, so a
capture can be re-verified without trusting the process that produced it.

`fixtures/rehearsal-2026-09-18/` is a byte-exact, watch-root-shaped capture of the real
2026-09-18 G0 rehearsal on `paper` — the four `tclk-offers` lines that made the pair, both
deal rooms' lock/reveal/receipt, and both paper notes fetched once, live, with curl. Run it:

```bash
node examples/audit-export.mjs --root fixtures/rehearsal-2026-09-18 \
  --expect 0xb0fa70a3c2a914134967fa423ae3295c2e35b6c3dfd6d461fb7a17fef2430d46=settled
```

## EVM leg (local, keyless)

`src/rails/evm-htlc.ts` binds the vendored `EvmHashRail` (`src/vendor/evm-hash-rail.ts`,
`contracts/EvmHashRail.sol`) into a desk rail with a chain pin (a mainnet deny list refuses
Ethereum/Base/Optimism/Arbitrum/Polygon/BNB/Avalanche mainnet by name even if someone pins
them), byte-exact JSON-RPC capture (`src/rails/rpc-capture.ts`) so every verdict can be
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

**Keyless throughout (D-10):** no private key, mnemonic, or seed for any EVM account exists
anywhere in this build — writes go out as JSON-RPC accounts (`eth_sendTransaction` from one of
anvil's own unlocked addresses) via a plain-address viem `WalletClient`. tclk's Ed25519 test
identities (`tests/helpers/identity.ts`) sign the deal-room transcript; they are not wallet keys.

**What this proves, and what it does not.** The three committed fixtures
(`fixtures/evm-anvil-2026-09-28/{settled,refunded,refunded-b}/`, replayed hermetically by
`tests/evm-anvil-fixtures.test.ts`) show a real ERC20 escrowed, claimed or refunded on a real
EVM contract, with every verdict re-derivable from the exact captured RPC bytes — but on
`anvil-local` (chain id `31337`), an ephemeral node this repo itself starts and stops, never a
real network, and never with mainnet value at any point in this build (D-09/D-10). The
Base Sepolia deploy (P2.5) — a real testnet, a real key loaded from env and never printed, the
account lines exchanged for real — is Dave's own G1 step and is not built here.

## What this is not

No AMM, no pool, no custody, no relayer (yellow paper R10.4's allowlisted relayer is
not used: each party redeems its own leg), no point/adaptor locks (tclk's adaptor path is
unaudited reference crypto), no mainnet value. The profile carries a fee field (`docs/FEES.md`),
but every deployment we operate sets it to zero; no deployment here charges anything.

## License

MIT for this repo's own code. Vendored and derived files keep their upstream license — see
`PROVENANCE.md` for the full file-by-file list, sources and hashes.
