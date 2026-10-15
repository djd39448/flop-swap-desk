// SPDX-License-Identifier: MIT
//
// The desk-facing `btc-htlc` adapter (P4-BTC-SPEC.md §4): a chain pin with an allow list
// (regtest, signet), a re-checked-before-every-write network guard, and keyless writes
// (fund/claim/refund) via a bitcoind wallet's own `walletprocesspsbt` — no private key, WIF,
// xprv, seed or mnemonic for either party ever exists anywhere in this build (§1). Every write
// runs `testmempoolaccept` before it ever broadcasts (the Bitcoin twin of the EVM leg's
// simulate-before-claim rule), and `claim()` re-checks its own deadline against fresh chain time
// as the very last read before broadcast, mirroring src/rails/evm-htlc.ts's `claim()`/
// `assertBeforeNotAfterMsOrThrow`.
//
// This stage (BB1) builds the primitive and the adapter; the pure, replayable evidence reader
// (`src/rails/btc-evidence.ts`, spec §5) and the rail-agnostic client wiring (spec §6/§7) are a
// later stage — `verifyLockFinal` is therefore intentionally not implemented here yet.
//
// Design source: flop-contrib/handoff/P4-BTC-SPEC.md §4;
// flop-contrib/handoff/research/btc-regtest-probe-2026-09-28.md.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Decimal, Transaction } from "@scure/btc-signer";

import {
  BTC_REGTEST_NETWORK,
  BTC_SIGNET_NETWORK,
  buildClaimPsbt,
  buildHtlcScript,
  buildRefundPsbt,
  bytesEqual,
  htlcSpendVsizeBound,
  locktimeFromRefundAfterMs,
  scriptPubKeyForAddress,
  type FundingUtxo,
  type HtlcSpendBranch,
} from "./btc-script.js";
import { quotedPinTextOrPlaceholder } from "./pin-text.js";
import { RpcCaptureError, type CapturingRpc } from "./rpc-capture.js";

export type BtcNetworkName = "regtest" | "signet";

export interface BtcChainPin {
  name: string;
  network: BtcNetworkName;
  /** `bip122:<first 32 hex chars of the genesis hash>` (P4-BTC-SPEC.md §0/§6). */
  caip2: string;
  /** `getblockhash 0`'s result — lowercase 64-hex. */
  genesisHash: string;
  finality: { confirmations: number };
  /**
   * P10 B3 (signet only): the signet challenge of the chain this pin names, lowercase hex, the script a block's solution must satisfy. The genesis
   * hash and the chain name are the same on every signet (a node started with its own `-signetchallenge` reports `signet` and the public signet's
   * genesis hash, proven on an offline Core 31.1 node), so only this value tells the public signet from a custom one whose blocks anyone can
   * make. `assertPinnedChain` compares `getblockchaininfo().signet_challenge` with the pin's own copy of it, never with the config's. Absent for
   * regtest, and optional in a config (a config written before this field carries none and is still checked against the build's own value);
   * a config that carries a different one is not a config for a chain this build knows (`validateBtcRailConfig`).
   */
  signetChallenge?: string;
}

/** No credentials here, ever (P4-BTC-SPEC.md §4 — "no credentials in the config"): RPC auth is
 *  the harness's/caller's own `CapturingRpc` header, never persisted alongside a rail config
 *  (`rails.json`, a capture index, a bundle). */
export interface BtcRailConfig {
  pin: BtcChainPin;
  endpoint: string;
  /** P4-BTC-FIXES.md H4: how many blocks past the funding height the evidence reader's spend
   *  scan will walk before giving up and failing closed, instead of an unbounded walk to the
   *  chain's own tip. Recorded verbatim in every capture's own `config` (A4) so a replay applies
   *  the exact bound the live sweep used. Defaults to `DEFAULT_SCAN_WINDOW_BLOCKS` when omitted. */
  scanWindowBlocks?: number;
  /** P4-BTC-FIXES-R3.md K3: the asset id this rail's own satoshis settle — an offer's declared
   *  `LockTerms.asset` must equal this before the Bitcoin rail ever locks/verifies/claims/refunds
   *  it (the reviewer's exploit: an offer labelled "USDC" against a `btc-htlc` leg, which this
   *  rail happily locked/verified before this fix, since nothing here ever checked the label
   *  against what it actually settles). Defaults to `BTC_ASSET_ID` when omitted. */
  asset?: string;
}

/** P4-BTC-FIXES-R3.md K3: this build's own single settled asset — see `BtcRailConfig.asset`. */
export const BTC_ASSET_ID = "BTC";

/** `config.asset`, defaulted to `BTC_ASSET_ID` — the one place every asset check in this file
 *  (and `btc-evidence.ts`) reads the configured asset id from. */
export function assetIdFor(config: BtcRailConfig): string {
  return config.asset ?? BTC_ASSET_ID;
}

/** P4-BTC-FIXES.md H4: ~2 weeks of mainnet blocks (10-minute spacing) — generous for regtest,
 *  where a scan finding nothing within this many blocks past funding is exceptionally unlikely
 *  to ever complete honestly, and unbounded is the actual defect being fixed. */
export const DEFAULT_SCAN_WINDOW_BLOCKS = 2016;

export function scanWindowFor(config: BtcRailConfig): number {
  return config.scanWindowBlocks ?? DEFAULT_SCAN_WINDOW_BLOCKS;
}

/** Regtest genesis confirmed live against Core 31.1 (probe Q6, and this build's own regtest
 *  harness). A confirmations count of 1 is a deliberate, documented choice for a build whose
 *  only chains are regtest (deterministic, single-node mining — "confirmed" only ever means "the
 *  one node that matters mined a block on top") and an as-yet-unverified signet pin; it is not a
 *  claim about what a real mainnet deployment would need (mainnet is out of scope, per spec §0).
 */
export const BTC_REGTEST_PIN: BtcChainPin = {
  name: "btc-regtest",
  network: "regtest",
  caip2: "bip122:0f9188f13cb7b2c71f2a335e3a4fc328",
  genesisHash: "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
  finality: { confirmations: 1 },
};

/** UNVERIFIED (P4-BTC-SPEC.md §4): this genesis hash is signet's well-known default value from
 *  public references (a public block explorer's signet API, 2026-10-05, G1-PREP section 4), never
 *  confirmed by this build against a live signet node — that confirmation is the desk operator's own G1 step
 *  (`bitcoin-cli -signet getblockhash 0` must print exactly `genesisHash` below, and `bitcoin-cli -signet getblockchaininfo` must report a
 *  `signet_challenge` equal to `signetChallenge` below, P10 B3), and the
 *  `-UNVERIFIED` suffix stays on `name` until it has been. Do not use this pin for a real
 *  deployment until it has; `connect()`'s own genesis check will simply refuse a live signet node
 *  if this value turns out to be wrong, so using it by mistake fails closed rather than silently
 *  mispinning. The value is also the double sha256 of signet's genesis header (time 1598918400,
 *  bits 0x1e0377ae, nonce 52613770), derived offline in tests/btc-htlc.test.ts: that shows the
 *  constant is the genesis of that header, not that a node agrees, so the suffix still waits for
 *  the live check.
 *
 *  P9-5: before this fix the genesis hash was 63 characters with a different tail, and the CAIP-2
 *  reference was 31 characters, so the pin failed this file's own shape check and no signet config
 *  could pass any entry point. Both are now exact: 64 lowercase hex, and `caip2` is `bip122:` plus
 *  the first 32 of them. */
export const BTC_SIGNET_PIN: BtcChainPin = {
  name: "btc-signet-UNVERIFIED",
  network: "signet",
  caip2: "bip122:00000008819873e925422c1ff0f99f7c",
  genesisHash: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
  finality: { confirmations: 1 },
  // P10 B3: the DEFAULT signet's challenge, a public constant (a 1-of-2 multisig script: OP_1, two compressed public keys, OP_2,
  // OP_CHECKMULTISIG; public keys only, no key material), derived, never typed from memory or fetched, from an offline Bitcoin Core 31.1
  // node: `bitcoind -signet -datadir=<a fresh scratch directory> -connect=0 -listen=0 -dnsseed=0 -fixedseeds=0 -rpcport=<a free port>`, then
  // `bitcoin-cli -signet ... getblockchaininfo` and its `signet_challenge` field (the same node answered `getblockhash 0` with the genesis
  // hash above). The node was stopped afterwards. Like the genesis hash it has not met a live public signet peer of this build yet: the desk
  // operator's G1 step is to check that their signet node answers exactly this value before the `-UNVERIFIED` suffix goes.
  signetChallenge:
    "512103ad5e0edad18cb1f0fc0d28a3d4f1f3e445640337489abb10404f2d1e086be430210359ef5021964fe22d6f8e05b2463c9540ce96883fe3b278760f048f5189f2e6c452ae",
};

/** Allow list, not a deny list (mirrors P22-P24-EVM-FIXES.md A3's rule for the EVM leg): only
 *  these two network names are ever accepted, so a live `getblockchaininfo().chain` of `"main"`,
 *  `"test"` or `"testnet4"` is refused by name, and so is anything nobody thought to name. */
const ALLOWED_NETWORKS: ReadonlySet<string> = new Set(["regtest", "signet"]);
const DENY_CHAIN_NAMES: ReadonlySet<string> = new Set(["main", "test", "testnet4"]);

/** P4-BTC-FIXES.md H3: every config this build ever trusts must pin one of these two chains
 *  exactly — a `(network, genesisHash)` pair that does not match either row here is not a config
 *  for a chain this build knows how to be safe on, no matter what its own `pin.name` claims to
 *  be. */
const KNOWN_PINS: readonly BtcChainPin[] = [BTC_REGTEST_PIN, BTC_SIGNET_PIN];

function knownPinFor(network: string, genesisHash: string): BtcChainPin | null {
  const lowerGenesis = genesisHash.toLowerCase();
  return KNOWN_PINS.find((pin) => pin.network === network && pin.genesisHash.toLowerCase() === lowerGenesis) ?? null;
}

const GENESIS_HASH_SHAPE = /^[0-9a-f]{64}$/;
const CAIP2_BIP122_SHAPE = /^bip122:[0-9a-f]{32}$/;
/** A signet challenge is a script: even-length lowercase hex, at most 1,000 bytes (a hand-written value is held to a bound; the real one is 71 bytes). */
const SIGNET_CHALLENGE_SHAPE = /^(?:[0-9a-f]{2}){1,1000}$/;

/**
 * Shape-only check on a config that could have come from untrusted/untyped data (a `--rails`
 * file, a captured `rails.json`), mirroring `evm-htlc.ts`'s `evmRailConfigShapeReason`. `null`
 * when the shape checks out; otherwise the first reason it doesn't.
 */
export function btcRailConfigShapeReason(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "btc rail config is not an object";
  const v = value as Record<string, unknown>;

  if (v.pin === null || typeof v.pin !== "object") return "btc rail config: pin is not an object";
  const pin = v.pin as Record<string, unknown>;
  if (typeof pin.name !== "string" || pin.name === "") return "btc rail config: pin.name must be a non-empty string";
  // Deliberately just "is this a non-empty string" here, not "is it regtest/signet" — the same
  // split `evm-htlc.ts` draws between `evmRailConfigShapeReason` (well-typed) and
  // `validateEvmRailConfig` (the allow list): a config that is well-SHAPED but pins an
  // off-allow-list network (say "main") must fail with the allow-list's own reason, from
  // `validateBtcRailConfig` below, not be rejected one step earlier as merely malformed.
  if (typeof pin.network !== "string" || pin.network === "") {
    return "btc rail config: pin.network must be a non-empty string";
  }
  if (typeof pin.genesisHash !== "string" || !GENESIS_HASH_SHAPE.test(pin.genesisHash)) {
    return "btc rail config: pin.genesisHash must be 64 lowercase hex chars";
  }
  if (typeof pin.caip2 !== "string" || !CAIP2_BIP122_SHAPE.test(pin.caip2)) {
    return 'btc rail config: pin.caip2 must be "bip122:<32 lowercase hex chars>"';
  }
  if (pin.caip2 !== `bip122:${pin.genesisHash.slice(0, 32)}`) {
    return "btc rail config: pin.caip2 does not match the first 32 hex chars of pin.genesisHash";
  }
  if (pin.finality === null || typeof pin.finality !== "object") return "btc rail config: pin.finality is not an object";
  const finality = pin.finality as Record<string, unknown>;
  if (typeof finality.confirmations !== "number" || !Number.isInteger(finality.confirmations) || finality.confirmations <= 0) {
    return "btc rail config: pin.finality.confirmations must be a positive integer";
  }
  // P10 B3: optional (a config written before the field existed has none); only its shape is checked here, and no refusal ever quotes it.
  if (pin.signetChallenge !== undefined && (typeof pin.signetChallenge !== "string" || !SIGNET_CHALLENGE_SHAPE.test(pin.signetChallenge))) {
    return "btc rail config: pin.signetChallenge must be lowercase hex of an even length when present";
  }

  if (typeof v.endpoint !== "string" || v.endpoint === "") return "btc rail config: endpoint must be a non-empty string";
  if (v.scanWindowBlocks !== undefined && (typeof v.scanWindowBlocks !== "number" || !Number.isInteger(v.scanWindowBlocks) || v.scanWindowBlocks <= 0)) {
    return "btc rail config: scanWindowBlocks must be a positive integer when present";
  }
  // K3: optional here (defaults to BTC_ASSET_ID via assetIdFor) — only its shape is checked;
  // btcEvidence/the client flows are what compare it against a leg's own declared asset.
  if (v.asset !== undefined && (typeof v.asset !== "string" || v.asset === "")) {
    return "btc rail config: asset must be a non-empty string when present";
  }
  return null;
}

/** Runtime checks that don't need a live chain: the pin's network is on the allow list.
 *  `connect()`/`assertPinnedChain()` additionally check the LIVE `getblockchaininfo().chain`
 *  against this same allow list before ever comparing it to the pin (defense in depth: even if
 *  `BtcChainPin.network`'s own type were ever widened, the runtime check still refuses a name
 *  nobody put on the list). */
export function validateBtcRailConfig(config: BtcRailConfig): void {
  // P10 B4 (the KR3-3 rule, src/rails/pin-text.ts): every pin text of a config that these refusals name is quoted only when it is a short plain
  // text. The refusals reach `watch.mjs --rails` and `audit-export --rails`, whose files have no key field, and a genesis hash is a run of 64 hex
  // digits, exactly the shape of a key, so a genesis hash is named only when it is one this build pins itself (a public constant).
  if (!ALLOWED_NETWORKS.has(config.pin.network)) {
    throw new Error(`btc-htlc: network ${quotedPinTextOrPlaceholder(config.pin.network)} is not on the allow list (regtest, signet only)`);
  }
  // H3: pin names tied to their network — a config cannot rename a known (network, genesisHash)
  // pair to a different `pin.name` (e.g. an index-only rename to "bitcoin-mainnet"), and cannot
  // pin a (network, genesisHash) pair this build does not itself know about at all.
  const known = knownPinFor(config.pin.network, config.pin.genesisHash);
  if (known === null) {
    const isPinnedGenesis = KNOWN_PINS.some((pin) => pin.genesisHash.toLowerCase() === String(config.pin.genesisHash).toLowerCase());
    throw new Error(
      `btc-htlc: (network ${quotedPinTextOrPlaceholder(config.pin.network)}, genesisHash ${
        isPinnedGenesis ? config.pin.genesisHash.toLowerCase() : "not one this build pins"
      }) does not match any known pin (btc-regtest, btc-signet-UNVERIFIED)`,
    );
  }
  if (config.pin.name !== known.name) {
    throw new Error(`btc-htlc: pin.name ${quotedPinTextOrPlaceholder(config.pin.name)} does not match the known pin's own name "${known.name}" for this (network, genesisHash)`);
  }
  // P10 B3: a config may carry the pin's own signet challenge and nothing else (it is never quoted: a hand-written value is untrusted text). The
  // live check always uses the build's own copy (`known.signetChallenge`), so a config that leaves the field out loses nothing.
  if (config.pin.signetChallenge !== undefined && config.pin.signetChallenge.toLowerCase() !== known.signetChallenge) {
    throw new Error(
      known.signetChallenge === undefined
        ? "btc-htlc: pin.signetChallenge is not a field of this pin (it has no signet challenge)"
        : "btc-htlc: pin.signetChallenge is not the signet challenge this build pins for this (network, genesisHash); a custom signet is not a chain this build knows",
    );
  }
}

export type BtcRailConfigCheck = { ok: true; config: BtcRailConfig } | { ok: false; reason: string };

export function checkBtcRailConfig(value: unknown): BtcRailConfigCheck {
  const shapeReason = btcRailConfigShapeReason(value);
  if (shapeReason !== null) return { ok: false, reason: shapeReason };
  const config = value as BtcRailConfig;
  try {
    validateBtcRailConfig(config);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, config };
}

function networkParamsFor(pin: BtcChainPin) {
  return pin.network === "regtest" ? BTC_REGTEST_NETWORK : BTC_SIGNET_NETWORK;
}

const HASH_LOCK_SHAPE = /^0x[0-9a-f]{64}$/; // matches tclk's own hash-statement grammar (0x + 64 lowercase hex)
const SECRET_SHAPE = /^0x[0-9a-f]{64}$/;
const PUBKEY_SHAPE = /^0[23][0-9a-f]{64}$/; // 33-byte compressed secp256k1 point, bare hex (Bitcoin convention)
const REF_SHAPE = /^[0-9a-f]{64}:[0-9]+$/;
const AMOUNT_SHAPE = /^(0|[1-9][0-9]*)$/;

/** The rail-agnostic-shaped terms for one Bitcoin HTLC leg — deliberately close to tclk's own
 *  `LockTerms` (0x-hex hash statement, decimal-string amount) so a later stage's client wiring
 *  can adapt one to the other without renaming fields; not itself `@flop-labs/tclk`'s
 *  `LockTerms` because that type also carries `contract`/`payer`/`payee` DIDs, which the D-08
 *  pubkey-line resolution (spec §6, a later stage) is what turns into `payeePubkey`/
 *  `payerPubkey` here. */
export interface BtcHtlcTerms {
  /** sha256(preimage) — `0x` + 64 lowercase hex. */
  hashLock: string;
  /** Satoshis, as a decimal-integer string (never a float — see `Decimal` below). */
  amountSats: string;
  /** `T = refundAfterMs / 1000`; validated by `locktimeFromRefundAfterMs`. */
  refundAfterMs: number;
  /** The Seller's pubkey (claim branch) — 33-byte compressed, bare lowercase hex. */
  payeePubkey: string;
  /** The Buyer's pubkey (refund branch) — 33-byte compressed, bare lowercase hex. */
  payerPubkey: string;
}

function validateTerms(terms: BtcHtlcTerms): void {
  if (!HASH_LOCK_SHAPE.test(terms.hashLock)) {
    throw new Error("btc-htlc: hashLock must be 0x + 64 lowercase hex (sha256 statement)");
  }
  if (!PUBKEY_SHAPE.test(terms.payeePubkey)) {
    throw new Error("btc-htlc: payeePubkey must be a 33-byte compressed pubkey (66 lowercase hex chars, 02/03 prefix)");
  }
  if (!PUBKEY_SHAPE.test(terms.payerPubkey)) {
    throw new Error("btc-htlc: payerPubkey must be a 33-byte compressed pubkey (66 lowercase hex chars, 02/03 prefix)");
  }
  if (!AMOUNT_SHAPE.test(terms.amountSats) || BigInt(terms.amountSats) <= 0n) {
    throw new Error("btc-htlc: amountSats must be a positive decimal-integer string");
  }
}

/**
 * P10 B3: the node answered a chain identity the pin does not name. `field` is the `getblockchaininfo` field that disagreed (today
 * `signet_challenge`), so a caller can tell this refusal from a plain wrong chain. The message quotes at most `PIN_FIELD_PREFIX_CHARS` characters
 * of what the node said, and only when it is hex; anything else is described, never quoted (the node's answer is its own to choose).
 */
export class BtcPinMismatchError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "BtcPinMismatchError";
    this.field = field;
  }
}

/** How many characters of a node's signet challenge a refusal may quote: the first six bytes. */
const PIN_FIELD_PREFIX_CHARS = 12;

/** A node's `signet_challenge` as a refusal may say it: absent, not a string, not hex, or at most a short prefix with its length. */
function describeSignetChallenge(value: unknown): string {
  if (value === undefined) return "is missing";
  if (typeof value !== "string") return "is not a string";
  if (!/^[0-9a-fA-F]*$/.test(value)) return "is not hex";
  const shown = value.slice(0, PIN_FIELD_PREFIX_CHARS);
  return value.length > PIN_FIELD_PREFIX_CHARS ? `begins ${shown}... (${value.length} hex characters)` : `is ${shown === "" ? "empty" : shown}`;
}

/**
 * P8-RESUME-SPEC.md: `testmempoolaccept` refused a transaction, so `sendrawtransaction` was never called and the
 * bytes provably never reached the network. Thrown from the same place, with the same message, the plain `Error`
 * used to be (`reason` is Core's own reject reason, e.g. `missing-inputs` or `txn-mempool-conflict`), so a caller
 * that matched on the message sees no change; a resume caller matches on the class instead. A transport failure
 * (the node unreachable, a malformed reply) is NOT this error: whether that transaction reached the node is unknown.
 */
export class BtcBroadcastRefusedError extends Error {
  readonly reason: string;
  constructor(reason: string | undefined) {
    super(`btc-htlc: refusing to broadcast \u2014 testmempoolaccept rejected it (${reason ?? "no reason given"})`);
    this.name = "BtcBroadcastRefusedError";
    this.reason = reason ?? "no reason given";
  }
}

/** P4-BTC-FIXES-R2.md R2-2: Core's own "No such mempool or blockchain transaction"/"Transaction
 *  not in mempool" answer (code -5) is the ONLY legitimate negative result for a lookup by txid
 *  — any other error (a transport failure, a malformed response, a rejected auth header) must
 *  propagate rather than be swallowed into the same "never reached the network" verdict a caller
 *  would otherwise treat as safe to act on (R2-1's own `resendRefundIfDropped` is exactly such a
 *  caller: it must never treat "the node timed out" as "safe to resend"). */
function isRpcNotFound(error: unknown): boolean {
  return error instanceof RpcCaptureError && error.code === -5;
}

function parseOutpointRef(ref: string): { txid: string; vout: number } {
  if (!REF_SHAPE.test(ref)) {
    throw new Error(`btc-htlc: ref must look like "<64-hex txid>:<vout>", got "${ref}"`);
  }
  const parts = ref.split(":");
  const txid = parts[0];
  const voutStr = parts[1];
  if (txid === undefined || voutStr === undefined) {
    throw new Error(`btc-htlc: ref must look like "<64-hex txid>:<vout>", got "${ref}"`); // unreachable given REF_SHAPE, kept for noUncheckedIndexedAccess
  }
  return { txid, vout: Number(voutStr) };
}

/** The signer's own public identity for one wallet call — never a private key. `pubkey` must
 *  equal `terms.payeePubkey` (claim) or `terms.payerPubkey` (fund/refund); `fingerprint`/`path`
 *  are that same wallet's own BIP32 derivation info (from its own `getaddressinfo`), so
 *  `walletprocesspsbt` can find and use its own already-owned key without ever importing one. */
export interface BtcSignerKey {
  pubkey: string;
  fingerprint: number;
  path: readonly number[];
}

export interface BtcWalletHandle {
  /** Every wallet RPC this call makes targets `/wallet/<wallet>` (`CapturingRpc`'s `path`). */
  wallet: string;
  key: BtcSignerKey;
}

/** Parse bitcoind's own `hdkeypath` string (e.g. `"m/84h/1h/0h/0/0"` — Core uses a trailing `h`
 *  for a hardened index, not `@scure/btc-signer`'s own `bip32Path` helper's `'`) into the index
 *  array `@scure/btc-signer`'s PSBT `bip32Derivation` field expects. */
export function parseHdKeyPath(hdkeypath: string): number[] {
  const parts = hdkeypath.split("/");
  if (parts[0] !== "m") {
    throw new Error(`btc-htlc: unexpected hdkeypath "${hdkeypath}" (expected to start with "m")`);
  }
  return parts.slice(1).map((segment) => {
    const hardened = segment.endsWith("h") || segment.endsWith("H") || segment.endsWith("'");
    const numeric = hardened ? segment.slice(0, -1) : segment;
    const n = Number(numeric);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`btc-htlc: unexpected hdkeypath segment "${segment}" in "${hdkeypath}"`);
    }
    return hardened ? n + 0x80000000 : n;
  });
}

/** Build a `BtcSignerKey` straight from one wallet's own `getaddressinfo` response — the
 *  convenience a regtest test (or a later client stage) uses instead of hand-parsing Core's
 *  fingerprint/path strings itself. Never touches a key: every field here is public. */
export function keyFromAddressInfo(info: { pubkey: string; hdmasterfingerprint: string; hdkeypath: string }): BtcSignerKey {
  return { pubkey: info.pubkey.toLowerCase(), fingerprint: Number(`0x${info.hdmasterfingerprint}`), path: parseHdKeyPath(info.hdkeypath) };
}

/** A fixed fee, in satoshis, subtracted from a claim/refund's single output. Fee estimation is
 *  out of scope for the regtest build (P4-BTC-SPEC.md section 0 scope note: "Out of scope: ... fees ..."),
 *  and regtest keeps this constant byte for byte. On signet (P9-5) it is the FLOOR of the fee
 *  rule below: the node's estimate may raise a claim's or refund's fee above it, never lower it. */
export const DEFAULT_FEE_SATS = 1000n;

/** Bitcoin's own standardness floor for a single output (BIP: any output below this is
 *  non-standard and most nodes/miners will never relay or mine a transaction that creates one).
 *  P4-BTC-FIXES.md G6. */
export const DUST_LIMIT_SATS = 546n;

/** G6 margin: extra headroom above the bare fee+dust floor. `amountSats` funds the P2WSH output
 *  itself; once a claim or refund subtracts `DEFAULT_FEE_SATS`, the single remaining output must
 *  still clear `DUST_LIMIT_SATS` — this margin keeps it comfortably clear rather than exactly on
 *  the line, a single satoshi of fee-estimate drift away from becoming non-standard. */
export const MIN_LOCKABLE_MARGIN_SATS = 500n;

/** G6: the smallest `amountSats` this rail will ever lock — the fixed fee plus the worst-case
 *  dust limit, with margin (spec: "the fixed fee plus the worst-case 546-sat dust limit, with
 *  margin"). The reviewer's 1,200-sat and 900-sat cases are both refused (this floor is 2,046
 *  sats). */
export const BTC_MIN_LOCKABLE_SATS: bigint = DEFAULT_FEE_SATS + DUST_LIMIT_SATS + MIN_LOCKABLE_MARGIN_SATS;

// -- P9-5: the signet fee rule ---------------------------------------------------------------

/**
 * How a network that prices its fee from the node (signet) chooses it. Plain integers on purpose: the rule sits in a
 * frozen policy object (`BTC_SIGNET_POLICY`, src/client/policy.ts) and is printed or compared with no BigInt.
 * Regtest has no rule (`btcFeeRuleFor("regtest")` is `null`): it keeps `DEFAULT_FEE_SATS` and makes no estimate call.
 *
 * What a build pays: the node's `estimatesmartfee` rate for `confTarget` blocks, clamped to
 * [`floorSatPerKvB`, `capSatPerKvB`]. A claim or refund pays that rate times an upper bound for its own size
 * (`htlcSpendVsizeBound`), never less than `floorFeeSats` in total, and never cut: P10 B2, a leg too small to pay that fee and keep its
 * output at the dust limit is refused (`BTC_SIGNET_MIN_LOCKABLE_SATS` at the lock guard, `BtcSpendUnaffordableError` in `spendFeeSatsFor`).
 * The funding transaction asks the wallet for that rate (`fee_rate`), since only the wallet knows how many inputs it will spend.
 */
export interface BtcFeeRule {
  /** `estimatesmartfee`'s `conf_target`, in blocks. */
  readonly confTarget: number;
  /** `estimatesmartfee`'s `estimate_mode`. */
  readonly estimateMode: "conservative" | "economical";
  /** The lowest fee rate this rule ever pays, in satoshis per 1000 virtual bytes. */
  readonly floorSatPerKvB: number;
  /** The highest fee rate this rule ever pays (the documented cap), in satoshis per 1000 virtual bytes. */
  readonly capSatPerKvB: number;
  /** The least a claim or refund ever pays in total, in satoshis: `DEFAULT_FEE_SATS`, the regtest fee. */
  readonly floorFeeSats: number;
}

/** `estimatesmartfee`'s target on signet: 6 blocks. `BTC_SIGNET_POLICY.claimInclusionMarginMs` is 60 minutes and
 *  signet's target block spacing is 10 minutes, so a claim priced for six blocks is expected to be mined inside the very
 *  margin that guards it (the Seller stops claiming once less than that margin is left before `refundAfterMs`). */
export const BTC_SIGNET_FEE_TARGET_BLOCKS = 6;

/** The floor of a signet fee RATE: 8 sat/vB. The smallest claim or refund this build can make is 132 virtual bytes (a
 *  P2WPKH destination), and 8 sat/vB over 132 bytes is 1,056 satoshis, so at this rate a claim or refund never pays
 *  less than `DEFAULT_FEE_SATS` (1,000), the fee every regtest build pays; the funding transaction gets the same floor
 *  as a rate. A test pins that relation. The node's estimate can only raise the rate above this. */
export const BTC_SIGNET_FEE_FLOOR_SAT_PER_VB = 8;

/** THE CAP on a signet fee RATE: 50 sat/vB, about six times the floor. It bounds an estimator that has gone wrong (a
 *  node with sparse data, a mis-set mempool, a lying endpoint), not any real fee market: whatever the node answers, a
 *  claim or refund pays at most 50 sat/vB over its own size (7,000 satoshis for a claim to a P2WPKH address, 7,600 to a
 *  P2WSH one). P10 B2: that fee is never cut to fit a small leg (it used to be capped at the funding amount less the
 *  dust limit, which paid a 2,046 satoshi leg 1,500 where the rule asked for 4,110, an underpriced claim sitting in the
 *  mempool with its preimage visible): a leg that cannot pay it is refused before anything is locked
 *  (`BTC_SIGNET_MIN_LOCKABLE_SATS`), and `spendFeeSatsFor` throws `BtcSpendUnaffordableError` for one that reaches it
 *  anyway. The cap is a rate: a funding transaction that the wallet builds from very many inputs pays that rate on a
 *  larger transaction. */
export const BTC_SIGNET_FEE_CAP_SAT_PER_VB = 50;

/** The signet fee rule (`BTC_SIGNET_POLICY.fee` is this same object). `conservative` because a claim that waits
 *  publishes the preimage in the mempool, where the Buyer can use it to take the other leg while its own refund is
 *  still open: a few hundred satoshis too much on a test network is the cheap side of that risk. */
export const BTC_SIGNET_FEE_RULE: BtcFeeRule = Object.freeze({
  confTarget: BTC_SIGNET_FEE_TARGET_BLOCKS,
  estimateMode: "conservative",
  floorSatPerKvB: BTC_SIGNET_FEE_FLOOR_SAT_PER_VB * 1000,
  capSatPerKvB: BTC_SIGNET_FEE_CAP_SAT_PER_VB * 1000,
  floorFeeSats: Number(DEFAULT_FEE_SATS),
});

/** The fee rule of a pinned network by its name: never a constructor option. `null` for regtest (fixed fee, no
 *  estimate call); throws for any name off the allow list. */
export function btcFeeRuleFor(network: string): BtcFeeRule | null {
  if (network === "regtest") return null;
  if (network === "signet") return BTC_SIGNET_FEE_RULE;
  throw new Error(`btc-htlc: no fee rule for network ${quotedPinTextOrPlaceholder(network)} (regtest, signet only)`);
}

/**
 * The fee rate, in satoshis per 1000 virtual bytes, an `estimatesmartfee` answer gives under `rule`. Pure. The node
 * answers `{ feerate: <BTC per 1000 vB>, blocks }`, or `{ errors: [...], blocks }` with no `feerate` when it lacks data.
 * An answer without a usable rate (absent, not a number, not finite, zero or negative) is the floor: the estimate is
 * advice and the floor is the fee every regtest build already pays, so a missing estimate never stops a swap step. A
 * usable rate is rounded to a whole satoshi per 1000 bytes (the answer has eight decimals of a bitcoin, so this is
 * exact) and clamped into [floor, cap]; one too large to be a safe integer is the cap.
 */
export function feeRateFromEstimate(rule: BtcFeeRule, answer: unknown): number {
  const feerate = typeof answer === "object" && answer !== null ? (answer as { feerate?: unknown }).feerate : undefined;
  if (typeof feerate !== "number" || !Number.isFinite(feerate) || feerate <= 0) return rule.floorSatPerKvB;
  const satPerKvB = Math.round(feerate * 1e8);
  if (!Number.isSafeInteger(satPerKvB)) return rule.capSatPerKvB;
  return Math.min(Math.max(satPerKvB, rule.floorSatPerKvB), rule.capSatPerKvB);
}

/**
 * P10 B2: a claim or refund of this funding cannot pay the fee the rule asks for and still leave an output at or above the dust limit. Thrown by
 * `spendFeeSatsFor` BEFORE anything is built or signed (nothing was sent, no fee was remembered), naming the numbers. The old rule cut such a fee to
 * the amount less the dust limit (a 2,046 satoshi leg paid 1,500 where the rule asked for 4,110), which left an underpriced claim in the mempool with
 * the preimage visible; now the leg is refused instead. The lock guard keeps a real leg out of this case (`BTC_SIGNET_MIN_LOCKABLE_SATS`), so a leg
 * the flows accepted never reaches it.
 */
export class BtcSpendUnaffordableError extends Error {
  readonly amountSats: bigint;
  readonly feeSats: bigint;
  readonly dustLimitSats: bigint;
  readonly vsize: number;
  readonly rateSatPerKvB: number;
  constructor(amountSats: bigint, feeSats: bigint, dustLimitSats: bigint, vsize: number, rateSatPerKvB: number) {
    super(
      `btc-htlc: refusing a spend of a ${amountSats} satoshi leg: the fee rule asks ${feeSats} satoshis (${rateSatPerKvB} sat per 1000 vB over ${vsize} vB), ` +
        `but the leg can pay at most ${amountSats > dustLimitSats ? amountSats - dustLimitSats : 0n} and keep its output at the ${dustLimitSats} satoshi dust limit; ` +
        "the fee is never cut to fit, so the leg is too small",
    );
    this.name = "BtcSpendUnaffordableError";
    this.amountSats = amountSats;
    this.feeSats = feeSats;
    this.dustLimitSats = dustLimitSats;
    this.vsize = vsize;
    this.rateSatPerKvB = rateSatPerKvB;
  }
}

/**
 * The whole fee, in satoshis, of one claim or refund of `fundingAmountSats` that is `vsize` virtual bytes at
 * `rateSatPerKvB` (clamped into the rule's range again here, so a caller cannot pass a rate outside it). Pure. Exactly
 * `ceil(rate * vsize / 1000)`, never less than `floorFeeSats`: the rule's own estimate, never cut. P10 B2: when that fee
 * would leave the single output under the dust limit, it throws `BtcSpendUnaffordableError` (the leg is too small for the
 * rule) instead of returning a smaller fee, so no leg that is accepted pays below the estimate.
 */
export function spendFeeSatsFor(rule: BtcFeeRule, rateSatPerKvB: number, vsize: number, fundingAmountSats: bigint): bigint {
  if (!Number.isSafeInteger(rateSatPerKvB) || rateSatPerKvB <= 0) throw new Error("btc-htlc: fee rate must be a positive integer (sat per 1000 vB)");
  if (!Number.isSafeInteger(vsize) || vsize <= 0) throw new Error("btc-htlc: vsize must be a positive integer");
  const clamped = Math.min(Math.max(rateSatPerKvB, rule.floorSatPerKvB), rule.capSatPerKvB);
  const rate = BigInt(clamped);
  let fee = (rate * BigInt(vsize) + 999n) / 1000n; // ceil(rate * vsize / 1000)
  const floor = BigInt(rule.floorFeeSats);
  if (fee < floor) fee = floor;
  if (fee > fundingAmountSats - DUST_LIMIT_SATS) throw new BtcSpendUnaffordableError(fundingAmountSats, fee, DUST_LIMIT_SATS, vsize, clamped);
  return fee;
}

/**
 * P10 B2: the witness script of this build's HTLC is 118 bytes (two 33-byte keys, a 4-byte locktime, a 32-byte hash and 16 bytes of opcodes and length bytes);
 * a locktime is at most `MAX_LOCKTIME` (0x7fffffff), which is also a 4-byte script number, so no valid terms make it longer. tests/btc-signet-fee.test.ts
 * pins this against `buildHtlcScript`.
 */
export const BTC_HTLC_WITNESS_SCRIPT_BYTES = 118;

/**
 * P10 B2: the longest scriptPubKey `scriptPubKeyForAddress` can return, which is the longest destination a claim or refund pays: 34 bytes (P2WSH and
 * P2TR; P2WPKH is 22, P2PKH 25, P2SH 23, and a witness program of another version or length is refused by the address decoder).
 */
export const BTC_MAX_DESTINATION_SCRIPT_BYTES = 34;

/**
 * P10 B2: the most a signet claim or refund can cost: the cap rate over the claim bound for the longest destination and the 118-byte script
 * (`ceil(50,000 x 152 / 1000)` = 7,600 satoshis). A refund is smaller (144 virtual bytes), and a leg is spent by one or the other, never both.
 */
export const BTC_SIGNET_MAX_SPEND_FEE_SATS: bigint =
  (BigInt(BTC_SIGNET_FEE_RULE.capSatPerKvB) * BigInt(htlcSpendVsizeBound("claim", BTC_HTLC_WITNESS_SCRIPT_BYTES, BTC_MAX_DESTINATION_SCRIPT_BYTES)) + 999n) / 1000n;

/**
 * P10 B2 (R1-FUND-05): the smallest `amountSats` a signet leg may lock: the most a claim or refund can cost (`BTC_SIGNET_MAX_SPEND_FEE_SATS`, 7,600) plus
 * the dust limit (546) plus the same 500 satoshi margin the regtest floor carries (`MIN_LOCKABLE_MARGIN_SATS`): 8,646. A leg below it is refused by
 * `BuyerFlow.bid` / `lockLegA` and `SellerFlow.acceptLegA` (the lock guard), before anything is locked; at or above it, the fee rule's own fee at any rate
 * the rule allows leaves the output above the dust limit, so `spendFeeSatsFor` never has to refuse an accepted leg. Regtest keeps `BTC_MIN_LOCKABLE_SATS`.
 */
export const BTC_SIGNET_MIN_LOCKABLE_SATS: bigint = BTC_SIGNET_MAX_SPEND_FEE_SATS + DUST_LIMIT_SATS + MIN_LOCKABLE_MARGIN_SATS;

/** The smallest lockable amount of a pinned network by its name: `BTC_MIN_LOCKABLE_SATS` on regtest, `BTC_SIGNET_MIN_LOCKABLE_SATS` on signet; throws for any name off the allow list. */
export function btcMinLockableSatsFor(network: string): bigint {
  if (network === "regtest") return BTC_MIN_LOCKABLE_SATS;
  if (network === "signet") return BTC_SIGNET_MIN_LOCKABLE_SATS;
  throw new Error(`btc-htlc: no minimum lockable amount for network ${quotedPinTextOrPlaceholder(network)} (regtest, signet only)`);
}

/** P4-BTC-FIXES.md H2: a funding transaction built and signed, but never yet broadcast — every
 *  field a caller needs to record BEFORE broadcasting (so a crash between `prepareFunding` and
 *  `broadcastFunding` leaves enough on disk to recover from, via `recoverFunding`, rather than
 *  either double-funding or losing track of the outpoint). */
export interface PreparedFunding {
  /** The funding outpoint this transaction will create once broadcast ("txid:vout") — already
   *  known here because `txid` is a hash of the transaction's own bytes, not of anything the
   *  network assigns on broadcast. */
  ref: string;
  txid: string;
  vout: number;
  /** The complete, wallet-signed transaction, hex-encoded — exactly what `broadcastFunding` will
   *  run `testmempoolaccept` then `sendrawtransaction` on. */
  rawTx: string;
  witnessScript: Uint8Array;
  address: string;
  terms: BtcHtlcTerms;
}

/** P4-BTC-FIXES.md H2: what `recoverFunding` can determine about a previously-prepared funding
 *  txid without ever needing to have broadcast it itself — the node's own view is the source of
 *  truth for "did this reach the network", not this process's own possibly-crashed memory of
 *  whether `broadcastFunding` returned. */
export interface RecoveredFunding {
  /** True once the node's own view (mempool or chain) already contains this txid — a caller
   *  recovering from an interruption between `broadcastFunding`'s own `testmempoolaccept` and its
   *  return should treat this as "already sent" and never broadcast it again. */
  broadcast: boolean;
  /** Null until the transaction has been mined. */
  blockHash: string | null;
  /** Null when `broadcast` is false (nothing to report a confirmation count for). */
  confirmations: number | null;
}

export interface WriteEvidence {
  /** The outpoint this write concerns: the newly created one for `fund`, or the one spent for
   *  `claim`/`refund`. */
  ref: string;
  /** This write's own transaction id. */
  txid: string;
  /** Always `null` immediately after broadcast (a regtest node never auto-mines) — populating
   *  these once a later read confirms the tx is the pure evidence reader's job (§5, a later
   *  stage), not this write's. */
  blockHeight: number | null;
  blockHash: string | null;
  /** Response sha256s of every exchange THIS write produced, in call order (P22-P24-EVM-FIXES.md
   *  A10's rule, reused here: a snapshot-at-start slice, never a `drain()` that could also sweep
   *  up an earlier, un-drained read). */
  raw: string[];
  /** P4-BTC-FIXES-R2.md R2-1: `refund()`'s own exact signed transaction bytes (hex), kept so a
   *  caller can re-send the IDENTICAL bytes later (`resendRefundIfDropped`) if they drop out of
   *  the mempool without confirming, rather than building (and therefore signing) a new refund.
   *  Absent from `fund()`/`claim()` — neither needs a retry-resend path today. */
  rawTx?: string;
}

/**
 * P8-RESUME-SPEC.md: the recorder `BtcHtlcRail.refund` accepts. `onSigned` is awaited with the refund's txid and
 * exact signed bytes after signing and before anything is sent; `onNotBroadcast` is called with the same pair when
 * `testmempoolaccept` refused the transaction (it provably never reached the network). Omitted: no behaviour change.
 */
export interface BtcRefundOptions {
  onSigned?: (signed: { txid: string; rawTx: string }) => void | Promise<void>;
  onNotBroadcast?: (signed: { txid: string; rawTx: string }) => void | Promise<void>;
}

/**
 * P10 B7: the recorder `BtcHtlcRail.claim` accepts, the claim's twin of `BtcRefundOptions` (record before send). `onSigned` is awaited with the claim's txid
 * and exact signed bytes once they are final and BEFORE the last deadline read and anything is sent, so a caller can persist them: a claim that is later
 * dropped from the mempool is re-sent as these very bytes (`resendClaim`), never rebuilt with another fee. `onNotBroadcast` is called with the same pair when
 * the claim provably never reached the network: the deadline guard refused it, or `testmempoolaccept` did. The bytes carry the preimage in their witness: they
 * are for the Seller's own record, never a log. Omitted: no behaviour change.
 */
export interface BtcClaimOptions {
  onSigned?: (signed: { txid: string; rawTx: string }) => void | Promise<void>;
  onNotBroadcast?: (signed: { txid: string; rawTx: string }) => void | Promise<void>;
}

/**
 * P10 B7: what the node says of ONE claim transaction a Seller signed, from its txid and the state of the funding output (`BtcHtlcRail.claimStatus`).
 * `mined`: it has a confirmation. `in-mempool`: the node holds it, unmined. `unknown`: the node does not know the txid and the funding output is still unspent
 * by anyone (mempool included): the claim was never sent or was dropped, and the identical bytes may be sent again. `spent-by-other`: the node does not know
 * the txid and the funding output is spent by another transaction (the Buyer's refund, most likely), so this claim can no longer land.
 */
export type BtcClaimStatus = "mined" | "in-mempool" | "unknown" | "spent-by-other";

/** P10 B7: what `BtcHtlcRail.resendClaim` settled: the node already had the claim (`mined`, `in-mempool`), the funding output is spent by another transaction (`spent-by-other`, nothing sent), or it sent the identical bytes (`in-mempool`). */
export type BtcClaimResend = "mined" | "in-mempool" | "spent-by-other";

export interface BtcHtlcRailOptions {
  config: BtcRailConfig;
  rpc: CapturingRpc;
  clock?: () => number;
  /**
   * P9-5 (signet only): the fee a claim or refund first used, kept for as long as this map lives, so a retry of the same
   * spend rebuilds the IDENTICAL transaction (P4-BTC-FIXES-R3.md K2: a lost broadcast reply is recognised on retry as
   * "already in the mempool" only when the bytes are the same, which a moved fee estimate would break). A flow's rail
   * passes one map to every `connect()`, because each flow step connects anew; without one each `BtcHtlcRail` keeps its
   * own. An entry is kept only while its transaction may have reached the node: a spend that fails before it is sent, or
   * that `testmempoolaccept` refuses, forgets its fee and is priced afresh on the next attempt. Regtest never writes it.
   */
  spendFees?: Map<string, bigint>;
}

function base64FromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * The desk's `btc-htlc` rail handle: one instance per party, bound to one pinned chain. Build it
 * with `BtcHtlcRail.connect(...)`, never `new` — connecting is where the chain pin gets checked
 * against reality.
 */
export class BtcHtlcRail {
  private readonly config: BtcRailConfig;
  private readonly rpc: CapturingRpc;
  private readonly clock: () => number;
  private readonly networkParams: ReturnType<typeof networkParamsFor>;
  /** P9-5: `null` on regtest (the fixed fee, no estimate call), the signet rule on signet; chosen by the pin's network name. */
  private readonly feeRule: BtcFeeRule | null;
  private readonly spendFees: Map<string, bigint>;

  private constructor(config: BtcRailConfig, rpc: CapturingRpc, clock: () => number, spendFees: Map<string, bigint>) {
    this.config = config;
    this.rpc = rpc;
    this.clock = clock;
    this.networkParams = networkParamsFor(config.pin);
    this.feeRule = btcFeeRuleFor(config.pin.network);
    this.spendFees = spendFees;
  }

  /**
   * Validates the config (shape + allow list), then checks `getblockchaininfo().chain` and
   * `getblockhash 0` against the pin — refusing a chain name off the allow list (naming `main`/
   * `test`/`testnet4` specifically when that's what it is) or a genesis hash that disagrees, the
   * same two checks `assertPinnedChain` re-runs before every write below.
   */
  static async connect(options: BtcHtlcRailOptions): Promise<BtcHtlcRail> {
    const configCheck = checkBtcRailConfig(options.config);
    if (!configCheck.ok) {
      throw new Error(`btc-htlc: refusing to connect — ${configCheck.reason}`);
    }
    const rail = new BtcHtlcRail(configCheck.config, options.rpc, options.clock ?? Date.now, options.spendFees ?? new Map());
    await rail.assertPinnedChain();
    // A10-equivalent: connect's own exchanges never linger into a later write's own
    // snapshot-at-start (`before = this.rpc.exchanges().length`).
    options.rpc.drain();
    return rail;
  }

  private async request<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.rpc.request({ method, params })) as T;
  }

  private async walletRequest<T>(wallet: string, method: string, params: unknown[]): Promise<T> {
    return (await this.rpc.request({ method, params, path: `/wallet/${wallet}` })) as T;
  }

  /** Re-checked before every write (mirrors P22-P24-EVM-FIXES.md A10's "re-check before every
   *  write" for the EVM leg): a long-lived rail instance drives an entire swap, and refusing to
   *  sign anywhere but the pinned chain is cheap insurance against a reused RPC endpoint having
   *  quietly started answering for a different chain since connect. */
  private async assertPinnedChain(): Promise<void> {
    const info = await this.request<{ chain: string; signet_challenge?: unknown }>("getblockchaininfo", []);
    if (!ALLOWED_NETWORKS.has(info.chain)) {
      throw new Error(
        `btc-htlc: chain "${info.chain}" is not on the allow list (regtest, signet only)` +
          (DENY_CHAIN_NAMES.has(info.chain) ? `; refusing ${info.chain} by name` : ""),
      );
    }
    if (info.chain !== this.config.pin.network) {
      throw new Error(
        `btc-htlc: connected chain "${info.chain}" does not match pin ${quotedPinTextOrPlaceholder(this.config.pin.name)} (expected ${quotedPinTextOrPlaceholder(this.config.pin.network)})`,
      );
    }
    // P10 B3: on signet the chain name and the genesis hash are the same on every signet, so the challenge is what tells the public signet from a
    // custom one (a node started with -signetchallenge=51, where anyone can mine). The expected value is this build's own copy for the pin
    // (`knownPinFor`), never the config's; a missing field, a non-string and any other value are refused, naming the field.
    if (this.config.pin.network === "signet") {
      const expected = knownPinFor(this.config.pin.network, this.config.pin.genesisHash)?.signetChallenge;
      if (expected === undefined) {
        throw new BtcPinMismatchError("signet_challenge", "btc-htlc: this build pins no signet challenge for this signet, refusing to connect");
      }
      const live = info.signet_challenge;
      if (typeof live !== "string" || live.toLowerCase() !== expected) {
        throw new BtcPinMismatchError(
          "signet_challenge",
          `btc-htlc: the node's signet_challenge ${describeSignetChallenge(live)}, not the default signet's challenge pinned by ${quotedPinTextOrPlaceholder(this.config.pin.name)} ` +
            `(it begins ${expected.slice(0, PIN_FIELD_PREFIX_CHARS)}...); a custom signet is not a chain this build knows`,
        );
      }
    }
    const genesisHash = await this.request<string>("getblockhash", [0]);
    if (genesisHash.toLowerCase() !== this.config.pin.genesisHash.toLowerCase()) {
      throw new Error(
        `btc-htlc: genesis hash ${genesisHash} does not match pin ${quotedPinTextOrPlaceholder(this.config.pin.name)} (expected ${this.config.pin.genesisHash})`,
      );
    }
  }

  /**
   * P9-5 (signet): the fee rate this build pays, in satoshis per 1000 virtual bytes: the node's `estimatesmartfee` under
   * the rule, clamped, or the floor when the node has no usable answer. ANY failure of the estimate call itself (an
   * error reply, a timeout, a transport fault) is the floor too: the estimate is advice, and a claim must not miss its
   * window because the node was slow to answer a question about fees. The call is a node-level read made before the
   * build, so a claim's last deadline guard (which follows the build) still comes after it.
   */
  private async feeRateSatPerKvB(rule: BtcFeeRule): Promise<number> {
    let answer: unknown;
    try {
      answer = await this.request<unknown>("estimatesmartfee", [rule.confTarget, rule.estimateMode]);
    } catch {
      return rule.floorSatPerKvB;
    }
    return feeRateFromEstimate(rule, answer);
  }

  /**
   * P9-5: the fee of one claim or refund. Regtest (no rule): `DEFAULT_FEE_SATS`, no call, no memory, exactly as before.
   * Signet: the fee this spend first used when there is one (`BtcHtlcRailOptions.spendFees`), else the estimate priced
   * for the spend's own size. The caller reports back through `settle`: `true` once the transaction may have reached the
   * node (the fee stays pinned for a retry), `false` when it failed before it was sent or `testmempoolaccept` refused it
   * (the fee is forgotten, so the next attempt prices afresh).
   */
  private async priceSpend(
    branch: HtlcSpendBranch,
    ref: string,
    fundingAmountSats: bigint,
    witnessScriptLength: number,
    destinationScriptPubKey: Uint8Array,
  ): Promise<{ feeSats: bigint; settle: (mayHaveReachedTheNode: boolean) => void }> {
    const rule = this.feeRule;
    if (rule === null) return { feeSats: DEFAULT_FEE_SATS, settle: () => {} };
    const key = `${branch}:${ref}:${bytesToHex(destinationScriptPubKey)}`;
    const settle = (mayHaveReachedTheNode: boolean): void => {
      if (!mayHaveReachedTheNode) this.spendFees.delete(key);
    };
    const pinned = this.spendFees.get(key);
    if (pinned !== undefined) return { feeSats: pinned, settle };
    const rate = await this.feeRateSatPerKvB(rule);
    const vsize = htlcSpendVsizeBound(branch, witnessScriptLength, destinationScriptPubKey.length);
    const feeSats = spendFeeSatsFor(rule, rate, vsize, fundingAmountSats);
    this.spendFees.set(key, feeSats);
    return { feeSats, settle };
  }

  /** Decode an on-chain output exactly (never Core's own float-BTC JSON amounts, which could
   *  lose satoshi precision) by reading the raw transaction and letting `@scure/btc-signer`
   *  decode its exact-bigint output amount. */
  private async readOutput(txid: string, vout: number): Promise<{ scriptPubKey: Uint8Array; amountSats: bigint }> {
    const rawHex = await this.request<string>("getrawtransaction", [txid, false]);
    const decoded = Transaction.fromRaw(hexToBytes(rawHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    if (vout >= decoded.outputsLength) {
      throw new Error(`btc-htlc: outpoint ${txid}:${vout} has no such output (tx has ${decoded.outputsLength})`);
    }
    const output = decoded.getOutput(vout);
    if (output.script === undefined || output.amount === undefined) {
      throw new Error(`btc-htlc: outpoint ${txid}:${vout} decoded with no script/amount`);
    }
    return { scriptPubKey: output.script, amountSats: output.amount };
  }

  /** P4-BTC-FIXES-R3.md K2: Core's own `testmempoolaccept` rejection reasons for "this exact
   *  transaction has already reached the node" — confirmed live against Core 31.1:
   *  `"txn-already-in-mempool"` (still sitting in the mempool); `"txn-already-known"` is kept too
   *  since other Core versions/paths (e.g. a since-CONFIRMED repeat) are documented to use it.
   *  Never any OTHER rejection reason (a genuine policy/consensus failure must still throw). */
  private static readonly ALREADY_KNOWN_REJECT_REASONS: ReadonlySet<string> = new Set(["txn-already-in-mempool", "txn-already-known"]);

  /**
   * `expectedTxid`, when given, is the txid this EXACT `rawHex` already deterministically hashes
   * to (computed locally before ever calling this — "sign-and-record, then broadcast"). One of
   * `ALREADY_KNOWN_REJECT_REASONS` is then recognized as success, not a fresh failure: it is the
   * practical shape a RETRY of an already-broadcast write takes after a lost reply (the node
   * accepted the original `sendrawtransaction` and this process simply never saw the response; a
   * byte-identical rebuild, thanks to deterministic signing, reproduces the identical bytes and
   * hits this exact rejection on retry). Every other rejection reason still throws, exactly as
   * before; a caller with no `expectedTxid` to offer gets today's behaviour unchanged for every
   * reason, "already known" included.
   */
  private async broadcastOrThrow(rawHex: string, expectedTxid?: string): Promise<string> {
    const acceptance = await this.request<Array<{ txid: string; allowed: boolean; "reject-reason"?: string }>>("testmempoolaccept", [
      [rawHex],
    ]);
    const result = acceptance[0];
    if (result === undefined) throw new Error("btc-htlc: testmempoolaccept returned no result");
    if (!result.allowed) {
      const reason = result["reject-reason"];
      if (expectedTxid !== undefined && reason !== undefined && BtcHtlcRail.ALREADY_KNOWN_REJECT_REASONS.has(reason)) {
        return expectedTxid;
      }
      throw new BtcBroadcastRefusedError(reason);
    }
    return await this.request<string>("sendrawtransaction", [rawHex]);
  }

  private finishWriteEvidence(ref: string, txid: string, before: number, rawTx?: string): WriteEvidence {
    const raw = this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
    return { ref, txid, blockHeight: null, blockHash: null, raw, ...(rawTx === undefined ? {} : { rawTx }) };
  }

  /** The chain's tip block time, in ms. One of the two chain-time helpers spec §4 asks for.
   *
   *  P4-BTC-FIXES-R3.md K6: fails closed unless `getblockchaininfo().time` is a finite integer —
   *  a missing/malformed field became `NaN` here before this fix, and `NaN * 1000` stays `NaN`,
   *  which makes EVERY `>=`/`<` deadline comparison built on it silently evaluate to `false` (a
   *  claim's own `assertChainTimeBeforeOrThrow` would then never refuse, no matter how far past
   *  its deadline). Never guess a time; throw instead. */
  async tipBlockTimeMs(): Promise<number> {
    const info = await this.request<{ time: unknown }>("getblockchaininfo", []);
    if (typeof info.time !== "number" || !Number.isFinite(info.time) || !Number.isInteger(info.time)) {
      throw new Error("btc-htlc: getblockchaininfo did not return a finite integer tip time (time) — refusing to guess a chain-time deadline");
    }
    return info.time * 1000;
  }

  /** The chain's median time past (the last 11 blocks), in ms — what CLTV's `after(T)` branch is
   *  actually checked against, and the second chain-time helper spec §4 asks for.
   *
   *  P4-BTC-FIXES-R3.md K6: the same fail-closed rule as `tipBlockTimeMs` — a missing/malformed
   *  `mediantime` must throw, never silently become `NaN` and let a deadline comparison built on
   *  it pass by accident. */
  async medianTimePastMs(): Promise<number> {
    const info = await this.request<{ mediantime: unknown }>("getblockchaininfo", []);
    if (typeof info.mediantime !== "number" || !Number.isFinite(info.mediantime) || !Number.isInteger(info.mediantime)) {
      throw new Error("btc-htlc: getblockchaininfo did not return a finite integer median time past (mediantime) — refusing to guess a chain-time deadline");
    }
    return info.mediantime * 1000;
  }

  /** P22-P24-EVM-FIXES-R3.md E4's rule, reused here: the claim's deadline guard is read fresh and
   *  re-checked as the LAST thing before broadcast — no earlier read (however recent) is trusted
   *  for this. */
  private async assertChainTimeBeforeOrThrow(notAfterMs: number): Promise<void> {
    const tipMs = await this.tipBlockTimeMs();
    const chainNow = Math.max(tipMs, this.clock());
    if (chainNow >= notAfterMs) {
      throw new Error(`btc-htlc: refusing to broadcast claim — chain time ${chainNow} is at/after the given deadline (notAfterMs ${notAfterMs})`);
    }
  }

  /** Shared build logic for `prepareFunding`/`fund` — never touches `testmempoolaccept` or
   *  `sendrawtransaction`; callers re-check the chain pin themselves before calling this, since
   *  it has no re-check of its own (P4-BTC-FIXES.md H2). */
  private async buildFundingPsbt(terms: BtcHtlcTerms, buyer: BtcWalletHandle): Promise<PreparedFunding> {
    const locktime = locktimeFromRefundAfterMs(terms.refundAfterMs);
    const hashLockBytes = hexToBytes(terms.hashLock.slice(2));
    const payeePubkey = hexToBytes(terms.payeePubkey);
    const payerPubkey = hexToBytes(terms.payerPubkey);
    const { address, scriptPubKey, witnessScript } = buildHtlcScript({ hashLock: hashLockBytes, payeePubkey, payerPubkey, locktime }, this.networkParams);

    const amountBtc = Decimal.encode(BigInt(terms.amountSats));
    // H2: build via walletcreatefundedpsbt (an output to the HTLC address for exactly
    // terms.amountSats, coin-selected and change-handled by the wallet's own keyless logic) +
    // walletprocesspsbt (sign AND finalize in one call, exactly like claim/refund) — never
    // sendtoaddress, which broadcasts on its own with no testmempoolaccept in between.
    // P9-5: on signet the wallet is told the rate (`fee_rate`, sat/vB), so its own estimator, which a fresh signet node
    // may have no data for, is never consulted; on regtest the options stay `{}`, byte for byte.
    const fundingOptions: Record<string, unknown> = {};
    if (this.feeRule !== null) fundingOptions.fee_rate = (await this.feeRateSatPerKvB(this.feeRule)) / 1000;
    const created = await this.walletRequest<{ psbt: string }>(buyer.wallet, "walletcreatefundedpsbt", [[], [{ [address]: amountBtc }], 0, fundingOptions, true]);
    const processed = await this.walletRequest<{ complete: boolean; hex?: string }>(buyer.wallet, "walletprocesspsbt", [created.psbt]);
    if (!processed.complete || processed.hex === undefined) {
      throw new Error("btc-htlc: walletprocesspsbt did not produce a complete, finalized funding transaction");
    }

    const decoded = Transaction.fromRaw(hexToBytes(processed.hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const scriptPubKeyHex = bytesToHex(scriptPubKey);
    let vout = -1;
    for (let i = 0; i < decoded.outputsLength; i += 1) {
      const output = decoded.getOutput(i);
      if (output.script !== undefined && bytesToHex(output.script) === scriptPubKeyHex) {
        vout = i;
        break;
      }
    }
    if (vout === -1) {
      throw new Error("btc-htlc: funding transaction has no output paying the HTLC address (unexpected)");
    }
    const txid = decoded.id;
    return { ref: `${txid}:${vout}`, txid, vout, rawTx: processed.hex, witnessScript, address, terms };
  }

  /**
   * H2: build and sign the funding transaction — via `walletcreatefundedpsbt` +
   * `walletprocesspsbt`, exactly like `claim`/`refund` — and return it **before any broadcast**,
   * so a caller can record `{ ref, rawTx, ... }` first (P4-BTC-SPEC.md §7a's "record before
   * sending" rule) and only then call `broadcastFunding`. Re-checks the pinned chain itself,
   * exactly like every other write.
   */
  async prepareFunding(terms: BtcHtlcTerms, buyer: BtcWalletHandle): Promise<PreparedFunding> {
    validateTerms(terms);
    if (buyer.key.pubkey.toLowerCase() !== terms.payerPubkey.toLowerCase()) {
      throw new Error("btc-htlc: fund must be signed by the payer's own wallet (buyer.key.pubkey must equal terms.payerPubkey)");
    }
    await this.assertPinnedChain();
    return this.buildFundingPsbt(terms, buyer);
  }

  /**
   * H2: `testmempoolaccept` then `sendrawtransaction` on a transaction `prepareFunding` already
   * built and signed — the only path by which a prepared funding transaction ever reaches the
   * network. Re-checks the pinned chain itself (a caller may call this a while after
   * `prepareFunding`, e.g. after recording it to disk first).
   */
  async broadcastFunding(prepared: PreparedFunding): Promise<WriteEvidence> {
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    const txid = await this.broadcastOrThrow(prepared.rawTx);
    return this.finishWriteEvidence(prepared.ref, txid, before);
  }

  /**
   * P8-RESUME-SPEC.md "Buyer lock A": re-send a funding transaction that `prepareFunding` built and a caller
   * persisted (`rawTx`, with its `ref`) when the process died around `broadcastFunding` and the node does not know
   * the txid. Never builds or signs anything: the identical bytes are checked locally against the ref's own txid
   * (so a swapped or truncated `rawTx` is refused before any call), then `testmempoolaccept` + `sendrawtransaction`
   * exactly as `broadcastFunding` does, except that Core's "already known" answer counts as success (the first
   * broadcast, or a concurrent resend, got there first; resending identical bytes cannot create a second outpoint).
   * A refusal by `testmempoolaccept` (inputs spent, a conflicting transaction, a policy rejection) is a
   * `BtcBroadcastRefusedError`: a caller must NOT answer it by funding again.
   */
  async rebroadcastFunding(ref: string, rawTx: string): Promise<WriteEvidence> {
    const { txid: refTxid } = parseOutpointRef(ref);
    let decodedTxid: string;
    try {
      decodedTxid = Transaction.fromRaw(hexToBytes(rawTx), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;
    } catch {
      throw new Error("btc-htlc: the recorded funding rawTx does not decode as a transaction");
    }
    if (decodedTxid !== refTxid) {
      throw new Error("btc-htlc: the recorded funding rawTx does not hash to the ref's txid, refusing to broadcast it");
    }
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    const txid = await this.broadcastOrThrow(rawTx, refTxid);
    return this.finishWriteEvidence(ref, txid, before);
  }

  /**
   * H2: recover a previously-prepared funding's own on-chain status by its txid alone — for a
   * caller resuming after an interruption between `broadcastFunding`'s own `testmempoolaccept`
   * and its return, which must never re-broadcast blindly without first checking whether the
   * node's own view (mempool or chain) already has it. Reads `getrawtransaction(txid, true)`
   * (the harness runs `-txindex=1`, so this answers for a mempool-only tx too, not only a mined
   * one); a "no such transaction" answer means "never reached the network" (`broadcast: false`),
   * never a thrown exception.
   *
   * P4-BTC-FIXES-R2.md R2-2: ONLY an `RpcCaptureError` carrying Core's own "No such mempool or
   * blockchain transaction" code (-5) may return `broadcast: false` — every other error (a
   * transport failure, a malformed response, an unexpected JSON-RPC error code) throws. Before
   * this fix, ANY error here — including one that says nothing about whether the transaction was
   * ever broadcast — was silently folded into "never reached the network", which is unsound: a
   * caller acting on that verdict (R2-1's own `resendRefundIfDropped`) could then re-send a
   * refund that was, in fact, already confirmed or still safely pending, on nothing more than a
   * blip the node happened to answer with a different error shape.
   */
  async recoverFunding(txid: string): Promise<RecoveredFunding> {
    await this.assertPinnedChain();
    let result: { confirmations?: unknown; blockhash?: unknown };
    try {
      result = await this.request<{ confirmations?: unknown; blockhash?: unknown }>("getrawtransaction", [txid, true]);
    } catch (error) {
      if (isRpcNotFound(error)) return { broadcast: false, blockHash: null, confirmations: null };
      throw error;
    }
    const confirmations = typeof result.confirmations === "number" && Number.isInteger(result.confirmations) ? result.confirmations : 0;
    const blockHash = typeof result.blockhash === "string" ? result.blockhash : null;
    return { broadcast: true, blockHash, confirmations };
  }

  /**
   * R1-01 (part 2): whether the funding output `ref` names is still unspent by anyone, the mempool included
   * (`gettxout(txid, vout, true)`). A read: it never sends anything. `false` means another transaction (most likely a
   * claim, mined or not) already spends it, so a refund of it can no longer land; `true` says nothing more than "not
   * spent yet". `resendRefundIfDropped` makes the same read before it re-sends.
   */
  async fundingOutputUnspent(ref: string): Promise<boolean> {
    const { txid, vout } = parseOutpointRef(ref);
    await this.assertPinnedChain();
    const txout = await this.request<Record<string, unknown> | null>("gettxout", [txid, vout, true]);
    return txout !== null;
  }

  /**
   * P4-BTC-FIXES-R2.md R2-1: idempotent resend of a previously-broadcast refund whose bytes are
   * already recorded (`refundRawTx`, `refund()`'s own `WriteEvidence.rawTx`) — NEVER rebuilds or
   * re-signs anything; resending identical bytes always reproduces the identical `refundTxid` (a
   * hash of those exact bytes), so this can only ever confirm the same write is back in the
   * mempool, never create a new one. Only actually re-sends when ALL of:
   *
   *  1. `refundTxid` is not currently sitting in the mempool (`getmempoolentry` answers "not
   *     found" — R2-2's own code-(-5)-only rule applies here too);
   *  2. it is not confirmed either (`recoverFunding`: fewer than 1 confirmation, or never seen at
   *     all); and
   *  3. the funding outpoint remains unspent by ANYONE, considering the mempool too
   *     (`gettxout(..., true)`) — so a claim that has already reached the mempool (not yet mined)
   *     is never raced by a blind resend; the caller's own evidence read is what discovers that.
   *
   * Never throws for a chain-state reason; a genuine transport failure from any of its own reads
   * propagates (the same R2-2 discipline).
   */
  async resendRefundIfDropped(ref: string, refundTxid: string, refundRawTx: string): Promise<{ resent: boolean; txid: string; raw: string[] }> {
    const { txid: fundTxid, vout: fundVout } = parseOutpointRef(ref);
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    const done = (resent: boolean, txid: string) => ({ resent, txid, raw: this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256) });

    try {
      await this.request("getmempoolentry", [refundTxid]);
      return done(false, refundTxid); // still pending in the mempool — nothing dropped
    } catch (error) {
      if (!isRpcNotFound(error)) throw error;
    }

    const recovered = await this.recoverFunding(refundTxid);
    if (recovered.confirmations !== null && recovered.confirmations >= 1) {
      return done(false, refundTxid); // already confirmed
    }

    const txout = await this.request<Record<string, unknown> | null>("gettxout", [fundTxid, fundVout, true]);
    if (txout === null) {
      // Spent by something else (most likely a claim, not yet or already confirmed) — never
      // resend blind; the caller's own evidence read (verifyLockFinal) discovers and reports this.
      return done(false, refundTxid);
    }

    const sentTxid = await this.broadcastOrThrow(refundRawTx, refundTxid);
    if (sentTxid !== refundTxid) {
      // Unreachable given identical bytes hash deterministically to the identical txid — kept as
      // a loud sanity check rather than silently returning a mismatched ref/txid pair.
      throw new Error("btc-htlc: resending the recorded refund produced a different txid than recorded (unexpected)");
    }
    return done(true, sentTxid);
  }

  /**
   * Back-compat convenience for existing callers (P4-BTC-FIXES.md H2: "keep the old fund()
   * working"): `prepareFunding` immediately followed by `broadcastFunding`, with a single
   * re-check of the pinned chain (not two), and `raw` covering every exchange both steps made —
   * exactly one HTLC output funded, `testmempoolaccept` always run before `sendrawtransaction`.
   * A caller that wants to record the prepared funding before it is broadcast (G3's own "record
   * before sending" rule) calls `prepareFunding`/`broadcastFunding` directly instead.
   */
  async fund(terms: BtcHtlcTerms, buyer: BtcWalletHandle): Promise<WriteEvidence> {
    validateTerms(terms);
    if (buyer.key.pubkey.toLowerCase() !== terms.payerPubkey.toLowerCase()) {
      throw new Error("btc-htlc: fund must be signed by the payer's own wallet (buyer.key.pubkey must equal terms.payerPubkey)");
    }
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    const prepared = await this.buildFundingPsbt(terms, buyer);
    const txid = await this.broadcastOrThrow(prepared.rawTx);
    return this.finishWriteEvidence(prepared.ref, txid, before);
  }

  /**
   * Builds the claim PSBT (witness_utxo + witnessScript + bip32_derivation for the seller's own
   * key + the BIP174 sha256 preimage field), has `seller`'s own wallet sign AND finalize it in
   * one `walletprocesspsbt` call, re-checks `notAfterMs` against fresh chain time as the very
   * last read, runs `testmempoolaccept`, and only then broadcasts.
   *
   * P10 B7 (record before send): `options.onSigned` is awaited with the claim's txid and exact bytes after signing and before that last read, so a caller
   * can persist them; the deadline read is still the last RPC before `testmempoolaccept`. If the deadline refuses the claim, or `testmempoolaccept` does,
   * `options.onNotBroadcast` hears of it (the bytes never reached the network). The return says the claim was ACCEPTED by this node, not that it is mined.
   */
  async claim(
    ref: string,
    terms: BtcHtlcTerms,
    secretHex: string,
    seller: BtcWalletHandle,
    destinationAddress: string,
    notAfterMs: number,
    options: BtcClaimOptions = {},
  ): Promise<WriteEvidence> {
    const { txid: fundTxid, vout: fundVout } = parseOutpointRef(ref);
    validateTerms(terms);
    if (!SECRET_SHAPE.test(secretHex)) {
      throw new Error("btc-htlc: secret must be 0x + 64 lowercase hex");
    }
    if (seller.key.pubkey.toLowerCase() !== terms.payeePubkey.toLowerCase()) {
      throw new Error("btc-htlc: claim must be signed by the payee's own wallet (seller.key.pubkey must equal terms.payeePubkey)");
    }
    const preimage = hexToBytes(secretHex.slice(2));
    const hashLockBytes = hexToBytes(terms.hashLock.slice(2));
    if (!bytesEqual(sha256(preimage), hashLockBytes)) {
      throw new Error("btc-htlc: secret does not open hashLock (sha256 mismatch) — refusing to build a claim that can never verify");
    }

    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;

    const locktime = locktimeFromRefundAfterMs(terms.refundAfterMs);
    const payeePubkey = hexToBytes(terms.payeePubkey);
    const payerPubkey = hexToBytes(terms.payerPubkey);
    const { witnessScript, scriptPubKey } = buildHtlcScript({ hashLock: hashLockBytes, payeePubkey, payerPubkey, locktime }, this.networkParams);

    const funding = await this.readOutput(fundTxid, fundVout);
    if (!bytesEqual(funding.scriptPubKey, scriptPubKey)) {
      throw new Error("btc-htlc: funding output does not match the HTLC script for these terms — refusing to claim");
    }
    if (funding.amountSats <= DEFAULT_FEE_SATS) {
      throw new Error("btc-htlc: funding amount does not cover the fixed fee");
    }
    const destinationScriptPubKey = scriptPubKeyForAddress(destinationAddress, this.networkParams);

    // P9-5: regtest pays `DEFAULT_FEE_SATS` with no call; signet prices the claim from the node (before the build, so the
    // deadline guard below is still the last read) and pins that fee for a retry of this same claim.
    const price = await this.priceSpend("claim", ref, funding.amountSats, witnessScript.length, destinationScriptPubKey);
    let mayHaveReachedTheNode = false;
    try {
      const utxo: FundingUtxo = { txid: fundTxid, vout: fundVout, scriptPubKey: funding.scriptPubKey, amountSats: funding.amountSats };
      const psbt = buildClaimPsbt({
        utxo,
        witnessScript,
        hashLock: hashLockBytes,
        preimage,
        payeePubkey,
        payeeDerivation: { fingerprint: seller.key.fingerprint, path: seller.key.path },
        destinationScriptPubKey,
        feeSats: price.feeSats,
      });

      const processed = await this.walletRequest<{ complete: boolean; hex?: string }>(seller.wallet, "walletprocesspsbt", [base64FromBytes(psbt)]);
      if (!processed.complete || processed.hex === undefined) {
        throw new Error("btc-htlc: walletprocesspsbt did not produce a complete, finalized claim transaction");
      }

      // P4-BTC-FIXES-R3.md K2: "sign-and-record, then broadcast" - this transaction's own txid is
      // already fully determined by its own signed bytes (a hash of them), knowable before ever
      // broadcasting. Recording it here (a local decode, no RPC of its own) means a caller retrying
      // after a lost broadcast reply reproduces the IDENTICAL bytes (deterministic signing) and this
      // same txid, so `broadcastOrThrow` recognizes Core's own "already known" answer as success.
      const claimTxid = Transaction.fromRaw(hexToBytes(processed.hex), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;

      // P10 B7 (record before send): the signed bytes are handed to the caller (awaited) BEFORE anything is sent, so a restart can find this one claim again
      // (and send it again, byte for byte, if it drops out of the mempool) instead of signing a second. It comes before the deadline read below, which stays
      // the last read before `testmempoolaccept`: a claim the deadline then refuses is reported through `onNotBroadcast`.
      const signed = { txid: claimTxid, rawTx: processed.hex };
      if (options.onSigned !== undefined) await options.onSigned(signed);

      // The deadline guard is the LAST read before broadcast - nothing but testmempoolaccept and
      // the broadcast itself follow.
      try {
        await this.assertChainTimeBeforeOrThrow(notAfterMs);
      } catch (error) {
        if (options.onNotBroadcast !== undefined) await options.onNotBroadcast(signed);
        throw error;
      }

      let txid: string;
      try {
        mayHaveReachedTheNode = true;
        txid = await this.broadcastOrThrow(processed.hex, claimTxid);
      } catch (error) {
        // `testmempoolaccept` refused it: `sendrawtransaction` was never called, so these bytes never reached the network.
        if (error instanceof BtcBroadcastRefusedError && options.onNotBroadcast !== undefined) await options.onNotBroadcast(signed);
        throw error;
      }
      return this.finishWriteEvidence(ref, txid, before);
    } catch (error) {
      // A `testmempoolaccept` refusal means the bytes provably never reached the network: the fee is forgotten.
      price.settle(mayHaveReachedTheNode && !(error instanceof BtcBroadcastRefusedError));
      throw error;
    }
  }

  /**
   * Builds the refund PSBT (global `nLockTime = T`, `witness_utxo` + `witnessScript` +
   * `bip32_derivation` for the buyer's own key), has `buyer`'s own wallet sign AND finalize it —
   * which succeeds regardless of whether the chain's median time past has reached `T` yet (probe
   * Q4) — then runs `testmempoolaccept`, which is what actually rejects it as "non-final" before
   * MTP passes `T` and accepts it after.
   */
  async refund(
    ref: string,
    terms: BtcHtlcTerms,
    buyer: BtcWalletHandle,
    destinationAddress: string,
    options: BtcRefundOptions = {},
  ): Promise<WriteEvidence> {
    const { txid: fundTxid, vout: fundVout } = parseOutpointRef(ref);
    validateTerms(terms);
    if (buyer.key.pubkey.toLowerCase() !== terms.payerPubkey.toLowerCase()) {
      throw new Error("btc-htlc: refund must be signed by the payer's own wallet (buyer.key.pubkey must equal terms.payerPubkey)");
    }

    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;

    const locktime = locktimeFromRefundAfterMs(terms.refundAfterMs);
    const payeePubkey = hexToBytes(terms.payeePubkey);
    const payerPubkey = hexToBytes(terms.payerPubkey);
    const hashLockBytes = hexToBytes(terms.hashLock.slice(2));
    const { witnessScript, scriptPubKey } = buildHtlcScript({ hashLock: hashLockBytes, payeePubkey, payerPubkey, locktime }, this.networkParams);

    const funding = await this.readOutput(fundTxid, fundVout);
    if (!bytesEqual(funding.scriptPubKey, scriptPubKey)) {
      throw new Error("btc-htlc: funding output does not match the HTLC script for these terms — refusing to refund");
    }
    if (funding.amountSats <= DEFAULT_FEE_SATS) {
      throw new Error("btc-htlc: funding amount does not cover the fixed fee");
    }
    const destinationScriptPubKey = scriptPubKeyForAddress(destinationAddress, this.networkParams);

    // P9-5: as in `claim()`: `DEFAULT_FEE_SATS` on regtest, the node's estimate on signet, pinned for a retry.
    const price = await this.priceSpend("refund", ref, funding.amountSats, witnessScript.length, destinationScriptPubKey);
    let mayHaveReachedTheNode = false;
    try {
      const utxo: FundingUtxo = { txid: fundTxid, vout: fundVout, scriptPubKey: funding.scriptPubKey, amountSats: funding.amountSats };
      const psbt = buildRefundPsbt({
        utxo,
        witnessScript,
        locktime,
        payerPubkey,
        payerDerivation: { fingerprint: buyer.key.fingerprint, path: buyer.key.path },
        destinationScriptPubKey,
        feeSats: price.feeSats,
      });

      const processed = await this.walletRequest<{ complete: boolean; hex?: string }>(buyer.wallet, "walletprocesspsbt", [base64FromBytes(psbt)]);
      if (!processed.complete || processed.hex === undefined) {
        throw new Error("btc-htlc: walletprocesspsbt did not produce a complete, finalized refund transaction");
      }

      // P4-BTC-FIXES-R3.md K2: same "sign-and-record, then broadcast" rule as `claim()` above - the
      // deterministic txid, known from the signed bytes alone, before ever broadcasting.
      const refundTxid = Transaction.fromRaw(hexToBytes(processed.hex), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;

      // P8-RESUME-SPEC.md rule 1: the signed bytes are handed to the caller (awaited) BEFORE anything is sent, so a
      // restart can find this one refund again instead of signing a second.
      const signed = { txid: refundTxid, rawTx: processed.hex };
      if (options.onSigned !== undefined) await options.onSigned(signed);
      let txid: string;
      try {
        mayHaveReachedTheNode = true;
        txid = await this.broadcastOrThrow(processed.hex, refundTxid);
      } catch (error) {
        // `testmempoolaccept` refused it: `sendrawtransaction` was never called, so these bytes never reached the network.
        if (error instanceof BtcBroadcastRefusedError) {
          mayHaveReachedTheNode = false;
          if (options.onNotBroadcast !== undefined) await options.onNotBroadcast(signed);
        }
        throw error;
      }
      // R2-1: record the exact signed bytes broadcast, so a later retry can re-send the IDENTICAL
      // transaction if it drops out of the mempool without confirming (`resendRefundIfDropped`).
      return this.finishWriteEvidence(ref, txid, before, processed.hex);
    } catch (error) {
      // A `testmempoolaccept` refusal means the bytes provably never reached the network: the fee is forgotten.
      price.settle(mayHaveReachedTheNode && !(error instanceof BtcBroadcastRefusedError));
      throw error;
    }
  }

  /**
   * Bounded block scan (spec §4) for the transaction that spent `ref`, between `fromHeight` and
   * the current tip: returns the 32-byte witness item (as `0x`-hex) whose sha256 equals
   * `hashLockHex` — the secret `s` — or `null` when `ref` is unspent, was spent by the refund
   * branch instead (no witness item opens the hash), or the scan window closes first.
   */
  /**
   * P4-BTC-FIXES-R3.md K1: does ANY transaction currently in bitcoind's own mempool spend this
   * outpoint — a claim (or refund) that has been broadcast but not yet mined. `gettxspendingprevout`
   * only ever answers for the mempool (never the confirmed chain — a MINED spend is what
   * `findClaimPreimage`'s own bounded block scan is for), so this is the mempool twin of that
   * scan: without it, a claim sitting unmined is invisible to `findClaimPreimage` until (and
   * unless) a block confirms it, which is exactly how a Seller's claim could otherwise silently
   * outrun a Buyer who never learns the secret in time. `null` when nothing in the mempool spends
   * this outpoint at all.
   */
  async findMempoolSpend(ref: string): Promise<{ txid: string; witness: readonly string[] } | null> {
    const { txid, vout } = parseOutpointRef(ref);
    const results = await this.request<Array<{ txid: string; vout: number; spendingtxid?: string }>>("gettxspendingprevout", [
      [{ txid, vout }],
    ]);
    const entry = results[0];
    if (entry === undefined || entry.spendingtxid === undefined) return null;
    const spender = await this.request<{ vin: Array<{ txid?: string; vout?: number; txinwitness?: string[] }> }>("getrawtransaction", [
      entry.spendingtxid,
      true,
    ]);
    for (const input of spender.vin) {
      if (input.txid === txid && input.vout === vout) {
        return { txid: entry.spendingtxid, witness: input.txinwitness ?? [] };
      }
    }
    return null; // unreachable in practice (gettxspendingprevout only ever names a real spender)
  }

  /** The 32-byte witness item (as `0x`-hex) whose sha256 equals `hashLockBytes`, or `null` when
   *  none of `witness`'s items open it (the timelock/refund branch). Shared by the mempool check
   *  and the mined-block scan below so the two can never classify a witness differently. */
  private static preimageOpening(witness: readonly string[], hashLockBytes: Uint8Array): string | null {
    for (const item of witness) {
      if (!/^[0-9a-fA-F]{64}$/.test(item)) continue;
      const candidate = hexToBytes(item);
      if (bytesEqual(sha256(candidate), hashLockBytes)) {
        return `0x${bytesToHex(candidate)}`;
      }
    }
    return null;
  }

  async findClaimPreimage(ref: string, hashLockHex: string, fromHeight: number): Promise<string | null> {
    const { txid: fundTxid, vout: fundVout } = parseOutpointRef(ref);
    if (!HASH_LOCK_SHAPE.test(hashLockHex)) {
      throw new Error("btc-htlc: hashLock must be 0x + 64 lowercase hex");
    }
    const hashLockBytes = hexToBytes(hashLockHex.slice(2));

    // K1: a claim the Seller has broadcast but that has not yet been mined would otherwise stay
    // invisible to the bounded block scan below until (and unless) a block confirms it — check
    // the mempool first, so a pending claim's own secret is learned at once.
    const mempoolSpend = await this.findMempoolSpend(ref);
    if (mempoolSpend !== null) {
      const preimage = BtcHtlcRail.preimageOpening(mempoolSpend.witness, hashLockBytes);
      if (preimage !== null) return preimage;
      // Spent in the mempool by something that does not open H (the timelock/refund branch) —
      // nothing to learn from the mempool itself; fall through to the block scan below in case a
      // DIFFERENT, already-mined spend exists (e.g. this mempool entry is about to be replaced).
    }

    return this.scanMinedSpend(fundTxid, fundVout, hashLockBytes, fromHeight);
  }

  /** The bounded block scan of `findClaimPreimage` (mined spends only, never the mempool): the preimage of the first mined spend of the outpoint that opens `hashLockBytes`, else `null`. */
  private async scanMinedSpend(fundTxid: string, fundVout: number, hashLockBytes: Uint8Array, fromHeight: number): Promise<string | null> {
    const info = await this.request<{ blocks: number }>("getblockchaininfo", []);
    for (let height = fromHeight; height <= info.blocks; height += 1) {
      const blockHash = await this.request<string>("getblockhash", [height]);
      const block = await this.request<{
        tx: Array<{ vin: Array<{ txid?: string; vout?: number; txinwitness?: string[] }> }>;
      }>("getblock", [blockHash, 2]);

      for (const tx of block.tx) {
        for (const input of tx.vin) {
          if (input.txid !== fundTxid || input.vout !== fundVout) continue;
          return BtcHtlcRail.preimageOpening(input.txinwitness ?? [], hashLockBytes); // found the spend, mined
        }
      }
    }
    return null; // never spent within the scanned window
  }

  /**
   * P10 B7: has the hash branch of this funding output been spent by a MINED transaction (one confirmation on the pinned chain)? The block scan of
   * `findClaimPreimage` without its mempool step: a claim that is only in the mempool is not mined. Only a spend whose witness opens `hashLockHex` counts
   * (the Buyer's timelock-branch refund never does). The chain is re-checked first, so the answer is always about the pinned chain.
   */
  async claimMined(ref: string, hashLockHex: string, fromHeight: number): Promise<boolean> {
    const { txid: fundTxid, vout: fundVout } = parseOutpointRef(ref);
    if (!HASH_LOCK_SHAPE.test(hashLockHex)) {
      throw new Error("btc-htlc: hashLock must be 0x + 64 lowercase hex");
    }
    await this.assertPinnedChain();
    return (await this.scanMinedSpend(fundTxid, fundVout, hexToBytes(hashLockHex.slice(2)), fromHeight)) !== null;
  }

  /**
   * P10-FUND-02: what the node says of a claim txid, as `resendRefundIfDropped` reads a refund: `mined` ONLY with a confirmation on the best chain (`getrawtransaction` through the
   * `-txindex=1` this rail needs), `in-mempool` ONLY when `getmempoolentry` knows the txid, otherwise `null`. `getrawtransaction` alone is not enough for the second: with a txindex it
   * also answers for a transaction that sits in a block of a stale branch (confirmations 0 and a blockhash) while the node holds it nowhere, and a claim read as "in the mempool" in
   * that state would never be sent again. Only Core's own "not found" answer (code -5) reads as absent; any other failure propagates (the R2-2 discipline). READ-ONLY.
   */
  private async claimTxPresence(claimTxid: string): Promise<"mined" | "in-mempool" | null> {
    const known = await this.recoverFunding(claimTxid);
    if (!known.broadcast) return null;
    if (known.confirmations !== null && known.confirmations >= 1) return "mined";
    try {
      await this.request("getmempoolentry", [claimTxid]);
      return "in-mempool";
    } catch (error) {
      if (!isRpcNotFound(error)) throw error;
      return null;
    }
  }

  /**
   * P10 B7, READ-ONLY (it never sends): what became of the one claim whose txid the Seller recorded. The node is asked about the txid (`claimTxPresence`, P10-FUND-02): `mined` with
   * a confirmation, `in-mempool` only while its mempool holds the transaction. Otherwise (never sent, dropped, or only in a block of a stale branch): when the funding output is
   * spent by another transaction (`gettxout` with the mempool answers nothing) the claim can no longer land: `spent-by-other`; else `unknown`, and `resendClaim` (with the Seller's
   * own bound, P10-FUND-01/03) decides. The txid is looked up once more before the `spent-by-other` verdict, so a claim that reached the node between the two reads is never called
   * superseded.
   */
  async claimStatus(ref: string, claimTxid: string): Promise<BtcClaimStatus> {
    parseOutpointRef(ref);
    const known = await this.claimTxPresence(claimTxid);
    if (known !== null) return known;
    if (await this.fundingOutputUnspent(ref)) return "unknown";
    const again = await this.claimTxPresence(claimTxid);
    if (again !== null) return again;
    return "spent-by-other";
  }

  /**
   * P10 B7: re-send the IDENTICAL recorded claim bytes, once, when the node no longer holds them. NEVER rebuilds or re-signs (identical bytes have one txid and
   * one fee, so this cannot create a second spend), and reveals nothing the first send did not: the preimage is in the bytes. First the bytes are checked
   * locally: they must decode, hash to `claimTxid` and spend exactly the outpoint `ref` (a record that was edited into some other transaction is refused before
   * any call). Then, in order: the node already holds the txid (`mined` with a confirmation, `in-mempool` only when `getmempoolentry` knows it: a transaction that only a
   * stale branch's block holds is neither, P10-FUND-02; nothing sent); the funding output is spent by another transaction
   * (`spent-by-other`, nothing sent); otherwise `options.notAfterMs`, when given, is checked against fresh chain time as the last read (the Seller passes it unless leg B's note
   * already reads claimed with the secret, P10-FUND-01/03), and
   * `testmempoolaccept` then `sendrawtransaction` run with Core's "already known" answer counting as success. A refusal by `testmempoolaccept` (the inputs gone, a
   * policy rejection such as a mempool minimum fee that has risen) is a `BtcBroadcastRefusedError`: a person decides, the claim is never re-priced.
   */
  async resendClaim(
    ref: string,
    claimTxid: string,
    claimRawTx: string,
    options: { notAfterMs?: number } = {},
  ): Promise<{ outcome: BtcClaimResend; txid: string; raw: string[] }> {
    const { txid: fundTxid, vout: fundVout } = parseOutpointRef(ref);
    let decoded: Transaction;
    try {
      decoded = Transaction.fromRaw(hexToBytes(claimRawTx), { allowUnknownInputs: true, allowUnknownOutputs: true });
    } catch {
      throw new Error("btc-htlc: the recorded claim rawTx does not decode as a transaction");
    }
    if (decoded.id !== claimTxid) {
      throw new Error("btc-htlc: the recorded claim rawTx does not hash to the recorded txid, refusing to broadcast it");
    }
    const input = decoded.inputsLength === 1 ? decoded.getInput(0) : undefined;
    if (input === undefined || input.txid === undefined || bytesToHex(input.txid) !== fundTxid || input.index !== fundVout) {
      throw new Error("btc-htlc: the recorded claim rawTx does not spend exactly the funding output it is recorded for, refusing to broadcast it");
    }
    await this.assertPinnedChain();
    const before = this.rpc.exchanges().length;
    const done = (outcome: BtcClaimResend) => ({ outcome, txid: claimTxid, raw: this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256) });

    // P10-FUND-02: "held" means the mempool has it or a block of the best chain does; a transaction only in a stale branch's block is neither, and is sent below (funding unspent)
    const known = await this.claimTxPresence(claimTxid);
    if (known !== null) return done(known);
    const txout = await this.request<Record<string, unknown> | null>("gettxout", [fundTxid, fundVout, true]);
    if (txout === null) {
      const again = await this.claimTxPresence(claimTxid);
      if (again !== null) return done(again);
      return done("spent-by-other");
    }
    if (options.notAfterMs !== undefined) await this.assertChainTimeBeforeOrThrow(options.notAfterMs);
    const sentTxid = await this.broadcastOrThrow(claimRawTx, claimTxid);
    if (sentTxid !== claimTxid) {
      // Unreachable given identical bytes hash deterministically to the identical txid - kept as a loud sanity check.
      throw new Error("btc-htlc: resending the recorded claim produced a different txid than recorded (unexpected)");
    }
    return done("in-mempool");
  }
}
