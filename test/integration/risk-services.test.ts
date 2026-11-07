import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { PaperProviders } from '../../src/providers/paper.js';
import { businessStatus, receiveInvoice } from '../../src/business.js';
import { createRiskService, riskReport, simulateServicePayment } from '../../src/risk-services.js';
import { DomainError, Proposal } from '../../src/domain.js';
import type { Fetch } from '../../src/providers/http.js';

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
  BUSINESS_RELATED_ACCOUNTS: 'team.near',
  LIVE_ARBITRAGE_ENABLED: 'false',
});
const db = createDatabase(url),
  paper = new Store(db, config);
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "BusinessEntry", "Cycle", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await paper.initialize();
});
afterAll(async () => db.$disconnect());
function order(relationship = 'EXTERNAL_ATTESTED') {
  return {
    reference: `audit:${randomUUID()}`,
    payer: relationship === 'TEAM_DEMO' ? 'team.near' : 'customer.near',
    customerRelationship: relationship,
    agreedTermsDigest: 'a'.repeat(64),
    priceAtoms: '1000000',
    proposal: {
      strategy: 'risk-assessment',
      originChain: 'near:paper',
      destinationChain: 'eip155:31337',
      originAsset: 'USDC',
      intermediateAsset: 'WNEAR',
      amountAtoms: '10000000',
      recipient: 'paper.treasury',
      refundTo: 'paper.treasury',
      slippageBps: 50,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
  };
}
const h = (n: number) => bs58.encode(Buffer.alloc(32, n));
function receipt(payer: string): Fetch {
  const event = (standard: string, version: string, name: string, data: unknown[]) =>
    'EVENT_JSON:' + JSON.stringify({ standard, version, event: name, data });
  return async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    return Response.json({
      result:
        method === 'status'
          ? { chain_id: 'mainnet' }
          : method === 'block'
            ? {
                header: {
                  hash: h(4),
                  timestamp_nanosec: String(BigInt(Date.now() + 1000) * 1000000n),
                },
              }
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
                      logs: [
                        event('dip4', '0.4.3', 'transfer', [
                          {
                            intent_hash: h(3),
                            account_id: payer,
                            receiver_id: 'business.near',
                            tokens: { 'nep141:usdc.near': '1000000' },
                          },
                        ]),
                        event('dip4', '0.4.3', 'intents_executed', [
                          { intent_hash: h(3), account_id: payer },
                        ]),
                        event('nep245', '1.0.0', 'mt_transfer', [
                          {
                            old_owner_id: payer,
                            new_owner_id: 'business.near',
                            token_ids: ['nep141:usdc.near'],
                            amounts: ['1000000'],
                          },
                        ]),
                      ],
                    },
                  },
                ],
              },
    });
  };
}
it('delivers a prepaid negative risk report without trading, minting or claiming PAPER revenue', async () => {
  const input = order(),
    entry = await createRiskService(paper, input),
    cycleId = (entry.payload as { cycleId: string }).cycleId;
  expect((await createRiskService(paper, input)).id).toBe(entry.id);
  const providers = new PaperProviders();
  const originalQuote = providers.quote.bind(providers),
    originalAssess = providers.assess.bind(providers);
  vi.spyOn(providers, 'quote').mockImplementation(async (id, p) => ({
    ...(await originalQuote(id, p)),
    expectedOutputAtoms: '9840294',
    minimumOutputAtoms: '9800000',
  }));
  const assessments = vi.spyOn(providers, 'assess').mockImplementation(async (id, p, q) => {
    const result = await originalAssess(id, p, q);
    return { ...result, assessment: { ...result.assessment, execute: false } };
  });
  const prepares = vi.spyOn(providers, 'prepare');
  const engine = new Engine(paper, providers);
  await engine.tick(['SCOUT']);
  expect((await paper.getCycle(cycleId)).state).toBe('QUOTED');
  await engine.tick(['BRAIN']);
  expect(assessments).not.toHaveBeenCalled();
  expect(await db.computeUsage.count()).toBe(0);
  await simulateServicePayment(paper, input.reference);
  await db.job.updateMany({ where: { cycleId, doneAt: null }, data: { availableAt: new Date(0) } });
  await engine.tick(['BRAIN']);
  await engine.tick(['HAND']);
  expect((await paper.getCycle(cycleId)).state).toBe('CLOSED');
  expect(await riskReport(paper, input.reference)).toMatchObject({
    simulated: true,
    executionAuthorized: false,
    assurance: 'LOCAL_SIMULATION',
    deterministicRiskFlags: expect.arrayContaining(['INSUFFICIENT_NET_PROFIT', 'MODEL_REJECTED']),
  });
  expect(prepares).not.toHaveBeenCalled();
  expect(await db.chainTransaction.count()).toBe(0);
  expect(await db.proof.count({ where: { kind: 'EXECUTION_RECEIPT' } })).toBe(0);
  expect(await businessStatus(paper)).toMatchObject({
    confirmedReceiptCount: 0,
    revenueAtoms: '0',
  });
  await expect(
    providers.prepare(
      cycleId,
      Proposal.parse(input.proposal),
      await providers.quote(cycleId, Proposal.parse(input.proposal)),
    ),
  ).rejects.toMatchObject({ code: 'SERVICE_CANNOT_TRADE' });
});

it.each(['EXTERNAL_ATTESTED', 'TEAM_DEMO'])(
  'recognizes %s payments only according to delivery and relationship (injected evidence)',
  async (relationship) => {
    // Every RPC response, signature status and usage value in this test is injected; no mainnet/TEE claim.
    const live = new Store(db, { ...config, EXECUTION_MODE: 'LIVE', NEAR_NETWORK: 'mainnet' });
    await live.initialize();
    const input = order(relationship),
      entry = await createRiskService(live, input),
      cycleId = (entry.payload as { cycleId: string }).cycleId;
    await receiveInvoice(
      live,
      input.reference,
      { txHash: h(1), senderId: 'relayer.near' },
      receipt(input.payer),
    );
    expect((await businessStatus(live)).revenueAtoms).toBe('0');
    const providers = new PaperProviders(),
      originalAssess = providers.assess.bind(providers);
    vi.spyOn(providers, 'assess').mockImplementation(async (id, p, q) => {
      const result = await originalAssess(id, p, q);
      return { ...result, proof: { ...result.proof, kind: 'NEAR_AI', status: 'VERIFIED' } };
    });
    const prepare = vi.spyOn(providers, 'prepare');
    const engine = new Engine(live, providers);
    for (let i = 0; i < 3; i++) await engine.tick();
    expect((await live.getCycle(cycleId)).state).toBe('CLOSED');
    expect((await businessStatus(live)).revenueAtoms).toBe(
      relationship === 'EXTERNAL_ATTESTED' ? '1000000' : '0',
    );
    expect(await db.businessEntry.count({ where: { kind: 'SERVICE_PAYMENT' } })).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    await expect(simulateServicePayment(live, input.reference)).rejects.toMatchObject({
      code: 'PAPER_ONLY',
    });
  },
);

it('TEE quarantine holds prepaid delivery and known team payers cannot become external revenue', async () => {
  const live = new Store(db, { ...config, EXECUTION_MODE: 'LIVE', NEAR_NETWORK: 'mainnet' });
  await live.initialize();
  await expect(createRiskService(live, { ...order(), payer: 'team.near' })).rejects.toMatchObject({
    code: 'RELATED_PARTY',
  });
  const input = order(),
    entry = await createRiskService(live, input),
    cycleId = (entry.payload as { cycleId: string }).cycleId;
  await receiveInvoice(
    live,
    input.reference,
    { txHash: h(1), senderId: 'relayer.near' },
    receipt(input.payer),
  );
  const providers = new PaperProviders();
  vi.spyOn(providers, 'assess').mockRejectedValue(
    new DomainError('TEE_DEPLOYMENT_UNAPPROVED', 'Quarantined fixture'),
  );
  const engine = new Engine(live, providers);
  await engine.tick(['SCOUT']);
  await engine.tick(['BRAIN']);
  expect((await live.getCycle(cycleId)).state).toBe('QUOTED');
  expect((await businessStatus(live)).revenueAtoms).toBe('0');
  await expect(riskReport(live, input.reference)).rejects.toMatchObject({
    code: 'SERVICE_REPORT_PENDING',
  });
  expect(await db.computeUsage.count()).toBe(0);
  expect(await db.liveLeg.count()).toBe(0);
});
