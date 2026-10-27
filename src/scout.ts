import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { Proposal, DomainError, digest } from './domain.js';
import { evaluatePolicy } from './policy.js';
import type { Providers } from './providers/types.js';
const routes = z.array(Proposal.omit({ expiresAt: true })).max(10);
/** Bounded allowlisted route discovery. Historical swaps are never treated as pending orders. */
export async function scout(store: Store, providers: Providers): Promise<void> {
  if (!store.config.SCOUT_ROUTES_FILE) return;
  const control = await store.db.workerControl.findUniqueOrThrow({ where: { role: 'SCOUT' } });
  const policy = await store.db.policy.findUniqueOrThrow({ where: { mode: store.mode } });
  if (control.paused || policy.paused) return;
  if (
    await store.db.cycle.count({
      where: {
        mode: store.mode,
        state: { notIn: ['CLOSED', 'REJECTED', 'EXPIRED', 'REFUNDED', 'FAILED'] },
      },
    })
  )
    return;
  const data = await readFile(store.config.SCOUT_ROUTES_FILE, 'utf8');
  if (data.length > 65536) throw new DomainError('ROUTES_SIZE', 'Scout route file is too large');
  for (const route of routes.parse(JSON.parse(data))) {
    const proposal = Proposal.parse({
      ...route,
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    });
    const quote = await providers.quote('discovery', proposal);
    if (evaluatePolicy(policy, proposal, quote, null).length) continue;
    const key = `scout:${digest(route)}:${Math.floor(Date.now() / store.config.SCOUT_INTERVAL_MS)}`;
    await store.createCycle(proposal, key);
    return;
  }
}
