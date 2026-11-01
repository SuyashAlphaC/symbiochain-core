import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { PaperProviders } from '../../src/providers/paper.js';
import { NearAiClient } from '../../src/providers/near-ai.js';
import { Proposal, digest, sha256 } from '../../src/domain.js';
import type { Fetch } from '../../src/providers/http.js';
import {
  BUDGET_MODEL,
  localComputeBudget,
  priceComputeReservation,
  reserveComputeBudget,
  settleComputeBudget,
} from '../../src/providers/compute-budget.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
const c = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  NEAR_AI_MODEL: 'canonical/model',
  COMPUTE_CREDIT_POLICY: 'PROVIDER_BALANCE',
  TEE_GATEWAY_COMPOSE_HASHES: 'aa'.repeat(32),
  TEE_MODEL_COMPOSE_HASHES: 'aa'.repeat(32),
});
it('admits only one concurrent request at the budget boundary and retains unknown costs across restarts', async () => {
  const config = {
    ...c,
    COMPUTE_CREDIT_POLICY: 'LOCAL_BUDGET' as const,
    AI_BUDGET_ID: 'boundary-fixture',
    NEAR_AI_MODEL: BUDGET_MODEL,
    AI_TOTAL_BUDGET_USD_MICROS: '84219',
    AI_MAX_REQUEST_USD_MICROS: '84219',
  };
  const a = await setup(),
    b = await setup();
  let posts = 0;
  const transport: Fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/models')
      return Response.json({
        data: [
          {
            id: BUDGET_MODEL,
            owned_by: 'nearai',
            is_ready: true,
            context_length: 1048576,
            supported_sampling_parameters: ['max_tokens'],
            supported_features: ['structured_outputs'],
            pricing: { prompt: '0.00000008', completion: '0.0000005', request: '0', image: '0' },
          },
        ],
      });
    if (path.includes('/attestation/'))
      return Response.json({ gateway_attestation: {}, model_attestations: [{}] });
    if (path === '/v1/chat/completions') {
      posts++;
      throw new Error('uncertain paid outcome');
    }
    throw new Error('Unexpected transport request');
  };
  const results = await Promise.allSettled(
    [a, b].map((x) => new NearAiClient(config, db, hardware, transport).assess(x.id, x.p, x.q)),
  );
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(posts).toBe(1);
  expect(await db.inferenceAttempt.count()).toBe(1);
  const budget = await localComputeBudget(db, config);
  expect(budget).toMatchObject({
    committedUsdMicros: '84219',
    availableUsdMicros: '0',
    halted: true,
    providerBalanceVerified: false,
  });
  const third = await setup();
  await expect(
    new NearAiClient(config, db, hardware, transport).assess(third.id, third.p, third.q),
  ).rejects.toThrow('budget cannot cover');
  expect(posts).toBe(1);
  expect((await new Store(db, config).snapshot()).computeCreditNanoUsd).toBeNull();
});
it('reconciles charges idempotently and halts further spending after a provider overrun', async () => {
  const config = {
    ...c,
    COMPUTE_CREDIT_POLICY: 'LOCAL_BUDGET' as const,
    AI_BUDGET_ID: 'overrun-fixture',
    NEAR_AI_MODEL: BUDGET_MODEL,
  };
  const budgetStore = new Store(db, config),
    { id } = await setup();
  const reservation = await priceComputeReservation(config, async () =>
    Response.json({
      data: [
        {
          id: BUDGET_MODEL,
          owned_by: 'nearai',
          is_ready: true,
          context_length: 1048576,
          supported_sampling_parameters: ['max_tokens'],
          supported_features: ['structured_outputs'],
          pricing: { prompt: '0.00000008', completion: '0.0000005', request: '0', image: '0' },
        },
      ],
    }),
  );
  await budgetStore.atomic((tx) => reserveComputeBudget(tx, budgetStore, id, reservation));
  const actual = '84220';
  expect(
    await budgetStore.atomic((tx) => settleComputeBudget(tx, budgetStore, id, reservation, actual)),
  ).toBe(true);
  expect(
    await budgetStore.atomic((tx) => settleComputeBudget(tx, budgetStore, id, reservation, actual)),
  ).toBe(true);
  expect(await localComputeBudget(db, config)).toMatchObject({
    committedUsdMicros: actual,
    halted: true,
  });
  const next = await setup();
  await expect(
    budgetStore.atomic((tx) => reserveComputeBudget(tx, budgetStore, next.id, reservation)),
  ).rejects.toThrow('budget cannot cover');
  expect(await db.journal.count({ where: { kind: 'INFERENCE_BUDGET_BREACH' } })).toBe(1);
});
const db = createDatabase(url),
  store = new Store(db, c),
  signer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const hardware = {
  verify: async (_r: unknown, nonce: string) => ({
    signer: signer.address.toLowerCase(),
    algorithm: 'ecdsa' as const,
    composeHash: 'aa'.repeat(32),
    nonce,
    tcbStatus: 'UpToDate',
    gpuVerified: true,
  }),
}; // test double; never an execution-mode bypass
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Cycle", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
});
afterAll(async () => db.$disconnect());
async function setup() {
  const p = Proposal.parse({
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
  const { cycle } = await store.createCycle(p, randomUUID());
  const q = await new PaperProviders().quote(cycle.id, p);
  return { p, q, id: cycle.id };
}
it.each(['PROVIDER_BALANCE', 'LOCAL_BUDGET'] as const)(
  'does not repeat a paid inference after a transport timeout: %s',
  async (policy) => {
    const config = {
      ...c,
      COMPUTE_CREDIT_POLICY: policy,
      AI_BUDGET_ID: 'inference-fixture',
      NEAR_AI_MODEL: policy === 'LOCAL_BUDGET' ? BUDGET_MODEL : c.NEAR_AI_MODEL,
    };
    const { p, q, id } = await setup();
    let posts = 0;
    const transport: Fetch = async (url) => {
      if (new URL(String(url)).pathname === '/v1/models')
        return Response.json({
          data: [
            {
              id: BUDGET_MODEL,
              owned_by: 'nearai',
              is_ready: true,
              context_length: 1048576,
              supported_sampling_parameters: ['max_tokens'],
              supported_features: ['structured_outputs'],
              pricing: { prompt: '0.00000008', completion: '0.0000005', request: '0', image: '0' },
            },
          ],
        });
      if (String(url).includes('/attestation/'))
        return Response.json({ gateway_attestation: {}, model_attestations: [{}] });
      posts++;
      throw new Error('paid request accepted but connection lost');
    };
    const client = new NearAiClient(config, db, hardware, transport);
    await expect(client.assess(id, p, q)).rejects.toThrow('connection lost');
    await expect(
      new NearAiClient(config, db, hardware, transport).assess(id, p, q),
    ).rejects.toThrow('automatic resubmission');
    expect(posts).toBe(1);
    expect((await db.inferenceAttempt.findUniqueOrThrow({ where: { cycleId: id } })).status).toBe(
      'STARTED',
    );
    if (policy === 'LOCAL_BUDGET')
      expect((await localComputeBudget(db, config)).committedUsdMicros).toBe('84219');
  },
);
it.each(['PROVIDER_BALANCE', 'LOCAL_BUDGET'] as const)(
  'resumes billing/signature verification from captured bytes without paying twice: %s',
  async (policy) => {
    const config = {
      ...c,
      COMPUTE_CREDIT_POLICY: policy,
      AI_BUDGET_ID: 'inference-fixture',
      NEAR_AI_MODEL: policy === 'LOCAL_BUDGET' ? BUDGET_MODEL : c.NEAR_AI_MODEL,
    };
    const { p, q, id } = await setup();
    let posts = 0,
      costs = 0,
      request = Buffer.alloc(0),
      response = Buffer.alloc(0);
    const transport: Fetch = async (url, init) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path === '/v1/models')
        return Response.json({
          data: [
            {
              id: BUDGET_MODEL,
              owned_by: 'nearai',
              is_ready: true,
              context_length: 1048576,
              supported_sampling_parameters: ['max_tokens'],
              supported_features: ['structured_outputs'],
              pricing: { prompt: '0.00000008', completion: '0.0000005', request: '0', image: '0' },
            },
          ],
        });
      if (path.includes('/attestation/'))
        return Response.json({ gateway_attestation: {}, model_attestations: [{}] });
      if (path === '/v1/chat/completions') {
        posts++;
        request = Buffer.from(init?.body as Uint8Array);
        if (policy === 'LOCAL_BUDGET')
          expect(JSON.parse(request.toString())).toMatchObject({
            max_tokens: 600,
            thinking_token_budget: 64,
            reasoning_effort: 'low',
            response_format: { type: 'json_object' },
          });
        response = Buffer.from(
          JSON.stringify({
            id: 'chat-1',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    execute: true,
                    reason: 'fixture',
                    maxSlippageBps: 50,
                    proposalDigest: digest({ proposal: p, quote: q }),
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
        );
        return new Response(response, {
          headers: { 'inference-id': 'billing-uuid', 'x-request-id': 'wrong-transport-id' },
        });
      }
      if (path === '/v1/billing/costs') {
        expect(JSON.parse(String(init?.body))).toEqual({ requestIds: ['billing-uuid'] });
        costs++;
        return Response.json({
          requests: [{ requestId: 'billing-uuid', costNanoUsd: 100001 }],
          warning: costs === 1 ? 'Not ready' : null,
        });
      }
      if (path.includes('/signature/')) {
        const text = `${config.NEAR_AI_MODEL}:${sha256(request)}:${sha256(response)}`;
        return Response.json({
          signature_kind: 'provider_tee',
          signing_algo: 'ecdsa',
          signing_address: signer.address,
          text,
          signature: await signer.signMessage({ message: text }),
        });
      }
      throw new Error('Unexpected fixture request');
    };
    const client = new NearAiClient(config, db, hardware, transport);
    await expect(client.assess(id, p, q)).rejects.toThrow('reliable request cost');
    if (policy === 'LOCAL_BUDGET')
      expect((await localComputeBudget(db, config)).committedUsdMicros).toBe('84219');
    const result = await new NearAiClient(config, db, hardware, transport).assess(id, p, q);
    expect(result.proof.status).toBe('VERIFIED');
    expect(result.usage.costUsdMicros).toBe('101');
    expect(posts).toBe(1);
    expect(await db.computeUsage.count()).toBe(1);
    expect((await client.assess(id, p, q)).proof.requestHash).toBe(result.proof.requestHash);
    expect(posts).toBe(1);
    if (policy === 'LOCAL_BUDGET')
      expect((await localComputeBudget(db, config)).committedUsdMicros).toBe('101');
  },
);
