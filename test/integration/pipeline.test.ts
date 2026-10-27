import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store, json } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { PaperProviders } from '../../src/providers/paper.js';
import { createApp } from '../../src/app.js';
import type { PreparedExecution } from '../../src/domain.js';
import { Proposal } from '../../src/domain.js';

const testUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(testUrl).pathname.endsWith('_test'))
  throw new Error('Integration tests require a dedicated *_test database');
const config = loadConfig({
  ...process.env,
  DATABASE_URL: testUrl,
  EXECUTION_MODE: 'PAPER',
  LOG_LEVEL: 'silent',
});
const db = createDatabase(testUrl);
const store = new Store(db, config);
const proposal = () => ({
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
});
async function drain(engine: Engine, n = 16) {
  for (let i = 0; i < n; i++) await engine.tick();
}
beforeAll(async () => {
  await db.$connect();
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Cycle", "Decision", "Proof", "ChainTransaction", "Policy", "Reservation", "Journal", "Posting", "ComputeUsage", "Job", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
  await store.fundPaper(20_000_000n, 'initial-test-capital');
});
afterAll(async () => {
  await db.$disconnect();
});

describe('durable agent pipeline', () => {
  it('deduplicates concurrent creation under one idempotency key', async () => {
    const p = proposal(),
      key = randomUUID();
    const results = await Promise.all([store.createCycle(p, key), store.createCycle(p, key)]);
    expect(results[0].cycle.id).toBe(results[1].cycle.id);
    expect(await db.cycle.count()).toBe(1);
    expect(await db.job.count()).toBe(1);
  });
  it('fences a stale worker after another worker acquires its expired lease', async () => {
    const p = Proposal.parse(proposal()),
      { cycle } = await store.createCycle(p, randomUUID());
    const first = await store.claim(['SCOUT']);
    expect(first).not.toBeNull();
    await db.job.update({ where: { id: first!.id }, data: { leaseUntil: new Date(0) } });
    const second = await store.claim(['SCOUT']);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    const quote = await new PaperProviders().quote(cycle.id, p);
    await expect(
      store.advance(first!, 'DISCOVERED', 'QUOTED', { quote: json(quote) }, {}, 'BRAIN'),
    ).rejects.toThrow('no longer owns');
    expect(await store.renew(first!)).toBe(false);
    await store.advance(second!, 'DISCOVERED', 'QUOTED', { quote: json(quote) }, {}, 'BRAIN');
    expect((await store.getCycle(cycle.id)).version).toBe(1);
  });
  it('rejects mutation of a previously posted funding journal', async () => {
    await expect(store.fundPaper(21_000_000n, 'initial-test-capital')).rejects.toThrow(
      'different economic terms',
    );
    expect(await store.balance()).toBe(20_000_000n);
  });
  it('closes a complete cycle with balanced journals, explicit simulated evidence and released reservations', async () => {
    const { cycle } = await store.createCycle(proposal(), randomUUID());
    await drain(new Engine(store, new PaperProviders()));
    expect((await store.getCycle(cycle.id)).state).toBe('CLOSED');
    const proofs = await db.proof.findMany({ where: { cycleId: cycle.id } });
    expect(proofs.every((p) => p.status === 'SIMULATED')).toBe(true);
    expect(await db.reservation.count({ where: { cycleId: cycle.id, status: 'ACTIVE' } })).toBe(0);
    const journals = await db.journal.findMany({ include: { postings: true } });
    for (const j of journals)
      expect(j.postings.reduce((a, p) => a + BigInt(p.amountAtoms.toFixed(0)), 0n)).toBe(0n);
    expect(await db.computeUsage.count()).toBe(1);
    expect((await store.snapshot()).mode).toBe('PAPER');
  });
  it('deduplicates requests and rejects mutation under the same key', async () => {
    const p = proposal(),
      key = randomUUID();
    const a = await store.createCycle(p, key),
      b = await store.createCycle(p, key);
    expect(a.cycle.id).toBe(b.cycle.id);
    expect(b.created).toBe(false);
    await expect(store.createCycle({ ...p, amountAtoms: '4000000' }, key)).rejects.toThrow(
      'another proposal',
    );
    expect(await db.job.count()).toBe(1);
  });
  it('prevents competing workers from spending the same reservation twice', async () => {
    const { cycle } = await store.createCycle(proposal(), randomUUID());
    const providers = new PaperProviders();
    let broadcasts = 0;
    const original = providers.broadcast.bind(providers);
    providers.broadcast = async (tx) => {
      broadcasts++;
      await original(tx);
    };
    const a = new Engine(store, providers),
      b = new Engine(store, providers);
    for (let i = 0; i < 12; i++) await Promise.all([a.tick(), b.tick()]);
    expect((await store.getCycle(cycle.id)).state).toBe('CLOSED');
    expect(broadcasts).toBe(1);
    expect(await db.journal.count({ where: { reference: `settlement:${cycle.id}` } })).toBe(1);
  });
  it('reconciles a lost broadcast confirmation using persisted identity without preparing another transfer', async () => {
    const providers = new PaperProviders();
    let prepares = 0;
    const original = providers.prepare.bind(providers);
    providers.prepare = async (...args) => {
      prepares++;
      return original(...args);
    };
    providers.broadcast = async () => {
      throw new Error('Confirmation lost after acceptance');
    };
    const { cycle } = await store.createCycle(proposal(), randomUUID());
    await drain(new Engine(store, providers));
    expect((await store.getCycle(cycle.id)).state).toBe('CLOSED');
    expect(prepares).toBe(1);
    expect(await db.decision.count({ where: { cycleId: cycle.id, action: 'UNKNOWN' } })).toBe(1);
  });
  it('rechecks recipient restrictions after assessment', async () => {
    const { cycle } = await store.createCycle(proposal(), randomUUID());
    const engine = new Engine(store, new PaperProviders());
    await engine.tick();
    await engine.tick();
    await db.policy.update({
      where: { mode: 'PAPER' },
      data: { allowedRecipients: ['another.recipient'] },
    });
    await drain(engine);
    expect((await store.getCycle(cycle.id)).state).toBe('REJECTED');
    expect(await db.reservation.count()).toBe(0);
  });
  it('retains financial reserves during an unknown settlement outcome', async () => {
    const providers = new PaperProviders();
    providers.settle = async () => ({
      status: 'UNKNOWN',
      receivedAtoms: '0',
      feesAtoms: '0',
      transactions: [],
      evidence: {},
    });
    const { cycle } = await store.createCycle(proposal(), randomUUID());
    await drain(new Engine(store, providers));
    expect((await store.getCycle(cycle.id)).state).toBe('SETTLING');
    expect(await db.reservation.count({ where: { status: 'ACTIVE' } })).toBe(1);
    expect(await db.journal.count({ where: { kind: 'TRADING_RESULT' } })).toBe(0);
  });
  it('rejects a malicious model decision bound to a different transaction', async () => {
    const providers = new PaperProviders(),
      original = providers.assess.bind(providers);
    providers.assess = async (...args) => {
      const r = await original(...args);
      r.assessment.proposalDigest = '0'.repeat(64);
      return r;
    };
    const { cycle } = await store.createCycle(proposal(), randomUUID());
    await drain(new Engine(store, providers));
    expect((await store.getCycle(cycle.id)).rejection).toContain('ASSESSMENT_BINDING_MISMATCH');
  });
});

describe('frontend API and WebSocket contract', () => {
  it('updates policy only at the expected revision without admitting an impossible cap', async () => {
    const app = await createApp(store);
    try {
      const headers = { authorization: `Bearer ${config.ADMIN_TOKEN}` };
      const good = await app.inject({
        method: 'POST',
        url: '/api/admin/policy',
        headers,
        payload: { expectedRevision: 1, maxTradeAtoms: '5000000' },
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().revision).toBe(2);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/admin/policy',
            headers,
            payload: { expectedRevision: 1, maxTradeAtoms: '4000000' },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/admin/policy',
            headers,
            payload: { expectedRevision: 2, maxDailySpendAtoms: '1' },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('authenticates reads and writes, bounds input, and redacts encrypted evidence', async () => {
    const app = await createApp(store);
    await app.ready();
    try {
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/swarm' })).statusCode).toBe(401);
      const headers = { authorization: `Bearer ${config.READ_TOKEN}` };
      expect((await app.inject({ url: '/api/swarm', headers })).json().mode).toBe('PAPER');
      expect(
        (await app.inject({ method: 'POST', url: '/api/admin/pause', headers })).statusCode,
      ).toBe(401);
      const response = await app.inject({
        method: 'POST',
        url: '/api/cycles',
        headers: { authorization: `Bearer ${config.ADMIN_TOKEN}`, 'idempotency-key': randomUUID() },
        payload: proposal(),
      });
      expect(response.statusCode).toBe(201);
      await drain(new Engine(store, new PaperProviders()));
      const result = await app.inject({ url: `/api/cycles/${response.json().id}`, headers });
      expect(result.body).not.toContain('evidenceCiphertext');
      expect(result.json().state).toBe('CLOSED');
      expect((await app.inject({ url: '/api/events?limit=10000', headers })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('replays persisted events after a WebSocket reconnect', async () => {
    const app = await createApp(store);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const read = async (after: string) =>
      new Promise<Array<{ seq: string }>>((resolve, reject) => {
        const ws = new WebSocket(url.replace('http:', 'ws:') + '/ws');
        const events: Array<{ seq: string }> = [];
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket timeout'));
        }, 5000);
        ws.on('open', () =>
          ws.send(JSON.stringify({ type: 'subscribe', token: config.READ_TOKEN, after })),
        );
        ws.on('message', (data) => {
          const e = JSON.parse(data.toString());
          if (e.type === 'event') {
            events.push(e);
            clearTimeout(timer);
            ws.close();
            resolve(events);
          }
        });
        ws.on('error', reject);
      });
    try {
      const first = await read('0');
      expect(first.length).toBeGreaterThan(0);
      await store.createCycle(proposal(), randomUUID());
      const second = await read(first.at(-1)!.seq);
      expect(BigInt(second[0]!.seq)).toBeGreaterThan(BigInt(first.at(-1)!.seq));
    } finally {
      await app.close();
    }
  });
});
