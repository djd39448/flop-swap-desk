# Provenance

Files vendored or derived from `@flop-labs/tclk` (upstream `flop-labs/tclk`), fetched into this
repo's `vendor/tclk` git submodule object store as local refs. Every hash below is the sha256 of
the exact git blob bytes (`git -C vendor/tclk show <rev>:<path> | sha256sum`) — never a working
copy, which can be rewritten by a checkout's autocrlf settings.

## tclk#21 — `EvmHashRail.sol` and its Foundry test (vendored byte-identical)

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
| `foundry.toml` | `foundry.toml` | `8dedbc4aab0d608cfd79f69a9a9a91d3d2a302da` | `cb358a2815a47a19a2fe7203e90c01beb351ab122b67f08122d5a3b57f93ce22` |
| `foundry.lock` | `foundry.lock` | `31b0fe2e253592e6f72dca5a7f07b070da9d02ce` | `6b182f57b5c5615131465941411dac80a778d554bd4a796bd28749b9b752d6f0` |

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
  now (see the P9-7 section at the end of this file).
- Live tests (each spawns its own throwaway local node and never touches a public network):
  `tests-anvil/resume.anvil.test.ts`, `tests-regtest/resume.regtest.test.ts`, `tests-near/resume.near.test.ts` and
  `tests-sol/resume.sol.test.ts`.

## First-party EVM signer files (P9-1, handoff/P9-G1-READINESS-SPEC.md) - unaudited, testnet-only

Not vendored: original to this repo, written for the G1 readiness stage (a real key on a public testnet, Dave's own key
files). Unaudited and testnet-only like every file above. No key material is in the repository: the tests generate their
keys at test time, and the loader reads a key only from a file an operator names at run time.

- `src/client/evm-key-file.ts` - `loadEvmLocalAccount(path)`: reads one `0x`-prefixed 32-byte hex key, refuses everything
  else with the typed `EvmKeyFileError` (a message that names the path and the problem and never any content), warns on a
  group- or world-accessible file on POSIX (the check is skipped on win32), and returns a frozen viem `LocalAccount` that
  prints, serialises and inspects as its address and type only (`sealLocalAccount`).
- Extended first-party files: `src/rails/evm-htlc.ts` (the `account` option is an `Address` or a `LocalAccount`; local
  accounts send `eth_sendRawTransaction`; `EvmRailConfig.receiptTimeoutMs`; the typed `EvmReceiptTimeoutError`; the public
  client's `waitForTransactionReceipt` is wrapped so the vendored rail's receipt waits are bounded too, while
  `src/vendor/evm-hash-rail.ts` stays byte-identical) and `src/client/evm-rail.ts` (the same option; the EIP-191 account
  proof is `account.signMessage` for a local account, verified as before).
- Hermetic tests: `tests/evm-key-file.test.ts` (every refusal, the warning on both platforms, every serialisation of the
  account scanned for the key), `tests/evm-local-signer.test.ts` (raw sends, nonces, the claim's preimage ordering, the
  proof, receipt timeouts, whole swaps with local accounts including a lost lock reply recovered through the P8 path, and a
  scan of every capture, venue line, store record and rendering for the key) and the helper `tests/helpers/evm-local.ts`
  (key generation into a temporary file loaded by the real loader, a key scanner that answers a boolean only, and a mock
  node that also answers nonce, gas, fee and raw-send reads). They were outside the `typecheck` gate when written and are
  inside it since P9-7 (see that section at the end of this file).
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

**Dave's deployed contract must report the runtime value through `bin/evm-code-hash.mjs`** (`node bin/evm-code-hash.mjs
<rpc-url> <address>` prints `keccak256 0x...` and `bytes 3416`); that is the string that goes into `contractCodeHash` in
`rails.json`. Another value means the code at that address is not this source built with this toolchain, and the desk will
refuse it.

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

## First-party code-pin and log-scan files (P9-2, P9-3) - unaudited, testnet-only

Not vendored: original to this repo. No key material in any of them.

- `src/rails/evm-code-pin.ts` - the one judgement of a contract's code against `contractCodeHash` (`judgeRuntimeCode`),
  shared by `EvmHtlcRail.connect` and the evidence reader so they cannot disagree.
- Extended first-party files: `src/rails/evm-htlc.ts` (`EvmRailConfig.contractCodeHash` and `maxLogRange`; the typed
  `EvmContractCodeError` and `EvmLogScanBoundError`; `effectiveMaxLogRange`; the chunked write-evidence lookup and
  `findClaimedPreimage`), `src/rails/evm-evidence.ts` (the capture records `eth_getCode` for a pinned config and the
  decoder fails closed on it) and `src/client/seller.ts` (comments only). `src/vendor/evm-hash-rail.ts`, `vendor/tclk` and
  `contracts/` are untouched.
- `bin/evm-code-hash.mjs` - prints the keccak256 and byte length of the code at an address; read-only, one JSON-RPC call,
  never prints the RPC URL.
- Hermetic tests: `tests/evm-code-pin.test.ts`, `tests/evm-code-hash-bin.test.ts` (against a throwaway local HTTP server),
  `tests/evm-log-scan.test.ts`, the P9-3 block of `tests/flow-resume-sell.test.ts`, and the helper `tests/helpers/scripted-rpc.ts`;
  the stateful mock node (`tests/helpers/evm-mock-node.ts`) answers `eth_getCode`, a chain id, and refuses an `eth_getLogs` range
  over its cap exactly as the public endpoint does.
- Live tests: `tests-anvil/code-pin.anvil.test.ts` and `tests-anvil/log-scan.anvil.test.ts`.

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
  the value G1-PREP section 4 read from a public block explorer. It has not been compared with a live node.
- Hermetic tests: `tests/btc-signet-fee.test.ts` (new: the size bound against the two real Core-signed spends in
  `fixtures/btc-regtest-2026-09-28/`, the rate and fee rules, the policy selection) and the P9-5 blocks of
  `tests/btc-htlc.test.ts` and `tests/btc-evidence.test.ts` (the pin, the adapter against a mocked bitcoind, the retry rule).
- Live test: `tests-regtest/btc-htlc.regtest.test.ts` gained assertions about the real Bitcoin Core 31.1 node (what
  `estimatesmartfee` answers with no data; that `walletcreatefundedpsbt` takes the rate as `fee_rate` in sat/vB); the regtest
  suite is still 29 tests and no regtest request changed.

## First-party rehearsal runner files (P9-6, handoff/P9-G1-READINESS-SPEC.md, rule 4) - unaudited, testnet-only

Not vendored: original to this repo. The runner is dry-run by default and Dave runs it; it posts to no HTTP venue and its only
network is `rails.evm.endpoint`. No key material in any of them: the two EVM keys are loaded by `loadEvmLocalAccount` from files
the operator names and are never printed, stored or inspected; the tests generate their keys at test time.

- `bin/swap-rehearsal-evm.mjs` - the command line (arguments, exit code); everything else is in `src/client/`.
- `src/client/rehearsal-config.ts` - the closed config file (`rails.evm` rebuilt from known fields only, no credentials in the
  endpoint, `clock: "chain"` for anvil only, the known-good deadline set); `src/client/rehearsal-preflight.ts` - the read-only
  pre-flight table (chain id, code pin, finalized lag, `pending`, state at the finalized hash, log cap, clock, balances, deadlines);
  `src/client/rehearsal-world.ts` - the in-memory venue and paper notes made durable (atomic file writes), the two parties'
  Ed25519 venue seeds, and the one-runner lock; `src/client/rehearsal-run.ts` - the modes (dry run, `--yes`, `--resume`,
  `--refund`), `run.json` and `outcome.json`, the bundle and the `audit-export` replay.
- Hermetic tests: `tests/rehearsal-config.test.ts`, `tests/rehearsal-world.test.ts`, `tests/rehearsal-preflight.test.ts`,
  `tests/rehearsal-run.test.ts` (the runner and its command line against a fake read-only chain served by a throwaway local HTTP
  server), and the helper `tests/helpers/fake-chain.ts`.
- Live test: `tests-anvil/rehearsal-runner.anvil.test.ts` (the runner as a child process against real anvil nodes: the dry run, a
  settle, a kill and a resume at two cuts, and the refund paths; every file it wrote and its output scanned for both keys and for
  the venue seeds) and the `blockTimeSeconds` option of `tests-anvil/helpers/anvil.ts`.
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
  ran under vitest alone, which does not check types; the P8 and P9-1 notes above point here.
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
- Not in the gate: `tests-anvil/`, `tests-regtest/`, `tests-near/` and `tests-sol/`. Under a scratch config the first has 2
  diagnostics (`tests-anvil/client-flows.anvil.test.ts`, a `string` where a hex type is wanted), the third 3
  (`tests-near/client-flows.near.test.ts`, `txHash` possibly undefined); `tests-regtest/` and `tests-sol/` report none.
