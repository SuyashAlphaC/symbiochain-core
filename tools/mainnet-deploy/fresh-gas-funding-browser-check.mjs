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
const accountId = 'solidvideo4090.near';
const dir = await mkdtemp(join(tmpdir(), 'symbio-intents-key-repair-browser-'));
const child = spawn(
  process.execPath,
  ['tools/mainnet-deploy/fresh-gas-funding-server.mjs', '3438', dir],
  { stdio: 'ignore' },
);
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch('http://localhost:3438')).ok) {
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
  await page.goto('http://localhost:3438');
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
  assert.equal(t.receiverId, 'wrap.near');
  assert.equal(t.actions.length, 3);
  assert.deepEqual(
    t.actions.map((a) => a.functionCall.methodName),
    ['near_deposit', 'ft_transfer_call', 'ft_transfer_call'],
  );
  assert.equal(t.actions[0].functionCall.deposit.toString(), '100000000000000000000000');
  for (let i = 1; i < 3; i++) {
    const f = t.actions[i].functionCall;
    assert.equal(f.deposit.toString(), '1');
    assert.equal(f.gas.toString(), '70000000000000');
    assert.deepEqual(JSON.parse(Buffer.from(f.args).toString()), {
      receiver_id: 'intents.near',
      amount: '50000000000000000000000',
      msg: ['brain', 'hand'][i - 1] + '.symbio-fcef733893.near',
    });
  }
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.includes('Wallet:'),
    undefined,
    { timeout: 15000 },
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'UNSIGNED_STATIC_AGENT_GAS_FUNDING',
    signer: accountId,
    actions: 3,
    capitalNear: '0.10',
    nativeDepositAccountsCreated: 0,
    priceQuotesCreatedBeforeWalletApproval: 0,
    noKeyGrant: true,
    signatureDeliberatelyRejected: true,
    mainnetTransactionsSubmitted: 0,
    paidInferenceRequests: 0,
  };
  await writeFile(
    'artifacts/mainnet-fresh-funding-browser.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await b.close();
  child.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
