import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createIntentsFundingApp } from './intents-funding-server.mjs';
import { rpc, planDigest } from './plan.mjs';
import { BRAIN, HAND } from './intents-funding-plan.mjs';
const role = process.argv[2];
assert.ok(['brain', 'hand'].includes(role), 'NAMED_AGENT_REQUIRED');
const port = process.argv[3] ? Number(process.argv[3]) : role === 'brain' ? 3422 : 3423;
assert.ok(Number.isInteger(port) && port >= 3422 && port <= 3499, 'LOOPBACK_PORT_REQUIRED');
const account = role === 'brain' ? BRAIN : HAND;
const original = JSON.parse(await readFile('artifacts/mainnet-bounded-plan.json'));
const publicKey = original.intentsPublicKeys[role];
const t = {
  id: role + '_intents_allowance_repair',
  signerId: account,
  receiverId: account,
  actions: [
    { type: 'DeleteKey', params: { publicKey } },
    {
      type: 'AddKey',
      params: {
        publicKey,
        accessKey: {
          permission: {
            receiverId: 'intents.near',
            methodNames: ['execute_intents'],
            allowance: '40000000000000000000000',
          },
        },
      },
    },
  ],
};
const p = {
  scope: 'INTENTS_GAS_ALLOWANCE_REPAIR_ONLY',
  network: 'mainnet',
  signerId: account,
  receiverId: account,
  publicKey,
  newAllowanceYocto: '40000000000000000000000',
  capitalYocto: '0',
  feeAllowanceYocto: '500000000000000000000',
  transaction: t,
};
const plan = { ...p, digest: planDigest(p) };
const inspect = async () => {
  const block = (await rpc('block', { finality: 'final' })).header;
  const [key, keys, near] = await Promise.all([
    rpc('query', {
      request_type: 'view_access_key',
      account_id: account,
      public_key: publicKey,
      block_id: block.hash,
    }),
    rpc('query', {
      request_type: 'view_access_key_list',
      account_id: account,
      block_id: block.hash,
    }),
    rpc('query', { request_type: 'view_account', account_id: account, block_id: block.hash }),
  ]);
  const f = key.permission.FunctionCall;
  assert.ok(f, 'FULL_ACCESS_FORBIDDEN');
  assert.equal(f.receiver_id, 'intents.near');
  assert.deepEqual(f.method_names, ['execute_intents']);
  assert.ok(
    keys.keys.filter((k) => k.access_key.permission === 'FullAccess').length === 1,
    'CUSTODY_CHANGED',
  );
  assert.ok(
    BigInt(near.amount) - BigInt(near.storage_usage) * 10000000000000000000n >
      1000000000000000000000n,
    'SIGNER_RESERVE_TOO_LOW',
  );
  return {
    block: { hash: block.hash, height: String(block.height) },
    allowance: f.allowance,
    keyNonce: String(key.nonce),
    account,
    publicKey,
  };
};
const page = (token, plan) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="fixture-token" content="${token}"><title>SymbioChain restricted key allowance repair</title><style>body{font:17px system-ui;max-width:1000px;margin:40px auto;background:#132128;color:#eafff6;padding:20px;line-height:1.6}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}button,input{padding:14px;margin:10px}a{color:#6ee5ba}</style></head><body><h1>Repair ${role}'s restricted gas allowance</h1><p>Select <strong>${account}</strong> in Meteor. The two-action atomic transaction deletes and reinstalls only the existing dedicated Intents key with a finite <strong>0.04 NEAR gas allowance</strong>. Receiver stays <code>intents.near</code>, method stays <code>execute_intents</code>. No full-access key, transfer, new public key, TEE approval or contract policy change is requested.</p><p>The node rejected the old 0.005 NEAR allowance before inclusion. This replacement also resets the native key nonce so the rejected native envelope cannot execute later. The original off-chain payment nonce is retained. Fee planning ceiling: <strong>0.0005 NEAR</strong>, included in the existing 0.03 NEAR internal-payment test budget. Changing the allowance does not transfer or spend 0.04 NEAR.</p><details><summary>Exact transaction</summary><pre>${JSON.stringify(plan, null, 2)}</pre></details><pre id="status">Checking chain state…</pre><button id="connect">Connect named Meteor account</button><label><input id="reviewed" type="checkbox">I reviewed the same key, restricted receiver/method and finite allowance.</label><button id="sign" disabled>Sign reviewed allowance repair</button><h2>Reconcile existing signature</h2><input id="hash" size="55"><button id="verify">Verify existing receipt</button><p><a href="http://localhost:${role === 'brain' ? 3423 : 3422}">${role === 'brain' ? 'Next: Hand' : 'Brain repair'}</a></p><script type="module" src="/client.js"></script></body></html>`;
await mkdir('.data/mainnet-intents-fixture/key-repair', { recursive: true, mode: 0o700 });
const app = await createIntentsFundingApp({
  port,
  plan,
  page,
  stateDir: process.argv[4] ?? '.data/mainnet-intents-fixture/key-repair/' + role,
  client: await readFile('.data/mainnet-intents-fixture/key-repair/client.js', 'utf8'),
  inspect,
  verifyAfter: async (before, after) => {
    assert.equal(after.allowance, plan.newAllowanceYocto, 'ALLOWANCE_NOT_UPDATED');
    assert.equal(after.publicKey, before.publicKey);
    assert.ok(BigInt(after.keyNonce) > BigInt(before.keyNonce), 'KEY_NONCE_NOT_RESET');
  },
  readTransaction: (hash) =>
    rpc(
      'tx',
      { tx_hash: hash, sender_account_id: account, wait_until: 'FINAL' },
      'https://archival-rpc.mainnet.fastnear.com',
    ),
});
await app.listen({ host: '127.0.0.1', port });
console.log({
  portal: 'http://localhost:' + port,
  signer: account,
  allowanceNear: '0.04',
  feeAllowanceNear: '0.0005',
  keyScopesChanged: false,
});
