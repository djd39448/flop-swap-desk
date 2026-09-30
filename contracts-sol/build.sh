#!/usr/bin/env bash
# Builds the htlc program with cargo-build-sbf and runs all tests inside WSL.
# Run from Windows Git Bash as:
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/<this-worktree>/contracts-sol/build.sh'"
# Optional: FLOP_SOL_USDC_MINT=<base58 mint> selects the USDC mint compiled into the program
# (default: the keyless localnet mock mint, see README.md). NOTE: the litesvm tests assume the default.
set -euo pipefail

source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/agave/v4.3.0/bin:$PATH"
# Paths come from this script's own location; the target directory is unique per worktree
# (scripts/cargo-target-dir.sh hashes the worktree path) so two worktrees never overwrite each other's .so.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export CARGO_TARGET_DIR="$(bash "$DIR/../scripts/cargo-target-dir.sh" sol)"
cd "$DIR"

echo "=== cargo test (host unit tests, htlc) ==="
cargo test --locked -p htlc

echo
echo "=== cargo-build-sbf (htlc) ==="
cargo-build-sbf --manifest-path "$DIR/htlc/Cargo.toml" --sbf-out-dir "$CARGO_TARGET_DIR/deploy"

# cargo-build-sbf writes a program keypair next to the .so on every build: delete it unread.
rm -f "$CARGO_TARGET_DIR"/deploy/*-keypair.json

SO="$CARGO_TARGET_DIR/deploy/htlc.so"
if [ ! -f "$SO" ]; then
  echo "MISSING: $SO" >&2
  exit 1
fi

echo
echo "=== litesvm tests against the built .so ==="
( cd "$DIR/htlc-tests" && HTLC_SO="$SO" cargo test --locked )

echo
echo "=== artifact ==="
echo "$SO"
echo "  size: $(stat -c%s "$SO") bytes"
echo "  sha256: $(sha256sum "$SO" | cut -d' ' -f1)"
ls "$CARGO_TARGET_DIR"/deploy/
