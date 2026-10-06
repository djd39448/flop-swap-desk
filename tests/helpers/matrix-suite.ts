// SPDX-License-Identifier: MIT
//
// The test bodies of the P8 crash matrix, shared by tests/resume-matrix-<world>.test.ts (one file per world, so they run in
// parallel): a reference run of each script lists its outward actions, then every action is cut in each of the three ways
// (tests/helpers/crash-matrix.ts) and the finished run is checked by `inspectRun`.

import { describe, expect, it } from "vitest";

import { BuyerFlow } from "../../src/client/buyer.js";
import { FlowRecordStaleError, FlowStoreLockedError, FlowStoreWriteFailedError } from "../../src/client/flow-store.js";
import {
  MODES,
  NEVER_LOCKED,
  PREFIX,
  REFUND_BOTH,
  SETTLE,
  finishStalled,
  inspectRun,
  resumeRole,
  runScript,
  STEPS,
  type Action,
  type Expected,
  type Mode,
  type Step,
  type WorldFactory,
} from "./crash-matrix.js";

export interface MatrixOptions {
  /** Cuts after which this world cannot finish the swap and stops safely, and why: a signed lock that stays pending (leg A is then
   *  never locked and the Seller takes leg B back) or a signed refund that stays pending (leg A stays locked until a person acts).
   *  Everything else must finish as the script says. */
  stalls?: (action: Action, mode: Mode) => "lock-pending" | "refund-pending" | undefined;
}

interface Plan {
  title: string;
  script: readonly Step[];
  expected: Expected;
  /** Only actions after this step are cut (the earlier ones belong to the settle matrix). */
  tailFrom?: Step;
}

const PLANS: Plan[] = [
  { title: "the swap settles", script: SETTLE, expected: "settled" },
  { title: "the Seller never reveals: both legs are refunded", script: REFUND_BOTH, expected: "refunded-both", tailFrom: STEPS.legARefundTime },
  { title: "the Buyer never locks: the Seller takes leg B back", script: NEVER_LOCKED, expected: "never-locked", tailFrom: STEPS.legBRefundTime },
];

export async function describeMatrix(world: string, factory: WorldFactory, options: MatrixOptions = {}): Promise<void> {
  for (const plan of PLANS) {
    const reference = await runScript(factory, plan.script, []);
    const referenceFindings = await inspectRun(reference, plan.expected);
    const tailAt = plan.tailFrom === undefined ? 0 : (reference.stepAt[plan.script.indexOf(plan.tailFrom)] as number);
    const cuts = reference.world.ctl.actions.filter((action) => action.n > tailAt);

    describe(`${world}: ${plan.title}`, () => {
      it("a run with no crash is right, and its boundaries are all outward actions that were saved before the next one", () => {
        expect(referenceFindings.problems).toEqual([]);
        expect(reference.world.ctl.unsaved).toEqual([]);
        expect(cuts.length).toBeGreaterThan(0);
      });

      for (const action of cuts) {
        for (const mode of MODES) {
          if (action.kind === "signed" && mode !== "before") continue; // a boundary is not an action: there is nothing to finish
          it(`#${action.n} ${action.role} ${action.what} / ${mode}`, async () => {
            const run = await runScript(factory, plan.script, [{ n: action.n, mode }]);
            const ctl = run.world.ctl;
            expect(ctl.fired.map((fired) => fired.n)).toEqual([action.n]); // the planned crash happened, exactly once
            expect(run.deaths).toBe(1);
            const stalls = options.stalls?.(action, mode);
            expect(run.stalled).toBe(stalls);
            if (stalls === "lock-pending") await finishStalled(run);
            const findings = await inspectRun(run, stalls === "lock-pending" ? "never-locked" : stalls === "refund-pending" ? "refund-stuck" : plan.expected);
            expect(findings.problems).toEqual([]);
            expect(ctl.unsaved).toEqual([]);
          });
        }
      }
    });
  }
}

/** How many outward actions after the first death are tried as the place of a second one (the recovery itself, not the rest of the swap). */
const RECOVERY_CUTS = 4;

/**
 * A process that dies again while it is recovering: for each chain action of the settle script, the first death either comes right before
 * the action (the recovery has to send it, or find out it was sent) or right after it with the next store write refused (the action
 * happened, its record did not); each of the next few outward actions of the run is then cut as well, before it and after it with the next
 * store write refused. The swap must still end exactly as if nothing had happened.
 */
export async function describeDoubleCrash(world: string, factory: WorldFactory, options: MatrixOptions = {}): Promise<void> {
  const reference = await runScript(factory, SETTLE, []);
  const firsts = reference.world.ctl.actions.filter((action) => action.kind === "chain");
  describe(`${world}: the swap settles, and the recovery is cut too`, () => {
    for (const first of firsts) {
      for (const firstMode of ["before", "after-store-fail"] as const) {
        if (options.stalls?.(first, firstMode) !== undefined) continue; // that cut stops the swap; the matrix above has it
        it(`#${first.n} ${first.what} / ${firstMode}; then each of the next ${RECOVERY_CUTS} outward actions is cut as well`, async () => {
          const probe = await runScript(factory, SETTLE, [{ n: first.n, mode: firstMode }]);
          const doomed = new Set(probe.world.ctl.doomed.map((action) => action.n));
          const seconds = probe.world.ctl.actions.filter((action) => action.n > first.n && action.kind !== "signed" && !doomed.has(action.n)).slice(0, RECOVERY_CUTS);
          expect(seconds.length).toBeGreaterThan(0);
          for (const second of seconds) {
            for (const mode of ["before", "after-store-fail"] as const) {
              const run = await runScript(factory, SETTLE, [
                { n: first.n, mode: firstMode },
                { n: second.n, mode },
              ]);
              expect(run.world.ctl.fired.map((fired) => fired.n).sort((a, b) => a - b), `${second.what} / ${mode}`).toEqual([first.n, second.n]);
              const stalls = options.stalls?.(second, mode);
              expect(run.stalled).toBe(stalls);
              if (stalls === "lock-pending") await finishStalled(run);
              const findings = await inspectRun(run, stalls === "lock-pending" ? "never-locked" : stalls === "refund-pending" ? "refund-stuck" : "settled");
              expect(findings.problems, `${second.what} / ${mode}`).toEqual([]);
              expect(run.world.ctl.unsaved).toEqual([]);
            }
          }
        });
      }
    }
  });
}

// --- review round 1: three more dimensions ------------------------------------------------------------------------------------------
//
//   time passes     the Buyer's lock lands, the process dies, and the clock moves past the lock-time guard (or to leg A's refund time) while it is
//                   down: the resumed Buyer must RECOGNISE its landed lock whatever the clock says and finish (R1-01)
//   sticky fault    a store fault that never heals: every save from the k-th save of a Buyer step on is refused, the same step is called again
//                   in the same process (twice), and only then does the runner restart: the retries must refuse and do nothing outward, the
//                   restart must finish the swap (R1-03)
//   two instances   two live Buyer instances on one store both lock leg A: exactly one lock is sent and the loser is refused (R1-02)

const settle = async <T>(run: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  run.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * The Buyer's lock lands (the last chain action of its `lockLegA`) and the record of it is lost or saved, the process dies, and the clock
 * jumps while it is down:
 *   - to one millisecond before leg A's refund time: far outside the lock-time guard (rule 1 of the deadline arithmetic fails), yet the
 *     resumed Buyer records and announces the lock that landed, and the swap runs on to "refunded-both" exactly as if nothing happened;
 *   - to leg A's refund time: `next` names `refundLegA`, which refunds the lock that landed (one lock, one refund, nothing sent twice).
 */
export async function describeTimePasses(world: string, factory: WorldFactory): Promise<void> {
  const reference = await runScript(factory, [...PREFIX, STEPS.lockLegA], []);
  const chainActions = reference.world.ctl.actions.filter((action) => action.role === "buyer" && action.kind === "chain");
  const landing = chainActions[chainActions.length - 1];
  if (landing === undefined) throw new Error(`${world}: the reference run has no Buyer chain action`);

  describe(`${world}: time passes while the Buyer is down with its lock landed (R1-01)`, () => {
    for (const mode of ["after-store-fail", "after-store-ok"] as const) {
      it(`${landing.what} / ${mode}: resumed outside the lock-time guard, the landed lock is recognised and the swap ends refunded on both legs`, async () => {
        const run = await runScript(factory, REFUND_BOTH, [{ n: landing.n, mode }], {
          beforeResume: (role, w) => {
            if (role === "buyer") w.setTime(w.refundAt.legA - 1); // time passes while the process is down
          },
        });
        expect(run.deaths).toBe(1);
        expect(run.stalled).toBeUndefined();
        const findings = await inspectRun(run, "refunded-both");
        expect(findings.problems).toEqual([]);
        expect(findings.counts).toMatchObject({ locks: 1, refunds: 1 });
      });

      it(`${landing.what} / ${mode}: resumed at leg A's refund time, next names refundLegA and the one lock that landed is refunded`, async () => {
        const run = await runScript(factory, REFUND_BOTH, [{ n: landing.n, mode }], {
          beforeResume: (role, w) => {
            if (role === "buyer") w.setTime(w.refundAt.legA);
          },
        });
        expect(run.deaths).toBe(1);
        expect(run.nexts[0]?.next).toBe("refundLegA");
        const counts = run.world.counts();
        expect(counts).toMatchObject({ locks: 1, refunds: 1 });
        const resumed = await BuyerFlow.resume({ ...run.world.buyerOptions(), store: run.world.stores.buyer, swapId: run.world.swapId });
        expect(resumed.next).toBe("done");
      });
    }
  });
}

/** The saves each step of `script` makes on the Buyer's store, by step index (a step that is not the Buyer's, or saves nothing, is 0). */
async function buyerSavesPerStep(factory: WorldFactory, script: readonly Step[]): Promise<number[]> {
  const starts: number[] = [];
  const run = await runScript(factory, script, [], {
    beforeStep: async (index, _step, c) => {
      starts[index] = c.w.stores.buyer.saveCount;
    },
  });
  const end = run.world.stores.buyer.saveCount;
  return script.map((_step, index) => (index === script.length - 1 ? end : (starts[index + 1] ?? end)) - (starts[index] ?? 0));
}

/**
 * For each Buyer step and each of its saves k: every save from the k-th on is refused (the fault never heals); the step fails with a
 * `FlowStoreWriteFailedError`; the same step is called twice more in the SAME process and refuses both times with no outward action
 * (no chain send, no venue post, no paper write: the controller counts every one) and nothing built; then the fault is cleared, the
 * Buyer is resumed (a new flow) and the swap runs to its end.
 */
export async function describeStickyFault(world: string, factory: WorldFactory): Promise<void> {
  const plans: Array<{ title: string; script: readonly Step[]; expected: Expected; steps: Step[] }> = [
    { title: "the swap settles", script: SETTLE, expected: "settled", steps: [STEPS.bid, STEPS.acceptLegB, STEPS.verify, STEPS.buyerLine, STEPS.lockLegA, STEPS.learnAndClaimB] },
    { title: "the Seller never reveals", script: REFUND_BOTH, expected: "refunded-both", steps: [STEPS.refundLegA] },
  ];
  for (const plan of plans) {
    const saves = await buyerSavesPerStep(factory, plan.script);
    describe(`${world}: ${plan.title}; a store fault that never heals (R1-03)`, () => {
      for (const step of plan.steps) {
        const index = plan.script.indexOf(step);
        for (let k = 1; k <= (saves[index] ?? 0); k += 1) {
          it(`${step.name}, from its save ${k} of ${saves[index]}: the step fails, two retries in the same process refuse and do nothing, the restart finishes`, async () => {
            const run = await runScript(factory, plan.script, [], {
              beforeStep: async (at, current, c) => {
                if (at !== index) return;
                const w = c.w;
                const store = w.stores.buyer;
                const start = store.saveCount;
                store.failSaveWhen((n) => (n >= start + k ? "reject" : undefined));
                const first = await settle(current.run(c));
                expect(first.ok, "the step must fail once its save is refused").toBe(false);
                expect(!first.ok && first.error, "the first failure").toBeInstanceOf(FlowStoreWriteFailedError);
                const before = { actions: w.ctl.actions.length, counts: w.counts() };
                for (let retry = 1; retry <= 2; retry += 1) {
                  const again = await settle(current.run(c));
                  expect(again.ok, `retry ${retry} must refuse`).toBe(false);
                  expect(!again.ok && again.error, `retry ${retry}`).toBeInstanceOf(FlowStoreWriteFailedError);
                }
                expect(w.ctl.actions.length, "no outward action by a retry").toBe(before.actions);
                expect(w.counts(), "nothing built or sent by a retry").toEqual(before.counts);
                store.clearFaults();
                w.ctl.attachStore(store, "buyer");
                if (current === STEPS.bid && k === 1) {
                  // nothing was ever saved, so there is nothing to resume: the runner starts the swap again with a new flow
                  w.ctl.restart("buyer");
                  c.buyer = new BuyerFlow(w.buyerOptions());
                  c.history.push(c.buyer);
                  return { next: "bid" };
                }
                return { next: await resumeRole(c, "buyer") };
              },
            });
            // a refund that was signed and whose handle save was refused was never sent, so a second one may be BUILT; it is never sent twice
            if (run.world.maxRefundBuilds !== undefined) run.world.maxRefundBuilds += 1;
            const findings = await inspectRun(run, plan.expected);
            expect(findings.problems).toEqual([]);
            expect(run.deaths).toBe(0);
          });
        }
      }
    });
  }
}

/**
 * Two live Buyer instances on one store (a supervisor that believes the first died, or a runner that resumes while a hung call is still
 * running) both call `lockLegA`, in turn and at once: exactly ONE lock is sent, exactly one call wins, and the loser is refused by the
 * store (`FlowRecordStaleError`, or `FlowStoreLockedError` for a file store); the swap then finishes through the winner.
 */
export async function describeTwoInstances(world: string, factory: WorldFactory, options: { alsoRefusedBy?: RegExp } = {}): Promise<void> {
  const lockIndex = SETTLE.indexOf(STEPS.lockLegA);
  describe(`${world}: two Buyer instances on one store both lock leg A (R1-02)`, () => {
    for (const order of ["in turn", "at once"] as const) {
      it(`${order}: one lock, one winner, the loser is refused, and the swap settles`, async () => {
        const run = await runScript(factory, SETTLE, [], {
          beforeStep: async (at, _step, c) => {
            if (at !== lockIndex) return;
            const w = c.w;
            const first = c.buyer;
            const second = (await BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId })).flow; // same epoch: both are alive
            const results =
              order === "in turn"
                ? [await settle(first.lockLegA()), await settle(second.lockLegA())]
                : await Promise.all([settle(first.lockLegA()), settle(second.lockLegA())]);
            const winners = results.filter((result) => result.ok);
            const losers = results.filter((result) => !result.ok);
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            const loser = losers[0];
            const error = !loser?.ok ? loser?.error : undefined;
            const refusedByStore = error instanceof FlowRecordStaleError || error instanceof FlowStoreLockedError;
            // A rail that reads the chain before it signs (Solana: an escrow for this payer and hash lock already exists) may refuse
            // the second lock itself, in turn; it is a refusal either way and nothing is sent.
            const refusedByChain = options.alsoRefusedBy !== undefined && error instanceof Error && options.alsoRefusedBy.test(error.message);
            expect(refusedByStore || refusedByChain, `the loser's error: ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : String(error)}`).toBe(true);
            if (order === "at once") expect(refusedByStore, "two calls at once reach the store together: the store refuses the loser").toBe(true);
            expect(w.counts().locks).toBe(1);
            c.buyer = results[0]?.ok === true ? first : second;
            c.history.push(second);
            return { handled: true };
          },
        });
        const findings = await inspectRun(run, "settled");
        expect(findings.problems).toEqual([]);
        expect(findings.counts.locks).toBe(1);
      });
    }
  });
}
