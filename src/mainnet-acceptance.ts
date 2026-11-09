import { readFile, stat } from 'node:fs/promises';
import { MainnetAcceptance } from './mainnet-acceptance-contract.js';
export async function readMainnetAcceptance(path = 'artifacts/mainnet-acceptance.json') {
  if ((await stat(path)).size > 100000)
    throw Error('Mainnet acceptance report exceeds publication limit');
  return MainnetAcceptance.parse(JSON.parse(await readFile(path, 'utf8')));
}
