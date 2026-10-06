// SPDX-License-Identifier: MIT
//
// tests/flow-resume-begin.test.ts - review round 2, R2-04: two accepts of ONE offer through two store objects, and across processes.
//
// A Seller record is keyed by leg A's contract id, which is minted with the secret and so differs between two accepts of one offer: the
// per-key compare-and-swap never compares the two. The scan "is this offer already accepted", the mint and the create are therefore one
// critical section. Before round 2 it was serialised per store OBJECT only, so a runner that builds `new FileFlowStore(".state/flows")`
// per incoming offer (the README's own example) accepted a re-delivered offer twice: two secrets, two different accept A and offer B
// frames in the room. Now every store object on one directory shares one queue (`FlowStore.scopeId`) and the section runs inside the
// store's own `exclusive("seller-begin")` lock file, which fences other processes too.
//
// Ported from the idempotency lens of review round 2 (IDEM2-2) and the secrets lens (SEC2-C).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OFFER_ROOM, generateHashLock } from "@flop-labs/tclk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FlowRecordVersionError } from "../src/client/flow-record.js";
import { FlowRecordExistsError, FlowStoreLockedError } from "../src/client/flow-resume.js";
import { FileFlowStore, FlowStoreCorruptError, flowDigest, type FlowStore, type MemoryFlowStore } from "../src/client/flow-store.js";
import { SellerFlow } from "../src/client/seller.js";
import { STEPS, readSwap } from "./helpers/crash-matrix.js";
import { evmWorld } from "./helpers/matrix-worlds.js";
import { started, type Started } from "./helpers/resume-world.js";
import { sellerKeyOf } from "./helpers/seller-key.js";
import { framesIn } from "./helpers/sol-flow-harness.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rsm-begin-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An EVM world with the Buyer's offer A in the offers room, and a Seller factory that mints a FRESH secret per flow. */
async function afterTheBid(): Promise<{ s: Started; offerA: NonNullable<Awaited<ReturnType<typeof readSwap>>["offerA"]>; seller: (store: FileFlowStore) => SellerFlow }> {
  const s = await started(evmWorld, [STEPS.bid]);
  const offerA = (await readSwap(s.w)).offerA;
  if (offerA === undefined) throw new Error("the bid did not reach the offers room");
  return { s, offerA, seller: (store) => new SellerFlow({ ...s.w.sellerOptions(), store, mintHashLock: () => generateHashLock() }) };
}

/** What the Seller put in the offers room: its accept A frames and its offer B frames. */
async function sellerFrames(s: Started): Promise<{ accepts: number; offers: number }> {
  const records = (await s.w.venue.read(OFFER_ROOM)).filter((record) => record.sender === s.w.dids.seller);
  return { accepts: framesIn(records, "accept").length, offers: framesIn(records, "offer").length };
}

const sellerFiles = (dir: string): string[] => readdirSync(dir).filter((name) => /^seller-0x[0-9a-f]{64}[.]json$/.test(name));
const lockFiles = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".lock"));

describe("R2-04: two acceptLegA calls of one offer, each with its own FileFlowStore object on one directory", () => {
  it("exactly one is accepted: one FlowRecordExistsError, one accept A and one offer B in the room, one Seller record", async () => {
    const dir = join(root, "flows");
    const { s, offerA, seller } = await afterTheBid();
    // a runner that builds the store inline for each incoming offer, and the same offer arrives twice
    const results = await Promise.allSettled([
      seller(new FileFlowStore(dir)).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs),
      seller(new FileFlowStore(dir)).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(refused?.reason).toBeInstanceOf(FlowRecordExistsError);
    expect(await sellerFrames(s)).toEqual({ accepts: 1, offers: 1 });
    expect(sellerFiles(dir)).toHaveLength(1);
    expect(lockFiles(dir)).toEqual([]);
  });

  it("control: two calls on ONE store object are refused the same way", async () => {
    const dir = join(root, "flows");
    const { s, offerA, seller } = await afterTheBid();
    const shared = new FileFlowStore(dir);
    const results = await Promise.allSettled([seller(shared).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs), seller(shared).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason).toBeInstanceOf(FlowRecordExistsError);
    expect(await sellerFrames(s)).toEqual({ accepts: 1, offers: 1 });
    expect(sellerFiles(dir)).toHaveLength(1);
  });

  it("a second accept of the same offer AFTER the first finished is refused too, and a different offer is not", async () => {
    const dir = join(root, "flows");
    const { s, offerA, seller } = await afterTheBid();
    await seller(new FileFlowStore(dir)).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs);
    await expect(seller(new FileFlowStore(dir)).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)).rejects.toBeInstanceOf(FlowRecordExistsError);
    expect(await sellerFrames(s)).toEqual({ accepts: 1, offers: 1 });
  });
});

describe("R2-04: the begin section across processes", () => {
  /** A child process that sleeps (a live pid that is not ours). */
  const sleeper = (): ChildProcess => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("could not start a child process for the test");
    return child;
  };

  it("a begin lock held by a live process refuses acceptLegA with FlowStoreLockedError before anything is minted or posted", async () => {
    const dir = join(root, "flows");
    mkdirSync(dir);
    const { s, offerA, seller } = await afterTheBid();
    const other = sleeper();
    try {
      writeFileSync(join(dir, "seller-begin.lock"), `${other.pid}\n0123456789abcdef\n`);
      const error = await seller(new FileFlowStore(dir, { lockWaitMs: 0 })).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowStoreLockedError);
      expect((error as FlowStoreLockedError).holderPid).toBe(other.pid);
      expect(await sellerFrames(s)).toEqual({ accepts: 0, offers: 0 }); // nothing posted
      expect(sellerFiles(dir)).toEqual([]); // nothing stored: the secret was never minted
    } finally {
      other.kill();
    }
  });

  const supportsTypeStripping = (process.features as { typescript?: unknown }).typescript !== undefined && (process.features as { typescript?: unknown }).typescript !== false;

  it.skipIf(!supportsTypeStripping)("a real child process inside the section fences this process, and when it is killed there the stale lock is broken", async () => {
    const dir = join(root, "flows");
    const script = join(root, "hold.mjs");
    writeFileSync(
      script,
      [
        'const { FileFlowStore } = await import(process.env.STORE_MODULE);',
        'const store = new FileFlowStore(process.env.STORE_DIR, { lockWaitMs: 8000 });',
        'await store.exclusive("seller-begin", async () => {',
        '  process.stdout.write("held\\n");',
        "  await new Promise((done) => setTimeout(done, 120000));",
        "});",
        "",
      ].join("\n"),
    );
    const storeModule = pathToFileURL(fileURLToPath(new URL("../src/client/flow-store.ts", import.meta.url))).href;
    const child = spawn(process.execPath, ["--experimental-strip-types", script], {
      env: { ...process.env, STORE_MODULE: storeModule, STORE_DIR: dir },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await new Promise<void>((resolveHeld, rejectHeld) => {
        let seen = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          seen += chunk.toString("utf8");
          if (seen.includes("held")) resolveHeld();
        });
        child.on("exit", () => rejectHeld(new Error("the child exited before it held the section")));
      });
      const { s, offerA, seller } = await afterTheBid();
      // the child is inside the section: this process is refused, and nothing is minted or posted
      const error = await seller(new FileFlowStore(dir, { lockWaitMs: 0 })).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowStoreLockedError);
      expect((error as FlowStoreLockedError).holderPid).toBe(child.pid);
      expect(await sellerFrames(s)).toEqual({ accepts: 0, offers: 0 });
      expect(sellerFiles(dir)).toEqual([]);
      // the child dies inside the section (a crash during a begin): its lock names a dead pid and is broken
      const exited = new Promise<void>((done) => child.on("exit", () => done()));
      child.kill();
      await exited;
      await seller(new FileFlowStore(dir, { lockWaitMs: 100 })).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs);
      expect(await sellerFrames(s)).toEqual({ accepts: 1, offers: 1 });
      expect(sellerFiles(dir)).toHaveLength(1);
      expect(lockFiles(dir)).toEqual([]);
    } finally {
      child.kill();
    }
  });
});

// --- R2-05: the begin scan never skips a Seller record it cannot read ------------------------------------------------------------------

describe("R2-05: an unreadable Seller record blocks every new accept on its store until a person moves it aside", () => {
  const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

  /** The Seller accepted the offer once (secret p1, accept A1 and offer B1 posted). `mints` counts every secret minted since. */
  async function acceptedOnce(): Promise<{ s: Started; offerA: Awaited<ReturnType<typeof afterTheBid>>["offerA"]; store: MemoryFlowStore; mints: () => number; again: (store?: FlowStore) => SellerFlow; key: string }> {
    const s = await started(evmWorld, [STEPS.bid]);
    const offerA = (await readSwap(s.w)).offerA;
    if (offerA === undefined) throw new Error("the bid did not reach the offers room");
    const store = s.w.stores.seller;
    let minted = 0;
    const flow = (over?: FlowStore): SellerFlow =>
      new SellerFlow({
        ...s.w.sellerOptions(),
        store: over ?? store,
        mintHashLock: () => {
          minted += 1;
          return generateHashLock();
        },
      });
    await flow().acceptLegA(offerA, s.w.legB, s.w.lockTimeMs);
    expect(minted).toBe(1);
    return { s, offerA, store, mints: () => minted, again: flow, key: await sellerKeyOf(store) };
  }

  it("a garbage record: resume rejects with a corrupt-record error, a new acceptLegA of the same offer rejects with the typed error naming the key, and the room holds one accept A", async () => {
    const { s, offerA, store, mints, again, key } = await acceptedOnce();
    const stored = await store.load(key);
    if (stored === null) throw new Error("the Seller record vanished");
    await store.save(key, bytesOf("{garbage"), flowDigest(stored)); // disk damage

    await expect(SellerFlow.resume({ ...s.w.sellerOptions(), store, swapId: s.w.swapId, contractA: key.slice("seller:".length) })).rejects.toThrow(/corrupt/);
    const error = await again().acceptLegA(offerA, s.w.legB, s.w.lockTimeMs).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowStoreCorruptError);
    expect((error as FlowStoreCorruptError).key).toBe(key);
    expect(mints()).toBe(1); // nothing was minted for the second call
    expect(await sellerFrames(s)).toEqual({ accepts: 1, offers: 1 });
  });

  it("a record of a version this build does not know is refused as it is (FlowRecordVersionError), not skipped", async () => {
    const { s, offerA, store, mints, again, key } = await acceptedOnce();
    const stored = await store.load(key);
    if (stored === null) throw new Error("the Seller record vanished");
    const written = new TextDecoder().decode(stored);
    expect(written.startsWith('{"v":1,')).toBe(true);
    await store.save(key, bytesOf(written.replace('{"v":1,', '{"v":2,')), flowDigest(stored)); // written by a newer build, then a downgrade

    await expect(again().acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)).rejects.toBeInstanceOf(FlowRecordVersionError);
    expect(mints()).toBe(1);
    expect(await sellerFrames(s)).toEqual({ accepts: 1, offers: 1 });
  });

  it("a load that fails once with EIO for the key: acceptLegA rejects with that error, nothing is minted or posted, and once the disk answers again the offer is a FlowRecordExistsError", async () => {
    const { s, offerA, store, mints, again, key } = await acceptedOnce();
    let armed = true;
    const flaky: FlowStore = {
      scopeId: "flaky-handle",
      list: () => store.list(),
      save: (k, bytes, expected) => store.save(k, bytes, expected),
      load: async (k) => {
        if (armed && k === key) {
          armed = false;
          throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
        }
        return store.load(k);
      },
    };
    const error = await again(flaky).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("EIO");
    expect(mints()).toBe(1);
    expect(await sellerFrames(s)).toEqual({ accepts: 1, offers: 1 });
    await expect(again(flaky).acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)).rejects.toBeInstanceOf(FlowRecordExistsError);
    expect(mints()).toBe(1);
  });

  it("an unreadable record of ANOTHER swap blocks too: the scan cannot tell what it is for, so nothing is minted until a person moves it aside", async () => {
    const s = await started(evmWorld, [STEPS.bid]);
    const offerA = (await readSwap(s.w)).offerA;
    if (offerA === undefined) throw new Error("the bid did not reach the offers room");
    const store = s.w.stores.seller;
    await store.save(`seller:0x${"7e".repeat(32)}`, bytesOf("not a record"), null);
    let minted = 0;
    const flow = new SellerFlow({ ...s.w.sellerOptions(), mintHashLock: () => ((minted += 1), generateHashLock()) });
    await expect(flow.acceptLegA(offerA, s.w.legB, s.w.lockTimeMs)).rejects.toBeInstanceOf(FlowStoreCorruptError);
    expect(minted).toBe(0);
    expect(await sellerFrames(s)).toEqual({ accepts: 0, offers: 0 });
  });
});
