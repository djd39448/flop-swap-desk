// SPDX-License-Identifier: MIT
//
// tests/evm-log-scan.test.ts: P9-3 (rule 3, "every chain read stays bounded and works on the public endpoint"). The public Base Sepolia
// endpoint refuses `eth_getLogs` over more than 500 blocks. Every log scan this build makes (the write-evidence lookup and
// `findClaimedPreimage`) is therefore split into calls of at most `maxLogRange` blocks (default 500 on chain 84532, none on anvil),
// the preimage scan newest range first, with a hard bound of MAX_LOG_SCAN_CHUNKS calls and a typed error when it is hit.
// The stateful mock node refuses a range over its cap exactly as the public endpoint does (both ends counted), so a scan that is not
// chunked fails here the way it would there. The resumed Seller's claim scan has its own tests in tests/flow-resume-sell.test.ts.

import type { LockTerms } from "@flop-labs/tclk";
import { generateHashLock, verifyHashPreimage } from "@flop-labs/tclk";
import { encodeAbiParameters, encodeEventTopics, getAddress, numberToHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  ANVIL_LOCAL_PIN,
  BASE_SEPOLIA_MAX_LOG_RANGE,
  BASE_SEPOLIA_PIN,
  EvmHtlcRail,
  EvmLogScanBoundError,
  MAX_LOG_SCAN_CHUNKS,
  checkEvmRailConfig,
  effectiveMaxLogRange,
  type EvmRailConfig,
} from "../src/rails/evm-htlc.js";
import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmSigner } from "./helpers/proven-lines.js";
import { scriptedRpc } from "./helpers/scripted-rpc.js";

const T0 = 1_700_000_000_000;
const NOW = (): number => T0;
const CAP = 500n;

function addr(tag: string): Address {
  return getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
}

const RAIL_CONTRACT = addr("log-scan-rail");
const TOKEN = addr("log-scan-usdc");
const BUYER = evmSigner(0x521);
const SELLER = evmSigner(0x522);
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

/** The mock chain a public endpoint's 500-block cap is on: Base Sepolia (84532) unless `chainId` says otherwise. */
function capped(chainId = 84532): EvmMockNode {
  const node = new EvmMockNode(NOW, RAIL_CONTRACT, TOKEN, [BUYER, SELLER]);
  node.chainId = chainId;
  node.maxLogSpan = CAP;
  return node;
}

const connect = (node: EvmMockNode, who: typeof BUYER, config: EvmRailConfig = node.config()): Promise<EvmHtlcRail> =>
  EvmHtlcRail.connect({ config, rpc: node.rpc(), account: who.address, addressBook: ADDRESS_BOOK, clock: NOW });

/** `[from, tip]` as the newest-first partition into ranges of at most `size` blocks (both ends counted). */
function newestFirst(from: bigint, tip: bigint, size: bigint): Array<{ from: bigint; to: bigint }> {
  const out: Array<{ from: bigint; to: bigint }> = [];
  let hi = tip;
  while (hi >= from) {
    const lo = hi - size + 1n > from ? hi - size + 1n : from;
    out.push({ from: lo, to: hi });
    hi = lo - 1n;
  }
  return out;
}

/** A lock of the Buyer's and the Seller's claim of it, with the chain pushed to `claimAt` first (so the claim sits in the chosen range). */
async function lockedAndClaimed(node: EvmMockNode, claimAfterBlocks = 0n) {
  const lock = generateHashLock();
  const terms = termsFor(lock.hash);
  const buyer = await connect(node, BUYER);
  const seller = await connect(node, SELLER);
  const marker = node.blockNumber; // what a Buyer saves before its lock: the scan starts here
  await buyer.approve("USDC", terms.amount);
  await buyer.lock(terms, 0);
  node.blockNumber += claimAfterBlocks;
  const claim = await seller.claim(lock.hash as Hex, lock.preimage as Hex, terms.refundAfterMs);
  return { lock, terms, buyer, seller, marker, claimBlock: claim.blockNumber };
}

describe("P9-3 config: maxLogRange and its default per chain", () => {
  const base = { endpoint: "http://mock-evm", contract: RAIL_CONTRACT, assets: { USDC: TOKEN } };
  const sepolia = { ...base, pin: BASE_SEPOLIA_PIN, contractCodeHash: `0x${"ab".repeat(32)}` } as EvmRailConfig;
  const anvil = { ...base, pin: ANVIL_LOCAL_PIN } as EvmRailConfig;

  it("defaults to 500 on Base Sepolia and to no limit on anvil; an explicit value wins on either", () => {
    expect(BASE_SEPOLIA_MAX_LOG_RANGE).toBe(500);
    expect(effectiveMaxLogRange(sepolia)).toBe(500);
    expect(effectiveMaxLogRange(anvil)).toBeUndefined();
    expect(effectiveMaxLogRange({ ...sepolia, maxLogRange: 100 })).toBe(100);
    expect(effectiveMaxLogRange({ ...anvil, maxLogRange: 2000 })).toBe(2000);
  });

  it("the hard bound is 100 calls", () => {
    expect(MAX_LOG_SCAN_CHUNKS).toBe(100);
  });

  it.each([1, 7, 500, 10_000, 1_000_000])("a positive integer (%i) is accepted", (value) => {
    expect(checkEvmRailConfig({ ...sepolia, maxLogRange: value }).ok).toBe(true);
    expect(checkEvmRailConfig({ ...anvil, maxLogRange: value }).ok).toBe(true);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], ["500"], [null], [true]])("%j is refused as maxLogRange", (value) => {
    const check = checkEvmRailConfig({ ...anvil, maxLogRange: value });
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/maxLogRange must be a positive integer/);
  });
});

describe("P9-3 findClaimedPreimage: chunked, newest range first, on a 500-block endpoint", () => {
  it("a scan over 1,300 blocks (the claim in the oldest range) succeeds in three calls, newest first, none over 500 blocks, covering every block once", async () => {
    const node = capped();
    const { lock, seller, marker } = await lockedAndClaimed(node);
    node.blockNumber = marker + 1299n; // tip: [marker, tip] is exactly 1,300 blocks
    node.logRanges.length = 0;
    const found = await seller.findClaimedPreimage(lock.hash as Hex, marker);
    expect(found).toBe(lock.preimage);
    expect(node.logRanges.map(({ from, to }) => ({ from, to }))).toEqual(newestFirst(marker, node.blockNumber, CAP));
    expect(node.logRanges).toHaveLength(3);
    expect(node.logRanges.every((range) => !range.latest && range.to - range.from + 1n <= CAP)).toBe(true);
    expect(node.logRanges[0]?.to).toBe(node.blockNumber);
    expect(node.logRanges[2]?.from).toBe(marker);
  });

  it("the same scan with the claim in the newest range stops after one call (newest first)", async () => {
    const node = capped();
    const { lock, seller, marker } = await lockedAndClaimed(node, 1200n); // the claim is mined 1,200 blocks after the lock
    node.blockNumber = marker + 1299n;
    node.logRanges.length = 0;
    expect(await seller.findClaimedPreimage(lock.hash as Hex, marker)).toBe(lock.preimage);
    expect(node.logRanges).toHaveLength(1);
  });

  it("with the claim in the middle range it stops after two calls", async () => {
    const node = capped();
    const { lock, seller, marker } = await lockedAndClaimed(node, 600n);
    node.blockNumber = marker + 1299n;
    node.logRanges.length = 0;
    expect(await seller.findClaimedPreimage(lock.hash as Hex, marker)).toBe(lock.preimage);
    expect(node.logRanges).toHaveLength(2);
  });

  it("no claim at all reads the whole range in three calls and answers null (nothing is skipped)", async () => {
    const node = capped();
    const lock = generateHashLock();
    const seller = await connect(node, SELLER);
    node.blockNumber = 1304n;
    node.logRanges.length = 0;
    expect(await seller.findClaimedPreimage(lock.hash as Hex, 5n)).toBeNull();
    expect(node.logRanges.map(({ from, to }) => ({ from, to }))).toEqual(newestFirst(5n, 1304n, CAP));
    expect(node.logRanges).toHaveLength(3);
  });

  it("a range of exactly 500 blocks is one call, and 501 blocks are two", async () => {
    const node = capped();
    const lock = generateHashLock();
    const seller = await connect(node, SELLER);
    node.blockNumber = 504n; // [5, 504] = 500 blocks
    node.logRanges.length = 0;
    await seller.findClaimedPreimage(lock.hash as Hex, 5n);
    expect(node.logRanges).toHaveLength(1);
    node.blockNumber = 505n; // [5, 505] = 501 blocks
    node.logRanges.length = 0;
    await seller.findClaimedPreimage(lock.hash as Hex, 5n);
    expect(node.logRanges).toHaveLength(2);
  });

  it("reads the tip once (a fresh eth_blockNumber, never a cached one) and never asks for the latest tag", async () => {
    const node = capped();
    const lock = generateHashLock();
    const { rpc, calls } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(84532) }),
      eth_getCode: () => ({ result: node.contractCode }),
      eth_blockNumber: () => ({ result: numberToHex(1304n) }),
      eth_getLogs: () => ({ result: [] }),
    });
    const config = node.config();
    const seller = await EvmHtlcRail.connect({ config, rpc, account: SELLER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    calls.length = 0;
    expect(await seller.findClaimedPreimage(lock.hash as Hex, 5n)).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(["eth_blockNumber", "eth_getLogs", "eth_getLogs", "eth_getLogs"]);
    const filters = calls.filter((call) => call.method === "eth_getLogs").map((call) => (call.params[0] as { fromBlock: string; toBlock: string }));
    expect(filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([
      [numberToHex(805n), numberToHex(1304n)],
      [numberToHex(305n), numberToHex(804n)],
      [numberToHex(5n), numberToHex(304n)],
    ]);
  });

  it("a start above the tip reads nothing and answers null", async () => {
    const node = capped();
    const seller = await connect(node, SELLER);
    node.logRanges.length = 0;
    expect(await seller.findClaimedPreimage(generateHashLock().hash as Hex, node.blockNumber + 10n)).toBeNull();
    expect(node.logRanges).toEqual([]);
  });

  it("maxLogRange 1 reads one block per call, newest first", async () => {
    const node = capped();
    node.configExtras = { maxLogRange: 1 };
    const lock = generateHashLock();
    const seller = await connect(node, SELLER);
    node.blockNumber = 9n;
    node.logRanges.length = 0;
    await seller.findClaimedPreimage(lock.hash as Hex, 5n);
    expect(node.logRanges.map((range) => range.from)).toEqual([9n, 8n, 7n, 6n, 5n]);
  });

  it("anvil (no default limit) keeps the single call to latest: no eth_blockNumber read, one range, exactly as before", async () => {
    const node = capped(31337);
    node.maxLogSpan = undefined;
    const { rpc, calls } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(31337) }),
      eth_getLogs: () => ({ result: [] }),
    });
    const seller = await EvmHtlcRail.connect({ config: node.config(), rpc, account: SELLER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    calls.length = 0;
    expect(await seller.findClaimedPreimage(generateHashLock().hash as Hex, 5n)).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(["eth_getLogs"]);
    expect((calls[0]?.params[0] as { fromBlock: string; toBlock: string }).toBlock).toBe("latest");
  });

  it("on anvil without maxLogRange a capped endpoint refuses the single call (the cap is real in this mock)", async () => {
    const node = capped(31337);
    const lock = generateHashLock();
    const seller = await connect(node, SELLER);
    node.blockNumber = 1304n;
    await expect(seller.findClaimedPreimage(lock.hash as Hex, 5n)).rejects.toThrow(/block range limit/);
  });

  it("on anvil an explicit maxLogRange chunks the same way", async () => {
    const node = capped(31337);
    node.configExtras = { maxLogRange: 500 };
    const { lock, seller, marker } = await lockedAndClaimed(node);
    node.blockNumber = marker + 1299n;
    node.logRanges.length = 0;
    expect(await seller.findClaimedPreimage(lock.hash as Hex, marker)).toBe(lock.preimage);
    expect(node.logRanges).toHaveLength(3);
  });

  it("a Claimed log whose preimage does not open the statement is skipped and the scan goes on to the next range", async () => {
    const lock = generateHashLock();
    const bogus = claimedLog(lock.hash as Hex, `0x${"07".repeat(32)}` as Hex, 900n);
    const real = claimedLog(lock.hash as Hex, lock.preimage as Hex, 400n);
    expect(verifyHashPreimage(lock.hash, bogus.preimage)).toBe(false);
    let call = 0;
    const node = capped();
    const { rpc } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(84532) }),
      eth_getCode: () => ({ result: node.contractCode }),
      eth_blockNumber: () => ({ result: numberToHex(1304n) }),
      eth_getLogs: () => ({ result: [[bogus.raw], [real.raw], []][call++] ?? [] }),
    });
    const seller = await EvmHtlcRail.connect({ config: node.config(), rpc, account: SELLER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    expect(await seller.findClaimedPreimage(lock.hash as Hex, 5n)).toBe(lock.preimage);
    expect(call, "stopped at the second range, where the real one is").toBe(2);
  });

  it("only invalid preimages in every range read null, after all three ranges", async () => {
    const lock = generateHashLock();
    const bogus = claimedLog(lock.hash as Hex, `0x${"07".repeat(32)}` as Hex, 900n);
    let calls = 0;
    const node = capped();
    const { rpc } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(84532) }),
      eth_getCode: () => ({ result: node.contractCode }),
      eth_blockNumber: () => ({ result: numberToHex(1304n) }),
      eth_getLogs: () => ((calls += 1), { result: [bogus.raw] }),
    });
    const seller = await EvmHtlcRail.connect({ config: node.config(), rpc, account: SELLER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    expect(await seller.findClaimedPreimage(lock.hash as Hex, 5n)).toBeNull();
    expect(calls).toBe(3);
  });

  it("a malformed eth_blockNumber is an error, never an empty scan", async () => {
    const node = capped();
    const { rpc } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(84532) }),
      eth_getCode: () => ({ result: node.contractCode }),
      eth_blockNumber: () => ({ result: "soon" }),
    });
    const seller = await EvmHtlcRail.connect({ config: node.config(), rpc, account: SELLER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(seller.findClaimedPreimage(generateHashLock().hash as Hex, 5n)).rejects.toThrow(/eth_blockNumber/);
  });

  it("an endpoint error on any range is an error (a half-read scan never answers null)", async () => {
    const node = capped();
    let call = 0;
    const { rpc } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(84532) }),
      eth_getCode: () => ({ result: node.contractCode }),
      eth_blockNumber: () => ({ result: numberToHex(1304n) }),
      eth_getLogs: () => (++call === 2 ? { error: { code: -32005, message: "rate limited" } } : { result: [] }),
    });
    const seller = await EvmHtlcRail.connect({ config: node.config(), rpc, account: SELLER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(seller.findClaimedPreimage(generateHashLock().hash as Hex, 5n)).rejects.toThrow(/rate limited/);
  });
});

describe("P9-3 the hard bound: 100 calls, then a typed error, never a silent truncation", () => {
  it("a scan needing exactly 100 calls (50,000 blocks) is read in full and answers null", async () => {
    const node = capped();
    const seller = await connect(node, SELLER);
    node.blockNumber = 49_999n + 5n; // [5, 50004] = 50,000 blocks = 100 ranges
    node.logRanges.length = 0;
    expect(await seller.findClaimedPreimage(generateHashLock().hash as Hex, 5n)).toBeNull();
    expect(node.logRanges).toHaveLength(MAX_LOG_SCAN_CHUNKS);
  });

  it("a scan needing 101 calls (50,001 blocks) makes 100 calls and throws EvmLogScanBoundError naming what was not read", async () => {
    const node = capped();
    const seller = await connect(node, SELLER);
    node.blockNumber = 50_000n + 5n; // [5, 50005] = 50,001 blocks
    node.logRanges.length = 0;
    const error = (await seller.findClaimedPreimage(generateHashLock().hash as Hex, 5n).catch((caught: unknown) => caught)) as EvmLogScanBoundError;
    expect(error).toBeInstanceOf(EvmLogScanBoundError);
    expect(node.logRanges, "100 newest ranges were read before the error").toHaveLength(MAX_LOG_SCAN_CHUNKS);
    expect(error.fromBlock).toBe(5n);
    expect(error.toBlock).toBe(50_005n);
    expect(error.unreadFrom).toBe(5n);
    expect(error.unreadTo).toBe(5n); // one block (the oldest) was not read
    expect(error.maxLogRange).toBe(500);
    expect(error.chunkBound).toBe(MAX_LOG_SCAN_CHUNKS);
    expect(error.message).toMatch(/blocks 5 to 5 were not read, so the scan is incomplete/);
  });

  it("a far older start is the same error, with the unread part named", async () => {
    const node = capped();
    const seller = await connect(node, SELLER);
    node.blockNumber = 1_000_000n;
    const error = (await seller.findClaimedPreimage(generateHashLock().hash as Hex, 0n).catch((caught: unknown) => caught)) as EvmLogScanBoundError;
    expect(error).toBeInstanceOf(EvmLogScanBoundError);
    expect(error.unreadFrom).toBe(0n);
    expect(error.unreadTo).toBe(1_000_000n - 50_000n);
  });

  it("a preimage found inside the newest 100 ranges is returned even though older blocks lie beyond the bound", async () => {
    const node = capped();
    const { lock, seller, marker } = await lockedAndClaimed(node);
    node.blockNumber = 1_000_000n;
    // the claim (block ~8) is far below; move it into the newest range with the mock's own reorg model
    node.reorgLog("Claimed", lock.hash, 999_900n);
    node.logRanges.length = 0;
    expect(await seller.findClaimedPreimage(lock.hash as Hex, marker)).toBe(lock.preimage);
    expect(node.logRanges).toHaveLength(1);
  });

  it("a claim older than the bound is NOT reported as no claim: the typed error says the scan is incomplete", async () => {
    const node = capped();
    const { lock, seller, marker } = await lockedAndClaimed(node);
    node.blockNumber = 1_000_000n; // the claim (block ~8) is 999,000 blocks down
    await expect(seller.findClaimedPreimage(lock.hash as Hex, marker)).rejects.toBeInstanceOf(EvmLogScanBoundError);
  });
});

describe("P9-3 the write-evidence lookup: paged the same way, one log required across all pages", () => {
  /** After the lock send, the chain jumps `blocks` blocks (a long wait for the receipt on a slow public chain). */
  function jumpAfterLock(node: EvmMockNode, blocks: bigint): void {
    node.hook = {
      begin: (fn) => fn,
      end: (token) => {
        if (token === "lock") node.blockNumber += blocks;
      },
    };
  }

  it("a lookup spanning about 1,200 blocks is read in three calls and finds its one Locked log", async () => {
    const node = capped();
    jumpAfterLock(node, 1200n);
    const buyer = await connect(node, BUYER);
    const terms = termsFor(generateHashLock().hash);
    await buyer.approve("USDC", terms.amount);
    node.logRanges.length = 0;
    const evidence = await buyer.lock(terms, 0);
    expect(evidence.event).toBe("Locked");
    expect(node.logRanges).toHaveLength(3);
    expect(node.logRanges.every((range) => !range.latest && range.to - range.from + 1n <= CAP)).toBe(true);
    // oldest first is not required, but the ranges must tile [fromBlock, tip] exactly
    const sorted = [...node.logRanges].sort((a, b) => Number(a.from - b.from));
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]!.from).toBe(sorted[i - 1]!.to + 1n);
    expect(sorted.at(-1)?.to).toBe(node.blockNumber);
  });

  it("the same lookup on an uncapped-by-config anvil pin is refused by the capped endpoint (the cap is real)", async () => {
    const node = capped(31337);
    jumpAfterLock(node, 1200n);
    const buyer = await connect(node, BUYER);
    const terms = termsFor(generateHashLock().hash);
    await buyer.approve("USDC", terms.amount);
    await expect(buyer.lock(terms, 0)).rejects.toThrow(/block range limit/);
  });

  it("a lookup needing more than 100 calls throws EvmLogScanBoundError before reading anything", async () => {
    const node = capped();
    jumpAfterLock(node, 60_000n);
    const buyer = await connect(node, BUYER);
    const terms = termsFor(generateHashLock().hash);
    await buyer.approve("USDC", terms.amount);
    node.logRanges.length = 0;
    await expect(buyer.lock(terms, 0)).rejects.toBeInstanceOf(EvmLogScanBoundError);
    expect(node.logRanges, "no partial read: the answer could not be complete").toEqual([]);
    expect(node.count("lock"), "the lock itself landed (the lookup is evidence, not the write)").toBe(1);
  });

  it("two matching logs across different pages are refused as several (never the first one found)", async () => {
    const node = capped();
    const lock = generateHashLock();
    const terms = termsFor(lock.hash);
    const log = lockedLog(lock.hash as Hex, 7n);
    let tipReads = 0;
    const { rpc } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(84532) }),
      eth_getCode: () => ({ result: node.contractCode }),
      // the block read before the write (the scan's start), then the tip 1,299 blocks later: three ranges
      eth_blockNumber: () => ({ result: numberToHex(++tipReads === 1 ? 5n : 1304n) }),
      eth_sendTransaction: () => ({ result: `0x${"01".repeat(32)}` }),
      eth_getTransactionReceipt: () => ({
        result: { status: "0x1", transactionHash: `0x${"01".repeat(32)}`, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x7", transactionIndex: "0x0", from: BUYER.address, to: RAIL_CONTRACT, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2" },
      }),
      eth_getLogs: () => ({ result: [log] }), // every page answers the same event
    });
    const buyer = await EvmHtlcRail.connect({ config: node.config(), rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(buyer.lock(terms, 0)).rejects.toThrow(/expected exactly one Locked log .* found 3/);
  });

  it("no matching log on any page is refused as none", async () => {
    const node = capped();
    const lock = generateHashLock();
    const terms = termsFor(lock.hash);
    let tipReads = 0;
    const { rpc } = scriptedRpc({
      eth_chainId: () => ({ result: numberToHex(84532) }),
      eth_getCode: () => ({ result: node.contractCode }),
      eth_blockNumber: () => ({ result: numberToHex(++tipReads === 1 ? 5n : 1304n) }),
      eth_sendTransaction: () => ({ result: `0x${"01".repeat(32)}` }),
      eth_getTransactionReceipt: () => ({
        result: { status: "0x1", transactionHash: `0x${"01".repeat(32)}`, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x7", transactionIndex: "0x0", from: BUYER.address, to: RAIL_CONTRACT, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2" },
      }),
      eth_getLogs: () => ({ result: [] }),
    });
    const buyer = await EvmHtlcRail.connect({ config: node.config(), rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    await expect(buyer.lock(terms, 0)).rejects.toThrow(/expected exactly one Locked log .* found 0/);
  });

  it("anvil keeps its one call to latest for the lookup (no extra read, unchanged evidence shape)", async () => {
    const node = capped(31337);
    node.maxLogSpan = undefined;
    const buyer = await connect(node, BUYER);
    const terms = termsFor(generateHashLock().hash);
    await buyer.approve("USDC", terms.amount);
    node.logRanges.length = 0;
    await buyer.lock(terms, 0);
    expect(node.logRanges).toHaveLength(1);
    expect(node.logRanges[0]?.latest).toBe(true);
  });
});

// --- log builders for the scripted tests --------------------------------------------------------------------------------------

const CLAIMED_EVENT = {
  type: "event",
  name: "Claimed",
  inputs: [
    { name: "hashLock", type: "bytes32", indexed: true },
    { name: "preimage", type: "bytes32", indexed: false },
  ],
} as const;

const LOCKED_EVENT = {
  type: "event",
  name: "Locked",
  inputs: [
    { name: "hashLock", type: "bytes32", indexed: true },
    { name: "payer", type: "address", indexed: true },
    { name: "payee", type: "address", indexed: true },
    { name: "token", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "claimByMs", type: "uint256", indexed: false },
    { name: "refundAfterMs", type: "uint256", indexed: false },
  ],
} as const;

function rawLog(topics: readonly Hex[], data: Hex, blockNumber: bigint) {
  return {
    address: RAIL_CONTRACT,
    topics,
    data,
    blockNumber: numberToHex(blockNumber),
    blockHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${"aa".repeat(32)}`,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

function claimedLog(hashLock: Hex, preimage: Hex, blockNumber: bigint): { raw: ReturnType<typeof rawLog>; preimage: Hex } {
  const topics = encodeEventTopics({ abi: [CLAIMED_EVENT], eventName: "Claimed", args: { hashLock } });
  return { raw: rawLog(topics, encodeAbiParameters([{ name: "preimage", type: "bytes32" }], [preimage]), blockNumber), preimage };
}

function lockedLog(hashLock: Hex, blockNumber: bigint): ReturnType<typeof rawLog> {
  const topics = encodeEventTopics({ abi: [LOCKED_EVENT], eventName: "Locked", args: { hashLock, payer: BUYER.address, payee: SELLER.address } });
  const data = encodeAbiParameters(
    [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "claimByMs", type: "uint256" },
      { name: "refundAfterMs", type: "uint256" },
    ],
    [TOKEN, 1_000_000n, BigInt(T0 + 3_600_000), BigInt(T0 + 5_400_000)],
  );
  return rawLog(topics, data, blockNumber);
}
