import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
const check = z
  .object({
    id: z.string().regex(/^[A-Z0-9_]+$/),
    status: z.enum(['PASS', 'BLOCKED', 'UNAVAILABLE']),
    detail: z.string().max(500),
  })
  .strict();
export const MainnetPreparationReport = z
  .object({
    id: z.uuid(),
    capturedAt: z.iso.datetime(),
    scope: z.literal('REAL_MAINNET_READ_ONLY_PREPARATION'),
    checks: z.array(check).max(25),
    wallets: z
      .array(
        z
          .object({
            chain: z.enum(['BASE', 'SOLANA']),
            address: z.string().max(64),
            nativeAtoms: atoms,
            tokenAtoms: atoms.nullable(),
            block: atoms,
          })
          .strict(),
      )
      .max(2),
    quote: z
      .object({
        status: z.enum(['VALIDATED', 'UNAVAILABLE']),
        inputAtoms: atoms,
        minimumOutputAtoms: atoms.nullable(),
        costAllowanceAtoms: atoms,
        requiredOutputAtoms: atoms.nullable(),
        passesProfitFloor: z.boolean(),
        quoteDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        expiresAt: z.iso.datetime().nullable(),
      })
      .strict(),
    nonTeeReady: z.boolean(),
    nextGate: z.enum(['NON_TEE_REQUIREMENTS', 'TEE_APPROVAL_REQUIRED']),
    paidInferenceRequests: z.literal(0),
    transactionsSubmitted: z.literal(0),
    economicClaimsProven: z.literal(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ready = v.checks.every((c) => c.status === 'PASS');
    if (v.nonTeeReady !== ready || (v.nextGate === 'TEE_APPROVAL_REQUIRED') !== ready)
      ctx.addIssue({ code: 'custom', message: 'Readiness must match all non-TEE checks' });
  });
export type MainnetPreparationReport = z.infer<typeof MainnetPreparationReport>;
export const MainnetPreparation = z
  .object({
    contractVersion: z.literal(1),
    enabled: z.boolean(),
    report: MainnetPreparationReport.nullable(),
    stale: z.boolean(),
    executionEnabled: z.boolean(),
    tee: z.literal('QUARANTINED'),
  })
  .strict();
