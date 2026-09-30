// SPDX-License-Identifier: MIT
//
// tests/client-flows-near-rpc.test.ts — P5-NEAR-FIXES.md Group G (G1, G2, G3, G4): hermetic tests
// for SellerFlow.claimLegA/BuyerFlow.refundLegA/BuyerFlow.reconcileLockA's own near-htlc-specific
// fixes, driven through the REAL client flows (src/client/seller.ts, buyer.ts) over the REAL
// near-htlc rail wiring (src/client/near-rail.ts -> src/rails/near-htlc.ts -> src/rails/near-rpc
// .ts -> src/rails/near-evidence.ts) — never a scripted `FakeCounterAssetRail` the way
// tests/client-flows-near.test.ts exercises the rail-agnostic flow logic. Only the wire transport
// is fake: a `fetch` injected into `CapturingRpc` (mirroring tests/near-htlc.test.ts's own
// pattern), backed here by `StatefulNearRpc` — a small, deliberately narrow simulator of the
// deployed `htlc` contract's own state machine (get_lock/storage_balance_of reads, ft_transfer_
// call/claim/refund writes) that decodes each outgoing transaction's borsh bytes for itself
// (methodName + JSON args), so the same signed transaction near-htlc.ts actually builds and sends
// is what drives the mock's own state transitions — never a scripted queue of canned responses
// that would let this file's own assumptions about call order silently diverge from what the
// adapter really sends.
//
// Modelled contract rules (P5-NEAR-SPEC.md §2/§4, H1/H2/F4's own doc in src/rails/near-htlc.ts):
//   - Squatting fix: locks are keyed by (payer, hash lock). `ft_transfer_call` creates a `Locked`
//     row unless one already exists for that SAME pair (S3: the transfer call itself still
//     reports `Success`; `ft_on_transfer` simply refuses). `get_lock`/`claim` name the payer;
//     `refund` is keyed by the signer. `squat()` lands another payer's lock under a public hash
//     lock first, exactly what a third party holding the token can do.
//   - `claim` reveals the preimage (sets it, moves to `Claiming`) BEFORE the payout promise runs,
//     synchronously within the same `send_tx` (`wait_until: "FINAL"` always waits for the whole
//     receipt chain) — the payout then either lands (`Claimed`) or fails (F4: reverts to `Locked`
//     with the preimage kept) depending on whether the payee is storage-registered AT THAT
//     MOMENT, which this file can arm to flip between the adapter's own pre-check read and the
//     actual on-chain execution (`armPayoutFailureAfterReads`), reproducing H1's own S1 scenario
//     (payee unregistered by the time the payout promise ran) through the real client and real
//     adapter rather than asserting it by fiat.
//   - `refund` is the mirror image on the payer's side.
//   - `forceNextClaimTxFailure`/`forceNextRefundTxFailure` model an arbitrary top-level `Failure`
//     (an out-of-gas panic, or — H1's own named scenario — a claim landing at/after
//     `refundAfterMs`) returned as an ordinary HTTP-200 JSON-RPC response with `status.Failure`,
//     exactly the shape a real near-sandbox node reports for an executed-but-failed transaction
//     (never a JSON-RPC-level `error`) — this is deliberately a test-controlled trigger rather
//     than a precisely-timed deadline race, since the client's OWN guards (H3's landing margin,
//     the flow's own claimByMs/margin checks) already refuse to broadcast a claim that would
//     obviously land past the deadline; what H1 protects against is a chain-level failure for ANY
//     reason once a transaction is broadcast, and this file exercises exactly that.
//
// Design source: flop-contrib/handoff/P5-NEAR-FIXES.md Group G (G1-G5);
// flop-contrib/handoff/P5-NEAR-DECISIONS-2026-09-29.md D-N1..D-N10;
// tests/near-htlc.test.ts (the mocked-fetch pattern this file's own transport reuses).

import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { dealRoom, MemoryNoteStore, PaperRail, tryDecodeFrame, type TranscriptRecord } from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue, type Signer, type Venue } from "../src/client/venue.js";
import { createNearCounterRail } from "../src/client/near-rail.js";
import { NEAR_SANDBOX_PIN, type NearRailConfig } from "../src/rails/near-htlc.js";
import { InMemoryNearSigner } from "../src/rails/near-signer-memory.js";
import { CapturingRpc } from "../src/rails/rpc-capture.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { identity, type Identity } from "./helpers/identity.js";

// ── a minimal borsh reader (the write side lives in src/rails/near-borsh.ts; this file never
//    imports it — decoding what the REAL adapter actually signed and sent is exactly the point) ──

class BorshReader {
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

interface DecodedFunctionCall {
  signerId: string;
  receiverId: string;
  methodName: string;
  argsJson: Record<string, unknown>;
}

/** Decodes exactly what `src/rails/near-borsh.ts`'s `encodeSignedTransaction` writes for a
 *  `TransactionV0` carrying a single `FunctionCall` action — the only shape `near-htlc.ts` ever
 *  sends (`prepareLock`/`claim`/`refund`, one action each). Throws loudly on anything else, so a
 *  future adapter change that starts batching actions (or sends a different action type) fails
 *  this file's own tests rather than silently mis-decoding. */
function decodeSignedTxFunctionCall(signedTxBase64: string): DecodedFunctionCall {
  const bytes = Uint8Array.from(Buffer.from(signedTxBase64, "base64"));
  const r = new BorshReader(bytes);
  const signerId = r.readString();
  const keyType = r.readU8();
  if (keyType !== 0) throw new Error(`decodeSignedTxFunctionCall: unsupported public key type tag ${keyType}`);
  r.readBytes(32); // public key
  r.readU64(); // nonce
  const receiverId = r.readString();
  r.readBytes(32); // block hash
  const actionCount = r.readU32();
  if (actionCount !== 1) throw new Error(`decodeSignedTxFunctionCall: expected exactly 1 action, got ${actionCount}`);
  const tag = r.readU8();
  if (tag !== 2) throw new Error(`decodeSignedTxFunctionCall: expected a FunctionCall action (tag 2), got ${tag}`);
  const methodName = r.readString();
  const argsBytes = r.readByteVec();
  r.readU64(); // gas
  r.readU128(); // deposit
  const argsJson = JSON.parse(new TextDecoder().decode(argsBytes)) as Record<string, unknown>;
  return { signerId, receiverId, methodName, argsJson };
}

// ── the stateful fake NEAR node ──────────────────────────────────────────────────────────────

interface LockRow {
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
}

class StatefulNearRpc {
  private readonly locks = new Map<string, LockRow>();
  private readonly nonces = new Map<string, number>();
  private readonly registered = new Set<string>();
  private readonly readsRemainingBeforeUnregister = new Map<string, number>();
  private blockHeight = 100;
  nowMs: number;
  forceNextClaimTxFailure = false;
  forceNextRefundTxFailure = false;
  claimSendTxCalls = 0;
  refundSendTxCalls = 0;
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
  }

  registerStorage(accountId: string): void {
    this.registered.add(accountId);
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
  private lockViewJson(hashLockHex: string, payer: string): string {
    const row = this.locks.get(this.key(payer, hashLockHex));
    if (row === undefined) return "null";
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
      return { nonce: this.nonces.get(accountId) ?? 0, permission: "FullAccess", block_height: block.height, block_hash: block.hash };
    }
    if (requestType === "call_function") {
      const methodName = params.method_name as string;
      const argsBase64 = params.args_base64 as string;
      const args = JSON.parse(Buffer.from(argsBase64, "base64").toString("utf8")) as Record<string, unknown>;
      if (methodName === "get_lock") {
        return this.callFunctionResult(this.lockViewJson(args.hash_lock as string, args.payer as string));
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
    this.nonces.set(decoded.signerId, (this.nonces.get(decoded.signerId) ?? 0) + 1);
    let failure: unknown = null;
    // H9: `ft_transfer_call` resolves to the amount used (JSON string): the whole amount when the
    // lock was made, "0" when `ft_on_transfer` refused it (as observed on a real near-sandbox).
    let successValue = "";

    if (decoded.methodName === "ft_transfer_call") {
      const amount = decoded.argsJson.amount as string;
      const msg = JSON.parse(decoded.argsJson.msg as string) as { hash_lock: string; payee: string; claim_by_ms: string; refund_after_ms: string };
      const alreadyExists = this.locks.has(this.key(decoded.signerId, msg.hash_lock));
      const refused = alreadyExists || msg.payee === this.contract || msg.payee === this.token || BigInt(amount) <= 0n;
      successValue = Buffer.from(JSON.stringify(refused ? "0" : amount)).toString("base64");
      if (!refused) {
        this.locks.set(this.key(decoded.signerId, msg.hash_lock), {
          status: "Locked",
          payer: decoded.signerId,
          payee: msg.payee,
          token: this.token,
          amount,
          claimByMs: Number(msg.claim_by_ms),
          refundAfterMs: Number(msg.refund_after_ms),
          preimage: null,
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

    this.blockHeight += 1;
    const block = this.currentBlock();
    return { status: failure === null ? { SuccessValue: successValue } : { Failure: failure }, transaction_outcome: { id: `outcome-${this.blockHeight}`, block_hash: block.hash } };
  }

  /** The one dispatch point every fake `fetch` call routes through. */
  handle(method: string, params: unknown): { result: unknown } | { error: { code: number; message: string } } {
    try {
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
      return { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
  }
}

function fetchFor(node: StatefulNearRpc): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { id: number | string; method: string; params: unknown };
    let outcome: { result: unknown } | { error: { code: number; message: string } };
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

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const CONTRACT = "htlc.near-sandbox-flop";
const USDC = "usdc.near-sandbox-flop";
const HTLC_CODE_HASH = "5CVXgVR5RfKHGYqDDXWMKcadxHTfjaEczo6zRLfBrpFT";
const BUYER_ACCOUNT = "buyer.near-sandbox-flop";
const SELLER_ACCOUNT = "seller.near-sandbox-flop";
const SEED_BUYER = new Uint8Array(32).fill(11);
const SEED_SELLER = new Uint8Array(32).fill(22);

function nearConfig(): NearRailConfig {
  return { pin: NEAR_SANDBOX_PIN, endpoint: "http://127.0.0.1:9999", contract: CONTRACT, assets: { USDC }, htlcCodeHash: HTLC_CODE_HASH };
}

function ident(tag: number): Identity {
  return identity(tag.toString(16).padStart(2, "0").repeat(32));
}

function legADeadlines(windowMs: number) {
  const lockTimeMs = T0 + 30 * 60_000;
  return { claimByMs: lockTimeMs + 5 * 60_000, refundAfterMs: lockTimeMs + windowMs, expiresMs: T0 + 10 * 60_000, lockTimeMs };
}
function legBDeadlines() {
  return { claimByMs: T0 + 12 * 60 * 60_000, refundAfterMs: T0 + 24 * 60 * 60_000, expiresMs: T0 + 60 * 60_000 };
}

/** One node + one buyer rail + one seller rail, each with its own `CapturingRpc` (mirroring two
 *  independent parties each running their own RPC client) over the SAME `StatefulNearRpc` (the
 *  one chain both parties actually observe). */
function harness() {
  const node = new StatefulNearRpc(CONTRACT, USDC, HTLC_CODE_HASH, T0);
  const config = nearConfig();
  const buyer = ident(1);
  const seller = ident(2);
  const clockRef = { ms: T0 };
  const clock = () => clockRef.ms;
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();

  const buyerSigner = InMemoryNearSigner.generate(BUYER_ACCOUNT, SEED_BUYER);
  const sellerSigner = InMemoryNearSigner.generate(SELLER_ACCOUNT, SEED_SELLER);
  const buyerRpc = new CapturingRpc({ endpoint: config.endpoint, fetch: fetchFor(node), clock: () => clockRef.ms });
  const sellerRpc = new CapturingRpc({ endpoint: config.endpoint, fetch: fetchFor(node), clock: () => clockRef.ms });
  const buyerRail = createNearCounterRail({ config, rpc: buyerRpc, signer: buyerSigner, clock: () => node.nowMs });
  const sellerRail = createNearCounterRail({ config, rpc: sellerRpc, signer: sellerSigner, clock: () => node.nowMs });

  const buyerFlow = new BuyerFlow({ identity: buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail, clock });
  const sellerFlow = new SellerFlow({ identity: seller, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock });
  return { node, buyer, seller, venue, clockRef, clock, buyerFlow, sellerFlow };
}

/** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both account lines ->
 *  lockLegA (the real NEAR write, against the stateful node) — the full happy prefix up to (but
 *  not including) a claim/refund. Both parties' NEAR accounts are storage-registered on the
 *  token BEFORE locking, unless a test wants otherwise (a test un-registers/arms after this). */
async function lockedFlow(h: ReturnType<typeof harness>, windowMs = 6 * 60 * 60_000) {
  h.node.registerStorage(BUYER_ACCOUNT);
  h.node.registerStorage(SELLER_ACCOUNT);
  const legA = legADeadlines(windowMs);
  const swapId = computeSwapId(h.buyer.did, "00000001");
  const offerA = await h.buyerFlow.bid({
    swapId,
    wantAsset: "FLOP",
    wantAmount: "52070000",
    wantRail: "flop-htlc",
    amount: "1000000",
    asset: "USDC",
    claimByMs: legA.claimByMs,
    refundAfterMs: legA.refundAfterMs,
    expiresMs: T0 + 10 * 60_000,
  });
  const { acceptA, acceptARecord, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
  const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
  await h.sellerFlow.lockLegB(acceptBRecord);
  await h.buyerFlow.verifyLegBLocked();
  await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
  await h.buyerFlow.postAccountLineA(BUYER_ACCOUNT);
  await h.buyerFlow.lockLegA();
  const statement = h.sellerFlow.statement;
  if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
  return { offerA, acceptA, statement };
}

function dealRoomOf(acceptA: { contract: string }): string {
  return dealRoom(acceptA.contract);
}

function framesIn(records: readonly TranscriptRecord[], type: string): TranscriptRecord[] {
  return records.filter((r) => tryDecodeFrame(r.line)?.type === type);
}

// ── squatting fix: a third party locking under the public hash lock first ───────────────────

describe("squatting fix — a squatter's lock under the swap's hash lock never blocks the real one", () => {
  const SQUATTER = "squatter.near-sandbox-flop";

  /** Everything `lockedFlow` does, but a squatter's own lock lands under the (public) hash lock
   *  right before the Buyer's `lockLegA`. */
  async function lockedFlowWithSquat(h: ReturnType<typeof harness>) {
    h.node.registerStorage(BUYER_ACCOUNT);
    h.node.registerStorage(SELLER_ACCOUNT);
    const legA = legADeadlines(6 * 60 * 60_000);
    const swapId = computeSwapId(h.buyer.did, "00000001");
    const offerA = await h.buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      claimByMs: legA.claimByMs,
      refundAfterMs: legA.refundAfterMs,
      expiresMs: T0 + 10 * 60_000,
    });
    const { acceptA, acceptARecord, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
    await h.buyerFlow.postAccountLineA(BUYER_ACCOUNT);
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: seller's own statement was never minted");
    // The squat: same hash lock, 1 unit, the same payee and windows a copycat would read off the offer.
    h.node.squat(SQUATTER, statement.slice(2), { payee: SELLER_ACCOUNT, amount: "1", claimByMs: legA.claimByMs, refundAfterMs: legA.refundAfterMs });
    await h.buyerFlow.lockLegA();
    return { offerA, acceptA, statement };
  }

  it("lockLegA succeeds with a squat in place, the lock frame carries the payer-keyed ref, and the Seller claims exactly the Buyer's own lock", async () => {
    const h = harness();
    const { acceptA, statement } = await lockedFlowWithSquat(h);

    const lockFrames = framesIn(await h.venue.read(dealRoomOf(acceptA)), "lock");
    expect(lockFrames).toHaveLength(1);
    expect((tryDecodeFrame(lockFrames[0]!.line) as { ref: string }).ref).toBe(`${statement}:${BUYER_ACCOUNT}`);

    const result = await h.sellerFlow.claimLegA(statement);
    expect(result.receipt).toBeDefined();
    expect(h.node.getLockRow(statement.slice(2), BUYER_ACCOUNT)?.status).toBe("Claimed");
    // The squatter's own row is untouched: nobody but its payer (or a claim naming it) can move it.
    expect(h.node.getLockRow(statement.slice(2), SQUATTER)?.status).toBe("Locked");
    expect(h.node.getLockRow(statement.slice(2), SQUATTER)?.amount).toBe("1");

    // The Buyer still learns the secret from the chain.
    const secret = await h.buyerFlow.learnSecret();
    expect(`0x${Buffer.from(sha256(Uint8Array.from(Buffer.from(secret.slice(2), "hex")))).toString("hex")}`).toBe(statement);
  });

  it("refundLegA refunds exactly the Buyer's own lock; the squatter's row stays for its own payer to refund", async () => {
    const h = harness();
    const { offerA, acceptA, statement } = await lockedFlowWithSquat(h);

    h.clockRef.ms = offerA.refundAfterMs;
    h.node.nowMs = h.clockRef.ms;
    const refund = await h.buyerFlow.refundLegA();
    expect(refund.ref).toBe(`${statement}:${BUYER_ACCOUNT}`);
    expect(h.node.getLockRow(statement.slice(2), BUYER_ACCOUNT)?.status).toBe("Refunded");
    expect(h.node.getLockRow(statement.slice(2), SQUATTER)?.status).toBe("Locked");
    expect(framesIn(await h.venue.read(dealRoomOf(acceptA)), "refund")).toHaveLength(1);
  });
});

// ── G1/G3: a payout that fails after revealing the preimage, then a successful revealed retry ──

describe("G1/G3 — NearPayoutFailedError posts a reveal but no receipt, then a revealed retry succeeds past the deadlines", () => {
  it("claimLegA throws NearPayoutFailedError, posts the reveal frame only; a later retry (past refundAfterMs) skips the guards and succeeds", async () => {
    const h = harness();
    const { offerA, acceptA, statement } = await lockedFlow(h);
    const dealRoomA = dealRoomOf(acceptA);

    // H1's own S1 race: the payee (Seller) IS storage-registered when the adapter's own
    // preimage-free pre-check reads it, but becomes unregistered by the time the on-chain payout
    // promise actually runs — read #1 is verifyLockFinal's own storage_balance_of (inside
    // claimLegA's normal-path deadline guard), read #2 is near-htlc.ts claim()'s own pre-check.
    h.node.armPayoutFailureAfterReads(SELLER_ACCOUNT, 2);

    const before = (await h.venue.read(dealRoomA)).length;
    let thrown: unknown;
    try {
      await h.sellerFlow.claimLegA(statement);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("NearPayoutFailedError");

    const afterFirst = await h.venue.read(dealRoomA);
    // G1: the reveal frame IS posted (the secret is now public on chain regardless)...
    expect(framesIn(afterFirst, "reveal")).toHaveLength(1);
    const revealFrame = tryDecodeFrame(framesIn(afterFirst, "reveal")[0]!.line) as { secret: string };
    expect(revealFrame.secret).toBeTruthy();
    // ...but no receipt — this flow does not know the payout landed.
    expect(framesIn(afterFirst, "receipt")).toHaveLength(0);
    expect(afterFirst.length).toBe(before + 1);

    // The lock is genuinely still Locked on chain, with the preimage revealed (F4) — confirms
    // the mock modelled the contract's own rule, not merely "the client threw".
    const hashLockHex = statement.slice(2);
    const row = h.node.getLockRow(hashLockHex);
    expect(row?.status).toBe("Locked");
    expect(row?.preimage).toBe(revealFrame.secret.slice(2));

    // G3: advance the clock well PAST refundAfterMs — an ordinary (non-revealed) claim would be
    // refused outright by both this flow's own guards and the adapter's H3 landing-margin check.
    h.clockRef.ms = offerA.refundAfterMs + 60 * 60_000;
    h.node.nowMs = h.clockRef.ms;
    // Re-register the Seller for real this time — the storage-registration check is NEVER
    // skipped, even on a revealed retry (H2's own doc).
    h.node.registerStorage(SELLER_ACCOUNT);

    const result = await h.sellerFlow.claimLegA(statement);
    expect(result.receipt).toBeDefined();
    const afterRetry = await h.venue.read(dealRoomA);
    expect(framesIn(afterRetry, "receipt")).toHaveLength(1);
    // G6: the reveal was already posted by the first call; the retry must not post a second one.
    expect(framesIn(afterRetry, "reveal")).toHaveLength(1);
    expect(h.node.getLockRow(hashLockHex)?.status).toBe("Claimed");
  });
});

// ── G6: the reveal must land before refundAfterMs ───────────────────────────────────────────

/** Make `h.venue.post` throw for the next `count` reveal frames (all other posts pass through). */
function failRevealPosts(h: { venue: { post: (...a: never[]) => Promise<unknown> } }, count: number): { failed: () => number } {
  const venue = h.venue as unknown as { post: (room: string, line: string, id: unknown) => Promise<unknown> };
  const original = venue.post.bind(venue);
  let failed = 0;
  venue.post = async (room, line, id) => {
    const frame = tryDecodeFrame(line) as { type?: string } | null;
    if (frame?.type === "reveal" && failed < count) {
      failed++;
      throw new Error("venue unreachable (test)");
    }
    return original(room, line, id);
  };
  return { failed: () => failed };
}

describe("G6 - the reveal must land before refundAfterMs", () => {
  it("a payout failure whose reveal post keeps failing throws RevealNotPostedError (not the bare payout error) and posts nothing", async () => {
    const h = harness();
    const { acceptA, statement } = await lockedFlow(h);
    h.node.armPayoutFailureAfterReads(SELLER_ACCOUNT, 2);
    const fails = failRevealPosts(h as never, 99);

    let thrown: unknown;
    try {
      await h.sellerFlow.claimLegA(statement);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe("RevealNotPostedError");
    expect((thrown as Error).message).toMatch(/reveal must land before refundAfterMs/);
    expect((thrown as Error).message).toMatch(/payout failed/);
    expect(fails.failed()).toBe(3); // bounded retries
    expect(framesIn(await h.venue.read(dealRoomOf(acceptA)), "reveal")).toHaveLength(0);
  });

  it("a payout failure whose reveal post fails twice is retried and lands; the payout error still surfaces", async () => {
    const h = harness();
    const { acceptA, statement } = await lockedFlow(h);
    h.node.armPayoutFailureAfterReads(SELLER_ACCOUNT, 2);
    failRevealPosts(h as never, 2);

    let thrown: unknown;
    try {
      await h.sellerFlow.claimLegA(statement);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe("NearPayoutFailedError");
    expect(framesIn(await h.venue.read(dealRoomOf(acceptA)), "reveal")).toHaveLength(1);
  });

  it("a claim that landed but whose reveal post failed: the G2 retry posts the missing reveal and receipt exactly once, and a third call posts nothing", async () => {
    const h = harness();
    const { acceptA, statement } = await lockedFlow(h);
    failRevealPosts(h as never, 3);

    await expect(h.sellerFlow.claimLegA(statement)).rejects.toMatchObject({ name: "RevealNotPostedError" });
    expect(h.node.claimSendTxCalls).toBe(1);
    const room = dealRoomOf(acceptA);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(0);
    expect(framesIn(await h.venue.read(room), "receipt")).toHaveLength(0);

    const second = await h.sellerFlow.claimLegA(statement);
    expect(second.reveal).toBeDefined();
    expect(h.node.claimSendTxCalls).toBe(1); // no second claim transaction
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(1);
    expect(framesIn(await h.venue.read(room), "receipt")).toHaveLength(1);

    const length = (await h.venue.read(room)).length;
    await h.sellerFlow.claimLegA(statement);
    expect((await h.venue.read(room)).length).toBe(length); // latched: nothing re-posted
  });
});

// ── G1: a top-level chain failure posts nothing at all ──────────────────────────────────────

describe("G1 — NearTxFailedError posts nothing", () => {
  it("claimLegA throws NearTxFailedError and posts neither a reveal nor a receipt", async () => {
    const h = harness();
    const { acceptA, statement } = await lockedFlow(h);
    const dealRoomA = dealRoomOf(acceptA);
    h.node.forceNextClaimTxFailure = true;

    const before = (await h.venue.read(dealRoomA)).length;
    let thrown: unknown;
    try {
      await h.sellerFlow.claimLegA(statement);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("NearTxFailedError");
    const after = await h.venue.read(dealRoomA);
    expect(after.length).toBe(before); // nothing posted at all
  });
});

// ── G2 (claim half): a retry after the chain already agrees the claim landed ────────────────

describe("G2 — a retry after an already-successful claim recognises success from the chain and sends nothing", () => {
  it("a second claimLegA call posts nothing new (latched) and never re-signs/re-sends a claim transaction", async () => {
    const h = harness();
    const { acceptA, statement } = await lockedFlow(h);
    const dealRoomA = dealRoomOf(acceptA);

    const first = await h.sellerFlow.claimLegA(statement);
    expect(first.receipt).toBeDefined();
    expect(h.node.claimSendTxCalls).toBe(1);

    const before = (await h.venue.read(dealRoomA)).length;
    const second = await h.sellerFlow.claimLegA(statement);
    expect(second.receipt).toBeDefined();
    // G2: recognised success from the chain (findClaimedPreimage + verifyLockFinal) — the
    // adapter's own claim() is never called a second time.
    expect(h.node.claimSendTxCalls).toBe(1);
    const after = await h.venue.read(dealRoomA);
    // G6: the frames the first call posted are latched per flow instance, so nothing is doubled.
    expect(after.length).toBe(before);
    expect(framesIn(after, "reveal")).toHaveLength(1);
    expect(framesIn(after, "receipt")).toHaveLength(1);
  });
});

// ── G2 (refund half): a retry after a lost reply from an already-successful refund ──────────

describe("G2 — a refund retry after a lost reply recognises success from the chain rather than surfacing the write's own refusal", () => {
  it("refundLegA's own write appears to fail (lost reply) even though it genuinely landed; a retry reports success without re-broadcasting", async () => {
    const h = harness();
    const { offerA, acceptA } = await lockedFlow(h);
    const dealRoomA = dealRoomOf(acceptA);
    h.clockRef.ms = offerA.refundAfterMs;
    h.node.nowMs = h.clockRef.ms;

    // The refund transaction genuinely executes on the mock node (the lock really does move to
    // Refunded), but `connected.refund()`'s own call never gets to see the response — models a
    // dropped network reply after the write already committed. Buyer.refundLegA's own G2 catch
    // recovers within this SAME call (a fresh `verifyLockFinal` read confirms success) rather
    // than needing an external retry — a stronger outcome than "throws once, then a separate
    // retry succeeds": the caller here never even sees the failure.
    h.node.dropNextSendTxReply = true;

    const before = (await h.venue.read(dealRoomA)).length;
    const evidence = await h.buyerFlow.refundLegA();
    expect(evidence.ref).toBeTruthy();
    // The write was attempted exactly once — the recovered evidence is never a second broadcast.
    expect(h.node.refundSendTxCalls).toBe(1);
    const after = await h.venue.read(dealRoomA);
    expect(framesIn(after, "refund")).toHaveLength(1);
    expect(framesIn(after, "receipt").filter((r) => (tryDecodeFrame(r.line) as { outcome?: string }).outcome === "refunded")).toHaveLength(1);
    expect(after.length).toBeGreaterThan(before);

    // A genuine retry (a second call, e.g. a runner that calls this defensively) still never
    // re-broadcasts, and reports the same outcome idempotently.
    const evidenceAgain = await h.buyerFlow.refundLegA();
    expect(evidenceAgain.ref).toBe(evidence.ref);
    expect(h.node.refundSendTxCalls).toBe(1);
  });
});

// ── G4: reconcileLockA reports "locked, unverified" when the strict evidence pipeline can't ──

describe("G4 — reconcileLockA falls back to a permissive existence check when verifyLockFinal withholds `rail`", () => {
  it("reports { locked: true, verified: false } and still announces the lock when the payee is not storage-registered", async () => {
    const h = harness();
    h.node.registerStorage(BUYER_ACCOUNT);
    // Deliberately never registers the Seller (payee) — near-evidence.ts's own Locked branch
    // then withholds `rail` entirely (D-N10: a locked verdict must also prove the payout can
    // land), even though the lock genuinely exists for this payer with matching terms.
    const legA = legADeadlines(6 * 60 * 60_000);
    const swapId = computeSwapId(h.buyer.did, "00000001");
    const offerA = await h.buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "1000000",
      asset: "USDC",
      claimByMs: legA.claimByMs,
      refundAfterMs: legA.refundAfterMs,
      expiresMs: T0 + 10 * 60_000,
    });
    const { acceptARecord, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBDeadlines(), legA.lockTimeMs);
    const { acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    await h.sellerFlow.postAccountLineA(SELLER_ACCOUNT);
    await h.buyerFlow.postAccountLineA(BUYER_ACCOUNT);

    // Locking leg A itself needs no storage registration at all (only CLAIMING does — D-N10) —
    // this succeeds and announces the real lock frame normally.
    await expect(h.buyerFlow.lockLegA()).resolves.toBeDefined();

    // verifyLockFinal's own Locked branch withholds `rail` entirely because the payee (Seller)
    // is not storage-registered — a strict "unverified" read despite a lock that genuinely
    // exists on chain for this payer with matching terms.
    const reconciled = await h.buyerFlow.reconcileLockA();
    expect(reconciled.locked).toBe(true);
    expect(reconciled.verified).toBe(false);
    expect(reconciled.reason).toBeTruthy();
  });
});
