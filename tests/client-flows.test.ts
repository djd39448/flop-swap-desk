// SPDX-License-Identifier: MIT
//
// tests/client-flows.test.ts — P22-P24-EVM-FIXES.md B6: hermetic unit tests (mocked transport,
// MemoryVenue, no anvil) for the Seller/Buyer client flows' own refusals — the B1 and B3
// authentication/authorization guards, the deadline and account-line gates `lockLegA` refuses
// on, both refund-timing guards, a mismatched hashLock, and `claimLegA`'s chain-time claimBy/
// margin guard (B2). The happy path end to end (a real lock, a real claim, a real settle) is
// covered on a real anvil node by tests-anvil/client-flows.anvil.test.ts; this file only needs
// enough of each flow to reach the refusal under test, so most cases here never touch an RPC at
// all — `unreachableRpc()` below throws if one ever tries, which is itself part of what a fix
// guarantees (a bad state is refused before any network call, not just before a real signature).
//
// P22-P24-EVM-FIXES.md B2's "a claim that simulates to a revert is never sent" is unit-tested
// directly against `EvmHtlcRail.claim` in tests/evm-htlc.test.ts ("claim() never broadcasts when
// the simulation reverts") — `SellerFlow.claimLegA` calls that exact method unmodified, so this
// file does not duplicate the (fairly heavy) ABI-encoded `locks()`/finalized-block mocking that
// would be needed to also drive it from here.
//
// Design source: flop-contrib/handoff/P22-P24-EVM-FIXES.md B1, B2, B3, B6.

import {
  MemoryNoteStore,
  OFFER_ROOM,
  PaperRail,
  encodeFrame,
  generateHashLock,
  makeAccept,
  tryDecodeFrame,
  type AcceptFrame,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";
import { getAddress, numberToHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { EVM_LOCAL_POLICY } from "../src/client/policy.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { identity, record, unsignedRecord, type Identity } from "./helpers/identity.js";

function addr(tag: string): Address {
  const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
  return getAddress(`0x${hex}`);
}

/** Deterministic, distinct did:key identities — one 32-byte hex seed per party, never reused
 *  across tests (a reused seed would make two "different" parties the same DID). */
function ident(tag: number): Identity {
  return identity(tag.toString(16).padStart(2, "0").repeat(32));
}

const T0 = 1_700_000_000_000;
const RAIL_CONTRACT = addr("client-flows-rail");
const TOKEN = addr("client-flows-usdc");
const BUYER_ACCOUNT = addr("client-flows-buyer-account");
const SELLER_ACCOUNT = addr("client-flows-seller-account");

function evmConfig(): EvmRailConfig {
  return { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: RAIL_CONTRACT, assets: { USDC: TOKEN } };
}

/** A `CapturingRpc` whose transport throws on any call — every test that expects a refusal to
 *  happen before this flow ever touches the network uses this, so a regression that let the
 *  flow reach the RPC layer fails loudly instead of silently mocking its way past the bug. */
function unreachableRpc(): CapturingRpc {
  const fetchImpl = (async () => {
    throw new Error("client-flows.test.ts: unexpected network call in a hermetic test");
  }) as unknown as typeof fetch;
  return new CapturingRpc({ endpoint: "http://unreachable.invalid", fetch: fetchImpl });
}

type Responder = (params: readonly unknown[]) => { result?: unknown; error?: { code: number; message: string } };

/** The same hand-rolled JSON-RPC mock pattern tests/evm-htlc.test.ts uses, reused here for the
 *  two `claimLegA` chain-time tests (B2) that need `eth_chainId` (EvmHtlcRail.connect) and
 *  `eth_getBlockByNumber("latest", false)` (EvmHtlcRail.latestBlockTimestampMs). */
function mockRpc(handlers: Record<string, Responder>): CapturingRpc {
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
    const handler = handlers[body.method];
    if (handler === undefined) throw new Error(`mock rpc: unexpected method ${body.method}`);
    const response = handler(body.params);
    const envelope =
      response.error !== undefined
        ? { jsonrpc: "2.0", id: body.id, error: response.error }
        : { jsonrpc: "2.0", id: body.id, result: response.result };
    const text = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return new CapturingRpc({ endpoint: "http://mock-evm", fetch: fetchImpl });
}

function legADeadlines(t0: number) {
  return { claimByMs: t0 + 60 * 60_000, refundAfterMs: t0 + 90 * 60_000, expiresMs: t0 + 30 * 60_000 };
}
function legBDeadlines(t0: number) {
  return { claimByMs: t0 + 120 * 60_000, refundAfterMs: t0 + 180 * 60_000, expiresMs: t0 + 40 * 60_000 };
}

interface Harness {
  buyer: Identity;
  seller: Identity;
  venue: MemoryVenue;
  clockRef: { ms: number };
  clock: () => number;
  buyerFlow: BuyerFlow;
  sellerFlow: SellerFlow;
}

function harness(buyerTag: number, sellerTag: number, opts?: { buyerRpc?: CapturingRpc; sellerRpc?: CapturingRpc }): Harness {
  const buyer = ident(buyerTag);
  const seller = ident(sellerTag);
  const clockRef = { ms: T0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const config = evmConfig();
  const buyerFlow = new BuyerFlow({
    identity: buyer,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    account: BUYER_ACCOUNT,
    rpc: opts?.buyerRpc ?? unreachableRpc(),
    evmConfig: config,
    clock,
  });
  const sellerFlow = new SellerFlow({
    identity: seller,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    account: SELLER_ACCOUNT,
    rpc: opts?.sellerRpc ?? unreachableRpc(),
    evmConfig: config,
    clock,
  });
  return { buyer, seller, venue, clockRef, clock, buyerFlow, sellerFlow };
}

async function bidAndAcceptA(
  h: Harness,
  nonceHex: string,
  legB: { claimByMs: number; refundAfterMs: number; expiresMs: number } = legBDeadlines(T0),
): Promise<{ swapId: string; offerA: OfferFrame; acceptA: AcceptFrame; acceptARecord: TranscriptRecord; offerB: OfferFrame }> {
  const swapId = computeSwapId(h.buyer.did, nonceHex);
  const offerA = await h.buyerFlow.bid({
    swapId,
    wantAsset: "FLOP",
    wantAmount: "52070000",
    wantRail: "flop-htlc",
    amount: "1000000",
    asset: "USDC",
    ...legADeadlines(T0),
  });
  const { acceptA, acceptARecord, offerB } = await h.sellerFlow.acceptLegA(offerA, legB, T0);
  return { swapId, offerA, acceptA, acceptARecord, offerB };
}

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both account lines — the
 *  full happy prefix, reused by tests that need to reach `lockLegA`. */
async function pairLockBAndAccountLines(h: Harness, nonceHex: string) {
  const { swapId, offerA, acceptA, acceptARecord, offerB } = await bidAndAcceptA(h, nonceHex);
  const { acceptB, acceptBRecord } = await h.buyerFlow.acceptLegB(offerB, acceptARecord, T0);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
  await h.buyerFlow.postAccountLineA(BUYER_ACCOUNT);
  return { swapId, offerA, acceptA, offerB, acceptB };
}

describe("SellerFlow.acceptLegA — B2 deadline/margin refusals", () => {
  it("refuses a leg A offer whose claimByMs..refundAfterMs gap is below the claim-inclusion margin", async () => {
    const h = harness(1, 2);
    const swapId = computeSwapId(h.buyer.did, "00000001");
    const offerA = await h.buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      claimByMs: T0 + 60 * 60_000,
      refundAfterMs: T0 + 60 * 60_000 + 60_000, // 1 minute, well under the 5-minute margin
      expiresMs: T0 + 30 * 60_000,
    });
    await expect(h.sellerFlow.acceptLegA(offerA, legBDeadlines(T0), T0)).rejects.toThrow(/claim-inclusion margin/);
  });

  it("refuses to propose leg B deadlines its own checkSwapDeadlines would call unsafe", async () => {
    const h = harness(3, 4);
    const swapId = computeSwapId(h.buyer.did, "00000001");
    const offerA = await h.buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "1",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      ...legADeadlines(T0),
    });
    // legB.claimByMs far too soon after legA.refundAfterMs (rule 2 needs >= legA.refundAfterMs +
    // finalityAMs).
    const badLegB = { claimByMs: T0 + 91 * 60_000, refundAfterMs: T0 + 200 * 60_000, expiresMs: T0 + 40 * 60_000 };
    await expect(h.sellerFlow.acceptLegA(offerA, badLegB, T0)).rejects.toThrow(/leg B deadlines it would propose are unsafe/);
  });
});

describe("SellerFlow.lockLegB — B1 (CRITICAL)", () => {
  it("locks leg B on a genuine, correctly-authenticated accept (sanity check)", async () => {
    const h = harness(5, 6);
    const { offerB, acceptARecord } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerB, acceptARecord, T0);
    await expect(h.sellerFlow.lockLegB(acceptBRecord)).resolves.toBeDefined();
  });

  it("refuses an unauthenticated (unsigned) accept record", async () => {
    const h = harness(7, 8);
    const { offerB } = await bidAndAcceptA(h, "00000001");
    const acceptB = makeAccept(offerB, { from: h.buyer.did, statement: h.sellerFlow.statement! });
    const forged = unsignedRecord(OFFER_ROOM, 999, T0, encodeFrame(acceptB));
    await expect(h.sellerFlow.lockLegB(forged)).rejects.toThrow(/does not authenticate/);
  });

  it("refuses a record whose signer differs from the frame's own claimed sender", async () => {
    const h = harness(9, 10);
    const attacker = ident(11);
    const { offerB } = await bidAndAcceptA(h, "00000001");
    // A cryptographically valid record — signed by `attacker` as `record.sender` — but the
    // frame it carries claims `from: h.buyer.did`, a DID the attacker never controls.
    const acceptB = makeAccept(offerB, { from: h.buyer.did, statement: h.sellerFlow.statement! });
    const forged = record(OFFER_ROOM, 999, T0, attacker, encodeFrame(acceptB));
    await expect(h.sellerFlow.lockLegB(forged)).rejects.toThrow(/not an authenticated accept frame/);
  });

  it("refuses an accept naming the acceptor's own statement instead of this Seller's minted one (the reviewer's attack)", async () => {
    const h = harness(12, 13);
    const attacker = ident(14);
    const { offerB } = await bidAndAcceptA(h, "00000001");
    const attackerHashLock = generateHashLock();
    // The attacker mints its own statement (whose preimage only it knows) and accepts leg B
    // under it — before B1, SellerFlow.lockLegB trusted this outright and the attacker could
    // then immediately claim leg B with the preimage it already holds.
    const forgedAccept = makeAccept(offerB, { from: attacker.did, statement: attackerHashLock.hash });
    const forgedRecord = await h.venue.post(OFFER_ROOM, encodeFrame(forgedAccept), attacker);
    await expect(h.sellerFlow.lockLegB(forgedRecord)).rejects.toThrow(/not this flow's own minted statement/);
  });

  it("refuses an accept from a DID other than the Buyer who opened leg A, even using the real (public) statement", async () => {
    const h = harness(15, 16);
    const attacker = ident(17);
    const { offerB } = await bidAndAcceptA(h, "00000001");
    // The statement is public once offerB/acceptA are posted — an attacker can read it and
    // accept leg B with the *correct* statement, naming only itself as acceptor.
    const forgedAccept = makeAccept(offerB, { from: attacker.did, statement: h.sellerFlow.statement! });
    const forgedRecord = await h.venue.post(OFFER_ROOM, encodeFrame(forgedAccept), attacker);
    await expect(h.sellerFlow.lockLegB(forgedRecord)).rejects.toThrow(/not from the Buyer who opened leg A/);
  });

  it("refuses an accept that does not reference this flow's own leg B offer", async () => {
    const h = harness(18, 19);
    const { offerA, offerB } = await bidAndAcceptA(h, "00000001");
    const acceptB = makeAccept(offerB, { from: h.buyer.did, statement: h.sellerFlow.statement! });
    const frame = tryDecodeFrame(encodeFrame(acceptB));
    if (frame === null || frame.type !== "accept") throw new Error("test setup: expected an accept frame");
    const tampered = { ...frame, ref: offerA.id }; // some other, real offer id — never offerB.id
    const tamperedRecord = await h.venue.post(OFFER_ROOM, encodeFrame(tampered), h.buyer);
    await expect(h.sellerFlow.lockLegB(tamperedRecord)).rejects.toThrow(/does not reference this flow's leg B offer/);
  });

  it("refuses an accept whose contract id does not match tclk's own derivation for this offer/accept pair", async () => {
    const h = harness(20, 21);
    const { offerB } = await bidAndAcceptA(h, "00000001");
    const acceptB = makeAccept(offerB, { from: h.buyer.did, statement: h.sellerFlow.statement! });
    const frame = tryDecodeFrame(encodeFrame(acceptB));
    if (frame === null || frame.type !== "accept") throw new Error("test setup: expected an accept frame");
    const tampered = { ...frame, contract: `0x${"ab".repeat(32)}` };
    const tamperedRecord = await h.venue.post(OFFER_ROOM, encodeFrame(tampered), h.buyer);
    await expect(h.sellerFlow.lockLegB(tamperedRecord)).rejects.toThrow(/contract id does not match/);
  });
});

describe("BuyerFlow.acceptLegB — B3", () => {
  it("refuses an unauthenticated leg A accept record", async () => {
    const h = harness(22, 23);
    const { offerB, acceptA } = await bidAndAcceptA(h, "00000001");
    const forged = unsignedRecord(OFFER_ROOM, 999, T0, encodeFrame(acceptA));
    await expect(h.buyerFlow.acceptLegB(offerB, forged, T0)).rejects.toThrow(/leg A accept record does not authenticate/);
  });

  it("refuses a leg A accept record whose signer differs from the frame's own claimed sender", async () => {
    const h = harness(24, 25);
    const attacker = ident(26);
    const { offerB, acceptA } = await bidAndAcceptA(h, "00000001");
    const forged = record(OFFER_ROOM, 999, T0, attacker, encodeFrame(acceptA));
    await expect(h.buyerFlow.acceptLegB(offerB, forged, T0)).rejects.toThrow(/not an authenticated accept frame/);
  });

  it("refuses a leg A accept that is not from the Seller who posted leg B's offer", async () => {
    const h = harness(27, 28);
    const impostor = ident(29);
    const { offerA, offerB } = await bidAndAcceptA(h, "00000001");
    // A properly authenticated accept for leg A — just not from the DID that actually posted
    // offerB.
    const impostorAccept = makeAccept(offerA, { from: impostor.did, statement: generateHashLock().hash });
    const impostorRecord = await h.venue.post(OFFER_ROOM, encodeFrame(impostorAccept), impostor);
    await expect(h.buyerFlow.acceptLegB(offerB, impostorRecord, T0)).rejects.toThrow(
      /not from the Seller who posted leg B's offer/,
    );
  });

  it("refuses an unsafe deadline pair even with a fully genuine leg A accept", async () => {
    const h = harness(30, 31);
    const { offerB, acceptARecord } = await bidAndAcceptA(h, "00000001");
    // lockTimeMs so late that rule 1 (the Seller's real reveal window) is violated.
    const unsafeLockTimeMs = legADeadlines(T0).refundAfterMs - 60_000;
    await expect(h.buyerFlow.acceptLegB(offerB, acceptARecord, unsafeLockTimeMs)).rejects.toThrow(/unsafe deadlines/);
  });
});

describe("BuyerFlow.lockLegA — refusals never touch the network", () => {
  it("refuses before leg B verifies", async () => {
    const h = harness(32, 33);
    const { offerB, acceptARecord } = await bidAndAcceptA(h, "00000001");
    await h.buyerFlow.acceptLegB(offerB, acceptARecord, T0);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/before leg B verifies/);
  });

  it("refuses when the deadline re-check fails at the real lock time (B3)", async () => {
    const h = harness(34, 35);
    await pairLockBAndAccountLines(h, "00000001");
    // Time has moved on well past what checkSwapDeadlines would allow for a lock happening now.
    h.clockRef.ms = legADeadlines(T0).refundAfterMs - 1_000;
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/deadlines are no longer safe at lock time/);
  });

  it("refuses before the Seller's account line resolves (D-08)", async () => {
    const h = harness(36, 37);
    const { offerB, acceptARecord } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerB, acceptARecord, T0);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    // Deliberately never call sellerFlow.postAccountLineA.
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/Seller's account line has not resolved/);
  });
});

describe("Refund guards refuse before touching the network", () => {
  it("BuyerFlow.refundLegA refuses before A.refundAfterMs", async () => {
    const h = harness(38, 39);
    await pairLockBAndAccountLines(h, "00000001");
    // Field injection: isolate the refundAfterMs guard from the (separately meaningful)
    // "never locked" guard that runs before it, without needing a real anvil lock.
    (h.buyerFlow as unknown as { lockedHashLock: Hex }).lockedHashLock = `0x${"11".repeat(32)}`;
    h.clockRef.ms = legADeadlines(T0).refundAfterMs - 1_000;
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/before its refundAfterMs/);
  });

  it("SellerFlow.refundLegB refuses before B.refundAfterMs", async () => {
    const h = harness(40, 41);
    await pairLockBAndAccountLines(h, "00000001");
    h.clockRef.ms = legBDeadlines(T0).refundAfterMs - 1_000;
    await expect(h.sellerFlow.refundLegB()).rejects.toThrow(/before its refundAfterMs/);
  });
});

describe("SellerFlow.claimLegA — B2", () => {
  it("refuses a hashLock that does not match this flow's own minted statement", async () => {
    const h = harness(42, 43);
    await bidAndAcceptA(h, "00000001");
    await expect(h.sellerFlow.claimLegA(`0x${"ff".repeat(32)}`)).rejects.toThrow(/hashLock does not match/);
  });

  it("refuses to claim at/after claimByMs, by chain time — never wall-clock", async () => {
    const rpc = mockRpc({
      eth_chainId: () => ({ result: "0x7a69" }), // 31337, matches ANVIL_LOCAL_PIN
      eth_getBlockByNumber: () => ({ result: { timestamp: numberToHex(Math.floor((T0 + 60 * 60_000) / 1000)) } }),
    });
    const h = harness(44, 45, { sellerRpc: rpc });
    await bidAndAcceptA(h, "00000001"); // legA.claimByMs = T0 + 60min; the mocked chain time is exactly that.
    await expect(h.sellerFlow.claimLegA(h.sellerFlow.statement!)).rejects.toThrow(/at\/after its claimByMs \(chain time\)/);
  });

  // The Seller's own accept-time guard (tested above) already keeps
  // `refundAfterMs - claimByMs >= claimInclusionMarginMs` for any offer this flow actually
  // accepted, which makes this branch unreachable through the public API alone (chain time
  // below claimByMs implies more than the margin remains before refundAfterMs, by that same
  // accept-time invariant). Field-injecting a pre-accepted offer whose own gap is *already*
  // below the margin isolates this guard exactly the way the accept-time test isolates its own
  // — verifying it independently is the point of defense in depth.
  it("refuses to claim when less than the claim-inclusion margin remains before refundAfterMs, by chain time", async () => {
    const claimByMs = T0 + 61 * 60_000;
    const refundAfterMs = T0 + 62 * 60_000; // 1-minute gap: below the 5-minute margin.
    const rpc = mockRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      // 1 minute before claimByMs; only 2 minutes remain before refundAfterMs.
      eth_getBlockByNumber: () => ({ result: { timestamp: numberToHex(Math.floor((claimByMs - 60_000) / 1000)) } }),
    });
    const h = harness(46, 47, { sellerRpc: rpc });
    const { offerA, acceptARecord } = await bidAndAcceptA(h, "00000001");
    const hashLock = generateHashLock();
    const acceptA = makeAccept(offerA, { from: h.seller.did, statement: hashLock.hash });
    const tamperedOfferA: OfferFrame = { ...offerA, claimByMs, refundAfterMs };
    // Deliberately bypasses acceptLegA's own margin guard — see the comment above.
    Object.assign(h.sellerFlow as unknown as Record<string, unknown>, {
      offerA: tamperedOfferA,
      acceptA: { ...acceptA, ref: tamperedOfferA.id },
      hashLock,
    });
    void acceptARecord;
    await expect(h.sellerFlow.claimLegA(hashLock.hash)).rejects.toThrow(/claim-inclusion margin.*remains before refundAfterMs/);
  });
});
