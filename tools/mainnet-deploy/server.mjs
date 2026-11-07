import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, open, unlink } from 'node:fs/promises';
import { ROOT, STATE_DIR, prepare, inspect, planDigest, WASM_SHA256 } from './plan.mjs';

const { plan, wasm } = await prepare();
const digest = planDigest(plan);
const token = randomBytes(32).toString('hex');
const port = 3417;
const lockPath = `${STATE_DIR}/portal.lock`;
const lock = await open(lockPath, 'wx', 0o600).catch(() => {
  throw Error('ANOTHER_PORTAL_OR_STALE_LOCK_REQUIRES_REVIEW');
});
await lock.writeFile(String(process.pid));
const client = await readFile(`${STATE_DIR}/client.js`);
const app = Fastify({ logger: false, bodyLimit: 16000 });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="deployment-token" content="${token}"><title>SymbioChain mainnet owner deployment</title><style>body{font:16px system-ui;background:#111c22;color:#e7f0f3;max-width:860px;margin:32px auto;padding:0 20px}section{border:1px solid #50626a;border-radius:14px;padding:18px;margin:20px 0}button{padding:12px 18px;margin:8px 8px 8px 0;cursor:pointer}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:28px}p{line-height:1.6}.hold{color:#ffcc91}label{display:block;margin:16px 0}</style></head><body><h1>SymbioChain mainnet deployment</h1><p>Owner-signed infrastructure deployment. Your seed phrase and owner private key stay in Meteor.</p><section><h2>Review before signing</h2><p>Owner: <code id="owner"></code></p><p><strong>6.27 NEAR allocated:</strong> treasury 6.10; Brain, Hand and accountant 0.05 each; Scout 0.02. The treasury allocation mainly covers storage and stays locked while the code exists.</p><p><strong>Fee contingency: 0.13 NEAR. Planning ceiling: 6.40 NEAR.</strong> The portal checks the live network gas price and leaves at least 0.30 NEAR in the owner account. Actual network fees are determined by NEAR.</p><p class="hold">Treasury initializes and pauses in the same transaction, then disables all workers. Initial trade caps are one atomic unit. No trade, inference, cross-chain funding, mint or Intents settlement is requested.</p><pre id="accounts"></pre><p>WASM SHA-256: <code id="hash"></code></p></section><section><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I reviewed the account allocations, fee contingency and paused deployment.</label><button id="deploy" disabled>Sign deployment batch in Meteor</button><button id="refresh">Refresh on-chain state</button><p id="progress" aria-live="polite"></p><pre id="status" role="status">Checking mainnet state…</pre></section><script type="module" src="/client.js"></script></body></html>`;
app.addHook('onRequest', async (request, reply) => {
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host))
    return reply.code(403).send({ code: 'HOST_NOT_ALLOWED' });
  if (
    request.headers.origin &&
    ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)
  )
    return reply.code(403).send({ code: 'ORIGIN_NOT_ALLOWED' });
  if (!['/', '/client.js', '/wasm', '/favicon.ico'].includes(request.url.split('?')[0])) {
    const actual = String(request.headers['x-deployment-token'] ?? '');
    if (actual.length !== token.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(token)))
      return reply.code(401).send({ code: 'LOCAL_SESSION_REQUIRED' });
  }
});
app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://wallet.meteorwallet.app; connect-src 'self' https://free.rpc.fastnear.com https://*.meteorwallet.app; frame-src https://*.meteorwallet.app; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  return payload;
});
app.setErrorHandler((error, _request, reply) => {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'DEPLOYMENT_CHECK_FAILED';
  reply.code(409).send({ code });
});
app.get('/', async (_request, reply) => reply.type('text/html').send(html));
app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
app.get('/client.js', async (_request, reply) => reply.type('text/javascript').send(client));
app.get('/wasm', async (_request, reply) => reply.type('application/wasm').send(wasm));
app.get('/plan', async () => ({ ...plan, digest }));
async function state() {
  const result = await inspect(plan);
  await writeFile(`${STATE_DIR}/status.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}
app.get('/state', async () => state());
app.post('/preflight', async (request) => {
  if (request.body?.planDigest !== digest) throw Error('PLAN_DIGEST_CHANGED');
  const rehearsal = JSON.parse(
    await readFile('artifacts/mainnet-owner-deployment-rehearsal.json', 'utf8').catch(() => {
      throw Error('SANDBOX_REHEARSAL_REQUIRED');
    }),
  );
  if (
    rehearsal.wasmSha256 !== plan.wasmSha256 ||
    !rehearsal.initializedAndPausedInSameTransaction ||
    !rehearsal.runtimeKeyCannotUnpause ||
    !rehearsal.duplicateCreationCannotDoubleFund
  )
    throw Error('SANDBOX_REHEARSAL_REQUIRED');
  return state();
});
app.post('/observe', async (request) => {
  const hashes = request.body?.hashes;
  if (
    !Array.isArray(hashes) ||
    hashes.length > 5 ||
    hashes.some(
      (value) => typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value),
    )
  )
    throw Error('TRANSACTION_HASHES_INVALID');
  const previous = await readFile(`${STATE_DIR}/transaction-hashes.json`, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  await writeFile(
    `${STATE_DIR}/transaction-hashes.json`,
    JSON.stringify([...new Set([...previous, ...hashes])]),
    { mode: 0o600 },
  );
  return state();
});
await app.listen({ host: '127.0.0.1', port });
console.log(
  JSON.stringify({
    portal: `http://localhost:${port}`,
    owner: ROOT,
    plannedFundingNEAR: '6.27',
    feeContingencyNEAR: '0.13',
    plannedCeilingNEAR: '6.40',
    wasmSha256: WASM_SHA256,
    ownerSignatureRequired: true,
    serverCanSignOwnerTransactions: false,
  }),
);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await lock.close();
    await unlink(lockPath);
    process.exit(0);
  });
