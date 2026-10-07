#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// P9-6: the EVM rehearsal runner (handoff/P9-G1-READINESS-SPEC.md, rule 4: "nothing public before Dave"). One process plays
// both the Buyer and the Seller of one swap (leg A on an EVM chain, leg B on the FLOP paper rail) over a local venue and a
// local note file, signs with two local key files, and ends by writing the evidence bundle and replaying it offline with
// examples/audit-export.mjs. The default is a DRY RUN: it reads the chain, prints the pre-flight table with the two addresses
// and sends nothing. `--yes` broadcasts; Dave runs it. Everything it does is in src/client/rehearsal-run.ts (this file only
// reads the command line); it imports from ../dist/, so `npm run build` must run first.
//
// The only network it speaks to is rails.evm.endpoint in the config. It posts to no HTTP venue. It never prints a key, nor
// the endpoint URL (only its host).

/** The exit code for bad arguments, config or state (`EXIT.config` of src/client/rehearsal-run.ts), known before the module is loaded. */
const EXIT_CONFIG = 2;

const USAGE = `Usage: node bin/swap-rehearsal-evm.mjs <config.json> [--state-dir DIR] [--yes [--stop-after lock] | --resume | --refund [--wait]]

Runs one EVM atomic-swap rehearsal (the Buyer and the Seller in one process). With no mode flag it is a DRY RUN: it loads both
key files (to show the two addresses), reads the chain, prints the pre-flight table and the plan, and sends nothing. Exit 0 only
if every check that is needed holds.

Modes (at most one):
  (none)       Dry run: pre-flight only; no transaction, no file written.
  --yes        Run the swap: bid, accept, account lines, leg B on paper, leg A on chain (approve and lock), wait for the finalized
               read (real waiting), claim, learn the secret, claim leg B, write the bundle, replay it with audit-export
               (--expect <swapId>=settled). Runs the pre-flight first and refuses to broadcast unless it passes.
               --stop-after lock  ends after the lock: the Seller never claims (the first half of a refund rehearsal).
  --resume     Continue the run in --state-dir after a stop or a kill: both roles are rebuilt from their records, and a repeated lock
               or claim is refused by the contract and costs only gas. A run started with --stop-after lock stops at the lock again.
  --refund     Drive the refund path: the Buyer refunds leg A once its refund time has come, the Seller refunds leg B (the paper
               note) once its own has, then the bundle and --expect <swapId>=refunded (refunded-b when leg A was never locked).
               The Seller's key file is not needed for a refund (nothing of the Seller's moves on the chain): a missing one is a warning.
               --wait  wait here for a refund time that has not come (otherwise it is reported, exit 5, and the run can be repeated).

Options:
  --state-dir DIR  Where the run's records live: run.json, buyer/ and seller/ (P8 flow records, the venue's signing seeds), world/
                   (the local venue and paper notes). Secret-grade (it holds the Seller's swap secret). Default .state/rehearsal-evm.
  -h, --help       Show this message and exit 0.

The config is one JSON file (see README, "Deploying EvmHashRail to Base Sepolia"): rails.evm (an EvmRailConfig with contractCodeHash
and maxLogRange), buyerKeyFile, sellerKeyFile, deadlines, amount, out, and a few optional fields. Relative paths are relative to
the config file.

Exit codes: 0 done (or a clean dry run); 2 bad arguments, config or state; 3 pre-flight failed (nothing was sent); 4 a step refused
(its reason is printed); 5 not yet (a refund time has not come); 6 the bundle was written but audit-export did not accept it.
`;

function parse(argv) {
  const out = { config: null, stateDir: ".state/rehearsal-evm", mode: null, stopAfter: null, wait: false, help: false };
  const setMode = (mode) => {
    if (out.mode !== null && out.mode !== mode) return false;
    out.mode = mode;
    return true;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--yes":
        if (!setMode("yes")) return null;
        break;
      case "--resume":
        if (!setMode("resume")) return null;
        break;
      case "--refund":
        if (!setMode("refund")) return null;
        break;
      case "--wait":
        out.wait = true;
        break;
      case "--state-dir": {
        const value = argv[++i];
        if (value === undefined || value === "") return null;
        out.stateDir = value;
        break;
      }
      case "--stop-after": {
        const value = argv[++i];
        if (value !== "lock") return null;
        out.stopAfter = "lock";
        break;
      }
      default:
        if (arg.startsWith("-") || out.config !== null) return null;
        out.config = arg;
    }
  }
  return out;
}

const args = parse(process.argv.slice(2));
if (args === null) {
  process.stderr.write(USAGE);
  process.exit(EXIT_CONFIG);
}
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (args.config === null || (args.stopAfter !== null && args.mode !== "yes") || (args.wait && args.mode !== "refund")) {
  process.stderr.write(USAGE);
  process.exit(EXIT_CONFIG);
}

// Loaded only now, so that --help and a bad command line work without a build; a missing build is said in one line.
let runRehearsal;
try {
  ({ runRehearsal } = await import("../dist/client/rehearsal-run.js"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  const firstLine = String(error.message).split("\n")[0];
  process.stderr.write(`swap-rehearsal-evm: cannot load the runner (${firstLine}); run npm run build first (this CLI imports from ../dist/)\n`);
  process.exit(EXIT_CONFIG);
}

const env = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const code = await runRehearsal({
  configPath: args.config,
  mode: args.mode ?? "dry",
  stateDir: args.stateDir, // as typed: the runner refuses key-like text in it (KR2-1) before it resolves it against the working directory
  ...(args.stopAfter === null ? {} : { stopAfter: args.stopAfter }),
  ...(args.wait ? { wait: true } : {}),
  env,
});
// Not process.exit(): on Windows, Node 24 can abort ("UV_HANDLE_CLOSING") when it exits while a fetch connection is still closing. The
// exit code is set and the process ends by itself once its sockets are done (the runner leaves no timer or server running).
process.exitCode = code;
