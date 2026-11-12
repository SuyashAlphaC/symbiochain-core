/** Reuse only the two confirmed native refunds; never repeat a pending deposit. */
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parse } from 'dotenv';
import { quoteHash } from '@defuse-protocol/one-click-sdk-typescript';
import { createCrossFundingApp } from './cross-funding-server.mjs';
import {
  ROWS,
  fundingTerms,
  assertFundingQuote,
  HAND,
  EVM_WALLET,
  SOL_WALLET,
} from './cross-funding-plan.mjs';
import { ROOT, UNIT, rpc, planDigest } from './plan.mjs';
import { loadConfig } from '../../dist/config.js';
import { OneClickClient } from '../../dist/providers/oneclick.js';
import { ChainWallets } from '../../dist/providers/wallets.js';
try {
  const dir = '.data/mainnet-gas-funding-retry',
    port = Number(process.argv[2] ?? 3427),
    stateDir = process.argv[3] ?? dir;
  assert.ok([3427, 3437].includes(port));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const previous = JSON.parse(await readFile('artifacts/mainnet-wallet-provisioning.json'));
  assert.equal(previous.capitalReturnedYocto, '100000000000000000000000');
  assert.equal(previous.status, 'PARTIAL_REFUNDED');
  assert.equal(previous.conversions.filter((c) => c.status === 'REFUNDED').length, 2);
  const c = loadConfig({
      ...parse(await readFile('.env', 'utf8')),
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
    }),
    one = new OneClickClient(c),
    wallets = new ChainWallets(c);
  assert.equal(await wallets.address('eip155:8453'), EVM_WALLET);
  assert.equal(await wallets.address('solana:mainnet'), SOL_WALLET);
  const rows = ROWS.slice(1).map((r) => ({ ...r, slippageBps: 50 }));
  let plan;
  try {
    plan = JSON.parse(await readFile(dir + '/plan.json'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const quotes = [];
    for (const r of rows)
      quotes.push(
        await one.quote(fundingTerms(r, new Date(Date.now() + 1800000).toISOString()), false),
      );
    quotes.forEach((q, i) => assertFundingQuote(rows[i], q));
    const raw = {
      scope: 'OWNER_FUNDED_MAINNET_WALLETS_NOT_REVENUE',
      network: 'mainnet',
      signerId: ROOT,
      capitalYocto: '100000000000000000000000',
      feeAllowanceYocto: '16000000000000000000000',
      totalPlanningCeilingYocto: previous.additionalCeilingYocto,
      minimumOwnerRemainingYocto: (UNIT / 5n).toString(),
      reusesConfirmedRefundsYocto: previous.capitalReturnedYocto,
      priorRetainedCapitalYocto: previous.retainedCapitalYocto,
      priorNetworkFeesYocto: previous.networkFeesYocto,
      fundingOnlySlippageBps: 50,
      quotes,
      transactions: quotes.map((q, i) => ({
        id: rows[i].id + '_refunded_retry',
        signerId: ROOT,
        receiverId: q.quote.depositAddress,
        actions: [{ type: 'Transfer', params: { deposit: rows[i].near.toString() } }],
      })),
      paidInferenceRequests: 0,
      automatedTradingEnabled: false,
    };
    assert.ok(
      BigInt(raw.priorRetainedCapitalYocto) +
        BigInt(raw.capitalYocto) +
        BigInt(raw.priorNetworkFeesYocto) +
        BigInt(raw.feeAllowanceYocto) <=
        BigInt(raw.totalPlanningCeilingYocto),
      'EXISTING_BUDGET_EXCEEDED',
    );
    plan = { ...raw, digest: planDigest(raw) };
    await writeFile(dir + '/plan.json', JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
  }
  const inspect = async () => {
    assert.equal(await wallets.evm.getChainId(), 8453);
    assert.equal(
      await wallets.solana.getGenesisHash(),
      '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    );
    const b = (await rpc('block', { finality: 'final' })).header,
      owner = await rpc('query', {
        request_type: 'view_account',
        account_id: ROOT,
        block_id: b.hash,
      }),
      hand = await rpc('query', {
        request_type: 'view_account',
        account_id: HAND,
        block_id: b.hash,
      });
    const block = (await wallets.evm.getBlockNumber()) - BigInt(c.EVM_CONFIRMATIONS) + 1n;
    return {
      block: { height: String(b.height), hash: b.hash },
      ownerBalanceYocto: owner.amount,
      ownerAvailableYocto: (
        BigInt(owner.amount) -
        BigInt(owner.storage_usage) * 10n ** 19n
      ).toString(),
      handBalanceYocto: hand.amount,
      eth: (await wallets.evm.getBalance({ address: EVM_WALLET, blockNumber: block })).toString(),
      sol: String(await wallets.solana.getBalance(new PublicKey(SOL_WALLET), 'finalized')),
      baseBlock: String(block),
      solSlot: String(await wallets.solana.getSlot('finalized')),
    };
  };
  const settlement = async (p, before, after, receipts) => {
    const results = [];
    for (let i = 0; i < 2; i++) {
      const q = p.quotes[i],
        s = await one.status(q.quote.depositAddress);
      assert.equal(s.status, 'SUCCESS', 'GAS_FUNDING_NOT_SETTLED');
      assert.equal(quoteHash(s.quoteResponse), quoteHash(q), 'SIGNED_QUOTE_CHANGED');
      assert.ok(
        s.swapDetails.originChainTxHashes.some((t) => t.hash === receipts[i].hash),
        'ORIGINAL_RECEIPT_NOT_BOUND',
      );
      assert.ok(BigInt(s.swapDetails.amountOut) >= BigInt(q.quote.minAmountOut));
      assert.ok(s.swapDetails.destinationChainTxHashes.length > 0);
      for (const t of s.swapDetails.destinationChainTxHashes) {
        if (i === 0) {
          const receipt = await wallets.evm.getTransactionReceipt({ hash: t.hash });
          assert.equal(receipt.status, 'success');
          assert.ok(receipt.blockNumber <= BigInt(after.baseBlock));
        } else {
          const incoming = await wallets.verifyIncoming(
            'solana:mainnet',
            'sol:native',
            SOL_WALLET,
            q.quote.minAmountOut,
            [t.hash],
            BigInt(before.solSlot),
          );
          assert.ok(incoming.verified, 'SOLANA_TRANSFER_NOT_VERIFIED');
        }
      }
      const key = i === 0 ? 'eth' : 'sol';
      assert.ok(
        BigInt(after[key]) - BigInt(before[key]) >= BigInt(q.quote.minAmountOut),
        'DERIVED_CREDIT_NOT_OBSERVED',
      );
      results.push({
        asset: rows[i].asset,
        recipient: rows[i].recipient,
        status: 'SUCCESS',
        minimumOutputAtoms: q.quote.minAmountOut,
        actualOutputAtoms: s.swapDetails.amountOut,
        destinationTransactions: s.swapDetails.destinationChainTxHashes,
      });
    }
    return results;
  };
  const page = (token) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="fixture-token" content="${token}"><title>SymbioChain refunded gas funding</title><style>body{font:17px system-ui;background:#132128;color:#eafff6;max-width:1000px;margin:35px auto;padding:20px;line-height:1.6}button,input{padding:14px;margin:8px}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>Reuse verified gas-funding refunds</h1><p>The earlier ETH and SOL conversions expired and returned exactly <strong>0.10 native NEAR</strong> to ${ROOT}. The USDC conversion and Hand gas deposit succeeded and will not be repeated.</p><p>Review two transfers: <strong>0.05 NEAR for Base ETH</strong> and <strong>0.05 NEAR for Solana SOL</strong>, each to a fresh signature-verified provider deposit. Funding conversions allow at most <strong>0.5% slippage</strong>; the treasury's trading policy remains zero-slippage. Minimum outputs are at least 0.00005 ETH and 0.0015 SOL. Actual signed minimums are shown below.</p><p>Combined retry network-fee planning ceiling: <strong>0.016 NEAR</strong>, including creation of two implicit deposit accounts. Reusing the confirmed refunds keeps retained capital plus all actual prior fees and this retry allowance below the unchanged <strong>0.50-NEAR additional budget</strong>. At least 0.20 NEAR remains in Meteor. No treasury top-up, key request, AI inference or automated trading is enabled.</p><details><summary>Exact transactions, signed quotes and output floors</summary><pre>${JSON.stringify(plan, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre></details><pre id="status">Checking finalized state…</pre><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I reviewed both refunded-capital transfers, funding slippage and the unchanged total budget.</label><button id="sign" disabled>Sign two reviewed funding transfers</button><button id="refresh">Reconcile existing receipts</button><h2>Reconcile an existing signature</h2><select id="index"><option value="0">Base ETH</option><option value="1">Solana SOL</option></select><input id="hash" size="50"><button id="verify">Verify existing receipt</button><script type="module" src="/client.js"></script></body></html>`;
  const app = await createCrossFundingApp({
    plan,
    page,
    fundingRows: rows,
    handFundingYocto: 0n,
    inspect,
    settlement,
    stateDir,
    port,
    client: await readFile(dir + '/client.js', 'utf8'),
    readTransaction: (h) =>
      rpc(
        'tx',
        { tx_hash: h, sender_account_id: ROOT, wait_until: 'FINAL' },
        'https://archival-rpc.mainnet.fastnear.com',
      ),
    readBlock: (h) => rpc('block', { block_id: h }, 'https://archival-rpc.mainnet.fastnear.com'),
  });
  await app.listen({ host: '127.0.0.1', port });
  console.log(
    JSON.stringify({
      portal: 'http://localhost:' + port,
      refundedCapitalReusedNear: '0.10',
      additionalTotalCeilingNear: '0.50',
      fundingSlippageBps: 50,
      transactionsSubmitted: 0,
      paidInferenceRequests: 0,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'RETRY_FUNDING_HELD',
      credentialValuesPrinted: false,
    }),
  );
  process.exitCode = 1;
}
