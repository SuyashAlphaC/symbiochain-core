import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createIntentsFundingApp } from './intents-funding-server.mjs';
import { intentsFundingPlan } from './intents-funding-plan.mjs';
const { Transaction } = createRequire(new URL('../../package.json', import.meta.url))(
  'near-api-js',
);
const m = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json'));
const plan = intentsFundingPlan();
const dir = await mkdtemp(join(tmpdir(), 'symbio-intents-funding-browser-'));
const app = await createIntentsFundingApp({
  stateDir: dir,
  client: await readFile('.data/mainnet-intents-fixture/client.js'),
  port: 3431,
});
await app.listen({ host: '127.0.0.1', port: 3431 });
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
    { publicKey: m.recoveryPublicKey, accountId: plan.signerId },
  );
  await page.goto('http://localhost:3431');
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
  assert.equal(t.signerId, plan.signerId);
  assert.equal(t.receiverId, 'wrap.near');
  assert.equal(t.actions.length, 4);
  for (let i = 0; i < 4; i++) {
    const c = t.actions[i].functionCall,
      p = plan.transaction.actions[i].params;
    assert.equal(c.methodName, p.methodName);
    assert.equal(c.gas.toString(), p.gas);
    assert.equal(c.deposit.toString(), p.deposit);
    assert.deepEqual(JSON.parse(Buffer.from(c.args).toString()), p.args);
  }
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.includes('Wallet:'),
    undefined,
    { timeout: 15000 },
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'UNSIGNED_INTENTS_FUNDING_BROWSER_FIXTURE',
    signer: t.signerId,
    receiver: t.receiverId,
    actions: 4,
    capitalNear: '0.002',
    storageCollateralCeilingNear: '0.00125',
    feePlanningCeilingNear: '0.017',
    signatureDeliberatelyRejected: true,
    actualMainnetTransactions: 0,
    paidInferenceRequests: 0,
    walletErrorRetained: true,
  };
  await writeFile(
    'artifacts/mainnet-intents-funding-browser-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await b.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
