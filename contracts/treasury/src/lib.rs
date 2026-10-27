use near_contract_standards::non_fungible_token::NonFungibleToken;
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::{U128, U64};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};
mod nft;
mod solana;
#[cfg(test)]
mod tests;

const MAX_RECORDS: u64 = 10_000;
const DAY_NS: u64 = 86_400_000_000_000;

#[derive(BorshSerialize, BorshStorageKey)]
enum Key {
    Cycles,
    Workers,
    ServiceBalances,
    ServicePayments,
    Tokens,
    TokenMetadata,
    TokenOwner,
    TokenApprovals,
    ReceiptShares,
    Dividends,
    ClaimCredits,
    AssetDaily,
    Distributions,
}

#[near(serializers=[json,borsh])]
#[derive(Clone)]
pub struct Policy {
    pub max_trade_atoms: U128,
    pub max_daily_atoms: U128,
    pub min_reserve_yocto: U128,
    pub max_signing_cost_yocto: U128,
    pub max_slippage_bps: u16,
    pub allowed_chain_ids: Vec<u64>,
    pub allowed_token_contracts: Vec<String>,
    pub token_max_trade_atoms: Vec<U128>,
    pub token_max_daily_atoms: Vec<U128>,
}

#[near(serializers=[json,borsh])]
#[derive(Clone)]
pub struct Authorization {
    pub cycle_id: String,
    pub proposal_hash: String,
    pub route_hash: String,
    pub evidence_hash: String,
    pub amount_atoms: U128,
    /// Both limits use the configured base asset denomination, never mixed token units.
    pub budget_atoms: U128,
    pub expires_at_ns: U64,
    pub chain_id: u64,
    pub token_contract: String,
    pub deposit_address: String,
    pub max_fee_per_gas: U128,
    pub gas_limit: U128,
    pub slippage_bps: u16,
}

#[near(serializers=[json,borsh])]
#[derive(Clone)]
pub struct CycleRecord {
    pub authorization: Authorization,
    pub status: String,
    pub payload_hex: Option<String>,
    pub signature: Option<String>,
    pub tx_hash: Option<String>,
    pub realized_pnl_atoms: Option<String>,
    pub reconciliation_hash: Option<String>,
}

#[near(serializers=[json])]
pub struct EvmTransfer {
    pub nonce: U64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    brain: AccountId,
    hand: AccountId,
    accountant: AccountId,
    mpc: AccountId,
    derivation_path: String,
    policy: Policy,
    paused: bool,
    day: u64,
    daily_reserved_atoms: u128,
    signing_reserved_yocto: u128,
    unresolved_signatures: u32,
    service_liability_yocto: u128,
    cycles: UnorderedMap<String, CycleRecord>,
    workers: LookupMap<AccountId, bool>,
    service_balances: LookupMap<AccountId, u128>,
    service_payments: LookupMap<String, String>,
    tokens: NonFungibleToken,
    receipt_shares: UnorderedMap<String, u16>,
    total_shares_bps: u16,
    dividends: LookupMap<String, u128>,
    claim_credits: LookupMap<AccountId, u128>,
    dividend_liability_yocto: u128,
    asset_daily: LookupMap<String, (u64, u128)>,
    distributions: UnorderedMap<String, u128>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        brain: AccountId,
        hand: AccountId,
        accountant: AccountId,
        mpc: AccountId,
        derivation_path: String,
        policy: Policy,
    ) -> Self {
        validate_policy(&policy);
        require!(
            !derivation_path.is_empty() && derivation_path.len() <= 64,
            "Invalid derivation path"
        );
        let mut workers = LookupMap::new(Key::Workers);
        workers.insert(&brain, &true);
        workers.insert(&hand, &true);
        workers.insert(&accountant, &true);
        let tokens = NonFungibleToken::new(
            Key::Tokens,
            owner.clone(),
            Some(Key::TokenMetadata),
            Some(Key::TokenOwner),
            Some(Key::TokenApprovals),
        );
        Self {
            owner,
            brain,
            hand,
            accountant,
            mpc,
            derivation_path,
            policy,
            paused: false,
            day: env::block_timestamp() / DAY_NS,
            daily_reserved_atoms: 0,
            signing_reserved_yocto: 0,
            unresolved_signatures: 0,
            service_liability_yocto: 0,
            cycles: UnorderedMap::new(Key::Cycles),
            workers,
            service_balances: LookupMap::new(Key::ServiceBalances),
            service_payments: LookupMap::new(Key::ServicePayments),
            tokens,
            receipt_shares: UnorderedMap::new(Key::ReceiptShares),
            total_shares_bps: 0,
            dividends: LookupMap::new(Key::Dividends),
            claim_credits: LookupMap::new(Key::ClaimCredits),
            dividend_liability_yocto: 0,
            asset_daily: LookupMap::new(Key::AssetDaily),
            distributions: UnorderedMap::new(Key::Distributions),
        }
    }

    #[payable]
    pub fn fund(&mut self) {
        self.log("funded",near_sdk::serde_json::json!({"amount":env::attached_deposit().as_yoctonear().to_string()}));
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.owner_only();
        self.paused = paused;
        self.log("paused", near_sdk::serde_json::json!({"paused":paused}));
    }
    pub fn set_policy(&mut self, policy: Policy) {
        self.owner_only();
        validate_policy(&policy);
        self.policy = policy;
    }
    pub fn set_worker_enabled(&mut self, worker: AccountId, enabled: bool) {
        self.owner_only();
        self.workers.insert(&worker, &enabled);
    }
    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }
    pub fn get_cycle(&self, cycle_id: String) -> Option<CycleRecord> {
        self.cycles.get(&cycle_id)
    }
    pub fn get_signing_identity(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"predecessor":env::current_account_id(),"path":self.derivation_path,"mpc":self.mpc})
    }
    pub fn check_metabolism(&self) -> near_sdk::serde_json::Value {
        let available = self.available_native();
        near_sdk::serde_json::json!({"status":if self.paused {"PAUSED"} else if available<self.policy.min_reserve_yocto.0 {"LOW_RESERVE"}else{"ACTIVE"},"available_yocto":available.to_string(),"service_liability_yocto":self.service_liability_yocto.to_string(),"compute_credits":"UNKNOWN"})
    }

    pub fn authorize_cycle(&mut self, authorization: Authorization) -> CycleRecord {
        self.role(&self.brain);
        require!(!self.paused, "Paused");
        valid_hash(&authorization.proposal_hash);
        valid_hash(&authorization.route_hash);
        valid_hash(&authorization.evidence_hash);
        require!(
            !authorization.cycle_id.is_empty() && authorization.cycle_id.len() <= 80,
            "Invalid cycle id"
        );
        if let Some(existing) = self.cycles.get(&authorization.cycle_id) {
            require!(
                near_sdk::serde_json::to_string(&existing.authorization).unwrap()
                    == near_sdk::serde_json::to_string(&authorization).unwrap(),
                "Idempotency conflict"
            );
            return existing;
        }
        require!(self.cycles.len() < MAX_RECORDS, "Cycle capacity reached");
        self.validate_authorization(&authorization);
        let day = env::block_timestamp() / DAY_NS;
        if day != self.day {
            self.day = day;
            self.daily_reserved_atoms = 0;
        }
        let total = self
            .daily_reserved_atoms
            .checked_add(authorization.budget_atoms.0)
            .expect("Overflow");
        require!(total <= self.policy.max_daily_atoms.0, "Daily limit");
        self.daily_reserved_atoms = total;
        let asset_index = self
            .policy
            .allowed_token_contracts
            .iter()
            .position(|v| v.eq_ignore_ascii_case(&authorization.token_contract))
            .expect("Unknown token");
        let asset_key = format!(
            "{}:{}",
            authorization.chain_id,
            authorization.token_contract.to_lowercase()
        );
        let (previous_day, previous_amount) = self.asset_daily.get(&asset_key).unwrap_or((day, 0));
        let amount = if previous_day == day {
            previous_amount
        } else {
            0
        };
        let amount = amount
            .checked_add(authorization.amount_atoms.0)
            .expect("Overflow");
        require!(
            amount <= self.policy.token_max_daily_atoms[asset_index].0,
            "Token daily limit"
        );
        self.asset_daily.insert(&asset_key, &(day, amount));
        let record = CycleRecord {
            authorization: authorization.clone(),
            status: "AUTHORIZED".into(),
            payload_hex: None,
            signature: None,
            tx_hash: None,
            realized_pnl_atoms: None,
            reconciliation_hash: None,
        };
        self.cycles.insert(&authorization.cycle_id, &record);
        require!(
            self.available_native() >= self.policy.min_reserve_yocto.0,
            "Authorization storage reserve protected"
        );
        self.log("authorized",near_sdk::serde_json::json!({"cycle_id":authorization.cycle_id,"route_hash":authorization.route_hash}));
        record
    }

    /// Derives the only signable payload from the authorized ERC-20 transfer.
    /// The worker cannot pass arbitrary calldata or a precomputed payload hash.
    pub fn request_evm_signature(&mut self, cycle_id: String, transaction: EvmTransfer) -> Promise {
        self.role(&self.hand);
        require!(!self.paused, "Paused");
        let mut record = self.cycles.get(&cycle_id).expect("Unknown cycle");
        require!(
            record.status == "AUTHORIZED",
            "Signing already requested; reconcile existing request"
        );
        self.validate_authorization(&record.authorization);
        require!(
            record.authorization.chain_id != 0,
            "Use the Solana signing method"
        );
        require!(
            transaction.max_fee_per_gas.0 <= record.authorization.max_fee_per_gas.0,
            "Gas price exceeds authorization"
        );
        require!(
            transaction.gas_limit.0 <= record.authorization.gas_limit.0,
            "Gas limit exceeds authorization"
        );
        require!(
            transaction.max_priority_fee_per_gas.0 <= transaction.max_fee_per_gas.0,
            "Invalid priority fee"
        );
        let a = &record.authorization;
        let token = address_bytes(&a.token_contract);
        let recipient = address_bytes(&a.deposit_address);
        let mut data = hex::decode("a9059cbb").unwrap();
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(&recipient);
        data.extend_from_slice(&[0u8; 16]);
        data.extend_from_slice(&a.amount_atoms.0.to_be_bytes());
        let encoded = rlp_list(&[
            rlp_int(a.chain_id as u128),
            rlp_int(transaction.nonce.0 as u128),
            rlp_int(transaction.max_priority_fee_per_gas.0),
            rlp_int(transaction.max_fee_per_gas.0),
            rlp_int(transaction.gas_limit.0),
            rlp_bytes(&token),
            rlp_int(0),
            rlp_bytes(&data),
            vec![0xc0],
        ]);
        let mut unsigned = vec![2u8];
        unsigned.extend_from_slice(&encoded);
        let payload = hex::encode(env::keccak256(&unsigned));
        let signing_cost = 1u128;
        require!(
            self.available_native()
                >= self
                    .policy
                    .min_reserve_yocto
                    .0
                    .checked_add(signing_cost)
                    .expect("Overflow"),
            "Reserve protected"
        );
        require!(
            signing_cost <= self.policy.max_signing_cost_yocto.0,
            "Signing cost limit"
        );
        record.payload_hex = Some(payload.clone());
        record.status = "SIGNING".into();
        self.cycles.insert(&cycle_id, &record);
        self.signing_reserved_yocto = self
            .signing_reserved_yocto
            .checked_add(signing_cost)
            .expect("Overflow");
        self.unresolved_signatures = self.unresolved_signatures.checked_add(1).expect("Overflow");
        self.request_mpc(cycle_id, payload, false)
    }

    #[private]
    pub fn on_signature(&mut self, cycle_id: String) -> Option<near_sdk::serde_json::Value> {
        let mut record = self.cycles.get(&cycle_id).expect("Unknown cycle");
        require!(record.status == "SIGNING", "Invalid signing state");
        self.signing_reserved_yocto = self
            .signing_reserved_yocto
            .checked_sub(1)
            .expect("Accounting mismatch");
        let result = env::promise_result_checked(0, 4096).ok().and_then(|bytes| {
            near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes).ok()
        });
        if let Some(signature) = result {
            record.signature = Some(signature.to_string());
            record.status = "SIGNED".into();
            self.cycles.insert(&cycle_id, &record);
            Some(signature)
        } else {
            record.status = "SIGNATURE_FAILED".into();
            self.unresolved_signatures = self
                .unresolved_signatures
                .checked_sub(1)
                .expect("Signature counter mismatch");
            self.cycles.insert(&cycle_id, &record);
            None
        }
    }

    /// A signature may already have been broadcast. No automatic reauthorization or reserve release is allowed.
    pub fn record_submission(&mut self, cycle_id: String, tx_hash: String) {
        self.role(&self.hand);
        require!(
            tx_hash.len() <= 100 && !tx_hash.is_empty(),
            "Invalid transaction hash"
        );
        let mut r = self.cycles.get(&cycle_id).expect("Unknown cycle");
        if let Some(existing) = r.tx_hash.as_ref() {
            require!(existing == &tx_hash, "Submission conflict");
            return;
        }
        require!(r.status == "SIGNED", "Signature required");
        r.tx_hash = Some(tx_hash);
        r.status = "SUBMITTED".into();
        self.cycles.insert(&cycle_id, &r);
    }

    /// Reconciliation is an explicit accountant trust boundary, not a proof of cross-chain state by itself.
    pub fn finalize_cycle(
        &mut self,
        cycle_id: String,
        reconciliation_hash: String,
        realized_pnl_atoms: String,
    ) -> CycleRecord {
        self.role(&self.accountant);
        valid_hash(&reconciliation_hash);
        require!(
            realized_pnl_atoms.len() <= 78 && realized_pnl_atoms.parse::<i128>().is_ok(),
            "Invalid PnL"
        );
        let mut r = self.cycles.get(&cycle_id).expect("Unknown cycle");
        if r.status == "CLOSED" {
            require!(
                r.reconciliation_hash.as_ref() == Some(&reconciliation_hash)
                    && r.realized_pnl_atoms.as_ref() == Some(&realized_pnl_atoms),
                "Finalization conflict"
            );
            return r;
        }
        require!(r.status == "SUBMITTED", "Submission required");
        r.status = "CLOSED".into();
        self.unresolved_signatures = self
            .unresolved_signatures
            .checked_sub(1)
            .expect("Signature counter mismatch");
        r.reconciliation_hash = Some(reconciliation_hash);
        r.realized_pnl_atoms = Some(realized_pnl_atoms);
        self.cycles.insert(&cycle_id, &r);
        r
    }

    #[payable]
    pub fn fund_services(&mut self) {
        let who = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Deposit required");
        let storage_before = env::storage_usage();
        let prior = self.service_balances.get(&who).unwrap_or(0);
        self.service_balances.insert(
            &who,
            &self
                .service_balances
                .get(&who)
                .unwrap_or(0)
                .checked_add(amount)
                .expect("Overflow"),
        );
        let storage_cost = (env::storage_usage() - storage_before) as u128
            * env::storage_byte_cost().as_yoctonear();
        require!(amount > storage_cost, "Deposit must cover its storage");
        let credit = amount - storage_cost;
        self.service_balances
            .insert(&who, &prior.checked_add(credit).expect("Overflow"));
        self.service_liability_yocto = self
            .service_liability_yocto
            .checked_add(credit)
            .expect("Overflow");
    }
    pub fn service_balance(&self, account: AccountId) -> U128 {
        U128(self.service_balances.get(&account).unwrap_or(0))
    }
    pub fn settle_service(
        &mut self,
        payment_id: String,
        recipient: AccountId,
        amount: U128,
        reference_hash: String,
    ) {
        require!(!self.paused, "Paused");
        let payer = env::predecessor_account_id();
        require!(self.workers.get(&payer).unwrap_or(false), "Worker revoked");
        require!(
            payment_id.len() <= 80 && !payment_id.is_empty(),
            "Invalid payment id"
        );
        valid_hash(&reference_hash);
        let identity = near_sdk::serde_json::to_string(&(
            payer.clone(),
            recipient.clone(),
            amount,
            reference_hash.clone(),
        ))
        .unwrap();
        if let Some(existing) = self.service_payments.get(&payment_id) {
            require!(existing == identity, "Service idempotency conflict");
            return;
        }
        let balance = self.service_balances.get(&payer).unwrap_or(0);
        require!(balance >= amount.0, "Insufficient service balance");
        require!(payer != recipient, "Self payment forbidden");
        self.service_balances.insert(&payer, &(balance - amount.0));
        self.service_balances.insert(
            &recipient,
            &self
                .service_balances
                .get(&recipient)
                .unwrap_or(0)
                .checked_add(amount.0)
                .expect("Overflow"),
        );
        self.service_payments.insert(&payment_id, &identity);
        require!(
            self.available_native() >= self.policy.min_reserve_yocto.0,
            "Service storage reserve protected"
        );
        self.log("service_paid",near_sdk::serde_json::json!({"payment_id":payment_id,"payer":payer,"recipient":recipient,"amount":amount.0.to_string(),"reference_hash":reference_hash}));
    }

    pub fn withdraw_funds(&mut self, amount: U128) -> Promise {
        self.owner_only();
        require!(self.paused, "Pause before owner withdrawal");
        require!(
            self.unresolved_signatures == 0,
            "Outstanding signatures or submissions require reconciliation"
        );
        require!(
            amount.0 <= self.available_native(),
            "Committed funds protected"
        );
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }
}

impl Contract {
    fn request_mpc(&self, cycle_id: String, payload: String, ed25519: bool) -> Promise {
        let payload = if ed25519 {
            near_sdk::serde_json::json!({"Eddsa":payload})
        } else {
            near_sdk::serde_json::json!({"Ecdsa":payload})
        };
        Promise::new(self.mpc.clone()).function_call("sign",near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"request":{"payload_v2":payload,"path":self.derivation_path,"domain_id":if ed25519{1}else{0}}})).unwrap(),NearToken::from_yoctonear(1),Gas::from_tgas(180))
          .then(Promise::new(env::current_account_id()).function_call("on_signature",near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"cycle_id":cycle_id})).unwrap(),NearToken::from_yoctonear(0),Gas::from_tgas(30)))
    }
    fn owner_only(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }
    fn role(&self, expected: &AccountId) {
        let who = env::predecessor_account_id();
        require!(
            &who == expected && self.workers.get(&who).unwrap_or(false),
            "Unauthorized or revoked worker"
        );
    }
    fn available_native(&self) -> u128 {
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(
                env::storage_byte_cost()
                    .as_yoctonear()
                    .saturating_mul(env::storage_usage() as u128),
            )
            .saturating_sub(self.service_liability_yocto)
            .saturating_sub(self.dividend_liability_yocto)
            .saturating_sub(self.signing_reserved_yocto)
    }
    fn validate_authorization(&self, a: &Authorization) {
        require!(
            a.amount_atoms.0 > 0
                && a.budget_atoms.0 > 0
                && a.budget_atoms.0 <= self.policy.max_trade_atoms.0,
            "Trade limit"
        );
        require!(
            a.expires_at_ns.0 > env::block_timestamp()
                && a.expires_at_ns.0 <= env::block_timestamp() + 3_600_000_000_000,
            "Expired or excessive deadline"
        );
        require!(
            self.policy.allowed_chain_ids.contains(&a.chain_id),
            "Chain not allowed"
        );
        require!(
            self.policy
                .allowed_token_contracts
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&a.token_contract)),
            "Token not allowed"
        );
        let index = self
            .policy
            .allowed_token_contracts
            .iter()
            .position(|v| v.eq_ignore_ascii_case(&a.token_contract))
            .unwrap();
        require!(
            a.amount_atoms.0 <= self.policy.token_max_trade_atoms[index].0,
            "Token trade limit"
        );
        if a.chain_id == 0 {
            require!(
                a.token_contract == "sol:native",
                "Only native SOL transfers supported"
            );
            require!(
                hex::decode(&a.deposit_address)
                    .map(|v| v.len() == 32)
                    .unwrap_or(false),
                "Invalid Solana recipient"
            );
            require!(
                a.amount_atoms.0 <= u64::MAX as u128,
                "Solana amount overflow"
            );
        } else {
            address_bytes(&a.token_contract);
            address_bytes(&a.deposit_address);
        }
        require!(
            a.slippage_bps <= self.policy.max_slippage_bps,
            "Slippage limit"
        );
        require!(a.gas_limit.0 > 0 && a.gas_limit.0 <= 500_000, "Gas limit");
    }
    fn log(&self, event: &str, data: near_sdk::serde_json::Value) {
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({"standard":"symbiochain","version":"1.0.0","event":event,"data":[data]})
        ));
    }
}
fn validate_policy(p: &Policy) {
    require!(
        p.max_trade_atoms.0 > 0 && p.max_daily_atoms.0 >= p.max_trade_atoms.0,
        "Invalid limits"
    );
    require!(p.max_slippage_bps <= 1000, "Excessive slippage");
    require!(
        !p.allowed_chain_ids.is_empty() && p.allowed_chain_ids.len() <= 8,
        "Invalid chains"
    );
    require!(
        !p.allowed_token_contracts.is_empty() && p.allowed_token_contracts.len() <= 16,
        "Invalid token set"
    );
    for a in &p.allowed_token_contracts {
        if a != "sol:native" {
            address_bytes(a);
        }
    }
    require!(
        p.allowed_token_contracts.len() == p.token_max_trade_atoms.len()
            && p.allowed_token_contracts.len() == p.token_max_daily_atoms.len(),
        "Token limits required"
    );
    for i in 0..p.allowed_token_contracts.len() {
        require!(
            p.token_max_trade_atoms[i].0 > 0
                && p.token_max_daily_atoms[i].0 >= p.token_max_trade_atoms[i].0,
            "Invalid token limits"
        );
        require!(
            !p.allowed_token_contracts[..i]
                .iter()
                .any(|v| v.eq_ignore_ascii_case(&p.allowed_token_contracts[i])),
            "Duplicate token policy"
        );
    }
}
fn valid_hash(s: &str) {
    require!(
        s.len() == 64 && hex::decode(s).is_ok(),
        "Expected SHA-256 hex"
    );
}
fn address_bytes(s: &str) -> Vec<u8> {
    let b = hex::decode(s.strip_prefix("0x").expect("Address prefix required"))
        .expect("Invalid address hex");
    require!(b.len() == 20, "Invalid address length");
    b
}
fn rlp_int(v: u128) -> Vec<u8> {
    if v == 0 {
        return vec![0x80];
    }
    let b = v.to_be_bytes();
    rlp_bytes(&b[b.iter().position(|x| *x != 0).unwrap()..])
}
fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_prefix(0x80, b.len());
    out.extend_from_slice(b);
    out
}
fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let size = items.iter().map(Vec::len).sum();
    let mut out = rlp_prefix(0xc0, size);
    for item in items {
        out.extend_from_slice(item);
    }
    out
}
fn rlp_prefix(base: u8, len: usize) -> Vec<u8> {
    if len < 56 {
        return vec![base + len as u8];
    }
    let bytes = len.to_be_bytes();
    let bytes = &bytes[bytes.iter().position(|v| *v != 0).unwrap()..];
    let mut out = vec![base + 55 + bytes.len() as u8];
    out.extend_from_slice(bytes);
    out
}
