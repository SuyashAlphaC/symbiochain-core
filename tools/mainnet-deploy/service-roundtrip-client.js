import { setupWalletSelector, internalActionToNaj } from '@near-wallet-selector/core';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
console.log = () => {};
const token = document.querySelector('meta[name="service-token"]').content,
  status = document.querySelector('#status'),
  send = document.querySelector('#send');
let wallet,
  plan,
  busy = false;
async function read(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-service-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.code ?? 'SERVICE_TEST_HELD');
  return d;
}
async function refresh() {
  plan = await read('/plan');
  send.disabled = busy || !wallet || !plan.step;
  send.textContent =
    plan.step === 'withdraw'
      ? 'Sign withdrawal of verified credit'
      : 'Sign 0.002 NEAR service deposit';
  if (plan.complete)
    status.textContent = `COMPLETE. Credit returned; service balance is zero. Paused throughout. Deposit: ${plan.complete.depositTransaction.url}\nWithdrawal: ${plan.complete.transaction.url}`;
  else if (plan.phase.endsWith('PENDING'))
    status.textContent = `${plan.phase}. Verify the existing hash; do not send a second transaction.`;
  else if (plan.step === 'withdraw')
    status.textContent = `Deposit confirmed. Exact withdrawable credit: ${plan.fund.after.serviceBalanceYocto} yoctoNEAR. Review withdrawal to your same wallet.`;
  return plan;
}
async function preflight() {
  const p = await read('/preflight', {});
  document.querySelector('#preflight').textContent =
    `Finalized block ${p.block.height}. Treasury PAUSED; execution disarmed. Current service credit: ${p.serviceBalanceYocto} yoctoNEAR.`;
}
try {
  await refresh();
  await preflight();
  if (plan.phase === 'READY')
    status.textContent = 'Ready. Connect solidvideo4090.near in Meteor. No signature requested.';
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
    const a = await wallet.getAccounts();
    if (a.length !== 1 || a[0].accountId !== 'solidvideo4090.near')
      throw Error('Select solidvideo4090.near in Meteor.');
    status.textContent = 'Connected. Review the bounded test before signing.';
  } catch (e) {
    wallet = null;
    status.textContent = e.message;
  } finally {
    busy = false;
    await refresh();
  }
});
send.addEventListener('click', async () => {
  if (busy || !wallet || !plan.step) return;
  busy = true;
  send.disabled = true;
  try {
    if (!document.querySelector('#reviewed').checked) throw Error('Review the test first.');
    if ((await wallet.getAccounts())[0]?.accountId !== 'solidvideo4090.near')
      throw Error('CONNECTED_OWNER_CHANGED');
    const tx = plan.transaction,
      c = tx.actions[0],
      step = plan.step;
    if (
      tx.signerId !== 'solidvideo4090.near' ||
      tx.receiverId !== 'treasury.symbio-fcef733893.near' ||
      tx.actions.length !== 1 ||
      c.type !== 'FunctionCall'
    )
      throw Error('SERVICE_PLAN_CHANGED');
    if (
      step === 'deposit' &&
      (c.params.methodName !== 'fund_services' ||
        c.params.deposit !== '2000000000000000000000' ||
        c.params.gas !== '10000000000000' ||
        JSON.stringify(c.params.args) !== '{}')
    )
      throw Error('SERVICE_PLAN_CHANGED');
    if (
      step === 'withdraw' &&
      (c.params.methodName !== 'withdraw_service_balance' ||
        c.params.deposit !== '0' ||
        c.params.gas !== '30000000000000' ||
        !/^\d+$/.test(c.params.args.amount) ||
        BigInt(c.params.args.amount) <= 0n ||
        BigInt(c.params.args.amount) > 2000000000000000000000n)
    )
      throw Error('SERVICE_PLAN_CHANGED');
    await read('/begin', { step, planDigest: plan.digest });
    status.textContent = `Review the single ${c.params.methodName} call in Meteor.`;
    const response = await wallet.signAndSendTransactions({
      transactions: [
        {
          signerId: tx.signerId,
          receiverId: tx.receiverId,
          actions: tx.actions.map(internalActionToNaj),
        },
      ],
    });
    const row = Array.isArray(response) ? response[0] : response,
      hash = row?.transaction?.hash;
    if (!hash) throw Error('SIGNATURE_OUTCOME_UNKNOWN_VERIFY_EXISTING_HASH');
    document.querySelector('#hash').value = hash;
    await read('/observe', { step, hash });
  } catch (e) {
    status.textContent = `Held: ${e.message}. Reconcile an existing hash before retrying.`;
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
    const s = await read('/state');
    const step =
      s.phase === 'DEPOSIT_PENDING'
        ? 'deposit'
        : s.phase === 'WITHDRAW_PENDING'
          ? 'withdraw'
          : null;
    if (!step) throw Error('NO_PENDING_RECEIPT');
    await read('/observe', { step, hash: document.querySelector('#hash').value.trim() });
  } catch (e) {
    status.textContent = e.message;
  } finally {
    busy = false;
    await refresh();
  }
});
