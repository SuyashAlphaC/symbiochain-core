import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { PaperProviders } from './providers/paper.js';
import { LiveProviders } from './providers/live.js';
import { scout } from './scout.js';
import { refreshComputeCredits } from './providers/compute-credits.js';
import { colocatedPaperFaults } from './paper-faults.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const store = new Store(db, config);
await store.initialize();
if (config.EXECUTION_MODE === 'REPLAY')
  throw new Error('REPLAY is read-only; use the evidence replay command');
const providers =
  config.EXECUTION_MODE === 'LIVE' ? new LiveProviders(store) : new PaperProviders();
const faults = colocatedPaperFaults(config);
const engine = new Engine(
  store,
  providers,
  faults ? (job) => faults.afterClaim(store, job) : undefined,
);
const lanes = process.env.WORKER_ROLE ? [process.env.WORKER_ROLE] : ['SCOUT', 'BRAIN', 'HAND'];
if (lanes.some((l) => !['SCOUT', 'BRAIN', 'HAND'].includes(l)))
  throw new Error('Invalid WORKER_ROLE');
let stopped = false;
let lastScan = 0;
let lastCreditRefresh = 0;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopped = true;
  });
while (!stopped) {
  if (
    config.EXECUTION_MODE === 'LIVE' &&
    lanes.includes('SCOUT') &&
    Date.now() - lastCreditRefresh > 60000
  ) {
    lastCreditRefresh = Date.now();
    await refreshComputeCredits(config, db).catch(() =>
      console.error(JSON.stringify({ event: 'compute.balance_unavailable' })),
    );
  }
  for (const role of lanes)
    await db.workerControl.update({ where: { role }, data: { heartbeat: new Date() } });
  if (lanes.includes('SCOUT') && Date.now() - lastScan >= config.SCOUT_INTERVAL_MS) {
    lastScan = Date.now();
    if (providers instanceof LiveProviders)
      await providers
        .reconcileIdleBalance()
        .catch(() =>
          console.error(JSON.stringify({ event: 'treasury.balance_reconciliation_unavailable' })),
        );
    await scout(store, providers).catch((e) =>
      console.error(
        JSON.stringify({
          event: 'scout.scan_failed',
          code: e instanceof Error ? e.name : 'UNKNOWN',
        }),
      ),
    );
  }
  if (!(await engine.tick(lanes))) await sleep(config.WORKER_POLL_MS);
}
await db.$disconnect();
