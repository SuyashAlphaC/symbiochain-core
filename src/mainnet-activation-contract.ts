import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
export const MainnetActivationProof = z
  .object({
    contractVersion: z.literal(1),
    profile: z.literal('BOUNDED_OWNER_ACTIVATION_TEE_QUARANTINED'),
    status: z.enum(['PENDING', 'PARTIAL', 'COMPLETE']),
    checkedAt: z.iso.datetime().nullable(),
    transactions: z
      .array(
        z
          .object({
            hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
            step: z.enum([
              'brain_key',
              'brain_register',
              'hand_key',
              'hand_register',
              'activate',
              'owner_probe',
            ]),
            url: z.url().refine((s) => s.startsWith('https://nearblocks.io/txns/')),
            actualFeeYocto: atoms,
          })
          .strict(),
      )
      .max(6),
    totalFeeYocto: atoms,
    newStorageYocto: atoms,
    treasuryTopupYocto: z.literal('0'),
    paidInferenceRequests: z.literal(0),
    externalRevenueProven: z.literal(false),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      (r.status === 'PENDING' && r.transactions.length !== 0) ||
      (r.status === 'PARTIAL' && (!r.transactions.length || r.transactions.length === 6)) ||
      (r.status === 'COMPLETE' && r.transactions.length !== 6)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Proof status must match confirmed transaction coverage',
      });
    if (
      new Set(r.transactions.map((t) => t.hash)).size !== r.transactions.length ||
      new Set(r.transactions.map((t) => t.step)).size !== r.transactions.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate activation proofs' });
    if (
      BigInt(r.totalFeeYocto) !== r.transactions.reduce((n, t) => n + BigInt(t.actualFeeYocto), 0n)
    )
      ctx.addIssue({ code: 'custom', message: 'Activation fees must reconcile' });
  });
export const MainnetActivation = z
  .object({
    contractVersion: z.literal(1),
    network: z.literal('mainnet'),
    capturedAt: z.iso.datetime(),
    ownerActivation: z.enum(['PENDING', 'PARTIAL', 'ACTIVE']),
    paused: z.boolean(),
    enabledWorkerCount: z.number().int().min(0).max(3),
    executionEnabled: z.boolean(),
    automaticTradingEnabled: z.boolean(),
    monitorOnlyWorkers: z.boolean(),
    proof: MainnetActivationProof,
    monitors: z
      .array(
        z
          .object({
            role: z.enum(['SCOUT', 'BRAIN', 'HAND']),
            heartbeat: z.iso.datetime().nullable(),
            fresh: z.boolean(),
          })
          .strict(),
      )
      .max(3),
    configuration: z
      .object({
        scope: z.literal('CONFIGURATION_PRESENCE'),
        treasurySigningKeys: z.number().int().min(0).max(3),
        dedicatedIntentsKeys: z.number().int().min(0).max(2),
        evmRpcConfigured: z.boolean(),
        nftReceiver: z.string().max(64),
      })
      .strict(),
    intentsRegistration: z
      .object({
        brain: z.enum(['REGISTERED', 'NOT_REGISTERED', 'UNAVAILABLE']),
        hand: z.enum(['REGISTERED', 'NOT_REGISTERED', 'UNAVAILABLE']),
      })
      .strict(),
    limits: z
      .object({
        asset: z.literal('USDC'),
        decimals: z.literal(6),
        onChainMaxTradeAtoms: atoms,
        onChainMaxDailyAtoms: atoms,
        configuredMaxTradeAtoms: atoms,
        configuredMaxDailyAtoms: atoms,
        matches: z.boolean(),
        scope: z.literal('AUTHORIZED_CROSS_CHAIN_TRANSFERS'),
        universalNativeSpendingCap: z.literal(false),
        nativeReserveYocto: atoms,
        mpcSigningDepositLimitYocto: atoms,
      })
      .strict(),
    tee: z
      .object({
        status: z.literal('QUARANTINED'),
        reason: z.literal('APPLICATION_WORKLOAD_MEASUREMENT_POLICY'),
        message: z.literal(
          'Inference blocked by application-level TEE workload measurement policy.',
        ),
      })
      .strict(),
    externalRevenueProven: z.literal(false),
    automaticCreditPurchaseImplemented: z.literal(false),
  })
  .strict();
export type MainnetActivation = z.infer<typeof MainnetActivation>;
