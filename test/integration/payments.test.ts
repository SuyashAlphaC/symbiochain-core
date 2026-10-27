import { randomUUID } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { createDatabase } from '../../src/db.js';
import { loadConfig } from '../../src/config.js';
import { Store } from '../../src/store.js';
import { IntentPayments, type PaymentTransport } from '../../src/providers/intent-payments.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
const key = KeyPair.fromRandom('ed25519').toString();
const c = loadConfig({
  ...process.env,
  DATABASE_URL: url,
  EXECUTION_MODE: 'PAPER',
  NEAR_BRAIN_ACCOUNT_ID: 'brain.test.near',
  NEAR_BRAIN_PRIVATE_KEY: key,
  NEAR_WORKER_ACCOUNT_ID: 'hand.test.near',
  NEAR_WORKER_PRIVATE_KEY: key,
});
const db = createDatabase(url),
  store = new Store(db, c);
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Cycle", "ServicePayment", "Policy", "Journal", "WorkerControl", "OutboxEvent", "ComputeAccount" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
});
afterAll(async () => db.$disconnect());
async function cycle() {
  return (
    await store.createCycle(
      {
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
      randomUUID(),
    )
  ).cycle;
}
it('reconciles a timed-out Intents transfer by its durable nonce without another payment', async () => {
  const item = await cycle();
  let spent = false,
    calls = 0,
    nonce = '';
  const transport: PaymentTransport = {
    salt: async () => '01020304',
    registered: async () => true,
    used: async (_payer, n) => {
      if (nonce) expect(n).toBe(nonce);
      return spent;
    },
    execute: async (_account, intent) => {
      calls++;
      nonce = intent.payload.nonce;
      expect(Buffer.from(nonce, 'base64').subarray(0, 4).toString('hex')).toBe('01020304');
      const payload = JSON.parse(intent.payload.message);
      expect(payload.intents[0].tokens['nep141:wrap.near']).toBe(c.SERVICE_PAYMENT_YOCTO);
      expect(payload.intents[0].receiver_id).toBe('scout.test.near');
      spent = true;
      throw new Error('Accepted transfer; response lost');
    },
  };
  const id = `${item.id}:signal`;
  await expect(
    new IntentPayments(store, transport).settle(
      item.id,
      id,
      'BRAIN',
      'scout.test.near',
      'aa'.repeat(32),
    ),
  ).rejects.toThrow('response lost');
  await new IntentPayments(store, transport).settle(
    item.id,
    id,
    'BRAIN',
    'scout.test.near',
    'aa'.repeat(32),
  );
  expect(calls).toBe(1);
  expect((await db.servicePayment.findUniqueOrThrow({ where: { id } })).status).toBe('SETTLED');
  const journal = await db.journal.findUniqueOrThrow({
    where: { mode_reference: { mode: 'PAPER', reference: `service:${id}` } },
    include: { postings: true },
  });
  expect(journal.kind).toBe('INTERNAL_AGENT_PAYMENT');
  expect(journal.postings.reduce((sum, p) => sum + BigInt(p.amountAtoms.toFixed(0)), 0n)).toBe(0n);
  await expect(
    new IntentPayments(store, transport).settle(
      item.id,
      id,
      'BRAIN',
      'other.test.near',
      'aa'.repeat(32),
    ),
  ).rejects.toThrow('terms have changed');
});
it('does not submit an intent for an unregistered signing key', async () => {
  const item = await cycle();
  let calls = 0;
  const transport: PaymentTransport = {
    salt: async () => '01020304',
    registered: async () => false,
    used: async () => false,
    execute: async () => {
      calls++;
      return 'never';
    },
  };
  await expect(
    new IntentPayments(store, transport).settle(
      item.id,
      `${item.id}:signal`,
      'BRAIN',
      'scout.test.near',
      'aa'.repeat(32),
    ),
  ).rejects.toThrow('Register the dedicated');
  expect(calls).toBe(0);
});
