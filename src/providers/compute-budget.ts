import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import type { Store, Tx } from '../store.js';
import { DomainError, sha256 } from '../domain.js';
import { httpJson, type Fetch } from './http.js';

export const BUDGET_MODEL = 'z-ai/glm-5.3-flash';
export const MAX_OUTPUT_TOKENS = 600;
export const MAX_THINKING_TOKENS = 64;
export interface ComputeBudgetReservation {
  account: string;
  reservedUsdMicros: string;
  model: string;
  keyFingerprint: string;
}
const accountFor = (c: Config) => `AI_BUDGET:${sha256(c.AI_BUDGET_ID)}`;
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,9})?$/);
const nanoPrice = (s: string) => {
  decimal.parse(s);
  const [whole, fraction = ''] = s.split('.');
  return BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
};

/** Reserve against the entire advertised input context, avoiding a guessed tokenizer count. */
export async function priceComputeReservation(
  c: Config,
  transport: Fetch,
): Promise<ComputeBudgetReservation> {
  if (
    c.NEAR_AI_MODEL !== BUDGET_MODEL ||
    new URL(c.NEAR_AI_BASE_URL).origin !== 'https://cloud-api.near.ai'
  )
    throw new DomainError(
      'COMPUTE_BUDGET_MODEL',
      'Local budget requires the reviewed NEAR GLM model',
    );
  const catalog = z
    .object({ data: z.array(z.object({ id: z.string() }).passthrough()) })
    .parse(await httpJson(new URL('/v1/models', c.NEAR_AI_BASE_URL), {}, transport));
  const matches = catalog.data.filter((m) => m.id === BUDGET_MODEL);
  if (matches.length !== 1)
    throw new DomainError(
      'COMPUTE_BUDGET_MODEL',
      'Canonical NEAR GLM model is unavailable or ambiguous',
    );
  const model = z
    .object({
      id: z.string(),
      owned_by: z.literal('nearai'),
      is_ready: z.literal(true),
      context_length: z.number().int().positive().max(1_048_576),
      supported_sampling_parameters: z.array(z.string()).refine((v) => v.includes('max_tokens')),
      supported_features: z.array(z.string()).refine((v) => v.includes('structured_outputs')),
      pricing: z.object({ prompt: decimal, completion: decimal, request: decimal, image: decimal }),
    })
    .parse(matches[0]);
  const input = nanoPrice(model.pricing.prompt),
    output = nanoPrice(model.pricing.completion);
  if (
    input > 80n ||
    output > 500n ||
    nanoPrice(model.pricing.request) !== 0n ||
    nanoPrice(model.pricing.image) !== 0n
  )
    throw new DomainError(
      'COMPUTE_BUDGET_PRICE',
      'Model pricing exceeds the reviewed budget policy',
    );
  // Reasoning is billed within completion tokens. Counting it again is conservative.
  const bound =
    (BigInt(model.context_length) * input +
      BigInt(MAX_OUTPUT_TOKENS + MAX_THINKING_TOKENS) * output +
      999n) /
    1000n;
  if (bound <= 0n || bound > BigInt(c.AI_MAX_REQUEST_USD_MICROS))
    throw new DomainError(
      'COMPUTE_REQUEST_LIMIT',
      'Worst-case inference exceeds the request budget',
    );
  return {
    account: accountFor(c),
    reservedUsdMicros: bound.toString(),
    model: BUDGET_MODEL,
    keyFingerprint: sha256(c.NEAR_AI_API_KEY),
  };
}

export async function localComputeBudget(db: Database | Tx, c: Config) {
  const account = accountFor(c);
  const [sum, breach] = await Promise.all([
    db.posting.aggregate({ where: { account, asset: 'USD_MICRO' }, _sum: { amountAtoms: true } }),
    db.journal.findFirst({
      where: { kind: 'INFERENCE_BUDGET_BREACH', postings: { some: { account } } },
      select: { id: true },
    }),
  ]);
  const committed = BigInt(sum._sum.amountAtoms?.toFixed(0) ?? '0');
  const available = BigInt(c.AI_TOTAL_BUDGET_USD_MICROS) - committed;
  return {
    source: 'LOCAL_BUDGET' as const,
    limitUsdMicros: c.AI_TOTAL_BUDGET_USD_MICROS,
    committedUsdMicros: committed.toString(),
    availableUsdMicros: available.toString(),
    halted: !!breach || available <= 0n,
    providerBalanceVerified: false,
  };
}

/** Must share the transaction that inserts STARTED, before the paid POST. */
export async function reserveComputeBudget(
  tx: Tx,
  store: Store,
  cycleId: string,
  reservation: ComputeBudgetReservation,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(78234832)`;
  const status = await localComputeBudget(tx, store.config);
  if (
    reservation.account !== accountFor(store.config) ||
    status.halted ||
    BigInt(status.availableUsdMicros) < BigInt(reservation.reservedUsdMicros)
  )
    throw new DomainError(
      'COMPUTE_BUDGET_EXHAUSTED',
      'Application compute budget cannot cover this request',
    );
  await store.journal(
    tx,
    `ai-budget:reserve:${cycleId}`,
    'INFERENCE_BUDGET_RESERVED',
    [
      {
        account: reservation.account,
        asset: 'USD_MICRO',
        amountAtoms: BigInt(reservation.reservedUsdMicros),
      },
      {
        account: `${reservation.account}:OFFSET`,
        asset: 'USD_MICRO',
        amountAtoms: -BigInt(reservation.reservedUsdMicros),
      },
    ],
    cycleId,
  );
}

/** Billing failure leaves the reservation held. A provider overrun is recorded and halts the budget. */
export async function settleComputeBudget(
  tx: Tx,
  store: Store,
  cycleId: string,
  reservation: ComputeBudgetReservation,
  actualUsdMicros: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(78234832)`;
  const actual = BigInt(actualUsdMicros),
    reserved = BigInt(reservation.reservedUsdMicros);
  if (actual < 0n) throw new DomainError('COMPUTE_BUDGET_COST', 'Billed cost must be nonnegative');
  const reservationJournal = await tx.journal.findUnique({
    where: { mode_reference: { mode: store.mode, reference: `ai-budget:reserve:${cycleId}` } },
    include: { postings: true },
  });
  if (
    !reservationJournal?.postings.some(
      (p) =>
        p.account === reservation.account &&
        p.amountAtoms.toFixed(0) === reservation.reservedUsdMicros,
    )
  )
    throw new DomainError(
      'COMPUTE_BUDGET_RESERVATION',
      'Inference has no matching durable budget reservation',
    );
  const exceeded = actual > reserved;
  await store.journal(
    tx,
    `ai-budget:settle:${cycleId}`,
    exceeded ? 'INFERENCE_BUDGET_BREACH' : 'INFERENCE_BUDGET_SETTLED',
    [
      { account: reservation.account, asset: 'USD_MICRO', amountAtoms: actual - reserved },
      {
        account: `${reservation.account}:OFFSET`,
        asset: 'USD_MICRO',
        amountAtoms: reserved - actual,
      },
    ],
    cycleId,
  );
  return exceeded;
}
