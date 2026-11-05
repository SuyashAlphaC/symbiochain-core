import { expect, it } from 'vitest';
import { performanceFee, FeeInvoice, BusinessWindow } from '../../src/business.js';
it('charges 15% only above the cumulative high-water mark after loss recovery', () => {
  const win = performanceFee(0n, 0n, 1000n);
  expect(win.feeAtoms).toBe('150');
  const loss = performanceFee(1000n, 1000n, -700n);
  expect(loss).toMatchObject({ feeAtoms: '0', cumulativeNet: '300', highWater: '1000' });
  expect(performanceFee(300n, 1000n, 600n).feeAtoms).toBe('0');
  expect(performanceFee(900n, 1000n, 300n).feeAtoms).toBe('30');
  expect(performanceFee(-2000n, 0n, 1000n).feeAtoms).toBe('0');
});
it('rejects incomplete operating costs and missing evidence', () => {
  expect(FeeInvoice.safeParse({ reference: 'x', cycleId: 'x', costsComplete: false }).success).toBe(
    false,
  );
  expect(
    BusinessWindow.safeParse({ costsComplete: true, realizedCosts: { compute: '0' } }).success,
  ).toBe(false);
});
