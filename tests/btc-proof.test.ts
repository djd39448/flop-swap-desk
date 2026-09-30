// SPDX-License-Identifier: MIT
//
// tests/btc-proof.test.ts -- P7 `bip322`: the BIP-322 simple signature for a pubkey line's
// P2WPKH address. Pins the BIP-322 test vectors (https://github.com/bitcoin/bips/blob/master/
// bip-0322.mediawiki, "Test vectors": the L3VFeEuj... key, address
// bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l, messages "" and "Hello World"), then the
// account-proof use: a proof for another pubkey, DID, contract or account is refused. Hermetic:
// the stand-in for the node wallet is btc-signer signing the PSBT this code built, the same
// artifact a real wallet's `walletprocesspsbt` signs (the regtest suite drives the real one).

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { dealRoom } from "@flop-labs/tclk";
import { p2wpkh, Transaction, WIF } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";

import { formatPubkeyLine, pubkeyProofMessage, resolvePubkeys } from "../src/rails/account-line.js";
import { buildAccountProofMessage, checkLineProof } from "../src/rails/account-proof.js";
import {
  bip322ProofPsbt,
  bip322Txids,
  bip322Verifier,
  bip322WitnessFromSignedTx,
} from "../src/rails/btc-proof.js";
import { identity, record } from "./helpers/identity.js";

// -- the BIP-322 vectors ---------------------------------------------------------------------

const VECTOR_WIF = "L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k";
const VECTOR_ADDRESS = "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l";
const vectorPriv = WIF().decode(VECTOR_WIF);
const vectorPub = bytesToHex(secp256k1.getPublicKey(vectorPriv, true));

const VECTORS = [
  {
    message: "",
    toSpend: "c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7",
    toSign: "1e9654e951a5ba44c8604c4de6c67fd78a27e81dcadcfe1edf638ba3aaebaed6",
    signature:
      "AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=",
  },
  {
    message: "Hello World",
    toSpend: "b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b",
    toSign: "88737ae86f2077145f93cc4b153ae9a1cb8d56afa511988c149c5c8c9d93bddf",
    signature:
      "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=",
  },
] as const;

const ctxFor = (message: string, signature: string, subject = vectorPub) => ({
  message,
  railId: "btc-htlc",
  caip2: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
  subject,
  proof: { scheme: "bip322", signature },
});

describe("bip322: the BIP-322 test vectors", () => {
  it("the pubkey's P2WPKH address is the vector's address", () => {
    expect(p2wpkh(hexToBytes(vectorPub)).address).toBe(VECTOR_ADDRESS);
  });

  for (const v of VECTORS) {
    it(`to_spend and to_sign txids match the BIP for message ${JSON.stringify(v.message)}`, () => {
      expect(bip322Txids(v.message, vectorPub)).toEqual({ toSpend: v.toSpend, toSign: v.toSign });
    });

    it(`the BIP's signature for message ${JSON.stringify(v.message)} verifies`, () => {
      expect(bip322Verifier.verify(ctxFor(v.message, v.signature))).toBe(true);
    });
  }

  it("the BIP's signature does not verify for the other vector message, another pubkey, or a mangled token", () => {
    const [empty, hello] = VECTORS;
    expect(bip322Verifier.verify(ctxFor(hello.message, empty.signature))).toBe(false);
    expect(bip322Verifier.verify(ctxFor(empty.message, hello.signature))).toBe(false);
    const otherPub = bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true));
    expect(bip322Verifier.verify(ctxFor(empty.message, empty.signature, otherPub))).toBe(false);
    // One flipped bit inside the DER signature.
    const raw = Buffer.from(empty.signature, "base64");
    raw[10] = raw[10]! ^ 1;
    expect(bip322Verifier.verify(ctxFor(empty.message, raw.toString("base64")))).toBe(false);
    // Not base64, non-canonical base64 padding, truncated, empty.
    expect(bip322Verifier.verify(ctxFor(empty.message, "!!!"))).toBe(false);
    expect(bip322Verifier.verify(ctxFor(empty.message, empty.signature.slice(0, -4)))).toBe(false);
    expect(bip322Verifier.verify(ctxFor(empty.message, empty.signature.replace(/=$/, "")))).toBe(false);
    expect(bip322Verifier.verify(ctxFor(empty.message, "AA=="))).toBe(false);
  });

  it("refuses a witness that is not exactly [DER sig + SIGHASH_ALL, pubkey]", () => {
    const sig = Buffer.from(VECTORS[0].signature, "base64");
    // Replace the trailing SIGHASH_ALL byte of the signature item (offset 2 + 1 + 71 - 1) with SINGLE.
    const single = Buffer.from(sig);
    single[3 + 71 - 1] = 3;
    expect(bip322Verifier.verify(ctxFor("", single.toString("base64")))).toBe(false);
    // A third witness item.
    const extra = Buffer.concat([sig, Buffer.from([0x01, 0x00])]);
    extra[0] = 3;
    expect(bip322Verifier.verify(ctxFor("", extra.toString("base64")))).toBe(false);
    // A key on the proof (the line's own pubkey is the key; nothing else is accepted).
    expect(bip322Verifier.verify({ ...ctxFor("", VECTORS[0].signature), proof: { scheme: "bip322", signature: VECTORS[0].signature, publicKey: vectorPub } })).toBe(false);
    // A subject that is not a compressed pubkey.
    expect(bip322Verifier.verify(ctxFor("", VECTORS[0].signature, VECTOR_ADDRESS))).toBe(false);
  });
});

// -- the account proof -------------------------------------------------------------------------

const BTC = "btc-htlc";
const BTC_CAIP2 = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328";
const CONTRACT = `0x${"ab".repeat(32)}`;
const OTHER_CONTRACT = `0x${"cd".repeat(32)}`;
const buyer = identity("d4".repeat(32));
const seller = identity("e5".repeat(32));
const T0 = 1_758_000_000_000;

/** Stand-in for the node wallet: sign and finalize the PSBT this code built, with a key the test
 *  holds, exactly what `walletprocesspsbt` does for the wallet's own key. Returns the proof. */
function walletSign(priv: Uint8Array, message: string) {
  const pub = bytesToHex(secp256k1.getPublicKey(priv, true));
  const psbt = bip322ProofPsbt(message, pub, { fingerprint: 0xdeadbeef, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] });
  const tx = Transaction.fromPSBT(Buffer.from(psbt, "base64"), { allowUnknownOutputs: true, allowUnknownInputs: true });
  tx.signIdx(priv, 0);
  tx.finalize();
  return { pub, signature: bip322WitnessFromSignedTx(tx.hex) };
}

function lineFor(did: string, contract: string, priv: Uint8Array, claimedPubkey?: string): string {
  const pub = bytesToHex(secp256k1.getPublicKey(priv, true));
  const shown = claimedPubkey ?? pub;
  const signed = walletSign(priv, pubkeyProofMessage({ did, contract, railId: BTC, caip2: BTC_CAIP2, pubkey: shown }));
  return formatPubkeyLine({ railId: BTC, caip2: BTC_CAIP2, pubkey: shown, proof: { scheme: "bip322", signature: signed.signature } });
}

describe("bip322 account proofs", () => {
  const keyA = new Uint8Array(32).fill(11);
  const keyB = new Uint8Array(32).fill(12);
  const pubA = bytesToHex(secp256k1.getPublicKey(keyA, true));
  const pubB = bytesToHex(secp256k1.getPublicKey(keyB, true));
  const room = dealRoom(CONTRACT);
  const input = {
    contract: CONTRACT,
    payerDid: buyer.did,
    payeeDid: seller.did,
    rail: BTC,
    caip2: BTC_CAIP2,
    proof: { mode: "required" } as const,
  };

  it("the PSBT handed to the wallet spends to_spend:0 with amount 0 and pays an OP_RETURN", () => {
    const message = pubkeyProofMessage({ did: buyer.did, contract: CONTRACT, railId: BTC, caip2: BTC_CAIP2, pubkey: pubA });
    const psbt = bip322ProofPsbt(message, pubA, { fingerprint: 1, path: [0x80000054, 0, 0] });
    const tx = Transaction.fromPSBT(Buffer.from(psbt, "base64"), { allowUnknownOutputs: true, allowUnknownInputs: true });
    const input0 = tx.getInput(0);
    expect(tx.version).toBe(0);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(input0.index).toBe(0);
    expect(input0.sequence).toBe(0);
    expect(bytesToHex(input0.txid!)).toBe(bip322Txids(message, pubA).toSpend);
    expect(input0.witnessUtxo?.amount).toBe(0n);
    const out = tx.getOutput(0);
    expect(bytesToHex(out.script!)).toBe("6a");
    expect(out.amount).toBe(0n);
    expect(tx.id).toBe(bip322Txids(message, pubA).toSign);
  });

  it("a wallet-signed proof verifies for this DID, contract, rail and pubkey, and resolves", () => {
    const line = lineFor(buyer.did, CONTRACT, keyA);
    const result = resolvePubkeys([record(room, 1, T0, buyer, line)], input);
    expect(result.payer).toBe(pubA);
    expect(result.reasons).toEqual([]);
  });

  it("a proof by another pubkey's key is refused: A's signature on a line naming B", () => {
    // A signs a message that names B (not its own key), then the line claims B. Refused.
    const message = pubkeyProofMessage({ did: buyer.did, contract: CONTRACT, railId: BTC, caip2: BTC_CAIP2, pubkey: pubB });
    const psbt = bip322ProofPsbt(message, pubA, { fingerprint: 1, path: [0, 0] }); // A's key over B's message
    const tx = Transaction.fromPSBT(Buffer.from(psbt, "base64"), { allowUnknownOutputs: true, allowUnknownInputs: true });
    tx.signIdx(keyA, 0);
    tx.finalize();
    const fromA = bip322WitnessFromSignedTx(tx.hex);
    const line = formatPubkeyLine({ railId: BTC, caip2: BTC_CAIP2, pubkey: pubB, proof: { scheme: "bip322", signature: fromA } });
    const result = resolvePubkeys([record(room, 1, T0, buyer, line)], input);
    expect(result.payer).toBeUndefined();
    expect(result.reasons.join("\n")).toContain("not proven");

    // And a stranger copying A's own proven line for a line naming B's key: the pubkey in the
    // line is what is verified, never the one in the copied witness.
    const aLine = lineFor(buyer.did, CONTRACT, keyA);
    const aSig = aLine.split(" proof bip322:")[1]!;
    const copied = formatPubkeyLine({ railId: BTC, caip2: BTC_CAIP2, pubkey: pubB, proof: { scheme: "bip322", signature: aSig } });
    expect(resolvePubkeys([record(room, 1, T0, buyer, copied)], input).payer).toBeUndefined();
  });

  it("a proof for another DID, contract, rail or chain is refused", () => {
    const victim = lineFor(buyer.did, CONTRACT, keyA);
    // Another sender posting the victim's line.
    expect(resolvePubkeys([record(room, 1, T0, seller, victim)], input).payee).toBeUndefined();
    // The same line in a room for another contract (a mirror pair): the contract differs.
    const mirror = { ...input, contract: OTHER_CONTRACT };
    expect(resolvePubkeys([record(dealRoom(OTHER_CONTRACT), 1, T0, buyer, victim)], mirror).payer).toBeUndefined();
    // A proof made for another contract / DID, posted here.
    expect(resolvePubkeys([record(room, 1, T0, buyer, lineFor(buyer.did, OTHER_CONTRACT, keyA))], input).payer).toBeUndefined();
    expect(resolvePubkeys([record(room, 1, T0, buyer, lineFor(seller.did, CONTRACT, keyA))], input).payer).toBeUndefined();
    // checkLineProof with another chain or rail in the message it rebuilds.
    const good = walletSign(keyA, buildAccountProofMessage({ did: buyer.did, contract: CONTRACT, railId: BTC, account: `${BTC_CAIP2}:${pubA}` }));
    const base = {
      policy: { mode: "required" as const },
      did: buyer.did,
      contract: CONTRACT,
      railId: BTC,
      caip2: BTC_CAIP2,
      account: `${BTC_CAIP2}:${pubA}`,
      subject: pubA,
      proof: { scheme: "bip322", signature: good.signature },
    };
    expect(checkLineProof(base)).toBeNull();
    expect(checkLineProof({ ...base, account: `bip122:000000000933ea01ad0ee984209779ba:${pubA}` })).not.toBeNull();
  });

  it("an eip191 or nep413 scheme is not accepted on the btc rail", () => {
    const line = formatPubkeyLine({ railId: BTC, caip2: BTC_CAIP2, pubkey: pubA, proof: { scheme: "eip191", signature: "ab".repeat(65) } });
    const result = resolvePubkeys([record(room, 1, T0, buyer, line)], input);
    expect(result.payer).toBeUndefined();
    expect(result.reasons.join("\n")).toContain('scheme "eip191" is not accepted for rail "btc-htlc"');
  });

  it("the longest bip322 pubkey line is well inside the room-message cap", () => {
    const line = lineFor(buyer.did, CONTRACT, keyA);
    expect(line.length).toBeLessThan(400);
  });
});
