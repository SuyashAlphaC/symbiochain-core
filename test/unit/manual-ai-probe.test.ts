import { expect, it } from 'vitest';
import { ManualAiProbe } from '../../src/manual-ai-probe-contract.js';
import { readManualAiProbe } from '../../src/manual-ai-probe.js';

it('keeps authenticated manual inference separate from approved autonomous execution', async () => {
  const evidence = await readManualAiProbe();
  expect(evidence.inferenceRequests).toBe(1);
  expect(evidence.automatedInferenceRequests).toBe(0);
  expect(() =>
    ManualAiProbe.parse({
      ...evidence,
      security: { ...evidence.security, teeWorkloadApproved: true },
    }),
  ).toThrow();
  expect(() =>
    ManualAiProbe.parse({
      ...evidence,
      organization: { ...evidence.organization, binding: 'VERIFIED' },
    }),
  ).toThrow();
  expect(() =>
    ManualAiProbe.parse({ ...evidence, rawResponse: 'private model response' }),
  ).toThrow();
});

it('rejects mismatched provider billing and an understated budget hold', async () => {
  const evidence = await readManualAiProbe();
  expect(evidence.billing.costNanoUsd).toBe('5480');
  expect(evidence.billing.applicationBudgetHoldUsdMicros).toBe('6');
  expect(() =>
    ManualAiProbe.parse({
      ...evidence,
      billing: { ...evidence.billing, applicationBudgetHoldUsdMicros: '5' },
    }),
  ).toThrow();
  expect(() =>
    ManualAiProbe.parse({
      ...evidence,
      billing: { ...evidence.billing, costNanoUsd: '100000001' },
    }),
  ).toThrow();
});
