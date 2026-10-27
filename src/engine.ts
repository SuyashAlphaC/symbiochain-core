import { Store, json } from './store.js';
import type { ClaimedJob, Tx } from './store.js';
import type { Providers } from './providers/types.js';
import type { Cycle } from './generated/prisma/client.js';
import {
  Proposal,
  Quote,
  Assessment,
  DomainError,
  digest,
  errorMessage,
  terminalStates,
  type PreparedExecution,
} from './domain.js';
import { evaluatePolicy } from './policy.js';
import { seal } from './crypto.js';
import { z } from 'zod';

export class Engine {
  constructor(
    public readonly store: Store,
    public readonly providers: Providers,
  ) {}

  async tick(lanes = ['SCOUT', 'BRAIN', 'HAND']): Promise<boolean> {
    const job = await this.store.claim(lanes);
    if (!job) return false;
    let lost = false;
    const heartbeat = setInterval(
      () => {
        void this.store
          .renew(job)
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => {
            lost = true;
          });
      },
      Math.max(250, Math.floor(this.store.config.WORKER_LEASE_MS / 3)),
    );
    heartbeat.unref();
    try {
      const cycle = await this.store.getCycle(job.cycleId);
      if (terminalStates.has(cycle.state)) {
        await this.store.finishStale(job);
        return true;
      }
      if (lost) throw new DomainError('LEASE_LOST', 'Job lease lost');
      await this.run(job, cycle);
    } catch (e) {
      // A stalled submission stays reserved. No generic retry path creates a new transaction.
      const message = e instanceof DomainError ? e.code : 'PROVIDER_FAILURE';
      await this.store.retry(job, message, Math.min(30000, 500 * 2 ** Math.min(job.attempts, 6)));
      if (!(e instanceof DomainError))
        console.error(
          JSON.stringify({
            event: 'worker.error',
            jobId: job.id,
            cycleId: job.cycleId,
            code: 'PROVIDER_FAILURE',
            message: Object.entries(this.store.config)
              .filter(
                ([key, value]) =>
                  /TOKEN|PRIVATE_KEY|API_KEY|ENCRYPTION_KEY|JWT/.test(key) &&
                  typeof value === 'string' &&
                  value.length >= 8,
              )
              .reduce(
                (message, [, secret]) => message.replaceAll(String(secret), '[REDACTED]'),
                errorMessage(e),
              )
              .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
              .slice(0, 300),
          }),
        );
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async reject(
    job: ClaimedJob,
    cycle: Cycle,
    reasons: string[],
    expired = false,
  ): Promise<void> {
    await this.store.advance(
      job,
      cycle.state,
      expired ? 'EXPIRED' : 'REJECTED',
      { rejection: reasons.join(',') },
      { reasons },
      null,
      async (tx) => {
        await tx.reservation.updateMany({
          where: { cycleId: cycle.id, status: 'ACTIVE' },
          data: { status: 'RELEASED' },
        });
      },
    );
  }

  private async run(job: ClaimedJob, cycle: Cycle): Promise<void> {
    const p = Proposal.parse(cycle.proposal);
    const policy = await this.store.db.policy.findUniqueOrThrow({
      where: { mode: this.store.mode },
    });
    const hasLiveOperation =
      this.store.mode === 'LIVE' &&
      (await this.store.db.liveLeg.count({ where: { cycleId: cycle.id } })) > 0;
    if (
      ['DISCOVERED', 'QUOTED', 'ASSESSED', 'RESERVED'].includes(cycle.state) &&
      !cycle.submission &&
      !hasLiveOperation &&
      Date.parse(p.expiresAt) <= Date.now()
    ) {
      await this.reject(job, cycle, ['EXPIRED'], true);
      return;
    }
    if (cycle.state === 'DISCOVERED') {
      if (policy.paused) {
        await this.store.retry(job, 'TREASURY_PAUSED', 2000);
        return;
      }
      const q = Quote.parse(await this.providers.quote(cycle.id, p));
      const reasons = evaluatePolicy(policy, p, q, null);
      if (reasons.length) {
        await this.reject(job, cycle, reasons);
        return;
      }
      await this.store.advance(
        job,
        'DISCOVERED',
        'QUOTED',
        { quote: json(q) },
        { quoteId: q.id, minimumOutputAtoms: q.minimumOutputAtoms, costsAtoms: q.costsAtoms },
        'BRAIN',
      );
      return;
    }
    const q = Quote.parse(cycle.quote);
    if (cycle.state === 'QUOTED') {
      if (policy.paused) {
        await this.store.retry(job, 'TREASURY_PAUSED', 2000);
        return;
      }
      const result = await this.providers.assess(cycle.id, p, q);
      const assessment = Assessment.parse(result.assessment);
      const proof = result.proof;
      const required = this.store.mode === 'LIVE' ? 'VERIFIED' : 'SIMULATED';
      if (proof.status !== required || (this.store.mode === 'LIVE' && proof.kind !== 'NEAR_AI'))
        throw new DomainError(
          'UNVERIFIED_INFERENCE',
          'Inference evidence does not satisfy execution mode',
        );
      const reasons = evaluatePolicy(policy, p, q, assessment);
      await this.store.advance(
        job,
        'QUOTED',
        reasons.length ? 'REJECTED' : 'ASSESSED',
        {
          assessment: json(assessment),
          ...(reasons.length ? { rejection: reasons.join(',') } : {}),
        },
        { execute: reasons.length === 0, reasons, proofStatus: proof.status },
        reasons.length ? null : 'HAND',
        async (tx) => {
          await tx.proof.create({
            data: {
              cycleId: cycle.id,
              kind: proof.kind,
              status: proof.status,
              model: proof.model,
              requestHash: proof.requestHash,
              responseHash: proof.responseHash,
              signer: proof.signer,
              measurement: proof.measurement,
              evidenceCiphertext: seal(
                proof.evidence,
                this.store.config.EVIDENCE_ENCRYPTION_KEY,
                cycle.id,
              ),
              publicDetails: json(proof.publicDetails),
              verifiedAt: proof.status === 'VERIFIED' ? new Date() : null,
            },
          });
          await this.store.recordUsage(tx, cycle.id, result.usage);
        },
      );
      return;
    }
    if (cycle.state === 'ASSESSED') {
      const assessment = Assessment.parse(cycle.assessment);
      const reasons = evaluatePolicy(policy, p, q, assessment);
      if (reasons.length) {
        await this.reject(job, cycle, reasons);
        return;
      }
      await this.store.advance(
        job,
        'ASSESSED',
        'RESERVED',
        {},
        { amountAtoms: p.amountAtoms },
        'HAND',
        async (tx) => {
          // Serialize every reservation against the policy row; no concurrent agent can overspend.
          await tx.$queryRaw`SELECT mode FROM "Policy" WHERE mode::text=${this.store.mode} FOR UPDATE`;
          const fresh = await tx.policy.findUniqueOrThrow({ where: { mode: this.store.mode } });
          if (evaluatePolicy(fresh, p, q, assessment).length)
            throw new DomainError('POLICY_CHANGED', 'Current policy refuses reservation');
          const active = await tx.reservation.aggregate({
            where: { mode: this.store.mode, status: 'ACTIVE' },
            _sum: { amountAtoms: true },
          });
          const spent = await tx.reservation.aggregate({
            where: {
              mode: this.store.mode,
              status: { in: ['ACTIVE', 'SPENT'] },
              createdAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) },
            },
            _sum: { amountAtoms: true },
          });
          const amount = BigInt(p.amountAtoms);
          if (
            (await this.store.balance(tx)) -
              BigInt(active._sum.amountAtoms?.toFixed(0) ?? '0') -
              amount <
            BigInt(fresh.minReserveAtoms.toFixed(0))
          )
            throw new DomainError('INSUFFICIENT_RESERVE', 'Insufficient uncommitted funds');
          if (
            BigInt(spent._sum.amountAtoms?.toFixed(0) ?? '0') + amount >
            BigInt(fresh.maxDailySpendAtoms.toFixed(0))
          )
            throw new DomainError('DAILY_LIMIT', 'Daily spending cap reached');
          await tx.reservation.create({
            data: { cycleId: cycle.id, mode: this.store.mode, amountAtoms: p.amountAtoms },
          });
        },
      );
      return;
    }
    if (cycle.state === 'RESERVED') {
      const reasons = evaluatePolicy(policy, p, q, Assessment.parse(cycle.assessment));
      if (reasons.length && !hasLiveOperation) {
        await this.reject(job, cycle, reasons);
        return;
      }
      const prepared = await this.providers.prepare(cycle.id, p, q);
      // Persist exact signed material before any target-chain broadcast.
      await this.store.advance(
        job,
        'RESERVED',
        'SUBMITTED',
        { submission: json(prepared) },
        { chainId: prepared.chainId, txHash: prepared.txHash },
        'HAND',
      );
      return;
    }
    const prepared = cycle.submission as unknown as PreparedExecution;
    if (!prepared?.txHash)
      throw new DomainError(
        'MISSING_SUBMISSION',
        'Reconciliation requires persisted transaction identity',
      );
    if (cycle.state === 'SUBMITTED') {
      if (policy.paused) {
        await this.store.retry(job, 'TREASURY_PAUSED', 2000);
        return;
      }
      try {
        await this.providers.broadcast(prepared);
        await this.store.advance(
          job,
          'SUBMITTED',
          'SETTLING',
          {},
          { txHash: prepared.txHash },
          'HAND',
        );
      } catch {
        await this.store.advance(
          job,
          'SUBMITTED',
          'UNKNOWN',
          {},
          { code: 'BROADCAST_OUTCOME_UNKNOWN', txHash: prepared.txHash },
          'HAND',
        );
      }
      return;
    }
    if (cycle.state === 'SETTLING' || cycle.state === 'UNKNOWN') {
      const result = await this.providers.settle(cycle.id, p, q, prepared);
      if (result.status === 'PENDING' || result.status === 'UNKNOWN') {
        await this.store.retry(job, `SETTLEMENT_${result.status}`, 1000);
        return;
      }
      if (!/^\d+$/.test(result.receivedAtoms) || !/^\d+$/.test(result.feesAtoms))
        throw new DomainError('INVALID_SETTLEMENT', 'Invalid settlement units');
      const received = BigInt(result.receivedAtoms),
        fees = BigInt(result.feesAtoms),
        input = BigInt(p.amountAtoms);
      const nativeFees = z
        .array(
          z.object({ chainId: z.string().min(3).max(80), atoms: z.string().regex(/^\d{1,77}$/) }),
        )
        .max(4)
        .parse(result.evidence.nativeFees ?? []);
      await this.store.advance(
        job,
        cycle.state,
        result.status === 'REFUNDED' ? 'REFUNDED' : 'RECONCILED',
        { settlement: json(result) },
        { receivedAtoms: result.receivedAtoms, feesAtoms: result.feesAtoms, mode: this.store.mode },
        result.status === 'REFUNDED' ? null : 'HAND',
        async (tx) => {
          await this.store.journal(
            tx,
            `settlement:${cycle.id}`,
            'TRADING_RESULT',
            [
              {
                account: 'TREASURY',
                asset: this.store.config.BASE_ASSET,
                amountAtoms: received - input,
              },
              {
                account: 'TRADING_PNL',
                asset: this.store.config.BASE_ASSET,
                amountAtoms: input - received,
              },
            ],
            cycle.id,
          );
          if (fees > 0n)
            await this.store.journal(
              tx,
              `fees:${cycle.id}`,
              'CHAIN_COST',
              [
                { account: 'TREASURY', asset: this.store.config.BASE_ASSET, amountAtoms: -fees },
                {
                  account: 'CHAIN_EXPENSE',
                  asset: this.store.config.BASE_ASSET,
                  amountAtoms: fees,
                },
              ],
              cycle.id,
            );
          await tx.reservation.updateMany({
            where: { cycleId: cycle.id, status: 'ACTIVE' },
            data: { status: 'SPENT' },
          });
          for (const [index, fee] of nativeFees.entries())
            if (BigInt(fee.atoms) > 0n)
              await this.store.journal(
                tx,
                `native-fee:${cycle.id}:${index}`,
                'NATIVE_CHAIN_COST',
                [
                  {
                    account: 'NATIVE_GAS_CLEARING',
                    asset: `native:${fee.chainId}`,
                    amountAtoms: -BigInt(fee.atoms),
                  },
                  {
                    account: 'CHAIN_EXPENSE',
                    asset: `native:${fee.chainId}`,
                    amountAtoms: BigInt(fee.atoms),
                  },
                ],
                cycle.id,
              );
          for (const t of result.transactions) {
            await tx.chainTransaction.upsert({
              where: {
                chainId_txHash_operation: {
                  chainId: t.chainId,
                  txHash: t.txHash,
                  operation: t.operation,
                },
              },
              update: { status: t.status },
              create: { cycleId: cycle.id, ...t },
            });
            await this.store.event(tx, 'new_transaction', { cycleId: cycle.id, ...t }, cycle.id);
          }
        },
      );
      return;
    }
    if (cycle.state === 'RECONCILED') {
      const evidence = {
        cycleId: cycle.id,
        mode: this.store.mode,
        proposalDigest: digest(p),
        settlementDigest: digest(cycle.settlement),
      };
      const receipt = await this.providers.receipt(cycle.id, evidence);
      await this.store.advance(job, 'RECONCILED', 'CLOSED', {}, { receipt }, null, async (tx) => {
        await tx.proof.create({
          data: {
            cycleId: cycle.id,
            kind: 'EXECUTION_RECEIPT',
            status: this.store.mode === 'PAPER' ? 'SIMULATED' : 'RECORDED',
            publicDetails: json(receipt),
          },
        });
      });
      return;
    }
    throw new DomainError('UNHANDLED_STATE', `Cannot process ${cycle.state}`);
  }
}
