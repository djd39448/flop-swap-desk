// SPDX-License-Identifier: MIT
//
// A scripted JSON-RPC node for the P9 hermetic tests: each method has a handler that answers from the call's params, every call is
// recorded, and a method with no handler answers a JSON-RPC error (so a call the test did not expect is visible, never silent). It goes
// through the repo's own `CapturingRpc` (a mocked `fetch`), the same way tests/evm-htlc.test.ts drives the adapter.

import { CapturingRpc } from "../../src/rails/rpc-capture.js";

export type ScriptedResponse = { result?: unknown; error?: { code: number; message: string } };
export type ScriptedHandler = (params: readonly unknown[]) => ScriptedResponse;

export interface ScriptedRpc {
  rpc: CapturingRpc;
  calls: Array<{ method: string; params: readonly unknown[] }>;
}

export function scriptedRpc(handlers: Record<string, ScriptedHandler>): ScriptedRpc {
  const calls: Array<{ method: string; params: readonly unknown[] }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly unknown[] };
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    const response: ScriptedResponse = handler === undefined ? { error: { code: -32601, message: `unexpected ${body.method}` } } : handler(body.params);
    const text = JSON.stringify(
      response.error !== undefined ? { jsonrpc: "2.0", id: body.id, error: response.error } : { jsonrpc: "2.0", id: body.id, result: response.result },
    );
    const bytes = new TextEncoder().encode(text);
    return { text: async () => text, arrayBuffer: async () => bytes.buffer } as Response;
  }) as typeof fetch;
  return { rpc: new CapturingRpc({ endpoint: "http://mock-evm", fetch: fetchImpl }), calls };
}
