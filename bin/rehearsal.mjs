#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Print the exact frame set and note writes for a PaperRail rehearsal of one two-leg swap
// (SPEC-ATOMIC-SWAP-DESK.md Phase 1, gate G0) for approval. Deterministic: the same inputs
// reproduce the same bytes; `rehearse-post.mjs` regenerates them at the real t0.
//
// This script POSTS NOTHING and SIGNS NOTHING. It writes plan.json (with the secret) and
// plan.txt (secret redacted) under --out. The `paper` rail holds no value.
//
// Usage:
//   node bin/rehearsal.mjs --buyer-did did:key:z6Mk... --seller-did did:key:z6Mk... \
//     --t0 2026-09-19T15:00:00Z --nonce-seed <ascii> --preimage-file <0x + 64 hex file> \
//     --out <dir> [--counter-asset USDC --counter-amount 1000000 --flop-amount 1000000000000000000]
//
// Requires `npm run build` first (imports the vendored tclk dist).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { buildPlan, renderPlan } from "./rehearsal-plan.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const t0 = Date.parse(arg("t0"));
if (!Number.isSafeInteger(t0)) { console.error("bad --t0"); process.exit(2); }
const preimageFile = arg("preimage-file");
const out = arg("out");
mkdirSync(out, { recursive: true });
if (!existsSync(preimageFile)) {
  writeFileSync(preimageFile, "0x" + randomBytes(32).toString("hex"), { encoding: "utf8" });
}

const plan = buildPlan({
  buyerDid: arg("buyer-did"),
  sellerDid: arg("seller-did"),
  t0,
  nonceSeed: arg("nonce-seed"),
  preimageHex: readFileSync(preimageFile, "utf8").trim(),
  counterAsset: arg("counter-asset", "USDC"),
  counterAmount: arg("counter-amount", "1000000"),
  flopAmount: arg("flop-amount", "1000000000000000000"),
});

writeFileSync(join(out, "plan.json"), JSON.stringify({ generatedAt: new Date().toISOString(), preimageFile, ...plan }, null, 2) + "\n");
const text = renderPlan(plan, true);
writeFileSync(join(out, "plan.txt"), text + "\n");
console.log(text);
