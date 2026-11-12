import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
const receipt = z
  .object({ hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/), url: z.url() })
  .strict()
  .refine((r) => r.url === `https://nearblocks.io/txns/${r.hash}`, 'Receipt link mismatch');
export const MainnetSettlementFixture = z
  .object({
    contractVersion: z.literal(1),
    network: z.literal('mainnet'),
    scope: z.literal('TEAM_FUNDED_INTERNAL_INTENTS_SETTLEMENT'),
    checkedAt: z.iso.datetime(),
    funding: receipt,
    payments: z
      .array(
        z
          .object({
            receipt,
            payer: z.string().max(64),
            recipient: z.string().max(64),
            amountYocto: atoms,
            nonceConfirmed: z.literal(true),
            nativeFeeYocto: atoms,
          })
          .strict(),
      )
      .length(2),
    allowanceRepairs: z.array(receipt).length(2),
    totalNetworkFeesYocto: atoms,
    fundedCapitalYocto: atoms,
    storageCollateralYocto: atoms,
    totalPlanningCeilingYocto: atoms,
    paidInferenceRequests: z.literal(0),
    teeApprovalClaimed: z.literal(false),
    externalRevenueProven: z.literal(false),
    marketSwapPerformed: z.literal(false),
  })
  .strict();
export type MainnetSettlementFixture = z.infer<typeof MainnetSettlementFixture>;
