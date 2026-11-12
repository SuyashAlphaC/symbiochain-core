import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
console.log = () => {};
const token = document.querySelector('meta[name="fixture-token"]').content,
  status = document.querySelector('#status'),
  sign = document.querySelector('#sign');
let plan,
  wallet,
  busy = false;
async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-fixture-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ planDigest: plan.digest, ...body }) } : {}),
    cache: 'no-store',
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.code ?? 'REPAIR_HELD');
  return d;
}
function check() {
  if (
    !['brain.symbio-fcef733893.near', 'hand.symbio-fcef733893.near'].includes(plan.signerId) ||
    plan.receiverId !== plan.signerId ||
    plan.newAllowanceYocto !== '40000000000000000000000' ||
    plan.transaction.actions.length !== 2
  )
    throw Error('REPAIR_PLAN_CHANGED');
  const [a, b] = plan.transaction.actions;
  if (
    a.type !== 'DeleteKey' ||
    a.params.publicKey !== plan.publicKey ||
    b.type !== 'AddKey' ||
    b.params.publicKey !== plan.publicKey ||
    JSON.stringify(b.params.accessKey.permission) !==
      JSON.stringify({
        receiverId: 'intents.near',
        methodNames: ['execute_intents'],
        allowance: '40000000000000000000000',
      })
  )
    throw Error('KEY_SCOPE_CHANGED');
}
async function refresh() {
  const s = await api('/state');
  sign.disabled = busy || !wallet || s.pending || !!s.receipt;
  if (s.receipt)
    status.textContent =
      'COMPLETE. Same Intents key and method scope; finite allowance corrected. Receipt: https://nearblocks.io/txns/' +
      s.receipt.transaction.hash;
  else if (s.pending)
    status.textContent =
      'Signature outcome pending. Reconcile its existing hash, do not sign again.';
  return s;
}
try {
  plan = await api('/plan');
  check();
  await api('/preflight', {});
  const s = await refresh();
  if (!s.pending && !s.receipt)
    status.textContent = 'Ready. Select ' + plan.signerId + ' in Meteor.';
} catch (e) {
  status.textContent = e.message;
}
document.querySelector('#connect').onclick = async () => {
  try {
    const selector = await setupWalletSelector({
      network: 'mainnet',
      fallbackRpcUrls: ['https://free.rpc.fastnear.com'],
      modules: [setupMeteorWallet()],
      debug: false,
    });
    wallet = await selector.wallet('meteor-wallet');
    if (await wallet.isSignedIn()) {
      if ((await wallet.getAccounts())[0]?.accountId !== plan.signerId) await wallet.signOut();
    }
    if (!(await wallet.isSignedIn())) await wallet.signIn({});
    if ((await wallet.getAccounts())[0]?.accountId !== plan.signerId)
      throw Error('SELECT_NAMED_SIGNER');
    status.textContent = 'Connected. Review the same-key allowance correction.';
  } catch (e) {
    wallet = null;
    status.textContent = e.message;
  }
  await refresh();
};
sign.onclick = async () => {
  if (busy || !wallet) return;
  busy = true;
  sign.disabled = true;
  try {
    check();
    if (!document.querySelector('#reviewed').checked) throw Error('REVIEW_REQUIRED');
    if ((await wallet.getAccounts())[0]?.accountId !== plan.signerId)
      throw Error('SELECT_NAMED_SIGNER');
    await api('/begin', {});
    const rows = await wallet.signAndSendTransactions({
      transactions: [
        {
          signerId: plan.signerId,
          receiverId: plan.receiverId,
          actions: plan.transaction.actions.map(internalActionToNaj),
        },
      ],
    });
    const hash = rows?.[0]?.transaction?.hash;
    if (!hash) throw Error('UNKNOWN_OUTCOME_RECONCILE_EXISTING_HASH');
    document.querySelector('#hash').value = hash;
    await api('/observe', { hash });
    await refresh();
  } catch (e) {
    const m = e.message;
    await refresh();
    status.textContent += '\nWallet: ' + m;
  } finally {
    busy = false;
    const s = await api('/state');
    sign.disabled = !wallet || s.pending || !!s.receipt;
  }
};
document.querySelector('#verify').onclick = async () => {
  try {
    await api('/observe', { hash: document.querySelector('#hash').value.trim() });
    await refresh();
  } catch (e) {
    status.textContent = e.message;
  }
};
