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

`fixtures/evm-anvil-2026-09-28/{settled,refunded,refunded-b}/` are also first-party: real
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

`fixtures/btc-regtest-2026-09-28/{settled,refunded,refunded-b}/` are also first-party: real
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

`fixtures/near-sandbox-2026-09-29/{settled,refunded,refunded-b}/` are also first-party: real
capture bytes from a real, local, ephemeral `near-sandbox` node this repo itself starts and stops
(`tests-near/client-flows.near.test.ts`) — not from any external service, and containing no
private key material (this build never holds a real NEAR secret key to begin with beyond the
one sandbox-generated `test.near` key, read once into memory and never serialized — D-N2; every
account and key these captures ever name past that point is this process's own freshly generated,
zero-value, in-memory keypair). `tests/near-sandbox-fixtures.test.ts`'s own extended key-material
scan (the Bitcoin fixture scan's patterns, the literal `"secret_key"` and `"private_key"` field
names, any base58 token decoding to 64 bytes whose first 32 bytes derive its last 32, and any
32-byte hex or base58 token whose derived public key is one of the fixture's own public keys —
each shape has a planted-leak test) additionally pins this for the three committed directories
on every `npm test` run. `refunded-b` contains no NEAR bytes at all (the Buyer never locked leg
A), so it carries no chain evidence of its own.

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
evidence file format changed, so no fixture was recaptured. Round 2 of the review (V3-V8, P5-NEAR-FIXES-R2.md) removed the shared-swapId evidence blanking, kept only genuine accepts for candidates and evidence keys, paired leg B with leg A's accepter, made a refund frame insufficient for chain legs, and keyed the watcher, bundle and audit-export by pair; all first-party.

## Reveal latches and signer error text (P5-NEAR-FIXES-R2.md G6, D4)

`src/client/seller.ts` gained `RevealNotPostedError` and the `revealPosted`/`receiptPosted` latches
(the reveal is retried up to three times and a failure is a distinct error rather than a silent
skip, and a retry of `claimLegA` posts only the frame still missing); `fromNearSecretKey` in
`src/rails/near-signer-memory.ts` no longer puts any character of its input in an error; the
comments at the two `refundedFold` call sites in `src/swap.ts` now describe the V4 rule. All
first-party, covered by `tests/client-flows-near-rpc.test.ts` and `tests/near-signer-memory.test.ts`.
