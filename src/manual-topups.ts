import { z } from 'zod';
import { Store, type Tx } from './store.js';
import { append, enabled, existing, reserveProceeds } from './business.js';
import { DomainError, digest, positiveAtoms } from './domain.js';
import { ManualTopupReport, ManualTopupTask, OperatingStatus } from './operating-contract.js';
import { readFile } from 'node:fs/promises';

const request = z
  .object({
    reservationReference: z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/),
    requestedCreditUsdMicros: z.string().regex(/^[1-9]\d{0,12}$/),
  })
  .strict();

/** No payment adapter or credit mutation exists in this workflow. */
export async function requestManualTopup(store: Store, input: unknown) {
  await enabled(store);
  if (store.mode === 'REPLAY')
    throw new DomainError('READ_ONLY_MODE', 'Replay cannot request top-ups');
  const data = request.parse(input);
  const organizationId =
    store.mode === 'PAPER' ? 'PAPER_ORGANIZATION' : store.config.NEAR_AI_ORG_ID;
  if (!organizationId)
    throw new DomainError(
      'TOPUP_ORGANIZATION_REQUIRED',
      'Select the matching Cloud organization before requesting a manual purchase',
    );
  return store.atomic(async (tx) => {
    const [policy, unresolved, book] = await Promise.all([
      tx.policy.findUnique({ where: { mode: store.mode } }),
      tx.inferenceAttempt.count({
        where: { cycle: { mode: store.mode }, status: { not: 'COMPLETE' } },
      }),
      tx.businessEntry.findMany({
        where: {
          mode: store.mode,
          kind: { in: ['COST_WINDOW', 'PROCEEDS_RESERVED', 'PROCEEDS_RELEASED'] },
        },
      }),
    ]);
    if (!policy || policy.paused || unresolved)
      throw new DomainError(
        'TOPUP_PROFIT_HELD',
        'Paused policy or unresolved inference costs hold purchase requests',
      );
    const net = book
      .filter((row) => row.kind === 'COST_WINDOW')
      .reduce((n, row) => n + BigInt(row.amountAtoms.toFixed(0)), 0n);
    const committed = book
      .filter((row) => row.kind === 'PROCEEDS_RESERVED')
      .reduce((n, row) => n + BigInt(row.amountAtoms.toFixed(0)), 0n);
    const released = book
      .filter((row) => row.kind === 'PROCEEDS_RELEASED')
      .reduce((n, row) => n + BigInt(row.amountAtoms.toFixed(0)), 0n);
    if (net < committed - released)
      throw new DomainError(
        'TOPUP_PROFIT_HELD',
        'Recover reported business losses before requesting manual spending',
      );
    const reservation = await tx.businessEntry.findUniqueOrThrow({
      where: { mode_reference: { mode: store.mode, reference: data.reservationReference } },
    });
    const payload = reservation.payload as Record<string, unknown>;
    if (
      reservation.kind !== 'PROCEEDS_RESERVED' ||
      payload.purpose !== 'COMPUTE_PURCHASE' ||
      reservation.asset !== store.config.BUSINESS_INTENTS_ASSET
    )
      throw new DomainError(
        'TOPUP_RESERVATION_REQUIRED',
        'Reserve earned proceeds specifically for compute first',
      );
    const reference = `topup:${reservation.id}`;
    const task = ManualTopupTask.parse({
      reference,
      organizationId,
      spendBudgetAtoms: reservation.amountAtoms.toFixed(0),
      requestedCreditUsdMicros: data.requestedCreditUsdMicros,
      state: 'WAITING_OPERATOR',
      simulated: store.mode === 'PAPER',
      providerVerified: false,
    });
    const termsDigest = digest(task);
    if (!(await existing(tx, store, reference, termsDigest))) {
      await append(
        tx,
        store,
        reference,
        'MANUAL_TOPUP_REQUIRED',
        '0',
        { ...task, reservationReference: data.reservationReference },
        termsDigest,
      );
      await store.event(tx, 'business.topup_required', {
        reference,
        status: 'WAITING_OPERATOR',
        simulated: task.simulated,
      });
    }
    return taskState(tx, store, task);
  });
}

async function taskState(tx: Tx, store: Store, task: z.infer<typeof ManualTopupTask>) {
  const report = await tx.businessEntry.findUnique({
    where: { mode_reference: { mode: store.mode, reference: `${task.reference}:reported` } },
  });
  return ManualTopupTask.parse({
    ...task,
    state: report ? 'OPERATOR_REPORTED_UNVERIFIED' : 'WAITING_OPERATOR',
  });
}

export async function manualTopupTasks(store: Store) {
  const rows = await store.db.businessEntry.findMany({
    where: { mode: store.mode, kind: 'MANUAL_TOPUP_REQUIRED' },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return Promise.all(
    rows.map(async (row) => {
      const { reservationReference: _privateReference, ...data } = row.payload as Record<
        string,
        unknown
      >;
      return taskState(store.db, store, ManualTopupTask.parse(data));
    }),
  );
}

export async function reportManualTopup(store: Store, input: unknown) {
  await enabled(store);
  if (store.mode === 'REPLAY')
    throw new DomainError('READ_ONLY_MODE', 'Replay cannot confirm top-ups');
  const data = ManualTopupReport.parse(input);
  return store.atomic(async (tx) => {
    const task = await tx.businessEntry.findUniqueOrThrow({
      where: { mode_reference: { mode: store.mode, reference: data.reference } },
    });
    if (task.kind !== 'MANUAL_TOPUP_REQUIRED')
      throw new DomainError('TOPUP_TASK_REQUIRED', 'A manual purchase task is required');
    const target = task.payload as Record<string, unknown>;
    if (target.organizationId !== data.organizationId)
      throw new DomainError(
        'TOPUP_ORGANIZATION_MISMATCH',
        'Report the same organization bound to the task',
      );
    const reference = `${data.reference}:reported`,
      termsDigest = digest(data);
    if (!(await existing(tx, store, reference, termsDigest))) {
      const duplicate = await tx.businessEntry.findFirst({
        where: {
          mode: store.mode,
          kind: 'MANUAL_TOPUP_REPORTED',
          sourceKey: `manual-credit:${store.mode}:${data.receiptDigest}`,
        },
      });
      if (duplicate) throw new DomainError('TOPUP_RECEIPT_USED', 'Receipt digest already used');
      await append(
        tx,
        store,
        reference,
        'MANUAL_TOPUP_REPORTED',
        '0',
        {
          ...data,
          simulated: store.mode === 'PAPER',
          providerVerified: false,
          attribution: 'OPERATOR_REPORTED_ONLY',
          reservationHeld: true,
        },
        termsDigest,
        `manual-credit:${store.mode}:${data.receiptDigest}`,
      );
      await store.event(tx, 'business.topup_reported', {
        reference: data.reference,
        providerVerified: false,
        simulated: store.mode === 'PAPER',
      });
    }
    return {
      reference: data.reference,
      state: 'OPERATOR_REPORTED_UNVERIFIED' as const,
      providerVerified: false as const,
    };
  });
}

/** Reads finalized receipt/cost accounting, never equates an account balance with profit. */
export async function tickManualTopups(
  store: Store,
  input: { maxSpendAtoms: string; requestedCreditUsdMicros: string },
) {
  positiveAtoms.parse(input.maxSpendAtoms);
  const credit = request.shape.requestedCreditUsdMicros.parse(input.requestedCreditUsdMicros);
  if (store.mode !== 'PAPER' && !store.config.NEAR_AI_ORG_ID)
    throw new DomainError(
      'TOPUP_ORGANIZATION_REQUIRED',
      'Bind the Cloud organization before reserving proceeds',
    );
  const windows = await store.db.businessEntry.findMany({
    where: { mode: store.mode, kind: 'COST_WINDOW' },
    orderBy: { createdAt: 'asc' },
  });
  const result = [];
  for (const window of windows) {
    if (BigInt(window.amountAtoms.toFixed(0)) < BigInt(input.maxSpendAtoms)) continue;
    const reference = `compute:${window.id}`;
    try {
      await reserveProceeds(store, {
        reference,
        windowReference: window.reference,
        purpose: 'COMPUTE_PURCHASE',
        amountAtoms: input.maxSpendAtoms,
      });
      result.push(
        await requestManualTopup(store, {
          reservationReference: reference,
          requestedCreditUsdMicros: credit,
        }),
      );
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        !['BUSINESS_INSUFFICIENT_PROFIT', 'BUSINESS_COST_UNKNOWN', 'TOPUP_PROFIT_HELD'].includes(
          error.code,
        )
      )
        throw error;
    }
  }
  return result;
}

export async function operatingStatus(store: Store) {
  // This is the release's recorded audit, not a fresh hardware probe or a runtime approval.
  const audit = z
    .object({
      checkedAt: z.iso.datetime(),
      deploymentApproved: z.literal(false),
      signedModelResponseVerified: z.literal(false),
    })
    .parse(JSON.parse(await readFile('artifacts/brave-cli-verification.json', 'utf8')));
  const [waiting, reported, receipts] = await Promise.all([
    store.db.businessEntry.count({ where: { mode: store.mode, kind: 'MANUAL_TOPUP_REQUIRED' } }),
    store.db.businessEntry.count({ where: { mode: store.mode, kind: 'MANUAL_TOPUP_REPORTED' } }),
    store.mode === 'PAPER'
      ? 0
      : store.db.businessEntry.count({ where: { mode: store.mode, kind: 'EXTERNAL_RECEIPT' } }),
  ]);
  return OperatingStatus.parse({
    contractVersion: 1,
    capturedAt: new Date().toISOString(),
    mode: store.mode,
    tee: {
      status: 'QUARANTINED',
      inferenceGate: 'CLOSED',
      auditCapturedAt: audit.checkedAt,
      signedInferenceVerified: false,
      demoInference: 'LOCAL_SIMULATION',
    },
    bridge: {
      status: 'HUMAN_IN_THE_LOOP',
      waitingOperator: Math.max(0, waiting - reported),
      operatorReported: reported,
      providerVerifiedPurchases: 0,
      automaticPurchasesEnabled: false,
    },
    revenue: {
      status: receipts ? 'RECEIPTS_RECORDED_DEMAND_UNPROVEN' : 'UNPROVEN',
      confirmedReceiptCount: receipts,
    },
  });
}
