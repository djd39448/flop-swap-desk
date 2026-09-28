// SPDX-License-Identifier: MIT
//
// The Bitcoin HTLC primitive (P4-BTC-SPEC.md §3): a pure witnessScript/address builder plus
// claim/refund PSBT builders, built to reproduce Bitcoin Core 31.1's own miniscript compilation
// of `andor(pk(PAYEE),sha256(H),and_v(v:pk(PAYER),after(T)))` byte for byte — verified
// empirically against a real regtest node (handoff/research/btc-regtest-probe-2026-09-28.md
// Q1, Q3, Q4) and re-verified as a regression fixture in tests-regtest/btc-htlc.regtest.test.ts.
// `@scure/btc-signer`'s `Script` coder and `p2wsh`/`Address`/`OutScript` payment helpers do the
// actual bitcoin-consensus encoding; this module only supplies the exact opcode sequence Core's
// compiler produced and the regtest/signet network parameters `@scure/btc-signer` does not ship
// (it only carries mainnet `bc` and testnet `tb` bech32 HRPs — probe gotcha).
//
// Keyless throughout (P4-BTC-SPEC.md §1): every function here handles only PUBLIC keys
// (33-byte compressed secp256k1 points) and a PSBT's own public fields (witness_utxo,
// witnessScript, bip32_derivation, the BIP174 sha256-preimage map) — never a private key, WIF,
// xprv, seed or mnemonic. Signing happens entirely inside a bitcoind wallet via
// `walletprocesspsbt` (src/rails/btc-htlc.ts); this module never talks to a node.
//
// Design source: flop-contrib/handoff/P4-BTC-SPEC.md §3;
// flop-contrib/handoff/research/btc-regtest-probe-2026-09-28.md Q1-Q4.

import { hexToBytes } from "@noble/hashes/utils.js";
import { Address, OutScript, Script, Transaction, p2wsh } from "@scure/btc-signer";
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";

/** BIP65's own height/time threshold: an `nLockTime`/CLTV value at or below this is interpreted
 *  as a BLOCK HEIGHT, not a Unix time. P4-BTC-SPEC.md §3 requires the locktime this module
 *  encodes to sit strictly above it, so it can never be read back as a height and is always
 *  checkable against the signed terms byte for byte. */
export const BIP65_THRESHOLD = 500_000_000;

/** P4-BTC-FIXES.md H7, tightened by the main-loop review 2026-09-28: the cap is miniscript's
 *  `after(n)` range, `1 <= n < 2^31`, not the 32-bit `nLockTime` field. The refund is signed by
 *  the Buyer's wallet through `walletprocesspsbt`, which satisfies the script only after parsing
 *  it as miniscript; a `T` of 2^31 or more (unix time in 2038 or later) would build and fund a
 *  valid P2WSH whose refund branch the wallet cannot sign, leaving the escrow claimable only by
 *  the Seller. Both the locktime deriver and the script builder refuse it up front. */
export const MAX_LOCKTIME = 0x7fffffff;

/** `@scure/btc-signer` ships only mainnet (`bc`) and testnet (`tb`) bech32 HRPs (its own
 *  `NETWORK`/`TEST_NETWORK`) — regtest needs its own network params defined by hand. Probe
 *  gotcha: regtest's base58 version bytes (`pubKeyHash`/`scriptHash`/`wif`) are IDENTICAL to
 *  testnet's; only the bech32 HRP (`bcrt` vs `tb`) differs. */
export const BTC_REGTEST_NETWORK: BTC_NETWORK = { bech32: "bcrt", pubKeyHash: 111, scriptHash: 196, wif: 239 };

/** Signet reuses testnet's base58/bech32 version bytes, including the `tb` HRP (signet and
 *  testnet3 addresses are not distinguishable by HRP alone). Present so the type exists for
 *  P4-BTC-SPEC.md §4's `BTC_SIGNET_PIN`; not verified against a live signet node by this build
 *  (Dave's own G1 step) — see the "UNVERIFIED" pin in src/rails/btc-htlc.ts. */
export const BTC_SIGNET_NETWORK: BTC_NETWORK = { bech32: "tb", pubKeyHash: 111, scriptHash: 196, wif: 239 };

const COMPRESSED_PUBKEY_LENGTH = 33;
const HASH_LENGTH = 32;

function assertCompressedPubkey(label: string, pubkey: Uint8Array): void {
  if (pubkey.length !== COMPRESSED_PUBKEY_LENGTH || (pubkey[0] !== 0x02 && pubkey[0] !== 0x03)) {
    throw new Error(`btc-script: ${label} must be a 33-byte compressed public key (0x02/0x03 prefix)`);
  }
}

/** P4-BTC-SPEC.md §3: `T = refundAfterMs / 1000`, refused unless `refundAfterMs` is a whole
 *  number of seconds and `T` is strictly above BIP65's height/time threshold. This is what makes
 *  the on-chain `T` checkable against the signed terms byte for byte, and never ambiguous with a
 *  block height. Consequence (documented for a caller, per the spec): the refund becomes
 *  spendable only once the median time past of the chain's last 11 blocks passes `T`, which lags
 *  wall clock by roughly an hour — a real refund's chain-observable time is later than
 *  `refundAfterMs` itself.
 */
export function locktimeFromRefundAfterMs(refundAfterMs: number): number {
  if (!Number.isFinite(refundAfterMs) || !Number.isInteger(refundAfterMs)) {
    throw new Error("btc-script: refundAfterMs must be an integer number of milliseconds");
  }
  if (refundAfterMs % 1000 !== 0) {
    throw new Error("btc-script: refundAfterMs must be a whole number of seconds (a multiple of 1000)");
  }
  const t = refundAfterMs / 1000;
  if (!(t > BIP65_THRESHOLD)) {
    throw new Error(
      `btc-script: locktime ${t} is at or below the BIP65 height/time threshold (${BIP65_THRESHOLD}); refusing an ambiguous CLTV value`,
    );
  }
  if (t > MAX_LOCKTIME) {
    throw new Error(`btc-script: locktime ${t} exceeds miniscript's after() maximum (${MAX_LOCKTIME}); the wallet could not sign the refund`);
  }
  return t;
}

export interface HtlcScriptParams {
  /** sha256(preimage) — 32 bytes. */
  hashLock: Uint8Array;
  /** The Seller's pubkey (the hash/claim branch). */
  payeePubkey: Uint8Array;
  /** The Buyer's pubkey (the timelock/refund branch). */
  payerPubkey: Uint8Array;
  /** Unix seconds. Use `locktimeFromRefundAfterMs` to derive this from `refundAfterMs` — this
   *  function re-checks the same bound (never trusts a caller that bypassed the helper). */
  locktime: number;
}

export interface HtlcScript {
  /** Core's exact compiled form of `andor(pk(PAYEE),sha256(H),and_v(v:pk(PAYER),after(T)))`:
   *  `<PAYEE> CHECKSIG NOTIF <PAYER> CHECKSIGVERIFY <T> CHECKLOCKTIMEVERIFY ELSE SIZE 32
   *  EQUALVERIFY SHA256 <H> EQUAL ENDIF` (probe Q1). */
  witnessScript: Uint8Array;
  /** The P2WSH `scriptPubKey` (`OP_0 <sha256(witnessScript)>`). */
  scriptPubKey: Uint8Array;
  /** bech32 address for `network` (regtest: `bcrt1q…`; signet/testnet: `tb1q…`). */
  address: string;
  locktime: number;
}

/**
 * Build the HTLC witnessScript, its P2WSH scriptPubKey, and address for `network` — pure, and
 * byte-identical to what `bitcoin-cli decodescript`/`deriveaddresses` produced for the same
 * `(H, payeePubkey, payerPubkey, T)` on Core 31.1 (probe Q1; re-verified live in
 * tests-regtest/btc-htlc.regtest.test.ts). Probe gotcha: script numbers (the locktime, the `32`
 * size check) must reach `Script.encode` as a plain JS `number`, never a `BigInt` — the encoder
 * throws on a bigint script push.
 */
export function buildHtlcScript(params: HtlcScriptParams, network: BTC_NETWORK = BTC_REGTEST_NETWORK): HtlcScript {
  assertCompressedPubkey("payeePubkey", params.payeePubkey);
  assertCompressedPubkey("payerPubkey", params.payerPubkey);
  if (params.hashLock.length !== HASH_LENGTH) {
    throw new Error("btc-script: hashLock must be 32 bytes (sha256 of the preimage)");
  }
  if (!Number.isInteger(params.locktime) || !(params.locktime > BIP65_THRESHOLD) || params.locktime > MAX_LOCKTIME) {
    throw new Error(
      `btc-script: locktime must be an integer strictly above the BIP65 threshold (${BIP65_THRESHOLD}) and at most ${MAX_LOCKTIME}; use locktimeFromRefundAfterMs`,
    );
  }

  // Miniscript andor(X,Y,Z) compiles to `X NOTIF Z ELSE Y ENDIF` (probe Q1's decodescript ASM).
  const witnessScript = Script.encode([
    params.payeePubkey,
    "CHECKSIG",
    "NOTIF",
    params.payerPubkey,
    "CHECKSIGVERIFY",
    params.locktime,
    "CHECKLOCKTIMEVERIFY",
    "ELSE",
    "SIZE",
    32,
    "EQUALVERIFY",
    "SHA256",
    params.hashLock,
    "EQUAL",
    "ENDIF",
  ]);

  // p2wsh() only reads `.script` off its `child` argument (and hashes/wraps it) — the `type`
  // tag it also expects is never inspected for that, so any label satisfies it; ours never
  // matches one of the library's own recognized payment shapes, which is the point (a bespoke
  // miniscript script, not a name it would otherwise try to interpret).
  const wrapped = p2wsh({ type: "htlc", script: witnessScript }, network);

  return { witnessScript, scriptPubKey: wrapped.script, address: wrapped.address, locktime: params.locktime };
}

/** Decode a bech32/base58 address into its scriptPubKey bytes for `network` — used to turn a
 *  claim/refund's chosen destination address into the PSBT output script. Spec §3: "where the
 *  claim and refund outputs go is each party's own choice at spend time", so this is the only
 *  place an arbitrary destination address enters the build. */
export function scriptPubKeyForAddress(address: string, network: BTC_NETWORK): Uint8Array {
  try {
    return OutScript.encode(Address(network).decode(address));
  } catch (error) {
    throw new Error(`btc-script: "${address}" is not a valid address for this network (${error instanceof Error ? error.message : String(error)})`);
  }
}

export interface Bip32Derivation {
  /** The signing wallet's own master-key fingerprint (`getaddressinfo(...).hdMasterFingerprint`
   *  as a 4-byte big-endian integer — public key material, never a key). */
  fingerprint: number;
  /** The signing wallet's own derivation path for this pubkey (`getaddressinfo(...).hdKeypath`,
   *  parsed to indices — public, never a key). */
  path: readonly number[];
}

/** The funding output a claim/refund PSBT spends — read live off-chain (src/rails/btc-htlc.ts),
 *  never assumed, so the PSBT's `witness_utxo` amount is always the exact on-chain value the
 *  segwit v0 sighash commits to. */
export interface FundingUtxo {
  /** Display-order (big-endian) txid hex, exactly as bitcoind reports and accepts it. */
  txid: string;
  vout: number;
  scriptPubKey: Uint8Array;
  amountSats: bigint;
}

export interface ClaimPsbtParams {
  utxo: FundingUtxo;
  witnessScript: Uint8Array;
  hashLock: Uint8Array;
  /** The secret. Only ever placed in the PSBT's own BIP174 `sha256` preimage field, handed
   *  straight to the signing wallet's own `walletprocesspsbt` — never logged, never captured. */
  preimage: Uint8Array;
  payeePubkey: Uint8Array;
  payeeDerivation: Bip32Derivation;
  destinationScriptPubKey: Uint8Array;
  /** A fixed fee in satoshis, subtracted from the single output. Fee estimation is explicitly
   *  out of scope for this build (P4-BTC-SPEC.md scope note). */
  feeSats: bigint;
}

/**
 * Build the claim-branch PSBT (probe Q3, path (a)): `witness_utxo` + `witnessScript` +
 * `bip32_derivation` for the payee's own key + the BIP174 `sha256` preimage field, so
 * `walletprocesspsbt` (default `finalize=true`) can sign AND finalize in one call with no
 * `importdescriptors` on the signing wallet. `sequence` is `0xfffffffe` (probe): harmless for
 * the claim branch (it does not read the locktime), and keeps this input's own fields uniform
 * with the refund PSBT's.
 */
export function buildClaimPsbt(params: ClaimPsbtParams): Uint8Array {
  assertCompressedPubkey("payeePubkey", params.payeePubkey);
  if (params.preimage.length !== HASH_LENGTH) throw new Error("btc-script: preimage must be 32 bytes");
  if (params.hashLock.length !== HASH_LENGTH) throw new Error("btc-script: hashLock must be 32 bytes");
  if (params.feeSats <= 0n) throw new Error("btc-script: feeSats must be positive");
  if (params.feeSats >= params.utxo.amountSats) {
    throw new Error("btc-script: feeSats must be less than the funding amount");
  }

  const tx = new Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
    version: 2,
    lockTime: 0,
  });
  tx.addInput({
    txid: hexToBytes(params.utxo.txid),
    index: params.utxo.vout,
    witnessUtxo: { amount: params.utxo.amountSats, script: params.utxo.scriptPubKey },
    witnessScript: params.witnessScript,
    bip32Derivation: [
      [params.payeePubkey, { fingerprint: params.payeeDerivation.fingerprint, path: [...params.payeeDerivation.path] }],
    ],
    sha256: [[params.hashLock, params.preimage]],
    sequence: 0xfffffffe,
  });
  tx.addOutput({ script: params.destinationScriptPubKey, amount: params.utxo.amountSats - params.feeSats });
  return tx.toPSBT();
}

export interface RefundPsbtParams {
  utxo: FundingUtxo;
  witnessScript: Uint8Array;
  /** `T` — becomes the transaction's own global `nLockTime`. */
  locktime: number;
  payerPubkey: Uint8Array;
  payerDerivation: Bip32Derivation;
  destinationScriptPubKey: Uint8Array;
  feeSats: bigint;
}

/**
 * Build the refund-branch PSBT (probe Q4): global `nLockTime = T`, input `sequence =
 * 0xfffffffe` (BIP65 requires a non-final sequence for CLTV to take effect), `witness_utxo` +
 * `witnessScript` + `bip32_derivation` for the payer's own key. Core's miniscript-aware
 * finalizer produces the mandatory NULLFAIL dissatisfaction of `pk(PAYEE)` (an empty witness
 * item) on its own — no extra help needed. `walletprocesspsbt` signs/finalizes this
 * successfully regardless of whether the chain's median time past has reached `T` yet (probe
 * Q4): only broadcast (`testmempoolaccept`) is locktime-gated, never PSBT finalization itself.
 */
export function buildRefundPsbt(params: RefundPsbtParams): Uint8Array {
  assertCompressedPubkey("payerPubkey", params.payerPubkey);
  if (!Number.isInteger(params.locktime) || !(params.locktime > BIP65_THRESHOLD) || params.locktime > MAX_LOCKTIME) {
    throw new Error(`btc-script: locktime must be an integer strictly above the BIP65 threshold (${BIP65_THRESHOLD}) and at most ${MAX_LOCKTIME}`);
  }
  if (params.feeSats <= 0n) throw new Error("btc-script: feeSats must be positive");
  if (params.feeSats >= params.utxo.amountSats) {
    throw new Error("btc-script: feeSats must be less than the funding amount");
  }

  const tx = new Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
    version: 2,
    lockTime: params.locktime,
  });
  tx.addInput({
    txid: hexToBytes(params.utxo.txid),
    index: params.utxo.vout,
    witnessUtxo: { amount: params.utxo.amountSats, script: params.utxo.scriptPubKey },
    witnessScript: params.witnessScript,
    bip32Derivation: [
      [params.payerPubkey, { fingerprint: params.payerDerivation.fingerprint, path: [...params.payerDerivation.path] }],
    ],
    sequence: 0xfffffffe,
  });
  tx.addOutput({ script: params.destinationScriptPubKey, amount: params.utxo.amountSats - params.feeSats });
  return tx.toPSBT();
}

/** Constant-time-shaped (length-checked first; no early exit that would leak a byte count from
 *  timing on equal-length inputs beyond what a plain loop already does) byte comparison used
 *  wherever this build compares a candidate witness/preimage against a hash-lock statement. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}
