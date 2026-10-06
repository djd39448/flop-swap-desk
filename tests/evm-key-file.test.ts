// SPDX-License-Identifier: MIT
//
// tests/evm-key-file.test.ts - P9-1 (handoff/P9-G1-READINESS-SPEC.md, rule 1): the key-file loader. Every key here is
// generated at test time (viem `generatePrivateKey`) into a temporary file; none is a literal, none is printed. Covers: a good
// file loads to the address viem derives; every refusal the spec names (empty, two lines, a mnemonic, non-hex, wrong length,
// missing 0x, a directory, an unreadable or missing path) with a typed error whose message names the path and the problem and
// never any content; the POSIX mode warning (a real 0644 file, skipped on win32 where mode bits mean nothing, plus the
// injectable-platform branches that run everywhere); and that no way of printing, serialising, cloning or enumerating the
// account shows the key.

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";

import { recoverMessageAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EvmKeyFileError, loadEvmLocalAccount, type EvmKeyFileProblem } from "../src/client/evm-key-file.js";

const IS_WIN32 = process.platform === "win32";
const WIN32_REASON = "POSIX file modes are not meaningful on win32 (Node reports a fixed mode for every file)";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "evmkf-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes `content` to a fresh file under the test directory (mode 0600) and returns its path. */
async function fileWith(content: string | Buffer, mode = 0o600): Promise<string> {
  counter += 1;
  const path = join(dir, `k${counter}.key`);
  await writeFile(path, content, { mode });
  return path;
}

/** Every substring of `secret` that is `window` characters long: none may appear in text that must not leak it. */
function windows(secret: string, window = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i + window <= secret.length; i += 1) out.push(secret.slice(i, i + window));
  return out;
}

function expectNoLeak(error: unknown, secret: string): void {
  const e = error as EvmKeyFileError;
  const texts = [e.message, String(e.stack), JSON.stringify(e), inspect(e, { depth: null, showHidden: true }), String(e.cause ?? "")];
  for (const text of texts) {
    for (const piece of windows(secret)) expect(text.includes(piece)).toBe(false);
  }
}

async function refusal(path: string, options?: Parameters<typeof loadEvmLocalAccount>[1]): Promise<EvmKeyFileError> {
  try {
    await loadEvmLocalAccount(path, options);
  } catch (error) {
    expect(error).toBeInstanceOf(EvmKeyFileError);
    return error as EvmKeyFileError;
  }
  throw new Error("expected loadEvmLocalAccount to refuse");
}

describe("loadEvmLocalAccount: a good key file", () => {
  it("loads one 0x + 64 hex key to the address viem derives, whatever the (single) line ending", async () => {
    for (const ending of ["", "\n", "\r\n"]) {
      const key = generatePrivateKey();
      const account = await loadEvmLocalAccount(await fileWith(key + ending));
      expect(account.address).toBe(privateKeyToAccount(key).address);
      expect(account.type).toBe("local");
    }
  });

  it("accepts upper-case hex digits after the 0x", async () => {
    const key = generatePrivateKey();
    const upper = `0x${key.slice(2).toUpperCase()}`;
    const account = await loadEvmLocalAccount(await fileWith(`${upper}\n`));
    expect(account.address).toBe(privateKeyToAccount(key).address);
  });

  it("returns an account that signs: a message signature recovers to its own address", async () => {
    const account = await loadEvmLocalAccount(await fileWith(`${generatePrivateKey()}\n`));
    const signature = await account.signMessage({ message: "p9-1 signer check" });
    expect(await recoverMessageAddress({ message: "p9-1 signer check", signature })).toBe(account.address);
    const signedTx = await account.signTransaction({ chainId: 31337, nonce: 0, to: account.address, value: 0n, gas: 21_000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 1n, type: "eip1559" });
    expect(signedTx.startsWith("0x02")).toBe(true);
  });
});

describe("loadEvmLocalAccount: refusals (typed, path and problem named, content never)", () => {
  /** Content builders: each derives the bad content from a freshly generated key, so a leak would show the key's own hex. */
  const cases: Array<{ name: string; problem: EvmKeyFileProblem; code: EvmKeyFileError["code"]; content: (key: Hex) => string | Buffer }> = [
    { name: "an empty file", problem: "empty-file", code: "empty", content: () => "" },
    { name: "a file with only a newline", problem: "empty-file", code: "empty", content: () => "\n" },
    { name: "two lines", problem: "several-lines", code: "malformed", content: (key) => `${key}\n${key}\n` },
    { name: "a key followed by a blank line", problem: "several-lines", code: "malformed", content: (key) => `${key}\n\n` },
    { name: "a key with a comment line after it", problem: "several-lines", code: "malformed", content: (key) => `${key}\n# mine\n` },
    { name: "a mnemonic phrase", problem: "whitespace-or-control", code: "malformed", content: () => "one two three four five six seven eight nine ten eleven twelve\n" },
    { name: "a labelled key", problem: "whitespace-or-control", code: "malformed", content: (key) => `key: ${key}\n` },
    { name: "a key with a leading space", problem: "whitespace-or-control", code: "malformed", content: (key) => ` ${key}\n` },
    { name: "a key with a trailing space", problem: "whitespace-or-control", code: "malformed", content: (key) => `${key} \n` },
    { name: "a key behind a UTF-8 byte order mark", problem: "whitespace-or-control", code: "malformed", content: (key) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(key)]) },
    { name: "UTF-16 text", problem: "whitespace-or-control", code: "malformed", content: (key) => Buffer.from(key, "utf16le") },
    { name: "a key without the 0x prefix", problem: "missing-0x-prefix", code: "malformed", content: (key) => `${key.slice(2)}\n` },
    { name: "a key with an upper-case 0X prefix", problem: "missing-0x-prefix", code: "malformed", content: (key) => `0X${key.slice(2)}\n` },
    { name: "a key one digit short", problem: "wrong-length", code: "malformed", content: (key) => `${key.slice(0, -1)}\n` },
    { name: "a key one digit long", problem: "wrong-length", code: "malformed", content: (key) => `${key}a\n` },
    { name: "a bare 0x", problem: "wrong-length", code: "malformed", content: () => "0x\n" },
    { name: "a key with a non-hex character", problem: "not-hex", code: "malformed", content: (key) => `${key.slice(0, 20)}g${key.slice(21)}\n` },
    { name: "the zero key", problem: "not-a-valid-key", code: "malformed", content: () => `0x${"0".repeat(64)}\n` },
    { name: "a value at or above the curve order", problem: "not-a-valid-key", code: "malformed", content: () => `0x${"f".repeat(64)}\n` },
    { name: "a file over the size cap", problem: "too-large", code: "malformed", content: (key) => `${key}${"a".repeat(300)}` },
  ];

  for (const c of cases) {
    it(`refuses ${c.name}: ${c.problem}`, async () => {
      const key = generatePrivateKey();
      const path = await fileWith(c.content(key));
      const error = await refusal(path);
      expect(error.problem).toBe(c.problem);
      expect(error.code).toBe(c.code);
      expect(error.name).toBe("EvmKeyFileError");
      expect(error.path).toBe(path);
      expect(error.message).toContain(path);
      expect(error.cause).toBeUndefined();
      expectNoLeak(error, key);
    });
  }

  it("refuses a missing file as not-found, naming the path", async () => {
    const path = join(dir, "does-not-exist.key");
    const error = await refusal(path);
    expect(error.code).toBe("not-found");
    expect(error.problem).toBe("no-such-file");
    expect(error.message).toContain(path);
  });

  it("refuses a path under a regular file (not a directory) as not-found", async () => {
    const file = await fileWith(`${generatePrivateKey()}\n`);
    const error = await refusal(join(file, "child.key"));
    expect(error.code).toBe("not-found");
  });

  it("refuses an empty path as not-found without touching the file system", async () => {
    const error = await refusal("");
    expect(error.code).toBe("not-found");
    expect(error.problem).toBe("empty-path");
  });

  it("refuses a directory as not-a-file", async () => {
    const sub = join(dir, "a-directory");
    await mkdir(sub);
    const error = await refusal(sub);
    expect(error.code).toBe("not-a-file");
    expect(error.problem).toBe("not-a-regular-file");
    expect(error.message).toContain(sub);
  });

  it("refuses a path the file system cannot even try to open as unreadable", async () => {
    const error = await refusal(join(dir, "bad\u0000name.key"));
    expect(error.code).toBe("unreadable");
    expect(error.problem).toBe("cannot-read");
  });

  it.skipIf(IS_WIN32 || IS_ROOT)(`refuses a file with no read permission as unreadable (skipped on win32 and as root: ${WIN32_REASON})`, async () => {
    const key = generatePrivateKey();
    const path = await fileWith(`${key}\n`);
    await chmod(path, 0o000);
    const error = await refusal(path);
    expect(error.code).toBe("unreadable");
    expectNoLeak(error, key);
    await chmod(path, 0o600);
  });
});

describe("loadEvmLocalAccount: the file-mode warning", () => {
  it.skipIf(IS_WIN32)(`warns once for a real mode-0644 file and still loads it (skipped on win32: ${WIN32_REASON})`, async () => {
    const key = generatePrivateKey();
    const path = await fileWith(`${key}\n`, 0o644);
    await chmod(path, 0o644);
    const warn = vi.fn();
    const account = await loadEvmLocalAccount(path, { warn });
    expect(account.address).toBe(privateKeyToAccount(key).address);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(path);
    expect(message).toContain("644");
    expect(message).toContain("chmod 600");
    for (const piece of windows(key)) expect(message.includes(piece)).toBe(false);
  });

  it.skipIf(IS_WIN32)(`does not warn for a real mode-0600 file (skipped on win32: ${WIN32_REASON})`, async () => {
    const path = await fileWith(`${generatePrivateKey()}\n`, 0o600);
    await chmod(path, 0o600);
    const warn = vi.fn();
    await loadEvmLocalAccount(path, { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it.skipIf(IS_WIN32)(`warns for group-readable (0640) and world-readable (0604) files too (skipped on win32: ${WIN32_REASON})`, async () => {
    for (const mode of [0o640, 0o604]) {
      const path = await fileWith(`${generatePrivateKey()}\n`, mode);
      await chmod(path, mode);
      const warn = vi.fn();
      await loadEvmLocalAccount(path, { warn });
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it("runs on every host: with the platform injected as linux, an open file warns exactly once and still loads", async () => {
    // On win32 every file reports an open mode, on POSIX the default 0644 does; either way group/other bits are set.
    const path = await fileWith(`${generatePrivateKey()}\n`, 0o644);
    if (!IS_WIN32) await chmod(path, 0o644);
    const warn = vi.fn();
    const account = await loadEvmLocalAccount(path, { warn, platform: "linux" });
    expect(account.type).toBe("local");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("runs on every host: with the platform injected as win32 the mode check is skipped and nothing warns", async () => {
    const path = await fileWith(`${generatePrivateKey()}\n`, 0o644);
    if (!IS_WIN32) await chmod(path, 0o644);
    const warn = vi.fn();
    await loadEvmLocalAccount(path, { warn, platform: "win32" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("by default the warning goes through process.emitWarning, with a code, and never carries the key", async () => {
    const key = generatePrivateKey();
    const path = await fileWith(`${key}\n`, 0o644);
    if (!IS_WIN32) await chmod(path, 0o644);
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      await loadEvmLocalAccount(path, { platform: "linux" });
      expect(spy).toHaveBeenCalledTimes(1);
      const [message, options] = spy.mock.calls[0] ?? [];
      expect(String(message)).toContain(path);
      expect(options).toMatchObject({ code: "EVM_KEY_FILE_MODE" });
      for (const piece of windows(key)) expect(String(message).includes(piece)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("a refused file never warns (the refusal is the only signal)", async () => {
    const path = await fileWith("not a key\n", 0o644);
    const warn = vi.fn();
    await refusal(path, { warn, platform: "linux" });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("loadEvmLocalAccount: the account shows its address and type, never the key", () => {
  async function loaded() {
    const key = generatePrivateKey();
    const account = await loadEvmLocalAccount(await fileWith(`${key}\n`));
    return { key, account };
  }

  /** The forms a key can take in text: with and without the 0x, both cases. */
  function forms(key: Hex): string[] {
    return [key, key.slice(2), key.toUpperCase(), key.slice(2).toUpperCase()];
  }

  function expectClean(text: string, key: Hex): void {
    for (const form of forms(key)) {
      for (const piece of windows(form)) expect(text.includes(piece)).toBe(false);
    }
  }

  it("JSON.stringify, util.inspect (default, no custom inspect, hidden members, deep), String, a template and util.format show only the address and the type", async () => {
    const { key, account } = await loaded();
    const views = [
      JSON.stringify(account),
      JSON.stringify({ wrapped: account, list: [account] }),
      inspect(account),
      inspect(account, { customInspect: false }),
      inspect(account, { showHidden: true, depth: null }),
      inspect(account, { customInspect: false, showHidden: true, depth: null, getters: true }),
      String(account),
      `${account}`,
      account.toString(),
      format("%s %o %O %j %d", account, account, account, account, 1),
      JSON.stringify(Object.entries(account)),
      JSON.stringify(Object.keys(account)),
      JSON.stringify(Object.values(account)),
      JSON.stringify(Object.getOwnPropertyNames(account)),
      JSON.stringify({ ...account }),
      JSON.stringify(structuredClone(account)),
      Object.prototype.toString.call(account),
    ];
    for (const view of views) expectClean(view, key);
    // What they DO show: the address and the type.
    expect(JSON.parse(JSON.stringify(account))).toEqual({ address: account.address, type: "local" });
    expect(inspect(account)).toContain(account.address);
    expect(String(account)).toContain(account.address);
    expect(inspect(account, { customInspect: false })).toContain(account.address);
    expect(Object.keys(account)).toEqual(["address", "type"]);
    expect(Object.entries(account)).toEqual([["address", account.address], ["type", "local"]]);
    expect({ ...account }).toEqual({ address: account.address, type: "local" });
    expect(structuredClone(account)).toEqual({ address: account.address, type: "local" });
  });

  it("answers toJSON and the custom inspector itself, so a member made enumerable later would still not show", async () => {
    const { key, account } = await loaded();
    const shown = (account as unknown as { toJSON(): unknown }).toJSON();
    expect(shown).toEqual({ address: account.address, type: "local" });
    const inspected = (account as unknown as Record<symbol, () => string>)[inspect.custom]!();
    expect(inspected).toContain(account.address);
    expectClean(inspected, key);
    expect(Object.getOwnPropertyDescriptor(account, "toJSON")?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(account, "toString")?.enumerable).toBe(false);
  });

  it("holds no member, own or symbol, whose value is or contains the key", async () => {
    const { key, account } = await loaded();
    const own = [...Object.getOwnPropertyNames(account), ...Object.getOwnPropertySymbols(account)];
    for (const name of own) {
      const value = (account as unknown as Record<string | symbol, unknown>)[name];
      if (typeof value === "function") continue;
      expectClean(typeof value === "string" ? value : JSON.stringify(value) ?? "", key);
    }
    // The viem account object has no key member either, but a name that suggests one would be a red flag in this wrapper.
    expect(own.map(String).some((name) => /priv|secret|seed|mnemonic/i.test(name))).toBe(false);
  });

  it("is frozen: nothing can be attached to it or changed on it", async () => {
    const { account } = await loaded();
    expect(Object.isFrozen(account)).toBe(true);
    expect(() => {
      (account as unknown as Record<string, unknown>).leak = "x";
    }).toThrow(TypeError);
    expect(() => {
      (account as unknown as Record<string, unknown>).address = "0x0";
    }).toThrow(TypeError);
  });

  it("keeps the signing members viem reads by name, non-enumerable", async () => {
    const { account } = await loaded();
    for (const name of ["signMessage", "signTransaction", "signTypedData", "signAuthorization", "sign"] as const) {
      expect(typeof account[name]).toBe("function");
      expect(Object.getOwnPropertyDescriptor(account, name)?.enumerable).toBe(false);
    }
    expect(account.source).toBe("privateKey");
    expect(account.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
  });

  it("an error from a failed signature does not carry the key either", async () => {
    const { key, account } = await loaded();
    const failure = await account.signTransaction({ chainId: 31337, type: "eip1559", maxFeePerGas: 1n, maxPriorityFeePerGas: 2n } as never).then(
      () => "no error",
      (error: unknown) => `${String(error)} ${inspect(error, { depth: null })}`,
    );
    expectClean(failure, key);
  });
});
