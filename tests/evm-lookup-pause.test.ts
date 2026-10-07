// SPDX-License-Identifier: MIT
//
// tests/evm-lookup-pause.test.ts - P9-4 decision 10 (P2R2-PIN-07; P9-4-DECISIONS-2026-10-07.md): the write-evidence lookup pauses about one block between its
// re-plans.
//
// After a lock, claim or refund the rail looks the write's own log up (a bounded `eth_getLogs`). A load-balanced public endpoint can answer the receipt from one
// node and the logs from another that is a block behind; the lookup then re-plans (a fresh tip read, the whole range read again) at most EVM_WRITE_LOOKUP_REPLANS
// (3) times before it reports "found 0". Before this decision those four reads ran back to back against the same stale view, so a lag of ONE block (a moment)
// failed a write that had landed. Now each re-plan is preceded by a pause of the chain's block time (2 s on Base Sepolia, from the policy; the runner's poll interval
// or 1 s elsewhere), so the second read sees the block. The pause is injected (`sleep`) so a test makes it a block passing on the mock node, never a real wait.

import type { LockTerms } from "@flop-labs/tclk";
import { generateHashLock } from "@flop-labs/tclk";
import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { BASE_SEPOLIA_POLICY, EVM_LOCAL_POLICY } from "../src/client/policy.js";
import { EVM_WRITE_LOOKUP_REPLANS, EvmHtlcRail, MAX_LOOKUP_PAUSE_MS } from "../src/rails/evm-htlc.js";
import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmSigner } from "./helpers/proven-lines.js";

const T0 = 1_700_000_000_000;
const NOW = (): number => T0;

function addr(tag: string): Address {
  return getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
}

const RAIL_CONTRACT = addr("pause-rail");
const TOKEN = addr("pause-usdc");
const BUYER = evmSigner(0x531);
const SELLER = evmSigner(0x532);
const ADDRESS_BOOK: AddressBook = { resolve: (did) => (did === "did:key:zPayee" ? SELLER.address : BUYER.address) };

function termsFor(hashLock: string): LockTerms {
  return {
    contract: `0x${"11".repeat(32)}`,
    lock: "hash",
    statement: hashLock,
    amount: "1000000",
    asset: "USDC",
    payer: "did:key:zPayer",
    payee: "did:key:zPayee",
    claimByMs: T0 + 3_600_000,
    refundAfterMs: T0 + 5_400_000,
  };
}

function nodeOn(chainId: number): EvmMockNode {
  const node = new EvmMockNode(NOW, RAIL_CONTRACT, TOKEN, [BUYER, SELLER]);
  node.chainId = chainId;
  return node;
}

/** A recording pause that lets one block pass on `node` (a moment later the lagging log index has caught up). */
function blockPassing(node: EvmMockNode): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      node.advance(1n);
    },
  };
}

/** A recording pause that never lets the chain move: the stale view stays stale. */
function frozen(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

async function connectRail(node: EvmMockNode, lookupPauseMs: number | undefined, sleep: (ms: number) => Promise<void>): Promise<EvmHtlcRail> {
  return EvmHtlcRail.connect({
    config: node.config(),
    rpc: node.rpc(),
    account: BUYER.address,
    addressBook: ADDRESS_BOOK,
    clock: NOW,
    sleep,
    ...(lookupPauseMs === undefined ? {} : { lookupPauseMs }),
  });
}

describe("P9-4 decision 10: the write lookup pauses between its re-plans (the rail)", () => {
  it("logs that lag the head by one block: today's four immediate reads miss the landed lock; with a 2-second pause the second read finds it", async () => {
    // today: no pause, the view never changes between the four reads
    const stale = nodeOn(84532);
    const none = frozen();
    const without = await connectRail(stale, undefined, none.sleep);
    const staleLock = generateHashLock();
    await without.approve("USDC", "1000000");
    stale.logLagBlocks = 1;
    stale.logRanges.length = 0;
    await expect(without.lock(termsFor(staleLock.hash), 0)).rejects.toThrow(/expected exactly one Locked log .* found 0/);
    expect(stale.logRanges, "one read and three immediate re-plans").toHaveLength(1 + EVM_WRITE_LOOKUP_REPLANS);
    expect(none.sleeps).toEqual([]);
    expect(stale.count("lock"), "the lock landed once and is never sent again").toBe(1);

    // with the pause: a block passes before the second read
    const node = nodeOn(84532);
    const pause = blockPassing(node);
    const rail = await connectRail(node, 2_000, pause.sleep);
    const lock = generateHashLock();
    await rail.approve("USDC", "1000000");
    node.logLagBlocks = 1;
    node.logRanges.length = 0;
    const evidence = await rail.lock(termsFor(lock.hash), 0);
    expect(evidence.event).toBe("Locked");
    expect(pause.sleeps, "one pause, before the first re-plan, of the block time").toEqual([2_000]);
    expect(node.logRanges, "the first read missed, the second found").toHaveLength(2);
    expect(node.count("lock")).toBe(1);
  });

  it("a pause comes before EACH re-plan and never before the first read: three empty answers then a right one is three pauses, four reads", async () => {
    const node = nodeOn(84532);
    const pause = frozen();
    const rail = await connectRail(node, 2_000, pause.sleep);
    await rail.approve("USDC", "1000000");
    node.emptyLogQueries = EVM_WRITE_LOOKUP_REPLANS;
    node.logRanges.length = 0;
    expect((await rail.lock(termsFor(generateHashLock().hash), 0)).event).toBe("Locked");
    expect(pause.sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(node.logRanges).toHaveLength(4);
  });

  it("a lookup that finds its log at once never pauses (the common case costs nothing), and neither does one with no pause configured", async () => {
    const node = nodeOn(84532);
    const pause = frozen();
    const rail = await connectRail(node, 2_000, pause.sleep);
    await rail.approve("USDC", "1000000");
    await rail.lock(termsFor(generateHashLock().hash), 0);
    expect(pause.sleeps).toEqual([]);

    const quiet = nodeOn(84532);
    const quietPause = frozen();
    const quietRail = await connectRail(quiet, undefined, quietPause.sleep);
    await quietRail.approve("USDC", "1000000");
    quiet.emptyLogQueries = 1;
    await quietRail.lock(termsFor(generateHashLock().hash), 0);
    expect(quietPause.sleeps, "no lookupPauseMs: the re-plan is immediate, as before").toEqual([]);
  });

  it("the bound is unchanged: four empty answers still end in 'found 0' after exactly three pauses, and the write is never repeated", async () => {
    const node = nodeOn(84532);
    const pause = frozen();
    const rail = await connectRail(node, 2_000, pause.sleep);
    await rail.approve("USDC", "1000000");
    node.emptyLogQueries = EVM_WRITE_LOOKUP_REPLANS + 1;
    await expect(rail.lock(termsFor(generateHashLock().hash), 0)).rejects.toThrow(/expected exactly one Locked log .* found 0/);
    expect(pause.sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(node.count("lock")).toBe(1);
  });

  it("the pause also covers a claim and a refund lookup, not only a lock's", async () => {
    const node = nodeOn(84532);
    const pause = blockPassing(node);
    const buyer = await connectRail(node, 2_000, pause.sleep);
    const seller = await EvmHtlcRail.connect({ config: node.config(), rpc: node.rpc(), account: SELLER.address, addressBook: ADDRESS_BOOK, clock: NOW, lookupPauseMs: 2_000, sleep: pause.sleep });
    const lock = generateHashLock();
    await buyer.approve("USDC", "1000000");
    await buyer.lock(termsFor(lock.hash), 0);
    node.logLagBlocks = 1;
    const claim = await seller.claim(lock.hash as `0x${string}`, lock.preimage as `0x${string}`, T0 + 5_000_000);
    expect(claim.event).toBe("Claimed");
    expect(pause.sleeps).toEqual([2_000]);
  });

  it("lookupPauseMs must be an integer from 0 to a minute; anything else is refused at connect, before any request", async () => {
    expect(MAX_LOOKUP_PAUSE_MS).toBe(60_000);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_LOOKUP_PAUSE_MS + 1, "2000" as unknown as number]) {
      const node = nodeOn(84532);
      await expect(connectRail(node, bad, frozen().sleep), `value ${String(bad)}`).rejects.toThrow(/lookupPauseMs must be an integer from 0 to 60000/);
      expect(node.requests).toEqual([]);
    }
    const ok = nodeOn(84532);
    await connectRail(ok, 0, frozen().sleep);
    await connectRail(nodeOn(84532), MAX_LOOKUP_PAUSE_MS, frozen().sleep);
  });
});

describe("P9-4 decision 10: the counter rail passes the chain's block time (the policy), or the poll interval elsewhere", () => {
  /** Runs one lock through `createEvmCounterRail` over a node with a one-block log lag and reports the pauses it made. */
  async function pausesOf(chainId: number, pollMs: number | undefined): Promise<number[]> {
    const node = nodeOn(chainId);
    const pause = blockPassing(node);
    const rail = createEvmCounterRail({
      config: node.config(),
      rpc: node.rpc(),
      account: BUYER.address,
      clock: NOW,
      sleep: pause.sleep,
      ...(pollMs === undefined ? {} : { pollMs }),
    });
    const lock = generateHashLock();
    const terms = termsFor(lock.hash);
    const connected = await rail.connect(terms, { payee: SELLER.address });
    await connected.prepareLock(terms, 0);
    node.logLagBlocks = 1; // the log of the lock is a block behind the head for a moment
    await connected.commitLock();
    expect(node.count("lock")).toBe(1);
    return pause.sleeps;
  }

  it("Base Sepolia: 2,000 ms from the policy's blockTimeMs, whatever poll interval the runner has", async () => {
    expect(BASE_SEPOLIA_POLICY.blockTimeMs).toBe(2_000);
    expect(await pausesOf(84532, undefined)).toEqual([2_000]);
    expect(await pausesOf(84532, 750)).toEqual([2_000]);
    expect(await pausesOf(84532, 5_000)).toEqual([2_000]);
  });

  it("anvil: the runner's poll interval when it gives one, else the anvil policy's 1,000 ms block time", async () => {
    expect(EVM_LOCAL_POLICY.blockTimeMs).toBe(1_000);
    expect(await pausesOf(31337, 750)).toEqual([750]);
    expect(await pausesOf(31337, undefined)).toEqual([1_000]);
  });
});
