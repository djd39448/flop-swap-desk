// SPDX-License-Identifier: MIT
//
// tests-near/account-proof.near.test.ts -- P7 `nep413` on a real near-sandbox node: the connected
// `near-htlc` handle's `signAccountProof` signs the account-proof message (NEP-413) with the
// account's in-memory full-access key; the proven line resolves with its key; and the evidence
// read (`view_access_key(account, key)` at the same finalized block as the lock) accepts a real
// full-access key and refuses a function-call key, a key the account does not hold, and another
// account's key. The lock itself is a real one, written by the buyer's rail.

import { randomBytes } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { dealRoom, type LockTerms } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNearCounterRail } from "../src/client/near-rail.js";
import { accountProofMessage, formatAccountLine, resolveAccounts } from "../src/rails/account-line.js";
import { buildSignedTransaction, type NearAction } from "../src/rails/near-borsh.js";
import { captureNearLeg, nearEvidence, type NearAccounts } from "../src/rails/near-evidence.js";
import { signNep413 } from "../src/rails/near-proof.js";
import { NearRpc } from "../src/rails/near-rpc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { verifiedExchangeBytes } from "../src/rails/rpc-capture.js";
import { identity, record } from "../tests/helpers/identity.js";
import { startNearSandbox, type NearSandboxHandle } from "./helpers/sandbox.js";

const buyerId = identity("d4".repeat(32));
const sellerId = identity("e5".repeat(32));
const CONTRACT = `0x${"ab".repeat(32)}`;
const ROOM = dealRoom(CONTRACT);

describe("nep413 account proofs on a real near-sandbox node", () => {
  let sandbox: NearSandboxHandle;
  let caip2: string;
  let terms: LockTerms;
  let ref: string;
  let buyerHandle: Awaited<ReturnType<ReturnType<typeof createNearCounterRail>["connect"]>>;
  let sellerHandle: Awaited<ReturnType<ReturnType<typeof createNearCounterRail>["connect"]>>;
  let functionCallKey: InMemoryNearSigner;

  async function chainNowMs(): Promise<number> {
    const block = await new NearRpc(sandbox.createCapturingRpc()).block({ finality: "final" });
    return Number(BigInt(block.header.timestampNs) / 1_000_000n);
  }

  beforeAll(async () => {
    sandbox = await startNearSandbox();
    caip2 = sandbox.config.pin.caip2;
    const now = await chainNowMs();
    const hashLock = `0x${bytesToHex(sha256(randomBytes(32)))}`;
    terms = {
      contract: CONTRACT,
      lock: "hash",
      statement: hashLock,
      amount: "1000",
      asset: "USDC",
      payer: buyerId.did,
      payee: sellerId.did,
      claimByMs: now + 10 * 60_000,
      refundAfterMs: now + 20 * 60_000,
    };
    const mk = (signer: InMemoryNearSigner | (typeof sandbox.buyer)["signer"]) =>
      createNearCounterRail({ config: sandbox.config, rpc: sandbox.createCapturingRpc(), signer, clock: Date.now });
    const accounts = { payee: sandbox.seller.accountId };
    buyerHandle = await mk(sandbox.buyer.signer).connect(terms, accounts);
    sellerHandle = await mk(sandbox.seller.signer).connect(terms, accounts);

    // A real lock by the buyer, so the evidence reader has something to decide on.
    const prepared = await buyerHandle.prepareLock(terms, 0);
    ref = prepared.ref;
    await buyerHandle.commitLock();

    // A function-call key on the seller's account: its proof must never prove control of it.
    functionCallKey = InMemoryNearSigner.generate(sandbox.seller.accountId);
    const rpc = sandbox.createCapturingRpc();
    const near = new NearRpc(rpc);
    const sellerSigner = sandbox.seller.signer;
    const accessKey = await near.viewAccessKey(sandbox.seller.accountId, sellerSigner.publicKey);
    const block = await near.block({ finality: "final" });
    const actions: NearAction[] = [
      {
        type: "AddKey",
        publicKey: { keyType: "ED25519", data: functionCallKey.publicKeyRaw() },
        nonce: 0n,
        permission: { functionCall: { allowance: null, receiverId: sandbox.htlcContract, methodNames: ["get_lock"] } },
      },
    ];
    const built = await buildSignedTransaction(
      {
        signerId: sandbox.seller.accountId,
        publicKey: { keyType: "ED25519", data: base58.decode(sellerSigner.publicKey.slice("ed25519:".length)) },
        nonce: BigInt(accessKey.nonce) + 1n,
        receiverId: sandbox.seller.accountId,
        blockHash: base58.decode(block.header.hash),
        actions,
      },
      (hash) => sellerSigner.sign(hash),
    );
    await near.sendTx(Buffer.from(built.signedBytes).toString("base64"), "FINAL");
  }, 300_000);

  afterAll(async () => {
    if (sandbox !== undefined) await sandbox.stop();
  });

  const messageFor = (did: string, contract: string, account: string) =>
    accountProofMessage({ did, contract, railId: "near-htlc", caip2, address: account });

  async function lineFor(handle: typeof buyerHandle, did: string, account: string): Promise<string> {
    const proof = await handle.signAccountProof(messageFor(did, CONTRACT, account));
    return formatAccountLine({ railId: "near-htlc", caip2, address: account, proof });
  }

  function resolveInput() {
    return { contract: CONTRACT, payerDid: buyerId.did, payeeDid: sellerId.did, rail: "near-htlc", caip2, proof: { mode: "required" } as const };
  }

  async function evidenceFor(accounts: NearAccounts) {
    const rpc = sandbox.createCapturingRpc();
    const nowMs = Date.now();
    const { index, exchanges } = await captureNearLeg(rpc, sandbox.config, terms, accounts, ref, nowMs);
    const bytes = verifiedExchangeBytes(exchanges);
    return nearEvidence({ terms, config: sandbox.config, accounts, capture: { index, bytes } });
  }

  it("the handle signs with the account's own key, the line resolves with the proven key, and the lock verifies with a real FullAccess read", async () => {
    const sellerLine = await lineFor(sellerHandle, sellerId.did, sandbox.seller.accountId);
    const buyerLine = await lineFor(buyerHandle, buyerId.did, sandbox.buyer.accountId);
    expect(sellerLine.length).toBeLessThan(600);
    const resolved = resolveAccounts([record(ROOM, 1, Date.now(), sellerId, sellerLine), record(ROOM, 2, Date.now(), buyerId, buyerLine)], resolveInput());
    expect(resolved.payee).toBe(sandbox.seller.accountId);
    expect(resolved.payeeKey).toBe(sandbox.seller.signer.publicKey);
    expect(resolved.payer).toBe(sandbox.buyer.accountId);
    expect(resolved.payerKey).toBe(sandbox.buyer.signer.publicKey);

    const result = await evidenceFor({
      payee: resolved.payee!,
      payer: resolved.payer!,
      payeeKey: resolved.payeeKey!,
      payerKey: resolved.payerKey!,
    });
    expect(result.lock.reason).toContain("locked and on-chain state matches terms");
    expect(result.lock.railVerified).toBe(true);
  });

  it("the handle refuses a message that names another account", async () => {
    await expect(sellerHandle.signAccountProof(messageFor(sellerId.did, CONTRACT, sandbox.buyer.accountId))).rejects.toThrow(/own account/);
  });

  it("a function-call key on the account: the signature verifies, the evidence read refuses the key", async () => {
    const proof = await signNep413(functionCallKey, messageFor(sellerId.did, CONTRACT, sandbox.seller.accountId));
    const line = formatAccountLine({ railId: "near-htlc", caip2, address: sandbox.seller.accountId, proof });
    const resolved = resolveAccounts([record(ROOM, 1, Date.now(), sellerId, line)], resolveInput());
    expect(resolved.payee).toBe(sandbox.seller.accountId);
    expect(resolved.payeeKey).toBe(functionCallKey.publicKey);
    const result = await evidenceFor({ payee: resolved.payee!, payeeKey: resolved.payeeKey! });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toContain("is not a FullAccess key");
    expect(result.rail).toBeUndefined();
  });

  it("a key that is not on the account is refused", async () => {
    const stranger = InMemoryNearSigner.generate(sandbox.seller.accountId);
    const proof = await signNep413(stranger, messageFor(sellerId.did, CONTRACT, sandbox.seller.accountId));
    const line = formatAccountLine({ railId: "near-htlc", caip2, address: sandbox.seller.accountId, proof });
    const resolved = resolveAccounts([record(ROOM, 1, Date.now(), sellerId, line)], resolveInput());
    expect(resolved.payeeKey).toBe(stranger.publicKey);
    const result = await evidenceFor({ payee: resolved.payee!, payeeKey: resolved.payeeKey! });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toContain("is not an access key");
  });

  it("another account's full-access key is refused: the buyer's key proving the seller's account", async () => {
    const result = await evidenceFor({ payee: sandbox.seller.accountId, payeeKey: sandbox.buyer.signer.publicKey });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toContain("is not an access key");
  });

  it("the proof for another contract is refused at resolution", async () => {
    const proof = await sellerHandle.signAccountProof(messageFor(sellerId.did, `0x${"cd".repeat(32)}`, sandbox.seller.accountId));
    const line = formatAccountLine({ railId: "near-htlc", caip2, address: sandbox.seller.accountId, proof });
    expect(resolveAccounts([record(ROOM, 1, Date.now(), sellerId, line)], resolveInput()).payee).toBeUndefined();
  });
});
