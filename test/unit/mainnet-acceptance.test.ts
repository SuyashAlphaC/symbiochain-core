import { expect, it } from 'vitest';
import { MainnetAcceptance } from '../../src/mainnet-acceptance-contract.js';
const report = () => ({
  contractVersion: 1,
  profile: 'MAINNET_ACCEPTANCE',
  network: 'mainnet',
  capturedAt: '2026-11-09T05:00:00.000Z',
  block: { height: '123', hash: 'final' },
  summary: { passed: 1, blocked: 0, notRun: 0, complete: true },
  checks: [
    {
      id: 'network',
      label: 'Network',
      status: 'PASSED',
      scope: 'ON_CHAIN_STATE',
      detail: 'Observed mainnet.',
      links: ['https://nearblocks.io/address/treasury.near'],
    },
  ],
  transactions: [],
  serviceRoundTrip: null,
  runner: { paidInferenceRequests: 0, transactionsSubmitted: 0, readOnly: true },
});
it('keeps mainnet proof scope explicit and refuses fabricated completion or private data', () => {
  expect(MainnetAcceptance.parse(report()).network).toBe('mainnet');
  for (const mutate of [
    (r: any) => (r.network = 'testnet'),
    (r: any) => (r.checks[0].scope = 'NOT_EXECUTED'),
    (r: any) => (r.checks[0].status = 'BLOCKED'),
    (r: any) => (r.checks[0].links = ['https://testnet.nearblocks.io/txns/example']),
    (r: any) => (r.runner.paidInferenceRequests = 1),
    (r: any) => (r.privateKey = 'SECRET_SENTINEL'),
  ]) {
    const r = report();
    mutate(r);
    expect(() => MainnetAcceptance.parse(r)).toThrow();
  }
});
