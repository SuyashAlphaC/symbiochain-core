import { randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import {
  queueNftPayout,
  runNftPayout,
  fundingStatus,
  requestComputePurchase,
  cancelUnsubmittedPayout,
} from '../../src/business-funding.js';
import { businessStatus, reserveProceeds } from '../../src/business.js';
import type {
  FundingPorts,
  FundingTerms,
  PreparedFundingCall,
  FinalFundingCall,
  SignedFundingIntent,
} from '../../src/funding-types.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw Error('Dedicated test database required');
const hash = (n: number) => bs58.encode(Buffer.alloc(32, n));
const base = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  LOG_LEVEL: 'silent',
  BUSINESS_RECEIVER_ID: 'business.near',
  BUSINESS_INTENTS_ASSET: 'nep141:usdc.near',
});
// Test-only mode injection. No live SDK, wallet or external HTTP transport is constructed.
const config = {
  ...base,
  EXECUTION_MODE: 'LIVE' as const,
  NEAR_NETWORK: 'mainnet' as const,
  LIVE_TRADING_ENABLED: true,
  BUSINESS_PAYOUTS_ENABLED: true,
  BUSINESS_INTENTS_PRIVATE_KEY: 'unused-test-intents-key',
  BUSINESS_PAYOUT_PRIVATE_KEY: 'unused-test-payout-key',
  NEAR_ACCOUNTANT_ACCOUNT_ID: 'books.near',
  NEAR_CONTRACT_ID: 'treasury.near',
  BUSINESS_TREASURY_CODE_HASH: hash(9),
  BUSINESS_MAX_PAYOUT_ATOMS: '100',
  BUSINESS_DAILY_PAYOUT_ATOMS: '200',
  BUSINESS_MAX_GAS_YOCTO: '1000',
  BUSINESS_MIN_NATIVE_RESERVE_YOCTO: '1000',
};
const db = createDatabase(url),
  store = new Store(db, config);
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "BusinessEntry", "Cycle", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
});
afterAll(async () => db.$disconnect());
async function reservation(reference = 'nft-budget', amount = '100') {
  const r = await db.businessEntry.create({
    data: {
      id: randomUUID(),
      mode: 'LIVE',
      reference: `receipt-${reference}`,
      kind: 'EXTERNAL_RECEIPT',
      asset: config.BUSINESS_INTENTS_ASSET,
      amountAtoms: '1000',
      termsDigest: 'a'.repeat(64),
      sourceKey: `near:mainnet:${randomUUID()}`,
      payload: {},
    },
  });
  await db.businessEntry.create({
    data: {
      id: randomUUID(),
      mode: 'LIVE',
      reference: `window-${reference}`,
      kind: 'COST_WINDOW',
      asset: r.asset,
      amountAtoms: '900',
      termsDigest: 'b'.repeat(64),
      payload: { receiptIds: [r.id] },
    },
  });
  return db.businessEntry.create({
    data: {
      id: randomUUID(),
      mode: 'LIVE',
      reference,
      kind: 'PROCEEDS_RESERVED',
      asset: r.asset,
      amountAtoms: amount,
      termsDigest: 'c'.repeat(64),
      payload: {
        purpose: 'NFT_DISTRIBUTION',
        windowReference: `window-${reference}`,
        state: 'RESERVED_NOT_PAID',
      },
    },
  });
}
function ports(lost = false) {
  let swapped = false;
  const calls = {
    quotes: 0,
    signatures: 0,
    swaps: 0,
    prepare: { WITHDRAW: 0, DISTRIBUTE: 0 },
    sent: [] as string[],
  };
  const finalized = new Map<string, FinalFundingCall>();
  const seen = new Set<string>();
  const adapter: FundingPorts = {
    check: async () => {},
    quote: async (t) => {
      calls.quotes++;
      return {
        correlationId: 'fixture',
        timestamp: new Date().toISOString(),
        signature: 'validated-by-production-adapter',
        quoteRequest: {
          dry: false,
          swapType: 'EXACT_INPUT',
          depositMode: 'SIMPLE',
          originAsset: t.asset,
          destinationAsset: 'nep141:wrap.near',
          depositType: 'INTENTS',
          recipientType: 'INTENTS',
          refundType: 'INTENTS',
          amount: t.amountAtoms,
          recipient: t.payer,
          refundTo: t.payer,
          slippageTolerance: t.slippageBps,
          deadline: t.deadline,
        },
        quote: {
          amountIn: t.amountAtoms,
          amountOut: '600',
          minAmountOut: '500',
          depositAddress: 'fixture-deposit',
          deadline: t.deadline,
          timeEstimate: 1,
        },
      };
    },
    signSwap: async (t) => {
      calls.signatures++;
      return {
        standard: 'nep413',
        payload: {
          recipient: 'intents.near',
          nonce: Buffer.alloc(32, 1).toString('base64'),
          message: JSON.stringify({
            signer_id: t.payer,
            deadline: t.deadline,
            intents: [
              {
                intent: 'token_diff',
                diff: { [t.asset]: `-${t.amountAtoms}`, 'nep141:wrap.near': '500' },
              },
            ],
          }),
        },
        public_key: 'fixture',
        signature: 'fixture',
      };
    },
    swapStatus: async () => ({
      status: swapped ? 'SUCCESS' : 'PENDING',
      creditYocto: '500',
      evidenceDigest: 'd'.repeat(64),
    }),
    submitSwap: async () => {
      calls.swaps++;
      swapped = true;
      if (lost && !seen.has('swap')) {
        seen.add('swap');
        throw Error('Accepted swap response lost');
      }
    },
    prepareCall: async (_t, kind, amount) => {
      calls.prepare[kind]++;
      return {
        kind,
        txHash: hash(kind === 'WITHDRAW' ? 2 : 3),
        signedBase64: Buffer.from(`exact-${kind}-identity`).toString('base64'),
        amountNearYocto: amount,
      };
    },
    reconcileCall: async (_t, call) => finalized.get(call.txHash) ?? null,
    sendCall: async (call) => {
      // Every signed identity must already be durable before the outbound side effect.
      const records = await db.businessEntry.findMany({ where: { kind: 'NFT_FUNDING_STEP' } });
      expect(
        records.some((r) => (r.payload as { phase: string }).phase === `${call.kind}_PREPARED`),
      ).toBe(true);
      calls.sent.push(call.signedBase64);
      finalized.set(call.txHash, {
        txHash: call.txHash,
        gasYocto: '10',
        amountNearYocto: call.amountNearYocto,
        allocatedYocto: call.kind === 'DISTRIBUTE' ? '50' : null,
        evidenceDigest: 'e'.repeat(64),
      });
      if (lost && !seen.has(call.kind)) {
        seen.add(call.kind);
        throw Error(`Accepted ${call.kind} response lost`);
      }
    },
  };
  return {
    adapter,
    calls,
    finalized,
    setSwapped: () => {
      swapped = true;
    },
  };
}
async function drive(reference: string, p: FundingPorts) {
  for (let i = 0; i < 10; i++) {
    try {
      if ((await runNftPayout(new Store(db, config), reference, p)) === 'COMPLETE') return;
    } catch (e) {
      if (!String(e).includes('response lost')) throw e;
    }
  }
  throw Error('Payout did not complete');
}
it('recovers the same swap, withdrawal and distribution after three accepted-but-lost responses', async () => {
  await reservation();
  const queued = await queueNftPayout(store, {
    reservationReference: 'nft-budget',
    minimumNearYocto: '490',
  });
  const p = ports(true);
  await drive(queued.reference, p.adapter);
  expect(p.calls).toMatchObject({
    quotes: 1,
    signatures: 1,
    swaps: 1,
    prepare: { WITHDRAW: 1, DISTRIBUTE: 1 },
  });
  expect(new Set(p.calls.sent).size).toBe(2);
  const report = await fundingStatus(store);
  expect(report).toMatchObject({
    completedDistributions: 1,
    distributedNearYocto: '500',
    allocatedNearYocto: '50',
    computePurchaseImplemented: false,
  });
  expect(report.operations[0]?.state).toBe('COMPLETE');
  expect(await runNftPayout(store, queued.reference, p.adapter)).toBe('COMPLETE');
  const journals = await db.journal.findMany({ include: { postings: true } });
  expect(journals.map((j) => j.kind).sort()).toEqual([
    'EARNED_PROCEEDS_CONVERSION',
    'EARNED_PROCEEDS_NATIVE_WITHDRAWAL',
    'EARNED_PROCEEDS_NFT_DISTRIBUTION',
  ]);
  for (const j of journals)
    for (const asset of new Set(j.postings.map((p) => p.asset)))
      expect(
        j.postings
          .filter((p) => p.asset === asset)
          .reduce((n, p) => n + BigInt(p.amountAtoms.toFixed(0)), 0n),
      ).toBe(0n);
  const records = await db.businessEntry.findMany({ where: { kind: 'NFT_FUNDING_STEP' } });
  expect(JSON.stringify(records)).not.toContain('exact-WITHDRAW');
  expect(JSON.stringify(report)).not.toMatch(
    /signedBase64|public_key|payload|envelope|unused-test/,
  );
});
it('serializes admission and refuses competing account nonces or changed payout minima', async () => {
  await reservation('a');
  await reservation('b');
  const results = await Promise.allSettled(
    ['a', 'b'].map((reservationReference) =>
      queueNftPayout(store, { reservationReference, minimumNearYocto: '490' }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
    reference: string;
    reservationReference: string;
  }>;
  expect(
    (
      await queueNftPayout(store, {
        reservationReference: winner.value.reservationReference,
        minimumNearYocto: '490',
      })
    ).reference,
  ).toBe(winner.value.reference);
  await expect(
    queueNftPayout(store, {
      reservationReference: winner.value.reservationReference,
      minimumNearYocto: '491',
    }),
  ).rejects.toThrow('another minimum');
});
it('PAPER, missing caps and provider purchases cause no payment', async () => {
  const p = ports();
  await expect(
    queueNftPayout(new Store(db, base), { reservationReference: 'none', minimumNearYocto: '1' }),
  ).rejects.toThrow('arming');
  await expect(
    queueNftPayout(new Store(db, { ...config, BUSINESS_MAX_PAYOUT_ATOMS: '0' }), {
      reservationReference: 'none',
      minimumNearYocto: '1',
    }),
  ).rejects.toThrow('caps');
  expect(() => requestComputePurchase()).toThrow('No publicly supported NEAR AI');
  expect(p.calls.sent).toEqual([]);
  expect(await db.businessEntry.count()).toBe(0);
});
it('keeps funds held on a paused policy or changed recipient', async () => {
  await reservation();
  const q = await queueNftPayout(store, {
    reservationReference: 'nft-budget',
    minimumNearYocto: '490',
  });
  const p = ports();
  await db.policy.update({ where: { mode: 'LIVE' }, data: { paused: true } });
  await expect(runNftPayout(store, q.reference, p.adapter)).rejects.toThrow('Paused policy');
  await db.policy.update({ where: { mode: 'LIVE' }, data: { paused: false } });
  await expect(
    runNftPayout(
      new Store(db, { ...config, NEAR_ACCOUNTANT_ACCOUNT_ID: 'other.near' }),
      q.reference,
      p.adapter,
    ),
  ).rejects.toThrow('Frozen payout');
  expect(p.calls.swaps).toBe(0);
  expect(p.calls.sent).toEqual([]);
});
it('reuses a signed intent at most three times without generating a replacement', async () => {
  await reservation();
  const q = await queueNftPayout(store, {
    reservationReference: 'nft-budget',
    minimumNearYocto: '490',
  });
  const p = ports();
  p.adapter.submitSwap = async () => {
    p.calls.swaps++;
    throw Error('response lost');
  };
  for (let i = 0; i < 3; i++)
    await expect(runNftPayout(store, q.reference, p.adapter)).rejects.toThrow('response lost');
  await expect(runNftPayout(store, q.reference, p.adapter)).rejects.toThrow('Only reconciliation');
  expect(p.calls.signatures).toBe(1);
  expect(p.calls.swaps).toBe(3);
  expect(p.calls.sent).toEqual([]);
});
it('does not withdraw or pay on a failed/refunded conversion', async () => {
  await reservation();
  const q = await queueNftPayout(store, {
    reservationReference: 'nft-budget',
    minimumNearYocto: '490',
  });
  const p = ports();
  p.adapter.swapStatus = async () => ({
    status: 'REFUNDED',
    creditYocto: '0',
    evidenceDigest: 'f'.repeat(64),
  });
  expect(await runNftPayout(store, q.reference, p.adapter)).toBe('REFUNDED_HELD');
  expect(await runNftPayout(store, q.reference, p.adapter)).toBe('REFUNDED_HELD');
  expect(p.calls.sent).toEqual([]);
  expect((await fundingStatus(store)).completedDistributions).toBe(0);
});
it('honors input caps and only consumes an NFT proceeds reservation', async () => {
  await reservation('too-big', '101');
  await expect(
    queueNftPayout(store, { reservationReference: 'too-big', minimumNearYocto: '1' }),
  ).rejects.toThrow('cap');
  const r = await reservation('compute');
  await db.businessEntry.update({
    where: { id: r.id },
    data: { payload: { purpose: 'COMPUTE_PURCHASE' } },
  });
  await expect(
    queueNftPayout(store, { reservationReference: 'compute', minimumNearYocto: '1' }),
  ).rejects.toThrow('NFT reservation');
});
it('records confirmed distributions even if actual gas exceeds the cap, then pauses further spending', async () => {
  await reservation();
  const q = await queueNftPayout(store, {
    reservationReference: 'nft-budget',
    minimumNearYocto: '490',
  });
  const p = ports();
  const send = p.adapter.sendCall;
  p.adapter.sendCall = async (call) => {
    await send(call);
    if (call.kind === 'DISTRIBUTE') p.finalized.get(call.txHash)!.gasYocto = '1001';
  };
  await drive(q.reference, p.adapter);
  expect((await fundingStatus(store)).completedDistributions).toBe(1);
  expect((await db.policy.findUniqueOrThrow({ where: { mode: 'LIVE' } })).paused).toBe(true);
});

it('cancels an unsubmitted authorization without resetting a payment that might have escaped', async () => {
  await reservation();
  const q = await queueNftPayout(store, {
    reservationReference: 'nft-budget',
    minimumNearYocto: '490',
  });
  expect((await cancelUnsubmittedPayout(store, q.reference)).state).toBe('CANCELLED');
  expect((await cancelUnsubmittedPayout(store, q.reference)).state).toBe('CANCELLED');
  expect((await businessStatus(store)).reservedAtoms).toBe('0');
  expect(await runNftPayout(store, q.reference, ports().adapter)).toBe('CANCELLED');
  const fresh = await reserveProceeds(store, {
    reference: 'replacement',
    windowReference: 'window-nft-budget',
    purpose: 'NFT_DISTRIBUTION',
    amountAtoms: '100',
  });
  expect(fresh.amountAtoms.toFixed(0)).toBe('100');
  const next = await queueNftPayout(store, {
    reservationReference: 'replacement',
    minimumNearYocto: '490',
  });
  const p = ports();
  await runNftPayout(store, next.reference, p.adapter);
  await expect(cancelUnsubmittedPayout(store, next.reference)).rejects.toThrow(
    'payment may have escaped',
  );
  expect((await fundingStatus(store)).completedDistributions).toBe(0);
});
it('serializes two recovering executors around one persisted identity per payment step', async () => {
  await reservation();
  const q = await queueNftPayout(store, {
      reservationReference: 'nft-budget',
      minimumNearYocto: '490',
    }),
    p = ports();
  p.setSwapped();
  let nonce = 20;
  p.adapter.prepareCall = async (_t, kind, amount) => {
    p.calls.prepare[kind]++;
    const n = nonce++;
    return { kind, txHash: hash(n), signedBase64: `unique-prepared-${n}`, amountNearYocto: amount };
  };
  for (let i = 0; i < 5; i++)
    await Promise.allSettled([
      runNftPayout(store, q.reference, p.adapter),
      runNftPayout(store, q.reference, p.adapter),
    ]);
  expect((await fundingStatus(store)).completedDistributions).toBe(1);
  expect(new Set(p.calls.sent).size).toBe(2);
  expect(await db.journal.count({ where: { kind: 'EARNED_PROCEEDS_NFT_DISTRIBUTION' } })).toBe(1);
});

it('authenticates payout control and returns the purchase blocker without creating a payment', async () => {
  const app = await createApp(new Store(db, base));
  try {
    for (const url of ['/api/business/payouts', '/api/business/compute-purchases']) {
      const denied = await app.inject({ method: 'POST', url, payload: {} });
      expect(denied.statusCode).toBe(401);
      const readOnly = await app.inject({
        method: 'POST',
        url,
        payload: {},
        headers: { authorization: `Bearer ${base.READ_TOKEN}` },
      });
      expect(readOnly.statusCode).toBe(401);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/business/compute-purchases',
      headers: { authorization: `Bearer ${base.ADMIN_TOKEN}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('PROVIDER_PURCHASE_PROTOCOL_REQUIRED');
    const status = await app.inject({
      url: '/api/business/funding',
      headers: { authorization: `Bearer ${base.READ_TOKEN}` },
    });
    expect(status.json()).toMatchObject({
      nftFundingImplemented: true,
      nftFundingEnabled: false,
      completedDistributions: 0,
      computePurchaseImplemented: false,
    });
    expect(await db.businessEntry.count()).toBe(0);
  } finally {
    await app.close();
  }
});
