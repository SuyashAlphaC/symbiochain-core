import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateRoleKey, methods, ROOT, MAX_TOTAL, UNIT } from './plan.mjs';
import { makeFactoryPlan, DEPLOYMENT_FUNDING } from './factory-plan.mjs';

const recovery = generateRoleKey();
const credentials = Object.fromEntries(
  [...Object.keys(methods), 'deployer'].map((role) => [role, generateRoleKey()]),
);
const plan = makeFactoryPlan(
  recovery.publicKey,
  credentials,
  'symbio-fixture.near',
  (6735n * UNIT) / 1000n,
);
test('Meteor funds a separate wallet through the official factory without root key grants', () => {
  const tx = plan.factoryTransaction;
  assert.equal(tx.signerId, ROOT);
  assert.equal(tx.receiverId, 'near');
  assert.equal(tx.actions.length, 1);
  assert.equal(tx.actions[0].type, 'FunctionCall');
  assert.equal(tx.actions[0].params.methodName, 'create_account');
  assert.equal(tx.actions[0].params.args.new_account_id, plan.namespace);
  assert.equal(tx.actions[0].params.args.new_public_key, credentials.deployer.publicKey);
  assert.equal(tx.actions[0].params.deposit, DEPLOYMENT_FUNDING.toString());
  assert.equal(DEPLOYMENT_FUNDING + BigInt(plan.factoryGasReserveYocto), MAX_TOTAL);
});
test('dedicated owner initializes and pauses treasury before creating any worker accounts', () => {
  assert.equal(plan.groups[0].role, 'treasury');
  assert.equal(plan.initializer.owner, plan.namespace);
  for (const group of plan.groups) {
    assert.equal(group.signerId, plan.namespace);
    assert.ok(group.receiverId.endsWith(`.${plan.namespace}`));
    const grants = group.actions.filter((action) => action.type === 'AddKey');
    assert.equal(grants[0].params.publicKey, recovery.publicKey);
    assert.ok(grants.every((grant) => grant.params.publicKey !== credentials.deployer.publicKey));
  }
  for (const key of Object.values(credentials))
    assert.ok(!JSON.stringify(plan).includes(key.secretKey));
});
