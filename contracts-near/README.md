# contracts-near

First-party, unaudited, testnet-only NEAR contracts for the FLOP swap desk's NEAR leg
(P5-NEAR-SPEC.md). A Cargo workspace with two crates:

- **`htlc`** — the hashed-timelock contract. Any configured NEP-141 token's `ft_transfer_call`
  locks funds behind a sha256 hash lock; a payee reveals the 32-byte preimage to `claim`, or
  the payer `refund`s after a deadline. Locks are keyed by (payer, hash lock) — see "Lock keys and
  method signatures" below.
- **`mock-ft`** — a test-only NEP-141 + NEP-145 token standing in for Circle's NEAR USDC (6
  decimals, symbol `USDC`, owner-minted), exactly like `MockERC20` on the EVM leg.

This directory went through an NB1 fix pass (2026-09-29) against an opus review that found
one critical, one high, two medium and four low fund-safety/hygiene findings (F1–F8). All
eight are fixed or documented below; see the git log (`NB1 fix F1`..`F8`) for the detailed
per-finding rationale and the test that fails without each fix.

## Lock keys and method signatures

Locks are keyed by **(payer, hash lock)**: the storage key is `"<payer account>:<hash_lock hex>"`
(helper `lock_key`; a NEAR account id never contains `:`, so the key is unambiguous). The payer is
the account that sent the `ft_transfer_call` (`sender_id` in `ft_on_transfer`).

| Method | Signature | Notes |
|---|---|---|
| `ft_on_transfer` | `(sender_id, amount, msg)` | stores the lock under `(sender_id, hash_lock)`; refuses a duplicate only for that same pair |
| `get_lock` | `(hash_lock, payer)` | view; `null` when that pair has no lock |
| `claim` | `(hash_lock, payer, preimage)` | still permissionless; pays the stored payee; names the lock's payer |
| `refund` | `(hash_lock)` | keyed by `(predecessor_account_id, hash_lock)`: only the payer's own account can reach its own lock |
| `on_transfer_complete` | `(hash_lock, payer, exit, result)` | private callback |

The desk's NEAR ref is `0x<hash lock hex>:<payer account id>` (`src/rails/near-ref.ts`); it is
known before any write, and every adapter call derives `hash_lock` and `payer` from it.

## What the `htlc` contract guarantees

- **`claim` only pays out for the correct, full-length secret.** `env::sha256(preimage) ==
  hash_lock` is required, *and* the decoded preimage must be exactly 32 bytes (F1) — matching
  every other rail in this swap (tclk's `verifySecret`, the EVM `claim(bytes32,bytes32)`, the
  Bitcoin script's `SIZE 32 EQUALVERIFY`). A hash lock published for a non-32-byte secret can
  never be satisfied here, so a malicious counterparty cannot strand the other side by
  publishing `H = sha256(s')` for `|s'| != 32`.
- **A lock can only be created by the configured token.** `#[init]` takes one `usdc_token:
  AccountId`; `ft_on_transfer` refuses (full refund) any call whose predecessor isn't that
  account (F3). This closes direct-call storage-spam (a non-token account can no longer occupy or
  drain the contract's own storage staking by calling `ft_on_transfer` directly with no real
  transfer behind it), at the cost of making the contract single-token per deployment — see
  "Known limits" below.
  `ft_on_transfer` also validates `msg` strictly: unknown JSON fields are refused
  (`deny_unknown_fields`), and `claim_by_ms`/`refund_after_ms` must be a plain digit string
  with no leading `+` or leading zero (F8).
- **A new lock is refused if the contract can't afford it.** After inserting a lock,
  `ft_on_transfer` checks `env::account_balance() >= env::storage_byte_cost() *
  env::storage_usage() + 0.05 NEAR`; if not, the lock is rolled back and the token refunds the
  sender in full (F2). This keeps a fixed reserve free for `claim`/`refund`'s own 1-yoctoNEAR
  attached deposit and the callback's gas refund.
- **`claim` never grows storage.** `Lock.preimage` is a fixed `[u8; 32]` allocated (zeroed) at
  lock time; `claim` only overwrites it in place, never changes the entry's serialized size
  (F2). A `claim` can never fail on storage staking that a lock's own creation didn't already
  cover.
- **Hash-lock squatting is closed.** A third party who locks 1 unit under a public hash lock
  first occupies only its own `(squatter, hash_lock)` key: the real payer's lock, under
  `(payer, hash_lock)`, still succeeds, is claimed and refunded on its own, and a squatter's lock
  can be neither claimed against nor refunded through the real payer's key (`claim` names the
  payer, `refund` is keyed by the caller). The squatter can only refund its own unit after its own
  window. (Before this fix, locks were keyed by the hash lock alone and the first writer won.)
- **A revealed lock can't be refunded out from under the payee.** Once `claim` has verified a
  preimage (even if the payout callback then fails and `status` reverts to `Locked`), `refund`
  is refused and `claim` may keep retrying regardless of `refund_after_ms` (F4). The payer is
  not harmed by this: it already has the same preimage, usable on the other leg.
  A revealed preimage is now included in the "claiming"/"claimed" event log, not only in
  `get_lock` state (F6).

## Known limits

- **Single-token deployment.** The file's original design was fully asset-agnostic ("any NEP-
  141 token may call `ft_on_transfer`"); the F3 fix narrows this to one configured
  `usdc_token`. A deployment that needs more than one token needs either multiple `htlc`
  contract instances or a future allow-list (`Vec<AccountId>`) generalization.
- **A stuck `claim`/`refund` payout callback has no recovery method (F5, not fixed).** If
  `on_transfer_complete`'s callback itself panics or runs out of gas, the lock's `Claiming`/
  `Refunding` status is never resolved and no method can move it out of that state. For the
  configured USDC mock (and real NEAR USDC, which also returns an empty `ft_transfer` result)
  this cannot happen: `CALLBACK_GAS` (10 Tgas) is far above what reading/writing one
  `LookupMap` entry costs, and near-sdk-macros 5.29.1 maps an empty successful result to
  `Ok(())` rather than attempting a JSON deserialization that could fail. It *can* happen for
  a non-standard NEP-141 token whose `ft_transfer` returns a non-empty, non-JSON-unit result
  (e.g. the literal `true`): the generated `#[callback_result]` deserialization panics with a
  JSON error, and the callback never runs its own logic. Only locks funded by such a token are
  affected; this desk's own token allow-list (F3) is the practical mitigation (only fund the
  contract with a token verified not to do this), and the evidence reader must keep treating
  `Claiming`/`Refunding` as non-final outcomes (per D-N10) rather than assuming a stuck lock
  resolves. A proper fix (reading the raw promise result via `env::promise_result(0)` instead
  of `#[callback_result]`, so any successful result counts regardless of its bytes) was not
  applied in this pass because it would require dropping the `#[callback_result]` parameter
  entirely, which the existing unit tests rely on to inject `Ok(())`/`Err(PromiseError::Failed)`
  directly — a hermetic-test-only workaround this contract's own doc-tested method signature
  can't reproduce, as the reviewer's own note on this finding says ("not testable
  hermetically... unit tests call the method body directly and skip the macro's
  deserialization"). Left for a future pass with sandbox-backed (not unit) coverage.
- **An unregistered payee's claim reveals the preimage without paying out.** `claim()` writes
  the preimage (making it public) and flips the lock to `Claiming` BEFORE its own `ft_transfer`
  cross-contract promise ever runs; if the payee named in the lock was never
  `storage_deposit`'d on the token, that promise fails, and the callback reverts the lock back
  to `Locked` — but the preimage stays public regardless, since it was written before the
  promise chain even started. This is inherent to any "reveal-then-pay" callback design on
  NEAR, not a bug this contract could fix by reordering (the preimage must be checked, and so
  known, before any transfer can be attempted at all). The desk's own client
  (`src/rails/near-htlc.ts`'s `claim()`) mitigates this with a no-secret `storage_balance_of`
  pre-check before ever signing a claim; a caller that builds and sends the raw transaction
  directly, bypassing that guard, can still reach this state — exercised end to end by
  `tests-near/near-htlc.near.test.ts`'s own "claim to an unregistered payee" scenario and
  `tests-near/client-flows.near.test.ts`'s client-flow twin of it (see the main `README.md`'s
  own "NEAR leg" section).
- **No 1-yoctoNEAR requirement on `claim`/`refund`.** Unlike `ft_transfer`/`ft_transfer_call`
  on the NEP-141 side, this contract's own `claim`/`refund` methods don't require an attached
  deposit from their caller — anyone may call `claim` permissionlessly by design (the payee
  doesn't need a NEAR balance to be paid), and `refund` is restricted to the payer by account
  id instead.
- **Storage per lock grows with the payer's account id.** The key is `"<payer>:<hash lock hex>"`,
  so a lock costs the payer-account length plus one byte more storage than a bare hash-lock key.
  (The F2 reserve check still covers it.) A squatter's 1-unit lock still costs the contract
  storage staking; the F2 reserve check refuses new locks when the contract can no longer afford
  them, exactly as before.
- **Storage is never freed and is cheap to consume.** `claim` and `refund` only change a lock's
  status; the row and its storage stay, and a lock costs its creator one token unit plus gas. Enough
  cheap locks make the F2 reserve check refuse every new lock until the contract account is topped
  up. Nothing in the contract prunes rows or charges the payer for the storage it occupies.
- **A revealed lock cannot be refunded (F4).** If the payee named in a lock never registers
  storage on the token, a revealed lock can neither pay out nor be refunded; the payer's funds stay
  in it. The payer keeps the preimage for the other leg.
- **The token itself is not pinned by code hash.** The contract trusts one configured token
  account id; that token's own code (upgradeable, in Circle's case) is outside this contract.
- **Unaudited, testnet-only.** No formal audit; not intended for mainnet value.

## Gas and storage constants

| Constant | Value | Where |
|---|---|---|
| `FT_TRANSFER_GAS` | 10 Tgas | attached to the `ft_transfer` cross-contract call from `claim`/`refund` |
| `CALLBACK_GAS` | 10 Tgas | attached to `on_transfer_complete` |
| storage reserve | 0.05 NEAR | kept free (beyond storage staking already owed) before a new lock is accepted, F2 |

These two constants are this CONTRACT's own internal gas reservation — how much of whatever the
caller attaches to `claim`/`refund` this contract itself statically sub-allocates for the
`ft_transfer` promise and its callback — and were left unchanged by NB-int's own D-N9 pass.
What NB-int measured and corrected was the CALLER's own side of this: the adapter's
`FT_TRANSFER_CALL_GAS`/`CLAIM_REFUND_GAS` (`src/rails/near-htlc.ts`, attached gas, not this
table's reservation), from a provisional 100/60 Tgas down to 20/40 Tgas against real measured
burn on the sandbox (`tests-near/near-htlc.near.test.ts`'s own `measuredGasBurnt`) — see that
file's own doc comment for the full story, including why `CLAIM_REFUND_GAS` could not simply be
set close to the ~7.3 Tgas actually burnt: it must stay comfortably above this table's own 20
Tgas of static sub-allocation (`FT_TRANSFER_GAS` + `CALLBACK_GAS`), which is checked eagerly at
promise-creation time, a different constraint from total gas burnt. See the main `README.md`'s
own "NEAR leg" section for how to run this leg's tests and what its committed fixtures prove.

## Build instructions

Everything runs inside WSL (Ubuntu 24.04, Rust 1.98.1 + `wasm32-unknown-unknown`, near-sandbox
2.13.4 / protocol 86 — see `handoff/P5-NEAR-SPEC.md` §0 and `tests-near/probe/README.md`).
From Windows Git Bash, never inline `$VAR`-bearing shell logic straight into a single-quoted
`wsl bash -lc '...'` string (it gets silently stripped — see the probe README's "Environment
gotcha"); call a script file by path instead, double-quoting the outer command:

```bash
# cargo test --workspace, then a release wasm32-unknown-unknown build of both crates:
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/<this-worktree>/contracts-near/build.sh'"

# keyless smoke test: deploys both wasms to a throwaway sandbox via sandbox_patch_state and
# runs a view call against each, with no keys used or generated:
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/<this-worktree>/contracts-near/smoke-test.sh'"
```

`build.sh` builds into `CARGO_TARGET_DIR=$HOME/.cache/flop-near-target-<hash of the worktree path>` (from
`scripts/cargo-target-dir.sh`, so two worktrees never share or overwrite a build; WSL-native, not
`/mnt/c`, for speed); the wasm artifacts themselves are never committed. `Cargo.lock` is
committed (D-N11).
