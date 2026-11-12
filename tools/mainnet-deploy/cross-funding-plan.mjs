import assert from 'node:assert/strict';
import { ROOT, UNIT, planDigest } from './plan.mjs';
export const EVM_WALLET = '0xE9464975ECAFa3e27AC1048C16a3406395061092';
export const SOL_WALLET = 'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f';
export const HAND = 'hand.symbio-fcef733893.near';
export const FUNDING_CEILING = UNIT / 2n;
export const ROWS = [
  {
    id: 'base_usdc',
    asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    near: UNIT / 10n,
    recipient: EVM_WALLET,
    minimum: '250000',
    decimals: 6,
  },
  {
    id: 'base_eth',
    asset: 'nep141:base.omft.near',
    near: UNIT / 20n,
    recipient: EVM_WALLET,
    minimum: '50000000000000',
    decimals: 18,
  },
  {
    id: 'sol_gas',
    asset: 'nep141:sol.omft.near',
    near: UNIT / 20n,
    recipient: SOL_WALLET,
    minimum: '1500000',
    decimals: 9,
  },
];
export function fundingTerms(row, deadline) {
  return {
    originAsset: 'nep141:wrap.near',
    destinationAsset: row.asset,
    amount: row.near.toString(),
    recipient: row.recipient,
    refundTo: ROOT,
    deadline,
    slippageBps: 0,
  };
}
export function assertFundingQuote(row, q, now = Date.now()) {
  assert.match(q.quote.depositAddress ?? '', /^[a-f0-9]{64}$/, 'NEAR_DEPOSIT_ACCOUNT_REQUIRED');
  assert.ok(!q.quote.depositMemo, 'MEMO_UNSUPPORTED');
  assert.equal(q.quoteRequest.originAsset, 'nep141:wrap.near');
  assert.equal(q.quoteRequest.destinationAsset, row.asset);
  assert.equal(q.quoteRequest.recipient, row.recipient);
  assert.equal(q.quoteRequest.refundTo, ROOT);
  assert.equal(q.quoteRequest.depositType, 'ORIGIN_CHAIN');
  assert.equal(q.quoteRequest.recipientType, 'DESTINATION_CHAIN');
  assert.equal(q.quoteRequest.dry, false);
  assert.equal(q.quoteRequest.slippageTolerance, 0);
  assert.equal(q.quote.amountIn, row.near.toString());
  assert.ok(BigInt(q.quote.minAmountOut) >= BigInt(row.minimum), 'FUNDING_OUTPUT_TOO_LOW');
  assert.ok(Date.parse(q.quote.deadline) > now + 90000, 'FUNDING_QUOTE_EXPIRING');
}
export function makeCrossFundingPlan(quotes, now = Date.now()) {
  assert.equal(quotes.length, 3);
  const transfers = [{ id: 'hand_near_gas', receiverId: HAND, amount: UNIT / 4n }];
  for (let i = 0; i < ROWS.length; i++) {
    assertFundingQuote(ROWS[i], quotes[i], now);
    transfers.push({
      id: ROWS[i].id,
      receiverId: quotes[i].quote.depositAddress,
      amount: ROWS[i].near,
    });
  }
  assert.equal(new Set(transfers.map((t) => t.receiverId)).size, 4, 'DUPLICATE_FUNDING_RECIPIENT');
  const transactions = transfers.map((t) => ({
    id: t.id,
    signerId: ROOT,
    receiverId: t.receiverId,
    actions: [{ type: 'Transfer', params: { deposit: t.amount.toString() } }],
  }));
  const p = {
    scope: 'OWNER_FUNDED_MAINNET_WALLETS_NOT_REVENUE',
    network: 'mainnet',
    signerId: ROOT,
    capitalYocto: transfers.reduce((n, t) => n + t.amount, 0n).toString(),
    feeAllowanceYocto: (UNIT / 20n).toString(),
    totalPlanningCeilingYocto: FUNDING_CEILING.toString(),
    minimumOwnerRemainingYocto: (UNIT / 5n).toString(),
    transactions,
    quotes,
    paidInferenceRequests: 0,
    teeApprovalClaimed: false,
    automatedTradingEnabled: false,
  };
  assert.ok(BigInt(p.capitalYocto) + BigInt(p.feeAllowanceYocto) <= FUNDING_CEILING);
  return { ...p, digest: planDigest(p) };
}
