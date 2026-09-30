// SPDX-License-Identifier: MIT
//
// tests/sol-spl.test.ts - the SPL Token encoders/decoders pinned against public and program-owned bytes.
//
// Sources:
//   - crates.io spl-token-interface 3.0.0, src/instruction.rs unit tests (`test_instruction_packing`): the
//     expected bytes for MintTo{1}, TransferChecked{1,2}, InitializeAccount3{[2;32]} and both
//     InitializeMint2 shapes are copied from there. Same crate's src/state.rs `pack_into_slice` fixes the
//     82-byte mint and 165-byte token-account layouts.
//   - contracts-sol/htlc/src/lib.rs: `token_data_transfer_checked(1234, 6)` and the layout constants
//     TA_MINT/TA_OWNER/TA_AMOUNT/TA_STATE/MINT_DECIMALS/MINT_INIT (the program's unit tests pin those to the
//     same crate).
//   - the PDA cases were computed with solana-program 5.1.0 `Pubkey::find_program_address` (the crate the
//     program itself is built with): escrow ["htlc", payer, hash_lock] and vault ["vault", escrow] under the
//     program id, and the associated token account [owner, token program, mint] under the ATA program.

import { describe, expect, it } from "vitest";

import { pubkeyFromBase58, pubkeyToBase58, findProgramAddress } from "../src/rails/sol-tx.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_MINT_LEN,
  SPL_TOKEN_ACCOUNT_LEN,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  decodeMint,
  decodeTokenAccount,
  initializeAccount3,
  initializeAccount3Data,
  initializeMint2,
  initializeMint2Data,
  mintTo,
  mintToData,
  systemCreateAccount,
  transferChecked,
  transferCheckedData,
} from "../src/rails/sol-spl.js";

const fill = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const text = (b: Uint8Array): string => pubkeyToBase58(b);

describe("SPL Token instruction data (spl-token-interface 3.0.0 pack() vectors)", () => {
  it("MintTo { amount: 1 } = [7, 1, 0 x7]", () => {
    expect(Array.from(mintToData(1n))).toEqual([7, 1, 0, 0, 0, 0, 0, 0, 0]);
  });
  it("TransferChecked { amount: 1, decimals: 2 } = [12, 1, 0 x7, 2]", () => {
    expect(Array.from(transferCheckedData(1n, 2))).toEqual([12, 1, 0, 0, 0, 0, 0, 0, 0, 2]);
  });
  it("matches the program's own token_data_transfer_checked(1234, 6)", () => {
    expect(Array.from(transferCheckedData(1234n, 6))).toEqual([12, 210, 4, 0, 0, 0, 0, 0, 0, 6]);
  });
  it("InitializeAccount3 { owner: [2; 32] } = [18, owner]", () => {
    expect(Array.from(initializeAccount3Data(fill(2)))).toEqual([18, ...new Array(32).fill(2)]);
  });
  it("InitializeMint2, freeze authority None and Some", () => {
    expect(Array.from(initializeMint2Data(2, fill(1), null))).toEqual([20, 2, ...new Array(32).fill(1), 0]);
    expect(Array.from(initializeMint2Data(2, fill(2), fill(3)))).toEqual([20, 2, ...new Array(32).fill(2), 1, ...new Array(32).fill(3)]);
  });
  it("u64 amounts are little-endian and range-checked", () => {
    expect(Array.from(mintToData(0xffff_ffff_ffff_ffffn))).toEqual([7, ...new Array(8).fill(255)]);
    expect(() => mintToData(0x1_0000_0000_0000_0000n)).toThrow();
    expect(() => mintToData(-1n)).toThrow();
    expect(() => transferCheckedData(1n, 256)).toThrow();
  });
});

describe("instruction account lists", () => {
  const A = fill(10);
  const B = fill(11);
  const C = fill(12);
  const D = fill(13);
  it("transferChecked: source (w), mint, destination (w), authority (signer)", () => {
    const ix = transferChecked({ source: A, mint: B, destination: C, authority: D, amount: 5n, decimals: 6 });
    expect(text(ix.programId)).toBe(TOKEN_PROGRAM_ID);
    expect(ix.accounts.map((m) => [m.isSigner, m.isWritable])).toEqual([
      [false, true],
      [false, false],
      [false, true],
      [true, false],
    ]);
    expect(ix.accounts.map((m) => Array.from(m.pubkey)[0])).toEqual([10, 11, 12, 13]);
  });
  it("mintTo: mint (w), destination (w), authority (signer); initializeAccount3: account (w), mint; initializeMint2: mint (w)", () => {
    expect(mintTo({ mint: A, destination: B, authority: C, amount: 1n }).accounts.map((m) => [m.isSigner, m.isWritable])).toEqual([
      [false, true],
      [false, true],
      [true, false],
    ]);
    expect(initializeAccount3({ account: A, mint: B, owner: C }).accounts.map((m) => [m.isSigner, m.isWritable])).toEqual([
      [false, true],
      [false, false],
    ]);
    expect(initializeMint2({ mint: A, decimals: 6, mintAuthority: B, freezeAuthority: null }).accounts.map((m) => [m.isSigner, m.isWritable])).toEqual([[false, true]]);
  });
  it("system CreateAccount data = u32 0, lamports, space, owner", () => {
    const ix = systemCreateAccount({ from: A, newAccount: B, lamports: 1_000_000n, space: 165n, owner: pubkeyFromBase58(TOKEN_PROGRAM_ID) });
    expect(Array.from(ix.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(4, true)).toBe(1_000_000n);
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(12, true)).toBe(165n);
    expect(ix.data).toHaveLength(52);
    expect(ix.accounts.map((m) => [m.isSigner, m.isWritable])).toEqual([
      [true, true],
      [true, true],
    ]);
  });
});

describe("program-derived addresses computed with solana-program 5.1.0", () => {
  const programId = pubkeyFromBase58("GedsjashYAxaoETcwBZQR1YgBbuEaK8QiiKu2qi6xe6C");
  const payer = fill(7);
  const hashLock = Uint8Array.from({ length: 32 }, (_, i) => i);
  const enc = new TextEncoder();

  it("escrow [htlc, payer, hash_lock] and vault [vault, escrow] under the program id", () => {
    const escrow = findProgramAddress([enc.encode("htlc"), payer, hashLock], programId);
    expect(text(escrow.address)).toBe("FoMr7GtzuhdJihntCrP1EGGbc3a9BMeQBHVbo6A8yQ1y");
    expect(escrow.bump).toBe(254);
    const vault = findProgramAddress([enc.encode("vault"), escrow.address], programId);
    expect(text(vault.address)).toBe("7Yyy3o5EyPetKjuwmmdkF9hUKffSRH3vDem7jUXPrTDD");
    expect(vault.bump).toBe(255);
  });

  it("the associated token account [owner, token program, mint] under the ATA program", () => {
    const mint = pubkeyFromBase58("91cjWuWZvm24ttxccaWHkAcXQcDw1jce4PNqknzRNSMz");
    expect(text(associatedTokenAddress(fill(9), mint))).toBe("6iiyETYN91h7yPA8rTL46pc69N3LF6LQBDVzq4hZS5uX");
    const ix = createAssociatedTokenAccountIdempotent({ payer: fill(1), owner: fill(9), mint });
    expect(text(ix.programId)).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(Array.from(ix.data)).toEqual([1]);
    expect(text(ix.accounts[1]?.pubkey ?? new Uint8Array(32))).toBe("6iiyETYN91h7yPA8rTL46pc69N3LF6LQBDVzq4hZS5uX");
  });
});

/** Builds a 165-byte token account the way spl-token-interface state.rs `pack_into_slice` lays it out. */
function tokenAccountBytes(o: { mint: Uint8Array; owner: Uint8Array; amount: bigint; state: number; delegate?: Uint8Array; native?: bigint; closeAuthority?: Uint8Array }): Uint8Array {
  const data = new Uint8Array(SPL_TOKEN_ACCOUNT_LEN);
  const view = new DataView(data.buffer);
  data.set(o.mint, 0);
  data.set(o.owner, 32);
  view.setBigUint64(64, o.amount, true);
  if (o.delegate !== undefined) {
    view.setUint32(72, 1, true);
    data.set(o.delegate, 76);
  }
  data[108] = o.state;
  if (o.native !== undefined) {
    view.setUint32(109, 1, true);
    view.setBigUint64(113, o.native, true);
  }
  if (o.closeAuthority !== undefined) {
    view.setUint32(129, 1, true);
    data.set(o.closeAuthority, 133);
  }
  return data;
}

describe("account decoders", () => {
  it("decodes a token account at the offsets the program uses (mint 0, owner 32, amount 64, state 108)", () => {
    const acct = decodeTokenAccount(tokenAccountBytes({ mint: fill(1), owner: fill(2), amount: 777n, state: 1 }));
    expect(Array.from(acct.mint)).toEqual(Array.from(fill(1)));
    expect(Array.from(acct.owner)).toEqual(Array.from(fill(2)));
    expect(acct.amount).toBe(777n);
    expect(acct.state).toBe("initialized");
    expect(acct.delegate).toBeNull();
    expect(acct.isNative).toBeNull();
    expect(acct.closeAuthority).toBeNull();
  });

  it("decodes frozen, delegate, native and close-authority fields", () => {
    const acct = decodeTokenAccount(
      tokenAccountBytes({ mint: fill(1), owner: fill(2), amount: 1n, state: 2, delegate: fill(3), native: 2039280n, closeAuthority: fill(4) }),
    );
    expect(acct.state).toBe("frozen");
    expect(Array.from(acct.delegate ?? [])).toEqual(Array.from(fill(3)));
    expect(acct.isNative).toBe(2039280n);
    expect(Array.from(acct.closeAuthority ?? [])).toEqual(Array.from(fill(4)));
  });

  it("refuses a Token-2022-sized account, a short one, a bad state byte and a bad option tag", () => {
    const good = tokenAccountBytes({ mint: fill(1), owner: fill(2), amount: 1n, state: 1 });
    expect(() => decodeTokenAccount(new Uint8Array(166))).toThrow(/165/);
    expect(() => decodeTokenAccount(good.slice(0, 164))).toThrow(/165/);
    const badState = good.slice();
    badState[108] = 3;
    expect(() => decodeTokenAccount(badState)).toThrow(/state/);
    const badTag = good.slice();
    badTag[72] = 2;
    expect(() => decodeTokenAccount(badTag)).toThrow(/COption/);
  });

  it("decodes a mint at the offsets the program uses (decimals 44, initialised 45)", () => {
    const data = new Uint8Array(SPL_MINT_LEN);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1, true);
    data.set(fill(5), 4);
    view.setBigUint64(36, 1_000_000n, true);
    data[44] = 6;
    data[45] = 1;
    const mint = decodeMint(data);
    expect(mint.decimals).toBe(6);
    expect(mint.isInitialized).toBe(true);
    expect(mint.supply).toBe(1_000_000n);
    expect(Array.from(mint.mintAuthority ?? [])).toEqual(Array.from(fill(5)));
    expect(mint.freezeAuthority).toBeNull();
    const bad = data.slice();
    bad[45] = 2;
    expect(() => decodeMint(bad)).toThrow();
    expect(() => decodeMint(new Uint8Array(83))).toThrow(/82/);
  });
});
