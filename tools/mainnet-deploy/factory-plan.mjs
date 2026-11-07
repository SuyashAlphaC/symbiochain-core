import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import {
  ROOT,
  RPC,
  WASM_SHA256,
  ZERO_CODE,
  UNIT,
  OWNER_MINIMUM,
  makePlan,
  generateRoleKey,
  methods,
  rpc,
  hash,
  inspect,
} from './plan.mjs';
import { Account, JsonRpcProvider, PublicKey, actions, actionFor } from './near-actions.mjs';

export const FACTORY_STATE_DIR = '.data/mainnet-deployment-factory';
export const FACTORY_CODE_HASH = 'HiyC5tB1gBDpgR4x1guEp1orBde5PXqUYGoWaZfX3JGX';
export const DEPLOYMENT_FUNDING = 6380000000000000000000000n;
export const FACTORY_GAS = 50000000000000n;
export const DEPLOYMENT_GAS_RESERVE = UNIT / 10n;
export const PARENT_RESERVE = UNIT / 200n;
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item), 2) + '\n';

export function makeFactoryPlan(
  ownerPublicKey,
  credentials,
  namespace,
  initialBalance,
  owner = ROOT,
  factory = 'near',
  factoryCodeHash = FACTORY_CODE_HASH,
) {
  assert.ok(namespace.endsWith(`.${factory}`));
  const base = makePlan(ownerPublicKey, credentials, initialBalance, namespace);
  // Reserve treasury's prepaid gas before distributing the smaller agent balances.
  base.groups.sort((a, b) => Number(b.role === 'treasury') - Number(a.role === 'treasury'));
  base.owner = owner;
  // The dedicated namespace owns the contract. Its final recovery key belongs
  // to the funding Meteor wallet; the temporary deployment key is revoked.
  return {
    ...base,
    version: 2,
    mode: 'BOUNDED_LOCAL_DEPLOYMENT_WALLET',
    namespace,
    deployerPublicKey: credentials.deployer.publicKey,
    factory,
    factoryCodeHash,
    deploymentFundingYocto: DEPLOYMENT_FUNDING.toString(),
    factoryGasReserveYocto: (UNIT / 50n).toString(),
    factoryTransaction: {
      signerId: owner,
      receiverId: factory,
      actions: [
        {
          type: 'FunctionCall',
          params: {
            methodName: 'create_account',
            args: { new_account_id: namespace, new_public_key: credentials.deployer.publicKey },
            gas: FACTORY_GAS.toString(),
            deposit: DEPLOYMENT_FUNDING.toString(),
          },
        },
      ],
    },
    disclosure:
      'Meteor funds a separate deployment wallet with 6.38 NEAR via the official near account factory. Its temporary local full-access key deploys the paused infrastructure, adds the Meteor recovery public key, refunds excess funds and removes itself. No key or permission is added to the original Meteor account. The local key controls the separate deployment wallet until finalization.',
  };
}
export async function prepareFactory() {
  await mkdir(FACTORY_STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(FACTORY_STATE_DIR, 0o700);
  const wasm = await readFile('artifacts/symbiochain_treasury.wasm');
  assert.equal(hash(wasm), WASM_SHA256);
  let plan, credentials;
  try {
    plan = JSON.parse(await readFile(`${FACTORY_STATE_DIR}/plan.json`, 'utf8'));
    credentials = JSON.parse(await readFile(`${FACTORY_STATE_DIR}/credentials.json`, 'utf8'));
    assert.deepEqual(
      plan,
      makeFactoryPlan(plan.ownerPublicKey, credentials, plan.namespace, plan.initialBalanceYocto),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    for (const name of ['plan.json', 'credentials.json']) {
      const present = await readFile(`${FACTORY_STATE_DIR}/${name}`)
        .then(() => true)
        .catch((e) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        });
      assert.equal(present, false, 'PARTIAL_FACTORY_STATE_REQUIRES_REVIEW');
    }
    const [owner, keys, factoryAccount] = await Promise.all([
      rpc('query', { request_type: 'view_account', finality: 'final', account_id: ROOT }),
      rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: ROOT }),
      rpc('query', { request_type: 'view_account', finality: 'final', account_id: 'near' }),
    ]);
    assert.equal(factoryAccount.code_hash, FACTORY_CODE_HASH, 'FACTORY_CODE_CHANGED');
    assert.ok(BigInt(owner.amount) >= (67n * UNIT) / 10n, 'OWNER_FUNDING_INSUFFICIENT');
    const fullKeys = keys.keys.filter((row) => row.access_key.permission === 'FullAccess');
    assert.equal(fullKeys.length, 1, 'OWNER_RECOVERY_KEYS_CHANGED');
    credentials = Object.fromEntries(
      [...Object.keys(methods), 'deployer'].map((role) => [role, generateRoleKey()]),
    );
    const namespace = `symbio-${randomBytes(5).toString('hex')}.near`;
    assert.equal(
      await rpc('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: namespace,
      }),
      null,
      'DEPLOYMENT_NAME_ALREADY_EXISTS',
    );
    plan = makeFactoryPlan(fullKeys[0].public_key, credentials, namespace, owner.amount);
    await writeFile(`${FACTORY_STATE_DIR}/credentials.json`, json(credentials), {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(`${FACTORY_STATE_DIR}/plan.json`, json(plan), { mode: 0o600, flag: 'wx' });
  }
  return { plan, credentials, wasm };
}
export async function inspectFactory(plan) {
  const [status, gas, owner, ownerKeys, factoryAccount, parent] = await Promise.all([
    rpc('status', []),
    rpc('gas_price', [null]),
    rpc('query', { request_type: 'view_account', finality: 'final', account_id: ROOT }),
    rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: ROOT }),
    rpc('query', { request_type: 'view_account', finality: 'final', account_id: plan.factory }),
    rpc('query', { request_type: 'view_account', finality: 'final', account_id: plan.namespace }),
  ]);
  assert.equal(status.chain_id, 'mainnet');
  assert.ok(BigInt(gas.gas_price) <= 200000000n, 'GAS_PRICE_REVIEW_REQUIRED');
  assert.equal(factoryAccount.code_hash, plan.factoryCodeHash, 'FACTORY_CODE_CHANGED');
  assert.equal(owner.code_hash, ZERO_CODE, 'OWNER_CONTRACT_REQUIRES_REVIEW');
  const full = ownerKeys.keys.filter((row) => row.access_key.permission === 'FullAccess');
  assert.equal(full.length, 1, 'OWNER_RECOVERY_KEYS_CHANGED');
  assert.equal(full[0].public_key, plan.ownerPublicKey);
  if (!parent) {
    assert.ok(
      BigInt(owner.amount) >=
        DEPLOYMENT_FUNDING + BigInt(plan.factoryGasReserveYocto) + OWNER_MINIMUM,
      'OWNER_FUNDING_INSUFFICIENT',
    );
    return {
      checkedAt: new Date().toISOString(),
      ownerBalanceYocto: owner.amount,
      completed: [],
      remainingRoles: plan.groups.map((row) => row.role),
      fundingRequired: true,
      localDeploymentReady: false,
      fullyDeployed: false,
      paidInferenceRequests: 0,
    };
  }
  assert.equal(parent.code_hash, ZERO_CODE, 'DEPLOYMENT_PARENT_CODE_CHANGED');
  const keys = await rpc('query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: plan.namespace,
  });
  assert.ok(keys.keys.length === 1 || keys.keys.length === 2, 'DEPLOYMENT_KEYS_CHANGED');
  for (const key of keys.keys) {
    assert.ok(
      [plan.ownerPublicKey, plan.deployerPublicKey].includes(key.public_key),
      'UNEXPECTED_DEPLOYMENT_KEY',
    );
    assert.equal(key.access_key.permission, 'FullAccess');
  }
  const temporaryPresent = keys.keys.some((key) => key.public_key === plan.deployerPublicKey);
  const recoveryPresent = keys.keys.some((key) => key.public_key === plan.ownerPublicKey);
  const childState = await inspect(plan, {
    fundingAccountId: plan.namespace,
    minimumFundingBalance: PARENT_RESERVE,
    gasReserve: DEPLOYMENT_GAS_RESERVE,
  });
  if (!temporaryPresent)
    assert.ok(recoveryPresent && childState.fullyDeployed, 'DEPLOYER_REMOVED_BEFORE_COMPLETION');
  return {
    ...childState,
    fundingRequired: false,
    localDeploymentReady: temporaryPresent,
    infrastructureVerified: childState.fullyDeployed,
    fullyDeployed: childState.fullyDeployed && recoveryPresent && !temporaryPresent,
    temporaryKeyRevoked: !temporaryPresent,
    recoveryPresent,
  };
}

export async function runFundedDeployment(
  plan,
  credentials,
  wasm,
  { url = RPC, persist = true, beforeStep } = {},
) {
  assert.equal(hash(wasm), plan.wasmSha256);
  const check = beforeStep ?? (url === RPC ? () => inspectFactory(plan) : async () => {});
  await check();
  const provider = new JsonRpcProvider({ url });
  const signer = new Account(plan.namespace, provider, credentials.deployer.secretKey);
  const recorded = [];
  const record = async (label, result) => {
    assert.equal(result.transaction.signer_id, plan.namespace, 'UNEXPECTED_LOCAL_SIGNER');
    assert.ok(!JSON.stringify(result.status).includes('Failure'), 'DEPLOYMENT_TRANSACTION_FAILED');
    recorded.push({
      label,
      hash: result.transaction.hash,
      signerId: result.transaction.signer_id,
      receiverId: result.transaction.receiver_id,
    });
    if (persist) {
      const old = await readFile(`${FACTORY_STATE_DIR}/transactions.json`, 'utf8')
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      await writeFile(`${FACTORY_STATE_DIR}/transactions.json`, json([...old, recorded.at(-1)]), {
        mode: 0o600,
      });
    }
  };
  const keys = await provider.viewAccessKeyList({ accountId: plan.namespace });
  const temporary = keys.keys.find((key) => key.public_key === plan.deployerPublicKey);
  if (!temporary) return { recorded, alreadyFinalized: true };
  if (!keys.keys.some((key) => key.public_key === plan.ownerPublicKey)) {
    await check();
    await record(
      'install-owner-recovery',
      await signer.signAndSendTransaction({
        receiverId: plan.namespace,
        actions: [actions.addFullAccessKey(PublicKey.fromString(plan.ownerPublicKey))],
        waitUntil: 'FINAL',
      }),
    );
  }
  for (const group of plan.groups) {
    const state = await rpc(
      'query',
      { request_type: 'view_account', finality: 'final', account_id: group.receiverId },
      url,
    );
    if (state) continue;
    await check();
    await record(
      `create-${group.role}`,
      await signer.signAndSendTransaction({
        receiverId: group.receiverId,
        actions: group.actions.map((intent) => actionFor(intent, wasm)),
        waitUntil: 'FINAL',
      }),
    );
  }
  await check();
  const balance = await provider.viewAccount({ accountId: plan.namespace });
  const available = BigInt(balance.amount) - BigInt(balance.storage_usage) * 10000000000000000000n;
  assert.ok(available >= PARENT_RESERVE, 'DEPLOYMENT_FINALIZATION_RESERVE_TOO_LOW');
  const refund = available > (15n * UNIT) / 1000n ? available - UNIT / 100n : 0n;
  if (refund > 0n)
    await record(
      'refund-excess-to-meteor',
      await signer.signAndSendTransaction({
        receiverId: plan.owner,
        actions: [actions.transfer(refund)],
        waitUntil: 'FINAL',
      }),
    );
  await record(
    'revoke-temporary-deployer',
    await signer.signAndSendTransaction({
      receiverId: plan.namespace,
      actions: [actions.deleteKey(PublicKey.fromString(plan.deployerPublicKey))],
      waitUntil: 'FINAL',
    }),
  );
  return { recorded, refundedYocto: refund.toString(), temporaryKeyRevoked: true };
}
