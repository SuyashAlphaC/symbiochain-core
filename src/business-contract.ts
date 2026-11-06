import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d*)$/);
export const BusinessStatus = z
  .object({
    contractVersion: z.literal(1),
    capturedAt: z.iso.datetime(),
    coverage: z.literal('CLOSED_WINDOWS_ONLY'),
    mode: z.enum(['PAPER', 'LIVE', 'REPLAY']),
    simulated: z.boolean(),
    asset: z.string().nullable(),
    configured: z.boolean(),
    confirmedReceiptCount: z.number().int().nonnegative(),
    revenueAtoms: atoms,
    closedWindowCount: z.number().int().nonnegative(),
    receiptsAwaitingCostWindow: z.number().int().nonnegative(),
    netAfterReportedCostsAtoms: z
      .string()
      .regex(/^-?(0|[1-9]\d*)$/)
      .nullable(),
    costVerification: z.enum(['ACCOUNTANT_REPORTED', 'UNKNOWN']),
    independentlyVerifiedBusinessProfit: z.literal(false),
    fullBusinessRunway: z.null(),
    reservedAtoms: atoms,
    computePurchaseImplemented: z.literal(false),
    purchasedCreditsUsdMicros: z.literal('0'),
    businessFundedNftDistributions: z.number().int().nonnegative(),
    blockers: z.array(
      z.enum(['PROVIDER_PURCHASE_PROTOCOL_REQUIRED', 'EARNED_PROCEEDS_NFT_SETTLEMENT_UNPROVEN']),
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.simulated !== (v.mode === 'PAPER') ||
      (v.mode === 'PAPER' &&
        (v.confirmedReceiptCount !== 0 ||
          v.revenueAtoms !== '0' ||
          v.businessFundedNftDistributions !== 0))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Simulated activity cannot be published as external revenue',
      });
  });
