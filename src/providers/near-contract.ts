import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import type { Config } from '../config.js';
import { DomainError } from '../domain.js';
export interface Authorization {
  cycle_id: string;
  proposal_hash: string;
  route_hash: string;
  evidence_hash: string;
  amount_atoms: string;
  budget_atoms: string;
  expires_at_ns: string;
  chain_id: number;
  token_contract: string;
  deposit_address: string;
  max_fee_per_gas: string;
  gas_limit: string;
  slippage_bps: number;
}
export interface ContractCycle {
  authorization: Authorization;
  status: string;
  payload_hex: string | null;
  signature: string | null;
  tx_hash: string | null;
  realized_pnl_atoms: string | null;
  reconciliation_hash: string | null;
}
export type ContractRole = 'BRAIN' | 'HAND' | 'ACCOUNTANT';
export class NearTreasury {
  private readonly provider: JsonRpcProvider;
  private readonly accounts: Record<ContractRole, Account>;
  constructor(public readonly config: Config) {
    this.provider = new JsonRpcProvider({ url: config.NEAR_RPC_URL });
    this.accounts = {
      BRAIN: new Account(
        config.NEAR_BRAIN_ACCOUNT_ID,
        this.provider,
        config.NEAR_BRAIN_PRIVATE_KEY as KeyPairString,
      ),
      HAND: new Account(
        config.NEAR_WORKER_ACCOUNT_ID,
        this.provider,
        config.NEAR_WORKER_PRIVATE_KEY as KeyPairString,
      ),
      ACCOUNTANT: new Account(
        config.NEAR_ACCOUNTANT_ACCOUNT_ID,
        this.provider,
        config.NEAR_ACCOUNTANT_PRIVATE_KEY as KeyPairString,
      ),
    };
  }
  async view<T>(methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({
      contractId: this.config.NEAR_CONTRACT_ID,
      method: methodName,
      args,
    })) as T;
  }
  async call<T = unknown>(
    role: ContractRole,
    methodName: string,
    args: Record<string, unknown>,
    gas = 80_000_000_000_000n,
  ): Promise<T> {
    return (await this.accounts[role].callFunction({
      contractId: this.config.NEAR_CONTRACT_ID,
      methodName,
      args,
      gas,
      deposit: 0n,
      waitUntil: 'FINAL',
    })) as T;
  }
  cycle(id: string) {
    return this.view<ContractCycle | null>('get_cycle', { cycle_id: id });
  }
  async authorize(authorization: Authorization): Promise<void> {
    const existing = await this.cycle(authorization.cycle_id);
    if (existing) {
      if (JSON.stringify(existing.authorization) !== JSON.stringify(authorization)) {
        // JSON object member order is not part of NEAR serialization semantics.
        for (const key of Object.keys(authorization) as Array<keyof Authorization>)
          if (existing.authorization[key] !== authorization[key])
            throw new DomainError(
              'ONCHAIN_AUTHORIZATION_CONFLICT',
              'Different terms already authorized',
            );
      }
      return;
    }
    await this.call('BRAIN', 'authorize_cycle', { authorization });
  }
  async service(
    paymentId: string,
    recipient: string,
    referenceHash: string,
    role: ContractRole = 'HAND',
  ): Promise<void> {
    if (BigInt(this.config.SERVICE_PAYMENT_YOCTO) === 0n) return;
    await this.call(role, 'settle_service', {
      payment_id: paymentId,
      recipient,
      amount: this.config.SERVICE_PAYMENT_YOCTO,
      reference_hash: referenceHash,
    });
  }
}
