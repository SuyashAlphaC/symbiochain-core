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
    plan.signerId !== 'solidvideo4090.near' ||
    plan.capitalYocto !== '100000000000000000000000' ||
    plan.feeAllowanceYocto !== '16000000000000000000000' ||
    plan.totalPlanningCeilingYocto !== '500000000000000000000000' ||
    plan.reusesConfirmedRefundsYocto !== '100000000000000000000000' ||
    plan.fundingOnlySlippageBps !== 50 ||
    plan.transactions.length !== 2 ||
    plan.quotes.length !== 2
  )
    throw Error('REFUNDED_FUNDING_PLAN_CHANGED');
  const expected = [
    ['nep141:base.omft.near', '0xE9464975ECAFa3e27AC1048C16a3406395061092', '50000000000000'],
    ['nep141:sol.omft.near', 'G48CEnMPfRadRQxaTmJkkdFRVTobyJyDDVec88PZwt2f', '1500000'],
  ];
  for (let i = 0; i < 2; i++) {
    const t = plan.transactions[i],
      q = plan.quotes[i],
      r = q.quoteRequest;
    if (
      t.signerId !== plan.signerId ||
      !t.receiverId.match(/^[a-f0-9]{64}$/) ||
      t.receiverId !== q.quote.depositAddress ||
      t.actions.length !== 1 ||
      t.actions[0].type !== 'Transfer' ||
      t.actions[0].params.deposit !== '50000000000000000000000' ||
      r.refundTo !== plan.signerId ||
      r.recipient !== expected[i][1] ||
      r.destinationAsset !== expected[i][0] ||
      r.originAsset !== 'nep141:wrap.near' ||
      r.depositType !== 'ORIGIN_CHAIN' ||
      r.recipientType !== 'DESTINATION_CHAIN' ||
      r.dry !== false ||
      r.slippageTolerance !== 50 ||
      r.amount !== '50000000000000000000000' ||
      BigInt(q.quote.minAmountOut) < BigInt(expected[i][2])
    )
      throw Error('FUNDING_TERMS_CHANGED');
  }
}
async function refresh() {
  const s = await api('/state');
  button.disabled = busy || !wallet || s.pending || !!s.complete;
  if (s.complete)
    status.textContent =
      'COMPLETE. Both refunded-capital transfers and gas credits verified. This is owner-funded capital, not revenue or AI execution.';
  else if (s.pending)
    status.textContent =
      s.receipts.filter(Boolean).length +
      '/2 original receipts verified. Signature outcome held; reconcile existing hashes and destination credits. Do not sign again.';
  return s;
}
try {
  plan = await api('/plan');
  check();
  await api('/preflight', {});
  const s = await refresh();
  if (!s.pending && !s.complete)
    status.textContent =
      'Ready. Review the two refunded-capital transfers and signed conversion quotes.';
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
    status.textContent = 'Connected. Review refunded capital, fees, funding slippage and reserve.';
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
    if (result?.length !== 2) throw Error('PARTIAL_RESULT_RECONCILE_EXISTING_HASHES');
    status.textContent +=
      ' Waiting for both destination credits. Click Reconcile existing receipts.';
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
