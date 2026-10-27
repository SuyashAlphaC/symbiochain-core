use crate::{Contract, ContractExt};
use near_sdk::{near, require, Promise};

/// A deliberately narrow legacy Solana message: one native SOL SystemProgram transfer.
/// No arbitrary instruction, approval, program, or compute-budget instruction can be signed.
#[near]
impl Contract {
    pub fn request_solana_signature(
        &mut self,
        cycle_id: String,
        sender_hex: String,
        recent_blockhash_hex: String,
    ) -> Promise {
        self.role(&self.hand);
        require!(!self.paused, "Paused");
        let mut r = self.cycles.get(&cycle_id).expect("Unknown cycle");
        require!(
            r.status == "AUTHORIZED",
            "Signing already requested; reconcile existing request"
        );
        self.validate_authorization(&r.authorization);
        require!(
            r.authorization.chain_id == 0,
            "Expected Solana authorization"
        );
        let sender = key(&sender_hex);
        let blockhash = key(&recent_blockhash_hex);
        let recipient = key(&r.authorization.deposit_address);
        require!(
            sender != recipient && sender != vec![0; 32] && recipient != vec![0; 32],
            "Invalid transfer accounts"
        );
        let payload = transfer_message(
            &sender,
            &recipient,
            &blockhash,
            r.authorization.amount_atoms.0 as u64,
        );
        require!(
            self.available_native()
                >= self
                    .policy
                    .min_reserve_yocto
                    .0
                    .checked_add(1)
                    .expect("Overflow"),
            "Reserve protected"
        );
        require!(
            self.policy.max_signing_cost_yocto.0 >= 1,
            "Signing cost limit"
        );
        let payload = hex::encode(payload);
        r.payload_hex = Some(payload.clone());
        r.status = "SIGNING".into();
        self.cycles.insert(&cycle_id, &r);
        self.signing_reserved_yocto = self
            .signing_reserved_yocto
            .checked_add(1)
            .expect("Overflow");
        self.unresolved_signatures = self.unresolved_signatures.checked_add(1).expect("Overflow");
        self.request_mpc(cycle_id, payload, true)
    }
}
fn key(s: &str) -> Vec<u8> {
    let b = hex::decode(s).expect("Invalid public key hex");
    require!(b.len() == 32, "Expected 32 bytes");
    b
}
pub(crate) fn transfer_message(
    sender: &[u8],
    recipient: &[u8],
    blockhash: &[u8],
    amount: u64,
) -> Vec<u8> {
    let mut msg = vec![1, 0, 1, 3]; // one signature; one readonly unsigned system-program account; three keys
    msg.extend_from_slice(sender);
    msg.extend_from_slice(recipient);
    msg.extend_from_slice(&[0; 32]);
    msg.extend_from_slice(blockhash);
    msg.extend_from_slice(&[1, 2, 2, 0, 1, 12]); // one instruction, program index 2, account indexes [0,1], 12 data bytes
    msg.extend_from_slice(&2u32.to_le_bytes());
    msg.extend_from_slice(&amount.to_le_bytes());
    msg
}
