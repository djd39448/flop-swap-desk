#!/usr/bin/env bash
# NB1 keyless smoke test — mirrors tests-near/probe/nb0-probe.sh's step 4 (deploy via
# sandbox_patch_state + a view call) for both contracts-near wasms, run against a fresh
# throwaway sandbox that is torn down at the end. No keys are used or generated (D-N2's
# keyless-stages rule: this stage builds only the contracts and their keyless checks).
#
# Run from Windows Git Bash as:
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/<this-worktree>/contracts-near/smoke-test.sh'"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORKSPACE_DIR="$SCRIPT_DIR"
export CARGO_TARGET_DIR="$(bash "$SCRIPT_DIR/../scripts/cargo-target-dir.sh" near)"
SANDBOX_BIN="$HOME/.near-sandbox/2.13.4/Linux-x86_64/near-sandbox"
SANDBOX_HOME=/tmp/nb1-smoke-home
PORT=3131

SANDBOX_PID=""
cleanup() {
  # F7: kill only the sandbox process this script started, by pid -- not every near-sandbox
  # on the machine. These worktrees are shared by concurrent builders/sessions (D-N2, D-N12);
  # `pkill -x near-sandbox` matched every near-sandbox by exact process name (comm), so
  # another builder's NB-int run in the same WSL instance would have its sandbox killed
  # mid-suite by this script's cleanup. Fall back to the old exact-name pkill only if the pid
  # was never captured (e.g. the script failed before starting the sandbox).
  if [ -n "$SANDBOX_PID" ]; then
    kill "$SANDBOX_PID" >/dev/null 2>&1 || true
    wait "$SANDBOX_PID" 2>/dev/null || true
  fi
  rm -rf "$SANDBOX_HOME"
}
trap cleanup EXIT

echo "== build release wasms =="
source "$HOME/.cargo/env"
cd "$WORKSPACE_DIR"
cargo build --release --target wasm32-unknown-unknown -p htlc -p mock-ft
HTLC_WASM="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/htlc.wasm"
FT_WASM="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/mock_ft.wasm"
for f in "$HTLC_WASM" "$FT_WASM"; do
  echo "$f: $(stat -c%s "$f") bytes, sha256 $(sha256sum "$f" | awk '{print $1}')"
done

echo "== start throwaway sandbox =="
rm -rf "$SANDBOX_HOME"
"$SANDBOX_BIN" --home "$SANDBOX_HOME" init >/dev/null 2>&1
python3 - "$SANDBOX_HOME/config.json" "$PORT" <<'PYEOF'
import json, sys
path, port = sys.argv[1], sys.argv[2]
with open(path) as f:
    cfg = json.load(f)
cfg["rpc"]["addr"] = f"127.0.0.1:{port}"
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF
nohup "$SANDBOX_BIN" --home "$SANDBOX_HOME" run > "$SANDBOX_HOME/run.log" 2>&1 &
SANDBOX_PID=$!
disown
for i in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/" \
      -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":"smoke","method":"status","params":[]}' 2>/dev/null | grep -q 200; then
    echo "RPC ready after ${i}s on 127.0.0.1:$PORT"
    break
  fi
  sleep 1
done

echo "== keyless deploy (sandbox_patch_state) + view calls =="
python3 - "$HTLC_WASM" "$FT_WASM" "$PORT" <<'PYEOF'
import json, hashlib, base64, sys, time, urllib.request

htlc_wasm_path, ft_wasm_path, port = sys.argv[1], sys.argv[2], sys.argv[3]
url = f"http://127.0.0.1:{port}/"
HTLC_ACCOUNT = "htlc.smoke.near"
FT_ACCOUNT = "ft.smoke.near"

def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "smoke", "method": method, "params": params}).encode()
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

def account_record(account_id, wasm, storage_kv_hex):
    code_hash_b58 = b58encode(hashlib.sha256(wasm).digest())
    storage_usage = len(wasm) + len(account_id) + 200
    # A patched-in contract still needs every storage key a real `new()` call would have
    # written populated — not just "STATE" (near-sdk-5.29.1/src/state.rs's
    # ContractState::state_key()), which is all `#[init]` itself writes, but also whatever
    # near-sdk's own collections (LookupMap/LazyOption here) wrote as a side effect of
    # constructing them, or every exported method hits PanicOnDefault's "The contract is not
    # initialized" panic (near-sdk-5-facts-2026-09-29.md section 1) or a trap reading a
    # missing collection entry. No keys exist yet at this stage (D-N2), so instead of calling
    # `new()` as a real transaction, this script writes Data records for the exact
    # (key, value) pairs a `new()` call leaves in storage, dumped natively (off-chain, not on
    # wasm) via `near_sdk::mock::with_mocked_blockchain(|b| b.take_storage())` after calling
    # `new()` under `testing_env!` — see the (removed) `_smoke_state_dump::dump_storage`
    # ignored test this script's constants were captured from.
    records = [
        {"Account": {"account_id": account_id, "account": {
            "amount": "100000000000000000000000000",
            "locked": "0",
            "code_hash": code_hash_b58,
            "storage_usage": storage_usage,
        }}},
        {"Contract": {"account_id": account_id, "code": base64.b64encode(wasm).decode()}},
    ]
    for key_hex, value_hex in storage_kv_hex:
        records.append({"Data": {
            "account_id": account_id,
            "data_key": base64.b64encode(bytes.fromhex(key_hex)).decode(),
            "value": base64.b64encode(bytes.fromhex(value_hex)).decode(),
        }})
    return records

with open(htlc_wasm_path, "rb") as f:
    htlc_wasm = f.read()
with open(ft_wasm_path, "rb") as f:
    ft_wasm = f.read()

# (storage key hex, storage value hex) pairs left behind by
# `htlc::Contract::new(FT_ACCOUNT)` / `mock_ft::Contract::new(accounts(0))` respectively (see
# the comment above). NB1 fix F3 added a `usdc_token: AccountId` field to htlc::Contract
# (borsh: the LookupMap's prefix bytes, unchanged, followed by the AccountId as a borsh
# string -- 4-byte LE length + utf8 bytes); computed below rather than hand-typed so a hex
# mistake can't silently produce a differently-shaped-but-still-valid STATE value.
def _borsh_string(s: str) -> bytes:
    b = s.encode("utf-8")
    return len(b).to_bytes(4, "little") + b

_htlc_state = bytes.fromhex("010000006c") + _borsh_string(FT_ACCOUNT)
HTLC_STORAGE_KV = [
    ("5354415445", _htlc_state.hex()),  # "STATE" -> borsh(Contract { locks, usdc_token })
]
FT_STORAGE_KV = [
    # FungibleToken::new(b"a") + internal_register_account(owner) -> owner's zero balance.
    ("6105000000616c696365", "00000000000000000000000000000000"),
    # LazyOption::new(b"m", Some(&metadata)) -> the metadata value itself.
    ("6d", "0800000066742d312e302e300d0000004d6f636b2055534420436f696e040000005553444300000006"),
    # "STATE" -> borsh(Contract { owner_id, token, metadata }).
    ("5354415445", "05000000616c696365010000006100000000000000000000000000000000"
        "7d00000000000000010000006d"),
]

records = account_record(HTLC_ACCOUNT, htlc_wasm, HTLC_STORAGE_KV) + account_record(
    FT_ACCOUNT, ft_wasm, FT_STORAGE_KV
)
patch_result = rpc("sandbox_patch_state", {"records": records})
print("patch_state result:", json.dumps(patch_result))
assert "error" not in patch_result, f"patch_state failed: {patch_result}"
time.sleep(3)

def call_view(account_id, method_name, args: dict):
    query_result = rpc("query", {
        "request_type": "call_function",
        "finality": "final",
        "account_id": account_id,
        "method_name": method_name,
        "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
    })
    if "error" in query_result:
        raise AssertionError(f"{account_id}.{method_name} query error: {json.dumps(query_result)}")
    result_bytes = bytes(query_result["result"]["result"])
    return json.loads(result_bytes.decode("utf-8"))

# get_lock on a (hash, payer) pair that was never locked -> None (JSON null).
never_locked_hash = "0" * 64
lock = call_view(HTLC_ACCOUNT, "get_lock", {"hash_lock": never_locked_hash, "payer": "nobody.smoke.near"})
print("get_lock(never-locked hash) decoded:", lock)
assert lock is None, f"expected null, got {lock!r}"

metadata = call_view(FT_ACCOUNT, "ft_metadata", {})
print("ft_metadata() decoded:", metadata)
assert metadata["symbol"] == "USDC", f"expected symbol USDC, got {metadata!r}"
assert metadata["decimals"] == 6, f"expected 6 decimals, got {metadata!r}"

print("SUCCESS: both wasms accepted and executed on protocol 86 (get_lock -> null, ft_metadata -> USDC/6)")
PYEOF

echo "== done =="
