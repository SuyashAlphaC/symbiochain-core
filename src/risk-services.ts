import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Store, json, type Tx } from './store.js';
import { append, enabled, existing } from './business.js';
import { Proposal, DomainError, digest, type Assessment, type Quote } from './domain.js';
import type { Cycle } from './generated/prisma/client.js';
import { evaluatePolicy } from './policy.js';

const Order = z
  .object({
    reference: z.string().regex(/^[a-zA-Z0-9:_-]{1,70}$/),
    payer: z
      .string()
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
      .min(2)
      .max(64),
    customerRelationship: z.enum(['TEAM_DEMO', 'EXTERNAL_ATTESTED']),
    agreedTermsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    priceAtoms: z.string().regex(/^[1-9]\d{0,12}$/),
    proposal: Proposal.extend({ strategy: z.literal('risk-assessment') }),
  })
  .strict();

/** Operator-mediated post-quote risk report, never a security audit or trading mandate. */
export async function createRiskService(store: Store, input: unknown) {
  await enabled(store);
  if (store.mode === 'REPLAY')
    throw new DomainError('READ_ONLY_MODE', 'Replay cannot accept service orders');
  const data = Order.parse(input),
    c = store.config;
  if (
    Date.parse(data.proposal.expiresAt) <= Date.now() ||
    Date.parse(data.proposal.expiresAt) > Date.now() + 3600000
  )
    throw new DomainError('SERVICE_DEADLINE', 'The subject proposal must expire within one hour');
  const related = [
    c.BUSINESS_RECEIVER_ID,
    c.NEAR_CONTRACT_ID,
    c.NEAR_BRAIN_ACCOUNT_ID,
    c.NEAR_WORKER_ACCOUNT_ID,
    c.NEAR_SCOUT_ACCOUNT_ID,
    c.NEAR_ACCOUNTANT_ACCOUNT_ID,
    ...c.BUSINESS_RELATED_ACCOUNTS,
  ];
  if (data.customerRelationship === 'EXTERNAL_ATTESTED' && related.includes(data.payer))
    throw new DomainError(
      'RELATED_PARTY',
      'A known team or internal payer cannot be external revenue',
    );
  const termsDigest = digest({
    ...data,
    receiver: c.BUSINESS_RECEIVER_ID,
    asset: c.BUSINESS_INTENTS_ASSET,
    decimals: c.BASE_DECIMALS,
  });
  return store.atomic(async (tx) => {
    const old = await existing(tx, store, data.reference, termsDigest);
    if (old) return old;
    const cycle = await tx.cycle.create({
      data: {
        id: randomUUID(),
        mode: store.mode,
        idempotencyKey: `service:${data.reference}`,
        strategy: 'risk-assessment',
        proposal: json(data.proposal),
        expiresAt: new Date(data.proposal.expiresAt),
      },
    });
    const order = await append(
      tx,
      store,
      data.reference,
      'SERVICE_ORDER',
      data.priceAtoms,
      {
        ...data,
        cycleId: cycle.id,
        receiver: c.BUSINESS_RECEIVER_ID,
        simulated: store.mode === 'PAPER',
        description:
          'Risk report on a quoted cross-chain proposal; no trade, wallet audit, guaranteed safety or guaranteed profit',
      },
      termsDigest,
    );
    await store.enqueue(tx, cycle.id, 'SCOUT', 0);
    await store.event(
      tx,
      'cycle.created',
      { id: cycle.id, state: cycle.state, proposal: data.proposal },
      cycle.id,
    );
    return order;
  });
}

export async function simulateServicePayment(store: Store, reference: string) {
  await enabled(store);
  if (store.mode !== 'PAPER')
    throw new DomainError('PAPER_ONLY', 'Synthetic payment cannot fund LIVE service delivery');
  return store.atomic(async (tx) => {
    const order = await tx.businessEntry.findUniqueOrThrow({
      where: { mode_reference: { mode: store.mode, reference } },
    });
    if (order.kind !== 'SERVICE_ORDER')
      throw new DomainError('SERVICE_ORDER_REQUIRED', 'An assessment order is required');
    const ref = `paid:${reference}`,
      termsDigest = digest({ orderId: order.id, simulated: true });
    return (
      (await existing(tx, store, ref, termsDigest)) ??
      append(
        tx,
        store,
        ref,
        'SERVICE_PAYMENT',
        order.amountAtoms.toFixed(0),
        { invoiceReference: reference, simulated: true, paymentEvidence: 'LOCAL_FIXTURE' },
        termsDigest,
      )
    );
  });
}

export async function requireServicePayment(store: Store, cycleId: string, tx: Tx = store.db) {
  const rows = await tx.businessEntry.findMany({
    where: { mode: store.mode, kind: 'SERVICE_ORDER' },
  });
  const order = rows.find((row) => (row.payload as Record<string, unknown>).cycleId === cycleId);
  if (!order) throw new DomainError('SERVICE_ORDER_REQUIRED', 'Assessment cycle has no invoice');
  const payment = await tx.businessEntry.findUnique({
    where: { mode_reference: { mode: store.mode, reference: `paid:${order.reference}` } },
  });
  if (
    !payment ||
    payment.kind !== 'SERVICE_PAYMENT' ||
    payment.amountAtoms.toFixed(0) !== order.amountAtoms.toFixed(0) ||
    payment.asset !== order.asset
  )
    throw new DomainError(
      'SERVICE_PAYMENT_REQUIRED',
      'Payment must be reconciled before paid inference',
    );
  if (store.mode === 'LIVE' && !(payment.payload as Record<string, unknown>).sourceKey)
    throw new DomainError(
      'SERVICE_PAYMENT_UNVERIFIED',
      'LIVE delivery requires finalized receipt evidence',
    );
  return { order, payment };
}

export async function deliverRiskReport(
  tx: Tx,
  store: Store,
  cycle: Cycle,
  assessment: Assessment,
  quote: Quote,
) {
  const { order, payment } = await requireServicePayment(store, cycle.id, tx);
  const proof = await tx.proof.findFirst({
    where: {
      cycleId: cycle.id,
      kind: store.mode === 'LIVE' ? 'NEAR_AI' : 'PAPER',
      status: store.mode === 'LIVE' ? 'VERIFIED' : 'SIMULATED',
    },
  });
  if (!proof || assessment.proposalDigest !== digest({ proposal: cycle.proposal, quote }))
    throw new DomainError(
      'UNVERIFIED_INFERENCE',
      'A bound inference proof is required for delivery',
    );
  const policy = await tx.policy.findUniqueOrThrow({ where: { mode: store.mode } });
  if (policy.paused) throw new DomainError('TREASURY_PAUSED', 'Paused policy holds delivery');
  const report = {
    cycleId: cycle.id,
    assessment,
    deterministicRiskFlags: evaluatePolicy(
      policy,
      Proposal.parse(cycle.proposal),
      quote,
      assessment,
    ),
    executionAuthorized: false,
    proofStatus: proof.status,
    requestHash: proof.requestHash,
    responseHash: proof.responseHash,
    simulated: store.mode === 'PAPER',
    assurance:
      store.mode === 'PAPER' ? 'LOCAL_SIMULATION' : 'VERIFIED_INFERENCE_NOT_FINANCIAL_ADVICE',
  };
  await append(
    tx,
    store,
    `delivered:${order.reference}`,
    'SERVICE_DELIVERED',
    '0',
    { ...report, invoiceReference: order.reference },
    digest(report),
  );
  const external =
    store.mode === 'LIVE' &&
    (order.payload as Record<string, unknown>).customerRelationship === 'EXTERNAL_ATTESTED';
  if (external) {
    const revenue = await append(
      tx,
      store,
      `earned:${order.reference}`,
      'EXTERNAL_RECEIPT',
      payment.amountAtoms.toFixed(0),
      {
        invoiceReference: order.reference,
        paymentId: payment.id,
        paymentEvidence: payment.payload,
        customerRelationship: 'OPERATOR_ATTESTED',
        commercialDemand: 'UNPROVEN',
      },
      digest({ paymentId: payment.id, report }),
      `service-earned:${payment.id}`,
    );
    await store.journal(tx, `service-earned:${revenue.id}`, 'EARNED_SERVICE_REVENUE', [
      {
        account: 'CUSTOMER_ADVANCES',
        asset: order.asset,
        amountAtoms: BigInt(payment.amountAtoms.toFixed(0)),
      },
      {
        account: 'BUSINESS_REVENUE',
        asset: order.asset,
        amountAtoms: -BigInt(payment.amountAtoms.toFixed(0)),
      },
    ]);
  }
  return report;
}

export async function riskReport(store: Store, reference: string) {
  const row = await store.db.businessEntry.findUnique({
    where: { mode_reference: { mode: store.mode, reference: `delivered:${reference}` } },
  });
  if (!row || row.kind !== 'SERVICE_DELIVERED')
    throw new DomainError('SERVICE_REPORT_PENDING', 'No delivered report exists', 404);
  return row.payload;
}
