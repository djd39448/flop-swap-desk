// SPDX-License-Identifier: MIT
//
// tests/sol-evidence.test.ts - the Solana evidence reader (src/rails/sol-evidence.ts) against captures taken
// through the real `captureSolLeg` + `CapturingRpc` from the scripted fake node (tests/helpers/sol-fake-chain.ts),
// then tampered one property at a time. The NEAR and Bitcoin round-1 probes are ported: a splice with a donor
// nonce, an index-only pin rename, a captured config weaker than the auditor's, a wrong mint, a wrong payee,
// an amount mismatch, a programdata hash mismatch, an upgrade authority that is set, a transport failure. Each
// rule has a test that fails without it. The fake node models no program logic; the escrow bytes are the
// documented layout, and the program itself is exercised by contracts-sol's tests and, in SB-int, the validator.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LockTerms } from "@flop-labs/tclk";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SOL_RAIL_ID } from "../src/rails/custom-rails.js";
import { CapturingRpc, verifiedExchangeBytes, writeCapture } from "../src/rails/rpc-capture.js";
import {
  SOL_CAPTURE_ATTEMPTS,
  captureSolLeg,
  loadSolCapture,
  solCaptureDir,
  solCaptureKey,
  solEvidence,
  solLockRefInvalid,
  type SolAccounts,
  type SolCapture,
} from "../src/rails/sol-evidence.js";
import { SOL_DEVNET_PIN, SOL_HTLC_PROGRAM_ID, type SolRailConfig } from "../src/rails/sol-htlc.js";
import { TOKEN_PROGRAM_ID } from "../src/rails/sol-spl.js";
import { pubkeyFromBase58, pubkeyToBase58 } from "../src/rails/sol-tx.js";
import { FakeRpcError, escrowBytes, makeWorld, putLockedEscrow, tokenAccountBytes, type World, type WorldOptions } from "./helpers/sol-fake-chain.js";

const NOW = 1_800_000_000_500;
const LEG_CONTRACT = `0x${"22".repeat(32)}`;
const OTHER_KEY = pubkeyToBase58(new Uint8Array(32).fill(0x55));

function termsFor(w: World, over: Partial<LockTerms> = {}): LockTerms {
  return {
    contract: `0x${"11".repeat(32)}`,
    lock: "hash",
    statement: w.hashLock,
    amount: w.terms.amount,
    asset: "USDC",
    payer: "did:key:zPayer",
    payee: "did:key:zPayee",
    claimByMs: w.terms.claimByMs,
    refundAfterMs: w.terms.refundAfterMs,
    ...over,
  };
}

function accountsFor(w: World): SolAccounts {
  return { payee: w.seller.publicKey, payer: w.buyer.publicKey };
}

async function takeCapture(w: World, o: { accounts?: SolAccounts; terms?: LockTerms; ref?: string; config?: SolRailConfig } = {}): Promise<SolCapture> {
  const { index, exchanges } = await captureSolLeg(w.rpc, o.config ?? w.config, o.terms ?? termsFor(w), o.accounts ?? accountsFor(w), o.ref ?? w.ref, NOW);
  return { index, bytes: verifiedExchangeBytes(exchanges) };
}

function verdict(w: World, capture: SolCapture, over: { terms?: LockTerms; accounts?: SolAccounts; config?: SolRailConfig } = {}) {
  return solEvidence({ terms: over.terms ?? termsFor(w), config: over.config ?? w.config, accounts: over.accounts ?? accountsFor(w), capture });
}

async function lockedWorld(options: WorldOptions = {}): Promise<{ w: World; capture: SolCapture }> {
  const w = makeWorld(options);
  putLockedEscrow(w);
  return { w, capture: await takeCapture(w) };
}

// -- tamper helpers ----------------------------------------------------------------------------------------

function clone(capture: SolCapture): { index: SolCapture["index"]; bytes: Map<string, Uint8Array | null> } {
  return { index: structuredClone(capture.index), bytes: new Map(capture.bytes) };
}

function shaOf(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Rewrites the response of exchange `i` (re-hashing, so the index and bytes agree). */
function setResponse(capture: SolCapture, i: number, mutate: (envelope: Record<string, unknown>) => void): SolCapture {
  const c = clone(capture);
  const exchange = c.index.exchanges[i]!;
  const envelope = JSON.parse(new TextDecoder().decode(c.bytes.get(exchange.responseSha256)!)) as Record<string, unknown>;
  mutate(envelope);
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const sha = shaOf(bytes);
  c.bytes.set(sha, bytes);
  exchange.responseSha256 = sha;
  return c;
}

/** Rewrites the request of exchange `i`, keeping the index's own params in step unless told not to. */
function setRequest(capture: SolCapture, i: number, mutate: (request: { id: unknown; method: string; params: unknown }) => void, syncIndex = true): SolCapture {
  const c = clone(capture);
  const exchange = c.index.exchanges[i]!;
  const request = JSON.parse(exchange.requestBody) as { id: unknown; method: string; params: unknown };
  mutate(request);
  exchange.requestBody = JSON.stringify(request);
  if (syncIndex) {
    exchange.method = request.method;
    exchange.params = request.params;
  }
  return c;
}

function setSlot(capture: SolCapture, i: number, slot: number): SolCapture {
  return setResponse(capture, i, (envelope) => {
    (envelope.result as { context: { slot: number } }).context.slot = slot;
  });
}

function withEscrow(w: World, o: Partial<Parameters<typeof escrowBytes>[0]> & { vaultAmount?: bigint }): void {
  const amount = o.amount ?? BigInt(w.terms.amount);
  w.chain.put(w.keys.escrow, {
    lamports: 1,
    owner: SOL_HTLC_PROGRAM_ID,
    data: escrowBytes({
      bump: w.keys.bump,
      payer: w.buyer.publicKeyBytes,
      payee: w.seller.publicKeyBytes,
      mint: w.mint,
      hashLock: Uint8Array.from(Buffer.from(w.hashLock.slice(2), "hex")),
      amount,
      claimByMs: w.terms.claimByMs,
      refundAfterMs: w.terms.refundAfterMs,
      ...o,
    }),
    executable: false,
  });
  w.chain.put(w.keys.vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.keys.escrow, amount: o.vaultAmount ?? amount }), executable: false });
}

const FINALIZED_REF = "solana-localnet-flop:final:5000";

// -- happy path and layout ---------------------------------------------------------------------------------

describe("solEvidence - happy path", () => {
  it("locked, every field matches, vault funded, payee token account usable -> railVerified true, rail locked+final", async () => {
    const { w, capture } = await lockedWorld();
    const result = verdict(w, capture);
    expect(result.lock.railVerified).toBe(true);
    expect(result.rail).toEqual({ status: "locked", final: true, checkedAtMs: NOW, finalizedRef: FINALIZED_REF });
    expect(result.lock.finalizedRef).toBe(FINALIZED_REF);
    expect(result.lock.ref).toBe(w.ref);
    expect(result.lock.rail).toBe(SOL_RAIL_ID);
    expect(result.lock.raw).toEqual(capture.index.exchanges.map((e) => e.responseSha256));
    expect(result.lock.checkedAtMs).toBe(NOW);
  });

  it("the read sequence is genesis, finalized slot, escrow, vault, program, programdata, payee token account - all finalized at minContextSlot", async () => {
    const { w, capture } = await lockedWorld();
    expect(capture.index.exchanges.map((e) => e.method)).toEqual(["getGenesisHash", "getSlot", "getAccountInfo", "getAccountInfo", "getAccountInfo", "getAccountInfo", "getAccountInfo"]);
    const slot = w.chain.finalizedSlot;
    expect(capture.index.exchanges[1]!.params).toEqual([{ commitment: "finalized" }]);
    const keys = [w.keys.escrow, w.keys.vault, pubkeyFromBase58(SOL_HTLC_PROGRAM_ID), undefined, w.keys.sellerToken].map((k) => (k === undefined ? undefined : pubkeyToBase58(k)));
    capture.index.exchanges.slice(2).forEach((e, n) => {
      const params = e.params as [string, { encoding: string; commitment: string; minContextSlot: number }];
      if (keys[n] !== undefined) expect(params[0]).toBe(keys[n]);
      expect(params[1]).toEqual({ encoding: "base64", commitment: "finalized", minContextSlot: slot });
    });
    for (const [n, e] of capture.index.exchanges.entries()) {
      expect((JSON.parse(e.requestBody) as { id: string }).id).toBe(`${w.ref}:${NOW}:${capture.index.nonce}:${n + 1}`);
    }
    expect(capture.index.exchanges).toHaveLength(7);
  });

  it("without a payee account line the payee token account is not read and the verdict is null (no payee line)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const capture = await takeCapture(w, { accounts: { payer: w.buyer.publicKey } });
    expect(capture.index.exchanges).toHaveLength(6);
    const result = verdict(w, capture, { accounts: { payer: w.buyer.publicKey } });
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/payee has no account line/);
    expect(result.rail).toBeUndefined();
  });

  it("a payer account line is optional corroboration; the ref's payer is used when there is none", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const accounts = { payee: w.seller.publicKey };
    const capture = await takeCapture(w, { accounts });
    expect(verdict(w, capture, { accounts }).lock.railVerified).toBe(true);
  });

  it("the ProgramData may carry trailing zero padding, and the authority may be None or all-zero", async () => {
    for (const options of [{ padding: 17 }, { authority: "none" as const }, { authority: "zero" as const }]) {
      const { w, capture } = await lockedWorld(options);
      expect(verdict(w, capture).lock.railVerified, JSON.stringify(options)).toBe(true);
    }
  });

  it("a stray donation to the vault (more than the amount) is not a mismatch", async () => {
    const w = makeWorld();
    withEscrow(w, { vaultAmount: 1_500_000n });
    expect(verdict(w, await takeCapture(w)).lock.railVerified).toBe(true);
  });
});

// -- terminal states ---------------------------------------------------------------------------------------

describe("solEvidence - claimed and refunded", () => {
  it("Claimed (revealed, the stored preimage opens the hash lock) -> railVerified false with a final claimed rail", async () => {
    const w = makeWorld();
    withEscrow(w, { status: "Claimed", preimage: w.preimage, vaultAmount: 0n });
    const result = verdict(w, await takeCapture(w));
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toEqual({ status: "claimed", final: true, checkedAtMs: NOW, finalizedRef: FINALIZED_REF });
    expect(result.lock.reason).toMatch(/claimed on-chain, not locked/);
  });

  it("Refunded -> railVerified false with a final refunded rail", async () => {
    const w = makeWorld();
    withEscrow(w, { status: "Refunded", vaultAmount: 0n });
    const result = verdict(w, await takeCapture(w));
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail?.status).toBe("refunded");
    expect(result.rail?.final).toBe(true);
  });

  it("a terminal escrow whose fields do not match the terms carries no rail (H1)", async () => {
    for (const over of [{ amount: 999n }, { payee: pubkeyFromBase58(OTHER_KEY) }, { mint: pubkeyFromBase58(OTHER_KEY) }, { claimByMs: 1 }, { refundAfterMs: 2 }]) {
      const w = makeWorld();
      withEscrow(w, { status: "Refunded", vaultAmount: 0n, ...over });
      const result = verdict(w, await takeCapture(w));
      expect(result.rail, JSON.stringify(Object.keys(over))).toBeUndefined();
      expect(result.lock.railVerified).toBeNull();
      expect(result.lock.reason).toMatch(/refusing to trust it as this swap's own lock/);
    }
  });

  it("no revealed-but-unpaid state exists: Locked holding a preimage, Claimed with the wrong preimage, or Refunded holding one are all impossible and fail closed", async () => {
    const w = makeWorld();
    withEscrow(w, { preimage: w.preimage });
    let result = verdict(w, await takeCapture(w));
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/impossible state/);
    expect(result.rail).toBeUndefined();

    withEscrow(w, { status: "Claimed", preimage: new Uint8Array(32).fill(9), vaultAmount: 0n });
    result = verdict(w, await takeCapture(w));
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/does not open the hash lock/);
    expect(result.rail).toBeUndefined();

    withEscrow(w, { status: "Claimed", vaultAmount: 0n }); // claimed without any stored preimage
    result = verdict(w, await takeCapture(w));
    expect(result.lock.railVerified).toBeNull();

    withEscrow(w, { status: "Refunded", preimage: w.preimage, vaultAmount: 0n });
    result = verdict(w, await takeCapture(w));
    expect(result.lock.railVerified).toBeNull();
    expect(result.rail).toBeUndefined();
  });
});

// -- H1: the locked verdict needs every field and the payout path ---------------------------------------------

describe("solEvidence - a locked verdict needs every field to match (H1)", () => {
  async function expectNoRail(w: World, reasonPattern: RegExp, verdictValue: boolean | null = false, over: Parameters<typeof verdict>[2] = {}): Promise<void> {
    const result = verdict(w, await takeCapture(w, over.accounts === undefined ? {} : { accounts: over.accounts }), over);
    expect(result.lock.railVerified).toBe(verdictValue);
    expect(result.lock.reason).toMatch(reasonPattern);
    expect(result.rail).toBeUndefined();
  }

  it("wrong mint on the escrow", async () => {
    const w = makeWorld();
    withEscrow(w, { mint: pubkeyFromBase58(OTHER_KEY) });
    await expectNoRail(w, /mint differs/);
  });

  it("wrong payee on the escrow (not the payee account line)", async () => {
    const w = makeWorld();
    withEscrow(w, { payee: pubkeyFromBase58(OTHER_KEY) });
    await expectNoRail(w, /payee differs/);
  });

  it("amount mismatch", async () => {
    const w = makeWorld();
    withEscrow(w, { amount: 1n });
    await expectNoRail(w, /amount differs/);
  });

  it("claimByMs and refundAfterMs mismatches", async () => {
    let w = makeWorld();
    withEscrow(w, { claimByMs: w.terms.claimByMs + 1 });
    await expectNoRail(w, /claimByMs differs/);
    w = makeWorld();
    withEscrow(w, { refundAfterMs: w.terms.refundAfterMs + 1 });
    await expectNoRail(w, /refundAfterMs differs/);
  });

  it("the terms disagreeing with the chain (not the chain with the terms) is the same mismatch", async () => {
    const { w, capture } = await lockedWorld();
    const result = verdict(w, capture, { terms: termsFor(w, { amount: "2000000" }) });
    expect(result.lock.railVerified).toBe(false);
    expect(result.rail).toBeUndefined();
  });

  it("the payer account line naming someone other than the ref's payer", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const accounts = { payee: w.seller.publicKey, payer: OTHER_KEY };
    const result = verdict(w, await takeCapture(w, { accounts }), { accounts });
    expect(result.lock.railVerified).toBe(false);
    expect(result.lock.reason).toMatch(/payer account line differs/);
    expect(result.rail).toBeUndefined();
  });

  it("an escrow account whose own payer is not the ref's payer is not this lock", async () => {
    const w = makeWorld();
    withEscrow(w, { payer: pubkeyFromBase58(OTHER_KEY) });
    await expectNoRail(w, /differ from the ref/, null);
  });

  it("the vault holds less than the amount, is missing, frozen, or owned by someone other than the escrow", async () => {
    const short = makeWorld();
    withEscrow(short, { vaultAmount: 1n });
    await expectNoRail(short, /vault holds 1 units/);

    const missing = makeWorld();
    putLockedEscrow(missing);
    missing.chain.accounts.delete(pubkeyToBase58(missing.keys.vault));
    await expectNoRail(missing, /vault does not exist/);

    const frozen = makeWorld();
    putLockedEscrow(frozen);
    frozen.chain.put(frozen.keys.vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: frozen.mint, owner: frozen.keys.escrow, amount: 1_000_000n, state: 2 }), executable: false });
    await expectNoRail(frozen, /vault is frozen/);

    const stolen = makeWorld();
    putLockedEscrow(stolen);
    stolen.chain.put(stolen.keys.vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: stolen.mint, owner: pubkeyFromBase58(OTHER_KEY), amount: 1_000_000n }), executable: false });
    await expectNoRail(stolen, /vault is owned by a different wallet/);
  });

  it("the payee's token account missing, for another mint, owned by someone else, frozen, or not a token account: the payout could never land", async () => {
    const cases: Array<[string, (w: World) => void, RegExp]> = [
      ["missing", (w) => void w.chain.accounts.delete(pubkeyToBase58(w.keys.sellerToken)), /does not exist/],
      [
        "other mint",
        (w) => w.chain.put(w.keys.sellerToken, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: pubkeyFromBase58(OTHER_KEY), owner: w.seller.publicKeyBytes, amount: 0n }), executable: false }),
        /different mint/,
      ],
      [
        "other owner",
        (w) => w.chain.put(w.keys.sellerToken, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: pubkeyFromBase58(OTHER_KEY), amount: 0n }), executable: false }),
        /different wallet/,
      ],
      [
        "frozen",
        (w) => w.chain.put(w.keys.sellerToken, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.seller.publicKeyBytes, amount: 0n, state: 2 }), executable: false }),
        /frozen/,
      ],
      [
        "not owned by the token program",
        (w) => w.chain.put(w.keys.sellerToken, { lamports: 1, owner: SOL_HTLC_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.seller.publicKeyBytes, amount: 0n }), executable: false }),
        /not owned by the classic token program/,
      ],
    ];
    for (const [name, mutate, pattern] of cases) {
      const w = makeWorld();
      putLockedEscrow(w);
      mutate(w);
      const result = verdict(w, await takeCapture(w));
      expect(result.lock.railVerified, name).toBe(false);
      expect(result.lock.reason, name).toMatch(pattern);
      expect(result.lock.reason, name).toMatch(/could never land/);
      expect(result.rail, name).toBeUndefined();
    }
  });

  it("no escrow at the derived address, or one not owned by the program, is 'no lock', never a verdict", async () => {
    const w = makeWorld();
    const none = verdict(w, await takeCapture(w));
    expect(none.lock.railVerified).toBeNull();
    expect(none.lock.reason).toMatch(/no lock at the finalized view/);
    expect(none.rail).toBeUndefined();

    putLockedEscrow(w);
    const account = w.chain.get(w.keys.escrow)!;
    w.chain.put(w.keys.escrow, { ...account, owner: "11111111111111111111111111111111" });
    const foreign = verdict(w, await takeCapture(w));
    expect(foreign.lock.railVerified).toBeNull();
    expect(foreign.lock.reason).toMatch(/not owned by the HTLC program/);
  });

  it("a malformed escrow (wrong length, unknown status byte, unknown version) fails closed", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const good = w.chain.get(w.keys.escrow)!;
    for (const mutate of [(d: Uint8Array) => d.slice(0, 187), (d: Uint8Array) => Uint8Array.from(d, (b, i) => (i === 1 ? 9 : b)), (d: Uint8Array) => Uint8Array.from(d, (b, i) => (i === 0 ? 2 : b))]) {
      w.chain.put(w.keys.escrow, { ...good, data: mutate(good.data) });
      const result = verdict(w, await takeCapture(w));
      expect(result.lock.railVerified).toBeNull();
      expect(result.lock.reason).toMatch(/malformed escrow/);
      expect(result.rail).toBeUndefined();
    }
  });

  it("a leg asset other than USDC and a ref/lock mismatch fail before any chain data is read (K3, ref binding)", async () => {
    const { w, capture } = await lockedWorld();
    expect(verdict(w, capture, { terms: termsFor(w, { asset: "USDT" }) }).lock.railVerified).toBe(false);
    expect(verdict(w, capture, { terms: termsFor(w, { statement: `0x${"cd".repeat(32)}` }) }).lock.railVerified).toBe(false);
    expect(verdict(w, capture, { terms: termsFor(w, { lock: "time" as unknown as "hash" }) }).lock.railVerified).toBe(false);
    expect(solLockRefInvalid(termsFor(w), `${w.hashLock}`)).toBe(true);
    expect(solLockRefInvalid(termsFor(w), `${w.hashLock}:notakey`)).toBe(true);
    expect(solLockRefInvalid(termsFor(w), w.ref)).toBe(false);
  });
});

// -- the program: hash and upgrade authority ---------------------------------------------------------------------

describe("solEvidence - the program is the pinned, immutable one", () => {
  it("a ProgramData hash that is not the pinned programHash -> null with the reason, no rail", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const pd = pubkeyToBase58(findProgramData());
    const account = w.chain.accounts.get(pd)!;
    const data = account.data.slice();
    data[45] ^= 1;
    w.chain.put(pd, { ...account, data });
    const result = verdict(w, await takeCapture(w));
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/hash does not match the pinned programHash/);
    expect(result.rail).toBeUndefined();
  });

  it("an upgrade authority that is set (any key other than the all-zero address) -> null, no rail", async () => {
    for (const key of [new Uint8Array(32).fill(7), Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0))]) {
      const { w, capture } = await lockedWorld({ authority: key });
      const result = verdict(w, capture);
      expect(result.lock.railVerified).toBeNull();
      expect(result.lock.reason).toMatch(/upgrade authority/);
      expect(result.rail).toBeUndefined();
    }
  });

  it("a malformed authority option, a missing/non-executable/foreign-owned program, a missing ProgramData all fail closed", async () => {
    const programKey = SOL_HTLC_PROGRAM_ID;
    const pdKey = pubkeyToBase58(findProgramData());
    const cases: Array<[string, (w: World) => void, RegExp]> = [
      ["authority tag 2", (w) => w.chain.put(pdKey, { ...w.chain.accounts.get(pdKey)!, data: Uint8Array.from(w.chain.accounts.get(pdKey)!.data, (b, i) => (i === 12 ? 2 : b)) }), /malformed/],
      ["program missing", (w) => void w.chain.accounts.delete(programKey), /program account does not exist/],
      ["program not executable", (w) => w.chain.put(programKey, { ...w.chain.accounts.get(programKey)!, executable: false }), /not executable/],
      ["program wrong owner", (w) => w.chain.put(programKey, { ...w.chain.accounts.get(programKey)!, owner: TOKEN_PROGRAM_ID }), /upgradeable loader/],
      ["programdata missing", (w) => void w.chain.accounts.delete(pdKey), /ProgramData account does not exist/],
      ["programdata wrong owner", (w) => w.chain.put(pdKey, { ...w.chain.accounts.get(pdKey)!, owner: TOKEN_PROGRAM_ID }), /ProgramData account is not owned/],
      ["program points elsewhere", (w) => w.chain.put(programKey, { ...w.chain.accounts.get(programKey)!, data: Uint8Array.from(w.chain.accounts.get(programKey)!.data, (b, i) => (i === 4 ? b ^ 1 : b)) }), /not the one derived/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const w = makeWorld();
      putLockedEscrow(w);
      mutate(w);
      const result = verdict(w, await takeCapture(w));
      expect(result.lock.railVerified, name).toBeNull();
      expect(result.lock.reason, name).toMatch(pattern);
      expect(result.rail, name).toBeUndefined();
    }
  });
});

function findProgramData(): Uint8Array {
  const w = makeWorld();
  const program = w.chain.get(pubkeyFromBase58(SOL_HTLC_PROGRAM_ID))!;
  return program.data.slice(4, 36);
}

// -- binding and tampering ----------------------------------------------------------------------------------

describe("solEvidence - binding (splice, tamper, index-only edits)", () => {
  it("F2: an exchange spliced in from a capture with another nonce is refused, and so is one moved to another position", async () => {
    const w = makeWorld();
    withEscrow(w, { status: "Refunded", vaultAmount: 0n });
    const donor = await takeCapture(w); // a real capture of a refunded escrow
    putLockedEscrow(w);
    const genuine = await takeCapture(w);
    expect(donor.index.nonce).not.toBe(genuine.index.nonce);

    const spliced = clone(genuine);
    spliced.index.exchanges[2] = donor.index.exchanges[2]!;
    spliced.bytes.set(donor.index.exchanges[2]!.responseSha256, donor.bytes.get(donor.index.exchanges[2]!.responseSha256)!);
    const result = verdict(w, spliced);
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/id is not this capture's/);
    expect(result.rail).toBeUndefined();

    const moved = clone(genuine);
    [moved.index.exchanges[2], moved.index.exchanges[3]] = [moved.index.exchanges[3]!, moved.index.exchanges[2]!];
    expect(verdict(w, moved).lock.railVerified).toBeNull();
  });

  it("E6: an index-only rename of the pin/caip2 (top-level fields only) is refused", async () => {
    const { w, capture } = await lockedWorld();
    for (const mutate of [
      (i: SolCapture["index"]) => (i.pin = "solana-mainnet-beta"),
      (i: SolCapture["index"]) => (i.caip2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
      (i: SolCapture["index"]) => (i.endpoint = "http://elsewhere.invalid"),
    ]) {
      const c = clone(capture);
      mutate(c.index);
      const result = verdict(w, c);
      expect(result.lock.railVerified).toBeNull();
      expect(result.lock.reason).toMatch(/E6/);
      expect(result.rail).toBeUndefined();
    }
  });

  it("A4/D3: a captured config weaker than the auditor's (or simply different) is refused", async () => {
    const { w, capture } = await lockedWorld();
    const weaker: Array<[string, (c: SolRailConfig) => void, RegExp]> = [
      ["a different program hash", (c) => (c.programHash = "00".repeat(32)), /different rail config/],
      ["another mint", (c) => (c.assets = { USDC: OTHER_KEY }), /different rail config/],
      ["confirmed commitment", (c) => ((c.pin as { commitment: string }).commitment = "confirmed"), /invalid/],
      ["mainnet pin", (c) => (c.pin = { name: "solana-mainnet-beta", caip2: "solana:mainnet", commitment: "finalized" }), /mainnet/],
      ["devnet pin", (c) => (c.pin = SOL_DEVNET_PIN), /different rail config/],
      ["another program id", (c) => (c.programId = OTHER_KEY), /invalid/],
    ];
    for (const [name, mutate, pattern] of weaker) {
      const c = clone(capture);
      mutate(c.index.config);
      const result = verdict(w, c);
      expect(result.lock.railVerified, name).toBeNull();
      expect(result.lock.reason, name).toMatch(pattern);
      expect(result.rail, name).toBeUndefined();
    }
    // and the other way round: the auditor pins another hash than the one the capture ran under
    const auditor = { ...w.config, programHash: "11".repeat(32) };
    expect(verdict(w, capture, { config: auditor }).lock.railVerified).toBeNull();
    // an auditor config that is itself invalid never verifies anything
    const broken = { ...w.config, programId: OTHER_KEY };
    expect(verdict(w, capture, { config: broken }).lock.reason).toMatch(/auditor's own config is invalid/);
  });

  it("a request that is not the read this reader requires (lower minContextSlot, weaker commitment, another account, another method) is refused", async () => {
    const { w, capture } = await lockedWorld();
    const tampers: Array<[string, SolCapture]> = [
      ["lower minContextSlot", setRequest(capture, 2, (r) => ((r.params as [string, { minContextSlot: number }])[1].minContextSlot = 1))],
      ["confirmed commitment", setRequest(capture, 2, (r) => ((r.params as [string, { commitment: string }])[1].commitment = "confirmed"))],
      ["another account", setRequest(capture, 2, (r) => ((r.params as string[])[0] = OTHER_KEY))],
      ["processed slot", setRequest(capture, 1, (r) => (r.params = [{ commitment: "processed" }]))],
      ["another method", setRequest(capture, 2, (r) => (r.method = "getMultipleAccounts"))],
      ["index metadata edited but not the request", setRequest(capture, 2, (r) => ((r.params as string[])[0] = OTHER_KEY), false)],
    ];
    for (const [name, tampered] of tampers) {
      const result = verdict(w, tampered);
      expect(result.lock.railVerified, name).toBeNull();
      expect(result.lock.reason, name).toMatch(/missing\/tampered capture/);
      expect(result.rail, name).toBeUndefined();
    }
  });

  it("a response whose id is not its request's, an error reply, an undecodable body, missing bytes, missing or extra exchanges are all refused", async () => {
    const { w, capture } = await lockedWorld();
    const idSwapped = setResponse(capture, 2, (e) => (e.id = "another-id"));
    expect(verdict(w, idSwapped).lock.reason).toMatch(/response id does not match/);

    const rejected = setResponse(capture, 2, (e) => {
      delete e.result;
      e.error = { code: -32000, message: "boom" };
    });
    expect(verdict(w, rejected).lock.reason).toMatch(/rpc rejected getAccountInfo\(escrow\)/);

    const c = clone(capture);
    const garbage = new TextEncoder().encode("{not json");
    const sha = shaOf(garbage);
    c.bytes.set(sha, garbage);
    c.index.exchanges[3]!.responseSha256 = sha;
    expect(verdict(w, c).lock.reason).toMatch(/undecodable/);

    const noBytes = clone(capture);
    noBytes.bytes.delete(noBytes.index.exchanges[4]!.responseSha256);
    expect(verdict(w, noBytes).lock.reason).toMatch(/missing\/tampered capture/);

    const truncated = clone(capture);
    truncated.index.exchanges.pop();
    expect(verdict(w, truncated).lock.railVerified).toBeNull();

    const extra = clone(capture);
    extra.index.exchanges.push(extra.index.exchanges[2]!);
    expect(verdict(w, extra).lock.reason).toMatch(/unexpected extra exchanges/);

    for (const result of [idSwapped, rejected].map((cap) => verdict(w, cap))) expect(result.rail).toBeUndefined();
  });

  it("context slots: a read from before the pinned finalized slot, or reads that straddle two slots, are refused", async () => {
    const { w, capture } = await lockedWorld();
    const behind = setSlot(capture, 3, w.chain.finalizedSlot - 1);
    expect(verdict(w, behind).lock.reason).toMatch(/minContextSlot not honoured/);
    const straddled = setSlot(capture, 3, w.chain.finalizedSlot + 1);
    const result = verdict(w, straddled);
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/do not share one finalized context slot/);
    expect(result.rail).toBeUndefined();
  });

  it("the chain identity: a mainnet genesis is refused; the local pin refuses every public genesis; the devnet pin needs devnet's", async () => {
    const mainnet = makeWorld();
    mainnet.chain.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpExtra1111111111";
    putLockedEscrow(mainnet);
    expect(verdict(mainnet, await takeCapture(mainnet)).lock.reason).toMatch(/mainnet/);

    const devnetOnLocal = makeWorld();
    devnetOnLocal.chain.genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1Extra11111111111";
    putLockedEscrow(devnetOnLocal);
    expect(verdict(devnetOnLocal, await takeCapture(devnetOnLocal)).lock.reason).toMatch(/public cluster/);

    const devnet = makeWorld();
    devnet.chain.genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1Extra11111111111";
    putLockedEscrow(devnet);
    const config = { ...devnet.config, pin: SOL_DEVNET_PIN };
    const ok = verdict(devnet, await takeCapture(devnet, { config }), { config });
    expect(ok.lock.railVerified).toBe(true);
    expect(ok.rail?.finalizedRef).toBe("solana-devnet-UNVERIFIED:final:5000");

    const notDevnet = makeWorld();
    putLockedEscrow(notDevnet);
    const config2 = { ...notDevnet.config, pin: SOL_DEVNET_PIN };
    expect(verdict(notDevnet, await takeCapture(notDevnet, { config: config2 }), { config: config2 }).lock.reason).toMatch(/does not match pin/);
  });

  it("F1: a capture that did not complete carries its reason and never a verdict", async () => {
    const { w, capture } = await lockedWorld();
    const c = clone(capture);
    c.index.error = "fetch failed";
    const result = verdict(w, c);
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/chain read did not complete: fetch failed/);
    expect(result.rail).toBeUndefined();
  });

  it("the reader never throws, whatever the capture looks like", async () => {
    const { w, capture } = await lockedWorld();
    const garbage: unknown[] = [
      { index: { ...capture.index, exchanges: null }, bytes: capture.bytes },
      { index: { ...capture.index, config: null }, bytes: capture.bytes },
      { index: null, bytes: new Map() },
      { index: capture.index, bytes: null },
      {},
    ];
    for (const g of garbage) {
      const result = verdict(w, g as SolCapture);
      expect(result.lock.railVerified).toBeNull();
      expect(result.rail).toBeUndefined();
    }
    // wire values of the wrong shape
    for (const value of [null, 5, "x", [], { context: {}, value: 1 }, { context: { slot: 5000 }, value: { lamports: "1", owner: TOKEN_PROGRAM_ID, data: ["", "base64"], executable: false } }, { context: { slot: 5000 }, value: { lamports: 1, owner: TOKEN_PROGRAM_ID, data: ["%%%", "base64"], executable: false } }]) {
      const c = setResponse(capture, 3, (e) => (e.result = value));
      const result = verdict(w, c);
      expect(result.lock.railVerified).toBeNull();
    }
  });
});

// -- the live capture -----------------------------------------------------------------------------------------

describe("captureSolLeg", () => {
  it("F1/E2: a transport failure anywhere is a failure capture with index.error, never a throw and never a verdict", async () => {
    for (const method of ["getGenesisHash", "getSlot", "getAccountInfo"]) {
      const w = makeWorld();
      putLockedEscrow(w);
      w.chain.override(method, () => {
        throw new Error("socket hang up");
      });
      const capture = await takeCapture(w);
      expect(capture.index.error, method).toMatch(/socket hang up|fetch|hang/);
      const result = verdict(w, capture);
      expect(result.lock.railVerified, method).toBeNull();
      expect(result.lock.reason, method).toMatch(/did not complete/);
    }
  });

  it("a transport failure on a LATER read still fails the whole capture (never a partial sequence read as complete)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    let calls = 0;
    w.chain.override("getAccountInfo", (p, c) => {
      calls += 1;
      if (calls === 4) throw new Error("connection reset");
      const cfg = p[1] as { commitment?: string };
      const a = c.accounts.get(p[0] as string);
      return {
        context: c.ctx(cfg.commitment),
        value: a === undefined ? null : { lamports: a.lamports, owner: a.owner, data: [base64.encode(a.data), "base64"], executable: a.executable },
      };
    });
    const capture = await takeCapture(w);
    expect(capture.index.error).toMatch(/connection reset/);
    expect(verdict(w, capture).lock.railVerified).toBeNull();
  });

  it("a JSON-RPC error reply is a completed read (no index.error); the reader reports it", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.once("getAccountInfo", () => {
      throw new FakeRpcError(-32016, "Minimum context slot has not been reached", { contextSlot: 1 });
    });
    const capture = await takeCapture(w);
    expect(capture.index.error).toBeUndefined();
    const result = verdict(w, capture);
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/rpc rejected getAccountInfo\(escrow\)/);
  });

  it("E5: a response over the byte cap is a failure capture, not a completed read", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const rpc = new CapturingRpc({ endpoint: w.config.endpoint, fetch: w.chain.fetch, clock: () => 5000, maxResponseBytes: 600 });
    const { index } = await captureSolLeg(rpc, w.config, termsFor(w), accountsFor(w), w.ref, NOW);
    expect(index.error).toMatch(/maxResponseBytes/);
  });

  it("a malformed genesis or slot reply stops the sequence without an error and the reader reports it", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.override("getSlot", () => "not-a-slot");
    const capture = await takeCapture(w);
    expect(capture.index.exchanges).toHaveLength(2);
    expect(verdict(w, capture).lock.railVerified).toBeNull();
  });

  it("an invalid ref (not this terms' hash lock) reads nothing at all", async () => {
    const { w } = await lockedWorld();
    const before = w.chain.requests.length;
    const { index, exchanges } = await captureSolLeg(w.rpc, w.config, termsFor(w), accountsFor(w), `0x${"cd".repeat(32)}:${w.buyer.publicKey}`, NOW);
    expect(exchanges).toEqual([]);
    expect(index.exchanges).toEqual([]);
    expect(w.chain.requests.length).toBe(before);
  });

  it("a read sequence that straddled two finalized slots is retried and only the good attempt is kept", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    let n = 0;
    w.chain.override("getAccountInfo", (p, c) => {
      n += 1;
      const cfg = p[1] as { commitment?: string };
      const a = c.accounts.get(p[0] as string);
      const slot = n === 1 ? c.finalizedSlot + 1 : c.finalizedSlot; // only the very first read of attempt 1 is a slot ahead
      return { context: { slot }, value: a === undefined ? null : { lamports: a.lamports, owner: a.owner, data: [base64.encode(a.data), "base64"], executable: a.executable } };
    });
    const capture = await takeCapture(w);
    expect(w.chain.count("getSlot")).toBe(2);
    expect(capture.index.exchanges).toHaveLength(7);
    expect(verdict(w, capture).lock.railVerified).toBe(true);
    // the kept attempt's ids all carry ITS nonce
    for (const [i, e] of capture.index.exchanges.entries()) expect((JSON.parse(e.requestBody) as { id: string }).id).toBe(`${w.ref}:${NOW}:${capture.index.nonce}:${i + 1}`);
  });

  it("a sequence that always straddles gives up after SOL_CAPTURE_ATTEMPTS and the reader refuses the mixed view", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    let n = 0;
    w.chain.override("getAccountInfo", (p, c) => {
      n += 1;
      const a = c.accounts.get(p[0] as string);
      return { context: { slot: c.finalizedSlot + (n % 2) }, value: a === undefined ? null : { lamports: a.lamports, owner: a.owner, data: [base64.encode(a.data), "base64"], executable: a.executable } };
    });
    const capture = await takeCapture(w);
    expect(w.chain.count("getSlot")).toBe(SOL_CAPTURE_ATTEMPTS);
    const result = verdict(w, capture);
    expect(result.lock.railVerified).toBeNull();
    expect(result.lock.reason).toMatch(/do not share one finalized context slot/);
  });
});

// -- disk round trip, newest-only, keyed by hash lock + leg contract ----------------------------------------------

describe("loadSolCapture", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "flop-swap-desk-sol-evidence-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function persist(w: World, stamp: string, legContract = LEG_CONTRACT): Promise<SolCapture> {
    const { index, exchanges } = await captureSolLeg(w.rpc, w.config, termsFor(w), accountsFor(w), w.ref, NOW);
    await writeCapture(root, exchanges);
    const dir = solCaptureDir(root, w.hashLock, legContract);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${stamp}.json`), JSON.stringify(index), "utf8");
    return { index, bytes: verifiedExchangeBytes(exchanges) };
  }

  it("live and replayed verdicts agree, byte for byte", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const live = await persist(w, "2026-09-30T00-00-00-000Z");
    const loaded = await loadSolCapture(root, w.ref, LEG_CONTRACT);
    expect(loaded.skipped).toEqual([]);
    expect(loaded.capture).not.toBeNull();
    expect(verdict(w, loaded.capture!)).toEqual(verdict(w, live));
    expect(verdict(w, loaded.capture!).lock.railVerified).toBe(true);
  });

  it("no directory -> no capture and no skip", async () => {
    const w = makeWorld();
    expect(await loadSolCapture(root, w.ref, LEG_CONTRACT)).toEqual({ capture: null, skipped: [] });
  });

  it("only the NEWEST index is read; a broken newest fails the leg closed and never falls back to an older good one", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    await persist(w, "2026-09-30T00-00-00-000Z");
    const dir = solCaptureDir(root, w.hashLock, LEG_CONTRACT);
    await writeFile(join(dir, "2026-09-30T00-00-01-000Z.json"), "{ not json", "utf8");
    const loaded = await loadSolCapture(root, w.ref, LEG_CONTRACT);
    expect(loaded.capture).toBeNull();
    expect(loaded.skipped).toEqual(["2026-09-30T00-00-01-000Z.json"]);
    // an index for another ref is also refused
    await writeFile(join(dir, "2026-09-30T00-00-02-000Z.json"), JSON.stringify({ ...(await takeCapture(w)).index, ref: `${w.hashLock}:${OTHER_KEY}` }), "utf8");
    expect((await loadSolCapture(root, w.ref, LEG_CONTRACT)).capture).toBeNull();
  });

  it("E1: two legs sharing a hash lock are keyed by leg contract and never see or overwrite each other", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const otherLeg = `0x${"33".repeat(32)}`;
    await persist(w, "only", LEG_CONTRACT);
    expect((await loadSolCapture(root, w.ref, otherLeg)).capture).toBeNull();
    withEscrow(w, { status: "Refunded", vaultAmount: 0n });
    const theirs = await persist(w, "only", otherLeg);
    expect((await loadSolCapture(root, w.ref, otherLeg)).capture?.index.nonce).toBe(theirs.index.nonce);
    expect(verdict(w, (await loadSolCapture(root, w.ref, LEG_CONTRACT)).capture!).lock.railVerified).toBe(true);
    expect(solCaptureKey(w.hashLock, LEG_CONTRACT)).not.toBe(solCaptureKey(w.hashLock, otherLeg));
    expect(solCaptureKey(w.hashLock, LEG_CONTRACT)).toBe(`${w.hashLock}:${LEG_CONTRACT}`);
  });

  it("a malformed leg contract or ref is refused before touching the filesystem", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    await persist(w, "only");
    for (const bad of ["../../etc/passwd", "not-a-contract-id", `0x${"AB".repeat(32)}`]) {
      expect(await loadSolCapture(root, w.ref, bad)).toEqual({ capture: null, skipped: [] });
    }
    expect(await loadSolCapture(root, w.hashLock, LEG_CONTRACT)).toEqual({ capture: null, skipped: [] });
  });

  it("tampered response bytes on disk are refused by the loader's re-hash (the exchange reads as missing)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const live = await persist(w, "only");
    const sha = live.index.exchanges[2]!.responseSha256;
    await writeFile(join(root, "raw", "rpc", `${sha}.json`), "{}", "utf8");
    const loaded = await loadSolCapture(root, w.ref, LEG_CONTRACT);
    expect(verdict(w, loaded.capture!).lock.railVerified).toBeNull();
  });
});
