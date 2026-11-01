import { it, expect } from 'vitest';
import { quoteProfitCheck } from '../../src/policy.js';
import type { Quote } from '../../src/domain.js';
const quote: Quote = {
  id: 'diagnostic',
  inputAtoms: '10000000',
  expectedOutputAtoms: '9890000',
  minimumOutputAtoms: '9840294',
  costsAtoms: '200000',
  expiresAt: '2099-01-01T00:00:00Z',
  routeDigest: 'aa'.repeat(32),
  route: {},
};
it('explains the 10-USDC loss without treating slippage protection as a fee', () => {
  expect(quoteProfitCheck(quote, '10000')).toMatchObject({
    quotedGrossPnlAtoms: '-110000',
    minimumGrossPnlAtoms: '-159706',
    minimumNetAfterAllowanceAtoms: '-359706',
    requiredMinimumOutputAtoms: '10210000',
    shortfallAtoms: '369706',
    passesProfitFloor: false,
    realized: false,
    completeCostBasis: false,
  });
});
it('rejects apparent quoted profit when the conservative return fails the floor', () => {
  expect(
    quoteProfitCheck({ ...quote, expectedOutputAtoms: '10500000' }, '10000').passesProfitFloor,
  ).toBe(false);
});
it('requires the entire principal, cost allowance and profit floor at atomic precision', () => {
  expect(
    quoteProfitCheck(
      { ...quote, expectedOutputAtoms: '10300000', minimumOutputAtoms: '10209999' },
      '10000',
    ).passesProfitFloor,
  ).toBe(false);
  expect(
    quoteProfitCheck(
      { ...quote, expectedOutputAtoms: '10300000', minimumOutputAtoms: '10210000' },
      '10000',
    ),
  ).toMatchObject({ passesProfitFloor: true, shortfallAtoms: '0' });
});
