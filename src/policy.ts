import type { Policy } from './generated/prisma/client.js';
import { digest, netProfit, type Proposal, type Quote, type Assessment } from './domain.js';

/** Indicative admission arithmetic, never a realized P&L or complete cost basis. */
export function quoteProfitCheck(quote: Quote, minimumNetProfitAtoms: string) {
  const input = BigInt(quote.inputAtoms),
    quoted = BigInt(quote.expectedOutputAtoms),
    minimum = BigInt(quote.minimumOutputAtoms),
    costs = BigInt(quote.costsAtoms),
    floor = BigInt(minimumNetProfitAtoms),
    required = input + costs + floor,
    shortfall = required > minimum ? required - minimum : 0n;
  return {
    inputAtoms: input.toString(),
    quotedOutputAtoms: quoted.toString(),
    minimumOutputAtoms: minimum.toString(),
    quotedGrossPnlAtoms: (quoted - input).toString(),
    minimumGrossPnlAtoms: (minimum - input).toString(),
    previewCostAllowanceAtoms: costs.toString(),
    minimumNetAfterAllowanceAtoms: netProfit(quote).toString(),
    profitFloorAtoms: floor.toString(),
    requiredMinimumOutputAtoms: required.toString(),
    shortfallAtoms: shortfall.toString(),
    passesProfitFloor: shortfall === 0n,
    realized: false,
    completeCostBasis: false,
  };
}

export function evaluatePolicy(
  policy: Policy,
  proposal: Proposal,
  quote: Quote,
  assessment: Assessment | null,
  now = Date.now(),
): string[] {
  const reasons: string[] = [];
  if (policy.paused) reasons.push('TREASURY_PAUSED');
  if (Date.parse(proposal.expiresAt) <= now || Date.parse(quote.expiresAt) <= now)
    reasons.push('EXPIRED');
  if (quote.inputAtoms !== proposal.amountAtoms) reasons.push('QUOTE_AMOUNT_MISMATCH');
  if (quote.routeDigest !== digest(quote.route)) reasons.push('QUOTE_DIGEST_MISMATCH');
  if (BigInt(proposal.amountAtoms) > BigInt(policy.maxTradeAtoms.toFixed(0)))
    reasons.push('TRADE_LIMIT');
  if (proposal.slippageBps > policy.maxSlippageBps) reasons.push('SLIPPAGE_LIMIT');
  if (
    ![proposal.originAsset, proposal.intermediateAsset].every((a) =>
      policy.allowedAssets.includes(a),
    )
  )
    reasons.push('ASSET_NOT_ALLOWED');
  if (
    ![proposal.originChain, proposal.destinationChain].every((a) =>
      policy.allowedChains.includes(a),
    )
  )
    reasons.push('CHAIN_NOT_ALLOWED');
  if (![proposal.recipient, proposal.refundTo].every((a) => policy.allowedRecipients.includes(a)))
    reasons.push('RECIPIENT_NOT_ALLOWED');
  if (netProfit(quote) < BigInt(policy.minNetProfitAtoms.toFixed(0)))
    reasons.push('INSUFFICIENT_NET_PROFIT');
  if (assessment) {
    if (!assessment.execute) reasons.push('MODEL_REJECTED');
    if (assessment.proposalDigest !== digest({ proposal, quote }))
      reasons.push('ASSESSMENT_BINDING_MISMATCH');
    if (proposal.slippageBps > assessment.maxSlippageBps) reasons.push('MODEL_SLIPPAGE_LIMIT');
  }
  return reasons;
}
