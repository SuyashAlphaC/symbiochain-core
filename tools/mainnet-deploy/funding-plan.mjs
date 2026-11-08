import assert from 'node:assert/strict';
import { ROOT, UNIT, WASM_SHA256, planDigest } from './plan.mjs';

export const TREASURY = 'treasury.symbio-fcef733893.near';
export const DEPOSIT = UNIT / 1000n;
export const FEE_ALLOWANCE = (UNIT * 3n) / 1000n;
export const GAS = 10_000_000_000_000n;
export const fundingPlan = Object.freeze({
  network: 'mainnet',
  classification: 'TEAM_FUNDED_TREASURY_CAPITAL_NOT_REVENUE',
  expectedWasmSha256: WASM_SHA256,
  feeAllowanceYocto: FEE_ALLOWANCE.toString(),
  planningCeilingYocto: (DEPOSIT + FEE_ALLOWANCE).toString(),
  transaction: {
    signerId: ROOT,
    receiverId: TREASURY,
    actions: [
      {
        type: 'FunctionCall',
        params: { methodName: 'fund', args: {}, gas: GAS.toString(), deposit: DEPOSIT.toString() },
      },
    ],
  },
});
export const fundingDigest = planDigest(fundingPlan);

export function validatePreflight({ snapshot, wallet, runtime, gasPrice }) {
  assert.equal(runtime.mode, 'LIVE', 'LIVE_OBSERVER_REQUIRED');
  assert.equal(runtime.network, 'mainnet', 'MAINNET_REQUIRED');
  assert.equal(runtime.executionEnabled, false, 'EXECUTION_MUST_REMAIN_DISARMED');
  assert.equal(snapshot.treasuryAccount, TREASURY, 'TREASURY_CHANGED');
  assert.equal(snapshot.paused, true, 'TREASURY_MUST_REMAIN_PAUSED');
  assert.equal(snapshot.code.matches, true, 'CODE_CHANGED');
  assert.equal(snapshot.deployment.temporaryKeyRevoked, true, 'DEPLOYMENT_KEY_NOT_REVOKED');
  const workers = snapshot.accounts.filter((a) => a.workerEnabled !== null);
  assert.equal(workers.length, 3, 'WORKER_STATE_MISSING');
  assert.ok(
    workers.every((a) => a.workerEnabled === false),
    'WORKERS_MUST_REMAIN_DISABLED',
  );
  assert.equal(wallet.accountId, ROOT, 'WRONG_WALLET');
  // A conservative planning estimate, not a protocol-level maximum gas-price field.
  const estimatedFee = (GAS + 3_000_000_000_000n) * BigInt(gasPrice) * 2n;
  assert.ok(estimatedFee > 0n && estimatedFee <= FEE_ALLOWANCE, 'GAS_ESTIMATE_EXCEEDS_ALLOWANCE');
  assert.ok(
    BigInt(wallet.availableYocto) >= DEPOSIT + FEE_ALLOWANCE + UNIT / 20n,
    'OWNER_RESERVE_TOO_LOW',
  );
  return {
    estimatedFeeYocto: estimatedFee.toString(),
    block: snapshot.block,
    treasuryBalanceYocto: snapshot.accounts.find((a) => a.role === 'TREASURY').balanceYocto,
  };
}

export function verifyFundingReceipt(tx, hash) {
  const success = (s) => s && !('Failure' in s) && ('SuccessValue' in s || 'SuccessReceiptId' in s);
  assert.equal(tx.final_execution_status, 'FINAL', 'FINALITY_REQUIRED');
  assert.equal(tx.transaction.hash, hash, 'TRANSACTION_HASH_CHANGED');
  assert.ok(typeof tx.transaction_outcome.block_hash === 'string', 'BLOCK_ID_REQUIRED');
  assert.equal(tx.transaction.signer_id, ROOT, 'WRONG_SIGNER');
  assert.equal(tx.transaction.receiver_id, TREASURY, 'WRONG_RECEIVER');
  assert.equal(tx.transaction.actions.length, 1, 'EXTRA_ACTIONS');
  const call = tx.transaction.actions[0].FunctionCall;
  assert.ok(call, 'FUNCTION_CALL_REQUIRED');
  assert.equal(call.method_name, 'fund', 'WRONG_METHOD');
  assert.equal(String(call.deposit), DEPOSIT.toString(), 'WRONG_DEPOSIT');
  assert.equal(String(call.gas), GAS.toString(), 'GAS_CHANGED');
  assert.deepEqual(JSON.parse(Buffer.from(call.args, 'base64').toString()), {}, 'ARGS_CHANGED');
  const outcomes = [tx.transaction_outcome, ...tx.receipts_outcome];
  assert.ok(
    success(tx.status) && outcomes.length > 1 && outcomes.every((o) => success(o.outcome.status)),
    'RECEIPT_FAILED',
  );
  const funded = tx.receipts_outcome.some(
    (o) =>
      o.outcome.executor_id === TREASURY &&
      o.outcome.logs.some((line) => {
        if (!line.startsWith('EVENT_JSON:')) return false;
        try {
          const event = JSON.parse(line.slice(11));
          return (
            event.standard === 'symbiochain' &&
            event.event === 'funded' &&
            event.data?.[0]?.amount === DEPOSIT.toString()
          );
        } catch {
          return false;
        }
      }),
  );
  assert.ok(funded, 'FUNDED_EVENT_MISSING');
  const fee = outcomes.reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n);
  assert.ok(fee >= 0n && fee <= FEE_ALLOWANCE, 'ACTUAL_FEE_EXCEEDS_ALLOWANCE');
  return {
    hash,
    blockHash: tx.transaction_outcome.block_hash,
    signerId: ROOT,
    receiverId: TREASURY,
    method: 'fund',
    depositYocto: DEPOSIT.toString(),
    actualFeeYocto: fee.toString(),
    classification: fundingPlan.classification,
    final: true,
    succeeded: true,
    url: `https://nearblocks.io/txns/${hash}`,
  };
}
