import type { Store } from './store.js';
import { DomainError, digest, Proposal, type Settlement } from './domain.js';
import { totalApprovedCost } from './cost-basis.js';
import type { Cycle, CostBasis } from './generated/prisma/client.js';
import type { Config } from './config.js';

/** Cost approvals include a finalization budget; they are not independently verified realized costs. */
export async function cycleEconomics(store: Store, cycleId: string) {
  const cycle = await store.getCycle(cycleId);
  const [basis, usage] = await Promise.all([
    store.db.costBasis.findUnique({ where: { cycleId } }),
    store.db.computeUsage.findMany({ where: { cycleId }, select: { costUsdMicros: true } }),
  ]);
  return summarizeCycleEconomics(cycle, basis, usage, store.config);
}

export function summarizeCycleEconomics(
  cycle: Cycle,
  basis: CostBasis | null,
  usage: { costUsdMicros: string }[],
  config: Config,
) {
  const metered = usage.reduce((total, row) => total + BigInt(row.costUsdMicros), 0n);
  const settlement = cycle.settlement as unknown as Settlement | null;
  const settled = settlement?.status === 'SUCCESS';
  const proposal = Proposal.parse(cycle.proposal);
  const gross = settled ? BigInt(settlement.receivedAtoms) - BigInt(proposal.amountAtoms) : null;
  const settlementFees = settled ? BigInt(settlement.feesAtoms) : null;
  const settlementDigest = settled ? digest(settlement) : null;
  const nativeFeeEvidenceDigest = settled ? digest(settlement.evidence.nativeFees ?? []) : null;
  if (
    basis &&
    (basis.settlementDigest !== settlementDigest ||
      (basis.sourceEvidence &&
        (basis.sourceEvidence as Record<string, unknown>).nativeFeeEvidenceDigest !==
          nativeFeeEvidenceDigest) ||
      BigInt(basis.inferenceCostUsdMicros) !== metered)
  )
    throw new DomainError(
      'COST_BASIS_STALE',
      'Approved costs no longer match this settlement and billing',
    );
  const costs = basis
    ? {
        computeBaseAtoms: basis.computeBaseAtoms,
        nativeGasBaseAtoms: basis.nativeGasBaseAtoms,
        hostingBaseAtoms: basis.hostingBaseAtoms,
        otherBaseAtoms: basis.otherBaseAtoms,
        receiptBudgetBaseAtoms: basis.receiptBudgetBaseAtoms,
      }
    : null;
  return {
    cycleId: cycle.id,
    mode: cycle.mode,
    baseAsset: config.BASE_ASSET,
    baseDecimals: config.BASE_DECIMALS,
    status: basis
      ? ('ACCOUNTANT_APPROVED' as const)
      : settled
        ? ('AWAITING_COST_APPROVAL' as const)
        : ('AWAITING_SETTLEMENT' as const),
    simulated: cycle.mode === 'PAPER',
    grossTradingPnlAtoms: gross?.toString() ?? null,
    inferenceCostUsdMicros: metered.toString(),
    costs,
    totalApprovedCostAtoms: basis ? totalApprovedCost(basis).toString() : null,
    settlementFeesAtoms: settlementFees?.toString() ?? null,
    totalCostsIncludingSettlementFeesAtoms:
      basis && settlementFees !== null
        ? (totalApprovedCost(basis) + settlementFees).toString()
        : null,
    netAfterApprovedCostsAtoms:
      basis && gross !== null
        ? (gross - BigInt(settlement!.feesAtoms) - totalApprovedCost(basis)).toString()
        : null,
    includesFinalizationBudget: true,
    independentlyVerifiedCosts: false,
    approvedBy: basis?.approvedBy ?? null,
    approvalDigest: basis?.termsDigest ?? null,
    settlementDigest,
    nativeFeeEvidenceDigest,
    nativeFeeEvidence: settled ? (settlement.evidence.nativeFees ?? []) : [],
    sourceEvidence: basis?.sourceEvidence ?? null,
    requestedShareBps: config.NFT_SHARE_BPS,
    requiresApprovalForRights: config.NFT_SHARE_BPS > 0,
    survivalHours: null,
    runwayReason:
      'A complete business expense observation window and funding valuation are not recorded',
  };
}

export type CycleEconomics = Awaited<ReturnType<typeof cycleEconomics>>;
