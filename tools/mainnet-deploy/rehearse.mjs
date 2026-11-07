import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'near-workspaces';
import { createRequire } from 'node:module';
const { Account, JsonRpcProvider, PublicKey, KeyPair, actions } = createRequire(
  new URL('../../package.json', import.meta.url),
)('near-api-js');
import {
  makePlan,
  generateRoleKey,
  hash,
  WASM_SHA256,
  UNIT,
  MAX_TOTAL,
  methods,
  rpc,
} from './plan.mjs';

function actionFor(intent, wasm) {
  const p = intent.params;
  switch (intent.type) {
    case 'CreateAccount':
      return actions.createAccount();
    case 'Transfer':
      return actions.transfer(BigInt(p.deposit));
    case 'DeployContract':
      return actions.deployContract(wasm);
    case 'FunctionCall':
      return actions.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit));
    case 'AddKey': {
      const key = PublicKey.fromString(p.publicKey),
        scope = p.accessKey.permission;
      return scope === 'FullAccess'
        ? actions.addFullAccessKey(key)
        : actions.addFunctionCallAccessKey(
            key,
            scope.receiverId,
            scope.methodNames,
            BigInt(scope.allowance),
          );
    }
    default:
      throw Error('UNEXPECTED_ACTION');
  }
}
process.env.NEAR_SANDBOX_BIN_PATH = '1';
process.env.NEAR_SANDBOX_BINARY_PATH = resolve('.data/bin/Linux-x86_64');
const wasm = await readFile('artifacts/symbiochain_treasury.wasm');
assert.equal(hash(wasm), WASM_SHA256);
const worker = await Worker.init();
try {
  const root = worker.rootAccount;
  const owner = await root.createSubAccount('owner', {
    initialBalance: '6735041233785237412378082',
  });
  const key = await owner.getKey();
  const provider = new JsonRpcProvider({ url: worker.provider.connection.url });
  const signer = new Account(owner.accountId, provider, key.toString());
  const roleKeys = Object.fromEntries(
    Object.keys(methods).map((role) => [role, generateRoleKey()]),
  );
  for (const pair of Object.values(roleKeys))
    assert.equal(KeyPair.fromString(pair.secretKey).getPublicKey().toString(), pair.publicKey);
  const initial = await provider.viewAccount({ accountId: owner.accountId });
  const plan = makePlan(key.getPublicKey().toString(), roleKeys, initial.amount, owner.accountId);
  const txs = [];
  for (const group of plan.groups) {
    const tx = await signer.signAndSendTransaction({
      receiverId: group.receiverId,
      actions: group.actions.map((intent) => actionFor(intent, wasm)),
      waitUntil: 'FINAL',
    });
    assert.ok(
      !JSON.stringify(tx.status).includes('Failure'),
      `DEPLOYMENT_GROUP_FAILED_${group.role}`,
    );
    txs.push(tx);
  }
  const view = (method, args = {}) =>
    provider.callFunction({ contractId: plan.accounts.treasury, method, args });
  assert.equal((await view('distribution_policy')).paused, true);
  assert.equal((await view('check_metabolism')).status, 'PAUSED');
  assert.deepEqual(await view('get_policy'), plan.initializer.policy);
  for (const role of Object.keys(methods)) {
    const id = Buffer.from(plan.accounts[role]);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(id.length);
    const key = Buffer.concat([Buffer.from([1]), length, id]).toString('base64');
    const state = await rpc(
      'query',
      {
        request_type: 'view_state',
        account_id: plan.accounts.treasury,
        finality: 'final',
        prefix_base64: key,
      },
      worker.provider.connection.url,
    );
    assert.equal(state.values.length, 1);
    assert.equal(state.values[0].key, key);
    assert.deepEqual(Buffer.from(state.values[0].value, 'base64'), Buffer.from([0]));
  }
  const treasury = await provider.viewAccount({ accountId: plan.accounts.treasury });
  const available =
    BigInt(treasury.amount) - BigInt(treasury.storage_usage) * 10000000000000000000n;
  assert.ok(available >= UNIT / 10n);
  const final = await provider.viewAccount({ accountId: owner.accountId });
  const ownerSpent = BigInt(initial.amount) - BigInt(final.amount);
  assert.ok(ownerSpent <= MAX_TOTAL);
  assert.ok(BigInt(final.amount) >= (3n * UNIT) / 10n);
  const brain = new Account(plan.accounts.brain, provider, roleKeys.brain.secretKey);
  await assert.rejects(
    brain.callFunction({
      contractId: plan.accounts.treasury,
      methodName: 'set_paused',
      args: { paused: false },
      gas: 10000000000000n,
      deposit: 0n,
    }),
    /method|access|permission/i,
  );
  assert.equal((await view('distribution_policy')).paused, true);
  const beforeDuplicate = await provider.viewAccount({ accountId: plan.accounts.brain });
  await assert.rejects(
    signer.signAndSendTransaction({
      receiverId: plan.accounts.brain,
      actions: plan.groups[0].actions.map((intent) => actionFor(intent, wasm)),
      waitUntil: 'FINAL',
    }),
  );
  const afterDuplicate = await provider.viewAccount({ accountId: plan.accounts.brain });
  assert.equal(afterDuplicate.amount, beforeDuplicate.amount);
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_NEAR_SANDBOX_EXACT_ACTION_REHEARSAL',
    walletSignatureEmulatedBySandboxOwner: true,
    actualMainnetTransactions: 0,
    wasmSha256: WASM_SHA256,
    accountGroups: plan.groups.length,
    initializedAndPausedInSameTransaction: true,
    runtimeKeyCannotUnpause: true,
    duplicateCreationCannotDoubleFund: true,
    treasuryStorageBytes: treasury.storage_usage,
    treasuryAvailableYocto: available.toString(),
    ownerSpentYocto: ownerSpent.toString(),
    fundingYocto: plan.totalFundingYocto,
    ownerRemainingYocto: final.amount,
    maximumPlannedYocto: MAX_TOTAL.toString(),
    paused: true,
    tradingCapsAtoms: '1',
    modelRequests: 0,
  };
  const encode = (value) =>
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
  await writeFile('artifacts/mainnet-owner-deployment-rehearsal.json', encode(report) + '\n');
  console.log(encode(report));
} finally {
  await worker.tearDown();
}
