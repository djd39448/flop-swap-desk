// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs's btc-htlc-leg wiring (P4-BTC-SPEC.md §7): `loadRails` /
// `loadBtcCaptures` unit-tested directly, then the compiled CLI exercised end to end against a
// synthetic watch root shaped exactly like a live sweep with `options.rails.btc` configured
// would leave on disk — `rails.json`, `raw/btc/<txid>-<vout>/*.json`, `raw/rpc/<sha256>.json` —
// proving the offline replay reaches the same verdict without ever opening a socket. Mirrors
// tests/audit-export-evm.test.ts's own structure for the identical contract.

import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Transaction } from "@scure/btc-signer";
import { dealRoom, encodeFrame, generateHashLock, makeAccept, makeOffer, OFFER_ROOM } from "@flop-labs/tclk";

import { legAContext, legBContext, swapId as makeSwapId } from "../src/profile.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { formatPubkeyLine } from "../src/rails/account-line.js";
import { BTC_REGTEST_PIN, type BtcRailConfig } from "../src/rails/btc-htlc.js";
import { BTC_REGTEST_NETWORK, buildHtlcScript } from "../src/rails/btc-script.js";
import { identity, record } from "./helpers/identity.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadBtcCaptures, loadRails } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");

const buyer = identity("c3".repeat(32));
const seller = identity("c4".repeat(32));
const T0 = 1_758_000_000_000;
const MIN = 60_000;

const PAYEE_PUBKEY = "0361c6efa7529b0f113fe6ea467248133aba7f14927a7163d6333048ebbf01318a"; // seller
const PAYER_PUBKEY = "0372320de1e3ad1abed6a51d6c435cd1312657a62d6b3545cfca062bc8fd08a627"; // buyer
const FUND_TXID = "ab08a3ba29a27d8ccbc37fe3efe3f56018e34978328bc421361e688dc8d66694";
const FUND_VOUT = 1;
const REF = `${FUND_TXID}:${FUND_VOUT}`;
const AMOUNT_SATS = 100_000_000n;
const TIP_HEIGHT = 110;
const FUNDING_BLOCK_HASH = "bb".repeat(32);

const BTC_CONFIG: BtcRailConfig = { pin: BTC_REGTEST_PIN, endpoint: "http://127.0.0.1:19999" };

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
const NONCE = "cccccccccccccccc";
function btcId(checkedAtMs: number, n: number): string {
  return `${REF}:${checkedAtMs}:${NONCE}:${n}`;
}
function wireRow(rec: ReturnType<typeof record>) {
  return JSON.stringify({ seq: rec.seq, ts: new Date(rec.timestampMs).toISOString(), from: rec.sender, nonce: rec.nonce, sig: rec.signature, text: rec.line });
}
function dealRoomWire(rows: ReturnType<typeof record>[]) {
  return JSON.stringify({ messages: rows.map((r) => ({ seq: r.seq, ts: new Date(r.timestampMs).toISOString(), from: r.sender, nonce: r.nonce, sig: r.signature, text: r.line })) });
}

function scriptFor(hashLockHex: string, locktime: number) {
  return buildHtlcScript(
    { hashLock: hexToBytes(hashLockHex.slice(2)), payeePubkey: hexToBytes(PAYEE_PUBKEY), payerPubkey: hexToBytes(PAYER_PUBKEY), locktime },
    BTC_REGTEST_NETWORK,
  );
}

/** A 2-output funding transaction whose vout `FUND_VOUT` output is the real HTLC script — the
 *  same technique tests/btc-evidence.test.ts's own `fakeRawFundingTxHex` uses. */
function fakeRawFundingTxHex(scriptPubKey: Uint8Array, amountSats: bigint): string {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true, version: 2, lockTime: 0 });
  tx.addInput({ txid: new Uint8Array(32), index: 0, witnessUtxo: { amount: 1n, script: new Uint8Array([0x00]) } });
  tx.addOutput({ script: new Uint8Array([0x00, 0x14, ...new Array(20).fill(0)]), amount: 1_000_000n });
  tx.addOutput({ script: scriptPubKey, amount: amountSats });
  return bytesToHex(tx.unsignedTx);
}

/** Build one leg-A-on-btc-htlc / leg-B-unlocked swap and everything a live sweep with
 *  `options.rails.btc` configured would have written under a watch root for it. */
function buildBtcFixture() {
  const swapId = makeSwapId(buyer.did, "e00fe00fe00fe00f");
  const lock = generateHashLock();

  const legAOffer = makeOffer({
    from: buyer.did, role: "payer", amount: AMOUNT_SATS.toString(), asset: "BTC", lock: "hash", rails: ["btc-htlc"],
    claimByMs: T0 + 45 * MIN, refundAfterMs: T0 + 60 * MIN, expiresMs: T0 + 30 * MIN,
    job: { proto: "swap", id: swapId, context: legAContext({ wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc" }) },
  });
  const legAAccept = makeAccept(legAOffer, { from: seller.did, statement: lock.hash });

  const legBOffer = makeOffer({
    from: seller.did, role: "payer", amount: "52070000", asset: "FLOP", lock: "hash", rails: ["flop-htlc"],
    claimByMs: T0 + 70 * MIN, refundAfterMs: T0 + 180 * MIN, expiresMs: T0 + 40 * MIN,
    job: { proto: "swap", id: swapId, context: legBContext(legAOffer.id) },
  });
  const legBAccept = makeAccept(legBOffer, { from: buyer.did, statement: lock.hash });

  const legATerms = offerAcceptLockTerms(legAOffer, legAAccept);
  const locktime = legATerms.refundAfterMs / 1000;

  const offerRows = [
    record(OFFER_ROOM, 1, T0, buyer, encodeFrame(legAOffer)),
    record(OFFER_ROOM, 2, T0 + 1 * MIN, seller, encodeFrame(legAAccept)),
    record(OFFER_ROOM, 3, T0 + 2 * MIN, seller, encodeFrame(legBOffer)),
    record(OFFER_ROOM, 4, T0 + 3 * MIN, buyer, encodeFrame(legBAccept)),
  ];

  // P4-BTC-FIXES-R2.md R2-3: pubkey lines before the lock frame, matching the real client flows
  // (P4-BTC-SPEC.md §7 — both parties post their pubkey line, THEN the Buyer funds and posts the
  // lock frame) and `replay.ts`'s own `beforeSeq: accepted.seq` rule, which now ignores anything
  // at or after the accepted lock's own seq.
  const dealRoomA = dealRoom(legAAccept.contract);
  const dealRoomARows = [
    record(dealRoomA, 1, T0 + 4 * MIN, seller, formatPubkeyLine({
      railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: PAYEE_PUBKEY,
    })),
    record(dealRoomA, 2, T0 + 4 * MIN + 1, buyer, formatPubkeyLine({
      railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: PAYER_PUBKEY,
    })),
    record(dealRoomA, 3, T0 + 4.5 * MIN, buyer, encodeFrame({
      type: "lock", from: buyer.did, contract: legAAccept.contract, rail: "btc-htlc", ref: REF,
    })),
  ];

  const scriptPubKey = scriptFor(lock.hash, locktime).scriptPubKey;
  const rawHex = fakeRawFundingTxHex(scriptPubKey, AMOUNT_SATS);
  const checkedAtMs = T0 + 5 * MIN;

  const chainInfoBody = jsonRpcResult(btcId(checkedAtMs, 1), { chain: "regtest", blocks: TIP_HEIGHT });
  const genesisBody = jsonRpcResult(btcId(checkedAtMs, 2), BTC_REGTEST_PIN.genesisHash);
  const rawTxBody = jsonRpcResult(btcId(checkedAtMs, 3), { hex: rawHex, confirmations: 2, blockhash: FUNDING_BLOCK_HASH });
  const txoutBody = jsonRpcResult(btcId(checkedAtMs, 4), { confirmations: 2, value: 1.0, scriptPubKey: { hex: bytesToHex(scriptPubKey) } });
  // H6: the funding block's own real height, read directly via getblockheader.
  const FUNDING_HEIGHT = TIP_HEIGHT - 2 + 1;
  const blockHeaderBody = jsonRpcResult(btcId(checkedAtMs, 5), { height: FUNDING_HEIGHT });

  // P4-BTC-SPEC.md §7, mirroring evm-evidence's own A1/D1 binding rules: each exchange's own
  // `requestBody` must actually ask for its declared `method`/`params`, and every id is bound
  // to this capture's own ref/checkedAtMs/nonce.
  const index = {
    v: 1,
    rail: "btc-htlc",
    ref: REF,
    pin: BTC_CONFIG.pin.name,
    caip2: BTC_CONFIG.pin.caip2,
    endpoint: BTC_CONFIG.endpoint,
    checkedAtMs,
    config: BTC_CONFIG,
    nonce: NONCE,
    exchanges: [
      {
        method: "getblockchaininfo",
        params: [],
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(checkedAtMs, 1), method: "getblockchaininfo", params: [] }),
        responseSha256: sha256Hex(chainInfoBody),
        atMs: T0,
      },
      {
        method: "getblockhash",
        params: [0],
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(checkedAtMs, 2), method: "getblockhash", params: [0] }),
        responseSha256: sha256Hex(genesisBody),
        atMs: T0,
      },
      {
        method: "getrawtransaction",
        params: [FUND_TXID, true],
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(checkedAtMs, 3), method: "getrawtransaction", params: [FUND_TXID, true] }),
        responseSha256: sha256Hex(rawTxBody),
        atMs: T0,
      },
      {
        method: "gettxout",
        params: [FUND_TXID, FUND_VOUT, false],
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(checkedAtMs, 4), method: "gettxout", params: [FUND_TXID, FUND_VOUT, false] }),
        responseSha256: sha256Hex(txoutBody),
        atMs: T0,
      },
      {
        method: "getblockheader",
        params: [FUNDING_BLOCK_HASH],
        requestBody: JSON.stringify({ jsonrpc: "2.0", id: btcId(checkedAtMs, 5), method: "getblockheader", params: [FUNDING_BLOCK_HASH] }),
        responseSha256: sha256Hex(blockHeaderBody),
        atMs: T0,
      },
    ],
  };

  return { swapId, lock, legAOffer, legAAccept, legBOffer, legBAccept, legATerms, offerRows, dealRoomA, dealRoomARows, index, chainInfoBody, genesisBody, rawTxBody, txoutBody, blockHeaderBody };
}

async function writeWatchRoot(root: string, fixture: ReturnType<typeof buildBtcFixture>, opts: { rails?: unknown } = {}) {
  await mkdir(join(root, "raw", OFFER_ROOM), { recursive: true });
  await writeFile(join(root, "raw", OFFER_ROOM, "only.jsonl"), fixture.offerRows.map(wireRow).join("\n") + "\n");

  await mkdir(join(root, "raw", fixture.dealRoomA), { recursive: true });
  await writeFile(join(root, "raw", fixture.dealRoomA, "only.json"), dealRoomWire(fixture.dealRoomARows));

  await mkdir(join(root, "raw", "rpc"), { recursive: true });
  for (const [sha, body] of [
    [fixture.index.exchanges[0]!.responseSha256, fixture.chainInfoBody],
    [fixture.index.exchanges[1]!.responseSha256, fixture.genesisBody],
    [fixture.index.exchanges[2]!.responseSha256, fixture.rawTxBody],
    [fixture.index.exchanges[3]!.responseSha256, fixture.txoutBody],
    [fixture.index.exchanges[4]!.responseSha256, fixture.blockHeaderBody],
  ] as const) {
    await writeFile(join(root, "raw", "rpc", `${sha}.json`), body);
  }

  await mkdir(join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`), { recursive: true });
  await writeFile(join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`, "only.json"), JSON.stringify(fixture.index, null, 2));

  if (opts.rails !== undefined) {
    await writeFile(join(root, "rails.json"), JSON.stringify(opts.rails, null, 2));
  }
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "audit-export-btc-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadRails — btc", () => {
  it("reads DIR/rails.json's btc config when present", async () => {
    await writeFile(join(root, "rails.json"), JSON.stringify({ btc: BTC_CONFIG }));
    expect(loadRails(root, undefined)).toEqual({ btc: BTC_CONFIG });
  });

  // P4-BTC-SPEC.md §7, mirroring A3 for evm: a rails config read off disk is just as
  // untrusted as any other file under --root, so it gets the same `checkBtcRailConfig` gate a
  // live sweep's own `--rails` file does.
  it("throws when DIR/rails.json's own btc config is invalid (network off the allow list)", async () => {
    const badConfig = { ...BTC_CONFIG, pin: { ...BTC_CONFIG.pin, network: "mainnet" } };
    await writeFile(join(root, "rails.json"), JSON.stringify({ btc: badConfig }));
    expect(() => loadRails(root, undefined)).toThrow(/btc rail config is invalid.*not on the allow list/);
  });

  it("reads both evm and btc from the same file", async () => {
    await writeFile(join(root, "rails.json"), JSON.stringify({ btc: BTC_CONFIG }));
    const parsed = loadRails(root, undefined);
    expect(parsed.btc).toEqual(BTC_CONFIG);
  });
});

describe("loadBtcCaptures", () => {
  it("returns an empty map when raw/btc does not exist", async () => {
    expect((await loadBtcCaptures(root)).size).toBe(0);
  });

  it("loads the latest index per outpoint, with pre-verified raw/rpc bytes", async () => {
    const fixture = buildBtcFixture();
    await writeWatchRoot(root, fixture);

    const chain = await loadBtcCaptures(root);
    expect(chain.size).toBe(1);
    const capture = chain.get(REF);
    expect(capture).toBeDefined();
    expect(capture.index.ref).toBe(REF);

    const goodSha = fixture.index.exchanges[0]!.responseSha256;
    expect(new TextDecoder().decode(capture.bytes.get(goodSha))).toBe(fixture.chainInfoBody);
    expect(capture.bytes.get("0".repeat(64)) ?? null).toBeNull();
  });

  it("fails the leg closed on a corrupted newest index and reports it via the notes array", async () => {
    const fixture = buildBtcFixture();
    await writeWatchRoot(root, fixture);
    await writeFile(join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`, "zzz-newer-but-corrupt.json"), "{ not valid json");

    const notes: string[] = [];
    const chain = await loadBtcCaptures(root, notes);
    expect(chain.size).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`raw/btc/${FUND_TXID}-${FUND_VOUT}/zzz-newer-but-corrupt\\.json.*skipped`));
  });

  it("skips a directory that is not ref-shaped, without throwing", async () => {
    await mkdir(join(root, "raw", "btc", "not-a-ref"), { recursive: true });
    await writeFile(join(root, "raw", "btc", "not-a-ref", "only.json"), "{}");
    const chain = await loadBtcCaptures(root);
    expect(chain.size).toBe(0);
  });
});

describe("examples/audit-export.mjs — btc-htlc leg end to end", () => {
  it("folds a captured, on-terms locked read into settlementView 'funded' with a btc-regtest finalizedRef", async () => {
    const fixture = buildBtcFixture();
    await writeWatchRoot(root, fixture, { rails: { btc: BTC_CONFIG } });

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("funded");
    expect(swap.finalizedRefs.some((ref: string) => ref.startsWith("btc-regtest:confirmations-1:"))).toBe(true);
  });

  it("a tampered raw/rpc file (bytes no longer hash to their own filename) leaves the leg unverified, never thrown", async () => {
    const fixture = buildBtcFixture();
    await writeWatchRoot(root, fixture, { rails: { btc: BTC_CONFIG } });

    const txoutSha = fixture.index.exchanges[3]!.responseSha256;
    await writeFile(join(root, "raw", "rpc", `${txoutSha}.json`), "tampered, does not match its own filename's hash");

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const swap = JSON.parse(result.stdout).swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("none");
    expect(swap.finalizedRefs).toEqual([]);
  });

  it("still opens no network connection with a btc-htlc leg on disk (the CLI imports no fetch)", async () => {
    const fixture = buildBtcFixture();
    await writeWatchRoot(root, fixture, { rails: { btc: BTC_CONFIG } });
    const result = run(["--root", root]);
    expect(result.status).toBe(0);
  });

  it("exits 2 with the reason when DIR/rails.json's btc config is invalid", async () => {
    const fixture = buildBtcFixture();
    const badConfig = { ...BTC_CONFIG, pin: { ...BTC_CONFIG.pin, network: "mainnet" } };
    await writeWatchRoot(root, fixture, { rails: { btc: badConfig } });

    const result = run(["--root", root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/btc rail config is invalid.*not on the allow list/);
  });

  it("R2-3: a conflicting pubkey line posted AFTER the accepted lock frame leaves leg A funded (never re-resolved)", async () => {
    const fixture = buildBtcFixture();
    // A second, conflicting pubkey line for the Seller (payee), posted after the lock frame the
    // tclk machine actually accepted (seq 3) — per G1's own rule (now applied on replay too,
    // R2-3), this must neither add to nor conflict with what already resolved before the lock.
    fixture.dealRoomARows.push(
      record(fixture.dealRoomA, 4, T0 + 5 * MIN, seller, formatPubkeyLine({
        railId: "btc-htlc", caip2: BTC_REGTEST_PIN.caip2, pubkey: `03${"ee".repeat(32)}`,
      })),
    );
    await writeWatchRoot(root, fixture, { rails: { btc: BTC_CONFIG } });

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("funded");
  });

  it("R2-5: a genuine response from a DIFFERENT capture (the donor's own nonce id) leaves leg A without chain evidence, naming the capture binding", async () => {
    const fixture = buildBtcFixture();
    await writeWatchRoot(root, fixture, { rails: { btc: BTC_CONFIG } });

    // H8's own splice defence, exercised through the real CLI: a donor exchange that is itself
    // genuine and self-consistent (its own request id equals its own response's embedded id) but
    // minted under a DIFFERENT capture (a different nonce) — so only `idBoundToCapture` can catch
    // it, never a bare id-mismatch check.
    const donorNonce = "dddddddddddddddd";
    const donorId = `${REF}:${fixture.index.checkedAtMs}:${donorNonce}:1`;
    const donorBody = jsonRpcResult(donorId, { chain: "regtest", blocks: TIP_HEIGHT });
    const donorSha = sha256Hex(donorBody);
    await writeFile(join(root, "raw", "rpc", `${donorSha}.json`), donorBody);

    const splicedIndex = {
      ...fixture.index,
      exchanges: fixture.index.exchanges.map((exchange, i) =>
        i === 0
          ? { ...exchange, requestBody: JSON.stringify({ jsonrpc: "2.0", id: donorId, method: "getblockchaininfo", params: [] }), responseSha256: donorSha }
          : exchange,
      ),
    };
    await writeFile(join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`, "only.json"), JSON.stringify(splicedIndex, null, 2));

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap).toBeDefined();
    expect(swap.settlementView.a).toBe("none");
    expect(swap.finalizedRefs).toEqual([]);
    expect(swap.evidence.a.railVerified).toBeNull();
    expect(swap.evidence.a.reason).toMatch(/not bound to this capture/);
  });

  it("prints a note, still replays, and fails the leg closed when the newest capture index is corrupted", async () => {
    const fixture = buildBtcFixture();
    await writeWatchRoot(root, fixture, { rails: { btc: BTC_CONFIG } });
    await writeFile(join(root, "raw", "btc", `${FUND_TXID}-${FUND_VOUT}`, "zzz-newer-but-corrupt.json"), "{ not valid json");

    const result = run(["--root", root, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.btcCaptureNotes).toHaveLength(1);
    expect(parsed.btcCaptureNotes[0]).toMatch(/zzz-newer-but-corrupt\.json.*skipped/);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === fixture.swapId);
    expect(swap.settlementView.a).toBe("none");
  });
});
