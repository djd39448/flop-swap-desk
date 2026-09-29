#!/usr/bin/env bash
# Builds and tests the contracts-near Cargo workspace inside WSL.
# Run from Windows Git Bash as:
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/flop-swap-desk-near/contracts-near/build.sh'"
# (never inline $VAR-bearing shell logic straight into `wsl bash -lc '...'` — see
# tests-near/probe/README.md's "Environment gotcha" section; this file exists so that
# gotcha never applies here.)
set -euo pipefail

source "$HOME/.cargo/env"

export CARGO_TARGET_DIR="$HOME/.cache/flop-near-target"
WORKSPACE_DIR="/mnt/c/Users/trustcore-rdp/flop-swap-desk-near/contracts-near"

cd "$WORKSPACE_DIR"

echo "=== cargo test --workspace ==="
cargo test --workspace

echo
echo "=== cargo build --release --target wasm32-unknown-unknown (htlc) ==="
cargo build --release --target wasm32-unknown-unknown -p htlc

echo
echo "=== cargo build --release --target wasm32-unknown-unknown (mock-ft) ==="
cargo build --release --target wasm32-unknown-unknown -p mock-ft

HTLC_WASM="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/htlc.wasm"
FT_WASM="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/mock_ft.wasm"

echo
echo "=== wasm artifacts ==="
for f in "$HTLC_WASM" "$FT_WASM"; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f" >&2
    exit 1
  fi
  size=$(stat -c%s "$f")
  sha=$(sha256sum "$f" | cut -d' ' -f1)
  echo "$f"
  echo "  size: $size bytes"
  echo "  sha256: $sha"
done
