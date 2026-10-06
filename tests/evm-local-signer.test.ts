// SPDX-License-Identifier: MIT
//
// tests/evm-local-signer.test.ts - P9-1 (handoff/P9-G1-READINESS-SPEC.md): the EVM rail with a LOCAL account against the
// stateful mock node, through the real viem clients and the real CapturingRpc. Keys are generated at test time and loaded
// through the real key-file loader (tests/helpers/evm-local.ts); none is a literal.
//
//   - with a LocalAccount every write is `eth_sendRawTransaction` (approve, lock, claim, refund), never `eth_sendTransaction`
//     and never `personal_sign`; nonce, gas and fee reads appear in the captures through the same CapturingRpc; the signed
//     transaction recovers to the account, carries the pinned chain id and a nonce that advances;
//   - with an Address the old shape is unchanged (`eth_sendTransaction`, none of the local-signing reads);
//   - the account proof signed locally verifies with the existing verifier, and refuses a message for another account;
//   - `receiptTimeoutMs` bounds every receipt wait and a timeout is the typed `EvmReceiptTimeoutError`, not a hang;
//   - the real Buyer and Seller flows settle and refund with both parties local, and a lost lock reply is recovered through
//     the P8 path without a second lock.

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, generateHashLock, verifyHashPreimage, type LockTerms } from "@flop-labs/tclk";
import { getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuyerFlow, type BidParams } from "../src/client/buyer.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { MemoryFlowStore } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { accountProofMessage, formatAccountLine, parseAccountLine } from "../src/rails/account-line.js";
import { eip191Verifier } from "../src/rails/account-proof.js";
import {
  EvmHtlcRail,
  EvmReceiptTimeoutError,
  MAX_RECEIPT_TIMEOUT_MS,
  VIEM_RECEIPT_TIMEOUT_MS,
  checkEvmRailConfig,
  type EvmRailConfig,
} from "../src/rails/evm-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import type { AddressBook } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { keyScanner, localSigningRpc, makeLocalAccount, makeLocalAccountWithScan, type LocalSigningRpc } from "./helpers/evm-local.js";
import { identity } from "./helpers/identity.js";

const T0 = 1_700_000_000_000;
const RAIL = getAddress(`0x${Buffer.from("p91-rail", "utf8").toString("hex").padEnd(40, "0")}`);
const TOKEN = getAddress(`0x${Buffer.from("p91-usdc", "utf8").toString("hex").padEnd(40, "0")}`);
const FEE_READS = ["eth_maxPriorityFeePerGas", "eth_gasPrice", "eth_feeHistory"];

function methodsOf(rpc: CapturingRpc): string[] {
  return rpc.exchanges().map((exchange) => exchange.method);
}

interface Rig {
  node: EvmMockNode;
  clockRef: { ms: number };
  clock: () => number;
}

function rig(): Rig {
  const clockRef = { ms: T0 };
  const clock = () => clockRef.ms;
  // No `personal_sign` signers: a node that has no key for any account, like a public endpoint.
  const node = new EvmMockNode(clock, RAIL, TOKEN, []);
  return { node, clockRef, clock };
}

function termsFor(hash: Hex, over: Partial<LockTerms> = {}): LockTerms {
  return {
    contract: `0x${"11".repeat(32)}`,
    lock: "hash",
    statement: hash,
    amount: "1000000",
    asset: "USDC",
    payer: "did:key:zPayer",
    payee: "did:key:zPayee",
    claimByMs: T0 + 60 * 60_000,
    refundAfterMs: T0 + 90 * 60_000,
    ...over,
  };
}

function bookFor(payer: Address, payee: Address): AddressBook {
  return { resolve: (did) => (did === "did:key:zPayee" ? payee : payer) };
}

describe("EvmHtlcRail with a LocalAccount: every write is eth_sendRawTransaction", () => {
  it("approve, lock, claim and refund are signed locally, with nonce, gas and fee reads through the same CapturingRpc", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const seller = await makeLocalAccount();
    const buyerWire = localSigningRpc(node);
    const sellerWire = localSigningRpc(node);
    const book = bookFor(buyer.address, seller.address);
    const buyerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: buyerWire.rpc, account: buyer, addressBook: book, clock });
    const sellerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: sellerWire.rpc, account: seller, addressBook: book, clock });

    const lockHash = generateHashLock();
    const approved = await buyerRail.approve("USDC", "1000000");
    expect(approved.raw.length).toBeGreaterThan(4); // the write's own exchanges: nonce, fee, gas, send, receipt poll
    const locked = await buyerRail.lock(termsFor(lockHash.hash), 0);
    expect(locked.event).toBe("Locked");
    await sellerRail.claim(lockHash.hash, lockHash.preimage, T0 + 80 * 60_000).then((evidence) => expect(evidence.event).toBe("Claimed"));

    const refundHash = generateHashLock();
    await buyerRail.approve("USDC", "1000000");
    await buyerRail.lock(termsFor(refundHash.hash), 0);
    node.rows.get(refundHash.hash.toLowerCase())!.refundAfterMs = BigInt(T0 - 1); // the chain is past this lock's refund window
    const refunded = await buyerRail.refund(refundHash.hash);
    expect(refunded.event).toBe("Refunded");

    for (const wire of [buyerWire, sellerWire]) {
      expect(wire.calls).not.toContain("eth_sendTransaction");
      expect(wire.calls).not.toContain("personal_sign");
      expect(methodsOf(wire.rpc)).not.toContain("eth_sendTransaction");
      expect(methodsOf(wire.rpc)).not.toContain("personal_sign");
      expect(methodsOf(wire.rpc)).toContain("eth_sendRawTransaction");
      expect(methodsOf(wire.rpc)).toContain("eth_getTransactionCount");
      expect(methodsOf(wire.rpc)).toContain("eth_estimateGas");
      expect(methodsOf(wire.rpc).some((method) => FEE_READS.includes(method))).toBe(true);
    }

    // The buyer's four writes: approve (nonce 0), lock (1), approve (2), lock (3), refund (4). The seller's claim is nonce 0.
    expect(buyerWire.rawSends.map((send) => send.nonce)).toEqual([0, 1, 2, 3, 4]);
    expect(sellerWire.rawSends.map((send) => send.nonce)).toEqual([0]);
    for (const send of buyerWire.rawSends) {
      expect(send.from).toBe(buyer.address);
      expect(send.chainId).toBe(31337);
    }
    expect(sellerWire.rawSends[0]?.from).toBe(seller.address);
    expect(buyerWire.rawSends[0]?.to?.toLowerCase()).toBe(TOKEN.toLowerCase()); // approve goes to the token
    expect(buyerWire.rawSends[1]?.to?.toLowerCase()).toBe(RAIL.toLowerCase()); // lock goes to the escrow
    expect(node.count("approve")).toBe(2);
    expect(node.count("lock")).toBe(2);
    expect(node.count("claim")).toBe(1);
    expect(node.count("refund")).toBe(1);
  });

  it("the fee and gas fields are viem's defaults: an EIP-1559 transaction with a gas limit from eth_estimateGas", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock });
    await rail.approve("USDC", "5");
    expect(wire.calls.indexOf("eth_getTransactionCount")).toBeLessThan(wire.calls.indexOf("eth_sendRawTransaction"));
    expect(wire.calls.indexOf("eth_estimateGas")).toBeLessThan(wire.calls.indexOf("eth_sendRawTransaction"));
    expect(wire.rawSends).toHaveLength(1);
  });

  it("the real preimage reaches the endpoint only after the claim's last deadline guard, and only a handful of viem's own calls follow it", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const seller = await makeLocalAccount();
    const buyerWire = localSigningRpc(node);
    const sellerWire = localSigningRpc(node);
    const book = bookFor(buyer.address, seller.address);
    const buyerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: buyerWire.rpc, account: buyer, addressBook: book, clock });
    const sellerRail = await EvmHtlcRail.connect({ config: node.config(), rpc: sellerWire.rpc, account: seller, addressBook: book, clock });
    const secret = generateHashLock();
    await buyerRail.approve("USDC", "1000000");
    await buyerRail.lock(termsFor(secret.hash), 0);
    await sellerRail.claim(secret.hash, secret.preimage, T0 + 80 * 60_000);

    const exchanges = sellerWire.rpc.exchanges();
    const guard = exchanges.map((exchange) => JSON.stringify(exchange.params)).lastIndexOf(JSON.stringify(["pending", false]));
    expect(guard).toBeGreaterThan(0);
    const bare = secret.preimage.slice(2).toLowerCase();
    exchanges.forEach((exchange, index) => {
      const carries = exchange.requestBody.toLowerCase().includes(bare);
      if (index <= guard) expect(carries, `exchange ${index} (${exchange.method}) is at or before the guard`).toBe(false);
    });
    // What follows the guard is viem's own signing path, a handful of single-attempt calls; the preimage rides only the last ones.
    const after = exchanges.slice(guard + 1).map((exchange) => exchange.method);
    expect(after.at(-1)).toBe("eth_getLogs"); // the write-evidence lookup, after the receipt
    // A client's first write first asks the node to fill the transaction (`eth_fillTransaction`; this mock answers method-not-found,
    // and viem then falls back to the individual reads below).
    expect(after.filter((method) => method !== "eth_fillTransaction").slice(0, 5)).toEqual([
      "eth_getTransactionCount",
      "eth_getBlockByNumber",
      "eth_maxPriorityFeePerGas",
      "eth_estimateGas",
      "eth_sendRawTransaction",
    ]);
    const carriers = exchanges.filter((exchange) => exchange.requestBody.toLowerCase().includes(bare)).map((exchange) => exchange.method);
    expect(carriers.filter((method) => method !== "eth_fillTransaction")).toEqual(["eth_estimateGas", "eth_sendRawTransaction"]);
  });

  it("a node-refused raw send surfaces as a failure and does not move the account's nonce", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock });
    node.rejectNextSend("approve");
    await expect(rail.approve("USDC", "5")).rejects.toThrow();
    await rail.approve("USDC", "5"); // the retry is signed with the SAME nonce 0: the refused transaction never took it
    expect(wire.rawSends.map((send) => send.nonce)).toEqual([0, 0]);
    expect(node.count("approve")).toBe(1);
  });

  it("a node that is behind on the transaction count gets a nonce-too-low answer, not a second applied send", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc: wire.rpc, account: buyer, addressBook: bookFor(buyer.address, buyer.address), clock });
    await rail.approve("USDC", "5");
    wire.countOverride.set(buyer.address.toLowerCase(), 0); // the count read lags: it still says 0
    await expect(rail.approve("USDC", "5")).rejects.toThrow(/nonce too low/);
    expect(node.count("approve")).toBe(1);
  });
});

describe("EvmHtlcRail with an Address: the old shape is unchanged", () => {
  it("writes are eth_sendTransaction from the node, with none of the local-signing reads", async () => {
    const { node, clock } = rig();
    const rpc = node.rpc();
    const payer = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const rail = await EvmHtlcRail.connect({ config: node.config(), rpc, account: payer, addressBook: bookFor(payer, payer), clock });
    const lockHash = generateHashLock();
    await rail.approve("USDC", "1000000");
    await rail.lock(termsFor(lockHash.hash), 0);
    const methods = methodsOf(rpc);
    expect(methods).toContain("eth_sendTransaction");
    for (const absent of ["eth_sendRawTransaction", "eth_getTransactionCount", "eth_estimateGas", "personal_sign", ...FEE_READS]) {
      expect(methods).not.toContain(absent);
    }
  });
});

describe("EvmHtlcRail.connect: the account option is validated", () => {
  const address = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  const signTransaction = async () => "0x";
  const bogus: Array<[string, unknown]> = [
    ["a smart account", { address, type: "smart", signTransaction }],
    ["a local-looking object with a bad address", { address: "nope", type: "local", signTransaction }],
    ["a local-looking object that cannot sign a transaction", { address, type: "local" }],
    ["null", null],
    ["a number", 5],
  ];
  for (const [name, account] of bogus) {
    it(`refuses ${name}`, async () => {
      const { node, clock } = rig();
      await expect(
        EvmHtlcRail.connect({ config: node.config(), rpc: node.rpc(), account: account as never, addressBook: bookFor(RAIL, RAIL), clock }),
      ).rejects.toThrow(/account must be an address or a local account/);
    });
  }
});

describe("the account proof (EIP-191) signed by a local account", () => {
  const did = identity("41".repeat(32)).did;
  const contract = `0x${"22".repeat(32)}`;

  it("is account.signMessage, not personal_sign, and verifies with the existing verifier", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const wire = localSigningRpc(node);
    const rail = createEvmCounterRail({ config: node.config(), rpc: wire.rpc, account: buyer, clock });
    const line = await rail.proveAccountLine({ address: buyer.address, did, contract, terms: termsFor(generateHashLock().hash) });

    expect(wire.calls).not.toContain("personal_sign");
    expect(methodsOf(wire.rpc)).not.toContain("personal_sign");
    const parsed = parseAccountLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.address).toBe(buyer.address.toLowerCase());
    expect(parsed?.proof?.scheme).toBe("eip191");
    const message = accountProofMessage({ did, contract, railId: "evm-htlc", caip2: "eip155:31337", address: buyer.address });
    expect(
      eip191Verifier.verify({ message, railId: "evm-htlc", caip2: "eip155:31337", subject: buyer.address.toLowerCase(), proof: parsed!.proof! }),
    ).toBe(true);
    // An independent recovery agrees: the signature is by this account over exactly this message.
    const signature = `0x${parsed!.proof!.signature}` as Hex;
    expect(await recoverMessageAddress({ message, signature })).toBe(buyer.address);
    // A line signed for one account does not verify for another.
    const other = await makeLocalAccount();
    expect(
      eip191Verifier.verify({ message, railId: "evm-htlc", caip2: "eip155:31337", subject: other.address.toLowerCase(), proof: parsed!.proof! }),
    ).toBe(false);
  });

  it("refuses to sign a message that names another account, and signs nothing", async () => {
    const { node, clock } = rig();
    const buyer = await makeLocalAccount();
    const other = await makeLocalAccount();
    const wire = localSigningRpc(node);
    // The sealed account is frozen (it cannot be spied on), so stand a counting stand-in in front of its signer.
    const sign = vi.fn(buyer.signMessage);
    const counting = { address: buyer.address, type: "local", source: "privateKey", publicKey: buyer.publicKey, signMessage: sign, signTransaction: buyer.signTransaction, signTypedData: buyer.signTypedData } as unknown as typeof buyer;
    const rail = createEvmCounterRail({ config: node.config(), rpc: wire.rpc, account: counting, clock });
    await expect(rail.proveAccountLine({ address: other.address, did, contract, terms: termsFor(generateHashLock().hash) })).rejects.toThrow(
      /does not name this handle's own account/,
    );
    expect(sign).not.toHaveBeenCalled();
  });

  it("a formatted line round-trips: the line a party posts is the one this rail would sign", async () => {
    const { node, clock } = rig();
    const seller = await makeLocalAccount();
    const wire = localSigningRpc(node);
    const rail = createEvmCounterRail({ config: node.config(), rpc: wire.rpc, account: seller, clock });
    const line = await rail.proveAccountLine({ address: seller.address, did, contract, terms: termsFor(generateHashLock().hash) });
    const parsed = parseAccountLine(line)!;
    expect(line).toBe(formatAccountLine({ railId: "evm-htlc", caip2: "eip155:31337", address: seller.address, proof: parsed.proof! }));
  });
});

describe("receiptTimeoutMs", () => {
  /** A rail whose chain never confirms anything: every receipt read answers null. */
  async function stuckRail(receiptTimeoutMs: number | undefined, kind: "local" | "json-rpc") {
    const { node, clock } = rig();
    const payer = kind === "local" ? await makeLocalAccount() : getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const address = typeof payer === "string" ? payer : payer.address;
    let rpc: CapturingRpc;
    let wire: LocalSigningRpc | undefined;
    if (kind === "local") {
      wire = localSigningRpc(node);
      wire.holdReceipts = true;
      rpc = wire.rpc;
    } else {
      const inner = node.rpc();
      const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number | string; method: string; params: unknown[] };
        let envelope: unknown;
        if (body.method === "eth_getTransactionReceipt") envelope = { jsonrpc: "2.0", id: body.id, result: null };
        else if (body.method === "eth_getTransactionByHash") envelope = { jsonrpc: "2.0", id: body.id, result: null };
        else {
          try {
            envelope = { jsonrpc: "2.0", id: body.id, result: await inner.request({ method: body.method, params: body.params }) };
          } catch (error) {
            const e = error as { code?: number; message?: string };
            envelope = { jsonrpc: "2.0", id: body.id, error: { code: e.code ?? -32000, message: e.message ?? "" } };
          }
        }
        const text = JSON.stringify(envelope);
        const bytes = new TextEncoder().encode(text);
        return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
      }) as typeof fetch;
      rpc = new CapturingRpc({ endpoint: "http://mock-evm", fetch: fetchImpl });
    }
    const config: EvmRailConfig = { ...node.config(), ...(receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs }) };
    const rail = await EvmHtlcRail.connect({ config, rpc, account: payer, addressBook: bookFor(address, address), clock });
    return { rail, node, wire, address };
  }

  for (const kind of ["local", "json-rpc"] as const) {
    it(`${kind}: a lock whose receipt never comes is an EvmReceiptTimeoutError after receiptTimeoutMs, not a hang`, async () => {
      const { rail } = await stuckRail(150, kind);
      const started = Date.now();
      const error = await rail.lock(termsFor(generateHashLock().hash), 0).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(error).toBeInstanceOf(EvmReceiptTimeoutError);
      const timeout = error as EvmReceiptTimeoutError;
      expect(timeout.name).toBe("EvmReceiptTimeoutError");
      expect(timeout.timeoutMs).toBe(150);
      expect(timeout.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(timeout.message).toContain(timeout.hash);
      expect(timeout.message).toMatch(/may still be mined/);
    });

    it(`${kind}: approve is bounded the same way`, async () => {
      const { rail } = await stuckRail(150, kind);
      await expect(rail.approve("USDC", "1")).rejects.toBeInstanceOf(EvmReceiptTimeoutError);
    });
  }

  it("claim and refund are bounded too, and the timeout names the transaction that was sent", async () => {
    const { rail, node, wire, address } = await stuckRail(150, "local");
    const payee = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const open = (hash: Hex, refundAfterMs: number) =>
      node.rows.set(hash.toLowerCase(), { payer: address, payee, token: TOKEN, amount: 1n, claimByMs: BigInt(T0 + 60 * 60_000), refundAfterMs: BigInt(refundAfterMs), status: 1 });

    // The chain never confirms OUR sends, but it can already hold locks: one open (to claim), one past its refund window.
    const toClaim = generateHashLock();
    open(toClaim.hash, T0 + 90 * 60_000);
    const claim = await rail.claim(toClaim.hash, toClaim.preimage, T0 + 80 * 60_000).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(claim).toBeInstanceOf(EvmReceiptTimeoutError);
    expect(wire?.rawSends).toHaveLength(1); // it WAS sent: the timeout is "sent, outcome unknown"

    const toRefund = generateHashLock();
    open(toRefund.hash, T0 - 1);
    const refund = await rail.refund(toRefund.hash).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refund).toBeInstanceOf(EvmReceiptTimeoutError);
    expect(wire?.rawSends).toHaveLength(2);
  });

  describe("the default is viem's (no receiptTimeoutMs configured)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits the full 180 s before it gives up, and then says so", async () => {
      const { rail } = await stuckRail(undefined, "local");
      let outcome: unknown = "pending";
      void rail.approve("USDC", "1").then(
        () => {
          outcome = "resolved";
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await vi.advanceTimersByTimeAsync(VIEM_RECEIPT_TIMEOUT_MS - 1_000);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(outcome).toBeInstanceOf(EvmReceiptTimeoutError);
      expect((outcome as EvmReceiptTimeoutError).timeoutMs).toBe(180_000);
    });
  });

  it("is validated: a positive integer of at most a day; omitted is fine", () => {
    const { node } = rig();
    const base = node.config();
    expect(checkEvmRailConfig(base).ok).toBe(true);
    expect(checkEvmRailConfig({ ...base, receiptTimeoutMs: 1 }).ok).toBe(true);
    expect(checkEvmRailConfig({ ...base, receiptTimeoutMs: MAX_RECEIPT_TIMEOUT_MS }).ok).toBe(true);
    for (const bad of [0, -5, 1.5, MAX_RECEIPT_TIMEOUT_MS + 1, "300", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = checkEvmRailConfig({ ...base, receiptTimeoutMs: bad });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/receiptTimeoutMs must be a positive integer/);
    }
  });
});

describe("the real Buyer and Seller flows with both parties local", () => {
  const BID = (swapId: string): BidParams => ({
    swapId,
    wantAsset: "FLOP",
    wantAmount: "52070000",
    wantRail: "flop-htlc",
    amount: "1000000",
    asset: "USDC",
    claimByMs: T0 + 60 * 60_000,
    refundAfterMs: T0 + 90 * 60_000,
    expiresMs: T0 + 30 * 60_000,
  });
  const LEG_B = { claimByMs: T0 + 120 * 60_000, refundAfterMs: T0 + 180 * 60_000, expiresMs: T0 + 40 * 60_000 };

  /** Both parties built over one mock node, each with its own CapturingRpc and its own freshly generated local account, taken
   *  through the pairing, leg B's paper lock and both PROVEN account lines (the lines are signed by the local accounts). */
  async function pairedSwap(withStore: boolean) {
    const { node, clockRef, clock } = rig();
    const { account: buyerAccount, leaks: buyerLeaks } = await makeLocalAccountWithScan();
    const { account: sellerAccount, leaks: sellerLeaks } = await makeLocalAccountWithScan();
    const buyerWire = localSigningRpc(node);
    const sellerWire = localSigningRpc(node);
    const buyerId = identity("51".repeat(32));
    const sellerId = identity("52".repeat(32));
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const stores = { buyer: new MemoryFlowStore(), seller: new MemoryFlowStore() };
    const buyerOptions = () => ({
      identity: buyerId,
      venue,
      paperRail: new PaperRail(noteStore, clock),
      rail: createEvmCounterRail({ config: node.config(), rpc: buyerWire.rpc, account: buyerAccount, clock }),
      clock,
      ...(withStore ? { store: stores.buyer } : {}),
    });
    const sellerOptions = () => ({
      identity: sellerId,
      venue,
      paperRail: new PaperRail(noteStore, clock),
      rail: createEvmCounterRail({ config: node.config(), rpc: sellerWire.rpc, account: sellerAccount, clock }),
      clock,
      ...(withStore ? { store: stores.seller } : {}),
    });
    const buyer = new BuyerFlow(buyerOptions());
    const seller = new SellerFlow(sellerOptions());
    const swapId = computeSwapId(buyerId.did, "000000a1");

    const offerA = await buyer.bid(BID(swapId));
    const { acceptA, acceptARecord, offerBRecord } = await seller.acceptLegA(offerA, LEG_B, T0);
    const { acceptB, acceptBRecord } = await buyer.acceptLegB(offerBRecord, acceptARecord, T0);
    await seller.lockLegB(acceptBRecord);
    await buyer.verifyLegBLocked();
    await seller.postAccountLineA(sellerAccount.address);
    await buyer.postAccountLineA(buyerAccount.address);
    const leaks = (text: string): boolean => buyerLeaks(text) || sellerLeaks(text);
    return { node, clockRef, buyer, seller, buyerAccount, sellerAccount, buyerWire, sellerWire, venue, stores, swapId, buyerOptions, sellerOptions, leaks, acceptA, acceptB };
  }

  it("settles: lock and claim go out as raw transactions, no personal_sign, no eth_sendTransaction, the Buyer learns the secret", async () => {
    const r = await pairedSwap(false);
    const lockA = await r.buyer.lockLegA();
    expect(lockA.writeEvidence.event).toBe("Locked");
    const claimed = await r.seller.claimLegA(lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
    const secret = await r.buyer.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await r.buyer.claimLegB(secret);

    for (const wire of [r.buyerWire, r.sellerWire]) {
      expect(wire.calls).not.toContain("eth_sendTransaction");
      expect(wire.calls).not.toContain("personal_sign");
    }
    expect(r.buyerWire.rawSends.map((send) => send.to?.toLowerCase())).toEqual([TOKEN.toLowerCase(), RAIL.toLowerCase()]);
    expect(r.sellerWire.rawSends.map((send) => send.from)).toEqual([r.sellerAccount.address]);
    expect(r.node.count("lock")).toBe(1);
    expect(r.node.count("claim")).toBe(1);
  });

  it("no key appears in any capture, venue line, store record or rendering of a whole swap (rule 1)", async () => {
    const r = await pairedSwap(true);
    const lockA = await r.buyer.lockLegA();
    await r.seller.claimLegA(lockA.hashLock);
    await r.buyer.claimLegB(await r.buyer.learnSecret());

    const texts: string[] = [];
    for (const wire of [r.buyerWire, r.sellerWire]) {
      for (const exchange of wire.rpc.exchanges()) texts.push(exchange.requestBody, exchange.responseBody, JSON.stringify(exchange.params));
      texts.push(JSON.stringify(wire.rawSends, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
    }
    for (const room of [OFFER_ROOM, dealRoom(r.acceptA.contract), dealRoom(r.acceptB.contract)]) texts.push(JSON.stringify(await r.venue.read(room)));
    for (const store of [r.stores.buyer, r.stores.seller]) {
      for (const key of await store.list()) texts.push(key, Buffer.from((await store.load(key))!).toString("utf8"));
    }
    for (const flow of [r.buyer, r.seller]) texts.push(JSON.stringify(flow), inspect(flow, { depth: null, showHidden: true }), String(flow));
    for (const options of [r.buyerOptions(), r.sellerOptions()]) {
      texts.push(inspect(options, { depth: null, showHidden: true }), inspect(options, { depth: null, customInspect: false, showHidden: true }));
    }
    for (const account of [r.buyerAccount, r.sellerAccount]) texts.push(JSON.stringify(account), inspect(account, { depth: null, showHidden: true }), String(account));

    expect(texts.length).toBeGreaterThan(40);
    expect(texts.some((text) => r.leaks(text))).toBe(false); // a boolean: a failure here must never print the key
  });

  it("the key scanner is not blind: it finds a key, a part of it, either case, with or without 0x, and nothing else", () => {
    const key = generatePrivateKey();
    const scan = keyScanner(key);
    expect(scan(`prefix ${key} suffix`)).toBe(true);
    expect(scan(key.slice(2))).toBe(true);
    expect(scan(key.slice(2).toUpperCase())).toBe(true);
    expect(scan(`"${key.slice(20, 50)}"`)).toBe(true); // 30 hex digits of it
    expect(scan(key.slice(2, 17))).toBe(false); // 15 digits are below the window: a deliberately blunt scanner
    expect(scan(JSON.stringify({ hash: `0x${"ab".repeat(32)}` }))).toBe(false);
    expect(scan(keyScanner(generatePrivateKey()).toString())).toBe(false);
  });

  it("refunds: the Buyer's refund after the window is a raw transaction by the Buyer's account, then leg B's paper refund", async () => {
    const r = await pairedSwap(false);
    const lockA = await r.buyer.lockLegA();
    r.clockRef.ms = T0 + 90 * 60_000 + 60_000;
    const refunded = await r.buyer.refundLegA();
    expect(refunded.event).toBe("Refunded");
    r.clockRef.ms = LEG_B.refundAfterMs + 60_000;
    await r.seller.refundLegB();
    expect(r.node.count("refund")).toBe(1);
    expect(r.buyerWire.rawSends.at(-1)?.from).toBe(r.buyerAccount.address);
    expect(r.buyerWire.calls).not.toContain("eth_sendTransaction");
    expect(lockA.hashLock).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("a lost lock reply is recovered through the P8 path: the same one lock, no second signed lock, then the swap settles", async () => {
    const r = await pairedSwap(true);
    r.node.loseNextSendReply("lock");
    await expect(r.buyer.lockLegA()).rejects.toThrow();
    expect(r.node.count("lock")).toBe(1); // it landed; the reply did not come back
    const sentBefore = r.buyerWire.rawSends.length;

    // The Buyer's process restarts: a fresh flow resumes from the store and recovers the lock by reading the chain.
    const resumed = await BuyerFlow.resume({ ...r.buyerOptions(), store: r.stores.buyer, swapId: r.swapId });
    const lockA = await resumed.flow.lockLegA();
    expect(lockA.hashLock).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.node.count("lock")).toBe(1);
    expect(r.node.count("approve")).toBe(1);
    expect(r.buyerWire.rawSends.length).toBe(sentBefore); // recovery read the chain; it signed and sent nothing

    const claimed = await r.seller.claimLegA(lockA.hashLock);
    expect(claimed.evidence.event).toBe("Claimed");
    await resumed.flow.claimLegB(await resumed.flow.learnSecret());
    expect(r.node.count("claim")).toBe(1);
  });
});
