// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Tests", the hermetic crash matrix, `sol` harness. See tests/helpers/crash-matrix.ts for what is cut, how, and what is
// counted afterwards, and tests/helpers/matrix-worlds.ts for what the harness is.

import { describeDoubleCrash, describeMatrix, describeStickyFault, describeTimePasses, describeTwoInstances } from "./helpers/matrix-suite.js";
import { solWorld } from "./helpers/matrix-worlds.js";

await describeMatrix("sol", solWorld);
await describeDoubleCrash("sol", solWorld);
await describeTimePasses("sol", solWorld);
await describeStickyFault("sol", solWorld);
await describeTwoInstances("sol", solWorld, { alsoRefusedBy: /an escrow already exists for this payer and hash lock/ });
