import { it, expect } from 'vitest';
import { readMainnetSettlementFixture } from '../../src/mainnet-settlement.js';
import { MainnetSettlementFixture } from '../../src/mainnet-settlement-contract.js';
it('publishes actual internal mainnet transfers without claiming AI execution or external revenue', async () => {
  const r = await readMainnetSettlementFixture();
  expect(r.payments).toHaveLength(2);
  expect(r.payments.map((p) => p.amountYocto)).toEqual([
    '100000000000000000000',
    '100000000000000000000',
  ]);
  expect(r.paidInferenceRequests).toBe(0);
  expect(r.externalRevenueProven).toBe(false);
  expect(
    BigInt(r.totalNetworkFeesYocto) +
      BigInt(r.fundedCapitalYocto) +
      BigInt(r.storageCollateralYocto),
  ).toBeLessThan(BigInt(r.totalPlanningCeilingYocto));
  expect(() => MainnetSettlementFixture.parse({ ...r, teeApprovalClaimed: true })).toThrow();
  expect(() => MainnetSettlementFixture.parse({ ...r, externalRevenueProven: true })).toThrow();
});
