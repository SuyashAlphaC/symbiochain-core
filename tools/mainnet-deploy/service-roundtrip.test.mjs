import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, UNIT } from './plan.mjs';
import { TREASURY } from './funding-plan.mjs';
import {
  SERVICE_DEPOSIT,
  serviceTransaction,
  serviceDigest,
  verifyServiceReceipt,
} from './service-roundtrip-plan.mjs';
import { createServiceApp } from './service-roundtrip-server.mjs';

const credit = '1200000000000000000000';
function receipt(step, hash) {
  const p = serviceTransaction(step, credit).actions[0].params;
  const outcome = {
    outcome: { status: { SuccessValue: '' }, tokens_burnt: '100000000' },
    block_hash: 'block',
  };
  return {
    final_execution_status: 'FINAL',
    transaction: {
      hash,
      signer_id: ROOT,
      receiver_id: TREASURY,
      actions: [
        {
          FunctionCall: {
            method_name: p.methodName,
            args: Buffer.from(JSON.stringify(p.args)).toString('base64'),
            gas: p.gas,
            deposit: p.deposit,
          },
        },
      ],
    },
    status: { SuccessValue: step === 'withdraw' ? 'dHJ1ZQ==' : '' },
    transaction_outcome: structuredClone(outcome),
    receipts_outcome: [structuredClone(outcome)],
  };
}
test('service test permits only a fixed deposit and return of its bounded credit', () => {
  assert.equal(SERVICE_DEPOSIT.toString(), '2000000000000000000000');
  assert.equal(serviceTransaction('deposit').actions[0].params.methodName, 'fund_services');
  assert.equal(serviceTransaction('withdraw', credit).actions[0].params.deposit, '0');
  for (const v of ['0', '2000000000000000000001', '-1'])
    assert.throws(() => serviceTransaction('withdraw', v));
  assert.throws(() => serviceTransaction('unpause'));
});
test('service receipt requires final success, exact terms and a successful payout callback', () => {
  assert.equal(
    verifyServiceReceipt(receipt('withdraw', 'hash'), 'hash', 'withdraw', credit).withdrawalYocto,
    credit,
  );
  for (const change of [
    (t) => (t.transaction.signer_id = 'other.near'),
    (t) => (t.transaction.receiver_id = 'other.near'),
    (t) => t.transaction.actions.push({ AddKey: {} }),
    (t) => (t.transaction.actions[0].FunctionCall.method_name = 'set_paused'),
    (t) => (t.status.SuccessValue = 'ZmFsc2U='),
    (t) => (t.receipts_outcome[0].outcome.status = { Failure: {} }),
    (t) => (t.final_execution_status = 'EXECUTED'),
  ]) {
    const t = receipt('withdraw', 'hash');
    change(t);
    assert.throws(() => verifyServiceReceipt(t, 'hash', 'withdraw', credit));
  }
});
test('service portal verifies both steps once, refuses duplicate signatures and reconciles storage/fees', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'symbio-service-test-'));
  let current = '0',
    withdrawn = false,
    reads = 0;
  const app = await createServiceApp({
    stateDir,
    inspect: async () => ({
      block: { height: '100' },
      serviceBalanceYocto: current,
      serviceLiabilityYocto: current,
      gasPriceYocto: '100000000',
      ownerAvailableYocto: (withdrawn
        ? 2n * UNIT - (SERVICE_DEPOSIT - BigInt(credit)) - 400000000n
        : 2n * UNIT
      ).toString(),
    }),
    readBlock: async () => ({ header: { height: 100 } }),
    readTransaction: async (hash) => {
      reads++;
      const step = hash === '3'.repeat(44) ? 'deposit' : 'withdraw';
      current = step === 'deposit' ? credit : '0';
      withdrawn = step === 'withdraw';
      return receipt(step, hash);
    },
  });
  try {
    const host = { host: 'localhost:3419' };
    const html = (await app.inject({ url: '/', headers: host })).body;
    const token = html.match(/name="service-token" content="([a-f0-9]+)"/)[1];
    const headers = { ...host, 'x-service-token': token };
    assert.equal((await app.inject({ url: '/state', headers: host })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/state', headers: { ...headers, origin: 'https://example.com' } }))
        .statusCode,
      403,
    );
    for (const step of ['deposit', 'withdraw']) {
      const payload = { step, planDigest: serviceDigest(step, credit) };
      assert.equal(
        (await app.inject({ method: 'POST', url: '/begin', headers, payload })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/begin', headers, payload })).statusCode,
        409,
      );
      const observe = { step, hash: (step === 'deposit' ? '3' : '4').repeat(44) };
      const r = await app.inject({ method: 'POST', url: '/observe', headers, payload: observe });
      assert.equal(r.statusCode, 200);
      assert.equal(
        (await app.inject({ method: 'POST', url: '/observe', headers, payload: observe }))
          .statusCode,
        200,
      );
    }
    const s = (await app.inject({ url: '/state', headers })).json();
    assert.equal(s.phase, 'COMPLETE');
    assert.equal(s.complete.walletBalanceReconciled, true);
    assert.equal(s.complete.after.serviceBalanceYocto, '0');
    assert.equal(s.complete.storageCollateralYocto, '800000000000000000000');
    assert.equal(s.complete.totalFeeYocto, '400000000');
    assert.equal(reads, 2);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/begin',
          headers,
          payload: { step: 'deposit', planDigest: serviceDigest('deposit') },
        })
      ).statusCode,
      409,
    );
  } finally {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
