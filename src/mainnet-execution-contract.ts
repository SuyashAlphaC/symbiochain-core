import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
const nearReceipt = z
  .object({
    hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
    step: z.string(),
    signerId: z.string(),
    receiverId: z.string(),
    actualFeeYocto: atoms,
    blockHash: z.string(),
    final: z.literal(true),
    succeeded: z.literal(true),
    url: z.url(),
  })
  .strict()
  .refine((r) => r.url === `https://nearblocks.io/txns/${r.hash}`);
export const MainnetOwnedExecution = z
  .object({
    contractVersion: z.literal(1),
    checkedAt: z.iso.datetime(),
    scope: z.literal('OWNER_AUTHORIZED_MAINNET_MPC_EXECUTION_FIXTURES'),
    network: z.literal('mainnet'),
    results: z
      .array(
        z
          .object({
            checkedAt: z.iso.datetime(),
            id: z.string(),
            chain: z.enum(['eip155:8453', 'solana:mainnet']),
            source: z.string(),
            recipient: z.string(),
            asset: z.string(),
            amountAtoms: atoms,
            txHash: z.string(),
            explorerUrl: z.url(),
            destinationFinal: z.literal(true),
            destinationNativeFeeAtoms: atoms,
            nativeReceipts: z.array(nearReceipt).length(4),
            contractStatus: z.literal('CLOSED'),
            grossPnlAtoms: z.literal('0'),
            netProfitProven: z.literal(false),
            sourceClassification: z.literal('OWNER_AUTHORIZATION_FIXTURE_NOT_AI'),
          })
          .strict()
          .refine(
            (r) =>
              r.explorerUrl ===
              (r.chain === 'eip155:8453' ? 'https://basescan.org/tx/' : 'https://solscan.io/tx/') +
                r.txHash,
          ),
      )
      .length(2),
    executionNativeFeesYocto: atoms,
    allContinuationNativeFeesYocto: atoms,
    retainedCapitalInputYocto: atoms,
    additionalPlanningCeilingYocto: atoms,
    paidInferenceRequests: z.literal(0),
    teeApproved: z.literal(false),
    marketSwapProven: z.literal(false),
    externalRevenueProven: z.literal(false),
    netProfitProven: z.literal(false),
    nftMinted: z.literal(false),
  })
  .strict()
  .superRefine((v, c) => {
    const sum = v.results
      .flatMap((r) => r.nativeReceipts)
      .reduce((n, r) => n + BigInt(r.actualFeeYocto), 0n);
    if (
      sum !== BigInt(v.executionNativeFeesYocto) ||
      BigInt(v.allContinuationNativeFeesYocto) + BigInt(v.retainedCapitalInputYocto) >
        BigInt(v.additionalPlanningCeilingYocto)
    )
      c.addIssue({ code: 'custom', message: 'Execution fee evidence does not reconcile' });
  });
export type MainnetOwnedExecution = z.infer<typeof MainnetOwnedExecution>;
