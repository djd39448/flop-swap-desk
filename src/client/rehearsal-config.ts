// SPDX-License-Identifier: MIT
//
// P9-6 (handoff/P9-G1-READINESS-SPEC.md, rule 4: "nothing public before Dave"): the config file of the EVM rehearsal runner
// (bin/swap-rehearsal-evm.mjs). One JSON object names everything a rehearsal needs and nothing else:
//
//   {
//     "rails": { "evm": { <an EvmRailConfig: pin, endpoint, contract, assets, contractCodeHash, maxLogRange, ...> } },
//     "buyerKeyFile": "<path>", "sellerKeyFile": "<path>",      // loaded by loadEvmLocalAccount; the keys are never in this file
//     "deadlines": "known-good" | { "legA": {...}, "legB": {...} },
//     "amount": "1000000", "out": "<bundle directory>",
//     "asset": "USDC", "flopAmount": "52070000", "clock": "system", "pollMs": 5000, "waitLimitMs": 7200000
//   }
//
// Every object is CLOSED: a field this build does not know is a refusal that names the field and never echoes its value, so a
// key pasted under a wrong name (or any other typo) cannot ride into a log, the bundle's rails.json or this module's own
// output. The EVM config that reaches the bundle is rebuilt from the known fields only, for the same reason. Relative paths
// are resolved against the config file's directory, so a config and its key files can be moved together.
//
// The endpoint URL is written into the bundle (rails.json, the capture indexes) and into every error text a transport raises,
// so a URL that carries credentials, a query or a fragment is refused here; a key embedded in the PATH of a URL cannot be told
// from a path and is the operator's to avoid (the README says so, and the runner never prints the URL, only its host).
//
// No environment variable is read, no clock, no network: this module only checks data it is given.

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { checkEvmRailConfig, type EvmFinality, type EvmRailConfig } from "../rails/evm-htlc.js";

/** One leg's three deadlines, in minutes after the run's start (t0). */
export interface LegDeadlineMinutes {
  claimByMin: number;
  refundAfterMin: number;
  expiresMin: number;
}

export interface DeadlineMinutes {
  legA: LegDeadlineMinutes;
  legB: LegDeadlineMinutes;
}

/**
 * The deadline set the anvil suites (tests-anvil/client-flows.anvil.test.ts) already run against `EVM_LOCAL_POLICY`, and the one
 * the README documents for the first rehearsals. Leg A is the Base Sepolia USDC leg: claim by +60 min, refund from +90 min;
 * leg B is the FLOP paper leg: claim by +120 min, refund from +180 min. The three rules of SPEC 3.5 hold for it at any lock time
 * up to 45 minutes after t0 (rule 1, a 45-minute reveal window, is the binding one; the pre-flight checks the rules with the real
 * numbers and `EVM_LOCAL_POLICY`, whatever the config says), and the pre-flight also compares the chain's measured `finalized` lag with leg A's claim-by (P9-4 sets the Base Sepolia
 * policy numbers from the 24-hour sample; this set is the one that works with today's policy).
 */
export const KNOWN_GOOD_DEADLINES: DeadlineMinutes = Object.freeze({
  legA: Object.freeze({ claimByMin: 60, refundAfterMin: 90, expiresMin: 30 }),
  legB: Object.freeze({ claimByMin: 120, refundAfterMin: 180, expiresMin: 40 }),
});

/** Every leg-A lock is expected within this many minutes of the run's start; the rules of SPEC 3.5 are checked at that lock time. */
export const LOCK_ESTIMATE_MS = 10 * 60_000;

export type RehearsalClockMode = "system" | "chain";

/** A validated rehearsal config. Every path is absolute; `rails.evm` holds the known fields only. */
export interface RehearsalConfig {
  /** The config file's own path (absolute), for messages. */
  readonly file: string;
  readonly rails: { readonly evm: EvmRailConfig };
  readonly buyerKeyFile: string;
  readonly sellerKeyFile: string;
  readonly deadlines: DeadlineMinutes;
  readonly deadlinesSource: "known-good" | "explicit";
  /** The leg-A amount in the token's minimal units (USDC: 6 decimals), a positive decimal integer string. */
  readonly amount: string;
  /** The key of `rails.evm.assets` the swap moves. */
  readonly asset: string;
  /** The FLOP leg's amount on the paper rail (no value moves). */
  readonly flopAmount: string;
  /** The bundle directory. Must be absent or empty when the bundle is written. */
  readonly out: string;
  /** `system`: the machine clock. `chain`: the machine clock shifted once, at process start, to the chain's own latest block time
   *  (anvil only: a local node whose time a test or rehearsal moved). Refused for any other chain. */
  readonly clock: RehearsalClockMode;
  /** How often a wait polls the chain, in ms. */
  readonly pollMs: number;
  /** The longest one wait for finality may last, in ms. */
  readonly waitLimitMs: number;
}

/** A refused config. The message names the field and the problem, never a value that could be a secret. */
export class RehearsalConfigError extends Error {
  constructor(message: string) {
    super(`rehearsal config: ${message}`);
    this.name = "RehearsalConfigError";
  }
}

const TOP_FIELDS = ["rails", "buyerKeyFile", "sellerKeyFile", "deadlines", "amount", "asset", "flopAmount", "out", "clock", "pollMs", "waitLimitMs"] as const;
const RAILS_FIELDS = ["evm"] as const;
const EVM_FIELDS = ["pin", "endpoint", "contract", "assets", "receiptTimeoutMs", "contractCodeHash", "maxLogRange"] as const;
const PIN_FIELDS = ["chainId", "name", "caip2", "finality"] as const;
const TAG_FINALITY_FIELDS = ["mode", "tag", "fallbackConfirmations"] as const;
const CONFIRMATIONS_FINALITY_FIELDS = ["mode", "confirmations"] as const;
const DEADLINE_FIELDS = ["legA", "legB"] as const;
const LEG_FIELDS = ["claimByMin", "refundAfterMin", "expiresMin"] as const;

const AMOUNT = /^[1-9][0-9]{0,77}$/;
const ASSET_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const ANVIL_CHAIN_ID = 31337;

const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 50;
const MAX_POLL_MS = 60_000;
const DEFAULT_WAIT_LIMIT_MS = 2 * 60 * 60_000;
const MAX_WAIT_LIMIT_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_FLOP_AMOUNT = "52070000";
/** One leg's deadline minutes may not exceed a week: a larger number is a typo for something else. */
const MAX_DEADLINE_MIN = 7 * 24 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Refuses a field the object may not carry. The message names the field (a config key, never its value). */
function closed(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RehearsalConfigError(`${path === "" ? "" : `${path}.`}${safeName(key)} is not a field this runner knows (the config objects are closed; no key, seed or secret belongs in this file)`);
    }
  }
}

/** A field NAME printed back: only a short run of plain characters, so a pasted secret used as a key name is never echoed. */
function safeName(key: string): string {
  return /^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : "<unprintable name>";
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RehearsalConfigError(`${path} must be an object`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") throw new RehearsalConfigError(`${path} must be a non-empty string`);
  return value;
}

function requireInt(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RehearsalConfigError(`${path} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function resolvePath(base: string, value: unknown, path: string): string {
  const text = requireString(value, path);
  return isAbsolute(text) ? resolve(text) : resolve(base, text);
}

/** Rebuilds the EVM config from its known fields only, refusing any other field at every level. */
function cleanEvmConfig(value: unknown): EvmRailConfig {
  const evm = requireObject(value, "rails.evm");
  closed(evm, EVM_FIELDS, "rails.evm");
  const pin = requireObject(evm.pin, "rails.evm.pin");
  closed(pin, PIN_FIELDS, "rails.evm.pin");
  const finality = requireObject(pin.finality, "rails.evm.pin.finality");
  closed(finality, finality.mode === "confirmations" ? CONFIRMATIONS_FINALITY_FIELDS : TAG_FINALITY_FIELDS, "rails.evm.pin.finality");
  const assets = requireObject(evm.assets, "rails.evm.assets");

  const cleanFinality = (finality.mode === "confirmations"
    ? { mode: "confirmations", confirmations: finality.confirmations }
    : {
        mode: finality.mode,
        tag: finality.tag,
        ...(finality.fallbackConfirmations === undefined ? {} : { fallbackConfirmations: finality.fallbackConfirmations }),
      }) as unknown as EvmFinality;
  const candidate = {
    pin: { chainId: pin.chainId, name: pin.name, caip2: pin.caip2, finality: cleanFinality },
    endpoint: evm.endpoint,
    contract: evm.contract,
    assets: Object.fromEntries(Object.entries(assets)),
    ...(evm.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: evm.receiptTimeoutMs }),
    ...(evm.contractCodeHash === undefined ? {} : { contractCodeHash: evm.contractCodeHash }),
    ...(evm.maxLogRange === undefined ? {} : { maxLogRange: evm.maxLogRange }),
  };
  const checked = checkEvmRailConfig(candidate);
  if (!checked.ok) throw new RehearsalConfigError(`rails.evm: ${checked.reason}`);
  assertEndpoint(checked.config.endpoint);
  return checked.config;
}

/** The endpoint is written into the bundle and into transport error texts: no credentials, query or fragment may ride in it. */
function assertEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new RehearsalConfigError("rails.evm.endpoint is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RehearsalConfigError("rails.evm.endpoint must be an http or https URL");
  if (url.username !== "" || url.password !== "") {
    throw new RehearsalConfigError("rails.evm.endpoint must not carry credentials (user or password): the URL is written into the bundle's rails.json");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new RehearsalConfigError("rails.evm.endpoint must not carry a query or a fragment: the URL is written into the bundle's rails.json");
  }
}

function parseDeadlines(value: unknown): { deadlines: DeadlineMinutes; source: "known-good" | "explicit" } {
  if (value === undefined || value === "known-good") return { deadlines: KNOWN_GOOD_DEADLINES, source: "known-good" };
  const set = requireObject(value, 'deadlines (the string "known-good" or an object)');
  closed(set, DEADLINE_FIELDS, "deadlines");
  const leg = (raw: unknown, path: string): LegDeadlineMinutes => {
    const obj = requireObject(raw, path);
    closed(obj, LEG_FIELDS, path);
    const claimByMin = requireInt(obj.claimByMin, `${path}.claimByMin`, 1, MAX_DEADLINE_MIN);
    const refundAfterMin = requireInt(obj.refundAfterMin, `${path}.refundAfterMin`, 1, MAX_DEADLINE_MIN);
    const expiresMin = requireInt(obj.expiresMin, `${path}.expiresMin`, 1, MAX_DEADLINE_MIN);
    if (claimByMin >= refundAfterMin) throw new RehearsalConfigError(`${path}: claimByMin must be before refundAfterMin`);
    return { claimByMin, refundAfterMin, expiresMin };
  };
  return { deadlines: { legA: leg(set.legA, "deadlines.legA"), legB: leg(set.legB, "deadlines.legB") }, source: "explicit" };
}

/**
 * Validates a parsed config. `value` is untrusted data (a JSON file); `baseDir` is where relative paths start. Throws a
 * `RehearsalConfigError` for the first problem. Nothing is read from disk here (key files are loaded by the runner).
 */
export function parseRehearsalConfig(value: unknown, baseDir: string, file = ""): RehearsalConfig {
  const top = requireObject(value, "the config");
  closed(top, TOP_FIELDS, "");
  const rails = requireObject(top.rails, "rails");
  closed(rails, RAILS_FIELDS, "rails");
  const evm = cleanEvmConfig(rails.evm);

  const buyerKeyFile = resolvePath(baseDir, top.buyerKeyFile, "buyerKeyFile");
  const sellerKeyFile = resolvePath(baseDir, top.sellerKeyFile, "sellerKeyFile");
  const samePath = process.platform === "win32" ? buyerKeyFile.toLowerCase() === sellerKeyFile.toLowerCase() : buyerKeyFile === sellerKeyFile;
  if (samePath) throw new RehearsalConfigError("buyerKeyFile and sellerKeyFile name the same file; a swap needs two different accounts");

  const { deadlines, source } = parseDeadlines(top.deadlines);

  const amount = requireString(top.amount, "amount");
  if (!AMOUNT.test(amount)) throw new RehearsalConfigError("amount must be a positive decimal integer string in the token's minimal units");
  const asset = top.asset === undefined ? "USDC" : requireString(top.asset, "asset");
  if (!ASSET_NAME.test(asset)) throw new RehearsalConfigError("asset must be a short plain name (letters, digits, - and _)");
  if (evm.assets[asset] === undefined) throw new RehearsalConfigError(`asset "${asset}" is not a key of rails.evm.assets`);
  const flopAmount = top.flopAmount === undefined ? DEFAULT_FLOP_AMOUNT : requireString(top.flopAmount, "flopAmount");
  if (!AMOUNT.test(flopAmount)) throw new RehearsalConfigError("flopAmount must be a positive decimal integer string");

  const out = resolvePath(baseDir, top.out, "out");

  const clock = top.clock === undefined ? "system" : top.clock;
  if (clock !== "system" && clock !== "chain") throw new RehearsalConfigError('clock must be "system" or "chain"');
  if (clock === "chain" && evm.pin.chainId !== ANVIL_CHAIN_ID) {
    throw new RehearsalConfigError('clock "chain" is for a local anvil node only (chain id 31337); a public chain always uses the system clock');
  }

  const pollMs = top.pollMs === undefined ? DEFAULT_POLL_MS : requireInt(top.pollMs, "pollMs", MIN_POLL_MS, MAX_POLL_MS);
  const waitLimitMs = top.waitLimitMs === undefined ? DEFAULT_WAIT_LIMIT_MS : requireInt(top.waitLimitMs, "waitLimitMs", pollMs, MAX_WAIT_LIMIT_MS);

  return Object.freeze({
    file,
    rails: Object.freeze({ evm }),
    buyerKeyFile,
    sellerKeyFile,
    deadlines,
    deadlinesSource: source,
    amount,
    asset,
    flopAmount,
    out,
    clock,
    pollMs,
    waitLimitMs,
  });
}

/** Reads and validates the config file at `path`. A file that is not JSON is refused without echoing any of its content. */
export async function loadRehearsalConfig(path: string): Promise<RehearsalConfig> {
  const file = resolve(path);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new RehearsalConfigError(`cannot read the config file ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RehearsalConfigError(`${file} is not valid JSON`);
  }
  return parseRehearsalConfig(parsed, dirname(file), file);
}

/** The deadlines of one run in absolute milliseconds: the config's minutes laid on the run's start. */
export interface RunDeadlines {
  legA: { claimByMs: number; refundAfterMs: number; expiresMs: number };
  legB: { claimByMs: number; refundAfterMs: number; expiresMs: number };
}

export function absoluteDeadlines(minutes: DeadlineMinutes, t0Ms: number): RunDeadlines {
  const leg = (m: LegDeadlineMinutes): RunDeadlines["legA"] => ({
    claimByMs: t0Ms + m.claimByMin * 60_000,
    refundAfterMs: t0Ms + m.refundAfterMin * 60_000,
    expiresMs: t0Ms + m.expiresMin * 60_000,
  });
  return { legA: leg(minutes.legA), legB: leg(minutes.legB) };
}

/** The host of the endpoint, for output: the URL itself is never printed (a path can carry a key). */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "<invalid url>";
  }
}
