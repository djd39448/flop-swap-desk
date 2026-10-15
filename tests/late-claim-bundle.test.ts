// SPDX-License-Identifier: MIT
//
// tests/late-claim-bundle.test.ts - P10 B5 (P10-BACKLOG-SPEC.md decision 5; R5-FUND-01, found by the main loop's opus read of fix pass 4).
//
// The late-claim path of the EVM rehearsal runner (P9-4 decision 13) ends `revealed` with exit 0 and a sentence that says the swap is settled on chain. P94-FUND-02 made the runner read
// leg A before it writes the bundle (`lateRevealGate`), but that read is the RUNNER's own, at the finalized block's NUMBER; the bundle's evidence reader reads leg A later, at the finalized
// block's HASH. Behind a load-balanced endpoint the two can answer differently, and the bundle then holds a leg A observation that says Locked under a `revealed` exit 0. So the runner also
// requires the bundle's OWN leg A observation (`writeBundle`'s `legARail`) to say claimed and final (`bundleLegAClaimed`), before the bundle is renamed into place or outcome.json is written.
//
// Here, hermetic: the REAL flows over the stateful mock node (tests/helpers/evm-mock-node.ts) settle a swap; the node can then answer block-HASH reads of `locks` as Locked while every other
// read is untouched (`hashReadsShowClaimedAsLocked`), which is the reviewer's endpoint. `writeBundle` is called as the runner calls it. The whole late run on a real node, with the exit code
// and the files, is tests-anvil/rehearsal-runner.anvil.test.ts.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryNoteStore, OFFER_ROOM, PaperRail, dealRoom, paperNote } from "@flop-labs/tclk";
import { getAddress, type Address } from "viem";
import { afterAll, describe, expect, it } from "vitest";

import { BuyerFlow } from "../src/client/buyer.js";
import { writeBundle, type WriteBundleResult } from "../src/client/bundle.js";
import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { parseRehearsalConfig } from "../src/client/rehearsal-config.js";
import { bundleLegAClaimed, EXIT, LATE_REVEAL_BUNDLE_NOT_CLAIMED, LATE_REVEAL_NOT_ON_CHAIN, LATE_REVEAL_SENTENCE, lateRevealGate, legAClaimedAtFinalized, type FinalityWorld } from "../src/client/rehearsal-run.js";
import { SellerFlow } from "../src/client/seller.js";
import { MemoryVenue } from "../src/client/venue.js";
import { swapId as computeSwapId } from "../src/profile.js";
import { ANVIL_LOCAL_PIN } from "../src/rails/evm-htlc.js";
import type { RailObservation } from "../src/types.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { identity, type Identity } from "./helpers/identity.js";
import { evmSigner } from "./helpers/proven-lines.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const T0 = 1_700_000_000_000;
const BUYER_SIGNER = evmSigner(0x511);
const SELLER_SIGNER = evmSigner(0x512);
const legAWindow = { claimByMs: T0 + 60 * 60_000, refundAfterMs: T0 + 90 * 60_000, expiresMs: T0 + 30 * 60_000 };
const legBWindow = { claimByMs: T0 + 120 * 60_000, refundAfterMs: T0 + 180 * 60_000, expiresMs: T0 + 40 * 60_000 };
const ident = (tag: number): Identity => identity(tag.toString(16).padStart(2, "0").repeat(32));

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A settled swap on the mock node: lock A, claim A, leg B claimed on the paper note, every frame posted. Returns what a runner hands to `writeBundle`. */
async function settledSwap() {
  const clock = (): number => T0;
  const node = new EvmMockNode(clock, getAddress(`0x${Buffer.from("late-claim-bundle-rail", "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`), getAddress(`0x${Buffer.from("late-claim-bundle-usdc", "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`), [BUYER_SIGNER, SELLER_SIGNER]);
  const venue = new MemoryVenue(clock);
  const noteStore = new MemoryNoteStore();
  const buyerIdentity = ident(0x31);
  const buyer = new BuyerFlow({
    identity: buyerIdentity,
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config: node.config(), rpc: node.rpc(), account: BUYER_SIGNER.address, clock }),
    clock,
  });
  const seller = new SellerFlow({
    identity: ident(0x32),
    venue,
    paperRail: new PaperRail(noteStore, clock),
    rail: createEvmCounterRail({ config: node.config(), rpc: node.rpc(), account: SELLER_SIGNER.address, clock }),
    clock,
  });
  const swapId = computeSwapId(buyerIdentity.did, "00000001");
  const offerA = await buyer.bid({ swapId, wantAsset: "FLOP", wantAmount: "52070000", wantRail: "flop-htlc", amount: "1000000", asset: "USDC", ...legAWindow });
  const accepted = await seller.acceptLegA(offerA, legBWindow, T0);
  const { acceptB, acceptBRecord } = await buyer.acceptLegB(accepted.offerBRecord, accepted.acceptARecord, T0);
  await seller.lockLegB(acceptBRecord);
  await buyer.verifyLegBLocked();
  await seller.postAccountLineA(SELLER_SIGNER.address);
  await buyer.postAccountLineA(BUYER_SIGNER.address);
  const lockA = await buyer.lockLegA();
  const claimed = await seller.claimLegA(lockA.hashLock);
  const secret = await buyer.learnSecret();
  await buyer.claimLegB(secret);
  return { node, venue, noteStore, buyer, seller, swapId, lockA, claimed, contractA: accepted.acceptA.contract, contractB: acceptB.contract };
}

type Swap = Awaited<ReturnType<typeof settledSwap>>;

/** `writeBundle`, called as the runner's `writeAndAudit` calls it (a fresh capture transport on the node, leg A's lock as the EVM capture). */
async function bundleOf(swap: Swap): Promise<{ written: WriteBundleResult; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "p10-b5-"));
  dirs.push(parent);
  const root = join(parent, "bundle");
  const { ns, key } = paperNote(swap.contractB);
  const rawNote = swap.noteStore.raw(ns, key);
  const written = await writeBundle({
    root,
    nowMs: T0,
    offerRoomRecords: await swap.venue.read(OFFER_ROOM),
    dealRooms: new Map([
      [dealRoom(swap.contractA), await swap.venue.read(dealRoom(swap.contractA))],
      [dealRoom(swap.contractB), await swap.venue.read(dealRoom(swap.contractB))],
    ]),
    paperNotes: rawNote === undefined ? new Map() : new Map([[swap.contractB, rawNote]]),
    writeExchanges: [...swap.buyer.exchanges, ...swap.seller.exchanges],
    evm: { config: swap.node.config(), rpc: swap.node.rpc(), hashLock: swap.lockA.hashLock },
    evidence: {
      swapId: swap.swapId,
      legA: { contract: swap.contractA, rail: "evm-htlc" },
      legB: { contract: swap.contractB, rail: "paper" },
      feeBps: 0,
      writes: [
        { leg: "a", step: "lock", rail: "evm-htlc", evidence: swap.lockA.writeEvidence },
        { leg: "a", step: "claim", rail: "evm-htlc", evidence: swap.claimed.evidence },
      ],
      startedAtMs: T0,
      finishedAtMs: T0,
    },
  });
  return { written, root };
}

/** The runner's own view of the same node: a `FinalityWorld` whose reads go through the node's transport (leg A is read at the finalized block's NUMBER). */
function runnerWorld(swap: Swap): FinalityWorld {
  const config = parseRehearsalConfig(
    { rails: { evm: { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock", contract: swap.node.railContract, assets: { USDC: swap.node.token } } }, buyerKeyFile: "b.key", sellerKeyFile: "s.key", amount: "1000000", out: "bundle", pollMs: 5_000 },
    "/base",
  );
  const errs: string[] = [];
  return {
    config,
    env: { now: () => T0, sleep: async () => undefined, out: () => undefined, err: (line) => void errs.push(line) },
    rpc: swap.node.rpc(),
    log: () => undefined,
    pollMs: 5_000,
  };
}

const observation = (status: RailObservation["status"], final: boolean): Pick<WriteBundleResult, "legARail"> => ({
  legARail: {
    status,
    final,
    checkedAtMs: T0,
    rail: "evm-htlc",
    ref: "ref",
    contract: "contract",
    terms: { rail: "evm-htlc", ref: "ref", contract: "contract" } as unknown as RailObservation["terms"],
  },
});

describe("P10 B5: the bundle's own leg A observation gates the late path", () => {
  it("bundleLegAClaimed says yes only for an observation that is claimed AND final; no observation, locked, refunded and not-final claimed are all no", () => {
    expect(bundleLegAClaimed(observation("claimed", true))).toBe(true);
    expect(bundleLegAClaimed(observation("claimed", false))).toBe(false);
    expect(bundleLegAClaimed(observation("locked", true))).toBe(false);
    expect(bundleLegAClaimed(observation("locked", false))).toBe(false);
    expect(bundleLegAClaimed(observation("refunded", true))).toBe(false);
    expect(bundleLegAClaimed({ legARail: undefined })).toBe(false);
  });

  it("a settled swap on the mock node: the bundle's own fold reports leg A claimed and final, and the status it records is settled", async () => {
    const swap = await settledSwap();
    const { written, root } = await bundleOf(swap);
    expect(written.legARail?.status).toBe("claimed");
    expect(written.legARail?.final).toBe(true);
    expect(bundleLegAClaimed(written)).toBe(true);
    expect(written.status).toBe("settled");
    // The result is the fold's own answer: the status it hands back is the one written into evidence/<swapId>.json.
    const summary = JSON.parse(await readFile(join(root, "evidence", `${swap.swapId}.json`), "utf8")) as { status?: unknown };
    expect(summary.status).toBe(written.status);
  });

  it("the reviewer's endpoint: block-HASH reads of locks answer Locked and every other read is untouched; the runner's own gate (a read at the finalized NUMBER) passes while the bundle's observation says locked", async () => {
    const swap = await settledSwap();
    swap.node.hashReadsShowClaimedAsLocked = true;
    const world = runnerWorld(swap);
    expect(await legAClaimedAtFinalized(world, swap.lockA.hashLock)).toBe(true); // the runner's own read: Claimed
    expect(await lateRevealGate(world, swap.lockA.hashLock, true)).toBeUndefined(); // so the first gate lets the late path go on
    const { written } = await bundleOf(swap); // the bundle's evidence reader reads by the finalized block's hash
    expect(written.legARail?.status).toBe("locked"); // what goes into the bundle
    expect(bundleLegAClaimed(written)).toBe(false); // so the second gate refuses
    swap.node.hashReadsShowClaimedAsLocked = false;
    expect(bundleLegAClaimed((await bundleOf(swap)).written)).toBe(true); // the same chain, read again once the endpoint agrees: claimed
  });

  it("the refusal is one fixed ASCII sentence with no value in it, distinct from the runner's own gate's sentence; it says no bundle was kept, nothing was sent and what to do", () => {
    const text = LATE_REVEAL_BUNDLE_NOT_CLAIMED;
    expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
    expect(/0x[0-9a-fA-F]|[0-9]/.test(text)).toBe(false); // no number, no hash, no time
    expect(text.includes(". ")).toBe(false); // one sentence
    expect(text.endsWith(".")).toBe(false);
    expect(text).toContain("the bundle's own read of leg A at the finalized block's hash does not show it claimed");
    expect(text).toContain("no bundle was kept; nothing was sent");
    expect(text).toContain("run --resume again once the endpoint's reads agree");
    expect(text).not.toContain("replays offline to revealed"); // the late-reveal sentence says the swap is settled; this one must not
    expect(text).not.toContain(LATE_REVEAL_SENTENCE);
    expect(text).not.toBe(LATE_REVEAL_NOT_ON_CHAIN);
    expect(EXIT.audit).toBe(6);
  });

  it("writeAndAudit checks the bundle's own observation after writeBundle and before the rename, the audit and outcome.json; the refusal is exit 6 and removes the staged copy (code order)", async () => {
    const text = await readFile(join(REPO_ROOT, "src", "client", "rehearsal-run.ts"), "utf8");
    const start = text.indexOf("async function writeAndAudit(");
    const end = text.indexOf("// --- the swap ---");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = text.slice(start, end);
    const at = (needle: string): number => body.indexOf(needle);
    const gate = 'if (parts.outcome === "revealed" && !bundleLegAClaimed(written)) {';
    const order = ["const written = await writeBundle({", gate, "await fsp.rename(stage, out);", "if (!(await auditBundle(w, out, parts.outcome))) return EXIT.audit;", "await writeFileDurable(join(w.stateDir, OUTCOME_FILE)"].map(at);
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.match(/bundleLegAClaimed\(written\)/g)?.length).toBe(1);
    const branch = body.slice(at(gate), body.indexOf("  }\n", at(gate)));
    expect(branch).toContain("await fsp.rm(stage, { recursive: true, force: true })");
    expect(branch).toContain("rehearsal: ${LATE_REVEAL_BUNDLE_NOT_CLAIMED}");
    expect(branch).toContain("return EXIT.audit;");
    expect(branch).not.toContain("rename");
    expect(branch).not.toContain("OUTCOME_FILE");
    expect(branch).not.toContain("LATE_REVEAL_SENTENCE");
    // the runner's own finalized-number read stays the first gate
    expect(text).toContain("const notOnChain = await lateRevealGate(w, lockA.hashLock, lateReveal);");
  });
});
