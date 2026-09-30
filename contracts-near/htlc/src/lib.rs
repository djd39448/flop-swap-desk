//! First-party, unaudited, testnet-only HTLC for a NEP-141 token (P5-NEAR-SPEC.md section 3).
//! Any NEP-141 token may call `ft_on_transfer`; the lock records which token account funded
//! it (`predecessor_account_id` at that call), and it is the caller's (the swap desk's) job to
//! verify that account against its own configured USDC token before trusting a lock as real
//! payment — this contract itself is asset-agnostic.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

/// D-N9: explicit gas constants; NB-int measures the real burn and these are corrected once
/// with the measurement recorded in the commit message.
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
pub const CALLBACK_GAS: Gas = Gas::from_tgas(10);

const HASH_HEX_LEN: usize = 64;

/// F2: kept free in the contract's own account balance, beyond what `env::storage_usage()`
/// already owes in storage staking, before a new lock is accepted. Without this, the
/// contract's free balance can be driven to (or toward) zero by lock storage staking --
/// spammed by an attacker calling `ft_on_transfer` directly (closed separately by F3's token
/// allow-list) or simply by honest lock volume over time -- and a later `claim`/`refund`'s
/// `ft_transfer` promise then fails with `LackBalanceForState` *after* its preimage (for a
/// claim) is already public in the transaction, with no way to undo that disclosure.
fn storage_reserve() -> NearToken {
    NearToken::from_millinear(50)
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LockStatus {
    Locked,
    Claiming,
    Claimed,
    Refunding,
    Refunded,
}

impl LockStatus {
    fn as_str(self) -> &'static str {
        match self {
            LockStatus::Locked => "Locked",
            LockStatus::Claiming => "Claiming",
            LockStatus::Claimed => "Claimed",
            LockStatus::Refunding => "Refunding",
            LockStatus::Refunded => "Refunded",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Lock {
    pub payer: AccountId,
    pub payee: AccountId,
    pub token: AccountId,
    pub amount: u128,
    pub claim_by_ms: u64,
    pub refund_after_ms: u64,
    pub status: LockStatus,
    /// F2: a fixed-size 32-byte slot, allocated (zeroed) at lock time and only ever
    /// overwritten in place by `claim` -- never `Option<String>`, whose borsh encoding would
    /// grow the entry from `None` (1 byte) to `Some(String)` (roughly 69 bytes for a 64-hex-
    /// char preimage) the moment `claim` reveals it. A growing entry makes `claim` itself
    /// consume additional storage staking out of the contract's own balance at the exact
    /// moment the preimage becomes public, which is the least safe time for that write to be
    /// able to fail. Meaningless (all zero) until `revealed` is true.
    pub preimage: [u8; 32],
    /// True once `claim` has verified a preimage against `hash_lock` and stored it in
    /// `preimage`; the preimage is public from that point on (including in the event log,
    /// F6), even if the payout callback later fails and `status` reverts to `Locked` (F4: a
    /// revealed lock may no longer be refunded).
    pub revealed: bool,
}

/// `get_lock`'s return shape: every field, amounts/times as decimal strings (near-sdk's own
/// `U128`/`U64` JSON convention — a bare JSON number only guarantees 53 correct bits).
#[near(serializers = [json])]
pub struct LockView {
    pub payer: AccountId,
    pub payee: AccountId,
    pub token: AccountId,
    pub amount: U128,
    pub claim_by_ms: U64,
    pub refund_after_ms: U64,
    pub status: String,
    pub preimage: Option<String>,
}

impl From<&Lock> for LockView {
    fn from(l: &Lock) -> Self {
        LockView {
            payer: l.payer.clone(),
            payee: l.payee.clone(),
            token: l.token.clone(),
            amount: U128(l.amount),
            claim_by_ms: U64(l.claim_by_ms),
            refund_after_ms: U64(l.refund_after_ms),
            status: l.status.as_str().to_string(),
            preimage: if l.revealed {
                Some(hex_encode(&l.preimage))
            } else {
                None
            },
        }
    }
}

/// Which exit path a pending `ft_transfer` callback is resolving.
#[near(serializers = [json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Claim,
    Refund,
}

/// The `ft_on_transfer` `msg` field's JSON shape (P5-NEAR-SPEC.md section 3). All four fields
/// are required; `claim_by_ms`/`refund_after_ms` travel as decimal strings (matching near-sdk's
/// own `U64` JSON convention) so a caller never hits the 53-bit JSON-number limit.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct LockMsg {
    hash_lock: String,
    payee: String,
    claim_by_ms: String,
    refund_after_ms: String,
}

/// F8: `str::parse::<u64>()` is looser than "validate strictly" (P5-NEAR-SPEC.md section 3)
/// -- it accepts a leading `+` and leading zeros (e.g. `"+0003600000"`). Requires exactly
/// `"0"` or a nonzero-leading run of ASCII digits.
fn parse_u64_strict(s: &str) -> Option<u64> {
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    if !bytes.iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if bytes[0] == b'0' && bytes.len() > 1 {
        return None;
    }
    s.parse::<u64>().ok()
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Keyed by `lock_key(payer, hash_lock)` (squatting fix): a lock lives under its own
    /// payer, so another account locking under the same public hash lock first can never
    /// occupy the real payer's key.
    locks: LookupMap<String, Lock>,
    /// F3: the only NEP-141 token whose `ft_transfer_call` may create a lock (checked at the
    /// top of `ft_on_transfer`). `ft_on_transfer` is otherwise a public method any account
    /// can call directly with no real token transfer behind it (gas only) -- without this
    /// allow-list an attacker could spam locks to drain the contract's storage staking (F2).
    /// This makes the contract single-token per deployment rather than the fully
    /// asset-agnostic design in this file's original header comment -- see README "Known
    /// limits".
    usdc_token: AccountId,
}

#[near]
impl Contract {
    #[init]
    pub fn new(usdc_token: AccountId) -> Self {
        Self {
            locks: LookupMap::new(b"l"),
            usdc_token,
        }
    }

    /// All fields plus `preimage` once known; amounts/times as decimal strings. `None` if
    /// `payer` has never locked under `hash_lock`.
    pub fn get_lock(&self, hash_lock: String, payer: AccountId) -> Option<LockView> {
        self.locks
            .get(&lock_key(&payer, &hash_lock))
            .map(|l| LockView::from(&l))
    }

    /// Permissionless. Reveals `preimage` (public from this point on, even if the payout
    /// callback later fails and status reverts to `Locked`) and schedules the payout.
    /// Addresses only the lock `payer` made under `hash_lock`; pays the stored payee.
    pub fn claim(&mut self, hash_lock: String, payer: AccountId, preimage: String) -> Promise {
        let key = lock_key(&payer, &hash_lock);
        let mut lock = self
            .locks
            .get(&key)
            .unwrap_or_else(|| env::panic_str("No lock for this hash"));
        require!(lock.status == LockStatus::Locked, "Lock is not claimable");
        let now_ms = env::block_timestamp_ms();
        // F4: once a preimage has been revealed (this is a retry after a failed payout
        // callback -- see `refund`, which now refuses a revealed lock), the payee owns this
        // lock and may keep retrying past `refund_after_ms`; only a lock that has never been
        // claimed is bound by the window.
        require!(
            now_ms < lock.refund_after_ms || lock.revealed,
            "Refund window has opened"
        );

        let preimage_bytes =
            decode_hex(&preimage).unwrap_or_else(|| env::panic_str("Preimage is not valid hex"));
        // F1: every other rail in the swap (tclk's verifySecret/hashLockFromPreimage, the EVM
        // `claim(bytes32,bytes32)`, the Bitcoin script's `SIZE 32 EQUALVERIFY`) requires a
        // 32-byte secret. Accepting any even-length hex here let a malicious Seller publish
        // `H = sha256(s')` for a non-32-byte `s'`: the Buyer cannot detect this from `H` alone,
        // locks leg A under `H`, and once the Seller reveals `s'` here to take leg B, the
        // Buyer can never satisfy the other rails' 32-byte check with the same `s'` and loses
        // leg A after its own refund window closes.
        require!(preimage_bytes.len() == 32, "Preimage must be 32 bytes");
        let computed = hex_encode(&env::sha256(&preimage_bytes));
        require!(computed == hash_lock, "Preimage does not match hash lock");

        lock.status = LockStatus::Claiming;
        // F2: overwrite the fixed-size array in place -- the entry's serialized size (and
        // therefore `env::storage_usage()`) is identical before and after this write.
        lock.preimage.copy_from_slice(&preimage_bytes);
        lock.revealed = true;
        self.locks.insert(&key, &lock);
        log_event("claiming", &hash_lock, &lock);

        ext_ft_core::ext(lock.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(lock.payee.clone(), U128(lock.amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_complete(hash_lock, payer, Exit::Claim),
            )
    }

    /// Payer only: addresses the lock `(predecessor, hash_lock)`, so a caller can only ever
    /// name its own lock. Only once the refund window has opened.
    pub fn refund(&mut self, hash_lock: String) -> Promise {
        let payer = env::predecessor_account_id();
        let key = lock_key(&payer, &hash_lock);
        let mut lock = self
            .locks
            .get(&key)
            .unwrap_or_else(|| env::panic_str("No lock for this hash"));
        require!(payer == lock.payer, "Only the payer can refund");
        require!(lock.status == LockStatus::Locked, "Lock is not refundable");
        // F4: once a valid preimage has been revealed (claim ran, then its payout callback
        // failed and reverted status to Locked), the lock belongs to the payee -- refunding
        // here would let the payer take leg A back while it already knows the secret and can
        // claim leg B, so the counterparty loses both legs. The payer is unharmed: it can use
        // the now-public preimage on leg B itself.
        require!(
            !lock.revealed,
            "Lock already claimed (preimage revealed); refund is refused"
        );
        let now_ms = env::block_timestamp_ms();
        require!(
            now_ms >= lock.refund_after_ms,
            "Refund window has not opened"
        );

        lock.status = LockStatus::Refunding;
        self.locks.insert(&key, &lock);
        log_event("refunding", &hash_lock, &lock);

        ext_ft_core::ext(lock.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(lock.payer.clone(), U128(lock.amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_complete(hash_lock, payer, Exit::Refund),
            )
    }

    /// Resolves the `ft_transfer` promise started by `claim`/`refund`: success moves the lock
    /// to its terminal state, failure reverts it to `Locked` (the preimage, if any, stays
    /// public — it was already logged and stored before this callback ever runs).
    #[private]
    pub fn on_transfer_complete(
        &mut self,
        hash_lock: String,
        payer: AccountId,
        exit: Exit,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let key = lock_key(&payer, &hash_lock);
        let mut lock = self
            .locks
            .get(&key)
            .unwrap_or_else(|| env::panic_str("No lock for this hash"));
        let ok = result.is_ok();
        lock.status = match (exit, ok) {
            (Exit::Claim, true) => LockStatus::Claimed,
            (Exit::Claim, false) => LockStatus::Locked,
            (Exit::Refund, true) => LockStatus::Refunded,
            (Exit::Refund, false) => LockStatus::Locked,
        };
        self.locks.insert(&key, &lock);
        log_event(
            if ok {
                match exit {
                    Exit::Claim => "claimed",
                    Exit::Refund => "refunded",
                }
            } else {
                "transfer_failed"
            },
            &hash_lock,
            &lock,
        );
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Strict `msg` validation per P5-NEAR-SPEC.md section 3: on ANY invalid input, returns
    /// `U128(amount)` (the token contract refunds the sender in full) and NEVER panics — this
    /// is user input arriving from an arbitrary token/sender pair, not a trusted call.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let refuse_all = PromiseOrValue::Value(amount);

        if amount.0 == 0 {
            return refuse_all;
        }

        // F3: only the configured token's own transfer may create a lock -- see the
        // `usdc_token` field doc for why a direct call from anywhere else must be refused
        // before it can occupy (squat) or spam a hash_lock key.
        if env::predecessor_account_id() != self.usdc_token {
            return refuse_all;
        }

        let parsed: LockMsg = match near_sdk::serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => return refuse_all,
        };

        if !is_valid_hash_hex(&parsed.hash_lock) {
            return refuse_all;
        }
        let payee: AccountId = match parsed.payee.parse() {
            Ok(v) => v,
            Err(_) => return refuse_all,
        };
        // H5: a payee that can never receive/spend a payout -- the HTLC contract's own account
        // (its `ft_transfer` payout would just be a transfer to itself; the lock could never be
        // meaningfully claimed by a counterparty) or the USDC token account itself (same
        // reasoning -- and near-contract-standards' own `ft_transfer` refuses a self-transfer
        // from the token to itself anyway, so a lock like this could never even settle).
        if payee == env::current_account_id() || payee == self.usdc_token {
            return refuse_all;
        }
        let claim_by_ms: u64 = match parse_u64_strict(&parsed.claim_by_ms) {
            Some(v) => v,
            None => return refuse_all,
        };
        let refund_after_ms: u64 = match parse_u64_strict(&parsed.refund_after_ms) {
            Some(v) => v,
            None => return refuse_all,
        };
        if claim_by_ms >= refund_after_ms {
            return refuse_all;
        }
        let now_ms = env::block_timestamp_ms();
        if now_ms >= refund_after_ms {
            return refuse_all;
        }
        // Squatting fix: a duplicate is refused only for the same (payer, hash_lock) pair.
        let key = lock_key(&sender_id, &parsed.hash_lock);
        if self.locks.get(&key).is_some() {
            return refuse_all;
        }

        let token = env::predecessor_account_id();
        let lock = Lock {
            payer: sender_id,
            payee,
            token,
            amount: amount.0,
            claim_by_ms,
            refund_after_ms,
            status: LockStatus::Locked,
            preimage: [0u8; 32],
            revealed: false,
        };
        self.locks.insert(&key, &lock);

        // F2: refuse (and let the token refund the sender in full) unless the contract's own
        // balance still covers its storage staking plus a fixed reserve after this insert --
        // otherwise a later claim/refund's payout promise can fail (LackBalanceForState) with
        // the preimage, for a claim, already public in the transaction.
        let required = env::storage_byte_cost()
            .saturating_mul(env::storage_usage() as u128)
            .saturating_add(storage_reserve());
        if env::account_balance() < required {
            self.locks.remove(&key);
            return refuse_all;
        }

        log_event("locked", &parsed.hash_lock, &lock);

        PromiseOrValue::Value(U128(0))
    }
}

/// Storage key of a lock: `"<payer account>:<hash_lock hex>"`. The NEAR account-id grammar has
/// no `:`, so the pair is unambiguous.
fn lock_key(payer: &AccountId, hash_lock: &str) -> String {
    format!("{payer}:{hash_lock}")
}

fn is_valid_hash_hex(s: &str) -> bool {
    s.len() == HASH_HEX_LEN
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_val(bytes[i])?;
        let lo = hex_val(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// NEP-297 event log: `EVENT_JSON:{"standard":"near-htlc","version":"1.0.0","event":<kind>,
/// "data":[{...}]}`.
fn log_event(kind: &str, hash_lock: &str, lock: &Lock) {
    let mut entry = near_sdk::serde_json::json!({
        "hash_lock": hash_lock,
        "payer": lock.payer,
        "payee": lock.payee,
        "token": lock.token,
        "amount": lock.amount.to_string(),
        "status": lock.status.as_str(),
    });
    // F6: the doc comment on `Lock::preimage`/`LockView::preimage` says the preimage is
    // "public thereafter (including in the event log)" once revealed -- make that true. A
    // log-based reader (mirroring how the EVM rail's findClaimedPreimage reads Claimed logs)
    // would otherwise silently miss the secret and have to fall back to `get_lock` state.
    if lock.revealed {
        entry["preimage"] = near_sdk::serde_json::Value::String(hex_encode(&lock.preimage));
    }
    let event = near_sdk::serde_json::json!({
        "standard": "near-htlc",
        "version": "1.0.0",
        "event": kind,
        "data": [entry],
    });
    env::log_str(&format!("EVENT_JSON:{event}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const HOUR_MS: u64 = 3_600_000;

    fn token() -> AccountId {
        accounts(0)
    }
    fn payer() -> AccountId {
        accounts(1)
    }
    fn payee() -> AccountId {
        accounts(2)
    }
    fn contract_account() -> AccountId {
        accounts(3)
    }

    fn ctx(predecessor: AccountId, block_ts_ms: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_account())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .block_timestamp(block_ts_ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(0));
        b
    }

    fn setup() -> Contract {
        testing_env!(ctx(token(), 0).build());
        Contract::new(token())
    }

    fn preimage_and_hash() -> (String, String) {
        // Fixed secret; the hash is derived at test time (off-chain sha256 fallback, see
        // near-sdk-5-facts-2026-09-29.md section 3), never hardcoded, so it can never drift
        // from `decode_hex`/`hex_encode`'s own encoding. F1: exactly 32 bytes, matching the
        // length every other rail (tclk/EVM/Bitcoin) requires -- the old 21-byte fixture was
        // exercising the very hole F1 closes as its own happy path.
        testing_env!(ctx(token(), 0).build());
        let preimage_bytes = b"flop-near-htlc-secret-32-bytes!!".to_vec();
        assert_eq!(preimage_bytes.len(), 32);
        let hash = hex_encode(&env::sha256(&preimage_bytes));
        (hex_encode(&preimage_bytes), hash)
    }

    fn lock_msg(hash_lock: &str, claim_by_ms: u64, refund_after_ms: u64) -> String {
        format!(
            r#"{{"hash_lock":"{}","payee":"{}","claim_by_ms":"{}","refund_after_ms":"{}"}}"#,
            hash_lock,
            payee(),
            claim_by_ms,
            refund_after_ms
        )
    }

    fn lock_via_transfer(
        contract: &mut Contract,
        now_ms: u64,
        amount: u128,
        hash_lock: &str,
        claim_by_ms: u64,
        refund_after_ms: u64,
    ) -> PromiseOrValue<U128> {
        testing_env!(ctx(token(), now_ms).build());
        contract.ft_on_transfer(
            payer(),
            U128(amount),
            lock_msg(hash_lock, claim_by_ms, refund_after_ms),
        )
    }

    fn assert_value(result: PromiseOrValue<U128>, expected: u128) {
        match result {
            PromiseOrValue::Value(v) => assert_eq!(v.0, expected),
            PromiseOrValue::Promise(_) => panic!("expected a Value, got a Promise"),
        }
    }

    // ---- ft_on_transfer / locking ----

    #[test]
    fn valid_lock_accepts_full_amount_and_stores_lock() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let res = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        assert_value(res, 0);

        let view = c.get_lock(hash.clone(), payer()).expect("lock stored");
        assert_eq!(view.payer, payer());
        assert_eq!(view.payee, payee());
        assert_eq!(view.token, token());
        assert_eq!(view.amount, U128(1_000));
        assert_eq!(view.claim_by_ms, U64(HOUR_MS));
        assert_eq!(view.refund_after_ms, U64(2 * HOUR_MS));
        assert_eq!(view.status, "Locked");
        assert_eq!(view.preimage, None, "preimage hidden until claim");
    }

    #[test]
    fn get_lock_before_any_lock_is_none() {
        let c = setup();
        assert!(c.get_lock("a".repeat(64), payer()).is_none());
    }

    #[test]
    fn malformed_json_msg_refunds_full_amount() {
        let mut c = setup();
        testing_env!(ctx(token(), 0).build());
        let res = c.ft_on_transfer(payer(), U128(777), "not json".to_string());
        assert_value(res, 777);
    }

    #[test]
    fn amount_zero_refuses_without_storing_anything() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let res = lock_via_transfer(&mut c, 0, 0, &hash, HOUR_MS, 2 * HOUR_MS);
        assert_value(res, 0);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn bad_hash_lock_shape_refunds_full_amount() {
        let mut c = setup();
        testing_env!(ctx(token(), 0).build());
        let msg = lock_msg("not-64-hex-chars", HOUR_MS, 2 * HOUR_MS);
        let res = c.ft_on_transfer(payer(), U128(500), msg);
        assert_value(res, 500);
    }

    #[test]
    fn bad_payee_account_id_refunds_full_amount() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        testing_env!(ctx(token(), 0).build());
        let msg = format!(
            r#"{{"hash_lock":"{}","payee":"NOT a valid account!!","claim_by_ms":"{}","refund_after_ms":"{}"}}"#,
            hash, HOUR_MS, 2 * HOUR_MS
        );
        let res = c.ft_on_transfer(payer(), U128(500), msg);
        assert_value(res, 500);
    }

    #[test]
    fn lock_msg_with_unknown_field_is_refused() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        testing_env!(ctx(token(), 0).build());
        let msg = format!(
            r#"{{"hash_lock":"{}","payee":"{}","claim_by_ms":"{}","refund_after_ms":"{}","extra":1}}"#,
            hash,
            payee(),
            HOUR_MS,
            2 * HOUR_MS
        );
        let res = c.ft_on_transfer(payer(), U128(500), msg);
        assert_value(res, 500);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn lock_msg_with_leading_plus_sign_is_refused() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        testing_env!(ctx(token(), 0).build());
        let msg = format!(
            r#"{{"hash_lock":"{}","payee":"{}","claim_by_ms":"+{}","refund_after_ms":"{}"}}"#,
            hash,
            payee(),
            HOUR_MS,
            2 * HOUR_MS
        );
        let res = c.ft_on_transfer(payer(), U128(500), msg);
        assert_value(res, 500);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn lock_msg_with_leading_zero_is_refused() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        testing_env!(ctx(token(), 0).build());
        let msg = format!(
            r#"{{"hash_lock":"{}","payee":"{}","claim_by_ms":"0{}","refund_after_ms":"{}"}}"#,
            hash,
            payee(),
            HOUR_MS,
            2 * HOUR_MS
        );
        let res = c.ft_on_transfer(payer(), U128(500), msg);
        assert_value(res, 500);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn claim_by_after_refund_after_refunds_full_amount() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        // claim_by_ms >= refund_after_ms is rejected.
        let res = lock_via_transfer(&mut c, 0, 1_000, &hash, 2 * HOUR_MS, HOUR_MS);
        assert_value(res, 1_000);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn claim_by_equal_refund_after_refunds_full_amount() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let res = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, HOUR_MS);
        assert_value(res, 1_000);
    }

    #[test]
    fn expired_window_refunds_full_amount() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        // now_ms (3*HOUR_MS) >= refund_after_ms (2*HOUR_MS): the window is already closed.
        let res = lock_via_transfer(&mut c, 3 * HOUR_MS, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        assert_value(res, 1_000);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn duplicate_hash_lock_refunds_the_second_transfer_and_keeps_the_first() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let first = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        assert_value(first, 0);

        let second = lock_via_transfer(&mut c, 0, 42, &hash, HOUR_MS, 2 * HOUR_MS);
        assert_value(second, 42);

        // Original lock is untouched by the rejected second attempt.
        let view = c.get_lock(hash, payer()).unwrap();
        assert_eq!(view.amount, U128(1_000));
    }

    #[test]
    fn direct_call_from_a_non_token_account_is_refused() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        // Not the configured token: predecessor is an ordinary account, no real transfer
        // behind this call at all.
        testing_env!(ctx(accounts(4), 0).build());
        let res = c.ft_on_transfer(accounts(4), U128(1), lock_msg(&hash, HOUR_MS, 2 * HOUR_MS));
        assert_value(res, 1);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn payee_equal_to_the_contract_itself_refunds_full_amount() {
        // H5: a payee that can never receive/spend a payout must be refused up front.
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        testing_env!(ctx(token(), 0).build());
        let msg = format!(
            r#"{{"hash_lock":"{}","payee":"{}","claim_by_ms":"{}","refund_after_ms":"{}"}}"#,
            hash,
            contract_account(),
            HOUR_MS,
            2 * HOUR_MS
        );
        let res = c.ft_on_transfer(payer(), U128(500), msg);
        assert_value(res, 500);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn payee_equal_to_the_usdc_token_refunds_full_amount() {
        // H5: same reasoning for the configured token account.
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        testing_env!(ctx(token(), 0).build());
        let msg = format!(
            r#"{{"hash_lock":"{}","payee":"{}","claim_by_ms":"{}","refund_after_ms":"{}"}}"#,
            hash,
            token(),
            HOUR_MS,
            2 * HOUR_MS
        );
        let res = c.ft_on_transfer(payer(), U128(500), msg);
        assert_value(res, 500);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    #[test]
    fn hash_lock_squatter_cannot_block_the_real_lock() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        testing_env!(ctx(accounts(4), 0).build()); // not a token: a direct call
        let squat = c.ft_on_transfer(accounts(4), U128(1), lock_msg(&hash, HOUR_MS, u64::MAX / 2));
        assert_value(squat, 1);
        assert!(c.get_lock(hash.clone(), payer()).is_none(), "squat must never be stored");

        let real = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        assert_value(real, 0);
        assert_eq!(c.get_lock(hash, payer()).unwrap().amount, U128(1_000));
    }

    // ---- squatting fix: locks are keyed by (payer, hash_lock) ----

    fn lock_as(
        contract: &mut Contract,
        sender: AccountId,
        now_ms: u64,
        amount: u128,
        hash_lock: &str,
    ) -> PromiseOrValue<U128> {
        testing_env!(ctx(token(), now_ms).build());
        contract.ft_on_transfer(sender, U128(amount), lock_msg(hash_lock, HOUR_MS, 2 * HOUR_MS))
    }

    #[test]
    fn squat_by_another_payer_first_does_not_block_the_real_lock_and_it_pays_out() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        // accounts(4) holds the token and locks 1 unit under the public hash lock FIRST.
        assert_value(lock_as(&mut c, accounts(4), 0, 1, &hash), 0);
        // The real payer's lock under the same hash lock is still accepted in full.
        assert_value(lock_as(&mut c, payer(), 0, 1_000, &hash), 0);
        assert_eq!(c.get_lock(hash.clone(), payer()).unwrap().amount, U128(1_000));
        assert_eq!(c.get_lock(hash.clone(), accounts(4)).unwrap().amount, U128(1));

        // Claiming the real lock reveals and pays the real payee 1_000, not the squat.
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash.clone(), payer(), preimage);
        assert_eq!(c.get_lock(hash.clone(), payer()).unwrap().status, "Claiming");
        testing_env!(ctx(contract_account(), HOUR_MS / 2).build());
        c.on_transfer_complete(hash.clone(), payer(), Exit::Claim, Ok(()));
        assert_eq!(c.get_lock(hash.clone(), payer()).unwrap().status, "Claimed");
        assert_eq!(c.get_lock(hash, accounts(4)).unwrap().status, "Locked");
    }

    #[test]
    fn claim_refund_and_get_lock_address_only_their_own_pair() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        assert_value(lock_as(&mut c, accounts(4), 0, 1, &hash), 0);
        assert_value(lock_as(&mut c, payer(), 0, 1_000, &hash), 0);

        // Claiming the squatter's pair moves only that pair.
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash.clone(), accounts(4), preimage);
        assert_eq!(c.get_lock(hash.clone(), accounts(4)).unwrap().status, "Claiming");
        assert_eq!(c.get_lock(hash.clone(), payer()).unwrap().status, "Locked");
        assert_eq!(c.get_lock(hash.clone(), payer()).unwrap().preimage, None);

        // A refund names (predecessor, hash): the payer's own lock, never the squatter's.
        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _r = c.refund(hash.clone());
        assert_eq!(c.get_lock(hash.clone(), payer()).unwrap().status, "Refunding");
        assert_eq!(c.get_lock(hash.clone(), accounts(4)).unwrap().status, "Claiming");

        // An account with no lock under this hash gets nothing.
        assert!(c.get_lock(hash, accounts(5)).is_none());
    }

    #[test]
    #[should_panic(expected = "No lock for this hash")]
    fn claim_naming_a_payer_with_no_lock_panics() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        assert_value(lock_as(&mut c, payer(), 0, 1_000, &hash), 0);
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _ = c.claim(hash, accounts(4), preimage);
    }

    #[test]
    #[should_panic(expected = "No lock for this hash")]
    fn refund_by_an_account_with_no_lock_under_the_hash_panics() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        assert_value(lock_as(&mut c, payer(), 0, 1_000, &hash), 0);
        testing_env!(ctx(accounts(4), 2 * HOUR_MS).build());
        let _ = c.refund(hash);
    }

    #[test]
    fn same_payer_cannot_lock_the_same_hash_lock_twice() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        assert_value(lock_as(&mut c, payer(), 0, 1_000, &hash), 0);
        assert_value(lock_as(&mut c, payer(), 0, 42, &hash), 42);
        assert_eq!(c.get_lock(hash, payer()).unwrap().amount, U128(1_000));
    }

    #[test]
    fn lock_key_is_unambiguous_per_payer_and_hash() {
        let h = "a".repeat(64);
        assert_eq!(lock_key(&payer(), &h), format!("{}:{}", payer(), h));
        assert_ne!(lock_key(&payer(), &h), lock_key(&accounts(4), &h));
    }

    // ---- claim ----

    #[test]
    fn claim_with_correct_preimage_moves_to_claiming_and_reveals_it() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _promise = c.claim(hash.clone(), payer(), preimage.clone());

        let view = c.get_lock(hash, payer()).unwrap();
        assert_eq!(view.status, "Claiming");
        assert_eq!(view.preimage.as_deref(), Some(preimage.to_lowercase().as_str()));
    }

    #[test]
    #[should_panic(expected = "Preimage does not match hash lock")]
    fn claim_with_wrong_preimage_panics() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        // 32 bytes (F1), but the wrong 32 bytes -- exercises the hash-mismatch check, not the
        // length check.
        let _ = c.claim(hash, payer(), hex_encode(b"totally-wrong-secret-32-bytes!!!"));
    }

    #[test]
    #[should_panic(expected = "Preimage is not valid hex")]
    fn claim_with_non_hex_preimage_panics() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _ = c.claim(hash, payer(), "not hex zz".to_string());
    }

    #[test]
    #[should_panic(expected = "Preimage must be 32 bytes")]
    fn claim_rejects_non_32_byte_preimage() {
        let mut c = setup();
        testing_env!(ctx(token(), 0).build());
        let pre = vec![7u8; 33];
        let hash = hex_encode(&env::sha256(&pre));
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _ = c.claim(hash, payer(), hex_encode(&pre));
    }

    #[test]
    #[should_panic(expected = "Preimage must be 32 bytes")]
    fn claim_rejects_empty_preimage() {
        let mut c = setup();
        testing_env!(ctx(token(), 0).build());
        let pre: Vec<u8> = vec![];
        let hash = hex_encode(&env::sha256(&pre));
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _ = c.claim(hash, payer(), hex_encode(&pre));
    }

    #[test]
    #[should_panic(expected = "Preimage must be 32 bytes")]
    fn claim_rejects_31_byte_preimage() {
        let mut c = setup();
        testing_env!(ctx(token(), 0).build());
        let pre = vec![9u8; 31];
        let hash = hex_encode(&env::sha256(&pre));
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _ = c.claim(hash, payer(), hex_encode(&pre));
    }

    #[test]
    #[should_panic(expected = "No lock for this hash")]
    fn claim_on_unknown_hash_lock_panics() {
        let mut c = setup();
        testing_env!(ctx(payee(), 0).build());
        let _ = c.claim("a".repeat(64), payer(), "00".to_string());
    }

    #[test]
    #[should_panic(expected = "Refund window has opened")]
    fn claim_after_refund_after_ms_panics() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), 2 * HOUR_MS).build());
        let _ = c.claim(hash, payer(), preimage);
    }

    #[test]
    #[should_panic(expected = "Lock is not claimable")]
    fn claim_is_permissionless_but_refunding_blocks_it() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        // Move the lock to Refunding first.
        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _p = c.refund(hash.clone());

        // Now claim is blocked while Refunding.
        testing_env!(ctx(payee(), 2 * HOUR_MS).build());
        let _ = c.claim(hash, payer(), preimage);
    }

    #[test]
    fn claim_is_storage_neutral() {
        let mut c = setup();
        let pre = vec![9u8; 32];
        testing_env!(ctx(token(), 0).build());
        let hash = hex_encode(&env::sha256(&pre));
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        let before = env::storage_usage();
        let mut b = ctx(payee(), HOUR_MS / 2);
        b.storage_usage(before);
        testing_env!(b.build());
        let _p = c.claim(hash, payer(), hex_encode(&pre));
        assert_eq!(env::storage_usage(), before, "claim grew storage");
    }

    #[test]
    fn lock_refused_when_contract_cannot_cover_storage_plus_reserve() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let mut b = ctx(token(), 0);
        b.account_balance(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        let res = c.ft_on_transfer(payer(), U128(1_000), lock_msg(&hash, HOUR_MS, 2 * HOUR_MS));
        assert_value(res, 1_000);
        assert!(c.get_lock(hash, payer()).is_none());
    }

    // ---- refund ----

    #[test]
    fn refund_after_window_moves_to_refunding() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _promise = c.refund(hash.clone());

        let view = c.get_lock(hash, payer()).unwrap();
        assert_eq!(view.status, "Refunding");
    }

    #[test]
    #[should_panic(expected = "No lock for this hash")]
    fn non_payer_refund_panics() {
        // Squatting fix: refund is keyed by (predecessor, hash), so a non-payer simply has
        // no lock under the hash; the payer-equality require is now structurally redundant.
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), 2 * HOUR_MS).build());
        let _ = c.refund(hash);
    }

    #[test]
    #[should_panic(expected = "Refund window has not opened")]
    fn early_refund_panics() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payer(), HOUR_MS / 2).build());
        let _ = c.refund(hash);
    }

    #[test]
    #[should_panic(expected = "No lock for this hash")]
    fn refund_on_unknown_hash_lock_panics() {
        let mut c = setup();
        testing_env!(ctx(payer(), 0).build());
        let _ = c.refund("b".repeat(64));
    }

    #[test]
    #[should_panic(expected = "Lock is not refundable")]
    fn refund_blocked_while_claiming() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        // Move the lock to Claiming first (still within the claim window).
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash.clone(), payer(), preimage);

        // Refund is blocked while Claiming, even after the window opens.
        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _ = c.refund(hash);
    }

    // ---- callback transitions (both exits, success and failure) ----

    #[test]
    fn claim_callback_success_moves_to_claimed() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash.clone(), payer(), preimage);

        testing_env!(ctx(contract_account(), HOUR_MS / 2).build());
        c.on_transfer_complete(hash.clone(), payer(), Exit::Claim, Ok(()));

        assert_eq!(c.get_lock(hash, payer()).unwrap().status, "Claimed");
    }

    #[test]
    fn claim_callback_failure_reverts_to_locked_but_keeps_preimage() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash.clone(), payer(), preimage.clone());

        testing_env!(ctx(contract_account(), HOUR_MS / 2).build());
        c.on_transfer_complete(hash.clone(), payer(), Exit::Claim, Err(PromiseError::Failed));

        let view = c.get_lock(hash, payer()).unwrap();
        assert_eq!(view.status, "Locked");
        assert_eq!(view.preimage.as_deref(), Some(preimage.to_lowercase().as_str()));
    }

    #[test]
    fn refund_callback_success_moves_to_refunded() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _p = c.refund(hash.clone());

        testing_env!(ctx(contract_account(), 2 * HOUR_MS).build());
        c.on_transfer_complete(hash.clone(), payer(), Exit::Refund, Ok(()));

        assert_eq!(c.get_lock(hash, payer()).unwrap().status, "Refunded");
    }

    #[test]
    fn refund_callback_failure_reverts_to_locked() {
        let mut c = setup();
        let (_, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);
        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _p = c.refund(hash.clone());

        testing_env!(ctx(contract_account(), 2 * HOUR_MS).build());
        c.on_transfer_complete(hash.clone(), payer(), Exit::Refund, Err(PromiseError::Failed));

        let view = c.get_lock(hash.clone(), payer()).unwrap();
        assert_eq!(view.status, "Locked");

        // A reverted-to-Locked lock is claimable/refundable again.
        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _p2 = c.refund(hash.clone());
        assert_eq!(c.get_lock(hash, payer()).unwrap().status, "Refunding");
    }

    #[test]
    #[should_panic(expected = "Lock already claimed (preimage revealed); refund is refused")]
    fn refund_refused_after_preimage_revealed_and_payout_failed() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash.clone(), payer(), preimage);

        testing_env!(ctx(contract_account(), HOUR_MS / 2).build());
        c.on_transfer_complete(hash.clone(), payer(), Exit::Claim, Err(PromiseError::Failed));

        testing_env!(ctx(payer(), 2 * HOUR_MS).build());
        let _ = c.refund(hash); // today (pre-fix): succeeds, moves to Refunding
    }

    #[test]
    fn payee_can_retry_claim_after_refund_after_once_revealed() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash.clone(), payer(), preimage.clone());

        testing_env!(ctx(contract_account(), HOUR_MS / 2).build());
        c.on_transfer_complete(hash.clone(), payer(), Exit::Claim, Err(PromiseError::Failed));

        // Past refund_after_ms, but the preimage was already revealed by the first claim
        // attempt -- the retry must still succeed (pre-fix: panics "Refund window has
        // opened").
        testing_env!(ctx(payee(), 3 * HOUR_MS).build());
        let _p2 = c.claim(hash.clone(), payer(), preimage);
        assert_eq!(c.get_lock(hash, payer()).unwrap().status, "Claiming");
    }

    #[test]
    fn claiming_event_carries_the_preimage() {
        let mut c = setup();
        let (preimage, hash) = preimage_and_hash();
        let _ = lock_via_transfer(&mut c, 0, 1_000, &hash, HOUR_MS, 2 * HOUR_MS);

        testing_env!(ctx(payee(), HOUR_MS / 2).build());
        let _p = c.claim(hash, payer(), preimage.clone());
        let logs = near_sdk::test_utils::get_logs();
        let claiming = logs
            .iter()
            .find(|l| l.contains("\"claiming\""))
            .expect("a claiming event was logged");
        assert!(claiming.contains(&preimage));
    }

    // ---- hex helpers ----

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0u8, 1, 255, 16, 171];
        let s = hex_encode(&bytes);
        assert_eq!(decode_hex(&s).unwrap(), bytes);
    }

    #[test]
    fn decode_hex_rejects_odd_length_and_bad_chars() {
        assert!(decode_hex("abc").is_none());
        assert!(decode_hex("zz").is_none());
    }
}
