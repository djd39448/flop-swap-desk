// SPDX-License-Identifier: MIT
//
// tests/rehearsal-world.test.ts: P9-6, the local world the EVM rehearsal runner keeps in its state directory so a killed process can be
// replaced (src/client/rehearsal-world.ts): the venue and the paper notes made durable, the parties' Ed25519 venue seeds, and the
// one-runner lock. A venue must hand a flow what `MemoryVenue` does (same records, the same signature rule) and must still hold after a
// restart exactly what it returned before; a damaged file is a typed error and never an empty world.

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { MemoryNoteStore, verifyTranscriptRecord } from "@flop-labs/tclk";
import { afterAll, describe, expect, it } from "vitest";

import { MemoryVenue } from "../src/client/venue.js";
import {
  acquireRunLock,
  DurableNoteStore,
  DurableVenue,
  loadOrCreateIdentity,
  RehearsalWorldError,
  RunLockedError,
  writeFileDurable,
} from "../src/client/rehearsal-world.js";
import { identity } from "./helpers/identity.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rh-world-"));
  dirs.push(dir);
  return dir;
}

const signer = identity("31".repeat(32));
const other = identity("32".repeat(32));
const T = 1_790_000_000_000;

describe("writeFileDurable", () => {
  it("writes a file whole, replaces it whole, and leaves no temp file behind", async () => {
    const dir = await temp();
    const path = join(dir, "sub", "f.json");
    await writeFileDurable(path, "one\n");
    expect(await readFile(path, "utf8")).toBe("one\n");
    await writeFileDurable(path, "two\n");
    expect(await readFile(path, "utf8")).toBe("two\n");
    expect(await readdir(join(dir, "sub"))).toEqual(["f.json"]);
  });
});

describe("DurableVenue", () => {
  it("hands out the very records a MemoryVenue does (same seq, nonce, signature, stamp) and they verify", async () => {
    const dir = await temp();
    const durable = await DurableVenue.open(join(dir, "venue.json"), () => T);
    const memory = new MemoryVenue(() => T);
    for (const [room, line, who] of [
      ["tclk-offers", "one", signer],
      ["tclk-offers", "two", other],
      ["mb-p-tclk-aa", "three", signer],
    ] as const) {
      const a = await durable.post(room, line, who);
      const b = await memory.post(room, line, who);
      expect(a).toEqual(b);
      expect(verifyTranscriptRecord(a).ok).toBe(true);
    }
    expect((await durable.read("tclk-offers")).map((r) => r.seq)).toEqual([1, 2]);
    expect(await durable.read("never-used")).toEqual([]);
  });

  it("holds after a restart exactly what it returned before, and goes on numbering from there", async () => {
    const dir = await temp();
    const path = join(dir, "venue.json");
    const first = await DurableVenue.open(path, () => T);
    const posted = [await first.post("r", "a", signer), await first.post("r", "b", other), await first.post("s", "c", signer)];
    const second = await DurableVenue.open(path, () => T + 5);
    expect(await second.read("r")).toEqual([posted[0], posted[1]]);
    expect(await second.read("s")).toEqual([posted[2]]);
    const next = await second.post("r", "d", signer);
    expect(next.seq).toBe(3);
    expect(next.timestampMs).toBe(T + 5);
    expect((await (await DurableVenue.open(path, () => T)).read("r")).map((r) => r.line)).toEqual(["a", "b", "d"]);
  });

  it("writes before it answers: a post is on disk the moment it resolves", async () => {
    const dir = await temp();
    const path = join(dir, "venue.json");
    const venue = await DurableVenue.open(path, () => T);
    const record = await venue.post("r", "line", signer);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as { v: number; rooms: Record<string, unknown[]> };
    expect(onDisk.v).toBe(1);
    expect(onDisk.rooms.r).toEqual([record]);
  });

  it("serialises overlapping posts: every one lands, each with its own seq", async () => {
    const dir = await temp();
    const path = join(dir, "venue.json");
    const venue = await DurableVenue.open(path, () => T);
    const records = await Promise.all(Array.from({ length: 8 }, (_, i) => venue.post("r", `line ${i}`, signer)));
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await (await DurableVenue.open(path, () => T)).read("r")).map((r) => r.line)).toEqual(records.map((r) => r.line));
  });

  it("a post whose write failed is not a post: the venue shows nothing new, and the file is untouched", async () => {
    const dir = await temp();
    const path = join(dir, "venue.json");
    const venue = await DurableVenue.open(path, () => T);
    await venue.post("r", "kept", signer);
    const before = await readFile(path, "utf8");
    // The path becomes a directory: the rename onto it fails, which stands in for any failed write.
    await rm(path);
    await mkdir(path);
    await expect(venue.post("r", "lost", signer)).rejects.toThrow();
    expect((await venue.read("r")).map((r) => r.line)).toEqual(["kept"]);
    await rm(path, { recursive: true });
    await writeFile(path, before);
    expect((await (await DurableVenue.open(path, () => T)).read("r")).map((r) => r.line)).toEqual(["kept"]);
    // And the next post after a failed one is numbered as if the failed one never happened.
    expect((await venue.post("r", "after", signer)).seq).toBe(2);
  });

  it("refuses a damaged file instead of starting an empty venue", async () => {
    const dir = await temp();
    const path = join(dir, "venue.json");
    await writeFile(path, '{ "v": 1, "rooms": ');
    await expect(DurableVenue.open(path, () => T)).rejects.toThrow(RehearsalWorldError);
    await expect(DurableVenue.open(path, () => T)).rejects.toThrow(/is not valid JSON/);
    await writeFile(path, JSON.stringify({ v: 2, rooms: {} }));
    await expect(DurableVenue.open(path, () => T)).rejects.toThrow(/not a version 1 venue/);
    await writeFile(path, JSON.stringify({ v: 1, rooms: { r: "nope" } }));
    await expect(DurableVenue.open(path, () => T)).rejects.toThrow(/not a list/);
    // A record whose seq does not follow its position, or with a stray field, is not one this build wrote.
    const good = { room: "r", seq: 1, timestampMs: T, sender: signer.did, nonce: "10001", signature: "s", line: "l" };
    await writeFile(path, JSON.stringify({ v: 1, rooms: { r: [{ ...good, seq: 2 }] } }));
    await expect(DurableVenue.open(path, () => T)).rejects.toThrow(/does not fit room r at position 1/);
    await writeFile(path, JSON.stringify({ v: 1, rooms: { r: [{ ...good, extra: 1 }] } }));
    await expect(DurableVenue.open(path, () => T)).rejects.toThrow(/does not fit room r/);
    await writeFile(path, JSON.stringify({ v: 1, rooms: { r: [good] } }));
    expect((await (await DurableVenue.open(path, () => T)).read("r")).length).toBe(1);
  });
});

describe("DurableNoteStore", () => {
  it("applies tclk's conditional-write rules exactly as MemoryNoteStore does", async () => {
    const dir = await temp();
    const durable = await DurableNoteStore.open(join(dir, "notes.json"));
    const memory = new MemoryNoteStore();
    const steps: Array<[string, string, string, ({ ifAbsent: true } | { if: string })?]> = [
      ["ns", "k", "v1", { ifAbsent: true }],
      ["ns", "k", "v2", { ifAbsent: true }], // loses
      ["ns", "k", "v3", { if: "v1" }], // wins
      ["ns", "k", "v4", { if: "v1" }], // loses
      ["ns", "k", "v5"], // unconditional
      ["ns", "other", "x", { if: "nothing" }], // loses: absent is not "nothing"
    ];
    for (const [ns, key, value, condition] of steps) {
      expect(await durable.set(ns, key, value, condition)).toBe(await memory.set(ns, key, value, condition));
      expect(await durable.get(ns, key)).toBe(await memory.get(ns, key));
      expect(durable.raw(ns, key)).toBe(memory.raw(ns, key));
    }
    expect(await durable.get("ns", "never")).toBeNull();
  });

  it("holds its notes across a restart, and a refused write changes nothing on disk", async () => {
    const dir = await temp();
    const path = join(dir, "notes.json");
    const first = await DurableNoteStore.open(path);
    await first.set("tclk-paper-ab", "k1", "tclkpaper1 locked", { ifAbsent: true });
    expect(await first.set("tclk-paper-ab", "k1", "other", { ifAbsent: true })).toBe(false);
    const second = await DurableNoteStore.open(path);
    expect(await second.get("tclk-paper-ab", "k1")).toBe("tclkpaper1 locked");
    expect(await second.set("tclk-paper-ab", "k1", "tclkpaper1 claimed", { if: "tclkpaper1 locked" })).toBe(true);
    expect(await (await DurableNoteStore.open(path)).get("tclk-paper-ab", "k1")).toBe("tclkpaper1 claimed");
  });

  it("serialises overlapping writes (one wins an ifAbsent race)", async () => {
    const dir = await temp();
    const store = await DurableNoteStore.open(join(dir, "notes.json"));
    const wins = await Promise.all(Array.from({ length: 6 }, (_, i) => store.set("n", "k", `v${i}`, { ifAbsent: true })));
    expect(wins.filter(Boolean).length).toBe(1);
    expect(store.raw("n", "k")).toBe(`v${wins.indexOf(true)}`);
  });

  it("refuses a damaged notes file instead of starting an empty one", async () => {
    const dir = await temp();
    const path = join(dir, "notes.json");
    await writeFile(path, "{ nope");
    await expect(DurableNoteStore.open(path)).rejects.toThrow(/is not valid JSON/);
    await writeFile(path, JSON.stringify({ v: 1, notes: { "a/b": 7 } }));
    await expect(DurableNoteStore.open(path)).rejects.toThrow(/not text/);
    await writeFile(path, JSON.stringify({ v: 3, notes: {} }));
    await expect(DurableNoteStore.open(path)).rejects.toThrow(/not a version 1 notes file/);
  });
});

describe("loadOrCreateIdentity", () => {
  it("mints a seed once, then reads the same identity back; the identity shows only its DID", async () => {
    const dir = await temp();
    const path = join(dir, "buyer", "ed25519.seed");
    const first = await loadOrCreateIdentity(path);
    const again = await loadOrCreateIdentity(path);
    expect(again.did).toBe(first.did);
    expect(first.did).toMatch(/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
    const seed = (await readFile(path, "utf8")).trim();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    // The seed is not a member of the identity and no view of it shows it.
    expect(Object.keys(first).sort()).toEqual(["did", "sign"]);
    expect(JSON.stringify(first)).not.toContain(seed.slice(0, 16));
    expect(Object.isFrozen(first)).toBe(true);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    // Two parties get two different identities.
    expect((await loadOrCreateIdentity(join(dir, "seller", "ed25519.seed"))).did).not.toBe(first.did);
  });

  it("signs the way the venue's records need (they verify), before and after a restart", async () => {
    const dir = await temp();
    const path = join(dir, "x.seed");
    const venue = await DurableVenue.open(join(dir, "v.json"), () => T);
    const a = await loadOrCreateIdentity(path);
    const b = await loadOrCreateIdentity(path);
    expect(verifyTranscriptRecord(await venue.post("r", "one", a)).ok).toBe(true);
    expect(verifyTranscriptRecord(await venue.post("r", "two", b)).ok).toBe(true);
  });

  it("never overwrites or replaces a seed file that is not one of ours", async () => {
    const dir = await temp();
    const path = join(dir, "x.seed");
    await writeFile(path, "not a seed\n");
    await expect(loadOrCreateIdentity(path)).rejects.toThrow(/not 64 hex digits; it is never replaced/);
    expect(await readFile(path, "utf8")).toBe("not a seed\n");
  });
});

describe("acquireRunLock", () => {
  it("takes a lock, refuses a lock held by another live process, and releases only its own", async () => {
    const dir = await temp();
    const release = await acquireRunLock(dir);
    expect((await readFile(join(dir, "runner.lock"), "utf8")).split("\n")[0]).toBe(String(process.pid));
    await release();
    expect(await readdir(dir)).toEqual([]);

    // A live process that is not this one holds it.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await writeFile(join(dir, "runner.lock"), `${child.pid}\nfeedfacefeedface\n`);
      await expect(acquireRunLock(dir)).rejects.toThrow(RunLockedError);
      await expect(acquireRunLock(dir)).rejects.toThrow(/one runner per swap/);
      expect((await readFile(join(dir, "runner.lock"), "utf8")).split("\n")[0]).toBe(String(child.pid)); // left alone
    } finally {
      child.kill();
    }
  });

  it("breaks a lock whose holder is gone, and one that names this very pid (a restart under the same pid)", async () => {
    const dir = await temp();
    const { stdout } = await execFileAsync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    await writeFile(join(dir, "runner.lock"), `${stdout}\ndeadbeefdeadbeef\n`); // a process that has exited
    const release = await acquireRunLock(dir);
    await release();
    await writeFile(join(dir, "runner.lock"), `${process.pid}\ndeadbeefdeadbeef\n`);
    const again = await acquireRunLock(dir);
    await again();
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not remove a lock somebody else took after this one was broken", async () => {
    const dir = await temp();
    const release = await acquireRunLock(dir);
    await writeFile(join(dir, "runner.lock"), "99999999\nfeedfacefeedface\n");
    await release();
    expect(await readFile(join(dir, "runner.lock"), "utf8")).toBe("99999999\nfeedfacefeedface\n");
  });
});
