import { ROOT, UNIT, planDigest } from './plan.mjs';
export const BRAIN = 'brain.symbio-fcef733893.near',
  HAND = 'hand.symbio-fcef733893.near',
  SCOUT = 'scout.symbio-fcef733893.near';
export const FUND_PER_AGENT = UNIT / 1000n;
export const INTENTS_FUNDING_FEE = (17n * UNIT) / 1000n;
const call = (methodName, args, gas, deposit) => ({
  type: 'FunctionCall',
  params: { methodName, args, gas, deposit },
});
export function intentsFundingPlan() {
  const p = {
    network: 'mainnet',
    scope: 'CONTROLLED_INTERNAL_PAYMENT_FIXTURE',
    signerId: ROOT,
    receiverId: 'wrap.near',
    capitalYocto: (2n * FUND_PER_AGENT).toString(),
    storageDepositYocto: '1250000000000000000000',
    feeAllowanceYocto: INTENTS_FUNDING_FEE.toString(),
    totalFixtureCeilingYocto: ((3n * UNIT) / 100n).toString(),
    ownerMinimumRemainingYocto: (UNIT / 5n).toString(),
    transaction: {
      id: 'intents_fixture_funding',
      signerId: ROOT,
      receiverId: 'wrap.near',
      actions: [
        call(
          'storage_deposit',
          { account_id: ROOT, registration_only: true },
          '10000000000000',
          '1250000000000000000000',
        ),
        call('near_deposit', {}, '5000000000000', (2n * FUND_PER_AGENT).toString()),
        ...[BRAIN, HAND].map((account) =>
          call(
            'ft_transfer_call',
            { receiver_id: 'intents.near', amount: FUND_PER_AGENT.toString(), msg: account },
            '70000000000000',
            '1',
          ),
        ),
      ],
    },
    disclosure: {
      treasuryTopup: false,
      paidInferenceAllowed: false,
      aiApprovalClaimed: false,
      externalRevenue: false,
      marketSwap: false,
      newWalletKeys: false,
    },
  };
  return { ...p, digest: planDigest(p) };
}
