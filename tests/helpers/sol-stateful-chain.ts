// SPDX-License-Identifier: MIT
//
// A STATEFUL fake Solana JSON-RPC node for the hermetic SB3a client-flow tests (the "reviewer pattern" of
// tests/client-flows-near-rpc.test.ts: only the wire is fake, everything above it is the real code). It layers
// the escrow program's own state machine (contracts-sol/README.md "Accounts and state", the three
// instructions Lock / Claim / Refund and their error numbers) onto the scripted node of
// tests/helpers/sol-fake-chain.ts: each transaction the REAL adapter builds and sends (`SolHtlcRail`) is
// decoded here from its wire bytes (instruction tag, account order, data) and its effect is applied to
// in-memory accounts, so what the client flows see is the chain's answer to what they actually sent, never a
// canned queue that could let the tests' assumptions about call order drift from the adapter.
//
// What is modelled (and only this):
//   - Lock creates the payer-keyed escrow PDA and the vault token account and debits the payer's token account;
//     Claim checks Locked, the window (program time < refund_after_ms), the preimage and the payee's token
//     account (missing / wrong owner / wrong mint = the atomic failure: the WHOLE transaction fails, state
//     unchanged, but the transaction is still on chain with its instruction data, which carries the preimage:
//     the S1 leak); Refund checks the payer, Locked and time >= refund_after_ms.
//   - sendTransaction runs the node's preflight simulation first (a transaction that would fail is rejected
//     with -32002 and never lands), then the `midFlight` hook (a test's way to change the world AFTER the
//     preflight and BEFORE the transaction executes: the only way a claim can land and fail), then executes.
//     Executed transactions get a finalized status (with their error when they failed), a stored transaction and
//     an entry in the escrow address's signature history (newest first), exactly what `getSignatureStatuses`,
//     `getTransaction` and `getSignaturesForAddress` answer on a real node.
//   - Program time is the node's own clock (`nowMs`, the FINALIZED block time); tests move it, and the rail's
//     injected clock reads the same value.
// It does NOT model fees, rent, blockhash expiry or slot progress.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";

import { CapturingRpc } from "../../src/rails/rpc-capture.js";
import { SOL_HTLC_PROGRAM_ID, SOL_ESCROW_LEN, decodeEscrow, escrowAddress, vaultAddress, type SolEscrowView, type SolRailConfig } from "../../src/rails/sol-htlc.js";
import { InMemorySolSigner } from "../../src/rails/sol-signer-memory.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, TOKEN_PROGRAM_ID, associatedTokenAddress, decodeTokenAccount } from "../../src/rails/sol-spl.js";
import { bytesEqual, decodeTransaction, pubkeyFromBase58, pubkeyToBase58, verifyTransactionSignatures, type SolTransaction } from "../../src/rails/sol-tx.js";
import { FakeRpcError, FakeSolChain, escrowBytes, makeWorld, tokenAccountBytes, type World } from "./sol-fake-chain.js";

const CUSTOM = (n: number): unknown => ({ InstructionError: [0, { Custom: n }] });

type Kind = "lock" | "claim" | "refund";

interface Parsed {
  kind: Kind;
  keys: Uint8Array[];
  accounts: Uint8Array[];
  data: Uint8Array;
  tx: SolTransaction;
}

export interface ExecutedTx {
  kind: Kind;
  signature: string;
  err: unknown;
  /** The claim preimage that sat in the instruction data (hex, `0x`), claims only. */
  preimage?: string;
}

export class StatefulSolNode {
  readonly world: World;
  readonly chain: FakeSolChain;
  readonly config: SolRailConfig;
  readonly mint: Uint8Array;
  /** Every transaction that EXECUTED (landed), in order, with its error. */
  readonly history: ExecutedTx[] = [];
  /** Transactions the node ACCEPTED for sending, by kind (the preflight-rejected are not counted). */
  readonly sent: Record<Kind, number> = { lock: 0, claim: 0, refund: 0 };
  private blockhashCounter = 0;
  /** Token accounts a claim transaction's CreateIdempotent created (kept for tests that count them). */
  readonly createdByAta: string[] = [];
  /** Runs after the preflight and before execution. A test mutates the world here (move the clock, close an
   *  account) to make a transaction land and fail. Called for every kind; `kind` says which. */
  midFlight?: (kind: Kind, tx: SolTransaction) => void;
  /** Make the reply of the next send of `kind` fail at the transport level AFTER the transaction executed. */
  dropNextSendReplyFor?: Kind;
  /** Runs right after a transaction landed (executed and recorded), with whether it failed. */
  afterLand?: (kind: Kind, failed: boolean) => void;

  constructor() {
    this.world = makeWorld();
    this.chain = this.world.chain;
    this.config = this.world.config;
    this.mint = this.world.mint;
    this.chain.override("simulateTransaction", (p) => {
      const tx = decodeTransaction(base64.decode(p[0] as string));
      const { err } = this.run(tx, false);
      return { context: this.chain.ctx("confirmed"), value: { err, logs: [], unitsConsumed: 1234 } };
    });
    this.chain.override("sendTransaction", (p) => {
      const tx = decodeTransaction(base64.decode(p[0] as string));
      if (this.chain.statuses.has(tx.signature)) return tx.signature; // a duplicate send
      const pre = this.run(tx, false);
      if (pre.err !== null) throw new FakeRpcError(-32002, "Transaction simulation failed", { err: pre.err, logs: [], unitsConsumed: 0 });
      this.midFlight?.(pre.kind, tx);
      const done = this.run(tx, true);
      this.sent[done.kind] += 1;
      this.land(tx, done);
      this.afterLand?.(done.kind, done.err !== null);
      if (this.dropNextSendReplyFor === done.kind) {
        this.dropNextSendReplyFor = undefined;
        throw new Error("connection reset (test: the reply was lost after the transaction landed)");
      }
      return tx.signature;
    });
  }

  /** Executes `tx` as if some other sender's transaction landed (no preflight, no hooks): a relayer that won a
   *  race. Returns its error (null when it succeeded). */
  executeAndLand(tx: SolTransaction): unknown {
    const done = this.run(tx, true);
    this.land(tx, done);
    return done.err;
  }

  // -- clock -------------------------------------------------------------------------------------------------

  get nowMs(): number {
    return this.chain.finalizedTimeMs;
  }
  set nowMs(ms: number) {
    this.chain.finalizedTimeMs = ms;
  }
  clock = (): number => this.chain.finalizedTimeMs;
  sleep = async (ms: number): Promise<void> => {
    this.chain.finalizedTimeMs += ms;
  };

  /** A fresh capturing transport against this node (each party has its own, as in production). */
  rpc(): CapturingRpc {
    return new CapturingRpc({ endpoint: "http://127.0.0.1:9999", fetch: this.chain.fetch, clock: () => this.chain.finalizedTimeMs });
  }

  // -- world builders ----------------------------------------------------------------------------------------

  /** Creates (or tops up) the owner's associated token account for the mint. */
  fundToken(owner: Uint8Array | string, amount: bigint): void {
    const ownerBytes = typeof owner === "string" ? pubkeyFromBase58(owner) : owner;
    const key = associatedTokenAddress(ownerBytes, this.mint);
    const existing = this.chain.get(key);
    const current = existing === undefined ? 0n : decodeTokenAccount(existing.data).amount;
    this.chain.put(key, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: this.mint, owner: ownerBytes, amount: current + amount }), executable: false });
  }

  closeToken(owner: Uint8Array | string): void {
    const ownerBytes = typeof owner === "string" ? pubkeyFromBase58(owner) : owner;
    this.chain.accounts.delete(pubkeyToBase58(associatedTokenAddress(ownerBytes, this.mint)));
  }

  /** Freezes the owner's token account (a claim into it then fails on chain, as the token program refuses a frozen destination). */
  freezeToken(owner: Uint8Array | string): void {
    const ownerBytes = typeof owner === "string" ? pubkeyFromBase58(owner) : owner;
    const key = associatedTokenAddress(ownerBytes, this.mint);
    const existing = this.chain.get(key);
    if (existing === undefined) return;
    const data = existing.data.slice();
    data[108] = 2;
    this.chain.put(key, { ...existing, data });
  }

  tokenBalance(owner: Uint8Array | string): bigint | null {
    const ownerBytes = typeof owner === "string" ? pubkeyFromBase58(owner) : owner;
    const account = this.chain.get(associatedTokenAddress(ownerBytes, this.mint));
    return account === undefined ? null : decodeTokenAccount(account.data).amount;
  }

  escrow(hashLock: string, payer: string): SolEscrowView | null {
    const account = this.chain.get(escrowAddress(SOL_HTLC_PROGRAM_ID, payer, hashLock).address);
    return account === undefined ? null : decodeEscrow(account.data);
  }

  vaultBalance(hashLock: string, payer: string): bigint | null {
    const escrow = escrowAddress(SOL_HTLC_PROGRAM_ID, payer, hashLock).address;
    const account = this.chain.get(vaultAddress(SOL_HTLC_PROGRAM_ID, escrow).address);
    return account === undefined ? null : decodeTokenAccount(account.data).amount;
  }

  /** Another payer's escrow under the same public hash lock (the squat): lands as a finished Lock would. */
  injectEscrow(o: { payer: InMemorySolSigner; payee: string; hashLock: string; amount: bigint; claimByMs: number; refundAfterMs: number }): void {
    const { address, bump } = escrowAddress(SOL_HTLC_PROGRAM_ID, o.payer.publicKey, o.hashLock);
    this.chain.put(address, {
      lamports: 1,
      owner: SOL_HTLC_PROGRAM_ID,
      data: escrowBytes({
        bump,
        payer: o.payer.publicKeyBytes,
        payee: pubkeyFromBase58(o.payee),
        mint: this.mint,
        hashLock: hexToBytes(o.hashLock.slice(2)),
        amount: o.amount,
        claimByMs: o.claimByMs,
        refundAfterMs: o.refundAfterMs,
      }),
      executable: false,
    });
    const vault = vaultAddress(SOL_HTLC_PROGRAM_ID, address).address;
    this.chain.put(vault, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: this.mint, owner: address, amount: o.amount }), executable: false });
  }

  // -- the program -------------------------------------------------------------------------------------------

  /** The compute-budget instructions are accepted and ignored (fees and compute are not modelled); the ATA
   *  CreateIdempotent instructions are collected; exactly one other (program) instruction must remain. */
  private split(tx: SolTransaction): { program: SolTransaction["message"]["instructions"][number][]; ata: Array<{ payer: Uint8Array; owner: Uint8Array; mint: Uint8Array }>; budget: number } {
    const program: SolTransaction["message"]["instructions"][number][] = [];
    const ata: Array<{ payer: Uint8Array; owner: Uint8Array; mint: Uint8Array }> = [];
    let budget = 0;
    for (const ix of tx.message.instructions) {
      const id = pubkeyToBase58(tx.message.accountKeys[ix.programIdIndex] as Uint8Array);
      if (id === COMPUTE_BUDGET_PROGRAM_ID) budget += 1;
      else if (id === ASSOCIATED_TOKEN_PROGRAM_ID) {
        const k = ix.accountIndexes.map((i) => tx.message.accountKeys[i] as Uint8Array);
        ata.push({ payer: k[0] as Uint8Array, owner: k[2] as Uint8Array, mint: k[3] as Uint8Array });
      } else program.push(ix);
    }
    return { program, ata, budget };
  }

  /** The program instruction of an executed transaction, for history indexing. */
  programInstruction(tx: SolTransaction): SolTransaction["message"]["instructions"][number] | undefined {
    return this.split(tx).program[0];
  }

  private parse(tx: SolTransaction): Parsed | { err: unknown } {
    if (!verifyTransactionSignatures(tx)) return { err: "SignatureFailure" };
    const split = this.split(tx);
    const ix = split.program[0];
    if (split.program.length !== 1 || ix === undefined) return { err: CUSTOM(1) };
    const programKey = tx.message.accountKeys[ix.programIdIndex];
    if (programKey === undefined || pubkeyToBase58(programKey) !== SOL_HTLC_PROGRAM_ID) return { err: "InvalidProgramForExecution" };
    const tag = ix.data[0];
    const kind: Kind | undefined = tag === 0 ? "lock" : tag === 1 ? "claim" : tag === 2 ? "refund" : undefined;
    if (kind === undefined) return { err: CUSTOM(1) };
    const accounts = ix.accountIndexes.map((i) => tx.message.accountKeys[i] as Uint8Array);
    return { kind, keys: [...tx.message.accountKeys], accounts, data: ix.data, tx };
  }

  /** Runs the transaction against the current world; `commit` applies its effect. Never throws. */
  private run(tx: SolTransaction, commit: boolean): { kind: Kind; err: unknown; preimage?: string } {
    const parsed = this.parse(tx);
    if ("err" in parsed) return { kind: "claim", err: parsed.err };
    const now = Math.floor(this.chain.finalizedTimeMs / 1000) * 1000;
    // CreateIdempotent runs before the program instruction inside the same transaction: it creates the token account
    // when it is missing. A failed transaction (or a simulation) leaves nothing behind.
    const created: string[] = [];
    for (const a of this.split(tx).ata) {
      const key = associatedTokenAddress(a.owner, a.mint);
      if (this.chain.get(key) === undefined) {
        this.chain.put(key, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: a.mint, owner: a.owner, amount: 0n }), executable: false });
        created.push(pubkeyToBase58(key));
        this.createdByAta.push(pubkeyToBase58(key));
      }
    }
    const out = parsed.kind === "lock" ? this.lock(parsed, now, commit) : parsed.kind === "claim" ? this.claim(parsed, now, commit) : this.refund(parsed, now, commit);
    if (!commit || out.err !== null) for (const key of created) this.chain.accounts.delete(key);
    return { kind: parsed.kind, err: out.err, ...(parsed.kind === "claim" ? { preimage: `0x${bytesToHex(parsed.data.slice(1))}` } : {}) };
  }

  private tokenOf(key: Uint8Array): ReturnType<typeof decodeTokenAccount> | null {
    const account = this.chain.get(key);
    if (account === undefined || account.owner !== TOKEN_PROGRAM_ID) return null;
    try {
      return decodeTokenAccount(account.data);
    } catch {
      return null;
    }
  }

  private setTokenAmount(key: Uint8Array, amount: bigint): void {
    const account = this.chain.get(key);
    if (account === undefined) return;
    const data = account.data.slice();
    new DataView(data.buffer).setBigUint64(64, amount, true);
    this.chain.put(key, { ...account, data });
  }

  private lock(p: Parsed, now: number, commit: boolean): { err: unknown } {
    if (p.data.length !== 89 || p.accounts.length !== 7) return { err: CUSTOM(1) };
    const [payer, escrowKey, vaultKey, mintKey, payerToken] = p.accounts as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const hashLock = p.data.slice(1, 33);
    const payee = p.data.slice(33, 65);
    const view = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
    const claimBy = Number(view.getBigInt64(65, true));
    const refundAfter = Number(view.getBigInt64(73, true));
    const amount = view.getBigUint64(81, true);
    if (p.keys.findIndex((k) => bytesEqual(k, payer)) >= p.tx.message.header.numRequiredSignatures) return { err: CUSTOM(9) };
    if (amount === 0n) return { err: CUSTOM(3) };
    if (!(claimBy < refundAfter)) return { err: CUSTOM(4) };
    if (!(now < refundAfter)) return { err: CUSTOM(5) };
    if (!bytesEqual(mintKey, this.mint)) return { err: CUSTOM(7) };
    const escrow = escrowAddress(SOL_HTLC_PROGRAM_ID, pubkeyToBase58(payer), `0x${bytesToHex(hashLock)}`);
    if (!bytesEqual(escrow.address, escrowKey)) return { err: CUSTOM(13) };
    if (!bytesEqual(vaultAddress(SOL_HTLC_PROGRAM_ID, escrow.address).address, vaultKey)) return { err: CUSTOM(14) };
    const existing = this.chain.get(escrowKey);
    if (existing !== undefined && existing.owner === SOL_HTLC_PROGRAM_ID) return { err: CUSTOM(15) };
    const token = this.tokenOf(payerToken);
    if (token === null || !bytesEqual(token.owner, payer) || !bytesEqual(token.mint, this.mint)) return { err: CUSTOM(17) };
    if (token.amount < amount) return { err: CUSTOM(1) }; // the token program's own "insufficient funds"
    if (commit) {
      this.setTokenAmount(payerToken, token.amount - amount);
      this.chain.put(escrowKey, {
        lamports: 1,
        owner: SOL_HTLC_PROGRAM_ID,
        data: escrowBytes({ bump: escrow.bump, payer, payee, mint: this.mint, hashLock, amount, claimByMs: claimBy, refundAfterMs: refundAfter }),
        executable: false,
      });
      this.chain.put(vaultKey, { lamports: 1, owner: TOKEN_PROGRAM_ID, data: tokenAccountBytes({ mint: this.mint, owner: escrowKey, amount }), executable: false });
    }
    return { err: null };
  }

  private claim(p: Parsed, now: number, commit: boolean): { err: unknown } {
    if (p.data.length !== 33 || p.accounts.length !== 5) return { err: CUSTOM(1) };
    const [escrowKey, vaultKey, mintKey, payeeToken] = p.accounts as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const preimage = p.data.slice(1);
    const account = this.chain.get(escrowKey);
    if (account === undefined || account.owner !== SOL_HTLC_PROGRAM_ID || account.data.length !== SOL_ESCROW_LEN) return { err: CUSTOM(16) };
    const escrow = decodeEscrow(account.data);
    if (escrow.status !== "Locked") return { err: CUSTOM(18) };
    if (!(now < escrow.refundAfterMs)) return { err: CUSTOM(19) };
    if (!bytesEqual(sha256(preimage), hexToBytes(escrow.hashLock.slice(2)))) return { err: CUSTOM(20) };
    if (!bytesEqual(mintKey, this.mint)) return { err: CUSTOM(7) };
    const vault = this.tokenOf(vaultKey);
    if (vault === null || vault.amount < BigInt(escrow.amount)) return { err: CUSTOM(17) };
    const payee = this.tokenOf(payeeToken);
    if (payee === null || payee.state !== "initialized" || !bytesEqual(payee.owner, pubkeyFromBase58(escrow.payee)) || !bytesEqual(payee.mint, this.mint)) return { err: CUSTOM(17) };
    if (commit) {
      const total = vault.amount;
      this.setTokenAmount(vaultKey, 0n);
      this.setTokenAmount(payeeToken, payee.amount + total);
      this.chain.put(escrowKey, {
        ...account,
        data: escrowBytes({
          status: "Claimed",
          bump: escrow.bump,
          payer: pubkeyFromBase58(escrow.payer),
          payee: pubkeyFromBase58(escrow.payee),
          mint: this.mint,
          hashLock: hexToBytes(escrow.hashLock.slice(2)),
          amount: BigInt(escrow.amount),
          claimByMs: escrow.claimByMs,
          refundAfterMs: escrow.refundAfterMs,
          preimage,
        }),
      });
    }
    return { err: null };
  }

  private refund(p: Parsed, now: number, commit: boolean): { err: unknown } {
    if (p.data.length !== 1 || p.accounts.length !== 6) return { err: CUSTOM(1) };
    const [payer, escrowKey, vaultKey, mintKey, payerToken] = p.accounts as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    if (p.keys.findIndex((k) => bytesEqual(k, payer)) >= p.tx.message.header.numRequiredSignatures) return { err: CUSTOM(9) };
    const account = this.chain.get(escrowKey);
    if (account === undefined || account.owner !== SOL_HTLC_PROGRAM_ID || account.data.length !== SOL_ESCROW_LEN) return { err: CUSTOM(16) };
    const escrow = decodeEscrow(account.data);
    if (escrow.payer !== pubkeyToBase58(payer)) return { err: CUSTOM(21) };
    if (escrow.status !== "Locked") return { err: CUSTOM(18) };
    if (!(now >= escrow.refundAfterMs)) return { err: CUSTOM(22) };
    if (!bytesEqual(mintKey, this.mint)) return { err: CUSTOM(7) };
    const vault = this.tokenOf(vaultKey);
    if (vault === null) return { err: CUSTOM(17) };
    const dest = this.tokenOf(payerToken);
    if (dest === null || !bytesEqual(dest.owner, payer) || !bytesEqual(dest.mint, this.mint)) return { err: CUSTOM(17) };
    if (commit) {
      this.setTokenAmount(vaultKey, 0n);
      this.setTokenAmount(payerToken, dest.amount + vault.amount);
      this.chain.put(escrowKey, {
        ...account,
        data: escrowBytes({
          status: "Refunded",
          bump: escrow.bump,
          payer,
          payee: pubkeyFromBase58(escrow.payee),
          mint: this.mint,
          hashLock: hexToBytes(escrow.hashLock.slice(2)),
          amount: BigInt(escrow.amount),
          claimByMs: escrow.claimByMs,
          refundAfterMs: escrow.refundAfterMs,
        }),
      });
    }
    return { err: null };
  }

  /** Records an executed transaction the way a real node's ledger answers later reads. */
  private land(tx: SolTransaction, done: { kind: Kind; err: unknown; preimage?: string }): void {
    const slot = this.chain.finalizedSlot;
    this.chain.statuses.set(tx.signature, { slot, confirmations: null, err: done.err, confirmationStatus: "finalized" });
    this.chain.transactions.set(tx.signature, { slot, blockTime: Math.floor(this.chain.finalizedTimeMs / 1000), err: done.err, bytes: tx.bytes });
    const ix = this.programInstruction(tx);
    if (ix !== undefined) {
      for (const index of ix.accountIndexes) {
        const key = pubkeyToBase58(tx.message.accountKeys[index] as Uint8Array);
        // only addresses the program's own accounts live at matter for history reads (escrow, vault)
        const list = this.chain.addressSignatures.get(key) ?? [];
        list.unshift({ signature: tx.signature, slot, err: done.err });
        this.chain.addressSignatures.set(key, list);
      }
    }
    // Real blockhashes move every slot: a transaction signed after this one (a retry) names a different one, so
    // it is a different transaction (an identical re-send would be "already processed").
    this.blockhashCounter += 1;
    this.chain.blockhash = base58.encode(new Uint8Array(32).fill(0x42 + (this.blockhashCounter % 200)));
    this.history.push({ kind: done.kind, signature: tx.signature, err: done.err, ...(done.preimage === undefined ? {} : { preimage: done.preimage }) });
  }
}
