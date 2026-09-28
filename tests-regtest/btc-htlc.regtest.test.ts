// SPDX-License-Identifier: MIT
//
// tests-regtest/btc-htlc.regtest.test.ts — P4-BTC-SPEC.md §2/§3/§4, Stage BB1's regtest
// coverage: one real Bitcoin Core 31.1 `-regtest` node (tests-regtest/helpers/bitcoind.ts), two
// real descriptor wallets, real mined blocks — no mocks. Reproduces the empirical probe's own
// findings (handoff/research/btc-regtest-probe-2026-09-28.md) as committed regression coverage:
//
//   - buildHtlcScript's witnessScript/address match what Core itself compiles, for freshly
//     wallet-generated keys (not the probe's own hardcoded fixture — tests/btc-script.test.ts
//     already pins those byte-for-byte).
//   - a real claim, keylessly signed by the seller's own wallet.
//   - a real refund: rejected non-final before the chain's median time past reaches T, accepted
//     once setmocktime + mining pushes it past T.
//   - a wrong-preimage claim is rejected by testmempoolaccept and never broadcast (probe Q5),
//     exercised one layer below BtcHtlcRail.claim() itself, which already refuses a mismatched
//     preimage before ever touching the network — this test proves the underlying mempool
//     policy independently backs that refusal up.
//   - findClaimPreimage recovers the real secret from the chain after a claim.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

import { BTC_REGTEST_NETWORK, buildHtlcScript } from "../src/rails/btc-script.js";
import {
  BTC_REGTEST_PIN,
  BtcHtlcRail,
  DEFAULT_FEE_SATS,
  keyFromAddressInfo,
  type BtcHtlcTerms,
  type BtcRailConfig,
  type BtcWalletHandle,
} from "../src/rails/btc-htlc.js";
import { startBitcoind, type BitcoindHandle } from "./helpers/bitcoind.js";

const REGTEST_CONFIG: BtcRailConfig = { pin: BTC_REGTEST_PIN, endpoint: "" }; // endpoint filled in per-node below

function wholeSecondsMsFrom(baseMs: number, deltaSeconds: number): number {
  return (Math.floor(baseMs / 1000) + deltaSeconds) * 1000;
}

function partyFrom(wallet: { wallet: string; pubkey: string; hdMasterFingerprint: string; hdKeyPath: string }): BtcWalletHandle {
  return { wallet: wallet.wallet, key: keyFromAddressInfo({ pubkey: wallet.pubkey, hdmasterfingerprint: wallet.hdMasterFingerprint, hdkeypath: wallet.hdKeyPath }) };
}

describe("btc-htlc (regtest)", () => {
  let node: BitcoindHandle;

  beforeAll(async () => {
    node = await startBitcoind();
  }, 120_000);

  afterAll(async () => {
    if (node !== undefined) await node.stop();
  });

  async function connect(): Promise<BtcHtlcRail> {
    return BtcHtlcRail.connect({ config: { ...REGTEST_CONFIG, endpoint: node.endpoint }, rpc: node.createCapturingRpc() });
  }

  function terms(hashLock: Uint8Array, refundAfterMs: number, amountSats = "100000000"): BtcHtlcTerms {
    return {
      hashLock: `0x${bytesToHex(hashLock)}`,
      amountSats,
      refundAfterMs,
      payeePubkey: node.seller.pubkey,
      payerPubkey: node.buyer.pubkey,
    };
  }

  it("buildHtlcScript reproduces Core's own compiled witnessScript and address, for freshly wallet-generated keys", async () => {
    const preimage = randomBytes(32);
    const hashLock = sha256(preimage);
    const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
    const locktime = info.mediantime + 200_000; // comfortably future; well above the BIP65 threshold given regtest's real-time-based mediantime

    const ours = buildHtlcScript(
      { hashLock, payeePubkey: hexToBytes(node.seller.pubkey), payerPubkey: hexToBytes(node.buyer.pubkey), locktime },
      BTC_REGTEST_NETWORK,
    );

    // Independent ground truth: ask Core itself to compile the same miniscript policy.
    const descriptor = `wsh(andor(pk(${node.seller.pubkey}),sha256(${bytesToHex(hashLock)}),and_v(v:pk(${node.buyer.pubkey}),after(${locktime}))))`;
    const descInfo = await node.rpcCall<{ checksum: string }>("getdescriptorinfo", [descriptor]);
    const checkedDescriptor = `${descriptor}#${descInfo.checksum}`;
    const [coreAddress] = await node.rpcCall<string[]>("deriveaddresses", [checkedDescriptor]);
    expect(coreAddress).toBe(ours.address);

    // getdescriptorinfo/deriveaddresses don't expose the compiled witnessScript bytes directly
    // (probe Q1) — read them back via a disposable watch-only wallet's own getaddressinfo.
    const watcherName = `watcher-${bytesToHex(hashLock).slice(0, 8)}`;
    await node.rpcCall("createwallet", [watcherName, true, true, "", false, true]);
    await node.rpcCall("importdescriptors", [[{ desc: checkedDescriptor, timestamp: "now" }]], `/wallet/${watcherName}`);
    const addrInfo = await node.rpcCall<{ hex: string }>("getaddressinfo", [coreAddress], `/wallet/${watcherName}`);

    expect(addrInfo.hex).toBe(bytesToHex(ours.witnessScript));
  });

  it("claims: the seller's own wallet signs the hash branch and the funds land in the seller's balance", async () => {
    const buyer = partyFrom(node.buyer);
    const seller = partyFrom(node.seller);
    const buyerRail = await connect();
    const sellerRail = await connect();

    const preimage = randomBytes(32);
    const hashLock = sha256(preimage);
    const tipMs = await buyerRail.tipBlockTimeMs();
    const refundAfterMs = wholeSecondsMsFrom(tipMs, 24 * 3600); // far future — irrelevant to the claim branch

    const fundEvidence = await buyerRail.fund(terms(hashLock, refundAfterMs), buyer);
    expect(fundEvidence.ref).toMatch(/^[0-9a-f]{64}:[0-9]+$/);
    await node.mine(1);

    const destination = await node.rpcCall<string>("getnewaddress", ["", "bech32"], "/wallet/seller");
    const sellerBalanceBefore = await node.rpcCall<number>("getbalance", [], "/wallet/seller");

    const notAfterMs = tipMs + 3600_000;
    const claimEvidence = await sellerRail.claim(fundEvidence.ref, terms(hashLock, refundAfterMs), `0x${bytesToHex(preimage)}`, seller, destination, notAfterMs);
    expect(claimEvidence.ref).toBe(fundEvidence.ref);
    expect(claimEvidence.txid).toMatch(/^[0-9a-f]{64}$/);

    await node.mine(1);
    const sellerBalanceAfter = await node.rpcCall<number>("getbalance", [], "/wallet/seller");
    expect(sellerBalanceAfter).toBeGreaterThan(sellerBalanceBefore);
  });

  it("refund: rejected non-final before median time past reaches T, accepted once it does", async () => {
    const buyer = partyFrom(node.buyer);
    const buyerRail = await connect();

    const preimage = randomBytes(32);
    const hashLock = sha256(preimage);
    const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
    const t = info.mediantime + 120; // just above the current mediantime — not yet reachable
    const refundAfterMs = t * 1000;

    const fundEvidence = await buyerRail.fund(terms(hashLock, refundAfterMs), buyer);
    await node.mine(1);

    const destination = await node.rpcCall<string>("getnewaddress", ["", "bech32"], "/wallet/buyer");

    await expect(buyerRail.refund(fundEvidence.ref, terms(hashLock, refundAfterMs), buyer, destination)).rejects.toThrow(/non-final/);

    // Push median time past T (probe Q4: setmocktime + mine 11 blocks so MTP itself advances).
    await node.setMockTime(t + 200);
    await node.mine(11);

    const refundEvidence = await buyerRail.refund(fundEvidence.ref, terms(hashLock, refundAfterMs), buyer, destination);
    expect(refundEvidence.ref).toBe(fundEvidence.ref);
    expect(refundEvidence.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a wrong-preimage claim is rejected by testmempoolaccept and never broadcast (probe Q5)", async () => {
    const buyer = partyFrom(node.buyer);
    const seller = partyFrom(node.seller);
    const buyerRail = await connect();

    const preimage = randomBytes(32);
    const hashLock = sha256(preimage);
    const tipMs = await buyerRail.tipBlockTimeMs();
    const refundAfterMs = wholeSecondsMsFrom(tipMs, 24 * 3600);

    const fundEvidence = await buyerRail.fund(terms(hashLock, refundAfterMs), buyer);
    await node.mine(1);
    const [fundTxid, voutStr] = fundEvidence.ref.split(":");
    const vout = Number(voutStr);

    const script = buildHtlcScript(
      { hashLock, payeePubkey: hexToBytes(node.seller.pubkey), payerPubkey: hexToBytes(node.buyer.pubkey), locktime: refundAfterMs / 1000 },
      BTC_REGTEST_NETWORK,
    );
    const destination = await node.rpcCall<string>("getnewaddress", ["", "bech32"], "/wallet/seller");
    const { OutScript, Address, Transaction } = await import("@scure/btc-signer");
    const destinationScriptPubKey = OutScript.encode(Address(BTC_REGTEST_NETWORK).decode(destination));
    const amountSats = 100_000_000n;

    // Probe Q5's own recipe: a valid PSBT carrying witness_utxo/witnessScript/bip32_derivation
    // but deliberately NO sha256 preimage field, so Core's own finalizer cannot auto-satisfy the
    // hash branch at all (finalize defaults to true but can only ever produce a PARTIAL result
    // here) — walletprocesspsbt(psbt, sign=true, sighashtype=ALL, bip32derivs=true,
    // finalize=false) returns the seller's real signature (a signature never depends on the
    // witness stack's own preimage value) without ever needing the correct preimage to produce
    // it. This build then hand-assembles the final witness itself with a WRONG preimage in
    // place of the real one, bypassing Core's own finalizer entirely — exactly what a hostile
    // client could attempt, and exactly what mempool policy (not signature validity) must catch.
    const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
    tx.addInput({
      txid: fundTxid as string,
      index: vout,
      witnessUtxo: { amount: amountSats, script: script.scriptPubKey },
      witnessScript: script.witnessScript,
      bip32Derivation: [[hexToBytes(node.seller.pubkey), { fingerprint: seller.key.fingerprint, path: [...seller.key.path] }]],
      sequence: 0xfffffffe,
    });
    tx.addOutput({ script: destinationScriptPubKey, amount: amountSats - DEFAULT_FEE_SATS });

    const processed = await node.rpcCall<{ psbt: string; complete: boolean }>(
      "walletprocesspsbt",
      [Buffer.from(tx.toPSBT()).toString("base64"), true, "ALL", true, false],
      "/wallet/seller",
    );
    expect(processed.complete).toBe(false); // cannot auto-satisfy sha256() with no preimage field at all

    const partiallySigned = Transaction.fromPSBT(Buffer.from(processed.psbt, "base64"), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const sellerSignature = partiallySigned.getInput(0).partialSig?.[0]?.[1];
    expect(sellerSignature).toBeInstanceOf(Uint8Array);
    if (sellerSignature === undefined) throw new Error("test setup: seller's wallet returned no partial signature");

    const wrongPreimage = randomBytes(32); // overwhelmingly unlikely to hash to hashLock
    tx.updateInput(0, { finalScriptWitness: [wrongPreimage, sellerSignature, script.witnessScript] });
    const badRawHex = bytesToHex(tx.extract());

    const acceptance = await node.rpcCall<Array<{ allowed: boolean; "reject-reason"?: string }>>("testmempoolaccept", [[badRawHex]]);
    expect(acceptance[0]?.allowed).toBe(false);
    expect(acceptance[0]?.["reject-reason"]).toMatch(/mempool-script-verify-flag-failed/);

    const mempool = await node.rpcCall<string[]>("getrawmempool", []);
    expect(mempool).toEqual([]);
  });

  it("findClaimPreimage recovers the secret from a real claim on chain", async () => {
    const buyer = partyFrom(node.buyer);
    const seller = partyFrom(node.seller);
    const buyerRail = await connect();
    const sellerRail = await connect();

    const preimage = randomBytes(32);
    const hashLock = sha256(preimage);
    const tipMs = await buyerRail.tipBlockTimeMs();
    const refundAfterMs = wholeSecondsMsFrom(tipMs, 24 * 3600);

    const startHeight = (await node.rpcCall<{ blocks: number }>("getblockchaininfo", [])).blocks;
    const fundEvidence = await buyerRail.fund(terms(hashLock, refundAfterMs), buyer);
    await node.mine(1);

    const destination = await node.rpcCall<string>("getnewaddress", ["", "bech32"], "/wallet/seller");
    await sellerRail.claim(fundEvidence.ref, terms(hashLock, refundAfterMs), `0x${bytesToHex(preimage)}`, seller, destination, tipMs + 3600_000);
    await node.mine(1);

    const found = await buyerRail.findClaimPreimage(fundEvidence.ref, `0x${bytesToHex(hashLock)}`, startHeight);
    expect(found).toBe(`0x${bytesToHex(preimage)}`);
  });

  it("findClaimPreimage returns null for a refunded (not claimed) outpoint", async () => {
    const buyer = partyFrom(node.buyer);
    const buyerRail = await connect();

    const preimage = randomBytes(32);
    const hashLock = sha256(preimage);
    const info = await node.rpcCall<{ mediantime: number }>("getblockchaininfo", []);
    const t = info.mediantime + 60;
    const refundAfterMs = t * 1000;

    const startHeight = (await node.rpcCall<{ blocks: number }>("getblockchaininfo", [])).blocks;
    const fundEvidence = await buyerRail.fund(terms(hashLock, refundAfterMs), buyer);
    await node.mine(1);

    await node.setMockTime(t + 200);
    await node.mine(11);
    const destination = await node.rpcCall<string>("getnewaddress", ["", "bech32"], "/wallet/buyer");
    await buyerRail.refund(fundEvidence.ref, terms(hashLock, refundAfterMs), buyer, destination);
    await node.mine(1);

    const found = await buyerRail.findClaimPreimage(fundEvidence.ref, `0x${bytesToHex(hashLock)}`, startHeight);
    expect(found).toBeNull();
  });
});
