import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
const model = z.literal('z-ai/glm-5.3-flash');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const ManualAiProbe = z
  .object({
    contractVersion: z.literal(1),
    scope: z.literal('MANUAL_API_PROBE_UNVERIFIED_INFERENCE'),
    label: z.literal('Manual API Probe (Unverified Inference)'),
    status: z.literal('SUCCESS'),
    checkedAt: z.iso.datetime(),
    endpoint: z.literal('https://cloud-api.near.ai/v1/chat/completions'),
    requestedModel: model,
    returnedModel: model,
    httpStatus: z.literal(200),
    responseId: z.string().min(1).max(160),
    inferenceId: z.uuid(),
    requestSha256: sha256,
    responseSha256: sha256,
    expectedResponse: z.literal('NEAR_AI_OK'),
    responseMatched: z.literal(true),
    usage: z
      .object({
        promptTokens: z.number().int().nonnegative(),
        completionTokens: z.number().int().positive(),
        totalTokens: z.number().int().positive(),
      })
      .strict(),
    limits: z
      .object({
        maxCompletionTokens: z.literal(64),
        thinkingTokenBudget: z.literal(16),
        requestCeilingUsdMicros: z.literal('100000'),
        worstCaseUsdMicros: atoms,
      })
      .strict(),
    billing: z
      .object({
        status: z.enum(['PENDING', 'RECONCILED']),
        costNanoUsd: atoms.nullable(),
        costUsdMicros: atoms.nullable(),
        applicationBudgetHoldUsdMicros: atoms,
      })
      .strict(),
    organization: z
      .object({
        configured: z.literal(true),
        binding: z.literal('NOT_INDEPENDENTLY_VERIFIED'),
        detail: z.string().max(400),
      })
      .strict(),
    security: z
      .object({
        isolated: z.literal(true),
        teeWorkloadApproved: z.literal(false),
        responseSignatureVerified: z.literal(false),
        automatedExecutionEnabled: z.literal(false),
        treasuryInvoked: z.literal(false),
        treasuryFundsUsed: z.literal(false),
        blockchainTransactionsSubmitted: z.literal(0),
      })
      .strict(),
    inferenceRequests: z.literal(1),
    automatedInferenceRequests: z.literal(0),
    sources: z.array(z.url().refine((s) => new URL(s).origin === 'https://docs.near.ai')).length(2),
  })
  .strict()
  .superRefine((v, c) => {
    const b = v.billing;
    const reconciled = b.status === 'RECONCILED';
    if (
      v.usage.promptTokens + v.usage.completionTokens !== v.usage.totalTokens ||
      v.usage.completionTokens > v.limits.maxCompletionTokens ||
      BigInt(v.limits.worstCaseUsdMicros) > 100000n ||
      (reconciled && (b.costNanoUsd === null || b.costUsdMicros === null)) ||
      (!reconciled &&
        (b.costNanoUsd !== null ||
          b.costUsdMicros !== null ||
          b.applicationBudgetHoldUsdMicros !== '100000')) ||
      (reconciled &&
        b.costNanoUsd !== null &&
        b.costUsdMicros !== null &&
        (BigInt(b.costNanoUsd) <= 0n ||
          (BigInt(b.costNanoUsd) + 999n) / 1000n !== BigInt(b.costUsdMicros) ||
          b.applicationBudgetHoldUsdMicros !== b.costUsdMicros ||
          BigInt(b.costUsdMicros) > BigInt(v.limits.worstCaseUsdMicros)))
    )
      c.addIssue({ code: 'custom', message: 'Probe usage and bounded billing must reconcile' });
  });
export type ManualAiProbe = z.infer<typeof ManualAiProbe>;
