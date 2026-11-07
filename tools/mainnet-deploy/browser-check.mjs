import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
const { Transaction } = createRequire(new URL('../../package.json', import.meta.url))(
  'near-api-js',
);
const plan = JSON.parse(await readFile('.data/mainnet-deployment-factory/plan.json', 'utf8'));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const diagnostics = { origins: [], rpc: [], failures: [], consoleErrors: [], transportTypes: [] };
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [],
    blockedRpc = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const u = new URL(request.url());
    if (!diagnostics.origins.includes(u.origin)) diagnostics.origins.push(u.origin);
    if (u.hostname.includes('near.org')) diagnostics.rpc.push(request.postDataJSON()?.method);
  });
  page.on('requestfailed', (request) =>
    diagnostics.failures.push({
      origin: new URL(request.url()).origin,
      error: request.failure()?.errorText,
    }),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      diagnostics.consoleErrors.push(message.text().substring(0, 350));
  });
  await page.route('https://free.rpc.fastnear.com/**', async (route) => {
    const method = route.request().postDataJSON()?.method;
    if (
      !['query', 'block', 'status', 'gas_price', 'EXPERIMENTAL_protocol_config'].includes(method)
    ) {
      blockedRpc.push(method);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.addInitScript(
    ({ owner, ownerPublicKey }) => {
      let listener;
      window.__capture = [];
      window.__logins = [];
      window.__types = [];
      window.meteorWallet = { isInstalled: true };
      window.meteorCom = {
        addMessageDataListener(fn) {
          listener = fn;
        },
        sendMessageData(data) {
          if (!data.inputs) return;
          window.__types.push(data.actionType);
          if (data.actionType === 'login') {
            window.__logins.push({
              contractId: data.inputs.contract_id,
              type: data.inputs.type,
              network: data.network,
            });
            setTimeout(
              () =>
                listener({
                  uid: data.uid,
                  status: 'closed_success',
                  payload: { accountId: owner, allKeys: [ownerPublicKey] },
                }),
              5,
            );
          } else if (data.actionType === 'sign') {
            window.__capture.push(data.inputs.transactions);
            setTimeout(() => listener({ uid: data.uid, status: 'closed_window', endTags: [] }), 5);
          }
        },
      };
    },
    { owner: plan.owner, ownerPublicKey: plan.ownerPublicKey },
  );
  await page.goto('http://localhost:3417');
  await page.waitForFunction(
    () => document.querySelector('#progress').textContent.includes('0/5'),
    undefined,
    { timeout: 60000 },
  );
  assert.match(await page.locator('#status').innerText(), /Ready for owner review/);
  assert.equal((await page.request.get('http://localhost:3417/plan')).status(), 401);
  assert.equal(
    (
      await page.request.get('http://localhost:3417/', {
        headers: { Origin: 'https://example.com' },
      })
    ).status(),
    403,
  );
  assert.equal((await page.request.get('http://localhost:3417/.env')).status(), 401);
  assert.equal((await page.request.get('http://localhost:3417/credentials.json')).status(), 401);
  await page.locator('#connect').click();
  await page.waitForFunction(
    () =>
      !document.querySelector('#deploy').disabled ||
      (!document.querySelector('#connect').disabled &&
        !document.querySelector('#status').textContent.includes('Ready for owner')),
    undefined,
    { timeout: 60000 },
  );
  assert.equal(
    await page.locator('#deploy').isEnabled(),
    true,
    `Connect failed: ${await page.locator('#status').innerText()}`,
  );
  await page.locator('#reviewed').check();
  await page.locator('#deploy').click();
  await page.waitForFunction(
    () =>
      window.__capture.length > 0 ||
      (!document.querySelector('#deploy').disabled &&
        document.querySelector('#status').textContent.includes('held')),
    undefined,
    { timeout: 60000 },
  );
  const captured = await page.evaluate(() => ({
    logins: window.__logins,
    transactions: window.__capture,
  }));
  await writeFile(
    '.data/mainnet-deployment-factory/unsigned-fixture.json',
    JSON.stringify(captured),
    {
      mode: 0o600,
    },
  );
  assert.equal(captured.logins[0].contractId, '');
  assert.equal(captured.logins[0].network, 'mainnet');
  assert.equal(
    captured.transactions.length,
    1,
    `Signing encoding failed: ${await page.locator('#status').innerText()}`,
  );
  const decoded = captured.transactions[0]
    .split(',')
    .map((bytes) => Transaction.decode(Buffer.from(bytes, 'base64')));
  assert.equal(decoded.length, 1);
  const tx = decoded[0];
  assert.equal(tx.signerId, plan.owner);
  assert.equal(tx.receiverId, 'near');
  assert.equal(tx.publicKey.toString(), plan.ownerPublicKey);
  assert.equal(tx.actions.length, 1);
  assert.ok('functionCall' in tx.actions[0]);
  assert.ok(!tx.actions.some((action) => action.addKey));
  const call = tx.actions[0].functionCall;
  assert.equal(call.methodName, 'create_account');
  assert.equal(String(call.deposit), '6380000000000000000000000');
  assert.equal(String(call.gas), '50000000000000');
  assert.deepEqual(JSON.parse(Buffer.from(call.args)), {
    new_account_id: plan.namespace,
    new_public_key: plan.deployerPublicKey,
  });
  assert.equal(await page.locator('#namespace').innerText(), plan.namespace);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRpc, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_FACTORY_FUNDING_TRANSPORT_FIXTURE',
    realWalletUsed: false,
    actualMainnetTransactions: 0,
    browserErrors: errors,
    protectedRoutes: true,
    foreignOriginBlocked: true,
    ownerConnectFixturePassed: true,
    transactionEncodingVerified: decoded.length,
    rootFullAccessGrants: 0,
    factoryMethod: 'near.create_account',
    separateWalletFundingYocto: plan.deploymentFundingYocto,
    signatureDeliberatelyRejected: true,
    rootPermissionRequestContract: '',
    mobileOverflow: false,
    wasmSha256: plan.wasmSha256,
    paidRequests: 0,
  };
  await writeFile(
    'artifacts/mainnet-factory-browser-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} catch (error) {
  diagnostics.transportTypes = await page?.evaluate(() => window.__types);
  console.log(
    JSON.stringify({
      status: await page?.locator('#status').innerText(),
      name: error.name,
      message: error.message,
      diagnostics,
    }),
  );
  throw error;
} finally {
  await browser.close();
}
