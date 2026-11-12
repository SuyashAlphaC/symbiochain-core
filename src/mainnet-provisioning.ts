import { readFile } from 'node:fs/promises';
import { MainnetProvisioning } from './mainnet-provisioning-contract.js';
export async function readMainnetProvisioning() {
  const raw = JSON.parse(
    await readFile(
      new URL('../artifacts/mainnet-wallet-provisioning.json', import.meta.url),
      'utf8',
    ),
  );
  const { policy, ...rest } = raw;
  const sol = policy.allowed_token_contracts.indexOf('sol:native');
  return MainnetProvisioning.parse({
    ...rest,
    limits: {
      maxTradeUsdcAtoms: policy.max_trade_atoms,
      maxDailyUsdcAtoms: policy.max_daily_atoms,
      maxSolLamports: policy.token_max_trade_atoms[sol],
      maxDailySolLamports: policy.token_max_daily_atoms[sol],
      nativeReserveYocto: policy.min_reserve_yocto,
    },
  });
}
