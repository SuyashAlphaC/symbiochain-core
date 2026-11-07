import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
export const RuntimeStatus = z
  .object({
    contractVersion: z.literal(1),
    mode: z.enum(['PAPER', 'LIVE', 'REPLAY']),
    executionEnabled: z.boolean(),
    network: z.enum(['mainnet', 'testnet', 'sandbox']),
    mainnetAvailable: z.boolean(),
  })
  .strict();
export const MainnetSnapshot = z
  .object({
    contractVersion: z.literal(1),
    mode: z.literal('LIVE'),
    network: z.literal('mainnet'),
    capturedAt: z.iso.datetime(),
    block: z.object({ height: atoms, hash: z.string(), timestamp: z.iso.datetime() }).strict(),
    executionEnabled: z.boolean(),
    ownerAccount: z.string(),
    treasuryAccount: z.string(),
    code: z
      .object({ expectedHash: z.string(), observedHash: z.string(), matches: z.boolean() })
      .strict(),
    paused: z.boolean(),
    accounts: z
      .array(
        z
          .object({
            role: z.enum(['OWNER', 'TREASURY', 'SCOUT', 'BRAIN', 'HAND', 'ACCOUNTANT']),
            accountId: z.string(),
            balanceYocto: atoms,
            storageYocto: atoms,
            availableYocto: atoms,
            storageBytes: z.number().int().nonnegative(),
            fullAccessKeyCount: z.number().int().nonnegative(),
            scopedKeyCount: z.number().int().nonnegative(),
            recoveryKeyPresent: z.boolean(),
            workerEnabled: z.boolean().nullable(),
          })
          .strict(),
      )
      .length(6),
    policy: z
      .object({
        maxTradeAtoms: atoms,
        maxDailyAtoms: atoms,
        minReserveYocto: atoms,
        placeholderLimits: z.boolean(),
      })
      .strict(),
    nfts: z
      .object({
        totalSupply: atoms,
        revenueShareBps: z.number().int().min(0).max(10000),
        distributionLiabilityYocto: atoms.nullable(),
      })
      .strict(),
    compute: z
      .object({
        model: z.string(),
        totalBudgetUsdMicros: atoms,
        maxRequestUsdMicros: atoms,
        deploymentApproval: z.literal('QUARANTINED'),
        automaticCreditPurchase: z.literal(false),
      })
      .strict(),
    deployment: z
      .object({
        verifiedAt: z.iso.datetime(),
        temporaryKeyRevoked: z.boolean(),
        transactions: z
          .array(
            z
              .object({
                hash: z.string(),
                label: z.string(),
                signerId: z.string(),
                receiverId: z.string(),
                url: z.url(),
              })
              .strict(),
          )
          .max(30),
      })
      .strict(),
    blockers: z.array(z.string()).max(20),
    survivalHours: z.null(),
    externalRevenueProven: z.literal(false),
  })
  .strict();
export const MainnetTransaction = z
  .object({
    contractVersion: z.literal(1),
    network: z.literal('mainnet'),
    hash: z.string(),
    signerId: z.string(),
    receiverId: z.string(),
    succeeded: z.boolean(),
    final: z.boolean(),
    blockHash: z.string(),
    url: z.url(),
    verifiedAt: z.iso.datetime(),
    classification: z.literal('DEPLOYMENT_NOT_REVENUE'),
  })
  .strict();
export const MainnetWallet = z
  .object({
    network: z.literal('mainnet'),
    accountId: z.string(),
    balanceYocto: atoms,
    storageYocto: atoms,
    availableYocto: atoms,
    blockHash: z.string(),
  })
  .strict();
