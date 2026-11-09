import Fastify from 'fastify';
import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MainnetReader } from '../../dist/mainnet.js';
import { rpc, RPC, WASM_SHA256 } from './plan.mjs';
import {
  makeActivationPlan,
  verifyActivationReceipt,
  FEE_CEILING,
  OWNER_GAS_RESERVE,
} from './activation-plan.mjs';
const PORT = 3420,
  ARCHIVE = 'https://archival-rpc.mainnet.fastnear.com';
async function optional(file) {
  try {
    return JSON.parse(await readFile(file));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
export async function inspectActivation(plan) {
  const m = JSON.parse(await readFile('artifacts/mainnet-paused-deployment.json'));
  const c = {
    EXECUTION_MODE: 'LIVE',
    EXECUTION_ENABLED: false,
    NEAR_NETWORK: 'mainnet',
    NEAR_RPC_URL: RPC,
    NEAR_CONTRACT_ID: m.treasury,
    NEAR_WORKER_ACCOUNT_ID: m.accounts.hand,
    NEAR_BRAIN_ACCOUNT_ID: m.accounts.brain,
    NEAR_SCOUT_ACCOUNT_ID: m.accounts.scout,
    NEAR_ACCOUNTANT_ACCOUNT_ID: m.accounts.accountant,
    NEAR_AI_MODEL: 'z-ai/glm-5.3-flash',
    AI_TOTAL_BUDGET_USD_MICROS: '1000000',
    AI_MAX_REQUEST_USD_MICROS: '100000',
  };
  const snapshot = await new MainnetReader(c).snapshot();
  assert.ok(snapshot.code.matches && m.wasmSha256 === WASM_SHA256, 'REVIEWED_CODE_CHANGED');
  assert.ok(
    snapshot.deployment.temporaryKeyRevoked &&
      snapshot.accounts.every((a) => a.recoveryKeyPresent && a.fullAccessKeyCount === 1),
    'RECOVERY_CUSTODY_CHANGED',
  );
  const price = await rpc('gas_price', [null]);
  const keys = {};
  for (const role of ['brain', 'hand']) {
    const rows = await rpc('query', {
      request_type: 'view_access_key_list',
      block_id: snapshot.block.hash,
      account_id: m.accounts[role],
    });
    const key = rows.keys.find((k) => k.public_key === plan.intentsPublicKeys[role]);
    if (key) {
      const f = key.access_key.permission.FunctionCall;
      assert.ok(f, 'INTENTS_KEY_HAS_FULL_ACCESS');
      assert.equal(f.receiver_id, 'intents.near');
      assert.deepEqual(f.method_names, ['execute_intents']);
      assert.ok(BigInt(f.allowance) <= 5000000000000000000000n);
    }
    const r = await rpc('query', {
      request_type: 'call_function',
      block_id: snapshot.block.hash,
      account_id: 'intents.near',
      method_name: 'has_public_key',
      args_base64: Buffer.from(
        JSON.stringify({ account_id: m.accounts[role], public_key: plan.intentsPublicKeys[role] }),
      ).toString('base64'),
    });
    keys[role] = {
      installed: !!key,
      registered: JSON.parse(Buffer.from(r.result).toString()) === true,
    };
  }
  const policyResult = await rpc('query', {
    request_type: 'call_function',
    block_id: snapshot.block.hash,
    account_id: m.treasury,
    method_name: 'get_policy',
    args_base64: 'e30=',
  });
  const policy = JSON.parse(Buffer.from(policyResult.result).toString());
  const r = await fetch('https://symbiochain.vercel.app/api/swarm/runtime', {
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  assert.ok(r.ok, 'HOSTED_RUNTIME_UNAVAILABLE');
  const runtime = await r.json();
  assert.ok(
    runtime.mode === 'LIVE' && !runtime.executionEnabled,
    'EXECUTION_ENGINE_MUST_REMAIN_DISARMED',
  );
  return {
    checkedAt: new Date().toISOString(),
    snapshot,
    keys,
    policy,
    gasPriceYocto: price.gas_price,
  };
}
export async function createActivationApp({
  plan,
  client = '',
  stateDir = '.data/mainnet-activation/operation',
  inspect = () => inspectActivation(plan),
  readTransaction = (hash, signer) =>
    rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' }, ARCHIVE),
  readBlock = (hash) => rpc('block', { block_id: hash }),
  port = PORT,
} = {}) {
  assert.deepEqual(plan, makeActivationPlan(plan.intentsPublicKeys), 'ACTIVATION_PLAN_CHANGED');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const app = Fastify({ logger: false, bodyLimit: 4000 });
  const rows = plan.transactions
    .map(
      (t, i) =>
        `<li>${i + 1}. <strong>${t.id}</strong> — signer <code>${t.signerId}</code>, receiver <code>${t.receiverId}</code></li>`,
    )
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="activation-token" content="${token}"><title>SymbioChain bounded owner activation</title><style>body{font:16px system-ui;background:#111c22;color:#e7f0f3;max-width:1000px;margin:30px auto;padding:0 20px;line-height:1.6}section{border:1px solid #50626a;border-radius:14px;padding:20px;margin:20px 0}button,input{padding:12px;margin:8px 8px 8px 0}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}input[type=text]{width:90%}a{color:#77e7bb}</style></head><body><h1>Bounded owner activation · AI quarantined</h1><p>No treasury top-up. No owner recovery key is loaded by this server. Only the selected wallet signs.</p><section><h2>What this authorizes</h2><p>Install two receiver-scoped keys (Intents <code>execute_intents</code> only, 0.005 NEAR gas allowance each), register those public keys on Intents, reallocate 0.02 NEAR from the paused treasury to its existing owner for gas, then atomically set the treasury policy, enable its three worker roles and unpause. The final <code>fund({})</code> probe attaches <strong>zero NEAR</strong>.</p><p>Trade authorization limits: <strong>0.05 USDC per authorization, 0.10 USDC per day</strong>, on Base USDC only. Native reserve: <strong>0.10 NEAR</strong>; MPC signing deposit limit: <strong>1 yoctoNEAR</strong>. These caps do not bound every fund-moving path or the owner's recovery authority. Registered Intents keys can authorize the corresponding agent's Intents balances.</p><p>Combined planning ceiling: <strong>0.03 NEAR</strong> across seven signatures: 0.02 NEAR is reallocated from the paused treasury to its owner for gas, while total network fees and new-key storage have a 0.01 NEAR planning allowance. No new funds enter the treasury. Per-transaction network-fee allowance: 0.01 NEAR. Fees are paid by the named signers' existing balances. Gas estimates are rechecked; NEAR transactions do not encode a maximum gas-price field. Review Meteor's displayed fees.</p><p>Inference stays blocked by application-level TEE workload measurement policy. Automated trading, service spending, NFT minting and credit purchases remain disabled. Running monitor heartbeats do not establish AI execution or revenue.</p><ol>${rows}</ol><p>Switch Meteor to each named signer as prompted. They use your existing recovery custody; this page does not import keys.</p><details><summary>Full public transaction plan</summary><pre>${JSON.stringify(plan, null, 2)}</pre></details></section><section><pre id="preflight">Reading finalized state…</pre><p id="next"></p><button id="connect">Connect selected Meteor account</button><label><input id="reviewed" type="checkbox">I reviewed the next transaction, scoped keys, USDC limits and fee planning ceiling.</label><button id="sign" disabled>Sign next reviewed transaction</button><button id="refresh">Refresh state</button><pre id="status" role="status"></pre></section><section><h2>Reconcile an existing signature</h2><p>Unknown outcomes stop another signature. Paste the existing hash; do not repeat the operation.</p><input id="hash" type="text" aria-label="Existing transaction hash" autocomplete="off"><button id="verify">Verify existing receipt</button><p><a href="https://symbiochain.vercel.app/evidence" target="_blank" rel="noopener noreferrer">Public mainnet evidence</a></p></section><script type="module" src="/client.js"></script></body></html>`;
  app.addHook('onRequest', async (req, reply) => {
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!hosts.includes(req.headers.host))
      return reply.code(403).send({ code: 'HOST_NOT_ALLOWED' });
    if (req.headers.origin && !hosts.map((h) => 'http://' + h).includes(req.headers.origin))
      return reply.code(403).send({ code: 'ORIGIN_NOT_ALLOWED' });
    if (!['/', '/client.js', '/favicon.ico'].includes(req.url)) {
      const actual = String(req.headers['x-activation-token'] ?? '');
      if (
        actual.length !== token.length ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(token))
      )
        return reply.code(401).send({ code: 'LOCAL_SESSION_REQUIRED' });
    }
  });
  app.addHook('onSend', async (_req, reply, body) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://free.rpc.fastnear.com https://*.meteorwallet.app; frame-src https://*.meteorwallet.app; img-src 'self' data: https://*.meteorwallet.app; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    return body;
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(409).send({ code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'ACTIVATION_HELD' }),
  );
  const state = async () => {
    const receipts = [];
    for (const t of plan.transactions) {
      const r = await optional(`${stateDir}/${t.id}.json`);
      if (!r) break;
      receipts.push(r);
    }
    const index = receipts.length,
      next = plan.transactions[index] ?? null;
    return {
      index,
      next,
      receipts,
      pending: next ? !!(await optional(`${stateDir}/${next.id}-attempt.json`)) : false,
      complete: index === plan.transactions.length,
    };
  };
  const checkBody = (b) => assert.equal(b?.planDigest, plan.digest, 'PLAN_DIGEST_MISMATCH');
  const preflight = async () => {
    const s = await state();
    assert.ok(s.next && !s.pending, 'COMPLETE_OR_PENDING_RECONCILE');
    const before = await inspect();
    if (s.next.id !== 'owner_probe') {
      assert.equal(before.snapshot.paused, true, 'TREASURY_STATE_CHANGED');
      assert.equal(
        before.snapshot.accounts.filter((a) => a.workerEnabled === true).length,
        0,
        'WORKERS_ALREADY_ENABLED',
      );
    } else {
      assert.equal(before.snapshot.paused, false, 'ACTIVATION_NOT_OBSERVED');
      assert.deepEqual(before.policy, plan.policy, 'ACTIVATED_POLICY_MISMATCH');
    }
    const signer = before.snapshot.accounts.find((a) => a.accountId === s.next.signerId);
    assert.ok(signer, 'SIGNER_NOT_RECORDED');
    if (s.next.id === 'owner_gas_reserve') {
      const treasury = before.snapshot.accounts.find((a) => a.accountId === plan.treasury);
      assert.ok(
        BigInt(treasury.availableYocto) >=
          OWNER_GAS_RESERVE + BigInt(plan.policy.min_reserve_yocto),
        'TREASURY_RESERVE_PROTECTED',
      );
    }
    if (s.next.id === 'activate')
      assert.ok(
        BigInt(signer.availableYocto) >= 30000000000000000000000n,
        'OWNER_WALLET_GAS_RESERVE_REQUIRED',
      );
    const gas = s.next.actions.reduce(
      (n, a) => n + (a.type === 'FunctionCall' ? BigInt(a.params.gas) : 0n),
      10000000000000n,
    );
    const estimate = gas * BigInt(before.gasPriceYocto);
    assert.ok(estimate <= 10000000000000000000000n, 'GAS_PRICE_EXCEEDS_FEE_ALLOWANCE');
    const storage = s.next.id.endsWith('_key') ? 3000000000000000000000n : 0n;
    assert.ok(
      BigInt(signer.availableYocto) > estimate + storage + 2000000000000000000000n,
      'SIGNER_RESERVE_TOO_LOW',
    );
    const spent = s.receipts.reduce(
      (n, r) => n + BigInt(r.transaction.actualFeeYocto) + BigInt(r.storageIncreaseYocto),
      0n,
    );
    assert.ok(spent + estimate + storage <= FEE_CEILING, 'COMBINED_PLANNING_CEILING');
    return { state: s, before, estimateYocto: estimate.toString() };
  };
  app.get('/', async (_q, r) => r.type('text/html').send(html));
  app.get('/favicon.ico', async (_q, r) => r.code(204).send());
  app.get('/client.js', async (_q, r) => r.type('text/javascript').send(client));
  app.get('/plan', async () => plan);
  app.get('/state', state);
  app.post('/preflight', async (req) => {
    checkBody(req.body);
    const p = await preflight();
    return {
      index: p.state.index,
      signerId: p.state.next.signerId,
      block: p.before.snapshot.block,
      paused: p.before.snapshot.paused,
      estimateYocto: p.estimateYocto,
    };
  });
  app.post('/begin', async (req) => {
    checkBody(req.body);
    const p = await preflight();
    await writeFile(
      `${stateDir}/${p.state.next.id}-attempt.json`,
      JSON.stringify({
        at: new Date().toISOString(),
        planDigest: plan.digest,
        before: p.before,
        index: p.state.index,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    return { prepared: true, index: p.state.index };
  });
  let observing = false;
  app.post('/observe', async (req) => {
    checkBody(req.body);
    const hash = req.body?.hash;
    assert.match(hash ?? '', /^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'INVALID_HASH');
    const s = await state();
    const existing = s.receipts.find((r) => r.transaction.hash === hash);
    if (existing) return existing;
    assert.ok(s.pending && s.next, 'NO_PENDING_SIGNATURE');
    assert.ok(!observing, 'OBSERVATION_RUNNING');
    observing = true;
    try {
      await writeFile(
        `${stateDir}/${s.next.id}-observed-hash.json`,
        JSON.stringify({ at: new Date().toISOString(), hash, scope: 'UNVERIFIED_WALLET_RESULT' }),
        { mode: 0o600 },
      );
      const attempt = await optional(`${stateDir}/${s.next.id}-attempt.json`);
      const transaction = verifyActivationReceipt(
        await readTransaction(hash, s.next.signerId),
        hash,
        s.next,
      );
      const block = await readBlock(transaction.blockHash);
      assert.ok(
        BigInt(block.header.height) >= BigInt(attempt.before.snapshot.block.height),
        'TRANSACTION_PREDATES_ATTEMPT',
      );
      const after = await inspect();
      assert.ok(
        BigInt(block.header.height) <= BigInt(after.snapshot.block.height),
        'RECEIPT_NOT_FINAL_IN_SNAPSHOT',
      );
      if (s.index < 4) {
        assert.ok(after.snapshot.paused, 'EARLY_UNPAUSE');
        const role = s.next.id.split('_')[0];
        assert.ok(
          after.keys[role][s.next.id.endsWith('_key') ? 'installed' : 'registered'],
          'EXPECTED_KEY_STATE_MISSING',
        );
      } else if (s.next.id === 'owner_gas_reserve') {
        assert.ok(after.snapshot.paused, 'RESERVE_ALLOCATION_MUST_REMAIN_PAUSED');
        const ownerBefore = attempt.before.snapshot.accounts.find(
          (a) => a.accountId === plan.owner,
        );
        const ownerAfter = after.snapshot.accounts.find((a) => a.accountId === plan.owner);
        assert.ok(
          BigInt(ownerAfter.balanceYocto) >
            BigInt(ownerBefore.balanceYocto) + OWNER_GAS_RESERVE - 10000000000000000000000n,
          'OWNER_GAS_RESERVE_NOT_RECEIVED',
        );
      } else {
        assert.ok(!after.snapshot.paused, 'ACTIVATION_NOT_OBSERVED');
        assert.equal(
          after.snapshot.accounts.filter((a) => a.workerEnabled === true).length,
          3,
          'WORKERS_NOT_ENABLED',
        );
        assert.deepEqual(after.policy, plan.policy, 'POLICY_NOT_APPLIED');
      }
      const storageIncrease = after.snapshot.accounts.reduce((sum, a) => {
        const b = attempt.before.snapshot.accounts.find((x) => x.accountId === a.accountId);
        return (
          sum +
          (b && BigInt(a.storageYocto) > BigInt(b.storageYocto)
            ? BigInt(a.storageYocto) - BigInt(b.storageYocto)
            : 0n)
        );
      }, 0n);
      const record = {
        checkedAt: new Date().toISOString(),
        scope: 'BOUNDED_OWNER_ACTIVATION_TEE_QUARANTINED',
        transaction,
        storageIncreaseYocto: storageIncrease.toString(),
        before: attempt.before,
        after,
        paidInferenceRequests: 0,
        treasuryTopupYocto: '0',
        externalRevenueProven: false,
      };
      await writeFile(`${stateDir}/${s.next.id}.json`, JSON.stringify(record, null, 2), {
        flag: 'wx',
        mode: 0o600,
      });
      const final = await state();
      if (final.complete)
        await writeFile(
          `${stateDir}/complete.json`,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              planDigest: plan.digest,
              scope: record.scope,
              transactions: final.receipts.map((r) => r.transaction),
              totalFeeYocto: final.receipts
                .reduce((n, r) => n + BigInt(r.transaction.actualFeeYocto), 0n)
                .toString(),
              newStorageYocto: final.receipts
                .reduce((n, r) => n + BigInt(r.storageIncreaseYocto), 0n)
                .toString(),
              after,
              paidInferenceRequests: 0,
              treasuryTopupYocto: '0',
              externalRevenueProven: false,
            },
            null,
            2,
          ),
          { flag: 'wx', mode: 0o600 },
        );
      return record;
    } finally {
      observing = false;
    }
  });
  return app;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const plan = JSON.parse(await readFile('artifacts/mainnet-bounded-plan.json'));
  const client = await readFile('.data/mainnet-activation/client.js');
  const app = await createActivationApp({ plan, client });
  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(
    JSON.stringify({
      portal: 'http://localhost:' + PORT,
      stages: 7,
      treasuryTopupYocto: '0',
      ownerSignaturesRequired: true,
      serverHoldsWalletKeys: false,
      paidInferenceRequests: 0,
    }),
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => void app.close().then(() => process.exit(0)));
}
