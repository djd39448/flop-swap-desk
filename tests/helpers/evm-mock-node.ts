// SPDX-License-Identifier: MIT
//
// A STATEFUL mock EVM JSON-RPC node for the hermetic P8 crash-resume tests (the EVM twin of tests/helpers/sol-stateful-chain.ts):
// only the wire is fake. The REAL EvmHtlcRail / viem clients talk to it and what they see is the chain's answer to what they
// actually sent. It models the EvmHashRail contract's own state machine (contracts/EvmHashRail.sol) for the four calls the
// flows make (ERC20 approve, lock, claim, refund), the `locks(hashLock)` view, the three events, receipts and block tags. It does
// NOT model gas, nonces, reorgs or any ERC20 balance: the contract's own state machine is what the resume paths depend on.
//
// A reorg is modelled only as far as the resume tests need it: `reorgLog` moves an event's log to another block number (R2-13).
//
// P9-4 decision 7 (a write whose receipt never comes): `holdNextSend(fn)` pools the next send of that kind WITHOUT mining it (the node accepted it and
// answered its hash, nothing else changed); `answerTxByHash` makes the node answer `eth_getTransactionByHash` (a pooled transaction has no block; a mined one
// has its block); `releaseHeld()` mines the pool, `failHeld()` mines it as reverted (a receipt with status 0, no effect), `dropHeld()` forgets it.
//
// P10 B6 (the claim's printed and saved hash): a node's answer to a RAW send (`eth_sendRawTransaction`) is keccak256 of the raw bytes, as a real node's is: the local-signing wire
// (tests/helpers/evm-local.ts) hands the node that hash (`rawHash`) and the node keys the transaction under it. `answerWrongHashForNextSend(fn)` makes the next send of that kind answer
// a DIFFERENT, well-formed hash (the node still keys the transaction under the true one): an endpoint whose answer cannot be trusted.
//
// Fault knobs, each firing once: `rejectNextSend(fn)` answers the send with a JSON-RPC error WITHOUT applying it (the transaction
// never happened); `loseNextSendReply(fn)` applies the effect and then answers with an error (the transaction landed, the reply was
// lost). `sends` records every send that was applied, so a test can count approvals and locks exactly.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, keccak256, numberToHex, type Address, type Hex } from "viem";

import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN, type EvmRailConfig } from "../../src/rails/evm-htlc.js";
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
  /** P9-4 decision 7: when true the node answers `eth_getTransactionByHash` (default false: the method is not served, as before). */
  answerTxByHash = false;
  /** P9-4 decision 7: sends accepted into the pool and not mined (see `holdNextSend`). */
  readonly held: Array<{ fn: SendKind; txHash: Hex; tx: { from: Address; to: Address; data: Hex } }> = [];
  private readonly holdNext = new Set<SendKind>();
  /** When true `eth_getLogs` answers nothing (an evidence lookup that finds no event although the transaction mined). */
  hideLogs = false;
  /** A public provider's cap (R1-13, P9-3): an `eth_getLogs` over more than this many blocks (`fromBlock` to `toBlock`, BOTH ends counted,
   *  `toBlock` "latest" meaning the tip) is refused with an error, as a range-capped RPC does (the strictest reading of "limited to a 500
   *  range": a 500-block call passes, a 501-block call is refused). `undefined` = no cap. */
  maxLogSpan: bigint | undefined;
  /** When true every `eth_getLogs` is refused with an error (a provider that is down for log queries). */
  refuseLogs = false;
  /** F7: the next this-many `eth_getLogs` calls answer an empty list whatever the filter (a load-balanced node that has not seen the block yet). */
  emptyLogQueries = 0;
  /** P9-4 decision 10: `eth_getLogs` hides every log whose block is within this many blocks of the tip (a node whose log index is that far behind its own head):
   *  with 1, a log in the tip block shows only once the chain has moved one block on (`advance`). 0 = no lag, the default. */
  logLagBlocks = 0;
  /** F7: after an `eth_getTransactionReceipt` is answered, the next this-many `eth_blockNumber` answers are one block BEHIND the chain (a tip read that a
   *  node lagging the one that answered the receipt gives). */
  lagTipReads = 0;
  private lagArmed = false;
  /** Every `fromBlock` an `eth_getLogs` was asked for, in order (a test reads where a scan started). */
  readonly logQueries: bigint[] = [];
  /** Every `eth_getLogs` range that was asked for, in order, refused ones included (`to` is the tip for a "latest" call, `latest` says so). */
  readonly logRanges: Array<{ from: bigint; to: bigint; latest: boolean }> = [];
  /** R2-FUND-01: how far the FINALIZED block's timestamp lags the chain's time, in ms (a finalized tag read answers `now - finalizedLagMs`); 0 = no lag,
   *  the default, so every other test sees the finalized block as current as the latest. */
  finalizedLagMs = 0;
  /** R2-FUND-01: every JSON-RPC method this node was asked, in order (a test counts the reads a step made, or that it made none). */
  readonly requests: string[] = [];
  /** The chain id `eth_chainId` answers (31337 anvil; 84532 makes `config()` a Base Sepolia pin with the code hash). */
  chainId = ANVIL_LOCAL_PIN.chainId;
  /** P9-2: the runtime code `eth_getCode` answers for the rail contract (any other address has none). A test sets another to play a different contract. */
  contractCode: Hex = "0x6080604052348015600e575f5ffd5b50600436106100565760003560e01c8063ab12cd3414610059575b5f5ffd5b610061610063565b005b565bfea164736f6c6343000818000a";
  /** Every address `eth_getCode` was asked about, in order. */
  readonly codeReads: string[] = [];
  /** P10 B5: when true, a `locks(hashLock)` read pinned to a block by HASH (the EIP-1898 `{ blockHash }` selector the evidence reader uses) answers a Claimed row as Locked, while a read at
   *  any other selector (a block tag or a block number) is untouched: one node of a load-balanced endpoint that has not seen the claim's block, answering the block-hash read. */
  hashReadsShowClaimedAsLocked = false;
  /** Fields merged into `config()` (a test sets `maxLogRange`, `receiptTimeoutMs`, or turns the code pin off with `contractCodeHash: undefined`). */
  configExtras: { [K in keyof EvmRailConfig]?: EvmRailConfig[K] | undefined } = {};
  /** See `SendHook`. */
  hook: SendHook | undefined;
  private readonly logs: StoredLog[] = [];
  private readonly receipts = new Map<string, { blockNumber: bigint; to: Address; from: Address; status?: "0x0" | "0x1" }>();
  private txCounter = 0;
  private readonly rejectNext = new Set<SendKind>();
  private readonly loseNext = new Set<SendKind>();
  private readonly wrongHashNext = new Set<SendKind>();

  constructor(
    /** The chain's time (block timestamps and the contract's `block.timestamp`), in ms. */
    private readonly nowMs: () => number,
    readonly railContract: Address,
    readonly token: Address,
    private readonly signers: readonly EvmSignerLike[],
  ) {}

  /** The rail config for this node: the anvil pin by default (no code pin), the Base Sepolia pin with the contract's code hash when `chainId` is 84532. */
  config(): EvmRailConfig {
    const base: EvmRailConfig =
      this.chainId === BASE_SEPOLIA_PIN.chainId
        ? { pin: BASE_SEPOLIA_PIN, endpoint: "http://mock-evm", contract: this.railContract, assets: { USDC: this.token }, contractCodeHash: keccak256(this.contractCode) }
        : { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: this.railContract, assets: { USDC: this.token } };
    const merged: Record<string, unknown> = { ...base, ...this.configExtras };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return merged as unknown as EvmRailConfig;
  }

  rejectNextSend(fn: SendKind): void {
    this.rejectNext.add(fn);
  }
  /** P9-4 decision 7: the next send of this kind is accepted into the pool (its hash is answered) and NOT mined: no row, no log, no receipt, no block. */
  holdNextSend(fn: SendKind): void {
    this.holdNext.add(fn);
  }
  /** P9-4 decision 7: mines every pooled send, in order, each under the hash its sender was given. */
  releaseHeld(): void {
    for (const entry of this.held.splice(0)) this.send(entry.tx, entry.txHash, true);
  }
  /** P9-4 decision 7: mines every pooled send as a REVERTED transaction (a block, a receipt with status 0, no effect on any lock). */
  failHeld(): void {
    for (const entry of this.held.splice(0)) {
      const blockNumber = this.mine();
      this.receipts.set(entry.txHash, { blockNumber, to: entry.tx.to, from: entry.tx.from, status: "0x0" });
    }
  }
  /** P9-4 decision 7: the node forgets every pooled send (dropped from its pool, never mined). */
  dropHeld(): void {
    this.held.length = 0;
  }
  loseNextSendReply(fn: SendKind): void {
    this.loseNext.add(fn);
  }
  /** P10 B6: the next send of this kind is applied (or pooled) as usual under its true hash, but the node ANSWERS another, well-formed lower-case hash (never the true one). */
  answerWrongHashForNextSend(fn: SendKind): void {
    this.wrongHashNext.add(fn);
  }

  /** R2-13: a reorg mined the transaction that emitted `event` for `hashLock` into another block, `blockNumber`, than the one it was first
   *  seen in: the log moves (what `eth_getLogs` filters on); nothing else about the chain changes. */
  reorgLog(event: keyof typeof EVENTS, hashLock: string, blockNumber: bigint): void {
    const log = this.logs.find((candidate) => candidate.event === event && candidate.hashLock.toLowerCase() === hashLock.toLowerCase());
    if (log === undefined) throw new Error(`mock evm node: no ${event} log for ${hashLock}`);
    log.blockNumber = blockNumber;
    log.raw.blockNumber = numberToHex(blockNumber);
    log.raw.blockHash = this.blockHash(blockNumber);
  }

  /** P9-4 decision 10: time passes on the chain: `blocks` empty blocks are mined (a lagging log index catches up). */
  advance(blocks = 1n): void {
    this.blockNumber += blocks;
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

  /** The next transaction hash: lower-case hex that carries LETTERS (a counter in the last four digits behind a fixed `c0ffee` filler), so a test that answers it in upper case
   *  (`localSigningRpc(...).upperCaseHashes`, P94-PIN-01) really changes the text. */
  private nextTxHash(): Hex {
    this.txCounter += 1;
    return `0x${"c0ffee".repeat(10)}${this.txCounter.toString(16).padStart(4, "0")}` as Hex;
  }

  private blockHash(number: bigint): Hex {
    return `0x${number.toString(16).padStart(64, "0")}` as Hex;
  }

  private mine(): bigint {
    this.blockNumber += 1n;
    return this.blockNumber;
  }

  private handle(method: string, params: readonly unknown[]): Envelope {
    this.requests.push(method);
    switch (method) {
      case "eth_chainId":
        return { result: `0x${this.chainId.toString(16)}` };
      case "eth_getCode": {
        const who = String(params[0]).toLowerCase();
        this.codeReads.push(who);
        return { result: who === this.railContract.toLowerCase() ? this.contractCode : "0x" };
      }
      case "eth_blockNumber":
        if (this.lagArmed && this.lagTipReads > 0) {
          this.lagTipReads -= 1;
          if (this.lagTipReads === 0) this.lagArmed = false;
          return { result: numberToHex(this.blockNumber - 1n) };
        }
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
        const seconds = Math.floor((this.nowMs() - (tag === "finalized" ? this.finalizedLagMs : 0)) / 1000) + (tag === "pending" ? 1 : 0);
        return { result: { number: numberToHex(number), hash: this.blockHash(number), timestamp: numberToHex(seconds) } };
      }
      case "eth_getTransactionReceipt": {
        // a node treats a hash as hex, whatever the case it is asked in (P94-PIN-01: a flow may ask with a hash a node answered in upper case)
        const receipt = this.receipts.get(String(params[0]).toLowerCase());
        if (receipt === undefined) return { result: null };
        if (this.lagTipReads > 0) this.lagArmed = true;
        return {
          result: {
            status: receipt.status ?? "0x1",
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
        const toIsHex = filter.toBlock !== undefined && filter.toBlock.startsWith("0x");
        const to = toIsHex ? BigInt(filter.toBlock as string) : this.blockNumber;
        this.logQueries.push(from);
        this.logRanges.push({ from, to, latest: !toIsHex });
        if (this.refuseLogs) return { error: { code: -32000, message: "mock evm node: eth_getLogs refused (test)" } };
        if (this.maxLogSpan !== undefined && to - from + 1n > this.maxLogSpan) {
          return { error: { code: -32602, message: `mock evm node: query exceeds the block range limit of ${this.maxLogSpan} (test)` } };
        }
        if (this.emptyLogQueries > 0) {
          this.emptyLogQueries -= 1;
          return { result: [] };
        }
        return { result: this.getLogs(filter) };
      }
      case "eth_call":
        return this.call(params[0] as { to?: string; data?: string }, params[1]);
      case "eth_getTransactionByHash": {
        if (!this.answerTxByHash) return { error: { code: -32601, message: `mock evm node: unexpected method ${method}` } };
        const hash = String(params[0]);
        const key = hash.toLowerCase();
        const pooled = this.held.find((entry) => entry.txHash === key);
        const base = { hash, nonce: "0x0", gas: "0x5208", value: "0x0", type: "0x2" };
        if (pooled !== undefined) return { result: { ...base, blockNumber: null, blockHash: null, transactionIndex: null, from: pooled.tx.from, to: pooled.tx.to, input: pooled.tx.data } };
        const mined = this.receipts.get(key);
        if (mined !== undefined) return { result: { ...base, blockNumber: numberToHex(mined.blockNumber), blockHash: this.blockHash(mined.blockNumber), transactionIndex: "0x0", from: mined.from, to: mined.to, input: "0x" } };
        return { result: null };
      }
      case "eth_sendTransaction":
        return this.send(params[0] as { from: Address; to: Address; data: Hex; rawHash?: Hex });
      default:
        return { error: { code: -32601, message: `mock evm node: unexpected method ${method}` } };
    }
  }

  private getLogs(filter: { topics?: Array<string | null>; fromBlock?: string; toBlock?: string }) {
    const from = filter.fromBlock !== undefined && filter.fromBlock.startsWith("0x") ? BigInt(filter.fromBlock) : 0n;
    const to = filter.toBlock !== undefined && filter.toBlock.startsWith("0x") ? BigInt(filter.toBlock) : undefined;
    const [topic0, topic1] = filter.topics ?? [];
    if (this.hideLogs) return [];
    return this.logs
      .filter((log) => log.blockNumber >= from && (to === undefined || log.blockNumber <= to))
      .filter((log) => log.blockNumber <= this.blockNumber - BigInt(this.logLagBlocks))
      .filter((log) => (log.raw.topics as string[])[0] === topic0)
      .filter((log) => topic1 === undefined || topic1 === null || (log.raw.topics as string[])[1] === topic1)
      .map((log) => log.raw);
  }

  private call(call: { to?: string; data?: string }, selector?: unknown): Envelope {
    if ((call.to ?? "").toLowerCase() === this.token.toLowerCase()) return { result: `0x${"0".repeat(63)}1` }; // any ERC20 call succeeds
    const decoded = decodeFunctionData({ abi: EVM_HASH_RAIL_ABI, data: call.data as Hex });
    if (decoded.functionName === "locks") {
      const row = this.rows.get(String(decoded.args[0]).toLowerCase());
      const r = row ?? { payer: ZERO_ADDRESS, payee: ZERO_ADDRESS, token: ZERO_ADDRESS, amount: 0n, claimByMs: 0n, refundAfterMs: 0n, status: 0 as const };
      const byBlockHash = typeof selector === "object" && selector !== null && "blockHash" in selector;
      const status = this.hashReadsShowClaimedAsLocked && byBlockHash && r.status === 2 ? 1 : r.status;
      return { result: encodeFunctionResult({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", result: [r.payer, r.payee, r.token, r.amount, r.claimByMs, r.refundAfterMs, status] }) };
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

  private send(tx: { from: Address; to: Address; data: Hex; rawHash?: Hex }, presetHash?: Hex, released = false): Envelope {
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
    if (!released && this.rejectNext.delete(fn)) return { error: { code: -32000, message: `mock evm node: ${fn} not accepted (test)` } };
    if (!released && this.holdNext.delete(fn)) {
      const pooledHash = tx.rawHash ?? this.nextTxHash();
      this.held.push({ fn, txHash: pooledHash, tx: { from, to: tx.to, data: tx.data } });
      return { result: this.wrongHashNext.delete(fn) ? this.nextTxHash() : pooledHash };
    }
    const hookToken = this.hook?.begin(fn, from);

    const txHash = presetHash ?? tx.rawHash ?? this.nextTxHash();
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
    return { result: this.wrongHashNext.delete(fn) ? this.nextTxHash() : txHash };
  }
}
