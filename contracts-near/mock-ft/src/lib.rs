//! Test-only NEP-141 + NEP-145 token standing in for Circle's NEAR USDC, exactly like
//! `MockERC20` on the EVM leg (P5-NEAR-SPEC.md section 3). 6 decimals, symbol `USDC`,
//! owner-minted supply (no cap, testnet-only). Trait implementations are written by hand
//! (the `impl_fungible_token_core!`/`impl_fungible_token_storage!` macros are deprecated
//! in near-contract-standards 5.x — near-sdk-5-facts-2026-09-29.md section 5).

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    events::FtMint, FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

/// Test-token decimals (matches Circle's real USDC on NEAR).
pub const TOKEN_DECIMALS: u8 = 6;
/// Test-token symbol.
pub const TOKEN_SYMBOL: &str = "USDC";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// The only account allowed to call `mint`.
    owner_id: AccountId,
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
}

#[near]
impl Contract {
    /// Initializes the contract with zero supply; `owner_id` is the only account that can
    /// later call `mint`. The owner is pre-registered for storage so it can hold a balance
    /// as soon as it mints to itself.
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USD Coin".to_string(),
            symbol: TOKEN_SYMBOL.to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: TOKEN_DECIMALS,
        };
        metadata.assert_valid();
        let mut this = Self {
            owner_id: owner_id.clone(),
            token: FungibleToken::new(b"a".to_vec()),
            metadata: LazyOption::new(b"m".to_vec(), Some(&metadata)),
        };
        this.token.internal_register_account(&owner_id);
        this
    }

    /// Owner-only mint (test-only convenience mirroring `MockERC20.mint` on the EVM leg).
    /// Registers `account_id` for storage if it isn't already, then credits `amount`.
    /// Panics if called by anyone other than `owner_id` (this is a test double, not a
    /// production-grade access-control pattern).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can mint"
        );
        require!(amount.0 > 0, "Mint amount must be positive");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.into());
        FtMint {
            owner_id: &account_id,
            amount,
            memo: None,
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) = self
            .token
            .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: AccountId, deposit: NearToken) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        // accounts(n) only covers indices 0-5 (near-sdk-5-facts-2026-09-29.md section 6); use
        // index 5 ("fargo") for the contract's own account so it never collides with a party
        // account used in these tests (0-2).
        b.current_account_id(accounts(5))
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .attached_deposit(deposit);
        b
    }

    fn min_storage_balance(contract: &Contract) -> NearToken {
        contract.storage_balance_bounds().min
    }

    fn setup() -> Contract {
        testing_env!(ctx(accounts(0), NearToken::from_yoctonear(0)).build());
        Contract::new(accounts(0))
    }

    #[test]
    fn new_registers_owner_with_zero_balance() {
        let contract = setup();
        assert_eq!(contract.ft_balance_of(accounts(0)), U128(0));
        assert_eq!(contract.ft_total_supply(), U128(0));
    }

    #[test]
    fn metadata_is_usdc_six_decimals() {
        let contract = setup();
        let m = contract.ft_metadata();
        assert_eq!(m.symbol, "USDC");
        assert_eq!(m.decimals, 6);
    }

    #[test]
    fn owner_can_mint_to_registered_or_new_account() {
        let mut contract = setup();
        testing_env!(ctx(accounts(0), NearToken::from_yoctonear(0)).build());
        contract.mint(accounts(1), U128(1_000_000));
        assert_eq!(contract.ft_balance_of(accounts(1)), U128(1_000_000));
        assert_eq!(contract.ft_total_supply(), U128(1_000_000));
    }

    #[test]
    #[should_panic(expected = "Only the owner can mint")]
    fn non_owner_cannot_mint() {
        let mut contract = setup();
        testing_env!(ctx(accounts(1), NearToken::from_yoctonear(0)).build());
        contract.mint(accounts(1), U128(1_000_000));
    }

    #[test]
    #[should_panic(expected = "Mint amount must be positive")]
    fn mint_zero_rejected() {
        let mut contract = setup();
        testing_env!(ctx(accounts(0), NearToken::from_yoctonear(0)).build());
        contract.mint(accounts(1), U128(0));
    }

    #[test]
    fn transfer_between_registered_accounts() {
        let mut contract = setup();
        testing_env!(ctx(accounts(0), NearToken::from_yoctonear(0)).build());
        contract.mint(accounts(0), U128(500));

        // Register accounts(1) for storage before it can receive a transfer.
        let min = min_storage_balance(&contract);
        testing_env!(ctx(accounts(1), min).build());
        contract.storage_deposit(None, None);

        testing_env!(ctx(accounts(0), NearToken::from_yoctonear(1)).build());
        contract.ft_transfer(accounts(1), U128(200), None);

        assert_eq!(contract.ft_balance_of(accounts(0)), U128(300));
        assert_eq!(contract.ft_balance_of(accounts(1)), U128(200));
    }

    #[test]
    #[should_panic(expected = "The account charlie is not registered")]
    fn transfer_to_unregistered_account_panics() {
        // near-sdk's `test_utils::accounts(2)` yields the literal id "charlie" (see
        // near-sdk-5-facts-2026-09-29.md section 6); `internal_deposit`'s exact panic text
        // is `"The account {id} is not registered"` (section 4).
        let mut contract = setup();
        testing_env!(ctx(accounts(0), NearToken::from_yoctonear(0)).build());
        contract.mint(accounts(0), U128(500));
        testing_env!(ctx(accounts(0), NearToken::from_yoctonear(1)).build());
        contract.ft_transfer(accounts(2), U128(200), None);
    }

    #[test]
    fn storage_deposit_registers_new_account() {
        let mut contract = setup();
        let min = min_storage_balance(&contract);
        testing_env!(ctx(accounts(1), min).build());
        let balance = contract.storage_deposit(None, None);
        assert_eq!(balance.total, min);
        assert!(contract.storage_balance_of(accounts(1)).is_some());
    }

    #[test]
    fn storage_balance_of_none_for_unregistered() {
        let contract = setup();
        assert!(contract.storage_balance_of(accounts(1)).is_none());
    }
}
