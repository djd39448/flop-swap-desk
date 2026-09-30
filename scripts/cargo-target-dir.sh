#!/usr/bin/env bash
# Prints the CARGO_TARGET_DIR for one of this worktree's contract builds: a WSL-native directory whose
# name carries a short hash of THIS worktree's own absolute path, so two worktrees of the repository
# (they share one .git but not a build directory) never overwrite each other's wasm/so artifacts.
#
#   bash scripts/cargo-target-dir.sh near   ->  $HOME/.cache/flop-near-target-<8 hex>
#   bash scripts/cargo-target-dir.sh sol    ->  $HOME/.cache/flop-sol-target-<8 hex>
#
# The worktree root is this script's own parent directory (resolved with `pwd -P`), never a hard-coded
# path, so a copy of the tree anywhere gets its own directory. Every build script and every harness that
# needs an artifact path calls THIS script, so they cannot disagree about it. Prints nothing else.
set -euo pipefail

name="${1:-}"
case "$name" in
  near | sol) ;;
  *) echo "usage: cargo-target-dir.sh near|sol" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
hash="$(printf '%s' "$root" | sha256sum | cut -c1-8)"
printf '%s\n' "$HOME/.cache/flop-$name-target-$hash"
