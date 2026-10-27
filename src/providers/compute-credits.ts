import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { DomainError } from '../domain.js';
import { httpJson, type Fetch } from './http.js';
import { json } from '../store.js';
const units = z.union([
  z.string().regex(/^-?\d+$/),
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
]);
export async function refreshComputeCredits(
  config: Config,
  db: Database,
  transport: Fetch = fetch,
): Promise<bigint> {
  if (!config.NEAR_AI_ORG_ID || !config.NEAR_AI_SESSION_TOKEN)
    throw new DomainError(
      'COMPUTE_CREDIT_UNKNOWN',
      'Organization balance requires a dedicated NEAR AI session token and organization ID',
    );
  const base = `/v1/organizations/${encodeURIComponent(config.NEAR_AI_ORG_ID)}`;
  const headers = { authorization: `Bearer ${config.NEAR_AI_SESSION_TOKEN}` };
  let staking: unknown = null;
  if (config.SYNC_STAKING_CREDITS)
    staking = await httpJson(
      new URL(`${base}/staking/farm/sync`, config.NEAR_AI_BASE_URL),
      { method: 'POST', headers },
      transport,
    );
  const raw = await httpJson(
    new URL(`${base}/usage/balance`, config.NEAR_AI_BASE_URL),
    { headers },
    transport,
  );
  const data = z
    .object({
      organization_id: z.string(),
      remaining: units.nullable(),
      updated_at: z.string(),
      credit_limits: z.array(z.unknown()),
    })
    .passthrough()
    .parse(raw);
  if (data.organization_id !== config.NEAR_AI_ORG_ID || data.remaining === null)
    throw new DomainError(
      'COMPUTE_CREDIT_UNKNOWN',
      'Provider did not report a bounded remaining compute balance',
    );
  const remaining = BigInt(data.remaining);
  await db.computeAccount.upsert({
    where: { mode: config.EXECUTION_MODE },
    create: {
      mode: config.EXECUTION_MODE,
      remainingNanoUsd: remaining.toString(),
      providerEvidence: json({ balance: data, staking }),
    },
    update: {
      remainingNanoUsd: remaining.toString(),
      providerEvidence: json({ balance: data, staking }),
    },
  });
  return remaining;
}
