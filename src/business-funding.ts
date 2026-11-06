import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, json, type Tx } from './store.js';
import { DomainError, digest } from './domain.js';
import { seal, unseal } from './crypto.js';
import {
  FundingRequest,
  FundingTerms,
  FundingSummary,
  MAX_DISTRIBUTION_YOCTO,
  type FundingPorts,
  type PreparedFundingCall,
  type FinalFundingCall,
} from './funding-types.js';
import { NearFundingPorts, swapCredit } from './providers/funding.js';
import type { SignedFundingIntent } from './funding-types.js';

const WRAP = 'nep141:wrap.near';
const phaseRef = (reference: string, phase: string) => `${reference}:${phase}`;
const context = (store: Store, ref: string) => `funding:${store.mode}:${ref}`;
function armed(store: Store) {
  const c = store.config;
  if (
    store.mode !== 'LIVE' ||
    c.NEAR_NETWORK !== 'mainnet' ||
    !c.LIVE_TRADING_ENABLED ||
    !c.BUSINESS_PAYOUTS_ENABLED
  )
    throw new DomainError(
      'BUSINESS_PAYOUT_DISABLED',
      'Earned-proceeds payouts require explicit mainnet arming',
    );
  if (
    !c.BUSINESS_RECEIVER_ID ||
    !c.NEAR_ACCOUNTANT_ACCOUNT_ID ||
    !c.NEAR_CONTRACT_ID ||
    !c.BUSINESS_PAYOUT_PRIVATE_KEY ||
    !c.BUSINESS_INTENTS_PRIVATE_KEY ||
    !c.BUSINESS_TREASURY_CODE_HASH ||
    [
      c.BUSINESS_MAX_PAYOUT_ATOMS,
      c.BUSINESS_DAILY_PAYOUT_ATOMS,
      c.BUSINESS_MAX_GAS_YOCTO,
      c.BUSINESS_MIN_NATIVE_RESERVE_YOCTO,
    ].some((v) => BigInt(v) <= 0n)
  )
    throw new DomainError(
      'BUSINESS_PAYOUT_CONFIGURATION',
      'Dedicated identities, pinned contract and positive spending/reserve caps are required',
    );
  if (
    c.BUSINESS_INTENTS_PRIVATE_KEY === c.BUSINESS_PAYOUT_PRIVATE_KEY ||
    c.BUSINESS_PAYOUT_PRIVATE_KEY === c.NEAR_ACCOUNTANT_PRIVATE_KEY
  )
    throw new DomainError(
      'BUSINESS_PAYOUT_KEY',
      'Use separate Intents and payout keys, isolated from cycle-finalization nonces',
    );
}
async function outbound(store: Store, t: FundingTerms) {
  armed(store);
  const c = store.config;
  if (
    t.payer !== c.BUSINESS_RECEIVER_ID ||
    t.accountant !== c.NEAR_ACCOUNTANT_ACCOUNT_ID ||
    t.treasury !== c.NEAR_CONTRACT_ID ||
    t.asset !== c.BUSINESS_INTENTS_ASSET ||
    t.treasuryCodeHash !== c.BUSINESS_TREASURY_CODE_HASH ||
    BigInt(t.amountAtoms) > BigInt(c.BUSINESS_MAX_PAYOUT_ATOMS) ||
    BigInt(t.maxGasYocto) > BigInt(c.BUSINESS_MAX_GAS_YOCTO) ||
    BigInt(t.minReserveYocto) < BigInt(c.BUSINESS_MIN_NATIVE_RESERVE_YOCTO)
  )
    throw new DomainError(
      'BUSINESS_PAYOUT_TERMS_CHANGED',
      'Frozen payout terms no longer fit the configured identities/caps',
    );
  const [policy, unknown] = await Promise.all([
    store.db.policy.findUnique({ where: { mode: store.mode } }),
    store.db.inferenceAttempt.count({
      where: { cycle: { mode: store.mode }, status: { not: 'COMPLETE' } },
    }),
  ]);
  const book = await store.db.businessEntry.findMany({
    where: {
      mode: store.mode,
      kind: { in: ['COST_WINDOW', 'PROCEEDS_RESERVED', 'PROCEEDS_RELEASED'] },
    },
  });
  const net = book
    .filter((r) => r.kind === 'COST_WINDOW')
    .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
  const committed = book
    .filter((r) => r.kind === 'PROCEEDS_RESERVED')
    .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
  const released = book
    .filter((r) => r.kind === 'PROCEEDS_RELEASED')
    .reduce((n, r) => n + BigInt(r.amountAtoms.toFixed(0)), 0n);
  if (net < committed - released)
    throw new DomainError(
      'BUSINESS_PAYOUT_HELD',
      'Reported operating losses no longer cover committed proceeds',
    );
  if (!policy || policy.paused || unknown)
    throw new DomainError(
      'BUSINESS_PAYOUT_HELD',
      'Paused policy or unresolved inference charges hold outbound payments',
    );
}
async function read<T>(store: Store, reference: string, phase: string): Promise<T | null> {
  const ref = phaseRef(reference, phase);
  const row = await store.db.businessEntry.findUnique({
    where: { mode_reference: { mode: store.mode, reference: ref } },
  });
  return row
    ? (unseal(
        (row.payload as { envelope: string }).envelope,
        store.config.EVIDENCE_ENCRYPTION_KEY,
        context(store, ref),
      ) as T)
    : null;
}
async function append<T>(
  store: Store,
  reference: string,
  phase: string,
  value: T,
  tx?: Tx,
): Promise<T> {
  const ref = phaseRef(reference, phase);
  const work = async (db: Tx) => {
    const found = await db.businessEntry.findUnique({
      where: { mode_reference: { mode: store.mode, reference: ref } },
    });
    if (found)
      return unseal(
        (found.payload as { envelope: string }).envelope,
        store.config.EVIDENCE_ENCRYPTION_KEY,
        context(store, ref),
      ) as T;
    await db.businessEntry.create({
      data: {
        id: randomUUID(),
        mode: store.mode,
        reference: ref,
        kind: phase === 'START' ? 'NFT_FUNDING_STARTED' : 'NFT_FUNDING_STEP',
        asset: store.config.BUSINESS_INTENTS_ASSET,
        amountAtoms: '0',
        termsDigest: digest(value),
        payload: json({
          reference,
          phase,
          envelope: seal(value, store.config.EVIDENCE_ENCRYPTION_KEY, context(store, ref)),
        }),
      },
    });
    await store.event(db, 'business.funding', { reference, phase });
    return value;
  };
  return tx ? work(tx) : store.atomic(work);
}
export async function queueNftPayout(store: Store, input: unknown) {
  armed(store);
  const request = FundingRequest.parse(input),
    c = store.config;
  return store.atomic(async (tx) => {
    const reservation = await tx.businessEntry.findUniqueOrThrow({
      where: { mode_reference: { mode: store.mode, reference: request.reservationReference } },
    });
    const data = reservation.payload as Record<string, unknown>;
    if (
      reservation.kind !== 'PROCEEDS_RESERVED' ||
      data.purpose !== 'NFT_DISTRIBUTION' ||
      reservation.asset !== c.BUSINESS_INTENTS_ASSET
    )
      throw new DomainError(
        'BUSINESS_PAYOUT_RESERVATION',
        'An earned-proceeds NFT reservation in the configured asset is required',
      );
    const reference = `nft:${reservation.id}`,
      old = await tx.businessEntry.findUnique({
        where: { mode_reference: { mode: store.mode, reference: phaseRef(reference, 'START') } },
      });
    if (old) {
      const terms = FundingTerms.parse(
        unseal(
          (old.payload as { envelope: string }).envelope,
          c.EVIDENCE_ENCRYPTION_KEY,
          context(store, old.reference),
        ),
      );
      if (terms.minimumNearYocto !== request.minimumNearYocto)
        throw new DomainError('BUSINESS_PAYOUT_CONFLICT', 'Payout already commits another minimum');
      return {
        reference,
        reservationReference: request.reservationReference,
        state: (await tx.businessEntry.findUnique({
          where: {
            mode_reference: { mode: store.mode, reference: phaseRef(reference, 'CANCELLED') },
          },
        }))
          ? 'CANCELLED'
          : 'QUEUED_OR_RECORDED',
      };
    }
    const window = await tx.businessEntry.findUniqueOrThrow({
      where: { mode_reference: { mode: store.mode, reference: String(data.windowReference) } },
    });
    const receiptIds = (window.payload as { receiptIds: string[] }).receiptIds;
    const receipts = await tx.businessEntry.findMany({
      where: {
        id: { in: receiptIds },
        mode: 'LIVE',
        kind: 'EXTERNAL_RECEIPT',
        asset: c.BUSINESS_INTENTS_ASSET,
      },
    });
    if (
      !receiptIds.length ||
      receipts.length !== receiptIds.length ||
      receipts.some((r) => !r.sourceKey?.startsWith('near:mainnet:'))
    )
      throw new DomainError(
        'BUSINESS_PAYOUT_REVENUE',
        'Reservation must trace to confirmed external mainnet receipts',
      );
    const starts = await tx.businessEntry.findMany({
      where: { mode: store.mode, kind: 'NFT_FUNDING_STARTED' },
    });
    for (const start of starts) {
      const op = (start.payload as { reference: string }).reference;
      if (
        !(await tx.businessEntry.findFirst({
          where: {
            mode: store.mode,
            reference: { in: [phaseRef(op, 'COMPLETE'), phaseRef(op, 'CANCELLED')] },
          },
        }))
      )
        throw new DomainError(
          'BUSINESS_PAYOUT_BUSY',
          'Reconcile the active payout before signing another account nonce',
        );
    }
    const today = Date.now() - 86400000;
    const daily = starts
      .filter((r) => r.createdAt.getTime() >= today)
      .reduce((n, r) => {
        const t = FundingTerms.parse(
          unseal(
            (r.payload as { envelope: string }).envelope,
            c.EVIDENCE_ENCRYPTION_KEY,
            context(store, r.reference),
          ),
        );
        return n + BigInt(t.amountAtoms);
      }, 0n);
    const amount = reservation.amountAtoms.toFixed(0);
    if (
      BigInt(amount) > BigInt(c.BUSINESS_MAX_PAYOUT_ATOMS) ||
      daily + BigInt(amount) > BigInt(c.BUSINESS_DAILY_PAYOUT_ATOMS)
    )
      throw new DomainError(
        'BUSINESS_PAYOUT_CAP',
        'Per-operation or rolling daily input cap exceeded',
      );
    if (c.BUSINESS_INTENTS_ASSET === WRAP && BigInt(request.minimumNearYocto) > BigInt(amount))
      throw new DomainError(
        'FUNDING_QUOTE_FLOOR',
        'Native withdrawal cannot exceed the reserved wNEAR',
      );
    const terms = FundingTerms.parse({
      reservationId: reservation.id,
      reservationReference: reservation.reference,
      reference,
      payer: c.BUSINESS_RECEIVER_ID,
      accountant: c.NEAR_ACCOUNTANT_ACCOUNT_ID,
      treasury: c.NEAR_CONTRACT_ID,
      treasuryCodeHash: c.BUSINESS_TREASURY_CODE_HASH,
      asset: reservation.asset,
      amountAtoms: amount,
      minimumNearYocto: request.minimumNearYocto,
      maxGasYocto: c.BUSINESS_MAX_GAS_YOCTO,
      minReserveYocto: c.BUSINESS_MIN_NATIVE_RESERVE_YOCTO,
      slippageBps: c.MAX_SLIPPAGE_BPS,
      deadline: new Date(Date.now() + 1200000).toISOString(),
    });
    await append(store, reference, 'START', terms, tx);
    return { reference, reservationReference: reservation.reference, state: 'QUEUED' };
  });
}
async function attempt(store: Store, reference: string, step: string) {
  return store.atomic(async (tx) => {
    const prefix = phaseRef(reference, `SEND_${step}_`);
    if (
      await tx.businessEntry.findFirst({
        where: {
          mode: store.mode,
          reference: {
            in: ['COMPLETE', 'REFUNDED', 'CANCELLED'].map((p) => phaseRef(reference, p)),
          },
        },
      })
    )
      throw new DomainError(
        'BUSINESS_PAYOUT_TERMINAL',
        'Payout is already terminal; no submission is permitted',
      );
    const count = await tx.businessEntry.count({
      where: { mode: store.mode, reference: { startsWith: prefix } },
    });
    if (count >= 3)
      throw new DomainError(
        'BUSINESS_PAYOUT_RETRY_EXHAUSTED',
        'Only reconciliation of the persisted identity remains; no replacement signature is generated',
      );
    await append(store, reference, `SEND_${step}_${count}`, { attempt: count + 1 }, tx);
  });
}
async function recordConversion(
  store: Store,
  t: FundingTerms,
  value: { nearYocto: string; receivedNearYocto?: string; evidenceDigest: string },
) {
  return store.atomic(async (tx) => {
    const prior = await tx.businessEntry.findUnique({
      where: {
        mode_reference: { mode: store.mode, reference: phaseRef(t.reference, 'CONVERTED') },
      },
    });
    if (!prior && t.asset !== WRAP)
      await store.journal(tx, `funding:${t.reference}:conversion`, 'EARNED_PROCEEDS_CONVERSION', [
        { account: 'BUSINESS_CASH', asset: t.asset, amountAtoms: -BigInt(t.amountAtoms) },
        { account: 'CONVERSION_CLEARING', asset: t.asset, amountAtoms: BigInt(t.amountAtoms) },
        {
          account: 'BUSINESS_CASH',
          asset: WRAP,
          amountAtoms: BigInt(value.receivedNearYocto ?? value.nearYocto),
        },
        {
          account: 'CONVERSION_CLEARING',
          asset: WRAP,
          amountAtoms: -BigInt(value.receivedNearYocto ?? value.nearYocto),
        },
      ]);
    return append(store, t.reference, 'CONVERTED', value, tx);
  });
}
async function recordWithdrawal(store: Store, t: FundingTerms, value: FinalFundingCall) {
  return store.atomic(async (tx) => {
    await store.journal(
      tx,
      `funding:${t.reference}:withdrawal`,
      'EARNED_PROCEEDS_NATIVE_WITHDRAWAL',
      [
        { account: 'BUSINESS_CASH', asset: WRAP, amountAtoms: -BigInt(value.amountNearYocto) },
        { account: 'CONVERSION_CLEARING', asset: WRAP, amountAtoms: BigInt(value.amountNearYocto) },
        {
          account: 'BUSINESS_NATIVE_CASH',
          asset: 'native:near',
          amountAtoms: BigInt(value.amountNearYocto),
        },
        {
          account: 'CONVERSION_CLEARING',
          asset: 'native:near',
          amountAtoms: -BigInt(value.amountNearYocto),
        },
        {
          account: 'BUSINESS_GAS_CAPITAL',
          asset: 'native:near',
          amountAtoms: -BigInt(value.gasYocto),
        },
        {
          account: 'BUSINESS_GAS_EXPENSE',
          asset: 'native:near',
          amountAtoms: BigInt(value.gasYocto),
        },
      ],
    );
    return append(store, t.reference, 'WITHDRAWN', value, tx);
  });
}
async function nearStep(
  store: Store,
  ports: FundingPorts,
  t: FundingTerms,
  kind: 'WITHDRAW' | 'DISTRIBUTE',
  amount: string,
  gasSpent = '0',
) {
  let prepared = await read<PreparedFundingCall>(store, t.reference, `${kind}_PREPARED`);
  if (!prepared) {
    await outbound(store, t);
    await ports.check(t, kind === 'DISTRIBUTE' ? amount : '0', gasSpent);
    prepared = await append(
      store,
      t.reference,
      `${kind}_PREPARED`,
      await ports.prepareCall(t, kind, amount),
    );
  }
  const final = await ports.reconcileCall(t, prepared);
  if (final) return final;
  await outbound(store, t);
  await ports.check(t, kind === 'DISTRIBUTE' ? amount : '0', gasSpent);
  await attempt(store, t.reference, kind);
  // The persisted winner is the sole identity that can ever be sent for this step.
  await ports.sendCall(prepared);
  return null;
}
export async function runNftPayout(
  store: Store,
  reference: string,
  injected?: FundingPorts,
): Promise<string> {
  armed(store);
  const t = FundingTerms.parse(await read(store, reference, 'START'));
  if (await read(store, reference, 'COMPLETE')) return 'COMPLETE';
  if (await read(store, reference, 'CANCELLED')) return 'CANCELLED';
  if (await read(store, reference, 'REFUNDED')) return 'REFUNDED_HELD';
  const ports = injected ?? new NearFundingPorts(store.config);
  try {
    let converted = await read<{ nearYocto: string; evidenceDigest: string }>(
      store,
      reference,
      'CONVERTED',
    );
    if (!converted) {
      if (t.asset === WRAP)
        converted = await recordConversion(store, t, {
          nearYocto: t.amountAtoms,
          evidenceDigest: digest({ asset: WRAP, reservationId: t.reservationId }),
        });
      else {
        let quote = await read<unknown>(store, reference, 'QUOTE');
        if (!quote) {
          await outbound(store, t);
          await ports.check(t);
          quote = await append(store, reference, 'QUOTE', await ports.quote(t));
        }
        let signed = await read<SignedFundingIntent>(store, reference, 'SIGNED_SWAP');
        if (!signed) {
          await outbound(store, t);
          signed = await append(store, reference, 'SIGNED_SWAP', await ports.signSwap(t, quote));
        }
        const credit = swapCredit(t, quote, signed, 0);
        const state = await ports.swapStatus(t, quote, signed);
        if (state.status === 'REFUNDED') {
          await append(store, reference, 'REFUNDED', state);
          return 'REFUNDED_HELD';
        }
        if (state.status !== 'SUCCESS') {
          if (Date.parse(t.deadline) <= Date.now())
            throw new DomainError(
              'FUNDING_EXPIRED',
              'Swap refund deadline passed; reconcile the existing payment without resubmission',
            );
          await outbound(store, t);
          await ports.check(t);
          await attempt(store, reference, 'SWAP');
          await ports.submitSwap(signed);
          return 'SWAP_PENDING';
        }
        if (state.creditYocto !== credit)
          throw new DomainError(
            'BUSINESS_PAYOUT_CREDIT',
            'Confirmed conversion credit differs from the signed exchange',
          );
        if (BigInt(state.receivedYocto ?? credit) < BigInt(credit))
          throw new DomainError(
            'BUSINESS_PAYOUT_CREDIT',
            'Conversion receipt is below the guaranteed withdrawal',
          );
        converted = await recordConversion(store, t, {
          nearYocto: credit,
          receivedNearYocto: state.receivedYocto ?? credit,
          evidenceDigest: state.evidenceDigest,
        });
      }
    }
    const amount = converted.nearYocto;
    if (BigInt(amount) > MAX_DISTRIBUTION_YOCTO)
      throw new DomainError(
        'FUNDING_DISTRIBUTION_CAP',
        'Converted amount exceeds the pinned treasury cap; keep wNEAR held',
      );
    if (BigInt(amount) < BigInt(t.minimumNearYocto))
      throw new DomainError(
        'FUNDING_QUOTE_FLOOR',
        'Converted proceeds are below the approved minimum',
      );
    let withdrawal = await read<FinalFundingCall>(store, reference, 'WITHDRAWN');
    if (!withdrawal) {
      const result = await nearStep(store, ports, t, 'WITHDRAW', amount);
      if (!result) return 'WITHDRAW_PENDING';
      if (result.amountNearYocto !== amount)
        throw new DomainError('FUNDING_WITHDRAWAL_PROOF', 'Withdrawal amount changed');
      withdrawal = await recordWithdrawal(store, t, result);
    }
    if (BigInt(withdrawal.gasYocto) >= BigInt(t.maxGasYocto)) {
      await store.db.policy.update({ where: { mode: store.mode }, data: { paused: true } });
      throw new DomainError(
        'FUNDING_GAS_CAP',
        'Withdrawal exhausted the native gas cap; proceeds remain held',
      );
    }
    const result = await nearStep(store, ports, t, 'DISTRIBUTE', amount, withdrawal.gasYocto);
    if (!result) return 'DISTRIBUTION_PENDING';
    if (
      result.amountNearYocto !== amount ||
      !result.allocatedYocto ||
      BigInt(result.allocatedYocto) <= 0n ||
      BigInt(result.allocatedYocto) > BigInt(amount)
    )
      throw new DomainError(
        'FUNDING_DISTRIBUTION_PROOF',
        'Verified dividend allocation is required',
      );
    await store.atomic(async (tx) => {
      if (
        await tx.businessEntry.findUnique({
          where: {
            mode_reference: { mode: store.mode, reference: phaseRef(reference, 'COMPLETE') },
          },
        })
      )
        return;
      const gas = BigInt(withdrawal!.gasYocto) + BigInt(result.gasYocto);
      const allocation = BigInt(result.allocatedYocto!);
      await store.journal(tx, `funding:${reference}`, 'EARNED_PROCEEDS_NFT_DISTRIBUTION', [
        { account: 'BUSINESS_NATIVE_CASH', asset: 'native:near', amountAtoms: -BigInt(amount) },
        { account: 'NFT_DIVIDEND_LIABILITY', asset: 'native:near', amountAtoms: allocation },
        {
          account: 'BUSINESS_TREASURY_RETAINED',
          asset: 'native:near',
          amountAtoms: BigInt(amount) - allocation,
        },
        {
          account: 'BUSINESS_GAS_CAPITAL',
          asset: 'native:near',
          amountAtoms: -BigInt(result.gasYocto),
        },
        {
          account: 'BUSINESS_GAS_EXPENSE',
          asset: 'native:near',
          amountAtoms: BigInt(result.gasYocto),
        },
      ]);
      await append(
        store,
        reference,
        'COMPLETE',
        {
          reservationReference: t.reservationReference,
          inputAtoms: t.amountAtoms,
          distributedNearYocto: amount,
          allocatedNearYocto: result.allocatedYocto,
          withdrawalTx: withdrawal!.txHash,
          distributionTx: result.txHash,
          conversionEvidenceDigest: converted!.evidenceDigest,
          gasYocto: gas.toString(),
          gasCapBreached: gas > BigInt(t.maxGasYocto),
          evidenceDigest: result.evidenceDigest,
        },
        tx,
      );
      if (gas > BigInt(t.maxGasYocto))
        await tx.policy.update({ where: { mode: store.mode }, data: { paused: true } });
    });
    return 'COMPLETE';
  } catch (e) {
    const code = e instanceof DomainError ? e.code : 'FUNDING_UNAVAILABLE';
    await append(store, reference, `ERROR_${digest(code).slice(0, 16)}`, { code });
    throw e;
  }
}
export async function fundingStatus(store: Store) {
  const rows = await store.db.businessEntry.findMany({
    where: { mode: store.mode, kind: { in: ['NFT_FUNDING_STARTED', 'NFT_FUNDING_STEP'] } },
    orderBy: { createdAt: 'asc' },
  });
  const starts = rows.filter((r) => r.kind === 'NFT_FUNDING_STARTED');
  let deposited = 0n,
    allocated = 0n,
    complete = 0,
    inputSpent = 0n;
  const operations = [];
  for (const start of starts) {
    const t = FundingTerms.parse(
      unseal(
        (start.payload as { envelope: string }).envelope,
        store.config.EVIDENCE_ENCRYPTION_KEY,
        context(store, start.reference),
      ),
    );
    const phases = rows.filter(
      (r) => (r.payload as { reference: string }).reference === t.reference,
    );
    const done = phases.find((r) => (r.payload as { phase: string }).phase === 'COMPLETE');
    const cancelled = phases.some((r) => (r.payload as { phase: string }).phase === 'CANCELLED');
    const last = phases.at(-1)!;
    const error = phases
      .filter((r) => (r.payload as { phase: string }).phase.startsWith('ERROR_'))
      .at(-1);
    const lastError = error
      ? (unseal(
          (error.payload as { envelope: string }).envelope,
          store.config.EVIDENCE_ENCRYPTION_KEY,
          context(store, error.reference),
        ) as { code: string })
      : null;
    let withdrawalTxHash: string | null = null,
      distributionTxHash: string | null = null;
    if (done) {
      const d = await read<{
        distributedNearYocto: string;
        allocatedNearYocto: string;
        withdrawalTx: string;
        distributionTx: string;
      }>(store, t.reference, 'COMPLETE');
      deposited += BigInt(d!.distributedNearYocto);
      allocated += BigInt(d!.allocatedNearYocto);
      complete++;
      inputSpent += BigInt(t.amountAtoms);
      withdrawalTxHash = d!.withdrawalTx;
      distributionTxHash = d!.distributionTx;
    }
    operations.push({
      reference: t.reference,
      reservationReference: t.reservationReference,
      state: done
        ? 'COMPLETE'
        : cancelled
          ? 'CANCELLED'
          : (last.payload as { phase: string }).phase,
      updatedAt: last.createdAt.toISOString(),
      error: done || cancelled ? null : (lastError?.code ?? null),
      withdrawalTxHash,
      distributionTxHash,
    });
  }
  return FundingSummary.parse({
    contractVersion: 1,
    mode: store.mode,
    nftFundingImplemented: true,
    nftFundingEnabled: store.mode === 'LIVE' && store.config.BUSINESS_PAYOUTS_ENABLED,
    computePurchaseImplemented: false,
    computePurchaseBlocker: 'NO_PUBLIC_NEAR_AI_PURCHASE_PROTOCOL',
    completedDistributions: complete,
    spentInputAtoms: inputSpent.toString(),
    distributedNearYocto: deposited.toString(),
    allocatedNearYocto: allocated.toString(),
    operations: operations.slice(-20).reverse(),
  });
}
export async function tickBusinessFunding(store: Store) {
  if (!store.config.BUSINESS_PAYOUTS_ENABLED || store.mode !== 'LIVE') return;
  const status = await fundingStatus(store);
  const operation = status.operations.find(
    (op) => op.state !== 'COMPLETE' && op.state !== 'REFUNDED' && op.state !== 'CANCELLED',
  );
  if (operation) await runNftPayout(store, operation.reference);
}
/** No checkout is fabricated from credit allocation, staking sync, or a transfer of existing credits. */
export function requestComputePurchase(): never {
  throw new DomainError(
    'PROVIDER_PURCHASE_PROTOCOL_REQUIRED',
    'No publicly supported NEAR AI customer payment-to-credit protocol has been verified; no payment was created',
    409,
  );
}

export async function cancelUnsubmittedPayout(store: Store, reference: string) {
  const t = FundingTerms.parse(await read(store, reference, 'START'));
  return store.atomic(async (tx) => {
    const rows = await tx.businessEntry.findMany({
      where: { mode: store.mode, reference: { startsWith: `${reference}:` } },
    });
    if (rows.some((r) => r.reference === phaseRef(reference, 'CANCELLED')))
      return { reference, state: 'CANCELLED' };
    if (
      rows.some(
        (r) =>
          r.reference.startsWith(phaseRef(reference, 'SEND_')) ||
          ['WITHDRAWN', 'COMPLETE'].some((p) => r.reference === phaseRef(reference, p)) ||
          (r.reference === phaseRef(reference, 'CONVERTED') && t.asset !== WRAP),
      )
    )
      throw new DomainError(
        'BUSINESS_PAYOUT_OUTCOME_UNKNOWN',
        'A payment may have escaped; reconcile the existing identity before releasing proceeds',
      );
    const reservation = await tx.businessEntry.findUniqueOrThrow({
      where: { id: t.reservationId },
    });
    await tx.businessEntry.create({
      data: {
        id: randomUUID(),
        mode: store.mode,
        reference: `release:${t.reservationId}`,
        kind: 'PROCEEDS_RELEASED',
        asset: t.asset,
        amountAtoms: t.amountAtoms,
        termsDigest: digest({
          reference,
          reservationId: t.reservationId,
          reason: 'CANCELLED_BEFORE_SUBMISSION',
        }),
        payload: json({
          reservationReference: t.reservationReference,
          windowReference: (reservation.payload as { windowReference: string }).windowReference,
          reason: 'NO_SUBMISSION_ATTEMPT',
        }),
      },
    });
    await append(store, reference, 'CANCELLED', { reason: 'NO_SUBMISSION_ATTEMPT' }, tx);
    return { reference, state: 'CANCELLED' };
  });
}
