// SPDX-License-Identifier: MIT
//
// P9-6 (rule 4, "nothing public before Dave"): the pre-flight of the EVM rehearsal runner. It reads the chain a swap would run
// on and answers, row by row, whether the swap can go: the dry run (the runner's default) prints this table and sends nothing,
// and `--yes` runs the same checks first and refuses to broadcast unless every row that is needed holds. Every call here is a
// READ (`eth_chainId`, `eth_getCode`, `eth_getBlockByNumber`, `eth_call`, `eth_getLogs`, `eth_getBalance`, `eth_gasPrice`); no
// write method is ever named in this module, and the only network it speaks to is the configured endpoint.
//
// The rows (which of them a mode runs is in `PreflightInput.fresh`):
//   chain id       the node answers the pinned chain id
//   escrow code    the keccak of eth_getCode(contract) is the pinned `contractCodeHash` (P9-2); on an unpinned anvil config the
//                  observed hash is printed so a person can pin it
//   finalized      the `finalized` tag exists, and how far it lags the head in blocks and seconds (the Seller may claim only
//                  once the lock reads at that block)
//   finality budget  the lag plus the time a lock needs to land fits before leg A's claim-by
//   pending        the `pending` tag answers (the claim's last deadline guard reads it)
//   state at finalized  `locks(hashLock)` can be read at the finalized block by its hash (EIP-1898), which the evidence reader needs
//   log range      the endpoint's `eth_getLogs` cap against the config's `maxLogRange` (one probe of that many blocks must be
//                  accepted and one of one more refused, or what the endpoint does is reported)
//   clock          the local clock against the chain's head
//   buyer / seller the addresses (never a key), ETH against the gas the swap needs (generous per-call ceilings times twice the
//                  node's gas price), the Buyer's token balance and allowance against the amount
//   deadlines      SPEC 3.5 rules 1 to 3 and the claim margin, with the rail's own policy and the real numbers
//
// Output is addresses, amounts, hashes of public code and block numbers. It never contains a key, and the endpoint appears as its
// host only; any transport error text goes through the caller's `redact` first (a transport's own error names its URL).

import { encodeFunctionData, erc20Abi, formatEther, formatUnits, isAddressEqual, type Address, type Hex } from "viem";
import type { OfferFrame } from "@flop-labs/tclk";

import { checkSwapDeadlines } from "../deadlines.js";
import { EVM_HASH_RAIL_ABI } from "../vendor/evm-hash-rail.js";
import { describeCodeProblem, judgeRuntimeCode } from "../rails/evm-code-pin.js";
import { effectiveMaxLogRange } from "../rails/evm-htlc.js";
import type { CapturingRpc } from "../rails/rpc-capture.js";
import { endpointHost, type RehearsalConfig, type RunDeadlines } from "./rehearsal-config.js";
import type { RailLocalPolicy } from "./policy.js";

export type RowStatus = "ok" | "fail" | "warn" | "info";

export interface PreflightRow {
  check: string;
  status: RowStatus;
  detail: string;
}

export interface PreflightReport {
  rows: PreflightRow[];
  /** No row failed: everything the swap needs holds. */
  ok: boolean;
}

/**
 * Per-call gas CEILINGS the balance rows reserve, in gas units. Measured on anvil with the mock token (2026-10-06): approve 44,000, lock
 * 214,000, claim 65,000 (a refund was not measured: it writes one status and moves one token, like a claim, so it gets the claim's ceiling). The ceilings
 * are about 2.7x, 1.9x and 3x of those, so that a proxied
 * token such as Circle's USDC (an extra delegatecall and a blacklist read per transfer) still fits: a swap that fits them cannot be
 * stranded by gas. The Buyer needs the approve, the lock and, on the refund path, the refund; the Seller needs the claim.
 */
export const GAS_CEILING = Object.freeze({ approve: 120_000n, lock: 400_000n, claim: 200_000n, refund: 200_000n });

/** The gas price the balance rows reserve against is the node's `eth_gasPrice` times this (a price can rise during a swap). */
export const GAS_PRICE_CUSHION = 2n;

/** What a lock needs from the run's start to read final besides the chain's own lag: approve and lock transactions, their receipts and the first polls. */
export const LOCK_SETTLE_ALLOWANCE_MS = 10 * 60_000;

/** The largest gap between the local clock and a live chain's head the pre-flight accepts (a public chain's head is seconds old). */
export const CLOCK_SKEW_BOUND_MS = 60_000;

export interface PreflightInput {
  config: RehearsalConfig;
  /** The transport to the configured endpoint. */
  rpc: Pick<CapturingRpc, "request">;
  /** The two accounts' addresses, or the problem that kept one from loading (a key-file refusal's text names a path, never a key). */
  buyer: { address: Address } | { problem: string };
  seller: { address: Address } | { problem: string };
  /** The runner's clock reading now. */
  nowMs: number;
  /** A fresh run (dry run and `--yes`) also checks the swap's deadlines, the token balance and the finality budget; a resume or
   *  refund (false) checks only what the remaining steps read and spend. */
  fresh: boolean;
  /** The run's absolute deadlines and the lock time the rules are checked at (fresh only). */
  deadlines?: { absolute: RunDeadlines; lockTimeMs: number };
  /** The rail's own deadline policy (`CounterAssetRail.policy`). */
  policy: RailLocalPolicy;
  /** Removes the endpoint (and anything else that must not be printed) from a text. */
  redact: (text: string) => string;
  /** Rows whose failure does not stop THIS mode (a refund does not use the claim's `pending` read): a failed one is shown as a warning. */
  notNeeded?: ReadonlySet<string>;
}

interface Block {
  number: bigint;
  timestampMs: number;
  hash: Hex;
}

/** A hash no code has: `judgeRuntimeCode` against it reports the observed hash of whatever code is there. */
const NO_PIN = `0x${"00".repeat(32)}`;

const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const HEX_HASH = /^0x[0-9a-fA-F]{64}$/;

function parseBlock(value: unknown): Block | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.number !== "string" || !HEX_QUANTITY.test(v.number)) return null;
  if (typeof v.timestamp !== "string" || !HEX_QUANTITY.test(v.timestamp)) return null;
  if (typeof v.hash !== "string" || !HEX_HASH.test(v.hash)) return null;
  const seconds = BigInt(v.timestamp);
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER) / 1000n) return null;
  return { number: BigInt(v.number), timestampMs: Number(seconds) * 1000, hash: v.hash as Hex };
}

function quantity(value: unknown): bigint | null {
  return typeof value === "string" && HEX_QUANTITY.test(value) ? BigInt(value) : null;
}

/** An `eth_call` answer that is one ABI word (a uint256: 32 bytes, leading zeros kept), as a number. */
function word(value: unknown): bigint | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? BigInt(value) : null;
}

/**
 * The first line of an error's own short message, redacted and capped: never a stack, a cause chain or request arguments. K3 (P9 review round
 * 1): REDACT FIRST, then cut. Cutting first left the front part of an endpoint URL (an API key can sit in its path) that straddled the cut,
 * and the whole-URL redaction no longer matched it.
 */
export function describeFailure(error: unknown, redact: (text: string) => string): string {
  const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
  const text = typeof short === "string" ? short : error instanceof Error ? error.message : String(error);
  const redacted = redact(text.split("\n")[0] ?? "");
  return redacted.length > 300 ? `${redacted.slice(0, 297)}...` : redacted;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** Reads the chain and fills the table. Never throws: a read that fails is a row. Sends nothing. */
export async function runPreflight(input: PreflightInput): Promise<PreflightReport> {
  const { config, rpc, redact } = input;
  const evm = config.rails.evm;
  const rows: PreflightRow[] = [];
  const add = (check: string, status: RowStatus, detail: string): void => {
    rows.push({ check, status, detail });
  };
  const read = async (method: string, params: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> => {
    try {
      return { ok: true, value: await rpc.request({ method, params }) };
    } catch (error) {
      return { ok: false, why: describeFailure(error, redact) };
    }
  };
  const blockAt = async (tag: string): Promise<{ block: Block } | { why: string }> => {
    const answer = await read("eth_getBlockByNumber", [tag, false]);
    if (!answer.ok) return { why: answer.why };
    const block = parseBlock(answer.value);
    return block === null ? { why: `the node answered no usable "${tag}" block` } : { block };
  };

  // -- what the swap is --------------------------------------------------------------------------------------------------------
  add(
    "terms",
    "info",
    `${evm.pin.name} (chain ${evm.pin.chainId}), testnet only, no fee (feeBps 0), leg A ${config.amount} minimal units of ${config.asset}, leg B ${config.flopAmount} FLOP on the paper rail (no value)`,
  );
  const endpointUrl = new URL(evm.endpoint);
  const loopback = endpointUrl.hostname === "localhost" || endpointUrl.hostname === "127.0.0.1" || endpointUrl.hostname === "[::1]";
  if (endpointUrl.protocol === "http:" && !loopback) {
    add("endpoint", "warn", `host ${endpointHost(evm.endpoint)} over plain http: what the runner sends (a claim carries the swap's secret) can be read on the way; use an https endpoint`);
  } else {
    add("endpoint", "ok", `host ${endpointHost(evm.endpoint)}; the URL itself is never printed, and it carries no credentials, query or fragment`);
  }
  add("escrow", "info", `${evm.contract}; ${config.asset} token ${evm.assets[config.asset] ?? "?"}`);

  // -- the chain -------------------------------------------------------------------------------------------------------------------
  const chainIdAnswer = await read("eth_chainId", []);
  if (!chainIdAnswer.ok) add("chain id", "fail", `eth_chainId failed: ${chainIdAnswer.why}`);
  else {
    const live = quantity(chainIdAnswer.value);
    if (live === null) add("chain id", "fail", "eth_chainId did not answer a number");
    else if (live !== BigInt(evm.pin.chainId)) add("chain id", "fail", `the node is chain ${live}, the pin says ${evm.pin.chainId} (${evm.pin.name})`);
    else add("chain id", "ok", `${live} matches the pin ${evm.pin.name}`);
  }

  const codeAnswer = await read("eth_getCode", [evm.contract, "latest"]);
  if (!codeAnswer.ok) add("escrow code", "fail", `eth_getCode failed: ${codeAnswer.why}`);
  else if (evm.contractCodeHash === undefined) {
    // An anvil config may leave the escrow unpinned; the observed hash is printed so a person can pin it. (No real code hashes to zeros.)
    const verdict = judgeRuntimeCode(codeAnswer.value, NO_PIN);
    if (!verdict.ok && verdict.problem === "mismatch") {
      add("escrow code", "info", `not pinned (an anvil config may omit contractCodeHash): ${verdict.bytes} bytes, keccak ${verdict.observed.toLowerCase()}`);
    } else {
      add("escrow code", "fail", verdict.ok ? "the escrow's code could not be judged" : describeCodeProblem(verdict, evm.contract, NO_PIN));
    }
  } else {
    const verdict = judgeRuntimeCode(codeAnswer.value, evm.contractCodeHash);
    if (verdict.ok) add("escrow code", "ok", `${verdict.bytes} bytes, keccak ${verdict.observed.toLowerCase()} is the pinned contractCodeHash`);
    else add("escrow code", "fail", describeCodeProblem(verdict, evm.contract, evm.contractCodeHash));
  }

  // -- finality ----------------------------------------------------------------------------------------------------------------
  const head = await blockAt("latest");
  let finalized: Block | undefined;
  let lagMs: number | undefined;
  if ("why" in head) {
    add("finalized", "fail", `cannot read the head: ${head.why}`);
  } else {
    const finality = evm.pin.finality;
    if (finality.mode === "tag") {
      const tagged = await blockAt(finality.tag);
      if ("block" in tagged) {
        finalized = tagged.block;
        lagMs = Math.max(0, head.block.timestampMs - tagged.block.timestampMs);
        add(
          "finalized",
          "ok",
          `block ${tagged.block.number}, ${head.block.number - tagged.block.number} blocks and ${seconds(lagMs)} (${minutes(lagMs)}) behind the head (block ${head.block.number})`,
        );
      } else if (finality.fallbackConfirmations !== undefined) {
        const number = head.block.number >= BigInt(finality.fallbackConfirmations) ? head.block.number - BigInt(finality.fallbackConfirmations) : 0n;
        const numbered = await blockAt(`0x${number.toString(16)}`);
        if ("block" in numbered) {
          finalized = numbered.block;
          lagMs = Math.max(0, head.block.timestampMs - numbered.block.timestampMs);
          add("finalized", "warn", `the node has no "${finality.tag}" tag (${tagged.why}); the config falls back to ${finality.fallbackConfirmations} confirmations: block ${number}, ${seconds(lagMs)} behind the head`);
        } else add("finalized", "fail", `no "${finality.tag}" tag (${tagged.why}) and the fallback block could not be read (${numbered.why})`);
      } else {
        add("finalized", "fail", `the node has no usable "${finality.tag}" tag (${tagged.why}) and the config names no fallbackConfirmations: no lock would ever read final, so the Seller could never claim`);
      }
    } else {
      const number = head.block.number >= BigInt(finality.confirmations) ? head.block.number - BigInt(finality.confirmations) : 0n;
      const numbered = await blockAt(`0x${number.toString(16)}`);
      if ("block" in numbered) {
        finalized = numbered.block;
        lagMs = Math.max(0, head.block.timestampMs - numbered.block.timestampMs);
        add("finalized", "ok", `${finality.confirmations} confirmations: block ${number}, ${seconds(lagMs)} behind the head`);
      } else add("finalized", "fail", `the block ${finality.confirmations} confirmations behind the head could not be read (${numbered.why})`);
    }
  }

  if (input.fresh && input.deadlines !== undefined) {
    const claimBy = input.deadlines.absolute.legA.claimByMs;
    if (lagMs === undefined) {
      add("finality budget", "fail", "the finalized lag is unknown, so it cannot be set against leg A's claim-by");
    } else {
      const needMs = lagMs + LOCK_SETTLE_ALLOWANCE_MS;
      const haveMs = claimBy - input.nowMs;
      if (needMs > haveMs) {
        add(
          "finality budget",
          "fail",
          `a lock would read final about ${minutes(needMs)} after the run starts (finalized lag ${minutes(lagMs)} plus ${minutes(LOCK_SETTLE_ALLOWANCE_MS)} to land it) but leg A's claim-by is in ${minutes(haveMs)}: the Seller could not claim in time`,
        );
      } else {
        add("finality budget", "ok", `a lock reads final about ${minutes(needMs)} after the run starts (lag ${minutes(lagMs)} plus ${minutes(LOCK_SETTLE_ALLOWANCE_MS)}); leg A's claim-by is in ${minutes(haveMs)}, ${minutes(haveMs - needMs)} to spare`);
      }
    }
  }

  // The pending block carries a timestamp and nothing else this build reads (a node may answer it with a null number and hash).
  const pendingAnswer = await read("eth_getBlockByNumber", ["pending", false]);
  const pendingTime = pendingAnswer.ok ? quantity((pendingAnswer.value as { timestamp?: unknown } | null)?.timestamp) : null;
  if (pendingTime !== null) add("pending", "ok", `the pending tag answers (time ${new Date(Number(pendingTime) * 1000).toISOString()})`);
  else add("pending", "fail", `the pending tag is unusable (${pendingAnswer.ok ? "the node answered no usable pending block" : pendingAnswer.why}); the claim's last deadline guard reads it`);

  if (finalized === undefined) {
    add("state at finalized", "fail", "there is no finalized block to read state at");
  } else {
    const data = encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [`0x${"00".repeat(32)}` as Hex] });
    const answer = await read("eth_call", [{ to: evm.contract, data }, { blockHash: finalized.hash }]);
    if (!answer.ok) add("state at finalized", "fail", `locks() at the finalized block by its hash failed (${answer.why}); the evidence reader needs exactly this read`);
    else if (typeof answer.value !== "string" || !/^0x[0-9a-fA-F]*$/.test(answer.value) || answer.value.length < 66) {
      add("state at finalized", "fail", "locks() at the finalized block answered something that is not an ABI-encoded row");
    } else add("state at finalized", "ok", `locks() reads at finalized block ${finalized.number} by its hash (EIP-1898)`);
  }

  // -- the log range cap -------------------------------------------------------------------------------------------------------
  const limit = effectiveMaxLogRange(evm);
  if ("why" in head) {
    add("log range", "fail", "the head is unknown, so the log range cannot be probed");
  } else {
    const tip = head.block.number;
    const logs = async (from: bigint): Promise<{ ok: true } | { ok: false; why: string }> => {
      const answer = await read("eth_getLogs", [{ address: evm.contract, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${tip.toString(16)}` }]);
      return answer.ok ? (Array.isArray(answer.value) ? { ok: true } : { ok: false, why: "the answer is not a list" }) : { ok: false, why: answer.why };
    };
    if (limit === undefined) {
      const whole = await logs(0n);
      if (whole.ok) add("log range", "ok", `no maxLogRange configured and the endpoint accepted a scan of blocks 0 to ${tip} in one call`);
      else add("log range", "warn", `no maxLogRange configured and the endpoint refused a scan of blocks 0 to ${tip} (${whole.why}); set maxLogRange to the endpoint's cap`);
    } else if (tip < BigInt(limit)) {
      add("log range", "info", `maxLogRange ${limit}; the chain has only ${tip + 1n} blocks, too few to probe the cap`);
    } else {
      const within = await logs(tip - BigInt(limit) + 1n); // exactly `limit` blocks, both ends counted
      const over = await logs(tip - BigInt(limit)); // `limit + 1` blocks
      if (!within.ok) {
        add("log range", "fail", `the endpoint refused a scan of ${limit} blocks (${within.why}); maxLogRange ${limit} is too wide for it, so no log scan would work`);
      } else if (!over.ok) {
        add("log range", "ok", `maxLogRange ${limit}: the endpoint accepted ${limit} blocks and refused ${limit + 1} (${over.why})`);
      } else {
        add("log range", "warn", `maxLogRange ${limit}: the endpoint accepted ${limit} blocks and also ${limit + 1}; its cap is looser than the config's value (the scans are safe, with more calls than needed)`);
      }
    }
  }

  // -- the clock ---------------------------------------------------------------------------------------------------------------
  if ("block" in head) {
    const skew = input.nowMs - head.block.timestampMs;
    if (config.clock === "chain") {
      add("clock", "info", `the runner's clock follows the chain's head (anvil only); head time ${new Date(head.block.timestampMs).toISOString()}`);
    } else if (Math.abs(skew) > CLOCK_SKEW_BOUND_MS && evm.pin.chainId !== 31337) {
      add("clock", "fail", `the local clock and the chain's head differ by ${seconds(Math.abs(skew))} (${skew > 0 ? "the head is behind" : "the local clock is behind"}); a refund and a claim are judged against both, fix the machine's time first`);
    } else {
      add("clock", "ok", `the local clock and the chain's head differ by ${seconds(Math.abs(skew))}`);
    }
  } else {
    add("clock", "fail", "the head is unknown, so the clock cannot be compared with it");
  }

  // -- the accounts --------------------------------------------------------------------------------------------------------------
  const priceAnswer = await read("eth_gasPrice", []);
  const price = priceAnswer.ok ? quantity(priceAnswer.value) : null;
  if (price === null) add("gas price", "fail", priceAnswer.ok ? "eth_gasPrice did not answer a number" : `eth_gasPrice failed: ${priceAnswer.why}`);
  else add("gas price", "info", `${formatUnits(price, 9)} gwei, reserved at ${GAS_PRICE_CUSHION}x`);

  const buyerAddress = "address" in input.buyer ? input.buyer.address : undefined;
  const sellerAddress = "address" in input.seller ? input.seller.address : undefined;
  if ("problem" in input.buyer) add("buyer account", "fail", input.buyer.problem);
  if ("problem" in input.seller) add("seller account", "fail", input.seller.problem);
  if (buyerAddress !== undefined && sellerAddress !== undefined && isAddressEqual(buyerAddress, sellerAddress)) {
    add("accounts", "fail", "the Buyer and the Seller key files are the same account; a swap needs two");
  }

  const ethRow = async (label: string, address: Address, gas: bigint, what: string): Promise<void> => {
    const balanceAnswer = await read("eth_getBalance", [address, "latest"]);
    const balance = balanceAnswer.ok ? quantity(balanceAnswer.value) : null;
    if (balance === null) {
      add(label, "fail", `${address}: eth_getBalance ${balanceAnswer.ok ? "did not answer a number" : `failed: ${balanceAnswer.why}`}`);
      return;
    }
    if (price === null) {
      add(label, "fail", `${address}: ${formatEther(balance)} ETH, but the gas price is unknown so the need cannot be set against it`);
      return;
    }
    const need = gas * price * GAS_PRICE_CUSHION;
    if (balance < need) add(label, "fail", `${address}: ${formatEther(balance)} ETH, needs ${formatEther(need)} ETH for ${what} (${gas} gas ceiling): fund it first`);
    else add(label, "ok", `${address}: ${formatEther(balance)} ETH, needs ${formatEther(need)} ETH for ${what} (${gas} gas ceiling)`);
  };
  if (buyerAddress !== undefined) {
    await ethRow("buyer ETH", buyerAddress, GAS_CEILING.approve + GAS_CEILING.lock + GAS_CEILING.refund, "approve, lock and a refund");
  }
  if (sellerAddress !== undefined) await ethRow("seller ETH", sellerAddress, GAS_CEILING.claim, "the claim");

  if (input.fresh && buyerAddress !== undefined) {
    const token = evm.assets[config.asset];
    if (token === undefined) {
      add("buyer token", "fail", `asset ${config.asset} has no token address`);
    } else {
      const amount = BigInt(config.amount);
      const balanceAnswer = await read("eth_call", [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [buyerAddress] }) }, "latest"]);
      const balance = balanceAnswer.ok ? word(balanceAnswer.value) : null;
      const decimalsAnswer = await read("eth_call", [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) }, "latest"]);
      const decimals = decimalsAnswer.ok ? word(decimalsAnswer.value) : null;
      const shown = (units: bigint): string =>
        decimals !== null && decimals <= 36n ? `${formatUnits(units, Number(decimals))} ${config.asset} (${units} units)` : `${units} units of ${config.asset}`;
      if (balance === null) add("buyer token", "fail", `balanceOf on ${token} ${balanceAnswer.ok ? "did not answer a number" : `failed: ${balanceAnswer.why}`}`);
      else if (balance < amount) add("buyer token", "fail", `the Buyer holds ${shown(balance)}, the swap needs ${shown(amount)}: fund it first`);
      else add("buyer token", "ok", `the Buyer holds ${shown(balance)}, the swap needs ${shown(amount)}`);

      const allowanceAnswer = await read("eth_call", [
        { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [buyerAddress, evm.contract] }) },
        "latest",
      ]);
      const allowance = allowanceAnswer.ok ? word(allowanceAnswer.value) : null;
      if (allowance === null) add("buyer allowance", "fail", `allowance on ${token} ${allowanceAnswer.ok ? "did not answer a number" : `failed: ${allowanceAnswer.why}`}`);
      else add("buyer allowance", "info", `the escrow may spend ${shown(allowance)} of the Buyer's tokens now; the lock's own approve sets it to the amount`);
    }
  }

  // -- the deadlines ---------------------------------------------------------------------------------------------------------------
  if (input.fresh && input.deadlines !== undefined) {
    const { absolute, lockTimeMs } = input.deadlines;
    const asOffer = (leg: RunDeadlines["legA"]): OfferFrame => leg as unknown as OfferFrame; // checkSwapDeadlines reads only the three deadline fields
    const checked = checkSwapDeadlines(asOffer(absolute.legA), asOffer(absolute.legB), lockTimeMs, input.policy);
    const violations = [...checked.violations];
    const margin = input.policy.claimInclusionMarginMs;
    if (absolute.legA.refundAfterMs - absolute.legA.claimByMs < margin) {
      violations.push(`leg A: refundAfter - claimBy must be at least the claim-inclusion margin (${minutes(margin)}) or the Seller refuses to accept`);
    }
    if (violations.length > 0) add("deadlines", "fail", violations.join("; "));
    else {
      const at = (ms: number): string => new Date(ms).toISOString();
      add(
        "deadlines",
        "ok",
        `SPEC 3.5 rules 1 to 3 and the claim margin hold at a lock ${minutes(lockTimeMs - input.nowMs)} after the start; leg A claim-by ${at(absolute.legA.claimByMs)}, refundable from ${at(absolute.legA.refundAfterMs)}; leg B claim-by ${at(absolute.legB.claimByMs)}, refundable from ${at(absolute.legB.refundAfterMs)}`,
      );
    }
  }

  const shown = rows.map((row): PreflightRow =>
    row.status === "fail" && input.notNeeded?.has(row.check) === true ? { check: row.check, status: "warn", detail: `(not needed for this mode) ${row.detail}` } : row,
  );
  return { rows: shown, ok: !shown.some((row) => row.status === "fail") };
}

/** The table as printable lines, with a one-line verdict at the end. */
export function renderPreflight(report: PreflightReport, title: string): string[] {
  const width = Math.max(...report.rows.map((row) => row.check.length), 10);
  const label: Record<RowStatus, string> = { ok: "OK  ", fail: "FAIL", warn: "WARN", info: "    " };
  const lines = [title];
  for (const row of report.rows) lines.push(`  ${label[row.status]}  ${row.check.padEnd(width)}  ${row.detail}`);
  const count = (status: RowStatus): number => report.rows.filter((row) => row.status === status).length;
  lines.push(
    report.ok
      ? `RESULT: every check that is needed holds (${count("ok")} ok, ${count("warn")} warnings).`
      : `RESULT: ${count("fail")} check(s) failed (${count("ok")} ok, ${count("warn")} warnings): the swap cannot start.`,
  );
  return lines;
}
