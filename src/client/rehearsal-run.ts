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
//                          claim B; then the bundle and `examples/audit-export.mjs --expect <swapId>=settled` (P9-4 decision 13: `=revealed`, and exit 0 with one fixed
//                          sentence, when the Seller's reveal frame was stamped at or after leg A's refund time: the late-claim path below). Real waiting on the
//                          chain's clock. `--stop-after lock` ends after the lock (the Seller never claims: the first half of a refund rehearsal).
//   --resume               a fresh process continues the run from the state directory: the P8 flow records (both roles), the durable
//                          venue and paper notes (src/client/rehearsal-world.ts) and run.json. Each step reads what it needs from
//                          the records and the chain, so a kill at any instant costs gas at most: a repeated lock or claim is refused by the
//                          contract and costs only gas (a write that was still pending when the run stopped is signed and sent again).
//   --refund               drives the refund path after the deadlines: the Buyer refunds leg A once leg A's refund time has come
//                          (the local clock AND the chain's head must be past it), the Seller refunds leg B (the paper note) once
//                          its refund time has come, then the bundle and `--expect <swapId>=refunded` (or `refunded-b` when leg A
//                          was never locked). Without `--wait` a refund time not yet reached is reported (exit 5) and the run can be repeated.
//                          It needs no key file of the Seller's (a refund moves nothing of the Seller's on the chain): a missing one is a warning.
//                          R2-FUND-01: a leg A lock attempt that never landed (a refused lock after the approve, a signer refusal, a dropped lock, a kill between
//                          the two) ends in a verdict, never a loop: once leg A's refund time is FINALIZED with no lock on the chain the Buyer's record says
//                          so, the Seller's leg B is refunded and the bundle replays to `refunded-b`; before that finalized block the run waits for it
//                          (bounded by `waitLimitMs`). A `--resume` of a run whose Buyer record holds that verdict has no settle to resume and continues as `--refund`.
//                          R3-FUND-01: a Seller's claim of leg A that landed but is not FINAL yet when the Buyer refunds (it landed within one finality lag of leg A's
//                          refund time) is waited for (bounded by `waitLimitMs`), never routed on; the run then ends with the claimed-lock refusal that names `--resume`.
//                          P9-4 decision 13: the following `--resume` finishes the swap on chain (one lock, one claim, leg B claimed), but the Seller's reveal frame can only be posted now,
//                          after leg A's refund time, which tclk's machine rejects ("refund window is open"): the bundle replays to `revealed`, not `settled`. That is the protocol's own grade
//                          for a reveal that came late, not a lost swap, so the runner expects `revealed` for that path (decided from the reveal frame's own stamp, never by trying
//                          `settled` first), writes the bundle, and exits 0 with `LATE_REVEAL_SENTENCE`; the on-chain evidence is the proof.
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { OFFER_ROOM, PaperRail, dealRoom, paperNote } from "@flop-labs/tclk";
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import type { LocalAccount } from "viem/accounts";

import { swapId as computeSwapId } from "../profile.js";
import { effectiveMaxLogRange, evmLogScanCoverage, MAX_LOG_SCAN_CHUNKS } from "../rails/evm-htlc.js";
import { CapturingRpc, type Exchange } from "../rails/rpc-capture.js";
import { EVM_HASH_RAIL_ABI } from "../vendor/evm-hash-rail.js";
import { writeBundle, type BundleEvidenceSummary } from "./bundle.js";
import { BuyerFlow, LockPendingError, RefundNotFinalYetError, type BuyerNextStep } from "./buyer.js";
import type { CounterAssetRail, RailWriteEvidence } from "./counter-rail.js";
import { describeKeyFileProblem, EvmKeyFileError, loadEvmLocalAccount } from "./evm-key-file.js";
import { createEvmCounterRail } from "./evm-rail.js";
import { decodeFlowRecord } from "./flow-record.js";
import { FileFlowStore, flowKey, parseFlowKey } from "./flow-store.js";
import {
  absoluteDeadlines,
  loadRehearsalConfig,
  LOCK_ESTIMATE_MS,
  looksLikeKeyMaterial,
  RehearsalConfigError,
  type RehearsalConfig,
  type RunDeadlines,
} from "./rehearsal-config.js";
import { describeFailure, renderPreflight, runPreflight, type BuyerSends, type PreflightReport, type PreflightRow, type SellerSends } from "./rehearsal-preflight.js";
import { acquireRunLock, DurableNoteStore, DurableVenue, loadOrCreateIdentity, RehearsalWorldError, RunLockedError, writeFileDurable, type RehearsalIdentity } from "./rehearsal-world.js";
import { evmLocalPolicyFor } from "./policy.js";
import { ClaimPendingError, CLAIM_MARKER_REORG_MARGIN_EVM, SellerFlow, type SellerNextStep } from "./seller.js";

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
  /** The state directory (run.json, the two parties' flow records and seeds, the venue and note files), as the caller wrote it: a relative path is
   *  resolved against the working directory here, AFTER the key-like check (KR2-1), so a long directory path of the machine is never judged. */
  stateDir: string;
  /** `--yes` only: stop after leg A is locked and recorded (the Seller never claims). */
  stopAfter?: "lock";
  /** `--refund` only: wait for a refund time that has not come instead of reporting it. */
  wait?: boolean;
  env: RehearsalEnv;
}

export const EXIT = Object.freeze({ ok: 0, config: 2, preflight: 3, refused: 4, notYet: 5, audit: 6 });

/** The statuses `examples/audit-export.mjs --expect` is asked for. */
type Outcome = "settled" | "revealed" | "refunded" | "refunded-b";

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
  /**
   * P2R2-PIN-06 (P9 review round 2): the effective `maxLogRange` of the config the run STARTED with (the configured value, else the chain's default; absent where no
   * cap is in force, and in a run.json written before this field existed). P9-4 decision 11: its PRESENCE says the run's claim-log scan was sized for a cap, so `--resume`
   * checks that the config's cap still reaches leg A's window (`logScanWindowTooLong`); a run.json without it is not checked.
   */
  maxLogRange?: number;
}

const RUN_FIELDS = ["v", "swapId", "nonce", "t0Ms", "lockTimeMs", "chainId", "contract", "asset", "amount", "flopAmount", "deadlines", "stopAfter", "buyerDid", "sellerDid", "buyerAccount", "sellerAccount"];
const RUN_OPTIONAL_FIELDS = ["maxLogRange"];
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
  const present = Object.keys(v).filter((key) => !RUN_OPTIONAL_FIELDS.includes(key));
  if (present.sort().join(",") !== [...RUN_FIELDS].sort().join(",") || Object.keys(v).some((key) => !RUN_FIELDS.includes(key) && !RUN_OPTIONAL_FIELDS.includes(key))) {
    return bad("its fields are not the known ones");
  }
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
  if (v.maxLogRange !== undefined && (typeof v.maxLogRange !== "number" || !Number.isSafeInteger(v.maxLogRange) || v.maxLogRange <= 0)) return bad("maxLogRange");
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
    ...(v.maxLogRange === undefined ? {} : { maxLogRange: v.maxLogRange }),
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
    (v.outcome !== "settled" && v.outcome !== "revealed" && v.outcome !== "refunded" && v.outcome !== "refunded-b")
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

/**
 * P9-4 decision 11 (the window check that replaces P2R2-PIN-06's "never smaller than the run started with"): the run's claim-log scan reads at most MAX_LOG_SCAN_CHUNKS
 * calls of `maxLogRange` blocks above its marker, oldest range first, and a claim can land at any time between the lock and leg A's refund time, so what matters is not
 * whether the cap shrank but whether the scan still REACHES leg A's window. `--resume` is refused only when `MAX_LOG_SCAN_CHUNKS` x the new effective cap is below
 * ceil((leg A's refund time - the run's start) / the policy's block time) + the 256-block marker margin (the same measure as the dry run's "log scan reach" row, at the
 * POLICY's block time: 2 s on Base Sepolia, 1 s on anvil, not a fresh measurement). A run.json without the recorded cap (older, or a chain with no cap in force) is not
 * checked, and neither is a config with no cap at all. The refusal names both numbers, and the cap that would do. Exported for its own tests.
 */
export function logScanWindowTooLong(run: RunRecord, config: RehearsalConfig): string | null {
  if (run.maxLogRange === undefined) return null;
  const reach = evmLogScanCoverage(config.rails.evm);
  const cap = effectiveMaxLogRange(config.rails.evm);
  if (reach === undefined || cap === undefined) return null;
  const blockMs = evmLocalPolicyFor(run.chainId).blockTimeMs;
  const windowMs = Math.max(0, run.deadlines.legA.refundAfterMs - run.t0Ms);
  const needBlocks = Math.ceil(windowMs / blockMs) + CLAIM_MARKER_REORG_MARGIN_EVM;
  if (reach >= needBlocks) return null;
  return (
    `maxLogRange is ${cap} in the config: ${MAX_LOG_SCAN_CHUNKS} calls of it read ${reach} blocks above a marker, but leg A's window needs ${needBlocks} blocks ` +
    `(${(windowMs / 60_000).toFixed(1)} min from the run's start to leg A's refund time at ${(blockMs / 1000).toFixed(1)} s a block, plus ${CLAIM_MARKER_REORG_MARGIN_EVM} of marker margin): ` +
    `a claim that lands late in the window could be beyond the scan, so resume with maxLogRange ${Math.ceil(needBlocks / MAX_LOG_SCAN_CHUNKS)} or more`
  );
}

/**
 * P9-4 decision 13: the one sentence a run that ends `revealed` prints (and a repeated `--resume` of it prints again). The swap is settled on the chain, and the bundle's transcript
 * grades it `revealed` because the Seller's reveal frame was posted at or after leg A's refund time, where tclk's machine refuses a reveal. Fixed text: no number, no value.
 */
export const LATE_REVEAL_SENTENCE =
  "the swap is settled on chain (leg A was claimed by the Seller and leg B by the Buyer), and the Seller's reveal frame came after leg A's refund time, so the bundle replays offline to revealed and not settled: the on-chain evidence is the proof, and the transcript's grade says only that the reveal was late";

/**
 * P9-4 decision 13: whether the Seller's reveal frame was stamped at or after leg A's refund time, which is exactly tclk's rule for refusing it (`nowMs >= refundAfterMs`, with the
 * record's own stamp as `nowMs`). The runner then expects `revealed` from the audit. A reveal that is absent (it is only ever absent when a test asks the Seller to skip it) is not late.
 */
export function revealCameAfterWindow(reveal: { readonly timestampMs: number } | undefined, refundAfterMs: number): boolean {
  return reveal !== undefined && reveal.timestampMs >= refundAfterMs;
}

/**
 * P9-4 decision 7 (the rail part: a lock or claim write whose receipt wait timed out is asked about by its hash before it is sent again): the two typed refusals that
 * come of it, `LockPendingError` (the Buyer's lock) and `ClaimPendingError` (the Seller's claim), mean the node still holds that transaction or the endpoint's reads do not
 * show it yet, and that nothing new was signed or sent. The runner does not loop on them (a refusal is preferred to any new outward action): it ends with a fixed sentence
 * that says what to do, in the runner's own terms (the flows' own text says "call lockLegA() again later", which a person cannot do). The text carries no hash and no value.
 * `undefined` for any other error. Exported for its own tests.
 */
export function pendingWriteRefusal(error: unknown): string | undefined {
  if (error instanceof LockPendingError) {
    return "a lock this run sent earlier is not decided yet (the node still holds its transaction, or the endpoint's reads do not show it yet): nothing new was signed or sent; run --resume again in a few minutes";
  }
  if (error instanceof ClaimPendingError) {
    return "a claim this run sent earlier is not decided yet (the node still holds its transaction, or the endpoint's reads do not show it yet): nothing new was signed or sent; run --resume again in a few minutes (if leg A's refund time comes first, --resume and --refund say what to do)";
  }
  return undefined;
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

/**
 * The pre-flight rows a refund does not depend on (the claim's `pending` read, the log scans, the Seller's gas: leg B refunds on paper; and, R1-FUND-01
 * with F2, the Seller's account: the Buyer's refund of leg A and the Seller's refund of leg B (a paper note) use no EVM key of the Seller's, so a Seller
 * key file that is gone or unreadable must not stand between an honest Buyer and its refund).
 */
const REFUND_NOT_NEEDED: ReadonlySet<string> = new Set(["pending", "log range", "seller ETH", "seller account"]);

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
  /**
   * R3-FUND-01, `refundLegA`: the lock was claimed, read FINAL by the flow's own evidence reader, and the Buyer is routed to `learnSecret`
   * (`next` says so from then on). Every one of the flow's four routing refusals ends in this sentence.
   */
  legAClaimed: /call learnSecret\(\) then claimLegB\(\) instead of refundLegA\(\)/,
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

/**
 * R1-FUND-01: whether the Buyer's flow record in `stateDir` holds a lock that landed (its write evidence is recorded). Reads the record only
 * (no seed, no directory, nothing is written). A record that is missing, damaged or without that evidence reads false, so the Buyer's ETH
 * row keeps its full size: the smaller sizing is only ever taken for a lock the record proves.
 */
export async function buyerLockOnRecord(stateDir: string, swapId: string): Promise<boolean> {
  try {
    const key = flowKey("buyer", swapId);
    const bytes = await new FileFlowStore(join(stateDir, "buyer", "flows")).load(key);
    if (bytes === null) return false;
    const record = decodeFlowRecord(bytes, key);
    return record.role === "buyer" && record.lock.evidence !== undefined;
  } catch {
    return false;
  }
}

/**
 * R2-FUND-01: whether the Buyer's flow record in `stateDir` holds the verdict that leg A's lock attempt NEVER LANDED (`lock.neverLanded`: leg A's refund time was
 * final with no lock on the chain, and the escrow refuses every lock from then on). Reads the record only; a missing or damaged record reads false (the
 * ordinary paths then say what they always said).
 */
export async function buyerLockNeverLanded(stateDir: string, swapId: string): Promise<boolean> {
  try {
    const key = flowKey("buyer", swapId);
    const bytes = await new FileFlowStore(join(stateDir, "buyer", "flows")).load(key);
    if (bytes === null) return false;
    const record = decodeFlowRecord(bytes, key);
    return record.role === "buyer" && record.lock.neverLanded === true;
  } catch {
    return false;
  }
}

/**
 * R3-FUND-01: the hash lock of leg A, read from the Buyer's flow record in `stateDir` (`lock.hashLock`). Reads the record only; a missing or damaged record, or one
 * with no hash lock yet, reads `undefined` (the caller then says what it always said).
 */
export async function buyerHashLockOnRecord(stateDir: string, swapId: string): Promise<string | undefined> {
  try {
    const key = flowKey("buyer", swapId);
    const bytes = await new FileFlowStore(join(stateDir, "buyer", "flows")).load(key);
    if (bytes === null) return undefined;
    const record = decodeFlowRecord(bytes, key);
    return record.role === "buyer" ? record.lock.hashLock : undefined;
  } catch {
    return undefined;
  }
}

/** The status byte of `locks(hashLock)` (0 None, 1 Locked, 2 Claimed, 3 Refunded) at `block` (a tag or a 0x block number), read through `rpc`; `null` when the node answers no usable row. */
async function lockStatusAt(rpc: Pick<CapturingRpc, "request">, contract: Address, hashLock: string, block: string): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hashLock)) return null;
  const data = encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", args: [hashLock as Hex] });
  const answer = await rpc.request({ method: "eth_call", params: [{ to: contract, data }, block] });
  if (typeof answer !== "string" || !/^0x[0-9a-fA-F]*$/.test(answer) || answer.length < 66) return null;
  try {
    const row = decodeFunctionResult({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", data: answer as Hex }) as readonly unknown[];
    const status = row[6];
    return typeof status === "number" ? status : null;
  } catch {
    return null;
  }
}

/**
 * R2-FUND-04 (P9 review round 2): what the Seller still has to SEND, which sizes its ETH row in `--resume`. `"nothing"` when its claim already landed: the
 * Seller's own record says so (`claimOutcome` landed), or, when the record is unclear (a claim was attempted and the process died before the outcome was
 * recorded), `locks(hashLock)` reads Claimed at the latest block. Everything else, and any read that fails, is `"claim"`: the full reservation is only ever
 * lifted for a claim the record or the chain proves. Reads only (no seed, no directory, nothing is written).
 */
export async function sellerSendsOnRecord(stateDir: string, rpc: Pick<CapturingRpc, "request">, contract: Address): Promise<SellerSends> {
  try {
    const store = new FileFlowStore(join(stateDir, "seller", "flows"));
    const keys = (await store.list()).filter((key) => key.startsWith("seller:"));
    const only = keys[0];
    if (keys.length !== 1 || only === undefined) return "claim";
    const bytes = await store.load(only);
    if (bytes === null) return "claim";
    const record = decodeFlowRecord(bytes, only);
    if (record.role !== "seller") return "claim";
    if (record.claimOutcome === "landed") return "nothing";
    if (!record.claimAttempted) return "claim";
    return (await lockStatusAt(rpc, contract, record.statement, "latest")) === 2 ? "nothing" : "claim";
  } catch {
    return "claim";
  }
}

type KeyFileField = "buyerKeyFile" | "sellerKeyFile";

/**
 * K1 (P9 review round 1): loads one key file for the runner. A refusal is `<field>: <the loader's fixed problem sentence>` and NEVER the
 * configured path or the loader's own message (which names the path): a person who pasted a key into a key-file field with a slip the
 * config's guard does not catch (a space, a dropped digit, a letter O for a zero) would otherwise see it printed back, in every mode.
 * The loader's group-or-other mode warning (POSIX) is shown the same way, by field name, through `warn` and not through the process's own
 * warning channel (which prints the path). Only an `EvmKeyFileError`'s `problem` is read; any other failure is a fixed sentence.
 */
export async function loadRunnerAccount(
  path: string,
  field: KeyFileField,
  warn: (line: string) => void,
  platform?: NodeJS.Platform,
): Promise<{ account: LocalAccount } | { problem: string }> {
  try {
    const account = await loadEvmLocalAccount(path, {
      warn: () => warn(`${field}: the key file can be read by group or other users; run chmod 600 on it (the key was loaded anyway)`),
      ...(platform === undefined ? {} : { platform }),
    });
    return { account };
  } catch (error) {
    return { problem: `${field}: ${error instanceof EvmKeyFileError ? describeKeyFileProblem(error.problem) : "the key file could not be loaded"}` };
  }
}

async function loadAccounts(config: RehearsalConfig, warn: (line: string) => void): Promise<Accounts> {
  return {
    buyer: await loadRunnerAccount(config.buyerKeyFile, "buyerKeyFile", warn),
    seller: await loadRunnerAccount(config.sellerKeyFile, "sellerKeyFile", warn),
  };
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
  /** The party's EVM account (public). A `--refund` run whose Seller key file does not load still has the address the run recorded. */
  address: Address;
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
  /** Removes the endpoint from a text (K3: a failure text is redacted BEFORE it is cut, so every `describeFailure` call gets this one). */
  redact: (text: string) => string;
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

/** What a wait for finality reads of the world: the config (the pin), the runner's own reads, its clock and sleep, and its log. */
export interface FinalityWorld {
  config: RehearsalConfig;
  env: RehearsalEnv;
  rpc: CapturingRpc;
  log: (line: string) => void;
  pollMs: number;
}

/** What `waitLockFinal` needs to know of the lock when its record holds no block number: its hash lock, and where the run keeps the wait's target. */
export interface RecoveredLock {
  hashLock: string;
  swapId: string;
  stateDir: string;
}

const LOCK_FINAL_FILE = "lockfinal.json";

/** The block a recovered lock is waited for, kept across resumes: the head read at the FIRST wait (the lock landed at or below it). */
async function recoveredTarget(w: FinalityWorld, lock: RecoveredLock): Promise<{ target: bigint; kept: boolean }> {
  const path = join(lock.stateDir, LOCK_FINAL_FILE);
  try {
    const value = JSON.parse(await fsp.readFile(path, "utf8")) as Record<string, unknown> | null;
    if (value !== null && typeof value === "object" && value.v === 1 && value.swapId === lock.swapId && value.hashLock === lock.hashLock && typeof value.target === "string" && /^[0-9]{1,18}$/.test(value.target)) {
      return { target: BigInt(value.target), kept: true };
    }
  } catch {
    // no file, or one that is not this run's: the target is read afresh below (a wait for a later block is only ever longer, never unsafe)
  }
  const target = await blockNumberNow(w.rpc);
  await writeFileDurable(path, `${JSON.stringify({ v: 1, swapId: lock.swapId, hashLock: lock.hashLock, target: target.toString() })}\n`);
  return { target, kept: false };
}

/** Whether `locks(hashLock)` has a row (status other than None) at the FINALIZED block the pin names: the lock is final, whatever block it landed in. Any failure reads false. */
async function lockReadsFinal(w: FinalityWorld, hashLock: string): Promise<boolean> {
  try {
    const finalized = await finalizedNumber(w.rpc, w.config);
    if (finalized === null) return false;
    const status = await lockStatusAt(w.rpc, w.config.rails.evm.contract, hashLock, `0x${finalized.toString(16)}`);
    return status !== null && status !== 0;
  } catch {
    return false;
  }
}

/**
 * The wait for leg A's lock to be final before the Seller's claim. With a block number on record (a lock this run sent and read back) it is the wait for the
 * finalized block to reach that block. R1-FUND-07 (P9 review round 1): a lock RECOVERED from the chain (a lock receipt timeout, a kill between the broadcast and the
 * save, a lagging lookup) has no block number on record, and the wait used to return at once there; the claim loop gave up after 20 re-reads (about 100 s at the
 * default poll), so a finalized lag of 15 to 39 minutes needed many manual --resume runs. R2-FUND-03 (P9 review round 2): that fix waited a whole finalized lag on
 * EVERY resume, even for a lock final for hours or already claimed, ahead of the Seller's claim and the Buyer's leg B claim (a resume within the last lag of a
 * deadline could miss it). So a recovered lock is READ before it is waited for: a row at the finalized block (any status but None, which covers a lock already
 * claimed) is final and the wait returns at once. Only otherwise it waits for the finalized block to pass the head read at the FIRST wait, which is kept in the
 * state directory (`lockfinal.json`, keyed by the swap and the hash lock), so a later resume waits for that same block and never for a newer head; the row is read
 * again at every poll, so a lock that landed below the head is released as soon as the finalized block passes ITS block. Bounded by `waitLimitMs` like every wait.
 */
export async function waitLockFinal(w: FinalityWorld, blockNumber: bigint | undefined, lock: RecoveredLock): Promise<void> {
  if (blockNumber !== undefined) return waitFinalized(w, blockNumber, "lock of leg A");
  if (await lockReadsFinal(w, lock.hashLock)) {
    w.log("the lock of leg A has no block number on record (it was recovered from the chain), and it already reads at the finalized block: it is final, no wait");
    return;
  }
  const { target, kept } = await recoveredTarget(w, lock);
  w.log(
    `the lock of leg A has no block number on record (it was recovered from the chain); it landed at or below the head, block ${target}${kept ? " (kept from the first wait, so that a resume waits for the same block)" : ""}, so waiting until the finalized block passes that`,
  );
  return waitFinalized(w, target, "lock of leg A (recovered: its block is not on record, so the head read at the first wait)", () => lockReadsFinal(w, lock.hashLock));
}

/**
 * Waits (real polling) until the finalized block is at least `minBlock` (or `alsoDone` says so): the transaction mined at or below it is then final. Past
 * `waitLimitMs` it refuses with "run --resume to keep waiting", or with the text `refusal` builds from the seconds waited (R3-FUND-01: the late-claim wait of
 * `--refund` is kept up by running `--refund` again, and `--resume` would only say so).
 */
async function waitFinalized(
  w: FinalityWorld,
  minBlock: bigint | undefined,
  what: string,
  alsoDone?: () => Promise<boolean>,
  refusal?: (waitedSeconds: number) => string,
): Promise<void> {
  if (minBlock === undefined) return;
  const startedMs = w.env.now();
  let lastLogMs = 0;
  for (;;) {
    const finalized = await finalizedNumber(w.rpc, w.config);
    if (finalized !== null && finalized >= minBlock) return;
    if (alsoDone !== undefined && (await alsoDone())) return;
    const elapsed = w.env.now() - startedMs;
    if (elapsed > w.config.waitLimitMs) {
      const seconds = Math.round(elapsed / 1000);
      throw new RunnerRefusal(refusal !== undefined ? refusal(seconds) : `the ${what} (block ${minBlock}) was not final after ${seconds} s (waitLimitMs); run --resume to keep waiting`);
    }
    if (w.env.now() - lastLogMs >= 30_000) {
      w.log(`waiting for the ${what} to be final: block ${minBlock}, the finalized block is ${finalized === null ? "unreadable" : finalized}`);
      lastLogMs = w.env.now();
    }
    await w.env.sleep(w.pollMs);
  }
}

/** Waits (real polling) until the FINALIZED block's own timestamp is at or past `refundAfterMs`, bounded by `waitLimitMs`: only then can a lock that was not seen be ruled out. */
async function waitFinalizedTime(w: FinalityWorld, refundAfterMs: number): Promise<void> {
  const startedMs = w.env.now();
  let lastLogMs = 0;
  for (;;) {
    let stamp: number | null = null;
    try {
      const finalized = await finalizedNumber(w.rpc, w.config);
      if (finalized !== null) {
        const block = (await w.rpc.request({ method: "eth_getBlockByNumber", params: [`0x${finalized.toString(16)}`, false] })) as { timestamp?: unknown } | null;
        if (typeof block?.timestamp === "string" && HEX_QUANTITY.test(block.timestamp)) stamp = Number(BigInt(block.timestamp)) * 1000;
      }
    } catch {
      stamp = null; // an unreadable finalized block is not a final one: keep waiting (bounded)
    }
    if (stamp !== null && stamp >= refundAfterMs) return;
    const elapsed = w.env.now() - startedMs;
    if (elapsed > w.config.waitLimitMs) {
      throw new RunnerRefusal(
        `the finalized block has not reached leg A's refund time ${iso(refundAfterMs)} after ${Math.round(elapsed / 1000)} s (waitLimitMs), so a lock that was not seen cannot be ruled out yet; nothing was sent or recorded; run --refund again to keep waiting`,
      );
    }
    if (w.env.now() - lastLogMs >= 30_000) {
      w.log(`waiting for the finalized block to pass leg A's refund time ${iso(refundAfterMs)}: ${stamp === null ? "the finalized block is unreadable" : `it is at ${iso(stamp)}`}`);
      lastLogMs = w.env.now();
    }
    await w.env.sleep(w.pollMs);
  }
}

/**
 * `--refund`'s Buyer step: `refundLegA()` with the waits a person would otherwise repeat by hand. The refund of a lock that landed is signed and sent, and reads final
 * only once the finalized block passes the one it landed in (waited for, bounded by `waitLimitMs`). R2-FUND-01 (P9 review round 2): a lock ATTEMPT with no evidence is
 * read on the chain first; while no finalized block is at or past leg A's refund time the Buyer says (a typed `RefundNotFinalYetError`) that a lock cannot be ruled
 * out yet, and this loop waits for that finalized block and asks again; once it is, the verdict "never locked" ends the loop with `undefined` (the Buyer has nothing
 * on the chain, and the caller refunds the Seller's leg B).
 *
 * R3-FUND-01 (P9 review round 3): a Seller's claim that was mined within one finality lag of leg A's refund time is not FINAL yet when the Buyer comes to refund. The refund
 * then reverts (the row is Claimed at the latest block) and the flow's own evidence reader, which reads the finalized block, still says Locked, so the revert used to be thrown
 * raw, `next` flipped to `refundLegA`, and both `--refund` and `--resume` stalled for up to a whole finality lag. Now, when the refund fails with anything but the cases
 * above and `locks(hashLock)` reads Claimed at the LATEST block but not yet at the finalized block (two reads, nothing is sent), the loop waits (bounded by `waitLimitMs`) for the finalized block to pass the head
 * and asks `refundLegA` again, so that the FLOW routes on a FINAL claim (it saves that and `next` says `learnSecret`); the run then ends with the claimed-lock refusal that
 * names `--resume`. The read at the latest block only decides to wait: nothing is ever routed on a read that is not final (a claim that a reorg removes after leg A's refund
 * time can never land again, and a Buyer routed away on it would hold a refundable lock `next` no longer names). Past the bound it refuses with "nothing was sent; run
 * --refund again to keep waiting". Every other failure is a real refusal and is thrown.
 */
export async function refundLegAWaiting(w: FinalityWorld, buyer: Pick<BuyerFlow, "refundLegA">, hashLock: string): Promise<RailWriteEvidence | undefined> {
  const startedMs = w.env.now();
  let announced = false;
  for (;;) {
    try {
      return await buyer.refundLegA();
    } catch (error) {
      const message = messageOf(error);
      if (FLOW_MESSAGE.neverLocked.test(message)) return undefined; // leg A was never locked: the Buyer has nothing at stake on chain
      if (error instanceof RefundNotFinalYetError) {
        const elapsed = w.env.now() - startedMs;
        if (elapsed > w.config.waitLimitMs) {
          throw new RunnerRefusal(
            `leg A's lock attempt is not on the chain, and the finalized block has not reached leg A's refund time ${iso(error.refundAfterMs)} after ${Math.round(elapsed / 1000)} s (waitLimitMs), so a lock that was not seen cannot be ruled out yet; nothing was sent or recorded; run --refund again to keep waiting`,
          );
        }
        w.log(`leg A's lock attempt is not on the chain, but a lock cannot be ruled out until the finalized block has passed leg A's refund time ${iso(error.refundAfterMs)}; the refund is not final yet, waiting for that block`);
        await waitFinalizedTime(w, error.refundAfterMs);
        await w.env.sleep(w.pollMs); // the Buyer reads the chain itself: never ask again in a tight loop if its read and this one disagree
        continue;
      }
      if (FLOW_MESSAGE.legAClaimed.test(message)) throw new RunnerRefusal(LEG_A_CLAIMED_REFUSAL); // the flow read the claim FINAL and routed the Buyer to learnSecret
      if (FLOW_MESSAGE.refundUnconfirmed.test(message)) {
        if (w.env.now() - startedMs > w.config.waitLimitMs) throw error;
        // The refund was signed and sent; it reads final only once the finalized block passes the one it landed in. The tip now is above it.
        w.log("the refund of leg A is not final yet; waiting for the finalized block to pass the current head");
        await waitFinalized(w, await blockNumberNow(w.rpc), "refund of leg A");
        continue;
      }
      // R3-FUND-01: any other failure is a real refusal, unless the lock reads Claimed at the latest block and NOT yet at the finalized block: a claim that is not final yet.
      // Wait for it, then ask again. (A claim the finalized block already shows is final: the flow would have routed on it, so this failure is another one and is thrown.)
      if (!(await lateClaimNotFinal(w, hashLock))) throw error;
      const elapsed = w.env.now() - startedMs;
      if (elapsed > w.config.waitLimitMs) throw new RunnerRefusal(LATE_CLAIM_NOT_FINAL(Math.round(elapsed / 1000)));
      if (!announced) {
        w.log(LATE_CLAIM_LOG);
        announced = true;
      }
      await waitFinalized(w, await blockNumberNow(w.rpc), "claim of leg A", undefined, LATE_CLAIM_NOT_FINAL);
      await w.env.sleep(w.pollMs); // the Buyer reads the finalized block by its hash: never ask again in a tight loop if its read and this one disagree
    }
  }
}

/** R3-FUND-01: the one sentence logged while a claim of leg A that is not final yet is waited for. */
const LATE_CLAIM_LOG = "leg A's lock was claimed; waiting for the claim to be final, then --resume finishes the swap";

/** R3-FUND-01: the end of `--refund` once the flow read the claim final and routed the Buyer to `learnSecret`: the refund is refused, and `--resume` is the way on. */
const LEG_A_CLAIMED_REFUSAL = "leg A's lock was claimed and the claim is final, so leg A is not refunded (the contract has paid the Seller); run --resume, which learns the secret, claims leg B and finishes the swap";

/** R3-FUND-01: the late-claim wait ran out of `waitLimitMs`; nothing was sent, and `--refund` waits again from the start. */
const LATE_CLAIM_NOT_FINAL = (waitedSeconds: number): string =>
  `leg A's lock was claimed, but the claim was not final after ${waitedSeconds} s (waitLimitMs); nothing was sent; run --refund again to keep waiting (once the claim is final it says to run --resume)`;

/**
 * R3-FUND-01: what `--resume` says when the Buyer's `next` is `refundLegA` (leg A's refund time has come and the refund path is the way on). Normally "use --refund". When
 * `locks(hashLock)` reads Claimed at the latest block the claim may not be final yet (a refund attempt that was cut short while it waited, or one that reverted before this
 * fix): `--refund` then waits for the claim to be final and hands over to `--resume`, and the text says so. One read, nothing is sent.
 */
export async function refundDoorwayText(w: Pick<FinalityWorld, "config" | "rpc">, hashLock: string | undefined): Promise<string> {
  if (await lockClaimedAtLatest(w, hashLock)) {
    return "leg A's lock was claimed and the claim may not be final yet: run --refund, which waits for the claim to be final, then --resume";
  }
  return "leg A's refund time has come; use --refund";
}

/**
 * R3-FUND-01: a claim of leg A that is not final yet: `locks(hashLock)` reads Claimed at the LATEST block and does not read Claimed at the finalized block. Two reads, nothing is
 * sent; any failure, an unreadable finalized block or a row the node does not answer reads false (the refund's own failure is then thrown as it was). A row that the finalized
 * block already shows Claimed is a FINAL claim: the flow routes on it by itself, so a refund that still fails then fails for another reason (a refusal it gives before any
 * read, an RPC outage) and waiting for the claim would only hold that failure back for a whole `waitLimitMs`.
 */
async function lateClaimNotFinal(w: Pick<FinalityWorld, "config" | "rpc">, hashLock: string): Promise<boolean> {
  try {
    if (!(await lockClaimedAtLatest(w, hashLock))) return false;
    const finalized = await finalizedNumber(w.rpc, w.config);
    if (finalized === null) return false;
    const status = await lockStatusAt(w.rpc, w.config.rails.evm.contract, hashLock, `0x${finalized.toString(16)}`);
    return status !== null && status !== 2;
  } catch {
    return false;
  }
}

/** R3-FUND-01: whether `locks(hashLock)` reads Claimed at the LATEST block. One read, nothing is sent; any failure reads false (the refund's own failure is then thrown as it was). It only decides to WAIT. */
async function lockClaimedAtLatest(w: Pick<FinalityWorld, "config" | "rpc">, hashLock: string | undefined): Promise<boolean> {
  if (hashLock === undefined) return false;
  try {
    return (await lockStatusAt(w.rpc, w.config.rails.evm.contract, hashLock, "latest")) === 2;
  } catch {
    return false;
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
  if (parts.outcome === "revealed") w.log(LATE_REVEAL_SENTENCE);
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
  if (buyerOpen.next === "refundLegA") throw new RunnerRefusal(await refundDoorwayText(w, await buyerHashLockOnRecord(w.stateDir, run.swapId)));
  if (sellerOpen?.next === "refundLegB") throw new RunnerRefusal("leg B's refund has begun; use --refund");
  const buyer = buyerOpen.flow;
  const seller = sellerOpen === null ? newSeller(w) : sellerOpen.flow;
  const buyerAddress = w.buyer.address;
  const sellerAddress = w.seller.address;
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

  await waitLockFinal(w, lockA.writeEvidence.blockNumber, { hashLock: lockA.hashLock, swapId: run.swapId, stateDir: w.stateDir });
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
          `${describeFailure(error, w.redact)}; the Seller's claim window has closed, so no new claim is sent, but a claim this run sent earlier may still be pending and can land until leg A's refund time ${iso(run.deadlines.legA.refundAfterMs)}: once it has come, run --resume first (if that earlier claim landed, --resume finishes the swap), and if --resume stops here again, run --refund (leg A goes back to the Buyer; if the lock was claimed after all, --refund waits for the claim to be final and then tells you to run --resume)`,
        );
      }
      if (!FLOW_MESSAGE.lockNotFinal.test(message) || attempt >= CLAIM_REREAD_ATTEMPTS || w.env.now() - claimStartedMs > w.config.waitLimitMs) throw error;
      log(`the lock does not read final to the evidence reader yet (${describeFailure(error, w.redact)}); asking again (${attempt}/${CLAIM_REREAD_ATTEMPTS})`);
      await w.env.sleep(w.pollMs);
    }
  }
  step("seller", "claimLegA", evidenceTx(claimed.evidence));

  const secret = await buyer.learnSecret();
  step("buyer", "learnSecret", "the secret opens leg A's hash lock");
  await buyer.claimLegB(secret);
  step("buyer", "claimLegB", "paper note");

  await waitFinalized(w, await blockNumberNow(w.rpc), "claim of leg A");
  // P9-4 decision 13: a reveal frame that came after leg A's window (the late-claim path: the claim landed within a finality lag of the refund time, or its frames were posted
  // by a later --resume) is graded `revealed` by the replay; the swap itself is settled on chain. Decided from the frame's own stamp, the machine's own rule.
  const lateReveal = revealCameAfterWindow(claimed.reveal, run.deadlines.legA.refundAfterMs);
  return writeAndAudit(w, {
    outcome: lateReveal ? "revealed" : "settled",
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

  const refundA: RailWriteEvidence | undefined = await refundLegAWaiting(w, buyer, accepted.acceptA.statement);
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
      log(`the lock's own evidence could not be read back (${describeFailure(error, w.redact)}); the summary names its reference only`);
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

/**
 * KR2-1 (P9 review round 2): the two arguments the runner prints back (the config path in its refusals, the state directory in its rows and
 * messages) must not be key material. A key pasted where a path belongs is refused here, BEFORE anything is read, written, sent or printed, with a
 * fixed sentence that names the argument and never its value (the same rule as every config field: `looksLikeKeyMaterial`).
 */
function keyLikeArgument(options: RehearsalOptions): string | undefined {
  if (looksLikeKeyMaterial(options.configPath)) return "the config path";
  if (looksLikeKeyMaterial(options.stateDir)) return "--state-dir";
  return undefined;
}

/** Everything one invocation does. Returns the process exit code; throws nothing. */
export async function runRehearsal(options: RehearsalOptions): Promise<number> {
  const { env } = options;
  let mode: RehearsalMode = options.mode;
  const keyLike = keyLikeArgument(options);
  if (keyLike !== undefined) {
    env.err(
      `rehearsal: ${keyLike} looks like key material (a run of 32 or more hex digits, or a phrase of 11 or more words) and not a path: it must name a file or a directory, never a key; nothing was read, written or sent`,
    );
    return EXIT.config;
  }
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
  const stateDir = resolve(options.stateDir);

  let release: (() => Promise<void>) | undefined;
  try {
    const rpc = new CapturingRpc({ endpoint: evm.endpoint });
    const clock = await makeClock(config, env, rpc).catch((error) => {
      throw new RunnerRefusal(describeFailure(error, redact));
    });
    const log = (line: string): void => out(`[${iso(clock())}] ${line}`);

    if (mode !== "dry") release = await acquireRunLock(stateDir);

    const accounts = await loadAccounts(config, errLine);
    const buyerProblem = "problem" in accounts.buyer ? accounts.buyer.problem : undefined;
    const sellerProblem = "problem" in accounts.seller ? accounts.seller.problem : undefined;
    const fresh = mode === "dry" || mode === "yes";

    // The state of this directory, before anything is written.
    const existingRun = await readRun(stateDir);
    // R2-FUND-01: a Buyer record holding the verdict "leg A's lock attempt never landed" leaves nothing to settle: a --resume of such a run is the refund path (the
    // Seller's leg B is refunded and the bundle replays to refunded-b), never "use --refund" and exit 4. Only a verdict the record holds redirects; nothing else does.
    if (mode === "resume" && existingRun !== null && (await buyerLockNeverLanded(stateDir, existingRun.swapId))) {
      mode = "refund";
      out("--resume: the Buyer's record holds the verdict that leg A's lock attempt never landed (leg A's refund time was final with no lock on the chain), so there is no swap to settle; continuing as --refund: leg B is refunded and the bundle written");
    }
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
      account: LocalAccount | Address,
    ): Promise<{ rail: CounterAssetRail; store: FileFlowStore; identity: Promise<RehearsalIdentity> }> => ({
      // P9-4 decision 10: the write lookup pauses about one block between its re-plans: the policy's block time on Base Sepolia, this poll interval elsewhere (anvil).
      rail: createEvmCounterRail({ config: evm, rpc: new CapturingRpc({ endpoint: evm.endpoint, clock }), account, clock, pollMs: config.pollMs }),
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
      const mismatch = runMatchesConfig(existingRun, config) ?? (mode === "resume" ? logScanWindowTooLong(existingRun, config) : null);
      if (mismatch !== null) throw new RunnerRefusal(`the config no longer matches this run: ${mismatch}`);
      // A finished run is only reported: nothing on the chain or in the state directory is touched again.
      const finished = await readOutcome(stateDir);
      if (finished !== null) {
        const settleOutcome = finished.outcome === "settled" || finished.outcome === "revealed";
        const wanted = mode === "resume" ? settleOutcome : !settleOutcome;
        out(`this run already ended: swap ${finished.swapId} ${finished.outcome}; bundle ${finished.bundle}`);
        if (finished.outcome === "revealed") out(LATE_REVEAL_SENTENCE);
        if (wanted) return EXIT.ok;
        throw new RunnerRefusal(mode === "resume" ? `the run ended as ${finished.outcome}, so there is nothing to resume` : "the run settled, so there is nothing to refund");
      }
    }

    // R1-FUND-01 (P9 review round 1): what the Buyer still has to send sizes its ETH row. Once its approve and lock are spent (--refund, or --resume
    // with a lock on record: the refund is then its only possible write) only the refund is reserved; asking again for the gas already spent
    // could refuse a refund the Buyer can pay, and a resume the delay of which then costs a settle.
    const buyerSends: BuyerSends =
      mode === "refund" || (mode === "resume" && existingRun !== null && (await buyerLockOnRecord(stateDir, existingRun.swapId))) ? "refund" : "approve-lock-refund";

    // R2-FUND-04: what the Seller still has to send sizes its ETH row in --resume (its claim may have landed already); a refund's short Buyer row is a warning.
    const sellerSends: SellerSends = mode === "resume" && existingRun !== null ? await sellerSendsOnRecord(stateDir, rpc, evm.contract as Address) : "claim";

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
      buyerSends,
      sellerSends,
      ...(mode === "refund" ? { buyerEthShort: "warn" as const } : {}),
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

    // From here the runner may write and send. The Buyer's key file loaded (the pre-flight checked it), and so did the Seller's, except in --refund
    // (R1-FUND-01 with F2): a refund uses no EVM key of the Seller's (the Buyer refunds leg A, the Seller refunds leg B, a paper note), so a Seller key
    // file that is gone does not stand between the Buyer and its refund. The Seller's rail is then built on the placeholder address, through which
    // nothing is ever sent (a refund drives no Seller write on the chain), and the address the run recorded stands in for the key file's.
    if (!("account" in accounts.buyer)) throw new RunnerRefusal("a key file did not load");
    const sellerKey = "account" in accounts.seller ? accounts.seller.account : undefined;
    const sellerAddress: Address | undefined = sellerKey !== undefined ? sellerKey.address : existingRun !== null ? (existingRun.sellerAccount as Address) : undefined;
    if (sellerAddress === undefined || (sellerKey === undefined && mode !== "refund")) throw new RunnerRefusal("a key file did not load");
    if (
      existingRun !== null &&
      (existingRun.buyerAccount !== accounts.buyer.account.address.toLowerCase() || (sellerKey !== undefined && existingRun.sellerAccount !== sellerKey.address.toLowerCase()))
    ) {
      throw new RunnerRefusal("the key files now name other accounts than the ones this run started with (the config's buyerKeyFile and sellerKeyFile must be the same two accounts)");
    }
    const buyerParty = await buildParty("buyer", accounts.buyer.account);
    const sellerParty = await buildParty("seller", sellerKey ?? ZERO_ADDRESS);
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
        sellerAccount: sellerAddress.toLowerCase(),
        ...(effectiveMaxLogRange(evm) === undefined ? {} : { maxLogRange: effectiveMaxLogRange(evm) as number }),
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
      buyer: { identity: buyerIdentity, address: accounts.buyer.account.address, rail: buyerParty.rail, store: buyerParty.store },
      seller: { identity: sellerIdentity, address: sellerAddress, rail: sellerParty.rail, store: sellerParty.store },
      run,
      log,
      redact,
      pollMs: config.pollMs,
    };
    log(`${mode === "yes" ? "run" : mode} started: swap ${run.swapId}; buyer ${buyerIdentity.did} account ${accounts.buyer.account.address}; seller ${sellerIdentity.did} account ${sellerAddress}`);
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
    const pending = pendingWriteRefusal(error);
    if (pending !== undefined) {
      errLine(`rehearsal: ${pending}`);
      return EXIT.refused;
    }
    errLine(`rehearsal: refused: ${error instanceof Error ? error.name : "Error"}: ${describeFailure(error, redact)}`);
    return EXIT.refused;
  } finally {
    if (release !== undefined) await release().catch(() => undefined);
  }
}
