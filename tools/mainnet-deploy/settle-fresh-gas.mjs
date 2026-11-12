/** Two explicitly authorized owner-capital conversions. Fresh quotes follow confirmed funding. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse } from 'dotenv';
import bs58 from 'bs58';
import { quoteHash } from '@defuse-protocol/one-click-sdk-typescript';
import { loadConfig } from '../../dist/config.js';
import { OneClickClient } from '../../dist/providers/oneclick.js';
import { ChainWallets } from '../../dist/providers/wallets.js';
import { rpc } from './plan.mjs';
import { verifyActivationReceipt } from './activation-plan.mjs';
import { intentsBalance } from './intents-funding-server.mjs';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { Account, JsonRpcProvider, SignedTransaction, actions, KeyPair } = require('near-api-js');
const { signMessage } = require('near-api-js/nep413');
const DIR = '.data/mainnet-fresh-gas-funding/',
  AMOUNT = '50000000000000000000000';
const hash = (b) => createHash('sha256').update(b).digest();
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
  assert.equal(process.argv[2], '--execute', 'EXPLICIT_EXECUTION_REQUIRED');
  const funding = JSON.parse(await readFile(DIR + 'receipt.json'));
  assert.equal(funding.scope, 'REFUNDED_CAPITAL_FOR_FRESH_GAS_QUOTES');
  assert.equal(funding.transaction.succeeded, true);
  const e = parse(await readFile('.env', 'utf8')),
    c = loadConfig(e);
  assert.equal(c.EXECUTION_MODE, 'LIVE');
  assert.equal(c.EXECUTION_ENABLED, false);
  const one = new OneClickClient(c),
    wallets = new ChainWallets(c),
    provider = new JsonRpcProvider({ url: c.NEAR_RPC_URL });
  const evm = await wallets.address('eip155:8453'),
    sol = await wallets.address('solana:mainnet');
  assert.equal(evm, '0xE9464975ECAFa3e27AC1048C16a3406395061092');
  assert.equal(sol, 'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f');
  const rows = [
      {
        id: 'base_eth',
        payer: 'brain.symbio-fcef733893.near',
        key: e.INTENTS_BRAIN_PRIVATE_KEY,
        asset: 'nep141:base.omft.near',
        recipient: evm,
        minimum: 50000000000000n,
      },
      {
        id: 'sol_gas',
        payer: 'hand.symbio-fcef733893.near',
        key: e.INTENTS_HAND_PRIVATE_KEY,
        asset: 'nep141:sol.omft.near',
        recipient: sol,
        minimum: 1500000n,
      },
    ],
    results = [];
  for (const row of rows) {
    const path = DIR + row.id;
    let done = await optional(path + '-complete.json');
    if (done) {
      results.push(done);
      continue;
    }
    let p = await optional(path + '-prepared.json');
    if (!p) {
      assert.ok(
        BigInt(await intentsBalance(row.payer)) >= BigInt(AMOUNT),
        'FUNDED_INTENTS_BALANCE_REQUIRED',
      );
      const key = KeyPair.fromString(row.key),
        access = await rpc('query', {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: row.payer,
          public_key: key.getPublicKey().toString(),
        });
      assert.equal(access.permission.FunctionCall.receiver_id, 'intents.near');
      assert.deepEqual(access.permission.FunctionCall.method_names, ['execute_intents']);
      assert.ok(
        BigInt(access.permission.FunctionCall.allowance) >= 35000000000000000000000n,
        'FINITE_ALLOWANCE_TOO_LOW',
      );
      assert.ok(
        await view('has_public_key', {
          account_id: row.payer,
          public_key: key.getPublicKey().toString(),
        }),
      );
      const quote = await one.quote(
        {
          originAsset: 'nep141:wrap.near',
          destinationAsset: row.asset,
          amount: AMOUNT,
          recipient: row.recipient,
          refundTo: row.payer,
          deadline: new Date(Date.now() + 600000).toISOString(),
          slippageBps: 50,
        },
        false,
        'INTENTS_TO_CHAIN',
      );
      assert.ok(BigInt(quote.quote.minAmountOut) >= row.minimum, 'GAS_OUTPUT_FLOOR');
      assert.ok(
        Date.parse(quote.quoteRequest.deadline) > Date.now() + 90000,
        'SPEND_DEADLINE_EXPIRED',
      );
      const salt = await view('current_salt', {});
      assert.match(salt, /^[a-f0-9]{8}$/i);
      const nonce = Buffer.concat([
        Buffer.from(salt, 'hex'),
        hash('symbio-owned-gas:' + funding.transaction.hash + ':' + row.id).subarray(0, 28),
      ]);
      assert.equal(
        await view('is_nonce_used', { account_id: row.payer, nonce: nonce.toString('base64') }),
        false,
      );
      const message = JSON.stringify({
        signer_id: row.payer,
        deadline: quote.quoteRequest.deadline,
        intents: [
          {
            intent: 'transfer',
            receiver_id: quote.quote.depositAddress,
            tokens: { 'nep141:wrap.near': AMOUNT },
            memo: 'Owner-funded gas provisioning; no AI or business revenue',
          },
        ],
      });
      const account = new Account(row.payer, provider, row.key),
        signature = await signMessage({
          signerAccount: account,
          payload: { message, nonce, recipient: 'intents.near' },
        }),
        intent = {
          standard: 'nep413',
          payload: { message, nonce: nonce.toString('base64'), recipient: 'intents.near' },
          public_key: signature.publicKey.toString(),
          signature: 'ed25519:' + bs58.encode(signature.signature),
        };
      const signed = await account.createSignedTransaction({
        receiverId: 'intents.near',
        actions: [
          actions.functionCall('execute_intents', { signed: [intent] }, 30000000000000n, 0n),
        ],
      });
      const head = await wallets.evm.getBlockNumber(),
        slot = await wallets.solana.getSlot('finalized');
      p = {
        quote,
        intent,
        txHash: bs58.encode(hash(signed.transaction.encode())),
        signedBase64: Buffer.from(signed.encode()).toString('base64'),
        before: {
          payer: await intentsBalance(row.payer),
          baseBlock: head.toString(),
          solSlot: String(slot),
          native: (
            await wallets.balance(
              row.id === 'base_eth' ? 'eip155:8453' : 'solana:mainnet',
              row.id === 'base_eth' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : 'sol:native',
            )
          ).toString(),
        },
      };
      if (row.id === 'base_eth')
        p.before.native = (await wallets.evm.getBalance({ address: evm })).toString();
      await writeFile(path + '-prepared.json', JSON.stringify(p), { mode: 0o600, flag: 'wx' });
    }
    if (!(await optional(path + '-attempt.json'))) {
      assert.ok(
        Date.parse(p.quote.quoteRequest.deadline) > Date.now() + 30000,
        'SPEND_DEADLINE_EXPIRED',
      );
      await writeFile(
        path + '-attempt.json',
        JSON.stringify({
          at: new Date().toISOString(),
          hash: p.txHash,
          state: 'RECONCILE_SAME_IDENTITY',
        }),
        { mode: 0o600, flag: 'wx' },
      );
      await provider.sendTransactionUntil(
        SignedTransaction.decode(Buffer.from(p.signedBase64, 'base64')),
        'FINAL',
      );
    }
    const raw = await rpc(
      'tx',
      { tx_hash: p.txHash, sender_account_id: row.payer, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    );
    const receipt = verifyActivationReceipt(
      raw,
      p.txHash,
      {
        id: row.id,
        signerId: row.payer,
        receiverId: 'intents.near',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'execute_intents',
              args: { signed: [p.intent] },
              gas: '30000000000000',
              deposit: '0',
            },
          },
        ],
      },
      1000000000000000000000n,
    );
    assert.equal(
      await view('is_nonce_used', { account_id: row.payer, nonce: p.intent.payload.nonce }),
      true,
    );
    await writeFile(path + '-receipt.json', JSON.stringify(receipt), { mode: 0o600 });
    let status;
    for (let i = 0; i < 30; i++) {
      status = await one.status(p.quote.quote.depositAddress);
      assert.equal(quoteHash(status.quoteResponse), quoteHash(p.quote), 'SIGNED_QUOTE_CHANGED');
      if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(status.status)) break;
      if (i % 6 === 0)
        console.log(JSON.stringify({ step: row.id, status: status.status, hash: p.txHash }));
      await new Promise((r) => setTimeout(r, 10000));
    }
    await writeFile(path + '-status.json', JSON.stringify(status), { mode: 0o600 });
    assert.equal(status.status, 'SUCCESS', 'FUNDING_NOT_SUCCESSFUL_RECONCILE_OR_RECOVER');
    assert.ok(BigInt(status.swapDetails.amountOut) >= BigInt(p.quote.quote.minAmountOut));
    const hashes = status.swapDetails.destinationChainTxHashes.map((t) => t.hash);
    assert.ok(hashes.length > 0);
    if (row.id === 'sol_gas') {
      const incoming = await wallets.verifyIncoming(
        'solana:mainnet',
        'sol:native',
        sol,
        status.swapDetails.amountOut,
        hashes,
        BigInt(p.before.solSlot),
      );
      assert.ok(incoming.verified, 'SOLANA_CREDIT_NOT_FINAL');
    } else {
      for (const h of hashes) {
        const r = await wallets.evm.getTransactionReceipt({ hash: h });
        assert.equal(r.status, 'success');
        assert.ok(
          (await wallets.evm.getBlockNumber()) - r.blockNumber + 1n >= BigInt(c.EVM_CONFIRMATIONS),
          'BASE_FINALITY_PENDING',
        );
      }
      assert.ok(
        (await wallets.evm.getBalance({ address: evm })) - BigInt(p.before.native) >=
          BigInt(status.swapDetails.amountOut),
        'BASE_ETH_CREDIT_NOT_OBSERVED',
      );
    }
    done = {
      checkedAt: new Date().toISOString(),
      asset: row.asset,
      payer: row.payer,
      recipient: row.recipient,
      amountInYocto: AMOUNT,
      amountOutAtoms: status.swapDetails.amountOut,
      nativeReceipt: receipt,
      destinationHashes: hashes,
      nonceConfirmed: true,
      quoteDigest: quoteHash(p.quote),
      status: 'SUCCESS',
    };
    await writeFile(path + '-complete.json', JSON.stringify(done, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    results.push(done);
    console.log(
      JSON.stringify({
        step: row.id,
        status: 'SUCCESS',
        amountOut: done.amountOutAtoms,
        hash: p.txHash,
      }),
    );
  }
  const proof = {
    checkedAt: new Date().toISOString(),
    scope: 'OWNER_FUNDED_MAINNET_GAS_WALLETS_VIA_INTENTS',
    network: 'mainnet',
    ownerFundingReceipt: funding.transaction,
    conversions: results,
    paidInferenceRequests: 0,
    teeApprovalClaimed: false,
    externalRevenueProven: false,
    profitProven: false,
  };
  await writeFile(DIR + 'complete.json', JSON.stringify(proof, null, 2), { mode: 0o600 });
  await writeFile(
    'artifacts/mainnet-fresh-gas-funding.json',
    JSON.stringify(proof, null, 2) + '\n',
  );
  console.log(JSON.stringify({ status: 'COMPLETE', walletsFunded: 2, paidInferenceRequests: 0 }));
}
await mkdir(DIR, { recursive: true, mode: 0o700 });
main().catch((e) => {
  console.error(
    JSON.stringify({
      status: 'HELD',
      code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'RECONCILE_EXISTING_FUNDING_IDENTITY',
      credentialValuesPrinted: false,
    }),
  );
  process.exitCode = 1;
});
