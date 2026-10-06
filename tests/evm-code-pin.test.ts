// SPDX-License-Identifier: MIT
//
// tests/evm-code-pin.test.ts: P9-2 (rule 2, "trust a contract by its code, not its address"). `EvmRailConfig.contractCodeHash` is the
// keccak256 of the escrow's deployed RUNTIME code (the bytes `eth_getCode` answers):
//   - a Base Sepolia (84532) config without it is refused by every entry point that validates a config; anvil's is optional;
//   - `EvmHtlcRail.connect` reads `eth_getCode(contract, "latest")` and refuses an empty, malformed or different code (typed
//     `EvmContractCodeError`, naming the expected and the observed hash) before any write;
//   - the evidence reader captures the same read and fails closed (`railVerified: null` with a reason) when the code differs, when the
//     capture never read it or was taken without the pin, so the board never folds on an unpinned contract.
// Everything runs on the stateful mock node (tests/helpers/evm-mock-node.ts) or on scripted JSON-RPC answers; no anvil.

import type { LockTerms } from "@flop-labs/tclk";
import { generateHashLock } from "@flop-labs/tclk";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { createEvmCounterRail, evmDeploymentId } from "../src/client/evm-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { captureEvmLeg, evmEvidence, type EvmCapture, type EvmCaptureIndex } from "../src/rails/evm-evidence.js";
import {
  ANVIL_LOCAL_PIN,
  BASE_SEPOLIA_PIN,
  EvmContractCodeError,
  EvmHtlcRail,
  checkEvmRailConfig,
  validateEvmRailConfig,
  type EvmRailConfig,
} from "../src/rails/evm-htlc.js";
import { verifiedExchangeBytes, type CapturingRpc } from "../src/rails/rpc-capture.js";
import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { Controller, PREFIX, type Ctx } from "./helpers/crash-matrix.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmWorldWith } from "./helpers/matrix-worlds.js";
import { evmSigner } from "./helpers/proven-lines.js";
import { scriptedRpc } from "./helpers/scripted-rpc.js";

const T0 = 1_700_000_000_000;
const NOW = (): number => T0;

function addr(tag: string): Address {
  return getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
}

const RAIL_CONTRACT = addr("code-pin-rail");
const TOKEN = addr("code-pin-usdc");
const BUYER = evmSigner(0x511);
const SELLER = evmSigner(0x512);
const WRONG_HASH = `0x${"ab".repeat(32)}` as Hex;

const ADDRESS_BOOK: AddressBook = { resolve: (did) => (did === "did:key:zPayee" ? SELLER.address : BUYER.address) };

function newNode(chainId: number = ANVIL_LOCAL_PIN.chainId): EvmMockNode {
  const node = new EvmMockNode(NOW, RAIL_CONTRACT, TOKEN, [BUYER, SELLER]);
  node.chainId = chainId;
  return node;
}

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

/** A connected rail over the node for the Buyer's JSON-RPC account. */
function connectBuyer(node: EvmMockNode, config: EvmRailConfig = node.config()): Promise<EvmHtlcRail> {
  return EvmHtlcRail.connect({ config, rpc: node.rpc(), account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW });
}

const sepoliaConfig = (hash?: string): unknown => ({
  pin: BASE_SEPOLIA_PIN,
  endpoint: "http://mock-evm",
  contract: RAIL_CONTRACT,
  assets: { USDC: TOKEN },
  ...(hash === undefined ? {} : { contractCodeHash: hash }),
});

describe("P9-2 config: a Base Sepolia config must carry contractCodeHash, an anvil one may", () => {
  it("a 84532 config without contractCodeHash is refused by validateEvmRailConfig and checkEvmRailConfig, naming the field", () => {
    const config = sepoliaConfig() as EvmRailConfig;
    expect(() => validateEvmRailConfig(config)).toThrow(/base-sepolia \(84532\) config must carry contractCodeHash/);
    const check = checkEvmRailConfig(config);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/must carry contractCodeHash/);
  });

  it("connect() refuses that config before any network call", async () => {
    const { rpc, calls } = scriptedRpc({});
    await expect(EvmHtlcRail.connect({ config: sepoliaConfig() as EvmRailConfig, rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(
      /refusing to connect.*must carry contractCodeHash/,
    );
    expect(calls).toEqual([]);
  });

  it("a 84532 config with a well-shaped contractCodeHash passes, in either letter case", () => {
    expect(checkEvmRailConfig(sepoliaConfig(WRONG_HASH)).ok).toBe(true);
    expect(checkEvmRailConfig(sepoliaConfig(`0x${"AB".repeat(32)}`)).ok).toBe(true);
  });

  it.each([
    ["too short", `0x${"ab".repeat(31)}`],
    ["too long", `0x${"ab".repeat(33)}`],
    ["no 0x", "ab".repeat(32)],
    ["not hex", `0x${"zz".repeat(32)}`],
    ["empty", ""],
    ["a number", 7],
    ["null", null],
  ])("a malformed contractCodeHash (%s) is refused even on anvil, with its own reason", (_label, value) => {
    const anvil = { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: RAIL_CONTRACT, assets: { USDC: TOKEN }, contractCodeHash: value };
    const check = checkEvmRailConfig(anvil);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/contractCodeHash must be 0x followed by 64 hex digits/);
  });

  it("an anvil config without the field is valid, and so is one with it", () => {
    const anvil = { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: RAIL_CONTRACT, assets: { USDC: TOKEN } };
    expect(checkEvmRailConfig(anvil).ok).toBe(true);
    expect(checkEvmRailConfig({ ...anvil, contractCodeHash: WRONG_HASH }).ok).toBe(true);
  });

  it("the pin is not part of the deployment id (the address names the deployment, the hash only proves what is at it)", () => {
    const bare = newNode().config();
    expect(evmDeploymentId({ ...bare, contractCodeHash: WRONG_HASH })).toBe(evmDeploymentId(bare));
  });
});

describe("P9-2 connect(): the contract's code is read and must hash to the pin", () => {
  it("a matching hash connects; the code read is eth_getCode(contract, latest) right after eth_chainId; any letter case of the hash is fine", async () => {
    const node = newNode();
    const hash = keccak256(node.contractCode);
    for (const written of [hash, hash.toUpperCase().replace("0X", "0x")] as Hex[]) {
      const { rpc, calls } = scriptedRpc({
        eth_chainId: () => ({ result: "0x7a69" }),
        eth_getCode: () => ({ result: node.contractCode }),
      });
      const config = { ...node.config(), contractCodeHash: written };
      await expect(EvmHtlcRail.connect({ config, rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW })).resolves.toBeInstanceOf(EvmHtlcRail);
      expect(calls.map((call) => call.method)).toEqual(["eth_chainId", "eth_getCode"]);
      expect(calls[1]?.params).toEqual([RAIL_CONTRACT, "latest"]);
    }
  });

  it("a different code is refused with the typed error naming the expected and the observed hash, and nothing is written", async () => {
    const node = newNode();
    const observed = keccak256(node.contractCode);
    const config = { ...node.config(), contractCodeHash: WRONG_HASH };
    const error = await connectBuyer(node, config).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EvmContractCodeError);
    const typed = error as EvmContractCodeError;
    expect(typed.problem).toBe("mismatch");
    expect(typed.contract).toBe(RAIL_CONTRACT);
    expect(typed.expected).toBe(WRONG_HASH);
    expect(typed.observed).toBe(observed);
    expect(typed.message).toContain(WRONG_HASH);
    expect(typed.message).toContain(observed);
    expect(typed.message).toMatch(/hash to .*not the pinned contractCodeHash/);
    expect(node.sends).toEqual([]);
  });

  it("no code at the address is refused as empty, naming the pinned hash", async () => {
    const node = newNode();
    node.contractCode = "0x";
    const error = (await connectBuyer(node, { ...node.config(), contractCodeHash: WRONG_HASH }).catch((caught: unknown) => caught)) as EvmContractCodeError;
    expect(error).toBeInstanceOf(EvmContractCodeError);
    expect(error.problem).toBe("empty");
    expect(error.observed).toBeUndefined();
    expect(error.message).toMatch(/no code at .*\(eth_getCode returned 0x\).*contractCodeHash 0xabab/);
  });

  it.each([["not hex at all"], ["0x123"], ["0xzz"], [""]])("an answer that is not whole hex bytes (%j) is refused as malformed", async (answer) => {
    const { rpc } = scriptedRpc({ eth_chainId: () => ({ result: "0x7a69" }), eth_getCode: () => ({ result: answer }) });
    const config = { ...newNode().config(), contractCodeHash: WRONG_HASH };
    const error = (await EvmHtlcRail.connect({ config, rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW }).catch((caught: unknown) => caught)) as EvmContractCodeError;
    expect(error).toBeInstanceOf(EvmContractCodeError);
    expect(error.problem).toBe("malformed");
  });

  it("a node that answers an error to eth_getCode refuses the connect too (never trusted unread)", async () => {
    const { rpc } = scriptedRpc({ eth_chainId: () => ({ result: "0x7a69" }), eth_getCode: () => ({ error: { code: -32000, message: "no code for you" } }) });
    const config = { ...newNode().config(), contractCodeHash: WRONG_HASH };
    await expect(EvmHtlcRail.connect({ config, rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW })).rejects.toThrow(/no code for you/);
  });

  it("the chain id is checked first: a Base Sepolia pin against another chain is refused as that, not as a code problem", async () => {
    const node = newNode(); // chain 31337
    const config: EvmRailConfig = { ...node.config(), pin: BASE_SEPOLIA_PIN, contractCodeHash: WRONG_HASH };
    await expect(connectBuyer(node, config)).rejects.toThrow(/connected chain id 31337 does not match pin "base-sepolia"/);
    expect(node.codeReads).toEqual([]);
  });

  it("an anvil config without the field never reads the code (the existing configs behave exactly as before)", async () => {
    const { rpc, calls } = scriptedRpc({ eth_chainId: () => ({ result: "0x7a69" }) });
    const config = newNode().config();
    expect(config.contractCodeHash).toBeUndefined();
    await EvmHtlcRail.connect({ config, rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW });
    expect(calls.map((call) => call.method)).toEqual(["eth_chainId"]);
  });

  it("a Base Sepolia pin on a 84532 node connects when the code matches (the mock answers chain 84532)", async () => {
    const node = newNode(84532);
    const config = node.config();
    expect(config.pin.chainId).toBe(84532);
    expect(config.contractCodeHash).toBe(keccak256(node.contractCode));
    await expect(connectBuyer(node, config)).resolves.toBeInstanceOf(EvmHtlcRail);
    node.contractCode = `${node.contractCode}00`; // another contract at the same address
    await expect(connectBuyer(node, config)).rejects.toBeInstanceOf(EvmContractCodeError);
  });
});

describe("P9-2: a flow never writes against a contract whose code is not the pin", () => {
  it("every step of a swap refuses at connect: no approve, lock or claim reaches the node", async () => {
    let node: EvmMockNode | undefined;
    const factory = evmWorldWith((n) => {
      node = n;
      n.configExtras = { contractCodeHash: WRONG_HASH }; // the pin names other code than the node's
    });
    const w = factory(new Controller([]));
    const c: Ctx = { w, buyer: new BuyerFlow(w.buyerOptions()), seller: new SellerFlow(w.sellerOptions()), history: [] };
    let refused: unknown;
    for (const step of PREFIX) {
      try {
        await step.run(c);
      } catch (error) {
        refused = error;
        break;
      }
    }
    expect(refused, "a step refused").toBeInstanceOf(EvmContractCodeError);
    expect(node?.sends, "nothing was sent").toEqual([]);
    expect(w.counts()).toEqual({ locks: 0, claims: 0, refunds: 0, refundBuilds: 0 });
  });

  it("the same swap with the right pin gets past the first rail touch: the code is read, every step runs", async () => {
    let node: EvmMockNode | undefined;
    const factory = evmWorldWith((n) => {
      node = n;
      n.configExtras = { contractCodeHash: keccak256(n.contractCode) };
    });
    const w = factory(new Controller([]));
    const c: Ctx = { w, buyer: new BuyerFlow(w.buyerOptions()), seller: new SellerFlow(w.sellerOptions()), history: [] };
    for (const step of PREFIX) await step.run(c);
    expect(node?.codeReads.length, "the pinned code was read").toBeGreaterThan(0);
  });
});

// --- the evidence reader ------------------------------------------------------------------------------------------------------

/** A node holding one lock of the Buyer's, a pinned config, and a captured leg (index plus bytes) for it. */
async function lockedAndCaptured(node: EvmMockNode): Promise<{
  terms: LockTerms;
  config: EvmRailConfig;
  rail: EvmHtlcRail;
  rpc: CapturingRpc;
  capture: () => Promise<EvmCapture>;
}> {
  const lock = generateHashLock();
  const terms = termsFor(lock.hash);
  const config = { ...node.config(), contractCodeHash: keccak256(node.contractCode) };
  const rpc = node.rpc();
  const rail = await EvmHtlcRail.connect({ config, rpc, account: BUYER.address, addressBook: ADDRESS_BOOK, clock: NOW });
  await rail.approve("USDC", terms.amount);
  await rail.lock(terms, 0);
  const capture = async (): Promise<EvmCapture> => {
    const { index, exchanges } = await captureEvmLeg(node.rpc(), config, terms.statement, T0);
    return { index, bytes: verifiedExchangeBytes(exchanges) };
  };
  return { terms, config, rail, rpc, capture };
}

const ACCOUNTS = { payer: BUYER.address, payee: SELLER.address };

/** The index with one exchange (the first of `method`) rewritten: the recorded fields and the request body stay in step, as a forger would leave them. */
function rewrite(capture: EvmCapture, method: string, change: (params: unknown) => unknown): EvmCapture {
  const exchanges = capture.index.exchanges.map((exchange) => {
    if (exchange.method !== method) return exchange;
    const params = change(exchange.params);
    const body = JSON.parse(exchange.requestBody) as { params: unknown };
    return { ...exchange, params, requestBody: JSON.stringify({ ...body, params }) };
  });
  return { index: { ...capture.index, exchanges }, bytes: capture.bytes };
}

describe("P9-2 evidence: the capture reads the code and fails closed when it is not the pin", () => {
  it("a live verifyLockFinal under a pinned config records eth_getCode right after eth_chainId and verifies", async () => {
    const node = newNode();
    const { rail, terms } = await lockedAndCaptured(node);
    const result = await rail.verifyLockFinal(terms, terms.statement, ACCOUNTS);
    expect(result.lock.railVerified).toBe(true);
    expect(result.lock.reason).toMatch(/locked and on-chain state matches terms/);
  });

  it("the captured leg holds the code read: [eth_chainId, eth_getCode(contract, latest), the finalized block, eth_call]", async () => {
    const node = newNode();
    const { capture, terms } = await lockedAndCaptured(node);
    const captured = await capture();
    expect(captured.index.exchanges.map((exchange) => exchange.method)).toEqual(["eth_chainId", "eth_getCode", "eth_getBlockByNumber", "eth_call"]);
    expect(captured.index.exchanges[1]?.params).toEqual([RAIL_CONTRACT, "latest"]);
    expect(captured.index.config.contractCodeHash).toBe(keccak256(node.contractCode));
    const result = evmEvidence({ terms, config: captured.index.config, accounts: ACCOUNTS, capture: captured });
    expect(result.lock.railVerified).toBe(true);
  });

  it("code that changed after connect (another contract at the address) reads railVerified null, naming both hashes, with no rail observation", async () => {
    const node = newNode();
    const { rail, terms, config } = await lockedAndCaptured(node);
    node.contractCode = `${node.contractCode}00`;
    const result = await rail.verifyLockFinal(terms, terms.statement, ACCOUNTS);
    expect(result.lock.railVerified).toBeNull();
    expect(result.rail).toBeUndefined();
    expect(result.lock.reason).toContain(config.contractCodeHash);
    expect(result.lock.reason).toContain(keccak256(node.contractCode));
    expect(result.lock.reason).toMatch(/not the pinned contractCodeHash/);
  });

  it("no code at verify time reads railVerified null as empty", async () => {
    const node = newNode();
    const { rail, terms } = await lockedAndCaptured(node);
    node.contractCode = "0x";
    const result = await rail.verifyLockFinal(terms, terms.statement, ACCOUNTS);
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no code at .*\(eth_getCode returned 0x\)/);
  });

  it("a replayed capture that never read the code fails closed against a pinned auditor config (the exchange is missing)", async () => {
    const node = newNode();
    const { capture, terms, config } = await lockedAndCaptured(node);
    const captured = await capture();
    const without: EvmCapture = { index: { ...captured.index, exchanges: captured.index.exchanges.filter((exchange) => exchange.method !== "eth_getCode") }, bytes: captured.bytes };
    const result = evmEvidence({ terms, config, accounts: ACCOUNTS, capture: without });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/no eth_getCode exchange/);
  });

  it("a capture taken without the pin (its own config has none, no code was read) fails closed against a pinned auditor config", async () => {
    const node = newNode();
    const { terms, config } = await lockedAndCaptured(node);
    const { index, exchanges } = await captureEvmLeg(node.rpc(), node.config(), terms.statement, T0); // the anvil config: no hash, so no code read
    expect(index.exchanges.map((exchange) => exchange.method)).not.toContain("eth_getCode");
    const result = evmEvidence({ terms, config, accounts: ACCOUNTS, capture: { index, bytes: verifiedExchangeBytes(exchanges) } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/without the auditor's contractCodeHash pin/);
  });

  it("a captured config naming another hash than the auditor's fails closed the same way", async () => {
    const node = newNode();
    const { capture, terms, config } = await lockedAndCaptured(node);
    const captured = await capture();
    const other: EvmCapture = { index: { ...captured.index, config: { ...captured.index.config, contractCodeHash: WRONG_HASH } as EvmCaptureIndex["config"] }, bytes: captured.bytes };
    const result = evmEvidence({ terms, config, accounts: ACCOUNTS, capture: other });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/without the auditor's contractCodeHash pin/);
  });

  it("an eth_getCode request rewritten to read another address, or another block, is refused as tampered", async () => {
    const node = newNode();
    const { capture, terms, config } = await lockedAndCaptured(node);
    const captured = await capture();
    const otherAddress = rewrite(captured, "eth_getCode", () => [addr("someone-else"), "latest"]);
    const otherBlock = rewrite(captured, "eth_getCode", () => [RAIL_CONTRACT, "0x1"]);
    for (const tampered of [otherAddress, otherBlock]) {
      const result = evmEvidence({ terms, config, accounts: ACCOUNTS, capture: tampered });
      expect(result.lock.railVerified).toBeNull();
      expect(result.lock.reason).toMatch(/eth_getCode request does not read this deployment's contract at latest/);
    }
  });

  it("an eth_getCode answered with an error is refused", async () => {
    const node = newNode();
    const { terms, config } = await lockedAndCaptured(node);
    const { rpc } = scriptedRpc({
      eth_chainId: () => ({ result: "0x7a69" }),
      eth_getCode: () => ({ error: { code: -32000, message: "boom" } }),
    });
    const { index, exchanges } = await captureEvmLeg(rpc, config, terms.statement, T0);
    // a JSON-RPC error reply on a read stops the capture (F1): it carries `error` and reads null
    expect(index.error).toMatch(/boom/);
    const result = evmEvidence({ terms, config, accounts: ACCOUNTS, capture: { index, bytes: verifiedExchangeBytes(exchanges) } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/chain read did not complete/);
  });

  it("an auditor config without the pin does not check the code (the pin is the auditor's own, so anvil configs work as before)", async () => {
    const node = newNode();
    const { capture, terms } = await lockedAndCaptured(node);
    const captured = await capture();
    const anvilOnly = newNode().config();
    expect(anvilOnly.contractCodeHash).toBeUndefined();
    const result = evmEvidence({ terms, config: { ...anvilOnly, contract: RAIL_CONTRACT }, accounts: ACCOUNTS, capture: captured });
    expect(result.lock.railVerified).toBe(true);
  });

  it("a pinned Base Sepolia mock chain end to end: lock, verify true; the code swapped, verify null", async () => {
    const node = newNode(84532);
    const { rail, terms, config } = await lockedAndCaptured(node);
    expect(config.pin.chainId).toBe(84532);
    expect((await rail.verifyLockFinal(terms, terms.statement, ACCOUNTS)).lock.railVerified).toBe(true);
    node.contractCode = "0x00";
    expect((await rail.verifyLockFinal(terms, terms.statement, ACCOUNTS)).lock.railVerified).toBeNull();
  });
});

describe("P9-2: createEvmCounterRail connect, the first touch of every flow step", () => {
  it("refuses a node whose code is not the pin, and reads nothing else of the contract first", async () => {
    const node = newNode();
    const config = { ...node.config(), contractCodeHash: WRONG_HASH };
    const adapter = createEvmCounterRail({ config, rpc: node.rpc(), account: BUYER.address, clock: NOW });
    await expect(adapter.connect(termsFor(generateHashLock().hash), { payee: SELLER.address, payer: BUYER.address })).rejects.toBeInstanceOf(EvmContractCodeError);
    expect(node.sends).toEqual([]);
  });
});
