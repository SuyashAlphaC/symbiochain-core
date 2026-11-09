import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
console.log = () => {};
const token = document.querySelector('meta[name="activation-token"]').content,
  status = document.querySelector('#status'),
  sign = document.querySelector('#sign');
let plan,
  wallet,
  busy = false,
  current;
async function read(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-activation-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify({ ...body, planDigest: plan.digest }) } : {}),
    cache: 'no-store',
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.code ?? 'ACTIVATION_HELD');
  return data;
}
async function refresh() {
  const s = await read('/state');
  current = s;
  sign.disabled = busy || !wallet || s.pending || s.complete;
  document.querySelector('#next').textContent = s.next
    ? `Next: ${s.index + 1}/6 ${s.next.id}. Select ${s.next.signerId} in Meteor.`
    : 'All six receipts verified.';
  if (s.complete)
    status.textContent =
      'COMPLETE. Scoped Intents keys registered, bounded on-chain policy active, worker permissions enabled. AI remains quarantined and automated spending is disabled. No treasury top-up or paid inference occurred.';
  else if (s.pending)
    status.textContent =
      'A signature outcome is pending. Reconcile its existing hash; do not sign again.';
  return s;
}
async function preflight() {
  const p = await read('/preflight', {});
  document.querySelector('#preflight').textContent =
    `Finalized block ${p.block.height}. Treasury ${p.paused ? 'PAUSED' : 'ACTIVE'}. Next signer: ${p.signerId}. Conservative fee estimate: ${p.estimateYocto} yoctoNEAR. TEE gate stays closed.`;
  return p;
}
function checkTransaction(t) {
  const owner = 'symbio-fcef733893.near',
    treasury = 'treasury.' + owner;
  if (!['brain.' + owner, 'hand.' + owner, owner].includes(t.signerId))
    throw Error('SIGNER_CHANGED');
  if (t.id.endsWith('_key')) {
    const a = t.actions[0],
      p = a?.params?.accessKey?.permission;
    if (
      t.actions.length !== 1 ||
      a.type !== 'AddKey' ||
      t.receiverId !== t.signerId ||
      !p ||
      p === 'FullAccess' ||
      p.receiverId !== 'intents.near' ||
      JSON.stringify(p.methodNames) !== '["execute_intents"]' ||
      p.allowance !== '5000000000000000000000'
    )
      throw Error('SCOPED_KEY_PLAN_CHANGED');
  } else if (t.id.endsWith('_register')) {
    const a = t.actions[0];
    if (
      t.actions.length !== 1 ||
      t.receiverId !== 'intents.near' ||
      a.type !== 'FunctionCall' ||
      a.params.methodName !== 'add_public_key' ||
      a.params.deposit !== '1' ||
      a.params.gas !== '20000000000000'
    )
      throw Error('REGISTRATION_PLAN_CHANGED');
  } else if (t.id === 'activate') {
    if (
      t.signerId !== owner ||
      t.receiverId !== treasury ||
      t.actions.length !== 5 ||
      t.actions.some(
        (a) =>
          a.type !== 'FunctionCall' ||
          a.params.deposit !== '0' ||
          a.params.gas !== '10000000000000',
      )
    )
      throw Error('ACTIVATION_PLAN_CHANGED');
    const p = t.actions[0].params.args.policy;
    if (
      t.actions[0].params.methodName !== 'set_policy' ||
      p.max_trade_atoms !== '50000' ||
      p.max_daily_atoms !== '100000' ||
      p.min_reserve_yocto !== '100000000000000000000000' ||
      p.max_signing_cost_yocto !== '1' ||
      JSON.stringify(p.allowed_chain_ids) !== '[8453]'
    )
      throw Error('LIMITS_CHANGED');
    for (let i = 1; i < 4; i++)
      if (
        t.actions[i].params.methodName !== 'set_worker_enabled' ||
        t.actions[i].params.args.worker !== ['brain', 'hand', 'books'][i - 1] + '.' + owner ||
        t.actions[i].params.args.enabled !== true
      )
        throw Error('ROLE_PLAN_CHANGED');
    if (
      t.actions[4].params.methodName !== 'set_paused' ||
      t.actions[4].params.args.paused !== false
    )
      throw Error('UNPAUSE_CHANGED');
  } else if (t.id === 'owner_probe') {
    const a = t.actions[0];
    if (
      t.signerId !== owner ||
      t.receiverId !== treasury ||
      t.actions.length !== 1 ||
      a.type !== 'FunctionCall' ||
      a.params.methodName !== 'fund' ||
      a.params.deposit !== '0' ||
      a.params.gas !== '10000000000000' ||
      JSON.stringify(a.params.args) !== '{}'
    )
      throw Error('ZERO_DEPOSIT_PROBE_CHANGED');
  } else throw Error('UNEXPECTED_STAGE');
}
try {
  plan = await read('/plan');
  if (
    plan.transactions.length !== 6 ||
    plan.treasury !== 'treasury.symbio-fcef733893.near' ||
    plan.newTreasuryCapitalYocto !== '0'
  )
    throw Error('WRONG_DEPLOYMENT');
  const s = await refresh();
  if (!s.complete && !s.pending) {
    await preflight();
    status.textContent = 'Ready. Review the next signer and transaction. Keys stay in Meteor.';
  }
} catch (e) {
  status.textContent = e.message;
}
document.querySelector('#connect').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    const s = await refresh();
    if (!s.next) throw Error('ALREADY_COMPLETE');
    const selector = await setupWalletSelector({
      network: 'mainnet',
      fallbackRpcUrls: ['https://free.rpc.fastnear.com'],
      modules: [setupMeteorWallet()],
      debug: false,
    });
    wallet = await selector.wallet('meteor-wallet');
    if (await wallet.isSignedIn()) {
      const a = await wallet.getAccounts();
      if (a[0]?.accountId !== s.next.signerId) await wallet.signOut();
    }
    if (!(await wallet.isSignedIn())) await wallet.signIn({});
    const accounts = await wallet.getAccounts();
    if (accounts.length !== 1 || accounts[0].accountId !== s.next.signerId)
      throw Error(
        'Select ' +
          s.next.signerId +
          ' in Meteor. Your existing recovery custody controls this account.',
      );
    status.textContent =
      'Connected as ' + accounts[0].accountId + '. Review the next bounded transaction.';
  } catch (e) {
    wallet = null;
    status.textContent = e.message;
  } finally {
    busy = false;
    await refresh();
  }
});
sign.addEventListener('click', async () => {
  if (busy || !wallet) return;
  busy = true;
  sign.disabled = true;
  try {
    if (!document.querySelector('#reviewed').checked) throw Error('REVIEW_REQUIRED');
    const s = await refresh(),
      t = s.next;
    checkTransaction(t);
    if ((await wallet.getAccounts())[0]?.accountId !== t.signerId)
      throw Error('SELECT_NAMED_SIGNER');
    await read('/begin', {});
    status.textContent = 'Review ' + t.id + ' in Meteor. No owner key is exported.';
    const result = await wallet.signAndSendTransactions({
      transactions: [
        {
          signerId: t.signerId,
          receiverId: t.receiverId,
          actions: t.actions.map(internalActionToNaj),
        },
      ],
    });
    const row = Array.isArray(result) ? result[0] : result;
    const hash = row?.transaction?.hash;
    if (!hash) throw Error('OUTCOME_UNKNOWN_RECONCILE_EXISTING_HASH');
    document.querySelector('#hash').value = hash;
    await read('/observe', { hash });
    document.querySelector('#reviewed').checked = false;
    status.textContent = 'Final receipt verified: https://nearblocks.io/txns/' + hash;
    const after = await refresh();
    if (after.next?.signerId !== t.signerId) wallet = null;
  } catch (e) {
    status.textContent =
      'Held: ' + e.message + '. Reconcile any approved transaction hash before retrying.';
  } finally {
    busy = false;
    await refresh();
  }
});
document.querySelector('#refresh').addEventListener('click', () => {
  if (!busy)
    void refresh()
      .then((s) => (!s.complete && !s.pending ? preflight() : undefined))
      .catch((e) => (status.textContent = e.message));
});
document.querySelector('#verify').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    await read('/observe', { hash: document.querySelector('#hash').value.trim() });
    status.textContent = 'Existing receipt verified.';
  } catch (e) {
    status.textContent = e.message;
  } finally {
    busy = false;
    await refresh();
  }
});
