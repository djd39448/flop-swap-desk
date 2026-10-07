// SPDX-License-Identifier: MIT
//
// A `FinalityWorld` (what the runner's waits read: the config's pin, the runner's own transport, its clock and sleep, its log) over one of the EVM matrix worlds
// (tests/helpers/matrix-worlds.ts): the transport is a fresh one on the world's stateful mock node, the clock is the world's own, and `sleep` moves that clock.
// The runner's loops (`refundLegAWaiting`) can then drive the REAL BuyerFlow, with nothing mocked in the flow.

import { parseRehearsalConfig } from "../../src/client/rehearsal-config.js";
import type { FinalityWorld } from "../../src/client/rehearsal-run.js";
import { ANVIL_LOCAL_PIN } from "../../src/rails/evm-htlc.js";
import type { EvmMockNode } from "./evm-mock-node.js";
import type { Started } from "./resume-world.js";

export interface WorldProbe {
  world: FinalityWorld;
  /** Every log line the runner wrote. */
  logs: string[];
  /** Every sleep the runner made, in ms. */
  sleeps: number[];
}

export function finalityWorld(s: Started, node: EvmMockNode, options: { waitLimitMs?: number; pollMs?: number } = {}): WorldProbe {
  const pollMs = options.pollMs ?? 5_000;
  const logs: string[] = [];
  const sleeps: number[] = [];
  const config = parseRehearsalConfig(
    {
      rails: { evm: { pin: ANVIL_LOCAL_PIN, endpoint: "http://mock-evm", contract: node.railContract, assets: { USDC: node.token } } },
      buyerKeyFile: "b.key",
      sellerKeyFile: "s.key",
      amount: "1000000",
      out: "bundle",
      pollMs,
      ...(options.waitLimitMs === undefined ? {} : { waitLimitMs: options.waitLimitMs }),
    },
    "/base",
  );
  const world: FinalityWorld = {
    config,
    env: {
      now: () => s.w.clockRef.ms,
      sleep: async (ms) => {
        sleeps.push(ms);
        s.w.clockRef.ms += ms;
      },
      out: () => undefined,
      err: () => undefined,
    },
    rpc: node.rpc(),
    log: (line) => void logs.push(line),
    pollMs,
  };
  return { world, logs, sleeps };
}
