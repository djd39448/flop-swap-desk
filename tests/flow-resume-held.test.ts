// SPDX-License-Identifier: MIT
//
// R2-11 and R2-12 (P8-FIXES-R2.md): the exchanges of FAILED claim attempts that the Seller holds back until the reveal is posted (R1-22).
//
// R2-11: the hold was a TypeScript-private field, which is an ordinary enumerable property. After a claim that never reached the chain (the node
// refused the send), the secret is NOT public, yet `Object.entries(flow)` and `util.inspect(flow, { customInspect: false })` showed the request
// body whose calldata holds the preimage. The hold (and the list `exchanges` reads) are now ES `#private` fields: no enumeration, inspection or
// structured clone reaches them. The runner-supplied `rail` keeps its own capture log; that predates P8 and is the runner's.
//
// R2-12: the held exchanges are released once the reveal is posted. A later claim attempt of the SAME instance (a payout that fails again)
// held its own exchanges and then hit `postRevealLatched`'s early return (the reveal was already posted), which released nothing: a bundle lacked
// the second attempt's evidence. The early return now releases too.
//
// Ported from the secrets and store lens (SEC2-A, SEC2-H) of review round 2.

import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { NearPayoutFailedError } from "../src/rails/near-htlc.js";
import { containsSecret } from "./helpers/crash-matrix.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmWorldWith } from "./helpers/matrix-worlds.js";
import { SELLER_ACCOUNT } from "./helpers/near-stateful-rpc.js";
import { nearSwap } from "./helpers/near-swap-rig.js";
import { started } from "./helpers/resume-world.js";

/** JSON that drops raw bytes (a flow store's saves are bytes, and the Seller's own record is allowed to hold the secret). */
const plainJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item instanceof Uint8Array ? undefined : item)) ?? "";

/** The EVM swap at leg A locked, then a claim the node refuses before it reaches the chain: the secret is not public. */
async function refusedClaim() {
  let node: EvmMockNode | undefined;
  const s = await started(evmWorldWith((n) => void (node = n)));
  if (node === undefined) throw new Error("test: the world did not hand over its node");
  const statement = s.c.seller.statement;
  if (statement === undefined) throw new Error("test: the Seller has no statement");
  node.rejectNextSend("claim");
  const error = await s.c.seller.claimLegA(statement).catch((e: unknown) => e);
  expect(error, "the node refused the claim").toBeInstanceOf(Error);
  expect(node.count("claim"), "nothing reached the chain: the secret is not public").toBe(0);
  return { flow: s.c.seller, secret: s.w.hashLock };
}

describe("R2-11: a claim the node refused before it reached the chain leaves the secret out of every enumerable field of the flow", () => {
  it("the public views stay clean and the scan is not blind (controls)", async () => {
    const { flow, secret } = await refusedClaim();
    expect(containsSecret(plainJson({ planted: secret.preimage }), secret)).toBe(true);
    expect(containsSecret(JSON.stringify(flow), secret)).toBe(false);
    expect(containsSecret(inspect(flow), secret)).toBe(false);
    expect(containsSecret(plainJson(flow.exchanges), secret)).toBe(false);
  });

  it("util.inspect(flow, { customInspect: false }) holds no encoding of the secret", async () => {
    const { flow, secret } = await refusedClaim();
    const raw = inspect(flow, { customInspect: false, maxStringLength: Infinity, maxArrayLength: Infinity });
    expect(containsSecret(raw, secret)).toBe(false);
  });

  it("Object.entries(flow), without the runner's own rail, holds no encoding of the secret", async () => {
    const { flow, secret } = await refusedClaim();
    const holders = Object.entries(flow)
      .filter(([name]) => name !== "rail") // runner-supplied: its capture log predates P8
      .filter(([, value]) => containsSecret(plainJson(value), secret))
      .map(([name]) => name);
    expect(holders, "own enumerable fields of the flow that hold the secret").toEqual([]);
  });

  it("the hold and the exchange list are not properties of the flow at all", async () => {
    const { flow } = await refusedClaim();
    for (const name of ["heldClaimExchanges", "writeExchanges"]) {
      expect(Object.getOwnPropertyNames(flow)).not.toContain(name);
      expect(Reflect.ownKeys(flow).map(String)).not.toContain(name);
    }
  });
});

describe("R2-12: a payout that fails twice in one instance still delivers the second attempt's exchanges once the reveal is out", () => {
  it("NEAR: after the second failed claimLegA, flow.exchanges holds the second attempt's claim transaction (the first one's was released with the first reveal)", async () => {
    const r = await nearSwap();
    const claimSends = (): number => r.seller.exchanges.filter((e) => e.requestBody.includes("send_tx")).length;

    r.node.armPayoutFailureAfterReads(SELLER_ACCOUNT, 2);
    const first = await r.seller.claimLegA(r.statement).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(NearPayoutFailedError);
    const afterFirst = r.seller.exchanges.length;
    expect(claimSends(), "the first attempt's claim transaction joined the exchanges with its reveal").toBe(1);

    // the Seller's token storage is back for the pre-check and gone again by the payout: the same instance fails a second time
    r.node.registerStorage(SELLER_ACCOUNT);
    r.node.armPayoutFailureAfterReads(SELLER_ACCOUNT, 2);
    const second = await r.seller.claimLegA(r.statement).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(NearPayoutFailedError);
    expect(r.node.claimSendTxCalls, "two claim transactions reached the node").toBe(2);
    expect(r.seller.exchanges.length).toBeGreaterThan(afterFirst);
    expect(claimSends(), "the second attempt's claim transaction is among the exchanges").toBe(2);
  });
});

