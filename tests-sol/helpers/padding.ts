// SPDX-License-Identifier: MIT
//
// tests-sol/helpers/padding.ts - S2-2/S2-3: anyone can push an address's transaction history past any scan limit
// by sending cheap transactions that merely NAME the address (about 0.025 SOL for 5000 of them). This helper does
// exactly that on the live validator, from a throwaway funded party: each padding transaction is a one-lamport-class
// System Program transfer (a distinct amount per transaction, so every signature is distinct) whose instruction also
// lists `target` as an extra read-only account. The System Program ignores extra accounts; the validator indexes the
// transaction under every account key it names, so `getSignaturesForAddress(target)` grows by one per transaction.

import { SolRpc } from "../../src/rails/sol-rpc.js";
import { SYSTEM_PROGRAM_ID } from "../../src/rails/sol-spl.js";
import { compileLegacyMessage, pubkeyFromBase58, signTransaction, type SolInstruction } from "../../src/rails/sol-tx.js";
import type { SolParty, SolValidatorHandle } from "./validator.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** System Program Transfer: instruction index 2 (u32 LE) then lamports (u64 LE). */
function transferData(lamports: number): Uint8Array {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(lamports), true);
  return data;
}

/** How many finalized history entries `getSignaturesForAddress` reports for `address` (paged, at most `cap` counted). */
export async function historyLength(v: SolValidatorHandle, address: string, cap: number): Promise<number> {
  const sol = new SolRpc(v.createCapturingRpc());
  let count = 0;
  let before: string | undefined;
  for (;;) {
    const page = await sol.getSignaturesForAddress(address, { commitment: "finalized", limit: 1000, ...(before === undefined ? {} : { before }) });
    count += page.length;
    const last = page[page.length - 1];
    if (page.length < 1000 || last === undefined || count >= cap) return count;
    before = last.signature;
  }
}

/** Pads `address`'s finalized history with at least `count` entries and waits until they are finalized. */
export async function padAddressHistory(v: SolValidatorHandle, address: string, count: number, padder?: SolParty): Promise<number> {
  const payer = padder ?? (await v.createParty({ sol: 3, tokenAccount: false }));
  const sol = new SolRpc(v.createCapturingRpc());
  const target = pubkeyFromBase58(address);
  const recipient = pubkeyFromBase58(v.seller.address);
  const system = pubkeyFromBase58(SYSTEM_PROGRAM_ID);
  const BATCH = 250;
  const CONCURRENCY = 25;
  const base = await historyLength(v, address, count + 10_000);
  for (let offset = 0; offset < count; offset += BATCH) {
    const latest = await sol.getLatestBlockhash("confirmed");
    const blockhash = pubkeyFromBase58(latest.blockhash);
    const n = Math.min(BATCH, count - offset);
    const signed = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const instruction: SolInstruction = {
          programId: system,
          accounts: [
            { pubkey: payer.signer.publicKeyBytes, isSigner: true, isWritable: true },
            { pubkey: recipient, isSigner: false, isWritable: true },
            { pubkey: target, isSigner: false, isWritable: false },
          ],
          data: transferData(offset + i + 1),
        };
        const message = compileLegacyMessage({ feePayer: payer.signer.publicKeyBytes, recentBlockhash: blockhash, instructions: [instruction] });
        return signTransaction(message, [payer.signer]);
      }),
    );
    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const index = next;
          next += 1;
          const tx = signed[index];
          if (tx === undefined) return;
          await sol.sendTransaction(tx.bytes, { skipPreflight: true });
        }
      }),
    );
  }
  for (const deadline = Date.now() + 300_000; ; ) {
    const length = await historyLength(v, address, base + count + 10_000);
    if (length >= base + count) return length;
    if (Date.now() >= deadline) throw new Error(`test: the padding never reached ${base + count} finalized entries (saw ${length})`);
    await sleep(3000);
  }
}
