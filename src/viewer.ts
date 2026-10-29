import type { Store } from './store.js';
import { DomainError } from './domain.js';
import { summarizeCycleEconomics } from './economics.js';
import { ViewerSnapshot, ViewerProof } from './viewer-contract.js';

export function requirePaperViewer(store: Store) {
  if (store.mode !== 'PAPER')
    throw new DomainError(
      'VIEWER_MODE_FORBIDDEN',
      'Public viewer data is available only in PAPER mode',
      403,
    );
}

/** An explicit publication boundary: never return model input, signing material or arbitrary JSON. */
export async function viewerSnapshot(store: Store) {
  requirePaperViewer(store);
  return store.db.$transaction(
    async (tx) => {
      const mode = store.mode,
        asset = store.config.BASE_ASSET;
      const [
        balances,
        reserved,
        policy,
        usage,
        workers,
        decisions,
        transactions,
        proofs,
        history,
        events,
        highWater,
      ] = await Promise.all([
        tx.$queryRaw<
          { account: string; amount: string }[]
        >`SELECT p.account, SUM(p."amountAtoms")::text AS amount FROM "Posting" p JOIN "Journal" j ON j.id=p."journalId" WHERE j.mode::text=${mode} AND p.asset=${asset} GROUP BY p.account`,
        tx.reservation.aggregate({
          where: { mode, status: 'ACTIVE' },
          _sum: { amountAtoms: true },
        }),
        tx.policy.findUniqueOrThrow({ where: { mode } }),
        tx.$queryRaw<
          { amount: string }[]
        >`SELECT COALESCE(SUM("costUsdMicros"::numeric),0)::text AS amount FROM "ComputeUsage" WHERE mode::text=${mode}`,
        tx.workerControl.findMany({ orderBy: { role: 'asc' } }),
        tx.decision.findMany({
          where: { cycle: { mode } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 30,
          select: { id: true, cycleId: true, agent: true, action: true, createdAt: true },
        }),
        tx.chainTransaction.findMany({
          where: { cycle: { mode } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 30,
          select: {
            id: true,
            cycleId: true,
            createdAt: true,
            txHash: true,
            chainId: true,
            amountAtoms: true,
            asset: true,
          },
        }),
        tx.proof.findMany({
          where: { kind: 'EXECUTION_RECEIPT', cycle: { mode } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 30,
          include: {
            cycle: { include: { costBasis: true, usage: { select: { costUsdMicros: true } } } },
          },
        }),
        tx.$queryRaw<
          { timestamp: Date; balance: string }[]
        >`WITH deltas AS (SELECT date_trunc('hour',j."createdAt") AS timestamp,SUM(p."amountAtoms") AS delta FROM "Posting" p JOIN "Journal" j ON j.id=p."journalId" WHERE j.mode::text=${mode} AND p.account='TREASURY' AND p.asset=${asset} GROUP BY 1), curve AS (SELECT timestamp,SUM(delta) OVER(ORDER BY timestamp)::text AS balance FROM deltas) SELECT timestamp,balance FROM curve ORDER BY timestamp DESC LIMIT 168`,
        tx.outboxEvent.findMany({
          where: { mode },
          orderBy: { seq: 'desc' },
          take: 30,
          select: { seq: true, createdAt: true, topic: true, cycleId: true },
        }),
        tx.outboxEvent.aggregate({ where: { mode }, _max: { seq: true } }),
      ]);
      const balance = BigInt(balances.find((row) => row.account === 'TREASURY')?.amount ?? '0');
      const held = BigInt(reserved._sum.amountAtoms?.toFixed(0) ?? '0');
      const now = new Date().toISOString();
      return ViewerSnapshot.parse({
        contractVersion: 1,
        mode,
        capturedAt: now,
        cursor: (highWater._max.seq ?? 0n).toString(),
        treasury: {
          asset,
          decimals: store.config.BASE_DECIMALS,
          balanceAtoms: balance.toString(),
          availableAtoms: (balance - held).toString(),
          reservedAtoms: held.toString(),
          grossTradingPnlAtoms: (-BigInt(
            balances.find((row) => row.account === 'TRADING_PNL')?.amount ?? '0',
          )).toString(),
          minReserveAtoms: policy.minReserveAtoms.toFixed(0),
        },
        compute: { inferenceCostUsdMicros: usage[0]?.amount ?? '0', purchaseImplemented: false },
        survivalHours: null,
        paused: policy.paused,
        workers: workers.map((row) => ({
          role: row.role,
          paused: row.paused,
          heartbeat: row.heartbeat?.toISOString() ?? null,
        })),
        history: [...history]
          .reverse()
          .map((row) => ({ timestamp: row.timestamp.toISOString(), balanceAtoms: row.balance }))
          .concat([{ timestamp: now, balanceAtoms: balance.toString() }]),
        decisions: decisions.map((row) => ({
          id: row.id,
          cycleId: row.cycleId,
          timestamp: row.createdAt.toISOString(),
          agent: row.agent,
          action: row.action,
          details: `The ${row.agent} lane recorded ${row.action} for this PAPER cycle. Financial results and execution evidence are simulated.`,
        })),
        transactions: transactions.map((row) => ({
          id: row.id,
          cycleId: row.cycleId,
          timestamp: row.createdAt.toISOString(),
          txHash: row.txHash,
          chainId: row.chainId,
          amountAtoms: row.amountAtoms,
          asset: row.asset,
          decimals: row.asset === asset ? store.config.BASE_DECIMALS : null,
          status: 'SIMULATED',
        })),
        receipts: proofs.map((row) => {
          const economics = summarizeCycleEconomics(
            row.cycle,
            row.cycle.costBasis,
            row.cycle.usage,
            store.config,
          );
          const details = (row.publicDetails ?? {}) as Record<string, unknown>;
          return {
            id: row.id,
            cycleId: row.cycleId,
            timestamp: row.createdAt.toISOString(),
            mintedOnChain: false,
            status: 'SIMULATED',
            shareBps:
              typeof details.simulatedRightsBps === 'number' ? details.simulatedRightsBps : null,
            grossPnlAtoms: economics.grossTradingPnlAtoms,
            approvedNetPnlAtoms: economics.netAfterApprovedCostsAtoms,
            approvalDigest: economics.approvalDigest,
          };
        }),
        events: events.map((row) => ({
          seq: row.seq.toString(),
          timestamp: row.createdAt.toISOString(),
          topic: row.topic,
          cycleId: row.cycleId,
        })),
      });
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000, maxWait: 10000 },
  );
}

export async function viewerProof(store: Store, hash: string) {
  requirePaperViewer(store);
  const proof = await store.db.proof.findFirst({
    where: {
      kind: 'NEAR_AI',
      status: 'VERIFIED',
      cycle: { mode: store.mode },
      OR: [{ requestHash: hash }, { responseHash: hash }],
    },
    select: {
      id: true,
      model: true,
      signer: true,
      measurement: true,
      requestHash: true,
      responseHash: true,
      verifiedAt: true,
    },
  });
  if (!proof)
    throw new DomainError(
      'NOT_FOUND',
      'No recorded verified NEAR AI inference matches this hash',
      404,
    );
  return ViewerProof.parse({
    ...proof,
    verifiedAt: proof.verifiedAt?.toISOString() ?? null,
    contractVersion: 1,
    mode: store.mode,
    scope: 'RECORDED_VERIFICATION',
    freshAttestationPerformed: false,
  });
}
