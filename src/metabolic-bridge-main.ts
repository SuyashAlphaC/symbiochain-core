import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { Store } from './store.js';
import { tickManualTopups } from './manual-topups.js';
import { DomainError, digest } from './domain.js';
import { append, existing } from './business.js';

const { values } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    'max-atoms': { type: 'string' },
    'credit-usd-micros': { type: 'string' },
  },
});
if (!values['max-atoms'] || !values['credit-usd-micros'])
  throw new Error(
    'Specify --max-atoms and --credit-usd-micros; this process never makes purchases',
  );
const config = loadConfig();
const db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX),
  store = new Store(db, config);
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopped = true;
  });

// Optional alert only. A missing or failed webhook never confirms a payment or changes credits.
async function alert(reference: string) {
  const target = process.env.OPERATOR_TOPUP_WEBHOOK_URL;
  if (!target) return;
  const url = new URL(target);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'discord.com' ||
    !url.pathname.startsWith('/api/webhooks/') ||
    url.username ||
    url.password
  )
    throw new DomainError('TOPUP_WEBHOOK_CONFIGURATION', 'Use a dedicated Discord webhook');
  const ref = `${reference}:alert`,
    termsDigest = digest({ reference });
  const claimed = await store.atomic(async (tx) => {
    if (await existing(tx, store, ref, termsDigest)) return false;
    await append(
      tx,
      store,
      ref,
      'MANUAL_TOPUP_ALERT_STARTED',
      '0',
      { reference, outcome: 'UNKNOWN' },
      termsDigest,
    );
    return true;
  });
  if (!claimed) return;
  let delivered = false;
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `SymbioChain: manual AI-credit top-up requires operator review. Open the private operator dashboard. Execution mode: ${store.mode}. Reference: ${reference}. No payment was submitted.`,
        allowed_mentions: { parse: [] },
      }),
    });
    delivered = response.ok;
  } catch {
    /* Keep the task pending and hold uncertain alert delivery; never log the secret URL. */
  }
  await store.atomic((tx) =>
    append(
      tx,
      store,
      `${reference}:alert-result`,
      'MANUAL_TOPUP_ALERT_RESULT',
      '0',
      { reference, delivered, automaticRetry: false },
      digest({ reference, delivered }),
    ),
  );
}

try {
  if (store.mode === 'REPLAY')
    throw new DomainError('READ_ONLY_MODE', 'Bridge cannot run in REPLAY');
  do {
    const tasks = await tickManualTopups(store, {
      maxSpendAtoms: values['max-atoms'],
      requestedCreditUsdMicros: values['credit-usd-micros'],
    });
    for (const task of tasks) {
      if (task.state === 'WAITING_OPERATOR') await alert(task.reference);
      console.log(
        JSON.stringify({
          event: 'compute.manual_topup',
          reference: task.reference,
          state: task.state,
          simulated: task.simulated,
          providerVerified: false,
          purchasesSubmitted: 0,
        }),
      );
    }
    if (!tasks.length)
      console.log(
        JSON.stringify({
          event: 'compute.manual_topup',
          state: 'NO_ELIGIBLE_CLOSED_PROFIT_WINDOW',
          purchasesSubmitted: 0,
        }),
      );
    if (!values.once && !stopped) await sleep(10000);
  } while (!values.once && !stopped);
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'compute.manual_topup_held',
      code: error instanceof DomainError ? error.code : 'BRIDGE_UNAVAILABLE',
      purchasesSubmitted: 0,
    }),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
