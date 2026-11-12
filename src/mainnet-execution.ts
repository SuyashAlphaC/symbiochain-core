import { readFile } from 'node:fs/promises';
import { MainnetOwnedExecution } from './mainnet-execution-contract.js';
export async function readMainnetOwnedExecution() {
  return MainnetOwnedExecution.parse({
    contractVersion: 1,
    ...JSON.parse(
      await readFile(new URL('../artifacts/mainnet-owned-execution.json', import.meta.url), 'utf8'),
    ),
  });
}
