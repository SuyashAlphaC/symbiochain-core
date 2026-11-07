import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import bs58 from 'bs58';

export const ROOT = 'solidvideo4090.near';
export const RPC = 'https://free.rpc.fastnear.com';
export const STATE_DIR = '.data/mainnet-deployment';
export const UNIT = 10n ** 24n;
export const WASM_SHA256 = '39f034e6ae16ddb9cf253ac977c4146989a0fee1fa7c33ba0944092bf41de3d5';
export const ZERO_CODE = '11111111111111111111111111111111';
export const MAX_TOTAL = 6400000000000000000000000n;
export const GAS_RESERVE = 130000000000000000000000n;
export const OWNER_MINIMUM = 300000000000000000000000n;
export const SCOPE_ALLOWANCE = 40000000000000000000000n;
export const methods = {
  brain: ['authorize_cycle'],
  hand: ['request_evm_signature', 'request_solana_signature', 'record_submission'],
  accountant: ['finalize_cycle', 'mint_proof_nft'],
};
const names = {
  brain: 'brain',
  hand: 'hand',
  accountant: 'books',
  scout: 'scout',
  treasury: 'treasury',
};
const funding = {
  brain: UNIT / 20n,
  hand: UNIT / 20n,
  accountant: UNIT / 20n,
  scout: UNIT / 50n,
  treasury: (61n * UNIT) / 10n,
};
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const planDigest = (value) => hash(JSON.stringify(value));
export function generateRoleKey() {
  const pair = generateKeyPairSync('ed25519');
  const publicBytes = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const seed = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return {
    publicKey: `ed25519:${bs58.encode(publicBytes)}`,
    secretKey: `ed25519:${bs58.encode(Buffer.concat([seed, publicBytes]))}`,
  };
}
let rpcQueue = Promise.resolve();
let lastRpcStart = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function paceRpc(url) {
  if (url !== RPC) return;
  const turn = rpcQueue.then(async () => {
    await delay(Math.max(0, lastRpcStart + 250 - Date.now()));
    lastRpcStart = Date.now();
  });
  rpcQueue = turn.catch(() => {});
  await turn;
}
export async function rpc(method, params, url = RPC, retry = 0) {
  await paceRpc(url);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'symbiochain-owner-deployment', method, params }),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 429 && retry < 2) {
    await response.body?.cancel();
    await delay(1000 * (retry + 1));
    return rpc(method, params, url, retry + 1);
  }
  if (!response.ok) throw Error(`RPC_HTTP_${response.status}`);
  const body = await response.json();
  if (body.error) {
    if (body.error.cause?.name === 'UNKNOWN_ACCOUNT') return null;
    throw Error(`RPC_${body.error.cause?.name ?? 'ERROR'}`);
  }
  if (body.result === undefined) throw Error('RPC_RESPONSE_INVALID');
  return body.result;
}
export function makePlan(ownerPublicKey, roleKeys, initialBalance, owner = ROOT) {
  const accounts = Object.fromEntries(
    Object.entries(names).map(([role, name]) => [role, `${name}.${owner}`]),
  );
  const policy = {
    max_trade_atoms: '1',
    max_daily_atoms: '1',
    min_reserve_yocto: (UNIT / 10n).toString(),
    max_signing_cost_yocto: '1',
    max_slippage_bps: 0,
    allowed_chain_ids: [0],
    allowed_token_contracts: ['sol:native'],
    token_max_trade_atoms: ['1'],
    token_max_daily_atoms: ['1'],
  };
  const initializer = {
    owner,
    brain: accounts.brain,
    hand: accounts.hand,
    accountant: accounts.accountant,
    mpc: 'v1.signer',
    derivation_path: 'symbio-mainnet-v1',
    policy,
  };
  const groups = Object.keys(names).map((role) => {
    const actions = [
      { type: 'CreateAccount' },
      { type: 'Transfer', params: { deposit: funding[role].toString() } },
      {
        type: 'AddKey',
        params: { publicKey: ownerPublicKey, accessKey: { permission: 'FullAccess' } },
      },
    ];
    if (methods[role])
      actions.push({
        type: 'AddKey',
        params: {
          publicKey: roleKeys[role].publicKey,
          accessKey: {
            permission: {
              receiverId: accounts.treasury,
              methodNames: methods[role],
              allowance: SCOPE_ALLOWANCE.toString(),
            },
          },
        },
      });
    if (role === 'treasury')
      actions.push(
        { type: 'DeployContract', params: { code: 'PINNED_WASM_FROM_LOCAL_SERVER' } },
        {
          type: 'FunctionCall',
          params: { methodName: 'new', args: initializer, gas: '80000000000000', deposit: '0' },
        },
        {
          type: 'FunctionCall',
          params: {
            methodName: 'set_paused',
            args: { paused: true },
            gas: '10000000000000',
            deposit: '0',
          },
        },
        ...['brain', 'hand', 'accountant'].map((agent) => ({
          type: 'FunctionCall',
          params: {
            methodName: 'set_worker_enabled',
            args: { worker: accounts[agent], enabled: false },
            gas: '10000000000000',
            deposit: '0',
          },
        })),
      );
    return {
      role,
      signerId: owner,
      receiverId: accounts[role],
      fundingYocto: funding[role].toString(),
      actions,
    };
  });
  const totalFunding = Object.values(funding).reduce((a, b) => a + b, 0n);
  assert.equal(totalFunding, 6270000000000000000000000n);
  assert.equal(totalFunding + GAS_RESERVE, MAX_TOTAL);
  return {
    version: 1,
    network: 'mainnet',
    owner,
    ownerPublicKey,
    accounts,
    initializer,
    wasmSha256: WASM_SHA256,
    initialBalanceYocto: String(initialBalance),
    maxTotalYocto: MAX_TOTAL.toString(),
    gasReserveYocto: GAS_RESERVE.toString(),
    minimumOwnerRemainingYocto: OWNER_MINIMUM.toString(),
    totalFundingYocto: totalFunding.toString(),
    groups,
    disclosure:
      'Paused owner-funded infrastructure only. No trading, inference, Intents settlement, NFT mint, revenue or profit proof. Gas is checked at current network prices; the chain determines actual fees.',
  };
}
export async function prepare() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
  const wasm = await readFile('artifacts/symbiochain_treasury.wasm');
  assert.equal(hash(wasm), WASM_SHA256, 'WASM_REBUILD_REVIEW_REQUIRED');
  let plan, credentials;
  try {
    plan = JSON.parse(await readFile(`${STATE_DIR}/plan.json`, 'utf8'));
    credentials = JSON.parse(await readFile(`${STATE_DIR}/credentials.json`, 'utf8'));
    const expected = makePlan(plan.ownerPublicKey, credentials, plan.initialBalanceYocto);
    assert.deepEqual(plan, expected, 'EXISTING_PLAN_CHANGED');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Refuse to replace half of an existing key/manifest pair.
    for (const name of ['plan.json', 'credentials.json']) {
      const exists = await readFile(`${STATE_DIR}/${name}`)
        .then(() => true)
        .catch((e) => {
          if (e.code === 'ENOENT') return false;
          throw e;
        });
      assert.equal(exists, false, 'PARTIAL_KEY_STATE_REQUIRES_REVIEW');
    }
    const [status, owner, ownerKeys] = await Promise.all([
      rpc('status', []),
      rpc('query', { request_type: 'view_account', finality: 'final', account_id: ROOT }),
      rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: ROOT }),
    ]);
    assert.equal(status.chain_id, 'mainnet');
    assert.ok(
      owner && BigInt(owner.amount) >= MAX_TOTAL + OWNER_MINIMUM,
      'OWNER_FUNDING_INSUFFICIENT',
    );
    assert.equal(owner.code_hash, ZERO_CODE, 'OWNER_CONTRACT_REQUIRES_REVIEW');
    const full = ownerKeys.keys.filter((row) => row.access_key.permission === 'FullAccess');
    assert.equal(full.length, 1, 'AMBIGUOUS_OWNER_RECOVERY_KEY');
    credentials = Object.fromEntries(Object.keys(methods).map((role) => [role, generateRoleKey()]));
    plan = makePlan(full[0].public_key, credentials, owner.amount);
    for (const accountId of Object.values(plan.accounts))
      assert.equal(
        await rpc('query', {
          request_type: 'view_account',
          finality: 'final',
          account_id: accountId,
        }),
        null,
        'ACCOUNT_ALREADY_EXISTS',
      );
    await writeFile(`${STATE_DIR}/credentials.json`, JSON.stringify(credentials), {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(`${STATE_DIR}/plan.json`, JSON.stringify(plan, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  return { plan, wasm, credentials };
}
export async function viewCall(accountId, method, args = {}, url = RPC) {
  const result = await rpc(
    'query',
    {
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
    url,
  );
  assert.ok(result, 'CONTRACT_VIEW_UNAVAILABLE');
  return JSON.parse(Buffer.from(result.result).toString());
}
export async function inspect(
  plan,
  { fundingAccountId = ROOT, minimumFundingBalance = OWNER_MINIMUM, gasReserve = GAS_RESERVE } = {},
) {
  const [owner, gas, protocol, ownerKeys] = await Promise.all([
    rpc('query', { request_type: 'view_account', finality: 'final', account_id: ROOT }),
    rpc('gas_price', [null]),
    rpc('EXPERIMENTAL_protocol_config', { finality: 'final' }),
    rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: ROOT }),
  ]);
  assert.equal(protocol.chain_id, 'mainnet');
  assert.equal(protocol.runtime_config.storage_amount_per_byte, '10000000000000000000');
  assert.ok(BigInt(gas.gas_price) <= 200000000n, 'GAS_PRICE_REVIEW_REQUIRED');
  assert.equal(owner.code_hash, ZERO_CODE, 'OWNER_CONTRACT_REQUIRES_REVIEW');
  const fullKeys = ownerKeys.keys.filter((row) => row.access_key.permission === 'FullAccess');
  assert.equal(fullKeys.length, 1, 'OWNER_RECOVERY_KEYS_CHANGED');
  assert.equal(fullKeys[0].public_key, plan.ownerPublicKey, 'OWNER_RECOVERY_KEY_CHANGED');
  const remaining = [],
    completed = [];
  const accountStates = await Promise.all(
    plan.groups.map((group) =>
      rpc('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: group.receiverId,
      }),
    ),
  );
  for (const [index, group] of plan.groups.entries()) {
    const account = accountStates[index];
    if (!account) {
      remaining.push(group);
      continue;
    }
    assert.equal(
      account.code_hash,
      group.role === 'treasury' ? bs58.encode(Buffer.from(WASM_SHA256, 'hex')) : ZERO_CODE,
      'EXISTING_ACCOUNT_CODE_MISMATCH',
    );
    const keys = await rpc('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: group.receiverId,
    });
    const wanted = group.actions.filter((action) => action.type === 'AddKey');
    assert.equal(keys.keys.length, wanted.length, 'ACCOUNT_KEYS_CHANGED');
    for (const expected of wanted) {
      const actual = keys.keys.find((key) => key.public_key === expected.params.publicKey);
      assert.ok(actual, 'ACCOUNT_KEY_MISSING');
      const scope = expected.params.accessKey.permission;
      if (scope === 'FullAccess') assert.equal(actual.access_key.permission, 'FullAccess');
      else {
        const permission = actual.access_key.permission.FunctionCall;
        assert.equal(permission.receiver_id, scope.receiverId);
        assert.deepEqual([...permission.method_names].sort(), [...scope.methodNames].sort());
        assert.ok(BigInt(permission.allowance) <= BigInt(scope.allowance), 'ALLOWANCE_INCREASED');
      }
    }
    if (group.role === 'treasury') {
      assert.deepEqual(
        await viewCall(group.receiverId, 'get_policy'),
        plan.initializer.policy,
        'POLICY_MISMATCH',
      );
      const distribution = await viewCall(group.receiverId, 'distribution_policy');
      assert.equal(distribution.paused, true, 'TREASURY_NOT_PAUSED');
      assert.equal(distribution.accountant, plan.accounts.accountant);
      assert.equal(distribution.total_shares_bps, 0);
      for (const role of ['brain', 'hand', 'accountant']) {
        const worker = Buffer.from(plan.accounts[role]);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(worker.length);
        // LookupMap<Key::Workers, AccountId, bool>: Borsh enum prefix + string.
        const key = Buffer.concat([Buffer.from([1]), length, worker]);
        const state = await rpc('query', {
          request_type: 'view_state',
          finality: 'final',
          account_id: group.receiverId,
          prefix_base64: key.toString('base64'),
        });
        assert.equal(state.values.length, 1, 'WORKER_DISABLE_RECORD_MISSING');
        assert.equal(state.values[0].key, key.toString('base64'), 'WORKER_STATE_KEY_MISMATCH');
        assert.deepEqual(
          Buffer.from(state.values[0].value, 'base64'),
          Buffer.from([0]),
          'WORKER_NOT_DISABLED',
        );
      }
      assert.ok(
        BigInt(account.amount) -
          BigInt(account.storage_usage) * BigInt(protocol.runtime_config.storage_amount_per_byte) >=
          BigInt(plan.initializer.policy.min_reserve_yocto),
        'TREASURY_RESERVE_TOO_LOW',
      );
    }
    completed.push({
      role: group.role,
      accountId: group.receiverId,
      amountYocto: account.amount,
      storageBytes: account.storage_usage,
      codeHash: account.code_hash,
    });
  }
  const stillRequired = remaining.reduce((sum, group) => sum + BigInt(group.fundingYocto), 0n);
  const fundingAccount =
    fundingAccountId === ROOT
      ? owner
      : await rpc('query', {
          request_type: 'view_account',
          finality: 'final',
          account_id: fundingAccountId,
        });
  assert.ok(fundingAccount, 'DEPLOYMENT_ACCOUNT_NOT_FUNDED');
  const spendableFunding =
    BigInt(fundingAccount.amount) -
    BigInt(fundingAccount.storage_usage) * BigInt(protocol.runtime_config.storage_amount_per_byte);
  const remainingGasReserve = (gasReserve * BigInt(remaining.length)) / BigInt(plan.groups.length);
  assert.ok(
    spendableFunding >= stillRequired + remainingGasReserve + minimumFundingBalance,
    'OWNER_REMAINING_BALANCE_TOO_LOW',
  );
  if (fundingAccountId !== ROOT)
    assert.ok(BigInt(owner.amount) >= OWNER_MINIMUM, 'METEOR_OWNER_RESERVE_TOO_LOW');
  return {
    checkedAt: new Date().toISOString(),
    ownerBalanceYocto: owner.amount,
    gasPriceYocto: gas.gas_price,
    completed,
    remainingRoles: remaining.map((group) => group.role),
    transactions: remaining,
    ready: remaining.length > 0,
    fullyDeployed: remaining.length === 0,
    paidInferenceRequests: 0,
    signingRequestsSubmittedByServer: 0,
  };
}
