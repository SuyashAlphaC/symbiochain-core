//! Sandbox-only MPC transport stub. This signature is deliberately invalid.
//! Never deploy this contract as a signing service for live funds.
use near_sdk::{near,env};
#[near(contract_state)]
#[derive(Default)]
pub struct Mock;
#[near]
impl Mock {
    #[payable]
    pub fn sign(&mut self,request:near_sdk::serde_json::Value)->near_sdk::serde_json::Value {
        env::log_str(&format!("SANDBOX_MPC_STUB:{}",request));
        near_sdk::serde_json::json!({"big_r":{"affine_point":format!("02{}","11".repeat(32))},"s":{"scalar":"22".repeat(32)},"recovery_id":0})
    }
}
