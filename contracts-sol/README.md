# contracts-sol

First-party, unaudited, testnet/localnet-only Solana program for the FLOP swap desk's Solana leg
(`handoff/P6-SOL-SPEC.md` section 2). Native Rust (no Anchor), one crate:

- **`htlc`**: a hashed-timelock escrow for one SPL token (the configured USDC mint). `Lock` moves tokens
  into a vault behind a sha256 hash lock; anyone may `Claim` with the 32-byte preimage (the vault pays
  the named payee), or the payer `Refund`s once the window has closed.
- **`htlc-tests`**: litesvm tests that load the **built `.so`** (see "Why two workspaces").

## Program id and deployment model (keyless)

The program id is fixed in code: `base58(sha256("flop-swap-desk:sol-htlc:v1"))` =
`GedsjashYAxaoETcwBZQR1YgBbuEaK8QiiKu2qi6xe6C`. Nobody holds a key for it. It is loaded at genesis with
`solana-test-validator --upgradeable-program <id> <so> none`, which installs it under the upgradeable loader
with the upgrade authority disabled. Finding (SB1): this validator (Agave 4.3.0) records "no authority" not
as `None` in the ProgramData account but as the all-zero address (the System Program id, `1111...1111`),
identically for plain `--bpf-program`; no key can sign for that address, so the program is immutable in
practice. `smoke.sh` accepts exactly `None` or the all-zero address and nothing else. A consumer must check three things (P6 section 2): the program
account is executable, its ProgramData bytes hash to the reviewed `.so` sha256, and the upgrade authority is
`None` or (on this validator) the all-zero address. The program also refuses to run under any other id (`WrongProgramId`), because every PDA derives
from the declared id.

## Accounts and state

- **Escrow** = PDA `["htlc", payer, hash_lock]`, owned by the program. Keyed by the payer, so another payer
  locking under the same public hash lock lands in a different account and cannot block the real one (the
  NEAR squatting fix, applied from the start). Layout (188 bytes, byte 0 is the version, integers LE):

  | offset | field |
  |---|---|
  | 0 | version (= 1) |
  | 1 | status: 1 Locked, 2 Claimed, 3 Refunded |
  | 2 | revealed (1 once claimed) |
  | 3 | PDA bump |
  | 4 / 36 / 68 / 100 | payer / payee / mint / hash_lock (32 bytes each) |
  | 132 / 140 / 148 | amount u64 / claim_by_ms i64 / refund_after_ms i64 |
  | 156 | preimage (32 bytes; zero until claimed) |

- **Vault** = PDA `["vault", escrow]`, a classic SPL token account (165 bytes) for the mint, whose token
  owner is the escrow PDA. The program creates it (no associated-token-account program involved).
- **Payee** = the *owner* of the token account that a claim pays. The claim needs that account to exist,
  be initialised, unfrozen, for the mint, and owned by the payee named in the lock.
- The token program is the classic SPL Token program only. Token-2022 is refused on purpose (transfer
  hooks, fees and freeze extensions change transfer semantics).

### Instructions (first data byte)

| tag | name | data after the tag | accounts |
|---|---|---|---|
| 0 | Lock | hash_lock[32], payee[32], claim_by_ms i64, refund_after_ms i64, amount u64 (89 bytes total) | payer (s,w), escrow (w), vault (w), mint, payer token account (w), token program, system program |
| 1 | Claim | preimage[32] (33 total) | escrow (w), vault (w), mint, payee token account (w), token program |
| 2 | Refund | none (1 total) | payer (s), escrow (w), vault (w), mint, payer token account (w), token program |

Errors are `ProgramError::Custom(n)`; the numbering is the `HtlcError` enum in `htlc/src/lib.rs`.

## Guarantees (each has a test that fails without it)

- **Lock** refuses: amount 0; `claim_by_ms >= refund_after_ms`; `now_ms >= refund_after_ms`
  (`now_ms = Clock.unix_timestamp * 1000`, checked multiplication); a payee equal to the escrow or vault
  address, the all-zero address (System Program id), this program, the token program or the mint (a payee
  nobody can sign for; the NEAR H5 twin; other unreceivable addresses such as another escrow PDA cannot be
  told apart on chain and stay a client check); any mint other than the configured one; a payer token account that is not the payer's, not for
  the mint, frozen, or too small; a second lock by the same payer under the same hash lock. Rent for both
  new accounts is paid by the payer. The transfer is a `TransferChecked` CPI and the vault balance is
  re-read and must equal the amount.
- **Claim** is permissionless (no signer besides the fee payer), needs status Locked, `now_ms <
  refund_after_ms`, and `sha256(preimage) == hash_lock` (the `sol_sha256` syscall). It sets Claimed and stores
  the preimage, then pays the vault to the payee's token account. The payout CPI is atomic with the
  state change: a failed payout reverts the whole transaction (status stays Locked, no preimage stored), so a
  "revealed but unpaid" state cannot exist on Solana. The preimage is still public in the failed
  transaction's instruction data, and, unlike NEAR (which records the reveal and then refuses refund), Solana
  keeps no revealed state: the escrow stays Locked with revealed = 0, so the payer can still `Refund` after
  `refund_after_ms`. In the desk's protocol the Seller mints the secret and the Buyer is the payer of this
  leg, so the leaked secret reaches the Buyer, who could claim leg B *and* refund this escrow. The program
  cannot close this (the secret is in the instruction data whether the transaction succeeds or fails; a
  claim landing at or after `refund_after_ms` fails with ClaimWindowClosed and leaks it the same way). The
  protection lives in the SB2 client: always simulate a claim first; give it a blockhash whose
  `lastValidBlockHeight` expires (at the slower slot-time estimate) before `refund_after_ms` minus a margin,
  so a late claim is dropped rather than executed and published; treat any failed claim as urgent and retry
  at once. Tests: `failed_claim_leaves_the_escrow_locked_and_refundable`,
  `late_claim_fails_with_the_secret_public_and_refund_still_works`.
- **Refund** needs the payer's signature, status Locked and `now_ms >= refund_after_ms`; it pays the vault to
  a token account owned by the payer and sets Refunded. Claim and Refund are mutually exclusive at the
  boundary: at `now_ms == refund_after_ms` claim is closed and refund open; one millisecond earlier it is
  the reverse.
- **Account validation on every instruction**: exact account count, no duplicate accounts, signer and
  writable flags, escrow address re-derived from its own stored payer/hash lock/bump, vault address
  re-derived, token program id, system program id, mint address and mint account, every token account's
  owner program, length, initialised state, mint and token owner, escrow owner/length/version. Substitution
  attacks (fake vault, fake escrow, wrong token program, a payee account owned by someone else, a wrong
  mint) are refused before any state changes.
- **Pre-funding cannot block a lock**: lamports sent to the escrow or vault PDA in advance are adopted
  (top up, allocate, assign) instead of failing with "account already in use".
- **A stray donation to the vault is not stranded**: the payout moves the whole vault balance.
- Terminal escrows stay on chain with status and preimage (an evidence reader reads them).

## Mint configuration and its trust assumption

The accepted mint is a **compile-time constant** taken from the environment variable
`FLOP_SOL_USDC_MINT` (base58) by `htlc/build.rs`; unset, it is the keyless localnet mock mint
`base58(sha256("flop-swap-desk:sol-mock-usdc:v1"))` = `91cjWuWZvm24ttxccaWHkAcXQcDw1jce4PNqknzRNSMz`.

Why this form: an init instruction with "first caller sets the mint" would be a race anyone could win on
a public chain before the desk did, and a config PDA needs its own trust story. A constant is covered by
the reviewed `.so` sha256 that the desk already pins, so there is nothing extra to trust or to check: a
different mint means a different program hash. The cost is one build per mint. Trust assumption: the desk
pins the `.so` hash for the mint it means to use (the localnet mock mint has to be created at that fixed
address at genesis, for example with `--account`; that is a validator-harness job, not the program's).
The litesvm tests assume the default mint.

## Known limits

- **Token-level authorities are outside this program.** A real USDC mint has a freeze authority: if the
  issuer freezes the vault (or the payee/payer account), claim/refund fail until it is unfrozen, and funds
  wait. The program cannot prevent this. It refuses frozen accounts up front so the failure is explicit.
- **Rent is not reclaimed.** Escrow and vault stay open after a terminal state (the escrow must, for
  evidence); about 0.0039 SOL per swap stays locked. No `Close` instruction.
- **Hash-lock length**: a hash lock is any 32 bytes; a hash published for a non-32-byte secret can never be
  claimed (the preimage type is exactly 32 bytes), matching the other rails.
- **Time is validator time.** `Clock.unix_timestamp` is stake-weighted validator time with second
  resolution; a claim landing close to `refund_after_ms` can lose the race to a refund, so clients keep a
  landing margin.
- **No on-chain claim_by enforcement.** `claim_by_ms` is recorded and validated against `refund_after_ms`
  but only `refund_after_ms` gates a claim (as on NEAR); the client enforces `claim_by`. Consequence for the
  protocol: the secret can become public as late as `refund_after_ms` minus one second, so the Buyer derives
  leg-B safety from leg A's `refund_after_ms`, never from `claim_by_ms`; SB2/SB3 terms validation must refuse
  terms where legB.refundAfter minus legA.refundAfter is smaller than the Buyer's landing margin even when
  claimBy leaves room, and an evidence reader must not treat `claim_by_ms` as a bound on disclosure.
- **Not yet run on a real validator (SB-int).** Lock, Claim and Refund (including the prefunded lock, the
  CPIs made without the callee in `account_infos`, the executable-flag checks and the rent path) are proven
  only in litesvm 0.17; `smoke.sh` exercises only an unknown-tag simulation. A runtime difference would be a
  liveness failure, not a fund loss (every failure is atomic). SB-int must run them end to end on
  `solana-test-validator` (mock mint created at its fixed address with `--account`) before the `.so` hash is
  pinned.
- **Upgrade-authority rule the evidence reader inherits.** Accept a ProgramData authority of exactly `None`
  (tag 0) or `Some` of the 32 zero bytes, nothing broader. The zero bytes are a small-order ed25519 point;
  this is safe only because Solana verifies transaction signatures with `verify_strict`, which rejects such
  keys, so nobody can sign as the all-zero address. Any other key, including other low-order encodings, fails
  closed (SB2 `sol-evidence.ts` / `connect()` must spell this out and test it).
- **Gas/compute** is small (well under the default 200k units per instruction) and was not tuned.
- **Unaudited, testnet/localnet-only.** Not for mainnet value.

## Build and test

Run in WSL through the Bash tool (script files, never `$VAR` inline in `wsl bash -lc '...'`):

```
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/flop-swap-desk-sol/contracts-sol/build.sh'"
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/flop-swap-desk-sol/contracts-sol/smoke.sh'"
```

`build.sh` runs the host unit tests, builds with `cargo-build-sbf` (Agave 4.3.0, platform-tools v1.57;
target dir `~/.cache/flop-sol-target-<hash of the worktree path>` from `scripts/cargo-target-dir.sh`, unique per worktree), deletes the generated `*-keypair.json` unread, runs the litesvm tests
against the built `.so`, and prints its size and sha256. `smoke.sh` starts `solana-test-validator` on free
ports with the program at genesis, checks that the program account is executable, that the ProgramData bytes
hash to the built `.so` and that the upgrade authority is `None` or the all-zero address, that the program answers under its fixed id,
then stops the validator by its own pid and deletes the ledger. It never opens the ledger's key files.
`smoke.sh` must run inside a `wsl.exe` call that stays alive (it does; use the Bash tool's background mode).

## Dependency choices (recorded)

- `solana-program = "=5.1.0"` (latest at build time; the split crates were not needed). It builds cleanly with
  `cargo-build-sbf 4.3.0` / platform-tools v1.57 and is the version the SB0 probe verified.
- `spl-token-interface = "=3.0.0"`, the SPL Token interface crate (Anza, `solana-program/token`). It depends on
  `solana-pubkey` 3.x while `solana-program 5.1.0` uses 4.x, so the two `Pubkey` types differ and its
  instruction builders cannot feed `solana_program::program::invoke`. The program therefore builds the
  `TransferChecked` / `InitializeAccount3` instructions itself (a few bytes each) and unit tests pin them, and
  the account/mint layout constants, against the interface crate's `pack()` output. It is a dev-dependency only (unit tests), not in the SBF build graph. No other crate is added
  to the program; the system-program instructions are hand-encoded too.
- Tests: `litesvm = "=0.17.0"` (in-process SVM, Agave 4.3 based; loads the built `.so` and lets the harness
  set the Clock sysvar). Chosen over `mollusk-svm` because it runs whole transactions with real account
  loading and rent checks.

### Why two workspaces

`litesvm 0.17.0` pins `solana-epoch-schedule ~3.3` while `solana-program 5.1.0` needs `^3.4`, so a single
dependency graph cannot hold both. `contracts-sol/` is the workspace for `htlc` (its own `Cargo.lock`);
`contracts-sol/htlc-tests/` is a separate workspace with its own `Cargo.lock`. The tests never import the
program's Rust types; they exercise the `.so` through bytes, which is also the stronger check. Both lock files
are committed and both builds use `--locked`.
