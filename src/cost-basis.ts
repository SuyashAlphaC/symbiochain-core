import { z } from 'zod';
import { Store, json } from './store.js';
import { DomainError, digest, atoms, type Settlement } from './domain.js';
export const CostApproval = z
  .object({
    settlementDigest: z.string().regex(/^[a-f0-9]{64}$/),
    inferenceCostUsdMicros: atoms,
    computeBaseAtoms: atoms,
    nativeGasBaseAtoms: atoms,
    hostingBaseAtoms: atoms,
    otherBaseAtoms: atoms,
    receiptBudgetBaseAtoms: atoms,
    approvedBy: z.string().min(2).max(80),
    sourceEvidence: z
      .object({
        nativeFeeEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        valuationMethod: z.string().min(10).max(4000),
        references: z.array(z.string().min(1).max(500)).min(1).max(20),
        includesNearGasAndHosting: z.literal(true),
      })
      .strict(),
  })
  .strict();
export async function approveCostBasis(store: Store, cycleId: string, input: unknown) {
  const data = CostApproval.parse(input),
    termsDigest = digest(data);
  return store.atomic(async (tx) => {
    const cycle = await tx.cycle.findFirstOrThrow({ where: { id: cycleId, mode: store.mode } });
    if (cycle.state !== 'RECONCILED')
      throw new DomainError(
        'COST_BASIS_STATE',
        'Cost approval requires a reconciled, unclosed cycle',
      );
    if (digest(cycle.settlement) !== data.settlementDigest)
      throw new DomainError(
        'COST_BASIS_BINDING',
        'Cost basis does not match this exact settlement',
      );
    const settlement = cycle.settlement as unknown as Settlement;
    if (
      digest(settlement.evidence.nativeFees ?? []) !== data.sourceEvidence.nativeFeeEvidenceDigest
    )
      throw new DomainError(
        'COST_BASIS_FEES',
        'Valuation does not identify the recorded native fee evidence',
      );
    const usage = await tx.computeUsage.findMany({ where: { cycleId } }),
      metered = usage.reduce((sum, row) => sum + BigInt(row.costUsdMicros), 0n);
    if (metered !== BigInt(data.inferenceCostUsdMicros))
      throw new DomainError(
        'COST_BASIS_COMPUTE',
        'Cost basis must identify all metered inference charges',
      );
    if (metered > 0n && BigInt(data.computeBaseAtoms) === 0n)
      throw new DomainError(
        'COST_BASIS_COMPUTE',
        'Positive metered costs require a positive base-asset valuation',
      );
    if (BigInt(data.receiptBudgetBaseAtoms) === 0n)
      throw new DomainError(
        'COST_BASIS_RECEIPT',
        'Include a conservative budget for finalization and NFT gas',
      );
    const existing = await tx.costBasis.findUnique({ where: { cycleId } });
    if (existing) {
      if (existing.termsDigest !== termsDigest)
        throw new DomainError('COST_BASIS_CONFLICT', 'Approved cost basis is immutable');
      return existing;
    }
    const basis = await tx.costBasis.create({
      data: {
        ...data,
        sourceEvidence: json(data.sourceEvidence),
        termsDigest,
        mode: store.mode,
        cycleId,
      },
    });
    await store.event(
      tx,
      'accounting.cost_basis_approved',
      { cycleId, termsDigest, approvedBy: data.approvedBy, trust: 'ACCOUNTANT_APPROVED' },
      cycleId,
    );
    await tx.job.updateMany({
      where: {
        cycleId,
        lane: 'HAND',
        doneAt: null,
        leaseToken: null,
        lastError: 'COST_BASIS_REQUIRED',
      },
      data: { availableAt: new Date() },
    });
    return basis;
  });
}
export function totalApprovedCost(basis: {
  computeBaseAtoms: string;
  nativeGasBaseAtoms: string;
  hostingBaseAtoms: string;
  otherBaseAtoms: string;
  receiptBudgetBaseAtoms: string;
}): bigint {
  return (
    BigInt(basis.computeBaseAtoms) +
    BigInt(basis.nativeGasBaseAtoms) +
    BigInt(basis.hostingBaseAtoms) +
    BigInt(basis.otherBaseAtoms) +
    BigInt(basis.receiptBudgetBaseAtoms)
  );
}
