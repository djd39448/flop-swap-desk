// SPDX-License-Identifier: MIT
//
// tests-anvil/log-scan.anvil.test.ts - P9-3 (handoff/P9-G1-READINESS-SPEC.md, rule 3): the chunked `eth_getLogs` scans against a real anvil
// node. The hermetic tests (tests/evm-log-scan.test.ts, tests/flow-resume-sell.test.ts) prove the chunking against a mock that refuses
// ranges over 500 blocks; this file proves the same arithmetic against the real node's own reading of `fromBlock` and `toBlock` (both
// ends inclusive), with a small `maxLogRange` so a handful of blocks makes several ranges:
//   - findClaimedPreimage over about 40 blocks with maxLogRange 7 finds the claim, newest range first, no range over 7 blocks, and agrees
//     with the unlimited scan (one call to latest);
//   - a lock whose evidence lookup spans several ranges (maxLogRange 1) is still found exactly once;
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

  it("a claim 40 blocks back is found by a scan with maxLogRange 7, newest range first, and agrees with the unlimited scan", async () => {
    const lock = generateHashLock();
    const t = terms(lock.hash, "1000000");
    const startMarker = await blockNumber();
    const chunkedConfig: EvmRailConfig = { ...baseConfig, maxLogRange: 7 };
    const writer = await rail(baseConfig, payer, new CapturingRpc({ endpoint: anvil.endpoint }));
    await writer.approve("USDC", t.amount);
    await writer.lock(t, 0);
    await anvil.rpcCall("anvil_mine", ["0x2"]); // the lock is final for the claim's own pre-check
    const claimer = await rail(baseConfig, payee, new CapturingRpc({ endpoint: anvil.endpoint }));
    await claimer.claim(lock.hash as Hex, lock.preimage as Hex, t.refundAfterMs);
    await anvil.rpcCall("anvil_mine", ["0x28"]); // 40 more blocks

    const rpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const chunked = await rail(chunkedConfig, payee, rpc);
    rpc.drain();
    const tip = await blockNumber();
    expect(await chunked.findClaimedPreimage(lock.hash as Hex, startMarker)).toBe(lock.preimage);
    const ranges = logRanges(rpc);
    expect(ranges.length).toBeGreaterThan(1);
    for (const range of ranges) {
      expect(range.to).not.toBe("latest");
      expect((range.to as bigint) - range.from + 1n).toBeLessThanOrEqual(7n);
    }
    expect(ranges[0]?.to, "the newest range comes first and ends at the tip").toBe(tip);
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i]!.to).toBe(ranges[i - 1]!.from - 1n); // contiguous, newest to oldest

    const unlimitedRpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const unlimited = await rail(baseConfig, payee, unlimitedRpc);
    unlimitedRpc.drain();
    expect(await unlimited.findClaimedPreimage(lock.hash as Hex, startMarker)).toBe(lock.preimage);
    expect(logRanges(unlimitedRpc)).toEqual([{ from: startMarker, to: "latest" }]);
  }, 60_000);

  it("no claim in any range reads null after reading every block from the start", async () => {
    const lock = generateHashLock();
    const start = await blockNumber();
    await anvil.rpcCall("anvil_mine", ["0x1e"]); // 30 blocks, no claim for this lock anywhere
    const rpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const chunked = await rail({ ...baseConfig, maxLogRange: 7 }, payee, rpc);
    rpc.drain();
    const tip = await blockNumber();
    expect(await chunked.findClaimedPreimage(lock.hash as Hex, start)).toBeNull();
    const ranges = logRanges(rpc);
    expect(ranges).toHaveLength(Math.ceil(Number(tip - start + 1n) / 7));
    expect(ranges.at(-1)?.from).toBe(start);
  }, 60_000);

  it("the write-evidence lookup with maxLogRange 1 pages block by block and still finds its one Locked log", async () => {
    const lock = generateHashLock();
    const t = terms(lock.hash, "500000");
    const rpc = new CapturingRpc({ endpoint: anvil.endpoint });
    const chunked = await rail({ ...baseConfig, maxLogRange: 1 }, payer, rpc);
    await chunked.approve("USDC", t.amount);
    const before = logRanges(rpc).length;
    const evidence = await chunked.lock(t, 0);
    expect(evidence.event).toBe("Locked");
    const ranges = logRanges(rpc).slice(before);
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    for (const range of ranges) expect(range.to).toBe(range.from); // one block per call
  }, 60_000);
});
