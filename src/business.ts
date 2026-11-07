import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DomainError, digest, atoms, positiveAtoms, Proposal, type Settlement } from './domain.js';
import { Store, json, type Tx } from './store.js';
import { verifyIntentReceipt, nearHash } from './providers/intent-receipts.js';
import type { Fetch } from './providers/http.js';
import { BusinessStatus } from './business-contract.js';
import { fundingStatus } from './business-funding.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/);
const account = z
  .string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
  .min(2)
  .max(64);
const time = z.iso.datetime();
const sources = z.array(z.string().min(1).max(500)).min(1).max(30);
const costs = z
  .object({ compute: atoms, gas: atoms, hosting: atoms, venue: atoms, other: atoms })
  .strict();
const sum = (c: z.infer<typeof costs>) => Object.values(c).reduce((a, b) => a + BigInt(b), 0n);
export const FeeInvoice = z
  .object({
    reference,
    cycleId: z.uuid(),
    payer: account,
    agreedTermsDigest: hash,
    // Realized costs replace quote buffers. The accountant remains an explicit trust boundary.
    realizedCosts: costs,
    inferenceCostUsdMicros: atoms,
    costSources: sources,
    approvedBy: z.string().min(1).max(100),
    costsComplete: z.literal(true),
  })
  .strict();
export const BusinessWindow = z
  .object({
    reference,
    from: time,
    through: time,
    realizedCosts: costs,
    costSources: sources,
    inferenceCostUsdMicros: atoms,
    costsComplete: z.literal(true),
    approvedBy: z.string().min(1).max(100),
  })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.through), 'Invalid accounting window');
export const ProceedsReservation = z
  .object({
    reference,
    windowReference: reference,
    purpose: z.enum(['COMPUTE_PURCHASE', 'NFT_DISTRIBUTION']),
    amountAtoms: positiveAtoms,
  })
  .strict();

/** Fees apply only to new cumulative profit. Loss recovery is never charged twice. */
export function performanceFee(previousNet: bigint, previousHighWater: bigint, net: bigint) {
  const cumulativeNet = previousNet + net;
  const newProfit = cumulativeNet > previousHighWater ? cumulativeNet - previousHighWater : 0n;
  return {
    cumulativeNet: cumulativeNet.toString(),
    highWater: (cumulativeNet > previousHighWater ? cumulativeNet : previousHighWater).toString(),
    feeAtoms: ((newProfit * 1500n) / 10000n).toString(),
    performanceFeeBps: 1500,
  };
}
export async function enabled(store: Store) {
  const c = store.config;
  if (!c.BUSINESS_RECEIVER_ID || !/^nep141:[a-z0-9._-]+$/.test(c.BUSINESS_INTENTS_ASSET))
    throw new DomainError(
      'BUSINESS_NOT_CONFIGURED',
      'Configure the business receiver and exact Intents asset',
    );
  if (store.mode !== 'PAPER' && (store.mode !== 'LIVE' || c.NEAR_NETWORK !== 'mainnet'))
    throw new DomainError(
      'BUSINESS_NETWORK',
      'External business receipts require mainnet LIVE accounting',
    );
  const old = await store.db.businessEntry.findFirst({
    where: { mode: store.mode, asset: { not: c.BUSINESS_INTENTS_ASSET } },
  });
  if (old)
    throw new DomainError(
      'BUSINESS_DENOMINATION_CHANGED',
      'Existing ledger denomination cannot be changed',
    );
}
export async function existing(tx: Tx, store: Store, ref: string, termsDigest: string) {
  const found = await tx.businessEntry.findUnique({
    where: { mode_reference: { mode: store.mode, reference: ref } },
  });
  if (found && found.termsDigest !== termsDigest)
    throw new DomainError(
      'BUSINESS_CONFLICT',
      'Reference already binds different immutable terms',
      409,
    );
  return found;
}
export async function append(
  tx: Tx,
  store: Store,
  ref: string,
  kind: string,
  amount: string,
  payload: unknown,
  termsDigest: string,
  sourceKey: string | null = null,
) {
  const entry = await tx.businessEntry.create({
    data: {
      id: randomUUID(),
      mode: store.mode,
      reference: ref,
      kind,
      amountAtoms: amount,
      asset: store.config.BUSINESS_INTENTS_ASSET,
      payload: json(payload),
      termsDigest,
      sourceKey,
    },
  });
  await store.event(tx, 'business.updated', {
    reference: ref,
    kind,
    simulated: store.mode === 'PAPER',
  });
  return entry;
}
export async function issueFeeInvoice(store: Store, input: unknown) {
  await enabled(store);
  const data = FeeInvoice.parse(input),
    termsDigest = digest({
      data,
      asset: store.config.BUSINESS_INTENTS_ASSET,
      receiver: store.config.BUSINESS_RECEIVER_ID,
      denomination: store.config.BASE_ASSET,
      decimals: store.config.BASE_DECIMALS,
    });
  if (
    [
      store.config.BUSINESS_RECEIVER_ID,
      store.config.NEAR_BRAIN_ACCOUNT_ID,
      store.config.NEAR_WORKER_ACCOUNT_ID,
      store.config.NEAR_SCOUT_ACCOUNT_ID,
      store.config.NEAR_ACCOUNTANT_ACCOUNT_ID,
      ...store.config.BUSINESS_RELATED_ACCOUNTS,
    ].includes(data.payer)
  )
    throw new DomainError(
      'RELATED_PARTY',
      'Capital and internal payments cannot become external revenue',
    );
  return store.atomic(async (tx) => {
    const found = await existing(tx, store, data.reference, termsDigest);
    if (found) return found;
    const cycle = await tx.cycle.findUniqueOrThrow({ where: { id: data.cycleId } });
    if (cycle.mode !== store.mode || cycle.state !== 'CLOSED')
      throw new DomainError('BUSINESS_CYCLE', 'A closed cycle in this execution mode is required');
    const settlement = cycle.settlement as unknown as Settlement;
    if (settlement?.status !== 'SUCCESS')
      throw new DomainError('BUSINESS_SETTLEMENT', 'Successful settlement required');
    const proposal = Proposal.parse(cycle.proposal);
    const metered = await tx.computeUsage.findMany({ where: { cycleId: cycle.id } });
    const billed = metered.reduce((n, u) => n + BigInt(u.costUsdMicros), 0n);
    if (
      billed !== BigInt(data.inferenceCostUsdMicros) ||
      (billed > 0n && BigInt(data.realizedCosts.compute) === 0n)
    )
      throw new DomainError(
        'BUSINESS_COMPUTE_COST',
        'Include all metered inference charges and their asset valuation',
      );
    const nativeFees = settlement.evidence.nativeFees;
    if (Array.isArray(nativeFees) && nativeFees.length && BigInt(data.realizedCosts.gas) === 0n)
      throw new DomainError(
        'BUSINESS_GAS_COST',
        'Realized native gas requires an explicit asset valuation',
      );

    const history = await tx.businessEntry.findMany({
      where: { mode: store.mode, kind: 'FEE_INVOICE' },
    });
    if (history.some((e) => (e.payload as Record<string, unknown>).cycleId === data.cycleId))
      throw new DomainError('BUSINESS_CYCLE_USED', 'Cycle already crystallized');
    // Every cycle is crystallized in settlement order. Mixing customers or adding old cycles is forbidden.
    const customer = history.filter(
      (e) => (e.payload as Record<string, unknown>).payer === data.payer,
    );
    if (
      customer.some(
        (e) => (e.payload as Record<string, unknown>).agreedTermsDigest !== data.agreedTermsDigest,
      )
    )
      throw new DomainError('BUSINESS_TERMS', 'Customer terms are immutable');
    const latest = customer
      .map((e) => e.payload as Record<string, string>)
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .at(-1);
    if (latest && Date.parse(latest.cycleClosedAt!) >= cycle.updatedAt.getTime())
      throw new DomainError('BUSINESS_ORDER', 'Crystallize cycles in settlement order');
    const net =
      BigInt(settlement.receivedAtoms) -
      BigInt(proposal.amountAtoms) -
      BigInt(settlement.feesAtoms) -
      sum(data.realizedCosts);
    const fee = performanceFee(
      BigInt(latest?.cumulativeNet ?? '0'),
      BigInt(latest?.highWater ?? '0'),
      net,
    );
    return append(
      tx,
      store,
      data.reference,
      'FEE_INVOICE',
      fee.feeAtoms,
      {
        ...data,
        ...fee,
        sequence: customer.length + 1,
        cycleClosedAt: cycle.updatedAt.toISOString(),
        netAfterReportedCostsAtoms: net.toString(),
        settlementDigest: digest(settlement),
        receiver: store.config.BUSINESS_RECEIVER_ID,
        simulated: store.mode === 'PAPER',
        costVerification: 'ACCOUNTANT_REPORTED',
        customerRelationship: 'OPERATOR_ATTESTED',
        denomination: store.config.BASE_ASSET,
        decimals: store.config.BASE_DECIMALS,
      },
      termsDigest,
    );
  });
}

export async function receiveInvoice(
  store: Store,
  invoiceReference: string,
  input: { txHash: string; senderId: string },
  transport: Fetch = fetch,
) {
  await enabled(store);
  if (store.mode !== 'LIVE')
    throw new DomainError('BUSINESS_LIVE_REQUIRED', 'PAPER invoices cannot accept real receipts');
  const invoice = await store.db.businessEntry.findUniqueOrThrow({
    where: {
      mode_reference: { mode: store.mode, reference: invoiceReference },
    },
  });
  if (
    !['FEE_INVOICE', 'SERVICE_ORDER'].includes(invoice.kind) ||
    BigInt(invoice.amountAtoms.toFixed(0)) <= 0n
  )
    throw new DomainError('BUSINESS_INVOICE', 'A positive business invoice is required');
  const payload = invoice.payload as Record<string, string>;
  if (
    invoice.asset !== store.config.BUSINESS_INTENTS_ASSET ||
    payload.receiver !== store.config.BUSINESS_RECEIVER_ID
  )
    throw new DomainError('BUSINESS_TERMS', 'Receiver or asset changed after issuance');
  const proof = await verifyIntentReceipt(
    {
      ...input,
      terms: {
        payer: payload.payer!,
        receiver: payload.receiver!,
        asset: invoice.asset,
        amountAtoms: invoice.amountAtoms.toFixed(0),
        issuedAt: invoice.createdAt.toISOString(),
      },
    },
    transport,
  );
  const ref = `paid:${invoiceReference}`,
    termsDigest = digest({ invoiceId: invoice.id, proof });
  return store.atomic(async (tx) => {
    const found = await existing(tx, store, ref, termsDigest);
    if (found) return found;
    if (await tx.businessEntry.findUnique({ where: { sourceKey: proof.sourceKey } }))
      throw new DomainError('BUSINESS_RECEIPT_USED', 'Receipt already consumed');
    const entry = await append(
      tx,
      store,
      ref,
      invoice.kind === 'SERVICE_ORDER' ? 'SERVICE_PAYMENT' : 'EXTERNAL_RECEIPT',
      proof.amountAtoms,
      {
        invoiceReference,
        ...proof,
        costVerification: 'ACCOUNTANT_REPORTED',
        customerRelationship: payload.customerRelationship ?? 'OPERATOR_ATTESTED',
      },
      termsDigest,
      proof.sourceKey,
    );
    await store.journal(
      tx,
      `business:${entry.id}`,
      invoice.kind === 'SERVICE_ORDER' ? 'CUSTOMER_ADVANCE' : 'EXTERNAL_BUSINESS_REVENUE',
      [
        { account: 'BUSINESS_CASH', asset: proof.asset, amountAtoms: BigInt(proof.amountAtoms) },
        {
          account: invoice.kind === 'SERVICE_ORDER' ? 'CUSTOMER_ADVANCES' : 'BUSINESS_REVENUE',
          asset: proof.asset,
          amountAtoms: -BigInt(proof.amountAtoms),
        },
      ],
    );
    return entry;
  });
}

export async function closeBusinessWindow(store: Store, input: unknown) {
  await enabled(store);
  const data = BusinessWindow.parse(input),
    termsDigest = digest({
      data,
      asset: store.config.BUSINESS_INTENTS_ASSET,
      receiver: store.config.BUSINESS_RECEIVER_ID,
      denomination: store.config.BASE_ASSET,
      decimals: store.config.BASE_DECIMALS,
    });
  if (Date.parse(data.through) > Date.now())
    throw new DomainError('BUSINESS_WINDOW', 'Future costs are not realized costs');
  return store.atomic(async (tx) => {
    const found = await existing(tx, store, data.reference, termsDigest);
    if (found) return found;
    const rows = await tx.businessEntry.findMany({ where: { mode: store.mode } });
    const unfinishedFunding = rows
      .filter(
        (r) => r.kind === 'NFT_FUNDING_STARTED' && r.createdAt.getTime() < Date.parse(data.through),
      )
      .some(
        (start) =>
          !rows.some((r) =>
            ['COMPLETE', 'CANCELLED'].some(
              (p) => r.reference === `${(start.payload as { reference: string }).reference}:${p}`,
            ),
          ),
      );
    if (unfinishedFunding)
      throw new DomainError(
        'BUSINESS_COST_UNKNOWN',
        'Reconcile pending NFT funding outcomes before closing operating costs',
      );
    const nativeFundingGas = await tx.posting.findFirst({
      where: {
        account: 'BUSINESS_GAS_EXPENSE',
        asset: 'native:near',
        amountAtoms: { gt: 0 },
        journal: {
          mode: store.mode,
          createdAt: { gte: new Date(data.from), lt: new Date(data.through) },
        },
      },
    });
    if (nativeFundingGas && BigInt(data.realizedCosts.gas) === 0n)
      throw new DomainError(
        'BUSINESS_GAS_COST',
        'Include realized native payout gas and its payment-asset valuation',
      );

    if (
      rows
        .filter((r) => r.kind === 'COST_WINDOW')
        .some((r) => {
          const w = r.payload as Record<string, string>;
          return (
            Date.parse(w.from!) < Date.parse(data.through) &&
            Date.parse(data.from) < Date.parse(w.through!)
          );
        })
    )
      throw new DomainError('BUSINESS_WINDOW_OVERLAP', 'Cost windows cannot overlap');
    const unresolved = await tx.inferenceAttempt.count({
      where: {
        cycle: { mode: store.mode },
        status: { not: 'COMPLETE' },
        createdAt: { gte: new Date(data.from), lt: new Date(data.through) },
      },
    });
    if (unresolved)
      throw new DomainError(
        'BUSINESS_COST_UNKNOWN',
        'Reconcile all inference outcomes before closing costs',
      );
    const usage = await tx.computeUsage.findMany({
      where: {
        mode: store.mode,
        createdAt: { gte: new Date(data.from), lt: new Date(data.through) },
      },
    });
    const billed = usage.reduce((n, u) => n + BigInt(u.costUsdMicros), 0n);
    if (
      billed !== BigInt(data.inferenceCostUsdMicros) ||
      (billed > 0n && BigInt(data.realizedCosts.compute) === 0n)
    )
      throw new DomainError(
        'BUSINESS_COMPUTE_COST',
        'Include all metered inference charges and their asset valuation',
      );
    const receipts = rows.filter(
      (r) =>
        r.kind === 'EXTERNAL_RECEIPT' &&
        r.asset === store.config.BUSINESS_INTENTS_ASSET &&
        r.createdAt.getTime() >= Date.parse(data.from) &&
        r.createdAt.getTime() < Date.parse(data.through),
    );
    const revenue = receipts.reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
    const net = revenue - sum(data.realizedCosts);
    return append(
      tx,
      store,
      data.reference,
      'COST_WINDOW',
      net.toString(),
      {
        ...data,
        revenueAtoms: revenue.toString(),
        totalCostAtoms: sum(data.realizedCosts).toString(),
        netAfterReportedCostsAtoms: net.toString(),
        receiptIds: receipts.map((r) => r.id),
        simulated: store.mode === 'PAPER',
        costVerification: 'ACCOUNTANT_REPORTED',
      },
      termsDigest,
    );
  });
}

export async function reserveProceeds(store: Store, input: unknown) {
  await enabled(store);
  const data = ProceedsReservation.parse(input),
    termsDigest = digest({
      data,
      asset: store.config.BUSINESS_INTENTS_ASSET,
      receiver: store.config.BUSINESS_RECEIVER_ID,
      denomination: store.config.BASE_ASSET,
      decimals: store.config.BASE_DECIMALS,
    });
  return store.atomic(async (tx) => {
    const found = await existing(tx, store, data.reference, termsDigest);
    if (found) return found;
    const unresolved = await tx.inferenceAttempt.count({
      where: {
        cycle: { mode: store.mode },
        status: { not: 'COMPLETE' },
      },
    });
    if (unresolved)
      throw new DomainError(
        'BUSINESS_COST_UNKNOWN',
        'Reconcile outstanding inference outcomes before reserving proceeds',
      );
    const rows = await tx.businessEntry.findMany({ where: { mode: store.mode } });
    const window = rows.find(
      (r) => r.reference === data.windowReference && r.kind === 'COST_WINDOW',
    );
    if (!window)
      throw new DomainError(
        'BUSINESS_COSTS_REQUIRED',
        'Close the full operating-cost window first',
      );
    const reserved = rows
      .filter(
        (r) =>
          r.kind === 'PROCEEDS_RESERVED' &&
          (r.payload as Record<string, unknown>).windowReference === data.windowReference,
      )
      .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
    const losses = rows
      .filter((r) => r.kind === 'COST_WINDOW' && r.asset === window.asset)
      .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
    const allReserved = rows
      .filter((r) => r.kind === 'PROCEEDS_RESERVED' && r.asset === window.asset)
      .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
    const releases = rows.filter((r) => r.kind === 'PROCEEDS_RELEASED' && r.asset === window.asset);
    const releasedForWindow = releases
      .filter(
        (r) => (r.payload as { windowReference: string }).windowReference === data.windowReference,
      )
      .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
    const releasedTotal = releases.reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
    if (
      BigInt(data.amountAtoms) >
        BigInt(window.amountAtoms.toFixed(0)) - reserved + releasedForWindow ||
      BigInt(data.amountAtoms) > losses - allReserved + releasedTotal
    )
      throw new DomainError(
        'BUSINESS_INSUFFICIENT_PROFIT',
        'Recover operating losses and fund costs before reserving proceeds',
      );
    // Reservation is deliberately not a provider credit purchase or NFT payment.
    return append(
      tx,
      store,
      data.reference,
      'PROCEEDS_RESERVED',
      data.amountAtoms,
      {
        ...data,
        state: 'RESERVED_NOT_PAID',
        simulated: store.mode === 'PAPER',
        blocker:
          data.purpose === 'COMPUTE_PURCHASE'
            ? 'PROVIDER_PURCHASE_PROTOCOL_REQUIRED'
            : 'EARNED_PROCEEDS_CONVERSION_AND_ONCHAIN_DISTRIBUTION_REQUIRED',
      },
      termsDigest,
    );
  });
}

export async function businessStatus(store: Store) {
  const funding = await fundingStatus(store);
  const rows = await store.db.businessEntry.findMany({
    where: { mode: store.mode },
    orderBy: { createdAt: 'asc' },
  });
  const receipts = rows.filter((r) => r.kind === 'EXTERNAL_RECEIPT');
  const windows = rows.filter((r) => r.kind === 'COST_WINDOW');
  const reserved = rows.filter((r) => r.kind === 'PROCEEDS_RESERVED');
  const released = rows
    .filter((r) => r.kind === 'PROCEEDS_RELEASED')
    .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
  const assets = [...new Set(rows.map((r) => r.asset))];
  if (assets.length > 1)
    throw new DomainError(
      'BUSINESS_DENOMINATION_CHANGED',
      'Mixed book denominations require reconciliation',
    );
  const asset = assets[0] ?? store.config.BUSINESS_INTENTS_ASSET;
  return BusinessStatus.parse({
    contractVersion: 1,
    capturedAt: new Date().toISOString(),
    coverage: 'CLOSED_WINDOWS_ONLY',
    mode: store.mode,
    simulated: store.mode === 'PAPER',
    asset: asset || null,
    configured:
      !!store.config.BUSINESS_RECEIVER_ID &&
      !!asset &&
      asset === store.config.BUSINESS_INTENTS_ASSET,
    confirmedReceiptCount: receipts.length,
    revenueAtoms: receipts.reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n).toString(),
    closedWindowCount: windows.length,
    receiptsAwaitingCostWindow: receipts.filter(
      (r) =>
        !windows.some((w) =>
          ((w.payload as Record<string, unknown>).receiptIds as string[]).includes(r.id),
        ),
    ).length,
    netAfterReportedCostsAtoms: windows.length
      ? windows.reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n).toString()
      : null,
    costVerification: windows.length ? 'ACCOUNTANT_REPORTED' : 'UNKNOWN',
    independentlyVerifiedBusinessProfit: false,
    fullBusinessRunway: null,
    reservedAtoms: (
      reserved.reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n) -
      BigInt(funding.spentInputAtoms) -
      released
    ).toString(),
    computePurchaseImplemented: false,
    purchasedCreditsUsdMicros: '0',
    businessFundedNftDistributions: funding.completedDistributions,
    blockers: [
      'PROVIDER_PURCHASE_PROTOCOL_REQUIRED',
      ...(funding.completedDistributions ? [] : ['EARNED_PROCEEDS_NFT_SETTLEMENT_UNPROVEN']),
    ],
    // Invoice/customer identity and private cost sources never enter the public projection.
  });
}
export const ReceiptInput = z.object({ txHash: nearHash, senderId: account }).strict();
