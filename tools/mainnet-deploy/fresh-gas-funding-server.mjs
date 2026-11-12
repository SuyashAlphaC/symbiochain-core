import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createIntentsFundingApp, intentsBalance } from './intents-funding-server.mjs';
import { ROOT, UNIT, rpc, planDigest } from './plan.mjs';
import { BRAIN, HAND } from './intents-funding-plan.mjs';
const dir = '.data/mainnet-fresh-gas-funding',
  port = Number(process.argv[2] ?? 3428);
assert.ok([3428, 3438].includes(port));
await mkdir(dir, { recursive: true, mode: 0o700 });
const original = JSON.parse(await readFile('artifacts/mainnet-wallet-provisioning.json')),
  retry = JSON.parse(await readFile('.data/mainnet-gas-funding-retry/terminal.json'));
assert.equal(retry.refundedNativeYocto, '100000000000000000000000');
const priorFees = BigInt(original.networkFeesYocto) + BigInt(retry.networkFeesYocto);
assert.ok(
  350000000000000000000000n + 100000000000000000000000n + priorFees + 14000000000000000000000n <=
    UNIT / 2n,
  'EXISTING_BUDGET_EXCEEDED',
);
const call = (methodName, args, gas, deposit) => ({
  type: 'FunctionCall',
  params: { methodName, args, gas, deposit },
});
const t = {
  id: 'refunded_capital_to_agents',
  signerId: ROOT,
  receiverId: 'wrap.near',
  actions: [
    call('near_deposit', {}, '5000000000000', '100000000000000000000000'),
    ...[BRAIN, HAND].map((account) =>
      call(
        'ft_transfer_call',
        { receiver_id: 'intents.near', amount: '50000000000000000000000', msg: account },
        '70000000000000',
        '1',
      ),
    ),
  ],
};
const raw = {
    scope: 'REFUNDED_CAPITAL_FOR_FRESH_GAS_QUOTES',
    network: 'mainnet',
    signerId: ROOT,
    receiverId: 'wrap.near',
    capitalYocto: '100000000000000000000000',
    feeAllowanceYocto: '4000000000000000000000',
    totalAdditionalCeilingYocto: (UNIT / 2n).toString(),
    priorNetworkFeesYocto: priorFees.toString(),
    futureIntentsFeePlanningYocto: '2000000000000000000000',
    futureExecutionFeePlanningYocto: '8000000000000000000000',
    fundingSlippageBps: 50,
    transaction: t,
    gasSwaps: [
      {
        payer: BRAIN,
        asset: 'nep141:base.omft.near',
        recipient: '0xE9464975ECAFa3e27AC1048C16a3406395061092',
        amountYocto: '50000000000000000000000',
        minimumOutput: '50000000000000',
      },
      {
        payer: HAND,
        asset: 'nep141:sol.omft.near',
        recipient: 'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f',
        amountYocto: '50000000000000000000000',
        minimumOutput: '1500000',
      },
    ],
    paidInferenceRequests: 0,
    automatedTradingEnabled: false,
  },
  plan = { ...raw, digest: planDigest(raw) };
const inspect = async () => {
  const b = (await rpc('block', { finality: 'final' })).header,
    owner = await rpc('query', {
      request_type: 'view_account',
      account_id: ROOT,
      block_id: b.hash,
    });
  assert.ok(
    BigInt(owner.amount) - BigInt(owner.storage_usage) * 10n ** 19n >=
      UNIT / 5n + UNIT / 10n + 4000000000000000000000n,
    'OWNER_RESERVE_PROTECTED',
  );
  const storage = await rpc('query', {
    request_type: 'call_function',
    account_id: 'wrap.near',
    block_id: b.hash,
    method_name: 'storage_balance_of',
    args_base64: Buffer.from(JSON.stringify({ account_id: ROOT })).toString('base64'),
  });
  assert.ok(JSON.parse(Buffer.from(storage.result).toString()), 'EXISTING_FT_STORAGE_REQUIRED');
  return {
    block: { hash: b.hash, height: String(b.height) },
    ownerBalanceYocto: owner.amount,
    brain: await intentsBalance(BRAIN, b.hash),
    hand: await intentsBalance(HAND, b.hash),
  };
};
const page = (token) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="fixture-token" content="${token}"><title>SymbioChain fresh gas funding</title><style>body{font:17px system-ui;background:#142127;color:#eafff6;max-width:1000px;margin:35px auto;padding:20px;line-height:1.6}button,input{padding:14px;margin:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>Fund agents before requesting fresh gas quotes</h1><p>The second ETH/SOL attempt expired and refunded 0.10 native NEAR. This plan reuses that returned capital. It creates no new native deposit accounts and requests no price quote before your wallet signature.</p><p>One transaction to wrap.near: wrap <strong>0.10 NEAR</strong>, then credit <strong>0.05 wNEAR each</strong> to Brain and Hand on Intents. Afterwards the controlled runner will create fresh quotes and immediately fund only Base ETH and Solana SOL at the owned derived addresses below, with at most <strong>0.5% funding slippage</strong>. Refunded swaps remain owned agent balances; no automatic replacement quote is funded.</p><p>Funding transaction fee planning ceiling: <strong>0.004 NEAR</strong>. Subsequent Intents payments: 0.002 NEAR planning allowance. Bounded execution tests: 0.008 NEAR planning allowance. Prior actual fees, retained capital and these allowances fit the unchanged <strong>0.50 NEAR additional budget</strong>. At least 0.20 NEAR remains in Meteor. Trading slippage stays zero; AI and automated trading remain disabled.</p><details><summary>Exact calls and permitted gas swaps</summary><pre>${JSON.stringify(plan, null, 2)}</pre></details><pre id="status">Checking mainnet state…</pre><button id="connect">Connect Meteor</button><label><input id="reviewed" type="checkbox">I reviewed recycled capital, the three calls, both gas swaps and the total budget.</label><button id="sign" disabled>Sign reviewed agent funding</button><h2>Reconcile existing signature</h2><input id="hash" size="55"><button id="verify">Verify existing receipt</button><script type="module" src="/client.js"></script></body></html>`;
const app = await createIntentsFundingApp({
  plan,
  page,
  inspect,
  port,
  stateDir: process.argv[3] ?? dir,
  client: await readFile(dir + '/client.js', 'utf8'),
  verifyAfter: async (before, after) => {
    assert.equal(BigInt(after.brain) - BigInt(before.brain), UNIT / 20n);
    assert.equal(BigInt(after.hand) - BigInt(before.hand), UNIT / 20n);
  },
  readTransaction: (h) =>
    rpc(
      'tx',
      { tx_hash: h, sender_account_id: ROOT, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    ),
});
await app.listen({ host: '127.0.0.1', port });
console.log(
  JSON.stringify({
    portal: 'http://localhost:' + port,
    quotesCreated: 0,
    capitalNear: '0.10',
    feePlanningNear: '0.004',
    additionalCeilingNear: '0.50',
    paidInferenceRequests: 0,
  }),
);
