// SPDX-License-Identifier: MIT
//
// tests-sol/client-flows.sol.test.ts - Stage SB3b (P6-SOL-SPEC.md sections 3-5): the Seller/Buyer client flows
// (src/client/seller.ts, src/client/buyer.ts) end to end against a REAL `solana-test-validator` with the real
// reviewed `htlc.so` loaded at genesis (tests-sol/helpers/validator.ts): leg A on the Solana rail
// (src/client/sol-rail.ts, rail id SOL_RAIL_ID), leg B on tclk's own `PaperRail` over one in-memory
// `NoteStore`. Mirrors tests-near/client-flows.near.test.ts (one shared node for the whole file, `writeBundle`
// plus `examples/audit-export.mjs` replay per fixture scenario, `CAPTURE_SOL_FIXTURES`) with Solana's own
// primitives swapped in: a wallet address per party and a proven `ed25519` account line (P7), the
// `0x<hash lock>:<payer>` ref, and real time instead of a fast-forward.
//
// TIME. A `solana-test-validator` has no fast-forward: chain time is wall time, and every write waits for
// FINALIZED (about 13-15 s behind the tip, so one write is 15-30 s). Two kinds of window result:
//   - an HONEST window (claim and Buyer-refund-refusal scenarios): the leg-A deadlines are `t0 + 20 min` /
//     `t0 + 47 min` with the flow clock at `t0`, exactly what the flows' own rules demand (rule 1: at least 45
//     minutes from the declared lock time to `refundAfterMs`; a claim needs the 5 minute claim margin, and the
//     adapter's own 120 s landing margin on top);
//   - a COMPRESSED window (the one scenario that must actually cross `refundAfterMs` on the chain, "refunded"):
//     `refundAfterMs` is about 7 real minutes away and the FLOW clock is set back by the difference, so the
//     flows' own "45 minutes from lock to refund" rule still sees 48 minutes. The flow clock is an input of the
//     flows (they never read wall time themselves); what is NOT compressed is everything the chain decides: the
//     adapter judges refund and claim windows against the chain's own FINALIZED slot time and
//     `max(chain time, clock)`, and the program checks its own clock. After the lock, the flow clock is moved
//     forward (a free assignment, as in the NEAR file) and the real chain time is waited for.
// Leg B (paper) is governed by the flow clock only, so its refund is a free clock move.
//
// What this file pins live (each scenario has a hermetic twin in tests/client-flows-sol.test.ts on the stateful
// fake node; the point here is that the real validator, the real program and the real adapter agree):
//   1 settled; 2 refunded (the Buyer refunds leg A after the real chain time passes refundAfterMs, the Seller
//   refunds leg B); 3 refunded-b; 4 a claim is refused before the lock is final (before any lock frame, and with
//   a lock frame posted while the lock is only `confirmed`); 5 the Buyer learns the secret with no reveal frame;
//   6 a claim that LANDS and FAILS publishes the secret, the flows route correctly (reveal posted, retry at once
//   in public-secret mode and paid; or no retry possible and the Buyer learns the secret from the failed
//   transaction and refuses to refund); 7 a squat by another payer does not block; 8 lost replies are recovered
//   (the lock by `reconcileLockA`, the claim by recognising the landed claim from the chain); 9 a mirror pair
//   cannot borrow the evidence (P7: its copies of the victim's lines do not resolve).
//
// Fixtures `fixtures/sol-localnet-2026-09-30/{settled,refunded,refunded-b}/`, regenerated only with
// `CAPTURE_SOL_FIXTURES=1` (mirrors `CAPTURE_NEAR_FIXTURES`); every other run writes to a fresh `mkdtemp`
// directory, removed in `afterAll` unless `KEEP_SOL_BUNDLES=1`. No key is ever written, printed or committed:
// the in-memory wallets of `tests-sol/helpers/validator.ts` never leave memory, and the fixtures hold only
// public chain reads, signed transactions and account-line proofs.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, paperNote, tryDecodeFrame, verifyHashPreimage, type LockTerms, type TranscriptRecord } from "@flop-labs/tclk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { writeBundle, type BundleEvidenceSummary } from "../src/client/bundle.js";
import type { CounterAssetRail } from "../src/client/counter-rail.js";
import { SellerFlow } from "../src/client/seller.js";
import { createSolCounterRail } from "../src/client/sol-rail.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { resolveSolAccounts } from "../src/rails/account-line.js";
import { SOL_RAIL_ID, createSolRailRegistry } from "../src/rails/custom-rails.js";
import { encodeFrameWith } from "../src/rails/custom-frames.js";
import { CapturingRpc, verifiedExchangeBytes, type Exchange } from "../src/rails/rpc-capture.js";
import { captureSolLeg, solEvidence, type SolAccounts, type SolCapture } from "../src/rails/sol-evidence.js";
import { SolHtlcRail, escrowAddress, type SolSigner } from "../src/rails/sol-htlc.js";
import { SolRpc } from "../src/rails/sol-rpc.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotent } from "../src/rails/sol-spl.js";
import { compileLegacyMessage, pubkeyFromBase58, pubkeyToBase58, signTransaction, type SolInstruction } from "../src/rails/sol-tx.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { identity, record, type Identity } from "../tests/helpers/identity.js";
import { startSolValidator, type SolParty, type SolValidatorHandle } from "./helpers/validator.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXTURES_ROOT = join(REPO_ROOT, "fixtures", "sol-localnet-2026-09-30");

/** Mirrors `CAPTURE_NEAR_FIXTURES`: only this switch writes into the committed fixtures directory. */
const CAPTURE_FIXTURES = process.env.CAPTURE_SOL_FIXTURES === "1";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every scenario's own `mkdtemp` bundle directory (never the committed fixtures under `CAPTURE_FIXTURES`). */
const scenarioRoots: string[] = [];

async function scenarioRoot(scenario: string): Promise<string> {
  if (CAPTURE_FIXTURES) {
    const dir = join(FIXTURES_ROOT, scenario);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return dir;
  }
  const dir = await mkdtemp(join(tmpdir(), `flop-sol-localnet-${scenario}-`));
  scenarioRoots.push(dir);
  return dir;
}

async function runAuditExport(root: string, expectArg: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(REPO_ROOT, "examples", "audit-export.mjs"), "--root", root, "--expect", expectArg], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function ident(tag: number): Identity {
  return identity(tag.toString(16).padStart(2, "0").repeat(32));
}

function framesIn(records: readonly TranscriptRecord[], type: string): TranscriptRecord[] {
  return records.filter((r) => tryDecodeFrame(r.line)?.type === type);
}

interface LegWindows {
  lockTimeMs: number;
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
}

/** An HONEST leg-A window anchored at the flow clock `t0`: 20 min to claim, 47 min to refund (rule 1: at least
 *  45 min from the declared lock time), the offer open for 10 min. */
function honestLegA(t0: number): LegWindows {
  return { lockTimeMs: t0, claimByMs: t0 + 20 * MINUTE, refundAfterMs: t0 + 47 * MINUTE, expiresMs: t0 + 10 * MINUTE };
}

/** Leg B (paper): governed only by the flow clock, sized a full order of magnitude clear of every policy number. */
function legBWindows(t0: number) {
  return { claimByMs: t0 + 12 * HOUR, refundAfterMs: t0 + 24 * HOUR, expiresMs: t0 + 40 * MINUTE };
}

interface Swap {
  buyer: Identity;
  seller: Identity;
  buyerParty: SolParty;
  sellerParty: SolParty;
  /** The flow clock: real wall time plus `skew.ms` (the flows never read wall time themselves). */
  skew: { ms: number };
  clock: () => number;
  venue: MemoryVenue;
  noteStore: MemoryNoteStore;
  buyerRpc: CapturingRpc;
  sellerRpc: CapturingRpc;
  /** How many `sendTransaction` requests each party's transport has made (a capture drains the exchange log, so
   *  the log itself cannot be counted). */
  buyerSends: () => number;
  sellerSends: () => number;
  buyerRail: CounterAssetRail;
  sellerRail: CounterAssetRail;
  buyerFlow: BuyerFlow;
  sellerFlow: SellerFlow;
}

describe("Seller/Buyer client flows against a real solana-test-validator", () => {
  let v: SolValidatorHandle;

  beforeAll(async () => {
    v = await startSolValidator();
  }, 600_000);

  afterAll(async () => {
    if (v !== undefined) await v.stop();
    if (process.env.KEEP_SOL_BUNDLES !== "1") {
      await Promise.all(scenarioRoots.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  // -- harness -----------------------------------------------------------------------------------------------

  interface SetupOptions {
    buyer: Identity;
    seller: Identity;
    buyerParty?: SolParty;
    sellerParty?: SolParty;
    skewMs?: number;
    buyerFetch?: typeof fetch;
    sellerFetch?: typeof fetch;
    sellerSleep?: (ms: number) => Promise<void>;
  }

  function setupSwap(options: SetupOptions): Swap {
    const skew = { ms: options.skewMs ?? 0 };
    const clock = (): number => Date.now() + skew.ms;
    const venue = new MemoryVenue(clock);
    const noteStore = new MemoryNoteStore();
    const buyerParty = options.buyerParty ?? v.buyer;
    const sellerParty = options.sellerParty ?? v.seller;
    const buyerCount = countingFetch(options.buyerFetch);
    const sellerCount = countingFetch(options.sellerFetch);
    const buyerRpc = v.createCapturingRpc({ fetch: buyerCount.fetch });
    const sellerRpc = v.createCapturingRpc({ fetch: sellerCount.fetch });
    const buyerRail = createSolCounterRail({ config: v.config, rpc: buyerRpc, signer: buyerParty.signer as SolSigner, clock });
    const sellerRail = createSolCounterRail({
      config: v.config,
      rpc: sellerRpc,
      signer: sellerParty.signer as SolSigner,
      clock,
      ...(options.sellerSleep === undefined ? {} : { sleep: options.sellerSleep }),
    });
    const buyerFlow = new BuyerFlow({ identity: options.buyer, venue, paperRail: new PaperRail(noteStore, clock), rail: buyerRail, clock });
    const sellerFlow = new SellerFlow({ identity: options.seller, venue, paperRail: new PaperRail(noteStore, clock), rail: sellerRail, clock });
    return { buyer: options.buyer, seller: options.seller, buyerParty, sellerParty, skew, clock, venue, noteStore, buyerRpc, sellerRpc, buyerSends: buyerCount.sends, sellerSends: sellerCount.sends, buyerRail, sellerRail, buyerFlow, sellerFlow };
  }

  /** The chain's own FINALIZED slot time (what the adapter's claim and refund windows are judged against). */
  async function chainTimeMs(): Promise<number> {
    const sol = new SolRpc(v.createCapturingRpc());
    const slot = await sol.getSlot("finalized");
    const seconds = await sol.getBlockTime(slot);
    if (seconds === null) throw new Error("test: the finalized slot has no block time");
    return seconds * 1000;
  }

  async function waitChainTime(atLeastMs: number, timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await chainTimeMs()) >= atLeastMs) return;
      if (Date.now() >= deadline) throw new Error("test: the chain time never reached the target");
      await sleep(2000);
    }
  }

  /** bid -> acceptLegA -> acceptLegB -> lockLegB -> verifyLegBLocked -> both PROVEN account lines: the prefix every
   *  scenario shares (P7: each party posts its wallet address with an `ed25519` proof). */
  async function pairWithLines(nonceHex: string, h: Swap, legA: LegWindows, postLines = true) {
    const swapId = computeSwapId(h.buyer.did, nonceHex);
    const offerA = await h.buyerFlow.bid({
      swapId,
      wantAsset: "FLOP",
      wantAmount: "52070000",
      wantRail: "flop-htlc",
      amount: "500000", // 0.5 USDC (6 decimals)
      asset: "USDC",
      claimByMs: legA.claimByMs,
      refundAfterMs: legA.refundAfterMs,
      expiresMs: legA.expiresMs,
    });
    const { acceptA, acceptARecord, offerB, offerBRecord } = await h.sellerFlow.acceptLegA(offerA, legBWindows(legA.lockTimeMs), legA.lockTimeMs);
    const { acceptB, acceptBRecord } = await h.buyerFlow.acceptLegB(offerBRecord, acceptARecord, legA.lockTimeMs);
    await h.sellerFlow.lockLegB(acceptBRecord);
    await h.buyerFlow.verifyLegBLocked();
    if (postLines) {
      await h.sellerFlow.postAccountLineA(h.sellerParty.address);
      await h.buyerFlow.postAccountLineA(h.buyerParty.address);
    }
    const statement = h.sellerFlow.statement;
    if (statement === undefined) throw new Error("test setup: the Seller's statement was never minted");
    return { swapId, offerA, offerB, acceptA, acceptB, statement, termsA: offerAcceptLockTerms(offerA, acceptA) };
  }

  type Paired = Awaited<ReturnType<typeof pairWithLines>>;

  /** Both parties' resolved (proven) wallet addresses, exactly as the flows resolve them internally. */
  async function resolveSol(h: Swap, p: Paired): Promise<SolAccounts> {
    const records = await h.venue.read(dealRoom(p.acceptA.contract));
    const resolved = h.buyerRail.resolveAccounts(records, { contract: p.acceptA.contract, payerDid: p.termsA.payer, payeeDid: p.termsA.payee });
    return { ...(resolved.payee === undefined ? {} : { payee: resolved.payee }), ...(resolved.payer === undefined ? {} : { payer: resolved.payer }) };
  }

  const refOf = (p: Paired, h: Swap): string => `${p.statement}:${h.buyerParty.address}`;
  const escrowKey = (payer: string, hashLock: string): string => pubkeyToBase58(escrowAddress(v.config.programId, payer, hashLock).address);

  async function escrowStatus(ref: string): Promise<string | null> {
    const rail = await SolHtlcRail.connect({ config: v.config, rpc: v.createCapturingRpc(), signer: v.buyer.signer as SolSigner });
    return (await rail.getEscrow(ref)).escrow?.status ?? null;
  }

  async function waitEscrowStatus(ref: string, status: string, timeoutMs = 120_000): Promise<void> {
    for (const deadline = Date.now() + timeoutMs; ; ) {
      if ((await escrowStatus(ref)) === status) return;
      if (Date.now() >= deadline) throw new Error(`test: the escrow never reached ${status} at finalized`);
      await sleep(1000);
    }
  }

  /** Sends one transaction from `party` and waits until it reaches `commitment` (throws on an on-chain error). */
  async function sendFrom(party: SolParty, instructions: SolInstruction[], commitment: "confirmed" | "finalized"): Promise<string> {
    const sol = new SolRpc(v.createCapturingRpc());
    const latest = await sol.getLatestBlockhash("confirmed");
    const message = compileLegacyMessage({ feePayer: party.signer.publicKeyBytes, recentBlockhash: pubkeyFromBase58(latest.blockhash), instructions });
    const tx = await signTransaction(message, [party.signer]);
    await sol.sendTransaction(tx.bytes, { preflightCommitment: "confirmed" });
    const rank: Record<string, number> = { processed: 1, confirmed: 2, finalized: 3 };
    for (const deadline = Date.now() + 120_000; ; ) {
      const [status] = await sol.getSignatureStatuses([tx.signature]);
      if (status !== undefined && status !== null) {
        if (status.err !== null) throw new Error(`test: a setup transaction failed: ${JSON.stringify(status.err)}`);
        if (status.confirmationStatus !== null && (rank[status.confirmationStatus] ?? 0) >= rank[commitment]!) return tx.signature;
      }
      if (Date.now() >= deadline) throw new Error(`test: a setup transaction never reached ${commitment}`);
      await sleep(400);
    }
  }

  /** SPL Token CloseAccount (tag 9) for `party`'s own associated token account (balance must be 0). */
  function closeOwnTokenAccount(party: SolParty): SolInstruction {
    return {
      programId: pubkeyFromBase58(TOKEN_PROGRAM_ID),
      accounts: [
        { pubkey: pubkeyFromBase58(party.tokenAccount as string), isSigner: false, isWritable: true },
        { pubkey: party.signer.publicKeyBytes, isSigner: false, isWritable: true },
        { pubkey: party.signer.publicKeyBytes, isSigner: true, isWritable: false },
      ],
      data: Uint8Array.of(9),
    };
  }

  function createOwnTokenAccount(party: SolParty): SolInstruction {
    return createAssociatedTokenAccountIdempotent({ payer: party.signer.publicKeyBytes, owner: party.signer.publicKeyBytes, mint: pubkeyFromBase58(v.mint) });
  }

  /** Wraps `inner` (or the platform `fetch`) and counts the `sendTransaction` requests that pass through. */
  function countingFetch(inner?: typeof fetch): { fetch: typeof fetch; sends: () => number } {
    let sends = 0;
    const counting: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : {};
      if (body.method === "sendTransaction") sends += 1;
      return (inner ?? fetch)(input, init);
    };
    return { fetch: counting, sends: () => sends };
  }

  /** A fetch that performs the real request and then loses the reply, for `sendTransaction` only, once armed. */
  function lossyFetch(): { fetch: typeof fetch; arm: () => void } {
    let armed = false;
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }) : {};
      if (armed && body.method === "sendTransaction") {
        armed = false;
        await response.arrayBuffer();
        throw new Error("connection reset while reading the reply");
      }
      return response;
    };
    return { fetch: lossy, arm: () => void (armed = true) };
  }

  /**
   * Makes the Seller's FIRST claim land and FAIL on the real chain: when the claim is about to be sent, the payee's
   * associated token account is closed (and confirmed) and the claim is forwarded with its preflight skipped, so
   * the program runs it, finds no payee token account and fails (BadTokenAccount) after the secret is public in
   * its instruction data. This models the only way a claim can land and fail (the account vanishing between the
   * flow's checks and the landing); the claim itself, its simulation and its pre-checks are the adapter's own.
   * With `recreate`, the account is created again as soon as the failed claim landed, and the rail's poll sleep
   * waits for that to be FINALIZED, as a person fixing the account would.
   */
  function failingClaimFetch(seller: SolParty, recreate: boolean): { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; state: { pending: Promise<void> | null; claimSignature: string | null } } {
    const state: { armed: boolean; pending: Promise<void> | null; claimSignature: string | null } = { armed: true, pending: null, claimSignature: null };
    const failing: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string; params?: unknown[] }) : {};
      if (!state.armed || body.method !== "sendTransaction" || !Array.isArray(body.params)) return fetch(input, init);
      state.armed = false;
      await sendFrom(seller, [closeOwnTokenAccount(seller)], "confirmed");
      const config = { ...((body.params[1] as Record<string, unknown> | undefined) ?? {}), skipPreflight: true };
      const forwarded = { ...body, params: [body.params[0], config, ...body.params.slice(2)] };
      const response = await fetch(input, { ...init, body: JSON.stringify(forwarded) });
      const reply = (await response.clone().json()) as { result?: string };
      state.claimSignature = reply.result ?? null;
      if (recreate && state.claimSignature !== null) {
        const signature = state.claimSignature;
        state.pending = (async () => {
          const sol = new SolRpc(v.createCapturingRpc());
          for (const deadline = Date.now() + 120_000; ; ) {
            const [status] = await sol.getSignatureStatuses([signature]);
            if (status !== undefined && status !== null) break;
            if (Date.now() >= deadline) throw new Error("test: the failing claim never landed");
            await sleep(300);
          }
          await sendFrom(seller, [createOwnTokenAccount(seller)], "finalized");
        })();
        state.pending.catch(() => undefined);
      }
      return response;
    };
    return {
      fetch: failing,
      sleep: async (ms) => {
        if (state.pending !== null) await state.pending;
        await sleep(ms);
      },
      state,
    };
  }

  /** Writes a watch-root bundle for the swap (a fresh `mkdtemp` directory, or, only under `CAPTURE_SOL_FIXTURES=1`,
   *  the named committed fixture directory) and replays it through `examples/audit-export.mjs` as a real child
   *  process, asserting the verdict. Mirrors the NEAR file's own `writeAndReplay`. */
  async function writeAndReplay(args: {
    scenario: string;
    h: Swap;
    p: Paired;
    status: string;
    sol?: { ref: string; accounts: SolAccounts };
    writes: BundleEvidenceSummary["writes"];
    startedAtMs: number;
  }): Promise<string> {
    const { h, p } = args;
    const root = await scenarioRoot(args.scenario);
    const dealRoomA = dealRoom(p.acceptA.contract);
    const dealRoomB = dealRoom(p.acceptB.contract);
    const { ns, key } = paperNote(p.acceptB.contract);
    const rawNote = h.noteStore.raw(ns, key);
    const nowMs = h.clock();
    const summary: BundleEvidenceSummary = {
      swapId: p.swapId,
      legA: { contract: p.acceptA.contract, rail: SOL_RAIL_ID },
      legB: { contract: p.acceptB.contract, rail: "paper" },
      feeBps: 0,
      writes: args.writes,
      startedAtMs: args.startedAtMs,
      finishedAtMs: nowMs,
    };
    await writeBundle({
      root,
      nowMs,
      offerRoomRecords: await h.venue.read(OFFER_ROOM),
      dealRooms: new Map([
        [dealRoomA, await h.venue.read(dealRoomA)],
        [dealRoomB, await h.venue.read(dealRoomB)],
      ]),
      paperNotes: rawNote === undefined ? new Map() : new Map([[p.acceptB.contract, rawNote]]),
      writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
      ...(args.sol === undefined ? {} : { sol: { config: v.config, rpc: v.createCapturingRpc(), ref: args.sol.ref, terms: p.termsA, accounts: args.sol.accounts } }),
      evidence: summary,
    });
    const result = await runAuditExport(root, `${p.swapId}=${args.status}`);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return root;
  }

  /** One live evidence read for `terms` with the given resolved accounts (the flows' own capture-then-decide). */
  async function evidenceFor(terms: LockTerms, accounts: SolAccounts, ref: string): Promise<ReturnType<typeof solEvidence>> {
    const rpc = v.createCapturingRpc();
    const { index, exchanges } = await captureSolLeg(rpc, v.config, terms, accounts, ref, Date.now());
    expect(index.error).toBeUndefined();
    const capture: SolCapture = { index, bytes: verifiedExchangeBytes(exchanges as Exchange[]) };
    return solEvidence({ terms, config: v.config, accounts, capture });
  }

  // -- 1 -----------------------------------------------------------------------------------------------------

  it("scenario 1: happy path -> settled (fixture: settled)", async () => {
    const h = setupSwap({ buyer: ident(1), seller: ident(2) });
    const startedAtMs = h.clock();
    const buyerBefore = (await v.usdcBalanceOf(h.buyerParty.address)) as bigint;
    const sellerBefore = (await v.usdcBalanceOf(h.sellerParty.address)) ?? 0n;

    const p = await pairWithLines("00000001", h, honestLegA(h.clock()));
    const lockA = await h.buyerFlow.lockLegA();
    expect(lockA.writeEvidence.ref).toBe(refOf(p, h));
    expect(await v.usdcBalanceOf(h.buyerParty.address)).toBe(buyerBefore - 500_000n);
    // the lock frame names the payer-keyed ref and the custom rail id
    const lockFrame = framesIn(await h.venue.read(dealRoom(p.acceptA.contract)), "lock").map((r) => tryDecodeFrame(r.line) as unknown as { rail: string; ref: string });
    expect(lockFrame).toEqual([expect.objectContaining({ rail: SOL_RAIL_ID, ref: refOf(p, h) })]);

    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.reveal).toBeDefined();
    expect(claimed.receipt).toBeDefined();
    expect(await v.usdcBalanceOf(h.sellerParty.address)).toBe(sellerBefore + 500_000n);
    expect(await escrowStatus(refOf(p, h))).toBe("Claimed");

    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);

    await writeAndReplay({
      scenario: "settled",
      h,
      p,
      status: "settled",
      sol: { ref: lockA.writeEvidence.ref, accounts: await resolveSol(h, p) },
      writes: [
        { leg: "a", step: "lock", rail: SOL_RAIL_ID, evidence: lockA.writeEvidence },
        { leg: "a", step: "claim", rail: SOL_RAIL_ID, evidence: claimed.evidence },
      ],
      startedAtMs,
    });
  }, 480_000);

  // -- 2 -----------------------------------------------------------------------------------------------------

  it(
    "scenario 2: refunded - the Seller never claims; the Buyer refunds leg A once the REAL chain time passes refundAfterMs, the Seller refunds leg B (fixture: refunded)",
    async () => {
      // COMPRESSED window (see the file header): refundAfterMs is about 7 real minutes away, the flow clock runs
      // 41 minutes behind wall time so the flows' own rule still sees a 48 minute window from lock to refund.
      const refundAfterMs = Date.now() + 7 * MINUTE;
      const h = setupSwap({ buyer: ident(3), seller: ident(4), skewMs: -(48 * MINUTE - 7 * MINUTE) });
      const t0 = h.clock();
      const startedAtMs = t0;
      const legA: LegWindows = { lockTimeMs: t0, claimByMs: refundAfterMs - 5 * MINUTE - 1000, refundAfterMs, expiresMs: t0 + 30 * MINUTE };
      expect(refundAfterMs - t0).toBeGreaterThanOrEqual(47 * MINUTE);

      const p = await pairWithLines("00000002", h, legA);
      const buyerBefore = (await v.usdcBalanceOf(h.buyerParty.address)) as bigint;
      const lockA = await h.buyerFlow.lockLegA();
      expect(await v.usdcBalanceOf(h.buyerParty.address)).toBe(buyerBefore - 500_000n);
      const ref = refOf(p, h);

      // Guard 1 (the flow's own, clock-gated, cheap): the flow clock is still far before refundAfterMs.
      await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/before its refundAfterMs/);

      // Move the flow clock to real time and wait until WALL time is past refundAfterMs: the chain's own finalized
      // time still lags (about 15 s), and the adapter judges the window against the CHAIN only, so it refuses.
      h.skew.ms = 0;
      while (Date.now() <= refundAfterMs + 1000) await sleep(1000);
      const sendsBefore = h.buyerSends();
      await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/chain time has not yet reached refundAfterMs/);
      expect(h.buyerSends()).toBe(sendsBefore);
      expect(await escrowStatus(ref)).toBe("Locked");

      // Now actually cross refundAfterMs on the real chain (the validator's own finalized slot time).
      await waitChainTime(refundAfterMs);
      const refundA = await h.buyerFlow.refundLegA();
      expect(refundA.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,100}$/);
      expect(await escrowStatus(ref)).toBe("Refunded");
      expect(await v.usdcBalanceOf(h.buyerParty.address)).toBe(buyerBefore);
      const roomA = await h.venue.read(dealRoom(p.acceptA.contract));
      expect(framesIn(roomA, "refund")).toHaveLength(1);
      expect(framesIn(roomA, "receipt").map((r) => tryDecodeFrame(r.line))).toEqual([expect.objectContaining({ outcome: "refunded", rail: SOL_RAIL_ID, ref })]);

      // Leg B (paper) needs only the flow clock, which is free to move arbitrarily far.
      h.skew.ms = 25 * HOUR;
      const refundB = await h.sellerFlow.refundLegB();
      expect(refundB.refund).toBeDefined();

      await writeAndReplay({
        scenario: "refunded",
        h,
        p,
        status: "refunded",
        sol: { ref: lockA.writeEvidence.ref, accounts: await resolveSol(h, p) },
        writes: [
          { leg: "a", step: "lock", rail: SOL_RAIL_ID, evidence: lockA.writeEvidence },
          { leg: "a", step: "refund", rail: SOL_RAIL_ID, evidence: refundA },
        ],
        startedAtMs,
      });
    },
    900_000,
  );

  // -- 3 -----------------------------------------------------------------------------------------------------

  it("scenario 3: refunded-b - the Buyer never locks A; the Seller refunds leg B (fixture: refunded-b)", async () => {
    const h = setupSwap({ buyer: ident(5), seller: ident(6) });
    const startedAtMs = h.clock();
    const p = await pairWithLines("00000003", h, honestLegA(h.clock()));

    // The Buyer never calls lockLegA: no Solana write, no chain interaction for leg A ever happens.
    h.skew.ms = 25 * HOUR;
    const refundB = await h.sellerFlow.refundLegB();
    expect(refundB.refund).toBeDefined();
    expect(h.buyerSends()).toBe(0);
    expect(await escrowStatus(refOf(p, h))).toBeNull();

    await writeAndReplay({
      scenario: "refunded-b",
      h,
      p,
      status: "refunded-b",
      // No Solana WRITE exists, but the bundle still carries a live read of the chain for the ref the lock would
      // have had: the evidence of ABSENCE (and the rails.json the replay needs to read a Solana-rail swap at all).
      sol: { ref: refOf(p, h), accounts: await resolveSol(h, p) },
      writes: [{ leg: "b", step: "refund", rail: "paper", evidence: {} }],
      startedAtMs,
    });
  }, 240_000);

  // -- 4 -----------------------------------------------------------------------------------------------------

  it("scenario 4: a claim is refused before the lock is final (no lock frame; then a lock frame while the lock is only confirmed), and goes through once it is final", async () => {
    const h = setupSwap({ buyer: ident(9), seller: ident(10) });
    const p = await pairWithLines("00000004", h, honestLegA(h.clock()));
    const ref = refOf(p, h);
    const room = dealRoom(p.acceptA.contract);

    // (a) The Buyer has not locked: there is no accepted lock frame for the Seller's claim to name.
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/no accepted lock frame carries a .* ref \(0x<hash lock>:<payer>\) yet/);
    expect(h.sellerSends()).toBe(0);

    // (b) The lock is SENT (not waited for) and a lock frame naming it is posted as soon as the escrow is visible at
    // `confirmed`, well before it is FINALIZED (the flows post their own lock frame only after the chain agrees; an
    // early or dishonest Buyer need not). The Seller's claim reads the lock at FINALIZED and must refuse.
    const accounts = await resolveSol(h, p);
    const connected = await h.buyerRail.connect(p.termsA, accounts);
    await connected.prepareLock(p.termsA, 0);
    const committing = connected.commitLock();
    const outcome = committing.then(
      () => null,
      (error: unknown) => error,
    );
    const sol = new SolRpc(v.createCapturingRpc());
    const escrowAddr = escrowKey(h.buyerParty.address, p.statement);
    for (const deadline = Date.now() + 90_000; (await sol.getAccountInfo(escrowAddr, { commitment: "confirmed" })).account === null; ) {
      if (Date.now() >= deadline) throw new Error("test: the lock never became visible at confirmed");
      await sleep(100);
    }
    const finalizedAlready = (await sol.getAccountInfo(escrowAddr, { commitment: "finalized" })).account !== null;
    if (finalizedAlready) throw new Error("test precondition: the lock finalized before the claim could be attempted (slow machine); rerun");
    await h.venue.post(room, encodeFrameWith({ type: "lock", from: h.buyer.did, contract: p.acceptA.contract, rail: SOL_RAIL_ID, ref }, createSolRailRegistry()), h.buyer);

    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/before verifyLockFinal\(A\) is true/);
    expect(h.sellerSends()).toBe(0);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(0);

    // (c) Once the lock is final the very same claim goes through.
    expect(await outcome).toBeNull();
    await waitEscrowStatus(ref, "Locked");
    const claimed = await h.sellerFlow.claimLegA(p.statement);
    expect(claimed.evidence.ref).toBe(ref);
    expect(await escrowStatus(ref)).toBe("Claimed");
  }, 480_000);

  // -- 5 -----------------------------------------------------------------------------------------------------

  it("scenario 5: the Seller claims without posting a reveal frame; the Buyer learns the secret from the chain alone", async () => {
    const h = setupSwap({ buyer: ident(11), seller: ident(12) });
    const p = await pairWithLines("00000005", h, honestLegA(h.clock()));
    const lockA = await h.buyerFlow.lockLegA();

    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock, { skipReveal: true });
    expect(claimed.reveal).toBeUndefined();
    expect(framesIn(await h.venue.read(dealRoom(p.acceptA.contract)), "reveal")).toHaveLength(0);

    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);
  }, 360_000);

  // -- 6 -----------------------------------------------------------------------------------------------------

  it("scenario 6a: a claim that lands and FAILS publishes the secret; the Seller posts the reveal, retries at once in public-secret mode and is paid", async () => {
    const seller = await v.createParty({});
    const failing = failingClaimFetch(seller, true);
    const h = setupSwap({ buyer: ident(13), seller: ident(14), sellerParty: seller, sellerFetch: failing.fetch, sellerSleep: failing.sleep });
    const p = await pairWithLines("00000006", h, honestLegA(h.clock()));
    const ref = refOf(p, h);
    const lockA = await h.buyerFlow.lockLegA();

    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.ref).toBe(ref);
    expect(claimed.receipt).toBeDefined();
    expect(failing.state.claimSignature).not.toBeNull();

    // On chain: the escrow's history holds exactly one FAILED claim (BadTokenAccount, program error 17) and the
    // successful retry; the failed one carries the preimage in its instruction data, which is how the secret
    // became public.
    const sol = new SolRpc(v.createCapturingRpc());
    const history = await sol.getSignaturesForAddress(escrowKey(h.buyerParty.address, p.statement), { commitment: "finalized", limit: 20 });
    expect(history).toHaveLength(3); // lock, failed claim, retried claim
    const failedOnes = history.filter((entry) => entry.err !== null);
    expect(failedOnes).toHaveLength(1);
    expect(failedOnes[0]?.signature).toBe(failing.state.claimSignature);
    expect(failedOnes[0]?.err).toEqual({ InstructionError: [0, { Custom: 17 }] });
    expect(await escrowStatus(ref)).toBe("Claimed");
    expect(await v.usdcBalanceOf(seller.address)).toBe(500_000n);

    // The reveal frame and the receipt were posted once each; the Buyer learns the secret and claims leg B.
    const room = await h.venue.read(dealRoom(p.acceptA.contract));
    expect(framesIn(room, "reveal")).toHaveLength(1);
    expect(framesIn(room, "receipt")).toHaveLength(1);
    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);
  }, 600_000);

  it("scenario 6b: a failed claim whose retry cannot land leaves the secret public on chain only; the Buyer refuses to refund into it, learns the secret from the failed transaction and claims leg B", async () => {
    const seller = await v.createParty({});
    const failing = failingClaimFetch(seller, false);
    const h = setupSwap({ buyer: ident(15), seller: ident(16), sellerParty: seller, sellerFetch: failing.fetch });
    const p = await pairWithLines("00000007", h, honestLegA(h.clock()));
    const ref = refOf(p, h);
    const lockA = await h.buyerFlow.lockLegA();
    const room = dealRoom(p.acceptA.contract);

    // The claim lands and fails; no reveal frame is posted and the retry is refused by the adapter's own pre-check
    // (the payee's token account is gone), so the Seller is left unpaid with the secret public on chain.
    await expect(h.sellerFlow.claimLegA(lockA.hashLock, { skipReveal: true })).rejects.toThrow(/associated token account/);
    expect(framesIn(await h.venue.read(room), "reveal")).toHaveLength(0);
    expect(await escrowStatus(ref)).toBe("Locked");

    // The refund window of the flow clock opens: the Buyer must still NOT refund (the lock is claimable with a
    // public secret), and nothing is sent.
    h.skew.ms = 48 * MINUTE;
    const sendsBefore = h.buyerSends();
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/the secret is public and leg B is still claimable; call learnSecret\(\) then claimLegB\(\)/);
    await expect(h.buyerFlow.refundLegA()).rejects.toThrow(/call learnSecret/); // on every retry, not only the first
    expect(h.buyerSends()).toBe(sendsBefore);

    // With no reveal frame, the Buyer learns the secret from the failed transaction's instruction data.
    const secret = await h.buyerFlow.learnSecret();
    expect(verifyHashPreimage(lockA.hashLock, secret)).toBe(true);
    await h.buyerFlow.claimLegB(secret);
  }, 600_000);

  // -- 7 -----------------------------------------------------------------------------------------------------

  it("scenario 7: a squat - another payer locks under the swap's public hash lock first; the Buyer's own lock still goes through and the swap settles", async () => {
    const h = setupSwap({ buyer: ident(17), seller: ident(18) });
    const p = await pairWithLines("00000008", h, honestLegA(h.clock()));
    const squatter = await v.createParty({ usdc: 1000n });
    const squatRail = await SolHtlcRail.connect({ config: v.config, rpc: v.createCapturingRpc(), signer: squatter.signer as SolSigner });
    await squatRail.prepareLock({ hashLock: p.statement, amount: "7", payee: squatter.address, claimByMs: p.offerA.claimByMs, refundAfterMs: p.offerA.refundAfterMs });
    await squatRail.commitLock();
    const squatRef = `${p.statement}:${squatter.address}`;
    expect(await escrowStatus(squatRef)).toBe("Locked");

    // The Buyer's real lock is not blocked, and its ref names the Buyer (the payer), not the squatter.
    const lockA = await h.buyerFlow.lockLegA();
    expect(lockA.writeEvidence.ref).toBe(refOf(p, h));
    const lockFrame = framesIn(await h.venue.read(dealRoom(p.acceptA.contract)), "lock").map((r) => tryDecodeFrame(r.line) as unknown as { ref: string });
    expect(lockFrame).toEqual([expect.objectContaining({ ref: refOf(p, h) })]);

    const claimed = await h.sellerFlow.claimLegA(lockA.hashLock);
    expect(claimed.evidence.ref).toBe(refOf(p, h));
    const secret = await h.buyerFlow.learnSecret();
    await h.buyerFlow.claimLegB(secret);
    expect(await escrowStatus(refOf(p, h))).toBe("Claimed");
    // The squatter's own unit is untouched: still Locked under ITS OWN key.
    expect(await escrowStatus(squatRef)).toBe("Locked");
  }, 480_000);

  // -- 8 -----------------------------------------------------------------------------------------------------

  it("scenario 8: lost replies are recovered - a lock whose send reply was lost is found by reconcileLockA (frame posted once); a claim whose reply was lost is recognised from the chain and sent only once", async () => {
    const lossyBuyer = lossyFetch();
    const lossySeller = lossyFetch();
    const h = setupSwap({ buyer: ident(19), seller: ident(20), buyerFetch: lossyBuyer.fetch, sellerFetch: lossySeller.fetch });
    const p = await pairWithLines("00000009", h, honestLegA(h.clock()));
    const ref = refOf(p, h);
    const room = dealRoom(p.acceptA.contract);

    // Lock: the transport error is rethrown unchanged, the flow stays latched, the lock lands anyway.
    lossyBuyer.arm();
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/connection reset/);
    await expect(h.buyerFlow.lockLegA()).rejects.toThrow(/already attempted/);
    expect(framesIn(await h.venue.read(room), "lock")).toHaveLength(0);
    let reconciled: Awaited<ReturnType<BuyerFlow["reconcileLockA"]>> = { locked: false, verified: false };
    for (const deadline = Date.now() + 180_000; ; ) {
      reconciled = await h.buyerFlow.reconcileLockA();
      if (reconciled.locked) break;
      if (Date.now() >= deadline) throw new Error("test: reconcileLockA never saw the lock");
      await sleep(2000);
    }
    expect(reconciled).toMatchObject({ locked: true, verified: true });
    await h.buyerFlow.reconcileLockA();
    expect(framesIn(await h.venue.read(room), "lock")).toHaveLength(1); // latched: never posted twice
    expect(await escrowStatus(ref)).toBe("Locked");

    // Claim: the send reply is lost after the claim was broadcast; the flow throws; once the claim is final, a retry
    // recognises success from the chain, sends nothing, and posts the frames once.
    lossySeller.arm();
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/connection reset/);
    const sendsAfterLoss = h.sellerSends();
    await waitEscrowStatus(ref, "Claimed");
    const second = await h.sellerFlow.claimLegA(p.statement);
    expect(second.receipt).toBeDefined();
    expect(h.sellerSends()).toBe(sendsAfterLoss); // nothing was sent again
    const after = await h.venue.read(room);
    expect(framesIn(after, "reveal")).toHaveLength(1);
    expect(framesIn(after, "receipt")).toHaveLength(1);
    await h.sellerFlow.claimLegA(p.statement);
    expect((await h.venue.read(room)).length).toBe(after.length);
    const secret = await h.buyerFlow.learnSecret();
    await h.buyerFlow.claimLegB(secret);
  }, 600_000);

  // -- 9 -----------------------------------------------------------------------------------------------------

  it("scenario 9: a mirror pair cannot borrow the evidence - a stranger's copy of the victim's proven lines does not resolve, so the victim's real lock never verifies for the mirror", async () => {
    const h = setupSwap({ buyer: ident(21), seller: ident(22) });
    const p = await pairWithLines("0000000a", h, honestLegA(h.clock()));
    const ref = refOf(p, h);
    const lockA = await h.buyerFlow.lockLegA();
    expect(lockA.writeEvidence.ref).toBe(ref);
    const victimAccounts = await resolveSol(h, p);
    expect(victimAccounts).toEqual({ payee: h.sellerParty.address, payer: h.buyerParty.address });

    // Control: the victim's own proven lines verify its real lock on the real chain.
    const control = await evidenceFor(p.termsA, victimAccounts, ref);
    expect(control.lock.railVerified).toBe(true);

    // The mirror: stranger DIDs and a stranger contract id (a different tclk pair for the same public hash lock),
    // whose room holds the victim's two account lines re-posted VERBATIM as the stranger's own lines.
    const mirrorBuyer = ident(0xa7);
    const mirrorSeller = ident(0xb8);
    const mirrorContract = `0x${"e1".repeat(32)}`;
    const mirrorRoom = dealRoom(mirrorContract);
    const victimLines = (await h.venue.read(dealRoom(p.acceptA.contract))).filter((r) => tryDecodeFrame(r.line) === null && r.line.includes("account"));
    expect(victimLines).toHaveLength(2);
    const mirrorRecords = victimLines.map((r, i) => record(mirrorRoom, i + 1, r.timestampMs + 1, r.sender === h.buyer.did ? mirrorBuyer : mirrorSeller, r.line));
    const caip2 = v.config.pin.caip2;
    const input = { contract: mirrorContract, payerDid: mirrorBuyer.did, payeeDid: mirrorSeller.did, caip2 };

    // The attack WORKS without the proof requirement (the pre-P7 fold): the copies resolve to the victim's wallets...
    const legacy = resolveSolAccounts(mirrorRecords, { ...input, proof: { mode: "legacy-unproven" } });
    expect(legacy.payee).toBe(h.sellerParty.address);
    expect(legacy.payer).toBe(h.buyerParty.address);
    const mirrorTerms: LockTerms = { ...p.termsA, contract: mirrorContract, payer: mirrorBuyer.did, payee: mirrorSeller.did };
    const borrowed = await evidenceFor(mirrorTerms, { payee: legacy.payee as string, payer: legacy.payer as string }, ref);
    expect(borrowed.lock.railVerified).toBe(true);

    // ...and is STOPPED by it: each proof binds the victim's DID and contract, so the copies do not resolve and the
    // live lock is never attributed to the mirror.
    const required = resolveSolAccounts(mirrorRecords, input);
    expect(required.payee).toBeUndefined();
    expect(required.payer).toBeUndefined();
    const refused = await evidenceFor(mirrorTerms, {}, ref);
    expect(refused.lock.railVerified).not.toBe(true);
    expect(refused.rail).toBeUndefined();
  }, 420_000);

  it("hygiene: no party signer leaks a key through JSON", () => {
    for (const party of [v.buyer, v.seller]) {
      const text = JSON.stringify(party);
      expect(text).not.toMatch(/secret/i);
      expect(Object.keys(party.signer)).not.toContain("secretKey");
    }
  });
});
