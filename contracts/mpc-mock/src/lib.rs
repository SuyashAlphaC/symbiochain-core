//! Sandbox-only MPC transport stub. This signature is deliberately invalid.
//! Never deploy this contract as a signing service for live funds.
use near_sdk::{near,env};
#[near(contract_state)]
#[derive(Default)]
pub struct Mock;
#[near]
impl Mock {
    /// Sandbox-only FT receiver for wrapped-NEAR callback gas regression tests.
    pub fn ft_on_transfer(&mut self, sender_id: String, amount: near_sdk::json_types::U128, msg: String) -> near_sdk::json_types::U128 {
        env::log_str(&format!("SANDBOX_FT_RECEIVER:{sender_id}:{}:{msg}", amount.0));
        near_sdk::json_types::U128(0)
    }
    #[payable]
    pub fn sign(&mut self,request:near_sdk::serde_json::Value)->near_sdk::serde_json::Value {
        env::log_str(&format!("SANDBOX_MPC_STUB:{}",request));
        near_sdk::serde_json::json!({"big_r":{"affine_point":format!("02{}","11".repeat(32))},"s":{"scalar":"22".repeat(32)},"recovery_id":0})
    }
}
