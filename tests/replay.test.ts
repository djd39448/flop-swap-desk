// SPDX-License-Identifier: MIT
//
// foldCaptured / findSwapLegCandidates (src/replay.ts): the shared "assemble → evidence →
// buildBoard" step, exercised directly (not through the watcher's own fetch machinery) so
// it is provably usable standalone — exactly how examples/audit-export.mjs uses it.

import {
  OFFER_ROOM,
  dealRoom,
  encodeFrame,
  encodePaperRecord,
  generateHashLock,
  makeAccept,
  makeOffer,
  type LockFrame,
  type RevealFrame,
} from "@flop-labs/tclk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { findSwapLegCandidates, foldCaptured } from "../src/replay.js";
import { formatAccountLine } from "../src/rails/account-line.js";
import type { EvmCapture, EvmCaptureIndex } from "../src/rails/evm-evidence.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";
import { identity, record } from "./helpers/identity.js";

const T0 = 1_758_000_000_000;
const MIN = 60_000;

const buyer = identity("d4".repeat(32));
const seller = identity("e5".repeat(32));

function buildPaperSwap() {
  const swapId = makeSwapId(buyer.did, "f001f001f001f001");
  const lock = generateHashLock();

  const legAOffer = makeOffer({
    from: buyer.did,
    role: "payer",
    amount: "1000",
    asset: "USDC",
    lock: "hash",
    rails: ["paper"],
    claimByMs: T0 + 45 * MIN,
    refundAfterMs: T0 + 60 * MIN,
    expiresMs: T0 + 30 * MIN,
    job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash });

  const legBOffer = makeOffer({
    from: seller.did,
    role: "payer",
    amount: "52070000",
    asset: "FLOP",
    lock: "hash",
    rails: ["flop-htlc", "paper"],
    claimByMs: T0 + 70 * MIN,
    refundAfterMs: T0 + 180 * MIN,
    expiresMs: T0 + 40 * MIN,
    job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash });

  const offers = [
    record(OFFER_ROOM, 1, T0, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, 2, T0 + 1 * MIN, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(legBAccept)),
  ];

  const dealRoomB = dealRoom(legBAccept.contract);
  const lockB: LockFrame = { type: "lock", from: seller.did, contract: legBAccept.contract, rail: "paper", ref: legBAccept.contract };
  const revealB: RevealFrame = { type: "reveal", from: buyer.did, contract: legBAccept.contract, ref: legBAccept.contract, secret: lock.preimage };
  const dealRoomsB = [
    record(dealRoomB, 1, T0 + 4 * MIN, seller, encodeFrame(lockB)),
    record(dealRoomB, 2, T0 + 5 * MIN, buyer, encodeFrame(revealB)),
  ];

  return { swapId, lock, legAOffer, legAAccept, legBOffer, legBAccept, offers, dealRoomB, dealRoomsB };
}

describe("findSwapLegCandidates", () => {
  it("finds both legs' contracts, carrying swapId/leg/offer/accept", () => {
    const s = buildPaperSwap();
    const { candidates, swapLegOffers } = findSwapLegCandidates(s.offers);
    expect(swapLegOffers).toBe(2);
    expect(candidates.map((c) => c.contract).sort()).toEqual(
      [s.legAAccept.contract, s.legBAccept.contract].sort(),
    );
    const legB = candidates.find((c) => c.contract === s.legBAccept.contract)!;
    expect(legB.leg).toBe("b");
    expect(legB.swapId).toBe(s.swapId);
    expect(legB.offer.refundAfterMs).toBe(s.legBOffer.refundAfterMs);
    expect(legB.accept.statement).toBe(s.legBAccept.statement);
  });
});

describe("foldCaptured", () => {
  it("folds a captured paper note into evidence and settles/advances accordingly", async () => {
    const s = buildPaperSwap();
    const noteValue = encodePaperRecord({
      status: "locked",
      lock: "hash",
      statement: s.lock.hash,
      refundAfterMs: s.legBOffer.refundAfterMs,
    });
    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomB, s.dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteValue}\n`, endpoint: "kv:test" }]]),
      nowMs: T0 + 6 * MIN,
    });
    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.b?.rail).toBe("paper");
    expect(view!.evidence.b?.railVerified).toBe(true);
    expect(view!.evidence.bRail?.status).toBe("locked");
    expect(view!.reasons).toContain("paper rail: rehearsal only, no value");
  });

  it("a candidate with a paper lock but no captured note gets no evidence for that leg", async () => {
    const s = buildPaperSwap();
    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomB, s.dealRoomsB]]),
      notes: new Map(), // nothing captured — mirrors a 404 or an uncaptured replay
      nowMs: T0 + 6 * MIN,
    });
    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.b).toBeUndefined();
    expect(view!.evidence.bRail).toBeUndefined();
  });
});

// P22-P24-EVM-SPEC.md §5: the evm-htlc branch of foldCaptured's dispatch — leg A on the
// evm-htlc rail (leg B stays on paper, already covered above), captured with synthetic
// ABI-encoded `locks()` responses built the same way tests/evm-evidence.test.ts builds them.
describe("foldCaptured — evm-htlc leg (P22-P24-EVM-SPEC.md §5)", () => {
  function sha256Hex(text: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(text)));
  }
  function jsonRpcResult(id: number, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }
  function addr(tag: string): Address {
    const hex = Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40);
    return `0x${hex}` as Address;
  }

  const enum Status {
    None = 0,
    Locked = 1,
    Claimed = 2,
    Refunded = 3,
  }

  const RAIL_CONTRACT = addr("evm-rail-contract");
  const TOKEN = addr("usdc-token");
  const BUYER_ADDR = addr("buyer-evm-addr");
  const SELLER_ADDR = addr("seller-evm-addr");
  const BLOCK_HASH = ("0x" + "cd".repeat(32)) as Hex;

  const EVM_CONFIG: EvmRailConfig = {
    pin: ANVIL_LOCAL_PIN,
    endpoint: "http://127.0.0.1:9999",
    contract: RAIL_CONTRACT,
    assets: { USDC: TOKEN },
  };

  function encodeLocksResult(args: {
    payer?: Address;
    payee?: Address;
    token?: Address;
    amount?: bigint;
    claimByMs?: bigint;
    refundAfterMs?: bigint;
    status: number;
  }): Hex {
    return encodeFunctionResult({
      abi: EVM_HASH_RAIL_ABI,
      functionName: "locks",
      result: [
        args.payer ?? BUYER_ADDR,
        args.payee ?? SELLER_ADDR,
        args.token ?? TOKEN,
        args.amount ?? 1000n,
        args.claimByMs ?? BigInt(T0 + 45 * MIN),
        args.refundAfterMs ?? BigInt(T0 + 60 * MIN),
        args.status,
      ],
    });
  }

  interface ExchangeSpec { method: string; params: unknown; body: string }

  function buildCapture(hashLock: string, exchanges: ExchangeSpec[]): EvmCapture {
    const bySha = new Map<string, Uint8Array>();
    const indexExchanges = exchanges.map((spec, i) => {
      const sha = sha256Hex(spec.body);
      bySha.set(sha, new TextEncoder().encode(spec.body));
      return {
        method: spec.method,
        params: spec.params,
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: spec.method, params: spec.params }),
        responseSha256: sha,
        atMs: T0,
      };
    });
    const index: EvmCaptureIndex = {
      v: 1,
      rail: "evm-htlc",
      chainId: ANVIL_LOCAL_PIN.chainId,
      caip2: ANVIL_LOCAL_PIN.caip2,
      pin: ANVIL_LOCAL_PIN.name,
      endpoint: EVM_CONFIG.endpoint,
      contract: EVM_CONFIG.contract,
      hashLock,
      checkedAtMs: T0,
      finality: { mode: "tag", tag: "finalized" },
      config: EVM_CONFIG,
      exchanges: indexExchanges,
    };
    return { index, bytes: bySha };
  }

  /** The standard chainId/finalized-block/eth_call sequence, all synthetic. `chainId`
   *  overrides what the (also synthetic) `eth_chainId` RPC response itself reports — this is
   *  what `evmEvidence` actually decodes against the pin, never the capture index's own
   *  `chainId` metadata field. */
  function standardExchanges(hashLock: Hex, callResult: Hex, chainId = ANVIL_LOCAL_PIN.chainId): ExchangeSpec[] {
    return [
      { method: "eth_chainId", params: [], body: jsonRpcResult(1, `0x${chainId.toString(16)}`) },
      {
        method: "eth_getBlockByNumber",
        params: ["finalized", false],
        body: jsonRpcResult(2, { number: "0x5", hash: BLOCK_HASH }),
      },
      {
        method: "eth_call",
        params: [
          { to: EVM_CONFIG.contract, data: encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [hashLock] }) },
          { blockHash: BLOCK_HASH },
        ],
        body: jsonRpcResult(3, callResult),
      },
    ];
  }

  /** Leg A on evm-htlc, leg B on paper (mirrors buildPaperSwap above) — the deal-room account
   *  lines (D-08) and lock/reveal frames are left to each test, since the whole point of this
   *  block is dispatching on exactly those. */
  function buildMixedSwapBase(nonce: string) {
    const swapId = makeSwapId(buyer.did, nonce);
    const lock = generateHashLock();

    const legAOffer = makeOffer({
      from: buyer.did,
      role: "payer",
      amount: "1000",
      asset: "USDC",
      lock: "hash",
      rails: ["evm-htlc"],
      claimByMs: T0 + 45 * MIN,
      refundAfterMs: T0 + 60 * MIN,
      expiresMs: T0 + 30 * MIN,
      job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
    });
    const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash });

    const legBOffer = makeOffer({
      from: seller.did,
      role: "payer",
      amount: "52070000",
      asset: "FLOP",
      lock: "hash",
      rails: ["flop-htlc", "paper"],
      claimByMs: T0 + 70 * MIN,
      refundAfterMs: T0 + 180 * MIN,
      expiresMs: T0 + 40 * MIN,
      job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
    });
    const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash });

    const offers = [
      record(OFFER_ROOM, 1, T0, buyer, encodeFrame(legAOffer)),
      record(OFFER_ROOM, 2, T0 + 1 * MIN, seller, encodeFrame(legAAccept)),
      record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(legBOffer)),
      record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(legBAccept)),
    ];

    return {
      swapId,
      lock,
      legAOffer,
      legAAccept,
      legBOffer,
      legBAccept,
      offers,
      dealRoomA: dealRoom(legAAccept.contract),
      dealRoomB: dealRoom(legBAccept.contract),
      legATerms: offerAcceptLockTerms(legAOffer, legAAccept),
      legBTerms: offerAcceptLockTerms(legBOffer, legBAccept),
    };
  }

  /** Leg A's account lines (D-08): the payee (seller) posts, required; the payer (buyer)
   *  posts too in most tests, as corroboration. */
  function accountLineRecords(dealRoomA: string, seq: number, ts: number) {
    const sellerLine = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: SELLER_ADDR });
    const buyerLine = formatAccountLine({ railId: "evm-htlc", caip2: ANVIL_LOCAL_PIN.caip2, address: BUYER_ADDR });
    return [
      record(dealRoomA, seq, ts, seller, sellerLine),
      record(dealRoomA, seq + 1, ts + 1, buyer, buyerLine),
    ];
  }

  it("a-locked: both legs locked, leg A's lock evidence comes from a captured EVM read", async () => {
    const s = buildMixedSwapBase("f001f001f001f001");
    const lockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(lockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
    ];
    const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

    const noteBValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legBOffer.refundAfterMs });
    const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Locked })));

    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }]]),
      chain: new Map([[s.lock.hash, capture]]),
      rails: { evm: EVM_CONFIG },
      nowMs: T0 + 6 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.a?.rail).toBe("evm-htlc");
    expect(view!.evidence.a?.railVerified).toBe(true);
    expect(view!.evidence.aRail).toEqual({ status: "locked", final: true, checkedAtMs: T0, finalizedRef: `anvil-local:finalized:5:${BLOCK_HASH}` });
    expect(view!.status).toBe("a-locked");
  });

  it("settled: both legs reveal, and both rails report a final claim", async () => {
    const s = buildMixedSwapBase("f002f002f002f002");
    const lockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const revealA: RevealFrame = { type: "reveal", from: seller.did, contract: s.legAAccept.contract, ref: s.lock.hash, secret: s.lock.preimage };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const revealB: RevealFrame = { type: "reveal", from: buyer.did, contract: s.legBAccept.contract, ref: s.legBAccept.contract, secret: s.lock.preimage };

    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(lockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
      record(s.dealRoomA, 4, T0 + 5 * MIN, seller, encodeFrame(revealA)),
    ];
    const dealRoomsB = [
      record(s.dealRoomB, 1, T0 + 5.5 * MIN, seller, encodeFrame(lockB)),
      record(s.dealRoomB, 2, T0 + 6 * MIN, buyer, encodeFrame(revealB)),
    ];

    const noteBValue = encodePaperRecord({
      status: "claimed",
      lock: "hash",
      statement: s.lock.hash,
      refundAfterMs: s.legBOffer.refundAfterMs,
      secret: s.lock.preimage,
    });
    const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Claimed })));

    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }]]),
      chain: new Map([[s.lock.hash, capture]]),
      rails: { evm: EVM_CONFIG },
      nowMs: T0 + 7 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.aRail?.status).toBe("claimed");
    expect(view!.evidence.aRail?.final).toBe(true);
    expect(view!.evidence.bRail?.status).toBe("claimed");
    expect(view!.status).toBe("settled");
  });

  it("refunded-a: a captured Refunded state settles leg A even with no refund frame posted", async () => {
    const s = buildMixedSwapBase("f003f003f003f003");
    const lockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(lockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
    ];
    const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

    const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Refunded })));

    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map(), // leg B's note was never captured: irrelevant to this leg-A case
      chain: new Map([[s.lock.hash, capture]]),
      rails: { evm: EVM_CONFIG },
      nowMs: T0 + 6 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.aRail).toEqual({ status: "refunded", final: true, checkedAtMs: T0, finalizedRef: `anvil-local:finalized:5:${BLOCK_HASH}` });
    expect(view!.status).toBe("refunded-a");
  });

  it("a tampered capture (the eth_call response no longer hashes to its own name) leaves leg A unverified, not thrown", async () => {
    const s = buildMixedSwapBase("f004f004f004f004");
    const lockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(lockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
    ];
    const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

    const noteBValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legBOffer.refundAfterMs });
    const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Locked })));
    const tamperedCapture: EvmCapture = { index: capture.index, bytes: new Map() }; // every read now "missing"

    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }]]),
      chain: new Map([[s.lock.hash, tamperedCapture]]),
      rails: { evm: EVM_CONFIG },
      nowMs: T0 + 6 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.a?.railVerified).toBeNull();
    expect(view!.evidence.a?.reason).toMatch(/missing\/tampered capture/);
    expect(view!.status).toBe("b-locked"); // leg B corroborated, leg A is not
    expect(view!.reasons).toContain("leg A lock unverified");
  });

  it("a capture from the wrong chain id leaves leg A unverified", async () => {
    const s = buildMixedSwapBase("f005f005f005f005");
    const lockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(lockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
    ];
    const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

    const noteBValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legBOffer.refundAfterMs });
    // The RPC itself reports Base Sepolia's chain id, but rails.evm below still pins anvil-local.
    const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Locked }), 84532));

    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }]]),
      chain: new Map([[s.lock.hash, capture]]),
      rails: { evm: EVM_CONFIG },
      nowMs: T0 + 6 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.a?.railVerified).toBeNull();
    expect(view!.evidence.a?.reason).toMatch(/does not match pin/);
    expect(view!.status).toBe("b-locked");
  });

  it("a lock frame signed by anyone other than the leg's own payer is ignored entirely", async () => {
    const s = buildMixedSwapBase("f006f006f006f006");
    // Signed by the seller (leg A's payee, not its payer) — verifyTranscriptRecord accepts
    // it fine, but findAuthenticatedLock must not treat it as leg A's lock.
    const forgedLockA: LockFrame = { type: "lock", from: seller.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, seller, encodeFrame(forgedLockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
    ];
    const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

    const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Locked })));

    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map(),
      chain: new Map([[s.lock.hash, capture]]),
      rails: { evm: EVM_CONFIG },
      nowMs: T0 + 6 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.a).toBeUndefined();
    expect(view!.evidence.aRail).toBeUndefined();
  });

  it("no rails configured: an evm-htlc lock plus a captured chain read still yield no evidence (identical to before this option existed)", async () => {
    const s = buildMixedSwapBase("f007f007f007f007");
    const lockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(lockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
    ];
    const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

    const noteBValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legBOffer.refundAfterMs });
    const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Locked })));

    // No `rails` field at all — same as every call in this file before §5 existed.
    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }]]),
      chain: new Map([[s.lock.hash, capture]]), // present, but must be ignored without rails.evm
      nowMs: T0 + 6 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.a).toBeUndefined();
    expect(view!.evidence.aRail).toBeUndefined();
    // Leg B's paper path is completely unaffected by leg A's ignored evm-htlc lock.
    expect(view!.evidence.b?.railVerified).toBe(true);
    expect(view!.status).toBe("b-locked");
  });

  // P22-P24-EVM-FIXES.md A6 (deliberate behaviour change): foldCaptured dispatches on the lock
  // rail/ref the tclk contract machine actually *accepted* (`foldAcceptedLock`), never merely
  // the first authenticated-looking lock frame in room order (`findAuthenticatedLock`, this
  // file's own comment above still documents why a forged-sender frame is ignored — that part
  // is unchanged; these two pin the *new* ground the fix covers).
  describe("A6: dispatch on the tclk-accepted lock, not the first authenticated frame", () => {
    it("a rejected paper frame (rail never offered for this leg) followed by an accepted evm-htlc frame yields no paper evidence, only evm-htlc", async () => {
      const s = buildMixedSwapBase("a001a001a001a001"); // legA offers only ["evm-htlc"] (buildMixedSwapBase)
      const rejectedPaperLockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "paper", ref: s.legAAccept.contract };
      const acceptedEvmLockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
      const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
      const dealRoomsA = [
        record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(rejectedPaperLockA)),
        record(s.dealRoomA, 2, T0 + 4.2 * MIN, buyer, encodeFrame(acceptedEvmLockA)),
        ...accountLineRecords(s.dealRoomA, 3, T0 + 4.5 * MIN),
      ];
      const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

      // A paper note IS captured for leg A's own contract too — the old first-authenticated-
      // frame dispatch would have matched `rejectedPaperLockA.ref === candidate.contract` and
      // reported (bogus) paper evidence from it instead of ever reaching the evm-htlc branch.
      const noteAValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legAOffer.refundAfterMs });
      const noteBValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legBOffer.refundAfterMs });
      const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Locked })));

      const board = foldCaptured({
        offers: s.offers,
        dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
        notes: new Map([
          [s.legAAccept.contract, { body: `!! rehearsal\n\n${noteAValue}\n`, endpoint: "kv:test" }],
          [s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }],
        ]),
        chain: new Map([[s.lock.hash, capture]]),
        rails: { evm: EVM_CONFIG },
        nowMs: T0 + 6 * MIN,
      });

      const view = board.swaps.find((sw) => sw.swapId === s.swapId);
      expect(view).toBeDefined();
      expect(view!.evidence.a?.rail).toBe("evm-htlc");
      expect(view!.evidence.a?.railVerified).toBe(true);
      expect(view!.status).toBe("a-locked");
    });

    it("a payer's earlier malformed frame (posted after the refund window had already opened) does not shadow the later accepted lock", async () => {
      const s = buildMixedSwapBase("a002a002a002a002");
      const wrongRef = "0x" + "88".repeat(32);
      // tclk's machine rejects this one on its own timestamp ("refund window is already
      // open") regardless of its contract/sender/rail otherwise checking out —
      // findAuthenticatedLock has no notion of a deadline at all, so the old dispatch would
      // have picked this up as "the" lock frame for leg A (and, since its ref does not equal
      // terms.statement, reported no evm-htlc evidence for leg A at all — never even reaching
      // the frame the payer actually meant).
      const malformedLockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: wrongRef };
      const acceptedLockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
      const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
      const dealRoomsA = [
        record(s.dealRoomA, 1, T0 + 65 * MIN /* after legAOffer.refundAfterMs (60 min) */, buyer, encodeFrame(malformedLockA)),
        record(s.dealRoomA, 2, T0 + 4 * MIN, buyer, encodeFrame(acceptedLockA)),
        ...accountLineRecords(s.dealRoomA, 3, T0 + 4.5 * MIN),
      ];
      const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

      const noteBValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legBOffer.refundAfterMs });
      const capture = buildCapture(s.lock.hash, standardExchanges(s.lock.hash as Hex, encodeLocksResult({ status: Status.Locked })));

      const board = foldCaptured({
        offers: s.offers,
        dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
        notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }]]),
        chain: new Map([[s.lock.hash, capture]]),
        rails: { evm: EVM_CONFIG },
        nowMs: T0 + 6 * MIN,
      });

      const view = board.swaps.find((sw) => sw.swapId === s.swapId);
      expect(view).toBeDefined();
      expect(view!.evidence.a?.rail).toBe("evm-htlc");
      expect(view!.evidence.a?.ref).toBe(s.lock.hash);
      expect(view!.evidence.a?.railVerified).toBe(true);
      expect(view!.status).toBe("a-locked");
    });
  });

  // P22-P24-EVM-FIXES.md A3: foldCaptured itself refuses to reach the decoder with a malformed
  // `rails.evm` — every evm-htlc leg fails closed with the specific reason, distinguishable
  // from "not captured yet" (an absent `evidence.a` entirely).
  it("A3: a malformed rails.evm config fails every evm-htlc leg closed with a specific reason, never reaching evmEvidence", async () => {
    const s = buildMixedSwapBase("a003a003a003a003");
    const lockA: LockFrame = { type: "lock", from: buyer.did, contract: s.legAAccept.contract, rail: "evm-htlc", ref: s.lock.hash };
    const lockB: LockFrame = { type: "lock", from: seller.did, contract: s.legBAccept.contract, rail: "paper", ref: s.legBAccept.contract };
    const dealRoomsA = [
      record(s.dealRoomA, 1, T0 + 4 * MIN, buyer, encodeFrame(lockA)),
      ...accountLineRecords(s.dealRoomA, 2, T0 + 4.5 * MIN),
    ];
    const dealRoomsB = [record(s.dealRoomB, 1, T0 + 5 * MIN, seller, encodeFrame(lockB))];

    const noteBValue = encodePaperRecord({ status: "locked", lock: "hash", statement: s.lock.hash, refundAfterMs: s.legBOffer.refundAfterMs });
    // A config with a chain id off the A3 allow list — never even reaches `evmEvidence`.
    const badConfig = { ...EVM_CONFIG, pin: { ...EVM_CONFIG.pin, chainId: 8453, caip2: "eip155:8453" } };

    const board = foldCaptured({
      offers: s.offers,
      dealRooms: new Map([[s.dealRoomA, dealRoomsA], [s.dealRoomB, dealRoomsB]]),
      notes: new Map([[s.legBAccept.contract, { body: `!! rehearsal\n\n${noteBValue}\n`, endpoint: "kv:test" }]]),
      chain: new Map(), // deliberately empty: if the bad config were ever ignored this would
      // also read "not captured", so the assertion below on `.reason` is what actually pins A3.
      rails: { evm: badConfig },
      nowMs: T0 + 6 * MIN,
    });

    const view = board.swaps.find((sw) => sw.swapId === s.swapId);
    expect(view).toBeDefined();
    expect(view!.evidence.a?.railVerified).toBeNull();
    expect(view!.evidence.a?.reason).toMatch(/rail config invalid.*not on the allow list/);
  });
});
