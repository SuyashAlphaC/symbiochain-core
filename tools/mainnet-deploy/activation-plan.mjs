import assert from 'node:assert/strict';
import { UNIT, ROOT, WASM_SHA256, planDigest } from './plan.mjs';
export const OWNER = 'symbio-fcef733893.near';
export const TREASURY = 'treasury.' + OWNER;
export const FEE_CEILING = UNIT / 100n;
export const OWNER_GAS_RESERVE = UNIT / 50n;
export const INTENTS_ALLOWANCE = UNIT / 200n;
const call = (methodName, args, gas = '10000000000000', deposit = '0') => ({
  type: 'FunctionCall',
  params: { methodName, args, gas, deposit },
});
export function makeActivationPlan(publicKeys) {
  for (const k of Object.values(publicKeys))
    assert.match(k, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.deepEqual(Object.keys(publicKeys).sort(), ['brain', 'hand']);
  assert.notEqual(publicKeys.brain, publicKeys.hand);
  const policy = {
    max_trade_atoms: '50000',
    max_daily_atoms: '100000',
    min_reserve_yocto: (UNIT / 10n).toString(),
    max_signing_cost_yocto: '1',
    max_slippage_bps: 0,
    allowed_chain_ids: [8453],
    allowed_token_contracts: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    token_max_trade_atoms: ['50000'],
    token_max_daily_atoms: ['100000'],
  };
  const transactions = [];
  for (const role of ['brain', 'hand']) {
    const id = role + '.' + OWNER;
    transactions.push({
      id: role + '_key',
      signerId: id,
      receiverId: id,
      actions: [
        {
          type: 'AddKey',
          params: {
            publicKey: publicKeys[role],
            accessKey: {
              permission: {
                receiverId: 'intents.near',
                methodNames: ['execute_intents'],
                allowance: INTENTS_ALLOWANCE.toString(),
              },
            },
          },
        },
      ],
    });
    transactions.push({
      id: role + '_register',
      signerId: id,
      receiverId: 'intents.near',
      actions: [call('add_public_key', { public_key: publicKeys[role] }, '20000000000000', '1')],
    });
  }
  transactions.push({
    id: 'owner_gas_reserve',
    signerId: OWNER,
    receiverId: TREASURY,
    actions: [
      call('withdraw_funds', { amount: OWNER_GAS_RESERVE.toString() }, '5000000000000', '0'),
    ],
  });
  transactions.push({
    id: 'activate',
    signerId: OWNER,
    receiverId: TREASURY,
    actions: [
      call('set_policy', { policy }, '5000000000000'),
      ...['brain', 'hand', 'books'].map((name) =>
        call('set_worker_enabled', { worker: name + '.' + OWNER, enabled: true }, '5000000000000'),
      ),
      call('set_paused', { paused: false }, '5000000000000'),
    ],
  });
  transactions.push({
    id: 'owner_probe',
    signerId: OWNER,
    receiverId: TREASURY,
    actions: [call('fund', {}, '10000000000000', '0')],
  });
  const plan = {
    contractVersion: 1,
    network: 'mainnet',
    profile: 'BOUNDED_OWNER_ACTIVATION_TEE_QUARANTINED',
    root: ROOT,
    owner: OWNER,
    treasury: TREASURY,
    wasmSha256: WASM_SHA256,
    feeAndStoragePlanningCeilingYocto: FEE_CEILING.toString(),
    ownerGasReserveReallocationYocto: OWNER_GAS_RESERVE.toString(),
    totalPlanningCeilingYocto: (FEE_CEILING + OWNER_GAS_RESERVE).toString(),
    perTransactionFeeAllowanceYocto: (UNIT / 100n).toString(),
    newTreasuryCapitalYocto: '0',
    intentsPublicKeys: publicKeys,
    policy,
    transactions,
    disclosure: {
      tradeAsset: 'USDC',
      tradeDecimals: 6,
      universalNativeSpendingCap: false,
      executionEngineEnabled: false,
      paidInferenceAllowed: false,
      automaticTradingAllowed: false,
      externalRevenueProven: false,
      automaticCreditPurchaseImplemented: false,
      intentsKeysAuthorizeThatAgentsIntentsBalances: true,
      ownerCustodyUnchanged: true,
    },
  };
  return { ...plan, digest: planDigest(plan) };
}
export function verifyActivationReceipt(raw, hash, transaction, perFee = UNIT / 100n) {
  assert.equal(raw.final_execution_status, 'FINAL', 'TRANSACTION_NOT_FINAL');
  const tx = raw.transaction;
  assert.equal(tx.hash, hash, 'HASH_MISMATCH');
  assert.equal(tx.signer_id, transaction.signerId, 'SIGNER_MISMATCH');
  assert.equal(tx.receiver_id, transaction.receiverId, 'RECEIVER_MISMATCH');
  assert.equal(tx.actions.length, transaction.actions.length, 'EXTRA_ACTIONS');
  for (let i = 0; i < transaction.actions.length; i++) {
    const expected = transaction.actions[i],
      actual = tx.actions[i];
    if (expected.type === 'FunctionCall') {
      const a = actual.FunctionCall,
        p = expected.params;
      assert.ok(a, 'FUNCTION_CALL_REQUIRED');
      assert.equal(a.method_name, p.methodName, 'METHOD_MISMATCH');
      assert.equal(String(a.deposit), p.deposit, 'DEPOSIT_MISMATCH');
      assert.equal(String(a.gas), p.gas, 'GAS_MISMATCH');
      assert.deepEqual(
        JSON.parse(Buffer.from(a.args, 'base64').toString()),
        p.args,
        'ARGUMENT_MISMATCH',
      );
    } else if (expected.type === 'Transfer') {
      assert.equal(String(actual.Transfer?.deposit), expected.params.deposit, 'TRANSFER_MISMATCH');
    } else if (expected.type === 'DeleteKey') {
      assert.equal(actual.DeleteKey?.public_key, expected.params.publicKey, 'KEY_MISMATCH');
    } else {
      assert.equal(expected.type, 'AddKey', 'UNEXPECTED_ACTION');
      const a = actual.AddKey,
        p = expected.params;
      assert.ok(a, 'ADD_KEY_REQUIRED');
      assert.equal(a.public_key, p.publicKey, 'KEY_MISMATCH');
      const f = a.access_key.permission.FunctionCall;
      assert.ok(f, 'FULL_ACCESS_FORBIDDEN');
      assert.equal(f.receiver_id, p.accessKey.permission.receiverId, 'KEY_RECEIVER_MISMATCH');
      assert.deepEqual(f.method_names, p.accessKey.permission.methodNames, 'KEY_METHOD_MISMATCH');
      assert.equal(
        String(f.allowance),
        String(p.accessKey.permission.allowance),
        'KEY_ALLOWANCE_MISMATCH',
      );
    }
  }
  const success = (s) => s && ('SuccessValue' in s || 'SuccessReceiptId' in s);
  const outcomes = [raw.transaction_outcome, ...raw.receipts_outcome];
  assert.ok(
    success(raw.status) && outcomes.length > 1 && outcomes.every((r) => success(r.outcome.status)),
    'RECEIPT_FAILED',
  );
  const fee = outcomes.reduce((s, r) => s + BigInt(r.outcome.tokens_burnt), 0n);
  assert.ok(fee <= perFee, 'FEE_ALLOWANCE_EXCEEDED');
  return {
    hash,
    step: transaction.id,
    signerId: tx.signer_id,
    receiverId: tx.receiver_id,
    actualFeeYocto: fee.toString(),
    blockHash: raw.transaction_outcome.block_hash,
    final: true,
    succeeded: true,
    url: 'https://nearblocks.io/txns/' + hash,
  };
}
