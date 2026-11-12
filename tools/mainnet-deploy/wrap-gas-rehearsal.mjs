import { Worker } from 'near-workspaces';
import { rpc } from './plan.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Account, JsonRpcProvider, actions } from './near-actions.mjs';
process.env.NEAR_SANDBOX_BIN_PATH = '1';
process.env.NEAR_SANDBOX_BINARY_PATH = resolve('.data/bin/Linux-x86_64');
const observed = await rpc('query', {
  request_type: 'view_code',
  finality: 'final',
  account_id: 'wrap.near',
});
assert.equal(observed.hash, 'DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1', 'WRAP_CODE_CHANGED');
const wrapWasm = Buffer.from(observed.code_base64, 'base64');
const w = await Worker.init();
try {
  const root = w.rootAccount,
    wrap = await root.createSubAccount('wrap', { initialBalance: '3000000000000000000000000' }),
    receiver = await root.createSubAccount('receiver', {
      initialBalance: '2000000000000000000000000',
    });
  await wrap.deploy(wrapWasm);
  await wrap.call(wrap, 'new', {});
  await receiver.deploy(
    await readFile(
      'contracts/treasury/target/wasm32-unknown-unknown/release/symbiochain_mpc_mock.wasm',
    ),
  );
  await root.call(
    wrap,
    'storage_deposit',
    { account_id: receiver.accountId, registration_only: true },
    { attachedDeposit: '1250000000000000000000' },
  );
  const p = new JsonRpcProvider({ url: w.provider.connection.url });
  const a = new Account(root.accountId, p, (await root.getKey()).toString());
  const tx = (gas) => ({
    receiverId: wrap.accountId,
    actions: [
      actions.functionCall(
        'storage_deposit',
        { account_id: root.accountId, registration_only: true },
        10000000000000n,
        1250000000000000000000n,
      ),
      actions.functionCall('near_deposit', {}, 5000000000000n, 2000000000000000000000n),
      ...['brain', 'hand'].map((msg) =>
        actions.functionCall(
          'ft_transfer_call',
          { receiver_id: receiver.accountId, amount: '1000000000000000000000', msg },
          gas,
          1n,
        ),
      ),
    ],
    waitUntil: 'FINAL',
    throwOnFailure: false,
    retries: 0,
  });
  const failed = await a.signAndSendTransaction(tx(30000000000000n));
  assert.ok(failed.status.Failure);
  assert.ok(JSON.stringify(failed.status).includes('FunctionCallZeroAttachedGas'));
  const succeeded = await a.signAndSendTransaction(tx(70000000000000n));
  assert.ok(succeeded.status.SuccessValue !== undefined);
  assert.ok(
    [succeeded.transaction_outcome, ...succeeded.receipts_outcome].every(
      (r) => !r.outcome.status.Failure,
    ),
  );
  const balance = await wrap.view('ft_balance_of', { account_id: receiver.accountId });
  assert.equal(balance, '2000000000000000000000');
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_SANDBOX_WITH_OBSERVED_MAINNET_WRAP_CODE',
    mainnetWrapCodeHash: 'DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1',
    receiver: 'SANDBOX_MOCK_NOT_INTENTS',
    originalTransferGas: '30000000000000',
    originalFailureReproduced: true,
    correctedTransferGas: '70000000000000',
    correctedBatchSucceeded: true,
    twoTransfersCredited: true,
    mainnetTransactionsSubmitted: 0,
    paidInferenceRequests: 0,
  };
  await writeFile(
    'artifacts/mainnet-wrap-gas-rehearsal.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(report);
} finally {
  await w.tearDown();
}
