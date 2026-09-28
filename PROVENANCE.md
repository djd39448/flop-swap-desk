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
  pin, mainnet deny list, write evidence (§2.2).
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

## Settlement-view vocabulary — pinned to tclk PR #173

`none | unverified | unfunded | funded | claimed | refunded` (per-leg `SwapView.settlementView`,
`src/swap.ts`) is the settlement-view vocabulary proposed in `flop-labs/tclk` PR #173 at commit
`0f94269`. Cited here, not vendored: nothing from that PR's diff is copied into this repo, only
the naming convention is adopted, because this repo needs to say what it believes about money
independently of tclk's own choreography status (H3, tclk#180/#181). Vendored tclk (git submodule,
`vendor/tclk`) is pinned at `5cc4ab9` and does not contain PR #173 — it is unmerged upstream. If
`flop-labs/tclk#172` changes the vocabulary before PR #173 merges, this line — and the mapping in
`src/swap.ts`'s `RAIL_STATUS_TO_SETTLEMENT_VIEW` — moves with it.
