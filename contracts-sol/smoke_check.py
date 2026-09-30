#!/usr/bin/env python3
"""Keyless read-only checks against a solana-test-validator that loaded htlc.so at genesis.

usage: smoke_check.py <rpc-port> <path-to-htlc.so>

No key is generated, loaded or read. Everything is a public RPC read plus one simulateTransaction
with an all-zero signature (sigVerify false) whose fee payer is a public address.
"""
import base64
import hashlib
import json
import sys
import time
import urllib.request

PROGRAM_ID = "GedsjashYAxaoETcwBZQR1YgBbuEaK8QiiKu2qi6xe6C"
LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + ALPHABET.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + raw


def b58encode(b):
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + out


def rpc(port, method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}", body, {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(f"{method}: {out['error']}")
    return out["result"]


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


def main():
    port, so_path = int(sys.argv[1]), sys.argv[2]
    so = open(so_path, "rb").read()
    so_sha = hashlib.sha256(so).hexdigest()

    check(b58encode(hashlib.sha256(b"flop-swap-desk:sol-htlc:v1").digest()) == PROGRAM_ID,
          "program id == base58(sha256('flop-swap-desk:sol-htlc:v1'))")

    for _ in range(120):
        try:
            if rpc(port, "getHealth") == "ok":
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        check(False, "validator healthy within 120 s")
    print("INFO version", rpc(port, "getVersion")["solana-core"])

    acct = rpc(port, "getAccountInfo", [PROGRAM_ID, {"encoding": "base64", "commitment": "confirmed"}])["value"]
    check(acct is not None, "program account exists")
    check(acct["executable"] is True, "program account executable")
    check(acct["owner"] == LOADER, "program account owned by the upgradeable loader")
    data = base64.b64decode(acct["data"][0])
    check(len(data) == 36 and int.from_bytes(data[:4], "little") == 2, "program account = Program{programdata_address}")
    pd_addr = b58encode(data[4:36])
    print("INFO programdata address", pd_addr)

    pd = rpc(port, "getAccountInfo", [pd_addr, {"encoding": "base64", "commitment": "confirmed"}])["value"]
    check(pd is not None and pd["owner"] == LOADER, "programdata account exists, owned by the loader")
    pdd = base64.b64decode(pd["data"][0])
    check(int.from_bytes(pdd[:4], "little") == 3, "programdata account discriminant")
    if pdd[12] == 0:
        print("PASS programdata upgrade authority is None (immutable)")
    else:
        authority = pdd[13:45]
        print("INFO upgrade authority is SET to", b58encode(authority))
        check(authority == bytes(32),
              "programdata upgrade authority is the all-zero address (System Program id: no key can sign for it)")
    elf = pdd[45:45 + len(so)]
    check(hashlib.sha256(elf).hexdigest() == so_sha, f"programdata sha256 == built .so sha256 ({so_sha})")
    check(all(b == 0 for b in pdd[45 + len(so):]), "programdata has only zero padding after the ELF")

    # The program answers under its fixed id: a keyless simulation with an unknown tag must fail
    # with the program's own InvalidInstruction (Custom(1)). Fee payer = a public funded address.
    largest = rpc(port, "getLargestAccounts")["value"][0]["address"]
    payer = b58decode(largest)
    prog = b58decode(PROGRAM_ID)
    msg = bytes([1, 0, 1]) + bytes([2]) + payer + prog + bytes(32) + bytes([1]) + bytes([1, 0, 1, 9])
    tx = bytes([1]) + bytes(64) + msg
    sim = None
    for _ in range(30):  # a freshly booted validator can need a few slots before the program is visible
        sim = rpc(port, "simulateTransaction",
                  [base64.b64encode(tx).decode(), {"encoding": "base64", "sigVerify": False, "replaceRecentBlockhash": True}])["value"]
        if sim["err"] != {"InstructionError": [0, "UnsupportedProgramId"]}:
            break
        time.sleep(1)
    check(sim["err"] == {"InstructionError": [0, {"Custom": 1}]},
          f"program runs under its fixed id (simulation returned {sim['err']})")
    print("ALL SMOKE CHECKS PASSED")


main()
