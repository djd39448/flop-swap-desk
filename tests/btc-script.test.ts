// SPDX-License-Identifier: MIT
//
// tests/btc-script.test.ts — P4-BTC-SPEC.md §3, Stage BB1. Pure, hermetic (no node, no
// network): the exact `(hashLock, payeePubkey, payerPubkey, locktime)` and expected witnessScript
// /scriptPubKey/address bytes here are the real values Bitcoin Core 31.1 produced on regtest for
// the same script (handoff/research/btc-regtest-probe-2026-09-28.md Q1 — `decodescript`,
// `deriveaddresses`, and a disposable watch-only wallet's `getaddressinfo`). Reproducing them
// byte-for-byte here is the regression test the probe report promised in place of committing a
// separate probe script.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";

import {
  BIP65_THRESHOLD,
  BTC_REGTEST_NETWORK,
  MAX_LOCKTIME,
  bytesEqual,
  buildClaimPsbt,
  buildHtlcScript,
  buildRefundPsbt,
  locktimeFromRefundAfterMs,
  scriptPubKeyForAddress,
  type FundingUtxo,
} from "../src/rails/btc-script.js";

// Probe Q1's own params (handoff/research/btc-regtest-probe-2026-09-28.md).
const PAYEE_HEX = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a"; // seller
const PAYER_HEX = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627"; // buyer
const H_HEX = "1a7c40b97c2c5579f5fc5a44d73f1cea553f585eb3c99e4fac9b1039aacaa89e";
const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const T = 1_700_000_000;

const EXPECTED_WITNESS_SCRIPT_HEX =
  "210361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318aac64" +
  "210372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627ad0400f15365b167" +
  "82012088a8201a7c40b97c2c5579f5fc5a44d73f1cea553f585eb3c99e4fac9b1039aacaa89e8768";
const EXPECTED_SCRIPT_PUBKEY_HEX = "0020bb8185b42c76af598a5bc0aae77a1b7ea58ed5f4a0944ef36d2cc223730d2ce9";
const EXPECTED_ADDRESS = "bcrt1qhwqctdpvw6h4nzjmcz4ww7sm06jca4055z2yaumd9npzxucd9n5sketrra";

describe("buildHtlcScript", () => {
  it("reproduces Core 31.1's compiled witnessScript, scriptPubKey and address byte for byte (probe Q1)", () => {
    const result = buildHtlcScript({
      hashLock: hexToBytes(H_HEX),
      payeePubkey: hexToBytes(PAYEE_HEX),
      payerPubkey: hexToBytes(PAYER_HEX),
      locktime: T,
    });

    expect(bytesToHex(result.witnessScript)).toBe(EXPECTED_WITNESS_SCRIPT_HEX);
    expect(bytesToHex(result.scriptPubKey)).toBe(EXPECTED_SCRIPT_PUBKEY_HEX);
    expect(result.address).toBe(EXPECTED_ADDRESS);
    expect(result.locktime).toBe(T);
  });

  it("is deterministic: the same inputs always produce the same bytes", () => {
    const params = { hashLock: hexToBytes(H_HEX), payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX), locktime: T };
    const a = buildHtlcScript(params);
    const b = buildHtlcScript(params);
    expect(bytesToHex(a.witnessScript)).toBe(bytesToHex(b.witnessScript));
    expect(a.address).toBe(b.address);
  });

  it("produces a different address for a different locktime, holding keys/hash fixed", () => {
    const base = { hashLock: hexToBytes(H_HEX), payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX) };
    const a = buildHtlcScript({ ...base, locktime: T });
    const b = buildHtlcScript({ ...base, locktime: T + 1 });
    expect(a.address).not.toBe(b.address);
  });

  it("refuses a locktime at or below the BIP65 threshold", () => {
    expect(() =>
      buildHtlcScript({ hashLock: hexToBytes(H_HEX), payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX), locktime: BIP65_THRESHOLD }),
    ).toThrow(/BIP65/);
  });

  it("H7: refuses a locktime above the maximum 32-bit nLockTime value", () => {
    expect(() =>
      buildHtlcScript({ hashLock: hexToBytes(H_HEX), payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX), locktime: MAX_LOCKTIME + 1 }),
    ).toThrow(/at most|32-bit/);
  });

  it("H7: accepts the maximum 32-bit nLockTime value itself", () => {
    expect(() =>
      buildHtlcScript({ hashLock: hexToBytes(H_HEX), payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX), locktime: MAX_LOCKTIME }),
    ).not.toThrow();
  });

  it("refuses a hashLock that is not 32 bytes", () => {
    expect(() =>
      buildHtlcScript({ hashLock: hexToBytes(H_HEX).slice(0, 31), payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX), locktime: T }),
    ).toThrow(/32 bytes/);
  });

  it("refuses a pubkey that is not a 33-byte compressed key", () => {
    expect(() =>
      buildHtlcScript({ hashLock: hexToBytes(H_HEX), payeePubkey: hexToBytes(PAYEE_HEX).slice(0, 32), payerPubkey: hexToBytes(PAYER_HEX), locktime: T }),
    ).toThrow(/compressed public key/);
  });
});

describe("locktimeFromRefundAfterMs", () => {
  it("divides whole seconds and refuses sub-second precision", () => {
    expect(locktimeFromRefundAfterMs(1_700_000_000_000)).toBe(1_700_000_000);
    expect(() => locktimeFromRefundAfterMs(1_700_000_000_500)).toThrow(/whole number of seconds/);
  });

  it("refuses a value at or below the BIP65 threshold", () => {
    expect(() => locktimeFromRefundAfterMs(BIP65_THRESHOLD * 1000)).toThrow(/BIP65/);
    expect(() => locktimeFromRefundAfterMs(1000)).toThrow(/BIP65/);
  });

  it("H7: refuses a value above the maximum 32-bit nLockTime value", () => {
    expect(() => locktimeFromRefundAfterMs((MAX_LOCKTIME + 1) * 1000)).toThrow(/32-bit/);
  });

  it("H7: accepts the maximum 32-bit nLockTime value itself", () => {
    expect(locktimeFromRefundAfterMs(MAX_LOCKTIME * 1000)).toBe(MAX_LOCKTIME);
  });

  it("refuses a non-integer or non-finite input", () => {
    expect(() => locktimeFromRefundAfterMs(1_700_000_000_000.5)).toThrow();
    expect(() => locktimeFromRefundAfterMs(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("scriptPubKeyForAddress", () => {
  it("decodes the probe's own HTLC address back to the identical scriptPubKey", () => {
    expect(bytesToHex(scriptPubKeyForAddress(EXPECTED_ADDRESS, BTC_REGTEST_NETWORK))).toBe(EXPECTED_SCRIPT_PUBKEY_HEX);
  });

  it("refuses an address from the wrong network", () => {
    expect(() => scriptPubKeyForAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", BTC_REGTEST_NETWORK)).toThrow();
  });
});

describe("bytesEqual", () => {
  it("agrees with a naive comparison", () => {
    expect(bytesEqual(hexToBytes(H_HEX), hexToBytes(H_HEX))).toBe(true);
    expect(bytesEqual(hexToBytes(H_HEX), hexToBytes(PREIMAGE_HEX))).toBe(false);
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(1))).toBe(false);
  });
});

describe("buildClaimPsbt / buildRefundPsbt", () => {
  const script = buildHtlcScript({ hashLock: hexToBytes(H_HEX), payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX), locktime: T });
  const utxo: FundingUtxo = {
    txid: "ab08a3ba29a27d8ccbc37fe3efe3f56018e34978328bc421361e688dc8d66694",
    vout: 1,
    scriptPubKey: script.scriptPubKey,
    amountSats: 100_000_000n,
  };
  const destination = scriptPubKeyForAddress(EXPECTED_ADDRESS, BTC_REGTEST_NETWORK);

  it("buildClaimPsbt embeds witness_utxo, witnessScript, bip32_derivation and the BIP174 sha256 preimage field", () => {
    const psbtBytes = buildClaimPsbt({
      utxo,
      witnessScript: script.witnessScript,
      hashLock: hexToBytes(H_HEX),
      preimage: hexToBytes(PREIMAGE_HEX),
      payeePubkey: hexToBytes(PAYEE_HEX),
      payeeDerivation: { fingerprint: 0xb222e7bb, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] },
      destinationScriptPubKey: destination,
      feeSats: 1000n,
    });

    const tx = Transaction.fromPSBT(psbtBytes, { allowUnknownInputs: true, allowUnknownOutputs: true });
    expect(tx.inputsLength).toBe(1);
    const input = tx.getInput(0);
    expect(bytesToHex(input.witnessScript as Uint8Array)).toBe(bytesToHex(script.witnessScript));
    expect(input.sha256?.[0]?.[0] && bytesToHex(input.sha256[0][0])).toBe(H_HEX);
    expect(input.sha256?.[0]?.[1] && bytesToHex(input.sha256[0][1])).toBe(PREIMAGE_HEX);
    expect(input.bip32Derivation?.[0]?.[1].fingerprint).toBe(0xb222e7bb);
    expect(tx.getOutput(0).amount).toBe(100_000_000n - 1000n);
  });

  it("buildRefundPsbt sets the transaction's global lockTime to T and no sha256 field", () => {
    const psbtBytes = buildRefundPsbt({
      utxo,
      witnessScript: script.witnessScript,
      locktime: T,
      payerPubkey: hexToBytes(PAYER_HEX),
      payerDerivation: { fingerprint: 0x2cd95c68, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] },
      destinationScriptPubKey: destination,
      feeSats: 1000n,
    });

    const tx = Transaction.fromPSBT(psbtBytes, { allowUnknownInputs: true, allowUnknownOutputs: true });
    expect(tx.lockTime).toBe(T);
    const input = tx.getInput(0);
    expect(input.sha256).toBeUndefined();
    expect(input.bip32Derivation?.[0]?.[1].fingerprint).toBe(0x2cd95c68);
  });

  it("refuses a fee that is not less than the funding amount", () => {
    expect(() =>
      buildClaimPsbt({
        utxo: { ...utxo, amountSats: 500n },
        witnessScript: script.witnessScript,
        hashLock: hexToBytes(H_HEX),
        preimage: hexToBytes(PREIMAGE_HEX),
        payeePubkey: hexToBytes(PAYEE_HEX),
        payeeDerivation: { fingerprint: 0, path: [] },
        destinationScriptPubKey: destination,
        feeSats: 500n,
      }),
    ).toThrow(/feeSats/);
  });
});
