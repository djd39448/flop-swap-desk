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
  locktimeFromRefundAfterMs,
  scriptPubKeyForAddress,
  type FundingUtxo,
} from "./btc-script.js";
import type { CapturingRpc } from "./rpc-capture.js";

export type BtcNetworkName = "regtest" | "signet";

export interface BtcChainPin {
  name: string;
  network: BtcNetworkName;
  /** `bip122:<first 32 hex chars of the genesis hash>` (P4-BTC-SPEC.md §0/§6). */
  caip2: string;
  /** `getblockhash 0`'s result — lowercase 64-hex. */
  genesisHash: string;
  finality: { confirmations: number };
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
 *  public references, never confirmed by this build against a live signet node — that
 *  confirmation is Dave's own G1 step. Do not use this pin for a real deployment until it has
 *  been; `connect()`'s own genesis check will simply refuse a live signet node if this value
 *  turns out to be wrong, so using it by mistake fails closed rather than silently mispinning.
 */
export const BTC_SIGNET_PIN: BtcChainPin = {
  name: "btc-signet-UNVERIFIED",
  network: "signet",
  caip2: "bip122:00000008819873e925422c1ff0f99f7",
  genesisHash: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3628bea634",
  finality: { confirmations: 1 },
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

  if (typeof v.endpoint !== "string" || v.endpoint === "") return "btc rail config: endpoint must be a non-empty string";
  if (v.scanWindowBlocks !== undefined && (typeof v.scanWindowBlocks !== "number" || !Number.isInteger(v.scanWindowBlocks) || v.scanWindowBlocks <= 0)) {
    return "btc rail config: scanWindowBlocks must be a positive integer when present";
  }
  return null;
}

/** Runtime checks that don't need a live chain: the pin's network is on the allow list.
 *  `connect()`/`assertPinnedChain()` additionally check the LIVE `getblockchaininfo().chain`
 *  against this same allow list before ever comparing it to the pin (defense in depth: even if
 *  `BtcChainPin.network`'s own type were ever widened, the runtime check still refuses a name
 *  nobody put on the list). */
export function validateBtcRailConfig(config: BtcRailConfig): void {
  if (!ALLOWED_NETWORKS.has(config.pin.network)) {
    throw new Error(`btc-htlc: network "${config.pin.network}" is not on the allow list (regtest, signet only)`);
  }
  // H3: pin names tied to their network — a config cannot rename a known (network, genesisHash)
  // pair to a different `pin.name` (e.g. an index-only rename to "bitcoin-mainnet"), and cannot
  // pin a (network, genesisHash) pair this build does not itself know about at all.
  const known = knownPinFor(config.pin.network, config.pin.genesisHash);
  if (known === null) {
    throw new Error(
      `btc-htlc: (network "${config.pin.network}", genesisHash ${config.pin.genesisHash}) does not match any known pin (btc-regtest, btc-signet-UNVERIFIED)`,
    );
  }
  if (config.pin.name !== known.name) {
    throw new Error(`btc-htlc: pin.name "${config.pin.name}" does not match the known pin's own name "${known.name}" for this (network, genesisHash)`);
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
 *  explicitly out of scope for this build (P4-BTC-SPEC.md §0 scope note: "Out of scope: …
 *  fees …"). */
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
}

export interface BtcHtlcRailOptions {
  config: BtcRailConfig;
  rpc: CapturingRpc;
  clock?: () => number;
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

  private constructor(config: BtcRailConfig, rpc: CapturingRpc, clock: () => number) {
    this.config = config;
    this.rpc = rpc;
    this.clock = clock;
    this.networkParams = networkParamsFor(config.pin);
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
    const rail = new BtcHtlcRail(configCheck.config, options.rpc, options.clock ?? Date.now);
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
    const info = await this.request<{ chain: string }>("getblockchaininfo", []);
    if (!ALLOWED_NETWORKS.has(info.chain)) {
      throw new Error(
        `btc-htlc: chain "${info.chain}" is not on the allow list (regtest, signet only)` +
          (DENY_CHAIN_NAMES.has(info.chain) ? `; refusing ${info.chain} by name` : ""),
      );
    }
    if (info.chain !== this.config.pin.network) {
      throw new Error(
        `btc-htlc: connected chain "${info.chain}" does not match pin "${this.config.pin.name}" (expected "${this.config.pin.network}")`,
      );
    }
    const genesisHash = await this.request<string>("getblockhash", [0]);
    if (genesisHash.toLowerCase() !== this.config.pin.genesisHash.toLowerCase()) {
      throw new Error(
        `btc-htlc: genesis hash ${genesisHash} does not match pin "${this.config.pin.name}" (expected ${this.config.pin.genesisHash})`,
      );
    }
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

  private async broadcastOrThrow(rawHex: string): Promise<string> {
    const acceptance = await this.request<Array<{ txid: string; allowed: boolean; "reject-reason"?: string }>>("testmempoolaccept", [
      [rawHex],
    ]);
    const result = acceptance[0];
    if (result === undefined) throw new Error("btc-htlc: testmempoolaccept returned no result");
    if (!result.allowed) {
      throw new Error(`btc-htlc: refusing to broadcast — testmempoolaccept rejected it (${result["reject-reason"] ?? "no reason given"})`);
    }
    return await this.request<string>("sendrawtransaction", [rawHex]);
  }

  private finishWriteEvidence(ref: string, txid: string, before: number): WriteEvidence {
    const raw = this.rpc.exchanges().slice(before).map((exchange) => exchange.responseSha256);
    return { ref, txid, blockHeight: null, blockHash: null, raw };
  }

  /** The chain's tip block time, in ms. One of the two chain-time helpers spec §4 asks for. */
  async tipBlockTimeMs(): Promise<number> {
    const info = await this.request<{ time: number }>("getblockchaininfo", []);
    return info.time * 1000;
  }

  /** The chain's median time past (the last 11 blocks), in ms — what CLTV's `after(T)` branch is
   *  actually checked against, and the second chain-time helper spec §4 asks for. */
  async medianTimePastMs(): Promise<number> {
    const info = await this.request<{ mediantime: number }>("getblockchaininfo", []);
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
    const created = await this.walletRequest<{ psbt: string }>(buyer.wallet, "walletcreatefundedpsbt", [[], [{ [address]: amountBtc }], 0, {}, true]);
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
   * H2: recover a previously-prepared funding's own on-chain status by its txid alone — for a
   * caller resuming after an interruption between `broadcastFunding`'s own `testmempoolaccept`
   * and its return, which must never re-broadcast blindly without first checking whether the
   * node's own view (mempool or chain) already has it. Reads `getrawtransaction(txid, true)`
   * (the harness runs `-txindex=1`, so this answers for a mempool-only tx too, not only a mined
   * one); a "no such transaction" answer means "never reached the network" (`broadcast: false`),
   * never a thrown exception.
   */
  async recoverFunding(txid: string): Promise<RecoveredFunding> {
    await this.assertPinnedChain();
    let result: { confirmations?: unknown; blockhash?: unknown };
    try {
      result = await this.request<{ confirmations?: unknown; blockhash?: unknown }>("getrawtransaction", [txid, true]);
    } catch {
      return { broadcast: false, blockHash: null, confirmations: null };
    }
    const confirmations = typeof result.confirmations === "number" && Number.isInteger(result.confirmations) ? result.confirmations : 0;
    const blockHash = typeof result.blockhash === "string" ? result.blockhash : null;
    return { broadcast: true, blockHash, confirmations };
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
   */
  async claim(
    ref: string,
    terms: BtcHtlcTerms,
    secretHex: string,
    seller: BtcWalletHandle,
    destinationAddress: string,
    notAfterMs: number,
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

    const utxo: FundingUtxo = { txid: fundTxid, vout: fundVout, scriptPubKey: funding.scriptPubKey, amountSats: funding.amountSats };
    const psbt = buildClaimPsbt({
      utxo,
      witnessScript,
      hashLock: hashLockBytes,
      preimage,
      payeePubkey,
      payeeDerivation: { fingerprint: seller.key.fingerprint, path: seller.key.path },
      destinationScriptPubKey,
      feeSats: DEFAULT_FEE_SATS,
    });

    const processed = await this.walletRequest<{ complete: boolean; hex?: string }>(seller.wallet, "walletprocesspsbt", [base64FromBytes(psbt)]);
    if (!processed.complete || processed.hex === undefined) {
      throw new Error("btc-htlc: walletprocesspsbt did not produce a complete, finalized claim transaction");
    }

    // The deadline guard is the LAST read before broadcast — nothing but testmempoolaccept and
    // the broadcast itself follow.
    await this.assertChainTimeBeforeOrThrow(notAfterMs);

    const txid = await this.broadcastOrThrow(processed.hex);
    return this.finishWriteEvidence(ref, txid, before);
  }

  /**
   * Builds the refund PSBT (global `nLockTime = T`, `witness_utxo` + `witnessScript` +
   * `bip32_derivation` for the buyer's own key), has `buyer`'s own wallet sign AND finalize it —
   * which succeeds regardless of whether the chain's median time past has reached `T` yet (probe
   * Q4) — then runs `testmempoolaccept`, which is what actually rejects it as "non-final" before
   * MTP passes `T` and accepts it after.
   */
  async refund(ref: string, terms: BtcHtlcTerms, buyer: BtcWalletHandle, destinationAddress: string): Promise<WriteEvidence> {
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

    const utxo: FundingUtxo = { txid: fundTxid, vout: fundVout, scriptPubKey: funding.scriptPubKey, amountSats: funding.amountSats };
    const psbt = buildRefundPsbt({
      utxo,
      witnessScript,
      locktime,
      payerPubkey,
      payerDerivation: { fingerprint: buyer.key.fingerprint, path: buyer.key.path },
      destinationScriptPubKey,
      feeSats: DEFAULT_FEE_SATS,
    });

    const processed = await this.walletRequest<{ complete: boolean; hex?: string }>(buyer.wallet, "walletprocesspsbt", [base64FromBytes(psbt)]);
    if (!processed.complete || processed.hex === undefined) {
      throw new Error("btc-htlc: walletprocesspsbt did not produce a complete, finalized refund transaction");
    }

    const txid = await this.broadcastOrThrow(processed.hex);
    return this.finishWriteEvidence(ref, txid, before);
  }

  /**
   * Bounded block scan (spec §4) for the transaction that spent `ref`, between `fromHeight` and
   * the current tip: returns the 32-byte witness item (as `0x`-hex) whose sha256 equals
   * `hashLockHex` — the secret `s` — or `null` when `ref` is unspent, was spent by the refund
   * branch instead (no witness item opens the hash), or the scan window closes first.
   */
  async findClaimPreimage(ref: string, hashLockHex: string, fromHeight: number): Promise<string | null> {
    const { txid: fundTxid, vout: fundVout } = parseOutpointRef(ref);
    if (!HASH_LOCK_SHAPE.test(hashLockHex)) {
      throw new Error("btc-htlc: hashLock must be 0x + 64 lowercase hex");
    }
    const hashLockBytes = hexToBytes(hashLockHex.slice(2));

    const info = await this.request<{ blocks: number }>("getblockchaininfo", []);
    for (let height = fromHeight; height <= info.blocks; height += 1) {
      const blockHash = await this.request<string>("getblockhash", [height]);
      const block = await this.request<{
        tx: Array<{ vin: Array<{ txid?: string; vout?: number; txinwitness?: string[] }> }>;
      }>("getblock", [blockHash, 2]);

      for (const tx of block.tx) {
        for (const input of tx.vin) {
          if (input.txid !== fundTxid || input.vout !== fundVout) continue;
          for (const item of input.txinwitness ?? []) {
            if (!/^[0-9a-fA-F]{64}$/.test(item)) continue;
            const candidate = hexToBytes(item);
            if (bytesEqual(sha256(candidate), hashLockBytes)) {
              return `0x${bytesToHex(candidate)}`;
            }
          }
          return null; // found the spend, but no witness item opens the hash (the refund branch)
        }
      }
    }
    return null; // never spent within the scanned window
  }
}
