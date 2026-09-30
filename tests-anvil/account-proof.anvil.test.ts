// SPDX-License-Identifier: MIT
//
// tests-anvil/account-proof.anvil.test.ts -- P7 `eip191` on a real anvil node: the connected
// `evm-htlc` handle's `signAccountProof` has anvil's own node-held account sign the account-proof
// message over JSON-RPC (`personal_sign`), no key anywhere in this code, and the signature
// resolves an account line under a `required` proof policy. A proof by another node account, for
// another contract, DID or address is refused.

import { dealRoom, type LockTerms } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEvmCounterRail } from "../src/client/evm-rail.js";
import type { ConnectedCounterAssetRail } from "../src/client/counter-rail.js";
import { accountProofMessage, formatAccountLine, resolveAccounts } from "../src/rails/account-line.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { identity, record } from "../tests/helpers/identity.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

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
  asset: "USDC",
  payer: buyer.did,
  payee: seller.did,
  claimByMs: T0 + 3_600_000,
  refundAfterMs: T0 + 7_200_000,
};

describe("eip191 account proofs on a real anvil node", () => {
  let anvil: AnvilHandle;
  let config: EvmRailConfig;
  let accountA: `0x${string}`;
  let accountB: `0x${string}`;
  let handleA: ConnectedCounterAssetRail;
  let handleB: ConnectedCounterAssetRail;

  beforeAll(async () => {
    anvil = await startAnvil({ timestampSeconds: 1_700_000_000 });
    [accountA, accountB] = anvil.accounts as [`0x${string}`, `0x${string}`];
    const deployed = await deployRailContracts(anvil.endpoint, accountA);
    config = { pin: ANVIL_LOCAL_PIN, endpoint: anvil.endpoint, contract: deployed.railContract, assets: { USDC: deployed.tokenContract } };
    const mk = (account: `0x${string}`) =>
      createEvmCounterRail({ config, rpc: new CapturingRpc({ endpoint: anvil.endpoint }), account, clock: () => T0 });
    handleA = await mk(accountA).connect(TERMS, {});
    handleB = await mk(accountB).connect(TERMS, {});
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  const input = {
    contract: CONTRACT,
    payerDid: buyer.did,
    payeeDid: seller.did,
    rail: "evm-htlc",
    caip2: ANVIL_LOCAL_PIN.caip2,
    proof: { mode: "required" } as const,
  };

  const messageFor = (did: string, contract: string, address: string) =>
    accountProofMessage({ did, contract, railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address });

  it("the node signs, and the proven line resolves for this DID, contract and account", async () => {
    const proof = await handleA.signAccountProof(messageFor(buyer.did, CONTRACT, accountA));
    expect(proof.scheme).toBe("eip191");
    expect(proof.signature).toMatch(/^[0-9a-f]{130}$/);
    const line = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: accountA, proof });
    const result = resolveAccounts([record(ROOM, 1, T0, buyer, line)], input);
    expect(result.payer).toBe(accountA.toLowerCase());
    expect(result.reasons).toEqual([]);
  });

  it("the handle refuses a message that names another account", async () => {
    await expect(handleA.signAccountProof(messageFor(buyer.did, CONTRACT, accountB))).rejects.toThrow(/own account/);
  });

  it("a proof for another DID, contract or address is refused at resolution", async () => {
    // Another node account signs a message naming account A: a stranger claiming A's address.
    const forged = await handleB.signAccountProof(messageFor(buyer.did, CONTRACT, accountB));
    const claimsA = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: accountA, proof: forged });
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, claimsA)], input).payer).toBeUndefined();

    // A's genuine proof for the buyer, posted as the seller, or in a mirror pair's room.
    const proof = await handleA.signAccountProof(messageFor(buyer.did, CONTRACT, accountA));
    const line = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: accountA, proof });
    expect(resolveAccounts([record(ROOM, 1, T0, seller, line)], input).payee).toBeUndefined();
    expect(
      resolveAccounts([record(dealRoom(OTHER_CONTRACT), 1, T0, buyer, line)], { ...input, contract: OTHER_CONTRACT }).payer,
    ).toBeUndefined();

    // A proof made for another contract and posted here.
    const other = await handleA.signAccountProof(messageFor(buyer.did, OTHER_CONTRACT, accountA));
    const otherLine = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: accountA, proof: other });
    expect(resolveAccounts([record(ROOM, 1, T0, buyer, otherLine)], input).payer).toBeUndefined();
  });

  it("the longest evm-htlc account line is well inside the room-message cap", async () => {
    const proof = await handleA.signAccountProof(messageFor(buyer.did, CONTRACT, accountA));
    const line = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: accountA, proof });
    expect(line.length).toBeLessThan(260);
  });
});
