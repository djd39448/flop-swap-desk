#!/usr/bin/env bash
# Keyless genesis smoke for the built htlc.so (run build.sh first). Runs inside ONE wsl.exe call that
# stays alive for the whole run (a validator started with & dies when the hosting wsl.exe call
# returns, so this script keeps the call open until it has finished). Run from Windows Git Bash as:
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/flop-swap-desk-sol/contracts-sol/smoke.sh'"
# A NEAR sandbox from another process may share this WSL instance: we only ever kill our own pid.
# No key is generated or read: the validator's own ledger key files are never opened.
set -euo pipefail

export PATH="$HOME/.local/share/agave/v4.3.0/bin:$PATH"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SO="${HTLC_SO:-$(bash "$DIR/../scripts/cargo-target-dir.sh" sol)/deploy/htlc.so}"
PROGRAM_ID="GedsjashYAxaoETcwBZQR1YgBbuEaK8QiiKu2qi6xe6C"   # base58(sha256("flop-swap-desk:sol-htlc:v1"))

[ -f "$SO" ] || { echo "MISSING $SO (run build.sh first)" >&2; exit 1; }

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
RPC_PORT="$(free_port)"
FAUCET_PORT="$(free_port)"
GOSSIP_PORT="$(free_port)"
LEDGER="/tmp/flop-sol-smoke-ledger-$$"
LOG="/tmp/flop-sol-smoke-$$.log"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
  fi
  rm -rf "$LEDGER" "$LOG"
}
trap cleanup EXIT

# --upgradeable-program ... none is the immutable form. (Plain --bpf-program gave the identical
# on-chain result in SB1: the validator stores "no authority" as the all-zero address either way.)
LOAD_ARGS="--upgradeable-program $PROGRAM_ID $SO none"

echo "loader args: $LOAD_ARGS"
echo "starting solana-test-validator (rpc $RPC_PORT, faucet $FAUCET_PORT, gossip $GOSSIP_PORT)"
solana-test-validator --ledger "$LEDGER" --reset --quiet \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" --gossip-port "$GOSSIP_PORT" \
  $LOAD_ARGS >"$LOG" 2>&1 &
PID=$!
echo "validator pid $PID"

python3 "$DIR/smoke_check.py" "$RPC_PORT" "$SO"
RC=$?
echo "smoke rc=$RC"
exit "$RC"
