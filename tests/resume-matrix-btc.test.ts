// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Tests", the hermetic crash matrix, `btc` harness. See tests/helpers/crash-matrix.ts for what is cut, how, and what is
// counted afterwards, and tests/helpers/matrix-worlds.ts for what the harness is.

import { describeDoubleCrash, describeMatrix, describeStickyFault, describeTimePasses, describeTwoInstances } from "./helpers/matrix-suite.js";
import { btcWorld } from "./helpers/matrix-worlds.js";

await describeMatrix("btc", btcWorld);
await describeDoubleCrash("btc", btcWorld);
await describeTimePasses("btc", btcWorld);
await describeStickyFault("btc", btcWorld);
await describeTwoInstances("btc", btcWorld);
