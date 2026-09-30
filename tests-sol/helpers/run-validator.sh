#!/usr/bin/env bash
# Starts ONE solana-test-validator in the foreground (exec), for tests-sol/helpers/validator.ts.
# The Node helper runs this inside a wsl.exe call that stays attached for the validator's whole life
# (a nohup/& child of wsl.exe dies when wsl.exe returns, sol-probe README gotcha 1). The script records
# its own pid (the exec keeps it the validator's pid) so the helper can stop exactly this process by pid
# and never by name (a NEAR sandbox from another builder may share this WSL instance).
#
# usage: run-validator.sh <home> <rpc-port> <faucet-port> <gossip-port> <program-id> <program.so> <mint-address> <mint-account.json>
# <home> holds: pid, validator.log, ledger/. No key file of the validator's ledger is ever opened by us.
set -euo pipefail
if [ "$#" -ne 8 ]; then
  echo "usage: run-validator.sh <home> <rpc-port> <faucet-port> <gossip-port> <program-id> <program.so> <mint-address> <mint-account.json>" >&2
  exit 2
fi
HOME_DIR="$1"
RPC_PORT="$2"
FAUCET_PORT="$3"
GOSSIP_PORT="$4"
PROGRAM_ID="$5"
SO="$6"
MINT_ADDRESS="$7"
MINT_JSON="$8"

export PATH="$HOME/.local/share/agave/v4.3.0/bin:$PATH"
command -v solana-test-validator >/dev/null 2>&1 || { echo "solana-test-validator not found (Agave v4.3.0 under ~/.local/share/agave)" >&2; exit 3; }

echo "$$" > "$HOME_DIR/pid"
# --upgradeable-program ... none: the program is loaded immutable (contracts-sol/README.md).
# --account: the mock USDC mint exists at genesis at the program's compiled-in mint address.
exec solana-test-validator --ledger "$HOME_DIR/ledger" --reset --quiet \
  --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" --gossip-port "$GOSSIP_PORT" \
  --upgradeable-program "$PROGRAM_ID" "$SO" none \
  --account "$MINT_ADDRESS" "$MINT_JSON" \
  >"$HOME_DIR/validator.log" 2>&1
