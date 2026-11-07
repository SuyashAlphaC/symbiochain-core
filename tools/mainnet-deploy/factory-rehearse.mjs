import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'near-workspaces';
import {
  makeFactoryPlan,
  runFundedDeployment,
  DEPLOYMENT_FUNDING,
  FACTORY_CODE_HASH,
} from './factory-plan.mjs';
import { Account, JsonRpcProvider, actions } from './near-actions.mjs';
import { methods, generateRoleKey, UNIT, MAX_TOTAL, hash, rpc } from './plan.mjs';

process.env.NEAR_SANDBOX_BIN_PATH = '1';
process.env.NEAR_SANDBOX_BINARY_PATH = resolve('.data/bin/Linux-x86_64');
const wasm = await readFile('artifacts/symbiochain_treasury.wasm');
const factoryWasm = await readFile('.data/mainnet-deployment/near-account-factory.wasm').catch(
  async (error) => {
    if (error.code !== 'ENOENT') throw error;
    const deployed = await rpc('query', {
      request_type: 'view_code',
      finality: 'final',
      account_id: 'near',
    });
    assert.equal(deployed.hash, FACTORY_CODE_HASH, 'FACTORY_CODE_CHANGED');
    const bytes = Buffer.from(deployed.code_base64, 'base64');
    assert.equal(hash(bytes), 'f87b56e82fec98541e8ac524851d301be5d1572ff66af905bbf08c8f77afa458');
    await mkdir('.data/mainnet-deployment', { recursive: true, mode: 0o700 });
    await writeFile('.data/mainnet-deployment/near-account-factory.wasm', bytes, { mode: 0o600 });
    return bytes;
  },
);
assert.equal(hash(factoryWasm), 'f87b56e82fec98541e8ac524851d301be5d1572ff66af905bbf08c8f77afa458');
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const owner = await root.createSubAccount('owner', {
    initialBalance: '6735041233785237412378082',
  });
  const factory = await root.createSubAccount('factory', {
    initialBalance: '2000000000000000000000000',
  });
  await factory.deploy(factoryWasm);
  await factory.call(factory, 'new', {});
  const provider = new JsonRpcProvider({ url: worker.provider.connection.url });
  const ownerKey = await owner.getKey();
  const ownerSigner = new Account(owner.accountId, provider, ownerKey.toString());
  const credentials = Object.fromEntries(
    [...Object.keys(methods), 'deployer'].map((role) => [role, generateRoleKey()]),
  );
  const namespace = `symbio.${factory.accountId}`;
  const initial = await provider.viewAccount({ accountId: owner.accountId });
  const plan = makeFactoryPlan(
    ownerKey.getPublicKey().toString(),
    credentials,
    namespace,
    initial.amount,
    owner.accountId,
    factory.accountId,
    'LOCAL_FACTORY_SNAPSHOT',
  );
  assert.equal(plan.factoryTransaction.actions.length, 1);
  assert.equal(plan.factoryTransaction.actions[0].type, 'FunctionCall');
  const p = plan.factoryTransaction.actions[0].params;
  const funding = await ownerSigner.signAndSendTransaction({
    receiverId: factory.accountId,
    actions: [actions.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit))],
    waitUntil: 'FINAL',
  });
  assert.ok(!JSON.stringify(funding.status).includes('Failure'));
  assert.equal(
    await provider
      .callFunction({
        contractId: factory.accountId,
        method: 'get_key_balance',
        args: { key: plan.deployerPublicKey },
      })
      .then(() => true)
      .catch(() => false),
    false,
  );
  const result = await runFundedDeployment(plan, credentials, wasm, {
    url: worker.provider.connection.url,
    persist: false,
  });
  assert.equal(result.recorded.length, 8);
  const view = (method) =>
    provider.callFunction({ contractId: plan.accounts.treasury, method, args: {} });
  assert.equal((await view('distribution_policy')).paused, true);
  assert.equal((await view('check_metabolism')).status, 'PAUSED');
  assert.deepEqual(await view('get_policy'), plan.initializer.policy);
  const parentKeys = await provider.viewAccessKeyList({ accountId: namespace });
  assert.equal(parentKeys.keys.length, 1);
  assert.equal(parentKeys.keys[0].public_key, plan.ownerPublicKey);
  const ownerKeys = await provider.viewAccessKeyList({ accountId: owner.accountId });
  assert.equal(ownerKeys.keys.length, 1);
  assert.equal(ownerKeys.keys[0].public_key, plan.ownerPublicKey);
  const final = await provider.viewAccount({ accountId: owner.accountId });
  const spent = BigInt(initial.amount) - BigInt(final.amount);
  assert.ok(spent <= MAX_TOTAL);
  assert.ok(BigInt(final.amount) >= (3n * UNIT) / 10n);
  const again = await runFundedDeployment(plan, credentials, wasm, {
    url: worker.provider.connection.url,
    persist: false,
  });
  assert.equal(again.alreadyFinalized, true);
  assert.equal(again.recorded.length, 0);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_NEAR_FACTORY_SNAPSHOT_REHEARSAL',
    actualMainnetTransactions: 0,
    factoryWasmSha256: hash(factoryWasm),
    wasmSha256: hash(wasm),
    walletTransactionTypes: ['FunctionCall'],
    walletMethod: 'near.create_account',
    walletFundingYocto: DEPLOYMENT_FUNDING.toString(),
    rootOwnerKeysUnchanged: true,
    temporaryKeyRevoked: true,
    paused: true,
    localDeploymentTransactions: result.recorded.length,
    duplicateRunSubmitsZeroTransactions: true,
    ownerSpentYocto: spent.toString(),
    ownerRemainingYocto: final.amount.toString(),
    refundedYocto: result.refundedYocto,
    maximumPlannedYocto: MAX_TOTAL.toString(),
    paidRequests: 0,
  };
  await writeFile(
    'artifacts/mainnet-factory-deployment-rehearsal.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await worker.tearDown();
}
