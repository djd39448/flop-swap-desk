// SPDX-License-Identifier: MIT
//
// The five worlds of the P8 crash matrix (tests/resume-*.test.ts). Each builds ONE swap's surroundings, fresh: a shared venue, note
// store, clock and chain, a flow store per role, and the options of each role's flow with every outward channel wrapped so the
// `Controller` can cut the process (tests/helpers/crash-matrix.ts). The flows and the counter-asset rails are the REAL ones; only the
// wire is fake:
//
//   evm      the real EVM rail + viem over the stateful mock node (approve, lock, claim, refund are the node's own sends)
//   sol      the real Solana rail over the stateful Solana node
//   near     the real NEAR rail over the stateful NEAR RPC simulator (the one tests/client-flows-near-rpc.test.ts uses)
//   btc      a stateful fake at the rail seam with Bitcoin's recovery semantics (tests/helpers/ledger-rail.ts)
//   nearfake the same fake with NEAR's (a provable never-landed), which the real NEAR rail never gives a lock that was not sent

import { base58 } from "@scure/base";
import { MemoryNoteStore, PaperRail, generateHashLock } from "@flop-labs/tclk";
import { getAddress, type Address } from "viem";

import { LockPendingError, type BidParams } from "../../src/client/buyer.js";
import { createEvmCounterRail } from "../../src/client/evm-rail.js";
import { decodeFlowRecord } from "../../src/client/flow-record.js";
import { MemoryFlowStore, flowKey } from "../../src/client/flow-store.js";
import { createNearCounterRail } from "../../src/client/near-rail.js";
import { MemoryVenue } from "../../src/client/venue.js";
import { swapId as computeSwapId } from "../../src/profile.js";
import { InMemoryNearSigner } from "../../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../../src/rails/rpc-capture.js";
import {
  Controller,
  wrapAdapterRail,
  wrapPaper,
  wrapVenue,
  type ChainCounts,
  type Role,
  type World,
  type WorldFactory,
} from "./crash-matrix.js";
import { EvmMockNode } from "./evm-mock-node.js";
import { identity, type Identity } from "./identity.js";
import { LEDGER_BTC_ADDRESS, LEDGER_NEAR_ADDRESS, LedgerChain, createLedgerRail, type LedgerFlavour, type LedgerHooks } from "./ledger-rail.js";
import { BUYER_ACCOUNT, SELLER_ACCOUNT, StatefulNearRpc, CONTRACT, HTLC_CODE_HASH, USDC, fetchFor, nearConfig } from "./near-stateful-rpc.js";
import { evmSigner } from "./proven-lines.js";
import { BID, T0, legADeadlines, legBDeadlines, solHarness } from "./sol-flow-harness.js";

const ident = (tag: number): Identity => identity(tag.toString(16).padStart(2, "0").repeat(32));
/** The 32-byte seed `ident(tag)` derives its DID key from. */
const seedOfTag = (tag: number): Uint8Array => Uint8Array.from(Buffer.from(tag.toString(16).padStart(2, "0").repeat(32), "hex"));
/** The private key tests/helpers/proven-lines.ts's `evmSigner(tag)` derives (a throwaway test value). */
function evmKeySeed(tag: number): Uint8Array {
  const bytes = new Uint8Array(32).fill(1);
  bytes[0] = tag & 0xff;
  bytes[1] = (tag >> 8) & 0xff;
  return bytes;
}

/** The deadlines every world but the EVM one uses: leg A's window is 6 h, leg B's 24 h (all inside every rail's policy). */
const SIX_HOURS = 6 * 60 * 60_000;

interface Common {
  ctl: Controller;
  clockRef: { ms: number };
  venue: MemoryVenue;
  noteStore: MemoryNoteStore;
  stores: Record<Role, MemoryFlowStore>;
}

function common(ctl: Controller, clockRef: { ms: number }, venue: MemoryVenue, noteStore: MemoryNoteStore): Common {
  return { ctl, clockRef, venue, noteStore, stores: { buyer: new MemoryFlowStore(), seller: new MemoryFlowStore() } };
}

// --- evm ----------------------------------------------------------------------------------------------------------------

function evmAddress(tag: string): Address {
  return getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
}

export const evmWorld: WorldFactory = (ctl): World => {
  const buyerKey = evmSigner(0x411);
  const sellerKey = evmSigner(0x412);
  const legA = { claimByMs: T0 + 60 * 60_000, refundAfterMs: T0 + 90 * 60_000, expiresMs: T0 + 30 * 60_000 };
  const legB = { claimByMs: T0 + 120 * 60_000, refundAfterMs: T0 + 180 * 60_000, expiresMs: T0 + 40 * 60_000 };
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const node = new EvmMockNode(clock, evmAddress("matrix-evm-rail"), evmAddress("matrix-evm-usdc"), [buyerKey, sellerKey]);
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const base = common(ctl, clockRef, venue, noteStore);
  const dids = { buyer: ident(0x21).did, seller: ident(0x22).did };
  const hashLock = generateHashLock();
  const roleOf = (from: Address): Role => (from.toLowerCase() === buyerKey.address.toLowerCase() ? "buyer" : "seller");
  // The chain's sends are the actions; they are cut inside the node, so the approve/lock pair of a lock is two boundaries.
  node.hook = {
    begin: (fn, from) => ctl.begin(roleOf(from), ctl.epochOf(roleOf(from)), "chain", `chain:${fn}`),
    end: (token) => ctl.end(token as Parameters<Controller["end"]>[0]),
  };
  const options = (role: Role) => {
    const epoch = ctl.epochOf(role);
    const key = role === "buyer" ? buyerKey : sellerKey;
    return {
      identity: role === "buyer" ? ident(0x21) : ident(0x22),
      venue: wrapVenue(venue, ctl, role, epoch),
      paperRail: wrapPaper(new PaperRail(noteStore, clock), ctl, role, epoch),
      rail: createEvmCounterRail({ config: node.config(), rpc: node.rpc(), account: key.address, clock }),
      clock,
      store: base.stores[role],
    };
  };
  return {
    name: "evm",
    ...base,
    setTime: (ms) => {
      clockRef.ms = ms;
    },
    paper: new PaperRail(noteStore, clock),
    dids,
    swapId: computeSwapId(dids.buyer, "00000001"),
    bidParams: { swapId: computeSwapId(dids.buyer, "00000001"), wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legA },
    legB,
    lockTimeMs: T0,
    addresses: { buyer: buyerKey.address, seller: sellerKey.address },
    hashLock,
    keySeeds: [seedOfTag(0x21), seedOfTag(0x22), evmKeySeed(0x411), evmKeySeed(0x412)],
    refundAt: { legA: legA.refundAfterMs, legB: legB.refundAfterMs },
    buyerOptions: () => ({ ...options("buyer") }),
    sellerOptions: () => ({ ...options("seller"), mintHashLock: () => hashLock }),
    counts: (): ChainCounts => ({ locks: node.count("lock"), claims: node.count("claim"), refunds: node.count("refund"), refundBuilds: node.count("refund") }),
    settlePending: async () => false, // the EVM rail answers a missing row as never-landed; it is never pending
  };
};

// --- sol ----------------------------------------------------------------------------------------------------------------

export const solWorld: WorldFactory = (ctl): World => {
  const buyerStore = new MemoryFlowStore();
  const sellerStore = new MemoryFlowStore();
  const h = solHarness({ buyerStore, sellerStore });
  const legA = legADeadlines(SIX_HOURS);
  const swapId = computeSwapId(h.buyer.did, "00000001");
  const wrap = (role: Role) => {
    const epoch = ctl.epochOf(role);
    const raw = role === "buyer" ? h.buyerOptions : h.sellerOptions;
    return {
      ...raw,
      venue: wrapVenue(h.venue, ctl, role, epoch),
      paperRail: wrapPaper(raw.paperRail, ctl, role, epoch),
      rail: wrapAdapterRail(raw.rail, ctl, role, epoch),
    };
  };
  return {
    name: "sol",
    ctl,
    clockRef: h.clockRef,
    setTime: h.setTime,
    venue: h.venue,
    noteStore: h.noteStore,
    paper: new PaperRail(h.noteStore, h.clock),
    stores: { buyer: buyerStore, seller: sellerStore },
    dids: { buyer: h.buyer.did, seller: h.seller.did },
    swapId,
    bidParams: { swapId, ...BID, claimByMs: legA.claimByMs, refundAfterMs: legA.refundAfterMs, expiresMs: T0 + 10 * 60_000 },
    legB: legBDeadlines(),
    lockTimeMs: legA.lockTimeMs,
    addresses: { buyer: h.buyerWallet.publicKey, seller: h.sellerWallet.publicKey },
    hashLock: h.sellerLock,
    keySeeds: [seedOfTag(1), seedOfTag(2), new Uint8Array(32).fill(11), new Uint8Array(32).fill(12)],
    refundAt: { legA: legA.refundAfterMs, legB: legBDeadlines().refundAfterMs },
    buyerOptions: () => wrap("buyer"),
    sellerOptions: () => wrap("seller") as ReturnType<World["sellerOptions"]>,
    counts: (): ChainCounts => ({ locks: h.node.sent.lock, claims: h.node.sent.claim, refunds: h.node.sent.refund, refundBuilds: h.node.sent.refund }),
    settlePending: async (role, error) => {
      // A signed transaction whose blockhash is still valid is "pending". Let its blockhash expire on the chain with no status for the
      // old signature: from then on "never landed" is provable and a fresh transaction may be signed.
      const key = flowKey(role, swapId);
      const record = decodeFlowRecord((await (role === "buyer" ? buyerStore : sellerStore).load(key))!, key);
      let height: number | undefined;
      const message = error instanceof Error ? error.message : "";
      if (record.role === "buyer" && error instanceof LockPendingError) {
        const handle = record.lock.prepared?.recovery;
        if (handle?.chain === "sol") height = handle.lastValidBlockHeight;
      } else if (record.role === "buyer" && /not yet confirmed/.test(message)) {
        const handle = record.refund.recovery;
        if (handle?.chain === "sol") height = handle.lastValidBlockHeight;
      } else if (record.role === "seller" && error instanceof Error && error.name === "SolPendingError") {
        height = Math.max(0, ...record.claimRecords.map((entry) => entry.lastValidBlockHeight));
      }
      if (height === undefined) return false;
      h.node.chain.finalizedHeight = height + 1;
      h.node.chain.blockhash = base58.encode(new Uint8Array(32).fill(0x66));
      h.node.chain.lastValidBlockHeight = height + 400;
      return true;
    },
  };
};

// --- near (the real rail over the RPC simulator) --------------------------------------------------------------------------

export const nearWorld: WorldFactory = (ctl): World => {
  const node = new StatefulNearRpc(CONTRACT, USDC, HTLC_CODE_HASH, T0);
  const config = nearConfig();
  const clockRef = { ms: T0 };
  const clock = (): number => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  node.registerStorage(BUYER_ACCOUNT);
  node.registerStorage(SELLER_ACCOUNT);
  const buyerSigner = InMemoryNearSigner.generate(BUYER_ACCOUNT, new Uint8Array(32).fill(11));
  const sellerSigner = InMemoryNearSigner.generate(SELLER_ACCOUNT, new Uint8Array(32).fill(22));
  const base = common(ctl, clockRef, venue, noteStore);
  const dids = { buyer: ident(1).did, seller: ident(2).did };
  const hashLock = generateHashLock();
  const legA = legADeadlines(SIX_HOURS);
  const swapId = computeSwapId(dids.buyer, "00000001");
  const options = (role: Role) => {
    const epoch = ctl.epochOf(role);
    const rpc = new CapturingRpc({ endpoint: config.endpoint, fetch: fetchFor(node), clock: () => clockRef.ms });
    const rail = createNearCounterRail({ config, rpc, signer: role === "buyer" ? buyerSigner : sellerSigner, clock: () => node.nowMs });
    return {
      identity: role === "buyer" ? ident(1) : ident(2),
      venue: wrapVenue(venue, ctl, role, epoch),
      paperRail: wrapPaper(new PaperRail(noteStore, clock), ctl, role, epoch),
      rail: wrapAdapterRail(rail, ctl, role, epoch),
      clock,
      store: base.stores[role],
    };
  };
  return {
    name: "near",
    ...base,
    setTime: (ms) => {
      clockRef.ms = ms;
      node.nowMs = ms;
    },
    paper: new PaperRail(noteStore, clock),
    dids,
    swapId,
    bidParams: { swapId, ...BID, asset: "USDC", claimByMs: legA.claimByMs, refundAfterMs: legA.refundAfterMs, expiresMs: T0 + 10 * 60_000 },
    legB: legBDeadlines(),
    lockTimeMs: legA.lockTimeMs,
    addresses: { buyer: BUYER_ACCOUNT, seller: SELLER_ACCOUNT },
    hashLock,
    keySeeds: [seedOfTag(1), seedOfTag(2), new Uint8Array(32).fill(11), new Uint8Array(32).fill(22)],
    refundAt: { legA: legA.refundAfterMs, legB: legBDeadlines().refundAfterMs },
    buyerOptions: () => ({ ...options("buyer") }),
    sellerOptions: () => ({ ...options("seller"), mintHashLock: () => hashLock }),
    counts: (): ChainCounts => ({ locks: node.lockSendTxCalls, claims: node.claimSendTxCalls, refunds: node.refundSendTxCalls, refundBuilds: node.refundSendTxCalls }),
    // A NEAR lock that was signed and never sent stays pending for as long as nothing consumes the key's nonce (a liveness limit
    // of the rail's nonce proof, not a fund-safety one): the world has no honest way to decide it.
    settlePending: async () => false,
  };
};

// --- the ledger worlds (btc and nearfake) ---------------------------------------------------------------------------------

function ledgerWorld(flavour: LedgerFlavour): WorldFactory {
  return (ctl): World => {
    const clockRef = { ms: T0 };
    const clock = (): number => clockRef.ms;
    const chain = new LedgerChain(clock);
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const base = common(ctl, clockRef, venue, noteStore);
    const dids = { buyer: ident(1).did, seller: ident(2).did };
    const hashLock = generateHashLock();
    const legA = legADeadlines(SIX_HOURS);
    const swapId = computeSwapId(dids.buyer, "00000001");
    const addresses = flavour === "btc" ? { buyer: LEDGER_BTC_ADDRESS.buyer, seller: LEDGER_BTC_ADDRESS.seller } : { buyer: LEDGER_NEAR_ADDRESS.buyer, seller: LEDGER_NEAR_ADDRESS.seller };
    const hooksFor = (role: Role, epoch: number): LedgerHooks => ({
      act: (what, run) => ctl.action(role, epoch, "chain", `chain:${what}`, run),
      alive: () => ctl.assertAlive(role, epoch),
    });
    const options = (role: Role) => {
      const epoch = ctl.epochOf(role);
      return {
        identity: role === "buyer" ? ident(1) : ident(2),
        venue: wrapVenue(venue, ctl, role, epoch),
        paperRail: wrapPaper(new PaperRail(noteStore, clock), ctl, role, epoch),
        rail: createLedgerRail({ chain, flavour, address: addresses[role], hooks: hooksFor(role, epoch) }),
        clock,
        store: base.stores[role],
      };
    };
    return {
      name: flavour === "btc" ? "btc" : "nearfake",
      ...base,
      setTime: (ms) => {
        clockRef.ms = ms;
      },
      paper: new PaperRail(noteStore, clock),
      dids,
      swapId,
      bidParams: { swapId, ...BID, asset: flavour === "btc" ? "BTC" : "USDC", claimByMs: legA.claimByMs, refundAfterMs: legA.refundAfterMs, expiresMs: T0 + 10 * 60_000 },
      legB: legBDeadlines(),
      lockTimeMs: legA.lockTimeMs,
      addresses,
      hashLock,
      keySeeds: [seedOfTag(1), seedOfTag(2)],
      refundAt: { legA: legA.refundAfterMs, legB: legBDeadlines().refundAfterMs },
      buyerOptions: () => ({ ...options("buyer") }),
      sellerOptions: () => ({ ...options("seller"), mintHashLock: () => hashLock }),
      counts: (): ChainCounts => ({ locks: chain.counts.fundSent, claims: chain.counts.claimSent, refunds: chain.counts.refundSent, refundBuilds: chain.counts.refundBuilt }),
      // Bitcoin never builds a second refund (a signed one stays valid as long as its inputs are unspent); NEAR may build one fresh
      // refund once the rail proves the first can no longer land.
      maxRefundBuilds: flavour === "btc" ? 1 : 2,
      settlePending: async () => false,
    };
  };
}

export const btcWorld: WorldFactory = ledgerWorld("btc");
export const nearFakeWorld: WorldFactory = ledgerWorld("near");

export const WORLDS: Array<{ name: string; factory: WorldFactory }> = [
  { name: "evm", factory: evmWorld },
  { name: "sol", factory: solWorld },
  { name: "near", factory: nearWorld },
  { name: "btc", factory: btcWorld },
  { name: "nearfake", factory: nearFakeWorld },
];

export type { BidParams };
