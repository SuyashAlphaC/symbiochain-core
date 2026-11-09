import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { inspectFunding } from './funding-server.mjs';
import { ROOT, UNIT, rpc } from './plan.mjs';
import { TREASURY } from './funding-plan.mjs';
import {
  SERVICE_DEPOSIT,
  SERVICE_FEE_ALLOWANCE,
  serviceGas,
  serviceTransaction,
  serviceDigest,
  verifyServiceReceipt,
} from './service-roundtrip-plan.mjs';

const PORT = 3419,
  ARCHIVE = 'https://archival-rpc.mainnet.near.org';
async function optional(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function contractView(method, args = {}) {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: TREASURY,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}
export async function inspectService() {
  const [s, balance, metabolism] = await Promise.all([
    inspectFunding(),
    contractView('service_balance', { account: ROOT }),
    contractView('check_metabolism'),
  ]);
  const estimate =
    2n *
    (BigInt(serviceGas.deposit) + BigInt(serviceGas.withdraw) + 6_000_000_000_000n) *
    BigInt(s.gasPriceYocto);
  if (
    estimate > SERVICE_FEE_ALLOWANCE ||
    BigInt(s.ownerAvailableYocto) < SERVICE_DEPOSIT + SERVICE_FEE_ALLOWANCE + UNIT / 20n
  )
    throw Error('SERVICE_BUDGET_EXCEEDED');
  if (!/^\d+$/.test(balance) || metabolism.status !== 'PAUSED')
    throw Error('SERVICE_STATE_UNVERIFIED');
  return {
    ...s,
    serviceBalanceYocto: balance,
    serviceLiabilityYocto: metabolism.service_liability_yocto,
    estimatedCombinedFeeYocto: estimate.toString(),
  };
}
export async function createServiceApp({
  stateDir = '.data/mainnet-service-roundtrip',
  client = '',
  inspect = inspectService,
  readTransaction = (hash) =>
    rpc('tx', { tx_hash: hash, sender_account_id: ROOT, wait_until: 'FINAL' }, ARCHIVE),
  readBlock = (hash) => rpc('block', { block_id: hash }, ARCHIVE),
} = {}) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const app = Fastify({ logger: false, bodyLimit: 4000 });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="service-token" content="${token}"><title>SymbioChain mainnet service-balance test</title><style>body{font:16px system-ui;background:#111c22;color:#e7f0f3;max-width:850px;margin:30px auto;padding:0 20px;line-height:1.6}section{border:1px solid #50626a;border-radius:14px;padding:20px;margin:20px 0}button,input{padding:12px;margin:8px 8px 8px 0}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}input[type=text]{width:90%}a{color:#77e7bb}</style></head><body><h1>Mainnet service-balance round trip</h1><p>Two owner-signed calls from <code>${ROOT}</code> to <code>${TREASURY}</code>. This is a self-funded escrow test, not agent commerce, profit, an Intents swap or an NFT distribution.</p><section><p><strong>Step 1: fund_services({}) with 0.002 NEAR.</strong> The contract deducts new storage collateral and credits the remainder to your own service balance.</p><p><strong>Step 2: withdraw_service_balance({amount: verified credit}).</strong> The exact credit is read after the first call confirms and returned to your same wallet. Storage collateral remains in the contract.</p><p>Total network-fee allowance: <strong>0.01 NEAR</strong>; deposit plus fee planning ceiling: <strong>0.012 NEAR</strong>. Actual gas price is checked before each signature; review Meteor's estimate. The allowance is not a protocol maximum gas-price field.</p><p>The treasury stays PAUSED, all workers disabled and execution disarmed. No access key, unpause, model request, trade or NFT mint is requested. The server holds no wallet key.</p><pre id="preflight">Checking finalized state…</pre></section><section><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I reviewed the bounded service-balance test and the return to my same wallet.</label><button id="send" disabled>Sign next test step</button><button id="refresh">Refresh state</button><pre id="status" role="status">Preparing…</pre></section><section><h2>Reconcile an existing signature</h2><p>Unknown outcomes block another signature. Paste the existing hash instead of repeating the call.</p><input id="hash" type="text" autocomplete="off" aria-label="Existing transaction hash"><button id="verify">Verify existing receipt</button></section><script type="module" src="/client.js"></script></body></html>`;
  app.addHook('onRequest', async (req, reply) => {
    const hosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
    if (!hosts.includes(req.headers.host))
      return reply.code(403).send({ code: 'HOST_NOT_ALLOWED' });
    if (req.headers.origin && !hosts.map((h) => 'http://' + h).includes(req.headers.origin))
      return reply.code(403).send({ code: 'ORIGIN_NOT_ALLOWED' });
    if (!['/', '/client.js', '/favicon.ico'].includes(req.url)) {
      const actual = String(req.headers['x-service-token'] ?? '');
      if (
        actual.length !== token.length ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(token))
      )
        return reply.code(401).send({ code: 'LOCAL_SESSION_REQUIRED' });
    }
  });
  app.addHook('onSend', async (_req, reply, body) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://free.rpc.fastnear.com https://*.meteorwallet.app; frame-src https://*.meteorwallet.app; img-src 'self' data: https://*.meteorwallet.app; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    return body;
  });
  app.setErrorHandler((e, _req, reply) =>
    reply
      .code(409)
      .send({ code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'SERVICE_TEST_HELD' }),
  );
  const state = async () => {
    const complete = await optional(`${stateDir}/complete.json`),
      fund = await optional(`${stateDir}/deposit.json`);
    return {
      phase: complete
        ? 'COMPLETE'
        : (await optional(`${stateDir}/withdraw-attempt.json`))
          ? 'WITHDRAW_PENDING'
          : fund
            ? 'WITHDRAW_READY'
            : (await optional(`${stateDir}/deposit-attempt.json`))
              ? 'DEPOSIT_PENDING'
              : 'READY',
      fund,
      complete,
    };
  };
  const plan = async () => {
    const s = await state();
    const step = s.phase === 'READY' ? 'deposit' : s.phase === 'WITHDRAW_READY' ? 'withdraw' : null;
    const credit = s.fund?.after.serviceBalanceYocto ?? '0';
    return {
      ...s,
      step,
      transaction: step ? serviceTransaction(step, credit) : null,
      digest: step ? serviceDigest(step, credit) : null,
    };
  };
  app.get('/', async (_req, reply) => reply.type('text/html').send(html));
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  app.get('/client.js', async (_req, reply) => reply.type('text/javascript').send(client));
  app.get('/plan', plan);
  app.get('/state', state);
  app.post('/preflight', async () => inspect());
  app.post('/begin', async (req) => {
    const p = await plan();
    if (!p.step || p.step !== req.body?.step || p.digest !== req.body?.planDigest)
      throw Error('SERVICE_STEP_NOT_READY');
    const before = await inspect();
    if (p.step === 'deposit' && before.serviceBalanceYocto !== '0')
      throw Error('PREEXISTING_SERVICE_BALANCE');
    if (p.step === 'withdraw' && before.serviceBalanceYocto !== p.fund.after.serviceBalanceYocto)
      throw Error('SERVICE_CREDIT_CHANGED');
    const spent = BigInt(p.fund?.transaction.actualFeeYocto ?? '0');
    if (
      spent +
        2n * (BigInt(serviceGas[p.step]) + 3_000_000_000_000n) * BigInt(before.gasPriceYocto) >
      SERVICE_FEE_ALLOWANCE
    )
      throw Error('SERVICE_FEE_ALLOWANCE_EXHAUSTED');
    await writeFile(
      `${stateDir}/${p.step}-attempt.json`,
      JSON.stringify({ at: new Date().toISOString(), before, transaction: p.transaction }),
      { flag: 'wx', mode: 0o600 },
    ).catch((e) => {
      if (e.code === 'EEXIST') throw Error('SERVICE_ATTEMPT_PENDING_VERIFY_EXISTING_HASH');
      throw e;
    });
    return { prepared: true };
  });
  let verifying = false;
  app.post('/observe', async (req) => {
    const { step, hash } = req.body ?? {};
    if (
      !['deposit', 'withdraw'].includes(step) ||
      typeof hash !== 'string' ||
      !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)
    )
      throw Error('INVALID_RECEIPT_INPUT');
    const s = await state();
    const recorded = step === 'deposit' ? s.fund : s.complete;
    if (recorded) {
      if (recorded.transaction.hash !== hash) throw Error('SERVICE_STEP_ALREADY_VERIFIED');
      return recorded;
    }
    const attempt = await optional(`${stateDir}/${step}-attempt.json`);
    if (!attempt) throw Error('SERVICE_ATTEMPT_REQUIRED');
    if (verifying) throw Error('VERIFICATION_RUNNING');
    verifying = true;
    try {
      const credit = s.fund?.after.serviceBalanceYocto ?? '0';
      const transaction = verifyServiceReceipt(await readTransaction(hash), hash, step, credit);
      const block = await readBlock(transaction.blockHash);
      if (BigInt(block.header.height) < BigInt(attempt.before.block.height))
        throw Error('TRANSACTION_PREDATES_ATTEMPT');
      const after = await inspect();
      if (BigInt(block.header.height) > BigInt(after.block.height))
        throw Error('FINAL_SNAPSHOT_NOT_READY');
      if (
        step === 'deposit' &&
        (BigInt(after.serviceBalanceYocto) <= 0n ||
          BigInt(after.serviceBalanceYocto) > SERVICE_DEPOSIT)
      )
        throw Error('SERVICE_CREDIT_NOT_VERIFIED');
      if (step === 'withdraw' && after.serviceBalanceYocto !== '0')
        throw Error('SERVICE_WITHDRAWAL_NOT_VERIFIED');
      const record = {
        checkedAt: new Date().toISOString(),
        scope: 'MAINNET_SELF_FUNDED_SERVICE_BALANCE_TEST',
        transaction,
        before: attempt.before,
        after,
        treasuryStayedPaused: true,
        workersStayedDisabled: true,
        paidInferenceRequests: 0,
        agentToAgentPayment: false,
        intentsSettlement: false,
        externalRevenue: false,
      };
      if (step === 'withdraw') {
        record.depositTransaction = s.fund.transaction;
        record.returnedYocto = credit;
        record.storageCollateralYocto = (SERVICE_DEPOSIT - BigInt(credit)).toString();
        record.totalFeeYocto = (
          BigInt(transaction.actualFeeYocto) + BigInt(s.fund.transaction.actualFeeYocto)
        ).toString();
        if (BigInt(record.totalFeeYocto) > SERVICE_FEE_ALLOWANCE)
          throw Error('TOTAL_SERVICE_FEE_ALLOWANCE_EXCEEDED');
        record.totalOwnerCostYocto = (
          BigInt(record.storageCollateralYocto) + BigInt(record.totalFeeYocto)
        ).toString();
        record.observedOwnerDebitYocto = (
          BigInt(s.fund.before.ownerAvailableYocto) - BigInt(after.ownerAvailableYocto)
        ).toString();
        record.walletBalanceReconciled =
          record.observedOwnerDebitYocto === record.totalOwnerCostYocto;
      }
      await writeFile(
        `${stateDir}/${step === 'deposit' ? 'deposit' : 'complete'}.json`,
        JSON.stringify(record, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      return record;
    } finally {
      verifying = false;
    }
  });
  return app;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const client = await readFile('.data/mainnet-service-roundtrip/client.js');
  const app = await createServiceApp({
    stateDir:
      process.env.SYMBIO_SERVICE_BROWSER_REHEARSAL === 'true'
        ? '.data/mainnet-service-browser'
        : '.data/mainnet-service-roundtrip',
    client,
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(
    JSON.stringify({
      portal: `http://localhost:${PORT}`,
      depositNEAR: '0.002',
      combinedFeeAllowanceNEAR: '0.01',
      planningCeilingNEAR: '0.012',
      walletKeysLoaded: false,
      paidInferenceRequests: 0,
    }),
  );
  for (const s of ['SIGINT', 'SIGTERM'])
    process.on(s, () => void app.close().then(() => process.exit(0)));
}
