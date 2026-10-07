// SPDX-License-Identifier: MIT
//
// tests/refund-late-claim.test.ts - P9 review round 3, R3-FUND-01 (case F-C of the review): a claim of leg A that landed within one finality lag of leg A's refund
// time is not FINAL when the Buyer comes to refund. The refund then reverts (the row is Claimed at the latest block) and the flow's evidence reader, which reads the
// finalized block, still says Locked: `refundLegA` threw the raw revert, `next` flipped to `refundLegA`, and both `--refund` and `--resume` stalled for up to a whole
// finality lag while the secret was readable at the latest block all along.
//
// The fix (src/client/rehearsal-run.ts `refundLegAWaiting`): a refund that fails with anything but the known cases while `locks(hashLock)` reads Claimed at the LATEST
// block is waited for (bounded by `waitLimitMs`), then asked again, so that the FLOW routes on a FINAL claim; the run ends with the claimed-lock refusal that names
// `--resume`. Nothing is ever routed on a read that is not final.
//
// The real BuyerFlow over the stateful mock node (tests/helpers/evm-mock-node.ts) with the runner's own wait loop on top. The mock answers `locks()` at a block other than
// latest and pending from a "finalized view" that the test moves: it lags the live rows (shows the lock as Locked) until the test says it has caught up.

import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { parseRehearsalConfig } from "../src/client/rehearsal-config.js";
import { refundDoorwayText, refundLegAWaiting, type FinalityWorld } from "../src/client/rehearsal-run.js";
import { ANVIL_LOCAL_PIN } from "../src/rails/evm-htlc.js";
import { EVM_HASH_RAIL_ABI } from "../src/vendor/evm-hash-rail.js";
import { EvmMockNode } from "./helpers/evm-mock-node.js";
import { evmWorldWith } from "./helpers/matrix-worlds.js";
import { buyerRecordOf, resumedBuyer, started, type Started } from "./helpers/resume-world.js";

const POLL_MS = 5_000;

interface Script {
  /** The finalized view shows the lock as Locked while this is true (the claim, or the refund, is not final yet). */
  lag: boolean;
  /** `refundLegA` calls made so far through `ask`. */
  calls: number;
  /** The log lines the runner wrote. */
  logs: string[];
  /** The sleeps the runner made, in ms. */
  sleeps: number[];
}

interface Rig {
  s: Started;
  node: EvmMockNode;
  script: Script;
  world: FinalityWorld;
  hashLock: Hex;
  /** The flow, restarted from its store, wrapped so each call is counted and `onCall(n)` runs BEFORE call n (1-based). */
  buyer: (onCall?: (n: number) => void) => Promise<{ flow: Awaited<ReturnType<typeof resumedBuyer>>["flow"]; next: string }>;
}

/**
 * The review's state: the Buyer's lock of leg A recorded; the Seller's claim applied at leg A's refund time minus 60 s with no reveal frame and no Seller flow
 * involved (its outcome unsaved); the clock then at refund time + 1 s. The runner's finalized number always equals the head on the mock, so the wait for the finalized
 * block to pass the head returns at once; what the claim's finality gates is the flow's own read (the finalized view), which the test releases.
 */
async function lateClaim(options: { waitLimitMs?: number; claim?: boolean } = {}): Promise<Rig> {
  let node: EvmMockNode | undefined;
  const s = await started(evmWorldWith((n) => void (node = n)));
  const mock = node!;
  const key = s.w.hashLock.hash.toLowerCase();
  expect(mock.rows.get(key)?.status).toBe(1);

  if (options.claim !== false) {
    s.w.setTime(s.w.refundAt.legA - 60_000);
    const data = encodeFunctionData({ abi: EVM_HASH_RAIL_ABI, functionName: "claim", args: [s.w.hashLock.hash as Hex, s.w.hashLock.preimage as Hex] });
    await mock.rpc().request({ method: "eth_sendTransaction", params: [{ from: s.w.addresses.seller, to: mock.railContract, data }] });
    expect(mock.rows.get(key)?.status).toBe(2);
  }

  const script: Script = { lag: true, calls: 0, logs: [], sleeps: [] };
  const patched = mock as unknown as { handle: (method: string, params: readonly unknown[]) => unknown };
  const original = patched.handle.bind(mock);
  patched.handle = (method, params) => {
    if (script.lag && method === "eth_call" && params[1] !== "latest" && params[1] !== "pending" && params[1] !== undefined) {
      const call = params[0] as { to?: string; data?: string };
      if ((call.to ?? "").toLowerCase() === mock.railContract.toLowerCase()) {
        const decoded = decodeFunctionData({ abi: EVM_HASH_RAIL_ABI, data: call.data as Hex });
        if (decoded.functionName === "locks" && String(decoded.args[0]).toLowerCase() === key) {
          const r = mock.rows.get(key)!;
          return { result: encodeFunctionResult({ abi: EVM_HASH_RAIL_ABI, functionName: "locks", result: [r.payer, r.payee, r.token, r.amount, r.claimByMs, r.refundAfterMs, 1] }) };
        }
      }
    }
    return original(method, params);
  };

  s.w.setTime(s.w.refundAt.legA + 1);
  const config = parseRehearsalConfig(
    {
      rails: { evm: { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: mock.railContract, assets: { USDC: mock.token } } },
      buyerKeyFile: "b.key",
      sellerKeyFile: "s.key",
      amount: "1000000",
      out: "bundle",
      pollMs: POLL_MS,
      ...(options.waitLimitMs === undefined ? {} : { waitLimitMs: options.waitLimitMs }),
    },
    "/base",
  );
  const world: FinalityWorld = {
    config,
    env: {
      now: () => s.w.clockRef.ms,
      sleep: async (ms) => {
        script.sleeps.push(ms);
        s.w.clockRef.ms += ms;
      },
      out: () => undefined,
      err: () => undefined,
    },
    rpc: mock.rpc(),
    log: (line) => void script.logs.push(line),
    pollMs: POLL_MS,
  };
  const buyer: Rig["buyer"] = async (onCall) => {
    const resumed = await resumedBuyer(s);
    const ask = resumed.flow.refundLegA.bind(resumed.flow);
    resumed.flow.refundLegA = async () => {
      script.calls += 1;
      onCall?.(script.calls);
      return ask();
    };
    return resumed;
  };
  return { s, node: mock, script, world, hashLock: s.w.hashLock.hash as Hex, buyer };
}

const SENTENCE = "leg A's lock was claimed; waiting for the claim to be final, then --resume finishes the swap";

describe("R3-FUND-01: a late claim of leg A that is not final yet is waited for, then --resume finishes the swap", () => {
  it("--refund at refund time + 1 s logs the waiting sentence and sends nothing; once the claim reads final it ends with the claimed-lock refusal naming --resume (no raw revert), next = learnSecret; --resume then settles", async () => {
    const r = await lateClaim();
    expect((await r.buyer()).next, "before the refund, the doorway is learnSecret").toBe("learnSecret");

    const { flow } = await r.buyer((n) => {
      if (n === 4) r.script.lag = false; // the claim turns final just before the fourth ask
    });
    const error = await refundLegAWaiting(r.world, flow, r.hashLock).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error, "it ends in a refusal").toBeInstanceOf(Error);
    expect(error!.message).toMatch(/leg A's lock was claimed/);
    expect(error!.message).toMatch(/--resume/);
    expect(error!.message, "never the raw revert").not.toMatch(/reverted|refund refused/);
    expect(r.script.logs.filter((line) => line === SENTENCE), "the fixed sentence, once").toHaveLength(1);
    expect(r.script.calls, "it kept asking while the claim was not final").toBe(4);
    expect(r.script.sleeps.every((ms) => ms === POLL_MS)).toBe(true);
    expect(r.s.w.counts(), "nothing was sent: no refund (the lock and the claim are the setup's)").toMatchObject({ refunds: 0 });
    expect(r.node.count("refund")).toBe(0);

    // the flow itself routed, on the FINAL claim: its record says so and `next` follows
    const record = await buyerRecordOf(r.s.w);
    expect(record.refund.claimSeen).toBe(true);
    const after = await resumedBuyer(r.s);
    expect(after.next).toBe("learnSecret");

    // --resume's part: the secret is learned (the Seller posted no reveal frame, so from the chain) and leg B is claimed, which ends the Buyer's swap
    expect(await after.flow.learnSecret()).toBe(r.s.w.hashLock.preimage);
    await after.flow.claimLegB(r.s.w.hashLock.preimage);
    expect((await resumedBuyer(r.s)).next).toBe("done");
    expect(r.node.count("refund")).toBe(0);
  });

  it("a claim that is already final at the first ask is the same refusal at once, with no wait", async () => {
    const r = await lateClaim();
    r.script.lag = false;
    const { flow } = await r.buyer();
    await expect(refundLegAWaiting(r.world, flow, r.hashLock)).rejects.toThrow(/leg A's lock was claimed and the claim is final.*run --resume/);
    expect(r.script.sleeps).toEqual([]);
    expect(r.script.logs.filter((line) => line === SENTENCE)).toEqual([]);
    expect((await resumedBuyer(r.s)).next).toBe("learnSecret");
  });

  it("with waitLimitMs below the time the claim needs, the refusal says nothing was sent and names --refund (no raw revert); a later --refund, once the claim is final, ends with the --resume refusal", async () => {
    const r = await lateClaim({ waitLimitMs: 12_000 });
    const { flow } = await r.buyer();
    const error = await refundLegAWaiting(r.world, flow, r.hashLock).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error!.message).toMatch(/leg A's lock was claimed, but the claim was not final after \d+ s \(waitLimitMs\); nothing was sent; run --refund again to keep waiting/);
    expect(error!.message).not.toMatch(/reverted|refund refused/);
    expect(r.node.count("refund")).toBe(0);
    expect(r.script.calls).toBeGreaterThanOrEqual(2);
    expect(r.script.calls).toBeLessThan(8); // bounded: it did not keep asking far past the limit
    // the Buyer's refund attempt is on record and the claim is not routed on (it is not final): next still names the refund, and --resume says what that means
    expect((await resumedBuyer(r.s)).next).toBe("refundLegA");
    expect(await refundDoorwayText(r.world, r.hashLock)).toMatch(/was claimed and the claim may not be final yet: run --refund, which waits for the claim to be final, then --resume/);

    r.script.lag = false; // the claim is final now
    const again = await r.buyer();
    await expect(refundLegAWaiting(r.world, again.flow, r.hashLock)).rejects.toThrow(/leg A's lock was claimed and the claim is final.*run --resume/);
    expect((await resumedBuyer(r.s)).next).toBe("learnSecret");
  });

  it("a claim that a reorg removes is never routed on: the loop asks again and the refund goes ahead (nothing was routed away from the refund)", async () => {
    const r = await lateClaim();
    const key = r.hashLock.toLowerCase();
    const { flow } = await r.buyer((n) => {
      if (n === 2) r.node.rows.get(key)!.status = 1; // the unsafe block that carried the claim is gone; a claim cannot land again after the refund time
      if (n === 4) r.script.lag = false; // the refund, mined at call 2, now reads final
    });
    const evidence = await refundLegAWaiting(r.world, flow, r.hashLock);
    expect(evidence).toBeDefined();
    expect(r.node.count("refund")).toBe(1);
    expect(r.node.row(key)?.status).toBe(3);
    const record = await buyerRecordOf(r.s.w);
    expect(record.refund.claimSeen, "the Buyer was never routed away from its refund on a claim that was not final").toBeUndefined();
  });

  it("every other failure stays a real refusal, with no wait: a refund that fails while the row is Locked at the latest block, or while the row cannot be read", async () => {
    const locked = await lateClaim({ claim: false });
    const { flow } = await locked.buyer();
    // the Buyer's refund is refused by the contract (the refund time check) when the clock is moved back under the world's feet
    locked.s.w.setTime(locked.s.w.refundAt.legA - 1);
    await expect(refundLegAWaiting(locked.world, flow, locked.hashLock)).rejects.toThrow(/before its refundAfterMs/);
    expect(locked.script.sleeps).toEqual([]);
    expect(locked.script.logs).toEqual([]);

    const raw = await lateClaim({ claim: false });
    const refused = { refundLegA: async () => Promise.reject(new Error("tclk: The contract function \"refund\" reverted")) };
    await expect(refundLegAWaiting(raw.world, refused, raw.hashLock)).rejects.toThrow("reverted"); // the row reads Locked: nothing claimed, nothing to wait for
    expect(raw.script.sleeps).toEqual([]);

    const broken = await lateClaim();
    const unreadable = { ...broken.world, rpc: { request: async () => Promise.reject(new Error("node is down")) } as unknown as FinalityWorld["rpc"] };
    await expect(refundLegAWaiting(unreadable, refused, broken.hashLock)).rejects.toThrow("reverted"); // the claim read failed: the refund's own failure is thrown as it was
    expect(broken.script.sleeps).toEqual([]);
  });
});

describe("R3-FUND-01: what --resume says at the refund doorway", () => {
  it("the bare 'use --refund' unless the lock reads Claimed at the latest block; a failed read or an unknown hash lock keeps it", async () => {
    const claimed = await lateClaim();
    expect(await refundDoorwayText(claimed.world, claimed.hashLock)).toBe("leg A's lock was claimed and the claim may not be final yet: run --refund, which waits for the claim to be final, then --resume");

    const open = await lateClaim({ claim: false });
    expect(await refundDoorwayText(open.world, open.hashLock)).toBe("leg A's refund time has come; use --refund");
    expect(await refundDoorwayText(claimed.world, undefined)).toBe("leg A's refund time has come; use --refund");
    const unreadable = { ...claimed.world, rpc: { request: async () => Promise.reject(new Error("node is down")) } as unknown as FinalityWorld["rpc"] };
    expect(await refundDoorwayText(unreadable, claimed.hashLock)).toBe("leg A's refund time has come; use --refund");
  });
});
