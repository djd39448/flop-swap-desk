// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Tests", the hermetic crash matrix, NEAR harness: the real flows over the real NEAR rail over the stateful NEAR RPC
// simulator of tests/client-flows-near-rpc.test.ts. See tests/helpers/crash-matrix.ts for what is cut, how, and what is counted afterwards.
//
// Two cuts do not finish the swap, for one reason: the NEAR rail can only call a transaction that was never sent "never landed" once the
// access key's nonce has moved past it, and nothing moves it, so a recovery answers "pending" for as long as nothing else is signed.
//   - a Buyer that dies right BEFORE `commitLock` leaves a signed lock transaction that was never sent: `lockLegA` keeps refusing without
//     signing anything. Nothing is locked, so this is a liveness limit, not a fund-safety one; the Seller takes leg B back.
//   - a Buyer that dies right AFTER signing its refund (the signature is saved, nothing is sent) cannot build a second refund while the
//     first could still land: `refundLegA` keeps answering "not yet confirmed". Leg A stays locked until a person acts (the funds are
//     in the escrow, not lost); the Seller still takes leg B back.
// Both are open issues of the rail's nonce proof, reported rather than fixed here.

import { describeMatrix } from "./helpers/matrix-suite.js";
import { nearWorld } from "./helpers/matrix-worlds.js";

await describeMatrix("near", nearWorld, {
  stalls: (action, mode) =>
    action.what === "chain:commitLock" && mode === "before" ? "lock-pending" : action.what === "chain:refund.signed" ? "refund-pending" : undefined,
});
