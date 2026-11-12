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
      'CONFIRMED. Brain and Hand each received 0.05 wNEAR on Intents. Funding: https://nearblocks.io/txns/' +
      s.receipt.transaction.hash +
      '. No AI inference or revenue claimed.';
  else if (s.pending)
    status.textContent = 'Signature outcome pending. Verify its existing hash; do not sign again.';
  return s;
}
function check() {
  if (
    plan.scope !== 'REFUNDED_CAPITAL_FOR_FRESH_GAS_QUOTES' ||
    plan.signerId !== 'solidvideo4090.near' ||
    plan.receiverId !== 'wrap.near' ||
    plan.capitalYocto !== '100000000000000000000000' ||
    plan.feeAllowanceYocto !== '4000000000000000000000' ||
    plan.transaction.actions.length !== 3 ||
    plan.fundingSlippageBps !== 50
  )
    throw Error('STATIC_FUNDING_PLAN_CHANGED');
  const a = plan.transaction.actions;
  if (
    a[0].type !== 'FunctionCall' ||
    a[0].params.methodName !== 'near_deposit' ||
    a[0].params.deposit !== '100000000000000000000000' ||
    a[0].params.gas !== '5000000000000' ||
    JSON.stringify(a[0].params.args) !== '{}'
  )
    throw Error('WRAP_CHANGED');
  for (let i = 1; i < 3; i++)
    if (
      a[i].type !== 'FunctionCall' ||
      a[i].params.methodName !== 'ft_transfer_call' ||
      a[i].params.deposit !== '1' ||
      a[i].params.gas !== '70000000000000' ||
      JSON.stringify(a[i].params.args) !==
        JSON.stringify({
          receiver_id: 'intents.near',
          amount: '50000000000000000000000',
          msg: ['brain', 'hand'][i - 1] + '.symbio-fcef733893.near',
        })
    )
      throw Error('AGENT_CREDIT_CHANGED');
  const expected = [
    [
      'brain.symbio-fcef733893.near',
      'nep141:base.omft.near',
      '0xE9464975ECAFa3e27AC1048C16a3406395061092',
    ],
    [
      'hand.symbio-fcef733893.near',
      'nep141:sol.omft.near',
      'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f',
    ],
  ];
  for (let i = 0; i < 2; i++)
    if (
      plan.gasSwaps[i].payer !== expected[i][0] ||
      plan.gasSwaps[i].asset !== expected[i][1] ||
      plan.gasSwaps[i].recipient !== expected[i][2] ||
      plan.gasSwaps[i].amountYocto !== '50000000000000000000000'
    )
      throw Error('SWAP_AUTHORIZATION_CHANGED');
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
    status.textContent = 'Connected. Review the three exact calls and fee allowance.';
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
