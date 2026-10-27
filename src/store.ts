import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { Prisma, type Cycle, type Job, type CycleState } from './generated/prisma/client.js';
import type { Config } from './config.js';
import {
  Proposal,
  DomainError,
  assertTransition,
  digest,
  type Mode,
  type Usage,
} from './domain.js';

export type Tx = Prisma.TransactionClient;
export const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export interface ClaimedJob extends Job {
  leaseToken: string;
}
export type PostingInput = { account: string; asset: string; amountAtoms: bigint };

export class Store {
  constructor(
    public readonly db: Database,
    public readonly config: Config,
  ) {}
  get mode(): Mode {
    return this.config.EXECUTION_MODE;
  }

  async atomic<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(work, {
          isolationLevel: 'Serializable',
          maxWait: 10000,
          timeout: 15000,
        });
      } catch (e) {
        if (
          attempt < 4 &&
          e instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2034', 'P2002'].includes(e.code)
        )
          continue;
        throw e;
      }
    }
  }

  async initialize(): Promise<void> {
    const c = this.config;
    await this.db.policy.upsert({
      where: { mode: this.mode },
      update: {},
      create: {
        mode: this.mode,
        maxTradeAtoms: c.MAX_TRADE_ATOMS,
        maxDailySpendAtoms: c.MAX_DAILY_SPEND_ATOMS,
        minReserveAtoms: c.MIN_RESERVE_ATOMS,
        minNetProfitAtoms: c.MIN_NET_PROFIT_ATOMS,
        maxSlippageBps: c.MAX_SLIPPAGE_BPS,
        allowedAssets: c.ALLOWED_ASSETS,
        allowedChains: c.ALLOWED_CHAINS,
        allowedRecipients: c.ALLOWED_RECIPIENTS,
      },
    });
    for (const role of ['SCOUT', 'BRAIN', 'HAND'])
      await this.db.workerControl.upsert({ where: { role }, update: {}, create: { role } });
  }

  async event(
    tx: Tx,
    topic: string,
    payload: unknown,
    cycleId: string | null = null,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: { mode: this.mode, topic, cycleId, payload: json(payload) },
    });
  }

  async enqueue(
    tx: Tx,
    cycleId: string,
    lane: string,
    version: number,
    delayMs = 0,
  ): Promise<void> {
    const dedupKey = `${cycleId}:${lane}:${version}`;
    await tx.job.upsert({
      where: { dedupKey },
      update: {},
      create: { cycleId, lane, dedupKey, availableAt: new Date(Date.now() + delayMs) },
    });
  }

  async createCycle(
    input: unknown,
    idempotencyKey: string,
  ): Promise<{ cycle: Cycle; created: boolean }> {
    if (this.mode === 'REPLAY')
      throw new DomainError('READ_ONLY_MODE', 'Replay mode cannot create transactions', 403);
    const p = Proposal.parse(input);
    if (Date.parse(p.expiresAt) <= Date.now())
      throw new DomainError('EXPIRED', 'Proposal has expired', 400);
    if (Date.parse(p.expiresAt) > Date.now() + 60 * 60 * 1000)
      throw new DomainError('DEADLINE_TOO_LONG', 'Maximum proposal lifetime is one hour', 400);
    return this.atomic(async (tx) => {
      const existing = await tx.cycle.findUnique({
        where: { mode_idempotencyKey: { mode: this.mode, idempotencyKey } },
      });
      if (existing) {
        if (digest(existing.proposal) !== digest(p))
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Key already identifies another proposal');
        return { cycle: existing, created: false };
      }
      const cycle = await tx.cycle.create({
        data: {
          mode: this.mode,
          idempotencyKey,
          strategy: p.strategy,
          proposal: json(p),
          expiresAt: new Date(p.expiresAt),
        },
      });
      await this.enqueue(tx, cycle.id, 'SCOUT', 0);
      await this.event(
        tx,
        'cycle.created',
        { id: cycle.id, state: cycle.state, proposal: p },
        cycle.id,
      );
      return { cycle, created: true };
    });
  }

  async getCycle(id: string): Promise<Cycle> {
    const cycle = await this.db.cycle.findFirst({ where: { id, mode: this.mode } });
    if (!cycle) throw new DomainError('NOT_FOUND', 'Cycle not found', 404);
    return cycle;
  }

  async claim(lanes: string[]): Promise<ClaimedJob | null> {
    const token = randomUUID();
    const result = await this.db.$queryRaw<ClaimedJob[]>`
      WITH candidate AS (
        SELECT j.id FROM "Job" j JOIN "Cycle" c ON c.id=j."cycleId"
        JOIN "WorkerControl" w ON w.role=j.lane
        WHERE j."doneAt" IS NULL AND j."availableAt" <= NOW()
          AND (j."leaseUntil" IS NULL OR j."leaseUntil" < NOW())
          AND j.lane = ANY(${lanes}::text[]) AND c.mode::text=${this.mode}
          AND w.paused=false
        ORDER BY j."availableAt", j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      )
      UPDATE "Job" j SET "leaseToken"=${token},
        "leaseUntil"=NOW()+(${this.config.WORKER_LEASE_MS} * INTERVAL '1 millisecond'), attempts=j.attempts+1
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`;
    return result[0] ?? null;
  }

  async renew(job: ClaimedJob): Promise<boolean> {
    const result = await this.db.job.updateMany({
      where: {
        id: job.id,
        leaseToken: job.leaseToken,
        doneAt: null,
        leaseUntil: { gt: new Date() },
      },
      data: { leaseUntil: new Date(Date.now() + this.config.WORKER_LEASE_MS) },
    });
    return result.count === 1;
  }

  async guardJob(tx: Tx, job: ClaimedJob): Promise<void> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Job" WHERE id=${job.id} AND "leaseToken"=${job.leaseToken} AND "doneAt" IS NULL AND "leaseUntil">NOW() FOR UPDATE`;
    if (rows.length !== 1) throw new DomainError('LEASE_LOST', 'Worker no longer owns this job');
  }

  async advance(
    job: ClaimedJob,
    expected: CycleState,
    next: CycleState,
    patch: Prisma.CycleUpdateInput,
    details: unknown,
    lane: string | null,
    work?: (tx: Tx, cycle: Cycle) => Promise<void>,
  ): Promise<void> {
    assertTransition(expected, next);
    await this.atomic(async (tx) => {
      await this.guardJob(tx, job);
      const cycle = await tx.cycle.findFirstOrThrow({
        where: { id: job.cycleId, mode: this.mode },
      });
      if (cycle.state !== expected)
        throw new DomainError('STALE_STATE', `Expected ${expected}, got ${cycle.state}`);
      if (work) await work(tx, cycle);
      const result = await tx.cycle.updateMany({
        where: { id: cycle.id, version: cycle.version },
        data: {
          ...patch,
          state: next,
          version: { increment: 1 },
        } as Prisma.CycleUpdateManyMutationInput,
      });
      if (result.count !== 1) throw new DomainError('STALE_STATE', 'Concurrent cycle transition');
      await tx.decision.create({
        data: { cycleId: cycle.id, agent: job.lane, action: next, details: json(details) },
      });
      await tx.job.update({
        where: { id: job.id },
        data: { doneAt: new Date(), leaseToken: null, leaseUntil: null },
      });
      if (lane) await this.enqueue(tx, cycle.id, lane, cycle.version + 1);
      await this.event(
        tx,
        'cycle.updated',
        { id: cycle.id, state: next, version: cycle.version + 1, details },
        cycle.id,
      );
    });
  }

  async retry(job: ClaimedJob, error: string, delayMs = 1000): Promise<void> {
    await this.db.job.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken, doneAt: null },
      data: {
        leaseToken: null,
        leaseUntil: null,
        availableAt: new Date(Date.now() + delayMs),
        lastError: error.slice(0, 500),
      },
    });
  }

  async finishStale(job: ClaimedJob): Promise<void> {
    await this.db.job.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken },
      data: { doneAt: new Date(), leaseUntil: null, leaseToken: null },
    });
  }

  async journal(
    tx: Tx,
    reference: string,
    kind: string,
    postings: PostingInput[],
    cycleId?: string,
  ): Promise<boolean> {
    const existing = await tx.journal.findUnique({
      where: { mode_reference: { mode: this.mode, reference } },
      include: { postings: true },
    });
    if (existing) {
      const normalize = (rows: PostingInput[]) =>
        rows.map((p) => `${p.asset}:${p.account}:${p.amountAtoms}`).sort();
      if (
        existing.kind !== kind ||
        digest(
          normalize(
            existing.postings.map((p) => ({
              account: p.account,
              asset: p.asset,
              amountAtoms: BigInt(p.amountAtoms.toFixed(0)),
            })),
          ),
        ) !== digest(normalize(postings))
      )
        throw new DomainError(
          'JOURNAL_CONFLICT',
          'Journal reference already contains different economic terms',
        );
      return false;
    }
    const totals = new Map<string, bigint>();
    for (const p of postings) totals.set(p.asset, (totals.get(p.asset) ?? 0n) + p.amountAtoms);
    if (postings.length < 2 || [...totals.values()].some((t) => t !== 0n))
      throw new DomainError('UNBALANCED_JOURNAL', 'Every asset must balance');
    await tx.journal.create({
      data: {
        mode: this.mode,
        reference,
        kind,
        ...(cycleId ? { cycleId } : {}),
        postings: {
          create: postings.map((p) => ({
            account: p.account,
            asset: p.asset,
            amountAtoms: p.amountAtoms.toString(),
          })),
        },
      },
    });
    return true;
  }

  async balance(tx: Tx = this.db, account = 'TREASURY'): Promise<bigint> {
    const result = await tx.posting.aggregate({
      where: { account, asset: this.config.BASE_ASSET, journal: { mode: this.mode } },
      _sum: { amountAtoms: true },
    });
    return BigInt(result._sum.amountAtoms?.toFixed(0) ?? '0');
  }

  async fundPaper(amount: bigint, reference: string): Promise<void> {
    if (this.mode !== 'PAPER')
      throw new DomainError('MODE_FORBIDDEN', 'Synthetic funding is only permitted in PAPER', 403);
    await this.atomic(async (tx) => {
      const asset = this.config.BASE_ASSET;
      const inserted = await this.journal(tx, reference, 'CAPITAL', [
        { account: 'TREASURY', asset, amountAtoms: amount },
        { account: 'EXTERNAL_CAPITAL', asset, amountAtoms: -amount },
      ]);
      if (inserted)
        await this.event(tx, 'treasury.funded', {
          amountAtoms: amount.toString(),
          source: 'SIMULATED_CAPITAL',
        });
    });
  }

  async recordUsage(tx: Tx, cycleId: string, usage: Usage): Promise<void> {
    const exists = await tx.computeUsage.findUnique({ where: { requestId: usage.requestId } });
    if (
      exists &&
      (exists.cycleId !== cycleId ||
        exists.costUsdMicros !== usage.costUsdMicros ||
        exists.model !== usage.model)
    )
      throw new DomainError('USAGE_CONFLICT', 'Billing request already identifies different usage');
    if (!exists) await tx.computeUsage.create({ data: { cycleId, mode: this.mode, ...usage } });
    // USD micros are mapped to base atoms only for a six-decimal USD accounting asset.
    // Live funding of provider credits is a separate asset journal, never inferred from a wallet balance.
    if (this.mode === 'PAPER') {
      const cost =
        (BigInt(usage.costUsdMicros) * 10n ** BigInt(this.config.BASE_DECIMALS)) / 1_000_000n;
      await this.journal(
        tx,
        `compute:${usage.requestId}`,
        'COMPUTE_COST',
        [
          { account: 'TREASURY', asset: this.config.BASE_ASSET, amountAtoms: -cost },
          { account: 'COMPUTE_EXPENSE', asset: this.config.BASE_ASSET, amountAtoms: cost },
        ],
        cycleId,
      );
    } else {
      const cost = BigInt(usage.costUsdMicros);
      await this.journal(
        tx,
        `compute:${usage.requestId}`,
        'COMPUTE_COST',
        [
          { account: 'PROVIDER_USAGE_CLEARING', asset: 'USD_MICRO', amountAtoms: -cost },
          { account: 'COMPUTE_EXPENSE', asset: 'USD_MICRO', amountAtoms: cost },
        ],
        cycleId,
      );
    }
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const [balance, reserved, policy, pnl, usage, workers, counts, compute] = await Promise.all([
      this.balance(),
      this.db.reservation.aggregate({
        where: { mode: this.mode, status: 'ACTIVE' },
        _sum: { amountAtoms: true },
      }),
      this.db.policy.findUniqueOrThrow({ where: { mode: this.mode } }),
      this.db.posting.aggregate({
        where: { account: 'TRADING_PNL', journal: { mode: this.mode } },
        _sum: { amountAtoms: true },
      }),
      this.db.computeUsage.findMany({
        where: { mode: this.mode },
        select: { costUsdMicros: true, createdAt: true },
      }),
      this.db.workerControl.findMany(),
      this.db.cycle.groupBy({ by: ['state'], where: { mode: this.mode }, _count: true }),
      this.db.computeAccount.findUnique({ where: { mode: this.mode } }),
    ]);
    const reservedAtoms = BigInt(reserved._sum.amountAtoms?.toFixed(0) ?? '0');
    const available = balance - reservedAtoms;
    const costs = usage.reduce((a, b) => a + BigInt(b.costUsdMicros), 0n);
    const freshCompute =
      compute && Date.now() - compute.updatedAt.getTime() < 120000 ? compute : null;
    return {
      mode: this.mode,
      baseAsset: this.config.BASE_ASSET,
      baseDecimals: this.config.BASE_DECIMALS,
      balanceAtoms: balance.toString(),
      reservedAtoms: reservedAtoms.toString(),
      availableAtoms: available.toString(),
      grossTradingPnlAtoms: (-BigInt(pnl._sum.amountAtoms?.toFixed(0) ?? '0')).toString(),
      netProfitStatus:
        this.mode === 'PAPER' ? 'SIMULATED' : 'INCOMPLETE_UNTIL_ALL_COSTS_ARE_VALUED',
      inferenceCostUsdMicros: costs.toString(),
      metabolism: policy.paused
        ? 'PAUSED'
        : available < BigInt(policy.minReserveAtoms.toFixed(0))
          ? 'LOW_RESERVE'
          : this.mode === 'LIVE' && !freshCompute
            ? 'COMPUTE_CREDIT_UNKNOWN'
            : this.mode === 'LIVE' &&
                BigInt(freshCompute!.remainingNanoUsd) <
                  BigInt(this.config.MIN_COMPUTE_CREDIT_USD_MICROS) * 1000n
              ? 'LOW_COMPUTE_CREDIT'
              : 'ACTIVE',
      computeCreditNanoUsd: freshCompute?.remainingNanoUsd ?? null,
      computeCreditObservedAt: compute?.updatedAt ?? null,
      survivalHours: null,
      runwayReason:
        'Compute credits, provider funding and hosting costs must be measured before claiming runway',
      workers: workers.map((w) => ({ role: w.role, paused: w.paused, heartbeat: w.heartbeat })),
      cycles: counts.map((c) => ({ state: c.state, count: c._count })),
    };
  }
}
