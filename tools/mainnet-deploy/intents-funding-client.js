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
  if (!r.ok) throw Error(d.code ?? 'REQUEST_HELD');
  return d;
}
async function refresh() {
  const s = await api('/state');
  sign.disabled = busy || !wallet || s.pending || !!s.receipt;
  if (s.receipt)
    status.textContent =
      'CONFIRMED. Brain and Hand each received 0.001 wNEAR on Intents. Funding: https://nearblocks.io/txns/' +
      s.receipt.transaction.hash +
      '. No AI inference or revenue claimed.';
  else if (s.pending)
    status.textContent = 'Signature outcome pending. Verify its existing hash; do not sign again.';
  return s;
}
function check() {
  if (
    plan.signerId !== 'solidvideo4090.near' ||
    plan.receiverId !== 'wrap.near' ||
    plan.capitalYocto !== '2000000000000000000000' ||
    plan.transaction.actions.length !== 4
  )
    throw Error('FUNDING_TERMS_CHANGED');
  const a = plan.transaction.actions;
  const expected = [
    ['storage_deposit', '1250000000000000000000', '10000000000000'],
    ['near_deposit', '2000000000000000000000', '5000000000000'],
    ['ft_transfer_call', '1', '70000000000000'],
    ['ft_transfer_call', '1', '70000000000000'],
  ];
  for (let i = 0; i < 4; i++)
    if (
      a[i].type !== 'FunctionCall' ||
      a[i].params.methodName !== expected[i][0] ||
      a[i].params.deposit !== expected[i][1] ||
      a[i].params.gas !== expected[i][2]
    )
      throw Error('ACTION_CHANGED');
  if (
    JSON.stringify(a[0].params.args) !==
      JSON.stringify({ account_id: 'solidvideo4090.near', registration_only: true }) ||
    JSON.stringify(a[1].params.args) !== '{}'
  )
    throw Error('REGISTRATION_CHANGED');
  for (let i = 2; i < 4; i++)
    if (
      JSON.stringify(a[i].params.args) !==
      JSON.stringify({
        receiver_id: 'intents.near',
        amount: '1000000000000000000000',
        msg: ['brain', 'hand'][i - 2] + '.symbio-fcef733893.near',
      })
    )
      throw Error('RECIPIENT_CHANGED');
}
try {
  plan = await api('/plan');
  check();
  await api('/preflight', {});
  const s = await refresh();
  if (!s.pending && !s.receipt)
    status.textContent = 'Ready. One wallet signature funds the reviewed internal-payment fixture.';
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
    if (!(await wallet.isSignedIn())) await wallet.signIn({});
    const accounts = await wallet.getAccounts();
    if (accounts.length !== 1 || accounts[0].accountId !== plan.signerId)
      throw Error('Select solidvideo4090.near in Meteor');
    status.textContent = 'Connected. Review the four exact calls and fee allowance.';
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
    const results = await wallet.signAndSendTransactions({
      transactions: [
        {
          signerId: plan.signerId,
          receiverId: plan.receiverId,
          actions: plan.transaction.actions.map(internalActionToNaj),
        },
      ],
    });
    const hash = results?.[0]?.transaction?.hash;
    if (!hash) throw Error('OUTCOME_UNKNOWN_VERIFY_EXISTING_HASH');
    document.querySelector('#hash').value = hash;
    await api('/observe', { hash });
    await refresh();
  } catch (e) {
    const message = e.message;
    await refresh();
    status.textContent += '\nWallet: ' + message;
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
