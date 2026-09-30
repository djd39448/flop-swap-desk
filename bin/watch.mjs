#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CLI over src/watcher.ts's runSweep. Read-only; never posts. Imports from ../dist/, so
// `npm run build` must run first (see USAGE below).
//
// The continuous loop belongs to a scheduler (cron, a systemd timer, Task Scheduler), not
// to this process — only `--once` is implemented; without it this prints usage and exits 2.

import { readFileSync } from "node:fs";

import { runSweep } from "../dist/watcher.js";

const USAGE = `Usage: node bin/watch.mjs --root DIR [--base-url URL] [--max-deal-rooms N] [--timeout SEC] [--rails FILE] [--btc-rpc-cookie FILE] --once

Runs one read-only sweep of technocore.chat's tclk-offers export (and any deal rooms it
implies) and writes the board under DIR. Never posts, signs, or writes outside DIR.

Requires a build first: npm run build (this CLI imports from ../dist/, not ../src/).

Options:
  --root DIR            Required. Directory the sweep reads/writes under.
  --base-url URL        Venue base URL (default https://technocore.chat).
  --max-deal-rooms N     Cap on deal rooms fetched per sweep (default 50).
  --timeout SEC          Per-request timeout in seconds (default 45).
  --rails FILE           A JSON file shaped { "evm"?: EvmRailConfig, "btc"?: BtcRailConfig,
                          "near"?: NearRailConfig, "sol"?: SolRailConfig } naming the chain
                          rail(s) to capture live evidence from (P22-P24-EVM-SPEC.md §5;
                          P4-BTC-SPEC.md §7; P5-NEAR-SPEC.md §4; P6-SOL-SPEC.md §3). Absent (the
                          default): no RPC endpoint is ever touched, unchanged from before this
                          option existed. A "near" or "sol" config needs no out-of-band auth
                          (unlike "btc") — every read is a public JSON-RPC call. A "sol" config
                          also admits the Solana leg's own rail id for this sweep's board and
                          account lines (a local registry, never global); without it a Solana
                          leg reads as an unregistered rail.
  --btc-rpc-cookie FILE  P4-BTC-SPEC.md §1/§4/§7: bitcoind's own cookie file (its regtest/
                          signet datadir's ".cookie") — read once, turned into an HTTP Basic
                          auth header, and used ONLY for the "btc" rail's own RPC calls.
                          Never logged, never written to rails.json, a capture index, or any
                          other file this sweep writes. Required when --rails names a "btc"
                          config against a cookie-authenticated node; ignored otherwise.
  --once                 Run exactly one sweep and exit. Required — there is no built-in
                          loop; run this repeatedly from a scheduler instead.
  -h, --help              Show this message and exit 0.

Exit codes:
  0  sweep completed
  2  bad or missing arguments (nothing was run), --rails did not name readable JSON, or
     --btc-rpc-cookie did not name a readable file
  3  the sweep hit a transport failure or could not parse the offers export
`;

function parseArgs(argv) {
  const out = {
    root: null,
    baseUrl: null,
    maxDealRooms: null,
    timeoutSec: null,
    railsFile: null,
    btcRpcCookieFile: null,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--root":
        out.root = argv[++i];
        break;
      case "--base-url":
        out.baseUrl = argv[++i];
        break;
      case "--max-deal-rooms":
        out.maxDealRooms = argv[++i];
        break;
      case "--timeout":
        out.timeoutSec = argv[++i];
        break;
      case "--rails":
        out.railsFile = argv[++i];
        break;
      case "--btc-rpc-cookie":
        out.btcRpcCookieFile = argv[++i];
        break;
      case "--once":
        out.once = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        return null;
    }
  }
  return out;
}

function summarize(report) {
  const statuses = report.swapsByStatus ?? {};
  const statusPart = Object.keys(statuses).length
    ? Object.entries(statuses)
        .map(([status, count]) => `${status}=${count}`)
        .join(",")
    : "none";
  // chainReads only appears on a report at all when --rails was given (P22-P24-EVM-SPEC.md
  // §5) — omitted here too, rather than printed as 0, so a sweep without it prints exactly
  // what it always did.
  const chainPart = report.chainReads !== undefined ? ` chainReads=${report.chainReads}` : "";
  // btcChainReads only appears when --rails named a "btc" config (P4-BTC-SPEC.md §7) —
  // identical omission rule, and a separate field from chainReads (see SweepReport's own doc).
  const btcChainPart = report.btcChainReads !== undefined ? ` btcChainReads=${report.btcChainReads}` : "";
  // nearChainReads only appears when --rails named a "near" config (P5-NEAR-SPEC.md §4) —
  // identical omission rule, and a separate field from chainReads/btcChainReads.
  const nearChainPart = report.nearChainReads !== undefined ? ` nearChainReads=${report.nearChainReads}` : "";
  // P5-NEAR-FIXES.md E6: the *ReadsSkipped counts were computed on every report that has a
  // corresponding *Reads count, but never printed anywhere — a sweep whose every chain read
  // failed (a stalled RPC, a bad endpoint) looked identical to a healthy one at a glance, since
  // chainReads=0 and chainReadsSkipped=3 render the exact same "chainReads=0" on their own. Same
  // omission rule as the *Reads counts themselves: absent from the line entirely unless that
  // rail was configured for this sweep.
  const chainSkipPart = report.chainReadsSkipped !== undefined ? ` chainReadsSkipped=${report.chainReadsSkipped.length}` : "";
  const btcChainSkipPart = report.btcChainReadsSkipped !== undefined ? ` btcChainReadsSkipped=${report.btcChainReadsSkipped.length}` : "";
  const nearChainSkipPart = report.nearChainReadsSkipped !== undefined ? ` nearChainReadsSkipped=${report.nearChainReadsSkipped.length}` : "";
  // SB3a: the Solana twin - same omission rule: absent unless --rails named a "sol" config.
  const solChainPart = report.solChainReads !== undefined ? ` solChainReads=${report.solChainReads}` : "";
  const solChainSkipPart = report.solChainReadsSkipped !== undefined ? ` solChainReadsSkipped=${report.solChainReadsSkipped.length}` : "";
  return (
    `offers=${report.offerRecords} swapLegs=${report.swapLegOffers} ` +
    `dealRooms=${report.dealRoomsFetched} notes=${report.noteFetches} swaps[${statusPart}] ` +
    `swapsWritten=${report.swapsWritten} hit=${report.hitCreated} ok=${report.ok}` +
    `${chainPart}${chainSkipPart}${btcChainPart}${btcChainSkipPart}${nearChainPart}${nearChainSkipPart}${solChainPart}${solChainSkipPart}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.once || !args.root) {
    process.stderr.write(USAGE);
    return 2;
  }

  const options = { root: args.root, once: undefined };
  delete options.once;
  if (args.baseUrl !== null) options.baseUrl = args.baseUrl;
  if (args.maxDealRooms !== null) {
    const n = Number.parseInt(args.maxDealRooms, 10);
    if (!Number.isInteger(n) || n <= 0) {
      process.stderr.write(USAGE);
      return 2;
    }
    options.maxDealRooms = n;
  }
  if (args.timeoutSec !== null) {
    const s = Number.parseFloat(args.timeoutSec);
    if (!Number.isFinite(s) || s <= 0) {
      process.stderr.write(USAGE);
      return 2;
    }
    options.timeoutMs = Math.round(s * 1000);
  }
  if (args.railsFile !== null) {
    let raw;
    try {
      raw = readFileSync(args.railsFile, "utf8");
    } catch (error) {
      process.stderr.write(`watch.mjs: cannot read --rails file ${args.railsFile}: ${error.message}\n`);
      return 2;
    }
    try {
      options.rails = JSON.parse(raw);
    } catch (error) {
      process.stderr.write(`watch.mjs: --rails file ${args.railsFile} is not valid JSON: ${error.message}\n`);
      return 2;
    }
  }
  if (args.btcRpcCookieFile !== null) {
    // P4-BTC-SPEC.md §1/§4/§7: read once, turned into a Basic-auth header held only in this
    // process's memory — never logged, never assigned onto `options.rails` or anything else
    // that reaches disk (rpc-capture.ts's own `headers` option is never recorded on an
    // Exchange, and `RunSweepOptions.btcRpcHeaders`/`rails.json` never carry it either).
    let cookie;
    try {
      cookie = readFileSync(args.btcRpcCookieFile, "utf8").trim();
    } catch (error) {
      process.stderr.write(`watch.mjs: cannot read --btc-rpc-cookie file ${args.btcRpcCookieFile}: ${error.message}\n`);
      return 2;
    }
    const authHeader = `Basic ${Buffer.from(cookie).toString("base64")}`;
    options.btcRpcHeaders = () => ({ Authorization: authHeader });
  }

  const report = await runSweep(options);
  process.stdout.write(`${summarize(report)}\n`);
  // P5-NEAR-FIXES.md E6: `report.railsConfigError` was already set (and the sweep already
  // aborted) whenever --rails named an invalid evm/btc/near config — but this CLI never printed
  // it, so a bad rails config silently produced exit code 3 with no reason on stderr at all
  // (the same generic "sweep did not complete" outcome as a transport failure or a parse error,
  // below).
  if (report.railsConfigError) {
    process.stderr.write(`rails config invalid: ${report.railsConfigError}\n`);
    return 3;
  }
  if (report.transport) {
    process.stderr.write(`transport failure: ${report.transport.url}: ${report.transport.error}\n`);
    return 3;
  }
  if (report.offerParseError) {
    process.stderr.write(`offers export did not parse: ${report.offerParseError}\n`);
    return 3;
  }
  return report.ok ? 0 : 3;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`watch.mjs: unexpected error: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 3;
  },
);
