/** One controlled mainnet payment per agent. This never runs inside the AI engine. */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Account, JsonRpcProvider, KeyPair, SignedTransaction, actions } = require('near-api-js');
const { signMessage } = require('near-api-js/nep413');
import bs58 from 'bs58';
import { rpc, RPC, UNIT } from './plan.mjs';
import { BRAIN, HAND, SCOUT } from './intents-funding-plan.mjs';
import { intentsBalance } from './intents-funding-server.mjs';
import { verifyActivationReceipt } from './activation-plan.mjs';
const DIR = '.data/mainnet-intents-fixture/',
  AMOUNT = UNIT / 10000n,
  FEE = (35n * UNIT) / 10000n,
  GAS = 30000000000000n;
const sha = (b) => createHash('sha256').update(b).digest();
const optional = async (p) => {
  try {
    return JSON.parse(await readFile(p));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
async function view(method, args) {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: 'intents.near',
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}
async function main() {
  assert.equal(process.argv[2], '--execute', 'EXPLICIT_EXECUTION_FLAG_REQUIRED');
  const funding = JSON.parse(await readFile(DIR + 'funding/receipt.json'));
  assert.equal(funding.transaction.succeeded, true);
  assert.equal(funding.scope, 'CONTROLLED_INTERNAL_PAYMENT_FIXTURE');
  const done = await optional(DIR + 'complete.json');
  if (done) {
    console.log(
      JSON.stringify({
        status: 'ALREADY_COMPLETE',
        hashes: done.transactions.map((t) => t.hash),
        newTransactionsSubmitted: 0,
      }),
    );
    return;
  }
  const e = parse(await readFile('.env'));
  const provider = new JsonRpcProvider({ url: RPC });
  const steps = [
    { id: 'brain_pays_scout', payer: BRAIN, recipient: SCOUT, key: e.INTENTS_BRAIN_PRIVATE_KEY },
    { id: 'hand_pays_brain', payer: HAND, recipient: BRAIN, key: e.INTENTS_HAND_PRIVATE_KEY },
  ];
  const receipts = [];
  for (const step of steps) {
    const path = DIR + step.id;
    let record = await optional(path + '-complete.json');
    if (record) {
      receipts.push(record);
      continue;
    }
    const key = KeyPair.fromString(step.key);
    const publicKey = key.getPublicKey().toString();
    const [access, price] = await Promise.all([
      rpc('query', {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: step.payer,
        public_key: publicKey,
      }),
      rpc('gas_price', [null]),
    ]);
    const scope = access.permission.FunctionCall;
    assert.ok(scope, 'FULL_ACCESS_KEY_FORBIDDEN');
    assert.equal(scope.receiver_id, 'intents.near');
    assert.deepEqual(scope.method_names, ['execute_intents']);
    assert.ok(
      BigInt(scope.allowance) >= (GAS + 1000000000000n) * BigInt(price.gas_price),
      'KEY_ALLOWANCE_TOO_LOW',
    );
    assert.ok((GAS + 5000000000000n) * BigInt(price.gas_price) <= FEE, 'FEE_CEILING_EXCEEDED');
    assert.ok(
      await view('has_public_key', { account_id: step.payer, public_key: publicKey }),
      'KEY_NOT_REGISTERED',
    );
    let prepared = await optional(path + '-prepared.json');
    if (!prepared) {
      assert.ok(BigInt(await intentsBalance(step.payer)) >= AMOUNT, 'INTENTS_CAPITAL_REQUIRED');
      const salt = await view('current_salt', {});
      assert.match(salt, /^[a-f0-9]{8}$/i);
      const nonce = Buffer.concat([
        Buffer.from(salt, 'hex'),
        sha('symbio-mainnet-payment-fixture-v1:' + step.id).subarray(0, 28),
      ]);
      assert.equal(
        await view('is_nonce_used', { account_id: step.payer, nonce: nonce.toString('base64') }),
        false,
        'EXISTING_NONCE_REQUIRES_RECONCILIATION',
      );
      const message = JSON.stringify({
        signer_id: step.payer,
        deadline: new Date(Date.now() + 1200000).toISOString(),
        intents: [
          {
            intent: 'transfer',
            receiver_id: step.recipient,
            tokens: { 'nep141:wrap.near': AMOUNT.toString() },
            memo: 'SymbioChain controlled internal-payment fixture; no AI or external revenue',
          },
        ],
      });
      const account = new Account(step.payer, provider, step.key);
      const signature = await signMessage({
        signerAccount: account,
        payload: { message, nonce, recipient: 'intents.near' },
      });
      const intent = {
        standard: 'nep413',
        payload: { message, nonce: nonce.toString('base64'), recipient: 'intents.near' },
        public_key: signature.publicKey.toString(),
        signature: 'ed25519:' + bs58.encode(signature.signature),
      };
      const signed = await account.createSignedTransaction({
        receiverId: 'intents.near',
        actions: [actions.functionCall('execute_intents', { signed: [intent] }, GAS, 0n)],
      });
      prepared = {
        step: step.id,
        payer: step.payer,
        recipient: step.recipient,
        amountYocto: AMOUNT.toString(),
        intentNonce: nonce.toString('base64'),
        intent,
        txHash: bs58.encode(sha(signed.transaction.encode())),
        signedBase64: Buffer.from(signed.encode()).toString('base64'),
        before: {
          payer: await intentsBalance(step.payer),
          recipient: await intentsBalance(step.recipient),
        },
      };
      await writeFile(path + '-prepared.json', JSON.stringify(prepared), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    let attempted = await optional(path + '-attempt.json');
    const recoveryFile = path + '-known-rejection-recovery.json';
    let recovery = await optional(recoveryFile);
    if (
      !recovery &&
      attempted &&
      BigInt(access.nonce) >=
        BigInt(
          SignedTransaction.decode(Buffer.from(prepared.signedBase64, 'base64')).transaction.nonce,
        )
    ) {
      const repair = await optional(
        DIR + 'key-repair/' + (step.payer === BRAIN ? 'brain' : 'hand') + '/receipt.json',
      );
      const rejected = await optional(path + '-rebroadcast-result.json');
      const allowanceError =
        rejected?.error?.data?.TxExecutionError?.InvalidTxError?.InvalidAccessKeyError
          ?.NotEnoughAllowance;
      assert.ok(
        repair?.transaction.succeeded && allowanceError,
        'KNOWN_PREINCLUSION_REJECTION_REQUIRED',
      );
      assert.equal(allowanceError.public_key, publicKey);
      assert.equal(
        await view('is_nonce_used', { account_id: step.payer, nonce: prepared.intentNonce }),
        false,
        'EXISTING_INTENT_ALREADY_USED',
      );
      const account = new Account(step.payer, provider, step.key);
      let intent = prepared.intent;
      const message = JSON.parse(intent.payload.message);
      assert.equal(message.signer_id, step.payer);
      assert.equal(message.intents.length, 1);
      assert.equal(message.intents[0].receiver_id, step.recipient);
      assert.equal(message.intents[0].tokens['nep141:wrap.near'], AMOUNT.toString());
      const deadlineRenewed = Date.parse(message.deadline) <= Date.now();
      if (deadlineRenewed) {
        message.deadline = new Date(Date.now() + 1200000).toISOString();
        const payload = { ...intent.payload, message: JSON.stringify(message) };
        const signed = await signMessage({
          signerAccount: account,
          payload: { ...payload, nonce: Buffer.from(prepared.intentNonce, 'base64') },
        });
        intent = { ...intent, payload, signature: 'ed25519:' + bs58.encode(signed.signature) };
      }
      const signed = await account.createSignedTransaction({
        receiverId: 'intents.near',
        actions: [actions.functionCall('execute_intents', { signed: [intent] }, GAS, 0n)],
      });
      const updated = {
        ...prepared,
        intent,
        txHash: bs58.encode(sha(signed.transaction.encode())),
        signedBase64: Buffer.from(signed.encode()).toString('base64'),
      };
      recovery = {
        at: new Date().toISOString(),
        reason: 'CONFIRMED_NOT_ENOUGH_ALLOWANCE_BEFORE_INCLUSION',
        oldHash: prepared.txHash,
        oldEnvelopeInvalidatedByKeyNonce: String(access.nonce),
        sameEconomicTerms: true,
        sameIntentNonce: true,
        deadlineRenewed,
        updated,
      };
      await writeFile(recoveryFile, JSON.stringify(recovery), { flag: 'wx', mode: 0o600 });
    }
    if (
      recovery &&
      (prepared.txHash !== recovery.updated.txHash || attempted?.txHash === recovery.oldHash)
    ) {
      if (prepared.txHash !== recovery.updated.txHash) {
        await writeFile(path + '-pre-repair-envelope.json', JSON.stringify(prepared), {
          mode: 0o600,
        });
        await writeFile(path + '-prepared.json', JSON.stringify(recovery.updated), { mode: 0o600 });
      }
      if (attempted?.txHash === recovery.oldHash)
        await rename(path + '-attempt.json', path + '-pre-repair-attempt.json');
      prepared = recovery.updated;
      attempted = null;
    }

    if (!attempted) {
      assert.equal(
        await view('is_nonce_used', { account_id: step.payer, nonce: prepared.intentNonce }),
        false,
        'NONCE_ALREADY_USED',
      );
      await writeFile(
        path + '-attempt.json',
        JSON.stringify({
          at: new Date().toISOString(),
          txHash: prepared.txHash,
          state: 'SUBMIT_ONCE_RECONCILE_EXISTING_IDENTITY',
        }),
        { flag: 'wx', mode: 0o600 },
      );
      await provider.sendTransactionUntil(
        SignedTransaction.decode(Buffer.from(prepared.signedBase64, 'base64')),
        'FINAL',
      );
    }
    const raw = await rpc(
      'tx',
      { tx_hash: prepared.txHash, sender_account_id: step.payer, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    );
    const transaction = verifyActivationReceipt(
      raw,
      prepared.txHash,
      {
        id: step.id,
        signerId: step.payer,
        receiverId: 'intents.near',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'execute_intents',
              args: { signed: [prepared.intent] },
              gas: GAS.toString(),
              deposit: '0',
            },
          },
        ],
      },
      FEE,
    );
    assert.equal(
      await view('is_nonce_used', { account_id: step.payer, nonce: prepared.intentNonce }),
      true,
      'NONCE_NOT_FINAL',
    );
    const b = (await rpc('block', { finality: 'final' })).header;
    const after = {
      payer: await intentsBalance(step.payer, b.hash),
      recipient: await intentsBalance(step.recipient, b.hash),
    };
    assert.equal(
      BigInt(prepared.before.payer) - BigInt(after.payer),
      AMOUNT,
      'PAYER_DEBIT_MISMATCH',
    );
    assert.equal(
      BigInt(after.recipient) - BigInt(prepared.before.recipient),
      AMOUNT,
      'RECIPIENT_CREDIT_MISMATCH',
    );
    record = {
      checkedAt: new Date().toISOString(),
      transaction,
      payer: step.payer,
      recipient: step.recipient,
      amountYocto: AMOUNT.toString(),
      asset: 'nep141:wrap.near',
      nonceConfirmed: true,
      before: prepared.before,
      after,
    };
    await writeFile(path + '-complete.json', JSON.stringify(record, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    receipts.push(record);
    console.log(
      JSON.stringify({
        completed: step.id,
        hash: transaction.hash,
        amountYocto: AMOUNT.toString(),
        feeYocto: transaction.actualFeeYocto,
      }),
    );
  }
  const failure = await optional(DIR + 'failed-funding-reconciliation.json');
  const failedFee = BigInt(failure?.feeYocto ?? '0');
  const repairs = [];
  for (const role of ['brain', 'hand']) {
    const repair = await optional(DIR + 'key-repair/' + role + '/receipt.json');
    if (repair) repairs.push(repair.transaction);
  }
  const fees =
    BigInt(funding.transaction.actualFeeYocto) +
    receipts.reduce((n, r) => n + BigInt(r.transaction.actualFeeYocto), failedFee) +
    repairs.reduce((n, r) => n + BigInt(r.actualFeeYocto), 0n);
  assert.ok(fees + 3250000000000000000000n <= (3n * UNIT) / 100n, 'TOTAL_FIXTURE_CEILING_EXCEEDED');
  const out = {
    checkedAt: new Date().toISOString(),
    scope: 'MAINNET_INTERNAL_INTENTS_SETTLEMENT_FIXTURE',
    network: 'mainnet',
    classification: 'TEAM_FUNDED_INTERNAL_TRANSFERS_NOT_REVENUE',
    funding: {
      hash: funding.transaction.hash,
      url: funding.transaction.url,
      capitalYocto: '2000000000000000000000',
      storageCollateralYocto: (
        BigInt(funding.before.ownerBalanceYocto) -
        BigInt(funding.after.ownerBalanceYocto) -
        BigInt(funding.transaction.actualFeeYocto) -
        BigInt(funding.capitalYocto) -
        2n
      ).toString(),
    },
    transactions: receipts.map((r) => r.transaction),
    payments: receipts.map(({ transaction, ...r }) => ({ ...r, hash: transaction.hash })),
    totalNetworkFeesIncludingFailedAttemptYocto: fees.toString(),
    failedFunding: failure ?? null,
    allowanceRepairs: repairs,
    capitalAndStoragePlanningCeilingYocto: '3250000000000000000000',
    totalPlanningCeilingYocto: ((3n * UNIT) / 100n).toString(),
    paidInferenceRequests: 0,
    teeApprovalClaimed: false,
    externalRevenueProven: false,
    marketSwapPerformed: false,
  };
  await writeFile(DIR + 'complete.json', JSON.stringify(out, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile('artifacts/mainnet-intents-settlement.json', JSON.stringify(out, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: 'COMPLETE',
      payments: 2,
      feeYocto: fees.toString(),
      externalRevenue: false,
      paidInferenceRequests: 0,
    }),
  );
}
await mkdir(DIR, { recursive: true, mode: 0o700 });
main().catch((e) => {
  console.error(
    JSON.stringify({
      status: 'HELD',
      code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'RECONCILE_EXISTING_IDENTITY_BEFORE_RETRY',
      privateKeyValuesPrinted: false,
    }),
  );
  process.exitCode = 1;
});
