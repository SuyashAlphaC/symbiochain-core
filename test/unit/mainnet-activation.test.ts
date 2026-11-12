import { expect, it } from 'vitest';
import { KeyPair } from 'near-api-js';
import { mainnetActivation } from '../../src/mainnet-activation.js';
import { MainnetActivation } from '../../src/mainnet-activation-contract.js';
import { loadConfig } from '../../src/config.js';
import type { Store } from '../../src/store.js';
import type { MainnetReader } from '../../src/mainnet.js';
it('distinguishes active owner policy, monitor heartbeats and the closed AI execution gate without exposing keys', async () => {
  const key = () => KeyPair.fromRandom('ed25519').toString();
  const c = loadConfig({
    DATABASE_URL: 'postgresql://u:p@localhost/test',
    ADMIN_TOKEN: 'a'.repeat(40),
    READ_TOKEN: 'r'.repeat(40),
    EVIDENCE_ENCRYPTION_KEY: 'b'.repeat(64),
    EXECUTION_MODE: 'LIVE',
    EXECUTION_ENABLED: 'false',
    MONITOR_ONLY_WORKERS: 'true',
    NEAR_NETWORK: 'mainnet',
    NEAR_CONTRACT_ID: 'treasury.owner.near',
    NEAR_BRAIN_ACCOUNT_ID: 'brain.owner.near',
    NEAR_WORKER_ACCOUNT_ID: 'hand.owner.near',
    NEAR_SCOUT_ACCOUNT_ID: 'scout.owner.near',
    NEAR_ACCOUNTANT_ACCOUNT_ID: 'books.owner.near',
    NEAR_BRAIN_PRIVATE_KEY: key(),
    NEAR_WORKER_PRIVATE_KEY: key(),
    NEAR_ACCOUNTANT_PRIVATE_KEY: key(),
    INTENTS_BRAIN_PRIVATE_KEY: key(),
    INTENTS_HAND_PRIVATE_KEY: key(),
    EVM_RPC_URL: 'https://rpc.example/?secret=RPC_SECRET',
    NFT_RECEIVER_ID: 'owner.near',
    MAX_TRADE_ATOMS: '50000',
    MAX_DAILY_SPEND_ATOMS: '100000',
  });
  let paused = false;
  const store = {
    config: c,
    db: {
      workerControl: {
        findMany: async () => [
          { role: 'SCOUT', heartbeat: new Date() },
          { role: 'BRAIN', heartbeat: new Date(Date.now() - 60000) },
          { role: 'HAND', heartbeat: null },
        ],
      },
    },
  } as unknown as Store;
  const reader = {
    snapshot: async () => ({
      paused,
      block: { hash: 'final' },
      accounts: [1, 2, 3].map(() => ({ workerEnabled: true })),
      policy: { maxTradeAtoms: '50000', maxDailyAtoms: '100000' },
    }),
    intentKeyRegistered: async (account: string) => account.startsWith('brain'),
    activationPolicy: async () => ({
      max_trade_atoms: '50000',
      max_daily_atoms: '100000',
      max_slippage_bps: 0,
      allowed_chain_ids: [8453],
      allowed_token_contracts: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
      token_max_trade_atoms: ['50000'],
      token_max_daily_atoms: ['100000'],
      min_reserve_yocto: '100000000000000000000000',
      max_signing_cost_yocto: '1',
    }),
  } as unknown as MainnetReader;
  const r = await mainnetActivation(store, reader);
  expect(r.ownerActivation).toBe('ACTIVE');
  expect(r.executionEnabled).toBe(false);
  expect(r.tee.status).toBe('QUARANTINED');
  expect(r.configuration).toMatchObject({ treasurySigningKeys: 3, dedicatedIntentsKeys: 2 });
  expect(r.intentsRegistration).toEqual({ brain: 'REGISTERED', hand: 'NOT_REGISTERED' });
  expect(r.monitors.map((m) => m.fresh)).toEqual([true, false, false]);
  for (const secret of [
    c.NEAR_BRAIN_PRIVATE_KEY,
    c.NEAR_WORKER_PRIVATE_KEY,
    c.NEAR_ACCOUNTANT_PRIVATE_KEY,
    c.INTENTS_BRAIN_PRIVATE_KEY,
    c.INTENTS_HAND_PRIVATE_KEY,
    'RPC_SECRET',
  ])
    expect(JSON.stringify(r)).not.toContain(secret);
  expect(() => MainnetActivation.parse({ ...r, privateKey: 'DO_NOT_LEAK' })).toThrow();
  expect(() =>
    MainnetActivation.parse({ ...r, limits: { ...r.limits, universalNativeSpendingCap: true } }),
  ).toThrow();
  expect(() =>
    MainnetActivation.parse({
      ...r,
      proof: { ...r.proof, ownerGasReserveReallocatedYocto: '1' },
    }),
  ).toThrow();
  if (r.proof.transactions.length)
    expect(() =>
      MainnetActivation.parse({
        ...r,
        proof: {
          ...r.proof,
          transactions: r.proof.transactions.map((t) => ({
            ...t,
            url: 'https://nearblocks.io/txns/' + 'A'.repeat(43),
          })),
        },
      }),
    ).toThrow();
  paused = true;
  expect((await mainnetActivation(store, reader)).ownerActivation).toBe('PARTIAL');
});
