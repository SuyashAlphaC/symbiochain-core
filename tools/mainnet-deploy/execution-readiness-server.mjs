import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { createRequire } from 'node:module';
import { createIntentsFundingApp } from './intents-funding-server.mjs';
import { rpc, planDigest, UNIT } from './plan.mjs';
import { OWNER, TREASURY } from './activation-plan.mjs';
const { KeyPair } = createRequire(new URL('../../package.json', import.meta.url))('near-api-js');
const profile = process.argv[2];
assert.ok(['hand', 'policy'].includes(profile), 'NAMED_PROFILE_REQUIRED');
const port = Number(process.argv[3] ?? (profile === 'hand' ? 3425 : 3426));
assert.ok(port >= 3425 && port < 3500, 'LOOPBACK_PORT_REQUIRED');
const e = parse(await readFile('.env', 'utf8'));
const pub = KeyPair.fromString(e.NEAR_WORKER_PRIVATE_KEY).getPublicKey().toString();
const manifest = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json'));
const policy = {
  max_trade_atoms: '250000',
  max_daily_atoms: '500000',
  min_reserve_yocto: (UNIT / 10n).toString(),
  max_signing_cost_yocto: '1',
  max_slippage_bps: 0,
  allowed_chain_ids: [8453, 0],
  allowed_token_contracts: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'sol:native'],
  token_max_trade_atoms: ['250000', '4000000'],
  token_max_daily_atoms: ['500000', '8000000'],
};
const permission = {
  receiverId: TREASURY,
  methodNames: ['request_evm_signature', 'request_solana_signature', 'record_submission'],
  allowance: '300000000000000000000000',
};
const signer = profile === 'hand' ? 'hand.' + OWNER : OWNER;
const t = {
  id: profile === 'hand' ? 'hand_mpc_allowance' : 'base_sol_bounded_policy',
  signerId: signer,
  receiverId: profile === 'hand' ? signer : TREASURY,
  actions:
    profile === 'hand'
      ? [
          { type: 'DeleteKey', params: { publicKey: pub } },
          { type: 'AddKey', params: { publicKey: pub, accessKey: { permission } } },
        ]
      : [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'set_policy',
              args: { policy },
              gas: '20000000000000',
              deposit: '0',
            },
          },
        ],
};
const raw = {
    scope:
      profile === 'hand' ? 'SAME_KEY_MPC_GAS_ALLOWANCE_REPAIR' : 'OWNER_REVIEWED_BASE_SOL_POLICY',
    network: 'mainnet',
    signerId: signer,
    receiverId: t.receiverId,
    capitalYocto: '0',
    feeAllowanceYocto: profile === 'hand' ? '500000000000000000000' : '5000000000000000000000',
    transaction: t,
    policy,
    publicKey: pub,
    paidInferenceRequests: 0,
    automaticSpendingEnabled: false,
    treasuryReserveYocto: (UNIT / 10n).toString(),
  },
  plan = { ...raw, digest: planDigest(raw) };
const view = async (method, block) => {
  const r = await rpc('query', {
    request_type: 'call_function',
    account_id: TREASURY,
    block_id: block,
    method_name: method,
    args_base64: 'e30=',
  });
  return JSON.parse(Buffer.from(r.result).toString());
};
const inspect = async () => {
  const b = (await rpc('block', { finality: 'final' })).header,
    [keys, balance, p, state] = await Promise.all([
      rpc('query', { request_type: 'view_access_key_list', account_id: signer, block_id: b.hash }),
      rpc('query', { request_type: 'view_account', account_id: signer, block_id: b.hash }),
      view('get_policy', b.hash),
      view('distribution_policy', b.hash),
    ]);
  assert.deepEqual(
    keys.keys.filter((k) => k.access_key.permission === 'FullAccess').map((k) => k.public_key),
    [manifest.recoveryPublicKey],
    'RECOVERY_CUSTODY_CHANGED',
  );
  assert.equal(state.accountant, 'books.' + OWNER);
  assert.equal(state.paused, false);
  assert.ok(BigInt(p.min_reserve_yocto) >= UNIT / 10n, 'TREASURY_RESERVE_CHANGED');
  const available = BigInt(balance.amount) - BigInt(balance.storage_usage) * 10n ** 19n;
  assert.ok(
    available > (profile === 'hand' ? 280000000000000000000000n : 25000000000000000000000n),
    'SIGNER_GAS_RESERVATION_NOT_FUNDED',
  );
  const existing = keys.keys.find((k) => k.public_key === pub)?.access_key;
  if (profile === 'hand') {
    assert.ok(existing?.permission.FunctionCall, 'SCOPED_KEY_REQUIRED');
    assert.equal(existing.permission.FunctionCall.receiver_id, TREASURY);
    assert.deepEqual(existing.permission.FunctionCall.method_names, permission.methodNames);
  }
  return {
    block: { height: String(b.height), hash: b.hash },
    policy: p,
    paused: state.paused,
    availableYocto: available.toString(),
    key: profile === 'hand' ? existing : null,
  };
};
const page = (token) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="fixture-token" content="${token}"><title>SymbioChain bounded execution preparation</title><style>body{font:17px system-ui;background:#132128;color:#eafff6;max-width:1000px;margin:35px auto;padding:20px;line-height:1.6}button,input{padding:14px;margin:10px}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#6ee5ba}</style></head><body><h1>${profile === 'hand' ? 'Repair Hand’s finite MPC gas allowance' : 'Authorize bounded Base and native-SOL transfers'}</h1><p>Select <strong>${signer}</strong> in Meteor. ${profile === 'hand' ? 'The same existing treasury key is deleted and reinstalled with a finite 0.30-NEAR gas allowance. Receiver and its three permitted methods stay exactly the same. This allowance is not a transfer; it covers the upfront gas reservation for a 250-TGas MPC request. Fee planning ceiling: 0.0005 NEAR.' : 'One zero-deposit set_policy() call adds native SOL to the existing Base-USDC policy. Global authorization limits change from 0.05/0.10 USDC to 0.25 USDC per authorization and 0.50 USDC per day. Native-SOL token caps are 0.004 SOL per authorization and 0.008 SOL per day. The native treasury reserve stays 0.10 NEAR, the MPC deposit cap stays 1 yoctoNEAR and slippage stays zero. Fee planning ceiling: 0.005 NEAR.'}</p><p>These calls prepare controlled mainnet tests. They do not open the TEE gate, purchase inference, start an MPC request, enable automated spending, mint an NFT or establish revenue. Their fees count toward the remaining 0.05-NEAR continuation fee allowance within the existing 0.50-NEAR additional test ceiling.</p><details><summary>Full exact plan</summary><pre>${JSON.stringify(plan, null, 2)}</pre></details><pre id="status">Checking chain state…</pre><button id="connect">Connect named Meteor account</button><label><input id="reviewed" type="checkbox">I reviewed the exact scope, finite caps, unchanged reserve and fee allowance.</label><button id="sign" disabled>Sign reviewed preparation call</button><h2>Reconcile an existing signature</h2><input id="hash" size="55"><button id="verify">Verify existing receipt</button><p><a href="http://localhost:${profile === 'hand' ? 3426 : 3425}">${profile === 'hand' ? 'Next: owner policy' : 'Hand allowance'}</a></p><script type="module" src="/client.js"></script></body></html>`;
const app = await createIntentsFundingApp({
  port,
  plan,
  page,
  inspect,
  stateDir: process.argv[4] ?? '.data/mainnet-execution-readiness/' + profile,
  client: await readFile('.data/mainnet-execution-readiness/client.js', 'utf8'),
  verifyAfter: async (before, after) => {
    if (profile === 'hand') {
      assert.equal(after.key.permission.FunctionCall.allowance, permission.allowance);
      assert.ok(BigInt(after.key.nonce) > BigInt(before.key.nonce), 'KEY_NONCE_NOT_RESET');
    } else assert.deepEqual(after.policy, policy, 'BOUNDED_POLICY_NOT_SET');
  },
  readTransaction: (h) =>
    rpc(
      'tx',
      { tx_hash: h, sender_account_id: signer, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    ),
});
await app.listen({ host: '127.0.0.1', port });
console.log(
  JSON.stringify({
    portal: 'http://localhost:' + port,
    signer,
    profile,
    zeroTransfers: true,
    paidInferenceRequests: 0,
  }),
);
