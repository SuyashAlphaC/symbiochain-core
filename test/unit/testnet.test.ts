import { it, expect } from 'vitest';
import { emptyTestnetReport, TestnetReport } from '../../src/testnet-contract.js';
import { requireTestnetAccount, requireTestnetNetwork } from '../../src/testnet-profile.js';
import { applyTeeProbe } from '../../src/testnet-report.js';

it('refuses mainnet identities and RPCs before testnet transactions', async () => {
  expect(() => requireTestnetAccount('solidvideo4090.near')).toThrow('dedicated .testnet');
  expect(() => requireTestnetAccount('abc.testnet.evil')).toThrow();
  expect(() => requireTestnetAccount('brain.rehearsal.testnet')).not.toThrow();
  await expect(requireTestnetNetwork(async () => ({ chain_id: 'mainnet' }))).rejects.toThrow(
    'non-testnet',
  );
  await expect(
    requireTestnetNetwork(async () => ({ chain_id: 'testnet' })),
  ).resolves.toBeUndefined();
});
it('keeps hardware evidence separate from deployment approval and refuses stale or partial TEE audits', () => {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const probe = {
    checkedAt: new Date().toISOString(),
    paidInferenceRequests: 0,
    transactionsPerformed: false,
    inferenceResponseVerified: false,
    readyForBoundedInference: false,
    results: [
      { role: 'gateway', hardwareVerified: true, deploymentApproved: false },
      { role: 'model', hardwareVerified: true, deploymentApproved: false },
    ],
  };
  const report = applyTeeProbe(emptyTestnetReport(), probe, startedAt);
  expect(report.checks.find((c) => c.id === 'tee_hardware')?.status).toBe('PASSED');
  expect(report.checks.find((c) => c.id === 'tee_deployment')?.status).toBe('BLOCKED');
  expect(report.checks.find((c) => c.id === 'inference')?.status).toBe('BLOCKED');
  expect(() =>
    applyTeeProbe(report, { ...probe, results: [probe.results[0], probe.results[0]] }, startedAt),
  ).toThrow('gateway and model');
  expect(() =>
    applyTeeProbe(report, { ...probe, checkedAt: '2020-01-01T00:00:00.000Z' }, startedAt),
  ).toThrow('Fresh');
  expect(() => applyTeeProbe(report, { ...probe, paidInferenceRequests: 1 }, startedAt)).toThrow();
});
it('keeps rehearsal output bounded and refuses unsupported verification claims or secrets', () => {
  const report = emptyTestnetReport();
  expect(TestnetReport.parse(report)).toEqual(report);
  expect(TestnetReport.safeParse({ ...report, privateKey: 'secret' }).success).toBe(false);
  expect(TestnetReport.safeParse({ ...report, mainnetTransactions: 1 }).success).toBe(false);
  expect(
    TestnetReport.safeParse({
      ...report,
      checks: report.checks.map((c) => (c.id === 'inference' ? { ...c, status: 'PASSED' } : c)),
    }).success,
  ).toBe(false);
  expect(
    TestnetReport.safeParse({ ...report, checks: report.checks.map(() => report.checks[0]) })
      .success,
  ).toBe(false);
});
