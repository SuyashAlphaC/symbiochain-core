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
const accountId = 'brain.symbio-fcef733893.near';
const dir = await mkdtemp(join(tmpdir(), 'symbio-intents-key-repair-browser-'));
const child = spawn(
  process.execPath,
  ['tools/mainnet-deploy/intents-key-repair-server.mjs', 'brain', '3432', dir],
  { stdio: 'ignore' },
);
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch('http://localhost:3432')).ok) {
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
  await page.goto('http://localhost:3432');
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
  assert.equal(t.receiverId, accountId);
  assert.equal(t.actions.length, 2);
  const original = JSON.parse(await readFile('artifacts/mainnet-bounded-plan.json'));
  const expected = original.intentsPublicKeys.brain;
  const bytes = Array.from(PublicKey.fromString(expected).ed25519Key.data);
  assert.deepEqual(t.actions[0].deleteKey.publicKey.ed25519Key.data, bytes);
  assert.deepEqual(t.actions[1].addKey.publicKey.ed25519Key.data, bytes);
  const scope = t.actions[1].addKey.accessKey.permission.functionCall;
  assert.equal(scope.receiverId, 'intents.near');
  assert.deepEqual(scope.methodNames, ['execute_intents']);
  assert.equal(scope.allowance.toString(), '40000000000000000000000');
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.includes('Wallet:'),
    undefined,
    { timeout: 15000 },
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'UNSIGNED_RESTRICTED_KEY_ALLOWANCE_REPAIR',
    signer: accountId,
    actions: 2,
    newGasAllowanceNear: '0.04',
    samePublicKey: true,
    sameReceiverAndMethods: true,
    noFullAccessGrant: true,
    actualMainnetTransactions: 0,
    paidInferenceRequests: 0,
    signatureDeliberatelyRejected: true,
  };
  await writeFile(
    'artifacts/mainnet-intents-key-repair-browser.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await b.close();
  child.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
