// SPDX-License-Identifier: MIT
//
// tests-anvil/evm-htlc.anvil.test.ts — P22-P24-EVM-SPEC.md §2.3: EvmHtlcRail against a real,
// local anvil node. Everything in tests/evm-htlc.test.ts and tests/evm-evidence.test.ts is
// exercised against mocked transports; this file is the one place that proves the adapter's
// assumptions about anvil's actual behaviour (the `--slots-in-an-epoch 1` finalized/safe lag,
// JSON-RPC account writes, `evm_setNextBlockTimestamp`) hold against the real binary, not just
// this session's own empirical check of it. `npm run test:anvil` only; `npm test` never spawns
// anvil (see tests-anvil/helpers/anvil.ts).

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { LockTerms } from "@flop-labs/tclk";
import { generateHashLock } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN, EvmHtlcRail, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { deployRailContracts, startAnvil, type AnvilHandle } from "./helpers/anvil.js";

const MOCK_ERC20_MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

interface Receipt { status: string }

async function waitForReceipt(anvil: AnvilHandle, hash: Hex): Promise<Receipt> {
  for (;;) {
    const receipt = await anvil.rpcCall<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) return receipt;
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function mint(anvil: AnvilHandle, token: Address, to: Address, amount: bigint): Promise<void> {
  const data = encodeFunctionData({ abi: MOCK_ERC20_MINT_ABI, functionName: "mint", args: [to, amount] });
  const hash = await anvil.rpcCall<Hex>("eth_sendTransaction", [{ from: to, to: token, data }]);
  const receipt = await waitForReceipt(anvil, hash);
  if (receipt.status !== "0x1") throw new Error("test setup: mint reverted");
}

const PAYER_DID = "did:key:zPayer";
const PAYEE_DID = "did:key:zPayee";

/** Genesis time for every anvil node this file starts. `EvmHtlcRail`'s injected clock (fed
 *  straight through to the vendored rail's own pre-flight guard) must read a time before any
 *  fixture's `refundAfterMs` — the real wall clock (`Date.now()`, ~2026) is long past this
 *  file's fixed 2023 lock windows. */
const GENESIS_MS = 1_700_000_000_000;
const RAIL_CLOCK = () => GENESIS_MS;

describe("EvmHtlcRail against a real anvil node", () => {
  let anvil: AnvilHandle;
  let railContract: Address;
  let tokenContract: Address;
  let payer: Address;
  let payee: Address;
  let addressBook: AddressBook;
  let config: EvmRailConfig;

  beforeAll(async () => {
    anvil = await startAnvil({ timestampSeconds: GENESIS_MS / 1000 });
    const [first, second] = anvil.accounts;
    if (first === undefined || second === undefined) throw new Error("test setup: anvil did not expose two accounts");
    payer = first;
    payee = second;

    const deployed = await deployRailContracts(anvil.endpoint, payer);
    railContract = deployed.railContract;
    tokenContract = deployed.tokenContract;

    addressBook = { resolve: (did) => (did === PAYEE_DID ? payee : payer) };
    config = { pin: ANVIL_LOCAL_PIN, endpoint: anvil.endpoint, contract: railContract, assets: { USDC: tokenContract } };

    await mint(anvil, tokenContract, payer, 10_000_000n);
  }, 60_000);

  afterAll(async () => {
    // `beforeAll` may have thrown before assigning `anvil` (e.g. no anvil binary found) — don't
    // let that surface a second, unrelated TypeError on top of the real failure.
    await anvil?.stop();
  });

  function freshRpc(): CapturingRpc {
    return new CapturingRpc({ endpoint: anvil.endpoint });
  }

  it("connect refuses BASE_SEPOLIA_PIN against this anvil (chain id 31337)", async () => {
    const wrongPinConfig: EvmRailConfig = { ...config, pin: BASE_SEPOLIA_PIN };
    await expect(
      EvmHtlcRail.connect({ config: wrongPinConfig, rpc: freshRpc(), account: payer, addressBook }),
    ).rejects.toThrow(/connected chain id 31337 does not match pin "base-sepolia"/);
  });

  it("an anvil started with --chain-id 8453 is refused (not on the A3 allow list), by name, even when pinned as 8453", async () => {
    const deniedAnvil = await startAnvil({ chainId: 8453 });
    try {
      expect(deniedAnvil.chainId).toBe(8453);
      const deniedConfig: EvmRailConfig = {
        pin: { chainId: 8453, name: "base-mainnet-oops", caip2: "eip155:8453", finality: { mode: "tag", tag: "finalized" } },
        endpoint: deniedAnvil.endpoint,
        contract: railContract,
        assets: {},
      };
      await expect(
        EvmHtlcRail.connect({
          config: deniedConfig,
          rpc: new CapturingRpc({ endpoint: deniedAnvil.endpoint }),
          account: payer,
          addressBook,
        }),
      ).rejects.toThrow(/chain id 8453 is not on the allow list.*8453 is base mainnet/);
    } finally {
      await deniedAnvil.stop();
    }
  }, 20_000);

  it(
    "approve+lock -> WriteEvidence matching the receipt; verifyLockFinal null right after, true after 2 blocks; " +
      "claim -> observation claimed/final after 2 more; findClaimedPreimage returns s",
    async () => {
      const hashLock = generateHashLock();
      const rail = await EvmHtlcRail.connect({ config, rpc: freshRpc(), account: payer, addressBook, clock: RAIL_CLOCK });

      const terms: LockTerms = {
        contract: "0x" + "11".repeat(32),
        lock: "hash",
        statement: hashLock.hash,
        amount: "1000000",
        asset: "USDC",
        payer: PAYER_DID,
        payee: PAYEE_DID,
        claimByMs: GENESIS_MS + 60 * 60_000,
        refundAfterMs: GENESIS_MS + 120 * 60_000,
      };

      await rail.approve("USDC", terms.amount);
      const lockEvidence = await rail.lock(terms, 0);

      const receipt = await anvil.rpcCall<{ status: string; blockHash: Hex; transactionHash: Hex }>(
        "eth_getTransactionReceipt",
        [lockEvidence.txHash],
      );
      expect(receipt.status).toBe("0x1");
      expect(lockEvidence.txHash).toBe(receipt.transactionHash);
      expect(lockEvidence.blockHash).toBe(receipt.blockHash);

      const accounts = { payee, payer };

      const rightAfter = await rail.verifyLockFinal(terms, hashLock.hash, accounts);
      expect(rightAfter.lock.railVerified).toBeNull();
      expect(rightAfter.lock.reason).toBe("no lock at the finalized view");
      expect(rightAfter.rail).toBeUndefined();

      await anvil.rpcCall("anvil_mine", ["0x2"]);

      const afterTwoBlocks = await rail.verifyLockFinal(terms, hashLock.hash, accounts);
      expect(afterTwoBlocks.lock.railVerified).toBe(true);
      expect(afterTwoBlocks.rail).toEqual({
        status: "locked",
        final: true,
        checkedAtMs: expect.any(Number),
        finalizedRef: expect.stringMatching(/^anvil-local:finalized:\d+:0x[0-9a-f]{64}$/),
      });

      const claimEvidence = await rail.claim(hashLock.hash as Hex, hashLock.preimage as Hex);
      expect(claimEvidence.event).toBe("Claimed");

      await anvil.rpcCall("anvil_mine", ["0x2"]);

      const afterClaim = await rail.verifyLockFinal(terms, hashLock.hash, accounts);
      expect(afterClaim.lock.railVerified).toBe(false);
      expect(afterClaim.rail).toEqual({
        status: "claimed",
        final: true,
        checkedAtMs: expect.any(Number),
        finalizedRef: expect.stringMatching(/^anvil-local:finalized:\d+:0x[0-9a-f]{64}$/),
      });

      const found = await rail.findClaimedPreimage(hashLock.hash as Hex, 0n);
      expect(found).toBe(hashLock.preimage);
    },
    30_000,
  );

  it("refund is refused before refundAfterMs and succeeds after a time warp", async () => {
    const hashLock = generateHashLock();
    const rail = await EvmHtlcRail.connect({ config, rpc: freshRpc(), account: payer, addressBook, clock: RAIL_CLOCK });

    const latestBlock = await anvil.rpcCall<{ timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    const nowMs = Number.parseInt(latestBlock.timestamp, 16) * 1000;

    const terms: LockTerms = {
      contract: "0x" + "22".repeat(32),
      lock: "hash",
      statement: hashLock.hash,
      amount: "500000",
      asset: "USDC",
      payer: PAYER_DID,
      payee: PAYEE_DID,
      claimByMs: nowMs + 5 * 60_000,
      refundAfterMs: nowMs + 10 * 60_000,
    };

    await rail.approve("USDC", terms.amount);
    await rail.lock(terms, 0);

    // Empirically, anvil mines this reverting call rather than rejecting it at send time (unlike
    // a mocked transport's synchronous revert) — the vendored rail surfaces that as its own
    // "mined but reverted" message from the receipt check, not the require() reason string.
    await expect(rail.refund(hashLock.hash as Hex)).rejects.toThrow(/refund transaction mined but reverted on-chain/);

    const refundAfterSeconds = Math.ceil(terms.refundAfterMs / 1000) + 1;
    await anvil.rpcCall("evm_setNextBlockTimestamp", [refundAfterSeconds]);
    await anvil.rpcCall("anvil_mine", ["0x1"]);

    const refundEvidence = await rail.refund(hashLock.hash as Hex);
    expect(refundEvidence.event).toBe("Refunded");
  }, 30_000);
});
