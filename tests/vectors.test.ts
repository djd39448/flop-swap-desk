// SPDX-License-Identifier: MIT
//
// Generates `fixtures/vectors.json`, a deterministic golden fixture covering one full
// swap pair (SPEC §3.2-§3.3) plus its SPEC §3.5 deadline check. This test builds the
// vectors in memory and asserts the checked-in file is byte-identical, so the file
// itself is the golden — regenerate it (once) with `WRITE_VECTORS=1 npx vitest run
// tests/vectors.test.ts`, review the diff, and commit. Every frame goes through tclk's
// own `encodeFrame`/`canonicalJson`, never hand-serialized.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, contractId, dealRoom, encodeFrame, hashLockFromPreimage, makeAccept } from "@flop-labs/tclk";
import { checkSwapDeadlines, DEFAULT_POLICY_EXAMPLE } from "../src/deadlines.js";
import { BUYER_DID, SELLER_DID } from "./helpers/identities.js";
import { buildWorkedExample, SWAP_ID } from "./helpers/offers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(__dirname, "..", "fixtures", "vectors.json");

/** SPEC §3.5's worked-example lock time; shared with tests/deadlines.test.ts. */
const T0 = 1_735_000_000_000;

/** Fixed 32-byte preimage — deterministic, never a real secret. */
const FIXED_PREIMAGE = `0x${"11".repeat(32)}`;

function buildVectorsFileContent(): string {
  const { legA, legB } = buildWorkedExample(T0);

  // The Seller mints the statement at leg A's accept (D-01); the Buyer copies the same
  // H into leg B's accept without ever learning the preimage until leg A's reveal.
  const { hash: statement } = hashLockFromPreimage(FIXED_PREIMAGE);

  const acceptA = makeAccept(legA, { from: SELLER_DID, statement, nonce: "c3c3c3c3" });
  const acceptB = makeAccept(legB, { from: BUYER_DID, statement, nonce: "d4d4d4d4" });

  const contractIdA = contractId(legA, acceptA);
  const contractIdB = contractId(legB, acceptB);

  const deadlineCheck = checkSwapDeadlines(legA, legB, T0, DEFAULT_POLICY_EXAMPLE);

  const vectors = {
    $comment:
      "flop-swap-desk P0.1/P0.3 test vectors: one full swap pair (SPEC §3.2-§3.3) over " +
      "@flop-labs/tclk frames, plus the SPEC §3.5 deadline check for the worked example. " +
      "Fixed identities, nonces, and a fixed (non-secret) preimage make this file " +
      "byte-for-byte reproducible; see tests/vectors.test.ts.",
    swapId: SWAP_ID,
    buyerDid: BUYER_DID,
    sellerDid: SELLER_DID,
    lockTimeMs: T0,
    preimage: FIXED_PREIMAGE,
    statement,
    legA: {
      offerLine: encodeFrame(legA),
      offerId: legA.id,
      acceptLine: encodeFrame(acceptA),
      contractId: contractIdA,
      dealRoom: dealRoom(contractIdA),
    },
    legB: {
      offerLine: encodeFrame(legB),
      offerId: legB.id,
      acceptLine: encodeFrame(acceptB),
      contractId: contractIdB,
      dealRoom: dealRoom(contractIdB),
    },
    deadlineCheck,
  };

  // Round-trip through tclk's own canonicalJson (sorted keys, compact) so key order is
  // deterministic regardless of this object's insertion order, then pretty-print for a
  // reviewable checked-in file.
  const canonical = canonicalJson(vectors);
  return `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`;
}

describe("fixtures/vectors.json", () => {
  it("is byte-identical to the deterministically rebuilt vectors", () => {
    const rebuilt = buildVectorsFileContent();

    if (process.env.WRITE_VECTORS === "1") {
      writeFileSync(VECTORS_PATH, rebuilt);
    }

    const onDisk = readFileSync(VECTORS_PATH, "utf8");
    expect(rebuilt).toBe(onDisk);
  });

  it("the checked-in deadlineCheck is ok:true for the worked example", () => {
    const onDisk = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    expect(onDisk.deadlineCheck.ok).toBe(true);
    expect(onDisk.deadlineCheck.violations).toEqual([]);
  });

  it("leg B's offer context names leg A's offer id", () => {
    const onDisk = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
    expect(onDisk.legB.offerLine).toContain(`"b|${onDisk.legA.offerId}"`);
  });
});
