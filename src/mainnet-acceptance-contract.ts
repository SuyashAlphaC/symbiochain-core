import { z } from 'zod';
const atoms = z.string().regex(/^(0|[1-9]\d{0,76})$/);
const mainnetLink = z.url().refine((s) => {
  const u = new URL(s);
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    !u.hostname.includes('testnet') &&
    !u.searchParams.has('cluster')
  );
}, 'Mainnet evidence cannot link to testnet or devnet results');
export const MainnetAcceptance = z
  .object({
    contractVersion: z.literal(1),
    profile: z.literal('MAINNET_ACCEPTANCE'),
    network: z.literal('mainnet'),
    capturedAt: z.iso.datetime(),
    block: z.object({ height: atoms, hash: z.string() }).strict(),
    summary: z
      .object({
        passed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        notRun: z.number().int().nonnegative(),
        complete: z.boolean(),
      })
      .strict(),
    checks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_]{1,50}$/),
            label: z.string().max(120),
            status: z.enum(['PASSED', 'BLOCKED', 'NOT_RUN']),
            scope: z.enum([
              'ON_CHAIN_STATE',
              'FINAL_MAINNET_TRANSACTION',
              'PRODUCTION_ATTESTATION',
              'SIGNED_MARKET_PREVIEW',
              'NOT_EXECUTED',
            ]),
            detail: z.string().max(1600),
            links: z.array(mainnetLink).max(15),
          })
          .strict(),
      )
      .max(35),
    transactions: z
      .array(
        z
          .object({
            hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
            label: z.string().max(120),
            classification: z.enum([
              'DEPLOYMENT_NOT_REVENUE',
              'TEAM_FUNDED_TREASURY_CAPITAL_NOT_REVENUE',
              'SELF_FUNDED_SERVICE_BALANCE_TEST',
            ]),
            url: mainnetLink,
          })
          .strict(),
      )
      .max(30),
    serviceRoundTrip: z
      .object({
        checkedAt: z.iso.datetime(),
        depositedYocto: atoms,
        returnedYocto: atoms,
        storageCollateralYocto: atoms,
        totalFeeYocto: atoms,
        totalOwnerCostYocto: atoms,
        walletBalanceReconciled: z.boolean(),
        depositHash: z.string(),
        withdrawalHash: z.string(),
      })
      .strict()
      .nullable(),
    runner: z
      .object({
        paidInferenceRequests: z.literal(0),
        transactionsSubmitted: z.literal(0),
        readOnly: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const expected = {
      passed: r.checks.filter((c) => c.status === 'PASSED').length,
      blocked: r.checks.filter((c) => c.status === 'BLOCKED').length,
      notRun: r.checks.filter((c) => c.status === 'NOT_RUN').length,
      complete: r.checks.length > 0 && r.checks.every((c) => c.status === 'PASSED'),
    };
    if (JSON.stringify(r.summary) !== JSON.stringify(expected))
      ctx.addIssue({ code: 'custom', message: 'Summary must match actual check outcomes' });
    if (new Set(r.checks.map((c) => c.id)).size !== r.checks.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate check IDs' });
    if (r.checks.some((c) => c.status === 'PASSED' && c.scope === 'NOT_EXECUTED'))
      ctx.addIssue({ code: 'custom', message: 'An unexecuted check cannot pass' });
  });
export type MainnetAcceptance = z.infer<typeof MainnetAcceptance>;
