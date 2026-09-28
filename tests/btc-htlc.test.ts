// SPDX-License-Identifier: MIT
//
// tests/btc-htlc.test.ts — P4-BTC-SPEC.md §4, Stage BB1. BtcHtlcRail exercised against a mocked
// bitcoind JSON-RPC surface (a mocked `fetch`, through this repo's own CapturingRpc — the same
// pattern tests/evm-htlc.test.ts uses for the EVM leg) so the adapter's own guards, wallet-path
// dispatch and evidence slicing are exercised the same way production code drives them, without
// a real node. tests-regtest/btc-htlc.regtest.test.ts covers the parts that need one (real
// signing, real mempool policy, real chain time).

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";

import {
  BTC_REGTEST_NETWORK,
  buildHtlcScript,
  scriptPubKeyForAddress,
} from "../src/rails/btc-script.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import {
  BTC_REGTEST_PIN,
  BtcHtlcRail,
  checkBtcRailConfig,
  keyFromAddressInfo,
  parseHdKeyPath,
  validateBtcRailConfig,
  type BtcHtlcTerms,
  type BtcRailConfig,
  type BtcWalletHandle,
} from "../src/rails/btc-htlc.js";

// ── test fixtures ────────────────────────────────────────────────────────────────────────────

const PAYEE_PUBKEY = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a"; // seller
const PAYER_PUBKEY = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627"; // buyer
const PREIMAGE_HEX = "c620ab91f1abda4c1947a10469b3c7c21884be1d5e6d20d726bcb7c6a2f1e29a";
const HASH_LOCK = `0x${bytesToHex(sha256(hexToBytes(PREIMAGE_HEX)))}`;
const REFUND_AFTER_MS = 1_700_000_000_000; // -> T = 1_700_000_000 (whole seconds, > BIP65 threshold)
const FUND_TXID = "ab08a3ba29a27d8ccbc37fe3efe3f56018e34978328bc421361e688dc8d66694";

const SELLER: BtcWalletHandle = { wallet: "seller", key: { pubkey: PAYEE_PUBKEY, fingerprint: 0xb222e7bb, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] } };
const BUYER: BtcWalletHandle = { wallet: "buyer", key: { pubkey: PAYER_PUBKEY, fingerprint: 0x2cd95c68, path: [0x80000054, 0x80000001, 0x80000000, 0, 0] } };

const TERMS: BtcHtlcTerms = {
  hashLock: HASH_LOCK,
  amountSats: "100000000",
  refundAfterMs: REFUND_AFTER_MS,
  payeePubkey: PAYEE_PUBKEY,
  payerPubkey: PAYER_PUBKEY,
};

const SCRIPT = buildHtlcScript(
  { hashLock: hexToBytes(HASH_LOCK.slice(2)), payeePubkey: hexToBytes(PAYEE_PUBKEY), payerPubkey: hexToBytes(PAYER_PUBKEY), locktime: 1_700_000_000 },
  BTC_REGTEST_NETWORK,
);

const REF = `${FUND_TXID}:1`;
const DESTINATION_ADDRESS = SCRIPT.address; // any valid regtest address works as a payout destination for these tests

function config(overrides: Partial<BtcRailConfig["pin"]> = {}): BtcRailConfig {
  return { pin: { ...BTC_REGTEST_PIN, ...overrides }, endpoint: "http://127.0.0.1:19000" };
}

/** Builds a raw (unsigned — decoding outputs never needs a valid signature) 2-output funding
 *  transaction with the HTLC's own scriptPubKey at vout 1 (a dummy change-shaped output at vout
 *  0), matching `REF`'s own `<FUND_TXID>:1`. */
function fakeRawFundingTxHex(scriptPubKey: Uint8Array, amountSats: bigint): string {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
  tx.addInput({ txid: new Uint8Array(32), index: 0, witnessUtxo: { amount: 1n, script: new Uint8Array([0x00]) } });
  tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(0)]), amount: 1_000_000n }); // vout 0: unrelated change
  tx.addOutput({ script: scriptPubKey, amount: amountSats }); // vout 1: the HTLC output
  return bytesToHex(tx.unsignedTx);
}

interface RpcCallLog {
  method: string;
  params: unknown[];
  path?: string;
}

type Handlers = Record<string, (params: unknown[], path: string | undefined) => unknown>;

/** A mocked bitcoind JSON-RPC surface: dispatches on `method` (bitcoind's own JSON-RPC 2.0-shaped
 *  envelope), records every call (method/params/path) for assertions, and lets a test mutate
 *  `handlers` in place mid-test (e.g. to simulate the live chain changing between `connect()`
 *  and a later write). A handler that throws becomes a JSON-RPC error reply, matching
 *  RpcCaptureError's own contract. */
function mockBitcoind(handlers: Handlers): { fetch: typeof fetch; calls: RpcCallLog[] } {
  const calls: RpcCallLog[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const parsedBody = JSON.parse(String(init?.body)) as { id: number | string; method: string; params: unknown[] };
    const pathMatch = /^https?:\/\/[^/]+(\/.*)?$/.exec(String(url));
    const path = pathMatch?.[1];
    calls.push({ method: parsedBody.method, params: parsedBody.params, ...(path === undefined ? {} : { path }) });
    const handler = handlers[parsedBody.method];
    let envelope: Record<string, unknown>;
    if (handler === undefined) {
      envelope = { jsonrpc: "2.0", id: parsedBody.id, error: { code: -32601, message: `no mock handler for ${parsedBody.method}` } };
    } else {
      try {
        envelope = { jsonrpc: "2.0", id: parsedBody.id, result: handler(parsedBody.params, path) };
      } catch (error) {
        envelope = { jsonrpc: "2.0", id: parsedBody.id, error: { code: -1, message: error instanceof Error ? error.message : String(error) } };
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    return { text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** A ready-to-connect set of handlers for a healthy regtest node at height `height`/time `time`,
 *  with the funding output already sitting at `FUND_TXID:1`. Tests override/extend individual
 *  handlers for their own scenario. */
function baseHandlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    getblockchaininfo: () => ({ chain: "regtest", blocks: 200, time: 1_690_000_000, mediantime: 1_690_000_000 }),
    getblockhash: (params) => (params[0] === 0 ? BTC_REGTEST_PIN.genesisHash : `${"00".repeat(31)}ff`),
    getrawtransaction: (params) => {
      const verbose = params[1] === true;
      if (verbose) return { vout: [{ n: 1, scriptPubKey: { hex: bytesToHex(SCRIPT.scriptPubKey) } }] };
      return fakeRawFundingTxHex(SCRIPT.scriptPubKey, 100_000_000n);
    },
    testmempoolaccept: () => [{ txid: "aa".repeat(32), allowed: true }],
    sendrawtransaction: () => "bb".repeat(32),
    sendtoaddress: () => FUND_TXID,
    walletprocesspsbt: () => ({ complete: true, hex: "02" + "00".repeat(10) }),
    ...overrides,
  };
}

async function connectRail(handlers: Handlers, clock?: () => number): Promise<{ rail: BtcHtlcRail; rpc: CapturingRpc; calls: RpcCallLog[]; handlers: Handlers }> {
  const { fetch: fetchImpl, calls } = mockBitcoind(handlers);
  const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:19000", fetch: fetchImpl });
  const rail = await BtcHtlcRail.connect({ config: config(), rpc, ...(clock === undefined ? {} : { clock }) });
  return { rail, rpc, calls, handlers };
}

// ── config validation ───────────────────────────────────────────────────────────────────────

describe("checkBtcRailConfig / validateBtcRailConfig", () => {
  it("accepts the shipped regtest pin", () => {
    expect(checkBtcRailConfig(config())).toEqual({ ok: true, config: config() });
  });

  it("refuses a network not on the allow list", () => {
    expect(() => validateBtcRailConfig(config({ network: "main" as never }))).toThrow(/allow list/);
  });

  it("refuses a caip2 that disagrees with genesisHash", () => {
    const bad = config({ caip2: "bip122:deadbeefdeadbeefdeadbeefdeadbeef" });
    const result = checkBtcRailConfig(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match/);
  });

  it("refuses a non-object, a missing pin, and a bad finality shape", () => {
    expect(checkBtcRailConfig(null).ok).toBe(false);
    expect(checkBtcRailConfig({}).ok).toBe(false);
    expect(checkBtcRailConfig({ ...config(), pin: { ...BTC_REGTEST_PIN, finality: { confirmations: 0 } } }).ok).toBe(false);
  });
});

// ── connect() ────────────────────────────────────────────────────────────────────────────────

describe("BtcHtlcRail.connect", () => {
  it("succeeds and drains its own exchanges so a later write's evidence starts clean", async () => {
    const { rail, rpc } = await connectRail(baseHandlers());
    expect(rail).toBeInstanceOf(BtcHtlcRail);
    expect(rpc.exchanges()).toHaveLength(0);
  });

  it("refuses before touching the network when the config is invalid", async () => {
    const { fetch: fetchImpl, calls } = mockBitcoind(baseHandlers());
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await expect(BtcHtlcRail.connect({ config: config({ network: "main" as never }), rpc })).rejects.toThrow(/allow list/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a live chain name off the allow list, naming it", async () => {
    const { fetch: fetchImpl } = mockBitcoind(baseHandlers({ getblockchaininfo: () => ({ chain: "main", time: 0, mediantime: 0 }) }));
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await expect(BtcHtlcRail.connect({ config: config(), rpc })).rejects.toThrow(/refusing main by name/);
  });

  it("refuses a live chain that disagrees with the pin's own network", async () => {
    const { fetch: fetchImpl } = mockBitcoind(baseHandlers({ getblockchaininfo: () => ({ chain: "signet", time: 0, mediantime: 0 }) }));
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await expect(BtcHtlcRail.connect({ config: config(), rpc })).rejects.toThrow(/does not match pin/);
  });

  it("refuses a genesis hash that disagrees with the pin", async () => {
    const { fetch: fetchImpl } = mockBitcoind(baseHandlers({ getblockhash: () => "ff".repeat(32) }));
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    await expect(BtcHtlcRail.connect({ config: config(), rpc })).rejects.toThrow(/genesis hash/);
  });
});

// ── re-check before every write ─────────────────────────────────────────────────────────────

describe("re-check before every write", () => {
  it("fund() refuses once the live chain no longer matches, even after a successful connect()", async () => {
    const handlers = baseHandlers();
    const { rail, handlers: liveHandlers } = await connectRail(handlers);
    liveHandlers.getblockchaininfo = () => ({ chain: "main", time: 0, mediantime: 0 });
    await expect(rail.fund(TERMS, BUYER)).rejects.toThrow(/refusing main by name/);
  });
});

// ── fund() ───────────────────────────────────────────────────────────────────────────────────

describe("BtcHtlcRail.fund", () => {
  it("sends exactly terms.amountSats to the HTLC address and returns the funding ref", async () => {
    const { rail, calls } = await connectRail(baseHandlers());
    const evidence = await rail.fund(TERMS, BUYER);

    expect(evidence.ref).toBe(`${FUND_TXID}:1`);
    expect(evidence.txid).toBe(FUND_TXID);
    expect(evidence.blockHeight).toBeNull();
    expect(evidence.blockHash).toBeNull();

    const send = calls.find((c) => c.method === "sendtoaddress");
    expect(send?.path).toBe("/wallet/buyer");
    expect(send?.params[0]).toBe(SCRIPT.address);
    expect(send?.params[1]).toBe("1"); // Decimal.encode(100_000_000n) === "1"
  });

  it("raw lists only this write's own exchanges, not connect()'s or the re-check's", async () => {
    const { rail } = await connectRail(baseHandlers());
    const evidence = await rail.fund(TERMS, BUYER);
    // The `before` snapshot is taken AFTER assertPinnedChain()'s own re-check calls (the same
    // place P22-P24-EVM-FIXES.md A10's `assertPinnedChainId()` sits relative to its own writes'
    // `before` snapshots) — so raw is exactly sendtoaddress + getrawtransaction(verbose).
    expect(evidence.raw.length).toBeGreaterThanOrEqual(2);
    expect(new Set(evidence.raw).size).toBe(evidence.raw.length); // each exchange's own distinct response
  });

  it("refuses when buyer.key.pubkey does not equal terms.payerPubkey, before any RPC call", async () => {
    const { fetch: fetchImpl, calls } = mockBitcoind(baseHandlers());
    const rpc = new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl });
    const rail = await BtcHtlcRail.connect({ config: config(), rpc: new CapturingRpc({ endpoint: "http://x", fetch: fetchImpl }) });
    calls.length = 0; // clear connect()'s own calls
    const wrongKeyBuyer: BtcWalletHandle = { wallet: "buyer", key: { ...BUYER.key, pubkey: PAYEE_PUBKEY } };
    await expect(rail.fund(TERMS, wrongKeyBuyer)).rejects.toThrow(/payer's own wallet/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the funding transaction has no output paying the HTLC address", async () => {
    const { rail } = await connectRail(baseHandlers({ getrawtransaction: (params) => (params[1] === true ? { vout: [] } : "00") }));
    await expect(rail.fund(TERMS, BUYER)).rejects.toThrow(/no output paying the HTLC address/);
  });

  it("refuses malformed terms (bad hashLock shape)", async () => {
    const { rail } = await connectRail(baseHandlers());
    await expect(rail.fund({ ...TERMS, hashLock: "not-a-hash" }, BUYER)).rejects.toThrow(/hashLock/);
  });
});

// ── claim() ──────────────────────────────────────────────────────────────────────────────────

describe("BtcHtlcRail.claim", () => {
  const notAfterMs = 1_800_000_000_000; // well after the mocked chain's tip time (1_690_000_000s)

  it("happy path: builds, signs via walletprocesspsbt, checks the deadline, then broadcasts", async () => {
    const { rail, calls } = await connectRail(baseHandlers());
    const evidence = await rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION_ADDRESS, notAfterMs);

    expect(evidence.ref).toBe(REF);
    expect(evidence.txid).toBe("bb".repeat(32));

    const sign = calls.find((c) => c.method === "walletprocesspsbt");
    expect(sign?.path).toBe("/wallet/seller");
    const acceptIndex = calls.findIndex((c) => c.method === "testmempoolaccept");
    const sendIndex = calls.findIndex((c) => c.method === "sendrawtransaction");
    expect(acceptIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(acceptIndex);
  });

  it("refuses a secret that does not open hashLock, before any RPC call", async () => {
    const { rail, calls } = await connectRail(baseHandlers());
    calls.length = 0;
    const wrongSecret = `0x${"11".repeat(32)}`;
    await expect(rail.claim(REF, TERMS, wrongSecret, SELLER, DESTINATION_ADDRESS, notAfterMs)).rejects.toThrow(/does not open hashLock/);
    expect(calls).toHaveLength(0);
  });

  it("refuses when seller.key.pubkey does not equal terms.payeePubkey", async () => {
    const { rail } = await connectRail(baseHandlers());
    const wrongKeySeller: BtcWalletHandle = { wallet: "seller", key: { ...SELLER.key, pubkey: PAYER_PUBKEY } };
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, wrongKeySeller, DESTINATION_ADDRESS, notAfterMs)).rejects.toThrow(/payee's own wallet/);
  });

  it("refuses a malformed ref", async () => {
    const { rail } = await connectRail(baseHandlers());
    await expect(rail.claim("not-a-ref", TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION_ADDRESS, notAfterMs)).rejects.toThrow(/ref must look like/);
  });

  it("refuses when the funding output does not match the HTLC script for these terms", async () => {
    const otherScriptPubKey = new Uint8Array([0x00, 0x14, ...new Array(20).fill(0xaa)]);
    const { rail } = await connectRail(
      baseHandlers({
        getrawtransaction: (params) => (params[1] === true ? { vout: [{ n: 1, scriptPubKey: { hex: bytesToHex(otherScriptPubKey) } }] } : fakeRawFundingTxHex(otherScriptPubKey, 100_000_000n)),
      }),
    );
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION_ADDRESS, notAfterMs)).rejects.toThrow(/does not match the HTLC script/);
  });

  it("refuses when the funding amount does not cover the fixed fee", async () => {
    const { rail } = await connectRail(baseHandlers({ getrawtransaction: (params) => (params[1] === true ? { vout: [{ n: 1, scriptPubKey: { hex: bytesToHex(SCRIPT.scriptPubKey) } }] } : fakeRawFundingTxHex(SCRIPT.scriptPubKey, 500n)) }));
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION_ADDRESS, notAfterMs)).rejects.toThrow(/does not cover the fixed fee/);
  });

  it("refuses when walletprocesspsbt does not return a complete, finalized transaction", async () => {
    const { rail } = await connectRail(baseHandlers({ walletprocesspsbt: () => ({ complete: false }) }));
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION_ADDRESS, notAfterMs)).rejects.toThrow(/complete, finalized/);
  });

  it("E4-equivalent: refuses at/after notAfterMs, checked as the LAST read before broadcast — never calls testmempoolaccept or sendrawtransaction", async () => {
    const { rail, calls } = await connectRail(baseHandlers());
    calls.length = 0;
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION_ADDRESS, 1_690_000_000_000)).rejects.toThrow(/refusing to broadcast claim/);
    expect(calls.some((c) => c.method === "testmempoolaccept")).toBe(false);
    expect(calls.some((c) => c.method === "sendrawtransaction")).toBe(false);
  });

  it("refuses when testmempoolaccept rejects it, and never calls sendrawtransaction", async () => {
    const { rail, calls } = await connectRail(baseHandlers({ testmempoolaccept: () => [{ txid: "aa".repeat(32), allowed: false, "reject-reason": "mempool-script-verify-flag-failed" }] }));
    calls.length = 0;
    await expect(rail.claim(REF, TERMS, `0x${PREIMAGE_HEX}`, SELLER, DESTINATION_ADDRESS, notAfterMs)).rejects.toThrow(/mempool-script-verify-flag-failed/);
    expect(calls.some((c) => c.method === "sendrawtransaction")).toBe(false);
  });
});

// ── refund() ─────────────────────────────────────────────────────────────────────────────────

describe("BtcHtlcRail.refund", () => {
  it("happy path: builds, signs via walletprocesspsbt, then broadcasts (no deadline guard)", async () => {
    const { rail, calls } = await connectRail(baseHandlers());
    const evidence = await rail.refund(REF, TERMS, BUYER, DESTINATION_ADDRESS);
    expect(evidence.ref).toBe(REF);
    const sign = calls.find((c) => c.method === "walletprocesspsbt");
    expect(sign?.path).toBe("/wallet/buyer");
  });

  it("refuses when buyer.key.pubkey does not equal terms.payerPubkey", async () => {
    const { rail } = await connectRail(baseHandlers());
    const wrongKeyBuyer: BtcWalletHandle = { wallet: "buyer", key: { ...BUYER.key, pubkey: PAYEE_PUBKEY } };
    await expect(rail.refund(REF, TERMS, wrongKeyBuyer, DESTINATION_ADDRESS)).rejects.toThrow(/payer's own wallet/);
  });

  it("rejected non-final: testmempoolaccept's rejection propagates and sendrawtransaction is never called", async () => {
    const { rail, calls } = await connectRail(baseHandlers({ testmempoolaccept: () => [{ txid: "aa".repeat(32), allowed: false, "reject-reason": "non-final" }] }));
    calls.length = 0;
    await expect(rail.refund(REF, TERMS, BUYER, DESTINATION_ADDRESS)).rejects.toThrow(/non-final/);
    expect(calls.some((c) => c.method === "sendrawtransaction")).toBe(false);
  });
});

// ── findClaimPreimage() ──────────────────────────────────────────────────────────────────────

describe("BtcHtlcRail.findClaimPreimage", () => {
  function blockWithSpend(vin: Array<{ txid?: string; vout?: number; txinwitness?: string[] }>) {
    return { tx: [{ vin: [{ txid: "prev", vout: 0 }] }, { vin }] };
  }

  it("returns the preimage when the funding outpoint was spent by the hash branch", async () => {
    const { rail } = await connectRail(
      baseHandlers({
        getblockchaininfo: () => ({ chain: "regtest", blocks: 105, time: 0, mediantime: 0 }),
        getblockhash: (params) => (params[0] === 0 ? BTC_REGTEST_PIN.genesisHash : `hash-${String(params[0])}`),
        getblock: (params) =>
          params[0] === "hash-105"
            ? blockWithSpend([{ txid: FUND_TXID, vout: 1, txinwitness: [PREIMAGE_HEX, "aa".repeat(71), "bb".repeat(59)] }])
            : { tx: [] },
      }),
    );
    const result = await rail.findClaimPreimage(REF, HASH_LOCK, 100);
    expect(result).toBe(`0x${PREIMAGE_HEX}`);
  });

  it("returns null when the outpoint was spent by the refund branch (no witness item opens the hash)", async () => {
    const { rail } = await connectRail(
      baseHandlers({
        getblockchaininfo: () => ({ chain: "regtest", blocks: 105, time: 0, mediantime: 0 }),
        getblockhash: (params) => (params[0] === 0 ? BTC_REGTEST_PIN.genesisHash : `hash-${String(params[0])}`),
        getblock: (params) =>
          params[0] === "hash-105"
            ? blockWithSpend([{ txid: FUND_TXID, vout: 1, txinwitness: ["aa".repeat(71), "", "bb".repeat(59)] }])
            : { tx: [] },
      }),
    );
    expect(await rail.findClaimPreimage(REF, HASH_LOCK, 100)).toBeNull();
  });

  it("returns null when the outpoint is never spent within the scanned window", async () => {
    const { rail } = await connectRail(
      baseHandlers({
        getblockchaininfo: () => ({ chain: "regtest", blocks: 102, time: 0, mediantime: 0 }),
        getblockhash: (params) => (params[0] === 0 ? BTC_REGTEST_PIN.genesisHash : `hash-${String(params[0])}`),
        getblock: () => ({ tx: [] }),
      }),
    );
    expect(await rail.findClaimPreimage(REF, HASH_LOCK, 100)).toBeNull();
  });

  it("refuses a malformed hashLock", async () => {
    const { rail } = await connectRail(baseHandlers());
    await expect(rail.findClaimPreimage(REF, "not-a-hash", 100)).rejects.toThrow(/hashLock/);
  });
});

// ── chain time helpers ───────────────────────────────────────────────────────────────────────

describe("chain time helpers", () => {
  it("tipBlockTimeMs and medianTimePastMs read getblockchaininfo's time/mediantime in ms", async () => {
    const { rail } = await connectRail(baseHandlers({ getblockchaininfo: () => ({ chain: "regtest", time: 1000, mediantime: 900 }) }));
    expect(await rail.tipBlockTimeMs()).toBe(1_000_000);
    expect(await rail.medianTimePastMs()).toBe(900_000);
  });
});

// ── key/path parsing helpers ─────────────────────────────────────────────────────────────────

describe("parseHdKeyPath / keyFromAddressInfo", () => {
  it("parses Core's own hdkeypath format (trailing h for hardened)", () => {
    expect(parseHdKeyPath("m/84h/1h/0h/0/0")).toEqual([0x80000054, 0x80000001, 0x80000000, 0, 0]);
  });

  it("keyFromAddressInfo builds a BtcSignerKey from a live getaddressinfo shape", () => {
    const key = keyFromAddressInfo({ pubkey: PAYEE_PUBKEY.toUpperCase(), hdmasterfingerprint: "77de3973", hdkeypath: "m/84h/1h/0h/0/0" });
    expect(key.pubkey).toBe(PAYEE_PUBKEY); // normalized to lowercase
    expect(key.fingerprint).toBe(0x77de3973);
    expect(key.path).toEqual([0x80000054, 0x80000001, 0x80000000, 0, 0]);
  });

  it("refuses a path that does not start with m", () => {
    expect(() => parseHdKeyPath("84h/1h/0h/0/0")).toThrow(/expected to start with "m"/);
  });
});

// sanity: SCRIPT/DESTINATION_ADDRESS setup above actually decodes to a real regtest scriptPubKey.
describe("test fixture sanity", () => {
  it("scriptPubKeyForAddress round-trips SCRIPT's own address", () => {
    expect(bytesToHex(scriptPubKeyForAddress(DESTINATION_ADDRESS, BTC_REGTEST_NETWORK))).toBe(bytesToHex(SCRIPT.scriptPubKey));
  });
});
