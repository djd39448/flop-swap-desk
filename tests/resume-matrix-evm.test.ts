// SPDX-License-Identifier: MIT
//
// P8-RESUME-SPEC.md "Tests", the hermetic crash matrix, EVM harness: the real flows over the real EVM rail over the stateful mock node.
// See tests/helpers/crash-matrix.ts for what is cut, how, and what is counted afterwards.

import { evmWorld } from "./helpers/matrix-worlds.js";
import { describeDoubleCrash, describeMatrix } from "./helpers/matrix-suite.js";

await describeMatrix("evm", evmWorld);
await describeDoubleCrash("evm", evmWorld);
