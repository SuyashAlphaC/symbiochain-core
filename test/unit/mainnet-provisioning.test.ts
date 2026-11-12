import { it, expect } from 'vitest';
import { readMainnetProvisioning } from '../../src/mainnet-provisioning.js';
import { MainnetProvisioning } from '../../src/mainnet-provisioning-contract.js';
it('reports actual owner funding, refunded conversions and permission receipts without invented revenue', async () => {
  const r = await readMainnetProvisioning();
  expect(r.funding).toHaveLength(4);
  expect(r.permissions).toHaveLength(2);
  expect(r.conversions.map((c) => c.status)).toEqual(['SUCCESS', 'REFUNDED', 'REFUNDED']);
  expect(r.capitalReturnedYocto).toBe('100000000000000000000000');
  expect(r.limits.maxTradeUsdcAtoms).toBe('250000');
  expect(() => MainnetProvisioning.parse({ ...r, capitalReturnedYocto: '0' })).toThrow();
  expect(() => MainnetProvisioning.parse({ ...r, externalRevenueProven: true })).toThrow();
});
