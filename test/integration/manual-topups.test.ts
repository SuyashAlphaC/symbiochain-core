import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { digest } from '../../src/domain.js';
import { businessStatus } from '../../src/business.js';
import {
  tickManualTopups,
  reportManualTopup,
  manualTopupTasks,
  operatingStatus,
} from '../../src/manual-topups.js';
import { createApp } from '../../src/app.js';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
const config = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  LOG_LEVEL: 'silent',
  BUSINESS_RECEIVER_ID: 'business.near',
  BUSINESS_INTENTS_ASSET: 'nep141:usdc.near',
});
const db = createDatabase(url),
  store = new Store(db, config);
const budget = { maxSpendAtoms: '1000000', requestedCreditUsdMicros: '1000000' };
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "BusinessEntry", "Cycle", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
});
afterAll(async () => db.$disconnect());
async function fixtureWindow(amount = '2000000') {
  // Injected PAPER accounting fixture; never claimed as real receipts or operating profit.
  return db.businessEntry.create({
    data: {
      id: randomUUID(),
      mode: 'PAPER',
      reference: `fixture:${randomUUID()}`,
      kind: 'COST_WINDOW',
      amountAtoms: amount,
      asset: config.BUSINESS_INTENTS_ASSET,
      termsDigest: digest({ amount }),
      payload: { simulated: true, receiptIds: [], costVerification: 'ACCOUNTANT_REPORTED' },
    },
  });
}

it('only requests manual work after closed positive net and holds reservations across retries', async () => {
  expect(await tickManualTopups(store, budget)).toEqual([]);
  await fixtureWindow('-1000000');
  expect(await tickManualTopups(store, budget)).toEqual([]);
  await fixtureWindow('3000000');
  const runs = await Promise.all([
    tickManualTopups(store, budget),
    tickManualTopups(store, budget),
  ]);
  expect(runs[0]).toEqual(runs[1]);
  expect(await db.businessEntry.count({ where: { kind: 'PROCEEDS_RESERVED' } })).toBe(1);
  expect(await db.businessEntry.count({ where: { kind: 'MANUAL_TOPUP_REQUIRED' } })).toBe(1);
  expect(await db.outboxEvent.count({ where: { topic: 'business.topup_required' } })).toBe(1);
  expect((await manualTopupTasks(new Store(db, config)))[0]).toMatchObject({
    state: 'WAITING_OPERATOR',
    providerVerified: false,
    simulated: true,
  });
});

it('operator reports are immutable, organization-bound and cannot purchase credits or release funds', async () => {
  await fixtureWindow();
  const [task] = await tickManualTopups(store, budget);
  const report = {
    reference: task!.reference,
    organizationId: task!.organizationId,
    receiptDigest: 'a'.repeat(64),
    reportedCreditUsdMicros: '1000000',
    fundingSource: 'OPERATOR_FUNDED',
  };
  await expect(
    reportManualTopup(store, { ...report, organizationId: 'other-org' }),
  ).rejects.toMatchObject({ code: 'TOPUP_ORGANIZATION_MISMATCH' });
  expect(await reportManualTopup(store, report)).toEqual(await reportManualTopup(store, report));
  await expect(
    reportManualTopup(store, { ...report, reportedCreditUsdMicros: '2000000' }),
  ).rejects.toMatchObject({ code: 'BUSINESS_CONFLICT' });
  expect((await tickManualTopups(store, budget))[0]!.state).toBe('OPERATOR_REPORTED_UNVERIFIED');
  expect(await businessStatus(store)).toMatchObject({
    computePurchaseImplemented: false,
    purchasedCreditsUsdMicros: '0',
    confirmedReceiptCount: 0,
    reservedAtoms: '1000000',
  });
  expect(await db.businessEntry.count({ where: { kind: 'PROCEEDS_RELEASED' } })).toBe(0);
  expect(await db.computeAccount.count()).toBe(0);
  expect(await db.inferenceAttempt.count()).toBe(0);
  expect(await db.journal.count()).toBe(0);
  expect((await operatingStatus(store)).tee).toMatchObject({
    status: 'QUARANTINED',
    inferenceGate: 'CLOSED',
    signedInferenceVerified: false,
  });
});

it('private task/report routes require admin; public status omits purchase evidence and organization IDs', async () => {
  await fixtureWindow();
  const [task] = await tickManualTopups(store, budget);
  const app = await createApp(store);
  try {
    const read = { authorization: `Bearer ${config.READ_TOKEN}` },
      admin = { authorization: `Bearer ${config.ADMIN_TOKEN}` };
    expect(
      (await app.inject({ url: '/api/business/compute-topups', headers: read })).statusCode,
    ).toBe(401);
    const report = {
      reference: task!.reference,
      organizationId: task!.organizationId,
      receiptDigest: 'b'.repeat(64),
      reportedCreditUsdMicros: '1000000',
      fundingSource: 'EARNED_PROCEEDS_REPORTED',
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/business/compute-topups/report',
          headers: read,
          payload: report,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/business/compute-topups/report',
          headers: admin,
          payload: report,
        })
      ).statusCode,
    ).toBe(200);
    const status = await app.inject({ url: '/api/operations/status', headers: read });
    expect(status.statusCode).toBe(200);
    expect(status.json().bridge).toMatchObject({
      operatorReported: 1,
      providerVerifiedPurchases: 0,
      automaticPurchasesEnabled: false,
    });
    expect(status.body).not.toContain(task!.organizationId);
    expect(status.body).not.toContain(report.receiptDigest);
    expect(
      (await app.inject({ method: 'POST', url: '/api/business/compute-purchases', headers: admin }))
        .statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});

it('missing mainnet organization fails before reserving proceeds', async () => {
  const live = new Store(db, {
    ...config,
    EXECUTION_MODE: 'LIVE',
    NEAR_NETWORK: 'mainnet',
    NEAR_AI_ORG_ID: '',
  });
  await expect(tickManualTopups(live, budget)).rejects.toMatchObject({
    code: 'TOPUP_ORGANIZATION_REQUIRED',
  });
  expect(await db.businessEntry.count()).toBe(0);
});

it('new losses hold repeat alerts without releasing the existing reservation', async () => {
  await fixtureWindow();
  expect(await tickManualTopups(store, budget)).toHaveLength(1);
  await fixtureWindow('-2000000');
  expect(await tickManualTopups(store, budget)).toEqual([]);
  expect(await db.businessEntry.count({ where: { kind: 'PROCEEDS_RELEASED' } })).toBe(0);
});
