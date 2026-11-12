import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { intentsFundingPlan } from './intents-funding-plan.mjs';
const { Transaction, PublicKey } = createRequire(new URL('../../package.json', import.meta.url))(
  'near-api-js',
);
const m = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json'));
const profile = process.argv[2];
assert.ok(['hand', 'policy'].includes(profile));
const accountId = profile === 'hand' ? 'hand.symbio-fcef733893.near' : 'symbio-fcef733893.near';
const dir = await mkdtemp(join(tmpdir(), 'symbio-intents-key-repair-browser-'));
const child = spawn(
  process.execPath,
  [
    'tools/mainnet-deploy/execution-readiness-server.mjs',
    profile,
    profile === 'hand' ? '3435' : '3436',
    dir,
  ],
  { stdio: 'ignore' },
);
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch('http://localhost:' + (profile === 'hand' ? '3435' : '3436'))).ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
assert.ok(ready, 'LOCAL_REPAIR_SERVER_NOT_READY');
const b = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await b.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://free.rpc.fastnear.com/**', async (route) => {
    const method = route.request().postDataJSON()?.method;
    if (!['query', 'block', 'status', 'gas_price', 'EXPERIMENTAL_protocol_config'].includes(method))
      await route.abort();
    else await route.continue();
  });
  await page.addInitScript(
    ({ publicKey, accountId }) => {
      let listener;
      window.__gasCapture = [];
      window.meteorWallet = { isInstalled: true };
      window.meteorCom = {
        addMessageDataListener(fn) {
          listener = fn;
        },
        sendMessageData(d) {
          if (!d.inputs) return;
          if (d.actionType === 'login')
            setTimeout(
              () =>
                listener({
                  uid: d.uid,
                  status: 'closed_success',
                  payload: { accountId, allKeys: [publicKey] },
                }),
              5,
            );
          else if (d.actionType === 'sign') {
            window.__gasCapture.push(d.inputs.transactions);
            setTimeout(() => listener({ uid: d.uid, status: 'closed_window', endTags: [] }), 5);
          }
        },
      };
    },
    { publicKey: m.recoveryPublicKey, accountId },
  );
  await page.goto('http://localhost:' + (profile === 'hand' ? '3435' : '3436'));
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.startsWith('Ready.'),
    undefined,
    { timeout: 90000 },
  );
  await page.locator('#connect').click();
  await page.waitForFunction(() => !document.querySelector('#sign').disabled, undefined, {
    timeout: 60000,
  });
  await page.locator('#reviewed').check();
  await page.locator('#sign').click();
  await page.waitForFunction(() => window.__gasCapture.length === 1, undefined, { timeout: 90000 });
  const captured = await page.evaluate(() => window.__gasCapture[0]);
  const txs = captured.split(',').map((t) => Transaction.decode(Buffer.from(t, 'base64')));
  assert.equal(txs.length, 1);
  const t = txs[0];
  assert.equal(t.signerId, accountId);
  if (profile === 'hand') {
    assert.equal(t.receiverId, accountId);
    assert.equal(t.actions.length, 2);
    const expected = 'ed25519:B5QXGjwnTzEKotw6pk2BRoTS3q6SbnW6mViWY3Kxg3cN';
    const bytes = Array.from(PublicKey.fromString(expected).ed25519Key.data);
    assert.deepEqual(t.actions[0].deleteKey.publicKey.ed25519Key.data, bytes);
    assert.deepEqual(t.actions[1].addKey.publicKey.ed25519Key.data, bytes);
    const f = t.actions[1].addKey.accessKey.permission.functionCall;
    assert.equal(f.receiverId, 'treasury.symbio-fcef733893.near');
    assert.deepEqual(f.methodNames, [
      'request_evm_signature',
      'request_solana_signature',
      'record_submission',
    ]);
    assert.equal(f.allowance.toString(), '300000000000000000000000');
  } else {
    assert.equal(t.receiverId, 'treasury.symbio-fcef733893.near');
    assert.equal(t.actions.length, 1);
    const f = t.actions[0].functionCall;
    assert.equal(f.methodName, 'set_policy');
    assert.equal(f.deposit.toString(), '0');
    assert.equal(f.gas.toString(), '20000000000000');
    const p = JSON.parse(Buffer.from(f.args).toString()).policy;
    assert.equal(p.max_trade_atoms, '250000');
    assert.equal(p.max_daily_atoms, '500000');
    assert.deepEqual(p.allowed_chain_ids, [8453, 0]);
    assert.deepEqual(p.token_max_trade_atoms, ['250000', '4000000']);
    assert.deepEqual(p.token_max_daily_atoms, ['500000', '8000000']);
    assert.equal(p.min_reserve_yocto, '100000000000000000000000');
    assert.equal(p.max_signing_cost_yocto, '1');
    assert.equal(p.max_slippage_bps, 0);
  }
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.includes('Wallet:'),
    undefined,
    { timeout: 15000 },
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'UNSIGNED_MAINNET_EXECUTION_READINESS',
    profile,
    signer: accountId,
    exactActionsVerified: true,
    fullAccessGrant: false,
    transfers: 0,
    paidInferenceRequests: 0,
    mainnetTransactionsSubmitted: 0,
    signatureDeliberatelyRejected: true,
  };
  await writeFile(
    'artifacts/mainnet-readiness-' + profile + '-browser.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await b.close();
  child.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
