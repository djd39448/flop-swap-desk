// SPDX-License-Identifier: MIT
//
// The P8 crash matrix (P8-RESUME-SPEC.md, Tests): for each role and each harness, cut a whole swap at every boundary between two
// OUTWARD actions (a venue post, a paper-note write, a chain send), in three ways, drop the flow instance, resume a fresh one over
// the same venue, note store, chain, clock and flow store, run to the end, and count what reached the outside world.
//
//   "before"            the process dies right before action k: the store holds what was saved before it, the action did not happen;
//   "after-store-fail"  action k happens, then the very next store write of that role is REFUSED (MemoryFlowStore fault "reject"):
//                       the outward effect exists, the record of it does not;
//   "after-store-ok"    action k happens, then the very next store write commits and the process dies right after it
//                       (MemoryFlowStore fault "commit-then-throw"): the effect and its record both exist, nothing after them.
//
// A "process" here is a flow instance plus the wrappers around the objects it was handed (venue, paper rail, counter rail, store
// faults). `Controller.kill` marks a role dead; a dead instance cannot act any more (every wrapper throws `ProcessDied` for it), which
// is what a dead process does, even if the flow code catches the first error and tries to carry on. `restart` builds new wrappers for
// the same role (a new epoch) and the driver resumes a new flow from the store.
//
// The driver is a "runner": it holds no swap state of its own. It reads the signed records it needs from the venue, calls the next
// step of the script, and after a crash resumes the dead role and re-runs the crashed step (every step is idempotent against the
// record). `resume`'s `next` decides which earlier steps of that role are skipped, so a wrong `next` shows up as a swap that does not
// finish. Every outward action is counted at the point it happens (`Controller.actions`), which is also how a run's boundaries are
// listed before any crash is planned.

import { inspect } from "node:util";
import {
  MemoryNoteStore,
  OFFER_ROOM,
  PaperRail,
  dealRoom,
  foldTranscript,
  tryDecodeFrame,
  verifyTranscriptRecord,
  type AcceptFrame,
  type HashLock,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { BuyerFlow, LockPendingError, type BidParams, type BuyerFlowOptions } from "../../src/client/buyer.js";
import type { ConnectedCounterAssetRail, CounterAssetRail, RailClaimOptions, RailRefundOptions } from "../../src/client/counter-rail.js";
import { decodeFlowRecord } from "../../src/client/flow-record.js";
import { MemoryFlowStore, flowKey, type MemoryFault } from "../../src/client/flow-store.js";
import { SellerFlow, type LegBDeadlines, type SellerFlowOptions } from "../../src/client/seller.js";
import type { MemoryVenue, Venue } from "../../src/client/venue.js";
import { classifySwapOffer } from "../../src/profile.js";
import { ProcessDied } from "./resume-flows.js";

export type Role = "buyer" | "seller";
export type Mode = "before" | "after-store-fail" | "after-store-ok";
export const MODES: readonly Mode[] = ["before", "after-store-fail", "after-store-ok"];

/** `post`: a venue post. `note`: a paper-note write. `chain`: a send on the counter-asset chain. `signed`: a boundary, not an action: a
 *  claim or refund was signed and its record saved (the `onSigned` recorder returned) and nothing was sent yet. */
export type PointKind = "post" | "note" | "chain" | "signed";

export interface Action {
  n: number;
  role: Role;
  kind: PointKind;
  what: string;
}
export interface Target {
  n: number;
  mode: Mode;
}
interface Token {
  action: Action;
  target: Target | undefined;
}

// --- the controller ------------------------------------------------------------------------------------------------------

export class Controller {
  /** Every outward action and boundary reached so far, in order (1-based `n`). */
  readonly actions: Action[] = [];
  /** The planned crashes that actually fired. */
  readonly fired: Array<Target & { role: Role; what: string }> = [];
  /** Outward actions that began before the previous action of the same role had its outcome saved. The only pair the design allows
   *  is the EVM lock's `approve` then `lock`: one saved intent (the prepared lock) covers both sends. Anything else is a send the
   *  record did not cover. */
  get unsaved(): Array<{ role: Role; after: Action; next: Action }> {
    return this.gaps.filter((gap) => !(gap.after.what === "chain:approve" && gap.next.what === "chain:lock"));
  }
  private readonly gaps: Array<{ role: Role; after: Action; next: Action }> = [];
  /** Roles that died, in order. */
  readonly kills: Array<{ role: Role; at: Action | undefined }> = [];
  private readonly targets: readonly Target[];
  private count = 0;
  private readonly dead: Record<Role, boolean> = { buyer: false, seller: false };
  private readonly epochs: Record<Role, number> = { buyer: 0, seller: 0 };
  private readonly armed: Record<Role, { fault: MemoryFault; after: Action; target: Target } | undefined> = { buyer: undefined, seller: undefined };
  private readonly last: Record<Role, Action | undefined> = { buyer: undefined, seller: undefined };
  private readonly savedSince: Record<Role, boolean> = { buyer: true, seller: true };

  constructor(targets: readonly Target[] = []) {
    this.targets = targets;
  }

  epochOf(role: Role): number {
    return this.epochs[role];
  }
  isDead(role: Role): boolean {
    return this.dead[role];
  }
  restart(role: Role): void {
    this.dead[role] = false;
    this.epochs[role] += 1;
    this.armed[role] = undefined;
    this.last[role] = undefined;
    this.savedSince[role] = true;
  }
  private kill(role: Role): void {
    this.dead[role] = true;
    this.kills.push({ role, at: this.last[role] });
  }

  /** A dead process, or an instance from before the last restart, does nothing. */
  assertAlive(role: Role, epoch: number): void {
    if (this.dead[role] || epoch !== this.epochs[role]) throw new ProcessDied(`(${role} is dead: no further calls)`);
  }

  /** Starts an outward action. Throws `ProcessDied` when the plan kills the role right before it. */
  begin(role: Role, epoch: number, kind: PointKind, what: string): Token {
    this.assertAlive(role, epoch);
    const action: Action = { n: ++this.count, role, kind, what };
    this.actions.push(action);
    const previous = this.last[role];
    if (previous !== undefined && !this.savedSince[role]) this.gaps.push({ role, after: previous, next: action });
    const target = this.targets.find((candidate) => candidate.n === action.n);
    // An earlier after-store fault is still armed: no store write happened between the two actions. The process dies here instead.
    const pending = this.armed[role];
    if (pending !== undefined) {
      this.armed[role] = undefined;
      this.fired.push({ ...pending.target, role, what: pending.after.what });
      this.kill(role);
      throw new ProcessDied(`before ${what} (the store write after ${pending.after.what} never came)`);
    }
    if (target?.mode === "before") {
      this.fired.push({ ...target, role, what });
      this.kill(role);
      throw new ProcessDied(`before ${what}`);
    }
    return { action, target };
  }

  /** The action happened. An after-store plan arms the fault the role's next store write will hit. */
  end(token: Token): void {
    const { action, target } = token;
    this.last[action.role] = action;
    this.savedSince[action.role] = false;
    if (target !== undefined && target.mode !== "before" && action.kind !== "signed") {
      this.armed[action.role] = { fault: target.mode === "after-store-fail" ? "reject" : "commit-then-throw", after: action, target };
    }
  }

  /** `begin`, `run`, `end`. */
  async action<T>(role: Role, epoch: number, kind: PointKind, what: string, run: () => Promise<T>): Promise<T> {
    const token = this.begin(role, epoch, kind, what);
    const result = await run();
    this.end(token);
    return result;
  }

  /** A boundary inside an action (a signed refund whose record was saved): the plan can only kill the role right here. */
  boundary(role: Role, epoch: number, what: string): void {
    this.begin(role, epoch, "signed", what);
  }

  /** The predicate for `MemoryFlowStore.failSaveWhen` of `role`'s store. */
  storeFault(role: Role): MemoryFault | undefined {
    if (this.dead[role]) return "reject"; // a dead process cannot save
    this.savedSince[role] = true;
    const armed = this.armed[role];
    if (armed === undefined) return undefined;
    this.armed[role] = undefined;
    this.fired.push({ ...armed.target, role, what: armed.after.what });
    this.kill(role);
    return armed.fault;
  }

  attachStore(store: MemoryFlowStore, role: Role): void {
    store.failSaveWhen(() => this.storeFault(role));
  }
}

// --- wrappers: the objects a flow is handed -----------------------------------------------------------------------------

function postLabel(line: string): string {
  const frame = tryDecodeFrame(line);
  if (frame === null) return "post:line";
  const rail = (frame as { rail?: unknown }).rail;
  return typeof rail === "string" ? `post:${frame.type}/${rail}` : `post:${frame.type}`;
}

export function wrapVenue(venue: Venue, ctl: Controller, role: Role, epoch: number): Venue {
  return {
    post: (room, line, signer) => ctl.action(role, epoch, "post", postLabel(line), () => venue.post(room, line, signer)),
    read: async (room) => {
      ctl.assertAlive(role, epoch);
      return venue.read(room);
    },
  };
}

/** The paper rail's three writes are outward actions (`note:lock`, `note:claim`, `note:refund`); its reads only check the role is alive. */
export function wrapPaper(paper: PaperRail, ctl: Controller, role: Role, epoch: number): PaperRail {
  return new Proxy(paper, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const name = String(property);
      return (...args: unknown[]): unknown => {
        if (name === "lock" || name === "claim" || name === "refund") {
          return ctl.action(role, epoch, "note", `note:${name}`, async () => (await (value as (...a: unknown[]) => unknown).apply(target, args)) as unknown);
        }
        ctl.assertAlive(role, epoch);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * An ADAPTER rail (the real Solana or NEAR rail) seen as outward actions at the seam: `commitLock`, `claim` and `refund` are `chain`
 * actions, and a claim or refund's `onSigned` recorder returning is a `signed` boundary (the signature is saved, nothing is sent yet).
 * Everything else only checks that the role is alive.
 */
export function wrapAdapterRail(rail: CounterAssetRail, ctl: Controller, role: Role, epoch: number): CounterAssetRail {
  const wrapConnected = (connected: ConnectedCounterAssetRail): ConnectedCounterAssetRail =>
    new Proxy(connected, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const name = String(property);
        const call = (...args: unknown[]): unknown => (value as (...a: unknown[]) => unknown).apply(target, args);
        if (name === "commitLock") return () => ctl.action(role, epoch, "chain", "chain:commitLock", async () => (await call()) as unknown);
        if (name === "claim") {
          return (ref: string, secret: string, notAfterMs: number, options?: RailClaimOptions) => {
            const wrapped: RailClaimOptions | undefined =
              options?.onSigned === undefined
                ? options
                : {
                    ...options,
                    onSigned: async (record) => {
                      await options.onSigned?.(record);
                      ctl.boundary(role, epoch, "chain:claim.signed");
                    },
                  };
            return ctl.action(role, epoch, "chain", "chain:claim", async () => (await call(ref, secret, notAfterMs, ...(wrapped === undefined ? [] : [wrapped]))) as unknown);
          };
        }
        if (name === "refund") {
          return (ref: string, options?: RailRefundOptions) => {
            const wrapped: RailRefundOptions | undefined =
              options?.onSigned === undefined
                ? options
                : {
                    ...options,
                    onSigned: async (recovery) => {
                      await options.onSigned?.(recovery);
                      ctl.boundary(role, epoch, "chain:refund.signed");
                    },
                  };
            return ctl.action(role, epoch, "chain", "chain:refund", async () => (await call(ref, ...(wrapped === undefined ? [] : [wrapped]))) as unknown);
          };
        }
        return (...args: unknown[]): unknown => {
          ctl.assertAlive(role, epoch);
          return call(...args);
        };
      },
    });
  return new Proxy(rail, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "connect") {
        return async (...args: Parameters<CounterAssetRail["connect"]>): Promise<ConnectedCounterAssetRail> => {
          ctl.assertAlive(role, epoch);
          return wrapConnected(await target.connect(...args));
        };
      }
      return (...args: unknown[]): unknown => {
        ctl.assertAlive(role, epoch);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

// --- the world ----------------------------------------------------------------------------------------------------------

export interface ChainCounts {
  /** Lock transactions that reached the chain / claims / refunds. */
  locks: number;
  claims: number;
  refunds: number;
  /** Refund transactions BUILT (signed). A refund built but never sent never reached the network. */
  refundBuilds: number;
}

export interface World {
  name: string;
  ctl: Controller;
  clockRef: { ms: number };
  setTime(ms: number): void;
  venue: MemoryVenue;
  noteStore: MemoryNoteStore;
  /** A paper rail for READING notes (not instrumented). */
  paper: PaperRail;
  stores: Record<Role, MemoryFlowStore>;
  dids: Record<Role, string>;
  swapId: string;
  bidParams: BidParams;
  legB: LegBDeadlines;
  lockTimeMs: number;
  addresses: Record<Role, string>;
  /** The secret the Seller mints (injected, so the matrix knows it). */
  hashLock: HashLock;
  /** Every 32-byte key seed this world derived a key from (the DID identities and the chain signers): none of them may ever show in
   *  anything a flow persists. */
  keySeeds: Uint8Array[];
  refundAt: { legA: number; legB: number };
  buyerOptions(): BuyerFlowOptions;
  sellerOptions(): SellerFlowOptions;
  counts(): ChainCounts;
  /** The most refund transactions the world may have BUILT in one swap (Bitcoin: 1, whatever crashes). Default: no limit beyond sends. */
  maxRefundBuilds?: number;
  /** A step of `role` ended with `error`, which may mean "a recorded transaction is not decided yet" (a signed lock, claim or refund
   *  whose blockhash is still valid): move the chain so it is decided and answer `true` (the step is called again), or `false`
   *  when `error` is not that or the chain will never decide it. */
  settlePending(role: Role, error: unknown): Promise<boolean>;
}

export type WorldFactory = (ctl: Controller) => World;

// --- what the venue shows -----------------------------------------------------------------------------------------------

export interface SwapView {
  offerA?: OfferFrame;
  offerARecord?: TranscriptRecord;
  acceptA?: AcceptFrame;
  acceptARecord?: TranscriptRecord;
  offerB?: OfferFrame;
  offerBRecord?: TranscriptRecord;
  acceptB?: AcceptFrame;
  acceptBRecord?: TranscriptRecord;
}

/** The four swap frames and their signed records, read from the offers room the way a runner would. */
export async function readSwap(w: World): Promise<SwapView> {
  const view: SwapView = {};
  for (const record of await w.venue.read(OFFER_ROOM)) {
    if (!verifyTranscriptRecord(record).ok) continue;
    const frame = tryDecodeFrame(record.line);
    if (frame === null || frame.from !== record.sender) continue;
    if (frame.type === "offer") {
      const classified = classifySwapOffer(frame);
      if (classified === null) continue;
      if (classified.context.leg === "a" && record.sender === w.dids.buyer) Object.assign(view, { offerA: frame, offerARecord: record });
      if (classified.context.leg === "b" && record.sender === w.dids.seller) Object.assign(view, { offerB: frame, offerBRecord: record });
    } else if (frame.type === "accept") {
      if (record.sender === w.dids.seller) Object.assign(view, { acceptA: frame, acceptARecord: record });
      if (record.sender === w.dids.buyer) Object.assign(view, { acceptB: frame, acceptBRecord: record });
    }
  }
  return view;
}

// --- steps and scripts --------------------------------------------------------------------------------------------------

export interface Ctx {
  w: World;
  buyer: BuyerFlow;
  seller: SellerFlow;
  /** Every flow instance ever built, in order (the dead ones too). */
  history: Array<BuyerFlow | SellerFlow>;
}

export interface Step {
  /** `null`: a step of the runner itself (time passing), not of a flow. */
  role: Role | null;
  /** The name `resume` uses in `next` for this step. */
  name: string;
  run(c: Ctx): Promise<unknown>;
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`matrix runner: ${what} is not in the venue yet`);
  return value;
};

export const STEPS = {
  bid: { role: "buyer", name: "bid", run: (c) => c.buyer.bid(c.w.bidParams) },
  acceptLegA: {
    role: "seller",
    name: "acceptLegA",
    run: async (c) => c.seller.acceptLegA(need((await readSwap(c.w)).offerA, "offer A"), c.w.legB, c.w.lockTimeMs),
  },
  acceptLegB: {
    role: "buyer",
    name: "acceptLegB",
    run: async (c) => {
      const v = await readSwap(c.w);
      return c.buyer.acceptLegB(need(v.offerBRecord, "offer B"), need(v.acceptARecord, "accept A"), c.w.lockTimeMs);
    },
  },
  sellerLine: { role: "seller", name: "postAccountLineA", run: (c) => c.seller.postAccountLineA(c.w.addresses.seller) },
  lockLegB: {
    role: "seller",
    name: "lockLegB",
    run: async (c) => c.seller.lockLegB(need((await readSwap(c.w)).acceptBRecord, "accept B")),
  },
  verify: { role: "buyer", name: "verifyLegBLocked", run: (c) => c.buyer.verifyLegBLocked() },
  buyerLine: { role: "buyer", name: "postAccountLineA", run: (c) => c.buyer.postAccountLineA(c.w.addresses.buyer) },
  lockLegA: { role: "buyer", name: "lockLegA", run: (c) => c.buyer.lockLegA() },
  claimLegA: { role: "seller", name: "claimLegA", run: (c) => c.seller.claimLegA(need(c.seller.statement, "the Seller's statement")) },
  learnAndClaimB: {
    role: "buyer",
    name: "learnSecret",
    run: async (c) => c.buyer.claimLegB(await c.buyer.learnSecret()),
  },
  refundLegA: { role: "buyer", name: "refundLegA", run: (c) => c.buyer.refundLegA() },
  refundLegB: { role: "seller", name: "refundLegB", run: (c) => c.seller.refundLegB() },
  legARefundTime: { role: null, name: "time:legA", run: async (c) => c.w.setTime(c.w.refundAt.legA) },
  legBRefundTime: { role: null, name: "time:legB", run: async (c) => c.w.setTime(c.w.refundAt.legB) },
} satisfies Record<string, Step>;

/** The pairing and both account lines: everything before the Buyer locks leg A. */
export const PREFIX: Step[] = [
  STEPS.bid,
  STEPS.acceptLegA,
  STEPS.acceptLegB,
  STEPS.sellerLine,
  STEPS.lockLegB,
  STEPS.verify,
  STEPS.buyerLine,
];
/** The whole swap: both legs settle. */
export const SETTLE: Step[] = [...PREFIX, STEPS.lockLegA, STEPS.claimLegA, STEPS.learnAndClaimB];
/** The Seller never reveals: both legs are refunded (the Buyer's leg A first, then the Seller's leg B). */
export const REFUND_BOTH: Step[] = [...PREFIX, STEPS.lockLegA, STEPS.legARefundTime, STEPS.refundLegA, STEPS.legBRefundTime, STEPS.refundLegB];
/** The Buyer never locks leg A: the Seller refunds leg B. */
export const NEVER_LOCKED: Step[] = [...PREFIX, STEPS.legBRefundTime, STEPS.refundLegB];

/** Where `next` (a name `resume` returned) points in `script` for `role`. A name the script does not use means "the rest of what
 *  this script has for the role": `learnSecret` after a lock leads to the refund in a refund script, and so on. */
export function rankOf(script: readonly Step[], role: Role, next: string): number {
  if (next === "done") return script.length;
  const alias: Record<string, string> = { learnSecret: "refundLegA", claimLegA: "refundLegB" };
  const find = (name: string): number => script.findIndex((step) => step.role === role && step.name === name);
  let index = find(next);
  if (index < 0 && alias[next] !== undefined) index = find(alias[next] as string);
  return index < 0 ? script.length : index;
}

// --- the driver ---------------------------------------------------------------------------------------------------------

export interface RunResult {
  world: World;
  ctx: Ctx;
  /** What `resume` said after each restart. */
  nexts: Array<{ role: Role; next: string; crashedAt: string }>;
  /** A recorded transaction stayed undecided although the world offers no way to decide it, and the run went on without it, safely:
   *  `lock-pending`: the Buyer's signed lock (nothing is locked, so leg A is simply never locked); `refund-pending`: the Buyer's
   *  signed refund (leg A stays locked until a person acts). */
  stalled: "lock-pending" | "refund-pending" | undefined;
  /** Errors a dead role's step ended with. */
  deaths: number;
  /** Rooms searched for the secret at each death while the secret was still private. */
  leaks: string[];
  /** How many outward actions had happened when each script step first started (so a refund tail can be told from its prefix). */
  stepAt: number[];
}

const MAX_PENDING_RETRIES = 4;

export async function resumeRole(c: Ctx, role: Role): Promise<string> {
  const w = c.w;
  w.ctl.restart(role);
  if (role === "buyer") {
    const resumed = await BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId });
    c.buyer = resumed.flow;
    c.history.push(resumed.flow);
    return resumed.next;
  }
  const resumed = await SellerFlow.resume({ ...w.sellerOptions(), store: w.stores.seller, swapId: w.swapId });
  c.seller = resumed.flow;
  c.history.push(resumed.flow);
  return resumed.next;
}

export interface RunHooks {
  /** Runs right after a dead role was resumed and before its crashed step runs again: the place for a third party to act on the chain. */
  afterResume?: (role: Role, next: string, w: World) => void | Promise<void>;
}

export async function runScript(factory: WorldFactory, script: readonly Step[], targets: readonly Target[], hooks: RunHooks = {}): Promise<RunResult> {
  const ctl = new Controller(targets);
  const w = factory(ctl);
  ctl.attachStore(w.stores.buyer, "buyer");
  ctl.attachStore(w.stores.seller, "seller");
  const buyer = new BuyerFlow(w.buyerOptions());
  const seller = new SellerFlow(w.sellerOptions());
  const c: Ctx = { w, buyer, seller, history: [buyer, seller] };
  const result: RunResult = { world: w, ctx: c, nexts: [], stalled: undefined, deaths: 0, leaks: [], stepAt: [] };
  const skipBelow: Record<Role, number> = { buyer: 0, seller: 0 };

  let i = 0;
  let guard = 0;
  while (i < script.length) {
    if (++guard > 200) throw new Error("matrix runner: the script did not finish in 200 steps");
    const step = script[i] as Step;
    if (step.role !== null && skipBelow[step.role] > i) {
      i += 1;
      continue;
    }
    if (result.stepAt[i] === undefined) result.stepAt[i] = ctl.actions.length;
    let failure: unknown;
    let pendingRetries = 0;
    for (;;) {
      try {
        await step.run(c);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (step.role !== null && !ctl.isDead(step.role) && pendingRetries < MAX_PENDING_RETRIES && (await w.settlePending(step.role, error))) {
          pendingRetries += 1;
          continue;
        }
        break;
      }
    }
    if (step.role !== null && ctl.isDead(step.role)) {
      // The process died during this step (whatever the step then returned or threw). Nothing else happened since.
      result.deaths += 1;
      result.leaks.push(...(await secretLeaks(w)));
      const next = await resumeRole(c, step.role);
      await hooks.afterResume?.(step.role, next, w);
      result.nexts.push({ role: step.role, next, crashedAt: step.name });
      skipBelow[step.role] = rankOf(script, step.role, next);
      continue; // run the same step again unless `next` is past it
    }
    if (failure !== undefined) {
      if (failure instanceof LockPendingError) {
        result.stalled = "lock-pending"; // nothing is locked, nothing more can happen on leg A: the finale is the refund of leg B
        return result;
      }
      if (step === STEPS.refundLegA && failure instanceof Error && /not yet confirmed/.test(failure.message)) {
        result.stalled = "refund-pending"; // leg A stays locked; the Seller's side of the script still runs
        i += 1;
        continue;
      }
      throw failure;
    }
    i += 1;
  }
  return result;
}

/** The stall finale: leg A never locked, leg B waits out its deadline and the Seller takes it back. */
export async function finishStalled(r: RunResult): Promise<void> {
  const c = r.ctx;
  await STEPS.legBRefundTime.run(c);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await STEPS.refundLegB.run(c);
      return;
    } catch (error) {
      if (!c.w.ctl.isDead("seller")) throw error;
      await resumeRole(c, "seller");
    }
  }
}

// --- the secret ---------------------------------------------------------------------------------------------------------

/** The text forms the swap secret takes: `0x` + 64 hex, lowercase and uppercase, and the bare hex. */
export function secretForms(secret: HashLock): string[] {
  const bare = secret.preimage.replace(/^0x/, "");
  return [bare.toLowerCase(), bare.toUpperCase()];
}

export function containsSecret(text: string, secret: HashLock): boolean {
  return secretForms(secret).some((form) => text.includes(form));
}

const decoder = new TextDecoder();

/** Every historical save of a role's store, as text. */
export function storeTexts(store: MemoryFlowStore): string[] {
  return store.saves.map((entry) => decoder.decode(entry.bytes));
}

async function swapRooms(w: World): Promise<string[]> {
  const view = await readSwap(w);
  const rooms = [OFFER_ROOM];
  if (view.acceptA !== undefined) rooms.push(dealRoom(view.acceptA.contract));
  if (view.acceptB !== undefined) rooms.push(dealRoom(view.acceptB.contract));
  return rooms;
}

/** Whether a Seller reveal (leg A) or a Buyer reveal (leg B) is already in the venue: from then on the secret is public by design. */
async function revealPublic(w: World): Promise<boolean> {
  for (const room of await swapRooms(w)) {
    for (const record of await w.venue.read(room)) if (tryDecodeFrame(record.line)?.type === "reveal") return true;
  }
  return false;
}

/** Where the secret is found although it is still private (no reveal posted): the venue rooms, the leg B note, any Buyer record. */
export async function secretLeaks(w: World): Promise<string[]> {
  if (await revealPublic(w)) return [];
  const leaks: string[] = [];
  for (const room of await swapRooms(w)) {
    for (const record of await w.venue.read(room)) if (containsSecret(record.line, w.hashLock)) leaks.push(`venue ${room} seq ${record.seq}`);
  }
  const view = await readSwap(w);
  if (view.acceptB !== undefined) {
    const note = await w.paper.read(view.acceptB.contract);
    if (note !== null && containsSecret(JSON.stringify(note), w.hashLock)) leaks.push("the leg B note");
  }
  storeTexts(w.stores.buyer).forEach((text, index) => {
    if (containsSecret(text, w.hashLock)) leaks.push(`buyer store save ${index + 1}`);
  });
  return leaks;
}

// --- the oracle ---------------------------------------------------------------------------------------------------------

export type Expected = "settled" | "refunded-both" | "never-locked" | "refund-stuck";

export interface FrameCounts {
  [type: string]: number;
}

export async function frameCounts(w: World, room: string): Promise<FrameCounts> {
  const out: FrameCounts = {};
  for (const record of await w.venue.read(room)) {
    const type = tryDecodeFrame(record.line)?.type ?? "line";
    out[type] = (out[type] ?? 0) + 1;
  }
  return out;
}

export interface Findings {
  /** A failed expectation, as a sentence; the test prints these. Empty = the run is right. */
  problems: string[];
  counts: ChainCounts;
  rooms: { offers: FrameCounts; a: FrameCounts; b: FrameCounts };
  nextAfter: { buyer: string; seller: string };
}

/**
 * What the world looks like after a run, checked against `expected`. Every claim is a counter or a read of the venue or the chain,
 * never a flow's own report: one leg-A lock, one landed claim, at most one refund build on Bitcoin, each frame type exactly once per
 * contract, every deal-room record accepted by tclk's own fold, the two parties' account lines each once and before the lock frame,
 * both flows at "done" when resumed from their stores, and the secret only in the Seller's record.
 */
export async function inspectRun(r: RunResult, expected: Expected): Promise<Findings> {
  const w = r.world;
  const problems: string[] = [];
  const view = await readSwap(w);
  const counts = w.counts();
  const roomA = view.acceptA === undefined ? undefined : dealRoom(view.acceptA.contract);
  const roomB = view.acceptB === undefined ? undefined : dealRoom(view.acceptB.contract);
  const empty: FrameCounts = {};
  const rooms = {
    offers: await frameCounts(w, OFFER_ROOM),
    a: roomA === undefined ? empty : await frameCounts(w, roomA),
    b: roomB === undefined ? empty : await frameCounts(w, roomB),
  };
  const expect = (label: string, actual: unknown, wanted: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) problems.push(`${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  };

  // the offers room: the two offers and the two accepts, once each
  expect("offers room", rooms.offers, { offer: 2, accept: 2 });

  // the chain
  const wantCounts: Record<Expected, Omit<ChainCounts, "refundBuilds">> = {
    settled: { locks: 1, claims: 1, refunds: 0 },
    "refunded-both": { locks: 1, claims: 0, refunds: 1 },
    "never-locked": { locks: 0, claims: 0, refunds: 0 },
    "refund-stuck": { locks: 1, claims: 0, refunds: 0 },
  };
  expect("chain sends", { locks: counts.locks, claims: counts.claims, refunds: counts.refunds }, wantCounts[expected]);
  if (counts.refundBuilds > (w.maxRefundBuilds ?? counts.refunds + 1)) problems.push(`refund builds: ${counts.refundBuilds} built for ${counts.refunds} sent (limit ${w.maxRefundBuilds ?? counts.refunds + 1})`);

  // the deal rooms, frame by frame
  const wantA: Record<Expected, FrameCounts> = {
    settled: { line: 2, lock: 1, reveal: 1, receipt: 1 },
    "refunded-both": { line: 2, lock: 1, refund: 1, receipt: 1 },
    "never-locked": { line: 2 },
    "refund-stuck": { line: 2, lock: 1 },
  };
  const wantB: Record<Expected, FrameCounts> = {
    settled: { lock: 1, reveal: 1, receipt: 1 },
    "refunded-both": { lock: 1, refund: 1, receipt: 1 },
    "never-locked": { lock: 1, refund: 1, receipt: 1 },
    "refund-stuck": { lock: 1, refund: 1, receipt: 1 },
  };
  expect("deal room A", sortKeys(rooms.a), sortKeys(wantA[expected]));
  expect("deal room B", sortKeys(rooms.b), sortKeys(wantB[expected]));

  // tclk's own fold accepts every step (a duplicated frame would be a rejected step) and ends where the swap should
  const statusA: Record<Expected, string> = { settled: "claimed", "refunded-both": "refunded", "never-locked": "accepted", "refund-stuck": "locked" };
  const statusB: Record<Expected, string> = { settled: "claimed", "refunded-both": "refunded", "never-locked": "refunded", "refund-stuck": "refunded" };
  if (view.offerARecord !== undefined && view.acceptARecord !== undefined && roomA !== undefined) {
    const folded = foldTranscript([view.offerARecord, view.acceptARecord, ...(await w.venue.read(roomA))]);
    expect("leg A status", folded.state?.status, statusA[expected]);
    const rejected = folded.steps.filter((step) => !step.ok && step.type !== undefined).map((step) => `${step.type}@${step.seq}`);
    expect("leg A rejected steps", rejected, []);
  }
  if (view.offerBRecord !== undefined && view.acceptBRecord !== undefined && view.acceptB !== undefined && roomB !== undefined) {
    const folded = foldTranscript([view.offerBRecord, view.acceptBRecord, ...(await w.venue.read(roomB))]);
    expect("leg B status", folded.state?.status, statusB[expected]);
    const rejected = folded.steps.filter((step) => !step.ok && step.type !== undefined).map((step) => `${step.type}@${step.seq}`);
    expect("leg B rejected steps", rejected, []);
    const note = await w.paper.read(view.acceptB.contract);
    expect("leg B note", note?.status, expected === "settled" ? "claimed" : "refunded");
  }

  // the account lines: one per party, both before the lock frame (a line after it would not count)
  if (roomA !== undefined) {
    const records = await w.venue.read(roomA);
    const lockSeq = records.find((record) => tryDecodeFrame(record.line)?.type === "lock")?.seq ?? Number.POSITIVE_INFINITY;
    for (const role of ["buyer", "seller"] as const) {
      const lines = records.filter((record) => record.sender === w.dids[role] && tryDecodeFrame(record.line) === null);
      expect(`${role} account lines`, lines.length, 1);
      if (lines.some((record) => record.seq > lockSeq)) problems.push(`${role} posted an account line after the lock frame`);
    }
  }

  // the stores: one record per role under its own key and nothing else; both flows resumed from them are at "done"; only the Seller's
  // record holds the secret
  expect("buyer store keys", await w.stores.buyer.list(), [flowKey("buyer", w.swapId)]);
  expect("seller store keys", await w.stores.seller.list(), [flowKey("seller", w.swapId)]);
  const nextAfter = { buyer: "", seller: "" };
  nextAfter.buyer = (await BuyerFlow.resume({ ...w.buyerOptions(), store: w.stores.buyer, swapId: w.swapId })).next;
  nextAfter.seller = (await SellerFlow.resume({ ...w.sellerOptions(), store: w.stores.seller, swapId: w.swapId })).next;
  const wantNext =
    expected === "never-locked" ? { buyer: "lockLegA", seller: "done" } : expected === "refund-stuck" ? { buyer: "refundLegA", seller: "done" } : { buyer: "done", seller: "done" };
  expect("next after the run", nextAfter, wantNext);

  const sellerRecord = decodeFlowRecord((await w.stores.seller.load(flowKey("seller", w.swapId)))!, flowKey("seller", w.swapId));
  if (sellerRecord.role !== "seller" || sellerRecord.preimage !== w.hashLock.preimage) problems.push("the Seller's record does not hold the secret");
  if (!storeTexts(w.stores.seller).some((text) => containsSecret(text, w.hashLock))) problems.push("the secret form check is blind: the Seller's own saves do not show it");
  storeTexts(w.stores.buyer).forEach((text, index) => {
    if (containsSecret(text, w.hashLock)) problems.push(`the secret is in the Buyer's store save ${index + 1}`);
  });
  for (const flow of r.ctx.history) {
    const forms = [JSON.stringify(flow), inspect(flow, { depth: 6 }), inspect(flow, { depth: 6, showHidden: true })];
    if (forms.some((text) => containsSecret(text, w.hashLock))) problems.push(`the secret shows in JSON.stringify or util.inspect of a ${flow instanceof BuyerFlow ? "Buyer" : "Seller"}`);
  }
  for (const leak of r.leaks) problems.push(`the secret was outside the Seller's record while still private: ${leak}`);

  return { problems, counts, rooms, nextAfter };
}

function sortKeys(counts: FrameCounts): FrameCounts {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
