// SPDX-License-Identifier: MIT
//
// The stateful fake NEAR node of tests/client-flows-near-rpc.test.ts (P5-NEAR-FIXES.md Group G), moved here unchanged so the
// P8 crash-resume matrix (tests/resume-*.test.ts) can drive the REAL flows over the REAL near rail over the same simulator.
// The only additions are the ones recovery needs: `EXPERIMENTAL_tx_status` by transaction hash, and counters of the sends it
// applied. Nothing about the simulated contract changed.
//
// R1-10 / R1-19 additions (rail recovery of a transaction that was signed and saved but never sent, or that landed while the
// node still hides it): the node now models what a real one answers to `send_tx` -- `InvalidNonce` for a nonce the access key
// has already consumed, `Expired` for a block hash older than `txValidityPeriodBlocks` (or one it never had) -- and block
// heights move on demand (`advanceBlocks`). `lockRowDelayBlocks` delays the `ft_on_transfer` receipt that creates a lock row
// (the row is invisible to a read at an earlier block), and `txStatusUnknown` makes `EXPERIMENTAL_tx_status` answer
// UNKNOWN_TRANSACTION for every hash (a lagging node). All default to the old behaviour.

import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

import { decodeSignedTransactionHeader } from "../../src/rails/near-borsh.js";
import { NEAR_SANDBOX_PIN, type NearRailConfig } from "../../src/rails/near-htlc.js";

// ── a minimal borsh reader (the write side lives in src/rails/near-borsh.ts; this file never
//    imports it — decoding what the REAL adapter actually signed and sent is exactly the point) ──

export class BorshReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new Error("BorshReader: unexpected end of buffer");
  }
  readU8(): number {
    this.need(1);
    const v = this.bytes[this.pos]!;
    this.pos += 1;
    return v;
  }
  readU32(): number {
    this.need(4);
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4).getUint32(0, true);
    this.pos += 4;
    return v;
  }
  readU64(): bigint {
    this.need(8);
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8).getBigUint64(0, true);
    this.pos += 8;
    return v;
  }
  readU128(): bigint {
    this.need(16);
    let v = 0n;
    for (let i = 15; i >= 0; i -= 1) v = (v << 8n) | BigInt(this.bytes[this.pos + i]!);
    this.pos += 16;
    return v;
  }
  readBytes(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  readByteVec(): Uint8Array {
    return this.readBytes(this.readU32());
  }
  readString(): string {
    return new TextDecoder().decode(this.readByteVec());
  }
}

export interface DecodedFunctionCall {
  signerId: string;
  receiverId: string;
  methodName: string;
  argsJson: Record<string, unknown>;
  /** P8 additions, for `EXPERIMENTAL_tx_status`: the transaction as a node would describe it. */
  publicKeyBytes: Uint8Array;
  nonce: bigint;
  /** R1-10: the block hash the transaction was built on (base58), which decides whether it can still be included. */
  blockHashBase58: string;
  argsBase64: string;
  gas: bigint;
  deposit: bigint;
}

/** Decodes exactly what `src/rails/near-borsh.ts`'s `encodeSignedTransaction` writes for a
 *  `TransactionV0` carrying a single `FunctionCall` action — the only shape `near-htlc.ts` ever
 *  sends (`prepareLock`/`claim`/`refund`, one action each). Throws loudly on anything else, so a
 *  future adapter change that starts batching actions (or sends a different action type) fails
 *  this file's own tests rather than silently mis-decoding. */
export function decodeSignedTxFunctionCall(signedTxBase64: string): DecodedFunctionCall {
  const bytes = Uint8Array.from(Buffer.from(signedTxBase64, "base64"));
  const r = new BorshReader(bytes);
  const signerId = r.readString();
  const keyType = r.readU8();
  if (keyType !== 0) throw new Error(`decodeSignedTxFunctionCall: unsupported public key type tag ${keyType}`);
  const publicKeyBytes = r.readBytes(32);
  const nonce = r.readU64();
  const receiverId = r.readString();
  const blockHashBase58 = base58.encode(r.readBytes(32));
  const actionCount = r.readU32();
  if (actionCount !== 1) throw new Error(`decodeSignedTxFunctionCall: expected exactly 1 action, got ${actionCount}`);
  const tag = r.readU8();
  if (tag !== 2) throw new Error(`decodeSignedTxFunctionCall: expected a FunctionCall action (tag 2), got ${tag}`);
  const methodName = r.readString();
  const argsBytes = r.readByteVec();
  const gas = r.readU64();
  const deposit = r.readU128();
  const argsJson = JSON.parse(new TextDecoder().decode(argsBytes)) as Record<string, unknown>;
  return { signerId, receiverId, methodName, argsJson, publicKeyBytes, nonce, blockHashBase58, argsBase64: Buffer.from(argsBytes).toString("base64"), gas, deposit };
}

// ── the stateful fake NEAR node ──────────────────────────────────────────────────────────────

export interface LockRow {
  status: "Locked" | "Claiming" | "Claimed" | "Refunding" | "Refunded";
  payer: string;
  payee: string;
  token: string;
  amount: string;
  claimByMs: number;
  refundAfterMs: number;
  /** hex, no `0x` (matches the contract's own `get_lock` field — near-htlc.ts's `parseLockView`
   *  adds the `0x` prefix back on read). */
  preimage: string | null;
  /** R1-19: the first block height at which a read shows this row (the `ft_on_transfer` receipt's block); absent = at once. */
  visibleFromHeight?: number;
}

/** A JSON-RPC error body the node answers with (the shape a real near-sandbox gave, see tests/near-rpc.test.ts). */
export interface SimRpcErrorBody {
  code: number;
  message: string;
  name?: string;
  cause?: unknown;
  data?: unknown;
}
class SimRpcError extends Error {
  constructor(readonly body: SimRpcErrorBody) {
    super(body.message);
  }
}
const invalidTx = (reason: unknown): SimRpcError =>
  new SimRpcError({ code: -32000, message: "Server error", name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: reason } } });

export class StatefulNearRpc {
  private readonly locks = new Map<string, LockRow>();
  private readonly nonces = new Map<string, number>();
  private readonly registered = new Set<string>();
  private readonly accountsWithoutKeys = new Set<string>();
  private readonly readsRemainingBeforeUnregister = new Map<string, number>();
  private blockHeight = 100;
  /** R1-10: block height by block hash (every block the node ever had), for the `Expired` check of `send_tx`. */
  private readonly heightByHash = new Map<string, number>();
  /** R1-10: a transaction built on a block more than this many blocks behind the head is `Expired` (nearcore's
   *  `transaction_validity_period`; the real default is 86400, so a test that wants an expiry sets a small one). */
  txValidityPeriodBlocks = 86_400;
  /** R1-19: blocks between a lock transaction's inclusion and the `ft_on_transfer` receipt that creates its row. */
  lockRowDelayBlocks = 0;
  /** R1-19: `EXPERIMENTAL_tx_status` answers UNKNOWN_TRANSACTION for every hash (a lagging or load-balanced node). */
  txStatusUnknown = false;
  /** R1-10: every `send_tx` that reached this node, and how many of them it rejected as expired or as an invalid nonce. */
  sendTxReceived = 0;
  sendTxExpired = 0;
  sendTxInvalidNonce = 0;
  nowMs: number;
  forceNextClaimTxFailure = false;
  forceNextRefundTxFailure = false;
  claimSendTxCalls = 0;
  refundSendTxCalls = 0;
  /** P8: `ft_transfer_call` sends applied, and the lock rows they actually created. */
  lockSendTxCalls = 0;
  lockRowsCreated = 0;
  /** P8: every applied send by transaction hash, as `EXPERIMENTAL_tx_status` answers it. */
  private readonly appliedTxs = new Map<string, Record<string, unknown>>();
  /** When set, the NEXT `send_tx` this rpc would otherwise process still updates state exactly
   *  as normal, but the caller receives a thrown network-style error instead of a response —
   *  models a reply genuinely lost after the write already executed on chain (G2's own scenario:
   *  a retry must recognise success from the chain, not from the write's own return). */
  dropNextSendTxReply = false;

  constructor(
    private readonly contract: string,
    private readonly token: string,
    private readonly codeHash: string,
    nowMs: number,
  ) {
    this.nowMs = nowMs;
    this.heightByHash.set(this.blockHashFor(this.blockHeight), this.blockHeight);
  }

  /** R1-19 / R1-10: the chain moves on by `n` blocks (and its time by `msPerBlock` each, 0 keeps `nowMs`). */
  advanceBlocks(n: number, msPerBlock = 0): void {
    for (let i = 0; i < n; i += 1) {
      this.blockHeight += 1;
      this.heightByHash.set(this.blockHashFor(this.blockHeight), this.blockHeight);
      this.nowMs += msPerBlock;
    }
  }
  get height(): number {
    return this.blockHeight;
  }
  /** R1-10: another transaction of this account's key took nonces up to `nonce` (the key's nonce never moves back). */
  consumeNonce(accountId: string, nonce: number): void {
    this.nonces.set(accountId, Math.max(this.nonces.get(accountId) ?? 0, nonce));
  }
  /** R1-10: the key's current nonce, as `view_access_key` reports it. */
  nonceOf(accountId: string): number {
    return this.nonces.get(accountId) ?? 0;
  }

  registerStorage(accountId: string): void {
    this.registered.add(accountId);
  }
  /** P7 fix pass (F2): the account's access keys are gone (deleted or rotated): every
   *  `view_access_key` for it answers "does not exist". */
  deleteAccessKeys(accountId: string): void {
    this.accountsWithoutKeys.add(accountId);
  }
  unregisterStorage(accountId: string): void {
    this.registered.delete(accountId);
  }
  /** Arms an automatic un-registration the `reads`-th time `storage_balance_of(accountId)` is
   *  read while still registered — lets a test put a real race between the adapter's own
   *  preimage-free pre-check (near-htlc.ts's `claim()`, read #2 after `verifyLockFinal`'s own
   *  read #1) and the actual on-chain payout, reproducing H1's S1 scenario through the real
   *  client rather than asserting it by fiat. */
  armPayoutFailureAfterReads(accountId: string, reads: number): void {
    this.readsRemainingBeforeUnregister.set(accountId, reads);
  }
  private key(payer: string, hashLockHex: string): string {
    return `${payer}:${hashLockHex}`;
  }
  getLockRow(hashLockHex: string, payer: string = BUYER_ACCOUNT): LockRow | undefined {
    return this.locks.get(this.key(payer, hashLockHex));
  }
  /** A third party's own `ft_transfer_call` lock landing first, under a public hash lock. */
  squat(payer: string, hashLockHex: string, terms: { payee: string; amount: string; claimByMs: number; refundAfterMs: number }): void {
    this.locks.set(this.key(payer, hashLockHex), {
      status: "Locked",
      payer,
      payee: terms.payee,
      token: this.token,
      amount: terms.amount,
      claimByMs: terms.claimByMs,
      refundAfterMs: terms.refundAfterMs,
      preimage: null,
    });
  }

  private blockHashFor(height: number): string {
    return base58.encode(sha256(new TextEncoder().encode(`block:${height}`)));
  }
  private currentBlock(): { height: number; hash: string; timestampNs: string } {
    return { height: this.blockHeight, hash: this.blockHashFor(this.blockHeight), timestampNs: `${BigInt(Math.round(this.nowMs)) * 1_000_000n}` };
  }
  private lockViewJson(hashLockHex: string, payer: string, atHeight: number = this.blockHeight): string {
    const row = this.locks.get(this.key(payer, hashLockHex));
    if (row === undefined) return "null";
    if (row.visibleFromHeight !== undefined && row.visibleFromHeight > atHeight) return "null"; // the receipt is not executed yet
    return JSON.stringify({
      status: row.status,
      payer: row.payer,
      payee: row.payee,
      token: row.token,
      amount: row.amount,
      claim_by_ms: String(row.claimByMs),
      refund_after_ms: String(row.refundAfterMs),
      ...(row.preimage === null ? {} : { preimage: row.preimage }),
    });
  }
  private callFunctionResult(resultJsonText: string): unknown {
    const block = this.currentBlock();
    return { result: Array.from(new TextEncoder().encode(resultJsonText)), logs: [], block_height: block.height, block_hash: block.hash };
  }

  private handleQuery(params: Record<string, unknown>): unknown {
    const requestType = params.request_type;
    if (requestType === "view_account") {
      const block = this.currentBlock();
      return { amount: "1000000000000000000000000", code_hash: this.codeHash, block_height: block.height, block_hash: block.hash };
    }
    if (requestType === "view_access_key_list") {
      // H6: this build's own contract is always deployed keyless once setup finishes.
      const block = this.currentBlock();
      return { keys: [], block_height: block.height, block_hash: block.hash };
    }
    if (requestType === "view_access_key") {
      const accountId = params.account_id as string;
      const block = this.currentBlock();
      if (this.accountsWithoutKeys.has(accountId)) {
        return { error: `access key ${String(params.public_key)} does not exist while viewing`, block_height: block.height, block_hash: block.hash };
      }
      return { nonce: this.nonces.get(accountId) ?? 0, permission: "FullAccess", block_height: block.height, block_hash: block.hash };
    }
    if (requestType === "call_function") {
      const methodName = params.method_name as string;
      const argsBase64 = params.args_base64 as string;
      const args = JSON.parse(Buffer.from(argsBase64, "base64").toString("utf8")) as Record<string, unknown>;
      if (methodName === "get_lock") {
        const atHeight = typeof params.block_id === "number" ? params.block_id : this.blockHeight;
        return this.callFunctionResult(this.lockViewJson(args.hash_lock as string, args.payer as string, atHeight));
      }
      if (methodName === "storage_balance_of") {
        const accountId = args.account_id as string;
        const registered = this.registered.has(accountId);
        const remaining = this.readsRemainingBeforeUnregister.get(accountId);
        if (registered && remaining !== undefined) {
          if (remaining <= 1) {
            this.readsRemainingBeforeUnregister.delete(accountId);
            this.registered.delete(accountId);
          } else {
            this.readsRemainingBeforeUnregister.set(accountId, remaining - 1);
          }
        }
        return this.callFunctionResult(registered ? JSON.stringify({ total: "1250000000000000000000", available: "0" }) : "null");
      }
      throw new Error(`StatefulNearRpc: unhandled call_function method ${methodName}`);
    }
    throw new Error(`StatefulNearRpc: unhandled query request_type ${String(requestType)}`);
  }

  private handleSendTx(params: Record<string, unknown>): unknown {
    const decoded = decodeSignedTxFunctionCall(params.signed_tx_base64 as string);
    this.sendTxReceived += 1;
    // R1-10: what a real node checks first. A block hash it never had, or one too far behind the head, is `Expired`; a nonce
    // the access key has already consumed (by another transaction, or by this very one) is `InvalidNonce`.
    const builtOn = this.heightByHash.get(decoded.blockHashBase58);
    if (builtOn === undefined || this.blockHeight - builtOn > this.txValidityPeriodBlocks) {
      this.sendTxExpired += 1;
      throw invalidTx("Expired");
    }
    const keyNonce = this.nonces.get(decoded.signerId) ?? 0;
    if (Number(decoded.nonce) <= keyNonce) {
      this.sendTxInvalidNonce += 1;
      throw invalidTx({ InvalidNonce: { tx_nonce: Number(decoded.nonce), ak_nonce: keyNonce } });
    }
    // The access key's nonce moves to the transaction's own (never backwards), as on a real node.
    this.nonces.set(decoded.signerId, Math.max(this.nonces.get(decoded.signerId) ?? 0, Number(decoded.nonce)));
    let failure: unknown = null;
    // H9: `ft_transfer_call` resolves to the amount used (JSON string): the whole amount when the
    // lock was made, "0" when `ft_on_transfer` refused it (as observed on a real near-sandbox).
    let successValue = "";

    if (decoded.methodName === "ft_transfer_call") {
      this.lockSendTxCalls += 1;
      const amount = decoded.argsJson.amount as string;
      const msg = JSON.parse(decoded.argsJson.msg as string) as { hash_lock: string; payee: string; claim_by_ms: string; refund_after_ms: string };
      const alreadyExists = this.locks.has(this.key(decoded.signerId, msg.hash_lock));
      const refused = alreadyExists || msg.payee === this.contract || msg.payee === this.token || BigInt(amount) <= 0n;
      successValue = Buffer.from(JSON.stringify(refused ? "0" : amount)).toString("base64");
      if (!refused) {
        this.lockRowsCreated += 1;
        this.locks.set(this.key(decoded.signerId, msg.hash_lock), {
          status: "Locked",
          payer: decoded.signerId,
          payee: msg.payee,
          token: this.token,
          amount,
          claimByMs: Number(msg.claim_by_ms),
          refundAfterMs: Number(msg.refund_after_ms),
          preimage: null,
          // the transaction is included in the block this send is about to create; its receipt executes `lockRowDelayBlocks` later
          ...(this.lockRowDelayBlocks > 0 ? { visibleFromHeight: this.blockHeight + 1 + this.lockRowDelayBlocks } : {}),
        });
      }
      // S3: `ft_on_transfer` refuses without ever panicking — the outer transfer call still
      // reports Success either way (the token contract returns the tokens on refusal).
    } else if (decoded.methodName === "claim") {
      this.claimSendTxCalls += 1;
      const hashLockHex = decoded.argsJson.hash_lock as string;
      const preimageHex = decoded.argsJson.preimage as string;
      const row = this.locks.get(this.key(decoded.argsJson.payer as string, hashLockHex));
      const digestHex = Buffer.from(sha256(Uint8Array.from(Buffer.from(preimageHex, "hex")))).toString("hex");
      if (this.forceNextClaimTxFailure) {
        this.forceNextClaimTxFailure = false;
        failure = { ActionError: { kind: { FunctionCallError: "forced test failure (top-level)" } } };
      } else if (row === undefined || row.status !== "Locked" || digestHex !== hashLockHex) {
        failure = { ActionError: { kind: { FunctionCallError: "claim refused: lock not claimable or preimage mismatch" } } };
      } else {
        // The contract's own `claim()`: the preimage is revealed synchronously, before the
        // payout promise ever runs (F4) — `wait_until: "FINAL"` always waits for the whole
        // receipt chain, so the payout's own outcome (registered or not, checked RIGHT NOW,
        // in-process — never a further RPC round trip) is reflected in this same response.
        row.preimage = preimageHex;
        row.status = this.registered.has(row.payee) ? "Claimed" : "Locked";
      }
    } else if (decoded.methodName === "refund") {
      this.refundSendTxCalls += 1;
      const hashLockHex = decoded.argsJson.hash_lock as string;
      const row = this.locks.get(this.key(decoded.signerId, hashLockHex));
      if (this.forceNextRefundTxFailure) {
        this.forceNextRefundTxFailure = false;
        failure = { ActionError: { kind: { FunctionCallError: "forced test failure (top-level)" } } };
      } else if (row === undefined || row.status !== "Locked" || row.payer !== decoded.signerId || this.nowMs < row.refundAfterMs) {
        failure = { ActionError: { kind: { FunctionCallError: "refund refused" } } };
      } else {
        row.status = this.registered.has(row.payer) ? "Refunded" : "Locked";
      }
    } else {
      throw new Error(`StatefulNearRpc: unhandled send_tx method ${decoded.methodName}`);
    }

    this.advanceBlocks(1);
    const block = this.currentBlock();
    const status = failure === null ? { SuccessValue: successValue } : { Failure: failure };
    // P8: remember the transaction under its own hash, for `EXPERIMENTAL_tx_status` (the lost-reply recovery path).
    const txHash = decodeSignedTransactionHeader(Uint8Array.from(Buffer.from(params.signed_tx_base64 as string, "base64"))).txHashBase58;
    this.appliedTxs.set(txHash, {
      status,
      transaction: {
        signer_id: decoded.signerId,
        public_key: `ed25519:${base58.encode(decoded.publicKeyBytes)}`,
        receiver_id: decoded.receiverId,
        nonce: Number(decoded.nonce),
        hash: txHash,
        actions: [{ FunctionCall: { method_name: decoded.methodName, args: decoded.argsBase64, gas: Number(decoded.gas), deposit: decoded.deposit.toString() } }],
      },
      transaction_outcome: { id: txHash, block_hash: block.hash },
    });
    return { status, transaction_outcome: { id: `outcome-${this.blockHeight}`, block_hash: block.hash } };
  }

  /** P8: what `EXPERIMENTAL_tx_status` answers for `txHash`: the applied transaction, or the node's UNKNOWN_TRANSACTION. */
  private handleTxStatus(params: Record<string, unknown>): { result: unknown } | { error: SimRpcErrorBody } {
    const known = this.txStatusUnknown ? undefined : this.appliedTxs.get(String(params.tx_hash));
    if (known === undefined) return { error: { code: -32000, message: "Server error", name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} } } };
    return { result: known };
  }

  /** The one dispatch point every fake `fetch` call routes through. */
  handle(method: string, params: unknown): { result: unknown } | { error: SimRpcErrorBody } {
    try {
      if (method === "EXPERIMENTAL_tx_status") return this.handleTxStatus(params as Record<string, unknown>);
      if (method === "status") return { result: { chain_id: "near-sandbox-flop", protocol_version: 86, sync_info: {} } };
      if (method === "block") {
        const block = this.currentBlock();
        return { result: { header: { height: block.height, hash: block.hash, timestamp_nanosec: block.timestampNs } } };
      }
      if (method === "query") return { result: this.handleQuery(params as Record<string, unknown>) };
      if (method === "send_tx") {
        if (this.dropNextSendTxReply) {
          this.dropNextSendTxReply = false;
          this.handleSendTx(params as Record<string, unknown>); // the write still happens...
          throw new Error("StatefulNearRpc: simulated lost reply (the write above already landed)");
        }
        return { result: this.handleSendTx(params as Record<string, unknown>) };
      }
      throw new Error(`StatefulNearRpc: unhandled method ${method}`);
    } catch (error) {
      if (error instanceof SimRpcError) return { error: error.body };
      return { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
  }
}

export function fetchFor(node: StatefulNearRpc): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { id: number | string; method: string; params: unknown };
    let outcome: { result: unknown } | { error: SimRpcErrorBody };
    try {
      outcome = node.handle(parsed.method, parsed.params);
    } catch (error) {
      // A thrown error (StatefulNearRpc's own `dropNextSendTxReply`) models the HTTP request
      // itself failing, never reaching a JSON-RPC envelope at all.
      throw error instanceof Error ? error : new Error(String(error));
    }
    const body = JSON.stringify("error" in outcome ? { jsonrpc: "2.0", id: parsed.id, error: outcome.error } : { jsonrpc: "2.0", id: parsed.id, result: outcome.result });
    const bytes = new TextEncoder().encode(body);
    return { text: async () => body, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
}

// ── fixtures shared with the tests ───────────────────────────────────────────────────────────

export const CONTRACT = "htlc.near-sandbox-flop";
export const USDC = "usdc.near-sandbox-flop";
export const HTLC_CODE_HASH = "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT";
export const BUYER_ACCOUNT = "buyer.near-sandbox-flop";
export const SELLER_ACCOUNT = "seller.near-sandbox-flop";

export function nearConfig(): NearRailConfig {
  return { pin: NEAR_SANDBOX_PIN, endpoint: "http://127.0.0.1:9999", contract: CONTRACT, assets: { USDC }, htlcCodeHash: HTLC_CODE_HASH };
}
