import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  TestnetLedger,
  optionalJson,
  privateJson,
  testnetLock,
  recoverTestnetLock,
} from '../src/testnet-ledger.js';
import { TestnetExecutor, type TestChain } from '../src/testnet-execution.js';
import { TestnetExecutionReport } from '../src/testnet-swarm.js';
import { digest, DomainError } from '../src/domain.js';
import { publishTestnetReport } from '../src/testnet-report.js';

// Independent authorization fixture, NOT a TEE-approved autonomous trade.
const directory = '.data/testnet-execution';
await mkdir(directory, { recursive: true, mode: 0o700 });
if (process.argv.includes('--recover-stale-lock')) await recoverTestnetLock();
const unlock = await testnetLock();
let ledger: TestnetLedger | undefined;
try {
  ledger = await TestnetLedger.open(directory);
  const executor = new TestnetExecutor(ledger);
  let saved = (await optionalJson(`${directory}/run.json`)) as { runId: string } | null;
  if (!saved) {
    saved = { runId: randomUUID() };
    await privateJson(`${directory}/run.json`, saved);
  }
  const results = [];
  for (const chain of ['eip155:11155111', 'solana:devnet'] as TestChain[]) {
    let result: TestnetExecutionReport;
    const sender = await executor.address(chain);
    try {
      result = await executor.execute(
        saved.runId,
        chain,
        'AUTHORIZATION_FIXTURE',
        digest({ fixture: true }),
        digest({ chain, runId: saved.runId }),
        digest({ settlement: 'SIMULATED' }),
      );
    } catch (error) {
      const name = chain === 'solana:devnet' ? 'solana' : 'evm';
      const plan = (await optionalJson(`${directory}/${saved.runId}-${name}-plan.json`)) as {
        signed?: { txHash: string };
      } | null;
      result = {
        chain,
        source: 'AUTHORIZATION_FIXTURE',
        sender,
        status: plan?.signed ? 'SIGNED' : 'BLOCKED',
        txHash: plan?.signed?.txHash ?? null,
        nativeFeeAtoms: null,
        code: error instanceof DomainError ? error.code : 'TESTNET_EXECUTION_UNAVAILABLE',
      };
      process.exitCode = 2;
    }
    results.push(TestnetExecutionReport.parse(result));
    await privateJson(`${directory}/public.json`, results);
    await publishTestnetReport();
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof DomainError ? error.code : 'TESTNET_EXECUTION_UNAVAILABLE',
    }),
  );
  process.exitCode = 2;
} finally {
  try {
    if (ledger) await ledger.paused(true);
  } finally {
    await unlock();
  }
}
