// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Tests", the hermetic crash matrix, NEAR harness: the real flows over the real NEAR rail over the stateful NEAR RPC
// simulator of tests/client-flows-near-rpc.test.ts. See tests/helpers/crash-matrix.ts for what is cut, how, and what is counted afterwards.
//
// Two cuts used to stop the swap here (builders' open issue (b), R1-10): the NEAR rail could only call a transaction that was never
// sent "never landed" once the access key's nonce had moved past it, and nothing moves it, so a recovery answered "pending" for
// as long as nothing else was signed (a Buyer that died right before `commitLock`, or right after signing its refund). Since the
// rail seam splits reading from re-sending (R1-01 part 2, R1-10), `recoverLock` / `recoverRefund` answer "unknown" for such a
// transaction and the identical saved bytes are sent once more (`resendLock` / `resendRefund`): the node accepts them, and the
// swap now runs to its end like every other cut. The stall expectations are gone; the rail-level cases (accepted, `Expired`,
// invalid nonce, transport failure) are in tests/rail-recovery-near.test.ts.

import { describeDoubleCrash, describeMatrix } from "./helpers/matrix-suite.js";
import { nearWorld } from "./helpers/matrix-worlds.js";

await describeMatrix("near", nearWorld);
await describeDoubleCrash("near", nearWorld);
