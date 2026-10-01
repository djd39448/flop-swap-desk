// SPDX-License-Identifier: MIT
//
// tests/client-flows-sol.test.ts - SB3a (P6-SOL-SPEC.md sections 3-5): the real Seller/Buyer client flows
// (src/client/seller.ts, buyer.ts) over the REAL Solana counter rail (src/client/sol-rail.ts ->
// src/rails/sol-htlc.ts -> src/rails/sol-rpc.ts -> src/rails/sol-evidence.ts), with only the wire faked: a
// STATEFUL fake Solana node (tests/helpers/sol-stateful-chain.ts) that applies the escrow program's own state
// machine to the transactions the real adapter builds, signs and sends (the reviewer pattern of
// tests/client-flows-near-rpc.test.ts). Nothing here is a scripted queue of canned replies.
//
// It covers every refusal and recovery the NEAR flows have (amount floor and asset, the rail-owned policy, the
// payer-keyed ref rule G5, one funding per swap G2, record-before-send and the announce-after-confirm K5, the
// last-moment claim guard judged against max(chain time, clock), a refund that counts only when confirmed and
// routes a pending claim to learnSecret K2, learnSecret from a reveal or from the chain alone, latched frames
// G6, lost replies on every write, a squatter under the public hash lock, the proven lines of P7) plus what is
// Solana-specific: a claim that lands and FAILS publishes the secret in its instruction data (S1), so the Buyer
// learns it from the failed transaction and does not refund, and the Seller posts the reveal and retries AT
// ONCE through the public-secret mode; a claim lost to a relayer is not a failure (A4); a claim the simulation
// refuses is never sent (nothing leaks); and the custom rail id is admitted only through the rail's own
// registry while tclk's closed check stays in force for everyone else.

import { dealRoom, decodePaperRecord, encodeFrame, encodePaperRecord, makeOffer, paperNote, PaperRail, tryDecodeFrame, type AcceptFrame, type LockTerms, type OfferFrame } from "@flop-labs/tclk";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { belowMinLockable } from "../src/client/counter-rail.js";
import { LegBClaimedError } from "../src/client/buyer.js";
import { SOL_CHAIN_CLOCK_SKEW_MS, SOL_LOCAL_POLICY } from "../src/client/policy.js";
import { RevealNotPostedError, SolClaimStarvedError } from "../src/client/seller.js";
import { SOL_ASSET_ID, SOL_AMOUNT_FLOOR, SOL_CLAIM_LANDING_MARGIN_MS, SOL_HTLC_PROGRAM_ID, SolClaimFailedError, claimInstructionData, escrowAddress, vaultAddress } from "../src/rails/sol-htlc.js";
import { InMemorySolSigner } from "../src/rails/sol-signer-memory.js";
import { TOKEN_PROGRAM_ID, associatedTokenAddress } from "../src/rails/sol-spl.js";
import { compileLegacyMessage, decodeTransaction, pubkeyFromBase58, signTransaction } from "../src/rails/sol-tx.js";
import { accountProofMessage, formatSolAccountLine } from "../src/rails/account-line.js";
import { encodeFrameWith } from "../src/rails/custom-frames.js";
import { SOL_RAIL_ID, createSolRailRegistry } from "../src/rails/custom-rails.js";
import { foldAcceptedLock } from "../src/replay.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { legAContext, swapId as computeSwapId } from "../src/profile.js";
import { BID, T0, dealRoomOf, failPosts, framesIn, legADeadlines, legBDeadlines, lockedFlow, pair, pairWithLines, solHarness, stallPosts, type SolHarness } from "./helpers/sol-flow-harness.js";
import { solWallet } from "./helpers/sol-proof.js";

const CUSTOM = (n: number): unknown => ({ InstructionError: [0, { Custom: n }] });

/** The nine-field terms of the swap's leg A, exactly as the flows derive them. */
function termsOf(p: { offerA: OfferFrame; acceptA: never }): LockTerms {
  return offerAcceptLockTerms(p.offerA, p.acceptA);
}

function decoded(record: { line: string }): Record<string, unknown> {
  return tryDecodeFrame(record.line) as unknown as Record<string, unknown>;
}

/** A relayer's claim transaction for the escrow named by `ref` (anyone may send a claim: it pays the payee). */
async function relayerClaim(h: SolHarness, statement: string, secretHex: string, relayer: InMemorySolSigner) {
  const escrow = escrowAddress(SOL_HTLC_PROGRAM_ID, h.buyerWallet.publicKey, statement).address;
  const vault = vaultAddress(SOL_HTLC_PROGRAM_ID, escrow).address;
  const mint = h.node.mint;
  const payeeToken = associatedTokenAddress(h.sellerWallet.publicKeyBytes, mint);
  const message = compileLegacyMessage({
    feePayer: relayer.publicKeyBytes,
    recentBlockhash: pubkeyFromBase58(h.node.chain.blockhash),
    instructions: [
      {
        programId: pubkeyFromBase58(SOL_HTLC_PROGRAM_ID),
        accounts: [
          { pubkey: escrow, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: payeeToken, isSigner: false, isWritable: true },
          { pubkey: pubkeyFromBase58(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
        ],
        data: claimInstructionData(Uint8Array.from(Buffer.from(secretHex.slice(2), "hex"))),
      },
    ],
  });
  return signTransaction(message, [relayer]);
}

// -- frames and the custom rail id ------------------------------------------------------------------------------

describe("the custom rail id: admitted per rail object, never global", () => {
  it("the leg A offer declares the custom rail, decodes under tclk, and tclk alone could never have emitted it", async () => {
    const h = solHarness();
    const { offerA } = await pair(h);
    expect(offerA.rails).toEqual([SOL_RAIL_ID]);
    const posted = (await h.venue.read("tclk-offers"))[0]!;
    expect((tryDecodeFrame(posted.line) as OfferFrame).rails).toEqual([SOL_RAIL_ID]);
    // tclk's own closed emission check refuses the very same frame: only the rail's own registry admits it
    expect(() => encodeFrame(offerA)).toThrow(/unknown rail id|non-canonical|malformed rail id/);
    expect(() => makeOffer({ ...offerA, rails: [SOL_RAIL_ID] } as never)).toThrow(/unknown rail id|malformed rail id/);
  });

  it("the lock frame and both receipts carry the custom rail id and the payer-keyed ref; the tclk machine accepts the lock", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const room = dealRoomOf(p.acceptA);
    const lockFrames = framesIn(await h.venue.read(room), "lock");
    expect(lockFrames).toHaveLength(1);
    expect(decoded(lockFrames[0]!)).toMatchObject({ rail: SOL_RAIL_ID, ref: p.ref, from: h.buyer.did });
    const offerRecord = (await h.venue.read("tclk-offers"))[0]!;
    const acceptRecord = (await h.venue.read("tclk-offers"))[1]!;
    const accepted = foldAcceptedLock(offerRecord, acceptRecord, await h.venue.read(room));
    expect(accepted).toMatchObject({ rail: SOL_RAIL_ID, railRef: p.ref });

    await h.sellerFlow.claimLegA(p.statement);
    const receipts = framesIn(await h.venue.read(room), "receipt").map(decoded);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "claimed", rail: SOL_RAIL_ID, ref: p.ref });
  });

  it("a flow without the registry (an EVM-shaped rail) cannot emit the custom id: encodeFrameWith with no or another registry is tclk's own closed check", () => {
    const lock = { type: "lock", from: "did:key:z6Mkabc", contract: `0x${"11".repeat(32)}`, rail: SOL_RAIL_ID, ref: "x" } as never;
    expect(() => encodeFrameWith(lock)).toThrow();
    expect(() => encodeFrameWith(lock, createSolRailRegistry())).toThrow(/did:key|from/); // passes the rail check, fails tclk's own DID grammar
  });

  it("the Seller refuses a leg A offer whose rails do not include this rail's own id", async () => {
    const h = solHarness();
    const legA = legADeadlines(6 * 60 * 60_000);
    const offer = makeOffer({
      from: h.buyer.did,
      role: "payer",
      amount: BID.amount,
      asset: BID.asset,
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: legA.claimByMs,
      refundAfterMs: legA.refundAfterMs,
      expiresMs: legA.expiresMs,
      job: { proto: "swap", id: computeSwapId(h.buyer.did, "00000001"), context: legAContext({ wantAsset: BID.wantAsset, wantAmount: BID.wantAmount, wantRail: BID.wantRail, feeBps: 0 }) },
    });
    await h.venue.post("tclk-offers", encodeFrame(offer), h.buyer);
    await expect(h.sellerFlow.acceptLegA(offer, legBDeadlines(), legA.lockTimeMs)).rejects.toThrow(/do not include this rail's own/);
  });
});

// -- amount floor, asset, policy ---------------------------------------------------------------------------------

describe("the amount floor, the asset and the rail-owned policy", () => {
  it("belowMinLockable reports 0 as below the floor and the floor itself as not", () => {
    const h = solHarness();
    expect(SOL_AMOUNT_FLOOR).toBe("1");
    expect(belowMinLockable(h.buyerRail, "0")).toBe(true);
    expect(belowMinLockable(h.buyerRail, SOL_AMOUNT_FLOOR)).toBe(false);
    expect(h.buyerRail.minLockableAmount).toBe(SOL_AMOUNT_FLOOR);
  });

  it("BuyerFlow.bid refuses a BTC-labelled leg before touching the chain; the Seller refuses it too", async () => {
    const h = solHarness();
    await expect(
      h.buyerFlow.bid({ swapId: computeSwapId(h.buyer.did, "00000001"), ...BID, asset: "BTC", ...legADeadlines(6 * 60 * 60_000) }),
    ).rejects.toThrow(/asset "BTC".*only ever settles "USDC"/);
    expect(h.node.chain.requests).toHaveLength(0);
    expect(h.buyerRail.assetId).toBe(SOL_ASSET_ID);
  });

  it("the policy is the rail's own frozen SOL_LOCAL_POLICY and its claim margin exceeds the claim landing margin", () => {
    const h = solHarness();
    expect(h.buyerRail.policy).toBe(SOL_LOCAL_POLICY);
    expect(h.sellerRail.policy).toBe(SOL_LOCAL_POLICY);
    expect(Object.isFrozen(SOL_LOCAL_POLICY)).toBe(true);
    expect(SOL_LOCAL_POLICY.minRevealWindowMs).toBe(45 * 60_000);
    expect(SOL_LOCAL_POLICY.finalityAMs).toBe(20 * 60_000);
    expect(SOL_LOCAL_POLICY.claimInclusionMarginMs).toBe(5 * 60_000);
    // the flow hands the rail notAfterMs = refundAfterMs - claimInclusionMarginMs; the adapter refuses a
    // notAfterMs that leaves less than SOL_CLAIM_LANDING_MARGIN_MS: a margin at or under it could never claim
    expect(SOL_CLAIM_LANDING_MARGIN_MS).toBe(120_000);
    expect(SOL_LOCAL_POLICY.claimInclusionMarginMs).toBeGreaterThan(SOL_CLAIM_LANDING_MARGIN_MS);
  });

  it("refuses a leg-A window under 45 minutes (rule 1) and a claim/refund gap inside the 5-minute margin", async () => {
    const h = solHarness();
    const lockTimeMs = T0 + 30 * 60_000;
    const refundAfterMs = lockTimeMs + 40 * 60_000;
    const offerA = await h.buyerFlow.bid({ swapId: computeSwapId(h.buyer.did, "00000001"), ...BID, claimByMs: refundAfterMs - 70 * 60_000, refundAfterMs, expiresMs: T0 + 10 * 60_000 });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), lockTimeMs)).rejects.toThrow(/leg B deadlines it would propose are unsafe/);

    const h2 = solHarness();
    const offer2 = await h2.buyerFlow.bid({
      swapId: computeSwapId(h2.buyer.did, "00000001"),
      ...BID,
      claimByMs: lockTimeMs + 6 * 60 * 60_000,
      refundAfterMs: lockTimeMs + 6 * 60 * 60_000 + 2 * 60_000,
      expiresMs: T0 + 10 * 60_000,
    });
    await expect(h2.sellerFlow.acceptLegA(offer2, legBDeadlines(), lockTimeMs)).rejects.toThrow(/claim-inclusion margin/);
  });
});

// -- proven account lines (P7) -----------------------------------------------------------------------------------

describe("P7: only proven lines resolve; a wallet proves only its own address", () => {
  it("an unproven Seller line never resolves: the Buyer refuses to lock", async () => {
    const h = solHarness();
    const p = await pair(h);
    await h.venue.post(dealRoom(p.acceptA.contract), h.sellerRail.formatAccountLine(h.sellerWallet.publicKey), h.seller);
    await h.buyerFlow.postAccountLineA(h.buyerWallet.publicKey);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/Seller's account line has not resolved/);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)).toBeNull();
  });

  it("the Buyer refuses to lock without its OWN proven payer line", async () => {
    const h = solHarness();
    await pair(h);
    await h.sellerFlow.postAccountLineA(h.sellerWallet.publicKey);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/our own proven payer account line has not resolved/);
  });

  it("a line signed by another wallet's key does not resolve", async () => {
    const h = solHarness();
    const p = await pair(h);
    const caip2 = h.node.config.pin.caip2;
    const message = accountProofMessage({ did: h.seller.did, contract: p.acceptA.contract, railId: SOL_RAIL_ID, caip2, address: h.sellerWallet.publicKey }, createSolRailRegistry());
    const forged = formatSolAccountLine({ caip2, address: h.sellerWallet.publicKey, proof: { scheme: "ed25519", signature: solWallet(77).sign(message) } });
    await h.venue.post(dealRoom(p.acceptA.contract), forged, h.seller);
    await h.buyerFlow.postAccountLineA(h.buyerWallet.publicKey);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/Seller's account line has not resolved/);
  });

  it("proveAccountLine and signAccountProof refuse an address or message that is not this wallet's own", async () => {
    const h = solHarness();
    const p = await pair(h);
    const other = solWallet(78).address;
    const terms = { payer: h.buyer.did, payee: h.seller.did } as never;
    await expect(h.sellerRail.proveAccountLine({ address: other, did: h.seller.did, contract: p.acceptA.contract, terms })).rejects.toThrow(/not this party's own wallet/);
    const connected = await h.sellerRail.connect(terms, {});
    const foreignMessage = accountProofMessage({ did: h.seller.did, contract: p.acceptA.contract, railId: SOL_RAIL_ID, caip2: h.node.config.pin.caip2, address: other }, createSolRailRegistry());
    await expect(connected.signAccountProof(foreignMessage)).rejects.toThrow(/does not name this handle's own wallet/);
  });
});

// -- happy paths, refund, refunded-b -----------------------------------------------------------------------------

describe("the flows settle and refund on the real rail", () => {
  it("scenario 1: settles - the Seller claims, the Buyer learns the secret from the reveal and claims leg B", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
    expect(h.node.tokenBalance(h.buyerWallet.publicKey)).toBe(4_000_000n);
    const claimed = await h.sellerFlow.claimLegA(p.statement);
    expect(claimed.evidence.ref).toBe(p.ref);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
    const secret = await h.buyerFlow.learnSecret();
    await h.buyerFlow.claimLegB(secret);
    const room = await h.venue.read(dealRoomOf(p.acceptA));
    expect(framesIn(room, "reveal")).toHaveLength(1);
    expect(framesIn(room, "receipt")).toHaveLength(1);
  });

  it("scenario 2: refunds - after refundAfterMs the Buyer refunds leg A once, the frames post once, a retry re-broadcasts nothing", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/before its refundAfterMs/);
    h.setTime(p.offerA.refundAfterMs);
    const refund = await h.buyerFlow.refundLegA();
    expect(refund.ref).toBe(p.ref);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
    expect(h.node.tokenBalance(h.buyerWallet.publicKey)).toBe(5_000_000n);
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "refund")).toHaveLength(1);
    const receipts = framesIn(await h.venue.read(room), "receipt").map(decoded);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "refunded", rail: SOL_RAIL_ID, ref: p.ref });
    const again = await h.buyerFlow.refundLegA();
    expect(again.ref).toBe(refund.ref);
    expect(h.node.sent.refund).toBe(1);
    expect(framesIn(await h.venue.read(room), "refund")).toHaveLength(1);
  });

  it("scenario 3: refunded-b - the Buyer never locks A; the Seller refunds leg B after its refundAfterMs", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    h.setTime(legBDeadlines().refundAfterMs);
    const refunded = await h.sellerFlow.refundLegB();
    expect(refunded.receipt).toBeDefined();
    expect(h.node.sent.lock).toBe(0);
    expect(p.offerA.rails).toEqual([SOL_RAIL_ID]);
  });

  it("scenario 4: claimLegA before the Buyer's lock frame refuses, and after it the claim is refused until the lock is final on chain", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/no accepted lock frame carries a .* ref \(0x<hash lock>:<payer>\) yet/);
    await h.buyerFlow.lockLegA();
    await expect(h.sellerFlow.claimLegA(p.statement)).resolves.toBeDefined();
  });

  it("scenario 5: a claim with no reveal frame posted - the Buyer learns the secret from the chain alone", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await h.sellerFlow.claimLegA(p.statement, { skipReveal: true });
    expect(framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "reveal")).toHaveLength(0);
    const secret = await h.buyerFlow.learnSecret();
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
    await h.buyerFlow.claimLegB(secret);
  });
});

// -- G5: the ref is the Seller's own hash lock, payer-keyed ------------------------------------------------------

describe("G5: the accepted lock frame's ref must be 0x<the Seller's own hash lock>:<payer>", () => {
  async function postLockFrame(h: SolHarness, contract: string, ref: string): Promise<void> {
    await h.venue.post(dealRoom(contract), encodeFrameWith({ type: "lock", from: h.buyer.did, contract, rail: SOL_RAIL_ID, ref }, createSolRailRegistry()), h.buyer);
  }

  it("refuses a lock frame naming another hash lock, the bare hash lock, or no payer", async () => {
    for (const refOf of [
      (statement: string, payer: string) => `0x${"bb".repeat(32)}:${payer}`,
      (statement: string) => statement,
      (statement: string) => `${statement}:`,
    ]) {
      const h = solHarness();
      const p = await pairWithLines(h);
      await postLockFrame(h, p.acceptA.contract, refOf(p.statement, h.buyerWallet.publicKey));
      await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/accepted lock frame's own ref is not 0x<this flow's own hash lock>:<payer>/);
    }
  });

  it("claims exactly the ref the accepted lock frame names, taking the payer from it", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.evidence.ref).toBe(`${p.statement}:${h.buyerWallet.publicKey}`);
  });
});

// -- squatting ---------------------------------------------------------------------------------------------------

describe("a squatter's escrow under the swap's public hash lock never blocks the real one", () => {
  it("the Buyer locks, the lock frame carries the payer-keyed ref, the Seller claims exactly the Buyer's lock; the squat stays", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const squatter = InMemorySolSigner.generate(new Uint8Array(32).fill(13));
    h.node.injectEscrow({ payer: squatter, payee: h.sellerWallet.publicKey, hashLock: p.statement, amount: 1n, claimByMs: p.legA.claimByMs, refundAfterMs: p.legA.refundAfterMs });
    await h.buyerFlow.lockLegA();
    const lockFrames = framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "lock");
    expect(decoded(lockFrames[0]!).ref).toBe(`${p.statement}:${h.buyerWallet.publicKey}`);
    await h.sellerFlow.claimLegA(p.statement);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    expect(h.node.escrow(p.statement, squatter.publicKey)?.status).toBe("Locked");
    expect(h.node.escrow(p.statement, squatter.publicKey)?.amount).toBe("1");
  });

  it("the Buyer refunds exactly its own escrow", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const squatter = InMemorySolSigner.generate(new Uint8Array(32).fill(13));
    h.node.injectEscrow({ payer: squatter, payee: h.sellerWallet.publicKey, hashLock: p.statement, amount: 1n, claimByMs: p.legA.claimByMs, refundAfterMs: p.legA.refundAfterMs });
    await h.buyerFlow.lockLegA();
    h.setTime(p.offerA.refundAfterMs);
    const refund = await h.buyerFlow.refundLegA();
    expect(refund.ref).toBe(`${p.statement}:${h.buyerWallet.publicKey}`);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
    expect(h.node.escrow(p.statement, squatter.publicKey)?.status).toBe("Locked");
  });
});

// -- G2 / K5: one funding per swap, record before send, announce after confirm -----------------------------------

describe("G2/K5: one funding per swap, recorded before it is sent, announced only once the chain agrees", () => {
  it("a second lockLegA call throws and the chain sees exactly one lock", async () => {
    const h = solHarness();
    await lockedFlow(h);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/already attempted/);
    expect(h.node.sent.lock).toBe(1);
  });

  it("a concurrent second lockLegA call is refused while the first is in flight", async () => {
    const h = solHarness();
    await pairWithLines(h);
    const first = h.buyerFlow.lockLegA();
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/already attempted|already in flight/);
    await first;
    expect(h.node.sent.lock).toBe(1);
  });

  it("reconcileLockA throws when nothing was ever attempted", async () => {
    const h = solHarness();
    await pairWithLines(h);
    await expect(h.buyerFlow.reconcileLockA()).rejects.toThrow(/never attempted/);
  });

  it("a payer token account that cannot fund the lock is refused before anything is signed; funding it lets the lock proceed", async () => {
    const h = solHarness({ buyerBalance: 10n });
    const p = await pairWithLines(h);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/holds less than the amount/);
    expect(h.node.sent.lock).toBe(0);
    h.node.fundToken(h.buyerWallet.publicKeyBytes, 5_000_000n);
    await h.buyerFlow.lockLegA();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
  });

  it("a lost reply after the lock landed: lockLegA throws, stays latched, and reconcileLockA announces the lock exactly once", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    h.node.dropNextSendReplyFor = "lock";
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "lock")).toHaveLength(0);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/already attempted/);
    const reconciled = await h.buyerFlow.reconcileLockA();
    expect(reconciled).toMatchObject({ locked: true, verified: true });
    expect(framesIn(await h.venue.read(room), "lock")).toHaveLength(1);
    await h.buyerFlow.reconcileLockA();
    expect(framesIn(await h.venue.read(room), "lock")).toHaveLength(1); // latched: never posted twice
    expect(h.node.sent.lock).toBe(1);
    await expect(h.sellerFlow.claimLegA(p.statement)).resolves.toBeDefined();
  });

  it("K5: the lock landed but its own frame post failed - reconcileLockA posts it (once), so the swap can continue", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    failPosts(h, "lock", 1);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/venue unreachable/);
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "lock")).toHaveLength(0);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
    await h.buyerFlow.reconcileLockA();
    expect(framesIn(await h.venue.read(room), "lock")).toHaveLength(1);
  });

  it("G4: the payee's token account is gone after the lock - reconcileLockA reports locked but unverified, and still announces it", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    failPosts(h, "lock", 1);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/venue unreachable/);
    h.node.closeToken(h.sellerWallet.publicKeyBytes);
    const reconciled = await h.buyerFlow.reconcileLockA();
    expect(reconciled.locked).toBe(true);
    expect(reconciled.verified).toBe(false);
    expect(reconciled.reason).toBeTruthy();
    expect(framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "lock")).toHaveLength(1);
  });
});

// -- the last-moment claim guard ---------------------------------------------------------------------------------

describe("B2/C3/E4: the claim guard is judged against max(chain time, wall clock), never either alone", () => {
  it("refuses when the CHAIN's own time is already past claimByMs though the wall clock still looks early", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.node.nowMs = p.offerA.claimByMs;
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/at\/after its claimByMs \(chain time\)/);
    expect(h.node.sent.claim).toBe(0);
  });

  it("refuses when the WALL CLOCK is already past claimByMs though the chain still looks early", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.clockRef.ms = p.offerA.claimByMs;
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/at\/after its claimByMs/);
    expect(h.node.sent.claim).toBe(0);
  });

  it("a claim inside the window still goes through", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.setTime(p.offerA.claimByMs - 10_000);
    await expect(h.sellerFlow.claimLegA(p.statement)).resolves.toBeDefined();
  });
});

// -- claim failures, lost replies, latches -----------------------------------------------------------------------

describe("refusals and recoveries of the claim", () => {
  it("a payee token account that is gone is refused before anything is signed: no claim on chain, nothing posted", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.node.closeToken(h.sellerWallet.publicKeyBytes);
    const room = dealRoomOf(p.acceptA);
    const before = (await h.venue.read(room)).length;
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/before verifyLockFinal\(A\) is true/);
    expect(h.node.history.filter((t) => t.kind === "claim")).toHaveLength(0);
    expect((await h.venue.read(room)).length).toBe(before);
  });

  it("a claim the node's simulation refuses is never sent, so nothing leaks, and nothing is posted", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const room = dealRoomOf(p.acceptA);
    const before = (await h.venue.read(room)).length;
    let simulations = 0;
    h.node.chain.override("simulateTransaction", (_p, c) => {
      simulations += 1;
      return { context: c.ctx("confirmed"), value: { err: CUSTOM(17), logs: [], unitsConsumed: 1 } };
    });
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    expect(simulations).toBe(1);
    expect(h.node.sent.claim).toBe(0);
    expect(h.node.history).toHaveLength(1); // only the lock
    expect((await h.venue.read(room)).length).toBe(before);
  });

  it("G2: a lost reply after a claim that landed - the retry recognises success from the chain, sends nothing, and posts the frames once", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.node.dropNextSendReplyFor = "claim";
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    expect(h.node.sent.claim).toBe(1);
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(0);
    const second = await h.sellerFlow.claimLegA(p.statement);
    expect(second.receipt).toBeDefined();
    expect(h.node.sent.claim).toBe(1);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(1);
    expect(framesIn(await h.venue.read(room), "receipt")).toHaveLength(1);
    const length = (await h.venue.read(room)).length;
    await h.sellerFlow.claimLegA(p.statement);
    expect((await h.venue.read(room)).length).toBe(length);
    expect(h.node.sent.claim).toBe(1);
  });

  it("G2: a second claimLegA after a clean claim posts nothing new and sends nothing", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await h.sellerFlow.claimLegA(p.statement);
    const room = dealRoomOf(p.acceptA);
    const length = (await h.venue.read(room)).length;
    await h.sellerFlow.claimLegA(p.statement);
    expect((await h.venue.read(room)).length).toBe(length);
    expect(h.node.sent.claim).toBe(1);
  });

  it("G6: a reveal post that keeps failing is RevealNotPostedError after the claim landed; the retry posts the missing frames once", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const fails = failPosts(h, "reveal", 3);
    const rejected = h.sellerFlow.claimLegA(p.statement);
    await expect(rejected).rejects.toBeInstanceOf(RevealNotPostedError);
    await expect(rejected).rejects.toThrow(/reveal must land before refundAfterMs|reveal frame did not post/);
    expect(fails.failed()).toBe(3);
    expect(h.node.sent.claim).toBe(1);
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(0);
    const second = await h.sellerFlow.claimLegA(p.statement);
    expect(second.reveal).toBeDefined();
    expect(h.node.sent.claim).toBe(1);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(1);
    expect(framesIn(await h.venue.read(room), "receipt")).toHaveLength(1);
  });

  it("G6: a reveal post that fails twice is retried within the call and lands", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    failPosts(h, "reveal", 2);
    await expect(h.sellerFlow.claimLegA(p.statement)).resolves.toBeDefined();
    expect(framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "reveal")).toHaveLength(1);
  });

  it("a claim whose finality is not known yet posts nothing; a later call completes it", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.node.chain.once("sendTransaction", (params) => {
      // accepted by the node but it never lands inside the wait: no status for the signature
      return decodeSignature(params[0] as string);
    });
    const room = dealRoomOf(p.acceptA);
    const before = (await h.venue.read(room)).length;
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/not settled yet|Pending/i);
    expect((await h.venue.read(room)).length).toBe(before);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
    h.node.chain.finalizedHeight = h.node.chain.lastValidBlockHeight + 1; // S2-2: the recorded claim can never land now
    await expect(h.sellerFlow.claimLegA(p.statement)).resolves.toBeDefined();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
  });

  it("A4: a relayer's claim landed first - this Seller's own claim fails but the payee WAS paid: not a failure, the frames post", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const relayer = InMemorySolSigner.generate(new Uint8Array(32).fill(14));
    // a relayer that learned the secret (a real one reads it from a public reveal) claims in the gap between
    // this Seller's preflight and its landing; its signing is asynchronous, so it is prepared first
    const tx = await relayerClaim(h, p.statement, sellerSecret(h), relayer);
    h.node.midFlight = (kind) => {
      if (kind === "claim") h.node.executeAndLand(tx);
    };
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.evidence.claimedByAnotherTransaction).toBe(true);
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n); // paid exactly once
    const own = h.node.history.filter((t) => t.kind === "claim");
    expect(own).toHaveLength(2);
    expect(own[0]!.err).toBeNull(); // the relayer's
    expect(own[1]!.err).not.toBeNull(); // the Seller's own
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(1);
    expect(framesIn(await h.venue.read(room), "receipt")).toHaveLength(1);
  });
});

/** The Seller's minted secret: the flow keeps it private, so the test reads what the chain will show: a
 *  relayer needs the preimage, which a real relayer learns from a public reveal; here the test derives it from
 *  the SellerFlow's private field, the only place a hermetic test may look. */
function sellerSecret(h: SolHarness): string {
  return (h.sellerFlow as unknown as { hashLock: { preimage: string } }).hashLock.preimage;
}
function decodeSignature(base64Tx: string): string {
  // the transaction id of a legacy transaction: its first 64 bytes after the one-byte signature count
  return base58.encode(Buffer.from(base64Tx, "base64").subarray(1, 65));
}

// -- S1: a claim that lands and FAILS publishes the secret -------------------------------------------------------

describe("S1 (contracts-sol/README.md): a claim that lands and fails leaks the secret", () => {
  /** Freezes the payee's token account AFTER the claim's preflight and BEFORE it executes (the only way a claim can
   *  land and fail now that the claim creates a missing account itself, R3-1); `recreate` restores it right after the failed landing, as a person fixing the account would. */
  function armFailedClaim(h: SolHarness, options: { recreate: boolean; times?: number }): void {
    let remaining = options.times ?? 1;
    h.node.midFlight = (kind) => {
      if (kind === "claim" && remaining > 0) h.node.freezeToken(h.sellerWallet.publicKeyBytes);
    };
    h.node.afterLand = (kind, failed) => {
      if (kind === "claim" && failed) {
        remaining -= 1;
        if (options.recreate) h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n);
      }
    };
  }

  it("the failed claim is on chain with the preimage in its instruction data, and the escrow is still Locked", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    await expect(h.sellerFlow.claimLegA(p.statement, { skipReveal: true })).rejects.toThrow();
    const failed = h.node.history.filter((t) => t.kind === "claim");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.err).toEqual(CUSTOM(17));
    expect(failed[0]!.preimage).toBe(sellerSecret(h));
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
  });

  it("after a claim that landed and failed the Seller retries AT ONCE through the public-secret mode, is paid, and posts the reveal only once the escrow reads Claimed", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: true });
    const result = await h.sellerFlow.claimLegA(p.statement);
    const claims = h.node.history.filter((t) => t.kind === "claim");
    expect(claims.map((t) => t.err !== null)).toEqual([true, false]);
    expect(result.evidence.ref).toBe(p.ref);
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
    const room = await h.venue.read(dealRoomOf(p.acceptA));
    expect(framesIn(room, "reveal")).toHaveLength(1);
    expect(framesIn(room, "receipt")).toHaveLength(1);
  });

  it("R3-10: a retry that cannot land posts no reveal (the escrow is not Claimed) and throws the real reason; the next call retries in public-secret mode and posts the one reveal once it is Claimed", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/payee's associated token account/);
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(0);
    expect(framesIn(await h.venue.read(room), "receipt")).toHaveLength(0);
    h.node.midFlight = undefined;
    h.node.afterLand = undefined;
    h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n); // the payee re-creates its account
    // a long while later, inside the last minute before refundAfterMs: past the flow's own claimByMs guard AND past
    // the adapter's notAfterMs bound (refundAfterMs minus the 5-minute margin), which only the public-secret
    // mode may skip, because the secret is already public and only being paid before refundAfterMs matters
    h.setTime(p.offerA.refundAfterMs - 60_000);
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(1);
    expect(framesIn(await h.venue.read(room), "receipt")).toHaveLength(1);
  });

  it("the retries are bounded: a claim that keeps failing is SolClaimFailedError after three landings", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: true, times: 99 });
    // each landing closes the account again (midFlight), each failure re-creates it (afterLand), so the pre-checks pass
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toBeInstanceOf(SolClaimFailedError);
    expect(h.node.history.filter((t) => t.kind === "claim" && t.err !== null)).toHaveLength(3);
    expect(framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "reveal")).toHaveLength(0); // R3-10: never Claimed, no reveal
  });

  it("the public-secret mode is only ever allowed after the chain shows the secret public: asked for with a private secret it refuses", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const connected = await h.sellerRail.connect(termsOf(p as never), { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey });
    await expect(connected.claim(p.ref, sellerSecret(h), p.offerA.claimByMs, { retryPublicSecret: true })).rejects.toThrow(/no claim carrying this preimage was found/);
    expect(h.node.sent.claim).toBe(0);
  });

  /** Anyone can push an address's history around (SOL-C1, S2-3): entries a whole-history scan would have to page through. */
  function padEscrowHistory(h: SolHarness, statement: string, count: number): void {
    const escrow = base58.encode(escrowAddress(SOL_HTLC_PROGRAM_ID, h.buyerWallet.publicKey, statement).address);
    const list = h.node.chain.addressSignatures.get(escrow) ?? [];
    for (let i = 0; i < count; i += 1) list.unshift({ signature: base58.encode(new Uint8Array(64).fill(1 + (i % 250)).map((b, j) => (j === 0 ? (i >> 8) & 255 : j === 1 ? i & 255 : b))), slot: 1, err: CUSTOM(20) });
    h.node.chain.addressSignatures.set(escrow, list);
  }

  it("SOL-C1: a failed claim buried under 150 padding entries does not block the Seller's public-secret retry past claimByMs", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/payee's associated token account/);
    h.node.midFlight = undefined;
    h.node.afterLand = undefined;
    padEscrowHistory(h, p.statement, 150);
    h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n);
    h.setTime(p.offerA.claimByMs + 60_000); // past claimByMs, well before refundAfterMs
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
  });

  it("SOL-C1: the Seller's own retry needs no history scan at all: a history past the scan guard does not stop it (recorded signature)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/payee's associated token account/);
    h.node.midFlight = undefined;
    h.node.afterLand = undefined;
    padEscrowHistory(h, p.statement, 5100);
    h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n);
    h.setTime(p.offerA.claimByMs + 60_000);
    await h.sellerFlow.claimLegA(p.statement);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    expect(h.node.chain.historyScans()).toBe(0);
  });

  // -- S2-1: the Buyer claims leg B only once leg A reads Claimed at finalized; it never scans history ---------------

  it("S2-1: a failed Seller claim with the secret public: the Buyer does not claim leg B, and refunds leg A after the window", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    // the Seller claims without a reveal frame and its retry cannot land either: the secret is public, nobody was paid
    await expect(h.sellerFlow.claimLegA(p.statement, { skipReveal: true })).rejects.toThrow();
    h.node.midFlight = undefined;
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
    // the Buyer never learns the secret from the failed transaction, and leg B stays unclaimed
    await expect(h.buyerFlow.learnSecret()).rejects.toThrow(/leg A not claimed on chain yet/);
    await expect(h.buyerFlow.claimLegB(sellerSecret(h))).rejects.toThrow(/leg A is not Claimed on chain/);
    // the refund window opens: the Buyer refunds leg A (the program refuses every claim from now on)
    h.setTime(p.offerA.refundAfterMs);
    await h.buyerFlow.refundLegA();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
    expect(h.node.tokenBalance(h.buyerWallet.publicKey)).toBe(5_000_000n);
    // the Seller refunds leg B after its window: nobody loses
    h.setTime(legBDeadlines().refundAfterMs);
    await h.sellerFlow.refundLegB();
    await expect(h.buyerFlow.claimLegB(sellerSecret(h))).rejects.toThrow();
  });

  it("S2-1: a successful Seller claim: the Buyer learns the secret from the escrow and claims leg B; it never refunds leg A afterwards", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await h.sellerFlow.claimLegA(p.statement, { skipReveal: true });
    const before = h.node.chain.historyScans();
    const secret = await h.buyerFlow.learnSecret();
    expect(secret).toBe(sellerSecret(h));
    await h.buyerFlow.claimLegB(secret);
    expect(h.node.chain.historyScans()).toBe(before); // the Buyer never scans history
    h.setTime(p.offerA.refundAfterMs);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/already claimed leg B/);
    expect(h.node.sent.refund).toBe(0);
  });

  it("S2-1: padding over 5000 entries never affects the Buyer (learnSecret, claimLegB, refundLegA)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    padEscrowHistory(h, p.statement, 5100);
    await expect(h.buyerFlow.learnSecret()).rejects.toThrow(/leg A not claimed on chain yet/);
    await h.sellerFlow.claimLegA(p.statement, { skipReveal: true });
    padEscrowHistory(h, p.statement, 5100);
    await h.buyerFlow.claimLegB(await h.buyerFlow.learnSecret());
    expect(h.node.chain.historyScans()).toBe(0);

    const g = solHarness({ buyerSeed: 21, sellerSeed: 22 });
    const q = await lockedFlow(g);
    padEscrowHistory(g, q.statement, 5100);
    g.setTime(q.offerA.refundAfterMs);
    await g.buyerFlow.refundLegA();
    expect(g.node.escrow(q.statement, g.buyerWallet.publicKey)?.status).toBe("Refunded");
  });

  it("S2-1: a failed claim and its leaked secret never let the Buyer claim leg B (the escrow is not Claimed)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(); // R3-10: posts no reveal frame (not Claimed)
    h.node.midFlight = undefined;
    expect(framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "reveal")).toHaveLength(0);
    await expect(h.buyerFlow.learnSecret()).rejects.toThrow(/leg A not claimed on chain yet/);
    await expect(h.buyerFlow.claimLegB(sellerSecret(h))).rejects.toThrow(/leg A is not Claimed on chain/);
    h.setTime(p.offerA.refundAfterMs);
    await h.buyerFlow.refundLegA(); // a failed claim leaves no state: the refund is safe and is not refused
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
  });

  // -- S2-2: the Seller records every claim signature before sending -----------------------------------------------

  it("S2-2: a claim that landed, its reply lost, then 5001 padding entries: the retry resolves the recorded signature and pays the Seller", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.node.dropNextSendReplyFor = "claim";
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    padEscrowHistory(h, p.statement, 5001);
    const second = await h.sellerFlow.claimLegA(p.statement);
    expect(second.receipt).toBeDefined();
    expect(h.node.sent.claim).toBe(1);
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
    expect(h.node.chain.historyScans()).toBe(0);
  });

  it("S2-2: a FAILED claim, its reply lost, then 5001 padding entries: the retry proves the secret public by the recorded signature and pays the Seller", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    h.node.dropNextSendReplyFor = "claim";
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    h.node.midFlight = undefined;
    h.node.afterLand = undefined;
    padEscrowHistory(h, p.statement, 5001);
    h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n);
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
    expect(h.node.history.filter((t) => t.kind === "claim").map((t) => t.err !== null)).toEqual([true, false]);
    expect(h.node.chain.historyScans()).toBe(0);
  });

  it("S2-2: a claim still pending (SolPendingError) blocks a second claim until its blockhash expires; then the retry pays the Seller past 5001 padding entries", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.node.chain.once("sendTransaction", (params) => decodeSignature(params[0] as string)); // accepted, never lands
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/not settled yet|Pending/i);
    padEscrowHistory(h, p.statement, 5001);
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/not settled yet/); // the first may still land
    expect(h.node.sent.claim).toBe(0);
    h.node.chain.finalizedHeight = h.node.chain.lastValidBlockHeight + 1; // its blockhash expired: it can never land
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
  });

  it("S2-2: a transport error while resolving the recorded signature keeps it; the next call resolves it and pays the Seller past 5001 padding entries", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.node.dropNextSendReplyFor = "claim";
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    padEscrowHistory(h, p.statement, 5001);
    h.node.chain.once("getSignatureStatuses", () => {
      throw new Error("connection reset (test: transport failure while polling)");
    });
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/connection reset/);
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.sent.claim).toBe(1);
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
  });

  it("S2-2: a claim the simulation refused was never sent: its record is dropped, so it never blocks the next call", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    let refuse = true;
    h.node.chain.override("simulateTransaction", (_p, c) => ({ context: c.ctx("confirmed"), value: { err: refuse ? CUSTOM(17) : null, logs: [], unitsConsumed: 1 } }));
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    expect((h.sellerFlow as unknown as { claimRecords: unknown[] }).claimRecords).toHaveLength(0);
    refuse = false;
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.sent.claim).toBe(1);
  });

  // -- S2-3: the Seller never scans history ------------------------------------------------------------------------

  it("S2-3: 5001 padding entries before the first claim: the claim lands (no scan, no SolHistoryTooLongError)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    padEscrowHistory(h, p.statement, 5001);
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
    expect(h.node.chain.historyScans()).toBe(0);
  });

  // -- S2-4: retry first, reveal after -----------------------------------------------------------------------------

  it("S2-4: the public-secret retry is sent before any reveal post", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: true });
    const venue = h.venue as unknown as { post: (room: string, line: string, id: unknown) => Promise<unknown> };
    const original = venue.post.bind(venue);
    const claimsLandedAtRevealPost: number[] = [];
    venue.post = async (room, line, id) => {
      if ((tryDecodeFrame(line) as { type?: string } | null)?.type === "reveal") {
        claimsLandedAtRevealPost.push(h.node.history.filter((t) => t.kind === "claim" && t.err === null).length);
      }
      return original(room, line, id);
    };
    await h.sellerFlow.claimLegA(p.statement);
    expect(claimsLandedAtRevealPost).toEqual([1]); // the paying claim had already landed when the reveal went out
  });

  it("S2-4: a stalled venue never holds up the retry: the Seller is paid, each reveal attempt is bounded, and the call ends with RevealNotPostedError", async () => {
    const h = solHarness({ revealPostTimeoutMs: 20 });
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: true });
    const stall = stallPosts(h, "reveal");
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toBeInstanceOf(RevealNotPostedError);
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
    expect(h.node.history.filter((t) => t.kind === "claim").map((t) => t.err !== null)).toEqual([true, false]);
    expect(stall.stalled()).toBe(3); // three bounded attempts, none left hanging the call
  });

  it("SOL-C4: a reveal post that keeps failing does not stop the retry claim; the Seller is paid, then RevealNotPostedError", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: true });
    failPosts(h, "reveal", 6);
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toBeInstanceOf(RevealNotPostedError);
    expect(h.node.history.filter((t) => t.kind === "claim").map((t) => t.err !== null)).toEqual([true, false]);
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
  });

  it("SOL-C5 (R3-10): a failed claim whose reply was lost gets no reveal frame (the escrow never reads Claimed)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    armFailedClaim(h, { recreate: false });
    h.node.dropNextSendReplyFor = "claim";
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    expect(framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "reveal")).toHaveLength(0);
    h.node.midFlight = undefined;
    h.node.afterLand = undefined;
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/payee's associated token account/);
    expect(framesIn(await h.venue.read(dealRoomOf(p.acceptA)), "reveal")).toHaveLength(0);
  });

});

// -- refunds: confirmed only, pending claims route to learnSecret ------------------------------------------------

describe("G7/K2: a refund counts only when confirmed and never races a claim", () => {
  it("a refund whose reply was lost but which landed is recognised from the chain in the same call, with one broadcast", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.setTime(p.offerA.refundAfterMs);
    h.node.dropNextSendReplyFor = "refund";
    const evidence = await h.buyerFlow.refundLegA();
    expect(evidence.ref).toBe(p.ref);
    expect(h.node.sent.refund).toBe(1);
    const room = dealRoomOf(p.acceptA);
    expect(framesIn(await h.venue.read(room), "refund")).toHaveLength(1);
    const again = await h.buyerFlow.refundLegA();
    expect(again.ref).toBe(evidence.ref);
    expect(h.node.sent.refund).toBe(1);
  });

  it("a lock claimed on chain routes the Buyer to learnSecret()/claimLegB() and never broadcasts a refund", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await h.sellerFlow.claimLegA(p.statement, { skipReveal: true });
    h.setTime(p.offerA.refundAfterMs);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/call learnSecret\(\) then claimLegB\(\)/);
    expect(h.node.sent.refund).toBe(0);
  });

  it("a refund attempt before the window opens is refused by the flow, and by the chain's own time when the wall clock lies", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.clockRef.ms = p.offerA.refundAfterMs; // a fast wall clock; the chain has not reached refund_after_ms
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/chain time has not yet reached refundAfterMs/);
    expect(h.node.sent.refund).toBe(0);
  });
});

// -- learnSecret -------------------------------------------------------------------------------------------------

describe("learnSecret", () => {
  it("recovers the secret from the Seller's posted reveal frame without reading the escrow's history", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await h.sellerFlow.claimLegA(p.statement);
    const before = h.node.chain.historyScans();
    const secret = await h.buyerFlow.learnSecret();
    expect(secret).toBe(sellerSecret(h));
    expect(h.node.chain.historyScans()).toBe(before);
  });

  it("throws while the escrow is not Claimed on chain (S2-1)", async () => {
    const h = solHarness();
    await lockedFlow(h);
    await expect(h.buyerFlow.learnSecret()).rejects.toThrow(/leg A not claimed on chain yet/);
  });
});

// -- rail-level refusals the flows rely on -----------------------------------------------------------------------

describe("the rail wrapper's own refusals", () => {
  async function connected(h: SolHarness, p: Awaited<ReturnType<typeof lockedFlow>>, accounts: { payee?: string; payer?: string }) {
    return h.sellerRail.connect(termsOf(p as never), accounts);
  }

  it("a claim with no resolved payee line is refused before anything is signed", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const c = await connected(h, p, {});
    await expect(c.claim(p.ref, sellerSecret(h), p.offerA.claimByMs)).rejects.toThrow(/payee account line has not resolved/);
    expect(h.node.sent.claim).toBe(0);
  });

  it("H12: a claim is refused when the escrow pays a different wallet than this leg's resolved payee", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const c = await connected(h, p, { payee: solWallet(79).address, payer: h.buyerWallet.publicKey });
    await expect(c.claim(p.ref, sellerSecret(h), p.offerA.claimByMs)).rejects.toThrow(/pays a different wallet/);
    expect(h.node.sent.claim).toBe(0);
  });

  it("H12: a claim is refused when the escrow's payer is not this leg's resolved payer, or its amount/times differ", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const wrongPayer = await connected(h, p, { payee: h.sellerWallet.publicKey, payer: solWallet(80).address });
    await expect(wrongPayer.claim(p.ref, sellerSecret(h), p.offerA.claimByMs)).rejects.toThrow(/payer differs/);
    const wrongAmount = await h.sellerRail.connect({ ...termsOf(p as never), amount: "999" }, { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey });
    await expect(wrongAmount.claim(p.ref, sellerSecret(h), p.offerA.claimByMs)).rejects.toThrow(/amount differs/);
    const c3 = await h.sellerRail.connect({ ...termsOf(p as never), claimByMs: p.offerA.claimByMs + 1000 }, { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey });
    await expect(c3.claim(p.ref, sellerSecret(h), p.offerA.claimByMs)).rejects.toThrow(/claimByMs differs/);
    expect(h.node.sent.claim).toBe(0);
  });

  it("a claim for a ref of another hash lock, or an unparseable ref, is refused", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const c = await connected(h, p, { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey });
    await expect(c.claim(`0x${"cc".repeat(32)}:${h.buyerWallet.publicKey}`, sellerSecret(h), 1)).rejects.toThrow(/hash lock is not this leg's own/);
    await expect(c.claim("nonsense", sellerSecret(h), 1)).rejects.toThrow(/ref must be/);
  });

  it("prepareLock needs the payee's resolved wallet and a zero fee", async () => {
    const h = solHarness();
    const p = await pairWithLines(h);
    const terms = termsOf(p as never);
    const noPayee = await h.buyerRail.connect(terms, {});
    await expect(noPayee.prepareLock(terms, 0)).rejects.toThrow(/payee's resolved Solana wallet address/);
    const withPayee = await h.buyerRail.connect(terms, { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey });
    await expect(withPayee.prepareLock(terms, 30)).rejects.toThrow(/feeBps must be 0/);
  });

  it("lockRecorded: exists only for this payer's own escrow of this leg's amount", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const good = await connected(h, p, { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey });
    // the Seller's handle is not the payer: its own signer is not the ref's payer
    expect((await good.lockRecorded!(p.ref)).exists).toBe(false);
    const buyerTerms = termsOf(p as never);
    const own = await h.buyerRail.connect(buyerTerms, { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey });
    expect(await own.lockRecorded!(p.ref)).toEqual({ exists: true });
    expect((await own.lockRecorded!(`0x${"dd".repeat(32)}:${h.buyerWallet.publicKey}`)).exists).toBe(false);
    expect((await own.lockRecorded!(p.statement)).exists).toBe(false);
    const otherAmount = await h.buyerRail.connect({ ...buyerTerms, amount: "5" }, {});
    const mismatch = await otherAmount.lockRecorded!(p.ref);
    expect(mismatch.exists).toBe(false);
    expect(mismatch.reason).toMatch(/amount does not match/);
  });

  it("verifyLockFinal without the payer's proven line never verifies the lock (P7 fix F1)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const c = await connected(h, p, { payee: h.sellerWallet.publicKey });
    const result = await c.verifyLockFinal(termsOf(p as never), p.ref, { payee: h.sellerWallet.publicKey });
    expect(result.lock.railVerified).not.toBe(true);
    expect(result.rail).toBeUndefined();
  });
});

// -- round 3 (P6-SOL-FIXES-R3.md R3-2, R3-3): starved claims and a pending retry -------------------------------------------

describe("R3-2/R3-3: a starved claim is reported, priced higher and re-signed; a pending retry never blocks a public secret", () => {
  /** The price (micro-lamports per unit) of every claim transaction the node was sent, oldest first. */
  function sentClaimPrices(h: SolHarness): bigint[] {
    return h.node.chain.requests
      .filter((r) => r.method === "sendTransaction")
      .map((r) => decodeTransaction(Buffer.from(r.params[0] as string, "base64")))
      .filter((tx) => tx.message.instructions.some((ix) => ix.data.length === 33 && ix.data[0] === 1))
      .map((tx) => new DataView(tx.message.instructions[1]!.data.buffer, tx.message.instructions[1]!.data.byteOffset + 1, 8).getBigUint64(0, true));
  }

  /** Signs and sends one claim the node accepts and never lands (the network starved it). */
  async function starveFirstClaim(h: SolHarness, statement: string): Promise<void> {
    h.node.chain.once("sendTransaction", (params) => decodeSignature(params[0] as string));
    await expect(h.sellerFlow.claimLegA(statement)).rejects.toThrow(/not settled yet|Pending/i);
  }

  it("a claim that never landed is re-signed at a doubled price, lands, and the result says the secret was possibly seen", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await starveFirstClaim(h, p.statement);
    h.node.chain.finalizedHeight = h.node.chain.lastValidBlockHeight + 1; // its blockhash expired with no status
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.neverLandedClaims).toBe(1);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    const prices = sentClaimPrices(h);
    expect(prices).toHaveLength(2);
    expect(prices[1]).toBe((prices[0] as bigint) * 2n);
  });

  it("a clean claim reports no never-landed count", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.neverLandedClaims).toBeUndefined();
  });

  it("after a never-landed claim the Seller keeps claiming past the 5-minute policy margin, up to the landing bound", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await starveFirstClaim(h, p.statement);
    h.node.chain.finalizedHeight = h.node.chain.lastValidBlockHeight + 1;
    h.setTime(p.offerA.refundAfterMs - 3 * 60_000); // inside the 5-minute margin, outside the 2-minute landing margin
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
  });

  it("without a never-landed claim the same late moment is still refused by the policy margin (the relaxation is only for a possibly-seen secret)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.setTime(p.offerA.refundAfterMs - 3 * 60_000);
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/claimByMs|claim-inclusion margin/);
    expect(h.node.sent.claim).toBe(0);
  });

  it("past the landing bound the end of the effort is SolClaimStarvedError ('secret broadcast but not landed (possibly seen)'), never a silent drop", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await starveFirstClaim(h, p.statement);
    h.node.chain.finalizedHeight = h.node.chain.lastValidBlockHeight + 1;
    h.setTime(p.offerA.refundAfterMs - 60_000); // inside the landing margin: no claim can be guaranteed to land or be dropped in time
    const error = await h.sellerFlow.claimLegA(p.statement).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SolClaimStarvedError);
    expect((error as Error).message).toMatch(/secret broadcast but not landed \(possibly seen\)/);
    expect((error as Error).message).toMatch(/leg B exposed until legB\.refundAfterMs/); // R4-4
    expect((error as SolClaimStarvedError).neverLandedClaims).toBe(1);
    expect(h.node.sent.claim).toBe(0);
  });

  it("R3-3: in public-secret mode an earlier retry that is still undecided does not block the next claim", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    // claim 1 lands and FAILS (secret public); claim 2 (the retry) is accepted by the node and starved
    let frozen = false;
    h.node.midFlight = (kind) => {
      if (kind === "claim" && !frozen) {
        frozen = true;
        h.node.freezeToken(h.sellerWallet.publicKeyBytes);
      }
    };
    h.node.afterLand = (kind, failed) => {
      if (kind === "claim" && failed) {
        h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n); // the account is fixed again
        h.node.chain.once("sendTransaction", (params) => decodeSignature(params[0] as string));
      }
    };
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/not settled yet|Pending/i);
    expect(h.node.history.filter((t) => t.kind === "claim").map((t) => t.err !== null)).toEqual([true]);
    expect((h.sellerFlow as unknown as { claimRecords: unknown[] }).claimRecords).toHaveLength(1); // the starved retry, still latched
    // the retry is still undecided (its blockhash has not expired): the Seller must not wait for it
    const result = await h.sellerFlow.claimLegA(p.statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
    expect(h.node.tokenBalance(h.sellerWallet.publicKey)).toBe(1_000_000n);
  });

  it("R3-3: while the secret is still private an undecided claim DOES block the next one (the rule stays)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await starveFirstClaim(h, p.statement);
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/not settled yet/);
    expect(h.node.sent.claim).toBe(0);
  });
});

// -- R3-6 .. R3-8: the Buyer's refund, the chain clock, the finality-lag window ------------------------------------

describe("R3-6: a claimed leg B stops the Buyer's refund of leg A", () => {
  it("a third party claims leg B with the public secret after a failed Seller claim: refundLegA refuses with the distinct error and sends no refund", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    // the Seller's claim lands and FAILS (its payee account is frozen): the secret is public in that transaction
    h.node.midFlight = (kind) => {
      if (kind === "claim") h.node.freezeToken(h.sellerWallet.publicKeyBytes);
    };
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow();
    h.node.midFlight = undefined;
    h.node.afterLand = undefined;
    // a third party reads the secret off the failed transaction and claims leg B on the paper rail
    const legBContract = (tryDecodeFrame(p.acceptBRecord.line) as AcceptFrame).contract;
    await new PaperRail(h.noteStore, h.clock).claim(legBContract, sellerSecret(h));

    h.setTime(p.offerA.refundAfterMs);
    const refusal = h.buyerFlow.refundLegA();
    await expect(refusal).rejects.toBeInstanceOf(LegBClaimedError);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/leg B was claimed with the public secret; leg A is owed to the Seller; settle by hand/);
    expect(h.node.sent.refund).toBe(0);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Locked");
  });

  it("with leg B still locked the same Buyer's refund goes through (the guard reads leg B's own record)", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.setTime(p.offerA.refundAfterMs);
    await h.buyerFlow.refundLegA();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
  });
});

describe("R4-1/R4-2: the refund guard trusts only a proven leg-B claim and checks leg A's own Claimed first", () => {
  /** Overwrites leg B's paper note with an arbitrary "claimed" line (the namespace is world-writable). */
  async function forgeLegBNote(h: SolHarness, p: { acceptBRecord: { line: string } }, mutate: (r: { lock: "hash"; statement: string; refundAfterMs: number; secret: string }) => void): Promise<void> {
    const legBContract = (tryDecodeFrame(p.acceptBRecord.line) as AcceptFrame).contract;
    const { ns, key } = paperNote(legBContract);
    const current = decodePaperRecord((await h.noteStore.get(ns, key)) as string);
    const record = { lock: "hash" as const, statement: current!.statement, refundAfterMs: current!.refundAfterMs, secret: sellerSecret(h) };
    mutate(record);
    await h.noteStore.set(ns, key, encodePaperRecord({ status: "claimed", ...record }));
  }

  it("R4-1: a forged note with a secret that does not open the statement does not block the refund", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await forgeLegBNote(h, p, (r) => {
      r.secret = "0x" + "11".repeat(32);
    });
    h.setTime(p.offerA.refundAfterMs);
    await h.buyerFlow.refundLegA();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
    expect(h.buyerFlow.refundNotes.join(" ")).toMatch(/not a proven claim/);
  });

  it("R4-1: a note whose terms do not match leg B (even with a real secret) does not block the refund", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await forgeLegBNote(h, p, (r) => {
      r.refundAfterMs += 1;
    });
    h.setTime(p.offerA.refundAfterMs);
    await h.buyerFlow.refundLegA();
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Refunded");
    expect(h.buyerFlow.refundNotes).toHaveLength(1);
  });

  it("R4-1: a note carrying the right terms and a secret that opens the statement blocks the refund, and the error says what it means", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await forgeLegBNote(h, p, () => undefined);
    h.setTime(p.offerA.refundAfterMs);
    const error = await h.buyerFlow.refundLegA().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LegBClaimedError);
    expect((error as Error).message).toMatch(/unauthenticated: this means the secret is public and leg B reads claimed/);
    expect(h.node.sent.refund).toBe(0);
  });

  it("R4-2: when leg A itself is Claimed the Buyer gets the learnSecret()/claimLegB() routing even though leg B also reads claimed", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await h.sellerFlow.claimLegA(p.statement);
    const legBContract = (tryDecodeFrame(p.acceptBRecord.line) as AcceptFrame).contract;
    await new PaperRail(h.noteStore, h.clock).claim(legBContract, sellerSecret(h));
    h.setTime(p.offerA.refundAfterMs);
    const error = await h.buyerFlow.refundLegA().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(LegBClaimedError);
    expect((error as Error).message).toMatch(/call learnSecret\(\) then claimLegB\(\) instead of refundLegA\(\)/);
    expect(h.node.sent.refund).toBe(0);
  });
});

describe("R3-7: the chain clock check on lockLegA and the Seller's acceptLegA", () => {
  it("the named bound is 60 s", () => {
    expect(SOL_CHAIN_CLOCK_SKEW_MS).toBe(60_000);
  });

  it("lockLegA refuses when the chain's finalized clock is more than the bound behind or ahead of the local clock, and sends nothing", async () => {
    for (const skewMs of [-(SOL_CHAIN_CLOCK_SKEW_MS + 1_000), SOL_CHAIN_CLOCK_SKEW_MS + 1_000]) {
      const h = solHarness();
      await pairWithLines(h);
      h.node.nowMs = h.clockRef.ms + skewMs;
      await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/refusing to lock leg A - the chain's finalized clock .* differ by .* more than 60000 ms \(R3-7\)/);
      expect(h.node.sent.lock).toBe(0);
    }
  });

  it("lockLegA accepts a skew inside the bound", async () => {
    const h = solHarness();
    await pairWithLines(h);
    h.node.nowMs = h.clockRef.ms - (SOL_CHAIN_CLOCK_SKEW_MS - 1_000);
    await h.buyerFlow.lockLegA();
    expect(h.node.sent.lock).toBe(1);
  });

  it("the Seller's acceptLegA refuses a chain clock outside the bound and posts nothing", async () => {
    const h = solHarness();
    const legA = legADeadlines(6 * 60 * 60_000);
    const offerA = await h.buyerFlow.bid({ swapId: computeSwapId(h.buyer.did, "00000001"), ...BID, claimByMs: legA.claimByMs, refundAfterMs: legA.refundAfterMs, expiresMs: T0 + 10 * 60_000 });
    const before = (await h.venue.read("tclk-offers")).length;
    h.node.nowMs = h.clockRef.ms + SOL_CHAIN_CLOCK_SKEW_MS + 1_000;
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs)).rejects.toThrow(/refusing to accept leg A - the chain's finalized clock .* \(R3-7\)/);
    expect((await h.venue.read("tclk-offers")).length).toBe(before);
    h.node.nowMs = h.clockRef.ms;
    await h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
  });
});

describe("R3-8: a claim seen only after the refund failed routes to learnSecret()/claimLegB()", () => {
  it("a relayer's claim lands between the pre-check and the refund: the Buyer is told to claim leg B, not shown the refund's own refusal", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    h.setTime(p.offerA.refundAfterMs);
    const relayer = InMemorySolSigner.generate(new Uint8Array(32).fill(14));
    const tx = await relayerClaim(h, p.statement, sellerSecret(h), relayer);
    h.node.midFlight = (kind) => {
      if (kind !== "refund") return;
      // the claim landed just before refund_after_ms (the chain's own time then), and was not yet final when the
      // refund's pre-check read the escrow
      h.node.nowMs = p.offerA.refundAfterMs - 1_000;
      h.node.executeAndLand(tx);
      h.node.nowMs = p.offerA.refundAfterMs;
    };
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/call learnSecret\(\) then claimLegB\(\) instead of refundLegA\(\) \(R3-8\)/);
    expect(h.node.escrow(p.statement, h.buyerWallet.publicKey)?.status).toBe("Claimed");
  });
});
