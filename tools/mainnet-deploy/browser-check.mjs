import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { chromium } from 'playwright-core';
const { Transaction } = createRequire(new URL('../../package.json', import.meta.url))(
  'near-api-js',
);
const plan = JSON.parse(await readFile('.data/mainnet-deployment/plan.json', 'utf8'));
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
  await writeFile('.data/mainnet-deployment/unsigned-fixture.json', JSON.stringify(captured), {
    mode: 0o600,
  });
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
  assert.equal(decoded.length, 5);
  for (const [index, tx] of decoded.entries()) {
    assert.equal(tx.signerId, plan.owner);
    assert.equal(tx.receiverId, plan.groups[index].receiverId);
    assert.equal(tx.publicKey.toString(), plan.ownerPublicKey);
    assert.ok('createAccount' in tx.actions[0]);
    assert.equal(tx.actions[1].transfer.deposit.toString(), plan.groups[index].fundingYocto);
    assert.equal(tx.actions.length, plan.groups[index].actions.length);
    if (index) assert.equal(tx.nonce, decoded[index - 1].nonce + 1n);
    const grants = tx.actions.filter((action) => action.addKey).map((action) => action.addKey);
    const wantedGrants = plan.groups[index].actions
      .filter((action) => action.type === 'AddKey')
      .map((action) => action.params);
    for (const [n, grant] of grants.entries()) {
      assert.equal(
        `ed25519:${bs58.encode(grant.publicKey.ed25519Key.data)}`,
        wantedGrants[n].publicKey,
      );
      const wanted = wantedGrants[n].accessKey.permission;
      if (wanted === 'FullAccess') assert.ok('fullAccess' in grant.accessKey.permission);
      else {
        assert.equal(grant.accessKey.permission.functionCall.receiverId, wanted.receiverId);
        assert.deepEqual(grant.accessKey.permission.functionCall.methodNames, wanted.methodNames);
        assert.equal(String(grant.accessKey.permission.functionCall.allowance), wanted.allowance);
      }
    }
    if (plan.groups[index].role === 'treasury') {
      const code = tx.actions.find((action) => action.deployContract).deployContract.code;
      assert.equal(createHash('sha256').update(Buffer.from(code)).digest('hex'), plan.wasmSha256);
      const calls = tx.actions
        .filter((action) => action.functionCall)
        .map((action) => action.functionCall);
      const wanted = plan.groups[index].actions
        .filter((action) => action.type === 'FunctionCall')
        .map((action) => action.params);
      for (const [n, call] of calls.entries()) {
        assert.equal(call.methodName, wanted[n].methodName);
        assert.deepEqual(JSON.parse(Buffer.from(call.args)), wanted[n].args);
        assert.equal(String(call.gas), wanted[n].gas);
        assert.equal(String(call.deposit), wanted[n].deposit);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRpc, []);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_METEOR_TRANSPORT_FIXTURE',
    realWalletUsed: false,
    actualMainnetTransactions: 0,
    browserErrors: errors,
    protectedRoutes: true,
    foreignOriginBlocked: true,
    ownerConnectFixturePassed: true,
    transactionEncodingVerified: decoded.length,
    signatureDeliberatelyRejected: true,
    rootPermissionRequestContract: '',
    mobileOverflow: false,
    wasmSha256: plan.wasmSha256,
    paidRequests: 0,
  };
  await writeFile(
    'artifacts/mainnet-owner-browser-verification.json',
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
