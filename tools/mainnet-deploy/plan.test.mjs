import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateRoleKey,
  makePlan,
  methods,
  ROOT,
  WASM_SHA256,
  MAX_TOTAL,
  OWNER_MINIMUM,
  SCOPE_ALLOWANCE,
} from './plan.mjs';

const owner = generateRoleKey();
const keys = Object.fromEntries(Object.keys(methods).map((role) => [role, generateRoleKey()]));
const plan = makePlan(owner.publicKey, keys, MAX_TOTAL + OWNER_MINIMUM);

test('funding plus contingency fits the approved deployment plan', () => {
  const sum = plan.groups.reduce((total, group) => total + BigInt(group.fundingYocto), 0n);
  assert.equal(sum + BigInt(plan.gasReserveYocto), MAX_TOTAL);
  assert.equal(plan.owner, ROOT);
  assert.equal(plan.groups.length, 5);
  for (const group of plan.groups) {
    assert.equal(group.signerId, ROOT);
    assert.ok(group.receiverId.endsWith(`.${ROOT}`));
    assert.equal(group.actions[0].type, 'CreateAccount');
    assert.equal(group.actions[1].type, 'Transfer');
    assert.equal(group.actions[1].params.deposit, group.fundingYocto);
  }
});

test('only owner holds recovery authority; runtime keys cannot change policy', () => {
  for (const group of plan.groups) {
    const grants = group.actions.filter((action) => action.type === 'AddKey');
    assert.equal(
      grants.filter((action) => action.params.accessKey.permission === 'FullAccess').length,
      1,
    );
    assert.equal(grants[0].params.publicKey, owner.publicKey);
    if (methods[group.role]) {
      const scope = grants[1].params.accessKey.permission;
      assert.equal(scope.receiverId, plan.accounts.treasury);
      assert.deepEqual(scope.methodNames, methods[group.role]);
      assert.equal(BigInt(scope.allowance), SCOPE_ALLOWANCE);
      assert.ok(!scope.methodNames.includes('set_paused'));
      assert.ok(!scope.methodNames.includes('set_policy'));
    } else assert.equal(grants.length, 1);
  }
  for (const key of [owner, ...Object.values(keys)])
    assert.ok(!JSON.stringify(plan).includes(key.secretKey));
});

test('treasury pins the reviewed artifact and closes all execution gates atomically', () => {
  assert.equal(plan.wasmSha256, WASM_SHA256);
  const actions = plan.groups.find((group) => group.role === 'treasury').actions;
  const calls = actions
    .filter((action) => action.type === 'FunctionCall')
    .map((action) => action.params);
  assert.deepEqual(
    calls.map((call) => call.methodName),
    ['new', 'set_paused', 'set_worker_enabled', 'set_worker_enabled', 'set_worker_enabled'],
  );
  assert.equal(calls[1].args.paused, true);
  assert.ok(calls.slice(2).every((call) => call.args.enabled === false));
  assert.equal(calls[0].args.policy.max_trade_atoms, '1');
  assert.equal(calls[0].args.policy.max_daily_atoms, '1');
  assert.equal(calls[0].args.mpc, 'v1.signer');
  assert.ok(calls.every((call) => call.deposit === '0'));
});
