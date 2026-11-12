import { KeyPair } from 'near-api-js';
import type { Store } from './store.js';
import type { MainnetReader } from './mainnet.js';
import { MainnetActivation, MainnetActivationProof } from './mainnet-activation-contract.js';
import { readFile } from 'node:fs/promises';
export async function mainnetActivation(store: Store, reader: MainnetReader) {
  const c = store.config,
    snapshot = await reader.snapshot();
  const configuredTreasury = [
    c.NEAR_BRAIN_PRIVATE_KEY,
    c.NEAR_WORKER_PRIVATE_KEY,
    c.NEAR_ACCOUNTANT_PRIVATE_KEY,
  ].filter(Boolean).length;
  const configuredIntents = [c.INTENTS_BRAIN_PRIVATE_KEY, c.INTENTS_HAND_PRIVATE_KEY].filter(
    Boolean,
  ).length;
  const registered = async (
    account: string,
    key: string,
  ): Promise<'REGISTERED' | 'NOT_REGISTERED' | 'UNAVAILABLE'> => {
    if (!key) return 'UNAVAILABLE';
    try {
      return (await reader.intentKeyRegistered(
        account,
        KeyPair.fromString(key as `ed25519:${string}`)
          .getPublicKey()
          .toString(),
        snapshot.block.hash,
      ))
        ? 'REGISTERED'
        : 'NOT_REGISTERED';
    } catch {
      return 'UNAVAILABLE';
    }
  };
  const [brain, hand, controls, policy] = await Promise.all([
    registered(c.NEAR_BRAIN_ACCOUNT_ID, c.INTENTS_BRAIN_PRIVATE_KEY),
    registered(c.NEAR_WORKER_ACCOUNT_ID, c.INTENTS_HAND_PRIVATE_KEY),
    store.db.workerControl.findMany({
      where: { role: { in: ['SCOUT', 'BRAIN', 'HAND'] } },
      select: { role: true, heartbeat: true },
    }),
    reader.activationPolicy(snapshot.block.hash),
  ]);
  const enabled = snapshot.accounts.filter((a) => a.workerEnabled === true).length;
  const matches =
    snapshot.policy.maxTradeAtoms === c.MAX_TRADE_ATOMS &&
    snapshot.policy.maxDailyAtoms === c.MAX_DAILY_SPEND_ATOMS &&
    BigInt(c.MAX_TRADE_ATOMS) > 1n &&
    JSON.stringify(policy.allowed_chain_ids) === '[8453]' &&
    policy.allowed_token_contracts.length === 1 &&
    policy.allowed_token_contracts[0]?.toLowerCase() ===
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' &&
    policy.token_max_trade_atoms[0] === c.MAX_TRADE_ATOMS &&
    policy.token_max_daily_atoms[0] === c.MAX_DAILY_SPEND_ATOMS &&
    BigInt(policy.min_reserve_yocto) >= 100000000000000000000000n &&
    BigInt(policy.max_signing_cost_yocto) <= 1n;
  return MainnetActivation.parse({
    contractVersion: 1,
    network: 'mainnet',
    capturedAt: new Date().toISOString(),
    ownerActivation:
      !snapshot.paused && enabled === 3 && matches
        ? 'ACTIVE'
        : snapshot.paused && enabled === 0
          ? 'PENDING'
          : 'PARTIAL',
    paused: snapshot.paused,
    enabledWorkerCount: enabled,
    executionEnabled: c.EXECUTION_ENABLED,
    automaticTradingEnabled: c.LIVE_ARBITRAGE_ENABLED,
    monitorOnlyWorkers: c.MONITOR_ONLY_WORKERS,
    preparationEnabled: c.MAINNET_PREPARATION_ENABLED,
    proof: MainnetActivationProof.parse(
      JSON.parse(await readFile('artifacts/mainnet-bounded-activation.json', 'utf8')),
    ),
    monitors: controls.map((r) => ({
      role: r.role,
      heartbeat: r.heartbeat?.toISOString() ?? null,
      fresh:
        (c.MONITOR_ONLY_WORKERS || c.MAINNET_PREPARATION_ENABLED) &&
        !!r.heartbeat &&
        Date.now() - r.heartbeat.getTime() >= 0 &&
        Date.now() - r.heartbeat.getTime() < 30000,
    })),
    configuration: {
      scope: 'CONFIGURATION_PRESENCE',
      treasurySigningKeys: configuredTreasury,
      dedicatedIntentsKeys: configuredIntents,
      evmRpcConfigured: !!c.EVM_RPC_URL,
      nftReceiver: c.NFT_RECEIVER_ID,
    },
    intentsRegistration: { brain, hand },
    limits: {
      asset: 'USDC',
      decimals: 6,
      onChainMaxTradeAtoms: snapshot.policy.maxTradeAtoms,
      onChainMaxDailyAtoms: snapshot.policy.maxDailyAtoms,
      configuredMaxTradeAtoms: c.MAX_TRADE_ATOMS,
      configuredMaxDailyAtoms: c.MAX_DAILY_SPEND_ATOMS,
      matches,
      scope: 'AUTHORIZED_CROSS_CHAIN_TRANSFERS',
      universalNativeSpendingCap: false,
      nativeReserveYocto: policy.min_reserve_yocto,
      mpcSigningDepositLimitYocto: policy.max_signing_cost_yocto,
    },
    tee: {
      status: 'QUARANTINED',
      reason: 'APPLICATION_WORKLOAD_MEASUREMENT_POLICY',
      message: 'Inference blocked by application-level TEE workload measurement policy.',
    },
    externalRevenueProven: false,
    automaticCreditPurchaseImplemented: false,
  });
}
