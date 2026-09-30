// SPDX-License-Identifier: MIT
//
// tests/sol-htlc.test.ts - the `sol-htlc` adapter against a scripted fake Solana node
// (tests/helpers/sol-fake-chain.ts), through the real CapturingRpc. Every guard below has a test that fails
// without it. The program itself is exercised by contracts-sol's Rust tests and, in SB-int, by the real
// validator; nothing here claims the fake node behaves like the runtime.
//
// Hole classes carried over from the NEAR review rounds (handoff/P5-NEAR-FIXES.md, P5-NEAR-SQUAT-FIX.md)
// and the program's own client duties (contracts-sol/README.md, finding S1) are marked in the test names.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";

import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { SolBlockhashNotFoundError, SolSimulationFailedError } from "../src/rails/sol-rpc.js";
import {
  SOL_CLAIM_LANDING_MARGIN_MS,
  SOL_DEVNET_PIN,
  SOL_HTLC_PROGRAM_ID,
  SOL_LOCAL_PIN,
  SOL_PREIMAGE_SCAN_MAX_TRANSACTIONS,
  SolClaimFailedError,
  SolClaimTooLateError,
  SolHtlcRail,
  SolLockRefusedError,
  SolNotLandedError,
  SolPendingError,
  SolRefundFailedError,
  SolTxFailedError,
  checkSolRailConfig,
  claimInstructionData,
  decodeEscrow,
  escrowAddress,
  formatSolRef,
  lockInstructionData,
  parseSolRef,
  refundInstructionData,
  validateSolRailConfig,
  vaultAddress,
  type SolPreparedRecord,
  type SolRailConfig,
} from "../src/rails/sol-htlc.js";
import { SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeTokenAccount } from "../src/rails/sol-spl.js";
import { InMemorySolSigner } from "../src/rails/sol-signer-memory.js";
import { compileLegacyMessage, findProgramAddress, isOnCurve, pubkeyFromBase58, pubkeyToBase58, signTransaction, type SolTransaction } from "../src/rails/sol-tx.js";
import {
  FAKE_PROGRAM_HASH,
  FakeRpcError,
  escrowBytes,
  makeWorld,
  putLockedEscrow,
  tokenAccountBytes,
  type World,
  type WorldOptions,
} from "./helpers/sol-fake-chain.js";

// -- harness ----------------------------------------------------------------------------------------------

async function railFor(w: World, signer: InMemorySolSigner = w.buyer, extra: Partial<Parameters<typeof SolHtlcRail.connect>[0]> = {}): Promise<SolHtlcRail> {
  return SolHtlcRail.connect({ config: w.config, rpc: w.rpc, signer, clock: w.clock, sleep: w.sleep, pollIntervalMs: 10, finalityTimeoutMs: 100, ...extra });
}

const OK = (): { slot: number; confirmations: null; err: null; confirmationStatus: "finalized" } => ({ slot: 5_000, confirmations: null, err: null, confirmationStatus: "finalized" });

/** A send that finalizes successfully and leaves the funded Locked escrow behind. */
function lockOnSend(w: World, sent?: SolTransaction[]): void {
  w.chain.onSend = (tx, chain) => {
    sent?.push(tx);
    chain.statuses.set(tx.signature, OK());
    putLockedEscrow(w);
  };
}

/** A send that finalizes successfully and leaves the escrow Claimed (payout to the seller's account). */
function claimOnSend(w: World, sent?: SolTransaction[]): void {
  w.chain.onSend = (tx, chain) => {
    sent?.push(tx);
    chain.statuses.set(tx.signature, OK());
    putLockedEscrow(w, { status: "Claimed", preimage: w.preimage, amount: 0n });
    chain.put(w.keys.sellerToken, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.seller.publicKeyBytes, amount: 1_000_000n }), executable: false });
  };
}

function refundOnSend(w: World, sent?: SolTransaction[]): void {
  w.chain.onSend = (tx, chain) => {
    sent?.push(tx);
    chain.statuses.set(tx.signature, OK());
    putLockedEscrow(w, { status: "Refunded", amount: 0n });
  };
}

const NOT_AFTER = (w: World): number => w.terms.claimByMs;
const CUSTOM = (n: number): unknown => ({ InstructionError: [0, { Custom: n }] });

// -- config -----------------------------------------------------------------------------------------------

describe("checkSolRailConfig / validateSolRailConfig", () => {
  const base = (): SolRailConfig => makeWorld().config;

  it("accepts the local pin and the devnet pin with the fixed program id", () => {
    expect(checkSolRailConfig(base())).toEqual({ ok: true, config: base() });
    expect(checkSolRailConfig({ ...base(), pin: SOL_DEVNET_PIN }).ok).toBe(true);
  });

  it("the program id constant is base58(sha256('flop-swap-desk:sol-htlc:v1'))", () => {
    expect(base58.encode(sha256(new TextEncoder().encode("flop-swap-desk:sol-htlc:v1")))).toBe(SOL_HTLC_PROGRAM_ID);
  });

  it("rejects non-objects and each malformed field, naming the field", () => {
    const c = base();
    const cases: Array<[unknown, RegExp]> = [
      [null, /not an object/],
      [{ ...c, pin: null }, /pin/],
      [{ ...c, pin: { ...c.pin, caip2: "solana:" } }, /caip2/],
      [{ ...c, pin: { ...c.pin, commitment: "confirmed" } }, /commitment/],
      [{ ...c, endpoint: "" }, /endpoint/],
      [{ ...c, programId: "notakey" }, /programId/],
      [{ ...c, programHash: "abc" }, /programHash/],
      [{ ...c, programHash: FAKE_PROGRAM_HASH.toUpperCase() }, /programHash/],
      [{ ...c, programHash: undefined }, /programHash/],
      [{ ...c, assets: {} }, /assets\.USDC/],
      [{ ...c, assets: { USDC: "0OIl" } }, /assets\.USDC/],
      [{ ...c, assets: null }, /assets/],
    ];
    for (const [value, reason] of cases) expect(checkSolRailConfig(value), JSON.stringify(reason)).toEqual({ ok: false, reason: expect.stringMatching(reason) });
  });

  it("refuses mainnet by name and by its genesis-prefix caip2, and any chain not on the allow list", () => {
    const c = base();
    expect(() => validateSolRailConfig({ ...c, pin: { name: "solana-mainnet-beta", caip2: "solana:mainnet", commitment: "finalized" } })).toThrow(/mainnet/);
    expect(() => validateSolRailConfig({ ...c, pin: { name: "anything", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", commitment: "finalized" } })).toThrow(/mainnet/);
    expect(() => validateSolRailConfig({ ...c, pin: { name: "solana-testnet", caip2: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z", commitment: "finalized" } })).toThrow(/allow list/);
  });

  it("refuses a renamed known pin, a program id other than the fixed one, and a program id used as the mint", () => {
    const c = base();
    expect(() => validateSolRailConfig({ ...c, pin: { ...SOL_LOCAL_PIN, name: "renamed" } })).toThrow(/pin\.name/);
    expect(() => validateSolRailConfig({ ...c, programId: pubkeyToBase58(new Uint8Array(32).fill(5)) })).toThrow(/fixed keyless id/);
    expect(() => validateSolRailConfig({ ...c, assets: { USDC: TOKEN_PROGRAM_ID } })).toThrow(/mint address/);
    expect(() => validateSolRailConfig({ ...c, assets: { USDC: SYSTEM_PROGRAM_ID } })).toThrow(/mint address/);
  });
});

describe("refs", () => {
  const hl = `0x${"ab".repeat(32)}`;
  const payer = pubkeyToBase58(new Uint8Array(32).fill(3));

  it("format and parse round-trip; anything else is invalid", () => {
    const ref = formatSolRef(hl, payer);
    expect(ref).toBe(`${hl}:${payer}`);
    expect(parseSolRef(ref)).toEqual({ hashLock: hl, payer });
    for (const bad of [hl, `${hl}:`, `${hl.toUpperCase()}:${payer}`, `${hl}:${payer}${payer}`, `0x${"ab".repeat(31)}:${payer}`, `${hl}:${payer.slice(0, 30)}`, `${hl}: ${payer}`, `${hl}:${payer}:${payer}`, 42, null, undefined]) {
      expect(parseSolRef(bad), String(bad)).toBeNull();
    }
    expect(() => formatSolRef("0x12", payer)).toThrow();
    expect(() => formatSolRef(hl, "short")).toThrow();
  });
});

// -- connect ----------------------------------------------------------------------------------------------

describe("SolHtlcRail.connect", () => {
  it("reads the genesis, the program account, then ProgramData and the mint at one context, and drains its own exchanges", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    expect(rail).toBeInstanceOf(SolHtlcRail);
    expect(w.chain.requests.map((r) => r.method)).toEqual(["getGenesisHash", "getAccountInfo", "getMultipleAccounts"]);
    expect(w.rpc.exchanges()).toHaveLength(0);
  });

  it("refuses when the config is invalid, before any request", async () => {
    const w = makeWorld();
    await expect(SolHtlcRail.connect({ config: { ...w.config, programHash: "x" }, rpc: w.rpc, signer: w.buyer })).rejects.toThrow(/refusing to connect/);
    expect(w.chain.requests).toHaveLength(0);
  });

  it("refuses mainnet by its genesis hash, and a local pin on any public cluster's genesis", async () => {
    for (const genesis of ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoVCnqeeF"]) {
      const w = makeWorld();
      w.chain.genesisHash = genesis;
      await expect(railFor(w), genesis).rejects.toThrow(/mainnet|public cluster/);
    }
  });

  it("the devnet pin needs the matching genesis prefix", async () => {
    const w = makeWorld();
    w.config = { ...w.config, pin: SOL_DEVNET_PIN };
    await expect(railFor(w)).rejects.toThrow(/does not match pin/);
    w.chain.genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoVCnqeeF";
    await expect(railFor(w)).resolves.toBeInstanceOf(SolHtlcRail);
  });

  it("the pin is re-checked before every write: an endpoint that starts answering as mainnet is refused", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    w.chain.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    await expect(rail.prepareLock(w.terms)).rejects.toThrow(/mainnet/);
  });

  it("refuses a missing, non-executable, wrongly owned or malformed program account", async () => {
    const mutate = (fn: (w: World) => void): Promise<unknown> => {
      const w = makeWorld();
      fn(w);
      return railFor(w);
    };
    await expect(mutate((w) => w.chain.accounts.delete(SOL_HTLC_PROGRAM_ID))).rejects.toThrow(/does not exist/);
    await expect(mutate((w) => (w.chain.get(SOL_HTLC_PROGRAM_ID)!.executable = false))).rejects.toThrow(/not executable/);
    await expect(mutate((w) => (w.chain.get(SOL_HTLC_PROGRAM_ID)!.owner = SYSTEM_PROGRAM_ID))).rejects.toThrow(/upgradeable loader/);
    await expect(mutate((w) => (w.chain.get(SOL_HTLC_PROGRAM_ID)!.data = new Uint8Array(36)))).rejects.toThrow(/Program\{programdata_address\}/);
  });

  it("refuses a ProgramData address that is not the one derived for the program", async () => {
    const w = makeWorld();
    const acct = w.chain.get(SOL_HTLC_PROGRAM_ID)!;
    acct.data = acct.data.slice();
    acct.data.set(new Uint8Array(32).fill(9), 4);
    await expect(railFor(w)).rejects.toThrow(/not the one derived/);
  });

  it("refuses a ProgramData hash that does not match the pinned programHash (a different program)", async () => {
    const w = makeWorld();
    w.config = { ...w.config, programHash: bytesToHex(sha256(new Uint8Array([1, 2, 3]))) };
    await expect(railFor(w)).rejects.toThrow(/does not match the pinned programHash/);
  });

  it("accepts zero padding after the ELF, refuses non-zero bytes after it", async () => {
    await expect(railFor(makeWorld({ padding: 40 }))).resolves.toBeInstanceOf(SolHtlcRail);
    const w = makeWorld({ padding: 40 });
    const pdKey = pubkeyToBase58(findProgramAddress([pubkeyFromBase58(SOL_HTLC_PROGRAM_ID)], pubkeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")).address);
    w.chain.get(pdKey)!.data[w.chain.get(pdKey)!.data.length - 1] = 1;
    await expect(railFor(w)).rejects.toThrow(/does not match the pinned programHash/);
  });

  it("upgrade authority: None and the all-zero address are accepted; any other key, including a low-order point, is refused", async () => {
    await expect(railFor(makeWorld({ authority: "none" }))).resolves.toBeInstanceOf(SolHtlcRail);
    await expect(railFor(makeWorld({ authority: "zero" }))).resolves.toBeInstanceOf(SolHtlcRail);
    await expect(railFor(makeWorld({ authority: new Uint8Array(32).fill(7) }))).rejects.toThrow(/upgrade authority/);
    const identity = new Uint8Array(32);
    identity[0] = 1; // the ed25519 identity point (y = 1): a low-order key that is NOT the all-zero address
    await expect(railFor(makeWorld({ authority: identity }))).rejects.toThrow(/upgrade authority/);
    const w = makeWorld();
    const pdKey = pubkeyToBase58(findProgramAddress([pubkeyFromBase58(SOL_HTLC_PROGRAM_ID)], pubkeyFromBase58("BPFLoaderUpgradeab1e11111111111111111111111")).address);
    w.chain.get(pdKey)!.data[12] = 2; // a malformed option tag
    await expect(railFor(w)).rejects.toThrow(/malformed/);
  });

  it("refuses a missing, wrongly owned or uninitialised mint", async () => {
    const mk = (fn: (w: World) => void): Promise<unknown> => {
      const w = makeWorld();
      fn(w);
      return railFor(w);
    };
    await expect(mk((w) => w.chain.accounts.delete(w.config.assets.USDC))).rejects.toThrow(/mint account does not exist/);
    await expect(mk((w) => (w.chain.get(w.config.assets.USDC)!.owner = SYSTEM_PROGRAM_ID))).rejects.toThrow(/classic SPL mint/);
    await expect(mk((w) => (w.chain.get(w.config.assets.USDC)!.data[45] = 0))).rejects.toThrow(/not initialised/);
  });
});

// -- terms ------------------------------------------------------------------------------------------------

describe("prepareLock term validation (a payee that can never receive or spend is refused before signing)", () => {
  it("rejects malformed and unreceivable terms without sending anything", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    const { escrow } = { escrow: w.keys.escrow };
    const t = w.terms;
    const cases: Array<[Partial<typeof t>, RegExp]> = [
      [{ hashLock: "0xnothex" }, /hashLock/],
      [{ payee: "notakey" }, /payee must be a base58/],
      [{ payee: SYSTEM_PROGRAM_ID }, /system program/],
      [{ payee: SOL_HTLC_PROGRAM_ID }, /HTLC program/],
      [{ payee: TOKEN_PROGRAM_ID }, /token program/],
      [{ payee: w.config.assets.USDC }, /USDC mint/],
      [{ payee: pubkeyToBase58(escrow) }, /own escrow or vault/],
      [{ payee: pubkeyToBase58(w.keys.vault) }, /own escrow or vault/],
      [{ amount: "0" }, /amount/],
      [{ amount: "18446744073709551616" }, /amount/],
      [{ amount: "1.5" }, /amount/],
      [{ amount: "-1" }, /amount/],
      [{ claimByMs: t.refundAfterMs }, /strictly before/],
      [{ claimByMs: 0 }, /positive safe integers/],
      [{ refundAfterMs: 2 ** 60 }, /safe integers/],
    ];
    for (const [override, reason] of cases) await expect(rail.prepareLock({ ...t, ...override }), JSON.stringify(override)).rejects.toThrow(reason);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("refuses an off-curve payee (a program-derived address has no key that can spend from it)", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    const pda = findProgramAddress([new TextEncoder().encode("x")], pubkeyFromBase58(SOL_HTLC_PROGRAM_ID)).address;
    expect(isOnCurve(pda)).toBe(false);
    await expect(rail.prepareLock({ ...w.terms, payee: pubkeyToBase58(pda) })).rejects.toThrow(/on-curve/);
  });

  it("accepts a payee equal to the payer's own key (a legitimate self-swap is not this layer's business)", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    await expect(rail.prepareLock({ ...w.terms, payee: w.buyer.publicKey })).resolves.toBeDefined();
  });
});

// -- lock -------------------------------------------------------------------------------------------------

describe("prepareLock / commitLock", () => {
  it("records ref and signature before sending; commitLock simulates first, then sends exactly that signed transaction, waits finalized and returns evidence", async () => {
    const w = makeWorld();
    const sent: SolTransaction[] = [];
    lockOnSend(w, sent);
    const rail = await railFor(w);
    const record = await rail.prepareLock(w.terms);

    expect(record.kind).toBe("lock");
    expect(record.ref).toBe(w.ref);
    expect(base58.decode(record.signature)).toHaveLength(64);
    expect(record.blockhash).toBe(w.chain.blockhash);
    expect(record.lastValidBlockHeight).toBe(w.chain.lastValidBlockHeight);
    expect(w.chain.count("sendTransaction")).toBe(0); // nothing sent yet: record-before-send

    const evidence = await rail.commitLock();
    expect(evidence.ref).toBe(w.ref);
    expect(evidence.signature).toBe(record.signature);
    expect(evidence.slot).toBe(5_000);
    expect(evidence.raw.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.signature).toBe(record.signature);

    const methods = w.chain.requests.map((r) => r.method);
    expect(methods.indexOf("simulateTransaction")).toBeGreaterThan(-1);
    expect(methods.indexOf("simulateTransaction")).toBeLessThan(methods.indexOf("sendTransaction"));
    expect(methods.indexOf("sendTransaction")).toBeLessThan(methods.lastIndexOf("getSignatureStatuses"));
    // the confirmation read is the LAST thing: the escrow re-read at finalized with the status slot as minContextSlot
    const last = w.chain.requests[w.chain.requests.length - 1];
    expect(last?.method).toBe("getMultipleAccounts");
    expect(last?.params[1]).toMatchObject({ commitment: "finalized", minContextSlot: 5_000 });
  });

  it("the signed Lock transaction has the program's documented shape (89-byte data, account order and flags)", async () => {
    const w = makeWorld();
    const sent: SolTransaction[] = [];
    lockOnSend(w, sent);
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await rail.commitLock();
    const tx = sent[0] as SolTransaction;
    expect(tx.message.instructions).toHaveLength(1);
    const ix = tx.message.instructions[0]!;
    const keys = tx.message.accountKeys.map(pubkeyToBase58);
    expect(keys[ix.programIdIndex]).toBe(SOL_HTLC_PROGRAM_ID);
    expect(ix.data).toHaveLength(89);
    expect(ix.data[0]).toBe(0);
    expect(bytesToHex(ix.data.slice(1, 33))).toBe(w.hashLock.slice(2));
    expect(pubkeyToBase58(ix.data.slice(33, 65))).toBe(w.seller.publicKey);
    const view = new DataView(ix.data.buffer, ix.data.byteOffset);
    expect(Number(view.getBigInt64(65, true))).toBe(w.terms.claimByMs);
    expect(Number(view.getBigInt64(73, true))).toBe(w.terms.refundAfterMs);
    expect(view.getBigUint64(81, true)).toBe(1_000_000n);
    expect(Array.from(ix.data)).toEqual(Array.from(lockInstructionData(w.terms)));
    // accounts: payer, escrow, vault, mint, payer token account, token program, system program
    expect(ix.accountIndexes.map((i) => keys[i])).toEqual([
      w.buyer.publicKey,
      pubkeyToBase58(w.keys.escrow),
      pubkeyToBase58(w.keys.vault),
      w.config.assets.USDC,
      pubkeyToBase58(w.keys.buyerToken),
      TOKEN_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
    ]);
    expect(tx.message.header).toMatchObject({ numRequiredSignatures: 1, numReadonlySigned: 0 });
  });

  it("commitLock without a prepared lock throws, and cannot be called twice for one prepareLock", async () => {
    const w = makeWorld();
    lockOnSend(w);
    const rail = await railFor(w);
    await expect(rail.commitLock()).rejects.toThrow(/call prepareLock first/);
    await rail.prepareLock(w.terms);
    await rail.commitLock();
    await expect(rail.commitLock()).rejects.toThrow(/call prepareLock first/);
    expect(w.chain.count("sendTransaction")).toBe(1);
  });

  it("refuses to lock when an escrow already exists for this payer and hash lock, but a pre-funded system-owned account does not block", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    await expect((await railFor(w)).prepareLock(w.terms)).rejects.toThrow(/already exists/);
    const w2 = makeWorld();
    w2.chain.put(w2.keys.escrow, { lamports: 5_000_000, owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(0), executable: false });
    await expect((await railFor(w2)).prepareLock(w2.terms)).resolves.toBeDefined();
  });

  it("a squat by another payer under the same public hash lock does not block this payer's lock (keyed by payer)", async () => {
    const w = makeWorld();
    const squatter = InMemorySolSigner.generate(new Uint8Array(32).fill(9));
    const squatEscrow = escrowAddress(SOL_HTLC_PROGRAM_ID, squatter.publicKey, w.hashLock).address;
    expect(pubkeyToBase58(squatEscrow)).not.toBe(pubkeyToBase58(w.keys.escrow));
    w.chain.put(squatEscrow, { lamports: 1, owner: SOL_HTLC_PROGRAM_ID, data: escrowBytes({ bump: 1, payer: squatter.publicKeyBytes, payee: squatter.publicKeyBytes, mint: w.mint, hashLock: pubkeyFromBase58(pubkeyToBase58(sha256(w.preimage))), amount: 1n, claimByMs: 1, refundAfterMs: 2 }), executable: false });
    lockOnSend(w);
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).resolves.toMatchObject({ ref: w.ref });
  });

  it("refuses when the payer's token account is missing, frozen, for another mint, foreign-owned, wrongly owned by program, or too small", async () => {
    const mk = async (fn: (w: World) => void, reason: RegExp): Promise<void> => {
      const w = makeWorld();
      fn(w);
      await expect((await railFor(w)).prepareLock(w.terms)).rejects.toThrow(reason);
    };
    await mk((w) => w.chain.accounts.delete(pubkeyToBase58(w.keys.buyerToken)), /does not exist/);
    await mk((w) => (w.chain.get(w.keys.buyerToken)!.data[108] = 2), /frozen/);
    await mk((w) => (w.chain.get(w.keys.buyerToken)!.data[108] = 0), /not initialised/);
    await mk((w) => w.chain.get(w.keys.buyerToken)!.data.set(new Uint8Array(32).fill(1), 0), /different mint/);
    await mk((w) => w.chain.get(w.keys.buyerToken)!.data.set(new Uint8Array(32).fill(1), 32), /different wallet/);
    await mk((w) => (w.chain.get(w.keys.buyerToken)!.owner = SYSTEM_PROGRAM_ID), /classic token program/);
    await mk((w) => (w.chain.get(w.keys.buyerToken)!.data = new Uint8Array(200)), /165/);
    await mk((w) => new DataView(w.chain.get(w.keys.buyerToken)!.data.buffer).setBigUint64(64, 10n, true), /holds less/);
  });

  it("a simulation that fails throws SolSimulationFailedError and NOTHING is sent", async () => {
    const w = makeWorld();
    w.chain.simulateErr = CUSTOM(15);
    w.chain.simulateLogs = ["Program log: boom"];
    lockOnSend(w);
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    const error = await rail.commitLock().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolSimulationFailedError);
    expect((error as SolSimulationFailedError).phase).toBe("simulate");
    expect((error as SolSimulationFailedError).logs).toEqual(["Program log: boom"]);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("a simulated BlockhashNotFound is typed and nothing is sent", async () => {
    const w = makeWorld();
    w.chain.simulateErr = "BlockhashNotFound";
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).rejects.toBeInstanceOf(SolBlockhashNotFoundError);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("a preflight refusal at send (-32002, structured data.err) is typed from the structured cause", async () => {
    const w = makeWorld();
    w.chain.override("sendTransaction", () => {
      throw new FakeRpcError(-32002, "Transaction simulation failed: Error processing Instruction 0: custom program error: 0xf", { err: CUSTOM(15), logs: ["l1"], unitsConsumed: 7 });
    });
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    const error = await rail.commitLock().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolSimulationFailedError);
    expect((error as SolSimulationFailedError).phase).toBe("preflight");
    expect((error as SolSimulationFailedError).err).toEqual(CUSTOM(15));
  });

  it("S3-class: a lock that FAILS on chain is SolLockRefusedError (a SolTxFailedError) carrying the program's error name", async () => {
    const w = makeWorld();
    w.chain.onSend = (tx, chain) => chain.statuses.set(tx.signature, { slot: 5_000, confirmations: null, err: CUSTOM(15), confirmationStatus: "finalized" });
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    const error = await rail.commitLock().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolLockRefusedError);
    expect(error).toBeInstanceOf(SolTxFailedError);
    expect((error as SolLockRefusedError).programError).toEqual({ code: 15, name: "EscrowExists" });
    expect((error as SolLockRefusedError).raw.length).toBeGreaterThan(0);
  });

  it("H1: a lock whose transaction succeeded but whose escrow does not hold the terms (no escrow, wrong amount, wrong payee, wrong payer, short vault) is refused", async () => {
    const scenarios: Array<[string, (w: World) => void]> = [
      ["no escrow", () => undefined],
      ["wrong amount", (w) => putLockedEscrow(w, { amount: 999n })],
      ["wrong payee", (w) => putLockedEscrow(w, { payee: new Uint8Array(32).fill(4) })],
      ["not Locked", (w) => putLockedEscrow(w, { status: "Refunded" })],
      ["short vault", (w) => {
        putLockedEscrow(w);
        w.chain.put(w.keys.vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.keys.escrow, amount: 1n }), executable: false });
      }],
      ["a stranger's escrow (different payer field)", (w) => {
        putLockedEscrow(w);
        w.chain.get(w.keys.escrow)!.data.set(new Uint8Array(32).fill(8), 4);
      }],
    ];
    for (const [name, apply] of scenarios) {
      const w = makeWorld();
      w.chain.onSend = (tx, chain) => {
        chain.statuses.set(tx.signature, OK());
        apply(w);
      };
      const rail = await railFor(w);
      await rail.prepareLock(w.terms);
      await expect(rail.commitLock(), name).rejects.toBeInstanceOf(name === "a stranger's escrow (different payer field)" ? Error : SolLockRefusedError);
    }
  });

  it("waits for FINALIZED: a confirmed-only status is not evidence, and it settles once finalized", async () => {
    const w = makeWorld();
    w.chain.onSend = (tx, chain) => {
      chain.statuses.set(tx.signature, { slot: 5_000, confirmations: 3, err: null, confirmationStatus: "confirmed" });
      putLockedEscrow(w);
      let polls = 0;
      chain.override("getSignatureStatuses", (p) => {
        polls += 1;
        if (polls >= 3) chain.statuses.set(tx.signature, OK());
        return { context: { slot: 1 }, value: (p[0] as string[]).map((s) => chain.statuses.get(s) ?? null) };
      });
    };
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).resolves.toMatchObject({ slot: 5_000 });
    expect(w.chain.count("getSignatureStatuses")).toBe(3);
  });

  it("never finalizing within the timeout is SolPendingError, not a verdict", async () => {
    const w = makeWorld();
    w.chain.onSend = (tx, chain) => chain.statuses.set(tx.signature, { slot: 5_000, confirmations: 3, err: null, confirmationStatus: "confirmed" });
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).rejects.toBeInstanceOf(SolPendingError);
  });

  it("no status and a blockhash that has NOT expired is pending; expired (finalized height past lastValidBlockHeight) is SolNotLandedError", async () => {
    const w = makeWorld();
    w.chain.onSend = () => undefined; // dropped by the network
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).rejects.toBeInstanceOf(SolPendingError);

    const w2 = makeWorld();
    w2.chain.onSend = () => undefined;
    const rail2 = await railFor(w2);
    await rail2.prepareLock(w2.terms);
    w2.chain.finalizedHeight = w2.chain.lastValidBlockHeight + 1;
    await expect(rail2.commitLock()).rejects.toBeInstanceOf(SolNotLandedError);
  });

  it("the height is read BEFORE the status: a transaction that lands between a past-expiry height read and the status read is found, never NotLanded", async () => {
    const w = makeWorld();
    w.chain.onSend = () => undefined; // sent; not visible yet
    const rail = await railFor(w);
    const record = await rail.prepareLock(w.terms);
    w.chain.once("getBlockHeight", (_p, chain) => {
      // the height read reports expiry, and the transaction lands right after it
      chain.statuses.set(record.signature, OK());
      putLockedEscrow(w);
      return record.lastValidBlockHeight + 1;
    });
    await expect(rail.commitLock()).resolves.toMatchObject({ ref: w.ref });
  });

  it("a transport failure during send rethrows unchanged (not folded into 'never landed'), and recovery by the recorded signature then finds the lock", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    const record = await rail.prepareLock(w.terms);
    w.chain.override("sendTransaction", () => {
      // the send reached the network, the reply was lost
      lockOnSend(w);
      w.chain.statuses.set(record.signature, OK());
      putLockedEscrow(w);
      throw new Error("socket hang up");
    });
    await expect(rail.commitLock()).rejects.toThrow(/socket hang up/);
    const evidence = await rail.recoverBySignature(record);
    expect(evidence).toMatchObject({ ref: w.ref, signature: record.signature, slot: 5_000 });
  });

  it("refuses when the node reports a different signature than the recorded one", async () => {
    const w = makeWorld();
    w.chain.override("sendTransaction", () => base58.encode(new Uint8Array(64).fill(3)));
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).rejects.toThrow(/not the recorded/);
  });

  it("retries a confirmation read while the node has not reached the status slot (-32016), then succeeds", async () => {
    const w = makeWorld();
    lockOnSend(w);
    let first = true;
    const original = w.chain;
    original.onSend = (tx, chain) => {
      chain.statuses.set(tx.signature, OK());
      putLockedEscrow(w);
      chain.once("getMultipleAccounts", () => {
        first = false;
        throw new FakeRpcError(-32016, "Minimum context slot has not been reached", { contextSlot: 4_990 });
      });
    };
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await expect(rail.commitLock()).resolves.toMatchObject({ ref: w.ref });
    expect(first).toBe(false);
  });
});

// -- claim ------------------------------------------------------------------------------------------------

describe("claim", () => {
  it("claims a Locked escrow: records the signature BEFORE sending, simulates first, sends, waits finalized and confirms Claimed with the preimage", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const sent: SolTransaction[] = [];
    claimOnSend(w, sent);
    const rail = await railFor(w, w.seller);
    const recorded: SolPreparedRecord[] = [];
    const evidence = await rail.claim(w.ref, w.preimageHex, NOT_AFTER(w), (record) => {
      expect(w.chain.count("sendTransaction")).toBe(0); // record-before-send
      recorded.push(record);
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.kind).toBe("claim");
    expect(evidence.signature).toBe(recorded[0]?.signature);
    const methods = w.chain.requests.map((r) => r.method);
    expect(methods.indexOf("simulateTransaction")).toBeLessThan(methods.indexOf("sendTransaction"));

    const tx = sent[0] as SolTransaction;
    const keys = tx.message.accountKeys.map(pubkeyToBase58);
    const ix = tx.message.instructions[0]!;
    expect(Array.from(ix.data)).toEqual(Array.from(claimInstructionData(w.preimage)));
    expect(ix.data).toHaveLength(33);
    expect(ix.accountIndexes.map((i) => keys[i])).toEqual([pubkeyToBase58(w.keys.escrow), pubkeyToBase58(w.keys.vault), w.config.assets.USDC, pubkeyToBase58(w.keys.sellerToken), TOKEN_PROGRAM_ID]);
    // permissionless: the fee payer is the only signer
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(keys[0]).toBe(w.seller.publicKey);
  });

  it("refuses a preimage that does not open the hash lock, or a malformed one, before any read", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const rail = await railFor(w, w.seller);
    const before = w.chain.requests.length;
    await expect(rail.claim(w.ref, `0x${"00".repeat(32)}`, NOT_AFTER(w))).rejects.toThrow(/does not open hashLock/);
    await expect(rail.claim(w.ref, "0x12", NOT_AFTER(w))).rejects.toThrow(/preimage must be/);
    await expect(rail.claim("garbage", w.preimageHex, NOT_AFTER(w))).rejects.toThrow(/ref must be/);
    expect(w.chain.requests.length).toBe(before);
  });

  it("no-secret pre-checks: a missing, Claimed or Refunded escrow, a payee account that is missing, frozen, for another mint or owned by someone else, or a short vault, are refused and nothing is sent", async () => {
    const cases: Array<[string, (w: World) => void, RegExp]> = [
      ["no escrow", () => undefined, /got none/],
      ["claimed", (w) => putLockedEscrow(w, { status: "Claimed", preimage: w.preimage }), /got Claimed/],
      ["refunded", (w) => putLockedEscrow(w, { status: "Refunded" }), /got Refunded/],
      ["payee ata missing", (w) => {
        putLockedEscrow(w);
        w.chain.accounts.delete(pubkeyToBase58(w.keys.sellerToken));
      }, /payee's associated token account does not exist/],
      ["payee ata frozen", (w) => {
        putLockedEscrow(w);
        w.chain.get(w.keys.sellerToken)!.data[108] = 2;
      }, /frozen/],
      ["payee ata other mint", (w) => {
        putLockedEscrow(w);
        w.chain.get(w.keys.sellerToken)!.data.set(new Uint8Array(32).fill(1), 0);
      }, /different mint/],
      ["payee ata other owner", (w) => {
        putLockedEscrow(w);
        w.chain.get(w.keys.sellerToken)!.data.set(new Uint8Array(32).fill(1), 32);
      }, /different wallet/],
      ["short vault", (w) => {
        putLockedEscrow(w);
        w.chain.put(w.keys.vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.keys.escrow, amount: 5n }), executable: false });
      }, /vault holds less/],
      ["vault frozen", (w) => {
        putLockedEscrow(w);
        w.chain.get(w.keys.vault)!.data[108] = 2;
      }, /vault is frozen/],
      ["escrow for another mint", (w) => {
        putLockedEscrow(w);
        w.chain.get(w.keys.escrow)!.data.set(new Uint8Array(32).fill(1), 68);
      }, /different mint/],
    ];
    for (const [name, apply, reason] of cases) {
      const w = makeWorld();
      apply(w);
      const rail = await railFor(w, w.seller);
      await expect(rail.claim(w.ref, w.preimageHex, NOT_AFTER(w)), name).rejects.toThrow(reason);
      expect(w.chain.count("sendTransaction"), name).toBe(0);
      expect(w.chain.count("simulateTransaction"), name).toBe(0);
    }
  });

  it("refuses when the clock is already at/after refundAfterMs, even before the finalized chain time gets there", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const rail = await railFor(w, w.seller);
    w.now.ms = w.terms.refundAfterMs; // the injected clock, not the chain
    await expect(rail.claim(w.ref, w.preimageHex, NOT_AFTER(w))).rejects.toThrow(/at\/after refundAfterMs/);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("H3: notAfterMs must leave the landing margin before refundAfterMs (exactly at the margin is allowed, one ms over is refused)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    const edge = w.terms.refundAfterMs - SOL_CLAIM_LANDING_MARGIN_MS;
    await expect(rail.claim(w.ref, w.preimageHex, edge + 1)).rejects.toThrow(/landing margin/);
    expect(w.chain.count("sendTransaction")).toBe(0);
    await expect(rail.claim(w.ref, w.preimageHex, edge)).resolves.toMatchObject({ ref: w.ref });
    expect(SOL_CLAIM_LANDING_MARGIN_MS).toBe(150 * 600 + 30_000);
  });

  it("S1: a blockhash that could still land after refundAfterMs minus the margin is refused (SolClaimTooLateError), so a late claim is never executed and never publishes the secret", async () => {
    // refundAfter 130 s out: notAfterMs passes the 120 s margin rule, but a fresh blockhash (181 blocks left at
    // 600 ms = 108.6 s, plus the 30 s margin = 138.6 s) could still land past it.
    const w = makeWorld({ refundAfterMs: 1_800_000_000_000 + 130_000, claimByMs: 1_800_000_000_000 + 5_000 });
    putLockedEscrow(w);
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).rejects.toBeInstanceOf(SolClaimTooLateError);
    expect(w.chain.count("sendTransaction")).toBe(0);
    expect(w.chain.count("simulateTransaction")).toBe(0);
  });

  it("S1: the landing bound uses the remaining blocks: a blockhash with few blocks left is accepted where a fresh one is refused", async () => {
    const w = makeWorld({ refundAfterMs: 1_800_000_000_000 + 130_000, claimByMs: 1_800_000_000_000 + 5_000 });
    putLockedEscrow(w);
    claimOnSend(w);
    w.chain.lastValidBlockHeight = w.chain.finalizedHeight + 100; // 100 blocks * 600 = 60 s + 30 s < 130 s
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).resolves.toMatchObject({ ref: w.ref });
  });

  it("S1: the timing override is harness-only and validated", async () => {
    const w = makeWorld({ refundAfterMs: 1_800_000_000_000 + 130_000, claimByMs: 1_800_000_000_000 + 5_000 });
    putLockedEscrow(w);
    claimOnSend(w);
    const fast = await railFor(w, w.seller, { timing: { slowBlockMs: 400, expiryMarginMs: 5_000 } });
    await expect(fast.claim(w.ref, w.preimageHex, w.terms.claimByMs)).resolves.toBeDefined(); // 181*400 + 5000 = 77.4 s
    await expect(railFor(w, w.seller, { timing: { slowBlockMs: 0 } })).rejects.toThrow(/timing overrides/);
  });

  it("S1: a claim the runtime would refuse (simulation error, e.g. ClaimWindowClosed) is NEVER sent, so the secret is not published", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.simulateErr = CUSTOM(19);
    claimOnSend(w);
    const rail = await railFor(w, w.seller);
    const error = await rail.claim(w.ref, w.preimageHex, NOT_AFTER(w)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolSimulationFailedError);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("H3: the last-moment guard judges notAfterMs against max(chain time, clock): a clock that moved past the deadline during simulation stops the send", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    claimOnSend(w);
    w.chain.override("simulateTransaction", (_p, c) => {
      w.now.ms = NOT_AFTER(w) + 1; // real time passed while the simulation ran
      return { context: c.ctx("confirmed"), value: { err: null, logs: [], unitsConsumed: 1 } };
    });
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, NOT_AFTER(w))).rejects.toThrow(/at\/after the given deadline/);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("H3: ...and a stale clock cannot hide a chain that is already past notAfterMs (chain time counts too)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    claimOnSend(w);
    w.chain.override("simulateTransaction", (_p, c) => {
      c.finalizedTimeMs = NOT_AFTER(w) + 5_000; // the chain moved, the injected clock did not
      return { context: c.ctx("confirmed"), value: { err: null, logs: [], unitsConsumed: 1 } };
    });
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, NOT_AFTER(w))).rejects.toThrow(/at\/after the given deadline/);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("S1: the landing bound is re-checked as the last read before broadcast", async () => {
    const w = makeWorld({ refundAfterMs: 1_800_000_000_000 + 400_000, claimByMs: 1_800_000_000_000 + 280_000 });
    putLockedEscrow(w);
    claimOnSend(w);
    w.chain.override("simulateTransaction", (_p, c) => {
      w.now.ms += 279_000; // one second before notAfterMs: passes that guard, but the blockhash can land too late
      c.finalizedTimeMs = w.now.ms;
      return { context: c.ctx("confirmed"), value: { err: null, logs: [], unitsConsumed: 1 } };
    });
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, w.terms.claimByMs)).rejects.toBeInstanceOf(SolClaimTooLateError);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("H1/S1: a claim that lands and FAILS on chain is SolClaimFailedError with the secret public and the program's error name", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.onSend = (tx, chain) => chain.statuses.set(tx.signature, { slot: 5_000, confirmations: null, err: CUSTOM(19), confirmationStatus: "finalized" });
    const rail = await railFor(w, w.seller);
    const error = await rail.claim(w.ref, w.preimageHex, NOT_AFTER(w)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolClaimFailedError);
    expect((error as SolClaimFailedError).secretPublic).toBe(true);
    expect((error as SolClaimFailedError).programError).toEqual({ code: 19, name: "ClaimWindowClosed" });
    expect((error as Error).message).toMatch(/secret is now public, retry at once/);
  });

  it("H1: a claim whose transaction succeeded but whose escrow is not Claimed is SolClaimFailedError", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.onSend = (tx, chain) => chain.statuses.set(tx.signature, OK()); // success, but the escrow never changed
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, NOT_AFTER(w))).rejects.toBeInstanceOf(SolClaimFailedError);
  });

  it("G2-class: a claim by someone else's transaction is not mistaken for ours (Claimed with a different preimage is a failure)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.onSend = (tx, chain) => {
      chain.statuses.set(tx.signature, OK());
      putLockedEscrow(w, { status: "Claimed", preimage: new Uint8Array(32).fill(1), amount: 0n });
    };
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, NOT_AFTER(w))).rejects.toBeInstanceOf(SolClaimFailedError);
  });
});

// -- preimage discovery ------------------------------------------------------------------------------------

describe("findClaimedPreimage (S1: a failed claim publishes the secret)", () => {
  /** Builds a signed claim transaction the way the rail does, for a history fixture. */
  async function claimTx(w: World, preimage: Uint8Array, opts: { escrow?: Uint8Array; program?: Uint8Array; data?: Uint8Array } = {}): Promise<SolTransaction> {
    const message = compileLegacyMessage({
      feePayer: w.seller.publicKeyBytes,
      recentBlockhash: new Uint8Array(32).fill(1),
      instructions: [
        {
          programId: opts.program ?? pubkeyFromBase58(SOL_HTLC_PROGRAM_ID),
          accounts: [
            { pubkey: opts.escrow ?? w.keys.escrow, isSigner: false, isWritable: true },
            { pubkey: w.keys.vault, isSigner: false, isWritable: true },
          ],
          data: opts.data ?? claimInstructionData(preimage),
        },
      ],
    });
    return signTransaction(message, [w.seller]);
  }

  function history(w: World, entries: Array<{ tx: SolTransaction; err: unknown }>): void {
    const escrowText = pubkeyToBase58(w.keys.escrow);
    w.chain.addressSignatures.set(
      escrowText,
      entries.map((e, i) => ({ signature: e.tx.signature, slot: 4_000 - i, err: e.err })),
    );
    for (const e of entries) w.chain.transactions.set(e.tx.signature, { slot: 4_000, blockTime: null, err: e.err, bytes: e.tx.bytes });
  }

  it("returns the stored preimage of a Claimed escrow without reading history", async () => {
    const w = makeWorld();
    putLockedEscrow(w, { status: "Claimed", preimage: w.preimage, amount: 0n });
    const rail = await railFor(w);
    expect(await rail.findClaimedPreimage(w.ref)).toBe(w.preimageHex);
    expect(w.chain.count("getSignaturesForAddress")).toBe(0);
  });

  it("finds the secret in a FAILED claim's instruction data while the escrow is still Locked and refundable", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const failed = await claimTx(w, w.preimage);
    history(w, [{ tx: failed, err: CUSTOM(19) }]);
    const rail = await railFor(w);
    expect(await rail.findClaimedPreimage(w.ref)).toBe(w.preimageHex);
    expect(await rail.checkPendingClaim(w.ref)).toBe(w.preimageHex);
  });

  it("the rail's own failed claim is later discoverable from its history (end to end with `claim`)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    let sentTx: SolTransaction | undefined;
    w.chain.onSend = (tx, chain) => {
      sentTx = tx;
      chain.statuses.set(tx.signature, { slot: 5_000, confirmations: null, err: CUSTOM(19), confirmationStatus: "finalized" });
    };
    const rail = await railFor(w, w.seller);
    await expect(rail.claim(w.ref, w.preimageHex, NOT_AFTER(w))).rejects.toBeInstanceOf(SolClaimFailedError);
    history(w, [{ tx: sentTx as SolTransaction, err: CUSTOM(19) }]);
    const buyer = await railFor(w, w.buyer);
    expect(await buyer.findClaimedPreimage(w.ref)).toBe(w.preimageHex);
  });

  it("ignores look-alikes: a claim for another escrow, another program, a preimage that does not open the lock, and non-claim data", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const other = escrowAddress(SOL_HTLC_PROGRAM_ID, w.seller.publicKey, w.hashLock).address;
    const entries = [
      { tx: await claimTx(w, w.preimage, { escrow: other }), err: null },
      { tx: await claimTx(w, w.preimage, { program: pubkeyFromBase58(TOKEN_PROGRAM_ID) }), err: null },
      { tx: await claimTx(w, new Uint8Array(32).fill(5)), err: CUSTOM(20) },
      { tx: await claimTx(w, w.preimage, { data: refundInstructionData() }), err: null },
      { tx: await claimTx(w, w.preimage, { data: Uint8Array.of(1, ...w.preimage, 0) }), err: null },
    ];
    // the escrow-key look-alike must also list THIS escrow somewhere to appear in its history
    history(w, entries);
    const rail = await railFor(w);
    expect(await rail.findClaimedPreimage(w.ref)).toBeNull();
  });

  it("is bounded: at most 100 transactions are fetched, so a claim buried under padding is missed rather than scanned forever", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const spam: Array<{ tx: SolTransaction; err: unknown }> = [];
    for (let i = 0; i < SOL_PREIMAGE_SCAN_MAX_TRANSACTIONS; i += 1) spam.push({ tx: await claimTx(w, new Uint8Array(32).fill(i + 1)), err: CUSTOM(20) });
    const buried = await claimTx(w, w.preimage);
    history(w, [...spam, { tx: buried, err: CUSTOM(19) }]);
    const rail = await railFor(w);
    expect(await rail.findClaimedPreimage(w.ref)).toBeNull();
    expect(w.chain.count("getTransaction")).toBe(SOL_PREIMAGE_SCAN_MAX_TRANSACTIONS);
    expect(w.chain.count("getSignaturesForAddress")).toBe(4); // 25 per page
  });

  it("skips a transaction the node no longer has or that is not a legacy transaction, and finds the claim after it", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    const good = await claimTx(w, w.preimage);
    const ghost = await claimTx(w, new Uint8Array(32).fill(3));
    history(w, [{ tx: ghost, err: null }, { tx: good, err: CUSTOM(19) }]);
    w.chain.transactions.delete(ghost.signature); // pruned
    const rail = await railFor(w);
    expect(await rail.findClaimedPreimage(w.ref)).toBe(w.preimageHex);
  });
});

// -- refund -----------------------------------------------------------------------------------------------

describe("refund", () => {
  const afterWindow = (w: World): void => {
    w.chain.finalizedTimeMs = w.terms.refundAfterMs; // the CHAIN reached the boundary
    w.now.ms = w.terms.refundAfterMs;
  };

  it("refunds a Locked escrow once chain time has reached refundAfterMs: records the signature first, simulates, sends, finalizes, confirms Refunded", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    afterWindow(w);
    const sent: SolTransaction[] = [];
    refundOnSend(w, sent);
    const rail = await railFor(w, w.buyer);
    const recorded: SolPreparedRecord[] = [];
    const evidence = await rail.refund(w.ref, (r) => {
      expect(w.chain.count("sendTransaction")).toBe(0);
      recorded.push(r);
    });
    expect(recorded[0]?.kind).toBe("refund");
    expect(evidence.signature).toBe(recorded[0]?.signature);
    const tx = sent[0] as SolTransaction;
    const keys = tx.message.accountKeys.map(pubkeyToBase58);
    const ix = tx.message.instructions[0]!;
    expect(Array.from(ix.data)).toEqual([2]);
    expect(ix.accountIndexes.map((i) => keys[i])).toEqual([w.buyer.publicKey, pubkeyToBase58(w.keys.escrow), pubkeyToBase58(w.keys.vault), w.config.assets.USDC, pubkeyToBase58(w.keys.buyerToken), TOKEN_PROGRAM_ID]);
  });

  it("refuses before refundAfterMs by CHAIN time even when the local clock is ahead, and sends nothing", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.now.ms = w.terms.refundAfterMs + 10_000; // a fast local clock
    refundOnSend(w);
    const rail = await railFor(w, w.buyer);
    await expect(rail.refund(w.ref)).rejects.toThrow(/chain time has not yet reached/);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("refuses when the signer is not the ref's payer", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    afterWindow(w);
    const rail = await railFor(w, w.seller);
    await expect(rail.refund(w.ref)).rejects.toThrow(/payer's own key/);
    expect(w.chain.count("sendTransaction")).toBe(0);
  });

  it("refuses an escrow that is not Locked (claimed, refunded, missing)", async () => {
    for (const status of ["Claimed", "Refunded"] as const) {
      const w = makeWorld();
      putLockedEscrow(w, { status, ...(status === "Claimed" ? { preimage: w.preimage } : {}) });
      afterWindow(w);
      const rail = await railFor(w, w.buyer);
      await expect(rail.refund(w.ref)).rejects.toThrow(new RegExp(`got ${status}`));
    }
    const w = makeWorld();
    afterWindow(w);
    await expect((await railFor(w, w.buyer)).refund(w.ref)).rejects.toThrow(/got none/);
  });

  it("refuses when the payer's token account is frozen or missing (the refund would fail)", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    afterWindow(w);
    w.chain.get(w.keys.buyerToken)!.data[108] = 2;
    await expect((await railFor(w, w.buyer)).refund(w.ref)).rejects.toThrow(/frozen/);
    w.chain.accounts.delete(pubkeyToBase58(w.keys.buyerToken));
    await expect((await railFor(w, w.buyer)).refund(w.ref)).rejects.toThrow(/does not exist/);
  });

  it("H1: a refund that fails on chain is SolRefundFailedError (NotLocked, RefundTooEarly named), and so is a success that leaves the escrow Locked", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    afterWindow(w);
    w.chain.onSend = (tx, chain) => chain.statuses.set(tx.signature, { slot: 5_000, confirmations: null, err: CUSTOM(22), confirmationStatus: "finalized" });
    const error = await (await railFor(w, w.buyer)).refund(w.ref).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SolRefundFailedError);
    expect((error as SolRefundFailedError).programError).toEqual({ code: 22, name: "RefundTooEarly" });

    w.chain.onSend = (tx, chain) => chain.statuses.set(tx.signature, OK());
    await expect((await railFor(w, w.buyer)).refund(w.ref)).rejects.toBeInstanceOf(SolRefundFailedError);
  });

  it("G2-class: a refund retry after a failed one sends a fresh transaction (nothing is cached as 'done')", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    afterWindow(w);
    w.chain.onSend = (tx, chain) => chain.statuses.set(tx.signature, { slot: 5_000, confirmations: null, err: CUSTOM(17), confirmationStatus: "finalized" });
    const rail = await railFor(w, w.buyer);
    await expect(rail.refund(w.ref)).rejects.toBeInstanceOf(SolRefundFailedError);
    refundOnSend(w);
    await expect(rail.refund(w.ref)).resolves.toMatchObject({ ref: w.ref });
    expect(w.chain.count("sendTransaction")).toBe(2);
  });
});

// -- recovery by signature --------------------------------------------------------------------------------

describe("recoverBySignature", () => {
  async function lockedRecord(w: World): Promise<{ rail: SolHtlcRail; record: SolPreparedRecord }> {
    const rail = await railFor(w);
    const record = await rail.prepareLock(w.terms);
    return { rail, record };
  }

  it("returns null ONLY when the blockhash has expired AND there is no status", async () => {
    const w = makeWorld();
    const { rail, record } = await lockedRecord(w);
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolPendingError); // not expired yet: undecided, never null
    w.chain.finalizedHeight = record.lastValidBlockHeight; // exactly at lastValid: a block at this height could still hold it
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolPendingError);
    w.chain.finalizedHeight = record.lastValidBlockHeight + 1;
    expect(await rail.recoverBySignature(record)).toBeNull();
  });

  it("a status that exists is never 'unknown', even past expiry: processed/confirmed is pending, finalized settles", async () => {
    const w = makeWorld();
    const { rail, record } = await lockedRecord(w);
    w.chain.finalizedHeight = record.lastValidBlockHeight + 50;
    w.chain.statuses.set(record.signature, { slot: 5_000, confirmations: 1, err: null, confirmationStatus: "confirmed" });
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolPendingError);
    w.chain.statuses.set(record.signature, OK());
    putLockedEscrow(w);
    await expect(rail.recoverBySignature(record)).resolves.toMatchObject({ signature: record.signature });
  });

  it("H4: a finalized failure is reported as failed by kind (never evidence)", async () => {
    const w = makeWorld();
    const { rail, record } = await lockedRecord(w);
    w.chain.statuses.set(record.signature, { slot: 5_000, confirmations: null, err: CUSTOM(15), confirmationStatus: "finalized" });
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolLockRefusedError);
    await expect(rail.recoverBySignature({ ...record, kind: "claim" })).rejects.toBeInstanceOf(SolClaimFailedError);
    await expect(rail.recoverBySignature({ ...record, kind: "refund" })).rejects.toBeInstanceOf(SolRefundFailedError);
  });

  it("a finalized success whose escrow does not show the effect is still refused (the escrow is read, the status alone is not trusted)", async () => {
    const w = makeWorld();
    const { rail, record } = await lockedRecord(w);
    w.chain.statuses.set(record.signature, OK());
    await expect(rail.recoverBySignature(record)).rejects.toBeInstanceOf(SolLockRefusedError); // no escrow
  });

  it("a transport failure while checking status is rethrown, not read as 'never landed'", async () => {
    const w = makeWorld();
    const { rail, record } = await lockedRecord(w);
    w.chain.finalizedHeight = record.lastValidBlockHeight + 10;
    w.chain.override("getSignatureStatuses", () => {
      throw new Error("ECONNRESET");
    });
    await expect(rail.recoverBySignature(record)).rejects.toThrow(/ECONNRESET/);
  });

  it("rejects a record with a malformed ref", async () => {
    const w = makeWorld();
    const { rail, record } = await lockedRecord(w);
    await expect(rail.recoverBySignature({ ...record, ref: "nope" })).rejects.toThrow(/own ref/);
  });
});

// -- chain time, reads ------------------------------------------------------------------------------------

describe("chainTimeMs / reads (fail closed)", () => {
  it("is the finalized slot's block time in ms, never the wall clock", async () => {
    const w = makeWorld();
    w.chain.finalizedTimeMs = 1_800_000_123_000;
    w.now.ms = 5;
    const rail = await railFor(w);
    expect(await rail.chainTimeMs()).toBe(1_800_000_123_000);
    expect(await rail.currentBlockMarker()).toBe(5_000);
  });

  it("refuses to guess when the block time is missing or unusable", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    w.chain.override("getBlockTime", () => null);
    await expect(rail.chainTimeMs()).rejects.toThrow(/no block time/);
    w.chain.override("getBlockTime", () => 0);
    await expect(rail.chainTimeMs()).rejects.toThrow(/positive integer/);
    w.chain.override("getBlockTime", () => 1.5);
    await expect(rail.chainTimeMs()).rejects.toThrow(/positive integer/);
  });

  it("getEscrow decodes the program-owned account; a system-owned pre-funded account is 'no escrow'; a malformed program-owned one throws", async () => {
    const w = makeWorld();
    const rail = await railFor(w);
    expect((await rail.getEscrow(w.ref)).escrow).toBeNull();
    putLockedEscrow(w);
    const { escrow } = await rail.getEscrow(w.ref);
    expect(escrow).toMatchObject({ status: "Locked", payer: w.buyer.publicKey, payee: w.seller.publicKey, amount: "1000000", hashLock: w.hashLock, mint: w.config.assets.USDC });
    expect(escrow?.preimage).toBeNull();
    w.chain.get(w.keys.escrow)!.data = new Uint8Array(10);
    await expect(rail.getEscrow(w.ref)).rejects.toThrow(/188 bytes/);
  });

  it("a payer/hash-lock recorded inside the escrow that disagrees with its address is refused", async () => {
    const w = makeWorld();
    putLockedEscrow(w);
    w.chain.get(w.keys.escrow)!.data.set(new Uint8Array(32).fill(6), 100);
    await expect((await railFor(w)).getEscrow(w.ref)).rejects.toThrow(/do not match its address/);
  });
});

describe("decodeEscrow / instruction encoders", () => {
  it("decodes the README layout, and is strict about version, status and the revealed flag", () => {
    const w = makeWorld();
    putLockedEscrow(w, { status: "Claimed", preimage: w.preimage });
    const data = w.chain.get(w.keys.escrow)!.data;
    const view = decodeEscrow(data);
    expect(view).toMatchObject({ status: "Claimed", revealed: true, preimage: w.preimageHex, bump: w.keys.bump, claimByMs: w.terms.claimByMs, refundAfterMs: w.terms.refundAfterMs });
    const clone = (i: number, v: number): Uint8Array => {
      const c = data.slice();
      c[i] = v;
      return c;
    };
    expect(() => decodeEscrow(clone(0, 2))).toThrow(/version/);
    expect(() => decodeEscrow(clone(1, 9))).toThrow(/status/);
    expect(() => decodeEscrow(clone(2, 2))).toThrow(/revealed/);
    expect(() => decodeEscrow(data.slice(0, 187))).toThrow(/188/);
    const huge = data.slice();
    new DataView(huge.buffer).setBigInt64(148, 2n ** 62n, true);
    expect(() => decodeEscrow(huge)).toThrow(/safe integer/);
  });

  it("escrow and vault addresses are the PDAs [htlc, payer, hash_lock] and [vault, escrow]", () => {
    const payer = pubkeyToBase58(new Uint8Array(32).fill(7));
    const hashLock = `0x${bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i))}`;
    const escrow = escrowAddress(SOL_HTLC_PROGRAM_ID, payer, hashLock);
    expect(pubkeyToBase58(escrow.address)).toBe("FoMr7GtzuhdJihntCrP1EGGbc3a9BMeQBHVbo6A8yQ1y");
    expect(pubkeyToBase58(vaultAddress(SOL_HTLC_PROGRAM_ID, escrow.address).address)).toBe("7Yyy3o5EyPetKjuwmmdkF9hUKffSRH3vDem7jUXPrTDD");
  });

  it("data encoders: claim is 33 bytes with tag 1, refund is [2], claim refuses a non-32-byte preimage", () => {
    expect(Array.from(claimInstructionData(new Uint8Array(32).fill(9)))).toEqual([1, ...new Array(32).fill(9)]);
    expect(Array.from(refundInstructionData())).toEqual([2]);
    expect(() => claimInstructionData(new Uint8Array(31))).toThrow();
  });
});

describe("the rail holds no key material", () => {
  it("a rail, its signer and a captured exchange never carry secret bytes (JSON of the rail is redacted to public data)", async () => {
    const w = makeWorld();
    lockOnSend(w);
    const rail = await railFor(w);
    await rail.prepareLock(w.terms);
    await rail.commitLock();
    const text = JSON.stringify({ rail, signer: w.buyer, exchanges: w.rpc.exchanges().map((e) => e.requestBody) });
    const seedText = base58.encode(new Uint8Array(32).fill(1));
    expect(text).not.toContain(seedText);
    expect(text).toContain(w.buyer.publicKey);
    // a claim-shaped request body carries the transaction, never a key: no request ever names a secret key field
    expect(text).not.toMatch(/secret|private/i);
    expect(decodeTokenAccount).toBeDefined();
  });
});

describe("unused-import guard", () => {
  it("keeps the shared harness types referenced", () => {
    const options: WorldOptions = {};
    expect(options).toEqual({});
    expect(CapturingRpc).toBeDefined();
  });
});
