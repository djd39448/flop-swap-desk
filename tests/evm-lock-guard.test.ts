// SPDX-License-Identifier: MIT
//
// tests/evm-lock-guard.test.ts - P9 fix pass, R1-FUND-08: the lock is not sent behind an unchecked clock.
//
// Review round 1: `checkLockGuards` runs before `commitLock`, but `commitLock` then waits for the ERC20 approve's receipt (up to
// `receiptTimeoutMs`, a day at most) before it sends the lock, and the vendored lock itself checks only `clock < refundAfterMs`. A slow
// approve could push the lock past the Seller's reveal window (SPEC 3.5 rule 1) without a guard noticing. Now `commitLock` takes the flow's own
// deadline guard (`options.beforeFinalSend`) and runs it after the approve's receipt and before the lock; the Buyer passes the same
// `checkSwapDeadlines` arithmetic at `clock()` that it ran before, so a window that closed during the approve refuses with the existing lock-guard
// error and no lock goes out (the approve stands: an allowance, never value). Pinned twice: at the rail seam, and through the real BuyerFlow.

import type { LockTerms, OfferFrame } from "@flop-labs/tclk";
import { generateHashLock } from "@flop-labs/tclk";
import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { createEvmCounterRail } from "../src/client/evm-rail.js";
import { EVM_LOCAL_POLICY } from "../src/client/policy.js";
import { checkSwapDeadlines } from "../src/deadlines.js";
import { PREFIX } from "./helpers/crash-matrix.js";
import { EvmMockNode, type SendKind } from "./helpers/evm-mock-node.js";
import { evmWorldWith } from "./helpers/matrix-worlds.js";
import { started } from "./helpers/resume-world.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const addr = (tag: string): Address => getAddress(`0x${Buffer.from(tag, "utf8").toString("hex").padEnd(40, "0").slice(0, 40)}`);
const RAIL = addr("lock-guard-rail");
const TOKEN = addr("lock-guard-usdc");
const BUYER = addr("lock-guard-buyer");
const SELLER = addr("lock-guard-seller");

// The matrix world's deadlines: leg A claim-by +60, refund +90 (minutes after T0); leg B claim-by +120, refund +180. The EVM policy asks for a
// 45-minute reveal window, so a lock at +50 or later is refused by rule 1 while the contract's own check (clock < refundAfterMs) still passes.
const LEG_A = { claimByMs: T0 + 60 * MIN, refundAfterMs: T0 + 90 * MIN, expiresMs: T0 + 30 * MIN };
const LEG_B = { claimByMs: T0 + 120 * MIN, refundAfterMs: T0 + 180 * MIN, expiresMs: T0 + 40 * MIN };
const asOffer = (leg: { claimByMs: number; refundAfterMs: number; expiresMs: number }): OfferFrame => leg as unknown as OfferFrame; // checkSwapDeadlines reads only the deadline fields

function termsFor(hash: string): LockTerms {
  return {
    contract: `0x${"11".repeat(32)}`,
    lock: "hash",
    statement: hash,
    amount: "1000000",
    asset: "USDC",
    payer: "did:key:zPayer",
    payee: "did:key:zPayee",
    claimByMs: LEG_A.claimByMs,
    refundAfterMs: LEG_A.refundAfterMs,
  };
}

describe("R1-FUND-08 at the rail seam: commitLock runs the caller's guard after the approve's receipt and before the lock", () => {
  /** A rail over the stateful node whose clock the test moves; `moveAfterApprove` is where the injected clock jumps once the approve was sent. */
  async function railWith(moveAfterApprove: number | undefined) {
    const clockRef = { ms: T0 };
    const clock = (): number => clockRef.ms;
    const node = new EvmMockNode(clock, RAIL, TOKEN, []);
    node.hook = {
      begin: (fn) => fn,
      end: (token) => {
        if (token === "approve" && moveAfterApprove !== undefined) clockRef.ms = moveAfterApprove;
      },
    };
    const rail = createEvmCounterRail({ config: node.config(), rpc: node.rpc(), account: BUYER, clock });
    const terms = termsFor(generateHashLock().hash);
    const connected = await rail.connect(terms, { payer: BUYER, payee: SELLER });
    await connected.prepareLock(terms, 0);
    const guard = (): void => {
      const check = checkSwapDeadlines(asOffer(LEG_A), asOffer(LEG_B), clock(), EVM_LOCAL_POLICY);
      if (!check.ok) throw new Error(`guard: deadlines are no longer safe at lock time: ${check.violations.join("; ")}`);
    };
    return { node, connected, guard, clockRef };
  }

  it("the clock moves past the lock window while the approve's receipt is awaited: the guard refuses, the approve stands, NO lock is sent", async () => {
    const { node, connected, guard } = await railWith(T0 + 50 * MIN);
    await expect(connected.commitLock({ beforeFinalSend: guard })).rejects.toThrow(/deadlines are no longer safe at lock time.*rule 1: reveal window/);
    expect(node.count("approve")).toBe(1);
    expect(node.count("lock"), "no lock behind a closed window").toBe(0);
  });

  it("the guard runs AFTER the approve was sent and BEFORE the lock", async () => {
    const { node, connected } = await railWith(undefined);
    const seen: Array<{ approves: number; locks: number }> = [];
    await connected.commitLock({
      beforeFinalSend: () => {
        seen.push({ approves: node.count("approve"), locks: node.count("lock") });
      },
    });
    expect(seen).toEqual([{ approves: 1, locks: 0 }]);
    expect(node.count("lock")).toBe(1);
  });

  it("a window that stays open sends the lock; a rail with no guard handed in sends it too (the option is optional)", async () => {
    const open = await railWith(T0 + 5 * MIN);
    const evidence = await open.connected.commitLock({ beforeFinalSend: open.guard });
    expect(evidence.ref).toBeDefined();
    expect(open.node.count("lock")).toBe(1);
    const bare = await railWith(undefined);
    await bare.connected.commitLock();
    expect(bare.node.count("lock")).toBe(1);
  });

  it("an async guard is awaited (its refusal still stops the lock)", async () => {
    const { node, connected } = await railWith(undefined);
    await expect(
      connected.commitLock({
        beforeFinalSend: async () => {
          await Promise.resolve();
          throw new Error("late refusal");
        },
      }),
    ).rejects.toThrow(/late refusal/);
    expect(node.count("lock")).toBe(0);
  });
});

describe("R1-FUND-08 through the real BuyerFlow: a window that closes during the approve refuses with the lock-guard error and sends no lock", () => {
  async function buyerReady() {
    let node: EvmMockNode | undefined;
    const s = await started(evmWorldWith((n) => void (node = n)), PREFIX);
    return { s, node: node! };
  }

  /** After the next send of `fn`, the world's clock jumps to `ms` (the world's own hook, which the crash controller uses, still runs first). */
  function moveClockAfter(s: Awaited<ReturnType<typeof buyerReady>>["s"], node: EvmMockNode, fn: SendKind, ms: number): void {
    const world = node.hook!;
    let last: SendKind | undefined;
    node.hook = {
      begin: (kind, from) => {
        last = kind;
        return world.begin(kind, from);
      },
      end: (token) => {
        world.end(token);
        if (last === fn) s.w.setTime(ms);
      },
    };
  }

  it("lockLegA throws the B3 lock-guard error, the approve went out, the lock did not, and a retry is refused too", async () => {
    const { s, node } = await buyerReady();
    moveClockAfter(s, node, "approve", s.w.lockTimeMs + 50 * MIN); // 40 minutes of reveal window left: under the 45 the policy asks for
    await expect(s.c.buyer.lockLegA()).rejects.toThrow(/refusing to lock leg A.*deadlines are no longer safe at lock time \(B3\).*rule 1/);
    expect(node.count("approve")).toBe(1);
    expect(node.count("lock"), "no lock behind a closed window").toBe(0);
    expect(s.w.counts().locks).toBe(0);
    await expect(s.c.buyer.lockLegA()).rejects.toThrow(/deadlines are no longer safe at lock time \(B3\)/);
    expect(node.count("lock"), "the retry sent nothing either").toBe(0);
  });

  it("with the clock where it was, the same flow locks (the control: the guard changes nothing while the window is open)", async () => {
    const { s, node } = await buyerReady();
    moveClockAfter(s, node, "approve", s.w.lockTimeMs + 5 * MIN);
    await s.c.buyer.lockLegA();
    expect(node.count("approve")).toBe(1);
    expect(node.count("lock")).toBe(1);
  });
});
