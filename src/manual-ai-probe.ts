import { readFile } from 'node:fs/promises';
import { ManualAiProbe } from './manual-ai-probe-contract.js';

/** Read captured public evidence only. This path cannot issue inference requests. */
export async function readManualAiProbe() {
  return ManualAiProbe.parse(
    JSON.parse(
      await readFile(new URL('../artifacts/manual-ai-probe.json', import.meta.url), 'utf8'),
    ),
  );
}
