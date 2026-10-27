import { writeFile, mkdir } from 'node:fs/promises';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { OneClickClient } from '../src/providers/oneclick.js';
// Public read-only probe: never requests a deposit address or creates a transaction.
const c = loadConfig({ ...process.env, EXECUTION_MODE: 'PAPER' }),
  client = new OneClickClient(c);
const tokens = await client.tokens();
const origin = tokens.find((t) => t.blockchain === 'base' && t.symbol === 'USDC');
const middle = tokens.find((t) => t.assetId === 'nep141:sol.omft.near');
if (!origin || !middle) throw new Error('Supported assets unavailable');
const originAddress = privateKeyToAccount(generatePrivateKey()).address,
  solanaAddress = Keypair.generate().publicKey.toBase58();
const deadline = new Date(Date.now() + 1800000).toISOString();
const first = await client.quote(
  {
    originAsset: origin.assetId,
    destinationAsset: middle.assetId,
    amount: '10000000',
    recipient: solanaAddress,
    refundTo: originAddress,
    deadline,
    slippageBps: 50,
  },
  true,
);
const second = await client.quote(
  {
    originAsset: middle.assetId,
    destinationAsset: origin.assetId,
    amount: first.quote.minAmountOut,
    recipient: originAddress,
    refundTo: solanaAddress,
    deadline,
    slippageBps: 50,
  },
  true,
);
const output = {
  checkedAt: new Date().toISOString(),
  source: 'https://1click.chaindefuser.com',
  mode: 'READ_ONLY_DRY_QUOTES',
  signaturesVerified: true,
  originAsset: origin.assetId,
  intermediateAsset: middle.assetId,
  inputAtoms: '10000000',
  conservativeReturnAtoms: second.quote.minAmountOut,
  grossPreviewAtoms: (BigInt(second.quote.minAmountOut) - 10_000_000n).toString(),
  disclosure:
    'Signed quote previews only. No deposits, swaps, signatures from Chain Signatures, model inference, or realized profit.',
  first,
  second,
};
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/market-probe.json', JSON.stringify(output, null, 2));
console.log(
  JSON.stringify(
    {
      checkedAt: output.checkedAt,
      mode: output.mode,
      signaturesVerified: true,
      grossPreviewAtoms: output.grossPreviewAtoms,
      saved: 'artifacts/market-probe.json',
    },
    null,
    2,
  ),
);
