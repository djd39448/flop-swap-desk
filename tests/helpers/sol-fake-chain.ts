// SPDX-License-Identifier: MIT
//
// A scripted fake Solana JSON-RPC node for the hermetic SB2a tests. It answers the methods `SolRpc` calls
// from plain in-memory state (accounts, slots, block heights, block times, signature statuses, stored
// transactions) and lets a test override or one-shot-script any method, inject an error reply, or hook the
// send. It models NO program logic: a test decides what a send "did" by editing the accounts and statuses
// (`applyLock` and friends do the common cases) - the program itself is exercised by the Rust tests and,
// in SB-int, by the real validator.
//
// It is wired through the real `CapturingRpc`, so every call is a real captured exchange with a real
// response hash, exactly as in production.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";

import { CapturingRpc } from "../../src/rails/rpc-capture.js";
import { InMemorySolSigner } from "../../src/rails/sol-signer-memory.js";
import { BPF_LOADER_UPGRADEABLE_ID, SPL_MINT_LEN, SPL_TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM_ID, associatedTokenAddress } from "../../src/rails/sol-spl.js";
import { decodeTransaction, findProgramAddress, pubkeyFromBase58, pubkeyToBase58 } from "../../src/rails/sol-tx.js";
import {
  SOL_HTLC_PROGRAM_ID,
  SOL_LOCAL_PIN,
  escrowAddress,
  vaultAddress,
  type SolEscrowStatus,
  type SolHtlcTerms,
  type SolRailConfig,
} from "../../src/rails/sol-htlc.js";

export interface FakeAccount {
  lamports: number;
  owner: string;
  data: Uint8Array;
  executable: boolean;
}

export interface FakeStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized";
}

export class FakeRpcError {
  constructor(
    readonly code: number,
    readonly message: string,
    readonly data?: unknown,
  ) {}
}

type Handler = (params: unknown[], chain: FakeSolChain) => unknown;

export class FakeSolChain {
  accounts = new Map<string, FakeAccount>();
  genesisHash = "LocalnetGenesisHashForTests1111111111111111111";
  finalizedSlot = 5_000;
  confirmedSlot = 5_031;
  finalizedHeight = 4_900;
  confirmedHeight = 4_931;
  /** Wall time (ms) that the FINALIZED slot's block time reports (seconds resolution on the wire). */
  finalizedTimeMs = 1_800_000_000_000;
  blockhash = base58.encode(new Uint8Array(32).fill(0x42));
  lastValidBlockHeight = 4_931 + 150;
  statuses = new Map<string, FakeStatus>();
  transactions = new Map<string, { slot: number; blockTime: number | null; err: unknown; bytes: Uint8Array }>();
  addressSignatures = new Map<string, Array<{ signature: string; slot: number; err: unknown }>>();
  simulateErr: unknown = null;
  simulateLogs: string[] = [];
  /** Called with the decoded transaction when `sendTransaction` is answered. Default: a finalized success. */
  onSend: (tx: ReturnType<typeof decodeTransaction>, chain: FakeSolChain) => void = (tx, chain) => {
    chain.statuses.set(tx.signature, { slot: chain.finalizedSlot, confirmations: null, err: null, confirmationStatus: "finalized" });
  };
  requests: Array<{ method: string; params: unknown[] }> = [];
  private overrides = new Map<string, Handler>();
  private queued = new Map<string, Handler[]>();

  /** Replace a method's handler for the rest of the test. */
  override(method: string, handler: Handler): void {
    this.overrides.set(method, handler);
  }

  /** Script the next call of `method` only. */
  once(method: string, handler: Handler): void {
    const list = this.queued.get(method) ?? [];
    list.push(handler);
    this.queued.set(method, list);
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  ctx(commitment?: string): { slot: number } {
    return { slot: commitment === "finalized" ? this.finalizedSlot : this.confirmedSlot };
  }

  private wireAccount(a: FakeAccount | undefined): unknown {
    if (a === undefined) return null;
    return { lamports: a.lamports, owner: a.owner, data: [base64.encode(a.data), "base64"], executable: a.executable, rentEpoch: 0, space: a.data.length };
  }

  private defaults: Record<string, Handler> = {
    getVersion: () => ({ "solana-core": "4.3.0", "feature-set": 1 }),
    getGenesisHash: (_p, c) => c.genesisHash,
    getSlot: (p, c) => ((p[0] as { commitment?: string } | undefined)?.commitment === "finalized" ? c.finalizedSlot : c.confirmedSlot),
    getBlockHeight: (p, c) => ((p[0] as { commitment?: string } | undefined)?.commitment === "finalized" ? c.finalizedHeight : c.confirmedHeight),
    getBlockTime: (p, c) => (p[0] === c.finalizedSlot ? Math.floor(c.finalizedTimeMs / 1000) : null),
    getLatestBlockhash: (p, c) => ({
      context: c.ctx((p[0] as { commitment?: string }).commitment),
      value: { blockhash: c.blockhash, lastValidBlockHeight: c.lastValidBlockHeight },
    }),
    getAccountInfo: (p, c) => {
      const cfg = p[1] as { commitment?: string; minContextSlot?: number };
      const ctx = c.ctx(cfg.commitment);
      if (cfg.minContextSlot !== undefined && cfg.minContextSlot > ctx.slot) throw new FakeRpcError(-32016, "Minimum context slot has not been reached", { contextSlot: ctx.slot });
      return { context: ctx, value: c.wireAccount(c.accounts.get(p[0] as string)) };
    },
    getMultipleAccounts: (p, c) => {
      const cfg = p[1] as { commitment?: string; minContextSlot?: number };
      const ctx = c.ctx(cfg.commitment);
      if (cfg.minContextSlot !== undefined && cfg.minContextSlot > ctx.slot) throw new FakeRpcError(-32016, "Minimum context slot has not been reached", { contextSlot: ctx.slot });
      return { context: ctx, value: (p[0] as string[]).map((k) => c.wireAccount(c.accounts.get(k))) };
    },
    simulateTransaction: (_p, c) => ({ context: c.ctx("confirmed"), value: { err: c.simulateErr, logs: c.simulateLogs, unitsConsumed: 1234 } }),
    sendTransaction: (p, c) => {
      const tx = decodeTransaction(base64.decode(p[0] as string));
      c.onSend(tx, c);
      return tx.signature;
    },
    getSignatureStatuses: (p, c) => ({ context: c.ctx("confirmed"), value: (p[0] as string[]).map((s) => c.statuses.get(s) ?? null) }),
    getTransaction: (p, c) => {
      const t = c.transactions.get(p[0] as string);
      if (t === undefined) return null;
      return { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err }, transaction: [base64.encode(t.bytes), "base64"], version: "legacy" };
    },
    getSignaturesForAddress: (p, c) => {
      const cfg = p[1] as { limit?: number; before?: string };
      let list = c.addressSignatures.get(p[0] as string) ?? [];
      if (cfg.before !== undefined) {
        const i = list.findIndex((e) => e.signature === cfg.before);
        list = i < 0 ? [] : list.slice(i + 1);
      }
      return list.slice(0, cfg.limit ?? 1000).map((e) => ({ signature: e.signature, slot: e.slot, err: e.err, blockTime: null, memo: null, confirmationStatus: "finalized" }));
    },
    requestAirdrop: () => base58.encode(new Uint8Array(64).fill(1)),
  };

  fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: unknown[] };
    this.requests.push({ method: body.method, params: body.params });
    let payload: unknown;
    try {
      const queue = this.queued.get(body.method);
      const next = queue?.shift();
      const handler = next ?? this.overrides.get(body.method) ?? this.defaults[body.method];
      if (handler === undefined) throw new Error(`FakeSolChain: no handler for ${body.method}`);
      payload = { jsonrpc: "2.0", id: body.id, result: handler(body.params ?? [], this) };
    } catch (error) {
      if (error instanceof FakeRpcError) {
        payload = { jsonrpc: "2.0", id: body.id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
      } else {
        throw error; // a transport-level failure: the fetch itself rejects
      }
    }
    const text = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as Response;
  }) as typeof fetch;

  // -- state builders ----------------------------------------------------------------------------------

  put(address: Uint8Array | string, account: FakeAccount): void {
    this.accounts.set(typeof address === "string" ? address : pubkeyToBase58(address), account);
  }

  get(address: Uint8Array | string): FakeAccount | undefined {
    return this.accounts.get(typeof address === "string" ? address : pubkeyToBase58(address));
  }
}

// --- byte builders (the program's documented layouts) -----------------------------------------------------

export function tokenAccountBytes(o: { mint: Uint8Array; owner: Uint8Array; amount: bigint; state?: number }): Uint8Array {
  const data = new Uint8Array(SPL_TOKEN_ACCOUNT_LEN);
  data.set(o.mint, 0);
  data.set(o.owner, 32);
  new DataView(data.buffer).setBigUint64(64, o.amount, true);
  data[108] = o.state ?? 1;
  return data;
}

export function mintBytes(decimals = 6, initialised = true): Uint8Array {
  const data = new Uint8Array(SPL_MINT_LEN);
  data[44] = decimals;
  data[45] = initialised ? 1 : 0;
  return data;
}

/** The program's 188-byte escrow (contracts-sol/README.md "Accounts and state"). */
export function escrowBytes(o: {
  status?: SolEscrowStatus;
  bump: number;
  payer: Uint8Array;
  payee: Uint8Array;
  mint: Uint8Array;
  hashLock: Uint8Array;
  amount: bigint;
  claimByMs: number;
  refundAfterMs: number;
  preimage?: Uint8Array;
  version?: number;
}): Uint8Array {
  const data = new Uint8Array(188);
  const view = new DataView(data.buffer);
  const status = o.status ?? "Locked";
  data[0] = o.version ?? 1;
  data[1] = status === "Locked" ? 1 : status === "Claimed" ? 2 : 3;
  data[2] = o.preimage === undefined ? 0 : 1;
  data[3] = o.bump;
  data.set(o.payer, 4);
  data.set(o.payee, 36);
  data.set(o.mint, 68);
  data.set(o.hashLock, 100);
  view.setBigUint64(132, o.amount, true);
  view.setBigInt64(140, BigInt(o.claimByMs), true);
  view.setBigInt64(148, BigInt(o.refundAfterMs), true);
  if (o.preimage !== undefined) data.set(o.preimage, 156);
  return data;
}

// --- a whole scripted world --------------------------------------------------------------------------------

export const FAKE_ELF = Uint8Array.from({ length: 500 }, (_, i) => (i * 7 + 3) % 251 || 1);
export const FAKE_PROGRAM_HASH = bytesToHex(sha256(FAKE_ELF));

const NOW_MS = 1_800_000_000_000;

export interface World {
  chain: FakeSolChain;
  rpc: CapturingRpc;
  config: SolRailConfig;
  buyer: InMemorySolSigner;
  seller: InMemorySolSigner;
  mint: Uint8Array;
  preimage: Uint8Array;
  hashLock: string;
  preimageHex: string;
  terms: SolHtlcTerms;
  ref: string;
  /** The injected clock (ms). `sleep` advances it. */
  now: { ms: number };
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  keys: { escrow: Uint8Array; vault: Uint8Array; bump: number; buyerToken: Uint8Array; sellerToken: Uint8Array };
}

export interface WorldOptions {
  /** Program authority: "none" (tag 0), "zero" (Some(all-zero)), or a 32-byte key (Some(key)). */
  authority?: "none" | "zero" | Uint8Array;
  padding?: number;
  refundAfterMs?: number;
  claimByMs?: number;
}

export function makeWorld(options: WorldOptions = {}): World {
  const chain = new FakeSolChain();
  chain.finalizedTimeMs = NOW_MS;
  const now = { ms: NOW_MS };
  const clock = (): number => now.ms;
  const sleep = async (ms: number): Promise<void> => {
    now.ms += ms;
  };
  const rpc = new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: chain.fetch, clock: () => 5000 });

  const buyer = InMemorySolSigner.generate(new Uint8Array(32).fill(1));
  const seller = InMemorySolSigner.generate(new Uint8Array(32).fill(2));
  const mint = new Uint8Array(32).fill(0x91);
  const preimage = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  const hashLock = `0x${bytesToHex(sha256(preimage))}`;
  const preimageHex = `0x${bytesToHex(preimage)}`;

  const config: SolRailConfig = {
    pin: SOL_LOCAL_PIN,
    endpoint: "http://127.0.0.1:9999",
    programId: SOL_HTLC_PROGRAM_ID,
    programHash: FAKE_PROGRAM_HASH,
    assets: { USDC: pubkeyToBase58(mint) },
  };

  // program + programdata + mint
  const programKey = pubkeyFromBase58(SOL_HTLC_PROGRAM_ID);
  const programData = findProgramAddress([programKey], pubkeyFromBase58(BPF_LOADER_UPGRADEABLE_ID)).address;
  const programAccount = new Uint8Array(36);
  new DataView(programAccount.buffer).setUint32(0, 2, true);
  programAccount.set(programData, 4);
  chain.put(programKey, { lamports: 1, owner: BPF_LOADER_UPGRADEABLE_ID, data: programAccount, executable: true });
  const pd = new Uint8Array(45 + FAKE_ELF.length + (options.padding ?? 0));
  new DataView(pd.buffer).setUint32(0, 3, true);
  const authority = options.authority ?? "zero";
  if (authority === "none") {
    pd[12] = 0;
  } else {
    pd[12] = 1;
    if (authority !== "zero") pd.set(authority, 13);
  }
  pd.set(FAKE_ELF, 45);
  chain.put(programData, { lamports: 1, owner: BPF_LOADER_UPGRADEABLE_ID, data: pd, executable: false });
  chain.put(mint, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: mintBytes(), executable: false });

  const amount = 1_000_000n;
  const refundAfterMs = options.refundAfterMs ?? NOW_MS + 3_600_000;
  const claimByMs = options.claimByMs ?? refundAfterMs - 1_800_000;
  const terms: SolHtlcTerms = { hashLock, amount: amount.toString(), payee: seller.publicKey, claimByMs, refundAfterMs };
  const ref = `${hashLock}:${buyer.publicKey}`;

  const { address: escrow, bump } = escrowAddress(SOL_HTLC_PROGRAM_ID, buyer.publicKey, hashLock);
  const vault = vaultAddress(SOL_HTLC_PROGRAM_ID, escrow).address;
  const buyerToken = associatedTokenAddress(buyer.publicKeyBytes, mint);
  const sellerToken = associatedTokenAddress(seller.publicKeyBytes, mint);
  chain.put(buyerToken, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint, owner: buyer.publicKeyBytes, amount: 5_000_000n }), executable: false });
  chain.put(sellerToken, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint, owner: seller.publicKeyBytes, amount: 0n }), executable: false });

  return { chain, rpc, config, buyer, seller, mint, preimage, hashLock, preimageHex, terms, ref, now, clock, sleep, keys: { escrow, vault, bump, buyerToken, sellerToken } };
}

/** Puts a Locked escrow (and its funded vault) on the fake chain, as a finished lock would have. */
export function putLockedEscrow(w: World, overrides: { status?: SolEscrowStatus; preimage?: Uint8Array; amount?: bigint; payee?: Uint8Array } = {}): void {
  const amount = overrides.amount ?? BigInt(w.terms.amount);
  w.chain.put(w.keys.escrow, {
    lamports: 1,
    owner: SOL_HTLC_PROGRAM_ID,
    data: escrowBytes({
      status: overrides.status ?? "Locked",
      bump: w.keys.bump,
      payer: w.buyer.publicKeyBytes,
      payee: overrides.payee ?? w.seller.publicKeyBytes,
      mint: w.mint,
      hashLock: Uint8Array.from(Buffer.from(w.hashLock.slice(2), "hex")),
      amount,
      claimByMs: w.terms.claimByMs,
      refundAfterMs: w.terms.refundAfterMs,
      ...(overrides.preimage === undefined ? {} : { preimage: overrides.preimage }),
    }),
    executable: false,
  });
  w.chain.put(w.keys.vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: w.mint, owner: w.keys.escrow, amount }), executable: false });
}
