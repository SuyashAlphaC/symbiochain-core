import assert from 'node:assert/strict';
import { ROOT, UNIT, planDigest } from './plan.mjs';
import { TREASURY } from './funding-plan.mjs';
export const SERVICE_DEPOSIT = UNIT / 500n;
export const SERVICE_FEE_ALLOWANCE = UNIT / 100n;
export const serviceGas = { deposit: '10000000000000', withdraw: '30000000000000' };
export function serviceTransaction(step, credit = '0') {
  assert.ok(['deposit', 'withdraw'].includes(step), 'INVALID_STEP');
  if (step === 'withdraw')
    assert.ok(BigInt(credit) > 0n && BigInt(credit) <= SERVICE_DEPOSIT, 'INVALID_CREDIT');
  return {
    signerId: ROOT,
    receiverId: TREASURY,
    actions: [
      {
        type: 'FunctionCall',
        params: {
          methodName: step === 'deposit' ? 'fund_services' : 'withdraw_service_balance',
          args: step === 'deposit' ? {} : { amount: credit },
          gas: serviceGas[step],
          deposit: step === 'deposit' ? SERVICE_DEPOSIT.toString() : '0',
        },
      },
    ],
  };
}
export const serviceDigest = (step, credit) => planDigest(serviceTransaction(step, credit));
export function verifyServiceReceipt(tx, hash, step, credit) {
  const expected = serviceTransaction(step, credit),
    p = expected.actions[0].params;
  const success = (s) => s && !('Failure' in s) && ('SuccessValue' in s || 'SuccessReceiptId' in s);
  assert.equal(tx.final_execution_status, 'FINAL', 'FINALITY_REQUIRED');
  assert.equal(tx.transaction.hash, hash, 'WRONG_HASH');
  assert.equal(tx.transaction.signer_id, ROOT, 'WRONG_SIGNER');
  assert.equal(tx.transaction.receiver_id, TREASURY, 'WRONG_RECEIVER');
  assert.equal(tx.transaction.actions.length, 1, 'EXTRA_ACTIONS');
  const call = tx.transaction.actions[0].FunctionCall;
  assert.ok(call, 'FUNCTION_CALL_REQUIRED');
  assert.equal(call.method_name, p.methodName, 'WRONG_METHOD');
  assert.equal(String(call.deposit), p.deposit, 'WRONG_DEPOSIT');
  assert.equal(String(call.gas), p.gas, 'WRONG_GAS');
  assert.deepEqual(JSON.parse(Buffer.from(call.args, 'base64').toString()), p.args, 'WRONG_ARGS');
  const outcomes = [tx.transaction_outcome, ...tx.receipts_outcome];
  assert.ok(
    success(tx.status) && outcomes.length > 1 && outcomes.every((o) => success(o.outcome.status)),
    'RECEIPT_FAILED',
  );
  if (step === 'withdraw')
    assert.equal(
      Buffer.from(tx.status.SuccessValue ?? '', 'base64').toString(),
      'true',
      'PAYOUT_CALLBACK_NOT_SUCCESSFUL',
    );
  const fee = outcomes.reduce((n, o) => n + BigInt(o.outcome.tokens_burnt), 0n);
  assert.ok(fee >= 0n && fee <= SERVICE_FEE_ALLOWANCE, 'FEE_ALLOWANCE_EXCEEDED');
  return {
    hash,
    step,
    signerId: ROOT,
    receiverId: TREASURY,
    method: p.methodName,
    attachedYocto: p.deposit,
    withdrawalYocto: step === 'withdraw' ? credit : '0',
    actualFeeYocto: fee.toString(),
    blockHash: tx.transaction_outcome.block_hash,
    final: true,
    succeeded: true,
    url: `https://nearblocks.io/txns/${hash}`,
  };
}
