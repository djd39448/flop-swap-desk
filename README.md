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

**Alpha, Phase 0, keyless.** Nothing here moves value. There is no FLOP testnet RPC yet; the
FLOP leg is bound through tclk PR #171's mock chain only. No rail evidence exists, so the board
cannot advance a swap past `paired` today — by design, not by accident (fail closed). Every
end-to-end atomicity claim remains PENDING until yellow paper open item E.48 closes, and this
repository does not present one.

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

## What this is not

No AMM, no pool, no fee, no custody, no relayer (yellow paper R10.4's allowlisted relayer is
not used: each party redeems its own leg), no point/adaptor locks (tclk's adaptor path is
unaudited reference crypto), no mainnet value.

## License

MIT. `vendor/tclk` is Apache-2.0, © FLOP Labs contributors.
