import { afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { createApp } from '../../src/app.js';
import { Engine } from '../../src/engine.js';
import { PaperProviders } from '../../src/providers/paper.js';
import { ViewerSnapshot } from '../../src/viewer-contract.js';

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
