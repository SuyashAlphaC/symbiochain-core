import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
const receipt = z
  .object({ hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/), url: z.url() })
  .strict()
  .refine((r) => r.url === `https://nearblocks.io/txns/${r.hash}`);
export const MainnetProvisioning = z
  .object({
    contractVersion: z.literal(1),
    checkedAt: z.iso.datetime(),
    network: z.literal('mainnet'),
    scope: z.literal('OWNER_FUNDED_PROVISIONING_NOT_REVENUE'),
    status: z.literal('PARTIAL_REFUNDED'),
    funding: z
      .array(receipt.safeExtend({ label: z.string(), amountYocto: atoms, feeYocto: atoms }))
      .length(4),
    permissions: z.array(receipt.safeExtend({ label: z.string(), feeYocto: atoms })).length(2),
    conversions: z
      .array(
        z
          .object({
            asset: z.string(),
            status: z.enum(['SUCCESS', 'REFUNDED']),
            inputYocto: atoms,
            minimumOutputAtoms: atoms,
            actualOutputAtoms: atoms.nullable(),
            refundYocto: atoms,
            refundReceipts: z.array(receipt),
            destinationHashes: z.array(z.string()),
            reason: z.enum(['QUOTE_EXPIRED']).nullable(),
          })
          .strict(),
      )
      .length(3),
    capitalSentYocto: atoms,
    capitalReturnedYocto: atoms,
    retainedCapitalYocto: atoms,
    networkFeesYocto: atoms,
    additionalCeilingYocto: atoms,
    limits: z
      .object({
        maxTradeUsdcAtoms: atoms,
        maxDailyUsdcAtoms: atoms,
        maxSolLamports: atoms,
        maxDailySolLamports: atoms,
        nativeReserveYocto: atoms,
      })
      .strict(),
    paidInferenceRequests: z.literal(0),
    externalRevenueProven: z.literal(false),
    profitProven: z.literal(false),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      BigInt(v.capitalSentYocto) - BigInt(v.capitalReturnedYocto) !==
        BigInt(v.retainedCapitalYocto) ||
      v.conversions.reduce((n, r) => n + BigInt(r.refundYocto), 0n) !==
        BigInt(v.capitalReturnedYocto) ||
      v.conversions.some(
        (r) =>
          r.status === 'REFUNDED' &&
          (r.actualOutputAtoms !== null || r.refundReceipts.length === 0),
      )
    )
      c.addIssue({ code: 'custom', message: 'Provisioning outcomes do not reconcile' });
  });
export type MainnetProvisioning = z.infer<typeof MainnetProvisioning>;
