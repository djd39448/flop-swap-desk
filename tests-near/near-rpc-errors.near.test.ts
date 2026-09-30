// SPDX-License-Identifier: MIT
//
// tests-near/near-rpc-errors.near.test.ts -- H11 (P5-NEAR-FIXES-R2.md): the node's REAL nonce and
// expiry error bodies, through NearRpc's own mapping. The two bodies pinned in
// tests/near-rpc.test.ts (REAL_INVALID_NONCE, REAL_EXPIRED) were captured from exactly these two
// requests on a near-sandbox node; this test proves the mapping still holds against the live node.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { base58 } from "@scure/base";

import { buildSignedTransaction } from "../src/rails/near-borsh.js";
import { NearExpiredTransactionError, NearInvalidNonceError, NearRpc } from "../src/rails/near-rpc.js";
import { startNearSandbox, type NearSandboxHandle } from "./helpers/sandbox.js";

describe("near-rpc error mapping (sandbox, H11)", () => {
  let sandbox: NearSandboxHandle;
  beforeAll(async () => {
    sandbox = await startNearSandbox();
  }, 300_000);
  afterAll(async () => {
    if (sandbox !== undefined) await sandbox.stop();
  });

  async function sendSelfTransfer(near: NearRpc, nonce: bigint, blockHash: string): Promise<void> {
    const signer = sandbox.buyer.signer;
    const built = await buildSignedTransaction(
      {
        signerId: sandbox.buyer.accountId,
        publicKey: { keyType: "ED25519", data: base58.decode(signer.publicKey.slice("ed25519:".length)) },
        nonce,
        receiverId: sandbox.buyer.accountId,
        blockHash: base58.decode(blockHash),
        actions: [{ type: "Transfer", deposit: 1n }],
      },
      (hash) => signer.sign(hash),
    );
    await near.sendTx(Buffer.from(built.signedBytes).toString("base64"), "FINAL");
  }

  it("a nonce not above the access key's is a NearInvalidNonceError; a block hash older than the validity window is a NearExpiredTransactionError", async () => {
    const near = new NearRpc(sandbox.createCapturingRpc());
    const key = await near.viewAccessKey(sandbox.buyer.accountId, sandbox.buyer.signer.publicKey);
    const oldBlock = await near.block({ finality: "final" });
    await expect(sendSelfTransfer(near, BigInt(key.nonce), oldBlock.header.hash)).rejects.toBeInstanceOf(NearInvalidNonceError);
    await sandbox.fastForward(400);
    await expect(sendSelfTransfer(near, BigInt(key.nonce) + 1n, oldBlock.header.hash)).rejects.toBeInstanceOf(NearExpiredTransactionError);
  }, 120_000);
});
