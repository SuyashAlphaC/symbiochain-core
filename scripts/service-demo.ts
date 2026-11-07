import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { PaperProviders } from '../src/providers/paper.js';
import { createRiskService, simulateServicePayment, riskReport } from '../src/risk-services.js';

const config = loadConfig();
if (config.EXECUTION_MODE !== 'PAPER') throw new Error('Service demo requires PAPER');
const db = createDatabase(config.DATABASE_URL);
try {
  const store = new Store(db, config);
  await store.initialize();
  const reference = `demo-audit:${randomUUID()}`;
  const order = await createRiskService(store, {
    reference,
    payer: 'team.paper',
    customerRelationship: 'TEAM_DEMO',
    agreedTermsDigest: '0'.repeat(64),
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
  });
  const cycleId = (order.payload as { cycleId: string }).cycleId;
  await simulateServicePayment(store, reference);
  const engine = new Engine(store, new PaperProviders());
  for (let step = 0; step < 3; step++) await engine.tick();
  if ((await store.getCycle(cycleId)).state !== 'CLOSED')
    throw new Error('Service not closed; inspect the existing job and policy');
  console.log(
    JSON.stringify(
      {
        scope: 'PAPER_SERVICE_DEMONSTRATION',
        paidInferenceRequests: 0,
        realPayments: 0,
        realRevenue: 0,
        disclosure:
          'Synthetic payment, quotes and local inference. No TEE, enclave emulator, provider credit purchase or market demand is demonstrated.',
        report: await riskReport(store, reference),
      },
      null,
      2,
    ),
  );
} finally {
  await db.$disconnect();
}
