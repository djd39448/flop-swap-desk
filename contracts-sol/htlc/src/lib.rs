//! First-party, unaudited, testnet-only hashed-timelock escrow for one SPL token (the configured
//! USDC mint) -- the FLOP swap desk's Solana leg (P6-SOL-SPEC.md section 2).
//!
//! Native program (no Anchor), keyless: the program id is `base58(sha256("flop-swap-desk:sol-htlc:v1"))`
//! and is declared below; it is loaded at genesis with `--bpf-program` and has no upgrade authority.
//!
//! Escrow = PDA `[b"htlc", payer, hash_lock]` (keyed by payer: no hash-lock squatting).
//! Vault  = PDA `[b"vault", escrow]`, a token account owned by the escrow PDA.
//!
//! Instructions (first data byte): 0 Lock, 1 Claim, 2 Refund. See README.md for the account lists.

use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

entrypoint!(process_instruction);

/// `base58(sha256("flop-swap-desk:sol-htlc:v1"))` = GedsjashYAxaoETcwBZQR1YgBbuEaK8QiiKu2qi6xe6C.
pub const PROGRAM_ID_BYTES: [u8; 32] = [
    232, 131, 124, 251, 229, 38, 137, 47, 49, 67, 20, 24, 240, 88, 87, 249, 68, 217, 196, 194,
    176, 145, 179, 78, 99, 161, 40, 7, 32, 6, 56, 105,
];
pub const ID: Pubkey = Pubkey::new_from_array(PROGRAM_ID_BYTES);

include!(concat!(env!("OUT_DIR"), "/usdc_mint.rs"));
/// The one mint this build accepts (compile-time, from `FLOP_SOL_USDC_MINT`; see build.rs).
pub const USDC_MINT: Pubkey = Pubkey::new_from_array(USDC_MINT_BYTES);

/// The classic SPL Token program (Token-2022 is refused on purpose: extensions such as transfer
/// hooks, fees and freeze authorities change the transfer semantics this escrow relies on).
pub const TOKEN_PROGRAM: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
pub const SYSTEM_PROGRAM: Pubkey = Pubkey::new_from_array([0u8; 32]);

pub const ESCROW_SEED: &[u8] = b"htlc";
pub const VAULT_SEED: &[u8] = b"vault";

pub const TAG_LOCK: u8 = 0;
pub const TAG_CLAIM: u8 = 1;
pub const TAG_REFUND: u8 = 2;

pub const LOCK_DATA_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8;
pub const CLAIM_DATA_LEN: usize = 1 + 32;
pub const REFUND_DATA_LEN: usize = 1;

// ---- escrow account layout (versioned; byte 0 is the version) ------------------------------------
pub const STATE_VERSION: u8 = 1;
pub const STATUS_LOCKED: u8 = 1;
pub const STATUS_CLAIMED: u8 = 2;
pub const STATUS_REFUNDED: u8 = 3;
pub const OFF_VERSION: usize = 0;
pub const OFF_STATUS: usize = 1;
pub const OFF_REVEALED: usize = 2;
pub const OFF_BUMP: usize = 3;
pub const OFF_PAYER: usize = 4;
pub const OFF_PAYEE: usize = 36;
pub const OFF_MINT: usize = 68;
pub const OFF_HASH_LOCK: usize = 100;
pub const OFF_AMOUNT: usize = 132;
pub const OFF_CLAIM_BY_MS: usize = 140;
pub const OFF_REFUND_AFTER_MS: usize = 148;
pub const OFF_PREIMAGE: usize = 156;
pub const ESCROW_LEN: usize = 188;

// ---- SPL token account / mint layout (classic Token program) --------------------------------------
const TA_LEN: usize = 165;
const TA_MINT: usize = 0;
const TA_OWNER: usize = 32;
const TA_AMOUNT: usize = 64;
const TA_STATE: usize = 108;
const MINT_LEN: usize = 82;
const MINT_DECIMALS: usize = 44;
const MINT_INIT: usize = 45;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HtlcError {
    InvalidInstruction = 1,
    WrongProgramId = 2,
    ZeroAmount = 3,
    BadWindow = 4,
    WindowClosed = 5,
    PayeeIsProgramAccount = 6,
    WrongMint = 7,
    DuplicateAccount = 8,
    MissingSigner = 9,
    NotWritable = 10,
    WrongTokenProgram = 11,
    WrongSystemProgram = 12,
    WrongEscrowAddress = 13,
    WrongVaultAddress = 14,
    EscrowExists = 15,
    BadEscrowState = 16,
    BadTokenAccount = 17,
    NotLocked = 18,
    ClaimWindowClosed = 19,
    WrongPreimage = 20,
    NotPayer = 21,
    RefundTooEarly = 22,
    Overflow = 23,
    BadMint = 24,
}

impl From<HtlcError> for ProgramError {
    fn from(e: HtlcError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

type Res<T = ()> = Result<T, ProgramError>;

pub fn find_escrow(payer: &Pubkey, hash_lock: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ESCROW_SEED, payer.as_ref(), hash_lock], &ID)
}

pub fn find_vault(escrow: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, escrow.as_ref()], &ID)
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // The PDA derivations use the declared id; refuse to run under any other id.
    if *program_id != ID {
        return Err(HtlcError::WrongProgramId.into());
    }
    let (tag, rest) = data.split_first().ok_or(HtlcError::InvalidInstruction)?;
    match *tag {
        TAG_LOCK => {
            if data.len() != LOCK_DATA_LEN {
                return Err(HtlcError::InvalidInstruction.into());
            }
            let mut hash_lock = [0u8; 32];
            hash_lock.copy_from_slice(&rest[0..32]);
            let payee = Pubkey::new_from_array(rest[32..64].try_into().unwrap());
            let claim_by_ms = i64::from_le_bytes(rest[64..72].try_into().unwrap());
            let refund_after_ms = i64::from_le_bytes(rest[72..80].try_into().unwrap());
            let amount = u64::from_le_bytes(rest[80..88].try_into().unwrap());
            lock(accounts, hash_lock, payee, claim_by_ms, refund_after_ms, amount)
        }
        TAG_CLAIM => {
            if data.len() != CLAIM_DATA_LEN {
                return Err(HtlcError::InvalidInstruction.into());
            }
            let mut preimage = [0u8; 32];
            preimage.copy_from_slice(rest);
            claim(accounts, preimage)
        }
        TAG_REFUND => {
            if data.len() != REFUND_DATA_LEN {
                return Err(HtlcError::InvalidInstruction.into());
            }
            refund(accounts)
        }
        _ => Err(HtlcError::InvalidInstruction.into()),
    }
}


/// System program instructions, hand-encoded (bincode: u32 LE tag, then fields) so no extra crate
/// is needed. create_account = 0, assign = 1, transfer = 2, allocate = 8.
mod sys {
    use super::{AccountMeta, Instruction, Pubkey, SYSTEM_PROGRAM};

    fn ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
        Instruction { program_id: SYSTEM_PROGRAM, accounts, data }
    }
    pub fn create_account(from: &Pubkey, to: &Pubkey, lamports: u64, space: u64, owner: &Pubkey) -> Instruction {
        let mut d = 0u32.to_le_bytes().to_vec();
        d.extend_from_slice(&lamports.to_le_bytes());
        d.extend_from_slice(&space.to_le_bytes());
        d.extend_from_slice(owner.as_ref());
        ix(vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)], d)
    }
    pub fn transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
        let mut d = 2u32.to_le_bytes().to_vec();
        d.extend_from_slice(&lamports.to_le_bytes());
        ix(vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)], d)
    }
    pub fn allocate(account: &Pubkey, space: u64) -> Instruction {
        let mut d = 8u32.to_le_bytes().to_vec();
        d.extend_from_slice(&space.to_le_bytes());
        ix(vec![AccountMeta::new(*account, true)], d)
    }
    pub fn assign(account: &Pubkey, owner: &Pubkey) -> Instruction {
        let mut d = 1u32.to_le_bytes().to_vec();
        d.extend_from_slice(owner.as_ref());
        ix(vec![AccountMeta::new(*account, true)], d)
    }
}

// ---- helpers --------------------------------------------------------------------------------------

fn now_ms() -> Res<i64> {
    let clock = Clock::get()?;
    clock
        .unix_timestamp
        .checked_mul(1000)
        .ok_or_else(|| HtlcError::Overflow.into())
}

fn require_distinct(accounts: &[AccountInfo]) -> Res {
    for i in 0..accounts.len() {
        for j in (i + 1)..accounts.len() {
            if accounts[i].key == accounts[j].key {
                return Err(HtlcError::DuplicateAccount.into());
            }
        }
    }
    Ok(())
}

fn require_signer(a: &AccountInfo) -> Res {
    if a.is_signer {
        Ok(())
    } else {
        Err(HtlcError::MissingSigner.into())
    }
}

fn require_writable(a: &AccountInfo) -> Res {
    if a.is_writable {
        Ok(())
    } else {
        Err(HtlcError::NotWritable.into())
    }
}

fn require_token_program(a: &AccountInfo) -> Res {
    if *a.key == TOKEN_PROGRAM && a.executable {
        Ok(())
    } else {
        Err(HtlcError::WrongTokenProgram.into())
    }
}

fn require_system_program(a: &AccountInfo) -> Res {
    if *a.key == SYSTEM_PROGRAM && a.executable {
        Ok(())
    } else {
        Err(HtlcError::WrongSystemProgram.into())
    }
}

/// Returns the mint's decimals. Requires `key == expected`, token-program ownership, an initialised
/// classic mint of exactly 82 bytes.
fn read_mint(a: &AccountInfo, expected: &Pubkey) -> Res<u8> {
    if a.key != expected {
        return Err(HtlcError::WrongMint.into());
    }
    if *a.owner != TOKEN_PROGRAM {
        return Err(HtlcError::BadMint.into());
    }
    let d = a.try_borrow_data()?;
    if d.len() != MINT_LEN || d[MINT_INIT] != 1 {
        return Err(HtlcError::BadMint.into());
    }
    Ok(d[MINT_DECIMALS])
}

struct TokenAcct {
    amount: u64,
}

/// Validates a classic SPL token account (token-program owned, 165 bytes, initialised and NOT
/// frozen) for `mint` with token-owner `owner`, and returns its balance.
fn read_token_account(a: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> Res<TokenAcct> {
    if *a.owner != TOKEN_PROGRAM {
        return Err(HtlcError::BadTokenAccount.into());
    }
    let d = a.try_borrow_data()?;
    if d.len() != TA_LEN || d[TA_STATE] != 1 {
        return Err(HtlcError::BadTokenAccount.into());
    }
    if d[TA_MINT..TA_MINT + 32] != mint.as_ref()[..] || d[TA_OWNER..TA_OWNER + 32] != owner.as_ref()[..] {
        return Err(HtlcError::BadTokenAccount.into());
    }
    Ok(TokenAcct {
        amount: u64::from_le_bytes(d[TA_AMOUNT..TA_AMOUNT + 8].try_into().unwrap()),
    })
}

fn pk(d: &[u8], off: usize) -> Pubkey {
    Pubkey::new_from_array(d[off..off + 32].try_into().unwrap())
}

/// Creates (or adopts a pre-funded, still system-owned, empty) PDA account: rent is paid by
/// `payer`. Pre-funding a PDA with lamports cannot block creation.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> Res {
    if *target.owner != SYSTEM_PROGRAM || !target.data_is_empty() {
        return Err(HtlcError::EscrowExists.into());
    }
    let need = Rent::get()?.minimum_balance(space);
    if target.lamports() == 0 {
        invoke_signed(
            &sys::create_account(payer.key, target.key, need, space as u64, owner),
            &[payer.clone(), target.clone(), system.clone()],
            &[seeds],
        )?;
    } else {
        let short = need.saturating_sub(target.lamports());
        if short > 0 {
            invoke(
                &sys::transfer(payer.key, target.key, short),
                &[payer.clone(), target.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &sys::allocate(target.key, space as u64),
            &[target.clone(), system.clone()],
            &[seeds],
        )?;
        invoke_signed(
            &sys::assign(target.key, owner),
            &[target.clone(), system.clone()],
            &[seeds],
        )?;
    }
    Ok(())
}

/// SPL Token `TransferChecked` (tag 12): amount u64 LE, decimals u8. Accounts: source (w), mint,
/// destination (w), authority (signer).
fn transfer_checked_ix(
    source: &Pubkey,
    mint: &Pubkey,
    dest: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(*source, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*dest, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data: token_data_transfer_checked(amount, decimals),
    }
}

pub fn token_data_transfer_checked(amount: u64, decimals: u8) -> Vec<u8> {
    let mut v = Vec::with_capacity(10);
    v.push(12);
    v.extend_from_slice(&amount.to_le_bytes());
    v.push(decimals);
    v
}

/// SPL Token `InitializeAccount3` (tag 18): owner pubkey. Accounts: account (w), mint.
fn initialize_account3_ix(account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(18);
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(*mint, false)],
        data,
    }
}

struct Escrow {
    bump: u8,
    status: u8,
    payer: Pubkey,
    payee: Pubkey,
    mint: Pubkey,
    hash_lock: [u8; 32],
    amount: u64,
    refund_after_ms: i64,
}

/// Loads and fully validates the escrow account: program-owned, exact length, known version,
/// address re-derived from its own stored (payer, hash_lock, bump).
fn load_escrow(a: &AccountInfo) -> Res<Escrow> {
    if *a.owner != ID {
        return Err(HtlcError::BadEscrowState.into());
    }
    let d = a.try_borrow_data()?;
    if d.len() != ESCROW_LEN || d[OFF_VERSION] != STATE_VERSION {
        return Err(HtlcError::BadEscrowState.into());
    }
    let e = Escrow {
        bump: d[OFF_BUMP],
        status: d[OFF_STATUS],
        payer: pk(&d, OFF_PAYER),
        payee: pk(&d, OFF_PAYEE),
        mint: pk(&d, OFF_MINT),
        hash_lock: d[OFF_HASH_LOCK..OFF_HASH_LOCK + 32].try_into().unwrap(),
        amount: u64::from_le_bytes(d[OFF_AMOUNT..OFF_AMOUNT + 8].try_into().unwrap()),
        refund_after_ms: i64::from_le_bytes(
            d[OFF_REFUND_AFTER_MS..OFF_REFUND_AFTER_MS + 8].try_into().unwrap(),
        ),
    };
    let derived = Pubkey::create_program_address(
        &[ESCROW_SEED, e.payer.as_ref(), &e.hash_lock, &[e.bump]],
        &ID,
    )
    .map_err(|_| HtlcError::WrongEscrowAddress)?;
    if derived != *a.key {
        return Err(HtlcError::WrongEscrowAddress.into());
    }
    Ok(e)
}

fn check_vault_key(vault: &AccountInfo, escrow: &Pubkey) -> Res {
    if find_vault(escrow).0 != *vault.key {
        return Err(HtlcError::WrongVaultAddress.into());
    }
    Ok(())
}

// ---- Lock -----------------------------------------------------------------------------------------
// Accounts: 0 payer (s,w) | 1 escrow PDA (w) | 2 vault PDA (w) | 3 mint | 4 payer token account (w)
//           | 5 token program | 6 system program

fn lock<'a>(
    accounts: &[AccountInfo<'a>],
    hash_lock: [u8; 32],
    payee: Pubkey,
    claim_by_ms: i64,
    refund_after_ms: i64,
    amount: u64,
) -> ProgramResult {
    if accounts.len() != 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (payer, escrow, vault, mint, payer_ta, token_prog, system) = (
        &accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4], &accounts[5], &accounts[6],
    );
    require_distinct(accounts)?;
    require_signer(payer)?;
    for a in [payer, escrow, vault, payer_ta] {
        require_writable(a)?;
    }
    require_token_program(token_prog)?;
    require_system_program(system)?;

    if amount == 0 {
        return Err(HtlcError::ZeroAmount.into());
    }
    if claim_by_ms >= refund_after_ms {
        return Err(HtlcError::BadWindow.into());
    }
    if now_ms()? >= refund_after_ms {
        return Err(HtlcError::WindowClosed.into());
    }

    let (escrow_key, bump) = find_escrow(payer.key, &hash_lock);
    if escrow_key != *escrow.key {
        return Err(HtlcError::WrongEscrowAddress.into());
    }
    let (vault_key, vault_bump) = find_vault(escrow.key);
    if vault_key != *vault.key {
        return Err(HtlcError::WrongVaultAddress.into());
    }
    // A payee nobody can sign for would strand a claim's payout (NEAR H5 twin): the all-zero address,
    // this program, the token program and the mint are refused, as are this lock's own accounts.
    if payee == *escrow.key
        || payee == *vault.key
        || payee == SYSTEM_PROGRAM
        || payee == ID
        || payee == TOKEN_PROGRAM
        || payee == USDC_MINT
    {
        return Err(HtlcError::PayeeIsProgramAccount.into());
    }

    let decimals = read_mint(mint, &USDC_MINT)?;
    let src = read_token_account(payer_ta, mint.key, payer.key)?;
    if src.amount < amount {
        // The token program would refuse too; fail early with a clear error.
        return Err(HtlcError::BadTokenAccount.into());
    }

    // Escrow account: rent paid by the payer; fails if it already exists (only for this payer).
    create_pda(
        payer,
        escrow,
        system,
        ESCROW_LEN,
        &ID,
        &[ESCROW_SEED, payer.key.as_ref(), &hash_lock, &[bump]],
    )?;
    {
        let mut d = escrow.try_borrow_mut_data()?;
        d.fill(0);
        d[OFF_VERSION] = STATE_VERSION;
        d[OFF_STATUS] = STATUS_LOCKED;
        d[OFF_REVEALED] = 0;
        d[OFF_BUMP] = bump;
        d[OFF_PAYER..OFF_PAYER + 32].copy_from_slice(payer.key.as_ref());
        d[OFF_PAYEE..OFF_PAYEE + 32].copy_from_slice(payee.as_ref());
        d[OFF_MINT..OFF_MINT + 32].copy_from_slice(mint.key.as_ref());
        d[OFF_HASH_LOCK..OFF_HASH_LOCK + 32].copy_from_slice(&hash_lock);
        d[OFF_AMOUNT..OFF_AMOUNT + 8].copy_from_slice(&amount.to_le_bytes());
        d[OFF_CLAIM_BY_MS..OFF_CLAIM_BY_MS + 8].copy_from_slice(&claim_by_ms.to_le_bytes());
        d[OFF_REFUND_AFTER_MS..OFF_REFUND_AFTER_MS + 8].copy_from_slice(&refund_after_ms.to_le_bytes());
    }

    // Vault: a token account at a PDA, owned by the escrow PDA.
    create_pda(
        payer,
        vault,
        system,
        TA_LEN,
        &TOKEN_PROGRAM,
        &[VAULT_SEED, escrow.key.as_ref(), &[vault_bump]],
    )
    .map_err(|e| if e == ProgramError::from(HtlcError::EscrowExists) { HtlcError::WrongVaultAddress.into() } else { e })?;
    invoke(
        &initialize_account3_ix(vault.key, mint.key, escrow.key),
        &[vault.clone(), mint.clone()],
    )?;

    invoke(
        &transfer_checked_ix(payer_ta.key, mint.key, vault.key, payer.key, amount, decimals),
        &[payer_ta.clone(), mint.clone(), vault.clone(), payer.clone()],
    )?;
    let got = read_token_account(vault, mint.key, escrow.key)?;
    if got.amount != amount {
        return Err(HtlcError::BadTokenAccount.into());
    }
    Ok(())
}

// ---- shared payout --------------------------------------------------------------------------------

fn pay_out<'a>(
    e: &Escrow,
    escrow: &AccountInfo<'a>,
    vault: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    token_prog: &AccountInfo<'a>,
) -> ProgramResult {
    let decimals = read_mint(mint, &e.mint)?;
    let v = read_token_account(vault, &e.mint, escrow.key)?;
    if v.amount < e.amount {
        return Err(HtlcError::BadTokenAccount.into());
    }
    // The whole vault balance moves (a stray donation to the vault is not stranded).
    invoke_signed(
        &transfer_checked_ix(vault.key, mint.key, dest.key, escrow.key, v.amount, decimals),
        &[vault.clone(), mint.clone(), dest.clone(), escrow.clone(), token_prog.clone()],
        &[&[ESCROW_SEED, e.payer.as_ref(), &e.hash_lock, &[e.bump]]],
    )
}

// ---- Claim ----------------------------------------------------------------------------------------
// Accounts: 0 escrow (w) | 1 vault (w) | 2 mint | 3 payee token account (w) | 4 token program
// Permissionless: no signer other than the transaction fee payer is needed.

fn claim<'a>(accounts: &[AccountInfo<'a>], preimage: [u8; 32]) -> ProgramResult {
    if accounts.len() != 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (escrow, vault, mint, payee_ta, token_prog) =
        (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4]);
    require_distinct(accounts)?;
    for a in [escrow, vault, payee_ta] {
        require_writable(a)?;
    }
    require_token_program(token_prog)?;

    let e = load_escrow(escrow)?;
    check_vault_key(vault, escrow.key)?;
    if e.status != STATUS_LOCKED {
        return Err(HtlcError::NotLocked.into());
    }
    if now_ms()? >= e.refund_after_ms {
        return Err(HtlcError::ClaimWindowClosed.into());
    }
    if hash(&preimage).to_bytes() != e.hash_lock {
        return Err(HtlcError::WrongPreimage.into());
    }
    read_token_account(payee_ta, &e.mint, &e.payee)?;

    {
        let mut d = escrow.try_borrow_mut_data()?;
        d[OFF_STATUS] = STATUS_CLAIMED;
        d[OFF_REVEALED] = 1;
        d[OFF_PREIMAGE..OFF_PREIMAGE + 32].copy_from_slice(&preimage);
    }
    pay_out(&e, escrow, vault, mint, payee_ta, token_prog)
}

// ---- Refund ---------------------------------------------------------------------------------------
// Accounts: 0 payer (s) | 1 escrow (w) | 2 vault (w) | 3 mint | 4 payer token account (w) | 5 token program

fn refund<'a>(accounts: &[AccountInfo<'a>]) -> ProgramResult {
    if accounts.len() != 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (payer, escrow, vault, mint, payer_ta, token_prog) = (
        &accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4], &accounts[5],
    );
    require_distinct(accounts)?;
    require_signer(payer)?;
    for a in [escrow, vault, payer_ta] {
        require_writable(a)?;
    }
    require_token_program(token_prog)?;

    let e = load_escrow(escrow)?;
    check_vault_key(vault, escrow.key)?;
    if e.payer != *payer.key {
        return Err(HtlcError::NotPayer.into());
    }
    if e.status != STATUS_LOCKED {
        return Err(HtlcError::NotLocked.into());
    }
    if now_ms()? < e.refund_after_ms {
        return Err(HtlcError::RefundTooEarly.into());
    }
    read_token_account(payer_ta, &e.mint, &e.payer)?;

    {
        let mut d = escrow.try_borrow_mut_data()?;
        d[OFF_STATUS] = STATUS_REFUNDED;
    }
    pay_out(&e, escrow, vault, mint, payer_ta, token_prog)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_id_is_sha256_of_the_label() {
        let h = hash(b"flop-swap-desk:sol-htlc:v1");
        assert_eq!(h.to_bytes(), PROGRAM_ID_BYTES);
    }

    #[test]
    fn default_mint_is_the_sha256_derived_mock() {
        // Only meaningful for a default build (no FLOP_SOL_USDC_MINT override).
        if option_env!("FLOP_SOL_USDC_MINT").is_none() {
            let h = hash(b"flop-swap-desk:sol-mock-usdc:v1");
            assert_eq!(h.to_bytes(), USDC_MINT_BYTES);
        }
    }

    #[test]
    fn token_program_constant_is_tokenkeg() {
        assert_eq!(TOKEN_PROGRAM.to_bytes(), spl_token_interface::ID.to_bytes());
    }

    #[test]
    fn token_instruction_data_matches_the_interface_crate() {
        use spl_token_interface::instruction::TokenInstruction;
        assert_eq!(
            token_data_transfer_checked(1234, 6),
            TokenInstruction::TransferChecked { amount: 1234, decimals: 6 }.pack()
        );
        let owner = spl_token_interface::ID;
        let ours = initialize_account3_ix(&Pubkey::new_unique(), &Pubkey::new_unique(), &Pubkey::new_from_array(owner.to_bytes()));
        assert_eq!(ours.data, TokenInstruction::InitializeAccount3 { owner }.pack());
    }

    #[test]
    fn token_account_layout_matches_the_interface_crate() {
        use solana_program_pack::Pack;
        use spl_token_interface::state::{Account, AccountState, Mint};
        let mut buf = [0u8; TA_LEN];
        let a = Account {
            mint: spl_token_interface::ID,
            owner: spl_token_interface::ID,
            amount: 777,
            state: AccountState::Initialized,
            ..Account::default()
        };
        Account::pack(a, &mut buf).unwrap();
        assert_eq!(&buf[TA_MINT..TA_MINT + 32], spl_token_interface::ID.as_ref());
        assert_eq!(u64::from_le_bytes(buf[TA_AMOUNT..TA_AMOUNT + 8].try_into().unwrap()), 777);
        assert_eq!(buf[TA_STATE], 1);
        assert_eq!(Account::LEN, TA_LEN);
        let mut m = [0u8; MINT_LEN];
        Mint::pack(Mint { decimals: 6, is_initialized: true, ..Mint::default() }, &mut m).unwrap();
        assert_eq!(m[MINT_DECIMALS], 6);
        assert_eq!(m[MINT_INIT], 1);
        assert_eq!(Mint::LEN, MINT_LEN);
    }
}
