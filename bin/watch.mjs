#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CLI over src/watcher.ts's runSweep. Read-only; never posts. Imports from ../dist/, so
// `npm run build` must run first (see USAGE below).
//
// The continuous loop belongs to a scheduler (cron, a systemd timer, Task Scheduler), not
// to this process — only `--once` is implemented; without it this prints usage and exits 2.

import { runSweep } from "../dist/watcher.js";

const USAGE = `Usage: node bin/watch.mjs --root DIR [--base-url URL] [--max-deal-rooms N] [--timeout SEC] --once

Runs one read-only sweep of technocore.chat's tclk-offers export (and any deal rooms it
implies) and writes the board under DIR. Never posts, signs, or writes outside DIR.

Requires a build first: npm run build (this CLI imports from ../dist/, not ../src/).

Options:
  --root DIR            Required. Directory the sweep reads/writes under.
  --base-url URL        Venue base URL (default https://technocore.chat).
  --max-deal-rooms N     Cap on deal rooms fetched per sweep (default 50).
  --timeout SEC          Per-request timeout in seconds (default 45).
  --once                 Run exactly one sweep and exit. Required — there is no built-in
                          loop; run this repeatedly from a scheduler instead.
  -h, --help              Show this message and exit 0.

Exit codes:
  0  sweep completed
  2  bad or missing arguments (nothing was run)
  3  the sweep hit a transport failure or could not parse the offers export
`;

function parseArgs(argv) {
  const out = { root: null, baseUrl: null, maxDealRooms: null, timeoutSec: null, once: false };
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
  return (
    `offers=${report.offerRecords} swapLegs=${report.swapLegOffers} ` +
    `dealRooms=${report.dealRoomsFetched} notes=${report.noteFetches} swaps[${statusPart}] ` +
    `swapsWritten=${report.swapsWritten} hit=${report.hitCreated} ok=${report.ok}`
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

  const report = await runSweep(options);
  process.stdout.write(`${summarize(report)}\n`);
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
