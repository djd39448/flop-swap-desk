# Provenance

## Settlement-view vocabulary — pinned to tclk PR #173

`none | unverified | unfunded | funded | claimed | refunded` (per-leg `SwapView.settlementView`,
`src/swap.ts`) is the settlement-view vocabulary proposed in `flop-labs/tclk` PR #173 at commit
`0f94269`. Cited here, not vendored: nothing from that PR's diff is copied into this repo, only
the naming convention is adopted, because this repo needs to say what it believes about money
independently of tclk's own choreography status (H3, tclk#180/#181). Vendored tclk (git submodule,
`vendor/tclk`) is pinned at `5cc4ab9` and does not contain PR #173 — it is unmerged upstream. If
`flop-labs/tclk#172` changes the vocabulary before PR #173 merges, this line — and the mapping in
`src/swap.ts`'s `RAIL_STATUS_TO_SETTLEMENT_VIEW` — moves with it.
