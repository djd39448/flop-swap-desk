// SPDX-License-Identifier: MIT
//
// src/client/flop-chain-guard.ts — two refusals read from the FLOP chain, applied by the Seller right before it locks the FLOP leg
// (leg B). Both come from the yellow paper sync of 2026-10-13 (flop-contrib handoff/YELLOWPAPER-SYNC-2026-10-13-IMPACT.md, sections 2 and 3)
// and were approved by Dave on 2026-10-17.
//
//   finality-open gate  The paper's timelock-symmetry rule (R10.2) now says a cross-chain HTLC open is rejected on chain while the finality lag
//                       (blocks between the head and the finalized prefix) is at or above `finality_freeze_threshold`, 120 blocks. Asking first
//                       turns a transaction the chain would reject into a plain "try later" before anything is locked.
//   burn-share guard    `htlc_burn_share_ppt` is 0 today; proposal D-0523 (a timeout burn: a refund or claim resolved at or after the deadline
//                       would destroy that share of the locked reward) would let a later runtime upgrade raise it. While it is nonzero the desk
//                       opens no new swap, until Dave decides how a burn is priced. Only the OPENING is refused: a redeem or refund of a lock
//                       that exists is never blocked by this, since refusing it could strand funds.
//
// The desk has no FLOP chain read path yet (the FLOP leg is tclk's `paper` rail; `flop-htlc` is a stub with no RPC), so this is a seam: a
// runner that has a FLOP node passes a `FlopChainGuard` backed by it. With none passed, nothing is checked (today's behaviour). A guard that
// cannot read, or reads nonsense, refuses: an unknown burn share or lag is never treated as safe.

/** The paper's `finality_freeze_threshold`: the finality lag, in blocks, at or above which the chain rejects a new cross-chain HTLC open. */
export const FLOP_FINALITY_FREEZE_THRESHOLD_BLOCKS = 120;

/** What the Seller reads from the FLOP chain immediately before it locks leg B. Both reads are of the FINALIZED view the chain rules use. */
export interface FlopChainGuard {
  /** Blocks by which the head leads the finalized prefix right now (the paper's `current_finality_lag`: `block_number - finalized_number`). */
  finalityLagBlocks(): Promise<number>;
  /** The chain's `htlc_burn_share_ppt`, parts per thousand (0 to 1000). */
  htlcBurnSharePpt(): Promise<number>;
}

export class FlopFinalityStalledError extends Error {
  constructor(readonly lagBlocks: number, readonly thresholdBlocks: number) {
    super(`finality is stalled: the FLOP chain's finality lag is ${lagBlocks} blocks, at or above the ${thresholdBlocks}-block limit past which it rejects a new cross-chain HTLC open; nothing was locked, try again once finality catches up`);
    this.name = "FlopFinalityStalledError";
  }
}

export class FlopBurnShareNonzeroError extends Error {
  constructor(readonly sharePpt: number) {
    super(`the FLOP chain's HTLC timeout-burn share is ${sharePpt} parts per thousand, not zero: a lock resolved at or after its deadline would lose that share of its value, and the desk opens no new swap until that is priced; nothing was locked`);
    this.name = "FlopBurnShareNonzeroError";
  }
}

export class FlopGuardUnreadableError extends Error {
  constructor(what: string, detail: string) {
    super(`cannot read the FLOP chain's ${what} (${detail}); an unknown value is not treated as safe, so nothing was locked`);
    this.name = "FlopGuardUnreadableError";
  }
}

async function readNumber(what: string, read: () => Promise<number>, max: number | undefined): Promise<number> {
  let value: number;
  try {
    value = await read();
  } catch (e) {
    throw new FlopGuardUnreadableError(what, e instanceof Error ? e.message : String(e));
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || (max !== undefined && value > max)) {
    throw new FlopGuardUnreadableError(what, `got ${String(value)}, expected a whole number${max === undefined ? " of at least 0" : ` from 0 to ${max}`}`);
  }
  return value;
}

/** Throws unless a new FLOP-leg HTLC may be opened now: finality lag under the threshold, burn share zero. Reads the lag first. */
export async function assertFlopLockAllowed(guard: FlopChainGuard, thresholdBlocks: number = FLOP_FINALITY_FREEZE_THRESHOLD_BLOCKS): Promise<void> {
  const lag = await readNumber("finality lag", () => guard.finalityLagBlocks(), undefined);
  if (lag >= thresholdBlocks) throw new FlopFinalityStalledError(lag, thresholdBlocks);
  const share = await readNumber("HTLC burn share", () => guard.htlcBurnSharePpt(), 1000);
  if (share !== 0) throw new FlopBurnShareNonzeroError(share);
}
