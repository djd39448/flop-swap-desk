// SPDX-License-Identifier: MIT
//
// tests/near-proof.test.ts -- P7 `nep413`: NEP-413 message signing
// (https://github.com/near/NEPs/blob/master/neps/nep-0413.md) as proof-of-control for a
// `near-htlc` account line. The signed bytes are cross-checked against an independent Borsh
// encoding (`BorshWriter`, the writer the transaction encoder uses), then the account-proof use:
// a proof for another DID, contract, rail, account or key is refused, a key conflict between one
// party's lines is a conflict, and the resolver hands the proven key to the evidence reader.
// Hermetic: keys are generated in memory per run, never printed. (That the key is a FullAccess
// key of the account is the evidence reader's check: tests/near-evidence.test.ts.)

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { dealRoom } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { accountProofMessage, formatAccountLine, parseAccountLine, resolveAccounts } from "../src/rails/account-line.js";
import { buildAccountProofMessage } from "../src/rails/account-proof.js";
import { BorshWriter } from "../src/rails/near-borsh.js";
import {
  decodeNearEd25519Key,
  NEP413_RECIPIENT,
  NEP413_TAG,
  nep413SignedHash,
  nep413Verifier,
  signNep413,
} from "../src/rails/near-proof.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { identity, record } from "./helpers/identity.js";

const NEAR = "near-htlc";
const NEAR_CAIP2 = "near:near-sandbox-flop";
const CONTRACT = `0x${"ab".repeat(32)}`;
const OTHER_CONTRACT = `0x${"cd".repeat(32)}`;
const ROOM = dealRoom(CONTRACT);
const T0 = 1_758_000_000_000;
const buyer = identity("d4".repeat(32));
const seller = identity("e5".repeat(32));

const alice = InMemoryNearSigner.generate("alice.near-sandbox-flop", new Uint8Array(32).fill(21));
const bob = InMemoryNearSigner.generate("bob.near-sandbox-flop", new Uint8Array(32).fill(22));

function messageFor(did: string, contract: string, account: string): string {
  return accountProofMessage({ did, contract, railId: NEAR, caip2: NEAR_CAIP2, address: account });
}

async function lineFor(signer: InMemoryNearSigner, did: string, contract: string, account = signer.accountId): Promise<string> {
  const proof = await signNep413(signer, messageFor(did, contract, account));
  return formatAccountLine({ railId: NEAR, caip2: NEAR_CAIP2, address: account, proof });
}

describe("nep413 signed bytes", () => {
  it("match an independent Borsh encoding of the NEP-413 payload", () => {
    const message = messageFor(buyer.did, CONTRACT, alice.accountId);
    const nonce = sha256(new TextEncoder().encode(message));
    // Borsh(u32 tag) ++ Borsh(Payload { message: String, nonce: [u8; 32], recipient: String, callbackUrl: Option<String> })
    const w = new BorshWriter();
    w.writeU32(NEP413_TAG);
    w.writeString(message);
    w.writeBytes(nonce);
    w.writeString(NEP413_RECIPIENT);
    w.writeU8(0);
    expect(NEP413_TAG).toBe(2 ** 31 + 413);
    expect(bytesToHex(nep413SignedHash(message))).toBe(bytesToHex(sha256(w.toBytes())));
  });

  it("differ for every field of the message", () => {
    const base = bytesToHex(nep413SignedHash(messageFor(buyer.did, CONTRACT, alice.accountId)));
    expect(bytesToHex(nep413SignedHash(messageFor(seller.did, CONTRACT, alice.accountId)))).not.toBe(base);
    expect(bytesToHex(nep413SignedHash(messageFor(buyer.did, OTHER_CONTRACT, alice.accountId)))).not.toBe(base);
    expect(bytesToHex(nep413SignedHash(messageFor(buyer.did, CONTRACT, bob.accountId)))).not.toBe(base);
  });
});

describe("nep413Verifier", () => {
  const message = messageFor(buyer.did, CONTRACT, alice.accountId);
  const ctx = async (over: Partial<{ message: string; subject: string; signer: InMemoryNearSigner; key: string | undefined; sig: string }> = {}) => {
    const proof = await signNep413(over.signer ?? alice, message);
    return {
      message: over.message ?? message,
      railId: NEAR,
      caip2: NEAR_CAIP2,
      subject: over.subject ?? alice.accountId,
      proof: {
        scheme: "nep413",
        signature: over.sig ?? proof.signature,
        ...("key" in over ? (over.key === undefined ? {} : { publicKey: over.key }) : { publicKey: proof.publicKey! }),
      },
    };
  };

  it("accepts the key's signature and refuses everything else", async () => {
    expect(nep413Verifier.verify(await ctx())).toBe(true);
    // Another message; another signer's signature under alice's key; bob's key on alice's signature.
    expect(nep413Verifier.verify(await ctx({ message: `${message}x` }))).toBe(false);
    expect(nep413Verifier.verify(await ctx({ signer: bob, key: alice.publicKey }))).toBe(false);
    expect(nep413Verifier.verify(await ctx({ key: bob.publicKey }))).toBe(false);
    // No key, a non-ed25519 key, a malformed key, a malformed signature.
    expect(nep413Verifier.verify(await ctx({ key: undefined }))).toBe(false);
    expect(nep413Verifier.verify(await ctx({ key: `secp256k1:${alice.publicKey.slice(8)}` }))).toBe(false);
    expect(nep413Verifier.verify(await ctx({ key: "ed25519:notbase58!" }))).toBe(false);
    expect(nep413Verifier.verify(await ctx({ key: `ed25519:${base58.encode(new Uint8Array(31))}` }))).toBe(false);
    expect(nep413Verifier.verify(await ctx({ sig: "ab".repeat(63) }))).toBe(false);
    expect(nep413Verifier.verify(await ctx({ sig: "AB".repeat(64) }))).toBe(false);
  });

  it("a raw ed25519 signature over the message text (not the NEP-413 payload) is refused", async () => {
    const raw = bytesToHex(ed25519.sign(new TextEncoder().encode(message), new Uint8Array(32).fill(21)));
    expect(nep413Verifier.verify(await ctx({ sig: raw }))).toBe(false);
  });

  it("decodes only a 32-byte ed25519 key", () => {
    expect(decodeNearEd25519Key(alice.publicKey)).toEqual(alice.publicKeyRaw());
    expect(decodeNearEd25519Key("ed25519:")).toBeNull();
    expect(decodeNearEd25519Key("rsa:abc")).toBeNull();
  });
});

describe("nep413 account lines under a required proof policy", () => {
  const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: NEAR, caip2: NEAR_CAIP2, proof: { mode: "required" } as const };

  it("the line round-trips through the strict grammar with its key", async () => {
    const line = await lineFor(alice, buyer.did, CONTRACT);
    const parsed = parseAccountLine(line);
    expect(parsed?.proof?.scheme).toBe("nep413");
    expect(parsed?.proof?.publicKey).toBe(alice.publicKey);
    expect(line.length).toBeLessThan(600);
  });

  it("resolves a proven line and hands back the proven key", async () => {
    const line = await lineFor(alice, seller.did, CONTRACT);
    const result = resolveAccounts([record(ROOM, 1, T0, seller, line)], input);
    expect(result.payee).toBe(alice.accountId);
    expect(result.payeeKey).toBe(alice.publicKey);
    expect(result.payerKey).toBeUndefined();
    // The pre-proof fold never reports a key.
    expect(resolveAccounts([record(ROOM, 1, T0, seller, line)], { ...input, proof: { mode: "legacy-unproven" } }).payeeKey).toBeUndefined();
  });

  it("refuses a proof for another DID, contract, account or rail, and a proof by another key", async () => {
    // Made for another sender / contract / account, posted as the seller here.
    expect((resolveAccounts([record(ROOM, 1, T0, seller, await lineFor(alice, buyer.did, CONTRACT))], input)).payee).toBeUndefined();
    expect((resolveAccounts([record(ROOM, 1, T0, seller, await lineFor(alice, seller.did, OTHER_CONTRACT))], input)).payee).toBeUndefined();
    const forAnotherAccount = (await lineFor(alice, seller.did, CONTRACT, alice.accountId)).replace(alice.accountId, bob.accountId);
    expect(resolveAccounts([record(ROOM, 1, T0, seller, forAnotherAccount)], input).payee).toBeUndefined();
    // A message for another rail id cannot be rebuilt into this one.
    const evmMessage = buildAccountProofMessage({ did: seller.did, contract: CONTRACT, railId: "evm-htlc", account: "eip155:1:0xd8da6bf26964af9d7eed9e03e53415d37aa96045" });
    const crossRail = await signNep413(alice, evmMessage);
    const crossLine = formatAccountLine({ railId: NEAR, caip2: NEAR_CAIP2, address: alice.accountId, proof: crossRail });
    expect(resolveAccounts([record(ROOM, 1, T0, seller, crossLine)], input).payee).toBeUndefined();
    // Bob signing for alice's account line: the signature is valid for bob's key over this
    // message, and is accepted as a signature (the key is bob's); whether bob's key controls alice's
    // account is the evidence reader's FullAccess check, which refuses it.
    const bobOnAlice = await signNep413(bob, messageFor(seller.did, CONTRACT, alice.accountId));
    const bobLine = formatAccountLine({ railId: NEAR, caip2: NEAR_CAIP2, address: alice.accountId, proof: bobOnAlice });
    const resolved = resolveAccounts([record(ROOM, 1, T0, seller, bobLine)], input);
    expect(resolved.payee).toBe(alice.accountId);
    expect(resolved.payeeKey).toBe(bob.publicKey);
  });

  it("two proven lines for one account with different keys are a conflict, never a pick", async () => {
    const one = await signNep413(alice, messageFor(seller.did, CONTRACT, alice.accountId));
    const otherKey = InMemoryNearSigner.generate(alice.accountId, new Uint8Array(32).fill(23));
    const two = await signNep413(otherKey, messageFor(seller.did, CONTRACT, alice.accountId));
    const lines = [one, two].map((proof) => formatAccountLine({ railId: NEAR, caip2: NEAR_CAIP2, address: alice.accountId, proof }));
    const result = resolveAccounts(lines.map((l, i) => record(ROOM, i + 1, T0, seller, l)), input);
    expect(result.payee).toBeUndefined();
    expect(result.reasons.join("\n")).toContain("conflicting account lines");
  });

  it("a nep413 line without a key is refused", async () => {
    const proof = await signNep413(alice, messageFor(seller.did, CONTRACT, alice.accountId));
    const { publicKey: _key, ...bare } = proof;
    void _key;
    const line = formatAccountLine({ railId: NEAR, caip2: NEAR_CAIP2, address: alice.accountId, proof: bare });
    expect(resolveAccounts([record(ROOM, 1, T0, seller, line)], input).payee).toBeUndefined();
  });
});
