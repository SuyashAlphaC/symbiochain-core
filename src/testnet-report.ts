import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { TestnetReport, emptyTestnetReport } from './testnet-contract.js';

export async function readTestnetReport(path = 'artifacts/testnet-rehearsal.json') {
  try {
    if ((await stat(path)).size > 100_000)
      throw new Error('Testnet report exceeds publication limit');
    return TestnetReport.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return emptyTestnetReport();
    throw error;
  }
}

export function applyTeeProbe(
  report: TestnetReport,
  raw: unknown,
  startedAt: string,
): TestnetReport {
  const probe = z
    .object({
      checkedAt: z.iso.datetime(),
      paidInferenceRequests: z.literal(0),
      transactionsPerformed: z.literal(false),
      inferenceResponseVerified: z.literal(false),
      readyForBoundedInference: z.boolean(),
      results: z
        .array(
          z.object({
            role: z.enum(['gateway', 'model']),
            hardwareVerified: z.boolean(),
            deploymentApproved: z.boolean(),
          }),
        )
        .min(2)
        .max(33),
    })
    .parse(raw);
  if (
    Date.parse(probe.checkedAt) < Date.parse(startedAt) ||
    Date.parse(probe.checkedAt) > Date.now() + 60_000 ||
    !probe.results.some((r) => r.role === 'gateway') ||
    !probe.results.some((r) => r.role === 'model')
  )
    throw new Error('Fresh gateway and model evidence required');
  const hardware = probe.results.every((r) => r.hardwareVerified);
  const approved =
    hardware && probe.readyForBoundedInference && probe.results.every((r) => r.deploymentApproved);
  const updated = structuredClone(report);
  for (const check of updated.checks) {
    if (check.id === 'tee_hardware') {
      check.status = hardware ? 'PASSED' : 'BLOCKED';
      check.detail = `Free gateway/model hardware audit at ${probe.checkedAt}; no completion was requested.`;
    }
    if (check.id === 'tee_deployment') {
      check.status = approved ? 'PASSED' : 'BLOCKED';
      check.detail = approved
        ? 'Configured deployment policy passed the fresh hardware audit.'
        : 'Deployment allowlists or provenance review remain unapproved; testnet does not bypass this gate.';
    }
    if (check.id === 'inference') {
      check.status = 'BLOCKED';
      check.detail = approved
        ? 'This free rehearsal does not buy inference. A separate budget-controlled signed completion remains required.'
        : 'No paid completion attempted while deployment approval is blocked.';
    }
  }
  updated.capturedAt = new Date().toISOString();
  return TestnetReport.parse(updated);
}
