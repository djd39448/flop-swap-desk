// SPDX-License-Identifier: MIT
//
// tests-anvil/log-scan.anvil.test.ts - P9-3 (handoff/P9-G1-READINESS-SPEC.md, rule 3): the chunked `eth_getLogs` scans against a real anvil
// node. The hermetic tests (tests/evm-log-scan.test.ts, tests/flow-resume-sell.test.ts) prove the chunking against a mock that refuses
// ranges over 500 blocks; this file proves the same arithmetic against the real node's own reading of `fromBlock` and `toBlock` (both
// ends inclusive), with the smallest `maxLogRange` a config may carry (257, R1-FUND-03) and a few hundred mined blocks so the scan makes
// several ranges:
//   - findClaimedPreimage over about 350 blocks with maxLogRange 257 finds a claim that sits in the second range, OLDEST range first from
//     the marker, no range over 257 blocks, and agrees with the unlimited scan (one call to latest);
//   - a lock whose evidence lookup spans several ranges (blocks are mined while its receipt is awaited) is still found exactly once;
//   - no claim in any range reads null after the whole range was read.
// `npm run test:anvil` only.

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { LockTerms } from "@flop-labs/tclk";
import { generateHashLock } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ANVIL_LOCAL_PIN, EvmHtlcRail, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const GENESIS_MS = 1_700_000_000_000;
const RAIL_CLOCK = () => GENESIS_MS;
const PAYER_DID = "did:key:zPayer";
const PAYEE_DID = "did:key:zPayee";

const MINT_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

describe("chunked log scans against a real anvil node", () => {
  let anvil: AnvilHandle;
  let payer: Address;
  let payee: Address;
  let baseConfig: EvmRailConfig;
  let addressBook: AddressBook;

  beforeAll(async () => {
    anvil = await startAnvil({ timestampSeconds: GENESIS_MS / 1000 });
    const [first, second] = anvil.accounts;
    if (first === undefined || second === undefined) throw new Error("test setup: anvil did not expose two accounts");
    payer = first;
    payee = second;
    const deployed = await deployRailContracts(anvil.endpoint, payer);
    baseConfig = { pin: ANVIL_LOCAL_PIN, endpoint: anvil.endpoint, contract: deployed.railContract, assets: { USDC: deployed.tokenContract } };
    addressBook = { resolve: (did) => (did === PAYEE_DID ? payee : payer) };
    const data = encodeFunctionData({ abi: MINT_ABI, functionName: "mint", args: [payer, 100_000_000n] });
    const hash = await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: payer, to: deployed.tokenContract, data }]);
    for (;;) {
      if ((await anvil.rpcCall<unknown>("eth_getTransactionReceipt", [hash])) !== null) break;
      await new Promise((r) => setTimeout(r, 30));
    }
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  const rail = (config: EvmRailConfig, account: Address, rpc: CapturingRpc) => EvmHtlcRail.connect({ config, rpc, account, addressBook, clock: RAIL_CLOCK });
  const blockNumber = async (): Promise<bigint> => BigInt(await anvil.rpcCall<Hex>("eth_blockNumber", []));

  function terms(statement: string, amount: string): LockTerms {
    return {
      contract: `0x${"33".repeat(32)}`,
      lock: "hash",
      statement,
      amount,
      asset: "USDC",
      payer: PAYER_DID,
      payee: PAYEE_DID,
      claimByMs: GENESIS_MS + 60 * 60_000,
      refundAfterMs: GENESIS_MS + 120 * 60_000,
    };
  }

  /** The `eth_getLogs` ranges one rail's rpc recorded, in call order. */
  function logRanges(rpc: CapturingRpc): Array<{ from: bigint; to: bigint | "latest" }> {
    return rpc
      .exchanges()
      .filter((exchange) => exchange.method === "eth_getLogs")
      .map((exchange) => {
        const filter = (exchange.params as Array<{ fromBlock: string; toBlock: string }>)[0]!;
        return { from: BigInt(filter.fromBlock), to: filter.toBlock === "latest" ? ("latest" as const) : BigInt(filter.toBlock) };
      });
  }

  it("a claim 300 blocks above the marker is found by a scan with maxLogRange 257, oldest range first from the marker, and agrees with the unlimited scan", async () => {
    const lock = generateHashLock();
    const t = terms(lock.hash, "1000000");
    const startMarker = await blockNumber();
    const chunkedConfig: EvmRailConfig = { ...baseConfig, maxLogRange: 257 };
    const writer = await rail(baseConfig, payer, new CapturingRpc({ endpoint: anvil.endpoint }));
    await writer.approve("USDC", t.amount);
    await writer.lock(t, 0);
    await anvil.rpcCall("anvil_mine", ["0x12c"]); // 300 blocks: the claim will sit in the second range
    const claimer = await rail(baseConfig, payee, new CapturingRpc({ endpoint: anvil.endpoint }));
    await claimer.claim(lock.hash as Hex, lock.preimage as Hex, t.refundAfterMs);
    await anvil.rpcCall("anvil_mine", ["0x28"]); // 40 more blocks

    const rpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const chunked = await rail(chunkedConfig, payee, rpc);
    rpc.drain();
    const tip = await blockNumber();
    expect(await chunked.findClaimedPreimage(lock.hash as Hex, startMarker)).toBe(lock.preimage);
    const ranges = logRanges(rpc);
    expect(ranges).toHaveLength(2);
    for (const range of ranges) {
      expect(range.to).not.toBe("latest");
      expect((range.to as bigint) - range.from + 1n).toBeLessThanOrEqual(257n);
    }
    expect(ranges[0]?.from, "the oldest range comes first and starts at the marker").toBe(startMarker);
    expect(ranges[1]?.from, "contiguous, oldest to newest").toBe((ranges[0]!.to as bigint) + 1n);
    expect(ranges[1]?.to, "the last range ends at the tip").toBe(tip);

    const unlimitedRpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const unlimited = await rail(baseConfig, payee, unlimitedRpc);
    unlimitedRpc.drain();
    expect(await unlimited.findClaimedPreimage(lock.hash as Hex, startMarker)).toBe(lock.preimage);
    expect(logRanges(unlimitedRpc)).toEqual([{ from: startMarker, to: "latest" }]);
  }, 60_000);

  it("no claim in any range reads null after reading every block from the start, oldest range first", async () => {
    const lock = generateHashLock();
    const start = await blockNumber();
    await anvil.rpcCall("anvil_mine", ["0x258"]); // 600 blocks, no claim for this lock anywhere
    const rpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const chunked = await rail({ ...baseConfig, maxLogRange: 257 }, payee, rpc);
    rpc.drain();
    const tip = await blockNumber();
    expect(await chunked.findClaimedPreimage(lock.hash as Hex, start)).toBeNull();
    const ranges = logRanges(rpc);
    expect(ranges).toHaveLength(Math.ceil(Number(tip - start + 1n) / 257));
    expect(ranges[0]?.from).toBe(start);
    expect(ranges.at(-1)?.to).toBe(tip);
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i]!.from).toBe((ranges[i - 1]!.to as bigint) + 1n);
  }, 60_000);

  it("the write-evidence lookup spanning several 257-block pages still finds its one Locked log", async () => {
    const lock = generateHashLock();
    const t = terms(lock.hash, "500000");
    // Blocks are mined right after the lock's send, so the lookup that follows the receipt spans more than 257 blocks.
    let mineAfterSend = false;
    const fetchMining: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (mineAfterSend && body.method === "eth_sendTransaction") {
        mineAfterSend = false;
        await anvil.rpcCall("anvil_mine", ["0x12c"]); // 300 blocks
      }
      return response;
    };
    const rpc = new CapturingRpc({ endpoint: anvil.endpoint, fetch: fetchMining });
    const chunked = await rail({ ...baseConfig, maxLogRange: 257 }, payer, rpc);
    await chunked.approve("USDC", t.amount);
    const before = logRanges(rpc).length;
    mineAfterSend = true;
    const evidence = await chunked.lock(t, 0);
    expect(evidence.event).toBe("Locked");
    const ranges = logRanges(rpc).slice(before);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    for (const range of ranges) expect((range.to as bigint) - range.from + 1n).toBeLessThanOrEqual(257n);
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i]!.from).toBe((ranges[i - 1]!.to as bigint) + 1n); // oldest first, contiguous
  }, 60_000);
});
