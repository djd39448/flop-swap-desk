// SPDX-License-Identifier: MIT
//
// P9-6 (handoff/P9-G1-READINESS-SPEC.md rule 4, "nothing public before Dave"): the EVM rehearsal runner's modes. bin/swap-rehearsal-evm.mjs
// is a thin CLI over `runRehearsal`; everything that decides anything is here, typed and testable.
//
//   dry run (the default)  loads both key files (to print the two ADDRESSES), reads the chain, prints the pre-flight table
//                          (src/client/rehearsal-preflight.ts) and the plan, and sends nothing: no transaction, no venue
//                          post, no file written. Exit 0 only if every check that is needed holds.
//   --yes                  runs the same pre-flight, then the choreography tests-anvil/client-flows.anvil.test.ts runs: bid, accept,
//                          account lines, lock B on paper, lock A on chain, wait for the finalized read, claim, learn the secret,
//                          claim B; then the bundle and `examples/audit-export.mjs --expect <swapId>=settled`. Real waiting on the
//                          chain's clock. `--stop-after lock` ends after the lock (the Seller never claims: the first half of a refund rehearsal).
//   --resume               a fresh process continues the run from the state directory: the P8 flow records (both roles), the durable
//                          venue and paper notes (src/client/rehearsal-world.ts) and run.json. Each step reads what it needs from
//                          the records and the chain, so a kill at any instant costs nothing: there is never a second lock or claim.
//   --refund               drives the refund path after the deadlines: the Buyer refunds leg A once leg A's refund time has come
//                          (the local clock AND the chain's head must be past it), the Seller refunds leg B (the paper note) once
//                          its refund time has come, then the bundle and `--expect <swapId>=refunded` (or `refunded-b` when leg A
//                          was never locked). Without `--wait` a refund time not yet reached is reported (exit 5) and the run can be repeated.
//
// The only network the runner speaks to is `rails.evm.endpoint`. It posts to no HTTP venue and never opens any other socket;
// the venue and the paper notes are two local files. The one thing it launches is `examples/audit-export.mjs`, offline.
//
// Keys: the two EVM keys are loaded by `loadEvmLocalAccount` (src/client/evm-key-file.ts) and handed to the rails as sealed
// accounts; nothing here reads, stores, prints or inspects one, and nothing it prints can contain one (addresses, hashes, block
// numbers, error texts cut to their first line and stripped of the endpoint). The state directory holds the P8 records (the Seller's
// swap secret), two Ed25519 venue-signing seeds and the venue's files: secret-grade, never in a bundle.
//
// Exit codes: 0 done (or a clean dry run); 2 bad config, arguments or state; 3 pre-flight failed (nothing was sent); 4 a step refused
// (the first line of its reason is printed); 5 not yet (a refund time has not come; run again then); 6 the bundle was written
// but `audit-export` did not accept it.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { OFFER_ROOM, PaperRail, dealRoom, paperNote } from "@flop-labs/tclk";
import type { Address } from "viem";
import type { LocalAccount } from "viem/accounts";

import { swapId as computeSwapId } from "../profile.js";
import { CapturingRpc, type Exchange } from "../rails/rpc-capture.js";
import { writeBundle, type BundleEvidenceSummary } from "./bundle.js";
import { BuyerFlow, type BuyerNextStep } from "./buyer.js";
import type { CounterAssetRail, RailWriteEvidence } from "./counter-rail.js";
import { loadEvmLocalAccount } from "./evm-key-file.js";
import { createEvmCounterRail } from "./evm-rail.js";
import { FileFlowStore, flowKey, parseFlowKey } from "./flow-store.js";
import {
  absoluteDeadlines,
  loadRehearsalConfig,
  LOCK_ESTIMATE_MS,
  RehearsalConfigError,
  type RehearsalConfig,
  type RunDeadlines,
} from "./rehearsal-config.js";
import { describeFailure, renderPreflight, runPreflight, type PreflightReport, type PreflightRow } from "./rehearsal-preflight.js";
import { acquireRunLock, DurableNoteStore, DurableVenue, loadOrCreateIdentity, RehearsalWorldError, RunLockedError, writeFileDurable, type RehearsalIdentity } from "./rehearsal-world.js";
import { SellerFlow, type SellerNextStep } from "./seller.js";

const execFileAsync = promisify(execFile);

/** What the runner needs from its host: the machine clock, a sleep and two output lines. The CLI passes the real ones. */
export interface RehearsalEnv {
  /** The machine clock in ms (the CLI passes `Date.now`). */
  now(): number;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  err(line: string): void;
}

export type RehearsalMode = "dry" | "yes" | "resume" | "refund";

export interface RehearsalOptions {
  configPath: string;
  mode: RehearsalMode;
  /** The state directory (run.json, the two parties' flow records and seeds, the venue and note files). */
  stateDir: string;
  /** `--yes` only: stop after leg A is locked and recorded (the Seller never claims). */
  stopAfter?: "lock";
  /** `--refund` only: wait for a refund time that has not come instead of reporting it. */
  wait?: boolean;
  env: RehearsalEnv;
}

export const EXIT = Object.freeze({ ok: 0, config: 2, preflight: 3, refused: 4, notYet: 5, audit: 6 });

/** The statuses `examples/audit-export.mjs --expect` is asked for. */
type Outcome = "settled" | "refunded" | "refunded-b";

// --- run.json -------------------------------------------------------------------------------------------------------------------

/** The public parameters of one swap, written once when `--yes` starts. No key, seed or secret is in it. */
export interface RunRecord {
  v: 1;
  swapId: string;
  nonce: string;
  t0Ms: number;
  lockTimeMs: number;
  chainId: number;
  contract: string;
  asset: string;
  amount: string;
  flopAmount: string;
  deadlines: RunDeadlines;
  stopAfter: "lock" | null;
  buyerDid: string;
  sellerDid: string;
  /** The two EVM accounts (public addresses, lower case): a resume or a refund with key files that name other accounts is refused. */
  buyerAccount: string;
  sellerAccount: string;
}

const RUN_FIELDS = ["v", "swapId", "nonce", "t0Ms", "lockTimeMs", "chainId", "contract", "asset", "amount", "flopAmount", "deadlines", "stopAfter", "buyerDid", "sellerDid", "buyerAccount", "sellerAccount"];
const LEG_RUN_FIELDS = ["claimByMs", "refundAfterMs", "expiresMs"];

function isSafeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseRunLeg(value: unknown): RunDeadlines["legA"] | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== [...LEG_RUN_FIELDS].sort().join(",")) return null;
  if (!isSafeMs(v.claimByMs) || !isSafeMs(v.refundAfterMs) || !isSafeMs(v.expiresMs)) return null;
  return { claimByMs: v.claimByMs, refundAfterMs: v.refundAfterMs, expiresMs: v.expiresMs };
}

/** Parses run.json strictly (closed fields, exact types). Throws `RehearsalWorldError`; the file is never replaced by a default. */
export function parseRunRecord(text: string, path: string): RunRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RehearsalWorldError(`${path} is not valid JSON; it names the swap this state directory holds and is never replaced`);
  }
  const bad = (what: string): never => {
    throw new RehearsalWorldError(`${path} is not a run record this build reads (${what})`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad("not an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== [...RUN_FIELDS].sort().join(",")) return bad("its fields are not the known ones");
  if (v.v !== 1) return bad("version");
  if (typeof v.swapId !== "string" || !/^0x[0-9a-f]{64}$/.test(v.swapId)) return bad("swapId");
  if (typeof v.nonce !== "string" || !/^[0-9a-f]{8,64}$/.test(v.nonce)) return bad("nonce");
  if (!isSafeMs(v.t0Ms) || !isSafeMs(v.lockTimeMs)) return bad("times");
  if (typeof v.chainId !== "number" || !Number.isSafeInteger(v.chainId) || v.chainId <= 0) return bad("chainId");
  if (typeof v.contract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v.contract)) return bad("contract");
  if (typeof v.asset !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(v.asset)) return bad("asset");
  if (typeof v.amount !== "string" || !/^[1-9][0-9]*$/.test(v.amount)) return bad("amount");
  if (typeof v.flopAmount !== "string" || !/^[1-9][0-9]*$/.test(v.flopAmount)) return bad("flopAmount");
  const d = v.deadlines as Record<string, unknown> | null;
  if (d === null || typeof d !== "object" || Object.keys(d).sort().join(",") !== "legA,legB") return bad("deadlines");
  const legA = parseRunLeg(d.legA);
  const legB = parseRunLeg(d.legB);
  if (legA === null || legB === null) return bad("deadlines");
  if (v.stopAfter !== null && v.stopAfter !== "lock") return bad("stopAfter");
  if (typeof v.buyerDid !== "string" || typeof v.sellerDid !== "string") return bad("DIDs");
  if (typeof v.buyerAccount !== "string" || !/^0x[0-9a-f]{40}$/.test(v.buyerAccount)) return bad("buyerAccount");
  if (typeof v.sellerAccount !== "string" || !/^0x[0-9a-f]{40}$/.test(v.sellerAccount)) return bad("sellerAccount");
  return {
    v: 1,
    swapId: v.swapId,
    nonce: v.nonce,
    t0Ms: v.t0Ms,
    lockTimeMs: v.lockTimeMs,
    chainId: v.chainId,
    contract: v.contract,
    asset: v.asset,
    amount: v.amount,
    flopAmount: v.flopAmount,
    deadlines: { legA, legB },
    stopAfter: v.stopAfter,
    buyerDid: v.buyerDid,
    sellerDid: v.sellerDid,
    buyerAccount: v.buyerAccount,
    sellerAccount: v.sellerAccount,
  };
}

const RUN_FILE = "run.json";
const OUTCOME_FILE = "outcome.json";

/** Written once the bundle is written AND `audit-export` accepted it: the run is over, and a repeat only says so. */
interface OutcomeRecord {
  v: 1;
  swapId: string;
  outcome: Outcome;
  bundle: string;
}

async function readOutcome(stateDir: string): Promise<OutcomeRecord | null> {
  const path = join(stateDir, OUTCOME_FILE);
  let text: string;
  try {
    text = await fsp.readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RehearsalWorldError(`${path} is not valid JSON; it records how this run ended and is never replaced`);
  }
  const v = value as Partial<OutcomeRecord> | null;
  if (
    v === null ||
    typeof v !== "object" ||
    v.v !== 1 ||
    typeof v.swapId !== "string" ||
    typeof v.bundle !== "string" ||
    (v.outcome !== "settled" && v.outcome !== "refunded" && v.outcome !== "refunded-b")
  ) {
    throw new RehearsalWorldError(`${path} is not an outcome record this build reads`);
  }
  return { v: 1, swapId: v.swapId, outcome: v.outcome, bundle: v.bundle };
}

async function readRun(stateDir: string): Promise<RunRecord | null> {
  const path = join(stateDir, RUN_FILE);
  let text: string;
  try {
    text = await fsp.readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  return parseRunRecord(text, path);
}

/** A resumed or refunded run must still be the run the config describes. */
function runMatchesConfig(run: RunRecord, config: RehearsalConfig): string | null {
  const evm = config.rails.evm;
  if (run.chainId !== evm.pin.chainId) return `the run was started on chain ${run.chainId}, the config pins ${evm.pin.chainId}`;
  if (run.contract.toLowerCase() !== evm.contract.toLowerCase()) return "the run was started against another escrow contract than the config names";
  if (run.asset !== config.asset) return `the run moves ${run.asset}, the config names ${config.asset}`;
  if (run.amount !== config.amount) return "the run's amount is not the config's amount";
  if (run.flopAmount !== config.flopAmount) return "the run's flopAmount is not the config's flopAmount";
  return null;
}

// --- small helpers --------------------------------------------------------------------------------------------------------------

/** Replaces the endpoint (as written and as a normalised URL) with a placeholder: a transport's error text names its URL. */
function makeRedact(endpoint: string): (text: string) => string {
  const variants = new Set<string>([endpoint, endpoint.replace(/\/+$/, "")]);
  try {
    variants.add(new URL(endpoint).href);
    variants.add(new URL(endpoint).href.replace(/\/+$/, ""));
  } catch {
    // validated by the config already
  }
  const list = [...variants].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  return (text) => {
    let result = text;
    for (const variant of list) result = result.split(variant).join("<rpc endpoint>");
    return result;
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** How many times a claim that the evidence reader does not yet see final (after the finalized block passed the lock) is asked again. */
const CLAIM_REREAD_ATTEMPTS = 20;

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** The pre-flight rows a refund does not depend on (the claim's `pending` read, the log scans, the Seller's gas: leg B refunds on paper). */
const REFUND_NOT_NEEDED: ReadonlySet<string> = new Set(["pending", "log range", "seller ETH"]);

/**
 * The flows' own refusals that the runner reacts to, by the text each carries. They are coupled by text on purpose (the flows have no
 * typed error for them), so `tests/rehearsal-run.test.ts` reads src/client/seller.ts and src/client/buyer.ts and fails if one of these
 * patterns no longer matches what the flows say.
 */
export const FLOW_MESSAGE = Object.freeze({
  /** `claimLegA`: the evidence reader does not (yet) read the lock final; nothing was signed, asking again is safe. */
  lockNotFinal: /before verifyLockFinal\(A\) is true/,
  /** `claimLegA`: the Seller's claim window (claim-by, or the margin before the refund time) has closed. */
  claimWindowClosed: /at\/after its claimByMs|claim-inclusion margin/,
  /** `refundLegA`: the refund was sent and does not read final yet. */
  refundUnconfirmed: /not yet confirmed/,
  /** `refundLegA`: leg A was never locked, so the Buyer has nothing at stake on the chain. */
  neverLocked: /never locked, nothing to refund/,
});

/** A refund is attempted only once the local clock AND the chain's head are both at or past the refund time (the contract judges the chain's). */
export function refundTimeReached(localMs: number, chainMs: number, refundAfterMs: number): boolean {
  return localMs >= refundAfterMs && chainMs >= refundAfterMs;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

function messageOf(error: unknown): string {
  const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
  return typeof short === "string" ? short : error instanceof Error ? error.message : String(error);
}

async function emptyOrAbsent(dir: string): Promise<boolean> {
  try {
    return (await fsp.readdir(dir)).length === 0;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return true;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

function dirOf(path: string): string {
  return join(path, "..");
}

// --- the runner -------------------------------------------------------------------------------------------------------------------

interface Accounts {
  buyer: { account: LocalAccount } | { problem: string };
  seller: { account: LocalAccount } | { problem: string };
}

async function loadAccounts(config: RehearsalConfig): Promise<Accounts> {
  const load = async (path: string): Promise<{ account: LocalAccount } | { problem: string }> => {
    try {
      return { account: await loadEvmLocalAccount(path) };
    } catch (error) {
      return { problem: messageOf(error) }; // an EvmKeyFileError names the path and the problem, never any content
    }
  };
  return { buyer: await load(config.buyerKeyFile), seller: await load(config.sellerKeyFile) };
}

/** The runner's clock: the machine's, or (anvil only) the machine's shifted once to the chain's head. */
async function makeClock(config: RehearsalConfig, env: RehearsalEnv, rpc: CapturingRpc): Promise<() => number> {
  if (config.clock === "system") return () => env.now();
  const head = (await rpc.request({ method: "eth_getBlockByNumber", params: ["latest", false] })) as { timestamp?: unknown } | null;
  const stamp = head?.timestamp;
  if (typeof stamp !== "string" || !HEX_QUANTITY.test(stamp)) throw new Error("the node answered no usable head block, so the chain clock cannot be read");
  const offset = Number(BigInt(stamp)) * 1000 - env.now();
  return () => env.now() + offset;
}

interface Party {
  identity: RehearsalIdentity;
  account: LocalAccount;
  rail: CounterAssetRail;
  store: FileFlowStore;
}

interface World {
  config: RehearsalConfig;
  env: RehearsalEnv;
  stateDir: string;
  clock: () => number;
  /** The runner's own reads (waits, probes): not a party's transport. */
  rpc: CapturingRpc;
  venue: DurableVenue;
  notes: DurableNoteStore;
  paper: (side: "buyer" | "seller") => PaperRail;
  buyer: Party;
  seller: Party;
  run: RunRecord;
  log: (line: string) => void;
  pollMs: number;
}

class RunnerRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerRefusal";
  }
}

/** Reads the finalized block number the way the pin says (the tag, or the fallback confirmations), or null when it cannot be read now. */
async function finalizedNumber(rpc: CapturingRpc, config: RehearsalConfig): Promise<bigint | null> {
  const finality = config.rails.evm.pin.finality;
  const head = async (tag: string): Promise<bigint | null> => {
    try {
      const block = (await rpc.request({ method: "eth_getBlockByNumber", params: [tag, false] })) as { number?: unknown } | null;
      return typeof block?.number === "string" && HEX_QUANTITY.test(block.number) ? BigInt(block.number) : null;
    } catch {
      return null;
    }
  };
  const byConfirmations = async (n: number): Promise<bigint | null> => {
    const latest = await head("latest");
    if (latest === null) return null;
    return latest >= BigInt(n) ? latest - BigInt(n) : 0n;
  };
  if (finality.mode === "confirmations") return byConfirmations(finality.confirmations);
  const tagged = await head(finality.tag);
  if (tagged !== null) return tagged;
  return finality.fallbackConfirmations === undefined ? null : byConfirmations(finality.fallbackConfirmations);
}

async function blockNumberNow(rpc: CapturingRpc): Promise<bigint> {
  const hex = await rpc.request({ method: "eth_blockNumber", params: [] });
  if (typeof hex !== "string" || !HEX_QUANTITY.test(hex)) throw new Error("eth_blockNumber did not answer a number");
  return BigInt(hex);
}

async function latestBlockMs(rpc: CapturingRpc): Promise<number> {
  const block = (await rpc.request({ method: "eth_getBlockByNumber", params: ["latest", false] })) as { timestamp?: unknown } | null;
  if (typeof block?.timestamp !== "string" || !HEX_QUANTITY.test(block.timestamp)) throw new Error("the node answered no usable head block");
  return Number(BigInt(block.timestamp)) * 1000;
}

/** Waits (real polling) until the finalized block is at least `minBlock`: the transaction mined at or below it is then final. */
async function waitFinalized(w: World, minBlock: bigint | undefined, what: string): Promise<void> {
  if (minBlock === undefined) return;
  const startedMs = w.env.now();
  let lastLogMs = 0;
  for (;;) {
    const finalized = await finalizedNumber(w.rpc, w.config);
    if (finalized !== null && finalized >= minBlock) return;
    const elapsed = w.env.now() - startedMs;
    if (elapsed > w.config.waitLimitMs) {
      throw new RunnerRefusal(`the ${what} (block ${minBlock}) was not final after ${Math.round(elapsed / 1000)} s (waitLimitMs); run --resume to keep waiting`);
    }
    if (w.env.now() - lastLogMs >= 30_000) {
      w.log(`waiting for the ${what} to be final: block ${minBlock}, the finalized block is ${finalized === null ? "unreadable" : finalized}`);
      lastLogMs = w.env.now();
    }
    await w.env.sleep(w.pollMs);
  }
}

function buyerRank(next: BuyerNextStep): number {
  return { abandoned: -1, bid: 0, acceptLegB: 1, verifyLegBLocked: 2, postAccountLineA: 3, lockLegA: 4, learnSecret: 5, refundLegA: 5, done: 6 }[next];
}

function sellerRank(next: SellerNextStep): number {
  return { abandoned: -1, acceptLegA: 0, postAccountLineA: 1, lockLegB: 1, claimLegA: 2, refundLegB: 2, done: 3 }[next];
}

/** Opens the Buyer's flow: resumed from its record when the store holds one, else new. */
async function openBuyer(w: World): Promise<{ flow: BuyerFlow; next: BuyerNextStep }> {
  const options = {
    identity: w.buyer.identity,
    venue: w.venue,
    paperRail: w.paper("buyer"),
    rail: w.buyer.rail,
    clock: w.clock,
    store: w.buyer.store,
  };
  if ((await w.buyer.store.list()).includes(flowKey("buyer", w.run.swapId))) return BuyerFlow.resume({ ...options, swapId: w.run.swapId });
  return { flow: new BuyerFlow(options), next: "bid" };
}

/** Opens the Seller's flow: resumed from its record (keyed by leg A's contract id) when the store holds one, else new. */
async function openSeller(w: World): Promise<{ flow: SellerFlow; next: SellerNextStep } | null> {
  const options = {
    identity: w.seller.identity,
    venue: w.venue,
    paperRail: w.paper("seller"),
    rail: w.seller.rail,
    clock: w.clock,
    store: w.seller.store,
  };
  const keys = (await w.seller.store.list()).filter((key) => key.startsWith("seller:"));
  if (keys.length > 1) throw new RunnerRefusal("the Seller's store holds more than one swap; one state directory is one swap");
  const only = keys[0];
  if (only === undefined) return null;
  return SellerFlow.resume({ ...options, swapId: w.run.swapId, contractA: parseFlowKey(only).swapId });
}

function newSeller(w: World): SellerFlow {
  return new SellerFlow({
    identity: w.seller.identity,
    venue: w.venue,
    paperRail: w.paper("seller"),
    rail: w.seller.rail,
    clock: w.clock,
    store: w.seller.store,
  });
}

function evidenceTx(evidence: RailWriteEvidence): string {
  return evidence.txHash === undefined ? "recovered from the chain" : `tx ${evidence.txHash}, block ${evidence.blockNumber ?? "?"}`;
}

/** Runs the audit export on the written bundle and returns whether it accepted the expected status. */
async function auditBundle(w: World, root: string, outcome: Outcome): Promise<boolean> {
  const script = fileURLToPath(new URL("../../examples/audit-export.mjs", import.meta.url));
  const expect = `${w.run.swapId}=${outcome}`;
  w.log(`audit: node examples/audit-export.mjs --root <bundle> --expect <swap>=${outcome}`);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, "--root", root, "--expect", expect], { maxBuffer: 16 * 1024 * 1024 });
    for (const line of stdout.split("\n")) if (line.trim() !== "") w.log(`  ${line}`);
    for (const line of stderr.split("\n")) if (line.trim() !== "") w.env.err(`  ${line}`);
    w.log(`audit: the bundle replays offline to ${outcome}`);
    return true;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    for (const line of (failure.stdout ?? "").split("\n")) if (line.trim() !== "") w.log(`  ${line}`);
    for (const line of (failure.stderr ?? "").split("\n")) if (line.trim() !== "") w.env.err(`  ${line}`);
    w.env.err(`audit: examples/audit-export.mjs did not accept ${outcome} (exit ${failure.code ?? "?"}); the bundle is at ${root}`);
    return false;
  }
}

interface BundleParts {
  outcome: Outcome;
  acceptAContract: string;
  acceptBContract: string;
  hashLock: string | undefined;
  writes: BundleEvidenceSummary["writes"];
  exchanges: readonly Exchange[];
}

/** Writes the bundle (to a sibling staging directory, then renamed to `out`) and replays it with `audit-export`. */
async function writeAndAudit(w: World, parts: BundleParts): Promise<number> {
  const out = w.config.out;
  if (!(await emptyOrAbsent(out))) throw new RunnerRefusal(`the bundle directory ${out} is not empty; move it away or name another "out"`);
  await fsp.mkdir(dirOf(out), { recursive: true });
  const stage = `${out}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
  const nowMs = w.clock();
  const dealRoomA = dealRoom(parts.acceptAContract);
  const dealRoomB = dealRoom(parts.acceptBContract);
  const { ns, key } = paperNote(parts.acceptBContract);
  const rawNote = w.notes.raw(ns, key);
  await writeBundle({
    root: stage,
    nowMs,
    offerRoomRecords: await w.venue.read(OFFER_ROOM),
    dealRooms: new Map([
      [dealRoomA, await w.venue.read(dealRoomA)],
      [dealRoomB, await w.venue.read(dealRoomB)],
    ]),
    paperNotes: rawNote === undefined ? new Map() : new Map([[parts.acceptBContract, rawNote]]),
    writeExchanges: parts.exchanges,
    ...(parts.hashLock === undefined
      ? {}
      : { evm: { config: w.config.rails.evm, rpc: new CapturingRpc({ endpoint: w.config.rails.evm.endpoint, clock: w.clock }), hashLock: parts.hashLock } }),
    evidence: {
      swapId: w.run.swapId,
      legA: { contract: parts.acceptAContract, rail: "evm-htlc" },
      legB: { contract: parts.acceptBContract, rail: "paper" },
      feeBps: 0,
      writes: parts.writes,
      startedAtMs: w.run.t0Ms,
      finishedAtMs: nowMs,
    },
  });
  if (await exists(out)) await fsp.rmdir(out); // empty (checked above); a rename onto an existing directory is refused on Windows
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(stage, out);
      break;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "string" || !RENAME_RETRY_CODES.has(code) || attempt >= 6) throw error; // a scanner may briefly hold the new files (Windows)
      await w.env.sleep(50 * attempt);
    }
  }
  w.log(`bundle written to ${out}`);
  if (!(await auditBundle(w, out, parts.outcome))) return EXIT.audit;
  const record: OutcomeRecord = { v: 1, swapId: w.run.swapId, outcome: parts.outcome, bundle: out };
  await writeFileDurable(join(w.stateDir, OUTCOME_FILE), `${JSON.stringify(record, null, 2)}\n`);
  w.log(`done: swap ${w.run.swapId} ${parts.outcome}; bundle ${out}`);
  return EXIT.ok;
}

// --- the swap -----------------------------------------------------------------------------------------------------------------------

/** `--yes` and `--resume`: the choreography of tests-anvil/client-flows.anvil.test.ts, each step skipped or confirmed from the records. */
async function driveSettle(w: World): Promise<number> {
  const { run, log } = w;
  const buyerOpen = await openBuyer(w);
  const sellerOpen = await openSeller(w);
  const bRank = buyerRank(buyerOpen.next);
  const sRank = sellerOpen === null ? 0 : sellerRank(sellerOpen.next);
  if (bRank < 0 || sRank < 0) {
    throw new RunnerRefusal("the swap was abandoned (an offer expired before the pairing finished); nothing is locked on either leg; start a new swap in a new state directory");
  }
  if (buyerOpen.next === "refundLegA") throw new RunnerRefusal("leg A's refund time has come; use --refund");
  if (sellerOpen?.next === "refundLegB") throw new RunnerRefusal("leg B's refund has begun; use --refund");
  const buyer = buyerOpen.flow;
  const seller = sellerOpen === null ? newSeller(w) : sellerOpen.flow;
  const buyerAddress = w.buyer.account.address;
  const sellerAddress = w.seller.account.address;
  const step = (who: string, what: string, detail = ""): void => log(`step ${who}.${what} done${detail === "" ? "" : `: ${detail}`}`);

  log(`${bRank === 0 && sRank === 0 ? "starting" : "continuing"} swap ${run.swapId} (buyer next: ${buyerOpen.next}, seller next: ${sellerOpen === null ? "acceptLegA" : sellerOpen.next})`);

  const offerA = await buyer.bid({
    swapId: run.swapId,
    wantAsset: "FLOP",
    wantAmount: run.flopAmount,
    wantRail: "flop-htlc",
    amount: run.amount,
    asset: run.asset,
    ...run.deadlines.legA,
  });
  step("buyer", "bid", `offer A ${offerA.id}`);
  const accepted = await seller.acceptLegA(offerA, run.deadlines.legB, run.lockTimeMs);
  step("seller", "acceptLegA", `contract A ${accepted.acceptA.contract}`);
  const paired = await buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, run.lockTimeMs);
  step("buyer", "acceptLegB", `contract B ${paired.acceptB.contract}`);
  if (sRank <= 1) {
    await seller.lockLegB(paired.acceptBRecord);
    step("seller", "lockLegB", "paper note");
  }
  if (bRank <= 2) {
    await buyer.verifyLegBLocked();
    step("buyer", "verifyLegBLocked");
  }
  if (sRank <= 1) {
    await seller.postAccountLineA(sellerAddress);
    step("seller", "postAccountLineA", `account ${sellerAddress}`);
  }
  if (bRank <= 3) {
    await buyer.postAccountLineA(buyerAddress);
    step("buyer", "postAccountLineA", `account ${buyerAddress}`);
  }
  const lockA = await buyer.lockLegA();
  step("buyer", "lockLegA", evidenceTx(lockA.writeEvidence));

  if (run.stopAfter === "lock") {
    const a = run.deadlines.legA.refundAfterMs;
    const b = run.deadlines.legB.refundAfterMs;
    log(`stopped after the lock, as asked: the Seller will not claim in this run. Leg A is refundable from ${iso(a)} and leg B from ${iso(b)}; then run --refund (add --wait to wait here)`);
    return EXIT.ok;
  }

  await waitFinalized(w, lockA.writeEvidence.blockNumber, "lock of leg A");
  let claimed: Awaited<ReturnType<SellerFlow["claimLegA"]>> | undefined;
  const claimStartedMs = w.env.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      claimed = await seller.claimLegA(lockA.hashLock);
      break;
    } catch (error) {
      // The lock was final by the finalized block number a moment ago but the evidence reader's own read (state at the finalized hash) may
      // lag it by a block: the claim refuses before it signs anything, so waiting and asking again is safe, a few times. Anything else (or
      // a lock that stays unreadable) is a real refusal, reported.
      const message = messageOf(error);
      if (FLOW_MESSAGE.claimWindowClosed.test(message)) {
        throw new RunnerRefusal(
          `${describeFailure(error, (t) => t)}; the Seller's claim window has closed, so leg A will go back to the Buyer: run --refund once leg A's refund time ${iso(run.deadlines.legA.refundAfterMs)} has come`,
        );
      }
      if (!FLOW_MESSAGE.lockNotFinal.test(message) || attempt >= CLAIM_REREAD_ATTEMPTS || w.env.now() - claimStartedMs > w.config.waitLimitMs) throw error;
      log(`the lock does not read final to the evidence reader yet (${describeFailure(error, (t) => t)}); asking again (${attempt}/${CLAIM_REREAD_ATTEMPTS})`);
      await w.env.sleep(w.pollMs);
    }
  }
  step("seller", "claimLegA", evidenceTx(claimed.evidence));

  const secret = await buyer.learnSecret();
  step("buyer", "learnSecret", "the secret opens leg A's hash lock");
  await buyer.claimLegB(secret);
  step("buyer", "claimLegB", "paper note");

  await waitFinalized(w, await blockNumberNow(w.rpc), "claim of leg A");
  return writeAndAudit(w, {
    outcome: "settled",
    acceptAContract: accepted.acceptA.contract,
    acceptBContract: paired.acceptB.contract,
    hashLock: lockA.hashLock,
    writes: [
      { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockA.writeEvidence },
      { leg: "a", step: "claim", rail: "evm-htlc", evidence: claimed.evidence },
    ],
    exchanges: [...buyer.exchanges, ...seller.exchanges],
  });
}

export interface RefundWaitParams {
  /** "leg A" or "leg B", for the log. */
  label: string;
  refundAfterMs: number;
  /** The runner's clock. */
  local: () => number;
  /** The chain's head time in ms; absent for a leg that has no chain (leg B's paper note, judged by the local clock alone). */
  head: (() => Promise<number>) | undefined;
  /** Wait for the refund time (true), or report that it has not come and give up (false). */
  wait: boolean;
  /** The machine clock and a sleep (the log's cadence and the pause between looks). */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  log: (line: string) => void;
}

/** Looks until `refundAfterMs` is behind the local clock and (when the leg has a chain) the chain's head. True once it is; false when it is not and `wait` is off. */
export async function untilRefundTime(p: RefundWaitParams): Promise<boolean> {
  let lastLogMs = 0;
  for (;;) {
    const local = p.local();
    const head = p.head === undefined ? local : await p.head();
    if (refundTimeReached(local, head, p.refundAfterMs)) return true;
    const remaining = Math.max(p.refundAfterMs - local, p.refundAfterMs - head);
    if (!p.wait) {
      p.log(`${p.label} is refundable from ${iso(p.refundAfterMs)}: the local clock reads ${iso(local)}${p.head === undefined ? "" : ` and the chain's head ${iso(head)}`}; run --refund again after that (or add --wait to wait here)`);
      return false;
    }
    if (p.now() - lastLogMs >= 60_000) {
      p.log(`waiting for ${p.label}'s refund time ${iso(p.refundAfterMs)} (${Math.ceil(remaining / 60_000)} min to go)`);
      lastLogMs = p.now();
    }
    await p.sleep(Math.min(Math.max(p.pollMs, 1_000), 30_000));
  }
}

/** `--refund`: Buyer refunds leg A, Seller refunds leg B (the paper note), then the bundle. */
async function driveRefund(w: World, wait: boolean): Promise<number> {
  const { run, log } = w;
  const step = (who: string, what: string, detail = ""): void => log(`step ${who}.${what} done${detail === "" ? "" : `: ${detail}`}`);
  if ((await w.buyer.store.list()).length === 0) throw new RunnerRefusal("the Buyer's store holds no record: this state directory never began a swap, so there is nothing to refund");
  const buyerOpen = await openBuyer(w);
  const sellerOpen = await openSeller(w);
  if (sellerOpen === null) throw new RunnerRefusal("the Seller's store holds no record: leg B was never accepted or locked, so there is nothing to refund");
  if (buyerOpen.next === "abandoned" || sellerOpen.next === "abandoned") {
    throw new RunnerRefusal("the swap was abandoned before anything was locked; there is nothing to refund");
  }
  // Leg B is locked only after the Buyer's accept B has landed and the Seller's accept A is done: before that nothing is locked anywhere.
  if (buyerRank(buyerOpen.next) <= 1 || sellerRank(sellerOpen.next) < 1) {
    throw new RunnerRefusal("the swap never got as far as a lock on either leg; there is nothing to refund");
  }
  const buyer = buyerOpen.flow;
  const seller = sellerOpen.flow;
  const accepted = await seller.acceptLegA(await buyer.bid({
    swapId: run.swapId,
    wantAsset: "FLOP",
    wantAmount: run.flopAmount,
    wantRail: "flop-htlc",
    amount: run.amount,
    asset: run.asset,
    ...run.deadlines.legA,
  }), run.deadlines.legB, run.lockTimeMs);
  const paired = await buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, run.lockTimeMs);

  log(`refunding swap ${run.swapId} (buyer next: ${buyerOpen.next}, seller next: ${sellerOpen.next})`);
  const waitFor = (label: string, refundAfterMs: number, chain: boolean): Promise<boolean> =>
    untilRefundTime({
      label,
      refundAfterMs,
      local: w.clock,
      head: chain ? () => latestBlockMs(w.rpc) : undefined,
      wait,
      now: w.env.now,
      sleep: w.env.sleep,
      pollMs: w.pollMs,
      log: w.log,
    });
  if (!(await waitFor("leg A", run.deadlines.legA.refundAfterMs, true))) return EXIT.notYet;

  let refundA: RailWriteEvidence | undefined;
  const refundStartedMs = w.env.now();
  for (;;) {
    try {
      refundA = await buyer.refundLegA();
      break;
    } catch (error) {
      const message = messageOf(error);
      if (FLOW_MESSAGE.neverLocked.test(message)) break; // leg A was never locked: the Buyer has nothing at stake on chain
      if (!FLOW_MESSAGE.refundUnconfirmed.test(message) || w.env.now() - refundStartedMs > w.config.waitLimitMs) throw error;
      // The refund was signed and sent; it reads final only once the finalized block passes the one it landed in. The tip now is above it.
      log("the refund of leg A is not final yet; waiting for the finalized block to pass the current head");
      await waitFinalized(w, await blockNumberNow(w.rpc), "refund of leg A");
    }
  }
  if (refundA === undefined) step("buyer", "refundLegA", "leg A was never locked: nothing to refund on chain");
  else step("buyer", "refundLegA", evidenceTx(refundA));

  if (!(await waitFor("leg B", run.deadlines.legB.refundAfterMs, false))) {
    log("leg A is refunded; leg B (the paper note) is not refundable yet");
    return EXIT.notYet;
  }
  await seller.refundLegB();
  step("seller", "refundLegB", "paper note");

  let lockEvidence: RailWriteEvidence | undefined;
  if (refundA !== undefined) {
    try {
      lockEvidence = (await buyer.lockLegA()).writeEvidence;
    } catch (error) {
      log(`the lock's own evidence could not be read back (${describeFailure(error, (t) => t)}); the summary names its reference only`);
    }
    await waitFinalized(w, await blockNumberNow(w.rpc), "refund of leg A");
  }
  return writeAndAudit(w, {
    outcome: refundA === undefined ? "refunded-b" : "refunded",
    acceptAContract: accepted.acceptA.contract,
    acceptBContract: paired.acceptB.contract,
    hashLock: refundA === undefined ? undefined : accepted.acceptA.statement,
    writes:
      refundA === undefined
        ? [{ leg: "b", step: "refund", rail: "paper", evidence: {} }]
        : [
            { leg: "a", step: "lock", rail: "evm-htlc", evidence: lockEvidence ?? { ref: accepted.acceptA.statement, raw: [] } },
            { leg: "a", step: "refund", rail: "evm-htlc", evidence: refundA },
          ],
    exchanges: [...buyer.exchanges, ...seller.exchanges],
  });
}

// --- set-up and dispatch ----------------------------------------------------------------------------------------------------------

function describeSwapPlan(config: RehearsalConfig, absolute: RunDeadlines, t0Ms: number, lockTimeMs: number): string[] {
  const after = (ms: number): string => `${Math.round((ms - t0Ms) / 60_000)} min after the start`;
  return [
    "Plan (nothing below has happened; this is what --yes would do):",
    `  1. the Buyer bids ${config.amount} minimal units of ${config.asset} for ${config.flopAmount} FLOP on the paper rail; the Seller accepts and opens leg B`,
    "  2. the Buyer accepts leg B, the Seller locks it on the paper rail (no value), both post a proven account line (signed locally)",
    `  3. the Buyer approves and locks leg A on the chain (two transactions), expected within ${Math.round(LOCK_ESTIMATE_MS / 60_000)} min (rules checked at ${iso(lockTimeMs)})`,
    "  4. wait until the lock reads at the finalized block (real waiting), the Seller claims (one transaction) and reveals the secret",
    "  5. the Buyer learns the secret and claims leg B on the paper note; wait until the claim is final; write the bundle; replay it offline",
    `  deadlines: leg A claim-by ${iso(absolute.legA.claimByMs)}, refundable from ${iso(absolute.legA.refundAfterMs)}; leg B claim-by ${iso(absolute.legB.claimByMs)}, refundable from ${iso(absolute.legB.refundAfterMs)}`,
    `  refund rehearsal (--yes --stop-after lock, then --refund): leg A is refundable ${after(absolute.legA.refundAfterMs)}, leg B ${after(absolute.legB.refundAfterMs)}`,
    `  bundle: ${config.out}`,
  ];
}

/** Everything one invocation does. Returns the process exit code; throws nothing. */
export async function runRehearsal(options: RehearsalOptions): Promise<number> {
  const { env, mode } = options;
  let config: RehearsalConfig;
  try {
    config = await loadRehearsalConfig(options.configPath);
  } catch (error) {
    env.err(error instanceof RehearsalConfigError ? error.message : `rehearsal: ${messageOf(error)}`);
    return EXIT.config;
  }
  const evm = config.rails.evm;
  const redact = makeRedact(evm.endpoint);
  const out = (line: string): void => env.out(redact(line));
  const errLine = (line: string): void => env.err(redact(line));
  const safeEnv: RehearsalEnv = { ...env, out, err: errLine };
  const stateDir = options.stateDir;

  let release: (() => Promise<void>) | undefined;
  try {
    const rpc = new CapturingRpc({ endpoint: evm.endpoint });
    const clock = await makeClock(config, env, rpc).catch((error) => {
      throw new RunnerRefusal(describeFailure(error, redact));
    });
    const log = (line: string): void => out(`[${iso(clock())}] ${line}`);

    if (mode !== "dry") release = await acquireRunLock(stateDir);

    const accounts = await loadAccounts(config);
    const buyerProblem = "problem" in accounts.buyer ? accounts.buyer.problem : undefined;
    const sellerProblem = "problem" in accounts.seller ? accounts.seller.problem : undefined;
    const fresh = mode === "dry" || mode === "yes";

    // The state of this directory, before anything is written.
    const existingRun = await readRun(stateDir);
    const stateRows: PreflightRow[] = [];
    if (fresh) {
      if (existingRun !== null) {
        stateRows.push({ check: "state directory", status: "fail", detail: `${stateDir} already holds swap ${existingRun.swapId}; --resume continues it, --refund refunds it; use a new --state-dir for a new swap` });
      } else {
        stateRows.push({ check: "state directory", status: "info", detail: `${stateDir} (secret-grade: the Seller's swap secret and the venue's signing seeds go there)` });
      }
      stateRows.push(
        (await emptyOrAbsent(config.out))
          ? { check: "bundle directory", status: "ok", detail: `${config.out} is absent or empty` }
          : { check: "bundle directory", status: "fail", detail: `${config.out} is not empty; move it away or name another "out"` },
      );
    }

    // Rails (no network at construction) give the pre-flight the policy and the continue-mode steps their transports.
    const buildParty = async (
      role: "buyer" | "seller",
      account: LocalAccount,
    ): Promise<{ rail: CounterAssetRail; store: FileFlowStore; identity: Promise<RehearsalIdentity> }> => ({
      rail: createEvmCounterRail({ config: evm, rpc: new CapturingRpc({ endpoint: evm.endpoint, clock }), account, clock }),
      store: new FileFlowStore(join(stateDir, role, "flows")),
      identity: loadOrCreateIdentity(join(stateDir, role, "ed25519.seed")),
    });

    const t0Ms = existingRun?.t0Ms ?? clock();
    const lockTimeMs = existingRun?.lockTimeMs ?? t0Ms + LOCK_ESTIMATE_MS;
    const absolute = existingRun?.deadlines ?? absoluteDeadlines(config.deadlines, t0Ms);
    // Only the rail's deadline policy is read from this one (it is selected on the rail object, never a constructor option); the zero
    // address is a placeholder account that no call ever uses: nothing is connected and nothing is sent through it.
    const policyRail = createEvmCounterRail({ config: evm, rpc: new CapturingRpc({ endpoint: evm.endpoint, clock }), account: ZERO_ADDRESS, clock });

    if (!fresh) {
      if (existingRun === null) throw new RunnerRefusal(`${stateDir} holds no run (no ${RUN_FILE}); there is nothing to ${mode === "resume" ? "resume" : "refund"} here`);
      const mismatch = runMatchesConfig(existingRun, config);
      if (mismatch !== null) throw new RunnerRefusal(`the config no longer matches this run: ${mismatch}`);
      // A finished run is only reported: nothing on the chain or in the state directory is touched again.
      const finished = await readOutcome(stateDir);
      if (finished !== null) {
        const wanted = mode === "resume" ? finished.outcome === "settled" : finished.outcome !== "settled";
        out(`this run already ended: swap ${finished.swapId} ${finished.outcome}; bundle ${finished.bundle}`);
        if (wanted) return EXIT.ok;
        throw new RunnerRefusal(mode === "resume" ? `the run ended as ${finished.outcome}, so there is nothing to resume` : "the run settled, so there is nothing to refund");
      }
    }

    const report: PreflightReport = await runPreflight({
      config,
      rpc,
      buyer: "account" in accounts.buyer ? { address: accounts.buyer.account.address as Address } : { problem: buyerProblem ?? "no buyer account" },
      seller: "account" in accounts.seller ? { address: accounts.seller.account.address as Address } : { problem: sellerProblem ?? "no seller account" },
      nowMs: clock(),
      fresh,
      ...(fresh ? { deadlines: { absolute, lockTimeMs } } : {}),
      policy: policyRail.policy,
      redact,
      // A refund needs the chain, the escrow, the finalized read, the clock and the Buyer's gas: a diagnostic that only a claim or a log
      // scan uses must never stand between an honest party and its refund (it still shows, as a warning).
      ...(mode === "refund" ? { notNeeded: REFUND_NOT_NEEDED } : {}),
    });
    const rows = [...report.rows, ...stateRows];
    const checked: PreflightReport = { rows, ok: !rows.some((row) => row.status === "fail") };
    const title =
      mode === "dry"
        ? "EVM rehearsal pre-flight (DRY RUN: reads the chain, sends nothing)"
        : `EVM rehearsal pre-flight before --${mode} (reads the chain, sends nothing)`;
    for (const line of renderPreflight(checked, title)) out(line);

    if (!checked.ok) {
      out(
        mode === "dry"
          ? "Nothing was sent. Fix the failed checks, then run the dry run again."
          : mode === "yes"
            ? "Nothing was sent: --yes refuses to broadcast unless every needed check holds."
            : `Nothing was sent: --${mode} did nothing because a check it needs failed.`,
      );
      return EXIT.preflight;
    }
    if (mode === "dry") {
      for (const line of describeSwapPlan(config, absolute, t0Ms, lockTimeMs)) out(line);
      out("This was a dry run: no transaction was sent, no file was written. Dave runs --yes (or --resume, --refund) himself.");
      return EXIT.ok;
    }

    // From here the runner may write and send. Both accounts are loaded (the pre-flight checked it).
    if (!("account" in accounts.buyer) || !("account" in accounts.seller)) throw new RunnerRefusal("a key file did not load");
    if (
      existingRun !== null &&
      (existingRun.buyerAccount !== accounts.buyer.account.address.toLowerCase() || existingRun.sellerAccount !== accounts.seller.account.address.toLowerCase())
    ) {
      throw new RunnerRefusal("the key files now name other accounts than the ones this run started with (the config's buyerKeyFile and sellerKeyFile must be the same two accounts)");
    }
    const buyerParty = await buildParty("buyer", accounts.buyer.account);
    const sellerParty = await buildParty("seller", accounts.seller.account);
    const buyerIdentity = await buyerParty.identity;
    const sellerIdentity = await sellerParty.identity;

    let run: RunRecord;
    if (mode === "yes") {
      const nonce = randomBytes(8).toString("hex");
      run = {
        v: 1,
        swapId: computeSwapId(buyerIdentity.did, nonce),
        nonce,
        t0Ms,
        lockTimeMs,
        chainId: evm.pin.chainId,
        contract: evm.contract,
        asset: config.asset,
        amount: config.amount,
        flopAmount: config.flopAmount,
        deadlines: absolute,
        stopAfter: options.stopAfter ?? null,
        buyerDid: buyerIdentity.did,
        sellerDid: sellerIdentity.did,
        buyerAccount: accounts.buyer.account.address.toLowerCase(),
        sellerAccount: accounts.seller.account.address.toLowerCase(),
      };
      await writeFileDurable(join(stateDir, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
    } else {
      run = existingRun as RunRecord; // checked above
      if (run.buyerDid !== buyerIdentity.did || run.sellerDid !== sellerIdentity.did) {
        throw new RunnerRefusal("the identities in this state directory are not the ones the run was started with");
      }
    }

    const venue = await DurableVenue.open(join(stateDir, "world", "venue.json"), clock);
    const notes = await DurableNoteStore.open(join(stateDir, "world", "notes.json"));
    const world: World = {
      config,
      env: safeEnv,
      stateDir,
      clock,
      rpc,
      venue,
      notes,
      paper: () => new PaperRail(notes, clock),
      buyer: { identity: buyerIdentity, account: accounts.buyer.account, rail: buyerParty.rail, store: buyerParty.store },
      seller: { identity: sellerIdentity, account: accounts.seller.account, rail: sellerParty.rail, store: sellerParty.store },
      run,
      log,
      pollMs: config.pollMs,
    };
    log(`${mode === "yes" ? "run" : mode} started: swap ${run.swapId}; buyer ${buyerIdentity.did} account ${accounts.buyer.account.address}; seller ${sellerIdentity.did} account ${accounts.seller.account.address}`);
    return mode === "refund" ? await driveRefund(world, options.wait === true) : await driveSettle(world);
  } catch (error) {
    if (error instanceof RunLockedError || error instanceof RehearsalWorldError) {
      errLine(`rehearsal: ${error.message}`);
      return EXIT.config;
    }
    if (error instanceof RunnerRefusal) {
      errLine(`rehearsal: ${error.message}`);
      return EXIT.refused;
    }
    errLine(`rehearsal: refused: ${error instanceof Error ? error.name : "Error"}: ${describeFailure(error, redact)}`);
    return EXIT.refused;
  } finally {
    if (release !== undefined) await release().catch(() => undefined);
  }
}
