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
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
const c = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  NEAR_AI_MODEL: 'canonical/model',
  TEE_GATEWAY_COMPOSE_HASHES: 'aa'.repeat(32),
  TEE_MODEL_COMPOSE_HASHES: 'aa'.repeat(32),
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
it('does not repeat a paid inference after a transport timeout', async () => {
  const { p, q, id } = await setup();
  let posts = 0;
  const transport: Fetch = async (url) => {
    if (String(url).includes('/attestation/'))
      return Response.json({ gateway_attestation: {}, model_attestations: [{}] });
    posts++;
    throw new Error('paid request accepted but connection lost');
  };
  const client = new NearAiClient(c, db, hardware, transport);
  await expect(client.assess(id, p, q)).rejects.toThrow('connection lost');
  await expect(new NearAiClient(c, db, hardware, transport).assess(id, p, q)).rejects.toThrow(
    'automatic resubmission',
  );
  expect(posts).toBe(1);
  expect((await db.inferenceAttempt.findUniqueOrThrow({ where: { cycleId: id } })).status).toBe(
    'STARTED',
  );
});
it('resumes billing/signature verification from captured bytes without paying twice', async () => {
  const { p, q, id } = await setup();
  let posts = 0,
    costs = 0,
    request = Buffer.alloc(0),
    response = Buffer.alloc(0);
  const transport: Fetch = async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    if (path.includes('/attestation/'))
      return Response.json({ gateway_attestation: {}, model_attestations: [{}] });
    if (path === '/v1/chat/completions') {
      posts++;
      request = Buffer.from(init?.body as Uint8Array);
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
      const text = `canonical/model:${sha256(request)}:${sha256(response)}`;
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
  const client = new NearAiClient(c, db, hardware, transport);
  await expect(client.assess(id, p, q)).rejects.toThrow('reliable request cost');
  const result = await new NearAiClient(c, db, hardware, transport).assess(id, p, q);
  expect(result.proof.status).toBe('VERIFIED');
  expect(result.usage.costUsdMicros).toBe('101');
  expect(posts).toBe(1);
  expect(await db.computeUsage.count()).toBe(1);
  expect((await client.assess(id, p, q)).proof.requestHash).toBe(result.proof.requestHash);
  expect(posts).toBe(1);
});
