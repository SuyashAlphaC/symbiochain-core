import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';
import { inspectMainnetRelease } from '../src/live-inspection.js';
import { DomainError } from '../src/domain.js';

try {
  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      rpc: { type: 'string', default: 'https://rpc.mainnet.near.org' },
    },
  });
  // Loading configuration never arms the runtime or constructs a provider capable of signing.
  const config = loadConfig({ ...process.env, EXECUTION_MODE: 'PAPER' });
  const report = await inspectMainnetRelease({
    wasm: await readFile('artifacts/symbiochain_treasury.wasm'),
    rpcUrl: values.rpc!,
    accounts: {
      OWNER: values.owner ?? '',
      TREASURY: config.NEAR_CONTRACT_ID,
      BRAIN: config.NEAR_BRAIN_ACCOUNT_ID,
      HAND: config.NEAR_WORKER_ACCOUNT_ID,
      SCOUT: config.NEAR_SCOUT_ACCOUNT_ID,
      ACCOUNTANT: config.NEAR_ACCOUNTANT_ACCOUNT_ID,
    },
  });
  await mkdir('.data/live-execution', { recursive: true, mode: 0o700 });
  await writeFile('.data/live-execution/release-inspection.json', JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // RPC credentials and private key parser errors must never enter logs.
  console.error(
    JSON.stringify({
      error: error instanceof DomainError ? error.code : 'INSPECTION_FAILED',
      message: 'Mainnet release inspection did not complete. No transaction was submitted.',
    }),
  );
  process.exitCode = 1;
}
