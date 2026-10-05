// SPDX-License-Identifier: MIT
//
// tests/flow-store.test.ts: P8-RESUME-SPEC.md "Surface" and "Tests / Store". The flow store is the only place a
// resumable flow writes its swap record, so what it promises is pinned here: temp file + rename (a crash at any
// stage leaves the old value whole), a checksum that turns truncation or corruption into a typed error rather
// than an empty answer (rule 6), the key grammar, nothing written outside the directory, and the file mode where
// the platform has one.

import { mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FlowRecordVersionError, loadFlowRecord, saveFlowRecord } from "../src/client/flow-record.js";
import {
  FileFlowStore,
  FlowStoreCorruptError,
  FlowStoreFaultError,
  FlowStoreKeyError,
  MemoryFlowStore,
  flowKey,
  parseFlowKey,
  type FileSaveStep,
} from "../src/client/flow-store.js";
import { sampleBuyerRecord } from "./helpers/flow-record-samples.js";

const SWAP_A = `0x${"ab".repeat(32)}`;
const SWAP_B = `0x${"cd".repeat(32)}`;
const KEY_BUYER = `buyer:${SWAP_A}`;
const KEY_SELLER = `seller:${SWAP_A}`;
const KEY_OTHER = `buyer:${SWAP_B}`;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (value: Uint8Array | null): string | null => (value === null ? null : new TextDecoder().decode(value));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flowstore-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("key grammar", () => {
  it("builds and parses buyer:<swapId> and seller:<swapId>", () => {
    expect(flowKey("buyer", SWAP_A)).toBe(KEY_BUYER);
    expect(flowKey("seller", SWAP_A)).toBe(KEY_SELLER);
    expect(parseFlowKey(KEY_BUYER)).toEqual({ role: "buyer", swapId: SWAP_A });
    expect(parseFlowKey(KEY_SELLER)).toEqual({ role: "seller", swapId: SWAP_A });
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
      await expect(store.save("buyer:../../etc/passwd", bytes("x"))).rejects.toThrow(FlowStoreKeyError);
      await expect(store.save("whatever", bytes("x"))).rejects.toThrow(FlowStoreKeyError);
    }
    expect(memory.saveCount).toBe(0); // a refused key is not even logged as a save
  });
});

describe("MemoryFlowStore", () => {
  it("round-trips by value, not by reference, and lists sorted keys", async () => {
    const store = new MemoryFlowStore();
    expect(await store.load(KEY_BUYER)).toBeNull();
    const input = bytes("one");
    await store.save(KEY_BUYER, input);
    input[0] = 0x58; // the caller mutates its array afterwards
    const got = await store.load(KEY_BUYER);
    expect(text(got)).toBe("one");
    got![0] = 0x59; // a loaded array is a copy too
    expect(text(await store.load(KEY_BUYER))).toBe("one");
    await store.save(KEY_OTHER, bytes("two"));
    await store.save(KEY_SELLER, bytes("three"));
    expect(await store.list()).toEqual([KEY_BUYER, KEY_OTHER, KEY_SELLER].sort());
  });

  it("logs every save, in order, with a copy of the bytes", async () => {
    const store = new MemoryFlowStore();
    await store.save(KEY_BUYER, bytes("a"));
    await store.save(KEY_SELLER, bytes("b"));
    await store.save(KEY_BUYER, bytes("c"));
    expect(store.saveCount).toBe(3);
    expect(store.saves.map((s) => [s.n, s.key, text(s.bytes), s.outcome])).toEqual([
      [1, KEY_BUYER, "a", "ok"],
      [2, KEY_SELLER, "b", "ok"],
      [3, KEY_BUYER, "c", "ok"],
    ]);
  });

  it("failSave(n) refuses the n-th save across all keys and stores nothing", async () => {
    const store = new MemoryFlowStore().failSave(2);
    await store.save(KEY_BUYER, bytes("first"));
    await expect(store.save(KEY_BUYER, bytes("second"))).rejects.toThrow(FlowStoreFaultError);
    expect(text(await store.load(KEY_BUYER))).toBe("first"); // the old value survives
    await store.save(KEY_BUYER, bytes("third")); // later saves pass
    expect(text(await store.load(KEY_BUYER))).toBe("third");
    expect(store.saves.map((s) => s.outcome)).toEqual(["ok", "reject", "ok"]);
  });

  it("commit-then-throw stores the bytes and still throws (the write landed, the ack was lost)", async () => {
    const store = new MemoryFlowStore().failSave(1, "commit-then-throw");
    await expect(store.save(KEY_SELLER, bytes("landed"))).rejects.toThrow(FlowStoreFaultError);
    expect(text(await store.load(KEY_SELLER))).toBe("landed");
    expect(store.saves[0]?.outcome).toBe("commit-then-throw");
  });

  it("failSaveWhen decides per call and clearFaults disarms everything", async () => {
    const store = new MemoryFlowStore().failSaveWhen((_n, key, payload) => (key === KEY_SELLER && text(payload) === "preimage" ? "reject" : undefined));
    await store.save(KEY_BUYER, bytes("preimage")); // wrong key: passes
    await expect(store.save(KEY_SELLER, bytes("preimage"))).rejects.toThrow(FlowStoreFaultError);
    await store.save(KEY_SELLER, bytes("other")); // wrong payload: passes
    store.failSave(5);
    store.clearFaults();
    await store.save(KEY_SELLER, bytes("preimage")); // disarmed
    expect(text(await store.load(KEY_SELLER))).toBe("preimage");
  });

  it("rejects an invalid failSave number", () => {
    expect(() => new MemoryFlowStore().failSave(0)).toThrow();
    expect(() => new MemoryFlowStore().failSave(1.5)).toThrow();
  });
});

describe("FileFlowStore", () => {
  it("round-trips, replaces whole, returns null for a missing key and lists keys", async () => {
    const dir = join(root, "flows");
    const store = new FileFlowStore(dir);
    expect(await store.load(KEY_BUYER)).toBeNull();
    expect(await store.list()).toEqual([]); // the directory does not exist yet
    await store.save(KEY_BUYER, bytes("v1 of the buyer record"));
    await store.save(KEY_SELLER, bytes("the seller record"));
    expect(text(await store.load(KEY_BUYER))).toBe("v1 of the buyer record");
    await store.save(KEY_BUYER, bytes("v2"));
    expect(text(await store.load(KEY_BUYER))).toBe("v2");
    expect(await store.list()).toEqual([KEY_BUYER, KEY_SELLER].sort());
    // a fresh instance over the same directory sees the same thing (what resume relies on)
    expect(text(await new FileFlowStore(dir).load(KEY_SELLER))).toBe("the seller record");
  });

  it("round-trips arbitrary bytes, including an empty payload and every byte value", async () => {
    const store = new FileFlowStore(join(root, "flows"));
    const everything = Uint8Array.from({ length: 256 }, (_, i) => i);
    await store.save(KEY_BUYER, everything);
    expect(Array.from((await store.load(KEY_BUYER))!)).toEqual(Array.from(everything));
    await store.save(KEY_SELLER, new Uint8Array(0));
    expect((await store.load(KEY_SELLER))!.length).toBe(0);
  });

  it("names the file <role>-<swapId>.json (a colon is not a Windows file name character)", async () => {
    const dir = join(root, "flows");
    await new FileFlowStore(dir).save(KEY_BUYER, bytes("x"));
    expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
  });

  it("writes a temp file in the same directory first and renames it: stages in order, no temp left behind", async () => {
    const dir = join(root, "flows");
    const seen: Array<{ step: FileSaveStep; files: string[] }> = [];
    const store = new FileFlowStore(dir, {
      onStep: (step) => {
        seen.push({ step, files: readdirSync(dir).sort() });
      },
    });
    await store.save(KEY_BUYER, bytes("payload"));
    const final = `buyer-${SWAP_A}.json`;
    const expectedSteps: FileSaveStep[] = process.platform === "win32" ? ["tmp-written", "file-synced", "renamed"] : ["tmp-written", "file-synced", "renamed", "dir-synced"];
    expect(seen.map((s) => s.step)).toEqual(expectedSteps);
    // before the rename only the temp file exists, named after the final file with a .tmp- suffix
    for (const stage of seen.slice(0, 2)) {
      expect(stage.files).toHaveLength(1);
      expect(stage.files[0]).toMatch(new RegExp(`^${final.replace(".", "\\.")}\\.tmp-${process.pid}-[0-9a-f]{12}$`));
    }
    // after the rename only the final file exists
    for (const stage of seen.slice(2)) expect(stage.files).toEqual([final]);
    expect(readdirSync(dir)).toEqual([final]);
  });

  it("fsyncs the temp file BEFORE the rename, and the directory AFTER it (the directory not on Windows, which cannot)", async () => {
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
      await new FileFlowStore(join(root, "flows")).save(KEY_BUYER, bytes("x"));
    } finally {
      syncSpy.mockRestore();
      renameSpy.mockRestore();
    }
    expect(order).toEqual(process.platform === "win32" ? ["fsync", "rename"] : ["fsync", "rename", "fsync"]);
  });

  it.skipIf(process.platform === "win32")("fsyncs the directory after the rename (not on Windows, which cannot)", async () => {
    const steps: FileSaveStep[] = [];
    await new FileFlowStore(join(root, "flows"), { onStep: (step) => void steps.push(step) }).save(KEY_BUYER, bytes("x"));
    expect(steps.at(-1)).toBe("dir-synced");
  });

  it.each<FileSaveStep>(["tmp-written", "file-synced"])("a crash at %s leaves the previous value whole and no temp file", async (crashAt) => {
    const dir = join(root, "flows");
    await new FileFlowStore(dir).save(KEY_BUYER, bytes("old value"));
    const crashing = new FileFlowStore(dir, {
      onStep: (step) => {
        if (step === crashAt) throw new Error("simulated crash");
      },
    });
    await expect(crashing.save(KEY_BUYER, bytes("new value"))).rejects.toThrow("simulated crash");
    expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("old value");
    expect(readdirSync(dir)).toEqual([`buyer-${SWAP_A}.json`]);
  });

  it("a crash after the rename means the new value is the one on disk", async () => {
    const dir = join(root, "flows");
    await new FileFlowStore(dir).save(KEY_BUYER, bytes("old value"));
    const crashing = new FileFlowStore(dir, {
      onStep: (step) => {
        if (step === "renamed") throw new Error("simulated crash");
      },
    });
    await expect(crashing.save(KEY_BUYER, bytes("new value"))).rejects.toThrow("simulated crash");
    expect(text(await new FileFlowStore(dir).load(KEY_BUYER))).toBe("new value");
  });

  it("a stale temp file from a crashed process is never listed and never read as the record", async () => {
    const dir = join(root, "flows");
    const store = new FileFlowStore(dir);
    await store.save(KEY_BUYER, bytes("good"));
    writeFileSync(join(dir, `buyer-${SWAP_A}.json.tmp-9999-abcdef012345`), "half a record");
    writeFileSync(join(dir, `seller-${SWAP_A}.json.tmp-9999-abcdef012345`), "half a record");
    writeFileSync(join(dir, "notes.txt"), "unrelated");
    expect(await store.list()).toEqual([KEY_BUYER]);
    expect(text(await store.load(KEY_BUYER))).toBe("good");
    expect(await store.load(KEY_SELLER)).toBeNull();
    await store.save(KEY_BUYER, bytes("better")); // saving is unaffected by the debris
    expect(text(await store.load(KEY_BUYER))).toBe("better");
  });

  describe("checksum: a damaged file is FlowStoreCorruptError, never null", () => {
    const filePath = (dir: string): string => join(dir, `buyer-${SWAP_A}.json`);
    async function seeded(): Promise<{ dir: string; store: FileFlowStore }> {
      const dir = join(root, "flows");
      const store = new FileFlowStore(dir);
      await store.save(KEY_BUYER, bytes('{"v":1,"hello":"world"}'));
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
      await saveFlowRecord(store, record);
      expect(await loadFlowRecord(store, "buyer", record.swapId)).toEqual(record);
      // the next release writes version 2 records: this build must refuse one that arrives through a valid store file
      const written = new TextDecoder().decode((await store.load(`buyer:${record.swapId}`))!);
      expect(written.startsWith('{"v":1,')).toBe(true);
      await store.save(`buyer:${record.swapId}`, new TextEncoder().encode(written.replace('{"v":1,', '{"v":2,')));
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
  });

  describe("nothing is written outside the directory", () => {
    it("refused keys touch nothing, and saves stay inside dir", async () => {
      const parent = join(root, "parent");
      const dir = join(parent, "flows");
      mkdirSync(parent);
      const before = readdirSync(parent).sort();
      const store = new FileFlowStore(dir);
      for (const key of ["buyer:../x", `buyer:../../${SWAP_A}`, `../buyer:${SWAP_A}`, `buyer:${SWAP_A}/../../x`]) {
        await expect(store.save(key, bytes("evil"))).rejects.toThrow(FlowStoreKeyError);
        await expect(store.load(key)).rejects.toThrow(FlowStoreKeyError);
      }
      await store.save(KEY_BUYER, bytes("ok"));
      await store.save(KEY_SELLER, bytes("ok"));
      expect(readdirSync(parent).sort()).toEqual([...before, "flows"].sort());
      expect(readdirSync(root).sort()).toEqual(["parent"]);
      expect(readdirSync(dir).sort()).toEqual([`buyer-${SWAP_A}.json`, `seller-${SWAP_A}.json`].sort());
    });

    it("creates a nested directory on first save and exposes its absolute path", async () => {
      const store = new FileFlowStore(join(root, "a", "b", ".state", "flows"));
      expect(store.directory).toBe(join(root, "a", "b", ".state", "flows"));
      await store.save(KEY_BUYER, bytes("x"));
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
      await store.save(KEY_SELLER, bytes("the preimage lives in here"));
      expect(statSync(join(store.directory, `seller-${SWAP_A}.json`)).mode & 0o777).toBe(0o600);
      expect(statSync(store.directory).mode & 0o777).toBe(0o700);
      await store.save(KEY_SELLER, bytes("replaced")); // a replacement keeps the mode
      expect(statSync(join(store.directory, `seller-${SWAP_A}.json`)).mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === "win32")("honours an explicit mode", async () => {
      const store = new FileFlowStore(join(root, "flows"), { mode: 0o640 });
      await store.save(KEY_BUYER, bytes("x"));
      expect(statSync(join(store.directory, `buyer-${SWAP_A}.json`)).mode & 0o777).toBe(0o640);
    });

    it.runIf(process.platform === "win32")("(Windows) saves and loads; POSIX modes are not asserted there", async () => {
      const store = new FileFlowStore(join(root, "flows"));
      await store.save(KEY_BUYER, bytes("x"));
      expect(text(await store.load(KEY_BUYER))).toBe("x");
    });
  });

  it("serialises concurrent saves of one key: every call resolves and the file is a whole, valid value", async () => {
    const store = new FileFlowStore(join(root, "flows"));
    const writes = Array.from({ length: 12 }, (_, i) => store.save(KEY_BUYER, bytes(`value-${i}`)));
    await Promise.all(writes);
    expect(text(await store.load(KEY_BUYER))).toBe("value-11"); // submission order is write order
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
    await expect(store.save(KEY_BUYER, bytes("one"))).rejects.toThrow("disk full");
    fail = false;
    await store.save(KEY_BUYER, bytes("two"));
    expect(text(await store.load(KEY_BUYER))).toBe("two");
  });
});
