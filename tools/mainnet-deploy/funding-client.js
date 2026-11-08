import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
console.log = () => {}; // Legacy Meteor SDK can log its generated app key.
const token = document.querySelector('meta[name="funding-token"]').content;
const status = document.querySelector('#status'),
  fund = document.querySelector('#fund');
let plan,
  wallet,
  busy = false;
async function read(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-funding-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.code ?? 'FUNDING_HELD');
  return data;
}
async function refresh() {
  const s = await read('/state');
  fund.disabled = busy || !wallet || s.pending || !!s.receipt;
  if (s.receipt)
    status.textContent = `Confirmed ${s.receipt.transaction.hash}. Treasury stayed PAUSED; this is team-funded capital, not revenue. Explorer: ${s.receipt.transaction.url}`;
  else if (s.pending)
    status.textContent =
      'A funding attempt is pending. Verify its existing hash; do not submit a second call.';
  return s;
}
async function preflight() {
  const p = await read('/preflight', { planDigest: plan.digest });
  document.querySelector('#preflight').textContent =
    `Finalized block ${p.block.height}. Treasury PAUSED. Workers disabled. Execution disarmed. Conservative fee estimate: ${p.estimatedFeeYocto} yoctoNEAR.`;
  return p;
}
try {
  plan = await read('/plan');
  const s = await refresh();
  await preflight();
  if (!s.pending && !s.receipt)
    status.textContent =
      'Ready. Connect solidvideo4090.near in Meteor. No transaction has been requested.';
} catch (e) {
  status.textContent = e.message;
  document.querySelector('#connect').disabled = true;
}
document.querySelector('#connect').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
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
    if (accounts.length !== 1 || accounts[0].accountId !== plan.transaction.signerId)
      throw Error('Select solidvideo4090.near in Meteor.');
    status.textContent = 'Connected. Review the single funding call; signing keys stay in Meteor.';
  } catch (e) {
    wallet = null;
    status.textContent = e.message;
  } finally {
    busy = false;
    await refresh();
  }
});
fund.addEventListener('click', async () => {
  if (busy || !wallet) return;
  busy = true;
  fund.disabled = true;
  try {
    if (!document.querySelector('#reviewed').checked) throw Error('Review the funding call first.');
    if ((await wallet.getAccounts())[0]?.accountId !== plan.transaction.signerId)
      throw Error('CONNECTED_OWNER_CHANGED');
    const tx = plan.transaction,
      call = tx.actions[0];
    if (
      tx.signerId !== 'solidvideo4090.near' ||
      tx.receiverId !== 'treasury.symbio-fcef733893.near' ||
      tx.actions.length !== 1 ||
      call.type !== 'FunctionCall' ||
      call.params.methodName !== 'fund' ||
      call.params.deposit !== '1000000000000000000000' ||
      call.params.gas !== '10000000000000' ||
      JSON.stringify(call.params.args) !== '{}'
    )
      throw Error('FUNDING_PLAN_CHANGED');
    await read('/begin', { planDigest: plan.digest });
    status.textContent =
      'Review one 0.001 NEAR fund() call in Meteor. No unpause or key grant is included.';
    const result = await wallet.signAndSendTransactions({
      transactions: [
        {
          signerId: tx.signerId,
          receiverId: tx.receiverId,
          actions: tx.actions.map(internalActionToNaj),
        },
      ],
    });
    const row = Array.isArray(result) ? result[0] : result;
    const hash = row?.transaction?.hash;
    if (!hash) throw Error('SIGNATURE_OUTCOME_UNKNOWN_VERIFY_EXISTING_HASH');
    document.querySelector('#hash').value = hash;
    await read('/observe', { hash });
  } catch (e) {
    status.textContent = `Funding held: ${e.message}. Verify any existing transaction hash before retrying.`;
  } finally {
    busy = false;
    await refresh();
  }
});
document.querySelector('#refresh').addEventListener('click', () => {
  if (!busy)
    void refresh()
      .then(preflight)
      .catch((e) => (status.textContent = e.message));
});
document.querySelector('#verify').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    await read('/observe', { hash: document.querySelector('#hash').value.trim() });
  } catch (e) {
    status.textContent = e.message;
  } finally {
    busy = false;
    await refresh();
  }
});
