import { afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { PaperProviders } from '../../src/providers/paper.js';
import { PaperFaultController } from '../../src/paper-faults.js';
import { createApp } from '../../src/app.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required');
const config = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  ENABLE_CHAOS_DEMO: 'true',
  NFT_SHARE_BPS: '100',
  LOG_LEVEL: 'silent',
});
const db = createDatabase(url),
  store = new Store(db, config);
const directory = await mkdtemp(join(tmpdir(), 'symbiochain-operator-test-'));
const faults = new PaperFaultController(config, join(directory, 'fault.json'));
const headers = { authorization: `Bearer ${config.ADMIN_TOKEN}` };
const readHeaders = { authorization: `Bearer ${config.READ_TOKEN}` };
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

beforeEach(async () => {
  await rm(faults.file, { force: true });
  await db.$executeRawUnsafe(
    'TRUNCATE "Cycle", "ServicePayment", "ComputeAccount", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
  await store.fundPaper(20_000_000n, 'operator-test-capital');
});
afterAll(async () => {
  await db.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

it('serves a same-origin dashboard without embedding credentials and enforces administrative access', async () => {
  const app = await createApp(store, { faults });
  try {
    const page = await app.inject('/dashboard');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Arm worker crash');
    expect(page.body).not.toContain(config.ADMIN_TOKEN);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await app.inject('/dashboard.js')).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/capabilities', headers: readHeaders })).json(),
    ).toMatchObject({ admin: false, crashDemoEnabled: true });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/demo/crash-worker',
          headers: readHeaders,
          payload: { cycleId: randomUUID(), role: 'SCOUT' },
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});

it('retains the revenue-rights gate until approval, reports bound net costs, and wakes the receipt job', async () => {
  const { cycle } = await store.createCycle(proposal(), randomUUID());
  const engine = new Engine(store, new PaperProviders());
  for (let i = 0; i < 9; i++) await engine.tick();
  expect((await store.getCycle(cycle.id)).state).toBe('RECONCILED');
  expect(await db.proof.count({ where: { cycleId: cycle.id, kind: 'EXECUTION_RECEIPT' } })).toBe(0);
  const app = await createApp(store);
  try {
    const initial = (
      await app.inject({ url: `/api/cycles/${cycle.id}/economics`, headers: readHeaders })
    ).json();
    expect(initial).toMatchObject({
      status: 'AWAITING_COST_APPROVAL',
      grossTradingPnlAtoms: '100000',
      netAfterApprovedCostsAtoms: null,
      requestedShareBps: 100,
    });
    const costs = {
      settlementDigest: initial.settlementDigest,
      inferenceCostUsdMicros: '100',
      computeBaseAtoms: '100',
      nativeGasBaseAtoms: '1000',
      hostingBaseAtoms: '50',
      otherBaseAtoms: '0',
      receiptBudgetBaseAtoms: '500',
      approvedBy: 'test-accountant',
      sourceEvidence: {
        nativeFeeEvidenceDigest: initial.nativeFeeEvidenceDigest,
        valuationMethod: 'Synthetic operator test costs, not real provider invoices',
        references: ['paper:operator-test'],
        includesNearGasAndHosting: true,
      },
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/admin/cycles/${cycle.id}/cost-basis`,
          headers: readHeaders,
          payload: costs,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/admin/cycles/${cycle.id}/cost-basis`,
          headers,
          payload: costs,
        })
      ).statusCode,
    ).toBe(200);
    await engine.tick();
    expect((await store.getCycle(cycle.id)).state).toBe('CLOSED');
    const result = (
      await app.inject({ url: `/api/cycles/${cycle.id}/economics`, headers: readHeaders })
    ).json();
    expect(result).toMatchObject({
      status: 'ACCOUNTANT_APPROVED',
      totalApprovedCostAtoms: '1650',
      settlementFeesAtoms: '1000',
      totalCostsIncludingSettlementFeesAtoms: '2650',
      netAfterApprovedCostsAtoms: '97350',
      simulated: true,
      independentlyVerifiedCosts: false,
      includesFinalizationBudget: true,
      survivalHours: null,
    });
    const proof = await db.proof.findFirstOrThrow({
      where: { cycleId: cycle.id, kind: 'EXECUTION_RECEIPT' },
    });
    expect(proof.publicDetails).toMatchObject({ mintedOnChain: false, simulatedRightsBps: 100 });
    const current = await store.getCycle(cycle.id);
    await db.cycle.update({
      where: { id: cycle.id },
      data: { settlement: { ...(current.settlement as object), receivedAtoms: '99999999' } },
    });
    expect(
      (await app.inject({ url: `/api/cycles/${cycle.id}/economics`, headers: readHeaders }))
        .statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});

it('consumes a targeted crash once and recovers the same expired job without duplicate execution', async () => {
  const { cycle } = await store.createCycle(proposal(), randomUUID());
  await expect(faults.arm(store, cycle.id, 'SCOUT')).rejects.toThrow('Pause');
  await db.workerControl.update({ where: { role: 'SCOUT' }, data: { paused: true } });
  const command = await faults.arm(store, cycle.id, 'SCOUT');
  expect(JSON.parse(await readFile(faults.file, 'utf8'))).toMatchObject(command);
  await expect(faults.arm(store, cycle.id, 'SCOUT')).rejects.toThrow('already armed');
  expect(await faults.cancel(store)).toMatchObject({
    cancelled: true,
    requestId: command.requestId,
  });
  expect(await faults.cancel(store)).toEqual({ cancelled: false });
  await faults.arm(store, cycle.id, 'SCOUT');
  await db.workerControl.update({ where: { role: 'SCOUT' }, data: { paused: false } });
  const job = await store.claim(['SCOUT']);
  expect(job).not.toBeNull();
  let crashes = 0;
  await faults.afterClaim(store, job!, () => {
    crashes++;
  });
  await faults.afterClaim(store, job!, () => {
    crashes++;
  });
  expect(crashes).toBe(1);
  await expect(access(faults.file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await store.claim(['SCOUT'])).toBeNull();
  await db.job.update({ where: { id: job!.id }, data: { leaseUntil: new Date(0) } });
  const engine = new Engine(store, new PaperProviders());
  for (let i = 0; i < 6; i++) await engine.tick();
  expect((await db.job.findUniqueOrThrow({ where: { id: job!.id } })).attempts).toBe(2);
  expect(await db.outboxEvent.count({ where: { topic: 'demo.worker_crash_triggered' } })).toBe(1);
  expect(await db.computeUsage.count({ where: { cycleId: cycle.id } })).toBe(1);
  expect(await db.journal.count({ where: { reference: `settlement:${cycle.id}` } })).toBe(1);
  expect((await store.getCycle(cycle.id)).state).toBe('RECONCILED');
});

it('refuses crash injection when disabled, in LIVE, or through a different cycle mode', async () => {
  for (const other of [
    { ...config, ENABLE_CHAOS_DEMO: false },
    { ...config, EXECUTION_MODE: 'LIVE' as const },
  ]) {
    const otherStore = new Store(db, other),
      controller = new PaperFaultController(other, faults.file);
    const app = await createApp(otherStore, { faults: controller });
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/admin/demo/crash-worker',
            headers,
            payload: { cycleId: randomUUID(), role: 'SCOUT' },
          })
        ).statusCode,
      ).toBe(403);
      await expect(controller.afterClaim(otherStore, {} as never)).rejects.toThrow('PAPER');
    } finally {
      await app.close();
    }
  }
  const { cycle } = await store.createCycle(proposal(), randomUUID());
  await db.cycle.update({ where: { id: cycle.id }, data: { mode: 'LIVE' } });
  await expect(faults.arm(store, cycle.id, 'SCOUT')).rejects.toThrow('not found');
});
