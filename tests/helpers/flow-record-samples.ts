// SPDX-License-Identifier: MIT
//
// Sample flow records for the P8 resume tests: one fully populated Buyer record and one fully populated Seller
// record (every optional field set, every recovery variant used somewhere), and the forbidden-field scan the fixture
// tests of the four rails already apply to captured files, applied here to anything a flow persists. The keys in the
// samples are throwaway test values; no real key material appears anywhere.

import { createHash } from "node:crypto";
import { dealRoom, OFFER_ROOM } from "@flop-labs/tclk";

import type { BuyerFlowRecord, FlowRecord, SellerFlowRecord } from "../../src/client/flow-record.js";
import { identity } from "./identity.js";

export const SAMPLE_BUYER = identity("a1".repeat(32));
export const SAMPLE_SELLER = identity("b2".repeat(32));
export const SAMPLE_SWAP_ID = `0x${"5a".repeat(32)}`;
export const SAMPLE_CONTRACT_A = `0x${"c1".repeat(32)}`;
export const SAMPLE_CONTRACT_B = `0x${"c2".repeat(32)}`;
export const SAMPLE_PREIMAGE = "0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
export const SAMPLE_STATEMENT = `0x${createHash("sha256").update(Buffer.from(SAMPLE_PREIMAGE.slice(2), "hex")).digest("hex")}`;

const T0 = 1_700_000_000_000;
const frame = (name: string): string => `tclk1 {"sample":"${name}"}`;
const signed = (room: string, seq: number, sender: string, line: string) => ({ room, seq, timestampMs: T0 + seq, sender, nonce: String(10_000 + seq), signature: `sig-${seq}`, line });

export const FORBIDDEN_FIELD_PATTERN = /-----BEGIN|PRIVATE KEY|mnemonic|seed phrase|"secret_key"|"private_key"|"secretKey"|"keypair"/i;

/** The same scan the rail fixture tests apply: throws if `bytes` hold any forbidden field name or key marker. */
export function assertNoForbiddenFields(bytes: Uint8Array | string, label = "record"): void {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  const hit = FORBIDDEN_FIELD_PATTERN.exec(text);
  if (hit !== null) throw new Error(`${label}: contains the forbidden token ${JSON.stringify(hit[0])}`);
}

export function sampleBuyerRecord(): BuyerFlowRecord {
  const roomA = dealRoom(SAMPLE_CONTRACT_A);
  const roomB = dealRoom(SAMPLE_CONTRACT_B);
  return {
    v: 1,
    role: "buyer",
    swapId: SAMPLE_SWAP_ID,
    did: SAMPLE_BUYER.did,
    railId: "btc-htlc",
    caip2: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
    deploymentId: "btc:bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
    createdAtMs: T0,
    updatedAtMs: T0 + 5_000,
    revision: 9,
    frames: {
      offerA: { text: frame("offer-a"), record: signed(OFFER_ROOM, 1, SAMPLE_BUYER.did, frame("offer-a")) },
      acceptA: { text: frame("accept-a"), record: signed(OFFER_ROOM, 2, SAMPLE_SELLER.did, frame("accept-a")) },
      offerB: { text: frame("offer-b"), record: signed(OFFER_ROOM, 3, SAMPLE_SELLER.did, frame("offer-b")) },
      acceptB: { text: frame("accept-b"), record: signed(OFFER_ROOM, 4, SAMPLE_BUYER.did, frame("accept-b")) },
    },
    contractA: SAMPLE_CONTRACT_A,
    contractB: SAMPLE_CONTRACT_B,
    lockTimeMs: T0 + 30 * 60_000,
    legB: { claimByMs: T0 + 12 * 3_600_000, refundAfterMs: T0 + 24 * 3_600_000, expiresMs: T0 + 3_600_000 },
    ledger: [
      { kind: "offer-a", room: OFFER_ROOM, text: frame("offer-a"), landed: { seq: 1, nonce: "10001" } },
      { kind: "accept-b", room: OFFER_ROOM, text: frame("accept-b"), landed: { seq: 4, nonce: "10004" } },
      { kind: "account-a", room: roomA, text: "acct btc-htlc sample-pubkey-line", landed: { seq: 1, nonce: null } },
      { kind: "lock-a", room: roomA, text: frame("lock-a") },
      { kind: "reveal-b", room: roomB, text: `sha256:${"3c".repeat(32)}` }, // a Buyer holds only the digest of its reveal text (R1-18)
    ],
    legBVerified: true,
    ownAccountLine: { address: "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627", text: "acct btc-htlc sample-pubkey-line" },
    lock: {
      attempted: true,
      prepared: { ref: `${"ab".repeat(32)}:1`, recovery: { chain: "btc", txid: "ab".repeat(32), rawTx: "02000000000101deadbeef" } },
      fromBlock: { kind: "number", value: "200" },
      accounts: { payer: "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627", payee: "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a" },
      hashLock: SAMPLE_STATEMENT,
      evidence: { ref: `${"ab".repeat(32)}:1`, raw: ["11".repeat(32), "22".repeat(32)], txid: "ab".repeat(32), blockHeight: null, blockHash: null },
      framePosted: false,
    },
    legBClaimAttempted: true,
    legBClaimed: false,
    legBClaimAdopted: true, // R1-06: leg B's note read claimed with the secret and this flow's own claim never returned
    refund: {
      attempted: true,
      recovery: { chain: "btc", txid: "cd".repeat(32), rawTx: "02000000000102cafebabe" },
      evidence: { ref: `${"ab".repeat(32)}:1`, raw: [], txid: "cd".repeat(32), blockHeight: 205, blockHash: "ee".repeat(32), rawTx: "02000000000102cafebabe" },
      framesPosted: false,
      claimSeen: true, // R1-15
    },
    refundNotes: ["leg B's paper note reads claimed but is not a proven claim: ignored (R4-1)"],
  };
}

export function sampleSellerRecord(): SellerFlowRecord {
  const roomA = dealRoom(SAMPLE_CONTRACT_A);
  const roomB = dealRoom(SAMPLE_CONTRACT_B);
  return {
    v: 1,
    role: "seller",
    swapId: SAMPLE_SWAP_ID,
    did: SAMPLE_SELLER.did,
    railId: "trustcore.sol-htlc-v1",
    caip2: "solana:localnet-flop",
    deploymentId: "sol:program-sample:mint-sample",
    createdAtMs: T0,
    updatedAtMs: T0 + 9_000,
    revision: 12,
    frames: {
      offerA: { text: frame("offer-a"), record: signed(OFFER_ROOM, 1, SAMPLE_BUYER.did, frame("offer-a")) },
      acceptA: { text: frame("accept-a") },
      offerB: { text: frame("offer-b") },
      acceptB: { text: frame("accept-b"), record: signed(OFFER_ROOM, 4, SAMPLE_BUYER.did, frame("accept-b")) },
    },
    contractA: SAMPLE_CONTRACT_A,
    contractB: SAMPLE_CONTRACT_B,
    lockTimeMs: T0 + 30 * 60_000,
    legB: { claimByMs: T0 + 12 * 3_600_000, refundAfterMs: T0 + 24 * 3_600_000, expiresMs: T0 + 3_600_000 },
    ledger: [
      { kind: "accept-a", room: OFFER_ROOM, text: frame("accept-a"), landed: { seq: 2, nonce: "10002" } },
      { kind: "offer-b", room: OFFER_ROOM, text: frame("offer-b"), landed: { seq: 3, nonce: "10003" } },
      { kind: "account-a", room: roomA, text: "acct sol sample-wallet-line", landed: { seq: 2, nonce: "10002" } },
      { kind: "lock-b", room: roomB, text: frame("lock-b") },
      { kind: "reveal-a", room: roomA, text: frame("reveal-a") },
    ],
    preimage: SAMPLE_PREIMAGE,
    statement: SAMPLE_STATEMENT,
    attemptedAcceptB: SAMPLE_CONTRACT_B,
    lockedLegBContract: SAMPLE_CONTRACT_B,
    frozenLegAAccounts: { payer: "BuyerWallet11111111111111111111111111111111", payee: "SellerWallet1111111111111111111111111111111" },
    frozenLegARailRef: `${SAMPLE_STATEMENT}:BuyerWallet11111111111111111111111111111111`,
    claimAttempted: true,
    claimFromBlock: { kind: "bigint", value: "1234" }, // R1-13
    claimRecords: [
      { signature: "sig-one", blockhash: "hash-one", lastValidBlockHeight: 5_082, signedSlot: 5_031 },
      { signature: "sig-two", blockhash: "hash-two", lastValidBlockHeight: 5_300 },
    ],
    publicClaimSignature: "sig-failed-public",
    neverLandedClaims: 1,
    claimOutcome: "failed-public",
    revealPosted: false,
    receiptPosted: false,
    legBRefund: { attempted: false, done: false, framesPosted: false },
  };
}

export function sampleRecords(): FlowRecord[] {
  return [sampleBuyerRecord(), sampleSellerRecord()];
}
