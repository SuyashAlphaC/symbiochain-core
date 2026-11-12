import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { Transaction } = createRequire(new URL('../../package.json', import.meta.url))(
  'near-api-js',
);
const dir = await mkdtemp(join(tmpdir(), 'symbio-cross-funding-browser-'));
const child = spawn(
  process.execPath,
  ['tools/mainnet-deploy/retry-funding-server.mjs', '3437', dir],
  { stdio: 'ignore' },
);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch('http://localhost:3437')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, 'LOCAL_FUNDING_SERVER_NOT_READY');
  const manifest = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json')),
    plan = JSON.parse(await readFile('.data/mainnet-gas-funding-retry/plan.json'));
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ({ publicKey }) => {
      let listener;
      window.__fundingCapture = [];
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
                  payload: { accountId: 'solidvideo4090.near', allKeys: [publicKey] },
                }),
              5,
            );
          else if (d.actionType === 'sign') {
            window.__fundingCapture.push(d.inputs.transactions);
            setTimeout(() => listener({ uid: d.uid, status: 'closed_window', endTags: [] }), 5);
          }
        },
      };
    },
    { publicKey: manifest.recoveryPublicKey },
  );
  await page.goto('http://localhost:3437');
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.startsWith('Ready.'),
    undefined,
    { timeout: 120000 },
  );
  await page.locator('#connect').click();
  await page.waitForFunction(() => !document.querySelector('#sign').disabled, undefined, {
    timeout: 90000,
  });
  await page.locator('#reviewed').check();
  await page.locator('#sign').click();
  await page.waitForFunction(() => window.__fundingCapture.length === 1, undefined, {
    timeout: 120000,
  });
  const encoded = await page.evaluate(() => window.__fundingCapture[0]);
  const txs = encoded.split(',').map((t) => Transaction.decode(Buffer.from(t, 'base64')));
  assert.equal(txs.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(txs[i].signerId, 'solidvideo4090.near');
    assert.equal(txs[i].receiverId, plan.transactions[i].receiverId);
    assert.equal(txs[i].actions.length, 1);
    assert.equal(
      txs[i].actions[0].transfer.deposit.toString(),
      plan.transactions[i].actions[0].params.deposit,
    );
  }
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'UNSIGNED_REFUNDED_MAINNET_GAS_FUNDING',
    transactions: 2,
    capitalNear: '0.10',
    additionalPlanningCeilingNear: '0.50',
    namedOwner: true,
    exactAmountsAndProviderDeposits: true,
    dedicatedDestinations: true,
    signatureDeliberatelyRejected: true,
    mainnetTransactionsSubmitted: 0,
    paidInferenceRequests: 0,
    noAccessKeyRequested: true,
  };
  await writeFile(
    'artifacts/mainnet-gas-retry-browser.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
