# Provenance

Files vendored or derived from `@flop-labs/tclk` (upstream `flop-labs/tclk`), fetched into this
repo's `vendor/tclk` git submodule object store as local refs. Every hash below is the sha256 of
the exact git blob bytes (`git -C vendor/tclk show <rev>:<path> | sha256sum`) — never a working
copy, which can be rewritten by a checkout's autocrlf settings.

## tclk#21 — `EvmHashRail.sol` and its Foundry test (vendored byte-identical, except `foundry.toml`: see below the table)

Source: fork `pplmaverick/tclk`, PR #21, head commit `d6477ac0aba7827a23bc77c72980dfc154c24e76`.
**PR #21 was closed unmerged on 2026-09-06** — sv's review comment was that tclk/1 should not
carry a value-bearing rail plus a bundled Solidity toolchain in the same package. We vendor the
contracts here instead, with this file as the provenance record, because the code itself is
useful and will never land in tclk/1 proper.

| path (this repo) | source path (tclk#21) | git blob id | sha256 (blob bytes) |
|---|---|---|---|
| `contracts/EvmHashRail.sol` | `contracts/EvmHashRail.sol` | `e4c328b2abf44f8ab12d14d168af22ecfc820652` | `4b1cd91f35acbe3dd97e0af575b178239f8a1899a66d61bc7ca2d25f971b6447` |
| `contracts/IERC20.sol` | `contracts/IERC20.sol` | `4ffc7e1988143c914e16d0c3e1e0ddd80066bfb3` | `3b556fe033f26e20caae76a917bd8294ccea9f7d5ff1abc8e96cef5e80abd374` |
| `contracts/mocks/MockERC20.sol` | `contracts/mocks/MockERC20.sol` | `efea86f5afa1378654508ca6fc4da2c6a8a054d1` | `0a8740a17930206f7459003e1fd9a4ade11e31fc71592063aa7029362fc671a7` |
| `test/EvmHashRail.t.sol` | `test/EvmHashRail.t.sol` | `33f7396524b4f787190f2176c18c9121a9e60b8d` | `ee7a52cd285f05140c0ac7ad185378552667f2c0717db5e24cdbcc0a6af18a29` |
| `foundry.toml` (MODIFIED by F6, see below) | `foundry.toml` | origin `8dedbc4aab0d608cfd79f69a9a9a91d3d2a302da`; now `5834eb07f9600b6d6982df72a900f6bd7eb009a0` | origin `cb358a2815a47a19a2fe7203e90c01beb351ab122b67f08122d5a3b57f93ce22`; now `dd0e2d2cffce1ef6e2f7fdfe809e7800eb47d69581c604fb66867123b62aa0a8` |
| `foundry.lock` | `foundry.lock` | `31b0fe2e253592e6f72dca5a7f07b070da9d02ce` | `6b182f57b5c5615131465941411dac80a778d554bd4a796bd28749b9b752d6f0` |

**`foundry.toml` is the one row that is no longer byte-identical to its source (F6, P9 review round 1, commit `f4f0232`; R2-DOC-PROV22).**
F6 added three settings under `[profile.default]`, `evm_version = "cancun"`, `bytecode_hash = "ipfs"` and `cbor_metadata = true`, so that
the built bytes no longer depend on a forge version's defaults (see "The toolchain, written down" under the runtime code hash). The
`origin` hashes in the row are the upstream file's at tclk#21 `d6477ac`. The `now` hashes are those of this repository's current file,
taken over the git blob (`git show HEAD:foundry.toml | sha256sum`; the id is `git rev-parse HEAD:foundry.toml`), never the working
copy: a checkout's autocrlf can rewrite a working copy, and this repository's `.gitattributes` keeps text LF in the blob. A reader who
hashes `foundry.toml` from a checkout and finds `dd0e2d2c...` instead of `cb358a28...` is looking at F6, not at a tampered file. The
other five rows are byte-identical to their source.

`foundry.lock` pins `lib/forge-std` to `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` (tag
`v1.16.2`); it is vendored here as a git submodule at that exact commit, not a blob copy.

**Status: unaudited, testnet-only.** These contracts have not been audited. Do not deploy them
against mainnet value. `EvmHashRail.sol` is used unmodified (deliverable 1); `EvmHashRailFee.sol`
below is derived from it (deliverable 3).

**License.** `vendor/tclk/LICENSE` is Apache-2.0 (© FLOP Labs contributors), and every vendored
file above keeps its own `SPDX-License-Identifier: Apache-2.0` header verbatim. This repository's
own root license is MIT (see `README.md`); the vendored/derived files under `contracts/` and
`test/` remain under their upstream Apache-2.0 license, not this repo's MIT license.

## tclk#125 — `evm-hash-rail.ts` viem binding (vendored with one import change)

Source: `flop-labs/tclk` PR #125 (open, approved, unmerged as of 2026-09-21), head commit
`3f544da9ba379e0a50b560d3cac4af23af6f6e66`.

| path (this repo) | source path (tclk#125) | git blob id (original) | sha256 (original blob bytes) | change |
|---|---|---|---|---|
| `src/vendor/evm-hash-rail.ts` | `src/evm-hash-rail.ts` | `5a8c24564d29d0a9b253be64f0d9c539fa98be61` | `65479fe0b488d269b6078db3921d8bea23b0843e1de348f8a882790cea97a677` | one line: `import type { LockTerms, SettlementRail } from "./rail.js";` → `import type { LockTerms, SettlementRail } from "@flop-labs/tclk";` |
| `tests/vendor-evm-hash-rail.test.ts` | `tests/evm-hash-rail.test.ts` | `f649dc1a8a2d9d2f4388a9b355fc4f994a4659cd` | `45e2d4095296d9ec5e2687d1beb948263eeb24850de989e09c3372bdada85f78` | import paths only: `../src/evm-hash-rail.js` → `../src/vendor/evm-hash-rail.js`; `LockTerms` now imported from `@flop-labs/tclk` instead of `../src/rail.js` |

No other lines were changed in either file.

## F2a — `contracts/EvmHashRailFee.sol` (derived, not vendored)

Derived from `contracts/EvmHashRail.sol` above (source blob
`e4c328b2abf44f8ab12d14d168af22ecfc820652` at tclk#21 `d6477ac`), with an immutable `feeBps` /
`feeRecipient` pair and a fee split on `claim` only. Differences from the source are listed in the
contract's own header comment. `refund` and `lock` are identical to upstream. Not vendored from
anywhere upstream — this file and `test/EvmHashRailFee.t.sol` are new, written for this repo.

## First-party EVM-leg files (P22-P24-EVM-SPEC.md) — unaudited, testnet-only

Not vendored — original to this repo, written for the local/keyless EVM leg
(`handoff/P22-P24-EVM-SPEC.md`). Listed here per that spec's own instruction, not because
anything below reuses outside code: **unaudited, testnet-only**, same as the vendored contracts
above — none of it has been reviewed for a real deployment, and no deployment this repo drives
today carries mainnet value (D-09/D-10: a mainnet chain-id deny list, no private key anywhere).

- `src/rails/rpc-capture.ts` — byte-exact JSON-RPC capture (§2.1).
- `src/rails/evm-htlc.ts` — the desk-facing `evm-htlc` adapter over the vendored binding, chain
  pin (allow list: anvil-local 31337, base-sepolia 84532), write evidence (§2.2).
- `src/rails/evm-evidence.ts` — the pure, fail-closed finalized-view evidence decoder shared by
  the live rail and the offline replay (§2.2 point 3, §4).
- `src/rails/account-line.ts` — the D-08 account-line grammar and `resolveAccounts` (§3).
- `src/client/venue.ts` — the `Venue`/`MemoryVenue` abstraction the client flows post through
  (§6).
- `src/client/seller.ts`, `src/client/buyer.ts` — the Seller/Buyer step functions (§6).
- `src/client/bundle.ts` — the watch-root-shaped evidence bundle writer `examples/audit-export.
  mjs` replays unmodified (§6).

`fixtures/evm-anvil-2026-09-28/{settled,refunded,refunded-b,squat}/` are also first-party: real
capture bytes from a real, local, ephemeral `anvil` node this repo itself starts and stops
(`tests-anvil/client-flows.anvil.test.ts`) — not from any external service, and containing no
private key material (nothing in this build holds one to begin with).

## First-party Bitcoin-leg files (P4-BTC-SPEC.md) — unaudited, testnet-only

Not vendored — original to this repo, written for the local/keyless Bitcoin leg
(`handoff/P4-BTC-SPEC.md`). Listed here per that spec's own instruction, not because anything
below reuses outside code, except where noted: **unaudited, testnet-only**, same as the EVM leg's
own files above — none of it has been reviewed for a real deployment, and no deployment this repo
drives today carries mainnet value (the allow list refuses `main`/`test`/`testnet4` by name, and
no private key, WIF, xprv, seed or mnemonic for any Bitcoin key exists anywhere in this build).

- `src/rails/btc-script.ts` — the pure P2WSH HTLC witnessScript/address builder and claim/refund
  PSBT builders (§3), reproducing Bitcoin Core 31.1's own compiled form of
  `andor(pk(payee),sha256(H),and_v(v:pk(payer),after(T)))` byte for byte (verified against a live
  regtest node, `handoff/research/btc-regtest-probe-2026-09-28.md`).
- `src/rails/btc-htlc.ts` — the desk-facing `btc-htlc` adapter: chain pin (allow list: `regtest`,
  an unverified `signet`), keyless writes via a bitcoind wallet's own `walletprocesspsbt` (§4).
- `src/rails/btc-evidence.ts` — the pure, fail-closed finalized-view evidence decoder shared by
  the live rail and the offline replay, the Bitcoin twin of `src/rails/evm-evidence.ts` (§5).
- `src/rails/account-line.ts`'s pubkey-line addition (`formatPubkeyLine`/`parsePubkeyLine`/
  `resolvePubkeys`) — the D-08 pubkey-line grammar a `btc-htlc` leg needs because its script
  commits to both parties' public keys, not an address (§6).
- `src/client/btc-rail.ts` — the `btc-htlc` implementation of `src/client/counter-rail.ts`'s
  `CounterAssetRail` interface, the rail-agnostic wiring `src/client/seller.ts`/`buyer.ts` drive
  (§7a).
- `src/client/policy.ts`'s `BTC_LOCAL_POLICY` — the Bitcoin-local deadline policy (§7).
- `src/client/bundle.ts`'s Bitcoin-leg addition (`BtcBundleCapture`) — writes a `btc-htlc` leg's
  own `raw/btc/`, `rails.json` entry and `finalizedRef` into the same watch-root-shaped bundle the
  EVM leg's own writer produces (§7).
- `src/replay.ts`'s/`src/watcher.ts`'s/`examples/audit-export.mjs`'s `btc-htlc` branches — added
  exactly the way the `evm-htlc` branch already existed, dispatching on the tclk contract
  machine's own accepted lock rail/ref (§7).

`fixtures/btc-regtest-2026-09-28/{settled,refunded,refunded-b,squat}/` are also first-party: real
capture bytes from a real, local, ephemeral `bitcoind -regtest` node this repo itself starts and
stops (`tests-regtest/client-flows.regtest.test.ts`) — not from any external service, and
containing no private key material (nothing in this build holds one to begin with; every key
these captures ever name is a public pubkey/fingerprint/path, and the node's own RPC cookie is
never captured, logged, or written into any file this repo commits).

## First-party NEAR-leg files (P5-NEAR-SPEC.md) — unaudited, testnet-only

Not vendored — original to this repo, written for the local/keyless NEAR leg
(`handoff/P5-NEAR-SPEC.md`, `handoff/P5-NEAR-DECISIONS-2026-09-29.md` D-N1..D-N12). Listed here
per that spec's own instruction, not because anything below reuses outside code, except where
noted: **unaudited, testnet-only**, same as the EVM and Bitcoin legs' own files above — none of
it has been reviewed for a real deployment, and no deployment this repo drives today carries
mainnet value (the allow list refuses every chain id but `near-sandbox-flop`/`testnet` by name,
`mainnet` is refused explicitly, and no private key, seed, mnemonic or ed25519 secret key for any
NEAR account exists anywhere in this build — D-N2, `tests-near/helpers/sandbox.ts`'s own header
comment).

- `contracts-near/htlc/src/lib.rs` — the hashed-timelock NEAR contract (§3): `ft_on_transfer`
  locks a NEP-141 transfer behind a sha256 hash lock, `claim`/`refund` pay out with an explicit
  gas-reserving callback. See `contracts-near/README.md` for the full guarantees list and the
  NB1 fix pass (F1-F8) that hardened it.
- `contracts-near/mock-ft/src/lib.rs` — a test-only NEP-141 + NEP-145 token standing in for
  Circle's NEAR USDC (6 decimals, symbol `USDC`, owner-minted), exactly like `MockERC20` on the
  EVM leg.
- `contracts-near/build.sh`/`contracts-near/smoke-test.sh` — the WSL build/keyless-smoke-test
  scripts (§0/§2).
- `src/rails/near-borsh.ts` — the first-party borsh transaction writer (D-N1: no new npm
  dependency): `TransactionV0`, its five actions, `SignedTransaction`, pinned against a known
  near-api-js test vector.
- `src/rails/near-rpc.ts` — the thin fetch JSON-RPC client (`status`, `block`, `call_function`,
  `send_tx`, `EXPERIMENTAL_tx_status`, `viewAccessKey`) through `CapturingRpc`, including
  `NearUnknownTransactionError`'s own recognition of near-sandbox's real tx-status timeout shape
  (confirmed live against the sandbox, NB-int). H11: nonce and expiry errors are read from the node's
  real shape (`error.data.TxExecutionError.InvalidTxError`), pinned by two reply bodies captured from
  a sandbox run (`tests/near-rpc.test.ts`) and re-forced live (`tests-near/near-rpc-errors.near.test.ts`).
  H10/H13: `txStatus` takes object params with `wait_until` (default `FINAL`) and returns the
  transaction body; `withReadTimeout` bounds reads (not `send_tx`/`txStatus`).
- `src/rails/near-ref.ts` — the shared NEAR ref helper: `0x<hash lock hex>:<payer account id>`
  (squatting fix, replacing D-N4's "ref = hash lock"), one parser/formatter every caller uses.
- `src/rails/near-htlc.ts` — the desk-facing `near-htlc` adapter: chain pin (allow list
  `near-sandbox-flop`/`testnet`), keyless writes via an in-memory `NearSigner` (§1/§4), the
  sign-and-record-then-broadcast split (D-N4; the lock is the only two-step write, `claim` and
  `refund` are single calls), `FT_TRANSFER_CALL_GAS`/`CLAIM_REFUND_GAS`
  corrected from their provisional 100/60 Tgas to 20/40 Tgas against real measured gas burn on
  the sandbox (D-N9, NB-int). H9: a lock is accepted only on the transaction's own used amount
  (`SuccessValue`, `"0"` = refused) plus a `Locked` lock with the exact terms; unsettled cases throw
  `NearLockUnknownError`. H10: `recoverByTxHash` decodes and matches the transaction to this rail's
  own write for the ref. H12: `claim` checks payee, token, amount and times before signing. H13:
  bounded reads, and the claim's deadline guard is the last read.
- `src/rails/near-evidence.ts` — the pure, fail-closed finalized-view evidence decoder shared by
  the live rail and the offline replay, the NEAR twin of `src/rails/evm-evidence.ts`/
  `src/rails/btc-evidence.ts` (D-N10). H8: it also binds `view_account` and `view_access_key_list` of
  the contract at the finalized block (reviewed code hash, zero access keys); the NEAR fixtures
  taken before H8 lack those reads and replay unverified until recaptured.
- `src/rails/near-signer-memory.ts` — `InMemoryNearSigner`, the ONLY concrete `NearSigner`
  implementation in this build (test/harness code only — §1/D-N2/D-10): the secret key is an ES
  `#secretKey` private field, and `toJSON`/`util.inspect` expose only the account id and public
  key (D1); `generate()` for a fresh in-memory keypair, `fromNearSecretKey()` for `tests-near/helpers/sandbox.ts`'s own one-time
  read of the sandbox's own `test.near` key.
- `src/client/near-rail.ts` — the `near-htlc` implementation of `src/client/counter-rail.ts`'s
  `CounterAssetRail` interface, the rail-agnostic wiring `src/client/seller.ts`/`buyer.ts` drive
  (§4/§7a); `resendRefundIfDropped` deliberately omitted (D-N6: NEAR has no mempool-drop concept
  for it to paper over), `checkPendingClaim` implemented (D-N6).
- `src/client/policy.ts`'s `NEAR_LOCAL_POLICY` — the NEAR-local deadline policy (D-N8): reuses
  EVM's own `minRevealWindowMs`/`finalityAMs` numbers verbatim rather than re-deriving them from
  NEAR's own (much faster) Doomslug finality — see that constant's own doc comment and
  `tests-near/client-flows.near.test.ts`'s header comment for the NB-int timing this stage
  measured but did not use to tighten it.
- `src/client/bundle.ts`'s NEAR-leg addition (`NearBundleCapture`) — writes a `near-htlc` leg's
  own `raw/near/`, `rails.json` entry and `finalizedRef` into the same watch-root-shaped bundle
  the EVM/Bitcoin legs' own writers produce (§4).
- `src/replay.ts`'s/`src/watcher.ts`'s/`bin/watch.mjs`'s/`examples/audit-export.mjs`'s
  `near-htlc` branches — added exactly the way the `evm-htlc`/`btc-htlc` branches already
  existed, dispatching on the tclk contract machine's own accepted lock rail/ref (§4).
- `tests-near/helpers/sandbox.ts` — the NB-int sandbox harness: spawns `near-sandbox` inside
  WSL (D-N2's argv-array `wsl.exe` invocation, never a `bash -lc` string carrying `$VAR`s),
  builds and deploys both contracts, creates the buyer/seller/token/contract accounts with fresh
  in-memory keys, and exposes `fastForward` (D-N7, confirmed empirically to advance the FINAL
  block's own timestamp).
- `tests-near/near-htlc.near.test.ts` — adapter integration against the real sandbox (nine
  scenarios: lock, claim, wrong-preimage refusal, refund timing, a malformed `ft_transfer_call`
  msg, an unregistered-payee claim forced past its own pre-check, lost-reply recovery, and the
  evidence reader end to end); this is also where D-N9's gas measurement was taken.
- `tests-near/client-flows.near.test.ts` — the Seller/Buyer client flows end to end against the
  same real sandbox (P5-NEAR-SPEC.md §5): the happy path to `settled`; both refund paths,
  `refunded` and `refunded-b`; a claim refused before a finalized on-chain lock exists and
  allowed once one does; the Buyer learning the secret from `get_lock` alone with no reveal frame
  posted; a claim to an unregistered payee refused before ever sending a transaction; and a
  lost-reply recovery by transaction hash (D-N4) exercised from inside a real client flow.
- `tests-near/probe/` — the NB0 wasm-compatibility probe (contract, script, findings) this leg's
  every later stage builds on.

`fixtures/near-sandbox-2026-09-29/{settled,refunded,refunded-b,squat}/` are also first-party: real
capture bytes from a real, local, ephemeral `near-sandbox` node this repo itself starts and stops
(`tests-near/client-flows.near.test.ts`) — not from any external service, and containing no
private key material (this build never holds a real NEAR secret key to begin with beyond the
one sandbox-generated `test.near` key, read once into memory and never serialized — D-N2; every
account and key these captures ever name past that point is this process's own freshly generated,
zero-value, in-memory keypair). `tests/near-sandbox-fixtures.test.ts`'s own extended key-material
scan (the Bitcoin fixture scan's patterns, the literal `"secret_key"` and `"private_key"` field
names, any base58 token decoding to 64 bytes whose first 32 bytes derive its last 32, and any
32-byte hex or base58 token whose derived public key is one of the fixture's own public keys —
each shape has a planted-leak test) additionally pins this for the committed fixture directories
on every `npm test` run. `refunded-b` contains no NEAR bytes at all (the Buyer never locked leg
A), so it carries no chain evidence of its own.

## First-party Solana-leg files (P6-SOL-SPEC.md) - unaudited, localnet-only

Not vendored: original to this repo, written for the local, keyless Solana leg (`handoff/P6-SOL-SPEC.md`,
`handoff/P7-ACCOUNT-PROOF-SPEC.md`). Listed per that spec's own instruction, not because anything below
reuses outside code. **Unaudited, localnet-only**: no deployment this repo drives carries mainnet value
(mainnet is refused by name and by genesis hash, the devnet pin is marked UNVERIFIED and has never met a real
devnet), and no private key, seed or keypair for any Solana account exists anywhere in this build: every key
is generated in process memory (`InMemorySolSigner`, an ES `#private` field) and never written, printed or
committed. No `@solana/*` npm dependency was added; the Rust crates the program and its tests use
(`solana-program`, `spl-token-interface`, `litesvm` and their siblings, pinned in `contracts-sol/Cargo.lock` and
`contracts-sol/htlc-tests/Cargo.lock`) are fetched by cargo under their own licences and are not copied into
this repository.

- `contracts-sol/htlc/` - the hashed-timelock escrow program (native Rust, no Anchor); `contracts-sol/htlc-tests/`
  its litesvm tests, run against the built `.so`; `contracts-sol/build.sh`, `smoke.sh`, `smoke_check.py` the WSL
  build and smoke scripts. See `contracts-sol/README.md` for the guarantees and the client duties.
- `scripts/cargo-target-dir.sh` - prints a per-worktree `CARGO_TARGET_DIR` (a hash of the worktree path) so two
  worktrees never overwrite each other's build; the NEAR and Solana build scripts and harnesses all call it.
- `src/rails/sol-tx.ts`, `sol-spl.ts`, `sol-rpc.ts` - the legacy-transaction codec, the SPL Token encoders and
  the JSON-RPC client; `sol-htlc.ts` - the adapter (chain pin, program pin, keyless writes, chain-confirmed
  writes with typed errors); `sol-evidence.ts` - the pure finalized-view evidence reader and the one live
  capture function; `sol-signer-memory.ts` - the only concrete signer.
- `src/rails/custom-rails.ts`, `custom-frames.ts` - the per-caller registry that admits the namespaced Solana
  rail id (`SOL_RAIL_ID`, spelled once) without editing `vendor/tclk`, and frame emission through it.
  `src/rails/account-line.ts` and `account-proof.ts` gained the Solana helpers and the registry-aware proof
  message (`ed25519`, P7).
- `src/client/sol-rail.ts` and `src/client/policy.ts`'s `SOL_LOCAL_POLICY` and `SOL_CHAIN_CLOCK_SKEW_MS` - the
  `CounterAssetRail` over the adapter, its deadline policy and the 60 s chain-clock bound (round 3, R3-7); the Solana branches of `seller.ts`, `buyer.ts`, `bundle.ts`, `replay.ts`,
  `watcher.ts`, `bin/watch.mjs` and `examples/audit-export.mjs` (`rails.sol`, `raw/sol/<hash lock>/<leg contract>/`).
- `tests-sol/helpers/validator.ts`, `run-validator.sh` - the live harness: spawns one throwaway
  `solana-test-validator` inside WSL with the reviewed `htlc.so` loaded at genesis, creates the mock USDC mint
  (public data only) and funds fresh in-memory keys through the validator faucet.
  `tests-sol/sol-htlc.sol.test.ts` - the adapter and evidence reader on the real validator.
  `tests-sol/client-flows.sol.test.ts` - the Seller/Buyer flows end to end on the real validator (settled,
  refunded, refunded-b, a claim refused before the lock is final, a secret learned with no reveal frame, a claim
  that lands and fails, a squat, lost replies, a mirror pair); the hermetic twins are
  `tests/client-flows-sol.test.ts` and `tests/audit-export-sol.test.ts` on a stateful fake node.

`fixtures/sol-localnet-2026-09-30/{settled,refunded,refunded-b}/` are first-party: real capture bytes from a
real, local, ephemeral `solana-test-validator` this repo itself starts and stops
(`tests-sol/client-flows.sol.test.ts`, regenerated only with `CAPTURE_SOL_FIXTURES=1`), not from any external
service. They hold public chain reads, signed transactions and account-line proofs (signatures), and no key
material: every account and key they name is a freshly generated, zero-value, in-memory keypair of that run.
`tests/sol-localnet-fixtures.test.ts` replays them hermetically through `examples/audit-export.mjs` and scans
every file under `fixtures/sol-localnet-2026-09-30/` for these shapes of key material on every `npm test` run (it
checks those shapes, not every possible hiding place): field names, PEM and mnemonic shapes, a base58, base64,
base64url or 128-hex token (hex with or without a `0x` prefix) that decodes to 64 bytes whose first 32 bytes derive
its last 32 (a Solana keypair), any JSON array of 64 numbers (the `solana-keygen` file format), and any bare 32-byte
base58, base64, base64url or hex token that derives a public key already present in the same fixture (as a base58
address or as 32 bytes inside a decoded base64 or base64url blob) (each shape has a planted-leak
test, and the real captured signatures, the
same length as a keypair, are shown not to be flagged). `refunded-b` holds no Solana escrow and no Solana write
(the Buyer never locked leg A): it carries one live read of the chain for the lock's ref that shows no escrow, and
`rails.json`.

## Settlement-view vocabulary — pinned to tclk PR #173

`none | unverified | unfunded | funded | claimed | refunded` (per-leg `SwapView.settlementView`,
`src/swap.ts`) is the settlement-view vocabulary proposed in `flop-labs/tclk` PR #173 at commit
`0f94269`. Cited here, not vendored: nothing from that PR's diff is copied into this repo, only
the naming convention is adopted, because this repo needs to say what it believes about money
independently of tclk's own choreography status (H3, tclk#180/#181). Vendored tclk (git submodule,
`vendor/tclk`) is pinned at `5cc4ab9` and does not contain PR #173 — it is unmerged upstream. If
`flop-labs/tclk#172` changes the vocabulary before PR #173 merges, this line — and the mapping in
`src/swap.ts`'s `RAIL_STATUS_TO_SETTLEMENT_VIEW` — moves with it.

## Evidence binding and pair keys — response to the tclk#194 review

`RailObservation` gained `rail`, `ref`, `contract` and `terms`, `src/swap.ts` gained
`bindObservation` and `pairKey`, and `BoardInput.evidence` is keyed by leg contract id instead of
`swapId`, after Viriat01's review of `flop-labs/tclk#194` (2026-09-28): a bare final `claimed`
observation folded a swap to `settled`, and two pairs with the same buyer and nonce shared one
evidence entry. Both are first-party changes; nothing is vendored or copied from that review beyond
the two reproductions, which are regression tests in `tests/binding.test.ts`. No capture or
evidence file format changed, so no fixture was recaptured. Round 2 of the review (V3-V8, P5-NEAR-FIXES-R2.md) removed the shared-swapId evidence blanking, kept only genuine accepts for candidates and evidence keys, paired leg B with leg A's accepter, made a refund frame insufficient for chain legs, and keyed the watcher, bundle and audit-export by pair; all first-party. Round 3 (R3-2, R3-3) made the board prefer the crossing pair and kept a stranger's copy of a swapId out of the bundle and `--expect`; the R3-1 limit it recorded (chain evidence does not bind a lock to a tclk contract, so a mirror pair could borrow it) is closed by the proof-of-control lines described below; no contract or lock format changed.

## Proof-of-control account lines (P7, handoff/P7-ACCOUNT-PROOF-SPEC.md)

`src/rails/account-proof.ts` (message, `proof` field grammar, verifier registry, `eip191` and
`ed25519`), `src/rails/btc-proof.ts` (`bip322`), `src/rails/near-proof.ts` (`nep413`) and the
`proof` field of `src/rails/account-line.ts` close R3-1 (the mirror-pair limit). All first-party
code written from public specifications, none copied: EIP-191 (personal_sign), BIP-322
(`bitcoin/bips` bip-0322.mediawiki; its published test vectors, the `L3VFeEuj...` key and the
messages "" and "Hello World", are pinned in `tests/btc-proof.test.ts`) and NEP-413
(`near/NEPs` nep-0413.md; the Borsh payload is cross-checked against an independent encoding in
`tests/near-proof.test.ts`). Verification uses `viem`, `@scure/btc-signer` and the `@noble/*`
packages already in the tree; no dependency was added. The message string
`FLOP::swap::account-proof::v1|<did>|<contract>|<rail>|<account>` is this desk's own. No contract,
lock format or vendored file changed, and no key material is committed: the fixtures carry proofs
(signatures and public keys) and on-chain reads only. Every chain fixture was recaptured once for
this change because the deal-room lines changed; the swap ids and statuses are unchanged
(`tests/evm-anvil-fixtures.test.ts`, `tests/btc-regtest-fixtures.test.ts`,
`tests/near-sandbox-fixtures.test.ts`; the NEAR squat fixture settles).

## Reveal latches and signer error text (P5-NEAR-FIXES-R2.md G6, D4)

`src/client/seller.ts` gained `RevealNotPostedError` and the `revealPosted`/`receiptPosted` latches
(the reveal is retried up to three times and a failure is a distinct error rather than a silent
skip, and a retry of `claimLegA` posts only the frame still missing); `fromNearSecretKey` in
`src/rails/near-signer-memory.ts` no longer puts any character of its input in an error; the
comments at the two `refundedFold` call sites in `src/swap.ts` now describe the V4 rule. All
first-party, covered by `tests/client-flows-near-rpc.test.ts` and `tests/near-signer-memory.test.ts`.

## First-party crash-resume files (P8-RESUME-SPEC.md, P8-FIXES-R1.md, P8-FIXES-R2.md, P8-FIXES-R3.md) - unaudited, testnet-only

Not vendored: original to this repo, written for the crash-resume stage (`handoff/P8-RESUME-SPEC.md`, amended by the
review round 1, round 2 and round 3 fix lists `handoff/P8-FIXES-R1.md`, `handoff/P8-FIXES-R2.md` and
`handoff/P8-FIXES-R3.md`). Listed per that spec's own
instruction, not because anything below reuses outside code. **First-party, unaudited, testnet-only**: none of it has
been reviewed for a real deployment, no deployment this repo drives carries mainnet value, and the store directory a
real run writes holds the Seller's swap secret (the README's "Resume" section says how to treat it). No dependency was
added, and `vendor/tclk`, `src/vendor/evm-hash-rail.ts`, `contracts/`, `contracts-near/`, `contracts-sol/`, `docs/`,
`fixtures/`, `package.json` and `package-lock.json` are byte-identical to `main` at `766a40a`. Nothing on the wire
changed, so `docs/PROFILE.md` is unchanged, and no fixture was added or recaptured.

- `src/client/flow-store.ts` - the `FlowStore` interface (a compare-and-swap `save`, plus the optional `scopeId` and
  `exclusive` section the Seller's begin uses and `locationOf`, which names a key's file in an error message),
  `MemoryFlowStore` (with fault injection for tests) and `FileFlowStore` (one checksummed file per swap, a per-key
  exclusive lock file and a store-wide `seller-begin.lock`, temp file, fsync and rename), and the typed lock refusal
  `FlowStoreLockedError` with its `reason`.
- `src/client/flow-record.ts` - the versioned, strictly validated, checksummed swap record (`v: 1`) for both roles, the
  frame ledger, the record key (`buyer:<swapId>`, `seller:<contractA>`) and the identity pins (DID, rail, chain,
  deployment, contracts).
- `src/client/flow-resume.ts` - `FlowJournal` (the single-writer, durable-before-adopted handle on one record), the
  typed errors (`SwapExpiredError` among them) and the `next`-step names (`abandoned` among them).
- Extended first-party files: `src/client/buyer.ts` and `seller.ts` (the `store` option, `resume`, the recover paths);
  `src/client/counter-rail.ts` and the four adapters `evm-rail.ts`, `btc-rail.ts`, `near-rail.ts` and `sol-rail.ts`
  (recovery handles, the read-only `recoverLock` and `recoverRefund`, `resendLock` and `resendRefund`, `deploymentId`, and
  the optional `settleDelay` that `near-rail.ts` and `sol-rail.ts` implement);
  `src/rails/btc-htlc.ts`, `near-htlc.ts`, `near-borsh.ts`, `sol-htlc.ts` and `evm-htlc.ts` (the reads and the re-send
  of identical bytes those use).
- Hermetic tests: `tests/flow-store.test.ts`, `flow-record.test.ts`, `flow-journal.test.ts`, `flow-resume-*.test.ts`,
  `resume-rules.test.ts`, `resume-secrets.test.ts` (the preimage and key-material scan of every save),
  `resume-matrix-{evm,btc,near,nearfake,sol}.test.ts` (the crash matrix), `rail-recovery-{evm,btc,near,near-sim,sol}.test.ts`,
  `deployment-id.test.ts`, `bundle-leak.test.ts`, and their helpers `tests/helpers/{crash-matrix,evm-mock-node,
  flow-record-samples,ledger-rail,live-resume,matrix-suite,matrix-worlds,near-stateful-rpc,near-swap-rig,resume-flows,
  resume-sol-rig,resume-world,secret-scan,seller-key}.ts`. Review round 3 added three more test files, all covered by
  the `flow-resume-*.test.ts` pattern above and named here so that none is missing from this list:
  `tests/flow-resume-detour.test.ts` (the Buyer's `next` after a saved refund attempt and a by-hand claim of leg B),
  `tests/flow-resume-late.test.ts` (an accept B that the venue stamped at or after offer B's expiry, both roles) and
  `tests/flow-resume-sol-lag.test.ts` (a lagging first status read of a Solana lock, the real rail over the stateful
  node). It also extended `tests/flow-store.test.ts`, `flow-resume-begin.test.ts`, `flow-resume-reorg.test.ts`,
  `flow-resume-sell.test.ts` and `flow-journal.test.ts`; `tests/helpers/ledger-rail.ts` and
  `tests/helpers/sol-stateful-chain.ts` were retyped (types only) and `tests/helpers/sol-fake-chain.ts`, a helper that
  predates the resume work, gained an opt-in read lag that is inert unless a test sets it. No helper file and no
  fixture was added. The follow-up pass after the Solana live suite added one more test file, named here so that this
  list stays complete: `tests/sol-compute-limits.test.ts` (R3-17: the Solana claim and refund compute-unit limits in
  `src/rails/sol-htlc.ts`, raised to 120,000 and 60,000, against the measured base plus thirty bump attempts; a rail
  test, not a resume test), and it added cases to `tests/flow-store.test.ts` (R3-18: an unreadable lock file at the
  acquire).
- Type checking: `npm run typecheck` runs `tsc -p tsconfig.json`, whose `include` is `src` alone, so `tests/` and
  `tests/helpers/` stay outside that gate (and outside `npm run build`); they run under vitest, which does not check
  types. In review round 3 the P8 test files and the helpers they use (`tests/flow-resume-*.test.ts`,
  `flow-store.test.ts`, `flow-record.test.ts`, `flow-journal.test.ts`, `helpers/ledger-rail.ts` and
  `helpers/near-swap-rig.ts`, with their imports) were type-checked with a scratch tsconfig that extends the repo's
  (`noEmit`, nothing committed): no diagnostics, exit 0. A scratch config over every file in `tests/` still reports 77
  diagnostics in 12 older test files and 2 helpers (`tests/helpers/scenario.ts` and `tests/helpers/fakeBoard.ts`)
  outside that set (`client-flows-near`, `client-flows-btc`, `evm-evidence` and others; most are fake counter-asset
  rails without the `deploymentId` that the resume work made required, the rest evidence fakes and strictness
  mismatches), which this pass did not touch. That separate hygiene pass is P9-7: `tests/` is inside the `typecheck` gate
  now (see the P9-7 section), and since P10 (B1) so are the four live folders (see the P10 section at the end of this file).
- Live tests (each spawns its own throwaway local node and never touches a public network):
  `tests-anvil/resume.anvil.test.ts`, `tests-regtest/resume.regtest.test.ts`, `tests-near/resume.near.test.ts` and
  `tests-sol/resume.sol.test.ts`.

## First-party EVM signer files (P9-1, handoff/P9-G1-READINESS-SPEC.md) - unaudited, testnet-only

Not vendored: original to this repo, written for the G1 readiness stage (a real key on a public testnet, the desk operator's own key
files). Unaudited and testnet-only like every file above. No key material is in the repository: the tests generate their
keys at test time, and the loader reads a key only from a file an operator names at run time.

- `src/client/evm-key-file.ts` - `loadEvmLocalAccount(path)`: reads one `0x`-prefixed 32-byte hex key, refuses everything
  else with the typed `EvmKeyFileError` (a message that names the path and the problem and never any content), warns on a
  group- or world-accessible file on POSIX (the check is skipped on win32), and returns a frozen viem `LocalAccount` that
  prints, serialises and inspects as its address and type only (`sealLocalAccount`, which since the P9 review round 1 fix pass
  takes any viem `LocalAccount`, so the guarded wrapper below is sealed the same way). `describeKeyFileProblem(problem)` (added
  in that pass, K1) is the loader's fixed problem sentence without the path, for a caller that must never print the path: the
  rehearsal runner prints `<field>: <that sentence>`.
- `src/rails/evm-signer.ts` - new in the fix pass (R1-FUND-02): `guardLocalAccount` wraps the sealed account so that its
  `signTransaction` refuses, with the typed `EvmSignerRefusedError` (no transaction field on it), a chain id other than the pin's,
  a gas limit missing or above `EVM_MAX_GAS_PER_WRITE` (500,000), or a fee cap missing or above `EvmRailConfig.maxFeePerGasWei`
  (default `EVM_DEFAULT_MAX_FEE_PER_GAS_WEI`, 1,000 gwei); `refuseFillTransaction` makes the local-signing transport answer
  `eth_fillTransaction` with method-not-found in-process, so the endpoint is never asked to fill (and never fills a chain id, gas
  or fee) a transaction this process signs. It originates no send and holds no key. Since P10 (B6) it also holds `verifySentTransactionHash`, a fourth defence: the
  hash of a raw send that the transport forwards is the keccak256 of the signed bytes, never the endpoint's answer (see the P10 section at the end of this file).
- Extended first-party files: `src/rails/evm-htlc.ts` (the `account` option is an `Address` or a `LocalAccount`; local
  accounts send `eth_sendRawTransaction` through the guarded account above; `EvmRailConfig.receiptTimeoutMs` and `maxFeePerGasWei`;
  the typed `EvmReceiptTimeoutError`; the public
  client's `waitForTransactionReceipt` is wrapped so the vendored rail's receipt waits are bounded too, while
  `src/vendor/evm-hash-rail.ts` stays byte-identical) and `src/client/evm-rail.ts` (the same option; the EIP-191 account
  proof is `account.signMessage` for a local account, verified as before).
- Hermetic tests: `tests/evm-key-file.test.ts` (every refusal, the warning on both platforms, every serialisation of the
  account scanned for the key), `tests/evm-local-signer.test.ts` (raw sends, nonces, the claim's preimage ordering, the
  proof, receipt timeouts, whole swaps with local accounts including a lost lock reply recovered through the P8 path, and a
  scan of every capture, venue line, store record and rendering for the key) and the helper `tests/helpers/evm-local.ts`
  (key generation into a temporary file loaded by the real loader, a key scanner that answers a boolean only, and a mock
  node that also answers nonce, gas, fee and raw-send reads). They were outside the `typecheck` gate when written and are
  inside it since P9-7 (see that section at the end of this file). Added in the fix pass: `tests/evm-signer.test.ts` (R1-FUND-02:
  each signing rule and the order they apply in, a refusal that carries no transaction field, the review's hostile
  `eth_fillTransaction` answer refused by the guard alone and never asked of the endpoint by the rail, a typed refusal out of
  `approve`, `lock` and `claim` with nothing sent, the configurable fee ceiling) and `tests/evm-lock-guard.test.ts` (R1-FUND-08:
  the lock's deadline guard runs again after the approve's receipt, at the rail seam and through the real `BuyerFlow`);
  `tests/helpers/evm-local.ts` gained an `answers` map (a test makes the endpoint answer one method its own way).
- Live test: `tests-anvil/local-signer.anvil.test.ts` (a Buyer and a Seller with local accounts, funded by anvil's account 0,
  settle and refund end to end, bundles scanned for the keys and replayed through `examples/audit-export.mjs`).

## `EvmHashRail.sol` runtime code hash (P9-2, handoff/P9-G1-READINESS-SPEC.md, rule 2)

A Base Sepolia config must carry `EvmRailConfig.contractCodeHash`, the keccak256 of the escrow's deployed RUNTIME code (the
bytes `eth_getCode` answers); `EvmHtlcRail.connect` and the evidence reader refuse a contract whose code hashes differently
(or is empty). This is the value the vendored `contracts/EvmHashRail.sol` builds to with the pinned toolchain:

| what | value |
|---|---|
| runtime code (`deployedBytecode.object`), 3416 bytes, keccak256 | `0x6ab36fa334036370445c22ca9f7999872ae56777d3c969438fb4b2414152da27` |
| creation code (`bytecode.object`), 3445 bytes, keccak256 (for reference; `forge create` sends this) | `0xb068f157be227cd9fef6611b4e9549aab69f8d8c334cc6375e40914edc754c7f` |

**The desk operator's deployed contract must report the runtime value through `bin/evm-code-hash.mjs`** (`node bin/evm-code-hash.mjs
<rpc-url> <address>` prints `keccak256 0x...` and `bytes 3416`); that is the string that goes into `contractCodeHash` in
`rails.json`. Another value means the code at that address is not this source built with this toolchain, and the desk will
refuse it. **A deploy built with another forge (or another solc, other settings, or a checkout without `lib/forge-std`) must
match the recorded hash before it is used**: compare `bin/evm-code-hash.mjs`'s `keccak256` line with the runtime value above, and if
it differs do not use the address and do not pin the new value until someone has found out why the bytes moved.

How the value was taken (2026-10-06, in the `flop-swap-desk-g1` worktree at branch `phase2-g1`, not from any earlier local
build): `forge clean`, then `forge build` (forge 1.8.3, commit `cae51ad458f6abb64852b7709eb784352429825d`, built
2026-09-15; solc `0.8.24+commit.e11b9ed9` from `foundry.toml`; optimizer on, 200 runs; EVM version `cancun`; metadata
`bytecodeHash` `ipfs`; sources `contracts/EvmHashRail.sol` and `contracts/IERC20.sol`; `lib/forge-std` at `v1.16.2`). Then the
hex string `deployedBytecode.object` of `out/EvmHashRail.sol/EvmHashRail.json` was hashed with keccak256 (viem's
`keccak256`, the hash `eth_getCode` bytes are checked with). The contract has no immutables and no library links
(`immutableReferences` absent, `linkReferences` empty), so the runtime code is the same bytes wherever it is deployed. The
anvil suite checks the same fact on a real node (`tests-anvil/code-pin.anvil.test.ts`: the code a deployment leaves on chain
hashes to the build's `deployedBytecode`).

The runtime code ends with solc's CBOR metadata, whose hash covers the source texts, their paths (`contracts/EvmHashRail.sol`,
`contracts/IERC20.sol`) and the compiler settings. So the value holds for this exact vendored source, built from this
repository's root with this `foundry.toml` (`forge create contracts/EvmHashRail.sol:EvmHashRail ...`); a different solc, other
settings, an edited file (a comment included) or another path gives another hash, and is refused until a person pins the new
value on purpose. The earlier local reference in the G1 research sheet (the same two numbers, 3416 bytes and `0x6ab36fa3...`)
was from an untracked build; this clean build reproduces it.

**The toolchain, written down (F6, P9 review round 1).** The recorded hashes hold for exactly this, all of it:

| setting | value |
|---|---|
| forge | 1.8.3, commit `cae51ad458f6abb64852b7709eb784352429825d` (built 2026-09-15) |
| solc | 0.8.24 (`solc_version` in `foundry.toml`; the build records `0.8.24+commit.e11b9ed9`) |
| optimizer | on, 200 runs (`optimizer`, `optimizer_runs`) |
| `evm_version` | `"cancun"` (`foundry.toml`) |
| `bytecode_hash` | `"ipfs"` (`foundry.toml`) |
| `cbor_metadata` | `true` (`foundry.toml`) |
| remapping | `:forge-std/=lib/forge-std/src/` (an empty context; forge detects it from `lib/forge-std`, `forge config` prints it as `forge-std/=lib/forge-std/src/`, and the build's metadata records it under `settings.remappings`) |
| sources | `contracts/EvmHashRail.sol`, `contracts/IERC20.sol`, with `lib/forge-std` at `v1.16.2` present |

When the value was first recorded `foundry.toml` named none of `evm_version`, `bytecode_hash` and `cbor_metadata`: forge 1.8.3 chose
`cancun` for solc 0.8.24 by itself, so another forge version could have chosen another one and built other bytes without anyone
changing a file. Since the fix pass `foundry.toml` states all three. They were checked not to move the hash: a `forge clean` and a
`forge build` in a clean scratch copy of the worktree gave runtime `0x6ab36fa334036370445c22ca9f7999872ae56777d3c969438fb4b2414152da27`
over 3,416 bytes and creation `0xb068f157be227cd9fef6611b4e9549aab69f8d8c334cc6375e40914edc754c7f` over 3,445 bytes, unchanged. The
control: the same copy with `evm_version = "shanghai"` gives a different runtime hash (`0xe82229b5...6df4`), so the setting is what
pins the bytes. No test pins this (a test cannot run another forge); the check is the clean build and the hash above, which the gate
repeats.

**How the hash is taken, and the gate's recipe (P2R2-PIN-02, P9 review round 2).** The runtime hash is the keccak256 of
`deployedBytecode.object` read as hex. That object is a string that ALREADY starts with `0x`, so it is hashed as it is: never
`"0x" + object` (viem's `keccak256` does not read `0x0x6080...` as hex and hashes the UTF-8 text instead, which gives
`0xf3b41084...3ad7fd`, and counting `object.length / 2` then counts the prefix as a byte: 3,417), and never `json.deployedBytecode`,
which is the wrapper object (the string is its `.object`). The byte count is `(length - 2) / 2`. The gate's earlier failed rebuild step
was exactly that bug in its own hashing script; the build it hashed was correct and gives the recorded value. **Compare the HASH, not
only the length:** a copy of the sources without `lib/forge-std` (no remapping: `remappings []` in the metadata) builds the same 3,416
bytes with another hash, `0x92eb8b1d...734b`, because the metadata hash covers the settings. The recipe, in Git Bash, from a fresh
scratch directory (never `/tmp`: Windows `node` reads `/tmp` as `C:/tmp`), writing nothing to the worktree:

```bash
export PATH=/c/Users/<user>/.foundry/bin:$PATH
W=<the worktree>; S=<a fresh scratch directory>/forge
rm -rf "$S" && mkdir -p "$S"
cp -r "$W/contracts" "$S/contracts"; cp "$W/foundry.toml" "$S/foundry.toml"
cp -r "$W/lib" "$S/lib"        # required: without lib/forge-std the remapping is [] and the hash changes at the same length
cd "$S" && forge --version && forge build --offline        # forge 1.8.3 (cae51ad), solc 0.8.24
NODE_PATH="$W/node_modules" node <scratch>/hash.cjs "$S/out/EvmHashRail.sol/EvmHashRail.json"
```

with `hash.cjs` a script FILE (not `node -e`: shell quoting mangles it):

```js
const fs = require('fs'); const { keccak256 } = require('viem');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const k of ['deployedBytecode', 'bytecode']) { const o = j[k].object; if (!/^0x[0-9a-fA-F]+$/.test(o)) throw new Error(k + ': object is not 0x-hex'); console.log(k, keccak256(o), (o.length - 2) / 2); }
```

It must print exactly `deployedBytecode 0x6ab36fa334036370445c22ca9f7999872ae56777d3c969438fb4b2414152da27 3416` and `bytecode
0xb068f157be227cd9fef6611b4e9549aab69f8d8c334cc6375e40914edc754c7f 3445`. (`cast keccak <the deployedBytecode.object string>` is
equivalent: `cast` reads a `0x`-prefixed argument as bytes.) The controls, all reproduced when this recipe was written: the same copy
without `lib/` gives `0x92eb8b1d...734b` over 3,416 bytes; hashing `"0x" + object` gives `0xf3b41084...3ad7fd` and a count of 3,417. The
`foundry.toml` of `56103b5` (before F6) builds the same bytes as the current one (rebuilt and hashed with this recipe).

## First-party code-pin and log-scan files (P9-2, P9-3) - unaudited, testnet-only

Not vendored: original to this repo. No key material in any of them.

- `src/rails/evm-code-pin.ts` - the one judgement of a contract's code against `contractCodeHash` (`judgeRuntimeCode`),
  shared by `EvmHtlcRail.connect` and the evidence reader so they cannot disagree. Since the fix pass (K2) its refusal text,
  `describeCodeProblem`, prints the observed hash in full and the pinned value only as its first 10 characters and `...`: a pinned
  value has a private key's shape, so one pasted there by mistake must not be printed back (the one change covers `connect()`, the
  pre-flight's `escrow code` row and the evidence reason that `audit-export` prints).
- Extended first-party files: `src/rails/evm-htlc.ts` (`EvmRailConfig.contractCodeHash` and `maxLogRange`, which must be at least
  `EVM_MIN_LOG_RANGE` (257); the typed `EvmContractCodeError` and `EvmLogScanBoundError`; `effectiveMaxLogRange`;
  `evmLogScanCoverage`, the blocks one scan reaches above its marker; the chunked write-evidence lookup, whose tip is floored at the
  write's own receipt block and re-planned up to `EVM_WRITE_LOOKUP_REPLANS` (3) times when it finds no log (F7); and
  `findClaimedPreimage`, which reads the OLDEST range first from the marker, so what a bound leaves unread is the newest part:
  F1 with R1-FUND-03), `src/rails/evm-evidence.ts` (the capture records `eth_getCode` for a pinned config and the decoder fails
  closed on it), `src/client/counter-rail.ts` (the optional `claimPaidOut(ref)` member and `RailCommitOptions`, whose
  `beforeFinalSend` is the lock's second deadline guard, R1-FUND-08), `src/client/evm-rail.ts` (`claimPaidOut` reads
  `locks(hashLock)`: Claimed with this account as payee; `commitLock` runs `beforeFinalSend` after the approve's receipt),
  `src/client/buyer.ts` (passes its own lock-time deadline guard, with the unchanged B3 error text, at both `commitLock` call sites)
  and `src/client/seller.ts` (`findPriorPreimage`: a resumed Seller asks `claimPaidOut` before it scans, so a scan that cannot
  finish never stalls a Seller that is already paid; an unpaid Seller is scanned and stalls on a failed scan exactly as before).
  `src/vendor/evm-hash-rail.ts`, `vendor/tclk` and `contracts/` are untouched.
- `bin/evm-code-hash.mjs` - prints the keccak256 and byte length of the code at an address; read-only, one JSON-RPC call,
  never prints the RPC URL.
- Hermetic tests: `tests/evm-code-pin.test.ts`, `tests/evm-code-hash-bin.test.ts` (against a throwaway local HTTP server),
  `tests/evm-log-scan.test.ts`, the P9-3 block of `tests/flow-resume-sell.test.ts`, and the helper `tests/helpers/scripted-rpc.ts`;
  the stateful mock node (`tests/helpers/evm-mock-node.ts`) answers `eth_getCode`, a chain id, and refuses an `eth_getLogs` range
  over its cap exactly as the public endpoint does. Changed in the fix pass: `tests/evm-code-pin.test.ts` (K2: the pinned value is
  never printed in full by `describeCodeProblem`, by `connect()` or by the evidence reason, with a key as the pin);
  `tests/evm-log-scan.test.ts` (the review's cases: marker 5, claim at block 18, tip 50,600 blocks above must return the preimage; the
  bound leaves the newest part unread; the 257 floor; F7's lagging tip and empty lookups) and `tests/flow-resume-sell.test.ts` (a
  resume 300, 600, 1,000 and 60,000 blocks late costs one `eth_getLogs` call; the old bound and anchor cases became unpaid variants
  with paid variants beside them: a paid Seller is not stalled by the bound); the mock node gained two knobs, `lagTipReads` (a tip
  read that lags the receipt) and `emptyLogQueries` (a lookup that finds nothing a number of times).
- Live tests: `tests-anvil/code-pin.anvil.test.ts` and `tests-anvil/log-scan.anvil.test.ts` (now with the smallest legal cap, 257,
  and a few hundred mined blocks).

## First-party Bitcoin signet pin, policy and fee files (P9-5, handoff/P9-G1-READINESS-SPEC.md) - unaudited, testnet-only

Not vendored: original to this repo. No key material in any of them (the Bitcoin leg holds none; each party's bitcoind wallet
signs). Nothing here has talked to a live signet node.

- Extended first-party files: `src/rails/btc-htlc.ts` (the corrected `BTC_SIGNET_PIN`, still named `btc-signet-UNVERIFIED`; the
  signet fee rule `BTC_SIGNET_FEE_RULE` with its target, floor and cap constants; `btcFeeRuleFor`, `feeRateFromEstimate`,
  `spendFeeSatsFor`; the estimate call and the per-spend fee memory in `BtcHtlcRail`), `src/rails/btc-script.ts`
  (`htlcSpendVsizeBound`, the size upper bound of a claim or refund), `src/client/policy.ts` (`BTC_SIGNET_POLICY`,
  `btcLocalPolicyFor`) and `src/client/btc-rail.ts` (the policy chosen by the pin's network name; one fee memory shared by every
  `connect()` of a rail). `BTC_LOCAL_POLICY` and every regtest request are unchanged. `vendor/tclk` and `src/vendor/` are untouched.
- The signet genesis hash is the double sha256 of signet's genesis header (version 1, merkle root
  `4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b`, time 1598918400, bits `0x1e0377ae`, nonce 52613770), derived
  offline in `tests/btc-htlc.test.ts` (the same procedure over mainnet's header reproduces mainnet's genesis hash). It equals
  the value G1-PREP section 4 read from a public block explorer. It has not been compared with a live node. Dropping `-UNVERIFIED`
  needs two things from a live node, not one: the genesis hash, AND `getblockchaininfo().signet_challenge` equal to the default
  signet's `512103ad5e...2ae` (shortened here; the full value is `BTC_SIGNET_PIN.signetChallenge`),
  because a node started with another challenge (`-signetchallenge=51`) reports the same genesis hash and the same chain name
  (checked on an offline Bitcoin Core 31.1 node in the P9 review round 1; at P9-5 the pin did not compare the challenge, F5, and P10 B3
  made it do so: see the P10 section at the end of this file). Likewise, at P9-5 a small signet leg's claim and refund fee was capped at the
  amount minus the dust limit, below the fee rule's estimate (a leg under about 8,000 satoshis at a high rate; R1-FUND-05); P10 B2 refuses
  such a leg instead (the P10 section again).
- Hermetic tests: `tests/btc-signet-fee.test.ts` (new: the size bound against the two real Core-signed spends in
  `fixtures/btc-regtest-2026-09-28/`, the rate and fee rules, the policy selection) and the P9-5 blocks of
  `tests/btc-htlc.test.ts` and `tests/btc-evidence.test.ts` (the pin, the adapter against a mocked bitcoind, the retry rule).
- Live test: `tests-regtest/btc-htlc.regtest.test.ts` gained assertions about the real Bitcoin Core 31.1 node (what
  `estimatesmartfee` answers with no data; that `walletcreatefundedpsbt` takes the rate as `fee_rate` in sat/vB); the regtest
  suite is still 29 tests and no regtest request changed.

## First-party rehearsal runner files (P9-6, handoff/P9-G1-READINESS-SPEC.md, rule 4) - unaudited, testnet-only

Not vendored: original to this repo. The runner is dry-run by default and the desk operator runs it; it posts to no HTTP venue and its only
network is `rails.evm.endpoint`. No key material in any of them: the two EVM keys are loaded by `loadEvmLocalAccount` from files
the operator names and are never printed, stored or inspected; the tests generate their keys at test time.

- `bin/swap-rehearsal-evm.mjs` - the command line (arguments, exit code); everything else is in `src/client/`.
- `src/client/rehearsal-config.ts` - the closed config file (`rails.evm` rebuilt from known fields only, no credentials in the
  endpoint, `clock: "chain"` for anvil only, the known-good deadline set); `src/client/rehearsal-preflight.ts` - the read-only
  pre-flight table (chain id, code pin, finalized lag, `pending`, state at the finalized hash, log cap, clock, balances, deadlines);
  `src/client/rehearsal-world.ts` - the in-memory venue and paper notes made durable (atomic file writes), the two parties'
  Ed25519 venue seeds, and the one-runner lock; `src/client/rehearsal-run.ts` - the modes (dry run, `--yes`, `--resume`,
  `--refund`), `run.json` and `outcome.json`, the bundle and the `audit-export` replay. Changed in the P9 review round 1 fix pass:
  the runner prints a key-file failure as `<field>: <problem>` and never the path (`loadRunnerAccount`, K1), the config refuses a
  key-file value with a run of 32 or more hex digits or a phrase of 11 or more words and a pin `name` or `caip2` that is not a
  short plain text (K1), the Buyer's ETH row is sized by what is left to send (`buyerLockOnRecord`, R1-FUND-01 with F2) and a
  refund no longer needs the Seller's key file, a lock with no block number is waited for (`waitLockFinal`, R1-FUND-07), failure
  texts are redacted before they are cut (K3), the pre-flight has a `log scan reach` row (F1), the `state at finalized` row says "not
  final yet" for an answer of `0x` (F9) and the `deadlines` row refuses a new swap on 84532 while the rail still runs the anvil
  policy (F3 with R1-FUND-06, interim until P9-4, which removed it: see "P9-4 part 2" below).
- Hermetic tests: `tests/rehearsal-config.test.ts`, `tests/rehearsal-world.test.ts`, `tests/rehearsal-preflight.test.ts`,
  `tests/rehearsal-run.test.ts` (the runner and its command line against a fake read-only chain served by a throwaway local HTTP
  server; since round 4 also `tests/rehearsal-claim-watch.test.ts`, the runner's claim watch against the mock node), and the helper `tests/helpers/fake-chain.ts`. Added in the fix pass, all four test files and the helper: K1 (four near-miss
  key forms, a key broken into runs the config cannot see, in the dry run, `--yes`, `--resume` and `--refund`, scanned with the key
  scanner); K2 (a key as `contractCodeHash`); K3 (a 220-character prefix and an endpoint crossing character 300); K4 (`.gitignore`
  names `*.key`); R1-FUND-01 (the Buyer's row in each mode, to the wei, the same case in resume mode, `buyerLockOnRecord`, a refund
  without the Seller's key file, a Seller key file that names another account); R1-FUND-07 (`waitLockFinal`); F1 (the `log scan reach`
  row at the boundary, at 12-second blocks, unmeasurable, silent on anvil; the 257 floor in the config check and in the row text); F3
  (the interim guard, and that it never blocks a refund or a resume); F9 (an answer of `0x` fails with the new wording, which kills
  mutant M26); R1-FUND-04 (the runner's header, usage and README no longer promise a resume sends nothing twice, and the closed-claim-window
  reaction names a possibly pending earlier claim). The fake chain gained two knobs: `stateAtFinalizedAnswer` (what the state read at the
  finalized hash answers) and `blockTimeSec`.
- Live test: `tests-anvil/rehearsal-runner.anvil.test.ts` (the runner as a child process against real anvil nodes: the dry run, a
  settle, a kill and a resume at two cuts, and the refund paths; every file it wrote and its output scanned for both keys and for
  the venue seeds) and the `blockTimeSeconds` option of `tests-anvil/helpers/anvil.ts`. Added in the fix pass: a refund without the
  Seller's key file, a resume whose Buyer record lost its lock's block number (R1-FUND-07), a scan of every output, state file and
  bundle for the key files' directory and names (K1), and a scan of the stop-after-lock, resume and refund runs for the Seller's
  secret, which may sit only in the Seller's own flow record before a reveal (K5).
- The gas ceilings of the pre-flight were measured on anvil with the mock token (approve 44,000, lock 214,000, claim 65,000 gas);
  a refund was not measured.

## Test type gate (P9-7, handoff/P9-G1-READINESS-SPEC.md, checkpoint decision 5) - tests and configuration only

Not vendored: original to this repo. No file under `src/`, `bin/`, `examples/`, `vendor/`, `contracts*` and no test body,
assertion or skip changed; `tsconfig.json` is unchanged, so `npm run build` and `dist/` are what they were (the same 156
files with the same hashes before and after, none of them from `tests/`).

- `tsconfig.tests.json` (new, repo root): extends `tsconfig.json` with `noEmit`, `rootDir: "."` and `include: ["src", "tests"]`.
  `npm run typecheck` is now `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.tests.json --noEmit` (the only change to
  `package.json`), so every file under `tests/` and `tests/helpers/` (142 files) is checked at the strictness `src` has
  (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). It replaces the earlier arrangement in which `tests/`
  ran under vitest alone, which does not check types; the P8 and P9-1 notes above point here. (Since P10 B1 the `include` also lists
  `tests-anvil/**/*.ts`, `tests-regtest/**/*.ts`, `tests-near/**/*.ts` and `tests-sol/**/*.ts`: see the P10 section at the end of this file.)
- The count fixed: a scratch config over `src` plus `tests/` reported 79 diagnostics in 13 test files and 2 helpers at the
  start of P9-7 (the 77 in 12 files and 2 helpers recorded after P8, plus 2 in `tests/evm-log-scan.test.ts` from P9-3); it
  reports 0 now. Of the 79: 36 fake counter-asset rails without the required `deploymentId` (2 classes, 34 call sites), 17
  scripted `verifyLockFinal` replies without the observation's binding fields, 1 fake `claim` taking an optional ref, 1 fake
  board view without `pairKey`, and 24 strictness mismatches (optional values passed as `undefined`, indexed reads, a missing
  type import, `unknown` from an untyped `.mjs`). Fixing the first group exposed 34 further `exactOptionalPropertyTypes`
  diagnostics at the fakes' call sites (two optional fields declared as `string | undefined`), fixed at the declaration.
- What changed, by kind: `FakeCounterAssetRail` in `tests/client-flows-btc.test.ts` and `tests/client-flows-near.test.ts`
  gains `deploymentId = "rail:<railId>"` (the value `railDeploymentId` derives for a rail that has none, as the P8 ledger
  fake does), optional `minLockableAmount` and `assetId`, and its `verifyLockFinal` completes a scripted observation with
  `railBinding(lock)` (the flows read only `status`, `final` and `finalizedRef`); the other fixes are conditional spreads
  for optional values, `| undefined` on the tests' own recorded-call types, non-null assertions where a test already relies
  on the entry, and narrower or wider local types (`buildCapture`'s bytes map, `rawLog`'s topics, the mock RPC's handler).
- One fix is not a pure type change, stated here so it is not a surprise: `tests/helpers/fakeBoard.ts` now gives each
  swap view `pairKey: null` (the field was absent, which the watcher read as the state key `pair:undefined`). No test on that
  fake asserts a state key or a `pairKey`; its one multi-swap case asserts only which deal rooms are fetched.
- The hermetic count is the one before the package: 114 files, 3517 passed, 7 skipped.
- Not in the gate at P9-7: `tests-anvil/`, `tests-regtest/`, `tests-near/` and `tests-sol/`. Under a scratch config the first had 2
  diagnostics (`tests-anvil/client-flows.anvil.test.ts`, a `string` where a hex type is wanted), the third 3
  (`tests-near/client-flows.near.test.ts`, `txHash` possibly undefined); `tests-regtest/` and `tests-sol/` reported none. All four
  joined the gate in P10 (B1), with zero diagnostics: see the P10 section at the end of this file.

## P9 review round 1 fix pass (handoff/P9-FIXES-R1.md) - the item list

Not vendored: original to this repo. The first review round of P9 (head `56103b5`; three lenses and a synthesis) found no route by
which an honest party loses value in this build and no leak of a key that the code loads from its file; it found two routes by
which a key an operator had put in the wrong config field was printed back (K1, K2), a local signer that signed whatever chain id,
gas and fees the endpoint filled in (R1-FUND-02) and a log scan whose bound left the oldest blocks unread (F1 with R1-FUND-03). The
fix pass changed the files named in the sections above; this table names each item once, with its test, so that none is missing.
Every code fix has a test that was watched to fail with the fix disabled.

| item | fix | pinned by |
|---|---|---|
| K1 | the runner prints `<field>: <problem>`, never a key-file path; the config refuses a run of 32 or more hex digits and a phrase of 11 or more words in a key-file field; `rails.evm.pin.name` and `caip2` must be short plain texts | `tests/rehearsal-run.test.ts`, `tests/rehearsal-config.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` |
| K2 | `describeCodeProblem` prints the pinned value as 10 characters and `...` | `tests/evm-code-pin.test.ts`, `tests/rehearsal-run.test.ts` |
| K3 | `describeFailure` redacts, then cuts; the runner's claim, re-read and lock read-back texts use the endpoint redactor | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` |
| K4 | `.gitignore` names `*.key` | `tests/rehearsal-config.test.ts` |
| K5 | test only: the stop-after-lock, resume and refund runs are scanned for the Seller's secret | `tests-anvil/rehearsal-runner.anvil.test.ts` |
| R1-FUND-01 with F2 | the Buyer's ETH row is sized by what is left to send; `--refund` needs no Seller key file | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` |
| R1-FUND-02 | the guarded local account and the in-process answer to `eth_fillTransaction` (`src/rails/evm-signer.ts`) | `tests/evm-signer.test.ts`, `tests/evm-local-signer.test.ts`, `tests-anvil/local-signer.anvil.test.ts` |
| F1 with R1-FUND-03 | oldest range first from the marker; `maxLogRange` of at least 257; `claimPaidOut`; `evmLogScanCoverage` and the `log scan reach` row | `tests/evm-log-scan.test.ts`, `tests/flow-resume-sell.test.ts`, `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts`, `tests-anvil/log-scan.anvil.test.ts` |
| F7 | the write-evidence lookup floors its tip at the receipt's block and re-plans up to 3 times | `tests/evm-log-scan.test.ts` |
| R1-FUND-07 | a lock with no block number on record is waited for until the finalized block passes the head (`waitLockFinal`); amended by R2-FUND-03 (read before waited for, the target kept across resumes: see the round-2 table) | `tests/rehearsal-run.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` |
| R1-FUND-08 | the lock's deadline guard runs again after the approve's receipt | `tests/evm-lock-guard.test.ts` |
| F3 with R1-FUND-06 | interim: a new swap on 84532 under the anvil policy fails the `deadlines` row (P9-4 replaces it) | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` |
| F9 | an answer of `0x` to the state read at the finalized hash says "not final yet" | `tests/rehearsal-preflight.test.ts` |
| F6 | `foundry.toml` pins `evm_version`, `bytecode_hash` and `cbor_metadata` | none (a clean build and the recorded hash; see the toolchain table above) |
| R1-FUND-04 | wording only: a repeated lock or claim is refused by the contract and costs only gas; the closed-claim-window reaction names a possibly pending earlier claim | `tests/rehearsal-run.test.ts` (the texts of the runner header, the usage, the README and the reaction) |
| K4 (docs), F5, R1-FUND-05 | README only: the key-file hygiene text, the signet `-UNVERIFIED` criterion (genesis hash and the default signet challenge) and the small-leg fee note | none |

Routed on, not done here: F4, F8, the code option of R1-FUND-04 and the other P9-4 questions (the Base Sepolia policy, the fee
ceiling value and the runner config field for it, the known-good deadline set, the claim margin, the L1 data-fee allowance, the
stuck-claim question, nonce handling); R1-FUND-05 and F5 (the code) for the first Bitcoin stage (built in P10, items B2 and B3: see the P10 section at the end of this file).

What did not change: no wire or protocol change; `vendor/tclk`, `src/vendor/evm-hash-rail.ts`, `contracts/` and `package.json` are
byte-identical to `56103b5`; no new dependency; no environment variable is read by `src/`, `bin/` or `examples/`; no new fixture; the
runtime code hash is the one in the table above. The hermetic count after the pass: 116 files, 3629 passed, 7 skipped (before it, at
the end of P9-7: 114 files, 3517 passed, 7 skipped).

## P9 review round 2 fix pass (handoff/P9-FIXES-R2.md) - the item list

Not vendored: original to this repo. The second review round of P9 (head `9dcac37`; three lenses and a synthesis) closed all fourteen
round-1 items, found no leak of a key that the code loads from its file, and found no route by which an honest party loses value in
G1 (leg B is paper, both keys are the desk operator's). It found the operator-mistake key-echo class of K1 and K2 still open for five more places
a key can be pasted into (KR2-1), three medium items that become value routes once leg B carries value (R2-FUND-01, R2-FUND-02,
R2-FUND-03), one more in the pre-flight sizing (R2-FUND-04) and lows. The pass changed the files named below; this table names each
item once, with its test, so that none is missing. Every code fix has a test that was watched to fail with the fix disabled.

| item | fix | pinned by |
|---|---|---|
| KR2-1 | one helper, `looksLikeKeyMaterial` in `src/client/rehearsal-config.ts` (32 or more hex digits in a run, or 11 or more words of letters; widened by KR3-1 to KR3-3, see the round-3 table), judges `out`, every `rails.evm.assets` name and the `asset` field (also held to `ASSET_NAME_SHAPE`, exported from `src/rails/evm-htlc.ts`, whose own refusals now quote an asset name only when it is a short plain name), the endpoint's host, and, at the top of `runRehearsal` before anything is read, written or printed, the config path and `--state-dir` (the command line passes `--state-dir` as typed; the usage text names the guarded values); each refusal names the field or the argument and never the value | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts`, `tests/evm-htlc.test.ts` |
| R2-FUND-01 | (amended by R3-FUND-01 to R3-FUND-03, see the round-3 table) Buyer: `refundLegA`, for a lock attempt with no evidence, reads the chain before it sends anything (`ConnectedCounterAssetRail.lockAbsence`, implemented by evm-htlc only; `EvmHtlcRail.finalizedBlock` and `readLockAbsence`): a row is recorded as landed and refunded as before, no row and a finalized block at or past leg A's `refundAfterMs` is the verdict "never locked" (recorded as the optional, strictly decoded record field `lock.neverLanded`; `next` says `done` and `lockLegA` refuses), no row and no such block yet is the typed `RefundNotFinalYetError` (nothing sent or recorded). Runner: `refundLegAWaiting` waits for the finalized block, `buyerLockNeverLanded`, and a `--resume` of a run holding the verdict continues as `--refund` | `tests/refund-never-landed.test.ts` (new), `tests/evm-lock-absence.test.ts` (new), `tests/flow-record.test.ts`, `tests/rehearsal-run.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` |
| R2-FUND-02 | the fee ceiling is judged before `eth_estimateGas`: a `fees.estimateFeesPerGas` hook on the local wallet client's chain (`guardEstimateFeesPerGas` in `src/rails/evm-signer.ts`, wired in `EvmHtlcRail.connect`) computes viem's own caps and throws the typed `fee` refusal above the ceiling, so a claim refused for its fee sends nothing that carries the preimage; the sign-time guard stays as the second line; the gas ceiling still follows the estimate (README says so); the call list after the last deadline guard is unchanged | `tests/evm-signer.test.ts`, `tests/evm-local-signer.test.ts` (a comment only; the order it pins is unchanged) |
| R2-FUND-03 | `waitLockFinal(world, blockNumber, { hashLock, swapId, stateDir })`: a recovered lock (no block number on record) is read at the finalized block first and returns at once on any status but none; otherwise it waits for the head read at the first wait, kept in `<state dir>/lockfinal.json`, and reads the row at every poll | `tests/rehearsal-run.test.ts` |
| R2-FUND-04 | `PreflightInput.sellerSends` (`claim` or `nothing`; the runner reads it in `--resume` from the Seller's record, `sellerSendsOnRecord`, or from `locks(hashLock)` reading Claimed) and `buyerEthShort` (`fail` or `warn`; `--refund` passes `warn`) | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` |
| R2-FUND-05 | the `log scan reach` row measures leg A's window from the run's start (`input.nowMs`) to its refund time, not from the lock estimate ten minutes later | `tests/rehearsal-preflight.test.ts`, `tests/evm-log-scan.test.ts` |
| R2-NOTE-a | `EvmContractCodeError.expected` holds the 10-character short form (`shortPinnedHash`, now exported from `src/rails/evm-code-pin.ts`), so `util.inspect` and `JSON.stringify` of the error carry no pasted key | `tests/evm-code-pin.test.ts` |
| P2R2-PIN-06 | `run.json` gained the optional `maxLogRange` (the effective cap at the fresh start, strictly parsed); `--resume` refuses a smaller effective cap by field name | `tests/rehearsal-run.test.ts` |
| R2-FUND-06, P2R2-PIN-04, P2R2-PIN-05 | README only: the known limit for a refund the signer refuses, the resumed Seller's call count (a prompt claim lies in the first range at 500 and in the second at the 257 floor), and the leg-linking rule that the known-good deadline set breaks as soon as the finality budget exceeds 30 minutes | none |
| P2R2-PIN-02, R2-DOC-PROV22 | this file only: how the runtime hash is taken and the gate's recipe with its two controls (see "How the hash is taken, and the gate's recipe"), and the `foundry.toml` row of the vendor table marked modified by F6 | none (the recipe is the check; it was run when it was written) |

New files: `tests/refund-never-landed.test.ts` and `tests/evm-lock-absence.test.ts`. Helper: `tests/helpers/evm-mock-node.ts` gained two
default-off knobs, `finalizedLagMs` (the finalized block's timestamp lags the chain's time by that many milliseconds) and a `requests`
log (every method the node was asked, in order). Live test: `tests-anvil/rehearsal-runner.anvil.test.ts` gained two runner cases, a lock
attempt that never landed (the signer refuses the lock after the approve; `--refund` waits for the finalized block, refunds leg B and
replays to `refunded-b`, and `--resume` continues the same way) and a `--refund` Buyer below the pre-flight's ceiling-sized reservation
(a warning, and the refund goes ahead). Extended first-party files: `src/client/buyer.ts` (`RefundNotFinalYetError`, the verdict),
`src/client/counter-rail.ts` (`LockAbsence`, the optional `lockAbsence`), `src/client/evm-rail.ts` (`lockAbsence`),
`src/client/flow-record.ts` (`lock.neverLanded`), `src/rails/evm-htlc.ts`, `src/rails/evm-signer.ts`, `src/rails/evm-code-pin.ts`,
`src/client/rehearsal-config.ts`, `src/client/rehearsal-preflight.ts`, `src/client/rehearsal-run.ts` and `bin/swap-rehearsal-evm.mjs`.
No key material in any of them: every key in the new tests is generated at test time and scanned for, never printed.

Routed on, not done here (P9-4): P2R2-PIN-07 (a pause of about one block time between the write lookup's re-plans), P2R2-PIN-08 (a
pre-flight row comparing viem's fee with the ceiling) and the runner field `maxFeePerGasWei` with a floor on 84532 (also R2-FUND-06's
code), the option of a `waitLimitMs` floor at the finality budget on 84532, and the Base Sepolia fee ceiling value, to be chosen with
R2-FUND-02's pre-estimate fee check in place.

What did not change: no wire or protocol change; `vendor/tclk`, `src/vendor/evm-hash-rail.ts`, `contracts/` and `package.json` are
byte-identical to `9dcac37`; no new dependency; no environment variable is read by `src/`, `bin/` or `examples/`; no new fixture; the
runtime code hash is the one in the table above. `tests-anvil/` stayed outside `npm run typecheck` with its two older diagnostics
(`tests-anvil/client-flows.anvil.test.ts`, unchanged by this pass; inside the gate since P10 B1). The hermetic count after the pass: 118 files, 3714 passed, 7
skipped (before it, at `9dcac37`: 116 files, 3629 passed, 7 skipped).

## P9 review round 3 fix pass (handoff/P9-FIXES-R3.md) - the item list

Not vendored: original to this repo. The third review round of P9 (head `87a3b96`; three lenses and a synthesis) closed every round-2 item,
found no route by which an honest party loses value in G1 (leg B is paper, both keys are the desk operator's) and no leak of a key that the code loads or
of the preimage. It found one medium item against P9-6's promise that `--resume` continues and `--refund` drives the refund path: a claim of
leg A that landed within one finality lag of leg A's refund time, with its outcome unsaved, stalled the documented refund-then-resume path
(R3-FUND-01). The rest are lows: two residuals of the never-locked verdict (R3-FUND-02, R3-FUND-03), three more shapes of the key-echo class
(KR3-1 to KR3-3), a resume cap check stricter than leg A's window (PIN3-01) and documentation (R3-FUND-04, which is PIN3-02, PIN3-03,
PIN3-04). The pass changed the files named below; this table names each item once, with its test, so that none is missing. Every code fix
has a test that was watched to fail with the fix disabled.

| item | fix | pinned by |
|---|---|---|
| R3-FUND-01 | `refundLegAWaiting(world, buyer, hashLock)` in `src/client/rehearsal-run.ts`: when the refund fails with anything but the never-locked, not-final, refund-unconfirmed or claimed-routing cases, it reads `locks(hashLock)` at the latest block and at the finalized block (two reads, nothing sent); a claim seen at the first and not at the second is waited for (the sentence "leg A's lock was claimed; waiting for the claim to be final, then --resume finishes the swap"; the finalized block must pass the head, bounded by `waitLimitMs`), and `refundLegA` is then asked again so that the FLOW routes on a final claim (`next` says `learnSecret`); the run ends with a refusal that names `--resume` (`FLOW_MESSAGE.legAClaimed` couples the runner to the flow's four routing refusals), and past the bound with "nothing was sent; run --refund again to keep waiting". A `--resume` at the refund doorway says to run `--refund`, which waits, then `--resume` (`refundDoorwayText`, `buyerHashLockOnRecord`); the closed-claim-window text and the README say to run `--resume` first. A late claim's `--resume` finishes the swap on the chain but its bundle replays to `revealed` (exit 6), not `settled`, because the Seller's reveal and receipt frames can only be posted after leg A's refund time (README, "Known limits of the runner") | `tests/refund-late-claim.test.ts` (new: case F-C on the real `BuyerFlow` over the stateful mock node), `tests/rehearsal-run.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` (a new case on a chain mined by hand) |
| R3-FUND-02 | `EvmHtlcRail.readLockAbsence` answers `landed` only from a row at the finalized block; a row present only at the latest block is `not-final` (the runner waits as for the typed error); once the finalized block is at or past `refundAfterMs` the row at that block alone decides, and a row visible only at latest there is an inconsistent read, also `not-final` | `tests/evm-lock-absence.test.ts`, `tests/refund-never-landed.test.ts` (case F-A, at flow level and through the runner's loop), `tests/client-flows.test.ts` (one mocked finalized block gained the timestamp every real block has) |
| R3-FUND-03 | (a) the private `EvmHtlcRail.finalizedBlockForVerdict`, used by `readLockAbsence` only: an error or a malformed answer to the finalized-tag read is `not-final`, and `fallbackConfirmations` applies only to a JSON-RPC -32601 or -32602 answer or a `null` result (`finalizedBlock()` and its other callers unchanged); (b) `BuyerFlow.refundLegA` with a recorded verdict reads `locks(hashLock)` at the latest block once and throws the new typed `LockExistsAfterVerdictError` for a lock of this payer (nothing sent; "refund it by hand", in the README), while another payer's row or no row keeps the verdict | `tests/evm-lock-absence.test.ts` (a, case F-B), `tests/refund-never-landed.test.ts` (b, case F-D, at flow level and through the runner's loop) |
| KR3-1 | `parseRehearsalConfig` refuses `amount` and `flopAmount` by field name when `looksLikeKeyMaterial` is true (at most 31 digits in the runner's config; the rail keeps uint256), before the shape test and without quoting the value | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts` |
| KR3-2 | `looksLikeKeyMaterial` also tests the hex rule on the value with every whitespace and format character (Unicode category Cf) removed (hyphens stay, so a UUID passes) and refuses 11 or more consecutive BIP-39 English words (the `english` export of `viem/accounts`, a dependency already) once the value is cut at every non-letter; every guard uses the one function. Test helpers `strippedKeyScanner`, `phraseScanner` and `decimalKeyScanner`; the K1, K2 and KR2-1 pasted-key scans now use the separator-stripping scanner | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts`, `tests/helpers/evm-local.ts` |
| KR3-3 | the two rail refusals that name `pin.name` and `pin.caip2` (`validateEvmRailConfig`, `evmRailConfigShapeReason`) quote the value only when it matches `PIN_TEXT_SHAPE` (`/^[A-Za-z0-9:_.-]{1,40}$/`, now exported from `src/rails/evm-htlc.ts`; the runner's own pin check uses the same constant), and otherwise say "a pin name (or caip2) that is not a short plain text" | `tests/rail-pin-text.test.ts` (new) |
| R3-FUND-04, PIN3-03, PIN3-04 | README only, and the comments in `src/client/rehearsal-preflight.ts` that carry the finality numbers: the finality sentences (the sample's largest finalized lag so far is 51.4 minutes, 3,086 s, after a stand-still of 30 minutes or more; the policy rule gives at least 80 minutes; a fresh deploy can take about 52 minutes to read final; P9-4 sets the number from the full 24-hour sample), the refusal of a directory named after a swap id or any 32 or more hex-digit hash and the asset-name rule (`USDC.e` is refused), the three wording fixes of the log-cap paragraph, the guarded list with `amount` and `flopAmount`, `out` named beside the config path and `--state-dir`, the forms still unseen, the late-claim `--refund` and `--resume` text and the verdict's by-hand line | none |

New files: `tests/refund-late-claim.test.ts`, `tests/rail-pin-text.test.ts` and the helper `tests/helpers/finality-world.ts` (a `FinalityWorld` over
one of the matrix worlds, so the runner's loops drive the real `BuyerFlow`). Helper: `tests/helpers/evm-local.ts` gained the three scanners named
above. Live test: `tests-anvil/rehearsal-runner.anvil.test.ts` gained one runner case, a late claim on a chain mined by hand (`--refund` waits and sends
nothing, the `waitLimitMs` refusal, the `--resume` doorway text, the refusal that names `--resume`, then `--resume` finishes the swap with one lock, one claim
and no refund). Extended first-party files: `src/client/buyer.ts` (`LockExistsAfterVerdictError`), `src/client/evm-rail.ts` (a comment),
`src/client/rehearsal-config.ts`, `src/client/rehearsal-run.ts`, `src/client/rehearsal-preflight.ts` (comments only) and `src/rails/evm-htlc.ts`. No key
material in any of them: every key and phrase in the new tests is generated at test time (`generatePrivateKey`, `generateMnemonic`) and scanned for, and the
assertions print booleans, never a key or a word of a phrase.

Routed on, not done here: PIN3-01 (the resume cap check compares caps, not leg A's window) and the other P9-4 items (the finality budget from the full
24-hour sample, the known-good deadline set re-derived against it, the `waitLimitMs` floor at the budget, finality pinned to the finalized tag with no
fallback on 84532, the coupling of the late-claim wait with the leg-linking budget, and everything carried from rounds 1 and 2). Not covered by this pass:
the Bitcoin, NEAR and Solana rails (`src/rails/btc-htlc.ts`, `near-htlc.ts`, `sol-htlc.ts`) still quote `pin.name` in refusals of the same kind as KR3-3; the
runner and G1 are EVM-only, but a hand-written rails file for `watch.mjs` or `audit-export` with a `btc`, `near` or `sol` block would still print a pin name pasted into the wrong field
(closed by P10 B4: see the P10 section at the end of this file).

What did not change: no wire or protocol change; `vendor/tclk`, `src/vendor/evm-hash-rail.ts`, `contracts/`, `fixtures/` and `package.json` are
byte-identical to `87a3b96`; no new dependency; no environment variable is read by `src/`, `bin/` or `examples/`; no new fixture; the
runtime code hash is the one in the table above. `tests-anvil/` stayed outside `npm run typecheck` with its two older diagnostics
(`tests-anvil/client-flows.anvil.test.ts`, unchanged by this pass; inside the gate since P10 B1). The hermetic count after the pass: 120 files, 3751 passed, 7 skipped (before it, at `87a3b96`:
118 files, 3714 passed, 7 skipped).

## P9-4 part 1: the Base Sepolia policy and the EVM rail (handoff/P9-4-DECISIONS-2026-10-07.md decisions 1 to 5, 7, 8 and 10) - the item list

Not vendored: original to this repo. The first build of P9-4 (base: the round-3 fixed head `270cf47`) sets the Base Sepolia policy from the
24-hour finality sample and changes the EVM rail and the two flows only where a decision says so. The runner (`src/client/rehearsal-*.ts`,
`bin/`), the README and the pre-flight rows are the second build's (decisions 5 runner part, 6, 9, 11 to 15). Every code change below has a
test that was watched to fail with the change disabled.

The sample, read by a short read-only script (`handoff/research/base-sepolia-finality-2026-10-06.jsonl`, 288 samples every 5 minutes from
2026-10-06T09:30:03Z to 2026-10-07T09:29:01Z, 23.98 hours, no sample with an error): finalized lag minimum 868 s, median 1,156 s, p90 1,348 s
(nearest rank), maximum 3,086 s (51.4 minutes, at 2026-10-07T02:02:31Z); the longest stand-still of the finalized block was 8 consecutive samples
on block 47783591 (first seen 2026-10-07T01:27:25Z, last 02:02:31Z, so 35.1 to 45.1 minutes); safe-head lag 6 to 98 blocks (median 51.5, p90 82);
block time 2.0 s in every sample; the `finalized` tag and the state read at the finalized block's hash answered in 288 of 288 samples.

| decision | change | pinned by |
|---|---|---|
| 1 | `BASE_SEPOLIA_POLICY` in `src/client/policy.ts` (finality budget 80 minutes = 3,086 s x 1.5 rounded up to 5 minutes, claim margin 10 minutes, reveal window 45 minutes, block time 2 s), `evmLocalPolicyFor(chainId)`, the typed `EvmPolicyUnavailableError`; the EVM rail selects the policy by the pin's chain id (31337 keeps `EVM_LOCAL_POLICY`) and refuses any other chain id at `connect()` before one request; never a constructor option | `tests/evm-policy.test.ts` (new) |
| 2 | `KNOWN_GOOD_DEADLINES_BY_CHAIN` and `knownGoodDeadlinesFor`: anvil +60/+90/+120/+180, Base Sepolia leg A claim by +115 and refund +135, leg B claim by +225 and refund +285 (a refund rehearsal ends at +285 minutes, 4 h 45 min); the slack of every rule and the claim-pipeline arithmetic (6 x 45 s calls + 45 s = 5.25 minutes against the 10-minute margin) | `tests/deadlines-policy.test.ts` (new) |
| 3 | `checkEvmRailConfig` refuses confirmations mode and any `fallbackConfirmations` when the pin is chain 84532 | `tests/evm-base-knobs.test.ts` (new) |
| 4 | the Buyer's EVM lock marker is saved as the tip minus `LOCK_MARKER_REORG_MARGIN_EVM` (256), floored at 0 (`lock.fromBlock` keeps its meaning) | `tests/flow-resume-lockmark.test.ts` (new) |
| 5 (rail part), 8 | the fee ceiling of a local account defaults to 50 gwei on 84532 (1,000 gwei on anvil) and a configured value below 1 gwei is refused there; `receiptTimeoutMs` on 84532 lies between 10,000 and 3,600,000 ms | `tests/evm-base-knobs.test.ts` |
| 7 | `EvmReceiptTimeoutError.write`; `EvmHtlcRail.transactionStatus` (`eth_getTransactionByHash`, then the receipt); the hash of a timed-out LOCK write in `lock.prepared.recovery = { chain: "evm", txHash }` and of a timed-out CLAIM write in the Seller's `claimTxHash` (two strictly decoded optional record fields, extended in place, version unchanged); `recoverLock` answers pending for a held (or mined-but-not-visible) lock, the resumed Seller ends with the typed `ClaimPendingError`; reverted and unknown go on as before | `tests/evm-pending-write.test.ts` (new), `tests/flow-record.test.ts`, `tests-anvil/pending-write.anvil.test.ts` (new, real anvil with its automine switched off) |
| 10 | `lookupPauseMs` and an injectable `sleep` on `EvmHtlcRail`; the write lookup pauses before each re-plan; `createEvmCounterRail` passes the policy's block time on Base Sepolia (2 s) and `pollMs` (else 1 s) elsewhere | `tests/evm-lookup-pause.test.ts` (new) |

Helpers: `tests/helpers/evm-mock-node.ts` gained default-off knobs (`logLagBlocks` and `advance`, `holdNextSend` with `releaseHeld`, `failHeld` and
`dropHeld`, `answerTxByHash`); `tests/helpers/evm-local.ts` gained `byHash` (default "hidden", as before) and counts a pooled send in the account's
nonce; `tests/helpers/matrix-worlds.ts` gives the EVM world the known-good set of its node's chain. Existing tests that depended on the old shape
moved with it: `tests/rehearsal-run.test.ts` (the dry run on 84532 with the anvil set now fails on rule 2 of the real policy, not on the interim row) and two
`tests/rehearsal-preflight.test.ts` finality-row cases (a fallback and confirmations mode, which 84532 now refuses, run on the anvil pin).

Extended first-party files: `src/client/policy.ts`, `src/client/evm-rail.ts`, `src/client/counter-rail.ts` (the `evm` recovery shape and the optional
`transactionStatus`), `src/client/buyer.ts`, `src/client/seller.ts`, `src/client/flow-record.ts`, `src/rails/evm-htlc.ts`, `src/rails/evm-signer.ts` (a comment).
No key material in any of them: every key in the new tests is generated at test time and never printed.

What did not change: no wire or protocol change; `vendor/tclk`, `src/vendor/evm-hash-rail.ts`, `contracts/`, `fixtures/` and `package.json` are byte-identical to
`270cf47`; no new dependency; no environment variable is read by `src/`, `bin/` or `examples/`; no new fixture.

## P9-4 part 2: the runner and the documentation (handoff/P9-4-DECISIONS-2026-10-07.md decisions 1 to 3, 5 to 7, 9 to 15) - the item list

Not vendored: original to this repo. The second build of P9-4 (base: the first build's head `2791eed`; eleven commits, `cf7321f` to `ab041c8`) is the runner
half: it changed `src/client/rehearsal-config.ts`, `src/client/rehearsal-preflight.ts`, `src/client/rehearsal-run.ts`, `bin/swap-rehearsal-evm.mjs` and the tests
named below, and no flow, rail or shared file. The third build (decision 15) is documentation only: the README and this file. Every code change below was
watched to fail its test with the change disabled by the build that made it.

| decision | change | pinned by |
|---|---|---|
| 1, 2 (runner part) | the interim "no Base Sepolia policy yet" guard and its imports are removed from `src/client/rehearsal-preflight.ts` (the `deadlines` row now judges the real numbers under the rail's policy); `KNOWN_GOOD_DEADLINES` in `src/client/rehearsal-config.ts` is the per-chain table of `src/client/policy.ts` and `"known-good"` (or an absent `deadlines`) resolves by the pin's chain id; the six interim-guard tests became policy tests | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts`, `tests/deadlines-policy.test.ts` (the drift test between the two tables) |
| 3 (runner part) | the runner config names the field when 84532 is given confirmations mode (`rails.evm.pin.finality.mode`) or a `fallbackConfirmations` (`rails.evm.pin.finality.fallbackConfirmations`), before the rail's own check and without echoing a value; anvil keeps both | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts` |
| 5 (runner part) | `rails.evm.maxFeePerGasWei` (a number or a decimal string) is a known runner field, carried to the rail and into the bundle's `rails.json`, a key-like string is refused by field name; the new `fee ceiling` pre-flight row (`FEE_CUSHION`, 2x; latest base fee x 1.2 + priority fee, or gas price minus base fee) FAILS a fresh run when the ceiling is below the cushioned fee and WARNS in `--resume` and `--refund` | `tests/rehearsal-config.test.ts`, `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts`, `tests/helpers/fake-chain.ts` |
| 6 | the new `buyer nonce` and `seller nonce` rows read `eth_getTransactionCount` at `latest` and at `pending` and FAIL a fresh run when they differ, in either direction, or cannot be read (WARN in `--resume` and `--refund`); the by-hand stuck-claim step is README only (no same-nonce replacement code) | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts`, `tests/helpers/fake-chain.ts` |
| 7 (runner part), 10 (runner part) | `pendingWriteRefusal` in `src/client/rehearsal-run.ts`: `LockPendingError` and `ClaimPendingError` end the run (exit 4) with a fixed sentence that names `--resume` and signs nothing (no loop, no timer); the runner hands `pollMs: config.pollMs` to each party's rail | `tests/rehearsal-run.test.ts` |
| 9 | on 84532 the runner config refuses a `waitLimitMs` below `BASE_SEPOLIA_POLICY.finalityAMs` (4,800,000 ms) by field name; the budget itself and the 2-hour default pass; anvil is unchanged | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts` |
| 11 | `logRangeShrank` (P2R2-PIN-06's "never a smaller cap") is replaced by the exported `logScanWindowTooLong`: `--resume` is refused only when 100 x the new effective cap is below ceil((leg A's refund time - the run's start) / the policy's block time) + 256, naming both numbers and the cap that would do; a `run.json` without the recorded cap and a config with no cap are not checked | `tests/rehearsal-run.test.ts` |
| 12 | the `finality budget` row uses the larger of the measured lag and `policy.finalityAMs`, plus `LOCK_SETTLE_ALLOWANCE_MS`, and prints both numbers and the sum; an unknown lag still fails | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` |
| 13 | `revealCameAfterWindow` (the reveal frame's own stamp at or after leg A's refund time: tclk's own rule), decided before the audit; the outcome `revealed` (`audit-export --expect <swap>=revealed`, `outcome.json`, exit 0, the fixed `LATE_REVEAL_SENTENCE`; a repeated `--resume` reports success with the sentence and `--refund` says the run settled); the ordinary path still ends `settled` | `tests/rehearsal-run.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` (the late-claim case on a chain mined by hand now pins exit 0, the sentence and the replay to `revealed`; it pinned exit 6) |
| 14 | `looksLikeKeyMaterial` runs the two phrase tests (eleven bare letter words, eleven consecutive BIP-39 words) on the value as it stands and again with every `\p{Cf}` character removed, so a phrase with an invisible character inside each word is refused by field name and never quoted | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts` (`out`, `--state-dir` and the config path) |
| 15 | `README.md`: the Base Sepolia policy with the full-sample statistics and stand-stills, the per-chain known-good sets with the slack per rule and the wall-clock cost of a refund rehearsal, the finality pin rule, the lock-marker margin, the fee ceiling and its pre-flight row, the nonce rows and the by-hand stuck-claim step, the receipt-timeout bounds, the `waitLimitMs` floor, the lookup pause, the window-based resume check, the `max(lag, budget)` finality row, the late-claim path (`revealed`, exit 0), the Cf stripping, "Deploying EvmHashRail to Base Sepolia" re-read against the final config shape, and no sentence that says a fresh Base Sepolia swap is refused by design; this file | `tests/rehearsal-run.test.ts` (reads the README for the R1-FUND-04 sentence), `tests/utf8.test.ts` |

New tests and helpers of the whole P9-4 package. New test files (all of the first build): `tests/evm-policy.test.ts`, `tests/deadlines-policy.test.ts`, `tests/evm-base-knobs.test.ts`,
`tests/flow-resume-lockmark.test.ts`, `tests/evm-lookup-pause.test.ts`, `tests/evm-pending-write.test.ts` and `tests-anvil/pending-write.anvil.test.ts`. Extended test files:
`tests/flow-record.test.ts` (the EVM handle of a timed-out lock write and `claimTxHash`), `tests/rehearsal-config.test.ts`, `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` and
`tests-anvil/rehearsal-runner.anvil.test.ts` (the second build). Helpers: `tests/helpers/evm-mock-node.ts` (default-off knobs `logLagBlocks` and `advance`, `holdNextSend` with
`releaseHeld`, `failHeld` and `dropHeld`, `answerTxByHash`), `tests/helpers/evm-local.ts` (`byHash`; a pooled send counts in the account's nonce), `tests/helpers/matrix-worlds.ts`
(the known-good set of the node's chain) and, in the second build, `tests/helpers/fake-chain.ts` (a base fee on every block, `eth_maxPriorityFeePerGas`, `eth_getTransactionCount` with
its `nonceReads` log; the default answers keep every older test unchanged). The tests that moved with the shapes: `tests/rehearsal-preflight.test.ts` builds its policy and deadline set from
the config's own chain (`evmLocalPolicyFor`, `knownGoodDeadlinesFor`), the 39- and 55-minute finality-lag cases run on the anvil pin with their numbers unchanged, and the unit worlds of
the wait functions in `tests/rehearsal-run.test.ts` set their one-minute `waitLimitMs` on the parsed config directly (a real 84532 config may not carry it).

Routed on, not done in P9-4: an L1 data-fee allowance in the ETH rows and a re-measurement of the gas ceilings against the real USDC proxy (the README says both are open); a same-nonce
replacement for a stuck claim (after the first real Base Sepolia rehearsal, with its numbers); the Bitcoin, NEAR and Solana rails' quoting of `pin.name` in refusals that `watch.mjs`
and `audit-export` print (the Bitcoin and Solana devnet stages; built in P10 B4); `tests-anvil/` stayed outside `npm run typecheck` with its two older diagnostics (inside the gate since P10 B1). The
same-nonce replacement for a stuck claim is still not built (P10 item B8: the P10 section says why).

What did not change in the whole package: no wire or protocol change; `vendor/tclk`, `src/vendor/evm-hash-rail.ts`, `contracts/`, `fixtures/`, `package.json` and `package-lock.json` are
byte-identical to `270cf47` (`git diff 270cf47..HEAD` is empty for them); no new dependency; no environment variable is read by `src/`, `bin/` or `examples/`; no `Date.now()` is called in a flow
(the one added line that names it is the rail's existing default for its injected `clock` option, moved onto a line of its own); no new fixture. The hermetic count at the second build's head
`ab041c8`, before this documentation pass: 126 files, 3898 passed, 7 skipped (at `270cf47`: 120 files, 3751 passed, 7 skipped).

## P9-4 decision index (decision -> files -> tests)

Every decision of `handoff/P9-4-DECISIONS-2026-10-07.md`, with the files that carry it and the tests that pin it; the item lists above say what each change is. A decision that has a runner
part and a rail part appears once with both.

| decision | files | tests |
|---|---|---|
| 1 `BASE_SEPOLIA_POLICY`, chain-id selection, interim guard removed | `src/client/policy.ts`, `src/client/evm-rail.ts`, `src/client/rehearsal-preflight.ts` | `tests/evm-policy.test.ts`, `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` |
| 2 known-good deadline set per chain | `src/client/policy.ts`, `src/client/rehearsal-config.ts` | `tests/deadlines-policy.test.ts`, `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts`, `tests/helpers/matrix-worlds.ts` |
| 3 finality pin on 84532 | `src/rails/evm-htlc.ts`, `src/client/rehearsal-config.ts` | `tests/evm-base-knobs.test.ts`, `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts` |
| 4 the Buyer's lock-marker margin | `src/client/buyer.ts`, `src/client/flow-record.ts` (a comment) | `tests/flow-resume-lockmark.test.ts` |
| 5 fee ceiling: rail default and floor, runner field, `fee ceiling` row | `src/rails/evm-htlc.ts`, `src/rails/evm-signer.ts` (a comment), `src/client/rehearsal-config.ts`, `src/client/rehearsal-preflight.ts`, `bin/swap-rehearsal-evm.mjs` | `tests/evm-base-knobs.test.ts`, `tests/rehearsal-config.test.ts`, `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` |
| 6 stuck claim: the nonce rows (the by-hand step is README only) | `src/client/rehearsal-preflight.ts`, `README.md` | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` |
| 7 a timed-out lock or claim write is asked about by its hash | `src/rails/evm-htlc.ts`, `src/client/counter-rail.ts`, `src/client/evm-rail.ts`, `src/client/buyer.ts`, `src/client/seller.ts`, `src/client/flow-record.ts`, `src/client/rehearsal-run.ts` | `tests/evm-pending-write.test.ts`, `tests/flow-record.test.ts`, `tests/rehearsal-run.test.ts`, `tests-anvil/pending-write.anvil.test.ts` |
| 8 `receiptTimeoutMs` bounds on 84532 | `src/rails/evm-htlc.ts` | `tests/evm-base-knobs.test.ts` |
| 9 `waitLimitMs` floor | `src/client/rehearsal-config.ts` | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts` |
| 10 the pause between the write lookup's re-plans | `src/rails/evm-htlc.ts`, `src/client/evm-rail.ts`, `src/client/rehearsal-run.ts` | `tests/evm-lookup-pause.test.ts`, `tests/rehearsal-run.test.ts` |
| 11 the resume cap check as a window check | `src/client/rehearsal-run.ts` | `tests/rehearsal-run.test.ts` |
| 12 the finality row `max(lag, budget)` | `src/client/rehearsal-preflight.ts` | `tests/rehearsal-preflight.test.ts`, `tests/rehearsal-run.test.ts` |
| 13 the late-claim end state | `src/client/rehearsal-run.ts`, `bin/swap-rehearsal-evm.mjs` | `tests/rehearsal-run.test.ts`, `tests-anvil/rehearsal-runner.anvil.test.ts` |
| 14 the Cf strip before the phrase tests | `src/client/rehearsal-config.ts` | `tests/rehearsal-config.test.ts`, `tests/rehearsal-run.test.ts` |
| 15 documentation | `README.md`, `PROVENANCE.md` | `tests/rehearsal-run.test.ts`, `tests/utf8.test.ts` |
| 16 the gate | none (the main loop runs it) | typecheck of both configs, hermetic, forge, the runtime-hash recipe of `P9-FIXES-R2.md` decision 9, anvil, regtest, the key scan; NEAR and Solana rerun by the main loop |

Round 4 amends decisions 2, 7, 8, 12, 13 and 14 above (the next section says how); the files and tests of those rows stay as listed, plus the ones the next section names.

## P9 review round 4 fix pass (handoff/P9-FIXES-R4.md) - the item list

Not vendored: original to this repo. The fourth review round of P9 (three lenses and a synthesis over `87a3b96..2d37f15`: the round-3 fix pass and the P9-4 build) found no route
by which an honest party loses funds and no leak of a loaded key or of the preimage, and closed every round-3 item. It found one medium item (P94-FUND-01: the runner showed a
stuck claim's hash only when the claim's receipt wait ended, so the by-hand speed-up that P9-4 decision 6 relies on could not be reached in time) and a list of lows. The pass
(base `2d37f15`: eleven code commits, `0bb4367` to `722d88a`, then one documentation commit) changed the files named below. This table names each item once, with its commits, files
and tests, so that none is missing. "Prefix" is the start of the test's name (or of its `describe`), which is how to find it.

| item | commit(s) | files | pinned by |
|---|---|---|---|
| P94-FUND-01, rail and Seller part (medium) | `8cd017d`; the real-node pin `dc63b89` | `src/rails/evm-htlc.ts` (`ReceiptWatch.onWaitStart`, `EvmHtlcRail.onWriteBroadcast`, `EVM_CLAIM_RECEIPT_WAIT_MS_BASE_SEPOLIA` = 180,000 ms: on 84532 the claim's own receipt wait is at most that, whatever `receiptTimeoutMs` says), `src/client/counter-rail.ts` (`RailWriteBroadcast`, the optional `onWriteBroadcast`), `src/client/evm-rail.ts`, `src/client/seller.ts` (the claim's hash is saved in `claimTxHash` at the broadcast; `SellerFlowOptions.onClaimSent`; `SellerFlow.claimSentHash`; `ClaimPendingError(hash, status, timing)` names the hash, the minutes left and the by-hand step) | `tests/evm-pending-write.test.ts` (prefix `P94-FUND-01: the claim's hash is shown the moment it is broadcast`: the review's 900 ms case, an upper-case answer, a refused claim, a throwing callback, the connected rail's events, the pending sentence by cases, the 180 s bound on 84532 with a smaller value kept), `tests-anvil/pending-write.anvil.test.ts` (the claim held by a real node: the record holds the hash 2 s into a 6 s wait) |
| P94-FUND-01, runner part | `a3a7e44` | `src/client/rehearsal-run.ts` (`claimSentLine`, `claimTickLine`, `createClaimWatch`, `CLAIM_TICK_MS`, `RehearsalEnv.claimTickMs`, `stuckClaimSentence`, `pendingWriteRefusal(error, timing)`; `onClaimSent` handed to both Sellers) | `tests/rehearsal-claim-watch.test.ts` (new; prefix `P94-FUND-01 (runner part, end to end)`: a real Seller on the mock node with the claim held), `tests/rehearsal-run.test.ts` (prefix `P94-FUND-01:` for the sentences; prefix `P94-FUND-01 (runner part): the claim of leg A is shown` for the watch under fake timers), `tests-anvil/rehearsal-runner.anvil.test.ts` (`a claim the endpoint accepts and never mines (P94-FUND-01)`) |
| P94-FUND-02 | `f9dd6ff` | `src/client/rehearsal-run.ts` (`legAClaimedAtFinalized`, `lateRevealGate`, `LATE_REVEAL_NOT_ON_CHAIN`: the late-claim exit 0 needs leg A claimed at the finalized block, else exit 6 with no bundle and no `outcome.json`), `bin/swap-rehearsal-evm.mjs` (the usage text) | `tests/rehearsal-run.test.ts` (prefix `P94-FUND-02: the late-claim exit 0 requires the chain`), `tests-anvil/rehearsal-runner.anvil.test.ts` (prefix `P94-FUND-02:`) |
| P94-PIN-01 | `0bb4367` | `src/rails/evm-htlc.ts` (`EvmReceiptTimeoutError` keeps its hash in lower case), `src/client/buyer.ts`, `src/client/seller.ts` (lower-case again where they save it); the decoders stay strict | `tests/evm-pending-write.test.ts` (prefix `P94-PIN-01: a node that answers an upper-case hash`); helpers `tests/helpers/evm-local.ts` (`upperCaseHashes`) and `tests/helpers/evm-mock-node.ts` (hashes carry letters; a hash is looked up in any case) |
| P94-FUND-04 | `722d88a` | `src/client/rehearsal-run.ts` (`refundLegAWaiting` passes `alsoDone`: the late-claim wait of `--refund` ends when leg A reads Claimed at the finalized block) | `tests/rehearsal-run.test.ts` (prefix `P94-FUND-04: the late-claim wait of --refund ends when the claim's own block is final`), `tests-anvil/rehearsal-runner.anvil.test.ts` (the by-hand late-claim case mines 7 blocks, not 8) |
| P94-PIN-02 | `879e3f8` | `src/client/rehearsal-preflight.ts` (the finality row on a fresh run also requires leg B's claim-by to be at least max(measured lag, budget) after leg A's refund time, and names both numbers) | `tests/rehearsal-preflight.test.ts` (two cases, prefix `P94-PIN-02:`) |
| P94-FUND-05 | `cf4c642`; tidy `f5ac50c` | `src/client/buyer.ts` (`checkLockDeadlines`: on 84532 a lock needs leg A's claim-by to be at least the finality budget plus the lock allowance away, else refused before signing; anvil unchanged), `src/client/policy.ts` (`LOCK_SETTLE_ALLOWANCE_MS`, 10 minutes, kept equal to the pre-flight's by a test) | `tests/deadlines-policy.test.ts` (prefix `P94-FUND-05: on Base Sepolia the Buyer's lock guard asks for the finality budget`) |
| P94-PIN-03 | `e288bfb` | `src/client/rehearsal-config.ts` (on 84532 a `pollMs` below the policy's block time, 2,000 ms, is refused by field name; anvil keeps 50) | `tests/rehearsal-config.test.ts` and `tests/rehearsal-run.test.ts` (prefix `P94-PIN-03:`); three older tests that ran Base Sepolia at 250 or 777 ms moved to 2,000 and 2,777 |
| KEYS-P94-01 | `c355d9e` | `src/client/rehearsal-config.ts` (`looksLikeKeyMaterial` also strips `\p{Default_Ignorable_Code_Point}`, for the hex reading and the phrase reading), `tests/helpers/evm-local.ts` (`strippedKeyScanner` widened the same way) | `tests/rehearsal-config.test.ts` and `tests/rehearsal-run.test.ts` (prefix `KEYS-P94-01:`) |
| P94-FUND-03 | the documentation commit of this pass | `src/client/policy.ts` (a comment: 10.25 minutes, not 14.75), `README.md` (the "Known limits of the EVM leg" bullet, the policy bullets and the slack table), `tests/deadlines-policy.test.ts` (the named constant `CLAIM_BY_TO_BROADCAST_CALLS` = 13 calls of 45 s from the flow's last claim-by check to the broadcast; `claimLandsBeforeRefundMargin` is derived from it) | `tests/deadlines-policy.test.ts` (the case `the Seller's claim-by binds well before leg A's refund time`: it expects 10.25 and a margin above the 10 minutes of the claim margin; it fails when 14.75 is expected). `CLAIM_PIPELINE_MS` (6 x 45 s + 45 s = 5.25 minutes) and the pipeline slack lines (9.75 minutes) are another check and did not change |
| KEYS-P94-02 | the documentation commit of this pass | `README.md` (the forms still unseen: a phrase whose words are joined with no visible separator, in CamelCase, or joined by a zero-width character while another sits inside each word; with KEYS-P94-01's wording: invisible characters are category Cf and the other default-ignorable code points, and U+2800 and other visible-but-blank separators stay unseen) | none (documentation) |
| R5-KEYS-01 (the main loop's opus read of this pass: KEYS-P94-01 glued words that a Hangul filler, U+034F or U+FE0F separated) | `96dd425` | `src/client/rehearsal-config.ts` (`looksLikeKeyMaterial`: both phrase tests on the value as it is, with Cf removed only, and with both invisible classes removed; the word-list test also on a reading with the Hangul fillers as word breaks); `README.md` (the three readings) | `tests/rehearsal-config.test.ts` (prefix `R5-KEYS-01:`) |
| R5-PIN-01 (the same read: nothing pinned that the 180 s claim-wait cap is Base Sepolia's only) | `90f183b` | none (test only) | `tests/evm-pending-write.test.ts` (prefix `R5-PIN-01:`) |

Documentation of the code items above, in the same documentation commit: `README.md` (the example config no longer sets `receiptTimeoutMs`; the config tables gain the claim's 180 s bound
and the `pollMs` floor; the by-hand stuck-claim step 1 names the runner's `claim of leg A sent: tx <hash>` line first; the `finality budget` row and the Buyer's lock guard; the `--yes`,
`--refund` and exit-code texts; the pending-claim and late-claim bullets of "Known limits of the runner"). Not here: P94-PIN-04 (the spec's slack sentence and the decisions file's
stand-still count and p90 label) belongs to the main loop's files; the open notes of the review (a), (b), (g) and (i) are documented as they stood, (c) and (f) are P94-FUND-01 above,
(d) goes to the checkpoint and the first real dry run, (e) is P94-PIN-02, and (h) gets its fake-chain pin from P94-FUND-02.

Amended by this pass (the tables above keep their text as a record of the build): decision 7 (the claim's hash is saved at the broadcast, not after the timeout; a pending claim ends the run with a
sentence that carries the hash, the minutes left and the by-hand step; the runner has no loop that sends anything, but one real timer, unref'd, prints a line a minute while a claim's wait lasts),
decision 8 (on 84532 the claim's own wait is at most 180 s), decision 12 (the finality row also checks the leg-linking slack), decision 13 (the late-claim exit 0 requires the chain: leg A claimed at the
finalized block), decision 14 (the strip covers the default-ignorable code points) and decision 2's arithmetic (a claim sent as late as the claim-by allows reaches the pool 10.25 minutes before refunds
open, counted over 13 calls from the flow's last claim-by check).

New files: `tests/rehearsal-claim-watch.test.ts` (the first-party test file of the runner's claim watch; it joins `tests/rehearsal-config.test.ts`, `tests/rehearsal-world.test.ts`,
`tests/rehearsal-preflight.test.ts` and `tests/rehearsal-run.test.ts` of "First-party rehearsal runner files"). No new helper file; `tests/helpers/evm-local.ts` and `tests/helpers/evm-mock-node.ts`
were extended as the table says. Extended first-party files: `src/client/buyer.ts`, `src/client/seller.ts`, `src/client/policy.ts`, `src/client/counter-rail.ts`, `src/client/evm-rail.ts`,
`src/client/rehearsal-config.ts`, `src/client/rehearsal-preflight.ts`, `src/client/rehearsal-run.ts`, `src/rails/evm-htlc.ts` and `bin/swap-rehearsal-evm.mjs`. No key material in any of them: every
key and phrase in the new tests is generated at test time, and the assertions print booleans, never a key or a word of a phrase; the hashes the new tests use are public values.

What did not change: no wire or protocol change; `vendor/tclk`, `src/vendor/evm-hash-rail.ts`, `contracts/`, `fixtures/`, `package.json` and `package-lock.json` are byte-identical to `2d37f15`;
no new dependency; no environment variable is read by `src/`, `bin/` or `examples/`; no `Date.now()` is called in a flow; no new fixture; the runtime code hash is the one in the table above.
`tests-anvil/` stayed outside `npm run typecheck` with its two older diagnostics (inside the gate since P10 B1). The hermetic count after the pass, with the two tests of the main loop's read (R5-KEYS-01, R5-PIN-01): 127 files, 3949 passed, 7 skipped.

## P10 backlog (handoff/P10-BACKLOG-SPEC.md) - the item list

Not vendored: original to this repo. P10 builds the items that P8 and P9 recorded as backlog, on branch `phase2-backlog` from `a59f6b2` (`main` after the P9 checkpoint): ten code
commits, `9657ba3` to `25a6bd3`, then the documentation commit(s) that carry this section. Keyless and local like every package before it: no public RPC call from any test, no
key or seed in any file, nothing pushed. This table names each item once, with its commits, files and tests, so that none is missing. "Prefix" is the start of the test's (or the
`describe`'s) name, which is how to find it. Every code item has a failing-without test: its commit message records the fix being disabled and the tests that then fail, and the file
restored byte for byte.

| item | commit(s) | files | pinned by |
|---|---|---|---|
| B1: the type gate covers the four live test folders | `9657ba3` | `tsconfig.tests.json` (`include` gains `tests-anvil/**/*.ts`, `tests-regtest/**/*.ts`, `tests-near/**/*.ts`, `tests-sol/**/*.ts`); `tests-anvil/client-flows.anvil.test.ts` (the two TS2322 errors, fixed with the `as Hex` cast that `tests-anvil/local-signer.anvil.test.ts` already uses); `tests-near/client-flows.near.test.ts` (three non-null assertions for TS2345 and TS18048). Types only: the four folders are erased at run time and no `src/` file changed | `npm run typecheck` itself: with the cast and the assertions taken out it printed five errors and failed, restored it exits 0. The program now holds 163 files under `tests/`, 10 under `tests-anvil/`, 9 under `tests-regtest/`, 6 under `tests-near/` and 5 under `tests-sol/` |
| B5: a late claim is `revealed` only if the bundle's own leg A observation says claimed | `d6fb3df` | `src/client/bundle.ts` (`writeBundle` returns `WriteBundleResult { status, legARail }`), `src/client/rehearsal-run.ts` (`bundleLegAClaimed`, `LATE_REVEAL_BUNDLE_NOT_CLAIMED`, the check in `writeAndAudit` before the staged copy is renamed, the audit runs or `outcome.json` is written) | `tests/late-claim-bundle.test.ts` (new, 5 cases), `tests-anvil/rehearsal-runner.anvil.test.ts` (the chain proxy gains `lockedAtHashedBlocks`; one new case: exit 6, the new sentence, no bundle directory, no `outcome.json`, nothing sent, and the next `--resume` finishes `revealed`); helper knob `hashReadsShowClaimedAsLocked` in `tests/helpers/evm-mock-node.ts` |
| B6: every EVM write is named by the keccak256 of its signed bytes | `4fdbfc8`; follow-up `dd04c52` | `src/rails/evm-signer.ts` (`verifySentTransactionHash`, `sentHashMismatchWarning`: the fourth defence of that module), `src/rails/evm-htlc.ts` (the local wallet's transport; `EvmHtlcRailOptions.onWarning`), `src/client/evm-rail.ts` (`EvmCounterRailOptions.onWarning`), `src/client/rehearsal-run.ts` (each rail gets `onWarning: errLine`). The follow-up made the warning name the computed hash only, never the endpoint's answer | `tests/evm-sent-hash.test.ts` (new, 8 cases: the wrapper alone, 15 shapes of non-hash answer none of them quoted, an error reply, other methods, a throwing listener, no state between writes, ASCII text), `tests/evm-pending-write.test.ts` (six new cases over the real flows and rail), `tests/rehearsal-claim-watch.test.ts` (the printed line and the ending sentence name the computed hash; a source pin that the runner passes `errLine`); helpers `tests/helpers/evm-mock-node.ts` (`answerWrongHashForNextSend`, `wrongHashesAnswered`, a raw send keyed under keccak256 of its bytes) and `tests/helpers/evm-local.ts` |
| B4, Bitcoin part: pin texts quoted only when plain | `cb7f7ea` | `src/rails/pin-text.ts` (new, imports nothing: `PIN_TEXT_SHAPE`, `UNPLAIN_PIN_TEXT`, `quotedPinText`, `quotedPinTextOrPlaceholder`, moved from `src/rails/evm-htlc.ts`, which re-exports `PIN_TEXT_SHAPE`), `src/rails/btc-htlc.ts`, `src/rails/btc-evidence.ts`, `src/client/btc-rail.ts` (the deployment id), `src/client/policy.ts` | `tests/btc-pin-text.test.ts` (new, 12 cases: a generated key in five spellings and a generated phrase in three, as pin name, network, genesis hash or caip2, leave no window in the config check, the sweep's `railsConfigError` and notes, `bin/watch.mjs` output, `audit-export` `--rails FILE` and `DIR/rails.json`, `connect`, `createBtcCounterRail`, `btcFeeRuleFor`, `btcLocalPolicyFor` and the deployment id; 40 plain characters are quoted and 41 are not) |
| B4, NEAR part: the same, and the pinned code hash by 8 characters | `73cb113` | `src/rails/pin-text.ts` (`shortPinnedValue`, `UNPLAIN_PINNED_VALUE`), `src/rails/near-htlc.ts` (`refusedByName`, `isNearCodeHash`), `src/rails/near-evidence.ts`, `src/client/near-rail.ts` (`nearDeploymentId`) | `tests/near-pin-text.test.ts` (new, 18 cases, including a key as the contract account, which the config check accepts, and a live capture through `captureNearLeg` on a mocked node) |
| B4, Solana part: the same, and the program hash by 8 characters | `25a6bd3` | `src/rails/sol-htlc.ts`, `src/client/sol-rail.ts` (`solDeploymentId`) | `tests/sol-pin-text.test.ts` (new, 17 cases, including a key as the pinned `programHash`, which passes the config check) |
| B3: the signet pin carries the challenge and the rail compares it | `9c12900` | `src/rails/btc-htlc.ts` (`BtcChainPin.signetChallenge`, `BTC_SIGNET_PIN`, `BtcPinMismatchError`, the compare in `assertPinnedChain`, the shape check and the config check of `pin.signetChallenge`) | `tests/btc-htlc.test.ts` (describe "P10 B3", 8 cases: the constant's structure, the default challenge connects, a node answering `51` is refused naming `signet_challenge`, a missing or odd answer is refused and never quoted, the config rules, regtest unchanged, the re-check before every write and read, the client wrapper); the signet mock node now answers the default challenge |
| B2: a signet leg that cannot pay the fee is refused; a spend never pays below the rule's estimate | `ece90c1` | `src/rails/btc-htlc.ts` (`spendFeeSatsFor` returns the estimate or throws `BtcSpendUnaffordableError`; `BTC_HTLC_WITNESS_SCRIPT_BYTES` 118, `BTC_MAX_DESTINATION_SCRIPT_BYTES` 34, `BTC_SIGNET_MAX_SPEND_FEE_SATS` 7,600, `BTC_SIGNET_MIN_LOCKABLE_SATS` 8,646, `btcMinLockableSatsFor`), `src/client/btc-rail.ts` (the rail's `minLockableAmount` is chosen by the pin's network name) | `tests/btc-signet-fee.test.ts` (the old "dust ceiling, the floor wins" case became the refusal; an exact boundary, a grid over rates, sizes and amounts, 118 and 34 pinned against `buildHtlcScript` and `scriptPubKeyForAddress`, the real `BuyerFlow.bid` and `SellerFlow.acceptLegA` refusing 2,046 and 8,645 on signet and taking 8,646, regtest unchanged at 2,046), `tests/btc-htlc.test.ts` (a claim and a refund of a 2,046 satoshi leg throw before any wallet, acceptance or send call; an 8,646 leg pays the full cap fee) |
| B7: a Bitcoin Seller claim counts as landed only once mined | `bb1c80f` | `src/rails/btc-htlc.ts` (`BtcClaimOptions`, the recorder in `claim`, `claimStatus`, `resendClaim`, `claimMined`, `scanMinedSpend`), `src/client/counter-rail.ts` (`RailClaimOptions.onSignedTx` and `onNotBroadcastTx`, `ClaimTxStatus`, `ClaimTxResend`, the three optional methods `claimIsMined`, `claimTxStatus`, `resendClaimTx`), `src/client/btc-rail.ts`, `src/client/flow-record.ts` (the optional Seller field `claimTx { txid, rawTx, sent? }`, record version unchanged, redaction), `src/client/seller.ts` (`ClaimNotMinedError`, `ClaimSupersededError`, `assertFirstClaimGuards` moved verbatim, `resumeBtcClaim`, `settleBtcClaim`) | `tests/flow-claim-mined-btc.test.ts` (new, 25 cases over the stateful Bitcoin ledger fake on a chain that mines only when told), `tests/btc-claim-settle.test.ts` (new, 27 cases against a mocked bitcoind), `tests/flow-record.test.ts` (24 cases for `claimTx`), `tests/helpers/ledger-rail.ts` (the Bitcoin flavour signs, records, sends, mines, evicts and has the three methods), and live `tests-regtest/claim-mined.regtest.test.ts` (new, 6 cases on a real bitcoind: a real eviction with `-mempoolexpiry=1`, an identical re-send counted from the wire, also past the claim-by, a spent funding output not re-sent); helper `tests-regtest/helpers/claim.ts` (new) and four existing regtest files adjusted (a scenario that called `claimLegA` once now broadcasts, mines and calls again) |

### The first review's fix pass (handoff/P10-FIXES-R1.md)

One read-only review of `a59f6b2..c037aaa` (fund safety with the Bitcoin claim state machine first, key handling, pins and bounds) found no route by which an honest party loses funds that
could not before, no key or preimage leak and no weakened assertion; its findings were all low, and one of them showed the main loop's own revision of decision 7 was too generous. Six commits fix
them. Each code fix has a failing-without test, recorded in its commit message: the fix (or the old logic) put back, the focused tests seen to fail, the file restored byte for byte.

| finding | commit | files | pinned by |
|---|---|---|---|
| P10-FUND-03 + P10-FUND-01: the identical re-send of a Bitcoin claim gets a bound, and the narrow window closes | `ff3a7da` | `src/client/seller.ts` (`ClaimResendTooLateError`, `resendUnknownClaim`, `legBTakenWithOurSecret`; the headers and docblocks) | `tests/flow-claim-mined-btc.test.ts` (10 new cases: leg B claimed with the secret re-sends at any time, with or without the `sent` mark; an accepted claim that was dropped is refused at and past `refundAfterMs` minus the claim-inclusion margin and re-sent one millisecond before it; the refusal ends once the Buyer claims leg B; a refund still ends in `ClaimSupersededError`), `tests-regtest/claim-mined.regtest.test.ts` (the re-send case moved inside the bound) |
| P10-KEY-01: the recorded claim is an ES `#private` field | `cd1486c` | `src/client/seller.ts` (`#claimTx`), `tests/helpers/ledger-rail.ts` (`claimBytesCarrySecret`) | `tests/flow-resume-held.test.ts` (2 new cases: a Bitcoin world whose claim bytes embed the preimage, the Seller dead before the send; the signing flow and the resumed one show nothing in `Object.entries`, `util.inspect` with hidden properties at any depth, JSON or structured clone) |
| P10-FUND-02: a claim is "in the mempool" only when `getmempoolentry` knows it | `d15cc5b` | `src/rails/btc-htlc.ts` (`claimTxPresence`, `claimStatus`, `resendClaim`) | `tests/btc-claim-settle.test.ts` (6 new cases, the mock gained `getmempoolentry` and a stale-branch knob), `tests-regtest/claim-mined.regtest.test.ts` (a real node: mined, `invalidateblock`, expired from the mempool, sent again with the recorded bytes) |
| P10-KEY-02: `rails.btc.asset` is a short plain name, quoted only through the helper | `8c2416f` | `src/rails/pin-text.ts` (`ASSET_NAME_SHAPE` moved from the EVM rail, `UNPLAIN_ASSET_NAME`, `quotedAssetNameOrPlaceholder`), `src/rails/btc-htlc.ts` (the config check), `src/rails/btc-evidence.ts`, `src/rails/evm-htlc.ts` (re-export), `src/client/seller.ts`, `src/client/buyer.ts` | `tests/btc-asset-text.test.ts` (new, 8 cases: a generated key in five spellings and a phrase in three; the config check, `btcEvidence`, the Seller's accept, the Buyer's bid and lock, the sweep, `watch.mjs` and `audit-export`) |
| P10-PIN-01: the B7 test gaps, and a defect the last of them found | `53ae3c8` | `src/client/seller.ts` (`project` no longer keeps a forgotten `claimTx` from the last saved record), `tests/helpers/ledger-rail.ts` (`claimCalls`, `refuseClaimAcceptance`) | `tests/flow-claim-mined-btc.test.ts` (5 new cases: `noteClaimAccepted` on the scan path and on the txid path, the dropped record of a refused claim at the flow level, a counter that sees a re-send through `claim()`, tclk's fold) |
| P10-DOCS-01: the documentation | the commit that carries this part | `README.md`, `PROVENANCE.md`, a comment of `src/client/near-rail.ts` | none (documentation) |

What the fix pass found beyond the list: the drop of a claim the node refused (`onNotBroadcastTx`) was never saved, because `project` laid the live state over the last saved record and an
undefined `#claimTx` left the stale one in place (a restarted process re-sent the old bytes, or ended in a `RailRecoveryRefusedError`, instead of making a fresh guarded first claim; no fund was
at risk, the bytes had never reached the network). Fixed in the P10-PIN-01 commit.

### The second review's fix pass (the reviewer's re-read of the first)

The re-read found no fund loss and no key leak and closed every earlier finding; it raised two low items and two small ones, fixed in two commits and this documentation.

| finding | commit | files | pinned by |
|---|---|---|---|
| P10R2-FUND-01: a failed read of leg B's note blocked the re-sends that do not need it; and a test name said "past the claim-inclusion margin" while it ran inside the bound | `d94ea1d` | `src/client/seller.ts` (`legBTakenWithOurSecret` answers false for a read that throws) | `tests/flow-claim-mined-btc.test.ts` (4 new cases over a paper rail whose read throws: the identical re-send inside the bound, still `ClaimResendTooLateError` past it and when leg B was claimed, the first-claim guards of a never-sent claim; the renamed case) |
| P10R2-FUND-02: a claim the node accepted whose `sent` mark was lost counted as a first claim; the Seller's own wallet now says it was accepted. Also the `ClaimSupersededError` sentence for `sent` false | `ade6687` | `src/rails/btc-htlc.ts` (`walletKnowsTransaction`), `src/client/btc-rail.ts` and `src/client/counter-rail.ts` (`claimTxKnownToWallet`), `src/client/seller.ts` (`noteClaimKnownToWallet`; the new sentence) | `tests/flow-claim-mined-btc.test.ts` (6 new cases over the ledger fake's wallet), `tests/btc-claim-settle.test.ts` (5 new cases against the mocked bitcoind), `tests-regtest/claim-mined.regtest.test.ts` (a real node: the wallet still answers after an expiry, with no confirmation; the identical re-send past the claim-by) |
| documentation of both | the commit that carries this part | `README.md`, `PROVENANCE.md` | none |

What Core 31.1 answered (observed on a regtest node with `-mempoolexpiry=1`, the claim paying to the Seller's wallet, the node's mock time moved two hours and an unrelated transaction submitted so that the
mempool dropped the claim): `gettransaction <claim txid>` on the Seller's wallet still answers, with `confirmations` 0, `trusted` false, no `blockhash`, empty `walletconflicts` and `mempoolconflicts`, and no
`abandoned` or `in_mempool` key; for a transaction the wallet has no part in (the Buyer's funding) it answers code -5. A wallet that was restored from a backup without a rescan, or a claim whose destination
is another wallet's address, would not know the transaction: that is the residual, written in the README's limit (1).

P10R3-PIN-01 (test only, `tests-regtest/claim-mined.regtest.test.ts`, cases 7a and 7b): the negative the wallet signal rests on, on a real node. A claim signed and passed through
`testmempoolaccept` whose `sendrawtransaction` call was dropped before the node (record: `claimTx` without `sent`), and a claim signed and then refused by the rail's own last deadline read,
are unknown to the Seller's wallet (`gettransaction` answers code -5, `walletKnowsTransaction` is false), and a restarted Seller past the claim-by keeps the first-claim guard ("at/after its
claimByMs") and makes no `testmempoolaccept` and no `sendrawtransaction` call.

Not built, on purpose: the backlog's two other items wait for the desk operator's word. B8, an automatic same-nonce re-pricing of a stuck EVM claim, is recommended after the first
real Base Sepolia rehearsal, with its numbers (the README still says to speed a stuck claim up by hand). B9, the Solana program-side compute fix (store the vault bump in the escrow:
a program build, a fixture refresh and a review round), is recommended with Solana devnet. Neither has code, a test or a fixture in this package.

The signet challenge's derivation (B3). `BTC_SIGNET_PIN.signetChallenge` is a public constant (a 71-byte 1-of-2 multisig script of two public keys: OP_1, key, key, OP_2, OP_CHECKMULTISIG;
142 hex characters, shown here shortened as `512103ad5e...2ae`) and was DERIVED, never typed from memory or fetched:

1. An offline Bitcoin Core v31.1.0 node: `bitcoind -signet -datadir=<a fresh scratch directory> -connect=0 -listen=0 -dnsseed=0 -fixedseeds=0 -rpcport=<a free port>`. No peer, no DNS seed
   and no fixed seeds, so the node never talks to a network.
2. `bitcoin-cli -signet` with the same datadir and port, `getblockchaininfo`: the `signet_challenge` field is the value.
3. On the same node `getblockhash 0` answered the genesis hash that `BTC_SIGNET_PIN.genesisHash` pins, so the challenge and the genesis hash come from one node that agrees with the pin.
4. The node was stopped afterwards.

To check it again, repeat steps 1 and 2 on any Core 31.1 node started that way and compare (case-insensitively) with the constant. The value has not met a live public signet peer of this
build; that check, with the genesis hash, is the desk operator's G1 step before `-UNVERIFIED` leaves the pin's name (README, "Bitcoin signet (P9-5)").

Open residuals the packages leave, each written in the README as a known limit:

- B7: in one narrow window the first-claim guards refuse a re-send (the node accepted the claim, the reply was lost, the lookup then failed, the claim was evicted, the claim-by has
  passed, leg B's note does not read claimed with the swap's secret and the Seller's own node wallet does not know the transaction, because the claim's destination is not an address of that
  wallet, the wallet never saw the claim, or the wallet read failed: a never-sent claim re-sent late would be a new reveal after the claim-by); an accepted claim that was dropped is
  not re-sent past leg A's refund time minus the claim-inclusion margin unless the Buyer has claimed leg B (`ClaimResendTooLateError`, a person acts); the claim status reads need
  `-txindex=1`; a claim that a reorg removes after its one confirmation is not sent again; a record written before this change holds no claim bytes, so its flow cannot re-send a claim it
  never recorded.
- B4 (NEAR): a NEAR contract or token account that is a 64-hex implicit account has a new deployment id (a digest of it, not the digits), so a flow record written before P10 for such a
  deployment is refused on resume (`FlowRecordMismatchError` on `deploymentId`; fail closed; a person reads the lock and leg B's note on chain and settles or refunds by hand). A deployment with named accounts keeps its id byte for byte.
- B3: the offline replay and the evidence reader do not compare the signet challenge; the live `connect()` and every write do.
- B4: a plain pin text of at most 40 characters is quoted by design, so a key cut to 40 characters or fewer and pasted into a pin name would still be echoed; `src/rails/account-line.ts`
  still quotes the caip2 it is given (a rail built in code, not a rails file).

Documentation (the commit(s) that carry this section):

- `README.md`: the type gate paragraph; the guarded-set bullet for pin texts, with its two residuals; the new paragraph "A write is named by the keccak256 of its signed bytes", with the two
  warning sentences and `onWarning`; the lower-case hash sentence; the short pinned hash of NEAR and Solana; every place that prints `claim of leg A sent: tx <hash>`; the late-claim bullet, with its
  second check and the new exit 6 sentence; the regtest suite list; the signet pin paragraph; the fee bullet, with the two minimums; the Bitcoin lost-reply paragraph and the new "counts as
  landed only once it is mined" bullet; the NEAR evidence reason; the Solana pin paragraph; the deployment id sentence; and the Bitcoin bullets of "What a resumed step does", "What still
  needs a person" and "Limits of resume".
- `PROVENANCE.md`: the P9-5 signet paragraph, the P9-1 signer note, the P9-7 gate lines and the "stays outside the gate" notes now point here, and this section is new; the fix pass
  after the first review adds the table above ("The first review's fix pass") and updates the B7 and B4 residuals.
- The fix pass's documentation (P10-DOCS-01): in `README.md`, the B7 bullet (the re-send rule with its three cases, `ClaimResendTooLateError`, the stale-branch reading of the node, the
  evidence note after `ClaimNotMinedError`), the "What a resumed step does" paragraph, "What still needs a person" (five cases), the "Limits of resume" ending, and the deployment id paragraph
  (the NEAR implicit-account limit, which that paragraph used to deny).
- New test files, as listed above: `tests/late-claim-bundle.test.ts`, `tests/evm-sent-hash.test.ts`, `tests/btc-pin-text.test.ts`, `tests/near-pin-text.test.ts`, `tests/sol-pin-text.test.ts`,
  `tests/btc-claim-settle.test.ts`, `tests/flow-claim-mined-btc.test.ts` and `tests-regtest/claim-mined.regtest.test.ts`.

No key material in any of the new tests: every key and phrase in them is generated at test time and only scanned for, the assertions are on booleans, and the hashes and the signet challenge
they use are public values.

What did not change: no wire or protocol change; `vendor/tclk`, `src/vendor/`, `contracts/`, `contracts-near/`, `contracts-sol/`, `fixtures/`, `docs/`, `bin/`, `examples/`, `package.json` and
`package-lock.json` are byte-identical to `a59f6b2` (`git diff a59f6b2..HEAD` is empty for them); no new dependency; no environment variable is read by `src/`, `bin/` or `examples/`; no
`Date.now()` is added; no new fixture. The hermetic count after the package and its two fix passes: 135 files, 4158 passed, 7 skipped (after the first fix pass: 135 files, 4143 passed; after the package alone, at `c037aaa`: 134 files,
4112 passed; before it, at `a59f6b2`: 127 files, 3949 passed, 7 skipped; the first fix pass adds 31 cases and one file, `tests/btc-asset-text.test.ts`, the second adds 15 cases and no file). The regtest
suite after the second pass: 7 files, 37 passed (35 at `c037aaa`, plus the stale-branch case and the wallet case); the anvil suite: 9 files, 52 passed (seller.ts is shared flow code the EVM leg runs, so
it was run again at the end of both passes); NEAR and Solana were not run by the fix passes (the main loop runs them). The first pass's documentation commit changes only `README.md`, `PROVENANCE.md`
and one comment of `src/client/near-rail.ts`; the second pass's changes only `README.md` and `PROVENANCE.md`.
