// SPDX-License-Identifier: MIT
//
// P9-1 (handoff/P9-G1-READINESS-SPEC.md, rule 1): the one place a private key ever enters this build. A runner names a
// file; this module reads it at run time, once, and hands back a viem `LocalAccount` whose key lives in a closure.
// Nothing here, and nothing that receives the account, can print, serialise or inspect the key:
//
//   - the file must hold exactly one `0x`-prefixed 32-byte hex key (one trailing newline or CRLF tolerated) and nothing
//     else; anything else is refused with an `EvmKeyFileError` whose message names the path and the PROBLEM (a fixed
//     sentence per problem) and never any byte of the content (no excerpt, no length, no position of a bad character);
//   - the returned account is a sealed, frozen object whose only enumerable members are `address` and `type: "local"`;
//     the signing functions are non-enumerable and the key is not a member at all (viem's `privateKeyToAccount` already
//     keeps it in a closure; this wrapper additionally hides every other member from `Object.keys`, `Object.entries`,
//     spreads and `structuredClone`, and answers `JSON.stringify`, `String()`, `util.inspect` (default and with
//     `customInspect: false`) with the address and the type only);
//   - the loader's own copy of the file bytes is zeroed as soon as the account exists.
//
// File mode (POSIX only): a key file readable by group or others gets ONE warning through `options.warn` (default
// `process.emitWarning`) and is still loaded: the loader does not refuse, the runner's operator decides. On win32 the mode
// bits are not meaningful (Node reports a fixed mode for every file; real access control is an ACL), so the check is
// skipped there and no warning is ever emitted; the README says to keep the key directory private to the user.
//
// Keys are created by the operator (`cast wallet new`, then the private key copied into the file, mode 0600); this module
// never generates, derives, stores or logs one. Tests generate keys at test time (viem `generatePrivateKey`).

import { open, stat } from "node:fs/promises";
import { inspect } from "node:util";

import type { Address } from "viem";
import { privateKeyToAccount, type LocalAccount, type PrivateKeyAccount } from "viem/accounts";

/** Coarse class of a refusal; `problem` (below) names the exact one. */
export type EvmKeyFileErrorCode = "not-found" | "unreadable" | "not-a-file" | "empty" | "malformed";

/** The exact problem, one fixed sentence each in the error message; none of them quotes the file content. */
export type EvmKeyFileProblem =
  | "empty-path"
  | "no-such-file"
  | "cannot-read"
  | "not-a-regular-file"
  | "empty-file"
  | "too-large"
  | "several-lines"
  | "whitespace-or-control"
  | "missing-0x-prefix"
  | "wrong-length"
  | "not-hex"
  | "not-a-valid-key";

const PROBLEM_TEXT: Record<EvmKeyFileProblem, string> = {
  "empty-path": "the key file path is empty",
  "no-such-file": "no such file",
  "cannot-read": "the file cannot be read",
  "not-a-regular-file": "the path is not a regular file (a directory or other special file)",
  "empty-file": "the file is empty",
  "too-large": "the file is larger than a single key can be",
  "several-lines": "the file holds more than one line (it must hold exactly one key line)",
  "whitespace-or-control":
    "the key line contains whitespace or non-printable characters (a mnemonic, a labelled key or an encoded file is not accepted)",
  "missing-0x-prefix": "the key does not start with 0x (it must be 0x followed by 64 hex characters)",
  "wrong-length": "the key is not 0x followed by exactly 64 hex characters",
  "not-hex": "the key contains characters that are not hexadecimal digits",
  "not-a-valid-key": "the 32 bytes are not a valid secp256k1 private key",
};

const PROBLEM_CODE: Record<EvmKeyFileProblem, EvmKeyFileErrorCode> = {
  "empty-path": "not-found",
  "no-such-file": "not-found",
  "cannot-read": "unreadable",
  "not-a-regular-file": "not-a-file",
  "empty-file": "empty",
  "too-large": "malformed",
  "several-lines": "malformed",
  "whitespace-or-control": "malformed",
  "missing-0x-prefix": "malformed",
  "wrong-length": "malformed",
  "not-hex": "malformed",
  "not-a-valid-key": "malformed",
};

/**
 * A refused key file. `message` is `evm key file <path>: <problem sentence>`; `path` is the path the caller passed
 * (a config value, not a secret). No field carries any part of the file content, and no `cause` is attached (the
 * underlying library error is dropped on purpose).
 */
export class EvmKeyFileError extends Error {
  readonly code: EvmKeyFileErrorCode;
  readonly problem: EvmKeyFileProblem;
  readonly path: string;

  constructor(problem: EvmKeyFileProblem, path: string) {
    super(`evm key file ${path === "" ? "(no path)" : path}: ${PROBLEM_TEXT[problem]}`);
    this.name = "EvmKeyFileError";
    this.code = PROBLEM_CODE[problem];
    this.problem = problem;
    this.path = path;
  }
}

/**
 * The fixed sentence for `problem` (the one the error message ends with): no path, no content. For a caller that must not print the
 * configured path (the rehearsal runner prints `<field>: <this sentence>`, because a path that a person got wrong can hold the key).
 */
export function describeKeyFileProblem(problem: EvmKeyFileProblem): string {
  return PROBLEM_TEXT[problem];
}

export interface LoadEvmLocalAccountOptions {
  /** Receives the one-line warning for a key file that group or other users can access (POSIX only). Default:
   *  `process.emitWarning(message, { type: "EvmKeyFileWarning", code: "EVM_KEY_FILE_MODE" })`. The text names the path and the
   *  octal mode, never any content. */
  warn?: (message: string) => void;
  /** The platform whose file-mode semantics apply; default `process.platform`. `"win32"` skips the mode check. Injectable
   *  so both branches are testable on every host. */
  platform?: NodeJS.Platform;
}

/** A key line is `0x` and 64 hex digits (66 characters); a CRLF makes 68. 256 leaves room for nothing useful, on purpose. */
const MAX_FILE_BYTES = 256;
const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function defaultWarn(message: string): void {
  process.emitWarning(message, { type: "EvmKeyFileWarning", code: "EVM_KEY_FILE_MODE" });
}

function isErrnoCode(error: unknown, ...codes: string[]): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && codes.includes(code);
}

/** Classifies a failed open or stat. The Node error is read for its errno code only and then dropped. */
function problemForFsError(error: unknown): EvmKeyFileProblem {
  if (isErrnoCode(error, "ENOENT", "ENOTDIR")) return "no-such-file";
  if (isErrnoCode(error, "EISDIR")) return "not-a-regular-file";
  return "cannot-read";
}

/** Validates the one key line and returns it, or the problem. `text` is the file content as latin1 (one char per byte). */
function keyLineOrProblem(text: string): { key: string } | { problem: EvmKeyFileProblem } {
  // One trailing line terminator is tolerated (an editor's final newline, a Windows CRLF); a second one is a second line.
  let line = text;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line === "") return { problem: "empty-file" };
  if (line.includes("\n") || line.includes("\r")) return { problem: "several-lines" };
  // Space, tab, NUL and every other control or non-ASCII byte (a BOM, UTF-16 text, a 12-word mnemonic).
  if (/[^\x21-\x7e]/.test(line)) return { problem: "whitespace-or-control" };
  if (!line.startsWith("0x")) return { problem: "missing-0x-prefix" };
  if (line.length !== 66) return { problem: "wrong-length" };
  if (!KEY_PATTERN.test(line)) return { problem: "not-hex" };
  return { key: line };
}

/**
 * Reads one `0x`-prefixed 32-byte hex private key from `path` and returns a sealed viem `LocalAccount` for it.
 *
 * Refuses (throws `EvmKeyFileError`): an empty path or a missing file (`not-found`), a file that cannot be opened or read
 * (`unreadable`), a directory or other non-regular file (`not-a-file`), an empty file (`empty`), and anything that is not
 * exactly one `0x` + 64 hex line (`malformed`: more than one line, whitespace, a mnemonic, no `0x`, a wrong length, a
 * non-hex character, a scalar that is not a valid secp256k1 key, a file over 256 bytes). The message names the path and the
 * problem and never any content.
 *
 * On POSIX, when group or other users have any access to the file (mode `& 0o077`), one warning goes to `options.warn`
 * and the key is still loaded. On win32 the mode check is skipped (see the file header).
 *
 * The account prints, serialises and inspects as its address and type only; see `sealLocalAccount`.
 */
export async function loadEvmLocalAccount(path: string, options: LoadEvmLocalAccountOptions = {}): Promise<LocalAccount> {
  if (typeof path !== "string" || path === "") throw new EvmKeyFileError("empty-path", typeof path === "string" ? path : "");
  const platform = options.platform ?? process.platform;
  const warn = options.warn ?? defaultWarn;

  // `stat` first: it follows symlinks and refuses a directory, a FIFO or a device BEFORE anything is opened (opening a FIFO
  // for reading would block until a writer shows up).
  let before;
  try {
    before = await stat(path);
  } catch (error) {
    throw new EvmKeyFileError(problemForFsError(error), path);
  }
  if (!before.isFile()) throw new EvmKeyFileError("not-a-regular-file", path);

  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    throw new EvmKeyFileError(problemForFsError(error), path);
  }

  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let length = 0;
  let mode: number;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new EvmKeyFileError("not-a-regular-file", path);
    mode = opened.mode & 0o777;
    if (opened.size > MAX_FILE_BYTES) throw new EvmKeyFileError("too-large", path);
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
  } catch (error) {
    buffer.fill(0);
    if (error instanceof EvmKeyFileError) throw error;
    throw new EvmKeyFileError("cannot-read", path);
  } finally {
    await handle.close().catch(() => undefined);
  }

  try {
    if (length > MAX_FILE_BYTES) throw new EvmKeyFileError("too-large", path);
    if (length === 0) throw new EvmKeyFileError("empty-file", path);
    // latin1: one character per byte, never a decode error, so the content is classified without being interpreted.
    const parsed = keyLineOrProblem(buffer.toString("latin1", 0, length));
    if ("problem" in parsed) throw new EvmKeyFileError(parsed.problem, path);

    let account: PrivateKeyAccount;
    try {
      account = privateKeyToAccount(parsed.key as `0x${string}`);
    } catch {
      // The library's own message is dropped: it is not ours to vouch that it never echoes its input.
      throw new EvmKeyFileError("not-a-valid-key", path);
    }

    // The mode is judged only once the file is known to be a key file we accept, so a refusal is never masked by a warning.
    if (platform !== "win32" && (mode & 0o077) !== 0) {
      warn(
        `evm key file ${path}: mode ${(mode & 0o777).toString(8).padStart(3, "0")} lets group or other users access the key; ` +
          "run chmod 600 on it (the key was loaded anyway)",
      );
    }
    return sealLocalAccount(account);
  } finally {
    buffer.fill(0);
  }
}

/**
 * Wraps a viem private-key account so that nothing but its address and type show (any viem `LocalAccount` is accepted:
 * src/rails/evm-signer.ts seals its guarded wrapper with this too): frozen; `address` and `type` the only
 * enumerable members; the signing functions, `publicKey` and `source` are real but non-enumerable (viem reads them by
 * name); `toJSON`, `toString`, `Symbol.toStringTag` and `util.inspect.custom` answer with the address and type only.
 * `structuredClone`, `Object.keys`, `Object.entries`, `{ ...account }` and `JSON.stringify` therefore see exactly
 * `{ address, type: "local" }`. The key is not a member: it lives in the closure of the viem account the signing
 * functions delegate to.
 */
export function sealLocalAccount(inner: LocalAccount): LocalAccount {
  const address: Address = inner.address;
  const sealed = {} as Record<string | symbol, unknown>;
  const shown = (): { address: Address; type: "local" } => ({ address, type: "local" });
  const text = (): string => `EvmLocalAccount { address: '${address}', type: 'local' }`;

  const define = (name: string | symbol, value: unknown, enumerable: boolean): void => {
    Object.defineProperty(sealed, name, { value, enumerable, writable: false, configurable: false });
  };
  define("address", address, true);
  define("type", "local", true);
  define("publicKey", inner.publicKey, false);
  define("source", "privateKey", false);
  define("sign", inner.sign === undefined ? undefined : (parameters: Parameters<NonNullable<typeof inner.sign>>[0]) => inner.sign!(parameters), false);
  define(
    "signAuthorization",
    inner.signAuthorization === undefined
      ? undefined
      : (parameters: Parameters<NonNullable<typeof inner.signAuthorization>>[0]) => inner.signAuthorization!(parameters),
    false,
  );
  define("signMessage", (parameters: Parameters<typeof inner.signMessage>[0]) => inner.signMessage(parameters), false);
  define(
    "signTransaction",
    ((transaction: never, options?: never) => inner.signTransaction(transaction, options)) as unknown as typeof inner.signTransaction,
    false,
  );
  define("signTypedData", ((typedData: never) => inner.signTypedData(typedData)) as unknown as typeof inner.signTypedData, false);
  define("toJSON", shown, false);
  define("toString", text, false);
  define(Symbol.toStringTag, "EvmLocalAccount", false);
  define(inspect.custom, text, false);
  return Object.freeze(sealed) as unknown as LocalAccount;
}
