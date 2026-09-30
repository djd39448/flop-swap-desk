# NB0 probe — near-sandbox wasm compatibility (keyless)

Spec: `handoff/P5-NEAR-SPEC.md` section 2 (Stage NB0). Run 2026-09-29 in WSL Ubuntu
(Rust 1.98.1, near-sandbox 2.13.4 / protocol 86, near-sdk 5.29.1). Reproduces with
`nb0-probe.sh`.

## Result: PASS

The wasm built by Rust 1.98.1 for `wasm32-unknown-unknown` was accepted by the
near-sandbox VM on protocol 86 with **no special flags** — no `RUSTFLAGS="-C
target-cpu=mvp"` and no `cargo-near` fallback were needed. Deployed keylessly via
`sandbox_patch_state`, the contract's `ping()` view method ran and returned `"pong"`.

## 1. Contract build

- Contract: `tests-near/probe/contract` (`near-sdk = "=5.29.1"`, `ping()` view method
  returning `"pong"` on default state). Compiled as-is; no changes needed.
- Command: `CARGO_TARGET_DIR=$HOME/.cache/flop-near-target cargo build --release
  --target wasm32-unknown-unknown` (WSL-native target dir, not the C: worktree).
- Build time: ~6s cold (proc-macro-heavy dependency tree: `syn`, `near-sdk-macros`,
  `borsh-derive`, etc.), <0.1s warm/no-op.
- Output: `nb0_probe.wasm`
  - size: **139295 bytes**
  - sha256: **`c63b7d1926b3b494e086ea016702320edfafb2635e1a8c895000b75c176b27de`**

## 2. Sandbox start / Windows reachability

- `near-sandbox --home <tmp> init`, then the generated `config.json`'s `rpc.addr` was
  rewritten to `127.0.0.1:<port>` (script: pick a free port; used 3031 here), then
  `near-sandbox --home <tmp> run` backgrounded with `nohup ... &`.
- RPC came up in **~2 seconds**.
- Windows reachability: **yes** — plain `curl` from Git Bash on the Windows side
  (not WSL) reached `http://127.0.0.1:<port>/` and got a normal JSON-RPC `status`
  response, confirming WSL2's automatic localhost forwarding works for this sandbox.

## 3. `status` / genesis hash per `init`

Example `status` response (one run):

| field | value |
|---|---|
| `chain_id` | `test-chain-W1u9t` (random per init) |
| `genesis_hash` | `Hu841pagaTKPhot878cBNd1VRrk5UKsHgYXnyoY5HYau` |
| `protocol_version` | 86 |
| `latest_protocol_version` | 86 |
| `validator_account_id` | `test.near` |

**Genesis hash changes on every `init`** (confirmed by initializing a second
throwaway home: it got a different `chain_id`/genesis, e.g. `test-chain-WwaHc` vs.
`test-chain-W1u9t` in the same run). Each throwaway sandbox home is a fresh, unrelated
chain — fixtures/tests must not hardcode a genesis hash across runs.

## 4. Keyless deploy via `sandbox_patch_state` — the record shape that worked

Two records in one `sandbox_patch_state` call: an `Account` record (to own the
contract, funded and with `code_hash` set) and a `Contract` record (the wasm itself).
This matches the `near_primitives::state_record::StateRecord` enum's JSON tagging
(external tag: `{"Account": {...}}` / `{"Contract": {...}}`) as consumed by
near-workspaces.

```json
{
  "records": [
    {
      "Account": {
        "account_id": "probe.test.near",
        "account": {
          "amount": "100000000000000000000000000",
          "locked": "0",
          "code_hash": "<base58 of sha256(wasm)>",
          "storage_usage": 139716
        }
      }
    },
    {
      "Contract": {
        "account_id": "probe.test.near",
        "code": "<base64 of the wasm bytes>"
      }
    }
  ]
}
```

Notes:
- `code_hash` **must** be the base58 (Bitcoin alphabet, near's `CryptoHash` codec) of
  the raw 32-byte sha256 digest of the wasm — not hex, not base64. The RPC's parse
  error for a malformed hash is explicit: `"Failed parsing args: invalid length NN,
  expected base58-encoded 256-bit hash"` (HTTP 400, JSON-RPC `code: -32700`).
  - Debugging note kept for the record: a hand-rolled base58 encoder that counts
    leading zero bytes wrong (counting *all* zero bytes in the digest instead of only
    the *leading run* of zero bytes) will occasionally prepend a spurious extra `"1"`
    and produce exactly this error, only on digests that happen to contain a `0x00`
    byte somewhere past the first position. It reproduced/failed nondeterministically
    across sandbox runs (same wasm, same digest, bug is deterministic per-digest, but
    it silently passed for the handful of digests tried first — worth flagging as an
    easy-to-miss bug for the real adapter code in §4 of the spec, which will need a
    correct base58 codec, e.g. from `near-api-js`/`bs58`, not a reimplementation).
- `storage_usage` on the `Account` record was set to `len(wasm) + len(account_id) +
  200` (a generous approximation); patch_state did not validate it strictly for this
  probe's purposes (a view call doesn't touch storage rent).
- `amount` was set high (100 NEAR-equivalent yocto) purely so the account is
  well-funded; `sandbox_patch_state` bypasses normal balance/fee mechanics entirely
  (that's the point of the keyless stage — see spec §1).
- Attempting `sandbox_patch_state` **immediately** after the RPC first answers
  `status` (i.e., within ~1-2s of the process starting, before/around block height 3)
  worked fine in every run — no readiness race was observed once `status` itself
  returned 200.

## 5. View call

```json
{
  "request_type": "call_function",
  "finality": "final",
  "account_id": "probe.test.near",
  "method_name": "ping",
  "args_base64": "e30="
}
```

`query`'s `result.result` is a byte array; decoding it as UTF-8 and JSON-parsing gives
the string `"pong"` — confirms the deployed wasm actually executes on protocol 86 (not
just that the bytes were accepted for storage).

## 6. Block cadence / finality lag

Sampled block height at `optimistic` and `final` finality once a second for ~20s:

- **Cadence: ~610-710 ms/block** (varied slightly run to run; two runs measured
  ~614 ms/block and ~706 ms/block over ~19-20s / ~28-31 blocks).
- **`final` trails `optimistic` by a constant 2 blocks** in every sample across every
  run (`min=max=last=2`). At ~0.6-0.7s/block that's roughly **1.2-1.5s of finality
  lag** — relevant for the swap desk's `finalityAMs` policy constant (spec §4 lists
  10 min for NEAR_LOCAL_POLICY, which is dominated by the rail's own safety margin,
  not sandbox block time).

## 7. Sandbox home contents (no key material read or printed)

A throwaway home directory (`near-sandbox --home <dir> init` then `run`) contains:

- `config.json`, `genesis.json` — not secret, inspected freely.
- `validator_key.json`, `node_key.json` — **never opened**; only their presence and
  file mode (`0600`, owner-only) were checked with `ls -la`.
- `data/` — the RocksDB chain state.
- `run.log` — the node's stdout/stderr (redirected there by the probe script).

The validator/node key files both belong to account id **`test.near`** (visible in
the node's own startup log line `using key for account ... account_id=test.near` and
in `status`'s `validator_account_id` field — never from reading the key files
themselves).

## 8. Cleanup

Both throwaway homes (`/tmp/nb0-home`, `/tmp/nb0-home2`) and the sandbox process were
removed/killed at the end of every run; `nb0-probe.sh` does this from a `trap ...
EXIT` so it also fires on failure.

## Environment gotcha (worth flagging for later NEAR stages)

This machine's sandboxed Bash tool **silently drops `$VAR` expansions** that appear
inside a *single-quoted* argument forwarded through to `wsl.exe`. For example:

```
wsl -d Ubuntu -- bash -lc 'A=5; echo $A'     # prints "" (empty), not "5"
wsl -d Ubuntu -- bash -lc "bash '/path/to/script.sh'"   # works: $ inside the file is untouched
```

Confirmed with `bash -lc 'A=5; echo "A is [$A]"'` → `A is []`, even though `echo
"HOME is [$HOME]"` alone (no assignment) also came back empty in the same style of
invocation — the entire word containing the `$`-expansion is dropped, not just the
variable name. This reproduced consistently across many invocations in this session
and is **not** what the spec's literal `bash -lc '<commands>'` recipe assumes.

**Workaround used throughout this probe and in `nb0-probe.sh`:** put every command
that uses `$` in an actual `.sh` file (written with the Write/Edit tool, which is not
subject to this stripping) under the worktree, and invoke it from Git Bash as:

```
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/<this-worktree>/tests-near/probe/nb0-probe.sh'"
```

(double-quoted outer command, containing only a literal path — no bare `$` for the
stripping layer to touch). This should carry forward into stage NB-int's
`tests-near/helpers/sandbox.ts`/test-runner invocations from Windows: don't inline
shell logic with `$VAR` into a single-quoted `wsl bash -lc '...'` string; write a
script file and call it by path instead.

Separately: `pkill -f <pattern>`/`pgrep -f <pattern>` run via `wsl -d Ubuntu -- bash
-lc "..."` can **match their own wrapping `bash -lc` process**, because that
process's argv literally contains the pattern text (the whole command string was
passed as one argument). `nb0-probe.sh`'s cleanup uses `pkill -x near-sandbox`
(exact process-name match, i.e. `comm`, not full cmdline) to avoid this.

## Commands (see `nb0-probe.sh` for the full reproducible script)

```bash
# from Git Bash, always as a script file (see gotcha above):
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash -lc "bash '/mnt/c/Users/trustcore-rdp/<this-worktree>/tests-near/probe/nb0-probe.sh'"
```
