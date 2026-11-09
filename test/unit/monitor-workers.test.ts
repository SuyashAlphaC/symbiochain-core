import { expect, it } from 'vitest';
import { monitorWorkers } from '../../src/monitor-workers.js';
import { loadConfig } from '../../src/config.js';
const env = {
  DATABASE_URL: 'postgresql://unused:unused@localhost/unused',
  ADMIN_TOKEN: 'a'.repeat(40),
  READ_TOKEN: 'r'.repeat(40),
  EVIDENCE_ENCRYPTION_KEY: 'b'.repeat(64),
  EXECUTION_MODE: 'LIVE',
  EXECUTION_ENABLED: 'false',
  MONITOR_ONLY_WORKERS: 'true',
  NEAR_NETWORK: 'mainnet',
  NEAR_CONTRACT_ID: 'treasury.owner.near',
  NEAR_WORKER_ACCOUNT_ID: 'hand.owner.near',
  NEAR_BRAIN_ACCOUNT_ID: 'brain.owner.near',
  NEAR_SCOUT_ACCOUNT_ID: 'scout.owner.near',
  NEAR_ACCOUNTANT_ACCOUNT_ID: 'books.owner.near',
};
it('permits monitor heartbeats only with every execution and spending switch disarmed', () => {
  expect(loadConfig(env).MONITOR_ONLY_WORKERS).toBe(true);
  for (const name of [
    'EXECUTION_ENABLED',
    'LIVE_TRADING_ENABLED',
    'LIVE_ARBITRAGE_ENABLED',
    'BUSINESS_PAYOUTS_ENABLED',
  ])
    expect(() => loadConfig({ ...env, [name]: 'true' })).toThrow('Monitor-only');
  expect(() => loadConfig({ ...env, EXECUTION_MODE: 'PAPER' })).toThrow('Monitor-only');
});
it('updates all three monitoring lanes and exits after the stop signal', async () => {
  const roles: string[] = [];
  let running = true;
  await monitorWorkers(
    async (role) => {
      roles.push(role);
    },
    () => running,
    async () => {
      running = false;
    },
  );
  expect(roles).toEqual(['SCOUT', 'BRAIN', 'HAND']);
});
