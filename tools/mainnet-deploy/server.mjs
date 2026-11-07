import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, open, unlink } from 'node:fs/promises';
import { ROOT, planDigest, WASM_SHA256 } from './plan.mjs';
import {
  FACTORY_STATE_DIR as STATE_DIR,
  prepareFactory,
  inspectFactory,
  runFundedDeployment,
} from './factory-plan.mjs';

const { plan, wasm, credentials } = await prepareFactory();
const digest = planDigest(plan);
const token = randomBytes(32).toString('hex');
const port = 3417;
const lockPath = `${STATE_DIR}/portal.lock`;
const lock = await open(lockPath, 'wx', 0o600).catch(() => {
  throw Error('ANOTHER_PORTAL_OR_STALE_LOCK_REQUIRES_REVIEW');
});
await lock.writeFile(String(process.pid));
const client = await readFile('.data/mainnet-deployment/client.js');
const app = Fastify({ logger: false, bodyLimit: 16000 });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="deployment-token" content="${token}"><title>SymbioChain mainnet deployment wallet</title><style>body{font:16px system-ui;background:#111c22;color:#e7f0f3;max-width:860px;margin:32px auto;padding:0 20px}section{border:1px solid #50626a;border-radius:14px;padding:18px;margin:20px 0}button{padding:12px 18px;margin:8px 8px 8px 0;cursor:pointer}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}h1{font-size:28px}p{line-height:1.6}.hold{color:#ffcc91}label{display:block;margin:16px 0}</style></head><body><h1>SymbioChain mainnet deployment</h1><p>Your owner private key and seed stay in Meteor. This revised flow creates a separate, funded deployment wallet through NEAR's standard account factory.</p><section><h2>Review funding and custody</h2><p>Meteor owner: <code id="owner"></code></p><p>Separate deployment wallet: <strong><code id="namespace"></code></strong></p><p><strong>One wallet transaction: 6.38 NEAR to the official <code>near.create_account</code> factory.</strong> This creates and funds the deployment wallet shown above. A temporary key stored only on this computer controls that separate wallet until deployment completes. No key is added to your original Meteor account.</p><p>The deployment wallet is the treasury owner account. After setup, your existing Meteor recovery key controls it; the temporary local key is revoked.</p><p>The local tool installs your Meteor recovery public key, creates the paused treasury and four agent accounts, refunds excess funds to your Meteor account, then revokes the temporary deployment key. Your Meteor recovery key remains the only full-access key on the deployment wallet and each child account.</p><p><strong>Infrastructure: 6.27 NEAR.</strong> Treasury 6.10; Brain, Hand and accountant 0.05 each; Scout 0.02. Remaining deployment-wallet funds cover fees, parent storage and a recovery balance. The owner-side fee contingency is 0.02 NEAR, for a <strong>6.40 NEAR planning ceiling</strong>. Actual network fees are set by NEAR.</p><p class="hold">The deployed treasury stays PAUSED and all workers disabled. Trading, paid inference, Intents settlement and NFT minting stay off.</p><pre id="accounts"></pre><p>WASM SHA-256: <code id="hash"></code></p></section><section><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I authorize the separate deployment wallet to receive 6.38 NEAR and its temporary local key to deploy the reviewed paused infrastructure, refund excess funds and revoke itself.</label><button id="deploy" disabled>Create deployment wallet in Meteor</button><button id="refresh">Refresh on-chain state</button><p id="progress" aria-live="polite"></p><pre id="status" role="status">Checking mainnet state…</pre></section><script type="module" src="/client.js"></script></body></html>`;
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
  const result = await inspectFactory(plan);
  await writeFile(`${STATE_DIR}/status.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}
app.get('/state', async () => state());
async function checkRehearsal(request) {
  if (request.body?.planDigest !== digest) throw Error('PLAN_DIGEST_CHANGED');
  const rehearsal = JSON.parse(
    await readFile('artifacts/mainnet-factory-deployment-rehearsal.json', 'utf8').catch(() => {
      throw Error('SANDBOX_REHEARSAL_REQUIRED');
    }),
  );
  if (
    rehearsal.wasmSha256 !== plan.wasmSha256 ||
    !rehearsal.rootOwnerKeysUnchanged ||
    !rehearsal.temporaryKeyRevoked ||
    !rehearsal.duplicateRunSubmitsZeroTransactions ||
    !rehearsal.paused
  )
    throw Error('SANDBOX_REHEARSAL_REQUIRED');
}
app.post('/preflight', async (request) => {
  await checkRehearsal(request);
  return state();
});
let deploymentInProgress = false;
app.post('/deploy-funded', async (request) => {
  await checkRehearsal(request);
  if (deploymentInProgress) throw Error('DEPLOYMENT_ALREADY_RUNNING');
  deploymentInProgress = true;
  try {
    const current = await state();
    if (current.fullyDeployed) return current;
    if (current.fundingRequired) throw Error('DEPLOYMENT_WALLET_NOT_FUNDED');
    await runFundedDeployment(plan, credentials, wasm, { beforeStep: state });
    return await state();
  } finally {
    deploymentInProgress = false;
  }
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
    deploymentWalletFundingNEAR: '6.38',
    rootFeeContingencyNEAR: '0.02',
    plannedCeilingNEAR: '6.40',
    wasmSha256: WASM_SHA256,
    ownerSignatureRequired: true,
    serverCanSignOwnerTransactions: false,
    serverCanSignFundedDeploymentWallet: true,
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
