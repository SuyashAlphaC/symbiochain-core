import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRoleKey } from './plan.mjs';
import {
  makeActivationPlan,
  verifyActivationReceipt,
  OWNER,
  TREASURY,
} from './activation-plan.mjs';
import { createActivationApp } from './activation-server.mjs';
const keys = { brain: generateRoleKey().publicKey, hand: generateRoleKey().publicKey };
const plan = makeActivationPlan(keys);
function receipt(t, i) {
  const hash = String.fromCharCode(65 + i).repeat(43);
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: {
      hash,
      signer_id: t.signerId,
      receiver_id: t.receiverId,
      actions: t.actions.map((a) =>
        a.type === 'FunctionCall'
          ? {
              FunctionCall: {
                method_name: a.params.methodName,
                args: Buffer.from(JSON.stringify(a.params.args)).toString('base64'),
                gas: a.params.gas,
                deposit: a.params.deposit,
              },
            }
          : {
              AddKey: {
                public_key: a.params.publicKey,
                access_key: {
                  nonce: 0,
                  permission: {
                    FunctionCall: {
                      receiver_id: 'intents.near',
                      method_names: ['execute_intents'],
                      allowance: '5000000000000000000000',
                    },
                  },
                },
              },
            },
      ),
    },
    transaction_outcome: {
      block_hash: 'block-' + i,
      outcome: { status: { SuccessReceiptId: 'receipt' }, tokens_burnt: '1000' },
    },
    receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, tokens_burnt: '1000' } }],
  };
}
export function fixture() {
  let executed = 0,
    reads = 0;
  const transactions = plan.transactions.map(receipt);
  return {
    plan,
    transactions,
    get reads() {
      return reads;
    },
    inspect: async () => ({
      checkedAt: new Date().toISOString(),
      snapshot: {
        block: { height: String(100 + executed * 10) },
        paused: executed < 6,
        accounts: [
          OWNER,
          TREASURY,
          'brain.' + OWNER,
          'hand.' + OWNER,
          'books.' + OWNER,
          'scout.' + OWNER,
        ].map((accountId, i) => ({
          accountId,
          availableYocto: i === 1 ? '300000000000000000000000' : '50000000000000000000000',
          balanceYocto:
            i === 0 && executed >= 5 ? '70000000000000000000000' : '50000000000000000000000',
          storageYocto: '0',
          workerEnabled: [2, 3, 4].includes(i) ? executed >= 6 : null,
        })),
      },
      keys: {
        brain: { installed: executed >= 1, registered: executed >= 2 },
        hand: { installed: executed >= 3, registered: executed >= 4 },
      },
      policy: executed >= 6 ? plan.policy : {},
      gasPriceYocto: '100000000',
    }),
    readTransaction: async (hash) => {
      reads++;
      const i = transactions.findIndex((t) => t.transaction.hash === hash);
      assert.ok(i >= 0);
      executed = i + 1;
      return transactions[i];
    },
    readBlock: async (hash) => ({ header: { height: 109 + 10 * Number(hash.split('-')[1]) } }),
  };
}
test('activation binds the deployed namespace, USDC limits, restricted keys and zero treasury top-up', () => {
  assert.equal(plan.owner, OWNER);
  assert.equal(plan.treasury, TREASURY);
  assert.equal(plan.newTreasuryCapitalYocto, '0');
  assert.equal(plan.policy.max_trade_atoms, '50000');
  assert.equal(plan.policy.max_daily_atoms, '100000');
  assert.equal(plan.transactions.length, 7);
  assert.ok(!JSON.stringify(plan).includes('secretKey'));
  assert.deepEqual(
    plan.transactions[5].actions.map((a) => a.params.methodName),
    ['set_policy', 'set_worker_enabled', 'set_worker_enabled', 'set_worker_enabled', 'set_paused'],
  );
  assert.equal(plan.transactions[6].actions[0].params.deposit, '0');
  const r = receipt(plan.transactions[0], 0);
  assert.equal(
    verifyActivationReceipt(r, r.transaction.hash, plan.transactions[0]).succeeded,
    true,
  );
  const full = structuredClone(r);
  full.transaction.actions[0].AddKey.access_key.permission = 'FullAccess';
  assert.throws(() => verifyActivationReceipt(full, full.transaction.hash, plan.transactions[0]));
  const unpause = receipt(plan.transactions[5], 5);
  unpause.transaction.actions[0].FunctionCall.deposit = '1';
  assert.throws(() =>
    verifyActivationReceipt(unpause, unpause.transaction.hash, plan.transactions[5]),
  );
  const failed = receipt(plan.transactions[5], 5);
  failed.receipts_outcome[0].outcome.status = { Failure: {} };
  assert.throws(() =>
    verifyActivationReceipt(failed, failed.transaction.hash, plan.transactions[5]),
  );
});
test('activation portal requires explicit sequential signatures, reconciles once, and holds unknown outcomes', async () => {
  const f = fixture(),
    dir = await mkdtemp(join(tmpdir(), 'symbio-activation-')),
    app = await createActivationApp({ ...f, stateDir: dir });
  try {
    const headers = { host: 'localhost:3420' };
    const html = (await app.inject({ url: '/', headers })).body;
    const token = /name="activation-token" content="([a-f0-9]+)"/.exec(html)[1];
    headers['x-activation-token'] = token;
    assert.equal(
      (await app.inject({ url: '/state', headers: { host: 'localhost:3420' } })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: '/state', headers: { ...headers, origin: 'https://evil.invalid' } }))
        .statusCode,
      403,
    );
    const body = { planDigest: plan.digest };
    for (let i = 0; i < 7; i++) {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/begin', headers, payload: body })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/begin', headers, payload: body })).statusCode,
        409,
      );
      const hash = f.transactions[i].transaction.hash;
      assert.equal(
        (await app.inject({ method: 'POST', url: '/observe', headers, payload: { ...body, hash } }))
          .statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/observe', headers, payload: { ...body, hash } }))
          .statusCode,
        200,
      );
    }
    assert.equal(f.reads, 7);
    assert.equal((await app.inject({ url: '/state', headers })).json().complete, true);
    const complete = JSON.parse(await readFile(join(dir, 'complete.json')));
    assert.equal(complete.treasuryTopupYocto, '0');
    assert.equal(complete.paidInferenceRequests, 0);
    assert.equal(complete.transactions.length, 7);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
