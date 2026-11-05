import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../../src/db.js';
import { loadConfig } from '../../src/config.js';
import { Store } from '../../src/store.js';
import { createApp } from '../../src/app.js';
import {
  issueFeeInvoice,
  receiveInvoice,
  closeBusinessWindow,
  reserveProceeds,
  businessStatus,
} from '../../src/business.js';
import type { Fetch } from '../../src/providers/http.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
const paper = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  LOG_LEVEL: 'silent',
  BUSINESS_RECEIVER_ID: 'business.near',
  BUSINESS_INTENTS_ASSET: 'nep141:usdc.near',
});
const db = createDatabase(url);
// Only the accounting mode is injected: no live provider, credentials or real RPC is constructed.
const store = new Store(db, { ...paper, EXECUTION_MODE: 'LIVE', NEAR_NETWORK: 'mainnet' });
const zero = { compute: '0', gas: '0', hosting: '0', venue: '0', other: '0' };
const h = (n: number) => bs58.encode(Buffer.alloc(32, n));
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "BusinessEntry", "Cycle", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => db.$disconnect());
async function invoice(ref: string, net = 1000, payer = 'customer.near') {
  const proposal = {
    strategy: 'round-trip',
    originChain: 'eip155:8453',
    destinationChain: 'solana:mainnet',
    originAsset: 'USDC',
    intermediateAsset: 'SOL',
    amountAtoms: '10000',
    recipient: 'business.near',
    refundTo: 'business.near',
    slippageBps: 50,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const cycle = await db.cycle.create({
    data: {
      mode: 'LIVE',
      idempotencyKey: randomUUID(),
      strategy: 'round-trip',
      state: 'CLOSED',
      expiresAt: new Date(proposal.expiresAt),
      proposal,
      settlement: {
        status: 'SUCCESS',
        receivedAtoms: String(10000 + net),
        feesAtoms: '0',
        transactions: [],
        evidence: {},
      },
    },
  });
  return issueFeeInvoice(store, {
    reference: ref,
    cycleId: cycle.id,
    payer,
    agreedTermsDigest: 'a'.repeat(64),
    realizedCosts: zero,
    inferenceCostUsdMicros: '0',
    costSources: ['local accounting fixture'],
    approvedBy: 'fixture accountant',
    costsComplete: true,
  });
}
function receipt(amount = '150', payer = 'customer.near') {
  const event = (standard: string, version: string, name: string, data: unknown[]) =>
    'EVENT_JSON:' + JSON.stringify({ standard, version, event: name, data });
  const events = [
    event('dip4', '0.4.3', 'transfer', [
      {
        intent_hash: h(3),
        account_id: payer,
        receiver_id: 'business.near',
        tokens: { 'nep141:usdc.near': amount },
      },
    ]),
    event('dip4', '0.4.3', 'intents_executed', [{ intent_hash: h(3), account_id: payer }]),
    event('nep245', '1.0.0', 'mt_transfer', [
      {
        old_owner_id: payer,
        new_owner_id: 'business.near',
        token_ids: ['nep141:usdc.near'],
        amounts: [amount],
      },
    ]),
  ];
  const timestamp = String(BigInt(Date.now() + 1000) * 1000000n);
  const fetch: Fetch = async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        result:
          method === 'status'
            ? { chain_id: 'mainnet' }
            : method === 'block'
              ? { header: { hash: h(4), timestamp_nanosec: timestamp } }
              : {
                  final_execution_status: 'FINAL',
                  transaction: { hash: h(1), receiver_id: 'intents.near' },
                  status: { SuccessValue: '' },
                  transaction_outcome: { outcome: { status: { SuccessReceiptId: h(2) } } },
                  receipts_outcome: [
                    {
                      id: h(2),
                      block_hash: h(4),
                      outcome: {
                        executor_id: 'intents.near',
                        status: { SuccessValue: '' },
                        logs: events,
                      },
                    },
                  ],
                },
      }),
    );
  };
  return fetch;
}
const pay = { txHash: h(1), senderId: 'relayer.near' };
const window = (reference: string) => ({
  reference,
  from: '2026-01-01T00:00:00.000Z',
  through: new Date(Date.now()).toISOString(),
  realizedCosts: { ...zero, hosting: '50' },
  costSources: ['hosting invoice fixture'],
  inferenceCostUsdMicros: '0',
  approvedBy: 'fixture accountant',
  costsComplete: true,
});
it('records actual receipt evidence once, excludes invoiced revenue and reserves only after costs', async () => {
  const inv = await invoice('fee1');
  expect(inv.amountAtoms.toFixed(0)).toBe('150');
  expect((await businessStatus(store)).revenueAtoms).toBe('0');
  const transport = receipt();
  const paid = await receiveInvoice(store, 'fee1', pay, transport);
  expect((await receiveInvoice(store, 'fee1', pay, transport)).id).toBe(paid.id);
  expect((await businessStatus(store)).revenueAtoms).toBe('150');
  const data = window('november');
  const w = await closeBusinessWindow(store, data);
  expect(w.amountAtoms.toFixed(0)).toBe('100');
  expect((await closeBusinessWindow(store, data)).id).toBe(w.id);
  const budget = {
    reference: 'nft-budget',
    windowReference: 'november',
    purpose: 'NFT_DISTRIBUTION',
    amountAtoms: '80',
  };
  const reservation = await reserveProceeds(store, budget);
  expect((await reserveProceeds(store, budget)).id).toBe(reservation.id);
  expect(reservation.payload).toMatchObject({ state: 'RESERVED_NOT_PAID' });
  await expect(
    reserveProceeds(store, {
      ...budget,
      reference: 'compute-budget',
      purpose: 'COMPUTE_PURCHASE',
      amountAtoms: '30',
    }),
  ).rejects.toThrow('Recover operating losses');
  expect(await db.journal.count({ where: { kind: 'EXTERNAL_BUSINESS_REVENUE' } })).toBe(1);
  expect(await businessStatus(store)).toMatchObject({
    revenueAtoms: '150',
    netAfterReportedCostsAtoms: '100',
    reservedAtoms: '80',
    computePurchaseImplemented: false,
    businessFundedNftDistributions: 0,
  });
});
it('rejects cross-invoice receipt reuse and changed immutable terms', async () => {
  const inv = await invoice('fee1');
  const transport = receipt();
  await receiveInvoice(store, 'fee1', pay, transport);
  await invoice('fee2');
  await expect(receiveInvoice(store, 'fee2', pay, transport)).rejects.toThrow('already consumed');
  await expect(
    issueFeeInvoice(store, { ...(inv.payload as object), reference: 'fee1' }),
  ).rejects.toThrow();
});
it('keeps loss recovery out of performance fees and rejects internal payers', async () => {
  expect((await invoice('loss', -1000)).amountAtoms.toFixed(0)).toBe('0');
  expect((await invoice('recovery', 600)).amountAtoms.toFixed(0)).toBe('0');
  expect((await invoice('new-profit', 600)).amountAtoms.toFixed(0)).toBe('30');
  await expect(invoice('internal', 1000, 'business.near')).rejects.toThrow('internal payments');
});
it('rejects overlapping windows, unmetered cost claims and unknown costs', async () => {
  await expect(
    reserveProceeds(store, {
      reference: 'x',
      windowReference: 'missing',
      purpose: 'COMPUTE_PURCHASE',
      amountAtoms: '1',
    }),
  ).rejects.toThrow('full operating-cost');
  await expect(
    closeBusinessWindow(store, { ...window('bad-cost'), inferenceCostUsdMicros: '1' }),
  ).rejects.toThrow('metered inference');
  await closeBusinessWindow(store, window('first'));
  await expect(closeBusinessWindow(store, window('overlap'))).rejects.toThrow('overlap');
});
it('authenticates financial writes and never accepts live receipts against PAPER invoices', async () => {
  const paperStore = new Store(db, paper),
    app = await createApp(paperStore);
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/api/business/invoices', payload: {} })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: '/api/business/status' })).statusCode).toBe(401);
    const state = await app.inject({
      url: '/api/business/status',
      headers: { authorization: `Bearer ${paper.READ_TOKEN}` },
    });
    expect(state.json()).toMatchObject({ simulated: true, revenueAtoms: '0' });
    await expect(receiveInvoice(paperStore, 'x', pay)).rejects.toThrow('PAPER invoices');
  } finally {
    await app.close();
  }
});
it('serializes competing proceeds reservations without double-spending', async () => {
  await invoice('fee');
  await receiveInvoice(store, 'fee', pay, receipt());
  await closeBusinessWindow(store, window('costs'));
  const reservations = await Promise.allSettled(
    ['a', 'b'].map((reference) =>
      reserveProceeds(store, {
        reference,
        windowReference: 'costs',
        purpose: 'NFT_DISTRIBUTION',
        amountAtoms: '75',
      }),
    ),
  );
  expect(reservations.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await businessStatus(store)).reservedAtoms).toBe('75');
});
it('holds all proceeds while earlier operating losses remain unrecovered', async () => {
  await closeBusinessWindow(store, {
    ...window('prior-loss'),
    from: '2025-01-01T00:00:00.000Z',
    through: '2026-01-01T00:00:00.000Z',
    realizedCosts: { ...zero, hosting: '500' },
  });
  await invoice('fee');
  await receiveInvoice(store, 'fee', pay, receipt());
  await closeBusinessWindow(store, window('current-profit'));
  await expect(
    reserveProceeds(store, {
      reference: 'spend',
      windowReference: 'current-profit',
      purpose: 'COMPUTE_PURCHASE',
      amountAtoms: '1',
    }),
  ).rejects.toThrow('Recover operating losses');
  expect((await businessStatus(store)).netAfterReportedCostsAtoms).toBe('-400');
});
it('rolls back an altered invoice reference and rejects denomination changes', async () => {
  const inv = await invoice('immutable');
  const p = inv.payload as Record<string, unknown>;
  const fields = {
    reference: 'immutable',
    cycleId: p.cycleId,
    payer: p.payer,
    agreedTermsDigest: p.agreedTermsDigest,
    realizedCosts: p.realizedCosts,
    inferenceCostUsdMicros: p.inferenceCostUsdMicros,
    costSources: p.costSources,
    approvedBy: p.approvedBy,
    costsComplete: true,
  };
  expect((await issueFeeInvoice(store, fields)).id).toBe(inv.id);
  await expect(
    issueFeeInvoice(store, { ...fields, realizedCosts: { ...zero, other: '1' } }),
  ).rejects.toThrow('immutable terms');
  const changed = new Store(db, { ...store.config, BUSINESS_INTENTS_ASSET: 'nep141:wrap.near' });
  await expect(closeBusinessWindow(changed, window('bad-asset'))).rejects.toThrow('denomination');
});
it('blocks proceeds when an older inference has an unknown financial outcome', async () => {
  const inv = await invoice('fee');
  await receiveInvoice(store, 'fee', pay, receipt());
  await closeBusinessWindow(store, window('profit'));
  await db.inferenceAttempt.create({
    data: {
      cycleId: (inv.payload as Record<string, string>).cycleId!,
      proposalDigest: 'f'.repeat(64),
      status: 'STARTED',
      evidenceCiphertext: 'unused fixture',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    },
  });
  await expect(
    reserveProceeds(store, {
      reference: 'held',
      windowReference: 'profit',
      purpose: 'NFT_DISTRIBUTION',
      amountAtoms: '1',
    }),
  ).rejects.toThrow('outstanding inference');
  expect((await businessStatus(store)).reservedAtoms).toBe('0');
});
