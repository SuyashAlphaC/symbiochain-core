/** Owner-authorized transfer fixtures only. No AI, market swap, profit or NFT claim. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse } from 'dotenv';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { loadConfig } from '../../dist/config.js';
import { ChainWallets } from '../../dist/providers/wallets.js';
import { MainnetReader } from '../../dist/mainnet.js';
import { matchesMainnetPolicy } from '../../dist/mainnet-activation.js';
import { rpc, UNIT } from './plan.mjs';
import { verifyActivationReceipt } from './activation-plan.mjs';
const { Account, JsonRpcProvider, SignedTransaction, actions, KeyPair } = createRequire(
  new URL('../../package.json', import.meta.url),
)('near-api-js');
const DIR = '.data/mainnet-owned-execution/';
const sha = (b) => createHash('sha256').update(b).digest(),
  digest = (x) => sha(JSON.stringify(x)).toString('hex');
const optional = async (p) => {
  try {
    return JSON.parse(await readFile(p));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
async function main() {
  assert.equal(
    process.argv[2],
    '--execute-controlled-fixtures',
    'EXPLICIT_CONTROLLED_EXECUTION_REQUIRED',
  );
  const c = loadConfig(parse(await readFile('.env', 'utf8')));
  assert.equal(c.EXECUTION_MODE, 'LIVE');
  assert.equal(c.NEAR_NETWORK, 'mainnet');
  assert.equal(c.EXECUTION_ENABLED, false);
  assert.equal(c.LIVE_ARBITRAGE_ENABLED, false);
  assert.equal(c.EVM_MAX_GAS, '100000');
  assert.equal(c.EVM_MAX_FEE_PER_GAS_WEI, '500000000');
  assert.equal(c.SOLANA_FEE_RESERVE_LAMPORTS, '1000000');
  const gasFunding = JSON.parse(await readFile('artifacts/mainnet-fresh-gas-funding.json'));
  assert.equal(gasFunding.conversions.length, 2);
  assert.ok(gasFunding.conversions.every((r) => r.status === 'SUCCESS'));
  const original = JSON.parse(await readFile('artifacts/mainnet-wallet-provisioning.json')),
    retry = JSON.parse(await readFile('.data/mainnet-gas-funding-retry/terminal.json'));
  const priorFees =
    BigInt(original.networkFeesYocto) +
    BigInt(retry.networkFeesYocto) +
    BigInt(gasFunding.ownerFundingReceipt.actualFeeYocto) +
    gasFunding.conversions.reduce((n, r) => n + BigInt(r.nativeReceipt.actualFeeYocto), 0n);
  assert.ok(
    450000000000000000000000n + priorFees + 8000000000000000000000n <= UNIT / 2n,
    'ADDITIONAL_BUDGET_EXHAUSTED',
  );
  const reader = new MainnetReader(c),
    snap = await reader.snapshot(),
    policy = await reader.activationPolicy(snap.block.hash);
  assert.ok(snap.code.matches && !snap.paused);
  assert.ok(matchesMainnetPolicy(c, policy));
  const manifest = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json'));
  const wallets = new ChainWallets(c),
    base = await wallets.address('eip155:8453'),
    sol = await wallets.address('solana:mainnet');
  assert.equal(base, '0xE9464975ECAFa3e27AC1048C16a3406395061092');
  assert.equal(sol, 'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f');
  const scoutWallets = new ChainWallets({ ...c, NEAR_CONTRACT_ID: c.NEAR_SCOUT_ACCOUNT_ID }),
    solRecipient = await scoutWallets.address('solana:mainnet');
  const custody = await rpc('query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: c.NEAR_SCOUT_ACCOUNT_ID,
  });
  assert.deepEqual(
    custody.keys.filter((k) => k.access_key.permission === 'FullAccess').map((k) => k.public_key),
    [manifest.recoveryPublicKey],
  );
  const roles = {
      BRAIN: { id: c.NEAR_BRAIN_ACCOUNT_ID, key: c.NEAR_BRAIN_PRIVATE_KEY },
      HAND: { id: c.NEAR_WORKER_ACCOUNT_ID, key: c.NEAR_WORKER_PRIVATE_KEY },
      ACCOUNTANT: { id: c.NEAR_ACCOUNTANT_ACCOUNT_ID, key: c.NEAR_ACCOUNTANT_PRIVATE_KEY },
    },
    provider = new JsonRpcProvider({ url: c.NEAR_RPC_URL });
  async function viewCycle(id) {
    const r = await rpc('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: c.NEAR_CONTRACT_ID,
      method_name: 'get_cycle',
      args_base64: Buffer.from(JSON.stringify({ cycle_id: id })).toString('base64'),
    });
    return JSON.parse(Buffer.from(r.result).toString());
  }
  async function call(id, role, method, args, gas) {
    const path = DIR + id + '-' + method,
      actor = roles[role];
    let saved = await optional(path + '-receipt.json');
    if (saved) return saved;
    let prepared = await optional(path + '-prepared.json');
    if (!prepared) {
      const key = KeyPair.fromString(actor.key),
        access = await rpc('query', {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: actor.id,
          public_key: key.getPublicKey().toString(),
        }),
        scope = access.permission.FunctionCall;
      assert.ok(scope && scope.allowance);
      assert.equal(scope.receiver_id, c.NEAR_CONTRACT_ID);
      assert.ok(scope.method_names.includes(method));
      assert.ok(
        BigInt(scope.allowance) >= (gas + 2000000000000n) * 1000000000n,
        'FINITE_GAS_ALLOWANCE_TOO_LOW',
      );
      const account = new Account(actor.id, provider, actor.key),
        signed = await account.createSignedTransaction({
          receiverId: c.NEAR_CONTRACT_ID,
          actions: [actions.functionCall(method, args, gas, 0n)],
        });
      prepared = {
        hash: bs58.encode(sha(signed.transaction.encode())),
        signedBase64: Buffer.from(signed.encode()).toString('base64'),
        method,
        args,
        gas: gas.toString(),
        signer: actor.id,
      };
      await writeFile(path + '-prepared.json', JSON.stringify(prepared), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    assert.deepEqual(prepared.args, args, 'PERSISTED_METHOD_TERMS_CHANGED');
    if (!(await optional(path + '-attempt.json'))) {
      await writeFile(
        path + '-attempt.json',
        JSON.stringify({
          at: new Date().toISOString(),
          hash: prepared.hash,
          state: 'RECONCILE_EXISTING_NATIVE_IDENTITY',
        }),
        { mode: 0o600, flag: 'wx' },
      );
      await provider.sendTransactionUntil(
        SignedTransaction.decode(Buffer.from(prepared.signedBase64, 'base64')),
        'FINAL',
      );
    }
    const raw = await rpc(
      'tx',
      { tx_hash: prepared.hash, sender_account_id: actor.id, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    );
    saved = verifyActivationReceipt(
      raw,
      prepared.hash,
      {
        id: method,
        signerId: actor.id,
        receiverId: c.NEAR_CONTRACT_ID,
        actions: [
          {
            type: 'FunctionCall',
            params: { methodName: method, args, gas: gas.toString(), deposit: '0' },
          },
        ],
      },
      method.startsWith('request_') ? 2500000000000000000000n : 500000000000000000000n,
    );
    await writeFile(path + '-receipt.json', JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    return saved;
  }
  const rent = await wallets.solana.getMinimumBalanceForRentExemption(0);
  assert.ok(Number.isSafeInteger(rent) && rent >= 0);
  const solAmount = BigInt(rent) + 10000n;
  assert.ok(solAmount <= 1000000n, 'RENT_CAP_CHANGED');
  const definitions = [
      {
        id: 'mainnet-owned-base-fixture-v1',
        chain: 'eip155:8453',
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        recipient: base,
        amount: '1',
        budget: '1',
      },
      {
        id: 'mainnet-owned-sol-fixture-v1',
        chain: 'solana:mainnet',
        token: 'sol:native',
        recipient: solRecipient,
        amount: solAmount.toString(),
        budget: '100000',
      },
    ],
    results = [];
  for (const row of definitions) {
    const path = DIR + row.id;
    let done = await optional(path + '-complete.json');
    if (done) {
      results.push(done);
      continue;
    }
    let plan = await optional(path + '-plan.json');
    if (!plan) {
      const unsigned = await wallets.prepare(row.chain, row.token, row.recipient, row.amount);
      const authorization = wallets.authorization(unsigned, {
        cycle_id: row.id,
        proposal_hash: digest({ scope: 'OWNER_AUTHORIZATION_FIXTURE', row }),
        route_hash: digest({ unsigned }),
        evidence_hash: digest({
          ownerPolicy: '8gYJJpuyU51BRx5b27YiqLVEj4s6YVmPyvL1djRa46RW',
          teeApproved: false,
          scope: 'OWNER_CONTROLLED_TRANSFER_NOT_AI',
        }),
        amount_atoms: row.amount,
        budget_atoms: row.budget,
        expires_at_ns: (BigInt(Date.now() + 600000) * 1000000n).toString(),
        slippage_bps: 0,
      });
      plan = { row, unsigned, authorization };
      await writeFile(path + '-plan.json', JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
    }
    const native = [];
    native.push(
      await call(
        row.id,
        'BRAIN',
        'authorize_cycle',
        { authorization: plan.authorization },
        20000000000000n,
      ),
    );
    native.push(
      await call(
        row.id,
        'HAND',
        row.chain.startsWith('eip155:') ? 'request_evm_signature' : 'request_solana_signature',
        { cycle_id: row.id, ...plan.unsigned.signArgs },
        250000000000000n,
      ),
    );
    let record = await viewCycle(row.id);
    assert.equal(record.payload_hex, plan.unsigned.payloadHex);
    assert.ok(record.signature, 'MPC_SIGNATURE_NOT_AVAILABLE');
    let signed = await optional(path + '-signed.json');
    if (!signed) {
      signed = await wallets.finalize(plan.unsigned, JSON.parse(record.signature));
      await writeFile(path + '-signed.json', JSON.stringify(signed), { mode: 0o600, flag: 'wx' });
    }
    native.push(
      await call(
        row.id,
        'HAND',
        'record_submission',
        { cycle_id: row.id, tx_hash: signed.txHash },
        20000000000000n,
      ),
    );
    if (!(await optional(path + '-broadcast.json'))) {
      await writeFile(
        path + '-broadcast.json',
        JSON.stringify({
          at: new Date().toISOString(),
          hash: signed.txHash,
          state: 'SUBMIT_SAME_SIGNED_BYTES_ONCE',
        }),
        { mode: 0o600, flag: 'wx' },
      );
      await wallets.broadcast(signed);
    }
    let confirmed;
    for (let i = 0; i < 30; i++) {
      confirmed = await wallets.confirmed(signed);
      if (confirmed.confirmed) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(confirmed.confirmed && !confirmed.failed, 'DESTINATION_NOT_CONFIRMED');
    const reconciliation = {
      scope: 'OWNER_AUTHORIZED_MAINNET_TRANSFER_FIXTURE',
      source: signed.sender,
      recipient: row.recipient,
      amountAtoms: row.amount,
      hash: signed.txHash,
      nativeFeeAtoms: confirmed.nativeFeeAtoms,
      grossPnlAtoms: '0',
      netProfitProven: false,
      aiApproved: false,
    };
    native.push(
      await call(
        row.id,
        'ACCOUNTANT',
        'finalize_cycle',
        { cycle_id: row.id, reconciliation_hash: digest(reconciliation), realized_pnl_atoms: '0' },
        20000000000000n,
      ),
    );
    record = await viewCycle(row.id);
    assert.equal(record.status, 'CLOSED');
    assert.equal(record.realized_pnl_atoms, '0');
    done = {
      checkedAt: new Date().toISOString(),
      id: row.id,
      chain: row.chain,
      source: signed.sender,
      recipient: row.recipient,
      asset: row.token,
      amountAtoms: row.amount,
      txHash: signed.txHash,
      explorerUrl: row.chain.startsWith('eip155:')
        ? 'https://basescan.org/tx/' + signed.txHash
        : 'https://solscan.io/tx/' + signed.txHash,
      destinationFinal: true,
      destinationNativeFeeAtoms: confirmed.nativeFeeAtoms,
      nativeReceipts: native,
      contractStatus: 'CLOSED',
      grossPnlAtoms: '0',
      netProfitProven: false,
      sourceClassification: 'OWNER_AUTHORIZATION_FIXTURE_NOT_AI',
    };
    await writeFile(path + '-complete.json', JSON.stringify(done, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    results.push(done);
    console.log(
      JSON.stringify({
        completed: row.id,
        hash: signed.txHash,
        nativeReceipts: native.map((t) => t.hash),
      }),
    );
  }
  const fees = results
    .flatMap((r) => r.nativeReceipts)
    .reduce((n, t) => n + BigInt(t.actualFeeYocto), 0n);
  assert.ok(
    priorFees + fees + 450000000000000000000000n <= UNIT / 2n,
    'ADDITIONAL_BUDGET_EXCEEDED',
  );
  const proof = {
    checkedAt: new Date().toISOString(),
    scope: 'OWNER_AUTHORIZED_MAINNET_MPC_EXECUTION_FIXTURES',
    network: 'mainnet',
    results,
    executionNativeFeesYocto: fees.toString(),
    allContinuationNativeFeesYocto: (priorFees + fees).toString(),
    retainedCapitalInputYocto: '450000000000000000000000',
    additionalPlanningCeilingYocto: (UNIT / 2n).toString(),
    paidInferenceRequests: 0,
    teeApproved: false,
    marketSwapProven: false,
    externalRevenueProven: false,
    netProfitProven: false,
    nftMinted: false,
  };
  await writeFile('artifacts/mainnet-owned-execution.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: 'COMPLETE',
      fixtures: 2,
      executionFeesYocto: fees.toString(),
      allContinuationFeesYocto: proof.allContinuationNativeFeesYocto,
      paidInferenceRequests: 0,
    }),
  );
}
await mkdir(DIR, { recursive: true, mode: 0o700 });
main().catch((e) => {
  console.error(
    JSON.stringify({
      status: 'HELD',
      code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'RECONCILE_EXISTING_EXECUTION_IDENTITY',
      credentialValuesPrinted: false,
    }),
  );
  process.exitCode = 1;
});
