import { setTimeout as sleep } from 'node:timers/promises';

/** Heartbeats only. No provider, engine, signer or proposal is available here. */
export async function monitorWorkers(
  heartbeat: (role: 'SCOUT' | 'BRAIN' | 'HAND') => Promise<unknown>,
  running: () => boolean,
  wait: () => Promise<unknown> = () => sleep(5000),
) {
  while (running()) {
    for (const role of ['SCOUT', 'BRAIN', 'HAND'] as const) await heartbeat(role);
    await wait();
  }
}
