import type { Store } from './store.js';
import { z } from 'zod';
import { Proposal, Quote } from './domain.js';
import { cycleEconomics } from './economics.js';
import { quoteProfitCheck } from './policy.js';
import { requirePaperViewer } from './viewer.js';
import {
  ViewerStatus,
  ViewerCycles,
  ViewerCycle,
  ViewerEvents,
} from './viewer-details-contract.js';
const summarySelect = {
  id: true,
  mode: true,
  state: true,
  strategy: true,
  rejection: true,
  createdAt: true,
  updatedAt: true,
} as const;
const safeCode = (value: string | null) =>
  value && /^[A-Z0-9_,]{1,500}$/.test(value) ? value : value ? 'PROVIDER_FAILURE' : null;
const summary = <T extends { createdAt: Date; updatedAt: Date; rejection: string | null }>(
  row: T,
) => ({
  ...row,
  rejection: safeCode(row.rejection),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
export async function viewerStatus(store: Store) {
  requirePaperViewer(store);
  const s = await store.snapshot(),
    c = store.config,
    control = z
      .object({
        source: z.enum(['LOCAL_BUDGET', 'PROVIDER_BALANCE']),
        providerBalanceVerified: z.boolean(),
        limitUsdMicros: z.string().optional(),
        committedUsdMicros: z.string().optional(),
        availableUsdMicros: z.string().optional(),
        halted: z.boolean().optional(),
      })
      .parse(s.computeControl);
  const local = control.source === 'LOCAL_BUDGET' ? control : null;
  return ViewerStatus.parse({
    contractVersion: 1,
    mode: store.mode,
    capturedAt: new Date().toISOString(),
    model: c.NEAR_AI_MODEL,
    liveTradingEnabled: false,
    measurementApprovalConfigured: !!(
      c.TEE_GATEWAY_COMPOSE_HASHES.length && c.TEE_MODEL_COMPOSE_HASHES.length
    ),
    deploymentActionsApprovalConfigured: !!c.TEE_MODEL_ACTIONS_HASHES.length,
    computePurchaseImplemented: false,
    providerCreditBalanceKnown: control.providerBalanceVerified,
    computeControl: {
      source: control.source,
      limitUsdMicros: local?.limitUsdMicros ?? null,
      committedUsdMicros: local?.committedUsdMicros ?? null,
      availableUsdMicros: local?.availableUsdMicros ?? null,
      halted: local?.halted ?? null,
      providerBalanceVerified: control.providerBalanceVerified,
    },
  });
}
export async function viewerCycles(store: Store, cursor?: string) {
  requirePaperViewer(store);
  if (cursor) await store.getCycle(cursor);
  const rows = await store.db.cycle.findMany({
    where: { mode: store.mode },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 26,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: summarySelect,
  });
  return ViewerCycles.parse({
    contractVersion: 1,
    mode: store.mode,
    cycles: rows.slice(0, 25).map(summary),
    nextCursor: rows.length > 25 ? rows[24]!.id : null,
  });
}
export async function viewerCycle(store: Store, id: string) {
  requirePaperViewer(store);
  const cycle = await store.getCycle(id),
    p = Proposal.parse(cycle.proposal);
  const [policy, decisions, jobs, proofs, economics] = await Promise.all([
    store.db.policy.findUniqueOrThrow({ where: { mode: store.mode } }),
    store.db.decision.findMany({
      where: { cycleId: id },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, agent: true, action: true, createdAt: true },
    }),
    store.db.job.findMany({
      where: { cycleId: id },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        lane: true,
        attempts: true,
        lastError: true,
        availableAt: true,
        doneAt: true,
        leaseUntil: true,
      },
    }),
    store.db.proof.findMany({
      where: { cycleId: id },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        model: true,
        requestHash: true,
        responseHash: true,
        verifiedAt: true,
      },
    }),
    cycleEconomics(store, id),
  ]);
  return ViewerCycle.parse({
    contractVersion: 1,
    mode: store.mode,
    cycle: summary({
      id: cycle.id,
      mode: cycle.mode,
      state: cycle.state,
      strategy: cycle.strategy,
      rejection: cycle.rejection,
      createdAt: cycle.createdAt,
      updatedAt: cycle.updatedAt,
    }),
    baseAsset: store.config.BASE_ASSET,
    baseDecimals: store.config.BASE_DECIMALS,
    proposal: {
      originChain: p.originChain,
      destinationChain: p.destinationChain,
      originAsset: p.originAsset,
      intermediateAsset: p.intermediateAsset,
      amountAtoms: p.amountAtoms,
      slippageBps: p.slippageBps,
    },
    profitCheck: cycle.quote
      ? quoteProfitCheck(Quote.parse(cycle.quote), policy.minNetProfitAtoms.toFixed(0))
      : null,
    decisions: decisions.map((d) => ({
      id: d.id,
      agent: d.agent,
      action: d.action,
      timestamp: d.createdAt.toISOString(),
    })),
    jobs: jobs.map((j) => ({
      ...j,
      lastError: safeCode(j.lastError)?.slice(0, 80) ?? null,
      availableAt: j.availableAt.toISOString(),
      doneAt: j.doneAt?.toISOString() ?? null,
      leaseUntil: j.leaseUntil?.toISOString() ?? null,
    })),
    economics: {
      status: economics.status,
      grossTradingPnlAtoms: economics.grossTradingPnlAtoms,
      inferenceCostUsdMicros: economics.inferenceCostUsdMicros,
      totalApprovedCostAtoms: economics.totalApprovedCostAtoms,
      netAfterApprovedCostsAtoms: economics.netAfterApprovedCostsAtoms,
      settlementFeesAtoms: economics.settlementFeesAtoms,
      approvalDigest: economics.approvalDigest,
      settlementDigest: economics.settlementDigest,
      nativeFeeEvidenceDigest: economics.nativeFeeEvidenceDigest,
      requestedShareBps: economics.requestedShareBps,
      requiresApprovalForRights: economics.requiresApprovalForRights,
      independentlyVerifiedCosts: false,
      survivalHours: null,
    },
    proofs: proofs.map((r) => ({ ...r, verifiedAt: r.verifiedAt?.toISOString() ?? null })),
  });
}
export async function viewerEvents(store: Store, after: string) {
  requirePaperViewer(store);
  const rows = await store.db.outboxEvent.findMany({
    where: { mode: store.mode, seq: { gt: BigInt(after) } },
    orderBy: { seq: 'asc' },
    take: 101,
    select: { seq: true, topic: true, cycleId: true, createdAt: true },
  });
  const selected = rows.slice(0, 100);
  return ViewerEvents.parse({
    contractVersion: 1,
    mode: store.mode,
    cursor: selected.at(-1)?.seq.toString() ?? after,
    hasMore: rows.length > 100,
    events: selected.map((e) => ({
      seq: e.seq.toString(),
      topic: e.topic,
      cycleId: e.cycleId,
      timestamp: e.createdAt.toISOString(),
    })),
  });
}
