// SPDX-License-Identifier: MIT
//
// tests/evm-code-hash-bin.test.ts: P9-2, bin/evm-code-hash.mjs against a throwaway HTTP server on 127.0.0.1 (no chain, no key, no
// public endpoint). The script prints the keccak256 of eth_getCode at latest and the byte length, two lines and nothing else, exits
// 3 on empty code and 4 on an endpoint that fails, and never prints the RPC URL. The anvil twin (the real node, the real contract)
// is tests-anvil/code-pin.anvil.test.ts.

import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { keccak256, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(fileURLToPath(new URL("../", import.meta.url)), "bin", "evm-code-hash.mjs");
const ADDRESS = "0x00000000000000000000000000000000000000a1";
const CODE: Hex = "0x6080604052348015600e575f5ffd5b50600436106100565760003560e01c8063ab12cd3414610059575b5f5ffd5b610061610063565b005b565bfea164736f6c6343000818000a";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("bin/evm-code-hash.mjs", () => {
  let server: Server;
  let base: string;
  /** What the server does with the next request: set per test. */
  let answer: (request: { method: string; body: Record<string, unknown> }, response: ServerResponse) => void;
  const seen: Array<{ method: string; params: unknown }> = [];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; params: unknown };
        seen.push({ method: body.method, params: body.params });
        answer({ method: request.method ?? "", body }, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const reply = (result: unknown) => (_request: unknown, response: ServerResponse) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };

  it("prints exactly the keccak256 of the code and its byte length, asks eth_getCode at latest, exit 0, nothing on stderr", async () => {
    seen.length = 0;
    answer = reply(CODE);
    const result = await run([base, ADDRESS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`keccak256 ${keccak256(CODE)}\nbytes ${(CODE.length - 2) / 2}\n`);
    expect(result.stderr).toBe("");
    expect(seen).toEqual([{ method: "eth_getCode", params: [ADDRESS, "latest"] }]);
  });

  it("accepts a checksummed or upper-case address", async () => {
    answer = reply(CODE);
    expect((await run([base, ADDRESS.toUpperCase().replace("0X", "0x")])).code).toBe(0);
  });

  it("empty code is exit 3 with nothing on stdout (an account, or a deploy that has not landed)", async () => {
    answer = reply("0x");
    const result = await run([base, ADDRESS]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/no code at 0x0+a1/);
  });

  it.each([
    ["a JSON-RPC error", (_r: unknown, response: ServerResponse) => response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } })), /JSON-RPC error: nope/],
    ["a result that is not hex", reply("not hex"), /did not answer hex bytes/],
    ["a result of an odd number of hex digits", reply("0x123"), /did not answer hex bytes/],
    ["a result that is not a string", reply(7), /did not answer hex bytes/],
    ["an HTTP error", (_r: unknown, response: ServerResponse) => { response.statusCode = 500; response.end("boom"); }, /answered HTTP 500/],
    ["a body that is not JSON", (_r: unknown, response: ServerResponse) => response.end("<html>"), /did not answer JSON/],
  ])("%s is exit 4 with nothing on stdout", async (_label, handler, message) => {
    answer = handler as typeof answer;
    const result = await run([base, ADDRESS]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(message);
  });

  it("an endpoint that cannot be reached is exit 4, and the URL (it may carry a key) is never printed", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve())); // nothing listens on this port now
    const result = await run([`http://127.0.0.1:${port}/some-path-token-xyzzy?apikey=plugh`, ADDRESS]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/could not be reached \(ECONNREFUSED\)/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/xyzzy|plugh|apikey/);
  });

  it.each([
    ["no arguments", []],
    ["one argument", ["http://127.0.0.1:1"]],
    ["three arguments", ["http://127.0.0.1:1", ADDRESS, "extra"]],
    ["a URL that is not one (and is not echoed)", ["not-a-url-secret-token", ADDRESS]],
    ["a URL that is not http", ["ftp://127.0.0.1/", ADDRESS]],
    ["an address that is too short", ["http://127.0.0.1:1", "0x1234"]],
    ["an address that is not hex", ["http://127.0.0.1:1", `0x${"zz".repeat(20)}`]],
  ])("%s is exit 2 and nothing is called", async (_label, args) => {
    seen.length = 0;
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/secret-token/);
    expect(seen).toEqual([]);
  });

  it("--help prints the usage on stdout and exits 0", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: node bin\/evm-code-hash\.mjs <rpc-url> <address>/);
  });
});
