// Additive publication contracts. v1 snapshot clients remain compatible.
import { z } from 'zod';
const amount = z.string().regex(/^-?\d{1,78}$/);
const id = z.uuid();
const time = z.iso.datetime();
const role = z.enum(['SCOUT', 'BRAIN', 'HAND']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ViewerStatus = z
  .object({
    contractVersion: z.literal(1),
    mode: z.literal('PAPER'),
    capturedAt: time,
    model: z.string().max(200),
    liveTradingEnabled: z.literal(false),
    measurementApprovalConfigured: z.boolean(),
    deploymentActionsApprovalConfigured: z.boolean(),
    computePurchaseImplemented: z.literal(false),
    providerCreditBalanceKnown: z.boolean(),
    computeControl: z
      .object({
        source: z.enum(['LOCAL_BUDGET', 'PROVIDER_BALANCE']),
        limitUsdMicros: amount.nullable(),
        committedUsdMicros: amount.nullable(),
        availableUsdMicros: amount.nullable(),
        halted: z.boolean().nullable(),
        providerBalanceVerified: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ViewerStatus = z.infer<typeof ViewerStatus>;
export const ViewerCycleSummary = z
  .object({
    id,
    mode: z.literal('PAPER'),
    state: z.string().max(40),
    strategy: z.enum(['round-trip', 'risk-assessment']),
    rejection: z.string().max(500).nullable(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export const ViewerCycles = z
  .object({
    contractVersion: z.literal(1),
    mode: z.literal('PAPER'),
    cycles: z.array(ViewerCycleSummary).max(25),
    nextCursor: id.nullable(),
  })
  .strict();
export type ViewerCycles = z.infer<typeof ViewerCycles>;
const ProfitCheck = z
  .object({
    inputAtoms: amount,
    quotedOutputAtoms: amount,
    minimumOutputAtoms: amount,
    quotedGrossPnlAtoms: amount,
    minimumGrossPnlAtoms: amount,
    previewCostAllowanceAtoms: amount,
    minimumNetAfterAllowanceAtoms: amount,
    profitFloorAtoms: amount,
    requiredMinimumOutputAtoms: amount,
    shortfallAtoms: amount,
    passesProfitFloor: z.boolean(),
    realized: z.literal(false),
    completeCostBasis: z.literal(false),
  })
  .strict();
export const ViewerCycle = z
  .object({
    contractVersion: z.literal(1),
    mode: z.literal('PAPER'),
    cycle: ViewerCycleSummary,
    baseAsset: z.string().max(200),
    baseDecimals: z.number().int().min(0).max(24),
    proposal: z
      .object({
        originChain: z.string().max(80),
        destinationChain: z.string().max(80),
        originAsset: z.string().max(200),
        intermediateAsset: z.string().max(200),
        amountAtoms: amount,
        slippageBps: z.number().int(),
      })
      .strict(),
    profitCheck: ProfitCheck.nullable(),
    decisions: z
      .array(z.object({ id, agent: role, action: z.string().max(100), timestamp: time }).strict())
      .max(100),
    jobs: z
      .array(
        z
          .object({
            id,
            lane: role,
            attempts: z.number().int().nonnegative(),
            lastError: z.string().max(80).nullable(),
            availableAt: time,
            doneAt: time.nullable(),
            leaseUntil: time.nullable(),
          })
          .strict(),
      )
      .max(100),
    economics: z
      .object({
        status: z.enum(['AWAITING_SETTLEMENT', 'AWAITING_COST_APPROVAL', 'ACCOUNTANT_APPROVED']),
        grossTradingPnlAtoms: amount.nullable(),
        inferenceCostUsdMicros: amount,
        totalApprovedCostAtoms: amount.nullable(),
        netAfterApprovedCostsAtoms: amount.nullable(),
        settlementFeesAtoms: amount.nullable(),
        approvalDigest: hash.nullable(),
        settlementDigest: hash.nullable(),
        nativeFeeEvidenceDigest: hash.nullable(),
        requestedShareBps: z.number().int().min(0).max(10000),
        requiresApprovalForRights: z.boolean(),
        independentlyVerifiedCosts: z.literal(false),
        survivalHours: z.null(),
      })
      .strict(),
    proofs: z
      .array(
        z
          .object({
            id,
            kind: z.string().max(80),
            status: z.string().max(80),
            model: z.string().max(200).nullable(),
            requestHash: hash.nullable(),
            responseHash: hash.nullable(),
            verifiedAt: time.nullable(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type ViewerCycle = z.infer<typeof ViewerCycle>;
export const ViewerEvents = z
  .object({
    contractVersion: z.literal(1),
    mode: z.literal('PAPER'),
    cursor: z.string().regex(/^\d{1,78}$/),
    hasMore: z.boolean(),
    events: z
      .array(
        z
          .object({
            seq: z.string().regex(/^\d{1,78}$/),
            topic: z.string().min(1).max(100),
            cycleId: id.nullable(),
            timestamp: time,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ViewerEvents = z.infer<typeof ViewerEvents>;
