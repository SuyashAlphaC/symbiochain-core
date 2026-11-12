import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rpc, ROOT, UNIT } from './plan.mjs';
import { verifyActivationReceipt } from './activation-plan.mjs';
import {
  intentsFundingPlan,
  BRAIN,
  HAND,
  FUND_PER_AGENT,
  INTENTS_FUNDING_FEE,
} from './intents-funding-plan.mjs';
const PORT = 3421,
  DIR = '.data/mainnet-intents-fixture/funding';
const optional = async (path) => {
  try {
    return JSON.parse(await readFile(path));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
export async function intentsBalance(account, block) {
  const r = await rpc('query', {
    request_type: 'call_function',
    ...(block ? { block_id: block } : { finality: 'final' }),
    account_id: 'intents.near',
    method_name: 'mt_balance_of',
    args_base64: Buffer.from(
      JSON.stringify({ account_id: account, token_id: 'nep141:wrap.near' }),
    ).toString('base64'),
  });
  const n = JSON.parse(Buffer.from(r.result).toString());
  assert.match(n, /^(0|[1-9]\d*)$/);
  return n;
}
export async function inspectIntentsFunding() {
  const b = (await rpc('block', { finality: 'final' })).header;
  const [root, bounds, brain, hand, price] = await Promise.all([
    rpc('query', { request_type: 'view_account', account_id: ROOT, block_id: b.hash }),
    rpc('query', {
      request_type: 'call_function',
      account_id: 'wrap.near',
      block_id: b.hash,
      method_name: 'storage_balance_bounds',
      args_base64: 'e30=',
    }),
    intentsBalance(BRAIN, b.hash),
    intentsBalance(HAND, b.hash),
    rpc('gas_price', [b.hash]),
  ]);
  assert.equal(
    JSON.parse(Buffer.from(bounds.result).toString()).min,
    '1250000000000000000000',
    'WRAP_STORAGE_CHANGED',
  );
  const estimate = 165000000000000n * BigInt(price.gas_price);
  assert.ok(estimate <= INTENTS_FUNDING_FEE, 'FEE_CEILING_EXCEEDED');
  const available = BigInt(root.amount) - BigInt(root.storage_usage) * 10000000000000000000n;
  assert.ok(
    available > UNIT / 5n + INTENTS_FUNDING_FEE + 3250000000000000000000n,
    'OWNER_RESERVE_PROTECTED',
  );
  return {
    block: { height: String(b.height), hash: b.hash },
    ownerBalanceYocto: root.amount,
    brain,
    hand,
    feeEstimateYocto: estimate.toString(),
  };
}
export async function createIntentsFundingApp({
  client = '',
  stateDir = DIR,
  inspect = inspectIntentsFunding,
  readBlock = (hash) => rpc('block', { block_id: hash }),
  port = PORT,
  readTransaction = (hash) =>
    rpc(
      'tx',
      { tx_hash: hash, sender_account_id: ROOT, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    ),
} = {}) {
  const plan = intentsFundingPlan();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const app = Fastify({ logger: false, bodyLimit: 2000 });
  app.addHook('onRequest', async (req, reply) => {
    const allowed = ['localhost:' + port, '127.0.0.1:' + port];
    if (
      !allowed.includes(req.headers.host) ||
      (req.headers.origin && !allowed.map((h) => 'http://' + h).includes(req.headers.origin))
    )
      return reply.code(403).send({ code: 'LOCAL_ORIGIN_REQUIRED' });
    if (!['/', '/client.js', '/favicon.ico'].includes(req.url)) {
      const t = String(req.headers['x-fixture-token'] ?? '');
      if (t.length !== token.length || !timingSafeEqual(Buffer.from(t), Buffer.from(token)))
        return reply.code(401).send({ code: 'LOCAL_SESSION_REQUIRED' });
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
    r.code(409).send({ code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'FUNDING_HELD' }),
  );
  const state = async () => ({
    receipt: await optional(stateDir + '/receipt.json'),
    pending: !!(await optional(stateDir + '/attempt.json')),
  });
  const body = (b) => assert.equal(b?.planDigest, plan.digest, 'PLAN_CHANGED');
  app.get('/', async (_q, r) =>
    r
      .type('text/html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="fixture-token" content="${token}"><title>SymbioChain controlled Intents funding</title><style>body{font:17px system-ui;background:#142127;color:#e6f4f2;max-width:1000px;margin:40px auto;padding:20px;line-height:1.6}button,input{padding:14px;margin:10px}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#6ee5ba}</style></head><body><h1>Controlled mainnet Intents payment fixture</h1><p>One transaction from <strong>${ROOT}</strong> to <strong>wrap.near</strong>, with four reviewed calls. Deposit up to <strong>0.00125 NEAR</strong> refundable storage collateral, wrap <strong>0.002 NEAR</strong>, then credit <strong>0.001 wNEAR each</strong> to Brain and Hand inside Intents. Each transfer-call attaches 1 yoctoNEAR.</p><p>Owner transaction fee planning allowance: <strong>0.017 NEAR</strong>. The earlier failed batch cost 0.00063244 NEAR in fees and credited no agent. That fee counts toward the same test budget. The complete funding and two-agent-payment fixture has a <strong>0.03 NEAR planning ceiling</strong>. At least <strong>0.20 NEAR</strong> stays in your wallet. Existing treasury funds and its 0.10 NEAR reserve are untouched.</p><p>The subsequent two payments are capped at 0.0001 wNEAR each: Brain pays Scout, then Hand pays Brain. They prove internal Intents settlement mechanics. No AI approval, external revenue, profitable trade, NFT distribution or compute purchase is claimed. No recovery key or key grant is requested.</p><details><summary>Full exact plan</summary><pre>${JSON.stringify(plan, null, 2)}</pre></details><pre id="status">Checking finalized mainnet state…</pre><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I reviewed the bounded funding and internal payment fixture.</label><button id="sign" disabled>Sign reviewed Intents funding</button><h2>Reconcile an existing signature</h2><p>Unknown outcomes prevent another signature. Paste the existing transaction hash.</p><input id="hash" size="55" autocomplete="off"><button id="verify">Verify existing receipt</button><script type="module" src="/client.js"></script></body></html>`,
      ),
  );
  app.get('/client.js', async (_q, r) => r.type('text/javascript').send(client));
  app.get('/favicon.ico', async (_q, r) => r.code(204).send());
  app.get('/plan', async () => plan);
  app.get('/state', state);
  app.post('/preflight', async (req) => {
    body(req.body);
    return inspect();
  });
  app.post('/begin', async (req) => {
    body(req.body);
    const s = await state();
    assert.ok(!s.pending && !s.receipt, 'EXISTING_ATTEMPT_REQUIRES_RECONCILIATION');
    const before = await inspect();
    await writeFile(
      stateDir + '/attempt.json',
      JSON.stringify({ at: new Date().toISOString(), planDigest: plan.digest, before }),
      { flag: 'wx', mode: 0o600 },
    );
    return { prepared: true };
  });
  let observing = false;
  app.post('/observe', async (req) => {
    body(req.body);
    const hash = req.body.hash;
    assert.match(hash ?? '', /^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'INVALID_HASH');
    const s = await state();
    if (s.receipt) {
      assert.equal(s.receipt.transaction.hash, hash, 'ALREADY_CONFIRMED');
      return s.receipt;
    }
    assert.ok(s.pending && !observing, 'PENDING_SIGNATURE_REQUIRED');
    observing = true;
    try {
      await writeFile(
        stateDir + '/observed-hash.json',
        JSON.stringify({ hash, unverified: true }),
        { mode: 0o600 },
      );
      const tx = verifyActivationReceipt(
        await readTransaction(hash),
        hash,
        plan.transaction,
        INTENTS_FUNDING_FEE,
      );
      const before = (await optional(stateDir + '/attempt.json')).before;
      const after = await inspect();
      const block = await readBlock(tx.blockHash);
      assert.ok(
        BigInt(block.header.height) >= BigInt(before.block.height),
        'RECEIPT_PREDATES_ATTEMPT',
      );
      assert.ok(BigInt(block.header.height) <= BigInt(after.block.height), 'RECEIPT_NOT_FINAL');
      assert.equal(
        BigInt(after.brain) - BigInt(before.brain),
        FUND_PER_AGENT,
        'BRAIN_CREDIT_MISMATCH',
      );
      assert.equal(
        BigInt(after.hand) - BigInt(before.hand),
        FUND_PER_AGENT,
        'HAND_CREDIT_MISMATCH',
      );
      const result = {
        checkedAt: new Date().toISOString(),
        scope: plan.scope,
        transaction: tx,
        before,
        after,
        capitalYocto: plan.capitalYocto,
        externalRevenue: false,
        paidInferenceRequests: 0,
      };
      await writeFile(stateDir + '/receipt.json', JSON.stringify(result, null, 2), {
        flag: 'wx',
        mode: 0o600,
      });
      return result;
    } finally {
      observing = false;
    }
  });
  return app;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = await createIntentsFundingApp({
    client: await readFile('.data/mainnet-intents-fixture/client.js', 'utf8'),
  });
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(
    JSON.stringify({
      portal: 'http://localhost:' + PORT,
      ownerSignatureRequired: true,
      serverHoldsWalletKeys: false,
      totalFixtureCeilingNear: '0.03',
    }),
  );
}
