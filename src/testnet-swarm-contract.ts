import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TestnetExecutionReport = z
  .object({
    chain: z.enum(['eip155:11155111', 'solana:devnet']),
    source: z.enum(['AUTHORIZATION_FIXTURE', 'VERIFIED_AI']),
    sender: z.string().max(64),
    status: z.enum(['BLOCKED', 'SIGNED', 'CONFIRMED']),
    code: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    txHash: z
      .string()
      .regex(/^(0x[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})$/)
      .nullable(),
    nativeFeeAtoms: z.string().regex(/^\d+$/).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const evm = value.chain === 'eip155:11155111';
    if (
      !(evm ? /^0x[a-fA-F0-9]{40}$/ : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(value.sender) ||
      (value.txHash &&
        !(evm ? /^0x[a-fA-F0-9]{64}$/ : /^[1-9A-HJ-NP-Za-km-z]{64,88}$/).test(value.txHash))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Address and transaction must match the test network',
      });
    if (value.status === 'CONFIRMED' && (!value.txHash || value.nativeFeeAtoms === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Confirmation requires transaction identity and actual fee',
      });
  });
export type TestnetExecutionReport = z.infer<typeof TestnetExecutionReport>;
export const swarmStages = ['SCOUT', 'BRAIN', 'HAND', 'ACCOUNTANT', 'CLOSED', 'REJECTED'] as const;
export type SwarmStage = (typeof swarmStages)[number];
export const TestnetSwarmReport = z
  .object({
    profile: z.literal('TESTNET_SWARM'),
    runId: z.uuid(),
    updatedAt: z.iso.datetime(),
    stage: z.enum(swarmStages),
    status: z.enum(['PENDING', 'RUNNING', 'BLOCKED', 'CLOSED', 'REJECTED']),
    settlement: z.literal('SIMULATED'),
    economics: z.literal('SIMULATED'),
    paidInferenceRequests: z.number().int().min(0).max(1),
    billedUsdMicros: z.string().regex(/^\d+$/).nullable(),
    inference: z
      .object({
        model: z.literal('z-ai/glm-5.3-flash'),
        status: z.literal('VERIFIED'),
        requestHash: hash,
        responseHash: hash,
        measurement: hash,
        execute: z.boolean(),
      })
      .strict()
      .nullable(),
    execution: TestnetExecutionReport.nullable(),
    receiptTokenId: z.string().max(160).nullable(),
    events: z
      .array(
        z
          .object({
            stage: z.enum(swarmStages),
            at: z.iso.datetime(),
            code: z.string().regex(/^[A-Z0-9_]{1,80}$/),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.status === 'CLOSED' &&
      (r.stage !== 'CLOSED' ||
        !r.inference?.execute ||
        r.execution?.status !== 'CONFIRMED' ||
        r.execution.source !== 'VERIFIED_AI' ||
        !r.receiptTokenId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Closed swarm requires verified AI, confirmed execution and a receipt',
      });
  });
export type TestnetSwarmReport = z.infer<typeof TestnetSwarmReport>;
