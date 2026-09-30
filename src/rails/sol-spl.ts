// SPDX-License-Identifier: MIT
//
// Minimal first-party encoders and decoders for the classic SPL Token program and the two other programs
// the Solana leg's harness and adapter touch (system, associated-token-account). No `@solana/*` and no
// `@solana/spl-token` dependency (P6-SOL-SPEC.md section 3).
//
// What is pinned, and against what (tests/sol-spl.test.ts):
//   - instruction data bytes: the crates.io `spl-token-interface` 3.0.0 `TokenInstruction::pack` unit tests
//     (src/instruction.rs), and the program's own hand-encoded `token_data_transfer_checked` /
//     `initialize_account3_ix` (contracts-sol/htlc/src/lib.rs), which that crate's tests pin the same way;
//   - the mint (82 bytes) and token-account (165 bytes) layouts: the constants the program itself uses
//     (`TA_MINT`, `TA_OWNER`, `TA_AMOUNT`, `TA_STATE`, `MINT_DECIMALS`, `MINT_INIT`, lib.rs) and
//     `spl-token-interface` `state.rs` `pack_into_slice`.
//
// Only the CLASSIC Token program is spoken here. Token-2022 accounts are longer than 165 bytes and the
// decoders refuse them by length on purpose (the escrow refuses Token-2022 too; contracts-sol/README.md).

import { concatBytes, findProgramAddress, pubkeyFromBase58, type SolAccountMeta, type SolInstruction } from "./sol-tx.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const BPF_LOADER_UPGRADEABLE_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

export const SPL_MINT_LEN = 82;
export const SPL_TOKEN_ACCOUNT_LEN = 165;

// SPL Token instruction tags (spl-token-interface `TokenInstruction::pack`).
const TAG_MINT_TO = 7;
const TAG_TRANSFER_CHECKED = 12;
const TAG_INITIALIZE_ACCOUNT3 = 18;
const TAG_INITIALIZE_MINT2 = 20;

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error("sol-spl: amount must fit an unsigned 64-bit integer");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function meta(pubkey: Uint8Array, isSigner: boolean, isWritable: boolean): SolAccountMeta {
  return { pubkey, isSigner, isWritable };
}

// --- instruction data (pure byte encoders, exported so tests can pin them) ---------------------------------

export function transferCheckedData(amount: bigint, decimals: number): Uint8Array {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("sol-spl: decimals must be 0..255");
  return concatBytes(Uint8Array.of(TAG_TRANSFER_CHECKED), u64le(amount), Uint8Array.of(decimals));
}

export function mintToData(amount: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(TAG_MINT_TO), u64le(amount));
}

export function initializeAccount3Data(owner: Uint8Array): Uint8Array {
  if (owner.length !== 32) throw new Error("sol-spl: owner must be 32 bytes");
  return concatBytes(Uint8Array.of(TAG_INITIALIZE_ACCOUNT3), owner);
}

/** `InitializeMint2`: tag 20, decimals, mint authority (32), then a one-byte option (0, or 1 + 32 bytes). */
export function initializeMint2Data(decimals: number, mintAuthority: Uint8Array, freezeAuthority: Uint8Array | null): Uint8Array {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("sol-spl: decimals must be 0..255");
  if (mintAuthority.length !== 32) throw new Error("sol-spl: mint authority must be 32 bytes");
  if (freezeAuthority !== null && freezeAuthority.length !== 32) throw new Error("sol-spl: freeze authority must be 32 bytes");
  return concatBytes(
    Uint8Array.of(TAG_INITIALIZE_MINT2, decimals),
    mintAuthority,
    freezeAuthority === null ? Uint8Array.of(0) : concatBytes(Uint8Array.of(1), freezeAuthority),
  );
}

// --- instructions ------------------------------------------------------------------------------------------

const TOKEN_PROGRAM = (): Uint8Array => pubkeyFromBase58(TOKEN_PROGRAM_ID);

/** System program `CreateAccount` (bincode: u32 tag 0, lamports u64, space u64, owner 32). */
export function systemCreateAccount(input: {
  from: Uint8Array;
  newAccount: Uint8Array;
  lamports: bigint;
  space: bigint;
  owner: Uint8Array;
}): SolInstruction {
  return {
    programId: pubkeyFromBase58(SYSTEM_PROGRAM_ID),
    accounts: [meta(input.from, true, true), meta(input.newAccount, true, true)],
    data: concatBytes(u32le(0), u64le(input.lamports), u64le(input.space), input.owner),
  };
}

/** Accounts: mint (w). */
export function initializeMint2(input: { mint: Uint8Array; decimals: number; mintAuthority: Uint8Array; freezeAuthority: Uint8Array | null }): SolInstruction {
  return {
    programId: TOKEN_PROGRAM(),
    accounts: [meta(input.mint, false, true)],
    data: initializeMint2Data(input.decimals, input.mintAuthority, input.freezeAuthority),
  };
}

/** Accounts: account (w), mint. */
export function initializeAccount3(input: { account: Uint8Array; mint: Uint8Array; owner: Uint8Array }): SolInstruction {
  return {
    programId: TOKEN_PROGRAM(),
    accounts: [meta(input.account, false, true), meta(input.mint, false, false)],
    data: initializeAccount3Data(input.owner),
  };
}

/** Accounts: mint (w), destination (w), mint authority (signer). */
export function mintTo(input: { mint: Uint8Array; destination: Uint8Array; authority: Uint8Array; amount: bigint }): SolInstruction {
  return {
    programId: TOKEN_PROGRAM(),
    accounts: [meta(input.mint, false, true), meta(input.destination, false, true), meta(input.authority, true, false)],
    data: mintToData(input.amount),
  };
}

/** Accounts: source (w), mint, destination (w), authority (signer). */
export function transferChecked(input: {
  source: Uint8Array;
  mint: Uint8Array;
  destination: Uint8Array;
  authority: Uint8Array;
  amount: bigint;
  decimals: number;
}): SolInstruction {
  return {
    programId: TOKEN_PROGRAM(),
    accounts: [meta(input.source, false, true), meta(input.mint, false, false), meta(input.destination, false, true), meta(input.authority, true, false)],
    data: transferCheckedData(input.amount, input.decimals),
  };
}

/** The associated token account of `owner` for `mint`: the PDA `[owner, token program, mint]` under the
 *  associated-token-account program. */
export function associatedTokenAddress(owner: Uint8Array, mint: Uint8Array): Uint8Array {
  return findProgramAddress([owner, TOKEN_PROGRAM(), mint], pubkeyFromBase58(ASSOCIATED_TOKEN_PROGRAM_ID)).address;
}

/** Associated-token-account program `CreateIdempotent` (data `[1]`); accounts: payer (s,w), the ATA (w),
 *  owner, mint, system program, token program. Succeeds when the account already exists. */
export function createAssociatedTokenAccountIdempotent(input: { payer: Uint8Array; owner: Uint8Array; mint: Uint8Array }): SolInstruction {
  return {
    programId: pubkeyFromBase58(ASSOCIATED_TOKEN_PROGRAM_ID),
    accounts: [
      meta(input.payer, true, true),
      meta(associatedTokenAddress(input.owner, input.mint), false, true),
      meta(input.owner, false, false),
      meta(input.mint, false, false),
      meta(pubkeyFromBase58(SYSTEM_PROGRAM_ID), false, false),
      meta(TOKEN_PROGRAM(), false, false),
    ],
    data: Uint8Array.of(1),
  };
}

// --- account decoders (strict, never trust a length) ------------------------------------------------------------

export interface SplMint {
  mintAuthority: Uint8Array | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: Uint8Array | null;
}

export type SplTokenAccountState = "uninitialized" | "initialized" | "frozen";

export interface SplTokenAccount {
  mint: Uint8Array;
  owner: Uint8Array;
  amount: bigint;
  delegate: Uint8Array | null;
  state: SplTokenAccountState;
  /** `Some(rent-exempt reserve)` for a wrapped-SOL account, else `null`. */
  isNative: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: Uint8Array | null;
}

function coptionKey(view: Uint8Array, offset: number): Uint8Array | null {
  // 4-byte little-endian tag (0 or 1), then 32 bytes
  const tag = new DataView(view.buffer, view.byteOffset + offset, 4).getUint32(0, true);
  if (tag === 0) return null;
  if (tag === 1) return view.slice(offset + 4, offset + 36);
  throw new Error("sol-spl: invalid COption tag");
}

/** Decodes a classic SPL mint (exactly 82 bytes: authority option @0, supply @36, decimals @44,
 *  initialised @45, freeze option @46). Throws on any other length or a bad flag byte. */
export function decodeMint(data: Uint8Array): SplMint {
  if (data.length !== SPL_MINT_LEN) throw new Error(`sol-spl: a classic mint is ${SPL_MINT_LEN} bytes, got ${data.length}`);
  const init = data[45];
  if (init !== 0 && init !== 1) throw new Error("sol-spl: invalid mint is_initialized byte");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mintAuthority: coptionKey(data, 0),
    supply: view.getBigUint64(36, true),
    decimals: data[44] as number,
    isInitialized: init === 1,
    freezeAuthority: coptionKey(data, 46),
  };
}

/** Decodes a classic SPL token account (exactly 165 bytes: mint @0, owner @32, amount @64, delegate option
 *  @72, state @108, native option @109, delegated amount @121, close-authority option @129). */
export function decodeTokenAccount(data: Uint8Array): SplTokenAccount {
  if (data.length !== SPL_TOKEN_ACCOUNT_LEN) {
    throw new Error(`sol-spl: a classic token account is ${SPL_TOKEN_ACCOUNT_LEN} bytes, got ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stateByte = data[108];
  const state: SplTokenAccountState | null = stateByte === 0 ? "uninitialized" : stateByte === 1 ? "initialized" : stateByte === 2 ? "frozen" : null;
  if (state === null) throw new Error("sol-spl: invalid token account state byte");
  const nativeTag = view.getUint32(109, true);
  if (nativeTag !== 0 && nativeTag !== 1) throw new Error("sol-spl: invalid COption tag");
  return {
    mint: data.slice(0, 32),
    owner: data.slice(32, 64),
    amount: view.getBigUint64(64, true),
    delegate: coptionKey(data, 72),
    state,
    isNative: nativeTag === 1 ? view.getBigUint64(113, true) : null,
    delegatedAmount: view.getBigUint64(121, true),
    closeAuthority: coptionKey(data, 129),
  };
}
