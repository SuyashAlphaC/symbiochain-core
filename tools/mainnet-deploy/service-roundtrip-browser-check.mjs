import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { Transaction } = createRequire(new URL('../../package.json', import.meta.url))(
  'near-api-js',
);
const manifest = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json', 'utf8'));
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [],
    blocked = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://free.rpc.fastnear.com/**', async (route) => {
    const method = route.request().postDataJSON()?.method;
    if (
      !['query', 'block', 'status', 'gas_price', 'EXPERIMENTAL_protocol_config'].includes(method)
    ) {
      blocked.push(method);
      await route.abort();
    } else await route.continue();
  });
  await page.addInitScript(
    ({ publicKey }) => {
      let listener;
      window.__fundingCapture = [];
      window.__fundingLogins = [];
      window.meteorWallet = { isInstalled: true };
      window.meteorCom = {
        addMessageDataListener(fn) {
          listener = fn;
        },
        sendMessageData(data) {
          if (!data.inputs) return;
          if (data.actionType === 'login') {
            window.__fundingLogins.push({
              contractId: data.inputs.contract_id,
              network: data.network,
            });
            setTimeout(
              () =>
                listener({
                  uid: data.uid,
                  status: 'closed_success',
                  payload: { accountId: 'solidvideo4090.near', allKeys: [publicKey] },
                }),
              5,
            );
          } else if (data.actionType === 'sign') {
            window.__fundingCapture.push(data.inputs.transactions);
            setTimeout(() => listener({ uid: data.uid, status: 'closed_window', endTags: [] }), 5);
          }
        },
      };
    },
    { publicKey: manifest.recoveryPublicKey },
  );
  await page.goto('http://localhost:3419');
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.startsWith('Ready.'),
    undefined,
    { timeout: 90000 },
  );
  assert.equal((await page.request.get('http://localhost:3419/state')).status(), 401);
  assert.equal(
    (
      await page.request.get('http://localhost:3419/', {
        headers: { origin: 'https://example.com' },
      })
    ).status(),
    403,
  );
  assert.equal((await page.request.get('http://localhost:3419/.env')).status(), 401);
  await page.locator('#connect').click();
  await page.waitForFunction(() => !document.querySelector('#send').disabled, undefined, {
    timeout: 60000,
  });
  await page.locator('#reviewed').check();
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__fundingCapture.length > 0, undefined, {
    timeout: 90000,
  });
  const captured = await page.evaluate(() => ({
    transactions: window.__fundingCapture,
    logins: window.__fundingLogins,
  }));
  assert.equal(captured.logins[0].contractId, '');
  assert.equal(captured.logins[0].network, 'mainnet');
  assert.equal(captured.transactions.length, 1);
  const decoded = captured.transactions[0]
    .split(',')
    .map((v) => Transaction.decode(Buffer.from(v, 'base64')));
  assert.equal(decoded.length, 1);
  const tx = decoded[0];
  assert.equal(tx.signerId, 'solidvideo4090.near');
  assert.equal(tx.receiverId, manifest.treasury);
  assert.equal(tx.actions.length, 1);
  const call = tx.actions[0].functionCall;
  assert.equal(call.methodName, 'fund_services');
  assert.equal(String(call.deposit), '2000000000000000000000');
  assert.equal(String(call.gas), '10000000000000');
  assert.deepEqual(JSON.parse(Buffer.from(call.args)), {});
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.includes('DEPOSIT_PENDING'),
    undefined,
    { timeout: 30000 },
  );
  assert.equal(await page.locator('#send').isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_UNSIGNED_SERVICE_BALANCE_DEPOSIT_FIXTURE',
    realWalletUsed: false,
    ownerSignInWithoutKeyGrant: true,
    transactionsEncoded: 1,
    method: 'fund_services',
    depositYocto: '2000000000000000000000',
    gas: '10000000000000',
    extraActions: 0,
    unpauseRequested: false,
    keyGrants: 0,
    signatureDeliberatelyRejected: true,
    pendingAttemptPreventsSecondSend: true,
    foreignOriginRejected: true,
    protectedRoutes: true,
    pageErrors: 0,
    mobileOverflow: false,
    actualMainnetTransactions: 0,
    paidInferenceRequests: 0,
  };
  await writeFile(
    'artifacts/mainnet-service-browser-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
