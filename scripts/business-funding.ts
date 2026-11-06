import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import {
  fundingStatus,
  queueNftPayout,
  runNftPayout,
  requestComputePurchase,
  cancelUnsubmittedPayout,
} from '../src/business-funding.js';
import { DomainError } from '../src/domain.js';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { reservation: { type: 'string' }, 'minimum-near-yocto': { type: 'string' } },
});
const config = loadConfig(),
  db = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX),
  store = new Store(db, config);
try {
  const command = positionals[0] ?? 'status';
  if (command === 'status') console.log(JSON.stringify(await fundingStatus(store), null, 2));
  else if (command === 'queue')
    console.log(
      JSON.stringify(
        await queueNftPayout(store, {
          reservationReference: values.reservation,
          minimumNearYocto: values['minimum-near-yocto'],
        }),
      ),
    );
  else if (command === 'step' && positionals[1])
    console.log(
      JSON.stringify({
        reference: positionals[1],
        state: await runNftPayout(store, positionals[1]),
      }),
    );
  else if (command === 'cancel' && positionals[1])
    console.log(JSON.stringify(await cancelUnsubmittedPayout(store, positionals[1])));
  else if (command === 'compute') requestComputePurchase();
  else
    throw new DomainError(
      'USAGE',
      'Use status, queue --reservation REF --minimum-near-yocto AMOUNT, step REF, cancel REF, or compute',
    );
} catch (error) {
  console.error(
    JSON.stringify({ error: error instanceof DomainError ? error.code : 'FUNDING_UNAVAILABLE' }),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
