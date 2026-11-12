import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ROOT, UNIT, rpc, planDigest } from './plan.mjs';
import { verifyActivationReceipt } from './activation-plan.mjs';
import {
  ROWS,
  HAND,
  makeCrossFundingPlan,
  fundingTerms,
  assertFundingQuote,
} from './cross-funding-plan.mjs';
const ARCHIVE = 'https://archival-rpc.mainnet.fastnear.com';
const optional = async (p) => {
  try {
    return JSON.parse(await readFile(p));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
export async function createCrossFundingApp({
  plan,
  inspect,
  settlement,
  readTransaction,
  readBlock,
  stateDir = '.data/mainnet-cross-funding',
  port = 3424,
  client = '',
} = {}) {
  assert.equal(plan.scope, 'OWNER_FUNDED_MAINNET_WALLETS_NOT_REVENUE');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex'),
    app = Fastify({ logger: false, bodyLimit: 4000 });
  app.addHook('onRequest', async (q, r) => {
    const hosts = ['localhost:' + port, '127.0.0.1:' + port];
    if (
      !hosts.includes(q.headers.host) ||
      (q.headers.origin && !hosts.map((h) => 'http://' + h).includes(q.headers.origin))
    )
      return r.code(403).send({ code: 'LOCAL_ORIGIN_REQUIRED' });
    if (!['/', '/client.js', '/favicon.ico'].includes(q.url)) {
      const t = String(q.headers['x-fixture-token'] ?? '');
      if (t.length !== token.length || !timingSafeEqual(Buffer.from(t), Buffer.from(token)))
        return r.code(401).send({ code: 'LOCAL_SESSION_REQUIRED' });
    }
  });
  app.addHook('onSend', async (_q, r, b) => {
    r.header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://free.rpc.fastnear.com https://*.meteorwallet.app; frame-src https://*.meteorwallet.app; img-src 'self' data: https://*.meteorwallet.app; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    return b;
  });
  app.setErrorHandler((e, _q, r) =>
    r.code(409).send({ code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'CROSS_FUNDING_HELD' }),
  );
  async function state() {
    return {
      pending: !!(await optional(stateDir + '/attempt.json')),
      receipts: await Promise.all(
        plan.transactions.map((t) => optional(stateDir + '/' + t.id + '.json')),
      ),
      complete: await optional(stateDir + '/complete.json'),
    };
  }
  const bind = (b) => assert.equal(b?.planDigest, plan.digest, 'PLAN_CHANGED');
  app.get('/', async (_q, r) =>
    r
      .type('text/html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="fixture-token" content="${token}"><title>SymbioChain bounded mainnet wallet funding</title><style>body{font:17px system-ui;background:#142127;color:#e6f4f2;max-width:1000px;margin:35px auto;padding:20px;line-height:1.6}button,input{padding:12px;margin:8px}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#6ee5ba}</style></head><body><h1>Fund owned mainnet wallets</h1><p>Four transfers from <strong>${ROOT}</strong>: <strong>0.25 NEAR</strong> to Hand for MPC gas reservation; <strong>0.10 NEAR</strong> converted to Base USDC; <strong>0.05 NEAR</strong> converted to Base ETH; <strong>0.05 NEAR</strong> converted to Solana SOL. Capital totals <strong>0.45 NEAR</strong>. Combined funding/continuation fee allowance: <strong>0.05 NEAR</strong>. Additional funding and fees must stay below <strong>0.50 NEAR</strong>. At least <strong>0.20 NEAR</strong> stays in Meteor; no treasury top-up or withdrawal is requested.</p><p>Cross-chain outputs go only to the treasury's derived wallets. Each provider quote is signature-verified, has a fixed input and minimum output, and refunds only to your Meteor account. Provider conversion fees reduce the funded capital. This is owner-funded provisioning, not arbitrage, profit or external revenue. Funding does not authorize AI, an MPC request or automated spending. No access key is requested.</p><p>The proposed later bounded gas profile is at most 100,000 EVM gas at 0.5 gwei and a 0.001 SOL reserve. Hand will separately need an owner-signed same-key treasury gas-allowance repair before MPC testing. AI stays quarantined; existing 0.05/0.10-USDC contract limits are unchanged by these transfers.</p><details><summary>Exact transactions, signed quotes and minimum outputs</summary><pre>${JSON.stringify(plan, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre></details><pre id="status">Checking finalized state…</pre><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I reviewed all four transfers, conversion minimums, refund account and 0.50-NEAR ceiling.</label><button id="sign" disabled>Sign four reviewed funding transfers</button><button id="refresh">Reconcile existing receipts</button><h2>Reconcile an existing hash</h2><p>Partial or unknown results block another signature. Select the original transfer and paste its existing hash.</p><select id="index">${plan.transactions.map((t, i) => `<option value="${i}">${i + 1}. ${t.id}</option>`).join('')}</select><input id="hash" size="50"><button id="verify">Verify existing receipt</button><script type="module" src="/client.js"></script></body></html>`,
      ),
  );
  app.get('/client.js', async (_q, r) => r.type('text/javascript').send(client));
  app.get('/favicon.ico', async (_q, r) => r.code(204).send());
  app.get('/plan', async () => plan);
  app.get('/state', state);
  app.post('/preflight', async (q) => {
    bind(q.body);
    return inspect();
  });
  app.post('/begin', async (q) => {
    bind(q.body);
    const s = await state();
    assert.ok(!s.pending && !s.complete, 'EXISTING_ATTEMPT_REQUIRES_RECONCILIATION');
    for (let i = 0; i < ROWS.length; i++) assertFundingQuote(ROWS[i], plan.quotes[i]);
    const before = await inspect();
    assert.ok(
      BigInt(before.ownerAvailableYocto) >=
        BigInt(plan.capitalYocto) + BigInt(plan.feeAllowanceYocto) + UNIT / 5n,
      'OWNER_RESERVE_PROTECTED',
    );
    await writeFile(
      stateDir + '/attempt.json',
      JSON.stringify({ at: new Date().toISOString(), planDigest: plan.digest, before }),
      { flag: 'wx', mode: 0o600 },
    );
    return { prepared: true };
  });
  let observing = false;
  app.post('/observe', async (q) => {
    bind(q.body);
    const { index, hash } = q.body;
    assert.ok(Number.isInteger(index) && index >= 0 && index < 4, 'TRANSFER_INDEX_REQUIRED');
    assert.match(hash ?? '', /^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'INVALID_HASH');
    assert.ok(!observing, 'RECONCILIATION_IN_PROGRESS');
    observing = true;
    try {
      const s = await state();
      assert.ok(s.pending, 'ORIGINAL_ATTEMPT_REQUIRED');
      if (s.receipts[index]) {
        assert.equal(s.receipts[index].hash, hash, 'RECEIPT_ALREADY_BOUND');
        return s.receipts[index];
      }
      assert.ok(!s.receipts.some((t) => t?.hash === hash), 'DUPLICATE_RECEIPT');
      await writeFile(
        stateDir + '/' + plan.transactions[index].id + '-observed.json',
        JSON.stringify({ hash, unverified: true }),
        { mode: 0o600 },
      );
      const t = verifyActivationReceipt(
        await readTransaction(hash),
        hash,
        plan.transactions[index],
        UNIT / 200n,
      );
      const attempt = await optional(stateDir + '/attempt.json');
      const b = await readBlock(t.blockHash);
      assert.ok(
        BigInt(b.header.height) >= BigInt(attempt.before.block.height),
        'RECEIPT_PREDATES_ATTEMPT',
      );
      await writeFile(stateDir + '/' + plan.transactions[index].id + '.json', JSON.stringify(t), {
        mode: 0o600,
        flag: 'wx',
      });
      return t;
    } finally {
      observing = false;
    }
  });
  app.post('/reconcile', async (q) => {
    bind(q.body);
    const s = await state();
    if (s.complete) return s.complete;
    assert.ok(s.receipts.every(Boolean), 'FOUR_FINAL_RECEIPTS_REQUIRED');
    const attempt = await optional(stateDir + '/attempt.json'),
      after = await inspect();
    const fees = s.receipts.reduce((n, t) => n + BigInt(t.actualFeeYocto), 0n);
    assert.ok(fees <= BigInt(plan.feeAllowanceYocto), 'FEE_CEILING_EXCEEDED');
    assert.equal(
      BigInt(after.ownerBalanceYocto),
      BigInt(attempt.before.ownerBalanceYocto) - BigInt(plan.capitalYocto) - fees,
      'OWNER_DEBIT_NOT_RECONCILED',
    );
    assert.ok(
      BigInt(after.handBalanceYocto) >= BigInt(attempt.before.handBalanceYocto) + UNIT / 4n,
      'HAND_FUNDING_NOT_OBSERVED',
    );
    const destinations = await settlement(plan, attempt.before, after, s.receipts);
    const complete = {
      checkedAt: new Date().toISOString(),
      scope: plan.scope,
      network: 'mainnet',
      fundingReceipts: s.receipts,
      destinations,
      capitalYocto: plan.capitalYocto,
      nativeFeesYocto: fees.toString(),
      totalPlanningCeilingYocto: plan.totalPlanningCeilingYocto,
      paidInferenceRequests: 0,
      externalRevenueProven: false,
      automatedTradingEnabled: false,
    };
    await writeFile(stateDir + '/complete.json', JSON.stringify(complete, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    return complete;
  });
  return app;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const dir = '.data/mainnet-cross-funding',
    stateDir = process.argv[3] ?? dir,
    port = Number(process.argv[2] ?? 3424);
  assert.ok([3424, 3434].includes(port), 'LOOPBACK_PORT_REQUIRED');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { parse } = await import('dotenv');
  const { loadConfig } = await import('../../dist/config.js');
  const { OneClickClient } = await import('../../dist/providers/oneclick.js');
  const c = loadConfig({
      ...parse(await readFile('.env', 'utf8')),
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
    }),
    client = new OneClickClient(c);
  assert.equal(c.NEAR_CONTRACT_ID, 'treasury.symbio-fcef733893.near');
  assert.equal(c.CHAIN_DERIVATION_PATH, 'symbio-mainnet-v1');
  assert.equal(c.NEAR_NETWORK, 'mainnet');
  const { ChainWallets } = await import('../../dist/providers/wallets.js');
  const wallets = new ChainWallets(c);
  const probe = {
    evmAddress: await wallets.address('eip155:8453'),
    solanaAddress: await wallets.address('solana:mainnet'),
  };
  assert.equal(probe.evmAddress, '0xE9464975ECAFa3e27AC1048C16a3406395061092');
  assert.equal(probe.solanaAddress, 'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f');
  let plan = await optional(dir + '/plan.json');
  if (!plan) {
    const deadline = new Date(Date.now() + 1200000).toISOString(),
      quotes = [];
    for (const row of ROWS) quotes.push(await client.quote(fundingTerms(row, deadline), false));
    plan = makeCrossFundingPlan(quotes);
    await writeFile(dir + '/plan.json', JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
  }
  const plain = { ...plan };
  delete plain.digest;
  assert.equal(planDigest(plain), plan.digest, 'SAVED_PLAN_CHANGED');
  const { createPublicClient, http, parseAbi } = await import('viem');
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const evm = createPublicClient({ transport: http(c.EVM_RPC_URL) }),
    sol = new Connection(c.SOLANA_RPC_URL, 'finalized');
  const inspect = async () => {
    assert.equal(await evm.getChainId(), 8453);
    assert.equal(await sol.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    const b = (await rpc('block', { finality: 'final' })).header;
    const owner = await rpc('query', {
        request_type: 'view_account',
        account_id: ROOT,
        block_id: b.hash,
      }),
      hand = await rpc('query', {
        request_type: 'view_account',
        account_id: HAND,
        block_id: b.hash,
      });
    const { MainnetReader } = await import('../../dist/mainnet.js');
    const observed = await new MainnetReader(c).snapshot();
    assert.ok(observed.code.matches, 'TREASURY_CODE_CHANGED');
    assert.equal(observed.treasuryAccount, c.NEAR_CONTRACT_ID);
    const base = (await evm.getBlockNumber()) - BigInt(c.EVM_CONFIRMATIONS) + 1n;
    return {
      block: { height: String(b.height), hash: b.hash },
      ownerAvailableYocto: (
        BigInt(owner.amount) -
        BigInt(owner.storage_usage) * 10n ** 19n
      ).toString(),
      ownerBalanceYocto: owner.amount,
      handBalanceYocto: hand.amount,
      baseBlock: base.toString(),
      usdc: (
        await evm.readContract({
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
          functionName: 'balanceOf',
          args: [probe.evmAddress],
          blockNumber: base,
        })
      ).toString(),
      eth: (await evm.getBalance({ address: probe.evmAddress, blockNumber: base })).toString(),
      sol: String(await sol.getBalance(new PublicKey(probe.solanaAddress), 'finalized')),
    };
  };
  const settlement = async (p, before, after) => {
    const out = [];
    for (let i = 0; i < ROWS.length; i++) {
      const row = ROWS[i],
        q = p.quotes[i],
        s = await client.status(q.quote.depositAddress);
      assert.equal(s.status, 'SUCCESS', 'CROSS_CHAIN_SETTLEMENT_PENDING');
      assert.equal(planDigest(s.quoteResponse), planDigest(q), 'SETTLEMENT_QUOTE_MISMATCH');
      assert.ok(
        BigInt(s.swapDetails.amountOut) >= BigInt(q.quote.minAmountOut),
        'DESTINATION_MINIMUM_NOT_MET',
      );
      assert.ok(s.swapDetails.destinationChainTxHashes.length > 0, 'DESTINATION_RECEIPT_REQUIRED');
      for (const t of s.swapDetails.destinationChainTxHashes) {
        if (i < 2) {
          const r = await evm.getTransactionReceipt({ hash: t.hash });
          assert.equal(r.status, 'success');
          assert.ok(after.baseBlock && r.blockNumber <= BigInt(after.baseBlock));
        } else {
          const r = await sol.getTransaction(t.hash, {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
          });
          assert.ok(r && !r.meta.err, 'SOLANA_RECEIPT_NOT_FINAL');
        }
      }
      const key = ['usdc', 'eth', 'sol'][i];
      assert.ok(
        BigInt(after[key]) - BigInt(before[key]) >= BigInt(q.quote.minAmountOut),
        'DERIVED_BALANCE_CREDIT_UNCONFIRMED',
      );
      out.push({
        asset: row.asset,
        recipient: row.recipient,
        minimumOutput: q.quote.minAmountOut,
        observedBalanceIncrease: (BigInt(after[key]) - BigInt(before[key])).toString(),
        destinationTransactions: s.swapDetails.destinationChainTxHashes,
      });
    }
    return out;
  };
  const app = await createCrossFundingApp({
    plan,
    stateDir,
    port,
    inspect,
    settlement,
    client: await readFile(dir + '/client.js', 'utf8'),
    readTransaction: (h) =>
      rpc('tx', { tx_hash: h, sender_account_id: ROOT, wait_until: 'FINAL' }, ARCHIVE),
    readBlock: (h) => rpc('block', { block_id: h }, ARCHIVE),
  });
  await app.listen({ host: '127.0.0.1', port });
  console.log(
    JSON.stringify({
      portal: 'http://localhost:' + port,
      capitalNear: '0.45',
      totalAdditionalCeilingNear: '0.50',
      serverHoldsOwnerKey: false,
      transactionsSubmitted: 0,
    }),
  );
}
