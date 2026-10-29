import { beforeEach, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { PaperProviders } from '../../src/providers/paper.js';
import { approveCostBasis, totalApprovedCost } from '../../src/cost-basis.js';
import { digest } from '../../src/domain.js';
import { LiveProviders } from '../../src/providers/live.js';
const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://symbio:symbio_local@localhost:55439/symbiochain_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test DB required');
const config = loadConfig({
    ...process.env,
    DATABASE_URL: url,
    EXECUTION_MODE: 'PAPER',
    NFT_SHARE_BPS: '100',
  }),
  db = createDatabase(url),
  store = new Store(db, config);
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE "Cycle", "ServicePayment", "ComputeAccount", "Policy", "Journal", "WorkerControl", "OutboxEvent" RESTART IDENTITY CASCADE',
  );
  await store.initialize();
  await store.fundPaper(20_000_000n, 'cost-test-capital');
});
afterAll(async () => db.$disconnect());
async function reconciled() {
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
  for (let i = 0; i < 6; i++) await engine.tick();
  const result = await store.getCycle(cycle.id);
  expect(result.state).toBe('RECONCILED');
  return result;
}
function approval(settlement: unknown) {
  return {
    settlementDigest: digest(settlement),
    inferenceCostUsdMicros: '100',
    computeBaseAtoms: '100',
    nativeGasBaseAtoms: '1000',
    hostingBaseAtoms: '50',
    otherBaseAtoms: '0',
    receiptBudgetBaseAtoms: '500',
    approvedBy: 'test-accountant',
    sourceEvidence: {
      nativeFeeEvidenceDigest: digest([]),
      valuationMethod: 'Sandbox fixture valuation, no external cost assertion',
      references: ['sandbox:synthetic-costs'],
      includesNearGasAndHosting: true,
    },
  };
}
it('binds immutable approved costs to settlement, fees and all billed inference', async () => {
  const cycle = await reconciled(),
    data = approval(cycle.settlement);
  await expect(
    approveCostBasis(store, cycle.id, { ...data, settlementDigest: 'ff'.repeat(32) }),
  ).rejects.toThrow('exact settlement');
  await expect(
    approveCostBasis(store, cycle.id, { ...data, inferenceCostUsdMicros: '0' }),
  ).rejects.toThrow('all metered');
  const row = await approveCostBasis(store, cycle.id, data);
  expect(totalApprovedCost(row)).toBe(1650n);
  expect((await approveCostBasis(store, cycle.id, data)).termsDigest).toBe(row.termsDigest);
  await expect(
    approveCostBasis(store, cycle.id, { ...data, hostingBaseAtoms: '0' }),
  ).rejects.toThrow('immutable');
});
it('withholds nonzero rights until costs are approved, then uses the approved net basis', async () => {
  const cycle = await reconciled();
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  // Exercise the real receipt method with an explicit sandbox transport; no live provider is composed.
  const context = Object.assign(Object.create(LiveProviders.prototype), {
    store,
    treasury: {
      cycle: async () => null,
      call: async (_role: string, method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        return { token_id: 'sandbox-token' };
      },
    },
  }) as LiveProviders;
  await expect(
    LiveProviders.prototype.receipt.call(context, cycle.id, { cycleId: cycle.id }),
  ).rejects.toThrow('awaits accountant');
  expect(calls).toHaveLength(0);
  await approveCostBasis(store, cycle.id, approval(cycle.settlement));
  const result = await LiveProviders.prototype.receipt.call(context, cycle.id, {
    cycleId: cycle.id,
  });
  expect(result.mintedOnChain).toBe(true);
  expect(result.costBasisTrust).toBe('ACCOUNTANT_APPROVED');
  expect(result.conservativePnlAtoms).toBe('97350');
  expect(calls.at(-1)?.args.share_bps).toBe(100);
});
it('does not mint rights when explicit settlement fees turn the approved result negative', async () => {
  const cycle = await reconciled();
  await approveCostBasis(store, cycle.id, {
    ...approval(cycle.settlement),
    nativeGasBaseAtoms: '98900',
    hostingBaseAtoms: '0',
    receiptBudgetBaseAtoms: '100',
  });
  const calls: string[] = [];
  const context = Object.assign(Object.create(LiveProviders.prototype), {
    store,
    treasury: {
      cycle: async () => null,
      call: async (_role: string, method: string) => {
        calls.push(method);
        return {};
      },
    },
  }) as LiveProviders;
  const result = await LiveProviders.prototype.receipt.call(context, cycle.id, {
    cycleId: cycle.id,
  });
  expect(result.mintedOnChain).toBe(false);
  expect(result.conservativePnlAtoms).toBe('-100');
  expect(calls).not.toContain('mint_proof_nft');
});
