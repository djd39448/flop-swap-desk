// SPDX-License-Identifier: MIT
//
// The test bodies of the P8 crash matrix, shared by tests/resume-matrix-<world>.test.ts (one file per world, so they run in
// parallel): a reference run of each script lists its outward actions, then every action is cut in each of the three ways
// (tests/helpers/crash-matrix.ts) and the finished run is checked by `inspectRun`.

import { describe, expect, it } from "vitest";

import {
  MODES,
  NEVER_LOCKED,
  REFUND_BOTH,
  SETTLE,
  finishStalled,
  inspectRun,
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
