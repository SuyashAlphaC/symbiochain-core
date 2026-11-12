import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROWS, fundingTerms, makeCrossFundingPlan } from './cross-funding-plan.mjs';
import { createCrossFundingApp } from './cross-funding-server.mjs';
import { verifyActivationReceipt } from './activation-plan.mjs';
const quote = (row, i) => ({
  quoteRequest: {
    ...fundingTerms(row, new Date(Date.now() + 1200000).toISOString()),
    dry: false,
    depositType: 'ORIGIN_CHAIN',
    recipientType: 'DESTINATION_CHAIN',
    slippageTolerance: 0,
  },
  quote: {
    depositAddress: String(i + 1).repeat(64),
    amountIn: row.near.toString(),
    minAmountOut: row.minimum,
    deadline: new Date(Date.now() + 1200000).toISOString(),
  },
});
const plan = makeCrossFundingPlan(ROWS.map(quote));
const receipt = (t, i) => ({
  final_execution_status: 'FINAL',
  status: { SuccessValue: '' },
  transaction: {
    hash: String.fromCharCode(65 + i).repeat(43),
    signer_id: t.signerId,
    receiver_id: t.receiverId,
    actions: [{ Transfer: { deposit: t.actions[0].params.deposit } }],
  },
  transaction_outcome: {
    block_hash: 'block-' + i,
    outcome: { tokens_burnt: '100', status: { SuccessValue: '' } },
  },
  receipts_outcome: [{ outcome: { tokens_burnt: '100', status: { SuccessValue: '' } } }],
});
test('funding plan binds all owned recipients, amounts, reserve and output floors', () => {
  assert.equal(plan.capitalYocto, '450000000000000000000000');
  assert.equal(plan.totalPlanningCeilingYocto, '500000000000000000000000');
  for (const change of [
    (q) => (q[0].quoteRequest.refundTo = 'attacker.near'),
    (q) => (q[1].quote.minAmountOut = '1'),
    (q) => (q[2].quote.depositAddress = 'attacker.near'),
    (q) => (q[0].quoteRequest.recipient = '0xattacker'),
    (q) => (q[2].quote.deadline = new Date().toISOString()),
  ]) {
    const q = ROWS.map(quote);
    change(q);
    assert.throws(() => makeCrossFundingPlan(q));
  }
  const r = receipt(plan.transactions[0], 0);
  assert.equal(
    verifyActivationReceipt(r, r.transaction.hash, plan.transactions[0]).succeeded,
    true,
  );
  r.transaction.actions[0].Transfer.deposit = '1';
  assert.throws(() => verifyActivationReceipt(r, r.transaction.hash, plan.transactions[0]));
});
test('funding portal holds partial signatures and requires final destination reconciliation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'symbio-cross-funding-'));
  let after = false,
    settled = false;
  const raw = plan.transactions.map(receipt);
  const inspect = async () => ({
    block: { height: after ? '120' : '100' },
    ownerAvailableYocto: '2000000000000000000000000',
    ownerBalanceYocto: after ? '1549999999999999999999200' : '2000000000000000000000000',
    handBalanceYocto: after ? '300000000000000000000000' : '50000000000000000000000',
  });
  const app = await createCrossFundingApp({
    plan,
    stateDir: dir,
    inspect,
    readTransaction: async (hash) => raw.find((r) => r.transaction.hash === hash),
    readBlock: async () => ({ header: { height: 110 } }),
    settlement: async () => {
      assert.ok(settled, 'DESTINATION_PENDING');
      return [{ verified: true }];
    },
  });
  try {
    const host = { host: 'localhost:3424' },
      html = (await app.inject({ url: '/', headers: host })).body;
    const token = /name="fixture-token" content="([a-f0-9]+)"/.exec(html)[1],
      headers = { ...host, 'x-fixture-token': token };
    assert.equal((await app.inject({ url: '/state', headers: host })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/state', headers: { ...headers, origin: 'https://evil.invalid' } }))
        .statusCode,
      403,
    );
    const payload = { planDigest: plan.digest };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/begin', headers, payload })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/begin', headers, payload })).statusCode,
      409,
    );
    for (let i = 0; i < 4; i++) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/observe',
            headers,
            payload: { ...payload, index: i, hash: raw[i].transaction.hash },
          })
        ).statusCode,
        200,
      );
      if (i === 0)
        assert.equal(
          (await app.inject({ method: 'POST', url: '/reconcile', headers, payload })).statusCode,
          409,
        );
    }
    after = true;
    assert.equal(
      (await app.inject({ method: 'POST', url: '/reconcile', headers, payload })).statusCode,
      409,
    );
    assert.equal((await app.inject({ url: '/state', headers })).json().complete, null);
    settled = true;
    const done = await app.inject({ method: 'POST', url: '/reconcile', headers, payload });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().externalRevenueProven, false);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/reconcile', headers, payload })).json()
        .fundingReceipts.length,
      4,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
