// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Tests", the hermetic crash matrix, `nearfake` harness. See tests/helpers/crash-matrix.ts for what is cut, how, and what is
// counted afterwards, and tests/helpers/matrix-worlds.ts for what the harness is.

import { describeDoubleCrash, describeMatrix } from "./helpers/matrix-suite.js";
import { nearFakeWorld } from "./helpers/matrix-worlds.js";

await describeMatrix("nearfake", nearFakeWorld);
await describeDoubleCrash("nearfake", nearFakeWorld);
