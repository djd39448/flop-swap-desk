// SPDX-License-Identifier: MIT
//
// tests/evm-sent-hash.test.ts - P10 B6 (P10-BACKLOG-SPEC.md decision 6; R5-KEY-INFO), the transport alone: `verifySentTransactionHash` (src/rails/evm-signer.ts) hands back the keccak256 of
// the raw signed transaction as the answer to every `eth_sendRawTransaction`, whatever the endpoint answered, and reports an answer that is not that hash once, as one fixed sentence that
// carries the computed hash only: the endpoint's answer is described, never quoted, even when it is shaped like a hash (it is the endpoint's to choose, so a hostile endpoint could put any
// 64-hex value it has seen into a log). (The whole rail over the stateful mock node: tests/evm-pending-write.test.ts; the runner's printed line: tests/rehearsal-claim-watch.test.ts.)
// No key is involved: the "raw transactions" here are arbitrary bytes, hashed and never parsed.

import { randomBytes } from "node:crypto";

import { keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { sentHashMismatchWarning, verifySentTransactionHash, type EvmRequestProvider } from "../src/rails/evm-signer.js";

const RAW = `0x02${"f8".repeat(40)}` as Hex; // bytes only: nothing parses them
const COMPUTED = keccak256(RAW);
const OTHER = keccak256("0x0102") as Hex; // another well-formed hash

/** A provider that answers every request with `answer`, recording the calls it got. */
function answering(answer: unknown): { provider: EvmRequestProvider; calls: Array<{ method: string; params?: unknown }> } {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    calls,
    provider: {
      async request(args) {
        calls.push(args);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const send = (provider: EvmRequestProvider, raw: unknown = RAW): Promise<unknown> => provider.request({ method: "eth_sendRawTransaction", params: [raw] });

describe("P10 B6: verifySentTransactionHash", () => {
  it("an answer equal to keccak256(raw) is returned as the computed hash, with no warning; the same hash in upper case is the same hash (no warning, lower case back)", async () => {
    const warnings: string[] = [];
    for (const answer of [COMPUTED, `0x${COMPUTED.slice(2).toUpperCase()}`]) {
      const { provider, calls } = answering(answer);
      expect(await send(verifySentTransactionHash(provider, (text) => void warnings.push(text)))).toBe(COMPUTED);
      expect(calls).toEqual([{ method: "eth_sendRawTransaction", params: [RAW] }]); // forwarded as it came
    }
    expect(warnings).toEqual([]);
  });

  it("another well-formed hash is replaced by the computed one and reported once; the sentence carries the computed hash and nothing else, and never the endpoint's answer", async () => {
    const warnings: string[] = [];
    const { provider } = answering(OTHER);
    expect(await send(verifySentTransactionHash(provider, (text) => void warnings.push(text)))).toBe(COMPUTED);
    expect(warnings).toEqual([sentHashMismatchWarning(COMPUTED, OTHER)]);
    expect(warnings[0]).toBe(`evm-htlc: warning: the endpoint answered a different transaction hash for a transaction this process sent; that transaction's hash is ${COMPUTED}, and the computed hash is used for this write`);
    expect(warnings[0]!.match(/0x[0-9a-fA-F]+/g)).toEqual([COMPUTED]); // exactly one 0x-64-hex run, the computed hash
    expect(warnings[0]!.toLowerCase().includes(OTHER.slice(2))).toBe(false);
    // the sentence does not depend on the answer at all, so no answer can reach a log through it (upper case or lower)
    expect(sentHashMismatchWarning(COMPUTED, `0x${OTHER.slice(2).toUpperCase()}`)).toBe(warnings[0]);
  });

  it("an answer equal to some other 64-hex value, such as 32 random bytes a hostile endpoint chose, never appears in the warning, in any case or without its 0x", async () => {
    for (let i = 0; i < 5; i += 1) {
      const chosen = randomBytes(32).toString("hex"); // a test-time value standing for anything the endpoint has seen (a preimage in call data, say)
      for (const answer of [`0x${chosen}`, `0x${chosen.toUpperCase()}`]) {
        const warnings: string[] = [];
        const { provider } = answering(answer);
        expect(await send(verifySentTransactionHash(provider, (text) => void warnings.push(text)))).toBe(COMPUTED);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.toLowerCase().includes(chosen)).toBe(false);
        expect(warnings[0]!.match(/0x[0-9a-fA-F]{64}/g)).toEqual([COMPUTED]);
        expect(warnings[0]).toBe(sentHashMismatchWarning(COMPUTED, OTHER)); // the same text whatever the answer was
      }
    }
  });

  it("an answer that is not a hash at all (absent, a number, an object, a short or long or non-hex string, a hash with text around it) is replaced and reported once, and none of it is quoted", async () => {
    const hostile = "HOSTILE-ENDPOINT-TEXT";
    const answers: unknown[] = [
      undefined,
      null,
      7,
      true,
      { hash: COMPUTED, note: hostile },
      [COMPUTED],
      "",
      "0x",
      `0x${"ab".repeat(31)}`, // 31 bytes
      `0x${"ab".repeat(33)}`, // 33 bytes
      `0x${"zz".repeat(32)}`, // not hex
      `${COMPUTED} ${hostile}`,
      `${hostile} ${COMPUTED}`,
      `${COMPUTED.slice(2)}`, // no 0x
      hostile.repeat(500),
    ];
    for (const answer of answers) {
      const warnings: string[] = [];
      const { provider } = answering(answer);
      expect(await send(verifySentTransactionHash(provider, (text) => void warnings.push(text))), JSON.stringify(answer)?.slice(0, 40)).toBe(COMPUTED);
      expect(warnings, JSON.stringify(answer)?.slice(0, 40)).toHaveLength(1);
      expect(warnings[0]).toBe(sentHashMismatchWarning(COMPUTED, answer));
      expect(warnings[0]).not.toContain(hostile);
      expect(warnings[0]!.match(/0x[0-9a-fA-F]+/g)).toEqual([COMPUTED]); // the one public hash, no answered value
    }
  });

  it("an endpoint's error reply is passed through exactly as before (same error, no warning, nothing hashed into an answer)", async () => {
    const warnings: string[] = [];
    const failure = new Error("nonce too low");
    const { provider } = answering(failure);
    await expect(send(verifySentTransactionHash(provider, (text) => void warnings.push(text)))).rejects.toBe(failure);
    expect(warnings).toEqual([]);
  });

  it("every other method goes through untouched, and a send whose parameter is not a raw transaction is forwarded unchanged (nothing to hash)", async () => {
    const warnings: string[] = [];
    const { provider, calls } = answering(OTHER);
    const wrapped = verifySentTransactionHash(provider, (text) => void warnings.push(text));
    expect(await wrapped.request({ method: "eth_getTransactionReceipt", params: [COMPUTED] })).toBe(OTHER);
    expect(await wrapped.request({ method: "eth_sendTransaction", params: [{ from: "0x", to: "0x" }] })).toBe(OTHER); // a JSON-RPC account's send: the node signs, nothing to hash
    for (const params of [undefined, [], ["not hex"], ["0x"], ["0x0"], ["0xabc"], [7], [null], "0xabcd"]) {
      expect(await wrapped.request({ method: "eth_sendRawTransaction", params }), JSON.stringify(params)).toBe(OTHER);
    }
    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(2 + 9);
  });

  it("a listener that throws changes nothing, and each write is reported on its own (the wrapper keeps no state between writes)", async () => {
    const { provider } = answering(OTHER);
    const broken = verifySentTransactionHash(provider, () => {
      throw new Error("the printer broke");
    });
    expect(await send(broken)).toBe(COMPUTED);
    const warnings: string[] = [];
    const counting = verifySentTransactionHash(provider, (text) => void warnings.push(text));
    expect(await send(counting)).toBe(COMPUTED);
    expect(await send(counting, `0x02${"f9".repeat(40)}`)).toBe(keccak256(`0x02${"f9".repeat(40)}` as Hex));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).not.toBe(warnings[1]); // each names its own computed hash
    expect(await send(verifySentTransactionHash(provider))).toBe(COMPUTED); // no listener: corrected, not reported
  });

  it("the sentence is plain ASCII on one line, and the only hex run in it is the computed hash", () => {
    for (const text of [sentHashMismatchWarning(COMPUTED, OTHER), sentHashMismatchWarning(COMPUTED, 5), sentHashMismatchWarning(COMPUTED, undefined)]) {
      expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
      expect(text.includes("\n")).toBe(false);
      expect(text.match(/[0-9a-fA-F]{16,}/g)).toEqual([COMPUTED.slice(2)]);
    }
  });
});
