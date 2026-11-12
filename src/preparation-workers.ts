import { setTimeout as sleep } from 'node:timers/promises';

/** Real read-only work runs without delaying liveness updates or claiming paid jobs. */
export async function preparationWorkers(
  heartbeat: (role: 'SCOUT' | 'BRAIN' | 'HAND') => Promise<unknown>,
  prepare: () => Promise<unknown>,
  running: () => boolean,
  wait: () => Promise<unknown> = () => sleep(5000),
  now: () => number = Date.now,
) {
  let next = 0,
    pending: Promise<unknown> | undefined;
  while (running()) {
    for (const role of ['SCOUT', 'BRAIN', 'HAND'] as const) await heartbeat(role);
    if (!pending && now() >= next) {
      next = now() + 300000;
      pending = prepare()
        .catch(() => {
          console.error(JSON.stringify({ event: 'mainnet.preparation_unavailable' }));
        })
        .finally(() => {
          pending = undefined;
        });
    }
    await wait();
  }
  await pending;
}
