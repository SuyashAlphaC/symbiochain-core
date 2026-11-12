import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
console.log = () => {};
const token = document.querySelector('meta[name="fixture-token"]').content,
  status = document.querySelector('#status'),
  button = document.querySelector('#sign');
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
function check() {
  if (
    plan.scope !== 'OWNER_FUNDED_MAINNET_WALLETS_NOT_REVENUE' ||
    plan.network !== 'mainnet' ||
    plan.signerId !== 'solidvideo4090.near' ||
    plan.capitalYocto !== '450000000000000000000000' ||
    plan.totalPlanningCeilingYocto !== '500000000000000000000000' ||
    plan.transactions.length !== 4 ||
    plan.quotes.length !== 3
  )
    throw Error('FUNDING_PLAN_CHANGED');
  const amounts = [
    '250000000000000000000000',
    '100000000000000000000000',
    '50000000000000000000000',
    '50000000000000000000000',
  ];
  for (let i = 0; i < 4; i++) {
    const t = plan.transactions[i];
    if (
      t.signerId !== plan.signerId ||
      t.actions.length !== 1 ||
      t.actions[0].type !== 'Transfer' ||
      t.actions[0].params.deposit !== amounts[i]
    )
      throw Error('TRANSFER_CHANGED');
    if (i === 0) {
      if (t.receiverId !== 'hand.symbio-fcef733893.near') throw Error('HAND_ACCOUNT_CHANGED');
    } else {
      const q = plan.quotes[i - 1];
      if (
        !/^[a-f0-9]{64}$/.test(t.receiverId) ||
        t.receiverId !== q.quote.depositAddress ||
        q.quoteRequest.dry !== false ||
        q.quoteRequest.refundTo !== plan.signerId ||
        q.quoteRequest.amount !== amounts[i] ||
        q.quoteRequest.originAsset !== 'nep141:wrap.near' ||
        q.quoteRequest.recipientType !== 'DESTINATION_CHAIN' ||
        q.quoteRequest.slippageTolerance !== 0
      )
        throw Error('QUOTE_TERMS_CHANGED');
      const expected = [
        [
          'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
          '0xE9464975ECAFa3e27AC1048C16a3406395061092',
          '250000',
        ],
        ['nep141:base.omft.near', '0xE9464975ECAFa3e27AC1048C16a3406395061092', '50000000000000'],
        ['nep141:sol.omft.near', 'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f', '1500000'],
      ][i - 1];
      if (
        q.quoteRequest.destinationAsset !== expected[0] ||
        q.quoteRequest.recipient !== expected[1] ||
        BigInt(q.quote.minAmountOut) < BigInt(expected[2])
      )
        throw Error('DESTINATION_CHANGED');
    }
  }
}
async function refresh() {
  const s = await api('/state');
  button.disabled = busy || !wallet || s.pending || !!s.complete;
  if (s.complete)
    status.textContent =
      'COMPLETE. Four funding transfers and all three cross-chain credits verified. This is owner-funded capital, not revenue or AI execution.';
  else if (s.pending)
    status.textContent =
      s.receipts.filter(Boolean).length +
      '/4 original receipts verified. Signature outcome held; reconcile existing hashes and destination credits. Do not sign again.';
  return s;
}
try {
  plan = await api('/plan');
  check();
  await api('/preflight', {});
  const s = await refresh();
  if (!s.pending && !s.complete)
    status.textContent = 'Ready. Review the four transfers and signed conversion quotes.';
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
    status.textContent = 'Connected. Review capital, fees, conversions and reserve.';
  } catch (e) {
    wallet = null;
    status.textContent = e.message;
  }
  await refresh();
};
button.onclick = async () => {
  if (busy || !wallet) return;
  busy = true;
  button.disabled = true;
  try {
    check();
    if (!document.querySelector('#reviewed').checked) throw Error('REVIEW_REQUIRED');
    if ((await wallet.getAccounts())[0]?.accountId !== plan.signerId)
      throw Error('SELECT_NAMED_SIGNER');
    await api('/begin', {});
    const result = await wallet.signAndSendTransactions({
      transactions: plan.transactions.map((t) => ({
        signerId: t.signerId,
        receiverId: t.receiverId,
        actions: t.actions.map(internalActionToNaj),
      })),
    });
    for (let index = 0; index < (result ?? []).length; index++) {
      const hash = result[index]?.transaction?.hash;
      if (!hash) throw Error('PARTIAL_RESULT_RECONCILE_EXISTING_HASHES');
      await api('/observe', { index, hash });
    }
    await refresh();
    if (result?.length !== 4) throw Error('PARTIAL_RESULT_RECONCILE_EXISTING_HASHES');
    status.textContent +=
      ' Waiting for the three destination credits. Click Reconcile existing receipts.';
  } catch (e) {
    await refresh();
    status.textContent += '\nWallet: ' + e.message;
  } finally {
    busy = false;
    await refresh();
  }
};
document.querySelector('#verify').onclick = async () => {
  try {
    await api('/observe', {
      index: Number(document.querySelector('#index').value),
      hash: document.querySelector('#hash').value.trim(),
    });
    await refresh();
  } catch (e) {
    status.textContent = e.message;
  }
};
document.querySelector('#refresh').onclick = async () => {
  try {
    await api('/reconcile', {});
    await refresh();
  } catch (e) {
    await refresh();
    status.textContent += '\nReconciliation: ' + e.message;
  }
};
