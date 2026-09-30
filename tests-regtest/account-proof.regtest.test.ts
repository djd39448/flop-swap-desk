// SPDX-License-Identifier: MIT
//
// tests-regtest/account-proof.regtest.test.ts -- P7 `bip322` on a real bitcoind -regtest node: the
// connected `btc-htlc` handle's `signAccountProof` has the node's own wallet sign BIP-322's
// `to_sign` keylessly with `walletprocesspsbt` (the same call the leg's own writes use), and the
// witness it returns is verified here, independently of the handle, against the wallet's pubkey
// with @scure/btc-signer. A proof for another pubkey, DID or contract is refused.

import { dealRoom, type LockTerms } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBtcCounterRail } from "../src/client/btc-rail.js";
import type { ConnectedCounterAssetRail } from "../src/client/counter-rail.js";
import { formatPubkeyLine, pubkeyProofMessage, resolvePubkeys } from "../src/rails/account-line.js";
import { bip322Verifier } from "../src/rails/btc-proof.js";
import { BTC_REGTEST_PIN, keyFromAddressInfo, type BtcRailConfig } from "../src/rails/btc-htlc.js";
import { identity, record } from "../tests/helpers/identity.js";
import { startBitcoind, type BitcoindHandle, type RegtestWallet } from "./helpers/bitcoind.js";

const T0 = 1_700_000_000_000;
const buyer = identity("d4".repeat(32));
const seller = identity("e5".repeat(32));
const CONTRACT = `0x${"ab".repeat(32)}`;
const OTHER_CONTRACT = `0x${"cd".repeat(32)}`;
const ROOM = dealRoom(CONTRACT);

const TERMS: LockTerms = {
  contract: CONTRACT,
  lock: "hash",
  statement: `0x${"11".repeat(32)}`,
  amount: "1000000",
  asset: "BTC",
  payer: buyer.did,
  payee: seller.did,
  claimByMs: T0 + 3_600_000,
  refundAfterMs: T0 + 18_000_000,
};

describe("bip322 account proofs on a real bitcoind -regtest node", () => {
  let node: BitcoindHandle;
  let config: BtcRailConfig;
  let buyerHandle: ConnectedCounterAssetRail;
  let sellerHandle: ConnectedCounterAssetRail;

  const pubOf = (w: RegtestWallet) => w.pubkey.toLowerCase();

  beforeAll(async () => {
    node = await startBitcoind();
    config = { pin: BTC_REGTEST_PIN, endpoint: node.endpoint };
    const mk = (w: RegtestWallet) =>
      createBtcCounterRail({
        config,
        rpc: node.createCapturingRpc(),
        wallet: w.wallet,
        key: keyFromAddressInfo({ pubkey: w.pubkey, hdmasterfingerprint: w.hdMasterFingerprint, hdkeypath: w.hdKeyPath }),
        destinationAddress: w.address,
        clock: () => T0,
      });
    const accounts = { payer: pubOf(node.buyer), payee: pubOf(node.seller) };
    buyerHandle = await mk(node.buyer).connect(TERMS, accounts);
    sellerHandle = await mk(node.seller).connect(TERMS, accounts);
  }, 120_000);

  afterAll(async () => {
    await node?.stop();
  });

  const input = {
    contract: CONTRACT,
    payerDid: buyer.did,
    payeeDid: seller.did,
    rail: "btc-htlc",
    caip2: BTC_REGTEST_PIN.caip2,
    proof: { mode: "required" } as const,
  };

  const messageFor = (did: string, contract: string, pubkey: string) =>
    pubkeyProofMessage({ did, contract, railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey });

  it("Core signs BIP-322's to_sign keylessly and the proof verifies against the wallet's pubkey", async () => {
    const message = messageFor(buyer.did, CONTRACT, pubOf(node.buyer));
    const proof = await buyerHandle.signAccountProof(message);
    expect(proof.scheme).toBe("bip322");
    // Independent of the handle's own re-check: the public verifier over the same inputs.
    expect(
      bip322Verifier.verify({ message, railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, subject: pubOf(node.buyer), proof }),
    ).toBe(true);
    const line = formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: pubOf(node.buyer), proof });
    const result = resolvePubkeys([record(ROOM, 1, T0, buyer, line)], input);
    expect(result.payer).toBe(pubOf(node.buyer));
    expect(result.reasons).toEqual([]);
    expect(line.length).toBeLessThan(400);
  });

  it("the handle refuses a message that names another pubkey", async () => {
    await expect(buyerHandle.signAccountProof(messageFor(buyer.did, CONTRACT, pubOf(node.seller)))).rejects.toThrow(/own pubkey/);
  });

  it("a proof for another pubkey, DID or contract is refused at resolution", async () => {
    // The seller's wallet signs a message naming the buyer's pubkey is refused by the handle; a
    // stranger instead lifts the seller's own proof onto a line naming the buyer's pubkey.
    const sellerProof = await sellerHandle.signAccountProof(messageFor(seller.did, CONTRACT, pubOf(node.seller)));
    const claimsBuyerKey = formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: pubOf(node.buyer), proof: sellerProof });
    expect(resolvePubkeys([record(ROOM, 1, T0, seller, claimsBuyerKey)], input).payee).toBeUndefined();

    // The buyer's genuine proof, posted by the seller or in a mirror pair's room.
    const proof = await buyerHandle.signAccountProof(messageFor(buyer.did, CONTRACT, pubOf(node.buyer)));
    const line = formatPubkeyLine({ railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: pubOf(node.buyer), proof });
    expect(resolvePubkeys([record(ROOM, 1, T0, seller, line)], input).payee).toBeUndefined();
    expect(
      resolvePubkeys([record(dealRoom(OTHER_CONTRACT), 1, T0, buyer, line)], { ...input, contract: OTHER_CONTRACT }).payer,
    ).toBeUndefined();
  });
});
