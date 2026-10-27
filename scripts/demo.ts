import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { PaperProviders } from '../src/providers/paper.js';

const config = loadConfig();
if (config.EXECUTION_MODE !== 'PAPER') throw new Error('Demo requires PAPER');
const db = createDatabase(config.DATABASE_URL);
try {
  const store = new Store(db, config);
  await store.initialize();
  await store.fundPaper(20_000_000n, `demo-funding:${randomUUID()}`);
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
    `demo:${randomUUID()}`,
  );
  const engine = new Engine(store, new PaperProviders());
  for (let i = 0; i < 12; i++) await engine.tick();
  const result = await store.getCycle(cycle.id);
  console.log(
    JSON.stringify(
      {
        disclosure:
          'PAPER: synthetic prices, simulated inference and settlement; no real revenue or hardware verification',
        cycleId: cycle.id,
        state: result.state,
        swarm: await store.snapshot(),
      },
      null,
      2,
    ),
  );
  if (result.state !== 'CLOSED') throw new Error(`Demo stopped at ${result.state}`);
} finally {
  await db.$disconnect();
}
