import { writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { digest, positiveAtoms, type Quote } from '../src/domain.js';
import { quoteProfitCheck } from '../src/policy.js';
import { OneClickClient, type SwapTerms } from '../src/providers/oneclick.js';

// Signed dry quotes only: no deposit address, inference, signing request or transfer.
const { values } = parseArgs({
  options: {
    'amount-atoms': { type: 'string', default: '10000000' },
    'slippage-bps': { type: 'string', default: '50' },
    chain: { type: 'string', default: 'base' },
  },
});
const amount = positiveAtoms.parse(values['amount-atoms']);
const slippageBps = z.coerce.number().int().min(1).max(100).parse(values['slippage-bps']);
const chain = z.enum(['base', 'eth', 'arbitrum', 'optimism']).parse(values.chain);
const c = loadConfig({ ...process.env, EXECUTION_MODE: 'PAPER' }),
  client = new OneClickClient(c);
const tokens = await client.tokens();
const origin = tokens.find(
  (t) => t.blockchain === chain && t.symbol === 'USDC' && t.decimals === 6,
);
const middle = tokens.find((t) => t.assetId === 'nep141:sol.omft.near');
if (!origin || !middle) throw new Error('Supported assets unavailable');
// Unfunded throwaway addresses are used only to request previews.
const originAddress = privateKeyToAccount(generatePrivateKey()).address,
  solanaAddress = Keypair.generate().publicKey.toBase58(),
  deadline = new Date(Date.now() + 1800000).toISOString();
const first = await client.quote(
  {
    originAsset: origin.assetId,
    destinationAsset: middle.assetId,
    amount,
    recipient: solanaAddress,
    refundTo: originAddress,
    deadline,
    slippageBps,
  },
  true,
);
const reverseTerms: Omit<SwapTerms, 'amount'> = {
  originAsset: middle.assetId,
  destinationAsset: origin.assetId,
  recipient: originAddress,
  refundTo: solanaAddress,
  deadline,
  slippageBps,
};
const second = await client.quote({ ...reverseTerms, amount: first.quote.minAmountOut }, true);
// Separate diagnostic quote; never substitute this larger amount in the guard.
const quotedSecond =
  first.quote.amountOut === first.quote.minAmountOut
    ? second
    : await client.quote({ ...reverseTerms, amount: first.quote.amountOut }, true);
const route = { first, second },
  quote: Quote = {
    id: digest(route),
    inputAtoms: amount,
    expectedOutputAtoms: second.quote.amountOut,
    minimumOutputAtoms: second.quote.minAmountOut,
    costsAtoms: (BigInt(c.GAS_COST_BASE_ATOMS) + BigInt(c.LIVE_COST_BUFFER_ATOMS)).toString(),
    expiresAt: deadline,
    routeDigest: digest(route),
    route,
  };
const output = {
  checkedAt: new Date().toISOString(),
  source: 'https://1click.chaindefuser.com',
  mode: 'READ_ONLY_DRY_QUOTES',
  authentication: c.ONECLICK_JWT ? 'AUTHENTICATED' : 'ANONYMOUS',
  signaturesVerified: true,
  chain,
  baseDecimals: origin.decimals,
  slippageBps,
  originAsset: origin.assetId,
  intermediateAsset: middle.assetId,
  profitCheck: quoteProfitCheck(quote, c.MIN_NET_PROFIT_ATOMS),
  quotedReturnFromQuotedFirstLegAtoms: quotedSecond.quote.amountOut,
  quotedGrossPnlFromQuotedFirstLegAtoms: (
    BigInt(quotedSecond.quote.amountOut) - BigInt(amount)
  ).toString(),
  disclosure:
    'Indicative signed quotes, not realized P&L. The reverse leg is not locked. Slippage bounds are protection, not charged fees. Preview allowances are not a complete realized cost basis. No trade or paid inference occurred.',
  first,
  second,
  quotedSecond,
};
await mkdir('.data/trading-gates', { recursive: true });
const saved = `.data/trading-gates/market-${chain}-${amount}-${slippageBps}.json`;
await writeFile(saved, JSON.stringify(output, null, 2), { mode: 0o600 });
const { first: _first, second: _second, quotedSecond: _quotedSecond, ...summary } = output;
console.log(JSON.stringify({ ...summary, saved }, null, 2));
