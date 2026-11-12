/** Explicit, disarmed configuration and receipt-backed owner capital import. Never arms execution. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import { MainnetReader } from '../src/mainnet.js';
import { matchesMainnetPolicy } from '../src/mainnet-activation.js';
import { ChainWallets } from '../src/providers/wallets.js';
import { OneClickClient } from '../src/providers/oneclick.js';
import { httpJson } from '../src/providers/http.js';
async function main() {
  const c = loadConfig();
  assert.equal(c.EXECUTION_MODE, 'LIVE');
  assert.equal(c.NEAR_NETWORK, 'mainnet');
  for (const enabled of [
    c.EXECUTION_ENABLED,
    c.LIVE_TRADING_ENABLED,
    c.LIVE_ARBITRAGE_ENABLED,
    c.BUSINESS_PAYOUTS_ENABLED,
  ])
    assert.equal(enabled, false, 'PAID_EXECUTION_MUST_STAY_DISABLED');
  const record = JSON.parse(await readFile('artifacts/mainnet-wallet-provisioning.json', 'utf8'));
  const manifest = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json', 'utf8'));
  assert.equal(c.NEAR_CONTRACT_ID, manifest.treasury);
  const reader = new MainnetReader(c),
    snap = await reader.snapshot(),
    p = await reader.activationPolicy(snap.block.hash);
  assert.ok(snap.code.matches && !snap.paused);
  assert.ok(matchesMainnetPolicy(c, p), 'ONCHAIN_LIMITS_MUST_MATCH_CONFIGURATION');
  const wallets = new ChainWallets(c),
    address = await wallets.address('eip155:8453');
  assert.deepEqual(c.ALLOWED_CHAINS, ['eip155:8453', 'solana:mainnet']);
  assert.deepEqual(c.ALLOWED_RECIPIENTS, [address]);
  assert.deepEqual(c.ALLOWED_ASSETS, [c.BASE_ASSET, 'nep141:sol.omft.near']);
  assert.equal(c.MAX_SLIPPAGE_BPS, 0);
  const source = record.funding.find((t: { label: string }) => t.label === 'base_usdc');
  assert.ok(source);
  const near = (await httpJson('https://archival-rpc.mainnet.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'owner-capital-proof',
      method: 'tx',
      params: {
        tx_hash: source.hash,
        sender_account_id: manifest.ownerFundingAccount,
        wait_until: 'FINAL',
      },
    }),
  })) as any;
  const tx = near.result;
  assert.equal(tx.final_execution_status, 'FINAL');
  assert.equal(tx.transaction.hash, source.hash);
  assert.equal(tx.transaction.signer_id, manifest.ownerFundingAccount);
  assert.equal(tx.transaction.actions.length, 1);
  assert.equal(tx.transaction.actions[0].Transfer.deposit, source.amountYocto);
  assert.ok(!tx.status.Failure && tx.receipts_outcome.every((r: any) => !r.outcome.status.Failure));
  const status = await new OneClickClient(c).status(tx.transaction.receiver_id);
  assert.equal(status.status, 'SUCCESS');
  assert.equal(status.quoteResponse.quoteRequest.recipient, address);
  assert.equal(status.quoteResponse.quoteRequest.destinationAsset, c.BASE_ASSET);
  assert.equal(status.quoteResponse.quoteRequest.refundTo, manifest.ownerFundingAccount);
  assert.equal(status.quoteResponse.quote.amountIn, source.amountYocto);
  assert.ok(status.swapDetails.originChainTxHashes.some((t) => t.hash === source.hash));
  const amount = BigInt(status.swapDetails.amountOut!),
    hashes = status.swapDetails.destinationChainTxHashes.map((t) => t.hash);
  assert.ok(amount > 0n && hashes.length === 1);
  const receipt = await wallets.evm.getTransactionReceipt({ hash: hashes[0] as `0x${string}` });
  const credit = await wallets.verifyIncoming(
    'eip155:8453',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    address,
    amount.toString(),
    hashes,
    receipt.blockNumber - 1n,
  );
  assert.ok(credit.verified, 'OWNER_CAPITAL_RECEIPT_NOT_VERIFIED');
  const db = createDatabase(c.DATABASE_URL, 1),
    store = new Store(db, c);
  try {
    const before = await db.policy.findUniqueOrThrow({ where: { mode: 'LIVE' } });
    assert.equal(before.paused, true);
    assert.equal(
      await db.cycle.count({
        where: {
          mode: 'LIVE',
          state: { notIn: ['CLOSED', 'REJECTED', 'EXPIRED', 'REFUNDED', 'FAILED'] },
        },
      }),
      0,
      'ACTIVE_CYCLES_REQUIRE_SEPARATE_MIGRATION',
    );
    const next = {
      paused: true,
      maxTradeAtoms: c.MAX_TRADE_ATOMS,
      maxDailySpendAtoms: c.MAX_DAILY_SPEND_ATOMS,
      minReserveAtoms: c.MIN_RESERVE_ATOMS,
      minNetProfitAtoms:
        BigInt(c.MIN_NET_PROFIT_ATOMS) > BigInt(before.minNetProfitAtoms.toFixed(0))
          ? c.MIN_NET_PROFIT_ATOMS
          : before.minNetProfitAtoms.toFixed(0),
      maxSlippageBps: 0,
      allowedAssets: c.ALLOWED_ASSETS,
      allowedChains: c.ALLOWED_CHAINS,
      allowedRecipients: c.ALLOWED_RECIPIENTS,
    };
    const reference = 'owner-capital:base:' + hashes[0];
    const apply = process.argv.includes('--apply');
    const existed = await db.journal.findUnique({
      where: { mode_reference: { mode: 'LIVE', reference } },
    });
    if (!existed)
      assert.ok(
        (await wallets.balance('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')) >=
          amount,
        'FUNDED_CAPITAL_NOT_PRESENT',
      );
    if (apply) {
      await store.atomic(async (q) => {
        const current = await q.policy.findUniqueOrThrow({ where: { mode: 'LIVE' } });
        assert.equal(current.revision, before.revision, 'POLICY_CHANGED');
        assert.equal(current.paused, true);
        await q.policy.update({
          where: { mode: 'LIVE' },
          data: { ...next, revision: { increment: 1 } },
        });
        const inserted = await store.journal(q, reference, 'CAPITAL', [
          { account: 'TREASURY', asset: c.BASE_ASSET, amountAtoms: amount },
          { account: 'EXTERNAL_CAPITAL', asset: c.BASE_ASSET, amountAtoms: -amount },
        ]);
        await store.event(q, 'mainnet.configuration', {
          paused: true,
          ownerPolicyBlock: snap.block.hash,
          capitalReceipt: hashes[0],
          capitalSource: 'VERIFIED_OWNER_FUNDING_NOT_REVENUE',
          amountAtoms: amount.toString(),
          capitalImported: inserted,
          paidInferenceRequests: 0,
        });
      });
    }
    const report = {
      checkedAt: new Date().toISOString(),
      scope: 'DISARMED_MAINNET_POLICY_AND_OWNER_CAPITAL',
      applied: apply,
      policyPaused: true,
      onChainPolicyMatched: true,
      capitalSource: 'VERIFIED_OWNER_FUNDING_NOT_REVENUE',
      capitalReceipt: hashes[0],
      capitalAtoms: amount.toString(),
      journalBalanceAtoms: (await store.balance()).toString(),
      policy: next,
      paidInferenceRequests: 0,
      transactionsSubmitted: 0,
      externalRevenueProven: false,
    };
    await mkdir('.data/mainnet-configuration', { recursive: true, mode: 0o700 });
    await writeFile(
      '.data/mainnet-configuration/' + (apply ? 'applied' : 'preview') + '.json',
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report));
  } finally {
    await db.$disconnect();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'MAINNET_CONFIGURATION_HELD',
      credentialValuesPrinted: false,
    }),
  );
  process.exitCode = 1;
});
