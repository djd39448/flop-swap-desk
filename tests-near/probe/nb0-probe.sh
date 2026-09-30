#!/bin/bash
# NB0 probe — spec handoff/P5-NEAR-SPEC.md section 2.
#
# Keyless check that near-sandbox 2.13.4 (protocol 86) accepts a wasm built
# by Rust 1.98.1 for wasm32-unknown-unknown, using near-sdk 5.29.1.
#
# Run from WSL (Ubuntu). From Git Bash on Windows, invoke it as a script
# file rather than inlining commands after `bash -lc '...'`: this sandbox's
# Bash tool was found to silently drop `$VAR` expansions that appear inside
# a single-quoted argument forwarded to `wsl.exe` (see README "Environment
# gotcha"), so commands with `$` must live in a file, not the outer command
# string:
#
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/<this-worktree>/tests-near/probe/nb0-probe.sh'"
#
# Steps performed (spec §2 items 1-5, plus cleanup = item 7):
#   1. Build the probe contract (release, wasm32-unknown-unknown).
#   2. Start a throwaway sandbox home, wait for RPC.
#   3. Read `status`; init a second throwaway home and compare genesis hash.
#   4. Deploy the wasm via `sandbox_patch_state` (Account + Contract records)
#      and call `ping` through `query` call_function; verify it decodes to "pong".
#   5. Measure block cadence and the optimistic/final lag over ~20s.
#   7. Kill the sandbox and delete both throwaway homes.
#
# Never prints or writes validator_key.json / node_key.json contents —
# only which files exist and the account id they belong to (see README).

set -euo pipefail

PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CONTRACT_DIR="$PROBE_DIR/contract"
export CARGO_TARGET_DIR="$(bash "$PROBE_DIR/../../scripts/cargo-target-dir.sh" near)"
SANDBOX_BIN="$HOME/.near-sandbox/2.13.4/Linux-x86_64/near-sandbox"
HOME1=/tmp/nb0-home
HOME2=/tmp/nb0-home2
PORT=3031

cleanup() {
  # -x matches the exact process name (comm), not the full cmdline: a -f
  # match here would also hit this very wrapper script, since its own
  # argv contains this same path/pattern text (self-match footgun).
  pkill -x near-sandbox >/dev/null 2>&1 || true
  rm -rf "$HOME1" "$HOME2"
}
trap cleanup EXIT

echo "== step 1: build =="
source ~/.cargo/env
cd "$CONTRACT_DIR"
cargo build --release --target wasm32-unknown-unknown
WASM="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/nb0_probe.wasm"
WASM_SIZE=$(stat -c%s "$WASM")
WASM_SHA256=$(sha256sum "$WASM" | awk '{print $1}')
echo "wasm size: $WASM_SIZE bytes"
echo "wasm sha256: $WASM_SHA256"

echo "== step 2: start sandbox =="
rm -rf "$HOME1"
"$SANDBOX_BIN" --home "$HOME1" init >/dev/null 2>&1
python3 - "$HOME1/config.json" "$PORT" <<'PYEOF'
import json, sys
path, port = sys.argv[1], sys.argv[2]
with open(path) as f:
    cfg = json.load(f)
cfg["rpc"]["addr"] = f"127.0.0.1:{port}"
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF
nohup "$SANDBOX_BIN" --home "$HOME1" run > "$HOME1/run.log" 2>&1 &
disown
for i in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":"probe","method":"status","params":[]}' 2>/dev/null | grep -q 200; then
    echo "RPC ready after ${i}s on 127.0.0.1:$PORT"
    break
  fi
  sleep 1
done

echo "== step 3: status + second init (genesis hash comparison) =="
python3 - "$PORT" <<'PYEOF'
import json, urllib.request, sys
port = sys.argv[1]
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/",
    data=json.dumps({"jsonrpc": "2.0", "id": "probe", "method": "status", "params": []}).encode(),
    headers={"Content-Type": "application/json"},
)
r = json.loads(urllib.request.urlopen(req, timeout=5).read())["result"]
print("chain_id:", r["chain_id"])
print("genesis_hash:", r["sync_info"]["earliest_block_hash"])
print("protocol_version:", r["protocol_version"])
print("latest_protocol_version:", r["latest_protocol_version"])
print("validator_account_id:", r["validator_account_id"])
PYEOF
rm -rf "$HOME2"
"$SANDBOX_BIN" --home "$HOME2" init >/dev/null 2>&1
python3 -c "import json; print('second init chain_id:', json.load(open('$HOME2/genesis.json'))['chain_id'])"
rm -rf "$HOME2"

echo "== step 4: keyless deploy via sandbox_patch_state + view call =="
ACCOUNT="probe.test.near"
python3 - "$WASM" "$ACCOUNT" "$PORT" <<'PYEOF'
import json, hashlib, base64, sys, time, urllib.request

wasm_path, account_id, port = sys.argv[1], sys.argv[2], sys.argv[3]
url = f"http://127.0.0.1:{port}/"

def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "probe", "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    s = ""
    while n > 0:
        n, r = divmod(n, 58)
        s = ALPHABET[r] + s
    pad = 0
    for byte in b:
        if byte == 0:
            pad += 1
        else:
            break
    return "1" * pad + s

with open(wasm_path, "rb") as f:
    wasm = f.read()

code_hash_b58 = b58encode(hashlib.sha256(wasm).digest())
storage_usage = len(wasm) + len(account_id) + 200

records = [
    {"Account": {"account_id": account_id, "account": {
        "amount": "100000000000000000000000000",
        "locked": "0",
        "code_hash": code_hash_b58,
        "storage_usage": storage_usage,
    }}},
    {"Contract": {"account_id": account_id, "code": base64.b64encode(wasm).decode()}},
]
patch_result = rpc("sandbox_patch_state", {"records": records})
print("patch_state result:", json.dumps(patch_result))
time.sleep(3)

query_result = rpc("query", {
    "request_type": "call_function",
    "finality": "final",
    "account_id": account_id,
    "method_name": "ping",
    "args_base64": base64.b64encode(b"{}").decode(),
})
result_bytes = bytes(query_result["result"]["result"])
decoded = json.loads(result_bytes.decode("utf-8"))
print("ping() decoded:", decoded)
assert decoded == "pong", f"expected 'pong', got {decoded!r}"
print("SUCCESS: VM accepted the wasm and executed ping()")
PYEOF

echo "== step 5: block cadence + final/optimistic lag (~20s) =="
python3 - "$PORT" <<'PYEOF'
import json, time, urllib.request, sys
port = sys.argv[1]
url = f"http://127.0.0.1:{port}/"

def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "probe", "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())

def height(finality):
    return rpc("block", {"finality": finality})["result"]["header"]["height"]

samples = []
t0 = time.time()
while time.time() - t0 < 20:
    h_opt, h_final = height("optimistic"), height("final")
    samples.append((time.time() - t0, h_opt, h_final))
    time.sleep(1)

first_h, last_h = samples[0][1], samples[-1][1]
elapsed = samples[-1][0] - samples[0][0]
blocks = last_h - first_h
cadence_ms = (elapsed / blocks * 1000) if blocks else float("nan")
lags = [o - f for _, o, f in samples]
print(f"blocks produced: {blocks} in {elapsed:.1f}s -> ~{cadence_ms:.0f} ms/block")
print(f"final-vs-optimistic lag (blocks): min={min(lags)} max={max(lags)} last={lags[-1]}")
PYEOF

echo "== done =="
