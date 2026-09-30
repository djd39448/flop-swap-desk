// SPDX-License-Identifier: MIT
//
// R3-1 regression (handoff/P7-ACCOUNT-PROOF-SPEC.md): the mirror-pair attack over each chain's
// committed settled fixture. A stranger builds their own pair of offers and accepts for the
// victim's hash lock (a different contract id per leg, different DIDs), posts the victim's
// account/pubkey lines verbatim as their own parties' lines, names the victim's lock ref in their
// own lock frame, and lets the replay borrow the victim's chain evidence. Before P7 the mirror
// folded to `settled`. Now the victim's lines are proofs for the victim's DIDs and contracts, so
// the mirror's lines do not resolve, its chain leg does not verify, and the victim still settles.
//
// Hermetic: the fixtures are the committed recaptures (npm test builds dist/ first, which the
// audit-export loaders import).

import { join } from "node:path";

import {
  OFFER_ROOM,
  dealRoom,
  encodeFrame,
  makeAccept,
  makeOffer,
  type AcceptFrame,
  tryDecodeFrame,
  type OfferFrame,
  type TranscriptRecord,
} from "@flop-labs/tclk";
import { describe, expect, it } from "vitest";

import { legBContext, swapId as computeSwapId } from "../src/profile.js";
import { resolveAccounts, resolvePubkeys } from "../src/rails/account-line.js";
import { foldAcceptedLock, findSwapLegCandidates, foldCaptured, type SwapLegCandidate } from "../src/replay.js";
import { pairKey } from "../src/swap.js";
import { identity, record } from "./helpers/identity.js";
// @ts-expect-error plain .mjs, no type declarations
import { loadBtcCaptures, loadDealRooms, loadEvmCaptures, loadNearCaptures, loadNotes, loadOffers, loadRails } from "../examples/audit-export.mjs";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const mirrorBuyer = identity("a7".repeat(32));
const mirrorSeller = identity("b8".repeat(32));

interface Loaded {
  offers: TranscriptRecord[];
  dealRooms: Map<string, TranscriptRecord[]>;
  notes: Map<string, { body: string; endpoint: string }>;
  chain: Map<string, unknown>;
  btcChain: Map<string, unknown>;
  nearChain: Map<string, unknown>;
  rails: { evm?: { pin: { caip2: string } }; btc?: { pin: { caip2: string } }; near?: { pin: { caip2: string } } };
}

async function load(dir: string): Promise<Loaded> {
  const root = join(FIXTURES, dir);
  const { records: offers } = loadOffers(root);
  return {
    offers,
    dealRooms: loadDealRooms(root),
    notes: loadNotes(root, offers),
    chain: await loadEvmCaptures(root),
    btcChain: await loadBtcCaptures(root),
    nearChain: await loadNearCaptures(root),
    rails: loadRails(root),
  };
}

/** A stranger's copy of one victim leg: same terms, same hash lock, stranger DIDs, fresh nonces. */
function mirrorOffer(victim: OfferFrame, from: string, jobId: string, context: string, nonce: string): OfferFrame {
  return makeOffer({
    from,
    role: victim.role,
    amount: victim.amount,
    asset: victim.asset,
    lock: victim.lock,
    rails: victim.rails,
    claimByMs: victim.claimByMs,
    refundAfterMs: victim.refundAfterMs,
    expiresMs: victim.expiresMs,
    job: { proto: "swap", id: jobId, context },
    nonce,
  });
}

interface Attack {
  offers: TranscriptRecord[];
  dealRooms: Map<string, TranscriptRecord[]>;
  notes: Map<string, { body: string; endpoint: string }>;
  mirrorSwapId: string;
  mirrorA: SwapLegCandidateLike;
  mirrorB: SwapLegCandidateLike;
  mirrorRoomA: TranscriptRecord[];
  victimA: SwapLegCandidate;
  victimB: SwapLegCandidate;
  victimSwapId: string;
  acceptedSeqA: number;
}
type SwapLegCandidateLike = { contract: string; offer: OfferFrame; accept: AcceptFrame };

function buildAttack(loaded: Loaded): Attack {
  const { candidates } = findSwapLegCandidates(loaded.offers);
  const victimA = candidates.find((c) => c.leg === "a");
  const victimB = candidates.find((c) => c.leg === "b");
  if (victimA === undefined || victimB === undefined) throw new Error("fixture has no complete victim pair");

  const maxSeq = Math.max(...loaded.offers.map((r) => r.seq));
  const t = Math.max(...loaded.offers.map((r) => r.timestampMs)) + 1_000;

  const mirrorSwapId = computeSwapId(mirrorBuyer.did, "00000000000000e1");
  const offerA = mirrorOffer(victimA.offer, mirrorBuyer.did, mirrorSwapId, victimA.offer.job!.context, "e1e1e1e1e1e1e1e1");
  const acceptA = makeAccept(offerA, { from: mirrorSeller.did, statement: victimA.accept.statement, nonce: "e2e2e2e2e2e2e2e2" });
  const offerB = mirrorOffer(victimB.offer, mirrorSeller.did, mirrorSwapId, legBContext(offerA.id), "e3e3e3e3e3e3e3e3");
  const acceptB = makeAccept(offerB, { from: mirrorBuyer.did, statement: victimA.accept.statement, nonce: "e4e4e4e4e4e4e4e4" });

  const offers = [
    ...loaded.offers,
    record(OFFER_ROOM, maxSeq + 1, t, mirrorBuyer, encodeFrame(offerA)),
    record(OFFER_ROOM, maxSeq + 2, t + 1, mirrorSeller, encodeFrame(acceptA)),
    record(OFFER_ROOM, maxSeq + 3, t + 2, mirrorSeller, encodeFrame(offerB)),
    record(OFFER_ROOM, maxSeq + 4, t + 3, mirrorBuyer, encodeFrame(acceptB)),
  ];

  // The victim's leg A room: its accepted lock (for the ref the mirror will borrow).
  const victimRoomA = loaded.dealRooms.get(dealRoom(victimA.contract)) ?? [];
  const victimRoomB = loaded.dealRooms.get(dealRoom(victimB.contract)) ?? [];
  const victimLock = foldAcceptedLock(victimA.offerRecord, victimA.acceptRecord, victimRoomA);
  if (victimLock === null) throw new Error("fixture's victim leg A has no accepted lock");

  // The stranger re-posts EVERY victim record in order as its own party's record (same seqs, same
  // relative timing): the account/pubkey lines verbatim, and each tclk frame with the mirror's
  // contract and DID. The lock frame names the same chain lock ref. This is the whole attack.
  const dids = new Map<string, (typeof mirrorBuyer)>([
    [victimA.offer.from, mirrorBuyer], // the Buyer (leg A payer)
    [victimA.accept.from, mirrorSeller], // the Seller (leg A payee)
  ]);
  function mirrorRoom(victimRoom: readonly TranscriptRecord[], victimContract: string, mirrorContract: string): TranscriptRecord[] {
    return victimRoom.map((r) => {
      const signer = dids.get(r.sender);
      if (signer === undefined) throw new Error("a victim record from a third party");
      const frame = tryDecodeFrame(r.line);
      let line = r.line;
      if (frame !== null) {
        const mapped: Record<string, unknown> = { ...frame, contract: mirrorContract, from: signer.did };
        if (mapped.ref === victimContract) mapped.ref = mirrorContract; // a paper lock's ref is its contract
        line = encodeFrame(mapped as never);
      }
      return record(dealRoom(mirrorContract), r.seq, r.timestampMs + 1, signer, line);
    });
  }
  const mirrorRoomA = mirrorRoom(victimRoomA, victimA.contract, acceptA.contract);
  const mirrorRoomB = mirrorRoom(victimRoomB, victimB.contract, acceptB.contract);
  void t;

  const dealRooms = new Map(loaded.dealRooms);
  dealRooms.set(dealRoom(acceptA.contract), mirrorRoomA);
  dealRooms.set(dealRoom(acceptB.contract), mirrorRoomB);
  const notes = new Map(loaded.notes);
  const victimNote = loaded.notes.get(victimB.contract);
  if (victimNote !== undefined) notes.set(acceptB.contract, victimNote);

  return {
    offers,
    dealRooms,
    notes,
    mirrorSwapId,
    mirrorA: { contract: acceptA.contract, offer: offerA, accept: acceptA },
    mirrorB: { contract: acceptB.contract, offer: offerB, accept: acceptB },
    mirrorRoomA,
    victimA,
    victimB,
    victimSwapId: victimA.swapId,
    acceptedSeqA: victimLock.seq,
  };
}

const CHAINS = [
  { name: "evm", dir: "evm-anvil-2026-09-28/settled" },
  { name: "btc", dir: "btc-regtest-2026-09-28/settled" },
  { name: "near", dir: "near-sandbox-2026-09-29/settled" },
] as const;

describe("R3-1: the mirror-pair attack over each chain's settled fixture", () => {
  for (const chain of CHAINS) {
    describe(chain.name, () => {
      it("the victim's swap folds to settled with its proven lines", async () => {
        const loaded = await load(chain.dir);
        const board = foldCaptured({ ...loaded, nowMs: Date.now() } as never);
        const { candidates } = findSwapLegCandidates(loaded.offers);
        const victim = board.swaps.find((s) => s.swapId === candidates[0]!.swapId);
        expect(victim?.status).toBe("settled");
      });

      it("a mirror pair that borrows the victim's evidence and re-posts the victim's lines does not fold to settled, and the victim still settles", async () => {
        const loaded = await load(chain.dir);
        const attack = buildAttack(loaded);

        // Chain captures are keyed per leg contract on NEAR (E1): a live watcher would capture the
        // borrowed lock under the mirror's own contract too, so hand it the same capture.
        const nearChain = new Map(loaded.nearChain as Map<string, unknown>);
        if (chain.name === "near") {
          const { nearCaptureKey } = await import("../src/rails/near-evidence.js");
          const victimEntry = [...nearChain.entries()][0];
          if (victimEntry === undefined) throw new Error("no near capture in the fixture");
          const hashLock = attack.victimA.accept.statement;
          nearChain.set(nearCaptureKey(hashLock, attack.mirrorA.contract), victimEntry[1]);
        }

        const board = foldCaptured({
          offers: attack.offers,
          dealRooms: attack.dealRooms,
          notes: attack.notes,
          chain: loaded.chain,
          btcChain: loaded.btcChain,
          nearChain,
          rails: loaded.rails,
          nowMs: Date.now(),
        } as never);

        const victim = board.swaps.find((s) => s.pairKey === pairKey(attack.victimA.offer.id, attack.victimA.contract, attack.victimB.contract));
        expect(victim?.status).toBe("settled");

        const mirror = board.swaps.find((s) => s.pairKey === pairKey(attack.mirrorA.offer.id, attack.mirrorA.contract, attack.mirrorB.contract));
        expect(mirror).toBeDefined();
        expect(mirror?.status).not.toBe("settled");
        // The mirror's leg A did not verify and was never attributed the victim's observation.
        expect(mirror?.evidence.a?.railVerified).not.toBe(true);
        expect(mirror?.evidence.aRail).toBeUndefined();
        expect(mirror?.settlementView.a).not.toBe("claimed");
        expect(mirror?.evidence.a?.reason ?? "").toMatch(/payee|pubkey|account/i);
      });

      it("the attack worked on the pre-P7 fold: only the proof requirement stops the victim's lines resolving for the mirror", async () => {
        const loaded = await load(chain.dir);
        const attack = buildAttack(loaded);
        const rail = chain.name === "evm" ? "evm-htlc" : chain.name === "btc" ? "btc-htlc" : "near-htlc";
        const caip2 = (loaded.rails[chain.name] as { pin: { caip2: string } }).pin.caip2;
        const input = {
          contract: attack.mirrorA.contract,
          payerDid: mirrorBuyer.did,
          payeeDid: mirrorSeller.did,
          rail,
          caip2,
          beforeSeq: attack.mirrorRoomA.length, // the lock frame is the room's last record
        };
        const resolve = (proof: { mode: "required" } | { mode: "legacy-unproven" }) =>
          chain.name === "btc"
            ? resolvePubkeys(attack.mirrorRoomA, { ...input, proof })
            : resolveAccounts(attack.mirrorRoomA, { ...input, proof });
        // Legacy: the stranger's copy of the victim's lines resolves to the victim's accounts.
        expect(resolve({ mode: "legacy-unproven" }).payee).toBeDefined();
        // Required: it does not (the proof binds the victim's DID and contract).
        expect(resolve({ mode: "required" }).payee).toBeUndefined();
        expect(resolve({ mode: "required" }).payer).toBeUndefined();
      });
    });
  }
});
