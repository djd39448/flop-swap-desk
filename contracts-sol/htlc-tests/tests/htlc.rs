//! In-process tests of the built `htlc.so` (litesvm). Every keypair is generated in memory per run
//! and never printed, written or logged. Error codes mirror `HtlcError` in htlc/src/lib.rs.
#![allow(clippy::too_many_arguments)]

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

// ---- error codes (must equal HtlcError) -------------------------------------------------------------
const E_INVALID_INSTRUCTION: u32 = 1;
const E_WRONG_PROGRAM_ID: u32 = 2;
const E_ZERO_AMOUNT: u32 = 3;
const E_BAD_WINDOW: u32 = 4;
const E_WINDOW_CLOSED: u32 = 5;
const E_PAYEE_IS_PROGRAM_ACCOUNT: u32 = 6;
const E_WRONG_MINT: u32 = 7;
const E_DUPLICATE_ACCOUNT: u32 = 8;
const E_MISSING_SIGNER: u32 = 9;
const E_NOT_WRITABLE: u32 = 10;
const E_WRONG_TOKEN_PROGRAM: u32 = 11;
const E_WRONG_SYSTEM_PROGRAM: u32 = 12;
const E_WRONG_ESCROW_ADDRESS: u32 = 13;
const E_WRONG_VAULT_ADDRESS: u32 = 14;
const E_ESCROW_EXISTS: u32 = 15;
const E_BAD_ESCROW_STATE: u32 = 16;
const E_BAD_TOKEN_ACCOUNT: u32 = 17;
const E_NOT_LOCKED: u32 = 18;
const E_CLAIM_WINDOW_CLOSED: u32 = 19;
const E_WRONG_PREIMAGE: u32 = 20;
const E_NOT_PAYER: u32 = 21;
const E_REFUND_TOO_EARLY: u32 = 22;
const E_OVERFLOW: u32 = 23;
const E_BAD_MINT: u32 = 24;

// ---- constants shared with the program ---------------------------------------------------------------
const PROGRAM_ID: [u8; 32] = [
    232, 131, 124, 251, 229, 38, 137, 47, 49, 67, 20, 24, 240, 88, 87, 249, 68, 217, 196, 194, 176,
    145, 179, 78, 99, 161, 40, 7, 32, 6, 56, 105,
];
const TOKEN_PROGRAM: [u8; 32] = [
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
];
const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ESCROW_LEN: usize = 188;
const TA_LEN: usize = 165;
const T0: i64 = 1_000_000; // unix seconds at test start
const HOUR: i64 = 3600;
const DECIMALS: u8 = 6;

fn program_id() -> Address {
    Address::new_from_array(PROGRAM_ID)
}
fn token_program() -> Address {
    Address::new_from_array(TOKEN_PROGRAM)
}
fn system_program() -> Address {
    Address::new_from_array([0u8; 32])
}
fn sha(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}
fn mock_mint() -> Address {
    Address::new_from_array(sha(b"flop-swap-desk:sol-mock-usdc:v1"))
}
fn so_path() -> String {
    std::env::var("HTLC_SO").unwrap_or_else(|_| {
        format!("{}/.cache/flop-sol-target/deploy/htlc.so", std::env::var("HOME").unwrap())
    })
}

fn pda_escrow(payer: &Address, hash: &[u8; 32]) -> Address {
    Address::find_program_address(&[b"htlc", payer.as_ref(), hash], &program_id()).0
}
fn pda_vault(escrow: &Address) -> Address {
    Address::find_program_address(&[b"vault", escrow.as_ref()], &program_id()).0
}

fn mint_data(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[36..44].copy_from_slice(&1_000_000_000u64.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}
fn ta_data(mint: &Address, owner: &Address, amount: u64, state: u8) -> Vec<u8> {
    let mut d = vec![0u8; TA_LEN];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = state;
    d
}

fn put_mint(svm: &mut LiteSVM, key: &Address, decimals: u8) {
    svm.set_account(
        *key,
        Account { lamports: 1_461_600, data: mint_data(decimals), owner: token_program(), executable: false, rent_epoch: 0 },
    )
    .unwrap();
}
fn put_ta(svm: &mut LiteSVM, key: &Address, mint: &Address, owner: &Address, amount: u64, state: u8) {
    svm.set_account(
        *key,
        Account { lamports: 2_039_280, data: ta_data(mint, owner, amount, state), owner: token_program(), executable: false, rent_epoch: 0 },
    )
    .unwrap();
}
fn ta_amount(svm: &LiteSVM, key: &Address) -> u64 {
    let a = svm.get_account(key).expect("token account exists");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
fn lamports(svm: &LiteSVM, key: &Address) -> u64 {
    svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
}
fn set_time(svm: &mut LiteSVM, secs: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = secs;
    svm.set_sysvar(&c);
}

// ---- instruction builders --------------------------------------------------------------------------
fn lock_data(hash: &[u8; 32], payee: &Address, claim_by_ms: i64, refund_after_ms: i64, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8];
    d.extend_from_slice(hash);
    d.extend_from_slice(payee.as_ref());
    d.extend_from_slice(&claim_by_ms.to_le_bytes());
    d.extend_from_slice(&refund_after_ms.to_le_bytes());
    d.extend_from_slice(&amount.to_le_bytes());
    d
}
fn lock_metas(payer: &Address, escrow: &Address, vault: &Address, mint: &Address, payer_ta: &Address) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new(*escrow, false),
        AccountMeta::new(*vault, false),
        AccountMeta::new_readonly(*mint, false),
        AccountMeta::new(*payer_ta, false),
        AccountMeta::new_readonly(token_program(), false),
        AccountMeta::new_readonly(system_program(), false),
    ]
}
fn claim_metas(escrow: &Address, vault: &Address, mint: &Address, payee_ta: &Address) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*escrow, false),
        AccountMeta::new(*vault, false),
        AccountMeta::new_readonly(*mint, false),
        AccountMeta::new(*payee_ta, false),
        AccountMeta::new_readonly(token_program(), false),
    ]
}
fn refund_metas(payer: &Address, escrow: &Address, vault: &Address, mint: &Address, payer_ta: &Address) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(*payer, true),
        AccountMeta::new(*escrow, false),
        AccountMeta::new(*vault, false),
        AccountMeta::new_readonly(*mint, false),
        AccountMeta::new(*payer_ta, false),
        AccountMeta::new_readonly(token_program(), false),
    ]
}
fn ix(metas: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: program_id(), accounts: metas, data }
}
fn claim_data(preimage: &[u8]) -> Vec<u8> {
    let mut d = vec![1u8];
    d.extend_from_slice(preimage);
    d
}
fn refund_data() -> Vec<u8> {
    vec![2u8]
}

type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Sent {
    svm.expire_blockhash();
    let tx = Transaction::new(signers, Message::new(ixs, Some(&signers[0].pubkey())), svm.latest_blockhash());
    svm.send_transaction(tx)
}

fn err_text(r: &Sent) -> String {
    match r {
        Ok(_) => "OK".to_string(),
        Err(f) => format!("{:?}", f.err),
    }
}
fn assert_code(r: &Sent, code: u32) {
    let t = err_text(r);
    assert!(t.contains(&format!("Custom({code})")), "expected Custom({code}), got {t}");
}
fn assert_ok(r: &Sent) {
    if let Err(f) = r {
        panic!("expected success, got {:?}\n{}", f.err, f.meta.pretty_logs());
    }
}

// ---- environment -------------------------------------------------------------------------------------
struct Env {
    svm: LiteSVM,
    mint: Address,
    payer: Keypair,
    payer_ta: Address,
    payee: Address,
    payee_ta: Address,
    cranker: Keypair,
    preimage: [u8; 32],
    hash: [u8; 32],
}

const BALANCE: u64 = 1_000_000;

impl Env {
    fn new() -> Env {
        let mut svm = LiteSVM::new();
        let so = so_path();
        svm.add_program_from_file(program_id(), &so).unwrap_or_else(|e| panic!("load {so}: {e:?}"));
        set_time(&mut svm, T0);
        let mint = mock_mint();
        put_mint(&mut svm, &mint, DECIMALS);
        let payer = Keypair::new();
        let cranker = Keypair::new();
        let payee = Address::new_unique();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&cranker.pubkey(), 1_000_000_000).unwrap();
        let payer_ta = Address::new_unique();
        let payee_ta = Address::new_unique();
        put_ta(&mut svm, &payer_ta, &mint, &payer.pubkey(), BALANCE, 1);
        put_ta(&mut svm, &payee_ta, &mint, &payee, 0, 1);
        let preimage = [7u8; 32];
        let hash = sha(&preimage);
        Env { svm, mint, payer, payer_ta, payee, payee_ta, cranker, preimage, hash }
    }
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Sent {
        send(&mut self.svm, ixs, signers)
    }
    fn escrow(&self) -> Address {
        pda_escrow(&self.payer.pubkey(), &self.hash)
    }
    fn vault(&self) -> Address {
        pda_vault(&self.escrow())
    }
    fn claim_by(&self) -> i64 {
        (T0 + HOUR) * 1000
    }
    fn refund_after(&self) -> i64 {
        (T0 + 2 * HOUR) * 1000
    }
    fn lock_ix(&self, amount: u64) -> Instruction {
        ix(
            lock_metas(&self.payer.pubkey(), &self.escrow(), &self.vault(), &self.mint, &self.payer_ta),
            lock_data(&self.hash, &self.payee, self.claim_by(), self.refund_after(), amount),
        )
    }
    fn lock(&mut self, amount: u64) -> Sent {
        let i = self.lock_ix(amount);
        let p = Keypair::try_from(self.payer.to_bytes().as_slice()).unwrap();
        send(&mut self.svm, &[i], &[&p])
    }
    fn claim_ix(&self, preimage: &[u8]) -> Instruction {
        ix(claim_metas(&self.escrow(), &self.vault(), &self.mint, &self.payee_ta), claim_data(preimage))
    }
    fn claim(&mut self) -> Sent {
        let i = self.claim_ix(&self.preimage.clone());
        let c = Keypair::try_from(self.cranker.to_bytes().as_slice()).unwrap();
        send(&mut self.svm, &[i], &[&c])
    }
    fn refund_ix(&self) -> Instruction {
        ix(
            refund_metas(&self.payer.pubkey(), &self.escrow(), &self.vault(), &self.mint, &self.payer_ta),
            refund_data(),
        )
    }
    fn refund(&mut self) -> Sent {
        let i = self.refund_ix();
        let p = Keypair::try_from(self.payer.to_bytes().as_slice()).unwrap();
        send(&mut self.svm, &[i], &[&p])
    }
    fn escrow_bytes(&self) -> Vec<u8> {
        self.svm.get_account(&self.escrow()).expect("escrow exists").data
    }
    fn status(&self) -> u8 {
        self.escrow_bytes()[1]
    }
    fn locked(mut self) -> Env {
        assert_ok(&self.lock(500_000));
        self
    }
}

// ---- Lock: happy path and accounting -------------------------------------------------------------------

#[test]
fn lock_creates_escrow_and_vault_and_moves_the_funds() {
    let mut e = Env::new();
    let before = lamports(&e.svm, &e.payer.pubkey());
    let r = e.lock(500_000);
    assert_ok(&r);
    let fee = r.unwrap().fee;

    let d = e.escrow_bytes();
    assert_eq!(d.len(), ESCROW_LEN);
    assert_eq!(d[0], 1, "version");
    assert_eq!(d[1], 1, "status Locked");
    assert_eq!(d[2], 0, "not revealed");
    assert_eq!(&d[4..36], e.payer.pubkey().as_ref());
    assert_eq!(&d[36..68], e.payee.as_ref());
    assert_eq!(&d[68..100], e.mint.as_ref());
    assert_eq!(&d[100..132], &e.hash);
    assert_eq!(u64::from_le_bytes(d[132..140].try_into().unwrap()), 500_000);
    assert_eq!(i64::from_le_bytes(d[140..148].try_into().unwrap()), e.claim_by());
    assert_eq!(i64::from_le_bytes(d[148..156].try_into().unwrap()), e.refund_after());
    assert_eq!(&d[156..188], &[0u8; 32], "preimage zero until claimed");
    assert_eq!(e.svm.get_account(&e.escrow()).unwrap().owner, program_id());

    let v = e.svm.get_account(&e.vault()).unwrap();
    assert_eq!(v.owner, token_program());
    assert_eq!(&v.data[0..32], e.mint.as_ref());
    assert_eq!(&v.data[32..64], e.escrow().as_ref(), "vault owned by the escrow PDA");
    assert_eq!(ta_amount(&e.svm, &e.vault()), 500_000);
    assert_eq!(ta_amount(&e.svm, &e.payer_ta), BALANCE - 500_000);

    // rent accounting: the payer paid exactly the two rent-exempt minimums plus the fee
    let rent_escrow = e.svm.minimum_balance_for_rent_exemption(ESCROW_LEN);
    let rent_vault = e.svm.minimum_balance_for_rent_exemption(TA_LEN);
    assert_eq!(lamports(&e.svm, &e.escrow()), rent_escrow);
    assert_eq!(lamports(&e.svm, &e.vault()), rent_vault);
    assert_eq!(before - lamports(&e.svm, &e.payer.pubkey()), rent_escrow + rent_vault + fee);
}

#[test]
fn lock_by_the_program_only_under_its_declared_id() {
    // Same binary at another address: PDAs would derive differently, so it must refuse to run.
    let mut e = Env::new();
    let other = Address::new_unique();
    e.svm.add_program_from_file(other, so_path()).unwrap();
    let mut i = e.lock_ix(1);
    i.program_id = other;
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    assert_code(&e.send(&[i], &[&p]), E_WRONG_PROGRAM_ID);
}

// ---- Lock: refusals -----------------------------------------------------------------------------------

#[test]
fn lock_zero_amount_refused() {
    let mut e = Env::new();
    assert_code(&e.lock(0), E_ZERO_AMOUNT);
    assert!(e.svm.get_account(&e.escrow()).is_none());
}

#[test]
fn lock_window_checks() {
    let mut e = Env::new();
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let m = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta);
    // claim_by == refund_after
    let r = e.send(&[ix(m.clone(), lock_data(&e.hash, &e.payee, e.refund_after(), e.refund_after(), 5))], &[&p]);
    assert_code(&r, E_BAD_WINDOW);
    // claim_by > refund_after
    let r = e.send(&[ix(m.clone(), lock_data(&e.hash, &e.payee, e.refund_after() + 1, e.refund_after(), 5))], &[&p]);
    assert_code(&r, E_BAD_WINDOW);
    // refund_after already in the past
    set_time(&mut e.svm, T0 + 3 * HOUR);
    let r = e.send(&[ix(m.clone(), lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5))], &[&p]);
    assert_code(&r, E_WINDOW_CLOSED);
    // now == refund_after is closed as well
    set_time(&mut e.svm, T0 + 2 * HOUR);
    let r = e.send(&[ix(m.clone(), lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5))], &[&p]);
    assert_code(&r, E_WINDOW_CLOSED);
    // one second before refund_after is fine
    set_time(&mut e.svm, T0 + 2 * HOUR - 1);
    let r = e.send(&[ix(m, lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5))], &[&p]);
    assert_ok(&r);
}

#[test]
fn lock_with_absurd_clock_overflows_checked() {
    let mut e = Env::new();
    set_time(&mut e.svm, i64::MAX);
    assert_code(&e.lock(5), E_OVERFLOW);
}

#[test]
fn lock_malformed_data_refused() {
    let mut e = Env::new();
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let m = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta);
    let good = lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5);
    for bad in [vec![], vec![0u8], good[..good.len() - 1].to_vec(), { let mut g = good.clone(); g.push(0); g }, vec![9u8; 89]] {
        let r = e.send(&[ix(m.clone(), bad)], &[&p]);
        assert_code(&r, E_INVALID_INSTRUCTION);
    }
    assert!(e.svm.get_account(&e.escrow()).is_none());
}

#[test]
fn lock_wrong_mint_refused() {
    let mut e = Env::new();
    // (a) a perfectly good token, but not the configured mint
    let other_mint = Address::new_unique();
    put_mint(&mut e.svm, &other_mint, DECIMALS);
    let other_ta = Address::new_unique();
    put_ta(&mut e.svm, &other_ta, &other_mint, &e.payer.pubkey(), BALANCE, 1);
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let m = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &other_mint, &other_ta);
    let r = e.send(&[ix(m, lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5))], &[&p]);
    assert_code(&r, E_WRONG_MINT);
    // (b) right mint, but the payer's token account is for another mint
    let bad_ta = Address::new_unique();
    put_ta(&mut e.svm, &bad_ta, &other_mint, &e.payer.pubkey(), BALANCE, 1);
    let m = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &bad_ta);
    let r = e.send(&[ix(m, lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5))], &[&p]);
    assert_code(&r, E_BAD_TOKEN_ACCOUNT);
    // (c) the configured mint address holding garbage / owned by the wrong program
    let mut acct = e.svm.get_account(&e.mint).unwrap();
    acct.owner = Address::new_unique();
    e.svm.set_account(e.mint, acct).unwrap();
    let r = e.lock(5);
    assert_code(&r, E_BAD_MINT);
}

#[test]
fn lock_payer_token_account_owned_by_someone_else_refused() {
    let mut e = Env::new();
    let victim = Address::new_unique();
    let victim_ta = Address::new_unique();
    put_ta(&mut e.svm, &victim_ta, &e.mint, &victim, BALANCE, 1);
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let m = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &victim_ta);
    let r = e.send(&[ix(m, lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5))], &[&p]);
    assert_code(&r, E_BAD_TOKEN_ACCOUNT);
    assert_eq!(ta_amount(&e.svm, &victim_ta), BALANCE);
}

#[test]
fn lock_frozen_or_short_payer_account_refused() {
    let mut e = Env::new();
    put_ta(&mut e.svm, &e.payer_ta.clone(), &e.mint.clone(), &e.payer.pubkey(), BALANCE, 2);
    assert_code(&e.lock(5), E_BAD_TOKEN_ACCOUNT);
    put_ta(&mut e.svm, &e.payer_ta.clone(), &e.mint.clone(), &e.payer.pubkey(), 4, 1);
    assert_code(&e.lock(5), E_BAD_TOKEN_ACCOUNT);
}

#[test]
fn lock_payee_may_not_be_the_escrow_or_the_vault() {
    let mut e = Env::new();
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let m = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta);
    for bad in [e.escrow(), e.vault()] {
        let r = e.send(&[ix(m.clone(), lock_data(&e.hash, &bad, e.claim_by(), e.refund_after(), 5))], &[&p]);
        assert_code(&r, E_PAYEE_IS_PROGRAM_ACCOUNT);
    }
}

#[test]
fn lock_account_validation() {
    let mut e = Env::new();
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let data = lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 5);
    let good = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta);

    // payer not a signer (someone else pays the fee and signs)
    let mut m = good.clone();
    m[0].is_signer = false;
    let r = e.send(&[ix(m, data.clone())], &[&e.cranker.insecure_clone()]);
    assert_code(&r, E_MISSING_SIGNER);

    // escrow / vault / payer token account not writable
    for idx in [1usize, 2, 4] {
        let mut m = good.clone();
        m[idx].is_writable = false;
        assert_code(&e.send(&[ix(m, data.clone())], &[&p]), E_NOT_WRITABLE);
    }

    // escrow address of another payer / random address
    for wrong in [pda_escrow(&Address::new_unique(), &e.hash), Address::new_unique()] {
        let mut m = good.clone();
        m[1].pubkey = wrong;
        assert_code(&e.send(&[ix(m, data.clone())], &[&p]), E_WRONG_ESCROW_ADDRESS);
    }

    // fake vault (any address that is not the derived vault)
    let mut m = good.clone();
    m[2].pubkey = Address::new_unique();
    assert_code(&e.send(&[ix(m, data.clone())], &[&p]), E_WRONG_VAULT_ADDRESS);

    // wrong token program (Token-2022, a random key) and wrong system program
    for tp in [TOKEN_2022.parse::<Address>().unwrap(), Address::new_unique()] {
        let mut m = good.clone();
        m[5].pubkey = tp;
        assert_code(&e.send(&[ix(m, data.clone())], &[&p]), E_WRONG_TOKEN_PROGRAM);
    }
    let mut m = good.clone();
    m[6].pubkey = Address::new_unique();
    assert_code(&e.send(&[ix(m, data.clone())], &[&p]), E_WRONG_SYSTEM_PROGRAM);

    // duplicate accounts
    let mut m = good.clone();
    m[4].pubkey = m[2].pubkey; // payer token account == vault
    assert_code(&e.send(&[ix(m, data.clone())], &[&p]), E_DUPLICATE_ACCOUNT);
    let mut m = good.clone();
    m[3].pubkey = m[4].pubkey; // mint == payer token account
    assert_code(&e.send(&[ix(m, data.clone())], &[&p]), E_DUPLICATE_ACCOUNT);

    // too few / too many accounts
    let mut m = good.clone();
    m.pop();
    let r = e.send(&[ix(m, data.clone())], &[&p]);
    assert!(err_text(&r).contains("NotEnoughAccountKeys"), "{}", err_text(&r));
    let mut m = good.clone();
    m.push(AccountMeta::new_readonly(Address::new_unique(), false));
    let r = e.send(&[ix(m, data.clone())], &[&p]);
    assert!(err_text(&r).contains("NotEnoughAccountKeys"), "{}", err_text(&r));

    assert!(e.svm.get_account(&e.escrow()).is_none(), "no refused lock left state behind");
    assert_eq!(ta_amount(&e.svm, &e.payer_ta), BALANCE);
}

#[test]
fn lock_twice_by_the_same_payer_is_refused_and_leaves_the_first_intact() {
    let mut e = Env::new().locked();
    let before = e.escrow_bytes();
    assert_code(&e.lock(1), E_ESCROW_EXISTS);
    assert_eq!(e.escrow_bytes(), before);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 500_000);
}

// ---- squatting and pre-funding -------------------------------------------------------------------------

#[test]
fn squat_by_another_payer_does_not_block_the_real_lock() {
    let mut e = Env::new();
    // the squatter locks 1 unit under the same (public) hash lock first
    let squatter = Keypair::new();
    e.svm.airdrop(&squatter.pubkey(), 1_000_000_000).unwrap();
    let sq_ta = Address::new_unique();
    put_ta(&mut e.svm, &sq_ta, &e.mint, &squatter.pubkey(), 10, 1);
    let sq_escrow = pda_escrow(&squatter.pubkey(), &e.hash);
    let i = ix(
        lock_metas(&squatter.pubkey(), &sq_escrow, &pda_vault(&sq_escrow), &e.mint, &sq_ta),
        lock_data(&e.hash, &e.payee, e.claim_by(), e.refund_after(), 1),
    );
    assert_ok(&e.send(&[i], &[&squatter]));

    // the real payer still locks, and the Seller's claim pays the real lock
    assert_ne!(sq_escrow, e.escrow());
    assert_ok(&e.lock(500_000));
    assert_ok(&e.claim());
    assert_eq!(ta_amount(&e.svm, &e.payee_ta), 500_000);

    // claim/refund address only their own escrow: the squatter refunds its own unit after the window
    set_time(&mut e.svm, T0 + 2 * HOUR);
    let i = ix(
        refund_metas(&squatter.pubkey(), &sq_escrow, &pda_vault(&sq_escrow), &e.mint, &sq_ta),
        refund_data(),
    );
    assert_ok(&e.send(&[i], &[&squatter]));
    assert_eq!(ta_amount(&e.svm, &sq_ta), 10);
    assert_eq!(e.status(), 2, "the real escrow is untouched by the squatter's refund");
}

#[test]
fn prefunding_the_pdas_cannot_block_the_lock() {
    let mut e = Env::new();
    // an attacker sends lamports to both derived addresses before the lock (a create_account
    // based program would fail with "account already in use")
    e.svm.airdrop(&e.escrow(), 1_000_000).unwrap();
    e.svm.airdrop(&e.vault(), 5_000_000).unwrap();
    let before = lamports(&e.svm, &e.payer.pubkey());
    let r = e.lock(500_000);
    assert_ok(&r);
    let fee = r.unwrap().fee;
    let rent_escrow = e.svm.minimum_balance_for_rent_exemption(ESCROW_LEN);
    let rent_vault = e.svm.minimum_balance_for_rent_exemption(TA_LEN);
    assert_eq!(lamports(&e.svm, &e.escrow()), rent_escrow);
    // the vault keeps the attacker's (larger) prefund: the payer only tops up what is missing
    assert_eq!(lamports(&e.svm, &e.vault()), 5_000_000.max(rent_vault));
    assert_eq!(
        before - lamports(&e.svm, &e.payer.pubkey()),
        (rent_escrow - 1_000_000) + fee
    );
    assert_ok(&e.claim());
    assert_eq!(ta_amount(&e.svm, &e.payee_ta), 500_000);
}

// ---- Claim -----------------------------------------------------------------------------------------------

#[test]
fn claim_pays_the_payee_permissionlessly_and_stores_the_preimage() {
    let mut e = Env::new().locked();
    let escrow_lamports = lamports(&e.svm, &e.escrow());
    let vault_lamports = lamports(&e.svm, &e.vault());
    assert_ok(&e.claim()); // fee payer is a third party with no relation to the swap
    assert_eq!(ta_amount(&e.svm, &e.payee_ta), 500_000);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 0);
    let d = e.escrow_bytes();
    assert_eq!(d[1], 2, "Claimed");
    assert_eq!(d[2], 1, "revealed");
    assert_eq!(&d[156..188], &e.preimage);
    // lamport accounting: nothing but tokens moved
    assert_eq!(lamports(&e.svm, &e.escrow()), escrow_lamports);
    assert_eq!(lamports(&e.svm, &e.vault()), vault_lamports);
}

#[test]
fn claim_wrong_preimage_and_malformed_length_refused() {
    let mut e = Env::new().locked();
    let c = Keypair::try_from(e.cranker.to_bytes().as_slice()).unwrap();
    let wrong = [8u8; 32];
    assert_code(&e.send(&[e.claim_ix(&wrong)], &[&c]), E_WRONG_PREIMAGE);
    // 31 and 33 byte preimages cannot be expressed: the instruction is malformed
    for len in [0usize, 31, 33, 64] {
        let r = e.send(&[e.claim_ix(&vec![7u8; len])], &[&c]);
        assert_code(&r, E_INVALID_INSTRUCTION);
    }
    assert_eq!(e.status(), 1);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 500_000);
    assert_eq!(&e.escrow_bytes()[156..188], &[0u8; 32], "a refused claim stores nothing");
}

#[test]
fn double_claim_refused() {
    let mut e = Env::new().locked();
    assert_ok(&e.claim());
    assert_code(&e.claim(), E_NOT_LOCKED);
    assert_eq!(ta_amount(&e.svm, &e.payee_ta), 500_000);
}

#[test]
fn claim_window_boundary_and_exclusivity_with_refund() {
    // refund_after = (T0+2h)*1000 ms; the clock has second resolution
    let mut e = Env::new().locked();
    set_time(&mut e.svm, T0 + 2 * HOUR - 1);
    assert_code(&e.refund(), E_REFUND_TOO_EARLY);
    // exactly at refund_after: claim closed, refund open
    set_time(&mut e.svm, T0 + 2 * HOUR);
    assert_code(&e.claim(), E_CLAIM_WINDOW_CLOSED);
    assert_ok(&e.refund());
    assert_eq!(ta_amount(&e.svm, &e.payer_ta), BALANCE);
    // claim after refund, refund after refund
    assert_code(&e.claim(), E_NOT_LOCKED);
    assert_code(&e.refund(), E_NOT_LOCKED);
    assert_eq!(e.status(), 3);
}

#[test]
fn claim_last_second_succeeds() {
    let mut e = Env::new().locked();
    set_time(&mut e.svm, T0 + 2 * HOUR - 1);
    assert_ok(&e.claim());
    // and now the refund is refused on the status even after the window opens
    set_time(&mut e.svm, T0 + 3 * HOUR);
    assert_code(&e.refund(), E_NOT_LOCKED);
    assert_eq!(ta_amount(&e.svm, &e.payer_ta), BALANCE - 500_000);
}

#[test]
fn sub_second_refund_after_is_judged_in_milliseconds() {
    let mut e = Env::new();
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let ra = (T0 + HOUR) * 1000 + 500;
    let m = lock_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta);
    assert_ok(&e.send(&[ix(m, lock_data(&e.hash, &e.payee, ra - 1000, ra, 9))], &[&p]));
    set_time(&mut e.svm, T0 + HOUR); // now_ms = ra - 500: still claimable, not refundable
    assert_code(&e.refund(), E_REFUND_TOO_EARLY);
    set_time(&mut e.svm, T0 + HOUR + 1); // now_ms = ra + 500
    assert_code(&e.claim(), E_CLAIM_WINDOW_CLOSED);
    assert_ok(&e.refund());
}

#[test]
fn claim_payee_token_account_substitutions_refused() {
    let mut e = Env::new().locked();
    let c = Keypair::try_from(e.cranker.to_bytes().as_slice()).unwrap();
    let attacker = Address::new_unique();
    // token account owned by someone else (not the payee)
    let theirs = Address::new_unique();
    put_ta(&mut e.svm, &theirs, &e.mint, &attacker, 0, 1);
    let i = ix(claim_metas(&e.escrow(), &e.vault(), &e.mint, &theirs), claim_data(&e.preimage));
    assert_code(&e.send(&[i], &[&c]), E_BAD_TOKEN_ACCOUNT);
    // token account of the payee but for another mint
    let other_mint = Address::new_unique();
    put_mint(&mut e.svm, &other_mint, DECIMALS);
    let wrong_mint_ta = Address::new_unique();
    put_ta(&mut e.svm, &wrong_mint_ta, &other_mint, &e.payee, 0, 1);
    let i = ix(claim_metas(&e.escrow(), &e.vault(), &e.mint, &wrong_mint_ta), claim_data(&e.preimage));
    assert_code(&e.send(&[i], &[&c]), E_BAD_TOKEN_ACCOUNT);
    // a wallet (system account) instead of a token account
    let wallet = e.payee;
    e.svm.airdrop(&wallet, 1_000_000).unwrap();
    let i = ix(claim_metas(&e.escrow(), &e.vault(), &e.mint, &wallet), claim_data(&e.preimage));
    assert_code(&e.send(&[i], &[&c]), E_BAD_TOKEN_ACCOUNT);
    // frozen payee account
    put_ta(&mut e.svm, &e.payee_ta.clone(), &e.mint.clone(), &e.payee.clone(), 0, 2);
    assert_code(&e.claim(), E_BAD_TOKEN_ACCOUNT);
    assert_eq!(e.status(), 1);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 500_000);
}

#[test]
fn claim_with_missing_payee_token_account_fails_atomically() {
    let mut e = Env::new().locked();
    let ghost = Address::new_unique(); // never created
    let c = Keypair::try_from(e.cranker.to_bytes().as_slice()).unwrap();
    let before = e.escrow_bytes();
    let i = ix(claim_metas(&e.escrow(), &e.vault(), &e.mint, &ghost), claim_data(&e.preimage));
    let r = e.send(&[i], &[&c]);
    assert!(r.is_err());
    // the whole transaction reverted: still Locked, no preimage stored, vault intact. (The preimage is
    // nevertheless public in the failed transaction's instruction data: the top-level-failure class.)
    assert_eq!(e.escrow_bytes(), before);
    assert_eq!(e.status(), 1);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 500_000);
    // then the payee account appears and the very same claim works
    assert_ok(&e.claim());
}

#[test]
fn claim_account_substitutions_refused() {
    let mut e = Env::new().locked();
    let c = Keypair::try_from(e.cranker.to_bytes().as_slice()).unwrap();
    let good = claim_metas(&e.escrow(), &e.vault(), &e.mint, &e.payee_ta);
    let data = claim_data(&e.preimage);

    // fake vault address
    let fake_vault = Address::new_unique();
    let (mint, esc) = (e.mint, e.escrow());
    put_ta(&mut e.svm, &fake_vault, &mint, &esc, 500_000, 1);
    let mut m = good.clone();
    m[1].pubkey = fake_vault;
    assert_code(&e.send(&[ix(m, data.clone())], &[&c]), E_WRONG_VAULT_ADDRESS);

    // fake escrow: a system-owned account with forged data, and a program-owned one at the wrong address
    let fake_escrow = Address::new_unique();
    let forged = e.escrow_bytes();
    e.svm
        .set_account(fake_escrow, Account { lamports: 5_000_000, data: forged.clone(), owner: system_program(), executable: false, rent_epoch: 0 })
        .unwrap();
    let mut m = good.clone();
    m[0].pubkey = fake_escrow;
    assert_code(&e.send(&[ix(m.clone(), data.clone())], &[&c]), E_BAD_ESCROW_STATE);
    e.svm
        .set_account(fake_escrow, Account { lamports: 5_000_000, data: forged, owner: program_id(), executable: false, rent_epoch: 0 })
        .unwrap();
    assert_code(&e.send(&[ix(m, data.clone())], &[&c]), E_WRONG_ESCROW_ADDRESS);

    // escrow with an unknown version byte / wrong length
    let mut acct = e.svm.get_account(&e.escrow()).unwrap();
    let orig = acct.clone();
    acct.data[0] = 2;
    e.svm.set_account(e.escrow(), acct).unwrap();
    assert_code(&e.claim(), E_BAD_ESCROW_STATE);
    let mut acct = orig.clone();
    acct.data.push(0);
    e.svm.set_account(e.escrow(), acct).unwrap();
    assert_code(&e.claim(), E_BAD_ESCROW_STATE);
    e.svm.set_account(e.escrow(), orig).unwrap();

    // vault at the right address but not owned by the escrow PDA / other mint
    let mut acct = e.svm.get_account(&e.vault()).unwrap();
    let orig = acct.clone();
    acct.data[32..64].copy_from_slice(Address::new_unique().as_ref());
    e.svm.set_account(e.vault(), acct).unwrap();
    assert_code(&e.claim(), E_BAD_TOKEN_ACCOUNT);
    e.svm.set_account(e.vault(), orig).unwrap();

    // wrong token program, wrong mint account
    let mut m = good.clone();
    m[4].pubkey = TOKEN_2022.parse().unwrap();
    assert_code(&e.send(&[ix(m, data.clone())], &[&c]), E_WRONG_TOKEN_PROGRAM);
    let other_mint = Address::new_unique();
    put_mint(&mut e.svm, &other_mint, DECIMALS);
    let mut m = good.clone();
    m[2].pubkey = other_mint;
    assert_code(&e.send(&[ix(m, data.clone())], &[&c]), E_WRONG_MINT);

    // duplicates and non-writable
    let mut m = good.clone();
    m[3].pubkey = m[1].pubkey; // payee token account == vault
    assert_code(&e.send(&[ix(m, data.clone())], &[&c]), E_DUPLICATE_ACCOUNT);
    for idx in [0usize, 1, 3] {
        let mut m = good.clone();
        m[idx].is_writable = false;
        assert_code(&e.send(&[ix(m, data.clone())], &[&c]), E_NOT_WRITABLE);
    }

    // everything above changed nothing
    assert_eq!(e.status(), 1);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 500_000);
    assert_ok(&e.claim());
}

#[test]
fn stray_donation_to_the_vault_is_not_stranded() {
    let mut e = Env::new().locked();
    let v = e.vault();
    put_ta_keep_lamports(&mut e.svm, &v, 500_000 + 77);
    assert_ok(&e.claim());
    assert_eq!(ta_amount(&e.svm, &e.payee_ta), 500_077);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 0);
}

fn put_ta_keep_lamports(svm: &mut LiteSVM, key: &Address, amount: u64) {
    let mut a = svm.get_account(key).unwrap();
    a.data[64..72].copy_from_slice(&amount.to_le_bytes());
    svm.set_account(*key, a).unwrap();
}

// ---- Refund ------------------------------------------------------------------------------------------------

#[test]
fn refund_returns_the_funds_after_the_window() {
    let mut e = Env::new().locked();
    set_time(&mut e.svm, T0 + 2 * HOUR + 5);
    let escrow_lamports = lamports(&e.svm, &e.escrow());
    assert_ok(&e.refund());
    assert_eq!(ta_amount(&e.svm, &e.payer_ta), BALANCE);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 0);
    assert_eq!(e.status(), 3);
    assert_eq!(&e.escrow_bytes()[156..188], &[0u8; 32]);
    assert_eq!(lamports(&e.svm, &e.escrow()), escrow_lamports);
}

#[test]
fn refund_early_refused() {
    let mut e = Env::new().locked();
    set_time(&mut e.svm, T0 + HOUR); // claim_by, still before refund_after
    assert_code(&e.refund(), E_REFUND_TOO_EARLY);
    assert_eq!(e.status(), 1);
}

#[test]
fn refund_by_a_non_payer_refused() {
    let mut e = Env::new().locked();
    set_time(&mut e.svm, T0 + 3 * HOUR);
    let thief = Keypair::new();
    e.svm.airdrop(&thief.pubkey(), 1_000_000_000).unwrap();
    let thief_ta = Address::new_unique();
    put_ta(&mut e.svm, &thief_ta, &e.mint, &thief.pubkey(), 0, 1);
    // the thief signs as "payer" and points the payout at its own account
    let i = ix(refund_metas(&thief.pubkey(), &e.escrow(), &e.vault(), &e.mint, &thief_ta), refund_data());
    assert_code(&e.send(&[i], &[&thief]), E_NOT_PAYER);
    // the payer's key but without its signature
    let mut m = refund_metas(&e.payer.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta);
    m[0].is_signer = false;
    assert_code(&e.send(&[ix(m, refund_data())], &[&thief]), E_MISSING_SIGNER);
    assert_eq!(e.status(), 1);
    assert_eq!(ta_amount(&e.svm, &e.vault()), 500_000);
}

#[test]
fn refund_to_a_token_account_of_someone_else_refused() {
    let mut e = Env::new().locked();
    set_time(&mut e.svm, T0 + 3 * HOUR);
    let theirs = Address::new_unique();
    put_ta(&mut e.svm, &theirs, &e.mint, &Address::new_unique(), 0, 1);
    let p = Keypair::try_from(e.payer.to_bytes().as_slice()).unwrap();
    let i = ix(refund_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &theirs), refund_data());
    assert_code(&e.send(&[i], &[&p]), E_BAD_TOKEN_ACCOUNT);
    // fake vault and malformed data
    let fake_vault = Address::new_unique();
    let (mint, esc) = (e.mint, e.escrow());
    put_ta(&mut e.svm, &fake_vault, &mint, &esc, 500_000, 1);
    let i = ix(refund_metas(&p.pubkey(), &e.escrow(), &fake_vault, &e.mint, &e.payer_ta), refund_data());
    assert_code(&e.send(&[i], &[&p]), E_WRONG_VAULT_ADDRESS);
    let i = ix(refund_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta), vec![2, 0]);
    assert_code(&e.send(&[i], &[&p]), E_INVALID_INSTRUCTION);
    let i = ix(refund_metas(&p.pubkey(), &e.escrow(), &e.vault(), &e.mint, &e.payer_ta), vec![3]);
    assert_code(&e.send(&[i], &[&p]), E_INVALID_INSTRUCTION);
    assert_eq!(e.status(), 1);
}

#[test]
fn refund_after_claim_refused() {
    let mut e = Env::new().locked();
    assert_ok(&e.claim());
    set_time(&mut e.svm, T0 + 3 * HOUR);
    assert_code(&e.refund(), E_NOT_LOCKED);
    assert_eq!(ta_amount(&e.svm, &e.payer_ta), BALANCE - 500_000);
}

#[test]
fn unknown_escrow_is_refused_not_paid() {
    let mut e = Env::new();
    // nothing locked: claim / refund on the derived addresses fail on state, never pay
    let c = Keypair::try_from(e.cranker.to_bytes().as_slice()).unwrap();
    assert_code(&e.send(&[e.claim_ix(&e.preimage.clone())], &[&c]), E_BAD_ESCROW_STATE);
    assert_code(&e.refund(), E_BAD_ESCROW_STATE);
}

#[test]
fn escrow_state_is_terminal_and_kept() {
    let mut e = Env::new().locked();
    assert_ok(&e.claim());
    let after = e.escrow_bytes();
    // a later lock attempt under the same (payer, hash) still refuses: the terminal escrow stays
    assert_code(&e.lock(1), E_ESCROW_EXISTS);
    assert_eq!(e.escrow_bytes(), after);
}
