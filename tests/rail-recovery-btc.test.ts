// SPDX-License-Identifier: MIT
//
// tests/rail-recovery-btc.test.ts: P8-RESUME-SPEC.md "Rail seam" and "Rail recovery" for the Bitcoin leg.
// A Buyer that dies between `prepareLock` and the end of `commitLock` must find out what became of the ONE funding
// transaction it signed, from the txid and bytes it persisted, and must never fund a second time:
//   - `prepareLock` hands out the funding txid and exact bytes (the recovery handle);
//   - `recoverLock` asks the node by txid, re-sends the IDENTICAL bytes if the node does not know them, and stops
//     with a typed error if the node refuses them (rule 2: never a second funding); it makes no wallet call;
//   - a refund hands its txid and bytes to `onSigned` before anything is sent, and `recoverRefund` resolves it.
// Everything runs against a mocked bitcoind surface (the pattern tests/btc-htlc.test.ts uses): no node, no wallet.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import type { LockTerms } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { RailRecoveryRefusedError, type ConnectedCounterAssetRail, type LockRecovery } from "../src/client/counter-rail.js";
import { BTC_REGTEST_NETWORK, buildHtlcScript } from "../src/rails/btc-script.js";
import { BTC_REGTEST_PIN, BtcBroadcastRefusedError, BtcHtlcRail, type BtcRailConfig, type BtcSignerKey } from "../src/rails/btc-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";

// -- fixtures ------------------------------------------------------------------------------------------------------

const PAYEE_PUBKEY = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a";
const PAYER_PUBKEY = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627";
const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
const REFUND_AFTER_MS = 1_700_000_000_000;
const BUYER_KEY: BtcSignerKey = { pubkey: PAYER_PUBKEY, fingerprint: 0x2cd95c68, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] };

const SCRIPT = buildHtlcScript(
  { hashLock: hexToBytes(HASH_LOCK.slice(2)), payeePubkey: hexToBytes(PAYEE_PUBKEY), payerPubkey: hexToBytes(PAYER_PUBKEY), locktime: 1_700_000_000 },
  BTC_REGTEST_NETWORK,
);

/** A decodable (unsigned) funding transaction with the HTLC output at vout 1, like the mocked wallet returns. */
function fundingTxHex(): string {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
  tx.addInput({ txid: new Uint8Array(32), index: 0, witnessUtxo: { amount: 1n, script: new Uint8Array([0x00]) } });
  tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(0)]), amount: 1_000_000n });
  tx.addOutput({ script: SCRIPT.scriptPubKey, amount: 100_000_000n });
  return bytesToHex(tx.unsignedTx);
}
const FUNDING_HEX = fundingTxHex();
const FUNDING_TXID = Transaction.fromRaw(hexToBytes(FUNDING_HEX), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;
const REF = `${FUNDING_TXID}:1`;

/** A decodable refund-shaped transaction spending REF: a different txid from the funding. */
function refundTxHex(): string {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 1_700_000_000 });
  tx.addInput({ txid: hexToBytes(FUNDING_TXID), index: 1, sequence: 0xfffffffe, witnessUtxo: { amount: 100_000_000n, script: SCRIPT.scriptPubKey } });
  tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(7)]), amount: 99_990_000n });
  return bytesToHex(tx.unsignedTx);
}
const REFUND_HEX = refundTxHex();
const REFUND_TXID = Transaction.fromRaw(hexToBytes(REFUND_HEX), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;

function lockTerms(): LockTerms {
  return {
    contract: `0x${"11".repeat(32)}`,
    lock: "hash",
    statement: HASH_LOCK,
    amount: "100000000",
    asset: "BTC",
    payer: "did:key:payer",
    payee: "did:key:payee",
    claimByMs: REFUND_AFTER_MS - 3_600_000,
    refundAfterMs: REFUND_AFTER_MS,
  };
}
const ACCOUNTS = { payer: PAYER_PUBKEY, payee: PAYEE_PUBKEY };

function railConfig(): BtcRailConfig {
  return { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:19000" };
}

interface RpcCallLog {
  method: string;
  params: unknown[];
  path?: string;
}
type Handlers = Record<string, (params: unknown[], path: string | undefined) => unknown>;

/** The mocked bitcoind surface of tests/btc-htlc.test.ts: dispatch on `method`, record every call, a thrown handler
 *  becomes a JSON-RPC error (carrying `.code` when it has one, so a test can answer Core's -5 "not found"). */
function mockBitcoind(handlers: Handlers): { fetch: typeof fetch; calls: RpcCallLog[] } {
  const calls: RpcCallLog[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { id: number | string; method: string; params: unknown[] };
    const path = /^https?:\/\/[^/]+(\/.*)?$/.exec(String(url))?.[1];
    calls.push({ method: parsed.method, params: parsed.params, ...(path === undefined ? {} : { path }) });
    const handler = handlers[parsed.method];
    let envelope: Record<string, unknown>;
    if (handler === undefined) {
      envelope = { jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: `no mock handler for ${parsed.method}` } };
    } else {
      try {
        envelope = { jsonrpc: "2.0", id: parsed.id, result: handler(parsed.params, path) };
      } catch (error) {
        const code = typeof (error as { code?: unknown } | undefined)?.code === "number" ? (error as { code: number }).code : -1;
        envelope = { jsonrpc: "2.0", id: parsed.id, error: { code, message: error instanceof Error ? error.message : String(error) } };
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const notFound = (): never => {
  throw Object.assign(new Error("No such mempool or blockchain transaction"), { code: -5 });
};

function baseHandlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    getblockchaininfo: () => ({ chain: "regtest", blocks: 200, time: 1_690_000_000, mediantime: 1_690_000_000 }),
    getblockhash: (params) => (params[0] === 0 ? BTC_REGTEST_PIN.genesisHash : `${"00".repeat(31)}ff`),
    getrawtransaction: (params) => (params[1] === true ? { confirmations: 0 } : FUNDING_HEX),
    testmempoolaccept: () => [{ txid: FUNDING_TXID, allowed: true }],
    sendrawtransaction: () => FUNDING_TXID,
    walletcreatefundedpsbt: () => ({ psbt: "cHNidP8A" }),
    walletprocesspsbt: () => ({ complete: true, hex: FUNDING_HEX }),
    ...overrides,
  };
}

async function connected(handlers: Handlers): Promise<{ rail: ConnectedCounterAssetRail; calls: RpcCallLog[]; mark: () => void; since: () => RpcCallLog[] }> {
  const { fetch: fetchImpl, calls } = mockBitcoind(handlers);
  const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: fetchImpl });
  const adapter = createBtcCounterRail({ config: railConfig(), rpc, wallet: "buyer", key: BUYER_KEY, destinationAddress: SCRIPT.address, clock: () => 1_690_000_000_000 });
  const rail = await adapter.connect(lockTerms(), ACCOUNTS);
  let marker = calls.length;
  return { rail, calls, mark: () => void (marker = calls.length), since: () => calls.slice(marker) };
}

const methods = (calls: readonly RpcCallLog[]): string[] => calls.map((c) => c.method);
const walletCalls = (calls: readonly RpcCallLog[]): string[] => methods(calls).filter((m) => m.startsWith("wallet"));
const PREPARED = { ref: REF, recovery: { chain: "btc", txid: FUNDING_TXID, rawTx: FUNDING_HEX } satisfies LockRecovery };

// -- prepareLock hands out the handle ----------------------------------------------------------------------------------

describe("Bitcoin prepareLock: the recovery handle", () => {
  it("returns the funding txid and exact signed bytes next to the ref, and broadcasts nothing", async () => {
    const { rail, calls } = await connected(baseHandlers());
    const prepared = await rail.prepareLock(lockTerms(), 0);
    expect(prepared).toEqual({ ref: REF, recovery: { chain: "btc", txid: FUNDING_TXID, rawTx: FUNDING_HEX } });
    expect(methods(calls)).not.toContain("testmempoolaccept");
    expect(methods(calls)).not.toContain("sendrawtransaction");
    // the persisted handle is JSON data and survives a JSON round trip unchanged
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
  });

  it("commitLock still broadcasts exactly the prepared bytes", async () => {
    const { rail, calls } = await connected(baseHandlers());
    await rail.prepareLock(lockTerms(), 0);
    await rail.commitLock();
    expect(calls.find((c) => c.method === "sendrawtransaction")?.params[0]).toBe(FUNDING_HEX);
  });
});

// -- recoverLock -------------------------------------------------------------------------------------------------------

describe("Bitcoin recoverLock", () => {
  it("a funding the node already knows (mempool) is landed, and nothing is sent or signed", async () => {
    const { rail, calls, mark } = await connected(baseHandlers({ getrawtransaction: () => ({ confirmations: 0 }) }));
    mark();
    await expect(rail.recoverLock(PREPARED)).resolves.toBe("landed");
    const after = calls.slice(-3).map((c) => c.method);
    expect(after).toContain("getrawtransaction");
    expect(methods(calls)).not.toContain("sendrawtransaction");
    expect(methods(calls)).not.toContain("testmempoolaccept");
    expect(walletCalls(calls)).toEqual([]);
  });

  it("a confirmed funding is landed", async () => {
    const { rail, calls } = await connected(baseHandlers({ getrawtransaction: () => ({ confirmations: 6, blockhash: "bb".repeat(32) }) }));
    await expect(rail.recoverLock(PREPARED)).resolves.toBe("landed");
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("an unknown funding is re-sent as the IDENTICAL persisted bytes (testmempoolaccept, then sendrawtransaction once), never re-prepared", async () => {
    const { rail, calls, mark, since } = await connected(baseHandlers({ getrawtransaction: notFound }));
    mark();
    await expect(rail.recoverLock(PREPARED)).resolves.toBe("landed");
    const seen = since();
    expect(seen.find((c) => c.method === "testmempoolaccept")?.params).toEqual([[FUNDING_HEX]]);
    const sends = seen.filter((c) => c.method === "sendrawtransaction");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.params).toEqual([FUNDING_HEX]);
    expect(walletCalls(calls)).toEqual([]); // no walletcreatefundedpsbt / walletprocesspsbt: no second funding is ever built
  });

  it.each(["txn-already-in-mempool", "txn-already-known"])("the node answering '%s' on the re-send means the first broadcast got there: landed, nothing sent twice", async (reason) => {
    const { rail, calls } = await connected(
      baseHandlers({ getrawtransaction: notFound, testmempoolaccept: () => [{ txid: FUNDING_TXID, allowed: false, "reject-reason": reason }] }),
    );
    await expect(rail.recoverLock(PREPARED)).resolves.toBe("landed");
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("inputs gone (the node refuses the persisted bytes): a typed error for a person, no send, and no new funding", async () => {
    const { rail, calls } = await connected(
      baseHandlers({ getrawtransaction: notFound, testmempoolaccept: () => [{ txid: FUNDING_TXID, allowed: false, "reject-reason": "missing-inputs" }] }),
    );
    const error = await rail.recoverLock(PREPARED).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("rebroadcast-refused");
    expect((error as RailRecoveryRefusedError).ref).toBe(REF);
    expect((error as Error).message).toMatch(/missing-inputs/);
    expect((error as Error).message).toMatch(/not re-prepared/);
    expect(methods(calls)).not.toContain("sendrawtransaction");
    expect(walletCalls(calls)).toEqual([]);
  });

  it("a conflicting spend of the same inputs is refused the same way", async () => {
    const { rail } = await connected(
      baseHandlers({ getrawtransaction: notFound, testmempoolaccept: () => [{ txid: FUNDING_TXID, allowed: false, "reject-reason": "txn-mempool-conflict" }] }),
    );
    await expect(rail.recoverLock(PREPARED)).rejects.toMatchObject({ code: "rebroadcast-refused" });
  });

  it("a transport failure while asking the node is NOT 'not broadcast': it propagates and nothing is re-sent", async () => {
    const { rail, calls } = await connected(
      baseHandlers({
        getrawtransaction: () => {
          throw new Error("connection reset"); // an un-coded failure, not Core's -5
        },
      }),
    );
    await expect(rail.recoverLock(PREPARED)).rejects.toThrow(/connection reset/);
    expect(methods(calls)).not.toContain("testmempoolaccept");
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("a failure of sendrawtransaction after an allowed testmempoolaccept propagates as it is (the outcome is unknown)", async () => {
    const { rail } = await connected(
      baseHandlers({
        getrawtransaction: notFound,
        sendrawtransaction: () => {
          throw new Error("reply lost");
        },
      }),
    );
    const error = await rail.recoverLock(PREPARED).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as Error).message).toMatch(/reply lost/);
  });

  it("refuses a PreparedLock with no handle, before asking the node anything", async () => {
    const { rail, calls, mark, since } = await connected(baseHandlers());
    mark();
    const error = await rail.recoverLock({ ref: REF }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "no-handle" });
    expect(since()).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("refuses a handle from another rail, a txid that is not the ref's, and bytes that do not hash to the txid", async () => {
    const { rail, mark, since } = await connected(baseHandlers());
    mark();
    const cases: Array<[string, { ref: string; recovery: LockRecovery }]> = [
      ["another rail", { ref: REF, recovery: { chain: "near", txHash: "x", signedTxBase64: "AAAA" } }],
      ["another txid", { ref: REF, recovery: { chain: "btc", txid: REFUND_TXID, rawTx: REFUND_HEX } }],
      ["tampered bytes", { ref: REF, recovery: { chain: "btc", txid: FUNDING_TXID, rawTx: REFUND_HEX } }],
      ["undecodable bytes", { ref: REF, recovery: { chain: "btc", txid: FUNDING_TXID, rawTx: "deadbeef" } }],
      ["uppercase hex", { ref: REF, recovery: { chain: "btc", txid: FUNDING_TXID, rawTx: FUNDING_HEX.toUpperCase() } }],
      ["a ref that is not an outpoint", { ref: HASH_LOCK, recovery: { chain: "btc", txid: FUNDING_TXID, rawTx: FUNDING_HEX } }],
    ];
    for (const [label, prepared] of cases) {
      const error = await rail.recoverLock(prepared).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(RailRecoveryRefusedError);
      expect((error as RailRecoveryRefusedError).code, label).toBe("handle-mismatch");
    }
    expect(since()).toEqual([]); // not one RPC call for any of them
  });
});

// -- the primitive under it --------------------------------------------------------------------------------------------

describe("BtcHtlcRail.rebroadcastFunding", () => {
  async function bare(handlers: Handlers): Promise<{ rail: BtcHtlcRail; calls: RpcCallLog[] }> {
    const { fetch: fetchImpl, calls } = mockBitcoind(handlers);
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: fetchImpl });
    return { rail: await BtcHtlcRail.connect({ config: railConfig(), rpc }), calls };
  }

  it("re-sends the recorded bytes and reports the node's txid with evidence of its own exchanges", async () => {
    const { rail, calls } = await bare(baseHandlers());
    const evidence = await rail.rebroadcastFunding(REF, FUNDING_HEX);
    expect(evidence.ref).toBe(REF);
    expect(evidence.txid).toBe(FUNDING_TXID);
    expect(evidence.raw.length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => c.method === "sendrawtransaction")).toHaveLength(1);
  });

  it("refuses bytes that do not hash to the ref's txid before any call (a swapped or truncated rawTx)", async () => {
    const { rail, calls } = await bare(baseHandlers());
    calls.length = 0;
    await expect(rail.rebroadcastFunding(REF, REFUND_HEX)).rejects.toThrow(/does not hash to the ref's txid/);
    await expect(rail.rebroadcastFunding(REF, "deadbeef")).rejects.toThrow(/does not decode/);
    await expect(rail.rebroadcastFunding("not-an-outpoint", FUNDING_HEX)).rejects.toThrow(/ref must look like/);
    expect(calls).toEqual([]);
  });

  it("a testmempoolaccept refusal is a BtcBroadcastRefusedError carrying Core's reason, and keeps the old message", async () => {
    const { rail } = await bare(baseHandlers({ testmempoolaccept: () => [{ txid: FUNDING_TXID, allowed: false, "reject-reason": "bad-txns-inputs-missingorspent" }] }));
    const error = await rail.rebroadcastFunding(REF, FUNDING_HEX).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BtcBroadcastRefusedError);
    expect((error as BtcBroadcastRefusedError).reason).toBe("bad-txns-inputs-missingorspent");
    expect((error as Error).message).toBe("btc-htlc: refusing to broadcast \u2014 testmempoolaccept rejected it (bad-txns-inputs-missingorspent)");
  });
});

// -- refund: record before send ----------------------------------------------------------------------------------------

describe("Bitcoin refund: onSigned / onNotBroadcast", () => {
  const refundHandlers = (overrides: Partial<Handlers> = {}): Handlers =>
    baseHandlers({
      walletprocesspsbt: () => ({ complete: true, hex: REFUND_HEX }),
      testmempoolaccept: () => [{ txid: REFUND_TXID, allowed: true }],
      sendrawtransaction: () => REFUND_TXID,
      ...overrides,
    });

  it("hands the refund's txid and exact bytes to onSigned BEFORE testmempoolaccept and sendrawtransaction", async () => {
    const { rail, calls } = await connected(refundHandlers());
    const events: string[] = [];
    const evidence = await rail.refund(REF, {
      onSigned: (recovery) => {
        events.push(`signed:${JSON.stringify(recovery)}`);
        events.push(`calls-so-far:${methods(calls).filter((m) => m === "testmempoolaccept" || m === "sendrawtransaction").length}`);
      },
    });
    expect(events).toEqual([`signed:${JSON.stringify({ chain: "btc", txid: REFUND_TXID, rawTx: REFUND_HEX })}`, "calls-so-far:0"]);
    expect(evidence.txid).toBe(REFUND_TXID);
    expect(evidence.rawTx).toBe(REFUND_HEX); // the evidence carries the same bytes the recorder was given
    expect(methods(calls).filter((m) => m === "sendrawtransaction")).toHaveLength(1);
  });

  it("an onSigned that fails (the store write failed) stops the refund before anything is sent", async () => {
    const { rail, calls } = await connected(refundHandlers());
    await expect(
      rail.refund(REF, {
        onSigned: () => {
          throw new Error("store write failed");
        },
      }),
    ).rejects.toThrow(/store write failed/);
    expect(methods(calls)).not.toContain("testmempoolaccept");
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("onNotBroadcast fires when testmempoolaccept refuses the transaction (it never reached the network), and the error still propagates", async () => {
    const { rail, calls } = await connected(refundHandlers({ testmempoolaccept: () => [{ txid: REFUND_TXID, allowed: false, "reject-reason": "non-final" }] }));
    const signed: LockRecovery[] = [];
    const dropped: LockRecovery[] = [];
    await expect(rail.refund(REF, { onSigned: (r) => void signed.push(r), onNotBroadcast: (r) => void dropped.push(r) })).rejects.toThrow(/non-final/);
    expect(dropped).toEqual(signed);
    expect(dropped).toHaveLength(1);
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("onNotBroadcast does NOT fire when the send itself failed after an allowed testmempoolaccept (the outcome is unknown)", async () => {
    const { rail } = await connected(
      refundHandlers({
        sendrawtransaction: () => {
          throw new Error("reply lost");
        },
      }),
    );
    const dropped: LockRecovery[] = [];
    await expect(rail.refund(REF, { onNotBroadcast: (r) => void dropped.push(r) })).rejects.toThrow(/reply lost/);
    expect(dropped).toEqual([]);
  });

  it("with no options the refund behaves exactly as before", async () => {
    const { rail } = await connected(refundHandlers());
    const evidence = await rail.refund(REF);
    expect(evidence.txid).toBe(REFUND_TXID);
  });
});

// -- recoverRefund -----------------------------------------------------------------------------------------------------

describe("Bitcoin recoverRefund", () => {
  const RECOVERY: LockRecovery = { chain: "btc", txid: REFUND_TXID, rawTx: REFUND_HEX };
  const recoverHandlers = (overrides: Partial<Handlers> = {}): Handlers =>
    baseHandlers({
      getmempoolentry: notFound,
      getrawtransaction: notFound,
      gettxout: () => ({ confirmations: 0, value: 1 }),
      testmempoolaccept: () => [{ txid: REFUND_TXID, allowed: true }],
      sendrawtransaction: () => REFUND_TXID,
      ...overrides,
    });

  it("a confirmed refund is landed; one still in the mempool is pending; nothing is sent either way", async () => {
    const confirmed = await connected(recoverHandlers({ getrawtransaction: () => ({ confirmations: 1, blockhash: "bb".repeat(32) }) }));
    await expect(confirmed.rail.recoverRefund?.(REF, RECOVERY)).resolves.toBe("landed");
    const pending = await connected(recoverHandlers({ getrawtransaction: () => ({ confirmations: 0 }) }));
    await expect(pending.rail.recoverRefund?.(REF, RECOVERY)).resolves.toBe("pending");
    expect(methods(confirmed.calls)).not.toContain("sendrawtransaction");
    expect(methods(pending.calls)).not.toContain("sendrawtransaction");
  });

  it("a refund that dropped out of the mempool while the funding is still unspent is re-sent as the IDENTICAL bytes (pending), not rebuilt", async () => {
    const { rail, calls } = await connected(recoverHandlers());
    await expect(rail.recoverRefund?.(REF, RECOVERY)).resolves.toBe("pending");
    const sends = calls.filter((c) => c.method === "sendrawtransaction");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.params).toEqual([REFUND_HEX]);
    expect(walletCalls(calls)).toEqual([]);
  });

  it("the funding output spent by something else (a claim) means this refund can no longer land: never-landed, nothing sent", async () => {
    const { rail, calls } = await connected(recoverHandlers({ gettxout: () => null }));
    await expect(rail.recoverRefund?.(REF, RECOVERY)).resolves.toBe("never-landed");
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("a refund that shows up between the two reads is not called dead", async () => {
    let lookups = 0;
    const { rail } = await connected(
      recoverHandlers({
        gettxout: () => null,
        getrawtransaction: () => {
          lookups += 1;
          // 1: recoverRefund's own look, 2: resendRefundIfDropped's look, 3: the final re-check finds it
          if (lookups < 3) return notFound();
          return { confirmations: 0 };
        },
      }),
    );
    await expect(rail.recoverRefund?.(REF, RECOVERY)).resolves.toBe("pending");
  });

  it("a transport failure propagates; a wrong or inconsistent handle is refused before any call", async () => {
    const failing = await connected(
      recoverHandlers({
        getrawtransaction: () => {
          throw new Error("connection reset");
        },
      }),
    );
    await expect(failing.rail.recoverRefund?.(REF, RECOVERY)).rejects.toThrow(/connection reset/);

    const { rail, mark, since } = await connected(recoverHandlers());
    mark();
    for (const bad of [
      { chain: "sol", signature: "s", blockhash: "b", lastValidBlockHeight: 1 } satisfies LockRecovery,
      { chain: "btc", txid: REFUND_TXID, rawTx: FUNDING_HEX } satisfies LockRecovery, // bytes of another transaction
    ]) {
      await expect(rail.recoverRefund?.(REF, bad)).rejects.toBeInstanceOf(RailRecoveryRefusedError);
    }
    expect(since()).toEqual([]);
  });
});
