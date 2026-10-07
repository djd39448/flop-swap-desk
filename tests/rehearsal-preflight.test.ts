// SPDX-License-Identifier: MIT
//
// tests/rehearsal-preflight.test.ts: P9-6 (rule 4), the pre-flight table of the EVM rehearsal runner (src/client/rehearsal-preflight.ts)
// against a fake read-only chain that answers like the public Base Sepolia endpoint and breaks one answer at a time (tests/helpers/
// fake-chain.ts). Every row has a case that turns it from OK to FAIL (or to a warning where the row only warns); the table shows both
// addresses and the endpoint's host only, never a key or the URL; and nothing in it is a write: the fake chain records every method, and
// the only ones asked are reads.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { BASE_SEPOLIA_POLICY, EVM_LOCAL_POLICY, evmLocalPolicyFor, knownGoodDeadlinesFor } from "../src/client/policy.js";
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
import { CLAIM_MARKER_REORG_MARGIN_EVM } from "../src/client/seller.js";
import { ANVIL_LOCAL_PIN, BASE_SEPOLIA_PIN, MAX_LOG_SCAN_CHUNKS } from "../src/rails/evm-htlc.js";
import { fakeChain, FAKE_ESCROW_CODE_HASH, type FakeChainOptions } from "./helpers/fake-chain.js";
import { scriptedRpc } from "./helpers/scripted-rpc.js";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HEAD_SEC = 1_790_000_000;
const NOW_MS = HEAD_SEC * 1000 + 2_000;
/** The known-good deadline sets of the two chains (P9-4 decision 2), as the runner's config resolves them. */
const ANVIL_SET = KNOWN_GOOD_DEADLINES[31337];
const BASE_SET = KNOWN_GOOD_DEADLINES[84532];
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
  nonceReads: Array<[string, string]>;
  text: string;
}

async function preflight(
  chainOptions: FakeChainOptions = {},
  configuration: RehearsalConfig = config(),
  overrides: Partial<PreflightInput> = {},
  minutes?: DeadlineMinutes,
): Promise<Run> {
  const chain = fakeChain({
    headTimestampSec: HEAD_SEC,
    tokenBalances: { [buyerAddress.toLowerCase()]: 100_000_000n },
    ...chainOptions,
  });
  const { rpc } = scriptedRpc(chain.handlers);
  // P9-4 decisions 1 and 2: the rail's policy and the known-good set are the pin's chain's own, as the runner hands them over.
  const chainId = configuration.rails.evm.pin.chainId;
  const absolute = absoluteDeadlines(minutes ?? knownGoodDeadlinesFor(chainId), NOW_MS);
  const report = await runPreflight({
    config: configuration,
    rpc,
    buyer: { address: buyerAddress },
    seller: { address: sellerAddress },
    nowMs: NOW_MS,
    fresh: true,
    deadlines: { absolute, lockTimeMs: NOW_MS + LOCK_ESTIMATE_MS },
    policy: evmLocalPolicyFor(chainId),
    redact: (text) => text.split("sepolia.base.org/secretpath").join("<rpc endpoint>"),
    ...overrides,
  });
  return { report, methods: chain.methods, logRanges: chain.logRanges, nonceReads: chain.nonceReads, text: renderPreflight(report, "title").join("\n") };
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
    const allowed = new Set(["eth_chainId", "eth_getCode", "eth_getBlockByNumber", "eth_call", "eth_getLogs", "eth_gasPrice", "eth_getBalance", "eth_maxPriorityFeePerGas", "eth_getTransactionCount"]);
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

describe("the endpoint", () => {
  const withEndpoint = (endpoint: string): RehearsalConfig => config({ endpoint });

  it("warns about plain http to a host that is not this machine (a claim carries the swap's secret), and not for https or loopback", async () => {
    const plain = await preflight({}, withEndpoint("http://rpc.example.org:8545"));
    expect(status(plain, "endpoint")).toBe("warn");
    expect(row(plain, "endpoint").detail).toContain("over plain http");
    expect(row(plain, "endpoint").detail).toContain("host rpc.example.org:8545");
    expect(plain.report.ok).toBe(true); // a warning, not a failure
    expect(status(await preflight({}, withEndpoint("https://rpc.example.org")), "endpoint")).toBe("ok");
    expect(status(await preflight({}, withEndpoint("http://127.0.0.1:8545")), "endpoint")).toBe("ok");
    expect(status(await preflight({}, withEndpoint("http://localhost:8545")), "endpoint")).toBe("ok");
    expect(status(await preflight({}, withEndpoint("http://[::1]:8545")), "endpoint")).toBe("ok");
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

  // P9-4 decision 3: a fallback and confirmations mode are refused for chain 84532 by the config check, so these two rows are exercised on anvil (31337), where
  // both are still allowed.
  it("warns (and goes on) when the tag is missing but the config names a fallback in confirmations (anvil: Base Sepolia refuses a fallback)", async () => {
    const withFallback = config({ pin: { ...ANVIL_LOCAL_PIN, finality: { mode: "tag", tag: "finalized", fallbackConfirmations: 200 } }, contractCodeHash: undefined });
    const run = await preflight({ noFinalizedTag: true, chainId: 31337 }, withFallback);
    expect(status(run, "finalized")).toBe("warn");
    expect(row(run, "finalized").detail).toContain("falls back to 200 confirmations");
    expect(run.report.ok).toBe(true);
  });

  it("reads a confirmations pin by block number (anvil: Base Sepolia refuses confirmations mode)", async () => {
    const confirmations = config({ pin: { ...ANVIL_LOCAL_PIN, finality: { mode: "confirmations", confirmations: 12 } }, contractCodeHash: undefined });
    const run = await preflight({ chainId: 31337 }, confirmations);
    expect(status(run, "finalized")).toBe("ok");
    expect(row(run, "finalized").detail).toContain("12 confirmations");
    expect(run.report.ok).toBe(true);
  });

  // On anvil (claim-by +60 min, a 20-minute finality budget): the measured lag is the larger of the two here, so these numbers are the lag's own. The Base Sepolia pair
  // (an 80-minute budget, claim-by +115) is the subject of the "finality budget row" tests below (P9-4 decision 12).
  it("sets the measured lag against leg A's claim-by (anvil, claim-by +60): 39 minutes fits, 55 minutes does not", async () => {
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const fits = await preflight({ chainId: 31337, finalizedLagSec: 39 * 60 }, anvil);
    expect(status(fits, "finality budget")).toBe("ok");
    expect(row(fits, "finality budget").detail).toContain("to spare");
    const tooSlow = await preflight({ chainId: 31337, finalizedLagSec: 55 * 60 }, anvil);
    expect(status(tooSlow, "finality budget")).toBe("fail");
    expect(row(tooSlow, "finality budget").detail).toContain("the Seller could not claim in time");
    expect(tooSlow.report.ok).toBe(false);
    // The allowance for landing the lock is part of the sum: a lag of exactly (claim-by - allowance) still fits.
    const edge = await preflight({ chainId: 31337, finalizedLagSec: (60 * 60_000 - LOCK_SETTLE_ALLOWANCE_MS) / 1000 }, anvil);
    expect(status(edge, "finality budget")).toBe("ok");
    const over = await preflight({ chainId: 31337, finalizedLagSec: (60 * 60_000 - LOCK_SETTLE_ALLOWANCE_MS) / 1000 + 1 }, anvil);
    expect(status(over, "finality budget")).toBe("fail");
  });

  // P9-4 decision 12 (F4): the lag measured at dry-run time is one reading of a number that stands still for 35 to 45 minutes at times. The row uses the LARGER of that lag and
  // the policy's finality budget (20 minutes on anvil, 80 on Base Sepolia), plus the 10 minutes a lock needs to land, against leg A's claim-by, and prints both numbers.
  it("P9-4 d12: a quiet moment (15-minute lag) does not pass what the 80-minute budget would not: the budget is used, both numbers are printed; the anvil set fails on 84532, the Base Sepolia set passes", async () => {
    const quiet = 15 * 60;
    const base = await preflight({ finalizedLagSec: quiet }, config(), {}, BASE_SET);
    expect(status(base, "finality budget")).toBe("ok");
    const detail = row(base, "finality budget").detail;
    expect(detail).toContain("the larger of the finalized lag measured now (15.0 min) and the policy's finality budget (80.0 min), 80.0 min, plus 10.0 min to land it");
    expect(detail).toContain("a lock reads final about 90.0 min after the run starts");
    expect(detail).toContain("leg A's claim-by is in 115.0 min, 25.0 min to spare");

    const anvilSet = await preflight({ finalizedLagSec: quiet }, config(), {}, ANVIL_SET);
    expect(status(anvilSet, "finality budget")).toBe("fail"); // before this decision: 15 + 10 = 25 min, which fits +60 and passed
    const failed = row(anvilSet, "finality budget").detail;
    expect(failed).toContain("a lock would read final about 90.0 min after the run starts");
    expect(failed).toContain("(15.0 min) and the policy's finality budget (80.0 min)");
    expect(failed).toContain("leg A's claim-by is in 60.0 min");
    expect(failed).toContain("the Seller could not claim in time");
    expect(anvilSet.report.ok).toBe(false);
  });

  it("P9-4 d12: a lag above the budget is used as it is (105 minutes + 10 fits claim-by +115 exactly, one second more does not); the row says it used the lag", async () => {
    const exact = await preflight({ finalizedLagSec: 105 * 60 }, config(), {}, BASE_SET);
    expect(status(exact, "finality budget")).toBe("ok");
    expect(row(exact, "finality budget").detail).toContain("(105.0 min) and the policy's finality budget (80.0 min), 105.0 min, plus 10.0 min");
    expect(row(exact, "finality budget").detail).toContain("0.0 min to spare");
    expect(status(await preflight({ finalizedLagSec: 105 * 60 + 1 }, config(), {}, BASE_SET), "finality budget")).toBe("fail");
  });

  it("P9-4 d12: the budget applies on anvil too (20 minutes + 10 needs a claim-by of +30 even when the lag measured is 5 minutes)", async () => {
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const claimBy = (min: number): DeadlineMinutes => ({ legA: { ...ANVIL_SET.legA, claimByMin: min }, legB: ANVIL_SET.legB });
    const short = await preflight({ chainId: 31337, finalizedLagSec: 5 * 60 }, anvil, {}, claimBy(29));
    expect(status(short, "finality budget")).toBe("fail");
    expect(row(short, "finality budget").detail).toContain("(5.0 min) and the policy's finality budget (20.0 min)");
    const exact = await preflight({ chainId: 31337, finalizedLagSec: 5 * 60 }, anvil, {}, claimBy(30));
    expect(status(exact, "finality budget")).toBe("ok");
    expect(row(exact, "finality budget").detail).toContain("0.0 min to spare");
  });

  it("an unknown lag still fails the row (the budget alone is not read as a measurement)", async () => {
    const run = await preflight({ noFinalizedTag: true }, config(), {}, BASE_SET);
    expect(row(run, "finality budget").detail).toContain("the finalized lag is unknown");
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
    const run = await preflight({ logCap: 300 }, config({ maxLogRange: 300 }));
    expect(status(run, "log range")).toBe("ok");
    expect(row(run, "log range").detail).toContain("accepted 300 blocks and refused 301");
    const head = 40_000_000n;
    expect(run.logRanges).toEqual([[head - 299n, head], [head - 300n, head]]);
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
      deadlines: { absolute: absoluteDeadlines(BASE_SET, NOW_MS), lockTimeMs: NOW_MS + LOCK_ESTIMATE_MS },
      policy: BASE_SEPOLIA_POLICY,
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

  it("fails when both parties are the same account, and when a key file did not load (the field and the problem, no path, no key)", async () => {
    const same = await preflight({}, config(), { seller: { address: buyerAddress } });
    expect(status(same, "accounts")).toBe("fail");
    expect(row(same, "accounts").detail).toContain("the same account");
    const problem = "buyerKeyFile: no such file";
    const run = await preflight({}, config(), { buyer: { problem } });
    expect(status(run, "buyer account")).toBe("fail");
    expect(row(run, "buyer account").detail).toBe(problem);
    expect(run.report.rows.some((r) => r.check === "buyer ETH")).toBe(false);
    expect(run.report.ok).toBe(false);
  });
});

// P9-4 decision 6: nothing re-prices a transaction that is already out, and the nonce of every write is the endpoint's `pending` count at that moment, so a transaction an
// account has queued sits ahead of the run's writes (a claim stuck behind it can miss leg A's refund time). A fresh run FAILS when either account's pending nonce differs
// from its latest nonce, printing both and the account; --resume and --refund only WARN.
describe("the nonce rows (P9-4 decision 6)", () => {
  const queued = (account: string, latest: bigint, pending: bigint): FakeChainOptions => ({ nonces: { [account.toLowerCase()]: { latest, pending } } });

  it("a clean account (pending = latest) is OK for both parties, printing the address and both counts; two reads each, latest and pending, and nothing is sent", async () => {
    const run = await preflight({ nonces: { [buyerAddress.toLowerCase()]: { latest: 4n }, [sellerAddress.toLowerCase()]: { latest: 0n } } });
    expect(status(run, "buyer nonce")).toBe("ok");
    expect(row(run, "buyer nonce").detail).toBe(`${buyerAddress}: latest nonce 4, pending nonce 4: nothing is queued`);
    expect(status(run, "seller nonce")).toBe("ok");
    expect(row(run, "seller nonce").detail).toContain(sellerAddress);
    expect(run.nonceReads.filter(([who]) => who === buyerAddress.toLowerCase())).toEqual([[buyerAddress.toLowerCase(), "latest"], [buyerAddress.toLowerCase(), "pending"]]);
    expect(run.nonceReads.filter(([who]) => who === sellerAddress.toLowerCase())).toEqual([[sellerAddress.toLowerCase(), "latest"], [sellerAddress.toLowerCase(), "pending"]]);
    expect(run.methods.filter((m) => m === "eth_sendRawTransaction" || m === "eth_sendTransaction")).toEqual([]);
    expect(run.report.ok).toBe(true);
  });

  it("a fresh run FAILS when the Buyer's pending nonce is above its latest nonce, naming the account and both numbers; the Seller's row stays OK", async () => {
    const run = await preflight(queued(buyerAddress, 2n, 3n));
    expect(status(run, "buyer nonce")).toBe("fail");
    const detail = row(run, "buyer nonce").detail;
    expect(detail).toContain(buyerAddress);
    expect(detail).toContain("the pending nonce 3 is not the latest nonce 2 (1 transaction(s) queued or not yet mined)");
    expect(detail).toContain("a write of this run would queue behind it");
    expect(detail).toContain("nothing here re-prices a stuck transaction");
    expect(detail).not.toContain("this mode goes ahead");
    expect(status(run, "seller nonce")).toBe("ok");
    expect(run.report.ok).toBe(false);
  });

  it("the same for the Seller, whose claim is the write that must not wait behind a queued transaction", async () => {
    const run = await preflight(queued(sellerAddress, 7n, 9n));
    expect(status(run, "seller nonce")).toBe("fail");
    expect(row(run, "seller nonce").detail).toContain(sellerAddress);
    expect(row(run, "seller nonce").detail).toContain("the pending nonce 9 is not the latest nonce 7 (2 transaction(s) queued or not yet mined)");
    expect(status(run, "buyer nonce")).toBe("ok");
    expect(run.report.ok).toBe(false);
  });

  it("a pending count BELOW the latest count (the endpoint's two answers disagree) is a difference too", async () => {
    const run = await preflight(queued(buyerAddress, 5n, 4n));
    expect(status(run, "buyer nonce")).toBe("fail");
    expect(row(run, "buyer nonce").detail).toContain("the pending nonce 4 is not the latest nonce 5 (the endpoint's two counts disagree)");
  });

  it("--resume and --refund (fresh = false) show the difference as a WARN with the same numbers, and go ahead", async () => {
    for (const buyerSends of ["approve-lock-refund", "refund"] as const) {
      const both: FakeChainOptions = { nonces: { [buyerAddress.toLowerCase()]: { latest: 2n, pending: 3n }, [sellerAddress.toLowerCase()]: { latest: 1n, pending: 2n } } };
      const run = await preflight(both, config(), { fresh: false, buyerSends });
      for (const check of ["buyer nonce", "seller nonce"]) {
        expect(status(run, check), `${buyerSends} ${check}`).toBe("warn");
        expect(row(run, check).detail, `${buyerSends} ${check}`).toContain("the pending nonce");
        expect(row(run, check).detail, `${buyerSends} ${check}`).toContain("this mode goes ahead: its writes queue behind it");
      }
      expect(run.report.ok, buyerSends).toBe(true);
    }
  });

  it("a node that cannot count (or answers no number) fails a fresh run's rows and warns the other modes: a queued transaction cannot be ruled out", async () => {
    const fresh = await preflight({ noNonces: true });
    for (const check of ["buyer nonce", "seller nonce"]) {
      expect(status(fresh, check)).toBe("fail");
      expect(row(fresh, check).detail).toContain("could not both be read");
      expect(row(fresh, check).detail).toContain("a queued transaction cannot be ruled out");
    }
    expect(fresh.report.ok).toBe(false);
    const resume = await preflight({ noNonces: true }, config(), { fresh: false });
    expect(status(resume, "buyer nonce")).toBe("warn");
    expect(resume.report.ok).toBe(true);
  });

  it("an account that did not load has no row (its own account row already fails)", async () => {
    const run = await preflight({}, config(), { seller: { problem: "sellerKeyFile: no such file" } });
    expect(run.report.rows.map((r) => r.check)).not.toContain("seller nonce");
    expect(status(run, "buyer nonce")).toBe("ok");
    expect(run.nonceReads.every(([who]) => who === buyerAddress.toLowerCase())).toBe(true);
  });
});

// P9-4 decision 5: a LOCAL account signs only under rails.evm.maxFeePerGasWei (50 gwei by default on Base Sepolia, 1,000 gwei on anvil), so a ceiling under the fee viem would
// compute is found at the dry run: the row reads the latest block's base fee and the priority fee the endpoint answers, forms viem's own fee (base fee x 1.2 + priority fee),
// puts a 2x cushion on it and sets it against the effective ceiling. A fresh run FAILS when the ceiling is below it; --resume and --refund only WARN.
describe("the fee ceiling row (P9-4 decision 5)", () => {
  const GWEI = 1_000_000_000n;
  const high = (baseGwei: bigint, tipGwei: bigint): FakeChainOptions => ({ baseFeePerGasWei: baseGwei * GWEI, priorityFeeWei: tipGwei * GWEI });

  it("the default ceiling passes on Base Sepolia's own fees (a sub-gwei base fee), printing the fee viem would sign, the cushioned fee and the ceiling", async () => {
    const run = await preflight();
    expect(status(run, "fee ceiling")).toBe("ok");
    const detail = row(run, "fee ceiling").detail;
    expect(detail).toContain("the fee viem would sign for now is 0.0007 gwei (base fee 0.0005 gwei x 1.2 + priority fee 0.0001 gwei)");
    expect(detail).toContain("0.0014 gwei with the 2x cushion");
    expect(detail).toContain("the effective ceiling is 50 gwei (the default of this chain)");
    expect(run.report.ok).toBe(true);
  });

  it("a base fee above the ceiling fails the row on a fresh run, printing both numbers and the field to raise", async () => {
    // base fee 100 gwei x 1.2 + 1 gwei = 121 gwei, 242 gwei with the cushion: over the 50-gwei default.
    const run = await preflight(high(100n, 1n));
    expect(status(run, "fee ceiling")).toBe("fail");
    const detail = row(run, "fee ceiling").detail;
    expect(detail).toContain("the fee viem would sign for now is 121 gwei (base fee 100 gwei x 1.2 + priority fee 1 gwei), 242 gwei with the 2x cushion");
    expect(detail).toContain("the effective ceiling is 50 gwei (the default of this chain)");
    expect(detail).toContain("the ceiling is below it, so the signer would refuse to sign a write at this fee (nothing would be sent)");
    expect(detail).toContain("raise rails.evm.maxFeePerGasWei to at least 242000000000 (242 gwei)");
    expect(run.report.ok).toBe(false);
  });

  it("a configured ceiling is used and named; it passes at exactly the cushioned fee and fails one wei under it", async () => {
    // base fee 0.5 gwei x 1.2 + 0.5 gwei = 1.1 gwei; with the cushion 2.2 gwei.
    const fees: FakeChainOptions = { baseFeePerGasWei: 500_000_000n, priorityFeeWei: 500_000_000n };
    const exact = await preflight(fees, config({ maxFeePerGasWei: "2200000000" }));
    expect(status(exact, "fee ceiling")).toBe("ok");
    expect(row(exact, "fee ceiling").detail).toContain("the effective ceiling is 2.2 gwei (rails.evm.maxFeePerGasWei)");
    const under = await preflight(fees, config({ maxFeePerGasWei: "2199999999" }));
    expect(status(under, "fee ceiling")).toBe("fail");
    expect(row(under, "fee ceiling").detail).toContain("2.2 gwei with the 2x cushion");
    expect(row(under, "fee ceiling").detail).toContain("the effective ceiling is 2.199999999 gwei (rails.evm.maxFeePerGasWei)");
    // A number works as well as a string.
    expect(status(await preflight(fees, config({ maxFeePerGasWei: 3_000_000_000 })), "fee ceiling")).toBe("ok");
  });

  it("with no priority fee from the endpoint the row does what viem does: gas price minus base fee, never below zero", async () => {
    const stand = await preflight({ priorityFeeWei: null, baseFeePerGasWei: 500_000n, gasPriceWei: 1_000_000n });
    expect(status(stand, "fee ceiling")).toBe("ok");
    expect(row(stand, "fee ceiling").detail).toContain("priority fee 0.0005 gwei, gas price minus base fee: the endpoint answers no priority fee");
    const floor = await preflight({ priorityFeeWei: null, baseFeePerGasWei: 2_000_000n, gasPriceWei: 1_000_000n });
    expect(row(floor, "fee ceiling").detail).toContain("priority fee 0 gwei");
  });

  it("a chain whose blocks carry no base fee, or a head that cannot be read, fails a fresh run's row and says why", async () => {
    const noBase = await preflight({ baseFeePerGasWei: null });
    expect(status(noBase, "fee ceiling")).toBe("fail");
    expect(row(noBase, "fee ceiling").detail).toContain("the head block carries no baseFeePerGas");
    const chain = fakeChain({ headTimestampSec: HEAD_SEC, tokenBalances: { [buyerAddress.toLowerCase()]: 100_000_000n } });
    const { rpc } = scriptedRpc({ ...chain.handlers, eth_getBlockByNumber: () => ({ error: { code: -32000, message: "no head" } }) });
    const report = await runPreflight({
      config: config(),
      rpc,
      buyer: { address: buyerAddress },
      seller: { address: sellerAddress },
      nowMs: NOW_MS,
      fresh: true,
      deadlines: { absolute: absoluteDeadlines(BASE_SET, NOW_MS), lockTimeMs: NOW_MS + LOCK_ESTIMATE_MS },
      policy: BASE_SEPOLIA_POLICY,
      redact: (t) => t,
    });
    const found = report.rows.find((r) => r.check === "fee ceiling");
    expect(found?.status).toBe("fail");
    expect(found?.detail).toContain("the head is unknown");
  });

  it("anvil's default ceiling is 1,000 gwei: the same 100-gwei base fee passes there", async () => {
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const run = await preflight({ chainId: 31337, ...high(100n, 1n) }, anvil);
    expect(status(run, "fee ceiling")).toBe("ok");
    expect(row(run, "fee ceiling").detail).toContain("the effective ceiling is 1000 gwei (the default of this chain)");
  });

  it("--resume and --refund (fresh = false) only WARN, with the same numbers: a prediction never stands between an honest party and a deadline-bound step", async () => {
    for (const buyerSends of ["approve-lock-refund", "refund"] as const) {
      const run = await preflight(high(100n, 1n), config(), { fresh: false, buyerSends });
      expect(status(run, "fee ceiling"), buyerSends).toBe("warn");
      expect(row(run, "fee ceiling").detail, buyerSends).toContain("242 gwei with the 2x cushion");
      expect(row(run, "fee ceiling").detail, buyerSends).toContain("the effective ceiling is 50 gwei");
      expect(run.report.ok, buyerSends).toBe(true);
    }
    const noBase = await preflight({ baseFeePerGasWei: null }, config(), { fresh: false });
    expect(status(noBase, "fee ceiling")).toBe("warn");
  });

  it("the row reads (eth_maxPriorityFeePerGas, the latest block) and sends nothing", async () => {
    const run = await preflight();
    expect(run.methods).toContain("eth_maxPriorityFeePerGas");
    expect(run.methods.filter((m) => m === "eth_sendRawTransaction" || m === "eth_sendTransaction")).toEqual([]);
  });
});

// R1-FUND-01 with F2 (P9 review round 1): the Buyer's ETH row always asked for approve + lock + refund, so after the approve and the lock were
// spent (about 258,000 gas) a Buyer who could pay the refund 2.9 times over was told "fund it first": --refund exited 3 (the refund was not sent)
// and --resume exited 3 (the delay could cost a settle). The row is now sized by what is left to send.
describe("the Buyer's ETH row is sized by what is left to send (R1-FUND-01)", () => {
  const price = 1_000_000n;
  const freshNeed = (GAS_CEILING.approve + GAS_CEILING.lock + GAS_CEILING.refund) * price * GAS_PRICE_CUSHION; // 1.44e12 at this price
  const refundNeed = GAS_CEILING.refund * price * GAS_PRICE_CUSHION; // 4e11
  const spent = (44_000n + 214_000n) * price; // what the approve and the lock really cost (258,000 gas)
  const left = freshNeed - spent; // 1.182e12: the dry run's need minus what the approve and the lock spent
  const funded = (wei: bigint): FakeChainOptions => ({ gasPriceWei: price, ethBalances: { [buyerAddress.toLowerCase()]: wei, [sellerAddress.toLowerCase()]: 10n ** 18n } });

  it("a Buyer left with the dry run's need minus the approve and the lock passes a refund or a resume with a lock (it failed 'fund it first' before)", async () => {
    expect(left).toBe(1_182_000_000_000n);
    expect(left * 10n).toBeGreaterThan(29n * refundNeed); // 2.9 times what the refund can cost
    // The old sizing, which a fresh run still has: the same Buyer is short.
    const asFresh = await preflight(funded(left), config(), { fresh: false });
    expect(status(asFresh, "buyer ETH")).toBe("fail");
    expect(row(asFresh, "buyer ETH").detail).toContain("approve, lock and a refund");
    expect(asFresh.report.ok).toBe(false);
    // Refund and resume with a lock on record: only the refund is reserved.
    const refund = await preflight(funded(left), config(), { fresh: false, buyerSends: "refund", notNeeded: new Set(["pending", "log range", "seller ETH", "seller account"]) });
    expect(status(refund, "buyer ETH")).toBe("ok");
    expect(row(refund, "buyer ETH").detail).toContain("for the refund (the approve and the lock are already sent)");
    expect(row(refund, "buyer ETH").detail).toContain(`${GAS_CEILING.refund} gas ceiling`);
    expect(refund.report.ok).toBe(true);
    const resume = await preflight(funded(left), config(), { fresh: false, buyerSends: "refund" });
    expect(status(resume, "buyer ETH")).toBe("ok");
    expect(resume.report.ok).toBe(true);
  });

  it("the refund-only need is exact: one wei short fails, the need itself passes; and a rising gas price still trips it", async () => {
    const exact = await preflight(funded(refundNeed), config(), { fresh: false, buyerSends: "refund" });
    expect(status(exact, "buyer ETH")).toBe("ok");
    const short = await preflight(funded(refundNeed - 1n), config(), { fresh: false, buyerSends: "refund" });
    expect(status(short, "buyer ETH")).toBe("fail");
    expect(row(short, "buyer ETH").detail).toContain("fund it first");
    expect(row(short, "buyer ETH").detail).toContain(buyerAddress);
    const spike = await preflight({ ...funded(left), gasPriceWei: 10_000_000_000n }, config(), { fresh: false, buyerSends: "refund" }); // 10 gwei
    expect(status(spike, "buyer ETH")).toBe("fail");
  });

  it("a fresh run keeps the full need (approve, lock and refund) and says what it is for", async () => {
    const need = (GAS_CEILING.approve + GAS_CEILING.lock + GAS_CEILING.refund) * price * GAS_PRICE_CUSHION;
    const exact = await preflight(funded(need));
    expect(status(exact, "buyer ETH")).toBe("ok");
    expect(row(exact, "buyer ETH").detail).toContain("approve, lock and a refund");
    expect(status(await preflight(funded(need - 1n)), "buyer ETH")).toBe("fail");
  });

  it("every ETH row says Base's L1 data fee is not included (its allowance is P9-4's)", async () => {
    const ok = await preflight(funded(10n ** 18n));
    for (const check of ["buyer ETH", "seller ETH"]) expect(row(ok, check).detail, check).toContain("Base's L1 data fee is not included");
    const short = await preflight(funded(1n));
    expect(status(short, "buyer ETH")).toBe("fail");
    expect(row(short, "buyer ETH").detail).toContain("Base's L1 data fee is not included");
    expect(row(short, "seller ETH").detail).toContain("Base's L1 data fee is not included");
  });

  it("a Seller account that did not load does not stop a refund (it is shown as a warning), and still fails any mode that needs it", async () => {
    const problem = "sellerKeyFile: no such file";
    const refundNotNeeded = new Set(["pending", "log range", "seller ETH", "seller account"]);
    const refund = await preflight({}, config(), { fresh: false, buyerSends: "refund", seller: { problem }, notNeeded: refundNotNeeded });
    expect(status(refund, "seller account")).toBe("warn");
    expect(row(refund, "seller account").detail).toBe(`(not needed for this mode) ${problem}`);
    expect(refund.report.ok).toBe(true);
    const resume = await preflight({}, config(), { fresh: false, buyerSends: "refund", seller: { problem } });
    expect(status(resume, "seller account")).toBe("fail");
    expect(resume.report.ok).toBe(false);
  });
});

// R2-FUND-04 (P9 review round 2): two ETH rows still reserved gas that is spent or no longer needed. (i) The Seller's row asked for a 200,000-gas claim at twice the
// price in --resume even after its claim landed (about 65,000 gas spent), so a Seller funded to the dry run's need failed it, and --resume exited 3 although only the
// Buyer's paper claim was left: one runner drives both roles, so the Seller's balance blocked the Buyer's deadline-bound step. (ii) The refund-only Buyer row (200,000 gas
// at twice the price) failed a Buyer who could pay the refund 2.7 times over once the price rose about 3x, and a refund has no deadline after leg A's refund time.
describe("the Seller's row is sized by what is left to send, and a refund's short Buyer row is a warning (R2-FUND-04)", () => {
  const price = 1_000_000n;
  const claimNeed = GAS_CEILING.claim * price * GAS_PRICE_CUSHION; // 4e11
  const sellerLeft = claimNeed - 65_000n * price; // funded to the dry run's need, minus the ~65k gas its claim spent: 3.35e11

  it("(i) a Seller whose claim landed (balance 3.35e11 wei) does not fail a resume: the row is an info row that reserves nothing; without the knowledge it still fails (the old sizing)", async () => {
    expect(sellerLeft).toBe(335_000_000_000n);
    const funded: FakeChainOptions = { gasPriceWei: price, ethBalances: { [buyerAddress.toLowerCase()]: 10n ** 18n, [sellerAddress.toLowerCase()]: sellerLeft } };
    // What --resume passed before this item (and passes whenever the Seller's claim is not proven): the claim is reserved in full.
    const before = await preflight(funded, config(), { fresh: false, buyerSends: "refund" });
    expect(status(before, "seller ETH")).toBe("fail");
    expect(row(before, "seller ETH").detail).toContain("needs 0.0000004 ETH for the claim");
    expect(before.report.ok).toBe(false);
    const claimed = await preflight(funded, config(), { fresh: false, buyerSends: "refund", sellerSends: "nothing" });
    expect(status(claimed, "seller ETH")).toBe("info");
    expect(row(claimed, "seller ETH").detail).toContain(sellerAddress);
    expect(row(claimed, "seller ETH").detail).toContain("nothing is left for the Seller to send (its claim already landed)");
    expect(claimed.report.ok).toBe(true);
    // A Seller with no ETH at all is no problem either once it has nothing to send; the explicit "claim" is the default.
    const empty = await preflight({ ...funded, ethBalances: { [buyerAddress.toLowerCase()]: 10n ** 18n, [sellerAddress.toLowerCase()]: 0n } }, config(), { fresh: false, buyerSends: "refund", sellerSends: "nothing" });
    expect(empty.report.ok).toBe(true);
    const explicit = await preflight(funded, config(), { fresh: false, buyerSends: "refund", sellerSends: "claim" });
    expect(status(explicit, "seller ETH")).toBe("fail");
  });

  it("(ii) a --refund Buyer holding the dry run's need minus the approve and the lock, at a price three times higher (balance 1.182e12, need 1.2e12), gets a WARN that still prints the need, and the refund goes ahead", async () => {
    const p1 = 3_000_000n; // 0.003 gwei
    const left = 1_182_000_000_000n;
    expect(GAS_CEILING.refund * p1 * GAS_PRICE_CUSHION).toBe(1_200_000_000_000n);
    const funded: FakeChainOptions = { gasPriceWei: p1, ethBalances: { [buyerAddress.toLowerCase()]: left, [sellerAddress.toLowerCase()]: 0n } };
    const notNeeded = new Set(["pending", "log range", "seller ETH", "seller account"]);
    const old = await preflight(funded, config(), { fresh: false, buyerSends: "refund", notNeeded });
    expect(status(old, "buyer ETH")).toBe("fail"); // the old behaviour: "fund it first", exit 3
    expect(old.report.ok).toBe(false);
    const refund = await preflight(funded, config(), { fresh: false, buyerSends: "refund", buyerEthShort: "warn", notNeeded });
    expect(status(refund, "buyer ETH")).toBe("warn");
    expect(row(refund, "buyer ETH").detail).toContain("needs 0.0000012 ETH for the refund (the approve and the lock are already sent)");
    expect(row(refund, "buyer ETH").detail).toContain(buyerAddress);
    expect(row(refund, "buyer ETH").detail).toContain("fund it first");
    expect(row(refund, "buyer ETH").detail).toContain("a refund does not need: it has no deadline after leg A's refund time");
    expect(refund.report.ok).toBe(true);
    // A Buyer that covers the need is still OK (not a warning), and the default for every other caller is still a failure.
    const covered = await preflight({ ...funded, ethBalances: { [buyerAddress.toLowerCase()]: 1_200_000_000_000n } }, config(), { fresh: false, buyerSends: "refund", buyerEthShort: "warn", notNeeded });
    expect(status(covered, "buyer ETH")).toBe("ok");
    const resume = await preflight(funded, config(), { fresh: false, buyerSends: "refund" });
    expect(status(resume, "buyer ETH")).toBe("fail");
  });

  it("the Seller's row of a fresh run keeps its claim reservation whatever sellerSends says elsewhere (the dry run and --yes never pass it), and the warning applies to the Buyer row only", async () => {
    const funded: FakeChainOptions = { gasPriceWei: price, ethBalances: { [buyerAddress.toLowerCase()]: 1n, [sellerAddress.toLowerCase()]: 1n } };
    const fresh = await preflight(funded);
    expect(status(fresh, "buyer ETH")).toBe("fail");
    expect(status(fresh, "seller ETH")).toBe("fail");
    const warned = await preflight(funded, config(), { buyerEthShort: "warn" });
    expect(status(warned, "buyer ETH")).toBe("warn");
    expect(status(warned, "seller ETH")).toBe("fail"); // the warning is the Buyer's, for a refund; the Seller's row is never softened
  });
});

// P9-4 decision 1 (runner part): the interim guard of review round 1 (F3 with R1-FUND-06), which refused every NEW swap on Base Sepolia while the rail still ran
// under the anvil policy, is gone. The rail selects its policy by the pin's chain id (BASE_SEPOLIA_POLICY on 84532: a finality budget of 80 minutes, a claim margin of
// 10 minutes), so the deadlines row checks the real numbers, and the known-good set of each chain (decision 2) passes under that chain's own policy.
describe("the deadlines row under each chain's own policy (P9-4 decisions 1 and 2)", () => {
  it("a fresh Base Sepolia run under BASE_SEPOLIA_POLICY with the Base Sepolia known-good set passes the row, and says the rules hold", async () => {
    const run = await preflight({}, config(), { policy: BASE_SEPOLIA_POLICY }, BASE_SET);
    expect(status(run, "deadlines")).toBe("ok");
    expect(row(run, "deadlines").detail).toContain("SPEC 3.5 rules 1 to 3 and the claim margin hold");
    expect(run.report.ok).toBe(true);
  });

  it("the anvil set on Base Sepolia fails the row with the rule named: leg B's claim-by is not leg A's refund time plus the 80-minute finality budget (rule 2)", async () => {
    const run = await preflight({}, config(), { policy: BASE_SEPOLIA_POLICY }, ANVIL_SET);
    expect(status(run, "deadlines")).toBe("fail");
    const detail = row(run, "deadlines").detail;
    expect(detail).toMatch(/rule 2: legB\.claimByMs \d+ < required \d+ ms \(legA\.refundAfterMs \d+ \+ finalityAMs 4800000\)/);
    expect(detail).not.toContain("rule 1");
    expect(detail).not.toContain("rule 3");
    expect(run.report.ok).toBe(false);
  });

  it("anvil keeps its own pair: the anvil set passes under EVM_LOCAL_POLICY (20-minute budget), and the Base Sepolia set passes there too", async () => {
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    expect(status(await preflight({ chainId: 31337 }, anvil, { policy: EVM_LOCAL_POLICY }, ANVIL_SET), "deadlines")).toBe("ok");
    expect(status(await preflight({ chainId: 31337 }, anvil, { policy: EVM_LOCAL_POLICY }, BASE_SET), "deadlines")).toBe("ok");
    expect(status(await preflight({ chainId: 31337 }, anvil), "deadlines")).toBe("ok"); // the helper's own default is the anvil pair
  });

  it("the row judges the numbers and nothing else: no policy object, not even the anvil one on chain 84532, gets a refusal from a guard (the old text is gone)", async () => {
    // The old guard fired on chain 84532 whenever the policy handed in was EVM_LOCAL_POLICY itself, whatever the deadlines said.
    const handedTheAnvilPolicy = await preflight({}, config(), { policy: EVM_LOCAL_POLICY }, ANVIL_SET);
    expect(status(handedTheAnvilPolicy, "deadlines")).toBe("ok"); // the anvil set passes the anvil policy's rules
    expect(row(handedTheAnvilPolicy, "deadlines").detail).not.toContain("no Base Sepolia policy yet");
    const tooShort: DeadlineMinutes = { legA: { claimByMin: 30, refundAfterMin: 40, expiresMin: 20 }, legB: { claimByMin: 120, refundAfterMin: 180, expiresMin: 40 } };
    const broken = await preflight({}, config(), { policy: EVM_LOCAL_POLICY }, tooShort);
    expect(row(broken, "deadlines").detail).toContain("rule 1");
    expect(row(broken, "deadlines").detail).not.toContain("no Base Sepolia policy yet");
  });

  it("the claim margin is the chain's own: on Base Sepolia a 9-minute gap between leg A's claim-by and refund time fails and 10 minutes passes (anvil: 4 fails, 5 passes)", async () => {
    const withGap = (gapMin: number, base: DeadlineMinutes): DeadlineMinutes => ({ ...base, legA: { ...base.legA, refundAfterMin: base.legA.claimByMin + gapMin } });
    const nine = await preflight({}, config(), { policy: BASE_SEPOLIA_POLICY }, withGap(9, BASE_SET));
    expect(status(nine, "deadlines")).toBe("fail");
    expect(row(nine, "deadlines").detail).toContain("claim-inclusion margin (10.0 min)");
    expect(status(await preflight({}, config(), { policy: BASE_SEPOLIA_POLICY }, withGap(10, BASE_SET)), "deadlines")).toBe("ok");
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const four = await preflight({ chainId: 31337 }, anvil, {}, withGap(4, ANVIL_SET));
    expect(row(four, "deadlines").detail).toContain("claim-inclusion margin (5.0 min)");
    expect(status(await preflight({ chainId: 31337 }, anvil, {}, withGap(5, ANVIL_SET)), "deadlines")).toBe("ok");
  });

  it("never blocks a refund or a resume: with fresh = false there is no deadlines row to fail, whatever the policy", async () => {
    for (const buyerSends of ["refund", "approve-lock-refund"] as const) {
      const run = await preflight({}, config(), { fresh: false, buyerSends, policy: EVM_LOCAL_POLICY });
      expect(run.report.rows.map((r) => r.check)).not.toContain("deadlines");
      expect(run.report.ok).toBe(true);
    }
  });
});

// F9 (P9 review round 1): a node answers 0x for an eth_call at a block where the contract does not exist yet, which is the likely case within the
// finalized lag of a deploy. The row used to say "not an ABI-encoded row" (and mutant M26, which relaxed the length check, survived the whole suite).
describe("the state read at the finalized block (F9)", () => {
  it("fails with 'not final yet' wording when the node answers 0x, which is what a deploy younger than the finalized lag reads as", async () => {
    const run = await preflight({ stateAtFinalizedAnswer: "0x" });
    expect(status(run, "state at finalized")).toBe("fail");
    const detail = row(run, "state at finalized").detail;
    expect(detail).toContain("answered 0x (no data)");
    expect(detail).toContain("the escrow's code or state is not final yet at that block");
    expect(detail).toContain("20.0 min"); // the finalized lag of the fake chain: how long to wait after the deploy
    expect(detail).not.toContain("not an ABI-encoded row");
    expect(run.report.ok).toBe(false);
  });

  it("fails an answer that is hex but no ABI row (shorter than one row), and a non-hex answer, as 'not an ABI-encoded row'; a full row is ok", async () => {
    for (const answer of ["0x00", `0x${"00".repeat(31)}`, "0xzz", "nonsense"]) {
      const run = await preflight({ stateAtFinalizedAnswer: answer });
      expect(status(run, "state at finalized"), answer).toBe("fail");
      expect(row(run, "state at finalized").detail, answer).toContain("not an ABI-encoded row");
    }
    expect(status(await preflight({ stateAtFinalizedAnswer: `0x${"00".repeat(32)}` }), "state at finalized")).toBe("ok"); // 66 characters is the shortest row accepted
    expect(status(await preflight(), "state at finalized")).toBe("ok");
  });
});

// F1 runner part (P9 review round 1): the claim-log scan reads OLDEST range first from its marker, at most MAX_LOG_SCAN_CHUNKS calls of maxLogRange blocks.
// A claim can land at any time between leg A's lock and its refund time, so those calls must reach as far as the window is long (at the block time
// measured from the last blocks, plus the 256-block marker margin), or the Buyer could not learn the secret from the chain.
describe("the log scans' reach covers leg A's window (F1)", () => {
  const lockTimeMs = NOW_MS + LOCK_ESTIMATE_MS;
  /** Leg A's window as `hours` hours (plus `extraMs`) from the run's start to the refund time (R2-FUND-05), the rest of the set as the known-good one. */
  const window = (hours: number, extraMs = 0): NonNullable<PreflightInput["deadlines"]> => {
    const absolute = absoluteDeadlines(BASE_SET, NOW_MS);
    const refundAfterMs = NOW_MS + hours * 3_600_000 + extraMs;
    return { absolute: { ...absolute, legA: { ...absolute.legA, refundAfterMs } }, lockTimeMs };
  };

  it("fails a cap of 300 against a 26-hour window at 2-second blocks, printing both numbers; the same window passes at the default 500", async () => {
    const low = await preflight({ logCap: 300 }, config({ maxLogRange: 300 }), { deadlines: window(26) });
    expect(status(low, "log scan reach")).toBe("fail");
    const detail = row(low, "log scan reach").detail;
    const need = 26 * 1800 + CLAIM_MARKER_REORG_MARGIN_EVM; // 46,800 blocks of 2 s, plus the margin
    expect(detail).toContain(`${MAX_LOG_SCAN_CHUNKS} calls of maxLogRange 300 read 30000 blocks`);
    expect(detail).toContain(`needs ${need} blocks`);
    expect(detail).toContain("1560.0 min from the run's start to leg A's refund time");
    expect(detail).toContain("2.0 s a block");
    expect(detail).toContain(`raise maxLogRange (to at least ${Math.ceil(need / MAX_LOG_SCAN_CHUNKS)})`);
    expect(low.report.ok).toBe(false);
    const wide = await preflight({}, config(), { deadlines: window(26) });
    expect(status(wide, "log scan reach")).toBe("ok");
    expect(row(wide, "log scan reach").detail).toContain(`needs ${need} blocks`);
    expect(row(wide, "log scan reach").detail).toContain("read 50000 blocks");
  });

  it("passes the known-good set at 500, and is exact at the boundary: a window of reach minus the margin passes, one block more fails", async () => {
    const known = await preflight();
    expect(status(known, "log scan reach")).toBe("ok");
    expect(row(known, "log scan reach").detail).toContain("it fits");
    // At 500 the reach is 50,000 blocks: 49,744 blocks of window and 256 of margin, 99,488 s at 2 s a block.
    const edge = await preflight({}, config(), { deadlines: window(0, 99_488_000) });
    expect(status(edge, "log scan reach")).toBe("ok");
    const over = await preflight({}, config(), { deadlines: window(0, 99_488_000 + 2_000) }); // one more block
    expect(status(over, "log scan reach")).toBe("fail");
    expect(row(over, "log scan reach").detail).toContain("needs 50001 blocks");
  });

  // R2-FUND-05 (P9 review round 2): the row measured the window from the lock ESTIMATE (the run's start plus 10 minutes), but the Buyer's marker is read seconds
  // after the run's start. At the boundary it passed a config whose real window exceeded the reach by 44 blocks.
  it("measures the window from the run's start: leg A 1,600/1,668 min on 84532 at a cap of 500 and 2-second blocks needs 50,296 blocks and FAILS (from the lock estimate it needed 49,996 and passed)", async () => {
    const minutes: DeadlineMinutes = { legA: { claimByMin: 1600, refundAfterMin: 1668, expiresMin: 30 }, legB: { claimByMin: 3400, refundAfterMin: 6000, expiresMin: 40 } };
    const run = await preflight({}, config(), {}, minutes);
    expect(status(run, "log scan reach")).toBe("fail");
    const detail = row(run, "log scan reach").detail;
    expect(detail).toContain(`needs ${1668 * 30 + CLAIM_MARKER_REORG_MARGIN_EVM} blocks`); // 50,040 blocks of 2 s from the start, plus the 256 margin
    expect(detail).toContain("needs 50296 blocks");
    expect(detail).not.toContain("49996");
    expect(detail).toContain("1668.0 min from the run's start to leg A's refund time");
    expect(detail).toContain("raise maxLogRange (to at least 503)"); // ceil(50,296 / 100)
    expect(run.report.ok).toBe(false);
    // One block less of window from the start fits exactly (49,744 blocks of window and 256 of margin make the 50,000 the scan reads).
    const edge = await preflight({}, config(), { deadlines: window(0, 99_488_000) });
    expect(status(edge, "log scan reach")).toBe("ok");
  });

  it("measures the block time from the chain (12-second blocks make the same window short), never below one second a block", async () => {
    const slow = await preflight({ logCap: 300, blockTimeSec: 12 }, config({ maxLogRange: 300 }), { deadlines: window(26) });
    expect(status(slow, "log scan reach")).toBe("ok");
    expect(row(slow, "log scan reach").detail).toContain("12.0 s a block");
    expect(row(slow, "log scan reach").detail).toContain(`needs ${26 * 300 + CLAIM_MARKER_REORG_MARGIN_EVM} blocks`);
    // A measured time under a second is a rounding artefact (timestamps are whole seconds): it is taken as one second a block, never less.
    const quick = await preflight({ blockTimeSec: 0 }, config(), { deadlines: window(1) });
    expect(row(quick, "log scan reach").detail).toContain("1.0 s a block");
  });

  it("fails closed when the block time cannot be measured, and is silent where one call reads any range (no maxLogRange: anvil)", async () => {
    const chain = fakeChain({ headTimestampSec: HEAD_SEC, tokenBalances: { [buyerAddress.toLowerCase()]: 100_000_000n } });
    const handlers = {
      ...chain.handlers,
      eth_getBlockByNumber: (params: readonly unknown[]) => (/^0x/.test(String(params[0])) ? { error: { code: -32000, message: "no history" } } : chain.handlers.eth_getBlockByNumber!(params)),
    };
    const { rpc } = scriptedRpc(handlers);
    const report = await runPreflight({
      config: config(),
      rpc,
      buyer: { address: buyerAddress },
      seller: { address: sellerAddress },
      nowMs: NOW_MS,
      fresh: true,
      deadlines: { absolute: absoluteDeadlines(BASE_SET, NOW_MS), lockTimeMs },
      policy: BASE_SEPOLIA_POLICY,
      redact: (t) => t,
    });
    const unmeasured = report.rows.find((r) => r.check === "log scan reach");
    expect(unmeasured?.status).toBe("fail");
    expect(unmeasured?.detail).toContain("the block time cannot be measured");
    expect(report.ok).toBe(false);
    const anvil = config({ contractCodeHash: undefined }, {}, ANVIL_LOCAL_PIN);
    const unlimited = await preflight({ chainId: 31337, logCap: null }, anvil);
    expect(unlimited.report.rows.map((r) => r.check)).not.toContain("log scan reach");
  });

  it("says in the log range row that maxLogRange cannot go below the 257-block floor when the endpoint refuses even the configured range", async () => {
    const run = await preflight({ logCap: 100 });
    expect(status(run, "log range")).toBe("fail");
    expect(row(run, "log range").detail).toContain("lower it, but not below 257");
    expect(row(run, "log range").detail).toContain(`${CLAIM_MARKER_REORG_MARGIN_EVM}-block marker margin`);
  });
});

describe("the deadlines", () => {
  it("fails a set that breaks SPEC 3.5 and names the rule", async () => {
    const tooShort: DeadlineMinutes = { legA: { claimByMin: 30, refundAfterMin: 40, expiresMin: 20 }, legB: { claimByMin: 120, refundAfterMin: 180, expiresMin: 40 } };
    const run = await preflight({}, config(), {}, tooShort);
    expect(status(run, "deadlines")).toBe("fail");
    expect(row(run, "deadlines").detail).toContain("rule 1");
    const legBTooEarly: DeadlineMinutes = { legA: BASE_SET.legA, legB: { claimByMin: 70, refundAfterMin: 100, expiresMin: 40 } };
    const rule2 = await preflight({}, config(), {}, legBTooEarly);
    expect(row(rule2, "deadlines").detail).toContain("rule 2");
  });

  it("fails a leg A whose claim-by is too close to its refund time for the Seller's claim margin", async () => {
    const tight: DeadlineMinutes = { legA: { claimByMin: 87, refundAfterMin: 90, expiresMin: 30 }, legB: BASE_SET.legB };
    const run = await preflight({}, config(), {}, tight);
    expect(status(run, "deadlines")).toBe("fail");
    expect(row(run, "deadlines").detail).toContain("claim-inclusion margin");
  });

  it("prints the absolute deadlines of the known-good set of the chain (Base Sepolia: leg A claim-by +115 min, leg B refundable from +285 min)", async () => {
    const run = await preflight();
    const detail = row(run, "deadlines").detail;
    expect(detail).toContain(new Date(NOW_MS + 115 * 60_000).toISOString());
    expect(detail).toContain(new Date(NOW_MS + 285 * 60_000).toISOString());
  });
});

describe("a resume or a refund (fresh = false)", () => {
  it("leaves out the rows that belong to a new swap (deadlines, token, finality budget) and keeps the chain rows", async () => {
    const run = await preflight({}, config(), { fresh: false });
    const checks = run.report.rows.map((r) => r.check);
    for (const gone of ["deadlines", "buyer token", "buyer allowance", "finality budget", "log scan reach"]) expect(checks).not.toContain(gone);
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

  // K3 (P9 review round 1): the first line was cut at 300 characters BEFORE the endpoint was redacted, so an endpoint URL straddling the cut was printed
  // in part ("https://.../v2/PATHKEY..."), and the whole-URL redaction no longer matched it. A path can carry an API key on a keyed provider.
  it("redact first and cut after: an endpoint that crosses character 300 is never printed in part (K3)", () => {
    const endpoint = "https://base-sepolia.g.alchemy.com/v2/PATHKEYPATHKEYPATHKEYPATHKEY01";
    const redact = (text: string): string => text.split(endpoint).join("<rpc endpoint>");
    for (const prefixLength of [200, 220, 230, 233, 240, 280, 295]) {
      const message = `${"x".repeat(prefixLength)} (endpoint ${endpoint}) and a tail that goes on and on and on and on and on and on and on and on and on and on`;
      const shown = describeFailure(new Error(message), redact);
      expect(shown, `prefix ${prefixLength}`).not.toContain("PATHKEY");
      expect(shown, `prefix ${prefixLength}`).not.toContain("alchemy");
      expect(shown, `prefix ${prefixLength}`).not.toContain("/v2/");
      expect(shown.length, `prefix ${prefixLength}`).toBeLessThanOrEqual(300);
    }
    // The review's case: a 220-character prefix and the URL crossing the cut.
    const crossing = describeFailure(new Error(`${"y".repeat(220)} (endpoint ${endpoint})`), redact);
    expect(crossing).toContain("<rpc endpoint>");
    expect(crossing).not.toMatch(/PATHKEY|alchemy|https:/);
    // The cut itself still happens (after the redaction) and the shown text ends in "...".
    const long = describeFailure(new Error(`${endpoint} ${"z".repeat(400)}`), redact);
    expect(long.length).toBe(300);
    expect(long.endsWith("...")).toBe(true);
    expect(long.startsWith("<rpc endpoint> ")).toBe(true);
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
