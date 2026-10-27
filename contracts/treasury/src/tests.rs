use super::*;
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_sdk::{test_utils::VMContextBuilder, testing_env};
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn context(who: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("treasury.test.near"))
        .predecessor_account_id(id(who))
        .signer_account_id(id(who))
        .account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(1_000_000);
    testing_env!(b.build());
}
fn contract() -> Contract {
    context("owner.near");
    Contract::new(
        id("owner.near"),
        id("brain.near"),
        id("hand.near"),
        id("books.near"),
        id("mpc.near"),
        "symbio-v1".into(),
        Policy {
            max_trade_atoms: U128(10_000_000),
            max_daily_atoms: U128(50_000_000),
            min_reserve_yocto: U128(10u128.pow(24)),
            max_signing_cost_yocto: U128(1),
            max_slippage_bps: 50,
            allowed_chain_ids: vec![8453, 0],
            allowed_token_contracts: vec![format!("0x{}", "11".repeat(20)), "sol:native".into()],
            token_max_trade_atoms: vec![U128(10_000_000), U128(1_000_000_000)],
            token_max_daily_atoms: vec![U128(50_000_000), U128(5_000_000_000)],
        },
    )
}
fn auth() -> Authorization {
    Authorization {
        cycle_id: "cycle-1".into(),
        proposal_hash: "aa".repeat(32),
        route_hash: "bb".repeat(32),
        evidence_hash: "cc".repeat(32),
        amount_atoms: U128(5_000_000),
        budget_atoms: U128(5_000_000),
        expires_at_ns: U64(1_000_000_000_000),
        chain_id: 8453,
        token_contract: format!("0x{}", "11".repeat(20)),
        deposit_address: format!("0x{}", "22".repeat(20)),
        max_fee_per_gas: U128(1_000_000_000),
        gas_limit: U128(100000),
        slippage_bps: 50,
    }
}
#[test]
fn authorization_is_idempotent() {
    let mut c = contract();
    context("brain.near");
    let a = auth();
    c.authorize_cycle(a.clone());
    c.authorize_cycle(a);
    assert_eq!(c.daily_reserved_atoms, 5_000_000);
}
#[test]
#[should_panic(expected = "Unauthorized")]
fn hand_cannot_authorize() {
    let mut c = contract();
    context("hand.near");
    c.authorize_cycle(auth());
}
#[test]
#[should_panic(expected = "Signing already requested")]
fn signing_cannot_repeat() {
    let mut c = contract();
    context("brain.near");
    c.authorize_cycle(auth());
    context("hand.near");
    let t = || EvmTransfer {
        nonce: U64(0),
        max_priority_fee_per_gas: U128(0),
        max_fee_per_gas: U128(1),
        gas_limit: U128(60000),
    };
    let _ = c.request_evm_signature("cycle-1".into(), t());
    let _ = c.request_evm_signature("cycle-1".into(), t());
}
#[test]
#[should_panic(expected = "Trade limit")]
fn cap_uses_base_budget() {
    let mut c = contract();
    context("brain.near");
    let mut a = auth();
    a.budget_atoms = U128(10_000_001);
    c.authorize_cycle(a);
}
#[test]
fn service_payments_conserve_liability() {
    let mut c = contract();
    context("hand.near");
    c.service_balances.insert(&id("hand.near"), &100);
    c.service_liability_yocto = 100;
    c.settle_service("p1".into(), id("brain.near"), U128(30), "ff".repeat(32));
    c.settle_service("p1".into(), id("brain.near"), U128(30), "ff".repeat(32));
    assert_eq!(c.service_balance(id("hand.near")).0, 70);
    assert_eq!(c.service_balance(id("brain.near")).0, 30);
    assert_eq!(c.service_liability_yocto, 100);
}
#[test]
fn receipt_rights_follow_transfer() {
    let mut c = contract();
    context("brain.near");
    c.authorize_cycle(auth());
    let mut r = c.cycles.get(&"cycle-1".into()).unwrap();
    r.status = "CLOSED".into();
    r.realized_pnl_atoms = Some("10".into());
    r.reconciliation_hash = Some("dd".repeat(32));
    c.cycles.insert(&"cycle-1".into(), &r);
    context("books.near");
    let token = c.mint_proof_nft("cycle-1".into(), id("holder.near"), 100);
    assert_eq!(token.owner_id, id("holder.near"));
    assert_eq!(c.total_shares_bps, 100);
    c.mint_proof_nft("cycle-1".into(), id("holder.near"), 100);
    assert_eq!(c.total_shares_bps, 100);
    assert!(c.nft_token("cycle:cycle-1".into()).is_some());
}
#[test]
fn solana_message_has_no_arbitrary_program() {
    let m = crate::solana::transfer_message(&[1; 32], &[2; 32], &[3; 32], 42);
    assert_eq!(m.len(), 150);
    assert_eq!(&m[..4], &[1, 0, 1, 3]);
    assert_eq!(&m[138..142], &2u32.to_le_bytes());
    assert_eq!(&m[142..], &42u64.to_le_bytes());
}

#[test]
#[should_panic(expected = "Token trade limit")]
fn base_budget_cannot_bypass_token_cap() {
    let mut c = contract();
    context("brain.near");
    let mut a = auth();
    a.budget_atoms = U128(1);
    a.amount_atoms = U128(10_000_001);
    c.authorize_cycle(a);
}
#[test]
#[should_panic(expected = "Unauthorized or revoked worker")]
fn owner_can_revoke_worker() {
    let mut c = contract();
    c.set_worker_enabled(id("brain.near"), false);
    context("brain.near");
    c.authorize_cycle(auth());
}
#[test]
#[should_panic(expected = "Paused")]
fn paused_contract_cannot_authorize() {
    let mut c = contract();
    c.set_paused(true);
    context("brain.near");
    c.authorize_cycle(auth());
}
#[test]
#[should_panic(expected = "Token daily limit")]
fn token_daily_cap_is_independent_of_claimed_base_budget() {
    let mut c = contract();
    context("brain.near");
    for i in 0..6 {
        let mut a = auth();
        a.cycle_id = format!("cycle-{i}");
        a.budget_atoms = U128(1);
        a.amount_atoms = U128(10_000_000);
        c.authorize_cycle(a);
    }
}
#[test]
fn failed_dividend_payout_restores_the_original_claimants_credit() {
    let mut c = contract();
    c.dividend_liability_yocto = 100;
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(id("treasury.test.near"))
        .predecessor_account_id(id("treasury.test.near"))
        .account_balance(NearToken::from_near(100));
    testing_env!(
        builder.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![near_sdk::PromiseResult::Failed]
    );
    assert!(!c.on_payout(id("former-holder.near"), U128(100), "dividend".into()));
    assert_eq!(c.claim_credit(id("former-holder.near")).0, 100);
    assert_eq!(c.dividend_liability_yocto, 100);
}
