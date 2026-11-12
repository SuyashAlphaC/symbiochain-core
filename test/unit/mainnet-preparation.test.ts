import { expect, it } from 'vitest';
import { inspectMainnetPreparation, type PreparationPorts } from '../../src/mainnet-preparation.js';
import { preparationWorkers } from '../../src/preparation-workers.js';
import { loadConfig } from '../../src/config.js';
import { MainnetPreparationReport } from '../../src/mainnet-preparation-contract.js';
const env = {
  DATABASE_URL: 'postgresql://u:p@localhost/test',
  ADMIN_TOKEN: 'a'.repeat(40),
  READ_TOKEN: 'r'.repeat(40),
  EVIDENCE_ENCRYPTION_KEY: 'b'.repeat(64),
  EXECUTION_MODE: 'LIVE',
  EXECUTION_ENABLED: 'false',
  MAINNET_PREPARATION_ENABLED: 'true',
  NEAR_NETWORK: 'mainnet',
  NEAR_CONTRACT_ID: 'treasury.owner.near',
  NEAR_BRAIN_ACCOUNT_ID: 'brain.owner.near',
  NEAR_WORKER_ACCOUNT_ID: 'hand.owner.near',
  NEAR_SCOUT_ACCOUNT_ID: 'scout.owner.near',
  NEAR_ACCOUNTANT_ACCOUNT_ID: 'books.owner.near',
  SOLANA_RPC_URL: 'https://api.mainnet.solana.com',
  EVM_RPC_URL: 'https://base.example',
  MAX_TRADE_ATOMS: '50000',
  GAS_COST_BASE_ATOMS: '1',
  LIVE_COST_BUFFER_ATOMS: '1',
  MIN_NET_PROFIT_ATOMS: '1',
};
const config = loadConfig(env);
function fixture(): PreparationPorts {
  return {
    state: async () => ({
      codeMatches: true,
      paused: false,
      workers: 3,
      allowedChains: [8453, 0],
      allowedTokens: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'sol:native'],
      maxTradeAtoms: '50000',
    }),
    wallets: async () => ({
      evmChain: 8453,
      solanaGenesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      wallets: [
        {
          chain: 'BASE',
          address: '0x' + 'a'.repeat(40),
          nativeAtoms: '1000000000000000',
          tokenAtoms: '50000',
          block: '12',
        },
        {
          chain: 'SOLANA',
          address: 'a'.repeat(44),
          nativeAtoms: '10000000',
          tokenAtoms: null,
          block: '34',
        },
      ],
    }),
    quote: async () => ({
      id: 'a'.repeat(64),
      routeDigest: 'b'.repeat(64),
      inputAtoms: '50000',
      expectedOutputAtoms: '50100',
      minimumOutputAtoms: '50004',
      costsAtoms: '2',
      route: {},
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  };
}
it('only reaches the TEE gate when all real non-TEE prerequisites pass; never calls a signing or inference port', async () => {
  const r = await inspectMainnetPreparation(config, fixture());
  expect(r.nonTeeReady).toBe(true);
  expect(r.nextGate).toBe('TEE_APPROVAL_REQUIRED');
  expect(r.transactionsSubmitted).toBe(0);
  expect(r.paidInferenceRequests).toBe(0);
  expect(() => MainnetPreparationReport.parse({ ...r, transactionsSubmitted: 1 })).toThrow();
  expect(() =>
    MainnetPreparationReport.parse({
      ...r,
      checks: [{ id: 'FUNDING', status: 'BLOCKED', detail: 'Missing funds' }],
    }),
  ).toThrow();
});
it('reports missing capital and a losing route as independent of TEE approval', async () => {
  const p = fixture(),
    read = p.wallets;
  p.wallets = async () => ({
    ...(await read()),
    wallets: (await read()).wallets.map((w) => ({
      ...w,
      nativeAtoms: '0',
      tokenAtoms: w.tokenAtoms === null ? null : '0',
    })),
  });
  const quote = p.quote;
  p.quote = async (proposal) => ({ ...(await quote(proposal)), minimumOutputAtoms: '49800' });
  const r = await inspectMainnetPreparation(config, p);
  expect(r.nonTeeReady).toBe(false);
  expect(r.nextGate).toBe('NON_TEE_REQUIREMENTS');
  expect(r.checks.filter((c) => c.status === 'BLOCKED').map((c) => c.id)).toEqual(
    expect.arrayContaining(['BASE_CAPITAL', 'BASE_GAS', 'SOLANA_GAS', 'PROFITABLE_SIGNED_ROUTE']),
  );
});
it('does not quote on the wrong network and does not expose upstream error content', async () => {
  const p = fixture(),
    read = p.wallets;
  p.wallets = async () => ({ ...(await read()), solanaGenesis: 'DEVNET' });
  p.quote = async () => {
    throw Error('MUST_NOT_QUOTE_SECRET');
  };
  const r = await inspectMainnetPreparation(config, p);
  expect(r.quote.status).toBe('UNAVAILABLE');
  expect(JSON.stringify(r)).not.toContain('SECRET');
});
it('refuses preparation combined with paid switches or devnet and keeps the existing execution gate closed', () => {
  for (const flag of [
    'EXECUTION_ENABLED',
    'MONITOR_ONLY_WORKERS',
    'LIVE_TRADING_ENABLED',
    'LIVE_ARBITRAGE_ENABLED',
    'BUSINESS_PAYOUTS_ENABLED',
  ])
    expect(() => loadConfig({ ...env, [flag]: 'true' })).toThrow('Mainnet preparation');
  expect(() => loadConfig({ ...env, SOLANA_RPC_URL: 'https://api.devnet.solana.com' })).toThrow(
    'mainnet RPC',
  );
});
it('heartbeats continue during a slow preparation request, with no duplicate work', async () => {
  let ticks = 0,
    runs = 0,
    finish!: () => void;
  const pending = new Promise<void>((r) => {
    finish = r;
  });
  const roles: string[] = [];
  await preparationWorkers(
    async (role) => {
      roles.push(role);
    },
    async () => {
      runs++;
      await pending;
    },
    () => ticks < 3,
    async () => {
      ticks++;
      if (ticks === 3) finish();
    },
    () => 1000,
  );
  expect(runs).toBe(1);
  expect(roles).toHaveLength(9);
});
