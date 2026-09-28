// SPDX-License-Identifier: MIT
//
// The "assemble inputs → evidence → buildBoard" step, factored out of `src/watcher.ts` so a
// live sweep and an offline replay (`examples/audit-export.mjs`) share exactly one code
// path and can never silently diverge (P05-SPEC.md deliverable 3). Everything here is pure
// over already-collected bytes: no fetch, no clock read. `findSwapLegCandidates` is also
// reused by the watcher itself, to decide which deal rooms and paper notes are worth
// fetching in the first place.
//
// P22-P24-EVM-FIXES.md A6 (deliberate behaviour change, 2026-09-28): `foldCaptured` dispatches
// on the lock rail/ref the tclk contract machine actually *accepted* for a leg
// (`foldAcceptedLock` below: `foldTranscript` of the leg's own offer → accept → deal room, the
// same records `src/board.ts`'s `buildLegRecords`/`src/swap.ts`'s `foldSwap` already fold) —
// never "the first structurally-authenticated lock frame from the leg's payer", which is all
// `findAuthenticatedLock` checks. A frame the machine itself rejected (its declared rail was
// never offered, its sender isn't this leg's own payer, the refund window was already open
// when it arrived, a duplicate lock attempt after the first one already succeeded, …) can no
// longer be picked up as evidence just because it happened to be authenticated and came first
// in room order, and a payer's later, corrected frame is never shadowed by an earlier bad one.
// This changes the no-rails-configured board in the edge case where the previous code let a
// frame the machine would have rejected stand in as "the" lock (a latent false `a-locked`);
// every other behaviour (the paper-only fold with no `evm-htlc` involved, and the whole
// dispatch when `input.rails`/`input.chain` are absent) is unchanged and still pinned by
// `tests/replay.test.ts`'s "no rails configured" case and the 2026-09-18 rehearsal fixture.

import {
  dealRoom,
  foldTranscript,
  paperNote,
  tryDecodeFrame,
  verifyTranscriptRecord,
  OFFER_ROOM,
  type AcceptFrame,
  type LockFrame,
  type OfferFrame,
  type TclkFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";

import { buildBoard as defaultBuildBoard } from "./board.js";
import { paperEvidence, stripNoteBanner, PAPER_RAIL_ID } from "./paper-evidence.js";
import { classifySwapOffer } from "./profile.js";
import { resolveAccounts, resolvePubkeys } from "./rails/account-line.js";
import { btcEvidence, BTC_RAIL_ID, type BtcCapture } from "./rails/btc-evidence.js";
import { checkBtcRailConfig, type BtcRailConfig } from "./rails/btc-htlc.js";
import { evmEvidence, EVM_RAIL_ID, type EvmCapture } from "./rails/evm-evidence.js";
import { checkEvmRailConfig, type EvmRailConfig } from "./rails/evm-htlc.js";
import { offerAcceptLockTerms } from "./swap.js";
import type { Board, BoardInput, LockEvidence, RailObservation, SwapEvidence, SwapLeg } from "./types.js";

// An offer/accept authenticated for the signed lane in tclk-offers (the same checks as
// transcript.ts's private authenticatedFrame, built from the exported primitives only).
function authenticatedOfferRoomFrame(record: TranscriptRecord): TclkFrame | null {
  if (record.room !== OFFER_ROOM || !verifyTranscriptRecord(record).ok) return null;
  const frame = tryDecodeFrame(record.line);
  return frame !== null && frame.from === record.sender ? frame : null;
}

// Same authentication (signed lane, unforged `from`) without the room restriction, for
// scanning a swap's own derived deal room.
function authenticatedFrame(record: TranscriptRecord): TclkFrame | null {
  if (!verifyTranscriptRecord(record).ok) return null;
  const frame = tryDecodeFrame(record.line);
  return frame !== null && frame.from === record.sender ? frame : null;
}

interface SwapLegOffer { seq: number; swapId: string; leg: SwapLeg; offer: OfferFrame; record: TranscriptRecord }

export interface SwapLegCandidate {
  contract: string;
  offerSeq: number;
  /** The accept's own offer-room seq (H2, tclk#181) — alongside `offerSeq`, the pair a
   *  caller needs to archive this leg's exact offer-room lines byte-for-byte before the
   *  venue's ring rolls past them. */
  acceptSeq: number;
  swapId: string;
  leg: SwapLeg;
  offer: OfferFrame;
  accept: AcceptFrame;
  /** A6: the raw signed records behind `offer`/`accept` — needed to re-fold this leg's own
   *  transcript (offer → accept → its deal room) through tclk's `foldTranscript` and learn
   *  which lock frame the contract machine actually accepted (`foldAcceptedLock` below), never
   *  merely "the first structurally-authenticated one" `findAuthenticatedLock` would find. */
  offerRecord: TranscriptRecord;
  acceptRecord: TranscriptRecord;
}

/**
 * Which contracts' deal rooms (and, transitively, paper notes) are worth polling or
 * replaying: authenticated offers that declare themselves a swap leg (SPEC §3.3), matched
 * to their authenticated accept for the contract id. Ordered by the offer's own seq (it
 * always precedes the accept), so a caller's cap keeps the earliest bids. Carries the
 * offer/accept frames along too, so a paper note's terms (offer.lock, offer.refundAfterMs,
 * accept.statement) and the candidate's swapId/leg (for `BoardInput.evidence`) never need a
 * second pass over the export.
 *
 * Single pass over `offerRoomRecords`, in order: authenticates (and Ed25519-verifies) each
 * record exactly once, same as `src/board.ts`'s own `authenticateOffers`/pairing already
 * does — an accept is only matched if its offer already appeared earlier in `offerRoomRecords`,
 * which is always true for real venue traffic (an accept can only name an offer id that
 * already exists) and for any caller here (the live watcher's export order; the offline
 * replay's `loadOffers`, which explicitly seq-sorts before returning). A two-pass version
 * that re-verified every record for each pass was the actual cost behind a slow replay
 * against a watch root accumulating many overlapping exports — Ed25519 verification, not
 * JSON parsing, dominates at that scale.
 */
export function findSwapLegCandidates(offerRoomRecords: readonly TranscriptRecord[]): {
  candidates: SwapLegCandidate[];
  swapLegOffers: number;
} {
  const swapLegOfferIds = new Map<string, SwapLegOffer>(); // offer id -> {seq, swapId, leg, offer}
  const byContract = new Map<string, SwapLegCandidate>();

  for (const record of offerRoomRecords) {
    const frame = authenticatedOfferRoomFrame(record);
    if (frame === null) continue;

    if (frame.type === "offer") {
      const classification = classifySwapOffer(frame);
      if (classification === null) continue;
      swapLegOfferIds.set(frame.id, {
        seq: record.seq,
        swapId: classification.swapId,
        leg: classification.context.leg,
        offer: frame,
        record,
      });
      continue;
    }

    if (frame.type === "accept") {
      const legOffer = swapLegOfferIds.get(frame.ref);
      if (legOffer === undefined) continue;
      const existing = byContract.get(frame.contract);
      if (existing === undefined || legOffer.seq < existing.offerSeq) {
        byContract.set(frame.contract, {
          contract: frame.contract,
          offerSeq: legOffer.seq,
          acceptSeq: record.seq,
          swapId: legOffer.swapId,
          leg: legOffer.leg,
          offer: legOffer.offer,
          accept: frame,
          offerRecord: legOffer.record,
          acceptRecord: record,
        });
      }
    }
  }

  return {
    candidates: [...byContract.values()].sort((a, b) => a.offerSeq - b.offerSeq),
    swapLegOffers: swapLegOfferIds.size,
  };
}

/**
 * True iff a candidate's own deal room carries an authenticated paper-rail lock for its own
 * contract — `{type:"lock", contract, rail:"paper", ref:contract}`, the convention the live
 * G0 rehearsal used (P05-SPEC.md "Live facts": the paper rail's `ref` is the contract id
 * itself, since `paperNote()` is keyed by contract, not a separate escrow id).
 */
export function hasAuthenticatedPaperLock(records: readonly TranscriptRecord[], contract: string): boolean {
  return records.some((record) => {
    const frame = authenticatedFrame(record);
    return (
      frame !== null &&
      frame.type === "lock" &&
      frame.contract === contract &&
      frame.rail === PAPER_RAIL_ID &&
      frame.ref === contract
    );
  });
}

/**
 * P22-P24-EVM-SPEC.md §5's payer-only rule, generalised over every rail: the authenticated
 * `lock` frame for `contract`, posted by its own leg's payer and no one else — only the party
 * who actually escrows a leg's funds can post the frame that says it is locked, so a
 * `verifyTranscriptRecord`-clean frame signed by anyone else (the payee, a stranger who
 * guessed the deal room) is not evidence of anything and must not be picked up as one.
 * `null` when no such record exists.
 *
 * P22-P24-EVM-FIXES.md A6: this only checks that a frame is *authenticated* — signed, right
 * contract, right sender — never whether tclk's own contract machine actually accepted it as
 * the lock (the declared rail may never have been offered, the refund window may already have
 * been open, a duplicate attempt may have arrived after the first lock already succeeded, …).
 * `foldCaptured` below and `src/watcher.ts`'s fetch decision no longer use this for evidence
 * dispatch — see `foldAcceptedLock` — but it is kept, and still exported, as the lower-level
 * "is there any authenticated lock frame at all" primitive a caller might still want.
 */
export function findAuthenticatedLock(
  records: readonly TranscriptRecord[],
  contract: string,
  payerDid: string,
): LockFrame | null {
  for (const record of records) {
    const frame = authenticatedFrame(record);
    if (frame !== null && frame.type === "lock" && frame.contract === contract && record.sender === payerDid) {
      return frame;
    }
  }
  return null;
}

/** The lock rail/ref `foldAcceptedLock` found the tclk contract machine actually accepted for
 *  a leg. */
export interface AcceptedLock {
  rail: string;
  railRef: string;
  /** P4-BTC-FIXES.md G1/G8: the venue `seq` (within the leg's own deal room) of the one record
   *  that transitioned the contract machine to `"locked"` — `vendor/tclk/src/machine.ts`'s own
   *  `"lock"` case accepts at most one such frame per contract (a second attempt is rejected
   *  outright, `state.status !== "accepted"`), so this is unambiguous whenever `foldAcceptedLock`
   *  itself returns non-null. `SellerFlow.claimLegA` uses it to bound its own pubkey/account-line
   *  resolution to lines posted strictly before this point (G1: "count only lines posted before
   *  the accepted lock frame") and, for a `btc-htlc` leg, as the trustworthy source of the
   *  funding outpoint (G8). */
  seq: number;
}

/**
 * P22-P24-EVM-FIXES.md A6: the lock rail/ref the tclk contract machine *actually accepted* for
 * this leg — never merely "the first frame that looks authenticated for the right contract
 * from the right payer" (`findAuthenticatedLock`'s only check). Folds the leg's own transcript
 * exactly the way `src/board.ts`'s `buildLegRecords`/`src/swap.ts`'s `foldSwap` already do for
 * the board's own choreography view — offer, then accept, then every deal-room record, in
 * venue order — through tclk's own `foldTranscript`/`applyFrame` (`vendor/tclk/src/machine.ts`
 * sets `state.rail`/`state.railRef` only on a lock transition it actually accepts, and never
 * clears them on any later valid transition). A frame the machine rejected — its declared rail
 * was never offered, its sender isn't this leg's own payer, the refund window was already open
 * when it arrived, a duplicate lock attempt after the first one already succeeded — leaves
 * `state.rail` exactly as it was, so it can never be picked up here just because it happened to
 * come first in room order; a payer's later, corrected frame is never shadowed by an earlier
 * bad one, since the machine only advances past `"accepted"` on the first frame it actually
 * takes. `null` when the leg's own offer/accept never even fold to a contract (a forged/
 * mismatched accept), or no lock was ever accepted.
 */
export function foldAcceptedLock(
  offerRecord: TranscriptRecord,
  acceptRecord: TranscriptRecord,
  dealRoomRecords: readonly TranscriptRecord[],
): AcceptedLock | null {
  const { state, steps } = foldTranscript([offerRecord, acceptRecord, ...dealRoomRecords]);
  if (state === null || state.rail === undefined || state.railRef === undefined) return null;
  const lockStep = steps.find((step) => step.ok && step.type === "lock");
  if (lockStep === undefined) return null; // unreachable given state.rail is set, kept defensively
  return { rail: state.rail, railRef: state.railRef, seq: lockStep.seq };
}

/** One captured paper-rail note: its raw `/kv` body (banner included) and the endpoint it
 *  was (or, for a replay, would have been) read from — carried through into `LockEvidence
 *  .endpoint` so an audit trail names its source either way. */
export interface CapturedNote {
  body: string;
  endpoint: string;
}

export interface FoldCapturedInput {
  offers: readonly TranscriptRecord[];
  /** Deal-room records keyed by room name, exactly like `BoardInput.dealRooms`. */
  dealRooms: ReadonlyMap<string, readonly TranscriptRecord[]>;
  /** Captured paper notes keyed by the contract id they were fetched (or read) for. A
   *  swap-leg candidate with an authenticated paper lock but no entry here gets no
   *  evidence for that leg — identical treatment whether the note 404'd, failed some other
   *  way, or (in a replay) was never captured. */
  notes: ReadonlyMap<string, CapturedNote>;
  /** P22-P24-EVM-SPEC.md §5: captured EVM chain reads, keyed by hashLock — an `evm-htlc`
   *  lock frame's own `.ref`, which must equal the leg's `terms.statement` to be picked up at
   *  all (§2.2 point 3). A candidate whose deal room shows an authenticated `evm-htlc` lock
   *  but has no entry here gets no evidence for that leg, the same treatment as a paper
   *  candidate with no captured note — whether it was never captured, or a replay simply
   *  didn't have it on disk. Absent entirely behaves exactly like an empty map. */
  chain?: ReadonlyMap<string, EvmCapture>;
  /** P4-BTC-SPEC.md §7: captured Bitcoin chain reads, keyed by the funding outpoint (a
   *  `btc-htlc` lock frame's own `.ref`, `"<txid>:<vout>"` — unlike `chain` above, this is
   *  never derived from `terms`, since a Bitcoin outpoint is chosen at fund time, not committed
   *  in the offer/accept). A candidate whose deal room shows an accepted `btc-htlc` lock but has
   *  no entry here gets no evidence for that leg, the same treatment as every other captured-but-
   *  absent case in this file. Absent entirely behaves exactly like an empty map. */
  btcChain?: ReadonlyMap<string, BtcCapture>;
  /** The chain rails this fold may draw evidence from. Absent (the default — and what the
   *  live watch passes when it isn't given `RunSweepOptions.rails`): neither the `evm-htlc` nor
   *  the `btc-htlc` branch below ever runs, so `foldCaptured` is exactly the paper-only fold it
   *  always was, byte-for-byte (tests/replay.test.ts's "no rails configured" cases pin this). */
  rails?: { evm?: EvmRailConfig; btc?: BtcRailConfig };
  nowMs: number;
  board?: (input: BoardInput) => Board;
}

/**
 * The shared fold: candidates → rail evidence → `buildBoard`. A live sweep
 * (`src/watcher.ts`) and an offline replay (`examples/audit-export.mjs`) both call this after
 * collecting their own bytes, so they can never fold differently.
 *
 * For each candidate, `foldAcceptedLock` (A6) folds the leg's own offer → accept → deal room
 * through tclk's contract machine and dispatches on the lock rail/ref it actually *accepted* —
 * never merely the first authenticated-looking lock frame in room order (P22-P24-EVM-SPEC.md
 * §5, as tightened by P22-P24-EVM-FIXES.md A6): `paper` (`railRef === contract`, tclk's
 * convention) → today's paper path, reading the captured note the same way it always has;
 * `evm-htlc` (`railRef === terms.statement`, the hashLock) → `evmEvidence`, but only when a
 * chain rail is configured (`input.rails.evm`, itself validated once per fold — A3 — so a
 * malformed config never silently reaches the decoder) AND a capture exists for that hashLock
 * (`input.chain`) — accounts are resolved fresh from the same deal room with `resolveAccounts`,
 * never cached across candidates, since each leg's own deal room is the only room its account
 * lines can be posted in; anything else (an unrecognised rail, or a rail/ref combination this
 * build has no reader for) gets no evidence, exactly like no lock having been accepted at all.
 */
export function foldCaptured(input: FoldCapturedInput): Board {
  const buildBoardFn = input.board ?? defaultBuildBoard;
  const { candidates } = findSwapLegCandidates(input.offers);
  const evidenceBySwap = new Map<string, SwapEvidence>();
  const evmConfig = input.rails?.evm;
  // A3: validated once per fold, not once per candidate — every entry point a rail config can
  // reach this from (a live sweep's `--rails` file, a replayed `rails.json`) is untrusted data,
  // so a malformed config never silently reaches `evmEvidence`; it fails every `evm-htlc` leg
  // closed instead, each with the same specific reason.
  const evmConfigCheck = evmConfig === undefined ? null : checkEvmRailConfig(evmConfig);
  // P4-BTC-SPEC.md §7: the `btc-htlc` twin of the above — validated once per fold, same A3 rule.
  const btcConfig = input.rails?.btc;
  const btcConfigCheck = btcConfig === undefined ? null : checkBtcRailConfig(btcConfig);

  for (const candidate of candidates) {
    const room = dealRoom(candidate.contract);
    const dealRoomRecords = input.dealRooms.get(room) ?? [];
    // Full nine-field LockTerms (H1, tclk#180), from the authenticated offer/accept pair
    // itself — never from the deal room or a rail's own record, both world-writable.
    const terms = offerAcceptLockTerms(candidate.offer, candidate.accept);
    const accepted = foldAcceptedLock(candidate.offerRecord, candidate.acceptRecord, dealRoomRecords);
    if (accepted === null) continue; // no lock the tclk machine actually accepted: no evidence

    let result: { lock: LockEvidence; rail?: RailObservation } | undefined;

    if (accepted.rail === PAPER_RAIL_ID && accepted.railRef === candidate.contract) {
      const captured = input.notes.get(candidate.contract);
      if (captured === undefined) continue; // not fetched/not found: evidence absent
      const noteValue = stripNoteBanner(captured.body);
      result = paperEvidence(terms, noteValue, input.nowMs, captured.endpoint);
    } else if (accepted.rail === EVM_RAIL_ID && accepted.railRef === terms.statement) {
      if (evmConfigCheck === null) continue; // no chain rail configured: no evidence at all
      if (!evmConfigCheck.ok) {
        // A3: a bad config fails every evm-htlc leg closed, with the specific reason — never
        // silently "no evidence" (which would look identical to "nothing captured yet").
        result = {
          lock: {
            rail: EVM_RAIL_ID,
            ref: accepted.railRef,
            terms,
            railVerified: null,
            checkedAtMs: input.nowMs,
            reason: `evm-htlc: rail config invalid: ${evmConfigCheck.reason}`,
          },
        };
      } else {
        const capture = input.chain?.get(accepted.railRef);
        if (capture === undefined) continue; // not captured (yet, or ever): evidence absent
        const accounts = resolveAccounts(dealRoomRecords, {
          contract: candidate.contract,
          payerDid: terms.payer,
          payeeDid: terms.payee,
          rail: EVM_RAIL_ID,
          caip2: evmConfigCheck.config.pin.caip2,
        });
        // D4 (P22-P24-EVM-FIXES-R2.md): a backstop, not the primary defense — `evmEvidence`
        // validates every address-shaped field it reads off captured data before it can ever
        // throw over one, but this call sits inside a loop that folds *every* candidate in one
        // pass, so an unanticipated throw here (a bug neither of us found yet) must still fail
        // only this one leg closed, never the whole replay and every other swap in it.
        try {
          result = evmEvidence({ terms, config: evmConfigCheck.config, accounts, capture });
        } catch (error) {
          result = {
            lock: {
              rail: EVM_RAIL_ID,
              ref: accepted.railRef,
              terms,
              railVerified: null,
              checkedAtMs: input.nowMs,
              reason: `evm-htlc: evidence check threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      }
    } else if (accepted.rail === BTC_RAIL_ID) {
      // P4-BTC-SPEC.md §7: unlike paper/evm-htlc above, `accepted.railRef` (the funding
      // outpoint) is never derived from `terms` — it is chosen at fund time — so there is no
      // equality check to gate dispatch on here; `btcEvidence` itself checks the rebuilt
      // script/amount against `terms`/`accounts` once a capture is found.
      if (btcConfigCheck === null) continue; // no chain rail configured: no evidence at all
      if (!btcConfigCheck.ok) {
        // A3 (mirrored for Bitcoin): a bad config fails every btc-htlc leg closed, with the
        // specific reason — never silently "no evidence".
        result = {
          lock: {
            rail: BTC_RAIL_ID,
            ref: accepted.railRef,
            terms,
            railVerified: null,
            checkedAtMs: input.nowMs,
            reason: `btc-htlc: rail config invalid: ${btcConfigCheck.reason}`,
          },
        };
      } else {
        const capture = input.btcChain?.get(accepted.railRef);
        if (capture === undefined) continue; // not captured (yet, or ever): evidence absent
        // P4-BTC-SPEC.md §6: a P2WSH script commits to BOTH parties' pubkeys, unlike the
        // account line's single-address resolution for evm-htlc — resolved fresh from the same
        // deal room with `resolvePubkeys`, never cached across candidates.
        //
        // P4-BTC-FIXES-R2.md R2-3: `beforeSeq: accepted.seq` — the same "only lines posted
        // before the accepted lock frame" rule the client flows have applied since G1 — so a
        // pubkey line posted AFTER the lock the tclk machine actually accepted can neither newly
        // resolve nor conflict-and-unresolve a party's pubkey on replay, exactly as it already
        // cannot for the live client flows themselves.
        const pubkeys = resolvePubkeys(dealRoomRecords, {
          contract: candidate.contract,
          payerDid: terms.payer,
          payeeDid: terms.payee,
          rail: BTC_RAIL_ID,
          caip2: btcConfigCheck.config.pin.caip2,
          beforeSeq: accepted.seq,
        });
        // D4-style defense in depth (mirrors the evm-htlc branch above): this call sits inside
        // a loop that folds *every* candidate in one pass, so an unanticipated throw here must
        // still fail only this one leg closed, never the whole replay.
        try {
          result = btcEvidence({
            terms,
            config: btcConfigCheck.config,
            accounts: {
              ...(pubkeys.payer === undefined ? {} : { payerPubkey: pubkeys.payer }),
              ...(pubkeys.payee === undefined ? {} : { payeePubkey: pubkeys.payee }),
            },
            capture,
          });
        } catch (error) {
          result = {
            lock: {
              rail: BTC_RAIL_ID,
              ref: accepted.railRef,
              terms,
              railVerified: null,
              checkedAtMs: input.nowMs,
              reason: `btc-htlc: evidence check threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
            },
          };
        }
      }
    } else {
      continue; // an unrecognised rail, or a rail this build has no evidence reader for
    }

    const entry: SwapEvidence = evidenceBySwap.get(candidate.swapId) ?? {};
    if (candidate.leg === "a") {
      entry.a = result.lock;
      if (result.rail !== undefined) entry.aRail = result.rail;
    } else {
      entry.b = result.lock;
      if (result.rail !== undefined) entry.bRail = result.rail;
    }
    evidenceBySwap.set(candidate.swapId, entry);
  }

  return buildBoardFn({
    offers: input.offers,
    dealRooms: input.dealRooms,
    evidence: evidenceBySwap,
    nowMs: input.nowMs,
  });
}

/** Where `paperNote(contract)` puts a note on disk under a watch root: `raw/kv/<ns>/<key>`. */
export function noteDir(contract: string): { ns: string; key: string; dir: string } {
  const { ns, key } = paperNote(contract);
  return { ns, key, dir: `raw/kv/${ns}/${key}` };
}
