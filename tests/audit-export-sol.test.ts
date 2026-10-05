// SPDX-License-Identifier: MIT
//
// tests/audit-export-sol.test.ts - SB3a (P6-SOL-SPEC.md section 3): the Solana leg through every read-only
// path that folds a board from captured bytes: `writeBundle` (src/client/bundle.ts), the live watcher
// (`runSweep` with `rails.sol`), and the offline replay `examples/audit-export.mjs` (the compiled CLI, a real
// child process, no network). The bytes are REAL: a whole swap is driven through the real client flows over the
// stateful fake node (tests/helpers/sol-stateful-chain.ts), and the bundle captures the node's own answers.
//
// What this pins, each with a test that fails without it:
//   - `rails.sol` admits the Solana rail id for the board and the account lines through a caller-owned registry
//     built per fold, never global: without it the same swap reads as an unregistered rail (closed by default);
//   - captures are keyed per leg contract (`raw/sol/<hash lock>/<leg contract>/`), never by hash lock alone;
//   - only genuine accepts count (a forged contract id is no candidate and gets no evidence);
//   - both parties' PROVEN lines are required for a verified lock (payer and payee);
//   - a capture that names another payer's ref than the accepted lock frame never stands in (squat);
//   - a spliced, tampered or corrupted capture fails that leg closed, never the whole replay;
//   - a live sweep and an offline replay of the same root agree on the verdict.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dealRoom, encodeFrame, OFFER_ROOM, PaperRail, paperNote, tryDecodeFrame, type AcceptFrame, type TranscriptRecord } from "@flop-labs/tclk";

import { buildBoard } from "../src/board.js";
import { writeBundle } from "../src/client/bundle.js";
import { encodeFrameWith } from "../src/rails/custom-frames.js";
import { SOL_RAIL_ID } from "../src/rails/custom-rails.js";
import { LEG_A_REFUNDED_AFTER_B_CLAIMED, LEG_A_REFUNDED_LEG_B_CLAIMED_UNPROVEN } from "../src/swap.js";
import { SOL_LOCAL_PIN } from "../src/rails/sol-htlc.js";
import { solCaptureKey } from "../src/rails/sol-evidence.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { runSweep } from "../src/watcher.js";
import { record } from "./helpers/identity.js";
import { provenSolLine, solWallet } from "./helpers/sol-proof.js";
import { T0, ident, lockedFlow, solHarness, type SolHarness } from "./helpers/sol-flow-harness.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadRails, loadSolCaptures } from "../examples/audit-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sol-audit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Kind = "locked" | "claimed" | "settled" | "refunded" | "stolen";
type Swap = { swapId: string; status: string; settlementView: { a: string; b: string }; reasons: string[]; evidence: Record<string, any>; finalizedRefs: string[] };

interface Built {
  h: SolHarness;
  swapId: string;
  hashLock: string;
  ref: string;
  legContract: string;
  legBContract: string;
  status: string;
}

/** The harness parties' own identities, to re-sign a rewritten deal-room record as the same sender. */
function identityOf(sender: string) {
  for (const tag of [1, 2]) if (ident(tag).did === sender) return ident(tag);
  throw new Error(`test: unknown sender ${sender}`);
}

/** Drives a whole swap through the real flows and writes its evidence bundle under `dir`. `mapDealRoomA` lets a
 *  test rewrite leg A's deal-room records before they are written (an unproven line, a missing line). */
async function buildBundle(
  dir: string,
  kind: Kind,
  opts: { mapDealRoomA?: (records: readonly TranscriptRecord[], contract: string) => readonly TranscriptRecord[]; harness?: SolHarness; capturePayee?: boolean; withPaperNote?: boolean } = {},
): Promise<Built> {
  const h = opts.harness ?? solHarness();
  const p = await lockedFlow(h);
  if (kind === "claimed" || kind === "settled") {
    await h.sellerFlow.claimLegA(p.statement);
    if (kind === "settled") await h.buyerFlow.claimLegB(await h.buyerFlow.learnSecret());
  }
  if (kind === "stolen") {
    // R3-9: a third party claims leg B with the public secret, then leg A is refunded anyway (the flow's own guard
    // refuses that, so the refund is made on the rail directly and its frames are posted as the Buyer would).
    const legBContractStolen = (tryDecodeFrame(p.acceptBRecord.line) as AcceptFrame).contract;
    await new PaperRail(h.noteStore, h.clock).claim(legBContractStolen, h.sellerLock.preimage); // P8: the Seller's secret is injected by the harness (mintHashLock), not read out of the flow
    h.setTime(p.offerA.refundAfterMs);
    const connected = await h.buyerRail.connect(offerAcceptLockTerms(p.offerA, p.acceptA), { payer: h.buyerWallet.publicKey, payee: h.sellerWallet.publicKey });
    await connected.refund(p.ref);
    const roomStolen = dealRoom(p.acceptA.contract);
    await h.venue.post(roomStolen, encodeFrame({ type: "refund", from: h.buyer.did, contract: p.acceptA.contract, ref: p.ref }), h.buyer);
    await h.venue.post(roomStolen, encodeFrameWith({ type: "receipt", from: h.buyer.did, contract: p.acceptA.contract, outcome: "refunded", rail: SOL_RAIL_ID, ref: p.ref }, h.buyerRail.railRegistry), h.buyer);
  }
  if (kind === "refunded") {
    h.setTime(p.offerA.refundAfterMs);
    await h.buyerFlow.refundLegA();
    h.setTime(p.offerA.refundAfterMs + 24 * 60 * 60_000);
    await h.sellerFlow.refundLegB();
  }
  const legBContract = (tryDecodeFrame(p.acceptBRecord.line) as AcceptFrame).contract;
  const roomA = dealRoom(p.acceptA.contract);
  const roomB = dealRoom(legBContract);
  const dealRoomA = await h.venue.read(roomA);
  const { ns, key } = paperNote(legBContract);
  const rawNote = h.noteStore.raw(ns, key);
  await writeBundle({
    root: dir,
    nowMs: h.node.nowMs,
    offerRoomRecords: await h.venue.read(OFFER_ROOM),
    dealRooms: new Map([
      [roomA, opts.mapDealRoomA === undefined ? dealRoomA : opts.mapDealRoomA(dealRoomA, p.acceptA.contract)],
      [roomB, await h.venue.read(roomB)],
    ]),
    paperNotes: rawNote === undefined || opts.withPaperNote === false ? new Map() : new Map([[legBContract, rawNote]]),
    writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
    sol: {
      config: h.node.config,
      rpc: h.node.rpc(),
      ref: p.ref,
      terms: offerAcceptLockTerms(p.offerA, p.acceptA),
      // a sweep captures with the lines it could resolve at that moment: no payee line, no payee token read
      accounts: { ...(opts.capturePayee === false ? {} : { payee: h.sellerWallet.publicKey }), payer: h.buyerWallet.publicKey },
    },
    evidence: {
      swapId: p.swapId,
      legA: { contract: p.acceptA.contract, rail: SOL_RAIL_ID },
      legB: { contract: legBContract, rail: "paper" },
      feeBps: 0,
      writes: [],
      startedAtMs: T0,
      finishedAtMs: h.node.nowMs,
    },
  });
  const summary = JSON.parse(await readFile(join(dir, "evidence", `${p.swapId}.json`), "utf8")) as { status: string };
  return { h, swapId: p.swapId, hashLock: p.statement, ref: p.ref, legContract: p.acceptA.contract, legBContract, status: summary.status };
}

function replay(dir: string, extra: string[] = []) {
  const result = run(["--root", dir, "--json", ...extra]);
  const parsed = result.status === 0 ? (JSON.parse(result.stdout) as { swaps: Swap[]; solCaptureNotes: string[] }) : null;
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, parsed };
}

function swapOf(result: ReturnType<typeof replay>, swapId: string): Swap {
  const swap = result.parsed?.swaps.find((s) => s.swapId === swapId);
  if (swap === undefined) throw new Error(`replay found no swap ${swapId}: ${result.stdout.slice(0, 400)} ${result.stderr}`);
  return swap;
}

// -- the bundle and its replay -----------------------------------------------------------------------------------

describe("writeBundle with a Solana capture, replayed by examples/audit-export.mjs", () => {
  it("a settled swap replays to settled with the Solana rail claimed and final, keyed per leg contract", async () => {
    const built = await buildBundle(root, "settled");
    expect(built.status).toBe("settled");
    const rails = JSON.parse(await readFile(join(root, "rails.json"), "utf8"));
    expect(rails.sol.pin.caip2).toBe(SOL_LOCAL_PIN.caip2);
    // E1: the capture lives under <hash lock>/<leg contract>, never under the hash lock alone
    const dir = join(root, "raw", "sol", built.hashLock, built.legContract);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, files[0]!), "utf8")).ref).toBe(built.ref);

    const result = replay(root, ["--expect", `${built.swapId}=settled`]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const swap = swapOf(result, built.swapId);
    expect(swap.status).toBe("settled");
    expect(swap.settlementView.a).toBe("claimed");
    expect(swap.evidence.a).toMatchObject({ rail: SOL_RAIL_ID });
    expect(swap.evidence.aRail).toMatchObject({ status: "claimed", final: true, rail: SOL_RAIL_ID, ref: built.ref, contract: built.legContract });
    expect(swap.finalizedRefs.some((r) => r.startsWith(SOL_LOCAL_PIN.name))).toBe(true);
  });

  it("a locked swap replays as funded and verified; a refunded one replays as refunded", async () => {
    const locked = await buildBundle(root, "locked");
    const swap = swapOf(replay(root), locked.swapId);
    expect(swap.settlementView.a).toBe("funded");
    expect(swap.evidence.a).toMatchObject({ rail: SOL_RAIL_ID, railVerified: true });
    expect(swap.evidence.aRail).toMatchObject({ status: "locked", final: true });

    const dir2 = await mkdtemp(join(tmpdir(), "sol-audit-refunded-"));
    try {
      const refunded = await buildBundle(dir2, "refunded");
      const swap2 = swapOf(replay(dir2), refunded.swapId);
      expect(swap2.settlementView.a).toBe("refunded");
      expect(swap2.evidence.aRail).toMatchObject({ status: "refunded", final: true });
      expect(swap2.status).toMatch(/refunded/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("R3-9/R4-3: leg A refunded after a PAPER leg-B claim folds to refunded-a with the neutral reason (the note is unauthenticated, so the framing probe cannot brand a theft); an ordinary refund carries neither", async () => {
    const stolen = await buildBundle(root, "stolen");
    const swap = swapOf(replay(root), stolen.swapId);
    expect(swap.status).toBe("refunded-a");
    expect(swap.reasons).toContain(LEG_A_REFUNDED_LEG_B_CLAIMED_UNPROVEN);
    expect(swap.reasons).not.toContain(LEG_A_REFUNDED_AFTER_B_CLAIMED);
    expect(LEG_A_REFUNDED_LEG_B_CLAIMED_UNPROVEN).toBe("leg B claimed and leg A refunded; order or value not proven");
    expect(LEG_A_REFUNDED_AFTER_B_CLAIMED).toBe("leg A refunded after leg B was claimed: the Seller received neither leg");

    const dir2 = await mkdtemp(join(tmpdir(), "sol-audit-ordinary-refund-"));
    try {
      const refunded = await buildBundle(dir2, "refunded");
      expect(swapOf(replay(dir2), refunded.swapId).reasons).not.toContain(LEG_A_REFUNDED_AFTER_B_CLAIMED);
      expect(swapOf(replay(dir2), refunded.swapId).reasons).not.toContain(LEG_A_REFUNDED_LEG_B_CLAIMED_UNPROVEN);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("closed by default: the same root without a rails.sol config reads as an unregistered rail, with no chain evidence", async () => {
    const built = await buildBundle(root, "claimed");
    await rm(join(root, "rails.json"));
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.status).toBe("orientation-unsupported");
    expect(swap.reasons.join(" ")).toMatch(/unregistered rail/);
    expect(swap.evidence.a).toBeUndefined();
  });

  it("exits 2 with the reason when rails.json's sol config is invalid (mainnet refused by name)", async () => {
    await buildBundle(root, "locked");
    const rails = JSON.parse(await readFile(join(root, "rails.json"), "utf8"));
    rails.sol.pin = { ...rails.sol.pin, caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", name: "solana-mainnet-beta" };
    await writeFile(join(root, "rails.json"), JSON.stringify(rails));
    const result = run(["--root", root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/sol rail config is invalid/);
  });

  it("loadRails reads the sol config", async () => {
    const built = await buildBundle(root, "locked");
    const rails = loadRails(root, undefined);
    expect(Object.keys(rails)).toEqual(["sol"]);
    expect(rails.sol.programId).toBe(built.h.node.config.programId);
  });

  it("the replay still opens no network connection with a Solana leg on disk (the CLI imports no fetch)", async () => {
    await buildBundle(root, "claimed");
    const result = run(["--root", root]);
    expect(result.status).toBe(0);
  });

  it("a bundle asked to capture a Solana lock names the leg it belongs to: no Solana leg in the evidence is refused", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    await expect(
      writeBundle({
        root,
        nowMs: h.node.nowMs,
        offerRoomRecords: await h.venue.read(OFFER_ROOM),
        dealRooms: new Map(),
        paperNotes: new Map(),
        sol: { config: h.node.config, rpc: h.node.rpc(), ref: p.ref, terms: offerAcceptLockTerms(p.offerA, p.acceptA), accounts: {} },
        evidence: { swapId: p.swapId, legA: { contract: p.acceptA.contract, rail: "evm-htlc" }, legB: { contract: p.acceptA.contract, rail: "paper" }, feeBps: 0, writes: [], startedAtMs: T0, finishedAtMs: T0 },
      }),
    ).rejects.toThrow(/neither leg of the evidence is on the Solana rail/);
  });
});

// -- proven lines: both parties', required ----------------------------------------------------------------------

describe("P7: a verified Solana lock needs BOTH parties' proven lines", () => {
  /** Rewrites one party's account-line record(s) (same sender, same seq, freshly signed). */
  function rewriteLine(senderDid: string, rewrite: (line: string, contract: string) => string | null) {
    return (records: readonly TranscriptRecord[], contract: string): readonly TranscriptRecord[] =>
      records.flatMap((r) => {
        if (!r.line.startsWith("swap1 account") || r.sender !== senderDid) return [r];
        const line = rewrite(r.line, contract);
        return line === null ? [] : [record(r.room, r.seq, r.timestampMs, identityOf(r.sender), line)];
      });
  }

  it("an unproven payee (Seller) line leaves the payee unresolved: railVerified null, the leg is not funded", async () => {
    const built = await buildBundle(root, "locked", { mapDealRoomA: rewriteLine(ident(2).did, (line) => line.split(" proof ")[0] as string), capturePayee: false });
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.settlementView.a).not.toBe("funded");
    expect(swap.evidence.a.railVerified).toBeNull();
    expect(swap.evidence.a.reason).toMatch(/payee has no account line/);
  });

  it("a missing or unproven payer (Buyer) line is refused too (P7 fix F1): railVerified null", async () => {
    const dropped = await buildBundle(root, "locked", { mapDealRoomA: rewriteLine(ident(1).did, () => null) });
    const swap = swapOf(replay(root), dropped.swapId);
    expect(swap.settlementView.a).not.toBe("funded");
    expect(swap.evidence.a.railVerified).toBeNull();
    expect(swap.evidence.a.reason).toMatch(/payer has no proven account line/);

    const dir2 = await mkdtemp(join(tmpdir(), "sol-audit-unproven-payer-"));
    try {
      const unproven = await buildBundle(dir2, "locked", { mapDealRoomA: rewriteLine(ident(1).did, (line) => line.split(" proof ")[0] as string) });
      const swap2 = swapOf(replay(dir2), unproven.swapId);
      expect(swap2.evidence.a.railVerified).toBeNull();
      expect(swap2.evidence.a.reason).toMatch(/payer has no proven account line/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("a proven payee line for a wallet other than the one the escrow pays never verifies the lock", async () => {
    // the Seller's line is perfectly valid and proven, but for a DIFFERENT wallet than the escrow pays
    const built = await buildBundle(root, "locked", {
      mapDealRoomA: rewriteLine(ident(2).did, (_line, contract) => provenSolLine(solWallet(77), ident(2).did, contract, SOL_LOCAL_PIN.caip2)),
    });
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.settlementView.a).not.toBe("funded");
    expect(swap.evidence.a.railVerified).not.toBe(true);
  });

  it("R2-3-style: a conflicting proven payee line posted AFTER the accepted lock frame never re-resolves the payee (the lock stays verified)", async () => {
    const built = await buildBundle(root, "locked", {
      mapDealRoomA: (records, contract) => {
        const last = records[records.length - 1]!;
        const late = record(last.room, last.seq + 1, last.timestampMs + 1, ident(2), provenSolLine(solWallet(77), ident(2).did, contract, SOL_LOCAL_PIN.caip2));
        return [...records, late];
      },
    });
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.settlementView.a).toBe("funded");
    expect(swap.evidence.a.railVerified).toBe(true);
  });

  it("control: the unmodified bundle verifies", async () => {
    const built = await buildBundle(root, "locked");
    expect(swapOf(replay(root), built.swapId).evidence.a.railVerified).toBe(true);
  });
});

// -- capture loading and the honesty checks ---------------------------------------------------------------------

describe("raw/sol captures: per-pair keys, corruption and splices fail that leg closed", () => {
  it("loadSolCaptures returns an empty map when raw/sol does not exist", async () => {
    expect((await loadSolCaptures(root)).size).toBe(0);
  });

  it("loads the newest index per (hash lock, leg contract) with pre-verified raw/rpc bytes", async () => {
    const built = await buildBundle(root, "locked");
    const notes: string[] = [];
    const chain = await loadSolCaptures(root, notes);
    expect(notes).toEqual([]);
    const capture = chain.get(solCaptureKey(built.hashLock, built.legContract));
    expect(capture).toBeDefined();
    expect(capture.index.ref).toBe(built.ref);
    expect(capture.bytes.size).toBeGreaterThan(0);
  });

  it("two leg contracts sharing one hash lock each load into their own entry; the collision is noted", async () => {
    const built = await buildBundle(root, "locked");
    const otherLeg = `0x${"ab".repeat(32)}`;
    await cp(join(root, "raw", "sol", built.hashLock, built.legContract), join(root, "raw", "sol", built.hashLock, otherLeg), { recursive: true });
    const notes: string[] = [];
    const chain = await loadSolCaptures(root, notes);
    expect(chain.size).toBe(2);
    expect(chain.has(solCaptureKey(built.hashLock, built.legContract))).toBe(true);
    expect(chain.has(solCaptureKey(built.hashLock, otherLeg))).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/2 different leg contracts captured under this hash lock/);
  });

  it("a corrupted newest index prints a note, the replay still runs, and the leg fails closed (no older fallback)", async () => {
    const built = await buildBundle(root, "locked");
    await writeFile(join(root, "raw", "sol", built.hashLock, built.legContract, "zzz-newer-but-corrupt.json"), "{ not valid json");
    const result = replay(root);
    expect(result.status).toBe(0);
    expect(result.parsed!.solCaptureNotes).toHaveLength(1);
    expect(result.parsed!.solCaptureNotes[0]).toMatch(/zzz-newer-but-corrupt\.json.*skipped/);
    const swap = swapOf(result, built.swapId);
    expect(swap.settlementView.a).toBe("none");
    // the swap still folds as a swap (the registry reaches the evidence-less fold too), just without chain evidence
    expect(swap.status).not.toBe("orientation-unsupported");
    expect(swap.reasons.join(" ")).not.toMatch(/unregistered rail/);
  });

  it("with no evidence for either leg the swap still folds as a swap (the registry reaches the evidence-less fold)", async () => {
    const built = await buildBundle(root, "locked", { withPaperNote: false });
    await rm(join(root, "raw", "sol"), { recursive: true, force: true });
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.evidence.a).toBeUndefined();
    expect(swap.evidence.b).toBeUndefined();
    expect(swap.status).not.toBe("orientation-unsupported");
    expect(swap.reasons.join(" ")).not.toMatch(/unregistered rail/);
  });

  it("a tampered raw/rpc file (bytes no longer hash to their own filename) leaves the leg unverified, never thrown", async () => {
    const built = await buildBundle(root, "locked");
    const dir = join(root, "raw", "sol", built.hashLock, built.legContract);
    const index = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]!), "utf8")) as { exchanges: Array<{ responseSha256: string }> };
    await writeFile(join(root, "raw", "rpc", `${index.exchanges[2]!.responseSha256}.json`), "tampered, does not match its own filename's hash");
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.settlementView.a).toBe("none");
    expect(swap.evidence.a.railVerified).toBeNull();
    expect(swap.finalizedRefs.filter((r) => r.startsWith(SOL_LOCAL_PIN.name))).toEqual([]);
  });

  it("a capture that names ANOTHER payer's ref than the accepted lock frame leaves leg A without chain evidence (squat)", async () => {
    const built = await buildBundle(root, "locked");
    const dir = join(root, "raw", "sol", built.hashLock, built.legContract);
    const file = join(dir, (await readdir(dir))[0]!);
    const index = JSON.parse(await readFile(file, "utf8"));
    index.ref = `${built.hashLock}:${built.h.sellerWallet.publicKey}`; // a squatter's ref under the same hash lock
    await writeFile(file, JSON.stringify(index, null, 2));
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.settlementView.a).toBe("none");
    expect(swap.evidence.a.railVerified).toBeNull();
    expect(swap.evidence.a.reason).toMatch(/payer mismatch/);
  });

  it("a capture keyed under another leg contract is never used for this leg", async () => {
    const built = await buildBundle(root, "locked");
    const from = join(root, "raw", "sol", built.hashLock, built.legContract);
    await rm(join(root, "raw", "sol", built.hashLock, `0x${"cd".repeat(32)}`), { recursive: true, force: true });
    await cp(from, join(root, "raw", "sol", built.hashLock, `0x${"cd".repeat(32)}`), { recursive: true });
    await rm(from, { recursive: true, force: true });
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.settlementView.a).toBe("none"); // the only capture belongs to another leg contract
  });

  it("only genuine accepts count: an accept whose contract id is forged gets no evidence and does not disturb the genuine leg", async () => {
    const built = await buildBundle(root, "locked");
    const offerFile = join(root, "raw", OFFER_ROOM);
    const [name] = await readdir(offerFile);
    const rows = (await readFile(join(offerFile, name!), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { seq: number; from: string; text: string });
    const genuine = rows.find((r) => (tryDecodeFrame(r.text) as { type?: string; contract?: string } | null)?.type === "accept")!;
    const frame = JSON.parse(genuine.text.slice("tclk1 ".length)) as Record<string, unknown>;
    const stranger = ident(9);
    const forged = { ...frame, from: stranger.did, contract: `0x${"ee".repeat(32)}` };
    const line = `tclk1 ${JSON.stringify(forged)}`;
    const seq = Math.max(...rows.map((r) => r.seq)) + 1;
    const rec = record(OFFER_ROOM, seq, T0 + 99, stranger, line);
    await writeFile(
      join(offerFile, name!),
      `${(await readFile(join(offerFile, name!), "utf8")).trimEnd()}\n${JSON.stringify({ seq: rec.seq, ts: new Date(rec.timestampMs).toISOString(), from: rec.sender, nonce: rec.nonce, sig: rec.signature, text: rec.line })}\n`,
    );
    const swap = swapOf(replay(root), built.swapId);
    expect(swap.settlementView.a).toBe("funded");
    expect(swap.evidence.a.railVerified).toBe(true);
  });
});

// -- the live watcher --------------------------------------------------------------------------------------------

function wireRow(rec: TranscriptRecord) {
  return { seq: rec.seq, ts: new Date(rec.timestampMs).toISOString(), from: rec.sender, nonce: rec.nonce, sig: rec.signature, text: rec.line };
}

describe("runSweep with rails.sol", () => {
  async function sweepFixture(lateLine = false) {
    const h = solHarness();
    const p = await lockedFlow(h);
    const legBContract = (tryDecodeFrame(p.acceptBRecord.line) as AcceptFrame).contract;
    const roomA = dealRoom(p.acceptA.contract);
    const roomB = dealRoom(legBContract);
    const exportBody = `${(await h.venue.read(OFFER_ROOM)).map((r) => JSON.stringify(wireRow(r))).join("\n")}\n`;
    const roomARecords = [...(await h.venue.read(roomA))];
    if (lateLine) {
      // a conflicting PROVEN payee line for another wallet, posted after the accepted lock frame
      const last = roomARecords[roomARecords.length - 1]!;
      roomARecords.push(record(roomA, last.seq + 1, last.timestampMs + 1, ident(2), provenSolLine(solWallet(77), ident(2).did, p.acceptA.contract, SOL_LOCAL_PIN.caip2)));
    }
    const bodyA = JSON.stringify({ messages: roomARecords.map(wireRow) });
    const bodyB = JSON.stringify({ messages: (await h.venue.read(roomB)).map(wireRow) });
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === h.node.config.endpoint) return h.node.chain.fetch(input as string, init);
      if (url.endsWith("/r/tclk-offers/export")) return { status: 200, text: async () => exportBody } as Response;
      if (url.includes(roomA)) return { status: 200, text: async () => bodyA } as Response;
      if (url.includes(roomB)) return { status: 200, text: async () => bodyB } as Response;
      return { status: 404, text: async () => "" } as Response;
    }) as typeof fetch;
    return { h, p, legBContract, fetchImpl, calls };
  }

  it("captures the locked leg live: raw/sol/<hash lock>/<leg contract>, rails.json, solChainReads, a verified board", async () => {
    const { h, p, fetchImpl } = await sweepFixture();
    const report = await runSweep({ root, baseUrl: "https://technocore.example", nowMs: () => h.node.nowMs, board: buildBoard, rails: { sol: h.node.config }, fetch: fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.solChainReads).toBe(1);
    expect(report.solChainReadsSkipped).toEqual([]);
    expect(JSON.parse(await readFile(join(root, "rails.json"), "utf8"))).toEqual({ sol: h.node.config });
    const dir = join(root, "raw", "sol", p.statement, p.acceptA.contract);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, files[0]!), "utf8")).ref).toBe(p.ref);
    const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
    const view = board.swaps.find((s: { swapId: string }) => s.swapId === p.swapId);
    expect(view.evidence.a.railVerified).toBe(true);
    expect(view.evidence.aRail).toMatchObject({ status: "locked", final: true, rail: SOL_RAIL_ID });

    // a live sweep and an offline replay of the same root agree on the verdict
    const replayed = swapOf(replay(root), p.swapId);
    expect(replayed.evidence.a.railVerified).toBe(true);
    expect(replayed.settlementView.a).toBe(view.settlementView.a);
    expect(replayed.status).toBe(view.status);
  });

  it("R2-3-style: a conflicting proven payee line posted after the accepted lock frame does not unverify the live capture", async () => {
    const { h, p, fetchImpl } = await sweepFixture(true);
    const report = await runSweep({ root, baseUrl: "https://technocore.example", nowMs: () => h.node.nowMs, board: buildBoard, rails: { sol: h.node.config }, fetch: fetchImpl });
    expect(report.solChainReads).toBe(1);
    const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
    const view = board.swaps.find((s: { swapId: string }) => s.swapId === p.swapId);
    expect(view.evidence.a.railVerified).toBe(true);
    const index = JSON.parse(await readFile(join(root, "raw", "sol", p.statement, p.acceptA.contract, (await readdir(join(root, "raw", "sol", p.statement, p.acceptA.contract)))[0]!), "utf8"));
    expect(index.exchanges).toHaveLength(7); // the payee's token account WAS read: the payee resolved from the line before the lock
  });

  it("nothing Solana runs unless the caller configured the rail: no chain read, no raw/sol, the leg reads as an unregistered rail", async () => {
    const { h, p, fetchImpl, calls } = await sweepFixture();
    const report = await runSweep({ root, baseUrl: "https://technocore.example", nowMs: () => h.node.nowMs, board: buildBoard, fetch: fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.solChainReads).toBeUndefined();
    expect(calls.some((url) => url === h.node.config.endpoint)).toBe(false);
    expect(existsSync(join(root, "raw", "sol"))).toBe(false);
    const board = JSON.parse(await readFile(join(root, "board.json"), "utf8"));
    expect(board.swaps.find((s: { swapId: string }) => s.swapId === p.swapId).status).toBe("orientation-unsupported");
  });

  it("an invalid rails.sol config aborts the sweep before any read, with the reason on the report", async () => {
    const { h, fetchImpl, calls } = await sweepFixture();
    const bad = { ...h.node.config, pin: { ...h.node.config.pin, caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", name: "solana-mainnet-beta" } };
    const report = await runSweep({ root, baseUrl: "https://technocore.example", nowMs: () => h.node.nowMs, board: buildBoard, rails: { sol: bad }, fetch: fetchImpl });
    expect(report.railsConfigError).toMatch(/mainnet/);
    expect(calls).toEqual([]);
  });
});
