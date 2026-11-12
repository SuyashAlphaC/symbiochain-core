import { readFile } from 'node:fs/promises';
import { MainnetSettlementFixture } from './mainnet-settlement-contract.js';
import { z } from 'zod';
const amount = z.string().regex(/^\d+$/);
export async function readMainnetSettlementFixture() {
  const tx = z.object({
    hash: z.string(),
    url: z.url(),
    actualFeeYocto: amount,
    final: z.literal(true),
    succeeded: z.literal(true),
  });
  const r = z
    .object({
      checkedAt: z.iso.datetime(),
      scope: z.literal('MAINNET_INTERNAL_INTENTS_SETTLEMENT_FIXTURE'),
      network: z.literal('mainnet'),
      funding: z.object({
        hash: z.string(),
        url: z.url(),
        capitalYocto: amount,
        storageCollateralYocto: amount,
      }),
      transactions: z.array(tx).length(2),
      payments: z
        .array(
          z.object({
            hash: z.string(),
            payer: z.string(),
            recipient: z.string(),
            amountYocto: amount,
            nonceConfirmed: z.literal(true),
          }),
        )
        .length(2),
      allowanceRepairs: z.array(tx).length(2),
      totalNetworkFeesIncludingFailedAttemptYocto: amount,
      totalPlanningCeilingYocto: amount,
      paidInferenceRequests: z.literal(0),
      teeApprovalClaimed: z.literal(false),
      externalRevenueProven: z.literal(false),
      marketSwapPerformed: z.literal(false),
    })
    .parse(JSON.parse(await readFile('artifacts/mainnet-intents-settlement.json', 'utf8')));
  return MainnetSettlementFixture.parse({
    contractVersion: 1,
    network: 'mainnet',
    scope: 'TEAM_FUNDED_INTERNAL_INTENTS_SETTLEMENT',
    checkedAt: r.checkedAt,
    funding: { hash: r.funding.hash, url: r.funding.url },
    payments: r.payments.map((p) => {
      const t = r.transactions.find((t) => t.hash === p.hash);
      if (!t) throw Error('PAYMENT_RECEIPT_MISMATCH');
      return {
        receipt: { hash: t.hash, url: t.url },
        payer: p.payer,
        recipient: p.recipient,
        amountYocto: p.amountYocto,
        nonceConfirmed: p.nonceConfirmed,
        nativeFeeYocto: t.actualFeeYocto,
      };
    }),
    allowanceRepairs: r.allowanceRepairs.map((t) => ({ hash: t.hash, url: t.url })),
    totalNetworkFeesYocto: r.totalNetworkFeesIncludingFailedAttemptYocto,
    fundedCapitalYocto: r.funding.capitalYocto,
    storageCollateralYocto: r.funding.storageCollateralYocto,
    totalPlanningCeilingYocto: r.totalPlanningCeilingYocto,
    paidInferenceRequests: 0,
    teeApprovalClaimed: false,
    externalRevenueProven: false,
    marketSwapPerformed: false,
  });
}
