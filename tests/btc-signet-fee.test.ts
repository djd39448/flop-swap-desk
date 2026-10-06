// SPDX-License-Identifier: MIT
//
// tests/btc-signet-fee.test.ts: P9-5, the Bitcoin signet fee rule and policy, in pure pieces and without a node:
// the size bound of a claim or refund (checked against the two real Core-signed spends in the committed regtest
// fixtures), the estimate-to-rate rule (floor, cap, no usable answer), the whole-fee rule (rate times size, the
// 1,000 satoshi floor, the dust ceiling), the policy chosen by the pin's network name, and the constants themselves.
// The adapter driving these through a mocked bitcoind (the estimate call, the PSBT it builds, the retry rule) is in
// tests/btc-htlc.test.ts; the real node is tests-regtest/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";

import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { BTC_LOCAL_POLICY, BTC_SIGNET_POLICY, btcLocalPolicyFor } from "../src/client/policy.js";
import { DEFAULT_POLICY_EXAMPLE } from "../src/deadlines.js";
import {
  BTC_MIN_LOCKABLE_SATS,
  BTC_REGTEST_PIN,
  BTC_SIGNET_FEE_CAP_SAT_PER_VB,
  BTC_SIGNET_FEE_FLOOR_SAT_PER_VB,
  BTC_SIGNET_FEE_RULE,
  BTC_SIGNET_FEE_TARGET_BLOCKS,
  BTC_SIGNET_PIN,
  DEFAULT_FEE_SATS,
  DUST_LIMIT_SATS,
  btcFeeRuleFor,
  feeRateFromEstimate,
  spendFeeSatsFor,
  type BtcFeeRule,
} from "../src/rails/btc-htlc.js";
import {
  BTC_REGTEST_NETWORK,
  buildClaimPsbt,
  buildHtlcScript,
  buildRefundPsbt,
  htlcSpendVsizeBound,
  scriptPubKeyForAddress,
} from "../src/rails/btc-script.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const RULE = BTC_SIGNET_FEE_RULE;

// -- the constants, pinned as literals so a drift is a visible diff ----------------------------

describe("P9-5: the signet fee rule's constants", () => {
  it("is 6 blocks, conservative, floor 8 sat/vB, cap 50 sat/vB, a 1,000 satoshi floor on the whole fee", () => {
    expect(BTC_SIGNET_FEE_TARGET_BLOCKS).toBe(6);
    expect(BTC_SIGNET_FEE_FLOOR_SAT_PER_VB).toBe(8);
    expect(BTC_SIGNET_FEE_CAP_SAT_PER_VB).toBe(50);
    expect(RULE).toEqual({ confTarget: 6, estimateMode: "conservative", floorSatPerKvB: 8000, capSatPerKvB: 50000, floorFeeSats: 1000 });
    expect(BigInt(RULE.floorFeeSats)).toBe(DEFAULT_FEE_SATS); // the regtest fee is the signet floor
    expect(Object.isFrozen(RULE)).toBe(true);
  });

  it("the target is the claim-inclusion margin in signet blocks (60 minutes at 10 minutes a block)", () => {
    expect(BTC_SIGNET_FEE_TARGET_BLOCKS * 10 * 60_000).toBe(BTC_SIGNET_POLICY.claimInclusionMarginMs);
  });

  it("the rate floor never prices a claim or refund below the 1,000 satoshi regtest fee, for the smallest destination", () => {
    // The smallest standard destination script is a P2WPKH one, 22 bytes; the smallest spend is its refund.
    for (const branch of ["claim", "refund"] as const) {
      const smallest = htlcSpendVsizeBound(branch, 118, 22);
      expect(BigInt(BTC_SIGNET_FEE_FLOOR_SAT_PER_VB * smallest)).toBeGreaterThanOrEqual(DEFAULT_FEE_SATS);
    }
    expect(htlcSpendVsizeBound("refund", 118, 22)).toBe(132);
  });

  it("the cap leaves room above the floor, and the cap fee of a real spend is well under a typical swap amount", () => {
    expect(RULE.capSatPerKvB).toBeGreaterThan(RULE.floorSatPerKvB);
    expect(BigInt(BTC_SIGNET_FEE_CAP_SAT_PER_VB * htlcSpendVsizeBound("claim", 118, 34))).toBe(7600n);
    expect(BigInt(BTC_SIGNET_FEE_CAP_SAT_PER_VB * htlcSpendVsizeBound("claim", 118, 22))).toBe(7000n);
  });

  it("btcFeeRuleFor: none for regtest, the one rule for signet, a throw for anything else", () => {
    expect(btcFeeRuleFor("regtest")).toBeNull();
    expect(btcFeeRuleFor("signet")).toBe(BTC_SIGNET_FEE_RULE);
    for (const other of ["main", "test", "testnet4", "", "Signet", "regtest "]) {
      expect(() => btcFeeRuleFor(other), other).toThrow(/no fee rule for network/);
    }
  });
});

// -- the size bound ---------------------------------------------------------------------------

const PAYEE_HEX = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a";
const PAYER_HEX = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627";
const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const H = sha256(hexToBytes(PREIMAGE_HEX));
const T = 1_700_000_000;
const SCRIPT = buildHtlcScript({ hashLock: H, payeePubkey: hexToBytes(PAYEE_HEX), payerPubkey: hexToBytes(PAYER_HEX), locktime: T }, BTC_REGTEST_NETWORK);
const FUND_TXID = "ab08a3ba29a27d8ccbc37fe3efe3f56018e34978328bc421361e688dc8d66694";
const UTXO = { txid: FUND_TXID, vout: 1, scriptPubKey: SCRIPT.scriptPubKey, amountSats: 100_000_000n };
const DERIVATION = { fingerprint: 0xb222e7bb, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] };

/** A P2WPKH destination (22-byte script) and a P2WSH one (34 bytes), as bytes. */
const P2WPKH_DESTINATION = new Uint8Array([0x00, 0x14, ...new Array<number>(20).fill(0xab)]);
const P2WSH_DESTINATION = scriptPubKeyForAddress(SCRIPT.address, BTC_REGTEST_NETWORK);

function claimPsbt(destination: Uint8Array): Uint8Array {
  return buildClaimPsbt({
    utxo: UTXO,
    witnessScript: SCRIPT.witnessScript,
    hashLock: H,
    preimage: hexToBytes(PREIMAGE_HEX),
    payeePubkey: hexToBytes(PAYEE_HEX),
    payeeDerivation: DERIVATION,
    destinationScriptPubKey: destination,
    feeSats: 1000n,
  });
}

function refundPsbt(destination: Uint8Array): Uint8Array {
  return buildRefundPsbt({
    utxo: UTXO,
    witnessScript: SCRIPT.witnessScript,
    locktime: T,
    payerPubkey: hexToBytes(PAYER_HEX),
    payerDerivation: DERIVATION,
    destinationScriptPubKey: destination,
    feeSats: 1000n,
  });
}

/** The size, in bytes, of the transaction the PSBT carries without any witness data. */
function nonWitnessBytes(psbt: Uint8Array): number {
  return Transaction.fromPSBT(psbt, { allowUnknownInputs: true, allowUnknownOutputs: true }).unsignedTx.length;
}

describe("P9-5: htlcSpendVsizeBound is an upper bound for the transaction a PSBT becomes", () => {
  it("is 140 / 132 virtual bytes for a claim / refund to a P2WPKH script and 152 / 144 to a P2WSH one (118-byte witness script)", () => {
    expect(SCRIPT.witnessScript.length).toBe(118);
    expect(htlcSpendVsizeBound("claim", 118, 22)).toBe(140);
    expect(htlcSpendVsizeBound("refund", 118, 22)).toBe(132);
    expect(htlcSpendVsizeBound("claim", 118, 34)).toBe(152);
    expect(htlcSpendVsizeBound("refund", 118, 34)).toBe(144);
  });

  it.each([
    ["P2WPKH", P2WPKH_DESTINATION],
    ["P2WSH", P2WSH_DESTINATION],
  ])("agrees with the real non-witness size of the built PSBT plus its witness, destination %s", (_label, destination) => {
    const script = SCRIPT.witnessScript.length;
    // Witness bytes, itemised: an item count, then each item with its length byte. A claim carries the 32-byte
    // preimage, a signature counted at 73 bytes and the script; a refund a 73-byte signature, an empty item and the script.
    const claimWitness = 1 + (1 + 32) + (1 + 73) + (1 + script);
    const refundWitness = 1 + (1 + 73) + 1 + (1 + script);
    expect(htlcSpendVsizeBound("claim", script, destination.length)).toBe(nonWitnessBytes(claimPsbt(destination)) + Math.ceil((2 + claimWitness) / 4));
    expect(htlcSpendVsizeBound("refund", script, destination.length)).toBe(nonWitnessBytes(refundPsbt(destination)) + Math.ceil((2 + refundWitness) / 4));
  });

  it("covers the two real Core-signed spends in the committed regtest fixtures, by at most two virtual bytes", () => {
    const spends = realSpendsFromFixtures();
    const claim = spends.find((spend) => spend.branch === "claim");
    const refund = spends.find((spend) => spend.branch === "refund");
    expect(claim, "a real claim in fixtures/btc-regtest-2026-09-28").toBeDefined();
    expect(refund, "a real refund in fixtures/btc-regtest-2026-09-28").toBeDefined();
    for (const spend of [claim, refund]) {
      if (spend === undefined) continue;
      const bound = htlcSpendVsizeBound(spend.branch, spend.witnessScriptLength, spend.destinationScriptLength);
      expect(bound, `${spend.branch} bound ${bound} vs real ${spend.vsize}`).toBeGreaterThanOrEqual(spend.vsize);
      expect(bound).toBeLessThanOrEqual(spend.vsize + 2);
    }
    // The numbers the doc comment quotes.
    expect(claim?.vsize).toBe(139);
    expect(refund?.vsize).toBe(131);
  });

  it("refuses a non-positive or fractional length", () => {
    expect(() => htlcSpendVsizeBound("claim", 0, 22)).toThrow(/witnessScriptLength/);
    expect(() => htlcSpendVsizeBound("claim", 118, 0)).toThrow(/destinationScriptLength/);
    expect(() => htlcSpendVsizeBound("refund", 118.5, 22)).toThrow(/witnessScriptLength/);
    expect(() => htlcSpendVsizeBound("refund", 118, Number.NaN)).toThrow(/destinationScriptLength/);
  });

  it("counts a witness script whose length needs a three-byte compact size (253 bytes or more)", () => {
    // base 82 (P2WPKH destination); claim witness = 1 + 33 + 74 + (length byte(s) + script)
    expect(htlcSpendVsizeBound("claim", 252, 22)).toBe(82 + Math.ceil((2 + 1 + 33 + 74 + 1 + 252) / 4)); // 173
    expect(htlcSpendVsizeBound("claim", 253, 22)).toBe(82 + Math.ceil((2 + 1 + 33 + 74 + 3 + 253) / 4)); // 174
    expect(htlcSpendVsizeBound("claim", 300, 22)).toBe(82 + Math.ceil((2 + 1 + 33 + 74 + 3 + 300) / 4)); // 186
  });
});

interface RealSpend {
  branch: "claim" | "refund";
  vsize: number;
  witnessScriptLength: number;
  destinationScriptLength: number;
}

/** Every real HTLC spend (a three-item witness ending in the 118-byte script) found in the committed regtest fixtures. */
function realSpendsFromFixtures(): RealSpend[] {
  const found = new Map<string, RealSpend>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const tx = node as { txid?: unknown; vsize?: unknown; vin?: unknown; vout?: unknown };
    if (typeof tx.txid === "string" && typeof tx.vsize === "number" && Array.isArray(tx.vin) && Array.isArray(tx.vout) && tx.vout.length === 1) {
      const witness = (tx.vin[0] as { txinwitness?: unknown } | undefined)?.txinwitness;
      const out = (tx.vout[0] as { scriptPubKey?: { hex?: unknown } }).scriptPubKey?.hex;
      if (Array.isArray(witness) && witness.length === 3 && typeof out === "string") {
        const items = witness as string[];
        const script = items[2] ?? "";
        const branch = (items[0] ?? "").length === 64 ? "claim" : items[1] === "" ? "refund" : undefined;
        if (branch !== undefined && script.length === 2 * SCRIPT.witnessScript.length) {
          found.set(tx.txid, { branch, vsize: tx.vsize, witnessScriptLength: script.length / 2, destinationScriptLength: out.length / 2 });
        }
      }
    }
    Object.values(node).forEach(visit);
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".json")) {
        try {
          visit(JSON.parse(readFileSync(path, "utf8")) as unknown);
        } catch {
          // a capture file that is not JSON (none expected) holds no transaction
        }
      }
    }
  };
  walk(join(repoRoot, "fixtures", "btc-regtest-2026-09-28"));
  return [...found.values()];
}

// -- the estimate to a rate -------------------------------------------------------------------

describe("P9-5: feeRateFromEstimate (sat per 1000 vB, clamped to [8000, 50000])", () => {
  it("uses the estimate when it lies between the floor and the cap (BTC/kvB to sat/kvB, exactly)", () => {
    expect(feeRateFromEstimate(RULE, { feerate: 0.00012, blocks: 6 })).toBe(12_000);
    expect(feeRateFromEstimate(RULE, { feerate: 0.00012345, blocks: 6 })).toBe(12_345);
    expect(feeRateFromEstimate(RULE, { feerate: 0.0004, blocks: 6 })).toBe(40_000);
    // every whole satoshi per kvB in the allowed range survives the float round trip
    for (let satPerKvB = 8000; satPerKvB <= 50_000; satPerKvB += 1) {
      expect(feeRateFromEstimate(RULE, { feerate: satPerKvB / 1e8 })).toBe(satPerKvB);
    }
  });

  it("clamps above the cap and below the floor", () => {
    expect(feeRateFromEstimate(RULE, { feerate: 0.0006 })).toBe(50_000);
    expect(feeRateFromEstimate(RULE, { feerate: 1 })).toBe(50_000);
    expect(feeRateFromEstimate(RULE, { feerate: 21_000_000 })).toBe(50_000);
    expect(feeRateFromEstimate(RULE, { feerate: 1e300 })).toBe(50_000);
    expect(feeRateFromEstimate(RULE, { feerate: 0.00001 })).toBe(8000); // 1 sat/vB
    expect(feeRateFromEstimate(RULE, { feerate: 1e-12 })).toBe(8000);
    expect(feeRateFromEstimate(RULE, { feerate: 0.00007999 })).toBe(8000);
    expect(feeRateFromEstimate(RULE, { feerate: 0.00008 })).toBe(8000);
    expect(feeRateFromEstimate(RULE, { feerate: 0.0005 })).toBe(50_000);
    expect(feeRateFromEstimate(RULE, { feerate: 0.00050001 })).toBe(50_000);
  });

  it("is the floor when the node has no usable answer", () => {
    const noData = { errors: ["Insufficient data or no feerate found"], blocks: 6 };
    const answers: unknown[] = [noData, {}, { blocks: 6 }, null, undefined, "0.0002", 7, [], { feerate: 0 }, { feerate: -0.0001 }, { feerate: Number.NaN }, { feerate: Number.POSITIVE_INFINITY }, { feerate: "0.0002" }, { feerate: null }, { feerate: {} }, { feerate: [0.0002] }, { feerate: true }];
    for (const answer of answers) {
      expect(feeRateFromEstimate(RULE, answer), JSON.stringify(answer)).toBe(8000);
    }
  });

  it("follows the rule it is given (a different floor and cap move the clamp)", () => {
    const other: BtcFeeRule = { ...RULE, floorSatPerKvB: 2000, capSatPerKvB: 3000 };
    expect(feeRateFromEstimate(other, { feerate: 0.00001 })).toBe(2000);
    expect(feeRateFromEstimate(other, { feerate: 0.000025 })).toBe(2500);
    expect(feeRateFromEstimate(other, { feerate: 0.0001 })).toBe(3000);
    expect(feeRateFromEstimate(other, null)).toBe(2000);
  });
});

// -- the whole fee of a spend -----------------------------------------------------------------

describe("P9-5: spendFeeSatsFor (rate times size, 1,000 satoshi floor, dust ceiling)", () => {
  it("is ceil(rate * size / 1000) between the floor and the ceiling", () => {
    expect(spendFeeSatsFor(RULE, 12_000, 140, 100_000_000n)).toBe(1680n);
    expect(spendFeeSatsFor(RULE, 8000, 132, 100_000_000n)).toBe(1056n);
    expect(spendFeeSatsFor(RULE, 8001, 132, 100_000_000n)).toBe(1057n); // 1056.132 rounds up
    expect(spendFeeSatsFor(RULE, 12_345, 152, 100_000_000n)).toBe(1877n); // 1876.44 rounds up
  });

  it("never pays more than the cap rate over the size, whatever rate it is handed", () => {
    expect(spendFeeSatsFor(RULE, 50_000, 140, 100_000_000n)).toBe(7000n);
    expect(spendFeeSatsFor(RULE, 5_000_000, 140, 100_000_000n)).toBe(7000n);
    expect(spendFeeSatsFor(RULE, Number.MAX_SAFE_INTEGER, 152, 100_000_000n)).toBe(7600n);
  });

  it("never pays less than the 1,000 satoshi floor, even for a rule whose rate floor would", () => {
    const lowRule: BtcFeeRule = { ...RULE, floorSatPerKvB: 1000, capSatPerKvB: 50_000 };
    expect(spendFeeSatsFor(lowRule, 1000, 140, 100_000_000n)).toBe(1000n); // 140 sat by rate, floored at 1,000
    expect(spendFeeSatsFor(lowRule, 1, 140, 100_000_000n)).toBe(1000n); // below the rule's rate floor: clamped up, then floored
  });

  it("never leaves an output under the dust limit, except that the floor wins on a leg too small to leave one", () => {
    expect(spendFeeSatsFor(RULE, 50_000, 140, 3000n)).toBe(3000n - DUST_LIMIT_SATS);
    expect(spendFeeSatsFor(RULE, 50_000, 140, BTC_MIN_LOCKABLE_SATS)).toBe(BTC_MIN_LOCKABLE_SATS - DUST_LIMIT_SATS); // 1,500, above the floor
    expect(spendFeeSatsFor(RULE, 8000, 132, BTC_MIN_LOCKABLE_SATS)).toBe(1056n); // under the ceiling, untouched
    expect(spendFeeSatsFor(RULE, 50_000, 140, 1200n)).toBe(1000n); // 1200 - 546 = 654 < the floor: the floor
    expect(spendFeeSatsFor(RULE, 8000, 132, 1001n)).toBe(1000n);
  });

  it("refuses a rate or size that is not a positive safe integer", () => {
    expect(() => spendFeeSatsFor(RULE, 0, 140, 1n)).toThrow(/fee rate/);
    expect(() => spendFeeSatsFor(RULE, -1, 140, 1n)).toThrow(/fee rate/);
    expect(() => spendFeeSatsFor(RULE, 8000.5, 140, 1n)).toThrow(/fee rate/);
    expect(() => spendFeeSatsFor(RULE, Number.NaN, 140, 1n)).toThrow(/fee rate/);
    expect(() => spendFeeSatsFor(RULE, 8000, 0, 1n)).toThrow(/vsize/);
    expect(() => spendFeeSatsFor(RULE, 8000, 1.5, 1n)).toThrow(/vsize/);
  });
});

// -- the policy, chosen by the network name ---------------------------------------------------

describe("P9-5: BTC_SIGNET_POLICY is chosen by the pin's network name, and regtest is untouched", () => {
  it("regtest keeps BTC_LOCAL_POLICY: the same object, the same numbers, and no fee field", () => {
    expect(btcLocalPolicyFor("regtest")).toBe(BTC_LOCAL_POLICY);
    expect(BTC_LOCAL_POLICY).toEqual({ ...DEFAULT_POLICY_EXAMPLE, minRevealWindowMs: 3_600_000, finalityAMs: 10_800_000, claimInclusionMarginMs: 3_600_000 });
    expect("fee" in BTC_LOCAL_POLICY).toBe(false);
    expect(Object.isFrozen(BTC_LOCAL_POLICY)).toBe(true);
  });

  it("signet gets BTC_SIGNET_POLICY: the same deadline numbers (one confirmation stays), and the fee rule", () => {
    expect(btcLocalPolicyFor("signet")).toBe(BTC_SIGNET_POLICY);
    expect(BTC_SIGNET_POLICY).toEqual({
      ...DEFAULT_POLICY_EXAMPLE,
      minRevealWindowMs: 3_600_000,
      finalityAMs: 10_800_000,
      claimInclusionMarginMs: 3_600_000,
      fee: BTC_SIGNET_FEE_RULE,
    });
    expect(BTC_SIGNET_POLICY.fee).toBe(BTC_SIGNET_FEE_RULE);
    expect(BTC_SIGNET_POLICY.fee).toBe(btcFeeRuleFor("signet"));
    expect(Object.isFrozen(BTC_SIGNET_POLICY)).toBe(true);
    expect(BTC_SIGNET_PIN.finality.confirmations).toBe(1);
    expect(BTC_SIGNET_POLICY).not.toBe(BTC_LOCAL_POLICY);
  });

  it("the policy is JSON-safe (no BigInt), so it can be printed or recorded", () => {
    expect(() => JSON.stringify(BTC_SIGNET_POLICY)).not.toThrow();
    expect(JSON.parse(JSON.stringify(BTC_SIGNET_POLICY))).toEqual(BTC_SIGNET_POLICY);
  });

  it("a name off the allow list has no policy", () => {
    for (const other of ["main", "test", "testnet4", "", "SIGNET"]) {
      expect(() => btcLocalPolicyFor(other), other).toThrow(/no policy for network/);
    }
  });

  function rail(network: "regtest" | "signet", extra: Record<string, unknown> = {}) {
    const pin = network === "regtest" ? BTC_REGTEST_PIN : BTC_SIGNET_PIN;
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:1", fetch: (() => Promise.reject(new Error("no network in this test"))) as typeof fetch });
    const key = { pubkey: PAYER_HEX, fingerprint: 0x2cd95c68, path: DERIVATION.path };
    return createBtcCounterRail({ config: { pin, endpoint: "http://127.0.0.1:1" }, rpc, wallet: "buyer", key, destinationAddress: SCRIPT.address, clock: () => 0, ...extra });
  }

  it("the rail takes its policy from the pin's network and ignores any policy a caller passes (never a constructor option)", () => {
    expect(rail("regtest").policy).toBe(BTC_LOCAL_POLICY);
    expect(rail("signet").policy).toBe(BTC_SIGNET_POLICY);
    const slack = { ...BTC_LOCAL_POLICY, minRevealWindowMs: 1, finalityAMs: 1, claimInclusionMarginMs: 1 };
    expect(rail("regtest", { policy: slack }).policy).toBe(BTC_LOCAL_POLICY);
    expect(rail("signet", { policy: slack }).policy).toBe(BTC_SIGNET_POLICY);
  });

  it("the rail refuses a network off the allow list when it is built, before any call", () => {
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:1", fetch: (() => Promise.reject(new Error("no network in this test"))) as typeof fetch });
    const key = { pubkey: PAYER_HEX, fingerprint: 0, path: [] };
    const config = { pin: { ...BTC_REGTEST_PIN, network: "main" as never }, endpoint: "http://127.0.0.1:1" };
    expect(() => createBtcCounterRail({ config, rpc, wallet: "buyer", key, destinationAddress: SCRIPT.address, clock: () => 0 })).toThrow(/no policy for network "main"/);
  });

  it("the minimum lockable amount is the same on both networks (a leg that clears regtest clears signet)", () => {
    expect(rail("regtest").minLockableAmount).toBe(BTC_MIN_LOCKABLE_SATS.toString());
    expect(rail("signet").minLockableAmount).toBe(BTC_MIN_LOCKABLE_SATS.toString());
  });
});
