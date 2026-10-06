// SPDX-License-Identifier: MIT
//
// A STATEFUL mock EVM JSON-RPC node for the hermetic P8 crash-resume tests (the EVM twin of tests/helpers/sol-stateful-chain.ts):
// only the wire is fake. The REAL EvmHtlcRail / viem clients talk to it and what they see is the chain's answer to what they
// actually sent. It models the EvmHashRail contract's own state machine (contracts/EvmHashRail.sol) for the four calls the
// flows make (ERC20 approve, lock, claim, refund), the `locks(hashLock)` view, the three events, receipts and block tags. It does
// NOT model gas, nonces, reorgs or any ERC20 balance: the contract's own state machine is what the resume paths depend on.
//
// Fault knobs, each firing once: `rejectNextSend(fn)` answers the send with a JSON-RPC error WITHOUT applying it (the transaction
// never happened); `loseNextSendReply(fn)` applies the effect and then answers with an error (the transaction landed, the reply was
// lost). `sends` records every send that was applied, so a test can count approvals and locks exactly.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, numberToHex, type Address, type Hex } from "viem";

import { ANVIL_LOCAL_PIN, type EvmRailConfig } from "../../src/rails/evm-htlc.js";
import { CapturingRpc } from "../../src/rails/rpc-capture.js";
import { EVM_HASH_RAIL_ABI } from "../../src/vendor/evm-hash-rail.js";

const LOCKED_EVENT = {
  type: "event",
  name: "Locked",
  inputs: [
    { name: "hashLock", type: "bytes32", indexed: true },
    { name: "payer", type: "address", indexed: true },
    { name: "payee", type: "address", indexed: true },
    { name: "token", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "claimByMs", type: "uint256", indexed: false },
    { name: "refundAfterMs", type: "uint256", indexed: false },
  ],
} as const;
const CLAIMED_EVENT = {
  type: "event",
  name: "Claimed",
  inputs: [
    { name: "hashLock", type: "bytes32", indexed: true },
    { name: "preimage", type: "bytes32", indexed: false },
  ],
} as const;
const REFUNDED_EVENT = { type: "event", name: "Refunded", inputs: [{ name: "hashLock", type: "bytes32", indexed: true }] } as const;
const EVENTS = { Locked: LOCKED_EVENT, Claimed: CLAIMED_EVENT, Refunded: REFUNDED_EVENT } as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const APPROVE_SELECTOR = "0x095ea7b3";

export type SendKind = "approve" | "lock" | "claim" | "refund";

export interface EvmRow {
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  claimByMs: bigint;
  refundAfterMs: bigint;
  status: 0 | 1 | 2 | 3;
}

interface StoredLog {
  event: keyof typeof EVENTS;
  hashLock: Hex;
  blockNumber: bigint;
  txHash: Hex;
  raw: Record<string, unknown>;
}

export interface AppliedSend {
  fn: SendKind;
  from: Address;
  hashLock?: Hex;
}

/** P8 matrix: a seam around every send the node applies. `begin` runs before the effect (it may throw: the process died right
 *  before the send) and `end` right after it (the effect happened). A send the node refuses with an error reaches neither. */
export interface SendHook {
  begin(fn: SendKind, from: Address): unknown;
  end(token: unknown): void;
}

export interface EvmSignerLike {
  address: Address;
  signPersonal(message: string): string;
}

type Envelope = { result?: unknown; error?: { code: number; message: string } };

export class EvmMockNode {
  readonly rows = new Map<string, EvmRow>();
  readonly sends: AppliedSend[] = [];
  blockNumber = 5n;
  /** When true `eth_getLogs` answers nothing (an evidence lookup that finds no event although the transaction mined). */
  hideLogs = false;
  /** A public provider's cap (R1-13): `eth_getLogs` over more than this many blocks (from `fromBlock` to the latest block) is refused with
   *  an error, as a range-capped RPC does. `undefined` = no cap. */
  maxLogSpan: bigint | undefined;
  /** When true every `eth_getLogs` is refused with an error (a provider that is down for log queries). */
  refuseLogs = false;
  /** Every `fromBlock` an `eth_getLogs` was asked for, in order (a test reads where a scan started). */
  readonly logQueries: bigint[] = [];
  /** See `SendHook`. */
  hook: SendHook | undefined;
  private readonly logs: StoredLog[] = [];
  private readonly receipts = new Map<string, { blockNumber: bigint; to: Address; from: Address }>();
  private txCounter = 0;
  private readonly rejectNext = new Set<SendKind>();
  private readonly loseNext = new Set<SendKind>();

  constructor(
    /** The chain's time (block timestamps and the contract's `block.timestamp`), in ms. */
    private readonly nowMs: () => number,
    readonly railContract: Address,
    readonly token: Address,
    private readonly signers: readonly EvmSignerLike[],
  ) {}

  config(): EvmRailConfig {
    return { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: this.railContract, assets: { USDC: this.token } };
  }

  rejectNextSend(fn: SendKind): void {
    this.rejectNext.add(fn);
  }
  loseNextSendReply(fn: SendKind): void {
    this.loseNext.add(fn);
  }

  count(fn: SendKind): number {
    return this.sends.filter((send) => send.fn === fn).length;
  }
  row(hashLock: string): EvmRow | undefined {
    return this.rows.get(hashLock.toLowerCase());
  }

  /** A new transport over this node's shared state (one per party, like a per-party `CapturingRpc`). */
  rpc(): CapturingRpc {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
      const response = this.handle(body.method, body.params);
      const envelope = response.error !== undefined ? { jsonrpc: "2.0", id: body.id, error: response.error } : { jsonrpc: "2.0", id: body.id, result: response.result };
      const text = JSON.stringify(envelope);
      const bytes = new TextEncoder().encode(text);
      return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
    }) as typeof fetch;
    return new CapturingRpc({ endpoint: "http://mock-evm", fetch: fetchImpl });
  }

  private blockHash(number: bigint): Hex {
    return `0x${number.toString(16).padStart(64, "0")}` as Hex;
  }

  private mine(): bigint {
    this.blockNumber += 1n;
    return this.blockNumber;
  }

  private handle(method: string, params: readonly unknown[]): Envelope {
    switch (method) {
      case "eth_chainId":
        return { result: `0x${ANVIL_LOCAL_PIN.chainId.toString(16)}` };
      case "eth_blockNumber":
        return { result: numberToHex(this.blockNumber) };
      case "personal_sign": {
        const account = String(params[1]).toLowerCase();
        const signer = this.signers.find((candidate) => candidate.address.toLowerCase() === account);
        if (signer === undefined) return { error: { code: -32000, message: "unknown account" } };
        const message = Buffer.from(String(params[0]).slice(2), "hex").toString("utf8");
        return { result: `0x${signer.signPersonal(message)}` };
      }
      case "eth_getBlockByNumber": {
        const tag = params[0];
        const number = this.blockNumber;
        const seconds = Math.floor(this.nowMs() / 1000) + (tag === "pending" ? 1 : 0);
        return { result: { number: numberToHex(number), hash: this.blockHash(number), timestamp: numberToHex(seconds) } };
      }
      case "eth_getTransactionReceipt": {
        const receipt = this.receipts.get(String(params[0]));
        if (receipt === undefined) return { result: null };
        return {
          result: {
            status: "0x1",
            transactionHash: params[0],
            blockHash: this.blockHash(receipt.blockNumber),
            blockNumber: numberToHex(receipt.blockNumber),
            transactionIndex: "0x0",
            from: receipt.from,
            to: receipt.to,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            type: "0x2",
          },
        };
      }
      case "eth_getLogs": {
        const filter = params[0] as { topics?: Array<string | null>; fromBlock?: string; toBlock?: string };
        const from = filter.fromBlock !== undefined && filter.fromBlock.startsWith("0x") ? BigInt(filter.fromBlock) : 0n;
        this.logQueries.push(from);
        if (this.refuseLogs) return { error: { code: -32000, message: "mock evm node: eth_getLogs refused (test)" } };
        if (this.maxLogSpan !== undefined && this.blockNumber - from > this.maxLogSpan) {
          return { error: { code: -32602, message: `mock evm node: query exceeds the block range limit of ${this.maxLogSpan} (test)` } };
        }
        return { result: this.getLogs(filter) };
      }
      case "eth_call":
        return this.call(params[0] as { to?: string; data?: string });
      case "eth_sendTransaction":
        return this.send(params[0] as { from: Address; to: Address; data: Hex });
      default:
        return { error: { code: -32601, message: `mock evm node: unexpected method ${method}` } };
    }
  }

  private getLogs(filter: { topics?: Array<string | null>; fromBlock?: string; toBlock?: string }) {
    const from = filter.fromBlock !== undefined && filter.fromBlock.startsWith("0x") ? BigInt(filter.fromBlock) : 0n;
    const [topic0, topic1] = filter.topics ?? [];
    if (this.hideLogs) return [];
    return this.logs
      .filter((log) => log.blockNumber >= from)
      .filter((log) => (log.raw.topics as string[])[0] === topic0)
      .filter((log) => topic1 === undefined || topic1 === null || (log.raw.topics as string[])[1] === topic1)
      .map((log) => log.raw);
  }

  private call(call: { to?: string; data?: string }): Envelope {
    if ((call.to ?? "").toLowerCase() === this.token.toLowerCase()) return { result: `0x${"0".repeat(63)}1` }; // any ERC20 call succeeds
    const decoded = decodeFunctionData({ abi: EVM_HASH_RAIL_ABI, data: call.data as Hex });
    if (decoded.functionName === "locks") {
      const row = this.rows.get(String(decoded.args[0]).toLowerCase());
      const r = row ?? { payer: ZERO_ADDRESS, payee: ZERO_ADDRESS, token: ZERO_ADDRESS, amount: 0n, claimByMs: 0n, refundAfterMs: 0n, status: 0 as const };
      return { result: encodeFunctionResult({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", result: [r.payer, r.payee, r.token, r.amount, r.claimByMs, r.refundAfterMs, r.status] }) };
    }
    if (decoded.functionName === "claim") {
      // the zero-preimage pre-check: it can only revert with "does not open the statement" when the lock is open and in window
      const [hashLock, preimage] = decoded.args;
      const row = this.rows.get(String(hashLock).toLowerCase());
      if (row === undefined || row.status !== 1) return { error: { code: 3, message: "execution reverted: EvmHashRail: not locked" } };
      if (BigInt(this.nowMs() + 1000) >= row.refundAfterMs) return { error: { code: 3, message: "execution reverted: EvmHashRail: too late" } };
      if (!this.opens(hashLock, preimage)) return { error: { code: 3, message: "execution reverted: EvmHashRail: secret does not open the statement" } };
      return { result: "0x" };
    }
    return { error: { code: -32000, message: `mock evm node: unexpected eth_call ${decoded.functionName}` } };
  }

  private opens(hashLock: Hex, preimage: Hex): boolean {
    return `0x${bytesToHex(sha256(hexToBytes(preimage.slice(2))))}` === hashLock.toLowerCase();
  }

  private pushLog(event: keyof typeof EVENTS, hashLock: Hex, args: Record<string, unknown>, blockNumber: bigint, txHash: Hex): void {
    const abi = EVENTS[event];
    const topics = encodeEventTopics({ abi: [abi], eventName: event, args } as never);
    const nonIndexed = abi.inputs.filter((input) => !input.indexed);
    const data = nonIndexed.length === 0 ? ("0x" as Hex) : encodeAbiParameters(nonIndexed as readonly { name: string; type: string }[], nonIndexed.map((input) => args[input.name]));
    this.logs.push({
      event,
      hashLock,
      blockNumber,
      txHash,
      raw: {
        address: this.railContract,
        topics,
        data,
        blockNumber: numberToHex(blockNumber),
        blockHash: this.blockHash(blockNumber),
        transactionHash: txHash,
        transactionIndex: "0x0",
        logIndex: numberToHex(this.logs.length),
        removed: false,
      },
    });
  }

  private send(tx: { from: Address; to: Address; data: Hex }): Envelope {
    const from = getAddress(tx.from);
    const isToken = tx.to.toLowerCase() === this.token.toLowerCase();
    let fn: SendKind;
    let decoded: ReturnType<typeof decodeFunctionData<typeof EVM_HASH_RAIL_ABI>> | undefined;
    if (isToken) {
      if (!tx.data.startsWith(APPROVE_SELECTOR)) return { error: { code: -32000, message: "mock evm node: only approve is modelled on the token" } };
      fn = "approve";
    } else {
      decoded = decodeFunctionData({ abi: EVM_HASH_RAIL_ABI, data: tx.data });
      fn = decoded.functionName as SendKind;
    }
    if (this.rejectNext.delete(fn)) return { error: { code: -32000, message: `mock evm node: ${fn} not accepted (test)` } };
    const hookToken = this.hook?.begin(fn, from);

    const txHash = `0x${(++this.txCounter).toString(16).padStart(64, "0")}` as Hex;
    const blockNumber = this.mine();
    const now = BigInt(this.nowMs());
    let hashLock: Hex | undefined;
    if (decoded !== undefined && decoded.functionName === "lock") {
      const [lock, payee, amount, token, claimByMs, refundAfterMs] = decoded.args;
      hashLock = lock;
      if (this.rows.has(lock.toLowerCase())) return { error: { code: 3, message: "execution reverted: EvmHashRail: lock exists" } };
      this.rows.set(lock.toLowerCase(), { payer: from, payee, token, amount, claimByMs, refundAfterMs, status: 1 });
      this.pushLog("Locked", lock, { hashLock: lock, payer: from, payee, token, amount, claimByMs, refundAfterMs }, blockNumber, txHash);
    } else if (decoded !== undefined && decoded.functionName === "claim") {
      const [lock, preimage] = decoded.args;
      hashLock = lock;
      const row = this.rows.get(lock.toLowerCase());
      if (row === undefined || row.status !== 1 || now >= row.refundAfterMs || !this.opens(lock, preimage)) return { error: { code: 3, message: "execution reverted: EvmHashRail: claim refused" } };
      row.status = 2;
      this.pushLog("Claimed", lock, { hashLock: lock, preimage }, blockNumber, txHash);
    } else if (decoded !== undefined && decoded.functionName === "refund") {
      const [lock] = decoded.args;
      hashLock = lock;
      const row = this.rows.get(lock.toLowerCase());
      if (row === undefined || row.status !== 1 || now < row.refundAfterMs || row.payer.toLowerCase() !== from.toLowerCase()) return { error: { code: 3, message: "execution reverted: EvmHashRail: refund refused" } };
      row.status = 3;
      this.pushLog("Refunded", lock, { hashLock: lock }, blockNumber, txHash);
    }
    this.receipts.set(txHash, { blockNumber, to: tx.to, from });
    this.sends.push({ fn, from, ...(hashLock === undefined ? {} : { hashLock }) });
    this.hook?.end(hookToken);
    if (this.loseNext.delete(fn)) return { error: { code: -32000, message: `mock evm node: connection reset after ${fn} (test)` } };
    return { result: txHash };
  }
}
