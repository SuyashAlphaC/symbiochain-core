import { z } from 'zod';

export const ManualTopupReport = z
  .object({
    reference: z.string().regex(/^topup:[a-f0-9-]{36}$/),
    organizationId: z.string().min(1).max(100),
    receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reportedCreditUsdMicros: z.string().regex(/^[1-9]\d{0,12}$/),
    fundingSource: z.enum(['OPERATOR_FUNDED', 'EARNED_PROCEEDS_REPORTED']),
  })
  .strict();

export const ManualTopupTask = z
  .object({
    reference: z.string().regex(/^topup:[a-f0-9-]{36}$/),
    organizationId: z.string().min(1).max(100),
    spendBudgetAtoms: z.string().regex(/^[1-9]\d{0,76}$/),
    requestedCreditUsdMicros: z.string().regex(/^[1-9]\d{0,12}$/),
    state: z.enum(['WAITING_OPERATOR', 'OPERATOR_REPORTED_UNVERIFIED']),
    simulated: z.boolean(),
    providerVerified: z.literal(false),
  })
  .strict();

export const OperatingStatus = z
  .object({
    contractVersion: z.literal(1),
    capturedAt: z.iso.datetime(),
    mode: z.enum(['PAPER', 'LIVE', 'REPLAY']),
    tee: z
      .object({
        status: z.literal('QUARANTINED'),
        inferenceGate: z.literal('CLOSED'),
        auditCapturedAt: z.iso.datetime(),
        signedInferenceVerified: z.literal(false),
        demoInference: z.literal('LOCAL_SIMULATION'),
      })
      .strict(),
    bridge: z
      .object({
        status: z.literal('HUMAN_IN_THE_LOOP'),
        waitingOperator: z.number().int().nonnegative(),
        operatorReported: z.number().int().nonnegative(),
        providerVerifiedPurchases: z.literal(0),
        automaticPurchasesEnabled: z.literal(false),
      })
      .strict(),
    revenue: z
      .object({
        status: z.enum(['UNPROVEN', 'RECEIPTS_RECORDED_DEMAND_UNPROVEN']),
        confirmedReceiptCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const receipts = value.revenue.confirmedReceiptCount;
    if (
      (value.mode === 'PAPER' && receipts !== 0) ||
      value.revenue.status !== (receipts ? 'RECEIPTS_RECORDED_DEMAND_UNPROVEN' : 'UNPROVEN')
    )
      context.addIssue({
        code: 'custom',
        message: 'Simulations cannot establish external revenue or demand',
      });
  });
