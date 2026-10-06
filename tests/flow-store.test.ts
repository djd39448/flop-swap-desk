// SPDX-License-Identifier: MIT
//
// tests/flow-store.test.ts: P8-RESUME-SPEC.md "Surface" and "Tests / Store". The flow store is the only place a
// resumable flow writes its swap record, so what it promises is pinned here: temp file + rename (a crash at any
// stage leaves the old value whole), a checksum that turns truncation or corruption into a typed error rather
// than an empty answer (rule 6), the key grammar, nothing written outside the directory, the file mode where
// the platform has one, and (review round 1) the SINGLE-WRITER compare-and-swap: a save presents the digest of what
// the caller last saw and is refused when the store holds something else (R1-02), the per-key lock file that makes
// that true across processes, the removal of a key's stale temp files inside the critical section (R1-17), and the
// durability steps after the rename (R1-20).

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlowRecordVersionError, loadFlowRecord, saveFlowRecord } from "../src/client/flow-record.js";
import {
  FileFlowStore,
  FlowRecordExistsError,
  FlowRecordStaleError,
  FlowStoreCorruptError,
  FlowStoreError,
  FlowStoreFaultError,
  FlowStoreKeyError,
  FlowStoreLockedError,
  FlowStoreWriteFailedError,
  MemoryFlowStore,
  flowDigest,
  flowKey,
  parseFlowKey,
  type FileSaveStep,
  type FlowStore,
} from "../src/client/flow-store.js";
import { sampleBuyerRecord } from "./helpers/flow-record-samples.js";

const SWAP_A = `0x${"ab".repeat(32)}`;
const SWAP_B = `0x${"cd".repeat(32)}`;
const KEY_BUYER = `buyer:${SWAP_A}`;
const KEY_SELLER = `seller:${SWAP_A}`;
const KEY_OTHER = `buyer:${SWAP_B}`;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (value: Uint8Array | null): string | null => (value === null ? null : new TextDecoder().decode(value));
/** The digest a caller holds after it saved or loaded `value`. */
const digestOf = (value: string): string => flowDigest(bytes(value));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flowstore-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("key grammar", () => {
  it("builds and parses buyer:<swapId> and seller:<contractA>", () => {
    expect(flowKey("buyer", SWAP_A)).toBe(KEY_BUYER);
    expect(flowKey("seller", SWAP_A)).toBe(KEY_SELLER);
    expect(parseFlowKey(KEY_BUYER)).toEqual({ role: "buyer", swapId: SWAP_A });
    expect(parseFlowKey(KEY_SELLER)).toEqual({ role: "seller", swapId: SWAP_A }); // for a Seller key the id is leg A's contract id
  });

  it("refuses anything else, including path tricks and a trailing newline", () => {
    const bad = [
      "",
      "buyer",
      "buyer:",
      "buyer:0x",
      `buyer:${SWAP_A.toUpperCase()}`,
      `buyer:0X${"ab".repeat(32)}`,
      `buyer:${"ab".repeat(32)}`,
      `buyer:0x${"ab".repeat(31)}`,
      `buyer:0x${"ab".repeat(33)}`,
      `operator:${SWAP_A}`,
      `Buyer:${SWAP_A}`,
      `buyer:${SWAP_A}\n`,
      ` buyer:${SWAP_A}`,
      `buyer:${SWAP_A}.json`,
      `buyer:../${SWAP_A}`,
      `buyer:..\\${SWAP_A}`,
      `../seller:${SWAP_A}`,
      `buyer-${SWAP_A}`,
    ];
    for (const key of bad) {
      expect(() => parseFlowKey(key), JSON.stringify(key)).toThrow(FlowStoreKeyError);
    }
    expect(() => flowKey("buyer", "0x1234")).toThrow(FlowStoreKeyError);
    expect(() => flowKey("operator" as "buyer", SWAP_A)).toThrow(FlowStoreKeyError);
  });

  it("is enforced by both stores on every call", async () => {
    const memory = new MemoryFlowStore();
    const file = new FileFlowStore(join(root, "flows"));
    for (const store of [memory, file]) {
      await expect(store.load("buyer:../../etc/passwd")).rejects.toThrow(FlowStoreKeyError);
      await expect(store.save("buyer:../../etc/passwd", bytes("x"), null)).rejects.toThrow(FlowStoreKeyError);
      await expect(store.save("whatever", bytes("x"), null)).rejects.toThrow(FlowStoreKeyError);
    }
    expect(memory.saveCount).toBe(0); // a refused key is not even logged as a save
  });
});

describe("MemoryFlowStore", () => {
  it("round-trips by value, not by reference, and lists sorted keys", async () => {
    const store = new MemoryFlowStore();
    expect(await store.load(KEY_BUYER)).toBeNull();
    const input = bytes("one");
    await store.save(KEY_BUYER, input, null);
    input[0] = 0x58; // the caller mutates its array afterwards
    const got = await store.load(KEY_BUYER);
    expect(text(got)).toBe("one");
    got![0] = 0x59; // a loaded array is a copy too
    expect(text(await store.load(KEY_BUYER))).toBe("one");
    await store.save(KEY_OTHER, bytes("two"), null);
    await store.save(KEY_SELLER, bytes("three"), null);
    expect(await store.list()).toEqual([KEY_BUYER, KEY_OTHER, KEY_SELLER].sort());
  });

  it("logs every save, in order, with a copy of the bytes", async () => {
    const store = new MemoryFlowStore();
    await store.save(KEY_BUYER, bytes("a"), null);
    await store.save(KEY_SELLER, bytes("b"), null);
    await store.save(KEY_BUYER, bytes("c"), digestOf("a"));
    expect(store.saveCount).toBe(3);
    expect(store.saves.map((s) => [s.n, s.key, text(s.bytes), s.outcome])).toEqual([
      [1, KEY_BUYER, "a", "ok"],
      [2, KEY_SELLER, "b", "ok"],
      [3, KEY_BUYER, "c", "ok"],
    ]);
  });

  it("failSave(n) refuses the n-th save across all keys and stores nothing", async () => {
    const store = new MemoryFlowStore().failSave(2);
    await store.save(KEY_BUYER, bytes("first"), null);
    await expect(store.save(KEY_BUYER, bytes("second"), digestOf("first"))).rejects.toThrow(FlowStoreFaultError);
    expect(text(await store.load(KEY_BUYER))).toBe("first"); // the old value survives
    await store.save(KEY_BUYER, bytes("third"), digestOf("first")); // later saves pass
    expect(text(await store.load(KEY_BUYER))).toBe("third");
    expect(store.saves.map((s) => s.outcome)).toEqual(["ok", "reject", "ok"]);
  });

  it("commit-then-throw stores the bytes and still throws (the write landed, the ack was lost)", async () => {
    const store = new MemoryFlowStore().failSave(1, "commit-then-throw");
    await expect(store.save(KEY_SELLER, bytes("landed"), null)).rejects.toThrow(FlowStoreFaultError);
    expect(text(await store.load(KEY_SELLER))).toBe("landed");
    expect(store.saves[0]?.outcome).toBe("commit-then-throw");
  });

  it("failSaveWhen decides per call and clearFaults disarms everything", async () => {
    const store = new MemoryFlowStore().failSaveWhen((_n, key, payload) => (key === KEY_SELLER && text(payload) === "preimage" ? "reject" : undefined));
    await store.save(KEY_BUYER, bytes("preimage"), null); // wrong key: passes
    await expect(store.save(KEY_SELLER, bytes("preimage"), null)).rejects.toThrow(FlowStoreFaultError);
    await store.save(KEY_SELLER, bytes("other"), null); // wrong payload: passes
    store.failSave(5);
    store.clearFaults();
    await store.save(KEY_SELLER, bytes("preimage"), digestOf("other")); // disarmed
    expect(text(await store.load(KEY_SELLER))).toBe("preimage");
  });

  it("rejects an invalid failSave number", () => {
    expect(() => new MemoryFlowStore().failSave(0)).toThrow();
    expect(() => new MemoryFlowStore().failSave(1.5)).toThrow();
  });

  it("every fault is a FlowStoreWriteFailedError carrying the key (the journal's one catchable family)", async () => {
    const store = new MemoryFlowStore().failSave(1);
    const error = await store.save(KEY_BUYER, bytes("x"), null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowStoreFaultError);
    expect(error).toBeInstanceOf(FlowStoreWriteFailedError);
    expect((error as FlowStoreWriteFailedError).key).toBe(KEY_BUYER);
  });
});

/** The compare-and-swap contract, the same for both stores (R1-02). */
describe.each<[string, () => FlowStore]>([
  ["MemoryFlowStore", () => new MemoryFlowStore()],
  ["FileFlowStore", () => new FileFlowStore(join(root, "cas"))],
])("%s: save is a compare-and-swap on the digest of the last bytes seen (R1-02)", (_name, make) => {
  it("a create over an existing key is FlowRecordExistsError and changes nothing", async () => {
    const store = make();
    await store.save(KEY_BUYER, bytes("first"), null);
    const error = await store.save(KEY_BUYER, bytes("second"), null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordExistsError);
    expect((error as FlowRecordExistsError).key).toBe(KEY_BUYER);
    expect(text(await store.load(KEY_BUYER))).toBe("first");
  });

  it("a save whose digest is not what is stored is FlowRecordStaleError (expected and actual named) and changes nothing", async () => {
    const store = make();
    await store.save(KEY_BUYER, bytes("first"), null);
    await store.save(KEY_BUYER, bytes("second"), digestOf("first")); // another writer got there first
    const error = await store.save(KEY_BUYER, bytes("mine"), digestOf("first")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordStaleError);
    expect((error as FlowRecordStaleError).expected).toBe(digestOf("first"));
    expect((error as FlowRecordStaleError).actual).toBe(digestOf("second"));
    expect(text(await store.load(KEY_BUYER))).toBe("second");
  });

  it("a save over a key that holds nothing is stale too (the record vanished), never a silent create", async () => {
    const store = make();
    const error = await store.save(KEY_BUYER, bytes("mine"), digestOf("gone")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordStaleError);
    expect((error as FlowRecordStaleError).actual).toBeNull();
    expect(await store.load(KEY_BUYER)).toBeNull();
  });

  it("the right digest chains: every save names the digest of the one before", async () => {
    const store = make();
    await store.save(KEY_BUYER, bytes("v1"), null);
    await store.save(KEY_BUYER, bytes("v2"), digestOf("v1"));
    await store.save(KEY_BUYER, bytes("v3"), digestOf("v2"));
    expect(text(await store.load(KEY_BUYER))).toBe("v3");
    expect(flowDigest((await store.load(KEY_BUYER))!)).toBe(digestOf("v3"));
  });

  it("anything but null or a sha256 hex is refused before the store is touched", async () => {
    const store = make();
    for (const bad of [undefined, "", "abc", digestOf("x").toUpperCase(), 7, `${digestOf("x")}0`]) {
      await expect(store.save(KEY_BUYER, bytes("x"), bad as unknown as string), String(bad)).rejects.toBeInstanceOf(FlowStoreError);
    }
    expect(await store.load(KEY_BUYER)).toBeNull();
  });

  it("two creates racing on one key: exactly one wins, the other is FlowRecordExistsError", async () => {
    const store = make();
    const results = await Promise.allSettled([store.save(KEY_BUYER, bytes("alpha"), null), store.save(KEY_BUYER, bytes("beta"), null)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(FlowRecordExistsError);
    expect(["alpha", "beta"]).toContain(text(await store.load(KEY_BUYER)));
  });

  it("twelve saves racing with the same digest: exactly one wins and the rest are stale; the stored value is the winner's whole value", async () => {
    const store = make();
    await store.save(KEY_BUYER, bytes("base"), null);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.save(KEY_BUYER, bytes(`value-${i}`), digestOf("base"))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(FlowRecordStaleError);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    expect(text(await store.load(KEY_BUYER))).toBe(`value-${winner}`);
  });

  it("different keys do not interfere", async () => {
    const store = make();
    await Promise.all([store.save(KEY_BUYER, bytes("a"), null), store.save(KEY_OTHER, bytes("b"), null), store.save(KEY_SELLER, bytes("c"), null)]);
    expect((await store.list()).length).toBe(3);
  });
});

describe("MemoryFlowStore: the compare-and-swap in the log", () => {
  it("a refused compare is logged as stale or exists, and a fault armed on that number still fires first", async () => {
    const store = new MemoryFlowStore();
    await store.save(KEY_BUYER, bytes("a"), null);
    await store.save(KEY_BUYER, bytes("b"), null).catch(() => undefined);
    await store.save(KEY_BUYER, bytes("c"), digestOf("zzz")).catch(() => undefined);
    store.failSave(4);
    await store.save(KEY_BUYER, bytes("d"), digestOf("zzz")).catch(() => undefined);
    expect(store.saves.map((s) => s.outcome)).toEqual(["ok", "exists", "stale", "reject"]);
  });

  it("commit-then-throw is not applied over a stale digest: the compare comes first", async () => {
    const store = new MemoryFlowStore().failSave(2, "commit-then-throw");
    await store.save(KEY_BUYER, bytes("a"), null);
    const error = await store.save(KEY_BUYER, bytes("b"), digestOf("not a")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowRecordStaleError);
    expect(text(await store.load(KEY_BUYER))).toBe("a");
  });
});

/** A pid that is certainly gone: a child that already exited. */
function deadPid(): number {
  for (let i = 0; i < 20; i += 1) {
    const pid = spawnSync(process.execPath, ["-e", "0"]).pid;
    if (typeof pid !== "number") continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as { code?: string }).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a dead pid for the test");
}

/** A pid that is certainly alive until `stop()`: a child that sleeps. */
function livePid(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("could not start a child process for the test");
  return { pid: child.pid, stop: () => void child.kill() };
}

const lockBody = (pid: number): string => `${pid}\n${"ab".repeat(8)}\n`;

describe("FileFlowStore", () => {
  it("round-trips, replaces whole, returns null for a missing key and lists keys", async () => {
    const dir = join(root, "flows");
    const store = new FileFlowStore(dir);
    expect(await store.load(KEY_BUYER)).toBeNull();
    expect(await store.list()).toEqual([]); // the directory does not exist yet
    await store.save(KEY_BUYER, bytes("v1 of the buyer record"), null);
    await store.save(KEY_SELLER, bytes("the seller record"), null);
    expect(text(await store.load(KEY_BUYER))).toBe("v1 of the buyer record");
    await store.save(KEY_BUYER, bytes("v2"), digestOf("v1 of the buyer record"));
    expect(text(await store.load(KEY_BUYER))).toBe("v2");
    expect(await store.list()).toEqual([KEY_BUYER, KEY_SELLER].sort());
    // a fresh instance over the same directory sees the same thing (what resume relies on)
    expect(text(await new FileFlowStore(dir).load(KEY_SELLER))).toBe("the seller record");
  });

  it("round-trips arbitrary bytes, including an empty payload and every byte value", async () => {
    const store = new FileFlowStore(join(root, "flows"));
    const everything = Uint8Array.from({ length: 256 }, (_, i) => i);
    await store.save(KEY_BUYER, everything, null);
    expect(Array.from((await store.load(KEY_BUYER))!)).toEqual(Array.from(everything));
    await store.save(KEY_SELLER, new Uint8Array(0), null);
    expect((await store.load(KEY_SELLER))!.length).toBe(0);
  });

  it("names the file <role>-<id>.json (a colon is not a Windows file name character) and leaves no lock behind", async () => {
    const dir = join(root, "flows");
    await new FileFlowStore(dir).save(KEY_BUYER, bytes("x"), null);
    expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
  });

  it("writes a temp file in the same directory first and renames it: stages in order, the key's lock held throughout, nothing left behind", async () => {
    const dir = join(root, "flows");
    const seen: Array<{ step: FileSaveStep; files: string[] }> = [];
    const store = new FileFlowStore(dir, {
      onStep: (step) => {
        seen.push({ step, files: readdirSync(dir).sort() });
      },
    });
    await store.save(KEY_BUYER, bytes("payload"), null);
    const final = `buyer-${SWAP_A}.json`;
    const lock = `buyer-${SWAP_A}.lock`;
    const expectedSteps: FileSaveStep[] = process.platform === "win32" ? ["tmp-written", "file-synced", "renamed", "target-synced"] : ["tmp-written", "file-synced", "renamed", "dir-synced"];
    expect(seen.map((s) => s.step)).toEqual(expectedSteps);
    // every stage runs inside the critical section: the lock file is there
    for (const stage of seen) expect(stage.files).toContain(lock);
    // before the rename only the temp file (and the lock) exists, named after the final file with a .tmp- suffix
    for (const stage of seen.slice(0, 2)) {
      const others = stage.files.filter((name) => name !== lock);
      expect(others).toHaveLength(1);
      expect(others[0]).toMatch(new RegExp(`^${final.replace(".", "\\.")}\\.tmp-${process.pid}-[0-9a-f]{12}$`));
    }
    // after the rename only the final file (and the lock) exists
    for (const stage of seen.slice(2)) expect(stage.files).toEqual([final, lock].sort());
    expect(readdirSync(dir)).toEqual([final]);
  });

  it("the lock file names the holder's pid", async () => {
    const dir = join(root, "flows");
    let body = "";
    const store = new FileFlowStore(dir, {
      onStep: (step) => {
        if (step === "tmp-written") body = readFileSync(join(dir, `buyer-${SWAP_A}.lock`), "utf8");
      },
    });
    await store.save(KEY_BUYER, bytes("x"), null);
    expect(body).toMatch(new RegExp(`^${process.pid}\\n[0-9a-f]{16}\\n$`));
  });

  it("fsyncs the temp file BEFORE the rename, and the directory (POSIX) or the renamed file (Windows) AFTER it", async () => {
    const probe = await fsp.open(join(root, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as { sync: (this: unknown) => Promise<void> };
    await probe.close();
    const realSync = proto.sync;
    const realRename = fsp.rename.bind(fsp);
    const order: string[] = [];
    const syncSpy = vi.spyOn(proto, "sync").mockImplementation(function (this: unknown) {
      order.push("fsync");
      return realSync.call(this);
    });
    const renameSpy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      order.push("rename");
      return realRename(from, to);
    });
    try {
      await new FileFlowStore(join(root, "flows")).save(KEY_BUYER, bytes("x"), null);
    } finally {
      syncSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(order).toEqual(["fsync", "rename", "fsync"]);
  });

  it.skipIf(process.platform === "win32")("fsyncs the directory after the rename (not on Windows, which cannot)", async () => {
    const steps: FileSaveStep[] = [];
    await new FileFlowStore(join(root, "flows"), { onStep: (step) => void steps.push(step) }).save(KEY_BUYER, bytes("x"), null);
    expect(steps.at(-1)).toBe("dir-synced");
  });

  it.each<FileSaveStep>(["tmp-written", "file-synced"])("a crash at %s leaves the previous value whole, no temp file and no lock", async (crashAt) => {
    const dir = join(root, "flows");
    await new FileFlowStore(dir).save(KEY_BUYER, bytes("old value"), null);
    const crashing = new FileFlowStore(dir, {
      onStep: (step) => {
        if (step === crashAt) throw new Error("simulated crash");
      },
    });
    await expect(crashing.save(KEY_BUYER, bytes("new value"), digestOf("old value"))).rejects.toThrow("simulated crash");
    expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("old value");
    expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
  });

  it("a crash after the rename means the new value is the one on disk", async () => {
    const dir = join(root, "flows");
    await new FileFlowStore(dir).save(KEY_BUYER, bytes("old value"), null);
    const crashing = new FileFlowStore(dir, {
      onStep: (step) => {
        if (step === "renamed") throw new Error("simulated crash");
      },
    });
    await expect(crashing.save(KEY_BUYER, bytes("new value"), digestOf("old value"))).rejects.toThrow("simulated crash");
    expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("new value");
  });

  it("a stale temp file from a crashed process is never listed and never read as the record", async () => {
    const dir = join(root, "flows");
    const store = new FileFlowStore(dir);
    await store.save(KEY_BUYER, bytes("good"), null);
    writeFileSync(join(dir, `buyer-${SWAP_A}.json.tmp-9999-abcdef012345`), "half a record");
    writeFileSync(join(dir, `seller-${SWAP_A}.json.tmp-9999-abcdef012345`), "half a record");
    writeFileSync(join(dir, "notes.txt"), "unrelated");
    expect(await store.list()).toEqual([KEY_BUYER]);
    expect(text(await store.load(KEY_BUYER))).toBe("good");
    expect(await store.load(KEY_SELLER)).toBeNull();
    await store.save(KEY_BUYER, bytes("better"), digestOf("good")); // saving is unaffected by the debris
    expect(text(await store.load(KEY_BUYER))).toBe("better");
  });

  describe("R1-17: a key's stale temp files are removed inside its critical section", () => {
    it("a planted <name>.tmp-* of the saved key is gone after the save, another key's temp file and unrelated files stay", async () => {
      const dir = join(root, "flows");
      const store = new FileFlowStore(dir);
      await store.save(KEY_BUYER, bytes("good"), null);
      const stale = `buyer-${SWAP_A}.json.tmp-1-abc`;
      const staleOther = `buyer-${SWAP_A}.json.tmp-424242-0123456789ab`; // a dead process's, with this build's own naming
      const otherKey = `buyer-${SWAP_B}.json.tmp-1-abc`;
      const sellerKey = `seller-${SWAP_A}.json.tmp-1-abc`;
      for (const name of [stale, staleOther, otherKey, sellerKey, "notes.txt", `buyer-${SWAP_A}.json.tmp-`]) writeFileSync(join(dir, name), "the whole record, preimage and all");
      await store.save(KEY_BUYER, bytes("better"), digestOf("good"));
      const left = readdirSync(dir).sort();
      expect(left).not.toContain(stale);
      expect(left).not.toContain(staleOther);
      expect(left).toContain(otherKey);
      expect(left).toContain(sellerKey);
      expect(left).toContain("notes.txt");
      expect(left).toContain(`buyer-${SWAP_A}.json.tmp-`); // the prefix alone is not a temp file of this build: left alone
      expect(left).toContain(`buyer-${SWAP_A}.json`);
    });

    it("never touches anything outside the directory", async () => {
      const parent = join(root, "parent");
      const dir = join(parent, "flows");
      mkdirSync(parent);
      const outside = join(parent, `buyer-${SWAP_A}.json.tmp-1-abc`);
      writeFileSync(outside, "outside");
      await new FileFlowStore(dir).save(KEY_BUYER, bytes("x"), null);
      expect(readFileSync(outside, "utf8")).toBe("outside");
    });

    it("a refused compare does not remove anything: the cleanup runs only for a save that will write", async () => {
      const dir = join(root, "flows");
      const store = new FileFlowStore(dir);
      await store.save(KEY_BUYER, bytes("good"), null);
      const stale = `buyer-${SWAP_A}.json.tmp-1-abc`;
      writeFileSync(join(dir, stale), "x");
      await expect(store.save(KEY_BUYER, bytes("mine"), digestOf("not good"))).rejects.toBeInstanceOf(FlowRecordStaleError);
      expect(readdirSync(dir)).toContain(stale);
    });
  });

  describe("the per-key lock file (R1-02)", () => {
    const lockFile = (dir: string): string => join(dir, `buyer-${SWAP_A}.lock`);

    it("a lock left by a dead process is broken and the save goes through", async () => {
      const dir = join(root, "flows");
      mkdirSync(dir);
      writeFileSync(lockFile(dir), lockBody(deadPid()));
      await new FileFlowStore(dir).save(KEY_BUYER, bytes("x"), null);
      expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("x");
      expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
    });

    it("a lock held by a live process is FlowStoreLockedError naming its pid and file, nothing is written, and the lock is never broken", async () => {
      const dir = join(root, "flows");
      mkdirSync(dir);
      const holder = livePid();
      try {
        writeFileSync(lockFile(dir), lockBody(holder.pid));
        const error = await new FileFlowStore(dir, { lockWaitMs: 0 }).save(KEY_BUYER, bytes("x"), null).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FlowStoreLockedError);
        expect(error).toBeInstanceOf(FlowStoreWriteFailedError);
        expect((error as FlowStoreLockedError).holderPid).toBe(holder.pid);
        expect((error as FlowStoreLockedError).lockPath).toBe(lockFile(dir));
        expect((error as FlowStoreLockedError).message).toContain(String(holder.pid));
        expect(readFileSync(lockFile(dir), "utf8")).toBe(lockBody(holder.pid)); // untouched
        expect(await new FileFlowStore(dir).load(KEY_BUYER)).toBeNull(); // nothing written
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.lock`]);
      } finally {
        holder.stop();
      }
    });

    it("a save waits for a live holder that lets go in time, then goes through (a critical section is brief)", async () => {
      const dir = join(root, "flows");
      mkdirSync(dir);
      const holder = livePid();
      try {
        writeFileSync(lockFile(dir), lockBody(holder.pid));
        setTimeout(() => rmSync(lockFile(dir), { force: true }), 120);
        await new FileFlowStore(dir, { lockWaitMs: 5000 }).save(KEY_BUYER, bytes("x"), null);
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("x");
      } finally {
        holder.stop();
      }
    });

    it("a lock file whose body is not a lock (its creator died before it wrote) is broken once it is seen unchanged twice", async () => {
      const dir = join(root, "flows");
      mkdirSync(dir);
      writeFileSync(lockFile(dir), "");
      await new FileFlowStore(dir, { lockWaitMs: 0 }).save(KEY_BUYER, bytes("x"), null);
      expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
      writeFileSync(lockFile(dir), "garbage that is not a pid");
      await new FileFlowStore(dir, { lockWaitMs: 0 }).save(KEY_BUYER, bytes("y"), digestOf("x"));
      expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("y");
    });

    describe("R2-01: a lock naming this process's own pid", () => {
      const eperm = (): Error => Object.assign(new Error("EPERM: operation not permitted (a scanner holds the file)"), { code: "EPERM" });

      it("one this process does not hold is a predecessor's leftover: it is broken, the save goes through and no lock remains", async () => {
        const dir = join(root, "flows");
        mkdirSync(dir);
        // a predecessor with the same pid (node as pid 1 in a container, a reused Windows pid) died inside a save
        writeFileSync(lockFile(dir), lockBody(process.pid));
        await new FileFlowStore(dir, { lockWaitMs: 100 }).save(KEY_BUYER, bytes("x"), null);
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("x");
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
        // and again for an update, from yet another store object
        writeFileSync(lockFile(dir), lockBody(process.pid));
        await new FileFlowStore(dir, { lockWaitMs: 100 }).save(KEY_BUYER, bytes("y"), digestOf("x"));
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("y");
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
      });

      it("one this process DOES hold is live: another store object on the same directory is refused, the message does not say 'another instance', and the holder's save is untouched", async () => {
        const dir = join(root, "flows");
        mkdirSync(dir);
        const link = join(root, "link"); // the same directory under another spelling, so the in-process queue does not serialise the two
        symlinkSync(dir, link, "junction");
        let refusal: unknown;
        const holder = new FileFlowStore(dir, {
          onStep: async (step) => {
            if (step !== "tmp-written") return;
            refusal = await new FileFlowStore(link, { lockWaitMs: 0 }).save(KEY_BUYER, bytes("intruder"), null).catch((e: unknown) => e);
          },
        });
        await holder.save(KEY_BUYER, bytes("holder"), null);
        expect(refusal).toBeInstanceOf(FlowStoreLockedError);
        expect((refusal as FlowStoreLockedError).holderPid).toBe(process.pid);
        expect((refusal as FlowStoreLockedError).message).not.toContain("another instance");
        expect((refusal as FlowStoreLockedError).message).toContain("this same process");
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("holder");
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
      });

      it("a lock held by ANOTHER live process still says another instance owns the swap", async () => {
        const dir = join(root, "flows");
        mkdirSync(dir);
        const other = livePid();
        try {
          writeFileSync(lockFile(dir), lockBody(other.pid));
          const error = await new FileFlowStore(dir, { lockWaitMs: 0 }).save(KEY_BUYER, bytes("x"), null).catch((e: unknown) => e);
          expect((error as FlowStoreLockedError).message).toContain("another instance owns this swap");
        } finally {
          other.stop();
        }
      });

      it("one transient EPERM on release's read of the lock file does not leave this process's own lock behind: the next saves, from the same and from a new store object, go through", async () => {
        const dir = join(root, "flows");
        const store = new FileFlowStore(dir, { lockWaitMs: 100 });
        await store.save(KEY_BUYER, bytes("v1"), null);
        const original = fsp.readFile;
        let lockReads = 0;
        const spy = vi.spyOn(fsp, "readFile").mockImplementation((async (path: unknown, options?: unknown) => {
          if (String(path).endsWith(".lock")) {
            lockReads += 1;
            if (lockReads === 2) throw eperm(); // read 1 is assertHeld's, read 2 is release's
          }
          return (original as (p: unknown, o?: unknown) => Promise<unknown>).call(fsp, path, options);
        }) as typeof fsp.readFile);
        try {
          await store.save(KEY_BUYER, bytes("v2"), digestOf("v1"));
        } finally {
          spy.mockRestore();
        }
        expect(lockReads).toBeGreaterThanOrEqual(3); // the release read was retried
        await store.save(KEY_BUYER, bytes("v3"), digestOf("v2"));
        await new FileFlowStore(dir, { lockWaitMs: 100 }).save(KEY_BUYER, bytes("v4"), digestOf("v3"));
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("v4");
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
      });

      it("a lock file release could not read at all stays behind, and this process's next save, from the same and from a new store object, breaks it", async () => {
        const dir = join(root, "flows");
        const store = new FileFlowStore(dir, { lockWaitMs: 100 });
        await store.save(KEY_BUYER, bytes("v1"), null);
        const original = fsp.readFile;
        const failReleaseReads = async (work: () => Promise<void>): Promise<void> => {
          let lockReads = 0;
          const spy = vi.spyOn(fsp, "readFile").mockImplementation((async (path: unknown, options?: unknown) => {
            if (String(path).endsWith(".lock")) {
              lockReads += 1;
              if (lockReads >= 2) throw eperm(); // every read from release's first on
            }
            return (original as (p: unknown, o?: unknown) => Promise<unknown>).call(fsp, path, options);
          }) as typeof fsp.readFile);
          try {
            await work();
          } finally {
            spy.mockRestore();
          }
        };
        await failReleaseReads(() => store.save(KEY_BUYER, bytes("v2"), digestOf("v1")));
        expect(readdirSync(dir).sort()).toEqual([`buyer-${SWAP_A}.json`, `buyer-${SWAP_A}.lock`]); // our own lock was left behind
        await store.save(KEY_BUYER, bytes("v3"), digestOf("v2")); // the same store object
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
        await failReleaseReads(() => store.save(KEY_BUYER, bytes("v4"), digestOf("v3")));
        expect(readdirSync(dir)).toContain(`buyer-${SWAP_A}.lock`);
        await new FileFlowStore(dir, { lockWaitMs: 100 }).save(KEY_BUYER, bytes("v5"), digestOf("v4")); // a new store object
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("v5");
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
      });
    });

    it("another key's lock does not block this key", async () => {
      const dir = join(root, "flows");
      mkdirSync(dir);
      const holder = livePid();
      try {
        writeFileSync(join(dir, `buyer-${SWAP_B}.lock`), lockBody(holder.pid));
        await new FileFlowStore(dir, { lockWaitMs: 0 }).save(KEY_BUYER, bytes("x"), null);
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("x");
      } finally {
        holder.stop();
      }
    });

    it("the lock is released when the save fails, whatever the reason: the next save is not locked out", async () => {
      const dir = join(root, "flows");
      let fail = true;
      const store = new FileFlowStore(dir, {
        lockWaitMs: 0,
        onStep: (step) => {
          if (fail && step === "tmp-written") throw new Error("disk full");
        },
      });
      await expect(store.save(KEY_BUYER, bytes("one"), null)).rejects.toThrow("disk full");
      expect(readdirSync(dir)).toEqual([]);
      fail = false;
      await store.save(KEY_BUYER, bytes("two"), null);
      await expect(store.save(KEY_BUYER, bytes("three"), digestOf("wrong"))).rejects.toBeInstanceOf(FlowRecordStaleError);
      await store.save(KEY_BUYER, bytes("three"), digestOf("two")); // a refused compare released the lock too
      expect(text(await store.load(KEY_BUYER))).toBe("three");
    });

    it("a lock that vanished or was replaced while the save held it stops the save before the rename", async () => {
      const dir = join(root, "flows");
      await new FileFlowStore(dir).save(KEY_BUYER, bytes("old"), null);
      const store = new FileFlowStore(dir, {
        lockWaitMs: 0,
        onStep: (step) => {
          if (step === "file-synced") writeFileSync(lockFile(dir), lockBody(deadPid())); // someone replaced our lock
        },
      });
      await expect(store.save(KEY_BUYER, bytes("new"), digestOf("old"))).rejects.toBeInstanceOf(FlowStoreLockedError);
      expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("old");
      expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });

    it("two FileFlowStore instances racing a create on one directory leave exactly one winner, whole on disk and nothing else behind", async () => {
      for (let round = 0; round < 8; round += 1) {
        const dir = join(root, `race-${round}`);
        const a = new FileFlowStore(dir);
        const b = new FileFlowStore(dir);
        const results = await Promise.allSettled([a.save(KEY_BUYER, bytes("from-a"), null), b.save(KEY_BUYER, bytes("from-b"), null)]);
        expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
        const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(loser?.reason).toBeInstanceOf(FlowRecordExistsError);
        const winner = results[0]?.status === "fulfilled" ? "from-a" : "from-b";
        expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe(winner);
        expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
      }
    });

    it("two instances racing an update with one digest: one wins, the other is stale", async () => {
      const dir = join(root, "flows");
      await new FileFlowStore(dir).save(KEY_BUYER, bytes("base"), null);
      const results = await Promise.allSettled([
        new FileFlowStore(dir).save(KEY_BUYER, bytes("from-a"), digestOf("base")),
        new FileFlowStore(dir).save(KEY_BUYER, bytes("from-b"), digestOf("base")),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(FlowRecordStaleError) });
    });

    it("refuses a bad lockWaitMs", () => {
      expect(() => new FileFlowStore(root, { lockWaitMs: -1 })).toThrow();
      expect(() => new FileFlowStore(root, { lockWaitMs: 1.5 })).toThrow();
    });
  });

  describe("R1-20: what is flushed after the rename, and which directory-fsync failures are real", () => {
    /** Makes opening the store's directory (for its fsync) hand back a handle whose sync throws `code`. */
    function failDirectorySync(dir: string, code: string): { restore: () => void } {
      const realOpen = fsp.open.bind(fsp);
      const spy = vi.spyOn(fsp, "open").mockImplementation(((path: unknown, flags?: unknown, mode?: unknown) => {
        if (path === dir && flags === "r") {
          return Promise.resolve({
            sync: () => Promise.reject(Object.assign(new Error(`${code}: simulated`), { code })),
            close: () => Promise.resolve(),
          });
        }
        return realOpen(path as string, flags as string, mode as number);
      }) as unknown as typeof fsp.open);
      return { restore: () => spy.mockRestore() };
    }

    it.each(["EACCES", "EPERM", "EBADF", "EIO"])("a directory fsync that fails with %s makes save reject: the rename may not be durable, so the flow must not act on it", async (code) => {
      const dir = join(root, "flows");
      const fault = failDirectorySync(join(root, "flows"), code);
      try {
        await expect(new FileFlowStore(dir, { platform: "linux" }).save(KEY_BUYER, bytes("x"), null)).rejects.toMatchObject({ code });
      } finally {
        fault.restore();
      }
    });

    it.each(["EINVAL", "ENOTSUP"])("a directory fsync that fails with %s (the file system does not support it) is tolerated", async (code) => {
      const dir = join(root, "flows");
      const fault = failDirectorySync(join(root, "flows"), code);
      try {
        await new FileFlowStore(dir, { platform: "linux" }).save(KEY_BUYER, bytes("x"), null);
      } finally {
        fault.restore();
      }
      expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("x");
    });

    it("on Windows the renamed file itself is flushed after the rename (a directory cannot be fsynced there)", async () => {
      const dir = join(root, "flows");
      const probe = await fsp.open(join(root, "probe"), "w");
      const proto = Object.getPrototypeOf(probe) as { sync: (this: unknown) => Promise<void> };
      await probe.close();
      const realSync = proto.sync;
      const realRename = fsp.rename.bind(fsp);
      const order: string[] = [];
      const syncSpy = vi.spyOn(proto, "sync").mockImplementation(function (this: unknown) {
        order.push("fsync");
        return realSync.call(this);
      });
      const renameSpy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        order.push("rename");
        return realRename(from, to);
      });
      const steps: FileSaveStep[] = [];
      try {
        await new FileFlowStore(dir, { platform: "win32", onStep: (step) => void steps.push(step) }).save(KEY_BUYER, bytes("x"), null);
      } finally {
        syncSpy.mockRestore();
        renameSpy.mockRestore();
      }
      expect(order).toEqual(["fsync", "rename", "fsync"]); // the temp file, then the rename, then the renamed file
      expect(steps).toEqual(["tmp-written", "file-synced", "renamed", "target-synced"]); // and no directory fsync
    });

    it("the flush of the renamed file is best effort: a platform that refuses it does not fail the save", async () => {
      const dir = join(root, "flows");
      const realOpen = fsp.open.bind(fsp);
      const target = join(dir, `buyer-${SWAP_A}.json`);
      const spy = vi.spyOn(fsp, "open").mockImplementation(((path: unknown, flags?: unknown, mode?: unknown) => {
        if (path === target && flags === "r+") return Promise.reject(Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" }));
        return realOpen(path as string, flags as string, mode as number);
      }) as unknown as typeof fsp.open);
      const steps: FileSaveStep[] = [];
      try {
        await new FileFlowStore(dir, { platform: "win32", onStep: (step) => void steps.push(step) }).save(KEY_BUYER, bytes("x"), null);
      } finally {
        spy.mockRestore();
      }
      expect(steps).toEqual(["tmp-written", "file-synced", "renamed"]);
      expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("x");
    });
  });

  describe("checksum: a damaged file is FlowStoreCorruptError, never null", () => {
    const filePath = (dir: string): string => join(dir, `buyer-${SWAP_A}.json`);
    async function seeded(): Promise<{ dir: string; store: FileFlowStore }> {
      const dir = join(root, "flows");
      const store = new FileFlowStore(dir);
      await store.save(KEY_BUYER, bytes('{"v":1,"hello":"world"}'), null);
      return { dir, store };
    }

    it("a flipped payload byte", async () => {
      const { dir, store } = await seeded();
      const file = readFileSync(filePath(dir));
      file[file.length - 3] = file[file.length - 3]! ^ 0x01;
      writeFileSync(filePath(dir), file);
      await expect(store.load(KEY_BUYER)).rejects.toThrow(FlowStoreCorruptError);
      await expect(store.load(KEY_BUYER)).rejects.toThrow(/sha256/);
    });

    it("a truncated file (payload cut short)", async () => {
      const { dir, store } = await seeded();
      const file = readFileSync(filePath(dir));
      writeFileSync(filePath(dir), file.subarray(0, file.length - 5));
      await expect(store.load(KEY_BUYER)).rejects.toThrow(FlowStoreCorruptError);
      await expect(store.load(KEY_BUYER)).rejects.toThrow(/bytes, the header says/);
    });

    it("a file cut inside the header, an empty file, and garbage", async () => {
      const { dir, store } = await seeded();
      const file = readFileSync(filePath(dir));
      for (const damaged of [file.subarray(0, 20), Buffer.alloc(0), Buffer.from("not a flow store file at all\n{}")]) {
        writeFileSync(filePath(dir), damaged);
        await expect(store.load(KEY_BUYER)).rejects.toThrow(FlowStoreCorruptError);
      }
    });

    it("extra bytes appended after the payload", async () => {
      const { dir, store } = await seeded();
      writeFileSync(filePath(dir), Buffer.concat([readFileSync(filePath(dir)), Buffer.from("\n{}")]));
      await expect(store.load(KEY_BUYER)).rejects.toThrow(FlowStoreCorruptError);
    });

    it("a payload swapped under an untouched header", async () => {
      const { dir, store } = await seeded();
      const file = readFileSync(filePath(dir));
      const newline = file.indexOf(0x0a);
      const swapped = Buffer.concat([file.subarray(0, newline + 1), Buffer.from('{"v":1,"hello":"WORLD"}')]); // same length
      writeFileSync(filePath(dir), swapped);
      await expect(store.load(KEY_BUYER)).rejects.toThrow(FlowStoreCorruptError);
    });

    it("an unknown store format version in the header is refused by name, never read", async () => {
      const { dir, store } = await seeded();
      const file = readFileSync(filePath(dir));
      writeFileSync(filePath(dir), Buffer.concat([Buffer.from(file.toString("latin1").replace("flop-flow-store/1 ", "flop-flow-store/2 "), "latin1")]));
      const error = await store.load(KEY_BUYER).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowStoreCorruptError);
      expect((error as FlowStoreCorruptError).reason).toMatch(/unknown store format version 2/);
    });

    it("an unknown RECORD version stored through a healthy store is refused when decoded, not read as empty", async () => {
      const dir = join(root, "flows");
      const store = new FileFlowStore(dir);
      const record = sampleBuyerRecord();
      await saveFlowRecord(store, record, null);
      expect(await loadFlowRecord(store, "buyer", record.swapId)).toEqual(record);
      // the next release writes version 2 records: this build must refuse one that arrives through a valid store file
      const current = (await store.load(`buyer:${record.swapId}`))!;
      const written = new TextDecoder().decode(current);
      expect(written.startsWith('{"v":1,')).toBe(true);
      await store.save(`buyer:${record.swapId}`, new TextEncoder().encode(written.replace('{"v":1,', '{"v":2,')), flowDigest(current));
      await expect(loadFlowRecord(store, "buyer", record.swapId)).rejects.toThrow(FlowRecordVersionError);
    });

    it("carries the key and a reason on the error", async () => {
      const { dir, store } = await seeded();
      writeFileSync(filePath(dir), "junk");
      const error = await store.load(KEY_BUYER).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowStoreCorruptError);
      expect((error as FlowStoreCorruptError).key).toBe(KEY_BUYER);
      expect((error as FlowStoreCorruptError).reason).toMatch(/header/);
    });

    it("a corrupt file is also reported by list-then-load, so a scan cannot skip it silently", async () => {
      const { dir, store } = await seeded();
      writeFileSync(filePath(dir), "junk");
      expect(await store.list()).toEqual([KEY_BUYER]);
      await expect(store.load(KEY_BUYER)).rejects.toThrow(FlowStoreCorruptError);
    });

    it("a damaged file is never overwritten by a compare-and-swap: an update over it is FlowStoreCorruptError, a create is FlowRecordExistsError", async () => {
      const { dir, store } = await seeded();
      writeFileSync(filePath(dir), "junk");
      await expect(store.save(KEY_BUYER, bytes("fresh"), digestOf("whatever"))).rejects.toBeInstanceOf(FlowStoreCorruptError);
      await expect(store.save(KEY_BUYER, bytes("fresh"), null)).rejects.toBeInstanceOf(FlowRecordExistsError);
      expect(readFileSync(filePath(dir), "utf8")).toBe("junk");
    });
  });

  describe("nothing is written outside the directory", () => {
    it("refused keys touch nothing, and saves stay inside dir", async () => {
      const parent = join(root, "parent");
      const dir = join(parent, "flows");
      mkdirSync(parent);
      const before = readdirSync(parent).sort();
      const store = new FileFlowStore(dir);
      for (const key of ["buyer:../x", `buyer:../../${SWAP_A}`, `../buyer:${SWAP_A}`, `buyer:${SWAP_A}/../../x`]) {
        await expect(store.save(key, bytes("evil"), null)).rejects.toThrow(FlowStoreKeyError);
        await expect(store.load(key)).rejects.toThrow(FlowStoreKeyError);
      }
      await store.save(KEY_BUYER, bytes("ok"), null);
      await store.save(KEY_SELLER, bytes("ok"), null);
      expect(readdirSync(parent).sort()).toEqual([...before, "flows"].sort());
      expect(readdirSync(root).sort()).toEqual(["parent"]);
      expect(readdirSync(dir).sort()).toEqual([`buyer-${SWAP_A}.json`, `seller-${SWAP_A}.json`].sort());
    });

    it("creates a nested directory on first save and exposes its absolute path", async () => {
      const store = new FileFlowStore(join(root, "a", "b", ".state", "flows"));
      expect(store.directory).toBe(join(root, "a", "b", ".state", "flows"));
      await store.save(KEY_BUYER, bytes("x"), null);
      expect(statSync(store.directory).isDirectory()).toBe(true);
    });

    it("refuses an empty directory name and a bad mode", () => {
      expect(() => new FileFlowStore("")).toThrow();
      expect(() => new FileFlowStore(root, { mode: -1 })).toThrow();
      expect(() => new FileFlowStore(root, { mode: 0o1777 })).toThrow();
    });
  });

  describe("file mode", () => {
    it.skipIf(process.platform === "win32")("defaults to 0o600 for files and 0o700 for a directory it creates", async () => {
      const store = new FileFlowStore(join(root, "flows"));
      await store.save(KEY_SELLER, bytes("the preimage lives in here"), null);
      expect(statSync(join(store.directory, `seller-${SWAP_A}.json`)).mode & 0o777).toBe(0o600);
      expect(statSync(store.directory).mode & 0o777).toBe(0o700);
      await store.save(KEY_SELLER, bytes("replaced"), digestOf("the preimage lives in here")); // a replacement keeps the mode
      expect(statSync(join(store.directory, `seller-${SWAP_A}.json`)).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === "win32")("honours an explicit mode", async () => {
      const store = new FileFlowStore(join(root, "flows"), { mode: 0o640 });
      await store.save(KEY_BUYER, bytes("x"), null);
      expect(statSync(join(store.directory, `buyer-${SWAP_A}.json`)).mode & 0o777).toBe(0o640);
    });

    it.runIf(process.platform === "win32")("(Windows) saves and loads; POSIX modes are not asserted there", async () => {
      const store = new FileFlowStore(join(root, "flows"));
      await store.save(KEY_BUYER, bytes("x"), null);
      expect(text(await store.load(KEY_BUYER))).toBe("x");
    });
  });

  it("a chain of saves, each naming the digest of the one before, is applied in order and leaves a whole, valid value and no debris", async () => {
    const store = new FileFlowStore(join(root, "flows"));
    await store.save(KEY_BUYER, bytes("value-0"), null);
    for (let i = 1; i < 12; i += 1) await store.save(KEY_BUYER, bytes(`value-${i}`), digestOf(`value-${i - 1}`));
    expect(text(await store.load(KEY_BUYER))).toBe("value-11");
    expect(readdirSync(store.directory)).toEqual([`buyer-${SWAP_A}.json`]);
  });

  it("a failed save does not poison the queue", async () => {
    const dir = join(root, "flows");
    let fail = true;
    const store = new FileFlowStore(dir, {
      onStep: (step) => {
        if (fail && step === "tmp-written") throw new Error("disk full");
      },
    });
    await expect(store.save(KEY_BUYER, bytes("one"), null)).rejects.toThrow("disk full");
    fail = false;
    await store.save(KEY_BUYER, bytes("two"), null);
    expect(text(await store.load(KEY_BUYER))).toBe("two");
  });
});
