import { it, expect } from 'vitest';
import { readMainnetOwnedExecution } from '../../src/mainnet-execution.js';
import { MainnetOwnedExecution } from '../../src/mainnet-execution-contract.js';
it('publishes confirmed owner-authorized mainnet transfers without upgrading them to AI or business execution', async () => {
  const r = await readMainnetOwnedExecution();
  expect(r.results.map((r) => r.chain)).toEqual(['eip155:8453', 'solana:mainnet']);
  expect(r.results.every((r) => r.contractStatus === 'CLOSED' && r.destinationFinal)).toBe(true);
  expect(r.results.flatMap((r) => r.nativeReceipts)).toHaveLength(8);
  expect(() => MainnetOwnedExecution.parse({ ...r, teeApproved: true })).toThrow();
  expect(() => MainnetOwnedExecution.parse({ ...r, executionNativeFeesYocto: '1' })).toThrow();
  expect(() =>
    MainnetOwnedExecution.parse({
      ...r,
      allContinuationNativeFeesYocto: r.additionalPlanningCeilingYocto,
    }),
  ).toThrow();
});
