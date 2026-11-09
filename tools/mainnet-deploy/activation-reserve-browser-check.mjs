import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createActivationApp } from './activation-server.mjs';
const { Transaction } = createRequire(new URL('../../package.json', import.meta.url))(
  'near-api-js',
);
const m = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json'));
const plan = JSON.parse(await readFile('artifacts/mainnet-bounded-plan.json'));
const dir = await mkdtemp(join(tmpdir(), 'symbio-owner-gas-browser-'));
for (const t of plan.transactions.slice(0, 4))
  await copyFile('.data/mainnet-activation/operation/' + t.id + '.json', join(dir, t.id + '.json'));
const app = await createActivationApp({
  plan,
  stateDir: dir,
  client: await readFile('.data/mainnet-activation/client.js'),
  port: 3430,
});
await app.listen({ host: '127.0.0.1', port: 3430 });
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
    { publicKey: m.recoveryPublicKey, accountId: plan.owner },
  );
  await page.goto('http://localhost:3430');
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
  assert.equal(t.signerId, plan.owner);
  assert.equal(t.receiverId, plan.treasury);
  assert.equal(t.actions.length, 1);
  const c = t.actions[0].functionCall;
  assert.equal(c.methodName, 'withdraw_funds');
  assert.equal(c.gas.toString(), '5000000000000');
  assert.equal(c.deposit.toString(), '0');
  assert.deepEqual(JSON.parse(Buffer.from(c.args).toString()), {
    amount: '20000000000000000000000',
  });
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.includes('Wallet result:'),
    undefined,
    { timeout: 15000 },
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'UNSIGNED_OWNER_GAS_RESERVE_BROWSER_FIXTURE',
    signer: t.signerId,
    receiver: t.receiverId,
    method: c.methodName,
    reserveReallocationYocto: '20000000000000000000000',
    attachedGas: '5000000000000',
    attachedDepositYocto: '0',
    signatureDeliberatelyRejected: true,
    actualMainnetTransactions: 0,
    paidInferenceRequests: 0,
    walletErrorRetained: true,
  };
  await writeFile(
    'artifacts/mainnet-activation-reserve-browser-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await b.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
