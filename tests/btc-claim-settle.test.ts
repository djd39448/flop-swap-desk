// SPDX-License-Identifier: MIT
//
// tests/btc-claim-settle.test.ts: P10 B7 at the rail, against a mocked bitcoind JSON-RPC surface (the same pattern as tests/btc-htlc.test.ts): the pieces the Seller's
// "a claim is landed only once it is mined" rule is built from.
//
//   BtcHtlcRail.claim        record before send: `onSigned` hears of the claim's txid and exact bytes after signing, before the deadline read (which stays the last
//                            read) and before anything is sent; `onNotBroadcast` hears of a claim that provably never reached the network
//   BtcHtlcRail.claimStatus  READ-ONLY: mined (a confirmation), in the mempool (`getmempoolentry` knows it, P10-FUND-02), unknown (dropped or never sent, or only in a block of a
//                            stale branch, funding unspent) or spent by another transaction
//   BtcHtlcRail.resendClaim  the IDENTICAL bytes, never a rebuild: checked against the txid and the outpoint first, then "already held", "spent by another", the optional
//                            last-moment deadline, `testmempoolaccept`, send
//   BtcHtlcRail.claimMined   a MINED spend by the hash branch (the block scan without the mempool step)
//   the wrapper              the same through ConnectedBtcCounterRail (the recovery-handle checks, the typed refusal)
//
// The flow-level behaviour (next stays at the claim step, the reveal, the receipt only when mined, the re-send after the claim-by) is in
// tests/flow-claim-mined-btc.test.ts; the real node is tests-regtest/claim-mined.regtest.test.ts.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";

import { createBtcCounterRail } from "../src/client/btc-rail.js";
import { RailRecoveryRefusedError, type LockRecovery } from "../src/client/counter-rail.js";
import { BTC_REGTEST_NETWORK, buildHtlcScript } from "../src/rails/btc-script.js";
import { BTC_REGTEST_PIN, BtcBroadcastRefusedError, BtcHtlcRail, type BtcClaimOptions, type BtcHtlcTerms, type BtcWalletHandle } from "../src/rails/btc-htlc.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { btcSigner } from "./helpers/proven-lines.js";

// Nothing here is a literal key or secret: the pubkeys come from the helper that derives them from a small tag, the preimage and the funding txid from a label.
const PAYEE_PUBKEY = btcSigner(0x7b1).pubkey;
const PAYER_PUBKEY = btcSigner(0x7b2).pubkey;
const labelHash = (label: string): string => bytesToHex(sha256(new TextEncoder().encode(label)));
const PREIMAGE_HEX = labelHash("p10-b7 test preimage");
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
const REFUND_AFTER_MS = 1_700_000_000_000;
const FUND_TXID = labelHash("p10-b7 test funding transaction");
const FUND_VOUT = 1;
const REF = `${FUND_TXID}:${FUND_VOUT}`;
const TERMS: BtcHtlcTerms = { hashLock: HASH_LOCK, amountSats: "100000000", refundAfterMs: REFUND_AFTER_MS, payeePubkey: PAYEE_PUBKEY, payerPubkey: PAYER_PUBKEY };
const SELLER: BtcWalletHandle = { wallet: "seller", key: { pubkey: PAYEE_PUBKEY, fingerprint: 0xb222e7bb, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] } };
const SCRIPT = buildHtlcScript({ hashLock: hexToBytes(HASH_LOCK.slice(2)), payeePubkey: hexToBytes(PAYEE_PUBKEY), payerPubkey: hexToBytes(PAYER_PUBKEY), locktime: 1_700_000_000 }, BTC_REGTEST_NETWORK);
const DESTINATION = SCRIPT.address;
const NOT_AFTER_MS = 1_800_000_000_000;
const CHAIN_TIME_S = 1_690_000_000;

/** The funding transaction the claim spends (vout 1 is the HTLC output), as the mock node serves it. */
function fundingTxHex(): string {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
  tx.addInput({ txid: new Uint8Array(32), index: 0, witnessUtxo: { amount: 1n, script: new Uint8Array([0x00]) } });
  tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(0)]), amount: 1_000_000n });
  tx.addOutput({ script: SCRIPT.scriptPubKey, amount: 100_000_000n });
  return bytesToHex(tx.unsignedTx);
}

/** A transaction shaped like the Seller's claim: ONE input spending exactly the funding outpoint, one output. The mock wallet "signs" to this. */
function claimShapedTx(spend: { txid: string; index: number } = { txid: FUND_TXID, index: FUND_VOUT }, extraInput = false): { hex: string; id: string } {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
  tx.addInput({ txid: hexToBytes(spend.txid), index: spend.index, witnessUtxo: { amount: 100_000_000n, script: SCRIPT.scriptPubKey }, sequence: 0xfffffffe });
  if (extraInput) tx.addInput({ txid: new Uint8Array(32).fill(7), index: 0, witnessUtxo: { amount: 1n, script: new Uint8Array([0x00]) }, sequence: 0xfffffffe });
  tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(5)]), amount: 99_999_000n });
  return { hex: bytesToHex(tx.unsignedTx), id: tx.id };
}

const CLAIM = claimShapedTx();

interface Call {
  method: string;
  params: unknown[];
}

/** What the mock node knows about the claim and the funding output; a test turns the knobs. */
interface NodeState {
  /** `null`: the node does not know the claim's txid; a number: it knows it with that many confirmations (0 is the mempool). */
  claimConfirmations: number | null;
  /** Whether the funding output is unspent by anyone (the mempool included). */
  fundingUnspent: boolean;
  /** `testmempoolaccept`'s answer for the next send. */
  accept: { allowed: boolean; reason?: string };
  /** Core's answer for the claim's txid when it is not found: -5 by default (a transport-ish failure is another code). */
  notFoundCode: number;
  /** Blocks for the scan: each is the list of transactions' inputs (txid, vout, witness). */
  blocks: Array<Array<{ vin: Array<{ txid: string; vout: number; txinwitness?: string[] }> }>>;
  mempoolSpend: { txid: string; witness: string[] } | null;
  tipTimeSeconds: number;
  /**
   * P10-FUND-02: `getrawtransaction` answers the claim's txid with `confirmations: 0` and a `blockhash` (with `-txindex=1` Core does that for a transaction that sits in a block of a stale
   * branch) while `getmempoolentry` does not know it: the node holds the transaction nowhere. Needs `claimConfirmations: 0`.
   */
  staleBlock: boolean;
  /** Core's code for a failed `getmempoolentry` of a txid the mempool does not hold: -5 ("not in mempool") by default; any other code is a failure that must propagate. */
  mempoolEntryCode: number;
  /** Called when the node answers `gettxout` (a test uses it to let the claim reach the node between two of the rail's reads). */
  onGetTxOut?: () => void;
}

function freshState(): NodeState {
  return { claimConfirmations: null, fundingUnspent: true, accept: { allowed: true }, notFoundCode: -5, blocks: [], mempoolSpend: null, tipTimeSeconds: CHAIN_TIME_S, staleBlock: false, mempoolEntryCode: -5 };
}

function mockNode(state: NodeState, claimHex: string, claimId: string): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "getblockchaininfo":
        return { chain: "regtest", blocks: state.blocks.length === 0 ? 200 : 100 + state.blocks.length - 1, time: state.tipTimeSeconds, mediantime: state.tipTimeSeconds };
      case "getblockhash":
        return params[0] === 0 ? BTC_REGTEST_PIN.genesisHash : `${"00".repeat(31)}${Number(params[0]).toString(16).padStart(2, "0")}`;
      case "getrawtransaction": {
        if (params[0] === FUND_TXID) return params[1] === true ? { vout: [] } : fundingTxHex();
        if (params[0] !== claimId) throw Object.assign(new Error("No such mempool or blockchain transaction"), { code: -5 });
        if (state.claimConfirmations === null) throw Object.assign(new Error(state.notFoundCode === -5 ? "No such mempool or blockchain transaction" : "node trouble"), { code: state.notFoundCode });
        const vin = state.mempoolSpend === null ? {} : { vin: [{ txid: FUND_TXID, vout: FUND_VOUT, txinwitness: state.mempoolSpend.witness }] };
        return state.claimConfirmations >= 1 || state.staleBlock ? { txid: claimId, confirmations: state.claimConfirmations, blockhash: "cc".repeat(32), ...vin } : { txid: claimId, ...vin };
      }
      case "getmempoolentry": {
        if (params[0] === claimId && state.claimConfirmations === 0 && !state.staleBlock) return { vsize: 150, weight: 600, fees: { base: 0.00001 } };
        throw Object.assign(new Error(state.mempoolEntryCode === -5 ? "Transaction not in mempool" : "node trouble (mempool)"), { code: state.mempoolEntryCode });
      }
      case "gettxout":
        state.onGetTxOut?.();
        return state.fundingUnspent ? { bestblock: "dd".repeat(32), confirmations: 3, value: 1 } : null;
      case "walletprocesspsbt":
        return { complete: true, hex: claimHex };
      case "testmempoolaccept":
        return [{ txid: claimId, allowed: state.accept.allowed, ...(state.accept.reason === undefined ? {} : { "reject-reason": state.accept.reason }) }];
      case "sendrawtransaction":
        state.claimConfirmations = state.claimConfirmations ?? 0;
        return claimId;
      case "gettxspendingprevout": {
        const outpoints = params[0] as Array<{ txid: string; vout: number }>;
        return outpoints.map((o) => ({ txid: o.txid, vout: o.vout, ...(state.mempoolSpend === null ? {} : { spendingtxid: state.mempoolSpend.txid }) }));
      }
      case "getblock": {
        const index = Number.parseInt(String(params[0]).slice(-2), 16) - 100;
        return { tx: state.blocks[index] ?? [] };
      }
      default:
        throw new Error(`no mock handler for ${method}`);
    }
  };
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number | string; method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    let envelope: Record<string, unknown>;
    try {
      envelope = { jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params) };
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
      envelope = { jsonrpc: "2.0", id: body.id, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

async function connect(state: NodeState, claim: { hex: string; id: string } = CLAIM) {
  const node = mockNode(state, claim.hex, claim.id);
  const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: node.fetch });
  const rail = await BtcHtlcRail.connect({ config: { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:19000" }, rpc, clock: () => CHAIN_TIME_S * 1000 });
  node.calls.length = 0; // the connect-time reads are not under test
  return { rail, rpc, calls: node.calls, state };
}

const methods = (calls: readonly Call[]): string[] => calls.map((c) => c.method);
const sentTo = (calls: readonly Call[], method: string): unknown[][] => calls.filter((c) => c.method === method).map((c) => c.params);

describe("P10 B7: BtcHtlcRail.claim records before it sends", () => {
  it("onSigned hears of the claim's txid and exact bytes after the wallet signed and BEFORE the deadline read, which is still the last read before testmempoolaccept", async () => {
    const { rail, calls } = await connect(freshState());
    const heard: Array<{ txid: string; rawTx: string; callsSoFar: string[] }> = [];
    const options: BtcClaimOptions = { onSigned: (signed) => void heard.push({ ...signed, callsSoFar: methods(calls) }) };
    const evidence = await rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION, NOT_AFTER_MS, options);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.txid).toBe(CLAIM.id);
    expect(heard[0]?.rawTx).toBe(CLAIM.hex);
    expect(heard[0]?.callsSoFar.at(-1)).toBe("walletprocesspsbt"); // signed, nothing else yet
    expect(heard[0]?.callsSoFar).not.toContain("testmempoolaccept");
    expect(methods(calls).slice(heard[0]?.callsSoFar.length)).toEqual(["getblockchaininfo", "testmempoolaccept", "sendrawtransaction"]); // the deadline read, then acceptance, then the send
    expect(evidence.txid).toBe(CLAIM.id);
    expect(evidence.blockHash).toBeNull(); // accepted by the node, not mined
  });

  it("a recorder that refuses (a save that failed) stops the claim before the deadline read, the test of acceptance and the send", async () => {
    const { rail, calls } = await connect(freshState());
    const failure = new Error("save refused");
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION, NOT_AFTER_MS, { onSigned: () => Promise.reject(failure) })).rejects.toBe(failure);
    expect(methods(calls)).not.toContain("testmempoolaccept");
    expect(methods(calls)).not.toContain("sendrawtransaction");
    expect(methods(calls).slice(-1)).toEqual(["walletprocesspsbt"]);
  });

  it("a claim the deadline refuses is reported to onNotBroadcast (same pair) and never sent", async () => {
    const { rail, calls } = await connect(freshState());
    const heard: string[] = [];
    const options: BtcClaimOptions = { onSigned: (s) => void heard.push(`signed ${s.txid}`), onNotBroadcast: (s) => void heard.push(`not broadcast ${s.txid} ${s.rawTx === CLAIM.hex}`) };
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION, CHAIN_TIME_S * 1000 - 1, options)).rejects.toThrow(/at\/after the given deadline/);
    expect(heard).toEqual([`signed ${CLAIM.id}`, `not broadcast ${CLAIM.id} true`]);
    expect(methods(calls)).not.toContain("testmempoolaccept");
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("a claim testmempoolaccept refuses is reported to onNotBroadcast and never sent; an accepted one is not", async () => {
    const state = freshState();
    state.accept = { allowed: false, reason: "mempool-script-verify-flag-failed" };
    const refused = await connect(state);
    const heard: string[] = [];
    const options: BtcClaimOptions = { onSigned: () => void heard.push("signed"), onNotBroadcast: () => void heard.push("not broadcast") };
    await expect(refused.rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION, NOT_AFTER_MS, options)).rejects.toBeInstanceOf(BtcBroadcastRefusedError);
    expect(heard).toEqual(["signed", "not broadcast"]);
    expect(methods(refused.calls)).not.toContain("sendrawtransaction");

    const accepted = await connect(freshState());
    const heardOk: string[] = [];
    await accepted.rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION, NOT_AFTER_MS, { onSigned: () => void heardOk.push("signed"), onNotBroadcast: () => void heardOk.push("not broadcast") });
    expect(heardOk).toEqual(["signed"]);
  });

  it("without a recorder nothing changes: the golden sequence of calls is the one before this change", async () => {
    const { rail, calls } = await connect(freshState());
    await rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION, NOT_AFTER_MS);
    expect(methods(calls)).toEqual(["getblockchaininfo", "getblockhash", "getrawtransaction", "walletprocesspsbt", "getblockchaininfo", "testmempoolaccept", "sendrawtransaction"]);
  });
});

describe("P10 B7: BtcHtlcRail.claimStatus (READ-ONLY)", () => {
  it.each([
    ["in the mempool", { claimConfirmations: 0 }, "in-mempool"],
    ["mined (one confirmation)", { claimConfirmations: 1 }, "mined"],
    ["mined (many)", { claimConfirmations: 9 }, "mined"],
    ["unknown to the node, funding unspent", { claimConfirmations: null, fundingUnspent: true }, "unknown"],
    ["unknown to the node, funding spent by another transaction", { claimConfirmations: null, fundingUnspent: false }, "spent-by-other"],
    // P10-FUND-02: `getrawtransaction` alone said "in the mempool" for a transaction that only a block of a stale branch holds
    ["in a block of a stale branch (confirmations 0 and a blockhash), not in the mempool, funding unspent", { claimConfirmations: 0, staleBlock: true, fundingUnspent: true }, "unknown"],
    ["in a block of a stale branch, funding spent by another transaction", { claimConfirmations: 0, staleBlock: true, fundingUnspent: false }, "spent-by-other"],
  ] as const)("%s", async (_label, patch, expected) => {
    const state = { ...freshState(), ...patch };
    const { rail, calls } = await connect(state);
    expect(await rail.claimStatus(REF, CLAIM.id)).toBe(expected);
    for (const sending of ["sendrawtransaction", "testmempoolaccept", "walletprocesspsbt", "walletcreatefundedpsbt"]) expect(methods(calls), sending).not.toContain(sending);
  });

  it("P10-FUND-02: the mempool is asked only about a transaction the node knows without a confirmation; a mined claim never reaches that read", async () => {
    const mined = await connect({ ...freshState(), claimConfirmations: 3 });
    expect(await mined.rail.claimStatus(REF, CLAIM.id)).toBe("mined");
    expect(methods(mined.calls)).not.toContain("getmempoolentry");
    const held = await connect({ ...freshState(), claimConfirmations: 0 });
    expect(await held.rail.claimStatus(REF, CLAIM.id)).toBe("in-mempool");
    expect(sentTo(held.calls, "getmempoolentry")).toEqual([[CLAIM.id]]);
    const unknown = await connect(freshState());
    expect(await unknown.rail.claimStatus(REF, CLAIM.id)).toBe("unknown");
    expect(methods(unknown.calls)).not.toContain("getmempoolentry"); // getrawtransaction said not found: there is nothing to ask the mempool
  });

  it("P10-FUND-02: a getmempoolentry failure that is not Core's own 'not in mempool' answer propagates: it is never read as 'unknown' (nor as 'in the mempool')", async () => {
    const { rail } = await connect({ ...freshState(), claimConfirmations: 0, staleBlock: true, mempoolEntryCode: -32603 });
    await expect(rail.claimStatus(REF, CLAIM.id)).rejects.toThrow(/node trouble \(mempool\)/);
  });

  it("a claim that reaches the node between the two reads is never called superseded", async () => {
    const state = freshState();
    state.fundingUnspent = false;
    state.onGetTxOut = () => {
      state.claimConfirmations = 0; // unknown on the first read, in the mempool by the second
    };
    const { rail } = await connect(state);
    expect(await rail.claimStatus(REF, CLAIM.id)).toBe("in-mempool");
  });

  it("a failure that is not Core's own 'not found' answer propagates: it is never read as 'unknown'", async () => {
    const state = freshState();
    state.notFoundCode = -32603;
    const { rail } = await connect(state);
    await expect(rail.claimStatus(REF, CLAIM.id)).rejects.toThrow(/node trouble/);
  });

  it("refuses a ref that is not an outpoint before any call", async () => {
    const { rail, calls } = await connect(freshState());
    await expect(rail.claimStatus("not-an-outpoint", CLAIM.id)).rejects.toThrow(/ref must look like/);
    expect(calls).toHaveLength(0);
  });
});

describe("P10 B7: BtcHtlcRail.resendClaim sends the IDENTICAL recorded bytes, and nothing else", () => {
  it("a claim the node dropped, with the funding unspent: testmempoolaccept and sendrawtransaction carry exactly the recorded bytes; nothing is built or signed", async () => {
    const state = freshState();
    const { rail, calls } = await connect(state);
    const resent = await rail.resendClaim(REF, CLAIM.id, CLAIM.hex);
    expect(resent.outcome).toBe("in-mempool");
    expect(resent.txid).toBe(CLAIM.id);
    expect(sentTo(calls, "testmempoolaccept")).toEqual([[[CLAIM.hex]]]);
    expect(sentTo(calls, "sendrawtransaction")).toEqual([[CLAIM.hex]]);
    for (const wallet of ["walletprocesspsbt", "walletcreatefundedpsbt", "estimatesmartfee"]) expect(methods(calls), wallet).not.toContain(wallet);
  });

  it("a claim the node already holds is not sent again: in the mempool, or mined", async () => {
    for (const [confirmations, outcome] of [
      [0, "in-mempool"],
      [2, "mined"],
    ] as const) {
      const state = { ...freshState(), claimConfirmations: confirmations };
      const { rail, calls } = await connect(state);
      expect((await rail.resendClaim(REF, CLAIM.id, CLAIM.hex)).outcome).toBe(outcome);
      expect(methods(calls)).not.toContain("sendrawtransaction");
      expect(methods(calls)).not.toContain("testmempoolaccept");
    }
  });

  it("P10-FUND-02: a claim that only a block of a stale branch holds (confirmations 0 and a blockhash, not in the mempool) is sent again while the funding output is unspent: the recorded bytes, nothing signed", async () => {
    const { rail, calls } = await connect({ ...freshState(), claimConfirmations: 0, staleBlock: true });
    const resent = await rail.resendClaim(REF, CLAIM.id, CLAIM.hex);
    expect(resent.outcome).toBe("in-mempool");
    expect(sentTo(calls, "testmempoolaccept")).toEqual([[[CLAIM.hex]]]);
    expect(sentTo(calls, "sendrawtransaction")).toEqual([[CLAIM.hex]]);
    for (const wallet of ["walletprocesspsbt", "walletcreatefundedpsbt", "estimatesmartfee"]) expect(methods(calls), wallet).not.toContain(wallet);
    // and with the funding output spent by another transaction it is still not sent
    const spent = await connect({ ...freshState(), claimConfirmations: 0, staleBlock: true, fundingUnspent: false });
    expect((await spent.rail.resendClaim(REF, CLAIM.id, CLAIM.hex)).outcome).toBe("spent-by-other");
    expect(methods(spent.calls)).not.toContain("sendrawtransaction");
  });

  it("a funding output spent by another transaction is NOT re-sent: spent-by-other, nothing tested, nothing sent", async () => {
    const state = { ...freshState(), fundingUnspent: false };
    const { rail, calls } = await connect(state);
    expect((await rail.resendClaim(REF, CLAIM.id, CLAIM.hex)).outcome).toBe("spent-by-other");
    expect(methods(calls)).not.toContain("testmempoolaccept");
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("without a deadline it is sent at any chain time (the secret is public already); with notAfterMs it is the last read before the send, and a chain past it refuses and sends nothing", async () => {
    const late = { ...freshState(), tipTimeSeconds: 1_900_000_000 }; // far past every deadline of the swap
    const unbounded = await connect(late);
    expect((await unbounded.rail.resendClaim(REF, CLAIM.id, CLAIM.hex)).outcome).toBe("in-mempool");

    const bounded = await connect({ ...freshState(), tipTimeSeconds: 1_900_000_000 });
    await expect(bounded.rail.resendClaim(REF, CLAIM.id, CLAIM.hex, { notAfterMs: 1_800_000_000_000 })).rejects.toThrow(/at\/after the given deadline/);
    expect(methods(bounded.calls)).not.toContain("testmempoolaccept");
    expect(methods(bounded.calls)).not.toContain("sendrawtransaction");

    const inside = await connect(freshState());
    await inside.rail.resendClaim(REF, CLAIM.id, CLAIM.hex, { notAfterMs: NOT_AFTER_MS });
    const order = methods(inside.calls);
    expect(order.lastIndexOf("getblockchaininfo")).toBeLessThan(order.indexOf("testmempoolaccept")); // the deadline read comes right before the acceptance test
    expect(order.slice(-2)).toEqual(["testmempoolaccept", "sendrawtransaction"]);
  });

  it("refuses bytes that are not the recorded claim before any call: another txid, bytes that do not decode, a transaction that spends another outpoint or two inputs", async () => {
    const { rail, calls } = await connect(freshState());
    await expect(rail.resendClaim(REF, "ee".repeat(32), CLAIM.hex)).rejects.toThrow(/does not hash to the recorded txid/);
    await expect(rail.resendClaim(REF, CLAIM.id, "zz")).rejects.toThrow(/does not decode/);
    const other = claimShapedTx({ txid: "11".repeat(32), index: 0 });
    await expect(rail.resendClaim(REF, other.id, other.hex)).rejects.toThrow(/does not spend exactly the funding output/);
    const sameOutpointWrongVout = claimShapedTx({ txid: FUND_TXID, index: 0 });
    await expect(rail.resendClaim(REF, sameOutpointWrongVout.id, sameOutpointWrongVout.hex)).rejects.toThrow(/does not spend exactly the funding output/);
    const twoInputs = claimShapedTx({ txid: FUND_TXID, index: FUND_VOUT }, true);
    await expect(rail.resendClaim(REF, twoInputs.id, twoInputs.hex)).rejects.toThrow(/does not spend exactly the funding output/);
    expect(calls).toHaveLength(0);
  });

  it("a node that refuses the bytes (inputs gone, a minimum fee that has risen) is BtcBroadcastRefusedError, never re-priced; 'already in mempool' counts as success", async () => {
    const refusing = freshState();
    refusing.accept = { allowed: false, reason: "min relay fee not met" };
    const a = await connect(refusing);
    const error = await a.rail.resendClaim(REF, CLAIM.id, CLAIM.hex).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BtcBroadcastRefusedError);
    expect((error as BtcBroadcastRefusedError).reason).toBe("min relay fee not met");
    expect(methods(a.calls)).not.toContain("sendrawtransaction");
    expect(methods(a.calls)).not.toContain("walletprocesspsbt");

    const known = freshState();
    known.accept = { allowed: false, reason: "txn-already-in-mempool" };
    const b = await connect(known);
    expect((await b.rail.resendClaim(REF, CLAIM.id, CLAIM.hex)).outcome).toBe("in-mempool");
  });
});

describe("P10 B7: BtcHtlcRail.claimMined is a MINED spend by the hash branch, never the mempool", () => {
  const spend = (witness: string[]) => ({ vin: [{ txid: FUND_TXID, vout: FUND_VOUT, txinwitness: witness }] });
  const claimWitness = [PREIMAGE_HEX, "30".repeat(36), bytesToHex(SCRIPT.witnessScript)];
  const refundWitness = ["30".repeat(36), "", bytesToHex(SCRIPT.witnessScript)];

  it("true for a mined claim", async () => {
    const state = { ...freshState(), blocks: [[], [spend(claimWitness)]] };
    const { rail } = await connect(state);
    expect(await rail.claimMined(REF, HASH_LOCK, 100)).toBe(true);
  });

  it("false for a claim that is only in the mempool (the mempool is not consulted), and for no spend at all", async () => {
    const state = { ...freshState(), mempoolSpend: { txid: CLAIM.id, witness: claimWitness }, blocks: [[], []] };
    const { rail, calls } = await connect(state);
    expect(await rail.claimMined(REF, HASH_LOCK, 100)).toBe(false);
    expect(methods(calls)).not.toContain("gettxspendingprevout");
    const none = await connect({ ...freshState(), blocks: [[], []] });
    expect(await none.rail.claimMined(REF, HASH_LOCK, 100)).toBe(false);
  });

  it("false for a mined refund (the timelock branch opens no hash), and a spend below the start height is not seen", async () => {
    const refunded = await connect({ ...freshState(), blocks: [[spend(refundWitness)]] });
    expect(await refunded.rail.claimMined(REF, HASH_LOCK, 100)).toBe(false);
    const below = await connect({ ...freshState(), blocks: [[spend(claimWitness)], [], []] });
    expect(await below.rail.claimMined(REF, HASH_LOCK, 101)).toBe(false); // the claim is in block 100; the scan starts at 101
    expect(await below.rail.claimMined(REF, HASH_LOCK, 100)).toBe(true);
  });

  it("findClaimPreimage is unchanged: the Buyer still learns the secret from the mempool, and from a block", async () => {
    const pending = await connect({ ...freshState(), claimConfirmations: 0, mempoolSpend: { txid: CLAIM.id, witness: claimWitness } });
    expect(await pending.rail.findClaimPreimage(REF, HASH_LOCK, 100)).toBe(`0x${PREIMAGE_HEX}`); // the mempool step (K1)
    expect(methods(pending.calls)).toContain("gettxspendingprevout");
    const mined = await connect({ ...freshState(), blocks: [[spend(claimWitness)]] });
    expect(await mined.rail.findClaimPreimage(REF, HASH_LOCK, 100)).toBe(`0x${PREIMAGE_HEX}`);
    const refunded = await connect({ ...freshState(), blocks: [[spend(refundWitness)]] });
    expect(await refunded.rail.findClaimPreimage(REF, HASH_LOCK, 100)).toBeNull();
  });
});

describe("P10 B7: the same through the wrapper (ConnectedBtcCounterRail)", () => {
  const key = { pubkey: PAYEE_PUBKEY, fingerprint: 0xb222e7bb, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] };
  const terms = { lock: "hash", statement: HASH_LOCK, amount: "100000000", refundAfterMs: REFUND_AFTER_MS, claimByMs: REFUND_AFTER_MS - 3_600_000, payer: "did:key:payer", payee: "did:key:payee", asset: "BTC", contract: `0x${"cc".repeat(32)}` };

  async function wrapped(state: NodeState) {
    const node = mockNode(state, CLAIM.hex, CLAIM.id);
    const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: node.fetch });
    const rail = createBtcCounterRail({ config: { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:19000" }, rpc, wallet: "seller", key, destinationAddress: DESTINATION, clock: () => CHAIN_TIME_S * 1000 });
    const connected = await rail.connect(terms as never, { payee: PAYEE_PUBKEY, payer: PAYER_PUBKEY });
    node.calls.length = 0;
    return { connected, calls: node.calls, state };
  }
  const handle = (over: Partial<{ chain: string; txid: string; rawTx: string }> = {}): LockRecovery => ({ chain: "btc", txid: CLAIM.id, rawTx: CLAIM.hex, ...over }) as LockRecovery;

  it("claim passes the recorder through as btc recovery handles; status, re-send and mined answer as the rail does", async () => {
    const { connected, calls, state } = await wrapped(freshState());
    const heard: LockRecovery[] = [];
    const evidence = await connected.claim(REF, `0x${PREIMAGE_HEX}`, NOT_AFTER_MS, { onSignedTx: (h) => void heard.push(h) });
    expect(heard).toEqual([{ chain: "btc", txid: CLAIM.id, rawTx: CLAIM.hex }]);
    expect(evidence.txid).toBe(CLAIM.id);
    expect(await connected.claimTxStatus?.(REF, handle())).toBe("in-mempool"); // the mock node took the send
    state.claimConfirmations = 1;
    expect(await connected.claimTxStatus?.(REF, handle())).toBe("mined");
    state.claimConfirmations = null;
    expect(await connected.claimTxStatus?.(REF, handle())).toBe("unknown");
    calls.length = 0;
    expect(await connected.resendClaimTx?.(REF, handle())).toBe("in-mempool");
    expect(sentTo(calls, "sendrawtransaction")).toEqual([[CLAIM.hex]]);
  });

  it("refuses a handle that is for another rail, malformed, or not this claim's bytes: RailRecoveryRefusedError(handle-mismatch), before any send", async () => {
    const { connected, calls } = await wrapped(freshState());
    const bad: LockRecovery[] = [
      { chain: "near", txHash: "x", signedTxBase64: "AA==" },
      handle({ txid: "NOT-HEX" }),
      handle({ rawTx: "zz" }),
      handle({ txid: "ee".repeat(32) }), // the bytes do not hash to the txid
    ];
    for (const recovery of bad) {
      for (const run of [() => connected.claimTxStatus?.(REF, recovery), () => connected.resendClaimTx?.(REF, recovery)]) {
        const error = await Promise.resolve(run()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RailRecoveryRefusedError);
        expect((error as RailRecoveryRefusedError).code).toBe("handle-mismatch");
      }
    }
    expect(methods(calls)).not.toContain("sendrawtransaction");
  });

  it("a node that refuses the bytes is RailRecoveryRefusedError(rebroadcast-refused) naming the txid, never a new claim", async () => {
    const state = freshState();
    state.accept = { allowed: false, reason: "bad-txns-inputs-missingorspent" };
    const { connected } = await wrapped(state);
    const error = await Promise.resolve(connected.resendClaimTx?.(REF, handle())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailRecoveryRefusedError);
    expect((error as RailRecoveryRefusedError).code).toBe("rebroadcast-refused");
    expect((error as RailRecoveryRefusedError).message).toContain(CLAIM.id);
    expect((error as RailRecoveryRefusedError).message).toContain("not re-signed and not re-priced");
  });

  it("P10-FUND-02: the wrapper reads a claim that only a stale branch's block holds as unknown, and its re-send sends the recorded bytes", async () => {
    const { connected, calls } = await wrapped({ ...freshState(), claimConfirmations: 0, staleBlock: true });
    expect(await connected.claimTxStatus?.(REF, handle())).toBe("unknown");
    expect(await connected.resendClaimTx?.(REF, handle())).toBe("in-mempool");
    expect(sentTo(calls, "sendrawtransaction")).toEqual([[CLAIM.hex]]);
  });

  it("claimIsMined reads the block scan from the marker (a number), 0 when there is none", async () => {
    const claimWitness = [PREIMAGE_HEX, "30".repeat(36), bytesToHex(SCRIPT.witnessScript)];
    const state = { ...freshState(), blocks: [[], [{ vin: [{ txid: FUND_TXID, vout: FUND_VOUT, txinwitness: claimWitness }] }]] };
    const { connected } = await wrapped(state);
    expect(await connected.claimIsMined?.(REF, 100)).toBe(true);
    expect(await connected.claimIsMined?.(REF, 102)).toBe(false);
  });
});
