// SPDX-License-Identifier: MIT
//
// Pure evidence adapter for the Solana HTLC rail (P6-SOL-SPEC.md section 3): the Solana twin of
// `near-evidence.ts`, carrying every round-1 rule of the NEAR and Bitcoin readers from the start
// (handoff/P5-NEAR-FIXES.md, P5-NEAR-SQUAT-FIX.md). `solEvidence` is pure and synchronous over an
// already-captured `SolCapture`; `captureSolLeg` is the one function that touches the network (through the
// caller's own `CapturingRpc`) and never throws. Neither ever throws for a chain-state reason.
//
// The fixed read sequence, always in this order (positions are part of the binding):
//   1 getGenesisHash          the chain identity (the pin's own genesis rule, shared with `connect()`)
//   2 getSlot finalized       the slot every later read must have reached: `minContextSlot`
//   3 getAccountInfo escrow   PDA ["htlc", payer, hash lock]
//   4 getAccountInfo vault    PDA ["vault", escrow]
//   5 getAccountInfo program  executable, upgradeable loader, ProgramData address derived
//   6 getAccountInfo programdata   the reviewed .so bytes (hash) and the upgrade authority
//   7 getAccountInfo payee token account   (only when the payee has an account line): the associated token
//     account the claim pays; the Solana twin of NEAR's storage_balance_of read.
// Every account read is `commitment: "finalized"` with `minContextSlot` = the slot of read 2, and every
// response's `context.slot` is checked: it must reach that slot, and all account reads must share ONE
// context slot (one finalized view of the chain; a read pair that straddled two slots is never mixed).
// The capture retries a straddled sequence a few times and records only the last attempt.
//
// What is bound, and how (the F2 splice, A1 tamper and E6 index rules): every request id is
// "<ref>:<checkedAtMs>:<nonce>:<position>" (a per-capture random nonce, so an exchange spliced in from a
// donor capture, or moved to another position, is refused); every exchange's request body must parse to
// exactly the method and params the index claims, and the params must be exactly what THIS reader would
// have sent (the derived account, finalized, the slot); responses are read from the wire bytes whose
// sha256 the index names. The captured config is validated and must equal the auditor's on chain, program,
// program hash and mint (a capture can never carry a weaker trust anchor than the auditor's own), and the
// index's top-level pin/caip2/endpoint must agree with it (E6).
//
// What a verdict needs (H1): a `locked` rail observation is attached ONLY when the escrow's payer (from the
// ref, and the payer account line when there is one), payee (the payee account line), mint, amount and both
// times all match, the vault (owned by the escrow, for the mint, not frozen) holds at least the amount, and
// the payee's token account exists with the right owner and mint and is not frozen (the payout can land).
// The program must be the pinned one: executable, upgradeable-loader owned, ProgramData hash equal to
// `programHash` (exact or with trailing zero padding stripped), upgrade authority None or the all-zero
// address only (contracts-sol/README.md, "Upgrade-authority rule the evidence reader inherits").
//
// Not carried over from NEAR: a "revealed but unpaid" state. A Solana claim is atomic (a failed payout
// reverts the state change), so an escrow is Locked (revealed = 0), Claimed (revealed, preimage stored) or
// Refunded; anything else (a Locked escrow that already holds a preimage, a Claimed one whose preimage does
// not open the hash lock) is an impossible state and fails closed (`railVerified: null`). The escrow's
// `claim_by_ms` is client-enforced only and is compared with the terms like every other field, never read as
// a bound on disclosure.

import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LockTerms } from "@flop-labs/tclk";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

import { SOL_RAIL_ID } from "./custom-rails.js";
import { readCapture, RpcCaptureError, type CapturingRpc, type Exchange } from "./rpc-capture.js";
import {
  SOL_ASSET_ID,
  SOL_ESCROW_LEN,
  checkSolRailConfig,
  decodeEscrow,
  escrowAddress,
  parseSolRef,
  solGenesisProblem,
  vaultAddress,
  type SolEscrowView,
  type SolRailConfig,
} from "./sol-htlc.js";
import { BPF_LOADER_UPGRADEABLE_ID, TOKEN_PROGRAM_ID, associatedTokenAddress, decodeTokenAccount } from "./sol-spl.js";
import { bytesEqual, findProgramAddress, isValidPubkeyBase58, pubkeyFromBase58, pubkeyToBase58 } from "./sol-tx.js";
import type { LockEvidence, RailObservation } from "../types.js";

export { SOL_RAIL_ID };

const SHA256_HEX_LOWER = /^[0-9a-f]{64}$/;
/** tclk's `CONTRACT_ID` shape: `0x` + 64 lowercase hex, already filename-safe. */
const LEG_CONTRACT_SHAPE = /^0x[0-9a-f]{64}$/;

/** How many times a capture retries a read sequence whose account reads straddled two finalized slots. */
export const SOL_CAPTURE_ATTEMPTS = 3;

/** Hoisted so it can run before any network call: `terms.lock` must be `"hash"`, `ref` must be a
 *  well-formed Solana ref (`0x<hash lock>:<payer>`), and its hash-lock part must equal `terms.statement`. */
export function solLockRefInvalid(terms: LockTerms, ref: string): boolean {
  const parsed = parseSolRef(ref);
  return terms.lock !== "hash" || parsed === null || parsed.hashLock !== terms.statement;
}

export interface SolCaptureIndexExchange {
  method: string;
  params: unknown;
  requestBody: string;
  responseSha256: string;
  atMs: number;
}

/** `raw/sol/<hashLock>/<legContract>/<iso-stamp>.json`. */
export interface SolCaptureIndex {
  v: 1;
  rail: string;
  ref: string;
  pin: string;
  caip2: string;
  endpoint: string;
  checkedAtMs: number;
  /** The full config this capture was taken under (frozen at capture time). */
  config: SolRailConfig;
  /** Minted once per capture attempt; every exchange id is namespaced with it. */
  nonce: string;
  /** Set when the capture did not run to completion (a transport failure). Absent for a completed read. */
  error?: string;
  exchanges: SolCaptureIndexExchange[];
}

export interface SolCapture {
  index: SolCaptureIndex;
  bytes: ReadonlyMap<string, Uint8Array | null>;
}

/** The leg's resolved wallet addresses (base58) from the account lines (`resolveSolAccounts`). `payee`
 *  also decides whether `captureSolLeg` reads the payee's token account. */
export interface SolAccounts {
  payee?: string;
  payer?: string;
}

export interface SolEvidenceInput {
  terms: LockTerms;
  config: SolRailConfig;
  accounts: SolAccounts;
  capture: SolCapture;
}

export interface SolEvidenceResult {
  lock: LockEvidence;
  rail?: RailObservation;
}

// -- the read plan (shared by the capture and the reader) ----------------------------------------------------

interface ReadPlan {
  escrow: string;
  vault: string;
  program: string;
  programData: string;
  payeeToken: string | null;
}

/** Derives every account this leg's evidence reads; throws only for an input that is not a valid address. */
function readPlan(config: SolRailConfig, ref: { hashLock: string; payer: string }, payee: string | undefined): ReadPlan {
  const escrow = escrowAddress(config.programId, ref.payer, ref.hashLock).address;
  const vault = vaultAddress(config.programId, escrow).address;
  const programData = findProgramAddress([pubkeyFromBase58(config.programId)], pubkeyFromBase58(BPF_LOADER_UPGRADEABLE_ID)).address;
  const payeeToken = payee === undefined ? null : pubkeyToBase58(associatedTokenAddress(pubkeyFromBase58(payee), pubkeyFromBase58(config.assets.USDC)));
  return { escrow: pubkeyToBase58(escrow), vault: pubkeyToBase58(vault), program: config.programId, programData: pubkeyToBase58(programData), payeeToken };
}

/** The params of one account read, in the one key order both the capture and the reader use. */
function accountReadParams(key: string, slot: number): unknown[] {
  return [key, { encoding: "base64", commitment: "finalized", minContextSlot: slot }];
}

const SLOT_PARAMS: unknown[] = [{ commitment: "finalized" }];

// -- binding (the NEAR/EVM bindExchange, adapted to positions) -------------------------------------------------

interface ParsedRequest {
  id: number | string;
  method: string;
  params: unknown;
}

function parseRequestBody(exchange: SolCaptureIndexExchange): ParsedRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exchange.requestBody);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if ((typeof obj.id !== "number" && typeof obj.id !== "string") || typeof obj.method !== "string") return null;
  return { id: obj.id, method: obj.method, params: obj.params };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type BoundExchange =
  | { kind: "missing"; reason: string }
  | { kind: "error" }
  | { kind: "bound"; value: unknown };

/** Authenticates the exchange at `position` (0-based): its request body really is the request the index
 *  claims, that request is exactly `expectedMethod`/`expectedParams`, its id is this capture's id for this
 *  position, and the response bytes (re-hashed by the loader) answer that id. A JSON-RPC error reply is a
 *  bound "error"; anything untrustworthy is "missing". */
function bindExchange(capture: SolCapture, position: number, expectedMethod: string, expectedParams: unknown, label: string): BoundExchange {
  const exchange = capture.index.exchanges[position];
  if (exchange === undefined || exchange.method !== expectedMethod) return { kind: "missing", reason: `missing/tampered capture: no ${label} exchange` };
  const request = parseRequestBody(exchange);
  if (request === null) return { kind: "missing", reason: `missing/tampered capture: ${label} (malformed request)` };
  if (request.method !== exchange.method || !sameJson(request.params, exchange.params)) {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (request does not match its own recorded method/params)` };
  }
  if (!sameJson(request.params, expectedParams)) {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (the request is not the read this reader requires)` };
  }
  const expectedId = `${capture.index.ref}:${capture.index.checkedAtMs}:${capture.index.nonce}:${position + 1}`;
  if (request.id !== expectedId) {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (id is not this capture's ref/checkedAtMs/nonce/position)` };
  }
  const bytes = capture.bytes.get(exchange.responseSha256);
  if (bytes === undefined || bytes === null) return { kind: "missing", reason: `missing/tampered capture: ${label}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (undecodable)` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "missing", reason: `missing/tampered capture: ${label} (not a JSON-RPC object)` };
  }
  const envelope = parsed as { id?: unknown; result?: unknown; error?: unknown };
  if (envelope.id !== request.id) return { kind: "missing", reason: `missing/tampered capture: ${label} (response id does not match its request)` };
  if (envelope.error !== undefined && envelope.error !== null) return { kind: "error" };
  return { kind: "bound", value: envelope.result };
}

// -- wire decoding ------------------------------------------------------------------------------------------

interface WireAccount {
  lamports: number;
  owner: string;
  data: Uint8Array;
  executable: boolean;
}

/** `{ context: { slot }, value: null | { lamports, owner, data: [base64, "base64"], executable } }`. */
function decodeAccountRead(value: unknown): { slot: number; account: WireAccount | null } | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { context?: unknown; value?: unknown };
  if (v.context === null || typeof v.context !== "object") return null;
  const slot = (v.context as { slot?: unknown }).slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) return null;
  if (v.value === null) return { slot, account: null };
  if (v.value === undefined || typeof v.value !== "object" || Array.isArray(v.value)) return null;
  const a = v.value as { lamports?: unknown; owner?: unknown; data?: unknown; executable?: unknown };
  if (typeof a.lamports !== "number" || typeof a.owner !== "string" || !isValidPubkeyBase58(a.owner)) return null;
  if (!Array.isArray(a.data) || a.data.length !== 2 || typeof a.data[0] !== "string" || a.data[1] !== "base64") return null;
  if (typeof a.executable !== "boolean") return null;
  let data: Uint8Array;
  try {
    data = base64.decode(a.data[0]);
  } catch {
    return null;
  }
  return { slot, account: { lamports: a.lamports, owner: a.owner, data, executable: a.executable } };
}

function tokenAccountProblem(account: WireAccount | null, mint: Uint8Array, owner: Uint8Array): string | null {
  if (account === null) return "does not exist";
  if (account.owner !== TOKEN_PROGRAM_ID) return "is not owned by the classic token program";
  let token;
  try {
    token = decodeTokenAccount(account.data);
  } catch (error) {
    return error instanceof Error ? error.message : "is not a token account";
  }
  if (token.state === "uninitialized") return "is not initialised";
  if (token.state === "frozen") return "is frozen";
  if (!bytesEqual(token.mint, mint)) return "is for a different mint";
  if (!bytesEqual(token.owner, owner)) return "is owned by a different wallet";
  return null;
}

function amountsEqual(onChain: string, expected: string): boolean {
  try {
    return BigInt(onChain) === BigInt(expected);
  } catch {
    return false;
  }
}

function preimageOpensHashLock(preimageHex0x: string, hashLock0x: string): boolean {
  try {
    return bytesEqual(sha256(hexToBytes(preimageHex0x.slice(2))), hexToBytes(hashLock0x.slice(2)));
  } catch {
    return false;
  }
}

/** The program's own checks, from the two account reads: `null` when it is the pinned, immutable program. */
function programProblem(config: SolRailConfig, program: WireAccount | null, programData: WireAccount | null, expectedProgramData: string): string | null {
  if (program === null) return "the program account does not exist";
  if (!program.executable) return "the program account is not executable";
  if (program.owner !== BPF_LOADER_UPGRADEABLE_ID) return "the program is not owned by the upgradeable loader";
  if (program.data.length !== 36 || new DataView(program.data.buffer, program.data.byteOffset).getUint32(0, true) !== 2) {
    return "the program account is not a Program{programdata_address}";
  }
  if (pubkeyToBase58(program.data.slice(4, 36)) !== expectedProgramData) return "the program's ProgramData address is not the one derived for it";
  if (programData === null) return "the ProgramData account does not exist";
  if (programData.owner !== BPF_LOADER_UPGRADEABLE_ID) return "the ProgramData account is not owned by the upgradeable loader";
  const d = programData.data;
  if (d.length < 45 || new DataView(d.buffer, d.byteOffset).getUint32(0, true) !== 3) return "the ProgramData account is malformed";
  const authorityTag = d[12];
  if (authorityTag === 1) {
    if (!d.slice(13, 45).every((byte) => byte === 0)) return "the program has an upgrade authority (only None or the all-zero address is accepted)";
  } else if (authorityTag !== 0) {
    return "the ProgramData upgrade-authority option is malformed";
  }
  const elf = d.slice(45);
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end -= 1;
  const exact = bytesToHex(sha256(elf));
  const trimmed = bytesToHex(sha256(elf.slice(0, end)));
  if (exact !== config.programHash && trimmed !== config.programHash) return "the ProgramData hash does not match the pinned programHash";
  return null;
}

function firstFieldMismatch(args: { view: SolEscrowView; payee: string; payer?: string; mint: string; terms: LockTerms }): string | null {
  const { view, payee, payer, mint, terms } = args;
  if (view.payee !== payee) return "sol-htlc: on-chain payee differs from the payee account line";
  if (view.mint !== mint) return "sol-htlc: on-chain mint differs from the configured USDC mint";
  if (!amountsEqual(view.amount, terms.amount)) return "sol-htlc: on-chain amount differs from terms";
  if (view.claimByMs !== terms.claimByMs) return "sol-htlc: on-chain claimByMs differs from terms";
  if (view.refundAfterMs !== terms.refundAfterMs) return "sol-htlc: on-chain refundAfterMs differs from terms";
  if (payer !== undefined && view.payer !== payer) return "sol-htlc: on-chain payer differs from the payer account line";
  return null;
}

// -- the pure decoder ---------------------------------------------------------------------------------------

/**
 * Turn one captured read sequence into evidence for `terms`/`accounts`. Pure, synchronous and total: any
 * unexpected condition is a `railVerified: null` with its reason, never a throw.
 */
export function solEvidence(input: SolEvidenceInput): SolEvidenceResult {
  try {
    return decide(input);
  } catch (error) {
    const { terms, capture } = input;
    return {
      lock: {
        rail: SOL_RAIL_ID,
        ref: String(capture?.index?.ref),
        terms,
        railVerified: null,
        checkedAtMs: Number(capture?.index?.checkedAtMs),
        reason: `sol-htlc: evidence could not be decoded (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}

function decide(input: SolEvidenceInput): SolEvidenceResult {
  const { terms, config, accounts, capture } = input;
  const checkedAtMs = capture.index.checkedAtMs;
  const raw = capture.index.exchanges.map((exchange) => exchange.responseSha256);
  const base = { rail: SOL_RAIL_ID, ref: capture.index.ref, terms, checkedAtMs, endpoint: config.endpoint, raw };
  const unverified = (reason: string, extra: { finalizedRef?: string } = {}): SolEvidenceResult => ({ lock: { ...base, ...extra, railVerified: null, reason } });

  // F1: this capture's own attempt did not run to completion.
  if (capture.index.error !== undefined) return unverified(`sol-htlc: chain read did not complete: ${capture.index.error}`);

  if (solLockRefInvalid(terms, capture.index.ref)) {
    return { lock: { ...base, railVerified: false, reason: 'sol-htlc: ref/lock mismatch (ref must be 0x<hash lock>:<payer> with the hash lock equal to terms.statement, and lock must be "hash")' } };
  }
  const ref = parseSolRef(capture.index.ref);
  if (ref === null) return unverified("sol-htlc: malformed ref");

  // K3: this rail only ever settles USDC.
  if (terms.asset !== SOL_ASSET_ID) {
    return { lock: { ...base, railVerified: false, reason: `sol-htlc: leg asset "${terms.asset}" does not match this rail's own asset "${SOL_ASSET_ID}" (K3)` } };
  }

  if (capture.index.rail !== SOL_RAIL_ID) return unverified("sol-htlc: the capture is not a sol-htlc capture (tampered rail field)");

  // A4/D3: the auditor's own config must be valid, the capture must carry a valid config, and the two must
  // agree on everything that anchors trust: chain, program, program hash, mint.
  const auditorCheck = checkSolRailConfig(config);
  if (!auditorCheck.ok) return unverified(`sol-htlc: the auditor's own config is invalid: ${auditorCheck.reason}`);
  const capturedCheck = checkSolRailConfig(capture.index.config);
  if (!capturedCheck.ok) return unverified(`sol-htlc: capture's own config is invalid (A4/D3): ${capturedCheck.reason}`);
  const captured = capturedCheck.config;
  const trusted = auditorCheck.config;
  if (
    captured.pin.caip2 !== trusted.pin.caip2 ||
    captured.pin.name !== trusted.pin.name ||
    captured.pin.commitment !== trusted.pin.commitment ||
    captured.programId !== trusted.programId ||
    captured.programHash !== trusted.programHash ||
    captured.assets.USDC !== trusted.assets.USDC
  ) {
    return unverified("sol-htlc: capture was taken under a different rail config (D3)");
  }
  // E6: the index's own top-level fields must agree with the embedded config. The filename stamp is not
  // bound (a reader is handed only the parsed index): a documented honesty limit.
  if (capture.index.pin !== captured.pin.name || capture.index.caip2 !== captured.pin.caip2 || capture.index.endpoint !== captured.endpoint) {
    return unverified("sol-htlc: capture's own top-level pin/caip2/endpoint fields disagree with its embedded config (E6, tampered index)");
  }
  const endpointFor = captured.endpoint;

  if (accounts.payee !== undefined && !isValidPubkeyBase58(accounts.payee)) return unverified("sol-htlc: the payee account line is not a valid address");
  if (accounts.payer !== undefined && !isValidPubkeyBase58(accounts.payer)) return unverified("sol-htlc: the payer account line is not a valid address");
  // The payer account line, when there is one, must be the payer the ref names (a lock frame's ref is
  // authenticated by its sender; a line that disagrees is a different party's claim).
  if (accounts.payer !== undefined && accounts.payer !== ref.payer) {
    return { lock: { ...base, endpoint: endpointFor, railVerified: false, reason: "sol-htlc: the payer account line differs from the payer named in the ref" } };
  }

  const plan = readPlan(trusted, ref, accounts.payee);
  const wantPayeeRead = plan.payeeToken !== null;
  const end = (reason: string, extra: { finalizedRef?: string } = {}): SolEvidenceResult => ({ lock: { ...base, endpoint: endpointFor, ...extra, railVerified: null, reason } });

  // Position 0: genesis.
  const genesis = bindExchange(capture, 0, "getGenesisHash", [], "getGenesisHash");
  if (genesis.kind === "missing") return end(genesis.reason);
  if (genesis.kind === "error") return end("rpc rejected getGenesisHash");
  if (typeof genesis.value !== "string" || genesis.value === "") return end("sol-htlc: malformed getGenesisHash result");
  const genesisProblem = solGenesisProblem(trusted.pin, genesis.value);
  if (genesisProblem !== null) return end(genesisProblem);

  // Position 1: the finalized slot every later read must reach.
  const slotRead = bindExchange(capture, 1, "getSlot", SLOT_PARAMS, "getSlot");
  if (slotRead.kind === "missing") return end(slotRead.reason);
  if (slotRead.kind === "error") return end("rpc rejected getSlot(finalized)");
  const minSlot = slotRead.value;
  if (typeof minSlot !== "number" || !Number.isSafeInteger(minSlot) || minSlot < 0) return end("sol-htlc: malformed getSlot result");

  // Positions 2..: the account reads.
  const labels: Array<[string, string]> = [
    ["escrow", plan.escrow],
    ["vault", plan.vault],
    ["program", plan.program],
    ["programdata", plan.programData],
  ];
  if (plan.payeeToken !== null) labels.push(["payee token account", plan.payeeToken]);
  const reads: Array<{ slot: number; account: WireAccount | null }> = [];
  for (let i = 0; i < labels.length; i += 1) {
    const [label, key] = labels[i] as [string, string];
    const bound = bindExchange(capture, 2 + i, "getAccountInfo", accountReadParams(key, minSlot), `getAccountInfo(${label})`);
    if (bound.kind === "missing") return end(bound.reason);
    if (bound.kind === "error") return end(`rpc rejected getAccountInfo(${label})`);
    const decoded = decodeAccountRead(bound.value);
    if (decoded === null) return end(`sol-htlc: malformed getAccountInfo(${label}) result`);
    if (decoded.slot < minSlot) return end(`sol-htlc: the ${label} read is from slot ${decoded.slot}, before the finalized slot ${minSlot} it was pinned to (minContextSlot not honoured)`);
    reads.push(decoded);
  }
  if (capture.index.exchanges.length !== 2 + labels.length) return end("missing/tampered capture: unexpected extra exchanges");
  const readSlot = (reads[0] as { slot: number }).slot;
  if (reads.some((r) => r.slot !== readSlot)) return end("sol-htlc: the account reads do not share one finalized context slot (a mixed view is never trusted)");
  const finalizedRef = `${trusted.pin.name}:final:${readSlot}`;
  const fin = { finalizedRef };
  const [escrowRead, vaultRead, programRead, programDataRead] = reads as [
    { slot: number; account: WireAccount | null },
    { slot: number; account: WireAccount | null },
    { slot: number; account: WireAccount | null },
    { slot: number; account: WireAccount | null },
  ];
  const payeeTokenRead = wantPayeeRead ? (reads[4] as { slot: number; account: WireAccount | null }) : undefined;

  // The trust anchor: this is the program the auditor pinned, and it cannot be changed.
  const pProblem = programProblem(trusted, programRead.account, programDataRead.account, plan.programData);
  if (pProblem !== null) return end(`sol-htlc: ${pProblem}`, fin);

  // The escrow.
  const escrowAccount = escrowRead.account;
  if (escrowAccount === null) return end("sol-htlc: no lock at the finalized view", fin);
  if (escrowAccount.owner !== trusted.programId) return end("sol-htlc: the escrow address is not owned by the HTLC program (no lock at the finalized view)", fin);
  if (escrowAccount.data.length !== SOL_ESCROW_LEN) return end(`sol-htlc: malformed escrow account (${escrowAccount.data.length} bytes)`, fin);
  let view: SolEscrowView;
  try {
    view = decodeEscrow(escrowAccount.data);
  } catch (error) {
    return end(`sol-htlc: malformed escrow account (${error instanceof Error ? error.message : "undecodable"})`, fin);
  }
  if (view.hashLock !== ref.hashLock || view.payer !== ref.payer) {
    return end("sol-htlc: the escrow's own payer/hash lock differ from the ref (not this lock)", fin);
  }
  if (accounts.payee === undefined) return end("sol-htlc: payee has no account line", fin);

  const mismatch = firstFieldMismatch({ view, payee: accounts.payee, ...(accounts.payer === undefined ? {} : { payer: accounts.payer }), mint: trusted.assets.USDC, terms });
  const mintBytes = pubkeyFromBase58(trusted.assets.USDC);

  if (view.status === "Locked") {
    // H1: `rail` only once every field this capture can check matches.
    if (mismatch !== null) return { lock: { ...base, endpoint: endpointFor, ...fin, railVerified: false, reason: mismatch } };
    // No revealed-but-unpaid state exists on Solana: a Locked escrow that carries a preimage is impossible.
    if (view.revealed || view.preimage !== null) {
      return end("sol-htlc: a Locked escrow that already holds a preimage is an impossible state (the claim is atomic) - refusing to read it", fin);
    }
    const vaultProblem = tokenAccountProblem(vaultRead.account, mintBytes, escrowOwnerBytes(plan.escrow));
    if (vaultProblem !== null) return { lock: { ...base, endpoint: endpointFor, ...fin, railVerified: false, reason: `sol-htlc: the vault ${vaultProblem}` } };
    const vaultBalance = decodeTokenAccount((vaultRead.account as WireAccount).data).amount;
    if (vaultBalance < BigInt(terms.amount)) {
      return { lock: { ...base, endpoint: endpointFor, ...fin, railVerified: false, reason: `sol-htlc: the vault holds ${vaultBalance} units, fewer than the ${terms.amount} the lock promises` } };
    }
    const payeeProblem = tokenAccountProblem((payeeTokenRead as { account: WireAccount | null }).account, mintBytes, pubkeyFromBase58(accounts.payee));
    if (payeeProblem !== null) {
      return { lock: { ...base, endpoint: endpointFor, ...fin, railVerified: false, reason: `sol-htlc: the payee's token account ${payeeProblem} - the payout could never land` } };
    }
    const rail: RailObservation = { status: "locked", final: true, checkedAtMs, finalizedRef };
    return { lock: { ...base, endpoint: endpointFor, ...fin, railVerified: true, reason: "sol-htlc: locked and on-chain state matches terms (vault funded, payee token account usable)" }, rail };
  }

  // Claimed or Refunded.
  const label: "claimed" | "refunded" = view.status === "Claimed" ? "claimed" : "refunded";
  if (label === "claimed") {
    if (!view.revealed || view.preimage === null || !preimageOpensHashLock(view.preimage, ref.hashLock)) {
      return end("sol-htlc: a Claimed escrow whose stored preimage does not open the hash lock is an impossible state - refusing to read it", fin);
    }
  } else if (view.revealed || view.preimage !== null) {
    return end("sol-htlc: a Refunded escrow that holds a preimage is an impossible state - refusing to read it", fin);
  }
  const baseReason = `sol-htlc: ${capture.index.ref} is ${label} on-chain, not locked`;
  if (mismatch !== null) {
    return end(`${baseReason} - and its other fields do not match this swap's terms/accounts (${mismatch}) - refusing to trust it as this swap's own lock`, fin);
  }
  const rail: RailObservation = { status: label, final: true, checkedAtMs, finalizedRef };
  return { lock: { ...base, endpoint: endpointFor, ...fin, railVerified: false, reason: baseReason }, rail };
}

function escrowOwnerBytes(escrowBase58: string): Uint8Array {
  return pubkeyFromBase58(escrowBase58);
}

// -- the live capture ---------------------------------------------------------------------------------------

function randomNonce(): string {
  return randomBytes(8).toString("hex");
}

function buildIndex(config: SolRailConfig, ref: string, checkedAtMs: number, nonce: string, exchanges: readonly Exchange[], error?: string): SolCaptureIndex {
  return {
    v: 1,
    rail: SOL_RAIL_ID,
    ref,
    pin: config.pin.name,
    caip2: config.pin.caip2,
    endpoint: config.endpoint,
    checkedAtMs,
    config,
    nonce,
    ...(error === undefined ? {} : { error }),
    exchanges: exchanges.map(({ method, params, requestBody, responseSha256, atMs }) => ({ method, params, requestBody, responseSha256, atMs })),
  };
}

function contextSlotOf(result: unknown): number | null {
  if (result === null || typeof result !== "object") return null;
  const context = (result as { context?: unknown }).context;
  if (context === null || typeof context !== "object") return null;
  const slot = (context as { slot?: unknown }).slot;
  return typeof slot === "number" ? slot : null;
}

/**
 * The live half of "capture live, then decode": the fixed read sequence in this file's header, every call
 * through `rpc` (so every byte is captured) with ids namespaced "<ref>:<nowMs>:<nonce>:<n>". Never throws.
 * A JSON-RPC-level error reply is a completed read (the exchange is recorded and `solEvidence` reports it on
 * replay); any other error (a transport failure, a timeout, the response byte cap, a non-JSON reply) means
 * the read did not complete: the capture carries `index.error` (F1/E2) and the caller counts it as skipped.
 * A sequence whose account reads straddled two finalized slots is retried, up to `SOL_CAPTURE_ATTEMPTS`
 * times; only the last attempt's exchanges are returned.
 */
export async function captureSolLeg(
  rpc: CapturingRpc,
  config: SolRailConfig,
  terms: LockTerms,
  accounts: SolAccounts,
  ref: string,
  nowMs: number,
): Promise<{ index: SolCaptureIndex; exchanges: Exchange[] }> {
  let nonce = randomNonce();
  const parsed = parseSolRef(ref);
  if (solLockRefInvalid(terms, ref) || parsed === null) return { index: buildIndex(config, ref, nowMs, nonce, []), exchanges: [] };
  let plan: ReadPlan;
  try {
    plan = readPlan(config, parsed, accounts.payee);
  } catch (error) {
    return { index: buildIndex(config, ref, nowMs, nonce, [], error instanceof Error ? error.message : String(error)), exchanges: [] };
  }

  let last: { index: SolCaptureIndex; exchanges: Exchange[] } | null = null;
  for (let attempt = 0; attempt < SOL_CAPTURE_ATTEMPTS; attempt += 1) {
    nonce = randomNonce();
    const before = rpc.exchanges().length;
    const finish = (error?: string): { index: SolCaptureIndex; exchanges: Exchange[] } => {
      const exchanges = rpc.exchanges().slice(before);
      return { index: buildIndex(config, ref, nowMs, nonce, exchanges, error), exchanges: [...exchanges] };
    };
    const outcome = await readOnce(rpc, plan, `${ref}:${nowMs}:${nonce}`, finish);
    last = outcome.result;
    if (!outcome.straddled) return last;
  }
  return last as { index: SolCaptureIndex; exchanges: Exchange[] };
}

async function readOnce(
  rpc: CapturingRpc,
  plan: ReadPlan,
  namespace: string,
  finish: (error?: string) => { index: SolCaptureIndex; exchanges: Exchange[] },
): Promise<{ result: { index: SolCaptureIndex; exchanges: Exchange[] }; straddled: boolean }> {
  rpc.setIdNamespace(namespace);
  try {
    try {
      const genesis = await rpc.request({ method: "getGenesisHash", params: [] });
      if (typeof genesis !== "string") return { result: finish(), straddled: false };
    } catch (error) {
      if (!(error instanceof RpcCaptureError)) return { result: finish(error instanceof Error ? error.message : String(error)), straddled: false };
      return { result: finish(), straddled: false };
    }
    let slot: unknown;
    try {
      slot = await rpc.request({ method: "getSlot", params: SLOT_PARAMS });
    } catch (error) {
      return { result: finish(error instanceof RpcCaptureError ? undefined : error instanceof Error ? error.message : String(error)), straddled: false };
    }
    if (typeof slot !== "number" || !Number.isSafeInteger(slot)) return { result: finish(), straddled: false };

    const keys = [plan.escrow, plan.vault, plan.program, plan.programData, ...(plan.payeeToken === null ? [] : [plan.payeeToken])];
    const contexts: Array<number | null> = [];
    for (const key of keys) {
      try {
        const result = await rpc.request({ method: "getAccountInfo", params: accountReadParams(key, slot) });
        contexts.push(contextSlotOf(result));
      } catch (error) {
        // E2: an RpcCaptureError is a JSON-RPC-level reply the exchange of which was recorded (a completed
        // read the evidence reports on replay). Anything else means nothing trustworthy was recorded.
        if (!(error instanceof RpcCaptureError)) return { result: finish(error instanceof Error ? error.message : String(error)), straddled: false };
        contexts.push(null);
      }
    }
    const known = contexts.filter((c): c is number => c !== null);
    const straddled = known.length > 0 && known.some((c) => c !== known[0]);
    return { result: finish(), straddled };
  } finally {
    rpc.setIdNamespace(undefined);
  }
}

// -- replay-side loading ------------------------------------------------------------------------------------

function isCaptureIndexCandidate(name: string): boolean {
  return name.endsWith(".json") && !name.includes(".tmp-");
}

function looksLikeSolCaptureIndex(value: unknown, ref: string): value is SolCaptureIndex {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || v.rail !== SOL_RAIL_ID) return false;
  if (typeof v.ref !== "string" || v.ref !== ref || parseSolRef(v.ref) === null) return false;
  if (typeof v.nonce !== "string" || v.nonce.length === 0) return false;
  if (!Array.isArray(v.exchanges)) return false;
  for (const exchange of v.exchanges) {
    if (exchange === null || typeof exchange !== "object") return false;
    const e = exchange as Record<string, unknown>;
    if (typeof e.method !== "string") return false;
    if (typeof e.requestBody !== "string") return false;
    if (typeof e.responseSha256 !== "string" || !SHA256_HEX_LOWER.test(e.responseSha256)) return false;
    if (typeof e.atMs !== "number") return false;
  }
  return true;
}

/** E1: `raw/sol/<hashLock>/<legContract>` - the directory a capture for this (hash lock, leg contract)
 *  pair lives under. The writer (watcher) and every reader build the same path from the same two values. */
export function solCaptureDir(root: string, hashLock: string, legContract: string): string {
  return join(root, "raw", "sol", hashLock, legContract);
}

/** E1: the composite key for every in-memory capture map (a bare hash lock is not enough once two legs can
 *  share one). `":"` is safe: neither part can contain one. */
export function solCaptureKey(hashLock: string, legContract: string): string {
  return `${hashLock}:${legContract}`;
}

export interface LoadSolCaptureResult {
  capture: SolCapture | null;
  /** The newest index filename when it failed to read, parse or validate (and so failed the leg closed). */
  skipped: string[];
}

/**
 * The one place a replay does file I/O for a Solana capture. Reads only the newest
 * `raw/sol/<hashLock>/<legContract>/*.json` (ISO-stamped names sort chronologically; `.tmp-*` leftovers are
 * never candidates); if that newest file fails to read, parse or validate, the leg fails closed
 * (`capture: null`) and never falls back to an older capture.
 */
export async function loadSolCapture(root: string, ref: string, legContract: string): Promise<LoadSolCaptureResult> {
  const parsed = parseSolRef(ref);
  if (parsed === null || !LEG_CONTRACT_SHAPE.test(legContract)) return { capture: null, skipped: [] };
  const dir = solCaptureDir(root, parsed.hashLock, legContract);
  let allEntries: string[];
  try {
    allEntries = await readdir(dir);
  } catch {
    return { capture: null, skipped: [] };
  }
  const newest = allEntries.filter(isCaptureIndexCandidate).sort().at(-1);
  if (newest === undefined) return { capture: null, skipped: [] };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(join(dir, newest), "utf8"));
  } catch {
    return { capture: null, skipped: [newest] };
  }
  if (!looksLikeSolCaptureIndex(parsedJson, ref)) return { capture: null, skipped: [newest] };

  const index = parsedJson;
  const bytes = new Map<string, Uint8Array | null>();
  for (const exchange of index.exchanges) {
    if (bytes.has(exchange.responseSha256)) continue;
    bytes.set(exchange.responseSha256, await readCapture(root, exchange.responseSha256));
  }
  return { capture: { index, bytes }, skipped: [] };
}
