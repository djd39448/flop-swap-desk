// SPDX-License-Identifier: MIT
//
// P7: hermetic stand-ins for each chain's signer, so a test can post the PROVEN account/pubkey line
// every resolver now requires (handoff/P7-ACCOUNT-PROOF-SPEC.md). Keys are derived from a tag in
// memory and never printed; the live suites use the real node signers instead.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { hashMessage, getAddress } from "viem";
import { publicKeyToAddress } from "viem/utils";

import { accountProofMessage, formatAccountLine, formatPubkeyLine, pubkeyProofMessage } from "../../src/rails/account-line.js";
import { bip322ProofPsbt, bip322WitnessFromSignedTx } from "../../src/rails/btc-proof.js";
import { nep413SignedHash } from "../../src/rails/near-proof.js";
import { InMemoryNearSigner } from "../../src/rails/near-signer-memory.js";

function seed32(tag: number): Uint8Array {
  const bytes = new Uint8Array(32).fill(1);
  bytes[0] = tag & 0xff;
  bytes[1] = (tag >> 8) & 0xff;
  return bytes;
}

/** An EVM account whose key the test holds: `address` (EIP-55) and `line(...)` (an EIP-191 proof,
 *  signed synchronously with noble so a test's row builders stay synchronous). */
export function evmSigner(tag: number) {
  const priv = seed32(tag);
  const address = getAddress(publicKeyToAddress(`0x${bytesToHex(secp256k1.getPublicKey(priv, false))}`));
  /** EIP-191 personal_sign of a UTF-8 message: 65 bytes as hex, no 0x prefix. */
  const signPersonal = (message: string): string => {
    const digest = hashMessage(message).slice(2);
    const sig = secp256k1.sign(hexToBytes(digest), priv, { prehash: false, format: "recovered" });
    // noble "recovered": recovery byte first, then r || s. EIP-191: r || s || (27 + recovery).
    return bytesToHex(new Uint8Array([...sig.slice(1), 27 + sig[0]!]));
  };
  return {
    address,
    signPersonal,
    line(input: { did: string; contract: string; caip2: string; address?: string }): string {
      const shown = input.address ?? address;
      const message = accountProofMessage({ did: input.did, contract: input.contract, railId: "evm-htlc", caip2: input.caip2, address: shown });
      const signature = signPersonal(message);
      return formatAccountLine({ railId: "evm-htlc", caip2: input.caip2, address: shown, proof: { scheme: "eip191", signature } });
    },
  };
}

/** A Bitcoin key: `pubkey` (compressed hex) and `line(...)` (a BIP-322 proof, signed the way the
 *  node wallet signs the PSBT). */
export function btcSigner(tag: number) {
  const priv = seed32(tag);
  const pubkey = bytesToHex(secp256k1.getPublicKey(priv, true));
  return {
    pubkey,
    line(input: { did: string; contract: string; caip2: string; pubkey?: string }): string {
      const shown = input.pubkey ?? pubkey;
      const message = pubkeyProofMessage({ did: input.did, contract: input.contract, railId: "btc-htlc", caip2: input.caip2, pubkey: shown });
      const psbt = bip322ProofPsbt(message, pubkey, { fingerprint: 0xdeadbeef, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] });
      const tx = Transaction.fromPSBT(Buffer.from(psbt, "base64"), { allowUnknownOutputs: true, allowUnknownInputs: true });
      tx.signIdx(priv, 0);
      tx.finalize();
      const signature = bip322WitnessFromSignedTx(tx.hex);
      return formatPubkeyLine({ railId: "btc-htlc", caip2: input.caip2, pubkey: shown, proof: { scheme: "bip322", signature } });
    },
  };
}

/** A NEAR account with an in-memory key: `line(...)` is a NEP-413 proof carrying the key. */
export function nearSigner(accountId: string, tag: number) {
  const signer = InMemoryNearSigner.generate(accountId, seed32(tag));
  return {
    signer,
    accountId,
    publicKey: signer.publicKey,
    line(input: { did: string; contract: string; caip2: string }): string {
      const message = accountProofMessage({ did: input.did, contract: input.contract, railId: "near-htlc", caip2: input.caip2, address: accountId });
      const signature = bytesToHex(signer.sign(nep413SignedHash(message)));
      return formatAccountLine({
        railId: "near-htlc",
        caip2: input.caip2,
        address: accountId,
        proof: { scheme: "nep413", signature, publicKey: signer.publicKey },
      });
    },
  };
}
