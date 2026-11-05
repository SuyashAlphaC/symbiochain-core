import { z } from 'zod';
import { TestnetExecutionReport, TestnetSwarmReport } from './testnet-swarm-contract.js';

export const testnetCheckIds = [
  'network',
  'deployment',
  'roles',
  'policy',
  'pause',
  'services',
  'evm_signature',
  'solana_signature',
  'settlement',
  'receipt',
  'dividends',
  'tee_hardware',
  'tee_deployment',
  'inference',
] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const account = z
  .string()
  .max(64)
  .regex(/^[a-z0-9._-]+\.testnet$/);
export const TestnetReport = z
  .object({
    contractVersion: z.literal(1),
    profile: z.literal('TESTNET_REHEARSAL'),
    runId: z.uuid().nullable(),
    capturedAt: z.iso.datetime().nullable(),
    network: z.literal('testnet'),
    contractId: account.nullable(),
    artifactHash: hash.nullable(),
    settlement: z.literal('SIMULATED'),
    economics: z.literal('SIMULATED'),
    mainnetTransactions: z.literal(0),
    paidInferenceRequests: z.literal(0),
    swarm: TestnetSwarmReport.optional(),
    executions: z.array(TestnetExecutionReport).max(2).optional(),
    checks: z
      .array(
        z
          .object({
            id: z.enum(testnetCheckIds),
            status: z.enum(['PENDING', 'PASSED', 'FAILED', 'BLOCKED', 'SIMULATED']),
            detail: z.string().min(1).max(400),
          })
          .strict(),
      )
      .length(testnetCheckIds.length),
    transactions: z
      .array(
        z
          .object({
            operation: z.string().regex(/^[a-z0-9:_-]{1,80}$/),
            hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
            receiver: account,
            success: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (new Set(report.checks.map((c) => c.id)).size !== testnetCheckIds.length)
      ctx.addIssue({ code: 'custom', message: 'Each rehearsal check must appear once' });
    for (const id of ['settlement', 'inference'] as const) {
      const check = report.checks.find((c) => c.id === id);
      if (check?.status === 'PASSED')
        ctx.addIssue({ code: 'custom', message: `${id} cannot claim verified execution` });
    }
  });
export type TestnetReport = z.infer<typeof TestnetReport>;

export function emptyTestnetReport(): TestnetReport {
  return {
    contractVersion: 1,
    profile: 'TESTNET_REHEARSAL',
    runId: null,
    capturedAt: null,
    network: 'testnet',
    contractId: null,
    artifactHash: null,
    settlement: 'SIMULATED',
    economics: 'SIMULATED',
    mainnetTransactions: 0,
    paidInferenceRequests: 0,
    checks: testnetCheckIds.map((id) => ({ id, status: 'PENDING', detail: 'Not run.' })),
    transactions: [],
  };
}
