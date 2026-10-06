// SPDX-License-Identifier: MIT
//
// tests/rehearsal-preflight.test.ts: P9-6 (rule 4), the pre-flight table of the EVM rehearsal runner (src/client/rehearsal-preflight.ts)
// against a fake read-only chain that answers like the public Base Sepolia endpoint and breaks one answer at a time (tests/helpers/
// fake-chain.ts). Every row has a case that turns it from OK to FAIL (or to a warning where the row only warns); the table shows both
// addresses and the endpoint's host only, never a key or the URL; and nothing in it is a write: the fake chain records every method, and
// the only ones asked are reads.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { EVM_LOCAL_POLICY } from "../src/client/policy.js";
import {
  absoluteDeadlines,
  KNOWN_GOOD_DEADLINES,
  LOCK_ESTIMATE_MS,
  parseRehearsalConfig,
  type DeadlineMinutes,
  type RehearsalConfig,
} from "../src/client/rehearsal-config.js";
import {
  CLOCK_SKEW_BOUND_MS,
  describeFailure,
  GAS_CEILING,
  GAS_PRICE_CUSHION,
  LOCK_SETTLE_ALLOWANCE_MS,
  renderPreflight,
  runPreflight,
  type PreflightInput,
  type PreflightReport,
  type PreflightRow,
  type RowStatus,
} from "../src/client/rehearsal-preflight.js";
import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN } from "../src/rails/evm-htlc.js";
import { fakeChain, FAKE_ESCROW_CODE_HASH, type FakeChainOptions } from "./helpers/fake-chain.js";
import { scriptedRpc } from "./helpers/scripted-rpc.js";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HEAD_SEC = 1_790_000_000;
const NOW_MS = HEAD_SEC * 1000 + 2_000;
const buyerAddress = privateKeyToAccount(generatePrivateKey()).address;
const sellerAddress = privateKeyToAccount(generatePrivateKey()).address;

function config(evmExtra: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, pin: typeof BASE_SEPOLIA_PIN = BASE_SEPOLIA_PIN): RehearsalConfig {
  return parseRehearsalConfig(
    {
      rails: { evm: { pin, endpoint: "https://sepolia.base.org/secretpath", contract: CONTRACT, assets: { USDC: TOKEN }, contractCodeHash: FAKE_ESCROW_CODE_HASH, ...evmExtra } },
      buyerKeyFile: "buyer.key",
      sellerKeyFile: "seller.key",
      amount: "1000000",
      out: "bundle",
      ...extra,
    },
    "/base",
  );
}

interface Run {
  report: PreflightReport;
  methods: string[];
  logRanges: Array<[bigint, bigint]>;
  text: string;
}

async function preflight(
  chainOptions: FakeChainOptions = {},
  configuration: RehearsalConfig = config(),
  overrides: Partial<PreflightInput> = {},
  minutes: DeadlineMinutes = KNOWN_GOOD_DEADLINES,
): Promise<Run> {
  const chain = fakeChain({
    headTimestampSec: HEAD_SEC,
    tokenBalances: { [buyerAddress.toLowerCase()]: 100_000_000n },
    ...chainOptions,
  });
  const { rpc } = scriptedRpc(chain.handlers);
  const absolute = absoluteDeadlines(minutes, NOW_MS);
  const report = await runPreflight({
    config: configuration,
    rpc,
    buyer: { address: buyerAddress },
    seller: { address: sellerAddress },
    nowMs: NOW_MS,
    fresh: true,
    deadlines: { absolute, lockTimeMs: NOW_MS + LOCK_ESTIMATE_MS },
    policy: EVM_LOCAL_POLICY,
    redact: (text) => text.split("sepolia.base.org/secretpath").join("<rpc endpoint>"),
    ...overrides,
  });
  return { report, methods: chain.methods, logRanges: chain.logRanges, text: renderPreflight(report, "title").join("\n") };
}

function row(run: Run, check: string): PreflightRow {
  const found = run.report.rows.find((r) => r.check === check);
  if (found === undefined) throw new Error(`no row "${check}" in ${run.report.rows.map((r) => r.check).join(", ")}`);
  return found;
}

function status(run: Run, check: string): RowStatus {
  return row(run, check).status;
}

describe("a healthy chain (every needed check holds)", () => {
  it("is all OK, shows both addresses and the host, never the URL or a path, and says so in one line", async () => {
    const run = await preflight();
    expect(run.report.ok).toBe(true);
    expect(run.report.rows.filter((r) => r.status === "fail")).toEqual([]);
    for (const check of ["endpoint", "chain id", "escrow code", "finalized", "finality budget", "pending", "state at finalized", "log range", "clock", "buyer ETH", "seller ETH", "buyer token", "deadlines"]) {
      expect(status(run, check), check).toBe("ok");
    }
    expect(run.text).toContain(buyerAddress);
    expect(run.text).toContain(sellerAddress);
    expect(run.text).toContain("host sepolia.base.org");
    expect(run.text).not.toContain("secretpath");
    expect(run.text).not.toContain("https://");
    expect(run.text).toMatch(/RESULT: every check that is needed holds \(\d+ ok, 0 warnings\)\./);
    expect(row(run, "escrow code").detail).toContain(FAKE_ESCROW_CODE_HASH.toLowerCase());
    expect(row(run, "finalized").detail).toMatch(/600 blocks and 1200 s \(20\.0 min\) behind the head/);
    expect(row(run, "buyer token").detail).toContain("100 USDC (100000000 units)");
  });

  it("only reads: no write method is ever asked of the node", async () => {
    const run = await preflight();
    const allowed = new Set(["eth_chainId", "eth_getCode", "eth_getBlockByNumber", "eth_call", "eth_getLogs", "eth_gasPrice", "eth_getBalance"]);
    expect(run.methods.length).toBeGreaterThan(10);
    expect(run.methods.filter((m) => !allowed.has(m))).toEqual([]);
  });

  it("probes the log cap with exactly the cap and one more block", async () => {
    const run = await preflight();
    const head = 40_000_000n;
    expect(run.logRanges).toEqual([
      [head - 499n, head], // 500 blocks, both ends counted: must be accepted
      [head - 500n, head], // 501 blocks: must be refused
    ]);
    expect(row(run, "log range").detail).toContain("accepted 500 blocks and refused 501");
  });
});

describe("the chain and the escrow", () => {
  it("fails on another chain id", async () => {
    const run = await preflight({ chainId: 1 });
    expect(status(run, "chain id")).toBe("fail");
    expect(row(run, "chain id").detail).toContain("the node is chain 1, the pin says 84532");
    expect(run.report.ok).toBe(false);
  });

  it("fails when the escrow's code is not the pinned one, is empty, or is not hex", async () => {
    const mismatch = await preflight({ code: "0x6080" });
    expect(status(mismatch, "escrow code")).toBe("fail");
    expect(row(mismatch, "escrow code").detail).toContain("not the pinned contractCodeHash");
    const empty = await preflight({ code: "0x" });
    expect(status(empty, "escrow code")).toBe("fail");
    expect(row(empty, "escrow code").detail).toContain("no code at");
    const failed = await preflight({ code: "error" });
    expect(status(failed, "escrow code")).toBe("fail");
    expect(row(failed, "escrow code").detail).toContain("eth_getCode failed");
  });

  it("prints the observed hash for an unpinned anvil config so a person can pin it, and still fails on empty code", async () => {
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const evm = anvil.rails.evm;
    expect(evm.contractCodeHash).toBeUndefined();
    const run = await preflight({ chainId: 31337 }, anvil);
    expect(status(run, "escrow code")).toBe("info");
    expect(row(run, "escrow code").detail).toContain(FAKE_ESCROW_CODE_HASH.toLowerCase());
    expect(row(run, "escrow code").detail).toContain("not pinned");
    const empty = await preflight({ chainId: 31337, code: "0x" }, anvil);
    expect(status(empty, "escrow code")).toBe("fail");
  });
});

describe("finality", () => {
  it("fails with no finalized tag and no fallback: the Seller could never claim", async () => {
    const run = await preflight({ noFinalizedTag: true });
    expect(status(run, "finalized")).toBe("fail");
    expect(row(run, "finalized").detail).toContain("no fallbackConfirmations");
    expect(status(run, "state at finalized")).toBe("fail");
    expect(status(run, "finality budget")).toBe("fail");
    expect(run.report.ok).toBe(false);
  });

  it("warns (and goes on) when the tag is missing but the config names a fallback in confirmations", async () => {
    const withFallback = config({ pin: { ...BASE_SEPOLIA_PIN, finality: { mode: "tag", tag: "finalized", fallbackConfirmations: 200 } } });
    const run = await preflight({ noFinalizedTag: true }, withFallback);
    expect(status(run, "finalized")).toBe("warn");
    expect(row(run, "finalized").detail).toContain("falls back to 200 confirmations");
    expect(run.report.ok).toBe(true);
  });

  it("reads a confirmations pin by block number", async () => {
    const confirmations = config({ pin: { ...BASE_SEPOLIA_PIN, finality: { mode: "confirmations", confirmations: 12 } } });
    const run = await preflight({}, confirmations);
    expect(status(run, "finalized")).toBe("ok");
    expect(row(run, "finalized").detail).toContain("12 confirmations");
    expect(run.report.ok).toBe(true);
  });

  it("sets the measured lag against leg A's claim-by: 39 minutes fits a 60-minute claim-by, 55 minutes does not", async () => {
    const fits = await preflight({ finalizedLagSec: 39 * 60 });
    expect(status(fits, "finality budget")).toBe("ok");
    expect(row(fits, "finality budget").detail).toContain("to spare");
    const tooSlow = await preflight({ finalizedLagSec: 55 * 60 });
    expect(status(tooSlow, "finality budget")).toBe("fail");
    expect(row(tooSlow, "finality budget").detail).toContain("the Seller could not claim in time");
    expect(tooSlow.report.ok).toBe(false);
    // The allowance for landing the lock is part of the sum: a lag of exactly (claim-by - allowance) still fits.
    const edge = await preflight({ finalizedLagSec: (60 * 60_000 - LOCK_SETTLE_ALLOWANCE_MS) / 1000 });
    expect(status(edge, "finality budget")).toBe("ok");
    const over = await preflight({ finalizedLagSec: (60 * 60_000 - LOCK_SETTLE_ALLOWANCE_MS) / 1000 + 1 });
    expect(status(over, "finality budget")).toBe("fail");
  });

  it("fails when the state at the finalized block cannot be read by its hash (a pruned node)", async () => {
    const run = await preflight({ noStateAtFinalized: true });
    expect(status(run, "state at finalized")).toBe("fail");
    expect(row(run, "state at finalized").detail).toContain("the evidence reader needs exactly this read");
  });

  it("fails when the pending tag is unusable, and accepts a pending block that carries only a timestamp", async () => {
    for (const pending of ["error", "null"] as const) {
      const run = await preflight({ pending });
      expect(status(run, "pending"), pending).toBe("fail");
    }
    const bare = await preflight({ pending: "bare" });
    expect(status(bare, "pending")).toBe("ok");
  });
});

describe("the log range cap", () => {
  it("fails when the endpoint refuses even the configured number of blocks", async () => {
    const run = await preflight({ logCap: 100 });
    expect(status(run, "log range")).toBe("fail");
    expect(row(run, "log range").detail).toContain("refused a scan of 500 blocks");
  });

  it("warns when the endpoint is looser than the config (the chunks are safe, just narrower than needed)", async () => {
    const run = await preflight({ logCap: 800 });
    expect(status(run, "log range")).toBe("warn");
    expect(row(run, "log range").detail).toContain("cap is looser than the config's value");
    expect(run.report.ok).toBe(true);
  });

  it("probes exactly the configured maxLogRange when one is set", async () => {
    const run = await preflight({ logCap: 100 }, config({ maxLogRange: 100 }));
    expect(status(run, "log range")).toBe("ok");
    expect(row(run, "log range").detail).toContain("accepted 100 blocks and refused 101");
    const head = 40_000_000n;
    expect(run.logRanges).toEqual([[head - 99n, head], [head - 100n, head]]);
  });

  it("only reports when the chain is too short to probe, and probes the whole chain when no limit applies (anvil)", async () => {
    const short = await preflight({ headNumber: 30n, finalizedLagBlocks: 2n });
    expect(status(short, "log range")).toBe("info");
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const unlimited = await preflight({ chainId: 31337, headNumber: 50n, finalizedLagBlocks: 2n, logCap: null }, anvil);
    expect(status(unlimited, "log range")).toBe("ok");
    expect(unlimited.logRanges).toEqual([[0n, 50n]]);
    const capped = await preflight({ chainId: 31337, headNumber: 5_000n, finalizedLagBlocks: 2n, logCap: 500 }, anvil);
    expect(status(capped, "log range")).toBe("warn");
    expect(row(capped, "log range").detail).toContain("set maxLogRange");
  });
});

describe("the clock", () => {
  it("fails on a public chain when the local clock and the head are more than a minute apart, in either direction", async () => {
    const ahead = await preflight({ headTimestampSec: HEAD_SEC - Math.ceil(CLOCK_SKEW_BOUND_MS / 1000) - 5 });
    expect(status(ahead, "clock")).toBe("fail");
    expect(row(ahead, "clock").detail).toContain("the head is behind");
    const behind = await preflight({ headTimestampSec: HEAD_SEC + 200 });
    expect(status(behind, "clock")).toBe("fail");
    expect(row(behind, "clock").detail).toContain("the local clock is behind");
  });

  it("does not hold an idle anvil head against the clock, and reports the chain clock when the config asks for it", async () => {
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const idle = await preflight({ chainId: 31337, headTimestampSec: HEAD_SEC - 3600 }, anvil);
    expect(status(idle, "clock")).toBe("ok");
    const chainClock = config({ contractCodeHash: undefined }, { clock: "chain" }, ANVIL_LOCAL_PIN);
    const followed = await preflight({ chainId: 31337, headTimestampSec: HEAD_SEC - 3600 }, chainClock);
    expect(status(followed, "clock")).toBe("info");
    expect(row(followed, "clock").detail).toContain("follows the chain's head");
  });
});

describe("the accounts", () => {
  it("fails an account with too little ETH for its gas, naming the address and the need, and passes at exactly the need", async () => {
    const price = 1_000_000n;
    const buyerNeed = (GAS_CEILING.approve + GAS_CEILING.lock + GAS_CEILING.refund) * price * GAS_PRICE_CUSHION;
    const sellerNeed = GAS_CEILING.claim * price * GAS_PRICE_CUSHION;
    const short = await preflight({ ethBalances: { [buyerAddress.toLowerCase()]: buyerNeed - 1n, [sellerAddress.toLowerCase()]: sellerNeed - 1n } });
    expect(status(short, "buyer ETH")).toBe("fail");
    expect(status(short, "seller ETH")).toBe("fail");
    expect(row(short, "buyer ETH").detail).toContain(buyerAddress);
    expect(row(short, "buyer ETH").detail).toContain("fund it first");
    const exact = await preflight({ ethBalances: { [buyerAddress.toLowerCase()]: buyerNeed, [sellerAddress.toLowerCase()]: sellerNeed } });
    expect(status(exact, "buyer ETH")).toBe("ok");
    expect(status(exact, "seller ETH")).toBe("ok");
  });

  it("scales the need with the node's gas price (a price spike fails a balance that was fine)", async () => {
    const run = await preflight({ gasPriceWei: 1_000_000_000_000n }); // 1000 gwei
    expect(status(run, "buyer ETH")).toBe("fail");
  });

  it("fails when the gas price cannot be read, since the need cannot be set against it", async () => {
    const chain = fakeChain({ headTimestampSec: HEAD_SEC, tokenBalances: { [buyerAddress.toLowerCase()]: 100_000_000n } });
    const handlers = { ...chain.handlers, eth_gasPrice: () => ({ error: { code: -32000, message: "no price" } }) };
    const { rpc } = scriptedRpc(handlers);
    const report = await runPreflight({
      config: config(),
      rpc,
      buyer: { address: buyerAddress },
      seller: { address: sellerAddress },
      nowMs: NOW_MS,
      fresh: true,
      deadlines: { absolute: absoluteDeadlines(KNOWN_GOOD_DEADLINES, NOW_MS), lockTimeMs: NOW_MS + LOCK_ESTIMATE_MS },
      policy: EVM_LOCAL_POLICY,
      redact: (t) => t,
    });
    expect(report.rows.find((r) => r.check === "gas price")?.status).toBe("fail");
    expect(report.rows.find((r) => r.check === "buyer ETH")?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails a Buyer short of tokens and shows the allowance as information", async () => {
    const short = await preflight({ tokenBalances: { [buyerAddress.toLowerCase()]: 999_999n } });
    expect(status(short, "buyer token")).toBe("fail");
    expect(row(short, "buyer token").detail).toContain("fund it first");
    const exact = await preflight({ tokenBalances: { [buyerAddress.toLowerCase()]: 1_000_000n }, allowances: { [buyerAddress.toLowerCase()]: 5_000_000n } });
    expect(status(exact, "buyer token")).toBe("ok");
    expect(status(exact, "buyer allowance")).toBe("info");
    expect(row(exact, "buyer allowance").detail).toContain("5 USDC (5000000 units)");
  });

  it("shows raw units when the token does not answer decimals()", async () => {
    const run = await preflight({ decimals: null });
    expect(row(run, "buyer token").detail).toContain("100000000 units of USDC");
    expect(status(run, "buyer token")).toBe("ok");
  });

  it("fails when both parties are the same account, and when a key file did not load (with the loader's own text, no key)", async () => {
    const same = await preflight({}, config(), { seller: { address: buyerAddress } });
    expect(status(same, "accounts")).toBe("fail");
    expect(row(same, "accounts").detail).toContain("the same account");
    const problem = "evm key file /k/buyer.key: no such file";
    const run = await preflight({}, config(), { buyer: { problem } });
    expect(status(run, "buyer account")).toBe("fail");
    expect(row(run, "buyer account").detail).toBe(problem);
    expect(run.report.rows.some((r) => r.check === "buyer ETH")).toBe(false);
    expect(run.report.ok).toBe(false);
  });
});

describe("the deadlines", () => {
  it("fails a set that breaks SPEC 3.5 and names the rule", async () => {
    const tooShort: DeadlineMinutes = { legA: { claimByMin: 30, refundAfterMin: 40, expiresMin: 20 }, legB: { claimByMin: 120, refundAfterMin: 180, expiresMin: 40 } };
    const run = await preflight({}, config(), {}, tooShort);
    expect(status(run, "deadlines")).toBe("fail");
    expect(row(run, "deadlines").detail).toContain("rule 1");
    const legBTooEarly: DeadlineMinutes = { legA: KNOWN_GOOD_DEADLINES.legA, legB: { claimByMin: 70, refundAfterMin: 100, expiresMin: 40 } };
    const rule2 = await preflight({}, config(), {}, legBTooEarly);
    expect(row(rule2, "deadlines").detail).toContain("rule 2");
  });

  it("fails a leg A whose claim-by is too close to its refund time for the Seller's claim margin", async () => {
    const tight: DeadlineMinutes = { legA: { claimByMin: 87, refundAfterMin: 90, expiresMin: 30 }, legB: KNOWN_GOOD_DEADLINES.legB };
    const run = await preflight({}, config(), {}, tight);
    expect(status(run, "deadlines")).toBe("fail");
    expect(row(run, "deadlines").detail).toContain("claim-inclusion margin");
  });

  it("prints the absolute deadlines of the known-good set", async () => {
    const run = await preflight();
    const detail = row(run, "deadlines").detail;
    expect(detail).toContain(new Date(NOW_MS + 60 * 60_000).toISOString());
    expect(detail).toContain(new Date(NOW_MS + 180 * 60_000).toISOString());
  });
});

describe("a resume or a refund (fresh = false)", () => {
  it("leaves out the rows that belong to a new swap (deadlines, token, finality budget) and keeps the chain rows", async () => {
    const run = await preflight({}, config(), { fresh: false });
    const checks = run.report.rows.map((r) => r.check);
    for (const gone of ["deadlines", "buyer token", "buyer allowance", "finality budget"]) expect(checks).not.toContain(gone);
    for (const kept of ["chain id", "escrow code", "finalized", "pending", "state at finalized", "log range", "clock", "buyer ETH", "seller ETH"]) expect(checks).toContain(kept);
    expect(run.report.ok).toBe(true);
  });
});

describe("rows a mode does not need", () => {
  it("shows a failed row that the mode does not use as a warning (it no longer stops the mode), and still fails one the mode needs", async () => {
    const notNeeded = new Set(["pending", "log range"]);
    const run = await preflight({ pending: "error", logCap: 100 }, config(), { notNeeded });
    expect(status(run, "pending")).toBe("warn");
    expect(row(run, "pending").detail).toMatch(/^\(not needed for this mode\) the pending tag is unusable/);
    expect(status(run, "log range")).toBe("warn");
    expect(run.report.ok).toBe(true);
    const needed = await preflight({ pending: "error", noFinalizedTag: true }, config(), { notNeeded });
    expect(status(needed, "finalized")).toBe("fail");
    expect(needed.report.ok).toBe(false);
    // Without the set, the same chain fails on the pending row.
    expect(status(await preflight({ pending: "error" }), "pending")).toBe("fail");
  });
});

describe("failure texts", () => {
  it("keep one line, are capped, prefer a library's short message and never carry the endpoint", () => {
    const redact = (t: string): string => t.split("https://rpc.example/v2/KEY").join("<rpc endpoint>");
    expect(describeFailure(new Error("first line\nsecond line with request body"), redact)).toBe("first line");
    expect(describeFailure(Object.assign(new Error("long message"), { shortMessage: "the short one" }), redact)).toBe("the short one");
    expect(describeFailure(new Error(`fetch to https://rpc.example/v2/KEY failed`), redact)).toBe("fetch to <rpc endpoint> failed");
    const capped = describeFailure(new Error("x".repeat(1000)), redact);
    expect(capped.length).toBe(300);
    expect(capped.endsWith("...")).toBe(true);
    expect(describeFailure("a plain string", redact)).toBe("a plain string");
  });

  it("redact a transport error that names the endpoint, in the table itself", async () => {
    const chain = fakeChain({ headTimestampSec: HEAD_SEC });
    const rpc = {
      request: async ({ method }: { method: string }): Promise<unknown> => {
        if (method === "eth_chainId") throw new Error("rpc-capture: response for eth_chainId is too large (endpoint https://sepolia.base.org/secretpath)");
        return chain.handlers[method]?.([])?.result;
      },
    };
    const report = await runPreflight({
      config: config(),
      rpc,
      buyer: { address: buyerAddress },
      seller: { address: sellerAddress },
      nowMs: NOW_MS,
      fresh: false,
      policy: EVM_LOCAL_POLICY,
      redact: (text) => text.split("https://sepolia.base.org/secretpath").join("<rpc endpoint>"),
    });
    const text = renderPreflight(report, "t").join("\n");
    expect(text).toContain("<rpc endpoint>");
    expect(text).not.toContain("secretpath");
  });
});

describe("renderPreflight", () => {
  it("labels each status, aligns the check names and ends in one RESULT line that counts the failures", async () => {
    const run = await preflight({ chainId: 1, logCap: 800 });
    const lines = renderPreflight(run.report, "the title");
    expect(lines[0]).toBe("the title");
    expect(lines.some((l) => /^ {2}FAIL {2}chain id/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {2}WARN {2}log range/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {2}OK {4}endpoint/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^RESULT: \d+ check\(s\) failed \(\d+ ok, 1 warnings\): the swap cannot start\.$/);
  });
});
