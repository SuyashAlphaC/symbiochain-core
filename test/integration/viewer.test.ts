import { afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { createApp } from '../../src/app.js';
import { Engine } from '../../src/engine.js';
import { PaperProviders } from '../../src/providers/paper.js';
import { ViewerSnapshot } from '../../src/viewer-contract.js';
import { TestnetReport } from '../../src/testnet-contract.js';
import { MainnetAcceptance } from '../../src/mainnet-acceptance-contract.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required');
const config = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  NFT_SHARE_BPS: '0',
  LOG_LEVEL: 'silent',
});
const db = createDatabase(url),
  store = new Store(db, config);
const headers = { authorization: `Bearer ${config.READ_TOKEN}` };

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Cycle", "ServicePayment", "ComputeAccount", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
  await store.fundPaper(20_000_000n, 'viewer-test-capital');
});
afterAll(async () => db.$disconnect());

it('keeps PAPER records private and rejects all privileged writes when LIVE is disarmed', async () => {
  const live = new Store(db, {
    ...config,
    EXECUTION_MODE: 'LIVE',
    EXECUTION_ENABLED: false,
    NEAR_NETWORK: 'mainnet',
    LIVE_TRADING_ENABLED: false,
    LIVE_ARBITRAGE_ENABLED: false,
    NEAR_CONTRACT_ID: 'treasury.owner.near',
    NEAR_WORKER_ACCOUNT_ID: 'hand.owner.near',
    NEAR_BRAIN_ACCOUNT_ID: 'brain.owner.near',
    NEAR_SCOUT_ACCOUNT_ID: 'scout.owner.near',
    NEAR_ACCOUNTANT_ACCOUNT_ID: 'books.owner.near',
  });
  const paperBalance = await store.balance();
  await live.initialize();
  const app = await createApp(live);
  try {
    expect((await app.inject('/api/runtime')).statusCode).toBe(401);
    const status = await app.inject({ url: '/api/runtime', headers });
    expect(status.json()).toMatchObject({
      mode: 'LIVE',
      executionEnabled: false,
      mainnetAvailable: true,
    });
    expect((await app.inject({ url: '/api/viewer/snapshot', headers })).statusCode).toBe(403);
    expect((await app.inject('/api/evidence/mainnet')).statusCode).toBe(401);
    expect((await app.inject('/api/mainnet/activation')).statusCode).toBe(401);
    expect((await app.inject('/api/mainnet/preparation')).statusCode).toBe(401);
    expect((await app.inject('/api/evidence/mainnet-intents')).statusCode).toBe(401);
    const acceptance = await app.inject({ url: '/api/evidence/mainnet', headers });
    expect(acceptance.statusCode).toBe(200);
    expect(MainnetAcceptance.parse(acceptance.json())).toMatchObject({
      profile: 'MAINNET_ACCEPTANCE',
      network: 'mainnet',
    });
    expect(acceptance.headers['cache-control']).toBe('private, no-store');
    expect(acceptance.body).not.toContain(config.READ_TOKEN);
    expect(acceptance.body).not.toContain(config.ADMIN_TOKEN);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/cycles',
          headers: { authorization: 'Bearer ' + config.ADMIN_TOKEN },
          payload: {
            strategy: 'round-trip',
            originChain: 'near:paper',
            destinationChain: 'eip155:31337',
            originAsset: 'USDC',
            intermediateAsset: 'WNEAR',
            amountAtoms: '1000000',
            recipient: 'paper.treasury',
            refundTo: 'paper.treasury',
            slippageBps: 50,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        })
      ).json(),
    ).toMatchObject({ error: 'EXECUTION_DISABLED' });
    expect(await store.balance()).toBe(paperBalance);
    expect(await live.balance()).toBe(0n);
    expect((await db.policy.findUniqueOrThrow({ where: { mode: 'LIVE' } })).paused).toBe(true);
    await expect(live.createCycle({}, 'disabled-test')).rejects.toMatchObject({
      code: 'EXECUTION_DISABLED',
    });
  } finally {
    await app.close();
  }
});

it('publishes bounded PAPER ledger data without arbitrary decision, event, or proof payloads', async () => {
  const { cycle } = await store.createCycle(
    {
      strategy: 'round-trip',
      originChain: 'near:paper',
      destinationChain: 'eip155:31337',
      originAsset: 'USDC',
      intermediateAsset: 'WNEAR',
      amountAtoms: '5000000',
      recipient: 'paper.treasury',
      refundTo: 'paper.treasury',
      slippageBps: 50,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    randomUUID(),
  );
  const engine = new Engine(store, new PaperProviders());
  for (let i = 0; i < 12; i++) await engine.tick();
  await db.decision.updateMany({ data: { details: { prompt: 'PRIVATE_PROMPT_SENTINEL' } } });
  await db.outboxEvent.updateMany({ data: { payload: { privateKey: 'PRIVATE_EVENT_SENTINEL' } } });
  await db.proof.updateMany({ data: { evidenceCiphertext: 'PRIVATE_EVIDENCE_SENTINEL' } });
  const app = await createApp(store);
  try {
    expect((await app.inject('/api/viewer/snapshot')).statusCode).toBe(401);
    const response = await app.inject({ url: '/api/viewer/snapshot', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const data = ViewerSnapshot.parse(response.json());
    expect(data).toMatchObject({
      mode: 'PAPER',
      survivalHours: null,
      compute: { purchaseImplemented: false, inferenceCostUsdMicros: '100' },
    });
    expect(data.treasury.balanceAtoms).toBe((await store.balance()).toString());
    expect(data.history.at(-1)?.balanceAtoms).toBe(data.treasury.balanceAtoms);
    expect(data.decisions.length).toBeGreaterThan(0);
    expect(data.transactions.length).toBeGreaterThan(0);
    expect(data.receipts).toEqual([
      expect.objectContaining({
        cycleId: cycle.id,
        mintedOnChain: false,
        status: 'SIMULATED',
        grossPnlAtoms: '100000',
        approvedNetPnlAtoms: null,
      }),
    ]);
    expect(BigInt(data.cursor)).toBeGreaterThanOrEqual(BigInt(data.events[0]!.seq));
    for (const value of [
      'PRIVATE_PROMPT_SENTINEL',
      'PRIVATE_EVENT_SENTINEL',
      'PRIVATE_EVIDENCE_SENTINEL',
      config.READ_TOKEN,
      config.ADMIN_TOKEN,
    ])
      expect(response.body).not.toContain(value);
  } finally {
    await app.close();
  }
});

it('fails closed for LIVE and REPLAY even with valid read credentials', async () => {
  for (const mode of ['LIVE', 'REPLAY'] as const) {
    const app = await createApp(new Store(db, { ...config, EXECUTION_MODE: mode }));
    try {
      for (const path of ['/api/viewer/snapshot', `/api/viewer/proof?hash=${'a'.repeat(64)}`])
        expect((await app.inject({ url: path, headers })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  }
});
it('requires read authorization for separate testnet evidence and refuses other runtime modes', async () => {
  const app = await createApp(store);
  try {
    expect((await app.inject('/api/viewer/testnet')).statusCode).toBe(401);
    const response = await app.inject({ url: '/api/viewer/testnet', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(TestnetReport.parse(response.json())).toMatchObject({
      profile: 'TESTNET_REHEARSAL',
      network: 'testnet',
      mainnetTransactions: 0,
      paidInferenceRequests: 0,
      settlement: 'SIMULATED',
    });
    expect(response.body).not.toContain(config.READ_TOKEN);
    expect(response.body).not.toContain(config.ADMIN_TOKEN);
  } finally {
    await app.close();
  }
  for (const mode of ['LIVE', 'REPLAY'] as const) {
    const other = await createApp(new Store(db, { ...config, EXECUTION_MODE: mode }));
    try {
      expect((await other.inject({ url: '/api/viewer/testnet', headers })).statusCode).toBe(403);
      expect((await other.inject('/api/evidence/testnet')).statusCode).toBe(401);
      const historical = await other.inject({ url: '/api/evidence/testnet', headers });
      expect(historical.statusCode).toBe(200);
      expect(historical.headers['cache-control']).toBe('private, no-store');
      expect(TestnetReport.parse(historical.json())).toMatchObject({
        profile: 'TESTNET_REHEARSAL',
        network: 'testnet',
        mainnetTransactions: 0,
        paidInferenceRequests: 0,
        settlement: 'SIMULATED',
        economics: 'SIMULATED',
      });
      expect(historical.body).not.toContain(config.READ_TOKEN);
      expect(historical.body).not.toContain(config.ADMIN_TOKEN);
    } finally {
      await other.close();
    }
  }
});

it('does not pass simulations off as verified inference and rejects unbounded lookup input', async () => {
  const app = await createApp(store);
  try {
    expect(
      (await app.inject({ url: `/api/viewer/proof?hash=${'a'.repeat(64)}`, headers })).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: '/api/viewer/proof?hash=invalid', headers })).statusCode).toBe(
      400,
    );
    expect(
      (
        await app.inject({
          url: `/api/viewer/proof?hash=${'a'.repeat(64)}&url=https://example.com`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

it('publishes cycle economics, budgets and replay cursors without private JSON', async () => {
  const { cycle } = await store.createCycle(
    {
      strategy: 'round-trip',
      originChain: 'near:paper',
      destinationChain: 'eip155:31337',
      originAsset: 'USDC',
      intermediateAsset: 'WNEAR',
      amountAtoms: '5000000',
      recipient: 'paper.treasury',
      refundTo: 'paper.treasury',
      slippageBps: 50,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    randomUUID(),
  );
  const engine = new Engine(store, new PaperProviders());
  for (let i = 0; i < 12; i++) await engine.tick();
  await db.decision.updateMany({ data: { details: { prompt: 'PRIVATE_DETAIL_SENTINEL' } } });
  await db.outboxEvent.updateMany({ data: { payload: { secret: 'PRIVATE_EVENT_SENTINEL' } } });
  const app = await createApp(store);
  try {
    for (const path of [
      '/api/viewer/status',
      '/api/viewer/cycles',
      `/api/viewer/cycles/${cycle.id}`,
      '/api/viewer/events?after=0',
    ]) {
      expect((await app.inject(path)).statusCode).toBe(401);
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      for (const secret of [
        'PRIVATE_DETAIL_SENTINEL',
        'PRIVATE_EVENT_SENTINEL',
        config.READ_TOKEN,
        config.ADMIN_TOKEN,
      ])
        expect(response.body).not.toContain(secret);
    }
    const detail = (await app.inject({ url: `/api/viewer/cycles/${cycle.id}`, headers })).json();
    expect(detail.cycle.state).toBe('CLOSED');
    expect(detail.economics.grossTradingPnlAtoms).toBe('100000');
    expect(detail.economics.netAfterApprovedCostsAtoms).toBeNull();
    expect(detail.profitCheck.realized).toBe(false);
    expect(detail.jobs.length).toBeGreaterThan(0);
    expect(detail).not.toHaveProperty('settlement');
    expect(detail).not.toHaveProperty('assessment');
    const events = (await app.inject({ url: '/api/viewer/events?after=0', headers })).json();
    expect(events.events.length).toBeGreaterThan(0);
    const next = (
      await app.inject({ url: `/api/viewer/events?after=${events.cursor}`, headers })
    ).json();
    expect(next.events).toEqual([]);
    expect(next.cursor).toBe(events.cursor);
    expect((await app.inject({ url: '/api/viewer/events?after=-1', headers })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ url: '/api/viewer/cycles/not-a-uuid', headers })).statusCode).toBe(
      400,
    );
    for (const mode of ['LIVE', 'REPLAY'] as const) {
      const other = await createApp(new Store(db, { ...config, EXECUTION_MODE: mode }));
      try {
        for (const path of [
          '/api/viewer/status',
          '/api/viewer/cycles',
          `/api/viewer/cycles/${cycle.id}`,
          '/api/viewer/events',
        ])
          expect((await other.inject({ url: path, headers })).statusCode).toBe(403);
      } finally {
        await other.close();
      }
    }
  } finally {
    await app.close();
  }
});

it('checks an operator mode binding before any administrative mutation', async () => {
  const app = await createApp(store);
  try {
    const before = await db.policy.findUniqueOrThrow({ where: { mode: 'PAPER' } });
    const response = await app.inject({
      url: '/api/admin/pause',
      method: 'POST',
      headers: { authorization: `Bearer ${config.ADMIN_TOKEN}`, 'x-symbio-expected-mode': 'LIVE' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('MODE_CHANGED');
    const after = await db.policy.findUniqueOrThrow({ where: { mode: 'PAPER' } });
    expect(after.revision).toBe(before.revision);
    expect(after.paused).toBe(before.paused);
    const live = await createApp(new Store(db, { ...config, EXECUTION_MODE: 'LIVE' }));
    try {
      expect(
        (
          await live.inject({
            url: '/api/admin/pause',
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.ADMIN_TOKEN}`,
              'x-symbio-expected-mode': 'PAPER',
            },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await live.close();
    }
  } finally {
    await app.close();
  }
});
