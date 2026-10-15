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
//
// P10-KEY-01 (P10-FIXES-R1.md decision 2): the Seller's recorded Bitcoin claim (`claimTx`: the txid and the complete signed bytes, which carry the preimage in their witness) was a
// TypeScript-private field, an enumerable own property, for a claim that the process signed and saved and the node had not yet been sent: the same leak R2-11 closed for the held
// exchanges. It is now an ES `#private` field, and the last describe below holds that with a Bitcoin world whose claim bytes embed the preimage.

import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { NearPayoutFailedError } from "../src/rails/near-htlc.js";
import { Controller, PREFIX, STEPS, containsSecret, type Ctx } from "./helpers/crash-matrix.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmWorldWith, ledgerWorldWith } from "./helpers/matrix-worlds.js";
import { SELLER_ACCOUNT } from "./helpers/near-stateful-rpc.js";
import { nearSwap } from "./helpers/near-swap-rig.js";
import { resumedSeller, sellerRecordOf, started } from "./helpers/resume-world.js";

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

/**
 * A Bitcoin ledger world whose claim bytes embed the preimage, with the Seller's process dead right before the claim's send (the claim is signed and saved, never sent): the secret
 * is NOT public, and the only holder of it that the flow keeps besides its own record is the recorded claim.
 */
async function bitcoinDiedBeforeClaimSend() {
  // a reference run numbers the outward actions; the cut is the claim's send
  const reference = new Controller();
  const refWorld = ledgerWorldWith("btc", (chain) => void (chain.claimBytesCarrySecret = true))(reference);
  const refCtx: Ctx = { w: refWorld, buyer: new BuyerFlow(refWorld.buyerOptions()), seller: new SellerFlow(refWorld.sellerOptions()), history: [] };
  for (const step of [...PREFIX, STEPS.lockLegA, STEPS.claimLegA]) await step.run(refCtx);
  const n = reference.actions.find((action) => action.what === "chain:claim.send")?.n;
  if (n === undefined) throw new Error("test: no claim send in the reference run");

  const ctl = new Controller([{ n, mode: "before" }]);
  const w = ledgerWorldWith("btc", (chain) => {
    chain.autoMineClaims = false;
    chain.claimBytesCarrySecret = true;
  })(ctl);
  ctl.attachStore(w.stores.buyer, "buyer");
  ctl.attachStore(w.stores.seller, "seller");
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  for (const step of [...PREFIX, STEPS.lockLegA]) await step.run(c);
  const statement = seller.statement;
  await seller.claimLegA(statement!).catch(() => undefined);
  expect(ctl.isDead("seller"), "the Seller's process died right before the claim's send").toBe(true);
  return { s: { ctl, w, c }, dead: seller };
}

describe("P10-KEY-01: a recorded Bitcoin claim's bytes carry the preimage and are held out of every enumerable view of the flow", () => {
  it("controls: the saved record holds the claim bytes with the preimage, and the scan sees it in them", async () => {
    const { s } = await bitcoinDiedBeforeClaimSend();
    const claimTx = (await sellerRecordOf(s.w)).claimTx;
    expect(claimTx !== undefined && containsSecret(claimTx.rawTx, s.w.hashLock), "the premise: the claim's bytes embed the preimage, and the record (the Seller's own home for it) holds them").toBe(true);
    expect(claimTx?.sent, "never sent").toBeUndefined();
  });

  it("neither the process that signed it nor the process that resumed it shows the bytes in Object.entries, util.inspect (customInspect off, hidden shown, any depth), JSON or structured clone", async () => {
    const { s, dead } = await bitcoinDiedBeforeClaimSend();
    const back = await resumedSeller(s);
    expect(back.next).toBe("claimLegA");
    const secret = s.w.hashLock;
    for (const [label, flow] of [
      ["the flow that signed the claim", dead],
      ["the flow that resumed it", back.flow],
    ] as const) {
      // the runner-supplied `rail` keeps its own state (here the whole fake chain, which has to hold the bytes); everything else the flow owns is what is asked about
      const own = Object.fromEntries(Object.entries(flow).filter(([name]) => name !== "rail"));
      expect(containsSecret(plainJson(own), secret), `${label}: Object.entries`).toBe(false);
      expect(
        containsSecret(inspect(own, { customInspect: false, showHidden: true, depth: null, maxStringLength: Infinity, maxArrayLength: Infinity }), secret),
        `${label}: util.inspect of the own properties, hidden ones shown, any depth`,
      ).toBe(false);
      expect(containsSecret(inspect(flow, { customInspect: false, showHidden: true, maxStringLength: Infinity, maxArrayLength: Infinity }), secret), `${label}: util.inspect of the flow`).toBe(false);
      expect(containsSecret(inspect(flow), secret), `${label}: util.inspect with the flow's own view`).toBe(false);
      expect(containsSecret(JSON.stringify(flow), secret), `${label}: JSON.stringify`).toBe(false);
      let cloned: unknown;
      try {
        cloned = structuredClone(own); // functions in the flow's other fields may make a clone throw; what it can copy must not hold the bytes
      } catch {
        cloned = undefined;
      }
      if (cloned !== undefined) expect(containsSecret(plainJson(cloned), secret), `${label}: structuredClone`).toBe(false);
      expect(Object.getOwnPropertyNames(flow), label).not.toContain("claimTx");
      expect(Reflect.ownKeys(flow).map(String), label).not.toContain("claimTx");
    }
  });
});
