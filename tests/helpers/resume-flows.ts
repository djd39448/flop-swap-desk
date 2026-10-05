// SPDX-License-Identifier: MIT
//
// Helpers for the P8 crash-resume flow tests: "drop the instance, resume a fresh one over the same venue, note store,
// chain and clock" (P8-RESUME-SPEC.md, Tests) without any process to kill. A crash is one of two things here: a call that
// throws `ProcessDied` BEFORE the real work (the intent is in the store, the action is not done), or one that does the real
// work and THEN throws `ProcessDied` (the action is done, the process never saw the reply). The flow instance that hit it is
// simply abandoned; the test builds a new one with `resumeBuyer` / `resumeSeller`.

import { PaperRail } from "@flop-labs/tclk";

import { BuyerFlow, type BuyerFlowOptions } from "../../src/client/buyer.js";
import type { ConnectedCounterAssetRail, CounterAssetRail } from "../../src/client/counter-rail.js";
import type { FlowStore } from "../../src/client/flow-store.js";
import { SellerFlow, type SellerFlowOptions } from "../../src/client/seller.js";
import type { Venue } from "../../src/client/venue.js";

/** What a "crashed" call throws. */
export class ProcessDied extends Error {
  constructor(where: string) {
    super(`process died ${where} (test)`);
    this.name = "ProcessDied";
  }
}

type ConnectedMethod = "prepareLock" | "commitLock" | "claim" | "refund" | "recoverLock" | "recoverRefund" | "recoverClaim" | "verifyLockFinal";

export interface CrashPlan {
  /** Throw `ProcessDied` instead of running the call (once). */
  before?: ConnectedMethod[];
  /** Run the call, then throw `ProcessDied` (once): the effect happened, the reply was lost. */
  after?: ConnectedMethod[];
}

/** A rail whose connected handles die as `plan` says. Each entry fires once, in the first connected handle that calls it. */
export function crashRail(rail: CounterAssetRail, plan: CrashPlan): CounterAssetRail {
  const before = new Set(plan.before ?? []);
  const after = new Set(plan.after ?? []);
  const wrapConnected = (connected: ConnectedCounterAssetRail): ConnectedCounterAssetRail =>
    new Proxy(connected, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const name = property as ConnectedMethod;
        return async (...args: unknown[]): Promise<unknown> => {
          if (before.delete(name)) throw new ProcessDied(`before ${String(property)}`);
          const result: unknown = await (value as (...a: unknown[]) => unknown).apply(target, args);
          if (after.delete(name)) throw new ProcessDied(`after ${String(property)}`);
          return result;
        };
      },
    });
  return new Proxy(rail, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "connect") {
        return async (...args: Parameters<CounterAssetRail["connect"]>): Promise<ConnectedCounterAssetRail> => wrapConnected(await target.connect(...args));
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface ResumeContext {
  buyer: BuyerFlowOptions;
  seller: SellerFlowOptions;
}

/** A new Buyer for the swap, built from the dead one's options (a fresh `PaperRail` over the same note store is part of
 *  `options.paperRail`, which the harness shares). */
export async function resumeBuyer(options: BuyerFlowOptions, store: FlowStore, swapId: string, extra: Partial<BuyerFlowOptions> = {}) {
  return BuyerFlow.resume({ ...options, ...extra, store, swapId });
}

export async function resumeSeller(options: SellerFlowOptions, store: FlowStore, swapId: string, extra: Partial<SellerFlowOptions> = {}) {
  return SellerFlow.resume({ ...options, ...extra, store, swapId });
}

/** A venue whose `post` throws for the next `count` lines that satisfy `match` (everything else passes through). */
export function failVenuePosts(venue: Venue, match: (room: string, line: string) => boolean, count = 1): { failed: () => number; restore: () => void } {
  const target = venue as unknown as { post: (room: string, line: string, id: unknown) => Promise<unknown> };
  const original = target.post.bind(venue);
  let failed = 0;
  target.post = async (room, line, id) => {
    if (failed < count && match(room, line)) {
      failed += 1;
      throw new ProcessDied(`before posting to ${room}`);
    }
    return original(room, line, id);
  };
  return {
    failed: () => failed,
    restore: () => {
      target.post = original;
    },
  };
}

/** A venue whose `post` lands the line and then throws for the next `count` matching lines (the reply is lost). */
export function loseVenueReplies(venue: Venue, match: (room: string, line: string) => boolean, count = 1): { lost: () => number; restore: () => void } {
  const target = venue as unknown as { post: (room: string, line: string, id: unknown) => Promise<unknown> };
  const original = target.post.bind(venue);
  let lost = 0;
  target.post = async (room, line, id) => {
    const record = await original(room, line, id);
    if (lost < count && match(room, line)) {
      lost += 1;
      throw new ProcessDied(`after posting to ${room}`);
    }
    return record;
  };
  return {
    lost: () => lost,
    restore: () => {
      target.post = original;
    },
  };
}

/** A fresh `PaperRail` over the shared note store, for a flow built after a crash. */
export function paperFor(noteStore: ConstructorParameters<typeof PaperRail>[0], clock: () => number): PaperRail {
  return new PaperRail(noteStore, clock);
}
