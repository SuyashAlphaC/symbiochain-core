import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fundingPlan,
  validatePreflight,
  verifyFundingReceipt,
  DEPOSIT,
  GAS,
  TREASURY,
} from './funding-plan.mjs';
const hash = 'test-transaction-identity';
const outcome = (executor_id, logs = []) => ({
  block_hash: 'recorded-block',
  outcome: { executor_id, logs, tokens_burnt: '100000000', status: { SuccessValue: '' } },
});

test('local portal blocks cross-origin calls and duplicate attempts, then verifies idempotently', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createFundingApp } = await import('./funding-server.mjs');
  const stateDir = await mkdtemp(join(tmpdir(), 'symbio-funding-test-'));
  let reads = 0;
  const app = await createFundingApp({
    stateDir,
    inspect: async () => ({ block: { height: '100' } }),
    readTransaction: async (h) => {
      reads++;
      const t = receipt();
      t.transaction.hash = h;
      return t;
    },
    readBlock: async () => ({ header: { height: 100 } }),
  });
  try {
    const host = { host: 'localhost:3418' };
    const html = await app.inject({ url: '/', headers: host });
    const token = html.body.match(/name="funding-token" content="([a-f0-9]+)"/)[1];
    const headers = { ...host, 'x-funding-token': token };
    assert.equal((await app.inject({ url: '/state', headers: host })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/state', headers: { ...headers, origin: 'https://example.com' } }))
        .statusCode,
      403,
    );
    const plan = (await app.inject({ url: '/plan', headers })).json();
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/begin',
          headers,
          payload: { planDigest: 'changed' },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/begin',
          headers,
          payload: { planDigest: plan.digest },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/begin',
          headers,
          payload: { planDigest: plan.digest },
        })
      ).statusCode,
      409,
    );
    const payload = { hash: '3'.repeat(44) };
    const first = await app.inject({ method: 'POST', url: '/observe', headers, payload });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().customerRevenueProven, false);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/observe', headers, payload })).statusCode,
      200,
    );
    assert.equal(reads, 1);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/begin',
          headers,
          payload: { planDigest: plan.digest },
        })
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
function receipt() {
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: {
      hash,
      signer_id: 'solidvideo4090.near',
      receiver_id: TREASURY,
      actions: [
        {
          FunctionCall: {
            method_name: 'fund',
            args: 'e30=',
            gas: GAS.toString(),
            deposit: DEPOSIT.toString(),
          },
        },
      ],
    },
    transaction_outcome: outcome('solidvideo4090.near'),
    receipts_outcome: [
      outcome(TREASURY, [
        'EVENT_JSON:' +
          JSON.stringify({
            standard: 'symbiochain',
            event: 'funded',
            data: [{ amount: DEPOSIT.toString() }],
          }),
      ]),
    ],
  };
}
function preflight() {
  return {
    runtime: { mode: 'LIVE', network: 'mainnet', executionEnabled: false },
    snapshot: {
      treasuryAccount: TREASURY,
      paused: true,
      code: { matches: true },
      deployment: { temporaryKeyRevoked: true },
      accounts: [
        { role: 'TREASURY', balanceYocto: '6100000000000000000000000', workerEnabled: null },
        ...['BRAIN', 'HAND', 'ACCOUNTANT'].map((role) => ({ role, workerEnabled: false })),
      ],
      block: { height: '123' },
    },
    wallet: { accountId: 'solidvideo4090.near', availableYocto: '1000000000000000000000000' },
    gasPrice: '100000000',
  };
}
test('funding plan contains only one fixed native funding call and no key grant or unpause', () => {
  assert.equal(fundingPlan.transaction.actions.length, 1);
  assert.equal(fundingPlan.transaction.actions[0].params.methodName, 'fund');
  assert.equal(fundingPlan.planningCeilingYocto, '4000000000000000000000');
  assert.equal(validatePreflight(preflight()).estimatedFeeYocto, '2600000000000000000000');
});
test('preflight refuses changed custody, enabled execution, unpaused treasury and excessive fees', () => {
  for (const change of [
    (p) => (p.runtime.executionEnabled = true),
    (p) => (p.snapshot.paused = false),
    (p) => (p.snapshot.code.matches = false),
    (p) => (p.snapshot.accounts[1].workerEnabled = true),
    (p) => (p.snapshot.deployment.temporaryKeyRevoked = false),
    (p) => (p.wallet.accountId = 'other.near'),
    (p) => (p.gasPrice = '99999999999'),
    (p) => (p.wallet.availableYocto = '1'),
  ]) {
    const p = preflight();
    change(p);
    assert.throws(() => validatePreflight(p));
  }
});
test('independent receipt verification binds amount, actions, signer, method, finality and event', () => {
  assert.equal(
    verifyFundingReceipt(receipt(), hash).classification,
    'TEAM_FUNDED_TREASURY_CAPITAL_NOT_REVENUE',
  );
  for (const change of [
    (t) => (t.transaction.signer_id = 'other.near'),
    (t) => (t.transaction.receiver_id = 'other.near'),
    (t) => t.transaction.actions.push({ Transfer: { deposit: '1' } }),
    (t) => (t.transaction.actions[0].FunctionCall.method_name = 'set_paused'),
    (t) => (t.transaction.actions[0].FunctionCall.deposit = '1'),
    (t) => (t.transaction.actions[0].FunctionCall.gas = '1'),
    (t) => (t.final_execution_status = 'EXECUTED'),
    (t) => (t.receipts_outcome[0].outcome.status = { Failure: {} }),
    (t) => (t.receipts_outcome[0].outcome.logs = []),
  ]) {
    const t = receipt();
    change(t);
    assert.throws(() => verifyFundingReceipt(t, hash));
  }
});
