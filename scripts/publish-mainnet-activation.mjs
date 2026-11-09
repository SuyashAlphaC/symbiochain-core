import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { MainnetActivationProof } from '../dist/mainnet-activation-contract.js';
import {
  makeActivationPlan,
  verifyActivationReceipt,
} from '../tools/mainnet-deploy/activation-plan.mjs';
import { rpc } from '../tools/mainnet-deploy/plan.mjs';
const plan = JSON.parse(await readFile('artifacts/mainnet-bounded-plan.json'));
assert.deepEqual(plan, makeActivationPlan(plan.intentsPublicKeys));
const transactions = [];
let storage = 0n;
for (const stage of plan.transactions) {
  let r;
  try {
    r = JSON.parse(await readFile('.data/mainnet-activation/operation/' + stage.id + '.json'));
  } catch (e) {
    if (e.code === 'ENOENT') break;
    throw e;
  }
  const tx = verifyActivationReceipt(
    await rpc(
      'tx',
      { tx_hash: r.transaction.hash, sender_account_id: stage.signerId, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    ),
    r.transaction.hash,
    stage,
  );
  assert.equal(tx.actualFeeYocto, r.transaction.actualFeeYocto, 'FEE_MISMATCH');
  assert.equal(r.treasuryTopupYocto, '0');
  assert.equal(r.paidInferenceRequests, 0);
  transactions.push({
    hash: tx.hash,
    step: stage.id,
    url: tx.url,
    actualFeeYocto: tx.actualFeeYocto,
  });
  storage += BigInt(r.storageIncreaseYocto);
}
const proof = MainnetActivationProof.parse({
  contractVersion: 1,
  profile: 'BOUNDED_OWNER_ACTIVATION_TEE_QUARANTINED',
  status:
    transactions.length === plan.transactions.length
      ? 'COMPLETE'
      : transactions.length
        ? 'PARTIAL'
        : 'PENDING',
  requiredTransactions: 7,
  checkedAt: transactions.length ? new Date().toISOString() : null,
  transactions,
  totalFeeYocto: transactions.reduce((n, t) => n + BigInt(t.actualFeeYocto), 0n).toString(),
  newStorageYocto: storage.toString(),
  ownerGasReserveReallocatedYocto: transactions.some((t) => t.step === 'owner_gas_reserve')
    ? plan.ownerGasReserveReallocationYocto
    : '0',
  treasuryTopupYocto: '0',
  paidInferenceRequests: 0,
  externalRevenueProven: false,
});
await writeFile('artifacts/mainnet-bounded-activation.json', JSON.stringify(proof, null, 2) + '\n');
console.log(
  JSON.stringify({
    status: proof.status,
    verifiedReceipts: proof.transactions.length,
    totalFeeYocto: proof.totalFeeYocto,
    newStorageYocto: proof.newStorageYocto,
    treasuryTopupYocto: '0',
    paidInferenceRequests: 0,
  }),
);
