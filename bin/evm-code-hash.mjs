#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// P9-2: prints the keccak256 of the code deployed at an address (eth_getCode at "latest") and its length in bytes: the value
// EvmRailConfig.contractCodeHash must carry for that contract (a Base Sepolia config cannot be used without it). Read-only, one
// JSON-RPC call, no key, no write. It never prints the RPC URL (an endpoint may carry a key in its path or query).
//
// Exit codes: 0 printed; 2 bad arguments (nothing was called); 3 no code at the address (an account, or a deploy that has not
// landed); 4 the endpoint could not be reached, answered an error or answered something that is not hex bytes.

import { isAddress, keccak256 } from "viem";

const USAGE = `Usage: node bin/evm-code-hash.mjs <rpc-url> <address>

Prints the keccak256 of the code at <address> (eth_getCode at "latest") and its byte length, two lines, nothing else:

  keccak256 0x<64 hex digits>
  bytes <n>

Put the hash in EvmRailConfig.contractCodeHash (rails.json). PROVENANCE.md records the value the vendored EvmHashRail.sol builds to;
a contract deployed from this repository's source with the pinned toolchain must report exactly that.

Exit codes: 0 printed, 2 bad arguments, 3 no code at the address, 4 the endpoint failed or answered something unusable.
`;

const TIMEOUT_MS = 45_000;
/** A contract's code is at most 24 KiB (48 KiB of hex); anything near this is not a JSON-RPC answer for eth_getCode. */
const MAX_RESPONSE_BYTES = 1_048_576;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

function fail(code, message) {
  process.stderr.write(`evm-code-hash: ${message}\n`);
  process.exit(code);
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail(4, "the endpoint's answer is larger than any contract code");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.length !== 2) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const [rpcUrl, address] = argv;
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    fail(2, "<rpc-url> is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(2, "<rpc-url> must be an http or https URL");
  if (!isAddress(address, { strict: false })) fail(2, "<address> is not a 20-byte 0x address");

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.name ?? "error";
    fail(4, `the endpoint could not be reached (${reason})`);
  }
  if (!response.ok) fail(4, `the endpoint answered HTTP ${response.status}`);
  let body;
  try {
    body = JSON.parse(await readCapped(response));
  } catch {
    fail(4, "the endpoint did not answer JSON");
  }
  if (body === null || typeof body !== "object") fail(4, "the endpoint did not answer a JSON-RPC object");
  if (body.error !== undefined && body.error !== null) {
    const message = typeof body.error.message === "string" ? body.error.message.slice(0, 200) : "unknown error";
    fail(4, `the endpoint answered a JSON-RPC error: ${message}`);
  }
  const code = body.result;
  if (typeof code !== "string" || !HEX_BYTES.test(code)) fail(4, "eth_getCode did not answer hex bytes");
  if (code.length === 2) fail(3, `no code at ${address} (eth_getCode returned 0x)`);
  process.stdout.write(`keccak256 ${keccak256(code)}\nbytes ${(code.length - 2) / 2}\n`);
}

await main(process.argv.slice(2));
