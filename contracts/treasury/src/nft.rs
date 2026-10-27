use crate::{Contract, ContractExt};
use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};
use std::collections::HashMap;

#[near]
impl Contract {
    /// A receipt records an accountant's reconciliation. It does not independently prove market profitability.
    /// Optional share rights are fixed basis points of future explicitly deposited NEAR distributions.
    /// New minting cannot dilute existing rights: the total can never exceed 10,000 bps.
    pub fn mint_proof_nft(
        &mut self,
        cycle_id: String,
        receiver_id: AccountId,
        share_bps: u16,
    ) -> Token {
        self.role(&self.accountant);
        let cycle = self.cycles.get(&cycle_id).expect("Unknown cycle");
        require!(cycle.status == "CLOSED", "Reconciled cycle required");
        require!(
            cycle
                .realized_pnl_atoms
                .as_ref()
                .and_then(|v| v.parse::<i128>().ok())
                .unwrap_or(0)
                > 0,
            "Positive reconciled PnL required"
        );
        let token_id = format!("cycle:{}", cycle_id);
        if let Some(token) = self.tokens.nft_token(token_id.clone()) {
            require!(
                self.receipt_shares.get(&token_id).unwrap_or(0) == share_bps,
                "Receipt share conflict"
            );
            return token;
        }
        require!(
            share_bps == 0 || self.receipt_shares.len() < 128,
            "Revenue-rights receipt capacity reached"
        );
        let total = self
            .total_shares_bps
            .checked_add(share_bps)
            .expect("Share overflow");
        require!(total <= 10_000, "Revenue rights exhausted");
        let metadata=TokenMetadata {title:Some(format!("SymbioChain cycle {}",cycle_id)),description:Some("Accountant-reconciled execution receipt; revenue rights apply only to future explicit distributions, with no guaranteed yield.".into()),extra:Some(near_sdk::serde_json::json!({"cycle_id":cycle_id,"reconciliation_hash":cycle.reconciliation_hash,"reported_pnl_atoms":cycle.realized_pnl_atoms,"share_bps":share_bps}).to_string()),..TokenMetadata::default()};
        let token = self.tokens.internal_mint_with_refund(
            token_id.clone(),
            receiver_id,
            Some(metadata),
            None,
        );
        near_contract_standards::non_fungible_token::events::NftMint {
            owner_id: &token.owner_id,
            token_ids: &[&token_id],
            memo: Some("Accountant-reconciled SymbioChain cycle"),
        }
        .emit();
        if share_bps > 0 {
            self.receipt_shares.insert(&token_id, &share_bps);
        }
        self.dividends.insert(&token_id, &0);
        self.total_shares_bps = total;
        require!(
            self.available_native() >= self.policy.min_reserve_yocto.0,
            "Insufficient storage and operational reserve"
        );
        self.log(
            "receipt_minted",
            near_sdk::serde_json::json!({"token_id":token_id,"share_bps":share_bps}),
        );
        token
    }

    #[payable]
    pub fn distribute_revenue(&mut self, distribution_reference: String) {
        self.role(&self.accountant);
        require!(
            !distribution_reference.is_empty() && distribution_reference.len() <= 100,
            "Invalid reference"
        );
        let amount = env::attached_deposit().as_yoctonear();
        require!(
            self.distributions.get(&distribution_reference).is_none(),
            "Distribution reference already used"
        );
        require!(
            self.distributions.len() < 10_000,
            "Distribution capacity reached"
        );
        require!(
            amount > 0 && amount <= 10u128.pow(30),
            "Invalid distribution amount"
        );
        // Explicit deposits are not themselves proof of external revenue. Indexers must classify their source.
        let mut allocated = 0u128;
        for (id, bps) in self.receipt_shares.iter() {
            let entitlement = amount
                .checked_mul(bps as u128)
                .expect("Distribution overflow")
                / 10_000;
            if entitlement > 0 {
                self.dividends.insert(
                    &id,
                    &self
                        .dividends
                        .get(&id)
                        .unwrap_or(0)
                        .checked_add(entitlement)
                        .expect("Dividend overflow"),
                );
                allocated = allocated
                    .checked_add(entitlement)
                    .expect("Distribution overflow");
            }
        }
        self.dividend_liability_yocto = self
            .dividend_liability_yocto
            .checked_add(allocated)
            .expect("Liability overflow");
        self.distributions.insert(&distribution_reference, &amount);
        self.log("revenue_distributed",near_sdk::serde_json::json!({"reference":distribution_reference,"deposited":amount.to_string(),"allocated":allocated.to_string(),"unallocated":(amount-allocated).to_string()}));
    }

    pub fn dividend_balance(&self, token_id: TokenId) -> U128 {
        U128(self.dividends.get(&token_id).unwrap_or(0))
    }
    pub fn claim_credit(&self, account: AccountId) -> U128 {
        U128(self.claim_credits.get(&account).unwrap_or(0))
    }
    pub fn claim_dividends(&mut self, token_id: TokenId) -> Promise {
        let claimant = env::predecessor_account_id();
        let token = self
            .tokens
            .nft_token(token_id.clone())
            .expect("Unknown token");
        require!(token.owner_id == claimant, "Token owner only");
        let amount = self.dividends.get(&token_id).unwrap_or(0);
        require!(amount > 0, "No dividends");
        self.dividends.insert(&token_id, &0);
        self.payout(claimant, amount, "dividend")
    }
    pub fn withdraw_claim_credit(&mut self) -> Promise {
        let claimant = env::predecessor_account_id();
        let amount = self.claim_credits.get(&claimant).unwrap_or(0);
        require!(amount > 0, "No credit");
        self.claim_credits.insert(&claimant, &0);
        self.payout(claimant, amount, "dividend")
    }
    pub fn withdraw_service_balance(&mut self, amount: U128) -> Promise {
        let claimant = env::predecessor_account_id();
        let balance = self.service_balances.get(&claimant).unwrap_or(0);
        require!(amount.0 > 0 && balance >= amount.0, "Insufficient balance");
        self.service_balances
            .insert(&claimant, &(balance - amount.0));
        self.payout(claimant, amount.0, "service")
    }
    #[private]
    pub fn on_payout(&mut self, claimant: AccountId, amount: U128, kind: String) -> bool {
        let success = env::promise_result_checked(0, 0).is_ok();
        if kind == "service" {
            if success {
                self.service_liability_yocto = self
                    .service_liability_yocto
                    .checked_sub(amount.0)
                    .expect("Liability mismatch");
            } else {
                self.service_balances.insert(
                    &claimant,
                    &self
                        .service_balances
                        .get(&claimant)
                        .unwrap_or(0)
                        .checked_add(amount.0)
                        .expect("Overflow"),
                );
            }
        } else {
            require!(kind == "dividend", "Invalid payout type");
            if success {
                self.dividend_liability_yocto = self
                    .dividend_liability_yocto
                    .checked_sub(amount.0)
                    .expect("Liability mismatch");
            } else {
                self.claim_credits.insert(
                    &claimant,
                    &self
                        .claim_credits
                        .get(&claimant)
                        .unwrap_or(0)
                        .checked_add(amount.0)
                        .expect("Overflow"),
                );
            }
        }
        success
    }
}
impl Contract {
    fn payout(&self, claimant: AccountId, amount: u128, kind: &str) -> Promise {
        Promise::new(claimant.clone()).transfer(NearToken::from_yoctonear(amount)).then(Promise::new(env::current_account_id()).function_call("on_payout",near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"claimant":claimant,"amount":amount.to_string(),"kind":kind})).unwrap(),NearToken::from_yoctonear(0),Gas::from_tgas(20)))
    }
}
#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.tokens
            .nft_transfer(receiver_id, token_id, approval_id, memo);
    }
    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.tokens
            .nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }
    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}
#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
    }
}
#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens
            .nft_tokens(from_index, Some(limit.unwrap_or(50).min(100)))
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, Some(limit.unwrap_or(50).min(100)))
    }
}
#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.into(),
            name: "SymbioChain Execution Receipts".into(),
            symbol: "SYMBIO".into(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}
