// SPDX-License-Identifier: MIT
//
// tests/deployment-id.test.ts: R1-05 (review round 1, P8-FIXES-R1.md), the rail half. `CounterAssetRail.deploymentId` names the
// deployment a leg runs on (EVM: escrow contract and token addresses; NEAR: contract account, token account, contract code hash;
// Solana: program id and mint; Bitcoin: network and genesis prefix). A record stores it at its birth and `resume` compares it, so
// a Buyer restarted against another escrow contract can no longer read "no row there" as "never landed" and lock again.
// Per rail the id must be stable (the same config always gives the same string, with no network call and no clock) and distinct
// (another deployment gives another string). The last test runs the flow half end to end on the EVM mock: a resume against a
// redeployed contract is refused and nothing is locked there (the archived scratch test zz-review-secrets-deploy, flipped).

import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { createBtcCounterRail } from "../src/client/btc-rail.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { createEvmCounterRail, evmDeploymentId } from "../src/client/evm-rail.js";
import { decodeFlowRecord, FlowRecordMismatchError, railDeploymentId } from "../src/client/flow-record.js";
import { flowKey } from "../src/client/flow-store.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { createSolCounterRail } from "../src/client/sol-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { BTC_REGTEST_PIN, BTC_SIGNET_PIN, type BtcRailConfig } from "../src/rails/btc-htlc.js";
import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../src/rails/evm-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { InMemorySolSigner } from "../src/rails/sol-signer-memory.js";
import { Controller, PREFIX, STEPS, type Ctx } from "./helpers/crash-matrix.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { HTLC_CODE_HASH, nearConfig } from "./helpers/near-stateful-rpc.js";
import { evmSigner } from "./helpers/proven-lines.js";
import { sellerKeyOf } from "./helpers/seller-key.js";
import { StatefulSolNode } from "./helpers/sol-stateful-chain.js";

/** A transport that must never be used: constructing a rail, and reading its deployment id, makes no network call. */
const deadRpc = (): CapturingRpc =>
  new CapturingRpc({
    endpoint: "http://127.0.0.1:9",
    fetch: (async () => {
      throw new Error("deploymentId must be derived from the config alone (no network call)");
    }) as typeof fetch,
  });

const address = (tag: string): Address => getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
const clock = (): number => 1_700_000_000_000;

function expectWellFormed(id: string, prefix: string): void {
  expect(id.startsWith(`${prefix}:`)).toBe(true);
  expect(id).toMatch(/^[\x20-\x7e]+$/); // printable ASCII
  expect(id.length).toBeLessThanOrEqual(512); // the record's strict reader caps the field there
}

describe("EVM deploymentId: the escrow contract and the token addresses", () => {
  const config = (overrides: Partial<EvmRailConfig> = {}): EvmRailConfig => ({
    pin: ANVIL_LOCAL_PIN,
    endpoint: "http://127.0.0.1:8545",
    contract: address("evm-escrow-one"),
    assets: { USDC: address("evm-usdc-one") },
    ...overrides,
  });
  const rail = (c: EvmRailConfig): CounterAssetRail => createEvmCounterRail({ config: c, rpc: deadRpc(), account: address("buyer"), clock });

  it("is stable: the same config gives the same id, whatever the address casing or the order of the assets, with no network call", () => {
    const a = rail(config({ assets: { USDC: address("evm-usdc-one"), DAI: address("evm-dai-one") } }));
    const b = rail(config({ contract: address("evm-escrow-one").toLowerCase() as Address, assets: { DAI: address("evm-dai-one").toLowerCase() as Address, USDC: address("evm-usdc-one") } }));
    expect(a.deploymentId).toBe(b.deploymentId);
    expect(a.deploymentId).toBe(evmDeploymentId(config({ assets: { USDC: address("evm-usdc-one"), DAI: address("evm-dai-one") } })));
    expectWellFormed(a.deploymentId, "evm-htlc");
  });

  it("is distinct per deployment: another escrow contract, another token, one more token each give another id", () => {
    const base = rail(config()).deploymentId;
    const others = [
      rail(config({ contract: address("evm-escrow-two") })).deploymentId,
      rail(config({ assets: { USDC: address("evm-usdc-two") } })).deploymentId,
      rail(config({ assets: { USDC: address("evm-usdc-one"), DAI: address("evm-dai-one") } })).deploymentId,
      rail(config({ assets: { EURC: address("evm-usdc-one") } })).deploymentId, // the same address under another asset name
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });

  it("is what the flows store: railDeploymentId gives the rail's own id, not the placeholder", () => {
    const r = rail(config());
    expect(railDeploymentId(r)).toBe(r.deploymentId);
    expect(railDeploymentId(r).startsWith("rail:")).toBe(false);
  });
});

describe("NEAR deploymentId: the contract account, the token account and the contract code hash", () => {
  const signer = InMemoryNearSigner.generate("buyer.near-sandbox-flop", new Uint8Array(32).fill(11));
  const rail = (c: ReturnType<typeof nearConfig>): CounterAssetRail => createNearCounterRail({ config: c, rpc: deadRpc(), signer, clock });

  it("is stable and well formed, with no network call", () => {
    const a = rail(nearConfig());
    const b = rail({ ...nearConfig() });
    expect(a.deploymentId).toBe(b.deploymentId);
    expectWellFormed(a.deploymentId, "near-htlc");
    expect(a.deploymentId).toContain(HTLC_CODE_HASH);
    expect(railDeploymentId(a)).toBe(a.deploymentId);
  });

  it("is distinct per deployment: another contract account, another token account, another code hash", () => {
    const base = rail(nearConfig()).deploymentId;
    const others = [
      rail({ ...nearConfig(), contract: "htlc2.near-sandbox-flop" }).deploymentId,
      rail({ ...nearConfig(), assets: { USDC: "usdc2.near-sandbox-flop" } }).deploymentId,
      rail({ ...nearConfig(), htlcCodeHash: "6DWYhR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT" }).deploymentId,
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe("Solana deploymentId: the program id and the mint", () => {
  const node = new StatefulSolNode();
  const signer = InMemorySolSigner.generate(new Uint8Array(32).fill(11));
  const rail = (c: typeof node.config): CounterAssetRail => createSolCounterRail({ config: c, rpc: deadRpc(), signer, clock });

  it("is stable and well formed, with no network call", () => {
    const a = rail(node.config);
    const b = rail({ ...node.config });
    expect(a.deploymentId).toBe(b.deploymentId);
    expectWellFormed(a.deploymentId, "sol-htlc");
    expect(a.deploymentId).toContain(node.config.programId);
    expect(a.deploymentId).toContain(node.config.assets.USDC);
    expect(railDeploymentId(a)).toBe(a.deploymentId);
  });

  it("is distinct per deployment: another program id, another mint", () => {
    const base = rail(node.config).deploymentId;
    const others = [
      rail({ ...node.config, programId: "11111111111111111111111111111112" }).deploymentId,
      rail({ ...node.config, assets: { USDC: "11111111111111111111111111111113" } }).deploymentId,
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe("Bitcoin deploymentId: the network and the genesis hash prefix", () => {
  const key = { pubkey: "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627", fingerprint: 0x2cd95c68, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] };
  const rail = (c: BtcRailConfig): CounterAssetRail => createBtcCounterRail({ config: c, rpc: deadRpc(), wallet: "buyer", key, destinationAddress: "bcrt1qexample", clock });
  const regtest: BtcRailConfig = { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:19000" };

  it("is stable and well formed, with no network call: the node's endpoint and the wallet are not part of it", () => {
    const a = rail(regtest);
    const b = rail({ ...regtest, endpoint: "http://127.0.0.1:19001" });
    expect(a.deploymentId).toBe(b.deploymentId);
    expectWellFormed(a.deploymentId, "btc-htlc");
    expect(a.deploymentId).toContain(`network=${BTC_REGTEST_PIN.network}`);
    expect(a.deploymentId).toContain(BTC_REGTEST_PIN.genesisHash.slice(0, 32));
    expect(railDeploymentId(a)).toBe(a.deploymentId);
  });

  it("is distinct per chain: another network, another genesis hash", () => {
    const base = rail(regtest).deploymentId;
    const others = [
      rail({ pin: BTC_SIGNET_PIN, endpoint: regtest.endpoint }).deploymentId,
      rail({ pin: { ...BTC_REGTEST_PIN, genesisHash: `ff${BTC_REGTEST_PIN.genesisHash.slice(2)}` }, endpoint: regtest.endpoint }).deploymentId,
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe("the flows pin it (R1-05): a resume against a redeployed EVM contract is refused", () => {
  /** The Buyer's lock landed at deployment 1 and the process died before the evidence was saved. */
  async function crashedAfterLock() {
    const ctl = new Controller();
    const w = evmWorld(ctl);
    const buyer = new BuyerFlow(w.buyerOptions());
    const seller = new SellerFlow(w.sellerOptions());
    const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
    for (const step of PREFIX) await step.run(c);
    const key = flowKey("buyer", w.swapId);
    w.stores.buyer.failSaveWhen((_n, _k, bytes) => {
      const r = decodeFlowRecord(bytes, key);
      return r.role === "buyer" && r.lock.evidence !== undefined ? "reject" : undefined;
    });
    await expect(c.buyer.lockLegA()).rejects.toThrow(/injected fault/);
    w.stores.buyer.clearFaults();
    expect(w.counts().locks).toBe(1);
    ctl.restart("buyer");
    return { w, key };
  }

  it("the record names the deployment it was created on, and a rail on another contract is a FlowRecordMismatchError: nothing is locked on deployment 2", async () => {
    const { w, key } = await crashedAfterLock();
    const stored = await w.stores.buyer.load(key);
    expect(stored).not.toBeNull();
    expect(decodeFlowRecord(stored as Uint8Array, key).deploymentId).toBe(railDeploymentId(w.buyerOptions().rail));
    const node2 = new EvmMockNode(() => w.clockRef.ms, address("matrix-evm-rail-v2"), address("matrix-evm-usdc"), [evmSigner(0x411), evmSigner(0x412)]);
    const rail2 = createEvmCounterRail({ config: node2.config(), rpc: node2.rpc(), account: w.addresses.buyer as Address, clock: () => w.clockRef.ms });
    expect(rail2.deploymentId).not.toBe(railDeploymentId(w.buyerOptions().rail));
    await expect(BuyerFlow.resume({ ...w.buyerOptions(), rail: rail2, store: w.stores.buyer, swapId: w.swapId })).rejects.toBeInstanceOf(FlowRecordMismatchError);
    expect(node2.count("lock")).toBe(0);
    // against the right deployment the same record resumes and recognises its lock instead of locking again
    const resumed = await BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId });
    expect(resumed.next).toBe("lockLegA");
    await resumed.flow.lockLegA();
    expect(w.counts().locks).toBe(1);
  });
});

describe("the Seller pins it too (R1-05): a resume against a redeployed EVM contract is refused", () => {
  it("the record names the deployment it was created on, and a Seller rail on another contract is a FlowRecordMismatchError: nothing is claimed on deployment 2", async () => {
    const ctl = new Controller();
    const w = evmWorld(ctl);
    const buyer = new BuyerFlow(w.buyerOptions());
    const seller = new SellerFlow(w.sellerOptions());
    const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
    for (const step of [...PREFIX, STEPS.lockLegA]) await step.run(c);
    const key = await sellerKeyOf(w.stores.seller);
    const contractA = key.slice("seller:".length);
    const stored = await w.stores.seller.load(key);
    expect(decodeFlowRecord(stored as Uint8Array, key).deploymentId).toBe(railDeploymentId(w.sellerOptions().rail));

    ctl.restart("seller");
    const node2 = new EvmMockNode(() => w.clockRef.ms, address("matrix-evm-rail-v2"), address("matrix-evm-usdc"), [evmSigner(0x411), evmSigner(0x412)]);
    const rail2 = createEvmCounterRail({ config: node2.config(), rpc: node2.rpc(), account: w.addresses.seller as Address, clock: () => w.clockRef.ms });
    const refusal = await SellerFlow.resume({ ...w.sellerOptions(), rail: rail2, store: w.stores.seller, contractA, swapId: w.swapId }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(FlowRecordMismatchError);
    expect((refusal as FlowRecordMismatchError).field).toBe("deploymentId");
    expect(node2.count("claim")).toBe(0);
    // against the right deployment the same record resumes and claims where the lock is
    const resumed = await SellerFlow.resume({ ...w.sellerOptions(), store: w.stores.seller, contractA, swapId: w.swapId });
    expect(resumed.next).toBe("claimLegA");
    await resumed.flow.claimLegA(resumed.flow.statement!);
    expect(w.counts().claims).toBe(1);
  });
});
