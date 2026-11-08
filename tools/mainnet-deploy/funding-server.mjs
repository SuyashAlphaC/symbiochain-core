import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MainnetReader } from '../../dist/mainnet.js';
import { ROOT, RPC, rpc, WASM_SHA256 } from './plan.mjs';
import {
  fundingPlan,
  fundingDigest,
  validatePreflight,
  verifyFundingReceipt,
} from './funding-plan.mjs';

const PORT = 3418;
async function optional(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
export async function inspectFunding() {
  const m = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json', 'utf8'));
  if (m.wasmSha256 !== WASM_SHA256) throw Error('REVIEWED_CODE_HASH_CHANGED');
  const reader = new MainnetReader({
    EXECUTION_MODE: 'LIVE',
    EXECUTION_ENABLED: false,
    NEAR_NETWORK: 'mainnet',
    NEAR_RPC_URL: RPC,
    NEAR_CONTRACT_ID: m.treasury,
    NEAR_WORKER_ACCOUNT_ID: m.accounts.hand,
    NEAR_BRAIN_ACCOUNT_ID: m.accounts.brain,
    NEAR_SCOUT_ACCOUNT_ID: m.accounts.scout,
    NEAR_ACCOUNTANT_ACCOUNT_ID: m.accounts.accountant,
    NEAR_AI_MODEL: 'z-ai/glm-5.3-flash',
    AI_TOTAL_BUDGET_USD_MICROS: '1000000',
    AI_MAX_REQUEST_USD_MICROS: '100000',
  });
  const [snapshot, wallet, price, response] = await Promise.all([
    reader.snapshot(),
    reader.wallet(ROOT),
    rpc('gas_price', [null]),
    fetch('https://symbiochain.vercel.app/api/swarm/runtime', {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    }),
  ]);
  if (!response.ok) throw Error('PRODUCTION_RUNTIME_UNAVAILABLE');
  const runtime = await response.json();
  return {
    ...validatePreflight({ snapshot, wallet, gasPrice: price.gas_price, runtime }),
    checkedAt: new Date().toISOString(),
    paused: true,
    workersDisabled: true,
    executionEnabled: false,
    ownerAvailableYocto: wallet.availableYocto,
    gasPriceYocto: price.gas_price,
  };
}

export async function createFundingApp({
  stateDir = '.data/mainnet-funding',
  client = '',
  inspect = inspectFunding,
  readTransaction = (hash) =>
    rpc('tx', { tx_hash: hash, sender_account_id: ROOT, wait_until: 'FINAL' }),
  readBlock = (hash) => rpc('block', { block_id: hash }),
} = {}) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const app = Fastify({ logger: false, bodyLimit: 4000 });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="funding-token" content="${token}"><title>SymbioChain paused funding demo</title><style>body{font:16px system-ui;background:#111c22;color:#e7f0f3;max-width:850px;margin:30px auto;padding:0 20px;line-height:1.6}section{border:1px solid #50626a;border-radius:14px;padding:20px;margin:20px 0}button,input{padding:12px;margin:8px 8px 8px 0}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}input[type=text]{width:90%}a{color:#77e7bb}</style></head><body><h1>One paused treasury funding call</h1><p>This is team-funded mainnet capital. It is not customer revenue, profit, an NFT distribution or a compute-credit purchase.</p><section><p>From: <code>${ROOT}</code><br>To: <code>${fundingPlan.transaction.receiverId}</code><br>Method: <code>fund({})</code></p><p><strong>Deposit: 0.001 NEAR.</strong> Attached gas: 10 TGas. Network-fee allowance: 0.003 NEAR. Planning ceiling: <strong>0.004 NEAR</strong>. The fee allowance is checked against current gas pricing; NEAR has no transaction field enforcing a maximum gas price. Review Meteor's displayed fee before signing.</p><p>The treasury must remain PAUSED and all workers disabled before and after this call. There is no unpause, deployment, key grant, trading, NFT mint or AI request.</p><p>Owner recovery keys stay in Meteor. This server holds no wallet key and cannot sign.</p><pre id="preflight">Checking final mainnet state…</pre></section><section><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I reviewed the single 0.001 NEAR funding call and its fee allowance.</label><button id="fund" disabled>Sign 0.001 NEAR funding call</button><button id="refresh">Refresh state</button><pre id="status" role="status">Preparing…</pre></section><section><h2>Verify an existing signature</h2><p>If signing returns an uncertain result, paste its transaction hash here. Never send a second funding call to resolve an unknown outcome.</p><input id="hash" type="text" autocomplete="off" aria-label="Funding transaction hash"><button id="verify">Verify funding receipt</button><p><a href="https://symbiochain.vercel.app/dashboard" target="_blank" rel="noopener noreferrer">Open live mainnet dashboard</a> · <a href="https://symbiochain.vercel.app/testnet" target="_blank" rel="noopener noreferrer">Historical testnet evidence</a></p></section><script type="module" src="/client.js"></script></body></html>`;
  app.addHook('onRequest', async (req, reply) => {
    const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    if (!hosts.includes(req.headers.host))
      return reply.code(403).send({ code: 'HOST_NOT_ALLOWED' });
    if (req.headers.origin && !hosts.map((h) => 'http://' + h).includes(req.headers.origin))
      return reply.code(403).send({ code: 'ORIGIN_NOT_ALLOWED' });
    if (!['/', '/client.js', '/favicon.ico'].includes(req.url)) {
      const actual = String(req.headers['x-funding-token'] ?? '');
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
      .header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://free.rpc.fastnear.com https://*.meteorwallet.app; frame-src https://*.meteorwallet.app; img-src 'self' data: https://*.meteorwallet.app; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    return body;
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(409).send({ code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'FUNDING_HELD' }),
  );
  const state = async () => ({
    receipt: await optional(`${stateDir}/verified-receipt.json`),
    pending: !!(await optional(`${stateDir}/attempt.json`)),
  });
  const digest = (body) => {
    if (body?.planDigest !== fundingDigest) throw Error('FUNDING_PLAN_CHANGED');
  };
  app.get('/', async (_req, reply) => reply.type('text/html').send(html));
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  app.get('/client.js', async (_req, reply) => reply.type('text/javascript').send(client));
  app.get('/plan', async () => ({ ...fundingPlan, digest: fundingDigest }));
  app.get('/state', state);
  app.post('/preflight', async (req) => {
    digest(req.body);
    return inspect();
  });
  app.post('/begin', async (req) => {
    digest(req.body);
    if ((await state()).receipt) throw Error('FUNDING_ALREADY_VERIFIED');
    const before = await inspect();
    await writeFile(
      `${stateDir}/attempt.json`,
      JSON.stringify({ at: new Date().toISOString(), planDigest: fundingDigest, before }),
      { flag: 'wx', mode: 0o600 },
    ).catch((e) => {
      if (e.code === 'EEXIST') throw Error('FUNDING_ATTEMPT_PENDING_VERIFY_EXISTING_HASH');
      throw e;
    });
    return { prepared: true, before };
  });
  let verifying = false;
  app.post('/observe', async (req) => {
    const hash = req.body?.hash;
    if (typeof hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash))
      throw Error('INVALID_TRANSACTION_HASH');
    const current = await state();
    if (current.receipt) {
      if (current.receipt.transaction.hash !== hash) throw Error('FUNDING_ALREADY_VERIFIED');
      return current.receipt;
    }
    if (!current.pending) throw Error('FUNDING_ATTEMPT_REQUIRED');
    if (verifying) throw Error('VERIFICATION_ALREADY_RUNNING');
    verifying = true;
    try {
      const transaction = verifyFundingReceipt(await readTransaction(hash), hash);
      const before = (await optional(`${stateDir}/attempt.json`)).before;
      const block = await readBlock(transaction.blockHash);
      if (BigInt(block.header.height) < BigInt(before.block.height))
        throw Error('TRANSACTION_PREDATES_FUNDING_ATTEMPT');
      const after = await inspect();
      if (BigInt(block.header.height) > BigInt(after.block.height))
        throw Error('TRANSACTION_NOT_YET_IN_FINAL_SNAPSHOT');
      const record = {
        checkedAt: new Date().toISOString(),
        scope: 'PAUSED_MAINNET_TEAM_FUNDING_DEMO',
        transaction,
        before,
        after,
        treasuryStayedPaused: true,
        workersStayedDisabled: true,
        executionStayedDisarmed: true,
        paidInferenceRequests: 0,
        customerRevenueProven: false,
        nftDistributionPerformed: false,
        computeCreditsPurchased: false,
      };
      await writeFile(`${stateDir}/verified-receipt.json`, JSON.stringify(record, null, 2), {
        flag: 'wx',
        mode: 0o600,
      });
      return record;
    } finally {
      verifying = false;
    }
  });
  return app;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const client = await readFile('.data/mainnet-funding/client.js');
  const app = await createFundingApp({
    stateDir:
      process.env.SYMBIO_FUNDING_BROWSER_REHEARSAL === 'true'
        ? '.data/mainnet-funding-browser'
        : '.data/mainnet-funding',
    client,
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(
    JSON.stringify({
      portal: `http://localhost:${PORT}`,
      depositNEAR: '0.001',
      feeAllowanceNEAR: '0.003',
      planningCeilingNEAR: '0.004',
      ownerSignatureRequired: true,
      serverHoldsWalletKeys: false,
      paidInferenceRequests: 0,
    }),
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => void app.close().then(() => process.exit(0)));
}
