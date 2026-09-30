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
// would be needed to also drive it from here — except for P22-P24-EVM-FIXES-R3.md E4's own
// client-side re-check (below), which needs `verifyLockFinal` to actually succeed once and so
// cannot avoid that mocking.
//
// P22-P24-EVM-FIXES-R3.md group E (fund safety under failure and repetition): E1 (a Buyer pairs
// leg B once, and re-verifies it immediately before spending), E2 (a Seller's leg-B lock latch
// never reopens once attempted), E3 (a Buyer records its own lock state before ever sending it),
// E4 (a Seller re-checks chain time again after `verifyLockFinal` returns, immediately before
// claiming).
//
// Design source: flop-contrib/handoff/P22-P24-EVM-FIXES.md B1, B2, B3, B6;
// P22-P24-EVM-FIXES-R3.md E1, E2, E3, E4.

import {
  MemoryNoteStore,
  dealRoom,
  OFFER_ROOM,
  PaperRail,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  tryDecodeFrame,
  type AcceptFrame,
  type NoteStore,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";
import { encodeEventTopics, encodeFunctionData, encodeFunctionResult, getAddress, numberToHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { EVM_LOCAL_POLICY } from "../src/client/policy.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { formatAccountLine, parseAccountLine, resolveAccounts } from "../src/rails/account-line.js";
import { evmSigner } from "./helpers/proven-lines.js";
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
// P7: the parties' accounts hold keys here (a stand-in for the node-held accounts anvil signs
// with over RPC), so `postAccountLineA` can post the proven line every resolver now requires.
const BUYER_SIGNER = evmSigner(0x401);
const SELLER_SIGNER = evmSigner(0x402);
const BUYER_ACCOUNT = BUYER_SIGNER.address;
const SELLER_ACCOUNT = SELLER_SIGNER.address;

/** The two reads a proven account line costs on the wire: the pin check (`eth_chainId`) and the
 *  node's `personal_sign` (answered here by the account's own stand-in key). Every other method
 *  stays whatever the test's transport says it is. */
function proofRpcResult(method: string, params: readonly unknown[]): { result: unknown } | undefined {
  if (method === "eth_chainId") return { result: `0x${ANVIL_LOCAL_PIN.chainId.toString(16)}` };
  if (method === "personal_sign") {
    const hex = String(params[0]);
    const account = String(params[1]).toLowerCase();
    const signer = [BUYER_SIGNER, SELLER_SIGNER].find((candidate) => candidate.address.toLowerCase() === account);
    if (signer === undefined) return undefined;
    return { result: `0x${signer.signPersonal(Buffer.from(hex.slice(2), "hex").toString("utf8"))}` };
  }
  return undefined;
}
const TX_HASH = ("0x" + "aa".repeat(32)) as Hex;
const BLOCK_HASH = ("0x" + "cd".repeat(32)) as Hex;

function evmConfig(): EvmRailConfig {
  return { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: RAIL_CONTRACT, assets: { USDC: TOKEN } };
}

const REFUNDED_EVENT = {
  type: "event",
  name: "Refunded",
  inputs: [{ name: "hashLock", type: "bytes32", indexed: true }],
} as const;

/** E3: a minimal, correctly-encoded `Refunded` log — the same small helper pattern
 *  tests/evm-htlc.test.ts's own `buildLog` uses, kept local here since this file needs only
 *  this one event shape. */
function buildRefundedLog(hashLock: Hex, meta: { blockNumber: string; blockHash: Hex; txHash: Hex; logIndex: string }) {
  const topics = encodeEventTopics({ abi: [REFUNDED_EVENT], eventName: "Refunded", args: { hashLock } } as never);
  return {
    address: RAIL_CONTRACT,
    topics,
    data: "0x" as Hex,
    blockNumber: meta.blockNumber,
    blockHash: meta.blockHash,
    transactionHash: meta.txHash,
    transactionIndex: "0x0",
    logIndex: meta.logIndex,
    removed: false,
  };
}

/** A generic ERC20/receipt-shaped mined-and-succeeded transaction receipt — every write path
 *  test in this file that needs one uses this same shape (only `to` varies meaningfully). */
function successReceipt(to: Address, blockNumber: string) {
  return {
    status: "0x1",
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber,
    transactionIndex: "0x0",
    from: BUYER_ACCOUNT,
    to,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    logs: [],
    logsBloom: "0x" + "00".repeat(256),
    type: "0x2",
  };
}

/** A `CapturingRpc` whose transport throws on any call — every test that expects a refusal to
 *  happen before this flow ever touches the network uses this, so a regression that let the
 *  flow reach the RPC layer fails loudly instead of silently mocking its way past the bug. */
function unreachableRpc(): CapturingRpc {
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
    const proven = proofRpcResult(body.method, body.params);
    if (proven === undefined) throw new Error("client-flows.test.ts: unexpected network call in a hermetic test");
    const text = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: proven.result });
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
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
    const handler = handlers[body.method] ?? ((params: readonly unknown[]) => proofRpcResult(body.method, params) ?? (() => {
      throw new Error(`mock rpc: unexpected method ${body.method}`);
    })());
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
    rail: createEvmCounterRail({ config, rpc: opts?.buyerRpc ?? unreachableRpc(), account: BUYER_ACCOUNT, clock }),
    clock,
  });
  const sellerFlow = new SellerFlow({
    identity: seller,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config, rpc: opts?.sellerRpc ?? unreachableRpc(), account: SELLER_ACCOUNT, clock }),
    clock,
  });
  return { buyer, seller, venue, clockRef, clock, buyerFlow, sellerFlow };
}

async function bidAndAcceptA(
  h: Harness,
  nonceHex: string,
  legB: { claimByMs: number; refundAfterMs: number; expiresMs: number } = legBDeadlines(T0),
): Promise<{
  swapId: string;
  offerA: OfferFrame;
  acceptA: AcceptFrame;
  acceptARecord: TranscriptRecord;
  offerB: OfferFrame;
  offerBRecord: TranscriptRecord;
}> {
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
  const { acceptA, acceptARecord, offerB, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legB, T0);
  return { swapId, offerA, acceptA, acceptARecord, offerB, offerBRecord };
}

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both account lines — the
 *  full happy prefix, reused by tests that need to reach `lockLegA`. */
async function pairLockBAndAccountLines(h: Harness, nonceHex: string) {
  const { swapId, offerA, acceptA, acceptARecord, offerB, offerBRecord } = await bidAndAcceptA(h, nonceHex);
  const { acceptB, acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
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
    const { offerBRecord, acceptARecord } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
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
    const { offerBRecord, acceptA } = await bidAndAcceptA(h, "00000001");
    const forged = unsignedRecord(OFFER_ROOM, 999, T0, encodeFrame(acceptA));
    await expect(h.buyerFlow.acceptLegB(offerBRecord, forged, T0)).rejects.toThrow(/leg A accept record does not authenticate/);
  });

  it("refuses a leg A accept record whose signer differs from the frame's own claimed sender", async () => {
    const h = harness(24, 25);
    const attacker = ident(26);
    const { offerBRecord, acceptA } = await bidAndAcceptA(h, "00000001");
    const forged = record(OFFER_ROOM, 999, T0, attacker, encodeFrame(acceptA));
    await expect(h.buyerFlow.acceptLegB(offerBRecord, forged, T0)).rejects.toThrow(/not an authenticated accept frame/);
  });

  it("refuses a leg A accept that is not from the Seller who posted leg B's offer", async () => {
    const h = harness(27, 28);
    const impostor = ident(29);
    const { offerA, offerBRecord } = await bidAndAcceptA(h, "00000001");
    // A properly authenticated accept for leg A — just not from the DID that actually posted
    // offerB.
    const impostorAccept = makeAccept(offerA, { from: impostor.did, statement: generateHashLock().hash });
    const impostorRecord = await h.venue.post(OFFER_ROOM, encodeFrame(impostorAccept), impostor);
    await expect(h.buyerFlow.acceptLegB(offerBRecord, impostorRecord, T0)).rejects.toThrow(
      /not from the Seller who posted leg B's offer/,
    );
  });

  it("refuses an unsafe deadline pair even with a fully genuine leg A accept", async () => {
    const h = harness(30, 31);
    const { offerBRecord, acceptARecord } = await bidAndAcceptA(h, "00000001");
    // lockTimeMs so late that rule 1 (the Seller's real reveal window) is violated.
    const unsafeLockTimeMs = legADeadlines(T0).refundAfterMs - 60_000;
    await expect(h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, unsafeLockTimeMs)).rejects.toThrow(/unsafe deadlines/);
  });
});

describe("BuyerFlow.acceptLegB — C4 (leg-A accept fully bound)", () => {
  it("refuses a leg A accept whose contract id does not match tclk's own derivation for that offer/accept pair", async () => {
    const h = harness(60, 61);
    const { offerA, offerBRecord } = await bidAndAcceptA(h, "00000001");
    // A genuinely signed accept for leg A — the same statement the Seller actually minted, from
    // the Seller's own identity, referencing this flow's own leg A offer — but a fresh call to
    // `makeAccept` mints its own fresh nonce, so its `contract` is well-formed on its own terms;
    // tampering it afterwards is what this test needs to isolate the C4 check.
    const acceptA = makeAccept(offerA, { from: h.seller.did, statement: h.sellerFlow.statement! });
    const frame = tryDecodeFrame(encodeFrame(acceptA));
    if (frame === null || frame.type !== "accept") throw new Error("test setup: expected an accept frame");
    const tampered = { ...frame, contract: `0x${"cd".repeat(32)}` };
    const tamperedRecord = await h.venue.post(OFFER_ROOM, encodeFrame(tampered), h.seller);
    await expect(h.buyerFlow.acceptLegB(offerBRecord, tamperedRecord, T0)).rejects.toThrow(
      /leg A accept's contract id does not match/,
    );
  });
});

describe("BuyerFlow.acceptLegB / lockLegA — C2 (paid what it asked for)", () => {
  it("refuses a leg B offer whose amount does not match what leg A's own bid asked for (a Seller offering 1 FLOP against a 52,070,000 FLOP want)", async () => {
    const h = harness(62, 63);
    const { offerB, acceptARecord } = await bidAndAcceptA(h, "00000001");
    // A leg B offer that is otherwise completely well-formed (same swap, same leg-A reference,
    // right asset, right rails) except that it pays far less than leg A's own bid declared
    // wanting. Built fresh with `makeOffer` (not a spread of the real `offerB`) since `amount`
    // is part of what the frame's own `id` commits to — a spread-and-override would fail
    // `encodeFrame`'s own "offer id mismatch" check before this test ever reaches acceptLegB.
    const stingyOfferB = makeOffer({
      from: offerB.from,
      role: offerB.role,
      amount: "1",
      asset: offerB.asset,
      lock: offerB.lock,
      rails: offerB.rails,
      claimByMs: offerB.claimByMs,
      refundAfterMs: offerB.refundAfterMs,
      expiresMs: offerB.expiresMs,
      job: offerB.job,
    });
    const stingyRecord = await h.venue.post(OFFER_ROOM, encodeFrame(stingyOfferB), h.seller);
    await expect(h.buyerFlow.acceptLegB(stingyRecord, acceptARecord, T0)).rejects.toThrow(
      /leg B pays amount 1, not the 52070000 leg A asked for/,
    );
  });

  it("lockLegA re-checks the same pairing at lock time, not only at accept time", async () => {
    const h = harness(64, 65);
    await pairLockBAndAccountLines(h, "00000001");
    // Field injection: this flow's own stored `offerB` no longer answers what its own `offerA`
    // asked for — isolates lockLegA's own re-check from acceptLegB's (already covered above).
    const tamperedOfferB: OfferFrame = { ...(h.buyerFlow as unknown as { offerB: OfferFrame }).offerB, amount: "1" };
    (h.buyerFlow as unknown as { offerB: OfferFrame }).offerB = tamperedOfferB;
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/leg B no longer matches what leg A asked for/);
  });
});

describe("BuyerFlow.lockLegA — refusals never touch the network", () => {
  it("refuses before leg B verifies", async () => {
    const h = harness(32, 33);
    const { offerBRecord, acceptARecord } = await bidAndAcceptA(h, "00000001");
    await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
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
    const { offerBRecord, acceptARecord } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    // Deliberately never call sellerFlow.postAccountLineA.
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/Seller's account line has not resolved/);
  });

  it("refuses to lock before the Buyer's own proven payer line is posted (P7 fix pass F1)", async () => {
    const h = harness(44, 45);
    const { offerBRecord, acceptARecord } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
    // Deliberately never call buyerFlow.postAccountLineA.
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/own proven payer account line has not resolved/);
  });

  // P7: a line with no proof, or a proof for another DID, contract or account, is never resolved.
  it.each([
    ["an unproven line", (_contract: string, _did: string) => formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: SELLER_ACCOUNT })],
    ["a line proven for another contract", (_contract: string, did: string) => SELLER_SIGNER.line({ did, contract: `0x${"ab".repeat(32)}`, caip2: ANVIL_LOCAL_PIN.caip2 })],
    ["a line proven for another DID", (contract: string, _did: string) => SELLER_SIGNER.line({ did: `did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`, contract, caip2: ANVIL_LOCAL_PIN.caip2 })],
  ])("refuses to lock when the Seller's only line is %s (P7)", async (_label, makeLine) => {
    const h = harness(40, 41);
    const { offerBRecord, acceptARecord, acceptA } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    await h.venue.post(dealRoom(acceptA.contract), makeLine(acceptA.contract, h.seller.did), h.seller);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/Seller's account line has not resolved/);
  });

  it("the flows post proven lines: each line carries an eip191 proof that verifies for its sender, this leg's contract and its own account, and resolves", async () => {
    const h = harness(42, 43);
    const { acceptA } = await pairLockBAndAccountLines(h, "00000001");
    const records = await h.venue.read(dealRoom(acceptA.contract));
    const lines = records.map((r) => ({ sender: r.sender, parsed: parseAccountLine(r.line) }));
    expect(lines).toHaveLength(2);
    for (const { parsed } of lines) expect(parsed?.proof?.scheme).toBe("eip191");
    const resolved = resolveAccounts(records, {
      contract: acceptA.contract,
      payerDid: h.buyer.did,
      payeeDid: h.seller.did,
      rail: "evm-htlc",
      caip2: ANVIL_LOCAL_PIN.caip2,
      proof: { mode: "required" },
    });
    expect(resolved.payee).toBe(SELLER_ACCOUNT.toLowerCase());
    expect(resolved.payer).toBe(BUYER_ACCOUNT.toLowerCase());
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

describe("SellerFlow.claimLegA — C3 (chain time that cannot freeze)", () => {
  it("refuses at/after claimByMs once wall-clock has passed it, even though the chain's own last block has not", async () => {
    const rpc = mockRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      // The chain is stalled: its last mined block is comfortably before claimByMs (T0 + 60min).
      eth_getBlockByNumber: () => ({ result: { timestamp: numberToHex(Math.floor((T0 + 10 * 60_000) / 1000)) } }),
    });
    const h = harness(66, 67, { sellerRpc: rpc });
    await bidAndAcceptA(h, "00000001");
    // Wall-clock has moved on past claimByMs even though the chain itself is stalled at T0+10min
    // — before C3 this guard read chain time alone and would have missed it.
    h.clockRef.ms = legADeadlines(T0).claimByMs + 1_000;
    await expect(h.sellerFlow.claimLegA(h.sellerFlow.statement!)).rejects.toThrow(/at\/after its claimByMs \(chain time\)/);
  });

  it("refuses when less than the claim-inclusion margin remains by wall-clock, even though the chain's own last block shows plenty", async () => {
    // A tight 2-minute claimByMs..refundAfterMs gap (below the 5-minute margin) so there is a
    // chainNow window — [refundAfterMs - margin, claimByMs) — where the margin guard is
    // reachable at all without first tripping the claimByMs guard (see the B2 test above: with
    // a gap at or above the margin, the two guards can never disagree, since a chain time still
    // short of claimByMs would leave more than the margin's worth of room by construction).
    const claimByMs = T0 + 61 * 60_000;
    const refundAfterMs = T0 + 63 * 60_000; // 2-minute gap: below the 5-minute margin.
    const rpc = mockRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      // The chain's own last block is stalled 13 minutes before refundAfterMs — comfortably
      // above the margin, and short of claimByMs too: chain time alone says this is entirely safe.
      eth_getBlockByNumber: () => ({ result: { timestamp: numberToHex(Math.floor((T0 + 50 * 60_000) / 1000)) } }),
    });
    const h = harness(68, 69, { sellerRpc: rpc });
    const { offerA } = await bidAndAcceptA(h, "00000001");
    const hashLock = generateHashLock();
    const acceptA = makeAccept(offerA, { from: h.seller.did, statement: hashLock.hash });
    const tamperedOfferA: OfferFrame = { ...offerA, claimByMs, refundAfterMs };
    Object.assign(h.sellerFlow as unknown as Record<string, unknown>, {
      offerA: tamperedOfferA,
      acceptA: { ...acceptA, ref: tamperedOfferA.id },
      hashLock,
    });
    // Wall-clock has moved to T0+59min: still short of claimByMs (T0+61min), but only 4 minutes
    // before refundAfterMs — below the 5-minute margin.
    h.clockRef.ms = T0 + 59 * 60_000;
    await expect(h.sellerFlow.claimLegA(hashLock.hash)).rejects.toThrow(/claim-inclusion margin.*remains before refundAfterMs/);
  });
});

describe("SellerFlow.lockLegB — C1 (one leg-B lock per swap)", () => {
  it("refuses a second lock for the same swap, even from a second, independently genuine accept", async () => {
    const h = harness(70, 71);
    const { offerB, acceptARecord, offerBRecord } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord: firstAcceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
    await h.sellerFlow.lockLegB(firstAcceptBRecord);

    // A second, independently genuine accept for the same leg B offer — a fresh nonce, so a
    // different tclk contract id from the first. Before C1, `lockLegB` had no guard against
    // this at all and would have locked a second time under this second contract.
    const secondAccept = makeAccept(offerB, { from: h.buyer.did, statement: h.sellerFlow.statement! });
    const secondRecord = await h.venue.post(OFFER_ROOM, encodeFrame(secondAccept), h.buyer);
    await expect(h.sellerFlow.lockLegB(secondRecord)).rejects.toThrow(/already locked, or a lock is already in flight/);
  });

  it("refuses a concurrent second lock attempt while the first is still in flight", async () => {
    const h = harness(72, 73);
    const { offerB, acceptARecord, offerBRecord } = await bidAndAcceptA(h, "00000001");
    const { acceptBRecord: firstRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
    const secondAccept = makeAccept(offerB, { from: h.buyer.did, statement: h.sellerFlow.statement! });
    const secondRecord = await h.venue.post(OFFER_ROOM, encodeFrame(secondAccept), h.buyer);

    // Both calls issued back to back, neither awaited first: the in-flight flag (set
    // synchronously, before either call's own first `await`) must still let only one through.
    const [firstResult, secondResult] = await Promise.allSettled([
      h.sellerFlow.lockLegB(firstRecord),
      h.sellerFlow.lockLegB(secondRecord),
    ]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult.status).toBe("rejected");
    if (secondResult.status === "rejected") {
      expect(String(secondResult.reason)).toMatch(/already locked, or a lock is already in flight/);
    }
  });
});

/** A second, independent SellerFlow sharing the same venue and offer — used to build a genuine,
 *  independently-signed second `(acceptA, offerB)` pair for the SAME leg A offer (its own fresh
 *  CSPRNG hash statement, per `SellerFlow.acceptLegA`), the E1 tests' "second genuine acceptA
 *  under a new hash" probe. Its own paper rail is never exercised in these tests. */
function secondSellerFlow(h: Harness, tag: number): SellerFlow {
  return new SellerFlow({
    identity: ident(tag),
    venue: h.venue,
    paperRail: new PaperRail(new MemoryNoteStore(), h.clock),
    rail: createEvmCounterRail({
      config: evmConfig(),
      rpc: unreachableRpc(),
      account: addr(`client-flows-seller2-account-${tag}`),
      clock: h.clock,
    }),
    clock: h.clock,
  });
}

describe("BuyerFlow.acceptLegB — E1 (pairs leg B once)", () => {
  it("refuses a second pairing for this flow, even from a second, independently genuine acceptA/offerB pair (a second genuine acceptA under a new hash)", async () => {
    const h = harness(74, 75);
    const { offerA, acceptARecord, offerBRecord } = await bidAndAcceptA(h, "00000001");
    await expect(h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0)).resolves.toBeDefined();

    // A second, independent Seller genuinely accepts the SAME leg A offer under its own fresh
    // CSPRNG hash statement (a "new hash") and its own signed acceptA/offerB pair. Before E1,
    // `acceptLegB` had no guard against re-pairing at all and would have overwritten this
    // flow's own `offerB`/`acceptA`/`acceptB` with the second pairing.
    const seller2Flow = secondSellerFlow(h, 76);
    const { acceptARecord: acceptARecord2, offerBRecord: offerBRecord2 } = await seller2Flow.acceptLegA(offerA, legBDeadlines(T0), T0);
    await expect(h.buyerFlow.acceptLegB(offerBRecord2, acceptARecord2, T0)).rejects.toThrow(
      /already paired, or a pairing is already in flight/,
    );
  });

  it("refuses a concurrent second pairing attempt while the first is still in flight", async () => {
    const h = harness(77, 78);
    const { offerA, acceptARecord, offerBRecord } = await bidAndAcceptA(h, "00000001");
    const seller2Flow = secondSellerFlow(h, 79);
    const { acceptARecord: acceptARecord2, offerBRecord: offerBRecord2 } = await seller2Flow.acceptLegA(offerA, legBDeadlines(T0), T0);

    const [firstResult, secondResult] = await Promise.allSettled([
      h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0),
      h.buyerFlow.acceptLegB(offerBRecord2, acceptARecord2, T0),
    ]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult.status).toBe("rejected");
    if (secondResult.status === "rejected") {
      expect(String(secondResult.reason)).toMatch(/already paired, or a pairing is already in flight/);
    }
  });
});

describe("BuyerFlow.lockLegA — E1 (re-verifies leg B immediately before spending)", () => {
  it("refuses when leg B no longer verifies on the paper rail, even though legBVerified was set true earlier", async () => {
    const h = harness(80, 81);
    await pairLockBAndAccountLines(h, "00000001");
    // Field injection: this flow's own stored `acceptB` now points at a contract nothing is
    // actually locked under — isolates the E1 re-check from `legBVerified`'s own (already-true)
    // flag, which a stale-flag bug would otherwise still trust at lock time.
    const staleAcceptB: AcceptFrame = {
      ...(h.buyerFlow as unknown as { acceptB: AcceptFrame }).acceptB,
      contract: `0x${"ab".repeat(32)}`,
    };
    (h.buyerFlow as unknown as { acceptB: AcceptFrame }).acceptB = staleAcceptB;
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/leg B no longer verifies on the paper rail \(E1\)/);
  });
});

describe("BuyerFlow.lockLegA — E3 (records its lock before sending it)", () => {
  it("a lock that succeeds on-chain but whose own evidence capture fails (eth_getLogs finds nothing) still lets refundLegA proceed", async () => {
    let getLogsCalls = 0;
    let capturedHashLock: Hex | undefined;
    const rpc = mockRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_blockNumber: () => ({ result: "0x5" }),
      eth_sendTransaction: () => ({ result: TX_HASH }),
      eth_getTransactionReceipt: () => ({ result: successReceipt(RAIL_CONTRACT, "0x6") }),
      eth_getLogs: () => {
        getLogsCalls += 1;
        if (getLogsCalls === 1) return { result: [] }; // the Locked-event lookup: an evidence-capture gap.
        if (capturedHashLock === undefined) throw new Error("test setup: hashLock not captured yet");
        return {
          result: [buildRefundedLog(capturedHashLock, { blockNumber: "0x9", blockHash: BLOCK_HASH, txHash: TX_HASH, logIndex: "0x0" })],
        };
      },
      // G7: `refundLegA` now checks the evidence reader itself before ever reporting success —
      // `verifyLockFinal`'s own capture needs a finalized-tag block and a `locks()` read showing
      // Refunded (status 3) with every field matching this swap's own terms.
      eth_getBlockByNumber: (params) => {
        if (params[0] === "finalized") return { result: { number: "0x6", hash: BLOCK_HASH } };
        throw new Error(`test setup: unexpected eth_getBlockByNumber(${String(params[0])})`);
      },
      eth_call: () => ({
        result: encodeFunctionResult({
          abi: EVM_HASH_RAIL_ABI,
          functionName: "locks",
          result: [
            BUYER_ACCOUNT,
            SELLER_ACCOUNT,
            TOKEN,
            1_000_000n,
            BigInt(legADeadlines(T0).claimByMs),
            BigInt(legADeadlines(T0).refundAfterMs),
            3, // Refunded
          ],
        }),
      }),
    });
    const h = harness(82, 83, { buyerRpc: rpc });
    await pairLockBAndAccountLines(h, "00000001");
    capturedHashLock = h.sellerFlow.statement! as Hex;

    // The on-chain write itself succeeds (approve + lock both mine with status success), but
    // `rail.lock`'s own bounded `eth_getLogs` finds zero matching `Locked` logs and throws —
    // before E3, this left the Buyer's own state believing leg A was never locked at all.
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/expected exactly one Locked log/);

    // E3: despite the throw, this flow's own state must already know leg A is locked — refund
    // must work off the chain (which it now can, via a genuine on-chain Refunded log), not off
    // whether `lockLegA` itself ever returned successfully. G7: refundLegA also confirms the
    // refund (via the mocked `locks()` read above showing Refunded) before ever reporting it.
    h.clockRef.ms = legADeadlines(T0).refundAfterMs;
    await expect(h.buyerFlow.refundLegA()).resolves.toBeDefined();
  });
});

/** E2: wraps a real `MemoryNoteStore` so its writes genuinely commit, but the first `set()`
 *  call throws right after committing — simulating a `NoteStore` whose write landed but whose
 *  ack never came back (a crash, a dropped response), the exact gap `lockLegB`'s own latch
 *  (`attemptedAcceptB`) must survive. */
class CommitsThenThrowsOnceStore implements NoteStore {
  private thrown = false;
  constructor(private readonly inner: NoteStore) {}

  async get(ns: string, key: string): Promise<string | null> {
    return this.inner.get(ns, key);
  }

  async set(ns: string, key: string, value: string, condition?: { ifAbsent: true } | { if: string }): Promise<boolean> {
    const result = await this.inner.set(ns, key, value, condition);
    if (!this.thrown) {
      this.thrown = true;
      throw new Error("client-flows.test.ts: simulated NoteStore ack failure after a real commit (E2)");
    }
    return result;
  }
}

describe("SellerFlow.lockLegB / reconcileLegB — E2 (leg-B latch never reopens)", () => {
  it("a NoteStore that commits then throws leaves the latch set; a second genuine accept is refused; reconcileLegB finds the real lock", async () => {
    const buyer = ident(84);
    const seller = ident(85);
    const clockRef = { ms: T0 };
    const clock = () => clockRef.ms;
    const venue = new MemoryVenue(clock);
    const flakyStore = new CommitsThenThrowsOnceStore(new MemoryNoteStore());
    const config = evmConfig();
    const buyerFlow = new BuyerFlow({
      identity: buyer,
      venue,
      paperRail: new PaperRail(new MemoryNoteStore(), clock),
      rail: createEvmCounterRail({ config, rpc: unreachableRpc(), account: BUYER_ACCOUNT, clock }),
      clock,
    });
    const sellerFlow = new SellerFlow({
      identity: seller,
      venue,
      paperRail: new PaperRail(flakyStore, clock),
      rail: createEvmCounterRail({ config, rpc: unreachableRpc(), account: SELLER_ACCOUNT, clock }),
      clock,
    });
    void buyerFlow;

    const swapId = computeSwapId(buyer.did, "00000001");
    const offerA = await buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      ...legADeadlines(T0),
    });
    const { offerB } = await sellerFlow.acceptLegA(offerA, legBDeadlines(T0), T0);
    const acceptB = makeAccept(offerB, { from: buyer.did, statement: sellerFlow.statement! });
    const acceptBRecord = await venue.post(OFFER_ROOM, encodeFrame(acceptB), buyer);

    // The first attempt's own `paperRail.lock` call commits (the underlying store now genuinely
    // has the note) but then throws (the simulated ack failure) — `lockLegB` must surface that
    // failure, never silently succeed.
    await expect(sellerFlow.lockLegB(acceptBRecord)).rejects.toThrow(/simulated NoteStore ack failure/);

    // E2: a second, independently genuine accept for the same leg B offer must still be refused
    // outright — the latch is permanent the moment any lock was attempted, whether or not this
    // flow itself knows the attempt succeeded.
    const secondAccept = makeAccept(offerB, { from: buyer.did, statement: sellerFlow.statement! });
    const secondRecord = await venue.post(OFFER_ROOM, encodeFrame(secondAccept), buyer);
    await expect(sellerFlow.lockLegB(secondRecord)).rejects.toThrow(/already locked, or a lock is already in flight/);

    // `reconcileLegB()` is the only way forward: it reads the paper rail directly (for the
    // *first* attempt's own contract, never the second) and finds that the write actually landed.
    await expect(sellerFlow.reconcileLegB()).resolves.toEqual({ locked: true });

    // Now that reconciliation confirms it, refundLegB (which needs `lockedLegBContract`) works.
    clockRef.ms = legBDeadlines(T0).refundAfterMs;
    await expect(sellerFlow.refundLegB()).resolves.toBeDefined();
  });

  it("reconcileLegB throws when nothing was ever attempted", async () => {
    const h = harness(86, 87);
    await bidAndAcceptA(h, "00000001");
    await expect(h.sellerFlow.reconcileLegB()).rejects.toThrow(/leg B lock was never attempted/);
  });
});

describe("SellerFlow.claimLegA — E4 (re-checks chain time again after verifyLockFinal)", () => {
  it("refuses to claim when a slow verifyLockFinal (the reviewer's 29-minute locks() read) eats the safety margin, and never broadcasts", async () => {
    // A tight leg-A window so a 29-minute delay inside verifyLockFinal clearly breaches
    // claimByMs — legA.refundAfterMs must still clear EVM_LOCAL_POLICY.minRevealWindowMs (45
    // min) measured from lockTimeMs (T0) for acceptLegA's own deadline check to pass.
    const claimByMs = T0 + 20 * 60_000;
    const refundAfterMs = T0 + 50 * 60_000;

    // This flow's own injected `clock()` never itself advances a single tick in this test —
    // "latest" answering differently on its second call (below) is what simulates 29 real
    // minutes having passed *inside* `verifyLockFinal`'s own round trip, exactly the way a real
    // process's `Date.now()` would have moved on even though nothing here fakes that directly.
    let latestCalls = 0;
    const locksResultBytes = encodeFunctionResult({
      abi: EVM_HASH_RAIL_ABI,
      functionName: "locks",
      result: [BUYER_ACCOUNT, SELLER_ACCOUNT, TOKEN, 1_000_000n, BigInt(claimByMs), BigInt(refundAfterMs), 1],
    });
    const locksSelector = encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [`0x${"0".repeat(64)}`] }).slice(0, 10);
    const rpc = mockRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_blockNumber: () => ({ result: "0x5" }),
      eth_getBlockByNumber: (params) => {
        if (params[0] === "finalized") return { result: { number: "0x5", hash: BLOCK_HASH } };
        if (params[0] === "pending") {
          // P22-P24-EVM-FIXES-R3.md E4: `EvmHtlcRail.claim`'s OWN last-moment guard reads this —
          // kept safely early throughout. That guard has its own dedicated, isolated test in
          // tests/evm-htlc.test.ts ("claim() never broadcasts when pending chain time is
          // at/after the given notAfterMs"); keeping it safe here isolates *this* test to
          // `SellerFlow.claimLegA`'s own re-check, the thing this test is actually about.
          return { result: { timestamp: numberToHex(Math.floor(T0 / 1000)) } };
        }
        // "latest": read once before `verifyLockFinal` (safe), and once more after it returns
        // (E4's own re-check) — the second reading is what a slow `verifyLockFinal` would have
        // let drift forward in reality.
        latestCalls += 1;
        const ms = latestCalls === 1 ? T0 : T0 + 29 * 60_000;
        return { result: { timestamp: numberToHex(Math.floor(ms / 1000)) } };
      },
      // If execution ever reaches `rail.claim()` at all (i.e. without the E4 fix), both E5
      // pre-checks are set up to pass here — a real, matching, Locked lock, and a payout that
      // simulates cleanly — so this test proves the claim would otherwise have gone on toward a
      // real broadcast (no eth_sendTransaction handler exists below, so it would fail loudly
      // with "unexpected method" instead of silently passing).
      eth_call: (params) => {
        const [callObject] = params as [{ to?: string; data?: string }];
        const to = (callObject.to ?? "").toLowerCase();
        if (to === TOKEN.toLowerCase()) return { result: `0x${"0".repeat(63)}1` }; // ERC20 transfer simulate: succeed.
        const data = (callObject.data ?? "").toLowerCase();
        if (data.startsWith(locksSelector)) return { result: locksResultBytes };
        // The rail contract, not a locks() read: the E5(a) zero-preimage claim() simulate.
        return { error: { code: 3, message: "execution reverted: EvmHashRail: secret does not open the statement" } };
      },
      // No eth_sendTransaction handler: if this ever reached a real broadcast, the mock would
      // throw "unexpected method" instead of failing with the assertion below.
    });
    const h = harness(88, 89, { sellerRpc: rpc });

    const swapId = computeSwapId(h.buyer.did, "00000001");
    const offerA = await h.buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      claimByMs,
      refundAfterMs,
      expiresMs: T0 + 10 * 60_000,
    });
    const { acceptARecord, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(T0), T0);
    // Both proven lines are required for `verifyLockFinal` to resolve (P7 fix pass F1), so the
    // Buyer pairs leg B and posts its own payer line too.
    await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, T0);
    await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
    await h.buyerFlow.postAccountLineA(BUYER_ACCOUNT);

    await expect(h.sellerFlow.claimLegA(h.sellerFlow.statement!)).rejects.toThrow(
      /at\/after its claimByMs \(chain time, re-checked after verifyLockFinal\) \(E4\)/,
    );
  });
});
