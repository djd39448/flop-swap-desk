// SPDX-License-Identifier: MIT
//
// tests/account-proof.test.ts — P7-ACCOUNT-PROOF-SPEC.md (proof-of-control account lines), shared
// core: the exact message, the trailing `proof` field grammar, the verifier interface, the two
// verifiers that exist without a rail (eip191, ed25519), and `resolveAccounts`/`resolvePubkeys`
// counting only lines whose proof verifies for this sender DID, contract, rail and account.
// Hermetic: keys are generated in memory per run, never printed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { dealRoom, MAX_FRAME_CHARS } from "@flop-labs/tclk";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  accountProofMessage,
  formatAccountLine,
  formatPubkeyLine,
  parseAccountLine,
  parsePubkeyLine,
  pubkeyProofMessage,
  resolveAccounts,
  resolvePubkeys,
} from "../src/rails/account-line.js";
import {
  ACCOUNT_PROOF_MESSAGE_PREFIX,
  buildAccountProofMessage,
  createProofVerifierRegistry,
  DEFAULT_PROOF_VERIFIERS,
  ed25519Verifier,
  eip191Verifier,
  formatProofField,
  type AccountProof,
  type AccountProofVerifier,
} from "../src/rails/account-proof.js";
import { identity, record } from "./helpers/identity.js";

const T0 = 1_758_000_000_000;
const buyer = identity("d4".repeat(32));
const seller = identity("e5".repeat(32));
const stranger = identity("f6".repeat(32));

const CONTRACT = `0x${"ab".repeat(32)}`;
const OTHER_CONTRACT = `0x${"cd".repeat(32)}`;
const ROOM = dealRoom(CONTRACT);
const OTHER_ROOM = dealRoom(OTHER_CONTRACT);

const EVM = "evm-htlc";
const EVM_CAIP2 = "eip155:31337";
const REQUIRED = { mode: "required" } as const;

function toHexNoPrefix(sigHex: string): string {
  return sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex;
}

const chainKey = privateKeyToAccount(generatePrivateKey());
const otherChainKey = privateKeyToAccount(generatePrivateKey());

async function eipProof(signer: typeof chainKey, message: string): Promise<AccountProof> {
  return { scheme: "eip191", signature: toHexNoPrefix(await signer.signMessage({ message })) };
}

describe("buildAccountProofMessage", () => {
  const base = {
    did: buyer.did,
    contract: CONTRACT,
    railId: EVM,
    account: `${EVM_CAIP2}:0xd8da6bf26964af9d7eed9e03e53415d37aa96045`,
  };

  it("is exactly FLOP::swap::account-proof::v1|did|contract|rail|account", () => {
    expect(ACCOUNT_PROOF_MESSAGE_PREFIX).toBe("FLOP::swap::account-proof::v1");
    expect(buildAccountProofMessage(base)).toBe(
      `FLOP::swap::account-proof::v1|${buyer.did}|${CONTRACT}|evm-htlc|eip155:31337:0xd8da6bf26964af9d7eed9e03e53415d37aa96045`,
    );
  });

  it("differs when any one field differs", () => {
    const m = buildAccountProofMessage(base);
    expect(buildAccountProofMessage({ ...base, did: seller.did })).not.toBe(m);
    expect(buildAccountProofMessage({ ...base, contract: OTHER_CONTRACT })).not.toBe(m);
    expect(buildAccountProofMessage({ ...base, railId: "near-htlc", account: "near:testnet:alice.testnet" })).not.toBe(m);
    expect(buildAccountProofMessage({ ...base, account: `${EVM_CAIP2}:0x${"11".repeat(20)}` })).not.toBe(m);
  });

  it("refuses non-canonical or separator-bearing fields", () => {
    expect(() => buildAccountProofMessage({ ...base, did: "did:key:z6Mk|x" })).toThrow();
    expect(() => buildAccountProofMessage({ ...base, did: "not-a-did" })).toThrow();
    expect(() => buildAccountProofMessage({ ...base, contract: "0xAB" })).toThrow();
    expect(() => buildAccountProofMessage({ ...base, contract: CONTRACT.toUpperCase() })).toThrow();
    expect(() => buildAccountProofMessage({ ...base, railId: "EVM-HTLC" })).toThrow();
    expect(() => buildAccountProofMessage({ ...base, railId: "nope-htlc" })).toThrow();
    expect(() => buildAccountProofMessage({ ...base, account: `${base.account}|x` })).toThrow();
    expect(() => buildAccountProofMessage({ ...base, account: `${base.account}\n` })).toThrow();
  });
});

describe("the proof field grammar", () => {
  const address = chainKey.address;
  const sig = "ab".repeat(65);

  it("formats and parses an account line with a proof, and one without", () => {
    const proof = { scheme: "eip191", signature: sig };
    const line = formatAccountLine({ railId: EVM, caip2: EVM_CAIP2, address, proof });
    expect(line).toBe(`swap1 account evm-htlc eip155:31337:${address.toLowerCase()} proof eip191:${sig}`);
    expect(parseAccountLine(line)).toEqual({
      railId: EVM,
      caip2: EVM_CAIP2,
      address: address.toLowerCase(),
      proof,
    });
    const bare = formatAccountLine({ railId: EVM, caip2: EVM_CAIP2, address });
    expect(parseAccountLine(bare)?.proof).toBeUndefined();
  });

  it("carries an optional key token", () => {
    const proof = { scheme: "nep413", signature: "sigsig", publicKey: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp" };
    const line = formatAccountLine({ railId: "near-htlc", caip2: "near:testnet", address: "alice.testnet", proof });
    expect(parseAccountLine(line)?.proof).toEqual(proof);
  });

  it("carries a proof on a pubkey line", () => {
    const pubkey = `02${"11".repeat(32)}`;
    const clean = { scheme: "bip322", signature: "AkcwRAIg" };
    const line = formatPubkeyLine({ railId: "btc-htlc", caip2: "bip122:000000000019d6689c085ae165831e93", pubkey, proof: clean });
    expect(parsePubkeyLine(line)?.proof).toEqual(clean);
  });

  it("a malformed proof makes the whole line unparseable", () => {
    const base = `swap1 account evm-htlc eip155:31337:${address.toLowerCase()}`;
    expect(parseAccountLine(`${base} proof`)).toBeNull();
    expect(parseAccountLine(`${base} proof eip191`)).toBeNull(); // no colon
    expect(parseAccountLine(`${base} proof :abc`)).toBeNull(); // empty scheme
    expect(parseAccountLine(`${base} proof EIP191:abc`)).toBeNull(); // scheme case
    expect(parseAccountLine(`${base} proof eip191:`)).toBeNull(); // empty signature
    expect(parseAccountLine(`${base} proof eip191:a b|`)).toBeNull(); // the second token is the key: `|` is not a key character
    expect(parseAccountLine(`${base} proof eip191:abc k1 k2`)).toBeNull(); // too many tokens
    expect(parseAccountLine(`${base} proof eip191:abc `)).toBeNull(); // trailing space
    expect(parseAccountLine(`${base} notproof eip191:abc`)).toBeNull();
    expect(parseAccountLine(`${base} proof eip191:a|b`)).toBeNull();
    expect(() => formatProofField({ scheme: "Bad", signature: "x" })).toThrow();
    expect(() => formatProofField({ scheme: "eip191", signature: "x y" })).toThrow();
  });

  it("records the longest line per rail and keeps every one inside the room-message cap", () => {
    const longRef = "a".repeat(32);
    const evm = formatAccountLine({
      railId: EVM,
      caip2: `eip155:${"9".repeat(32)}`,
      address,
      proof: { scheme: "eip191", signature: "ff".repeat(65) },
    });
    const near = formatAccountLine({
      railId: "near-htlc",
      caip2: `near:${longRef}`,
      address: `${"a".repeat(31)}.${"b".repeat(32)}`,
      proof: {
        scheme: "nep413",
        signature: base58.encode(new Uint8Array(64).fill(255)), // 64-byte ed25519 signature
        publicKey: `ed25519:${base58.encode(new Uint8Array(32).fill(255))}`,
      },
    });
    const btc = formatPubkeyLine({
      railId: "btc-htlc",
      caip2: `bip122:${"f".repeat(32)}`,
      pubkey: `03${"ff".repeat(32)}`,
      proof: { scheme: "bip322", signature: Buffer.alloc(110, 255).toString("base64") }, // P2WPKH simple witness, padded
    });
    const lengths = { evm: evm.length, near: near.length, btc: btc.length };
    expect(lengths).toEqual({ evm: 249, near: 281, btc: 290 });
    for (const length of Object.values(lengths)) expect(length).toBeLessThan(MAX_FRAME_CHARS);
    // over the cap: refused at parse time whatever the shape
    expect(parseAccountLine(`${evm}${" ".repeat(MAX_FRAME_CHARS)}`)).toBeNull();
  });
});

describe("eip191 verifier", () => {
  const message = buildAccountProofMessage({
    did: buyer.did,
    contract: CONTRACT,
    railId: EVM,
    account: `${EVM_CAIP2}:${chainKey.address.toLowerCase()}`,
  });
  const ctx = (signature: string, subject: string, m = message) => ({
    message: m,
    railId: EVM,
    caip2: EVM_CAIP2,
    subject,
    proof: { scheme: "eip191", signature },
  });

  it("accepts a personal_sign signature by the account and agrees with viem's recoverMessageAddress", async () => {
    const signature = toHexNoPrefix(await chainKey.signMessage({ message }));
    expect(signature).toHaveLength(130);
    const recovered = await recoverMessageAddress({ message, signature: `0x${signature}` });
    expect(recovered.toLowerCase()).toBe(chainKey.address.toLowerCase());
    expect(eip191Verifier.verify(ctx(signature, chainKey.address.toLowerCase()))).toBe(true);
  });

  it("refuses another account, another message, a flipped bit, a bad v and junk", async () => {
    const signature = toHexNoPrefix(await chainKey.signMessage({ message }));
    expect(eip191Verifier.verify(ctx(signature, otherChainKey.address.toLowerCase()))).toBe(false);
    expect(eip191Verifier.verify(ctx(signature, chainKey.address.toLowerCase(), `${message}x`))).toBe(false);
    const flipped = `${signature.slice(0, 10)}${signature[10] === "0" ? "1" : "0"}${signature.slice(11)}`;
    expect(eip191Verifier.verify(ctx(flipped, chainKey.address.toLowerCase()))).toBe(false);
    const badV = `${signature.slice(0, 128)}1d`;
    expect(eip191Verifier.verify(ctx(badV, chainKey.address.toLowerCase()))).toBe(false);
    expect(eip191Verifier.verify(ctx("zz".repeat(65), chainKey.address.toLowerCase()))).toBe(false);
    expect(eip191Verifier.verify(ctx("ab", chainKey.address.toLowerCase()))).toBe(false);
    expect(eip191Verifier.verify(ctx(`0x${signature}`, chainKey.address.toLowerCase()))).toBe(false); // canonical form is bare hex
  });

  it("F5: refuses the high-s twin of a valid signature (proofs are canonical)", async () => {
    const signature = toHexNoPrefix(await chainKey.signMessage({ message }));
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${signature.slice(64, 128)}`);
    expect(s <= n / 2n).toBe(true); // the signer produces low-s
    const v = parseInt(signature.slice(128), 16);
    const twin = `${signature.slice(0, 64)}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
    expect(eip191Verifier.verify(ctx(signature, chainKey.address.toLowerCase()))).toBe(true);
    expect(eip191Verifier.verify(ctx(twin, chainKey.address.toLowerCase()))).toBe(false);
  });
});

describe("ed25519 verifier (Solana-style address = key, and NEAR's signature step)", () => {
  const seed = new Uint8Array(32).fill(7);
  const publicKey = ed25519.getPublicKey(seed);
  const address = base58.encode(publicKey);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const message = buildAccountProofMessage({
    did: buyer.did,
    contract: CONTRACT,
    railId: "near-htlc",
    account: `near:testnet:${"x".repeat(8)}`,
  });
  const sign = (m: string) => hex(ed25519.sign(new TextEncoder().encode(m), seed));
  const ctx = (signature: string, subject: string, publicKeyHex?: string, m = message) => ({
    message: m,
    railId: "near-htlc",
    caip2: "near:testnet",
    subject,
    proof: { scheme: "ed25519", signature, ...(publicKeyHex === undefined ? {} : { publicKey: publicKeyHex }) },
  });

  it("verifies by the base58 address alone, or by an explicit key token", () => {
    const signature = sign(message);
    expect(ed25519Verifier.verify(ctx(signature, address))).toBe(true);
    expect(ed25519Verifier.verify(ctx(signature, "alice.testnet", hex(publicKey)))).toBe(true);
  });

  it("refuses a wrong message, a wrong key, a key that is not the address, and junk", () => {
    const signature = sign(message);
    expect(ed25519Verifier.verify(ctx(signature, address, undefined, `${message}x`))).toBe(false);
    const otherKey = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    expect(ed25519Verifier.verify(ctx(signature, "alice.testnet", hex(otherKey)))).toBe(false);
    expect(ed25519Verifier.verify(ctx(signature, address, hex(otherKey)))).toBe(false); // key token must equal the address key
    expect(ed25519Verifier.verify(ctx(signature, "alice.testnet"))).toBe(false); // nothing names a key
    expect(ed25519Verifier.verify(ctx("00".repeat(64), address))).toBe(false);
    expect(ed25519Verifier.verify(ctx("abcd", address))).toBe(false);
    expect(ed25519Verifier.verify(ctx(signature, address, "zz"))).toBe(false);
  });
});

describe("the registry", () => {
  it("holds the four schemes this build verifies", () => {
    expect([...DEFAULT_PROOF_VERIFIERS.keys()].sort()).toEqual(["bip322", "ed25519", "eip191", "nep413"]);
  });
  it("refuses a duplicate scheme", () => {
    expect(() => createProofVerifierRegistry([eip191Verifier, eip191Verifier])).toThrow();
  });
});

describe("resolveAccounts under a required proof policy (EVM)", () => {
  const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: EVM, caip2: EVM_CAIP2, proof: REQUIRED };

  async function line(opts: {
    signer?: typeof chainKey;
    lineAddress?: string;
    did?: string;
    contract?: string;
    messageAddress?: string;
    messageRail?: string;
  }): Promise<string> {
    const signer = opts.signer ?? chainKey;
    const lineAddress = opts.lineAddress ?? signer.address;
    const message = buildAccountProofMessage({
      did: opts.did ?? buyer.did,
      contract: opts.contract ?? CONTRACT,
      railId: opts.messageRail ?? EVM,
      account: `${EVM_CAIP2}:${(opts.messageAddress ?? lineAddress).toLowerCase()}`,
    });
    return formatAccountLine({
      railId: EVM,
      caip2: EVM_CAIP2,
      address: lineAddress,
      proof: await eipProof(signer, message),
    });
  }

  it("a proof for this DID, contract, rail and account resolves", async () => {
    const records = [record(ROOM, 1, T0, buyer, await line({}))];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBe(chainKey.address.toLowerCase());
    expect(result.reasons).toEqual([]);
  });

  it("a line without a proof is unresolved", async () => {
    const bare = formatAccountLine({ railId: EVM, caip2: EVM_CAIP2, address: chainKey.address });
    const result = resolveAccounts([record(ROOM, 1, T0, buyer, bare)], input);
    expect(result.payer).toBeUndefined();
    expect(result.reasons.join("\n")).toContain("no proof");
  });

  it("a proof over another DID is refused (wrong DID)", async () => {
    // The seller's DID was signed; the buyer posts it.
    const records = [record(ROOM, 1, T0, buyer, await line({ did: seller.did }))];
    const result = resolveAccounts(records, input);
    expect(result.payer).toBeUndefined();
    expect(result.reasons.join("\n")).toContain("does not verify");
  });

  it("a proof over another contract is refused (wrong contract)", async () => {
    const records = [record(ROOM, 1, T0, buyer, await line({ contract: OTHER_CONTRACT }))];
    expect(resolveAccounts(records, input).payer).toBeUndefined();
  });

  it("a proof over another rail is refused (wrong rail)", async () => {
    const records = [record(ROOM, 1, T0, buyer, await line({ messageRail: "btc-htlc" }))];
    expect(resolveAccounts(records, input).payer).toBeUndefined();
  });

  it("a proof over another account is refused (wrong account)", async () => {
    // Signed by the real key, but for a different address than the line names.
    const records = [record(ROOM, 1, T0, buyer, await line({ messageAddress: otherChainKey.address }))];
    expect(resolveAccounts(records, input).payer).toBeUndefined();
  });

  it("a line naming an account the signing key does not control is refused", async () => {
    // The key signs the exact message for the victim's address, but it is not the victim's key.
    const victim = otherChainKey.address;
    const records = [record(ROOM, 1, T0, buyer, await line({ signer: chainKey, lineAddress: victim }))];
    expect(resolveAccounts(records, input).payer).toBeUndefined();
  });

  it("malformed proofs are unresolved: junk signature, wrong scheme, unregistered scheme", async () => {
    const good = await line({});
    const junk = good.replace(/proof eip191:[0-9a-f]+/, `proof eip191:${"00".repeat(65)}`);
    const schemeNotForRail = good.replace("proof eip191:", "proof ed25519:");
    const noVerifier = good.replace("proof eip191:", "proof bip322:");
    const structurally = `${good.split(" proof ")[0]} proof eip191`; // unparseable, dropped as a non-line
    for (const l of [junk, schemeNotForRail, noVerifier, structurally]) {
      expect(resolveAccounts([record(ROOM, 1, T0, buyer, l)], input).payer).toBeUndefined();
    }
  });

  it("the mirror attack: a stranger replays the victim's proven line into a mirror contract's room", async () => {
    const victimLine = await line({}); // proven for buyer + CONTRACT
    const mirrorInput = { ...input, contract: OTHER_CONTRACT, payerDid: stranger.did };
    // verbatim, posted by the stranger as their own claim in the mirror room
    const verbatim = resolveAccounts([record(OTHER_ROOM, 1, T0, stranger, victimLine)], mirrorInput);
    expect(verbatim.payer).toBeUndefined();
    // and the stranger cannot sign as the victim's DID (the record would not verify)
    const asVictim = resolveAccounts([record(OTHER_ROOM, 1, T0, buyer, victimLine)], { ...input, contract: OTHER_CONTRACT });
    expect(asVictim.payer).toBeUndefined();
    // the victim still resolves in the victim's own room
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, victimLine)], input).payer).toBe(chainKey.address.toLowerCase());
  });

  it("existing rules are unchanged: sender binding, before-the-lock, conflicts, other rooms", async () => {
    const buyerLine = await line({});
    const sellerLine = await line({ did: seller.did, signer: otherChainKey });
    const both = resolveAccounts([record(ROOM, 1, T0, buyer, buyerLine), record(ROOM, 2, T0, seller, sellerLine)], input);
    expect(both.payer).toBe(chainKey.address.toLowerCase());
    expect(both.payee).toBe(otherChainKey.address.toLowerCase());

    // a proven line at or after the accepted lock is ignored
    expect(resolveAccounts([record(ROOM, 5, T0, buyer, buyerLine)], { ...input, beforeSeq: 5 }).payer).toBeUndefined();
    expect(resolveAccounts([record(ROOM, 4, T0, buyer, buyerLine)], { ...input, beforeSeq: 5 }).payer).toBe(
      chainKey.address.toLowerCase(),
    );

    // a proven line in another room does not count
    expect(resolveAccounts([record(OTHER_ROOM, 1, T0, buyer, buyerLine)], input).payer).toBeUndefined();

    // two proven, disagreeing lines from one party: unresolved, not first-wins
    const second = await line({ signer: otherChainKey });
    const conflict = resolveAccounts([record(ROOM, 1, T0, buyer, buyerLine), record(ROOM, 2, T0, buyer, second)], input);
    expect(conflict.payer).toBeUndefined();
    expect(conflict.reasons.join("\n")).toContain("conflicting account lines");

    // an unproven junk line does not turn a proven line into a conflict
    const bare = formatAccountLine({ railId: EVM, caip2: EVM_CAIP2, address: otherChainKey.address });
    const mixed = resolveAccounts([record(ROOM, 1, T0, buyer, buyerLine), record(ROOM, 2, T0, buyer, bare)], input);
    expect(mixed.payer).toBe(chainKey.address.toLowerCase());
  });

  it("a pluggable verifier decides: a custom scheme is honoured only when allowed for the rail", async () => {
    const always: AccountProofVerifier = { scheme: "always", verify: () => true };
    const never: AccountProofVerifier = { scheme: "always", verify: () => false };
    const l = formatAccountLine({
      railId: EVM,
      caip2: EVM_CAIP2,
      address: chainKey.address,
      proof: { scheme: "always", signature: "x" },
    });
    const records = [record(ROOM, 1, T0, buyer, l)];
    const policyFor = (v: AccountProofVerifier, allowedSchemes?: string[]) => ({
      mode: "required" as const,
      verifiers: createProofVerifierRegistry([v]),
      ...(allowedSchemes === undefined ? {} : { allowedSchemes }),
    });
    expect(resolveAccounts(records, { ...input, proof: policyFor(always) }).payer).toBeUndefined(); // not allowed for evm-htlc
    expect(resolveAccounts(records, { ...input, proof: policyFor(always, ["always"]) }).payer).toBe(
      chainKey.address.toLowerCase(),
    );
    expect(resolveAccounts(records, { ...input, proof: policyFor(never, ["always"]) }).payer).toBeUndefined();
  });

  it("the legacy-unproven policy ignores proofs entirely (the pre-P7 fold)", () => {
    const bare = formatAccountLine({ railId: EVM, caip2: EVM_CAIP2, address: chainKey.address });
    const result = resolveAccounts([record(ROOM, 1, T0, buyer, bare)], { ...input, proof: { mode: "legacy-unproven" } });
    expect(result.payer).toBe(chainKey.address.toLowerCase());
  });
});

describe("resolveAccounts with ed25519 (Solana-style, allowed explicitly)", () => {
  const seed = new Uint8Array(32).fill(3);
  const pub = ed25519.getPublicKey(seed);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const NEAR = "near-htlc";
  const NEAR_CAIP2 = "near:testnet";
  const policy = { mode: "required" as const, allowedSchemes: ["ed25519"] };
  const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: NEAR, caip2: NEAR_CAIP2, proof: policy };

  function nearLine(did: string, contract: string, account: string, key: Uint8Array): string {
    const message = buildAccountProofMessage({ did, contract, railId: NEAR, account: `${NEAR_CAIP2}:${account}` });
    const signature = hex(ed25519.sign(new TextEncoder().encode(message), seed));
    return formatAccountLine({
      railId: NEAR,
      caip2: NEAR_CAIP2,
      address: account,
      proof: { scheme: "ed25519", signature, publicKey: hex(key) },
    });
  }

  it("resolves a proven line and refuses wrong DID / contract / account / key", () => {
    const ok = nearLine(buyer.did, CONTRACT, "alice.testnet", pub);
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, ok)], input).payer).toBe("alice.testnet");
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, nearLine(seller.did, CONTRACT, "alice.testnet", pub))], input).payer).toBeUndefined();
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, nearLine(buyer.did, OTHER_CONTRACT, "alice.testnet", pub))], input).payer).toBeUndefined();
    const wrongAccount = ok.replace("alice.testnet", "bob.testnet");
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, wrongAccount)], input).payer).toBeUndefined();
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(4));
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, nearLine(buyer.did, CONTRACT, "alice.testnet", otherPub))], input).payer).toBeUndefined();
  });

  it("a nep413 line is unresolved when no nep413 verifier is registered, and when its signature is junk", () => {
    const l = formatAccountLine({
      railId: NEAR,
      caip2: NEAR_CAIP2,
      address: "alice.testnet",
      proof: { scheme: "nep413", signature: "abc", publicKey: "ed25519:abc" },
    });
    const bare = createProofVerifierRegistry([eip191Verifier, ed25519Verifier]);
    const result = resolveAccounts([record(ROOM, 1, T0, buyer, l)], { ...input, proof: { mode: "required", verifiers: bare } });
    expect(result.payer).toBeUndefined();
    expect(result.reasons.join("\n")).toContain('no verifier for scheme "nep413"');
    const junk = resolveAccounts([record(ROOM, 1, T0, buyer, l)], { ...input, proof: REQUIRED });
    expect(junk.payer).toBeUndefined();
    expect(junk.reasons.join("\n")).toContain("proof does not verify");
  });
});

describe("resolvePubkeys under a required proof policy", () => {
  const BTC = "btc-htlc";
  const BTC_CAIP2 = "bip122:000000000019d6689c085ae165831e93";
  const pubkey = `02${"11".repeat(32)}`;
  const input = { contract: CONTRACT, payerDid: buyer.did, payeeDid: seller.did, rail: BTC, caip2: BTC_CAIP2, proof: REQUIRED };

  it("a pubkey line without a proof, or with a bip322 proof that does not verify (or has no verifier), is unresolved", () => {
    const bare = formatPubkeyLine({ railId: BTC, caip2: BTC_CAIP2, pubkey });
    const r1 = resolvePubkeys([record(ROOM, 1, T0, buyer, bare)], input);
    expect(r1.payer).toBeUndefined();
    expect(r1.reasons.join("\n")).toContain("no proof");
    const claimed = formatPubkeyLine({ railId: BTC, caip2: BTC_CAIP2, pubkey, proof: { scheme: "bip322", signature: "AAAA" } });
    const r2 = resolvePubkeys([record(ROOM, 1, T0, buyer, claimed)], input);
    expect(r2.payer).toBeUndefined();
    expect(r2.reasons.join("\n")).toContain("proof does not verify");
    const r3 = resolvePubkeys([record(ROOM, 1, T0, buyer, claimed)], {
      ...input,
      proof: { mode: "required", verifiers: createProofVerifierRegistry([eip191Verifier]) },
    });
    expect(r3.reasons.join("\n")).toContain('no verifier for scheme "bip322"');
  });

  it("a plugged-in bip322-shaped verifier sees this DID, contract, rail and the key's message", () => {
    const seen: string[] = [];
    const spy: AccountProofVerifier = {
      scheme: "bip322",
      verify(ctx) {
        seen.push(ctx.message, ctx.subject);
        return true;
      },
    };
    const l = formatPubkeyLine({ railId: BTC, caip2: BTC_CAIP2, pubkey, proof: { scheme: "bip322", signature: "AAAA" } });
    const result = resolvePubkeys([record(ROOM, 1, T0, buyer, l)], {
      ...input,
      proof: { mode: "required", verifiers: createProofVerifierRegistry([spy]) },
    });
    expect(result.payer).toBe(pubkey);
    expect(seen).toEqual([pubkeyProofMessage({ did: buyer.did, contract: CONTRACT, railId: BTC, caip2: BTC_CAIP2, pubkey }), pubkey]);
    expect(seen[0]).toBe(`FLOP::swap::account-proof::v1|${buyer.did}|${CONTRACT}|btc-htlc|${BTC_CAIP2}:${pubkey}`);
  });
});

describe("no production call site uses the legacy-unproven policy", () => {
  it("every resolver call in src/ requires a proof (the flows, replay, watcher, bundle and audit-export)", () => {
    const root = join(import.meta.dirname, "..", "src");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith(".ts") && /proof: \{ mode: "legacy-unproven" \}/.test(readFileSync(p, "utf8"))) {
          hits.push(p.slice(root.length + 1).replaceAll("\\", "/"));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual([]);
  });
});
