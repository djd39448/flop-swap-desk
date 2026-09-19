// SPDX-License-Identifier: MIT
//
// examples/audit-export.mjs against the live G0 rehearsal fixture (P05-SPEC.md deliverable
// 3): runs the published CLI exactly as a user would, offline, against
// fixtures/rehearsal-2026-09-18/ — a byte-exact, watch-root-shaped capture of the real
// 2026-09-18 rehearsal (offer-room seqs 6510778/6510855/6511692/6511726, both paper notes
// fetched once with curl). `npm test` builds `dist/` first (see package.json's "test"
// script), which this spawn depends on.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const script = join(repoRoot, "examples", "audit-export.mjs");
const fixtureRoot = join(repoRoot, "fixtures", "rehearsal-2026-09-18");
const SWAP_ID = "0xb0fa70a3c2a914134967fa423ae3295c2e35b6c3dfd6d461fb7a17fef2430d46";

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
}

describe("examples/audit-export.mjs — live G0 rehearsal fixture", () => {
  it(`--expect ${SWAP_ID}=settled exits 0, with the paper-rail rehearsal reason printed`, () => {
    const result = run(["--root", fixtureRoot, "--expect", `${SWAP_ID}=settled`]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`swap ${SWAP_ID} -> settled`);
    expect(result.stdout).toContain("paper rail: rehearsal only, no value");
  });

  it("prints both notes' finalizedRef and the buyer/seller DIDs from the spec", () => {
    const result = run(["--root", fixtureRoot, "--json"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const swap = parsed.swaps.find((s: { swapId: string }) => s.swapId === SWAP_ID);
    expect(swap).toBeDefined();
    expect(swap.status).toBe("settled");
    expect(swap.buyerDid).toBe("did:key:z6MkfVWRHNeiV99ckgHDmi8HpwMLtir1XsTu9rNCoYdTuizf");
    expect(swap.sellerDid).toBe("did:key:z6MkiPxDPynVz6Wqkph7KA3NXBwXdfc4C9dGFDU7VsZskT6k");
    expect(swap.offerRoomSeqs).toEqual([6510778, 6510855, 6511692, 6511726]);
    expect(swap.finalizedRefs).toHaveLength(2);
    for (const ref of swap.finalizedRefs) expect(ref).toMatch(/^paper:sha256:[0-9a-f]{64}$/);
  });

  it("exits 1 when an --expect does not hold", () => {
    const result = run(["--root", fixtureRoot, "--expect", `${SWAP_ID}=paired`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expect failed");
  });

  it("exits 2 on bad arguments", () => {
    const result = run([]);
    expect(result.status).toBe(2);
  });

  it("exits 3 when raw/ is missing", () => {
    const result = run(["--root", join(repoRoot, "src")]); // exists, but has no raw/
    expect(result.status).toBe(3);
  });

  it("opens no network connection (the script imports no fetch)", () => {
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/from\s+["']node-fetch["']/);
  });
});
