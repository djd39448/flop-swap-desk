// SPDX-License-Identifier: MIT
//
// tests/bundle-leak.test.ts - review round 1, R1-22 (main-loop decision 6, P8 rule 5: "the preimage appears in no log, frame (before the
// reveal), fixture, capture or bundle written by library code").
//
// A Solana claim sends the signed claim, and with it the secret (its instruction data), to the RPC endpoint twice (`simulateTransaction`,
// `sendTransaction`), and a claim that LANDS AND FAILS publishes it on chain. `SellerFlow` keeps the exchanges of every claim attempt
// (`flow.exchanges`, which a runner hands to `writeBundle` as `writeExchanges`). The question was whether a bundle written after a FAILED
// claim, before the reveal frame is posted, can hold the preimage.
//
// What was found (the premise this file keeps): `writeCapture` persists ONLY response bytes (`raw/rpc/<response sha256>.json`), never
// request bodies, so the request bodies the decision names do not reach a bundle. The RESPONSES do: when the Seller retries a failed claim
// "in public-secret mode" the rail proves the secret public by reading the failed transaction (`getTransaction`), and that response IS the
// signed transaction. Those exchanges were pushed into `exchanges`, and the bundle wrote them to `raw/rpc/`, preimage included, while no
// reveal had been posted. The fix: the exchanges of failed claim attempts are held out of `exchanges` until the reveal frame is posted
// (a failed claim names no `WriteEvidence`, so nothing in a summary points at them; after the reveal the secret is public by design and
// they join the list, response bytes intact). This file scans EVERY byte and file name of a real bundle in every form the secret takes: hex of
// both cases, base58, base64 and base64url, a JSON array, and every JSON string value decoded as base58 or base64 and searched for the 32 raw
// bytes (how it sits inside a serialized transaction).

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { OFFER_ROOM, dealRoom, paperNote, tryDecodeFrame, type AcceptFrame } from "@flop-labs/tclk";
import { base58, base64, base64url } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBundle } from "../src/client/bundle.js";
import { SOL_RAIL_ID } from "../src/rails/custom-rails.js";
import { offerAcceptLockTerms } from "../src/swap.js";
import { T0, framesIn, lockedFlow, solHarness, type SolHarness } from "./helpers/sol-flow-harness.js";

let root: string;
const made: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bundle-leak-"));
  made.push(root);
});
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

// --- the scan -----------------------------------------------------------------------------------------------------------------------

const TEXT_BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const TEXT_BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** The text forms a 32-byte secret takes. */
function secretForms(preimageHex: string): { text: string[]; bytes: Buffer } {
  const bare = preimageHex.replace(/^0x/, "");
  const bytes = Buffer.from(bare, "hex");
  const list = Array.from(bytes);
  return {
    bytes,
    text: [bare, bare.toUpperCase(), `0x${bare}`, base58.encode(bytes), base64.encode(bytes), base64.encode(bytes).replace(/=+$/, ""), base64url.encode(bytes), JSON.stringify(list), list.join(",")],
  };
}

/** Every string value (and key) of a parsed JSON document. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) (into.push(key), strings(item, into));
  return into;
}

/** Where `blob` holds the secret: as text in any form, as raw bytes, or inside an encoded string (base58 / base64) of a JSON document. */
export function holdsSecret(blob: Buffer, preimageHex: string): string | null {
  const { text, bytes } = secretForms(preimageHex);
  const asText = blob.toString("utf8");
  for (const form of text) if (asText.includes(form)) return `the text form ${form.slice(0, 10)}...`;
  if (blob.includes(bytes)) return "the raw bytes";
  let parsed: unknown;
  try {
    parsed = JSON.parse(asText);
  } catch {
    return null;
  }
  for (const value of strings(parsed)) {
    if (value.length < 32) continue;
    const candidates: Buffer[] = [];
    if (TEXT_BASE58.test(value)) {
      try {
        candidates.push(Buffer.from(base58.decode(value)));
      } catch {
        /* not base58 */
      }
    }
    if (TEXT_BASE64.test(value)) {
      for (const codec of [base64, base64url]) {
        try {
          candidates.push(Buffer.from(codec.decode(value.padEnd(Math.ceil(value.length / 4) * 4, "="))));
        } catch {
          /* not this base64 */
        }
      }
    }
    if (candidates.some((candidate) => candidate.includes(bytes))) return "an encoded string (base58 or base64) that decodes to bytes holding it";
  }
  return null;
}

/** Every file under `dir` (by relative path), and where in the bundle the secret is, by file name or by content. */
async function scanBundle(dir: string, preimageHex: string): Promise<{ files: number; leaks: string[] }> {
  const leaks: string[] = [];
  let files = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current)) {
      const path = join(current, entry);
      const shown = relative(dir, path);
      const nameHit = holdsSecret(Buffer.from(shown, "utf8"), preimageHex);
      if (nameHit !== null) leaks.push(`file name ${shown}: ${nameHit}`);
      if ((await stat(path)).isDirectory()) await walk(path);
      else {
        files += 1;
        const hit = holdsSecret(await readFile(path), preimageHex);
        if (hit !== null) leaks.push(`${shown}: ${hit}`);
      }
    }
  };
  await walk(dir);
  return { files, leaks };
}

// --- the scenarios ------------------------------------------------------------------------------------------------------------------

/** What `writeBundle` is given after a swap, exactly as a runner builds it: the rooms, the note, both flows' exchanges and the Solana capture. */
async function writeBundleOf(h: SolHarness, p: Awaited<ReturnType<typeof lockedFlow>>, dir: string): Promise<void> {
  const legBContract = (tryDecodeFrame(p.acceptBRecord.line) as AcceptFrame).contract;
  const roomA = dealRoom(p.acceptA.contract);
  const roomB = dealRoom(legBContract);
  const { ns, key } = paperNote(legBContract);
  const rawNote = h.noteStore.raw(ns, key);
  await writeBundle({
    root: dir,
    nowMs: h.node.nowMs,
    offerRoomRecords: await h.venue.read(OFFER_ROOM),
    dealRooms: new Map([
      [roomA, await h.venue.read(roomA)],
      [roomB, await h.venue.read(roomB)],
    ]),
    paperNotes: rawNote === undefined ? new Map() : new Map([[legBContract, rawNote]]),
    writeExchanges: [...h.buyerFlow.exchanges, ...h.sellerFlow.exchanges],
    sol: {
      config: h.node.config,
      rpc: h.node.rpc(),
      ref: p.ref,
      terms: offerAcceptLockTerms(p.offerA, p.acceptA),
      accounts: { payee: h.sellerWallet.publicKey, payer: h.buyerWallet.publicKey },
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
}

/** Freezes the payee's token account AFTER the claim's preflight and BEFORE it executes (the only way a claim can land and fail), and, when
 *  `recreate`, re-creates it right after each failed landing so the next retry's pre-checks pass. */
function armFailedClaim(h: SolHarness, recreate: boolean): void {
  h.node.midFlight = (kind) => {
    if (kind === "claim") h.node.freezeToken(h.sellerWallet.publicKeyBytes);
  };
  h.node.afterLand = (kind, failed) => {
    if (kind === "claim" && failed && recreate) h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n);
  };
}

describe("R1-22: a bundle written after a FAILED Solana claim, before the reveal is posted, does not hold the preimage", () => {
  it("the retries are exhausted (three claims landed and failed, the secret is public on chain, no reveal was posted): the bundle is clean", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const secret = h.sellerLock.preimage;
    armFailedClaim(h, true);
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/claim failed on chain and the secret is now public/);
    const onChain = h.node.history.filter((t) => t.kind === "claim" && t.err !== null);
    expect(onChain.length, "the failed claims are on chain with the preimage in their instruction data").toBe(3);
    expect(onChain[0]?.preimage).toBe(secret);
    expect(framesIn(await h.venue.read(dealRoom(p.acceptA.contract)), "reveal"), "before any reveal").toHaveLength(0);
    // the flow does not hand the failed attempts' exchanges to a bundle (the retries read the failed transactions back: those responses ARE the signed claim)
    for (const exchange of h.sellerFlow.exchanges) expect(holdsSecret(Buffer.from(exchange.responseBytes), secret), `${exchange.method}`).toBeNull();

    await writeBundleOf(h, p, root);
    const scan = await scanBundle(root, secret);
    expect(scan.files, "the bundle has files to scan (rpc captures, rooms, the note, the summary)").toBeGreaterThan(8);
    expect(scan.leaks).toEqual([]);
  });

  it("one failed claim, then the payee's account is back and the retry lands: the bundle written BEFORE the reveal is clean; after the reveal the held exchanges are released, response bytes intact", async () => {
    const h = solHarness();
    const p = await lockedFlow(h);
    const secret = h.sellerLock.preimage;
    armFailedClaim(h, false);
    await expect(h.sellerFlow.claimLegA(p.statement)).rejects.toThrow(/payee's associated token account/); // landed and failed, the retry refused
    expect(framesIn(await h.venue.read(dealRoom(p.acceptA.contract)), "reveal")).toHaveLength(0);
    const beforeReveal = await mkdtemp(join(tmpdir(), "bundle-leak-before-"));
    made.push(beforeReveal);
    await writeBundleOf(h, p, beforeReveal);
    expect((await scanBundle(beforeReveal, secret)).leaks).toEqual([]);
    // the failed claim's own send is not among the exchanges a bundle is built from (it is held until the reveal)
    const failedSignature = h.node.history.find((t) => t.kind === "claim" && t.err !== null)!.signature;
    const sentFailed = (exchange: { method: string; responseBody: string }): boolean => exchange.method === "sendTransaction" && exchange.responseBody.includes(failedSignature);
    expect(h.sellerFlow.exchanges.some(sentFailed)).toBe(false);

    // the payee re-creates its account; a while later the Seller claims again in public-secret mode and the reveal follows
    h.node.midFlight = undefined;
    h.node.afterLand = undefined;
    h.node.fundToken(h.sellerWallet.publicKeyBytes, 0n);
    h.setTime(p.offerA.refundAfterMs - 60_000);
    await h.sellerFlow.claimLegA(p.statement);
    expect(framesIn(await h.venue.read(dealRoom(p.acceptA.contract)), "reveal")).toHaveLength(1);
    expect(h.sellerFlow.exchanges.some(sentFailed), "once the secret is revealed, the failed claim's own exchanges (response bytes) join the ones a bundle persists").toBe(true);
  });

  it("the scan itself finds the secret where it is: raw, as hex, and inside an encoded transaction string", () => {
    const secret = `0x${"5a".repeat(32)}`;
    const bytes = Buffer.from("5a".repeat(32), "hex");
    expect(holdsSecret(Buffer.from(`xx ${secret.slice(2)} yy`), secret)).not.toBeNull();
    expect(holdsSecret(Buffer.concat([Buffer.from("abc"), bytes]), secret)).not.toBeNull();
    const transaction = Buffer.concat([Buffer.alloc(8, 7), bytes, Buffer.alloc(5, 9)]);
    expect(holdsSecret(Buffer.from(JSON.stringify({ result: { transaction: [base64.encode(transaction), "base64"] } })), secret)).not.toBeNull();
    expect(holdsSecret(Buffer.from(JSON.stringify({ data: base58.encode(transaction) })), secret)).not.toBeNull();
    expect(holdsSecret(Buffer.from(JSON.stringify({ data: base58.encode(Buffer.alloc(40, 3)) })), secret)).toBeNull();
  });
});
